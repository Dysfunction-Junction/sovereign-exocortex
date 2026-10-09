# Audit follow-up plan (2026-10-09)

Source: full audit of phases 1-3 (commit `f6d750e`) and the biometric work (`da71391`).
Rule used for policy calls: choose the fail-closed default and record the behaviour change.

## Done

| Area | Item | Commit |
|---|---|---|
| all | 36 confirmed bugs fixed with regression tests | f6d750e |
| daemon/core | Shadow mode (`SHADOW!=0`) blocks `/network/approve` and delegation to `hermes-api` | f6d750e |
| core/daemon | `tap` shadow labels are never overwritten by `inferred`; `/v3/events` labels are not written twice | f6d750e |
| mobile/daemon/triad | Device-bound biometric approvals (Keystore EC P-256, per-use biometric); fabricated `attest_sig_` removed | da71391 |
| triad | Delegated approve/reject fail closed (401) without `TRIAD_SERVER_TOKEN` | da71391 |

## Implemented in the follow-up commit (T1-T4, C1-C3, D1-D2, M1-M2)

Each item: fail-closed default, a regression test, and a revert-the-fix check that the test fails.

### Triad (`packages/triad/triad`)
- **T1 Competition quorum.** The gate approves when only one of two advisors succeeded (`status == "degraded"`).
  Default: block unless `quorum_met`. *Behaviour change:* a degraded council no longer approves.
- **T2 `remove_worktree(force=True)`.** Today it `rmtree`s any non-repo directory. Default: delete only paths listed by
  `git worktree list --porcelain` for the owning repo, or located under the triad worktree root. The partial-delete retry
  case (a registered worktree whose `git worktree remove` failed) stays covered. *Behaviour change:* `triad worktree remove <arbitrary dir> --force` is refused.
- **T3 `deprovision_worktree_dependencies`.** Swallows every exception, while `WarmWorktreePool._reset_worktree` documents
  that a failure must raise, and `git clean -ffdx` runs afterwards regardless. Default: propagate the failure and skip the clean.
- **T4 Option injection via refs.** `create_worktree` and `git apply` paths pass a commit-ish positionally. Reject refs starting
  with `-` and use `--` where git supports it.

### Core (`packages/core/src`)
- **C1 `updateProposalState` transitions.** No transition rules (SUPPRESSED -> EXECUTING is possible). Default: a table of legal
  transitions; illegal ones throw. Needs the real state machine from `types.ts`/`stateMachine.ts` before writing the table.
- **C2 `ingestEvent` revocation race.** The enrolled/revoked check runs before `BEGIN IMMEDIATE`. Move it inside the transaction.
- **C3 `DryRunCache.release`.** Nonce compared with `===`; a wrong nonce does not consume the proposal. Default: constant-time compare;
  a wrong nonce still leaves the proposal intact (so a typo or attacker cannot burn it) but is rate-limited by the existing TTL.
  Only the constant-time compare is changed unless the tests show otherwise.

### Daemon (`apps/daemon/src`)
- **D1 `ingestTelemetry` validation.** `signals` is unvalidated, so a non-string `foregroundApp` throws after the cognitive mode already changed.
  Validate first, mutate after.
- **D2 `waitForPing` (`mishmash-launch.ts`).** Keeps polling up to 20 s after the child has already failed. Stop as soon as the child exits.

### Mobile (`apps/mobile/src`)
- **M1 `triageQueue` single-flight** and handle the unhandled promise at `App.tsx` mount/resume.
- **M2 `usage.ts` `peekQueue`** id-backfill write is unlocked and fire-and-forget; take the queue lock.

Behaviour changes from this pass:
- A degraded or no-quorum competition council no longer approves the gate.
- `triad worktree remove <dir> --force` is refused unless `<dir>` is a registered worktree or a `triad*` directory under the system temp dir.
- `remove_worktree` can raise when dependency-link cleanup fails (it no longer swallows the error and runs `git clean` anyway).
- Refs starting with `-` are rejected; `--` now precedes paths in `git apply` and `git worktree add`.
- `updateProposalState` throws on illegal transitions and on unknown proposal ids. The transition table was inferred (nothing in the repo called it yet); GATED -> EXECUTING is allowed for the auto-execute path.
- `ingestTelemetry` rejects malformed signals with a 400 instead of half-applying them.

## Needs a design decision (not implemented here)

| ID | Item | Why it waits | Proposed default |
|---|---|---|---|
| P1 | **Label ownership.** Any enrolled device can label any proposal and claim `source: "tap"`. | Proposals carry no owning device; needs a schema change (`proposals.device_id` or a label-signing key). | Bind labels to the approval key: a `tap` label must carry the same device signature as an approval. |
| P2 | **Android key-attestation chain.** `key_attested` is client-asserted. | Needs a trust anchor list and chain parser. | Verify the attestation certificate chain on key registration; reject software-only keys. |
| P3 | **Enrolled devices choose their own scopes**, including `admin`. | Policy for the enrollment token holder. | Cap scopes at an allowlist per platform; `admin` only via CLI on the PC. |
| P4 | **CODE_HEALTH policies score confidence 0.90 / risk 0.05** and pass auto-execute (`self_heal_restore`). | Shadow gating now exists at the daemon routes, but the executor of `SILENT_AUTO_EXECUTE` is not in these packages. | Require an explicit per-policy allowlist plus a shadow check in the executor. |
| P5 | **`createBeliefSnapshot.totalSurprisal`** is always 0. | The per-step surprisal is not retained. | Accumulate surprisal in `processObservation`; store it in the snapshot. |
| P6 | **Production path for proposals.** `ingestProposal` has no caller, so the approval modal is unreachable in a production build. | Needs a delivery channel (poll or push) from the daemon to the phone. | Poll `GET /v3/proposals?state=SURFACED` while the app is foregrounded. |
| P7 | **`/mishmash/delegate` on the triad** other actions are still open to any local process when no token is set. | Only approve/reject are sensitive today. | Require the token for every delegate action. |
| P8 | **Status allowlist prefill** saves the 7-day recent apps as the capture allowlist before the user confirms. | Consent/UX call. | Persist only on explicit confirm. |
| P9 | **`semanticSearch`** drops local hits when the server summaries call fails with a non-unreachable error. | May be intended. | Fall back to local-only results with a notice. |
| P10 | `.triad_proposed_fix.patch` is written into the working tree in direct mode (symlink write, blocks the next gate run). | Low severity, fail-closed. | Write into `.git/`. |
| P11 | `packages/mesh` (~40k lines) and triad `bench/` were not audited. | Scope. | Separate audit. |

## Verification

- Run all suites sequentially after the changes; triad's `test_cmd_auto_with_worktree_flag` is flaky under the full suite (2 of 5 runs) and passes alone.
- No on-device run of the biometric flow has happened; the Java compiles (`compileDebugJavaWithJavac`) but is untested on hardware.
- The Android project's generated `capacitor.settings.gradle` points at `../../../node_modules`, which does not exist in this pnpm layout, so a plain `gradlew` build fails until `npx cap sync` is run from a layout that matches.
