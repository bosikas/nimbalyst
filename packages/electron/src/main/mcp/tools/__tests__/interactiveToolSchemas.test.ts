// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';
vi.mock('@nimbalyst/collab-protocol', () => ({ STRUCTURED_INPUT_FIELD_TYPES: ['multiSelect','singleSelect','reorder','editText','confirm'] }));
import { getInteractiveToolSchemas } from '../interactiveToolSchemas';

describe('interactive tool discovery', () => {
  it('keeps all tools and argument contracts discoverable with compact descriptions', () => {
    const tools = getInteractiveToolSchemas('session');
    expect(tools.map(tool => tool.name)).toEqual(['PromptForUserInput', 'AskUserQuestion', 'developer_git_commit_proposal']);
    const commit = tools[2];
    expect(commit.inputSchema.required).toEqual(['filesToStage', 'commitMessage', 'reasoning']);
    expect(commit.inputSchema.properties).toHaveProperty('excludePaths');
    expect(commit.inputSchema.properties).toHaveProperty('workingDirectory');
    for (const contract of ['get_session_edited_files', 'ALL', '2000', 'ONE REPOSITORY', 'workingDirectory', 'excludePaths']) expect(commit.description).toContain(contract);
    const bytes = Buffer.byteLength(JSON.stringify(tools));
    console.info(JSON.stringify({ interactiveToolSchemaBytes: bytes }));
    expect(bytes).toBeLessThan(7_600);
    expect(getInteractiveToolSchemas(undefined)).toEqual([]);
  });
});
