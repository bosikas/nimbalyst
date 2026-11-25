import { findOwnedBackendTool } from '../mcp/backendToolRegistry';
import { resolveBackendWorkspacePath } from '../mcp/mcpWorkspaceResolver';
import { handleBackendTool } from '../mcp/tools/backendToolHandler';

const extensionId = 'com.marius.workoverview';
const tool = 'workoverview.work_checkpoint';
type WorkCheckpoint = { sessionId: string; updatedAt: number; throughMessageId: number; remaining: string; updates: unknown[] };

/** The host supplies the exact saved summary and authenticated caller identity. */
export async function sendSummaryWork(workspacePath: string, checkpoint: WorkCheckpoint): Promise<string> {
  try {
    const workspace = await resolveBackendWorkspacePath(workspacePath);
    if (!findOwnedBackendTool(workspace, tool, extensionId)) return ' Work Overview is unavailable. Its summary fallback remains available.';
    const result = await handleBackendTool(tool, tool, checkpoint, workspace, { caller: 'panel', sessionId: null, extensionId });
    if (!result.isError) return ' Work Overview items recorded.';
    return ` Work Overview could not record these items. The summary is saved. ${result.content[0]?.text.split('\n').at(-1)?.slice(0, 180) ?? ''}`;
  } catch {
    return ' Work Overview could not record these items. The summary is saved.';
  }
}
