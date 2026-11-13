import type { MeshConfig } from '@beamhop/core';

/** Per-thread mesh counters (persisted by @beamhop/store `meshThreads`). */
export interface MeshThreadState {
  /** Agent-to-agent turns since the last human message. */
  turns: number;
  /** Highest hop count seen in the thread. */
  hops: number;
  /** Set once a cap trips; cleared only by a human message. */
  humanRequired: boolean;
  lastHumanAt?: string;
}

export const emptyMeshThread = (): MeshThreadState => ({ turns: 0, hops: 0, humanRequired: false });

export type MeshDropReason = 'hop_cap' | 'turn_cap' | 'human_required';

export type MeshCheck =
  | { action: 'allow'; next: MeshThreadState; outgoingHops: number }
  | { action: 'drop'; reason: MeshDropReason; next: MeshThreadState; message: string };

export interface CheckMeshInput {
  thread: MeshThreadState;
  /** `hops` tag on the inbound message (0 for humans). */
  hops: number;
  config: Pick<MeshConfig, 'maxHops' | 'maxTurnsPerThread'>;
  /** Inbound message is from a human (not a peer agent). */
  fromHuman: boolean;
  now?: string;
}

/**
 * Mesh guardrails (§6A.6). Human messages reset the thread. A peer message is dropped when replying
 * would exceed `maxHops`, when the thread already used `maxTurnsPerThread` agent turns, or while the
 * thread waits for a human after a cap tripped. Returns the next state to persist either way.
 */
export const checkMesh = ({ thread, hops, config, fromHuman, now }: CheckMeshInput): MeshCheck => {
  if (fromHuman) {
    const next: MeshThreadState = { turns: 0, hops: 0, humanRequired: false };
    if (now) next.lastHumanAt = now;
    return { action: 'allow', next, outgoingHops: 1 };
  }
  const safeHops = Number.isFinite(hops) && hops >= 0 ? Math.floor(hops) : Number.MAX_SAFE_INTEGER;
  if (thread.humanRequired)
    return {
      action: 'drop',
      reason: 'human_required',
      next: thread,
      message: 'agent-to-agent limit reached; waiting for a human to reply',
    };
  if (safeHops >= config.maxHops)
    return {
      action: 'drop',
      reason: 'hop_cap',
      next: { ...thread, hops: Math.max(thread.hops, safeHops), humanRequired: true },
      message: `hop limit of ${config.maxHops} reached`,
    };
  if (thread.turns >= config.maxTurnsPerThread)
    return {
      action: 'drop',
      reason: 'turn_cap',
      next: { ...thread, humanRequired: true },
      message: `turn limit of ${config.maxTurnsPerThread} reached`,
    };
  return {
    action: 'allow',
    next: { ...thread, turns: thread.turns + 1, hops: Math.max(thread.hops, safeHops) },
    outgoingHops: safeHops + 1,
  };
};
