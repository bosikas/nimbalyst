// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { describeToolActivity, findToolActivityTarget, partitionToolActivity, summarizeToolActivity } from '../toolActivity';

const entry = (toolName: string, status = 'completed', extra = {}) => ({
  message: { toolCall: { toolName, status }, ...extra }, isExpanded: false,
});

describe('tool activity disclosure', () => {
  it('describes the real action and target without replacing the original evidence', () => {
    const input = entry('mcp__nimbalyst__session_send_prompt');
    Object.assign(input.message.toolCall!, { arguments: { sessionName: 'PR stack feedback fixes', prompt: 'Review the callback extension and confirm ownership.' } });
    expect(describeToolActivity([input])).toMatchObject({ title: 'Send prompt', target: 'PR stack feedback fixes', preview: 'Review the callback extension and confirm ownership.' });
    expect(input.message.toolCall).toHaveProperty('arguments.prompt', 'Review the callback extension and confirm ownership.');
  });
  it('describes a mixed batch and bounds previews without serializing arbitrary arguments', () => {
    const read = entry('Read');
    Object.assign(read.message.toolCall!, { arguments: { file_path: '/project/toolActivity.ts' } });
    const search = entry('Grep');
    Object.assign(search.message.toolCall!, { arguments: { pattern: 'groupToolActivity' } });
    expect(describeToolActivity([read, read, read, search]).title).toBe('Read 3 files and searched');
    const unknown = entry('future_tool');
    Object.assign(unknown.message.toolCall!, { arguments: { secret: 'do not copy arbitrary inputs' }, result: 'A'.repeat(10000) });
    const result = describeToolActivity([unknown]);
    expect(result.preview.length).toBeLessThanOrEqual(181);
    expect(result.preview).not.toContain('do not copy');
  });
  it('keeps questions, permissions and commit proposals outside collapsed activity in original order', () => {
    const entries = [entry('Read'), entry('Bash'), entry('mcp__nimbalyst-mcp__AskUserQuestion', 'running'), entry('ToolPermission', 'running'), entry('Write'), entry('developer_git_commit_proposal', 'running')];
    const groups = partitionToolActivity(entries);
    expect(groups.map(g => [g.kind, g.entries.map(e => e.message.toolCall?.toolName)])).toEqual([
      ['activity', ['Read', 'Bash']], ['interactive', ['mcp__nimbalyst-mcp__AskUserQuestion']],
      ['interactive', ['ToolPermission']], ['activity', ['Write']], ['interactive', ['developer_git_commit_proposal']],
    ]);
    expect(groups.flatMap(g => g.entries)).toEqual(entries);
  });
  it('never collapses an unrecognised interactive payload or a navigated tool', () => {
    expect(partitionToolActivity([entry('future-prompt', 'running', { interactivePrompt: {} })])[0].kind).toBe('interactive');
    expect(summarizeToolActivity([{ ...entry('Read'), isExpanded: true }], false).open).toBe(true);
  });
  it('reveals tools through their owning virtual row without moving ordinary message targets', () => {
    const entry = { index: 3, message: { toolCall: { providerToolCallId: 'call-3' } } };
    const rows = [{ toolEntries: null }, { toolEntries: [entry] }, { toolEntries: null }, { toolEntries: null }];
    expect(findToolActivityTarget(rows, 3)).toEqual({ owner: 1, entry });
    expect(findToolActivityTarget(rows, 0, 'call-3')).toEqual({ owner: 1, entry });
    expect(findToolActivityTarget(rows, 2)).toBeUndefined();
  });
  it('opens failures and distinguishes live work from interrupted history', () => {
    expect(summarizeToolActivity([entry('Bash', 'error')], false)).toMatchObject({ state: 'error', open: true });
    expect(summarizeToolActivity([entry('Read', 'running')], true)).toMatchObject({ state: 'running', open: true });
    expect(summarizeToolActivity([entry('Read', 'running')], false)).toMatchObject({ state: 'stopped', open: false });
    expect(summarizeToolActivity([entry('Read')], false)).toMatchObject({ state: 'completed', open: false });
  });
});
