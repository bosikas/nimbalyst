import importlib.util
from functools import partial
import os
from pathlib import Path
import shutil
import tempfile
import unittest
from unittest.mock import patch


spec = importlib.util.spec_from_file_location(
    'retention', Path(__file__).parents[1] / 'linux-build-retention.py'
)
retention = importlib.util.module_from_spec(spec)
spec.loader.exec_module(retention)


class RetentionTests(unittest.TestCase):
    def setUp(self):
        directory = tempfile.TemporaryDirectory()
        self.addCleanup(directory.cleanup)
        self.root = Path(directory.name).resolve() / 'nimbalyst-builds'
        self.root.mkdir()
        self.config = self.root.parent / 'config'
        self.proc = self.root.parent / 'proc'
        self.proc.mkdir()
        process_scan = patch.object(retention, 'protected_stages', partial(retention.protected_stages, proc_root=self.proc))
        process_scan.start()
        self.addCleanup(process_scan.stop)
        self.now = 50_000

    def stage(self, commit, *, fresh=False, verified=False, with_source=True):
        stage = self.root / commit
        archive = retention.app_archive(stage)
        archive.parent.mkdir(parents=True)
        archive.write_text('packaged app')
        (retention.unpacked_app(stage) / 'nimbalyst').touch()
        if with_source:
            source = stage / 'source'
            (source / 'node_modules/.pnpm').mkdir(parents=True)
            for name in ('.git', 'pnpm-lock.yaml', 'package.json', 'my-change.txt'):
                (source / name).touch()
        if verified:
            (stage / 'verified-commit').write_text(commit)
        if not fresh:
            for path in [stage, archive, *stage.iterdir(), stage / 'source/node_modules']:
                if not path.exists():
                    continue
                os.utime(path, (1, 1))
        return stage

    def test_protects_processes_launchers_and_saved_rollback_pointers(self):
        p = self.proc / '123'
        p.mkdir(parents=True)
        stage = self.stage('abcdef1')
        (p / 'cmdline').write_bytes(b'nimbalyst\0')
        (p / 'exe').symlink_to(retention.unpacked_app(stage) / 'nimbalyst')
        (stage / 'previous-service.local').write_text(f'ExecStart={self.root}/123abcd/artifacts/linux-unpacked/nimbalyst')
        (self.root / '.test-current-build').write_text(str(self.root / 'badf00d'))
        unit = self.config / 'systemd/user/pinned.service'
        unit.parent.mkdir(parents=True)
        unit.write_text(f'ExecStart={self.root}/a1b2c3d/artifacts/linux-unpacked/nimbalyst')
        self.assertEqual(retention.protected_stages(self.root, self.config),
                         {'abcdef1', '123abcd', 'badf00d', 'a1b2c3d'})

    def test_preview_and_apply_keep_source_recent_builds_and_rollbacks(self):
        old = self.stage('abcdef1')
        recent = self.stage('abcdef2', fresh=True)
        marked = self.stage('abcdef3')
        rollback = self.stage('abcdef4', verified=True)
        packaged_only = self.stage('abcdef5', with_source=False)
        (self.root / '.test-current-build').write_text(str(marked))

        def remove_generated(command, *, check):
            self.assertTrue(check)
            self.assertEqual(command[:-1], ['/usr/bin/rm', '-rf', '--one-file-system', '--'])
            shutil.rmtree(command[-1])

        with patch.object(retention, 'mounted_below', return_value=False), \
                patch.object(retention.subprocess, 'run', side_effect=remove_generated) as run:
            self.assertEqual(retention.prune(self.root, self.config, apply=False, now=self.now), 0)
            run.assert_not_called()
            self.assertEqual(retention.prune(self.root, self.config, apply=True, now=self.now), 2)
            self.assertEqual(retention.prune(self.root, self.config, apply=True, now=self.now), 0)
        self.assertTrue((old / 'source/my-change.txt').exists())
        self.assertTrue((old / 'source/pnpm-lock.yaml').exists())
        self.assertFalse((old / 'source/node_modules').exists())
        self.assertFalse(retention.app_archive(old).exists())
        for stage in (recent, marked, rollback, packaged_only):
            self.assertTrue(retention.app_archive(stage).exists(), stage)

    def test_skips_symlinked_dependencies_and_mounted_output(self):
        stage = self.stage('abcdef1')
        dependencies = stage / 'source/node_modules'
        external = self.root.parent / 'other-dependencies'
        dependencies.rename(external)
        dependencies.symlink_to(external)
        os.utime(dependencies, (1, 1), follow_symlinks=False)
        with patch.object(retention, 'mounted_below', return_value=True), \
                patch.object(retention.subprocess, 'run') as run:
            self.assertEqual(retention.prune(self.root, self.config, apply=True, now=self.now), 0)
            run.assert_not_called()
        self.assertTrue((external / '.pnpm').exists())
        self.assertTrue(retention.app_archive(stage).exists())


if __name__ == '__main__':
    unittest.main()
