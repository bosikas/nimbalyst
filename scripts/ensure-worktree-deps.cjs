const { spawnSync } = require('node:child_process');
const { statSync } = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');

function ensureWorktreeDeps() {
  if (process.platform !== 'darwin' && process.platform !== 'linux') return;
  if (process.env.CI || process.env.OFFICIAL_BUILD === 'true') return;
  if (!statSync(path.join(root, '.git'), { throwIfNoEntry: false })?.isFile()) return;

  const result = spawnSync('python3', [path.join(__dirname, 'install-worktree-deps.py'), '--ensure'], {
    cwd: root,
    stdio: 'inherit',
  });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}

if (require.main === module) ensureWorktreeDeps();
module.exports = ensureWorktreeDeps;
