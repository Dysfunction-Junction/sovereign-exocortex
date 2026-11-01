#!/bin/bash
# Preserve small, already-ingested takeout zips into canonical, CRC-verify, then report.
set -e
SRC='/tmp/od_mount/Apps/Google⁠ Download Your Data'
DST=/mnt/databank/canonical/google_takeout
mkdir -p "$DST"
for f in takeout-20251231T032548Z-8-001.zip takeout-20251231T032548Z-10-001.zip takeout-20221130T195942Z-006.zip takeout-20221130T195942Z-007.zip; do
  cp "$SRC/$f" "$DST/$f"
  src_sz=$(stat -c %s "$SRC/$f"); dst_sz=$(stat -c %s "$DST/$f")
  crc=$(python3 -c 'import zipfile,sys; z=zipfile.ZipFile(sys.argv[1]); b=z.testzip(); print("CRC_OK" if b is None else "CRC_BAD:"+b, len(z.namelist()))' "$DST/$f")
  if [ "$src_sz" = "$dst_sz" ]; then sz=SIZE_OK; else sz="SIZE_MISMATCH($src_sz/$dst_sz)"; fi
  echo "$f $sz $crc"
done
du -sh "$DST"
