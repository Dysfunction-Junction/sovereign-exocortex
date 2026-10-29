/**
 * @file usage-baseline.ts
 * Pre-registered comparators for the next-action predictor, computed before each guess and logged
 * inside the prediction's context JSON (`context.baselines`), so the report never has to pick a
 * baseline after seeing the answers.
 *
 *   avg_usage    - the user's trailing share per action: count(a in window) / n, over a time window
 *                  (14 days). By daypart; falls back to the overall window when the daypart has fewer
 *                  than `minCell` actions. Additive smoothing (alpha 0.5) over the actions seen in the
 *                  window plus OTHER. Cold start (overall n < `minOverall`): uniform over seen + OTHER,
 *                  flagged `cold_start`.
 *   persistence  - P(next = last action) = smoothed repeat rate (repeats+1)/(transitions+2); the rest
 *                  of the mass follows avg_usage.
 *
 * Feed it every resolved action in order (`observe`) and ask for `predict` before the next guess.
 */

import type { Daypart, PredictionCandidate } from "./prediction-log.js";

export const BASELINE_WINDOW_MS = 14 * 24 * 60 * 60 * 1000;
export const BASELINE_MIN_CELL = 30;
export const BASELINE_MIN_OVERALL = 10;
export const BASELINE_ALPHA = 0.5;
const MAX_LOGGED_CANDIDATES = 20;

export interface BaselineDist {
  /** Highest first. Actions not listed are scored by `other`. */
  cands: PredictionCandidate[];
  /** Mass on OTHER plus any candidates dropped from the logged list. */
  other: number;
}

export interface AvgUsageBaseline extends BaselineDist {
  /** Actions in the window used for the chosen cell. */
  n: number;
  cell: "daypart" | "overall";
  cold_start: boolean;
}

export interface PersistenceBaseline extends BaselineDist {
  repeat_rate: number;
}

export interface LoggedBaselines {
  avg_usage: AvgUsageBaseline;
  persistence: PersistenceBaseline;
}

export interface UsageBaselineOptions {
  windowMs?: number;
  minCell?: number;
  minOverall?: number;
  alpha?: number;
}

interface Entry {
  ts: number;
  action: string;
  daypart: Daypart;
  /** 1 when a previous action existed when this one was observed. */
  trans: 0 | 1;
  repeat: 0 | 1;
}

function finish(entries: Array<[string, number]>, otherMass: number): BaselineDist {
  const sorted = entries.sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1));
  const kept = sorted.slice(0, MAX_LOGGED_CANDIDATES);
  const dropped = sorted.slice(MAX_LOGGED_CANDIDATES).reduce((s, e) => s + e[1], 0);
  return { cands: kept.map(([value, prob]) => ({ value, prob })), other: otherMass + dropped };
}

export class UsageBaseline {
  private readonly windowMs: number;
  private readonly minCell: number;
  private readonly minOverall: number;
  private readonly alpha: number;
  private entries: Entry[] = [];
  private head = 0;
  private readonly overall = new Map<string, number>();
  private readonly byDaypart = new Map<Daypart, Map<string, number>>();
  private repeats = 0;
  private transitions = 0;
  private last: string | undefined;

  constructor(opts: UsageBaselineOptions = {}) {
    this.windowMs = opts.windowMs ?? BASELINE_WINDOW_MS;
    this.minCell = opts.minCell ?? BASELINE_MIN_CELL;
    this.minOverall = opts.minOverall ?? BASELINE_MIN_OVERALL;
    this.alpha = opts.alpha ?? BASELINE_ALPHA;
  }

  /** Actions currently inside the window. */
  get size(): number {
    return this.entries.length - this.head;
  }

  private bump(map: Map<string, number>, key: string, by: number): void {
    const v = (map.get(key) ?? 0) + by;
    if (v <= 0) map.delete(key);
    else map.set(key, v);
  }

  /** Drop actions older than the window (relative to `now`). Called lazily on observe and predict. */
  private expire(now: number): void {
    const cutoff = now - this.windowMs;
    while (this.head < this.entries.length && this.entries[this.head].ts < cutoff) {
      const e = this.entries[this.head++];
      this.bump(this.overall, e.action, -1);
      const dp = this.byDaypart.get(e.daypart);
      if (dp) {
        this.bump(dp, e.action, -1);
        if (dp.size === 0) this.byDaypart.delete(e.daypart);
      }
      this.repeats -= e.repeat;
      this.transitions -= e.trans;
    }
    if (this.head > 1024 && this.head * 2 > this.entries.length) {
      this.entries = this.entries.slice(this.head);
      this.head = 0;
    }
  }

  /** Record a resolved action. Must be called in time order, before predicting the action after it. */
  observe(action: string, ts: number, daypart: Daypart): void {
    this.expire(ts);
    const trans: 0 | 1 = this.last === undefined ? 0 : 1;
    const repeat: 0 | 1 = this.last === action ? 1 : 0;
    this.entries.push({ ts, action, daypart, trans, repeat });
    this.bump(this.overall, action, 1);
    let dp = this.byDaypart.get(daypart);
    if (!dp) this.byDaypart.set(daypart, (dp = new Map()));
    this.bump(dp, action, 1);
    this.repeats += repeat;
    this.transitions += trans;
    this.last = action;
  }

  private avgUsage(daypart: Daypart): AvgUsageBaseline {
    const overallN = this.size;
    const seen = [...this.overall.keys()];
    if (overallN < this.minOverall) {
      const u = 1 / (seen.length + 1);
      const d = finish(seen.map((a) => [a, u] as [string, number]), u);
      return { ...d, n: overallN, cell: "overall", cold_start: true };
    }
    const dp = this.byDaypart.get(daypart);
    const dpN = dp ? [...dp.values()].reduce((s, v) => s + v, 0) : 0;
    const useDaypart = dp !== undefined && dpN >= this.minCell;
    const counts = useDaypart ? dp : this.overall;
    const n = useDaypart ? dpN : overallN;
    // Smooth over every action seen in the window (not just in this cell) plus OTHER.
    const denom = n + this.alpha * (seen.length + 1);
    const d = finish(
      seen.map((a) => [a, ((counts.get(a) ?? 0) + this.alpha) / denom] as [string, number]),
      this.alpha / denom,
    );
    return { ...d, n, cell: useDaypart ? "daypart" : "overall", cold_start: false };
  }

  /** Both baselines for the guess about to be made at time `now` in `daypart`. */
  predict(now: number, daypart: Daypart): LoggedBaselines {
    this.expire(now);
    const avg = this.avgUsage(daypart);
    const r = (this.repeats + 1) / (this.transitions + 2);
    if (this.last === undefined) return { avg_usage: avg, persistence: { cands: avg.cands, other: avg.other, repeat_rate: r } };
    const entries = avg.cands.map((c) => [c.value, (1 - r) * c.prob + (c.value === this.last ? r : 0)] as [string, number]);
    if (!entries.some(([v]) => v === this.last)) entries.push([this.last, r]);
    const persistence = finish(entries, (1 - r) * avg.other);
    return { avg_usage: avg, persistence: { ...persistence, repeat_rate: r } };
  }
}
