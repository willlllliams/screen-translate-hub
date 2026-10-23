// Heartbeat samples (spec 17 section 3): grab the observed range at an interval and
// compare it with the frame of the last wake, tile by tile as in change detection.
import type { EncodedImage } from '@sth/model';
import type { HeartbeatSample } from './types.ts';
import { foregroundWindow, userIdleMs, type Foreground } from './win.ts';

const TILE = 16;
const TOLERANCE = 24;

/** Per-tile change flags between two raw BGRA frames of the same size (sampled every other pixel). */
export function tileChanges(a: EncodedImage, b: EncodedImage): { changed: number; total: number } {
  if (a.width !== b.width || a.height !== b.height || a.format !== 'raw_bgra8' || b.format !== 'raw_bgra8') return { changed: 1, total: 1 };
  const w = a.width;
  const h = a.height;
  const tx = Math.ceil(w / TILE);
  const ty = Math.ceil(h / TILE);
  let changed = 0;
  for (let j = 0; j < ty; j++) {
    for (let i = 0; i < tx; i++) {
      let diff = false;
      const y1 = Math.min(h, (j + 1) * TILE);
      const x1 = Math.min(w, (i + 1) * TILE);
      for (let y = j * TILE; y < y1 && !diff; y += 2) {
        let o = (y * w + i * TILE) * 4;
        for (let x = i * TILE; x < x1; x += 2, o += 8) {
          if (Math.abs(a.data[o] - b.data[o]) > TOLERANCE || Math.abs(a.data[o + 1] - b.data[o + 1]) > TOLERANCE || Math.abs(a.data[o + 2] - b.data[o + 2]) > TOLERANCE) {
            diff = true;
            break;
          }
        }
      }
      if (diff) changed++;
    }
  }
  return { changed, total: tx * ty };
}

export interface HeartbeatDeps {
  /** Grab the observed range as raw BGRA (the capture service, which leaves out the platform's own windows). */
  grab(): Promise<EncodedImage>;
  /** Process ids of the platform itself; their windows are not "the user's app". */
  ownPids: number[];
}

export class Heartbeat {
  private readonly deps: HeartbeatDeps;
  private wakeFrame: EncodedImage | null = null;
  private lastFrame: EncodedImage | null = null;
  private lastChangeAt = Date.now();
  private lastApp = '';
  private lastFg: Foreground | null = null;

  constructor(deps: HeartbeatDeps) {
    this.deps = deps;
  }

  /** Take one sample. */
  async sample(): Promise<{ sample: HeartbeatSample; frame: EncodedImage }> {
    const frame = await this.deps.grab();
    const now = Date.now();
    if (this.lastFrame) {
      const d = tileChanges(this.lastFrame, frame);
      if (d.changed > 0) this.lastChangeAt = now;
    }
    this.lastFrame = frame;
    // no reference yet (session start, or a wake before the first sample): this frame becomes it
    this.wakeFrame ??= frame;
    const sinceWake = tileChanges(this.wakeFrame, frame);
    let fg = await foregroundWindow();
    if (fg && this.deps.ownPids.includes(fg.pid)) fg = this.lastFg; // our card has focus: keep the user's app
    this.lastFg = fg;
    const app = fg?.app ?? '';
    const switched = !!this.lastApp && !!app && app !== this.lastApp;
    if (app) this.lastApp = app;
    return {
      frame,
      sample: {
        at: new Date(now).toISOString(),
        changed_ratio: sinceWake.changed / sinceWake.total,
        changed_since_ms: now - this.lastChangeAt,
        active_app: app,
        window_title: fg?.title ?? '',
        app_switched: switched,
        user_idle_ms: await userIdleMs(),
      },
    };
  }

  /** The AI looked at the screen: later samples compare with this frame (or the next one, when none is known). */
  markWake(frame: EncodedImage | null): void {
    this.wakeFrame = frame;
  }
}
