import { generateAgentKey } from '@beamhop/channel-nostr/keys';
import { describe, expect, it } from 'vitest';
import { completedCount, EMPTY, markDone, markSkipped, nextStep, resumeAt } from './progress.ts';
import { freeName, npubFromBunker } from './StepSetup.tsx';

describe('onboarding progress', () => {
  it('resumes at the first step neither done nor skipped', () => {
    // Outcome first: only "agent" and "hello" are steps; the others are pages setup sends you to.
    expect(resumeAt(EMPTY)).toBe('agent');
    let p = markDone(EMPTY, 'doctor');
    p = markSkipped(p, 'identity');
    expect(resumeAt(p)).toBe('agent');
    p = markDone(p, 'agent');
    expect(resumeAt(p)).toBe('hello');
    expect(completedCount(p)).toBe(1);
  });

  it('done and skipped are exclusive; marking twice is idempotent', () => {
    let p = markSkipped(EMPTY, 'phone');
    p = markDone(p, 'phone');
    p = markDone(p, 'phone');
    expect(p.done).toEqual(['phone']);
    expect(p.skipped).toEqual([]);
    p = markSkipped(p, 'phone');
    expect(p.done).toEqual([]);
  });

  it('carries extra state (agent, round trip)', () => {
    const p = markDone(EMPTY, 'agent', { agent: 'reviewer' });
    expect(p.agent).toBe('reviewer');
    expect(markDone(p, 'hello', { helloMs: 4200 }).helloMs).toBe(4200);
  });

  it('next step ends at the summary', () => {
    expect(nextStep('doctor')).toBe('agent');
    expect(nextStep('agent')).toBe('hello');
    expect(nextStep('hello')).toBe('next');
    const all = (['doctor', 'harnesses', 'identity', 'phone', 'agent', 'hello'] as const).reduce(
      (acc, s) => markDone(acc, s),
      EMPTY,
    );
    expect(resumeAt(all)).toBe('next');
  });
});

describe('onboarding helpers', () => {
  it('reads the signer key from a bunker URL', () => {
    const k = generateAgentKey();
    expect(npubFromBunker(`bunker://${k.pubkey}?relay=wss://relay.nsec.app`)).toBe(k.npub);
    expect(npubFromBunker(`bunker://${k.pubkey}`)).toBe(k.npub);
    expect(npubFromBunker('bunker://nope')).toBeNull();
    expect(npubFromBunker(k.npub)).toBeNull();
  });

  it('suggests a free agent name', () => {
    expect(freeName('reviewer', [])).toBe('reviewer');
    expect(freeName('reviewer', ['reviewer'])).toBe('reviewer-2');
    expect(freeName('reviewer', ['reviewer', 'reviewer-2'])).toBe('reviewer-3');
  });
});
