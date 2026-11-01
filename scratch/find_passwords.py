import sqlite3

db = sqlite3.connect('/mnt/databank/index/databank.db')
for (name, sql) in db.execute("SELECT name, sql FROM sqlite_master WHERE type='trigger'"):
    print(f"Trigger {name}: {sql}")
