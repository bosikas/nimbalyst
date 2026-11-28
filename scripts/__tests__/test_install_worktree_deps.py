import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import unittest


SCRIPT = Path(__file__).resolve().parents[1] / "install-worktree-deps.py"


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
            "elif os.environ.get('HOLD_INSTALL'):\n"
            "    sys.stdin.readline()\n"
            "else:\n"
            "    print(sys.argv[-1])\n"
        )
        pnpm.chmod(0o755)
        self.env = os.environ | {"PATH": f"{root}{os.pathsep}{os.environ['PATH']}"}
        self.env.pop("NIMBALYST_PNPM_STORE_DIR", None)

    def git(self, *args):
        subprocess.run(["git", "-c", "core.hooksPath=/dev/null", *args],
                       cwd=self.main, check=True)

    def command(self, checkout):
        return [sys.executable, str(checkout / "scripts" / SCRIPT.name)]

    def install(self, checkout, **env):
        return subprocess.run(self.command(checkout), cwd=checkout, env=self.env | env,
                              capture_output=True, text=True, timeout=10)

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
