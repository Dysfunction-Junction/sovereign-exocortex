import zipfile
import json

zpath = '/tmp/od_mount/Apps/Google\u2060 Download Your Data/takeout-20251231T032548Z-14-001.zip'

with zipfile.ZipFile(zpath, 'r') as zf:
    json_samples = [f.filename for f in zf.infolist() if 'Cube ACR' in f.filename and f.filename.lower().endswith('.json')][:3]
    for s in json_samples:
        print("=== File:", s)
        try:
            content = zf.read(s).decode('utf-8', errors='replace')
            print(content[:500])
        except Exception as e:
            print("Error reading:", e)
