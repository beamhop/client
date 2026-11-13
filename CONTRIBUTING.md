# Contributing

Thanks for helping. beamhop is a pnpm monorepo in TypeScript (strict, ESM, Node 22+).

## Setup

```bash
pnpm install
pnpm run check          # secret scan + typecheck + lint + unit tests — must be green
pnpm beamhop --help     # run the CLI from source (tsx)
pnpm dev:daemon         # run the daemon from source
```

Linux needs `bubblewrap socat ripgrep` for the sandbox tests; macOS needs `ripgrep`.

## Layout

```
apps/cli          beamhop CLI (commander); scripts/ builds the npm bundle and the SEA binaries
apps/daemon       beamhopd
apps/pwa          the PWA (Vite)
packages/core     types, plugin SDK, zod API contract — the contracts everything else builds on
packages/*        sandbox, broker, authz, store, mcp, channel-*, harness-*, deploy
packaging/        Homebrew / Scoop / winget templates (rendered per release)
scripts/          repo tooling: check-no-secrets, gen-cli-docs
docs/             user guides; docs/dev/CONVENTIONS.md for contributors
```

Read [docs/dev/CONVENTIONS.md](docs/dev/CONVENTIONS.md) before writing code. The short version:

- Packages export TS source (`"exports": { ".": "./src/index.ts" }`); import siblings as `@beamhop/<name>`.
- `@beamhop/core` contracts don't change silently: additive changes only, called out in the PR.
- Tests: vitest, next to the package in `test/`. Cover the happy path, errors and security edges. Unit
  tests never touch the network; live tests are `*.live.test.ts` (`pnpm vitest run -c vitest.live.config.ts`).
- **No token-shaped literals**, ever — not even fake ones. Build them at runtime:
  `['ghp', 'x'.repeat(36)].join('_')`. `node scripts/check-no-secrets.mjs` (part of `pnpm run check`)
  enforces this; `--staged` works as a pre-commit hook.
- Never log secrets; use the core `Logger` and `redact`.
- Cross-platform: `node:path`, no shell-specific syntax, guard platform code by `process.platform`.

## Changing the CLI

The CLI reference is generated. After touching `apps/cli/src/program.ts`:

```bash
pnpm exec tsx scripts/gen-cli-docs.ts          # rewrites docs/cli.md
```

The release workflow fails if `docs/cli.md` is stale (`--check`).

## Building the distribution

```bash
pnpm --filter beamhop run build     # apps/cli/dist: CLI + daemon + MCP + runtime assets + PWA (esbuild)
pnpm --filter beamhop run smoke     # npm pack → global install into a temp prefix → daemon/status/doctor/harness ls
node apps/cli/scripts/sea.mjs       # dist/standalone/beamhop-<v>-<os>-<arch>/ (Node SEA) + archive
```

Files that workspace code finds with `new URL('../x', import.meta.url)` (the harness catalog, the sandbox
runner, the pi gate extension, the MCP entry, the PWA build) are mirrored under `dist/runtime/<repo path>`,
and the build rewrites `import.meta.url` per module so those lookups resolve inside the package. If you add
such a file, add it to `RUNTIME_FILES` in `apps/cli/scripts/build.mjs` and to the smoke checks. Plugins the
daemon loads dynamically need a literal `import()` in `apps/daemon/src/registry.ts` so the bundler sees
them.

## Versions and releases

beamhop has **one** [semver](https://semver.org/) version for everything it ships: the CLI (npm package and
standalone binary), the daemon, the desktop app and the web UI always carry the same number, and every
`package.json` in the repo holds it. Code reads it from `VERSION` in `@beamhop/core`; never hard-code a
version string.

```bash
node scripts/version.mjs                # print it
node scripts/version.mjs check          # every package.json the same semver version (CI and `pnpm check`)
node scripts/version.mjs patch          # or minor / major / set x.y.z: bumps every package.json together
```

Which bump: **patch** for fixes only; **minor** for new features or (while we are below 1.0) anything that
breaks a config, the API or the CLI; **major** once we are at 1.0 and break something. Every change that
users can notice goes under _Unreleased_ in `CHANGELOG.md` as you make it.

To release: bump with the script, move _Unreleased_ to the new version (with the date) in the changelog,
commit to `main`, then tag `vX.Y.Z` and push the tag. The tag starts `.github/workflows/release.yml`, which
checks it against the version, publishes to npm and builds the signed apps. A build of `main` without a tag
(e.g. a local `dist:dir`) still reports the version in `package.json`.

## Pull requests

- One topic per PR, with tests. Describe user-visible changes in `CHANGELOG.md` under _Unreleased_.
- Security-relevant changes (sandbox, broker, authz, channel parsing): say so in the description and link
  the threat (PLAN §7A).
- Releases: see [Versions and releases](#versions-and-releases).

By contributing you agree that your contributions are licensed under [Apache-2.0](LICENSE).
