// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';
import { createCodexSkillsService } from '../CodexSkillsService';

function fixture() {
  const skills = [
    { name: 'one', path: '/skills/one/SKILL.md', description: 'First', scope: 'user', enabled: true },
    { name: 'two', path: '/skills/two/SKILL.md', description: 'Second', scope: 'repo', enabled: false },
  ];
  const request = vi.fn(async (method: string, params: any) => {
    if (method === 'skills/list') return { data: [{ cwd: '/workspace', skills, errors: [] }] };
    if (method === 'skills/config/write') skills.find(s => s.path === params.path)!.enabled = params.enabled;
    return {};
  });
  const read = vi.fn(async () => '規則\n'.repeat(150));
  return { skills, request, read, service: createCodexSkillsService({ request } as any, read) };
}

describe('native individual skill controls', () => {
  it('uses native path selectors, retains disabled skills for discovery, and verifies the effective value', async () => {
    const { service, request } = fixture();
    const result = await service.setEnabled('/workspace', '/skills/one/SKILL.md', false);
    expect(request).toHaveBeenCalledWith('skills/config/write', { path: '/skills/one/SKILL.md', enabled: false });
    expect(result.skills.map(s => [s.name, s.enabled])).toEqual([['one', false], ['two', false]]);
  });
  it('rejects stale/unlisted paths before reading or writing files and surfaces native errors', async () => {
    const { service, request, read } = fixture();
    await expect(service.setEnabled('/workspace', '/arbitrary/SKILL.md', false)).rejects.toThrow(/catalog/);
    await expect(service.preview('/workspace', '/arbitrary/SKILL.md')).rejects.toThrow(/catalog/);
    expect(read).not.toHaveBeenCalled();
    expect(request.mock.calls.some(([method]) => method === 'skills/config/write')).toBe(false);
    request.mockImplementation(async () => { throw new Error('unsupported native RPC'); });
    await expect(service.list('/workspace')).rejects.toThrow(/unsupported/);
  });
  it('bounds skill previews with a recoverable full-output file', async () => {
    const { service } = fixture();
    const text = await service.preview('/workspace', '/skills/one/SKILL.md');
    expect(text.split('\n').length).toBeLessThanOrEqual(100);
    expect(Buffer.byteLength(text)).toBeLessThanOrEqual(24000);
    expect(text).toContain('Full output saved to:');
    const file = text.match(/Full output saved to: (.+)/)![1];
    const { readFile } = await import('node:fs/promises');
    expect(await readFile(file, 'utf8')).toBe('規則\n'.repeat(150));
  });
  it('reports partial native discovery and rejects a write whose effective value did not change', async () => {
    const skills = [{ name: 'fixture', path: '/skills/SKILL.md', enabled: true, description: 'Fixture', scope: 'user' }];
    const request = vi.fn(async (method: string) => {
      if (method === 'plugin/reconcile') throw new Error('offline');
      if (method === 'skills/list') return { data: [{ skills, errors: [] }] };
      return {};
    });
    const service = createCodexSkillsService({ request } as any);
    expect((await service.list('/workspace')).errors[0].message).toContain('discovery may be incomplete');
    await expect(service.setEnabled('/workspace', '/skills/SKILL.md', false)).rejects.toThrow(/effective/);
    expect((await service.list('/workspace')).skills[0].enabled).toBe(true);
  });
  it('serializes workspace-scoped roots so concurrent catalogs cannot mix their generated skills', async () => {
    let root = '';
    const request = vi.fn(async (method: string, params: any) => {
      if (method === 'skills/extraRoots/set') root = params.extraRoots[0];
      if (method === 'skills/list') {
        await new Promise(resolve => setTimeout(resolve, 1));
        expect(root.startsWith(params.cwds[0] + '/')).toBe(true);
        return { data: [{ skills: [], errors: [] }] };
      }
      return {};
    });
    const service = createCodexSkillsService({ request } as any);
    await Promise.all([service.list('/first'), service.list('/second')]);
    expect(request.mock.calls.filter(([method]) => method === 'skills/list').map(([, params]) => params.cwds)).toEqual([['/first'], ['/second']]);
  });
});
