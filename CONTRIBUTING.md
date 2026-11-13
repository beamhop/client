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

## Pull requests

- One topic per PR, with tests. Describe user-visible changes in `CHANGELOG.md` under _Unreleased_.
- Security-relevant changes (sandbox, broker, authz, channel parsing): say so in the description and link
  the threat (PLAN §7A).
- Releases: bump `apps/cli/package.json` `version`, move _Unreleased_ to the new version in the changelog,
  tag `vX.Y.Z`. `.github/workflows/release.yml` does the rest.

By contributing you agree that your contributions are licensed under [Apache-2.0](LICENSE).
