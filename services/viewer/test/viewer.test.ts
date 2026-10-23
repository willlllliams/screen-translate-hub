// Viewer service end to end: a publisher like the run coordinator, a browser-like
// subscriber (Origin header, access code), frames over HTTP.
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import type { DisplayEvent, DisplaySnapshot } from '@sth/model';
import { connect, Connection, decodeFrame, encodeFrame, Peer, PROTOCOL_VERSION, SUBPROTOCOL } from '@sth/wire';
import { WebSocket } from 'ws';

const LOCAL_TOKEN = 'local-session-token';
const ACCESS = 'viewer-access-code-1234';
const PORT = 18848 + Math.floor(Math.random() * 500);
const BASE = `http://127.0.0.1:${PORT}`;
let proc: ChildProcess;
let localUrl = '';

before(async () => {
  const main = join(import.meta.dirname, '..', 'src', 'main.ts');
  proc = spawn(process.execPath, [main, '--standalone', LOCAL_TOKEN, JSON.stringify({ host: '127.0.0.1', port: PORT, access_token: ACCESS })], { stdio: ['pipe', 'pipe', 'pipe'] });
  localUrl = await new Promise<string>((resolve, reject) => {
    let out = '';
    let err = '';
    proc.stderr!.on('data', (d: Buffer) => (err += d.toString()));
    proc.stdout!.on('data', (d: Buffer) => {
      out += d.toString();
      const line = out.split('\n').find((l) => l.startsWith('ws://'));
      if (line) resolve(line.trim());
    });
    proc.once('exit', (code) => reject(new Error(`viewer exited ${code}: ${err}`)));
    setTimeout(() => reject(new Error('viewer did not start')), 20_000).unref();
  });
});

after(() => {
  proc.stdin?.end();
  proc.kill();
});

function browserConnect(origin: string | undefined, token: string): Promise<Connection> {
  const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws`, SUBPROTOCOL, origin ? { origin } : {});
  return new Promise((resolve, reject) => {
    let conn: Connection | null = null;
    ws.on('open', () => ws.send(encodeFrame({ t: 'hello', ver: [PROTOCOL_VERSION[0], PROTOCOL_VERSION[1]], kind: 'browser', peer: 'test', token })));
    ws.on('message', (data: Buffer) => {
      const bytes = new Uint8Array(data);
      if (conn) return conn.receive(bytes);
      const f = decodeFrame(bytes);
      if (f.t !== 'ack' || !f.ok) return reject(new Error(f.t === 'ack' ? f.code : 'bad ack'));
      conn = new Connection({ send: (d) => ws.send(d), close: (c, r) => ws.close(c, r) }, true, { kind: 'browser', name: 'test' });
      resolve(conn);
    });
    ws.on('unexpected-response', (_req, res) => reject(new Error(`http ${res.statusCode}`)));
    ws.on('error', reject);
  });
}

function frameImage(w: number, h: number) {
  const data = new Uint8Array(w * h * 4);
  for (let i = 0; i < data.length; i += 4) {
    data[i] = 200; // B
    data[i + 1] = 120;
    data[i + 2] = 40; // R
    data[i + 3] = 255;
  }
  return { image: { format: 'raw_bgra8' as const, width: w, height: h, data } };
}

const snapshot = (seq: number): DisplaySnapshot => ({
  stream_id: 'stream-1',
  seq,
  run_id: 'run-1',
  run_state: 'running',
  batch_seq: 1,
  frame: { image_id: 'run-1:1', width: 640, height: 360 },
  paragraphs: [],
  held: [],
  notices: [],
});

test('publish, list, subscribe, frames, sharing off', async () => {
  // the page needs no code; frames and the socket do
  const page = await fetch(`${BASE}/`);
  assert.equal(page.status, 200);
  assert.match(page.headers.get('content-security-policy') ?? '', /default-src 'self'/);
  assert.equal((await fetch(`${BASE}/app.js`)).status, 200);

  const local = new Peer(await connect(localUrl, { token: LOCAL_TOKEN, peer: 'coordinator' }), 'viewer');
  const pub = local.open<unknown, unknown>('viewer', 'Publish', { deadlineMs: 0 });
  await pub.send({ start: { run_id: 'run-1', stream_id: 'stream-1', device_id: 'dev', range_label: 'primary display', target_language: 'zh-Hans' } });
  await pub.send({ frame: { image_id: 'run-1:1', batch_seq: 1, ...{ image: frameImage(640, 360) } } });
  await pub.send({ snapshot: snapshot(3) });

  // a page on another origin, or no origin at all, is refused before the handshake
  await assert.rejects(browserConnect('http://evil.example', ACCESS), /403/);
  await assert.rejects(browserConnect(undefined, ACCESS), /403/);
  await assert.rejects(browserConnect(BASE, 'wrong-code'), /INVALID_CREDENTIAL/);

  const browser = new Peer(await browserConnect(BASE, ACCESS), 'viewer');
  const sources = browser.serverStream<unknown, { sources: Array<{ source_id: string; range_label: string }> }>('viewer', 'ListSources', {}, { deadlineMs: 0 });
  const first = await sources.next();
  assert.equal(first.value?.sources[0]?.range_label, 'primary display');

  const sub = browser.serverStream<{ source_id: string }, Record<string, unknown>>('viewer', 'Subscribe', { source_id: 'stream-1' }, { deadlineMs: 0 });
  const snap = (await sub.next()).value as { snapshot: DisplaySnapshot };
  assert.equal(snap.snapshot.seq, 3);
  assert.equal(snap.snapshot.frame?.image_id, 'run-1:1'); // coordinator ids are run:batch

  const ev: DisplayEvent = {
    stream_id: 'stream-1',
    seq: 4,
    run_id: 'run-1',
    ev: { kind: 'paragraph_add', paragraph_id: 1, text: 'Hello', direction: 'ltr', quads: [[0.1, 0.1, 0.3, 0.1, 0.3, 0.2, 0.1, 0.2]], bounds: { x: 0.1, y: 0.1, w: 0.2, h: 0.1 } },
  };
  await pub.send({ event: ev });
  const got = (await sub.next()).value as { event: DisplayEvent };
  assert.equal(got.event.seq, 4);

  // frames: access code required, scaled down, never enlarged, WebP by default
  assert.equal((await fetch(`${BASE}/frame/run-1%3A1?w=320`)).status, 401);
  const small = await fetch(`${BASE}/frame/run-1%3A1?w=320&accept=webp,jpeg`, { headers: { authorization: `Bearer ${ACCESS}` } });
  assert.equal(small.status, 200);
  assert.equal(small.headers.get('content-type'), 'image/webp');
  const big = await fetch(`${BASE}/frame/run-1%3A1?w=4000&accept=jpeg`, { headers: { authorization: `Bearer ${ACCESS}` } });
  assert.equal(big.headers.get('content-type'), 'image/jpeg');
  const { default: sharp } = await import('sharp');
  assert.equal((await sharp(Buffer.from(await small.arrayBuffer())).metadata()).width, 320);
  assert.equal((await sharp(Buffer.from(await big.arrayBuffer())).metadata()).width, 640);
  assert.equal((await fetch(`${BASE}/frame/nope?w=320`, { headers: { authorization: `Bearer ${ACCESS}` } })).status, 404);

  // sharing off: the source goes offline at once and its frames are dropped
  await local.unary('viewer', 'SetSharing', { enabled: false });
  assert.deepEqual((await sub.next()).value, { offline: true });
  assert.deepEqual((await sources.next()).value?.sources, []);
  assert.equal((await fetch(`${BASE}/frame/run-1%3A1?w=320`, { headers: { authorization: `Bearer ${ACCESS}` } })).status, 404);

  // while sharing is off a new publication is refused
  const again = local.open<unknown, unknown>('viewer', 'Publish', { deadlineMs: 0 });
  await again.send({ start: { run_id: 'run-2', stream_id: 'stream-2', device_id: 'dev', range_label: 'x', target_language: 'zh-Hans' } });
  assert.equal((await again.done).code, 'permission_denied');
  await sources.return(undefined);
  local.conn.close();
});

test('ten wrong access codes lock the address out, and the page can ask why', async () => {
  assert.deepEqual(await (await fetch(`${BASE}/lockout`)).json(), { retry_after_s: 0 });
  for (let i = 0; i < 10; i++) assert.equal((await fetch(`${BASE}/frame/x?w=320`, { headers: { authorization: 'Bearer wrong' } })).status, 401);
  assert.equal((await fetch(`${BASE}/frame/x?w=320`, { headers: { authorization: `Bearer ${ACCESS}` } })).status, 429);
  await assert.rejects(browserConnect(BASE, ACCESS), /403/);
  const { retry_after_s } = (await (await fetch(`${BASE}/lockout`)).json()) as { retry_after_s: number };
  assert.ok(retry_after_s > 50 && retry_after_s <= 60);
});
