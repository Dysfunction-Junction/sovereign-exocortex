import sqlite3, json

db = sqlite3.connect('/mnt/databank/index/databank.db')
cur = db.execute("SELECT item_id, title, meta FROM items WHERE source = 'facebook-messenger' LIMIT 3")
for r in cur.fetchall():
    print(r[0], r[1], r[2])
