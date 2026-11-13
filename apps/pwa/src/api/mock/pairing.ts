/**
 * Mock device pairing + onboarding hello (additive; owned by the settings/onboarding/pair builder).
 * Realistic flow without timers (works with `?still=1`): state advances on read, by elapsed time.
 *
 *  device.pairStart   → a real pairing payload (daemon key, relays, code) and hosted URL.
 *  device.pairStatus  → `waiting`; when a phone answers (pairComplete with the code) — or, in this
 *                       single-tab demo, a simulated "iPhone · Safari" after SIMULATED_PHONE_MS — it
 *                       becomes `awaiting-confirm` with the 4-word phrase from both pubkeys.
 *  device.pairConfirm → accept: the device joins `device.list`; reject: logged as a failed pairing.
 *  onboarding.hello / helloStatus → the reply "arrives" REPLY_MS after the hello was sent.
 */
import { generateAgentKey } from '@beamhop/channel-nostr/keys';
import { encodePairingPayload, pairingUrl, safetyPhrase } from '@beamhop/channel-nostr/pairing';
import type { DeviceView, PairingStatusView } from '@beamhop/core';
import { RELAYS } from './seed.ts';

export const SIMULATED_PHONE_MS = 6000;
export const REPLY_MS = 5000;
const TTL_MS = 2 * 60_000;

interface Pairing {
  id: string;
  name: string;
  code: string;
  startedAt: number;
  expiresAt: number;
  requireConfirm: boolean;
  status: PairingStatusView['status'];
  device?: DeviceView;
  phrase?: string[];
}

const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
const randomCode = () => {
  const r = new Uint8Array(8);
  globalThis.crypto.getRandomValues(r);
  const s = [...r].map((b) => CODE_ALPHABET[b % CODE_ALPHABET.length]).join('');
  return `${s.slice(0, 4)}-${s.slice(4)}`;
};

export class MockPairing {
  readonly daemonKey = generateAgentKey();
  private pairings = new Map<string, Pairing>();
  private hellos = new Map<string, { sentAt: number }>();

  constructor(
    private readonly hooks: {
      addDevice: (d: DeviceView) => void;
      audit: (type: string, summary: string, severity: 'info' | 'warn' | 'security') => void;
    },
  ) {}

  start(name: string, requireConfirm: boolean) {
    const now = Date.now();
    const id = `pair_${now.toString(36)}${Math.random().toString(36).slice(2, 5)}`;
    const code = randomCode();
    const rec: Pairing = {
      id,
      name,
      code,
      startedAt: now,
      expiresAt: now + TTL_MS,
      requireConfirm,
      status: 'waiting',
    };
    this.pairings.set(id, rec);
    const relays = RELAYS.slice(0, 3);
    const payload = encodePairingPayload({
      v: 1,
      daemon: this.daemonKey.pubkey,
      relays,
      code,
      name: "alice's MacBook",
      exp: Math.floor(rec.expiresAt / 1000),
    });
    this.hooks.audit('device.pairStart', `Device pairing started (${name})`, 'security');
    return {
      uri: pairingUrl(payload),
      link: `beamhop://pair#${payload}`,
      payload,
      code,
      expiresAt: new Date(rec.expiresAt).toISOString(),
      pairingId: id,
      daemonNpub: this.daemonKey.npub,
      relays,
    };
  }

  private answer(rec: Pairing, pubkey: string, name: string): DeviceView {
    const now = new Date().toISOString();
    const device: DeviceView = {
      id: `dev_${Date.now().toString(36)}`,
      name,
      pubkey,
      pairedAt: now,
      lastSeenAt: now,
      pushEnabled: false,
    };
    rec.device = device;
    rec.phrase = safetyPhrase(this.daemonKey.pubkey, pubkey);
    if (rec.requireConfirm) rec.status = 'awaiting-confirm';
    else {
      rec.status = 'paired';
      this.hooks.addDevice(device);
    }
    return device;
  }

  private tick(rec: Pairing) {
    const now = Date.now();
    if (rec.status === 'waiting' && now > rec.expiresAt) rec.status = 'expired';
    // Single-tab demo: nobody can scan the QR, so a phone "answers" after a few seconds.
    if (rec.status === 'waiting' && now - rec.startedAt > SIMULATED_PHONE_MS)
      this.answer(rec, generateAgentKey().npub, 'iPhone · Safari');
    return rec;
  }

  status(id: string): PairingStatusView {
    const rec = this.pairings.get(id);
    // Unknown or forgotten pairing (e.g. after a reload of the mock): report it as expired.
    if (!rec) return { pairingId: id, status: 'expired', expiresAt: new Date().toISOString() };
    const cur = this.tick(rec);
    return {
      pairingId: cur.id,
      status: cur.status,
      expiresAt: new Date(cur.expiresAt).toISOString(),
      ...(cur.device && cur.status !== 'rejected' && cur.status !== 'expired' ? { device: cur.device } : {}),
      ...(cur.phrase && (cur.status === 'awaiting-confirm' || cur.status === 'paired')
        ? { safetyPhrase: cur.phrase }
        : {}),
    };
  }

  confirm(id: string, accept: boolean): PairingStatusView {
    const rec = this.pairings.get(id);
    if (!rec) return this.status(id);
    const cur = this.tick(rec);
    if (!accept && (cur.status === 'waiting' || cur.status === 'awaiting-confirm')) {
      cur.status = 'rejected';
      this.hooks.audit(
        'pairing.failed',
        `Device pairing cancelled: safety phrase did not match (${cur.device?.name ?? 'no device yet'})`,
        'security',
      );
    } else if (accept && cur.status === 'awaiting-confirm' && cur.device) {
      cur.status = 'paired';
      this.hooks.addDevice(cur.device);
      this.hooks.audit(
        'device.paired',
        `Paired device ${cur.device.name} (safety phrase confirmed)`,
        'security',
      );
    } else if (accept) {
      throw Object.assign(new Error(`pairing is ${cur.status}, nothing to confirm`), { code: 'conflict' });
    }
    return this.status(id);
  }

  /** A phone answering with a code. Returns undefined when the code belongs to no pairing here. */
  complete(code: string, pubkey: string, name: string): DeviceView | undefined {
    const norm = code.trim().toUpperCase().replace(/-/g, '');
    const rec = [...this.pairings.values()].find(
      (r) => r.code.replace(/-/g, '') === norm && r.status === 'waiting',
    );
    return rec ? this.answer(rec, pubkey, name) : undefined;
  }

  hello(agent: string) {
    this.hellos.set(agent, { sentAt: Date.now() });
    return new Date().toISOString();
  }

  helloStatus(agent: string): {
    sent: boolean;
    replied: boolean;
    sentAt?: string;
    repliedAt?: string;
    from?: string;
    text?: string;
  } {
    const h = this.hellos.get(agent);
    if (!h) return { sent: false, replied: false };
    const replied = Date.now() - h.sentAt > REPLY_MS;
    return {
      sent: true,
      replied,
      sentAt: new Date(h.sentAt).toISOString(),
      ...(replied
        ? {
            repliedAt: new Date(h.sentAt + REPLY_MS).toISOString(),
            from: 'iPhone · Safari',
            text: 'Got it. Hello from my phone.',
          }
        : {}),
    };
  }
}
