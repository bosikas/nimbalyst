import React, { useId, useState } from 'react';
import { MaterialSymbol } from '../../icons/MaterialSymbol';
import { describeToolActivity, partitionToolActivity, summarizeToolActivity } from '../utils/toolActivity';
import type { TranscriptToolEntry } from './TranscriptMessageRow';

export interface ToolActivityReveal { toolIndex: number; sequence: number; }

// These widgets already expose the action, preview, clickable session chip and
// original evidence. A second disclosure would hide their useful controls.
const SESSION_CARD_TOOLS = new Set(['send_prompt', 'respond_to_prompt', 'spawn_session', 'create_session', 'get_session_status', 'get_session_result', 'list_queued_prompts', 'list_spawned_sessions']);

function Activity({ entries, isProcessing, renderEntry, reveal }: {
  entries: readonly TranscriptToolEntry[];
  isProcessing: boolean;
  renderEntry: (entry: TranscriptToolEntry) => React.ReactNode;
  reveal?: ToolActivityReveal;
}) {
  const id = useId();
  const summary = summarizeToolActivity(entries, isProcessing);
  const revealed = !!reveal && entries.some(e => e.index === reveal.toolIndex);
  const expandedKey = entries.filter(e => e.isExpanded).map(e => e.index).join(',') + (revealed ? `:${reveal.sequence}` : '');
  const [disclosure, setDisclosure] = useState<{ open: boolean; expandedKey: string } | null>(null);
  // A newly revealed tool opens its group; a user can still close the whole group.
  const open = disclosure?.expandedKey === expandedKey ? disclosure.open : revealed || summary.open;
  const description = describeToolActivity(entries);
  const exitCode = entries.length === 1 ? entries[0].message.toolCall?.exitCode : undefined;
  const status = summary.state === 'running' ? 'Working' : summary.state === 'error' ? `Failed${exitCode !== undefined ? ` · Exit ${exitCode}` : ''}` : summary.state === 'stopped' ? 'Stopped' : 'Completed';
  return <section className="transcript-tool-activity" data-state={summary.state}>
    <button type="button" className="transcript-tool-activity-toggle" aria-expanded={open} aria-controls={id} onClick={() => setDisclosure({ open: !open, expandedKey })}>
      {summary.state === 'running' ? <span className="transcript-tool-activity-spinner" aria-hidden="true" /> : <MaterialSymbol icon={summary.state === 'error' ? 'error_outline' : summary.state === 'stopped' ? 'stop_circle' : 'check_circle'} size={14} />}
      <span className="transcript-tool-activity-label"><span className="transcript-tool-activity-heading"><span>{description.title}</span>{description.target && <span className="transcript-tool-activity-target">{description.target}</span>}</span>{description.preview && <span className="transcript-tool-activity-preview">{description.preview}</span>}</span>
      <span className="transcript-tool-activity-count">{status}{entries.length > 1 && ` · ${entries.length} tools`}</span>
      <MaterialSymbol icon={open ? 'expand_more' : 'chevron_right'} size={14} />
    </button>
    <div id={id} hidden={!open} className="transcript-tool-activity-steps">{open && entries.map(renderEntry)}</div>
  </section>;
}

/** Only ordinary tools participate. All interactive cards retain their own UI. */
export function ToolActivityGroup({ entries, isProcessing, renderEntry, reveal }: {
  entries: readonly TranscriptToolEntry[];
  isProcessing: boolean;
  renderEntry: (entry: TranscriptToolEntry) => React.ReactNode;
  reveal?: ToolActivityReveal;
}) {
  return <div className="transcript-tool-activity-run">{partitionToolActivity(entries.filter(entry => !entry.superseded)).flatMap(group => group.kind === 'activity' && group.entries.length < 3 ? group.entries.map(entry => ({ ...group, entries: [entry] })) : [group]).map(group => group.kind === 'interactive' || (group.entries.length === 1 && SESSION_CARD_TOOLS.has(group.entries[0].message.toolCall?.toolName.split('__').pop() ?? ''))
    ? <React.Fragment key={group.entries[0].index}>{group.entries.map(renderEntry)}</React.Fragment>
    : <Activity key={group.entries[0].index} entries={group.entries} isProcessing={isProcessing} renderEntry={renderEntry} reveal={reveal} />)}</div>;
}
