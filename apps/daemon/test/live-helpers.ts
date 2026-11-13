// Shared plumbing for the daemon's live tests (*.live.test.ts). Never prints secrets.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { arch, homedir, platform } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createSandbox } from '@beamhop/sandbox';
import { ensureSrtTmp, type SandboxFactory } from '../src/index.ts';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

/** The opencode binary installed with @beamhop/harness-acp's dev dependency, if any. */
export const opencodeBinary = (): string | undefined => {
  try {
    const base = createRequire(join(repoRoot, 'packages', 'harness-acp', 'package.json'));
    const req = createRequire(base.resolve('opencode-ai/package.json'));
    const os = platform() === 'win32' ? 'windows' : platform();
    const exe = os === 'windows' ? 'opencode.exe' : 'opencode';
    for (const variant of ['', '-baseline']) {
      try {
        const bin = join(dirname(req.resolve(`opencode-${os}-${arch()}${variant}/package.json`)), 'bin', exe);
        if (existsSync(bin)) return bin;
      } catch {
        // next
      }
    }
  } catch {
    // not installed
  }
  return undefined;
};

/**
 * A work dir with a private HOME for opencode, and a sandbox factory that allows opencode's own
 * (free) model provider. The broker env from the daemon is kept; opencode's free "opencode"
 * provider has no broker route, so its traffic goes to opencode.ai directly (allow-listed here).
 */
export const opencodeWorkspace = (root: string): { work: string; sandbox: SandboxFactory } => {
  const work = join(root, 'work');
  const home = join(work, '.home');
  mkdirSync(home, { recursive: true });
  writeFileSync(join(work, 'opencode.json'), JSON.stringify({ autoupdate: false, share: 'disabled' }));
  const extraEnv: Record<string, string> = {
    HOME: home,
    XDG_CONFIG_HOME: join(home, '.config'),
    XDG_DATA_HOME: join(home, '.local', 'share'),
    XDG_CACHE_HOME: join(home, '.cache'),
    XDG_STATE_HOME: join(home, '.local', 'state'),
    OPENCODE_DISABLE_AUTOUPDATE: '1',
  };
  for (const k of ['SSL_CERT_FILE', 'NODE_EXTRA_CA_CERTS'])
    if (process.env[k]) extraEnv[k] = process.env[k] as string;
  const proxy = process.env.HTTPS_PROXY;
  ensureSrtTmp();
  const sandbox: SandboxFactory = (policy, o) =>
    createSandbox(
      {
        ...policy,
        net: { ...policy.net, allow: [...policy.net.allow, 'opencode.ai', '*.opencode.ai', 'models.dev'] },
      },
      {
        // Only upper-case HTTPS_PROXY is set for srt's parent proxy (lower+upper makes Bun hang).
        env: { ...o.env, ...extraEnv },
        ...(o.brokerPort ? { brokerPort: o.brokerPort } : {}),
        localAllow: o.localAllow,
        log: o.log,
        ...(proxy ? { parentProxy: { https: proxy } } : {}),
      },
    );
  return { work, sandbox };
};

const cfgDir = join(homedir(), '.config', 'beamhop');

/** Telegram bot token from env or ~/.config/beamhop/secrets.env. Never log it. */
export const telegramToken = (): string | undefined => {
  if (process.env.TELEGRAM_BOT_TOKEN) return process.env.TELEGRAM_BOT_TOKEN.trim();
  const file = join(cfgDir, 'secrets.env');
  if (!existsSync(file)) return undefined;
  for (const line of readFileSync(file, 'utf8').split(/\r?\n/)) {
    const m = /^\s*(?:export\s+)?TELEGRAM_BOT_TOKEN\s*=\s*(.*)\s*$/.exec(line);
    if (m?.[1]) return m[1].replace(/^['"]|['"]$/g, '').trim();
  }
  return undefined;
};

export const telegramOwnerChat = (): string | undefined => {
  const file = join(cfgDir, 'owner_chat_id');
  return existsSync(file) ? readFileSync(file, 'utf8').trim() || undefined : undefined;
};
