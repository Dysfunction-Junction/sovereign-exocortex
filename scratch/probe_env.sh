#!/bin/bash
echo "== remotes"; rclone listremotes
echo "== disks"; df -h / /tmp /mnt/databank | sed 1d
echo "== dedup_manifest schema"
python3 - <<'EOF'
import sqlite3
for db in ['/mnt/databank/index/dedup_manifest.db','/mnt/databank/index/gdrive_manifest.db']:
    c=sqlite3.connect(db)
    print('##',db)
    for (n,s) in c.execute("select name,sql from sqlite_master where type='table'"):
        cnt=c.execute(f'select count(*) from "{n}"').fetchone()[0]
        print(f'  {n} ({cnt} rows): {s}')
EOF
echo "== onedrive top-level dirs with sizes"
rclone lsf onedrive: --dirs-only
