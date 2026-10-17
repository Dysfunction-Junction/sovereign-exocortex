# Hermes Handoff: Sovereign Exocortex — Tracks 3 & 4 Shipped (2026-10-17)

**Date:** October 17, 2026  
**Commit:** `58c8161` (`origin/main`)  
**Scope:** Batch 3 & 4 — Empirical App Transition Matrix via `UsageStatsManager` (Track 3) & Clipboard Intent Extraction via Private Compute Core / `TextClassifier` (Track 4)

---

## 1. Accomplishments & Architecture

### Track 3: Empirical App Transition Matrix via `UsageStatsManager`
- **Native Android Outbox & Ring Buffer:**
  - [UsageSummary.java](file:///C:/Users/micha/projects/sovereign-exocortex/apps/mobile/android/app/src/main/java/com/pieces/android/companion/UsageSummary.java): Captures ordered foreground transition sequences $(A \to B)$ and dwell durations between distinct apps. Employs an in-memory ring buffer of the most recent 30 transitions per window to preserve high-velocity bursts without dropping edges.
  - [NativeTelemetrySync.java](file:///C:/Users/micha/projects/sovereign-exocortex/apps/mobile/android/app/src/main/java/com/pieces/android/companion/NativeTelemetrySync.java): Serializes transitions and switch counts into `APP_TRANSITIONS` events dispatched through the local SQLite outbox queue.
- **Core Markov Engine:**
  - [app-transitions.ts](file:///C:/Users/micha/projects/sovereign-exocortex/packages/core/app-transitions.ts): Implements `AppTransitionMarkov` with:
    - Laplace add-$\alpha$ smoothing: $P(\text{to} \mid \text{from}) = \frac{\text{count} + \alpha}{\text{totalOut} + \alpha(|V| - 1)}$ (excluding self-transitions).
    - Dwell-observed denominator tracking for accurate quick-bounce rate calculations without skew from dwell-less imports.
    - Constant-time `addCount` helper eliminating matrix import loops.
    - Prototype-pollution-safe JSON exports (`Object.create(null)`).
    - Deterministic tie-breaking on prediction rankings (count $\to$ dwell $\to$ alphabetical).
- **World Model Semantic Hydration:**
  - [graph-linker.ts](file:///C:/Users/micha/projects/sovereign-exocortex/packages/world-model/graph-linker.ts): Maps transitions into `CONTEXT_STATE` app nodes (`app_<pkg>`) connected by `TRANSITIONS_TO` edges with dwell-weighted edge reinforcement.
- **Cognitive Attentional Mode Gating:**
  - [cognitive-gate.ts](file:///C:/Users/micha/projects/sovereign-exocortex/packages/world-model/cognitive-gate.ts): Dynamically triggers `HIGH_VELOCITY_EXECUTION` when rapid recent transitions ($\ge 3$ transitions with $\ge 2$ quick bounces $<10\text{s}$ in the last 15 minutes) are observed, even if the device was previously stationary or idle.

### Track 4: Clipboard Intent Extraction & Security Hardening
- **Lifecycle & Privacy-Preserving Capture:**
  - [PiecesAccessibilityService.java](file:///C:/Users/micha/projects/sovereign-exocortex/apps/mobile/android/app/src/main/java/com/pieces/android/companion/PiecesAccessibilityService.java): Registered on-device `ClipboardManager.OnPrimaryClipChangedListener` in `onServiceConnected` and cleaned up in `onDestroy`.
  - **Android 13+ (API 33+) `ClipDescription.EXTRA_IS_SENSITIVE` Rejection:** Password manager copies and sensitive entry fields are dropped immediately.
  - **Pre-Hash Secret Rejection:** Heuristic filtering drops bearer tokens, GitHub PATs (`ghp_`), OpenAI API keys (`sk-`), private keys, and high-entropy strings *before* hashing or storing any clipboard fingerprint.
  - **PII Hashing:** Phone numbers and email addresses are cryptographically hashed with salted SHA-256 before disk persistence or network transmission.
- **On-Device Entity & Action Recognition:**
  - Fast-path deterministic regex matching for UPS, USPS, and FedEx tracking numbers (`track_package`), URLs (`open_link`), emails (`compose_email`), and phones (`dial_number`), with graceful fallback to on-device `TextClassifier` for calendar dates, locations, and flights.
- **Living Life Graph Resolution:**
  - [life-graph.ts](file:///C:/Users/micha/projects/sovereign-exocortex/packages/world-model/life-graph.ts): Added first-class `INTENT` entity type to `EntityType`.
  - [graph-linker.ts](file:///C:/Users/micha/projects/sovereign-exocortex/packages/world-model/graph-linker.ts): Resolves clipboard events into `INTENT` entities with collision-proof deterministic hashes and connects them to context via `REFERENCES` edges, cleanly plumbing `EXECUTE_INTENT` recommendations.
- **Attentional Glass Surfacing:**
  - [cognitive-gate.ts](file:///C:/Users/micha/projects/sovereign-exocortex/packages/world-model/cognitive-gate.ts): Enforces a 60-second intent TTL freshness window, requires exact normalized action matching, respects risk caps, and immediately surfaces actionable 1-tap Obsidian Glass modals while preserving true proposal confidence scores.

---

## 2. Verification & Testing

- **TypeScript Typecheck:**
  - `pnpm typecheck`: 0 errors across all 11 workspace packages.
- **Android Compilation:**
  - `cmd /c "gradlew.bat compileDebugJavaWithJavac"` in `apps/mobile/android`: `BUILD SUCCESSFUL` (0 errors).
- **Test Suite Results:**
  - `@exocortex/core`: 175 / 175 tests passing (100%).
  - `@exocortex/world-model`: 113 / 113 tests passing (100%).
  - `apps/daemon`: 170 / 170 tests passing (100%).
  - `apps/mobile`: 149 / 149 tests passing (100%).
- **Autonomous Triad Diff Review (`advisor.py`):**
  - All high-severity and architectural critique points (dwell denominator mismatch, sorting determinism, prototype safety, transition ring buffer, intent freshness TTL, exact action matching, collision-proof hashing, and pre-hash credential checks) were directly resolved and validated.
- **Git Commit:**
  - Commit `58c8161` pushed to `origin/main`.

---

## 3. Shadow Proposal Biometric Review & Live Actuation Alignment (Hotfix)

- **Root Cause Analysis:**
  - `apps/daemon/src/server.ts` line 1533 enforces `if (db.getProposal(proposalId)?.shadow === 1)` rejecting `/network/approve` with HTTP 423 (`"shadow proposal cannot be approved, even when live actuation is enabled"`).
  - However, `/v3/proposals/pending?include_shadow=1` previously merged `live` and `shadowProposals` using `liveIds.has(sp.proposalId)`. Because `buildPendingProposals()` in `pending-proposals.ts` omitted `shadow: true` and set `requiresBiometric: true`, shadow proposals leaked into the live list without the shadow flag.
  - The mobile companion app interpreted them as live biometric actuation proposals (`🔒 Biometric Required`), displayed a biometric authorization prompt, and submitted to `/network/approve`, triggering the 423 error.
  - Additionally, `surfaceTestProposal()` in `apps/daemon/src/dev-tools.ts` hardcoded `shadow: 1`, preventing operator end-to-end device approval testing even with `$env:SHADOW = "0"`.
- **Architectural Resolution:**
  - **Daemon Route Partitioning (`apps/daemon/src/server.ts`):** `GET /v3/proposals/pending?include_shadow=1` now authoritatively partitions shadow proposals, ensuring every SQLite `shadow === 1` row is delivered with `shadow: true` and `requiresBiometric: false`.
  - **423 Guard Error Details (`apps/daemon/src/server.ts`):** Added `code: "SHADOW_PROPOSAL_LABEL_ONLY"` and `label_endpoint: "/v3/shadow/labels"` to clearly instruct clients that shadow proposals are calibration-only and must be labeled rather than approved.
  - **Operator Surface Testing (`apps/daemon/src/dev-tools.ts`):** `surfaceTestProposal()` now respects `process.env.SHADOW === "0"` (creating `shadow: 0` proposals that can be live-actuated in testing) and supports an explicit `options.shadow` parameter.
  - **Mobile Client Auto-Recovery (`apps/mobile/src/lib/proposals.ts`):** Added a defensive fallback in `proposalManager.approve()` and `reject()`: if a 423 shadow error is ever returned from `/network/approve`, it converts the proposal to `shadow = true` and seamlessly routes to `labelWanted()`/`labelNotWanted()`, writing the shadow label to `/v3/shadow/labels` without error.
- **Verification:**
  - `@exocortex/daemon`: 173 / 173 tests passing (including 2 new regression tests).
  - `@exocortex/mobile`: 150 / 150 tests passing (including new 423 recovery regression test).
  - Full TypeScript typecheck: 0 errors across workspace.

---

## 4. PC Command Center Web Dashboard & 3D WebGL Living Brain Visualizer

- **Motivation & Goal:**
  - The phone app contained rich telemetry, anticipation ring, and cognitive HUD interfaces, but the ecosystem lacked a dedicated, responsive PC desktop dashboard.
  - The user requested an automatic pipeline to visualize collected telemetry in a "living brain" model (prior to Neo4j ingestion).
- **Architectural Implementation:**
  - **3D WebGL Force-Directed Brain Canvas (`apps/mobile/src/pages/LivingBrain.tsx`):**
    - High-performance Three.js + `3d-force-graph` visualization.
    - Entities colored by semantic type (`PERSON` = orange, `PROJECT` = electric cyan, `DEVICE` = purple, `GOAL` = emerald green, `ROUTINE` = rose, `CONTEXT_STATE` = gold, `TOPIC` = teal, `DOC` = slate).
    - Node size and outer glowing auras dynamically scaled by real-time spreading activation $(2.5 + \text{activation} \times 10)$.
    - Directed synapses with particle flows traveling along active edges.
    - Top floating control bar: live connection indicator, cognitive mode badge, node search with auto-focus camera tweening, category filter chips, and auto-orbiting controls.
    - Slide-out node inspection drawer: displays entity details, activation gauge, connected neighbors, and a 1-click "Inspect in Neo4j" button with copyable Cypher queries.
    - Full resource lifecycle: `ResizeObserver` container sizing and WebGL destructor cleanup on unmount.
  - **PC Command Center Responsive Layout (`apps/mobile/src/components/Layout.tsx` & `index.css`):**
    - Desktop Topbar Header at $\ge 900\text{px}$: Brand title, PC Command Center subtitle, persistent navigation buttons with active states, and real-time status pill.
    - Expands viewport container to $1300\text{px}$ on desktop (or $100\%$ viewport height for `/brain`), while preserving the compact layout on mobile screens with bottom `TabBar`.
    - Smart `RootRedirect`: Inspects enrollment state on load to route unconfigured clients to `/setup` and configured nodes to `/status`.
  - **Daemon Streaming & Static Asset Serving (`apps/daemon/src/server.ts`):**
    - `GET /v3/world-model/graph/full`: Exports snapshot of all entities and edges with `admin:read` scope enforcement.
    - `GET /v3/world-model/graph/live`: Server-Sent Events (SSE) stream broadcasting real-time `pulse` events on each `linkEventToGraph` update, `init` state, and periodic `ping` keep-alives. Hardened with comprehensive disconnect listeners (`req.on("close")`, `res.on("close")`, `aborted`, `error`) to eliminate listener leaks.
    - Hardened static file serving: Serves built production bundle from `apps/mobile/dist` for `GET`/`HEAD` requests, with path traversal prevention (`relative`, `sep`, `\0` rejection), `X-Content-Type-Options: nosniff`, content-hashed immutable caching for `/assets/`, and SPA HTML fallback.
- **Verification:**
  - Full TypeScript typecheck: 0 errors across `@exocortex/daemon` and `@exocortex/mobile`.
  - Production build: `pnpm --filter @exocortex/mobile build` completes cleanly in $529\text{ms}$.
  - Daemon tests: 173 / 173 passing ($100\%$).
  - Mobile tests: 150 / 150 passing ($100\%$).
  - Autonomous Triad diff review: Addressed all critical security, traversal, memory leak, and disposable connection items.
  - Commit: `a503988` pushed to `origin/main`.

---

## 5. Neo4j Enterprise Living Brain Synchronization & Zero-Touch Auto-Discovery (Completed)

- **Localhost Zero-Touch Auto-Discovery (`apps/daemon/src/server.ts` & `apps/mobile/src/lib/config.ts`):**
  - Loopback-only `GET /mobile/local-config` route auto-enrolls `pc:dashboard` with `admin:read` + `admin:write` scopes and issues a 365-day HS256 JWT.
  - Desktop browsers opening the PC Command Center automatically self-configure against local proxy (:8787) and gateway (:8788) with zero prompts or tokens required.
  - Manual fallback buttons added to `Status.tsx` and `Setup.tsx`.
  - Commit: `a268144`.

- **Neo4j Enterprise Runtime Recovery & Historical Ingestion:**
  - Configured Zulu JRE 21 (`C:\Users\micha\.Neo4jDesktop2\Cache\runtime\zulu21.52.15-ca-jre21.0.12-win_x64`) to resolve Java 8 missing vector module error.
  - Created [neo4j-sync-cli.ts](file:///C:/Users/micha/projects/sovereign-exocortex/apps/daemon/src/neo4j-sync-cli.ts) and npm script `pnpm --filter @exocortex/daemon neo4j-sync`.
  - Replayed all 14,155 historical events from `C:\Users\micha\AppData\Local\exocortex.db`, importing 763 unique entities and 1,453 relationships in 2.6 seconds.
  - Applied secondary labels (`:Person`, `:Project`, `:Device`, `:Topic`, `:Goal`, `:ContextState`) on top of `:Entity` for native color coding in Neo4j Browser and Bloom.

- **Automated Continuous Real-Time Ingestion (`apps/daemon/src/neo4j-sync.ts`):**
  - Created `Neo4jSyncService` connecting to Neo4j transactional HTTP endpoint (`http://127.0.0.1:7474/db/neo4j/tx/commit`) with Basic auth (`neo4j:codecode`).
  - Automatically executes parameterized `MERGE` statements with schema constraints.
  - Wired `attachToHost(defaultWorldModelHost)` on daemon startup: subscribes to `onGraphUpdated` and debounces live subgraphs/pulses directly into Neo4j.
  - Added REST control routes: `GET /v3/world-model/neo4j/status` (admin:read) and `POST /v3/world-model/neo4j/sync` (admin:write).
  - All 179 daemon tests pass with 100% pass rate. Commit: `19e3644`.

- **3D Living Brain HUD Badge & Deep-Link Inspection (`apps/mobile/src/pages/LivingBrain.tsx`):**
  - Added live Neo4j indicator badge in top status HUD (`🟢 Neo4j: 763 nodes`) with continuous polling and one-click `↻` re-sync trigger.
  - Added `↗ Open in Neo4j Browser` to the node inspector drawer that opens `http://127.0.0.1:7474/browser/?cmd=edit&arg=...` with the pre-filled Cypher query.
  - All 154 mobile tests pass with 100% pass rate. Commit: `5c8439f`.

---

## 6. Active Ecosystem Processes & Ports

| Subsystem | Port | Process / Status | Notes |
|---|---|---|---|
| **Exocortex PC Dashboard** | `:5173` | Vite Dev Server (PID 41948) | PC Command Center & 3D Living Brain (`http://localhost:5173`) |
| **Exocortex Gateway Daemon** | `:8788` | Node/tsx `exocortexd` (PID 52768) | Gateway, World Model, Pre-Cognitive Engine, Neo4j continuous sync |
| **Pieces Android Proxy** | `:8787` | S4U Scheduled Task (PID 7288) | Loopback Plan A proxy forwarding to PiecesOS |
| **Neo4j Enterprise** | `:7687` (Bolt), `:7474` (HTTP) | Zulu JRE 21 (PID 38284) | Neo4j Enterprise 2026.09 ("Exocortex" dbms) |
| **PiecesOS Native** | `:39300` | `os_server.exe` | Pieces LTM database and REST API |
