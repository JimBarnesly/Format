#!/usr/bin/env python3
"""Start Format only while the selected media filesystem is actually mounted."""
import json
import os
import subprocess
import sys
from pathlib import Path


def verify_media(config, runner=subprocess.run):
    root = Path(config['music_root'])
    if not root.is_dir():
        raise RuntimeError('Music directory is unavailable; not scanning or changing library state.')
    result = runner(['findmnt', '--json', '--target', str(root), '--output', 'UUID,TARGET'],
                    text=True, capture_output=True, check=True)
    mounts = json.loads(result.stdout)['filesystems']
    if len(mounts) != 1 or mounts[0].get('uuid') != config['filesystem_uuid']:
        raise RuntimeError('Expected HDD is not mounted here; refusing to scan a different filesystem.')
    return root


def main():
    config = json.loads(Path(sys.argv[1]).read_text())
    verify_media(config)
    env = dict(os.environ, MUSIC_ROOT=config['music_root'], CACHE_DIR=config['cache_dir'],
               DATA_DIR=config['data_dir'], HOST='127.0.0.1', PORT='4534', FORMAT_READ_ONLY='true',
               SHADOW_REPAIR_ENABLED='false', LIBRARY_PROBE_CONCURRENCY='2',
               MUSIC_FILESYSTEM_UUID=config['filesystem_uuid'])
    os.chdir(config['app_dir'])
    os.execve(config['node'], [config['node'], 'server.mjs'], env)


if __name__ == '__main__':
    try:
        main()
    except Exception as error:
        print(f'Format startup stopped: {error}', file=sys.stderr)
        sys.exit(1)
