// The translate interface (spec 09 section 13) and the shape every engine implements.
import type { ServiceManifest } from '@sth/model';
import type { Status } from '@sth/wire';

export interface GlossaryItem { source: string; target: string; note?: string }

export interface Segment { paragraph_id: number; text: string; language?: string }

export interface TranslateRequest {
  segments: Segment[];
  source_language: string;
  target_language: string;
  glossary?: GlossaryItem[];
  context?: string[];
  mode?: 'stream' | 'complete';
  prompt_template?: string;
  options?: Record<string, string>;
}

/** Cumulative text for one paragraph. A missing `text` with final=true means "done, keep the last text". */
export interface UpdateMsg { paragraph_id: number; text?: string; final: boolean }
export interface FailedMsg { paragraph_id: number; status: Status }
export type TranslateReply = { update: UpdateMsg } | { failed: FailedMsg };

export type Emit = (reply: TranslateReply) => Promise<void>;

export interface TranslateEngine {
  readonly id: string;
  manifest(name: string): ServiceManifest;
  /** Emit updates per paragraph; throw RpcError for whole-request failures (e.g. rate_limited). */
  translate(req: TranslateRequest, emit: Emit, signal: AbortSignal): Promise<void>;
  close?(): Promise<void>;
}

/** Languages AI engines are declared to handle; they also detect the source themselves. */
export const AI_LANGUAGES = [
  'en', 'zh-Hans', 'zh-Hant', 'ja', 'ko', 'fr', 'de', 'es', 'it', 'pt', 'ru', 'ar', 'vi', 'th', 'id', 'tr', 'pl', 'nl', 'uk', 'hi',
];

export function aiManifest(name: string, displayName: string, engine: string, limits: ServiceManifest['limits']): ServiceManifest {
  return {
    name,
    display_name: displayName,
    interfaces: [{ name: 'translate', major: 1, minor: 0 }],
    engine: { id: engine, name: displayName, version: '1' },
    languages: { source: AI_LANGUAGES, target: AI_LANGUAGES, detects_source: true },
    platform: { os: 'any', arch: 'any', accelerators: ['remote'] },
    limits,
    streaming: true,
    metering: 'calls',
  };
}
