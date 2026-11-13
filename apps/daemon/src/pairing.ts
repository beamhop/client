/**
 * Device pairing (§9 Hosting, JOURNEYS 9): one-time codes (stored hashed, single use, rate-limited),
 * the QR payload for the hosted PWA, the 4-word safety phrase and the trusted-side confirmation.
 * A paired device joins the Nostr control-plane allowlist and is linked to the owner.
 */
import { hostname } from 'node:os';
import { createPairingCode, normalizePrincipal, PairingLimiter } from '@beamhop/authz';
import { BeamhopError, type DeviceView, newId, type PairingStatusView } from '@beamhop/core';
import type { Daemon } from './daemon.ts';
import { requireNostr } from './identity.ts';
import type { CallContext } from './rpc-server.ts';

interface PairingRecord {
  id: string;
  name: string;
  expiresAt: string;
  requireConfirm: boolean;
  status: PairingStatusView['status'];
  deviceId?: string;
  safetyPhrase?: string[];
}

/** How long a device answered but unconfirmed stays pending past the code expiry. */
const CONFIRM_GRACE_MS = 5 * 60_000;
const NS = 'pairing';

export class DevicePairing {
  readonly limiter: PairingLimiter;

  constructor(private readonly d: Daemon) {
    this.limiter = new PairingLimiter({ now: () => d.now() });
  }

  /** Devices that finished pairing (pending ones are not on the allowlist and are not owners). */
  activeDevices(): DeviceView[] {
    return this.d.store.devices.list().filter((dev) => !this.d.store.kv.get('device-pending', dev.id));
  }

  async start(name: string, requireConfirm: boolean, ctx: { actor: string }) {
    const d = this.d;
    const m = await requireNostr();
    const key = await d.controlKey();
    const code = createPairingCode({ now: d.now() });
    const id = newId('pair');
    d.store.pairingCodes.put({
      code: code.code,
      purpose: 'device',
      expiresAt: code.expiresAt,
      data: { name, pairingId: id },
    });
    const rec: PairingRecord = { id, name, expiresAt: code.expiresAt, requireConfirm, status: 'waiting' };
    d.store.kv.set(NS, id, rec);
    const relays = d.global().nostr.relays;
    const payload = m.encodePairingPayload({
      v: 1,
      daemon: key.pubkey,
      relays,
      code: code.code,
      name: hostname(),
      exp: Math.floor(Date.parse(code.expiresAt) / 1000),
    });
    d.audit({
      type: 'device.pairStart',
      severity: 'security',
      summary: `Device pairing started (${name})`,
      actor: ctx.actor,
      data: { pairingId: id },
    });
    return {
      uri: m.pairingUrl(payload),
      link: m.pairingDeepLink(payload),
      payload,
      code: code.code,
      expiresAt: code.expiresAt,
      pairingId: id,
      daemonNpub: key.npub,
      relays,
    };
  }

  async complete(
    input: { code: string; pubkey: string; name: string },
    ctx: CallContext,
  ): Promise<DeviceView> {
    const d = this.d;
    const m = await requireNostr();
    const who = ctx.caller;
    const limit = this.limiter.check(who);
    if (!limit.ok) {
      d.audit({
        type: 'pairing.locked',
        severity: 'security',
        summary: `Device pairing from ${who} refused: too many failed attempts (${limit.scope})`,
        actor: who,
      });
      throw new BeamhopError(
        'rate_limited',
        `too many failed pairing attempts; try again in ${Math.ceil(limit.retryAfterMs / 1000)}s`,
      );
    }
    const fail = (reason: string, msg: string): never => {
      this.limiter.fail(who);
      d.audit({
        type: 'pairing.failed',
        severity: 'security',
        summary: `Failed device pairing (${reason})`,
        actor: who,
        data: { reason, transport: ctx.transport },
      });
      throw new BeamhopError('unauthorized', msg);
    };
    let hex: string;
    try {
      hex = m.decodePubkey(input.pubkey);
    } catch {
      throw new BeamhopError('invalid_input', 'pubkey must be an npub or 64-char hex key');
    }
    const npub = m.npubEncode(hex);
    // Over Nostr the request is signed by the device key: it can only pair itself.
    if (ctx.transport === 'nostr' && normalizePrincipal(ctx.caller) !== normalizePrincipal(`nostr:${npub}`))
      fail('key-mismatch', 'the pairing request must be signed by the device key');
    const res = d.store.pairingCodes.consume(input.code.trim().toUpperCase(), 'device');
    if (!res.ok) return fail(res.reason, `pairing code ${res.reason}`);
    const pairingId = typeof res.record.data.pairingId === 'string' ? res.record.data.pairingId : undefined;
    const rec = pairingId ? d.store.kv.get<PairingRecord>(NS, pairingId) : undefined;
    const name = (input.name || String(res.record.data.name ?? 'device')).slice(0, 80);
    // Re-pairing the same device replaces the old record and keeps its name (JOURNEYS 9).
    const old = d.store.devices.getByPubkey(npub) ?? d.store.devices.getByPubkey(hex);
    if (old) this.forget(old);
    const dev = d.store.devices.add({ name: old?.name ?? name, pubkey: npub });
    const key = await d.controlKey();
    const phrase = m.safetyPhrase(key.pubkey, hex);
    const confirm = rec?.requireConfirm ?? false;
    if (confirm) d.store.kv.set('device-pending', dev.id, pairingId ?? true);
    else this.activate(dev);
    if (rec)
      d.store.kv.set(NS, rec.id, {
        ...rec,
        status: confirm ? 'awaiting-confirm' : 'paired',
        deviceId: dev.id,
        safetyPhrase: phrase,
      } satisfies PairingRecord);
    d.audit({
      type: confirm ? 'device.pairPending' : 'device.paired',
      severity: 'security',
      summary: confirm
        ? `Device ${dev.name} answered; waiting for confirmation on this computer`
        : `Paired device ${dev.name}`,
      actor: who,
      data: { device: dev.id, via: ctx.transport },
    });
    return dev;
  }

  status(id: string): PairingStatusView {
    const rec = this.d.store.kv.get<PairingRecord>(NS, id);
    if (!rec) throw new BeamhopError('not_found', `pairing ${id} not found`);
    const cur = this.expireIfStale(rec);
    const out: PairingStatusView = { pairingId: cur.id, status: cur.status, expiresAt: cur.expiresAt };
    const dev = cur.deviceId ? this.d.store.devices.get(cur.deviceId) : undefined;
    if (dev && cur.status !== 'rejected' && cur.status !== 'expired') out.device = dev;
    if (cur.safetyPhrase && (cur.status === 'awaiting-confirm' || cur.status === 'paired'))
      out.safetyPhrase = cur.safetyPhrase;
    return out;
  }

  confirm(id: string, accept: boolean, actor: string): PairingStatusView {
    const d = this.d;
    const rec = d.store.kv.get<PairingRecord>(NS, id);
    if (!rec) throw new BeamhopError('not_found', `pairing ${id} not found`);
    const cur = this.expireIfStale(rec);
    if (cur.status === 'waiting' && !accept) {
      // Cancelled before any device answered: the code can no longer be used.
      d.store.kv.set(NS, id, { ...cur, status: 'rejected' } satisfies PairingRecord);
      return this.status(id);
    }
    if (cur.status !== 'awaiting-confirm')
      throw new BeamhopError('conflict', `pairing is ${cur.status}, nothing to confirm`);
    const dev = cur.deviceId ? d.store.devices.get(cur.deviceId) : undefined;
    if (!dev) throw new BeamhopError('not_found', 'paired device vanished');
    if (accept) {
      d.store.kv.delete('device-pending', dev.id);
      this.activate(dev);
      d.store.kv.set(NS, id, { ...cur, status: 'paired' } satisfies PairingRecord);
      d.audit({
        type: 'device.paired',
        severity: 'security',
        summary: `Paired device ${dev.name} (safety phrase confirmed)`,
        actor,
        data: { device: dev.id },
      });
    } else {
      this.forget(dev);
      d.store.kv.set(NS, id, { ...cur, status: 'rejected' } satisfies PairingRecord);
      d.audit({
        type: 'pairing.failed',
        severity: 'security',
        summary: `Device pairing cancelled: safety phrase did not match (${dev.name})`,
        actor,
        data: { reason: 'phrase-mismatch', device: dev.id },
      });
    }
    return this.status(id);
  }

  remove(id: string): boolean {
    const dev = this.d.store.devices.get(id);
    if (!dev) return false;
    this.forget(dev);
    return true;
  }

  /** Drop pending devices whose confirmation never came. */
  tick(): void {
    for (const dev of this.d.store.devices.list()) {
      const pid = this.d.store.kv.get<string | true>('device-pending', dev.id);
      if (!pid) continue;
      const rec = typeof pid === 'string' ? this.d.store.kv.get<PairingRecord>(NS, pid) : undefined;
      if (rec) this.expireIfStale(rec);
      else if (Date.parse(dev.pairedAt) + CONFIRM_GRACE_MS < this.d.now()) this.forget(dev);
    }
  }

  private expireIfStale(rec: PairingRecord): PairingRecord {
    const now = this.d.now();
    const exp = Date.parse(rec.expiresAt);
    const stale =
      (rec.status === 'waiting' && now >= exp) ||
      (rec.status === 'awaiting-confirm' && now >= exp + CONFIRM_GRACE_MS);
    if (!stale) return rec;
    if (rec.deviceId) {
      const dev = this.d.store.devices.get(rec.deviceId);
      if (dev) this.forget(dev);
    }
    const next: PairingRecord = { ...rec, status: 'expired' };
    this.d.store.kv.set(NS, rec.id, next);
    return next;
  }

  /** Allowlist the device and link it to the owner (a paired phone acts for the owner). */
  private activate(dev: DeviceView): void {
    const principal = `nostr:${dev.pubkey}`;
    this.d.updateGlobal((c) => {
      const people = { ...c.people };
      const list = people.owner ?? [];
      const anchor = c.owners[0] ?? 'local:owner';
      const next = list.length ? [...list] : [anchor];
      if (!next.some((p) => normalizePrincipal(p) === normalizePrincipal(principal))) next.push(principal);
      people.owner = next;
      return { ...c, people };
    });
    this.d.refreshControlAllowlist();
  }

  private forget(dev: DeviceView): void {
    const n = normalizePrincipal(`nostr:${dev.pubkey}`);
    this.d.store.devices.remove(dev.id);
    this.d.store.kv.delete('device-pending', dev.id);
    this.d.updateGlobal((c) => ({
      ...c,
      people: Object.fromEntries(
        Object.entries(c.people).map(([k, v]) => [k, v.filter((p) => normalizePrincipal(p) !== n)]),
      ),
    }));
    this.d.refreshControlAllowlist();
  }
}
