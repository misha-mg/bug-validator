import assert from 'node:assert/strict';
import { existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { describe, it } from 'node:test';
import { checked, firstMissing, readBug, readBugs, result } from '../../src/ui/read.ts';
import { emptyState, sampleState } from './state.ts';

describe('readBugs', () => {
  it('reads every row, the latest check first', () => {
    const bugs = readBugs(sampleState().dbFile);
    assert.deepEqual(bugs.map((b) => b.key), ['KAZ-2', 'RPG-4', 'KAZ-3', 'KAZ-5', 'KAZ-1']);
    const [kaz2] = bugs;
    assert.equal(kaz2?.summary, 'Ports table is empty after clearing the filter');
    assert.equal(kaz2?.reporter, 'A Tester');
    assert.deepEqual(kaz2?.missing, ['R4', 'R6']);
    assert.deepEqual(kaz2?.related, [{ key: 'KAZ-1', reason: 'the same empty table' }]);
    assert.equal(kaz2?.baseChecks.find((c) => c.id === 'R6')?.passed, false);
    assert.deepEqual(bugs.map(result), ['comment', 'error', 'no_comment', 'comment', 'skipped']);
    assert.deepEqual(bugs.map(checked), [true, false, true, true, false]);
  });
  it('reads the history and the first verdict', () => {
    const bug = readBug(sampleState().dbFile, 'KAZ-2');
    assert.ok(bug);
    assert.deepEqual(bug.history.map((r) => r.missing), [['R1', 'R4', 'R6'], [], ['R4', 'R6']]);
    assert.equal(bug.history[1]?.error, 'VerdictError: a re-check must keep the comment');
    assert.ok(bug.history[0]!.at < bug.history[2]!.at);
    assert.deepEqual(firstMissing(bug), ['R1', 'R4', 'R6']);
    assert.equal(readBug(sampleState().dbFile, 'KAZ-99'), null);
  });
  it('reads a database made before summary, reporter and runs existed, and rows without a time', () => {
    const file = join(emptyState().dir, 'old.sqlite');
    const old = new DatabaseSync(file);
    old.exec('CREATE TABLE checks (key TEXT PRIMARY KEY, status TEXT NOT NULL, attempts INTEGER NOT NULL DEFAULT 0, checked_at TEXT, base_checks TEXT, verdict TEXT, comment TEXT, comment_id TEXT, error TEXT)');
    old.exec("INSERT INTO checks (key, status, checked_at, comment) VALUES ('KAZ-1', 'dry_run', '2026-10-17T12:50:50.282Z', 'old comment')");
    old.exec("INSERT INTO checks (key, status) VALUES ('KAZ-2', 'skipped')");
    old.close();
    const bugs = readBugs(file);
    assert.deepEqual(bugs.map((b) => [b.key, b.summary, b.history.length, b.checkedAt.getTime()]), [['KAZ-1', null, 0, Date.parse('2026-10-17T12:50:50.282Z')], ['KAZ-2', null, 0, 0]]);
    assert.deepEqual(firstMissing(bugs[0]!), []);
  });
  it('a file that is not a database, or without the table yet, is no bugs', () => {
    const dir = emptyState().dir;
    writeFileSync(join(dir, 'text.sqlite'), 'not a database');
    assert.deepEqual(readBugs(join(dir, 'text.sqlite')), []);
    new DatabaseSync(join(dir, 'bare.sqlite')).close();
    assert.deepEqual(readBugs(join(dir, 'bare.sqlite')), []);
  });
  it('no database yet is no bugs, and the UI never creates one', () => {
    const file = join(emptyState().dir, 'missing.sqlite');
    assert.deepEqual(readBugs(file), []);
    assert.equal(existsSync(file), false);
  });
});
