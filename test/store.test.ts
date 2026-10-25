import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { describe, it } from 'node:test';
import { type IssueRef, Store } from '../src/db/store.ts';

const ref = (key: string): IssueRef => ({ id: `id-${key}`, key });
const result = { status: 'complete' as const, summary: 'Ports table is empty', reporter: 'A Tester', baseChecks: [], verdict: {}, comment: null };

describe('Store', () => {
  it('bootstraps once, even when the first query is empty, then reports only unknown keys as pending', () => {
    const s = new Store(':memory:');
    assert.equal(s.isBootstrapped(), false);
    s.bootstrap([]);
    assert.equal(s.isBootstrapped(), true);
    assert.deepEqual(s.pending(['KAZ-1']), ['KAZ-1']);
    s.bootstrap([ref('KAZ-1'), ref('KAZ-2')]);
    assert.deepEqual(s.pending(['KAZ-1', 'KAZ-2', 'KAZ-3']), ['KAZ-3']);
  });
  it('retries a failed check up to the limit, then marks it failed; requeue starts over', () => {
    const s = new Store(':memory:');
    assert.deepEqual(s.recordFailure(ref('KAZ-3'), 'boom', 3), { status: 'retry', attempts: 1 });
    assert.deepEqual(s.pending(['KAZ-3']), ['KAZ-3']);
    s.recordFailure(ref('KAZ-3'), 'boom', 3);
    assert.deepEqual(s.recordFailure(ref('KAZ-3'), 'boom', 3), { status: 'failed', attempts: 3 });
    assert.deepEqual(s.pending(['KAZ-3']), []);
    assert.equal(s.requeue('KAZ-3'), true);
    assert.deepEqual(s.pending(['KAZ-3']), ['KAZ-3']);
    assert.equal(s.requeue('KAZ-3'), false, 'only failed or posting rows are requeued');
  });
  it('a result after a failure closes the bug; posting becomes commented', () => {
    const s = new Store(':memory:');
    s.recordFailure(ref('KAZ-4'), 'boom', 3);
    s.recordResult(ref('KAZ-4'), { ...result, status: 'posting', comment: 'hi' });
    assert.deepEqual(s.pending(['KAZ-4']), [], 'a posting row is never checked again by itself');
    s.markCommented('KAZ-4', '42');
    assert.equal(s.status('KAZ-4'), 'commented');
  });
  it('a bug moved to the other project keeps its row under the new key; an old row gets its id', () => {
    const s = new Store(':memory:');
    s.recordResult(ref('RPG-6223'), result);
    assert.deepEqual(s.track([{ id: 'id-RPG-6223', key: 'KAZ-9040' }]), [{ from: 'RPG-6223', to: 'KAZ-9040' }]);
    assert.equal(s.status('KAZ-9040'), 'complete');
    assert.deepEqual(s.pending(['KAZ-9040']), []);
    assert.deepEqual(s.track([{ id: 'id-RPG-6223', key: 'KAZ-9040' }]), [], 'nothing moves twice');
  });
  it('opens a database made before meta and the late columns, and treats its rows as the first start', () => {
    const file = join(mkdtempSync(join(tmpdir(), 'store-')), 'old.sqlite');
    const old = new DatabaseSync(file);
    old.exec('CREATE TABLE checks (key TEXT PRIMARY KEY, status TEXT NOT NULL, attempts INTEGER NOT NULL DEFAULT 0, checked_at TEXT, base_checks TEXT, verdict TEXT, comment TEXT, comment_id TEXT, error TEXT)');
    old.exec("INSERT INTO checks (key, status, checked_at) VALUES ('KAZ-1', 'skipped', 't')");
    old.close();

    const s = new Store(file);
    assert.equal(s.isBootstrapped(), true);
    assert.deepEqual(s.track([ref('KAZ-1')]), []);
    assert.deepEqual(s.track([{ id: 'id-KAZ-1', key: 'RPG-1' }]), [{ from: 'KAZ-1', to: 'RPG-1' }], 'the old row got its id');
    s.recordResult(ref('KAZ-5'), result);
    s.close();
    const row = new DatabaseSync(file).prepare("SELECT summary, reporter FROM checks WHERE key = 'KAZ-5'").get();
    assert.deepEqual({ ...row }, { summary: 'Ports table is empty', reporter: 'A Tester' });
  });
});
