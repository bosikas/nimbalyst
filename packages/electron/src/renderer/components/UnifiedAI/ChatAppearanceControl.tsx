import React, { useState } from 'react';
import { useAtom } from 'jotai';
import { FloatingFocusManager } from '@floating-ui/react';
import { MaterialSymbol } from '@nimbalyst/runtime/ui/icons/MaterialSymbol';
import { FloatingPortal, useFloatingMenu } from '../../hooks/useFloatingMenu';
import { settingAtom } from '../../store/atoms/settingAtomFamily';
import { DEFAULT_CHAT_APPEARANCE, type ChatAppearance } from '../../../shared/chatAppearance';
import './chatAppearance.css';

/** The controls edit the same persisted settings used by the transcript. */
export function ChatAppearanceControl() {
  const menu = useFloatingMenu({ placement: 'bottom-end' });
  const [appearance, save] = useAtom(settingAtom('ui.chatAppearance'));
  const [density, saveDensity] = useAtom(settingAtom('ai.chatDensity'));
  const [tools, saveTools] = useAtom(settingAtom('ai.chatShowToolCalls'));
  const [error, setError] = useState('');
  const persist = async (operation: () => unknown) => {
    try { await operation(); setError(''); }
    catch { setError('Could not save this change. Please try again.'); }
  };
  const change = (patch: Partial<ChatAppearance>) => persist(() => save({ ...appearance, ...patch }));
  return <>
    <button type="button" ref={menu.refs.setReference} {...menu.getReferenceProps()}
      onClick={() => menu.setIsOpen(!menu.isOpen)} className="chat-appearance-trigger"
      title="Chat appearance" aria-label="Chat appearance" aria-haspopup="dialog" aria-expanded={menu.isOpen}>
      <MaterialSymbol icon="tune" size={18} />
    </button>
    {menu.isOpen && <FloatingPortal><FloatingFocusManager context={menu.context} modal={false}>
      <section ref={menu.refs.setFloating} style={menu.floatingStyles} {...menu.getFloatingProps()} role="dialog"
        className="chat-appearance-panel" aria-label="Chat appearance">
        <header><div><h2>Reading & appearance</h2><p>Saved on this device</p></div>
          <button type="button" aria-label="Close appearance" onClick={() => menu.setIsOpen(false)}><MaterialSymbol icon="close" size={16} /></button></header>
        <label><span>Text size <output>{appearance.textSize}px</output></span><input aria-label="Chat text size" type="range" min="12" max="20" step="0.5" value={appearance.textSize} onChange={e => { void change({ textSize: Number(e.target.value) }); }} /></label>
        <label><span>Reading width <output>{appearance.readingWidth}px</output></span><input aria-label="Reading width" type="range" min="560" max="1100" step="20" value={appearance.readingWidth} onChange={e => { void change({ readingWidth: Number(e.target.value) }); }} /></label>
        <label><span>Spacing</span><select aria-label="Chat spacing" value={density} onChange={e => { const next = e.target.value as typeof density; void persist(() => saveDensity(next)); }}><option value="comfortable">Comfortable</option><option value="compact">Compact</option><option value="dense">Dense</option></select></label>
        <label className="chat-appearance-toggle"><span>Show tool activity</span><input type="checkbox" checked={tools} onChange={e => { const next = e.target.checked; void persist(() => saveTools(next)); }} /></label>
        <label className="chat-appearance-toggle"><span>Group tool activity</span><input type="checkbox" checked={appearance.groupToolActivity} onChange={e => { void change({ groupToolActivity: e.target.checked }); }} /></label>
        <p className="chat-appearance-note">Questions and approvals stay visible. Expand activity to inspect every tool and its output.</p>
        {error && <p role="alert">{error}</p>}
        <footer><button type="button" onClick={() => { void persist(async () => { await save(DEFAULT_CHAT_APPEARANCE); await saveDensity('comfortable'); await saveTools(true); }); }}>Reset appearance</button></footer>
      </section>
    </FloatingFocusManager></FloatingPortal>}
  </>;
}
