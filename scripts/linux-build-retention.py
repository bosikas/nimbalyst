#!/usr/bin/env python3
"""Reclaim generated files from inactive Linux Nimbalyst build stages."""
import argparse
import fcntl
import os
from pathlib import Path
import re
import shutil
import subprocess
import time


STAGE_NAME = re.compile(r'[0-9a-f]{7,40}(?:[-.][a-zA-Z0-9._-]+)?')
GRACE_SECONDS = 2 * 60 * 60
GIB = 1024 ** 3
LOW_SPACE_GIB = 25


def protected_stages(root, config_home, proc_root=Path('/proc')):
    """Find paths held by this user's processes, launchers, or build pointers."""
    reference = re.compile(re.escape(os.fsencode(root)) + rb'/([a-zA-Z0-9._-]+)')
    protected = set()

    def record(data):
        protected.update(os.fsdecode(name) for name in reference.findall(data))

    launchers = (
        *root.glob('.*-current-build'),
        *((config_home / 'systemd/user').rglob('*.service')),
        *((config_home / 'systemd/user').rglob('*.conf')),
        *((config_home / 'autostart').glob('*.desktop')),
    )
    for launcher in launchers:
        if launcher.is_file():
            record(launcher.read_bytes())

    for process in proc_root.iterdir():
        if not process.name.isdigit():
            continue
        try:
            if process.stat().st_uid != os.getuid():
                continue
            record((process / 'cmdline').read_bytes())
        except OSError:
            continue  # The process can exit while /proc is being read.
        for link in (process / 'cwd', process / 'exe'):
            try:
                record(os.fsencode(link.readlink()))
            except OSError:
                pass
        try:
            for fd in (process / 'fd').iterdir():
                try:
                    record(os.fsencode(fd.readlink()))
                except OSError:
                    pass
        except OSError:
            pass
        try:
            record((process / 'maps').read_bytes())
        except OSError:
            pass
    # The active release's saved service file is an explicit rollback pointer.
    for name in tuple(protected):
        if STAGE_NAME.fullmatch(name):
            for launcher in (root / name).glob('previous-service*'):
                if launcher.is_file():
                    record(launcher.read_bytes())
    return protected


def unpacked_app(stage):
    return stage / 'artifacts/linux-unpacked'


def app_archive(stage):
    return unpacked_app(stage) / 'resources/app.asar'


def verified_rollback(stages, protected):
    verified = [
        stage for stage in stages if stage.name not in protected
        and ((stage / 'verified-commit').is_file() or any(stage.glob('*-verified.sha256')))
        and app_archive(stage).is_file()
    ]
    return max(verified, key=lambda stage: app_archive(stage).stat().st_mtime, default=None)


def stale(stage, now):
    # Removing node_modules changes source/ mtime. Use build outputs and logs
    # so that a dependency cleanup does not make an old package look new.
    paths = (stage, stage / 'source/node_modules', stage / 'artifacts', *stage.glob('*.log'))
    activity = max(path.lstat().st_mtime for path in paths if path.exists())
    return now - activity >= GRACE_SECONDS


def generated_directories(stage):
    source = stage / 'source'
    # Preserve packaged-only stages and anything without the inputs to rebuild it.
    if (source.resolve() != source or not (source / '.git').exists()
            or not (source / 'pnpm-lock.yaml').is_file() or not (source / 'package.json').is_file()):
        return []
    dependencies = source / 'node_modules'
    targets = []
    if (dependencies / '.pnpm').is_dir():
        targets.append(dependencies)
    app = unpacked_app(stage)
    if (app / 'nimbalyst').is_file() and app_archive(stage).is_file():
        targets.append(app)
    return targets


def mounted_below(target):
    for line in Path('/proc/self/mountinfo').read_text().splitlines():
        path = re.sub(r'\\([0-7]{3})', lambda match: chr(int(match[1], 8)), line.split()[4])
        if Path(path).is_relative_to(target):
            return True
    return False


def prune(root, config_home, *, apply, now):
    if not root.exists():
        return 0
    if root.resolve(strict=True) != root or not root.is_dir() or root.stat().st_uid != os.getuid():
        raise RuntimeError(f'Unexpected staging root: {root}')
    with (root / '.retention.lock').open('a') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        stages = [
            entry for entry in root.iterdir() if STAGE_NAME.fullmatch(entry.name)
            and not entry.is_symlink() and entry.is_dir() and entry.stat().st_uid == os.getuid()
        ]
        protected = protected_stages(root, config_home)
        rollback = verified_rollback(stages, protected)
        if rollback:
            protected.add(rollback.name)
        removed = 0
        for stage in sorted(stages):
            if stage.name in protected or not stale(stage, now):
                continue
            for target in generated_directories(stage):
                if (target.resolve(strict=True) != target or target.stat().st_uid != os.getuid()
                        or target.stat().st_dev != root.stat().st_dev or mounted_below(target)):
                    print(f'Skipping unexpected path {target}', flush=True)
                    continue
                if apply and stage.name in protected_stages(root, config_home):
                    break
                print(f'{"Removing" if apply else "Would remove"} {target.relative_to(root)}', flush=True)
                if apply:
                    subprocess.run(['/usr/bin/rm', '-rf', '--one-file-system', '--', target], check=True)
                    removed += 1
        return removed


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    mode = parser.add_mutually_exclusive_group()
    mode.add_argument('--apply', action='store_true', help='Remove generated files instead of listing them')
    mode.add_argument('--check', type=Path, metavar='BUILD_DIR', help='Check free space before building')
    args = parser.parse_args()
    state_home = Path(os.environ.get('XDG_STATE_HOME') or Path.home() / '.local/state')
    config_home = Path(os.environ.get('XDG_CONFIG_HOME') or Path.home() / '.config')
    root = state_home / 'nimbalyst-builds'
    volume = args.check or (root if root.exists() else Path.home())
    before = shutil.disk_usage(volume).free
    if not args.check:
        removed = prune(root, config_home, apply=args.apply, now=time.time())
        after = shutil.disk_usage(volume).free
        if args.apply:
            print(f'Removed {removed} generated directories. {after / GIB:.2f} GiB available '
                  f'({(after - before) / GIB:+.2f} GiB).')
    else:
        after = before
    if after < LOW_SPACE_GIB * GIB:
        print(f'Low disk space on {volume}: {after / GIB:.1f} GiB available. '
              f'Aim for {LOW_SPACE_GIB} GiB before building.')


if __name__ == '__main__':
    main()
