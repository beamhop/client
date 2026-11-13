import { createWriteStream } from 'node:fs';
import { mkdir, rename, unlink } from 'node:fs/promises';
import { dirname } from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { BeamhopError, type ErrorCode } from '@beamhop/core';
import type { TgFile } from './types.ts';

export const DEFAULT_API_ROOT = 'https://api.telegram.org';
/** Bot API getFile download limit. */
export const MAX_DOWNLOAD_BYTES = 20 * 1024 * 1024;
/** Broker-fetchable reference scheme used in `Attachment.url`. Never embeds the token. */
export const FILE_REF_PREFIX = 'telegram-file:';

export const fileRef = (fileId: string): string => `${FILE_REF_PREFIX}${fileId}`;
export const parseFileRef = (ref: string): string =>
  ref.startsWith(FILE_REF_PREFIX) ? ref.slice(FILE_REF_PREFIX.length) : ref;

/** Error from the Bot API (`ok: false`) or the transport. Message never contains the token. */
export class TelegramApiError extends BeamhopError {
  readonly method: string;
  readonly status: number;
  readonly description: string;
  readonly retryAfter?: number;
  constructor(method: string, status: number, description: string, retryAfter?: number) {
    super(codeFor(status), `telegram ${method}: ${status} ${description}`, { method, status, retryAfter });
    this.method = method;
    this.status = status;
    this.description = description;
    if (retryAfter !== undefined) this.retryAfter = retryAfter;
  }
}

const codeFor = (status: number): ErrorCode => {
  if (status === 400) return 'invalid_input';
  if (status === 401) return 'unauthorized';
  if (status === 403) return 'forbidden';
  if (status === 404) return 'not_found';
  if (status === 409) return 'conflict';
  if (status === 429) return 'rate_limited';
  if (status === 0) return 'unavailable';
  return 'internal';
};

export const isParseEntitiesError = (e: unknown): boolean =>
  e instanceof TelegramApiError &&
  e.status === 400 &&
  /can't parse entities|unsupported start tag/i.test(e.description);
export const isNotModifiedError = (e: unknown): boolean =>
  e instanceof TelegramApiError && e.status === 400 && /message is not modified/i.test(e.description);
export const isRemovedError = (e: unknown): boolean =>
  e instanceof TelegramApiError &&
  e.status === 403 &&
  /kicked|blocked by the user|not a member|chat was deleted|user is deactivated/i.test(e.description);

export interface BotApiOptions {
  token: string;
  apiRoot?: string;
  fetch?: typeof fetch;
}

export type ApiParams = Record<string, unknown>;

/** A file to upload in a multipart request. */
export interface UploadFile {
  name: string;
  mime: string;
  data: Uint8Array;
}

/** Minimal Bot API client over `fetch`. */
export class BotApi {
  readonly apiRoot: string;
  readonly #token: string;
  readonly #fetch: typeof fetch;

  constructor(opts: BotApiOptions) {
    this.#token = opts.token;
    this.apiRoot = (opts.apiRoot ?? DEFAULT_API_ROOT).replace(/\/+$/, '');
    this.#fetch = opts.fetch ?? fetch;
  }

  /** Remove any accidental occurrence of the token from a string. */
  scrub(s: string): string {
    return this.#token ? s.split(this.#token).join('<token>') : s;
  }

  async call<T>(
    method: string,
    params: ApiParams = {},
    opts: { signal?: AbortSignal; files?: Record<string, UploadFile> } = {},
  ): Promise<T> {
    const url = `${this.apiRoot}/bot${this.#token}/${method}`;
    let body: BodyInit;
    const headers: Record<string, string> = {};
    if (opts.files && Object.keys(opts.files).length > 0) {
      const fd = new FormData();
      for (const [k, v] of Object.entries(params)) {
        if (v === undefined) continue;
        fd.append(k, typeof v === 'string' ? v : JSON.stringify(v));
      }
      for (const [k, f] of Object.entries(opts.files)) {
        fd.append(k, new Blob([f.data as Uint8Array<ArrayBuffer>], { type: f.mime }), f.name);
      }
      body = fd;
    } else {
      headers['content-type'] = 'application/json';
      body = JSON.stringify(params);
    }
    let res: Response;
    try {
      res = await this.#fetch(url, { method: 'POST', headers, body, signal: opts.signal ?? null });
    } catch (e) {
      if (opts.signal?.aborted && (e as Error)?.name !== 'TimeoutError') throw e;
      throw new TelegramApiError(
        method,
        0,
        this.scrub(`network error: ${(e as Error)?.message ?? String(e)}`),
      );
    }
    let json: { ok?: boolean; result?: T; description?: string; parameters?: { retry_after?: number } };
    try {
      json = (await res.json()) as typeof json;
    } catch {
      throw new TelegramApiError(method, res.status || 0, `invalid response (HTTP ${res.status})`);
    }
    if (!json.ok) {
      throw new TelegramApiError(
        method,
        res.status,
        this.scrub(json.description ?? `HTTP ${res.status}`),
        json.parameters?.retry_after,
      );
    }
    return json.result as T;
  }

  /**
   * Download a file by `file_id` (or `telegram-file:<id>` reference) to `destPath`.
   * Writes atomically (temp file + rename) and enforces `maxBytes`.
   */
  async downloadFile(
    fileIdOrRef: string,
    destPath: string,
    opts: { maxBytes?: number; signal?: AbortSignal } = {},
  ): Promise<{ path: string; size: number; filePath: string }> {
    const maxBytes = opts.maxBytes ?? MAX_DOWNLOAD_BYTES;
    const fileId = parseFileRef(fileIdOrRef);
    const info = await this.call<TgFile>('getFile', { file_id: fileId }, { signal: opts.signal });
    if (!info.file_path)
      throw new TelegramApiError('getFile', 400, 'file is not downloadable (no file_path)');
    if (info.file_size !== undefined && info.file_size > maxBytes) {
      throw new BeamhopError(
        'invalid_input',
        `telegram file too large (${info.file_size} > ${maxBytes} bytes)`,
      );
    }
    const url = `${this.apiRoot}/file/bot${this.#token}/${info.file_path.split('/').map(encodeURIComponent).join('/')}`;
    let res: Response;
    try {
      res = await this.#fetch(url, { signal: opts.signal ?? null });
    } catch (e) {
      throw new TelegramApiError(
        'file',
        0,
        this.scrub(`network error: ${(e as Error)?.message ?? String(e)}`),
      );
    }
    if (!res.ok || !res.body)
      throw new TelegramApiError('file', res.status, `download failed (HTTP ${res.status})`);
    await mkdir(dirname(destPath), { recursive: true });
    const tmp = `${destPath}.part-${process.pid}-${Date.now()}`;
    let size = 0;
    const limiter = new Transform({
      transform(chunk: Buffer, _enc, cb) {
        size += chunk.length;
        if (size > maxBytes) cb(new BeamhopError('invalid_input', `telegram file exceeds ${maxBytes} bytes`));
        else cb(null, chunk);
      },
    });
    try {
      await pipeline(
        Readable.fromWeb(res.body as import('node:stream/web').ReadableStream),
        limiter,
        createWriteStream(tmp),
      );
      await rename(tmp, destPath);
    } catch (e) {
      await unlink(tmp).catch(() => {});
      throw e;
    }
    return { path: destPath, size, filePath: info.file_path };
  }
}

/** Standalone download helper for the daemon/broker. */
export const downloadFile = (
  api: BotApiOptions,
  fileIdOrRef: string,
  destPath: string,
  opts?: { maxBytes?: number; signal?: AbortSignal },
) => new BotApi(api).downloadFile(fileIdOrRef, destPath, opts);
