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



