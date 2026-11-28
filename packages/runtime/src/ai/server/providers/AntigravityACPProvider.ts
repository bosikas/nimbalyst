import {
  ANTIGRAVITY_AUTH_MESSAGE,
  ANTIGRAVITY_DEFAULT_MODEL,
  ANTIGRAVITY_EXECUTABLE,
  ANTIGRAVITY_INSTALL_MESSAGE,
  ANTIGRAVITY_INSTALL_PATHS,
  ANTIGRAVITY_PROVIDER,
  AntigravityACPProtocol,
} from '../protocols/AntigravityACPProtocol';
import type { AIModel } from '../types';
import type { AcpFormElicitationHandler } from '../protocols/GrokACPProtocol';
import {
  HeadlessCliAgentProvider,
  type HeadlessCliAgentDescriptor,
  type HeadlessCliEnvironmentLoaders,
} from './HeadlessCliAgentProvider';

export class AntigravityACPProvider extends HeadlessCliAgentProvider {
  private static formElicitationHandler?: AcpFormElicitationHandler;
  private static loaders: HeadlessCliEnvironmentLoaders = {
    mcpConfigLoader: null,
    shellEnvironmentLoader: null,
    enhancedPathLoader: null,
    executablePathLoader: null,
  };

  static configureLoaders(loaders: HeadlessCliEnvironmentLoaders): void {
    this.loaders = loaders;
  }

  static setFormElicitationHandler(handler: AcpFormElicitationHandler): void {
    this.formElicitationHandler = handler;
  }

  static async getModels(apiKey?: string, workspacePath = process.cwd()): Promise<AIModel[]> {
    if (!apiKey?.trim()) return [];
    const provider = new AntigravityACPProvider();
    const executable = provider.resolveExecutable();
    if (!executable) throw new Error(ANTIGRAVITY_INSTALL_MESSAGE);

    provider.protocol.setApiKey(apiKey);
    provider.protocol.setExecutablePath(executable);
    provider.protocol.setProcessEnv(provider.buildChildEnvironment());
    try {
      return await provider.protocol.discoverModels(workspacePath);
    } finally {
      provider.protocol.destroy();
    }
  }

  static async checkSetup(apiKey?: string, workspacePath?: string): Promise<void> {
    const provider = new AntigravityACPProvider();
    if (!provider.resolveExecutable()) throw new Error(ANTIGRAVITY_INSTALL_MESSAGE);
    if (!apiKey?.trim()) throw new Error(ANTIGRAVITY_AUTH_MESSAGE);
    await this.getModels(apiKey, workspacePath);
  }

  protected readonly descriptor: HeadlessCliAgentDescriptor = {
    providerName: ANTIGRAVITY_PROVIDER,
    displayName: 'Google Antigravity CLI',
    description: 'Google Antigravity CLI over ACP with Gemini API key authentication',
    executableName: ANTIGRAVITY_EXECUTABLE,
    homeRelativeInstallPaths: ANTIGRAVITY_INSTALL_PATHS,
    notInstalledMessage: ANTIGRAVITY_INSTALL_MESSAGE,
    notLoggedInMessage: ANTIGRAVITY_AUTH_MESSAGE,
    permissionModeMessage: 'Google Antigravity CLI could not request workspace permission.',
    supportsToolPermissions: true,
    streamedAssistantText: true,
  };

  protected readonly protocol = new AntigravityACPProtocol({
    onPermissionRequest: (request) => this.handleProtocolPermissionRequest(request),
    onFormElicitation: AntigravityACPProvider.formElicitationHandler,
  });

  constructor() {
    super(AntigravityACPProvider.loaders);
  }

  protected getLoaders(): HeadlessCliEnvironmentLoaders {
    return AntigravityACPProvider.loaders;
  }

  protected configureProtocol(executablePath: string, env: Record<string, string> | null): void {
    this.protocol.setExecutablePath(executablePath);
    this.protocol.setProcessEnv(env);
    this.protocol.setApiKey(this.config?.apiKey);
  }

  protected getDefaultModelId(): string {
    return ANTIGRAVITY_DEFAULT_MODEL;
  }
}
