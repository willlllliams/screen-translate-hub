// Firefox's translation models and engine binary from Mozilla Remote Settings
// (requirement 09 section 3.3): which files a language pair needs, downloaded on
// demand, verified by SHA-256 and kept in this app's data directory.
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export const SETTINGS_SERVER = 'https://firefox.settings.services.mozilla.com/v1';
/** Major version of the engine binary the vendored glue (v0.6.0) belongs to. */
export const WASM_MAJOR = 3;

export interface RemoteRecord {
  id: string;
  name: string;
  version: string;
  fileType?: string;
  fromLang?: string;
  toLang?: string;
  filter_expression?: string;
  attachment: { hash: string; size: number; location: string; filename: string };
}

export type ModelFileType = 'model' | 'lex' | 'vocab' | 'srcvocab' | 'trgvocab';
export type ModelFiles = Partial<Record<ModelFileType, RemoteRecord>>;

/**
 * Evaluate the filter expressions used in these collections for a desktop release
 * build: comparisons of env.appinfo.OS and env.channel joined by || or &&.
 * Anything else is treated as not applying.
 */
export function filterApplies(expr: string | undefined, env = { os: 'WINNT', channel: 'release' }): boolean {
  const e = (expr ?? '').trim();
  if (!e) return true;
  const value = (name: string) => (name === 'env.appinfo.OS' ? env.os : name === 'env.channel' ? env.channel : undefined);
  const term = (t: string): boolean | undefined => {
    const m = /^\s*(env\.[\w.]+)\s*(==|!=)\s*'([^']*)'\s*$/.exec(t);
    if (!m) return undefined;
    const v = value(m[1]);
    if (v === undefined) return undefined;
    return m[2] === '==' ? v === m[3] : v !== m[3];
  };
  // || binds weaker than &&
  let any = false;
  for (const disj of e.split('||')) {
    let all = true;
    for (const t of disj.split('&&')) {
      const r = term(t);
      if (r === undefined) return false;
      all &&= r;
    }
    any ||= all;
  }
  return any;
}

/** Release versions only (2.1, not 2.0a1), compared numerically. */
export function parseVersion(v: string): number[] | null {
  return /^\d+(\.\d+)*$/.test(v) ? v.split('.').map(Number) : null;
}

export function compareVersions(a: number[], b: number[]): number {
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const d = (a[i] ?? 0) - (b[i] ?? 0);
    if (d) return d;
  }
  return 0;
}

/** The newest complete file set for one direction: a model, its vocabularies, and the shortlist if any. */
export function pickModelFiles(records: RemoteRecord[], from: string, to: string): ModelFiles | null {
  const byVersion = new Map<string, ModelFiles>();
  for (const r of records) {
    if (r.fromLang !== from || r.toLang !== to || !parseVersion(r.version) || !filterApplies(r.filter_expression)) continue;
    const set = byVersion.get(r.version) ?? {};
    set[r.fileType as ModelFileType] = r;
    byVersion.set(r.version, set);
  }
  const complete = [...byVersion.entries()]
    .filter(([, s]) => s.model && (s.vocab || (s.srcvocab && s.trgvocab)))
    .sort((a, b) => compareVersions(parseVersion(b[0])!, parseVersion(a[0])!));
  return complete[0]?.[1] ?? null;
}

export function pickWasm(records: RemoteRecord[]): RemoteRecord | null {
  return (
    records
      .filter((r) => r.name === 'bergamot-translator' && parseVersion(r.version)?.[0] === WASM_MAJOR && filterApplies(r.filter_expression))
      .sort((a, b) => compareVersions(parseVersion(b.version)!, parseVersion(a.version)!))[0] ?? null
  );
}

/** Directions with a model: [from, to] pairs (most are to or from English). */
export function directions(records: RemoteRecord[]): Array<[string, string]> {
  const seen = new Set<string>();
  const out: Array<[string, string]> = [];
  for (const r of records) {
    if (!r.fromLang || !r.toLang || r.fileType !== 'model') continue;
    const k = `${r.fromLang}>${r.toLang}`;
    if (seen.has(k) || !pickModelFiles(records, r.fromLang, r.toLang)) continue;
    seen.add(k);
    out.push([r.fromLang, r.toLang]);
  }
  return out;
}

export interface RegistryOptions {
  dir: string;
  server?: string;
  fetchImpl?: typeof fetch;
  /** Re-read the record lists after this long; a stale cache is used when offline. */
  maxAgeMs?: number;
}

export class ModelRegistry {
  private readonly o: Required<Omit<RegistryOptions, 'fetchImpl'>> & Pick<RegistryOptions, 'fetchImpl'>;
  private baseUrl: string | null = null;
  private readonly downloads = new Map<string, Promise<string>>();

  constructor(o: RegistryOptions) {
    this.o = { server: SETTINGS_SERVER, maxAgeMs: 24 * 3_600_000, ...o };
    mkdirSync(join(this.o.dir, 'files'), { recursive: true });
  }

  private get fetch(): typeof fetch {
    return this.o.fetchImpl ?? fetch;
  }

  /** Records of a collection, from the cache when fresh or when the server cannot be reached. */
  async records(collection: 'translations-models' | 'translations-wasm'): Promise<RemoteRecord[]> {
    const cache = join(this.o.dir, `${collection}.json`);
    let cached: { at: number; data: RemoteRecord[] } | null = null;
    if (existsSync(cache)) {
      try {
        cached = JSON.parse(readFileSync(cache, 'utf8'));
      } catch {
        cached = null;
      }
    }
    if (cached && Date.now() - cached.at < this.o.maxAgeMs) return cached.data;
    try {
      const res = await this.fetch(`${this.o.server}/buckets/main/collections/${collection}/records`, { signal: AbortSignal.timeout(30_000) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = ((await res.json()) as { data: RemoteRecord[] }).data;
      writeFileSync(cache, JSON.stringify({ at: Date.now(), data }));
      return data;
    } catch (err) {
      if (cached) return cached.data;
      throw err;
    }
  }

  private async attachmentsBase(): Promise<string> {
    if (this.baseUrl) return this.baseUrl;
    const res = await this.fetch(`${this.o.server}/`, { signal: AbortSignal.timeout(30_000) });
    const caps = (await res.json()) as { capabilities?: { attachments?: { base_url?: string } } };
    this.baseUrl = caps.capabilities?.attachments?.base_url ?? 'https://firefox-settings-attachments.cdn.mozilla.net/';
    return this.baseUrl;
  }

  /** Local path of a record's file, downloading and verifying it first if needed. */
  file(r: RemoteRecord): Promise<string> {
    const path = join(this.o.dir, 'files', `${r.attachment.hash.slice(0, 16)}-${r.attachment.filename}`);
    if (existsSync(path)) return Promise.resolve(path);
    let p = this.downloads.get(path);
    if (!p) {
      p = this.download(r, path).finally(() => this.downloads.delete(path));
      this.downloads.set(path, p);
    }
    return p;
  }

  isLocal(r: RemoteRecord): boolean {
    return existsSync(join(this.o.dir, 'files', `${r.attachment.hash.slice(0, 16)}-${r.attachment.filename}`));
  }

  private async download(r: RemoteRecord, path: string): Promise<string> {
    const base = await this.attachmentsBase();
    const res = await this.fetch(new URL(r.attachment.location, base).toString(), { signal: AbortSignal.timeout(10 * 60_000) });
    if (!res.ok) throw new Error(`download ${r.attachment.filename}: HTTP ${res.status}`);
    const data = Buffer.from(await res.arrayBuffer());
    const hash = createHash('sha256').update(data).digest('hex');
    if (hash !== r.attachment.hash) throw new Error(`download ${r.attachment.filename}: checksum mismatch`);
    const tmp = `${path}.part`;
    writeFileSync(tmp, data);
    renameSync(tmp, path);
    return path;
  }
}
