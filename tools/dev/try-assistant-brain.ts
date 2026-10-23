// Live check of the Claude Code brain: real `claude -p`, the MCP proxy, and a local
// stand-in for the assistant session's tools. Two wakes test that context carries over.
//   node tools/dev/try-assistant-brain.ts [model]
import { listen, ServiceHost } from '@sth/wire';
import { ClaudeCodeBrain } from '../../services/assistant/src/brain-claude.ts';

const TOKEN = 'dev-token';
const tools = [
  {
    name: 'get_context',
    label: 'Context',
    description: "The user's task, the active window and recent wakes.",
    parameters: { type: 'object', properties: {} },
  },
  {
    name: 'annotate',
    label: 'Draw',
    description: 'Draw boxes or arrows on the screen; coordinates in screen pixels.',
    parameters: {
      type: 'object',
      properties: { items: { type: 'array', items: { type: 'object', properties: { kind: { type: 'string' }, rect: { type: 'object' }, text: { type: 'string' } } } } },
      required: ['items'],
    },
  },
];
const host = new ServiceHost().implement('assistant', 'assistant', [1, 0], {
  async ListSessionTools(s) {
    await s.recv();
    await s.send({ tools });
  },
  async CallTool(s) {
    const req = (await s.recv()) as { name: string; args: unknown };
    console.log(`  [tool] ${req.name} ${JSON.stringify(req.args)}`);
    if (req.name === 'get_context') await s.send({ text: JSON.stringify({ task: 'check the invoice total', active_app: 'EXCEL', window_title: 'Invoice 2026-10.xlsx', total_cell: { text: 'Total 1,204.00', rect: { x: 800, y: 600, w: 140, h: 24 } } }) });
    else await s.send({ text: JSON.stringify({ ids: ['a1'] }) });
  },
});
const server = await listen({ token: TOKEN, onConnection: (c) => host.attach(c) });
const brain = new ClaudeCodeBrain({ model: process.argv[2] ?? 'haiku', assistantUrl: server.url, token: TOKEN, sessionId: 'dev' });
await brain.open('check the invoice total', []);

for (const text of ['Where is the total on my screen? Point at it.', 'What number did you point at? Answer in one short sentence.']) {
  console.log(`> ${text}`);
  const t0 = performance.now();
  let out = '';
  for await (const e of brain.wake({ kind: 'user_message', text }, new AbortController().signal)) {
    if (e.type === 'text_delta') out += e.delta;
    else if (e.type === 'tool') console.log(`  (${e.phase} ${e.name}${e.ok === false ? ' failed' : ''})`);
    else if (e.type === 'turn_end') console.log(`  turn_end ${e.stop}${e.error ? `: ${e.error}` : ''} after ${Math.round(performance.now() - t0)} ms`);
  }
  console.log(`< ${out.trim()}`);
}
await brain.close();
await server.close();
