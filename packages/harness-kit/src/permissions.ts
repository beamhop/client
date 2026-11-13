import { BeamhopError, type PermissionDecision } from '@beamhop/core';

/**
 * Tracks outstanding permission requests. A harness adapter calls `ask(id)` when the harness
 * wants approval (after emitting a `permission_request` event); `respond(id, d)` resolves it.
 * Approvals with `always: true` are remembered per key for the rest of the session.
 */
export class PermissionBroker {
  private pending = new Map<string, { resolve: (d: PermissionDecision) => void; key?: string }>();
  private alwaysAllowed = new Set<string>();
  private seq = 0;

  nextId(prefix = 'perm'): string {
    this.seq += 1;
    return `${prefix}-${this.seq}`;
  }

  /** True if an earlier `always` approval covers this key. */
  isAlwaysAllowed(key: string | undefined): boolean {
    return key !== undefined && this.alwaysAllowed.has(key);
  }

  ask(id: string, key?: string): Promise<PermissionDecision> {
    if (this.pending.has(id)) throw new BeamhopError('conflict', `duplicate permission request ${id}`);
    return new Promise((resolve) => this.pending.set(id, { resolve, key }));
  }

  respond(id: string, decision: PermissionDecision): void {
    const p = this.pending.get(id);
    if (!p) throw new BeamhopError('not_found', `no pending permission request ${id}`);
    this.pending.delete(id);
    if (decision.allow && decision.always && p.key) this.alwaysAllowed.add(p.key);
    p.resolve(decision);
  }

  get size(): number {
    return this.pending.size;
  }

  /** Deny everything outstanding (cancel / close). */
  denyAll(reason = 'cancelled'): void {
    for (const [id, p] of this.pending) {
      this.pending.delete(id);
      p.resolve({ allow: false, reason });
    }
  }
}
