// A local fake of the Telegram Bot API for unit tests (no network).

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { TgUpdate } from '../src/types.ts';

export const FAKE_TOKEN = '123456789:AAFakeTokenForUnitTestsOnly_abcdefghij';

export interface RecordedCall {
  method: string;
  params: Record<string, unknown>;
  files: Record<string, { name: string; type: string; text: string }>;
}

export type ApiReply =
  | { status?: number; body: unknown }
  | ((call: RecordedCall) => { status?: number; body: unknown });

export const ok = (result: unknown) => ({ status: 200, body: { ok: true, result } });
export const fail = (status: number, description: string, parameters?: Record<string, unknown>) => ({
  status,
  body: { ok: false, error_code: status, description, ...(parameters ? { parameters } : {}) },
});

export class FakeBotApi {
  readonly calls: RecordedCall[] = [];
  /** Requested URLs (to assert the token never leaks elsewhere). */
  readonly urls: string[] = [];
  /** One-shot scripted replies per method, consumed in order before the default handler. */
  readonly script = new Map<string, ApiReply[]>();
  readonly files = new Map<string, Buffer>();
  bot = { id: 777000111, is_bot: true, first_name: 'Beam Test', username: 'beam_test_bot' };
  #server: Server | undefined;
  #updates: TgUpdate[] = [];
  #waiters: (() => void)[] = [];
  #nextMessageId = 1000;
  apiRoot = '';

  async start(): Promise<this> {
    this.#server = createServer((req, res) => void this.#handle(req, res));
    await new Promise<void>((r) => this.#server?.listen(0, '127.0.0.1', r));
    const { port } = this.#server.address() as AddressInfo;
    this.apiRoot = `http://127.0.0.1:${port}`;
    return this;
  }

  async stop(): Promise<void> {
    for (const w of this.#waiters.splice(0)) w();
    this.#server?.closeAllConnections();
    await new Promise<void>((r) => this.#server?.close(() => r()));
  }

  push(...updates: TgUpdate[]): void {
    this.#updates.push(...updates);
    for (const w of this.#waiters.splice(0)) w();
  }

  reply(method: string, ...replies: ApiReply[]): void {
    const q = this.script.get(method) ?? [];
    q.push(...replies);
    this.script.set(method, q);
  }

  callsTo(method: string): RecordedCall[] {
    return this.calls.filter((c) => c.method === method);
  }

  /** Wait until `n` calls to `method` were recorded. */
  async waitFor(method: string, n = 1, timeoutMs = 5000): Promise<RecordedCall[]> {
    const start = Date.now();
    while (this.callsTo(method).length < n) {
      if (Date.now() - start > timeoutMs) throw new Error(`timeout waiting for ${n}x ${method}`);
      await new Promise((r) => setTimeout(r, 5));
    }
    return this.callsTo(method);
  }

  async #handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = req.url ?? '';
    this.urls.push(url);
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const raw = Buffer.concat(chunks);

    const fileMatch = /^\/file\/bot([^/]+)\/(.+)$/.exec(url);
    if (fileMatch) {
      const data =
        fileMatch[1] === FAKE_TOKEN ? this.files.get(decodeURIComponent(fileMatch[2] ?? '')) : undefined;
      if (!data) {
        res.writeHead(404).end('not found');
        return;
      }
      res.writeHead(200, { 'content-type': 'application/octet-stream' }).end(data);
      return;
    }
    const m = /^\/bot([^/]+)\/(\w+)$/.exec(url);
    if (!m) return this.#send(res, fail(404, 'Not Found'));
    if (m[1] !== FAKE_TOKEN) return this.#send(res, fail(401, 'Unauthorized'));
    const method = m[2] ?? '';
    const call: RecordedCall = { method, params: {}, files: {} };
    const ctype = String(req.headers['content-type'] ?? '');
    if (ctype.startsWith('multipart/form-data')) {
      const form = await new Request('http://x/', {
        method: 'POST',
        headers: { 'content-type': ctype },
        body: raw,
      }).formData();
      for (const [k, v] of form.entries()) {
        if (typeof v === 'string') {
          try {
            call.params[k] = JSON.parse(v);
          } catch {
            call.params[k] = v;
          }
        } else call.files[k] = { name: v.name, type: v.type, text: await v.text() };
      }
    } else if (raw.length > 0) {
      call.params = JSON.parse(raw.toString('utf8')) as Record<string, unknown>;
    }
    this.calls.push(call);

    const scripted = this.script.get(method)?.shift();
    if (scripted) return this.#send(res, typeof scripted === 'function' ? scripted(call) : scripted);
    this.#send(res, await this.#default(call));
  }

  #send(res: ServerResponse, r: { status?: number; body: unknown }) {
    if (res.destroyed) return;
    res.writeHead(r.status ?? 200, { 'content-type': 'application/json' }).end(JSON.stringify(r.body));
  }

  async #default(call: RecordedCall): Promise<{ status?: number; body: unknown }> {
    const p = call.params;
    switch (call.method) {
      case 'getMe':
        return ok(this.bot);
      case 'getUpdates': {
        const offset = typeof p.offset === 'number' ? p.offset : 0;
        // Confirming an offset drops older updates, like the real API.
        this.#updates = this.#updates.filter((u) => u.update_id >= offset);
        if (this.#updates.length === 0) {
          const timeoutMs = Math.min(Number(p.timeout ?? 0) * 1000, 2000);
          await new Promise<void>((r) => {
            const t = setTimeout(r, timeoutMs);
            this.#waiters.push(() => {
              clearTimeout(t);
              r();
            });
          });
        }
        return ok(this.#updates.filter((u) => u.update_id >= offset));
      }
      case 'sendMessage':
      case 'sendPhoto':
      case 'sendDocument':
        return ok({
          message_id: this.#nextMessageId++,
          date: 1_700_000_000,
          chat: { id: Number(p.chat_id), type: Number(p.chat_id) < 0 ? 'supergroup' : 'private' },
          text: p.text,
        });
      case 'editMessageText':
        return ok({
          message_id: p.message_id,
          date: 1_700_000_000,
          chat: { id: Number(p.chat_id), type: 'private' },
        });
      case 'getFile': {
        const fileId = String(p.file_id);
        return ok({ file_id: fileId, file_unique_id: `u_${fileId}`, file_path: `documents/${fileId}.bin` });
      }
      case 'getUserProfilePhotos':
        return ok({
          total_count: 1,
          photos: [[{ file_id: 'AVATAR_SMALL', file_unique_id: 'av1', width: 160, height: 160 }]],
        });
      default:
        return ok(true);
    }
  }
}
