// Freeze the configuration and run the pre-run checks (spec 04 section 2.2,
// spec 03 section 6.3): compile the workflow into an execution plan.
import { supports, type CaptureRange } from '@sth/model';
import { validate, type NodeDef, type WorkflowDoc } from '@sth/workflow';
import { createHash } from 'node:crypto';
import { DEFAULT_RUN_PARAMS, type ExecPlan, type OutputPlan, type ResolvedService, type RunParams, type SourcePlan } from './types.ts';

export class PreflightError extends Error {
  readonly node: string;
  constructor(node: string, problem: string) {
    super(`${node}: ${problem}`);
    this.node = node;
  }
}

export type Resolver = (node: NodeDef, defaultService: string) => Promise<ResolvedService>;

/** Node types the v1 coordinator executes. */
const V1_TYPES = new Set(['screen_input', 'screenshot_input', 'ocr', 'normalize', 'translate', 'race', 'overlay', 'screenshot_card', 'web_display', 'save_history']);

function num(v: unknown, fallback: number): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : fallback;
}

function nodeOf(ref: string): string {
  return ref.slice(0, ref.lastIndexOf('.'));
}

export async function compilePlan(doc: WorkflowDoc, resolve: Resolver, range?: CaptureRange): Promise<ExecPlan> {
  const problems = validate(doc);
  if (problems.length) throw new PreflightError(problems[0].node ?? 'workflow', `rule ${problems[0].rule}: ${problems[0].message}`);
  if (doc.entry !== 'screenshot' && doc.entry !== 'continuous') throw new PreflightError('workflow', `entry ${doc.entry} is not supported by the v1 coordinator`);
  for (const n of doc.nodes) if (!V1_TYPES.has(n.type)) throw new PreflightError(n.id, `node type ${n.type} is not supported in v1`);

  const byId = new Map(doc.nodes.map((n) => [n.id, n]));
  const from = (to: string) => doc.edges.find((e) => e.to === to)?.from;
  const input = doc.nodes.find((n) => n.type === 'screen_input' || n.type === 'screenshot_input')!;
  const ocrNode = doc.nodes.find((n) => n.type === 'ocr');
  const normNode = doc.nodes.find((n) => n.type === 'normalize');
  if (!ocrNode || !normNode) throw new PreflightError('workflow', 'v1 needs an ocr and a normalize node');

  const p = doc.parameters ?? {};
  const sp = (input.params ?? {}) as { trigger?: { interval_ms?: number | null }; tolerance?: number | null; tile?: number | null };
  const params: RunParams = {
    batchDeadlineMs: num(p.batch_deadline_ms, DEFAULT_RUN_PARAMS.batchDeadlineMs),
    fullReocrRatio: num(p.full_reocr_ratio, DEFAULT_RUN_PARAMS.fullReocrRatio),
    adjacencyPx: num(p.adjacency_px, DEFAULT_RUN_PARAMS.adjacencyPx),
    ocrMarginPx: num(p.ocr_margin_px, DEFAULT_RUN_PARAMS.ocrMarginPx),
    cacheCapacity: num(p.cache_capacity, DEFAULT_RUN_PARAMS.cacheCapacity),
    intervalMs: num(sp.trigger?.interval_ms, DEFAULT_RUN_PARAMS.intervalMs),
    tolerance: num(sp.tolerance, DEFAULT_RUN_PARAMS.tolerance),
    tile: num(sp.tile, DEFAULT_RUN_PARAMS.tile),
  };

  const ocrSvc = await resolve(ocrNode, 'bundled.ocr');
  const normSvc = await resolve(normNode, 'normalize');
  const raceNode = doc.nodes.find((n) => n.type === 'race');
  let race: ExecPlan['race'] = null;
  if (raceNode) {
    const rp = raceNode.params as { source_language?: string; target_language?: string; ranking?: string[] };
    const sources: SourcePlan[] = [];
    for (const [i, id] of (rp.ranking ?? []).entries()) {
      const n = byId.get(id)!;
      const svc = await resolve(n, 'bundled.translate');
      const np = n.params as Record<string, unknown>;
      const lim = svc.manifest.limits ?? {};
      const target = rp.target_language ?? 'zh-Hans';
      const declaredTargets = svc.manifest.languages?.target ?? [];
      if (declaredTargets.length && !supports(declaredTargets, target)) throw new PreflightError(id, `does not translate into ${target}`);
      sources.push({
        node: id,
        rank: i + 1,
        service: svc,
        mode: np.mode === 'complete' ? 'complete' : 'stream',
        timeoutMs: num(np.timeout_ms, 15_000),
        retries: num(np.retries, 0),
        maxUnits: num(np.max_units_per_request, lim.max_units_per_request ?? 16),
        maxChars: lim.max_chars_per_request ?? 6_000,
        contextCount: np.context === true ? num(np.context_count, 5) : 0,
        useGlossary: np.use_glossary !== false,
        promptTemplate: typeof np.prompt_template === 'string' ? np.prompt_template : undefined,
      });
    }
    race = { node: raceNode.id, sourceLanguage: rp.source_language ?? 'auto', targetLanguage: rp.target_language ?? 'zh-Hans', sources };
  }

  const outputs: OutputPlan[] = [];
  for (const n of doc.nodes) {
    if (n.type !== 'overlay' && n.type !== 'screenshot_card' && n.type !== 'web_display') continue;
    const src = from(`${n.id}.translation`);
    if (raceNode && src && nodeOf(src) === raceNode.id) outputs.push({ node: n.id, type: n.type });
  }

  return {
    workflowId: doc.workflow_id,
    digest: createHash('sha256').update(JSON.stringify(doc)).digest('hex'),
    entry: doc.entry,
    inputNode: input.id,
    ocr: { node: ocrNode.id, service: ocrSvc, languages: (ocrNode.params.languages as string[]) ?? ['auto'], timeoutMs: num(ocrNode.params.timeout_ms, 30_000) },
    normalize: { node: normNode.id, service: normSvc },
    race,
    outputs,
    params,
    glossary: doc.glossary ?? [],
    range,
  };
}
