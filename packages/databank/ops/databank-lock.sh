#!/usr/bin/env bash
# Stops the service, unmounts and closes the LUKS volume. After this the data is unreadable
# until the passphrase is entered again.   ssh -t michael@hplubunhaos sudo databank-lock
set -euo pipefail
[[ $EUID -eq 0 ]] || { echo "run with sudo" >&2; exit 1; }
# shellcheck disable=SC1091
source /etc/databank.conf
systemctl stop databank.service || true
mountpoint -q "$MOUNT" && umount "$MOUNT"
cryptsetup status "$MAPPER" >/dev/null 2>&1 && cryptsetup close "$MAPPER"
echo "locked"
