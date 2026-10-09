# Shadow Metrics Evaluator — Design (sub-project 1 of 4)

Date: 2026-10-09. Status: approved by user ("execute", autonomous mode).

## Purpose
Turn the `gate_decisions` + `shadow_labels` tables into a measured Precision@surface
(plus coverage, focus regret, optional baseline gap) so the system can be priced and
gated against a real number instead of the 0.90 design target.

## Scope
In: pure metrics function, read-only SQL loader, CLI report.
Out (later sub-projects): daemon writing shadow proposals (#2), tap-to-label endpoint
+ mobile action (#3), `already_did`/`ignored` inference job (#4).
Deferred metrics: Recall, Brier, Δt quantiles (need event/confidence data not in these tables).

## Invariants
- Read-only: never writes; opens the DB with `readOnly: true`.
- Does not edit `db.ts` (another agent has uncommitted work there). New file only.
- Time is explicit (`nowMs` param) so results are deterministic.

## Definitions (window = last `windowDays`, default 14, by gate decision `ts` in ms; bounds `(now-window, now]`)
- Row = shadow proposal (`shadow=1`) whose latest gate decision (ties: highest rowid) is `SURFACE`.
- Precision@surface = wanted / (wanted + not_wanted), **tap-source labels only**. Inferred
  wanted/not_wanted are counted in `inferredDecided` and never feed precision or `minLabels`.
  `null` when the denominator is 0.
- Wilson 95% lower bound (clamped to [0,1]) reported alongside; the verdict still gates on the
  point estimate per the architecture doc (decision recorded: n≈20 cannot resolve 0.90, so
  `minLabels` defaults to 50).
- Pessimistic precision = wanted / (wanted + not_wanted + ignored) (treats ignored as a miss).
- `already_did` is reported but excluded from both denominators.
- Coverage = (wanted + not_wanted) / surfaced.
- Label source = `actual.source` if present, else tap for wanted/not_wanted, inferred otherwise.
- Focus regret = surfaced rows whose gate `mode` is `DEEP_FOCUS` (target 0).
- Baseline gap = precision − `baselinePrecision` when supplied.
- Verdict order: `insufficient_data` (tapped wanted+not_wanted < `minLabels`, default 50) →
  `fail` (precision < `threshold`, default 0.90; integer-safe compare) → `heuristic_scorer`
  (baseline supplied and gap ≤ 0) → `pass`. `breakerTripped` = verdict `fail`.
  A failing system is never downgraded to `heuristic_scorer`.
- Unknown label values in `shadow_labels` make the loader throw.

## CLI exit codes
0 pass, 1 breaker tripped, 2 usage error, 3 insufficient data, 4 heuristic scorer, 70 runtime error.

## Known follow-ups (not in this sub-project)
- Right-censoring: recently surfaced rows are unlabeled only because the user has not replied
  (add a `maturityMs` option when #3 defines proposal TTL handling).
- Index on `gate_decisions(proposal_id, ts)` once the table is large (schema change; not here).
- Warn if `gate_ts` looks like seconds (< 1e12).

## Files
- `packages/core/src/shadow-metrics.ts` — types, `computeShadowMetrics`, `loadShadowRows`, `formatShadowReport`.
- `packages/core/src/shadow-metrics.test.ts` — vitest.
- `packages/core/src/shadow-report-cli.ts` — `tsx` entry: `<db-path> [--days N] [--baseline P]`.
