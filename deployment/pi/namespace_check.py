#!/usr/bin/env python3
"""CI-only disposable systemd namespace check. Never installs a production unit."""
import errno
import json
import os
from pathlib import Path
import pwd
import shutil
import subprocess
import sys
import tempfile
import uuid


def denied(operation, label):
    try:
        operation()
    except OSError as error:
        if error.errno not in (errno.EROFS, errno.EACCES, errno.EPERM, errno.EBUSY):
            raise
    else:
        raise AssertionError(f'{label} unexpectedly writable')


def probe(root):
    if os.getuid() == 0:
        raise RuntimeError('Namespace probe must run as an unprivileged user.')
    music = root / 'Music'
    acquisition = music / 'Acquisition'
    original = music / 'original.flac'
    marker = acquisition / '.format-acquisition.json'
    denied(lambda: original.write_bytes(b'changed'), 'original media')
    denied(lambda: (music / 'forbidden').write_bytes(b'changed'), 'Music directory')
    denied(lambda: marker.write_bytes(b'changed'), 'ownership marker')
    denied(lambda: marker.unlink(), 'ownership marker unlink')
    denied(lambda: (root / 'outside-island').write_bytes(b'changed'), 'outside writable islands')
    assert original.read_bytes() == b'original synthetic media'
    assert json.loads(marker.read_text()) == {'schemaVersion': 1, 'filesystemUuid': 'synthetic'}
    (root / 'state' / 'state-probe').write_bytes(b'state writable')
    (acquisition / 'island-probe').write_bytes(b'dedicated island writable')
    targets = []
    for path in (acquisition, acquisition / 'albums', acquisition / 'staging'):
        result = subprocess.run(['findmnt', '--json', '--target', str(path), '--output', 'TARGET'],
                                check=True, capture_output=True, text=True)
        mounts = json.loads(result.stdout)['filesystems']
        assert len(mounts) == 1
        targets.append(mounts[0]['target'])
    assert targets[0] and targets[0] != '/' and len(set(targets)) == 1, targets
    staged = acquisition / 'staging' / 'album'
    staged.mkdir()
    (staged / 'track.flac').write_bytes(b'synthetic downloaded media')
    inode = staged.stat().st_ino
    published = acquisition / 'albums' / 'album'
    os.rename(staged, published)  # Must succeed directly: no EXDEV copy fallback.
    assert published.stat().st_ino == inode and not staged.exists()
    assert (published / 'track.flac').read_bytes() == b'synthetic downloaded media'
    print('Namespace verified: original media/marker protected; state/acquisition writable; atomic rename and common mount target passed.', flush=True)


def main():
    if len(sys.argv) == 3 and sys.argv[1] == '--probe':
        probe(Path(sys.argv[2]))
        return
    if len(sys.argv) != 1:
        raise RuntimeError('No arguments supported outside the private probe.')
    if Path('/proc/1/comm').read_text().strip() != 'systemd':
        raise RuntimeError('This CI check requires systemd as PID 1; refusing to skip or weaken namespace assertions.')
    if os.getuid() == 0:
        raise RuntimeError('Run as the unprivileged CI runner, not root.')
    for tool in ('sudo', 'systemd-run', 'systemctl', 'findmnt'):
        if not shutil.which(tool):
            raise RuntimeError(f'Missing required CI tool: {tool}')
    parent = Path(os.environ.get('RUNNER_TEMP', str(Path.home()))).resolve(strict=True)
    if parent == Path('/tmp') or parent.is_relative_to('/tmp') or parent == Path('/var/tmp') or parent.is_relative_to('/var/tmp'):
        raise RuntimeError('Use RUNNER_TEMP or home outside /tmp and /var/tmp; PrivateTmp must remain enabled.')
    # Import production renderer without invoking the installer.
    from install import render_service
    username = pwd.getpwuid(os.getuid()).pw_name
    unit = 'format-namespace-test-' + uuid.uuid4().hex + '.service'
    with tempfile.TemporaryDirectory(prefix='format-namespace-', dir=parent) as temp:
        root = Path(temp)
        music = root / 'Music'
        acquisition = music / 'Acquisition'
        for path in (acquisition / 'albums', acquisition / 'staging', root / 'state'):
            path.mkdir(parents=True, mode=0o700)
        (music / 'original.flac').write_bytes(b'original synthetic media')
        (acquisition / '.format-acquisition.json').write_text(json.dumps(
            {'schemaVersion': 1, 'filesystemUuid': 'synthetic'}))
        script = root / 'probe.py'
        shutil.copyfile(__file__, script)
        config = dict(app_dir=str(root), config_path=str(root / 'unused-config.json'),
                      music_root=str(music), state_root=str(root / 'state'),
                      acquisition_root=str(acquisition), downloads_enabled=True)
        service = render_service(config, username)
        # Reuse every generated Service property except executable/restart lifecycle.
        properties = []
        in_service = False
        for line in service.splitlines():
            if line.startswith('['):
                in_service = line == '[Service]'
            elif in_service and '=' in line:
                key = line.split('=', 1)[0]
                if key not in ('Type', 'ExecStart', 'Restart', 'RestartSec'):
                    properties.append('--property=' + line)
        command = ['sudo', '-n', 'systemd-run', '--wait', '--pipe', '--collect',
                   '--unit=' + unit, '--property=RuntimeMaxSec=60', *properties,
                   '/usr/bin/python3', str(script), '--probe', str(root)]
        try:
            subprocess.run(command, check=True, timeout=90)
            assert (music / 'original.flac').read_bytes() == b'original synthetic media'
            assert json.loads((acquisition / '.format-acquisition.json').read_text())['filesystemUuid'] == 'synthetic'
        finally:
            # Only the UUID-named unit and TemporaryDirectory belong to this check.
            subprocess.run(['sudo', '-n', 'systemctl', 'stop', unit], check=False,
                           stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=30)


if __name__ == '__main__':
    try:
        main()
    except Exception as error:
        print(f'Namespace verification failed: {error}', file=sys.stderr)
        sys.exit(1)
