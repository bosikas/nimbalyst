import React from 'react';
import { HeadlessCliProviderPanel, type HeadlessCliProviderPanelProps } from './HeadlessCliProviderPanel';

export function MistralVibePanel({ config, onToggle }: Pick<HeadlessCliProviderPanelProps, 'config' | 'onToggle'>) {
  return (
    <HeadlessCliProviderPanel
      config={config}
      onToggle={onToggle}
      toolId="mistral-vibe"
      title="Mistral Vibe"
      description="Use your Mistral subscription and Vibe CLI configuration in Nimbalyst coding sessions."
      commandName="Mistral Vibe"
      loginCommand="vibe --setup"
      docsUrl="https://docs.mistral.ai/vibe/code/cli/install-setup"
      docsLabel="Mistral Vibe CLI documentation"
      usageUrl="https://admin.mistral.ai/subscription"
      fileChangeFidelity="tool-args"
      manualAuthentication
      supportsToolPermissions
    />
  );
}
