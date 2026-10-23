// Sources published by run coordinators (spec 09 section 19, spec 10 sections 5.1 to 5.3):
// each keeps the display state of its stream and the recent batch frames, and fans
// snapshots and events out to subscribed browsers.
import type { DisplayEvent, DisplaySnapshot, Image } from '@sth/model';
import { applyEvent, emptyState, fromSnapshot, toSnapshot, type DisplayState } from '@sth/render';

export interface PublishStart {
  run_id: string;
  stream_id: string;
  device_id: string;
  range_label: string;
  target_language: string;
}

export interface SourceInfo {
  source_id: string;
  device_name: string;
  range_label: string;
  target_language: string;
}

export type SubscribeReply = { snapshot: DisplaySnapshot } | { event: DisplayEvent } | { offline: true };

export interface Subscriber {
  deliver(m: SubscribeReply): void;
}

/** Frames kept per source: the current one and a few before it, for late frame requests. */
const KEEP_FRAMES = 3;

export class Source {
  readonly info: SourceInfo;
  private state: DisplayState;
  private readonly subscribers = new Set<Subscriber>();
  private readonly frames = new Map<string, Image>();
  /** Called with the image ids this source no longer keeps. */
  onFramesDropped?: (ids: string[]) => void;

  constructor(start: PublishStart, deviceName: string) {
    this.info = { source_id: start.stream_id, device_name: deviceName, range_label: start.range_label, target_language: start.target_language };
    this.state = emptyState(start.stream_id, start.run_id);
  }

  snapshot(): DisplaySnapshot {
    return toSnapshot(this.state);
  }

  frame(imageId: string): Image | undefined {
    return this.frames.get(imageId);
  }

  putFrame(imageId: string, image: Image): void {
    this.frames.set(imageId, image);
    const dropped: string[] = [];
    while (this.frames.size > KEEP_FRAMES) {
      const oldest = this.frames.keys().next().value as string;
      this.frames.delete(oldest);
      dropped.push(oldest);
    }
    if (dropped.length) this.onFramesDropped?.(dropped);
  }

  setSnapshot(snap: DisplaySnapshot): void {
    this.state = fromSnapshot(snap);
    for (const s of this.subscribers) s.deliver({ snapshot: snap });
  }

  /** Apply a publisher event; a gap means the publisher lost events, so subscribers get a fresh snapshot. */
  event(e: DisplayEvent): void {
    const r = applyEvent(this.state, e);
    if (r === 'stale') return;
    if (r === 'gap') {
      // keep going from the event's sequence number; subscribers resynchronize from a snapshot
      this.state.seq = e.seq - 1;
      applyEvent(this.state, e);
      const snap = this.snapshot();
      for (const s of this.subscribers) s.deliver({ snapshot: snap });
      return;
    }
    for (const s of this.subscribers) s.deliver({ event: e });
  }

  subscribe(s: Subscriber): () => void {
    this.subscribers.add(s);
    return () => this.subscribers.delete(s);
  }

  /** The source went offline: tell subscribers, drop frames (requirement 05 section 4.3). */
  close(): void {
    for (const s of this.subscribers) s.deliver({ offline: true });
    this.subscribers.clear();
    const ids = [...this.frames.keys()];
    this.frames.clear();
    if (ids.length) this.onFramesDropped?.(ids);
  }
}

export class SourceRegistry {
  private readonly sources = new Map<string, Source>();
  private readonly watchers = new Set<(list: SourceInfo[]) => void>();
  private readonly deviceName: string;
  onFramesDropped?: (ids: string[]) => void;

  constructor(deviceName: string) {
    this.deviceName = deviceName;
  }

  add(start: PublishStart): Source {
    this.sources.get(start.stream_id)?.close();
    const src = new Source(start, this.deviceName);
    src.onFramesDropped = (ids) => this.onFramesDropped?.(ids);
    this.sources.set(start.stream_id, src);
    this.changed();
    return src;
  }

  remove(src: Source): void {
    if (this.sources.get(src.info.source_id) !== src) return;
    this.sources.delete(src.info.source_id);
    src.close();
    this.changed();
  }

  clear(): void {
    for (const src of [...this.sources.values()]) this.remove(src);
  }

  get(id: string): Source | undefined {
    return this.sources.get(id);
  }

  /** The source holding an image, for frame requests. */
  frame(imageId: string): Image | undefined {
    for (const src of this.sources.values()) {
      const f = src.frame(imageId);
      if (f) return f;
    }
    return undefined;
  }

  list(): SourceInfo[] {
    return [...this.sources.values()].map((s) => s.info);
  }

  watch(cb: (list: SourceInfo[]) => void): () => void {
    this.watchers.add(cb);
    cb(this.list());
    return () => this.watchers.delete(cb);
  }

  private changed(): void {
    const list = this.list();
    for (const w of this.watchers) w(list);
  }
}
