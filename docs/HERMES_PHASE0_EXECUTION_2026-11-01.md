# Hermes Phase 0 execution — 2026-11-01

Status: local rescue and retrieval protection verified; encrypted Drive mirror running, verification pending.

## Password quarantine: verified

The previous execution removed `Google_Passwords.pdf` and `Google_Passwords.xlsx` from the live index. Live SQL verification now confirms:

- Zero target items or chunks; zero matching credential-document paths/titles.
- Zero orphan vectors.
- Two remaining FTS phrase matches are references in an SMS conversation and `DOCUMENT_INFO.json`, not the credential documents. The earlier claim of zero phrase matches was inaccurate.
- Encrypted cold blobs were not deleted. No credential contents were printed.

Evidence: [retrieval.json](evidence/hermes-phase0/retrieval.json).

## Gwen owner filter: deployed and verified

All 349 Messenger records have source `gwen-messenger` and metadata `owner: "gwen"`, `tier: "gwen-knowledge-base"`; zero records retain `facebook-messenger`.

Tagging alone did not exclude these records from retrieval. `packages/databank/databank.ts` now defaults search to Michael, including legacy unowned records, and applies the owner partition before FTS candidate ranking and vector top-k selection. Gwen source/tier markers also enforce the Gwen partition. Explicit authenticated `owner: "gwen"` retrieval remains available through `/search` and CLI `search ... --owner gwen`.

This is retrieval scoping under the existing shared administrative token. Direct `/item/:id` and `/blob/:id` access retain that administrative access model.

The existing Pieces-for-All archive client sends `{q,k}` to `/search`, so its default archive context receives the Michael partition without caller changes.

Deployment: both `/home/michael/databank.mjs` and `/opt/databank/databank.mjs` on `michael@100.69.94.119`; prior bundles retained as `databank.pre-phase0.mjs`. The systemd Databank service was started after reboot and is listening on `127.0.0.1:8790`.

Live HTTP verification: zero Gwen records in default results, zero when only `source: "gwen-messenger"` is specified, and 10 Gwen records when `owner: "gwen"` is explicit. Only aggregate results were retained. A repeat probe timed out during heavy rescue I/O; the final probe after the copy passed in 1.84 seconds.

Validation: 78 Databank tests pass, package TypeScript checks and bundle pass, workspace `pnpm typecheck` passes. Tests cover FTS, vector-only, the 50-candidate cutoff, HTTP owner handling, and reassignment while embedding is in flight. Final hydration rechecks the partition after the asynchronous query-embedding call. Advisor review found no blocking issue after revision; schema and vector sentinel assumptions were checked against source.

## Old-PC rescue and encrypted off-site mirror

Local rescue completed and passed the final incremental rsync, inventory comparison, and sampled hashes:

- 14,320 regular files; 160,305,226,262 bytes; zero symlinks; original rsync reported 424 directories.
- All source/destination paths and sizes agree; all 32 sampled SHA-256 hashes agree.
- No old-PC entries exist in the current dedup manifest (20,375 entries in total); zero samples had a historical manifest match. Historical manifest comparison is unavailable, rather than a PASS. No full reread/hash of the degrading source was attempted.
- Encrypted upload started at `2026-11-01T09:46:57Z`. Its detached rclone process is active. Final per-file cryptcheck is queued after upload and has not passed yet.

Evidence snapshots: [rescue-status.json](evidence/hermes-phase0/rescue-status.json), [manifest-coverage.json](evidence/hermes-phase0/manifest-coverage.json). These are snapshots; the remote JSON below is the live status.

The existing rsync was preserved:

```sh
rsync -a --info=progress2 --stats /home/michael/oldpc-archive/ /mnt/databank/canonical/oldpc/
```

Log: `/mnt/databank/index/oldpc_rescue.log`.

A detached worker runs [phase0-rescue.py](../packages/databank/ops/phase0-rescue.py) on Lubuntu. It waits for the existing rsync, performs a final incremental rsync with an exit-status check, compares source/destination file counts and sizes plus symlink targets, checks 32 deterministic SHA-256 samples and available manifest matches, then runs:

```sh
rclone copy /mnt/databank/canonical/oldpc databank-crypt:canonical/oldpc --links --create-empty-src-dirs --stats 60s
rclone cryptcheck /mnt/databank/canonical/oldpc databank-crypt:canonical/oldpc --links --one-way
```

The new `databank-crypt:` remote overlays `gdrive:Databank_Backup`, encrypting both contents and names. No unencrypted old-PC cloud copy was started. Copy is resumable and never deletes the source. The worker uses an exclusive lock to prevent duplicate runs.

Progress and completion evidence on Lubuntu:

- `/mnt/databank/index/phase0-rescue.json` (aggregate stage, verification counts, success/failure)
- `/mnt/databank/index/phase0-worker.log`
- `/mnt/databank/index/phase0-rsync-final.log`
- `/mnt/databank/index/phase0-crypt-copy.log`
- `/mnt/databank/index/phase0-cryptcheck.log`

The mirror is only verified when the status says `stage: "complete"` and `encrypted_mirror_verified: true`. To resume after interruption:

```sh
nohup python3 /home/michael/phase0-rescue.py >> /mnt/databank/index/phase0-worker.log 2>&1 < /dev/null &
```

An encrypted upload/decrypt probe using the independently saved recovery keys passed; see [crypt-recovery.json](evidence/hermes-phase0/crypt-recovery.json). The disposable probe was removed after verification.

Encryption recovery material is saved with owner-only access on Lubuntu at `/home/michael/.config/rclone/databank-crypt-recovery.json` and backed up on Windows at `%LOCALAPPDATA%\exocortex\keys\databank-crypt-recovery.json` (ACL restricted to the current user and SYSTEM). It is outside Git and was never printed. Owner still needs to save it in Google Password Manager alongside the Databank key; this session has no Password Manager write access.

## Phase 1 remains separate

Product 14 preservation, video upload, staging ZIP removal, and OneDrive ZIP deletion were not executed by this Phase 0 session. The prior note's suggestion to delete the ZIP after only the preservation script is insufficient: that script skips some files by name/size or assumed ingestion and can retain videos locally. Verify complete coverage and the separate video-upload decision before any deletion.
