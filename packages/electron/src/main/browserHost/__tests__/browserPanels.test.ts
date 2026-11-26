// @vitest-environment node
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { callBrowserPanelTool, listBrowserExtensions, readBrowserPanelAssets } from '../browserPanels';

const { listManifests, enabled, ownedTool, dispatch } = vi.hoisted(() => ({
  listManifests: vi.fn(),
  enabled: vi.fn(),
  ownedTool: vi.fn(),
  dispatch: vi.fn(),
}));
vi.mock('../../services/extensionInventory', () => ({ scanInstalledExtensionManifests: listManifests }));
vi.mock('../../utils/store', () => ({ getExtensionEnabled: enabled }));
vi.mock('../../mcp/backendToolRegistry', () => ({ findOwnedBackendTool: ownedTool }));
vi.mock('../../mcp/mcpWorkspaceResolver', () => ({ resolveBackendWorkspacePath: vi.fn((path) => path) }));
vi.mock('../../mcp/tools/backendToolHandler', () => ({ handleBackendTool: dispatch }));

let root: string;
let extensionPath: string;

beforeEach(async () => {
  vi.resetAllMocks();
  root = await mkdtemp(join(tmpdir(), 'browser-panels-test-'));
  extensionPath = join(root, 'extension');
  await mkdir(extensionPath);
  listManifests.mockReturnValue([{
    id: 'example.extension',
    extensionPath,
    manifest: { main: 'panel.js', contributions: { panels: [{ id: 'panel' }] } },
  }]);
  enabled.mockReturnValue(true);
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

it('advertises embedded session components only to extensions with AI permission', async () => {
  const manifest = { main: 'panel.js', contributions: { panels: [{ id: 'panel', title: 'Panel', icon: 'extension' }] } };
  listManifests.mockReturnValue([
    { id: 'read-only', manifest },
    { id: 'with-ai', manifest: { ...manifest, permissions: { ai: true } } },
  ]);
  const [readOnly, withAi] = await listBrowserExtensions();
  expect(readOnly.panels?.[0]?.sessionAccess).toBe(false);
  expect(withAi.panels?.[0]?.sessionAccess).toBe(true);
});

it('serves only enabled extension bundles and blocks asset symlinks outside the bundle', async () => {
  const path = join(extensionPath, 'panel.js');
  await writeFile(path, 'export const panels = {};');
  expect(await readBrowserPanelAssets('example.extension')).toEqual({ source: 'export const panels = {};', css: '' });
  enabled.mockReturnValueOnce(false);
  expect(await readBrowserPanelAssets('example.extension')).toBeNull();
  await rm(path);
  const outside = join(root, 'outside.js');
  await writeFile(outside, 'must not serve this');
  await symlink(outside, path);
  expect(await readBrowserPanelAssets('example.extension')).toBeNull();
});

it('calls only a tool owned by an enabled extension in the configured workspace', async () => {
  ownedTool.mockReturnValueOnce(undefined).mockReturnValueOnce({});
  await expect(callBrowserPanelTool('/workspace', 'example.extension', 'other.tool', {})).rejects.toThrow('unavailable');
  expect(dispatch).not.toHaveBeenCalled();
  dispatch.mockResolvedValueOnce({ content: [{ text: '{"active":true}' }] });
  await expect(callBrowserPanelTool('/workspace', 'example.extension', 'example.status', {})).resolves.toEqual({ active: true });
  expect(ownedTool).toHaveBeenLastCalledWith('/workspace', 'example.status', 'example.extension');
  expect(dispatch).toHaveBeenCalledWith('example.status', 'example.status', {}, '/workspace', {
    sessionId: null, caller: 'panel', extensionId: 'example.extension',
  });
});
