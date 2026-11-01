#!/usr/bin/env python3
"""Cross-match photos by (basename, size) across:
   A) 2022 takeout-only media (photos_only_in_2022.json)
   B) 2025 Google Photos takeout (central directories)
   C) OneDrive Pictures/, Pictures 1/, Desktop/fotos (rclone lsjson)
No photo bytes are downloaded."""
import json, os, subprocess, zipfile
from collections import Counter, defaultdict

BASE = '/tmp/od_mount/Apps/Google\u2060 Download Your Data/'
MEDIA = {'.jpg', '.jpeg', '.png', '.heic', '.gif', '.webp', '.mp4', '.mov', '.3gp', '.m4v', '.dng', '.bmp', '.avi', '.mkv', '.webm'}
ism = lambda n: os.path.splitext(n)[1].lower() in MEDIA

only22 = json.load(open('/mnt/databank/index/photos_only_in_2022.json'))
only22 = [e for e in only22 if 'AvastCleanup' not in e['path']]

# 2025 takeout index
t25_ns, t25_n = set(), defaultdict(set)
for z in sorted(os.listdir(BASE)):
    if z.startswith('takeout-20251231T032548Z-12-'):
        with zipfile.ZipFile(BASE + z) as zf:
            for i in zf.infolist():
                if not i.is_dir() and ism(i.filename):
                    b = os.path.basename(i.filename)
                    t25_ns.add((b, i.file_size)); t25_n[b].add(i.file_size)
# 2022 takeout index (all media)
t22_ns = set()
for z in sorted(os.listdir(BASE)):
    if z.startswith('takeout-20221130') and z.endswith('.zip'):
        with zipfile.ZipFile(BASE + z) as zf:
            for i in zf.infolist():
                if not i.is_dir() and ism(i.filename):
                    t22_ns.add((os.path.basename(i.filename), i.file_size))

# OneDrive photo folders
od = []
for folder in ['Pictures', 'Pictures 1', 'Desktop/fotos']:
    out = subprocess.run(['rclone', 'lsjson', '-R', '--files-only', '--no-mimetype', f'onedrive:{folder}'],
                         capture_output=True, text=True)
    if out.returncode != 0:
        print('lsjson failed', folder, out.stderr[-300:]); continue
    for e in json.loads(out.stdout or '[]'):
        od.append((folder, e['Path'], e['Name'], e['Size']))
od_ns = {(n, s) for _, _, n, s in od}
print(f'OneDrive photo folders: {len(od)} files, {sum(x[3] for x in od)/2**30:.1f} GiB '
      f'({sum(1 for x in od if ism(x[2]))} media files)')

# A) where do the 2022-only items live?
cat = Counter(); csz = Counter()
for e in only22:
    b = os.path.basename(e['path']); k = (b, e['size'])
    if k in t25_ns: c = 'in_2025_by_name+size(crc differs)'
    elif k in od_ns: c = 'in_onedrive_pictures'
    elif b in t25_n: c = 'name_in_2025_but_different_size(edited/re-encoded?)'
    else: c = 'nowhere_else'
    cat[c] += 1; csz[c] += e['size']
print(f'\nA) 2022-only media (excluding AvastCleanup): {len(only22)}')
for c, n in cat.most_common():
    print(f'   {c}: {n} files, {csz[c]/2**30:.2f} GiB')

# C) OneDrive Pictures coverage by Google Photos takeouts
cov = Counter(); covsz = Counter(); unc_folders = Counter(); unc_sz = Counter()
for folder, path, n, s in od:
    if not ism(n):
        cov['non_media'] += 1; covsz['non_media'] += s; continue
    k = (n, s)
    c = 'in_2025_takeout' if k in t25_ns else ('in_2022_takeout_only' if k in t22_ns else 'not_in_any_takeout')
    cov[c] += 1; covsz[c] += s
    if c == 'not_in_any_takeout':
        top = folder + '/' + '/'.join(path.split('/')[:2]); unc_folders[top] += 1; unc_sz[top] += s
print('\nC) OneDrive photo folders vs Google Photos takeouts (name+size):')
for c, n in cov.most_common():
    print(f'   {c}: {n} files, {covsz[c]/2**30:.1f} GiB')
print('   not-in-any-takeout by folder (top 30):')
for f, n in unc_folders.most_common(30):
    print(f'     {f}: {n} files, {unc_sz[f]/2**30:.2f} GiB')
