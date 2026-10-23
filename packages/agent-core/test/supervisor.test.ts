import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { setTimeout as sleep } from 'node:timers/promises';
import { Supervisor, type ServiceSpec } from '../src/supervisor.ts';

async function until(ok: () => boolean, ms = 5_000): Promise<void> {
  const start = Date.now();
  while (!ok()) {
    if (Date.now() - start > ms) throw new Error('condition not met in time');
    await sleep(20);
  }
}

function supervisor(dir: string): { s: Supervisor; exits: Array<number | null> } {
  const s = new Supervisor({ agentUrl: () => 'ws://127.0.0.1:1', token: 'test', logDir: join(dir, 'logs') });
  const exits: Array<number | null> = [];
  s.onExit = (_name, code) => exits.push(code);
  return { s, exits };
}

test('a service that failed to start starts once the problem is fixed', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'sth-supervisor-test-'));
  const cwd = join(dir, 'late');
  const mark = join(dir, 'started');
  const spec: ServiceSpec = {
    name: 'probe',
    command: process.execPath,
    args: ['-e', `require('fs').writeFileSync(${JSON.stringify(mark)}, 'ok'); process.stdin.resume()`],
    cwd,
  };
  const { s, exits } = supervisor(dir);
  s.define(spec);
  try {
    s.ensure('probe'); // the working directory does not exist yet
    await until(() => exits.length === 1);
    assert.deepEqual(exits, [null]);
    assert.equal(s.isRunning('probe'), false);
    mkdirSync(cwd);
    s.ensure('probe');
    await until(() => existsSync(mark));
    assert.equal(s.isRunning('probe'), true);
  } finally {
    s.stopAll();
    await until(() => !s.isRunning('probe'));
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a missing command ends once and is retried with backoff', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'sth-supervisor-test-'));
  const { s, exits } = supervisor(dir);
  s.define({ name: 'missing', command: 'sth-no-such-command', args: [], cwd: dir });
  try {
    s.ensure('missing');
    await until(() => exits.length === 1);
    await sleep(300);
    assert.deepEqual(exits, [null]); // the error is not reported twice
    await until(() => exits.length === 2, 3_000); // first backoff step: 1 s
  } finally {
    s.stopAll();
    rmSync(dir, { recursive: true, force: true });
  }
});
