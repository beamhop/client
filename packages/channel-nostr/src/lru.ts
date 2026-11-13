// Browser-compatible.

/** Bounded LRU map (Map insertion order = recency). */
export class LruMap<K, V> {
  private readonly map = new Map<K, V>();
  constructor(readonly max: number) {
    if (max < 1) throw new Error('LRU max must be >= 1');
  }
  get size(): number {
    return this.map.size;
  }
  has(k: K): boolean {
    return this.map.has(k);
  }
  get(k: K): V | undefined {
    const v = this.map.get(k);
    if (v !== undefined) {
      this.map.delete(k);
      this.map.set(k, v);
    }
    return v;
  }
  set(k: K, v: V): void {
    this.map.delete(k);
    this.map.set(k, v);
    while (this.map.size > this.max) {
      const oldest = this.map.keys().next();
      if (oldest.done) break;
      this.map.delete(oldest.value);
    }
  }
  delete(k: K): void {
    this.map.delete(k);
  }
  keys(): K[] {
    return [...this.map.keys()];
  }
}

/** Bounded set of seen ids. `add` returns false if the id was already present. */
export class SeenSet {
  private readonly lru: LruMap<string, true>;
  constructor(max = 10_000) {
    this.lru = new LruMap(max);
  }
  has(id: string): boolean {
    return this.lru.has(id);
  }
  add(id: string): boolean {
    if (this.lru.has(id)) {
      this.lru.get(id);
      return false;
    }
    this.lru.set(id, true);
    return true;
  }
  values(): string[] {
    return this.lru.keys();
  }
  get size(): number {
    return this.lru.size;
  }
}

/** Sliding-window rate limiter: at most `limit` events per `windowMs`. */
export class RateLimiter {
  private stamps: number[] = [];
  constructor(
    readonly limit: number,
    readonly windowMs: number,
    private readonly now: () => number = Date.now,
  ) {}
  /** Try to take a slot. Returns true if allowed. */
  take(): boolean {
    const t = this.now();
    this.stamps = this.stamps.filter((s) => t - s < this.windowMs);
    if (this.stamps.length >= this.limit) return false;
    this.stamps.push(t);
    return true;
  }
  /** ms until the next slot frees up (0 if one is free). */
  retryAfterMs(): number {
    const t = this.now();
    this.stamps = this.stamps.filter((s) => t - s < this.windowMs);
    if (this.stamps.length < this.limit) return 0;
    return this.windowMs - (t - (this.stamps[0] ?? t));
  }
}
