import { CHECKPOINT_SCHEMA_SQL } from "./prob-engine-checkpoint.js";
/**
 * @file prediction-log.ts
 * Next-action prediction log and scorer.
 *
 * The system logs a ranked guess about what you will do next. A later event is the answer key,
 * so every guess resolves to HIT, MISS or EXPIRED without any tapping. Misses keep the action that
 * really happened, which turns the log into an empirical "when I guessed X in context C, what
 * happened" table (the probability guide).
 *
 * This is deliberately separate from Precision@surface (shadow-metrics.ts), which asks whether
 * surfacing a proposal was wanted and is fed by taps only. Nothing here feeds that number.
 *
 * Both tables are insert-only (triggers abort UPDATE and DELETE). The predictor is a frequency
 * scorer over the event history, not a learned model, and is named as such.
 */

import type { DatabaseSync } from "node:sqlite";

export const PREDICTION_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS predictions (
  prediction_id TEXT PRIMARY KEY,
  device_id     TEXT NOT NULL,
  made_seq      INTEGER NOT NULL,
  made_at       INTEGER NOT NULL,
  horizon_ms    INTEGER NOT NULL CHECK (horizon_ms > 0),
  context_key   TEXT NOT NULL,
  candidates    TEXT NOT NULL CHECK (json_valid(candidates)),
  context       TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(context))
) STRICT;
CREATE INDEX IF NOT EXISTS predictions_device_seq ON predictions(device_id, made_seq);

CREATE TABLE IF NOT EXISTS prediction_outcomes (
  prediction_id TEXT PRIMARY KEY REFERENCES predictions(prediction_id),
  outcome       TEXT NOT NULL CHECK (outcome IN ('HIT','MISS','EXPIRED')),
  actual        TEXT,
  actual_seq    INTEGER,
  hit_rank      INTEGER CHECK (hit_rank IS NULL OR hit_rank >= 1),
  latency_ms    INTEGER,
  resolved_at   INTEGER NOT NULL,
  actual_context TEXT CHECK (actual_context IS NULL OR json_valid(actual_context))
) STRICT;

CREATE TRIGGER IF NOT EXISTS predictions_no_update BEFORE UPDATE ON predictions
  BEGIN SELECT RAISE(ABORT, 'predictions are append-only'); END;
CREATE TRIGGER IF NOT EXISTS predictions_no_delete BEFORE DELETE ON predictions
  BEGIN SELECT RAISE(ABORT, 'predictions are append-only'); END;
CREATE TRIGGER IF NOT EXISTS prediction_outcomes_no_update BEFORE UPDATE ON prediction_outcomes
  BEGIN SELECT RAISE(ABORT, 'prediction outcomes are append-only'); END;
CREATE TRIGGER IF NOT EXISTS prediction_outcomes_no_delete BEFORE DELETE ON prediction_outcomes
  BEGIN SELECT RAISE(ABORT, 'prediction outcomes are append-only'); END;
`;

export type PredictionOutcome = "HIT" | "MISS" | "EXPIRED";

export interface PredictionCandidate {
  value: string;
  prob: number;
}

export interface PredictionInput {
  device_id: string;
  made_seq: number;
  made_at: number;
  horizon_ms: number;
  context_key: string;
  candidates: PredictionCandidate[];
  /** Structured snapshot of the situation when the guess was made (see PredictionContext). */
  context?: PredictionContext;
}

export interface PredictionRow extends PredictionInput {
  prediction_id: string;
  outcome: PredictionOutcome | null;
  actual: string | null;
  actual_seq: number | null;
  hit_rank: number | null;
  latency_ms: number | null;
  context: PredictionContext;
  /** Situation when the real action happened (only for guesses that resolved with an action). */
  actual_context: PredictionContext | null;
}

/** One observed action the resolver may match against (already extracted from an event). */
export interface ObservedAction {
  seq: number;
  ts: number;
  value: string;
  /** Situation at the moment of this action, stored on the outcome row. */
  context?: PredictionContext;
}

export type Daypart = "night" | "morning" | "afternoon" | "evening";

/**
 * Structured snapshot of the situation around a guess or an action. Every group is optional: a field
 * the system did not receive is left out and named in `missing`, never guessed.
 */
export interface PredictionContext {
  time?: { ts: number; hour: number; minute: number; dow: number; is_weekend: boolean; daypart: Daypart; tz_offset_min: number };
  app?: { package?: string; label?: string; screen?: string };
  device?: {
    screen_state?: string;
    mode?: string;
    battery_pct?: number;
    charging?: boolean;
    network?: string;
    idle_ms?: number;
    metered?: boolean;
    network_bandwidth_kbps?: number;
  };
  ambient?: {
    temp_c?: number;
    humidity_pct?: number;
    source?: string;
    lux?: number;
    proximity_cm?: number;
    physical_state?: "in_pocket" | "face_down" | "desk_ambient" | "handheld" | "at_ear" | "unknown" | string;
  };
  /** Coarse only: lat/lon are rounded to 2 decimals (about 1 km) before storage. */
  location?: { place?: string; lat?: number; lon?: number; accuracy_m?: number };
  /** Native Android system contextual suggestions and on-device ML priors (TextClassifier) */
  system_suggestions?: {
    primary_action?: string;
    actions?: string[];
    entities?: Array<{ type: string; value: string; confidence?: number }>;
    observed_ts?: number;
  };
  /** Native Android audio mode & headset routing */
  audio?: {
    mode?: "normal" | "in_call" | "in_communication" | "ringtone" | string;
    in_call?: boolean;
    music_active?: boolean;
    output_type?: "speaker" | "bluetooth_headset" | "wired_headset" | string;
  };
  /** Native Android proactive thermal throttling forecast and headroom */
  thermal?: {
    headroom?: number;
    status?: "nominal" | "elevated" | "throttling" | string;
  };
  /** Native Android battery micro-telemetry */
  battery_micro?: {
    temp_c?: number;
    voltage_mv?: number;
    plugged?: "unplugged" | "ac" | "usb" | "wireless" | string;
    current_ma?: number;
  };
  /** Low-power physical motion state classification */
  motion?: {
    state?: "still" | "walking" | "running" | "in_vehicle" | "unknown" | string;
    confidence?: number;
  };
  /** Hardware physical surface & pocket detection */
  physical_surface?: {
    state?: "in_pocket" | "face_down" | "desk_ambient" | "handheld" | "at_ear" | "unknown" | string;
    proximity_cm?: number;
    lux?: number;
    gravity_z?: number;
  };
  /** Hardware network telemetry & metering */
  network_telemetry?: {
    connected?: boolean;
    transport?: "wifi" | "cellular" | "ethernet" | "vpn" | "other" | "none" | "unknown" | string;
    metered?: boolean;
    vpn?: boolean;
    downstream_kbps?: number;
    upstream_kbps?: number;
    validated?: boolean;
  };
  /** 1-Tap actionable notification actions extracted from posted notifications */
  notification_actions?: Array<{
    action_id: string;
    title: string;
  }>;
  /** Local LLM or on-device triage category (urgent / routine / noise) */
  triage?: "urgent" | "routine" | "noise" | string;
  /** Expected signals that were not available when this snapshot was taken, e.g. "ambient.temp_c". */
  missing?: string[];
  [extra: string]: unknown;
}

/** Signals worth having that the log reports as missing when absent. */
export const EXPECTED_CONTEXT_FIELDS = [
  "device.screen_state",
  "device.battery_pct",
  "device.network",
  "ambient.temp_c",
  "location",
] as const;

export function daypartOf(hour: number): Daypart {
  if (hour < 6) return "night";
  if (hour < 12) return "morning";
  if (hour < 18) return "afternoon";
  return "evening";
}

/** Wall-clock facts for a timestamp in the given UTC offset (minutes east of UTC). */
export function timeContext(ts: number, tzOffsetMin: number): NonNullable<PredictionContext["time"]> {
  const local = new Date(ts + tzOffsetMin * 60_000);
  const hour = local.getUTCHours();
  const dow = local.getUTCDay();
  return { ts, hour, minute: local.getUTCMinutes(), dow, is_weekend: dow === 0 || dow === 6, daypart: daypartOf(hour), tz_offset_min: tzOffsetMin };
}

const round2 = (n: number): number => Math.round(n * 100) / 100;

export function getPath(obj: unknown, path: string): unknown {
  let cur: unknown = obj;
  for (const part of path.split(".")) {
    if (cur === null || typeof cur !== "object") return undefined;
    cur = (cur as Record<string, unknown>)[part];
  }
  return cur;
}

/** Drops undefined, rounds coordinates to about 1 km, and fills `missing` for absent expected signals. */
export function finalizeContext(ctx: PredictionContext | undefined): PredictionContext {
  const out: PredictionContext = JSON.parse(JSON.stringify(ctx ?? {}));
  if (out.location) {
    if (typeof out.location.lat === "number") out.location.lat = round2(out.location.lat);
    if (typeof out.location.lon === "number") out.location.lon = round2(out.location.lon);
  }
  const missing = new Set<string>();
  for (const f of EXPECTED_CONTEXT_FIELDS) {
    const v = getPath(out, f);
    const empty = v === undefined || v === null || (typeof v === "object" && Object.keys(v as object).length === 0);
    if (empty) missing.add(f);
  }
  out.missing = [...missing];
  return out;
}

export function ensurePredictionTables(raw: DatabaseSync): void {
  raw.exec(PREDICTION_SCHEMA_SQL);
  raw.exec(CHECKPOINT_SCHEMA_SQL);
}

export function predictionId(deviceId: string, madeSeq: number): string {
  return `pred:${deviceId}:${madeSeq}`;
}

/**
 * Frequency scorer: P(next | current) from consecutive pairs in `history` (oldest first).
 * Candidates are the top `k` observed successors. When `current` was never seen with a successor,
 * falls back to overall frequency. Returns [] when there is no history at all (no guess is logged).
 */
export function predictNext(history: readonly string[], current: string, k = 3): PredictionCandidate[] {
  const successors = new Map<string, number>();
  const overall = new Map<string, number>();
  for (let i = 0; i < history.length; i++) {
    overall.set(history[i], (overall.get(history[i]) ?? 0) + 1);
    if (i > 0 && history[i - 1] === current) {
      successors.set(history[i], (successors.get(history[i]) ?? 0) + 1);
    }
  }
  const table = successors.size > 0 ? successors : overall;
  const total = [...table.values()].reduce((a, b) => a + b, 0);
  if (total === 0) return [];
  return [...table.entries()]
    .sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))
    .slice(0, k)
    .map(([value, n]) => ({ value, prob: n / total }));
}

function assertInput(p: PredictionInput): void {
  if (!p.device_id) throw new TypeError("prediction: device_id required");
  for (const key of ["made_seq", "made_at", "horizon_ms"] as const) {
    if (!Number.isSafeInteger(p[key]) || p[key] <= 0) throw new TypeError(`prediction: ${key} must be a positive safe integer`);
  }
  if (!p.context_key) throw new TypeError("prediction: context_key required");
  if (!Array.isArray(p.candidates) || p.candidates.length === 0) throw new TypeError("prediction: at least one candidate required");
  let sum = 0;
  for (const c of p.candidates) {
    if (typeof c.value !== "string" || c.value.length === 0) throw new TypeError("prediction: candidate value must be a non-empty string");
    if (!Number.isFinite(c.prob) || c.prob < 0 || c.prob > 1) throw new TypeError("prediction: candidate prob must be in [0,1]");
    sum += c.prob;
  }
  if (sum > 1 + 1e-9) throw new TypeError("prediction: candidate probabilities sum above 1");
}

/** Insert a guess. Idempotent per (device, made_seq). Returns the id, or null when it already existed. */
export function logPrediction(raw: DatabaseSync, input: PredictionInput): string | null {
  assertInput(input);
  const id = predictionId(input.device_id, input.made_seq);
  const res = raw
    .prepare(
      `INSERT OR IGNORE INTO predictions (prediction_id, device_id, made_seq, made_at, horizon_ms, context_key, candidates, context)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(id, input.device_id, input.made_seq, input.made_at, input.horizon_ms, input.context_key, JSON.stringify(input.candidates), JSON.stringify(finalizeContext(input.context)));
  return Number(res.changes) > 0 ? id : null;
}

interface OpenRow {
  prediction_id: string;
  made_seq: number;
  made_at: number;
  horizon_ms: number;
  candidates: string;
}

/**
 * Resolve every open prediction of `deviceId` that precedes `actual`, using `actual` as the
 * answer key. HIT = top-1 guess matched; MISS = something else happened inside the horizon (the real
 * action is kept, with `hit_rank` when it was a lower-ranked candidate); EXPIRED = the next action
 * came after the horizon or never came (the late action is still recorded when known).
 * Returns the number resolved.
 */
export function resolveWithAction(raw: DatabaseSync, deviceId: string, actual: ObservedAction): number {
  const open = raw
    .prepare(
      `SELECT p.prediction_id, p.made_seq, p.made_at, p.horizon_ms, p.candidates
         FROM predictions p LEFT JOIN prediction_outcomes o ON o.prediction_id = p.prediction_id
        WHERE p.device_id = ? AND o.prediction_id IS NULL AND p.made_seq < ?
        ORDER BY p.made_seq`,
    )
    .all(deviceId, actual.seq) as unknown as OpenRow[];
  if (open.length === 0) return 0;
  const insert = raw.prepare(
    `INSERT OR IGNORE INTO prediction_outcomes (prediction_id, outcome, actual, actual_seq, hit_rank, latency_ms, resolved_at, actual_context)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const actualContext = JSON.stringify(finalizeContext(actual.context));
  let n = 0;
  for (const row of open) {
    const cands = JSON.parse(row.candidates) as PredictionCandidate[];
    const latency = Math.max(0, actual.ts - row.made_at);
    const rank = cands.findIndex((c) => c.value === actual.value);
    let outcome: PredictionOutcome;
    if (latency > row.horizon_ms) outcome = "EXPIRED";
    else outcome = rank === 0 ? "HIT" : "MISS";
    insert.run(row.prediction_id, outcome, actual.value, actual.seq, rank >= 0 ? rank + 1 : null, latency, actual.ts, actualContext);
    n++;
  }
  return n;
}

/** Mark open predictions whose horizon has passed with no later action as EXPIRED (no actual known). */
export function expireStale(raw: DatabaseSync, nowMs: number): number {
  const res = raw
    .prepare(
      `INSERT OR IGNORE INTO prediction_outcomes (prediction_id, outcome, actual, actual_seq, hit_rank, latency_ms, resolved_at)
       SELECT p.prediction_id, 'EXPIRED', NULL, NULL, NULL, NULL, ?
         FROM predictions p LEFT JOIN prediction_outcomes o ON o.prediction_id = p.prediction_id
        WHERE o.prediction_id IS NULL AND p.made_at + p.horizon_ms < ?`,
    )
    .run(nowMs, nowMs);
  return Number(res.changes);
}

export function loadPredictionRows(raw: DatabaseSync, sinceMs = 0): PredictionRow[] {
  const rows = raw
    .prepare(
      `SELECT p.prediction_id, p.device_id, p.made_seq, p.made_at, p.horizon_ms, p.context_key, p.candidates, p.context,
              o.outcome, o.actual, o.actual_seq, o.hit_rank, o.latency_ms, o.actual_context
         FROM predictions p LEFT JOIN prediction_outcomes o ON o.prediction_id = p.prediction_id
        WHERE p.made_at >= ? ORDER BY p.made_seq`,
    )
    .all(sinceMs) as unknown as Array<Record<string, unknown>>;
  return rows.map((r) => ({
    prediction_id: r.prediction_id as string,
    device_id: r.device_id as string,
    made_seq: r.made_seq as number,
    made_at: r.made_at as number,
    horizon_ms: r.horizon_ms as number,
    context_key: r.context_key as string,
    candidates: JSON.parse(r.candidates as string) as PredictionCandidate[],
    outcome: (r.outcome as PredictionOutcome | null) ?? null,
    actual: (r.actual as string | null) ?? null,
    actual_seq: (r.actual_seq as number | null) ?? null,
    hit_rank: (r.hit_rank as number | null) ?? null,
    latency_ms: (r.latency_ms as number | null) ?? null,
    context: JSON.parse(r.context as string) as PredictionContext,
    actual_context: r.actual_context ? (JSON.parse(r.actual_context as string) as PredictionContext) : null,
  }));
}

/** Wilson score interval for a binomial proportion; null when n is 0. */
export function wilsonInterval(successes: number, n: number, z = 1.96): { lo: number; hi: number } | null {
  if (n <= 0) return null;
  const p = successes / n;
  const denom = 1 + (z * z) / n;
  const centre = p + (z * z) / (2 * n);
  const margin = z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n));
  return { lo: Math.max(0, (centre - margin) / denom), hi: Math.min(1, (centre + margin) / denom) };
}

function wilsonLower(successes: number, n: number, z = 1.96): number | null {
  return wilsonInterval(successes, n, z)?.lo ?? null;
}

const LOSS_FLOOR = 1e-6;

/** Pre-registered baselines logged with a prediction (context.baselines); see usage-baseline.ts. */
interface LoggedDist {
  cands: PredictionCandidate[];
  cold_start?: boolean;
}
function loggedBaselines(r: PredictionRow): { avg_usage: LoggedDist; persistence: LoggedDist } | null {
  const b = (r.context as Record<string, unknown>).baselines as Record<string, unknown> | undefined;
  const ok = (d: unknown): boolean => !!d && typeof d === "object" && Array.isArray((d as LoggedDist).cands);
  if (!b || !ok(b.avg_usage) || !ok(b.persistence)) return null;
  return b as unknown as { avg_usage: LoggedDist; persistence: LoggedDist };
}

/** Probability a logged distribution gave the actual action; unlisted actions get the unlisted residual mass. */
function probOf(cands: readonly PredictionCandidate[], actual: string): number {
  const hit = cands.find((c) => c.value === actual);
  if (hit) return Math.max(hit.prob, LOSS_FLOOR);
  const residual = 1 - cands.reduce((s, c) => s + c.prob, 0);
  return Math.max(residual, LOSS_FLOOR);
}

export interface BaselineScore {
  top1: number | null;
  /** Mean -ln P(actual). Unlisted actions are scored with the distribution's unlisted residual mass. */
  logLoss: number | null;
}

/** Engine vs the logged baselines, on identical rows only. */
export interface BaselineComparison {
  /** Rows scored (have an actual and logged, non-cold-start baselines). */
  n: number;
  /** Rows with an actual left out because avg_usage was in cold start. */
  coldStart: number;
  /** Rows with an actual that predate baseline logging; only the legacy post-hoc `baselineTop1` covers them. */
  legacy: number;
  engine: BaselineScore;
  avg_usage: BaselineScore;
  persistence: BaselineScore;
}

function scoreRows(rows: readonly PredictionRow[]): BaselineComparison {
  let coldStart = 0;
  let legacy = 0;
  let n = 0;
  const acc = {
    engine: { hit: 0, loss: 0 },
    avg_usage: { hit: 0, loss: 0 },
    persistence: { hit: 0, loss: 0 },
  };
  for (const r of rows) {
    if (!r.actual) continue;
    const b = loggedBaselines(r);
    if (!b) {
      legacy++;
      continue;
    }
    if (b.avg_usage.cold_start) {
      coldStart++;
      continue;
    }
    n++;
    const dists = { engine: r.candidates, avg_usage: b.avg_usage.cands, persistence: b.persistence.cands };
    for (const k of ["engine", "avg_usage", "persistence"] as const) {
      acc[k].hit += dists[k][0]?.value === r.actual ? 1 : 0;
      acc[k].loss += -Math.log(probOf(dists[k], r.actual));
    }
  }
  const s = (k: keyof typeof acc): BaselineScore => ({ top1: n > 0 ? acc[k].hit / n : null, logLoss: n > 0 ? acc[k].loss / n : null });
  return { n, coldStart, legacy, engine: s("engine"), avg_usage: s("avg_usage"), persistence: s("persistence") };
}

export interface CalibrationBin {
  /** Inclusive lower, exclusive upper bound of the top-1 probability. */
  lo: number;
  hi: number;
  n: number;
  meanPredicted: number;
  observedRate: number;
  /** Wilson 95% interval on observedRate. */
  lo95: number;
  hi95: number;
}

export interface GuideEntry {
  context_key: string;
  top1: string;
  n: number;
  /** What actually happened after this guess, most frequent first. */
  actual: Array<{ value: string; n: number; prob: number }>;
}

export interface PredictionReport {
  total: number;
  open: number;
  expired: number;
  /** Predictions with a known actual action inside the horizon (HIT + MISS). */
  scored: number;
  hits: number;
  top1: number | null;
  top1WilsonLower: number | null;
  top3: number | null;
  /** Hit rate of always guessing the most common actual action; the bar the scorer must clear. */
  baselineTop1: number | null;
  beatsBaseline: boolean | null;
  /** Engine vs the pre-registered logged baselines on the scored (HIT + MISS) rows. */
  baselines: BaselineComparison;
  /**
   * Every row with a known actual (HIT, MISS and EXPIRED-with-actual) scored against `actual`.
   * The headline top-1 is conditional on the next action landing inside the horizon.
   */
  unconditional: {
    n: number;
    top1: number | null;
    top1WilsonLower: number | null;
    top1WilsonUpper: number | null;
    baselines: BaselineComparison;
  };
  calibration: CalibrationBin[];
  guide: GuideEntry[];
}

export interface PredictionReportOptions {
  bins?: number;
  /** Cap on guide rows returned (largest n first). */
  guideLimit?: number;
  /**
   * Slice the probability guide by a context field (dotted path, e.g. "time.daypart" or "device.network")
   * instead of the coarse context_key. Rows without that field group under "unknown".
   */
  guideBy?: string;
}

export function computePredictionReport(rows: readonly PredictionRow[], opts: PredictionReportOptions = {}): PredictionReport {
  const bins = opts.bins ?? 5;
  const open = rows.filter((r) => r.outcome === null).length;
  const expired = rows.filter((r) => r.outcome === "EXPIRED").length;
  const scoredRows = rows.filter((r) => r.outcome === "HIT" || r.outcome === "MISS");
  const hits = scoredRows.filter((r) => r.outcome === "HIT").length;
  const top3Hits = scoredRows.filter((r) => r.hit_rank !== null && r.hit_rank <= 3).length;

  const freq = new Map<string, number>();
  for (const r of scoredRows) if (r.actual) freq.set(r.actual, (freq.get(r.actual) ?? 0) + 1);
  const modal = [...freq.values()].reduce((a, b) => Math.max(a, b), 0);
  const scored = scoredRows.length;
  const baselineTop1 = scored > 0 ? modal / scored : null;
  const top1 = scored > 0 ? hits / scored : null;

  const withActual = rows.filter((r) => r.actual !== null && r.outcome !== null);
  const uncondHits = withActual.filter((r) => r.candidates[0]?.value === r.actual).length;
  const uncondCi = wilsonInterval(uncondHits, withActual.length);

  const calibration: CalibrationBin[] = [];
  for (let b = 0; b < bins; b++) {
    const lo = b / bins;
    const hi = (b + 1) / bins;
    const inBin = scoredRows.filter((r) => {
      const p = r.candidates[0]?.prob ?? 0;
      return p >= lo && (b === bins - 1 ? p <= hi : p < hi);
    });
    if (inBin.length === 0) continue;
    const binHits = inBin.filter((r) => r.outcome === "HIT").length;
    const ci = wilsonInterval(binHits, inBin.length)!;
    calibration.push({
      lo,
      hi,
      n: inBin.length,
      meanPredicted: inBin.reduce((a, r) => a + (r.candidates[0]?.prob ?? 0), 0) / inBin.length,
      observedRate: binHits / inBin.length,
      lo95: ci.lo,
      hi95: ci.hi,
    });
  }

  const groups = new Map<string, { context_key: string; top1: string; counts: Map<string, number>; n: number }>();
  for (const r of scoredRows) {
    const top = r.candidates[0]?.value;
    if (!top || !r.actual) continue;
    const groupName = opts.guideBy ? String(getPath(r.context, opts.guideBy) ?? "unknown") : r.context_key;
    const key = `${groupName}\u0000${top}`;
    let g = groups.get(key);
    if (!g) groups.set(key, (g = { context_key: groupName, top1: top, counts: new Map(), n: 0 }));
    g.counts.set(r.actual, (g.counts.get(r.actual) ?? 0) + 1);
    g.n++;
  }
  const guide: GuideEntry[] = [...groups.values()]
    .sort((a, b) => b.n - a.n || (a.context_key < b.context_key ? -1 : 1))
    .slice(0, opts.guideLimit ?? 50)
    .map((g) => ({
      context_key: g.context_key,
      top1: g.top1,
      n: g.n,
      actual: [...g.counts.entries()]
        .sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))
        .map(([value, n]) => ({ value, n, prob: n / g.n })),
    }));

  return {
    total: rows.length,
    open,
    expired,
    scored,
    hits,
    top1,
    top1WilsonLower: wilsonLower(hits, scored),
    top3: scored > 0 ? top3Hits / scored : null,
    baselineTop1,
    beatsBaseline: top1 !== null && baselineTop1 !== null ? top1 > baselineTop1 : null,
    baselines: scoreRows(scoredRows),
    unconditional: {
      n: withActual.length,
      top1: withActual.length > 0 ? uncondHits / withActual.length : null,
      top1WilsonLower: uncondCi?.lo ?? null,
      top1WilsonUpper: uncondCi?.hi ?? null,
      baselines: scoreRows(withActual),
    },
    calibration,
    guide,
  };
}

const pct = (v: number | null): string => (v === null ? "n/a" : `${(v * 100).toFixed(1)}%`);

const ll = (v: number | null): string => (v === null ? "n/a" : v.toFixed(3));

function formatComparison(title: string, c: BaselineComparison): string[] {
  const out = [`  ${title}: n=${c.n} (cold start excluded ${c.coldStart}, legacy rows without logged baselines ${c.legacy})`];
  if (c.n > 0) {
    for (const [name, s] of [["engine", c.engine], ["avg_usage", c.avg_usage], ["persistence", c.persistence]] as const) {
      out.push(`    ${name.padEnd(12)} top-1 ${pct(s.top1)}  log loss ${ll(s.logLoss)}`);
    }
  }
  return out;
}

export function formatPredictionReport(r: PredictionReport): string {
  const lines = [
    "Next-action prediction log",
    `  Guesses:        ${r.total}  (open ${r.open}, expired ${r.expired}, scored ${r.scored})`,
    `  Top-1 hit rate: ${pct(r.top1)}  (Wilson 95% lower ${pct(r.top1WilsonLower)})`,
    `  Top-3 hit rate: ${pct(r.top3)}`,
    `  Baseline:       ${pct(r.baselineTop1)}  (legacy, post-hoc: always guess the most common next action)`,
    `  Beats baseline: ${r.beatsBaseline === null ? "n/a" : r.beatsBaseline ? "yes" : "NO"}`,
  ];
  lines.push(...formatComparison("Pre-registered baselines, scored rows (within horizon)", r.baselines));
  lines.push(
    `  Unconditional (all rows with a known actual): n=${r.unconditional.n}  top-1 ${pct(r.unconditional.top1)}  (Wilson 95% ${pct(r.unconditional.top1WilsonLower)}-${pct(r.unconditional.top1WilsonUpper)})`,
  );
  lines.push(...formatComparison("Pre-registered baselines, unconditional", r.unconditional.baselines));
  if (r.calibration.length > 0) {
    lines.push("  Calibration (top-1 confidence -> observed hit rate):");
    for (const c of r.calibration) {
      lines.push(
        `    ${pct(c.lo)}-${pct(c.hi)}  n=${c.n}  said ${pct(c.meanPredicted)}  got ${pct(c.observedRate)}  (95% CI ${pct(c.lo95)}-${pct(c.hi95)})`,
      );
    }
  }
  if (r.guide.length > 0) {
    lines.push("  Probability guide (context, guess -> what really happened):");
    for (const g of r.guide.slice(0, 10)) {
      const dist = g.actual.map((a) => `${a.value} ${pct(a.prob)}`).join(", ");
      lines.push(`    [${g.context_key}] guessed ${g.top1} (n=${g.n}) -> ${dist}`);
    }
  }
  return lines.join("\n");
}
