import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { readVibeRecordedStartup } from './vibeRecordedStartup';

const groups = [
  ['system', 'System instructions'],
  ['tools', 'Tool definitions'],
  ['skills', 'Skills'],
  ['conversation', 'Conversation'],
] as const;

export async function readVibeContextGroups(providerSessionId: string | undefined) {
  return readContextGroups(vibeSessionDirectory(providerSessionId));
}

function vibeSessionDirectory(
  providerSessionId: string | undefined,
  vibeHome = process.env.VIBE_HOME || join(homedir(), '.vibe'),
) {
  if (!providerSessionId || !/^[\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12}$/i.test(providerSessionId)) return undefined;
  return join(vibeHome, 'logs', 'session', 'unified', providerSessionId);
}

export async function recordedVibeStartup(providerSessionId: string | undefined, maxTextBytes: number) {
  const directory = vibeSessionDirectory(providerSessionId);
  const report = directory && providerSessionId
    ? await readVibeRecordedStartup(directory, providerSessionId, maxTextBytes).catch(() => null)
    : null;
  return {
    report,
    status: report
      ? 'Saved Vibe context and ACP messages from the retained session snapshots.'
      : 'Vibe has no saved startup records available for this session.',
  };
}

async function readContextGroups(directory: string | undefined) {
  if (!directory) return [];
  try {
    // Vibe saves raw character sizes here. Its UI uses them to estimate shares
    // of input context. They are independent of ACP usage_update token counts.
    const path = join(directory, 'context-breakdown.json');
    const values = JSON.parse(await readFile(path, 'utf8')) as Record<string, unknown> | null;
    return groups.flatMap(([key, name]) => {
      const characters = values?.[key];
      return typeof characters === 'number' && Number.isSafeInteger(characters) && characters >= 0
        ? [{ name, characters }]
        : [];
    });
  } catch {
    // Vibe may be writing the snapshot, or the installed version may not save it.
    return [];
  }
}
