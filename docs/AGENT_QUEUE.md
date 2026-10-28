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
| - | Move `packages/triad` off Ollama to llama.cpp :8080 (branch `feat/ollama-cutover-triad`) | Claude Code | In progress |
| 0.3 | Raise root `engines` to Node >= 24 (PR #23) | agy | Done |
| 0.5 | `checkout_argv` works on Git < 2.44 (PR #24) | agy | Done |
| 0.6 | Tag `person:` entities with source channel; purge by tag on Gmail disconnect | agy | In review |
| 0.7 | Clear mobile lint warnings (Setup.tsx, LivingBrain.tsx) | agy | Ready |
| 4.0 | Daily review screen in the phone app for one-tap shadow labels | agy | Ready |
| 3.3 | Inference broker (queue, priority triage > embed > vision) | Claude Code | Ready |
| 2.1-2.2 | Delegate capability map, route /network/delegate through it | Claude Code | Needs Opus review |
| 1.1 | Channel event schema and email-body decision | Opus | Needs design |
| 1.2-1.6, 2.3-2.5 | Ingestion build, scripted executors, kill-switch drill | agy | Blocked on 1.1 / 2.1 |
| - | Move home proxy `/mobile/ask` off Ollama (other repo: pieces-android-shizuku-monitor) | Claude Code | Blocked (separate repo) |
