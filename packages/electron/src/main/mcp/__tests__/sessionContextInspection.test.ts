import { beforeEach, describe, expect, it, vi } from 'vitest';
const state = vi.hoisted(() => ({ session: null as any, snapshot: null as any }));
vi.mock('@nimbalyst/runtime/storage/repositories/AISessionsRepository', () => ({ AISessionsRepository: { get: async () => state.session } }));
vi.mock('@nimbalyst/runtime/ai/server/providers/codex/codexContextInspection', () => ({ readCodexContext: () => state.snapshot }));
vi.mock('../../utils/workspaceIdentity', () => ({ sameWorkspaceIdentity: (a: string, b: string) => a === b }));
vi.mock('../toolBudgetService', () => ({ getToolBudgetSnapshot: async () => ({ groups: [{ schemaBytes: 1234, estTokens: 300, inclusionReason: 'Configured discovery' }] }) }));
import { getSessionContextInspection } from '../sessionContextInspection';
beforeEach(() => {
  state.session = { workspacePath: '/project', metadata: JSON.stringify({ tokenUsage: { currentContext: { tokens: 7123, contextWindow: 100000 } } }) };
  state.snapshot = null;
});
describe('context inspection boundary', () => {
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
});
