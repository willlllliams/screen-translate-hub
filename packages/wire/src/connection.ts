// A multiplexed connection (spec 08 sections 4, 8, 10). Transport-agnostic:
// the transport feeds incoming bytes with receive() and reports loss with lost().
import { decodeFrame, encodeFrame, isStreamFrame, type Frame, type OpenFrame, type StreamFrame } from './frames.ts';
import { type Status } from './status.ts';
import { Stream, type StreamSink } from './stream.ts';

export interface Socket {
  send(data: Uint8Array): void;
  close(code?: number, reason?: string): void;
}

export interface PeerInfo {
  kind: 'local' | 'browser';
  name: string;
}

export interface OpenOptions {
  deadlineMs?: number;
  meta?: Record<string, string>;
  signal?: AbortSignal;
}

const PING_IDLE_MS = 15_000;
const DEAD_AFTER_MS = 45_000;

export class Connection implements StreamSink {
  readonly initiator: boolean;
  readonly peer: PeerInfo;
  readonly closed: Promise<Status>;
  /** Called for every stream the remote side opens. */
  onOpen?: (frame: OpenFrame, stream: Stream) => void;

  private readonly socket: Socket;
  private readonly streams = new Map<number, Stream>();
  private nextId: number;
  private isClosed = false;
  private resolveClosed!: (s: Status) => void;
  private lastRecv = Date.now();
  private lastSend = Date.now();
  private pingSeq = 0;
  private keepalive?: ReturnType<typeof setInterval>;

  constructor(socket: Socket, initiator: boolean, peer: PeerInfo) {
    this.socket = socket;
    this.initiator = initiator;
    this.peer = peer;
    this.nextId = initiator ? 1 : 2;
    this.closed = new Promise((r) => (this.resolveClosed = r));
    this.keepalive = setInterval(() => this.tick(), 5_000);
    (this.keepalive as { unref?: () => void }).unref?.();
  }

  get isOpen(): boolean {
    return !this.isClosed;
  }

  open<In = unknown, Out = unknown>(
    svc: string,
    iface: string,
    ver: readonly [number, number],
    method: string,
    opts: OpenOptions = {},
  ): Stream<In, Out> {
    const id = this.nextId;
    this.nextId += 2;
    const stream = new Stream<In, Out>(this, id, 'caller', opts.deadlineMs);
    if (this.isClosed) {
      stream.onLost({ code: 'unavailable', message: 'connection closed' });
      return stream;
    }
    this.streams.set(id, stream as Stream);
    this.sendFrame({
      t: 'open',
      s: id,
      svc,
      iface,
      maj: ver[0],
      min: ver[1],
      method,
      dl: opts.deadlineMs && opts.deadlineMs > 0 ? Math.ceil(opts.deadlineMs) : 0,
      meta: opts.meta,
    });
    if (opts.signal) {
      if (opts.signal.aborted) stream.cancel(String(opts.signal.reason ?? 'aborted'));
      else opts.signal.addEventListener('abort', () => stream.cancel(String(opts.signal?.reason ?? 'aborted')), { once: true });
    }
    return stream;
  }

  /** Feed one transport message. */
  receive(data: Uint8Array): void {
    this.lastRecv = Date.now();
    let f: Frame;
    try {
      f = decodeFrame(data);
    } catch {
      return;
    }
    if (f.t === 'ping') {
      this.sendRaw({ t: 'pong', n: f.n });
      return;
    }
    if (f.t === 'pong' || f.t === 'hello' || f.t === 'ack') return;
    if (!isStreamFrame(f)) return;
    if (f.t === 'open') {
      this.acceptOpen(f);
      return;
    }
    const stream = this.streams.get(f.s);
    if (!stream) return; // late frame for a finished stream
    switch (f.t) {
      case 'msg':
        stream.onMsg(f.b);
        break;
      case 'half':
        stream.onHalf();
        break;
      case 'close':
        stream.onClose({ code: f.code, message: f.msg, retryAfterMs: f.retry });
        break;
      case 'cancel':
        stream.onCancel(f.reason);
        break;
      case 'credit':
        stream.onCredit(f.n);
        break;
    }
  }

  /** The transport is gone: fail every stream with `unavailable` (spec 08 section 8.2). */
  lost(reason = 'connection lost'): void {
    if (this.isClosed) return;
    this.isClosed = true;
    if (this.keepalive) clearInterval(this.keepalive);
    const status: Status = { code: 'unavailable', message: reason };
    for (const s of [...this.streams.values()]) s.onLost(status);
    this.streams.clear();
    this.resolveClosed(status);
  }

  close(reason = 'closed'): void {
    if (this.isClosed) return;
    try {
      this.socket.close(1000, reason);
    } catch {
      // ignore
    }
    this.lost(reason);
  }

  // ---- StreamSink ----

  sendFrame(f: StreamFrame): void {
    this.sendRaw(f);
  }

  release(id: number): void {
    this.streams.delete(id);
  }

  // ---- internals ----

  private acceptOpen(f: OpenFrame): void {
    const stream = new Stream(this, f.s, 'callee', f.dl > 0 ? f.dl : undefined);
    this.streams.set(f.s, stream);
    if (!this.onOpen) {
      stream.close({ code: 'unavailable', message: 'no services on this endpoint' });
      return;
    }
    this.onOpen(f, stream);
  }

  private sendRaw(f: Frame): void {
    if (this.isClosed) return;
    this.lastSend = Date.now();
    try {
      this.socket.send(encodeFrame(f));
    } catch {
      this.lost('send failed');
    }
  }

  private tick(): void {
    if (this.isClosed) return;
    const now = Date.now();
    if (now - this.lastRecv > DEAD_AFTER_MS) {
      this.close('keepalive timeout');
      return;
    }
    if (now - this.lastSend > PING_IDLE_MS || now - this.lastRecv > PING_IDLE_MS) {
      this.sendRaw({ t: 'ping', n: ++this.pingSeq });
    }
  }
}
