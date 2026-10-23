// Default templates (spec 03 section 8). Every processing node is bound to the
// local machine; the reserved names resolve to this machine's bundled engines.
import type { WorkflowDoc } from './types.ts';

const NULL_PARAMS = {
  batch_deadline_ms: null,
  full_reocr_ratio: null,
  adjacency_px: null,
  ocr_margin_px: null,
  cache_capacity: null,
};

export const TEMPLATE_IDS = {
  screenshot: '01927b3e-5a40-7c1e-9f00-000000000001',
  continuous: '01927b3e-5a40-7c1e-9f00-000000000002',
} as const;

export function screenshotTemplate(targetLanguage: string): WorkflowDoc {
  return {
    format_version: 1,
    workflow_id: TEMPLATE_IDS.screenshot,
    revision: 1,
    name: 'Screenshot translation (default)',
    entry: 'screenshot',
    coordinator: 'local',
    parameters: { ...NULL_PARAMS },
    glossary: [],
    nodes: [
      { id: 'shot', type: 'screenshot_input', params: {} },
      { id: 'ocr', type: 'ocr', binding: { location: 'local', service: 'bundled.ocr' }, params: { languages: ['auto'] } },
      { id: 'normalize', type: 'normalize', params: {} },
      { id: 'translate_local', type: 'translate', binding: { location: 'local', service: 'bundled.translate' }, params: {} },
      { id: 'race', type: 'race', params: { source_language: 'auto', target_language: targetLanguage, ranking: ['translate_local'] } },
      { id: 'card', type: 'screenshot_card', params: {} },
    ],
    edges: [
      { from: 'shot.image', to: 'ocr.image' },
      { from: 'ocr.result', to: 'normalize.result' },
      { from: 'normalize.units', to: 'translate_local.units' },
      { from: 'normalize.units', to: 'race.units' },
      { from: 'translate_local.candidates', to: 'race.sources' },
      { from: 'race.translation', to: 'card.translation' },
      { from: 'shot.image', to: 'card.image' },
    ],
  };
}

export function continuousTemplate(targetLanguage: string): WorkflowDoc {
  return {
    format_version: 1,
    workflow_id: TEMPLATE_IDS.continuous,
    revision: 1,
    name: 'Continuous screen translation (default)',
    entry: 'continuous',
    coordinator: 'local',
    parameters: { ...NULL_PARAMS },
    glossary: [],
    nodes: [
      { id: 'screen', type: 'screen_input', params: { trigger: { interval_ms: null }, tolerance: null, tile: null } },
      { id: 'ocr', type: 'ocr', binding: { location: 'local', service: 'bundled.ocr' }, params: { languages: ['auto'] } },
      { id: 'normalize', type: 'normalize', params: {} },
      { id: 'translate_local', type: 'translate', binding: { location: 'local', service: 'bundled.translate' }, params: {} },
      { id: 'race', type: 'race', params: { source_language: 'auto', target_language: targetLanguage, ranking: ['translate_local'] } },
      { id: 'overlay', type: 'overlay', params: {} },
      { id: 'web', type: 'web_display', params: {} },
    ],
    edges: [
      { from: 'screen.batches', to: 'ocr.image' },
      { from: 'screen.batches', to: 'web.batches' },
      { from: 'ocr.result', to: 'normalize.result' },
      { from: 'normalize.units', to: 'translate_local.units' },
      { from: 'normalize.units', to: 'race.units' },
      { from: 'translate_local.candidates', to: 'race.sources' },
      { from: 'race.translation', to: 'overlay.translation' },
      { from: 'race.translation', to: 'web.translation' },
    ],
  };
}

/** Add a translation source to a race with the given rank (1 = preferred). */
export function addSource(doc: WorkflowDoc, nodeId: string, service: string, rank: number, params: Record<string, unknown> = {}): WorkflowDoc {
  const race = doc.nodes.find((n) => n.type === 'race');
  if (!race) throw new Error('workflow has no race node');
  const unitsFrom = doc.edges.find((e) => e.to === `${race.id}.units`)?.from;
  const ranking = [...((race.params.ranking as string[]) ?? [])];
  ranking.splice(Math.max(0, rank - 1), 0, nodeId);
  return {
    ...doc,
    nodes: [
      ...doc.nodes.map((n) => (n.id === race.id ? { ...n, params: { ...n.params, ranking } } : n)),
      { id: nodeId, type: 'translate', binding: { location: 'local', service }, params },
    ],
    edges: [...doc.edges, { from: unitsFrom!, to: `${nodeId}.units` }, { from: `${nodeId}.candidates`, to: `${race.id}.sources` }],
  };
}
