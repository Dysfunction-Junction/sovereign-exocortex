#!/usr/bin/env python3
"""
scripts/execute_phase2_truth_repair.py
Repairs chronological timestamps across:
1. cube-acr-calls (586 items) -> real call start timestamps (Central Time)
2. gwen-messenger (349 items) -> real message timestamps (Central Time)
3. google-drive-takeout (387 items) -> real file mtimes from p14_coverage_ledger.db

Hardened with:
- --dry-run (default: False when explicit flag passed)
- Read-only ledger connection (URI mode=ro)
- PRAGMA busy_timeout = 30000
- Single atomic transaction
- Explicit America/Chicago timezone for local sources
- Non-ambiguous ledger path matching (collision-resistant)
- Source attribution metadata: ts_source = 'parsed' | 'folder_fallback' | 'ledger_mtime'
"""

import argparse
import json
import os
import re
import sqlite3
import sys
from collections import defaultdict
from datetime import datetime
from zoneinfo import ZoneInfo

CHICAGO_TZ = ZoneInfo("America/Chicago")

def parse_args():
    parser = argparse.ArgumentParser(description="Repair Databank chronological timestamps.")
    parser.add_argument("--db", default="/mnt/databank/index/databank.db", help="Path to databank.db")
    parser.add_argument("--ledger", default="/mnt/databank/index/p14_coverage_ledger.db", help="Path to p14_coverage_ledger.db")
    parser.add_argument("--dry-run", action="store_true", help="Preview updates without modifying the database")
    parser.add_argument("--backup", action="store_true", help="Create a VACUUM INTO backup before modifying")
    return parser.parse_args()

def main():
    args = parse_args()
    print(f"Connecting to DB: {args.db}")
    print(f"Connecting to Ledger (ro): {args.ledger}")
    print(f"Mode: {'DRY RUN' if args.dry_run else 'LIVE EXECUTION'}")

    if not os.path.exists(args.db):
        sys.exit(f"Database not found: {args.db}")
    if not os.path.exists(args.ledger):
        sys.exit(f"Ledger not found: {args.ledger}")

    # Optional backup
    if args.backup and not args.dry_run:
        bak_path = f"{args.db}.bak_{datetime.now().strftime('%Y%m%d_%H%M%S')}"
        print(f"Creating live backup via VACUUM INTO {bak_path}...")
        bak_conn = sqlite3.connect(args.db)
        bak_conn.execute(f"VACUUM INTO '{bak_path}'")
        bak_conn.close()
        print("Backup created successfully.")

    db = sqlite3.connect(args.db)
    c = db.cursor()
    c.execute("PRAGMA busy_timeout = 30000;")

    ledger_db = sqlite3.connect(f"file:{os.path.abspath(args.ledger)}?mode=ro", uri=True)
    c_ledger = ledger_db.cursor()

    # Pre-index p14_ledger non-ambiguously
    ledger_map = {}
    basename_to_mtimes = defaultdict(list)

    for fname, mtime in c_ledger.execute("SELECT filename, mtime FROM p14_ledger WHERE mtime IS NOT NULL"):
        parts = fname.split('/')
        if len(parts) > 2 and parts[0] == 'Takeout' and parts[1] == 'Drive':
            key = "_".join(parts[2:]).replace('/', '_').replace('\\', '_').replace(' ', '_')
            ledger_map[key] = mtime
        key2 = fname.replace('/', '_').replace('\\', '_').replace(' ', '_')
        ledger_map[key2] = mtime
        base = parts[-1].replace(' ', '_')
        basename_to_mtimes[base].append(mtime)

    # Only map unique basenames
    for base, mtimes in basename_to_mtimes.items():
        if len(mtimes) == 1 and base not in ledger_map:
            ledger_map[base] = mtimes[0]

    if not args.dry_run:
        db.execute("BEGIN IMMEDIATE;")

    # 1. CUBE ACR CALLS
    print("\n--- Processing cube-acr-calls ---")
    cube_rows = c.execute("SELECT item_id, title, meta FROM items WHERE source = 'cube-acr-calls'").fetchall()
    cube_updated = 0

    for item_id, title, meta_str in cube_rows:
        meta = json.loads(meta_str or '{}')
        dr = meta.get('date_range', '')
        start_ts_str = dr.split(' to ')[0].strip() if ' to ' in dr else dr.strip()
        dt = None

        if start_ts_str:
            for fmt in ["%Y:%m:%d %H:%M:%S", "%Y-%m-%d %H:%M:%S", "%Y:%m:%d %H-%M-%S"]:
                try:
                    dt = datetime.strptime(start_ts_str, fmt).replace(tzinfo=CHICAGO_TZ)
                    break
                except Exception:
                    pass

        if not dt:
            chunk = c.execute("SELECT text FROM chunks WHERE item_id = ? AND ord = 0", (item_id,)).fetchone()
            if chunk:
                m = re.search(r'•\s*(\d{4}[:\-]\d{2}[:\-]\d{2}\s+\d{2}[:\-]\d{2}[:\-]\d{2})', chunk[0])
                if m:
                    s = m.group(1).replace('-', ':')
                    try:
                        dt = datetime.strptime(s, "%Y:%m:%d %H:%M:%S").replace(tzinfo=CHICAGO_TZ)
                    except Exception:
                        pass

        if dt:
            epoch_ms = int(dt.timestamp() * 1000)
            meta["start_ts_ms"] = epoch_ms
            meta["ts_source"] = "parsed"
            if not args.dry_run:
                c.execute("UPDATE items SET ts = ?, meta = ? WHERE item_id = ?", (epoch_ms, json.dumps(meta), item_id))
            cube_updated += 1

    print(f"Cube ACR calls resolved: {cube_updated} / {len(cube_rows)}")

    # 2. GWEN MESSENGER
    print("\n--- Processing gwen-messenger ---")
    gwen_rows = c.execute("SELECT item_id, title, meta FROM items WHERE source = 'gwen-messenger'").fetchall()
    folder_dt = {}
    gwen_parsed = {}

    for item_id, title, meta_str in gwen_rows:
        meta = json.loads(meta_str or '{}')
        folder = meta.get('folder', 'unknown')
        chunks = c.execute("SELECT text FROM chunks WHERE item_id = ? ORDER BY ord ASC", (item_id,)).fetchall()
        all_text = "\n".join(ch[0] for ch in chunks)
        # Normalize narrow no-break space (U+202F) and standard whitespace
        all_text_norm = all_text.replace('\u202f', ' ')
        matches = re.findall(r'\[([A-Za-z]{3}\s+\d{1,2},\s+\d{4}\s+[^\]]+)\]', all_text_norm)
        dt = None
        if matches:
            first_ts = matches[0].strip()
            s = re.sub(r'([0-9])([ap]m)', r'\1 \2', first_ts, flags=re.IGNORECASE).upper()
            for fmt in ["%b %d, %Y %I:%M:%S %p", "%b %d, %Y %I:%M %p"]:
                try:
                    dt = datetime.strptime(s, fmt).replace(tzinfo=CHICAGO_TZ)
                    break
                except Exception:
                    pass
        if dt:
            gwen_parsed[item_id] = dt
            if folder not in folder_dt or dt < folder_dt[folder]:
                folder_dt[folder] = dt

    gwen_updated = 0
    for item_id, title, meta_str in gwen_rows:
        meta = json.loads(meta_str or '{}')
        folder = meta.get('folder', 'unknown')
        dt = gwen_parsed.get(item_id)
        is_fallback = False

        part_num = 1
        part_match = re.search(r'\(Part\s+(\d+)\)', title)
        if part_match:
            part_num = int(part_match.group(1))

        if not dt and folder in folder_dt:
            dt = folder_dt[folder]
            is_fallback = True

        if dt:
            # Apply offset ONLY on folder fallback path, not to real parsed timestamps
            offset_ms = (part_num - 1) * 600_000 if is_fallback else 0
            epoch_ms = int(dt.timestamp() * 1000) + offset_ms
            meta["start_ts_ms"] = epoch_ms
            meta["ts_source"] = "folder_fallback" if is_fallback else "parsed"
            if not args.dry_run:
                c.execute("UPDATE items SET ts = ?, meta = ? WHERE item_id = ?", (epoch_ms, json.dumps(meta), item_id))
            gwen_updated += 1

    print(f"Gwen Messenger resolved: {gwen_updated} / {len(gwen_rows)}")

    # 3. GOOGLE DRIVE TAKEOUT
    print("\n--- Processing google-drive-takeout ---")
    gdrive_rows = c.execute("SELECT item_id, title, path, meta FROM items WHERE source = 'google-drive-takeout'").fetchall()
    gdrive_updated = 0
    chunk_headers_updated = 0

    for item_id, title, path, meta_str in gdrive_rows:
        mtime = ledger_map.get(path)
        if not mtime and path.startswith('_'):
            mtime = ledger_map.get(path[1:])

        if mtime:
            dt = datetime.fromtimestamp(mtime, tz=CHICAGO_TZ)
            # Sanity bound: 2000 <= year <= 2030
            if 2000 <= dt.year <= 2030:
                epoch_ms = int(mtime * 1000)
                meta = json.loads(meta_str or '{}')
                meta["mtimeMs"] = epoch_ms
                meta["ts_source"] = "ledger_mtime"
                if not args.dry_run:
                    c.execute("UPDATE items SET ts = ?, meta = ? WHERE item_id = ?", (epoch_ms, json.dumps(meta), item_id))
                gdrive_updated += 1

                chunk = c.execute("SELECT chunk_id, text FROM chunks WHERE item_id = ? AND ord = 0", (item_id,)).fetchone()
                if chunk:
                    chunk_id, text = chunk
                    real_date_str = dt.strftime("%Y-%m-%d")
                    new_text = re.sub(r'date:\s*2026-1[01]-\d{2}', f'date: {real_date_str}', text, count=1)
                    if new_text != text:
                        if not args.dry_run:
                            c.execute("UPDATE chunks SET text = ? WHERE chunk_id = ?", (new_text, chunk_id))
                        chunk_headers_updated += 1

    print(f"Google Drive Takeout items resolved: {gdrive_updated} / {len(gdrive_rows)}")
    print(f"Chunk 0 date headers updated: {chunk_headers_updated}")

    if not args.dry_run:
        # Rebuild FTS in same atomic transaction
        print("\n--- Rebuilding chunks_fts index ---")
        c.execute("INSERT INTO chunks_fts(chunks_fts) VALUES('rebuild');")
        db.commit()
        print("chunks_fts rebuilt and transaction committed successfully.")
    else:
        print("\n[Dry Run] No database modifications written.")

    # Verification stats
    print("\n--- Source Time Ranges ---")
    for row in c.execute("SELECT source, count(*), min(ts), max(ts) FROM items GROUP BY source"):
        s, cnt, min_ts, max_ts = row
        min_dt = datetime.fromtimestamp(min_ts / 1000.0, tz=CHICAGO_TZ).strftime('%Y-%m-%d %H:%M') if min_ts else 'N/A'
        max_dt = datetime.fromtimestamp(max_ts / 1000.0, tz=CHICAGO_TZ).strftime('%Y-%m-%d %H:%M') if max_ts else 'N/A'
        print(f"  {s:<22} count: {cnt:>5} | min: {min_dt} | max: {max_dt}")

    db.close()
    ledger_db.close()

if __name__ == "__main__":
    main()
