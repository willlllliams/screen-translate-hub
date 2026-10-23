// MCP server over stdio for the Claude Code brain (spec 17 section 5.2). Claude Code
// starts it; it forwards tools/list and tools/call to the assistant session that owns
// the tools (assistant.ListSessionTools, assistant.CallTool on the local endpoint).
// Environment: STH_ASSISTANT_URL, STH_TOKEN, STH_SESSION.
import { connect, Peer } from '@sth/wire';
import type { ToolResult } from './types.ts';

interface RpcMessage {
  jsonrpc: '2.0';
  id?: number | string | null;
  method?: string;
  params?: Record<string, unknown>;
}

const url = process.env.STH_ASSISTANT_URL ?? '';
const token = process.env.STH_TOKEN ?? '';
const session = process.env.STH_SESSION ?? '';

let peer: Promise<Peer> | null = null;
function assistant(): Promise<Peer> {
  peer ??= connect(url, { token, peer: 'mcp' }).then((c) => new Peer(c, 'assistant'));
  return peer;
}

function reply(id: RpcMessage['id'], result: unknown): void {
  process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id, result })}\n`);
}

function fail(id: RpcMessage['id'], code: number, message: string): void {
  process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id, error: { code, message } })}\n`);
}

async function handle(m: RpcMessage): Promise<void> {
  if (m.id === undefined) return; // notifications need no answer
  try {
    switch (m.method) {
      case 'initialize':
        reply(m.id, {
          protocolVersion: (m.params?.protocolVersion as string) ?? '2025-06-18',
          capabilities: { tools: {} },
          serverInfo: { name: 'sth', version: '1.0.0' },
        });
        return;
      case 'ping':
        reply(m.id, {});
        return;
      case 'tools/list': {
        const p = await assistant();
        const r = await p.unary<unknown, { tools: Array<{ name: string; description: string; parameters: unknown }> }>('assistant', 'ListSessionTools', { session_id: session });
        reply(m.id, { tools: r.tools.map((t) => ({ name: t.name, description: t.description, inputSchema: t.parameters })) });
        return;
      }
      case 'tools/call': {
        const p = await assistant();
        const r = await p.unary<unknown, ToolResult>(
          'assistant',
          'CallTool',
          { session_id: session, name: m.params?.name, args: m.params?.arguments ?? {} },
          { deadlineMs: 120_000 },
        );
        reply(m.id, {
          content: [{ type: 'text', text: r.text }, ...(r.images ?? []).map((i) => ({ type: 'image', data: i.data, mimeType: i.mimeType }))],
          isError: !!r.isError,
        });
        return;
      }
      default:
        fail(m.id, -32601, `method not found: ${m.method}`);
    }
  } catch (err) {
    if (m.method === 'tools/call') reply(m.id, { content: [{ type: 'text', text: `tool failed: ${(err as Error).message}` }], isError: true });
    else fail(m.id, -32603, (err as Error).message);
  }
}

let buffer = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk: string) => {
  buffer += chunk;
  for (let i = buffer.indexOf('\n'); i >= 0; i = buffer.indexOf('\n')) {
    const line = buffer.slice(0, i).trim();
    buffer = buffer.slice(i + 1);
    if (!line) continue;
    try {
      void handle(JSON.parse(line) as RpcMessage);
    } catch {
      fail(null, -32700, 'parse error');
    }
  }
});
process.stdin.on('end', () => process.exit(0));
