import assert from 'node:assert/strict';
import { test } from 'node:test';
import { RpcError } from '@sth/wire';
import type { TranslateReply, TranslateRequest } from '../src/engine.ts';
import { ClaudeCliEngine } from '../src/claude-cli.ts';
import { MockEngine } from '../src/mock.ts';
import { buildPrompt, extractItems, parseItems } from '../src/prompt.ts';
import { ItemStreamer } from '../src/streaming.ts';

const req: TranslateRequest = {
  segments: [
    { paragraph_id: 3, text: 'Hello world' },
    { paragraph_id: 4, text: 'Second paragraph' },
  ],
  source_language: 'auto',
  target_language: 'zh-Hans',
  glossary: [{ source: 'Claude', target: 'Claude' }],
  mode: 'stream',
};

test('prompt carries target language, glossary and items', () => {
  const { user } = buildPrompt(req);
  assert.match(user, /Simplified Chinese/);
  assert.match(user, /Claude => Claude/);
  assert.match(user, /"id":3/);
});

test('partial JSON extraction for streaming', () => {
  const partial = '{"items":[{"id":3,"text":"你好，世界"},{"id":4,"text":"第二';
  const items = extractItems(partial);
  assert.deepEqual(items, [
    { id: 3, text: '你好，世界', closed: true },
    { id: 4, text: '第二', closed: false },
  ]);
  assert.equal(extractItems('{"items":[{"id":1,"text":"a\\"b')[0].text, 'a"b');
});

test('complete parsing tolerates code fences', () => {
  const m = parseItems('```json\n{"items":[{"id":3,"text":"甲"},{"id":4,"text":"乙"}]}\n```');
  assert.equal(m.get(3), '甲');
  assert.equal(m.get(4), '乙');
});

test('streamer emits growing versions, a final per paragraph, and fails missing items', async () => {
  const out: TranslateReply[] = [];
  const s = new ItemStreamer(req, async (r) => void out.push(r));
  await s.progress('{"items":[{"id":3,"text":"你好');
  await s.progress('{"items":[{"id":3,"text":"你好，世界"');
  await s.complete('{"items":[{"id":3,"text":"你好，世界"}]}');
  assert.deepEqual(out, [
    { update: { paragraph_id: 3, text: '你好', final: false } },
    { update: { paragraph_id: 3, text: '你好，世界', final: true } },
    { failed: { paragraph_id: 4, status: { code: 'engine_error', message: 'missing from model output' } } },
  ]);
});

test('mock engine streams cumulative versions and marks completion', async () => {
  const out: TranslateReply[] = [];
  await new MockEngine({ latency_ms: 1, step_ms: 1, prefix: '' }).translate(
    { ...req, segments: [{ paragraph_id: 1, text: 'a b c' }] },
    async (r) => void out.push(r),
    new AbortController().signal,
  );
  const texts = out.map((r) => ('update' in r ? r.update.text : undefined));
  assert.deepEqual(texts, ['a', 'a b', 'a b c', undefined]);
  assert.equal('update' in out[3] && out[3].update.final, true);
});

test('claude-cli reports itself unavailable at once when claude is missing', async () => {
  const engine = new ClaudeCliEngine({ command: 'sth-no-such-claude', warm: 1 });
  const started = Date.now();
  await assert.rejects(
    engine.translate(req, async () => {}, new AbortController().signal),
    (e: unknown) => e instanceof RpcError && e.code === 'unavailable',
  );
  assert.ok(Date.now() - started < 2000);
  await engine.close();
});
