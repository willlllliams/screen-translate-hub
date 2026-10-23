import assert from 'node:assert/strict';
import { test } from 'node:test';
import { CompositeGate, JevGate, RuleGate, type JevAnswers } from '../src/gate.ts';
import type { GateInput, HeartbeatSample } from '../src/types.ts';

const NOW = '2026-10-21T12:00:00.000Z';

function input(s: Partial<HeartbeatSample> = {}, o: Partial<GateInput> = {}): GateInput {
  return {
    sample: { at: NOW, changed_ratio: 0, changed_since_ms: 10_000, active_app: 'chrome', window_title: 'Docs', app_switched: false, user_idle_ms: 0, ...s },
    task: 'help me read',
    paused: false,
    wakes_last_hour: 0,
    ...o,
  };
}

const signal = new AbortController().signal;

test('rule gate: hard limits first, then app switch and settled changes', async () => {
  const g = new RuleGate();
  assert.equal((await g.decide(input({ app_switched: true }, { paused: true }), signal)).wake, false);
  const tooSoon = await g.decide(input({ app_switched: true }, { last_wake_at: '2026-10-21T11:59:50.000Z' }), signal);
  assert.equal(tooSoon.wake, false);
  assert.match(tooSoon.reason, /10 s ago/);
  assert.match((await g.decide(input({ app_switched: true }, { wakes_last_hour: 30 }), signal)).reason, /limit/);
  assert.equal((await g.decide(input({ app_switched: true }), signal)).wake, true);
  assert.equal((await g.decide(input({ app_switched: true, changed_since_ms: 300 }), signal)).wake, false, 'switch still animating');
  assert.equal((await g.decide(input({ changed_ratio: 0.5 }), signal)).wake, true);
  assert.equal((await g.decide(input({ changed_ratio: 0.5, changed_since_ms: 200 }), signal)).reason, 'screen still changing');
  assert.equal((await g.decide(input({ changed_ratio: 0.05 }), signal)).wake, false);
});

function jev(answers: JevAnswers | Error, delayMs = 0) {
  return new JevGate({
    ask: (_state, sig) =>
      new Promise((resolve, reject) => {
        const t = setTimeout(() => (answers instanceof Error ? reject(answers) : resolve(answers)), delayMs);
        sig.addEventListener('abort', () => {
          clearTimeout(t);
          reject(new Error('aborted'));
        });
      }),
    timeoutMs: 100,
  });
}

test('jev gate: confident answers decide, everything else falls back to the rules', async () => {
  const sure = (p: number): JevAnswers => ({ wake: { noul: p }, change: { choice: 'new_content', confidence: 0.9 } });
  assert.equal((await jev(sure(0.8)).decide(input(), signal)).wake, true);
  assert.equal((await jev(sure(0.2)).decide(input({ changed_ratio: 0.9 }), signal)).wake, false);
  const unsure = await jev({ wake: { noul: 0.9 }, change: { choice: 'transition', confidence: 0.3 } }).decide(input(), signal);
  assert.equal(unsure.by, 'rules');
  assert.match(unsure.reason, /jev unsure/);
  assert.match((await jev(sure(0.9), 500).decide(input(), signal)).reason, /timed out/);
  assert.match((await jev(new Error('boom')).decide(input(), signal)).reason, /unreachable/);
  assert.match((await new JevGate({}).decide(input(), signal)).reason, /not configured/);
  // hard limits apply before jev is asked
  assert.equal((await jev(sure(0.99)).decide(input({}, { paused: true }), signal)).wake, false);
});

test('composite gate: rules 1 and 2, then the model gate', async () => {
  const rules = new RuleGate();
  const g = new CompositeGate(jev({ wake: { noul: 0.9 }, change: { choice: 'new_content', confidence: 0.95 } }), rules);
  assert.equal((await g.decide(input({}, { wakes_last_hour: 99 }), signal)).by, 'rules');
  const d = await g.decide(input(), signal);
  assert.equal(d.wake, true);
  assert.equal(d.by, 'jev');
});

test('jev state text carries the task, app, change and idle time', () => {
  const t = JevGate.stateText(input({ changed_ratio: 0.42, ocr_excerpt: 'Total 1,204' }));
  assert.match(t, /help me read/);
  assert.match(t, /chrome/);
  assert.match(t, /42%/);
  assert.match(t, /Total 1,204/);
});
