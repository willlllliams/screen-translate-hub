// Status codes and failure classes, spec 08 section 7.

export type StatusCode =
  | 'ok'
  | 'cancelled'
  | 'deadline_exceeded'
  | 'invalid_argument'
  | 'not_found'
  | 'engine_error'
  | 'internal'
  | 'unavailable'
  | 'rate_limited'
  | 'quota_exceeded'
  | 'incompatible'
  | 'unimplemented'
  | 'permission_denied'
  | 'unauthenticated';

export interface Status {
  code: StatusCode;
  message?: string;
  retryAfterMs?: number;
}

export const OK: Status = { code: 'ok' };

/** Failure class used by the run coordinator (spec 04 section 6.3). */
export type FailureClass = 'whole' | 'segment';

const WHOLE: ReadonlySet<StatusCode> = new Set([
  'unavailable',
  'rate_limited',
  'quota_exceeded',
  'incompatible',
  'unimplemented',
  'permission_denied',
]);
const SEGMENT: ReadonlySet<StatusCode> = new Set([
  'deadline_exceeded',
  'invalid_argument',
  'not_found',
  'engine_error',
  'internal',
]);

export function failureClass(code: StatusCode): FailureClass | null {
  if (WHOLE.has(code)) return 'whole';
  if (SEGMENT.has(code)) return 'segment';
  return null;
}

export class RpcError extends Error {
  readonly code: StatusCode;
  readonly retryAfterMs?: number;

  constructor(code: StatusCode, message?: string, retryAfterMs?: number) {
    super(message ? `${code}: ${message}` : code);
    this.name = 'RpcError';
    this.code = code;
    this.retryAfterMs = retryAfterMs;
  }

  static from(status: Status): RpcError {
    return new RpcError(status.code, status.message, status.retryAfterMs);
  }

  toStatus(): Status {
    const s: Status = { code: this.code };
    if (this.message && this.message !== this.code) s.message = this.message.replace(`${this.code}: `, '');
    if (this.retryAfterMs !== undefined) s.retryAfterMs = this.retryAfterMs;
    return s;
  }
}

/** Convert any thrown value into a status suitable for a Close frame. */
export function statusOf(err: unknown): Status {
  if (err instanceof RpcError) return err.toStatus();
  if (err instanceof Error && err.name === 'AbortError') return { code: 'cancelled' };
  const message = err instanceof Error ? err.message : String(err);
  return { code: 'internal', message };
}
