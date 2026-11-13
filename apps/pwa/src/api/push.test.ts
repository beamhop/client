import { afterEach, describe, expect, it, vi } from 'vitest';
import { createMockTransport } from './mock/index.ts';
import {
  disablePush,
  enablePush,
  getPushPrefs,
  type PushApi,
  pushSupport,
  setPushPref,
  urlBase64ToUint8Array,
} from './push.ts';

const originalNavigator = Object.getOwnPropertyDescriptor(globalThis, 'navigator');

const fakeApi = () => {
  const calls: { method: string; params: unknown }[] = [];
  const api: PushApi = {
    call: (async (method: string, params?: unknown) => {
      calls.push({ method, params });
      if (method === 'device.pushKey') return { publicKey: 'AQIDBA' };
      return { ok: true };
    }) as PushApi['call'],
  };
  return { api, calls };
};

const installPush = (opts: { permission: NotificationPermission; existingKey?: number[] }) => {
  const unsubscribe = vi.fn(async () => true);
  const subscribe = vi.fn(async (o: { applicationServerKey: Uint8Array }) => ({
    options: { applicationServerKey: o.applicationServerKey.buffer },
    unsubscribe,
    toJSON: () => ({ endpoint: 'https://push.example/new', keys: { p256dh: 'p', auth: 'a' } }),
  }));
  const existing = opts.existingKey
    ? {
        options: { applicationServerKey: new Uint8Array(opts.existingKey).buffer },
        unsubscribe,
        toJSON: () => ({ endpoint: 'https://push.example/old', keys: { p256dh: 'p', auth: 'a' } }),
      }
    : null;
  const reg = { pushManager: { getSubscription: vi.fn(async () => existing), subscribe } };
  Object.defineProperty(globalThis, 'navigator', {
    configurable: true,
    value: { serviceWorker: { ready: Promise.resolve(reg), getRegistration: async () => reg } },
  });
  vi.stubGlobal('PushManager', class {});
  vi.stubGlobal(
    'Notification',
    Object.assign(class {}, {
      permission: opts.permission,
      requestPermission: vi.fn(async () => 'granted' as NotificationPermission),
    }),
  );
  return { subscribe, unsubscribe };
};

afterEach(() => {
  vi.unstubAllGlobals();
  if (originalNavigator) Object.defineProperty(globalThis, 'navigator', originalNavigator);
});

describe('push helper', () => {
  it('decodes base64url VAPID keys', () => {
    expect([...urlBase64ToUint8Array('AQIDBA')]).toEqual([1, 2, 3, 4]);
    expect([...urlBase64ToUint8Array('-_8')]).toEqual([251, 255]);
  });

  it('reports unsupported browsers without calling the daemon', async () => {
    const { api, calls } = fakeApi();
    expect(pushSupport()).toBe('unsupported');
    expect(await enablePush(api, 'browser')).toBe('unsupported');
    expect(calls).toHaveLength(0);
  });

  it('asks for permission, subscribes with the VAPID key and registers the subscription', async () => {
    const { subscribe } = installPush({ permission: 'default' });
    const { api, calls } = fakeApi();
    expect(await enablePush(api, 'dev_1')).toBe('subscribed');
    expect([...subscribe.mock.calls[0]![0].applicationServerKey]).toEqual([1, 2, 3, 4]);
    expect(calls.map((c) => c.method)).toEqual(['device.pushKey', 'device.pushSubscribe']);
    expect(calls[1]!.params).toEqual({
      id: 'dev_1',
      subscription: { endpoint: 'https://push.example/new', keys: { p256dh: 'p', auth: 'a' } },
    });
  });

  it('replaces a subscription made for another VAPID key, keeps a matching one', async () => {
    let p = installPush({ permission: 'granted', existingKey: [9, 9] });
    await enablePush(fakeApi().api, 'browser');
    expect(p.unsubscribe).toHaveBeenCalled();
    expect(p.subscribe).toHaveBeenCalled();
    p = installPush({ permission: 'granted', existingKey: [1, 2, 3, 4] });
    const { api, calls } = fakeApi();
    await enablePush(api, 'browser');
    expect(p.subscribe).not.toHaveBeenCalled();
    expect((calls[1]!.params as { subscription: { endpoint: string } }).subscription.endpoint).toBe(
      'https://push.example/old',
    );
  });

  it('stops when permission is denied, and disable tells the daemon', async () => {
    installPush({ permission: 'denied' });
    const { api, calls } = fakeApi();
    expect(pushSupport()).toBe('denied');
    expect(await enablePush(api, 'browser')).toBe('denied');
    await disablePush(api, 'browser');
    expect(calls).toEqual([
      { method: 'device.pushSubscribe', params: { id: 'browser', subscription: null } },
    ]);
  });

  it('reads and toggles notification categories (mock daemon)', async () => {
    const t = createMockTransport({ live: false, latency: [0, 0] });
    const api: PushApi = { call: ((m: string, p?: unknown) => t.request(m, p ?? {})) as PushApi['call'] };
    expect(await getPushPrefs(api, 'dev_mac')).toMatchObject({ approvals: true, budget: true });
    expect(await setPushPref(api, 'dev_mac', 'budget', false)).toMatchObject({
      approvals: true,
      budget: false,
    });
    expect((await getPushPrefs(api, 'dev_mac')).budget).toBe(false);
    t.close?.();
  });
});
