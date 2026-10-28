# Agent queue

Single source of truth for who builds what next. Any agent (Claude Code, agy) can work from this file with no relay.
Row numbers come from `docs/FINISH_LINE_PLAN_2026-10-28.md`. If this file and the code disagree, the code wins.

## How to pick work
1. `git fetch origin` and `gh pr list` first.
2. Take the first row marked **Ready** for your tool. Skip rows another PR already covers.
3. Open a **draft PR** right away with the row number in the title. That claims the row.
4. Build it. CI (`.github/workflows/ci.yml`) must be green, and the PR template must be filled in.
5. In your PR, edit this table: set your row to `In review`. After merge, the next agent sets it to `Done`.
6. Stop. One row per session.

## Rules
- Node 24. Windows shell is PowerShell 5.1 (no `&&`, write files as UTF-8).
- Never turn SHADOW off. Never loosen `/network/delegate`, approval, attestation or the event log.
- Anything touching the event schema, event log, replay, approvals or SHADOW: stop, write the design, get Opus review first.
- Do not push to main. Do not force-push. Do not add servers or change model sizes without asking.

## Queue
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
| 4.0a | Shadow surfacing volume: Precision@surface counts only surfaced proposals (correct), so the review screen does not speed the gate. Propose a shadow-only surfacing threshold change | Opus | Needs design |
| 1.1 | Channel event schema and email-body decision | Opus | Needs design |
| N.1 | "Why" line on review cards (PR #41) | agy | Done |
| 2.1b | Tighten map: T3/T4 need `admin:write`, non-string memory sub-action denied (PR #40, Opus-approved) | Claude Code | Done |
| 2.1c | Delegate follow-ups: `delegate:actuate` scope required for T3/T4 before SHADOW=0 is ever used; write an event for every denied delegation; rate-limit `triad classify`; fix the 423 body text (says hermes-api for every block) | Claude Code | Ready |
| 2.3 | Scripted executors for every T0/T1 action (no LLM in the execute step) | agy | Ready |
| 2.4 | Morphogenetic engine: flag default off, or add the missing gates (no-network container, diff-size cap, static and security scan, reproduction test) | Claude Code | Ready |
| 2.5 | Kill-switch drill: flipping SHADOW=1 at runtime blocks every actuating route | Claude Code | Ready (Opus review before merge) |
| 1.2-1.6 | Ingestion build | agy | Blocked on 1.1 |
| - | Move home proxy `/mobile/ask` off Ollama (other repo: pieces-android-shizuku-monitor) | Claude Code | Blocked (separate repo) |
