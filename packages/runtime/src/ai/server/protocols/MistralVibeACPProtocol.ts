import type { SessionConfigOption } from '@agentclientprotocol/sdk';
import path from 'path';
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
          const selected = readConfigValue(result.configOptions, 'model');
          return selected ? MODEL_PREFIX + selected : undefined;
        }
        return model ? MODEL_PREFIX + model : undefined;
      },
      supportsFork: true,
      supportsAttachments: true,
      supportsSseMcp: false,
    }, deps);
  }
}

function readConfigValue(config: SessionConfigOption[], id: string): string | undefined {
  const option = config.find((entry) => entry.id === id && entry.type === 'select');
  return typeof option?.currentValue === 'string' ? option.currentValue : undefined;
}
