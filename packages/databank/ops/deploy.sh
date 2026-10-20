#!/usr/bin/env bash
# Run from the PC (Git Bash). Bundles the CLI into one file and installs it plus the units
# on Lubuntu. Does not touch the disk and does not need the vault to be unlocked.
#   ./deploy.sh user@databank-host
set -euo pipefail
HOST="${1:?usage: deploy.sh user@host}"
HERE="$(cd "$(dirname "$0")" && pwd)"
cd "$HERE/.."

npm run bundle >/dev/null
scp dist/databank.mjs "$HOST":/tmp/databank.mjs
scp ops/databank-unlock.sh ops/databank-lock.sh ops/databank.service ops/databank.env.example "$HOST":/tmp/

ssh -t "$HOST" 'set -e
  sudo mkdir -p /opt/databank
  sudo install -m 644 /tmp/databank.mjs /opt/databank/databank.mjs
  sudo install -m 755 /tmp/databank-unlock.sh /usr/local/bin/databank-unlock
  sudo install -m 755 /tmp/databank-lock.sh /usr/local/bin/databank-lock
  sudo install -m 644 /tmp/databank.service /etc/systemd/system/databank.service
  [ -f /etc/databank.env ] || sudo install -m 640 -o root -g "${SUDO_USER:-$USER}" /tmp/databank.env.example /etc/databank.env
  sudo systemctl daemon-reload
  rm -f /tmp/databank.mjs /tmp/databank-*.sh /tmp/databank.service /tmp/databank.env.example
  node /opt/databank/databank.mjs 2>&1 | head -2
  echo "installed. Edit /etc/databank.env and place /etc/databank.key, then run databank-unlock."'
