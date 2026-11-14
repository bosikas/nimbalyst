/** Keep implicit skill triggers intact; long explicit-command help belongs in the loaded skill body. */
export function codexSkillMetadata(workflow: { kind: string; description?: string }, name: string) {
  const original = workflow.description;
  if (workflow.kind !== 'command' || !original || Buffer.byteLength(original, 'utf8') <= 300) {
    return { description: original, details: '' };
  }
  const prefix = `Run /${name}: `;
  let description = prefix;
  for (const char of original.replace(/\s+/g, ' ')) {
    if (Buffer.byteLength(description + char + '…', 'utf8') > 300) break;
    description += char;
  }
  return { description: description + '…', details: `Workflow selection details:\n${original}` };
}
