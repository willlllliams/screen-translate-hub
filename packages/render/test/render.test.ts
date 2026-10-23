import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { DisplayEvent, DisplayEventBody, ParagraphAddBody } from '@sth/model';
import { applyEvent, emptyState, fitText, fromSnapshot, toSnapshot, wrap, type Measure } from '../src/index.ts';

const measure: Measure = (s, px) => [...s].length * px * 0.5;

function add(id: number, text = `p${id}`): ParagraphAddBody {
  return { kind: 'paragraph_add', paragraph_id: id, text, direction: 'ltr', quads: [[0.1, 0.1, 0.2, 0.1, 0.2, 0.2, 0.1, 0.2]], bounds: { x: 0.1, y: 0.1, w: 0.1, h: 0.1 } };
}

function feed(bodies: DisplayEventBody[]) {
  const s = emptyState('s', 'r');
  bodies.forEach((ev, i) => assert.equal(applyEvent(s, { stream_id: 's', run_id: 'r', seq: i + 1, ev } as DisplayEvent), 'ok'));
  return s;
}

test('carry, hold, take over and release across batches (spec 02 section 10)', () => {
  const s = feed([
    { kind: 'batch_start', batch_seq: 1, carried: [], held: [] },
    add(1),
    add(2),
    add(3),
    { kind: 'paragraph_show', paragraph_id: 1, show: 'text', text: 'one', source_rank: 1, final: true },
    { kind: 'paragraph_show', paragraph_id: 2, show: 'text', text: 'two', source_rank: 1, final: true },
    { kind: 'batch_end', batch_seq: 1, ended_by: 'settled' },
    // batch 2: paragraph 1 scrolled up and carried as 1, paragraph 2 held, paragraph 3 dropped
    { kind: 'batch_start', batch_seq: 2, carried: [{ paragraph_id: 1, from_paragraph_id: 1, dx: 0, dy: -0.05 }], held: [2] },
    { ...add(2, 'p2'), takes_over: 2 },
  ]);
  assert.deepEqual([...s.paragraphs.keys()], [1, 2]);
  assert.ok(Math.abs(s.paragraphs.get(1)!.add.bounds.y - 0.05) < 1e-9);
  assert.equal(s.paragraphs.get(2)!.show?.text, 'two'); // inherited from the held paragraph
  assert.equal(s.held.size, 0);
});

test('snapshot round trip equals event replay', () => {
  const s = feed([
    { kind: 'batch_start', batch_seq: 1, carried: [], held: [] },
    add(1),
    { kind: 'paragraph_show', paragraph_id: 1, show: 'error', error_reason: 'x' },
    { kind: 'notice', notice_id: 'n', notice: 'preferred_unavailable', race_node: 'race', reason: 'down', active: true },
  ]);
  const again = fromSnapshot(toSnapshot(s));
  assert.deepEqual(toSnapshot(again), toSnapshot(s));
});

test('sequence gaps are detected', () => {
  const s = emptyState();
  assert.equal(applyEvent(s, { stream_id: 's', run_id: 'r', seq: 2, ev: { kind: 'run_state', state: 'paused' } }), 'gap');
});

test('wrap breaks CJK anywhere and Latin at spaces', () => {
  assert.deepEqual(wrap('你好世界你好', 10, 20, measure), ['你好世界', '你好']);
  assert.deepEqual(wrap('hello big world', 10, 50, measure), ['hello big', 'world']);
});

test('wrap keeps closing punctuation off the line start and opening off the line end', () => {
  // 5 px per character: 6 characters per 30 px line
  assert.deepEqual(wrap('准备本地缓存。', 10, 30, measure), ['准备本地缓', '存。']);
  assert.deepEqual(wrap('首先点击“开始”按钮。', 10, 40, measure), ['首先点击“开始”', '按钮。']);
  assert.deepEqual(wrap('你好世界（测试）', 10, 25, measure), ['你好世界', '（测试）']);
});

test('fitText: shrink, then borrow space below, then truncate', () => {
  const box = { x: 0, y: 0, w: 100, h: 20 };
  const a = fitText({ text: 'short', box, vertical: false, minPx: 8, maxPx: 18, lineHeight: 1.1, measure });
  assert.equal(a.px, 18);
  assert.equal(a.truncated, false);
  const long = 'a much longer translation that needs more room than the original box offers';
  const b = fitText({ text: long, box, vertical: false, minPx: 8, maxPx: 18, lineHeight: 1.1, measure, area: { w: 300, h: 300 } });
  assert.equal(b.truncated, false);
  assert.ok(b.box.h > 20);
  const c = fitText({ text: long, box, vertical: false, minPx: 8, maxPx: 18, lineHeight: 1.1, measure, area: { w: 100, h: 20 } });
  assert.equal(c.truncated, true);
  assert.ok(c.lines[c.lines.length - 1].endsWith(String.fromCharCode(0x2026)));
});
