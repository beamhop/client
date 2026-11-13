import { isAbsolute, relative, resolve, sep } from 'node:path';
import { linkedPeople } from '@beamhop/authz';

/**
 * Budget key shared by every principal linked to the same person (review wave B R-B3): one human
 * with N linked accounts gets one per-person budget, in addition to the per-principal ones.
 * `undefined` when the principal is not linked to anybody.
 */
export const personBudgetKey = (
  agent: string,
  people: Record<string, string[]>,
  principal: string,
): string | undefined => {
  const persons = linkedPeople(people, principal).sort();
  return persons.length ? `person:${agent}:${persons[0]}` : undefined;
};

/** Simple FIFO async mutex. */
export class Mutex {
  private tail: Promise<void> = Promise.resolve();
  private held = 0;
  get locked(): boolean {
    return this.held > 0;
  }
  async acquire(): Promise<() => void> {
    let release!: () => void;
    const next = new Promise<void>((r) => {
      release = r;
    });
    const prev = this.tail;
    this.tail = prev.then(() => next);
    this.held++;
    await prev;
    let done = false;
    return () => {
      if (done) return;
      done = true;
      this.held--;
      release();
    };
  }
}

/** Counting semaphore with a FIFO wait queue; waiters can be cancelled. */
export class Semaphore {
  private active = 0;
  private readonly waiters: { resolve: () => void; reject: (e: unknown) => void }[] = [];
  constructor(public limit: number) {}
  get inUse(): number {
    return this.active;
  }
  get waiting(): number {
    return this.waiters.length;
  }
  /** Acquire a slot. `onQueued` is called once if the caller has to wait. */
  async acquire(opts: { signal?: AbortSignal; onQueued?: () => void } = {}): Promise<() => void> {
    if (this.active < this.limit) {
      this.active++;
      return this.releaser();
    }
    opts.onQueued?.();
    await new Promise<void>((resolve, reject) => {
      const w = { resolve, reject };
      this.waiters.push(w);
      opts.signal?.addEventListener(
        'abort',
        () => {
          const i = this.waiters.indexOf(w);
          if (i >= 0) this.waiters.splice(i, 1);
          reject(opts.signal?.reason ?? new Error('aborted'));
        },
        { once: true },
      );
    });
    this.active++;
    return this.releaser();
  }
  private releaser(): () => void {
    let done = false;
    return () => {
      if (done) return;
      done = true;
      this.active--;
      const w = this.waiters.shift();
      if (w) w.resolve();
    };
  }
}

/** Unbounded async queue usable as an AsyncIterable. */
export class AsyncQueue<T> implements AsyncIterable<T> {
  private items: T[] = [];
  private waiters: ((r: IteratorResult<T>) => void)[] = [];
  private closed = false;
  push(v: T): void {
    if (this.closed) return;
    const w = this.waiters.shift();
    if (w) w({ value: v, done: false });
    else this.items.push(v);
  }
  close(): void {
    this.closed = true;
    for (const w of this.waiters.splice(0)) w({ value: undefined as never, done: true });
  }
  [Symbol.asyncIterator](): AsyncIterator<T> {
    return {
      next: () => {
        const v = this.items.shift();
        if (v !== undefined) return Promise.resolve({ value: v, done: false });
        if (this.closed) return Promise.resolve({ value: undefined as never, done: true });
        return new Promise((r) => this.waiters.push(r));
      },
      return: async () => {
        this.close();
        return { value: undefined as never, done: true };
      },
    };
  }
}

/** True when `child` is `parent` or inside it (after resolving). */
export const isInside = (child: string, parent: string): boolean => {
  const rel = relative(resolve(parent), resolve(child));
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
};

/** Path glob → RegExp: `**` any depth, `*` within a segment, `?` one char. Separators normalized to '/'. */
export const pathGlobToRegExp = (glob: string): RegExp => {
  const g = glob.split(sep).join('/');
  let src = '';
  for (let i = 0; i < g.length; i++) {
    const c = g[i]!;
    if (c === '*') {
      if (g[i + 1] === '*') {
        i++;
        if (g[i + 1] === '/') {
          i++;
          src += '(?:.*/)?';
        } else src += '.*';
      } else src += '[^/]*';
    } else if (c === '?') src += '[^/]';
    else src += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`^${src}$`);
};

/** Make a string safe for git branch names / file names. */
export const slugify = (s: string, max = 60): string =>
  s
    .normalize('NFKD')
    .replace(/[^A-Za-z0-9._-]+/g, '-')
    .replace(/\.{2,}/g, '.')
    .replace(/^[-.]+|[-.]+$/g, '')
    .slice(0, max) || 'x';

export const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export const errMsg = (e: unknown): string => (e instanceof Error ? e.message : String(e));

/** Race a promise with a timeout; resolves undefined on timeout. */
export const withTimeout = async <T>(p: Promise<T>, ms: number): Promise<T | undefined> => {
  let t: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([p, new Promise<undefined>((r) => (t = setTimeout(() => r(undefined), ms)))]);
  } finally {
    if (t) clearTimeout(t);
  }
};
