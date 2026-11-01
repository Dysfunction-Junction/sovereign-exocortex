import struct
import subprocess
import sys

remote = sys.argv[1] if len(sys.argv) > 1 else "onedrive:Apps/Google⁠ Download Your Data/takeout-20251231T032548Z-14-001.zip"

res = subprocess.run(["rclone", "lsf", remote, "--format", "s"], capture_output=True, text=True, check=True)
size = int(res.stdout.strip())

# Fetch last 256KB
eocd_read_size = min(size, 256 * 1024)
offset = size - eocd_read_size
cmd = ["rclone", "cat", remote, "--offset", str(offset), "--count", str(eocd_read_size)]
res = subprocess.run(cmd, capture_output=True, check=True)
tail_bytes = res.stdout

zip64_loc_idx = tail_bytes.rfind(b"\x50\x4b\x06\x07")
if zip64_loc_idx != -1:
    loc_data = tail_bytes[zip64_loc_idx:zip64_loc_idx+20]
    _, _, zip64_eocd_offset, _ = struct.unpack("<4sIIQ", loc_data)
    # Fetch Zip64 EOCD record (56 bytes)
    cmd2 = ["rclone", "cat", remote, "--offset", str(zip64_eocd_offset), "--count", "56"]
    res2 = subprocess.run(cmd2, capture_output=True, check=True)
    eocd64 = res2.stdout
    _, _, _, _, _, _, _, total_records, cd_size, cd_offset = struct.unpack("<4sQHHIIQQQQ", eocd64[:56])
    print(f"Zip64: records={total_records:,}, CD size={cd_size:,}, CD offset={cd_offset:,}")
else:
    eocd_idx = tail_bytes.rfind(b"\x50\x4b\x05\x06")
    eocd_data = tail_bytes[eocd_idx:eocd_idx+22]
    _, disk_num, disk_start, cd_records_disk, total_records, cd_size, cd_offset, comment_len = struct.unpack("<4sHHHHIIH", eocd_data)
    print(f"Standard Zip: records={total_records:,}, CD size={cd_size:,}, CD offset={cd_offset:,}")

# Fetch first 64KB of Central Directory to sample file paths
sample_count = min(cd_size, 64 * 1024)
cmd3 = ["rclone", "cat", remote, "--offset", str(cd_offset), "--count", str(sample_count)]
res3 = subprocess.run(cmd3, capture_output=True, check=True)
cd_sample = res3.stdout

idx = 0
found_files = []
while idx < len(cd_sample) - 46 and len(found_files) < 30:
    if cd_sample[idx:idx+4] == b"\x50\x4b\x01\x02":
        fname_len, extra_len, comment_len = struct.unpack("<HHH", cd_sample[idx+28:idx+34])
        fname = cd_sample[idx+46:idx+46+fname_len].decode("utf-8", errors="ignore")
        found_files.append(fname)
        idx += 46 + fname_len + extra_len + comment_len
    else:
        idx += 1

print("\nSample paths in this archive:")
for f in found_files:
    print(f" - {f}")
