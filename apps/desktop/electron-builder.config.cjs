// electron-builder config for the beamhop desktop app. Run after scripts/build.mjs has staged build/.
//
// Signing and notarization are driven by environment variables, so the same config builds unsigned
// locally and signed in CI (.github/workflows/release.yml):
//
//   macOS    CSC_LINK (+ CSC_KEY_PASSWORD)  Developer ID Application certificate (.p12, base64 or path);
//            without it electron-builder uses a Developer ID identity from the login keychain, if any.
//            Notarization: APPLE_ID + APPLE_APP_SPECIFIC_PASSWORD + APPLE_TEAM_ID
//                       or APPLE_API_KEY + APPLE_API_KEY_ID + APPLE_API_ISSUER.
//   Windows  WIN_CSC_LINK (+ WIN_CSC_KEY_PASSWORD)  Authenticode certificate (.pfx).
//   Linux    unsigned (AppImage + .deb); the release checksums are signed with cosign.
//
// Native dependencies are per platform: build each target on its own OS and arch.
const env = process.env;
// No certificate and auto-discovery off: sign ad hoc ('-'). Apple Silicon refuses to run an app whose
// signature broke during packaging, so "unsigned" local builds still need this.
const adHoc = !env.CSC_LINK && !env.CSC_NAME && env.CSC_IDENTITY_AUTO_DISCOVERY === 'false';
const notarize = Boolean(
  (env.APPLE_ID && env.APPLE_APP_SPECIFIC_PASSWORD && env.APPLE_TEAM_ID) ||
    (env.APPLE_API_KEY && env.APPLE_API_KEY_ID && env.APPLE_API_ISSUER),
);

/** @type {import('electron-builder').Configuration} */
module.exports = {
  appId: 'dev.beamhop.desktop',
  productName: 'beamhop',
  copyright: 'Copyright © beamhop contributors',
  electronVersion: '45.1.0',
  directories: {
    app: 'build/app',
    output: '../../dist/desktop',
    buildResources: 'build-resources',
  },
  icon: 'assets/icon.png',
  asar: true,
  // The daemon is not loaded by Electron: it runs as a separate process from plain files on disk
  // (the sandbox runner and MCP server are spawned by path, and srt reads its helpers from disk).
  extraResources: [{ from: 'build/daemon', to: 'daemon', filter: ['**/*', '!.deps-stamp'] }],
  // electron-builder never copies `node_modules` through extraResources, so the daemon's production deps
  // are added here. afterPack runs before code signing: the native binaries in them get signed too.
  afterPack: async (ctx) => {
    const { cpSync, existsSync } = require('node:fs');
    const { join } = require('node:path');
    const src = join(__dirname, 'build', 'daemon', 'node_modules');
    if (!existsSync(src)) throw new Error('build/daemon/node_modules missing: run scripts/build.mjs first');
    const resources =
      ctx.electronPlatformName === 'darwin'
        ? join(ctx.appOutDir, `${ctx.packager.appInfo.productFilename}.app`, 'Contents', 'Resources')
        : join(ctx.appOutDir, 'resources');
    cpSync(src, join(resources, 'daemon', 'node_modules'), { recursive: true, verbatimSymlinks: true });
  },
  // Nothing to rebuild: the app itself has no dependencies; the daemon's native addons are N-API.
  npmRebuild: false,
  electronFuses: {
    // Needed: the daemon, sandbox runner and MCP server run on this binary in Node mode.
    runAsNode: true,
    enableCookieEncryption: true,
    enableNodeOptionsEnvironmentVariable: false,
    enableNodeCliInspectArguments: false,
    enableEmbeddedAsarIntegrityValidation: true,
    onlyLoadAppFromAsar: true,
    grantFileProtocolExtraPrivileges: false,
  },
  // biome-ignore lint/suspicious/noTemplateCurlyInString: electron-builder file name macros
  artifactName: 'beamhop-${version}-${os}-${arch}.${ext}',

  mac: {
    category: 'public.app-category.developer-tools',
    target: ['dmg', 'zip'],
    ...(adHoc ? { identity: '-' } : {}),
    hardenedRuntime: true,
    gatekeeperAssess: false,
    entitlements: 'build-resources/entitlements.mac.plist',
    entitlementsInherit: 'build-resources/entitlements.mac.plist',
    notarize: notarize && !adHoc,
    extendInfo: {
      NSCameraUsageDescription: 'beamhop uses the camera only to scan a pairing QR code.',
    },
  },
  dmg: {
    // biome-ignore lint/suspicious/noTemplateCurlyInString: electron-builder file name macros
    artifactName: 'beamhop-${version}-${os}-${arch}.${ext}',
  },

  win: {
    target: ['nsis'],
  },
  nsis: {
    oneClick: false,
    perMachine: false,
    allowToChangeInstallationDirectory: true,
    // Installed per user: the daemon keeps its data in the user's home (~/.beamhop) anyway.
    deleteAppDataOnUninstall: false,
  },

  linux: {
    target: ['AppImage', 'deb'],
    category: 'Development',
    maintainer: 'beamhop (https://github.com/beamhop/client)',
    synopsis: 'Your coding agents on Nostr, Telegram, Slack and Discord, sandboxed.',
    // The sandbox needs these on Linux (`beamhop doctor` explains what is missing).
    // AppImage users install them with their package manager.
  },
  deb: {
    // electron-builder's defaults (replaced when `depends` is set) plus the sandbox prerequisites.
    depends: [
      'libgtk-3-0',
      'libnotify4',
      'libnss3',
      'libxss1',
      'libxtst6',
      'xdg-utils',
      'libatspi2.0-0',
      'libuuid1',
      'libsecret-1-0',
      'bubblewrap',
      'socat',
      'ripgrep',
    ],
  },
};
