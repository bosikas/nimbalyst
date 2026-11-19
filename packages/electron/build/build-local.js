#!/usr/bin/env node
// Local, sequential builds only. Release scripts retain their existing profile.
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { spawnSync, execFileSync } = require('node:child_process');
const { affectsComponent, runCachedStep } = require('./local-build-cache');

const electronRoot = path.resolve(__dirname, '..');
const root = path.resolve(electronRoot, '../..');
const cacheDir = path.join(electronRoot, 'node_modules/.cache/nimbalyst-local-build');
const args = process.argv.slice(2);
const packageApp = args.includes('--package');
const force = args.includes('--force');
const heapArg = args.find(arg => arg.startsWith('--heap-mb='));
const heapMb = Number(heapArg?.split('=')[1] || 4096);
const only = args.find(arg => arg.startsWith('--only='))?.split('=')[1];
const core = ['main', 'preload', 'renderer', 'workers', 'cloudflare'];
const components = [...core, 'extensions', 'dictation'];
for (const arg of args) {
  if (!['--package', '--force'].includes(arg) && !/^--(heap-mb|only)=/.test(arg)) throw new Error(`Unknown option: ${arg}`);
}
if (!Number.isInteger(heapMb) || heapMb < 1024 || heapMb > 8192) throw new Error('--heap-mb must be an integer from 1024 to 8192');
if (only && !components.includes(only)) throw new Error(`Unknown component: ${only}`);
if (only && packageApp) throw new Error('--only cannot be combined with --package: packaging requires all components');
if (packageApp && process.platform !== 'darwin') throw new Error('--package is a host-architecture macOS build');
if (process.env.OFFICIAL_BUILD === 'true') throw new Error('Use the regular build for official releases');

fs.mkdirSync(path.join(cacheDir, 'logs'), { recursive: true });
const lock = path.join(cacheDir, 'build.lock');
// Never run two builds into the same out/ tree. Interrupted builds leave no
// cached success; a dead owner's lock is recoverable on the next invocation.
try {
  fs.writeFileSync(lock, String(process.pid), { flag: 'wx' });
} catch (error) {
  if (error.code !== 'EEXIST') throw error;
  const owner = Number(fs.readFileSync(lock, 'utf8'));
  if (!Number.isSafeInteger(owner) || owner <= 0) throw new Error(`Invalid build lock: ${lock}`);
  try { process.kill(owner, 0); throw new Error(`Local build ${owner} is already running`); }
  catch (ownerError) { if (ownerError.code !== 'ESRCH') throw ownerError; }
  fs.unlinkSync(lock);
  fs.writeFileSync(lock, String(process.pid), { flag: 'wx' });
}
process.on('exit', () => { if (fs.existsSync(lock) && fs.readFileSync(lock, 'utf8') === String(process.pid)) fs.unlinkSync(lock); });

// Inherited by children. The heap cap is per Node process, not total system RAM.
os.setPriority(0, 10);
const env = {
  ...process.env,
  NODE_ENV: 'production',
  OFFICIAL_BUILD: 'false',
  NIMBALYST_LOCAL_BUILD: '1',
  NIMBALYST_EXTERNAL_RENDERER: '0',
  NODE_OPTIONS: `${(process.env.NODE_OPTIONS || '').replace(/--max[-_]old[-_]space[-_]size(?:=|\s+)\d+/g, '')} --max-old-space-size=${heapMb}`.trim(),
};
delete env.NIMBALYST_LOCAL_COMPONENT;
const stamp = `${Date.now()}-${process.pid}`;
const results = [];

function run(name, command, commandArgs, extraEnv = {}) {
  const log = path.join(cacheDir, 'logs', `${stamp}-${name}.log`);
  console.log(`[local-build] Building ${name}; full log: ${log}`);
  const fd = fs.openSync(log, 'w');
  const started = Date.now();
  let result;
  try {
    const timed = process.platform === 'darwin';
    result = spawnSync(timed ? '/usr/bin/time' : command, timed ? ['-l', command, ...commandArgs] : commandArgs, {
      cwd: electronRoot, env: { ...env, ...extraEnv }, stdio: ['ignore', fd, fd],
    });
  } finally { fs.closeSync(fd); }
  const durationMs = Date.now() - started;
  const contents = fs.readFileSync(log, 'utf8');
  const maxRssBytes = process.platform === 'darwin' ? Number(contents.match(/(\d+)\s+maximum resident set size/)?.[1]) || null : null;
  if (result.error || result.status !== 0) {
    console.error(contents.split('\n').slice(-20).join('\n'));
    throw new Error(`${name} failed (${result.error?.message || result.signal || result.status}); full log: ${log}. No retry with a larger heap was started.`);
  }
  console.log(`[local-build] ${name}: ${(durationMs / 1000).toFixed(1)}s${maxRssBytes ? `; peak RSS ${(maxRssBytes / 1024 ** 2).toFixed(0)} MiB` : ''}`);
  return { durationMs, maxRssBytes, log };
}

function inputs() {
  // Includes uncommitted additions and deletions. Git-ignored generated output
  // is checked separately below, never treated as provenance for a first build.
  const files = execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard', '-z'], { cwd: root, maxBuffer: 32 * 1024 ** 2 }).toString().split('\0').filter(Boolean);
  for (const file of ['node_modules/.modules.yaml', 'node_modules/.pnpm/lock.yaml', 'package-lock.json']) {
    if (fs.existsSync(path.join(root, file))) files.push(file);
  }
  for (const directory of ['', 'packages/electron/']) {
    for (const name of ['.env', '.env.local', '.env.production', '.env.production.local']) {
      const file = directory + name;
      if (fs.existsSync(path.join(root, file))) files.push(file);
    }
  }
  return files;
}

const rel = file => path.relative(root, path.join(electronRoot, file));
const vite = path.join(root, 'node_modules/electron-vite/bin/electron-vite.js');
const plans = core.slice(0, 3).map(name => ({
  name, outputs: [rel(`out/${name}`), rel(`out/${name}/${name === 'renderer' ? 'index.html' : 'index.js'}`),
    path.relative(root, path.join(cacheDir, `${name}-inputs.json`))],
  run: () => run(name, process.execPath, [vite, 'build'], { NIMBALYST_LOCAL_COMPONENT: name }),
}));
plans.push({
  name: 'workers',
  outputs: ['worker', 'sqlite-worker', 'sqlite-verify-worker', 'sqlite-recovery-verify-worker', 'history-diff-worker', 'gif-encode-worker', 'project-manifest-worker'].map(name => rel(`out/${name}.bundle.js`)).concat([rel('out/pglite.wasm'), rel('out/pglite.data')]),
  run: () => run('workers', process.execPath, ['build/build-worker.js']),
}, {
  name: 'cloudflare', outputs: ['packages/cloudflare-sandbox/dist'],
  run: () => run('cloudflare', process.execPath, [path.join(root, 'packages/cloudflare-sandbox/scripts/build-artifact.mjs')]),
});
if (packageApp || only === 'extensions') {
  const outputs = ['packages/extension-sdk/dist'];
  for (const directory of fs.readdirSync(path.join(root, 'packages/extensions'))) {
    const extension = path.join(root, 'packages/extensions', directory);
    const pkgPath = path.join(extension, 'package.json');
    if (!fs.existsSync(pkgPath) || !JSON.parse(fs.readFileSync(pkgPath)).scripts?.build) continue;
    // Hash the full dist plus manifest entrypoints (some extensions emit elsewhere).
    if (fs.existsSync(path.join(extension, 'dist'))) outputs.push(path.relative(root, path.join(extension, 'dist')));
    const manifestPath = path.join(extension, 'manifest.json');
    if (fs.existsSync(manifestPath)) {
      const manifest = JSON.parse(fs.readFileSync(manifestPath));
      for (const field of ['main', 'styles']) if (manifest[field]) outputs.push(path.relative(root, path.join(extension, manifest[field])));
    }
  }
  plans.push({ name: 'extensions', outputs, run: () => run('extensions', process.execPath, ['build/build-extensions.js']) });
}
if (process.platform === 'darwin' && (packageApp || only === 'dictation')) {
  plans.push({ name: 'dictation', outputs: [rel('resources/dictation-helper-bin/nimbalyst-dictation')], run: () => run('dictation', '/bin/bash', ['scripts/build-dictation-helper.sh', '--host']) });
}

function main() {
  console.log(`[local-build] heap=${heapMb} MiB per Node process; nice=${os.getPriority()}; sequential; minification/size reporting off`);
  // These gates are never cached. No packaging command runs on gate failure.
  run('native-check', process.execPath, ['build/verify-native-runtime.js']);
  run('licenses', process.execPath, ['build/generate-third-party-licenses.js', '--check']);
  const cacheFile = path.join(cacheDir, 'state.json');
  const profile = JSON.stringify({ schema: 1, node: process.version, arch: process.arch, platform: process.platform, heapMb,
    viteEnvHash: crypto.createHash('sha256').update(JSON.stringify(Object.entries(env).filter(([key]) => key.startsWith('VITE_')).sort())).digest('hex'),
    installedAt: fs.statSync(path.join(root, 'node_modules')).mtimeMs,
  });
  let state = { profile, steps: {} };
  if (fs.existsSync(cacheFile)) {
    try { const previous = JSON.parse(fs.readFileSync(cacheFile)); if (previous.profile === profile && previous.steps && typeof previous.steps === 'object') state = previous; }
    catch (error) { console.warn(`[local-build] Ignoring unreadable cache: ${error.message}`); }
  }
  const save = () => { fs.writeFileSync(`${cacheFile}.tmp`, JSON.stringify(state, null, 2)); fs.renameSync(`${cacheFile}.tmp`, cacheFile); };
  for (const step of plans.filter(step => !only || step.name === only)) {
    const getInputs = () => {
      const files = inputs().filter(file => affectsComponent(file, step.name));
      if (step.name === 'dictation' && env.NIMBALYST_LOCAL_SWIFT_PROVENANCE) {
        files.push(env.NIMBALYST_LOCAL_SWIFT_PROVENANCE);
      }
      const graph = path.join(cacheDir, `${step.name}-inputs.json`);
      // Rollup's real dependency graph catches cross-layer imports, ignored
      // assets and installed JS dependencies, beyond the conservative groups.
      if (core.slice(0, 3).includes(step.name) && fs.existsSync(graph)) {
        files.push(...JSON.parse(fs.readFileSync(graph)));
      }
      return files;
    };
    const result = runCachedStep({ root, step, inputs: getInputs, cache: state.steps, save, run: step.run, force });
    results.push(result);
    if (result.reused) console.log(`[local-build] Reused ${step.name}: inputs and outputs match`);
  }
  if (packageApp) {
    // Deliberately always run the existing wrapper: extraResources, native ABI,
    // packaged SDK validation and signing hooks remain authoritative.
    run('package', process.execPath, [
      'build/build-with-env.js', '--mac', '--dir', `--${process.arch}`, '--publish', 'never',
      // Own bundle id: sharing com.nimbalyst.electron with Nimbalyst.app mixes their macOS privacy approvals.
      '--config.appId=com.nimbalyst.marilyst',
      '--config.productName=Marilyst', '--config.mac.extendInfo.CFBundleDisplayName=Marilyst',
      '--config.mac.icon=resources/marilyst-icon.icns',
      `--config.electronDist=${path.join(path.dirname(require.resolve('electron/package.json')), 'dist')}`,
      '--config.directories.output=release/marilyst-light',
    ], { SKIP_NOTARIZE: 'true' });
  }
  const report = { profile: JSON.parse(profile), nice: os.getPriority(), results };
  fs.writeFileSync(path.join(cacheDir, 'last-build.json'), JSON.stringify(report, null, 2));
  console.log(`[local-build] Report: ${path.join(cacheDir, 'last-build.json')}`);
}

try { main(); } catch (error) { console.error(`[local-build] ${error.message}`); process.exitCode = 1; }
