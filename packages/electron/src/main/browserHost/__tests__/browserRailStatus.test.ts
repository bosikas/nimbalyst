import { expect, it, vi } from 'vitest';
import { listBackendPanelGutterBadges } from '../../extensions/backendPanelBadges';
import { readBrowserRailStatus } from '../browserRailStatus';

vi.mock('../../extensions/backendPanelBadges', () => ({ listBackendPanelGutterBadges: vi.fn() }));
vi.mock('../../services/ClaudeUsageService', () => ({ claudeUsageService: { getCachedUsage: () => null, refresh: async () => null } }));
vi.mock('../../services/CodexUsageService', () => ({ codexUsageService: { getCachedUsage: () => null, refresh: async () => null } }));
vi.mock('../../services/GeminiUsageService', () => ({ geminiUsageService: { getCachedUsage: () => null, refresh: async () => null } }));
vi.mock('../../services/VibeUsageService', () => ({ readVibeUsage: async () => null }));

it('returns only badges from the browser workspace and preserves unread dots', async () => {
  vi.mocked(listBackendPanelGutterBadges).mockReturnValue([
    { workspacePath: '/other', panelId: 'example.runtime', value: 9, tone: 'warning' },
    { workspacePath: '/open', panelId: 'example.runtime', value: 3, tone: 'warning' },
    { workspacePath: '/open', panelId: 'example.backlog', value: 0, tone: 'default' },
    { workspacePath: '/open', panelId: 'example.archive', value: null, tone: 'default' },
  ]);
  expect((await readBrowserRailStatus(['/open'])).badges).toEqual({
    'example.runtime': { count: 3, tone: 'warning' },
    'example.backlog': { count: 0, tone: 'default' },
  });
});
