# 2-day delegation plan — 2026-11-01 → 2026-11-03

Claude is at 8% weekly usage. From here: Claude writes specs and verifies results; **agy, opencode, hermes, and codex do the implementation work.** Each task below names which agent owns it and what "done" looks like, so it can be handed off with no further Claude involvement except a final verification pass.

---

## In flight right now (finish before starting anything new)

### T0 — Ingest Downloads batch into live databank
- **Owner:** agy (Claude is offline until Wed 2026-11-04 06:00 CST — do not wait on Claude).
- **State as of handoff:** transfer to `michael@100.69.94.119:/home/michael/staging/downloads_ingest_2026-11-01/` is COMPLETE — verified `find <dir> -type f | wc -l` = 320/320. Only the `ingest-dir` run itself remains.
- **Correction — a dev checkout does exist:** `/home/michael/repos/sovereign-exocortex`, with `node_modules/.bin/tsx` present. It's currently 4 commits behind origin (stale at `96b9612`, missing the sensitivity-tier work) — `git pull` there first, before running anything, or `cli.ts` won't match what's actually deployed.
- **Exact run sequence (verified 2026-11-01):**
  1. `ssh michael@100.69.94.119`
  2. `cd /home/michael/repos/sovereign-exocortex && git pull`
  3. `set -a && source /etc/databank.env && set +a` (loads `DATABANK_ROOT`/`DATABANK_KEY_FILE` from the same env file `databank.service` uses)
  4. Take a backup first (see Safety below)
  5. `node_modules/.bin/tsx packages/databank/cli.ts ingest-dir /home/michael/staging/downloads_ingest_2026-11-01 --source downloads-2026-11-01`
  6. `node_modules/.bin/tsx packages/databank/cli.ts stats` to verify
- **Verified, not a risk:** `classifySensitivity()` is already called inside the ingest path (`databank.ts:291`), so this batch gets sensitivity-classified at ingest time, same as any other ingest — no separate reclassification step needed.
- **Safety:** use `--source downloads-2026-11-01` so this batch is identifiable/reversible later. Take a `VACUUM INTO` backup immediately before running (same pattern as the sensitivity migration).
- **Done when:** ingest reports `newItems` ≈ 320 minus duplicates already in the vault, `failed` empty or explained, `stats` shows item count above 5,669 (confirm actual pre-ingest count first — it may already differ from the 5,669 snapshot in HERMES_HANDOFF_2026-11-01_PHASE2.md since the sensitivity migration and any other work since then).
- **Cleanup:** delete the plaintext staging copies — both `/home/michael/staging/downloads_ingest_2026-11-01` on Lubuntu and `C:\Users\micha\Downloads-staging\ingestable_hold` locally — only after ingest is verified, not before.

---

## Day 1 (2026-11-01 → 2026-11-02)

### T1 — Databank: stop UPDATE-in-place, start ledger-sourced corrections
- **Owner:** codex
- **Why:** Phase 2 timestamp repair and the sensitivity migration both edited `databank.db` rows directly. The project's own stated invariant (CLAUDE.md root) is one append-only ledger as truth, with everything else a rebuildable projection. Databank currently breaks that.
- **Scope:** Design (don't yet migrate data) a path where:
  1. A correction (e.g. a wrong timestamp found later) is written as a new event to the ledger (`@exocortex/core/db`), not an `UPDATE` on `databank.db`.
  2. `databank` gains a `rebuildFromLedger()` entry point that can reconstruct its FTS/vector index from ledger events + the existing ingest sources, so it's provably a projection.
- **Deliverable:** a design doc (`docs/DESIGN_LEDGER_SOURCED_DATABANK.md`) plus a prototype `rebuildFromLedger()` behind a flag, tested against a copy of the DB — not run against the live vault.
- **Done when:** design doc exists, prototype passes tests on a local copy, Claude reviews before touching anything live.

### T2 — Ingest-time required field: event-time (sensitivity already done)
- **Owner:** agy
- **Correction from first draft:** sensitivity classification is already wired into ingest (`classifySensitivity()` runs inside `databank.ts` at line 291) — that half of this task is done, don't redo it.
- **Why (remaining scope):** `eventTime` still silently defaults to ingest time when not supplied. Phase 2 had to backfill this after the fact for three sources; stop it recurring for the next one.
- **Scope:** In `ingestDir`/`ingestText`, when no explicit `eventTime` is given, log a warning (include source + item identifier) instead of silently stamping ingest time.
- **Done when:** typecheck + `pnpm --filter @exocortex/databank test` pass, a new item ingested without explicit `eventTime` produces a visible warning in output/logs, not just a silent default.

### T3 — allowlist audit
- **Owner:** opencode
- **Why:** earlier assumed dead, corrected — it's actually used across daemon/mesh/world-model/mobile via subpath imports. Worth a real audit now that it's confirmed load-bearing: is its policy actually doing what each caller thinks it does?
- **Scope:** List every import site (`grep -r "@exocortex/allowlist"` including subpath imports like `allowlist/dist/...`), confirm each caller's expected behavior matches what the module does, flag mismatches.
- **Deliverable:** short findings doc, no code changes unless a mismatch is a security hole (then flag, don't fix solo).

### T4 — Decision ledger backfill
- **Owner:** hermes
- **Why:** `triad/decision_log.py` just landed (per the peer session message) but has no entries yet for today's work (sensitivity migration, Downloads ingestion).
- **Scope:** Add retroactive entries for: (1) sensitivity-tier migration run against live databank 2026-11-01 22:51 UTC, (2) Downloads ingestion batch (once T0 finishes).
- **Done when:** `python -m triad.decision_log tail -n 5 --project sovereign-exocortex` shows both entries with correct `touches` fields.

---

## Day 2 (2026-11-02 → 2026-11-03)

### T5 — Phase 3 embeddings backfill (resume)
- **Owner:** codex
- **Why:** `e53bcd6` added the vector backfill script; migration evidence shows `vectors: 16408` of `chunks: 30993` — roughly half done, meaning **something already ran this today**, outside this plan.
- **Before starting:** check both Lubuntu and the local machine for an already-running backfill process (`ps aux | grep -i embed` on Lubuntu; check for a stray local process too) — don't start a second one against the same vault. Also run this strictly after T0's ingest completes, since T0 adds new chunks that need embedding too — starting T5 first means re-running it.
- **Scope:** Resume/complete the backfill using the existing script against the live llama.cpp endpoint. Confirm resilient bisection + keyset pagination still works post sensitivity-migration schema change (v3 added a column — verify the backfill script doesn't choke on it).
- **Done when:** `stats` command shows `vectors` ≈ `chunks` (expect higher than 30,993 once T0's new items are counted), or a documented reason why some chunks can't be embedded.

### T6 — Branch/worktree hygiene pass
- **Owner:** agy
- **Why:** this recurs every few days as a cleanup task — formalize it so it's routine, not an audit each time.
- **Scope:** Run `git worktree list` + `git branch --no-merged` in sovereign-exocortex, cross-check with `gh pr list --state all` (not raw cherry/diffstat — see `feedback_branch_merge_verification.md` memory), remove confirmed-merged residue.
- **Done when:** no worktrees/branches remain whose content isn't either (a) in `main` via a real PR, or (b) actively in progress (confirm with the committing agent first, don't guess).

### T7 — Item/blob direct-ID access gap (Phase 6 blocker)
- **Owner:** codex
- **Why:** flagged in `docs/SPEC_SENSITIVITY_TIERS_2026-11-01.md` §4.5 as blocking the eventual `/ask` endpoint (Phase 6) — items/blobs can be fetched by direct ID without going through `filterSql()`'s sensitivity/owner gating.
- **Scope:** Audit `packages/databank/databank.ts` and `server.ts` for any direct-ID lookup path (not via search) that bypasses the owner/sensitivity filter. Patch those paths to apply the same gating.
- **Done when:** every item/blob fetch path — search or direct-ID — enforces `filterSql()`'s owner + sensitivity rules; add a regression test proving a direct-ID fetch of a `secret`-tier item without the right owner/sensitivity params is rejected.

---

## Pre-mortem — checked 2026-11-01, before handoff

- **Ingest-time classification (would have been a real gap):** verified NOT a problem — `classifySensitivity()` already runs inside the ingest path. T2 above is corrected to reflect this.
- **Version skew (would have been a real gap):** verified NOT a problem — `/opt/databank/databank.mjs` was rebuilt at 16:52, same time as the service restart, and contains `maxSensitivity` logic (grep count: 4). The sensitivity migration's enforcement code is actually deployed, not just migrated in the DB.
- **Secrets uploaded to plaintext Google Drive (real finding, needs a human call):** `rclone lsf -R gdrive:Downloads-Archive-2026-11` turned up `ssh-1-001.zip` and `ssh-key-2026-06-14.key.pub` outside the Openship noise. The `.pub` file is harmless by definition; **`ssh-1-001.zip`'s contents are unknown and unchecked** — it was never opened. Before anyone treats this Drive folder as done: have a human (not an agent) check that zip's contents and decide whether to delete it from Drive or move it to the encrypted `databank-crypt:` remote instead of plain `gdrive:`. Do not open/extract it as an agent task — a zip that might contain private key material should be handled by the user directly.
- **Local file-permission gap (lower priority, real but minor):** `databank.db` and its `pre-v3` backup are mode 644 on Lubuntu — world-readable on that host. Add `chmod 600 /mnt/databank/index/databank.db*` as a one-line task for whoever picks up T0 or T6.

## Explicitly not scheduled (needs a live decision, not a delegated task)
- Opening/extracting `ssh-1-001.zip` from the Drive upload — flagged above, human judgment call, not an agent task.
- Any further live-databank migrations beyond what's already run — check with the user first, same as the sensitivity-tier migration was.
- Any action that would prune/delete from the live databank (archival is append/copy only per the daemon's own fail-soft contract).

## Coordination note — read this even if you only read one section
- Multiple agents will be touching `sovereign-exocortex` `main` concurrently. **One owning agent per package.** Every merge gets a `decision_log.py add` entry (`python -m triad.decision_log add --intent "..." --reasoning "..." --touches "a,b"` from autonomous-triad) before the next task starts on that same package — check `tail -n 10 --project sovereign-exocortex` first to see what's already landed.
- **This rule only reaches Claude-based agents automatically.** Codex reads `AGENTS.md`, not `CLAUDE.md` — if codex is picking up T1, T5, or T7, point it at this plan doc directly; don't assume it already knows the decision-log convention.
- T1 and T2 both touch `databank.ts`. T1 is design/prototype-only against a local DB copy (not live) — land T1's design doc first, or have T1 and T2's owners read each other's diffs before merging, since a silent double-edit on the same file is exactly the collision pattern that caused worktree residue earlier in this project.
- **`opencode` (owner of T3) is confirmed working** (v2.2.5 on PATH) — but like codex, it does NOT read `CLAUDE.md` and will not pick up the decision-log convention on its own. Before or during T3, explicitly tell opencode: log this task in the decision ledger with `python -m triad.decision_log add --project sovereign-exocortex --intent "allowlist audit" --reasoning "<findings>" --touches "packages/allowlist"` from the `autonomous-triad` checkout, and check `tail -n 10 --project sovereign-exocortex` afterward to confirm it landed. Do not assume it will do this unprompted.
- **Per-agent launch gotchas** (from this session's memory, `project_sovereign_exocortex.md`):
  - `codex exec -s workspace-write` hangs on a quoted-argument prompt — pipe the prompt from a file instead: `codex exec -s workspace-write - < prompt.txt`, backgrounded with `nohup ... & disown` (plain `&` gives a false "completed" signal when only the launcher shell exits).
  - `agy --mode auto` silently falls back to default mode on this account and may not process the prompt at all — don't trust a background `agy` launch without checking its actual output.
  - hermes runs a free-tier flash model per its config — keep it off anything touching the live databank or secrets; T4 (decision-log backfill, no live writes) is an appropriate fit for it.

## Wednesday resume checklist (2026-11-04, 06:00 CST) — make the first 10 minutes back cheap
1. `python -m triad.decision_log tail -n 15 --project sovereign-exocortex` — see everything that landed while away, in order.
2. `git -C sovereign-exocortex log --oneline -20` and `git worktree list` — cross-check against the decision log for anything committed without a log entry.
3. Check T0/T5/T7's "done when" criteria directly (`stats` command, test suite, the direct-ID regression test) rather than trusting agent self-reports.
4. Check whether `ssh-1-001.zip` was resolved (deleted from Drive, moved to crypt, or confirmed harmless) — this was explicitly left for a human, confirm it didn't get silently actioned by an agent anyway.
5. Re-run `rclone lsf -R gdrive:Downloads-Archive-2026-11 | grep -iE "password|secret|\.key$|credential"` once more — new uploads may have landed there in the meantime from other work.
