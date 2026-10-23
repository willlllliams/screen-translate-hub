// Headless end-to-end run (spec 18 section 16): the real agent core, capture
// (replaying frames), OCR, normalization and coordinator, with recording displays.
//   node tools/dev/e2e.ts [screenshot|continuous|both] [mock|claude]
import { AgentCore, catalog, RecordingDisplays, RunLauncher, type TranslatorConfig } from '@sth/agent-core';
import { addSource, continuousTemplate, screenshotTemplate } from '@sth/workflow';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { bgraOf, renderFrames } from './fixtures.ts';

const root = resolve(import.meta.dirname, '../..');
const which = process.argv[2] ?? 'both';
const translator = process.argv[3] ?? 'mock';
const work = mkdtempSync(join(tmpdir(), 'sth-e2e-'));
const framesDir = join(work, 'frames');
const files = await renderFrames(framesDir);

const translators: TranslatorConfig[] = [{ name: 'translate.mock', engine: 'mock', prefix: '[zh] ', latency_ms: 30 }];
if (translator === 'claude') translators.push({ name: 'translate.claude-cli', engine: 'claude-cli', model: 'haiku', warm: 2 });

const agent = new AgentCore({
  logDir: join(work, 'logs'),
  aliases: { 'bundled.ocr': 'ocr.rapidocr', 'bundled.translate': 'translate.mock' },
  hooks: { notify: (kind, text) => console.log(`[notify] ${kind}: ${text}`) },
});
for (const spec of catalog({ root, translators, replay: { dir: framesDir, interval_ms: 1500 } })) agent.define(spec);
const displays = new RecordingDisplays();
displays.install(agent);
await agent.start();
const launcher = new RunLauncher(agent, '00000000-0000-7000-8000-000000000001');
console.log(`agent ${agent.url}, logs in ${join(work, 'logs')}`);

function print(label: string) {
  for (const r of displays.streams) {
    if (process.env.STH_E2E_TRACE) {
      for (const e of r.events) {
        const ev = e.ev;
        if (ev.kind === 'batch_start') console.log(`  [${e.seq}] batch_start ${ev.batch_seq} carried=${ev.carried.map((c) => `${c.from_paragraph_id}->${c.paragraph_id}`).join(',')} held=${ev.held.join(',')}`);
        else if (ev.kind === 'paragraph_add') console.log(`  [${e.seq}] add #${ev.paragraph_id} y=${(ev.bounds.y * 540).toFixed(0)} h=${(ev.bounds.h * 540).toFixed(0)}${ev.takes_over !== undefined ? ` takes_over=${ev.takes_over}` : ''} ${ev.text}`);
        else if (ev.kind === 'held_release') console.log(`  [${e.seq}] held_release ${ev.paragraph_ids.join(',')}`);
      }
    }
    console.log(`\n== ${label}: ${r.kind} display, ${r.events.length} events, gaps ${r.gaps}, batch ${r.state.batch_seq}`);
    for (const p of RecordingDisplays.view(r)) {
      console.log(`  #${p.id} [${p.end ?? '...'}${p.via ? `/${p.via}` : ''}] ${p.text}\n      -> ${p.shown ?? p.error ?? ''}`);
    }
  }
}

let failed = false;
try {
  if (which === 'screenshot' || which === 'both') {
    const img = await bgraOf(files[0]);
    let doc = screenshotTemplate('zh-Hans');
    if (translator === 'claude') doc = addSource(doc, 'translate_ai', 'translate.claude-cli', 1);
    const t0 = performance.now();
    const run = await launcher.start(doc, {
      image: { image: { format: 'raw_bgra8', width: img.width, height: img.height, data: img.data }, captured_at: new Date().toISOString() },
    });
    const st = await run.finished;
    console.log(`screenshot run ${st.state} in ${(performance.now() - t0).toFixed(0)} ms${run.preflight ? ` preflight: ${JSON.stringify(run.preflight)}` : ''}`);
    await sleep(200);
    print('screenshot');
    if (st.state !== 'completed') failed = true;
  }
  if (which === 'continuous' || which === 'both') {
    displays.streams.length = 0;
    let doc = continuousTemplate('zh-Hans');
    if (translator === 'claude') doc = addSource(doc, 'translate_ai', 'translate.claude-cli', 1);
    const run = await launcher.start(doc, { continuous_range: { display_id: 'replay' } });
    run.onStatus((s) => console.log(`[status] ${s.state}${s.reason ? ` (${s.reason})` : ''}`));
    await sleep(9000);
    await run.stop();
    const st = await run.finished;
    print('continuous');
    const details = (await launcher.details(run.id)) as { events: Array<{ kind: string; batch_seq?: number; reason?: string }> };
    for (const e of details.events.filter((x) => ['batch_start', 'ocr_failed', 'cache_hit', 'run_error'].includes(x.kind))) {
      console.log(`  detail ${e.kind} batch ${e.batch_seq ?? '-'} ${e.reason ?? ''}`);
    }
    if (st.state !== 'stopped') failed = true;
  }
} catch (e) {
  console.error(e);
  failed = true;
} finally {
  launcher.close();
  await agent.stop();
}
process.exit(failed ? 1 : 0);
