// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest';
const state = vi.hoisted(() => ({ session: null as any, snapshot: null as any, recorded: null as any, reads: [] as any[] }));
vi.mock('@nimbalyst/runtime/storage/repositories/AISessionsRepository', () => ({ AISessionsRepository: { get: async () => state.session } }));
vi.mock('@nimbalyst/runtime/ai/server/providers/codex/codexContextInspection', () => ({ readCodexContext: () => state.snapshot, readCodexContextEvidence: () => ({ compactions: [], observedTools: [], omittedToolCalls: 0 }) }));
vi.mock('../codexRolloutStartup', () => ({ readCodexRecordedStartup: async (...args: any[]) => { state.reads.push(args); if (state.recorded instanceof Error) throw state.recorded; return state.recorded; } }));
vi.mock('../../utils/workspaceIdentity', () => ({ sameWorkspaceIdentity: (a: string, b: string) => a === b }));
vi.mock('../toolBudgetService', () => ({ getToolBudgetSnapshot: async () => ({ groups: [{ schemaBytes: 1234, estTokens: 300, inclusionReason: 'Configured discovery' }] }) }));
import { getSessionContextInspection } from '../sessionContextInspection';
import { captureClaudeContextReport } from '../claudeContextReport';
import { recordVibePreparedContext } from '@nimbalyst/runtime/ai/server/providers/vibeContextInspection';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { gzipSync } from 'node:zlib';
beforeEach(() => {
  state.session = { workspacePath: '/project', metadata: JSON.stringify({ tokenUsage: { currentContext: { tokens: 7123, contextWindow: 100000 } } }) };
  state.snapshot = null;
  state.recorded = null;
  state.reads = [];
});
describe('context inspection boundary', () => {
  it.each(['plain', 'gzip', 'inline'])('returns Vibe context and scopes recorded text to the inspector (%s checkpoint)', async (format) => {
    const providerSessionId = 'c9187458-2f50-619d-9659-3e378bc79028';
    state.session = { ...state.session, provider: 'mistral-vibe', providerSessionId };
    const vibeHome = mkdtempSync(join(tmpdir(), 'vibe-context-'));
    vi.stubEnv('VIBE_HOME', vibeHome);
    recordVibePreparedContext({ id: providerSessionId, platform: 'mistral-vibe-acp', deliveredMcpServerCount: 2 },
      { sessionId: 'vibe', content: 'Latest prompt' }, 'Private prompt instructions', 1);
    try {
      const directory = join(vibeHome, 'logs', 'session', 'unified', providerSessionId);
      mkdirSync(directory, { recursive: true });
      writeFileSync(join(directory, 'context-breakdown.json'), JSON.stringify({
        system: 1200, tools: 34, skills: 0, conversation: 8100, unrelated: 'ignored',
      }));
      const generation = join(directory, 'generations', '0000000000000187');
      const chunks = join(directory, 'chunks');
      mkdirSync(generation, { recursive: true });
      mkdirSync(chunks, { recursive: true });
      const digest = 'a'.repeat(64);
      writeFileSync(join(generation, 'manifest.json'), JSON.stringify({
        session_id: providerSessionId, checkpoint: format === 'inline' ? { path: 'checkpoint.json' } : { chunks: [digest] },
      }));
      writeFileSync(join(generation, 'runtime-state.json'), JSON.stringify({
        session_id: providerSessionId, core_system_instructions: 'Vibe defaults\nAGENTS.md: keep é as written.',
      }));
      const messages = [
        { turn_index: 0, source: 'instructions', message: { role: 'developer',
          content: [{ type: 'text', text: 'Recorded project instructions\n' }] } },
        { turn_index: 0, source: 'history', message: { role: 'user', content: [
          { type: 'text', text: 'Find easy GP tasks' },
          { type: 'resource', resource: { uri: 'nimbalyst://system-instructions', text: 'Original Nimbalyst instructions\n' } },
        ] } },
        { turn_index: 1, source: 'history', message: { role: 'user',
          content: [{ type: 'text', text: 'Later prompt' }] } },
      ];
      if (format === 'inline') {
        writeFileSync(join(generation, 'checkpoint.json'), JSON.stringify({ context: { messages } }));
      } else if (format === 'gzip') {
        writeFileSync(join(chunks, digest + '.json.gz'), gzipSync(JSON.stringify(messages)));
      } else {
        writeFileSync(join(chunks, digest + '.json'), JSON.stringify(messages));
      }
      const local = await getSessionContextInspection('vibe', '/project', { audience: 'desktop' });
      expect(local).toMatchObject({
        nativeUsage: { value: { currentContext: { tokens: 7123 } } },
        preparedRequest: {
          categories: [{ name: 'Nimbalyst guidance', bytes: 27 }, { name: 'User input and document additions', bytes: 13 }],
          configuredMcpServers: 2,
          attachments: 1,
        },
        vibe: {
          groups: [
            { name: 'System instructions', characters: 1200 },
            { name: 'Tool definitions', characters: 34 },
            { name: 'Skills', characters: 0 },
            { name: 'Conversation', characters: 8100 },
          ],
          instructions: 'Private prompt instructions',
        },
        recordedStartup: { report: {
          provider: 'mistral-vibe',
          boundaryLine: 2,
          messages: [
            { role: 'developer', text: 'Recorded project instructions\n' },
            { role: 'user', text: 'Find easy GP tasks\nOriginal Nimbalyst instructions\n',
              kinds: ['user.text', 'Nimbalyst instructions (ACP resource)'] },
          ],
          snapshots: [{ name: 'Saved Vibe system instructions', text: 'Vibe defaults\nAGENTS.md: keep é as written.' }],
        } },
      });
      await expect(getSessionContextInspection('vibe', '/project', { audience: 'browser' })).resolves.toEqual(local);
      const agentReport = await getSessionContextInspection('vibe', '/project');
      expect(agentReport).not.toHaveProperty('recordedStartup');
      expect(JSON.stringify(agentReport)).not.toContain('Private prompt instructions');
      await expect(getSessionContextInspection('vibe', '/other')).rejects.toThrow('not in this workspace');
    } finally {
      vi.unstubAllEnvs();
      rmSync(vibeHome, { recursive: true, force: true });
    }
  });

  it('keeps recorded startup text out of the agent-facing provenance report', async () => {
    state.session = { ...state.session, provider: 'openai-codex', providerSessionId: 'native-thread' };
    state.recorded = { messages: [{ text: 'Private startup text' }] };

    const report = (await getSessionContextInspection('s', '/project')) as any;

    expect(report.nativeUsage.value.currentContext.tokens).toBe(7123);
    expect(report).not.toHaveProperty('recordedStartup');
    expect(state.reads).toEqual([]);
  });

  it('keeps provider-reported values separate from estimates and labels unavailable native content', async () => {
    const report = (await getSessionContextInspection('s', '/project')) as any;
    expect(report.nativeUsage.value.currentContext.tokens).toBe(7123);
    expect(report.preparedRequest).toBeNull();
    expect(report.unavailable).toContain('unavailable');
    expect(report.toolDefinitions.groups[0].schemaBytes).toBe(1234);
    expect(report).not.toHaveProperty('nativeTokenCategories');
  });
  it('rejects sessions outside the active workspace before returning diagnostics', async () => {
    await expect(getSessionContextInspection('s', '/other')).rejects.toThrow(/workspace/);
  });
  it('reads recorded native startup only for a Codex thread and reports a missing rollout honestly', async () => {
    const inspectStartup = async () => ((await getSessionContextInspection('s', '/project', { audience: 'desktop' })) as any).recordedStartup;
    expect(await inspectStartup()).toEqual({ report: null, status: expect.stringContaining('Not a Codex session') });
    state.session = { ...state.session, provider: 'openai-codex', providerSessionId: 'thread-1' };
    expect(await inspectStartup()).toEqual({ report: null, status: expect.stringContaining('No local Codex rollout') });
    state.recorded = { messages: [], snapshots: [], boundaryLine: 3 };
    expect((await inspectStartup())?.report).toBe(state.recorded);
    expect(state.reads.at(-1)?.[0]).toBe('thread-1');
    state.recorded = new Error('Startup prefix exceeds 4 MB');
    expect(await inspectStartup()).toEqual({ report: null, status: expect.stringContaining('exceeds 4 MB') });
  });
});

const claude = vi.hoisted(() => ({ rows: {} as Record<string, any>, live: undefined as any, userData: '' }));
vi.mock('electron', () => ({ app: { getPath: () => claude.userData } }));
vi.mock('../../database/initialize', () => ({
  getDatabase: () => ({
    query: async (sql: string) => {
      const kind = sql.includes('"prompt"') ? 'request' : sql.includes('"subtype":"init"') ? 'startup' : 'report';
      return { rows: claude.rows[kind] ? [claude.rows[kind]] : [] };
    },
  }),
}));
vi.mock('@nimbalyst/runtime/ai/server/ProviderFactory', () => ({
  ProviderFactory: { getProvider: () => claude.live === undefined ? undefined : { getLiveContextUsage: async () => claude.live } },
}));

const contextReport = (memoryPath: string) => ({
  categories: [{ name: 'Memory files', tokens: 900, kind: 'used' }],
  totalTokens: 50000, maxTokens: 1000000, model: 'claude-opus', gridRows: [[{ color: 'blue', isFilled: true }]],
  memoryFiles: [{ path: memoryPath, type: 'Project', tokens: 900 }],
  mcpTools: [{ name: 'tracker_list', serverName: 'trackers', tokens: 300, isLoaded: false }],
  systemPromptSections: [{ name: 'Tool guidance', tokens: 100 }, { name: 'Environment', tokens: 400 }],
  agents: [], isAutoCompactEnabled: true, autoCompactThreshold: 800000,
  apiUsage: { input_tokens: 10, output_tokens: 20, cache_creation_input_tokens: 30, cache_read_input_tokens: 40 },
});

describe('Claude context inspection', () => {
  beforeEach(() => {
    claude.userData = mkdtempSync(join(tmpdir(), 'ctx-inspect-'));
    state.session = { ...state.session, provider: 'claude-code' };
    claude.live = undefined;
    claude.rows = {
      request: {
        content: JSON.stringify({ prompt: 'Fix it\n<active-document>a.md</active-document>', options: {
          model: 'claude-opus', permissionMode: 'default', settingSources: ['user', 'project', 'local'], mcpServers: ['nimbalyst'],
          systemPrompt: { type: 'preset', preset: 'claude_code', append: '<scope>Workspace guidance</scope>' },
        } }),
        // SQLite returns metadata as a string; PGLite as an object.
        metadata: JSON.stringify({ attachments: [{ filename: 'shot.png', data: 'base64' }] }),
        created_at: '2026-11-19T20:00:00.000Z',
      },
      startup: {
        content: JSON.stringify({ type: 'system', subtype: 'init', model: 'claude-opus', tools: ['Read', 'Bash'], output_style: 'default', apiKeySource: 'none',
          mcp_servers: [{ name: 'nimbalyst', status: 'connected' }], plugins: [{ name: 'dev-kit', path: '/plugins/dev-kit' }], skills: ['commit'], slash_commands: ['commit'] }),
        created_at: new Date('2026-11-19T19:00:00.000Z'),
      },
      report: { content: JSON.stringify({ type: 'assistant', context_usage: contextReport('/p/CLAUDE.md') }), created_at: '2026-11-19T20:01:00.000Z' },
    };
  });

  it('reads the last request, startup frame and stored /context report, keeping raw text out of the agent-facing report', async () => {
    const agentFacing = (await getSessionContextInspection('s', '/project')) as any;
    expect(agentFacing.claude.lastRequest).not.toHaveProperty('prompt');
    expect(agentFacing.claude.lastRequest).not.toHaveProperty('systemPromptAppend');
    expect(JSON.stringify(agentFacing)).not.toContain('Workspace guidance');
    expect(agentFacing.claude.lastRequest.attachments).toEqual(['shot.png']);
    expect(agentFacing.claude.lastRequest.settingSources).toEqual(['user', 'project', 'local']);
    expect(agentFacing.claude.startup.tools).toEqual(['Read', 'Bash']);
    expect(agentFacing.claude.startup.recordedAt).toBe('2026-11-19T19:00:00.000Z');
    expect(agentFacing.claude.startup.plugins).toEqual([{ name: 'dev-kit', path: '/plugins/dev-kit' }]);
    expect(agentFacing.claude.contextReport.source).toBe('stored');
    expect(agentFacing.claude.contextReport.memoryFiles).toEqual([{ path: '/p/CLAUDE.md', type: 'Project', tokens: 900 }]);
    expect(agentFacing.claude.contextReport.mcpTools[0].isLoaded).toBe(false);
    expect(agentFacing.claude.contextReport.systemPromptSections.map((s: any) => s.name)).toEqual(['Environment', 'Tool guidance']);
    expect(agentFacing.claude.contextReport.apiUsage).toEqual({ inputTokens: 10, outputTokens: 20, cacheCreationInputTokens: 30, cacheReadInputTokens: 40 });
    expect(agentFacing).not.toHaveProperty('preparedRequest');

    const local = (await getSessionContextInspection('s', '/project', { audience: 'desktop' })) as any;
    expect(local.claude.lastRequest.systemPromptAppend).toBe('<scope>Workspace guidance</scope>');
    expect(local.claude.lastRequest.prompt).toContain('<active-document>a.md</active-document>');
  });

  it('prefers a live report from a running provider and falls back to the stored one when the live call has nothing', async () => {
    claude.live = contextReport('/live/CLAUDE.md');
    let report = (await getSessionContextInspection('s', '/project')) as any;
    expect(report.claude.contextReport.source).toBe('live');
    expect(report.claude.contextReport.memoryFiles[0].path).toBe('/live/CLAUDE.md');

    claude.live = null;
    report = (await getSessionContextInspection('s', '/project')) as any;
    expect(report.claude.contextReport.source).toBe('stored');
    expect(report.claude.contextReport.memoryFiles[0].path).toBe('/p/CLAUDE.md');
  });

  it('records the breakdown after a turn so it survives the Claude process ending', async () => {
    const running = { getLiveContextUsage: async () => contextReport('/turn/CLAUDE.md') };
    expect(await captureClaudeContextReport('s', running)).toBe(true);

    // The process is gone (app restarted): the recorded report wins over the older /context row.
    const report = (await getSessionContextInspection('s', '/project')) as any;
    expect(report.claude.contextReport.source).toBe('stored');
    expect(report.claude.contextReport.memoryFiles[0].path).toBe('/turn/CLAUDE.md');
    expect(report.claude.contextReport).not.toHaveProperty('gridRows');
  });

  it('records nothing when no live breakdown is available, and refuses path-like session ids', async () => {
    expect(await captureClaudeContextReport('s', { getLiveContextUsage: async () => null })).toBe(false);
    expect(await captureClaudeContextReport('s', undefined)).toBe(false);
    expect(existsSync(join(claude.userData, 'context-reports', 's.json'))).toBe(false);
    expect(await captureClaudeContextReport('../escape', { getLiveContextUsage: async () => contextReport('/x') })).toBe(false);
    expect(existsSync(join(claude.userData, 'escape.json'))).toBe(false);
  });

  it('reports nothing rather than guessing when a session has no recorded Claude rows', async () => {
    claude.rows = {};
    const report = (await getSessionContextInspection('s', '/project')) as any;
    expect(report.claude).toEqual({ lastRequest: null, startup: null, contextReport: null, liveError: null });
  });
});
