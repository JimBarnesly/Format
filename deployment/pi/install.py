#!/usr/bin/env python3
"""Explicit read-only-media Format deployment. Never changes mounts or media."""
import argparse
import importlib.util
import json
import os
from pathlib import Path
import pwd
import shutil
import subprocess
import sys
import tempfile


_spec = importlib.util.spec_from_file_location('format_pi_runtime', Path(__file__).with_name('run.py'))
runtime = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(runtime)


def quote(value):
    if any(c in str(value) for c in '\n\r\x00'):
        raise ValueError('Newlines/control characters are not supported in paths.')
    return '"' + str(value).replace('\\', '\\\\').replace('"', '\\"').replace('%', '%%') + '"'


def render_service(config, user):
    writable = [config['state_root']]
    readonly = [config['music_root']]
    if config.get('downloads_enabled') is True:
        # One bind-mount island keeps staging -> albums rename atomic.
        writable.append(config['acquisition_root'])
        readonly.append(str(Path(config['acquisition_root']) / runtime.MARKER))
    return f'''[Unit]
Description=Format local music server (read-only media)
After=local-fs.target network.target
StartLimitIntervalSec=0

[Service]
Type=simple
User={user}
ExecStart=/usr/bin/python3 {quote(Path(config['app_dir']) / 'deployment/pi/run.py')} {quote(config['config_path'])}
Restart=on-failure
RestartSec=30
UMask=0077
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=strict
ProtectHome=read-only
ReadOnlyPaths={' '.join(quote(path) for path in readonly)}
ReadWritePaths={' '.join(quote(path) for path in writable)}
RestrictAddressFamilies=AF_UNIX AF_INET AF_INET6

[Install]
WantedBy=multi-user.target
'''


def retained_config(state):
    path = runtime.safe_path(state / 'config.json', exists=False)
    return json.loads(path.read_text()) if path.exists() else {}


def configure_downloads(config, enabled=False, acquisition=None, downloader=None, previous=None):
    previous = previous or {}
    config['downloads_enabled'] = bool(enabled)
    # Retain ownership information when disabling; never silently re-enable.
    for key in ('acquisition_root', 'downloader'):
        if previous.get(key):
            config[key] = previous[key]
    if not enabled:
        if acquisition or downloader:
            raise RuntimeError('--acquisition-root and --downloader require --enable-downloads.')
        if config.get('acquisition_root'):
            runtime.verify_acquisition(config)
        return
    if not acquisition or not downloader:
        raise RuntimeError('--enable-downloads requires --acquisition-root and --downloader on every install.')
    config.update(acquisition_root=str(runtime.safe_path(acquisition, exists=False)), downloader=downloader)
    path = Path(config['acquisition_root'])
    if path.exists() and (previous.get('acquisition_root') != str(path)
                          or previous.get('filesystem_uuid') != config['filesystem_uuid']):
        raise RuntimeError('Existing acquisition directory lacks matching retained configuration.')
    runtime.verify_acquisition(config, allow_new=True)
    verify_free_space(config)


def verify_free_space(config):
    if config.get('downloads_enabled') is not True:
        return
    acquisition = Path(config['acquisition_root'])
    path = acquisition / 'staging' if acquisition.exists() else Path(config['music_root'])
    space = os.statvfs(path)
    if space.f_bavail * space.f_frsize < 1024 ** 3:
        raise RuntimeError('Download-only mode requires at least 1 GiB user-available HDD space. No media or staging deleted.')


def create_acquisition(config):
    if config.get('downloads_enabled') is not True:
        runtime.verify_media(config)
        return
    path = runtime.verify_acquisition(config, allow_new=True)
    verify_free_space(config)
    if not path.exists():
        # No recursive mkdir: never construct a missing mount or arbitrary ancestors.
        path.mkdir(mode=0o700)
        for name in ('albums', 'staging'):
            (path / name).mkdir(mode=0o700)
        with (path / runtime.MARKER).open('x') as out:
            json.dump(dict(schemaVersion=1, filesystemUuid=config['filesystem_uuid']), out)
    runtime.verify_acquisition(config)


def report_pending_jobs(config):
    path = runtime.safe_path(Path(config['data_dir']) / 'acquisitions.json', exists=False)
    if not path.exists():
        print('No retained acquisition queue found.')
        return
    try:
        data = json.loads(path.read_text())
        jobs = data if isinstance(data, list) else data.get('items', [])
        if isinstance(jobs, dict):
            jobs = list(jobs.values())
        legacy = sum(1 for job in jobs if job.get('status') in ('queued', 'resolving', 'running', 'failed')
                     and not (job.get('origin') == 'manual' and job.get('downloadOnly') is True
                              and not job.get('missingTracks')))
        print(f'Legacy pending jobs preserved and not resumed in download-only mode: {legacy}')
    except (OSError, ValueError, AttributeError, TypeError):
        print('Retained queue could not be inspected; legacy pending count is unknown. No jobs changed.')



def register_service(config, unit, target, runner=subprocess.run):
    """Retain backups and restore the previous protected configuration on failure."""
    state = Path(config['state_root'])
    config_path = runtime.safe_path(config['config_path'], exists=False)
    old_config = config_path.read_bytes() if config_path.exists() else None
    old_unit = target.read_bytes() if target.exists() else None
    for label, content in [('config', old_config), ('service', old_unit)]:
        if content is not None:
            with tempfile.NamedTemporaryFile(prefix=label + '-backup-', suffix='.json' if label == 'config' else '.service',
                                             dir=state, delete=False) as out:
                out.write(content)
    with tempfile.NamedTemporaryFile(mode='w', dir=state, delete=False) as out:
        json.dump(config, out, indent=2)
        temporary = out.name
    os.chmod(temporary, 0o600)
    os.replace(temporary, config_path)
    try:
        runner(['sudo', 'tee', str(target)], input=unit, text=True, stdout=subprocess.DEVNULL, check=True)
        runner(['sudo', 'systemctl', 'daemon-reload'], check=True)
        runner(['sudo', 'systemctl', 'enable', 'format-pi.service'], check=True)
        runner(['sudo', 'systemctl', 'restart', 'format-pi.service'], check=True)
    except Exception as error:
        # Retain attempted configuration too; no music or queue data is removed.
        disabled = dict(config, downloads_enabled=False)
        with tempfile.NamedTemporaryFile(prefix='config-failed-', suffix='.json', dir=state, delete=False) as out:
            out.write(config_path.read_bytes())
        if old_config is not None:
            with tempfile.NamedTemporaryFile(dir=state, delete=False) as out:
                out.write(old_config)
                restore = out.name
            os.replace(restore, config_path)
        else:
            # An incomplete first install cannot opt in on a later service start.
            config_path.write_text(json.dumps(disabled, indent=2))
        try:
            runner(['sudo', 'systemctl', 'stop', 'format-pi.service'], check=True)
            if old_unit is not None:
                runner(['sudo', 'tee', str(target)], input=old_unit.decode(), text=True,
                       stdout=subprocess.DEVNULL, check=True)
                runner(['sudo', 'systemctl', 'daemon-reload'], check=True)
                # Leave stopped for review; do not alter a previous stopped state.
            else:
                runner(['sudo', 'tee', str(target)], input=render_service(disabled, pwd.getpwuid(os.getuid()).pw_name),
                       text=True, stdout=subprocess.DEVNULL, check=True)
                runner(['sudo', 'systemctl', 'daemon-reload'], check=True)
                runner(['sudo', 'systemctl', 'disable', 'format-pi.service'], check=True)
        except Exception as rollback_error:
            raise RuntimeError(f'Install failed ({error}); rollback incomplete ({rollback_error}). Stop the service and review retained backups.') from error
        raise RuntimeError(f'Install failed ({error}); previous configuration restored, service stopped. Backups and media retained.') from error


def select_node(previous, root):
    global_node = shutil.which('node')
    node_candidate = str(Path(global_node).resolve()) if global_node else previous.get('node')
    if not node_candidate:
        raise RuntimeError('Missing Node runtime. No runtime downloaded or installed.')
    node_path = runtime.safe_path(node_candidate)
    if not node_path.is_file() or not os.access(node_path, os.X_OK) or runtime.overlaps(node_path, root):
        raise RuntimeError('Node runtime must be an existing executable outside Music.')
    node = str(node_path)
    return node


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--music-root', required=True, help='Existing Music folder on mounted HDD')
    parser.add_argument('--install', action='store_true', help='Install and enable the system service after preflight')
    parser.add_argument('--enable-downloads', action='store_true', help='Explicitly enable isolated download-only acquisition')
    parser.add_argument('--acquisition-root', help='New dedicated directory directly inside verified Music')
    parser.add_argument('--downloader', help='Existing absolute executable, separately reviewed and installed')
    args = parser.parse_args()
    if os.getuid() == 0:
        raise RuntimeError('Run as the normal Kodi user, not sudo. Only service registration uses sudo.')
    app = Path(__file__).resolve().parents[2]
    root = runtime.safe_path(str(Path(args.music_root).expanduser()))
    home = Path.home().resolve()
    if not root.is_dir() or root in (Path('/'), home) or runtime.overlaps(root, app):
        raise RuntimeError('Choose the specific Music directory, not /, home, or the application checkout.')
    state = home / '.local/share/format-pi'
    runtime.safe_path(state, exists=False)
    previous = retained_config(state)
    for tool in ['ffmpeg', 'ffprobe', 'findmnt', 'systemctl', 'sudo']:
        if not shutil.which(tool):
            raise RuntimeError(f'Missing prerequisite: {tool}. No installation changes made.')
    node = select_node(previous, root)
    major = int(subprocess.check_output([node, '-p', 'process.versions.node.split(".")[0]'], text=True).strip())
    if major < 22:
        raise RuntimeError('Format requires Node 22+. No OS/package upgrade attempted.')
    mounted = json.loads(subprocess.check_output(['findmnt', '--json', '--target', str(root), '--output', 'UUID,TARGET'], text=True))['filesystems']
    if len(mounted) != 1 or not mounted[0].get('uuid') or mounted[0]['target'] == '/':
        raise RuntimeError('Music must be on an identifiable mounted HDD, not the root filesystem.')
    if not os.access(root, os.R_OK | os.X_OK):
        raise RuntimeError('Music folder is not readable. No permissions changed.')
    state = home / '.local/share/format-pi'
    runtime.safe_path(state, exists=False)
    if runtime.overlaps(state, root):
        raise RuntimeError('State/cache must remain outside Music on the system disk.')
    ancestor = state
    while not ancestor.exists():
        ancestor = ancestor.parent
    if runtime.mount_info(ancestor).get('uuid') == mounted[0]['uuid'] or ancestor.stat().st_dev == root.stat().st_dev:
        raise RuntimeError('State/cache must remain on the system disk, not the music HDD.')
    for child in ('cache', 'data', 'config.json'):
        runtime.safe_path(state / child, exists=False)
    config = dict(music_root=str(root), filesystem_uuid=mounted[0]['uuid'], app_dir=str(app), node=node,
                  state_root=str(state), cache_dir=str(state / 'cache'), data_dir=str(state / 'data'),
                  config_path=str(state / 'config.json'))
    previous = retained_config(state)
    if previous.get('filesystem_uuid') and previous['filesystem_uuid'] != config['filesystem_uuid']:
        raise RuntimeError('Mounted HDD UUID differs from retained configuration; refusing disk replacement.')
    configure_downloads(config, args.enable_downloads, args.acquisition_root, args.downloader, previous)
    report_pending_jobs(config)
    unit = render_service(config, pwd.getpwuid(os.getuid()).pw_name)
    print(f'Music (read only): {root}\nFilesystem: {mounted[0]["uuid"]}\nState/cache: {state}\nURL: http://127.0.0.1:4534')
    print('No formatting, mounting, media moves, tag edits, or firewall/LAN changes.')
    if args.enable_downloads:
        print(f'Download-only opt-in: {config["acquisition_root"]}; dedicated acquisition island writable, ownership marker read-only.')
        print('Executable exists; provider compatibility, ARM64 operation and lawful licensing are NOT verified.')
        print('New explicit download-only jobs can resume on restart; legacy jobs remain untouched.')
    else:
        print('Downloads disabled; existing acquisition music/state retained.')
    if not args.install:
        print('Preflight passed. Add --install to install and enable the service.')
        return
    target = runtime.safe_path('/etc/systemd/system/format-pi.service', exists=False)
    if target.exists() and 'Format local music server (read-only media)' not in target.read_text():
        raise RuntimeError('An unrelated format-pi service exists; refusing to replace it.')
    create_acquisition(config)
    if state.exists():
        print('Existing state retained; configuration backup will be made.')
    state.mkdir(parents=True, exist_ok=True, mode=0o700)
    for name in ['cache', 'data']:
        path = state / name
        if path.is_symlink():
            raise RuntimeError(f'Refusing symlinked {name} directory.')
        path.mkdir(mode=0o700, exist_ok=True)
    register_service(config, unit, target)
    print('Service registered. Check: systemctl status format-pi; curl http://127.0.0.1:4534/api/health')
    print('Set the Kodi Format add-on server URL to http://127.0.0.1:4534 .')
    print('Fresh albums require identification: POST /api/shadow-albums/reconcile; this changes server metadata only.')


if __name__ == '__main__':
    try:
        main()
    except Exception as error:
        print(f'Setup stopped: {error}', file=sys.stderr)
        sys.exit(1)
