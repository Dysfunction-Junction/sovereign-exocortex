# Security findings and implementation handoff for Claude Code

Reviewed: 2026-10-22. Baseline: `c291588097047dbe3f776e6824180935ad412782`.

## Instructions to the implementing agent

Review these findings against the checkout before changing code. Implement small, independently tested patches; avoid unrelated refactoring. This handoff is not an applied patch or a claim that every suggested snippet is production-ready.

- Start with archive encryption, repair execution isolation, repair path protection, then delegation authentication and client hardening.
- Preserve existing approval signatures, shadow-mode checks, circuit breakers, Host/Origin checks, content IDs, and archive readability.
- Do not read or print real credentials, run exploit tests against live services, migrate real archives, or change deployment secrets without explicit authorization.
- Use synthetic keys, disposable repositories, mocked integrations, and ephemeral ports.
- Do not commit unless asked. Report changes, exact test commands/results, remaining risks, and any migration/deployment action required.
- Snippets below are proposed integration inputs, not complete replacements. Names marked proposed need implementation and tests.
- No application fixes were made as part of producing this document.

## Evidence and priority

These are source-confirmed defects or hardening gaps, not evidence of a compromise:

1. **High:** archive encryption has only 32 random bits of cross-blob nonce separation.
2. **High if repairs are untrusted:** repair verification executes with host privileges, not in a security sandbox.
3. **Medium:** protected repair paths are checked incompletely and before canonical policy evaluation.
4. **Medium, local-process threat:** memory delegation skips configured authentication and trusts a self-declared sender.
5. **Medium, defense in depth:** desktop CSP is disabled.
6. **Medium, device-compromise threat:** mobile bearer tokens use ordinary Preferences storage.
7. **Medium when HTTP is used:** Android permits cleartext app-wide.

The final audit pass ran 25 targeted tests successfully. This is not a full test-suite, native-build, hardware-biometric, or production-integration certification.

## 1. Archive encryption: replace XDB2 writes with independently keyed XDB3 blobs

### Evidence

`packages/databank/crypto.ts`:

- `DatabankKeys` derives one `blobKey` for the entire master key.
- `PREFIX_LEN = 4`; `encryptStream()` chooses `randomBytes(PREFIX_LEN)`.
- `nonceFor()` concatenates that prefix with an eight-byte frame index, starting at zero for each blob.

Two encrypted blobs with the same prefix reuse AES-GCM key/nonce pairs at matching frame indices. Collision probability is approximately `1 - exp(-n(n-1)/(2 * 2^32))`: roughly 39% at 65,536 encryptions under the same key. Confidentiality fails for overlapping ciphertext bytes; authentication security also degrades. This is not recovery of the AES master key.

Deduplication in `packages/databank/blobstore.ts` occurs after encryption and is not a nonce-uniqueness mechanism.

### Surgical suggested code inputs

Keep legacy derivations and the ID HMAC unchanged. Add a per-blob derivation method to `DatabankKeys`, using its existing blob key as HKDF input:

```ts
// Proposed addition inside DatabankKeys.
deriveBlobKey(salt: Buffer): Buffer {
  if (salt.length !== 32) throw new Error("invalid XDB3 salt length");
  return Buffer.from(hkdfSync(
    "sha256",
    this.blobKey,
    salt,
    "exocortex-databank/xdb3/frame-key/v1",
    32,
  ));
}
```

Suggested new format:

```text
XDB3 header = magic(4) || random_salt(32)
per-blob key = deriveBlobKey(random_salt)
frame nonce = zero(4) || frame_index_u64be
frame AAD = entire_header || frame_index_u64be || final_flag(1)
frame = ciphertext_length_u32be || ciphertext || GCM_tag(16)
```

Reuse the current framing, frame size, final-frame detection, streaming behavior, and tag length. Replace only format initialization and the key/nonce/AAD inputs to seal/open operations:

```ts
const salt = randomBytes(32);
const header = Buffer.concat([Buffer.from("XDB3"), salt]);
const frameKey = keys.deriveBlobKey(salt);
// Write header, then seal every frame with frameKey.
// nonceFor(Buffer.alloc(4), index) can retain the existing nonce layout.
// New AAD must bind header, index, and final flag; do not reuse XDB2's aadFor().
```

Integration requirements:

- Separate `LEGACY_MAGIC` and new write-format constants; do not simply change `MAGIC` and break old reads.
- Reader dispatches explicitly on XDB2/XDB3 magic. Preserve the exact XDB2 decoder for old archives; reject unknown formats without downgrade retries.
- Accumulate partial headers correctly before deriving the XDB3 key.
- Store one derived key per blob, not one HKDF derivation per frame.
- Reject indices outside a documented safe range before nonce construction; if using JS numbers, require nonnegative safe integers and reject counter exhaustion.
- Salt uniqueness is probabilistic at 256 bits. Do not claim safety if the same salt is deliberately reused.
- Do not substitute a new random nonce independently per frame without a fully specified authenticated streaming format.

### Compatibility and migration

Existing IDs are HMACs of plaintext. Retain `idKey` derivation so IDs, index references, and deduplication remain stable.

**Important:** calling `BlobStore.put()` to migrate an existing blob will deduplicate and retain the old XDB2 file. A migration needs an explicit rewrite path.

An opt-in migration should: lock out concurrent writers; decrypt the old blob into the new encryptor without plaintext files; write a temporary XDB3 blob on the same filesystem; verify its complete authentication, size, and plaintext HMAC against the existing ID; flush it; then perform a platform-tested replacement. Preserve originals/backups until verification completes. Test interruption/restart and Windows rename/replacement behavior. Do not bulk-rewrite live data by default.

Re-encryption does not undo exposure of previously copied vulnerable ciphertext. Master-key rotation is a separate operation because it also changes current content IDs.

### Acceptance tests

Extend `packages/databank/test/crypto.test.ts` and `test/blobstore.test.ts`:

- Existing fixed XDB2 fixtures remain readable; default writes are XDB3.
- Empty, tiny, exact-frame, multi-frame, and arbitrarily chunked streams round-trip.
- Different salts derive different keys even at equal frame indices.
- A deterministic synthetic XDB2 prefix-collision test demonstrates keystream reuse; no probabilistic collision test.
- Wrong key, salt/header tampering, frame reorder, truncation, missing final frame, oversized lengths, trailing data, and unknown magic fail.
- Same plaintext retains its existing HMAC ID; repeated writes deduplicate.
- Migration replaces an existing XDB2 blob rather than silently deduplicating it; corruption and interrupted migration preserve a recoverable original.

## 2. Repair execution: fail closed without a real isolated runner

### Evidence

`packages/triad/triad/morphogenetic.py`, `evaluate_mutation_in_sandbox()`:

- `subprocess.run(verification_command, cwd=str(sandbox), ..., timeout=120)` executes on the host.
- No explicit `env` means full environment inheritance.
- A git worktree isolates source changes, not access to host files, processes, credentials, or networking.
- An argv list avoids shell interpolation but does not make a hostile executable, test, import, or package script safe.

Severity depends on whether externally generated repairs reach this method. Do not describe this as proven unauthenticated remote code execution.

### Surgical containment change

Prefer a small injected runner interface instead of embedding a new sandbox subsystem here. The following is an **interface sketch**; implement the runner and update callers/tests:

```python
from typing import Protocol

class VerificationRunner(Protocol):
    def run(
        self, *, workspace: Path, profile: str, timeout: int
    ) -> subprocess.CompletedProcess[str]: ...

# Add an optional runner dependency to MorphogeneticEngine.__init__.
# In evaluate_mutation_in_sandbox, before executing candidate code:
if self.verification_runner is None:
    candidate.verification_output = (
        "Darwinian Rejection: isolated verification runner unavailable"
    )
    return False
```

Resolve a fixed verification profile through trusted configuration instead of accepting arbitrary candidate-selected argv. Update public callers deliberately; do not silently fall back to host execution.

For tests only, inject a fake runner. If a trusted-local development runner is retained, require explicit opt-in and label it **unsafe for untrusted repairs**. Keep any real invocation behind that boundary.

The isolated runner must enforce:

- Separate unprivileged identity/OS boundary; no host home directory, service secrets, credential stores, SSH agent, Docker socket, or shared git metadata mounted writable.
- Disposable workspace and scratch storage; trusted harness/configuration mounted read-only; no network by default.
- Trusted absolute executable paths and command profiles outside candidate control.
- Explicit minimal environment, including only essential platform variables; no inherited `PYTHONPATH`, `NODE_OPTIONS`, token variables, or user-controlled executable search path.
- CPU/memory/process/output quotas, timeout, and complete descendant termination.
- Post-execution changed-file validation: reject unexpected files, staged changes, harness modifications, and changes outside the declared target.

**Environment filtering alone is not a fix:** code running as the host user can still read that user's files. A container with host bind mounts or daemon credentials is not sufficient either. If a supported isolation backend is unavailable on Windows, reject untrusted evaluation and report the prerequisite.

### Small related state fix

Reset reusable candidate result state at the start of evaluation so a later failed attempt cannot retain an earlier successful diff:

```python
candidate.survival_passed = False
candidate.unified_diff = ""
candidate.verification_output = ""
```

Generate the final diff using the canonical relative path with literal Git pathspec handling, and only mark survival after successful runner and diff checks. A zero exit status by itself is not proof that a meaningful trusted test suite ran.

### Acceptance tests

Extend `packages/triad/triad/tests/test_morphogenetic.py`:

- No configured runner means no verification subprocess executes and no survivor is produced.
- Fake runners cover pass/fail/timeout and preserve existing trial semantics without executing hostile host code.
- A previous successful candidate reevaluated unsuccessfully has an empty diff and false survival flag.
- Supported backend integration tests use fake sentinel credentials/files: no environment leak, host-file read/write, outbound network, or surviving child processes.
- Additional/staged/harness mutations are rejected even if verification returns zero.
- Do not run adversarial host-access tests outside a genuine isolated backend.

## 3. Repair paths: apply policy to canonical paths and reject link aliases

### Evidence

In `packages/triad/triad/morphogenetic.py`, `_resolve_within()` already resolves paths and rejects escape outside the worktree. **Preserve that containment check.**

The later policy uses the original string:

- `"/tests/" in norm_target` misses root-level `tests/helper.py`.
- `test_example.py` does not match the existing suffix checks.
- An in-root symlink alias can resolve to a protected target while its input string looks unprotected.

### Suggested helper

Add this next to `_resolve_within()` and call it on the resolved target before reading/writing:

```python
def _is_protected_target(self, root: Path, target: Path) -> bool:
    rel = target.relative_to(root.resolve())
    parts = tuple(part.casefold() for part in rel.parts)
    name = parts[-1]
    return (
        any(part in {"test", "tests", "__tests__", ".github", ".git"}
            for part in parts)
        or any("invariants" in part for part in parts)
        or name.startswith("test_")
        or name.endswith(("_test.py", "test.py"))
        or any(name.endswith(suffix) for suffix in (
            ".test.ts", ".test.tsx", ".test.js", ".test.jsx",
            ".spec.ts", ".spec.tsx", ".spec.js", ".spec.jsx",
        ))
    )
```

Additional integration rules:

- Reject absolute, drive-qualified, UNC, and Windows alternate-data-stream paths at input. Reject unexpected separator syntax rather than interpreting it differently on different operating systems.
- Reject symlink/reparse-point components before writing, including in-root aliases. Use a platform-supported strategy; do not assume `is_symlink()` identifies every Windows junction.
- Use canonical `target.relative_to(sandbox).as_posix()` for policy and diff generation; evaluate lexical protected components too if aliases are ever permitted.
- Keep verification configuration, lockfiles, package scripts, and the runner/harness explicitly immutable or require separate human review. Filename patterns alone cannot identify every harness dependency.
- Canonicalization is not race-proof isolation. The runner boundary in finding 2 remains necessary.

Tests: root/nested test directories, `test_example.py`, `.spec.*`, `.github`, invariants, `..` normalization, case variation, mixed separators, in-root aliases to protected files, outward links, and Windows-specific paths. Test ordinary source-file mutations still work. Skip link tests with an explicit reason where the platform cannot create links.

## 4. Memory delegation: remove the loopback authentication exemption

### Evidence and threat model

`packages/memory/server.ts:300` computes `loopbackDelegate` and omits configured-token checks when it is true. `memory.add` then authorizes `body.from` against a name allowlist.

Any local process can make a matching request and self-declare an allowed sender. Host/Origin checks mitigate browsers and DNS rebinding; they are not service authentication. This does not, by itself, prove cross-user file access or remote exploitation.

### Minimal patch

Remove the `loopbackDelegate` exception from the existing token check:

```diff
- if (gatewayToken && gatewayToken.trim().length > 0 && !loopbackDelegate) {
+ if (gatewayToken && gatewayToken.trim().length > 0) {
```

Keep the existing constant-time comparison and browser/loopback guards. Remove the now-unused exemption variable and update its misleading comment.

This closes the bypass **only when a token is configured**. Make memory writes fail closed when no credential is configured; choose and document whether all delegate memory operations should require configuration. Do not silently leave `memory.add` unauthenticated in no-token mode.

Update the daemon's `relayEnvelope()` in `apps/daemon/src/network.ts` to send the memory service credential only to `pieces-for-all`:

```ts
// Proposed addition alongside the existing triad-only Authorization header.
...(envelope.to === "pieces-for-all" &&
    (env.GATEWAY_TOKEN ?? env.PIECES_GATEWAY_TOKEN)?.trim()
  ? { Authorization:
      `Bearer ${(env.GATEWAY_TOKEN ?? env.PIECES_GATEWAY_TOKEN)!.trim()}` }
  : {}),
```

Inventory all other memory callers and the launch environment before rollout. Preserve triad credential handling; never forward either service's token to another node. Normalize blank configuration consistently at both ends.

**Authorization limit:** a shared bearer token proves membership, not the truth of `body.from`. If sender-specific rights matter, use a proposed injected credential-to-principal map with per-service credentials, compare against its trusted values, and require `body.from === authenticatedPrincipal`. Do not claim the one-line patch implements this. Also review the gateway's ability to forward arbitrary sender names before assigning it impersonation authority.

Local processes running as the same OS user may still read that user's secrets; meaningful stronger separation needs OS accounts/IPC ACLs.

### Acceptance tests

Extend `packages/memory/test/server.test.ts` and `apps/daemon/src/network.test.ts`:

- Configured token + missing/wrong token + allowed spoofed sender returns 401 and performs no write.
- Valid credential + authorized caller succeeds; unauthorized caller returns 403.
- No configured credential cannot write memory.
- Browser Origin/rebound Host remains rejected even with valid credentials.
- Memory credential reaches only the memory service; triad credential reaches only triad.
- If per-service credentials are implemented, mismatched authenticated principal/from is rejected.

## 5. Desktop: enable CSP without breaking IPC or graph rendering

### Evidence

`apps/desktop/src-tauri/tauri.conf.json:30` has `"csp": null`; global Tauri exposure is enabled. `apps/desktop/src-tauri/src/lib.rs` exposes `get_local_config`, which obtains credentials for the frontend.

`capabilities/default.json` currently contains `core:default`, not unrestricted shell/filesystem grants. Do not misreport that as arbitrary native execution. Global IPC availability is an impact multiplier if script injection occurs, not an injection vulnerability by itself.

### Suggested starting policy

Replace the null CSP with a tested production policy. This is a **starting template**, not a validated drop-in:

```json
{
  "csp": "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self'; connect-src 'self' ipc: http://ipc.localhost http://127.0.0.1:8787 http://127.0.0.1:8788; object-src 'none'; base-uri 'self'; frame-src 'none'; form-action 'none'"
}
```

Inventory actual connections/assets/workers first. Add only necessary explicit origins and directives; do not fix breakage with `script-src 'unsafe-eval'`, unrestricted `connect-src *`, or disabling CSP again. Development HMR permissions belong in a separate development policy.

Do not switch `withGlobalTauri` off alone: `apps/mobile/src/lib/config.ts` currently uses its globals to invoke `get_local_config`. To disable it, add/use the supported `@tauri-apps/api/core` import and adapt platform detection in the same change.

The graph's `nodeLabel` path in `apps/mobile/src/pages/LivingBrain.tsx` warrants DOM review. Prefer labels constructed with `textContent`/text nodes over untrusted HTML strings. If formatting is needed, construct the DOM explicitly; do not assume CSP or React escapes a third-party HTML tooltip sink.

Acceptance: production WebView smoke test for startup, local pairing/IPC, graph/tooltips, fonts/assets, and API calls; injected label HTML displays inertly; CSP blocks inline scripts and unexpected network origins. No script-execution exploit was demonstrated by the prior tooltip checks.

## 6. Mobile tokens: encrypt credential storage and migrate safely

### Evidence

`apps/mobile/src/lib/config.ts` uses `Preferences.set()` for `proxyToken` and `remoteGatewayToken`. Capacitor Preferences is native storage, not encrypted credential storage. The Android manifest already has `allowBackup="false"`; do not claim ordinary Android backups currently expose these tokens.

### Surgical integration contract

Keep URLs/UI preferences in Preferences. Route only credential keys through a small storage adapter, preserving the existing public `get*/set*/clearConfig` functions:

```ts
// Proposed interface, not an existing plugin API.
interface CredentialStore {
  get(key: string): Promise<string | null>;
  set(key: string, value: string): Promise<void>;
  remove(key: string): Promise<void>;
}
```

Implement Android with a vetted maintained secure-storage dependency after review, or a small Capacitor plugin following the existing Java plugin pattern. Register any native plugin in `MainActivity.java`.

For a custom implementation:

- Generate a non-exportable Android Keystore AES key dedicated to credentials, separate from the approval signing key.
- Use `AES/GCM/NoPadding`, a fresh provider-generated IV for every encryption, a 128-bit tag, and the credential name as AAD.
- Persist only a versioned IV+ciphertext+tag envelope in app-private storage. Fail closed on malformed envelopes, tampering, or invalidated keys.
- Do not require a biometric prompt for every background sync read unless explicitly changing the product behavior.
- No silent fallback to plaintext after native failure. Define browser and Tauri storage separately; an Android plugin cannot secure their backends.

Migration per token: read legacy value once; encrypt and persist; read/decrypt and verify; only then delete the plaintext key. If interrupted after encrypted persistence, prioritize and verify encrypted storage, then remove the leftover legacy value. On verification failure preserve the legacy value for recovery and surface an actionable error; never erase the only working credential first.

Acceptance: plaintext absent after successful migration; clear removes encrypted and legacy copies; tampering/key invalidation returns no token; interrupted migration is recoverable; background sync and approval signing still work; desktop/browser tests use explicit platform adapters.

## 7. Android transport: restrict HTTP instead of merely changing the manifest

### Evidence

`apps/mobile/android/app/src/main/res/xml/network_security_config.xml` contains `<base-config cleartextTrafficPermitted="true" />`. Its comment accurately states that this is app-wide, not private-subnet-only.

Any configured HTTP endpoint transmits bearer tokens and capture data without TLS. Tailscale HTTPS protects that route; an HTTP LAN profile is a separate exposure.

### Suggested secure default

After providing a supported HTTPS/Tailscale path and migration UI, change the production base:

```xml
<network-security-config>
    <base-config cleartextTrafficPermitted="false" />
</network-security-config>
```

If USB/loopback HTTP is required, add narrowly tested literal loopback exceptions or a debug resource overlay; do not re-enable app-wide cleartext. Android domain entries cannot express arbitrary private CIDR ranges.

Validate URLs at both configuration and request boundaries. Add a shared URL policy helper used by `setProxyBaseUrl`, `setRemoteGatewayUrl`, and connection dispatch so legacy stored values cannot bypass validation:

- HTTPS required for production non-loopback connections.
- Reject embedded credentials, unsupported schemes, and unexpected URL paths/query/fragment according to the API's base-URL contract.
- Treat explicit loopback/debug HTTP as a separate policy, not any hostname containing "localhost".
- Offer a user-visible migration error for an old LAN HTTP profile rather than silently sending a token or silently losing connectivity.
- Do not disable certificate validation.

Acceptance: production cleartext non-loopback requests fail before credentials are sent; HTTPS works; legacy HTTP profiles receive actionable migration guidance; any intentional loopback/debug behavior has dedicated tests. TLS changes must be tested on Android hardware/emulator, not only JS mocks.

## Already corrected findings: retain regression coverage

- `apps/daemon/src/network.ts` rejects generic approve/reject forwarding. Do not reintroduce it to simplify routing.
- `/network/approve` enforces biometric verification, shadow mode, and breaker checks.
- Mesh/core/memory delegates contain Origin/Host protections. Do not report a demonstrated browser CSRF exploit on these guarded paths.
- Android disables backups; FileProvider is not exported. Broad `external-path`/`cache-path` scope is a least-privilege review item, not proof that any app can read files without a URI grant.

## Secondary review queue: do not inflate into confirmed vulnerabilities

- `packages/mesh/mishmash-delegate.ts`: local-process trust remains despite browser guards; assess mutating actions and reuse a reviewed service-auth pattern.
- `packages/triad/triad/server.py`: no-token behavior varies by endpoint; some sensitive endpoints require token configuration. Inventory actual handlers before claiming all routes are open.
- Archive index/metadata may need separate at-rest protection; blob encryption does not automatically encrypt searchable indexes. Verify deployment volume encryption and filesystem ACLs.
- Re-run Node/Rust dependency advisories against current locks and assess production reachability. Earlier advisory results are not a fresh scan and do not justify blind upgrades.
- Keep backend loopback binding and deployment proxy identity assumptions explicit. Do not broaden header trust.
- Verify FileProvider consumers before narrowing paths; use dedicated share subdirectories if sharing is needed.
- Real Android key attestation, native CSP enforcement, isolated-runner security, and production exposure still need integration verification.

## Validation commands and handback

Use package-specific runners; the core/mesh/mobile tests use Vitest while daemon/databank use Node tests through tsx. Do not run Vitest test files directly with `node --test`.

```powershell
# From repository root.
pnpm --filter @exocortex/databank test
pnpm --filter @exocortex/databank typecheck
pnpm --filter @exocortex/memory test
pnpm --filter @exocortex/memory typecheck
pnpm --filter @exocortex/core exec vitest run mishmash-delegate-guard.test.ts
pnpm --filter @exocortex/mesh test
node --import tsx --test apps/daemon/src/network.test.ts apps/daemon/src/shadow-actuation.test.ts apps/daemon/src/audit-fixes.test.ts
pnpm --filter @exocortex/daemon typecheck
pnpm --filter @exocortex/mobile test
pnpm --filter @exocortex/mobile typecheck
pnpm --filter @exocortex/mobile lint
pnpm --filter @exocortex/mobile build
git --no-pager diff --check
```

Python: use a development interpreter/environment installed from `packages/triad/pyproject.toml`; from `packages/triad`, run `python -m pytest triad/tests/test_morphogenetic.py` and `python -m ruff check triad/morphogenetic.py triad/tests/test_morphogenetic.py`. Do not assume a virtualenv already exists. Update sandbox-dependent tests to inject a fake runner before adopting a fail-closed default.

For native changes, inspect available SDK/toolchain setup before running Android Gradle builds or Tauri builds. Record unsupported targets and hardware checks explicitly.

Hand back:

- Each finding: fixed, partially mitigated, deferred, or not reproduced, with evidence.
- Changed files and exact tests/results, distinguishing pre-existing failures.
- XDB2/XDB3 compatibility and migration behavior.
- Any new service credentials/caller deployment requirements, without their values.
- Remaining isolation/platform limitations and explicit manual rollout steps.
