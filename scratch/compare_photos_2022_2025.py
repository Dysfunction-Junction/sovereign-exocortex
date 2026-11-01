#!/usr/bin/env python3
"""Compare 2022 Google Photos takeout against the 2025 takeout (+ canonical phone backups)
using only zip central directories (name, size, CRC32) -- no photo bytes are downloaded."""
import json, os, sqlite3, zipfile, zlib
from collections import Counter, defaultdict

BASE = '/tmp/od_mount/Apps/Google\u2060 Download Your Data/'
names = sorted(os.listdir(BASE))
z22 = [n for n in names if n.startswith('takeout-20221130') and n.endswith('.zip')]
z25 = [n for n in names if n.startswith('takeout-20251231T032548Z-12-')]
MEDIA = {'.jpg', '.jpeg', '.png', '.heic', '.gif', '.webp', '.mp4', '.mov', '.3gp', '.m4v', '.dng', '.bmp', '.avi', '.mkv', '.webm'}

def scan(zips):
    ents = {}  # (crc,size) -> sample info
    for z in zips:
        with zipfile.ZipFile(BASE + z) as zf:
            for i in zf.infolist():
                if i.is_dir():
                    continue
                ext = os.path.splitext(i.filename)[1].lower()
                if ext not in MEDIA:
                    continue
                k = (i.CRC, i.file_size)
                if k not in ents:
                    ents[k] = (z, i.filename, i.date_time)
        print(f'  scanned {z}: unique media so far {len(ents)}', flush=True)
    return ents

print('2022 zips:', z22); a = scan(z22)
print('2025 zips:', z25); b = scan(z25)

missing = {k: v for k, v in a.items() if k not in b}
print(f'\n2022 unique media: {len(a)} ({sum(k[1] for k in a)/2**30:.1f} GiB)')
print(f'2025 unique media: {len(b)} ({sum(k[1] for k in b)/2**30:.1f} GiB)')
print(f'2022 media ALSO in 2025: {len(a)-len(missing)}')
print(f'2022 media NOT in 2025:  {len(missing)} ({sum(k[1] for k in missing)/2**30:.2f} GiB)')

# Check the not-in-2025 leftovers against canonical phone backups (same size -> CRC32 the canonical file)
man = sqlite3.connect('/mnt/databank/index/dedup_manifest.db')
by_size = defaultdict(list)
for sz, rel in man.execute('select size_bytes, canonical_relpath from canonical_files'):
    by_size[sz].append(rel)
in_canon = set()
for (crc, sz) in missing:
    for rel in by_size.get(sz, []):
        p = '/mnt/databank/canonical/' + rel
        try:
            with open(p, 'rb') as f:
                c = 0
                for chunk in iter(lambda: f.read(1 << 20), b''):
                    c = zlib.crc32(chunk, c)
            if c == crc:
                in_canon.add((crc, sz)); break
        except OSError:
            pass
truly = {k: v for k, v in missing.items() if k not in in_canon}
print(f'  of those, found in canonical phone backups: {len(in_canon)}')
print(f'  ONLY in 2022 takeout (nowhere else known): {len(truly)} ({sum(k[1] for k in truly)/2**30:.2f} GiB)')

folders = Counter(); fsz = Counter()
for (crc, sz), (z, fn, dt) in truly.items():
    f = '/'.join(fn.split('/')[1:3]); folders[f] += 1; fsz[f] += sz
print('  ONLY-in-2022 by folder (top 25):')
for f, c in folders.most_common(25):
    print(f'    {f}: {c} files, {fsz[f]/2**20:.0f} MB')
json.dump([{'zip': z, 'path': fn, 'size': sz, 'crc': crc, 'date': dt} for (crc, sz), (z, fn, dt) in truly.items()],
          open('/mnt/databank/index/photos_only_in_2022.json', 'w'))
print('Wrote /mnt/databank/index/photos_only_in_2022.json')
