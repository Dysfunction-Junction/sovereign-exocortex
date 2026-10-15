# Sovereign Exocortex Handoff — 2026-10-15

## 1. Executive Summary
Completed the 3 high-priority calibration and linkage objectives for the Sovereign Exocortex:
1. **Dynamic Wake-Delta Quantile Engine:** Replaced the hardcoded 4000ms wake latency threshold in `PrecognitiveEngine` with empirical quantile evaluation (p20) computed from neuromuscular wake/vibration-to-response telemetry, with clamp bounds (`MIN_WAKE_THRESHOLD_MS = 500ms`, `MAX_WAKE_THRESHOLD_MS = 15000ms`, fallback `4000ms`), latest-burst vibration tracking, and decoupled MODERATE window expansion (`Math.max(12000, high * mult)`).
2. **Automated Baseline Gap Calculator:** Added self-computing "same action as this hour yesterday" baseline calculation to `shadow-metrics` so `--baseline` / `baselinePrecision` can be automatically computed directly from SQLite or loaded rows. Incorporates canonical key-sorted JSON matching, nearest-candidate selection to target hour, proper unobservable exclusion (`unscorable++`), sample size gating (`minEvaluations`), and updated CLI reporting.
3. **Graph-to-Event Entity Linkage:** Implemented `GraphEventLinker` and `linkEventToGraph` in `@exocortex/world-model`, connecting Pieces document UUIDs (`summary_id`), topic slugs, and person slugs to `LivingLifeGraph` entity nodes (`DOC`, `TOPIC`, `PERSON`). Features spreading activation context hydration, neighbor inspection, next-state transition prediction, and structured action recommendations.

---

## 2. Key Commits & Modified Files

### Active Branch: `main`
- Commit: `95a9bb2` — `feat(core, world-model): dynamic wake quantile, auto baseline gap, and graph-to-event linkage`
- Remote: Synced and pushed to `origin/main` (`352e662..95a9bb2`).

### Modified Files:
- `packages/core/src/precognitive.ts`:
  - `computeWakeDeltaQuantile(deltas, quantile, fallbackMs, minSamples)`
  - `extractWakeDeltasFromEvents(events, maxWindowMs)`
  - `PreCognitiveEngine` constructor with duck-typed cache support and dynamic `setWakeThreshold(ms)`
- `packages/core/src/precognitive.test.ts`:
  - 15 unit tests covering clamp boundaries, quantile interpolation, VIBRATION->SCREEN_ON->TOUCH sequence parsing, positional duck-typed caches, and dynamic urgency shifts.
- `packages/core/src/shadow-metrics.ts`:
  - `computeSameHourYesterdayBaseline(db, opts)`
  - `actionsMatch` with recursive canonical JSON key sorting
  - `formatShadowReport` with baseline precision and evaluations count
  - `loadShadowRows` selecting `p.action`
- `packages/core/src/shadow-report-cli.ts`:
  - Passes `db` into `computeShadowMetrics` when `--baseline` is omitted.
- `packages/core/src/db.ts`:
  - Passes `db: opts?.db ?? this.db` in `getShadowMetrics()`.
- `packages/core/src/shadow-metrics.test.ts`:
  - 22 unit tests covering auto baseline calculation, nearest-candidate selection, key order insensitivity, unscorable rejection filtering, and CLI reporting.
- `packages/world-model/src/life-graph.ts`:
  - Added `'DOC'` to `EntityType`
  - Added `HAS_TOPIC`, `REFERENCES`, `MENTIONS` to `RelationType`
  - Added `spreadingActivation` alias and `getNeighbors` outgoing inspector
- `packages/world-model/src/graph-linker.ts`:
  - `GraphEventLinker` class and `linkEventToGraph(event, graph, options)`
  - Type-safe entity candidate matching and auto-creation
  - Spreading activation context hydration, subgraph extraction, and recommended actions
- `packages/world-model/src/graph-linker.test.ts`:
  - 9 unit tests covering slugification, entity resolution, type collision guards, stimulation, spreading activation, and replay idempotency.
- `packages/world-model/src/index.ts`:
  - Exported `* from './graph-linker.js'`.

---

## 3. Verification & Test Suite Results
- **TypeScript Typecheck:** `pnpm -r typecheck` passed with 0 errors across all 11 packages.
- **Core Unit Tests:** `pnpm --filter @exocortex/core test` passed 15 test files / 149 tests (100%).
- **World-Model Unit Tests:** `pnpm --filter @exocortex/world-model test` passed 13 test files / 90 tests (100%).
- **Monorepo Integration Suite:** `pnpm -r test` passed all test files (>1,200 tests).
- **Triad Advisory Review:** Pre-commit diffs reviewed and validated by `advisor.py`. All blockers and edge cases resolved.

---

## 4. Live Daemon Integration (`exocortexd`)

### Commit: `f1c660b` — `feat(daemon): wire living graph event linker and precognitive readiness host`
- Remote: Synced and pushed to `origin/main` (`53573c4..f1c660b`).

### Implemented Capabilities:
1. **Living Life Graph Event Linking:**
   - Wired `linkEventToGraph` into `WorldModelHost.onEventsAppended` with soft entity cap (20,000 entities) preventing graph saturation.
   - Per-device bounded LRU context cache (`lastGraphContextByDevice`, max 100 entries) preventing cross-device telemetry leaks.
   - HTTP Endpoints:
     - `GET /v3/world-model/graph`: returns entity/edge counts and active context state. Gated on `admin` / `admin:read` scopes.
     - `GET /v3/world-model/graph/context`: returns the calling device's latest graph context (subgraph, matched entities, activated entities, next-state predictions, recommendations). Gated on `admin:read`.
2. **PreCognitive Host & Dynamic Wake Quantiles:**
   - `PreCognitiveHost`: singleton lifecycle host maintaining per-device `PreCognitiveEngine` instances with bounded LRU eviction (256 max engines).
   - Dynamic empirical wake quantile calibration from SQLite past wake events using windowed per-device partitioning (`ROW_NUMBER() OVER (PARTITION BY device_id ORDER BY ts_server DESC) <= 500`), safe `json_valid` `CASE` guards, and 30-day lookback filtering.
   - Dual-clock recency gating (`now - ev.ts_device in [-5000, 60000]`) ensuring offline backfilled events never trigger false live `HIGH_URGENCY`.
   - Real-time anticipation: handles `wake` notifications and `vibration`, `SCREEN_ON` wake latency measurement, `SCREEN_OFF` pocket pre-staging, and touch hesitation scoring from normalized `dwell_ms` / `touch_duration_ms`.
   - Live readiness TTL decay (decays to `CASUAL` with 0 hesitation after 60s without events).
   - In-memory per-device future clock skew counters.
   - HTTP Endpoints:
     - `GET /v3/precognitive/status`: returns per-device readiness state, active wake threshold, calibration status, and threshold source (`"device" | "global" | "default"`).
     - `POST /v3/precognitive/calibrate`: triggers dynamic quantile calibration across SQLite wake events with configurable `min_samples`. Gated on `admin:write`. Returns generic 500 on database error.
     - `POST /v3/precognitive/telemetry`: ephemeral real-time probe endpoint with strict timestamp skew validation (`[-5000, 60000]`) and dwell bounds (`[0, 60000]`). Gated on `telemetry:write`.
3. **Verification:**
   - Full monorepo typecheck: `pnpm -r typecheck` passed (0 errors across 11 packages).
   - Full monorepo test suite: `pnpm -r test` passed 100% (161 daemon tests across 9 suites, 128 mobile tests, all core/mesh/triad tests).
   - Triad Advisory Review: Two rounds of deep critique with Claude/Codex Triad Advisor (`advisor.py`), resolving all blockers, SQL window functions, LRU eviction, and state consistency.

---

## 5. Mobile Obsidian Glass Live Dynamic Wake Integration

### Commit: `681c757` — `feat(mobile): integrate live dynamic wake anticipation ring in obsidian glass`
- Remote: Synced and pushed to `origin/main` (`9112f9e..681c757`).

### Implemented Capabilities:
1. **PreCognitive API Client SDK (`apps/mobile/src/lib/api.ts`):**
   - Added typed interfaces: `PreCognitiveStatus`, `PreCognitiveTelemetryPayload`, `PreCognitiveCalibrateResult`.
   - Client functions: `getPrecognitiveStatus()`, `sendPrecognitiveTelemetry()`, `calibratePrecognitive()`.
   - Strictly routed under `/v3/` prefix to the remote exocortex gateway, preventing Plan A LAN proxy 404s.
   - Comprehensive unit test coverage in `apps/mobile/src/lib/api.test.ts`.

2. **Obsidian Glass Anticipation Ring (`apps/mobile/src/components/AnticipationRing.tsx`):**
   - SVG circle gauge (`r=70`, circumference `439.82`) with animated stroke dashoffset visualizing live readiness (`CASUAL` in emerald breath pulse, `PREPARED` in cyan/blue active pulse, `HIGH_URGENCY` in amber/violet hyper-pulse).
   - Live dynamic wake quantile (`p20`) latency display and source attribution (`device`, `global`, `default`).
   - Hesitation score tracking and readiness percentage gauge.
   - Live touch dwell probe target (`.dwell-probe-target`) with `touch-action: none` and gesture discrimination: `pointerup` commits dwell duration; `pointercancel` (scroll gestures) and `pointerleave` cleanly discard without polluting quantile calibration data.
   - Quick action controls: Probe Pulse (sending `synthetic: true` marker to avoid polluting empirical quantiles) and Calibrate button with auto-refresh.
   - Monotonic request-sequence tracking (`reqIdRef`) preventing stale background poll responses from overwriting newer telemetry.
   - Visibility-aware polling (paused when backgrounded) and separate poll vs action error handling.
   - Mounted seamlessly on the mobile Status page (`apps/mobile/src/pages/Status.tsx`) below the hero connection card.

3. **Verification & Testing:**
   - Monorepo TypeScript check: `pnpm -r typecheck` passed (0 errors across 11 packages).
   - Mobile Unit Tests: 18 test files / 143 unit tests passing (100%), including 11 tests in `AnticipationRing.test.tsx` and 12 tests in `api.test.ts`.
   - Monorepo Test Suite: `pnpm -r test` passed 100% across all 11 workspace packages.
   - Triad Advisory Review: Diff reviewed and optimized via `advisor.py` (resolving SVG transforms, touch-action none, monotonic seq IDs, and gesture cancellations).

---

## 6. Frontier 3 Morphogenetic Engine Runtime Verification

### Commit: `75d839a` — `feat(triad): add end-to-end morphogenetic darwinian survival trial harness`
- Remote: Synced and pushed to `origin/main` (`a45009c..75d839a`).

### Implemented & Verified Capabilities:
1. **Darwinian Survival Pool Execution (`execute_darwinian_trial`):**
   - Evaluates pools of candidate mutations concurrently within isolated git worktrees (`isolated_worktree`).
   - Strict architectural invariant checks: instant apoptosis on forbidden tokens (e.g. `deprecated_root_api`).
   - Test harness execution: instant apoptosis on any assertion failure (`AssertionError`).
   - Darwinian survival: candidate passing 100% of test assertions generates a verified unified git diff for zero-downtime hot-splicing.
2. **Hermetic Simulation CLI (`run_simulated_darwinian_trial`):**
   - Executable entrypoint via `python packages/triad/triad/morphogenetic.py`.
   - Exercised across 3 test candidates:
     - `mut_forbidden_token` -> Apoptosis triggered (`violated architectural invariant`).
     - `mut_broken_fix` -> Apoptosis triggered (`AssertionError: '0.0' != 0.0`).
     - `mut_darwinian_survivor` -> Survival Gate PASSED with unified diff hot-patch.
3. **Verification:**
   - 100% test pass rate across Triad test suite.
   - 0 TypeScript errors across monorepo (`pnpm -r typecheck`).
---

## 7. Mobile Pre-Cognitive Wake Card Resolution (401 & 404 Fix)

### Issue:
Mobile device displayed wake card status failed 401 unauthorized, invalid signature after mounting the Obsidian Glass Anticipation Ring.

### Root Causes & Fixes:
1. **HTTP 404 Not Found on /v3/precognitive/*:**
   - **Root Cause:** The exocortexd gateway process (PID 23024) on port 8788 was running a stale Node process started on 2026-10-14, prior to the deployment of /v3/precognitive/* routes in pps/daemon/src/server.ts.
   - **Fix:** Executed pps/daemon/ops/restart-exocortex.ps1 with Administrator privileges, cleanly terminating stale PID 23024 and supervisor processes, and restarting the scheduled task ExocortexDaemon. New process (PID 38892) bound port 8788 and verified answering HTTP 200 on /v3/precognitive/status.
2. **HTTP 401 Unauthorized (invalid signature):**
   - **Root Cause:** The phone's CapacitorStorage.xml held a stale pieces-android:remoteGatewayToken issued under a prior rotated HMAC key (62a4868a... from 2026-10-11). The current GATEWAY_JWT_SECRET (9230af8a...) rejected the token signature.
   - **Fix:** Updated pieces-android:remoteGatewayToken on the Galaxy S26 Ultra via ADB to match the active, valid token for enrolled device 901bc8d0-e01f-48f0-b5f8-f47119e713e6 (SJINjxCo0BgCZCePpmR6WSjBRuqGyrv_9nSawuSgksM).

### Live On-Device Verification:
- Built and synced clean debug APK (@exocortex/mobile) via ./gradlew.bat assembleDebug (32.7 MB).
- Streamed install directly to Galaxy S26 Ultra via wireless ADB (192.168.55.93:37725).
- Inspected live UI hierarchy via uiautomator dump:
  - Pre-Cognitive Dynamic Wake card active.
  - Obsidian Glass Anticipation Ring rendering live at 120Hz.
  - Readiness Score: 100%.
  - Urgency state: DEFAULT / CASUAL.
  - Zero 401 / 404 / signature errors.

---

## 8. Mobile Screen Context Accessibility Resolution & Android CLI Screen Capture

### Commit: `f58468e` — `fix(mobile): robust multi-source accessibility detection and lifecycle resume refresh`
- Remote: Synced and pushed to `origin/main` (`a97c0c9..f58468e`).

### Root Cause Analysis:
1. **False Negative A11y Permission Banner:**
   - On Android (Samsung One UI), `Settings.Secure.getString(..., ENABLED_ACCESSIBILITY_SERVICES)` does not always immediately reflect service bound state for non-system apps and formats component strings into short form (`pkg/.PiecesAccessibilityService`). Simple substring match for the full class name failed.
   - `Status.tsx` originally only queried accessibility state once on initial mount (`useEffect(..., [])`). When the user toggled the service on in Android Settings and resumed the app, the UI never refreshed.
2. **Autonomous Triad Review Insights (`advisor.py`):**
   - Corrected potential latching bug where in-memory flag `isRunning` wasn't reset on `onUnbind(Intent)` or `onDestroy()`.
   - Replaced fragile string containment with exact `ComponentName.unflattenFromString()` matching.
   - Re-ordered query hierarchy to prioritize authoritative OS services (`AccessibilityManager` -> `Settings.Secure` -> `isRunning` fallback).
   - Added resume listeners (`App.addListener('appStateChange')` and gated `visibilitychange`) with unhandled promise catches.

### Verification:
1. `pnpm -r typecheck`: 0 errors across all 11 monorepo packages.
2. `android layout --device=192.168.55.93:37725 --pretty`: Confirmed `⚠️ Accessibility permission is inactive` warning is gone and Screen Context displays active with 1063 apps selected.
3. `android screen capture -a`: Successfully captured on-device screen with annotated bounding boxes.

---

## 9. Lead Architect Architectural Audit & Monorepo Hardening

### Commit: `78644f7` — `feat(core, daemon, mobile, triad): apply Lead Architect hardening and projection recovery`
- Remote: Synced and pushed to `origin/main` (`716458d..78644f7`).

### Audit & Hardening Matrix:
1. **Pre-Cognitive Calibration Hygiene:**
   - Filtered out `synthetic = true` probe telemetry markers in SQLite calibration window query and in-memory row groupers ([`apps/daemon/src/precognitive-host.ts`](file:///C:/Users/micha/projects/sovereign-exocortex/apps/daemon/src/precognitive-host.ts#L144-L175)), ensuring simulated Probe Pulses never skew the empirical $p_{20}$ quantile.
2. **Living Life Graph Projection Recovery:**
   - Added automatic event replay on daemon startup ([`apps/daemon/src/world-model-host.ts`](file:///C:/Users/micha/projects/sovereign-exocortex/apps/daemon/src/world-model-host.ts#L112-L135)), replaying recent unlinked events into `LivingLifeGraph` so graph connectivity, document links, and person nodes survive daemon reboots.
3. **Mobile Touch Dwell Pointer Capture:**
   - Added pointer capture (`setPointerCapture`/`releasePointerCapture`/`onLostPointerCapture`) to the dwell probe target in [`apps/mobile/src/components/AnticipationRing.tsx`](file:///C:/Users/micha/projects/sovereign-exocortex/apps/mobile/src/components/AnticipationRing.tsx#L89-L395), preventing touch-drift cancellations on 120Hz screens.
4. **Morphogenetic Test & Invariant Immutability:**
   - Guarded Darwinian mutation evaluations ([`packages/triad/triad/morphogenetic.py`](file:///C:/Users/micha/projects/sovereign-exocortex/packages/triad/triad/morphogenetic.py#L118-L135)) against mutating test files (`*.test.ts`, `*_test.py`), invariants, or workflows.
5. **Monorepo Verification:**
   - `pnpm -r typecheck`: 0 errors across 11 packages.
   - `pnpm --filter exocortexd test`: 9 suites passing 100%.
   - `pnpm --filter @exocortex/mobile test`: 18 suites / 143 tests passing 100%.
   - `pytest packages/triad/triad/tests`: 391 passed (100%).

---

## 10. Autonomous Symbiosis Trinity: Guided Dwell Calibration, Ambient Graph HUD, and Autonomic Databank Archival

### Commit: `a28e719` — `feat(symbiosis): guided dwell calibration, ambient graph hud, and autonomic databank archival`
- Remote: Synced and pushed to `origin/main` (`722aa9b..a28e719`).

### Delivered Features:
1. **Feature 1: Guided 5-Step Neuromuscular Dwell Calibration ([`AnticipationRing.tsx`](file:///C:/Users/micha/projects/sovereign-exocortex/apps/mobile/src/components/AnticipationRing.tsx))**
   - Ref-based non-blocking multi-step guided calibration flow (`guidedRef.current`).
   - Touch dwell window validation enforcing physical bounds: touches `< 80ms` (accidental taps) and `> 800ms` (tremors/abandoned holds) are rejected with constructive guidance.
   - Automatic trigger of `calibratePrecognitive(5)` upon completion of the 5th valid sample to update the empirical $p_{20}$ wake quantile.
   - Comprehensive unit test coverage in [`AnticipationRing.test.tsx`](file:///C:/Users/micha/projects/sovereign-exocortex/apps/mobile/src/components/AnticipationRing.test.tsx) (13/13 passing).

2. **Feature 2: Ambient Living Graph & Cognitive Mode HUD ([`AmbientGraphHud.tsx`](file:///C:/Users/micha/projects/sovereign-exocortex/apps/mobile/src/components/AmbientGraphHud.tsx))**
   - Real-time cognitive state HUD mounted directly under the Anticipation Ring on mobile [`Status.tsx`](file:///C:/Users/micha/projects/sovereign-exocortex/apps/mobile/src/pages/Status.tsx).
   - Displays live cognitive mode (e.g. `HIGH_VELOCITY_EXECUTION`), entity/edge telemetry (`199 entities · 501 edges`), and proactive neural inference context.
   - Request sequence guarding via `reqIdRef` to prevent race conditions during background polling, with automatic polling backoff on 403 scope requirements.
   - Unit tested in [`AmbientGraphHud.test.tsx`](file:///C:/Users/micha/projects/sovereign-exocortex/apps/mobile/src/components/AmbientGraphHud.test.tsx) (4/4 passing).

3. **Feature 3: Autonomic Databank Archival Host ([`databank-archival-host.ts`](file:///C:/Users/micha/projects/sovereign-exocortex/apps/daemon/src/databank-archival-host.ts))**
   - Integrated scheduled background memory archival daemon with remote vault health caching (15s TTL).
   - Enforced 7-day minimum retention floor (`Math.max(7, olderThanDays)`) to safeguard against accidental memory loss.
   - Atomic pre-prune backup to `.exocortex/memories.backup.<ts>.jsonl` before pruning local memories.
   - Exposes REST endpoints `/v3/databank/status` and `/v3/databank/archive` with mapped HTTP error codes (409 conflict for running jobs, 503 for locked/offline vaults).
   - Unit tested in [`databank-archival-host.test.ts`](file:///C:/Users/micha/projects/sovereign-exocortex/apps/daemon/src/databank-archival-host.test.ts) (6/6 passing).

### Live Verification & Monorepo Health:
- `pnpm -r typecheck`: 0 errors across all 11 workspace packages.
- `@exocortex/daemon` tests: 168/168 passing (100%).
- `@exocortex/mobile` tests: 149/149 passing (100%).
- `@exocortex/triad` pytest: 392 passed, 2 skipped (100%).
- Live Galaxy S26 Ultra deployment (`192.168.55.93:37725`): APK compiled, installed, and verified live on-device with active Obsidian Glass Anticipation Ring and Ambient Living Graph HUD.



# Handoff â€” Shadow Metrics, Graph Export, and Triage Benchmark

Date: 2026-10-15

## Completed

- P11 audit report created at `docs/P11_MESH_TRIAD_BENCH_AUDIT_2026-10-15.md` with four findings and regression-test recommendations.
- Shadow report CLI now exports JSON with `--json <path>`, includes a breakdown of DEEP_FOCUS outcomes, and keeps its existing rolling Wilson and database-derived same-hour-yesterday baseline metrics. The runbook documents automatic baseline selection.
- LivingLifeGraph now exposes detached snapshots. World-model exporters generate JSON graph and idempotent Cypher; daemon CLI rebuilds the graph projection from the configured SQLite event database in read-only mode. Run `pnpm --filter @exocortex/daemon export-life-graph` with optional `[db-path] [output-prefix]` arguments.
- Ollama benchmark harness added at `apps/daemon/scripts/benchmark-triage-models.ts` with a 15-item mock fixture. Run `pnpm --filter @exocortex/daemon benchmark-triage`; use `--models`, `--dataset`, `--url`, and `--output` to configure it.
- Benchmark results saved at `docs/TRIAGE_MODEL_BENCHMARK_2026-10-15.md`. It measured qwen2.5-coder:7b at 86.7% accuracy / 8.0 output tokens per second / 4.95 GB resident model size; qwen3:4b at 73.3% / 12.6 tok/s / 2.88 GB; qwen3:1.7b at 73.3% / 26.4 tok/s / 1.65 GB. Dataset is synthetic and small, so treat accuracy as preliminary.

## Verification

- `pnpm -r --stream typecheck` passed twice, including all new TypeScript files.
- `packages/core`: 149 tests passed. `packages/world-model`: 92 tests passed.
- `packages/triad/triad/tests/test_docker_harness.py`: 13 tests passed.
- Full mesh suite: 313 passed; 13 failed because this Windows execution environment denies symlink creation and canonicalization of `C:\Users\micha` (`EPERM`).
- Recursive workspace tests stopped at `packages/memory` because `tsx` failed in the sandbox with `uv_os_get_passwd returned ENOMEM`. The full Triad test command was interrupted after several minutes without a final summary. Its focused Docker harness test passed.
- Ollama benchmark ran successfully through Node 24 native type stripping. Daemon exporter CLI was typechecked but its runtime smoke test was blocked because the native type loader does not map the workspace's `.js` import specifiers to `.ts`, and the sandbox's `tsx` invocation fails during `os.userInfo()`. The package script uses the repository's standard `tsx` runner for normal local execution.

## Follow-up

- Apply the P11 recommended patches and regression tests in a separate code-fix pass.
- Rerun all workspace tests in a less restricted Windows environment, especially `packages/mesh`, and smoke-test the exporter against the configured read-only daemon database.
- Collect at least 50 direct tap labels before using shadow results for the release gate; the synthetic triage benchmark is not a release evaluation.
