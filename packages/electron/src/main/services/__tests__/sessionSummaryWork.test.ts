// @vitest-environment node
import { expect, it, vi } from 'vitest';
import { sendSummaryWork } from '../sessionSummaryWork';

const mocks = vi.hoisted(() => ({
  lookup: vi.fn(),
  resolve: vi.fn(),
  dispatch: vi.fn(),
}));
vi.mock('../../mcp/backendToolRegistry', () => ({ findOwnedBackendTool: mocks.lookup }));
vi.mock('../../mcp/mcpWorkspaceResolver', () => ({ resolveBackendWorkspacePath: mocks.resolve }));
vi.mock('../../mcp/tools/backendToolHandler', () => ({ handleBackendTool: mocks.dispatch }));

const checkpoint = { sessionId: 'session', updatedAt: 100, throughMessageId: 42, remaining: 'Check the rollout',
  updates: [{ action: 'put', key: 'rollout', text: 'Check the rollout' }] };

it('routes the saved checkpoint to the Work Overview module in the parent workspace', async () => {
  mocks.resolve.mockResolvedValue('/parent');
  mocks.lookup.mockReturnValueOnce({ method: 'work_checkpoint' });
  mocks.dispatch.mockResolvedValueOnce({ isError: false });
  expect(await sendSummaryWork('/parent-worktree', checkpoint)).toContain('items recorded');
  expect(mocks.lookup).toHaveBeenCalledWith('/parent', 'workoverview.work_checkpoint', 'com.marius.workoverview');
  expect(mocks.dispatch).toHaveBeenCalledWith('workoverview.work_checkpoint', 'workoverview.work_checkpoint', checkpoint, '/parent',
    { caller: 'panel', sessionId: null, extensionId: 'com.marius.workoverview' });
});

it('keeps the native summary available if the module is missing or rejects the work', async () => {
  mocks.resolve.mockResolvedValue('/parent');
  mocks.lookup.mockReturnValueOnce(undefined);
  expect(await sendSummaryWork('/parent', checkpoint)).toContain('fallback remains available');
  mocks.lookup.mockReturnValueOnce({ method: 'work_checkpoint' });
  mocks.dispatch.mockResolvedValueOnce({ isError: true, content: [{ text: 'Backend tool error\nUnknown item' }] });
  expect(await sendSummaryWork('/parent', checkpoint)).toContain('The summary is saved. Unknown item');
});
