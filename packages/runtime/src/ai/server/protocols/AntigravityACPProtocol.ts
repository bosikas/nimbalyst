import { RequestError, type SessionConfigOption } from '@agentclientprotocol/sdk';
import { EFFORT_LEVELS, parseEffortLevel, selectSupportedEffortLevel } from '../effortLevels';
import type { AIModel } from '../types';
import { AcpStdioAgentProtocol, type GrokACPProtocolDeps } from './GrokACPProtocol';
import { mapGrokAcpSessionUpdate } from './headless/GrokBuildRecordMapper';
import { readVibeUsage } from './headless/MistralVibeRecordMapper';

export const ANTIGRAVITY_PROVIDER = 'antigravity-acp';
export const ANTIGRAVITY_EXECUTABLE = process.platform === 'win32' ? 'agy.exe' : 'agy';
export const ANTIGRAVITY_INSTALL_PATHS = process.platform === 'win32'
  ? ['AppData/Local/agy/bin/agy.exe']
  : ['.local/bin/agy'];
export const ANTIGRAVITY_INSTALL_MESSAGE =
  'Install the Google Antigravity CLI, then verify it with `agy --version` and `agy acp --help`.';
export const ANTIGRAVITY_AUTH_MESSAGE =
  'Save a Gemini API key in Antigravity CLI settings in Marilyst. In the CLI settings.json, set modelProvider to gemini.';

const MODEL_PREFIX = `${ANTIGRAVITY_PROVIDER}:`;
export const ANTIGRAVITY_DEFAULT_MODEL = `${MODEL_PREFIX}default`;

function selectOption(config: SessionConfigOption[], category: 'model' | 'thought_level' | 'mode') {
  return config.find((option) =>
    option.type === 'select' && (option.category === category || option.id === category
      || (category === 'thought_level' && option.id === 'thinking')),
  );
}

function choices(option: SessionConfigOption | undefined) {
  return option?.type === 'select'
    ? option.options.flatMap((item) => 'options' in item ? item.options : [item])
    : [];
}

function effortChoices(config: SessionConfigOption[]) {
  const available = choices(selectOption(config, 'thought_level'));
  return EFFORT_LEVELS.flatMap(({ key }) => {
    const option = available.find(({ value, name }) => [value, name].some((label) => {
      const normalized = label.toLowerCase();
      return normalized === key || (key === 'xhigh' && normalized === 'extra');
    }));
    return option ? [{ key, value: option.value }] : [];
  });
}

function model(id: string, name: string, config: SessionConfigOption[]): AIModel {
  const effortLevels = effortChoices(config).map(({ key }) => key);
  return {
    id: `${MODEL_PREFIX}${id}`,
    name,
    provider: ANTIGRAVITY_PROVIDER,
    ...(effortLevels.length && { effortLevels }),
  };
}

export class AntigravityACPProtocol extends AcpStdioAgentProtocol {
  private apiKey?: string;

  constructor(deps?: GrokACPProtocolDeps) {
    super({
      platform: ANTIGRAVITY_PROVIDER,
      displayName: 'Google Antigravity CLI',
      command: ANTIGRAVITY_EXECUTABLE,
      args: ['acp'],
      supportsAttachments: true,
      supportsSseMcp: true,
      resumeWithoutReplay: true,
      authentication: () => {
        if (!this.apiKey) throw new Error(ANTIGRAVITY_AUTH_MESSAGE);
        return {
          methodId: 'gemini-api-key',
          env: {
            GEMINI_API_KEY: this.apiKey,
            AGY_ADC_AUTH: undefined,
            GOOGLE_APPLICATION_CREDENTIALS: undefined,
            GOOGLE_CLOUD_ACCESS_TOKEN: undefined,
            GOOGLE_OAUTH_ACCESS_TOKEN: undefined,
            GOOGLE_GEMINI_BASE_URL: undefined,
          },
        };
      },
      formatError: (error) => {
        if (error instanceof RequestError && error.code === -32000) return ANTIGRAVITY_AUTH_MESSAGE;
        return error instanceof Error ? error.message : String(error);
      },
      mapUpdate: mapGrokAcpSessionUpdate,
      getUsage: readVibeUsage,
      configureSession: async (connection, sessionId, options, initialConfig) => {
        let config = initialConfig;
        const mode = selectOption(config, 'mode');
        // agy can restore a mode from disk. Request the documented approval mode before prompting.
        if (mode?.type === 'select') {
          if (mode.currentValue !== 'default') {
            ({ configOptions: config } = await connection.setSessionConfigOption({
              sessionId, configId: mode.id, value: 'default',
            }));
          }
        } else {
          await connection.setSessionMode({ sessionId, modeId: 'default' });
        }

        const configuredModel = selectOption(config, 'model');
        const wanted = options.model?.startsWith(MODEL_PREFIX)
          ? options.model.slice(MODEL_PREFIX.length)
          : undefined;
        if (wanted && wanted !== 'default') {
          if (configuredModel?.type !== 'select' || !choices(configuredModel).some(({ value }) => value === wanted)) {
            throw new Error(`Google Antigravity CLI did not offer model "${wanted}". Choose a model from the current catalog.`);
          }
          if (configuredModel.currentValue !== wanted) {
            ({ configOptions: config } = await connection.setSessionConfigOption({
              sessionId, configId: configuredModel.id, value: wanted,
            }));
          }
        }
        const effort = selectOption(config, 'thought_level');
        const requestedEffort = options.raw?.effortLevel;
        if (typeof requestedEffort === 'string' && effort?.type === 'select') {
          const levels = effortChoices(config);
          const selected = selectSupportedEffortLevel(parseEffortLevel(requestedEffort), levels.map(({ key }) => key));
          const value = levels.find(({ key }) => key === selected)?.value;
          if (value && value !== effort.currentValue) {
            await connection.setSessionConfigOption({ sessionId, configId: effort.id, value });
          }
        }
        const activeModel = selectOption(config, 'model');
        return activeModel?.type === 'select' ? activeModel.currentValue : undefined;
      },
    }, deps);
  }

  setApiKey(apiKey: string | undefined): void {
    const key = apiKey?.trim();
    if (this.apiKey !== key) {
      this.destroy();
      this.apiKey = key;
    }
  }

  async discoverModels(workspacePath: string): Promise<AIModel[]> {
    const connection = await this.getConnection();
    const session = await connection.newSession({ cwd: workspacePath, mcpServers: [] });
    const config = session.configOptions ?? [];
    const modelOption = selectOption(config, 'model');
    const models = [model('default', 'Google Antigravity CLI (default)', config)];
    for (const { value, name } of choices(modelOption)) {
      if (value === 'default' || modelOption?.type !== 'select') continue;
      const activeConfig = value === modelOption.currentValue
        ? config
        : (await connection.setSessionConfigOption({
          sessionId: session.sessionId, configId: modelOption.id, value,
        })).configOptions;
      models.push(model(value, name, activeConfig));
    }
    return models;
  }
}
