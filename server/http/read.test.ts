import assert from 'node:assert/strict'
import { existsSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { describe, it } from 'vitest'
import { checked, firstRun, readBug, readBugs, readRequests, result } from './read.ts'
import { emptyState, sampleState } from './sample.ts'

describe('readBugs', () => {
  it('reads every row, the latest check first', () => {
    const bugs = readBugs(sampleState().dbFile)
    assert.deepEqual(
      bugs.map((b) => b.key),
      ['KAZ-2', 'RPG-4', 'KAZ-3', 'RPG-6', 'KAZ-5', 'KAZ-1'],
    )
    const [kaz2] = bugs
    assert.equal(kaz2?.summary, 'Ports table is empty after clearing the filter')
    assert.equal(kaz2?.reporter, 'A Tester')
    assert.deepEqual(kaz2?.related, ['KAZ-1'])
    assert.equal(kaz2?.fieldChecks.find((c) => c.id === 'R6')?.passed, false)
    assert.equal(bugs[3]?.reason, 'The UI shows the counter ConfD returns.')
    assert.deepEqual(bugs.map(result), ['not_understood', 'error', 'understood', 'not_webui', 'not_understood', 'skipped'])
    assert.deepEqual(bugs.map(checked), [true, false, true, true, true, false])
  })
  it("reads the history: each check's outcome or error, what it read, and the first finished one", () => {
    const bug = readBug(sampleState().dbFile, 'KAZ-2')
    assert.ok(bug)
    assert.deepEqual(
      bug.history.map((r) => r.outcome),
      ['not_understood', null, 'not_understood'],
    )
    assert.deepEqual(
      bug.history.map((r) => r.fieldChecks.filter((c) => !c.passed).map((c) => c.id)),
      [['R1', 'R4', 'R6'], [], ['R4', 'R6']],
    )
    assert.equal(bug.history[1]?.error, 'VerdictError: not_understood without a comment')
    assert.deepEqual(
      [bug.history[0]?.webuiCommit, bug.history[0]?.version, bug.history[0]?.costUsd, bug.history[0]?.files.map((f) => f.kind)],
      ['abc123def456', 2, 0.03, ['image']],
    )
    assert.ok(bug.history[0]!.at < bug.history[2]!.at)
    assert.equal(firstRun(bug), bug.history[0])
    assert.equal(readBug(sampleState().dbFile, 'KAZ-5')?.history[0]?.version, 1, 'a check by the list')
    assert.equal(readBug(sampleState().dbFile, 'KAZ-99'), null)
  })
  it('reads a database made before summary, reporter and runs existed, and rows without a time', () => {
    const file = join(emptyState().dir, 'old.sqlite')
    const old = new DatabaseSync(file)
    old.exec(
      'CREATE TABLE checks (key TEXT PRIMARY KEY, status TEXT NOT NULL, attempts INTEGER NOT NULL DEFAULT 0, checked_at TEXT, base_checks TEXT, verdict TEXT, comment TEXT, comment_id TEXT, error TEXT)',
    )
    old.exec("INSERT INTO checks (key, status, checked_at, comment) VALUES ('KAZ-1', 'dry_run', '2026-10-17T12:50:50.282Z', 'old comment')")
    old.exec("INSERT INTO checks (key, status) VALUES ('KAZ-2', 'skipped')")
    old.close()
    const bugs = readBugs(file)
    assert.deepEqual(
      bugs.map((b) => [b.key, b.summary, b.history.length, b.checkedAt.getTime()]),
      [
        ['KAZ-1', null, 0, Date.parse('2026-10-17T12:50:50.282Z')],
        ['KAZ-2', null, 0, 0],
      ],
    )
    assert.equal(firstRun(bugs[0]!), null)
    assert.deepEqual([bugs[0]!.related, bugs[0]!.reason], [[], ''])
  })
  it('a file without the table yet is no bugs; one that is not a database is an error, not an empty state', () => {
    const dir = emptyState().dir
    writeFileSync(join(dir, 'text.sqlite'), 'not a database')
    assert.throws(() => readBugs(join(dir, 'text.sqlite')), /not a database/)
    new DatabaseSync(join(dir, 'bare.sqlite')).close()
    assert.deepEqual(readBugs(join(dir, 'bare.sqlite')), [])
  })
  it('reads the requests, oldest first; none from a database without the table', () => {
    const state = sampleState()
    assert.deepEqual(
      readRequests(state.dbFile).map((r) => [r.key, r.error]),
      [
        ['KAZ-77', 'JiraError: HTTP 404 on GET /issue/KAZ-77'],
        ['KAZ-1', null],
      ],
    )
    assert.ok(readRequests(state.dbFile)[1]!.at < state.now)
    const file = join(emptyState().dir, 'old.sqlite')
    new DatabaseSync(file).close()
    assert.deepEqual(readRequests(file), [])
    assert.deepEqual(readRequests(join(emptyState().dir, 'missing.sqlite')), [])
  })
  it('no database yet is no bugs, and the UI never creates one', () => {
    const file = join(emptyState().dir, 'missing.sqlite')
    assert.deepEqual(readBugs(file), [])
    assert.equal(existsSync(file), false)
  })
})
