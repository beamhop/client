/** beamhop home layout: API token, single-instance lock, data key. */
import { randomBytes } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { BeamhopError, type Logger, paths, type SecretStore } from '@beamhop/core';
import { encodeDataKey, generateDataKey, parseDataKey } from '@beamhop/store';

export const DATA_KEY_SECRET = 'beamhop.data-key';

/** Secrets the daemon manages itself; hidden from `secret.list` and not settable through the API. */
export const isInternalSecret = (name: string): boolean => name.startsWith('beamhop.');

export const ensureHomeDirs = (home: string): void => {
  const p = paths(home);
  for (const d of [home, p.agents, p.channels, p.sessions, p.worktrees, p.logs, join(home, 'schedules')])
    mkdirSync(d, { recursive: true, mode: 0o700 });
};

/** Read or create the API token file (mode 0600). */
export const ensureApiToken = (home: string): string => {
  const file = paths(home).token;
  if (existsSync(file)) {
    const t = readFileSync(file, 'utf8').trim();
    if (t.length >= 32) {
      if (process.platform !== 'win32') chmodSync(file, 0o600);
      return t;
    }
  }
  const token = randomBytes(32).toString('base64url');
  writeFileSync(file, `${token}\n`, { mode: 0o600 });
  if (process.platform !== 'win32') chmodSync(file, 0o600);
  return token;
};

/**
 * The SQLite data key lives in the secret store (the encrypted vault). If the secret store is
 * memory-only (tests) we fall back to `<home>/data.key` (0600) so the
 * database stays readable across restarts, and warn loudly.
 */
export const ensureDataKey = async (home: string, secrets: SecretStore, log: Logger): Promise<Buffer> => {
  const file = join(home, 'data.key');
  const fromStore = await secrets.get(DATA_KEY_SECRET);
  if (fromStore) return parseDataKey(fromStore);
  if (existsSync(file)) {
    const key = parseDataKey(readFileSync(file, 'utf8').trim());
    if (secrets.backend !== 'memory') {
      await secrets.set(DATA_KEY_SECRET, encodeDataKey(key));
      rmSync(file, { force: true });
      log.info('moved data key into the secret store');
    }
    return key;
  }
  const key = generateDataKey();
  if (secrets.backend === 'memory') {
    log.warn('memory-only secret store: storing the data key in <home>/data.key (0600)');
    writeFileSync(file, `${encodeDataKey(key)}\n`, { mode: 0o600 });
  } else await secrets.set(DATA_KEY_SECRET, encodeDataKey(key));
  return key;
};

const pidAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EPERM';
  }
};

/** Single-instance lock: `<home>/daemon.lock` holding our pid. Stale locks are taken over. */
export const acquireLock = (home: string): (() => void) => {
  const file = join(home, 'daemon.lock');
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      writeFileSync(file, String(process.pid), { flag: 'wx', mode: 0o600 });
      let released = false;
      return () => {
        if (released) return;
        released = true;
        try {
          if (readFileSync(file, 'utf8').trim() === String(process.pid)) rmSync(file, { force: true });
        } catch {
          /* already gone */
        }
      };
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
      const pid = Number(readFileSync(file, 'utf8').trim());
      if (Number.isInteger(pid) && pid > 0 && pid !== process.pid && pidAlive(pid))
        throw new BeamhopError('conflict', `another beamhop daemon is running (pid ${pid}, lock ${file})`);
      rmSync(file, { force: true });
    }
  }
  throw new BeamhopError('conflict', `could not acquire ${file}`);
};

/** Environment knobs set by cloud deploys (packages/deploy cloud-init). */
export interface DeployEnv {
  awaitProvisioning: boolean;
  ownerNpub?: string;
  provisioningPubkey?: string;
  /** One-time binding token proving this host came from the owner's deploy (wave C PROV-1). */
  provisioningToken?: string;
  daemonNsecRef?: string;
  sandboxFs: 'srt' | 'container';
  harnesses: string[];
  agent?: string;
  provider?: string;
}

export const readDeployEnv = (env: NodeJS.ProcessEnv = process.env): DeployEnv => {
  const out: DeployEnv = {
    awaitProvisioning: env.BEAMHOP_AWAIT_PROVISIONING === '1',
    sandboxFs: env.BEAMHOP_SANDBOX_FS === 'container' ? 'container' : 'srt',
    harnesses: (env.BEAMHOP_HARNESSES ?? '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
  };
  if (env.BEAMHOP_OWNER_NPUB) out.ownerNpub = env.BEAMHOP_OWNER_NPUB;
  if (env.BEAMHOP_PROVISIONING_PUBKEY) out.provisioningPubkey = env.BEAMHOP_PROVISIONING_PUBKEY;
  if (env.BEAMHOP_PROVISIONING_TOKEN) out.provisioningToken = env.BEAMHOP_PROVISIONING_TOKEN;
  if (env.BEAMHOP_DAEMON_NSEC_REF) out.daemonNsecRef = env.BEAMHOP_DAEMON_NSEC_REF;
  if (env.BEAMHOP_AGENT) out.agent = env.BEAMHOP_AGENT;
  if (env.BEAMHOP_DEPLOY_PROVIDER) out.provider = env.BEAMHOP_DEPLOY_PROVIDER;
  return out;
};
