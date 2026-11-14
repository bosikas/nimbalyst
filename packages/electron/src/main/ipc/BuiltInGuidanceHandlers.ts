import { safeHandle } from '../utils/ipcRegistry';
import { getAppSetting, setAppSetting } from '../utils/store';
import { createBuiltInGuidanceService } from '../services/BuiltInGuidanceService';
import { setBuiltInGuidanceSettingsLoader } from '@nimbalyst/runtime/ai/builtInGuidance';

export function registerBuiltInGuidanceHandlers(): void {
  const service = createBuiltInGuidanceService({
    read: () => getAppSetting('builtInGuidance'),
    write: (settings) => setAppSetting('builtInGuidance', settings),
  });
  setBuiltInGuidanceSettingsLoader(service.getSettings);
  safeHandle('agent-guidance:get-catalog', () => service.getCatalog());
  safeHandle('agent-guidance:update', (_event, updates: unknown) => service.update(updates));
}
