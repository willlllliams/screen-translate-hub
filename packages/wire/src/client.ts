// Caller-side helpers for the four call shapes (spec 08 section 4.3).
import type { Connection } from './connection.ts';
import { RpcError } from './status.ts';
import type { Stream } from './stream.ts';

export interface CallOptions {
  deadlineMs?: number;
  meta?: Record<string, string>;
  signal?: AbortSignal;
  /** Interface version required by the caller; defaults to 1.0. */
  version?: readonly [number, number];
}

export class Peer {
  readonly conn: Connection;
  readonly svc: string;

  constructor(conn: Connection, svc: string) {
    this.conn = conn;
    this.svc = svc;
  }

  open<In, Out>(iface: string, method: string, opts: CallOptions = {}): Stream<In, Out> {
    return this.conn.open<In, Out>(this.svc, iface, opts.version ?? [1, 0], method, opts);
  }

  /** One request, one reply. */
  async unary<Req, Res>(iface: string, method: string, req: Req, opts: CallOptions = {}): Promise<Res> {
    const s = this.open<Res, Req>(iface, method, opts);
    await s.send(req);
    s.halfClose();
    const reply = await s.recv();
    const status = await s.done;
    if (status.code !== 'ok') throw RpcError.from(status);
    if (reply === undefined) throw new RpcError('internal', `${iface}.${method} returned no reply`);
    return reply;
  }

  /** One request, a stream of replies. Breaking out of the loop cancels the call. */
  async *serverStream<Req, Res>(iface: string, method: string, req: Req, opts: CallOptions = {}): AsyncGenerator<Res> {
    const s = this.open<Res, Req>(iface, method, opts);
    let complete = false;
    try {
      await s.send(req);
      s.halfClose();
      for (;;) {
        const m = await s.recv();
        if (m === undefined) break;
        yield m;
      }
      const status = await s.done;
      if (status.code !== 'ok') throw RpcError.from(status);
      complete = true;
    } finally {
      if (!complete) s.cancel('caller stopped');
    }
  }

  /** Many messages, at most one reply. */
  async clientStream<Req, Res>(iface: string, method: string, opts: CallOptions = {}): Promise<ClientStreamCall<Req, Res>> {
    return new ClientStreamCall<Req, Res>(this.open<Res, Req>(iface, method, opts));
  }

  /** Both sides send freely. */
  bidi<Req, Res>(iface: string, method: string, opts: CallOptions = {}): Stream<Res, Req> {
    return this.open<Res, Req>(iface, method, opts);
  }
}

export class ClientStreamCall<Req, Res> {
  readonly stream: Stream<Res, Req>;

  constructor(stream: Stream<Res, Req>) {
    this.stream = stream;
  }

  send(m: Req): Promise<void> {
    return this.stream.send(m);
  }

  async finish(): Promise<Res | undefined> {
    this.stream.halfClose();
    const reply = await this.stream.recv();
    const status = await this.stream.done;
    if (status.code !== 'ok') throw RpcError.from(status);
    return reply;
  }

  cancel(reason?: string): void {
    this.stream.cancel(reason);
  }
}
