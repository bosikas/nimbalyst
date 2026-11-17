import { isInteractiveWidgetTool } from '../../../ai/server/interactivePromptTools';
import { formatToolDisplayName } from './toolNameFormatter';

interface ActivityEntry {
  message: {
    toolCall?: { toolName: string; status: string; isError?: boolean; arguments?: Record<string, unknown>; targetFilePath?: string | null; description?: string | null; toolDisplayName?: string; result?: string; exitCode?: number };
    interactivePrompt?: unknown;
    isError?: boolean;
  };
  isExpanded: boolean;
}

const excerpt = (text: string, limit = 180) => {
  const compact = text.slice(0, 1200).replace(/\s+/g, ' ').trim();
  return compact.length > limit ? compact.slice(0, limit) + '…' : compact;
};

/** Deterministic presentation of known fields; never replaces original tool data. */
export function describeToolActivity(entries: readonly ActivityEntry[]): { title: string; target: string; preview: string } {
  const descriptions = entries.map(({ message }) => {
    const tool = message.toolCall;
    const name = (tool?.toolName.split('__').pop() ?? 'tool').toLowerCase();
    const args = tool?.arguments ?? {};
    const field = (...keys: string[]) => {
      for (const key of keys) if (typeof args[key] === 'string' && (args[key] as string).trim()) return excerpt(args[key] as string);
      return '';
    };
    const path = excerpt(tool?.targetFilePath ?? '') || field('file_path', 'filePath', 'path');
    let title = tool?.toolDisplayName || formatToolDisplayName(tool?.toolName) || 'Tool call';
    let target = '', preview = excerpt(tool?.description ?? '');
    let category = 'other';
    if (/^(read|read_file)$/.test(name)) {
      title = 'Read file'; target = path; category = 'read';
      const start = args.offset ?? args.startLine;
      if (typeof start === 'number') preview = `From line ${start}${typeof args.limit === 'number' ? ` · ${args.limit} lines requested` : ''}`;
    } else if (/^(bash|shell|command_execution|exec_command|execute_command)$/.test(name)) {
      title = 'Run command'; target = field('command', 'cmd'); category = 'command';
    } else if (/^(edit|write|multiedit|multi_edit|apply_patch|file_change|write_file|edit_file)$/.test(name)) {
      title = name.includes('write') ? 'Write file' : 'Edit file'; target = path; category = 'edit';
    } else if (/^(grep|glob|search|search_files|web_search)$/.test(name)) {
      title = 'Search'; target = field('pattern', 'query', 'searchTerm'); category = 'search';
    } else if (/^(session_send_prompt|send_prompt|send_message|session_coordination)$/.test(name)) {
      title = name === 'session_coordination' ? 'Coordinate session' : 'Send prompt';
      target = field('sessionName', 'sessionTitle', 'targetSessionName', 'target', 'sessionId', 'targetSessionId');
      preview = field('prompt', 'message', 'text', 'content') || preview; category = name === 'session_coordination' ? 'other' : 'message';
    }
    if (!preview && tool?.result) {
      // JSON envelopes stay inside the full disclosure rather than becoming raw chrome.
      const result = tool.result.slice(0, 1200).trimStart();
      if (!result.startsWith('{') && !result.startsWith('[')) preview = excerpt(result);
    }
    return { title, target, preview, category };
  });
  if (descriptions.length === 1) return descriptions[0];
  const counts = new Map<string, number>();
  for (const d of descriptions) counts.set(d.category, (counts.get(d.category) ?? 0) + 1);
  const titles = [...counts].map(([category, count]) => category === 'read' ? `read ${count} file${count === 1 ? '' : 's'}`
    : category === 'search' ? 'searched' : category === 'edit' ? `edited ${count} file${count === 1 ? '' : 's'}`
    : category === 'command' ? `ran ${count} command${count === 1 ? '' : 's'}`
    : category === 'message' ? `sent ${count} message${count === 1 ? '' : 's'}` : `used ${count} tool${count === 1 ? '' : 's'}`);
  const title = titles.join(' and ');
  return { title: title ? title[0].toUpperCase() + title.slice(1) : 'Tool activity', target: '', preview: excerpt([...new Set(descriptions.map(d => d.target || d.title))].join(' · ')) };
}

/** Replayed provider events can carry failure on the tool without a message flag. */
export function isToolActivityError(message: ActivityEntry['message']): boolean {
  return !!(message.isError || message.toolCall?.isError || message.toolCall?.status === 'error');
}

/** Split at prompts rather than moving a pending decision behind disclosure. */
export function partitionToolActivity<T extends ActivityEntry>(entries: readonly T[]) {
  const groups: Array<{ kind: 'interactive' | 'activity'; entries: T[] }> = [];
  for (const entry of entries) {
    const interactive = !!entry.message.interactivePrompt || isInteractiveWidgetTool(entry.message.toolCall?.toolName);
    const previous = groups[groups.length - 1];
    if (!interactive && previous?.kind === 'activity') previous.entries.push(entry);
    else groups.push({ kind: interactive ? 'interactive' : 'activity', entries: [entry] });
  }
  return groups;
}

/** A tool's virtual row may be hidden because an earlier assistant owns it. */
export function findToolActivityTarget<T extends {
  index: number;
  message: { toolCall?: { providerToolCallId: string | null } };
}>(rows: readonly { toolEntries: readonly T[] | null }[], index: number, toolCallId?: string) {
  for (let owner = 0; owner < rows.length; owner++) {
    const entry = rows[owner].toolEntries?.find(entry => toolCallId
      ? entry.message.toolCall?.providerToolCallId === toolCallId
      : entry.index === index);
    if (entry) return { owner, entry };
  }
  return undefined;
}

export function summarizeToolActivity(entries: readonly ActivityEntry[], isProcessing: boolean) {
  const failed = entries.some(e => isToolActivityError(e.message));
  const unfinished = entries.some(e => e.message.toolCall?.status === 'running');
  const state = failed ? 'error' : unfinished ? isProcessing ? 'running' : 'stopped' : 'completed';
  return { state, open: failed || state === 'running' || entries.some(e => e.isExpanded) } as const;
}
