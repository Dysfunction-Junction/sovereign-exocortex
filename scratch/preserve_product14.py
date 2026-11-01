#!/usr/bin/env python3
"""Product 14 (Google Drive takeout 2025): preserve non-ingested, relevant files into canonical.

- Reads the staged zip; every member read is CRC-verified by zipfile.
- Skips: installers/binaries (.apk .exe .tini), AvastCleanup, docs already ingested into the
  Databank blob store, files whose SHA-256 is already in canonical, and files whose
  (name,size) still live on Google Drive (gdrive_manifest).
- Writes keepers to /mnt/databank/canonical/google_takeout/drive_2025/<path under Takeout/Drive>
  and registers them in dedup_manifest.db canonical_files.
- Does NOT delete anything from OneDrive; prints a summary for review.
"""
import hashlib, json, os, sqlite3, sys, time, zipfile
from collections import Counter

ZIP = sys.argv[1]
SRC_LABEL = 'onedrive:Apps/Google Download Your Data/takeout-20251231T032548Z-14-001.zip'
CANON = '/mnt/databank/canonical'
DEST_REL = 'google_takeout/drive_2025'
SKIP_EXT = {'.apk', '.exe', '.tini'}
INGESTED_DOC_EXT = {'.pdf', '.docx', '.xlsx', '.doc', '.txt', '.csv', '.html', '.gpx'}
SKIP_DIRS = {'AvastCleanup', 'net.appcake.apk'}

man = sqlite3.connect('/mnt/databank/index/dedup_manifest.db')
known_sha = {r[0] for r in man.execute('select sha256 from canonical_files')}
g = sqlite3.connect('/mnt/databank/index/gdrive_manifest.db')
on_gdrive = {(n, s) for n, s in g.execute('select name,size_bytes from gdrive_files where is_dir=0')}

stats = Counter(); sizes = Counter(); kept_by_ext = Counter(); kept_sz = Counter()
now = time.time(); t0 = now
with zipfile.ZipFile(ZIP) as zf:
    members = [i for i in zf.infolist() if not i.is_dir()]
    for n, info in enumerate(members, 1):
        parts = info.filename.split('/')
        ext = os.path.splitext(info.filename)[1].lower()
        base = parts[-1]
        if any(p in SKIP_DIRS for p in parts) or ext in SKIP_EXT:
            stats['skip_junk'] += 1; sizes['skip_junk'] += info.file_size; continue
        if ext in INGESTED_DOC_EXT and 'Cube ACR' not in info.filename:
            stats['skip_already_ingested_doc'] += 1; continue
        if (base, info.file_size) in on_gdrive:
            stats['skip_still_on_gdrive'] += 1; sizes['skip_still_on_gdrive'] += info.file_size; continue
        data = zf.read(info)  # raises on CRC mismatch
        sha = hashlib.sha256(data).hexdigest()
        if sha in known_sha:
            stats['skip_duplicate_sha'] += 1; sizes['skip_duplicate_sha'] += info.file_size; continue
        rel_in = '/'.join(parts[2:]) if parts[:2] == ['Takeout', 'Drive'] else '/'.join(parts)
        rel = f'{DEST_REL}/{rel_in}'
        out = os.path.join(CANON, rel)
        os.makedirs(os.path.dirname(out), exist_ok=True)
        with open(out, 'wb') as f:
            f.write(data)
        mtime = time.mktime(info.date_time + (0, 0, -1))
        os.utime(out, (mtime, mtime))
        man.execute('insert into canonical_files values (?,?,?,?,?,?,?,?)',
                    (sha, info.file_size, rel, f'{SRC_LABEL}!/{info.filename}', mtime, 1, '[]', now))
        known_sha.add(sha)
        stats['kept'] += 1; sizes['kept'] += info.file_size
        kept_by_ext[ext or '(none)'] += 1; kept_sz[ext or '(none)'] += info.file_size
        if n % 500 == 0:
            man.commit()
            print(f'{n}/{len(members)} scanned, kept {stats["kept"]} ({sizes["kept"]/1048576:.0f} MB), {time.time()-t0:.0f}s', flush=True)
man.commit()

print('\nSUMMARY', json.dumps({k: [stats[k], round(sizes[k] / 1048576, 1)] for k in stats}, indent=1))
print('KEPT BY TYPE:')
for e, c in kept_sz.most_common():
    print(f'  {e:8} {kept_by_ext[e]:6} files {c/1048576:9.1f} MB')
print(f'DONE in {time.time()-t0:.0f}s')
