# Handoff Documentation: Autonomous Exocortex Databank & Endzone Operations

> **Date:** 2026-11-01 02:35 CDT  
> **Source Agent:** Antigravity  
> **Target Agent(s):** OpenAI Codex (`codex`), Claude Code (`claude`), Hermes Agent  
> **Primary References:** [`AGENTS.md`](file:///C:/Users/micha/AGENTS.md), [`endzone_plan_ask_my_life.md`](file:///C:/Users/micha/.gemini/antigravity-cli/brain/50607308-26aa-4ec1-a124-56970d1e208a/endzone_plan_ask_my_life.md), [`post_backup_ingestion_and_space_reclamation_plan.md`](file:///C:/Users/micha/.gemini/antigravity-cli/brain/50607308-26aa-4ec1-a124-56970d1e208a/post_backup_ingestion_and_space_reclamation_plan.md)

---

## 1. Executive Status & Hardware State

1. **Lubuntu Server (`hplubunhaos`):**
   - Tailscale IP: `100.69.94.119` | Local LAN IP: `192.168.50.129` | SSH: `ssh michael@100.69.94.119` (or `michael@192.168.50.129`).
   - Vault Mount: `/mnt/databank` (`/dev/sdb1` ext4, WD 1TB USB, ~870 GB free, 4% used).
   - Degrading Drive Warning: `/dev/sda` (42k hours, 1,360 reallocated sectors) holds `~/oldpc-archive` (150 GB, 14,320 files). **This is the only plain copy.** Phase 0 priority is copying this to `/mnt/databank/canonical/oldpc/`.
2. **OneDrive Remote (`onedrive:`):**
   - Reconnected and authenticated.
   - Status: Total `2.117 TiB`, Used `1.666 TiB`, **Free `462.300 GiB`** (rescued from 841 GiB overage).
   - Deleted 7 broken/duplicate archives (321.7 GB wiped) + 4 fully-ingested small archives (YouTube, Nest, 2022 Messages parts 6 & 7).
3. **Current Active Background Jobs on Lubuntu:**
   - **Job A (`p14_preserve.log`):** Downloading `takeout-20251231T032548Z-14-001.zip` (23.6 GiB) to `/mnt/databank/staging/p14.zip` and preserving recordings, screenshots, and notes into `/mnt/databank/canonical/google_takeout/drive_2025/`.
   - **Job B (`photo_crossmatch.log`):** Cross-matching 2022 vs 2025 Google Photos takeouts and OneDrive `Pictures` directories.
   - Note: Because of heavy 24 GB write sync to `/dev/sdb1`, SSH banner exchange may take 10-15s until writeback buffers flush.

---

## 2. Decided Architectural Invariants (Confirmed by User 2026-11-01)

1. **Gwen's Messenger Archive (349 conversations, 44.2k messages):**
   - **User Decision:** Keep in vault, allocate strictly to her personal knowledge base.
   - **Implementation:** Partition in `databank.db` with `owner: "gwen"` and `tier: "gwen-knowledge-base"`. Exclude from Michael's default `/ask` context.
2. **Primary Photo & Video Home:**
   - **User Decision:** Google Drive / Google Photos (5 TB Google One AI Pro plan).
   - **Implementation:** All master photos/videos consolidate to Google Drive. Once verified by coverage ledger, duplicate OneDrive `Pictures` (~821 GB) and takeout zips will be deleted to reclaim ~1 TB on OneDrive.
3. **Cloud Mirror Encryption:**
   - **User Decision:** Encrypt off-site Google Drive backups with `rclone crypt`.
   - **Implementation:** Overlay `gdrive:Databank_Backup` with an `rclone crypt` remote. Store keys in Google Password Manager alongside `databank.key`.
4. **Product 14 Videos (15.4 GB):**
   - **User Decision:** Upload directly to Google Drive / Photos; do NOT store raw videos on `/mnt/databank`.
   - **Implementation:** Bypasses local canonical vault to strictly maintain the 870+ GB free space invariant on Lubuntu.
5. **Password Files in Search Index:**
   - **User Decision:** Remove `Google_Passwords.pdf` and `Google_Passwords.xlsx` from the searchable Databank index; leave only in encrypted cold backup.
6. **Therapy Records (Clinical Tier):**
   - **User Resource:** Zoom Canvas shared note link: `https://mynotes.zoom.us/5L037ZYkTPCKcwY4R490OA`.
   - **Rules:** Local processing only (`whisper.cpp` / local llama.cpp), zero plaintext in agent logs, zero transmission to cloud LLMs, stored in encrypted `clinical` tier.

---

## 3. Codex Execution Playbook (Prioritized Order)

### Phase 0: The Safety Net (Critical Priority)
1. **Old-PC Archive Rescue:**
   - Wait for Lubuntu SSH to be responsive (`ssh michael@100.69.94.119 "uptime"`).
   - Run rsync: `rsync -av --progress /home/michael/oldpc-archive/ /mnt/databank/canonical/oldpc/`
   - Verify file counts and sample SHA-256 hashes against `dedup_manifest.db`.
   - Mirror to Google Drive: `rclone copy /mnt/databank/canonical/oldpc/ gdrive:Databank_Backup/canonical/oldpc/ --stats 60s`
2. **Quarantine Passwords from Search Index:**
   - Delete items where `path LIKE '%Google_Passwords%'` or `title LIKE '%Google Passwords%'` from `/mnt/databank/index/databank.db`.
   - Re-index or verify `databank.mjs search "password"` no longer returns plaintext credential files.
3. **Tag Gwen's Knowledge Base:**
   - Run SQL update on `databank.db`: update `items` set `source = 'gwen-messenger'`, `kind = 'conversation'` where `source = 'facebook-messenger'`.

### Phase 1: Intake & Ledger Verification
1. **Product 14 Verification & Cleanup:**
   - Check `/mnt/databank/index/p14_preserve.log`.
   - Verify preserved files in `/mnt/databank/canonical/google_takeout/drive_2025/`.
   - Remove `staging/p14.zip` from Lubuntu to free 24 GB.
   - Delete `takeout-20251231T032548Z-14-001.zip` from OneDrive using `rclone delete` to reclaim 25.4 GB.
2. **Upload Product 14 Videos to Google Drive:**
   - Extract `.mp4` files directly to `gdrive:Databank_Backup/videos/` without storing on `/mnt/databank`.

### Phase 2: Real Timestamps & People Graph
1. **Timestamp Fix:**
   - Parse real conversation timestamps from metadata instead of `now()` for Cube ACR calls and FB Messenger.
2. **People Graph Resolver:**
   - Map phone numbers, caller IDs, and names to canonical person entities (Gwen, Mom Cindy, Uncle Robert, Aunt Pam, etc.).

---

## 4. How to Launch Codex

Codex CLI is installed and authenticated via ChatGPT Plus ($0 incremental cost):
- **Interactive TUI:** Open Windows Terminal in `C:\Users\micha\projects\sovereign-exocortex` and run:
  ```powershell
  codex
  ```
- **Autonomous Headless Execution:**
  ```powershell
  codex exec "Read C:\Users\micha\projects\sovereign-exocortex\HERMES_HANDOFF_2026-11-01.md and execute Phase 0 (oldpc archive rescue and password quarantine)." --dangerously-bypass-approvals-and-sandbox
  ```
