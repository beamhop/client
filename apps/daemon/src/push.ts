/**
 * Web Push (§9, §9B): VAPID keys (generated once, kept in the secret store), per-device push
 * subscriptions and notification preferences, and delivery through the `web-push` package.
 *
 * Payloads are minimal and never carry secrets or tool input: a title, a short body, the PWA route
 * to open and (for approvals) the approval id. Subscriptions the push service reports as gone
 * (404/410) are removed.
 */
import { createHash } from 'node:crypto';
import { BeamhopError, type PushCategory, type PushPrefs } from '@beamhop/core';
import webpush from 'web-push';
import { z } from 'zod';
import type { Daemon } from './daemon.ts';
import { errMsg } from './util.ts';

export const VAPID_SECRET = 'beamhop.push.vapid';
/** `device.pushSubscribe` id for the PWA served by the local daemon (no paired-device record). */
export const BROWSER_TARGET = 'browser';
export const PUSH_CATEGORIES: readonly PushCategory[] = [
  'approvals',
  'budget',
  'crash',
  'offline',
  'security',
];
const VAPID_SUBJECT = 'https://beamhop.dev';
const BROWSER_NS = 'push.browser';
const PREFS_NS = 'push.prefs';
const MAX_BROWSER_SUBS = 20;

/**
 * Browser push services (review wave C PUSH-1). The daemon POSTs to the endpoint from outside the
 * sandbox, so an endpoint is an outbound request target chosen by whoever registers it: only the
 * public push services of the browsers we support are accepted, on the default https port.
 */
export const PUSH_SERVICE_HOSTS: readonly string[] = [
  'fcm.googleapis.com', // Chrome, Edge (Chromium), Opera, Brave, Samsung Internet
  'android.googleapis.com', // legacy GCM endpoints
  'updates.push.services.mozilla.com', // Firefox
  'push.services.mozilla.com',
  'web.push.apple.com', // Safari, iOS 16.4+
  'notify.windows.com', // Edge (WNS: *.notify.windows.com)
];

export const isPushServiceEndpoint = (u: string): boolean => {
  let url: URL;
  try {
    url = new URL(u);
  } catch {
    return false;
  }
  if (url.protocol !== 'https:' || url.username || url.password || url.port) return false;
  const h = url.hostname.toLowerCase();
  return PUSH_SERVICE_HOSTS.some((s) => h === s || h.endsWith(`.${s}`));
};

export const PushSubscriptionInput = z.object({
  endpoint: z
    .string()
    .max(2048)
    .refine(isPushServiceEndpoint, 'endpoint must be an https URL of a browser push service'),
  expirationTime: z.number().nullable().optional(),
  keys: z.object({ p256dh: z.string().min(16).max(256), auth: z.string().min(8).max(64) }),
});
export type PushSubscriptionInput = z.infer<typeof PushSubscriptionInput>;

export interface PushPayload {
  category: PushCategory;
  title: string;
  body: string;
  /** PWA route to open on click (e.g. `/inbox/apr_x`). */
  url: string;
  approvalId?: string;
  /** Collapses repeated notifications of the same thing on the device. */
  tag?: string;
}

/** Delivery function (tests replace it with a fake push service). Same contract as webpush.sendNotification. */
export type PushSender = (
  sub: PushSubscriptionInput,
  payload: string,
  opts: webpush.RequestOptions,
) => Promise<{ statusCode: number }>;

export interface PushOptions {
  send?: PushSender;
  /** Request timeout per push (ms). */
  timeoutMs?: number;
}

interface Target {
  id: string;
  /** Prefs key (device id, or `browser`). */
  prefsKey: string;
  sub: PushSubscriptionInput;
  remove(): void;
}

export interface PushDelivery {
  target: string;
  ok: boolean;
  statusCode?: number;
  removed?: boolean;
  error?: string;
}

const subKey = (endpoint: string) => createHash('sha256').update(endpoint).digest('hex').slice(0, 32);

export class PushManager {
  private vapid: Promise<{ publicKey: string; privateKey: string }> | undefined;
  private readonly send: PushSender;

  constructor(
    private readonly d: Daemon,
    private readonly opts: PushOptions = {},
  ) {
    this.send = opts.send ?? ((sub, payload, o) => webpush.sendNotification(sub, payload, o));
  }

  /** VAPID key pair, created on first use and kept in the secret store. */
  keys(): Promise<{ publicKey: string; privateKey: string }> {
    this.vapid ??= (async () => {
      const raw = await this.d.secrets.get(VAPID_SECRET);
      if (raw) {
        try {
          const k = JSON.parse(raw) as { publicKey?: unknown; privateKey?: unknown };
          if (typeof k.publicKey === 'string' && typeof k.privateKey === 'string')
            return { publicKey: k.publicKey, privateKey: k.privateKey };
        } catch {
          /* regenerate below */
        }
        this.d.log.warn('stored VAPID keys are unreadable; generating new ones (devices must resubscribe)');
      }
      const k = webpush.generateVAPIDKeys();
      await this.d.secrets.set(VAPID_SECRET, JSON.stringify(k));
      this.d.invalidateSecretCache();
      return k;
    })();
    this.vapid.catch(() => {
      this.vapid = undefined;
    });
    return this.vapid;
  }

  async publicKey(): Promise<string> {
    return (await this.keys()).publicKey;
  }

  /** Store or (subscription null) remove a subscription. `id` is a device id or `browser`. */
  subscribe(id: string, subscription: unknown): void {
    const d = this.d;
    const sub = subscription == null ? null : PushSubscriptionInput.safeParse(subscription);
    if (sub && !sub.success)
      throw new BeamhopError(
        'invalid_input',
        `invalid push subscription: ${sub.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`,
      );
    if (id === BROWSER_TARGET) {
      if (!sub) {
        for (const k of d.store.kv.keys(BROWSER_NS)) d.store.kv.delete(BROWSER_NS, k);
        return;
      }
      const keys = d.store.kv.keys(BROWSER_NS);
      const k = subKey(sub.data.endpoint);
      if (!keys.includes(k) && keys.length >= MAX_BROWSER_SUBS)
        throw new BeamhopError('rate_limited', 'too many browser push subscriptions; remove some first');
      d.store.kv.set(BROWSER_NS, k, sub.data);
      return;
    }
    if (!d.store.devices.get(id)) throw new BeamhopError('not_found', `device ${id} not found`);
    d.store.devices.setPush(id, sub ? sub.data : null);
  }

  prefs(id: string): PushPrefs {
    const stored = this.d.store.kv.get<Partial<PushPrefs>>(PREFS_NS, id) ?? {};
    return Object.fromEntries(PUSH_CATEGORIES.map((c) => [c, stored[c] !== false])) as PushPrefs;
  }

  setPrefs(id: string, patch: Partial<PushPrefs>): PushPrefs {
    if (id !== BROWSER_TARGET && !this.d.store.devices.get(id))
      throw new BeamhopError('not_found', `device ${id} not found`);
    const next = { ...this.prefs(id), ...patch };
    this.d.store.kv.set(PREFS_NS, id, next);
    return next;
  }

  /** Forget everything about a removed device. */
  forgetDevice(id: string): void {
    this.d.store.kv.delete(PREFS_NS, id);
  }

  private targets(): Target[] {
    const d = this.d;
    const out: Target[] = [];
    for (const dev of d.store.devices.list()) {
      if (!dev.pushEnabled || d.store.kv.get('device-pending', dev.id)) continue;
      const parsed = PushSubscriptionInput.safeParse(d.store.devices.pushSubscription(dev.id));
      if (!parsed.success) continue;
      out.push({
        id: dev.id,
        prefsKey: dev.id,
        sub: parsed.data,
        remove: () => d.store.devices.setPush(dev.id, null),
      });
    }
    for (const k of d.store.kv.keys(BROWSER_NS)) {
      const parsed = PushSubscriptionInput.safeParse(d.store.kv.get(BROWSER_NS, k));
      if (!parsed.success) continue;
      out.push({
        id: `${BROWSER_TARGET}:${k.slice(0, 8)}`,
        prefsKey: BROWSER_TARGET,
        sub: parsed.data,
        remove: () => d.store.kv.delete(BROWSER_NS, k),
      });
    }
    return out;
  }

  /** Send one notification to every subscribed device that has the category on. */
  async notify(p: PushPayload): Promise<PushDelivery[]> {
    const targets = this.targets().filter((t) => this.prefs(t.prefsKey)[p.category]);
    if (!targets.length) return [];
    const vapid = await this.keys();
    const payload = JSON.stringify({
      title: p.title.slice(0, 120),
      body: p.body.slice(0, 240),
      url: p.url,
      category: p.category,
      ...(p.approvalId ? { approvalId: p.approvalId } : {}),
      ...(p.tag ? { tag: p.tag } : {}),
    });
    const proxy = process.env.HTTPS_PROXY ?? process.env.https_proxy;
    const opts: webpush.RequestOptions = {
      vapidDetails: { subject: VAPID_SUBJECT, publicKey: vapid.publicKey, privateKey: vapid.privateKey },
      TTL: p.category === 'approvals' ? 3600 : 24 * 3600,
      urgency: p.category === 'approvals' || p.category === 'security' ? 'high' : 'normal',
      timeout: this.opts.timeoutMs ?? 10_000,
      ...(proxy ? { proxy } : {}),
    };
    return Promise.all(
      targets.map(async (t): Promise<PushDelivery> => {
        try {
          const r = await this.send(t.sub, payload, opts);
          return { target: t.id, ok: true, statusCode: r.statusCode };
        } catch (e) {
          const status = (e as { statusCode?: number }).statusCode;
          if (status === 404 || status === 410) {
            t.remove();
            this.d.log.info('push subscription expired; removed', { target: t.id, status });
            return { target: t.id, ok: false, statusCode: status, removed: true };
          }
          this.d.log.warn('push failed', { target: t.id, ...(status ? { status } : {}), error: errMsg(e) });
          return { target: t.id, ok: false, ...(status ? { statusCode: status } : {}), error: errMsg(e) };
        }
      }),
    );
  }
}
