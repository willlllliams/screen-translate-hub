// Execution plan: the workflow frozen and resolved at run start (spec 04 section 2.2).
import type { CaptureRange, ServiceManifest } from '@sth/model';

export interface RunParams {
  batchDeadlineMs: number;
  fullReocrRatio: number;
  adjacencyPx: number;
  ocrMarginPx: number;
  cacheCapacity: number;
  intervalMs: number;
  tolerance: number;
  tile: number;
}

export const DEFAULT_RUN_PARAMS: RunParams = {
  batchDeadlineMs: 20_000,
  fullReocrRatio: 0.5,
  adjacencyPx: 6,
  ocrMarginPx: 8,
  cacheCapacity: 2_000,
  intervalMs: 700,
  tolerance: 8,
  tile: 16,
};

export interface ResolvedService {
  /** Registered name, e.g. translate.claude-cli. */
  name: string;
  endpoint: string;
  manifest: ServiceManifest;
}

export interface SourcePlan {
  node: string;
  rank: number;
  service: ResolvedService;
  mode: 'stream' | 'complete';
  timeoutMs: number;
  retries: number;
  maxUnits: number;
  maxChars: number;
  contextCount: number;
  useGlossary: boolean;
  promptTemplate?: string;
}

export interface RacePlan {
  node: string;
  sourceLanguage: string;
  targetLanguage: string;
  sources: SourcePlan[];
}

export type OutputType = 'overlay' | 'screenshot_card' | 'web_display';

export interface OutputPlan {
  node: string;
  type: OutputType;
}

export interface ExecPlan {
  workflowId: string;
  digest: string;
  entry: 'screenshot' | 'continuous';
  inputNode: string;
  ocr: { node: string; service: ResolvedService; languages: string[]; timeoutMs: number };
  normalize: { node: string; service: ResolvedService };
  race: RacePlan | null;
  outputs: OutputPlan[];
  params: RunParams;
  glossary: Array<{ source: string; target: string; note?: string }>;
  range?: CaptureRange;
}
