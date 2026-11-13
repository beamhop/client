import { generateAgentKey } from '@beamhop/channel-nostr/keys';
import { encodePairingPayload, pairingUrl, safetyPhrase } from '@beamhop/channel-nostr/pairing';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MockPairing, REPLY_MS, SIMULATED_PHONE_MS } from '../../api/mock/pairing.ts';
import { deviceNameFromUA } from './deviceKey.ts';
import { formatPairCode, tryDecodePayload, tryPhrase } from './safetyPhrase.ts';

describe('pairing helpers', () => {
  it('formats manual codes and rejects anything else', () => {
    expect(formatPairCode('ambr rly8')).toBe('AMBR-RLY8');
    expect(formatPairCode('AMBR-RLY8')).toBe('AMBR-RLY8');
    expect(formatPairCode('ambr-rly')).toBeNull();
    expect(formatPairCode('AMBR-RLY8X')).toBeNull();
    expect(formatPairCode('AMB!-RLY8')).toBeNull();
  });

  it('decodes a pairing URL fragment and rejects garbage', () => {
    const daemon = generateAgentKey();
    const payload = encodePairingPayload({
      v: 1,
      daemon: daemon.pubkey,
      relays: ['wss://relay.example'],
      code: 'AMBR-RLY8',
    });
    const p = tryDecodePayload(pairingUrl(payload));
    expect(p).toMatchObject({ daemon: daemon.pubkey, code: 'AMBR-RLY8', relays: ['wss://relay.example'] });
    expect(tryDecodePayload(payload)?.code).toBe('AMBR-RLY8');
    expect(tryDecodePayload('not-a-payload')).toBeUndefined();
    expect(tryDecodePayload('')).toBeUndefined();
  });

  it('shows the same 4 uppercase words on both sides', () => {
    const daemon = generateAgentKey();
    const phone = generateAgentKey();
    const a = tryPhrase(daemon.npub, phone.pubkey);
    const b = tryPhrase(phone.npub, daemon.pubkey);
    expect(a).toHaveLength(4);
    expect(a).toEqual(b);
    expect(a?.every((w) => w === w.toUpperCase())).toBe(true);
    expect(a).toEqual(safetyPhrase(daemon.pubkey, phone.pubkey).map((w) => w.toUpperCase()));
    expect(tryPhrase(undefined, phone.pubkey)).toBeUndefined();
    expect(tryPhrase('npub1nonsense', phone.pubkey)).toBeUndefined();
  });

  it('names a device from its user agent', () => {
    expect(
      deviceNameFromUA(
        'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1',
      ),
    ).toBe('iPhone · Safari');
    expect(
      deviceNameFromUA(
        'Mozilla/5.0 (Linux; Android 15; Pixel 9) AppleWebKit/537.36 Chrome/131.0 Mobile Safari/537.36',
      ),
    ).toBe('Pixel · Chrome');
    expect(
      deviceNameFromUA('Mozilla/5.0 (Macintosh; Intel Mac OS X 14.5; rv:132.0) Gecko/20100101 Firefox/132.0'),
    ).toBe('Mac · Firefox');
    expect(deviceNameFromUA('')).toBe('This device · Browser');
  });
});

describe('mock pairing flow (trusted-side confirmation)', () => {
  afterEach(() => vi.useRealTimers());
  const setup = () => {
    const devices: string[] = [];
    const audit: string[] = [];
    const m = new MockPairing({ addDevice: (d) => devices.push(d.name), audit: (t) => audit.push(t) });
    return { m, devices, audit };
  };

  it('waits, then a phone answers with the code and the computer confirms the phrase', () => {
    const { m, devices, audit } = setup();
    const s = m.start('New device', true);
    expect(tryDecodePayload(s.uri)?.daemon).toBe(m.daemonKey.pubkey);
    expect(m.status(s.pairingId).status).toBe('waiting');
    const phone = generateAgentKey();
    m.complete(s.code.toLowerCase(), phone.npub, 'Pixel · Chrome');
    const st = m.status(s.pairingId);
    expect(st.status).toBe('awaiting-confirm');
    expect(st.safetyPhrase).toEqual(safetyPhrase(m.daemonKey.pubkey, phone.pubkey));
    expect(devices).toEqual([]); // not on the allowlist before confirmation
    expect(m.confirm(s.pairingId, true).status).toBe('paired');
    expect(devices).toEqual(['Pixel · Chrome']);
    expect(audit).toContain('device.paired');
  });

  it('a mismatch rejects and logs a failed pairing; nothing is paired', () => {
    const { m, devices, audit } = setup();
    const s = m.start('New device', true);
    m.complete(s.code, generateAgentKey().npub, 'Unknown');
    expect(m.confirm(s.pairingId, false).status).toBe('rejected');
    expect(devices).toEqual([]);
    expect(audit).toContain('pairing.failed');
  });

  it('simulates a phone in the single-tab demo and expires stale codes', () => {
    vi.useFakeTimers();
    const { m } = setup();
    const s = m.start('New device', true);
    vi.advanceTimersByTime(SIMULATED_PHONE_MS + 10);
    expect(m.status(s.pairingId)).toMatchObject({
      status: 'awaiting-confirm',
      device: { name: 'iPhone · Safari' },
    });
    expect(m.status('pair_unknown').status).toBe('expired');
  });

  it('hello: no reply until the phone answers', () => {
    vi.useFakeTimers();
    const { m } = setup();
    expect(m.helloStatus('reviewer')).toEqual({ sent: false, replied: false });
    m.hello('reviewer');
    expect(m.helloStatus('reviewer')).toMatchObject({ sent: true, replied: false });
    vi.advanceTimersByTime(REPLY_MS + 10);
    const st = m.helloStatus('reviewer');
    expect(st).toMatchObject({ sent: true, replied: true });
    expect(new Date(st.repliedAt!).getTime() - new Date(st.sentAt!).getTime()).toBe(REPLY_MS);
  });
});
