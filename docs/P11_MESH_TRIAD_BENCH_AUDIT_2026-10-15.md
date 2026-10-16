# P11 Audit: Mesh and Triad Benchmark Harness

Date: 2026-10-15
Scope: tracked implementation and tests under `packages/mesh/` and `packages/triad/triad/bench/`. Generated `.cache/` repository snapshots were excluded.
Focus: async error paths, child and container cleanup, worktree lifecycle, narrowing at input boundaries, and regression coverage.

## Findings

### P1 — Process timeout can create an unhandled rejection and leave completion pending

`packages/mesh/src/process.ts:195-216` calls `terminate()` from the timeout callback with `void`. `terminate()` rejects when the process group remains alive after SIGKILL (`:204-207`). No rejection handler observes that promise. In that case the caller's `completion` promise still waits for the child `close` event, while the unhandled rejection is reported separately and the process may remain alive. `cancel()` does await the same function, so explicit cancellation at least reports the failure.

**Recommended patch:** observe the timeout-triggered termination promise and settle `completion` with a timeout/termination error if cleanup fails. Keep the process handle and captured stderr in the rejection so the router can mark the task failed and surface a useful diagnostic.

**Regression test:** inject or mock a process-group signal failure through the escalation sequence, trigger the timeout, and assert there is no unhandled rejection, `completion` settles, and the failure is visible to the caller.

### P2 — SWE-bench can access the network after a local bare-cache miss

`packages/triad/triad/bench/swebench_runner.py:503-525` attempts `git show` from a discovered bare repository, then falls through to `raw.githubusercontent.com` when the object or file is unavailable. The repository operating invariant requires file extraction to remain hermetic whenever local bare git caches exist. This fallback can make an evaluation depend on remote state and bypass the available local cache's provenance.

**Recommended patch:** when `resolve_bare_repo` returns a cache, return a local-cache error if `git show` fails. Permit HTTP retrieval only when no local bare cache exists, or remove that fallback and report the missing cache explicitly.

**Regression test:** mock an existing bare cache whose `git show` fails and assert the HTTP opener is never called; separately cover the chosen no-cache behavior.

### P2 — Docker timeout cleanup can silently leave a test container running

`packages/triad/triad/bench/docker_harness.py:285-293` catches `TimeoutExpired`, invokes `docker kill`, then discards both a nonzero kill result and kill timeout/OS errors. The caller reports timeout and the `finally` block removes the host checkout (`:318`), but the container may still be running with that checkout mounted.

**Recommended patch:** check the kill result, then perform a bounded `docker wait` or inspect/remove fallback. Include a cleanup-failed status in the report when Docker cannot confirm container termination. Avoid claiming cleanup succeeded based only on issuing the kill command.

**Regression test:** mock a timed out run and failed `docker kill`; assert a cleanup failure is returned and the cleanup escalation is attempted.

### P3 — Base-file materialization ignores Git staging and commit failures

`packages/triad/triad/bench/swebench_runner.py:737-767` ignores the results from `git add -f` and the base-file initialization `git commit`. Evaluation continues even if the base files were not staged or the synthetic baseline commit failed. That can make patch application and semantic diagnostics operate on a different baseline than the requested `base_commit`.

**Recommended patch:** check each subprocess return code and stop with an infrastructure error that includes the first useful stderr/stdout line. Apply the same rule to `reset --hard` / `clean -fd` before retrying a patch so retries cannot inherit partially applied state.

**Regression test:** force `git add`, commit, and retry cleanup to fail independently; each case should stop before candidate verification and report infrastructure failure.

## Coverage and limits

- Existing mesh tests cover worktree carry/cleanup and many orchestration paths, but there is no direct `startLineProcess` timeout escalation test. Add one with the timeout fix.
- `packages/triad/triad/tests/test_docker_harness.py` covers outcome classification, sandbox flags, cache naming, and checkout argument ordering. It does not cover `try_native_docker_tests` timeout/container cleanup or `swebench_runner.ensure_base_file` network fallback.
- The benchmark's existing worktree tests cover pool concurrency, recycling, and leak checks. They do not cover the ignored Git command failures listed above.
- Review covered first-party source and tests; `.cache/` contains third-party source snapshots and was not treated as project implementation.

## Recommended order

1. Fix mesh timeout promise settlement and add the process regression test.
2. Make cache-backed SWE-bench base-file retrieval strictly local.
3. Make Docker timeout cleanup observable and verified.
4. Fail closed on Git staging, commit, and retry-reset failures.

## Resolution (2026-10-15)

- P1: timeout-triggered process termination now has an explicit rejection handler. If escalation fails, `completion` rejects with the command, termination diagnostic, and captured stderr instead of leaving a detached rejection.
- P2: base-file retrieval returns a local cache error when a discovered bare repository lacks the requested object/file; HTTP fallback remains available only when no local bare repository exists.
- P2: Docker timeout cleanup now checks `kill`, waits for termination, and attempts force removal if termination cannot be confirmed. The result message reports cleanup failure explicitly.
- P3: base-file `git add` and baseline `git commit` return codes are checked. Both patch retry paths check `reset --hard` and `clean -fd`; cleanup failures stop retries and are classified as infrastructure errors.
- Regression tests cover local-cache network isolation and Docker cleanup failure/force-removal behavior. Focused mesh process-lifecycle tests pass; the termination-escalation failure branch does not have a direct injected-signal regression test yet.

Verification: `pnpm -r --stream typecheck` passed. The focused Python suite passed 16 tests, mesh process lifecycle passed 3 tests, and `git diff --check` plus Python compilation passed. A broader Triad test run stalled after a failure in a longer worktree test and was stopped; the focused changed-area tests passed independently. The required advisor diff review did not return within approximately one minute and was stopped.
