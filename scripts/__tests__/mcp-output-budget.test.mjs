import assert from 'node:assert/strict';
import { test, after } from 'node:test';
import { readFile, rm, stat, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { PassThrough } from 'node:stream';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { boundMcpResult, proxyMcp, MAX_RESULT_BYTES, MAX_RESULT_LINES } from '../mcp-output-budget.mjs';

const directories = [];
after(async () => { await Promise.all(directories.map(path => rm(path, { recursive: true, force: true }))); });
async function check(result) {
  const bounded = await boundMcpResult(result);
  assert.ok(Buffer.byteLength(JSON.stringify(bounded)) <= MAX_RESULT_BYTES);
  const text = bounded.content[0].text;
  assert.ok(text.split('\n').length <= MAX_RESULT_LINES);
  const file = text.match(/Full output saved to: ([^\n]+)/)?.[1];
  assert.ok(file);
  directories.push(dirname(file));
  assert.deepEqual(JSON.parse(await readFile(file, 'utf8')), result);
  assert.equal((await stat(file)).mode & 0o777, 0o600);
  return bounded;
}
test('hard limits cover huge lines, Unicode, JSON escaping and combined content blocks', async () => {
  for (const text of ['界'.repeat(10000), '\\\t"'.repeat(10000), 'line\n'.repeat(500)]) {
    await check({ content: [{ type: 'text', text }] });
  }
  await check({ content: Array.from({ length: 50 }, () => ({ type: 'text', text: 'line' })) });
});
test('small results pass unchanged; errors and complete structured evidence survive', async () => {
  const small = { content: [{ type: 'text', text: 'ok' }], isError: false };
  assert.equal(await boundMcpResult(small), small);
  const bounded = await check({ content: [{ type: 'text', text: 'failure\n'.repeat(100) }], isError: true });
  assert.equal(bounded.isError, true);
  await check({ content: [], structuredContent: { rows: Array(10000).fill('row') } });
});
test('stdio caps tool results and preserves discovery, response ids and small results', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'mcp-budget-test-'));
  directories.push(directory);
  const fixture = join(directory, 'server.mjs');
  await writeFile(fixture, [
    "import { createInterface } from 'node:readline';",
    "for await (const line of createInterface({input: process.stdin})) {",
    " const req = JSON.parse(line);",
    " if (req.params.name === 'collision') process.stdout.write(JSON.stringify({jsonrpc:'2.0', id:req.id, method:'ping', params:{}}) + '\\n');",
    " if (req.params.name === 'error') { process.stdout.write(JSON.stringify({jsonrpc:'2.0', id:req.id, error:{code:-32603,message:'error'.repeat(4000)}}) + '\\n'); continue; }",
    " const result = req.method === 'tools/list' ? { tools: [{ name: 'ctx_execute', description: 'schema'.repeat(3000) }] }",
    "  : { content: [{ type: 'text', text: ['big','collision'].includes(req.params.name) ? 'data\\n'.repeat(1000) : 'ok' }] };",
    " process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: req.id, result }) + '\\n');",
    "}",
  ].join('\n'));
  const input = new PassThrough(), output = new PassThrough();
  let captured = '';
  output.on('data', chunk => { captured += chunk; });
  const done = proxyMcp(process.execPath, [fixture], { input, output });
  for (const [id, method, name] of [[1, 'tools/list', ''], ['2', 'tools/call', 'big'], [3, 'tools/call', 'small'], [4, 'tools/call', 'collision'], [5, 'tools/call', 'error']]) {
    input.write(JSON.stringify({ jsonrpc: '2.0', id, method, params: { name } }) + '\n');
  }
  input.end();
  assert.equal(await done, 0);
  const responses = captured.trim().split('\n').map(line => JSON.parse(line));
  assert.deepEqual(responses.map(response => response.id), [1, '2', 3, 4, 4, 5]);
  assert.equal(responses[0].result.tools[0].description.length, 18000);
  assert.ok(Buffer.byteLength(JSON.stringify(responses[1].result)) <= MAX_RESULT_BYTES);
  directories.push(dirname(responses[1].result.content[0].text.match(/Full output saved to: ([^\n]+)/)[1]));
  assert.equal(responses[2].result.content[0].text, 'ok');
  assert.equal(responses[3].method, 'ping');
  assert.ok(responses[4].result.content[0].text.includes('Full output saved'));
  directories.push(dirname(responses[4].result.content[0].text.match(/Full output saved to: ([^\n]+)/)[1]));
  assert.equal(responses[5].error.code, -32603);
  assert.ok(Buffer.byteLength(JSON.stringify(responses[5].error)) <= MAX_RESULT_BYTES);
  directories.push(dirname(responses[5].error.message.match(/Full output saved to: ([^\n]+)/)[1]));
});
test('failed startup and early server exit terminate even if the client input stays open', { timeout: 3000 }, async () => {
  const input = new PassThrough(), output = new PassThrough();
  assert.equal(await proxyMcp(process.execPath, ['-e', 'process.exit(7)'], { input, output }), 7);
  await assert.rejects(proxyMcp('/definitely-missing-context-server', [], { input: new PassThrough(), output }), /ENOENT/);
});
test('repository launcher selects the client adapter and preserves lifecycle hook mode', { timeout: 5000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'mcp-launcher-test-'));
  directories.push(directory);
  const { mkdir } = await import('node:fs/promises');
  await mkdir(join(directory, 'plugins'));
  await writeFile(join(directory, 'plugins/installed_plugins.json'), JSON.stringify({
    plugins: { 'context-mode@context-mode': [{ installPath: directory }] },
  }));
  await writeFile(join(directory, 'server.mjs'), [
    "import {createInterface} from 'node:readline';",
    "for await (const line of createInterface({input:process.stdin})) {",
    " const req=JSON.parse(line);",
    " process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:req.id,result:{agent:process.argv.at(-1)}})+'\\n');",
    "}",
  ].join('\n'));
  await writeFile(join(directory, 'hook.mjs'), "process.stdout.write(JSON.stringify({mode:'hook',agent:process.argv.at(-1)}));");
  const entry = fileURLToPath(new URL('../context-mode-server.mjs', import.meta.url));
  const run = (args, input) => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [entry, ...args], {
      env: { ...process.env, CLAUDE_CONFIG_DIR: directory }, stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '', stderr = '';
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', code => code === 0 ? resolve(JSON.parse(stdout)) : reject(new Error(stderr)));
    child.stdin.end(input);
  });
  for (const [client, agent] of [['codex-mcp-client', 'codex'], ['claude-ai', 'claude-code']]) {
    const response = await run([], JSON.stringify({jsonrpc:'2.0',id:1,method:'initialize',params:{clientInfo:{name:client}}})+'\n');
    assert.equal(response.result.agent, agent);
  }
  assert.deepEqual(await run(['--hook', '--agent', 'claude-code'], '{}'), { mode: 'hook', agent: 'claude-code' });
});
