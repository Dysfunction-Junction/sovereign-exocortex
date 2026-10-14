# Pieces backfill: design (step 1 of 4)

Status: importer built (`apps/daemon/src/pieces-backfill.ts`). **Decision D1 changed by the owner:** events go into the live log, flagged as past via their own event kind `past` (plus `payload.past = true`) instead of a separate `backfill.db`. The predictors and world-model replay read only live kinds, so they ignore past events by default. Trade-off accepted: `ts_server` is the import time, so anything windowed by `ts_server` must filter on kind, and the rows cannot be deleted later.

Plan: (1) backfill events, (2) seed the life graph, (3) backtest, (4) learn model tables.
This document covers step 1 and the constraints it puts on steps 2 to 4.

## 1. Goal and non-goals

Replay about two months of Pieces history (2026-08-10 to 2026-10-09, 7,661 timeline records) through the existing event-log path, so the life graph, generative model and prediction code have something to learn from and be scored against.

Not goals: training a neural model, inferring cognitive mode (Pieces has no mode labels), touching the phone-signal pipeline, any cloud store. Source is the export on disk, not Aura.

## 2. Decisions needed

### D1. Where do backfilled events live? Recommend: a separate `backfill.db`

The live `events` table is append-only and hash-chained, and every row needs an enrolled `device_id`. `ts_server` is stamped at ingest, so backfilled rows would all look like "now" to anything ordered or windowed by `ts_server`, including shadow metrics. They would also sit in the chain you rely on as the source of truth.

Use a second SQLite file with the same schema (same `ExocortexDatabase` class, own hash chain). Replay, graph seeding and the backtest read from it. The live log stays pristine. Merging learned priors into the live DB is a later, explicit decision.

Alternative (not recommended): a synthetic enrolled device `pieces-backfill` writing to the live log with `ts_device` = original time. Simpler, but pollutes ts_server-based metrics and can never be undone (triggers forbid delete).

### D2. Event granularity. Recommend: one event per summary plus one per tag/person link

A summary is the natural unit: a named stretch of work with a time range, tags, persons and sources. Annotations (5,243) are fine-grained AI notes; skip them in v1 and use them only for memory text (step 2).

### D3. What time is "when it happened"? Recommend: range window, fall back to created

The export's chronology uses record creation time, not activity time (`index.md` says so). Summaries link to `ranges`, and a range has real `from`/`to` timestamps. Use `ranges.from` as `ts_device` when present, else summary `created`. Store both in the payload.

## 3. Mapping

Join rule: in each summary JSON, `ranges`, `tags`, `persons`, `sources`, `annotations` are `{ indices: { <id>: n } }` maps of record ids. Resolve ids to `data/<kind>/` files by their inner `id` field, not by filename (filename is the sha256, the id is a UUID). Build an id to file index once.

| Pieces record | Event | `kind` | Payload |
|---|---|---|---|
| summary | one per summary | `observation` | `{ source: "pieces-backfill", synthetic: true, type: "work_session", name, summary_id, ts_range: [from, to|null], created, tags: [tag text], persons: [name], sources: [name], model: model.name }` |
| website | one per website with a timestamp | `observation` | `{ source: "pieces-backfill", synthetic: true, type: "web_visit", url, title, created }` (optional in v1) |

Required fields for every row: `event_id` = `pieces:<record id>` (deterministic, so re-running is idempotent and the existing `EventIdConflictError` becomes a skip), `schema_ver` = 1.

Safety flags in every payload: `synthetic: true` and `source: "pieces-backfill"`. Any metric code that reads the live DB must never see them; any code that reads `backfill.db` can rely on them.

Sensitive data: summaries can contain private details. `backfill.db` is a local file next to the live DB and must not be synced, uploaded or sent to a model off-box.

## 4. Components

1. `apps/backfill` (or `apps/cli` subcommand `exo backfill pieces <exportDir>`): reads the export, builds the id index, emits events through `ExocortexDatabase.insertEvent` on `backfill.db`. Prints counts per type and skipped records.
2. Idempotent: running twice inserts nothing new.
3. Verification command: `exo backfill verify` re-reads `backfill.db`, checks the hash chain, and compares counts to the export (expect 123 summaries; websites optional).

## 5. How this constrains steps 2 to 4

- Step 2 (life graph): rebuild the graph by replaying `backfill.db`; entities come from tags, persons and sources inside payloads; edge weights from co-occurrence within a summary; activation decay from `ts_device`.
- Step 3 (backtest): time split. Train on events before a cut date, predict the held-out later events. Never shuffle. Report precision against what actually followed. Metrics code is pointed at `backfill.db` only.
- Step 4 (model tables): learn A/B/C/D only inside the backtest DB at first. The cognitive-mode factor is left at its prior because Pieces carries no mode signal.

## 6. Risks

| Risk | Mitigation |
|---|---|
| Domain mismatch: Pieces is desktop work, the live system watches phone and PC signals | Backtest reports per event type; treat the number as a ceiling, not a forecast |
| Summaries are AI-written and noisy | Use tags/persons/time (structured) before free text |
| Only about 2 months of history | Report confidence intervals; do not tune hard on 123 sessions |
| Time fields wrong (created vs activity) | D3 fallback order; count how many summaries had a real range |
| Private data in a new file | Local only, gitignored, excluded from sync |

## 7. Work estimate (for whoever builds it)

About 150 lines for the importer plus tests against a small fixture export. Half a day including the verify command. Backtest and model learning are separate designs.

## 8. Questions to settle before building

1. Approve D1, D2, D3, or change them.
2. Where should `backfill.db` live (next to the live DB, or under the databank)?
3. Include website visits in v1, or summaries only?
