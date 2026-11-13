export type ErrorCode =
  | 'not_found'
  | 'invalid_input'
  | 'unauthorized'
  | 'forbidden'
  | 'conflict'
  | 'unavailable'
  | 'timeout'
  | 'sandbox_violation'
  | 'budget_exceeded'
  | 'rate_limited'
  | 'internal';

export class BeamhopError extends Error {
  readonly code: ErrorCode;
  readonly details?: unknown;
  constructor(code: ErrorCode, message: string, details?: unknown) {
    super(message);
    this.name = 'BeamhopError';
    this.code = code;
    this.details = details;
  }
  toJSON() {
    return { code: this.code, message: this.message, details: this.details };
  }
}

export const isBeamhopError = (e: unknown): e is BeamhopError =>
  e instanceof BeamhopError ||
  (typeof e === 'object' && e !== null && (e as { name?: string }).name === 'BeamhopError');
