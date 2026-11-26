import React, { useId } from 'react';
import { FloatingFocusManager, FloatingOverlay, FloatingPortal, useFloating } from '@floating-ui/react';
import { useAtomValue } from 'jotai';
import type { TokenUsageCategory } from '@nimbalyst/runtime/ai/server/types';
import { registerDialog } from '../../contexts/DialogContext';
import type { DialogComponentProps } from '../../contexts/DialogContext.types';
import { DIALOG_IDS } from '../../dialogs/registry';
import { sessionPromptAdditionsAtom, sessionStoreAtom } from '../../store/atoms/sessions';
import { ContextInspectionDetails } from './ContextInspectionDetails';
import { ClaudeContextInspectionDetails } from './ClaudeContextInspectionDetails';

export interface ContextInspectionDialogData {
  sessionId: string;
  provider: 'openai-codex' | 'claude-code' | 'claude-code-cli';
  currentContext?: { tokens: number; contextWindow: number; categories?: TokenUsageCategory[] };
}

export function registerContextInspectionDialog() {
  registerDialog<ContextInspectionDialogData>({
    id: DIALOG_IDS.CONTEXT_INSPECTION,
    group: 'help',
    component: ContextInspectionDialog,
  });
}

const providerNames = {
  'openai-codex': 'Codex',
  'claude-code': 'Claude Agent',
  'claude-code-cli': 'Claude Code CLI',
};

function PromptText({ title, text }: { title: string; text: string }) {
  return <details className="context-prompt-text mt-2">
    <summary className="cursor-pointer font-medium">{title}</summary>
    <pre className="mt-2 select-text whitespace-pre-wrap break-words rounded bg-[var(--nim-bg-secondary)] p-3">{text}</pre>
  </details>;
}

function ClaudeContextDetails({ sessionId, provider }: Pick<ContextInspectionDialogData, 'sessionId' | 'provider'>) {
  const additions = useAtomValue(sessionPromptAdditionsAtom(sessionId));
  const session = useAtomValue(sessionStoreAtom(sessionId));
  const firstUserMessage = session?.messages?.find(message => message.type === 'user_message');
  return <div className="claude-context-details space-y-4">
    <section>
      <h3 className="font-semibold">Opening input</h3>
      {firstUserMessage?.text
        ? <PromptText title="First user message in the transcript" text={firstUserMessage.text} />
        : <p className="text-[var(--nim-text-muted)]">No opening text is available in this transcript.</p>}
    </section>
    <section>
      <h3 className="font-semibold">Nimbalyst prompt additions</h3>
      {provider === 'claude-code-cli' ? <p className="text-[var(--nim-text-muted)]">Prompt additions are unavailable for terminal-driven sessions.</p>
        : additions ? <>
          <p className="text-[var(--nim-text-muted)]">Last captured turn · {new Date(additions.timestamp).toLocaleString()}</p>
          {additions.systemPromptAddition && <PromptText title="System prompt addition" text={additions.systemPromptAddition} />}
          {additions.userMessageAddition && <PromptText title="User message addition" text={additions.userMessageAddition} />}
          {!!additions.attachments?.length && <p className="mt-2">Attachments · {additions.attachments.map(attachment => attachment.filename).join(', ')}</p>}
        </> : <p className="text-[var(--nim-text-muted)]">The split between your text and Nimbalyst’s additions is captured live; the full prompt as sent is under Last request.</p>}
      <p className="mt-2 text-[var(--nim-text-muted)]">Claude’s built-in system prompt text is unavailable; its sections and token counts are listed under Context breakdown.</p>
    </section>
    <ClaudeContextInspectionDetails sessionId={sessionId} />
  </div>;
}

export function ContextInspectionDialog({ isOpen, onClose, data }: DialogComponentProps<ContextInspectionDialogData>) {
  const titleId = useId();
  const floating = useFloating({ open: isOpen });
  if (!isOpen) return null;
  const { sessionId, provider, currentContext } = data;
  return <FloatingPortal>
    <FloatingOverlay lockScroll className="context-inspection-overlay z-[10000] grid place-items-center bg-black/50 p-4">
      <FloatingFocusManager context={floating.context}>
        <section ref={floating.refs.setFloating} role="dialog" aria-modal="true" aria-labelledby={titleId}
          className="context-inspection-dialog flex h-[min(80dvh,52rem)] w-full max-w-5xl flex-col overflow-hidden rounded-xl border border-[var(--nim-border)] bg-[var(--nim-bg)] text-[var(--nim-text)] shadow-xl">
          <header className="flex shrink-0 items-center justify-between gap-4 border-b border-[var(--nim-border)] px-5 py-3">
            <h2 id={titleId} className="text-base font-semibold">Context inspector · {providerNames[provider]}</h2>
            <button type="button" className="rounded px-2 py-1 hover:bg-[var(--nim-bg-secondary)]" onClick={onClose}>Close</button>
          </header>
          <div className="min-h-0 flex-1 overflow-auto px-5 py-4 text-sm">
            {currentContext && <section className="mb-4">
              <h3 className="font-semibold">Provider-reported context</h3>
              <p>{currentContext.tokens.toLocaleString()} / {currentContext.contextWindow.toLocaleString()} tokens</p>
              {!!currentContext.categories?.length && <ul className="mt-2 space-y-1">
                {currentContext.categories.map((category, index) => <li key={`${category.name}-${index}`}>
                  {category.name} · {category.tokens.toLocaleString()} tokens
                </li>)}
              </ul>}
            </section>}
            {provider === 'openai-codex' ? <ContextInspectionDetails key={sessionId} sessionId={sessionId} />
              : <ClaudeContextDetails sessionId={sessionId} provider={provider} />}
          </div>
        </section>
      </FloatingFocusManager>
    </FloatingOverlay>
  </FloatingPortal>;
}
