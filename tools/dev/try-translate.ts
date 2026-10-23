// Live check of a translate engine through the service protocol.
//   node tools/dev/try-translate.ts '{"engine":"claude-cli","model":"haiku"}' stream
import { connect, listen, Peer } from '@sth/wire';
import { createEngine, translateHost } from '../../services/translate/src/main.ts';

const config = JSON.parse(process.argv[2] ?? '{"engine":"mock"}') as Record<string, unknown>;
const mode = (process.argv[3] ?? 'stream') as 'stream' | 'complete';
const token = 'dev';
const engine = await createEngine(config);
if (process.env.STH_DELAY) await new Promise((r) => setTimeout(r, Number(process.env.STH_DELAY)));
const server = await listen({ token, onConnection: (c) => translateHost('translate.dev', engine).attach(c) });
const conn = await connect(server.url, { token, peer: 'dev' });
const peer = new Peer(conn, 'translate.dev');
const t0 = performance.now();
for await (const r of peer.serverStream('translate', 'Translate', {
  segments: [
    { paragraph_id: 1, text: "We've launched Claude Sonnet 4.5, our best model for complex agents and coding." },
    { paragraph_id: 2, text: 'Learn more in our context editing documentation.' },
  ],
  source_language: 'auto',
  target_language: 'zh-Hans',
  mode,
}, { deadlineMs: 60_000 })) {
  console.log(`${(performance.now() - t0).toFixed(0).padStart(6)} ms`, JSON.stringify(r));
}
conn.close();
await server.close();
await engine.close?.();
