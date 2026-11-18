/** Surfaces a server may omit. `code_mode` is excluded: omitting it was observed to leave tools unreachable. */
const ALLOWED_SURFACES = new Set(['direct', 'deferred']);

/**
 * Codex-native per-server exposure control; never implement a second discovery router.
 * - absent or []: native default; deferred to tool search when the model supports it, otherwise direct.
 * - ['deferred']: requests direct exposure when a thread starts. Codex ignores it (tools stay
 *   deferred) for code_mode_only models when its strict third-party tools feature is enabled.
 * - ['direct']: tools stay discoverable only.
 * Codex decides exposure per server, not per tool, and some model tool modes ignore it.
 */
export function codexToolExposure(serverName: string, config: Record<string, unknown>): Record<string, unknown> {
  if (config.omit_tools_from === undefined) return {};
  // The integration's required interaction tools must remain reachable even
  // when a project config tries to hide the entire core endpoint.
  if (serverName === 'nimbalyst') return { omit_tools_from: [] };
  if (!Array.isArray(config.omit_tools_from)) throw new Error('omit_tools_from must be an array.');
  const surfaces = [...new Set(config.omit_tools_from)];
  if (surfaces.includes('code_mode')) {
    throw new Error(`MCP server "${serverName}": omit_tools_from cannot include code_mode; omitting it can leave the server's tools unreachable.`);
  }
  if (surfaces.some(value => !ALLOWED_SURFACES.has(value as string))) {
    throw new Error(`MCP server "${serverName}": omit_tools_from supports only "direct" or "deferred".`);
  }
  if (surfaces.length > 1) {
    throw new Error(`MCP server "${serverName}": omit_tools_from cannot omit both direct and deferred surfaces; the tools would have no direct or discovery route.`);
  }
  return { omit_tools_from: surfaces };
}
