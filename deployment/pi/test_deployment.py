import importlib.util
import json
from pathlib import Path
import tempfile
import types
import unittest


def load(name):
    spec = importlib.util.spec_from_file_location(name, Path(__file__).parent / (name + '.py'))
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


install = load('install')
run = load('run')


class DeploymentTests(unittest.TestCase):
    def test_safe_unit(self):
        config = dict(app_dir='/home/jake/Format source', music_root='/media/jake/My Disk/Music',
                      state_root='/home/jake/.local/share/format-pi', config_path='/home/jake/config.json')
        unit = install.render_service(config, 'jake')
        for expected in ['User=jake', 'ProtectSystem=strict', 'ProtectHome=read-only',
                         'NoNewPrivileges=true', 'ReadOnlyPaths="/media/jake/My Disk/Music"',
                         'ReadWritePaths="/home/jake/.local/share/format-pi"', 'Restart=on-failure']:
            self.assertIn(expected, unit)
        self.assertNotIn('chmod', unit)

    def test_quote(self):
        self.assertEqual(install.quote('/a%/b"c'), '"/a%%/b\\"c"')
        with self.assertRaises(ValueError):
            install.quote('/a\nExecStart=bad')

    def test_mount_matches(self):
        with tempfile.TemporaryDirectory() as temp:
            config = dict(music_root=temp, filesystem_uuid='correct')
            def runner(args, **kwargs):
                self.assertEqual(args[:3], ['findmnt', '--json', '--target'])
                return types.SimpleNamespace(stdout=json.dumps({'filesystems': [{'uuid': 'correct'}]}))
            self.assertEqual(run.verify_media(config, runner), Path(temp))

    def test_wrong_or_missing_mount_fails(self):
        with tempfile.TemporaryDirectory() as temp:
            config = dict(music_root=temp, filesystem_uuid='correct')
            for value in [[], [{'uuid': 'wrong'}], [{'uuid': None}]]:
                with self.assertRaises(RuntimeError):
                    run.verify_media(config, lambda *a, **kw: types.SimpleNamespace(stdout=json.dumps({'filesystems': value})))
        with self.assertRaises(RuntimeError):
            run.verify_media(config)


if __name__ == '__main__':
    unittest.main()
