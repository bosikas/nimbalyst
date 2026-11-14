// @vitest-environment node
import { expect, it } from 'vitest';
import { codexSkillMetadata } from '../codexSkillMetadata';
it('keeps explicit command discovery compact while retaining full selection details for loading', () => {
  const description = 'Review the working tree; preserve existing fixes. ' + 'Detailed workflow guidance. '.repeat(80);
  const result = codexSkillMetadata({ kind: 'command', description }, 'review');
  expect(Buffer.byteLength(result.description!)).toBeLessThanOrEqual(300);
  expect(result.description).toContain('/review');
  expect(result.details).toContain(description);
  console.info(JSON.stringify({ fixture: 'long explicit command description', beforeBytes: Buffer.byteLength(description), afterBytes: Buffer.byteLength(result.description!) }));
});
it('preserves complete implicit skill triggers, exclusions and short descriptions', () => {
  const description = 'Use for charts. Do not use for tables. ' + 'selection caveat '.repeat(100);
  expect(codexSkillMetadata({ kind: 'skill', description }, 'charts').description).toBe(description);
  expect(codexSkillMetadata({ kind: 'command', description: 'Review code' }, 'review').description).toBe('Review code');
});
