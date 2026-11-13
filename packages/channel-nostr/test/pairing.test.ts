import { createHash } from 'node:crypto';
import { type RpcRequest, silentLogger } from '@beamhop/core';
import { finalizeEvent } from 'nostr-tools/pure';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import { type ControlServer, createControlServer } from '../src/control-server.ts';
import { buildAttestationTemplate, verifyAttestation } from '../src/identity.ts';
import { generateAgentKey } from '../src/keys.ts';
import {
  completePairing,
  decodePairingPayload,
  encodePairingPayload,
  formatSafetyPhrase,
  type PairingPayload,
  pairingDeepLink,
  pairingUrl,
  safetyPhrase,
} from '../src/pairing.ts';
import { WORDLIST } from '../src/wordlist.ts';
import { FakeRelay, sleep } from './helpers/fake-relay.ts';

describe('word list', () => {
  it('is the fixed 2048-word BIP-39 English list', () => {
    expect(WORDLIST).toHaveLength(2048);
    expect(new Set(WORDLIST).size).toBe(2048);
    expect(WORDLIST[0]).toBe('abandon');
    expect(WORDLIST[2047]).toBe('zoo');
    // Changing the list changes every phrase: pin it.
    expect(createHash('sha256').update(WORDLIST.join('\n')).digest('hex')).toBe(
      '187db04a869dd9bc7be80d21a86497d692c0db6abd3aa8cb6be5d618ff757fae',
    );
  });
});

describe('safety phrase', () => {
  const a = generateAgentKey();
  const b = generateAgentKey();

  it('is 4 words, deterministic and symmetric, npub or hex', () => {
    const p = safetyPhrase(a.pubkey, b.pubkey);
    expect(p).toHaveLength(4);
    for (const w of p) expect(WORDLIST).toContain(w);
    expect(safetyPhrase(a.pubkey, b.pubkey)).toEqual(p);
    expect(safetyPhrase(b.pubkey, a.pubkey)).toEqual(p);
    expect(safetyPhrase(a.npub, b.npub)).toEqual(p);
    expect(formatSafetyPhrase(p)).toBe(p.map((w) => w.toUpperCase()).join(' · '));
  });

  it('pins the derivation (fixed vector)', () => {
    const x = '1'.repeat(64);
    const y = '2'.repeat(64);
    // sha256("beamhop-pair-v1" ‖ min ‖ max), first 44 bits → 4 × 11-bit word indices.
    const h = createHash('sha256')
      .update(Buffer.concat([Buffer.from('beamhop-pair-v1'), Buffer.from(x, 'hex'), Buffer.from(y, 'hex')]))
      .digest();
    const bits = [...h].map((n) => n.toString(2).padStart(8, '0')).join('');
    const expected = [0, 1, 2, 3].map((i) => WORDLIST[Number.parseInt(bits.slice(i * 11, i * 11 + 11), 2)]);
    expect(safetyPhrase(x, y)).toEqual(expected);
  });

  it('changes with either key and spreads over the whole list (≈2^44 space)', () => {
    const c = generateAgentKey();
    expect(safetyPhrase(a.pubkey, c.pubkey)).not.toEqual(safetyPhrase(a.pubkey, b.pubkey));
    const seen = new Set<string>();
    const phrases = new Set<string>();
    for (let i = 0; i < 300; i++) {
      const p = safetyPhrase(a.pubkey, generateAgentKey().pubkey);
      for (const w of p) seen.add(w);
      phrases.add(p.join(' '));
    }
    expect(phrases.size).toBe(300);
    expect(seen.size).toBeGreaterThan(800); // 1200 draws from 2048 words
  });

  it('rejects identical or invalid keys', () => {
    expect(() => safetyPhrase(a.pubkey, a.npub)).toThrow();
    expect(() => safetyPhrase('nope', b.pubkey)).toThrow();
  });
});

describe('pairing payload', () => {
  const d = generateAgentKey();
  const p: PairingPayload = {
    v: 1,
    daemon: d.pubkey,
    relays: ['wss://relay.damus.io', 'wss://nos.lol'],
    code: 'ABC234',
    name: 'Alice’s MacBook',
    exp: 1_900_000_000,
  };

  it('round-trips through payload, URL and deep link', () => {
    const enc = encodePairingPayload(p);
    expect(enc).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(decodePairingPayload(enc)).toEqual(p);
    const url = pairingUrl(enc);
    expect(url.startsWith('https://app.beamhop.dev/pair#')).toBe(true);
    expect(decodePairingPayload(url)).toEqual(p);
    expect(pairingDeepLink(p).startsWith('beamhop://pair#')).toBe(true);
    expect(decodePairingPayload(pairingDeepLink(p))).toEqual(p);
    // npub input is normalized to hex
    expect(decodePairingPayload(encodePairingPayload({ ...p, daemon: d.npub })).daemon).toBe(d.pubkey);
  });

  it('rejects malformed payloads', () => {
    const wire = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url');
    expect(() => decodePairingPayload('')).toThrow();
    expect(() => decodePairingPayload('!!!')).toThrow();
    expect(() => decodePairingPayload(wire({ v: 2, d: d.pubkey, r: ['wss://x'], c: 'ABC234' }))).toThrow(
      /version/,
    );
    expect(() => decodePairingPayload(wire({ v: 1, d: 'zz', r: ['wss://x'], c: 'ABC234' }))).toThrow(
      /daemon/,
    );
    expect(() => decodePairingPayload(wire({ v: 1, d: d.pubkey, r: ['https://x'], c: 'ABC234' }))).toThrow(
      /relay/,
    );
    expect(() => decodePairingPayload(wire({ v: 1, d: d.pubkey, r: ['wss://x'], c: 'a b' }))).toThrow(/code/);
    expect(() => decodePairingPayload('x'.repeat(5000))).toThrow();
    expect(() => encodePairingPayload({ ...p, relays: ['http://x'] })).toThrow(/relay/);
  });
});

describe('attestation template', () => {
  it('owner device signs the template; it verifies like a daemon-signed one', () => {
    const owner = generateAgentKey();
    const agent = generateAgentKey();
    const t = buildAttestationTemplate(owner.npub, agent.npub, { name: 'rev' });
    const ev = finalizeEvent(t, owner.secretKey);
    expect(verifyAttestation(ev, { agentPubkey: agent.pubkey, ownerPubkey: owner.pubkey })).toMatchObject({
      ok: true,
    });
    expect(() => buildAttestationTemplate(owner.npub, owner.pubkey)).toThrow();
  });
});

describe('completePairing over the control plane', () => {
  let R: FakeRelay;
  const daemon = generateAgentKey();
  const owner = generateAgentKey();
  let server: ControlServer;
  const calls: { req: RpcRequest; allowlisted: boolean; sender: string }[] = [];

  beforeAll(async () => {
    R = await new FakeRelay().start();
  });
  afterAll(() => R.stop());
  afterEach(async () => {
    server?.close();
    calls.length = 0;
    await sleep(20);
    R.reset();
  });

  const start = async (rate?: { perSender: number; global: number; windowMs: number }) => {
    server = createControlServer({
      key: daemon.nsec,
      allowlist: [owner.npub],
      relays: [R.url],
      WebSocket: WebSocket as never,
      log: silentLogger,
      publicMethods: ['device.pairComplete'],
      ...(rate ? { publicRateLimit: rate } : {}),
      handle: async (req, ctx) => {
        calls.push({ req, allowlisted: ctx.allowlisted, sender: ctx.sender });
        if (req.method === 'device.pairComplete') {
          const p = req.params as { code: string; pubkey: string; name: string };
          if (p.code !== 'GOOD23')
            return {
              jsonrpc: '2.0',
              id: req.id,
              error: { code: -32001, message: 'pairing code unknown', data: { code: 'unauthorized' } },
            };
          server.setAllowlist([owner.npub, p.pubkey]);
          return {
            jsonrpc: '2.0',
            id: req.id,
            result: { id: 'dev_1', name: p.name, pubkey: p.pubkey, pairedAt: 'now', pushEnabled: false },
          };
        }
        return { jsonrpc: '2.0', id: req.id, result: { method: req.method } };
      },
    });
    await server.ready();
  };

  const payload = (code: string): PairingPayload => ({ v: 1, daemon: daemon.pubkey, relays: [R.url], code });

  it('pairs a fresh device key and returns the same safety phrase', async () => {
    await start();
    const phone = generateAgentKey();
    const r = await completePairing(encodePairingPayload(payload('GOOD23')), phone.nsec, {
      name: 'iPhone · Safari',
      WebSocket: WebSocket as never,
      timeoutMs: 3000,
    });
    expect(r.device.pubkey).toBe(phone.npub);
    expect(r.safetyPhrase).toEqual(safetyPhrase(daemon.npub, phone.npub));
    expect(calls[0]).toMatchObject({ allowlisted: false, sender: phone.pubkey });
    expect(server.allowlist()).toContain(phone.pubkey);
  });

  it('unpaired senders cannot call anything else; wrong codes are reported', async () => {
    await start();
    const phone = generateAgentKey();
    await expect(
      completePairing(payload('BAD234'), phone.secretKey, {
        name: 'x',
        WebSocket: WebSocket as never,
        timeoutMs: 3000,
      }),
    ).rejects.toThrow(/unknown/);
    const { createControlClient } = await import('../src/control-client.ts');
    const c = createControlClient({
      key: phone.secretKey,
      daemonPubkey: daemon.npub,
      relays: [R.url],
      WebSocket: WebSocket as never,
      timeoutMs: 2000,
    });
    await c.ready();
    await expect(c.call('system.status')).rejects.toThrow(/not paired/);
    c.close();
    expect(calls.map((x) => x.req.method)).toEqual(['device.pairComplete']);
  });

  it('rate-limits unknown senders before decryption', async () => {
    await start({ perSender: 2, global: 50, windowMs: 60_000 });
    const phone = generateAgentKey();
    const opts = { name: 'x', WebSocket: WebSocket as never, timeoutMs: 800 };
    await expect(completePairing(payload('BAD234'), phone.nsec, opts)).rejects.toThrow(/unknown/);
    await expect(completePairing(payload('BAD234'), phone.nsec, opts)).rejects.toThrow(/unknown/);
    // Third attempt is dropped silently (no reply → timeout), even with the right code.
    await expect(completePairing(payload('GOOD23'), phone.nsec, opts)).rejects.toThrow(/timed out/);
    expect(calls).toHaveLength(2);
  });

  it('refuses an expired payload locally', async () => {
    await expect(
      completePairing({ ...payload('GOOD23'), exp: 10 }, generateAgentKey().nsec, { name: 'x' }),
    ).rejects.toThrow(/expired/);
  });
});
