import { beforeEach, describe, expect, it, vi } from 'vitest';
const state = vi.hoisted(() => ({ session: null as any, snapshot: null as any, recorded: null as any, reads: [] as any[] }));
vi.mock('@nimbalyst/runtime/storage/repositories/AISessionsRepository', () => ({ AISessionsRepository: { get: async () => state.session } }));
vi.mock('@nimbalyst/runtime/ai/server/providers/codex/codexContextInspection', () => ({ readCodexContext: () => state.snapshot, readCodexContextEvidence: () => ({ compactions: [], observedTools: [], omittedToolCalls: 0 }) }));
vi.mock('../codexRolloutStartup', () => ({ readCodexRecordedStartup: async (...args: any[]) => { state.reads.push(args); if (state.recorded instanceof Error) throw state.recorded; return state.recorded; } }));
vi.mock('../../utils/workspaceIdentity', () => ({ sameWorkspaceIdentity: (a: string, b: string) => a === b }));
vi.mock('../toolBudgetService', () => ({ getToolBudgetSnapshot: async () => ({ groups: [{ schemaBytes: 1234, estTokens: 300, inclusionReason: 'Configured discovery' }] }) }));
import { getSessionContextInspection } from '../sessionContextInspection';
beforeEach(() => {
  state.session = { workspacePath: '/project', metadata: JSON.stringify({ tokenUsage: { currentContext: { tokens: 7123, contextWindow: 100000 } } }) };
  state.snapshot = null;
  state.recorded = null;
  state.reads = [];
});
describe('context inspection boundary', () => {
  it('keeps recorded startup text out of the agent-facing provenance report', async () => {
    state.session = { ...state.session, provider: 'openai-codex', providerSessionId: 'native-thread' };
    state.recorded = { messages: [{ text: 'Private startup text' }] };

    const report = await getSessionContextInspection('s', '/project');

    expect(report.nativeUsage.value.currentContext.tokens).toBe(7123);
    expect(report).not.toHaveProperty('recordedStartup');
    expect(state.reads).toEqual([]);
  });

  it('keeps provider-reported values separate from estimates and labels unavailable native content', async () => {
    const report = await getSessionContextInspection('s', '/project');
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
    const inspectStartup = async () => (await getSessionContextInspection('s', '/project', { includeRecordedStartup: true })).recordedStartup;
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
