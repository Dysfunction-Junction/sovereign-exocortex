# Security Handoff Remediation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close the seven findings in the Warp security handoff with small, independently tested patches.

**Architecture:** One task per finding, ordered by the handoff's priority (archive encryption, repair isolation, repair paths, delegation auth, then client hardening). Each task keeps existing behaviour (approval signatures, shadow mode, breakers, Host/Origin checks, content IDs, readable XDB2 archives) and adds a fail-closed default plus tests.

**Tech Stack:** TypeScript (Node `node:test` via tsx for daemon/databank; Vitest for core/mesh/mobile), Python/pytest/ruff (`packages/triad`), Tauri 2, Capacitor/Android (Java plugins).

**Spec:** `docs/SECURITY_HANDOFF_CLAUDE_CODE_2026-10-22.md` (baseline `c291588`). Re-read the matching section before each task.

## Global Constraints

- Do not read or print real credentials, run exploits against live services, migrate real archives, or change deployment secrets. Use synthetic keys, disposable repos, mocked integrations, ephemeral ports.
- Do not commit unless the user authorizes it. Every "Commit" step below runs only after that approval; otherwise leave changes in the working tree.
- Preserve: approval signatures, shadow-mode checks, circuit breakers, Host/Origin checks, content IDs (`idKey` HMAC), XDB2 readability, and `/network/approve` biometric gate. Never reintroduce generic approve/reject forwarding in `apps/daemon/src/network.ts`.
- Never add `unsafe-eval`, `connect-src *`, plaintext token fallbacks, or disabled certificate validation.
- Final report must state per finding: fixed / partially mitigated / deferred / not reproduced, with exact test commands and results, pre-existing failures called out, and any new credentials or rollout steps (no values).
- Verification commands (from the handoff): `pnpm --filter @exocortex/databank test`, `pnpm --filter @exocortex/memory test`, `node --import tsx --test apps/daemon/src/network.test.ts apps/daemon/src/shadow-actuation.test.ts apps/daemon/src/audit-fixes.test.ts`, `pnpm --filter @exocortex/mobile test`, typecheck/lint per package, `git --no-pager diff --check`; Python from `packages/triad`: `python -m pytest triad/tests/test_morphogenetic.py` and `python -m ruff check triad/morphogenetic.py triad/tests/test_morphogenetic.py`.

## Review Focus

- Memory write with no gateway token configured: must be rejected, not silently open (Task 1).
- Blob written with a deliberately fixed salt or an XDB3 header truncated mid-salt across chunk boundaries: must fail or parse correctly, never mis-derive a key (Task 2).
- Migration interrupted after the temp file is written but before replace: original XDB2 blob must remain readable (Task 3).
- Windows paths for repairs (`tests\helper.py`, `C:\x`, `a.py:stream`, junctions, mixed case): must be rejected or treated as protected (Task 4).
- A candidate re-evaluated after an earlier success must not keep the old diff/survival flag (Task 5).
- Legacy stored `http://` mobile URL with a token: must fail before any request carrying the token is sent (Task 8).

---

### Task 1: Memory delegation requires the gateway token (finding 4)

**Files:**
- Modify: `packages/memory/server.ts:300-320` (token check), `:380-393` (`memory.add` gate)
- Modify: `apps/daemon/src/network.ts:144-150` (`relayEnvelope` headers)
- Test: `packages/memory/test/server.test.ts`, `apps/daemon/src/network.test.ts`

**Interfaces:**
- Consumes: existing `gatewayToken`, `safeCompareTokens`, `isTrustedDelegateRequest`, `DELEGATE_UPSTREAMS`.
- Produces: `/mishmash/delegate` on the memory server returns 401 without a valid token when one is configured, and `memory.add` returns 401 when no token is configured. Daemon sends `Authorization: Bearer <GATEWAY_TOKEN ?? PIECES_GATEWAY_TOKEN>` only when `envelope.to === "pieces-for-all"`.

- [ ] **Step 1: Write failing tests** in `server.test.ts`: `delegate rejects missing token even from trusted loopback` (token configured, valid `from`, expect 401 and no write); `delegate rejects wrong token` (401); `delegate with valid token and allowed sender succeeds`; `memory.add with no configured token is rejected` (expect 401, nothing stored); `browser Origin with valid token still 403`. In `network.test.ts`: `memory token goes only to pieces-for-all` and `triad token goes only to autonomous-triad` (assert headers on a mocked `fetchImpl`).
- [ ] **Step 2: Run** `pnpm --filter @exocortex/memory test` and the daemon `node --import tsx --test` command. Expected: the new tests FAIL.
- [ ] **Step 3: Implement** in `server.ts`: delete `loopbackDelegate` and its comment; keep the token check unconditional when configured; in the `memory.add` branch, before the caller allowlist, return 401 `{error: "memory writes require a configured gateway token"}` when `gatewayToken` is blank. Normalize blank tokens with `.trim()` in both places.
- [ ] **Step 4: Implement** in `network.ts` `relayEnvelope`: add the `pieces-for-all` Authorization spread next to the triad one; trim the token; send nothing when blank.
- [ ] **Step 5: Run** the same commands plus `pnpm --filter @exocortex/memory typecheck` and `pnpm --filter @exocortex/daemon typecheck`. Expected: PASS, and existing delegate tests updated to supply a token.
- [ ] **Step 6: Inventory** other memory callers: `Grep` for `mishmash/delegate` and `pieces-for-all` across `apps/` and `packages/`; list each caller and its launch env in the final report as a required rollout step (set `GATEWAY_TOKEN` for daemon and memory).
- [ ] **Step 7: Commit (if authorized)** `fix(memory): require gateway token for delegated writes`.

---

### Task 2: XDB3 per-blob keyed format (finding 1, part 1)

**Files:**
- Modify: `packages/databank/crypto.ts`
- Test: `packages/databank/test/crypto.test.ts`

**Interfaces:**
- Produces: `DatabankKeys.deriveBlobKey(salt: Buffer): Buffer` (HKDF-SHA256 from `this.blobKey`, info `"exocortex-databank/xdb3/frame-key/v1"`, 32 bytes; throws `"invalid XDB3 salt length"` unless salt is 32 bytes). Exports `LEGACY_MAGIC = "XDB2"` and `MAGIC_V3 = "XDB3"`. `encryptStream` signature unchanged but writes XDB3. `decryptTransform` signature unchanged and dispatches on magic.

- [ ] **Step 1: Write failing tests** in `crypto.test.ts` (names are the assertions' subject):
  - `fixed XDB2 fixture still decrypts` — build the fixture with a test-local copy of the old sealer using a fixed key/prefix so it is deterministic.
  - `default writes start with XDB3 magic and 32-byte salt`.
  - `round-trips empty, 1 byte, exactly FRAME_SIZE, FRAME_SIZE+1, multi-frame, and 7-byte chunking`.
  - `different salts derive different frame keys`.
  - `synthetic XDB2 prefix collision reuses keystream` — two legacy blobs with the same prefix and same plaintext XOR to identical ciphertext; documents the defect, no probabilistic loop.
  - `rejects`: wrong key, flipped salt byte, reordered frames, truncated (missing final frame), oversized length, trailing data, unknown magic, header split across chunks still parses.
- [ ] **Step 2: Run** `pnpm --filter @exocortex/databank test`. Expected: new tests FAIL.
- [ ] **Step 3: Implement** `deriveBlobKey` exactly as in handoff §1. In `encryptStream`, write `header = MAGIC_V3 || randomBytes(32)`, derive `frameKey` once, use nonce `zero(4) || u64be(index)` (reuse `nonceFor(Buffer.alloc(4), index)`), AAD = `header || u64be(index) || final_flag` via a new `aadV3(header, index, final)`. Guard index with `Number.isSafeInteger(index) && index >= 0` before nonce construction.
- [ ] **Step 4: Implement** reader dispatch in `decryptTransform`: buffer 4 bytes, branch to the untouched XDB2 path (rename `MAGIC`→`LEGACY_MAGIC`; keep `aadFor`/`nonceFor` legacy behaviour) or the XDB3 path (needs 36 header bytes before deriving the key); any other magic throws `"not an XDB blob"` with no retry. Keep one derived key per blob.
- [ ] **Step 5: Run** `pnpm --filter @exocortex/databank test` and `pnpm --filter @exocortex/databank typecheck`. Expected: PASS.
- [ ] **Step 6: Extend `blobstore.test.ts`**: `same plaintext keeps its HMAC id and dedupes`; `get() reads both XDB2 and XDB3 blobs`; `verify() passes for both`. Run `pnpm --filter @exocortex/databank test`. Expected: PASS.
- [ ] **Step 7: Commit (if authorized)** `fix(databank): XDB3 per-blob HKDF keys, keep XDB2 readable`.

---

### Task 3: Explicit XDB2→XDB3 migration (finding 1, part 2)

**Files:**
- Modify: `packages/databank/blobstore.ts`
- Test: `packages/databank/test/blobstore.test.ts`

**Interfaces:**
- Consumes: Task 2 `encryptStream`, `BlobStore.get/pathFor/verify`.
- Produces: `BlobStore.rewriteLegacy(id: string): Promise<{ id: string; migrated: boolean }>`; returns `migrated: false` when the blob is already XDB3. Opt-in only; nothing calls it by default.

- [ ] **Step 1: Write failing tests**: `rewriteLegacy replaces an XDB2 blob (file now starts with XDB3, same id, plaintext identical)`; `rewriteLegacy is a no-op for XDB3`; `corrupt legacy blob leaves original untouched and throws`; `failure injected after temp write keeps original readable and removes temp`; `put() of existing XDB2 content still dedupes and does NOT migrate` (documents the trap). Build XDB2 blobs with the test-local legacy sealer from Task 2.
- [ ] **Step 2: Run** `pnpm --filter @exocortex/databank test`. Expected: FAIL (`rewriteLegacy` missing).
- [ ] **Step 3: Implement** `rewriteLegacy`: read the first 4 bytes to detect magic; stream `this.get(id)` into `encryptStream` writing to a `tmp/*.part` file; require returned `id` to equal `id`; fsync (same `open(tmp,"r+")` pattern as `put`); verify by decrypting the temp file fully against the id; then replace the original using `rename` over the target, with a `.bak` of the original kept until the rename succeeds and a Windows-safe fallback (rename original to `.bak`, rename temp into place, delete `.bak`). On any error remove the temp and restore the original.
- [ ] **Step 4: Run** the databank tests and typecheck. Expected: PASS. Note in the final report that no CLI/default migration runs and master-key rotation is out of scope.
- [ ] **Step 5: Commit (if authorized)** `feat(databank): opt-in XDB2 to XDB3 blob rewrite`.

---

### Task 4: Canonical protected-path policy for repairs (finding 3)

**Files:**
- Modify: `packages/triad/triad/morphogenetic.py` (`_resolve_within` neighbourhood, `evaluate_mutation_in_sandbox:121-135`)
- Test: `packages/triad/triad/tests/test_morphogenetic.py`

**Interfaces:**
- Produces: `MorphogeneticEngine._is_protected_target(self, root: Path, target: Path) -> bool` (handoff §3 body) and `MorphogeneticEngine._validate_rel_input(rel: str) -> Optional[str]` returning an error string for absolute, drive-qualified, UNC, ADS (`:` in any part), or backslash-containing input.

- [ ] **Step 1: Write failing tests** (pure-function level, no subprocess): `_is_protected_target` true for `tests/helper.py`, `pkg/tests/x.py`, `test_example.py`, `a.spec.ts`, `.github/wf.yml`, `invariants/x.py`, `TESTS/x.py` (case), false for `src/app.py`; `_validate_rel_input` rejects `/etc/x`, `C:\x`, `\\srv\s\x`, `a.py:stream`, `a\b.py`; symlink alias `src/alias.py -> tests/helper.py` is rejected (skip with reason if the platform cannot create symlinks); outward symlink rejected; ordinary `src/app.py` mutation still passes the policy.
- [ ] **Step 2: Run** `python -m pytest triad/tests/test_morphogenetic.py` from `packages/triad`. Expected: new tests FAIL.
- [ ] **Step 3: Implement** both helpers. In `evaluate_mutation_in_sandbox`, call `_validate_rel_input` before `_resolve_within`, reject any path component of `sandbox/rel` that `is_symlink()` (also check `os.path.realpath != abspath` as a junction backstop), call `_is_protected_target(sandbox, target_file_path)` on the resolved path, and replace the string-suffix block. Keep `_resolve_within` containment unchanged.
- [ ] **Step 4: Run** pytest and `python -m ruff check triad/morphogenetic.py triad/tests/test_morphogenetic.py`. Expected: PASS, clean.
- [ ] **Step 5: Commit (if authorized)** `fix(triad): apply protected-path policy to canonical targets`.

---

### Task 5: Fail-closed verification runner (finding 2)

**Files:**
- Modify: `packages/triad/triad/morphogenetic.py` (`MorphogeneticEngine.__init__`, `evaluate_mutation_in_sandbox`, `execute_darwinian_trial`)
- Modify: callers found by `Grep "MorphogeneticEngine\|execute_darwinian_trial"` across `packages/triad` and `apps/`
- Test: `packages/triad/triad/tests/test_morphogenetic.py`

**Interfaces:**
- Produces: `class VerificationRunner(Protocol)` with `run(self, *, workspace: Path, profile: str, timeout: int) -> subprocess.CompletedProcess[str]`; `MorphogeneticEngine.__init__(self, repo_root=None, verification_runner: Optional[VerificationRunner] = None, allow_unsafe_host_runner: bool = False)`; `evaluate_mutation_in_sandbox(self, candidate, verification_profile: str, base_commit="HEAD") -> bool` (replaces the `verification_command: List[str]` parameter; `execute_darwinian_trial` changes the same way). `UnsafeHostRunner` class, labelled unsafe, is only used when `allow_unsafe_host_runner=True` and maps a profile name from trusted config to a fixed argv with a minimal explicit `env`.

- [ ] **Step 1: Write failing tests**: `no runner configured -> returns False, verification_output contains "isolated verification runner unavailable", subprocess.run never called for verification` (patch `subprocess.run` and assert no call with the profile); fake runner `pass/fail/timeout` keep existing trial semantics; `re-evaluating a previously successful candidate unsuccessfully clears unified_diff and survival_passed`; `extra staged or untracked file after runner returns 0 -> rejected`; `modified harness file -> rejected`; `UnsafeHostRunner env excludes inherited tokens and PYTHONPATH` (sentinel env var not visible).
- [ ] **Step 2: Run** pytest. Expected: FAIL.
- [ ] **Step 3: Implement**: reset `survival_passed`, `unified_diff`, `verification_output` at the top of evaluation; reject when no runner; run via `self.verification_runner.run(...)` instead of host `subprocess.run`; after a zero exit, run `git status --porcelain` in the sandbox and reject if anything other than the single canonical target changed; generate the diff with `git diff --` using `target.relative_to(sandbox).as_posix()` and `:(literal)` pathspec; set `survival_passed` only after those checks. Resolve the profile through a trusted mapping (module-level `VERIFICATION_PROFILES: Dict[str, List[str]]` loaded from config, never from the candidate).
- [ ] **Step 4: Update callers and existing tests** to inject a fake runner or pass `allow_unsafe_host_runner=True` explicitly for trusted-local use. Do not run adversarial host-access tests; real isolation backend (container/VM/Job Object + low-integrity user) is a separate deliverable: write the prerequisite and "no backend on this Windows host" note into the final report.
- [ ] **Step 5: Run** pytest and ruff. Expected: PASS.
- [ ] **Step 6: Commit (if authorized)** `fix(triad): fail closed without an isolated verification runner`.

---

### Task 6: Desktop CSP and inert graph tooltips (finding 5)

**Files:**
- Modify: `apps/desktop/src-tauri/tauri.conf.json:30`
- Modify: `apps/mobile/src/pages/LivingBrain.tsx:371-` (`nodeLabel`)
- Test: `apps/mobile/src/pages/LivingBrain.test.tsx` (create if absent, following nearby test style)

**Interfaces:**
- Produces: `buildNodeLabel(node: GraphNode, role: string, activationPct: string): HTMLElement` exported from a new `apps/mobile/src/lib/graphLabel.ts`, returned to `.nodeLabel()` (library accepts an element); built only with `textContent`.

- [ ] **Step 1: Write failing test** in `graphLabel.test.ts`: `label containing <img src=x onerror=...> renders as text, no img element in the DOM`, and `activation percentage and role badge text appear`.
- [ ] **Step 2: Run** `pnpm --filter @exocortex/mobile test`. Expected: FAIL.
- [ ] **Step 3: Implement** `buildNodeLabel` and replace the template-string HTML at `LivingBrain.tsx:371-` (keep the existing role/colour logic, move it into the helper).
- [ ] **Step 4: Inventory** actual network origins and assets (`Grep` for `fetch(`, `http://`, `wss?://`, `new Worker`, `@font-face` under `apps/mobile/src`), then set `csp` to the handoff §5 template with only the origins found added. Leave `withGlobalTauri` as is: `config.ts` still reads `window.__TAURI__`.
- [ ] **Step 5: Run** `pnpm --filter @exocortex/mobile test`, `typecheck`, `lint`, `build`. Expected: PASS.
- [ ] **Step 6: Manual WebView smoke** (cannot be automated here): `pnpm --filter @exocortex/desktop tauri dev`-equivalent production build; verify startup, `get_local_config` pairing, graph tooltip, fonts, API calls, and that an inline script is blocked in the console. If no Tauri toolchain is available, record "not verified" in the report.
- [ ] **Step 7: Commit (if authorized)** `fix(desktop): enable CSP and render graph labels as text`.

---

### Task 7: Encrypted mobile credential storage (finding 6)

**Files:**
- Create: `apps/mobile/src/lib/credentialStore.ts`
- Modify: `apps/mobile/src/lib/config.ts:31-38,49-56,197-205` (token getters/setters/clear)
- Create (Android): `apps/mobile/android/app/src/main/java/.../SecureCredentialsPlugin.java`; register in `MainActivity.java` following the existing plugin pattern (find via `Grep "registerPlugin"`)
- Test: `apps/mobile/src/lib/credentialStore.test.ts`, extend `config.test.ts`

**Interfaces:**
- Produces: `interface CredentialStore { get(key: string): Promise<string | null>; set(key: string, value: string): Promise<void>; remove(key: string): Promise<void> }`; `getCredentialStore(): CredentialStore` (Android plugin on native; explicit in-memory-only adapter on web/desktop, no plaintext Preferences fallback); `migrateLegacyToken(key: string): Promise<void>`. `getProxyToken/setProxyToken/getRemoteGatewayToken/setRemoteGatewayToken/clearConfig` keep their signatures.
- Android plugin: Keystore AES-256 key alias distinct from the approval key, `AES/GCM/NoPadding`, provider IV, 128-bit tag, AAD = credential name, versioned envelope `v1 || iv || ct+tag` in app-private storage; fails closed (returns null) on malformed/tampered/invalidated.

- [ ] **Step 1: Write failing tests** with a fake `CredentialStore` injected into `config.ts`: `setProxyToken stores via credential store, not Preferences`; `migration: legacy Preferences token is encrypted, verified by read-back, then legacy key removed`; `migration verification failure keeps legacy value and surfaces error`; `interrupted migration (encrypted copy exists, legacy remains) prefers encrypted value and removes legacy`; `clearConfig removes both copies`; `store failure never falls back to plaintext`.
- [ ] **Step 2: Run** `pnpm --filter @exocortex/mobile test`. Expected: FAIL.
- [ ] **Step 3: Implement** `credentialStore.ts` and rewire the four token functions plus `clearConfig`; call `migrateLegacyToken` lazily from each getter (migrate-once per key, per the handoff order: read legacy, write encrypted, read back and compare, then delete plaintext).
- [ ] **Step 4: Implement** the Java plugin and registration. Before choosing a custom plugin, check whether a maintained secure-storage Capacitor package is already a dependency (`Grep "secure" apps/mobile/package.json`); prefer it if reviewed and present.
- [ ] **Step 5: Run** mobile test/typecheck/lint/build. If an Android SDK is present, run `./gradlew assembleDebug` in `apps/mobile/android` and an emulator check that background sync and approval signing still work; otherwise record "native not verified".
- [ ] **Step 6: Commit (if authorized)** `feat(mobile): store bearer tokens in Android Keystore-backed storage`.

---

### Task 8: HTTPS-by-default transport and URL policy (finding 7)

**Files:**
- Create: `apps/mobile/src/lib/urlPolicy.ts`
- Modify: `apps/mobile/src/lib/config.ts` (`setProxyBaseUrl`, `setRemoteGatewayUrl`, `getConnectionTargets:162-`), `apps/mobile/src/lib/api.ts` request dispatch
- Modify: `apps/mobile/android/app/src/main/res/xml/network_security_config.xml:14`; add `app/src/debug/res/xml/network_security_config.xml` overlay for debug loopback HTTP
- Test: `apps/mobile/src/lib/urlPolicy.test.ts`, extend `api.test.ts`

**Interfaces:**
- Produces: `validateBaseUrl(raw: string, opts?: { allowLoopbackHttp?: boolean }): { ok: true; url: string } | { ok: false; reason: string }`. Rules: `https:` required unless host is exactly `localhost`, `127.0.0.1`, or `[::1]` and `allowLoopbackHttp` is set; reject embedded credentials, non-http(s) schemes, query, fragment; strip trailing slash. `api.ts` calls it at dispatch so legacy stored values cannot bypass it.

- [ ] **Step 1: Write failing tests**: `https accepted`; `http://192.168.1.5:8787 rejected with actionable reason`; `http://localhost.evil.com rejected` (not substring match); `http://127.0.0.1:8787 accepted only with allowLoopbackHttp`; `user:pw@host rejected`; `ftp: rejected`; in `api.test.ts`, `legacy stored http LAN url -> no fetch is made and no Authorization header is sent, error carries migration guidance`.
- [ ] **Step 2: Run** `pnpm --filter @exocortex/mobile test`. Expected: FAIL.
- [ ] **Step 3: Implement** `validateBaseUrl`; call it in both setters and in `getConnectionTargets`/request dispatch before attaching any token; surface the rejection reason to the existing connection-error UI path.
- [ ] **Step 4: Set** `cleartextTrafficPermitted="false"` in the production base config; add the debug overlay permitting only literal loopback (`127.0.0.1`, `localhost`) cleartext; keep the explanatory comment accurate.
- [ ] **Step 5: Run** mobile test/typecheck/lint/build, then on emulator/hardware (if available) confirm an HTTPS Tailscale target connects and an HTTP LAN target is refused; otherwise record "not verified on device".
- [ ] **Step 6: Commit (if authorized)** `fix(mobile): disable app-wide cleartext, enforce URL policy`.

---

### Task 9: Whole-branch verification and handback

**Files:** none modified; writes `docs/superpowers/plans/2026-10-22-security-handoff-report.md`.

- [ ] **Step 1: Run** every command in Global Constraints plus `git --no-pager diff --check`. Record pass/fail counts and separate pre-existing failures (compare against a clean `git stash` run only if a failure looks unrelated).
- [ ] **Step 2: Write the report** per the handback list: per-finding status, files changed, test results, XDB2/XDB3 compatibility and migration behaviour, new credential/deployment requirements (no values), and remaining limits (no real isolation backend on Windows, native Android/Tauri unverified if toolchains missing, secondary review queue untouched).
- [ ] **Step 3: Request review** with `superpowers:requesting-code-review` on the full diff before any commit or merge.

---

## Self-Review

- **Spec coverage:** findings 1 (Tasks 2, 3), 2 (5), 3 (4), 4 (1), 5 (6), 6 (7), 7 (8), "already corrected" regression coverage (Task 1 keeps daemon approve tests green; Task 9 reruns them), validation commands and handback (Task 9). The secondary review queue is intentionally out of scope.
- **Type consistency:** `evaluate_mutation_in_sandbox` changes from `verification_command: List[str]` to `verification_profile: str` in Task 5 only; Task 4 does not touch its signature. `MAGIC` is renamed to `LEGACY_MAGIC` in Task 2 and later tasks reference `MAGIC_V3`/`LEGACY_MAGIC` only.
- **Proportion:** tasks carry signatures, test names, and decisions; bodies are left to the implementer except where the handoff fixes them.
