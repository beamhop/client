import { BeamhopError, type ErrorCode, type Logger, silentLogger } from '@beamhop/core';

/**
 * Tiny Slack Web API client (https://api.slack.com/web).
 *
 * We call the HTTP API directly with `fetch` instead of `@slack/web-api` so that every
 * request is observable/injectable in tests. Encoding matches what `@slack/web-api`
 * does: `application/x-www-form-urlencoded`, with non-string values JSON-serialized
 * (blocks, metadata, files …). Auth is `Authorization: Bearer <token>`.
 *
 * Rate limits (https://api.slack.com/apis/rate-limits): Slack answers HTTP 429 with a
 * `Retry-After` header (seconds). We sleep and retry up to `maxRetries` times, then
 * fail with `rate_limited`.
 */

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export interface SlackApiOptions {
  fetch?: FetchLike;
  sleep?: (ms: number) => Promise<void>;
  log?: Logger;
  maxRetries?: number;
  /** Upper bound for a single Retry-After wait. */
  maxRetryAfterMs?: number;
  baseUrl?: string;
}

export interface SlackResponse {
  ok: boolean;
  error?: string;
  [k: string]: unknown;
}

export const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

const AUTH_ERRORS = new Set([
  'invalid_auth',
  'not_authed',
  'account_inactive',
  'token_revoked',
  'token_expired',
  'no_permission',
  'missing_scope',
  'not_allowed_token_type',
]);
const NOT_FOUND = new Set(['channel_not_found', 'message_not_found', 'user_not_found', 'thread_not_found']);
const FORBIDDEN = new Set(['not_in_channel', 'is_archived', 'restricted_action', 'cant_update_message']);

const errorCode = (err: string): ErrorCode =>
  AUTH_ERRORS.has(err)
    ? 'unauthorized'
    : NOT_FOUND.has(err)
      ? 'not_found'
      : FORBIDDEN.has(err)
        ? 'forbidden'
        : err === 'ratelimited'
          ? 'rate_limited'
          : 'unavailable';

export class SlackApiError extends BeamhopError {
  readonly slackError: string;
  constructor(method: string, slackError: string, details?: unknown) {
    super(errorCode(slackError), `Slack ${method} failed: ${slackError}`, details);
    this.slackError = slackError;
  }
}

const encodeForm = (args: Record<string, unknown>): string => {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(args)) {
    if (v === undefined || v === null) continue;
    p.set(k, typeof v === 'string' ? v : JSON.stringify(v));
  }
  return p.toString();
};

export class SlackApi {
  private readonly fetch: FetchLike;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly log: Logger;
  private readonly maxRetries: number;
  private readonly maxRetryAfterMs: number;
  private readonly baseUrl: string;

  constructor(
    private readonly token: string,
    opts: SlackApiOptions = {},
  ) {
    this.fetch = opts.fetch ?? ((i, init) => globalThis.fetch(i, init));
    this.sleep = opts.sleep ?? defaultSleep;
    this.log = opts.log ?? silentLogger;
    this.maxRetries = opts.maxRetries ?? 3;
    this.maxRetryAfterMs = opts.maxRetryAfterMs ?? 60_000;
    this.baseUrl = opts.baseUrl ?? 'https://slack.com/api/';
  }

  async call<T extends SlackResponse = SlackResponse>(
    method: string,
    args: Record<string, unknown> = {},
  ): Promise<T> {
    for (let attempt = 0; ; attempt++) {
      let res: Response;
      try {
        res = await this.fetch(this.baseUrl + method, {
          method: 'POST',
          headers: {
            authorization: `Bearer ${this.token}`,
            'content-type': 'application/x-www-form-urlencoded; charset=utf-8',
          },
          body: encodeForm(args),
        });
      } catch (e) {
        throw new BeamhopError('unavailable', `Slack ${method}: network error`, { cause: String(e) });
      }
      if (res.status === 429) {
        const retryAfterS = Number(res.headers.get('retry-after') ?? '1');
        const waitMs = Math.min(
          this.maxRetryAfterMs,
          Number.isFinite(retryAfterS) && retryAfterS >= 0 ? retryAfterS * 1000 : 1000,
        );
        if (attempt >= this.maxRetries) {
          throw new BeamhopError('rate_limited', `Slack ${method} rate limited`, { retryAfterMs: waitMs });
        }
        this.log.warn('slack rate limited; retrying', { method, waitMs, attempt });
        await this.sleep(waitMs);
        continue;
      }
      if (res.status >= 500) {
        if (attempt < this.maxRetries) {
          await this.sleep(Math.min(this.maxRetryAfterMs, 500 * 2 ** attempt));
          continue;
        }
        throw new BeamhopError('unavailable', `Slack ${method}: HTTP ${res.status}`);
      }
      let body: SlackResponse;
      try {
        body = (await res.json()) as SlackResponse;
      } catch {
        throw new BeamhopError('unavailable', `Slack ${method}: invalid JSON (HTTP ${res.status})`);
      }
      if (!body.ok) {
        const err = body.error ?? 'unknown_error';
        if (err === 'ratelimited' && attempt < this.maxRetries) {
          await this.sleep(1000);
          continue;
        }
        throw new SlackApiError(method, err, { needed: body.needed, provided: body.provided });
      }
      return body as T;
    }
  }

  /**
   * Upload a file the "v2" way (what `files.uploadV2` in @slack/web-api does):
   *  1. files.getUploadURLExternal(filename, length) → { upload_url, file_id }
   *  2. POST the bytes to upload_url
   *  3. files.completeUploadExternal(files=[{id,title}], channel_id, thread_ts, initial_comment)
   * https://api.slack.com/messaging/files#uploading_files
   */
  async uploadFile(opts: {
    filename: string;
    data: Uint8Array;
    channelId: string;
    threadTs?: string;
    title?: string;
    initialComment?: string;
  }): Promise<{ fileId: string }> {
    const up = await this.call<SlackResponse & { upload_url: string; file_id: string }>(
      'files.getUploadURLExternal',
      { filename: opts.filename, length: String(opts.data.byteLength) },
    );
    let res: Response;
    for (let attempt = 0; ; attempt++) {
      res = await this.fetch(up.upload_url, {
        method: 'POST',
        headers: { 'content-type': 'application/octet-stream' },
        body: opts.data as unknown as BodyInit,
      });
      if (res.status === 429 && attempt < this.maxRetries) {
        await this.sleep(
          Math.min(this.maxRetryAfterMs, Number(res.headers.get('retry-after') ?? '1') * 1000),
        );
        continue;
      }
      break;
    }
    if (!res.ok) throw new BeamhopError('unavailable', `Slack file upload failed: HTTP ${res.status}`);
    await this.call('files.completeUploadExternal', {
      files: [{ id: up.file_id, title: opts.title ?? opts.filename }],
      channel_id: opts.channelId,
      thread_ts: opts.threadTs,
      initial_comment: opts.initialComment,
    });
    return { fileId: up.file_id };
  }
}
