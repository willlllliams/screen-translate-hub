// Scripted translation source for tests and demos (spec 16 section 2).
import type { ServiceManifest } from '@sth/model';
import { RpcError } from '@sth/wire';
import { setTimeout as sleep } from 'node:timers/promises';
import type { Emit, TranslateEngine, TranslateRequest } from './engine.ts';

export interface MockConfig {
  /** Delay before the first output, ms. */
  latency_ms?: number;
  /** Delay between streamed versions, ms. */
  step_ms?: number;
  /** Prefix put in front of every translation, e.g. "[fast] ". */
  prefix?: string;
  /** Fail the whole request with this status code (whole-source failure). */
  fail_whole?: string;
  /** Paragraph ids (or "all") that fail individually. */
  fail_paragraphs?: number[] | 'all';
  /** Stop streaming without a final version for these paragraphs (stream interrupted). */
  interrupt_paragraphs?: number[];
  /** Languages the mock claims to support; defaults to everything AI engines declare. */
  languages?: string[];
}

export class MockEngine implements TranslateEngine {
  readonly id = 'mock';
  private readonly cfg: MockConfig;

  constructor(cfg: MockConfig = {}) {
    this.cfg = cfg;
  }

  manifest(name: string): ServiceManifest {
    const langs = this.cfg.languages ?? ['en', 'zh-Hans', 'zh-Hant', 'ja', 'ko', 'fr', 'de', 'es', 'ar'];
    return {
      name,
      display_name: `Mock translator ${this.cfg.prefix ?? ''}`.trim(),
      interfaces: [{ name: 'translate', major: 1, minor: 0 }],
      engine: { id: 'mock', name: 'Mock', version: '1' },
      languages: { source: langs, target: langs, detects_source: true },
      platform: { os: 'any', arch: 'any', accelerators: ['cpu'] },
      limits: { max_concurrency: 4, requests_per_second: 50, burst: 10, max_units_per_request: 50, max_chars_per_request: 20000 },
      streaming: true,
      metering: 'none',
    };
  }

  async translate(req: TranslateRequest, emit: Emit, signal: AbortSignal): Promise<void> {
    const c = this.cfg;
    await sleep(c.latency_ms ?? 50, undefined, { signal });
    if (c.fail_whole) throw new RpcError(c.fail_whole as never, 'mock whole failure');
    for (const seg of req.segments) {
      const failAll = c.fail_paragraphs === 'all';
      if (failAll || (Array.isArray(c.fail_paragraphs) && c.fail_paragraphs.includes(seg.paragraph_id))) {
        await emit({ failed: { paragraph_id: seg.paragraph_id, status: { code: 'engine_error', message: 'mock segment failure' } } });
        continue;
      }
      const full = `${c.prefix ?? `[${req.target_language}] `}${seg.text}`;
      if (req.mode === 'stream') {
        const words = full.split(' ');
        for (let i = 1; i <= words.length; i++) {
          if (c.interrupt_paragraphs?.includes(seg.paragraph_id) && i === words.length) break;
          await emit({ update: { paragraph_id: seg.paragraph_id, text: words.slice(0, i).join(' '), final: false } });
          await sleep(c.step_ms ?? 20, undefined, { signal });
        }
        if (!c.interrupt_paragraphs?.includes(seg.paragraph_id)) {
          await emit({ update: { paragraph_id: seg.paragraph_id, final: true } });
        }
      } else {
        await emit({ update: { paragraph_id: seg.paragraph_id, text: full, final: true } });
      }
    }
  }
}
