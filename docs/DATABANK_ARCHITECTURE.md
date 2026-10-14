# Databank: encrypted cold archive + searchable index (Lubuntu, WD 1 TB)

Status: designed and implemented in `packages/databank` (2026-10-11). Not yet deployed:
the old PC drive is being copied off first, then wiped and formatted by `ops/setup-volume.sh`.

## Goal

A place for everything that is too big or too old for the PC's hot memory store
(`packages/memory`), that stays **searchable** and **private**:

- archived/overflow `LocalLTM` memories,
- the Pieces LTM backup and future Screenpipe-style captures,
- the old-PC photos, videos and documents (~155 GB),
- later: exported event-log segments, message/voicemail archives.

## Topology

```
 PC (Windows, i7, Ollama)            Lubuntu (hplubunhaos, Ryzen 5 2600H, 6.7 GB RAM)
 ┌──────────────────────┐            ┌──────────────────────────────────────────────┐
 │ exocortexd (hot)     │            │ systemd: databank (node 24)  127.0.0.1:8790    │
 │ LocalLTM memories    │  tailnet   │   Tailscale Serve  https://…ts.net:8443 ──┐    │
 │ Ollama nomic-embed ◄─┼────────────┼── embeds on demand (fail-soft to FTS)     │    │
 │ `databank` CLI/client│  bearer    │                                           ▼    │
 └──────────────────────┘  token     │ /mnt/databank  (LUKS2 + ext4, WD10EZEX)       │
                                     │   .vault-id            marker; service refuses │
                                     │   index/databank.db    SQLite: FTS5 + vectors  │
                                     │   blobs/aa/bb/<id>     content-addressed, AES  │
                                     └──────────────────────────────────────────────┘
```

Two tiers, one disk:

| Tier | What | Where | Why |
|---|---|---|---|
| Index | items, chunk text, FTS5, int8 vectors, ingest log | `index/databank.db` | search never touches blobs |
| Blobs | original files, immutable, content-addressed | `blobs/` | fetched only when you open a hit |

Nothing here is "hot": the PC keeps its own recent memory. Items move here when old
(`databank archive-memories --older-than-days 90`) and stay searchable from both sides.

## Why not the router USB port

SQLite over SMB/NFS corrupts under locking failures and a router NAS can't run the
service. The drive is local to Lubuntu; the router is not involved.

## Threat model and encryption (three layers, each does a different job)

1. **LUKS2 (aes-xts-plain64, argon2id) on the whole volume.** Protects against theft or
   disposal of the drive or the Lubuntu box. **The passphrase is never stored on
   Lubuntu.** After a reboot the vault is locked and the service stays down until you run
   the **Unlock Databank** desktop button (or `ssh -t lubuntu sudo databank-unlock`). The button
   (`ops/windows/unlock-databank.ps1`) prompts for the passphrase with hidden input and pipes it
   over SSH into `databank-unlock --stdin`; nothing is saved on either machine. (Trade-off: no
   unattended boot; an always-on keyfile would only defend against drive-only theft.)
2. **Per-blob AES-256-GCM (streamed, 1 MiB frames)**, subkey from HKDF of a 32-byte master
   key file kept on the PC (and in your password manager), *not* on the drive. Protects
   copies of `blobs/` that leave the machine (offsite backup) and a mounted-but-unattended
   vault. Frames are authenticated individually and bound to their index and to the
   final-frame flag, so truncation, reordering and bit flips are all detected.
3. **Blob IDs are `HMAC-SHA256(idKey, plaintext)`**, not a plain hash. Deduplication still
   works, but nobody holding only the blobs can confirm "this exact file is in here".

Not encrypted at the application layer: item titles, paths and chunk text in `databank.db`
(FTS and vectors need plaintext). That is why layer 1 is mandatory and why the database
never leaves the mounted volume. Plain vectors can leak content, so do not copy the DB off
the vault; back it up inside the LUKS volume or re-encrypt the whole file.

Service rules: bearer token (constant-time compare), binds to loopback only (Tailscale
Serve provides the tailnet HTTPS), refuses to start without `.vault-id` present on the
mount (so a locked/unmounted vault can never silently fill the root disk), no blob path
is ever taken from client input (IDs are validated as 64 hex chars).

## Schema (SQLite, WAL)

```
meta(key, value)                       schema_version, embed_model, embed_dim
items(item_id PK, source, kind, title, path, mime, size, ts, blob_id,
      meta JSON, tier, ingested_at)    item_id = sha256(source|path|blob_id)[:32] -> idempotent
chunks(chunk_id PK, item_id FK, ord, text, UNIQUE(item_id, ord))
chunks_fts  FTS5(text) external-content over chunks, porter unicode61
vectors(chunk_id PK FK, model, dim, scale, q8 BLOB)    unit vector -> int8 (768 B/chunk)
ingest_log(seq PK, ts, action, item_id, prev_hash, hash)   hash-chained, UPDATE/DELETE abort
```

`kind`: `memory | document | photo | video | audio | text | other`.

## Search

`search(q, {k, kind, source, since, until})`:
1. FTS5 `bm25` top 50 (query sanitised to quoted terms, no operator injection).
2. If the embedder answers within 5 s: cosine against all int8 vectors (in-memory typed
   array, rebuilt only when the vector count changes). Otherwise FTS only.
3. Score = 0.6 · cosine_norm + 0.4 · bm25_norm (min-max over the candidate union); best
   chunk per item; filters applied in SQL before scoring.

Capacity: 1 M chunks ≈ 770 MB of int8 vectors in RAM, which is the ceiling on this 6.7 GB
box (HAOS VM uses ~2.7 GB). Photos/videos get one metadata chunk each (path words + date),
not pixels; vision captions are an optional `Captioner` hook (Gemini API, not yet wired).

## Ingest

- `ingest-dir <dir>`: walks, hashes (HMAC), encrypts + stores the blob, extracts text
  (txt/md/csv/json/html direct; pdf via `pdftotext`; docx via `unzip -p`), chunks ~800
  chars with 100 overlap, embeds, writes the index in one transaction per item.
- `archive-memories`: moves `LocalLTM` entries older than N days; `--prune` rewrites
  `memories.jsonl` without them after writing a timestamped backup.
- Every write appends to `ingest_log` (hash chain), checkable with `databank verify`.

## Failure behaviour

Embedder down → item stored with FTS only, `vectors` row missing, backfilled by
`databank reindex`. Crash mid-ingest → blob temp files are renamed atomically only after
fsync; index transaction rolls back; re-run is idempotent. Corrupt blob → GCM tag fails,
`verify` reports the ID.

## Deploy checklist (after the copy is verified)

Lubuntu already runs Node 24.16.0 (installed to /usr/local on 2026-10-11), so the service is
one esbuild-bundled file, no Docker and no node_modules.

1. `ops/setup-volume.sh --device /dev/sdb --serial <SERIAL> --dry-run`, then again with
   `--yes-wipe` over `ssh -t` (asks for the LUKS passphrase). Copy the LUKS header backup
   it prints off the machine.
2. On the PC: `databank keygen <file>`; back it up outside the vault; copy it to
   `/etc/databank.key` on Lubuntu (mode 640 root:michael).
3. `ops/deploy.sh michael@100.69.94.119`, then edit `/etc/databank.env` (token, key path).
4. After every reboot click **Unlock Databank** (`ops/windows/make-shortcuts.ps1` creates the
   Unlock / Lock / Status buttons), then
   `tailscale serve --bg --https=8443 http://127.0.0.1:8790` once.
5. `databank ingest-dir /home/michael/oldpc-archive --source oldpc`, then
   `databank archive-memories packages/memory/data/memories.jsonl --older-than-days 90`.

## Tests

`packages/databank`: 31 tests (crypto tamper/truncate/reorder, blob store, index/search,
filters, hash chain, archive/prune, server auth). `pnpm --filter @exocortex/databank test`.
