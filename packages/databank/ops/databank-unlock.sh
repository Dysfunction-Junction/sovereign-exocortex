#!/usr/bin/env bash
# Opens the LUKS volume, mounts it and starts the databank service.
#
#   interactive : ssh -t user@databank-host sudo databank-unlock
#   from the PC : ops/windows/unlock-databank.ps1 pipes a typed passphrase to
#                 `sudo databank-unlock --stdin` (passphrase on stdin only: never stored on this
#                 machine, never on a command line, never in a file)
set -euo pipefail
[[ $EUID -eq 0 ]] || { echo "run with sudo" >&2; exit 1; }
# shellcheck disable=SC1091
source /etc/databank.conf

if ! cryptsetup status "$MAPPER" >/dev/null 2>&1; then
  if [[ "${1:-}" == "--stdin" ]]; then
    IFS= read -r PASS || true
    PASS="${PASS%$'\r'}" # tolerate CRLF from Windows
    [[ -n "$PASS" ]] || { echo "empty passphrase on stdin" >&2; exit 1; }
    printf '%s' "$PASS" | cryptsetup open --key-file=- "/dev/disk/by-uuid/$LUKS_UUID" "$MAPPER" \
      || { echo "wrong passphrase" >&2; unset PASS; exit 1; }
    unset PASS
  else
    cryptsetup open "/dev/disk/by-uuid/$LUKS_UUID" "$MAPPER"
  fi
fi
mountpoint -q "$MOUNT" || mount -o noatime,nodev,nosuid "/dev/mapper/$MAPPER" "$MOUNT"
[[ "$(cat "$MOUNT/.vault-id")" == "$VAULT_ID" ]] || { echo "vault id mismatch; not starting the service" >&2; exit 1; }
systemctl start databank.service
echo "unlocked: $MOUNT"
