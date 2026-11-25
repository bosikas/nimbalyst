// @vitest-environment node
import { describe, expect, it, vi } from "vitest";

import { buildSessionMetaToolSchemas, dispatchSessionMetaTool, setUpdateSessionSummaryFn, setUpdateSessionTitleFn, setUpdateSessionMetadataFn, setGetSessionTitleFn, setGetSessionTagsFn, setGetSessionPhaseFn } from "../sessionNamingServer";
import { CORE_TOOLS, CORE_ALWAYS_LOAD_TOOLS } from '@nimbalyst/runtime/ai/server/services/mcpTopology';

describe("buildSessionMetaToolSchemas", () => {
  it("keeps the eager schema byte-stable across sessions and tag mutations", async () => {
    const before = await buildSessionMetaToolSchemas("session-before-tags");
    const after = await buildSessionMetaToolSchemas("session-after-tags");

    expect(JSON.stringify(after)).toBe(JSON.stringify(before));

    const addDescription = before[0].inputSchema.properties.add.description;
    expect(addDescription).toContain("2–4 lowercase hyphen-separated work and area tags");
    expect(addDescription).toContain("uncommitted after edits");
    expect(addDescription).not.toMatch(/\(\d+\)/);
  });

  it('registers summary submission on core without expanding the always-loaded set', async () => {
    const schemas = await buildSessionMetaToolSchemas('caller-session');
    const summary = schemas.find(tool => tool.name === 'update_session_summary');
    expect(summary.inputSchema.required).toEqual(['scope', 'remaining', 'attention', 'areas']);
    expect(summary.inputSchema.properties.work).toMatchObject({ type: 'array', maxItems: 25 });
    expect(CORE_TOOLS).toContain(summary.name);
    expect(CORE_ALWAYS_LOAD_TOOLS).not.toContain(summary.name);
  });

  it('uses the authenticated calling session and reports invalid submissions as errors', async () => {
    const submit = vi.fn().mockResolvedValue('Updated');
    setUpdateSessionSummaryFn(submit);
    const args = { scope: 'Navigation', sessionId: 'forged-peer', work: [{ action: 'put', key: 'review', text: 'Review the navigation' }] };
    expect(await dispatchSessionMetaTool('mcp__nimbalyst__update_session_summary', args, 'caller-session')).toMatchObject({ isError: false });
    expect(submit).toHaveBeenCalledWith('caller-session', args);
    submit.mockRejectedValueOnce(new Error('Invalid summary'));
    expect(await dispatchSessionMetaTool('update_session_summary', {}, 'caller-session')).toMatchObject({ isError: true });
  });

  it('avoids writes for unchanged tags and phases while preserving explicit changes', async () => {
    let title = 'Assigned worker';
    let tags = ['runtime'];
    let phase = 'planning';
    const updateTitle = vi.fn(async (_id: string, value: string) => { title = value; });
    const updateMetadata = vi.fn(async (_id: string, value: Record<string, unknown>) => {
      if (value.tags) tags = value.tags as string[];
      if (value.phase) phase = value.phase as string;
    });
    setUpdateSessionTitleFn(updateTitle);
    setUpdateSessionMetadataFn(updateMetadata);
    setGetSessionTitleFn(async () => title);
    setGetSessionTagsFn(async () => tags);
    setGetSessionPhaseFn(async () => phase);
    const unchanged = await dispatchSessionMetaTool('update_session_meta', { add: ['runtime'], remove: ['missing'], phase }, 'caller');
    expect(unchanged.isError).toBe(false);
    expect(updateTitle).not.toHaveBeenCalled();
    expect(updateMetadata).not.toHaveBeenCalled();
    await dispatchSessionMetaTool('update_session_meta', { phase }, 'caller');
    expect(updateMetadata).not.toHaveBeenCalled();
    await dispatchSessionMetaTool('update_session_meta', { name: 'Requested rename', add: ['bug-fix'], phase: 'implementing' }, 'caller');
    expect(updateTitle).toHaveBeenCalledWith('caller', 'Requested rename');
    expect(updateMetadata).toHaveBeenCalledExactlyOnceWith('caller', { tags: ['runtime', 'bug-fix'], phase: 'implementing' });
  });

  it('still applies an explicit first name matching the provisional title so the host marks it named', async () => {
    const updateTitle = vi.fn(async () => {});
    setUpdateSessionTitleFn(updateTitle);
    setGetSessionTitleFn(async () => 'Provisional title');
    await dispatchSessionMetaTool('update_session_meta', { name: 'Provisional title' }, 'caller');
    expect(updateTitle).toHaveBeenCalledWith('caller', 'Provisional title');
  });
});
