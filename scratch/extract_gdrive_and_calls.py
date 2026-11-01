import zipfile
import os
import json
import re
from datetime import datetime

zpath_drive = '/tmp/od_mount/Apps/Google\u2060 Download Your Data/takeout-20251231T032548Z-14-001.zip'
zpath_yt = '/tmp/od_mount/Apps/Google\u2060 Download Your Data/takeout-20251231T032548Z-8-001.zip'

out_docs_dir = '/tmp/gdrive_docs'
out_calls_jsonl = '/tmp/cube_call_logs.jsonl'
out_yt_dir = '/tmp/youtube_takeout'

os.makedirs(out_docs_dir, exist_ok=True)
os.makedirs(out_yt_dir, exist_ok=True)

DOC_EXTS = {'.pdf', '.docx', '.xlsx', '.doc', '.txt', '.csv', '.html', '.gpx'}
IGNORE_DIRS = {'AvastCleanup', 'net.appcake.apk'}

print("Processing Drive documents and Cube ACR logs...")

call_logs = []
extracted_doc_count = 0
extracted_doc_bytes = 0

with zipfile.ZipFile(zpath_drive, 'r') as zf:
    for info in zf.infolist():
        if info.is_dir():
            continue
        
        fname = info.filename
        ext = os.path.splitext(fname)[1].lower()
        
        # Check for Cube ACR JSON files
        if 'Cube ACR' in fname and ext == '.json':
            try:
                raw = zf.read(info).decode('utf-8', errors='replace')
                data = json.loads(raw)
                # Filename format e.g.:
                # Takeout/Drive/Cube ACR/2025-12-29/2025-12-29 14-12-51 (phone) Aunt Pam (+1 979-5.json
                basename = os.path.basename(fname)
                m = re.match(r'^(\d{4}-\d{2}-\d{2}\s+\d{2}-\d{2}-\d{2})\s+\(([^)]+)\)\s*(.*?)(?:\.json)?$', basename)
                timestamp = ""
                channel = ""
                contact = ""
                if m:
                    timestamp = m.group(1).replace('-', ':')
                    channel = m.group(2)
                    contact = m.group(3).strip()
                
                callee = data.get('callee', '')
                duration_sec = None
                if 'duration' in data:
                    try:
                        # Duration in ms or sec? Cube ACR duration is usually ms
                        ms = int(data['duration'])
                        duration_sec = round(ms / 1000.0, 1)
                    except:
                        pass
                
                call_record = {
                    "id": f"call_{len(call_logs)+1}",
                    "kind": "conversation",
                    "source": "cube-acr-calls",
                    "title": f"Phone Call: {contact or callee or 'Unknown'} ({channel})",
                    "timestamp": timestamp,
                    "metadata": {
                        "contact": contact,
                        "callee": callee,
                        "channel": channel,
                        "direction": data.get('direction', 'Unknown'),
                        "duration_sec": duration_sec,
                        "raw_file": basename
                    },
                    "content": f"Call Record: {contact or 'Unknown'}\nPhone Number / Callee: {callee}\nChannel: {channel}\nDirection: {data.get('direction', 'Unknown')}\nDuration: {duration_sec}s\nDate/Time: {timestamp}"
                }
                call_logs.append(call_record)
            except Exception as e:
                pass
            continue
            
        # Check for document files
        if ext in DOC_EXTS:
            # Skip if under ignore dirs
            parts = fname.split('/')
            if any(p in IGNORE_DIRS for p in parts):
                continue
            
            # Avoid overwriting files with same basename
            safe_basename = "_".join(parts[2:]) if len(parts) > 2 else os.path.basename(fname)
            safe_basename = safe_basename.replace('/', '_').replace('\\', '_').replace(' ', '_')
            target_path = os.path.join(out_docs_dir, safe_basename)
            
            try:
                with open(target_path, 'wb') as f_out:
                    f_out.write(zf.read(info))
                extracted_doc_count += 1
                extracted_doc_bytes += info.file_size
            except Exception as e:
                print(f"Error extracting {fname}: {e}")

print(f"Extracted {extracted_doc_count} documents ({extracted_doc_bytes / (1024*1024):.2f} MB)")
print(f"Parsed {len(call_logs)} Cube ACR call records")

with open(out_calls_jsonl, 'w', encoding='utf-8') as f_out:
    for rec in call_logs:
        f_out.write(json.dumps(rec, ensure_ascii=False) + '\n')

print(f"Saved {out_calls_jsonl} ({os.path.getsize(out_calls_jsonl)/(1024*1024):.2f} MB)")

# YouTube processing
print("\nProcessing YouTube Takeout...")
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

print(f"Extracted YouTube files to {out_yt_dir}: {len(os.listdir(out_yt_dir))} files")
