import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { ChangeMap, Quad, Unit } from '@sth/model';
import { TranslationCache } from '../src/cache.ts';
import { detectLanguage } from '../src/langid.ts';
import { ServiceQueue } from '../src/queue.ts';
import { matchHeld, mergeRegions, planReuse, type PrevBatch } from '../src/reuse.ts';

const W = 320;
const H = 320;
const T = 16;
const COLS = W / T;
const ROWS = H / T;

function quad(x: number, y: number, w: number, h: number): Quad {
  return [{ x, y }, { x: x + w, y }, { x: x + w, y: y + h }, { x, y: y + h }];
}

function unit(id: number, x: number, y: number, w: number, h: number, text = `text ${id}`): Unit {
  return { paragraph_id: id, order: id, text, origin: 'recognized', direction: 'ltr', lines: [{ block_id: id, text, quad: quad(x, y, w, h) }], bounds: { x, y, w, h } };
}

/** A change map where all tiles match under shift 0, with optional changed tiles and a scrolled band. */
function map(opts: { changed?: Array<[number, number]>; shift?: { dy: number; rows: [number, number] } } = {}): ChangeMap {
  const masks = new Uint8Array(COLS * ROWS).fill(1);
  const shifts = [{ dx: 0, dy: 0 }];
  if (opts.shift) {
    shifts.push({ dx: 0, dy: opts.shift.dy });
    for (let v = opts.shift.rows[0]; v < opts.shift.rows[1]; v++) for (let u = 0; u < COLS; u++) masks[v * COLS + u] = 2;
  }
  for (const [u, v] of opts.changed ?? []) masks[v * COLS + u] = 0;
  let changed = 0;
  for (const m of masks) if (m === 0) changed++;
  return { base_frame_id: 1, frame_id: 2, tile: T, cols: COLS, rows: ROWS, shifts, masks, changed_ratio: changed / masks.length };
}

const params = { fullReocrRatio: 0.5, adjacencyPx: 6, ocrMarginPx: 4 };

function prev(units: Unit[], complete = true): PrevBatch {
  return { batchSeq: 1, width: W, height: H, paragraphs: units.map((u) => ({ unit: u, complete })) };
}

test('unchanged paragraphs are reused in place; nothing to OCR', () => {
  const p = planReuse(prev([unit(1, 32, 32, 100, 16)]), map(), W, H, params, true);
  assert.equal(p.full, false);
  assert.equal(p.reused.length, 1);
  assert.equal(p.reused[0].dx, 0);
  assert.equal(p.regions.length, 0);
});

test('a scrolled paragraph is reused with its shift; the new strip is OCRed', () => {
  // content rows 4..19 scrolled up by 32 px: tiles there match under shift dy = -32
  const m = map({ shift: { dy: -32, rows: [4, 18] }, changed: Array.from({ length: COLS }, (_, u) => [u, 18] as [number, number]) });
  const p = planReuse(prev([unit(1, 32, 128, 100, 16)]), m, W, H, params, true);
  assert.equal(p.reused.length, 1);
  assert.equal(p.reused[0].dy, -32);
  assert.equal(p.reused[0].moved.bounds?.y, 96);
  assert.equal(p.reused[0].moved.reused_from?.paragraph_id, 1);
  assert.ok(p.regions.length >= 1);
});

test('a paragraph next to a change is held and re-OCRed (condition 3)', () => {
  const m = map({ changed: [[9, 2]] }); // tile right next to the paragraph at y 32..48
  const p = planReuse(prev([unit(1, 32, 32, 100, 16)]), m, W, H, params, true);
  assert.equal(p.reused.length, 0);
  assert.equal(p.held.length, 1);
  assert.ok(p.regions.some((r) => r.y <= 32 && r.y + r.h >= 48));
});

test('incomplete races are not reused (condition 4)', () => {
  const p = planReuse(prev([unit(1, 32, 32, 100, 16)], false), map(), W, H, params, true);
  assert.equal(p.reused.length, 0);
  assert.equal(p.held.length, 1);
});

test('full re-OCR when the change is large, OCR was interrupted, or there is no previous batch', () => {
  const big = map({ changed: Array.from({ length: COLS * 12 }, (_, i) => [i % COLS, Math.floor(i / COLS)] as [number, number]) });
  assert.equal(planReuse(prev([unit(1, 32, 32, 100, 16)]), big, W, H, params, true).full, true);
  assert.equal(planReuse(prev([unit(1, 32, 32, 100, 16)]), map(), W, H, params, false).full, true);
  assert.equal(planReuse(null, null, W, H, params, true).full, true);
});

test('regions merge when they touch', () => {
  const r = mergeRegions([{ x: 0, y: 0, w: 10, h: 10 }, { x: 12, y: 0, w: 10, h: 10 }, { x: 200, y: 200, w: 5, h: 5 }], 2, W, H);
  assert.equal(r.length, 2);
});

test('held paragraphs are taken over only by same text, same place, cached', () => {
  const held = [{ unit: unit(7, 32, 32, 100, 16, 'Save'), complete: true }];
  const cache = new TranslationCache(10);
  cache.put('Save', '保存');
  const m = matchHeld(held, [unit(3, 33, 32, 99, 16, 'Save'), unit(4, 200, 200, 50, 16, 'Save')], (t) => cache.has(t));
  assert.deepEqual([...m.entries()], [[3, 7]]);
  assert.equal(matchHeld(held, [unit(3, 33, 32, 99, 16, 'Open')], (t) => cache.has(t)).size, 0);
});

test('cache evicts the least recently hit entry', () => {
  const c = new TranslationCache(2);
  c.put('a', 'A');
  c.put('b', 'B');
  c.get('a');
  c.put('c', 'C');
  assert.equal(c.get('b'), undefined);
  assert.equal(c.get('a'), 'A');
  assert.equal(c.get('你好 世界') ?? c.get('你好世界'), undefined);
  c.put('你好 世界', 'hello');
  assert.equal(c.get('你好世界'), 'hello');
});

test('language identification', () => {
  assert.equal(detectLanguage('这是一个简体中文的句子，我们来看看'), 'zh-Hans');
  assert.equal(detectLanguage('這是一個繁體中文的句子，我們來看看'), 'zh-Hant');
  assert.equal(detectLanguage('これは日本語の文です'), 'ja');
  assert.equal(detectLanguage('한국어 문장입니다'), 'ko');
  assert.equal(detectLanguage('The quick brown fox jumps over the lazy dog and the cat'), 'en');
  assert.equal(detectLanguage('Le chat est sur la table et il dort'), 'fr');
  assert.equal(detectLanguage('12345'), undefined);
});

test('queue honours concurrency and the token bucket', async () => {
  const q = new ServiceQueue({ concurrency: 1, ratePerSec: 1000, burst: 1 });
  const order: number[] = [];
  const r1 = await q.acquire();
  const p2 = q.acquire().then((rel) => {
    order.push(2);
    rel();
  });
  order.push(1);
  r1();
  await p2;
  assert.deepEqual(order, [1, 2]);
  const ac = new AbortController();
  const held = await q.acquire();
  const waiting = q.acquire(ac.signal);
  ac.abort();
  await assert.rejects(waiting);
  held();
});
