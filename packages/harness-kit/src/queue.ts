/**
 * Unbounded single-consumer async queue. Producers `push`, then `end()` or `fail(err)`.
 * Iterating it yields every pushed item in order, then finishes (or throws the failure).
 */
export class AsyncQueue<T> implements AsyncIterable<T> {
  private items: T[] = [];
  private waiters: { resolve: (r: IteratorResult<T>) => void; reject: (e: unknown) => void }[] = [];
  private done = false;
  private error: unknown = undefined;
  private failed = false;

  get closed(): boolean {
    return this.done || this.failed;
  }

  push(item: T): void {
    if (this.closed) return;
    const w = this.waiters.shift();
    if (w) w.resolve({ value: item, done: false });
    else this.items.push(item);
  }

  end(): void {
    if (this.closed) return;
    this.done = true;
    for (const w of this.waiters.splice(0)) w.resolve({ value: undefined as never, done: true });
  }

  fail(err: unknown): void {
    if (this.closed) return;
    this.failed = true;
    this.error = err;
    for (const w of this.waiters.splice(0)) w.reject(err);
  }

  next(): Promise<IteratorResult<T>> {
    if (this.items.length > 0) return Promise.resolve({ value: this.items.shift() as T, done: false });
    if (this.failed) return Promise.reject(this.error);
    if (this.done) return Promise.resolve({ value: undefined as never, done: true });
    return new Promise((resolve, reject) => this.waiters.push({ resolve, reject }));
  }

  [Symbol.asyncIterator](): AsyncIterator<T> {
    return {
      next: () => this.next(),
      return: async () => {
        this.end();
        return { value: undefined as never, done: true };
      },
    };
  }
}
