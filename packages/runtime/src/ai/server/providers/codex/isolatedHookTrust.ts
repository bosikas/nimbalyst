import { spawn } from 'node:child_process';
import { realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import { JsonRpcClient } from '../../protocols/codexAppServer/jsonRpcClient';
import { resolveCodexBinaryPath } from '../../protocols/codexAppServer/codexAppServerBinary';
import { resolvePackagedCodexBinaryPath } from './codexBinaryPath';

type ConfigLayer = {
  name: { type: string };
  disabledReason?: string;
  config: { hooks?: { state?: Record<string, Record<string, unknown>> } };
};

const cache = new Map<string, { revision: string; result: Promise<string | undefined> }>();

/** Codex keys user hook decisions by absolute filename, even for identical symlinks.
 * Carry only the user's saved decisions for the two files linked by isolatedCodexHome.
 * Codex still checks the saved hash against the current command on every launch. */
export async function isolatedHookTrust(source: string, home: string): Promise<string | undefined> {
  const info = await stat(path.join(source, 'config.toml'), { bigint: true }).catch(error => {
    if (error.code !== 'ENOENT') throw error;
    return undefined;
  });
  if (!info) return undefined;
  const revision = [info.ino, info.size, info.ctimeNs, info.mtimeNs].join(':');
  const prior = cache.get(home);
  if (prior?.revision === revision) return prior.result;
  const result = readHookDecisions(source, home);
  cache.set(home, { revision, result });
  try {
    return await result;
  } catch (error) {
    if (cache.get(home)?.result === result) cache.delete(home);
    throw error;
  }
}

async function readHookDecisions(source: string, home: string): Promise<string | undefined> {
  const binary = resolveCodexBinaryPath(resolvePackagedCodexBinaryPath);
  const child = spawn(binary, ['app-server', '--listen', 'stdio://'], {
    cwd: source, env: { ...process.env, CODEX_HOME: source }, stdio: 'pipe',
  });
  child.stderr.resume();
  const client = new JsonRpcClient(child, { defaultTimeoutMs: 10_000 });
  try {
    await client.request('initialize', {
      clientInfo: { name: 'nimbalyst-hook-config', version: '1' },
      capabilities: { experimentalApi: true },
    });
    client.notify('initialized', {});
    const { layers } = await client.request<{ layers: ConfigLayer[] }>('config/read', { includeLayers: true });
    const user = layers.find(layer => layer.name.type === 'user' && !layer.disabledReason);
    const aliases = new Map<string, string>();
    const sources = new Set([source, await realpath(source)]);
    const homes = new Set([home, await realpath(home)]);
    for (const [key, state] of Object.entries(user?.config.hooks?.state ?? {})) {
      for (const root of sources) {
        const suffix = key.slice(root.length + 1);
        if (!key.startsWith(root + path.sep) || !/^(hooks\.json|config\.toml):/.test(suffix)) continue;
        const fields = Object.entries(state).filter(([name, value]) =>
          (name === 'enabled' && typeof value === 'boolean') ||
          (['trusted_hash', 'trusted_content_hash'].includes(name) && typeof value === 'string'));
        if (!fields.length) continue;
        const table = fields.map(([name, value]) => name + '=' + JSON.stringify(value)).join(',');
        for (const directory of homes) aliases.set(path.join(directory, suffix), '{' + table + '}');
      }
    }
    if (!aliases.size) return undefined;
    return 'hooks.state={' + [...aliases].map(([key, table]) => JSON.stringify(key) + '=' + table).join(',') + '}';
  } finally {
    client.close('Read user hook configuration');
    if (child.exitCode === null) child.kill();
  }
}
