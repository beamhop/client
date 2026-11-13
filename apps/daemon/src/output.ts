/**
 * Output style (§6A.8): a live-edited reply (throttled to ~1 edit/s) on channels that support
 * edits; otherwise a typing indicator, short progress lines and one final message.
 */
import type { SentMessage } from '@beamhop/core';

export interface StreamSink {
  /** Send a new message (DLP already applied by the sink). */
  send(markdown: string): Promise<SentMessage | undefined>;
  typing?(): Promise<void>;
  canEdit: boolean;
}

export interface StreamerOptions {
  throttleMs?: number;
  /** Min gap between progress lines on non-edit channels. */
  progressGapMs?: number;
  now?: () => number;
}

const MAX_LIVE_CHARS = 3800;

export class ReplyStreamer {
  private text = '';
  private progress: string | undefined;
  private sent: SentMessage | undefined;
  private sending: Promise<void> | undefined;
  private lastEdit = 0;
  private lastProgressAt = Number.NEGATIVE_INFINITY;
  private timer: NodeJS.Timeout | undefined;
  private typingTimer: NodeJS.Timeout | undefined;
  private finished = false;
  readonly edits: number[] = [];
  private readonly throttleMs: number;
  private readonly progressGapMs: number;
  private readonly now: () => number;

  constructor(
    private readonly sink: StreamSink,
    opts: StreamerOptions = {},
  ) {
    this.throttleMs = opts.throttleMs ?? 1000;
    this.progressGapMs = opts.progressGapMs ?? 8000;
    this.now = opts.now ?? Date.now;
  }

  start(): void {
    if (this.sink.typing) {
      const tick = () => void this.sink.typing?.().catch(() => {});
      tick();
      this.typingTimer = setInterval(tick, 4500);
      this.typingTimer.unref?.();
    }
  }

  get fullText(): string {
    return this.text;
  }

  onText(delta: string): void {
    this.text += delta;
    if (this.sink.canEdit) this.schedule();
  }

  onProgress(message: string): void {
    const line = message.replace(/\s+/g, ' ').trim().slice(0, 200);
    if (!line) return;
    if (this.sink.canEdit) {
      this.progress = line;
      this.schedule();
      return;
    }
    const t = this.now();
    if (t - this.lastProgressAt < this.progressGapMs) return;
    this.lastProgressAt = t;
    void this.sink.send(`_${line}_`).catch(() => {});
  }

  private render(final: boolean): string {
    let body = this.text.trim();
    if (!final) {
      if (body.length > MAX_LIVE_CHARS) body = `…${body.slice(-MAX_LIVE_CHARS)}`;
      const tail = this.progress ? `\n\n_${this.progress}_` : '';
      return `${body || '…'}${tail}${body ? ' ▍' : ''}`;
    }
    return body;
  }

  private schedule(): void {
    if (this.finished || this.timer) return;
    const wait = Math.max(0, this.lastEdit + this.throttleMs - this.now());
    this.timer = setTimeout(() => {
      this.timer = undefined;
      void this.flush(false);
    }, wait);
  }

  private async flush(final: boolean): Promise<void> {
    if (this.sending) await this.sending;
    const content = this.render(final);
    const run = async () => {
      if (!this.sent) {
        if (!content && final) return;
        this.sent = await this.sink.send(content || '…');
      } else if (this.sent.edit) {
        await this.sent.edit(content);
      } else if (final) {
        await this.sink.send(content);
      }
      this.lastEdit = this.now();
      this.edits.push(this.lastEdit);
    };
    this.sending = run().catch(() => {});
    await this.sending;
    this.sending = undefined;
  }

  /** Deliver the final reply. `fallback` is used when the agent produced no text. */
  async finish(fallback?: string): Promise<void> {
    this.finished = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    if (this.typingTimer) clearInterval(this.typingTimer);
    this.progress = undefined;
    if (!this.text.trim() && fallback) this.text = fallback;
    if (!this.text.trim() && !this.sent) return;
    if (this.sink.canEdit) await this.flush(true);
    else {
      if (this.sending) await this.sending;
      await this.sink.send(this.render(true)).catch(() => {});
    }
  }

  stopTyping(): void {
    if (this.typingTimer) clearInterval(this.typingTimer);
  }
}
