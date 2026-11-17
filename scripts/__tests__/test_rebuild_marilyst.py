import importlib.util
from pathlib import Path
import plistlib
import shutil
import tempfile
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('rebuild', Path(__file__).parents[1] / 'rebuild-marilyst.py')
m = importlib.util.module_from_spec(spec)
spec.loader.exec_module(m)


class SafeInstallTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.source = self.app('build/Marilyst.app', b'new archive')
        self.target = self.app('installed/Marilyst.app', b'previous archive')

    def app(self, name, content):
        app = self.root / name
        (app / 'Contents/Resources').mkdir(parents=True)
        (app / 'Contents/Resources/app.asar').write_bytes(content)
        with (app / 'Contents/Info.plist').open('wb') as f:
            plistlib.dump({'CFBundleIdentifier': m.BUNDLE_ID, 'CFBundleName': 'Marilyst'}, f)
        return app

    def verify(self, app):
        m.bundle_info(app)
        return m.digest(app / 'Contents/Resources/app.asar')

    def install(self, **options):
        return m.install_app(self.source, self.target, verify=options.pop('verify', self.verify), copy=options.pop('copy', shutil.copytree), **options)

    def test_replacement_preserves_original_and_allows_another_install(self):
        first = self.install(stamp='first')
        self.assertEqual((Path(first['backup']) / 'Contents/Resources/app.asar').read_bytes(), b'previous archive')
        self.assertEqual(self.verify(self.target), self.verify(self.source))
        second = self.install(stamp='second')
        self.assertNotEqual(first['backup'], second['backup'])
        self.assertTrue(Path(first['backup']).exists())
        self.assertFalse(second['restarted'])

    def test_stage_validation_failure_leaves_current_app_untouched(self):
        def verify(app):
            if 'install-' in app.name:
                raise RuntimeError('invalid signature')
            return self.verify(app)
        with self.assertRaisesRegex(RuntimeError, 'invalid signature'):
            self.install(verify=verify, stamp='bad')
        self.assertEqual((self.target / 'Contents/Resources/app.asar').read_bytes(), b'previous archive')
        self.assertTrue((self.target.parent / '.Marilyst-install-bad.app').exists())

    def test_post_swap_failure_restores_previous_app_and_retains_failed_bundle(self):
        def verify(app):
            if app == self.target:
                raise RuntimeError('post-swap failure')
            return self.verify(app)
        with self.assertRaisesRegex(RuntimeError, 'post-swap failure'):
            self.install(verify=verify, stamp='rollback')
        self.assertEqual((self.target / 'Contents/Resources/app.asar').read_bytes(), b'previous archive')
        self.assertTrue((self.target.parent / '.Marilyst-failed-rollback.app').exists())

    def test_rename_failure_retries_then_restores_previous_app(self):
        attempts = []
        def rename(a, b):
            if a.name.startswith('.Marilyst-install-'):
                attempts.append(a)
                raise OSError('destination unavailable')
            a.rename(b)
        with patch.object(m.time, 'sleep'), self.assertRaises(OSError):
            self.install(rename=rename, stamp='retry')
        self.assertEqual(len(attempts), 3)
        self.assertEqual((self.target / 'Contents/Resources/app.asar').read_bytes(), b'previous archive')

    def test_wrong_bundle_identity_and_concurrent_install_fail_closed(self):
        info = self.source / 'Contents/Info.plist'
        with info.open('wb') as f:
            plistlib.dump({'CFBundleIdentifier': 'another.app', 'CFBundleName': 'Marilyst'}, f)
        with self.assertRaisesRegex(RuntimeError, 'identity'):
            self.install()
        self.assertEqual((self.target / 'Contents/Resources/app.asar').read_bytes(), b'previous archive')
        self.app('other/Marilyst.app', b'valid')
        self.source = self.root / 'other/Marilyst.app'
        (self.target.parent / '.Marilyst-install.lock').mkdir()
        with self.assertRaises(FileExistsError):
            self.install()

    def test_changed_copy_is_not_installed(self):
        def copy(a, b):
            shutil.copytree(a, b)
            (b / 'Contents/Resources/app.asar').write_bytes(b'damaged copy')
        with self.assertRaisesRegex(RuntimeError, 'differs'):
            self.install(copy=copy)
        self.assertEqual((self.target / 'Contents/Resources/app.asar').read_bytes(), b'previous archive')

    def test_failure_after_backup_rename_restores_visible_app(self):
        def rename(a, b):
            a.rename(b)
            if a == self.target:
                raise RuntimeError('failure after backup')
        with self.assertRaisesRegex(RuntimeError, 'failure after backup'):
            self.install(rename=rename, stamp='backup-failure')
        self.assertEqual((self.target / 'Contents/Resources/app.asar').read_bytes(), b'previous archive')

    def test_refuses_a_symlink_destination(self):
        alias = self.target.parent / 'Alias.app'
        alias.symlink_to(self.target, target_is_directory=True)
        with self.assertRaisesRegex(RuntimeError, 'symlink'):
            m.install_app(self.source, alias, verify=self.verify, copy=shutil.copytree)
        self.assertEqual((self.target / 'Contents/Resources/app.asar').read_bytes(), b'previous archive')


class ToolchainTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)

    def sdk(self, name, version):
        sdk = self.root / name
        interface = sdk / 'usr/lib/swift/Swift.swiftmodule/arm64e-apple-macos.swiftinterface'
        interface.parent.mkdir(parents=True)
        interface.write_text('// swift-interface-format-version: 1.0\n// swift-compiler-version: Apple Swift version ' + version + '\n')
        return sdk

    def test_uses_actual_mjs_launcher_when_corepack_cjs_path_is_dangling(self):
        launcher = self.root / '12.9.1/bin/pnpm.mjs'
        launcher.parent.mkdir(parents=True)
        launcher.write_text('launcher')
        self.assertEqual(m.choose_pnpm_launcher('12.9.1', [self.root]), launcher)
        with self.assertRaisesRegex(RuntimeError, 'No packages were installed'):
            m.choose_pnpm_launcher('13.0.0', [self.root])

    def test_rejects_newer_sdk_and_selects_installed_compatible_sdk(self):
        incompatible = self.sdk('MacOSX15.0.sdk', '6.0')
        compatible = self.sdk('MacOSX14.5.sdk', '5.10')
        self.assertEqual(m.choose_sdk((5, 10), [incompatible, compatible]), compatible)
        with self.assertRaisesRegex(RuntimeError, 'No SDK compatible'):
            m.choose_sdk((5, 10), [incompatible])
        self.assertEqual(m.choose_sdk((6, 0), [incompatible, compatible]), incompatible)

    def test_stable_provenance_does_not_invalidate_cache_on_every_invocation(self):
        file = self.root / 'toolchain.json'
        m.write_if_changed(file, '{"sdk":"14.5"}')
        timestamp = file.stat().st_mtime_ns
        m.write_if_changed(file, '{"sdk":"14.5"}')
        self.assertEqual(file.stat().st_mtime_ns, timestamp)
        m.write_if_changed(file, '{"sdk":"15.0"}')
        self.assertEqual(file.read_text(), '{"sdk":"15.0"}')


if __name__ == '__main__':
    unittest.main()
