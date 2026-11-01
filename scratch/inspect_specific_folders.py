import zipfile

zpath = '/tmp/od_mount/Apps/Google\u2060 Download Your Data/takeout-20251231T032548Z-14-001.zip'

folders_to_check = ['Dont Open Dumbass', 'NoteblocData', 'Phone Scans', 'Portfolio', 'My Computer']

with zipfile.ZipFile(zpath, 'r') as zf:
    for folder in folders_to_check:
        print(f"\n=== Folder: {folder} ===")
        matches = [f.filename for f in zf.infolist() if f'Takeout/Drive/{folder}/' in f.filename and not f.is_dir()][:15]
        for m in matches:
            print(" ", m)
