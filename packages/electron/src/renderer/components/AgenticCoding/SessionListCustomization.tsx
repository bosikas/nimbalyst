import React, { useState } from 'react';
import { useAtom } from 'jotai';
import { FloatingPortal, FloatingOverlay, FloatingFocusManager, useFloating, useDismiss, useRole, useInteractions } from '@floating-ui/react';
import { settingAtom } from '../../store/atoms/settingAtomFamily';
import { DEFAULT_SESSION_LIST_APPEARANCE as defaults, COMPACT_SESSION_LIST_APPEARANCE as compact, SESSION_ACTIVITY_APPEARANCE, sessionAppearanceVariables, type SessionListAppearance } from '../../../shared/sessionListAppearance';
import { ActivityHeading } from './SessionActivityHeader';

export function SessionListCustomization({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [value, save] = useAtom(settingAtom('ui.sessionListAppearance'));
  const [tab, setTab] = useState<'Type' | 'Details' | 'Hierarchy'>('Type');
  const [error, setError] = useState('');
  const matches = (preset: SessionListAppearance) => (Object.keys(preset) as Array<keyof SessionListAppearance>).every(key => value[key] === preset[key]);
  const presetName = matches(defaults) ? 'Concept' : matches(compact) ? 'Compact' : 'Custom';
  const floating = useFloating({ open, onOpenChange: next => { if (!next) onClose(); } });
  const interactions = useInteractions([useDismiss(floating.context), useRole(floating.context, { role: 'dialog' })]);
  const update = async (patch: Partial<SessionListAppearance>) => {
    try { await save({ ...value, ...patch }); setError(''); } catch { setError('Could not save. Your previous settings are retained.'); }
  };
  const number = (key: keyof SessionListAppearance, label: string, min: number, max: number, step = 1) => <label className="session-custom-control" key={key}><span>{label}</span><span className="session-custom-number"><input aria-label={label} type="number" min={min} max={max} step={step} value={Number(value[key])} onChange={event => { const n = event.currentTarget.valueAsNumber; if (Number.isFinite(n) && n >= min && n <= max) void update({ [key]: n }); }} /><span>{key === 'inactiveOpacity' ? '' : key === 'olderChildren' ? 'chats' : key === 'autoCollapseSeconds' ? 'sec' : 'px'}</span></span></label>;
  const toggle = (key: keyof SessionListAppearance, label: string) => <label className="session-custom-control" key={key}><span>{label}</span><input type="checkbox" checked={value[key] === true} onChange={event => { void update({ [key]: event.target.checked }); }} /></label>;
  const colors = Object.entries(SESSION_ACTIVITY_APPEARANCE).map(([label, activity]) => <div className="session-custom-control" key={activity.key}>
    <span>{label} color</span><span className="session-custom-colors">
      <span className="session-custom-color-swatch" style={{ background: value[activity.key] === 'theme' ? activity.color : value[activity.key] }}>
        <input type="color" aria-label={`${label} color`} value={value[activity.key] === 'theme' ? '#808080' : value[activity.key]} onChange={event => { void update({ [activity.key]: event.target.value }); }} />
      </span>
      <button type="button" disabled={value[activity.key] === 'theme'} onClick={() => { void update({ [activity.key]: 'theme' }); }} aria-label={`Use theme color for ${label}`}>Theme</button>
    </span>
  </div>);
  if (!open) return null;
  return <FloatingPortal><FloatingOverlay lockScroll className="session-custom-overlay"><FloatingFocusManager context={floating.context}>
    <section ref={floating.refs.setFloating} {...interactions.getFloatingProps()} className="session-customization" aria-label="Customize session list">
      <header><div><h2>Make the list yours</h2><p>Saved on this device, across projects.</p></div><button type="button" aria-label="Close customization" onClick={onClose}>×</button></header>
      <div className="session-custom-presets"><span>{presetName === 'Custom' ? 'Custom' : 'Preset'}</span><button type="button" aria-pressed={presetName === 'Concept'} onClick={() => { void update(defaults); }}>Concept</button><button type="button" aria-pressed={presetName === 'Compact'} onClick={() => { void update(compact); }}>Compact</button><button type="button" onClick={() => { void update(defaults); }}>Reset defaults</button></div>
      <div className="session-custom-preview" style={sessionAppearanceVariables(value) as React.CSSProperties} aria-label="Live preview">
        <div className="session-custom-preview-activities">{Object.keys(SESSION_ACTIVITY_APPEARANCE).map(title => <ActivityHeading key={title} title={title} count={1} appearance={value} />)}</div>
        <div className="session-custom-preview-row"><span className="session-custom-preview-title">Session navigation improvements</span>{value.showSummary && <p className="session-custom-preview-summary">Clearer hierarchy, summaries and quieter details.</p>}{value.showRemaining && <p className="session-custom-preview-summary"><strong>Next</strong> Review the updated sidebar.</p>}{value.showModel && <small>gpt-6.1-sol</small>}</div>
        <div className="session-custom-preview-child">Review child session</div>
      </div>
      <div className="session-custom-tabs" role="tablist" aria-label="Customization categories">{(['Type', 'Details', 'Hierarchy'] as const).map(name => <button key={name} type="button" role="tab" aria-selected={tab === name} onClick={() => setTab(name)}>{name}</button>)}</div>
      <div className="session-custom-controls" role="tabpanel" aria-label={tab}>
        {tab === 'Type' && <>{number('titleSize', 'Title size', 11, 22, 0.5)}{number('childTitleSize', 'Child title size', 10, 20, 0.5)}{number('rowPadding', 'Row padding', 0, 12)}{number('childPadding', 'Child row padding', 0, 10)}{number('summarySize', 'Summary size', 8, 14, 0.5)}{number('summaryLineHeight', 'Summary line spacing', 10, 22)}{number('headingSize', 'Activity heading size', 10, 16)}{toggle('headingBold', 'Bold activity headings')}{colors}{number('inactiveOpacity', 'Inactive text opacity', 0.4, 1, 0.05)}</>}
        {tab === 'Details' && <>{toggle('showSummary', 'Show scope summary')}{toggle('showRemaining', 'Show Next / To review')}{toggle('showModel', 'Show model')}{toggle('showTimestamps', 'Show timestamps')}{toggle('showParentIcon', 'Provider icon on main chats')}{toggle('showChildIcon', 'Provider icon on children')}<label className="session-custom-control"><span>Child context bars</span><select aria-label="Child context bars" value={value.childContext} onChange={event => { void update({ childContext: event.target.value as SessionListAppearance['childContext'] }); }}><option value="hover">On hover or selection</option><option value="always">Always</option><option value="hidden">Hidden</option></select></label><p className="session-custom-note">These controls change visibility. Summary generation is controlled separately for each session.</p></>}
        {tab === 'Hierarchy' && <>{toggle('activeChildrenFirst', 'Active children first')}{number('olderChildren', 'Older children initially shown', 0, 10)}{number('indent', 'Child indentation', 6, 24)}{toggle('branchGuides', 'Show branch guides')}{number('autoCollapseSeconds', 'Collapse expanded branches after', 0, 600)}<p className="session-custom-note">Zero keeps branches open.</p>{toggle('hideRedundantWorktrees', 'Hide single-root worktree headings')}<label className="session-custom-control"><span>Summary lines</span><select aria-label="Summary lines" value={value.scopeLines} onChange={event => { void update({ scopeLines: Number(event.target.value) }); }}>{[1, 2, 3].map(n => <option key={n} value={n}>{n}</option>)}</select></label></>}
      </div>
      {error && <p className="session-custom-error" role="alert">{error}</p>}
      <footer><span>Changes appear immediately.</span><button type="button" onClick={onClose}>Done</button></footer>
    </section>
  </FloatingFocusManager></FloatingOverlay></FloatingPortal>;
}
