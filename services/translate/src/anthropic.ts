// Anthropic Messages API.
import type { ServiceManifest } from '@sth/model';
import { RpcError } from '@sth/wire';
import { aiManifest, type Emit, type TranslateEngine, type TranslateRequest } from './engine.ts';
import { buildPrompt } from './prompt.ts';
import { httpError, ItemStreamer, sseData } from './streaming.ts';

export interface AnthropicConfig {
  api_key: string;
  model?: string;
  base_url?: string;
  max_tokens?: number;
}

export class AnthropicEngine implements TranslateEngine {
  readonly id = 'anthropic';
  private readonly cfg: AnthropicConfig;

  constructor(cfg: AnthropicConfig) {
    if (!cfg.api_key) throw new Error('anthropic engine needs api_key');
    this.cfg = cfg;
  }

  private model(): string {
    return this.cfg.model ?? 'claude-haiku-5-5';
  }

  manifest(name: string): ServiceManifest {
    return aiManifest(name, `${this.model()} (Anthropic)`, 'anthropic', {
      max_concurrency: 4,
      requests_per_second: 4,
      burst: 4,
      max_units_per_request: 24,
      max_chars_per_request: 8000,
    });
  }

  async translate(req: TranslateRequest, emit: Emit, signal: AbortSignal): Promise<void> {
    const { system, user } = buildPrompt(req);
    const streaming = req.mode === 'stream';
    let res: Response;
    try {
      res = await fetch(`${(this.cfg.base_url ?? 'https://api.anthropic.com').replace(/\/$/, '')}/v1/messages`, {
        method: 'POST',
        signal,
        headers: {
          'content-type': 'application/json',
          'x-api-key': this.cfg.api_key,
          'anthropic-version': '2023-06-01',
        },
        body: JSON.stringify({
          model: this.model(),
          max_tokens: this.cfg.max_tokens ?? 4096,
          stream: streaming,
          system,
          messages: [{ role: 'user', content: user }],
        }),
      });
    } catch (e) {
      if (signal.aborted) throw new RpcError('cancelled');
      throw new RpcError('unavailable', String(e));
    }
    if (!res.ok) throw httpError(res.status, await res.text(), res.headers.get('retry-after'));
    const streamer = new ItemStreamer(req, emit);
    if (!streaming) {
      const body = (await res.json()) as { content?: Array<{ type: string; text?: string }> };
      await streamer.complete((body.content ?? []).filter((c) => c.type === 'text').map((c) => c.text).join(''));
      return;
    }
    let text = '';
    for await (const data of sseData(res.body!)) {
      try {
        const ev = JSON.parse(data) as { type?: string; delta?: { type?: string; text?: string }; error?: { message?: string } };
        if (ev.type === 'content_block_delta' && ev.delta?.type === 'text_delta' && ev.delta.text) {
          text += ev.delta.text;
          await streamer.progress(text);
        } else if (ev.type === 'error') {
          throw new RpcError('unavailable', ev.error?.message ?? 'stream error');
        }
      } catch (e) {
        if (e instanceof RpcError) throw e;
      }
    }
    await streamer.complete(text);
  }
}
