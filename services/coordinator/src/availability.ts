// Service-level availability (spec 04 section 6.3). A wholly unavailable service
// fails requests immediately, without the network, until its recovery condition.
// v1 recovery is time based: the wait the service asked for, or a backoff per code.
import type { StatusCode } from '@sth/wire';

const BACKOFF_MS: Partial<Record<StatusCode, number>> = {
  unavailable: 5_000,
  rate_limited: 10_000,
  quota_exceeded: 60_000,
  incompatible: 60_000,
  unimplemented: 60_000,
  permission_denied: 30_000,
};

interface Down {
  code: StatusCode;
  reason: string;
  until: number;
}

export class Availability {
  private readonly down = new Map<string, Down>();
  private readonly listeners: Array<(svc: string, available: boolean, reason: string) => void> = [];
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>();

  onChange(cb: (svc: string, available: boolean, reason: string) => void): void {
    this.listeners.push(cb);
  }

  check(svc: string): Down | null {
    const d = this.down.get(svc);
    if (!d) return null;
    if (Date.now() >= d.until) {
      this.recover(svc);
      return null;
    }
    return d;
  }

  mark(svc: string, code: StatusCode, reason: string, retryAfterMs?: number): void {
    const wait = retryAfterMs && retryAfterMs > 0 ? retryAfterMs : (BACKOFF_MS[code] ?? 5_000);
    const wasDown = this.down.has(svc);
    this.down.set(svc, { code, reason, until: Date.now() + wait });
    const t = this.timers.get(svc);
    if (t) clearTimeout(t);
    const timer = setTimeout(() => this.recover(svc), wait);
    (timer as { unref?: () => void }).unref?.();
    this.timers.set(svc, timer);
    if (!wasDown) for (const l of this.listeners) l(svc, false, reason);
  }

  /** E.g. the service re-registered with a compatible version. */
  recover(svc: string): void {
    const d = this.down.get(svc);
    if (!d) return;
    this.down.delete(svc);
    const t = this.timers.get(svc);
    if (t) clearTimeout(t);
    this.timers.delete(svc);
    for (const l of this.listeners) l(svc, true, d.reason);
  }

  dispose(): void {
    for (const t of this.timers.values()) clearTimeout(t);
    this.timers.clear();
  }
}
