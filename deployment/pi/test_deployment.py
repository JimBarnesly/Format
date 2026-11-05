import contextlib
import importlib.util
import io
import json
import os
from pathlib import Path
import tempfile
import types
import unittest
from unittest.mock import patch


def load(name):
    spec = importlib.util.spec_from_file_location(name, Path(__file__).parent / (name + '.py'))
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


install = load('install')
run = load('run')


def mounted(*args, **kwargs):
    return types.SimpleNamespace(stdout=json.dumps({'filesystems': [{'uuid': 'correct', 'target': '/media/hdd'}]}))


class DeploymentTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        free_space = patch.object(install.os, 'statvfs', return_value=types.SimpleNamespace(
            f_bavail=1024 * 1024, f_frsize=4096))
        free_space.start()
        self.addCleanup(free_space.stop)
        self.base = Path(self.temp.name)
        self.music = self.base / 'Music'
        self.music.mkdir()
        self.downloader = self.base / 'provider-tool'
        self.downloader.write_text('synthetic executable; never invoked')
        self.downloader.chmod(0o700)
        self.config = dict(app_dir=str(self.base / 'app'), music_root=str(self.music),
                           state_root=str(self.base / 'state'), cache_dir=str(self.base / 'state/cache'),
                           data_dir=str(self.base / 'state/data'), config_path=str(self.base / 'state/config.json'),
                           filesystem_uuid='correct', acquisition_root=str(self.music / 'Format Downloads'),
                           downloader=str(self.downloader), downloads_enabled=True)

    def create_owned(self):
        path = Path(self.config['acquisition_root'])
        path.mkdir()
        (path / 'albums').mkdir()
        (path / 'staging').mkdir()
        (path / run.MARKER).write_text(json.dumps(dict(schemaVersion=1, filesystemUuid='correct')))
        return path

    def test_safe_unit(self):
        config = dict(self.config, downloads_enabled=False)
        unit = install.render_service(config, 'kodi')
        for expected in ['User=kodi', 'ProtectSystem=strict', 'ProtectHome=read-only',
                         'NoNewPrivileges=true', 'Restart=on-failure']:
            self.assertIn(expected, unit)
        self.assertEqual(next(line for line in unit.splitlines() if line.startswith('ReadWritePaths=')),
                         'ReadWritePaths=' + install.quote(config['state_root']))
        unit = install.render_service(self.config, 'kodi')
        self.assertEqual(next(line for line in unit.splitlines() if line.startswith('ReadWritePaths=')),
                         'ReadWritePaths=' + ' '.join(install.quote(p) for p in
                          [config['state_root'], config['acquisition_root']]))
        self.assertIn('ReadOnlyPaths=' + install.quote(config['music_root']), unit)
        self.assertIn(install.quote(config['acquisition_root'] + '/' + run.MARKER), unit)
        self.assertNotIn(install.quote(config['acquisition_root'] + '/albums'), unit)
        self.assertNotIn(install.quote(config['acquisition_root'] + '/staging'), unit)
        self.assertNotIn('chmod', unit)

    def test_quote(self):
        self.assertEqual(install.quote('/a%/b"c'), '"/a%%/b\\"c"')
        with self.assertRaises(ValueError):
            install.quote('/a\nExecStart=bad')

    def test_mount_matches(self):
        self.assertEqual(run.verify_media(self.config, mounted), self.music)

    def test_wrong_or_missing_mount_fails(self):
        for value in [[], [{'uuid': 'wrong', 'target': '/media/hdd'}], [{'uuid': None}],
                      [{'uuid': 'correct', 'target': '/'}]]:
            with self.assertRaises(RuntimeError):
                run.verify_media(self.config, lambda *a, **kw: types.SimpleNamespace(stdout=json.dumps({'filesystems': value})))
        self.music.rmdir()
        with self.assertRaises(RuntimeError):
            run.verify_media(self.config, mounted)

    def test_preflight_never_creates_directory(self):
        with patch.object(install.runtime, 'mount_info', return_value={'uuid': 'correct', 'target': '/media/hdd'}):
            install.configure_downloads(self.config, True, self.config['acquisition_root'], str(self.downloader))
        self.assertFalse(Path(self.config['acquisition_root']).exists())

    def test_low_free_space_rejects_new_opt_in_without_writes(self):
        before = sorted(str(path) for path in self.base.rglob('*'))
        with patch.object(install.runtime, 'mount_info', return_value={'uuid': 'correct', 'target': '/media/hdd'}), \
                patch.object(install.os, 'statvfs', return_value=types.SimpleNamespace(f_bavail=100, f_frsize=4096)) as statvfs:
            with self.assertRaisesRegex(RuntimeError, '1 GiB'):
                install.configure_downloads(self.config, True, self.config['acquisition_root'], str(self.downloader))
            statvfs.assert_called_with(self.music)
            with self.assertRaisesRegex(RuntimeError, '1 GiB'):
                install.create_acquisition(self.config)
        self.assertEqual(before, sorted(str(path) for path in self.base.rglob('*')))

    def test_low_space_retains_stage_and_does_not_block_disable(self):
        path = self.create_owned()
        stage = path / 'staging/partial.flac'
        stage.write_bytes(b'partial data retained')
        with patch.object(install.os, 'statvfs', return_value=types.SimpleNamespace(f_bavail=0, f_frsize=4096)):
            with self.assertRaisesRegex(RuntimeError, '1 GiB'):
                install.verify_free_space(self.config)
            install.verify_free_space(dict(self.config, downloads_enabled=False))
        self.assertEqual(stage.read_bytes(), b'partial data retained')
        with patch.object(install.os, 'statvfs', return_value=types.SimpleNamespace(f_bavail=262144, f_frsize=4096)):
            install.verify_free_space(self.config)

    def test_create_only_verified_directory(self):
        with patch.object(install.runtime, 'mount_info', return_value={'uuid': 'wrong', 'target': '/media/hdd'}):
            with self.assertRaises(RuntimeError):
                install.create_acquisition(self.config)
        self.assertFalse(Path(self.config['acquisition_root']).exists())
        with patch.object(install.runtime, 'mount_info', return_value={'uuid': 'correct', 'target': '/media/hdd'}):
            install.create_acquisition(self.config)
        self.assertEqual(run.verify_acquisition(self.config, mounted), Path(self.config['acquisition_root']))

    def test_owned_directory_requires_retained_config_and_marker(self):
        path = self.create_owned()
        with patch.object(install.runtime, 'mount_info', return_value={'uuid': 'correct', 'target': '/media/hdd'}):
            with self.assertRaises(RuntimeError):
                install.configure_downloads(self.config, True, str(path), str(self.downloader))
            install.configure_downloads(self.config, True, str(path), str(self.downloader), dict(self.config))
            (path / run.MARKER).unlink()
            with self.assertRaises(RuntimeError):
                install.configure_downloads(self.config, True, str(path), str(self.downloader), dict(self.config))

    def test_opt_in_and_disable_retains_media(self):
        path = self.create_owned()
        album = path / 'albums/owned.flac'
        album.write_bytes(b'unchanged')
        previous = dict(self.config)
        with patch.object(install.runtime, 'mount_info', return_value={'uuid': 'correct', 'target': '/media/hdd'}):
            install.configure_downloads(self.config, previous=previous)
            self.assertFalse(self.config['downloads_enabled'])
            self.assertEqual(self.config['acquisition_root'], str(path))
            self.assertEqual(album.read_bytes(), b'unchanged')
            with self.assertRaises(RuntimeError):
                install.configure_downloads(self.config, True, previous=previous)
        self.assertEqual(previous['downloads_enabled'], True)

    def test_paths_and_symlinks_rejected(self):
        for value in [str(self.music), str(self.base), str(self.music / 'nested/new'), '/']:
            with self.assertRaises(RuntimeError):
                run.verify_acquisition(dict(self.config, acquisition_root=value), mounted, allow_new=True)
        link = self.base / 'link'
        link.symlink_to(self.music, target_is_directory=True)
        with self.assertRaises(RuntimeError):
            run.verify_media(dict(self.config, music_root=str(link)), mounted)
        with self.assertRaises(RuntimeError):
            run.safe_path(link / 'nonexistent', exists=False)
        path = self.create_owned()
        (path / 'staging').rmdir()
        (path / 'staging').symlink_to(path / 'albums', target_is_directory=True)
        with self.assertRaises(RuntimeError):
            run.verify_acquisition(self.config, mounted)

    def test_state_overlap_and_downloader_rejected(self):
        for updates in [dict(state_root=self.config['acquisition_root']), dict(downloader='relative'),
                        dict(downloader=str(self.base / 'missing'))]:
            with self.assertRaises(RuntimeError):
                run.verify_acquisition(dict(self.config, **updates), mounted, allow_new=True)
        self.downloader.chmod(0o600)
        with self.assertRaises(RuntimeError):
            run.verify_acquisition(self.config, mounted, allow_new=True)

    def test_acquisition_wrong_mount_and_marker_rejected(self):
        path = self.create_owned()
        def changed(args, **kwargs):
            return mounted() if args[3] == str(self.music) else types.SimpleNamespace(stdout=json.dumps(
                {'filesystems': [{'uuid': 'wrong', 'target': '/media/other'}]}))
        with self.assertRaises(RuntimeError):
            run.verify_acquisition(self.config, changed)
        (path / run.MARKER).write_text('{"schemaVersion":1,"filesystemUuid":"wrong"}')
        with self.assertRaises(RuntimeError):
            run.verify_acquisition(self.config, mounted)

    def test_distinct_nested_mount_targets_rejected(self):
        acquisition = self.create_owned()
        for changed_path in [acquisition, acquisition / 'albums', acquisition / 'staging']:
            for target in ['', '/', str(changed_path)]:
                def runner(args, **kwargs):
                    selected = target if args[3] == str(changed_path) else '/media/hdd'
                    return types.SimpleNamespace(stdout=json.dumps({'filesystems': [
                        {'uuid': 'correct', 'target': selected}]}))
                with self.subTest(path=changed_path, target=target), self.assertRaises(RuntimeError):
                    run.verify_acquisition(self.config, runner)

    def test_music_readonly_parent_mount_can_differ(self):
        acquisition = self.create_owned()
        def runner(args, **kwargs):
            target = str(self.music) if args[3] == str(self.music) else str(acquisition)
            return types.SimpleNamespace(stdout=json.dumps({'filesystems': [
                {'uuid': 'correct', 'target': target}]}))
        self.assertEqual(run.verify_acquisition(self.config, runner), acquisition)

    def test_cross_device_staging_rejected(self):
        path = self.create_owned()
        original = Path.stat
        staging = path / 'staging'
        def stat(candidate, *args, **kwargs):
            value = original(candidate, *args, **kwargs)
            if candidate == staging:
                values = list(value)
                values[2] = value.st_dev + 1
                return os.stat_result(values)
            return value
        with patch.object(Path, 'stat', stat):
            with self.assertRaisesRegex(RuntimeError, 'share the Music filesystem'):
                run.verify_acquisition(self.config, mounted)

    def test_marker_and_downloader_symlinks_rejected(self):
        path = self.create_owned()
        marker = path / run.MARKER
        content = marker.read_bytes()
        marker.unlink()
        outside = self.base / 'marker.json'
        outside.write_bytes(content)
        marker.symlink_to(outside)
        with self.assertRaises(RuntimeError):
            run.verify_acquisition(self.config, mounted)
        link = self.base / 'downloader-link'
        link.symlink_to(self.downloader)
        with self.assertRaises(RuntimeError):
            run.verify_acquisition(dict(self.config, downloader=str(link)), mounted)

    def test_environment_clears_inherited_bypasses(self):
        inherited = dict(FORMAT_READ_ONLY='false', FORMAT_DOWNLOADS_ENABLED='true', DOWNLOAD_ROOT='/bad',
                         DOWNLOAD_STAGING_ROOT='/bad', FORMAT_ACQUISITION_ROOT='/bad', SPOTIFLAC_BIN='/bad',
                         SPOTIFLAC_CWD='/bad', TEST_BYPASS='true', NODE_OPTIONS='--require /bad', NODE_ENV='test')
        config = dict(self.config, downloads_enabled=False)
        config.pop('acquisition_root')
        env = run.runtime_environment(config, inherited)
        self.assertEqual(env['FORMAT_DOWNLOADS_ENABLED'], 'false')
        self.assertEqual(env['FORMAT_READ_ONLY'], 'true')
        self.assertEqual(env['NODE_ENV'], 'production')
        for key in ('DOWNLOAD_ROOT', 'DOWNLOAD_STAGING_ROOT', 'FORMAT_ACQUISITION_ROOT', 'SPOTIFLAC_BIN', 'TEST_BYPASS', 'NODE_OPTIONS'):
            self.assertNotIn(key, env)
        env = run.runtime_environment(self.config, inherited)
        self.assertEqual(env['DOWNLOAD_ROOT'], self.config['acquisition_root'] + '/albums')
        self.assertEqual(env['FORMAT_DOWNLOADS_ENABLED'], 'true')
        env = run.runtime_environment(dict(self.config, downloads_enabled=False), inherited)
        self.assertEqual(env['FORMAT_ACQUISITION_ROOT'], self.config['acquisition_root'])
        self.assertNotIn('SPOTIFLAC_BIN', env)

    def test_retained_node_when_global_missing(self):
        with patch.object(install.shutil, 'which', return_value=None):
            self.assertEqual(install.select_node({'node': str(self.downloader)}, self.music), str(self.downloader))
            with self.assertRaises(RuntimeError):
                install.select_node({}, self.music)
            linked = self.base / 'node-link'
            linked.symlink_to(self.downloader)
            with self.assertRaises(RuntimeError):
                install.select_node({'node': str(linked)}, self.music)

    def test_failed_install_restores_config_and_unit(self):
        state = Path(self.config['state_root'])
        state.mkdir()
        config_path = Path(self.config['config_path'])
        old = json.dumps(dict(self.config, downloads_enabled=False)).encode()
        config_path.write_bytes(old)
        unit = self.base / 'format.service'
        old_unit = install.render_service(dict(self.config, downloads_enabled=False), 'kodi')
        unit.write_text(old_unit)
        calls = []
        def runner(args, **kwargs):
            calls.append(args)
            if args[1] == 'tee':
                unit.write_text(kwargs['input'])
            if 'restart' in args:
                raise RuntimeError('synthetic restart failure')
        with self.assertRaisesRegex(RuntimeError, 'previous configuration restored'):
            install.register_service(self.config, install.render_service(self.config, 'kodi'), unit, runner)
        self.assertEqual(config_path.read_bytes(), old)
        self.assertEqual(unit.read_text(), old_unit)
        self.assertTrue(list(state.glob('config-backup-*')))
        self.assertTrue(list(state.glob('service-backup-*')))
        self.assertTrue(list(state.glob('config-failed-*')))
        self.assertIn(['sudo', 'systemctl', 'stop', 'format-pi.service'], calls)

    def test_failed_first_install_disables_downloads(self):
        Path(self.config['state_root']).mkdir()
        unit = self.base / 'format.service'
        def runner(args, **kwargs):
            if args[1] == 'tee':
                unit.write_text(kwargs['input'])
            if 'restart' in args:
                raise RuntimeError('synthetic failure')
        with self.assertRaises(RuntimeError):
            install.register_service(self.config, install.render_service(self.config, 'kodi'), unit, runner)
        self.assertFalse(json.loads(Path(self.config['config_path']).read_text())['downloads_enabled'])
        write_line = next(line for line in unit.read_text().splitlines() if line.startswith('ReadWritePaths='))
        self.assertEqual(write_line, 'ReadWritePaths=' + install.quote(self.config['state_root']))

    def test_failed_install_with_retained_config_but_missing_unit_is_protected(self):
        Path(self.config['state_root']).mkdir()
        config_path = Path(self.config['config_path'])
        old = json.dumps(self.config).encode()
        config_path.write_bytes(old)
        unit = self.base / 'format.service'
        calls = []
        def runner(args, **kwargs):
            calls.append(args)
            if args[1] == 'tee':
                unit.write_text(kwargs['input'])
            if 'restart' in args:
                raise RuntimeError('synthetic restart failure')
        with self.assertRaisesRegex(RuntimeError, 'previous configuration restored'):
            install.register_service(self.config, install.render_service(self.config, 'kodi'), unit, runner)
        self.assertEqual(config_path.read_bytes(), old)
        write_line = next(line for line in unit.read_text().splitlines() if line.startswith('ReadWritePaths='))
        self.assertEqual(write_line, 'ReadWritePaths=' + install.quote(self.config['state_root']))
        self.assertIn(['sudo', 'systemctl', 'stop', 'format-pi.service'], calls)
        self.assertIn(['sudo', 'systemctl', 'disable', 'format-pi.service'], calls)

    def test_legacy_report_is_read_only(self):
        data = Path(self.config['data_dir'])
        data.mkdir(parents=True)
        queue = data / 'acquisitions.json'
        queue.write_text(json.dumps({'schemaVersion': 1, 'items': [dict(status='queued'), dict(status='failed'),
                      dict(status='queued', origin='manual', downloadOnly=True, missingTracks=['track']),
                      dict(status='running', origin='manual', downloadOnly=True, missingTracks=[]),
                      dict(status='running', origin='manual', downloadOnly=True)]}))
        before = queue.read_bytes()
        out = io.StringIO()
        with contextlib.redirect_stdout(out):
            install.report_pending_jobs(self.config)
        self.assertIn('not resumed in download-only mode: 3', out.getvalue())
        self.assertEqual(queue.read_bytes(), before)


if __name__ == '__main__':
    unittest.main()
