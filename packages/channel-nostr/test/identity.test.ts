import { verifyEvent } from 'nostr-tools/pure';
import { describe, expect, it } from 'vitest';
import {
  buildAttestation,
  buildCapabilityCard,
  buildNip05Json,
  buildProfileEvent,
  checkNip05,
  type Nip05Fetch,
  parseCapabilityCard,
  signEvent,
  verifyAttestation,
} from '../src/identity.ts';
import { generateAgentKey } from '../src/keys.ts';

const owner = generateAgentKey();
const agent = generateAgentKey();

describe('profile (kind 0)', () => {
  it('marks the agent as a bot and discloses the owner', () => {
    const t = buildProfileEvent({
      name: 'reviewer',
      about: 'Reviews PRs.',
      owner: owner.pubkey,
      nip05: 'reviewer@example.com',
    });
    expect(t.kind).toBe(0);
    const c = JSON.parse(t.content);
    expect(c.bot).toBe(true);
    expect(c.about).toBe(`Reviews PRs.\n\nAI agent operated by ${owner.npub}`);
    expect(c.nip05).toBe('reviewer@example.com');
    const signed = signEvent(t, agent.nsec);
    expect(verifyEvent(signed)).toBe(true);
    expect(signed.pubkey).toBe(agent.pubkey);
  });
  it('requires a valid owner', () => {
    expect(() => buildProfileEvent({ name: 'x', owner: 'nope' })).toThrow();
  });
});

describe('owner attestation', () => {
  it('builds an owner-signed kind 30078 event that verifies', () => {
    const ev = buildAttestation(owner.nsec, agent.npub, { name: 'reviewer' });
    expect(ev.kind).toBe(30078);
    expect(ev.pubkey).toBe(owner.pubkey);
    expect(ev.tags).toContainEqual(['d', `beamhop-agent:${agent.pubkey}`]);
    expect(verifyAttestation(ev)).toEqual({
      ok: true,
      owner: owner.pubkey,
      agent: agent.pubkey,
      name: 'reviewer',
    });
    expect(verifyAttestation(ev, { agentPubkey: agent.npub, ownerPubkey: owner.npub }).ok).toBe(true);
  });

  it('rejects tampering, wrong expectations, self-attestation and revocation', () => {
    const ev = buildAttestation(owner.secretKey, agent.pubkey);
    const other = generateAgentKey();
    expect(verifyAttestation({ ...ev, content: ev.content.replace(agent.npub, other.npub) })).toMatchObject({
      ok: false,
      reason: 'bad signature',
    });
    expect(
      verifyAttestation({ ...ev, tags: [['d', `beamhop-agent:${other.pubkey}`], ...ev.tags.slice(1)] }).ok,
    ).toBe(false);
    expect(verifyAttestation(ev, { ownerPubkey: other.pubkey })).toMatchObject({
      ok: false,
      reason: 'unexpected owner',
    });
    expect(verifyAttestation(ev, { agentPubkey: other.pubkey })).toMatchObject({
      ok: false,
      reason: 'unexpected agent',
    });
    expect(() => buildAttestation(agent.secretKey, agent.pubkey)).toThrow();
    expect(
      verifyAttestation(buildAttestation(owner.secretKey, agent.pubkey, { revoked: true })),
    ).toMatchObject({
      ok: false,
      reason: 'revoked',
    });
    // Signed by a third party claiming to be the owner in content
    const forged = buildAttestation(other.secretKey, agent.pubkey);
    expect(verifyAttestation(forged, { ownerPubkey: owner.pubkey }).ok).toBe(false);
  });
});

describe('capability card (NIP-89 kind 31990)', () => {
  it('lists job kinds and links the attestation', () => {
    const t = buildCapabilityCard({
      agentPubkey: agent.npub,
      owner: owner.npub,
      name: 'reviewer',
      jobKinds: [5050, 5001, 5050],
      capabilities: ['code-review'],
    });
    expect(t.kind).toBe(31990);
    expect(t.tags.filter((x) => x[0] === 'k')).toEqual([
      ['k', '5001'],
      ['k', '5050'],
    ]);
    expect(t.tags).toContainEqual([
      'a',
      `30078:${owner.pubkey}:beamhop-agent:${agent.pubkey}`,
      '',
      'attestation',
    ]);
    const card = parseCapabilityCard(signEvent(t, agent.secretKey));
    expect(card).toEqual({
      agent: agent.pubkey,
      owner: owner.pubkey,
      jobKinds: [5001, 5050],
      name: 'reviewer',
      capabilities: ['code-review'],
    });
    expect(() =>
      buildCapabilityCard({ agentPubkey: agent.npub, owner: owner.npub, name: 'x', jobKinds: [1] }),
    ).toThrow();
  });
});

describe('NIP-05', () => {
  it('builds nostr.json and hosting snippets', () => {
    const b = buildNip05Json('https://Example.com/', [
      { name: 'Reviewer', pubkey: agent.npub, relays: ['wss://nos.lol'] },
    ]);
    expect(b.domain).toBe('example.com');
    expect(b.json).toEqual({
      names: { reviewer: agent.pubkey },
      relays: { [agent.pubkey]: ['wss://nos.lol'] },
    });
    expect(JSON.parse(b.body)).toEqual(b.json);
    expect(b.handles).toEqual(['reviewer@example.com']);
    expect(b.snippets.nginx).toContain('Access-Control-Allow-Origin');
    expect(b.snippets.cloudflarePages).toContain('/.well-known/nostr.json');
    expect(b.snippets.static).toContain('https://example.com/.well-known/nostr.json');
    expect(() => buildNip05Json('example.com', { 'bad name': agent.pubkey })).toThrow();
    expect(() => buildNip05Json('not a domain', { a: agent.pubkey })).toThrow();
    expect(() => buildNip05Json('example.com', { a: 'npub1bad' })).toThrow();
  });

  it('resolves handles without following redirects', async () => {
    const seen: { url: string; redirect?: string }[] = [];
    const fetch: Nip05Fetch = async (url, init) => {
      seen.push({ url, redirect: init?.redirect });
      if (url.includes('redirect.example')) return { ok: false, status: 301, json: async () => ({}) };
      return {
        ok: true,
        status: 200,
        json: async () => ({ names: { reviewer: agent.pubkey, _: owner.pubkey } }),
      };
    };
    expect(await checkNip05('reviewer@example.com', { fetch, expectedPubkey: agent.npub })).toEqual({
      ok: true,
      pubkey: agent.pubkey,
    });
    expect(seen[0]).toEqual({
      url: 'https://example.com/.well-known/nostr.json?name=reviewer',
      redirect: 'manual',
    });
    expect(await checkNip05('example.com', { fetch })).toMatchObject({ ok: true, pubkey: owner.pubkey });
    expect(await checkNip05('reviewer@example.com', { fetch, expectedPubkey: owner.pubkey })).toMatchObject({
      ok: false,
      reason: 'pubkey mismatch',
    });
    expect(await checkNip05('nobody@example.com', { fetch })).toMatchObject({
      ok: false,
      reason: 'name not found',
    });
    expect(await checkNip05('a@redirect.example', { fetch })).toMatchObject({
      ok: false,
      reason: 'HTTP 301',
    });
    expect(await checkNip05('bad handle@x', { fetch })).toMatchObject({
      ok: false,
      reason: 'invalid handle',
    });
  });
});
