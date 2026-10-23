// Live check of the Bergamot source: download Firefox's model and engine, translate.
//   node tools/dev/try-bergamot.ts [from] [to]
import { BergamotEngine } from '../../services/translate/src/bergamot.ts';

const [from = 'en', to = 'zh-Hans'] = process.argv.slice(2);
const texts =
  from === 'en'
    ? [
        'Release notes',
        "We've launched the memory tool in beta, enabling the assistant to store and consult information across conversations.",
        'Context editing automatically clears older tool results when the conversation approaches its token limit.',
        'If the program still does not start, collect the log files from the data folder and send them to the support team.',
      ]
    : from === 'ja'
      ? ['設定', 'プログラムが起動しない場合は、データフォルダーからログファイルを集めてサポートに送ってください。']
      : ['发布说明', '如果程序仍然无法启动，请从数据文件夹中收集日志文件并发送给支持团队。'];

let t0 = performance.now();
const engine = await BergamotEngine.create({});
const m = engine.manifest('translate.bergamot');
console.log(`records loaded in ${Math.round(performance.now() - t0)} ms; ${m.languages?.source?.length ?? 0} source and ${m.languages?.target?.length ?? 0} target languages; route ${JSON.stringify(engine.route(from, to))}`);

t0 = performance.now();
for (const [a, b] of engine.route(from, to) ?? []) await engine.prepare(a, b);
console.log(`model ready (download + load) in ${Math.round(performance.now() - t0)} ms`);

for (let round = 1; round <= 2; round++) {
  t0 = performance.now();
  await engine.translate(
    { segments: texts.map((text, i) => ({ paragraph_id: i + 1, text, language: from })), source_language: from, target_language: to },
    async (r) => {
      if (round === 2) return;
      if ('update' in r) console.log(`  ${r.update.paragraph_id}: ${r.update.text}`);
      else console.log(`  ${r.failed.paragraph_id}: FAILED ${r.failed.status.code} ${r.failed.status.message}`);
    },
    new AbortController().signal,
  );
  console.log(`round ${round}: ${texts.length} paragraphs in ${Math.round(performance.now() - t0)} ms`);
}
await engine.close();
