import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { sessionCreationPolicy } from '@nimbalyst/runtime/ai/sessionPolicy';
import { codexProjectRoot } from '@nimbalyst/runtime/ai/server/providers/codex/codexSessionHome';

/** A workspace may tighten the review sandbox, never widen its configured permissions. */
export async function loadPrReviewPreset(workspace: string) {
  const root = await codexProjectRoot(workspace);
  const file = path.join(root, '.nimbalyst', 'pr-review.json');
  const value = JSON.parse(await readFile(file, 'utf8'));
  if (!value || typeof value.model !== 'string' || !/^openai-codex:[\w.-]+$/.test(value.model)
    || typeof value.effortLevel !== 'string' || !value.effortLevel.trim()
    || typeof value.instructionFile !== 'string' || !value.instructionFile.trim()
    || !['read-only', 'workspace'].includes(value.permissions)
    || typeof value.generateSummary !== 'boolean' || !Number.isInteger(value.autoArchiveAfterMinutes)
    || !Array.isArray(value.startupSkills) || !value.startupSkills.every((s: unknown) => typeof s === 'string' && s.trim())) {
    throw new Error(`Invalid PR review preset in ${file}. Check model, effortLevel, instructionFile, permissions, generateSummary, autoArchiveAfterMinutes and startupSkills.`);
  }
  return {
    ...sessionCreationPolicy(value),
    model: value.model as string, effortLevel: value.effortLevel as string,
    instructionFile: path.resolve(root, value.instructionFile),
    skipDefaultInstructions: true, codexPermissions: value.permissions as 'read-only' | 'workspace',
    startupSkills: value.startupSkills as string[], reporting: 'final' as const,
  };
}
