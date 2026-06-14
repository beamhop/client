import { describe, test, expect } from 'bun:test';
import { parseHash, routeToHash, type Route } from '../src/lib/router.js';

const PUBKEY = 'd0a1ffb8761b974cec4a3be8cbcb2e96a7090dcf465ffeac839aa4ca20c9a59e';
const EVENT = 'a'.repeat(64);

describe('routeToHash → parseHash round-trips (bech32 in URL, hex internally)', () => {
  const cases: Route[] = [
    { name: 'home' },
    { name: 'security' },
    { name: 'explore', q: '', type: 'posts' },
    { name: 'explore', q: 'bitcoin', type: 'posts' },
    { name: 'explore', q: 'nostr dev', type: 'posts' },
    { name: 'explore', q: 'alice', type: 'people' },
    { name: 'profile', pubkey: null },
    { name: 'profile', pubkey: PUBKEY },
    { name: 'messages', peer: null },
    { name: 'messages', peer: PUBKEY },
    { name: 'note', id: EVENT },
  ];

  for (const route of cases) {
    test(JSON.stringify(route), () => {
      expect(parseHash(routeToHash(route))).toEqual(route);
    });
  }
});

describe('parseHash edge cases', () => {
  test('empty / bare hash is home', () => {
    expect(parseHash('')).toEqual({ name: 'home' });
    expect(parseHash('#')).toEqual({ name: 'home' });
    expect(parseHash('#/')).toEqual({ name: 'home' });
  });

  test('unknown path falls back to home', () => {
    expect(parseHash('#/nonsense')).toEqual({ name: 'home' });
  });

  test('malformed note id falls back to home', () => {
    expect(parseHash('#/note/not-a-real-id')).toEqual({ name: 'home' });
  });

  test('profile/messages with garbage identifier resolve to self/none', () => {
    expect(parseHash('#/profile/garbage')).toEqual({ name: 'profile', pubkey: null });
    expect(parseHash('#/messages/garbage')).toEqual({ name: 'messages', peer: null });
  });

  test('accepts a raw hex event id as well as nevent', () => {
    expect(parseHash(`#/note/${EVENT}`)).toEqual({ name: 'note', id: EVENT });
  });

  test('explore defaults to the posts scope and ignores an unknown type', () => {
    expect(parseHash('#/explore')).toEqual({ name: 'explore', q: '', type: 'posts' });
    expect(parseHash('#/explore?q=x&type=bogus')).toEqual({ name: 'explore', q: 'x', type: 'posts' });
    expect(parseHash('#/explore?q=x&type=people')).toEqual({ name: 'explore', q: 'x', type: 'people' });
  });
});
