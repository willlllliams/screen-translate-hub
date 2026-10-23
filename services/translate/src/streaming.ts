// Turn a growing model output into cumulative per-paragraph updates (requirement 03
// section 4.2): every time an item's text grows, emit a new version; when its string
// closes, emit the final version. Items the model never produced fail individually.
import { RpcError } from '@sth/wire';
import type { Emit, TranslateRequest } from './engine.ts';
import { extractItems, parseItems } from './prompt.ts';

export class ItemStreamer {
  private readonly emit: Emit;
  private readonly ids: Set<number>;
  private readonly shown = new Map<number, string>();
  private readonly done = new Set<number>();
  private readonly streaming: boolean;

  constructor(req: TranslateRequest, emit: Emit) {
    this.emit = emit;
    this.ids = new Set(req.segments.map((s) => s.paragraph_id));
    this.streaming = req.mode === 'stream';
  }

  /** Feed the whole output so far. */
  async progress(buffer: string): Promise<void> {
    if (!this.streaming) return;
    for (const it of extractItems(buffer)) {
      if (!this.ids.has(it.id) || this.done.has(it.id)) continue;
      if (it.closed) {
        await this.finishItem(it.id, it.text);
      } else if (it.text && it.text !== this.shown.get(it.id)) {
        this.shown.set(it.id, it.text);
        await this.emit({ update: { paragraph_id: it.id, text: it.text, final: false } });
      }
    }
  }

  /** The output is complete. */
  async complete(fullText: string): Promise<void> {
    const parsed = parseItems(fullText);
    for (const id of this.ids) {
      if (this.done.has(id)) continue;
      const text = parsed.get(id);
      if (text !== undefined) await this.finishItem(id, text);
      else await this.emit({ failed: { paragraph_id: id, status: { code: 'engine_error', message: 'missing from model output' } } });
    }
  }

  /** Structured output already parsed into items. */
  async completeItems(items: Array<{ id: number; text: string }>): Promise<void> {
    await this.complete(JSON.stringify({ items }));
  }

  private async finishItem(id: number, text: string): Promise<void> {
    this.done.add(id);
    const last = this.shown.get(id);
    this.shown.set(id, text);
    await this.emit({ update: { paragraph_id: id, text: last === text ? undefined : text, final: true } });
  }
}

/** Map an HTTP failure of an AI API to the two failure classes (spec 09 section 15). */
export function httpError(status: number, body: string, retryAfter?: string | null): RpcError {
  const snippet = body.slice(0, 200);
  if (status === 429) {
    const secs = retryAfter ? Number(retryAfter) : NaN;
    return new RpcError('rate_limited', snippet, Number.isFinite(secs) ? secs * 1000 : undefined);
  }
  if (status === 401 || status === 403) return new RpcError('permission_denied', snippet);
  if (status === 402) return new RpcError('quota_exceeded', snippet);
  if (status === 503 || status === 502 || status === 504 || status === 529) return new RpcError('unavailable', snippet);
  return new RpcError('engine_error', `HTTP ${status}: ${snippet}`);
}

/** Iterate the `data:` payloads of a server-sent-events response body. */
export async function* sseData(body: ReadableStream<Uint8Array>): AsyncGenerator<string> {
  const decoder = new TextDecoder();
  let buf = '';
  for await (const chunk of body as unknown as AsyncIterable<Uint8Array>) {
    buf += decoder.decode(chunk, { stream: true });
    let i: number;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i).replace(/\r$/, '');
      buf = buf.slice(i + 1);
      if (line.startsWith('data:')) yield line.slice(5).trimStart();
    }
  }
}
