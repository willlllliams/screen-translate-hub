import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { EncodedImage } from '@sth/model';
import { withTask } from '../src/brain-claude.ts';
import { RuleGate } from '../src/gate.ts';
import { tileChanges, type Heartbeat } from '../src/heartbeat.ts';
import type { Platform } from '../src/platform.ts';
import { AssistantSession } from '../src/session.ts';
import type { Brain, BrainEvent, Gate, SessionServerMessage, WakeEvent } from '../src/types.ts';

/** A brain whose turns last until released, recording every wake. */
class FakeBrain implements Brain {
  readonly name = 'fake';
  readonly wakes: WakeEvent[] = [];
  readonly tasks: string[] = [];
  private release: Array<() => void> = [];
  opened = false;
  closed = false;

  async open(): Promise<void> {
    this.opened = true;
  }

  async *wake(ev: WakeEvent, signal: AbortSignal): AsyncIterable<BrainEvent> {
    this.wakes.push(ev);
    yield { type: 'text_delta', delta: `answer to ${ev.kind}` };
    await new Promise<void>((r) => {
      this.release.push(r);
      signal.addEventListener('abort', () => r(), { once: true });
    });
    yield { type: 'turn_end', stop: signal.aborted ? 'cancelled' : 'done' };
  }

  setTask(task: string): void {
    this.tasks.push(task);
  }

  finishTurn(): void {
    this.release.shift()?.();
  }

  async close(): Promise<void> {
    this.closed = true;
  }
}

const tick = () => new Promise((r) => setTimeout(r, 5));

function makeSession(gate: Gate = new RuleGate()) {
  const brain = new FakeBrain();
  const out: SessionServerMessage[] = [];
  const frame: EncodedImage = { format: 'raw_bgra8', width: 2, height: 2, data: new Uint8Array(16) };
  const heartbeat = {
    sample: async () => ({ frame, sample: { at: new Date().toISOString(), changed_ratio: 1, changed_since_ms: 5000, active_app: 'x', window_title: '', app_switched: false, user_idle_ms: 0 } }),
    markWake: () => undefined,
  } as unknown as Heartbeat;
  const platform = { close: async () => undefined } as unknown as Platform;
  const s = new AssistantSession('task', { platform, heartbeat, gate, brain, heartbeatMs: 60_000, emit: (m) => out.push(m), log: () => undefined });
  return { s, brain, out };
}

test('user messages wake at once; wakes during a turn wait in one slot', async () => {
  const { s, brain, out } = makeSession();
  await s.start();
  assert.ok(brain.opened);
  s.userMessage('first');
  await tick();
  assert.equal(s.state, 'thinking');
  s.wake({ kind: 'gate', decision: { wake: true, confidence: 1, reason: 'a' } });
  s.wake({ kind: 'gate', decision: { wake: true, confidence: 1, reason: 'b' } });
  s.userMessage('second');
  s.wake({ kind: 'gate', decision: { wake: true, confidence: 1, reason: 'c' } }); // must not replace the user's message
  s.userMessage('third');
  brain.finishTurn();
  await tick();
  assert.equal(brain.wakes.length, 2);
  assert.equal(brain.wakes[1].kind, 'user_message');
  assert.equal(brain.wakes[1].text, 'second\nthird');
  brain.finishTurn();
  await tick();
  assert.equal(s.state, 'watching');
  assert.ok(out.some((m) => 'brain' in m && m.brain.type === 'text_delta'));
  assert.deepEqual(
    s.transcript.filter((t) => t.who === 'user').map((t) => t.text),
    ['first', 'second', 'third'],
  );
  await s.stop();
  assert.ok(brain.closed);
});

test('pause cancels the turn and stops waking; a message resumes', async () => {
  const { s, brain } = makeSession();
  await s.start();
  s.userMessage('look');
  await tick();
  s.pause();
  await tick();
  assert.equal(s.state, 'paused');
  s.wake({ kind: 'gate', decision: { wake: true, confidence: 1, reason: 'x' } });
  s.wake({ kind: 'hotkey' });
  await tick();
  assert.equal(brain.wakes.length, 1, 'no AI calls while paused');
  s.userMessage('back');
  await tick();
  assert.equal(s.state, 'thinking');
  assert.equal(brain.wakes.length, 2);
  await s.stop();
});

test('a task set during the session reaches the brain, which tells the model once', async () => {
  const { s, brain } = makeSession();
  await s.start();
  s.setTask('read the error dialog');
  assert.deepEqual(brain.tasks, ['read the error dialog']);
  assert.equal(withTask('hello', 'read the error dialog'), "[The user's task is now: read the error dialog]\nhello");
  assert.equal(withTask('hello', null), 'hello');
  await s.stop();
});

test('tile changes count changed 16 px tiles', () => {
  const a: EncodedImage = { format: 'raw_bgra8', width: 64, height: 32, data: new Uint8Array(64 * 32 * 4) };
  const b: EncodedImage = { ...a, data: a.data.slice() };
  assert.deepEqual(tileChanges(a, b), { changed: 0, total: 8 });
  b.data[(20 * 64 + 40) * 4] = 200; // one pixel in tile (2, 1)
  assert.deepEqual(tileChanges(a, b), { changed: 1, total: 8 });
});
