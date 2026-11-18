// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { codexToolExposure } from '../codexToolExposure';
describe('native selective MCP exposure', () => {
  it('passes through the native per-server choices: default, discovery-only and load at startup', () => {
    expect(codexToolExposure('design', {})).toEqual({});
    expect(codexToolExposure('design', { omit_tools_from: [] })).toEqual({ omit_tools_from: [] });
    expect(codexToolExposure('design', { omit_tools_from: ['direct'] })).toEqual({ omit_tools_from: ['direct'] });
    // Omitting the deferred surface makes Codex expose the server's tools directly at thread start.
    expect(codexToolExposure('design', { omit_tools_from: ['deferred', 'deferred'] })).toEqual({ omit_tools_from: ['deferred'] });
  });
  it('protects core interaction and discovery entry points', () => {
    expect(codexToolExposure('nimbalyst', {})).toEqual({});
    expect(codexToolExposure('nimbalyst', { omit_tools_from: ['deferred'] })).toEqual({ omit_tools_from: [] });
    expect(codexToolExposure('nimbalyst', { omit_tools_from: ['direct', 'deferred', 'code_mode'] })).toEqual({ omit_tools_from: [] });
  });
  it('rejects omissions that can leave tools unreachable instead of silently losing capabilities', () => {
    expect(() => codexToolExposure('design', { omit_tools_from: ['direct', 'deferred'] })).toThrow(/both/i);
    expect(() => codexToolExposure('design', { omit_tools_from: ['code_mode'] })).toThrow(/code_mode/);
    expect(() => codexToolExposure('design', { omit_tools_from: ['direct', 'code_mode'] })).toThrow(/code_mode/);
    expect(() => codexToolExposure('design', { omit_tools_from: ['typo'] })).toThrow(/direct.*deferred/);
    expect(() => codexToolExposure('design', { omit_tools_from: 'direct' })).toThrow(/array/i);
  });
});
