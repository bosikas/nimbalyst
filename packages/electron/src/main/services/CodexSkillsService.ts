import path from 'node:path';
import { open } from 'node:fs/promises';
import type { JsonRpcClient } from '@nimbalyst/runtime/ai/server/protocols/codexAppServer/jsonRpcClient';
import { boundSessionOutput } from '../mcp/sessionOutput';
import type { CodexSkillCatalog, CodexSkillEntry } from '../../shared/codexSkills';

async function readSkill(file: string): Promise<string> {
  const handle = await open(file, 'r');
  try {
    if ((await handle.stat()).size > 10 * 1024 * 1024) throw new Error('Skill exceeds the 10 MiB preview limit. Open the source path to inspect the complete file.');
    return await handle.readFile('utf8');
  } finally { await handle.close(); }
}

/** Native configuration owns enablement. Never rename, delete or rewrite skills.
 * Serialize operations because extra skill roots belong to the management child.
 */
export function createCodexSkillsService(client: Pick<JsonRpcClient, 'request'>, read = readSkill) {
  let pending: Promise<unknown> = Promise.resolve();
  function serialize<T>(operation: () => Promise<T>): Promise<T> {
    const result = pending.then(operation);
    pending = result.catch(() => undefined);
    return result;
  }
  async function list(workspacePath: string): Promise<CodexSkillCatalog> {
    if (typeof workspacePath !== 'string' || !path.isAbsolute(workspacePath)) throw new Error('An absolute workspace path is required.');
    const errors: CodexSkillCatalog['errors'] = [];
    // The management child has its own plugin cache, just like a session child.
    try { await client.request('plugin/reconcile', { reason: 'nimbalyst-skill-settings' }, 5_000); }
    catch (error) { errors.push({ path: workspacePath, message: `Plugin discovery may be incomplete: ${String(error)}` }); }
    await client.request('skills/extraRoots/set', { extraRoots: [path.join(workspacePath, '.agents', 'skills', '.nimbalyst-generated')] });
    const response = await client.request<{ data: Array<{ skills: CodexSkillEntry[]; errors: CodexSkillCatalog['errors'] }> }>('skills/list', { cwds: [workspacePath], forceReload: true });
    if (!Array.isArray(response?.data)) throw new Error('Codex returned an unsupported skill catalog.');
    const skills = new Map<string, CodexSkillEntry>();
    for (const group of response.data) {
      for (const skill of group.skills ?? []) skills.set(skill.path, skill);
      errors.push(...(group.errors ?? []));
    }
    return { skills: [...skills.values()].sort((a, b) => a.name.localeCompare(b.name)), errors };
  }
  async function requireSkill(workspace: string, file: string) {
    const catalog = await list(workspace);
    if (typeof file !== 'string' || !path.isAbsolute(file) || !catalog.skills.some(skill => skill.path === file)) throw new Error('Skill is not a local path in the current native catalog. Refresh the catalog.');
  }
  return {
    list: (workspace: string) => serialize(() => list(workspace)),
    setEnabled: (workspace: string, file: string, enabled: boolean) => serialize(async () => {
      if (typeof enabled !== 'boolean') throw new Error('Skill enabled must be a boolean.');
      await requireSkill(workspace, file);
      await client.request('skills/config/write', { path: file, enabled });
      const catalog = await list(workspace);
      if (catalog.skills.find(skill => skill.path === file)?.enabled !== enabled) throw new Error('Codex did not report the requested effective skill setting. Refresh before retrying.');
      return catalog;
    }),
    preview: (workspace: string, file: string) => serialize(async () => {
      await requireSkill(workspace, file);
      return boundSessionOutput(await read(file));
    }),
  };
}
