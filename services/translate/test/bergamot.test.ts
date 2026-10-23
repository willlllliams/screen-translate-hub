import assert from 'node:assert/strict';
import { test } from 'node:test';
import { cjkPunctuation } from '../src/bergamot.ts';
import { directions, filterApplies, pickModelFiles, pickWasm, type RemoteRecord } from '../src/bergamot/registry.ts';

let n = 0;
function rec(name: string, version: string, from?: string, to?: string, fileType?: string, filter = ''): RemoteRecord {
  n++;
  return { id: `r${n}`, name, version, fromLang: from, toLang: to, fileType, filter_expression: filter, attachment: { hash: `${n}`.padStart(64, '0'), size: 1, location: `x/${n}`, filename: name } };
}

test('filter expressions as a desktop release build sees them', () => {
  assert.ok(filterApplies(''));
  assert.ok(!filterApplies("env.appinfo.OS == 'Android'"));
  assert.ok(filterApplies("env.appinfo.OS != 'Android' || env.channel != 'release'"));
  assert.ok(!filterApplies("env.channel == 'default' || env.channel == 'nightly'"));
  assert.ok(!filterApplies("env.version|versionCompare('130.a0') >= 0"), 'unknown forms do not apply');
});

test('the newest complete release set wins; pre-releases and other platforms are skipped', () => {
  const records = [
    // 2.2: complete, with separate vocabularies (CJK)
    rec('model.enzh.intgemm.alphas.bin', '2.2', 'en', 'zh-Hans', 'model'),
    rec('lex.50.50.enzh.s2t.bin', '2.2', 'en', 'zh-Hans', 'lex'),
    rec('srcvocab.enzh.spm', '2.2', 'en', 'zh-Hans', 'srcvocab'),
    rec('trgvocab.enzh.spm', '2.2', 'en', 'zh-Hans', 'trgvocab'),
    // 2.3: incomplete (no vocabulary)
    rec('model.enzh.intgemm.alphas.bin', '2.3', 'en', 'zh-Hans', 'model'),
    // 3.0a1: pre-release
    rec('model.enzh.intgemm8.bin', '3.0a1', 'en', 'zh-Hans', 'model'),
    rec('vocab.enzh.spm', '3.0a1', 'en', 'zh-Hans', 'vocab'),
    // 2.9: Android only
    rec('model.enzh.intgemm.alphas.bin', '2.9', 'en', 'zh-Hans', 'model', "env.appinfo.OS == 'Android'"),
    rec('vocab.enzh.spm', '2.9', 'en', 'zh-Hans', 'vocab', "env.appinfo.OS == 'Android'"),
    rec('model.jaen.intgemm.alphas.bin', '1.0', 'ja', 'en', 'model'),
    rec('vocab.jaen.spm', '1.0', 'ja', 'en', 'vocab'),
  ];
  const files = pickModelFiles(records, 'en', 'zh-Hans')!;
  assert.equal(files.model!.version, '2.2');
  assert.ok(files.srcvocab && files.trgvocab && files.lex);
  assert.equal(pickModelFiles(records, 'zh-Hans', 'en'), null);
  assert.deepEqual(directions(records), [['en', 'zh-Hans'], ['ja', 'en']]);
});

test('engine binary: newest of the major version the glue belongs to', () => {
  const records = [rec('bergamot-translator', '2.0'), rec('bergamot-translator', '3.0'), rec('bergamot-translator', '4.0'), rec('fasttext-wasm', '9.0')];
  assert.equal(pickWasm(records)!.version, '3.0');
});

test('ASCII punctuation between CJK characters becomes full width', () => {
  assert.equal(cjkPunctuation('工具,使助手(测试版)能够:存储?'), '工具，使助手（测试版）能够：存储？');
  assert.equal(cjkPunctuation('API 1,204.00 (beta)'), 'API 1,204.00 (beta)');
});
