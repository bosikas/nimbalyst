import { existsSync } from 'node:fs';
import { readFile, readdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { Readable } from 'node:stream';
import { proxyMcp } from './mcp-output-budget.mjs';

async function packageRoot() {
  const claudeHome = process.env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude');
  try {
    const installed = JSON.parse(await readFile(join(claudeHome, 'plugins/installed_plugins.json'), 'utf8'));
    for (const entry of installed.plugins?.['context-mode@context-mode'] ?? []) {
      if (entry.installPath && existsSync(join(entry.installPath, 'server.mjs'))) return entry.installPath;
    }
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  const cache = join(claudeHome, 'plugins/cache/context-mode/context-mode');
  const versions = (await readdir(cache)).sort((a, b) => b.localeCompare(a, undefined, { numeric: true }));
  const version = versions.find(name => existsSync(join(cache, name, 'server.mjs')));
  if (!version) throw new Error('Install context-mode before starting the repository MCP server.');
  return join(cache, version);
}

try {
  const root = await packageRoot();
  const args = process.argv.slice(2);
  if (args[0] === '--hook') {
    // Preserve lifecycle/indexing hooks. Their JSON is not a tool result.
    const child = spawn(process.execPath, [join(root, 'hook.mjs'), ...args.slice(1)], { stdio: 'inherit' });
    child.once('error', error => { console.error(error.message); process.exitCode = 1; });
    child.once('exit', code => { process.exitCode = code ?? 1; });
  } else {
    // Shared .mcp.json is consumed by both providers. Select the adapter from
    // their actual MCP handshake rather than baking Claude into Codex sessions.
    const reader = createInterface({ input: process.stdin, crlfDelay: Infinity });
    const lines = reader[Symbol.asyncIterator]();
    const first = await lines.next();
    if (first.done) throw new Error('MCP client closed before initialization.');
    const hello = JSON.parse(first.value);
    const agent = /codex/i.test(hello.params?.clientInfo?.name ?? '') ? 'codex' : 'claude-code';
    const input = Readable.from((async function* () {
      yield first.value + '\n';
      for await (const line of lines) yield line + '\n';
    })());
    const serverArgs = args.includes('--agent') ? args : [...args, '--agent', agent];
    try {
      process.exitCode = await proxyMcp(process.execPath, [join(root, 'server.mjs'), ...serverArgs], { input });
    } finally {
      reader.close();
    }
  }
} catch (error) {
  console.error('Repository context-mode startup failed: ' + error.message);
  process.exitCode = 1;
}
