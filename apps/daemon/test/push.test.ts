// Web Push (§9, §9B) against a fake push service: VAPID key handling, subscriptions, per-device
// prefs, minimal secret-free payloads (decrypted here per RFC 8291), and 404/410 cleanup.
import { createDecipheriv, createECDH, createHmac, randomBytes } from 'node:crypto';
import { createServer, type IncomingHttpHeaders, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import webpush from 'web-push';
import { BROWSER_TARGET, type PushSender, VAPID_SECRET } from '../src/push.ts';
import { makeEnv, ownerAlice, setupBot, type TestEnv, until } from './helpers.ts';

// ───────────────────────────── fake push service ─────────────────────────────

interface Received {
  path: string;
  headers: IncomingHttpHeaders;
  body: Buffer;
}

class FakePushService {
  readonly received: Received[] = [];
  /** Status per path (default 201). */
  readonly status = new Map<string, number>();
  private server!: Server;
  base = '';

  async start(): Promise<this> {
    this.server = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (c: Buffer) => chunks.push(c));
      req.on('end', () => {
        const path = req.url ?? '/';
        this.received.push({ path, headers: req.headers, body: Buffer.concat(chunks) });
        res.statusCode = this.status.get(path) ?? 201;
        res.end();
      });
    });
    await new Promise<void>((r) => this.server.listen(0, '127.0.0.1', () => r()));
    this.base = `http://127.0.0.1:${(this.server.address() as AddressInfo).port}`;
    return this;
  }

  stop() {
    this.server.close();
  }

  /** Delivery used by the daemon: web-push builds the encrypted, VAPID-signed request; we POST it here. */
  sender(): PushSender {
    return async (sub, payload, opts) => {
      const det = webpush.generateRequestDetails(sub, payload, opts);
      const url = new URL(det.endpoint);
      const res = await fetch(`${this.base}${url.pathname}`, {
        method: 'POST',
        headers: det.headers as Record<string, string>,
        body: det.body ? new Uint8Array(det.body) : null,
      });
      if (res.status >= 400)
        throw Object.assign(new Error(`push service answered ${res.status}`), { statusCode: res.status });
      return { statusCode: res.status };
    };
  }
}

/** A browser-side subscription: P-256 key pair + auth secret (RFC 8291). */
const browserSub = (path: string) => {
  const ecdh = createECDH('prime256v1');
  ecdh.generateKeys();
  const auth = randomBytes(16);
  return {
    sub: {
      endpoint: `https://push.invalid${path}`,
      keys: { p256dh: ecdh.getPublicKey().toString('base64url'), auth: auth.toString('base64url') },
    },
    decrypt(body: Buffer): Record<string, unknown> {
      const hmac = (key: Buffer, data: Buffer) => createHmac('sha256', key).update(data).digest();
      const salt = body.subarray(0, 16);
      const idlen = body[20]!;
      const asPublic = body.subarray(21, 21 + idlen);
      const ct = body.subarray(21 + idlen);
      const shared = ecdh.computeSecret(asPublic);
      const prkKey = hmac(auth, shared);
      const keyInfo = Buffer.concat([
        Buffer.from('WebPush: info\0'),
        ecdh.getPublicKey(),
        asPublic,
        Buffer.from([1]),
      ]);
      const ikm = hmac(prkKey, keyInfo).subarray(0, 32);
      const prk = hmac(salt, ikm);
      const cek = hmac(prk, Buffer.from('Content-Encoding: aes128gcm\0\x01')).subarray(0, 16);
      const nonce = hmac(prk, Buffer.from('Content-Encoding: nonce\0\x01')).subarray(0, 12);
      const d = createDecipheriv('aes-128-gcm', cek, nonce);
      d.setAuthTag(ct.subarray(ct.length - 16));
      const plain = Buffer.concat([d.update(ct.subarray(0, ct.length - 16)), d.final()]);
      let end = plain.length - 1;
      while (end > 0 && plain[end] === 0) end--;
      return JSON.parse(plain.subarray(0, end).toString('utf8'));
    },
  };
};

// ───────────────────────────── tests ─────────────────────────────

let P: FakePushService;
let env: TestEnv | undefined;
beforeAll(async () => {
  P = await new FakePushService().start();
});
afterAll(() => P.stop());
afterEach(async () => {
  await env?.d.alerts.settled();
  await env?.close();
  env = undefined;
  P.received.length = 0;
  P.status.clear();
});

const start = async (alerts?: { spikeThreshold?: number }) => {
  env = await makeEnv({ push: { send: P.sender() }, ...(alerts ? { alerts } : {}) });
  return env;
};

const addDevice = (e: TestEnv, name: string) =>
  e.d.store.devices.add({ name, pubkey: `npub1${name}${'q'.repeat(20)}` });

const delivered = (path: string) => P.received.filter((r) => r.path === path);

describe('web push', () => {
  it('generates the VAPID key once, keeps it in the secret store and hides it from secret.list', async () => {
    const e = await start();
    const { publicKey } = await e.client.call('device.pushKey');
    expect(Buffer.from(publicKey, 'base64url')).toHaveLength(65);
    expect((await e.client.call('device.pushKey')).publicKey).toBe(publicKey);
    const stored = JSON.parse((await e.secrets.get(VAPID_SECRET))!);
    expect(stored.publicKey).toBe(publicKey);
    expect((await e.client.call('secret.list')).secrets.map((s) => s.name)).not.toContain(VAPID_SECRET);
  });

  it('pushes a minimal approval notification (no tool input) to subscribed devices, VAPID-signed', async () => {
    const e = await start();
    const conn = await setupBot(e);
    await ownerAlice(e);
    const dev = addDevice(e, 'phone');
    const b = browserSub('/phone');
    await e.client.call('device.pushSubscribe', { id: dev.id, subscription: b.sub });
    const local = browserSub('/local');
    await e.client.call('device.pushSubscribe', { id: BROWSER_TARGET, subscription: local.sub });
    conn.inject({ text: 'hi' });
    await until(() => conn.textsTo('alice').some((t) => t.includes('reply: hi')));
    conn.inject({
      conversation: { kind: 'group', id: 'g1' },
      from: { principal: 'fake:bob', displayName: 'Bob' },
      text: '@beambot RUN_SHELL',
      mentionsAgent: true,
    });
    await until(() => e.d.store.approvals.list().length === 1, 3000, 'approval');
    const approval = e.d.store.approvals.list()[0]!;
    await until(() => delivered('/phone').length === 1 && delivered('/local').length === 1, 3000, 'push');
    const req = delivered('/phone')[0]!;
    expect(req.headers['content-encoding']).toBe('aes128gcm');
    expect(String(req.headers.authorization)).toMatch(/^vapid t=.+, k=/);
    expect(req.headers.urgency).toBe('high');
    const payload = b.decrypt(req.body);
    expect(payload).toEqual({
      title: 'Approval needed',
      body: 'bot wants to run bash (high risk)',
      url: `/inbox/${approval.id}`,
      category: 'approvals',
      approvalId: approval.id,
      tag: `approval-${approval.id}`,
    });
    // The tool input never leaves in a push.
    expect(JSON.stringify(payload)).not.toMatch(/command|"ls"/);
    expect(local.decrypt(delivered('/local')[0]!.body)).toMatchObject({ approvalId: approval.id });
  });

  it('respects per-device category prefs', async () => {
    const e = await start();
    const a = addDevice(e, 'a');
    const b = addDevice(e, 'b');
    await e.client.call('device.pushSubscribe', { id: a.id, subscription: browserSub('/a').sub });
    await e.client.call('device.pushSubscribe', { id: b.id, subscription: browserSub('/b').sub });
    expect((await e.client.call('device.pushPrefs', { id: a.id })).prefs).toEqual({
      approvals: true,
      budget: true,
      crash: true,
      offline: true,
      security: true,
    });
    const r = await e.client.call('device.pushPrefs', { id: a.id, prefs: { budget: false } });
    expect(r.prefs.budget).toBe(false);
    expect(r.prefs.approvals).toBe(true);
    e.d.audit({
      type: 'budget.alert',
      severity: 'warn',
      summary: 'bot used 80%',
      actor: 'system:budget',
      agent: 'bot',
      data: { metric: 'usd', threshold: 0.8, used: 4, limit: 5 },
    });
    await e.d.alerts.settled();
    expect(delivered('/a')).toHaveLength(0);
    expect(delivered('/b')).toHaveLength(1);
    await expect(
      e.client.call('device.pushPrefs', { id: 'dev_nope', prefs: { crash: false } }),
    ).rejects.toThrow(/not found/);
  });

  it('removes subscriptions the push service reports gone (404/410), keeps them on other errors', async () => {
    const e = await start();
    const gone = addDevice(e, 'gone');
    const flaky = addDevice(e, 'flaky');
    await e.client.call('device.pushSubscribe', { id: gone.id, subscription: browserSub('/gone').sub });
    await e.client.call('device.pushSubscribe', { id: flaky.id, subscription: browserSub('/flaky').sub });
    await e.client.call('device.pushSubscribe', {
      id: BROWSER_TARGET,
      subscription: browserSub('/lost').sub,
    });
    P.status.set('/gone', 410);
    P.status.set('/lost', 404);
    P.status.set('/flaky', 500);
    const res = await e.d.push.notify({ category: 'crash', title: 't', body: 'b', url: '/' });
    expect(res.filter((r) => r.removed)).toHaveLength(2);
    const devs = (await e.client.call('device.list')).devices;
    expect(devs.find((d) => d.id === gone.id)!.pushEnabled).toBe(false);
    expect(devs.find((d) => d.id === flaky.id)!.pushEnabled).toBe(true);
    P.received.length = 0;
    await e.d.push.notify({ category: 'crash', title: 't', body: 'b', url: '/' });
    expect(P.received.map((r) => r.path)).toEqual(['/flaky']);
  });

  it('alerts: budget, agent crash (throttled), cloud agent offline, security spike', async () => {
    const e = await start({ spikeThreshold: 3 });
    const dev = addDevice(e, 'p');
    const b = browserSub('/p');
    await e.client.call('device.pushSubscribe', { id: dev.id, subscription: b.sub });
    const audit = (
      type: string,
      severity: 'info' | 'warn' | 'security',
      data: Record<string, unknown> = {},
    ) => e.d.audit({ type, severity, summary: type, actor: 'test', agent: 'bot', data });
    audit('budget.alert', 'security', { threshold: 1 });
    audit('agent.crash', 'warn');
    audit('agent.crash', 'warn'); // throttled
    audit('remote.offline', 'warn', { deployment: 'hetzner:bot', provider: 'hetzner' });
    await e.d.alerts.settled();
    audit('dlp.hit', 'security');
    audit('attachment.refused', 'security'); // 3rd security event (budget 100% counted) → spike
    audit('dlp.hit', 'security'); // same window: no second spike
    await e.d.alerts.settled();
    const got = delivered('/p').map((r) => b.decrypt(r.body));
    expect(got.map((p) => [p.category, p.title, p.url])).toEqual([
      ['budget', 'Budget exhausted', '/agents/bot'],
      ['crash', 'Agent crashed', '/agents/bot'],
      ['offline', 'Cloud agent offline', '/deploy/hetzner%3Abot'],
      ['security', 'Security events spiking', '/audit'],
    ]);
    expect(e.d.store.audit.query({ type: 'security.spike' })).toHaveLength(1);
  });

  it('a harness failure is audited as a crash and pushed', async () => {
    const e = await start();
    e.harness.script = async function* () {
      yield { type: 'text', delta: 'x' };
      throw new Error('harness exited with code 1');
    };
    const conn = await setupBot(e);
    await ownerAlice(e);
    const dev = addDevice(e, 'c');
    await e.client.call('device.pushSubscribe', { id: dev.id, subscription: browserSub('/c').sub });
    conn.inject({ text: 'hello' });
    await until(() => e.d.store.audit.query({ type: 'agent.crash' }).length === 1, 3000, 'crash audit');
    await e.d.alerts.settled();
    expect(delivered('/c')).toHaveLength(1);
  });

  it('validates subscriptions and confines devices to their own settings', async () => {
    const e = await start();
    const a = addDevice(e, 'mine');
    const other = addDevice(e, 'other');
    const sub = browserSub('/x').sub;
    await expect(
      e.client.call('device.pushSubscribe', {
        id: a.id,
        subscription: { ...sub, endpoint: 'http://push.invalid/x' },
      }),
    ).rejects.toThrow(/https/);
    await expect(
      e.client.call('device.pushSubscribe', { id: 'dev_missing', subscription: sub }),
    ).rejects.toThrow(/not found/);
    const asDevice = (method: string, params: unknown) =>
      e.d.dispatch(
        { jsonrpc: '2.0', id: 1, method, params },
        { caller: `nostr:${a.pubkey}`, transport: 'nostr' },
      );
    expect(await asDevice('device.pushSubscribe', { id: a.id, subscription: sub })).toMatchObject({
      result: { ok: true },
    });
    for (const id of [other.id, BROWSER_TARGET])
      expect(await asDevice('device.pushSubscribe', { id, subscription: sub })).toMatchObject({
        error: { data: { code: 'forbidden' } },
      });
    expect(await asDevice('device.pushPrefs', { id: other.id, prefs: { crash: false } })).toMatchObject({
      error: { data: { code: 'forbidden' } },
    });
    // Unsubscribe and device removal forget the subscription and prefs.
    await e.client.call('device.pushPrefs', { id: a.id, prefs: { crash: false } });
    await e.client.call('device.remove', { id: a.id });
    expect(e.d.store.kv.get('push.prefs', a.id)).toBeUndefined();
  });
});
