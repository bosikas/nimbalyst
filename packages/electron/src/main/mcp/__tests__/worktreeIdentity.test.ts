// @vitest-environment node
import { beforeEach, expect, it, vi } from 'vitest';

const fake = vi.hoisted(() => ({ getByPath: vi.fn() }));
vi.mock('electron', () => ({ BrowserWindow: { fromId: vi.fn(() => null) } }));
vi.mock('../../window/WindowManager', () => ({ findWindowByWorkspace: vi.fn(() => null) }));
vi.mock('../../database/initialize', () => ({ getDatabase: () => ({}) }));
vi.mock('../../services/WorktreeStore', () => ({ createWorktreeStore: () => ({ getByPath: fake.getByPath }) }));

import { registerExtensionTools, getActiveExtensionShortNames, getAvailableExtensionTools, getAvailableBackendTools, resolveBackendWorkspacePath } from '../mcpWorkspaceResolver';
import { registerBackendTools } from '../backendToolRegistry';
import { SessionManager } from '@nimbalyst/runtime/ai/server/SessionManager';
import { McpConfigService } from '@nimbalyst/runtime/ai/server/services/McpConfigService';
import type { SessionStore } from '@nimbalyst/runtime/ai/adapters/sessionStore';

beforeEach(() => {
  fake.getByPath.mockReset().mockImplementation(async (path: string) => path.endsWith('/wt') ? { projectPath: path.slice(0, -3) } : null);
});

function service() {
  return new McpConfigService({ mcpServerPort: 3000, extensionDevServerPort: null, mcpConfigLoader: null, claudeSettingsEnvLoader: null, shellEnvironmentLoader: null, extensionMcpServerNamesLoader: getActiveExtensionShortNames });
}

it('awaits cold worktree resolution before generating extension server configuration, then reuses the identity cache', async () => {
  const project = '/identity-renderer';
  registerExtensionTools(project, [{ name: 'diagram.read', description: '', inputSchema: { type: 'object', properties: {} }, extensionId: 'com.test.diagram', scope: 'global' }], new Map());
  const config = await service().getMcpServersConfig({ sessionId: 'cold', workspacePath: `${project}/wt` });
  expect(config['nimbalyst-diagram']?.url).toContain('/mcp/ext/diagram');
  expect(config['nimbalyst-diagram'].alwaysLoad).toBeFalsy();
  expect(new URL(config['nimbalyst-diagram'].url).searchParams.get('workspacePath')).toBe(`${project}/wt`);
  expect(await getAvailableExtensionTools(`${project}/wt`, undefined)).toHaveLength(1);
  expect(await getActiveExtensionShortNames(`${project}/wt`)).toEqual(['diagram']);
  expect(fake.getByPath.mock.calls.filter(([path]) => path === `${project}/wt`)).toHaveLength(1);
});

it('resolves backend-only tools and dispatch identity without a renderer registry entry', async () => {
  const project = '/identity-backend';
  registerBackendTools(project, 'com.test.backend', 'main', [{ name: 'read' }]);
  const config = await service().getMcpServersConfig({ sessionId: 'backend-cold', workspacePath: `${project}/wt` });
  expect(config['nimbalyst-backend']?.url).toContain('/mcp/ext/backend');
  expect(await getAvailableBackendTools(`${project}/wt`)).toHaveLength(1);
  expect(await resolveBackendWorkspacePath(`${project}/wt`)).toBe(project);
  expect(await getActiveExtensionShortNames(`${project}/wt`)).toEqual(['backend']);
  expect(fake.getByPath.mock.calls.filter(([path]) => path === `${project}/wt`)).toHaveLength(1);
});

it('never discovers another project’s tools and caches an authoritative non-worktree result', async () => {
  registerBackendTools('/identity-other', 'com.test.private', 'main', [{ name: 'read' }]);
  expect(await getAvailableBackendTools('/identity-empty/wt')).toEqual([]);
  expect(await getActiveExtensionShortNames('/identity-empty/wt')).toEqual([]);
  expect(await resolveBackendWorkspacePath('/identity-not-a-worktree')).toBe('/identity-not-a-worktree');
  expect(await resolveBackendWorkspacePath('/identity-not-a-worktree')).toBe('/identity-not-a-worktree');
  expect(fake.getByPath.mock.calls.filter(([path]) => path === '/identity-not-a-worktree')).toHaveLength(1);
});

it('retries transient identity lookup failures instead of caching them as a foreign or empty project', async () => {
  fake.getByPath.mockRejectedValueOnce(new Error('Database warming up'));
  expect(await resolveBackendWorkspacePath('/identity-retry/wt')).toBe('/identity-retry/wt');
  expect(await resolveBackendWorkspacePath('/identity-retry/wt')).toBe('/identity-retry');
});

function sessionManager(metadata: object = { tokenUsage: {} }) {
  const row = { id: 'stored', provider: 'openai-codex', messages: [], workspacePath: '/identity-project', worktreeId: 'worktree', worktreePath: '/identity-project/wt', worktreeProjectPath: '/identity-project', metadata };
  const manager = new SessionManager({ get: async () => row } as unknown as SessionStore);
  const transcript = vi.spyOn(manager as any, 'loadCanonicalTranscript').mockResolvedValue([]);
  return { manager, transcript };
}

it('reloads from a worktree while retaining persisted project identity, execution directory and permission scope', async () => {
  const { manager } = sessionManager();
  expect(await manager.loadSession('stored', '/identity-project/wt')).toMatchObject({ workspacePath: '/identity-project', worktreePath: '/identity-project/wt', worktreeProjectPath: '/identity-project' });
  expect((await manager.loadSession('stored', '/identity-project'))?.workspacePath).toBe('/identity-project');
});

it('prefers stored workspace ownership over stale metadata and still rejects foreign workspace loads', async () => {
  const { manager, transcript } = sessionManager({ tokenUsage: {}, workspaceId: '/stale-or-foreign' });
  expect((await manager.loadSession('stored', '/identity-project/wt'))?.workspacePath).toBe('/identity-project');
  transcript.mockClear();
  expect(await manager.loadSession('stored', '/identity-project-similar')).toBeNull();
  expect(await manager.loadSession('stored', '/stale-or-foreign')).toBeNull();
  expect(transcript).not.toHaveBeenCalled();
});
