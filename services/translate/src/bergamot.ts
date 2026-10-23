// Bergamot: Firefox's offline translation engine as WebAssembly, with Firefox's own
// models (requirement 09 section 3.3). Models download on first use. A request waits a
// few seconds for the download (other sources race meanwhile anyway); if the model is
// still not there, the source answers `unavailable` with a retry hint (spec 04 section 6.3)
// and the download carries on.
import type { ServiceManifest } from '@sth/model';
import { sameLanguage } from '@sth/model';
import { RpcError } from '@sth/wire';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Worker } from 'node:worker_threads';
import { directions, ModelRegistry, pickModelFiles, pickWasm, type ModelFiles, type RemoteRecord } from './bergamot/registry.ts';
import type { WorkerReply, WorkerRequest } from './bergamot/worker.ts';
import type { Emit, Segment, TranslateEngine, TranslateRequest } from './engine.ts';

export interface BergamotConfig {
  /** Where models and the engine binary are kept; default %APPDATA%\screen-translate-hub\bergamot. */
  dir?: string;
  /** Fetch these directions at start, e.g. the user's target language: [["en", "zh-Hans"]]. */
  prefetch?: Array<[string, string]>;
  /** Shorthand: prefetch English to this language. */
  target_language?: string;
}

const here = dirname(fileURLToPath(import.meta.url));
const GLUE = join(here, '..', 'vendor', 'bergamot', 'bergamot-translator.js');
const RETRY_WHILE_DOWNLOADING_MS = 30_000;
/** How long one request waits for a first-use download before answering unavailable. */
const DOWNLOAD_WAIT_MS = 10_000;

/** Firefox names Chinese by script; plain "zh" means Simplified. */
function firefoxTag(tag: string): string {
  if (tag === 'zh' || tag.startsWith('zh-CN') || tag.startsWith('zh-SG')) return 'zh-Hans';
  if (tag.startsWith('zh-TW') || tag.startsWith('zh-HK') || tag.startsWith('zh-MO')) return 'zh-Hant';
  if (tag.startsWith('zh-Hans') || tag.startsWith('zh-Hant')) return tag.slice(0, 7);
  return tag.split('-')[0];
}

const FULL_WIDTH: Record<string, string> = { ',': '，', ';': '；', ':': '：', '?': '？', '!': '！', '(': '（', ')': '）' };

/** Firefox's Chinese and Japanese models often write ASCII punctuation between CJK characters. */
export function cjkPunctuation(text: string): string {
  return text.replace(/(?<=[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}])[,;:?!]|[(](?=[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}])|(?<=[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}])[)]/gu, (c) => FULL_WIDTH[c]);
}

class EngineWorker {
  private readonly worker: Worker;
  private nextId = 1;
  private readonly pending = new Map<number, { resolve: (r: WorkerReply) => void }>();

  constructor() {
    this.worker = new Worker(new URL('./bergamot/worker.ts', import.meta.url));
    this.worker.on('message', (r: WorkerReply) => {
      this.pending.get(r.id)?.resolve(r);
      this.pending.delete(r.id);
    });
    this.worker.on('error', (err: Error) => {
      for (const p of this.pending.values()) p.resolve({ id: 0, ok: false, error: `worker failed: ${err.message}` });
      this.pending.clear();
    });
  }

  call(req: WorkerRequest extends infer R ? (R extends unknown ? Omit<R, 'id'> : never) : never): Promise<WorkerReply & { ok: true }> {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, {
        resolve: (r) => (r.ok ? resolve(r as WorkerReply & { ok: true }) : reject(new RpcError('engine_error', (r as { error: string }).error))),
      });
      this.worker.postMessage({ ...req, id } as WorkerRequest);
    });
  }

  terminate(): Promise<number> {
    return this.worker.terminate();
  }
}

export class BergamotEngine implements TranslateEngine {
  readonly id = 'bergamot';
  private readonly registry: ModelRegistry;
  private records: RemoteRecord[];
  private readonly pairs: Array<[string, string]>;
  private worker: EngineWorker | null = null;
  private ready: Promise<void> | null = null;
  private readonly loaded = new Map<string, Promise<void>>();

  private constructor(registry: ModelRegistry, records: RemoteRecord[]) {
    this.registry = registry;
    this.records = records;
    this.pairs = directions(records);
  }

  static async create(raw: Record<string, unknown>): Promise<BergamotEngine> {
    const config = raw as BergamotConfig;
    const dir = config.dir ?? join(process.env.APPDATA ?? join(homedir(), '.local', 'share'), 'screen-translate-hub', 'bergamot');
    const registry = new ModelRegistry({ dir });
    let records: RemoteRecord[] = [];
    try {
      records = await registry.records('translations-models');
    } catch {
      // offline with no cache: the manifest lists no languages until a later start
    }
    const engine = new BergamotEngine(registry, records);
    const prefetch = [...(config.prefetch ?? []), ...(config.target_language ? [['en', firefoxTag(config.target_language)] as [string, string]] : [])];
    for (const [from, to] of prefetch) void engine.prepare(from, to).catch(() => undefined);
    return engine;
  }

  manifest(name: string): ServiceManifest {
    const source = new Set<string>(['en']);
    const target = new Set<string>(['en']);
    for (const [from, to] of this.pairs) {
      if (to === 'en') source.add(from);
      if (from === 'en') target.add(to);
    }
    return {
      name,
      display_name: 'Bergamot (offline, Firefox models)',
      interfaces: [{ name: 'translate', major: 1, minor: 0 }],
      engine: { id: 'bergamot', name: 'Bergamot', version: '0.6.0' },
      languages: { source: [...source].sort(), target: [...target].sort(), detects_source: false },
      platform: { os: 'any', arch: 'any', accelerators: ['cpu'] },
      limits: { max_concurrency: 1, requests_per_second: 20, burst: 5, max_units_per_request: 32, max_chars_per_request: 8000 },
      streaming: false,
      metering: 'none',
    };
  }

  /** Directions to run for from -> to: direct, or through English. */
  route(from: string, to: string): Array<[string, string]> | null {
    const has = (a: string, b: string) => this.pairs.some(([x, y]) => x === a && y === b);
    if (has(from, to)) return [[from, to]];
    if (from !== 'en' && to !== 'en' && has(from, 'en') && has('en', to)) return [[from, 'en'], ['en', to]];
    return null;
  }

  private filesFor(from: string, to: string): ModelFiles {
    const files = pickModelFiles(this.records, from, to);
    if (!files) throw new RpcError('invalid_argument', `no model for ${from} to ${to}`);
    return files;
  }

  private engineReady(): Promise<void> {
    this.ready ??= (async () => {
      const wasm = pickWasm(await this.registry.records('translations-wasm'));
      if (!wasm) throw new Error('no compatible Bergamot engine binary');
      const wasmPath = await this.registry.file(wasm);
      this.worker = new EngineWorker();
      await this.worker.call({ type: 'init', gluePath: GLUE, wasmPath });
    })().catch((err) => {
      this.ready = null;
      throw err;
    });
    return this.ready;
  }

  /** Download (if needed) and load one direction. */
  prepare(from: string, to: string): Promise<void> {
    const key = `${from}>${to}`;
    let p = this.loaded.get(key);
    if (!p) {
      p = (async () => {
        const files = this.filesFor(from, to);
        const paths: Record<string, string> = {};
        for (const [type, rec] of Object.entries(files)) paths[type] = await this.registry.file(rec!);
        await this.engineReady();
        await this.worker!.call({ type: 'load', key, from, to, files: paths, int8: files.model!.name.endsWith('intgemm8.bin') });
      })().catch((err) => {
        this.loaded.delete(key);
        throw err;
      });
      this.loaded.set(key, p);
    }
    return p;
  }

  /** Whether a direction can run right now, without waiting for a download. */
  private isLocal(from: string, to: string): boolean {
    const files = pickModelFiles(this.records, from, to);
    return !!files && Object.values(files).every((r) => this.registry.isLocal(r!));
  }

  async translate(req: TranslateRequest, emit: Emit, signal: AbortSignal): Promise<void> {
    const to = firefoxTag(req.target_language);
    const groups = new Map<string, Segment[]>();
    for (const s of req.segments) {
      const from = firefoxTag(s.language ?? req.source_language);
      const g = groups.get(from) ?? [];
      g.push(s);
      groups.set(from, g);
    }
    for (const [from, segs] of groups) {
      if (sameLanguage(from, to)) {
        for (const s of segs) await emit({ update: { paragraph_id: s.paragraph_id, text: s.text, final: true } });
        continue;
      }
      const route = this.route(from, to);
      if (!route) {
        for (const s of segs) await emit({ failed: { paragraph_id: s.paragraph_id, status: { code: 'invalid_argument', message: `Bergamot has no model for ${from} to ${to}` } } });
        continue;
      }
      if (!route.every(([a, b]) => this.isLocal(a, b))) {
        // first use: the download (about 50 MB) usually takes a few seconds; wait that long
        const ready = Promise.all(route.map(([a, b]) => this.prepare(a, b)));
        ready.catch(() => undefined);
        let timer: ReturnType<typeof setTimeout> | undefined;
        const waited = await Promise.race([
          ready.then(
            () => 'ready' as const,
            (err: Error) => {
              throw new RpcError('unavailable', `could not get the ${from} to ${to} model: ${err.message}`, RETRY_WHILE_DOWNLOADING_MS);
            },
          ),
          new Promise<'late'>((r) => (timer = setTimeout(() => r('late'), DOWNLOAD_WAIT_MS))),
          new Promise<'aborted'>((r) => signal.addEventListener('abort', () => r('aborted'), { once: true })),
        ]);
        clearTimeout(timer);
        if (waited === 'aborted') return;
        if (waited === 'late') throw new RpcError('unavailable', `downloading the ${from} to ${to} model`, RETRY_WHILE_DOWNLOADING_MS);
      }
      for (const [a, b] of route) await this.prepare(a, b);
      if (signal.aborted) return;
      const r = await this.worker!.call({ type: 'translate', keys: route.map(([a, b]) => `${a}>${b}`), texts: segs.map((s) => s.text) });
      if (signal.aborted) return;
      const fix = /^(zh|ja)/.test(to) ? cjkPunctuation : (t: string) => t;
      for (let i = 0; i < segs.length; i++) await emit({ update: { paragraph_id: segs[i].paragraph_id, text: fix(r.texts![i]), final: true } });
    }
  }

  async close(): Promise<void> {
    await this.worker?.terminate();
    this.worker = null;
  }
}
