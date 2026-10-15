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

- **Living Life Graph:** entities (people, projects, devices, routines) with decaying activation and spreading activation across weighted edges, projected live to the mobile companion via the Ambient Living Graph HUD.
- **Cognitive Mode Gate:** filters what may interrupt you across five states: `DEEP_FOCUS`, `HIGH_VELOCITY_EXECUTION`, `EXPLORATORY_LEARNING`, `MAINTENANCE_SURFACING`, `REST_RECOVERY`.
- **Pre-Cognitive Dynamic Wake:** empirical $p_{20}$ wake-quantile estimation and touch-dwell velocity calibration ([`AnticipationRing.tsx`](apps/mobile/src/components/AnticipationRing.tsx)) anticipating intention before full interaction completion.
- **Active Inference:** a small discrete generative model (A, B, C, D tables learned from the event log) scores policies by expected free energy.
- **Approvals:** Android Keystore keys with BiometricPrompt, verified on the host through the attestation chain. Single-use tokens prevent replay.
- **Autonomic Databank Archival:** scheduled background memory lifecycle daemon ([`databank-archival-host.ts`](apps/daemon/src/databank-archival-host.ts)) with vault health caching, 7-day retention safety floor, and atomic pre-prune backups.

### Adaptive foundation

The adaptive layer ranks existing policy candidates; it does not invent executable commands or change their risk, urgency, confidence, or approval requirements. Recorded ordering is preserved within each proposal batch when staging and listing pending proposals, without altering approval nonces or action payloads. Supported observations share a validated mapping for live learning and event replay. The existing life graph supplies decayed, spreading-activation context rather than a second graph store.

Verified `wanted`/`not_wanted` tap labels teach proposal preferences, not action-success or execution transitions. Predictions are recorded before feedback so usefulness can be compared with a simple baseline without training on the answer. Inferred outcome labels (`already_did`, `ignored`) are tracked asynchronously by the `InferredOutcomeScheduler` for coverage and focus-regret analysis without contaminating direct precision weights. When neither usable learned scores nor verified preferences distinguish candidates, deterministic policy ordering is retained. These diagnostics do not replace the Precision@surface rollout gate or disable shadow mode; no trained neural network or new external service is required.

Full detail: [`docs/ARCHITECTURE_V3.md`](docs/ARCHITECTURE_V3.md).

## Quick start

```powershell
pnpm install

pnpm -r typecheck   # tsc across all 11 workspaces (0 errors)
pnpm test           # all test suites (daemon, mobile, triad)
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

- The approve and dismiss paths (BiometricPrompt, Keystore key, attestation, Tailscale HTTPS) were verified end to end on a Galaxy S26 Ultra. Only the read-only `diagnostic_probe` has been approved; nothing has actuated unattended.
- The mobile companion runs live on Galaxy S26 Ultra with active Obsidian Glass Anticipation Ring and Ambient Graph HUD.
- Firebase/FCM credentials are gitignored and must be supplied locally.
- Continuous shadow evaluation is gathering empirical data toward the 50-label statistical threshold.

## Roadmap

Shadow calibration and the autonomic substrate are organized into five streams:

1. **Shadow metrics evaluator** (`packages/core/src/shadow-report-cli.ts`). Shipped.
2. **Daemon shadow recording & repository health** (`apps/daemon/src/shadow-recorder.ts`, `apps/daemon/src/repo-health.ts`). Explicit test-suite, clean-checkout, and bridge-health observations feed the gated inference loop. The automated `RepoHealthWatcher` tracks git checkout cleanliness (`clean_checkout` vs `uncommitted_edits`, 2-minute dirty dwell debounce, 15-minute homeostatic heartbeat, index lock isolation). Shipped.
3. **Label capture & inferred outcomes** (`POST /v3/shadow/labels`, `apps/daemon/src/inferred-outcomes.ts`). Hardware-attested tap labels (`wanted`/`not_wanted`) advance shadow state. Background inferred outcome scheduler captures `already_did` and `ignored` for coverage analysis. Shipped.
4. **Symbiosis Trinity: Precognitive Wake, Ambient Graph HUD & Databank Archival** (`apps/mobile`, `apps/daemon/src/databank-archival-host.ts`). Guided 5-step touch-dwell calibration (80ms–800ms window), live Ambient Living Graph HUD with cognitive mode indicators, and scheduled memory vault archival with 7-day retention safety floor and atomic backup. Shipped.
5. **Frontier 3 Morphogenetic Code** (`packages/triad/triad/morphogenetic.py`). Darwinian mutation engine executing isolated trial evaluations in ephemeral worktrees, runtime friction interception, automated apoptosis of broken patches, and pristine git state preservation. Shipped.
6. **Precision@surface calibration** (target >= 0.90 over 14 days, at least 50 direct tap labels, plus positive baseline gap) before any tier leaves shadow mode. Waiting for live collection; see [`docs/SHADOW_EVALUATION_RUNBOOK.md`](docs/SHADOW_EVALUATION_RUNBOOK.md).

Alongside these, a **next-action prediction log** records guesses about what you will do next, scores them against the event log (misses keep the real action), and reports log loss, Brier score and calibration against a frequency baseline. See [`docs/superpowers/specs/2026-10-10-next-action-prediction-design.md`](docs/superpowers/specs/2026-10-10-next-action-prediction-design.md).

Local model integration is supported via Ollama (`http://127.0.0.1:11434`) using `qwen2.5-coder:7b` (for line-by-line code audits and security review), `qwen3:4b` (reasoning), and `qwen3:1.7b` (fast triage), connected directly into the VS Code Language Model provider API with $0 cloud cost.

Audit history and follow-ups: [`docs/AUDIT_FOLLOWUP_PLAN_2026-10-09.md`](docs/AUDIT_FOLLOWUP_PLAN_2026-10-09.md).

## Docs

- [`docs/ARCHITECTURE_V3.md`](docs/ARCHITECTURE_V3.md): schema, event pipeline, world model math
- [`docs/DEVICE_TEST_RUNBOOK.md`](docs/DEVICE_TEST_RUNBOOK.md): phone-to-triad approval test
- [`docs/SHADOW_EVALUATION_RUNBOOK.md`](docs/SHADOW_EVALUATION_RUNBOOK.md): shadow mode calibration & baseline gap evaluation
- [`docs/AUDIT_FOLLOWUP_PLAN_2026-10-09.md`](docs/AUDIT_FOLLOWUP_PLAN_2026-10-09.md): audit follow-ups
- [`docs/DATABANK_ARCHITECTURE.md`](docs/DATABANK_ARCHITECTURE.md): encrypted long-term cold archive specification

Private repository. Not licensed for redistribution.

