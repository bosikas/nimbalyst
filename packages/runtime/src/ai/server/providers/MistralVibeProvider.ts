import { DEFAULT_MODELS } from '../../modelConstants';
import {
  MISTRAL_VIBE_EXECUTABLE,
  MISTRAL_VIBE_INSTALL_PATHS,
  MistralVibeACPProtocol,
} from '../protocols/MistralVibeACPProtocol';
import type { AIModel } from '../types';
import {
  HeadlessCliAgentProvider,
  type HeadlessCliAgentDescriptor,
  type HeadlessCliEnvironmentLoaders,
} from './HeadlessCliAgentProvider';

export class MistralVibeProvider extends HeadlessCliAgentProvider {
  private static loaders: HeadlessCliEnvironmentLoaders = {
    mcpConfigLoader: null,
    shellEnvironmentLoader: null,
    enhancedPathLoader: null,
    executablePathLoader: null,
  };

  static configureLoaders(loaders: HeadlessCliEnvironmentLoaders): void {
    this.loaders = loaders;
  }

  static async getModels(workspacePath = process.cwd()): Promise<AIModel[]> {
    const fallback: AIModel[] = [{
      id: DEFAULT_MODELS['mistral-vibe'],
      name: 'Mistral Vibe (CLI default)',
      provider: 'mistral-vibe',
    }];
    const provider = new MistralVibeProvider();
    const executable = provider.resolveExecutable();
    if (!executable) return fallback;
    const protocol = new MistralVibeACPProtocol({ command: executable, env: provider.buildChildEnvironment() });
    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        protocol.discoverModels(workspacePath),
        new Promise<AIModel[]>((resolve) => {
          timeout = setTimeout(() => resolve(fallback), 8_000);
        }),
      ]);
    } catch {
      return fallback;
    } finally {
      clearTimeout(timeout);
      protocol.destroy();
    }
  }

  protected readonly descriptor: HeadlessCliAgentDescriptor = {
    providerName: 'mistral-vibe',
    displayName: 'Mistral Vibe',
    description: 'Mistral Vibe coding agent over the Agent Client Protocol',
    executableName: MISTRAL_VIBE_EXECUTABLE,
    homeRelativeInstallPaths: MISTRAL_VIBE_INSTALL_PATHS,
    notInstalledMessage: 'Mistral Vibe is not installed. Install the Vibe CLI, then run `vibe --setup` to sign in.',
    notLoggedInMessage: 'Mistral Vibe is not signed in. Run `vibe --setup` and sign in with your Mistral account.',
    permissionModeMessage: 'Mistral Vibe could not request workspace permission.',
    supportsToolPermissions: true,
  };

  protected readonly protocol = new MistralVibeACPProtocol({
    onPermissionRequest: (request) => this.handleProtocolPermissionRequest(request),
  });

  constructor() {
    super(MistralVibeProvider.loaders);
  }

  protected getLoaders(): HeadlessCliEnvironmentLoaders {
    return MistralVibeProvider.loaders;
  }

  protected configureProtocol(executablePath: string, env: Record<string, string> | null): void {
    this.protocol.setExecutablePath(executablePath);
    this.protocol.setProcessEnv(env);
  }

  async compactSession(
    sessionId: string,
    options?: { workspacePath?: string; permissionsPath?: string; providerSessionId?: string },
  ): Promise<void> {
    const workspacePath = options?.workspacePath;
    const providerSessionId = this.sessions.getSessionId(sessionId) || options?.providerSessionId;
    if (!workspacePath || !providerSessionId) {
      throw new Error('Cannot compact before Mistral Vibe has started a session.');
    }
    if (this.abortController) throw new Error('Wait for the active Mistral Vibe turn to finish before compacting.');

    const permission = this.requestTurnPermission(workspacePath, options.permissionsPath);
    if (permission.decision !== 'allow') throw new Error(permission.reason ?? 'Workspace permission denied.');

    this.configureProtocol(this.resolveExecutable() ?? MISTRAL_VIBE_EXECUTABLE, this.buildChildEnvironment());
    const abortController = new AbortController();
    this.abortController = abortController;
    try {
      const mcpServers = await this.mcpConfigService.getMcpServersConfig({
        sessionId,
        workspacePath: options.permissionsPath ?? workspacePath,
        profile: 'standard',
      });
      const session = await this.protocol.resumeSession(providerSessionId, {
        workspacePath,
        mcpServers,
        raw: { permissionsPath: options.permissionsPath },
      });
      let compacted = false;
      for await (const event of this.protocol.sendMessage(session, {
        content: '/compact',
        sessionId,
        abortSignal: abortController.signal,
      })) {
        if (event.type === 'error') throw new Error(event.error ?? 'Mistral Vibe compaction failed.');
        if (event.metadata?.contextCompacted === true) compacted = true;
      }
      if (!compacted) throw new Error('Mistral Vibe did not confirm compaction.');
    } finally {
      if (this.abortController === abortController) this.abortController = null;
    }
  }

  protected getDefaultModelId(): string {
    return DEFAULT_MODELS['mistral-vibe'];
  }
}
