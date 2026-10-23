// Node client against the Python implementation of the same protocol.
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { after, before, test } from 'node:test';
import { connect, Peer, RpcError, type Connection } from '../src/index.ts';

const root = resolve(import.meta.dirname, '../../..');
const python = resolve(root, '.venv/Scripts/python.exe');
const TOKEN = 'interop-token';
const skip = !existsSync(python);

let proc: ChildProcess;
let conn: Connection;
let peer: Peer;

before(async () => {
  if (skip) return;
  proc = spawn(python, ['-X', 'utf8', '-m', 'sth_wire.echo_server', TOKEN], { cwd: resolve(root, 'services/py') });
  const url = await new Promise<string>((ok, fail) => {
    proc.stdout!.once('data', (d: Buffer) => ok(d.toString().trim()));
    proc.once('exit', (c) => fail(new Error(`python exited ${c}`)));
  });
  conn = await connect(url, { token: TOKEN, peer: 'node' });
  peer = new Peer(conn, 'echo');
});

after(() => {
  if (skip) return;
  conn?.close();
  proc.stdin?.end();
  proc.kill();
});

test('unary with binary payload across languages', { skip }, async () => {
  const r = await peer.unary<{ text: string; blob: Uint8Array }, { text: string; blob: Uint8Array }>('echo', 'Unary', {
    text: 'ok',
    blob: new Uint8Array([1, 2, 3]),
  });
  assert.equal(r.text, 'OK');
  assert.deepEqual([...r.blob], [3, 2, 1]);
});

test('server stream with flow control across languages', { skip }, async () => {
  let n = 0;
  for await (const v of peer.serverStream<{ n: number }, number>('echo', 'Count', { n: 200 })) n = v;
  assert.equal(n, 200);
});

test('deadline and errors across languages', { skip }, async () => {
  await assert.rejects(peer.unary('echo', 'Slow', {}, { deadlineMs: 50 }), (e: unknown) => (e as RpcError).code === 'deadline_exceeded');
  await assert.rejects(peer.unary('echo', 'Fail', {}), (e: unknown) => (e as RpcError).code === 'engine_error');
});
