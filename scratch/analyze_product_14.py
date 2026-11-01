import zipfile
import os
from collections import Counter

zpath = '/tmp/od_mount/Apps/Google\u2060 Download Your Data/takeout-20251231T032548Z-14-001.zip'
ext_counter = Counter()
ext_size = Counter()
total_files = 0

print(f"Opening {zpath}...")
with zipfile.ZipFile(zpath, 'r') as zf:
    for info in zf.infolist():
        if not info.is_dir():
            total_files += 1
            ext = os.path.splitext(info.filename)[1].lower()
            ext_counter[ext] += 1
            ext_size[ext] += info.file_size

print(f"Total files: {total_files}")
print("\nTop extensions by count:")
for ext, count in ext_counter.most_common(25):
    print(f"  {ext:10}: {count:5} files, {ext_size[ext]/(1024*1024):8.2f} MB")

print("\nTop extensions by total size:")
for ext, size in ext_size.most_common(20):
    print(f"  {ext:10}: {ext_counter[ext]:5} files, {size/(1024*1024):8.2f} MB")
