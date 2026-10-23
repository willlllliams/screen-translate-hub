// OpenAI-compatible chat completions (covers most AI vendors, Ollama, llama-server).
import type { ServiceManifest } from '@sth/model';
import { RpcError } from '@sth/wire';
import { aiManifest, type Emit, type TranslateEngine, type TranslateRequest } from './engine.ts';
import { buildPrompt } from './prompt.ts';
import { httpError, ItemStreamer, sseData } from './streaming.ts';

export interface OpenAiConfig {
  base_url: string;       // e.g. https://api.openai.com/v1
  model: string;
  api_key?: string;
  temperature?: number;
  max_concurrency?: number;
  requests_per_second?: number;
}

export class OpenAiEngine implements TranslateEngine {
  readonly id = 'openai';
  private readonly cfg: OpenAiConfig;

  constructor(cfg: OpenAiConfig) {
    if (!cfg.base_url || !cfg.model) throw new Error('openai engine needs base_url and model');
    this.cfg = cfg;
  }

  manifest(name: string): ServiceManifest {
    return aiManifest(name, `${this.cfg.model} (OpenAI-compatible)`, 'openai', {
      max_concurrency: this.cfg.max_concurrency ?? 4,
      requests_per_second: this.cfg.requests_per_second ?? 4,
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
      res = await fetch(`${this.cfg.base_url.replace(/\/$/, '')}/chat/completions`, {
        method: 'POST',
        signal,
        headers: {
          'content-type': 'application/json',
          ...(this.cfg.api_key ? { authorization: `Bearer ${this.cfg.api_key}` } : {}),
        },
        body: JSON.stringify({
          model: this.cfg.model,
          temperature: this.cfg.temperature ?? 0.2,
          stream: streaming,
          messages: [
            { role: 'system', content: system },
            { role: 'user', content: user },
          ],
        }),
      });
    } catch (e) {
      if (signal.aborted) throw new RpcError('cancelled');
      throw new RpcError('unavailable', String(e));
    }
    if (!res.ok) throw httpError(res.status, await res.text(), res.headers.get('retry-after'));
    const streamer = new ItemStreamer(req, emit);
    if (!streaming) {
      const body = (await res.json()) as { choices?: Array<{ message?: { content?: string } }> };
      await streamer.complete(body.choices?.[0]?.message?.content ?? '');
      return;
    }
    let text = '';
    for await (const data of sseData(res.body!)) {
      if (data === '[DONE]') break;
      try {
        const chunk = JSON.parse(data) as { choices?: Array<{ delta?: { content?: string } }> };
        const delta = chunk.choices?.[0]?.delta?.content;
        if (delta) {
          text += delta;
          await streamer.progress(text);
        }
      } catch {
        // ignore keep-alive or malformed chunks
      }
    }
    await streamer.complete(text);
  }
}
