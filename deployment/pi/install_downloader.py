#!/usr/bin/env python3
"""Install Format's existing pinned provider in an isolated, versioned venv."""
import os
from pathlib import Path
import subprocess
import sys
import venv

VERSION = '0.7.0'  # Keep aligned with Dockerfile's original provider.


def install(destination, runner=subprocess.run, create=None):
    destination = Path(destination)
    if not destination.is_absolute() or '..' in destination.parts:
        raise RuntimeError('Provider destination must be an absolute path without traversal.')
    for path in (destination, *destination.parents):
        if path.is_symlink():
            raise RuntimeError('Provider destination must not contain symlinks.')
    executable = destination / 'bin/spotiflac'
    # Never overwrite a pre-existing environment, including partial installations.
    if destination.exists():
        if ((destination / 'bin').is_symlink() or not executable.is_file()
                or executable.is_symlink() or not os.access(executable, os.X_OK)):
            raise RuntimeError('Provider environment exists but is incomplete; retained unchanged.')
    else:
        destination.parent.mkdir(parents=True, exist_ok=True)
        destination.mkdir(mode=0o700)
        (create or (lambda path: venv.EnvBuilder(with_pip=True).create(path)))(destination)
        runner([str(destination / 'bin/python'), '-m', 'pip', '--isolated', 'install',
                '--disable-pip-version-check', '--no-input', '--index-url', 'https://pypi.org/simple',
                f'SpotiFLAC=={VERSION}'], check=True)
    # Verify both installed version and the CLI contract actually used by server.mjs.
    runner([str(destination / 'bin/python'), '-c',
            'from importlib.metadata import version; '
            f'assert version("SpotiFLAC") == {VERSION!r}, "Unexpected SpotiFLAC version"'], check=True)
    result = runner([str(executable), '--help'], check=True, text=True, capture_output=True)
    for option in ('--service', '--quality', '--filename-format', '--use-track-numbers',
                   '--use-artist-subfolders', '--use-album-subfolders', '--retries'):
        if option not in result.stdout:
            raise RuntimeError(f'Installed provider does not support required option: {option}')
    return executable


if __name__ == '__main__':
    try:
        target = Path.home() / '.local/share/format-runtime' / f'spotiflac-{VERSION}'
        print(install(target))
    except Exception as error:
        print(f'Provider setup stopped: {error}', file=sys.stderr)
        sys.exit(1)
