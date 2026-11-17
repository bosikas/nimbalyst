// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require_ = createRequire(import.meta.url);
const { localBuildOptions, localBuildTimingsPlugin, fingerprint, runCachedStep, affectsComponent } =require_('../local-build-cache.js');
const temporary: string[] = [];
afterEach(() => { for (const root of temporary.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nim-local-build-'));
  temporary.push(root);
  fs.writeFileSync(path.join(root, 'input.ts'), 'export const value = 1;');
  const cache: Record<string, unknown> = {};
  const run = vi.fn(() => { fs.mkdirSync(path.join(root, 'out'), { recursive: true }); fs.writeFileSync(path.join(root, 'out/index.js'), 'built'); });
  const options = { root, step: { name: 'renderer', outputs: ['out'] }, inputs: ['input.ts'], cache, save: vi.fn(), run };
  return { root, run, options, build: () => runCachedStep(options) };
}

describe('lightweight local builds', () => {
  it('disables minification and compressed size reporting only for the local profile', () => {
    expect(localBuildOptions(true)).toEqual({ minify: false, cssMinify: false, reportCompressedSize: false });
    expect(localBuildOptions(false)).toEqual({});
  });

  it('reuses a successful unchanged build instead of running it again', () => {
    const f = fixture();
    f.build();
    expect(f.build().reused).toBe(true);
    expect(f.run).toHaveBeenCalledTimes(1);
  });

  it('rebuilds changed source even when its timestamp is restored', () => {
    const f = fixture(); f.build();
    const source = path.join(f.root, 'input.ts'); const stat = fs.statSync(source);
    fs.writeFileSync(source, 'export const value = 2;'); fs.utimesSync(source, stat.atime, stat.mtime);
    expect(f.build().reused).toBe(false);
    expect(f.run).toHaveBeenCalledTimes(2);
  });

  it('rebuilds missing, changed or extra output files', () => {
    const f = fixture(); f.build();
    fs.unlinkSync(path.join(f.root, 'out/index.js')); f.build();
    fs.writeFileSync(path.join(f.root, 'out/index.js'), 'other build'); f.build();
    fs.writeFileSync(path.join(f.root, 'out/extra.js'), 'stale'); f.build();
    expect(f.run).toHaveBeenCalledTimes(4);
  });

  it('invalidates cached success before a failed rebuild and propagates the failure', () => {
    const f = fixture(); f.build();
    fs.writeFileSync(path.join(f.root, 'input.ts'), 'changed');
    f.run.mockImplementationOnce(() => { throw new Error('compile failed'); });
    expect(() => f.build()).toThrow('compile failed');
    expect(f.options.cache.renderer).toBeUndefined();
    f.build(); expect(f.run).toHaveBeenCalledTimes(3);
  });

  it('rejects successful commands that leave no required output', () => {
    const f = fixture(); f.run.mockImplementationOnce(() => {});
    expect(() => f.build()).toThrow('required outputs');
    expect(f.options.cache.renderer).toBeUndefined();
  });

  it('fingerprints added and deleted inputs and changed permissions', () => {
    const f = fixture(); const before = fingerprint(f.root, ['input.ts']);
    fs.writeFileSync(path.join(f.root, 'new.ts'), 'new');
    expect(fingerprint(f.root, ['input.ts', 'new.ts'])).not.toBe(before);
    fs.chmodSync(path.join(f.root, 'input.ts'), 0o755);
    expect(fingerprint(f.root, ['input.ts'])).not.toBe(before);
    fs.unlinkSync(path.join(f.root, 'input.ts'));
    expect(fingerprint(f.root, [])).not.toBe(before);
  });

  it('can explicitly force an unchanged rebuild', () => {
    const f = fixture(); f.build();
    runCachedStep({ ...f.options, force: true });
    expect(f.run).toHaveBeenCalledTimes(2);
  });

  it('does not invalidate main/preload/workers for a renderer-only edit', () => {
    const file = 'packages/electron/src/renderer/components/Chat.tsx';
    expect(['main', 'preload', 'workers'].filter(c => affectsComponent(file, c))).toEqual([]);
    expect(affectsComponent(file, 'renderer')).toBe(true);
    for (const component of ['main', 'preload', 'renderer', 'workers']) {
      expect(affectsComponent('packages/runtime/src/ai/provider.ts', component)).toBe(true);
      expect(affectsComponent('pnpm-lock.yaml', component)).toBe(true);
      expect(affectsComponent('packages/electron/src/shared/settings.ts', component)).toBe(true);
    }
    expect(affectsComponent('packages/electron/src/main/leaf.ts', 'renderer')).toBe(true);
  });

  it('does not record success when source changes during compilation', () => {
    const f = fixture();
    f.run.mockImplementationOnce(() => { fs.writeFileSync(path.join(f.root, 'input.ts'), 'edited during build'); });
    expect(() => f.build()).toThrow('inputs changed during the build');
    expect(f.options.cache.renderer).toBeUndefined();
  });

  it('tracks dependencies discovered by the build, including ignored installed files', () => {
    const f = fixture();
    const installed = path.join(f.root, 'installed.js');
    fs.writeFileSync(installed, 'dependency');
    let dependencies = ['input.ts'];
    const original = f.run.getMockImplementation()!;
    f.run.mockImplementation(() => { original(); dependencies = ['input.ts', installed]; });
    const build = () => runCachedStep({ ...f.options, inputs: () => dependencies });
    build(); expect(build().reused).toBe(true);
    fs.writeFileSync(installed, 'modified dependency');
    expect(build().reused).toBe(false);
    expect(f.run).toHaveBeenCalledTimes(2);
  });

  it('reuses native output only while the external SDK/compiler provenance matches', () => {
    const f = fixture();
    const provenance = path.join(f.root, 'dictation-toolchain.json');
    fs.writeFileSync(provenance, JSON.stringify({ sdk: '14.5', compiler: '5.10' }));
    const build = () => runCachedStep({ ...f.options, inputs: () => ['input.ts', provenance] });
    build();
    expect(build().reused).toBe(true);
    fs.writeFileSync(provenance, JSON.stringify({ sdk: '15.0', compiler: '6.0' }));
    expect(build().reused).toBe(false);
    expect(f.run).toHaveBeenCalledTimes(2);
  });

  it('times plugin hooks and phases without changing what the hooks receive, return or throw', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nim-local-timings-'));
    temporary.push(root);
    let clock = 0;
    const timings = localBuildTimingsPlugin('renderer', root, { now: () => clock, memory: () => ({ rss: 7, heapUsed: 3 }) });
    const filter = { id: /\.ts$/ };
    const slow = {
      name: 'slow',
      marker: 'bound',
      transform: { filter, order: 'pre', async handler(this: { marker: string }, code: string) { clock += 40; return `${code}:${this.marker}`; } },
      resolveId(source: string) { clock += 5; return source === 'skip' ? null : `/abs/${source}`; },
      load() { clock += 2; throw new Error('load failed'); },
    };
    const injected = { name: 'inject', transform() { clock += 1; return null; } };
    timings.configResolved({ plugins: [slow, timings, null], build: { rollupOptions: { plugins: [[injected], false] } } });

    timings.buildStart();
    expect(slow.transform.filter).toBe(filter);
    expect(slow.transform.order).toBe('pre');
    expect(await slow.transform.handler.call(slow, 'code')).toBe('code:bound');
    expect(slow.resolveId('a')).toBe('/abs/a');
    expect(slow.resolveId('skip')).toBeNull();
    expect(() => slow.load()).toThrow('load failed');
    expect(injected.transform()).toBeNull();
    timings.moduleParsed();
    timings.buildEnd();
    timings.renderStart(); clock += 30;
    timings.generateBundle(); clock += 4;
    timings.writeBundle();

    const report = JSON.parse(fs.readFileSync(path.join(root, 'renderer-timings.json'), 'utf8'));
    expect(report.modules).toBe(1);
    expect(report.phasesMs).toEqual({ transform: 53, render: 30, write: 4, total: 87 });
    expect(report.hooks).toEqual([
      { hook: 'slow:transform', calls: 1, ms: 40 },
      { hook: 'slow:resolveId', calls: 2, ms: 10 },
      { hook: 'slow:load', calls: 1, ms: 2 },
      { hook: 'inject:transform', calls: 1, ms: 1 },
    ]);
    expect(report.memory[0]).toEqual({ at: 'buildStart', rssBytes: 7, heapUsedBytes: 3 });
  });
});
