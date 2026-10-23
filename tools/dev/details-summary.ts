// Summarize run details (ctl.ts details) per batch: event kinds and counts.
//   node tools/dev/ctl.ts details > details.json; node tools/dev/details-summary.ts details.json
import { readFileSync } from 'node:fs';

const raw = readFileSync(process.argv[2], 'utf8');
const d = JSON.parse(raw.slice(raw.indexOf('{'))) as { events: Array<{ kind: string; batch_seq?: number; reason?: string }> };
const batches = new Map<number, Map<string, number>>();
const reasons: string[] = [];
for (const e of d.events) {
  const b = e.batch_seq ?? 0;
  const m = batches.get(b) ?? new Map<string, number>();
  m.set(e.kind, (m.get(e.kind) ?? 0) + 1);
  batches.set(b, m);
  if (e.kind === 'batch_start') reasons.push(`#${b}: ${e.reason}`);
}
for (const [b, m] of [...batches].sort((x, y) => x[0] - y[0])) console.log(`batch ${b}: ${[...m].map(([k, n]) => `${k}=${n}`).join(' ')}`);
for (const r of reasons) console.log(r);
