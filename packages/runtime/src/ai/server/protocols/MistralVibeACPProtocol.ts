import type { SessionConfigOption } from '@agentclientprotocol/sdk';
import path from 'path';
import { EFFORT_LEVELS, parseEffortLevel, selectSupportedEffortLevel } from '../effortLevels';
import type { AIModel } from '../types';
import { AcpStdioAgentProtocol, type GrokACPProtocolDeps } from './GrokACPProtocol';
import { mapVibeSessionUpdate, readVibeUsage } from './headless/MistralVibeRecordMapper';

export const MISTRAL_VIBE_EXECUTABLE = process.platform === 'win32' ? 'vibe-acp.exe' : 'vibe-acp';
export const MISTRAL_VIBE_INSTALL_PATHS = ['.local/bin/' + MISTRAL_VIBE_EXECUTABLE];
const MODEL_PREFIX = 'mistral-vibe:';

export class MistralVibeACPProtocol extends AcpStdioAgentProtocol {
  constructor(deps?: GrokACPProtocolDeps) {
    super({
      platform: 'mistral-vibe-acp',
      displayName: 'Mistral Vibe',
      command: MISTRAL_VIBE_EXECUTABLE,
      args: [],
      mapUpdate: (update, workspacePath) => mapVibeSessionUpdate(update, (filePath) => path.resolve(workspacePath, filePath)),
      getUsage: readVibeUsage,
      formatError: (error) => {
        const message = error instanceof Error ? error.message : String(error);
        if (/auth required|authentication required|not authenticated|unauthenticated|unauthorized|(?:invalid|missing) api key/i.test(message)) {
          return 'Mistral Vibe is not authenticated. Run `vibe --setup` and sign in with your Mistral account.';
        }
        return message;
      },
      configureSession: async (connection, sessionId, options, config) => {
        // Vibe may start in accept-edits or auto-approve from a previous run.
        // Require its approval callbacks before giving it a project prompt.
        let activeConfig = config;
        if (readConfigValue(activeConfig, 'mode') !== 'ask') {
          const result = await connection.setSessionConfigOption({ sessionId, configId: 'mode', value: 'ask' });
          activeConfig = result.configOptions;
          if (readConfigValue(activeConfig, 'mode') !== 'ask') {
            throw new Error('Mistral Vibe did not enable Ask mode. Update the Vibe CLI before starting a session.');
          }
        }
        const model = readConfigValue(activeConfig, 'model');
        const wanted = options.model?.startsWith(MODEL_PREFIX) ? options.model.slice(MODEL_PREFIX.length) : undefined;
        if (wanted && wanted !== 'default' && wanted !== model) {
          const result = await connection.setSessionConfigOption({ sessionId, configId: 'model', value: wanted });
          activeConfig = result.configOptions;
        }
        const thinking = findSelect(activeConfig, 'thinking');
        const { effortLevels, supportsThinkingOff } = thinkingOptions(activeConfig);
        const requestedEffort = options.raw?.effortLevel;
        // Keep Vibe's setting when the caller has no reasoning preference.
        const effort = supportsThinkingOff && options.raw?.thinkingMode === 'disabled'
          ? 'off'
          : requestedEffort !== undefined || options.raw?.thinkingMode === 'enabled'
            ? selectSupportedEffortLevel(parseEffortLevel(requestedEffort), effortLevels)
            : undefined;
        if (thinking && effort && effort !== thinking.currentValue) {
          const result = await connection.setSessionConfigOption({ sessionId, configId: thinking.id, value: effort });
          if (readConfigValue(result.configOptions, 'thinking') !== effort) {
            throw new Error(`Mistral Vibe did not apply ${effort} thinking effort.`);
          }
          activeConfig = result.configOptions;
        }
        const selected = readConfigValue(activeConfig, 'model');
        return selected ? MODEL_PREFIX + selected : undefined;
      },
      supportsFork: true,
      supportsAttachments: true,
      supportsSseMcp: false,
    }, deps);
  }

  /** Query the CLI's workspace catalog without starting a model turn. */
  async discoverModels(workspacePath: string): Promise<AIModel[]> {
    const connection = await this.getConnection();
    const session = await connection.newSession({ cwd: workspacePath, mcpServers: [] });
    const configOptions = session.configOptions ?? [];
    const currentModel = readConfigValue(configOptions, 'model');
    const models = [vibeModel('default', 'Mistral Vibe (CLI default)', configOptions)];
    for (const { value, name } of selectChoices(configOptions, 'model')) {
      if (value === 'default') continue;
      let choices = configOptions;
      if (value !== currentModel) {
        try {
          ({ configOptions: choices } = await connection.setSessionConfigOption({
            sessionId: session.sessionId, configId: 'model', value,
          }));
        } catch {
          continue;
        }
      }
      models.push(vibeModel(value, name, choices));
    }
    return models;
  }
}

function findSelect(config: SessionConfigOption[], id: string) {
  return config.find(
    (entry): entry is Extract<SessionConfigOption, { type: 'select' }> => entry.id === id && entry.type === 'select',
  );
}

function readConfigValue(config: SessionConfigOption[], id: string): string | undefined {
  const option = findSelect(config, id);
  return typeof option?.currentValue === 'string' ? option.currentValue : undefined;
}

function selectChoices(config: SessionConfigOption[], id: string) {
  const option = findSelect(config, id);
  return option?.options.flatMap((choice) => 'options' in choice ? choice.options : [choice]) ?? [];
}

function thinkingOptions(config: SessionConfigOption[]) {
  const choices = selectChoices(config, 'thinking');
  return {
    effortLevels: EFFORT_LEVELS.filter(({ key }) => choices.some(({ value }) => value === key)).map(({ key }) => key),
    supportsThinkingOff: choices.some(({ value }) => value === 'off'),
  };
}

function vibeModel(id: string, name: string, config: SessionConfigOption[]): AIModel {
  return { id: MODEL_PREFIX + id, name, provider: 'mistral-vibe', ...thinkingOptions(config) };
}
