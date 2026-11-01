#!/bin/bash
set -e
mkdir -p /mnt/databank/canonical/oldpc /mnt/databank/index
echo "Starting oldpc-archive rescue rsync at $(date)..." > /mnt/databank/index/oldpc_rescue.log

nohup rsync -a --info=progress2 --stats /home/michael/oldpc-archive/ /mnt/databank/canonical/oldpc/ >> /mnt/databank/index/oldpc_rescue.log 2>&1 &
echo "Rsync PID: $!"
