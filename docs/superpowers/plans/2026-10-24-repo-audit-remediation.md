# Repo Audit Remediation (2026-10-24) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close the audit findings validated against commit `f5689b6` (H1, H2, H3, M1, M2, M6, typecheck blocker) with a failing-first regression for each.

**Architecture:** Every fix is local to an existing file. Scope enforcement reuses `deviceHasScope` in `server.ts`; env isolation moves credentials from the shared `env` object into the per-node allowlist in `buildChildEnv`; ingest returns a new `insertedEvents` list that hooks consume; import order is fixed in the model; unimplemented execution fails closed.

**Tech Stack:** TypeScript (pnpm monorepo), `node:test` + `node:assert`, better-sqlite3 via `ExocortexDatabase`.

**Spec:** Audit report pasted 2026-10-24 (validated in-session); out of scope: H4, M3, M4, M5, M7, M8 (separate plans, see "Deferred").

## Global Constraints

- `pnpm -r typecheck` must report 0 errors before every commit.
- Each fix lands with a regression test that fails on `f5689b6` and passes after.
- Do not change the `/v3/events` response shape (`result.events` stays, including duplicates).
- Existing scope names only: `telemetry:write`, `approval:write`, `admin`, `admin:read`, `admin:write`.
- No real credentials in tests; use sentinel strings.
- Commit only files this plan touches (other dirty repos stay untouched).

## Review Focus

- Zero-scope device calls `/network/approve` with `action: "reject"` → expect 403 before any forward.
- Retry of an already-ingested event → expect no change in learned counts.
- `model_params` with versions [3, 2] for one factor → expect version 3 counts restored.
- Node ids other than `pieces-for-all`/`autonomous-triad` → expect none of the three tokens in the env.
- Unknown playbook id on the HTTP playbook endpoint → expect non-2xx, no `runId`.

---

### Task 1: Typecheck blocker in triage-host test

**Files:**
- Modify: `apps/daemon/src/triage-host.test.ts:125-141`

**Interfaces:**
- Produces: nothing; restores a green `pnpm -r typecheck` so later tasks can gate on it.

- [ ] **Step 1: Run `pnpm --filter @exocortex/daemon typecheck`; expect TS2339 at lines 139-141 (`never`).**
- [ ] **Step 2: Replace `let firedWith: {...} | null = null` with `const fired: Array<{ deviceId: string; category: string; seq: number }> = []`; callback does `fired.push({ deviceId, category: verdict.category, seq })`; assertions become `assert.equal(fired.length, 1)` and checks on `fired[0]`.**
- [ ] **Step 3: Run typecheck (0 errors) and `pnpm --filter @exocortex/daemon test -- triage-host` (pass).**
- [ ] **Step 4: Commit** `fix(test): type triage verdict hook capture`

### Task 2: Scope enforcement on events, delegate, approve/reject (H1)

**Files:**
- Modify: `apps/daemon/src/server.ts` (`/v3/events` ~678, `/network/delegate` ~1970, `/network/approve` ~2018)
- Test: `apps/daemon/src/v3-events.test.ts` (events), `apps/daemon/src/shadow-actuation.test.ts` (delegate/approve)

**Interfaces:**
- Consumes: `deviceHasScope(db, deviceId, ...allowedScopes): boolean` (`server.ts:175`).
- Produces: 403 responses with `{ error: "forbidden: ... requires <scope>" }`, matching the style at `server.ts:611-613`.

- [ ] **Step 1: Write failing tests** (reuse each file's existing enroll/token helpers; enroll a device with `scopes: []`):
  - `zero-scope device gets 403 on POST /v3/events and no event row is written`
  - `zero-scope device gets 403 on POST /network/delegate and forwardDelegate is not called`
  - `zero-scope device gets 403 on POST /network/approve for both action approve and reject`
  - `device with only telemetry:write gets 403 on /network/approve`
- [ ] **Step 2: Run them; expect FAIL (200/other status).**
- [ ] **Step 3: Implement.** `/v3/events`: require `telemetry:write` or `admin`. `/network/approve` (both actions, before body parsing): require `approval:write` or `admin`. `/network/delegate`: require `admin` or `admin:write` (containment until an action-level map exists). Check before `readBody`.
- [ ] **Step 4: Extend the shadow guard** so mutating delegation to any destination is blocked while `SHADOW !== "0"`: add test `delegate to agent-mesh demote returns 423 under SHADOW`; implement by applying the 423 branch to every `parsed.to` whose action is not read-only (read-only allowlist: `ping`, `status`, `list`). Confirm the allowlist against `network.ts` `parseDelegateEnvelope` before writing it.
- [ ] **Step 5: Run `pnpm --filter @exocortex/daemon test`; all pass except the known sibling-service integration test.**
- [ ] **Step 6: Commit** `fix(daemon): enforce device scopes on ingest, delegation, approval`

### Task 3: Per-node credential isolation (H2)

**Files:**
- Modify: `apps/daemon/src/mishmash-launch.ts:229-231` (remove token copies from shared `env`), `:158-187` (`buildChildEnv`)
- Test: `apps/daemon/src/mishmash-launch.test.ts`

**Interfaces:**
- Consumes: `buildChildEnv(portVariable, port, extraEnv, nodeId?)` unchanged signature.
- Produces: `buildChildEnv` never returns `TRIAD_SERVER_TOKEN`, `GATEWAY_TOKEN`, `PIECES_GATEWAY_TOKEN` unless allowlisted for that `nodeId`.

- [ ] **Step 1: Write failing test** `unrelated nodes receive none of the protected tokens`: set the three vars on `process.env` to sentinels (restore in `finally`), call `buildChildEnv` for every `MISHMASH_LAUNCH` id except `autonomous-triad`/`pieces-for-all` with `extraEnv` containing the sentinels, assert all three keys are `undefined`. Add `triad gets only TRIAD_SERVER_TOKEN` and `pieces-for-all gets only GATEWAY_TOKEN and PIECES_GATEWAY_TOKEN`.
- [ ] **Step 2: Run; expect FAIL on the unrelated-node case.**
- [ ] **Step 3: Implement:** delete lines 229-231 so tokens never enter the shared `env`; additionally strip the three keys from `extraEnv` inside `buildChildEnv` before spreading. Keep the existing per-node blocks (172, 176-179) as the only source. Leave `DATABANK_TOKEN` handling unchanged (audit found no leak).
- [ ] **Step 4: Run `pnpm --filter @exocortex/daemon test -- mishmash-launch`; pass.**
- [ ] **Step 5: Commit** `fix(daemon): stop leaking service tokens to unrelated mishmash children`

### Task 4: Duplicate events must not retrain projections (M1)

**Files:**
- Modify: `packages/core/db.ts:576-593` (`ingestBatch`), `apps/daemon/src/server.ts:740-795`
- Test: `packages/core/db.test.ts`, `apps/daemon/src/telemetry-dedupe.test.ts`

**Interfaces:**
- Produces: `ingestBatch(req): { insertedCount: number; duplicateCount: number; events: EventRecord[]; insertedEvents: EventRecord[] }`; `events` keeps duplicates for API compatibility.

- [ ] **Step 1: Write failing tests:** (db) `ingestBatch returns only new rows in insertedEvents on retry` (first call: `insertedEvents.length === 1`; retry: `0`, `events.length === 1`, `duplicateCount === 1`). (daemon) `retrying the same event batch does not change world-model counts`: POST twice, compare `getModelParams` / host counts after each.
- [ ] **Step 2: Run; expect FAIL (`insertedEvents` undefined; counts change).**
- [ ] **Step 3: Implement** the `insertedEvents` push in the `inserted` branch; in `server.ts` change `result.events` to `result.insertedEvents` in the world-model, precognitive, prediction, triage hooks and the label-sync loop. The HTTP response still maps `result.events`.
- [ ] **Step 4: Run `pnpm --filter @exocortex/core test` and daemon tests; pass.**
- [ ] **Step 5: Commit** `fix(core): project only newly inserted events`

### Task 5: Restore latest model version last (M2)

**Files:**
- Modify: `packages/world-model/generative-model.ts:761-789` (`importModelParams`)
- Test: `packages/world-model/generative-model.test.ts`

**Interfaces:**
- Consumes: `ModelParamRecord { factor; kind; version; counts; as_of_seq }`.
- Produces: `importModelParams(records)` independent of input order; newest valid record per `(factor, kind)` wins.

- [ ] **Step 1: Write failing test** `importModelParams applies the highest version regardless of input order`: records for one factor/kind with versions [3, 2] and distinguishable valid counts; after import assert `aCounts` equals version 3's table and `factor.version === 3`. Repeat with order [2, 3].
- [ ] **Step 2: Run; expect FAIL for the [3, 2] order.**
- [ ] **Step 3: Implement** by iterating `[...records].sort((a, b) => a.version - b.version)` (stable, oldest first) so a malformed newest record falls back to the previous valid one.
- [ ] **Step 4: Run `pnpm --filter @exocortex/world-model test`; pass.**
- [ ] **Step 5: Commit** `fix(world-model): restore newest model params last`

### Task 6: Fail closed on unimplemented playbook execution (M6)

**Files:**
- Modify: `packages/mesh/mishmash-delegate.ts:188-198`
- Test: `packages/core/mishmash-delegate-guard.test.ts` (existing delegate-handler tests live here)

**Interfaces:**
- Produces: playbook action returns `{ status: 501, body: envelope(record, { node: NODE, action: "playbook", ok: false, error: "HTTP playbook execution is not implemented", playbookId }) }`; no `runId`, no `status: "completed"`.

- [ ] **Step 1: Write failing test** `nonexistent playbook id returns 501 without runId or completed status`.
- [ ] **Step 2: Run; expect FAIL (200/completed).**
- [ ] **Step 3: Implement** the 501 branch; keep the quarantine check above it untouched. Then grep tests asserting `completed` (`grep -rn "executed successfully through mesh" packages apps`) and update them to the 501 contract; if the integration loop depends on it, record the dependency in the commit message instead of re-faking success.
- [ ] **Step 4: Run `pnpm --filter @exocortex/mesh test` and core tests; pass.**
- [ ] **Step 5: Commit** `fix(mesh): stop fabricating playbook execution results`

### Task 7: Containment guard for archival pruning (H3, interim)

**Files:**
- Modify: `packages/databank/archive.ts:71`, `packages/memory/archive-client.ts` (`prune` branch near :223)
- Test: `packages/databank/archive.test.ts` (create if absent), `packages/memory/archive-client.test.ts`

**Interfaces:**
- Produces: both archive functions throw `Error("Memory pruning is disabled until concurrent writers are coordinated")` when `opts.prune` is truthy, before any file mutation.

- [ ] **Step 1: Write failing tests** `prune:true rejects and leaves the memory file and backups untouched` for each package; keep existing non-prune tests.
- [ ] **Step 2: Run; expect FAIL.**
- [ ] **Step 3: Implement** the guard at the top of each function; find callers with `grep -rn "prune" packages apps --include=*.ts` and make CLI/daemon callers surface the error instead of swallowing it. Update tests that exercised pruning to assert the rejection.
- [ ] **Step 4: Run databank and memory suites; pass.**
- [ ] **Step 5: Commit** `fix(archive): disable pruning until writers are coordinated`

### Task 8: Full verification

- [ ] **Step 1:** `pnpm -r typecheck` → 0 errors.
- [ ] **Step 2:** `pnpm -r test` → all pass except the sibling-service integration test (`every local project answers through one delegate path`), which is pre-existing and tracked under Deferred.
- [ ] **Step 3:** `git status --short` shows only files named in this plan.

## Deferred (separate plans)

- H4 Windows process-tree termination (Job Object or `taskkill /T`), M3 `encryptStream` pipeline refactor, M4 blob verify-on-dedupe, M5 pending-alias key registration (needs device test), M7 bounded Docker output, M8 immutable candidate snapshot, real prune synchronization, isolated integration fixtures, dependency audit rerun.

## Self-review

- Coverage: H1, H2, H3 (interim), M1, M2, M6, typecheck each map to one task; deferred items listed.
- Order: Task 1 first so typecheck gates later commits; Tasks 2-3 (security) before correctness.
- Signatures: `insertedEvents` named identically in Tasks 4's db and server steps; `deviceHasScope` signature copied from `server.ts:175`.
- Unverified assumptions to confirm during execution: the shadow read-only action allowlist (Task 2 step 4), and which test file hosts the mesh delegate handler tests (Task 6).
