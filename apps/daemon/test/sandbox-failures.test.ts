/**
 * How a failed turn reads when the sandbox is involved: refused hosts are named on a network failure
 * (and offered as one-click allows), an unrelated error is left alone, and a dropped connection's
 * retries show as one notice.
 */
import type { HarnessEvent } from '@beamhop/core';
import { afterEach, describe, expect, it } from 'vitest';
import type { SandboxFactory } from '../src/daemon.ts';
import { FakeHarnessPlugin, fakeSandbox, makeEnv, setupBot, sleep, type TestEnv, until } from './helpers.ts';

type Violation = { kind: 'net.allow' | 'fs.read' | 'fs.write'; value: string; allowed?: boolean };

let env: TestEnv | undefined;
afterEach(async () => {
  await env?.close();
  env = undefined;
});

/** A test env whose sandbox lets the harness script report violations, like srt's proxy does. */
const setup = async (script: (refuse: (host: string) => void) => AsyncGenerator<HarnessEvent>) => {
  const sinks = new Set<(v: Violation) => void>();
  const sandbox: SandboxFactory = async (policy, o) => ({
    ...(await fakeSandbox(policy, o)),
    onViolation: (cb: (v: Violation) => void) => {
      sinks.add(cb);
      return () => sinks.delete(cb);
    },
  });
  const refuse = (host: string) => {
    for (const cb of sinks) cb({ kind: 'net.allow', value: host, allowed: false });
  };
  env = await makeEnv({ harness: new FakeHarnessPlugin(() => script(refuse)), sandbox });
  await setupBot(env);
  return env;
};

const runTurn = async (e: TestEnv, text = 'go') => {
  const s = await e.client.call('session.start', { agent: 'bot', text });
  let events: { kind: string; text?: string }[] = [];
  await until(
    async () => {
      events = (await e.client.call('session.events', { id: s.id })).events;
      return events.some((x) => x.kind === 'error');
    },
    5000,
    'turn error',
  );
  return { id: s.id, events: () => e.client.call('session.events', { id: s.id }).then((r) => r.events) };
};

describe('sandbox failures', () => {
  it('names the refused host on a network failure and offers it as an allow', async () => {
    const e = await setup(async function* (refuse) {
      yield { type: 'progress', message: 'retrying: Reconnecting... 1/5' };
      yield { type: 'progress', message: 'retrying: Reconnecting... 2/5' };
      yield { type: 'progress', message: 'retrying: Reconnecting... 3/5' };
      refuse('api.example.dev');
      yield { type: 'error', message: 'stream disconnected: connection reset' };
    });
    const t = await runTurn(e);
    const events = await t.events();
    const error = events.find((x) => x.kind === 'error');
    expect(error?.text).toContain('stream disconnected: connection reset');
    expect(error?.text).toContain('Blocked by the sandbox: api.example.dev');
    // Three retries, one notice.
    expect(events.filter((x) => x.kind === 'progress').map((x) => x.text)).toEqual([
      'Connection dropped, retrying…',
    ]);
    // Offered for one-click allow without learning mode.
    const { suggestions } = await e.client.call('policy.suggestions', { name: 'bot' });
    expect(suggestions.map((s) => [s.kind, s.value])).toContainEqual(['net.allow', 'api.example.dev']);
  });

  it('leaves an unrelated error alone, even when a host was refused', async () => {
    const e = await setup(async function* (refuse) {
      refuse('cdn.example.dev');
      yield { type: 'error', message: "The 'default' model is not supported with this account." };
    });
    const t = await runTurn(e);
    await sleep(800); // past the follow-up check's delay
    const events = await t.events();
    expect(events.find((x) => x.kind === 'error')?.text).toBe(
      "The 'default' model is not supported with this account.",
    );
    expect(events.some((x) => x.kind === 'system' && /Blocked by the sandbox/.test(x.text ?? ''))).toBe(
      false,
    );
  });

  it('adds a follow-up note when the refusal arrives after the error', async () => {
    const e = await setup(async function* (refuse) {
      yield { type: 'error', message: 'error sending request: connect failed' };
      await sleep(50);
      refuse('late.example.dev');
    });
    const t = await runTurn(e);
    await until(
      async () =>
        (await t.events()).some((x) => x.kind === 'system' && (x.text ?? '').includes('late.example.dev')),
      3000,
      'follow-up note',
    );
  });
});
