import React from 'react';

export interface StartupSelection {
  model: string | null;
  effort: string | null;
  thinkingMode: string | null;
}

export interface StartupInstructionSelection {
  fileSelected: boolean;
  filePath: string | null;
  skipDefaultInstructions: boolean;
}

export function StartupSelectionDetails({ selection, instructions }: {
  selection?: StartupSelection;
  instructions?: StartupInstructionSelection | null;
}) {
  if (!selection) return null;
  return <section className="mt-2">
    <h3 className="font-semibold">Session selection</h3>
    <p>Model: {selection.model ?? 'Provider default'} · Effort: {selection.effort ?? 'Provider or app default'}{selection.thinkingMode ? ` · Thinking: ${selection.thinkingMode}` : ''}</p>
    {instructions?.fileSelected && <p>Session instruction file selected{instructions.filePath && <> · <code>{instructions.filePath}</code></>}. Capture of the prepared app guidance is shown below when available.</p>}
    {instructions?.skipDefaultInstructions && <p>Native project instruction discovery was disabled in the session settings.</p>}
  </section>;
}
