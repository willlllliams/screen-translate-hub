// Worker thread running Firefox's Bergamot engine (WebAssembly). Translation is
// synchronous and CPU-bound, so it runs here, away from the service's event loop.
// Mirrors toolkit/components/translations/content/translations-engine.worker.js.
import { readFileSync } from 'node:fs';
import { parentPort } from 'node:worker_threads';

export type WorkerRequest =
  | { type: 'init'; id: number; gluePath: string; wasmPath: string }
  | { type: 'load'; id: number; key: string; from: string; to: string; files: Record<string, string>; int8: boolean }
  | { type: 'translate'; id: number; keys: string[]; texts: string[] };

export type WorkerReply = { id: number; ok: true; texts?: string[]; ms?: number } | { id: number; ok: false; error: string };

type Bergamot = any;

const ALIGNMENT: Record<string, number> = { model: 256, lex: 64, vocab: 64, srcvocab: 64, trgvocab: 64 };

let bergamot: Bergamot | null = null;
let service: Bergamot | null = null;
const models = new Map<string, Bergamot>();

function config(int8: boolean): string {
  const c: Record<string, string> = {
    'beam-size': '1',
    normalize: '1.0',
    'word-penalty': '0',
    'max-length-break': '128',
    'mini-batch-words': '1024',
    workspace: '128',
    'max-length-factor': '2.0',
    'skip-cost': 'true',
    'cpu-threads': '0',
    quiet: 'true',
    'quiet-translation': 'true',
    'gemm-precision': int8 ? 'int8shiftAll' : 'int8shiftAlphaAll',
    alignment: 'soft',
  };
  // Marian's config parser needs this exact layout
  const indent = '            ';
  return `\n${Object.entries(c).map(([k, v]) => `${indent}${k}: ${v}\n`).join('')}${indent}`;
}

function init(gluePath: string, wasmPath: string): Promise<void> {
  const loadBergamot = new Function(`${readFileSync(gluePath, 'utf8')}\nreturn loadBergamot;`)() as (m: object) => Bergamot;
  const wasmBinary = readFileSync(wasmPath);
  return new Promise((resolve, reject) => {
    const b = loadBergamot({
      INITIAL_MEMORY: 41_943_040,
      print: () => undefined,
      printErr: () => undefined,
      onAbort: () => reject(new Error('Bergamot wasm module aborted')),
      onRuntimeInitialized: async () => {
        await Promise.resolve();
        bergamot = b;
        service = new b.BlockingService({ cacheSize: 0 });
        resolve();
      },
      wasmBinary,
    });
  });
}

function load(key: string, from: string, to: string, files: Record<string, string>, int8: boolean): void {
  const b = bergamot;
  if (!b) throw new Error('engine not initialized');
  const mem: Record<string, Bergamot> = {};
  for (const [type, path] of Object.entries(files)) {
    const bytes = readFileSync(path);
    const m = new b.AlignedMemory(bytes.byteLength, ALIGNMENT[type] ?? 64);
    m.getByteArrayView().set(bytes);
    mem[type] = m;
  }
  const vocabs = new b.AlignedMemoryList();
  if (mem.vocab) vocabs.push_back(mem.vocab);
  else {
    vocabs.push_back(mem.srcvocab);
    vocabs.push_back(mem.trgvocab);
  }
  models.set(key, new b.TranslationModel(from, to, config(int8), mem.model, mem.lex ?? null, vocabs, null));
}

function translate(keys: string[], texts: string[]): string[] {
  const b = bergamot;
  if (!b || !service) throw new Error('engine not initialized');
  const ms = keys.map((k) => {
    const m = models.get(k);
    if (!m) throw new Error(`model ${k} not loaded`);
    return m;
  });
  const messages = new b.VectorString();
  const options = new b.VectorResponseOptions();
  for (const t of texts) {
    messages.push_back(t);
    options.push_back({ qualityScores: false, alignment: false, html: false });
  }
  let responses: Bergamot = null;
  try {
    responses = ms.length === 1 ? service.translate(ms[0], messages, options) : service.translateViaPivoting(ms[0], ms[1], messages, options);
    const out: string[] = [];
    for (let i = 0; i < responses.size(); i++) out.push(responses.get(i).getTranslatedText());
    return out;
  } finally {
    messages.delete();
    options.delete();
    responses?.delete();
  }
}

parentPort!.on('message', async (req: WorkerRequest) => {
  try {
    if (req.type === 'init') {
      await init(req.gluePath, req.wasmPath);
      parentPort!.postMessage({ id: req.id, ok: true } satisfies WorkerReply);
    } else if (req.type === 'load') {
      if (!models.has(req.key)) load(req.key, req.from, req.to, req.files, req.int8);
      parentPort!.postMessage({ id: req.id, ok: true } satisfies WorkerReply);
    } else {
      const t0 = performance.now();
      const texts = translate(req.keys, req.texts);
      parentPort!.postMessage({ id: req.id, ok: true, texts, ms: performance.now() - t0 } satisfies WorkerReply);
    }
  } catch (err) {
    parentPort!.postMessage({ id: req.id, ok: false, error: err instanceof Error ? err.message : String(err) } satisfies WorkerReply);
  }
});
