// What the assistant can reach on this computer: screen capture, OCR and normalization,
// the current translations and the overlay's annotation layer, all through the agent.
import type { Annotation, CaptureRange, DisplaySnapshot, EncodedImage, Image, OcrResult, Unit } from '@sth/model';
import type { Clients } from '@sth/service-kit';
import type { Stream } from '@sth/wire';
import { foregroundWindow } from './win.ts';

export interface ScreenRect { x: number; y: number; w: number; h: number }

export interface Paragraph {
  id: number;
  text: string;
  rect: ScreenRect;
}

export class Platform {
  private readonly clients: Clients;
  private readonly ownPids: number[];
  range: CaptureRange;
  private annotateStream: Stream<unknown, unknown> | null = null;
  private readonly annotations = new Map<string, Annotation>();
  private nextAnnotation = 1;

  constructor(clients: Clients, range: CaptureRange, ownPids: number[]) {
    this.clients = clients;
    this.range = range;
    this.ownPids = ownPids;
  }

  private async peer(name: string) {
    return this.clients.peer(await this.clients.acquire(name));
  }

  /** One frame of the observed range (or a screen region), raw BGRA with its geometry. */
  async grab(region?: ScreenRect): Promise<Image> {
    const capture = await this.peer('capture');
    let target: Record<string, unknown> = {};
    if (region) target = { region: { x: Math.round(region.x), y: Math.round(region.y), w: Math.round(region.w), h: Math.round(region.h) } };
    else if (this.range.window_id) target = { window_id: this.range.window_id };
    else if (this.range.region) target = { region: this.range.region };
    else if (this.range.follow_active_window) {
      const fg = await foregroundWindow();
      if (fg && !this.ownPids.includes(fg.pid)) target = { window_id: fg.hwnd };
    }
    return capture.unary<Record<string, unknown>, Image>('capture', 'Grab', { ...target, format: 'raw_bgra8' }, { deadlineMs: 10_000 });
  }

  /** OCR and normalization of a frame; paragraph rectangles in screen pixels. */
  async read(img: Image): Promise<Paragraph[]> {
    const g = img.geometry!;
    const e = img.image as EncodedImage;
    const ocr = await (await this.peer('bundled.ocr')).unary<unknown, OcrResult>(
      'ocr',
      'Recognize',
      { run_id: 'assistant', batch_seq: 1, languages: [], regions: [{ image: e, rect: { x: 0, y: 0, w: e.width, h: e.height }, scale: 1 }] },
      { deadlineMs: 20_000 },
    );
    const { units } = await (await this.peer('normalize')).unary<unknown, { units: Unit[] }>(
      'normalize',
      'Normalize',
      { ocr, reused: [], first_id: 1, frame_width: e.width, frame_height: e.height },
      { deadlineMs: 10_000 },
    );
    return units.map((u) => ({
      id: u.paragraph_id,
      text: u.text,
      rect: { x: Math.round(g.origin_x + (u.bounds?.x ?? 0)), y: Math.round(g.origin_y + (u.bounds?.y ?? 0)), w: Math.round(u.bounds?.w ?? 0), h: Math.round(u.bounds?.h ?? 0) },
    }));
  }

  /** The current continuous translation (coordinator.GetDisplay), positions in screen pixels. */
  async translations(): Promise<Array<{ original: string; translation: string | null; failed?: string; rect: ScreenRect }> | null> {
    const coord = await this.peer('coordinator');
    const r = await coord.unary<unknown, { snapshot: DisplaySnapshot | null }>('coordinator', 'GetDisplay', {}, { deadlineMs: 5_000 });
    const snap = r.snapshot;
    if (!snap) return null;
    const g = snap.geometry;
    const W = g?.width ?? 1;
    const H = g?.height ?? 1;
    return [...snap.held, ...snap.paragraphs].map(({ paragraph: p, shown }) => ({
      original: p.text,
      translation: shown?.show === 'text' ? (shown.text ?? null) : null,
      failed: shown?.show === 'error' ? (shown.error_reason ?? 'failed') : undefined,
      rect: {
        x: Math.round((g?.origin_x ?? 0) + p.bounds.x * W),
        y: Math.round((g?.origin_y ?? 0) + p.bounds.y * H),
        w: Math.round(p.bounds.w * W),
        h: Math.round(p.bounds.h * H),
      },
    }));
  }

  private async annotateCall(): Promise<Stream<unknown, unknown>> {
    if (this.annotateStream && !this.annotateStream.isFinished) return this.annotateStream;
    this.annotateStream = this.clients.agentService('overlay').open<unknown, unknown>('overlay', 'Annotate', { deadlineMs: 0 });
    return this.annotateStream;
  }

  /** Draw annotations on the overlay's annotation layer; returns their ids. */
  async annotate(items: Array<Omit<Annotation, 'id'>>): Promise<string[]> {
    const withIds = items.map((a) => ({ anchor: 'screen' as const, ...a, id: `a${this.nextAnnotation++}` }));
    for (const a of withIds) this.annotations.set(a.id, a);
    await (await this.annotateCall()).send({ set: withIds });
    return withIds.map((a) => a.id);
  }

  /** Clear the given annotations, or all of this session's (other sessions' stay). */
  async clearAnnotations(ids?: string[]): Promise<void> {
    const target = ids?.length ? ids.filter((id) => this.annotations.has(id)) : [...this.annotations.keys()];
    for (const id of target) this.annotations.delete(id);
    if (!target.length || !this.annotateStream || this.annotateStream.isFinished) return;
    await this.annotateStream.send({ clear: { ids: target } });
  }

  /** Session end: remove this session's annotations and close the layer stream. */
  async close(): Promise<void> {
    await this.clearAnnotations().catch(() => undefined);
    if (this.annotateStream && !this.annotateStream.isFinished) this.annotateStream.halfClose();
    this.annotateStream = null;
  }
}
