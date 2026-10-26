# Sovereign Exocortex

A local-first personal assistant and automation research project. It watches signals from your phone and PC, predicts useful next actions, and stages proposals. Verified human approval is the intended boundary for execution; the implementation gaps below mean this is not yet a system-wide guarantee.

> **Status: experimental; shadow mode by default.** `SHADOW=1` blocks the primary approval path, but generic delegation can bypass gateway approval checks. Keep deployment restricted to trusted devices and networks and address these gaps before enabling live actuation. Live Precision@surface results were not verified during the source audit.

## Design intent

1. **Shadow first.** Actuation is a capability granted per risk tier, never a build flag.
2. **One append-only event log is the source of truth.** The life graph, beliefs and caches are projections rebuilt from it (hash-chained SQLite, WAL mode).
3. **Deterministic core.** Models propose; a typed policy engine decides. No LLM sits in the gate or approval path.
4. **Capabilities, not trust.** Every device and agent holds scoped, revocable grants.
5. **Honest naming.** A component named for a method must implement it, or be renamed.

Non-goals: self-patching production code and multi-user support. Local-first is not offline-only: configured reasoning providers, Mem0, Gmail, Notion, push delivery, and remote archives can use network services. The channel air-gap policy is not a system-wide network sandbox.

## Layout

pnpm workspace with 13 projects including the root: primarily TypeScript, plus Python 3.10+ for the triad and Rust/Tauri for desktop. Use Node 24+: some workspace packages require it even though the root manifest still says Node 22.

| Path | Package | What it does |
|---|---|---|
| `apps/daemon` | `@exocortex/daemon` | `exocortexd` host: gateway on `:8788`, device enrollment and scoped grants, JWT auth, attestation checks, shadow recorder, FCM push, mesh launcher and sentinel |
| `apps/mobile` | `@exocortex/mobile` | Capacitor Android app: accessibility capture, on-device triage, biometric approval modal, QR-based first-time pairing (`pairing.ts`, `PairingPlugin.java`) for standalone installs outside the desktop shell. As of 2026-10-25 this is the sole mobile app client — a formerly separate copy in a sibling repo sharing the same Android `appId` has been retired. |
| `apps/desktop` | `@exocortex/desktop` | Windows-targeted Tauri shell sharing the mobile/web frontend, with tray integration and local daemon discovery |
| `apps/cli` | `@exocortex/cli` | `exo` command: `status`, `world`, `memory`, `gate`, `test` |
| `apps/neo4j-import` | — | Standalone Neo4j import and graph evaluation utilities |
| `packages/core` | `@exocortex/core` | Event bus, pattern analyzer, speculative dry-run cache, pre-cognitive readiness |
| `packages/world-model` | `@exocortex/world-model` | Living Life Graph, Cognitive Mode Gate, Active Inference engine |
| `packages/memory` | `@exocortex/memory` | Local long-term memory (token/vector overlap store) |
| `packages/databank` | `@exocortex/databank` | Encrypted cold archive with text search and vector indexing |
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

The daemon also includes Obsidian, Notion, and Gmail channel adapters and Neo4j synchronization. Channel ingestion currently writes directly to the in-memory graph rather than the event log, so it is not yet a fully replayable projection.

## Quick start
Install Node 24+ and pnpm. Python tests require an activated virtual environment with `packages/triad` and its development dependencies installed. Desktop builds additionally require Rust and the Tauri prerequisites; Android builds require the Android toolchain.

```powershell
pnpm install
pnpm typecheck     # available workspace checks; Python is explicitly skipped
pnpm test          # configured suites; currently has known failures
pnpm exo help       # list CLI commands
```

`exo status` and `exo world` read live daemon state. Set `EXOCORTEX_ADMIN_TOKEN` to a valid device JWT whose device has the `admin:read` scope; the daemon URL defaults to `http://127.0.0.1:8788` and can be overridden with `EXOCORTEX_DAEMON_URL`.

### Host configuration

The daemon package start script loads `apps/daemon/.env`. Supply credentials locally; never commit them:

- `GATEWAY_JWT_SECRET`: required signing secret; use at least 32 random characters.
- `HOME_PROXY_BASE_URL`: required URL of a separately running home proxy, commonly on port 8787.
- `HOME_PROXY_TOKEN`: required bearer credential for that proxy.
- `GATEWAY_ENROLL_TOKEN`: required to enable device enrollment.
- `TRIAD_SERVER_TOKEN`: required on both gateway and triad for delegated triad calls.
- `SHADOW=1`: retain the default while calibrating and addressing safety gaps.

The home proxy is **not included in this repository**. Normal daemon startup currently requires its URL and token even for local world-model use.

From the repository root:

```powershell
pnpm --filter @exocortex/daemon start
```

In another terminal:

```powershell
pnpm --filter @exocortex/daemon enroll -- "My Phone"
pnpm --filter @exocortex/mobile dev
```

The root `pnpm start` currently points to the missing `apps/daemon/src/index.ts`; use the daemon package script above. Desktop development also needs a configuration fix: `apps/desktop/src-tauri/tauri.conf.json` invokes `pnpm dev` from the desktop package, recursively launching Tauri instead of starting the mobile Vite frontend.

### Optional services

The mesh launcher expects sibling checkouts named `hermes-api`, `autonomous-triad`, `pieces-for-all`, `agent-mesh-mcp`, `pattern-analyzer`, `registry-app`, `gut-instinct`, and `tool-registry-heartbeat`. Embedded packages do not automatically replace these repositories; see [`mishmash-nodes.ts`](apps/daemon/src/mishmash-nodes.ts).

```powershell
pnpm --filter @exocortex/daemon exec tsx --env-file-if-exists=.env src/mishmash-up.ts
pnpm desktop:build
```

Once those sibling checkouts exist, `apps/daemon/ops/supervisor.ts` can start/stop/restart/status-check all 9 services (this daemon plus the 8 above) as a group, and two scheduled tasks (`MeshSupervisorStartup`, `MeshSupervisorWatchdog`) can keep them running automatically at boot and restart anything that dies. See [`docs/SETUP_GUIDE.md`](docs/SETUP_GUIDE.md#6-optional-the-wider-local-mesh).

The phone reaches the daemon over Tailscale (`tailscale serve --bg 8788`). To exercise the whole approval path on real hardware, follow [`docs/DEVICE_TEST_RUNBOOK.md`](docs/DEVICE_TEST_RUNBOOK.md).

## Honest limits

- Earlier documentation reports Galaxy S26 Ultra approval/dismiss testing limited to the read-only `diagnostic_probe`. Hardware operation and current collection progress were not revalidated in this source audit.
- Firebase/FCM credentials are gitignored and must be supplied locally.
- Generic `/network/delegate` can forward triad approvals without the shadow, circuit-breaker, biometric, and scope checks used by `/network/approve`. A mocked test reproduced gateway forwarding, not downstream execution.
- Cold-start model hydration is conditional on an already-open database; normal imports construct the world-model host before database initialization.
- Memory capture writes `loggedAt`, but archival filters on `createdAt`, silently retaining captured entries instead of archiving them.
- Gmail/Notion entity IDs do not match the channel purge prefix, so disconnect/resync leaves stale graph entities.
- Morphogenetic trials isolate files in worktrees, not execution privileges or networking. The architecture's full sandbox, reproduction-test, diff-size, and static/security gates are not all implemented.

### Validation snapshot (2026-10-22)

- Workspace TypeScript checks passed. Python is skipped by its typecheck script; desktop Rust and standalone Neo4j utilities are not covered.
- Separately running the configured non-Python suites produced 1,139 passing and 13 failing tests: one world-model contact fixture uses the old operator ID; 12 mobile API tests omit `isDesktopApp` from their config mock.
- Mobile lint failed with one conditional-Hook error and 20 warnings. Its production build passed, with a roughly 1.83 MB main JavaScript bundle before compression.
- Python tests, native desktop/Android builds, real integrations, and live rollout metrics were not verified. Passing package tests do not establish cross-service safety.

## Roadmap

Implemented components and remaining evaluation work:

1. **Shadow metrics evaluator** (`packages/core/shadow-report-cli.ts`).
2. **Daemon shadow recording & repository health** (`apps/daemon/src/shadow-recorder.ts`, `apps/daemon/src/repo-health.ts`). Test-suite, checkout, and bridge-health observations feed the inference loop.
3. **Label capture & inferred outcomes** (`POST /v3/shadow/labels`, `apps/daemon/src/inferred-outcomes.ts`). Direct tap labels and inferred outcomes are tracked separately.
4. **Wake calibration, graph HUD & archival** (`apps/mobile`, `apps/daemon/src/databank-archival-host.ts`). Interfaces and scheduling exist; the archival record contract needs correction.
5. **Experimental code-repair trials** (`packages/triad/triad/morphogenetic.py`). Worktree-based candidate evaluation; documented production safety gates remain incomplete.
6. **Precision@surface calibration** (target >= 0.90 over 14 days, at least 50 direct tap labels, plus positive baseline gap) before any tier leaves shadow mode. Waiting for live collection; see [`docs/SHADOW_EVALUATION_RUNBOOK.md`](docs/SHADOW_EVALUATION_RUNBOOK.md).

Alongside these, a **next-action prediction log** records guesses about what you will do next, scores them against the event log (misses keep the real action), and reports log loss, Brier score and calibration against a frequency baseline. See [`docs/superpowers/specs/2026-10-10-next-action-prediction-design.md`](docs/superpowers/specs/2026-10-10-next-action-prediction-design.md).

Local inference integrations include Ollama. Other reasoning paths use subscription CLIs or OpenRouter; the embedded memory gateway defaults to OpenRouter unless configured otherwise. Offline behavior, model availability, and cost depend on configuration. This repository does not establish a universal zero-cloud-cost or VS Code provider guarantee.

Audit history and follow-ups: [`docs/AUDIT_FOLLOWUP_PLAN_2026-10-09.md`](docs/AUDIT_FOLLOWUP_PLAN_2026-10-09.md).

## Docs

- [`docs/SETUP_GUIDE.md`](docs/SETUP_GUIDE.md): start-from-nothing onboarding — install, configure, pair a phone, verify end-to-end, plus known pitfalls (port collisions, the retired duplicate mobile app)
- [`docs/USER_MANUAL.md`](docs/USER_MANUAL.md): operator manual once the system is running — architecture, telemetry pipelines, cognitive core, security model, port/service health-check matrix, mesh supervisor
- [`docs/ARCHITECTURE_V3.md`](docs/ARCHITECTURE_V3.md): schema, event pipeline, world model math
- [`docs/DEVICE_TEST_RUNBOOK.md`](docs/DEVICE_TEST_RUNBOOK.md): phone-to-triad approval test
- [`docs/SHADOW_EVALUATION_RUNBOOK.md`](docs/SHADOW_EVALUATION_RUNBOOK.md): shadow mode calibration & baseline gap evaluation
- [`docs/AUDIT_FOLLOWUP_PLAN_2026-10-09.md`](docs/AUDIT_FOLLOWUP_PLAN_2026-10-09.md): audit follow-ups
- [`docs/DATABANK_ARCHITECTURE.md`](docs/DATABANK_ARCHITECTURE.md): encrypted long-term cold archive specification

License: [MIT](LICENSE), matching the checked-in license and root package metadata.

