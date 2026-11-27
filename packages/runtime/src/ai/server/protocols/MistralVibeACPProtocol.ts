import { RequestError, type ClientSideConnection, type SessionConfigOption } from '@agentclientprotocol/sdk';
import { execFile } from 'node:child_process';
import { realpath } from 'node:fs/promises';
import { promisify } from 'node:util';
import path from 'path';
import { EFFORT_LEVELS, parseEffortLevel, selectSupportedEffortLevel } from '../effortLevels';
import type { AIModel } from '../types';
import { recordVibePreparedContext } from '../providers/vibeContextInspection';
import { AcpStdioAgentProtocol, type GrokACPProtocolDeps } from './GrokACPProtocol';
import type { ProtocolMessage, ProtocolSession, SessionOptions } from './ProtocolInterface';
import { resolveVibeSteeringLaunch } from './headless/vibeSteeringLauncher';
import { mapVibeSessionUpdate, readVibeUsage } from './headless/MistralVibeRecordMapper';

export const MISTRAL_VIBE_EXECUTABLE = process.platform === 'win32' ? 'vibe-acp.exe' : 'vibe-acp';
export const MISTRAL_VIBE_INSTALL_PATHS = ['.local/bin/' + MISTRAL_VIBE_EXECUTABLE];
const MODEL_PREFIX = 'mistral-vibe:';
const execFileAsync = promisify(execFile);

export interface MistralVibeAccountUsage {
  utilization: number;
  resetsAt: string | null;
}

interface VibeTrustStatus {
  trust_status?: string;
  details?: {
    cwd?: string;
    repoExplicitlyUntrusted?: boolean;
    availableDecisions?: string[];
  } | null;
}

async function findRegisteredWorktree(workspacePath: string, projectPath: unknown) {
  if (typeof projectPath !== 'string' || projectPath === workspacePath) return;
  try {
    const [cwd, primaryCheckout] = await Promise.all([realpath(workspacePath), realpath(projectPath)]);
    if (cwd === primaryCheckout) return;
    // Read registrations from the source repo, whose path comes from the host session.
    const { stdout } = await execFileAsync('git', [
      '-C', primaryCheckout, 'worktree', 'list', '--porcelain', '-z',
    ]);
    const entries = stdout.split('\0');
    if (entries[0] === `worktree ${primaryCheckout}` && entries.includes(`worktree ${cwd}`)) {
      return { cwd, primaryCheckout };
    }
  } catch {
    // Git may be unavailable, or this may be a workspace outside a repository.
  }
  return undefined;
}

async function inheritWorktreeTrust(connection: ClientSideConnection, cwd: string, primaryCheckout: string) {
  let source: VibeTrustStatus;
  try {
    source = await connection.extMethod('_trust/status', { cwd: primaryCheckout }) as VibeTrustStatus;
  } catch (error) {
    if (error instanceof RequestError && error.code === -32601) return false;
    throw error;
  }
  if (source.trust_status !== 'trusted') return false;

  const target = await connection.extMethod('_trust/status', { cwd }) as VibeTrustStatus;
  const details = target.details;
  if (target.trust_status !== 'untrusted' || details?.cwd !== cwd
    || details.repoExplicitlyUntrusted !== false || !details.availableDecisions?.includes('trust_cwd')) {
    return false;
  }

  // Vibe pins the trust decision to an existing session's cwd. Use a session
  // with no turns or host tools so the real session can start with native hooks.
  const { sessionId } = await connection.newSession({ cwd, mcpServers: [] });
  const decision = await connection.extMethod('_trust/decision', { sessionId, cwd, decision: 'trust_cwd' }) as VibeTrustStatus;
  if (decision.trust_status !== 'trusted') {
    throw new Error(`Mistral Vibe could not activate project configuration for ${cwd}.`);
  }
  return true;
}

export class MistralVibeACPProtocol extends AcpStdioAgentProtocol {
  private static latestAccountProtocol?: WeakRef<MistralVibeACPProtocol>;
  private accountSession?: { connection: ClientSideConnection; id: string };

  static async readAccountUsage(): Promise<MistralVibeAccountUsage | null> {
    const session = this.latestAccountProtocol?.deref()?.accountSession;
    if (!session) return null;
    try {
      const { budget } = await session.connection.extMethod('_account/read', { sessionId: session.id }) as {
        budget?: { usage_percentage?: unknown; reset_at?: unknown } | null;
      };
      const utilization = budget?.usage_percentage;
      if (typeof utilization !== 'number' || !Number.isFinite(utilization) || utilization < 0) return null;
      const reset = budget?.reset_at;
      return { utilization, resetsAt: typeof reset === 'string' && Number.isFinite(Date.parse(reset)) ? reset : null };
    } catch {
      return null;
    }
  }

  constructor(deps?: GrokACPProtocolDeps) {
    super({
      platform: 'mistral-vibe-acp',
      displayName: 'Mistral Vibe',
      command: MISTRAL_VIBE_EXECUTABLE,
      args: [],
      mapUpdate: (update, workspacePath) => mapVibeSessionUpdate(update, (filePath) => path.resolve(workspacePath, filePath)),
      getUsage: readVibeUsage,
      onPromptPrepared: recordVibePreparedContext,
      resolveLaunch: resolveVibeSteeringLaunch,
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

  async steerTurn(sessionId: string, messageId: string, message: ProtocolMessage): Promise<'accepted' | 'unavailable' | 'unsupported'> {
    const prompt = await this.buildPromptBlocks(message);
    try {
      const result = await this.requestActiveTurnExtension(sessionId, '_nimbalyst/steer', { messageId, prompt });
      if (result === undefined || result.accepted === false) return 'unavailable';
      if (result.accepted === true) return 'accepted';
      throw new Error('Vibe did not confirm steering delivery');
    } catch (error) {
      if (error instanceof RequestError && error.code === -32601) return 'unsupported';
      throw error;
    }
  }

  /** Query the CLI's workspace catalog without starting a model turn. */
  override async createSession(options: SessionOptions): Promise<ProtocolSession> {
    await this.prepareWorktree(options);
    const session = await super.createSession(options);
    return this.rememberAccountSession(session);
  }

  override async resumeSession(sessionId: string, options: SessionOptions): Promise<ProtocolSession> {
    await this.prepareWorktree(options);
    const session = await super.resumeSession(sessionId, options);
    return this.rememberAccountSession(session);
  }

  private async rememberAccountSession(session: ProtocolSession): Promise<ProtocolSession> {
    const connection = await this.getConnection();
    this.accountSession = { connection, id: session.id };
    MistralVibeACPProtocol.latestAccountProtocol = new WeakRef(this);
    return session;
  }

  override destroy(): void {
    this.accountSession = undefined;
    super.destroy();
  }

  private async prepareWorktree(options: SessionOptions): Promise<void> {
    const worktree = await findRegisteredWorktree(options.workspacePath, options.raw?.permissionsPath);
    if (!worktree) return;

    const connection = await this.getConnection();
    if (await inheritWorktreeTrust(connection, worktree.cwd, worktree.primaryCheckout)) {
      // A previously loaded session can retain the untrusted hook registry.
      // Reconnect before starting or loading the real session.
      this.destroy();
    }
  }

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
