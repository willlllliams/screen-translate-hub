import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { test } from 'node:test';
import { HistoryStore } from '../src/history.ts';

test('history files are named by local date and time', () => {
  const dir = mkdtempSync(join(tmpdir(), 'sth-history-test-'));
  try {
    const store = new HistoryStore(dir);
    const saved = store.save({ kind: 'screenshot', text: 'a' });
    const at = new Date(saved.at);
    const p = (n: number) => String(n).padStart(2, '0');
    assert.equal(basename(dirname(saved.file)), `${at.getFullYear()}-${p(at.getMonth() + 1)}-${p(at.getDate())}`);
    assert.match(basename(saved.file), new RegExp(`^${p(at.getHours())}\\d{4}-screenshot-`));
    assert.deepEqual(store.list().map((e) => e.id), [saved.id]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
