import zipfile, os
from collections import Counter

base = '/tmp/od_mount/Apps/Google\u2060 Download Your Data/'
# archive -> extensions that were actually extracted/ingested
checks = {
    'takeout-20251231T032548Z-8-001.zip': {'.csv', '.html', '.json'},
    'takeout-20251231T032548Z-10-001.zip': {'.json', '.jsonl'},
    'takeout-20221130T195942Z-006.zip': None,
    'takeout-20221130T195942Z-007.zip': None,
    'takeout-20251231T032548Z-14-001.zip': {'.pdf', '.docx', '.xlsx', '.doc', '.txt', '.csv', '.html', '.gpx'},
}
for name, ok in checks.items():
    with zipfile.ZipFile(base + name) as zf:
        files = [i for i in zf.infolist() if not i.is_dir()]
        tops = Counter('/'.join(i.filename.split('/')[:3]) for i in files)
        print(f'=== {name}: {len(files)} files')
        if ok is None:
            for t, c in tops.most_common(10):
                print(f'   {t}: {c}')
            continue
        missed = Counter(); missed_sz = Counter()
        for i in files:
            e = os.path.splitext(i.filename)[1].lower()
            if e not in ok:
                missed[e] += 1; missed_sz[e] += i.file_size
        if not missed:
            print('   ALL entries covered by ingestion')
        for e, c in missed_sz.most_common(15):
            print(f'   NOT ingested {e or "(none)"}: {missed[e]} files, {c/1048576:.1f} MB')
