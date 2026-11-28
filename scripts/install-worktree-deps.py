#!/usr/bin/env python3
"""Install dependencies for this checkout using pnpm's shared package store."""

import argparse
import fcntl
import json
import os
from pathlib import Path
import subprocess
import sys


def primary_checkout(checkout):
    listing = subprocess.run(
        ["git", "worktree", "list", "--porcelain", "-z"],
        cwd=checkout,
        capture_output=True,
        text=True,
        check=True,
    ).stdout
    first, _, remainder = listing.partition("\0")
    if first.startswith("worktree ") and not remainder.startswith("bare\0"):
        return Path(first.removeprefix("worktree "))
    return checkout


def installed_store(checkout):
    modules = checkout / "node_modules"
    if modules.is_symlink():
        return None
    try:
        # pnpm 12 writes JSON to this historically YAML-named file.
        metadata = json.loads((modules / ".modules.yaml").read_text())
    except (FileNotFoundError, json.JSONDecodeError):
        return None
    store = metadata.get("storeDir") if isinstance(metadata, dict) else None
    if isinstance(store, str) and Path(store).is_absolute():
        return Path(store)
    return None


def store_for(checkout):
    existing = installed_store(checkout)
    if existing is not None:
        return existing

    override = os.environ.get("NIMBALYST_PNPM_STORE_DIR")
    if override:
        store = Path(override)
    else:
        primary = primary_checkout(checkout)
        # Under a sandbox, pnpm can fall back to a checkout-local store. Ask
        # from the primary checkout to keep using one store when that happens.
        store = installed_store(primary)
        if store is None or not os.access(store, os.W_OK):
            output = subprocess.check_output(["pnpm", "store", "path"], cwd=primary, text=True)
            store = Path(output.strip().split("\n")[-1].strip())
    if not store.is_absolute():
        raise ValueError("Set NIMBALYST_PNPM_STORE_DIR to an absolute shared pnpm store path.")
    return store


def dependencies_ready(checkout):
    env = os.environ.copy()
    # pnpm disables nested verification in the environment of package scripts.
    env.pop("pnpm_config_verify_deps_before_run", None)
    result = subprocess.run(
        ["pnpm", "--config.verify-deps-before-run=error", "exec", "node", "--version"],
        cwd=checkout,
        capture_output=True,
        text=True,
        env=env,
    )
    if result.returncode == 0:
        return True
    output = (result.stdout + result.stderr).strip()
    if "ERR_PNPM_VERIFY_DEPS_BEFORE_RUN" in output:
        return False
    raise ValueError(output or f"pnpm dependency verification exited {result.returncode}")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--ensure", action="store_true", help="Install only if pnpm reports missing or stale dependencies.")
    args = parser.parse_args()
    checkout = Path(__file__).resolve().parents[1]
    lock_path = checkout / ".cache" / "pnpm-install.lock"
    try:
        lock_path.parent.mkdir(exist_ok=True)
        with lock_path.open("ab") as lock:
            try:
                fcntl.flock(lock, fcntl.LOCK_EX if args.ensure else fcntl.LOCK_EX | fcntl.LOCK_NB)
            except BlockingIOError:
                print("A dependency install is active in this worktree.", file=sys.stderr)
                return os.EX_TEMPFAIL

            if (checkout / "node_modules").is_symlink():
                raise ValueError("node_modules is a symlink. Use a worktree-local dependency tree.")
            if args.ensure and dependencies_ready(checkout):
                return 0
            store = store_for(checkout)
            print(f"pnpm package store: {store}", flush=True)
            result = subprocess.run(
                ["pnpm", "install", "--frozen-lockfile", "--prefer-offline",
                 "--store-dir", str(store)],
                cwd=checkout,
                pass_fds=(lock.fileno(),),
            )
            return result.returncode if result.returncode >= 0 else 128 - result.returncode
    except KeyboardInterrupt:
        return 130
    except (OSError, ValueError, subprocess.CalledProcessError) as error:
        print(f"Worktree dependency install: {error}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main())
