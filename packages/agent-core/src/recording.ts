// Recording display ends for headless runs and tests (spec 16 section 2): they
// implement overlay.Attach and card.Open and keep the display state.
import type { DisplayEvent, DisplaySnapshot } from '@sth/model';
import { applyEvent, emptyState, fromSnapshot, toSnapshot, type DisplayState } from '@sth/render';
import type { Stream } from '@sth/wire';
import type { AgentCore } from './agent.ts';

export interface Recorded {
  kind: 'overlay' | 'card';
  start: Record<string, unknown>;
  events: DisplayEvent[];
  state: DisplayState;
  gaps: number;
  ended: boolean;
}

export class RecordingDisplays {
  readonly streams: Recorded[] = [];
  private readonly listeners: Array<(r: Recorded, e?: DisplayEvent) => void> = [];

  install(agent: AgentCore): void {
    agent.provide('overlay', 'overlay', {
      Attach: (s: Stream) => this.consume('overlay', s, 'event'),
      Annotate: async (s: Stream) => {
        for await (const _m of s) {
          // annotations are not recorded in v1 tests
        }
      },
    });
    agent.provide('card', 'card', {
      Open: async (s: Stream) => {
        await s.send({ opened: { card_id: 'recorded' } });
        await this.consume('card', s, 'display');
      },
    });
  }

  onUpdate(cb: (r: Recorded, e?: DisplayEvent) => void): void {
    this.listeners.push(cb);
  }

  private async consume(kind: 'overlay' | 'card', s: Stream, eventKey: 'event' | 'display'): Promise<void> {
    const rec: Recorded = { kind, start: {}, events: [], state: emptyState(), gaps: 0, ended: false };
    this.streams.push(rec);
    for await (const m of s as Stream<Record<string, unknown>, unknown>) {
      if (m.start) rec.start = m.start as Record<string, unknown>;
      else if (m.snapshot) rec.state = fromSnapshot(m.snapshot as DisplaySnapshot);
      else if (m[eventKey]) {
        const e = m[eventKey] as DisplayEvent;
        rec.events.push(e);
        if (applyEvent(rec.state, e) === 'gap') rec.gaps++;
        for (const l of this.listeners) l(rec, e);
      }
    }
    rec.ended = true;
    for (const l of this.listeners) l(rec);
  }

  /** Paragraph texts with their shown translation, in display order. */
  static view(r: Recorded): Array<{ id: number; text: string; shown?: string; error?: string; end?: string; via?: string }> {
    return toSnapshot(r.state).paragraphs.map((p) => ({
      id: p.paragraph.paragraph_id,
      text: p.paragraph.text,
      shown: p.shown?.show === 'text' ? p.shown.text : undefined,
      error: p.shown?.show === 'error' ? p.shown.error_reason : undefined,
      end: p.end_state,
      via: p.via,
    }));
  }
}
