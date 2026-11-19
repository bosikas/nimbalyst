import { expect, test, type Page } from '@playwright/test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { execFileSync } from 'node:child_process';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { launchElectronApp } from '../helpers';
import { isolatedCodexHome } from '../../../runtime/src/ai/server/providers/codex/codexSessionHome';

test.skip(!process.env.RUN_REAL_CODEX, 'Requires an authenticated Codex installation');
test.setTimeout(480_000);

const globalMarker = 'GLOBAL-INSTRUCTION-41e2';
const repoMarker = 'REPOSITORY-INSTRUCTION-d904';
const profileMarker = 'REVIEW-PROFILE-683f';

const invoke = (page: Page, channel: string, ...args: unknown[]) =>
  page.evaluate(({ channel, args }) => (window as any).electronAPI.invoke(channel, ...args), { channel, args });

test('normal, preset and restarted reviewer receive the intended native startup', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'nim-review-startup-'));
  const workspace = path.join(root, 'aifredas');
  const home = path.join(root, 'codex');
  const userData = path.join(root, 'user-data');
  const database = path.join(root, 'database');
  const model = 'openai-codex:' + (process.env.NIMBALYST_TEST_CODEX_MODEL || 'gpt-6.2-sol');
  // Capture the actual Responses input and return a single controlled shell
  // action. Authentication is checked separately through the real app service.
  const requests: Array<{ input: unknown[]; tools: unknown[] }> = [];
  let requestedRead = false;
  const endpoint = createServer(async (req, res) => {
    if (!req.url?.endsWith('/responses')) {
      res.writeHead(404).end();
      return;
    }
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(Buffer.from(chunk));
    const request = JSON.parse(Buffer.concat(chunks).toString());
    requests.push(request);
    const reviewer = JSON.stringify(request.input).includes(profileMarker);
    const id = 'fixture-' + requests.length;
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    const event = (type: string, data: object) => res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`);
    event('response.created', { response: { id, status: 'in_progress', output: [] } });
    if (reviewer && !requestedRead) {
      requestedRead = true;
      // Select the declared native tool form for this model.
      const definitions = [request.tools, ...request.input.map((item: { tools?: unknown }) => item.tools)];
      const codeMode = JSON.stringify(definitions).includes('"name":"exec"');
      const item = codeMode
        ? { type: 'custom_tool_call', name: 'exec', namespace: 'functions', input: 'text(await tools.exec_command({cmd:"cat proof.txt"}))', call_id: 'controlled-read' }
        : { type: 'function_call', name: 'exec_command', arguments: JSON.stringify({ cmd: 'cat proof.txt' }), call_id: 'controlled-read' };
      event('response.output_item.done', { output_index: 0, item });
    } else {
      event('response.output_item.done', { output_index: 0, item: { type: 'message', id, role: 'assistant', status: 'completed',
        content: [{ type: 'output_text', text: reviewer ? 'Review complete.' : 'Ready.' }] } });
    }
    const inputTokens = reviewer ? 200 : 100;
    event('response.completed', { response: { id, status: 'completed', usage: { input_tokens: inputTokens, output_tokens: 5, total_tokens: inputTokens + 5 } } });
    res.end();
  });
  let app: Awaited<ReturnType<typeof launchElectronApp>> | undefined;
  const shellHooks = new Set<string>();
  async function openApp() {
    app = await launchElectronApp({ mainPath: path.join(root, 'main.cjs'), workspace,
      preserveTestDatabase: true, permissionMode: 'allow-all', recordVideo: false,
      env: { CODEX_HOME: home, NIMBALYST_USER_DATA_PATH: database, NIMBALYST_USER_DATA_DIR: userData,
        NIMBALYST_CDP_PORT: '0', NIMBALYST_SHELL_HOOK_TRACE: '1' } });
    for (const stream of [app.process().stdout, app.process().stderr]) {
      let pending = '';
      stream?.on('data', chunk => {
        const lines = (pending + chunk).split('\n');
        pending = lines.pop() || '';
        for (const line of lines) {
          const match = line.match(/\[CodexShellTracking\] Hook (\{.*\})/);
          if (!match) continue;
          const hook = JSON.parse(match[1]);
          if (hook.tool === 'Bash' && hook.event === 'PreToolUse') shellHooks.add(hook.sessionId);
        }
      });
    }
    const page = await app.firstWindow({ timeout: 45_000 });
    await page.waitForFunction(() => typeof (window as any).electronAPI?.invoke === 'function');
    return page;
  }
  async function rollout(page: Page, session: string) {
    const row = await invoke(page, 'test:query-db', 'SELECT provider_session_id FROM ai_sessions WHERE id=$1', [session]);
    const id = row.rows[0]?.provider_session_id;
    if (!id) return;
    const dir = path.join(home, 'sessions');
    const name = (await fs.readdir(dir, { recursive: true })).find(file => file.endsWith(id + '.jsonl'));
    if (!name) return;
    const records = (await fs.readFile(path.join(dir, name), 'utf8')).trim().split('\n').map(line => JSON.parse(line));
    const messages = records.filter(r => r.type === 'response_item' && r.payload.type === 'message')
      .flatMap(r => r.payload.content.map((p: { text?: string }) => p.text || '')).join('\n');
    return { id, file: path.join(dir, name), messages, records };
  }
  try {
    await new Promise<void>((resolve, reject) => endpoint.once('error', reject).listen(0, '127.0.0.1', resolve));
    for (const dir of [workspace, home, database, userData]) await fs.mkdir(dir, { mode: 0o700 });
    await fs.writeFile(path.join(userData, 'logger-config.json'), JSON.stringify({ loggerConfig: {
      globalLevel: 'debug', consoleLogging: true, components: { MAIN: { enabled: true, level: 'debug' } },
    } }));
    const configuredHome = process.env.CODEX_HOME || path.join(os.homedir(), '.codex');
    await fs.symlink(path.join(configuredHome, 'auth.json'), path.join(home, 'auth.json'));
    execFileSync('git', ['init', '-q', workspace]);
    const port = (endpoint.address() as AddressInfo).port;
    const catalogFile = path.join(root, 'models.json');
    const cache = JSON.parse(await fs.readFile(path.join(configuredHome, 'models_cache.json'), 'utf8'));
    const selected = cache.models.find((m: { slug: string }) => m.slug === model.split(':')[1]);
    expect(selected, 'The native catalog must contain the model under test').toBeTruthy();
    await fs.writeFile(catalogFile, JSON.stringify({ models: [selected] }));
    const fixtureConfig = `model_provider="fixture"
model_catalog_json=${JSON.stringify(catalogFile)}
[model_providers.fixture]
name="Local verification fixture"
base_url="http://127.0.0.1:${port}/v1"
wire_api="responses"
requires_openai_auth=true
request_max_retries=0
stream_max_retries=0
[projects.${JSON.stringify(await fs.realpath(workspace))}]
trust_level="trusted"
`;
    await fs.writeFile(path.join(home, 'AGENTS.md'), globalMarker);
    const unrelated = path.join(home, 'skills', 'unrelated-test-skill');
    await fs.mkdir(unrelated, { recursive: true });
    await fs.writeFile(path.join(unrelated, 'SKILL.md'), '---\nname: unrelated-test-skill\ndescription: Unrelated skill description 98db.\n---\nFixture.');
    const reference = process.env.NIMBALYST_TEST_AIFREDAS_WORKSPACE;
    const repoInstructions = reference ? await fs.readFile(path.join(reference, 'AGENTS.md'), 'utf8') : '';
    const reviewerInstructions = reference ? await fs.readFile(path.join(reference, '.claude/agents/pr-reviewer.md'), 'utf8') : 'Review read-only.';
    await fs.writeFile(path.join(workspace, 'AGENTS.md'), repoMarker + '\n' + repoInstructions);
    await fs.writeFile(path.join(workspace, 'reviewer.md'), profileMarker + '\n' + reviewerInstructions);
    await fs.writeFile(path.join(workspace, 'proof.txt'), 'HOOK-PROOF-e127');
    await fs.mkdir(path.join(workspace, '.nimbalyst'));
    await fs.writeFile(path.join(workspace, '.nimbalyst/codex.json'), '{"nativeMultiAgent":false}');
    await fs.writeFile(path.join(workspace, '.nimbalyst/pr-review.json'), JSON.stringify({ model, effortLevel: 'medium',
      instructionFile: 'reviewer.md', permissions: 'read-only', generateSummary: false, autoArchiveAfterMinutes: 10, startupSkills: ['pr-review'] }));
    const main = process.env.NIMBALYST_E2E_MAIN_PATH || path.resolve(__dirname, '../../out/main/index.js');
    await fs.writeFile(path.join(root, 'main.cjs'), `const {app}=require('electron');app.setPath('userData',${JSON.stringify(userData)});app.setAppPath(${JSON.stringify(path.resolve(__dirname, '../..'))});require(${JSON.stringify(main)});`);
    let page = await openApp();
    await invoke(page, 'ai:saveSettings', { providerSettings: { 'openai-codex': { enabled: true } } });
    await expect.poll(async () => (await invoke(page, 'openai-codex:check-login')).isLoggedIn, { timeout: 30_000 }).toBe(true);
    execFileSync('codex', ['login', 'status'], { env: { ...process.env, CODEX_HOME: await isolatedCodexHome(home) }, stdio: 'pipe' });
    // Only the login checks use the real account. Never send its credentials
    // to the loopback endpoint. Replace the fixture's link, not its target.
    await fs.unlink(path.join(home, 'auth.json'));
    await fs.writeFile(path.join(home, 'auth.json'), JSON.stringify({ OPENAI_API_KEY: 'fixture-only' }), { flag: 'wx', mode: 0o600 });
    await fs.writeFile(path.join(home, 'config.toml'), fixtureConfig);
    const parent = await invoke(page, 'ai:createSession', 'openai-codex', undefined, workspace, model, 'agent');
    await invoke(page, 'ai:sendMessage', 'Reply READY.', undefined, parent.id, workspace);
    const ordinary = await rollout(page, parent.id);
    expect(ordinary?.messages).toContain(globalMarker);
    expect(ordinary?.messages).toContain(repoMarker);
    expect(ordinary?.messages).not.toContain(profileMarker);
    expect(JSON.stringify(requests[0].input)).toContain('Unrelated skill description 98db.');
    expect(ordinary?.messages).not.toContain('<multi_agent_role>');
    await fs.writeFile(path.join(home, 'AGENTS.override.md'), 'GLOBAL-OVERRIDE-ba47');

    const { port: mcpPort } = await invoke(page, 'mcp:get-server-port');
    const { token } = await invoke(page, 'mcp:get-auth-token');
    const url = new URL('/mcp/host', `http://127.0.0.1:${mcpPort}`);
    url.search = new URLSearchParams({ workspacePath: workspace, sessionId: parent.id }).toString();
    const client = new Client({ name: 'review-startup-test', version: '1' });
    let child: string;
    const testEnvironment = await app!.evaluate(() => ({
      PLAYWRIGHT: process.env.PLAYWRIGHT, PLAYWRIGHT_TEST: process.env.PLAYWRIGHT_TEST, NODE_ENV: process.env.NODE_ENV,
    }));
    try {
      // Playwright normally stores a synthetic child input without starting
      // the provider. Exercise the production queue after test IPC registration.
      await app!.evaluate(() => { delete process.env.PLAYWRIGHT; delete process.env.PLAYWRIGHT_TEST; process.env.NODE_ENV = 'development'; });
      await client.connect(new StreamableHTTPClientTransport(url, { requestInit: { headers: { Authorization: `Bearer ${token}` } } }));
      const lookup = await client.callTool({ name: 'search_codex_skills', arguments: { query: 'unrelated-test-skill' } });
      expect(JSON.stringify(lookup.content)).toContain('Unrelated skill description 98db.');
      const result = await client.callTool({ name: 'spawn_session', arguments: {
        prReview: 'Review this fixture. Run exactly cat proof.txt with the shell and report its contents. No edits.',
      } });
      expect(result.isError).toBeFalsy();
      child = JSON.parse((result.content as { text: string }[])[0].text).sessionId;
    } finally {
      await app!.evaluate((_, env) => {
        for (const [key, value] of Object.entries(env)) {
          if (value === undefined) delete process.env[key];
          else process.env[key] = value;
        }
      }, testEnvironment);
      await client.close();
    }
    await expect.poll(() => JSON.stringify(requests).includes('HOOK-PROOF-e127'), { timeout: 90_000 }).toBe(true);
    const reviewer = (await rollout(page, child))!;
    for (const marker of [globalMarker, repoMarker, 'GLOBAL-OVERRIDE-ba47', 'call update_session_summary', 'Identify your actual AI model']) expect(reviewer.messages).not.toContain(marker);
    expect(reviewer.messages).toContain(profileMarker);
    expect(reviewer.messages).not.toContain('<multi_agent_role>');
    expect(reviewer.messages).toContain('Review skills: pr-review');
    expect(reviewer.messages).not.toContain('Unrelated skill description 98db.');
    expect(reviewer.records.some(r => r.type === 'turn_context' && r.payload.approval_policy === 'never'
      && r.payload.sandbox_policy?.type === 'read-only')).toBe(true);
    expect(reviewer.records.some(r => r.type === 'event_msg' && r.payload.type === 'token_count' && r.payload.info)).toBe(true);
    expect(shellHooks.has(child)).toBe(true);
    await app!.close();
    app = undefined;
    page = await openApp();
    await invoke(page, 'ai:sendMessage', 'Reply RESUMED.', undefined, child, workspace);
    const resumed = (await rollout(page, child))!;
    expect(resumed.id).toBe(reviewer.id);
    expect(resumed.messages).toContain('RESUMED');
    expect(resumed.messages).toContain(profileMarker);
    expect(resumed.messages).not.toContain(globalMarker);
    expect(resumed.messages).not.toContain(repoMarker);
    expect(resumed.messages).not.toContain('GLOBAL-OVERRIDE-ba47');
    const resumedInput = requests.map(request => JSON.stringify(request.input)).find(input => input.includes('Reply RESUMED.'));
    expect(resumedInput).toContain(profileMarker);
    expect(resumedInput).not.toContain(repoMarker);
    // Usage reports the latest active rollout. The parent's completion inbox
    // can write last, so select the reviewer deterministically in this fixture.
    const latest = new Date(Date.now() + 60_000);
    await fs.utimes(resumed.file, latest, latest);
    await expect.poll(async () => (await invoke(page, 'codex-usage:refresh')).tokenUsage?.lastTokens,
      { timeout: 30_000, message: 'Usage reporting must read the reviewer’s distinctive token count' }).toBe(205);
  } finally {
    await app?.close();
    endpoint.closeAllConnections();
    endpoint.close();
    await fs.rm(root, { recursive: true, force: true });
  }
});
