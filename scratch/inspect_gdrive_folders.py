import zipfile
import os
from collections import Counter

zpath = '/tmp/od_mount/Apps/Google\u2060 Download Your Data/takeout-20251231T032548Z-14-001.zip'

with zipfile.ZipFile(zpath, 'r') as zf:
    folders = Counter()
    for f in zf.infolist():
        parts = f.filename.split('/')
        if len(parts) > 2 and parts[0] == 'Takeout' and parts[1] == 'Drive':
            folders[parts[2]] += 1
            
    print("Folders in Takeout/Drive:")
    for folder, count in folders.most_common(50):
        print(f"  {folder:35}: {count:5} items")
