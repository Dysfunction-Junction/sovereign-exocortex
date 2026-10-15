/**
 * @file shadow-metrics.ts
 * Shadow-mode calibration metrics (Architecture v3, "Shadow mode and rollout").
 *
 * Pure computation over gate decisions + shadow labels, plus a read-only SQL
 * loader. Never writes to the database.
 */

import type { DatabaseSync } from "node:sqlite";
import type { GateDecisionAction, ShadowLabel } from "./schema-types.js";

export const SHADOW_LABELS: readonly ShadowLabel[] = ["wanted", "not_wanted", "already_did", "ignored"] as const;

export function isShadowLabel(val: unknown): val is ShadowLabel {
  return typeof val === "string" && (SHADOW_LABELS as readonly string[]).includes(val);
}

const DAY_MS = 86_400_000;
const WILSON_Z = 1.96;

export type LabelSource = "tap" | "inferred";

export interface ShadowRow {
  proposal_id: string;
  shadow: number;
  decision: GateDecisionAction;
  mode: string;
  gate_ts: number;
  label: ShadowLabel | null;
  label_source: LabelSource | null;
  action?: string | null;
}

export interface ShadowMetricsOptions {
  nowMs: number;
  windowDays?: number;
  threshold?: number;
  minLabels?: number;
  baselinePrecision?: number;
  db?: DatabaseSync;
}

export interface BaselineCalculationOptions {
  nowMs: number;
  windowDays?: number;
  hourToleranceMs?: number;
}

export interface BaselineResult {
  baselinePrecision: number | null;
  evaluations: number;
  baselineWanted: number;
  baselineNotWanted: number;
}

export type ShadowVerdict = "insufficient_data" | "heuristic_scorer" | "pass" | "fail";

export type AutomatedVerdict =
  | "SUFFICIENT_DATA_PASS"
  | "BREAKER_TRIPPED_PRECISION_LOW"
  | "INSUFFICIENT_DATA"
  | "HEURISTIC_SCORER";

export function toAutomatedVerdict(verdict: ShadowVerdict): AutomatedVerdict {
  switch (verdict) {
    case "pass":
      return "SUFFICIENT_DATA_PASS";
    case "fail":
      return "BREAKER_TRIPPED_PRECISION_LOW";
    case "insufficient_data":
      return "INSUFFICIENT_DATA";
    case "heuristic_scorer":
      return "HEURISTIC_SCORER";
  }
}

export interface ShadowMetrics {
  windowDays: number;
  surfaced: number;
  wanted: number;
  notWanted: number;
  alreadyDid: number;
  ignored: number;
  unlabeled: number;
  tapped: number;
  inferred: number;
  /** wanted/not_wanted labels whose source is inferred; excluded from precision. */
  inferredDecided: number;
  precision: number | null;
  wilsonLower: number | null;
  pessimisticPrecision: number | null;
  coverage: number | null;
  focusRegret: number;
  baselinePrecision: number | null;
  baselineGap: number | null;
  baselineEvaluations?: number;
  threshold: number;
  minLabels: number;
  verdict: ShadowVerdict;
  automatedVerdict: AutomatedVerdict;
  breakerTripped: boolean;
}

function wilsonLowerBound(successes: number, n: number): number | null {
  if (n === 0) return null;
  const p = successes / n;
  const z2 = WILSON_Z * WILSON_Z;
  const centre = p + z2 / (2 * n);
  const margin = WILSON_Z * Math.sqrt((p * (1 - p)) / n + z2 / (4 * n * n));
  return Math.min(1, Math.max(0, (centre - margin) / (1 + z2 / n)));
}

function ratio(num: number, den: number): number | null {
  return den === 0 ? null : num / den;
}

export function computeShadowMetrics(rows: ShadowRow[], opts: ShadowMetricsOptions): ShadowMetrics {
  const windowDays = opts.windowDays ?? 14;
  const threshold = opts.threshold ?? 0.9;
  const minLabels = opts.minLabels ?? 50;

  // Latest gate decision per proposal wins (ties: later row in input order).
  const latest = new Map<string, ShadowRow>();
  for (const r of rows) {
    const prev = latest.get(r.proposal_id);
    if (!prev || r.gate_ts >= prev.gate_ts) latest.set(r.proposal_id, r);
  }

  const since = opts.nowMs - windowDays * DAY_MS;
  const surfaced = [...latest.values()].filter(
    (r) => r.shadow === 1 && r.decision === "SURFACE" && r.gate_ts > since && r.gate_ts <= opts.nowMs,
  );

  const sourceOf = (r: ShadowRow): LabelSource =>
    r.label_source ?? (r.label === "wanted" || r.label === "not_wanted" ? "tap" : "inferred");
  // Precision is tap-calibrated: inferred wanted/not_wanted never feed it.
  const count = (label: ShadowLabel, tapOnly: boolean) =>
    surfaced.filter((r) => r.label === label && (!tapOnly || sourceOf(r) === "tap")).length;
  const wanted = count("wanted", true);
  const notWanted = count("not_wanted", true);
  const alreadyDid = count("already_did", false);
  const ignored = count("ignored", false);
  const labeled = surfaced.filter((r) => r.label !== null);

  let tapped = 0;
  let inferred = 0;
  for (const r of labeled) {
    if (sourceOf(r) === "tap") tapped++;
    else inferred++;
  }
  const inferredDecided = labeled.filter(
    (r) => (r.label === "wanted" || r.label === "not_wanted") && sourceOf(r) === "inferred",
  ).length;

  const decided = wanted + notWanted;
  const precision = ratio(wanted, decided);

  let baselinePrecision = opts.baselinePrecision;
  let baselineEvaluations: number | undefined;

  if (baselinePrecision === undefined && opts.db) {
    const autoBaseline = computeSameHourYesterdayBaseline(opts.db, {
      nowMs: opts.nowMs,
      windowDays,
    });
    if (autoBaseline.baselinePrecision !== null) {
      baselinePrecision = autoBaseline.baselinePrecision;
      baselineEvaluations = autoBaseline.evaluations;
    }
  }

  const baselineGap =
    precision !== null && baselinePrecision !== undefined ? precision - baselinePrecision : null;

  // Compare in counts, not floats: wanted/decided >= threshold.
  const meetsThreshold = wanted >= threshold * decided - 1e-9;
  let verdict: ShadowVerdict;
  if (precision === null || decided < minLabels) verdict = "insufficient_data";
  else if (!meetsThreshold) verdict = "fail";
  else if (baselineGap !== null && baselineGap <= 0) verdict = "heuristic_scorer";
  else verdict = "pass";

  return {
    windowDays,
    surfaced: surfaced.length,
    wanted,
    notWanted,
    alreadyDid,
    ignored,
    unlabeled: surfaced.length - labeled.length,
    tapped,
    inferred,
    inferredDecided,
    precision,
    wilsonLower: wilsonLowerBound(wanted, decided),
    pessimisticPrecision: ratio(wanted, decided + ignored),
    coverage: ratio(decided, surfaced.length),
    focusRegret: surfaced.filter((r) => r.mode === "DEEP_FOCUS").length,
    baselinePrecision: baselinePrecision ?? null,
    baselineGap,
    baselineEvaluations,
    threshold,
    minLabels,
    verdict,
    automatedVerdict: toAutomatedVerdict(verdict),
    breakerTripped: verdict === "fail",
  };
}

interface RawShadowRow {
  proposal_id: string;
  shadow: number;
  decision: GateDecisionAction;
  mode: string;
  gate_ts: number;
  label: ShadowLabel | null;
  actual: string | null;
}

function parseSource(actual: string | null): LabelSource | null {
  if (!actual) return null;
  try {
    const source = (JSON.parse(actual) as { source?: unknown }).source;
    return source === "tap" || source === "inferred" ? source : null;
  } catch {
    return null;
  }
}

function actionsMatch(a: string, b: string): boolean {
  if (a === b) return true;
  try {
    const objA = JSON.parse(a);
    const objB = JSON.parse(b);
    return JSON.stringify(objA) === JSON.stringify(objB);
  } catch {
    return false;
  }
}

export function computeSameHourYesterdayBaseline(
  db: DatabaseSync,
  opts: BaselineCalculationOptions,
): BaselineResult {
  const windowDays = opts.windowDays ?? 14;
  const hourToleranceMs = opts.hourToleranceMs ?? 30 * 60 * 1000;
  const since = opts.nowMs - windowDays * DAY_MS;

  const queryOnlyStmt = db.prepare("PRAGMA query_only");
  const wasQueryOnly = Boolean((queryOnlyStmt.get() as { query_only?: number } | undefined)?.query_only);
  if (!wasQueryOnly) {
    db.exec("PRAGMA query_only = ON");
  }

  try {
    interface BaselineRow {
      proposal_id: string;
      action: string;
      gate_ts: number;
      label: ShadowLabel | null;
      actual: string | null;
    }

    const raw = db
      .prepare(
        `WITH ranked AS (
           SELECT g.proposal_id, g.mode, g.decision, g.ts,
                  ROW_NUMBER() OVER (PARTITION BY g.proposal_id ORDER BY g.ts DESC, g.rowid DESC) AS rn
             FROM gate_decisions g
         )
         SELECT r.proposal_id, p.action, r.ts AS gate_ts, l.label, l.actual
           FROM ranked r
           JOIN proposals p ON p.proposal_id = r.proposal_id
           LEFT JOIN shadow_labels l ON l.proposal_id = r.proposal_id
          WHERE r.rn = 1 AND p.shadow = 1 AND r.decision = 'SURFACE'
          ORDER BY r.ts ASC`,
      )
      .all() as unknown as BaselineRow[];

    const surfacedList = raw.map((r) => ({
      proposal_id: r.proposal_id,
      action: r.action,
      gate_ts: r.gate_ts,
      label: r.label,
      source: parseSource(r.actual) ?? (r.label === "wanted" || r.label === "not_wanted" ? "tap" : "inferred"),
    }));

    const targets = surfacedList.filter(
      (r) =>
        r.gate_ts > since &&
        r.gate_ts <= opts.nowMs &&
        (r.label === "wanted" || r.label === "not_wanted") &&
        r.source === "tap",
    );

    let baselineWanted = 0;
    let baselineNotWanted = 0;

    for (const target of targets) {
      const yesterdayTarget = target.gate_ts - DAY_MS;
      const windowStart = yesterdayTarget - hourToleranceMs;
      const windowEnd = yesterdayTarget + hourToleranceMs;

      const candidates = surfacedList.filter(
        (r) => r.gate_ts >= windowStart && r.gate_ts <= windowEnd,
      );

      if (candidates.length === 0) {
        continue;
      }

      const prev = candidates[candidates.length - 1];
      const isMatch = actionsMatch(prev.action, target.action);
      if (isMatch && target.label === "wanted") {
        baselineWanted++;
      } else {
        baselineNotWanted++;
      }
    }

    const evaluations = baselineWanted + baselineNotWanted;
    const baselinePrecision = evaluations > 0 ? baselineWanted / evaluations : null;

    return {
      baselinePrecision,
      evaluations,
      baselineWanted,
      baselineNotWanted,
    };
  } finally {
    if (!wasQueryOnly) {
      db.exec("PRAGMA query_only = OFF");
    }
  }
}

export interface LoadShadowRowsOptions {
  restoreQueryOnly?: boolean;
}

export function loadShadowRows(db: DatabaseSync, options?: LoadShadowRowsOptions): ShadowRow[] {
  const shouldRestore = options?.restoreQueryOnly ?? true;
  const queryOnlyStmt = db.prepare("PRAGMA query_only");
  const wasQueryOnly = Boolean((queryOnlyStmt.get() as { query_only?: number } | undefined)?.query_only);
  if (!wasQueryOnly) {
    db.exec("PRAGMA query_only = ON");
  }
  try {
    const raw = db
      .prepare(
        `WITH ranked AS (
           SELECT g.proposal_id, g.mode, g.decision, g.ts,
                  ROW_NUMBER() OVER (PARTITION BY g.proposal_id ORDER BY g.ts DESC, g.rowid DESC) AS rn
             FROM gate_decisions g
         )
         SELECT r.proposal_id AS proposal_id, p.shadow AS shadow, r.decision AS decision,
                r.mode AS mode, r.ts AS gate_ts, l.label AS label, l.actual AS actual,
                p.action AS action
           FROM ranked r
           JOIN proposals p ON p.proposal_id = r.proposal_id
           LEFT JOIN shadow_labels l ON l.proposal_id = r.proposal_id
          WHERE r.rn = 1 AND p.shadow = 1`,
      )
      .all() as unknown as RawShadowRow[];
    return raw.map(({ actual, ...r }) => {
      if (r.label !== null && !SHADOW_LABELS.includes(r.label)) {
        throw new Error(`shadow_labels: unknown label "${String(r.label)}" for ${r.proposal_id}`);
      }
      return { ...r, label_source: parseSource(actual) };
    });
  } finally {
    if (shouldRestore && !wasQueryOnly) {
      db.exec("PRAGMA query_only = OFF");
    }
  }
}

function pct(v: number | null): string {
  return v === null ? "n/a" : `${(v * 100).toFixed(1)}%`;
}

export function formatShadowReport(m: ShadowMetrics): string {
  const baselineStr =
    m.baselineGap === null
      ? "n/a (no baseline given)"
      : m.baselinePrecision !== null && m.baselineEvaluations !== undefined
        ? `${pct(m.baselineGap)}  (baseline ${pct(m.baselinePrecision)}, n=${m.baselineEvaluations})`
        : pct(m.baselineGap);

  return [
    `Shadow metrics (last ${m.windowDays} days)`,
    `  Surfaced:            ${m.surfaced}  (unlabeled ${m.unlabeled})`,
    `  Labels:              wanted ${m.wanted}, not_wanted ${m.notWanted}, already_did ${m.alreadyDid}, ignored ${m.ignored}`,
    `  Label sources:       tapped ${m.tapped}, inferred ${m.inferred} (inferred wanted/not_wanted excluded from precision: ${m.inferredDecided})`,
    `  Precision@surface:   ${pct(m.precision)}  (Wilson 95% lower ${pct(m.wilsonLower)}, pessimistic ${pct(m.pessimisticPrecision)})`,
    `  Coverage:            ${pct(m.coverage)}`,
    `  Focus regret:        ${m.focusRegret}  (target 0)`,
    `  Baseline gap:        ${baselineStr}`,
    `  Verdict:             ${m.verdict}  (threshold ${pct(m.threshold)}, min labels ${m.minLabels})`,
    `  Circuit breaker:     ${m.breakerTripped ? "TRIPPED" : "ok"}`,
  ].join("\n");
}
