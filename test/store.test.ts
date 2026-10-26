import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { describe, it } from 'node:test';
import { type IssueRef, Store } from '../src/db/store.ts';

const ref = (key: string): IssueRef => ({ id: `id-${key}`, key });
const result = { status: 'complete' as const, summary: 'Ports table is empty', reporter: 'A Tester', fingerprint: 'f1', baseChecks: [], verdict: {}, comment: null, commentId: null };
const statusOf = (s: Store, key: string) => s.rows([key]).get(key)?.status;

describe('Store', () => {
  it('bootstraps once, even when the first query is empty', () => {
    const s = new Store(':memory:');
    assert.equal(s.isBootstrapped(), false);
    s.bootstrap([]);
    assert.equal(s.isBootstrapped(), true);
    s.bootstrap([ref('KAZ-1'), ref('KAZ-2')]);
    assert.deepEqual([...s.rows(['KAZ-1', 'KAZ-2', 'KAZ-3']).keys()], ['KAZ-1', 'KAZ-2']);
    assert.equal(statusOf(s, 'KAZ-1'), 'skipped');
  });
  it('retries a failed first check up to the limit, then marks it failed', () => {
    const s = new Store(':memory:');
    assert.deepEqual(s.recordFailure(ref('KAZ-3'), 'boom', 3), { status: 'retry', attempts: 1 });
    s.recordFailure(ref('KAZ-3'), 'boom', 3);
    assert.deepEqual(s.recordFailure(ref('KAZ-3'), 'boom', 3), { status: 'failed', attempts: 3 });
    assert.equal(s.rows(['KAZ-3']).get('KAZ-3')?.runs, 3, 'every attempt is a run');
  });
  it('keeps one request per key until it is served, or failed until it is asked again', () => {
    const s = new Store(':memory:');
    s.request('KAZ-1');
    s.request('KAZ-2');
    s.request('KAZ-1');
    assert.deepEqual(s.requests().map((r) => r.key), ['KAZ-2', 'KAZ-1'], 'one per key, oldest first; asked again is asked anew');
    s.requestFailed('KAZ-2', 'no such issue');
    s.requestDone('KAZ-1');
    assert.deepEqual(s.requests().map((r) => [r.key, r.error]), [['KAZ-2', 'no such issue']]);
    s.request('KAZ-2');
    assert.deepEqual(s.requests().map((r) => r.error), [null], 'asked again: pending again');
  });
  it('a result after a failure closes the bug; posting becomes commented', () => {
    const s = new Store(':memory:');
    s.recordFailure(ref('KAZ-4'), 'boom', 3);
    s.recordResult(ref('KAZ-4'), { ...result, status: 'posting', comment: 'hi' });
    s.markCommented('KAZ-4', '42');
    assert.deepEqual(s.rows(['KAZ-4']).get('KAZ-4'), { status: 'commented', fingerprint: 'f1', comment: 'hi', commentId: '42', runs: 2 });
  });
  it('a re-check updates the state and keeps the comment id; a failed one changes nothing but the error', () => {
    const s = new Store(':memory:');
    s.recordResult(ref('KAZ-6'), { ...result, status: 'posting', comment: 'v1' });
    s.markCommented('KAZ-6', '42');
    s.recordRecheckFailure('KAZ-6', 'agent run timed out');
    assert.deepEqual(s.rows(['KAZ-6']).get('KAZ-6'), { status: 'commented', fingerprint: 'f1', comment: 'v1', commentId: '42', runs: 2 });
    s.recordResult(ref('KAZ-6'), { ...result, status: 'commented', fingerprint: 'f2', comment: 'v2', commentId: '42' });
    assert.deepEqual(s.rows(['KAZ-6']).get('KAZ-6'), { status: 'commented', fingerprint: 'f2', comment: 'v2', commentId: '42', runs: 3 });
  });
  it('a bug moved to the other project keeps its row and history under the new key; an old row gets its id', () => {
    const s = new Store(':memory:');
    s.recordResult(ref('RPG-6223'), result);
    assert.deepEqual(s.track([{ id: 'id-RPG-6223', key: 'KAZ-9040' }]), [{ from: 'RPG-6223', to: 'KAZ-9040' }]);
    assert.deepEqual(s.rows(['KAZ-9040']).get('KAZ-9040'), { status: 'complete', fingerprint: 'f1', comment: null, commentId: null, runs: 1 });
    assert.deepEqual(s.track([{ id: 'id-RPG-6223', key: 'KAZ-9040' }]), [], 'nothing moves twice');
  });
  it('opens a database made before meta and the late columns, and treats its rows as the first start', () => {
    const file = join(mkdtempSync(join(tmpdir(), 'store-')), 'old.sqlite');
    const old = new DatabaseSync(file);
    old.exec('CREATE TABLE checks (key TEXT PRIMARY KEY, status TEXT NOT NULL, attempts INTEGER NOT NULL DEFAULT 0, checked_at TEXT, base_checks TEXT, verdict TEXT, comment TEXT, comment_id TEXT, error TEXT)');
    old.exec("INSERT INTO checks (key, status, checked_at, comment) VALUES ('KAZ-1', 'dry_run', 't', 'old comment')");
    old.close();

    const s = new Store(file);
    assert.equal(s.isBootstrapped(), true);
    assert.deepEqual(s.rows(['KAZ-1']).get('KAZ-1'), { status: 'dry_run', fingerprint: null, comment: 'old comment', commentId: null, runs: 0 });
    assert.deepEqual(s.track([ref('KAZ-1')]), []);
    assert.deepEqual(s.track([{ id: 'id-KAZ-1', key: 'RPG-2' }]), [{ from: 'KAZ-1', to: 'RPG-2' }], 'the old row got its id');
    s.recordResult(ref('KAZ-5'), result);
    s.close();
    const row = new DatabaseSync(file).prepare("SELECT summary, reporter, fingerprint FROM checks WHERE key = 'KAZ-5'").get();
    assert.deepEqual({ ...row }, { summary: 'Ports table is empty', reporter: 'A Tester', fingerprint: 'f1' });
    assert.equal(Store.recordedComment(file, 'RPG-2'), 'old comment');
    assert.equal(Store.recordedComment(file, 'KAZ-404'), null);
  });
});
