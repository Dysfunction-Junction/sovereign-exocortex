#!/usr/bin/env bash
# Opens the LUKS volume, mounts it and starts the databank service.
# Run from the PC:  ssh -t michael@hplubunhaos sudo databank-unlock
# The passphrase is typed on your terminal and never written to disk.
set -euo pipefail
[[ $EUID -eq 0 ]] || { echo "run with sudo" >&2; exit 1; }
# shellcheck disable=SC1091
source /etc/databank.conf

if ! cryptsetup status "$MAPPER" >/dev/null 2>&1; then
  cryptsetup open "/dev/disk/by-uuid/$LUKS_UUID" "$MAPPER"
fi
mountpoint -q "$MOUNT" || mount -o noatime,nodev,nosuid "/dev/mapper/$MAPPER" "$MOUNT"
[[ "$(cat "$MOUNT/.vault-id")" == "$VAULT_ID" ]] || { echo "vault id mismatch; not starting the service" >&2; exit 1; }
systemctl start databank.service
echo "unlocked: $MOUNT"
