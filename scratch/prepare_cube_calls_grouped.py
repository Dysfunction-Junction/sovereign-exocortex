import json
from collections import defaultdict
from datetime import datetime

in_file = '/tmp/cube_call_logs.jsonl'
out_file = '/tmp/cube_calls_grouped.jsonl'

# Read raw records
contacts = defaultdict(list)

with open(in_file, 'r', encoding='utf-8') as f:
    for line in f:
        line = line.strip()
        if not line:
            continue
        rec = json.loads(line)
        meta = rec.get('metadata', {})
        contact = meta.get('contact', '').strip()
        phone = meta.get('phone', '').strip()
        
        key = contact or phone or 'Unknown'
        contacts[key].append(rec)

print(f"Total contacts/numbers: {len(contacts)}")

grouped_records = []

for contact_key, calls in contacts.items():
    # Sort calls chronologically by timestamp
    calls.sort(key=lambda x: x.get('timestamp', ''))
    
    # Chunk if contact has more than 50 calls
    chunk_size = 50
    for chunk_idx in range(0, len(calls), chunk_size):
        chunk = calls[chunk_idx:chunk_idx + chunk_size]
        part_str = f" (Part {chunk_idx // chunk_size + 1})" if len(calls) > chunk_size else ""
        
        # Build chronological log text
        lines = [f"Phone Call History: {contact_key}{part_str}"]
        lines.append(f"Total calls recorded in this thread: {len(calls)} (showing calls {chunk_idx+1} to {chunk_idx+len(chunk)})")
        lines.append("-" * 50)
        
        for c in chunk:
            m = c.get('metadata', {})
            ts = c.get('timestamp', 'Unknown Date')
            ch = m.get('channel', 'phone')
            direction = m.get('direction', 'Unknown')
            dur = m.get('duration_sec')
            dur_str = f", Duration: {dur}s" if dur is not None else ""
            phone_str = f" [{m['phone']}]" if m.get('phone') else ""
            lines.append(f"• {ts} | {direction} via {ch}{phone_str}{dur_str}")
            
        full_text = "\n".join(lines)
        
        # Extract phone from first call that has one
        phones = list({c['metadata']['phone'] for c in calls if c.get('metadata', {}).get('phone')})
        
        grouped_records.append({
            "title": f"Call Log: {contact_key}{part_str}",
            "source": "cube-acr-calls",
            "kind": "conversation",
            "text": full_text,
            "ts": int(datetime.now().timestamp() * 1000),
            "meta": {
                "contact": contact_key,
                "phone_numbers": phones,
                "call_count": len(calls),
                "date_range": f"{calls[0].get('timestamp', '')} to {calls[-1].get('timestamp', '')}"
            }
        })

print(f"Generated {len(grouped_records)} grouped call history documents.")

with open(out_file, 'w', encoding='utf-8') as f:
    for rec in grouped_records:
        f.write(json.dumps(rec, ensure_ascii=False) + '\n')

print(f"Saved {out_file}")
