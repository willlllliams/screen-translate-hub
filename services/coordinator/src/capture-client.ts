// Client side of capture.Session (spec 09 section 4, spec 04 section 3.1).
import type { CaptureRange, ChangeMap, Image } from '@sth/model';
import { RpcError, type Peer, type Stream } from '@sth/wire';

export interface CaptureBatch {
  frame_id: number;
  frame: Image;
  change_map?: ChangeMap;
}

export interface CaptureStart {
  range: CaptureRange;
  trigger: { interval_ms: number };
  tolerance: number;
  tile: number;
  frame_format: 'raw_bgra8' | 'png';
}

type ServerMsg = {
  started?: unknown;
  batch?: CaptureBatch;
  no_batch?: unknown;
  paused?: unknown;
  resumed?: unknown;
  interrupted?: { reason: string };
};

export class CaptureClient {
  private readonly stream: Stream<ServerMsg, unknown>;
  private take: { resolve: (b: CaptureBatch | null) => void; reject: (e: unknown) => void } | null = null;
  private started?: { resolve: () => void; reject: (e: unknown) => void };
  private acks: Array<() => void> = [];
  onInterrupted?: (reason: string) => void;

  constructor(peer: Peer) {
    this.stream = peer.open<ServerMsg, unknown>('capture', 'Session', { deadlineMs: 0 });
  }

  async start(start: CaptureStart): Promise<void> {
    const ready = new Promise<void>((resolve, reject) => (this.started = { resolve, reject }));
    void this.readLoop();
    await this.stream.send({ start });
    await ready;
  }

  private async readLoop(): Promise<void> {
    try {
      for await (const m of this.stream) {
        if (m.started !== undefined) this.started?.resolve();
        else if (m.batch) this.resolveTake(m.batch);
        else if (m.no_batch !== undefined) this.resolveTake(null);
        else if (m.paused !== undefined || m.resumed !== undefined) this.acks.shift()?.();
        else if (m.interrupted) this.onInterrupted?.(m.interrupted.reason);
      }
      this.fail(new RpcError('unavailable', 'capture session ended'));
    } catch (e) {
      this.fail(e);
    }
  }

  private resolveTake(b: CaptureBatch | null): void {
    const t = this.take;
    this.take = null;
    t?.resolve(b);
  }

  private fail(e: unknown): void {
    this.started?.reject(e);
    const t = this.take;
    this.take = null;
    t?.reject(e);
    for (const a of this.acks.splice(0)) a();
  }

  /** Wait up to waitMs for the next accepted frame; null when there was none. */
  takeBatch(waitMs: number): Promise<CaptureBatch | null> {
    if (this.take) throw new Error('take_batch already pending');
    return new Promise((resolve, reject) => {
      this.take = { resolve, reject };
      this.stream.send({ take_batch: { wait_ms: waitMs } }).catch(reject);
    });
  }

  async pause(): Promise<void> {
    const ack = new Promise<void>((r) => this.acks.push(r));
    await this.stream.send({ pause: {} });
    await ack;
  }

  async resume(): Promise<void> {
    const ack = new Promise<void>((r) => this.acks.push(r));
    await this.stream.send({ resume: {} });
    await ack;
  }

  close(): void {
    this.stream.halfClose();
    this.stream.cancel('session closed');
  }
}
