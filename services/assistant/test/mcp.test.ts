// The MCP stdio proxy the Claude Code brain starts: JSON-RPC in, assistant calls out.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { test } from 'node:test';
import { listen, ServiceHost } from '@sth/wire';

test('mcp proxy: initialize, tools/list and tools/call with an image', async () => {
  const calls: unknown[] = [];
  const host = new ServiceHost().implement('assistant', 'assistant', [1, 0], {
    async ListSessionTools(s) {
      const req = (await s.recv()) as { session_id: string };
      assert.equal(req.session_id, 'sess-1');
      await s.send({ tools: [{ name: 'screen_capture', label: 'Look', description: 'Capture the screen', parameters: { type: 'object', properties: {} } }] });
    },
    async CallTool(s) {
      const req = await s.recv();
      calls.push(req);
      await s.send({ text: 'Image 2x2', images: [{ data: 'aGVsbG8=', mimeType: 'image/jpeg' }] });
    },
  });
  const server = await listen({ token: 'tok', onConnection: (c) => host.attach(c) });
  const proc = spawn(process.execPath, [join(import.meta.dirname, '..', 'src', 'mcp.ts')], {
    env: { ...process.env, STH_ASSISTANT_URL: server.url, STH_TOKEN: 'tok', STH_SESSION: 'sess-1' },
    stdio: ['pipe', 'pipe', 'inherit'],
  });
  const replies = new Map<number, Record<string, unknown>>();
  let buf = '';
  const waiters = new Map<number, () => void>();
  proc.stdout.setEncoding('utf8');
  proc.stdout.on('data', (d: string) => {
    buf += d;
    for (let i = buf.indexOf('\n'); i >= 0; i = buf.indexOf('\n')) {
      const m = JSON.parse(buf.slice(0, i)) as { id: number };
      buf = buf.slice(i + 1);
      replies.set(m.id, m);
      waiters.get(m.id)?.();
    }
  });
  const rpc = (id: number, method: string, params?: unknown) =>
    new Promise<Record<string, any>>((resolve) => {
      waiters.set(id, () => resolve(replies.get(id)!));
      proc.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
    });

  const init = await rpc(1, 'initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '1' } });
  assert.equal(init.result.serverInfo.name, 'sth');
  assert.equal(init.result.protocolVersion, '2025-06-18');
  proc.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`);
  const list = await rpc(2, 'tools/list');
  assert.deepEqual(list.result.tools, [{ name: 'screen_capture', description: 'Capture the screen', inputSchema: { type: 'object', properties: {} } }]);
  const call = await rpc(3, 'tools/call', { name: 'screen_capture', arguments: { max_width: 640 } });
  assert.deepEqual(call.result.content, [
    { type: 'text', text: 'Image 2x2' },
    { type: 'image', data: 'aGVsbG8=', mimeType: 'image/jpeg' },
  ]);
  assert.equal(call.result.isError, false);
  assert.deepEqual(calls, [{ session_id: 'sess-1', name: 'screen_capture', args: { max_width: 640 } }]);
  assert.equal((await rpc(4, 'resources/list')).error.code, -32601);

  proc.stdin.end();
  await new Promise((r) => proc.once('exit', r));
  await server.close();
});
