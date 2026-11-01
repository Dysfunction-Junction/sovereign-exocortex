import sqlite3, json

db = sqlite3.connect('/mnt/databank/index/databank.db')
cur = db.execute("SELECT item_id, meta FROM items WHERE source = 'facebook-messenger'")
rows = cur.fetchall()
print(f"Updating {len(rows)} items for Gwen...")

for item_id, meta_str in rows:
    try:
        meta = json.loads(meta_str) if meta_str else {}
    except:
        meta = {}
    meta['owner'] = 'gwen'
    meta['tier'] = 'gwen-knowledge-base'
    new_meta = json.dumps(meta)
    db.execute("UPDATE items SET source = 'gwen-messenger', meta = ? WHERE item_id = ?", (new_meta, item_id))

db.commit()
print("Verification:")
c1 = db.execute("SELECT count(*) FROM items WHERE source = 'gwen-messenger'").fetchone()[0]
c2 = db.execute("SELECT count(*) FROM items WHERE source = 'facebook-messenger'").fetchone()[0]
print(f"gwen-messenger items: {c1}, facebook-messenger items: {c2}")
