// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { setIcon, electronApp } = vi.hoisted(() => {
  const setIcon = vi.fn();
  return { setIcon, electronApp: { isPackaged: false, dock: { setIcon }, getAppPath: () => '/app' } };
});

vi.mock('electron', () => ({
  app: electronApp,
  nativeImage: { createFromPath: (p: string) => ({ path: p }) },
}));
vi.mock('fs', () => ({ existsSync: () => true }));
vi.mock('../logger', () => ({ logger: { main: { warn: vi.fn() } } }));

import { applyDockIcon } from '../dockIcon';

describe('applyDockIcon', () => {
  const platform = process.platform;
  beforeEach(() => {
    setIcon.mockReset();
    Object.defineProperty(process, 'platform', { value: 'darwin' });
  });
  afterEach(() => Object.defineProperty(process, 'platform', { value: platform }));

  it('keeps the bundle icon of a packaged build so per-build icons show in the Dock', () => {
    electronApp.isPackaged = true;
    applyDockIcon();
    expect(setIcon).not.toHaveBeenCalled();
  });

  it('sets icon.png in dev, where the app runs out of Electron.app', () => {
    electronApp.isPackaged = false;
    applyDockIcon();
    expect(setIcon).toHaveBeenCalledWith({ path: '/app/icon.png' });
  });
});
