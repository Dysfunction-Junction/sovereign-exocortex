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

`exo status` and `exo world` read live daemon state. Set `EXOCORTEX_ADMIN_TOKEN` to a valid device JWT whose device has the `admin:read` scope; the daemon URL defaults to `http://127.0.0.1:8788` and can be overridden with `EXOCORTEX_DAEMON_URL`.

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

The phone reaches the daemon over Tailscale (`tailscale serve --bg 8788`). To exercise the whole approval path on real hardware, follow [`docs/DEVICE_TEST_RUNBOOK.md`](docs/DEVICE_TEST_RUNBOOK.md).

## Honest limits

- The approve and dismiss paths (BiometricPrompt, Keystore key, attestation, Tailscale HTTPS) were run end to end on a Galaxy S26 Ultra on 2026-10-10. Only the read-only `diagnostic_probe` has been approved; nothing has executed.
- Firebase/FCM credentials are gitignored and must be supplied locally.
- Nothing here has measured prediction quality against real data yet.

## Roadmap

Shadow calibration is four sub-projects:

1. Shadow metrics evaluator (`packages/core/src/shadow-report-cli.ts`). Shipped.
2. Daemon records shadow proposals and gate decisions (`apps/daemon/src/shadow-recorder.ts`). Code shipped, **but nothing feeds it yet**: only `POST /world-model/observation` triggers it, and no component calls that route, so no real proposal has been recorded.
3. Label capture from taps (`POST /v3/shadow/labels`, approve/dismiss in the app). Shipped and verified on hardware with test proposals. The inferred labels (`already_did`, `ignored`) are not built.
4. Precision@surface calibration (target >= 0.90, at least 50 tapped labels) before any tier leaves shadow mode. Waiting on real proposals.

Alongside these, a **next-action prediction log** records guesses about what you will do next, scores them against the event log (misses keep the real action), and reports log loss, Brier score and calibration against a frequency baseline. It does not feed Precision@surface. See [`docs/superpowers/specs/2026-10-10-next-action-prediction-design.md`](docs/superpowers/specs/2026-10-10-next-action-prediction-design.md).

Audit history and follow-ups: [`docs/AUDIT_FOLLOWUP_PLAN_2026-10-09.md`](docs/AUDIT_FOLLOWUP_PLAN_2026-10-09.md).

## Docs

- [`docs/ARCHITECTURE_V3.md`](docs/ARCHITECTURE_V3.md): schema, event pipeline, world model math
- [`docs/DEVICE_TEST_RUNBOOK.md`](docs/DEVICE_TEST_RUNBOOK.md): phone-to-triad approval test
- [`docs/AUDIT_FOLLOWUP_PLAN_2026-10-09.md`](docs/AUDIT_FOLLOWUP_PLAN_2026-10-09.md): audit follow-ups

Private repository. Not licensed for redistribution.
