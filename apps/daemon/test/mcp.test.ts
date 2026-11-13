import { randomBytes } from 'node:crypto';
import { mkdtempSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createBridgeClient } from '@beamhop/mcp';
import { afterEach, describe, expect, it } from 'vitest';
import { FakeHarnessPlugin, makeEnv, setupBot, type TestEnv, until } from './helpers.ts';

let env: TestEnv | undefined;
afterEach(async () => {
  await env?.close();
  env = undefined;
});

/** A harness turn that stays open so the test can call MCP tools with the session token. */
const holdingHarness = () => {
  const release: (() => void)[] = [];
  const h = new FakeHarnessPlugin(async function* () {
    yield { type: 'text', delta: 'working on it' };
    await new Promise<void>((r) => release.push(r));
    yield { type: 'done', stopReason: 'end_turn' };
  });
  return { h, release };
};

const setup = async (agent: Record<string, unknown> = {}) => {
  const { h, release } = holdingHarness();
  env = await makeEnv({ harness: h });
  // Outside the beamhop home, like a real mount (the home is always denied to the sandbox).
  const mount = mkdtempSync(join(tmpdir(), 'bh-mount-'));
  const conn = await setupBot(env, { mounts: [{ path: mount, mode: 'ro' }], ...agent });
  conn.inject({
    conversation: { kind: 'group', id: 'g1' },
    from: { principal: 'fake:bob', displayName: 'Bob' },
    text: '@beambot go',
    mentionsAgent: true,
  });
  await until(() => h.sessions.length === 1 && release.length === 1);
  const spec = h.latest().spec;
  const mcp = spec.mcpServers[0]!;
  const call = createBridgeClient({ url: mcp.env!.BEAMHOP_MCP_URL!, token: mcp.env!.BEAMHOP_MCP_TOKEN! });
  return { conn, call, release, mount, spec };
};

describe('MCP handlers (daemon side, through the real bridge)', () => {
  it('channel_send: replies in place; other targets need a route', async () => {
    const { conn, call } = await setup({ routes: [{ from: 'fk:group/g1', to: 'fk:group/ops' }] });
    const r1 = await call('channel_send', { markdown: 'progress note' });
    expect(r1.ok).toBe(true);
    expect(conn.textsTo('g1')).toContain('progress note');
    const denied = await call('channel_send', { markdown: 'exfil', target: 'fk:group/elsewhere' });
    expect(denied).toMatchObject({ ok: false, error: { code: 'forbidden' } });
    expect(conn.textsTo('elsewhere')).toHaveLength(0);
    expect(env!.d.store.audit.query({ type: 'route.denied' })).toHaveLength(1);
    const routed = await call('channel_send', { markdown: 'deploy done', target: 'fk:group/ops' });
    expect(routed.ok).toBe(true);
    expect(conn.textsTo('ops')).toContain('deploy done');
  });

  it('channel_send applies DLP', async () => {
    const secret = `zq${randomBytes(16).toString('hex')}`;
    const { conn, call } = await setup();
    await env!.secrets.set('SOME_KEY', secret);
    env!.d.invalidateSecretCache();
    await call('channel_send', { markdown: `key=${secret}` });
    expect(conn.textsTo('g1').join('\n')).not.toContain(secret);
  });

  it('channel_send_file is confined to the session dir and mounts (symlinks resolved)', async () => {
    const { conn, call, mount } = await setup();
    writeFileSync(join(mount, 'report.txt'), 'all good');
    const ok = await call('channel_send_file', { path: join(mount, 'report.txt'), caption: 'here' });
    expect(ok.ok).toBe(true);
    const sent = conn.sent.find((s) => s.msg.attachments?.length);
    expect(sent!.msg.attachments![0]!.name).toBe('report.txt');
    const outside = join(env!.home, 'config.yaml');
    expect(await call('channel_send_file', { path: outside })).toMatchObject({
      ok: false,
      error: { code: 'sandbox_violation' },
    });
    symlinkSync(outside, join(mount, 'sneaky.txt'));
    expect(await call('channel_send_file', { path: join(mount, 'sneaky.txt') })).toMatchObject({
      ok: false,
      error: { code: 'sandbox_violation' },
    });
    expect(await call('channel_send_file', { path: '../../config.yaml' })).toMatchObject({ ok: false });
  });

  it('channel_send_file works from the session dir inside the denied beamhop home; the rest of it stays refused', async () => {
    const { call, spec } = await setup();
    const sessionDir = spec.env.BEAMHOP_SESSION_DIR!;
    expect(sessionDir.startsWith(env!.home)).toBe(true);
    writeFileSync(join(sessionDir, 'notes.txt'), 'from the session dir');
    expect((await call('channel_send_file', { path: join(sessionDir, 'notes.txt') })).ok).toBe(true);
    writeFileSync(join(env!.home, 'sessions', 'other.txt'), 'another session');
    expect(await call('channel_send_file', { path: join(env!.home, 'sessions', 'other.txt') })).toMatchObject(
      {
        ok: false,
        error: { code: 'sandbox_violation' },
      },
    );
  });

  it('the sandbox policy carves out exactly this session dir and denies the actual beamhop home', async () => {
    const { spec } = await setup();
    const lives = (
      env!.d.sessions as unknown as { lives: Map<string, { runtime?: { own: string[]; deny: string[] } }> }
    ).lives;
    const rt = [...lives.values()][0]!.runtime!;
    expect(rt.own).toEqual([spec.env.BEAMHOP_SESSION_DIR]);
    expect(rt.deny).toContain(env!.home);
  });

  it('channel_history, channel_members, session_status; mesh tools unavailable without nostr', async () => {
    const { call } = await setup();
    const h = await call('channel_history', { limit: 10 });
    expect(h.ok && JSON.parse(h.text).messages[0].text).toBe('@beambot go');
    const m = await call('channel_members', {});
    expect(m.ok && JSON.parse(m.text)).toEqual([{ principal: 'fake:bob', name: 'Bob', role: 'user' }]);
    const st = await call('session_status', {});
    expect(st.ok && JSON.parse(st.text)).toMatchObject({
      agent: 'bot',
      role: 'user',
      channel: 'fk:group/g1',
    });
    env!.d.mesh = undefined;
    expect(await call('mesh_list_agents', {})).toMatchObject({ ok: false, error: { code: 'unavailable' } });
  });

  it('the token stops working when the session ends', async () => {
    const { call, release } = await setup();
    release.shift()!();
    const [s] = env!.d.store.sessions.list();
    await env!.client.call('session.stop', { id: s!.id });
    expect(await call('session_status', {})).toMatchObject({ ok: false, error: { code: 'unauthorized' } });
  });
});
