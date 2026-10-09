# HERMES & TRIAD HANDOFF — 2026-10-09

**Author:** Antigravity (Primary Executive Engine)  
**Collaborators:** Claude Code & OpenAI Codex (Advisory Council), Hermes Agent  
**Repository:** `C:\Users\micha\projects\sovereign-exocortex`  
**Git Branch:** `main`  
**Git Commits:**
- `6ddded7`: `feat(v3): import Architecture & Schema v3, SQLite DDL, and Phase 0 hardening` (Tag: `v3-schema-imported`)
- `f8cd063`: `feat(v3): implement SQLite Event Store driver, hash-chain verification, and hardened daemon ingest` (Tag: `v3-event-store-complete`)

---

## 1. Executive Summary

Phase 1 of **Sovereign Exocortex Architecture & Schema v3** is fully implemented, verified, hardened, and committed to git. This transitions the ecosystem from heuristic hardcoded threshold tables into an immutable, append-only, cryptographic hash-chained SQLite event store operating under WAL mode, with strict device binding, timing-safe authentication, and mathematical fork prevention.

Following Section 5 & 6 of `AGENTS.md` (Autonomous Triad Protocol), the implementation underwent an autonomous adversarial review by Claude Code (`advisor.py`), resulting in 11 surgical security and correctness hardening patches that were verified and incorporated prior to release.

---

## 2. Deliverables & Components

### A. Core SQLite Event Store Driver (`@exocortex/core/db`)
- **[schema.sql](file:///C:/Users/micha/projects/sovereign-exocortex/packages/core/src/schema.sql) & [V3_SCHEMA_SQL](file:///C:/Users/micha/projects/sovereign-exocortex/packages/core/src/db.ts):**
  - Full DDL for 11 v3 tables: `devices`, `events`, `invariants`, `model_params`, `belief_snapshots`, `proposals`, `gate_decisions`, `approvals`, `executions`, `shadow_labels`, `mutations`.
  - SQLite triggers `events_no_update` and `events_no_delete` aborting mutations with `RAISE(ABORT, 'events are append-only')`.
  - `CREATE UNIQUE INDEX events_prev_hash ON events(prev_hash)` strictly enforcing linear continuity and physically preventing chain forks.
  - `CREATE INDEX events_device_seq ON events(device_id, seq)` optimizing per-device event querying.
- **[canonical.ts](file:///C:/Users/micha/projects/sovereign-exocortex/packages/core/src/canonical.ts):**
  - Isomorphic deterministic JSON serialization with recursively sorted keys at all nested depths for deterministic SHA-256 cryptographic hashes.
- **[db.ts](file:///C:/Users/micha/projects/sovereign-exocortex/packages/core/src/db.ts):**
  - `ExocortexDatabase` engine using Node 22/24 `node:sqlite`.
  - Atomic nested transaction management via `withTransaction` supporting `BEGIN IMMEDIATE` and depth-counted `SAVEPOINT` nesting.
  - Typed error classes: `DeviceNotEnrolledError`, `DeviceRevokedError`, `EventIdConflictError`.
  - Cryptographic SHA-256 hash chaining (`sha256(prev_hash || canonical(row))`). Genesis event anchors on 32 zero bytes.
  - Memory-bounded streaming verification via `stmt.iterate()` in $O(1)$ memory.
  - Device-scoped event querying `listEvents({ deviceId, kind, sinceSeq, limit })`.
  - Serialization helpers: `ExocortexDatabase.eventToJson` and `deviceToJson` encoding binary keys and hashes to base64.
- **[package.json](file:///C:/Users/micha/projects/sovereign-exocortex/packages/core/package.json):**
  - Subpath exports: `"./db": "./src/db.ts"`, `"./canonical": "./src/canonical.ts"` ensuring isomorphic client builds (`@exocortex/mobile`) do not pull in native `node:sqlite`.

### B. Daemon REST Ingestion Engine (`@exocortex/daemon`)
- **[db-host.ts](file:///C:/Users/micha/projects/sovereign-exocortex/apps/daemon/src/db-host.ts):**
  - Singleton database host with lazy initialization and configurable `EXOCORTEX_DB_PATH`.
- **[device-registry.ts](file:///C:/Users/micha/projects/sovereign-exocortex/apps/daemon/src/device-registry.ts):**
  - Revocation fail-closed synchronization: `revokeDevice` marks revocation in both v3 SQLite and legacy JSON stores without overwriting existing `revoked_at` timestamps (`AND revoked_at IS NULL`).
- **[server.ts](file:///C:/Users/micha/projects/sovereign-exocortex/apps/daemon/src/server.ts):**
  - `POST /v3/devices/enroll`: Timing-safe token authentication via `crypto.timingSafeEqual` over multibyte-safe buffers (`GATEWAY_ENROLL_TOKEN`), SPKI DER validation (`createPublicKey`), key curve checks (EC/Ed25519), server-authoritative timestamps, and HTTP 409 duplicate handling.
  - `POST /v3/events`: Cryptographically binds `reqObj.device_id === auth.deviceId` (HTTP 403 on mismatch). Batch bounds (1-100), scalar type checks (positive safe integer `ts_device`, plain JSON object `payload`, string length caps), and typed error mapping (403, 409, 400).
  - `GET /v3/events`: Strict positive integer query bounds. Non-admin callers are strictly confined to their own device's events (`deviceId = auth.deviceId`).
  - `GET /v3/events/verify`: Chain integrity verification restricted to admin callers (`auth.deviceId` carrying `admin` or `admin:read` scope).
  - `GET /v3/devices`: Device listing restricted to admin callers; non-admin callers receive only their own enrolled device record.

---

## 3. Advisory Council Hardening Resolves

Claude Code identified 11 high-leverage findings which were addressed:
1. **Cross-Device Event ID Collision:** In `ingestEvent`, device enrollment and revocation are now checked *before* idempotency, and conflicting IDs from differing devices throw `EventIdConflictError` (HTTP 409).
2. **Device Isolation on Reads:** Non-admin callers on `GET /v3/events` and `GET /v3/devices` are constrained to their own device ID.
3. **Chain Forking Prevention:** Added `CREATE UNIQUE INDEX events_prev_hash ON events(prev_hash)` and nested transaction savepoints.
4. **Input Boundary Hardening:** Enforced `Number.isSafeInteger(ts_device)` (rejecting floats like 1.5 with HTTP 400) and plain JSON object validation.
5. **Streaming Verification:** `verifyEventChain()` uses `stmt.iterate()` to prevent memory bloat over large event streams.
6. **Key Verification on Enrollment:** Added DER SPKI decoding and curve validation (`asymmetricKeyType === 'ec' || 'ed25519'`).

---

## 4. Comprehensive Verification Evidence

All test suites pass 100% across the monorepo:
- **TypeScript Typecheck:** `pnpm -r typecheck` → 0 errors across all 10 workspace packages.
- **Core Unit Tests:** `pnpm --filter @exocortex/core test` → 57/57 tests passing.
- **Daemon Integration Tests:** `pnpm --filter @exocortex/daemon test` → 16/16 tests passing (including 16-step v3 integration suite with negative validation).
- **World Model Tests:** `pnpm --filter @exocortex/world-model test` → 19/19 tests passing.
- **Agent Mesh Tests:** `pnpm --filter @exocortex/mesh test` → 312/312 tests passing.
- **Mobile Companion Tests:** `pnpm --filter @exocortex/mobile test` → 52/52 tests passing.
- **Triad Engine Tests:** `python -m unittest triad/tests/test_morphogenetic.py` and `test_worktree.py` → 100% passing.
- **Sanitization Invariant:** 0 occurrences of deprecated components across all code, schemas, and tests.
- **Zero Secrets Invariant:** 0 keys, secrets, or certificates committed.

---

## 5. Next Steps (Phases 2 & 3)

1. **Phase 2: Discrete Learned Active Inference Model ($A, B, C, D$ Count Tables):**
   - Implement `ActiveInferenceLearner` in `packages/world-model` consuming the v3 event store.
   - Maintain Dirichlet count tables in `model_params` with conjugate pseudocount increments upon observation.
   - Replace heuristic constants with Bayesian posterior expectations.
2. **Phase 3: Shadow Mode Metrics & Calibration Engine:**
   - Implement rolling evaluation of `shadow_labels`.
   - Track Precision@surface, Focus Regret, and Baseline Gap.
   - Enforce automatic rollback circuit breaker if Precision@surface < 0.90 over a 14-day rolling window.
