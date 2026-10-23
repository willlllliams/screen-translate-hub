// Display streams (spec 02 section 10, spec 04 section 10): one per display node.
// Each keeps the same reducer state as the display ends, so snapshots are exact.
import type { CaptureGeometry, DisplayEvent, DisplayEventBody, DisplaySnapshot, FrameRef, Image } from '@sth/model';
import { emptyState, reduce, toSnapshot, type DisplayState } from '@sth/render';
import { randomUUID } from 'node:crypto';
import type { OutputType } from './types.ts';

export interface DisplaySink {
  /** Send the opening message, the current batch frame if any (web display), then the current snapshot. */
  open(snapshot: DisplaySnapshot, frame?: { id: string; seq: number; image: Image }): Promise<void>;
  event(e: DisplayEvent): Promise<void>;
  /** Web display only: the batch frame, sent before the batch_start that references it. */
  frame?(imageId: string, batchSeq: number, image: Image): Promise<void>;
  close(): void;
}

export class DisplayStream {
  readonly streamId = randomUUID();
  readonly node: string;
  readonly type: OutputType;
  readonly state: DisplayState;
  private sink: DisplaySink | null = null;
  private chain: Promise<void> = Promise.resolve();
  private lastFrame?: { id: string; seq: number; image: Image };

  constructor(runId: string, node: string, type: OutputType) {
    this.node = node;
    this.type = type;
    this.state = emptyState(this.streamId, runId);
  }

  get attached(): boolean {
    return this.sink !== null;
  }

  has(sink: DisplaySink): boolean {
    return this.sink === sink;
  }

  /** Attach a sink: it gets the current snapshot first (and the current frame), then live events. */
  attach(sink: DisplaySink): void {
    this.detach();
    this.sink = sink;
    const snap = toSnapshot(this.state);
    const frame = this.lastFrame;
    this.enqueue(() => sink.open(snap, frame));
  }

  detach(): void {
    if (!this.sink) return;
    const s = this.sink;
    this.sink = null;
    this.enqueue(async () => s.close());
  }

  emit(body: DisplayEventBody): void {
    this.state.seq += 1;
    reduce(this.state, body);
    const e: DisplayEvent = { stream_id: this.streamId, seq: this.state.seq, run_id: this.state.run_id, ev: body };
    const sink = this.sink;
    if (sink) this.enqueue(() => sink.event(e));
  }

  sendFrame(imageId: string, batchSeq: number, image: Image): void {
    this.lastFrame = { id: imageId, seq: batchSeq, image };
    const sink = this.sink;
    if (sink?.frame) this.enqueue(() => sink.frame!(imageId, batchSeq, image));
  }

  snapshot(): DisplaySnapshot {
    return toSnapshot(this.state);
  }

  /** Wait until everything queued so far has been handed to the transport. */
  flush(): Promise<void> {
    return this.chain;
  }

  private enqueue(fn: () => Promise<void>): void {
    this.chain = this.chain.then(fn).catch(() => {
      // a broken sink: stop sending to it
      if (this.sink) {
        try {
          this.sink.close();
        } catch {
          // ignore
        }
        this.sink = null;
      }
    });
  }
}

export class DisplayHub {
  readonly streams: DisplayStream[];

  constructor(runId: string, outputs: Array<{ node: string; type: OutputType }>) {
    this.streams = outputs.map((o) => new DisplayStream(runId, o.node, o.type));
  }

  byType(type: OutputType): DisplayStream[] {
    return this.streams.filter((s) => s.type === type);
  }

  emit(body: DisplayEventBody): void {
    for (const s of this.streams) s.emit(body);
  }

  /** batch_start differs per display end: the web display gets the frame, the overlay the geometry. */
  batchStart(base: Extract<DisplayEventBody, { kind: 'batch_start' }>, frame: { ref: FrameRef; image: Image } | null, geometry: CaptureGeometry | undefined): void {
    for (const s of this.streams) {
      const ev = { ...base };
      if (s.type === 'web_display' && frame) {
        s.sendFrame(frame.ref.image_id, base.batch_seq, frame.image);
        ev.frame = frame.ref;
      }
      if (s.type === 'overlay' && geometry) ev.geometry = geometry;
      s.emit(ev);
    }
  }

  async flush(): Promise<void> {
    await Promise.all(this.streams.map((s) => s.flush()));
  }

  closeAll(): void {
    for (const s of this.streams) s.detach();
  }
}
