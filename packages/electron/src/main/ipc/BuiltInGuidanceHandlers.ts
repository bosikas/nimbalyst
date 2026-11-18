import { app } from 'electron';
import path from 'path';
import { safeHandle } from '../utils/ipcRegistry';
import { getAppSetting, setAppSetting, isTrackersAgentToolsEnabled, store } from '../utils/store';
import { createBuiltInGuidanceService, buildAgentGuidancePreview } from '../services/BuiltInGuidanceService';
import type { AgentSetupProvider } from '@nimbalyst/runtime/ai/builtInGuidance';
import { setBuiltInGuidanceSettingsLoader } from '@nimbalyst/runtime/ai/builtInGuidance';
import { setCodexBaseInstructionsLoader } from '@nimbalyst/runtime/ai/codexBaseInstructions';

const LEGACY_TEXT_KEY = 'builtInGuidanceText';

export function registerBuiltInGuidanceHandlers(): void {
  const service = createBuiltInGuidanceService({
    read: () => getAppSetting('builtInGuidance'),
    write: (settings) => setAppSetting('builtInGuidance', settings),
    directory: path.join(app.getPath('userData'), 'agent-guidance'),
    readSources: () => getAppSetting('agentGuidanceSources'),
    writeSources: (sources) => setAppSetting('agentGuidanceSources', sources),
    readLegacyText: () => getAppSetting(LEGACY_TEXT_KEY),
    clearLegacyText: () => store.delete(LEGACY_TEXT_KEY as never),
  });
  try {
    const { migrated, backupPath } = service.migrateLegacyText();
    if (migrated.length || backupPath) console.log(`[BuiltInGuidance] Migrated ${migrated.length} custom section(s) to Markdown files; settings backup at ${backupPath ?? 'none'}`);
  } catch (error) {
    // The legacy prose stays in settings and keeps applying; migration retries on the next launch.
    console.error('[BuiltInGuidance] Legacy custom instruction migration failed; legacy text retained:', error);
  }
  setBuiltInGuidanceSettingsLoader(service.getSettings, service.getText);
  setCodexBaseInstructionsLoader(service.loadCodexBaseInstructions);
  safeHandle('agent-guidance:get-catalog', () => service.getCatalog());
  safeHandle('agent-guidance:update', (_event, updates: unknown) => service.update(updates));
  safeHandle('agent-guidance:update-text', (_event, id: unknown, text: unknown) => service.updateText(id, text));
  safeHandle('agent-guidance:select-source', (_event, id: unknown, filePath: unknown) => service.selectSource(id, filePath));
  safeHandle('agent-guidance:get-codex-base', () => service.getCodexBase());
  safeHandle('agent-guidance:update-codex-base', (_event, text: unknown) => service.updateCodexBase(text));
  safeHandle('agent-guidance:select-codex-base-source', (_event, filePath: unknown) => service.selectCodexBaseSource(filePath));
  safeHandle('agent-guidance:preview', (_event, workspacePath: string, provider: AgentSetupProvider) => {
    if (typeof workspacePath !== 'string' || !workspacePath.trim()) throw new Error('A workspace path is required.');
    const base = provider === 'openai-codex' ? service.loadCodexBaseInstructions() : undefined;
    const codexBase = base === undefined ? undefined : { sourcePath: service.getCodexBase().sourcePath!, text: base };
    return buildAgentGuidancePreview(provider, workspacePath, service.getSettings(), service.getText(), isTrackersAgentToolsEnabled(workspacePath), codexBase);
  });
}
