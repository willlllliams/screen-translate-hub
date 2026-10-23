// The viewing page in a real browser engine (Electron, offscreen): it follows its source
// across a viewer restart and across the source going offline and coming back, and the
// list layout honours "Show translation".
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { createRequire } from 'node:module';
import { createServer, type Socket } from 'node:net';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { after, test } from 'node:test';
import { setTimeout as sleep } from 'node:timers/promises';
import type { DisplaySnapshot } from '@sth/model';
import { connect, Peer, type Stream } from '@sth/wire';

const LOCAL_TOKEN = 'local-session-token';
const ACCESS = 'viewer-page-code-5678';
const LABEL = 'primary display';
const children: ChildProcess[] = [];

after(() => {
  for (const c of children) {
    c.stdin?.end();
    c.kill();
  }
});

function freePort(): Promise<number> {
  return new Promise((resolve) => {
    const s = createServer().listen(0, '127.0.0.1', () => {
      const { port } = s.address() as { port: number };
      s.close(() => resolve(port));
    });
  });
}

/** Start the viewer service; resolves with its local endpoint. */
async function startViewer(port: number): Promise<{ proc: ChildProcess; url: string }> {
  const main = join(import.meta.dirname, '..', 'src', 'main.ts');
  const proc = spawn(process.execPath, [main, '--standalone', LOCAL_TOKEN, JSON.stringify({ host: '127.0.0.1', port, access_token: ACCESS })], { stdio: ['pipe', 'pipe', 'pipe'] });
  children.push(proc);
  const url = await new Promise<string>((resolve, reject) => {
    let out = '';
    proc.stdout!.on('data', (d: Buffer) => {
      out += d.toString();
      const line = out.split('\n').find((l) => l.startsWith('ws://'));
      if (line) resolve(line.trim());
    });
    proc.once('exit', (code) => reject(new Error(`viewer exited ${code}`)));
    setTimeout(() => reject(new Error('viewer did not start')), 20_000).unref();
  });
  return { proc, url };
}

function stopViewer(proc: ChildProcess): Promise<void> {
  return new Promise((resolve) => {
    if (proc.exitCode !== null) return resolve();
    proc.once('exit', () => resolve());
    proc.kill();
  });
}

const para = (id: number, text: string, language: string, translation?: string): DisplaySnapshot['paragraphs'][number] => ({
  paragraph: { kind: 'paragraph_add', paragraph_id: id, text, language, direction: 'ltr', quads: [[0.05, 0.1 + id * 0.3, 0.9, 0.1 + id * 0.3, 0.9, 0.3 + id * 0.3, 0.05, 0.3 + id * 0.3]], bounds: { x: 0.05, y: 0.1 + id * 0.3, w: 0.85, h: 0.2 } },
  shown: translation ? { kind: 'paragraph_show', paragraph_id: id, show: 'text', text: translation, source_rank: 1, version: 1, final: true } : undefined,
  end_state: 'complete',
  via: 'race',
});

/** Publish the test source the way the run coordinator does; the source id is the stream id. */
async function publish(url: string, translation: string): Promise<{ local: Peer; pub: Stream<unknown, unknown>; seq: number }> {
  const local = new Peer(await connect(url, { token: LOCAL_TOKEN, peer: 'coordinator' }), 'viewer');
  const pub = local.open<unknown, unknown>('viewer', 'Publish', { deadlineMs: 0 });
  await pub.send({ start: { run_id: 'run-1', stream_id: 'stream-1', device_id: 'dev', range_label: LABEL, target_language: 'zh-Hans' } });
  const data = new Uint8Array(400 * 300 * 4).fill(200);
  await pub.send({ frame: { image_id: 'run-1:1', batch_seq: 1, image: { image: { format: 'raw_bgra8', width: 400, height: 300, data } } } });
  const seq = 5;
  const snap: DisplaySnapshot = {
    stream_id: 'stream-1',
    seq,
    run_id: 'run-1',
    run_state: 'running',
    batch_seq: 1,
    frame: { image_id: 'run-1:1', width: 400, height: 300 },
    paragraphs: [para(0, 'First paragraph of the page.', 'en', translation), para(1, '这一段本来就是中文。', 'zh-Hans')],
    held: [],
    notices: [],
  };
  await pub.send({ snapshot: snap });
  return { local, pub, seq };
}

/** Change the translation of paragraph 0 with a live event. */
async function retranslate(p: { pub: Stream<unknown, unknown>; seq: number }, text: string): Promise<void> {
  p.seq += 1;
  await p.pub.send({ event: { stream_id: 'stream-1', seq: p.seq, run_id: 'run-1', ev: { kind: 'paragraph_show', paragraph_id: 0, show: 'text', text, source_rank: 1, version: p.seq, final: true } } });
}

/** The page in Electron; `eval` runs JavaScript in it. */
async function openPage(base: string): Promise<{ eval: (js: string) => Promise<unknown> }> {
  const server = createServer();
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const electron = createRequire(import.meta.url)('electron') as unknown as string;
  const env: NodeJS.ProcessEnv = { ...process.env, STH_PAGE_URL: `${base}/#k=${ACCESS}`, STH_DRIVER_PORT: String((server.address() as { port: number }).port) };
  delete env.ELECTRON_RUN_AS_NODE;
  children.push(spawn(electron, [join(import.meta.dirname, 'page-driver.cjs')], { env, stdio: 'ignore' }));
  const socket = await new Promise<Socket>((resolve, reject) => {
    server.once('connection', resolve);
    setTimeout(() => reject(new Error('the browser did not start')), 30_000).unref();
  });
  server.close();
  const replies: Array<(r: { value?: unknown; error?: string }) => void> = [];
  createInterface({ input: socket })
    .on('line', (line) => replies.shift()?.(JSON.parse(line) as { value?: unknown; error?: string }))
    .on('error', () => {}); // the socket's errors land here; the browser is closed when the tests end
  let queue = Promise.resolve();
  return {
    eval: (js) => {
      const run = queue.then(async () => {
        const r = await new Promise<{ value?: unknown; error?: string }>((resolve, reject) => {
          replies.push(resolve);
          socket.write(`${JSON.stringify(js)}\n`);
          setTimeout(() => reject(new Error(`no answer from the page: ${js}`)), 10_000).unref();
        });
        if (r.error) throw new Error(r.error);
        return r.value;
      });
      queue = run.then(() => undefined, () => undefined);
      return run;
    },
  };
}

async function until(page: { eval: (js: string) => Promise<unknown> }, js: string, what: string, ms = 15_000): Promise<void> {
  const start = Date.now();
  for (;;) {
    if (await page.eval(js)) return;
    if (Date.now() - start > ms) throw new Error(`page: ${what} (status "${String(await page.eval(TITLE))}")`);
    await sleep(100);
  }
}

const TITLE = `document.getElementById('title').textContent`;
const shows = (text: string, el = 'layer') => `document.getElementById('${el}').innerText.includes(${JSON.stringify(text)})`;
const live = `${TITLE}.endsWith(${JSON.stringify(` · ${LABEL}`)}) && document.getElementById('dot').classList.contains('ok')`;

/** Change the settings sheet like a tap does: the sheet listens for input events. */
const setForm = (selector: string, checked: boolean) =>
  `(() => { const i = document.querySelector(${JSON.stringify(selector)}); i.checked = ${checked}; i.dispatchEvent(new Event('input', { bubbles: true })); return true; })()`;

test('the page follows its source across a viewer restart and a source coming back', async () => {
  const port = await freePort();
  const base = `http://127.0.0.1:${port}`;
  let viewer = await startViewer(port);
  let source = await publish(viewer.url, '第一段译文');
  const page = await openPage(base);
  await until(page, shows('第一段译文'), 'first translation shown');
  await until(page, live, 'connected');

  // the viewer restarts (a crash, or new settings) and the coordinator publishes again
  await stopViewer(viewer.proc);
  await until(page, `${TITLE} === 'Disconnected' || ${TITLE} === 'Reconnecting…'`, 'disconnect noticed');
  viewer = await startViewer(port);
  source = await publish(viewer.url, '重启后的译文');
  await until(page, shows('重启后的译文'), 'snapshot after reconnecting');
  await until(page, live, 'connected again');
  await retranslate(source, '重连后继续收到的译文');
  await until(page, shows('重连后继续收到的译文'), 'events after reconnecting');

  // sharing off and on: the source goes offline and comes back under the same id
  await source.local.unary('viewer', 'SetSharing', { enabled: false });
  await until(page, `${TITLE}.endsWith('(offline)')`, 'source offline');
  await source.local.unary('viewer', 'SetSharing', { enabled: true });
  source = await publish(viewer.url, '共享恢复后的译文');
  await until(page, shows('共享恢复后的译文'), 'source back online');
  await retranslate(source, '共享恢复后继续收到的译文');
  await until(page, shows('共享恢复后继续收到的译文'), 'events after coming back');
  await until(page, live, 'connected after coming back');
});

test('the list layout honours "Show translation"', async () => {
  const port = await freePort();
  const viewer = await startViewer(port);
  await publish(viewer.url, '列表里的译文');
  const page = await openPage(`http://127.0.0.1:${port}`);
  await until(page, shows('列表里的译文'), 'translation on the picture');

  await page.eval(`document.getElementById('btnSettings').click()`); // opening the sheet fills it in
  await page.eval(setForm('input[name="layout"][value="list"]', true));
  await until(page, shows('列表里的译文', 'list'), 'translation in the list');
  assert.equal(await page.eval(shows('First paragraph of the page.', 'list')), false); // original folded away
  assert.equal(await page.eval(shows('这一段本来就是中文。', 'list')), false); // nothing to translate: left out

  // translation off: the list reads the original text, as the picture does
  await page.eval(setForm('#sShow', false));
  await until(page, shows('First paragraph of the page.', 'list'), 'originals in the list');
  assert.equal(await page.eval(shows('列表里的译文', 'list')), false);
  assert.equal(await page.eval(shows('这一段本来就是中文。', 'list')), true);

  // controls for the picture only are hidden in the list layout, and back for the picture
  const hidden = (id: string) => `getComputedStyle(document.getElementById('${id}').closest('label')).display === 'none'`;
  assert.equal(await page.eval(hidden('sOpacity')), true);
  assert.equal(await page.eval(hidden('sFrame')), true);
  assert.equal(await page.eval(hidden('sShow')), false);
  await page.eval(setForm('input[name="layout"][value="picture"]', true));
  assert.equal(await page.eval(hidden('sOpacity')), false);
});
