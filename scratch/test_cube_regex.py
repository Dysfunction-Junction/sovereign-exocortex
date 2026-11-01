import zipfile
import re
import os

zpath_drive = '/tmp/od_mount/Apps/Google\u2060 Download Your Data/takeout-20251231T032548Z-14-001.zip'

with zipfile.ZipFile(zpath_drive, 'r') as zf:
    audio_files = [f.filename for f in zf.infolist() if 'Cube ACR' in f.filename and os.path.splitext(f.filename)[1].lower() in {'.m4a', '.amr'}][:20]
    
    for f in audio_files:
        basename = os.path.basename(f)
        name_no_ext = os.path.splitext(basename)[0]
        # Match: YYYY-MM-DD HH-MM-SS (channel) contact/number direction
        m = re.match(r'^(\d{4}-\d{2}-\d{2}\s+\d{2}-\d{2}-\d{2})\s+\(([^)]+)\)\s*(.*)$', name_no_ext)
        if m:
            dt, channel, rest = m.groups()
            direction = "Outgoing" if "↗" in rest else ("Incoming" if "↙" in rest else "Unknown")
            clean_rest = rest.replace("↗", "").replace("↙", "").strip()
            print(f"[{dt}] [{channel}] [{direction}] -> '{clean_rest}'")
        else:
            print(f"NO MATCH: {basename}")
