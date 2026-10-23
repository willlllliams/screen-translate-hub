// Per service instance: FIFO queue, concurrency limit c and token bucket (b, r)
// (spec 04 section 7.2). Limits are per service, shared by every node bound to it.

export interface QueueLimits {
  concurrency: number;
  ratePerSec: number;
  burst: number;
}

interface Waiter {
  resolve: (release: () => void) => void;
  reject: (e: unknown) => void;
  signal?: AbortSignal;
  onAbort?: () => void;
}

export class ServiceQueue {
  private limits: QueueLimits;
  private tokens: number;
  private lastRefill = performance.now();
  private active = 0;
  private readonly waiters: Waiter[] = [];
  private timer?: ReturnType<typeof setTimeout>;

  constructor(limits: QueueLimits) {
    this.limits = { ...limits };
    this.tokens = limits.burst;
  }

  get inFlight(): number {
    return this.active;
  }

  get queued(): number {
    return this.waiters.length;
  }

  setLimits(limits: QueueLimits): void {
    this.limits = { ...limits };
    this.pump();
  }

  acquire(signal?: AbortSignal): Promise<() => void> {
    return new Promise((resolve, reject) => {
      if (signal?.aborted) {
        reject(signal.reason ?? new Error('aborted'));
        return;
      }
      const w: Waiter = { resolve, reject, signal };
      if (signal) {
        w.onAbort = () => {
          const i = this.waiters.indexOf(w);
          if (i >= 0) this.waiters.splice(i, 1);
          reject(signal.reason ?? new Error('aborted'));
        };
        signal.addEventListener('abort', w.onAbort, { once: true });
      }
      this.waiters.push(w);
      this.pump();
    });
  }

  private refill(): void {
    const now = performance.now();
    this.tokens = Math.min(this.limits.burst, this.tokens + ((now - this.lastRefill) / 1000) * this.limits.ratePerSec);
    this.lastRefill = now;
  }

  private pump(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
    this.refill();
    while (this.waiters.length > 0 && this.active < this.limits.concurrency && this.tokens >= 1) {
      const w = this.waiters.shift()!;
      if (w.signal && w.onAbort) w.signal.removeEventListener('abort', w.onAbort);
      this.tokens -= 1;
      this.active++;
      let released = false;
      w.resolve(() => {
        if (released) return;
        released = true;
        this.active--;
        this.pump();
      });
    }
    if (this.waiters.length > 0 && this.active < this.limits.concurrency && this.tokens < 1 && this.limits.ratePerSec > 0) {
      const wait = ((1 - this.tokens) / this.limits.ratePerSec) * 1000;
      this.timer = setTimeout(() => this.pump(), Math.ceil(wait));
      (this.timer as { unref?: () => void }).unref?.();
    }
  }
}
