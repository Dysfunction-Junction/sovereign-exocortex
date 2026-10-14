#!/usr/bin/env bash
# One-time provisioning of the databank volume: GPT + LUKS2 + ext4, mounted at /mnt/databank.
# DESTROYS everything on the target disk. Run on Lubuntu as root, interactively (ssh -t),
# because cryptsetup asks for the passphrase on the terminal.
#
#   sudo ./setup-volume.sh --device /dev/sdb --serial <lsblk SERIAL> --dry-run
#   sudo ./setup-volume.sh --device /dev/sdb --serial <lsblk SERIAL> --yes-wipe
#
# Guards: must be a whole disk, not the disk holding / or /boot, nothing on it mounted,
# serial must match, and wiping needs --yes-wipe. The passphrase is never stored.
set -euo pipefail

DEVICE="" SERIAL="" WIPE=0 DRY=0 USER_NAME="${SUDO_USER:-michael}"
MAPPER=databank MOUNT=/mnt/databank CONF=/etc/databank.conf

while [[ $# -gt 0 ]]; do
  case "$1" in
    --device) DEVICE="$2"; shift 2 ;;
    --serial) SERIAL="$2"; shift 2 ;;
    --yes-wipe) WIPE=1; shift ;;
    --dry-run) DRY=1; shift ;;
    --user) USER_NAME="$2"; shift 2 ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
done

die() { echo "REFUSING: $*" >&2; exit 1; }

[[ $EUID -eq 0 ]] || die "run as root"
[[ -n "$DEVICE" && -n "$SERIAL" ]] || die "--device and --serial are required"
[[ -b "$DEVICE" ]] || die "$DEVICE is not a block device"
[[ "$(lsblk -dno TYPE "$DEVICE")" == "disk" ]] || die "$DEVICE is not a whole disk"
[[ "$(lsblk -dno SERIAL "$DEVICE" | tr -d '[:space:]')" == "$SERIAL" ]] || die "serial mismatch: $DEVICE has '$(lsblk -dno SERIAL "$DEVICE")'"

# Never touch the disk that holds the running system.
ROOT_SRC="$(findmnt -no SOURCE /)"
ROOT_DISK="/dev/$(lsblk -no PKNAME "$ROOT_SRC" 2>/dev/null | head -1)"
[[ "$ROOT_DISK" != "$DEVICE" ]] || die "$DEVICE holds the root filesystem"
# Nothing on the target may be mounted (old read-only Windows mounts must be unmounted first).
if lsblk -nlo MOUNTPOINTS "$DEVICE" | grep -q '[^[:space:]]'; then
  die "something on $DEVICE is mounted: $(lsblk -nlo NAME,MOUNTPOINTS "$DEVICE" | awk 'NF>1')"
fi
[[ ! -e /dev/mapper/$MAPPER ]] || die "/dev/mapper/$MAPPER already exists"

echo "Target : $DEVICE  $(lsblk -dno SIZE,MODEL,SERIAL "$DEVICE")"
lsblk -o NAME,SIZE,FSTYPE,LABEL "$DEVICE"
if [[ $DRY -eq 1 ]]; then echo "dry run: all guards passed, nothing changed"; exit 0; fi
[[ $WIPE -eq 1 ]] || die "add --yes-wipe to destroy everything on $DEVICE"

echo "Wiping $DEVICE in 5 seconds (Ctrl-C to abort)..."; sleep 5
umount -q "${DEVICE}"* 2>/dev/null || true
wipefs -a "$DEVICE"
sgdisk --zap-all "$DEVICE"
sgdisk -n 1:0:0 -t 1:8309 -c 1:databank-luks "$DEVICE"   # 8309 = Linux LUKS
partprobe "$DEVICE"; sleep 2
PART="$(lsblk -lnpo NAME,TYPE "$DEVICE" | awk '$2=="part"{print $1; exit}')"
[[ -b "$PART" ]] || die "partition not found after partitioning"

echo "Creating LUKS2 on $PART. Choose a strong passphrase; it is NOT stored anywhere on this machine."
cryptsetup luksFormat --type luks2 --cipher aes-xts-plain64 --key-size 512 --hash sha512 \
  --pbkdf argon2id --iter-time 3000 --label databank "$PART"
cryptsetup open "$PART" "$MAPPER"

mkfs.ext4 -q -L databank -m 1 -E lazy_itable_init=0 "/dev/mapper/$MAPPER"
mkdir -p "$MOUNT"
mount -o noatime,nodev,nosuid "/dev/mapper/$MAPPER" "$MOUNT"

VAULT_ID="$(cat /proc/sys/kernel/random/uuid)"
echo "$VAULT_ID" > "$MOUNT/.vault-id"
mkdir -p "$MOUNT/index" "$MOUNT/blobs" "$MOUNT/tmp"
chown -R "$USER_NAME":"$USER_NAME" "$MOUNT"
chmod 700 "$MOUNT"

UUID="$(blkid -s UUID -o value "$PART")"
cat > "$CONF" <<EOF
# written by setup-volume.sh $(date -Is)
LUKS_UUID=$UUID
MAPPER=$MAPPER
MOUNT=$MOUNT
VAULT_ID=$VAULT_ID
EOF
chmod 644 "$CONF"

HDR=/root/databank-luks-header-$(date +%Y%m%d).img
cryptsetup luksHeaderBackup "$PART" --header-backup-file "$HDR"
chmod 600 "$HDR"

echo
echo "Done. Vault id $VAULT_ID mounted at $MOUNT (LUKS UUID $UUID)."
echo "NEXT: copy $HDR off this machine (a damaged LUKS header means total loss), then"
echo "      the volume is locked at every reboot: use databank-unlock to open it."
