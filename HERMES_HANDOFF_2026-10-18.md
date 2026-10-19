# Sovereign Exocortex — Engineering Handoff (2026-10-18)

## 1. Disambiguation: What "Option 4" Refers To
In previous architectural roadmaps, **Option 4** referred to the **Cross-Repo Ecosystem Synchronization Workstream**:
- **Bear House Classic (`C:\Users\micha\projects\bear-house-classic`)**: FamilyOS platform (React 19 / Vite, Supabase Postgres RLS, Capacitor Android) with Home Assistant automation (`/api/ha-control`, `/api/ha-discover`) and Hermes Copilot.
- **2nd Helpings / Oakridge Cafeteria Menu Manager (`C:\Users\micha\projects\cafeteria-menu-manager`)**: School lunch menu aggregation, Google Sheets API synchronization, and automated daily nutrition delivery (`2ndhelpings.dysfunctionjunction.xyz`).
- **Status**: Intentionally deferred to focus 100% computational capacity and attention on the **Sovereign Exocortex** core monorepo.

---

## 2. Completed Workstreams (Options 1, 2, and 3)

### Workstream 1: Native Android Hardware Telemetry & Cognitive Gate Driving/Zen Safety
- **Native Android Collection (`NativeHardwareTelemetry.java`)**:
  - `collectFocusAndDnd()`: Queries `NotificationManager.getCurrentInterruptionFilter()`, mapping system Zen states (`ALL`, `PRIORITY`, `NONE`, `ALARMS`, `UNKNOWN`) and exposing `dnd_active: boolean`.
  - `collectAudio()`: Implemented priority-ranked audio routing:
    - `car_audio` (Priority 4): Detects `UiModeManager.getCurrentModeType() == UI_MODE_TYPE_CAR`, `AudioDeviceInfo.TYPE_BUS` (API 24+ automotive bus), or strict word-boundary vehicle infotainment names (`android auto`, `carplay`, `uconnect`, `carkit`, `sync 3`). Excludes common false positives ("USB Audio", "Audio", "Automatic").
    - `bluetooth_headset` (Priority 3): A2DP, SCO, BLE Headset, Hearing Aid.
    - `wired_headset` (Priority 2): 3.5mm jack, wired headphones, USB headset.
    - `speaker` (Priority 1): Built-in loudspeaker.
- **Cognitive Mode Gate Integration (`packages/world-model/cognitive-gate.ts`)**:
  - `classifyMode()`: Inactive screen state daytime DND triggers `DEEP_FOCUS`; night DND triggers `REST_RECOVERY`. Connected car audio infers `in_vehicle` motion unless explicitly stationary.
  - `evaluateProposal()`:
    - In-vehicle driving safety: Visual modals are suppressed into `BACKGROUND_QUEUE`; safe allowlisted actions are executed silently (`SILENT_AUTO_EXECUTE`); emergency urgency (≥ 0.95) breaches filter to `GLASS_MODAL`.
    - Native DND / Zen filter: Under `interruptionFilter === 'NONE'` (total silence), all proposals are queued. Under `PRIORITY`, emergency urgency is permitted.

### Workstream 2: Deep Neo4j Knowledge Graph Analytics & PC Command Center Query Bar
- **Daemon Knowledge Sync (`apps/daemon/src/neo4j-sync.ts`)**:
  - `getGraphAnalytics()`: Computes degree centrality hubs, stale entities (`lastActive` ordering), and entity/relationship type distributions. Cached with a 30-second TTL to avoid full-graph scan overhead.
  - `queryLivingGraph()`: Dual-mode query engine:
    - **Natural Language Mode**: Expands intent keywords (`projects`, `people`, `devices`, `topics`, `stale`, or search terms) into optimized Cypher MATCH statements.
    - **Cypher Mode**: Strictly read-only. Uses comment-stripping and string-literal sanitization (`sanitizeForScan`) to block mutation keywords (`CREATE`, `MERGE`, `DELETE`, `DETACH`, `SET`, `DROP`, `CALL`, etc.). Rejections throw `GraphQueryRejectedError` mapped to HTTP 400. Results capped at 200 rows.
- **HTTP Endpoints (`apps/daemon/src/server.ts`)**:
  - `GET /v3/world-model/neo4j/analytics`: Exposes graph metrics, protected by `admin:read`.
  - `POST /v3/world-model/neo4j/query`: Executes read-only queries with validation.
- **PC Command Center & Companion Dashboard (`apps/mobile/src/pages/LivingBrain.tsx`)**:
  - **"Brain Analytics & Query" Drawer**:
    - Central hubs chip list and stale entity list with clickable 3D camera fly-to focus.
    - Interactive query bar supporting Natural Language and direct Cypher with instant table rendering.
    - Full unicode escape integrity (`\u2715`, `\u2026`, `\u21BB`, `\u2713`) preventing mojibake.
    - Surfaceable error banner for 403 / syntax rejections.

### Workstream 3: Pre-Cognitive Speculative Action Pre-Warming
- **Markov App Transitions & Speculative Staging (`apps/daemon/src/precognitive-host.ts`)**:
  - Per-device `AppTransitionMarkov` models (`appMarkovByDevice`).
  - Strict prediction threshold: requires `smoothedProbability >= 0.35 && count >= 2`.
  - Pre-warms speculative proposals (`prop_precog_<device>_<app>`) into `preWarmedProposals` and updates readiness to `isPreStaged: true`.
  - Proposal expiry: automatically clears `isPreStaged: false` and `preStagedProposalId: undefined` when proposals age past `RECENCY_WINDOW_MS`.
  - Event deduplication via `processedPreWarmEventIds` bounded set.
- **Clipboard Intent Privacy Protection**:
  - Raw clipboard content (`snippet`/`value`) is strictly redacted from proposals, status objects, and logs.
  - Generates sanitized action labels: `Process clipboard <ENTITY_TYPE>` (allowlisted to `URL`, `CODE`, `TRACKING_NUMBER`, `ADDRESS`, `PHONE`, `EMAIL`, `TEXT`, `CLIPBOARD`).
- **Endpoints (`apps/daemon/src/server.ts`)**:
  - `GET /v3/precognitive/pre-warmed`: Returns currently pre-warmed speculative proposal with 0ms actuation latency.

### Workstream 4: Triad Fusion Monorepo Bug Audit & Hardening
- **Neo4j Cypher Label & Relationship Sanitization (`apps/daemon/src/neo4j-sync.ts`)**:
  - `labelForType()`: Hardened against Cypher injection, unescaped characters, and arbitrary inputs. Prefixes numeric-leading labels (e.g. `Type_123Numeric`, `Type_3D_MODEL`), caps at 48 chars, and preserves `"Generic"` fallback for backwards compatibility with existing nodes.
  - `safeRelType()`: Enforces regex `^[A-Z][A-Z0-9_]{0,48}$`, defaulting invalid or lowercase relations safely to `"RELATED"`.
  - `neo4j-sync.test.ts`: Added mock fetch interceptor for `/db/neo4j/tx/commit` preventing unhandled ECONNREFUSED when offline.
- **Cognitive Gate Hardware Telemetry Mapping (`packages/world-model/cognitive-gate.ts`)**:
  - `toBool()` parser: Strict boolean parser that avoids `Boolean()` coercion pitfalls where `null` becomes `false` and `"false"` evaluates truthy.
  - `normalizeInterruptionFilter()`: Strips `INTERRUPTION_FILTER_` prefixes, validates against strict enum `ALL | PRIORITY | NONE | ALARMS | UNKNOWN`, and safely returns `undefined` for unrecognized filters.
  - Derived `dndActive`: Accurately resolves `false` when `interruptionFilter === 'ALL'`.
- **Pre-Cognitive Telemetry Key Normalization & Deduplication (`apps/daemon/src/precognitive-host.ts`)**:
  - Key normalization: Ingests native Android keys (`transitions`, `app_transitions`, `clipboard_intent`, `clipboardIntent`).
  - Precedence: Uses `[...].find(Array.isArray)` so empty objects cannot shadow valid transition arrays.
  - Hash-Aware Deduplication: Added `hasNonZeroHash()` helper to deduplicate production events by SHA-256 hex while falling back cleanly on `seq` and timestamp for zero-hash test fixtures.
  - Fault Isolation: Isolated per-event pre-warming errors in inner `try/catch` to prevent malformed telemetry from crashing valid sibling batches.

---

## 3. Verification & Metrics
- **Tests**:
  - `@exocortex/daemon`: **184 / 184** tests passing (100%).
  - `@exocortex/world-model`: **116 / 116** tests passing (100%).
  - `@exocortex/core`: **175 / 175** tests passing (100%).
  - `@exocortex/mesh`: **326 / 326** tests passing (100%).
  - `@exocortex/memory`: **112 / 112** tests passing (100%).
  - `@exocortex/databank`: **33 / 33** tests passing (100%).
  - `@exocortex/mobile`: **154 / 154** tests passing (100%).
- **TypeScript**: **0** errors across all 11 packages and apps (`pnpm typecheck`).
- **Triad Advisory Review**: Fully reviewed and approved by the Autonomous Triad Advisory Council (`advisor.py` with Claude Pro / Codex failover) with zero token cost. All 5 advisory council refinements implemented and verified.
- **Git Commit**: `fix(exocortex): harden Cypher label sanitization, telemetry key normalization, and hardware signal mapping`.

---

## 4. Autonomous Triad Fusion Audit Runs (Completed Runs 1 - 4)

Across 4 consecutive Triad Fusion cycles, deep audits and surgical hardening were executed across the entire Sovereign Exocortex monorepo with Autonomous Triad advisory critique (`advisor.py`):

### Run 1 (Round 2 — Commit `6f7ee5c`):
- **Core Security & Telemetry Validation (`apps/daemon`)**:
  - Required explicit `telemetry:write` and `approval:write` cryptographic scopes on device attestations.
  - Hardened `dropKnownTelemetry` to prevent spoofing and replay attacks.
- **World Model Resilience (`packages/world-model`)**:
  - Guarded `LivingLifeGraph` against non-finite weights, edge probabilities, and NaN divergence in active inference policy evaluation.
- **Mobile Routing (`apps/mobile`)**:
  - Hardened navigation route parameters and deep link handling against corrupted payloads.

### Run 2 (Round 3 — Commit `c69ac81`):
- **P2P Mesh Network Hardening (`@exocortex/mesh`)**:
  - Enforced bounded peer discovery buffers, message envelope replay protections, and clock skew mitigation.
- **Databank Integrity (`@exocortex/databank`)**:
  - Hardened SQLite WAL mode transitions and transaction isolation under heavy background writes.
- **Semantic Memory Subsystem (`@exocortex/memory`)**:
  - Sanitized vector search inputs, embedding dimensionality checks, and cosine similarity NaN protection.

### Run 3 (Round 4 — Commit `68debd1`):
- **Decay Clocks (`packages/core/clocks.ts`)**:
  - Standardized `Number.isNaN` fail-closed decay and clarified `daysUntilExpiry` contracts.
- **CAS Proposal Transitions (`packages/core/db.ts`)**:
  - Implemented atomic compare-and-swap (CAS) transitions with `ProposalConcurrentModificationError`.
  - Permitted `SURFACED -> SUPPRESSED` transition while strictly blocking direct human bypass `GATED -> APPROVED`.
- **Replay Guards (`apps/mobile/src/lib/proposals.ts`)**:
  - Added synchronous in-flight action locks in `guardPendingProposal` and robust async concurrency guards.

### Run 4 (Round 5 — Commit `f6df55a`):
- **Cognitive Mode Gate Sanitization (`packages/world-model/cognitive-gate.ts`)**:
  - Out-of-range confidence (`> 1` or `< 0`) and risk (`< 0` or `> 1`) fail closed to `confidence: 0` and `risk: 1`.
  - Finite urgency is clamped to `[0, 1]` so emergency cutoffs (`>= 0.95`) are never suppressed by scaling anomalies.
  - Immutability: proposals and signals are shallow-cloned, preventing caller mutations from altering gate states or queued proposals.
  - Malformed proposal envelopes or missing IDs fail closed to `action: DROP`.
  - Queued proposals strictly sanitize `stagedAt`, `urgency`, `confidence`, and `estimatedRisk` to finite values.
- **Pending Proposals Payload Validation (`apps/daemon/src/pending-proposals.ts`)**:
  - Validates `actionPayload` before DB lookup: non-plain-objects (arrays, primitives, dates) fail closed by skipping the proposal.
  - Added deduplicated, sanitized warning logs (`JSON.stringify(proposalId)`).
- **State Matching Allowlist (`apps/daemon/src/inferred-outcomes.ts`)**:
  - `isStateMatching`: positive allowlist (`string`, `number`, `boolean`, `bigint`) prevents false string matches against objects, arrays (`[]`), functions, or `null`/`undefined`.

---

## 5. Final Ecosystem Verification & Test Metrics
- **Tests**:
  - `@exocortex/daemon`: **187 / 187** tests passing (100%).
  - `@exocortex/world-model`: **120 / 120** tests passing (100%).
  - `@exocortex/core`: **180 / 180** tests passing (100%).
  - `@exocortex/mesh`: **326 / 326** tests passing (100%).
  - `@exocortex/memory`: **112 / 112** tests passing (100%).
  - `@exocortex/databank`: **33 / 33** tests passing (100%).
  - `@exocortex/mobile`: **158 / 158** tests passing (100%).
- **TypeScript**: **0** compile errors across all 11 workspace packages (`pnpm typecheck`).
- **Triad Advisory Review**: Fully reviewed, refined, and approved by the Autonomous Triad Advisory Council (`advisor.py`).
- **All Remote Branches**: Synchronized on `origin/main`.

---

## 6. Native Desktop Application & Windows Installer Packaging (Tauri 2.0)

- **Desktop Workspace (`apps/desktop`)**:
  - Implemented **Tauri 2.0** architecture with Windows WebView2 hardware-accelerated WebGL 2.0 Direct3D ANGLE pipeline, consuming only ~40MB idle RAM (vs 250MB+ for Electron).
  - Native Win32 window (1440x900) hosting the 3D Living Brain interactive graph (`apps/mobile/dist`).
  - Native System Tray integration with `Show Living Brain` and `Quit Sovereign Exocortex`.
  - Close-to-tray handling: Closing the GUI hides the window while preserving 24/7 background telemetry and active inference event loop.
- **Compiled Binary Artifacts**:
  - Standalone NSIS Setup Installer: `apps/desktop/src-tauri/target/release/bundle/nsis/Sovereign Exocortex_1.0.0_x64-setup.exe` (2.41 MB).
  - Enterprise Windows Installer: `apps/desktop/src-tauri/target/release/bundle/msi/Sovereign Exocortex_1.0.0_x64_en-US.msi` (3.44 MB).
  - Portable Executable: `apps/desktop/src-tauri/target/release/app.exe`.
  - Monorepo scripts: `pnpm desktop:build` and `pnpm desktop:dev`.
- **Git Commit**: `feat(desktop): scaffold Tauri 2.0 native Windows desktop application and installer bundles` (`476b0d4`).

---

## 7. Zero-Config Desktop Architecture & Mobile Separation

- **Problem Identified**: The initial desktop build packaged the mobile companion frontend with default redirection to `/setup`, presenting Android-specific permissions (Accessibility Service, Android Notification Listener, SMS Backfill, Biometrics) and requiring manual proxy/gateway connection hurdles despite running locally on the PC where all data lives.
- **Architectural Separation**:
  - **Loopback Origin Allowance (`apps/daemon/src/server.ts`)**: Allowed `tauri.localhost` and exact loopback origins so Tauri's WebView2 auto-discovery `/mobile/local-config` succeeds over loopback without 403 origin blocks.
  - **Zero-Config Desktop Launch (`apps/mobile/src/App.tsx`, `apps/mobile/src/lib/config.ts`)**: Added `isDesktopApp()` helper. On desktop, the application defaults `isConfigured()` to `true` and launches directly into `/brain` (the 3D Living Brain interactive graph), connecting instantly to local services (`127.0.0.1:8788`, `127.0.0.1:8787`, and PiecesOS `127.0.0.1:39300`).
  - **Isolating Mobile-Only Permissions (`apps/mobile/src/pages/Status.tsx`, `apps/mobile/src/pages/Setup.tsx`, `apps/mobile/src/components/PermissionsPanel.tsx`)**:
    - Completely removed Android accessibility service warnings, Android app allowlists, Android notification capture switches, SMS backfill, and phone biometrics from the desktop view.
    - Added dedicated **Windows Workstation Node** HUD card in `Status.tsx` displaying daemon, proxy, PiecesOS, and SQLite WAL engine states.
    - Replaced the `/setup` tab on desktop with **Node Hub & Companion Pairing**, displaying the master PC host status and mobile pairing credentials (for scanning/copying from the Galaxy S26 Ultra to the PC).
- **Verification**:
  - 100% test pass rate (158/158 mobile tests, 187/187 daemon tests).
  - 0 TypeScript compiler errors across all monorepo packages.
  - Rebuilt and verified Tauri release packages:
    - NSIS Setup: `apps/desktop/src-tauri/target/release/bundle/nsis/Sovereign Exocortex_1.0.0_x64-setup.exe` (2.41 MB)
    - MSI Installer: `apps/desktop/src-tauri/target/release/bundle/msi/Sovereign Exocortex_1.0.0_x64_en-US.msi` (3.45 MB)
    - Portable executable: `apps/desktop/src-tauri/target/release/app.exe` (9.64 MB)
- **Git Commit**: `fix(desktop): zero-config local workstation launch into Living Brain 3D and isolate phone pairing` (`2cabb27`).



