/**
 * Device pairing, phone side (JOURNEYS §9, PLAN §9 Hosting) — the data layer behind the Pair screen.
 *
 *   /pair#<payload>  →  parse  →  device key (IndexedDB) + 4-word safety phrase  →  user taps Pair
 *   →  `device.pairComplete` over the Nostr control plane (completePairing from channel-nostr)
 *   →  poll until the computer confirms (paired) / refuses (rejected) / time runs out (expired)
 *   →  persist { daemonNpub, relays } as a saved daemon (daemons.ts) so the next boot is hosted mode.
 *
 * How polling works: until the computer confirms the safety phrase the device is not on the control
 * allowlist; the daemon answers its calls with "this device is not paired" (or, past its rate limit for
 * unknown keys — 5/min — drops them). So we probe with `device.list`: not-paired / no answer = still
 * waiting; an answer that lists this device = paired; an answer without it = rejected/removed.
 * The phone cannot tell "the computer pressed No" from "nobody answered yet" (both look unpaired), so
 * a refusal after the device answered surfaces as `expired` once the confirm window closes.
 *
 * Framework-free controller (`createPairingController`) + React hook (`usePairing`).
 */
import { RelayPool as Pool, type RelayPool, type WebSocketCtor } from '@beamhop/channel-nostr';
import type { ControlClient } from '@beamhop/channel-nostr/control-client';
import { decodePubkey, npubEncode } from '@beamhop/channel-nostr/keys';
import {
  completePairing,
  decodePairingPayload,
  encodePairingPayload,
  formatSafetyPhrase,
  type PairingPayload,
  safetyPhrase,
} from '@beamhop/channel-nostr/pairing';
import type { DeviceView } from '@beamhop/core';
import { useEffect, useMemo, useState, useSyncExternalStore } from 'react';
import { type SaveDaemonInput, type SavedDaemon, saveDaemon } from './daemons.ts';
import { type HostedIdentity, resolveIdentity } from './identity.ts';
import { isUnpairedError } from './nostr.ts';
import { useMaybeBeamhop } from './provider.tsx';
import type { SignerKind } from './signer.ts';

export type { PairingPayload } from '@beamhop/channel-nostr/pairing';

export type PairingPhase =
  /** No payload yet: show "scan the QR / paste the link". */
  | 'empty'
  /** The payload could not be read (`error`). */
  | 'invalid'
  /** Loading the device key / signer. */
  | 'preparing'
  /** Payload + safety phrase ready: show "Pair with <computerName>" + device name field. */
  | 'ready'
  /** device.pairComplete in flight. */
  | 'sending'
  /** The computer has our request; the user compares the safety phrase there. */
  | 'awaiting-confirm'
  | 'paired'
  | 'rejected'
  | 'expired'
  /** Retryable failure (relays unreachable, computer offline, signer refused). */
  | 'error';

export interface PairingState {
  phase: PairingPhase;
  payload?: PairingPayload;
  /** "Alice's MacBook" from the payload, when the computer sent one. */
  computerName?: string;
  /** 4 lowercase words; the computer shows the same ones. */
  safetyPhrase?: string[];
  /** "AMBER · RELAY · OTTER · NINE" */
  safetyPhraseText?: string;
  signer: SignerKind;
  /** This browser's key as the daemon will see it. */
  deviceNpub?: string;
  /** Payload expiry (ms epoch), if any. */
  expiresAt?: number;
  /** When we stop waiting for the computer's confirmation (ms epoch). */
  confirmDeadline?: number;
  device?: DeviceView;
  daemon?: SavedDaemon;
  /** Human-readable reason for invalid / rejected / expired / error. */
  error?: string;
  /** Demo flow (mock mode / demo payload): no network, nothing persisted. */
  simulated?: boolean;
}

export type SimulatedOutcome = 'paired' | 'rejected' | 'expired';

export interface PairingDeps {
  /** Device key by default; 'nip07' asks the browser extension. */
  identity(kind: SignerKind): Promise<HostedIdentity>;
  createPool(relays: string[]): RelayPool;
  saveDaemon(input: SaveDaemonInput): SavedDaemon;
  /** ms clock */
  now(): number;
  pollIntervalMs: number;
  probeTimeoutMs: number;
  /** device.pairComplete timeout. */
  callTimeoutMs: number;
  /** How long the daemon keeps an answered pairing open for confirmation (daemon: 5 min). */
  confirmGraceMs: number;
  /** Set to run the demo flow instead of the network. */
  simulate?: { outcome: SimulatedOutcome; delayMs: number };
}

export interface PairingController {
  getState(): PairingState;
  subscribe(fn: () => void): () => void;
  /** Parse a payload, a `…/pair#<payload>` URL or a `beamhop://pair#…` link (paste / Enter code). */
  setInput(text: string): Promise<PairingState>;
  /** Switch between the device key and a NIP-07 extension (recomputes the safety phrase). */
  setSigner(kind: SignerKind): Promise<PairingState>;
  /** Send the pairing request and wait for the outcome. Resolves with the final state. */
  pair(opts: { name: string }): Promise<PairingState>;
  /** Stop waiting (closes the connection) and go back to `ready`. */
  cancel(): void;
  /**
   * After `paired`: call the daemon over the pairing connection (e.g. `device.pushSubscribe` in the
   * install + push steps) without waiting for a reload into hosted mode.
   */
  call<T = unknown>(method: string, params?: unknown): Promise<T>;
  /** Close any connection. The controller stays usable. */
  dispose(): void;
}

/** A well-formed payload for a demo daemon: `/pair#<DEMO_PAIRING_PAYLOAD>` runs the simulated flow. */
export const DEMO_DAEMON_PUBKEY = 'de'.repeat(32);
export const DEMO_PAIRING_PAYLOAD = /* @__PURE__ */ encodePairingPayload({
  v: 1,
  daemon: DEMO_DAEMON_PUBKEY,
  relays: ['wss://relay.beamhop.invalid'],
  code: 'DEMOCODE',
  name: "Alice's MacBook",
});

/** The shared safety-phrase function (same words as the computer): `["amber","relay","otter","nine"]`. */
export const pairingSafetyPhrase = (daemonPubkey: string, devicePubkey: string): string[] =>
  safetyPhrase(daemonPubkey, devicePubkey);
export { formatSafetyPhrase };

/** Parse without throwing (for live validation of a pasted link). */
export const parsePairingInput = (
  text: string,
): { ok: true; payload: PairingPayload } | { ok: false; error: string } => {
  try {
    return { ok: true, payload: decodePairingPayload(text) };
  } catch (err) {
    return { ok: false, error: friendlyParseError((err as Error).message) };
  }
};

const friendlyParseError = (msg: string): string => {
  if (/version/.test(msg)) return 'This pairing link is from a newer beamhop. Update the app and try again.';
  return 'This is not a valid pairing link. Scan the QR code again or copy the whole link.';
};

/** Default device name from the user agent: "iPhone · Safari". */
export const defaultDeviceName = (
  ua: string = typeof navigator === 'undefined' ? '' : navigator.userAgent,
) => {
  const device = /iPhone/.test(ua)
    ? 'iPhone'
    : /iPad/.test(ua)
      ? 'iPad'
      : /Android/.test(ua)
        ? 'Android'
        : /Mac OS X|Macintosh/.test(ua)
          ? 'Mac'
          : /Windows/.test(ua)
            ? 'Windows'
            : /Linux/.test(ua)
              ? 'Linux'
              : 'Browser';
  const browser = /Edg\//.test(ua)
    ? 'Edge'
    : /Firefox\/|FxiOS/.test(ua)
      ? 'Firefox'
      : /Chrome\/|CriOS/.test(ua)
        ? 'Chrome'
        : /Safari\//.test(ua)
          ? 'Safari'
          : undefined;
  return browser ? `${device} · ${browser}` : device;
};

const defaultDeps = (ws?: WebSocketCtor): PairingDeps => ({
  identity: (kind) => resolveIdentity(kind),
  createPool: (relays) => new Pool({ relays, WebSocket: ws, backoff: { initialMs: 500, maxMs: 5000 } }),
  saveDaemon: (i) => saveDaemon(i),
  now: Date.now,
  pollIntervalMs: 4000,
  probeTimeoutMs: 4000,
  callTimeoutMs: 20_000,
  confirmGraceMs: 5 * 60_000,
});

const errCode = (e: unknown): number | undefined => (e as { code?: number })?.code;
const errData = (e: unknown): string | undefined =>
  (e as { data?: { code?: string } } | undefined)?.data?.code;
const errMsg = (e: unknown): string => String((e as Error)?.message ?? e);
const isTransport = (e: unknown) => {
  const c = errCode(e);
  return c === -32001 || c === -32002 || c === -32003;
};

const sameKey = (a: string, b: string) => {
  try {
    return decodePubkey(a) === decodePubkey(b);
  } catch {
    return false;
  }
};

export const createPairingController = (overrides: Partial<PairingDeps> = {}): PairingController => {
  const deps: PairingDeps = { ...defaultDeps(), ...overrides };
  let state: PairingState = { phase: 'empty', signer: 'device' };
  const listeners = new Set<() => void>();
  let identity: HostedIdentity | undefined;
  let pool: RelayPool | undefined;
  let client: ControlClient | undefined;
  /** Bumped on every cancel/new input so stale async work cannot overwrite the state. */
  let epoch = 0;
  /** A previous pairComplete timed out: the daemon may have processed it. */
  let unsure = false;
  let sleepTimer: ReturnType<typeof setTimeout> | undefined;
  let wake: (() => void) | undefined;

  const set = (patch: Partial<PairingState>, replace = false) => {
    state = replace ? ({ signer: state.signer, ...patch } as PairingState) : { ...state, ...patch };
    for (const l of listeners) l();
    return state;
  };

  const closeNet = () => {
    if (sleepTimer) clearTimeout(sleepTimer);
    sleepTimer = undefined;
    wake?.();
    wake = undefined;
    client?.close();
    client = undefined;
    pool?.close();
    pool = undefined;
  };

  const sleep = (ms: number) =>
    new Promise<void>((r) => {
      wake = r;
      sleepTimer = setTimeout(r, ms);
    });

  const prepare = async (payload: PairingPayload): Promise<PairingState> => {
    const my = ++epoch;
    const base: Partial<PairingState> = {
      payload,
      ...(payload.name ? { computerName: payload.name } : {}),
      ...(payload.exp ? { expiresAt: payload.exp * 1000 } : {}),
      ...(deps.simulate ? { simulated: true } : {}),
    };
    set({ phase: 'preparing', ...base }, true);
    try {
      identity = await deps.identity(state.signer);
    } catch (err) {
      if (my !== epoch) return state;
      return set({ phase: 'error', ...base, error: errMsg(err) }, true);
    }
    if (my !== epoch) return state;
    const words = safetyPhrase(payload.daemon, identity.pubkey);
    if (payload.exp && payload.exp * 1000 <= deps.now())
      return set(
        {
          phase: 'expired',
          ...base,
          safetyPhrase: words,
          safetyPhraseText: formatSafetyPhrase(words),
          deviceNpub: identity.npub,
          error: 'This pairing code has expired. Ask your computer for a new one.',
        },
        true,
      );
    return set(
      {
        phase: 'ready',
        ...base,
        safetyPhrase: words,
        safetyPhraseText: formatSafetyPhrase(words),
        deviceNpub: identity.npub,
      },
      true,
    );
  };

  const finishPaired = (device: DeviceView): PairingState => {
    const p = state.payload!;
    if (deps.simulate) return set({ phase: 'paired', device });
    const daemon = deps.saveDaemon({
      daemonPubkey: p.daemon,
      relays: p.relays,
      ...(p.name ? { name: p.name } : {}),
      signer: state.signer,
      deviceId: device.id,
      ...(identity ? { deviceNpub: identity.npub } : {}),
    });
    return set({ phase: 'paired', device, daemon, error: undefined });
  };

  /**
   * The daemon's record of this device = allowlisted; `false` = it answered without us (rejected or
   * removed); `undefined` = no answer yet (not allowlisted, or offline).
   */
  const probe = async (fallback?: DeviceView): Promise<DeviceView | false | undefined> => {
    try {
      const r = await client!.call<{ devices: DeviceView[] }>('device.list', {}, deps.probeTimeoutMs);
      return (r?.devices ?? []).find((d) => !!identity && sameKey(d.pubkey, identity.pubkey)) ?? false;
    } catch (err) {
      // No answer, or "this device is not paired" (the control server's reply to unknown keys).
      if (isTransport(err) || isUnpairedError(err)) return undefined;
      // Any other daemon error means the call passed the allowlist.
      return fallback ?? false;
    }
  };

  const waitForConfirm = async (my: number, device: DeviceView): Promise<PairingState> => {
    const p = state.payload!;
    const deadline = (p.exp ? p.exp * 1000 : deps.now()) + deps.confirmGraceMs;
    set({ phase: 'awaiting-confirm', device, confirmDeadline: deadline });
    for (;;) {
      const r = await probe(device);
      if (my !== epoch) return state;
      if (r) return finishPaired(r);
      if (r === false) {
        closeNet();
        return set({ phase: 'rejected', error: 'Your computer did not accept this device.' });
      }
      if (deps.now() >= deadline) {
        closeNet();
        return set({
          phase: 'expired',
          error: 'Your computer did not confirm in time. Start pairing again on the computer.',
        });
      }
      await sleep(deps.pollIntervalMs);
      if (my !== epoch) return state;
    }
  };

  const simulatedPair = async (my: number, name: string): Promise<PairingState> => {
    const sim = deps.simulate!;
    set({ phase: 'sending' });
    await sleep(Math.min(400, sim.delayMs));
    if (my !== epoch) return state;
    const device: DeviceView = {
      id: 'dev_demo',
      name,
      pubkey: identity?.npub ?? '',
      pairedAt: new Date(deps.now()).toISOString(),
      pushEnabled: false,
    };
    set({ phase: 'awaiting-confirm', device, confirmDeadline: deps.now() + sim.delayMs });
    await sleep(sim.delayMs);
    if (my !== epoch) return state;
    if (sim.outcome === 'paired') return finishPaired(device);
    if (sim.outcome === 'rejected')
      return set({ phase: 'rejected', error: 'Your computer did not accept this device.' });
    return set({ phase: 'expired', error: 'Your computer did not confirm in time.' });
  };

  const pair = async ({ name }: { name: string }): Promise<PairingState> => {
    if (state.phase !== 'ready' && state.phase !== 'error') return state;
    const p = state.payload;
    if (!p || !identity) return state;
    const my = ++epoch;
    const deviceName = name.trim().slice(0, 80) || defaultDeviceName();
    if (deps.simulate) return simulatedPair(my, deviceName);
    if (p.exp && p.exp * 1000 <= deps.now())
      return set({
        phase: 'expired',
        error: 'This pairing code has expired. Ask your computer for a new one.',
      });
    set({ phase: 'sending', error: undefined });
    closeNet();
    pool = deps.createPool(p.relays);
    client = identity.connect({
      daemonPubkey: p.daemon,
      relays: p.relays,
      pool,
      timeoutMs: deps.callTimeoutMs,
    });
    try {
      if (unsure) {
        // The last attempt may have reached the computer; do not burn the one-time code twice.
        await client.ready();
        const r = await probe();
        if (my !== epoch) return state;
        if (r) return finishPaired(r);
      }
      let device: DeviceView;
      if (identity.secretKey) {
        const res = await completePairing(p, identity.secretKey, {
          name: deviceName,
          client,
          timeoutMs: deps.callTimeoutMs,
          now: () => Math.floor(deps.now() / 1000),
        });
        device = res.device;
      } else {
        await client.ready();
        device = await client.call<DeviceView>(
          'device.pairComplete',
          { code: p.code, pubkey: npubEncode(identity.pubkey), name: deviceName },
          deps.callTimeoutMs,
        );
      }
      if (my !== epoch) return state;
      unsure = false;
      return await waitForConfirm(my, device);
    } catch (err) {
      if (my !== epoch) return state;
      const msg = errMsg(err);
      if (isTransport(err)) {
        if (errCode(err) === -32001) unsure = true;
        closeNet();
        return set({
          phase: 'error',
          error:
            errCode(err) === -32002
              ? 'Could not reach the relays. Check your connection and try again.'
              : 'Your computer did not answer. Make sure beamhop is running there, then try again.',
        });
      }
      if (unsure && /used/.test(msg)) {
        // Our earlier request did arrive: wait for the confirmation like a normal answer.
        unsure = false;
        return waitForConfirm(my, {
          id: '',
          name: deviceName,
          pubkey: identity.npub,
          pairedAt: new Date(deps.now()).toISOString(),
          pushEnabled: false,
        });
      }
      closeNet();
      if (/expired/.test(msg))
        return set({
          phase: 'expired',
          error: 'This pairing code has expired. Ask your computer for a new one.',
        });
      if (errData(err) === 'rate_limited') return set({ phase: 'rejected', error: msg });
      if (/used/.test(msg))
        return set({
          phase: 'rejected',
          error: 'This pairing code was already used. Ask your computer for a new one.',
        });
      if (errCode(err) === undefined) return set({ phase: 'error', error: msg });
      return set({ phase: 'rejected', error: `Your computer refused the pairing: ${msg}` });
    }
  };

  return {
    getState: () => state,
    subscribe(fn) {
      listeners.add(fn);
      return () => {
        listeners.delete(fn);
      };
    },
    async setInput(text) {
      epoch++;
      closeNet();
      unsure = false;
      if (!text.trim()) return set({ phase: 'empty' }, true);
      const r = parsePairingInput(text);
      if (!r.ok) return set({ phase: 'invalid', error: r.error }, true);
      return prepare(r.payload);
    },
    async setSigner(kind) {
      if (kind === state.signer) return state;
      epoch++;
      closeNet();
      state = { ...state, signer: kind };
      return state.payload ? prepare(state.payload) : set({});
    },
    pair,
    cancel() {
      epoch++;
      closeNet();
      if (state.payload && identity && state.phase !== 'paired')
        set({ phase: 'ready', error: undefined, device: undefined, confirmDeadline: undefined });
    },
    async call<T>(method: string, params?: unknown): Promise<T> {
      if (state.phase !== 'paired') throw new Error('not paired yet');
      if (state.simulated) throw new Error('demo pairing: there is no daemon to call');
      if (!client) {
        const p = state.payload!;
        pool = deps.createPool(p.relays);
        client = identity!.connect({ daemonPubkey: p.daemon, relays: p.relays, pool });
        await client.ready();
      }
      return client.call<T>(method, params ?? {}, deps.callTimeoutMs);
    },
    dispose() {
      epoch++;
      closeNet();
    },
  };
};

// ───────────────────────────── React ─────────────────────────────

const PAYLOAD_KEY = 'bh.pairPayload';

/**
 * Read the pairing payload from the URL fragment (`/pair#<payload>`), then strip it from the address bar
 * (it carries a one-time code) and keep it in sessionStorage so a reload of the Pair screen still works.
 */
export const takePairingInputFromUrl = (loc: Location = window.location): string => {
  const frag = loc.hash.startsWith('#') ? loc.hash.slice(1) : loc.hash;
  if (frag && !frag.includes('=')) {
    try {
      sessionStorage.setItem(PAYLOAD_KEY, frag);
      history.replaceState(history.state, '', `${loc.pathname}${loc.search}`);
    } catch {
      // storage / history blocked: keep the fragment
    }
    return frag;
  }
  try {
    return sessionStorage.getItem(PAYLOAD_KEY) ?? '';
  } catch {
    return '';
  }
};

const clearStoredPayload = () => {
  try {
    sessionStorage.removeItem(PAYLOAD_KEY);
  } catch {
    // ignore
  }
};

export interface UsePairingOptions {
  /** Payload / link to start with. Default: the URL fragment (see takePairingInputFromUrl). */
  input?: string;
  /** Force the demo flow (default: on for `?mock=1` or the demo payload). `?mockPair=rejected|expired`. */
  simulate?: boolean | SimulatedOutcome;
  /** Test seams. */
  deps?: Partial<PairingDeps>;
}

export interface UsePairing extends PairingState {
  setInput(text: string): Promise<PairingState>;
  setSigner(kind: SignerKind): Promise<PairingState>;
  pair(opts: { name: string }): Promise<PairingState>;
  cancel(): void;
  call<T = unknown>(method: string, params?: unknown): Promise<T>;
  /** Reload into hosted mode on the newly saved daemon. */
  enterApp(): void;
  /** Prefill for the device name field. */
  defaultName: string;
}

const simulatedOutcome = (): SimulatedOutcome => {
  const v = typeof location === 'undefined' ? null : new URLSearchParams(location.search).get('mockPair');
  return v === 'rejected' || v === 'expired' ? v : 'paired';
};

/**
 * The Pair screen's hook.
 *
 *   const p = usePairing();
 *   p.phase === 'ready' && <p>Pair with {p.computerName}: {p.safetyPhraseText}</p>
 *   p.pair({ name })  → 'awaiting-confirm' → 'paired' | 'rejected' | 'expired' | 'error'
 */
export const usePairing = (opts: UsePairingOptions = {}): UsePairing => {
  const ctx = useMaybeBeamhop();
  const [initial] = useState(
    () => opts.input ?? (typeof window === 'undefined' ? '' : takePairingInputFromUrl()),
  );
  const simulate = useMemo<PairingDeps['simulate']>(() => {
    const parsed = parsePairingInput(initial);
    const demo = parsed.ok && parsed.payload.daemon === DEMO_DAEMON_PUBKEY;
    const auto = demo || (ctx?.connection.kind === 'mock' && ctx.connection.reason === 'mock-param');
    const on = opts.simulate ?? auto;
    if (!on) return undefined;
    return { outcome: typeof on === 'string' ? on : simulatedOutcome(), delayMs: 2500 };
  }, [initial, ctx?.connection.kind, ctx?.connection.reason, opts.simulate]);
  const [controller] = useState(() =>
    createPairingController({ ...(simulate ? { simulate } : {}), ...opts.deps }),
  );
  const state = useSyncExternalStore(controller.subscribe, controller.getState, controller.getState);

  useEffect(() => {
    if (initial) void controller.setInput(initial);
    return () => controller.dispose();
  }, [controller, initial]);

  useEffect(() => {
    if (state.phase === 'paired') clearStoredPayload();
  }, [state.phase]);

  return useMemo<UsePairing>(
    () => ({
      ...state,
      setInput: controller.setInput,
      setSigner: controller.setSigner,
      pair: controller.pair,
      cancel: controller.cancel,
      call: controller.call,
      enterApp: () => window.location.assign('/'),
      defaultName: defaultDeviceName(),
    }),
    [state, controller],
  );
};
