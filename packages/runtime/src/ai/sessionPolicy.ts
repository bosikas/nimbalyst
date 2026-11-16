/** Host policies are independent of whether their captions are visible. */
export interface SessionPolicy {
  generateSummary: boolean;
  /** Zero disables automatic archival. */
  autoArchiveAfterMinutes: number;
}

export function readSessionPolicy(value: unknown): SessionPolicy {
  if (typeof value === 'string') {
    try { return readSessionPolicy(JSON.parse(value)); } catch { return { generateSummary: false, autoArchiveAfterMinutes: 0 }; }
  }
  const input = value && typeof value === 'object' ? value as Record<string, unknown> : {};
  return {
    generateSummary: input.generateSummary === undefined || input.generateSummary === true,
    autoArchiveAfterMinutes: Number.isSafeInteger(input.autoArchiveAfterMinutes) && Number(input.autoArchiveAfterMinutes) >= 0
      ? Number(input.autoArchiveAfterMinutes) : 0,
  };
}

export function sessionPolicyPatch(value: unknown): Partial<SessionPolicy> {
  const input = value && typeof value === 'object' ? value as Record<string, unknown> : {};
  const result: Partial<SessionPolicy> = {};
  if (input.generateSummary !== undefined) {
    if (typeof input.generateSummary !== 'boolean') throw new Error('generateSummary must be a boolean.');
    result.generateSummary = input.generateSummary;
  }
  if (input.autoArchiveAfterMinutes !== undefined) {
    if (!Number.isSafeInteger(input.autoArchiveAfterMinutes) || Number(input.autoArchiveAfterMinutes) < 0 || Number(input.autoArchiveAfterMinutes) > 525600)
      throw new Error('autoArchiveAfterMinutes must be a whole number from 0 to 525600; 0 disables archival.');
    result.autoArchiveAfterMinutes = Number(input.autoArchiveAfterMinutes);
  }
  return result;
}

export function sessionCreationPolicy(value: unknown): SessionPolicy {
  return { generateSummary: true, autoArchiveAfterMinutes: 0, ...sessionPolicyPatch(value) };
}
