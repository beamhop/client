# Desktop app

The beamhop desktop app is the same control panel as the [PWA](pwa.md), in its own window, with the
daemon bundled inside. You install nothing else: no Node.js and no CLI. It runs the daemon on its own
runtime, and everything the CLI does is in the app (setup, agents, channels, harnesses, policy, deploys,
audit, pairing a phone, Stop everything).

You can use the CLI only, the app only, or both. They share one daemon and one beamhop home
(`~/.beamhop`).

| You use          | Who runs the daemon                                     | The UI                                      |
| ---------------- | ------------------------------------------------------- | ------------------------------------------- |
| CLI only         | `beamhop daemon`                                         | the same web UI, at `beamhop ui` in a browser |
| Desktop app only | the app (its bundled daemon)                             | the app window                              |
| Both             | whichever starts first; the other connects to it         | either                                      |

## Install

Download it from the [releases page](https://github.com/beamhop/client/releases):

- **macOS** (Apple Silicon and Intel): `beamhop-<version>-mac-<arch>.dmg`. It is signed with a Developer ID
  and notarized by Apple.
- **Windows** (x64): `beamhop-<version>-win-x64.exe`, a per-user installer.
- **Linux** (x64, arm64): `.AppImage`, or `.deb` (which pulls in `bubblewrap`, `socat` and `ripgrep`). With
  the AppImage, install those three with your package manager; the sandbox needs them on Linux.

Agent harnesses (Claude Code, Codex, Gemini CLI and so on) are separate programs. The app finds the ones
you have installed and installs the rest for you: **Harnesses → Install** uses the harness's own installer
when there is one, otherwise Homebrew or npm, and shows its progress. Claude Code's agent runtime is
bundled, so Claude agents work without it.

You never need a terminal in the app. Installing, updating and logging in harnesses, and fixing what
**Setup → Checks** finds, are buttons; fixes that need administrator rights ask for your password through
the system's own prompt. Everything the app does is also a CLI command for servers without a screen (see
[the CLI](cli.md)): `beamhop harness install|update|login --browser`, `beamhop doctor --fix`.

## Using it

- **Closing the window keeps beamhop running** in the menu bar (macOS) or the tray (Windows, Linux), so your
  agents keep answering. Open the window again from there, or from the dock or start menu.
- **Quit beamhop** (menu bar / tray, or Cmd+Q) stops the daemon the app started. A daemon started by the CLI
  keeps running; the app only connects to it.
- **Open at login** (menu bar / tray) starts beamhop hidden at login: the daemon comes up and the app waits
  in the menu bar. On macOS this is a LaunchAgent you can also see in System Settings → General → Login
  Items; on Linux an `~/.config/autostart` entry; on Windows the usual Run key.
- **Stop everything** (menu bar / tray) is the same emergency stop as `beamhop panic`; the menu then offers
  **Resume**.
- **Show logs** opens `~/.beamhop/logs`. The app's daemon writes `desktop-daemon.log` there.

Apps opened from Finder or the Dock do not get your shell's `PATH`, so at startup beamhop asks your login
shell for it once (`$SHELL -ilc`, the same trick editors use) and gives the daemon that `PATH` plus a few
tool-manager variables such as `NVM_BIN`. That is how it finds harnesses installed with nvm, Homebrew, npm,
pnpm or bun, and how Node-based ones find `node`. Nothing else from your shell environment is passed on.
If your shell config is slow or waits for input, beamhop gives up after 10 seconds; it sets
`BEAMHOP_RESOLVING_SHELL_ENV=1` so your config can skip such parts.

The daemon listens on `127.0.0.1:7878` unless `BEAMHOP_PORT` (or `BEAMHOP_URL`) is set in the app's
environment; `BEAMHOP_HOME` moves the beamhop home, as with the CLI.

### The `beamhop` command

The app does not put anything on your `PATH` by itself. If you want the CLI too, turn on *Settings →
Advanced → Install the `beamhop` command*: the app writes a small launcher to `~/.beamhop/bin/beamhop` that
runs the CLI bundled in the app, and adds that folder to your login shell's profile (a marked block in
`~/.zprofile`, `~/.bash_profile`/`~/.bashrc`, fish's `conf.d`, or `~/.profile`). It never replaces a
`beamhop` you installed another way, and turning the setting off removes both. macOS and the Linux `.deb`
only. *Settings → Advanced → Show command-line equivalents* shows the matching command under each screen.

### Secrets and the system keychain

Secrets live in an encrypted file in `~/.beamhop`, whose key is in `~/.beamhop/vault.key`, so the app and
the CLI share them and nothing prompts. If you turn on *Settings → Secrets → Keep the vault key in the system
keychain* (or `beamhop secret keychain on`), only that one key moves into the keychain. macOS ties a keychain
item to the program that created it, so the first time the other program (the app, or `node` for the CLI)
reads it, macOS asks once: choose **Always Allow**.

The app itself keeps out of the keychain: Electron would otherwise create a "beamhop Safe Storage" item to
encrypt its cookies, and every rebuild (a new signature) would ask for your login password to read it. The
app stores nothing that needs it. Set `BEAMHOP_DESKTOP_KEYCHAIN=1` to restore Electron's default.

## Build it yourself

```bash
pnpm install
pnpm --filter @beamhop/desktop start      # stage and run in development (electron build/app)
pnpm --filter @beamhop/desktop dist       # installers for this OS/arch -> dist/desktop/
pnpm --filter @beamhop/desktop dist:dir   # an unpacked app only (faster, no installer)
```

`scripts/build.mjs` stages two things: `build/app` (the main process, bundled with esbuild, packed into
`app.asar`) and `build/daemon` (the same bundle as the npm package and the standalone binary, plus its
production dependencies for this platform). electron-builder ships `build/daemon` unpacked as
`<resources>/daemon`, because the sandbox runner and the MCP server run from files on disk.

The daemon's dependencies are installed without install scripts and then pruned (`scripts/prune.mjs`) of
what it never loads on the target: srt's optional Windows `mxc` backend (`@microsoft/mxc-sdk`, `node-pty`,
`koffi`; beamhop uses srt-win), srt's Linux and Windows helpers on other platforms and arches, source maps
and type declarations. That is about 190 MB on macOS. Most of what remains is the bundled Claude Code
runtime for the Claude harness.

The daemon runs on the app's own Electron binary in Node mode (`ELECTRON_RUN_AS_NODE=1`). The helpers it
launches with `process.execPath` (sandbox runner, MCP server) get the same switch through `nodeExecEnv()` in
`@beamhop/core`; the sandbox runner removes it again before a harness starts, so agents never inherit it.

Native dependencies are per platform, so build each OS/arch on that OS/arch. CI does this in the `desktop`
job of `.github/workflows/release.yml`.

### Signing and notarization

The config reads everything from the environment, so the same command builds unsigned locally and signed in CI:

| Platform | Variables                                                                                              |
| -------- | ------------------------------------------------------------------------------------------------------ |
| macOS    | `CSC_LINK` + `CSC_KEY_PASSWORD` (Developer ID Application .p12), or an identity in your login keychain |
|          | notarization: `APPLE_ID` + `APPLE_APP_SPECIFIC_PASSWORD` + `APPLE_TEAM_ID` (or the `APPLE_API_KEY*` trio) |
| Windows  | `WIN_CSC_LINK` + `WIN_CSC_KEY_PASSWORD` (Authenticode .pfx)                                             |
| Linux    | unsigned; release checksums are signed with cosign                                                      |

To build unsigned on a Mac that has a signing identity, set `CSC_IDENTITY_AUTO_DISCOVERY=false`.

The release workflow maps its existing secrets (`APPLE_CERT_P12_BASE64`, `APPLE_CERT_PASSWORD`, `APPLE_ID`,
`APPLE_TEAM_ID`, `APPLE_APP_PASSWORD`, `WINDOWS_CERT_PFX_BASE64`, `WINDOWS_CERT_PASSWORD`) onto these, refuses
to release an unsigned macOS app on a tag push, and checks the result with `codesign`, `spctl` and `stapler`.

### Hardening

- The window loads only the daemon origin; other links open in your browser (`http`, `https`, `mailto` only).
- Renderer: context isolation, sandbox, no Node integration, no `<webview>`; DevTools only in development.
  A preload exposes `window.beamhopDesktop` (app version, the `beamhop` command setting, restart the
  daemon, open the log) over fixed IPC channels that answer only the app window on the daemon origin.
- Installing harnesses, logging them in and applying doctor fixes run programs on the computer, so the
  daemon accepts them only from local clients (the app, the CLI), never from paired phones.
- Permissions: notifications, clipboard write and camera (for pairing QR codes), only for the daemon origin.
- Electron fuses: cookie encryption on; `NODE_OPTIONS` and `--inspect` off; the app loads only from its
  integrity-checked `app.asar`. `runAsNode` stays on because the daemon needs it.
- macOS hardened runtime with the entitlements in `build-resources/entitlements.mac.plist`.
