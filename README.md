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

### Adaptive foundation

The adaptive layer ranks existing policy candidates; it does not invent executable commands or change their risk, urgency, confidence, or approval requirements. Supported observations share a validated mapping for live learning and event replay. The existing life graph supplies decayed, spreading-activation context rather than a second graph store.

Verified `wanted`/`not_wanted` tap labels teach proposal preferences, not action-success or execution transitions. Predictions are recorded before feedback so usefulness can be compared with a simple baseline without training on the answer. When neither usable learned scores nor verified preferences distinguish candidates, deterministic policy ordering is retained. These diagnostics do not replace the Precision@surface rollout gate or disable shadow mode; no trained neural network or new external service is required.

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
2. Daemon records shadow proposals and gate decisions (`apps/daemon/src/shadow-recorder.ts`). Explicit test-suite, clean-checkout, and bridge-health observations on the normal `POST /v3/events` stream feed the existing gated inference loop. The mobile app emits bridge-health observations on connectivity transitions during event uploads, and `exo test` appends actual local test-suite outcomes as host observations. Arbitrary telemetry is not treated as an invariant. This does not execute repairs or leave shadow mode. An automated repository-health producer (`apps/daemon/src/repo-health.ts`) tracks git checkout cleanliness across paths configured in `EXOCORTEX_WATCH_REPOS` (`clean_checkout` vs `uncommitted_edits`, 2-minute dirty dwell debounce, 15-minute homeostatic heartbeat, index lock isolation) and feeds invariant observations into the active inference engine (`EXOCORTEX_REPO_WATCH=0` disables).
3. Label capture from taps (`POST /v3/shadow/labels`, approve/dismiss in the app). Shipped and verified on hardware with test proposals. The inferred labels (`already_did`, `ignored`) are not built.
4. Precision@surface calibration (target >= 0.90 over 14 days, at least 50 direct tap labels, plus a positive baseline gap) before any tier leaves shadow mode. Waiting for live collection; see [`docs/SHADOW_EVALUATION_RUNBOOK.md`](docs/SHADOW_EVALUATION_RUNBOOK.md).

5. Graph storage decision: benchmark representative three-hop queries against the current in-memory adjacency graph before introducing Neo4j. Run `node apps/neo4j-import/src/graph-benchmark.mjs`; a live Neo4j comparison requires a separately configured local/server instance.

Alongside these, a **next-action prediction log** records guesses about what you will do next, scores them against the event log (misses keep the real action), and reports log loss, Brier score and calibration against a frequency baseline. It does not feed Precision@surface. See [`docs/superpowers/specs/2026-10-10-next-action-prediction-design.md`](docs/superpowers/specs/2026-10-10-next-action-prediction-design.md).

An initial local vision path is available for a screenshot you explicitly select on the PC: `pnpm --filter @exocortex/daemon vision-tests -- --confirm-nonsensitive-test-screenshot <screenshot-image>`. The required flag confirms that the selected file is a nonsensitive test-runner screenshot; the mobile app's package denylist cannot be applied to arbitrary PC files. It resizes the image in memory and sends it only to a localhost Ollama endpoint (`EXOCORTEX_VISION_URL`, default `http://127.0.0.1:11434/api/generate`; model via `EXOCORTEX_VISION_MODEL`, default `llava:latest`). It classifies test-runner screenshots only; high-confidence pass/fail results become ordinary observations and any resulting proposals are recorded with `shadow=1`. Low-confidence or unclear images are logged only as an untrusted classification and cannot generate proposals. Raw image bytes and model summaries are not stored. This explicit PC workflow does not capture phone screens or run in the background.

Audit history and follow-ups: [`docs/AUDIT_FOLLOWUP_PLAN_2026-10-09.md`](docs/AUDIT_FOLLOWUP_PLAN_2026-10-09.md).

## Docs

- [`docs/ARCHITECTURE_V3.md`](docs/ARCHITECTURE_V3.md): schema, event pipeline, world model math
- [`docs/DEVICE_TEST_RUNBOOK.md`](docs/DEVICE_TEST_RUNBOOK.md): phone-to-triad approval test
- [`docs/AUDIT_FOLLOWUP_PLAN_2026-10-09.md`](docs/AUDIT_FOLLOWUP_PLAN_2026-10-09.md): audit follow-ups

Private repository. Not licensed for redistribution.
