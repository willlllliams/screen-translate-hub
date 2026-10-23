// Spec 16 section 4: the examples of requirement 03 sections 5.5 and 5.6, their
// failure variants, and randomized property tests of spec 04 section 6.6.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { EndState, Via } from '@sth/model';
import { Race, type RaceSink, type ShowBody } from '../src/race.ts';

class Recorder implements RaceSink {
  shows: ShowBody[] = [];
  ends: Array<{ state: EndState; via: Via }> = [];
  released: string[] = [];
  notices: string[] = [];
  show(_r: Race, b: ShowBody) {
    this.shows.push(b);
  }
  end(_r: Race, state: EndState, via: Via) {
    this.ends.push({ state, via });
  }
  release(_r: Race, node: string) {
    this.released.push(node);
  }
  preferredUnavailable(_r: Race, reason: string) {
    this.notices.push(reason);
  }
}

function race(sources: string[]): { r: Race; rec: Recorder } {
  const rec = new Recorder();
  const r = new Race('race', 1, 1, sources.map((node, i) => ({ node, rank: i + 1 })), rec);
  for (const s of sources) r.markRunning(s);
  return { r, rec };
}

const shownText = (rec: Recorder) => rec.shows.map((s) => (s.show === 'text' ? s.text : 'ERROR'));

test('example 1: three complete sources, AI > server > local', () => {
  const { r, rec } = race(['ai', 'server', 'local']);
  r.onCandidate('local', 1, true, 'local');
  r.onCandidate('server', 1, true, 'server');
  assert.equal(r.ended, false);
  r.onCandidate('ai', 1, true, 'ai');
  assert.deepEqual(shownText(rec), ['local', 'server', 'ai']);
  assert.equal(r.endState, 'complete');
  assert.equal(r.endedBy, 'settled');
});

test('example 1 variant: AI fails on this paragraph without output -> error', () => {
  const { r, rec } = race(['ai', 'server', 'local']);
  r.onCandidate('local', 1, true, 'local');
  r.onCandidate('server', 1, true, 'server');
  r.onFailure('ai', 'segment', 'timeout');
  assert.deepEqual(shownText(rec), ['local', 'server', 'ERROR']);
  assert.equal(r.endState, 'error');
});

test('example 1 variant: AI wholly unavailable -> keep server text, provisional, notice', () => {
  const { r, rec } = race(['ai', 'server', 'local']);
  r.onCandidate('local', 1, true, 'local');
  r.onCandidate('server', 1, true, 'server');
  r.onFailure('ai', 'whole', 'rate limited');
  assert.deepEqual(shownText(rec), ['local', 'server']);
  assert.equal(r.endState, 'provisional');
  assert.deepEqual(rec.notices, ['rate limited']);
});

test('example 2: stream interrupted, complete source wins', () => {
  const { r, rec } = race(['ai_complete', 'ai_stream', 'local']);
  r.onCandidate('local', 1, true, 'local');
  r.onCandidate('ai_stream', 1, false, '你好');
  r.onCandidate('ai_stream', 2, false, '你好，世界');
  assert.ok(rec.released.includes('local') === false); // local already finished
  r.onFailure('ai_stream', 'segment', 'interrupted');
  assert.equal(r.ended, false);
  r.onCandidate('ai_complete', 1, true, 'AI 完整译文');
  assert.deepEqual(shownText(rec), ['local', '你好', '你好，世界', 'AI 完整译文']);
  assert.equal(r.endState, 'complete');
});

test('example 2 variant: preferred stream interrupted after output -> partial', () => {
  const { r } = race(['ai_stream', 'local']);
  r.onCandidate('local', 1, true, 'local');
  r.onCandidate('ai_stream', 1, false, '你好');
  r.onFailure('ai_stream', 'segment', 'interrupted');
  assert.equal(r.endState, 'partial');
});

test('a final signal without text keeps the last version', () => {
  const { r, rec } = race(['ai']);
  r.onCandidate('ai', 1, false, 'abc');
  r.onCandidate('ai', 2, true, undefined);
  assert.equal(r.shownText, 'abc');
  assert.equal(r.endState, 'complete');
  assert.equal(rec.shows.length, 2);
});

test('lower ranked sources are pruned once a higher one shows text', () => {
  const { r, rec } = race(['ai', 'stream', 'local']);
  r.onCandidate('stream', 1, false, 'x');
  assert.ok(rec.released.includes('local'));
  assert.equal(r.outcome('local')?.state, 'pruned');
});

test('pause before the preferred source answers -> aborted', () => {
  const { r } = race(['ai', 'local']);
  r.onCandidate('local', 1, true, 'local');
  r.finish('pause');
  assert.equal(r.endState, 'aborted');
});

test('manual retry of the preferred source replaces the error', () => {
  const { r, rec } = race(['ai', 'local']);
  r.onFailure('ai', 'segment', 'boom');
  assert.equal(r.endState, 'error');
  assert.ok(r.retryEligible('ai'));
  r.reopen('ai');
  r.markRunning('ai');
  r.onCandidate('ai', 1, true, 'fixed');
  assert.equal(r.endState, 'complete');
  assert.equal(shownText(rec).at(-1), 'fixed');
});

// ---- randomized properties (spec 04 section 6.6, requirement 03 section 5.3) ----

function rng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}

test('randomized event orders satisfy the race properties', () => {
  for (let seed = 1; seed <= 3000; seed++) {
    const rand = rng(seed);
    const n = 1 + Math.floor(rand() * 4);
    const names = Array.from({ length: n }, (_, i) => `s${i + 1}`);
    const rec = new Recorder();
    const r = new Race('race', 1, 1, names.map((node, i) => ({ node, rank: i + 1 })), rec);
    for (const s of names) r.markRunning(s);
    const versions = new Map<string, number>();
    const prunedAt = new Map<string, number>();
    let steps = 0;
    while (!r.ended && steps < 40) {
      steps++;
      const s = names[Math.floor(rand() * n)];
      const x = rand();
      const before = r.outcome(s)?.state;
      if (x < 0.55) {
        const v = (versions.get(s) ?? 0) + 1;
        versions.set(s, v);
        r.onCandidate(s, v, rand() < 0.4, `${s}-v${v}`);
      } else if (x < 0.75) r.onFailure(s, 'segment', 'seg');
      else if (x < 0.85) r.onFailure(s, 'whole', 'whole');
      else if (x < 0.9) r.finish(rand() < 0.5 ? 'pause' : 'stop');
      else if (x < 0.95) r.onDeadline();
      for (const name of names) if (r.outcome(name)?.state === 'pruned' && !prunedAt.has(name)) prunedAt.set(name, rec.shows.length);
      void before;
    }
    if (!r.ended) r.finish('stop');
    // property 1: every race has an end state
    assert.ok(r.endState, `seed ${seed}: no end state`);
    // display rank only improves; cross-source replacements <= n - 1
    const ranks = rec.shows.filter((b) => b.show === 'text').map((b) => (b as { source_rank: number }).source_rank);
    for (let i = 1; i < ranks.length; i++) assert.ok(ranks[i] <= ranks[i - 1], `seed ${seed}: rank went up`);
    const switches = ranks.filter((v, i) => i > 0 && v !== ranks[i - 1]).length;
    assert.ok(switches <= n - 1, `seed ${seed}: too many cross-source replacements`);
    // property 2: a pruned source never changes the display afterwards
    for (const [name, at] of prunedAt) {
      const later = rec.shows.slice(at).filter((b) => b.show === 'text' && (b as { source_rank: number }).source_rank === r.rankOf(name));
      assert.equal(later.length, 0, `seed ${seed}: pruned ${name} changed the display`);
    }
    // property 4: complete means the preferred source's final text is shown
    if (r.endState === 'complete') {
      const rec2 = r.record();
      assert.equal(rec2.shown_candidate?.source, 's1', `seed ${seed}`);
      assert.equal(rec2.shown_candidate?.final, true, `seed ${seed}`);
    }
    assert.equal(rec.ends.length, 1, `seed ${seed}: end emitted ${rec.ends.length} times`);
  }
});
