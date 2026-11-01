import sqlite3

db = sqlite3.connect('/mnt/databank/index/databank.db')
target_ids = ['1cd5d803a2068fbc4356e5108d3c05d3', 'f74d7a7693bbd31ea00957af9c9ca03a']

print("Before deletion:")
for tid in target_ids:
    c = db.execute("SELECT count(*) FROM chunks WHERE item_id = ?", (tid,)).fetchone()[0]
    print(f"  Item {tid}: {c} chunks")

# Delete chunks (triggers chunks_ad to clean FTS5)
for tid in target_ids:
    db.execute("DELETE FROM chunks WHERE item_id = ?", (tid,))
    db.execute("DELETE FROM items WHERE item_id = ?", (tid,))

db.commit()
print("\nAfter deletion:")
for tid in target_ids:
    c = db.execute("SELECT count(*) FROM chunks WHERE item_id = ?", (tid,)).fetchone()[0]
    i = db.execute("SELECT count(*) FROM items WHERE item_id = ?", (tid,)).fetchone()[0]
    print(f"  Item {tid}: {i} items, {c} chunks")

# Verify FTS5 has no hits
fts_hits = db.execute("SELECT count(*) FROM chunks_fts WHERE text MATCH 'Google Passwords'").fetchone()[0]
print(f"FTS5 matches for 'Google Passwords': {fts_hits}")
