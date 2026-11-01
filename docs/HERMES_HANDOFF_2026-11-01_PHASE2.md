# Hermes Handoff: Phase 2 Truth Repair & People Graph Resolver

**Date:** 2026-11-01  
**Status:** Completed & Verified  
**Commits:** [`96b9612`](file:///C:/Users/micha/projects/sovereign-exocortex/commit/96b9612) pushed to `origin/main` and synced to Lubuntu (`hplubunhaos`).

---

## 1. Executive Summary

Phase 2 Truth Repair has successfully eliminated the chronological timestamp drift where historical documents and communication records had been stamped with ingest time (`2026-11-01`). Furthermore, the Unified People Graph Resolver has been built and verified in `@exocortex/databank`, establishing canonical entity resolution across telecom CDRs, Cube ACR recordings, Google/Samsung contact exports, and Facebook Messenger threads without exposing real-world PII in tracked source code.

---

## 2. Key Deliverables & Achievements

### A. Timestamp Truth Repair (`scripts/execute_phase2_truth_repair.py`)
- **Execution & Safety Net:**
  - Automated `VACUUM INTO` backup created at `/mnt/databank/index/databank.db.bak_20261101_105035`.
  - Read-only ledger connection (`mode=ro`).
  - PRAGMA `busy_timeout = 30000` avoiding lock contention with background daemons.
  - Executed inside a single atomic SQLite transaction.
  - Naive local timestamps interpreted explicitly in `America/Chicago` timezone.
- **Results:**
  - **`cube-acr-calls`:** **586 / 586 items** updated to exact call start times (March 24, 2025 – December 30, 2025).
  - **`gwen-messenger`:** **345 / 349 conversation threads** updated to real message timestamps dating back to August 21, 2012. Only 4 empty/placeholder threads remain at ingest date. Multi-part conversation fallbacks receive temporal offsets only on fallback paths with `ts_source: "folder_fallback"`.
  - **`google-drive-takeout`:** **387 / 387 documents** updated to real file `mtime` dates (January 31, 2013 – December 30, 2025) cross-matched against `/mnt/databank/index/p14_coverage_ledger.db`. Collision-safe mapping filters out ambiguous basenames.
  - **`chunks_fts`:** External content index rebuilt within the same atomic transaction.

### B. Unified People Graph Resolver (`packages/databank/people-resolver.ts`)
- **PII & Privacy Security (Zero Tracked PII):**
  - No real-world phone numbers, emails, or gate codes are committed to source control.
  - Dynamic loading from external/vault seed paths via `PeopleResolver.fromFile(filePath)`.
  - Synthetic test fixtures with zero real PII in test suites.
- **Core Entity Resolution:**
  - **E.164 Normalization:** Full ITU-T E.164 validation, NANP verification (`/^[2-9]\d{2}[2-9]\d{6}$/`), delimiter splitting (`:::`, semicolons), and max 15-digit constraint.
  - **Cube ACR Contact Disambiguation:** Resolves truncated contact strings (e.g. `Aunt Pam (+1 979-56`) by candidate prefix intersection (`>= 8` chars) and name-alias matching, preventing ambiguous cross-merges.
  - **Oakridge Smokehouse Staff Detection:** Automatically tags staff contacts with `oakridge-staff` and assigns `colleague` relationship.
  - **Idempotency & Collision Safety:** Repeated ingestion of identical `itemId` preserves `interactionCount`; slug generation uses NFKD unicode normalization and collision-safe incremental suffixes.
  - **Defensive Immutability:** Array copying on all getters prevents caller mutations from desynchronizing lookup indices.
  - **GraphStore & Ledger Generation:** Emits `GraphEntity` (including self-operator node `person_michael` to avoid dangling edges), `GraphEdge` (`CARES_ABOUT`, `INTERACTS_WITH`, `WORKS_ON`), and append-only ledger events.

---

## 3. Verification & Test Suite

- **Unit Tests:**
  - `pnpm --filter @exocortex/databank test` passes all **94 unit tests** (including 11 comprehensive tests in `test/people-resolver.test.ts`).
  - `pnpm --filter @exocortex/world-model test` passes all **138 unit tests**.
- **Typecheck:**
  - `pnpm run typecheck` passes with **0 errors across all 12 workspace projects**.
- **Autonomous Triad Diff Review:**
  - Reviewed by Autonomous Triad Advisor (`advisor.py` with Claude 3.7 Sonnet / Codex failover).
  - All Blockers (B1–B5) and High findings (H1–H6) addressed and verified prior to commit.
- **Live Lubuntu Health Check:**
  - `databank.service` on port 8790 verified active:
    `{"ok":true,"items":5669,"chunks":30993,"vectors":0,"blobs":5252}`

---

## 4. Current Background Tasks & Next Steps

1. **Active Background Worker:**
   - Detached worker `phase0-rescue.py` (PID 6981 / rclone PID 7675) continues copying oldpc to `databank-crypt:canonical/oldpc`.
   - Progress: **151.5 GiB / 182.9 GiB (83%, 10,004 / 14,319 files transferred)**.
2. **Next Steps:**
   - **Upload Staged Videos:** Upload 44 personal videos (9.52 GB) from `/mnt/databank/staging/p14_videos_for_cloud/` to `databank-crypt:canonical/google_takeout/drive_2025_videos/`.
   - **Phase 3 Embeddings Backfill:** Stand up local llama.cpp embeddings endpoint (`nomic-embed-text`) on CPU to embed all 30,993 chunks in `databank.db`.
