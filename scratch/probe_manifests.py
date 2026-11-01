import sqlite3
c = sqlite3.connect('/mnt/databank/index/dedup_manifest.db')
for r in c.execute('select sha256,size_bytes,canonical_relpath,winner_source_relpath,earliest_mtime,duplicate_count,substr(duplicate_paths_json,1,120),consolidated_at from canonical_files limit 2'):
    print(r)
g = sqlite3.connect('/mnt/databank/index/gdrive_manifest.db')
print('gdrive folders:', [r for r in g.execute('select folder,count(*),sum(size_bytes)/1048576 from gdrive_files group by folder')])
print('gdrive mp4s:', g.execute("select count(*), sum(size_bytes)/1048576 from gdrive_files where lower(name) like '%.mp4'").fetchone())
print('gdrive m4a/amr:', g.execute("select count(*) from gdrive_files where lower(name) like '%.m4a' or lower(name) like '%.amr'").fetchone())
