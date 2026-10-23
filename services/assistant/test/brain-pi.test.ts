// The pi brain against a scripted OpenAI-compatible server: the model first calls a
// platform tool, then answers. Exercises pi's SDK without an API key.
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { Type } from 'typebox';
import { PiBrain } from '../src/brain-pi.ts';
import type { BrainEvent, PlatformTool } from '../src/types.ts';

let server: Server;
let baseUrl = '';
const requests: Array<{ messages: Array<{ role: string; content: unknown }>; tools?: Array<{ function: { name: string } }> }> = [];
const dir = mkdtempSync(join(tmpdir(), 'sth-pi-test-'));

function sse(chunks: unknown[]): string {
  return chunks.map((c) => `data: ${JSON.stringify(c)}\n\n`).join('') + 'data: [DONE]\n\n';
}

before(async () => {
  server = createServer((req, res) => {
    let body = '';
    req.on('data', (d) => (body += d));
    req.on('end', () => {
      const parsed = JSON.parse(body);
      requests.push(parsed);
      const base = { id: 'c', object: 'chat.completion.chunk', created: 0, model: 'fake-model' };
      const hasToolResult = parsed.messages.some((m: { role: string }) => m.role === 'tool');
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      if (!hasToolResult) {
        res.end(
          sse([
            { ...base, choices: [{ index: 0, delta: { role: 'assistant', tool_calls: [{ index: 0, id: 'call_1', type: 'function', function: { name: 'get_context', arguments: '{}' } }] }, finish_reason: null }] },
            { ...base, choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] },
          ]),
        );
      } else {
        res.end(
          sse([
            { ...base, choices: [{ index: 0, delta: { role: 'assistant', content: 'The total ' }, finish_reason: null }] },
            { ...base, choices: [{ index: 0, delta: { content: 'looks right.' }, finish_reason: null }] },
            { ...base, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] },
          ]),
        );
      }
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`;
});

after(() => {
  server.close();
  rmSync(dir, { recursive: true, force: true });
});

test('pi brain: platform tools only, tool call then a streamed answer', async () => {
  let called = 0;
  const tools: PlatformTool[] = [
    {
      name: 'get_context',
      label: 'Context',
      description: 'The task and active window',
      parameters: Type.Object({}),
      async execute() {
        called++;
        return { text: JSON.stringify({ task: 'check the totals', active_app: 'excel' }) };
      },
    },
  ];
  const brain = new PiBrain({ provider: 'custom', model: 'fake-model', base_url: baseUrl, api_key: 'test', dir });
  await brain.open('check the totals', tools);
  const events: BrainEvent[] = [];
  for await (const e of brain.wake({ kind: 'user_message', text: 'is the total right?' }, new AbortController().signal)) events.push(e);
  await brain.close();

  assert.equal(called, 1);
  // only our tool is offered: none of pi's read/bash/edit/write
  assert.deepEqual(requests[0].tools?.map((t) => t.function.name), ['get_context']);
  assert.ok(requests[0].messages.some((m) => m.role === 'system' && String(m.content).includes('check the totals')));
  const text = events.filter((e) => e.type === 'text_delta').map((e) => (e as { delta: string }).delta).join('');
  assert.equal(text, 'The total looks right.');
  assert.deepEqual(
    events.filter((e) => e.type === 'tool').map((e) => `${(e as { name: string }).name}:${(e as { phase: string }).phase}`),
    ['get_context:start', 'get_context:end'],
  );
  assert.deepEqual(events.at(-1), { type: 'turn_end', stop: 'done' });
});
