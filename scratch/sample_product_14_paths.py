import zipfile
import os

zpath = '/tmp/od_mount/Apps/Google\u2060 Download Your Data/takeout-20251231T032548Z-14-001.zip'

with zipfile.ZipFile(zpath, 'r') as zf:
    print("Sample .m4a paths:")
    m4a_samples = [f.filename for f in zf.infolist() if f.filename.lower().endswith('.m4a')][:10]
    for s in m4a_samples:
        print(" ", s)
        
    print("\nSample .amr paths:")
    amr_samples = [f.filename for f in zf.infolist() if f.filename.lower().endswith('.amr')][:10]
    for s in amr_samples:
        print(" ", s)

    print("\nSample no-extension paths:")
    noext_samples = [f.filename for f in zf.infolist() if not f.is_dir() and '.' not in os.path.basename(f.filename)][:10]
    for s in noext_samples:
        print(" ", s)

    print("\nSample .json paths:")
    json_samples = [f.filename for f in zf.infolist() if f.filename.lower().endswith('.json')][:10]
    for s in json_samples:
        print(" ", s)
