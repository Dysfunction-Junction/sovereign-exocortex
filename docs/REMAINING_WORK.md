# Remaining work: the finish-line runbook (agy + Codex)

Written 2026-10-28 so the plan can be finished **without Claude**. Every task below is fully specified: files, steps, tests, done-when, and the gate before merge. Builders are **agy** and **Codex**. Codex also takes the reviewer role that Opus had.
If this file and the code disagree, the code wins: fix this file in the same PR.

## 0. How to run this (read once)

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

## 1. Where things stand (merged on `main`)

Phase 0 (0.1-0.8), 2.1-2.2 + 2.1b + 2.1c (#49), 2.3 scripted executors (#47), 2.5 kill-switch drill (#51), 2.4 (engine off by default, diff cap, reproduction gate), 2.4a, 3.1-3.3a, 4.0, N.1, Living Brain sizing + usability (#46, #48), triad off Ollama (#22).
Finish line tasks merged:
- R1 (2.6): Scope check on `/v3/channels/*` (#55)
- R2 (2.3): Scripted executors for T0/T1 actions (#47)
- R3 (2.4b): Morphogenetic static & security scan gate (#56)
- R4 (4.0a): Calibration surfacing in shadow mode (#57)
- R5 (1.1): Channel event schema and private content vault (#58)
- R6 (1.2): Adapters emit channel events without plaintext (#61)
- R7 (1.3): World model projects channel events into graph (#62)
- R8 (1.4-1.6): Async consumer, replay integration test, HMAC keyed IDs, and channel resync CLI (#64, docs #65)
- R10 (2.3a): Re-tier `self_heal_restore` to T2 (#59)
- R9: Home proxy `/mobile/ask` off Ollama to llama.cpp (PR #14 in `pieces-android-companion-seamless`)

All builder rows across both repositories (`sovereign-exocortex` and `pieces-android-shizuku-fix`) are **Done**. Ollama dependency has been retired from all active proxy and runtime execution paths. Ready for owner checklist verification (section 6). CI runs on every PR (`check` blocking, `docker-isolation` too).

## 2. Open PRs to land first

None. All finish-line PRs on `sovereign-exocortex` are merged into `main`.

## 3. Tasks

### R1 (2.6): scope check on `/v3/channels/*`. Codex. REVIEW. ∥ with R2
- **Why:** the 2.5 drill found that `/v3/channels/*` (sync, purge, configure, air-gap, disconnect) has **no scope check**. Any enrolled device, even one with only `telemetry:write`, can purge or disconnect your channels.
- **Depends on:** #49 and #51 merged.
- **Branch:** `fix/2.6-channels-scope`
- **Files:** `apps/daemon/src/server.ts` (the channel route block), a new test `apps/daemon/src/channels/channel-routes-auth.test.ts`.
- **Steps:**
  1. Find every handler whose path starts with `/v3/channels`. List each method and path in the PR.
  2. Mutating routes (POST, PUT, PATCH, DELETE: sync, purge, configure, air-gap, disconnect, connect): require `admin:write` via `deviceHasScope(getDatabase(), auth.deviceId, "admin:write")`. Otherwise 403 `{error:"forbidden: requires admin:write"}`.
  3. Read-only GET routes (status, list): require `admin` or `admin:read` or `admin:write`.
  4. Do not change any route's behavior once it is authorized.
- **Tests:**
  - a device with only `telemetry:write` gets 403 on every channel route
  - `admin:write` passes the mutating routes
  - `admin:read` passes GET and fails POST
  - a revoked device is refused
- **Done when:** the tests pass, CI is green, and the review approves.

### R2 (2.3): scripted executors for T0/T1 actions. agy. AUTO. ∥ with R1
- **Branch:** keep `feat/2.3-scripted-executors` (PR #47 already claims it). Merge `main` into it first.
- **Steps:**
  1. **Inventory.** Find every action that can be proposed or executed at tier T0 or T1. Look in `packages/core` (tiers, proposals), `packages/mesh/playbooks.ts`, `packages/mesh/playbook-tools.ts`, `apps/daemon/src/` (`followup-delivery.ts`, `registry-delivery.ts`, `shadow-recorder.ts`, anything named actuat*/execut*), and `apps/daemon/src/delegate-capabilities.ts`.
  2. At the top of the PR body, add a table: action, tier, file, executor (scripted or LLM), gap.
  3. For each T0/T1 action whose **execute** step calls a model, add a deterministic handler. The model may still propose. Executing runs typed code only, with arguments validated against a schema. Unknown or invalid arguments are refused.
  4. Each T0/T1 action needs a test: valid arguments run, invalid ones are refused, and the model client is **never called** (assert it with a spy or fake).
  5. Do not change any tier, the approval flow, SHADOW, or the event schema. If an action needs one of those changed, list it in the PR and skip it.
  6. If more than 8 actions need handlers, do 8 and add a row `2.3b` with the rest to `AGENT_QUEUE.md`.
- **Done when:** the inventory table is in the PR, every T0/T1 action has a handler and a test, and CI is green.

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

### R4 (4.0a): calibration surfacing in shadow mode. Codex. REVIEW.
- **Why:** the go-live gate needs at least 50 tap labels on **surfaced** proposals. At about 0.6 surfaced per day that takes about 12 weeks. The review screen does not help, because labels on queued proposals do not count, and that is correct.
- **Decision (final):** in shadow mode only, promote a few queued proposals per day to "surfaced" as calibration samples. Their labels count toward the gate. This is **conservative**: queued items rank below what the gate surfaces, so they lower measured precision rather than raise it. Nothing executes, because every proposal stays `shadow=1`.
- **Depends on:** nothing.
- **Branch:** `feat/4.0a-calibration-surfacing`
- **Files:** `apps/daemon/src/shadow-recorder.ts` (or a new `calibration-sampler.ts` next to it), `packages/core/shadow-metrics.ts`, `packages/core/shadow-report-cli.ts`, tests.
- **Steps:**
  1. **Promotion.** Once per local hour, when `process.env.SHADOW !== "0"`, pick up to `CALIBRATION_DAILY_CAP` (default **4**, env override, hard max 8) proposals for today.
     - **Eligible:** latest gate decision is `QUEUE` (state `STAGED`), `shadow=1`, not expired, no label yet.
     - **Order:** lowest `efe` first; ties broken by newest.
     - **Time:** only between 08:00 and 21:00 local.
  2. **Record.** For each pick, append a new `gate_decisions` row with decision `SURFACE` and a reason starting `calibration:`. Set the proposal state to `SURFACED`. Use existing tables only; **no schema change**. The push notifier already sends a quiet notification for newly SURFACED proposals.
  3. **Never when `SHADOW=0`.** Check the env var on every run, not once at startup.
  4. **Metrics.** `computeShadowMetrics` keeps its current gate number, now including calibration rows, because the latest decision wins. Also report `calibrationSurfaced` (count) and `precisionGateOnly` (precision excluding rows whose reason starts `calibration:`). `shadow-report-cli` prints both. The go-live gate (precision ≥ 0.90, at least 50 tap labels, 14 days) uses the main number, unchanged.
- **Tests:**
  - the daily cap is enforced
  - nothing is promoted when SHADOW=0
  - nothing is promoted outside 08:00-21:00
  - only STAGED, unlabeled, unexpired proposals are eligible
  - metrics count a labeled calibration proposal
  - `precisionGateOnly` excludes it
- **Done when:** the tests pass, CI is green, and the review approves.

### R5 (1.1): channel event schema and private content vault. Codex. REVIEW.
- **Decision (default; the owner may override in the PR):** email, Notion and Obsidian **content never enters the event log**. The log holds hashes and opaque references only. The content lives in a separate, deletable, encrypted vault. Disconnecting a channel deletes the vault rows and the channel key (crypto-shredding), so the log's hashes become unlinkable.
- **Depends on:** nothing.
- **Branch:** `feat/1.1-channel-events`
- **New files:** `apps/daemon/src/channels/channel-events.ts` (types, builders, validation), `apps/daemon/src/channels/channel-vault.ts`, tests.
- **Event kinds** (free-text `kind` column, `schema_ver` 1, written through `db.ingestEvent` as `HOST_DEVICE_ID`):

  | kind | payload fields (nothing else allowed) |
  | --- | --- |
  | `channel.document.upserted` | `channel` (gmail, notion or obsidian), `doc_key`, `content_sha256`, `ref`, `observed_at` |
  | `channel.entity.upserted` | `channel`, `entity_type` (person or project), `entity_key`, `ref`, `observed_at` |
  | `channel.link.upserted` | `channel`, `from_key`, `to_key`, `rel` (mentions, authored, member_of, links_to), `observed_at` |
  | `channel.disconnected` | `channel`, `observed_at` |

  - `doc_key` / `entity_key` = hex HMAC-SHA256(channel key, natural id), where the natural id is the message id, page id, file path, or lower-cased email.
  - `ref` = a random UUID pointing into the vault.
  - **Payload validation rejects any other field and any string over 128 chars.** Add a test that tries `title`, `body`, `email`, `name` and nested objects: all rejected.
- **Vault** (`channel-vault.ts`):
  - A new table in the same SQLite file, **not** part of the hash chain: `channel_vault(ref TEXT PRIMARY KEY, channel TEXT NOT NULL, ciphertext BLOB NOT NULL, created_at INTEGER NOT NULL)`. Add it through the existing migration path in `packages/core/db.ts`, without touching the `events` table or its triggers.
  - Encryption: AES-256-GCM via `node:crypto`. Per-channel 32-byte key at `%LOCALAPPDATA%\exocortex\channel-keys\<channel>.key` (on Linux, `~/.local/share/exocortex/channel-keys`), created on first use with 0600 permissions. If `packages/databank/crypto.ts` already exposes an equivalent helper, reuse it.
  - Plaintext JSON stored: `{title?, body?, display_name?, email?, url?}`.
  - API: `put(channel, obj) -> ref`, `get(ref) -> obj | null`, `purgeChannel(channel)`. Purge deletes every row for the channel AND the key file; after that, `get` returns null.
- **Tests:** a round trip; purge makes `get` return null and deletes the key; ciphertext does not contain the plaintext; payload validation as above; events are appended and the chain verifies.
- **Not in this task:** changing the adapters (that is R6).
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

### R7 (1.3): world model projects channel events. Codex. REVIEW.
- **Depends on:** R6 merged.
- **Branch:** `feat/1.3-project-channel-events`
- **File:** `apps/daemon/src/world-model-host.ts` (`onEventsAppended`).
- **Steps:**
  1. On `channel.entity.upserted`, upsert entity `<entity_type>:<entity_key>` tagged with the channel. Take its label from `vault.get(ref)?.display_name`. If the vault entry is purged, skip the entity.
  2. On `channel.document.upserted`, upsert `doc:<doc_key>`, labelled with the vault title or "(document)".
  3. On `channel.link.upserted`, add the edge.
  4. On `channel.disconnected`, remove every entity and edge tagged with that channel. Reuse the 0.6 purge-by-tag.
- **Test:** the graph from live ingest equals the graph from replaying the same events (node and edge sets compared). After a disconnect, replay shows no entities from that channel.
- **Done when:** the tests pass, CI is green, and the review approves.

### R8 (1.4 + 1.5 + 1.6): async consumer, replay test, one-time resync. Codex. REVIEW.
- **Depends on:** R7 merged.
- **Branch:** `feat/1.4-ingest-consumer`
- **Steps:**
  1. **1.4:** a new `apps/daemon/src/ingest-consumer.ts`. Post-ingest hooks (world model, triage, recorders) run in a worker loop that reads events by `seq` after a persisted cursor. The cursor lives in a new `consumer_cursors(name TEXT PRIMARY KEY, seq INTEGER NOT NULL)` table, which is not hash-chained. `POST /v3/events` returns before the hooks run. A restart resumes from the cursor. Hooks must be idempotent; give each one a test for applying the same event twice.
  2. **1.5:** a new `replay.integration.test.ts` that ingests a mixed fixture (telemetry plus every `channel.*` kind), snapshots the graph and beliefs, wipes the projections, replays from seq 0, and asserts they are equal. CI runs it.
  3. **1.6:** a one-time CLI, `apps/daemon/src/channel-resync-cli.ts`, that re-reads each connected channel through the adapters (the R6 path) so existing data exists as events. Print the entity counts before and after; they must match. Existing `person:<email>` graph IDs are replaced by keyed IDs. List that change in the PR.
- **Done when:** the tests pass, CI is green, the review approves, and the owner has run the resync CLI once (section 6).

### R9: home proxy `/mobile/ask` off Ollama, then retire Ollama. Codex. REVIEW.
- **Repo:** `C:\Users\micha\Desktop\projects\pieces-android-shizuku-fix` (pieces-android-shizuku-monitor). **Separate repo**, with its own PR.
- **Step 0:** confirm the active branch. The checkout is on `master`, but `C:\Users\micha\CLAUDE.md` says `shizuku-master`. Ask the owner if unsure. Never commit `apps/pieces-gateway/devices.json` (it holds pairing secrets).
- **Steps:**
  1. In `apps/proxy/src/ollama-fallback.ts`, point the fallback at llama.cpp `http://127.0.0.1:8080/v1/chat/completions` (OpenAI shape), with a loopback-only URL check. Keep an env override that restores Ollama.
  2. Keep the timeout (`OLLAMA_TIMEOUT_MS`, 90000) under a neutral name with the old one as an alias.
  3. Add tests for the request shape and the fallback.
- **After merge (owner):** stop Ollama, remove it from startup, and confirm triage, embeddings, vision, triad and `/mobile/ask` all still answer.

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

## 4. Review prompt (replaces Opus; the other builder runs it)

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

## 5. Environment facts

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

## 6. Owner checklist (no agent can do these)

1. **Merge #49, then #51.** Then each REVIEW PR once it shows "Review: approve".
2. **Revoke the two unknown devices** (`a4d55d96…`, `edd825ff…`), unless you know what they are. Get the full IDs from the device list, then in `apps\daemon` run, once per device:

   ```text
   npx tsx --env-file-if-exists=.env src/revoke-cli.ts <full-device-id>
   ```

3. **APK:** after any mobile PR merges, rebuild and reinstall, then turn the accessibility service back on: Settings → Accessibility.
4. **Label every day.** Open the Review screen and tap wanted, not wanted, or already did on every card. Calibration cards from R4 count.
5. **Weekly gate check**, in the repo root:

   ```text
   npx tsx packages/core/shadow-report-cli.ts "$env:LOCALAPPDATA\exocortex.db" --days 14
   ```

   Exit code 0 means passing. Go live only when it shows precision ≥ 0.90 with at least 50 tap labels over 14 days.
6. **Device test (4.3):** follow `docs/DEVICE_TEST_RUNBOOK.md` with one real T0 action, not only `diagnostic_probe`.
7. **Go live, T0 only (4.5):** set `SHADOW=0` only for T0, per that runbook. The rollback is `SHADOW=1`, proven by the 2.5 drill. Watch for 7 days with no unwanted action, then repeat for the next tier (4.6).
8. **After R8:** run the channel resync once:

   ```text
   npx tsx apps/daemon/src/channel-resync-cli.ts
   ```

   Check that the entity counts before and after match.
9. **After R9:** stop and uninstall Ollama.

## 7. Later (not on the finish line)

These are optional and not specified here: one memory database with vector search, eval CI on your own event history, a commitment tracker, a voice capture lane, an encrypted event log with per-channel retention, and an audit of the 8 sibling repos' delegate handlers.
