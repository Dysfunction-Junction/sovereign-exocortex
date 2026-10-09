# HERMES & TRIAD HANDOFF — 2026-10-09

**Author:** Antigravity (Primary Executive Engine)  
**Collaborators:** Claude Code & OpenAI Codex (Advisory Council), Hermes Agent  
**Repository:** `C:\Users\micha\projects\sovereign-exocortex`  
**Git Branch:** `main`  
**Latest Remote Commit:** `33ffe20` (Tag: `v3-phase-2-generative-model-complete`)  
**Previous Milestones:**
- `6ddded7`: `feat(v3): import Architecture & Schema v3, SQLite DDL, and Phase 0 hardening` (Tag: `v3-schema-imported`)
- `f8cd063`: `feat(v3): implement SQLite Event Store driver, hash-chain verification, and hardened daemon ingest` (Tag: `v3-event-store-complete`)
- `fa2eddf`: `feat(core): shadow-mode metrics evaluator + read-only report CLI`
- `1804c67`: `feat(daemon): persist shadow-mode proposals + gate decisions (ShadowRecorder)`
- `33ffe20`: `feat(world-model): discrete learned generative model (Phase 2 A, B, C, D count tables) and event replay` (Tag: `v3-phase-2-generative-model-complete`)
- Upcoming: `v3-phase-3-shadow-metrics-complete`

---

## 1. Executive Summary

**Phase 3: Shadow Mode Metrics, Calibration Engine & Rollback Circuit Breakers** is complete, verified, hardened through Triad Advisory critique, and ready for commit/tagging.

This builds on Phase 2's Active Inference generative substrate by closing the calibration feedback loop and enforcing strict fail-safe circuit breaking:
1. **Mathematical Calibration Engine (`@exocortex/core`):** Precision@surface point estimates, Wilson 95% score interval lower bounds, and Focus Regret with strict window bounds. Automated verdicts (`SUFFICIENT_DATA_PASS`, `BREAKER_TRIPPED_PRECISION_LOW`, `INSUFFICIENT_DATA`, `HEURISTIC_SCORER`).
2. **Safe Read-Only Ingest (`loadShadowRows`):** Manages `PRAGMA query_only = ON` with guaranteed `restoreQueryOnly: true` in `finally`, protecting shared read-write connections from lockouts.
3. **Daemon Telemetry & Gate Enforcement (`@exocortex/daemon`):**
   - `GET /v3/shadow/metrics`: Full query param validation (`days`, `threshold`, `min_labels`, `baseline_precision`), returning metrics, verdicts, `canonical_breaker_tripped`, and `effective_shadow`.
   - `POST /v3/shadow/labels`: Input validation, device revocation checks, proposal checks, atomic transaction writing to `shadow_labels` and appending hash-chained audit events.
   - `POST /v3/events`: Batch ingest automatically extracts and records `kind: "label"` events.
   - Circuit Breaker Enforcement on `POST /network/approve`: Blocks execution attempts with HTTP 423 Locked when Precision@surface drops below 0.90 over a 14-day window with $\ge 50$ labels.
4. **Mobile Telemetry Streaming (`apps/mobile`):**
   - Telemetry queue flusher posts to `POST /v3/events` in 100-event capped batches.
   - Distinguishes user queries (`kind: "query"`) from actions to prevent active inference transition tensor ($B$) poisoning.
   - Automatic 400/409 poison-pill discarding to prevent infinite retry deadlocks.
   - Graceful 403/404 failover to legacy `/mobile/usage-report`.
   - Automatic `"wanted"` / `"not_wanted"` ground-truth label submission upon mobile proposal review.

---

## 2. Deliverables & Components

### A. Core Shadow Engine (`@exocortex/core`)
- **[shadow-metrics.ts](file:///C:/Users/micha/projects/sovereign-exocortex/packages/core/src/shadow-metrics.ts):**
  - Exported `SHADOW_LABELS` and `isShadowLabel` type guard.
  - Added `AutomatedVerdict` and `toAutomatedVerdict(verdict)`.
  - Added `restoreQueryOnly: true` default in `loadShadowRows`, safely resetting `PRAGMA query_only = OFF` upon query completion.
- **[db.ts](file:///C:/Users/micha/projects/sovereign-exocortex/packages/core/src/db.ts):**
  - Added `loadShadowRows()`, `getShadowMetrics(opts)`, and `isCircuitBreakerTripped(opts)` methods to `ExocortexDatabase`.
- **[index.ts](file:///C:/Users/micha/projects/sovereign-exocortex/packages/core/src/index.ts):**
  - Re-exported shadow metrics functions and types without leaking `node:sqlite` value bindings.
- **[shadow-metrics.test.ts](file:///C:/Users/micha/projects/sovereign-exocortex/packages/core/src/shadow-metrics.test.ts):**
  - 18 comprehensive tests verifying precision, Wilson score intervals, focus regret, deduplication, window boundaries, query_only restoration, and invalid label rejections.

### B. Daemon API & Gate Enforcement (`@exocortex/daemon`)
- **[server.ts](file:///C:/Users/micha/projects/sovereign-exocortex/apps/daemon/src/server.ts):**
  - `applyShadowLabel`: Helper enforcing authoritative `source` binding and label sanitization.
  - `GET /v3/shadow/metrics`: Returns full metrics summary, canonical circuit breaker status, and effective shadow mode.
  - `POST /v3/shadow/labels`: Atomic insertion into `shadow_labels` + hash-chained audit event append.
  - `POST /v3/events`: Batch hooks process incoming `"label"` events via `applyShadowLabel`.
  - `POST /network/approve`: Circuit-breaker gate returns HTTP 423 Locked when breaker is tripped.
- **[v3-shadow.test.ts](file:///C:/Users/micha/projects/sovereign-exocortex/apps/daemon/src/v3-shadow.test.ts):**
  - Integration suite verifying metrics queries, label posting, event batching, and circuit breaker gate blocking.

### C. Mobile Companion Integration (`apps/mobile`)
- **[jwtDisplay.ts](file:///C:/Users/micha/projects/sovereign-exocortex/apps/mobile/src/lib/jwtDisplay.ts):**
  - Added `extractDeviceIdFromToken(token)` helper.
- **[flush.ts](file:///C:/Users/micha/projects/sovereign-exocortex/apps/mobile/src/lib/flush.ts):**
  - Streams telemetry to `POST /v3/events` in batches up to 100 events.
  - Maps `ask`/`search` to `kind: "query"` to isolate user queries from action transition tensors.
  - Discards poisoned payloads on 400/409, falls back on 403/404.
- **[api.ts](file:///C:/Users/micha/projects/sovereign-exocortex/apps/mobile/src/lib/api.ts):**
  - Added `submitShadowLabel` and `getShadowMetrics` client APIs.
- **[proposals.ts](file:///C:/Users/micha/projects/sovereign-exocortex/apps/mobile/src/lib/proposals.ts):**
  - Submits `"wanted"` / `"not_wanted"` labels automatically upon proposal review.
- **[flush.test.ts](file:///C:/Users/micha/projects/sovereign-exocortex/apps/mobile/src/lib/flush.test.ts) & [proposals.test.ts](file:///C:/Users/micha/projects/sovereign-exocortex/apps/mobile/src/lib/proposals.test.ts):**
  - Verified flush batching, error recovery, and proposal label submission.

---

## 3. Triad Advisory Council Findings Applied

Claude Code (`advisor.py`) performed adversarial review on the staged implementation, leading to the following key resolutions:
1. **Query-Only DB Lockout Prevention:** Defaulting `restoreQueryOnly: true` ensures `PRAGMA query_only = OFF` is restored in `finally`, preventing permanent write-lockout of shared `DatabaseSync` handles.
2. **Authoritative Label Source Placement:** Sanitizing `actual` payloads and strictly setting `source` last guarantees client input cannot forge telemetry attribution.
3. **Semantic Action Attribution:** Segregated user query events (`kind: "query"`) from system policy actions (`kind: "action"`), preventing active inference transition matrices ($B$) from being distorted.
4. **Mobile Queue Deadlock Elimination:** Added clearing on unrecoverable 400/409 client errors to prevent poison pills from blocking offline telemetry queues.
5. **Canonical Circuit Breaker Reporting:** Exposed `canonical_breaker_tripped` alongside ad-hoc query threshold metrics so clients cannot misinterpret what-if thresholds as system health.
6. **Device Revocation Verification:** Enforced `revoked_at === null` checks on both `GET /v3/shadow/metrics` and `POST /v3/shadow/labels`.

---

## 4. Comprehensive Verification Evidence

All test suites pass 100% across the monorepo:
- **TypeScript Typecheck:** `pnpm -r typecheck` → 0 errors across all 10 workspace packages.
- **Core Tests:** `pnpm --filter @exocortex/core test` → 76/76 passing.
- **Daemon Integration Tests:** `pnpm --filter @exocortex/daemon test` → 29/29 passing.
- **Mobile Companion Tests:** `pnpm --filter @exocortex/mobile test` → 56/56 passing.
- **World Model Tests:** `pnpm --filter @exocortex/world-model test` → 32/32 passing.
- **Memory Tests:** `pnpm --filter @exocortex/memory test` → 75/75 passing.
- **Agent Mesh Tests:** `pnpm --filter @exocortex/mesh test` → 312/312 passing.
- **Sanitization Invariant:** 0 occurrences of deprecated components across the monorepo (`git grep -i "shizuku"` returns 0).
- **Zero Secrets Invariant:** Strictly enforced; zero tokens, certificates, or keystores staged.

---

## 5. Next Steps (Phase 4)

1. **Phase 4: Active Inference Policy Arbitration & Mutation Verification Engine:**
   - Link `WorldModelHost` variational free energy minimization directly into gate decision policies.
   - Enforce Frontier 3 morphogenetic sandbox validation across isolated worktrees.
   - Wire biometric attestation verification into high-risk proposal approvals.
