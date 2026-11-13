# Desktop app without a terminal

Status: plan, agreed 2026-11-13. Ships as one release.

## Principle

Someone using the desktop app never needs a terminal. Every place the app now says "run this command"
gets a button that does the job, with progress the user can see. People who want a terminal already use
the CLI; the app does not push them toward it.

The browser UI (`beamhop ui`) and paired phones keep working as they do now. Anything that runs a program
on the computer works only from that computer.

## Decisions

| Topic | Decision |
| --- | --- |
| Installing a missing harness | The app runs the install itself. It tries the harness's own standalone installer first (when the catalog has one), then Homebrew, then npm. If none of these work, it explains why and links to the vendor's install page. |
| Updating a harness | An Update button that uses the same machinery as Install. Updates happen only when the user asks; the app never updates a harness on its own. |
| Harness login ("Run: codex login") | The app runs the login itself, with no visible terminal: it opens the browser for the sign-in step and watches for success. |
| Who can install or log in | Only the desktop app on that computer (`caller === 'local'`). A phone shows the status and "Open beamhop on your computer to install". |
| Progress while it runs | Plain steps ("Downloading…", "Verifying…", "Ready"), a Cancel button, and a collapsed "Show details" with the raw output. |
| Doctor fixes that need admin rights | A Fix button that runs a fixed command through the OS's own admin prompt (the macOS admin dialog, `pkexec` on Linux). beamhop never sees the password. |
| "run `beamhop init`", "`beamhop resume`", etc. | Become buttons that do the same thing. Desktop wording never mentions a command. |
| ~30 "CLI equivalent" strips | Hidden in the desktop app. Settings → Advanced → "Show command-line equivalents" brings them back. |
| `beamhop` command in PATH | Off by default: Settings → Advanced → "Install the `beamhop` command". Nothing is installed automatically, and no shell profile is touched unless the user asks. (Replaces the auto-install from commit 7e502d5.) |

## Design

### 1. How the UI knows it is in the desktop app

- Add a preload script (`apps/desktop/src/preload.ts`, loaded with `contextIsolation` and `sandbox`
  left on). Through `contextBridge` it exposes a small `window.beamhopDesktop`:
  - `{ version, platform }`
  - `cli.status() / cli.install() / cli.uninstall()`: IPC to the main process, which uses
    `cli-install.ts`.
  - `daemon.restart()`, `openLog()`: IPC to the supervisor.
- In the PWA, `lib/desktop.ts` provides `isDesktop()` and a `useDesktop()` hook. In the browser or on a
  phone, `window.beamhopDesktop` doesn't exist and nothing changes.
- This flag only changes what the UI looks like. Security comes from the daemon: every new method that
  runs a program accepts only `ctx.caller === 'local'` (the API token on this computer) and refuses
  paired devices with `forbidden`.

### 2. "CLI equivalent" strips

- Add a `useShowCli()` hook: true outside the desktop app; inside it, true only when Settings → Advanced
  → "Show command-line equivalents" is on (stored per window in localStorage).
- `CliStrip`, `States`, `ScreenStub`, `agents/parts.tsx` and every `cli=` prop render nothing when
  `useShowCli()` is false. The strip components check it once, so screens need no changes.
- Remove the Harnesses install sheet's `CommandLine` blocks in the desktop app. The commands remain under
  "Show details" (see 4).

### 3. Command messages become actions

| Where | Now | Desktop |
| --- | --- | --- |
| `IdentitySection` no owner key | "run `beamhop init`" | **Create owner key** button (`identity.ownerCreate`) |
| `StepChecks` daemon unreachable | "is `beamhop daemon` running?" | **Restart beamhop** (`beamhopDesktop.daemon.restart`) + **Open log** |
| `StepChecks` failing rows | "or run `beamhop doctor --fix`" | **Fix** per row / **Fix all** (see 6) |
| Stop everything dialog (main.ts) | "Resume later … with `beamhop resume`" | "Resume from the banner or the menu bar"; add **Resume** to the tray when paused (`system.resume`) |
| `Unpaired`, demo banner, `Connection` mock | "`beamhop ui`" | Can't happen in the desktop app: it always opens signed in. Show **Restart beamhop** in case it does. |
| `SecretsSection` | "reads the value from stdin" | The existing form; the strip hides with the rest |
| Harness rows `needs-login` | "Run: codex login" | **Log in** (see 5) |
| Harness rows `not-installed` | Install sheet with commands | **Install** (see 4) |

Wording: every `t(...)` string that contains a command gets a desktop version with no command in it.
`useShowCli()` decides which one to show.

### 4. Installing and updating harnesses

**Catalog** (`packages/harness-catalog`, signed): add a standalone installer per platform.

```ts
install: {
  npm?, brew?, winget?, url?,               // as now
  native?: {                                // new, optional
    darwin?: NativeInstaller; linux?: NativeInstaller; win32?: NativeInstaller;
  },
}
type NativeInstaller =
  | { kind: 'archive'; url: string; sha256: Record<string /* arch */, string>; bin: string } // preferred
  | { kind: 'script'; url: string };        // the vendor's own installer script (e.g. Claude Code)
```

`archive` pins an exact file and checks its sha256. `script` is allowed only for vendor URLs listed in
the signed catalog, and it runs without sudo.

**Which method to use** (`packages/harness-discovery/src/install.ts`, new): try `native` for this platform,
then `brew` if `brew` is on the shell PATH, then `npm` if `npm` is on the shell PATH. If none applies,
return `{ method: 'none', url }`, and the sheet explains in plain words with a link to the vendor page.

**Where it installs:**
- **brew:** installs as normal.
- **npm:** `npm i -g --prefix ~/.beamhop/harnesses/npm <pkg>`. This never needs root, avoids EACCES with a
  root-owned system Node, and leaves the user's own global packages alone.
- **native archives:** unpacked into `~/.beamhop/harnesses/<id>/`.

Discovery adds both folders to its search path. Uninstall only removes what beamhop installed.

**Daemon methods** (all require `local`):
- `harness.install { id, method? }` and `harness.update { id }` return a `HarnessJob`; clients poll `harness.job.get { jobId, since }` (the CLI has no event stream). The job runs with the
  login shell's environment, one job per harness at a time.
- `harness.job.cancel { jobId }`, `harness.job.list` kills the job's whole process group and cleans up a half-finished
  install.
- Steps: `resolving`, `downloading`, `verifying`, `installing`, `checking`, `waiting-browser`, `done`, `failed`, `cancelled`, plus a plain-language `message`.
- After the install, it re-scans: `done` means the harness now shows as installed.
- `harness.updates` reports newer versions from `npm view`, `brew info --json` or the catalog's release
  feed. It runs when the Harnesses screen opens and is cached for a day.

**UI:**
- Install and Update buttons appear on harness rows (Harnesses, onboarding step 02, New agent).
- While a job runs, the row shows the progress line, a Cancel button and "Show details" (the raw output,
  copyable).
- Errors are explained in plain words. For example: "Homebrew is busy with another install. Try again
  in a minute."
- On a phone the buttons are disabled, with "Open beamhop on your computer".

### 5. Logging in without a terminal

Sandboxed agents use the logins beamhop stores (vault methods: API key, Claude subscription token,
import from `gh`). These already work in the app and stay the first choice. The no-terminal login covers
what's left:

- **Claude subscription:** **Sign in with Claude** runs `claude setup-token`, opens the browser, reads the
  token from the output and stores it straight in the vault. The user never sees or pastes a token.
- **Subscription sign-ins** (added later; see [harnesses.md](harnesses.md#logging-harnesses-in)): a
  third login kind, `home`. The harness's own sign-in runs into a folder beamhop owns. Its files are kept
  in the vault and copied into each session, and refreshed tokens are synced back. This covers Codex,
  Gemini, Cline, Kimi, Auggie, Cursor, pi (through a helper that runs pi's own sign-in code) and OpenCode
  (through `auth export` / `import`). goose and Qwen Code were dropped from the catalog.
- **Pseudo-terminal:** the system `script` command (macOS and Linux). No new native dependency.
- **New methods:** `harness.loginFlow { id, openBrowser }` → `HarnessJob`. It shares the job events and cancel with
  section 4, with steps `waiting-browser` and `code`.

### 6. Doctor fixes

- `DoctorCheck` gets `action?: { id, label, summary, admin, command }`. Fix ids map to a fixed
  table in the daemon (for example `linux.apt.bubblewrap` → `apt-get install -y bubblewrap`). The UI never
  sends a command.
- `system.doctorFix { id, elevate }` (`local` only):
  - Without admin rights, it just runs.
  - With admin rights on macOS, it runs `osascript -e 'do shell script "<cmd>" with administrator privileges'`.
  - With admin rights on Linux, it runs `pkexec <cmd>`.
  - Without an OS prompt (no polkit agent), it falls back to the explanation, plus the command under
    "Show details".
- Before the OS prompt, the UI shows what will change in plain words: "Installs bubblewrap, which beamhop
  uses to keep each agent in its folder."
- **Fix all** runs the fixes one at a time and stops at the first refusal.

### 7. `beamhop` command: opt-in

- Remove `setupCli(false)` from launch and remove the tray item. Keep `cli-install.ts` as it is.
- Settings → Advanced (desktop only) gets "Install the `beamhop` command" with a toggle and a short
  explanation. Behind it are `beamhopDesktop.cli.*` and the same rules: never replace another `beamhop`,
  and remove the profile block when switched off.
- Anyone who already has the auto-installed launcher keeps it, and the toggle shows it as on.

## Security

- New methods that run programs (`harness.install|update|loginFlow|job.cancel`,
  `system.doctorFix`) refuse anyone other than `local`, whatever the device role. A test covers this.
- What runs comes only from the signed catalog or the daemon's fixed fix table, never from free text in
  the UI. Package names are checked against `^[@a-z0-9._/-]+$` before they reach brew or npm.
- No sudo: brew and npm run as the user. Admin rights come only through the OS prompt in section 6.
- `loginFlow` output can contain tokens. It goes to the window that asked, not the audit log. Logs keep
  only the step names.
- Everything is recorded in the audit log: "Installed Gemini CLI 0.9.1 via Homebrew", "Ran fix
  linux.apt.socat".

## Work

| # | Change | Main files |
| --- | --- | --- |
| 1 | Preload bridge + `isDesktop` / `useShowCli` + Settings → Advanced | `apps/desktop/src/{preload,main}.ts`, `apps/desktop/scripts/build.mjs`, `apps/pwa/src/lib/desktop.ts`, `screens/settings/AdvancedSection.tsx` |
| 2 | Hide CLI strips; desktop wording; command messages → buttons | `ui/CliStrip.tsx`, `ui/States.tsx`, `shell/*`, `screens/onboarding/*`, `screens/settings/*`, i18n |
| 3 | CLI install opt-in | `apps/desktop/src/main.ts`, `AdvancedSection.tsx` |
| 4 | Catalog `install.native`, `auth.loginFlow`; re-sign | `packages/harness-catalog/{src/schema.ts,catalog.json}` |
| 5 | Install/update jobs, managed prefix, discovery paths | `packages/harness-discovery/src/install.ts`, `apps/daemon/src/api*.ts`, `packages/core/src/api.ts` |
| 6 | Login flows (`script` pseudo-terminal, URL/code parsing, `claude setup-token` → vault) | `apps/daemon/src/harness-login*.ts`, `screens/harnesses/HarnessLogin.tsx` |
| 7 | Doctor `fix` table + admin prompt | `apps/daemon/src/doctor*.ts`, `StepChecks.tsx` |
| 8 | Install/Update/Log in UI with progress | `screens/harnesses/*`, `screens/onboarding/StepChecks.tsx`, `screens/agents/NewAgentScreen.tsx` |
| 9 | Docs | `docs/desktop.md`, `docs/harnesses.md` |

## CLI parity

Everything the app does stays possible on a server without a screen:

| Desktop | CLI |
| --- | --- |
| Install / Update | `beamhop harness install <id> [--method …]`, `beamhop harness update <id>`, `beamhop harness updates` |
| Log in (browser) | `beamhop harness login <id> --browser [--no-open]` (prints the page and code over SSH) |
| Progress, Cancel | follows the job; Ctrl-C cancels; `beamhop harness jobs`, `beamhop harness job <id> [--cancel]` |
| Fix / Fix all | `beamhop doctor --fix [id…] [--yes]` (admin fixes run with `sudo` in the terminal) |
| Create owner key, Resume | `beamhop init`, `beamhop resume` |

## Testing

- **Unit:**
  - Choosing an install method (native, brew or npm, depending on what's on PATH).
  - Package-name checks.
  - URL and device-code parsing from recorded login output.
  - The fix table.
  - `local`-only guards for every new method.
- **E2E (Playwright):** run the PWA with a fake `window.beamhopDesktop`. Check that no screen shows
  `beamhop ` in desktop mode with the setting off, and that the Install, Log in and Fix flows work
  against the mock daemon.
- **Manual on macOS:** test four setups: no brew or Node, brew only, Node only, both. Also install
  Gemini CLI, update it, log in Claude through `setup-token`, and confirm a paired phone sees disabled
  buttons. On Linux .deb: Fix all with `pkexec`.

## Open points (decided provisionally; revisit if wrong)

- npm installs go into beamhop's own folder rather than the global one, so a harness installed by the
  app isn't on the user's terminal PATH. That matches "terminal users use the CLI".
- Windows: the same plan with winget for installs. Admin fixes don't apply there (the Linux packages
  aren't needed).
