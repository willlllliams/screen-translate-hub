// One call on a connection (spec 08 section 4). The caller opens the stream and
// may cancel it; the callee ends it with a Close carrying a status. Both sides
// can send messages. Flow control counts messages (spec 18 section 3).
import type { StreamFrame } from './frames.ts';
import { OK, RpcError, type Status } from './status.ts';

export const INITIAL_CREDIT = 32;
const GRANT_BATCH = 8;

export type StreamRole = 'caller' | 'callee';

export interface StreamSink {
  sendFrame(f: StreamFrame): void;
  release(id: number): void;
}

export class Stream<In = unknown, Out = unknown> implements AsyncIterable<In> {
  readonly id: number;
  readonly role: StreamRole;
  /** Aborted when the stream finishes for any reason; handlers use it to stop work. */
  readonly signal: AbortSignal;
  /** Resolves with the final status once the stream has finished. */
  readonly done: Promise<Status>;
  /** Monotonic deadline (performance.now() based), if any. */
  readonly deadline?: number;

  private readonly sink: StreamSink;
  private readonly abort = new AbortController();
  private resolveDone!: (s: Status) => void;
  private queue: In[] = [];
  private wakers: Array<() => void> = [];
  private remoteHalf = false;
  private localHalf = false;
  private finished: Status | null = null;
  private sendCredit = INITIAL_CREDIT;
  private pendingGrant = 0;
  private timer?: ReturnType<typeof setTimeout>;

  constructor(sink: StreamSink, id: number, role: StreamRole, deadlineMs?: number) {
    this.sink = sink;
    this.id = id;
    this.role = role;
    this.signal = this.abort.signal;
    this.done = new Promise((r) => (this.resolveDone = r));
    if (deadlineMs && deadlineMs > 0) {
      this.deadline = performance.now() + deadlineMs;
      this.timer = setTimeout(() => this.onDeadline(), deadlineMs);
      (this.timer as { unref?: () => void }).unref?.();
    }
  }

  get isFinished(): boolean {
    return this.finished !== null;
  }

  get status(): Status | null {
    return this.finished;
  }

  /** Remaining time until the deadline in ms, or undefined when unlimited. */
  remainingMs(): number | undefined {
    if (this.deadline === undefined) return undefined;
    return Math.max(0, Math.floor(this.deadline - performance.now()));
  }

  /** Whether `send` would go out now, without waiting for credit. */
  get writable(): boolean {
    return !this.finished && !this.localHalf && this.sendCredit > 0;
  }

  /** Resolves once a send would go out without waiting, or the stream has finished. */
  async whenWritable(): Promise<void> {
    while (!this.finished && this.sendCredit <= 0) await this.wait();
  }

  async send(message: Out): Promise<void> {
    for (;;) {
      if (this.finished) throw RpcError.from(this.finished.code === 'ok' ? { code: 'cancelled' } : this.finished);
      if (this.localHalf) throw new Error(`stream ${this.id}: send after halfClose`);
      if (this.sendCredit > 0) break;
      await this.wait();
    }
    this.sendCredit--;
    this.sink.sendFrame({ t: 'msg', s: this.id, b: message });
  }

  /** Next incoming message; undefined at the end of input. Throws RpcError if the stream failed. */
  async recv(): Promise<In | undefined> {
    for (;;) {
      if (this.queue.length > 0) {
        const m = this.queue.shift() as In;
        this.grant();
        return m;
      }
      if (this.finished) {
        if (this.finished.code === 'ok' || this.remoteHalf) return undefined;
        throw RpcError.from(this.finished);
      }
      if (this.remoteHalf) return undefined;
      await this.wait();
    }
  }

  async *[Symbol.asyncIterator](): AsyncIterator<In> {
    for (;;) {
      const m = await this.recv();
      if (m === undefined) return;
      yield m;
    }
  }

  /** Signal that this side will send no more messages. */
  halfClose(): void {
    if (this.localHalf || this.finished) return;
    this.localHalf = true;
    this.sink.sendFrame({ t: 'half', s: this.id });
  }

  /** Caller side: abandon the call. */
  cancel(reason = 'cancelled'): void {
    if (this.finished) return;
    this.sink.sendFrame({ t: 'cancel', s: this.id, reason });
    this.finish({ code: 'cancelled', message: reason });
  }

  /** Callee side: end the stream with a status. */
  close(status: Status = OK): void {
    if (this.finished) return;
    this.sink.sendFrame({ t: 'close', s: this.id, code: status.code, msg: status.message, retry: status.retryAfterMs });
    this.finish(status);
  }

  // ---- called by Connection ----

  onMsg(body: unknown): void {
    if (this.finished || this.remoteHalf) return;
    this.queue.push(body as In);
    this.wakeAll();
  }

  onHalf(): void {
    this.remoteHalf = true;
    this.wakeAll();
  }

  onClose(status: Status): void {
    this.remoteHalf = true;
    this.finish(status);
  }

  onCancel(reason: string): void {
    this.finish({ code: 'cancelled', message: reason });
  }

  onCredit(n: number): void {
    this.sendCredit += n;
    this.wakeAll();
  }

  /** The connection went away. */
  onLost(status: Status): void {
    this.finish(status);
  }

  // ---- internals ----

  private onDeadline(): void {
    if (this.finished) return;
    const status: Status = { code: 'deadline_exceeded' };
    if (this.role === 'caller') {
      this.sink.sendFrame({ t: 'cancel', s: this.id, reason: 'deadline' });
      this.finish(status);
    } else {
      this.close(status);
    }
  }

  private grant(): void {
    if (this.finished || this.remoteHalf) return;
    this.pendingGrant++;
    if (this.pendingGrant >= GRANT_BATCH || this.queue.length === 0) {
      this.sink.sendFrame({ t: 'credit', s: this.id, n: this.pendingGrant });
      this.pendingGrant = 0;
    }
  }

  private finish(status: Status): void {
    if (this.finished) return;
    this.finished = status;
    if (this.timer) clearTimeout(this.timer);
    this.abort.abort(status.code === 'ok' ? undefined : new RpcError(status.code, status.message));
    this.wakeAll();
    this.resolveDone(status);
    this.sink.release(this.id);
  }

  private wait(): Promise<void> {
    return new Promise((r) => this.wakers.push(r));
  }

  private wakeAll(): void {
    const w = this.wakers;
    this.wakers = [];
    for (const f of w) f();
  }
}
