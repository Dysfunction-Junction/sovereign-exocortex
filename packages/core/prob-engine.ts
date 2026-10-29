/**
 * @file prob-engine.ts
 * Conditional probability engine for "what will the user do next".
 *
 * Model. Each expert e is a hierarchical Dirichlet-multinomial over next actions, conditioned on the
 * current action plus a subset of discretised context features. With context c and parent
 * distribution P_parent (the bigram on the current action; the bigram's own parent is the unigram):
 *
 *     P_e(y | c) = ( n_e(c, y) + alpha * P_parent(y) ) / ( n_e(c) + alpha )
 *
 * which is the posterior predictive of a Dirichlet(alpha * P_parent) prior. The chain bottoms out at a
 * unigram Dirichlet over the actions seen so far plus one OTHER class that carries the mass of actions
 * never seen before, so every distribution sums to exactly 1 and a novel action never gets zero.
 *
 * Combination. Experts are mixed by exponentiated weights on cumulative log loss. With eta = 1 this
 * is the exact Bayesian posterior over experts; fixed-share smoothing (share > 0) lets the mixture
 * track a user whose habits drift. An expert whose features are missing for an example sleeps: it
 * sits out the prediction and is charged the mixture's own loss so its weight is unaffected.
 *
 * Calibration. The mixture is sharpened or flattened by a single temperature T (p_i ~ p_i^(1/T))
 * fitted by minimising log loss over a window of the engine's own past predictions.
 *
 * Evaluation is prequential (predict, score, then learn), so every score is out-of-sample. Scores are
 * proper rules: log loss and Brier. A paired test against a baseline engine says whether an
 * improvement is larger than noise.
 *
 * No randomness, no clock, no I/O: replaying the same examples always gives the same numbers.
 */

import type { PredictionContext } from "./prediction-log.js";

/** Class that stands for every action not seen before. */
export const OTHER = "<other>";

/** Discretised categorical context. A missing key means the signal was not available. */
export type FeatureMap = Readonly<Record<string, string>>;

export interface Example {
  /** Action the user is on right now (the thing the next action is conditioned on). */
  current: string;
  features: FeatureMap;
  /** What they did next. */
  actual: string;
}

export interface ExpertSpec {
  name: string;
  /** Feature names that must all be present, in addition to the current action. */
  features: readonly string[];
}

export interface EngineOptions {
  /** Dirichlet concentration toward the parent distribution. Larger = trusts the parent longer. */
  alpha?: number;
  /** Unigram concentration toward uniform over (seen + OTHER). */
  beta?: number;
  /** Learning rate on log loss. 1 gives exact Bayesian model averaging. */
  eta?: number;
  /** Fixed-share rate in [0,1): probability mass moved uniformly across experts each step. */
  share?: number;
  experts?: readonly ExpertSpec[];
  /** Examples between temperature refits, and the window and minimum size used to fit. */
  calibrateEvery?: number;
  calibrationWindow?: number;
  calibrationMin?: number;
}

export interface SerializedProbEngineState {
  unigram: Array<[string, number]>;
  unigramTotal: number;
  logW: number[];
  temperature: number;
  seen: number;
  history?: Array<{ probs: Array<[string, number]>; actual: string }>;
  experts: Array<{
    name: string;
    cells: Array<[string, Array<[string, number]>]>;
    totals: Array<[string, number]>;
  }>;
}

export interface Distribution {
  /** Every seen action plus OTHER, highest first. Sums to 1. */
  probs: Array<{ value: string; prob: number }>;
  temperature: number;
  /** Normalised mixture weight of each active expert for this prediction. */
  weights: Record<string, number>;
  /** Experts that took part (all required features present). */
  active: string[];
}

export const FEATURE_NAMES = [
  "prev",
  "daypart",
  "hour3",
  "weekend",
  "dow",
  "app",
  "screen_state",
  "mode",
  "battery",
  "charging",
  "network",
  "idle",
  "temp",
  "place",
  "sys_suggest",
  "audio_mode",
  "motion",
  "physical_state",
  "metered",
  "triage",
] as const;

/** Unigram, bigram, and the current action paired with each context feature, plus three joint contexts. */
export const DEFAULT_EXPERTS: readonly ExpertSpec[] = [
  { name: "unigram", features: [] },
  { name: "bigram", features: [] },
  ...FEATURE_NAMES.map((f) => ({ name: `cur+${f}`, features: [f] })),
  { name: "cur+prev+daypart", features: ["prev", "daypart"] },
  { name: "cur+daypart+weekend", features: ["daypart", "weekend"] },
  { name: "cur+sys_suggest+app", features: ["sys_suggest", "app"] },
];

/**
 * Sensor-derived features under evaluation. They are emitted by contextFeatures (so every example
 * carries them from day one) but are NOT in FEATURE_NAMES / DEFAULT_EXPERTS, so no live expert reads
 * them. Promotion needs the pre-registered admission rule (>=4 weeks, >=300 app-stream examples,
 * paired log-loss z >= 2.6 against DEFAULT_EXPERTS); promote one at a time.
 */
export const CANDIDATE_FEATURE_NAMES = ["motion_energy", "orient", "steps", "sig_motion", "pressure_trend", "light", "near"] as const;

/** `cur+<f>` experts for candidate features, to be appended to DEFAULT_EXPERTS for a replay comparison. */
export function candidateExperts(features: readonly string[] = CANDIDATE_FEATURE_NAMES): ExpertSpec[] {
  return features.map((f) => ({ name: `cur+${f}`, features: [f] }));
}

const bucket = (v: number, edges: readonly number[], labels: readonly string[]): string => {
  for (let i = 0; i < edges.length; i++) if (v < edges[i]) return labels[i];
  return labels[labels.length - 1];
};

/**
 * Turn a context snapshot (and the previous action) into categorical features. Numeric signals are
 * bucketed so a handful of observations can populate a cell. Absent signals produce no key.
 */
export function contextFeatures(ctx: PredictionContext | undefined, prev?: string): FeatureMap {
  const f: Record<string, string> = {};
  if (prev) f.prev = prev;
  const t = ctx?.time;
  if (t) {
    f.daypart = t.daypart;
    f.hour3 = String(Math.floor(t.hour / 3));
    f.weekend = t.is_weekend ? "1" : "0";
    f.dow = String(t.dow);
  }
  if (ctx?.app?.package) f.app = ctx.app.package;
  const d = ctx?.device;
  if (d) {
    if (d.screen_state) f.screen_state = d.screen_state;
    if (d.mode) f.mode = d.mode;
    if (typeof d.battery_pct === "number" && Number.isFinite(d.battery_pct)) {
      f.battery = bucket(d.battery_pct, [20, 50, 80], ["0-20", "20-50", "50-80", "80-100"]);
    }
    if (typeof d.charging === "boolean") f.charging = d.charging ? "1" : "0";
    if (d.network) f.network = d.network;
    if (typeof d.idle_ms === "number" && Number.isFinite(d.idle_ms) && d.idle_ms >= 0) {
      f.idle = bucket(d.idle_ms, [5_000, 60_000, 600_000], ["<5s", "5s-1m", "1m-10m", ">10m"]);
    }
  }
  const temp = ctx?.ambient?.temp_c;
  if (typeof temp === "number" && Number.isFinite(temp)) {
    f.temp = bucket(temp, [10, 18, 24, 30], ["<10", "10-18", "18-24", "24-30", ">30"]);
  }
  const loc = ctx?.location;
  if (loc) {
    if (loc.place) f.place = loc.place;
    else if (typeof loc.lat === "number" && typeof loc.lon === "number") f.place = `${loc.lat.toFixed(1)},${loc.lon.toFixed(1)}`;
  }
  const sysSuggest =
    ctx?.system_suggestions?.primary_action ??
    (typeof ctx?.sys_suggest === "string" ? ctx.sys_suggest : undefined) ??
    (typeof ctx?.suggested_action === "string" ? ctx.suggested_action : undefined);
  if (sysSuggest) {
    f.sys_suggest = sysSuggest;
  }
  const audioMode = ctx?.audio?.mode ?? (typeof ctx?.audio_mode === "string" ? ctx.audio_mode : undefined);
  if (audioMode) {
    f.audio_mode = audioMode;
  }
  const motion = ctx?.motion?.state ?? (typeof ctx?.motion_state === "string" ? ctx.motion_state : undefined);
  if (motion && motion !== "unknown") {
    f.motion = motion;
  }
  const legacy = ctx as (PredictionContext & { physical_state?: unknown; metered?: unknown }) | undefined;
  const surfaceState = ctx?.physical_surface?.state;
  const ambientState = ctx?.ambient?.physical_state;
  const rawState = typeof legacy?.physical_state === "string" ? legacy.physical_state : undefined;
  const validState = (s: string | undefined) => (s && s !== "unknown" ? s : undefined);
  const physicalState = validState(surfaceState) ?? validState(ambientState) ?? validState(rawState);
  if (physicalState) {
    f.physical_state = physicalState;
  }
  const metered =
    ctx?.network_telemetry?.metered ??
    ctx?.device?.metered ??
    (typeof legacy?.metered === "boolean" ? legacy.metered : undefined);
  if (metered !== undefined) {
    f.metered = metered ? "1" : "0";
  }
  const triage = ctx?.triage ?? (typeof (ctx as any)?.triage_category === "string" ? (ctx as any).triage_category : undefined);
  if (typeof triage === "string" && triage) {
    f.triage = triage;
  }
  const sn = ctx?.sensors;
  if (sn) {
    if (sn.motion_energy) f.motion_energy = sn.motion_energy;
    if (sn.orient) f.orient = sn.orient;
    if (typeof sn.steps_delta === "number" && Number.isFinite(sn.steps_delta) && sn.steps_delta >= 0) {
      f.steps = bucket(sn.steps_delta, [1, 51, 301], ["0", "1-50", "51-300", ">300"]);
    }
    if (typeof sn.sig_motion === "boolean") f.sig_motion = sn.sig_motion ? "1" : "0";
    if (sn.pressure_trend) f.pressure_trend = sn.pressure_trend;
    if (sn.light) f.light = sn.light;
    if (typeof sn.near_frac === "number" && Number.isFinite(sn.near_frac) && sn.near_frac >= 0) {
      f.near = bucket(sn.near_frac, [0.05, 0.5], ["none", "some", "mostly"]);
    }
  }
  return f;
}

type Counts = Map<string, number>;

interface ExpertState {
  spec: ExpertSpec;
  /** context string -> next-action counts */
  cells: Map<string, Counts>;
  totals: Map<string, number>;
}

const clampProb = (p: number): number => Math.min(1, Math.max(1e-12, p));

export class ProbEngine {
  private readonly alpha: number;
  private readonly beta: number;
  private readonly eta: number;
  private readonly share: number;
  private readonly specs: readonly ExpertSpec[];
  private readonly calibrateEvery: number;
  private readonly calibrationWindow: number;
  private readonly calibrationMin: number;

  private readonly experts: ExpertState[];
  private readonly unigram: Counts = new Map();
  private unigramTotal = 0;
  private logW: number[];
  private temperature = 1;
  private seen = 0;
  /** Recent mixture distributions (before calibration) with the true outcome, for temperature fitting. */
  private history: Array<{ probs: Array<[string, number]>; actual: string }> = [];

  constructor(opts: EngineOptions = {}) {
    this.alpha = opts.alpha ?? 2;
    this.beta = opts.beta ?? 1;
    this.eta = opts.eta ?? 1;
    this.share = opts.share ?? 0.01;
    if (!(this.alpha > 0) || !(this.beta > 0) || !(this.eta > 0)) throw new RangeError("alpha, beta, eta must be positive");
    if (!(this.share >= 0 && this.share < 1)) throw new RangeError("share must be in [0,1)");
    this.specs = opts.experts ?? DEFAULT_EXPERTS;
    if (this.specs.length === 0) throw new RangeError("at least one expert required");
    this.calibrateEvery = opts.calibrateEvery ?? 25;
    this.calibrationWindow = opts.calibrationWindow ?? 500;
    this.calibrationMin = opts.calibrationMin ?? 40;
    this.experts = this.specs.map((spec) => ({ spec, cells: new Map(), totals: new Map() }));
    this.logW = this.specs.map(() => -Math.log(this.specs.length));
  }

  get examplesSeen(): number {
    return this.seen;
  }

  get currentTemperature(): number {
    return this.temperature;
  }

  /** Probability of each class under the unigram Dirichlet (seen actions + OTHER share beta equally). */
  private unigramProb(y: string): number {
    const k = this.unigram.size + 1;
    const n = y === OTHER ? 0 : this.unigram.get(y) ?? 0;
    return (n + this.beta / k) / (this.unigramTotal + this.beta);
  }

  private support(): string[] {
    return [...this.unigram.keys(), OTHER];
  }

  private contextKey(spec: ExpertSpec, current: string, features: FeatureMap): string | null {
    if (spec.name === "unigram") return "";
    let key = current;
    for (const name of spec.features) {
      const v = features[name];
      if (v === undefined) return null;
      key += `\u001f${name}=${v}`;
    }
    return key;
  }

  /** P_e(y | c) for every y in the support, recursing through the parent chain. */
  private expertDist(state: ExpertState, current: string, key: string, support: readonly string[]): Map<string, number> {
    const out = new Map<string, number>();
    // Parent chain: contextual expert -> bigram on the current action -> unigram -> uniform over (seen + OTHER).
    let parent: (y: string) => number;
    if (state.spec.name === "unigram") {
      for (const y of support) out.set(y, this.unigramProb(y));
      return out;
    }
    if (state.spec.name === "bigram") {
      parent = (y) => this.unigramProb(y);
    } else {
      const bg = this.experts.find((e) => e.spec.name === "bigram");
      const bgCounts = bg?.cells.get(current);
      const bgTotal = bg?.totals.get(current) ?? 0;
      parent = (y) => {
        const n = bgCounts?.get(y) ?? 0;
        return (n + this.alpha * this.unigramProb(y)) / (bgTotal + this.alpha);
      };
    }
    const cell = state.cells.get(key);
    const total = state.totals.get(key) ?? 0;
    for (const y of support) {
      const n = cell?.get(y) ?? 0;
      out.set(y, (n + this.alpha * parent(y)) / (total + this.alpha));
    }
    return out;
  }

  private active(current: string, features: FeatureMap): Array<{ i: number; key: string }> {
    const act: Array<{ i: number; key: string }> = [];
    this.experts.forEach((e, i) => {
      const key = e.spec.name === "bigram" ? current : this.contextKey(e.spec, current, features);
      if (key !== null) act.push({ i, key });
    });
    return act;
  }

  private mixture(current: string, features: FeatureMap): { dist: Map<string, number>; weights: number[]; act: Array<{ i: number; key: string }>; per: Array<Map<string, number>> } {
    const support = this.support();
    const act = this.active(current, features);
    const per = act.map(({ i, key }) => this.expertDist(this.experts[i], current, key, support));
    const maxLw = Math.max(...act.map(({ i }) => this.logW[i]));
    const raw = act.map(({ i }) => Math.exp(this.logW[i] - maxLw));
    const z = raw.reduce((a, b) => a + b, 0);
    const weights = raw.map((w) => w / z);
    const dist = new Map<string, number>();
    for (const y of support) {
      let p = 0;
      for (let j = 0; j < act.length; j++) p += weights[j] * (per[j].get(y) ?? 0);
      dist.set(y, p);
    }
    return { dist, weights, act, per };
  }

  private static temper(dist: ReadonlyMap<string, number>, temperature: number): Map<string, number> {
    if (temperature === 1) return new Map(dist);
    const inv = 1 / temperature;
    let z = 0;
    const raw = new Map<string, number>();
    for (const [y, p] of dist) {
      const v = Math.pow(clampProb(p), inv);
      raw.set(y, v);
      z += v;
    }
    const out = new Map<string, number>();
    for (const [y, v] of raw) out.set(y, v / z);
    return out;
  }

  /** Predictive distribution for the next action given where the user is and the context. */
  predict(current: string, features: FeatureMap = {}): Distribution {
    if (!current) throw new TypeError("current action required");
    const { dist, weights, act } = this.mixture(current, features);
    const tempered = ProbEngine.temper(dist, this.temperature);
    const probs = [...tempered.entries()]
      .map(([value, prob]) => ({ value, prob }))
      .sort((a, b) => b.prob - a.prob || (a.value < b.value ? -1 : 1));
    const w: Record<string, number> = {};
    act.forEach(({ i }, j) => (w[this.specs[i].name] = weights[j]));
    return { probs, temperature: this.temperature, weights: w, active: act.map(({ i }) => this.specs[i].name) };
  }

  /** Learn from what actually happened. Returns the log loss the engine incurred on this example. */
  observe(current: string, features: FeatureMap, actual: string): { logLoss: number; probOfActual: number } {
    if (!current || !actual) throw new TypeError("current and actual required");
    const shownT = this.temperature;
    const { dist, act, per } = this.mixture(current, features);
    const cls = this.unigram.has(actual) ? actual : OTHER;
    const mixLoss = -Math.log(clampProb(dist.get(cls) ?? 0));

    // Calibration history stores the uncalibrated mixture so T is fitted against a fixed target.
    this.history.push({ probs: [...dist.entries()], actual: cls });
    if (this.history.length > this.calibrationWindow) this.history.shift();

    // Weight update: active experts pay their own loss, sleeping experts pay the mixture's.
    const loss = new Array<number>(this.specs.length).fill(mixLoss);
    act.forEach(({ i }, j) => (loss[i] = -Math.log(clampProb(per[j].get(cls) ?? 0))));
    let lw = this.logW.map((w, i) => w - this.eta * loss[i]);
    const m = Math.max(...lw);
    let w = lw.map((v) => Math.exp(v - m));
    const z = w.reduce((a, b) => a + b, 0);
    w = w.map((v) => v / z);
    const n = w.length;
    this.logW = w.map((v) => Math.log((1 - this.share) * v + this.share / n));

    // Counts.
    this.unigram.set(actual, (this.unigram.get(actual) ?? 0) + 1);
    this.unigramTotal++;
    for (const { i, key } of act) {
      const e = this.experts[i];
      if (e.spec.name === "unigram") continue;
      const cell = e.cells.get(key) ?? new Map<string, number>();
      cell.set(actual, (cell.get(actual) ?? 0) + 1);
      e.cells.set(key, cell);
      e.totals.set(key, (e.totals.get(key) ?? 0) + 1);
    }

    this.seen++;
    if (this.seen % this.calibrateEvery === 0 && this.history.length >= this.calibrationMin) this.fitTemperature();

    // Report the loss of what predict() said before this update: same mixture, same temperature.
    const probOfActual = ProbEngine.temper(dist, shownT).get(cls) ?? 0;
    return { logLoss: -Math.log(clampProb(probOfActual)), probOfActual };
  }

  private fitTemperature(): void {
    const loss = (T: number): number => {
      let s = 0;
      for (const h of this.history) {
        const d = ProbEngine.temper(new Map(h.probs), T);
        s -= Math.log(clampProb(d.get(h.actual) ?? 0));
      }
      return s / this.history.length;
    };
    // Golden-section search; log loss is unimodal in T for temperature scaling.
    let lo = 0.5;
    let hi = 3;
    const g = (Math.sqrt(5) - 1) / 2;
    let a = hi - g * (hi - lo);
    let b = lo + g * (hi - lo);
    let fa = loss(a);
    let fb = loss(b);
    for (let k = 0; k < 40; k++) {
      if (fa < fb) {
        hi = b;
        b = a;
        fb = fa;
        a = hi - g * (hi - lo);
        fa = loss(a);
      } else {
        lo = a;
        a = b;
        fa = fb;
        b = lo + g * (hi - lo);
        fb = loss(b);
      }
    }
    this.temperature = (lo + hi) / 2;
  }

  toJSON(): SerializedProbEngineState {
    return {
      unigram: [...this.unigram.entries()],
      unigramTotal: this.unigramTotal,
      logW: [...this.logW],
      temperature: this.temperature,
      seen: this.seen,
      history: this.history.map((h) => ({ probs: [...h.probs], actual: h.actual })),
      experts: this.experts.map((e) => ({
        name: e.spec.name,
        cells: [...e.cells.entries()].map(([k, counts]) => [k, [...counts.entries()]]),
        totals: [...e.totals.entries()],
      })),
    };
  }

  /**
   * Expert weights are matched by name, not position, so a checkpoint saved with N experts loads into
   * a different set. An expert the checkpoint never had starts at the uniform prior; if the set
   * changed at all the weights are renormalised. An identical set copies the saved weights verbatim.
   */
  private static mapWeightsByName(data: SerializedProbEngineState, specs: readonly ExpertSpec[]): number[] {
    const saved = new Map<string, number>();
    data.experts.forEach((e, i) => {
      const w = data.logW?.[i];
      if (typeof w === "number" && Number.isFinite(w)) saved.set(e.name, w);
    });
    let unmatched = 0;
    const lw = specs.map((spec) => {
      const w = saved.get(spec.name);
      if (w === undefined) {
        unmatched++;
        return -Math.log(specs.length);
      }
      return w;
    });
    if (unmatched === 0 && saved.size === specs.length) return lw;
    const m = Math.max(...lw);
    const norm = m + Math.log(lw.reduce((a, v) => a + Math.exp(v - m), 0));
    return lw.map((v) => v - norm);
  }

  static fromJSON(data: SerializedProbEngineState, opts: EngineOptions = {}): ProbEngine {
    const engine = new ProbEngine(opts);
    engine.unigram.clear();
    for (const [k, v] of data.unigram) {
      engine.unigram.set(k, v);
    }
    engine.unigramTotal = data.unigramTotal;
    engine.logW = ProbEngine.mapWeightsByName(data, engine.specs);
    engine.temperature = data.temperature;
    engine.seen = data.seen;
    if (data.history) {
      engine.history = data.history.map((h) => ({ probs: [...h.probs], actual: h.actual }));
    }
    for (const expData of data.experts) {
      const exp = engine.experts.find((e) => e.spec.name === expData.name);
      if (!exp) continue;
      exp.cells.clear();
      exp.totals.clear();
      for (const [k, counts] of expData.cells) {
        exp.cells.set(k, new Map(counts));
      }
      for (const [k, total] of expData.totals) {
        exp.totals.set(k, total);
      }
    }
    return engine;
  }

}

// ---------------------------------------------------------------------------------------------
// Scoring and evaluation
// ---------------------------------------------------------------------------------------------

export interface ScoredExample {
  logLoss: number;
  brier: number;
  top1: boolean;
  top3: boolean;
  /** Probability the engine put on its top guess. */
  confidence: number;
  pActual: number;
}

function scoreOne(dist: Distribution, actual: string, seenBefore: boolean): ScoredExample {
  const cls = seenBefore && dist.probs.some((p) => p.value === actual) ? actual : OTHER;
  let brier = 0;
  for (const { value, prob } of dist.probs) brier += (prob - (value === cls ? 1 : 0)) ** 2;
  const rank = dist.probs.findIndex((p) => p.value === cls);
  const pActual = dist.probs[rank]?.prob ?? 0;
  return {
    logLoss: -Math.log(clampProb(pActual)),
    brier,
    top1: rank === 0 && cls !== OTHER,
    top3: rank >= 0 && rank < 3 && cls !== OTHER,
    confidence: dist.probs[0]?.prob ?? 0,
    pActual,
  };
}

export interface EvaluationSummary {
  n: number;
  meanLogLoss: number | null;
  meanBrier: number | null;
  top1: number | null;
  top3: number | null;
  /** Expected calibration error on top-1 confidence (equal-width bins). */
  ece: number | null;
}

export function summarize(scores: readonly ScoredExample[], bins = 10): EvaluationSummary {
  const n = scores.length;
  if (n === 0) return { n: 0, meanLogLoss: null, meanBrier: null, top1: null, top3: null, ece: null };
  const mean = (f: (s: ScoredExample) => number): number => scores.reduce((a, s) => a + f(s), 0) / n;
  let ece = 0;
  for (let b = 0; b < bins; b++) {
    const lo = b / bins;
    const hi = (b + 1) / bins;
    const inBin = scores.filter((s) => s.confidence >= lo && (b === bins - 1 ? s.confidence <= hi : s.confidence < hi));
    if (inBin.length === 0) continue;
    const conf = inBin.reduce((a, s) => a + s.confidence, 0) / inBin.length;
    const acc = inBin.filter((s) => s.top1).length / inBin.length;
    ece += (inBin.length / n) * Math.abs(conf - acc);
  }
  return {
    n,
    meanLogLoss: mean((s) => s.logLoss),
    meanBrier: mean((s) => s.brier),
    top1: mean((s) => (s.top1 ? 1 : 0)),
    top3: mean((s) => (s.top3 ? 1 : 0)),
    ece,
  };
}

/** Prequential run: predict, score, then learn, one example at a time. */
export function prequential(examples: readonly Example[], engine: ProbEngine): ScoredExample[] {
  const out: ScoredExample[] = [];
  const seen = new Set<string>();
  for (const ex of examples) {
    const dist = engine.predict(ex.current, ex.features);
    out.push(scoreOne(dist, ex.actual, seen.has(ex.actual)));
    engine.observe(ex.current, ex.features, ex.actual);
    seen.add(ex.actual);
  }
  return out;
}

export interface PairedComparison {
  n: number;
  /** Mean of (baseline log loss - candidate log loss). Positive means the candidate is better. */
  meanLogLossGain: number | null;
  standardError: number | null;
  z: number | null;
  /** True when the gain is positive and |z| exceeds 1.96. */
  significantlyBetter: boolean;
}

export function compareLogLoss(candidate: readonly ScoredExample[], baseline: readonly ScoredExample[]): PairedComparison {
  if (candidate.length !== baseline.length) throw new RangeError("score series must be the same length");
  const n = candidate.length;
  if (n < 2) return { n, meanLogLossGain: null, standardError: null, z: null, significantlyBetter: false };
  const d = candidate.map((c, i) => baseline[i].logLoss - c.logLoss);
  const mean = d.reduce((a, b) => a + b, 0) / n;
  const variance = d.reduce((a, b) => a + (b - mean) ** 2, 0) / (n - 1);
  const se = Math.sqrt(variance / n);
  const z = se > 0 ? mean / se : mean > 0 ? Infinity : mean < 0 ? -Infinity : 0;
  return { n, meanLogLossGain: mean, standardError: se, z, significantlyBetter: mean > 0 && z > 1.96 };
}

/** Engine restricted to the frequency baseline: unigram plus bigram, no context features. */
export function baselineEngine(opts: EngineOptions = {}): ProbEngine {
  return new ProbEngine({ ...opts, experts: DEFAULT_EXPERTS.filter((e) => e.name === "unigram" || e.name === "bigram") });
}

export interface SystemSuggestionBenchmark {
  totalEvaluated: number;
  eligibleEvaluated: number;
  coverage: number;
  exocortexHits: number;
  systemHits: number;
  bothHit: number;
  exoOnlyHits: number;
  sysOnlyHits: number;
  agreementRate: number;
  exocortexAccuracy: number;
  systemAccuracy: number;
  exocortexAdvantage: number;
  mcNemarChiSquare: number | null;
  mcNemarSignificant: boolean;
}

export interface SuggestionBenchmarkItem {
  actual: string;
  exocortexTop: string;
  systemSuggestion?: string | null;
}

/**
 * Benchmark Exocortex next-step accuracy against native on-device system suggestions (TextClassifier).
 * Restricts comparative evaluation to rows where the system emitted an action suggestion (reporting coverage),
 * and evaluates statistical significance across discordant prediction pairs via McNemar's test.
 */
export function benchmarkAgainstSystemSuggestion(
  items: readonly SuggestionBenchmarkItem[]
): SystemSuggestionBenchmark {
  const totalEvaluated = items.length;
  if (totalEvaluated === 0) {
    return {
      totalEvaluated: 0,
      eligibleEvaluated: 0,
      coverage: 0,
      exocortexHits: 0,
      systemHits: 0,
      bothHit: 0,
      exoOnlyHits: 0,
      sysOnlyHits: 0,
      agreementRate: 0,
      exocortexAccuracy: 0,
      systemAccuracy: 0,
      exocortexAdvantage: 0,
      mcNemarChiSquare: null,
      mcNemarSignificant: false,
    };
  }

  const eligibleItems = items.filter(
    (item) => typeof item.systemSuggestion === "string" && item.systemSuggestion.trim().length > 0
  );
  const eligibleEvaluated = eligibleItems.length;
  const coverage = eligibleEvaluated / totalEvaluated;

  if (eligibleEvaluated === 0) {
    return {
      totalEvaluated,
      eligibleEvaluated: 0,
      coverage: 0,
      exocortexHits: 0,
      systemHits: 0,
      bothHit: 0,
      exoOnlyHits: 0,
      sysOnlyHits: 0,
      agreementRate: 0,
      exocortexAccuracy: 0,
      systemAccuracy: 0,
      exocortexAdvantage: 0,
      mcNemarChiSquare: null,
      mcNemarSignificant: false,
    };
  }

  let exocortexHits = 0;
  let systemHits = 0;
  let bothHit = 0;
  let agreed = 0;

  for (const item of eligibleItems) {
    const sys = item.systemSuggestion!;
    const exoMatch = item.exocortexTop === item.actual;
    const sysMatch = sys === item.actual;
    if (exoMatch) exocortexHits++;
    if (sysMatch) systemHits++;
    if (exoMatch && sysMatch) bothHit++;
    if (item.exocortexTop === sys) agreed++;
  }

  const exoOnlyHits = exocortexHits - bothHit;
  const sysOnlyHits = systemHits - bothHit;
  const discordant = exoOnlyHits + sysOnlyHits;

  let mcNemarChiSquare: number | null = null;
  let mcNemarSignificant = false;
  if (discordant > 0) {
    // McNemar test with Edwards continuity correction: (|b - c| - 1)^2 / (b + c)
    mcNemarChiSquare = Math.max(0, Math.abs(exoOnlyHits - sysOnlyHits) - 1) ** 2 / discordant;
    // Critical value at p = 0.05 (1 df) is 3.841
    mcNemarSignificant = mcNemarChiSquare > 3.841;
  }

  const exocortexAccuracy = exocortexHits / eligibleEvaluated;
  const systemAccuracy = systemHits / eligibleEvaluated;

  return {
    totalEvaluated,
    eligibleEvaluated,
    coverage,
    exocortexHits,
    systemHits,
    bothHit,
    exoOnlyHits,
    sysOnlyHits,
    agreementRate: agreed / eligibleEvaluated,
    exocortexAccuracy,
    systemAccuracy,
    exocortexAdvantage: exocortexAccuracy - systemAccuracy,
    mcNemarChiSquare,
    mcNemarSignificant,
  };
}
