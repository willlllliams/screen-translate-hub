import assert from 'node:assert/strict';
import { test } from 'node:test';
import { addSource, continuousTemplate, screenshotTemplate, validate } from '../src/index.ts';

test('default templates pass static validation', () => {
  assert.deepEqual(validate(screenshotTemplate('zh-Hans')), []);
  assert.deepEqual(validate(continuousTemplate('zh-Hans')), []);
});

test('adding a preferred source keeps the workflow valid', () => {
  const doc = addSource(continuousTemplate('zh-Hans'), 'translate_ai', 'translate.claude-cli', 1, { mode: 'stream' });
  assert.deepEqual(validate(doc), []);
  const race = doc.nodes.find((n) => n.id === 'race')!;
  assert.deepEqual(race.params.ranking, ['translate_ai', 'translate_local']);
});

test('broken workflows are reported with rule numbers', () => {
  const doc = continuousTemplate('zh-Hans');
  doc.nodes.find((n) => n.id === 'race')!.params.ranking = ['nope'];
  doc.edges.push({ from: 'ocr.result', to: 'race.units' });
  doc.edges.push({ from: 'race.translation', to: 'ocr.image' });
  const rules = new Set(validate(doc).map((p) => p.rule));
  assert.ok(rules.has(11));
  assert.ok(rules.has(3));
  assert.ok(rules.has(2));
  assert.ok(rules.has(4));
});
