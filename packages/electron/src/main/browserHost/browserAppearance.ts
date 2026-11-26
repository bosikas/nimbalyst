import type { BrowserHostInfo } from '../../shared/browserHost';
import { scanInstalledExtensionManifests } from '../services/extensionInventory';
import { getExtensionEnabled, getTheme, getThemeIsDark } from '../utils/store';

export async function getBrowserAppearance(): Promise<NonNullable<BrowserHostInfo['appearance']>> {
  const theme = getTheme();
  if (theme === 'system' || theme === 'auto' || theme === 'light' || theme === 'dark') {
    return { theme };
  }

  for await (const { id, manifest } of scanInstalledExtensionManifests()) {
    if (!theme.startsWith(`${id}:`) || !getExtensionEnabled(id)) continue;
    const contributions = manifest.contributions?.themes;
    if (!Array.isArray(contributions)) continue;
    const contribution = contributions.find((entry) => entry && `${id}:${entry.id}` === theme);
    if (contribution) return { theme, contribution: { extensionId: id, theme: contribution } };
  }

  return { theme: getThemeIsDark() ? 'dark' : 'light' };
}
