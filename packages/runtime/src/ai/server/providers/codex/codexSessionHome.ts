import { lstat, mkdir, readFile, readlink, symlink } from 'node:fs/promises';
import path from 'node:path';

// Native account/configuration and rollout consumers must see the same files.
// Use an allowlist so future global instruction filenames cannot leak in.
const files = ['auth.json', 'auth.lock', 'auth.json.lock', 'config.toml', 'hooks.json', 'installation_id'];
const directories = ['sessions', 'archived_sessions', 'hooks', 'rules', 'plugins', 'skills', '.hook-trust'];

export async function isolatedCodexHome(source: string): Promise<string> {
  const home = path.join(source, 'nimbalyst-isolated');
  await mkdir(home, { recursive: true, mode: 0o700 });
  if (!(await lstat(home)).isDirectory()) throw new Error('Expected a directory for the isolated Codex home.');
  for (const name of ['AGENTS.md', 'AGENTS.override.md']) {
    if (await lstat(path.join(home, name)).catch(ignoreMissing)) {
      throw new Error(`Unexpected global instruction file in isolated Codex home: ${name}`);
    }
  }
  await Promise.all([...files, ...directories].map(async name => {
    const target = path.join(source, name);
    // Codex creates its rollout directory lazily; a dangling directory link
    // cannot be created through mkdir -p by the first isolated writer.
    if (directories.includes(name)) await mkdir(target, { recursive: true, mode: 0o700 });
    const link = path.join(home, name);
    try {
      await symlink(target, link, directories.includes(name) ? 'dir' : 'file');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST' || await readlink(link) !== target) throw error;
    }
  }));
  return home;
}

function ignoreMissing(error: NodeJS.ErrnoException): undefined {
  if (error.code !== 'ENOENT') throw error;
}

/** Linked checkouts opened as independent windows still use their parent project's defaults. */
export async function codexProjectRoot(workspace: string): Promise<string> {
  const gitFile = path.join(workspace, '.git');
  if (!(await lstat(gitFile).catch(ignoreMissing))?.isFile()) return workspace;
  const pointer = /^gitdir: (.+)$/m.exec(await readFile(gitFile, 'utf8'));
  if (!pointer) return workspace;
  const gitDir = path.resolve(workspace, pointer[1].trim());
  const common = await readFile(path.join(gitDir, 'commondir'), 'utf8').catch(ignoreMissing);
  if (!common) return workspace;
  const commonDir = path.resolve(gitDir, common.trim());
  return path.basename(commonDir) === '.git' ? path.dirname(commonDir) : workspace;
}

export async function nativeCodexDelegation(workspace: string, workflowOptIn?: boolean): Promise<boolean | undefined> {
  if (workflowOptIn) return true;
  const root = await codexProjectRoot(workspace);
  const file = path.join(root, '.nimbalyst', 'codex.json');
  const contents = await readFile(file, 'utf8').catch(ignoreMissing);
  if (contents === undefined) return undefined;
  const value = JSON.parse(contents)?.nativeMultiAgent;
  if (value !== undefined && typeof value !== 'boolean') throw new Error(`Expected boolean nativeMultiAgent in ${file}`);
  return value;
}
