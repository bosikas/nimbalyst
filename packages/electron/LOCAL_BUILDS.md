# Lightweight local builds

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

`--only` accepts `main`, `preload`, `renderer`, `workers`, `cloudflare`, `extensions` or `dictation`; partial builds cannot package. The first build must establish its own cache. Existing output is never assumed to match the source.

Subsequent builds hash source contents, filenames, permissions, configuration, lockfiles and output contents. Main/preload/renderer also record Rollup's actual input graph, including ignored assets and installed JS dependencies. A UI-only change leaves main, preload and workers reusable; shared inputs conservatively invalidate dependent components. Missing or modified outputs, source additions/deletions, profile changes and failed/interrupted builds invalidate reuse. The native and license checks run even on an otherwise unchanged build. A lock prevents concurrent lightweight builds; do not run regular builds into the same `out/` directory concurrently.

Use `--force` after manually modifying build tools or native/worker dependencies under `node_modules`. Do not copy cache metadata between checkouts. This is component-level reuse, not an incremental compiler: a changed renderer still requires its whole module graph to be compiled.

Cache, per-step full logs and `last-build.json` live in `node_modules/.cache/nimbalyst-local-build/` inside the Electron package. On macOS each executed step records elapsed time and `/usr/bin/time -l` peak resident memory in bytes. These are process measurements, not total Mac memory usage. Cached steps are marked as reused rather than claiming zero-cost compilation. Compare measurements under similar load before claiming a speedup.
