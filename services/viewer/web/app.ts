// LAN viewing page (spec 13 section 3, spec 07 section 3): picks a source, keeps its
// display state from the snapshot and events, shows the batch frame at this screen's
// width and draws the translations over it with the shared renderer.
import type { DisplayEvent, DisplaySnapshot, FrameRef } from '@sth/model';
import { readingOrder, type OrderItem } from '@sth/normalize/order';
import { applyEvent, defaultSettings, emptyState, fromSnapshot, toSnapshot, type DisplaySettings, type DisplayState, type ParaState } from '@sth/render';
import { DomRenderer } from '@sth/render/dom';
import { connectBrowser, Peer, RpcError, type Connection } from '@sth/wire/browser';

interface SourceInfo {
  source_id: string;
  device_name: string;
  range_label: string;
  target_language: string;
}
type SubscribeReply = { snapshot: DisplaySnapshot } | { event: DisplayEvent } | { offline: true };
interface ViewPrefs {
  fit: 'width' | 'screen';
  /** picture: translations over the screen image; list: translations as text in reading order (small phones). */
  layout: 'picture' | 'list';
}

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;

// ---------------- per-browser preferences (spec 13 section 3.4) ----------------

function load<T extends object>(key: string, base: T): T {
  try {
    const v = localStorage.getItem(key);
    return v ? { ...base, ...(JSON.parse(v) as Partial<T>) } : base;
  } catch {
    return base;
  }
}

function save(key: string, value: unknown): void {
  try {
    localStorage.setItem(key, typeof value === 'string' ? value : JSON.stringify(value));
  } catch {
    // storage unavailable (private mode): preferences last for this visit only
  }
}

const WEB_FONTS = ['PingFang SC', 'Hiragino Sans', 'Noto Sans CJK SC', 'Microsoft YaHei UI', 'Segoe UI', 'Roboto', 'sans-serif'];
let settings: DisplaySettings = load('sth.display', { ...defaultSettings('web'), fonts: WEB_FONTS });
let prefs: ViewPrefs = load<ViewPrefs>('sth.view', { fit: 'width', layout: 'picture' });

function readToken(): string {
  const m = /[#&]k=([^&]+)/.exec(location.hash);
  if (m) {
    const t = decodeURIComponent(m[1]);
    save('sth.token', t);
    history.replaceState(null, '', location.pathname); // keep the code out of the address bar
    return t;
  }
  try {
    return localStorage.getItem('sth.token') ?? '';
  } catch {
    return '';
  }
}

// ---------------- elements ----------------

const dot = $('dot');
const title = $('title');
const sourceSel = $<HTMLSelectElement>('sourceSel');
const empty = $('empty');
const stage = $('stage');
const canvas = $<HTMLCanvasElement>('frame');
const layer = $('layer');
const banner = $('banner');
const list = $('list');
const panel = $('panel');
const settingsSheet = $('settings');
const login = $('login');
const ctx = canvas.getContext('2d')!;
const renderer = new DomRenderer(layer, settings);

// ---------------- display state ----------------

let token = readToken();
let sources: SourceInfo[] = [];
let current: SourceInfo | null = null;
let live: DisplayState = emptyState();
/** "After each batch": the state on screen while the next batch fills in (spec 07 section 3.3). */
let frozen: DisplayState | null = null;
let pendingBitmap: ImageBitmap | null = null;
let shownFrame = { id: '', width: 0 };
let view = { w: 0, h: 0 };
let offline = false;

const shown = () => frozen ?? live;

function setStatus(kind: 'ok' | 'wait' | 'bad', text: string): void {
  dot.className = `dot ${kind === 'ok' ? 'ok' : kind === 'bad' ? 'bad' : ''}`;
  title.textContent = text;
}

function sourceLabel(s: SourceInfo): string {
  return `${s.device_name} · ${s.range_label}`;
}

function layout(): void {
  const ref = shown().frame;
  const hasSource = !!current;
  empty.hidden = hasSource;
  stage.hidden = !hasSource || !ref || prefs.layout === 'list';
  list.hidden = !hasSource || prefs.layout !== 'list';
  if (!ref) return;
  const availW = document.documentElement.clientWidth;
  const availH = window.innerHeight - $('bar').offsetHeight;
  let w = availW;
  let h = (w * ref.height) / ref.width;
  if (prefs.fit === 'screen' && h > availH) {
    h = availH;
    w = (h * ref.width) / ref.height;
  }
  view = { w: Math.round(w), h: Math.round(h) };
  stage.style.width = `${view.w}px`;
  stage.style.height = `${view.h}px`;
}

let drawScheduled = false;
function draw(): void {
  if (drawScheduled) return;
  drawScheduled = true;
  requestAnimationFrame(() => {
    drawScheduled = false;
    layout();
    if (prefs.layout === 'list') {
      renderList();
      return;
    }
    canvas.style.visibility = settings.show_frame ? 'visible' : 'hidden';
    renderer.setSettings(settings);
    renderer.render(shown(), { width: view.w, height: view.h, targetLanguage: current?.target_language });
    banner.hidden = !offline;
    banner.textContent = offline ? 'This source is offline. The last picture stays until another source appears.' : '';
  });
}

// ---------------- list layout ----------------

const listItems = new Map<string, HTMLElement>();
const compact = (s: string) => s.replace(/\s+/g, '');

/** Paragraphs in reading order (the normalizer's XY cut over the paragraph boxes). */
function readingOrdered(s: DisplayState): Array<[string, ParaState]> {
  const ref = s.frame ?? { width: 1000, height: 1000 };
  const items: OrderItem<[string, ParaState]>[] = [
    ...[...s.held.entries()].map(([id, p]) => [`h${id}`, p] as [string, ParaState]),
    ...[...s.paragraphs.entries()].map(([id, p]) => [`p${id}`, p] as [string, ParaState]),
  ].map((e) => {
    const b = e[1].add.bounds;
    const box = { x: b.x * ref.width, y: b.y * ref.height, w: b.w * ref.width, h: b.h * ref.height };
    return { box, dir: e[1].add.direction, glyph: Math.max(1, Math.min(box.h, 40)), ref: e };
  });
  if (items.length === 0) return [];
  return readingOrder(items, 1.2).flat().map((it) => it.ref);
}

function renderList(): void {
  // with translations turned off the list reads the original text, like the picture does
  const originals = !settings.show_translation;
  const keep = new Set<string>();
  const nodes: HTMLElement[] = [];
  for (const [key, p] of readingOrdered(shown())) {
    const show = p.show;
    // nothing to read: same language, no words, or a translation equal to the original
    if (!originals && !show && p.end_state !== undefined) continue;
    if (!originals && show?.show === 'text' && show.final && compact(show.text ?? '') === compact(p.add.text)) continue;
    let el = listItems.get(key);
    if (!el) {
      el = document.createElement('div');
      el.className = 'item';
      el.innerHTML = '<div class="tr"></div><div class="src"></div>';
      el.addEventListener('click', () => el!.classList.toggle('open'));
      listItems.set(key, el);
    }
    const tr = el.firstElementChild as HTMLElement;
    const src = el.lastElementChild as HTMLElement;
    tr.className = `tr${show?.show === 'error' ? ' err' : show ? '' : ' pending'}`;
    tr.textContent = show?.show === 'error' ? `Translation failed: ${show.error_reason ?? ''}` : (show?.text ?? '…');
    src.textContent = p.add.text;
    keep.add(key);
    nodes.push(el);
  }
  for (const k of [...listItems.keys()]) if (!keep.has(k)) listItems.delete(k);
  const head: HTMLElement[] = [];
  if (offline) {
    const g = document.createElement('div');
    g.className = 'gone';
    g.textContent = 'This source is offline.';
    head.push(g);
  }
  list.classList.toggle('originals', originals);
  list.style.setProperty('--scale', String(settings.font_scale));
  list.replaceChildren(...head, ...nodes);
}

// ---------------- frames ----------------

const accept = (() => {
  try {
    const c = document.createElement('canvas');
    c.width = c.height = 1;
    return c.toDataURL('image/webp').startsWith('data:image/webp') ? 'webp,jpeg' : 'jpeg';
  } catch {
    return 'jpeg';
  }
})();

function wantedWidth(ref: FrameRef): number {
  const cssWidth = view.w || document.documentElement.clientWidth;
  return Math.min(ref.width, Math.round(cssWidth * (window.devicePixelRatio || 1)));
}

async function fetchFrame(ref: FrameRef): Promise<ImageBitmap | null> {
  try {
    const res = await fetch(`/frame/${encodeURIComponent(ref.image_id)}?w=${wantedWidth(ref)}&saver=${settings.data_saver ? 1 : 0}&accept=${accept}`, {
      headers: { authorization: `Bearer ${token}` },
    });
    if (!res.ok) return null; // gone: a newer batch replaced it
    return await createImageBitmap(await res.blob());
  } catch {
    return null;
  }
}

function paint(bmp: ImageBitmap, id: string): void {
  canvas.width = bmp.width;
  canvas.height = bmp.height;
  ctx.drawImage(bmp, 0, 0);
  shownFrame = { id, width: bmp.width };
  bmp.close();
}

/** Show the frame of a state; the subscription waits for this, so a slow phone slows the stream (spec 13 section 3.2). */
async function showFrame(ref: FrameRef | undefined): Promise<void> {
  if (!ref) return;
  if (ref.image_id === shownFrame.id && shownFrame.width >= wantedWidth(ref)) return;
  const bmp = await fetchFrame(ref);
  if (bmp) paint(bmp, ref.image_id);
}

// ---------------- subscription ----------------

let peer: Peer | null = null;
let subAbort: AbortController | null = null;
/** Whether `current` has a subscription open on this connection; it ends with the connection or when the source goes offline. */
let subscribed = false;

function resetState(): void {
  live = emptyState();
  frozen = null;
  pendingBitmap?.close();
  pendingBitmap = null;
}

async function onEvent(e: DisplayEvent): Promise<'ok' | 'resync'> {
  const ev = e.ev;
  if (settings.refresh === 'complete' && ev.kind === 'batch_start' && !frozen && live.frame) {
    frozen = fromSnapshot(toSnapshot(live)); // keep showing the previous batch
  }
  const r = applyEvent(live, e);
  if (r === 'gap') return 'resync';
  if (ev.kind === 'batch_start' && ev.frame) {
    if (frozen) {
      pendingBitmap?.close();
      pendingBitmap = await fetchFrame(ev.frame);
    } else {
      await showFrame(ev.frame);
    }
  }
  if (ev.kind === 'batch_end' && frozen) {
    frozen = null;
    if (pendingBitmap && live.frame) paint(pendingBitmap, live.frame.image_id);
    pendingBitmap = null;
  }
  return 'ok';
}

async function subscribe(src: SourceInfo): Promise<void> {
  subAbort?.abort();
  const ctl = new AbortController();
  subAbort = ctl;
  subscribed = true;
  // the same source again (reconnected, or back online): its last picture stays until the snapshot replaces it
  if (current?.source_id !== src.source_id) resetState();
  current = src;
  offline = false;
  setStatus('ok', sourceLabel(src));
  draw();
  try {
    while (!ctl.signal.aborted && peer) {
      let resync = false;
      try {
        for await (const m of peer.serverStream<{ source_id: string }, SubscribeReply>('viewer', 'Subscribe', { source_id: src.source_id }, { deadlineMs: 0, signal: ctl.signal })) {
          if ('offline' in m) {
            offline = true;
            draw();
            return;
          }
          if ('snapshot' in m) {
            live = fromSnapshot(m.snapshot);
            frozen = null;
            await showFrame(live.frame);
          } else if ((await onEvent(m.event)) === 'resync') {
            resync = true;
            break;
          }
          draw();
        }
      } catch {
        return; // cancelled, or the connection is gone (the session loop reconnects)
      }
      if (!resync) return;
    }
  } finally {
    if (subAbort === ctl) subscribed = false;
  }
}

function updateSources(list: SourceInfo[]): void {
  sources = list;
  sourceSel.hidden = list.length < 2;
  sourceSel.replaceChildren(
    ...list.map((s) => {
      const o = document.createElement('option');
      o.value = s.source_id;
      o.textContent = sourceLabel(s);
      return o;
    }),
  );
  const still = current && list.find((s) => s.source_id === current!.source_id);
  if (still) {
    sourceSel.value = still.source_id;
    if (!subscribed) void subscribe(still); // a new connection, or the source is back with the same id
    return;
  }
  if (list.length > 0) {
    sourceSel.value = list[0].source_id;
    void subscribe(list[0]);
  } else if (current) {
    offline = true; // keep the last picture (spec 13 section 3.1)
    setStatus('wait', `${sourceLabel(current)} (offline)`);
    draw();
  } else {
    setStatus('wait', 'No screen shared');
    draw();
  }
}

sourceSel.addEventListener('change', () => {
  const s = sources.find((x) => x.source_id === sourceSel.value);
  if (s) void subscribe(s);
});

// ---------------- connection ----------------

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function session(conn: Connection): Promise<void> {
  peer = new Peer(conn, 'viewer');
  try {
    for await (const m of peer.serverStream<unknown, { sources: SourceInfo[] }>('viewer', 'ListSources', {}, { deadlineMs: 0 })) updateSources(m.sources);
  } finally {
    subAbort?.abort();
    subscribed = false;
    peer = null;
  }
}

async function connectLoop(): Promise<void> {
  const url = `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`;
  for (let attempt = 0; ; attempt++) {
    setStatus('wait', attempt ? 'Reconnecting…' : 'Connecting…');
    try {
      const conn = await connectBrowser(url, token);
      attempt = 0;
      await session(conn).catch(() => undefined);
    } catch (err) {
      if (err instanceof RpcError && err.code === 'unauthenticated') {
        showLogin('That access code was not accepted.');
        return;
      }
      const wait = await lockoutSeconds();
      if (wait > 0) {
        showLogin(`Too many wrong access codes from this device. Try again in ${wait} s.`);
        return;
      }
    }
    setStatus('bad', 'Disconnected');
    await sleep(Math.min(1000 * 2 ** attempt, 10_000));
  }
}

/** Seconds this device is locked out for after too many wrong access codes; 0 if it is not. */
async function lockoutSeconds(): Promise<number> {
  try {
    const res = await fetch('/lockout', { cache: 'no-store' });
    return res.ok ? Number(((await res.json()) as { retry_after_s?: number }).retry_after_s) || 0 : 0;
  } catch {
    return 0;
  }
}

function showLogin(msg = ''): void {
  login.hidden = false;
  empty.hidden = true;
  stage.hidden = true;
  $('loginMsg').textContent = msg;
  setStatus('bad', 'Access code needed');
  const input = $<HTMLInputElement>('tokenInput');
  input.value = '';
  input.focus();
}

$('tokenGo').addEventListener('click', () => {
  const t = $<HTMLInputElement>('tokenInput').value.trim();
  if (!t) return;
  token = t;
  save('sth.token', t);
  login.hidden = true;
  void connectLoop();
});

// ---------------- paragraph panel (spec 13 section 3.3) ----------------

stage.addEventListener('click', (e) => {
  const hit = renderer.hit(e.clientX, e.clientY);
  if (!hit) return;
  $('pSource').textContent = hit.source;
  $('pTransLabel').textContent = hit.error ? 'Translation failed' : 'Translation';
  $('pTrans').textContent = hit.error ?? hit.translation;
  settingsSheet.hidden = true;
  panel.hidden = false;
});
$('pClose').addEventListener('click', () => (panel.hidden = true));
$('pCopy').addEventListener('click', () => {
  const text = `${$('pSource').textContent}\n\n${$('pTrans').textContent}`;
  void navigator.clipboard?.writeText(text).then(
    () => ($('pCopy').textContent = 'Copied'),
    () => ($('pCopy').textContent = 'Copy failed'),
  );
  setTimeout(() => ($('pCopy').textContent = 'Copy'), 1500);
});

// ---------------- settings sheet (spec 13 section 3.4) ----------------

function radios(name: string): HTMLInputElement[] {
  return [...document.querySelectorAll<HTMLInputElement>(`input[name="${name}"]`)];
}

function syncSettingsForm(): void {
  for (const r of radios('mode')) r.checked = r.value === settings.mode;
  for (const r of radios('fit')) r.checked = r.value === prefs.fit;
  for (const r of radios('layout')) r.checked = r.value === prefs.layout;
  for (const r of radios('refresh')) r.checked = r.value === settings.refresh;
  for (const r of document.querySelectorAll<HTMLInputElement>('.seg input')) r.parentElement!.classList.toggle('on', r.checked);
  settingsSheet.classList.toggle('list-layout', prefs.layout === 'list'); // hides the controls that only apply to the picture
  $<HTMLInputElement>('sShow').checked = settings.show_translation;
  $<HTMLInputElement>('sFrame').checked = settings.show_frame;
  $<HTMLInputElement>('sFont').value = String(settings.font_scale);
  $<HTMLInputElement>('sOpacity').value = String(settings.plate_opacity);
  $<HTMLInputElement>('sBright').value = String(settings.brightness);
  $<HTMLInputElement>('sSaver').checked = settings.data_saver;
}

function readSettingsForm(): void {
  const pick = (name: string) => radios(name).find((r) => r.checked)?.value;
  settings = {
    ...settings,
    mode: pick('mode') === 'dim' ? 'dim' : 'plate',
    refresh: pick('refresh') === 'complete' ? 'complete' : 'immediate',
    show_translation: $<HTMLInputElement>('sShow').checked,
    show_frame: $<HTMLInputElement>('sFrame').checked,
    font_scale: Number($<HTMLInputElement>('sFont').value),
    plate_opacity: Number($<HTMLInputElement>('sOpacity').value),
    brightness: Number($<HTMLInputElement>('sBright').value),
    data_saver: $<HTMLInputElement>('sSaver').checked,
  };
  prefs = { fit: pick('fit') === 'screen' ? 'screen' : 'width', layout: pick('layout') === 'list' ? 'list' : 'picture' };
  if (settings.refresh === 'immediate' && frozen) {
    frozen = null;
    void showFrame(live.frame);
  }
  save('sth.display', settings);
  save('sth.view', prefs);
  syncSettingsForm();
  draw();
}

settingsSheet.addEventListener('input', readSettingsForm);
$('btnSettings').addEventListener('click', () => {
  syncSettingsForm();
  panel.hidden = true;
  settingsSheet.hidden = !settingsSheet.hidden;
});
$('sClose').addEventListener('click', () => (settingsSheet.hidden = true));
$('sForget').addEventListener('click', () => {
  try {
    localStorage.removeItem('sth.token');
  } catch {
    // nothing stored
  }
  location.reload();
});

window.addEventListener('resize', () => {
  draw();
  const ref = shown().frame;
  if (ref && !frozen) requestAnimationFrame(() => void showFrame(ref).then(draw)); // sharper frame after rotating or widening
});

// ---------------- start ----------------

/** For tests and bug reports: the state behind what is on screen. */
(window as unknown as { __sth: unknown }).__sth = {
  frame: () => ({ ref: shown().frame, shown: shownFrame, canvas: [canvas.width, canvas.height], view }),
  fetchFrame: async () => {
    const ref = shown().frame;
    if (!ref) return 'no frame ref';
    const res = await fetch(`/frame/${encodeURIComponent(ref.image_id)}?w=${wantedWidth(ref)}&accept=${accept}`, { headers: { authorization: `Bearer ${token}` } });
    return `${res.status} ${res.headers.get('content-type')} ${(await res.blob()).size}`;
  },
};

if (token) void connectLoop();
else showLogin();
