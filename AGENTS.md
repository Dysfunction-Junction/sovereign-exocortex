# Agent index

This file is a map. It names checkouts, ports, and the file to open. It does not describe behavior. If a line here and the code disagree, the code wins; then correct this file's path or port.

The launch table is copied from [`apps/daemon/src/mishmash-nodes.ts`](apps/daemon/src/mishmash-nodes.ts). That file is the routing contract. Checkouts sit next to each other. The launcher treats a directory as the repos root when it contains `hermes-api`, `autonomous-triad`, and `pieces-for-all` ([`defaultReposRoot`](apps/daemon/src/mishmash-launch.ts)).

## Family

| Launch id | Directory | Port | Role in the launch table | Mesh entry |
|---|---|---|---|---|
| *(this repo)* `exocortexd` | `sovereign-exocortex` | 8788 | gateway | [`apps/daemon/src/server.ts`](apps/daemon/src/server.ts) |
| `hermes-api` | `hermes-api` | 3000 | device and phone tasks | `mishmash/delegate.ts` |
| `autonomous-triad` | `autonomous-triad` | 8789 | intent and review | `triad.server` |
| `pieces-for-all` | `pieces-for-all` | 39400 | local memory gateway | `src/server.ts` |
| `agent-mesh-mcp` | `agent-mesh-mcp` | 39401 | local MCP switchboard | `src/mishmash-delegate.ts` |
| `pattern-analyzer` | `pattern-analyzer` | 39402 | pattern lifecycle ranking | `src/mishmash-delegate.ts` |
| `registry-app` | `registry-app` | 39403 | SecondGuess staging | `mishmash/delegate.ts` |
| `gut-instinct` | `Gut-Instinct` | 39404 | on-device coach contract | `mishmash/delegate.mjs` |
| `tool-registry-heartbeat` | `tool-registry-heartbeat` | 39405 | scheduled tool-inventory tasks | `mishmash/delegate.mjs` |

The home proxy (often `:8787`) and PiecesOS (`:39300`) are separate local processes. They are not checkouts in this table.

## This repo

Open [`README.md`](README.md) for status, the package table, how to run, and known gaps. Then open the path for the area you are changing:

| Path | Open when the question is about |
|---|---|
| [`apps/daemon`](apps/daemon) | gateway, auth, shadow, channels, graph routes, legacy neo4j-sync helpers, push |
| [`apps/mobile`](apps/mobile) | Android companion and the UI the desktop shell loads |
| [`apps/desktop`](apps/desktop) | Tauri shell (`get_local_config` is in `src-tauri/src/lib.rs`) |
| [`apps/cli`](apps/cli) | `exo` commands |
| [`packages/world-model`](packages/world-model) | life graph, cognitive gate, active inference |
| [`packages/core`](packages/core) | event log, prediction, pre-cognitive quantile |
| [`packages/memory`](packages/memory) | local long-term memory |
| [`packages/databank`](packages/databank) | encrypted cold archive |
| [`packages/mesh`](packages/mesh) | MCP router **inside this repo** |
| [`packages/triad`](packages/triad) | Python advisory package **inside this repo** |
| [`packages/allowlist`](packages/allowlist) | gateway routing allowlist |

`packages/triad` and the sibling checkout `autonomous-triad` are different trees. `packages/mesh` and the sibling checkout `agent-mesh-mcp` are different trees.

## Docs

| Doc | Use it for |
|---|---|
| [`README.md`](README.md) | current status, setup, honest limits |
| [`docs/WARP_HANDOFF_2026-11-01.md`](docs/WARP_HANDOFF_2026-11-01.md) | current continuation brief (read first if cold-starting) |
| [`docs/AGENT_QUEUE.md`](docs/AGENT_QUEUE.md) | what to build next, how to claim a row, the rules |
| [`docs/PLAN_WORLD_MODEL_STORE_2026-10-31.md`](docs/PLAN_WORLD_MODEL_STORE_2026-10-31.md) | active Neo4j→GraphStore plan, stop rules, frozen gates |
| [`docs/ARCHITECTURE_V3.md`](docs/ARCHITECTURE_V3.md) | event schema and world-model math |
| [`docs/DEVICE_TEST_RUNBOOK.md`](docs/DEVICE_TEST_RUNBOOK.md) | phone-to-approval hardware test |
| [`docs/SHADOW_EVALUATION_RUNBOOK.md`](docs/SHADOW_EVALUATION_RUNBOOK.md) | shadow calibration before a tier goes live |
| [`docs/REMAINING_WORK.md`](docs/REMAINING_WORK.md) | finish-line specs (agent rows Done; owner checklist remains) |
| [`docs/CODEX_HANDOFF.md`](docs/CODEX_HANDOFF.md), [`docs/AGY_HANDOFF.md`](docs/AGY_HANDOFF.md) | historical per-agent finish-line prompts |
| [`docs/DATABANK_ARCHITECTURE.md`](docs/DATABANK_ARCHITECTURE.md) | cold archive |
| [`docs/AUDIT_FOLLOWUP_PLAN_2026-10-09.md`](docs/AUDIT_FOLLOWUP_PLAN_2026-10-09.md) | older audit follow-ups; the date is part of the name |

Files under `docs/` whose names include a date are point-in-time notes. Read the date before treating one as current.

[`docs/USER_MANUAL.md`](docs/USER_MANUAL.md) has drifted from the daemon. Confirm routes, ports, the shadow flag, and network use against [`apps/daemon/src/server.ts`](apps/daemon/src/server.ts) and [`README.md`](README.md) before repeating anything it says. The Living Brain colors and synaptic layout are implemented in [`apps/mobile/src/pages/LivingBrain.tsx`](apps/mobile/src/pages/LivingBrain.tsx) and [`apps/mobile/src/lib/synapticAudio.ts`](apps/mobile/src/lib/synapticAudio.ts); read those files rather than the manual.

## Names that get confused

| Name | Where it is defined |
|---|---|
| Gateway port | `GATEWAY_PORT` in [`apps/daemon/src/server.ts`](apps/daemon/src/server.ts), default 8788 |
| Shadow flag | `SHADOW` in [`apps/daemon/src/server.ts`](apps/daemon/src/server.ts). Read the checks there. Do not invent a second live flag. |
| Cognitive modes | [`packages/world-model/cognitive-gate.ts`](packages/world-model/cognitive-gate.ts) |
| Active inference | [`packages/world-model/active-inference.ts`](packages/world-model/active-inference.ts) |
| Approval labels | `POST /v3/shadow/labels` in [`apps/daemon/src/server.ts`](apps/daemon/src/server.ts) |
| Device revoke | [`apps/daemon/src/revoke-cli.ts`](apps/daemon/src/revoke-cli.ts) |
