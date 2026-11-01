#!/usr/bin/env python3
"""Resume and verify oldpc rescue, then copy and cryptcheck its encrypted mirror.

Run on Lubuntu after configuring databank-crypt. Never deletes source data.
Only aggregate verification results are printed; paths stay on the vault.
"""
import hashlib
import fcntl
import json
import os
from pathlib import Path
import sqlite3
import subprocess
import time

ROOT = Path('/mnt/databank')
SOURCE = Path('/home/michael/oldpc-archive')
DEST = ROOT / 'canonical/oldpc'
EVIDENCE = ROOT / 'index/phase0-rescue.json'
REMOTE = 'databank-crypt:canonical/oldpc'
os.umask(0o077)
if not os.path.ismount(ROOT) or not SOURCE.is_dir():
    raise SystemExit('source or vault mount missing')
lock = (ROOT / 'index/phase0-rescue.lock').open('a')
try:
    fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
except BlockingIOError:
    raise SystemExit('rescue worker already running')
status = {'started_at': time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime())}


def save(stage, **values):
    status.update(stage=stage, updated_at=time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime()), **values)
    tmp = EVIDENCE.with_suffix('.tmp')
    with tmp.open('w') as out:
        out.write(json.dumps(status, indent=2) + '\n')
        out.flush()
        os.fsync(out.fileno())
    tmp.replace(EVIDENCE)
    print(json.dumps(status), flush=True)


def run(command, name):
    with (ROOT / 'index' / (name + '.log')).open('ab') as log:
        result = subprocess.run(command, stdout=log, stderr=log)
    if result.returncode:
        raise RuntimeError(name + ' failed: exit ' + str(result.returncode))


def inventory(root):
    files = {}
    links = {}
    def raise_walk_error(error):
        raise error
    for base, dirs, names in os.walk(root, onerror=raise_walk_error):
        for name in dirs + names:
            path = Path(base) / name
            if path.is_symlink():
                links[path.relative_to(root).as_posix()] = os.readlink(path)
            elif path.is_file():
                files[path.relative_to(root).as_posix()] = path.stat().st_size
    return files, links


def digest(path):
    h = hashlib.sha256()
    with path.open('rb') as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b''):
            h.update(block)
    return h.hexdigest()


def rsync_busy():
    targets = {os.fsencode(SOURCE), os.fsencode(DEST)}
    for process in Path('/proc').iterdir():
        if not process.name.isdigit():
            continue
        try:
            args = (process / 'cmdline').read_bytes().split(b'\0')
        except OSError:
            continue
        if os.path.basename(args[0]) == b'rsync' and any(arg.rstrip(b'/') in targets for arg in args[1:]):
            return True
    return False


try:
    if not os.path.ismount(ROOT) or not SOURCE.is_dir():
        raise RuntimeError('source or vault mount missing')
    save('waiting_for_existing_rsync')
    while rsync_busy():
        time.sleep(15)
    DEST.mkdir(parents=True, exist_ok=True)
    save('rescue_final_pass')
    run(['rsync', '-a', '--partial-dir=/mnt/databank/index/phase0-rsync-partial', '--stats', str(SOURCE) + '/', str(DEST) + '/'], 'phase0-rsync-final')
    original, src_links = inventory(SOURCE)
    rescued, dst_links = inventory(DEST)
    if not original:
        raise RuntimeError('empty source inventory')
    if original != rescued or src_links != dst_links:
        save('inventory_mismatch', missing=len(original.keys() - rescued.keys()), extra=len(rescued.keys() - original.keys()), size_mismatches=sum(original[name] != rescued[name] for name in original.keys() & rescued.keys()))
        raise RuntimeError('source/destination inventory mismatch')
    names = sorted(original)
    sample = sorted({names[i * (len(names) - 1) // min(31, len(names) - 1)] for i in range(min(32, len(names)))}) if len(names) > 1 else names
    manifest = sqlite3.connect('file:/mnt/databank/index/dedup_manifest.db?mode=ro', uri=True)
    matched = 0
    for name in sample:
        sha = digest(SOURCE / name)
        if digest(DEST / name) != sha:
            raise RuntimeError('sample SHA-256 mismatch')
        try:
            rows = manifest.execute('SELECT sha256 FROM canonical_files WHERE canonical_relpath = ?', ('oldpc/' + name,)).fetchall()
        except UnicodeEncodeError:
            rows = []
        if rows:
            if any(row[0] != sha for row in rows):
                raise RuntimeError('manifest SHA-256 mismatch')
            matched += 1
        elif manifest.execute('SELECT 1 FROM canonical_files WHERE sha256 = ? AND size_bytes = ?', (sha, original[name])).fetchone():
            matched += 1
    manifest.close()
    save('local_verified_with_sampling', files=len(names), bytes=sum(original.values()), symlinks=len(src_links), sha256_samples=len(sample), manifest_sample_matches=matched)
    save('encrypted_mirror_copy')
    run(['rclone', 'copy', str(DEST), REMOTE, '--links', '--create-empty-src-dirs', '--stats', '60s', '--stats-log-level', 'NOTICE', '--log-level', 'NOTICE', '--transfers', '4', '--checkers', '8'], 'phase0-crypt-copy')
    save('encrypted_mirror_check')
    report = ROOT / 'index/phase0-cryptcheck-combined.txt'
    run(['rclone', 'cryptcheck', str(DEST), REMOTE, '--links', '--one-way', '--combined', str(report), '--stats', '60s', '--log-level', 'NOTICE'], 'phase0-cryptcheck')
    with report.open('rb') as checks:
        outcomes = [line[:2] for line in checks]
    if len(outcomes) != len(original) + len(src_links) or any(outcome != b'= ' for outcome in outcomes):
        raise RuntimeError('encrypted mirror verification coverage mismatch')
    save('complete', encrypted_mirror_verified=True, encrypted_files_checked=len(outcomes))
except Exception as exc:
    save('failed', error=str(exc) if type(exc) is RuntimeError else type(exc).__name__)
    raise SystemExit(1)
