#!/usr/bin/env python3
"""Archive completed collection manifests; default mode only prints the plan."""
import argparse
import gzip
import hashlib
import json
import os
from pathlib import Path
import shutil
import tempfile
import time

RAW_DAYS = 2
ARCHIVE_DAYS = 30
SUFFIX = '-collection-manifest.json'


def digest(handle):
    value = hashlib.sha256()
    for chunk in iter(lambda: handle.read(1024 * 1024), b''):
        value.update(chunk)
    return value.hexdigest()


def archive(path, manifest):
    before = path.stat()
    destination = Path(str(path) + '.gz')
    if destination.exists():
        # Resume a process interrupted after publication but before unlinking.
        with path.open('rb') as source, gzip.open(destination, 'rb') as restored:
            if digest(source) != digest(restored):
                raise RuntimeError(f'different archive already exists: {destination}')
        summary = Path(str(path) + '.summary.json')
        if not summary.is_file():
            raise RuntimeError(f'archive summary is missing: {summary}')
        path.unlink()
        return
    fd, temporary = tempfile.mkstemp(prefix='.archive-', dir=path.parent)
    try:
        with os.fdopen(fd, 'wb') as output:
            with path.open('rb') as source, gzip.GzipFile(fileobj=output, mode='wb', mtime=0) as zipped:
                shutil.copyfileobj(source, zipped, 1024 * 1024)
            output.flush()
            os.fsync(output.fileno())
        with path.open('rb') as source:
            original_hash = digest(source)
        with gzip.open(temporary, 'rb') as restored:
            if digest(restored) != original_hash:
                raise RuntimeError(f'archive verification failed: {path}')
        after = path.stat()
        if (before.st_ino, before.st_size, before.st_mtime_ns) != (after.st_ino, after.st_size, after.st_mtime_ns):
            raise RuntimeError(f'manifest changed while archiving: {path}')
        summary = {
            'runKey': manifest.get('runKey'),
            'checkpointCommittedAt': manifest['checkpointCommittedAt'],
            'incrementalResult': manifest.get('incrementalResult'),
            'sourceRuns': [{k: row.get(k) for k in ('sourceId', 'status', 'changedItemCount', 'latencyMs')}
                           for row in manifest.get('sourceRuns', [])],
            'originalBytes': before.st_size,
            'sha256': original_hash,
            'archivedAt': time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime()),
        }
        summary_path = Path(str(path) + '.summary.json')
        if summary_path.exists():
            with summary_path.open(encoding='utf-8') as handle:
                if json.load(handle).get('sha256') != original_hash:
                    raise RuntimeError(f'different archive summary exists: {summary_path}')
        with summary_path.open('w', encoding='utf-8') as handle:
            json.dump(summary, handle, ensure_ascii=False, separators=(',', ':'))
            handle.write('\n')
            handle.flush()
            os.fsync(handle.fileno())
        os.chmod(temporary, before.st_mode & 0o777)
        os.chmod(summary_path, before.st_mode & 0o777)
        if os.geteuid() == 0:
            os.chown(temporary, before.st_uid, before.st_gid)
            os.chown(summary_path, before.st_uid, before.st_gid)
        os.utime(temporary, ns=(before.st_atime_ns, before.st_mtime_ns))
        os.replace(temporary, destination)
        directory_fd = os.open(path.parent, os.O_RDONLY)
        try:
            os.fsync(directory_fd)
        finally:
            os.close(directory_fd)
        path.unlink()
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--directory', type=Path, default=Path('/var/lib/lawfirm-ads/data/keyword-inbox'))
    parser.add_argument('--apply', action='store_true')
    args = parser.parse_args()
    if Path('/var/lib/lawfirm-ads/lock/pipeline.lock').exists():
        print(json.dumps({'skipped': 'collection pipeline is running'}))
        return
    now = time.time()
    for path in sorted(args.directory.iterdir()):
        if path.is_symlink() or not path.is_file():
            continue
        age = (now - path.stat().st_mtime) / 86400
        if path.name.endswith(SUFFIX) and age >= RAW_DAYS:
            if path.with_name(path.name.replace(SUFFIX, '-checkpoint-candidate.json')).exists():
                continue
            with path.open(encoding='utf-8') as handle:
                manifest = json.load(handle)
            if not manifest.get('checkpointCommittedAt'):
                continue
            print(json.dumps({'action': 'archive', 'path': str(path), 'bytes': path.stat().st_size}), flush=True)
            if args.apply:
                archive(path, manifest)
        elif path.name.endswith(SUFFIX + '.gz') and age >= ARCHIVE_DAYS:
            summary = Path(str(path)[:-3] + '.summary.json')
            if not summary.is_file() or summary.is_symlink():
                continue
            with summary.open(encoding='utf-8') as handle:
                metadata = json.load(handle)
            if not metadata.get('checkpointCommittedAt') or not metadata.get('sha256'):
                continue
            print(json.dumps({'action': 'expire-archive', 'path': str(path), 'bytes': path.stat().st_size}), flush=True)
            if args.apply:
                path.unlink()


if __name__ == '__main__':
    main()
