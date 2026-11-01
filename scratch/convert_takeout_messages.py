import json
import os
import glob
import datetime

msgs_dir = '/tmp/takeout_messages/Takeout/Messages'
out_file = '/tmp/takeout_messages.jsonl'

total_msgs = 0
total_convs = 0

with open(out_file, 'w', encoding='utf-8') as out_f:
    for fpath in glob.glob(os.path.join(msgs_dir, '*.json')):
        fname = os.path.basename(fpath)
        contact = os.path.splitext(fname)[0]
        try:
            with open(fpath, 'r', encoding='utf-8', errors='ignore') as f:
                data = json.load(f)
        except Exception:
            continue
        
        items = []
        for k, v in data.items():
            if not isinstance(v, dict):
                continue
            msg = v.get('Message', '').strip()
            sender = v.get('SenderId', 'Unknown')
            ts = v.get('Timestamp', '')
            if msg:
                items.append((ts, sender, msg))
        
        if not items:
            continue
        
        items.sort(key=lambda x: x[0])
        total_msgs += len(items)
        total_convs += 1
        
        lines = [f'[{t}] {s}: {m}' for t, s, m in items]
        transcript = f'Conversation with {contact} (Google Messages Takeout):\n\n' + '\n'.join(lines)
        
        epoch = 1667260800000
        try:
            dt = datetime.datetime.strptime(items[0][0], '%Y-%m-%d %H:%M:%S')
            epoch = int(dt.timestamp() * 1000)
        except Exception:
            pass
        
        record = {
            'title': f'Takeout Messages: {contact}',
            'source': 'takeout-messages',
            'kind': 'conversation',
            'text': transcript,
            'ts': epoch,
            'meta': {'contact': contact, 'message_count': len(items)}
        }
        out_f.write(json.dumps(record) + '\n')

print(f'Converted {total_msgs} messages across {total_convs} conversations into {out_file}')
