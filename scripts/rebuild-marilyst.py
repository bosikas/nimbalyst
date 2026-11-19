#!/usr/bin/env python3
"""Local ARM64 build/sign/install entry point. Never launches or restarts the app."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import plistlib
import re
import shutil
import subprocess
import sys
import tempfile
import time

ROOT = Path(__file__).resolve().parents[1]
ELECTRON = ROOT / 'packages/electron'
CACHE = ELECTRON / 'node_modules/.cache/nimbalyst-local-build'
APP = ELECTRON / 'release/marilyst-light/mac-arm64/Marilyst.app'
BUNDLE_ID = 'com.nimbalyst.marilyst'
# Builds before the bundle id split; accepted only for the bundle being replaced.
LEGACY_BUNDLE_ID = 'com.nimbalyst.electron'
# Install work bundles live outside /Applications: every extra copy there shares
# the bundle id and LaunchServices/TCC may attribute permission checks to it.
BACKUP_DIR = Path.home() / 'Library/Caches/Marilyst-backups'
# A stable self-signed identity keeps the designated requirement constant across
# rebuilds, so macOS privacy approvals survive. Ad-hoc signatures change each build.
SIGNING_IDENTITY = 'Marilyst Local Signing'
LOGIN_KEYCHAIN = Path.home() / 'Library/Keychains/login.keychain-db'


def digest(file):
    result = hashlib.sha256()
    with file.open('rb') as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b''):
            result.update(chunk)
    return result.hexdigest()


def bundle_info(app, allowed_ids=(BUNDLE_ID,)):
    with (app / 'Contents/Info.plist').open('rb') as stream:
        info = plistlib.load(stream)
    if info.get('CFBundleIdentifier') not in allowed_ids or info.get('CFBundleName') != 'Marilyst':
        raise RuntimeError(f'Unexpected app identity: {app}')
    return info


def run(command, **kwargs):
    print('+ ' + ' '.join(map(str, command)), flush=True)
    return subprocess.run(list(map(str, command)), check=True, **kwargs)


def signing_identity_exists(check_output=subprocess.check_output):
    # No -v: a self-signed certificate is untrusted but still signs.
    listing = check_output(['/usr/bin/security', 'find-identity', '-p', 'codesigning', LOGIN_KEYCHAIN], text=True)
    return f'"{SIGNING_IDENTITY}"' in listing


def ensure_signing_identity(exists=signing_identity_exists, quiet_run=None):
    """Create the local self-signed code-signing identity once. Returns True when created."""
    if exists():
        return False
    import secrets
    # Not printed: the p12 password is on these command lines.
    quiet_run = quiet_run or (lambda command: subprocess.run(list(map(str, command)), check=True, capture_output=True))
    with tempfile.TemporaryDirectory(prefix='marilyst-signing-') as directory:
        directory = Path(directory)
        config, key, cert, bundle = (directory / n for n in ['openssl.cnf', 'key.pem', 'cert.pem', 'identity.p12'])
        config.write_text('[req]\ndistinguished_name=dn\nprompt=no\n[dn]\nCN=' + SIGNING_IDENTITY + '\n'
                          '[codesign]\nbasicConstraints=critical,CA:false\nkeyUsage=critical,digitalSignature\n'
                          'extendedKeyUsage=critical,codeSigning\n')
        quiet_run(['/usr/bin/openssl', 'req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '3650', '-config', config,
                   '-extensions', 'codesign', '-keyout', key, '-out', cert])
        password = secrets.token_hex(24)
        quiet_run(['/usr/bin/openssl', 'pkcs12', '-export', '-inkey', key, '-in', cert, '-name', SIGNING_IDENTITY,
                   '-out', bundle, '-passout', f'pass:{password}'])
        quiet_run(['/usr/bin/security', 'import', bundle, '-k', LOGIN_KEYCHAIN, '-f', 'pkcs12', '-P', password,
                   '-T', '/usr/bin/codesign'])
    if not exists():
        raise RuntimeError(f'Created "{SIGNING_IDENTITY}" but it is not listed as a code-signing identity')
    print(f'Created code-signing identity "{SIGNING_IDENTITY}" in the login keychain', flush=True)
    return True


def sign_bundle(app):
    run(['/usr/bin/codesign', '--force', '--deep', '--sign', SIGNING_IDENTITY,
         '--entitlements', ELECTRON / 'build/entitlements.mac.plist', app])


def verify_bundle(app):
    info = bundle_info(app)
    executable = app / 'Contents/MacOS' / info['CFBundleExecutable']
    arch = subprocess.check_output(['/usr/bin/lipo', '-archs', executable], text=True).strip()
    if arch != 'arm64':
        raise RuntimeError(f'Expected ARM64 only, found {arch}: {app}')
    run(['/usr/bin/codesign', '--verify', '--deep', '--strict', app])
    archive = app / 'Contents/Resources/app.asar'
    if archive.stat().st_size == 0:
        raise RuntimeError('Empty application archive')
    return digest(archive)


def retry(operation):
    for attempt in range(3):
        try:
            return operation()
        except OSError:
            if attempt == 2:
                raise
            time.sleep(0.2 * (attempt + 1))


def install_app(source, target, verify=verify_bundle, copy=None, rename=os.rename, stamp=None, work_dir=None):
    """Stage and verify first. Never delete an installed, failed or backup bundle."""
    source, target = Path(source).absolute(), Path(target).absolute()
    if target.suffix != '.app' or target.is_symlink() or source.resolve() == target.resolve():
        raise RuntimeError('Installation needs a distinct .app destination, not a symlink')
    if target.resolve().is_relative_to(source.resolve()) or source.resolve().is_relative_to(target.resolve()):
        raise RuntimeError('Source and destination must not contain each other')
    expected = verify(source)
    if target.exists():
        bundle_info(target, allowed_ids=(BUNDLE_ID, LEGACY_BUNDLE_ID))
    work_dir = Path(work_dir or BACKUP_DIR).absolute()
    work_dir.mkdir(parents=True, exist_ok=True)
    if os.stat(work_dir).st_dev != os.stat(target.parent).st_dev:
        # rename() across volumes fails with EXDEV; never fall back to a copy.
        raise RuntimeError(f'{work_dir} and {target.parent} are on different volumes; no files were replaced')
    stamp = stamp or f'{time.strftime("%Y%m%d-%H%M%S")}-{time.time_ns()}-{os.getpid()}'
    stage = work_dir / f'Marilyst-install-{stamp}.app'
    backup = work_dir / f'Marilyst-backup-{stamp}.app'
    failed = work_dir / f'Marilyst-failed-{stamp}.app'
    lock = target.parent / '.Marilyst-install.lock'
    if any(p.exists() for p in [stage, backup, failed]):
        raise RuntimeError('Install paths already exist; no files were replaced')
    lock.mkdir()  # A concurrent or interrupted install fails closed.
    (lock / 'owner.json').write_text(json.dumps({'pid': os.getpid(), 'stage': str(stage), 'backup': str(backup)}))
    moved_old = False
    placed_new = False
    copy = copy or (lambda a, b: run(['/usr/bin/ditto', a, b]))
    try:
        print(f'Staging {source}; rollback bundle: {backup}', flush=True)
        retry(lambda: copy(source, stage))
        if verify(stage) != expected:
            raise RuntimeError(f'Staged application differs from verified source; retained at {stage}')
        try:
            if target.exists():
                print(f'Preserving installed app at {backup}', flush=True)
                retry(lambda: rename(target, backup))
                moved_old = True
            print(f'Replacing {target}; no restart or configuration changes', flush=True)
            retry(lambda: rename(stage, target))
            placed_new = True
            if verify(target) != expected:
                raise RuntimeError('Installed application does not match the staged archive')
        except BaseException:
            print(f'Installation failed; restoring {backup}; new bundle retained at {failed if placed_new else stage}', flush=True)
            if placed_new:
                retry(lambda: rename(target, failed))
            if backup.exists() and not target.exists():
                retry(lambda: rename(backup, target))
            raise
        return {'installed': str(target), 'backup': str(backup) if moved_old else None,
                'asarSha256': expected, 'bundleId': BUNDLE_ID, 'restarted': False}
    finally:
        # Only our tiny lock record is removed; all app/evidence bundles stay.
        (lock / 'owner.json').unlink()
        lock.rmdir()


def choose_pnpm_launcher(version, roots):
    for root in roots:
        for name in ['pnpm.mjs', 'pnpm.cjs', 'pnpm.js']:
            candidate = root / version / 'bin' / name
            if candidate.is_file():
                return candidate
    raise RuntimeError(f'Cached pnpm {version} launcher missing. No packages were installed and no build started.')


def swift_version(text):
    match = re.search(r'Apple Swift version (\d+)\.(\d+)', text)
    return tuple(map(int, match.groups())) if match else None


def sdk_interface(sdk):
    for name in ['arm64e-apple-macos.swiftinterface', 'arm64-apple-macos.swiftinterface']:
        file = sdk / 'usr/lib/swift/Swift.swiftmodule' / name
        if file.is_file():
            return file
    return None


def choose_sdk(compiler, candidates):
    for sdk in candidates:
        interface = sdk_interface(sdk)
        if interface:
            with interface.open() as stream:
                header = ''.join(stream.readline() for _ in range(5))
            version = swift_version(header)
            if version and version <= compiler:
                return sdk
    raise RuntimeError('No SDK compatible with the installed Swift compiler. No build started; set NIMBALYST_SWIFT_SDK to a compatible SDK.')


def write_if_changed(file, contents):
    if not file.exists() or file.read_text() != contents:
        file.write_text(contents)


def prepare_toolchain():
    major = (ROOT / '.nvmrc').read_text().strip().lstrip('v').split('.')[0]
    nvm = Path(os.environ.get('NVM_DIR', str(Path.home() / '.nvm')))
    candidates = list((nvm / 'versions/node').glob(f'v{major}*/bin/node'))
    candidates.sort(key=lambda p: tuple(map(int, p.parent.parent.name[1:].split('.'))), reverse=True)
    current = shutil.which('node')
    if current:
        candidates.insert(0, Path(current))
    node = next((p for p in candidates if subprocess.check_output([p, '--version'], text=True).strip().split('.')[0] == f'v{major}'), None)
    if not node:
        raise RuntimeError(f'Node {major} required by .nvmrc is unavailable. No toolchain was installed.')
    version = json.loads((ROOT / 'package.json').read_text())['packageManager'].split('@', 1)[1]
    roots = [Path.home() / '.cache/node/corepack/v1/pnpm', Path.home() / 'Library/Caches/node/corepack/v1/pnpm']
    if os.environ.get('COREPACK_HOME'):
        roots.insert(0, Path(os.environ['COREPACK_HOME']) / 'v1/pnpm')
    launcher = choose_pnpm_launcher(version, roots)
    actual = subprocess.check_output([node, launcher, '--version'], text=True).strip()
    if actual != version:
        raise RuntimeError(f'pnpm version mismatch: expected {version}, got {actual}')
    compiler_text = subprocess.check_output(['xcrun', 'swiftc', '--version'], text=True, stderr=subprocess.STDOUT)
    compiler = swift_version(compiler_text)
    if not compiler:
        raise RuntimeError('Cannot identify the installed Swift compiler')
    default = Path(subprocess.check_output(['xcrun', '--sdk', 'macosx', '--show-sdk-path'], text=True).strip()).resolve()
    override = os.environ.get('NIMBALYST_SWIFT_SDK')
    installed = {p.resolve() for p in default.parent.glob('MacOSX*.sdk')}
    installed = sorted(installed, key=lambda p: tuple(map(int, re.findall(r'\d+', p.name))), reverse=True)
    candidates = [Path(override).resolve()] if override else [default] + installed
    sdk = choose_sdk(compiler, candidates).resolve()
    compiler_path = Path(subprocess.check_output(['xcrun', '--find', 'swiftc'], text=True).strip())
    legacy_map = compiler_path.parent.parent / 'include/swift/module.modulemap'
    env = {**os.environ, 'NIMBALYST_LOCAL_SWIFT_SDK': str(sdk), 'NIMBALYST_LOCAL_SWIFT_MODULE_CACHE': str(CACHE / 'swift-modules')}
    # Swift 5's CLT module map duplicates the one supplied by the older SDK.
    # Hide that legacy map only for this compiler invocation, never on disk.
    overlay_enabled = compiler[0] == 5 and legacy_map.is_file()
    if overlay_enabled:
        empty = CACHE / 'legacy-swift.modulemap'
        write_if_changed(empty, '// Legacy duplicate module map hidden for this local build.\n')
        overlay = CACHE / 'swift-overlay.json'
        write_if_changed(overlay, json.dumps({'version': 0, 'roots': [{'type': 'file', 'name': str(legacy_map), 'external-contents': str(empty)}]}))
        env['NIMBALYST_LOCAL_SWIFT_OVERLAY'] = str(overlay)
    else:
        env.pop('NIMBALYST_LOCAL_SWIFT_OVERLAY', None)
    provenance = CACHE / 'dictation-toolchain.json'
    write_if_changed(provenance, json.dumps({'compiler': compiler_text, 'compilerPath': str(compiler_path), 'sdk': str(sdk), 'interfaceSha256': digest(sdk_interface(sdk)), 'settingsSha256': digest(sdk / 'SDKSettings.json'), 'legacyOverlay': overlay_enabled, 'overlaySha256': digest(overlay) if overlay_enabled else None, 'emptyModuleMapSha256': digest(empty) if overlay_enabled else None}, sort_keys=True))
    env['NIMBALYST_LOCAL_SWIFT_PROVENANCE'] = str(provenance)
    print(f'Toolchain: {node}; pnpm {version}; Swift {compiler[0]}.{compiler[1]}; SDK {sdk}', flush=True)
    return node, launcher, env


def build(heap_mb):
    node, launcher, env = prepare_toolchain()  # Fail before expensive compilation.
    ensure_signing_identity()
    with tempfile.TemporaryDirectory(prefix='marilyst-build-bin-') as directory:
        # A tiny shell wrapper selects the existing .mjs launcher instead of a
        # dangling Corepack .cjs path. No global configuration is changed.
        import shlex
        wrapper = Path(directory) / 'pnpm'
        wrapper.write_text(f'#!/bin/sh\nexec {shlex.quote(str(node))} {shlex.quote(str(launcher))} "$@"\n')
        wrapper.chmod(0o755)
        env['PATH'] = os.pathsep.join([directory, str(node.parent), env.get('PATH', '')])
        run([node, 'build/build-local.js', '--package', f'--heap-mb={heap_mb}'], cwd=ELECTRON, env=env)
    # Local distribution only: the build wrapper still runs all native/SDK
    # and packaging hooks. Sign after its final mutation of the bundle.
    sign_bundle(APP)
    verify_bundle(APP)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    modes = parser.add_mutually_exclusive_group()
    modes.add_argument('--install', action='store_true', help='Build, sign, verify and replace the installed app')
    modes.add_argument('--install-only', action='store_true', help='Verify/install the existing build without compiling or signing')
    parser.add_argument('--target', type=Path, default=Path('/Applications/Marilyst.app'))
    parser.add_argument('--heap-mb', type=int, default=4096)
    args = parser.parse_args()
    if sys.platform != 'darwin' or os.uname().machine != 'arm64':
        parser.error('This local workflow is for an Apple Silicon Mac')
    if not 1024 <= args.heap_mb <= 8192:
        parser.error('--heap-mb must be between 1024 and 8192')
    os.nice(max(0, 10 - os.getpriority(os.PRIO_PROCESS, 0)))
    CACHE.mkdir(parents=True, exist_ok=True)
    if not args.install_only:
        build(args.heap_mb)
    if args.install or args.install_only:
        receipt = install_app(APP, args.target)
        (CACHE / 'last-install.json').write_text(json.dumps(receipt, indent=2) + '\n')
        print(json.dumps(receipt, indent=2))
    else:
        print(f'Ready: {APP}\nRun with --install-only to replace the installed app without recompiling.')


if __name__ == '__main__':
    try:
        main()
    except Exception as error:
        print(f'Local rebuild failed: {error}', file=sys.stderr)
        sys.exit(1)
