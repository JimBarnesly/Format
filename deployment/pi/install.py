#!/usr/bin/env python3
"""Explicit read-only-media Format deployment. Never changes mounts or media."""
import argparse
import json
import os
from pathlib import Path
import pwd
import shutil
import subprocess
import sys
import tempfile


def quote(value):
    if any(c in str(value) for c in '\n\r\x00'):
        raise ValueError('Newlines/control characters are not supported in paths.')
    return '"' + str(value).replace('\\', '\\\\').replace('"', '\\"').replace('%', '%%') + '"'


def render_service(config, user):
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
ReadOnlyPaths={quote(config['music_root'])}
ReadWritePaths={quote(config['state_root'])}
RestrictAddressFamilies=AF_UNIX AF_INET AF_INET6

[Install]
WantedBy=multi-user.target
'''


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--music-root', required=True, help='Existing Music folder on mounted HDD')
    parser.add_argument('--install', action='store_true', help='Install and enable the system service after preflight')
    args = parser.parse_args()
    if os.getuid() == 0:
        raise RuntimeError('Run as the normal Kodi user, not sudo. Only service registration uses sudo.')
    app = Path(__file__).resolve().parents[2]
    root = Path(args.music_root).expanduser().resolve(strict=True)
    home = Path.home().resolve()
    if not root.is_dir() or root in (Path('/'), home) or root.is_relative_to(app):
        raise RuntimeError('Choose the specific Music directory, not /, home, or the application checkout.')
    for tool in ['node', 'ffmpeg', 'ffprobe', 'findmnt', 'systemctl', 'sudo']:
        if not shutil.which(tool):
            raise RuntimeError(f'Missing prerequisite: {tool}. No installation changes made.')
    node = str(Path(shutil.which('node')).resolve())
    major = int(subprocess.check_output([node, '-p', 'process.versions.node.split(".")[0]'], text=True).strip())
    if major < 22:
        raise RuntimeError('Format requires Node 22+. No OS/package upgrade attempted.')
    mounted = json.loads(subprocess.check_output(['findmnt', '--json', '--target', str(root), '--output', 'UUID,TARGET'], text=True))['filesystems']
    if len(mounted) != 1 or not mounted[0].get('uuid') or mounted[0]['target'] == '/':
        raise RuntimeError('Music must be on an identifiable mounted HDD, not the root filesystem.')
    if not os.access(root, os.R_OK | os.X_OK):
        raise RuntimeError('Music folder is not readable. No permissions changed.')
    state = home / '.local/share/format-pi'
    if state.is_symlink():
        raise RuntimeError('Refusing symlinked application state directory.')
    config = dict(music_root=str(root), filesystem_uuid=mounted[0]['uuid'], app_dir=str(app), node=node,
                  state_root=str(state), cache_dir=str(state / 'cache'), data_dir=str(state / 'data'),
                  config_path=str(state / 'config.json'))
    unit = render_service(config, pwd.getpwuid(os.getuid()).pw_name)
    print(f'Music (read only): {root}\nFilesystem: {mounted[0]["uuid"]}\nState/cache: {state}\nURL: http://127.0.0.1:4534')
    print('No formatting, mounting, media moves, tag edits, downloads, or firewall/LAN changes.')
    if not args.install:
        print('Preflight passed. Add --install to install and enable the service.')
        return
    target = Path('/etc/systemd/system/format-pi.service')
    if target.exists() and 'Format local music server (read-only media)' not in target.read_text():
        raise RuntimeError('An unrelated format-pi service exists; refusing to replace it.')
    if state.exists():
        print('Existing state retained; configuration backup will be made.')
    state.mkdir(parents=True, exist_ok=True, mode=0o700)
    for name in ['cache', 'data']:
        path = state / name
        if path.is_symlink():
            raise RuntimeError(f'Refusing symlinked {name} directory.')
        path.mkdir(mode=0o700, exist_ok=True)
    config_path = Path(config['config_path'])
    if config_path.is_symlink():
        raise RuntimeError('Refusing symlinked configuration file.')
    if config_path.exists():
        with tempfile.NamedTemporaryFile(prefix='config-backup-', suffix='.json', dir=state, delete=False) as out:
            out.write(config_path.read_bytes())
    with tempfile.NamedTemporaryFile(mode='w', dir=state, delete=False) as out:
        json.dump(config, out, indent=2)
        temporary = out.name
    os.chmod(temporary, 0o600)
    os.replace(temporary, config_path)
    subprocess.run(['sudo', 'tee', str(target)], input=unit, text=True, stdout=subprocess.DEVNULL, check=True)
    subprocess.run(['sudo', 'systemctl', 'daemon-reload'], check=True)
    subprocess.run(['sudo', 'systemctl', 'enable', 'format-pi.service'], check=True)
    subprocess.run(['sudo', 'systemctl', 'restart', 'format-pi.service'], check=True)
    print('Service registered. Check: systemctl status format-pi; curl http://127.0.0.1:4534/api/health')
    print('Set the Kodi Format add-on server URL to http://127.0.0.1:4534 .')
    print('Fresh albums require identification: POST /api/shadow-albums/reconcile; this changes server metadata only.')


if __name__ == '__main__':
    try:
        main()
    except Exception as error:
        print(f'Setup stopped: {error}', file=sys.stderr)
        sys.exit(1)
