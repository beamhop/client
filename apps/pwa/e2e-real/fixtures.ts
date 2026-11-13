/**
 * Shared fixtures for the real-backend suite. `bh` resets the daemon to a fresh, seeded home before
 * every test (fake channel `fk`, agent `bot` on `fk:dm`, owner `fake:alice`) and gives the test:
 *   - `open(page, path)`  → the PWA at `<daemon>/<path>#token=<api token>` (real WebSocket transport),
 *                           always a fresh load (also when the page already shows `path`)
 *   - `rpc(method, params)` → the daemon's own JSON-RPC over HTTP (verification from the outside)
 *   - `inject`, `snapshot`, `advance` → drive the fake channel / harness / clock (control API)
 *   - `seedGit()` → agent `bot` gets a rw git mount `~/code/app` with a bare remote (control API)
 * The daemon runs with a throwaway HOME (`userHome`), emptied on every reset.
 */
import AxeBuilder from '@axe-core/playwright';
import { test as base, expect, type Page } from '@playwright/test';
import { CONTROL_PORT } from './ports.ts';

export interface DaemonInfo {
  url: string;
  token: string;
  home: string;
  /** The daemon's (fake) home directory: what `~` means to it. */
  userHome: string;
}

export interface GitSeed {
  /** Absolute path of the repository mounted read-write by `bot` (checked out on `main`). */
  repo: string;
  /** Absolute path of the bare repository that is the repo's `origin`. */
  remote: string;
  /** The mount path as configured (`~/code/app`). */
  mount: string;
}

export interface Snapshot {
  sent: Record<string, { conversation: string; text: string; buttons: string[] }[]>;
  harness: {
    id: string;
    agent: string;
    prompts: string[];
    decisions: Record<string, { allow: boolean; reason?: string }>;
    cancelled: number;
    closed: boolean;
  }[];
}

export interface InjectMsg {
  text: string;
  channel?: string;
  conversation?: { kind: 'dm' | 'group' | 'public'; id: string };
  from?: { principal: string; displayName?: string };
  mentionsAgent?: boolean;
}

export class RpcFailure extends Error {
  constructor(
    message: string,
    readonly code: number,
    readonly data: unknown,
  ) {
    super(message);
  }
}

const control = process.env.BH_E2E_CONTROL ?? `http://127.0.0.1:${CONTROL_PORT}`;

const ctl = async <T>(path: string, body?: unknown): Promise<T> => {
  const r = await fetch(`${control}${path}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { 'content-type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const j = (await r.json()) as T & { error?: string };
  if (!r.ok) throw new Error(`control ${path}: ${j.error ?? r.status}`);
  return j;
};

export interface Bh extends DaemonInfo {
  open(page: Page, path?: string): Promise<void>;
  rpc<T = Record<string, unknown>>(method: string, params?: unknown): Promise<T>;
  inject(m: InjectMsg): Promise<{ id: string }>;
  snapshot(): Promise<Snapshot>;
  advance(ms: number): Promise<void>;
  /** A sandbox violation in every live session (returns how many sandboxes reported it). */
  violate(v: { kind: 'net.allow' | 'fs.read' | 'fs.write'; value: string }): Promise<number>;
  /** Fake-channel messages the daemon sent to one conversation (final text). */
  sentTo(conversation: string, channel?: string): Promise<string[]>;
  /** Give `bot` a rw git mount with a bare `origin` (sessions then run on a worktree). */
  seedGit(): Promise<GitSeed>;
}

export const test = base.extend<{ bh: Bh }>({
  // biome-ignore lint/correctness/noEmptyPattern: Playwright requires a destructuring first parameter
  bh: async ({}, use) => {
    const info = await ctl<DaemonInfo>('/reset', {});
    const rpc = async <T>(method: string, params: unknown = {}): Promise<T> => {
      const r = await fetch(`${info.url}/rpc`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${info.token}` },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
      });
      const j = (await r.json()) as {
        result?: T;
        error?: { message: string; code: number; data?: unknown };
      };
      if (j.error) throw new RpcFailure(j.error.message, j.error.code, j.error.data);
      return j.result as T;
    };
    const snapshot = () => ctl<Snapshot>('/snapshot');
    await use({
      ...info,
      open: async (page, path = '/') => {
        // Same path and query: a hash-only change would not reload the app (and its caches).
        const now = page.url().startsWith('http') ? new URL(page.url()) : undefined;
        if (now && `${now.pathname}${now.search}` === path) await page.goto('about:blank');
        await page.goto(`${path}#token=${info.token}`);
        await expect(page.locator('#bh-main-content').first()).toBeVisible();
      },
      rpc,
      inject: (m) => ctl('/inject', m),
      snapshot,
      advance: async (ms) => {
        await ctl('/advance', { ms });
      },
      seedGit: () => ctl<GitSeed>('/git', {}),
      violate: async (v) => (await ctl<{ sinks: number }>('/violation', v)).sinks,
      sentTo: async (conversation, channel = 'fk') =>
        ((await snapshot()).sent[channel] ?? [])
          .filter((s) => s.conversation === conversation)
          .map((s) => s.text),
    });
  },
});

export { expect };

/** axe (serious/critical, WCAG 2.2 AA tags) + no horizontal page scroll, like `e2e/`. */
export const axe = async (page: Page) => {
  // Live data animates in (slips, rows); let finite animations settle so contrast is measured at rest.
  await page.evaluate(async () => {
    const finite = document
      .getAnimations()
      .filter((a) => Number.isFinite(Number(a.effect?.getComputedTiming().endTime ?? 0)));
    await Promise.all(finite.map((a) => a.finished.catch(() => undefined)));
  });
  await page.waitForTimeout(400);
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  expect(overflow, 'horizontal page overflow (px)').toBeLessThanOrEqual(0);
  const results = await new AxeBuilder({ page })
    // React Aria's LiveAnnouncer (body-level `role=log`) briefly holds `role=img` nodes labelled by
    // elements that may already be gone; it is announcer plumbing, not page content.
    .exclude('[role="log"][aria-relevant="additions"]')
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'])
    .analyze();
  const bad = results.violations.filter((v) => v.impact === 'serious' || v.impact === 'critical');
  expect(
    bad.map(
      (v) =>
        `${v.id}: ${v.help} → ${v.nodes
          .map((n) => n.target.join(' '))
          .slice(0, 3)
          .join(' | ')}`,
    ),
  ).toEqual([]);
};

/** Collect page errors and failed RPCs (console) so a test can assert the app stayed healthy. */
export const watchErrors = (page: Page) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(`console: ${m.text()}`);
  });
  return errors;
};

export const isMobile = (projectName: string) => projectName === 'mobile';
