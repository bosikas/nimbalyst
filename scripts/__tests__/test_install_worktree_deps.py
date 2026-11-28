import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import unittest


SCRIPT = Path(__file__).resolve().parents[1] / "install-worktree-deps.py"
BUILD_CHECK = SCRIPT.with_name("ensure-worktree-deps.cjs")


@unittest.skipUnless(sys.platform in ("darwin", "linux"), "requires POSIX file locks")
class WorktreeDepsTests(unittest.TestCase):
    def setUp(self):
        temp = tempfile.TemporaryDirectory()
        self.addCleanup(temp.cleanup)
        root = Path(temp.name).resolve()
        self.main = root / "primary checkout"
        self.other = root / "linked checkout"
        self.main.mkdir()
        scripts = self.main / "scripts"
        scripts.mkdir()
        shutil.copyfile(SCRIPT, scripts / SCRIPT.name)
        shutil.copyfile(BUILD_CHECK, scripts / BUILD_CHECK.name)
        self.git("init", "-q")
        self.git("add", "scripts")
        self.git("-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid",
                 "commit", "-qm", "Bootstrap")
        self.git("worktree", "add", "-q", "--detach", str(self.other))

        pnpm = root / "pnpm"
        pnpm.write_text(
            f"#!{sys.executable}\n"
            "import os, sys\n"
            "from pathlib import Path\n"
            "if sys.argv[1:3] == ['store', 'path']:\n"
            "    print(Path.cwd() / '.pnpm-store' / 'v11')\n"
            "elif sys.argv[1] == '--config.verify-deps-before-run=error':\n"
            "    if 'pnpm_config_verify_deps_before_run' not in os.environ:\n"
            "        if reason := os.environ.get('PROBE_ERROR'):\n"
            "            sys.exit(reason)\n"
            "elif os.environ.get('HOLD_INSTALL'):\n"
            "    sys.stdin.readline()\n"
            "else:\n"
            "    print(sys.argv[-1])\n"
        )
        pnpm.chmod(0o755)
        self.env = os.environ | {"PATH": f"{root}{os.pathsep}{os.environ['PATH']}"}
        for key in ("NIMBALYST_PNPM_STORE_DIR", "CI", "OFFICIAL_BUILD"):
            self.env.pop(key, None)

    def git(self, *args):
        subprocess.run(["git", "-c", "core.hooksPath=/dev/null", *args],
                       cwd=self.main, check=True)

    def command(self, checkout):
        return [sys.executable, str(checkout / "scripts" / SCRIPT.name)]

    def install(self, checkout, **env):
        return subprocess.run(self.command(checkout), cwd=checkout, env=self.env | env,
                              capture_output=True, text=True, timeout=10)

    def build_check(self, checkout, **env):
        return subprocess.run(["node", str(checkout / "scripts" / BUILD_CHECK.name)],
                              cwd=checkout, env=self.env | env, capture_output=True,
                              text=True, timeout=10)

    @unittest.skipUnless(shutil.which("node"), "requires Node")
    def test_build_checks_install_only_when_dependencies_are_stale(self):
        warm = self.build_check(self.other)
        self.assertEqual(warm.returncode, 0, warm.stderr)
        self.assertEqual(warm.stdout, "")
        stale = self.build_check(self.other, PROBE_ERROR="ERR_PNPM_VERIFY_DEPS_BEFORE_RUN",
                                 pnpm_config_verify_deps_before_run="false")
        self.assertEqual(stale.returncode, 0, stale.stderr)
        self.assertIn("pnpm package store:", stale.stdout)
        failed = self.build_check(self.other, PROBE_ERROR="pnpm failed to start")
        self.assertEqual(failed.returncode, 1)
        self.assertIn("pnpm failed to start", failed.stderr)
        self.assertEqual(failed.stdout, "")

    @unittest.skipUnless(shutil.which("node"), "requires Node")
    def test_build_checks_leave_explicit_setup_entrypoints_alone(self):
        for checkout, env in ((self.main, {}), (self.other, {"CI": "true"}),
                              (self.other, {"OFFICIAL_BUILD": "true"})):
            result = self.build_check(checkout, PROBE_ERROR="ERR_PNPM_VERIFY_DEPS_BEFORE_RUN", **env)
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertEqual(result.stdout, "")

    def test_new_worktrees_share_the_primary_store(self):
        store = str(self.main / ".pnpm-store" / "v11")
        for checkout in (self.main, self.other):
            result = self.install(checkout)
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertEqual(result.stdout.splitlines()[-1], store)

    def test_linked_checkout_resolves_primary_fallback_when_primary_store_is_unavailable(self):
        modules = self.main / "node_modules"
        modules.mkdir()
        (modules / ".modules.yaml").write_text(
            json.dumps({"storeDir": str(self.main / "unavailable-store")})
        )
        result = self.install(self.other)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(result.stdout.splitlines()[-1], str(self.main / ".pnpm-store" / "v11"))

    def test_preserves_store_of_an_existing_dependency_tree(self):
        local = self.other / ".pnpm-store" / "v11"
        modules = self.other / "node_modules"
        modules.mkdir()
        (modules / ".modules.yaml").write_text(json.dumps({"storeDir": str(local)}))
        self.assertEqual(self.install(self.other).stdout.splitlines()[-1], str(local))
        fresh = self.main / "custom-store"
        self.assertEqual(self.install(self.main, NIMBALYST_PNPM_STORE_DIR=str(fresh))
                         .stdout.splitlines()[-1], str(fresh))

    def test_refuses_to_install_into_a_symlinked_dependency_tree(self):
        (self.other / "node_modules").symlink_to(self.main / "node_modules")
        result = self.install(self.other)
        self.assertEqual(result.returncode, 1)
        self.assertIn("node_modules is a symlink", result.stderr)

    def test_competing_installs_are_serialized_only_within_a_worktree(self):
        with subprocess.Popen(self.command(self.main), cwd=self.main,
                              env=self.env | {"HOLD_INSTALL": "1"},
                              stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                              text=True) as running:
            try:
                self.assertTrue(running.stdout.readline().startswith("pnpm package store:"))
                self.assertEqual(self.install(self.main).returncode, os.EX_TEMPFAIL)
                self.assertEqual(self.install(self.other).returncode, 0)
                running.communicate("done\n", timeout=10)
                self.assertEqual(running.returncode, 0)
            finally:
                if running.poll() is None:
                    running.kill()
        self.assertEqual(self.install(self.main).returncode, 0)


if __name__ == "__main__":
    unittest.main()
