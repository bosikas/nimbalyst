import React, { useState } from 'react';
import { useAtom } from 'jotai';
import { settingAtom } from '../../store/atoms/settingAtomFamily';
import { SessionListCustomization } from './SessionListCustomization';
import { SessionCreationOptions } from './SessionPolicyControls';
import { errorNotificationService } from '../../services/ErrorNotificationService';
import { FloatingFocusManager } from '@floating-ui/react';
import { MaterialSymbol } from '@nimbalyst/runtime/ui/icons/MaterialSymbol';
import { FloatingPortal, useFloatingMenu } from '../../hooks/useFloatingMenu';
import { RemoteMachineSelector } from '../RemoteMachineSelector';
import type { WorkSummaryFilter } from '@nimbalyst/runtime/ai/sessionWorkSummary';

interface Props {
  workspacePath: string;
  search: string;
  onSearch: (value: string) => void;
  onNew: (policy?: { generateSummary?: boolean; autoArchiveAfterMinutes?: number }) => void | Promise<unknown>;
  sort: 'updated' | 'created';
  onSort: (sort: 'updated' | 'created') => void;
  archived: boolean;
  onArchive: () => void;
  kanban: boolean;
  onKanban: () => void;
  compact: boolean;
  onCompact: () => void;
  context: boolean;
  onContext: () => void;
  count: number;
  workFilter?: WorkSummaryFilter;
  onWorkFilter?: (filter: WorkSummaryFilter) => void;
  areas?: string[];
  actions?: Array<{ label: string; run: () => void; disabled?: boolean }>;
  children?: React.ReactNode;
}

/** One toolbar in every list state; secondary capabilities remain discoverable. */
export function SessionNavigationToolbar(props: Props) {
  const menu = useFloatingMenu({ placement: 'bottom-end' });
  const [customize, setCustomize] = useState(false);
  const [creating, setCreating] = useState(false);
  const [appearance, saveAppearance] = useAtom(settingAtom('ui.sessionListAppearance'));
  const filterLabel = props.workFilter?.startsWith('area:') ? props.workFilter.slice(5) : props.workFilter === 'remaining' ? 'Remaining work' : props.workFilter === 'blocked' ? 'Blocked' : 'Needs review';
  const action = (label: string, run: () => void, checked?: boolean, disabled = false) => <button
    key={label} type="button" role={checked === undefined ? 'menuitem' : 'menuitemcheckbox'} aria-checked={checked} disabled={disabled}
    className="session-navigation-menu-item flex w-full items-center justify-between gap-4 rounded px-2 py-1.5 text-left text-xs hover:bg-[var(--nim-bg-hover)] disabled:opacity-40"
    onClick={() => { menu.setIsOpen(false); run(); }}>
    <span>{label}</span>{checked && <MaterialSymbol icon="check" size={12} />}
  </button>;
  return <div className="session-navigation-toolbar flex shrink-0 items-start gap-1 border-b border-[var(--nim-border)] px-2 py-2">
    <div className="session-navigation-search min-w-0 flex-1">
      {props.children ?? <input aria-label="Search sessions" placeholder="Search sessions or work…" title="Search titles, session scope, remaining work and areas" value={props.search} onChange={event => props.onSearch(event.target.value)} className="w-full rounded bg-[var(--nim-bg-secondary)] px-2 py-1.5 text-xs outline-none focus:ring-1 focus:ring-[var(--nim-primary)]" />}
      {props.workFilter && props.workFilter !== 'all' && props.onWorkFilter && <button type="button" className="session-filter-active" aria-label={`Clear ${filterLabel} filter`} onClick={() => props.onWorkFilter?.('all')}>
        <span>{filterLabel}</span><MaterialSymbol icon="close" size={10} />
      </button>}
    </div>
    {props.onWorkFilter && <SessionWorkFilters value={props.workFilter ?? 'all'} onChange={props.onWorkFilter} areas={props.areas ?? []} />}
    <button type="button" aria-label="New session" title="New session" onClick={() => { void props.onNew(); }} className="session-navigation-new flex h-7 w-7 shrink-0 items-center justify-center rounded text-[var(--nim-text-muted)] hover:bg-[var(--nim-bg-hover)] hover:text-[var(--nim-text)]"><MaterialSymbol icon="add" size={16} /></button>
    <button type="button" ref={menu.refs.setReference} {...menu.getReferenceProps()} aria-label="Session options" aria-expanded={menu.isOpen} onClick={() => menu.setIsOpen(!menu.isOpen)} className="session-navigation-options flex h-7 w-7 shrink-0 items-center justify-center rounded text-[var(--nim-text-muted)] hover:bg-[var(--nim-bg-hover)] hover:text-[var(--nim-text)]"><MaterialSymbol icon="more_horiz" size={16} /></button>
    {menu.isOpen && <FloatingPortal><FloatingFocusManager context={menu.context} modal={false}><div ref={menu.refs.setFloating} style={menu.floatingStyles} {...menu.getFloatingProps()} className="session-navigation-menu z-[10000] min-w-48 overflow-y-auto rounded-lg border border-[var(--nim-border)] bg-[var(--nim-bg)] p-1.5 text-[var(--nim-text)] shadow-lg" onKeyDown={event => {
      if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
      const items = [...event.currentTarget.querySelectorAll<HTMLButtonElement>('button:not(:disabled)')];
      const current = items.indexOf(document.activeElement as HTMLButtonElement);
      const next = event.key === 'Home' ? 0 : event.key === 'End' ? items.length - 1 : (current + (event.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length;
      event.preventDefault(); items[next]?.focus();
    }}>
      <p className="px-2 py-1 text-[10px] text-[var(--nim-text-faint)]">{props.count} sessions</p>
      {action(props.kanban ? 'List view' : 'Kanban view', props.onKanban)}
      {action('Show archived', props.onArchive, props.archived)}
      <div className="my-1 border-t border-[var(--nim-border)]" />
      {action('Last updated first', () => props.onSort('updated'), props.sort === 'updated')}
      {action('Created first', () => props.onSort('created'), props.sort === 'created')}
      {action('Compact rows', props.onCompact, props.compact)}
      {action('Show context usage', props.onContext, props.context)}
      {action('Show Next / To review', () => { void Promise.resolve(saveAppearance({ ...appearance, showRemaining: !appearance.showRemaining })).catch(error => errorNotificationService.showError(error, 'Could not save session list preferences.')); }, appearance.showRemaining)}
      {action('Show model', () => { void Promise.resolve(saveAppearance({ ...appearance, showModel: !appearance.showModel })).catch(error => errorNotificationService.showError(error, 'Could not save session list preferences.')); }, appearance.showModel)}
      {action('Customize session list…', () => setCustomize(true))}
      {action('New session with options…', () => setCreating(true))}
      {!!props.actions?.length && <div className="my-1 border-t border-[var(--nim-border)]" />}
      {props.actions?.map(item => action(item.label, item.run, undefined, item.disabled))}
      <RemoteMachineSelector workspacePath={props.workspacePath} />
    </div></FloatingFocusManager></FloatingPortal>}
    <SessionListCustomization open={customize} onClose={() => setCustomize(false)} />
    <SessionCreationOptions open={creating} onClose={() => setCreating(false)} onCreate={props.onNew} />
  </div>;
}

function SessionWorkFilters({ value, onChange, areas }: { value: WorkSummaryFilter; onChange: (filter: WorkSummaryFilter) => void; areas: string[] }) {
  const menu = useFloatingMenu({ placement: 'bottom-end' });
  const options: Array<[WorkSummaryFilter, string]> = [['all', 'All sessions'], ['remaining', 'Has remaining work'], ['blocked', 'Blocked'], ['review', 'Needs review'], ...areas.map(area => [`area:${area}`, area] as [WorkSummaryFilter, string])];
  const label = options.find(([key]) => key === value)?.[1] ?? 'All sessions';
  return <>
    <button type="button" ref={menu.refs.setReference} {...menu.getReferenceProps()} onClick={() => menu.setIsOpen(!menu.isOpen)}
      aria-label={`Filter sessions: ${label}`} aria-expanded={menu.isOpen} title={label}
      className={`session-navigation-filter relative flex h-7 w-7 shrink-0 items-center justify-center rounded hover:bg-[var(--nim-bg-hover)] ${value === 'all' ? 'text-[var(--nim-text-muted)]' : 'text-[var(--nim-primary)]'}`}>
      <MaterialSymbol icon="filter_list" size={15} />{value !== 'all' && <span className="session-filter-dot" />}
    </button>
    {menu.isOpen && <FloatingPortal><FloatingFocusManager context={menu.context} modal={false}>
      <div ref={menu.refs.setFloating} style={menu.floatingStyles} {...menu.getFloatingProps()} className="session-navigation-menu session-work-filter-menu" onKeyDown={event => {
        if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
        const buttons = [...event.currentTarget.querySelectorAll<HTMLButtonElement>('button')];
        const current = buttons.indexOf(document.activeElement as HTMLButtonElement);
        const next = event.key === 'Home' ? 0 : event.key === 'End' ? buttons.length - 1 : (current + (event.key === 'ArrowDown' ? 1 : -1) + buttons.length) % buttons.length;
        event.preventDefault(); buttons[next]?.focus();
      }}>
        <p className="session-filter-heading">Work</p>
        {options.map(([key, text], index) => <React.Fragment key={key}>
          {index === 4 && <p className="session-filter-heading session-filter-area-heading">Area</p>}
          <button type="button" role="menuitemradio" aria-checked={value === key} className="session-navigation-menu-item session-work-filter-option" onClick={() => { onChange(key); menu.setIsOpen(false); }}>
            <span>{text}</span>{value === key && <MaterialSymbol icon="check" size={12} />}
          </button>
        </React.Fragment>)}
      </div>
    </FloatingFocusManager></FloatingPortal>}
  </>;
}
