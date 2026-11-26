import { constants } from 'node:fs';
import { open, realpath } from 'node:fs/promises';
import { extname, isAbsolute, relative, resolve, sep } from 'node:path';
import { scanInstalledExtensionManifests } from '../services/extensionInventory';
import { getExtensionEnabled } from '../utils/store';
import { findOwnedBackendTool } from '../mcp/backendToolRegistry';
import { resolveBackendWorkspacePath } from '../mcp/mcpWorkspaceResolver';
import { handleBackendTool } from '../mcp/tools/backendToolHandler';
import type { BrowserHostExtension } from '../../shared/browserHost';

export async function listBrowserExtensions(): Promise<BrowserHostExtension[]> {
  const extensions: BrowserHostExtension[] = [];
  for await (const { id, manifest } of scanInstalledExtensionManifests()) {
    const enabled = getExtensionEnabled(id);
    const panels = enabled && manifest.main && Array.isArray(manifest.contributions?.panels)
      ? manifest.contributions.panels.flatMap((panel) =>
        panel?.id && panel.title ? [{ id: panel.id, title: panel.title, icon: panel.icon, order: panel.order }] : [],
      )
      : [];
    extensions.push({ id, name: manifest.name || id, version: manifest.version || 'unknown', enabled, panels });
  }
  return extensions;
}

export async function findPanelExtension(id: string) {
  if (!getExtensionEnabled(id)) return null;
  for await (const extension of scanInstalledExtensionManifests()) {
    if (extension.id === id && extension.manifest.contributions?.panels?.length) return extension;
  }
  return null;
}

export async function readBrowserPanelAssets(id: string): Promise<{ source: string; css: string } | null> {
  const extension = await findPanelExtension(id);
  if (!extension) return null;
  const { extensionPath, manifest } = extension;
  async function readAsset(root: string, asset: unknown, extensions: string[]): Promise<string> {
    if (typeof asset !== 'string' || isAbsolute(asset) || !extensions.includes(extname(asset))) {
      throw new Error('Invalid panel asset');
    }
    const file = await realpath(resolve(root, asset));
    const subpath = relative(root, file);
    if (isAbsolute(subpath) || subpath === '..' || subpath.startsWith(`..${sep}`)) {
      throw new Error('Invalid panel asset');
    }
    const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const info = await handle.stat();
      if (!info.isFile() || info.size > 16 * 1024 * 1024) throw new Error('Invalid panel asset');
      const bytes = Buffer.alloc(info.size);
      const { bytesRead } = await handle.read(bytes, 0, bytes.length, 0);
      if (bytesRead !== info.size) throw new Error('Panel asset changed while reading');
      return bytes.toString('utf8');
    } finally {
      await handle.close();
    }
  }

  try {
    const root = await realpath(extensionPath);
    const [source, css] = await Promise.all([
      readAsset(root, manifest.main, ['.js', '.mjs']),
      manifest.styles ? readAsset(root, manifest.styles, ['.css']) : '',
    ]);
    return { source, css };
  } catch {
    return null;
  }
}

export async function callBrowserPanelTool(
  workspacePath: string,
  extensionId: string,
  toolName: string,
  args: Record<string, unknown>,
): Promise<unknown> {
  const workspace = await resolveBackendWorkspacePath(workspacePath);
  const extension = await findPanelExtension(extensionId);
  if (!extension || !findOwnedBackendTool(workspace, toolName, extensionId)) {
    throw new Error('Backend tool is unavailable to this extension');
  }
  const result = await handleBackendTool(toolName, toolName, args, workspace, {
    sessionId: null,
    caller: 'panel',
    extensionId,
  });
  const text = result.content?.[0]?.text ?? '';
  if (result.isError) throw new Error(text || 'Backend tool failed');
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}
