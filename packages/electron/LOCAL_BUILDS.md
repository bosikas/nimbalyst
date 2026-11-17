# Lightweight local builds

For this Mac, run from the repository root:

```sh
python3 scripts/rebuild-marilyst.py --install
```

This is the preferred one-command local workflow. It locates Node from `.nvmrc` and the exact cached pnpm version from `package.json`, including pnpm's `.mjs` launcher when Corepack still points at `.cjs`. It checks the Swift compiler/SDK compatibility **before** compiling the app, selects an installed compatible SDK, and applies the established Swift 5 legacy-module-map overlay inside the build cache. It never installs dependencies or modifies the global toolchain or SDK. An unavailable toolchain fails early with an actionable error.

The script delegates compilation and packaging to the lightweight builder below. It keeps the 4 GB Node heap cap, priority 10, sequential component caching, license checks, native checks and packaging hooks. The dictation helper's selected SDK/compiler provenance is hashed with its inputs; its local probe must pass. The final local bundle receives an ad-hoc signature with the existing Electron entitlements, followed by strict recursive verification. This is not a signed/notarized release workflow.

Omit `--install` to build and sign only. Use `--heap-mb=3072` to explicitly try a smaller heap; it never increases the limit on failure. To install the already-built bundle without another build or signature change:

```sh
python3 scripts/rebuild-marilyst.py --install-only
```

Installation stages and verifies a copy, checks its archive against the verified source, preserves the previous `/Applications/Marilyst.app` in a timestamped backup, and restores it if replacement verification fails. Failed/staged bundles remain available as evidence. A lock prevents concurrent replacements; after a killed install, its `.Marilyst-install.lock/owner.json` identifies the staging and backup paths for inspection before recovery. App configuration and user data are untouched. The script never quits, launches or restarts the app. Quit and reopen Marilyst when ready to load the new build. The receipt lives in `packages/electron/node_modules/.cache/nimbalyst-local-build/last-install.json`.

The installed SDK can be selected explicitly with `NIMBALYST_SWIFT_SDK=/path/to/MacOSX.sdk`. The compatibility preflight still applies. No files under `/tmp` are required by this workflow.

Lower-level artifact commands remain available when the shell's Node/pnpm/Swift toolchain is already configured correctly.

Run from `packages/electron`:

```sh
pnpm run build:light
pnpm run build:mac:light
```

`build:light` produces main, preload, renderer, database/media workers and Cloudflare sandbox artifacts. `build:mac:light` also builds extensions and the host-architecture dictation helper, then packages `release/marilyst-light/mac-arm64/Marilyst.app` on Apple Silicon. It does not install, launch, publish or notarize the app. Release commands keep their existing production settings.

The local profile disables JavaScript/CSS minification and compressed-size reporting. It retains production behavior, bundle policies, license validation and native runtime checks. macOS packaging always uses `build-with-env.js`, including extra-resource validation, packaged SDK/native-module checks and signing hooks. It does not bypass tests, Git hooks or release gates.

Builds run sequentially with nice priority 10 and a 4,096 MiB old-generation heap cap per Node process, down from the regular build's 8,192 MiB cap. This is not a limit on total RAM: native allocations, other Node heaps and the app also use memory. A smaller cap can increase garbage collection or cause a build to fail; failures do not trigger an automatic larger-heap retry.

```sh
pnpm run build:light --heap-mb=3072
pnpm run build:light --only=renderer
pnpm run build:light --force
```

Set `NIMBALYST_LOCAL_BUILD_TIMINGS=1` on a build to record where a Vite component spends its time. It writes `node_modules/.cache/nimbalyst-local-build/<component>-timings.json` with transform, render and write phase durations, resident and heap memory at each phase boundary, and per-plugin hook totals, and prints a one-line summary into the component log. Hook totals are inclusive wall-clock time and overlap, so they rank plugins but do not add up to a phase. The variable is off by default and does not change build output or cache reuse; combine it with `--only=renderer --force` to measure a renderer build that would otherwise be reused.

`--only` accepts `main`, `preload`, `renderer`, `workers`, `cloudflare`, `extensions` or `dictation`; partial builds cannot package. The first build must establish its own cache. Existing output is never assumed to match the source.

Subsequent builds hash source contents, filenames, permissions, configuration, lockfiles and output contents. Main/preload/renderer also record Rollup's actual input graph, including ignored assets and installed JS dependencies. A UI-only change leaves main, preload and workers reusable; shared inputs conservatively invalidate dependent components. Missing or modified outputs, source additions/deletions, profile changes and failed/interrupted builds invalidate reuse. The native and license checks run even on an otherwise unchanged build. A lock prevents concurrent lightweight builds; do not run regular builds into the same `out/` directory concurrently.

Use `--force` after manually modifying build tools or native/worker dependencies under `node_modules`. Do not copy cache metadata between checkouts. This is component-level reuse, not an incremental compiler: a changed renderer still requires its whole module graph to be compiled.

Cache, per-step full logs and `last-build.json` live in `node_modules/.cache/nimbalyst-local-build/` inside the Electron package. On macOS each executed step records elapsed time and `/usr/bin/time -l` peak resident memory in bytes. These are process measurements, not total Mac memory usage. Cached steps are marked as reused rather than claiming zero-cost compilation. Compare measurements under similar load before claiming a speedup.

Repeated license verification retains identical inventory bytes when dependency/license evidence has not changed, avoiding timestamp-only source changes and cache invalidation. Changed evidence is regenerated and the normal approval check still runs.
