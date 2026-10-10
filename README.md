# Sovereign Exocortex

A private, local-first personal operating system. It watches signals from your phone and PC, predicts the next useful action, and stages it without interrupting you. Nothing changes state until you approve it with a verified biometric tap.

> **Status: shadow mode.** `SHADOW=1` is the default. The system logs what it *would* propose and measures how often it is right. It does not act on its own. Real Precision@surface numbers do not exist yet; see [Roadmap](#roadmap).

## Design rules

1. **Shadow first.** Actuation is a capability granted per risk tier, never a build flag.
2. **One append-only event log is the source of truth.** The life graph, beliefs and caches are projections rebuilt from it (hash-chained SQLite, WAL mode).
3. **Deterministic core.** Models propose; a typed policy engine decides. No LLM sits in the gate or approval path.
4. **Capabilities, not trust.** Every device and agent holds scoped, revocable grants.
5. **Honest naming.** A component named for a method must implement it, or be renamed.

Non-goals: self-patching production code, cloud-hosted state, multi-user support.

## Layout

pnpm workspace, TypeScript (Node >= 22) plus a Python package for the triad.

| Path | Package | What it does |
|---|---|---|
| `apps/daemon` | `@exocortex/daemon` | `exocortexd` host: gateway on `:8788`, device enrollment and scoped grants, JWT auth, attestation checks, shadow recorder, FCM push, mesh launcher and sentinel |
| `apps/mobile` | `@exocortex/mobile` | Capacitor Android app: accessibility capture, on-device triage, biometric approval modal |
| `apps/cli` | `@exocortex/cli` | `exo` command: `status`, `world`, `memory`, `gate`, `test` |
| `packages/core` | `@exocortex/core` | Event bus, pattern analyzer, speculative dry-run cache, pre-cognitive readiness |
| `packages/world-model` | `@exocortex/world-model` | Living Life Graph, Cognitive Mode Gate, Active Inference engine |
| `packages/memory` | `@exocortex/memory` | Local long-term memory (token/vector overlap store) |
| `packages/mesh` | `@exocortex/mesh` | MCP router, durable playbooks, swarms, two-phase patch promotion |
| `packages/triad` | `@exocortex/triad` | Advisory council and ephemeral-worktree risk gating (Python) |
| `packages/allowlist` | `@pieces-android/allowlist` | Gateway routing allowlist |

## How it works

```
phone + PC signals --> event log --> world model --> proposal
                                                        |
                                    cognitive mode gate + risk tier
                                                        |
                              shadow: log only   |   live: biometric approval
                                                        |
                                              execute via mesh / triad
                                                        |
                                    outcome labels feed back into the model
```

- **Living Life Graph:** entities (people, projects, devices, routines) with decaying activation and spreading activation across weighted edges.
- **Cognitive Mode Gate:** filters what may interrupt you across five states: `DEEP_FOCUS`, `HIGH_VELOCITY_EXECUTION`, `EXPLORATORY_LEARNING`, `MAINTENANCE_SURFACING`, `REST_RECOVERY`.
- **Active Inference:** a small discrete generative model (A, B, C, D tables learned from the event log) scores policies by expected free energy.
- **Approvals:** Android Keystore keys with BiometricPrompt, verified on the host through the attestation chain. Single-use tokens prevent replay.

Full detail: [`docs/ARCHITECTURE_V3.md`](docs/ARCHITECTURE_V3.md).

## Quick start

```powershell
pnpm install

pnpm typecheck      # tsc across all workspaces
pnpm test           # all suites
pnpm exo status     # system status
pnpm exo help       # list CLI commands
```

Run the host (needs secrets; copy values into `apps/daemon/.env`, which is gitignored and loaded automatically):

```powershell
$env:GATEWAY_JWT_SECRET   = "<32+ random characters>"
$env:GATEWAY_ENROLL_TOKEN = "<random>"
$env:TRIAD_SERVER_TOKEN   = "<random>"
cd apps\daemon
npx tsx src/mishmash-up.ts   # window 1: triad :8789, registry :39403, other nodes
pnpm start                   # window 2: gateway :8788
pnpm enroll -- "My Phone"    # enroll a device, prints its token
```

To exercise the whole approval path on real hardware, follow [`docs/DEVICE_TEST_RUNBOOK.md`](docs/DEVICE_TEST_RUNBOOK.md).

## Honest limits

- BiometricPrompt, the Keystore key and the Android attestation chain have not yet been run on hardware. Expect to debug them.
- Firebase/FCM credentials are gitignored and must be supplied locally.
- Nothing here has measured prediction quality against real data yet.

## Roadmap

Sub-project 1 of 4 (shadow metrics evaluator) is shipped. Remaining:

2. Daemon logs shadow proposals.
3. Label capture from taps and observed behaviour.
4. Precision@surface calibration (target >= 0.90) before any tier leaves shadow mode.

Audit history and follow-ups: [`docs/AUDIT_FOLLOWUP_PLAN_2026-10-09.md`](docs/AUDIT_FOLLOWUP_PLAN_2026-10-09.md).

## Docs

- [`docs/ARCHITECTURE_V3.md`](docs/ARCHITECTURE_V3.md): schema, event pipeline, world model math
- [`docs/DEVICE_TEST_RUNBOOK.md`](docs/DEVICE_TEST_RUNBOOK.md): phone-to-triad approval test
- [`docs/AUDIT_FOLLOWUP_PLAN_2026-10-09.md`](docs/AUDIT_FOLLOWUP_PLAN_2026-10-09.md): audit follow-ups

Private repository. Not licensed for redistribution.
