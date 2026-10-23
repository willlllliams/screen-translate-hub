import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { setTimeout as sleep } from 'node:timers/promises';
import { connect, listen, Peer, RpcError, ServiceHost, type Connection, type WireServer } from '../src/index.ts';

const TOKEN = 'test-token-0123456789';
let server: WireServer;
let conn: Connection;
let peer: Peer;
const cancelled: string[] = [];

before(async () => {
  const host = new ServiceHost();
  host.implement('echo', 'echo', [1, 2], {
    async Unary(s) {
      const req = (await s.recv()) as { text: string };
      await s.send({ text: req.text.toUpperCase() });
    },
    async Count(s) {
      const req = (await s.recv()) as { n: number };
      for (let i = 1; i <= req.n; i++) await s.send(i);
    },
    async Sum(s) {
      let sum = 0;
      for await (const v of s) sum += v as number;
      await s.send(sum);
    },
    async Slow(s) {
      await s.recv();
      await new Promise<void>((resolve) => {
        s.signal.addEventListener('abort', () => {
          cancelled.push(String((s.status ?? { code: '?' }).code));
          resolve();
        });
      });
    },
    async Fail(s) {
      await s.recv();
      throw new RpcError('engine_error', 'boom');
    },
  });
  server = await listen({ token: TOKEN, onConnection: (c) => host.attach(c) });
  conn = await connect(server.url, { token: TOKEN, peer: 'test' });
  peer = new Peer(conn, 'echo');
});

after(async () => {
  conn.close();
  await server.close();
});

test('unary call', async () => {
  const r = await peer.unary<{ text: string }, { text: string }>('echo', 'Unary', { text: 'hi' });
  assert.equal(r.text, 'HI');
});

test('server stream beyond the initial credit window', async () => {
  const got: number[] = [];
  for await (const v of peer.serverStream<{ n: number }, number>('echo', 'Count', { n: 100 })) {
    got.push(v);
    if (v % 10 === 0) await sleep(1); // slow consumer
  }
  assert.equal(got.length, 100);
  assert.equal(got[99], 100);
});

test('client stream', async () => {
  const call = await peer.clientStream<number, number>('echo', 'Sum');
  for (let i = 1; i <= 50; i++) await call.send(i);
  assert.equal(await call.finish(), 1275);
});

test('cancel reaches the callee', async () => {
  const s = peer.open<unknown, unknown>('echo', 'Slow');
  await s.send({});
  await sleep(20);
  s.cancel('test');
  await sleep(50);
  assert.ok(cancelled.includes('cancelled'));
});

test('deadline exceeded on both sides', async () => {
  const before = cancelled.length;
  await assert.rejects(
    peer.unary('echo', 'Slow', {}, { deadlineMs: 50 }),
    (e: unknown) => e instanceof RpcError && e.code === 'deadline_exceeded',
  );
  await sleep(50);
  assert.ok(cancelled.length > before);
});

test('error status propagates', async () => {
  await assert.rejects(peer.unary('echo', 'Fail', {}), (e: unknown) => e instanceof RpcError && e.code === 'engine_error');
});

test('version, method and service checks', async () => {
  await assert.rejects(peer.unary('echo', 'Unary', { text: '' }, { version: [2, 0] }), (e: unknown) => (e as RpcError).code === 'incompatible');
  await assert.rejects(peer.unary('echo', 'Unary', { text: '' }, { version: [1, 3] }), (e: unknown) => (e as RpcError).code === 'incompatible');
  await assert.rejects(peer.unary('echo', 'Nope', {}), (e: unknown) => (e as RpcError).code === 'unimplemented');
  await assert.rejects(new Peer(conn, 'missing').unary('echo', 'Unary', {}), (e: unknown) => (e as RpcError).code === 'unavailable');
});

test('wrong token is rejected', async () => {
  await assert.rejects(connect(server.url, { token: 'nope', peer: 'x' }), (e: unknown) => (e as RpcError).code === 'unauthenticated');
});

test('connection loss fails open streams with unavailable', async () => {
  const c2 = await connect(server.url, { token: TOKEN, peer: 'loss' });
  const s = new Peer(c2, 'echo').open<unknown, unknown>('echo', 'Slow');
  await s.send({});
  c2.close();
  const status = await s.done;
  assert.equal(status.code, 'unavailable');
});
