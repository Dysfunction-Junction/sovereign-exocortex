# agy handoff: sovereign-exocortex finish line

## PROMPT (paste this into the agent)

```text
You are agy, a builder on sovereign-exocortex. Your complete instruction set is C:\Users\micha\projects\sovereign-exocortex\docs\AGY_HANDOFF.md (repo path docs/AGY_HANDOFF.md). Run: git fetch origin; git checkout main; git pull. Then open that file. Do not wait for anyone.
Repo: C:\Users\micha\projects\sovereign-exocortex (GitHub Dysfunction-Junction/sovereign-exocortex).
1. Read C:\Users\micha\projects\sovereign-exocortex\docs\AGY_HANDOFF.md in full, then AGENTS.md in the repo.
2. Do the YOUR TASKS section of that file in the order listed, following "How to run this" exactly. A task can start only when its "Depends on" PRs are merged (check with: gh pr list --state merged --limit 30).
3. REVIEW gate: when your PR's CI is green, comment "@Codex: please run the review in REVIEWER DUTY" on the PR and move to your next task. Do not merge it yourself.
4. REVIEWER DUTY: whenever Codex asks you to review a PR, run the REVIEWER DUTY prompt in that file on it before continuing your own tasks.
5. Stop when every task in YOUR TASKS is Done or blocked. Final report: PR links, CI status, what you did not verify, every stop point hit.
```

## YOUR TASKS (in order)

Order: **R3 → R10 → R6**. R6 can start only after Codex's R5 is merged. Until then, do reviewer duty whenever Codex asks. R2 is already Done.

### R3 (2.4b): static and security scan gate for the morphogenetic engine. agy. AUTO. ∥ with R1
- **Depends on:** nothing.
- **Branch:** `feat/2.4b-scan-gate`
- **File:** `packages/triad/triad/morphogenetic.py` and its tests.
- **Steps:**
  1. Before a candidate patch reaches verification, run `ruff check` and `bandit -q -lll` (high severity only) on the **changed Python files** in the candidate workspace, on the host. This is read-only analysis. Both are already in the triad `[dev]` extras.
  2. Reject the candidate (fail closed) if ruff reports errors, bandit reports any high-severity issue, or either tool is missing or crashes.
  3. Add a config switch with a default of ON. It has no effect while the engine flag is off.
- **Tests:** a clean patch passes; a patch adding `eval(input())` is rejected by bandit; a patch with a syntax error is rejected by ruff; a missing tool rejects.
- **Done when:** the tests pass and CI is green.

### R10 (2.3a): re-tier `self_heal_restore`. agy. REVIEW.
- **Why:** 2.3 (#47) lists `self_heal_restore` as T0, but it writes local graph state (`targetState`). By the plan's tiers that is **T2** (writes local state). T0 is read-only.
- **Depends on:** nothing.
- **Branch:** `fix/2.3a-self-heal-tier`
- **Steps:**
  1. Find where `self_heal_restore` gets its tier (`world-model-host.ts`, `scripted-executors.ts`, the auto-execute allowlist in `@exocortex/world-model`).
  2. Make it T2.
  3. Confirm it is **not** auto-execute allowlisted. If it is, remove it from the list.
  4. `diagnostic_probe` stays T0 only if it writes nothing. Verify that, and say so in the PR.
- **Tests:** the tier assertion; `self_heal_restore` is never auto-executed; the existing scripted-executor tests still pass.
- **Done when:** the tests pass, CI is green, and the review approves.

### R6 (1.2): adapters emit channel events. agy. REVIEW.
- **Depends on:** R5 merged.
- **Branch:** `feat/1.2-adapters-emit-events`
- **Files:** `apps/daemon/src/channels/channel-manager.ts`, the gmail, notion and obsidian adapters.
- **Steps:**
  1. Wherever an adapter or the manager calls `graph.addEntity` / `graph.addEdge` for channel data, replace the call:
     - first `vault.put(...)` with the human-readable fields
     - then append the matching `channel.*` event with the R5 builders
  2. Delete the direct graph writes. When done, `grep -n "addEntity\|addEdge" apps/daemon/src/channels/` should return nothing outside tests.
  3. Disconnect: `vault.purgeChannel(channel)` and then append `channel.disconnected`.
  4. Keep the existing audit event (`channel_ingest`).
- **Tests:** an adapter sync emits events with no plaintext (assert by scanning the payload JSON for the fixture's title, body and email strings); a disconnect purges the vault.
- **Done when:** the grep is clean, the tests pass, CI is green, and the review approves.

## How to run this (applies to every task)

**Order.** Do the tasks in section 3 top to bottom. A task may start only when everything in its "Depends on" line is merged. agy and Codex can run in parallel only on tasks with no shared files (marked ∥).

**Every task:**
1. `git fetch origin`, then branch from fresh `origin/main`. The branch name is given in the task.
2. Open a **draft PR** first, titled `<ID>: <short title>`. That claims the task.
3. Build. Before pushing: `pnpm typecheck` plus the changed package's tests on Node 24. For triad on Windows, set `$env:TRIAD_SKIP_REAL_DOCKER="1"`. Real-container tests run inside WSL (section 5).
4. Fill in the PR template. Paste the commands and their output.
5. Wait for CI once: `gh pr checks <n> --watch`. Never poll in a loop.
6. **Gate:**
   - **AUTO**: when CI is green, `gh pr merge --auto --squash`.
   - **REVIEW**: CI green, then the other builder runs the review prompt in section 4. On "approve", the owner merges by hand. Never auto-merge a REVIEW task.
   - **OWNER**: the owner does it (section 6).
7. In the same PR, set the task's row in `docs/AGENT_QUEUE.md` to Done.

**Hard rules (any violation = stop and report):**
- Never set SHADOW=0 anywhere, including tests outside an explicit drill. Never loosen `/network/approve`, attestation, the delegate map, or the event log's append-only triggers.
- Never write plaintext personal content (email bodies, titles, names, addresses) into the `events` table. It can never be deleted.
- No pushes to `main`, no force-push, no rebasing someone else's branch (merge `main` into it instead).
- No `chmod 0777` on host data. Never expose the Docker socket over TCP. No image pulls or prunes.
- Do not stop or remove Ollama until task R9 is merged.
- If CI fails twice for no clear cause: stop, comment the failure on the PR, and move to the next task you are allowed to do.


## REVIEWER DUTY: review prompt

```text
You are the reviewer for PR #<n> on Dysfunction-Junction/sovereign-exocortex. Do not edit the PR. Read the diff (gh pr diff <n>), the PR body, and the task spec <ID> in docs/REMAINING_WORK.md.
Check, and answer each with PASS or FAIL plus the file:line:
1. Meets every step and "Done when" of the spec.
2. SHADOW: nothing sets SHADOW=0, and nothing that acts on the outside world skips the SHADOW check.
3. Authorization: every new or changed route checks a scope; deny is the default.
4. Event log: no plaintext personal content in any events payload; nothing that would need deleting later goes into events.
5. Tests prove the claim. A test that would still pass if the change were reverted is a FAIL.
6. Nothing outside the spec's files changed without a reason in the PR body.
Reply as a PR comment: "Review: approve" or "Review: changes requested", then the six lines and a numbered list of blocking fixes. Never approve with a FAIL on 2, 3 or 4.
```


## Environment facts

- **Repo:** `C:\Users\micha\projects\sovereign-exocortex`. **Shell:** Windows PowerShell 5.1 (no `&&`). **Node:** 24.
- **Docker:** Engine 29.9, inside WSL2 Ubuntu. Image `python:3.12-slim` must stay pulled (`--pull never`). Windows-side triad cannot see it, so run real-container tests in WSL:

  ```text
  cd /mnt/c/Users/micha/projects/sovereign-exocortex/packages/triad
  python3 -m venv /tmp/triad-venv
  . /tmp/triad-venv/bin/activate
  pip install -e ".[dev]"
  python -m unittest triad.tests.test_docker_runner -v
  ```

- **Local models (llama.cpp):**

  | Role | Port | Priority |
  | --- | --- | --- |
  | triage | :8080 | Normal |
  | embeddings | :8081 | BelowNormal |
  | vision | :8082 | BelowNormal |

  They are kept alive by `apps/daemon/ops/ensure-llama-server.ps1`. Ollama :11434 is used only by the home proxy until R9.

- **Memory node:** the backfill runs in the sibling checkout `C:\Users\micha\projects\pieces-for-all` (:39400), not in this repo.


## Where things stand (merged on `main`)

Phase 0 (0.1-0.8), 2.1-2.2 + 2.1b + 2.1c (#49), 2.3 scripted executors (#47), 2.5 kill-switch drill (#51), 2.4 (engine off by default, diff cap, reproduction gate), 2.4a, 3.1-3.3a, 4.0, N.1, Living Brain sizing + usability (#46, #48), triad off Ollama (#22). CI runs on every PR (`check` blocking, `docker-isolation` too).


## Not yours
Owner-only steps (merging REVIEW PRs, revoking devices, daily labels, weekly gate check, go-live, the resync run, uninstalling Ollama) are in docs/REMAINING_WORK.md section 6. Never do them.
