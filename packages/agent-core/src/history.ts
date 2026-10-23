// Local history (requirement 09 section 2: screenshot translations and assistant
// conversations on this computer only, no capacity management or sync). One JSON file
// per entry under history/YYYY-MM-DD; a screenshot's picture sits next to it. Folder and
// file names use local time, as the user looks for them; the entries record UTC.
import { randomUUID } from 'node:crypto';
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { EncodedImage, Image } from '@sth/model';

export interface HistoryEntry {
  kind: 'screenshot' | 'assistant_session' | string;
  [k: string]: unknown;
}

export interface SavedEntry {
  id: string;
  kind: string;
  at: string;
  file: string;
  image?: string;
}

/** Encodes a captured picture for the history folder; null to leave the picture out. */
export type ImageEncoder = (img: EncodedImage) => { data: Uint8Array; ext: string } | null;

function localNames(at: Date): { day: string; time: string } {
  const p = (n: number) => String(n).padStart(2, '0');
  return {
    day: `${at.getFullYear()}-${p(at.getMonth() + 1)}-${p(at.getDate())}`,
    time: `${p(at.getHours())}${p(at.getMinutes())}${p(at.getSeconds())}`,
  };
}

export class HistoryStore {
  readonly dir: string;
  private readonly encode?: ImageEncoder;

  constructor(dir: string, encode?: ImageEncoder) {
    this.dir = dir;
    this.encode = encode;
  }

  save(entry: HistoryEntry): SavedEntry {
    const at = new Date();
    const id = randomUUID();
    const names = localNames(at);
    const day = join(this.dir, names.day);
    mkdirSync(day, { recursive: true });
    const base = `${names.time}-${entry.kind}-${id.slice(0, 8)}`;
    const { image, ...rest } = entry as HistoryEntry & { image?: Image };
    let imageFile: string | undefined;
    if (image?.image && this.encode) {
      const enc = this.encode(image.image);
      if (enc) {
        imageFile = `${base}.${enc.ext}`;
        writeFileSync(join(day, imageFile), enc.data);
      }
    }
    const file = join(day, `${base}.json`);
    writeFileSync(file, JSON.stringify({ id, at: at.toISOString(), ...rest, ...(imageFile ? { image_file: imageFile, geometry: image?.geometry } : {}) }, null, 2));
    return { id, kind: entry.kind, at: at.toISOString(), file, image: imageFile && join(day, imageFile) };
  }

  /** Newest first. */
  list(limit = 50): SavedEntry[] {
    const out: SavedEntry[] = [];
    let days: string[] = [];
    try {
      days = readdirSync(this.dir).filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d)).sort().reverse();
    } catch {
      return out;
    }
    for (const d of days) {
      for (const f of readdirSync(join(this.dir, d)).filter((x) => x.endsWith('.json')).sort().reverse()) {
        try {
          const e = JSON.parse(readFileSync(join(this.dir, d, f), 'utf8')) as { id: string; kind: string; at: string; image_file?: string };
          out.push({ id: e.id, kind: e.kind, at: e.at, file: join(this.dir, d, f), image: e.image_file && join(this.dir, d, e.image_file) });
        } catch {
          // a damaged entry is skipped
        }
        if (out.length >= limit) return out;
      }
    }
    return out;
  }
}
