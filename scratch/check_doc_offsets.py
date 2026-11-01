import zipfile
import os

zpath_drive = '/tmp/od_mount/Apps/Google\u2060 Download Your Data/takeout-20251231T032548Z-14-001.zip'
DOC_EXTS = {'.pdf', '.docx', '.xlsx', '.doc', '.txt', '.csv', '.html', '.gpx'}

with zipfile.ZipFile(zpath_drive, 'r') as zf:
    docs = [info for info in zf.infolist() if not info.is_dir() and os.path.splitext(info.filename)[1].lower() in DOC_EXTS]
    print(f"Total doc entries in zip: {len(docs)}")
    
    # Check folder distribution of docs
    folders = {}
    for d in docs:
        parts = d.filename.split('/')
        fld = parts[2] if len(parts) > 2 else 'root'
        folders[fld] = folders.get(fld, 0) + 1
        
    for fld, cnt in sorted(folders.items(), key=lambda x: x[1], reverse=True):
        print(f"  {fld:30}: {cnt} docs")
