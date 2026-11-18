// @vitest-environment node
import { expect, it } from 'vitest';
import { instructionTemplate } from '../instructionTemplates';

it('inserts dynamic values literally, including template-looking text, without recursive substitutions', () => {
  const userValue = 'workspace {{0}} $& \\ file';
  expect(instructionTemplate('codex.language', [userValue])).toBe(` Use the preferred language: ${userValue}.`);
  expect(() => instructionTemplate('codex.language')).toThrow('Missing instruction value 0');
});
