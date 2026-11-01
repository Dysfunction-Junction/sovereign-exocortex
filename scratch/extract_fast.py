import zipfile
import re
import os
import json
import time

zpath_drive = '/tmp/od_mount/Apps/Google\u2060 Download Your Data/takeout-20251231T032548Z-14-001.zip'
zpath_yt = '/tmp/od_mount/Apps/Google\u2060 Download Your Data/takeout-20251231T032548Z-8-001.zip'
zpath_nest = '/tmp/od_mount/Apps/Google\u2060 Download Your Data/takeout-20251231T032548Z-10-001.zip'

out_docs_dir = '/tmp/gdrive_docs'
out_calls_jsonl = '/tmp/cube_call_logs.jsonl'
out_yt_dir = '/tmp/youtube_takeout'
out_nest_dir = '/tmp/nest_takeout'

os.makedirs(out_docs_dir, exist_ok=True)
os.makedirs(out_yt_dir, exist_ok=True)
os.makedirs(out_nest_dir, exist_ok=True)

DOC_EXTS = {'.pdf', '.docx', '.xlsx', '.doc', '.txt', '.csv', '.html', '.gpx'}
IGNORE_DIRS = {'AvastCleanup', 'net.appcake.apk'}

print("Starting Fast Extraction...")
t0 = time.time()

# 1. Product 14 (Google Drive)
print("\n[1/3] Reading Google Drive Takeout (Product 14)...")
call_logs = []
extracted_doc_count = 0
extracted_doc_bytes = 0

with zipfile.ZipFile(zpath_drive, 'r') as zf:
    # First: parse all Cube ACR filenames in memory
    for info in zf.infolist():
        fname = info.filename
        ext = os.path.splitext(fname)[1].lower()
        if 'Cube ACR' in fname and ext in {'.m4a', '.amr'}:
            basename = os.path.basename(fname)
            name_no_ext = os.path.splitext(basename)[0]
            m = re.match(r'^(\d{4}-\d{2}-\d{2}\s+\d{2}-\d{2}-\d{2})\s+\(([^)]+)\)\s*(.*)$', name_no_ext)
            if m:
                dt_str, channel, rest = m.groups()
                direction = "Outgoing" if "↗" in rest else ("Incoming" if "↙" in rest else "Unknown")
                contact_or_number = rest.replace("↗", "").replace("↙", "").strip()
                dt_formatted = dt_str.replace('-', ':')
                
                # Check for phone number in parens
                phone = ""
                name = contact_or_number
                pmatch = re.search(r'\(([\+\d\s\-\(\)]+)\)', contact_or_number)
                if pmatch:
                    phone = pmatch.group(1).strip()
                    name = contact_or_number[:pmatch.start()].strip()
                elif re.match(r'^[\+\d\s\-]+$', contact_or_number):
                    phone = contact_or_number
                    name = ""
                    
                call_logs.append({
                    "id": f"cube_call_{len(call_logs)+1}",
                    "kind": "conversation",
                    "source": "cube-acr-calls",
                    "title": f"Call: {name or phone or 'Unknown'} ({channel})",
                    "timestamp": dt_formatted,
                    "metadata": {
                        "contact": name,
                        "phone": phone,
                        "channel": channel,
                        "direction": direction,
                        "file_size": info.file_size,
                        "raw_file": basename
                    },
                    "content": f"Call Record: {name or 'Unknown'}\nPhone Number: {phone}\nChannel: {channel}\nDirection: {direction}\nRecorded: {dt_formatted}\nSize: {info.file_size} bytes"
                })

    print(f"Parsed {len(call_logs)} Cube ACR call records from metadata.")
    with open(out_calls_jsonl, 'w', encoding='utf-8') as f_out:
        for rec in call_logs:
            f_out.write(json.dumps(rec, ensure_ascii=False) + '\n')
    print(f"Saved {out_calls_jsonl} ({os.path.getsize(out_calls_jsonl)/(1024*1024):.2f} MB)")

    # Second: Extract only the document files
    doc_entries = [
        info for info in zf.infolist()
        if not info.is_dir()
        and os.path.splitext(info.filename)[1].lower() in DOC_EXTS
        and not any(p in IGNORE_DIRS for p in info.filename.split('/'))
    ]
    print(f"Found {len(doc_entries)} documents to extract...")
    for idx, info in enumerate(doc_entries):
        parts = info.filename.split('/')
        safe_basename = "_".join(parts[2:]) if len(parts) > 2 else os.path.basename(info.filename)
        safe_basename = safe_basename.replace('/', '_').replace('\\', '_').replace(' ', '_')
        target_path = os.path.join(out_docs_dir, safe_basename)
        
        # Skip if already extracted
        if os.path.exists(target_path) and os.path.getsize(target_path) == info.file_size:
            extracted_doc_count += 1
            extracted_doc_bytes += info.file_size
            continue
            
        try:
            with open(target_path, 'wb') as f_out:
                f_out.write(zf.read(info))
            extracted_doc_count += 1
            extracted_doc_bytes += info.file_size
            if (idx + 1) % 50 == 0 or (idx + 1) == len(doc_entries):
                print(f"  Extracted {idx + 1}/{len(doc_entries)} docs ({extracted_doc_bytes/(1024*1024):.1f} MB)...")
        except Exception as e:
            print(f"Error extracting {info.filename}: {e}")

print(f"Drive docs complete: {extracted_doc_count} files ({extracted_doc_bytes/(1024*1024):.2f} MB)")

# 2. Product 8 (YouTube)
print("\n[2/3] Extracting YouTube Takeout (Product 8)...")
with zipfile.ZipFile(zpath_yt, 'r') as zf_yt:
    for info in zf_yt.infolist():
        if info.is_dir():
            continue
        ext = os.path.splitext(info.filename)[1].lower()
        if ext in {'.csv', '.html', '.json'}:
            basename = os.path.basename(info.filename)
            target_path = os.path.join(out_yt_dir, basename)
            with open(target_path, 'wb') as f_out:
                f_out.write(zf_yt.read(info))
print(f"Extracted {len(os.listdir(out_yt_dir))} YouTube items to {out_yt_dir}")

# 3. Product 10 (Nest)
print("\n[3/3] Extracting Nest Takeout (Product 10)...")
with zipfile.ZipFile(zpath_nest, 'r') as zf_nest:
    for info in zf_nest.infolist():
        if info.is_dir():
            continue
        ext = os.path.splitext(info.filename)[1].lower()
        if ext in {'.json', '.jsonl'}:
            basename = os.path.basename(info.filename)
            target_path = os.path.join(out_nest_dir, basename)
            with open(target_path, 'wb') as f_out:
                f_out.write(zf_nest.read(info))
print(f"Extracted {len(os.listdir(out_nest_dir))} Nest items to {out_nest_dir}")

elapsed = time.time() - t0
print(f"\nAll extractions finished in {elapsed:.1f}s!")
