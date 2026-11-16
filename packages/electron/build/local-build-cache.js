const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

function localBuildOptions(enabled) {
  return enabled ? { minify: false, cssMinify: false, reportCompressedSize: false } : {};
}

function localBuildInputsPlugin(component, cacheDirectory) {
  return {
    name: 'local-build-inputs',
    writeBundle() {
      const files = [...new Set([...this.getModuleIds(), ...this.getWatchFiles()])]
        .map(file => file.split('?')[0])
        .filter(file => path.isAbsolute(file) && fs.existsSync(file) && fs.statSync(file).isFile())
        .sort();
      fs.mkdirSync(cacheDirectory, { recursive: true });
      fs.writeFileSync(path.join(cacheDirectory, `${component}-inputs.json`), JSON.stringify(files));
    },
  };
}

// Includes filenames, contents, permissions and symlink destinations. Removed or
// added files invalidate the fingerprint too; timestamps alone are insufficient.
function fingerprint(root, files) {
  const hash = crypto.createHash('sha256');
  for (const file of [...new Set(files)].sort()) {
    const absolute = path.resolve(root, file);
    hash.update(JSON.stringify(file));
    if (!fs.existsSync(absolute)) { hash.update('missing'); continue; }
    const stat = fs.lstatSync(absolute);
    hash.update(String(stat.mode));
    if (stat.isSymbolicLink()) hash.update(fs.readlinkSync(absolute));
    hash.update(fs.readFileSync(absolute));
  }
  return hash.digest('hex');
}

function outputFiles(root, outputs) {
  const files = [];
  function visit(file) {
    const absolute = path.resolve(root, file);
    if (!fs.existsSync(absolute)) return;
    if (fs.lstatSync(absolute).isDirectory()) {
      for (const name of fs.readdirSync(absolute).sort()) visit(path.join(file, name));
    } else files.push(file);
  }
  for (const output of outputs) visit(output);
  return files;
}

function outputFingerprint(root, outputs) {
  if (outputs.some(file => !fs.existsSync(path.resolve(root, file)))) return null;
  const files = outputFiles(root, outputs);
  return files.length ? fingerprint(root, files) : null;
}

function runCachedStep({ root, step, inputs, cache, save, run, force = false }) {
  const getInputs = typeof inputs === 'function' ? inputs : () => inputs;
  const originalInputs = getInputs();
  const inputHash = fingerprint(root, originalInputs);
  const previous = cache[step.name];
  if (!force && previous?.inputHash === inputHash && previous.outputHash === outputFingerprint(root, step.outputs)) {
    return { name: step.name, reused: true };
  }
  delete cache[step.name];
  save();
  const measurement = run(step);
  if (fingerprint(root, originalInputs) !== inputHash) throw new Error(`${step.name} inputs changed during the build; rerun before packaging`);
  const outputHash = outputFingerprint(root, step.outputs);
  if (!outputHash) throw new Error(`${step.name} did not produce its required outputs`);
  cache[step.name] = { inputHash: fingerprint(root, getInputs()), outputHash };
  save();
  return { name: step.name, reused: false, ...measurement };
}

// Shared workspace code is deliberately conservative. A renderer edit cannot
// invalidate main/preload/workers, but shared/config/dependency edits can.
function affectsComponent(file, component) {
  const electron = 'packages/electron/';
  if (/(^|\/)(__tests__|node_modules|out|dist|release|coverage)\//.test(file) || /\.(test|spec)\.[^/]+$/.test(file)) return false;
  if (file.startsWith('docs/') || /(^|\/)(CLAUDE|AGENTS)\.md$/.test(file)) return false;
  if (file.startsWith(`${electron}src/`)) {
    if (component === 'extensions') return true;
    if (file.startsWith(`${electron}src/shared/`)) return true;
    if (component === 'workers') return file.startsWith(`${electron}src/main/`);
    // Renderer code can import main/preload leaf modules; retain those inputs.
    if (component === 'renderer') return true;
    return file.startsWith(`${electron}src/${component}/`);
  }
  if (file.startsWith(`${electron}native/`)) return component === 'dictation';
  if (file.startsWith(`${electron}resources/dictation-helper-bin/`)) return false;
  if (file.startsWith(`${electron}resources/generated/`)) return false;
  if (component === 'dictation') return file.startsWith(`${electron}scripts/build-dictation-helper`) || /(^|\/)package\.json$/.test(file) || file.endsWith('pnpm-lock.yaml');
  if (file.startsWith('packages/cloudflare-sandbox/')) return component === 'cloudflare';
  if (component === 'cloudflare') return !file.startsWith('packages/') || /(^|\/)package\.json$/.test(file);
  // Package source, build plugins, assets and root configuration are shared
  // dependencies unless classified above. Unknown inputs rebuild, not reuse.
  return true;
}

module.exports = { localBuildOptions, localBuildInputsPlugin, fingerprint, outputFiles, outputFingerprint, runCachedStep, affectsComponent };
