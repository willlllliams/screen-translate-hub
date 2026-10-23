// Display state (spec 07 section 1) and the event reducer (spec 02 section 10).
// The run coordinator uses the same reducer to produce snapshots, so a snapshot
// always equals applying events 1..seq to the empty state.
import type {
  CaptureGeometry,
  DisplayEvent,
  DisplayEventBody,
  DisplaySnapshot,
  EndState,
  FrameRef,
  Notice,
  ParagraphAddBody,
  ParagraphShowBody,
  ParagraphView,
  RunStateName,
  Via,
} from '@sth/model';

export interface ParaState {
  add: ParagraphAddBody;
  show?: ParagraphShowBody;
  end_state?: EndState;
  via?: Via;
}

export interface DisplayState {
  stream_id: string;
  run_id: string;
  seq: number;
  run_state: RunStateName;
  batch_seq: number;
  frame?: FrameRef;
  geometry?: CaptureGeometry;
  paragraphs: Map<number, ParaState>;
  /** Paragraphs of the previous batch kept on screen until OCR finishes; keyed by their old ids. */
  held: Map<number, ParaState>;
  notices: Map<string, Notice>;
}

export function emptyState(stream_id = '', run_id = ''): DisplayState {
  return {
    stream_id,
    run_id,
    seq: 0,
    run_state: 'running',
    batch_seq: 0,
    paragraphs: new Map(),
    held: new Map(),
    notices: new Map(),
  };
}

function moved(p: ParaState, dx: number, dy: number, newId: number): ParaState {
  const add: ParagraphAddBody = {
    ...p.add,
    paragraph_id: newId,
    quads: p.add.quads.map((q) => q.map((v, i) => v + (i % 2 === 0 ? dx : dy))),
    bounds: { ...p.add.bounds, x: p.add.bounds.x + dx, y: p.add.bounds.y + dy },
    takes_over: undefined,
  };
  return { ...p, add, show: p.show ? { ...p.show, paragraph_id: newId } : undefined };
}

/** Apply one event body; mutates the state. */
export function reduce(s: DisplayState, ev: DisplayEventBody): void {
  switch (ev.kind) {
    case 'run_state':
      s.run_state = ev.state;
      break;
    case 'batch_start': {
      const next = new Map<number, ParaState>();
      for (const c of ev.carried) {
        const p = s.paragraphs.get(c.from_paragraph_id);
        if (p) next.set(c.paragraph_id, moved(p, c.dx, c.dy, c.paragraph_id));
      }
      const held = new Map<number, ParaState>();
      for (const id of ev.held) {
        const p = s.paragraphs.get(id);
        if (p) held.set(id, p);
      }
      s.paragraphs = next;
      s.held = held;
      s.batch_seq = ev.batch_seq;
      if (ev.frame) s.frame = ev.frame;
      if (ev.geometry) s.geometry = ev.geometry;
      break;
    }
    case 'paragraph_add': {
      const inherited = ev.takes_over !== undefined ? s.held.get(ev.takes_over) : undefined;
      if (ev.takes_over !== undefined) s.held.delete(ev.takes_over);
      s.paragraphs.set(ev.paragraph_id, {
        add: ev,
        show: inherited?.show ? { ...inherited.show, paragraph_id: ev.paragraph_id } : undefined,
      });
      break;
    }
    case 'held_release':
      for (const id of ev.paragraph_ids) s.held.delete(id);
      break;
    case 'paragraph_show': {
      const p = s.paragraphs.get(ev.paragraph_id);
      if (p) p.show = ev;
      break;
    }
    case 'paragraph_end': {
      const p = s.paragraphs.get(ev.paragraph_id);
      if (p) {
        p.end_state = ev.end_state;
        p.via = ev.via;
      }
      break;
    }
    case 'notice': {
      const { kind: _k, ...notice } = ev;
      if (notice.active) s.notices.set(notice.notice_id, notice);
      else s.notices.delete(notice.notice_id);
      break;
    }
    case 'batch_end':
      break;
  }
}

export type ApplyResult = 'ok' | 'gap' | 'stale';

/** Apply an event if its sequence number is the next one (spec 07 section 1). */
export function applyEvent(s: DisplayState, e: DisplayEvent): ApplyResult {
  if (e.seq <= s.seq) return 'stale';
  if (e.seq !== s.seq + 1) return 'gap';
  reduce(s, e.ev);
  s.seq = e.seq;
  s.stream_id = e.stream_id;
  s.run_id = e.run_id;
  return 'ok';
}

function view(p: ParaState): ParagraphView {
  const v: ParagraphView = { paragraph: p.add };
  if (p.show) v.shown = p.show;
  if (p.end_state) v.end_state = p.end_state;
  if (p.via) v.via = p.via;
  return v;
}

export function toSnapshot(s: DisplayState): DisplaySnapshot {
  const snap: DisplaySnapshot = {
    stream_id: s.stream_id,
    seq: s.seq,
    run_id: s.run_id,
    run_state: s.run_state,
    batch_seq: s.batch_seq,
    paragraphs: [...s.paragraphs.values()].map(view),
    held: [...s.held.entries()].map(([id, p]) => view({ ...p, add: { ...p.add, paragraph_id: id } })),
    notices: [...s.notices.values()],
  };
  if (s.frame) snap.frame = s.frame;
  if (s.geometry) snap.geometry = s.geometry;
  return snap;
}

export function fromSnapshot(snap: DisplaySnapshot): DisplayState {
  const s = emptyState(snap.stream_id, snap.run_id);
  s.seq = snap.seq;
  s.run_state = snap.run_state;
  s.batch_seq = snap.batch_seq;
  s.frame = snap.frame;
  s.geometry = snap.geometry;
  for (const v of snap.paragraphs) s.paragraphs.set(v.paragraph.paragraph_id, { add: v.paragraph, show: v.shown, end_state: v.end_state, via: v.via });
  for (const v of snap.held) s.held.set(v.paragraph.paragraph_id, { add: v.paragraph, show: v.shown, end_state: v.end_state, via: v.via });
  for (const n of snap.notices) s.notices.set(n.notice_id, n);
  return s;
}
