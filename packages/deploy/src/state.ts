import { chmod, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { BeamhopError, beamhopHome, type Deployment } from '@beamhop/core';
import { looksLikeSecret } from './validate.ts';

/** A deployment as persisted locally: the public `Deployment` plus provider resource ids. */
export interface DeployRecord extends Deployment {
  monthlyCostUsd?: number;
  /** Provider resource ids (server id, firewall id, app name, service id, …). Never tokens. */
  resources: Record<string, string>;
  updatedAt: string;
}

export interface DeployStateFile {
  version: 1;
  deployments: Record<string, DeployRecord>;
}

const empty = (): DeployStateFile => ({ version: 1, deployments: {} });

export const defaultStatePath = (home = beamhopHome()): string => join(home, 'deployments.json');

/**
 * Local deploy state (§10): a JSON file in the beamhop home, written atomically with mode 0600.
 * A second device learns about deployments from the encrypted Nostr mirror (`mirrorStateEvent`).
 */
export class DeployState {
  private chain: Promise<unknown> = Promise.resolve();

  constructor(readonly file: string = defaultStatePath()) {}

  async load(): Promise<DeployStateFile> {
    try {
      const parsed = JSON.parse(await readFile(this.file, 'utf8')) as DeployStateFile;
      if (parsed?.version !== 1 || typeof parsed.deployments !== 'object') {
        throw new BeamhopError('internal', `unsupported deploy state format in ${this.file}`);
      }
      return parsed;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return empty();
      throw err;
    }
  }

  private async save(s: DeployStateFile): Promise<void> {
    const json = JSON.stringify(s, null, 2);
    if (looksLikeSecret(json))
      throw new BeamhopError('internal', 'refusing to persist secret-looking deploy state');
    await mkdir(dirname(this.file), { recursive: true });
    const tmp = `${this.file}.${process.pid}.${Date.now()}.tmp`;
    await writeFile(tmp, `${json}\n`, { mode: 0o600 });
    await rename(tmp, this.file);
    if (process.platform !== 'win32') await chmod(this.file, 0o600);
  }

  /** Serialize read-modify-write cycles within this process. */
  private serial<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.chain.then(fn, fn);
    this.chain = next.catch(() => {});
    return next;
  }

  async get(id: string): Promise<DeployRecord | undefined> {
    return (await this.load()).deployments[id];
  }

  async list(): Promise<DeployRecord[]> {
    return Object.values((await this.load()).deployments);
  }

  upsert(rec: Omit<DeployRecord, 'updatedAt'> & { updatedAt?: string }): Promise<DeployRecord> {
    return this.serial(async () => {
      const s = await this.load();
      const prev = s.deployments[rec.id];
      const merged: DeployRecord = {
        ...prev,
        ...rec,
        resources: { ...prev?.resources, ...rec.resources },
        updatedAt: rec.updatedAt ?? new Date().toISOString(),
      };
      s.deployments[rec.id] = merged;
      await this.save(s);
      return merged;
    });
  }

  remove(id: string): Promise<void> {
    return this.serial(async () => {
      const s = await this.load();
      delete s.deployments[id];
      await this.save(s);
    });
  }
}

/** Unsigned Nostr event template (NIP-01 shape without id/pubkey/sig). */
export interface UnsignedEventTemplate {
  kind: number;
  created_at: number;
  tags: string[][];
  content: string;
}

/** Placeholder content when no encrypt hook is supplied; the daemon must replace it before signing. */
export const ENCRYPTED_CONTENT_PLACEHOLDER = '<nip44-encrypted-deploy-state>';
export const DEPLOY_STATE_D_TAG = 'beamhop/deployments';

export interface MirrorOptions {
  /**
   * Encrypt the plaintext JSON (e.g. NIP-44 to the owner's own pubkey). If omitted, `content`
   * is `ENCRYPTED_CONTENT_PLACEHOLDER` and the caller encrypts `plaintext` itself.
   */
  encrypt?: (plaintext: string) => string | Promise<string>;
  now?: () => Date;
}

/**
 * Build a NIP-78 application-specific data event (kind 30078, addressable by `d` tag) that
 * mirrors the deploy state so another device of the same owner can manage the deployments.
 * The daemon encrypts and signs it; this function never sees keys.
 */
export const mirrorStateEvent = async (
  state: DeployStateFile,
  opts: MirrorOptions = {},
): Promise<{ event: UnsignedEventTemplate; plaintext: string }> => {
  const plaintext = JSON.stringify(state);
  const content = opts.encrypt ? await opts.encrypt(plaintext) : ENCRYPTED_CONTENT_PLACEHOLDER;
  if (content === plaintext) throw new BeamhopError('internal', 'encrypt hook returned plaintext');
  return {
    event: {
      kind: 30078,
      created_at: Math.floor((opts.now?.() ?? new Date()).getTime() / 1000),
      // Only the d tag: provider names, agents and addresses stay inside the encrypted content.
      tags: [['d', DEPLOY_STATE_D_TAG]],
      content,
    },
    plaintext,
  };
};
