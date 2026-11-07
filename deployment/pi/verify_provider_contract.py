#!/usr/bin/env python3
"""Inspect the pinned PyPI wheel without importing or executing provider code."""
import ast
import hashlib
import re
from pathlib import Path
import sys
import zipfile

WHEEL_SHA256 = '8fd5c715ce2a6b7b6cb7189e0fea1e2005a39f1af9682cdd49896055cb56d360'


def verify(wheel, server):
    if hashlib.sha256(wheel.read_bytes()).hexdigest() != WHEEL_SHA256:
        raise ValueError('Provider wheel does not match the verified PyPI 0.7.0 artifact.')
    with zipfile.ZipFile(wheel) as archive:
        tree = ast.parse(archive.read('launcher.py'))
    options = set()
    for node in ast.walk(tree):
        if isinstance(node, ast.Call) and isinstance(node.func, ast.Attribute) and node.func.attr == 'add_argument':
            options.update(arg.value for arg in node.args if isinstance(arg, ast.Constant) and isinstance(arg.value, str))
    invocation = server.split('const child = spawn(\n    spotiflacBin,', 1)[1].split('cwd: spotiflacCwd', 1)[0]
    requested = set(re.findall(r'"(--[a-z-]+)"', invocation))
    if not requested or requested - options:
        raise ValueError(f'Unsupported provider options: {sorted(requested - options)}')
    print('Pinned provider wheel and Format CLI options verified without executing provider code.')


if __name__ == '__main__':
    wheel = Path(sys.argv[1])
    server = (Path(__file__).resolve().parents[2] / 'server.mjs').read_text()
    verify(wheel, server)
    # Regression: the old invocation must fail the actual published parser contract.
    broken = server.replace('"--retries", "2"', '"--retries", "2", "--timeout", "120"')
    try:
        verify(wheel, broken)
    except ValueError as error:
        if '--timeout' not in str(error):
            raise
    else:
        raise AssertionError('Unsupported historical timeout option was not rejected.')
