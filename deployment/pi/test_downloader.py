import importlib.util
from pathlib import Path
import subprocess
import tempfile
import types
import unittest

spec = importlib.util.spec_from_file_location('provider', Path(__file__).with_name('install_downloader.py'))
provider = importlib.util.module_from_spec(spec)
spec.loader.exec_module(provider)
HELP = '--service --quality --filename-format --use-track-numbers --use-artist-subfolders --use-album-subfolders --retries --timeout'


class ProviderTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.target = Path(self.temp.name) / 'provider'
        self.commands = []

    def create(self, path):
        (path / 'bin').mkdir()
        executable = path / 'bin/spotiflac'
        executable.write_text('#!/bin/sh\n')
        executable.chmod(0o700)

    def runner(self, command, **kwargs):
        self.commands.append(command)
        return types.SimpleNamespace(stdout=HELP)

    def test_pinned_provider_and_cli_checked(self):
        result = provider.install(self.target, self.runner, self.create)
        self.assertEqual(result, self.target / 'bin/spotiflac')
        self.assertIn('SpotiFLAC==0.7.0', self.commands[0])
        self.assertIn('https://pypi.org/simple', self.commands[0])
        self.assertEqual(self.commands[-1][-1], '--help')
        self.commands.clear()
        provider.install(self.target, self.runner, self.create)
        self.assertEqual(len(self.commands), 2)  # No reinstall of existing environment.

    def test_partial_environment_retained(self):
        self.target.mkdir()
        (self.target / 'keep').write_text('original')
        with self.assertRaisesRegex(RuntimeError, 'incomplete'):
            provider.install(self.target, self.runner, self.create)
        self.assertEqual((self.target / 'keep').read_text(), 'original')
        self.assertEqual(self.commands, [])

    def test_symlink_rejected(self):
        self.target.symlink_to(self.target.parent, target_is_directory=True)
        with self.assertRaisesRegex(RuntimeError, 'symlink'):
            provider.install(self.target, self.runner, self.create)
        self.assertEqual(self.commands, [])

    def test_incompatible_cli_rejected(self):
        with self.assertRaisesRegex(RuntimeError, 'required option'):
            provider.install(self.target, lambda *a, **k: types.SimpleNamespace(stdout=''), self.create)

    def test_failed_install_retained_not_retried(self):
        def fail(*args, **kwargs):
            raise subprocess.CalledProcessError(1, args[0])
        with self.assertRaises(subprocess.CalledProcessError):
            provider.install(self.target, fail, lambda path: None)
        self.assertTrue(self.target.exists())
        with self.assertRaisesRegex(RuntimeError, 'incomplete'):
            provider.install(self.target, self.runner, self.create)

    def test_original_container_version_matches(self):
        dockerfile = Path(__file__).resolve().parents[2] / 'Dockerfile'
        self.assertIn('ARG SPOTIFLAC_VERSION=' + provider.VERSION, dockerfile.read_text())

    def test_setup_explicit_opt_in(self):
        setup = Path(__file__).with_name('setup.sh').read_text()
        self.assertIn('downloads=false', setup)
        self.assertIn('install_downloader.py', setup)
        self.assertIn('spotiflac-' + provider.VERSION + '/bin/spotiflac', setup)
        self.assertIn('--acquisition-root "${1%/}/.format-acquisitions"', setup)
