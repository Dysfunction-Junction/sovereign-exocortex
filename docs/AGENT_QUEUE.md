# Agent queue

Single source of truth for who builds what next. Any agent (Claude Code, agy, Warp) can work from this file with no relay.
If this file and the code disagree, the code wins.

**Active track (2026-11-01):** world-model store cutover and Neo4j retirement. Spec and frozen gates: [`docs/PLAN_WORLD_MODEL_STORE_2026-10-31.md`](PLAN_WORLD_MODEL_STORE_2026-10-31.md). Evidence: `docs/evidence/world-model-store/`. Continuation brief: [`docs/WARP_HANDOFF_2026-11-01.md`](WARP_HANDOFF_2026-11-01.md).

The finish-line builder run (`docs/FINISH_LINE_PLAN_2026-10-28.md`, `docs/REMAINING_WORK.md`) is complete for all agent rows. Remaining finish-line items are **owner-only** (section 6 of `REMAINING_WORK.md`): labels, weekly shadow gate, device revoke, channel resync, Ollama uninstall confirmation, go-live.

## How to pick work
1. `git fetch origin` and `gh pr list` first.
2. Take the first row marked **Ready** for your tool. Skip rows another PR already covers.
3. Open a **draft PR** right away with the row number in the title. That claims the row.
4. Build it. CI (`.github/workflows/ci.yml`) must be green, and the PR template must be filled in.
5. In your PR, edit this table: set your row to `In review`. After merge, the next agent sets it to `Done`.
6. Stop. One row per session.

## Rules
- Node 24. Windows shell is PowerShell 5.1 / 7 (no bash `&&` assumptions; write files as UTF-8).
- Never turn SHADOW off. Never loosen `/network/delegate`, approval, attestation or the event log.
- Anything touching the event schema, event log, replay, approvals or SHADOW: stop, write the design, get review first.
- World-model store stop rules S1–S7 in the plan are binding. Never write synthetic events to `%LOCALAPPDATA%\exocortex.db`. Never delete Neo4j data or credentials without explicit user confirmation (S4).
- Do not push to main. Do not force-push. Do not add servers or change model sizes without asking.

## Active queue (world-model store)

| Row | Work | Tool | Status |
| --- | --- | --- | --- |
| WM-P0..P2 | Backups, provenance, GraphStore, gates P0–P2 | merged | Done |
| WM-P3.1-3.3 | Daemon graph routes, Living Brain cutover, curation-import CLI, P3-G2 | merged #80 #82 | Done |
| WM-P3-G1 | Phone smoke on SM-S948U1 | owner + evidence | Done |
| WM-P5-G1 | Aura retired, local pieces-graph export, networkless memory.search | merged #83 | Done |
| WM-LIVE | Confirm live daemon serves GraphStore vocabulary; `curation-import --apply` on live ledger only with owner OK | implementer + owner | Ready |
| WM-P3-G3 | 3-day daemon soak, zero graph errors | owner/implementer | Ready |
| WM-P3-G4 | Rollback drill: tag `pre-world-model-store-cutover` + P0-2 Neo4j copy | implementer | Ready |
| WM-CREDS | User-confirmed removal of any remaining Neo4j/Aura keys in local `.env` files | owner | Ready |
| WM-P4-G1 | After P3-G3, P3-G4, 30-day retention, user confirm: retire local Neo4j | owner | Blocked |
| DB-PARSERS | Databank domain parsers (Takeout, Join SMS, Health Connect, contacts) on `main` | merged | Done |

## Finish-line queue (historical, all Done)

Full specs: [`docs/REMAINING_WORK.md`](REMAINING_WORK.md). Builders were agy and Codex.

| Row | Work | Tool | Status |
| --- | --- | --- | --- |
| 0.1 | Triage-label test fix, README limits (PR #18) | any | Done |
| 3.1-3.2 | Embeddings and vision on llama.cpp (PR #19) | any | Done |
| 0.4 | Obsidian test builds a temp vault (PR #20) | agy | Done |
| 0.2 | CI workflow | Claude | Done |
| - | `packages/triad` off Ollama to llama.cpp :8080 (PR #22); `EXOCORTEX_TRIAD_BACKEND=ollama` restores Ollama | agy | Done |
| 0.3 | Raise root `engines` to Node >= 24 (PR #23) | agy | Done |
| 0.5 | `checkout_argv` works on Git < 2.44 (PR #24) | agy | Done |
| 0.6 | Tag `person:` entities with source channel; purge by tag on Gmail disconnect (PR #25) | agy | Done |
| 0.7 | Clear mobile lint warnings (Setup.tsx, LivingBrain.tsx) (PR #28) | agy | Done |
| 4.0 | Daily review screen in the phone app for one-tap shadow labels (PR #29) | agy | Done |
| 3.3 | Inference broker (queue, priority triage > embed > vision) (PR #26) | Claude Code | Done |
| 2.1-2.2 | Delegate capability map, /network/delegate routed through it (PR #34, Opus-reviewed design) | Claude Code | Done |
| 3.3a | OS priority for llama-server roles (PR #36). Triage p95 1.30 s quiet, 1.49 s under embed backfill (+14.5%); broker proxy not needed | agy | Done |
| 2.4a | Verification containers run as the invoking uid:gid on Linux, root refused; works on 0700 workspaces (PR #39). No profile runs git in the container | Claude Code | Done |
| 4.0a | Calibration surfacing in shadow mode (spec R4, PR #57) | Codex | Done |
| 1.1 | Channel event schema and private content vault (spec R5) | Codex | Done |
| N.1 | "Why" line on review cards (PR #41) | agy | Done |
| 2.1b | Tighten map: T3/T4 need `admin:write`, non-string memory sub-action denied (PR #40, Opus-approved) | Claude Code | Done |
| 2.1c | Delegate follow-ups: `delegate:actuate` scope required for T3/T4 before SHADOW=0 is ever used; write an event for every denied delegation; rate-limit `triad classify`; fix the 423 body text (says hermes-api for every block) | Claude Code | Done |
| 2.3 | Scripted executors for every T0/T1 action (no LLM in the execute step) (PR #47) | agy | Done |
| 2.4 | Morphogenetic engine: flag default off, or add the missing gates (no-network container, diff-size cap, static and security scan, reproduction test) (flag default off, diff-size cap and reproduction gate in the 2.4 PR) | Claude Code | Done |
| 2.4b | Morphogenetic static and security scan gate (spec R3, PR #56) | agy | Done |
| 2.5 | Kill-switch drill: flipping SHADOW=1 at runtime blocks every actuating route | Claude Code | Done |
| 2.6 | Scope check on /v3/channels/* (spec R1) | Codex | Done |
| 2.3a | Re-tier self_heal_restore: it writes local graph state, so it is T2, not T0 (spec R10, PR #59) | agy | Done |
| 1.2 | Adapters emit channel events (spec R6, PR #61) | agy | Done |
| 1.3 | World model projects channel events (spec R7, PR #62) | Codex / agy | Done |
| 1.4-1.6 | Async consumer, replay test, resync (spec R8) | agy | Done |
| - | Home proxy /mobile/ask off Ollama, then retire Ollama (spec R9, PR #14 in pieces-android-companion-seamless) | Codex / agy | Done |
