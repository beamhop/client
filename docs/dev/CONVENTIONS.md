# Builder conventions (read before writing code)

- Spec: `PLAN.md` (product) and `packages/core/src/*` (contracts). **Do not change `@beamhop/core` contracts silently.** If you truly need a change, make the minimal additive change, and list it under "Core changes" in your final report.
- Language: TypeScript (strict), ESM, Node >= 22. Packages export source: `"exports": { ".": "./src/index.ts" }`. Import siblings as `@beamhop/<name>` (add `"@beamhop/<name>": "workspace:*"` to dependencies). Relative imports use the `.ts` extension.
- Layout per package: `packages/<name>/{package.json,src/index.ts,test/*.test.ts}`. Live/network tests go in `test/*.live.test.ts` (excluded from the default run; run with `pnpm vitest run -c vitest.live.config.ts <path>`).
- Tooling (root): `pnpm run typecheck` (single root tsc), `pnpm run lint` (biome; run `pnpm biome check --write <your dirs>` to autofix), `pnpm vitest run <your dir>`. All three must be green for your packages before you finish. Don't edit root config files (package.json, tsconfig*, biome.json, vitest*.ts) — if you need a change, explain it in your report.
- Dependencies: add to *your* package.json, then `pnpm install` from the repo root. Prefer small, well-maintained deps.
- Tests: vitest. Cover the happy path, error paths and security edges. No `.skip`. Unit tests must not hit the network; use fakes/recorded fixtures.
- Secrets: never print, log or commit secret values. Env available: `OPENROUTER_API_KEY` (cap total live LLM spend for your work at **$1**, use a cheap model such as `openai/gpt-5-mini`, `google/gemini-2.5-flash` or `qwen/qwen3-coder` — check availability), `NOSTR_NSEC` (do not use it for tests — generate throwaway keys).
- Logging: use the `Logger` interface from core (`createLogger`, `silentLogger` in tests). Never log secrets (`redact`).
- Cross-platform: code must work on Linux, macOS and Windows (path handling via `node:path`, no shell-specific syntax; guard platform-specific code by `process.platform`).
- Commit your work in your worktree with clear messages ending with:
  `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`
  Do not push. Do not touch other packages' directories.
- Final report (your last message): branch name, worktree path, what's implemented, what's tested (and how), known gaps/TODOs, core changes, deps added.
