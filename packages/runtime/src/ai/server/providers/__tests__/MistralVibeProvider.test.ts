// @vitest-environment node

import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
import { MistralVibeProvider } from '../MistralVibeProvider';

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
    destroy() {}
  },
}));

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
