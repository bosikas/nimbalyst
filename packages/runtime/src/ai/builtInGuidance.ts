/** Nimbalyst-owned prompt guidance. Provider/repository instructions are separate. */
export const BUILT_IN_GUIDANCE = [
  { id: 'identity', title: 'Editor identity', description: 'Identify the editor and the actual AI model.' },
  { id: 'interactive-input', title: 'Interactive questions', description: 'Use Nimbalyst question and approval widgets instead of asking in chat.' },
  { id: 'visual-communication', title: 'Visual communication', description: 'Prefer charts, diagrams, screenshots and live editor embeds when useful.' },
  { id: 'file-references', title: 'Clickable file references', description: 'Format file references as links that open in the editor.' },
  { id: 'context-discovery', title: 'Context and skill discovery', description: 'Use native skill/tool discovery and distinguish agent reports from human requests (Codex).' },
  { id: 'git-commits', title: 'Nimbalyst commit proposals', description: 'Direct commit requests to the Nimbalyst commit widget. Turning this off removes that preference; the tool remains available.' },
  { id: 'trackers', title: 'Tracker references', description: 'Check teammate activity and format tracker links.' },
  { id: 'plan-tracking', title: 'Plan file tracking', description: 'Include tracking frontmatter in plan files when plan tracking is enabled.' },
  { id: 'worktree', title: 'Worktree guidance', description: 'Tell agents to stay in their assigned worktree and preserve shared edits.' },
  { id: 'repository-context', title: 'Repository snapshot', description: 'Include the session-start Git snapshot supplied by Claude Code.' },
  { id: 'session-metadata', title: 'Session names, tags and phase', description: 'Ask agents to maintain session metadata and commit-status tags.' },
  { id: 'session-naming-reminder', title: 'First-turn naming reminder', description: 'Extra Codex reminder if the first turn ends without naming the session.' },
  { id: 'voice-mode', title: 'Voice conversation guidance', description: 'Keep spoken answers brief in voice mode. Your custom voice instructions remain separate.' },
  { id: 'coordination', title: 'Coordinator workflows', description: 'Built-in delegation, child-report and workflow-preset instructions for coordinator sessions.' },
  { id: 'dev-agent', title: 'Extension coding-agent guidance', description: 'Built-in workflow and grounding instructions for tool-loop coding agents.' },
  { id: 'document-editing', title: 'Document editing guidance', description: 'Built-in document and mockup-editing instructions for chat providers.' },
] as const;

export type BuiltInGuidanceId = typeof BUILT_IN_GUIDANCE[number]['id'];
export type BuiltInGuidanceSettings = Partial<Record<BuiltInGuidanceId, boolean>>;
export type BuiltInGuidanceText = Partial<Record<BuiltInGuidanceId, string>>;
export type AgentSetupProvider = 'claude-code' | 'openai-codex';
export interface AgentGuidancePreview {
  provider: AgentSetupProvider;
  role: string;
  text: string;
  scope: string;
}
export interface GuidanceRenderOptions {
  guidanceSettings?: BuiltInGuidanceSettings;
  guidanceText?: BuiltInGuidanceText;
  /** Collect provider-default fragments for Settings, including disabled/replaced sections. */
  onGuidance?: (id: BuiltInGuidanceId, text: string) => void;
}
export interface BuiltInGuidanceEntry {
  id: BuiltInGuidanceId;
  title: string;
  description: string;
  enabled: boolean;
  /** A replacement for this section in every provider variant, when applicable. */
  customText?: string;
  previews: Array<{ provider: string; text: string }>;
}

const ids = new Set<string>(BUILT_IN_GUIDANCE.map(({ id }) => id));
let settingsLoader: (() => unknown) | undefined;
let textLoader: (() => unknown) | undefined;

/** The desktop host installs its persisted settings reader during handler registration. */
export function setBuiltInGuidanceSettingsLoader(loader?: () => unknown, loadText?: () => unknown): void {
  settingsLoader = loader;
  textLoader = loadText;
}

export function normalizeBuiltInGuidanceText(value: unknown): BuiltInGuidanceText {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  return Object.fromEntries(Object.entries(value).filter(([id, text]) => ids.has(id) && typeof text === 'string' && text.trim().length > 0));
}

export function validateBuiltInGuidanceTextUpdate(id: unknown, text: unknown): asserts id is BuiltInGuidanceId {
  if (typeof id !== 'string' || !ids.has(id)) throw new Error('Unknown guidance section.');
  if (text !== null && (typeof text !== 'string' || !text.trim() || text.length > 100_000)) {
    throw new Error('Instructions must contain 1–100,000 characters. Use the toggle to disable a section.');
  }
}

export function isBuiltInGuidanceEnabled(id: BuiltInGuidanceId): boolean {
  return normalizeBuiltInGuidanceSettings(settingsLoader?.())[id] !== false;
}

export function normalizeBuiltInGuidanceSettings(value: unknown): BuiltInGuidanceSettings {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  return Object.fromEntries(Object.entries(value).filter(([id, enabled]) => ids.has(id) && typeof enabled === 'boolean'));
}

export function validateBuiltInGuidanceUpdates(value: unknown): BuiltInGuidanceSettings {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Guidance settings must be an object.');
  for (const [id, enabled] of Object.entries(value)) {
    if (!ids.has(id) || typeof enabled !== 'boolean') throw new Error(`Invalid built-in guidance setting: ${id}`);
  }
  return normalizeBuiltInGuidanceSettings(value);
}

export function createGuidanceRenderer(options: GuidanceRenderOptions = {}) {
  const settings = normalizeBuiltInGuidanceSettings(options.guidanceSettings ?? settingsLoader?.());
  const customText = normalizeBuiltInGuidanceText(options.guidanceText ?? textLoader?.());
  return (id: BuiltInGuidanceId, text: string): string => {
    options.onGuidance?.(id, text);
    return settings[id] === false ? '' : customText[id] === undefined ? text : `\n\n${customText[id]}\n\n`;
  };
}
