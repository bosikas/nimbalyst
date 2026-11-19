// @vitest-environment node
import { expect, it } from 'vitest';
import { spawn } from 'node:child_process';
import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { resolveCodexBinaryPath } from '../../protocols/codexAppServer/codexAppServerBinary';
import { JsonRpcClient } from '../../protocols/codexAppServer/jsonRpcClient';
import { isolatedCodexHome } from '../codex/codexSessionHome';
import { isolatedHookTrust } from '../codex/isolatedHookTrust';

type Hook = { source: string; key: string; currentHash: string; trustStatus: string; enabled: boolean };

async function userHook(home: string, trust?: string): Promise<Hook> {
  const child = spawn(resolveCodexBinaryPath(), [
    ...(trust ? ['-c', trust] : []), 'app-server', '--listen', 'stdio://',
  ], { cwd: home, env: { ...process.env, CODEX_HOME: home }, stdio: 'pipe' });
  child.stderr.resume();
  const client = new JsonRpcClient(child);
  try {
    await client.request('initialize', {
      clientInfo: { name: 'hook-trust-test', version: '1' }, capabilities: { experimentalApi: true },
    });
    client.notify('initialized', {});
    const result = await client.request<{ data: Array<{ hooks: Hook[] }> }>('hooks/list', { cwds: [home] });
    const hook = result.data.flatMap(row => row.hooks).find(h => h.key.startsWith(path.join(home, 'hooks.json') + ':'));
    if (!hook) throw new Error('Native Codex did not list the fixture hook');
    return hook;
  } finally {
    client.close('Hook test done');
    child.kill();
  }
}

it('preserves saved hook approval and revocation and rejects changed commands in an isolated home', async () => {
  const source = await realpath(await mkdtemp(path.join(os.tmpdir(), 'nim-hook-trust-')));
  try {
    const home = await isolatedCodexHome(source);
    const setCommand = (command: string) => writeFile(path.join(source, 'hooks.json'), JSON.stringify({
      hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command }] }] },
    }));
    await setCommand('echo original');
    const original = await userHook(source);
    const config = path.join(source, 'config.toml');
    const decision = '[hooks.state.' + JSON.stringify(original.key) + ']\ntrusted_hash=' + JSON.stringify(original.currentHash);
    await writeFile(config, decision);
    const isolated = () => isolatedHookTrust(source, home).then(trust => userHook(home, trust));
    expect(await isolated()).toMatchObject({ trustStatus: 'trusted', enabled: true });
    await setCommand('echo changed');
    expect((await isolated()).trustStatus).not.toBe('trusted');
    await writeFile(config, decision + '\nenabled=false\n');
    expect((await isolated()).enabled).toBe(false);
    await writeFile(config, '');
    expect(await isolatedHookTrust(source, home)).toBeUndefined();
  } finally {
    await rm(source, { recursive: true, force: true });
  }
}, 30_000);
