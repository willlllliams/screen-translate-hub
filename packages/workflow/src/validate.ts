// Static validation (spec 03 section 6.2). Runs on save and import; a failing
// workflow is still saved, in the "editing" state.
import { ENTRY_INPUT, nodeSpec } from './nodes.ts';
import type { DataType, WorkflowDoc } from './types.ts';

export interface Problem {
  rule: number;
  node?: string;
  edge?: string;
  message: string;
}

const ID_RE = /^[a-z0-9_-]{1,64}$/;

function splitRef(ref: string): [string, string] {
  const i = ref.lastIndexOf('.');
  return i < 0 ? [ref, ''] : [ref.slice(0, i), ref.slice(i + 1)];
}

export function validate(doc: WorkflowDoc): Problem[] {
  const problems: Problem[] = [];
  const nodes = new Map(doc.nodes.map((n) => [n.id, n]));
  const add = (rule: number, message: string, extra: Partial<Problem> = {}) => problems.push({ rule, message, ...extra });

  // 1. ids unique, edges reference existing nodes and ports
  if (nodes.size !== doc.nodes.length) add(1, 'duplicate node ids');
  for (const n of doc.nodes) {
    if (!ID_RE.test(n.id)) add(1, `invalid node id ${n.id}`, { node: n.id });
    if (!nodeSpec(n.type)) add(1, `unknown node type ${n.type}`, { node: n.id });
  }
  const outType = (ref: string): DataType[] | null => {
    const [id, port] = splitRef(ref);
    const n = nodes.get(id);
    if (!n) return null;
    if (n.type === 'switch') return ['Units'];
    return nodeSpec(n.type)?.outputs.find((p) => p.name === port)?.types ?? null;
  };
  const inPort = (ref: string) => {
    const [id, port] = splitRef(ref);
    const n = nodes.get(id);
    return n ? nodeSpec(n.type)?.inputs.find((p) => p.name === port) ?? null : null;
  };
  const incoming = new Map<string, number>();
  for (const e of doc.edges) {
    const key = `${e.from}->${e.to}`;
    const ot = outType(e.from);
    const ip = inPort(e.to);
    if (!ot) add(1, `edge source ${e.from} does not exist`, { edge: key });
    if (!ip) add(1, `edge target ${e.to} does not exist`, { edge: key });
    if (ot && ip && !ot.some((t) => ip.types.includes(t))) add(4, `type mismatch ${ot.join('|')} -> ${ip.types.join('|')}`, { edge: key });
    incoming.set(e.to, (incoming.get(e.to) ?? 0) + 1);
  }
  // 3. at most one edge per input port (except race.sources); required inputs connected
  for (const n of doc.nodes) {
    for (const ip of nodeSpec(n.type)?.inputs ?? []) {
      const c = incoming.get(`${n.id}.${ip.name}`) ?? 0;
      if (c > 1 && !ip.multi) add(3, `${n.id}.${ip.name} has ${c} incoming edges`, { node: n.id });
      if (c === 0 && ip.required) add(3, `${n.id}.${ip.name} is not connected`, { node: n.id });
    }
  }
  // 2. no cycles
  const adj = new Map<string, string[]>();
  for (const e of doc.edges) {
    const a = splitRef(e.from)[0];
    const b = splitRef(e.to)[0];
    adj.set(a, [...(adj.get(a) ?? []), b]);
  }
  const state = new Map<string, 1 | 2>();
  const dfs = (id: string): boolean => {
    if (state.get(id) === 1) return true;
    if (state.get(id) === 2) return false;
    state.set(id, 1);
    for (const nx of adj.get(id) ?? []) if (dfs(nx)) return true;
    state.set(id, 2);
    return false;
  };
  for (const n of doc.nodes) if (dfs(n.id)) {
    add(2, 'the graph has a cycle');
    break;
  }
  // 5. exactly one input node of the entry's type
  const inputs = doc.nodes.filter((n) => nodeSpec(n.type)?.category === 'input');
  if (inputs.length !== 1 || inputs[0].type !== ENTRY_INPUT[doc.entry]) add(5, `entry ${doc.entry} needs exactly one ${ENTRY_INPUT[doc.entry]} node`);
  // 7. coordinator location
  if (doc.coordinator !== 'local' && doc.coordinator !== 'backend') add(7, 'coordinator must be local or backend');
  // 8. overlay and web display only in continuous workflows; one web display; batches from screen input
  const webs = doc.nodes.filter((n) => n.type === 'web_display');
  for (const n of doc.nodes) {
    if ((n.type === 'overlay' || n.type === 'web_display') && doc.entry !== 'continuous') add(8, `${n.type} only in continuous workflows`, { node: n.id });
  }
  if (webs.length > 1) add(8, 'at most one web display');
  for (const w of webs) {
    const e = doc.edges.find((x) => x.to === `${w.id}.batches`);
    if (e && nodes.get(splitRef(e.from)[0])?.type !== 'screen_input') add(8, 'web display batches must come from screen input', { node: w.id });
  }
  // 9-12. races
  const races = doc.nodes.filter((n) => n.type === 'race');
  for (const r of races) {
    if (doc.entry !== 'screenshot' && doc.entry !== 'continuous') add(9, 'race only in screenshot and continuous workflows', { node: r.id });
    const unitsFrom = doc.edges.find((e) => e.to === `${r.id}.units`)?.from;
    const sources = doc.edges.filter((e) => e.to === `${r.id}.sources`).map((e) => splitRef(e.from)[0]);
    for (const s of sources) {
      const su = doc.edges.find((e) => e.to === `${s}.units`)?.from;
      if (su !== unitsFrom) add(10, `source ${s} must take units from the same port as ${r.id}`, { node: s });
      const other = doc.edges.filter((e) => splitRef(e.from)[0] === s && e.to !== `${r.id}.sources`);
      if (other.some((e) => nodes.get(splitRef(e.to)[0])?.type !== 'save_history')) add(12, `${s} feeds ${r.id}; its candidates may only also go to save_history`, { node: s });
    }
    const ranking = (r.params.ranking as string[] | undefined) ?? [];
    const sameSet = ranking.length === sources.length && sources.every((s) => ranking.includes(s)) && new Set(ranking).size === ranking.length;
    if (!sameSet) add(11, `ranking of ${r.id} must list each source exactly once`, { node: r.id });
    if (!r.params.target_language) add(13, `${r.id} needs a target language`, { node: r.id });
  }
  // 13. translate nodes not feeding a race need a language pair
  for (const n of doc.nodes.filter((x) => x.type === 'translate')) {
    const feedsRace = doc.edges.some((e) => splitRef(e.from)[0] === n.id && nodes.get(splitRef(e.to)[0])?.type === 'race');
    if (!feedsRace && !n.params.target_language) add(13, `${n.id} needs a language pair`, { node: n.id });
  }
  // 14. display nodes take translation from the same race
  const displayRaces = new Set(
    doc.edges
      .filter((e) => ['screenshot_card', 'overlay', 'web_display'].includes(nodes.get(splitRef(e.to)[0])?.type ?? '') && splitRef(e.to)[1] === 'translation')
      .map((e) => splitRef(e.from)[0]),
  );
  if (displayRaces.size > 1) add(14, 'all display nodes must show the same race');
  // 16. http request urls
  for (const n of doc.nodes.filter((x) => x.type === 'http_request')) {
    const url = String(n.params.url ?? '');
    if (!/^https?:\/\//.test(url)) add(16, `${n.id} needs a full http(s) url`, { node: n.id });
  }
  return problems;
}
