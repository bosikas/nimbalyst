/** Codex-native exposure control; never implement a second discovery router. */
export function codexToolExposure(serverName: string, config: Record<string, unknown>): Record<string, unknown> {
  // The integration's required interaction tools must remain reachable even
  // when a project config tries to hide the entire core endpoint.
  if (config.omit_tools_from === undefined) return {};
  if (serverName === 'nimbalyst') return { omit_tools_from: [] };
  if (!Array.isArray(config.omit_tools_from)) throw new Error('omit_tools_from must be an array.');
  // Native on-demand discovery remains enabled. Hiding deferred/code-mode
  // surfaces is outside this control; use the native client for that policy.
  if (config.omit_tools_from.some(value => value !== 'direct')) {
    throw new Error('Nimbalyst selective loading preserves discovery: omit_tools_from supports only [] or ["direct"].');
  }
  return { omit_tools_from: [...new Set(config.omit_tools_from)] };
}
