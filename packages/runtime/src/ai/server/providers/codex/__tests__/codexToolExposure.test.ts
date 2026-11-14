import { describe, expect, it } from 'vitest';
import { codexToolExposure } from '../codexToolExposure';
describe('native selective MCP exposure', () => {
  it('honors explicit native deferral while leaving tools registered and searchable', () => {
    expect(codexToolExposure('design', { omit_tools_from: ['direct'] })).toEqual({ omit_tools_from: ['direct'] });
    expect(codexToolExposure('design', {})).toEqual({});
    expect(codexToolExposure('design', { omit_tools_from: [] })).toEqual({ omit_tools_from: [] });
  });
  it('protects core interaction and discovery entry points', () => {
    expect(codexToolExposure('nimbalyst', {})).toEqual({});
    expect(codexToolExposure('nimbalyst', { omit_tools_from: ['direct', 'deferred', 'code_mode'] })).toEqual({ omit_tools_from: [] });
  });
  it('rejects hiding discovery surfaces instead of silently losing configured capabilities', () => {
    expect(() => codexToolExposure('design', { omit_tools_from: ['direct', 'deferred'] })).toThrow(/discovery/i);
    expect(() => codexToolExposure('design', { omit_tools_from: 'direct' })).toThrow(/array/i);
  });
});
