// @vitest-environment node

import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
import { AISessionsRepository } from '../../../../storage/repositories/AISessionsRepository';
import * as mcpServerConfig from '../../services/mcpServerConfig';
import type { DocumentContext } from '../../types';
import { buildCodexSystemPrompt } from '../codex/codexSystemPrompt';
import { MistralVibeProvider } from '../MistralVibeProvider';

it('uses the shared app guidance with Vibe tools and respects the session summary policy', async () => {
  class TestProvider extends MistralVibeProvider {
    guidance(context: DocumentContext, sessionId: string) {
      return this.buildSessionSystemPrompt(context, sessionId);
    }
  }

  const metadata = {
    sessionDirective: 'Use the documented delivery procedure.',
    startupSkills: ['deliver'],
    generateSummary: false,
  };
  const session = vi.spyOn(AISessionsRepository, 'get').mockResolvedValue({
    id: 'vibe-session',
    provider: 'mistral-vibe',
    messages: [],
    createdAt: 0,
    updatedAt: 0,
    metadata,
  });
  const naming = vi.spyOn(mcpServerConfig, 'isInternalMcpServerEnabled').mockReturnValue(true);
  try {
    const context = { worktreePath: '/workspace/topic', hasBeenNamed: true } as DocumentContext;
    const provider = new TestProvider();
    const vibe = await provider.guidance(context, 'vibe-session');
    const codex = buildCodexSystemPrompt({
      documentContext: context,
      isMetaAgent: false,
      workflowPreset: 'default',
      hasOutOfBandNaming: true,
      generateSummary: false,
    });
    for (const section of ['## Interactive input', '## Context and discovery', '## Worktree']) {
      expect(vibe).toContain(section);
      expect(codex).toContain(section);
    }
    expect(vibe).toContain('## Worktree\nWork in /workspace/topic on its branch');
    expect(vibe).toContain('The name is assigned out-of-band');
    expect(vibe).toContain('Review skills: deliver.');
    expect(vibe).toContain('skill.read');
    expect(vibe).toContain('call skill.read with its name and follow the full skill it returns');
    expect(vibe).toContain('A target-not-found result means that edit changed nothing. Keep earlier successful edits.');
    expect(vibe).toContain('Complete the requested edit before updating cross-references.');
    expect(vibe).toContain('load coordinate before spawning or directing Nimbalyst workers');
    expect(vibe).toContain('end your turn so the completion message can resume it');
    expect(codex).not.toContain('call skill.read');
    expect(vibe).toContain(metadata.sessionDirective);
    expect(vibe).not.toContain('functions.exec');
    expect(vibe).not.toContain('search_codex_skills');
    expect(vibe).not.toContain('Before each final response, call update_session_summary');

    metadata.generateSummary = true;
    expect(await provider.guidance(context, 'vibe-session')).toContain(
      'Before each final response, call update_session_summary',
    );
  } finally {
    session.mockRestore();
    naming.mockRestore();
  }
});

const probe = vi.hoisted(() => ({ home: '' }));
vi.mock('../../protocols/MistralVibeACPProtocol', () => ({
  MISTRAL_VIBE_EXECUTABLE: 'vibe-acp',
  MISTRAL_VIBE_INSTALL_PATHS: [],
  MistralVibeACPProtocol: class {
    constructor(options?: { env?: Record<string, string> }) {
      if (options?.env) probe.home = options.env.VIBE_HOME;
    }
    async discoverModels() {
      const config = join(probe.home, 'config.toml');
      expect(await readFile(config, 'utf8')).toBe('active_model = "preferred"\n');
      await writeFile(config, 'active_model = "last-model-in-catalog"\n');
      return [{ id: 'mistral-vibe:discovered', name: 'Discovered', provider: 'mistral-vibe' }];
    }
    async readAccountUsage(workspace: string) {
      expect(workspace).toBe(join(probe.home, 'workspace'));
      expect(await readdir(workspace)).toEqual([]);
      expect(await readFile(join(probe.home, 'config.toml'), 'utf8')).toBe('active_model = "preferred"\n');
      return { utilization: 23.4, resetsAt: '2027-01-01T00:00:00Z' };
    }
    destroy() {}
  },
}));

it('reads Vibe account usage without an active app session', async () => {
  const userHome = await mkdtemp(join(tmpdir(), 'vibe-test-home-'));
  vi.stubEnv('VIBE_HOME', userHome);
  MistralVibeProvider.configureLoaders({
    mcpConfigLoader: null, shellEnvironmentLoader: null, enhancedPathLoader: null,
    executablePathLoader: () => 'vibe-acp',
  });
  try {
    await writeFile(join(userHome, 'config.toml'), 'active_model = "preferred"\n');
    expect(await MistralVibeProvider.readAccountUsage()).toEqual({
      utilization: 23.4, resetsAt: '2027-01-01T00:00:00Z',
    });
    await expect(readdir(probe.home)).rejects.toMatchObject({ code: 'ENOENT' });
  } finally {
    vi.unstubAllEnvs();
    await rm(userHome, { recursive: true, force: true });
  }
});

it('uses the signed-in settings to discover Vibe models without changing the active model', async () => {
  const userHome = await mkdtemp(join(tmpdir(), 'vibe-test-home-'));
  const config = join(userHome, 'config.toml');
  const preferences = 'active_model = "preferred"\n';
  vi.stubEnv('VIBE_HOME', userHome);
  MistralVibeProvider.configureLoaders({
    mcpConfigLoader: null, shellEnvironmentLoader: null, enhancedPathLoader: null,
    executablePathLoader: () => 'vibe-acp',
  });
  try {
    await writeFile(config, preferences);
    expect(await MistralVibeProvider.getModels()).toMatchObject([{ id: 'mistral-vibe:discovered' }]);
    expect(probe.home).not.toBe(userHome);
    expect(await readFile(config, 'utf8')).toBe(preferences);
    await expect(readFile(join(probe.home, 'config.toml'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
  } finally {
    MistralVibeProvider.configureLoaders({
      mcpConfigLoader: null, shellEnvironmentLoader: null, enhancedPathLoader: null, executablePathLoader: null,
    });
    vi.unstubAllEnvs();
    await rm(userHome, { recursive: true, force: true });
  }
});
