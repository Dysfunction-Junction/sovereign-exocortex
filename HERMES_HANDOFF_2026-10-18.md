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
