# World-Model Store Plan: Retire Neo4j, Rebuild the Graph from the Ledger

**Status:** Direction approved by the user on 2026-10-31 (decisions in §1). The gate thresholds in §9 are frozen. Only a dated planner amendment can change them.
**Progress (2026-10-31, updated 23:15 CDT):**
- **Phase 0 (`P0-G1`..`P0-G5`):** DONE — cold backups & isolated Neo4j inventory completed (`docs/evidence/world-model-store/P0-G1.json`..`P0-G5.json`); P0-4 merged to `main` as `bc9b139` ([PR #77](https://github.com/Dysfunction-Junction/sovereign-exocortex/pull/77)); P0-5 doc/spec corrections merged as `3171837` ([PR #78](https://github.com/Dysfunction-Junction/sovereign-exocortex/pull/78)).
- **Phase 1 (`P1-G1`..`P1-G5`):** DONE & MERGED — provenance registry, append-only `artifacts` table, curation artifact builders, and unified `projectEventToGraph` projector merged to `main` as `738314c` ([PR #79](https://github.com/Dysfunction-Junction/sovereign-exocortex/pull/79)).
- **Phase 2 (`P2-G1`..`P2-G5`):** DONE & MERGED — `GraphStore` port, `InMemoryGraphStore`, and `VocabularyIndex` merged to `main` ([PR #81](https://github.com/Dysfunction-Junction/sovereign-exocortex/pull/81)); all 5 gates passed with 3 `llama-server` processes running (`317 ms` 1x / `3,325 ms` 10x boot replay, `<= 13.33 ms` p95 port latency, `+50.43 MB` RSS delta at 10x, 1:1 curated parity, identical `taskkill /F` dump SHA-256). No §5.3 escalation required.
- **Phase 3.2 (Living Brain mobile cutover):** DONE & MERGED — `LivingBrain.tsx` and `api.ts` cut over to `/v3/world-model/graph/*` (404-only fallback to `/neo4j/*`), Cypher box removed, and user-facing `Neo4j` labels renamed to `Graph` as `28047bd` ([PR #80](https://github.com/Dysfunction-Junction/sovereign-exocortex/pull/80)).
- **Phase 3.1 & 3.3 (Daemon route cutover, Neo4j sync removal & `curation-import` CLI):** DONE & MERGED — revert tag `pre-world-model-store-cutover` pushed at `28047bd`; merged to `main` as `4d8938f` ([PR #82](https://github.com/Dysfunction-Junction/sovereign-exocortex/pull/82)); `P3-G2` passed.
- **Phase 5 (`P5-G1`):** DONE — read-only Aura probe confirmed instance retired (`ENOTFOUND`), cold canonical `pieces-graph` artifact exported (5.83 MB, 7,662 nodes, 7,534 relationships), network egress completely removed from `GraphClient`, `memory.search` verified with `globalThis.fetch` throwing unconditionally (`docs/evidence/world-model-store/P5-G1.json`).
- **Remaining:** Live daemon cutover and `curation-import --apply` on `%LOCALAPPDATA%\exocortex.db`, `SM-S948U1` smoke test (`P3-G1`), user-confirmed credential removal (`packages/memory/.env`), 3-day soak (`P3-G3`), rollback drill (`P3-G4`), and 30-day local Neo4j retirement (`P4-G1`).
**Supersedes:**
- `cortex_serverless_embedded_graph_plan.md` (Antigravity brain, 2026-10-31).
- The `graph_store_transition` (GS-1) entry in `docs/SOVEREIGN_EXOCORTEX_SPEC.json`.

**Target:** `packages/core`, `packages/world-model`, `packages/memory`, `apps/daemon`, `apps/mobile/src` (Living Brain screen)
**Branches:**
- The Phase 0 fix goes on a worktree off `origin/main`.
- Phases 1–3 go on a second worktree off `origin/main`, after the Phase 0 fix merges.
- Never use the `spike/gemma-litertlm` checkout, which carries uncommitted Android work.

**Author:** planner (Claude)
**Implementer:** Codex or Antigravity

---

## 0. Stop rules

| # | Rule | Reason |
|---|---|---|
| S1 | Keep the original Neo4j stopped until the Phase 0 fix (P0-4) merges. Do not run `pnpm neo4j-sync` and do not press Sync in the Living Brain screen. | `syncGraph` deletes every entity with `type = 'TOPIC'`, which includes the curated vocabulary. Three triggers run it: daemon start, `POST /v3/world-model/neo4j/sync`, and `neo4j-sync-cli.ts`. |
| S2 | Never start Neo4j on `apps/neo4j-import/.neo4j/data`. Inspect copies only. | Startup runs recovery on the store it opens. |
| S3 | No `git clean -fdx` in this repo until P0-2 is done. | The Neo4j data directory is gitignored inside the tree. |
| S4 | Deleting Neo4j data, the Aura instance, or any credential needs the user's confirmation at that step. | These deletions cannot be undone. |
| S5 | Implementers never change a threshold, an assertion, or fixture data to pass a gate. A failed gate goes back to the planner. | The roadmap has the same guardrail. |
| S6 | No wall-clock reads (`Date.now()`, or `new Date()` without an argument) in the projection path. Time comes from the event. | Replay must not depend on when it runs. |
| S7 | Never write synthetic or test events to `%LOCALAPPDATA%\exocortex.db`. Use scratch databases. | The ledger is append-only and permanent. |

## 1. Decisions (user, 2026-10-31)

| Question | Decision |
|---|---|
| World-model storage | In memory, rebuilt from the full ledger at boot. A persisted SQLite cache in a separate file is added only if gate P2-G1 or P2-G3 fails. LadybugDB is evaluated only if a named port operation then still misses P2-G2. |
| Neo4j Aura used by memory search | Export it once to local storage, then delete the credentials. |
| Raw Cypher box in the Living Brain screen | Remove it. Natural-language queries map to named port operations. |

## 2. Audit findings (measured 2026-10-31, 11:40–12:30 CDT, read-only)

### 2.1 Ledger (`%LOCALAPPDATA%\exocortex.db`)

- `events` has 17,461 rows:
  - `seq` runs from 1 to 17,461.
  - `ts_server` runs from 2026-10-10 01:03 UTC to 2026-10-31 16:51 UTC.
  - `schema_ver` is 1 on every row.
  - The file is 15.3 MB, with a 9.3 MB WAL.
- The hash is computed by `computeCanonicalEventHash` (`packages/core/db.ts:191`).
  - It is SHA-256 over `prev_hash`, followed by `canonicalJsonStringify({ event_id, device_id, kind, ts_device, ts_server, schema_ver, payload })`.
  - No `seq` and no `stream` go into the hash.
  - The chain is checked by `ExocortexDatabase.verifyEventChain()` (`db.ts:653`).
- The table is append-only: `BEFORE UPDATE` and `BEFORE DELETE` triggers abort. A new column on `events` could never be backfilled.
- Projections already in the file:
  - `model_params(factor, kind, version, counts, as_of_seq)`: 100 rows
  - `belief_snapshots(as_of_seq, mode, q, surprisal)`: 30 rows
  - `predictions`: 1,043 rows
  - `prediction_outcomes`: 1,039 rows
  - `triage_results`: 2,956 rows
  - `telemetry_tally`: 1,129 rows
- `consumer_cursors` holds `world-model`, `precognitive`, `prediction`, `triage`, and `shadow-labels`, all at 17,461.

### 2.2 Event kinds and provenance

| Kind | Rows | Source in payload or device | Class (§4.1) |
|---|---|---|---|
| `past` | 9,249 | `origin=comms-backfill`: 9,126, holding person ids, direction, and duration, with no message text. `origin=pieces-backfill`: 123. | observed, imported |
| `telemetry` | 7,269 | phone devices | observed |
| `channel_ingest` | 419 | `channel=obsidian`, flagged `untrusted` | observed, untrusted |
| `touch` | 406 | phone, dashboard | observed |
| `proposal` | 36 | `host:exocortexd` | system_emitted |
| `label` | 35 | `source=inferred`: 24. `source=tap`: 11. | inferred: system_emitted. tap: user_label. |
| `observation` | 30 | `health_observation`, `repo_health_watcher` | observed |
| `query` | 15 | phone. The payload holds `query` and `result`. | observed, for `query` only |
| `vision_observation` | 2 | `source=local_vision` | derived |

- The Dirichlet learner reads only `observation` and `telemetry` (`eventToObservation`, `packages/world-model/generative-model.ts:163`).
- The shadow-labels consumer already treats `source === "inferred"` separately (`apps/daemon/src/server.ts`).
- The graph linker runs on every kind except `channel.*`. Proposals do not match its extraction patterns today, but nothing prevents a later change from linking them.

### 2.3 Daemon graph (`LivingLifeGraph`)

- **Restart replays only the oldest 1,000 events.**
  - `WorldModelHost.hydrateFromDatabase` replays `db.listEvents({ limit: 1000 })`.
  - `listEvents` orders by `seq ASC`, so a restart replays events 1 through 1,000 (2026-10-10 01:03 to 2026-10-12 04:28 UTC), with `createMissingTopics: false`.
  - Live ingest (`onEventsAppended`) uses `createMissingTopics: autoCreate` instead.
  - After a restart, the ingest consumer resumes at the cursor (17,461). Events from 1,001 onward never re-enter the graph.
- `seedFromPastEvents` and `seedCommsFromPastEvents` run once per process at server start. A restarted graph and a long-running graph therefore apply them at different points.
- **Graph time comes from the wall clock.**
  - `LivingLifeGraph.addEdge` sets `lastObserved: Date.now()` on every call.
  - `addEntity`, `stimulate`, and `decay` default to `Date.now()`.
  - `linkEventToGraph` falls back to `Date.now()` when an event has no timestamp.
- **The replay test misses the restart path.** `replay.integration.test.ts` replays a handful of events through `onEventsAppended` and compares ids, types, names, and edge triples. It never exercises `hydrateFromDatabase`.
- **Keys are already deterministic strings:** `topic_<slug>`, `person_<slug>`, `doc_<summary_id>`, `location_<slug>`, and edge ids of the form `<source>:<RELATION>:<target>`. No hashing scheme is needed. Merges need an alias table.
- **Existing graph routes:** `GET /v3/world-model/graph`, `/graph/context`, `/graph/full`, and `/graph/live`.

### 2.4 Local Neo4j

> **Correction (P0-3, 2026-10-31).** Measured on a copy; see `docs/evidence/world-model-store/P0-G3.json`.
> - The repo install is Neo4j 2026.05.0 Enterprise (auth disabled), not 5 Community.
> - A second instance, Neo4j Desktop 2 (`%USERPROFILE%\.Neo4jDesktop2\Data\dbmss\`), also received daemon syncs. Its `query.log` shows the `TOPIC` delete first ran at 2026-10-27 19:32:31 UTC and repeatedly after, so its vocabulary is gone.
> - The repo `.neo4j` copy below never ran the delete and is the surviving curated store. It is backed up under P0-2.
> - Vocabulary topics: 8,157 (equal to `vocab-clean.json`), not 8,168. `HAS_TOPIC`: 1,743 path-rule, 43 entity-rule, 867 colon-merge, 254 oakridge index, 2,990 unsourced. File and Folder: 1,003. `CONTAINS`: 1,002. Nothing was missing.

The rest of §2.4 is the original pre-P0-3 audit text; where it conflicts with the correction above, the correction wins.

- **Install.** Neo4j 5 Community (superseded: 2026.05.0 Enterprise), configured in `apps/neo4j-import/.neo4j/conf/neo4j.conf`:
  - Heap: 512 MB initial, 1,024 MB max.
  - Page cache: 1,024 MB.
  - Bolt on 127.0.0.1:7687, HTTP on 127.0.0.1:7474.
  - Data lives in `apps/neo4j-import/.neo4j/data`, gitignored by `apps/neo4j-import/.gitignore`.
  - The JVM is Android Studio JBR 21, per the 2026-10-25 memory note.
- **State:** not running; nothing listens on 7474 or 7687. `neo4j.log` shows a start at 2026-10-27 14:05 UTC. A later start at 2026-10-28 21:07 UTC was stopped by request at 21:08.
- **Daemon writer** (`apps/daemon/src/neo4j-sync.ts`):
  - `attachToHost`, called at `server.ts:182`, runs `syncGraph` at every daemon start when Neo4j answers.
  - `POST /v3/world-model/neo4j/sync` runs `syncGraph`.
  - `neo4j-sync-cli.ts` (`pnpm neo4j-sync`) replays events and runs `syncGraph`.
  - `syncPulse` MERGEs live graph updates after a 1.5 s debounce.
- **Hand-run writers** in `C:\Users\micha\tag-cleanup`: `neo4j_topics.mjs`, `tag_paths.mjs`, `link_entities.mjs`, `import_repo_files.mjs`, `consolidate_colon_topics.mjs`.
- **The delete.** `syncGraph` starts with `MATCH (n:Entity) WHERE n.type = 'TOPIC' OR n.id = 'person_michael_hebert' DETACH DELETE n`, added in commit `291d9df` (2026-10-27 13:18 −05:00).
  - `neo4j_topics.mjs` and `tag_paths.mjs` create topics with `type = 'TOPIC'`, so the statement deletes the vocabulary and every `HAS_TOPIC` link attached to it.
  - `query.log` records every query. It ends at 2026-10-27 18:30:58 UTC and contains no execution of that statement.
- **Curated contents,** per the 2026-10-25 memory note and not re-counted since:
  - 8,168 vocabulary topics
  - `HAS_TOPIC` links: 1,743 `path-rule-2026-10-24`, 44 `entity-rule-2026-10-25`, and 2,404 Pieces baseline
  - 650 File and Folder nodes
  - 649 `CONTAINS` edges
- **Backups.** The newest is `tag-cleanup/neo4j-backups/topics-colon-merge-2026-10-26T00-24-20-194Z.json`. `link_entities.mjs` was modified at 2026-10-26 00:25 local, after that backup.
- **Consumers.** `apps/mobile/src/pages/LivingBrain.tsx` uses these through `api.ts`: `getNeo4jStatus`, sync, analytics, and `queryNeo4jLivingGraph` in `nl` and `cypher` modes.
  - `getGraphAnalytics` returns counts, the 10 highest-degree hubs, 10 stale entities by `lastActive`, and type and relation histograms, cached for 30 s.

### 2.5 Neo4j Aura (memory search)

- `packages/memory/.env` sets `NEO4J_URI` to a Neo4j Aura instance (`neo4j+s://…databases.neo4j.io`).
  - `GraphClient` (`packages/memory/graph-client.ts`) uses it to search a `PiecesRecord` graph.
- The client is dormant:
  - `GraphClient.fromEnv` needs `NEO4J_URI` and `NEO4J_USERNAME`, but the daemon's `.env` defines `NEO4J_URL` and `NEO4J_USER`.
  - Neither variable is set at user or machine level.
  - No MCP config launches the memory server.
- No `.env` file is tracked, now or in history.

### 2.6 Host and dependencies

- **Memory at 11:50 CDT:**
  - Commit charge: 34.7 of 36.7 GB in use. Free RAM: 1.6 of 15.7 GB.
  - Private bytes: llama-server at 5,252 MB, 1,107 MB, and 144 MB; the Gradle daemon at 2,675 MB; the Kotlin build daemon at 808 MB. Both Java daemons run on Android Studio JBR.
  - Neo4j was not running.
- **Toolchain:** Node 24.16.0 and pnpm 11.7.0. `pnpm-workspace.yaml` sets `allowBuilds: { esbuild: true }`.
- **`@ladybugdb/core` 0.22.1** (published 2026-10-28):
  - Optional dependency `@ladybugdb/core-win32-x64` 0.22.1.
  - An `install` script (`node install.js`), which pnpm skips unless it is allowed.
  - Dependencies: `cmake-js`, `apache-arrow`, and `node-addon-api`.
  - One maintainer.
- `kuzu` 0.11.3 is deprecated.
- **Phone over adb:** `ro.product.model = SM-S948U1`, `ro.soc.model = SM8850`.

### 2.7 Document errors

| Claim | Where | Measured |
|---|---|---|
| 1,928,413 events | Antigravity summary | 17,461 |
| `hash = sha256(prev_hash + seq + ts + stream + kind + payload)` | `SOVEREIGN_EXOCORTEX_SPEC.json`, memory `project_sovereign_exocortex_v3.md` | See §2.1. |
| `model_params` and `belief_snapshots` DDL | `SOVEREIGN_EXOCORTEX_SPEC.json` | The live columns match `ARCHITECTURE_V3.md` (§2.1). |
| Dirichlet count tables are L0 | Antigravity plan and summary | They are projections stamped with `as_of_seq`. |
| Galaxy S24 Ultra, Snapdragon 8 Gen 3 | Roadmap §0 and M1, `SPEC_GEMMA_LITERTLM_SPIKE_2026-10-31.md`, JSON spec | `SM-S948U1` (Galaxy S26 Ultra), SoC `SM8850`. Snapdragon 8 Gen 3 is SM8650. |
| Active branch `feat/forecast-cards` | JSON spec | `spike/gemma-litertlm` |
| `pnpm@9+`, `node@22+` | JSON spec | pnpm 11.7.0, Node 24.16.0 |
| Retiring Neo4j reclaims about 2 GB | Antigravity summary | Neo4j is not running. The 2.6 GB Java process is Gradle. |
| 8,168 topics in the live graph | JSON spec | That figure comes from the 2026-10-25 note and has not been counted since. |
| Air-gapped | Antigravity summary | Memory search is configured for Neo4j Aura (§2.5). |
| M4 builds on Neo4j with integer `topic_ids` | Roadmap M4, DoD items 4 and 8 | Topics only have string ids, and Neo4j is being retired. |

P0-5 corrected every row in the repo docs. The JSON spec's schema sections are now generated by `scripts/dump-sqlite-schema.mts`. Rows sourced only from the Antigravity summary or brain files stay uncorrected there; this plan supersedes them.

## 3. Phase 0: Protect what cannot be rebuilt

**P0-1. Ledger snapshot.**
1. Run `VACUUM INTO` from a read connection to `%LOCALAPPDATA%\exocortex\backups\exocortex-<date>.db`. Never copy the `.db` and `-wal` files by hand.
2. Open the copy and run `verifyEventChain()`.
3. Record the SHA-256, the event count, and the max `seq`.
4. Put a second copy on a different physical disk.

Gate: P0-G1.

**P0-2. Cold copies.** With Neo4j stopped, copy all of `apps/neo4j-import/.neo4j` and all of `C:\Users\micha\tag-cleanup` to `%LOCALAPPDATA%\exocortex\backups\neo4j-<date>\`. Write a SHA-256 manifest of every file. Gate: P0-G2.

**P0-3. Inventory from a second copy.**
1. Stop the Gradle daemons with `gradlew --stop` in `apps/mobile/android`. They hold about 3.4 GB, and commit headroom was 2.0 GB.
2. Make a second copy of the data directory, plus a conf that points at it:
   - Heap 512 MB and page cache 256 MB.
   - Bolt on 127.0.0.1:17687 and HTTP on 127.0.0.1:17474. Neither the daemon nor the phone knows these ports.
3. Export every node (labels and properties) and every relationship (type, endpoints, and properties) to JSON. Count:
   - nodes by label
   - relationships by type
   - `HAS_TOPIC` links by `source`
   - `Topic` nodes with `vocab = true`
4. Compare against §2.4. If anything is short, rebuild the missing layer on this copy from `vocab-clean.json`, the `neo4j-backups` JSON, and the rule scripts. Then re-export and record what was rebuilt.
5. Stop the copy.

Gate: P0-G3.

**P0-4. Fix PR**, on a worktree off `origin/main`:
- Remove the `TOPIC` delete from `syncGraph`. If the category migration it served is still needed, move it to an admin command that prints a dry-run count and skips nodes with `vocab = true` or a `source` property.
- Hydrate from all events. Page through `listEvents({ sinceSeq, limit })` to the end, using the same linker options as `onEventsAppended`. Set the in-memory processed `seq` to the last replayed event, so the ingest consumer does not apply it twice.
- Add an event-time argument to `LivingLifeGraph.addEdge`, and pass event time to `addEntity` and `stimulate`.
  - Use `ts_device`, and fall back to `ts_server` only when `ts_device` is absent.
  - The backfills already store the original time in `ts_device`.
- Replay a copy of the live ledger in full. Record the entity and edge counts, and the response size of `GET /v3/world-model/graph/full`, so the load on the 3D view is known.

Gates: P0-G4 and P0-G5.

**P0-5. Document corrections.**
- Fix every row in §2.7. Leave the Antigravity brain files alone; mark that plan as superseded.
- Replace the schema section of `SOVEREIGN_EXOCORTEX_SPEC.json` with output generated by a script from `sqlite_master`, so it cannot drift again.
- Retarget M4 as described in §6.4.

## 4. Phase 1: Make the ledger self-sufficient

### 4.1 Provenance registry

- **Shape.** A pure, versioned function in `packages/core`: `provenanceOf(event, attestation) -> { class, untrusted, projectableFields }`.
  - It is keyed on `kind`, `payload.source` or `payload.origin`, and `device_id`.
  - It also takes the label attestation result that `labelSource` already computes.
- **Classes:** `observed`, `user_label`, `derived`, `system_emitted`, and `unclassified`. The initial mapping is the table in §2.2.
- **No new column on `events`.** The inputs are already in the hashed row, and the triggers in §2.1 would block a backfill.
- **Inheritance.** A `derived` event takes the worst class among its `input_event_ids`. The `untrusted` flag is inherited the same way.
- **Projectable fields.** `projectableFields` lists, per kind, the payload fields a projection may read. `query.result` is not on the list.
- **Unclassified events** project nowhere. Each one increments a counter shown in the daemon status.
- **Consumer allowlist.** Each consumer (world-model graph, learner, precognitive, prediction, triage, shadow-labels) declares the classes it reads. The learner's current rule (`observation` and `telemetry` only) is re-expressed through the registry, with no change in behavior.

### 4.2 Artifacts

- **New table** in `exocortex.db`: `artifacts(sha256 BLOB PRIMARY KEY, media_type TEXT NOT NULL, bytes BLOB NOT NULL) STRICT`. It gets the same insert-only triggers as `events`.
- **Encoding.** The bytes are canonical JSON: sorted keys, UTF-8, LF line endings. The SHA-256 is computed over those bytes.
- **Vocabulary artifact:**
  - Holds every topic from the P0-3 export, with `id` (`topic_<slug>`), `name`, `aliases`, `generic`, and `topic_num`.
  - `topic_num` is assigned once, in sorted slug order.
  - Later versions append new topics at max + 1 and never reuse a number.
- **Rule-links artifact:** the `entity-rule` and `path-rule` `HAS_TOPIC` links, each with its rule source. Its class is `derived`.
- **File-tree artifact:** the 650 File and Folder nodes and the 649 `CONTAINS` edges. It is stored but not loaded (§12).
- **Ledger entry.** Each artifact enters the ledger through one `curation_import` event: `{ artifact_sha256, media_type, count, rule_source? }`. The vocabulary import is `user_label`; rule links are `derived`.
- **Boot check.** Every `artifact_sha256` referenced by a `curation_import` event must exist and hash correctly. Otherwise the world model refuses to serve, and the status endpoint names the missing or altered hash.

### 4.3 New event kinds

Each is registered in the same change that introduces it.

| Kind | Class | Payload |
|---|---|---|
| `curation_import` | `user_label` for the vocabulary, `derived` for rule links | as in §4.2 |
| `derived_assertion` | `derived`, inherited from its inputs | `model_id`, `model_sha256`, `prompt_sha256`, `input_event_ids`, `assertion { subj, pred, obj, confidence }` |
| `entity_merge` | `user_label`, attested | `from_id`, `into_id` |
| `assertion_retract` | `user_label`, attested | `edge_id` or `entity_id`, plus `reason` |

Replay applies these kinds from the ledger and never calls a model.

### 4.4 One projection function

- A single function applies one event to the graph. Live ingest and boot replay both call it.
- The startup seeding (`seedFromPastEvents` and `seedCommsFromPastEvents`) becomes that function's handler for `past` events.
- `seedEcosystemGraph` stays in code, and its contents count as part of the projector version.

Gates: P1-G1 through P1-G5.

**Limit.** Provenance stops the system from counting its own outputs as evidence. It does not stop forecast cards from changing behavior that is later observed. That needs exposure logging in the predictor (§12).

## 5. Phase 2: In-memory world-model store behind a port

### 5.1 Port (`GraphStore` in `packages/world-model`)

| Operation | Replaces |
|---|---|
| `status()` | `getStatus` and `checkHealth` |
| `analytics()` | `getGraphAnalytics`, with the same `GraphAnalyticsResult` shape |
| `search(q, k)` | the natural-language fallback branch |
| `byType(type, k)` | the natural-language `project`, `person`, `device`, and `topic` branches |
| `stale(k)` | the natural-language `stale`, `neglected`, and `idle` branch |
| `neighbors(id, hops <= 2, limit)` | expansion in the 3D view, and hydration for spreading activation |

There is no raw query passthrough.

### 5.2 Default adapter

- `LivingLifeGraph` is rebuilt at boot from a full replay through the §4.4 function, plus the artifacts.
- The vocabulary loads as a lookup index, used by the linker and for `topic_num`.
  - A topic becomes a graph node only when an event references it, which keeps 8,000 vocabulary entries out of spreading activation.
  - Topics with `generic = true` are excluded from spreading activation.
- Entity-rule links load as edges.
- Decay is computed at read time from the stored weight and the last event time. Decayed values are never written back.

### 5.3 Escalation (only after a gate failure)

1. **If P2-G1 or P2-G3 fails,** add a persisted cache in a separate SQLite file next to the ledger.
   - It has its own connection.
   - It stores its cursor and the ledger hash at that cursor. A mismatch at boot forces a rebuild.
   - Rebuilds write to a new file, which is then renamed into place.
2. **If a named operation still fails P2-G2,** evaluate LadybugDB as a second adapter. Its gates:
   - Review `install.js` before adding the package to `allowBuilds`.
   - Measure P2-G3 with llama-server running.
   - Its dump must equal the SQLite cache's dump.
   - It runs in a worker thread or a child process.
   - Its version is pinned exactly.

## 6. Phase 3: Cutover

### 6.1 Daemon routes

- **New routes,** backed by the port:
  - `GET /v3/world-model/graph/status`
  - `GET /v3/world-model/graph/analytics`
  - `POST /v3/world-model/graph/query`, natural language only

  These names do not collide with the routes in §2.3.
- **Aliases.** `/v3/world-model/neo4j/status`, `/analytics`, and `/query` stay, with identical response shapes, so the phone build already installed keeps working.
  - A request with `mode: "cypher"` returns 400 with a message.
  - `POST /v3/world-model/neo4j/sync` returns the status shape and reports that the graph is rebuilt at boot.
- **Scopes** stay as they are today (`admin:read`, `admin:write`).

### 6.2 Living Brain screen

- Remove the Cypher toggle and the `mode` parameter from `queryNeo4jLivingGraph`.
- Change every "Neo4j" label the user can see to "Graph".
- This ships with the next phone build. The aliases cover the gap until then.

### 6.3 Remove Neo4j sync

- Delete the `attachToHost` wiring and both pulse and full sync from the daemon, all in the same change.
- Rollback is the revert tag plus the P0-2 copy (P3-G4).

### 6.4 Roadmap M4 retarget

- The component "Neo4j topic indexing" becomes "world-model store topic edges".
- `(Event)-[:ABOUT]->(Topic)` becomes `ABOUT` edges in the world-model store, projected from the M4 event.
- `topic_ids` are `topic_num` values from the vocabulary artifact.
  - The payload adds `vocab_sha256`, and the daemon rejects ids from any other vocabulary version.
  - M4's on-device embedding table is keyed by `topic_num` and carries the same `vocab_sha256`.
- DoD item 4: replace "and Neo4j" with "the artifacts table and the world-model graph endpoints".
- DoD item 8 becomes "the world-model store contains zero free-text properties", tested over a port snapshot.

## 7. Phase 4: Retire local Neo4j

- After P3-G3 and P3-G4 pass, keep the P0-2 copies and the P0-3 export for 30 days.
- Deleting `apps/neo4j-import/.neo4j` waits for the user's confirmation.
- After that, remove:
  - `apps/neo4j-import`
  - `neo4j-sync.ts`, `neo4j-sync-cli.ts`, and `neo4j-sync.test.ts`
  - the Neo4j sections of `SETUP_GUIDE.md` and `USER_MANUAL.md`
- Retire the tag-cleanup writers. Future curation is an admin command that appends `curation_import` events.

Gate: P4-G1.

## 8. Phase 5: Aura export and credential removal

1. **Export.** Make a read-only export of every `PiecesRecord` node and relationship to a local JSON file, and record its SHA-256 and counts. If the instance no longer exists, record that and skip to step 3.
2. **Store it locally.** Put it in the artifacts table if the export is under 20 MB; otherwise put it in the databank. Memory search then reads it locally through the existing `GraphResult` contract (`available`, `hits`, `untrusted: true`).
3. **Remove the credentials, with the user's confirmation.**
   - Delete `NEO4J_URI`, `NEO4J_USERNAME`, and `NEO4J_PASSWORD` from `packages/memory/.env`.
   - Remove the network path from `GraphClient`.
   - Deleting the Aura instance itself is the user's call, made in the Aura console.
4. **Correct the "air-gapped" claim.**

Gate: P5-G1.

## 9. Gates (frozen)

| ID | Check | Pass condition |
|---|---|---|
| P0-G1 | Ledger snapshot | `verifyEventChain()` passes on the copy. Count and max `seq` match the live file at snapshot time. SHA-256 is recorded, and a second copy sits on another disk. |
| P0-G2 | Cold copies | The manifest covers every file. Nothing listened on 7474 or 7687 during the copy. |
| P0-G3 | Neo4j inventory | Counts by label, relationship type, and `HAS_TOPIC` source are recorded from a copy. Every difference from §2.4 is explained, and rebuilt layers are listed. |
| P0-G4 | Curated survival | A test shows a `vocab = true` topic and its `HAS_TOPIC` links survive `syncGraph`. |
| P0-G5 | Restart equals live | Run 1,500 non-`past` events through a scratch DB. The canonical dump after live ingest equals the dump after a restart, covering ids, types, names, edge triples, `observedCount`, and `lastObserved`. |
| P1-G1 | Registry coverage | Zero `unclassified` across every (kind, source, device) in a copy of the live ledger. |
| P1-G2 | Clock independence | Two full replays of the ledger copy, under fake clocks 30 days apart, give identical dump hashes. |
| P1-G3 | Restart equals live, all kinds | P0-G5 again, with `past`, `label`, `proposal`, and `query` events included. |
| P1-G4 | Consumer matrix | Append 10,000 synthetic `system_emitted` events (proposals, inferred labels, and poisoned `query.result` fields) to a scratch copy. The graph dump, `model_params`, `belief_snapshots`, `predictions`, and triage output are unchanged. |
| P1-G5 | Artifact integrity | A missing or altered artifact makes the world model refuse to serve, and the status names the hash. |
| P2-G1 | Boot replay time | At most 2 s at 1× (the ledger copy plus artifacts), and at most 15 s at 10× synthetic volume (scratch DB). |
| P2-G2 | Port latency | p95 is at most 50 ms for each §5.1 operation at 10×. |
| P2-G3 | Daemon memory | Private bytes stay within 250 MB of the pre-change baseline at 10×. |
| P2-G4 | Curated parity | Vocabulary topics and entity-rule links exactly equal the P0-G3 export. |
| P2-G5 | Crash | After `taskkill /F` on the daemon and a restart, the dump is identical. |
| P3-G1 | Phone smoke test | Status, analytics, and a natural-language query work on `SM-S948U1` with the installed build. |
| P3-G2 | Suites | `pnpm test` is green and `pnpm typecheck` reports 0 errors. |
| P3-G3 | Soak | Three days with zero graph errors in the daemon log. |
| P3-G4 | Rollback drill | The revert tag plus Neo4j started from the P0-2 copy restores the previous screens. |
| P4-G1 | Retired | Nothing listens on 7474 or 7687. No Neo4j lines appear in the daemon log. The docs are updated. |
| P5-G1 | Aura | The export SHA-256 and counts are recorded. Memory search returns local graph hits in a test where network access throws. |

- **10× synthetic volume:** a scratch DB generated by cloning the live mix of kinds with synthetic payloads. It never touches the live file (S7).
- **Host state for timing and memory gates:** the three llama-server processes must be running, as measured in §2.6.

### 9.1 Gate status ledger (2026-10-31)

| Gate | Status | Evidence / PR |
|---|---|---|
| P0-G1..P0-G5 | PASS | `docs/evidence/world-model-store/P0-G1.json`..`P0-G5.json`, [PR #77](https://github.com/Dysfunction-Junction/sovereign-exocortex/pull/77) (`bc9b139`), [PR #78](https://github.com/Dysfunction-Junction/sovereign-exocortex/pull/78) (`3171837`) |
| P1-G1..P1-G5 | PASS | `docs/evidence/world-model-store/P1-G1.json`..`P1-G5.json`, [PR #79](https://github.com/Dysfunction-Junction/sovereign-exocortex/pull/79) (`738314c`) |
| P2-G1..P2-G5 | PASS | `docs/evidence/world-model-store/P2-G1.json`..`P2-G5.json`, [PR #81](https://github.com/Dysfunction-Junction/sovereign-exocortex/pull/81) |
| P3-G2 | PASS | `docs/evidence/world-model-store/P3-G2.json`, [PR #82](https://github.com/Dysfunction-Junction/sovereign-exocortex/pull/82) (`4d8938f`) |
| P3-G1 | PASS | `docs/evidence/world-model-store/P3-G1.json` (SM-S948U1 phone smoke test, status/analytics/NL query verified, user confirmed) |
| P3-G3 | PENDING | 3-day daemon soak post-cutover |
| P3-G4 | PENDING | Rollback drill (`pre-world-model-store-cutover` + P0-2 copy) |
| P4-G1 | PENDING | After P3-G3, P3-G4, 30-day retention window, and explicit user confirmation (S4) |
| P5-G1 | PASS | `docs/evidence/world-model-store/P5-G1.json`, PR #83 (Aura ENOTFOUND, pieces-graph artifact export 5.83 MB, 7,662 nodes, 7,534 relations, zero-network memory.search test pass) |

## 10. Evidence files

Each gate writes `docs/evidence/world-model-store/<ID>.json`:

```json
{
  "gate": "P2-G1",
  "git_sha": "",
  "command": "",
  "ran_at": "",
  "host_state": { "commit_used_gb": 0, "llama_server_running": true },
  "measured": {},
  "threshold": {},
  "pass": false,
  "notes": ""
}
```

Evidence files hold counts, timings, and hashes only. They never contain payload content, names, or credentials.

## 11. Order, owners, rollback

| Step | Owner | Depends on | Rollback |
|---|---|---|---|
| P0-1 to P0-3 | Implementer, or the planner on request | nothing | Copies only. |
| P0-4 fix PR | Implementer; the planner reviews | P0-2 | Revert the PR. |
| P0-5 docs | Planner or implementer | P0-3 | Revert the doc edits. |
| Phase 1 | Implementer; the planner reviews | P0-4 merged | Revert. The `artifacts` table is additive. |
| Phase 2 | Implementer; the planner reviews | Phase 1 | Revert. |
| Phase 3 | Implementer; the user runs P3-G1 | Phase 2 | Revert tag plus the P0-2 copy. |
| Roadmap M4 | Per the roadmap | Phase 3, which provides `topic_num` and the port | Per the roadmap. |
| Phase 4 | Implementer, after the user confirms | P3-G3, P3-G4, and 30 days | None once deleted, hence the retention window. |
| Phase 5 | Implementer; the user confirms credential removal | P0-3 | The export file is kept. |

- Phases 1 and 2 can run in parallel with roadmap M1 and M2, which change phone code.
- The planner writes per-phase specs when an implementer asks for one.
- The planner reviews every PR and evidence file before merge.

## 12. Out of scope

- Exposure logging for forecast cards and other surfaced outputs. This is the remaining feedback path.
- Redaction or crypto-shredding of ledger payloads.
- Loading File and Folder nodes and path-rule links into the graph. They stay in their artifact until a consumer needs them.
- Counterfactual error mining queries (CEM-1). When they are specified, they are checked against P2-G2 before any engine change.

## 13. Reproducing the audit

- **Ledger counts.** Open `%LOCALAPPDATA%\exocortex.db` with a read-only SQLite connection (`mode=ro`), then run:
  - `SELECT kind, COUNT(*) FROM events GROUP BY kind`
  - a tally of `payload.source` and `payload.origin` per kind
  - `SELECT name, seq FROM consumer_cursors`
- **Restart window:** `SELECT seq, ts_server FROM events ORDER BY seq LIMIT 1 OFFSET 999`.
- **Neo4j state:**
  - `netstat -ano` for ports 7474 and 7687.
  - The start and stop lines in `apps/neo4j-import/.neo4j/logs/neo4j.log`.
  - A search of `query.log` for the `TOPIC` delete statement.
- **Delete commit:** `git log -S "n.type = 'TOPIC' OR n.id = 'person_michael_hebert'" -- apps/daemon/src/neo4j-sync.ts`.
- **Phone:** `adb shell getprop ro.product.model` and `adb shell getprop ro.soc.model`.
- **Packages:** `npm view @ladybugdb/core@0.22.1 scripts optionalDependencies dependencies`.
