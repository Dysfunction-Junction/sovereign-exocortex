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
] as const;

/** Unigram, bigram, and the current action paired with each context feature, plus two joint contexts. */
export const DEFAULT_EXPERTS: readonly ExpertSpec[] = [
  { name: "unigram", features: [] },
  { name: "bigram", features: [] },
  ...FEATURE_NAMES.map((f) => ({ name: `cur+${f}`, features: [f] })),
  { name: "cur+prev+daypart", features: ["prev", "daypart"] },
  { name: "cur+daypart+weekend", features: ["daypart", "weekend"] },
];

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
