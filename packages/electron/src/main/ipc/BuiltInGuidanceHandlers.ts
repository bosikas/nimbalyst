import { safeHandle } from '../utils/ipcRegistry';
import { getAppSetting, setAppSetting, isTrackersAgentToolsEnabled } from '../utils/store';
import { createBuiltInGuidanceService, buildAgentGuidancePreview } from '../services/BuiltInGuidanceService';
import type { AgentSetupProvider } from '@nimbalyst/runtime/ai/builtInGuidance';
import { setBuiltInGuidanceSettingsLoader } from '@nimbalyst/runtime/ai/builtInGuidance';

export function registerBuiltInGuidanceHandlers(): void {
  const service = createBuiltInGuidanceService({
    read: () => getAppSetting('builtInGuidance'),
    write: (settings) => setAppSetting('builtInGuidance', settings),
    readText: () => getAppSetting('builtInGuidanceText'),
    writeText: (text) => setAppSetting('builtInGuidanceText', text),
  });
  setBuiltInGuidanceSettingsLoader(service.getSettings, service.getText);
  safeHandle('agent-guidance:get-catalog', () => service.getCatalog());
  safeHandle('agent-guidance:update', (_event, updates: unknown) => service.update(updates));
  safeHandle('agent-guidance:update-text', (_event, id: unknown, text: unknown) => service.updateText(id, text));
  safeHandle('agent-guidance:preview', (_event, workspacePath: string, provider: AgentSetupProvider) => {
    if (typeof workspacePath !== 'string' || !workspacePath.trim()) throw new Error('A workspace path is required.');
    return buildAgentGuidancePreview(provider, workspacePath, service.getSettings(), service.getText(), isTrackersAgentToolsEnabled(workspacePath));
  });
}
