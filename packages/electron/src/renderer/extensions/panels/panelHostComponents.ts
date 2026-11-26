import { createElement, type ComponentType } from 'react';
import type { PanelHostComponents, PanelSessionTranscriptProps } from '@nimbalyst/extension-sdk';

/** Bind the host's workspace and services so the panel only supplies a session id. */
export function createPanelHostComponents<Bindings extends object>(
  Transcript: ComponentType<PanelSessionTranscriptProps & Bindings>,
  bindings: Bindings,
): PanelHostComponents {
  const SessionTranscript = (props: PanelSessionTranscriptProps) =>
    createElement(Transcript, { ...props, ...bindings });
  SessionTranscript.displayName = 'PanelHost.SessionTranscript';
  return { SessionTranscript };
}
