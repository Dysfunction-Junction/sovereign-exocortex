#!/bin/bash
# Launch both jobs in the background on Lubuntu. Logs -> /mnt/databank/index/
set -e
LOG=/mnt/databank/index
mkdir -p /mnt/databank/staging /tmp/od_mount
mountpoint -q /tmp/od_mount || rclone mount onedrive: /tmp/od_mount --vfs-cache-mode off --read-only --daemon
sleep 2

# Job A: stage Product 14 locally (fast sequential download), then preserve keepers.
nohup bash -c "
  rclone copyto 'onedrive:Apps/Google⁠ Download Your Data/takeout-20251231T032548Z-14-001.zip' /mnt/databank/staging/p14.zip --stats 60s --stats-one-line -v &&
  python3 /tmp/preserve_product14.py /mnt/databank/staging/p14.zip
" > $LOG/p14_preserve.log 2>&1 &
echo "job A pid $!"

# Job B: photo comparison (central directories only) + OneDrive Pictures inventory.
nohup bash -c "
  python3 /tmp/compare_photos_2022_2025.py;
  echo; echo '== OneDrive Pictures folders'; rclone size onedrive:Pictures; rclone size 'onedrive:Pictures 1';
  echo '== Any missing 2025 parts (12-001/002/009) elsewhere?';
  rclone lsf -R --max-depth 3 --include 'takeout-20251231*' onedrive: ; rclone lsf -R --max-depth 3 --include 'takeout-20251231*' gdrive:
" > $LOG/photo_compare.log 2>&1 &
echo "job B pid $!"
