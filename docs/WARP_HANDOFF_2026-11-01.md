# Warp handoff: sovereign-exocortex (2026-11-01)

## Mission (one screen)

You are continuing work on **Sovereign Exocortex**, a local-first personal assistant monorepo at `C:\Users\micha\projects\sovereign-exocortex` (GitHub `Dysfunction-Junction/sovereign-exocortex`).

Compress every session into five outcomes:

1. **Understand** — map the checkout, `main` tip, active plan, live ports, and ledger without rediscovering from scratch.
2. **Identify** — name the real gaps (code, docs, gates, owner-only ops) with file paths and stop rules.
3. **Clean** — fix only low-risk drift that helps the next agent; never widen safety surface area.
4. **Prioritize** — pick the single next Ready row; one claimable unit of work per session.
5. **Hand off** — leave durable context (queue row status, evidence paths, commands, what was *not* verified) so the next engineer or coding agent continues cold.

**Active track:** retire Neo4j / serve the life graph from the ledger via GraphStore. Spec: [`PLAN_WORLD_MODEL_STORE_2026-10-31.md`](PLAN_WORLD_MODEL_STORE_2026-10-31.md). Queue: [`AGENT_QUEUE.md`](AGENT_QUEUE.md). Map: [`../AGENTS.md`](../AGENTS.md).

**Hard stops:** `SHADOW` stays on unless the owner explicitly runs a go-live drill. Never loosen approve/delegate/attestation/event-log triggers. Never write synthetic events to `%LOCALAPPDATA%\exocortex.db` (plan S7). Never delete Neo4j data or credentials without explicit user confirmation (S4). Code wins over docs; then fix the doc in the same PR.

**Success for this repo right now:** finish world-model remaining gates (live curation apply with owner OK → soak → rollback drill → credential scrub → later P4 retirement) while owner continues shadow labels toward Precision@surface. Do not restart the finished finish-line builder queue.

---

## Detailed operating procedure

### 0. Cold start (do this every new session)

```powershell
cd C:\Users\micha\projects\sovereign-exocortex
git fetch origin
git checkout main
git pull
git status -sb
gh pr list --state open --limit 20
```

Then open, in order:

1. This file
2. `AGENTS.md` (ports and path map only)
3. `docs/AGENT_QUEUE.md` (first **Ready** row)
4. `docs/PLAN_WORLD_MODEL_STORE_2026-10-31.md` §§0, 9, 9.1 if the row is WM-*
5. Code named by the row — not `docs/USER_MANUAL.md` (drifted)

Toolchain measured here: **Node v24.16.0**, **pnpm 11.7.0**, Windows **PowerShell**. Prefer PowerShell; avoid bash `&&` chains.

### 1. Understand — what this system is

| Layer | Path | Role |
|---|---|---|
| Gateway daemon | `apps/daemon` (`exocortexd`) | HTTP on **:8788**, auth, shadow, channels, graph routes, mesh launch |
| Mobile / desktop UI | `apps/mobile`, `apps/desktop` | Capacitor Android + Tauri shell |
| CLI | `apps/cli` | `pnpm exo …` |
| Event log + core | `packages/core` | hash-chained SQLite ledger, predictions, shadow metrics |
| World model | `packages/world-model` | life graph, cognitive gate, active inference, GraphStore |
| Memory | `packages/memory` | local LTM; GraphClient is **local-only** after P5 |
| Databank | `packages/databank` | encrypted cold archive + domain parsers |
| Mesh / triad (in-repo) | `packages/mesh`, `packages/triad` | MCP router and Python advisory (≠ sibling checkouts) |

**Sibling mesh checkouts** (expected under `C:\Users\micha\projects\`): `hermes-api` :3000, `autonomous-triad` :8789, `pieces-for-all` :39400, `agent-mesh-mcp` :39401, `pattern-analyzer` :39402, `registry-app` :39403, `Gut-Instinct` :39404, `tool-registry-heartbeat` :39405. Home proxy (~:8787) and PiecesOS (:39300) are separate processes, not this table.

**Design intent (do not violate):**

- Shadow first; actuation is per risk tier, not a build flag
- One append-only event log is source of truth; graphs/beliefs are projections
- Deterministic core: models propose, typed policy decides; no LLM in gate/approve
- Capabilities, not trust; honest naming

Live ledger path: `%LOCALAPPDATA%\exocortex.db` (observed ~24 MB on 2026-11-01). Snapshot date in the world-model plan still cites 17,461 events at max seq 17,461 — **re-count before any live write**; the file has grown since the 2026-10-31 audit.

### 2. Identify — current truth (2026-11-01)

**Git**

- Branch: `main` @ `416f1cb` — `feat(databank): add Samsung and Google contacts parser with CLI ingest`
- Tracking: clean vs `origin/main` when this handoff was written
- Open PRs: **none**
- Recent merged world-model work: #79–#83 (provenance → GraphStore → Living Brain → daemon cutover → pieces-graph / networkless memory)
- Revert tag for graph cutover: `pre-world-model-store-cutover` (at `28047bd`)

**Finish-line (Oct 28 run)**

- All builder rows in `docs/REMAINING_WORK.md` / historical `AGENT_QUEUE` section: **Done**
- Owner checklist still open: device revoke, daily labels, weekly shadow report, channel resync once, Ollama uninstall confirmation, hardware device test, eventual SHADOW go-live
- Do **not** treat CODEX/AGY finish-line prompts as active build queues

**World-model store gates** (`docs/evidence/world-model-store/`)

| Gate | Status | Evidence |
|---|---|---|
| P0-G1..G5 | PASS | `P0-G*.json`, PR #77 #78 |
| P1-G1..G5 | PASS | `P1-G*.json`, PR #79 |
| P2-G1..G5 | PASS | `P2-G*.json`, PR #81 |
| P3-G1 | PASS | `P3-G1.json` (SM-S948U1, user confirmed, sha `5c545ab`) |
| P3-G2 | PASS | `P3-G2.json`, PR #82 |
| P3-G3 | **PENDING** | 3-day soak, zero graph errors in daemon log |
| P3-G4 | **PENDING** | Rollback drill with tag + P0-2 Neo4j copy |
| P4-G1 | **PENDING / blocked** | After soak, rollback, 30-day retention, **user confirm** |
| P5-G1 | PASS | `P5-G1.json`, PR #83 (Aura ENOTFOUND, 5.83 MB export, fetch-throw test) |

**Runtime snapshot when this brief was written**

- Something was speaking on **127.0.0.1:8788** (daemon path)
- Embed port **:8081** saw traffic; full llama trio (:8080/:8081/:8082) not fully re-validated in this pass
- **:7474 / :7687** not observed listening (Neo4j appears stopped — good; keep it that way unless running an isolated inventory copy on alternate ports)
- Databank parsers for Takeout, Join SMS, Health Connect, contacts are on `main`

**Doc drift still worth knowing**

- `docs/USER_MANUAL.md` — drifted; verify against `apps/daemon/src/server.ts`
- `docs/REMAINING_WORK.md` §5 still mentions Ollama for home proxy “until R9”; §1 already says R9 Done — prefer §1 + README
- `apps/daemon` still contains `neo4j-sync.ts` / `pnpm neo4j-sync` for rollback/legacy; **do not run sync against curated stores** (plan S1 — TOPIC delete hazard)
- Plan progress header was corrected 2026-11-01; gate table §9.1 is authoritative for PASS/PENDING

**Hazards**

- `syncGraph` historically `DETACH DELETE`s `type='TOPIC'` entities — destroyed vocabulary on Desktop Neo4j; surviving curated copy is the P0-2 backup / repo `.neo4j` that never ran the delete
- Live ledger is append-only permanent — test only on scratch DBs
- `packages/memory/.env` may still hold old Aura key *names*; removal needs owner confirmation even if Aura is ENOTFOUND
- Never use branch/worktree `spike/gemma-litertlm` for this work (uncommitted Android spike)

### 3. Clean — what already got fixed in this pass

Edits on the working tree (commit only if the owner asks):

- `docs/AGENT_QUEUE.md` — active WM queue + pointer to this brief; finish-line table marked historical
- `docs/PLAN_WORLD_MODEL_STORE_2026-10-31.md` — progress: P3-G1 Done; remaining list corrected
- `AGENTS.md` — docs index points at this handoff + world-model plan
- `README.md` — Living Brain/GraphStore wording; R9 Ollama status corrected

No application code was changed. No live ledger writes. No credentials touched. No commit/push.

### 4. Prioritize — next work (ordered)

Do **one** Ready unit per session. Claim with a draft PR title containing the row id.

1. **WM-LIVE (Ready, needs owner OK for apply)**  
   - Dry-run first:  
     `pnpm --filter @exocortex/daemon curation-import -- <neo4j-export.json>`  
   - Apply only after owner explicitly approves writing the live ledger: add `--apply`  
   - Confirm daemon graph status serves vocabulary counts consistent with P3 evidence (~8157 topics / entity-rule links as recorded)  
   - CLI: `apps/daemon/src/curation-import-cli.ts` (default dry-run)

2. **WM-P3-G3 (Ready)**  
   - Run daemon ≥3 days post-cutover  
   - Zero graph errors in daemon log  
   - Write `docs/evidence/world-model-store/P3-G3.json` in the evidence schema from the plan §10

3. **WM-P3-G4 (Ready)**  
   - Rollback drill: check out / run from tag `pre-world-model-store-cutover` and Neo4j from **P0-2 copy only** (never original data dir recovery on production copy — S2)  
   - Evidence `P3-G4.json`

4. **WM-CREDS (Ready, owner)**  
   - User confirms deletion of Neo4j/Aura entries from local env files  
   - Do not print secret values into chat, commits, or evidence files

5. **WM-P4-G1 (Blocked)**  
   - Only after P3-G3, P3-G4, 30-day retention window, and explicit user confirmation  
   - Retire local Neo4j listeners/docs leftovers

6. **Owner finish-line (parallel, not agent-merge work)**  
   - Daily Review labels; weekly:  
     `npx tsx packages/core/shadow-report-cli.ts "$env:LOCALAPPDATA\exocortex.db" --days 14`  
   - Revoke unknown devices via `apps/daemon/src/revoke-cli.ts`  
   - `pnpm --filter @exocortex/daemon channel-resync` once if not already done  
   - Device test runbook before any SHADOW=0 experiment  
   - Go-live only when Precision@surface gate passes (see shadow runbook)

**Out of scope unless owner redirects:** morphogenetic enablement, new servers/models, LadybugDB, rewriting USER_MANUAL wholesale, multi-user, self-patching prod.

### 5. Hand off — every session must leave

When you stop, update:

1. `docs/AGENT_QUEUE.md` row status (`In review` / `Done` / blocked reason)
2. Evidence JSON under `docs/evidence/world-model-store/` for any gate you ran (counts, timings, hashes — **never** payloads, names, credentials)
3. PR body with commands + outputs
4. A short “not verified” list (honest limits)

Optional: append a dated note under `docs/` only if this brief is wrong; prefer fixing this file or the plan progress block over spawning parallel truths.

### 6. Standard build / test commands

```powershell
pnpm install
pnpm typecheck
pnpm test
pnpm --filter @exocortex/daemon test
pnpm --filter @exocortex/daemon start
pnpm --filter @exocortex/daemon curation-import -- <export.json>          # dry-run
pnpm --filter @exocortex/daemon curation-import -- <export.json> --apply  # LIVE write — owner OK only
pnpm --filter @exocortex/daemon channel-resync
npx tsx packages/core/shadow-report-cli.ts "$env:LOCALAPPDATA\exocortex.db" --days 14
```

Triad real Docker tests: WSL only (`docs/REMAINING_WORK.md` §5 pattern). On Windows triad unit runs set `$env:TRIAD_SKIP_REAL_DOCKER="1"` when needed.

### 7. Review bar (any PR touching safety-adjacent code)

Use the six-line bar from `docs/REMAINING_WORK.md` §4:

1. Spec Done-when met  
2. SHADOW not defeated  
3. Authz default-deny on new/changed routes  
4. No plaintext personal content in `events`  
5. Tests would fail if the change were reverted  
6. No drive-by file churn without PR justification  

Fail closed on 2, 3, or 4.

### 8. What this pass did *not* verify

- Full `pnpm test` / `pnpm typecheck` greenness after databank commits (last recorded suite snapshot is P3-G2 evidence on older sha)
- Live `curation-import --apply` against `%LOCALAPPDATA%\exocortex.db`
- P3-G3 soak and P3-G4 rollback
- Exact current event count / consumer cursors after 2026-10-31 (re-query before writes)
- Whether `packages/memory/.env` still contains Aura key material (existence only; do not dump)
- Sibling mesh health beyond path presence checks attempted during discovery
- Physical phone re-test beyond existing P3-G1 evidence
- Shadow Precision@surface numbers

---

## Paste prompt (next agent)

```text
You are continuing sovereign-exocortex. Repo: C:\Users\micha\projects\sovereign-exocortex.
Read docs/WARP_HANDOFF_2026-11-01.md first (mission + procedure), then AGENTS.md, then docs/AGENT_QUEUE.md.
Active track = world-model store (docs/PLAN_WORLD_MODEL_STORE_2026-10-31.md). Finish-line builder rows are Done; do not restart them.
Work the first Ready queue row only. Obey stop rules S1–S7. Never SHADOW=0. Never write synthetic events to the live ledger. Never delete Neo4j/credentials without explicit user confirmation.
End with queue/evidence updates and an honest not-verified list.
```

## Provenance

- Written: 2026-11-01 by Warp agent pass (understand → identify → clean → prioritize → hand off)
- HEAD observed: `416f1cb` on `main`
- Companion edits: `AGENT_QUEUE.md`, plan progress header, `AGENTS.md`, `README.md` graph/Ollama wording
