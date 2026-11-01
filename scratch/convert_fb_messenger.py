import os
import glob
import re
import json
import html
from datetime import datetime

base_dir = "/tmp/fb_messenger"
out_jsonl = "/tmp/fb_messenger.jsonl"

# Regex patterns for fast extraction
# Sender: <div class="_2ph_ _a6-h _a6-i">Sender Name</div>
# Body: <div class="_2ph_ _a6-p"><div><div></div><div>Message</div>...
# Timestamp: <div class="_a72d">Timestamp</div>

msg_block_re = re.compile(r'<div class="_3-95 _a6-g">(.*?)</div></div></div>(?=<div class="_3-95 _a6-g">|<div class="_a707">|$)', re.DOTALL)
sender_re = re.compile(r'<div class="_2ph_ _a6-h _a6-i">([^<]+)</div>')
body_re = re.compile(r'<div class="_2ph_ _a6-p"><div><div></div><div>(.*?)</div>', re.DOTALL)
ts_re = re.compile(r'<div class="_a72d">([^<]+)</div>')
title_re = re.compile(r'<title>([^<]+)</title>')

total_conversations = 0
total_messages = 0

with open(out_jsonl, "w", encoding="utf-8") as out_f:
    for root, dirs, files in os.walk(base_dir):
        html_files = sorted([f for f in files if f.startswith("message_") and f.endswith(".html")])
        if not html_files:
            continue
        
        folder_name = os.path.basename(root)
        contact_name = folder_name.split("_")[0] if "_" in folder_name else folder_name
        
        messages = []
        parsed_title = ""
        
        for hf in html_files:
            fpath = os.path.join(root, hf)
            try:
                with open(fpath, "r", encoding="utf-8", errors="ignore") as f:
                    content = f.read()
            except Exception:
                continue
            
            if not parsed_title:
                m_title = title_re.search(content)
                if m_title:
                    parsed_title = html.unescape(m_title.group(1)).strip()
            
            # Find all message blocks
            for block in msg_block_re.finditer(content):
                b_text = block.group(1)
                m_sender = sender_re.search(b_text)
                m_body = body_re.search(b_text)
                m_ts = ts_re.search(b_text)
                
                sender = html.unescape(m_sender.group(1)).strip() if m_sender else "Unknown"
                raw_body = m_body.group(1) if m_body else ""
                # Strip any nested HTML tags from body
                clean_body = re.sub(r'<[^>]+>', ' ', raw_body)
                clean_body = html.unescape(clean_body).strip()
                ts_str = m_ts.group(1).strip() if m_ts else ""
                
                if clean_body:
                    messages.append((ts_str, sender, clean_body))
        
        if not messages:
            continue
        
        # Facebook exports messages in reverse chronological order (newest first).
        # We reverse them to chronological order (oldest first).
        messages.reverse()
        
        total_messages += len(messages)
        total_conversations += 1
        
        display_title = parsed_title or contact_name
        
        # Split very long conversations (e.g. > 1500 messages) into parts so individual items are manageable
        chunk_size = 1000
        for i in range(0, len(messages), chunk_size):
            chunk = messages[i:i+chunk_size]
            part_str = f" (Part {i//chunk_size + 1})" if len(messages) > chunk_size else ""
            lines = [f"[{t}] {s}: {m}" for t, s, m in chunk]
            transcript = f"Facebook Messenger Conversation with {display_title}{part_str}:\n\n" + "\n".join(lines)
            
            record = {
                "title": f"Facebook Messenger: {display_title}{part_str}",
                "source": "facebook-messenger",
                "kind": "conversation",
                "text": transcript,
                "ts": int(datetime.now().timestamp() * 1000),
                "meta": {
                    "contact": display_title,
                    "folder": folder_name,
                    "message_count": len(chunk),
                    "total_thread_count": len(messages)
                }
            }
            out_f.write(json.dumps(record) + "\n")

print(f"Extracted {total_messages:,} Facebook messages across {total_conversations:,} conversations into {out_jsonl}")
