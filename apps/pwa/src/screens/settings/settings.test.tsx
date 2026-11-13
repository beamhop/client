import { generateAgentKey } from '@beamhop/channel-nostr/keys';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { describe, expect, it } from 'vitest';
import { DOMAIN_RE, NIP05_NAME_RE, normalizeDomain } from './IdentitySection.tsx';
import { confirmMatches, TypeToConfirm } from './kit.tsx';
import { ownerPrincipal } from './OwnersSection.tsx';
import { SECRET_NAME_RE } from './SecretsSection.tsx';

const Harness = () => {
  const [v, setV] = useState('');
  return (
    <>
      <TypeToConfirm expected="ci-bot" value={v} onChange={setV} />
      <span data-testid="ok">{String(confirmMatches(v, 'ci-bot'))}</span>
    </>
  );
};

describe('settings validation', () => {
  it('normalizes and validates NIP-05 domains', () => {
    expect(normalizeDomain(' https://Example.com/path ')).toBe('example.com');
    expect(DOMAIN_RE.test('example.com')).toBe(true);
    expect(DOMAIN_RE.test('agents.acme.dev')).toBe(true);
    expect(DOMAIN_RE.test('localhost')).toBe(false);
    expect(DOMAIN_RE.test('-bad.com')).toBe(false);
    expect(NIP05_NAME_RE.test('reviewer')).toBe(true);
    expect(NIP05_NAME_RE.test('Reviewer')).toBe(false);
  });

  it('secret names', () => {
    expect(SECRET_NAME_RE.test('ANTHROPIC_API_KEY')).toBe(true);
    expect(SECRET_NAME_RE.test('channel/tg/bot-token')).toBe(true);
    expect(SECRET_NAME_RE.test('has space')).toBe(false);
    expect(SECRET_NAME_RE.test('/leading')).toBe(false);
    expect(SECRET_NAME_RE.test('')).toBe(false);
  });

  it('owner principals accept npub, hex and nostr: forms', () => {
    const k = generateAgentKey();
    const want = `nostr:${k.npub}`;
    expect(ownerPrincipal(k.npub)).toBe(want);
    expect(ownerPrincipal(k.pubkey)).toBe(want);
    expect(ownerPrincipal(`nostr:${k.npub}`)).toBe(want);
    expect(ownerPrincipal(k.nsec)).toBeNull(); // never accept a secret key as an owner id
    expect(ownerPrincipal('npub1nope')).toBeNull();
  });

  it('type-to-confirm is exact and case-sensitive', async () => {
    expect(confirmMatches(' reviewer ', 'reviewer')).toBe(true);
    expect(confirmMatches('Reviewer', 'reviewer')).toBe(false);
    render(<Harness />);
    const input = screen.getByLabelText('Type ci-bot to confirm');
    await userEvent.type(input, 'ci-bo');
    expect(screen.getByText('Doesn\'t match "ci-bot" yet.')).toBeInTheDocument();
    await userEvent.type(input, 't');
    expect(screen.getByTestId('ok').textContent).toBe('true');
  });
});
