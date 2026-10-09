# Shadow Proposal Recording — Design (sub-project 2 of 4)

Date: 2026-10-09. Status: approved by user ("Start 2", autonomous mode).

## Purpose
`WorldModelHost.ingestObservation` already builds policies, proposals and gate decisions
in memory, but nothing persists them, so the metrics evaluator (#1) has no rows. This
sub-project writes each would-be proposal and its gate decision to SQLite in shadow mode.

## Scope
In: `ShadowRecorder` (daemon), optional injection into `WorldModelHost`, lazy wiring in the
observation route, tests.
Out: label capture (#3), label inference (#4), silencing Glass delivery (no code path pushes
proposals to Glass today; the HTTP response is the only consumer), seeding the `invariants`
table (proposals use `invariant_id = NULL` for now).

## Invariants
- Recording never breaks observation ingest: host wraps `record()` in try/catch and logs.
- No edits to `packages/core/src/db.ts` (another agent has uncommitted work there).
- Writes are atomic: event append + proposal + gate decision in one transaction.
- Idempotent: an existing `proposal_id` is skipped (policy ids embed `Date.now()`).
- Semantic dedupe: a repeat of the same `invariantId + policy type + action` within a 1 h cooldown
  is skipped, so one ongoing anomaly cannot inflate the metric denominators. The cooldown map is
  in-memory (a restart resets it).
- Non-finite `estimatedRisk`, `expectedFreeEnergyScore`, `confidence` or `evaluatedAt` throw before any write.
- Failure latching: the host disables recording after 5 consecutive `record()` failures; a failed
  DB open disables it for the process. Env (`SHADOW`, `EXOCORTEX_SHADOW_RECORD`) is read once at attach.
- Clocks: row `expires_at`/`updated_at` use the recorder clock; event `ts_device` and gate `ts`
  use the gate's `evaluatedAt`.
- Opt out with `EXOCORTEX_SHADOW_RECORD=0`. `SHADOW=0` records `shadow=0`; default is `shadow=1`.

## Mapping (runtime gate → schema)
| Runtime `GateAction` | `gate_decisions.decision` | `proposals.state` |
|---|---|---|
| ALLOW_PROMPT | SURFACE | SURFACED |
| SUPPRESS_AND_QUEUE | QUEUE | STAGED |
| DROP | SUPPRESS | SUPPRESSED |
| SILENT_AUTO_EXECUTE | AUTO_DRY_RUN | GATED |

- `gate_decisions.mode` = runtime mode string (e.g. `DEEP_FOCUS`), `ts` = `evaluatedAt`.
- `tier` from `estimatedRisk`: ≤0.05→0, ≤0.15→1, ≤0.5→2, ≤0.85→3, else 4.
- `efe` = `expectedFreeEnergyScore`, `risk_term` = `estimatedRisk`, `ambiguity_term` = 1 − confidence.
- `action` = canonical JSON of the action payload; `action_hash` = SHA-256 of it.
- `expires_at` = now + 24 h (labels arrive later than the live 5 min dry-run TTL).
- `created_seq` = seq of a `proposal` event appended to the hash-chained log
  (`event_id = proposal:<id>`) by a registered host device `host:exocortexd`.

## Known gaps
- `proposals.invariant_id` is NULL until the `invariants` table is seeded (the event payload carries it).
- Synchronous SQLite on the request path (one transaction per proposal); batch or queue if latency matters.
- The host device uses a one-byte placeholder key, so any signature check against it fails closed.
- `/world-model/*` routes sit behind the gateway auth check; the observation route is not newly exposed.

## Files
- `apps/daemon/src/shadow-recorder.ts`, `shadow-recorder.test.ts` (node:test).
- `apps/daemon/src/world-model-host.ts`: `setShadowRecorder`, call in `ingestObservation`.
- `apps/daemon/src/server.ts`: lazy `ensureShadowRecorder()` in the observation route.
- `apps/daemon/package.json`: add the test file to the `test` script.
