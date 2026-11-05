#!/usr/bin/env python3
"""Start Format only on the verified disk, with explicit download-only opt-in."""
import json
import os
import subprocess
import sys
from pathlib import Path

MARKER = '.format-acquisition.json'


def safe_path(value, exists=True):
    path = Path(value)
    if not path.is_absolute() or '..' in path.parts:
        raise RuntimeError('Paths must be absolute and must not contain parent traversal.')
    for part in [path, *path.parents]:
        if part.is_symlink():
            raise RuntimeError(f'Refusing symlinked path: {part}')
    if exists and not path.exists():
        raise RuntimeError(f'Required path is unavailable: {path}')
    return path


def overlaps(a, b):
    return a == b or a.is_relative_to(b) or b.is_relative_to(a)


def mount_info(path, runner=subprocess.run):
    result = runner(['findmnt', '--json', '--target', str(path), '--output', 'UUID,TARGET'],
                    text=True, capture_output=True, check=True)
    mounts = json.loads(result.stdout)['filesystems']
    if len(mounts) != 1:
        raise RuntimeError('Cannot identify the mounted filesystem.')
    return mounts[0]


def verify_media(config, runner=subprocess.run):
    root = safe_path(config['music_root'])
    if not root.is_dir():
        raise RuntimeError('Music directory is unavailable; not scanning or changing library state.')
    mount = mount_info(root, runner)
    if (not config.get('filesystem_uuid') or mount.get('uuid') != config['filesystem_uuid']
            or not mount.get('target') or mount['target'] == '/'):
        raise RuntimeError('Expected HDD is not mounted here; refusing a different filesystem.')
    return root


def verify_acquisition(config, runner=subprocess.run, allow_new=False):
    root = verify_media(config, runner)
    acquisition = safe_path(config['acquisition_root'], exists=False)
    if acquisition.parent != root:
        raise RuntimeError('Acquisition must be a strict child directory inside Music.')
    for key in ('app_dir', 'state_root', 'cache_dir', 'data_dir'):
        if config.get(key) and overlaps(acquisition, safe_path(config[key], exists=False)):
            raise RuntimeError('Acquisition overlaps application or state paths.')
    if config.get('downloads_enabled') is True:
        downloader = safe_path(config['downloader'])
        if not downloader.is_file() or not os.access(downloader, os.X_OK) or overlaps(downloader, root):
            raise RuntimeError('Downloader must be an existing executable outside Music.')
    if not acquisition.exists():
        if not allow_new or acquisition.parent != root:
            raise RuntimeError('New acquisition directory must be directly inside verified Music.')
        return acquisition
    if not acquisition.is_dir():
        raise RuntimeError('Acquisition path is not a directory.')
    marker = safe_path(acquisition / MARKER)
    expected = dict(schemaVersion=1, filesystemUuid=config['filesystem_uuid'])
    if not marker.is_file() or json.loads(marker.read_text()) != expected:
        raise RuntimeError('Acquisition ownership marker is missing or invalid.')
    devices = {root.stat().st_dev}
    targets = set()
    for path in [acquisition, acquisition / 'albums', acquisition / 'staging']:
        safe_path(path)
        mount = mount_info(path, runner)
        if (not path.is_dir() or mount.get('uuid') != config['filesystem_uuid']
                or not mount.get('target') or mount['target'] == '/'):
            raise RuntimeError('Acquisition directories must remain on the expected HDD.')
        devices.add(path.stat().st_dev)
        targets.add(mount['target'])
    if len(targets) != 1:
        raise RuntimeError('Acquisition, albums and staging must share one mount target.')
    if len(devices) != 1:
        raise RuntimeError('Albums and staging must share the Music filesystem.')
    return acquisition


def runtime_environment(config, inherited=None):
    env = dict(os.environ if inherited is None else inherited)
    for key in list(env):
        if key.startswith('TEST_'):
            env.pop(key, None)
    for key in ('NODE_OPTIONS', 'NODE_PATH', 'TRASH_ROOT', 'METADATA_CORRECTIONS_FILE', 'SPOTIFLAC_CWD', 'FORMAT_DOWNLOADS_ENABLED', 'FORMAT_ACQUISITION_ROOT', 'DOWNLOAD_ROOT',
                'DOWNLOAD_STAGING_ROOT', 'SPOTIFLAC_BIN', 'MUSIC_FILESYSTEM_UUID'):
        env.pop(key, None)
    env.update(NODE_ENV='production', SPOTIFLAC_CWD=config['app_dir'], MUSIC_ROOT=config['music_root'], CACHE_DIR=config['cache_dir'],
               DATA_DIR=config['data_dir'], HOST='127.0.0.1', PORT='4534', FORMAT_READ_ONLY='true',
               FORMAT_DOWNLOADS_ENABLED='false', SHADOW_REPAIR_ENABLED='false',
               LIBRARY_PROBE_CONCURRENCY='2', MUSIC_FILESYSTEM_UUID=config['filesystem_uuid'])
    if config.get('acquisition_root'):
        acquisition = Path(config['acquisition_root'])
        env.update(FORMAT_ACQUISITION_ROOT=str(acquisition),
                   DOWNLOAD_ROOT=str(acquisition / 'albums'), DOWNLOAD_STAGING_ROOT=str(acquisition / 'staging'))
    if config.get('downloads_enabled') is True:
        env.update(FORMAT_DOWNLOADS_ENABLED='true', SPOTIFLAC_BIN=config['downloader'])
    return env


def main():
    config = json.loads(safe_path(sys.argv[1]).read_text())
    verify_media(config)
    for key in ('state_root', 'cache_dir', 'data_dir', 'app_dir', 'node'):
        path = safe_path(config[key])
        if overlaps(path, Path(config['music_root'])):
            raise RuntimeError('Application/runtime/state must remain outside Music.')
    for key in ('state_root', 'cache_dir', 'data_dir'):
        path = Path(config[key])
        if path.stat().st_dev == Path(config['music_root']).stat().st_dev or mount_info(path).get('uuid') == config['filesystem_uuid']:
            raise RuntimeError('State/cache must not use the music HDD.')
    if config.get('acquisition_root'):
        verify_acquisition(config)
    elif config.get('downloads_enabled') is True:
        raise RuntimeError('Download opt-in requires an acquisition directory.')
    os.chdir(config['app_dir'])
    os.execve(config['node'], [config['node'], 'server.mjs'], runtime_environment(config))


if __name__ == '__main__':
    try:
        main()
    except Exception as error:
        print(f'Format startup stopped: {error}', file=sys.stderr)
        sys.exit(1)
