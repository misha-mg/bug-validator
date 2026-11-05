// Tests of store.ts: the rows, the migrations and their backup copy, the requests, the posts, the heartbeat.
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterAll, describe, it } from 'vitest'
import { readHeartbeat } from '../http/read.ts'
import { type IssueRef, MAX_PENDING_REQUESTS, requestCheck, requestPost, Store } from './store.ts'

const dirs: string[] = []
const tempDir = (): string => {
  const dir = mkdtempSync(join(tmpdir(), 'store-'))
  dirs.push(dir)
  return dir
}
afterAll(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true })
})

const ref = (key: string): IssueRef => ({ id: `id-${key}`, key })
const result = {
  status: 'understood' as const,
  summary: 'Ports table is empty',
  reporter: 'A Tester',
  fingerprint: 'f1',
  fieldChecks: [],
  verdict: {},
  comment: null,
  commentId: null,
  webuiCommit: 'abc',
  files: [],
  reasoning: 'Ports.vue filters the rows out',
}
const statusOf = (s: Store, key: string) => s.rows([key]).get(key)?.status

describe('Store', () => {
  it('writes its heartbeat into meta, where the UI reads it without the Store', () => {
    const file = join(tempDir(), 'bug-validator.sqlite')
    const s = new Store(file)
    assert.equal(readHeartbeat(file), null)
    s.heartbeat(4242, '2026-11-04T10:00:00.000Z', '2026-11-04T10:00:05.000Z')
    assert.deepEqual(readHeartbeat(file), {
      pid: 4242,
      startedAt: new Date('2026-11-04T10:00:00.000Z'),
      seenAt: new Date('2026-11-04T10:00:05.000Z'),
    })
    s.heartbeat(4242, '2026-11-04T10:00:00.000Z', '2026-11-04T10:00:10.000Z')
    assert.equal(readHeartbeat(file)?.seenAt.toISOString(), '2026-11-04T10:00:10.000Z', 'one row per key, updated in place')
    assert.equal(s.isBootstrapped(), false, 'a heartbeat is not a first start')
    s.close()
  })
  it('bootstraps once, even when the first query is empty', () => {
    const s = new Store(':memory:')
    assert.equal(s.isBootstrapped(), false)
    s.bootstrap([])
    assert.equal(s.isBootstrapped(), true)
    s.bootstrap([ref('KAZ-1'), ref('KAZ-2')])
    assert.deepEqual([...s.rows(['KAZ-1', 'KAZ-2', 'KAZ-3']).keys()], ['KAZ-1', 'KAZ-2'])
    assert.equal(statusOf(s, 'KAZ-1'), 'skipped')
  })
  it('retries a failed first check up to the limit, then marks it failed', () => {
    const s = new Store(':memory:')
    assert.deepEqual(s.recordFailure(ref('KAZ-3'), 'boom', 3), { status: 'retry', attempts: 1 })
    s.recordFailure(ref('KAZ-3'), 'boom', 3)
    assert.deepEqual(s.recordFailure(ref('KAZ-3'), 'boom', 3), { status: 'failed', attempts: 3 })
    assert.equal(s.rows(['KAZ-3']).get('KAZ-3')?.runs, 3, 'every attempt is a run')
  })
  it('keeps one request per key until it is served, or failed until it is asked again', () => {
    const s = new Store(':memory:')
    s.request('KAZ-1')
    s.request('KAZ-2')
    s.request('KAZ-1')
    assert.deepEqual(
      s.requests().map((r) => r.key),
      ['KAZ-2', 'KAZ-1'],
      'one per key, oldest first; asked again is asked anew',
    )
    s.requestFailed('KAZ-2', 'no such issue')
    const asked = s.requests().find((r) => r.key === 'KAZ-1')!
    s.requestDone('KAZ-1', 'an older time')
    assert.equal(s.requests().length, 2, 'asked again since: kept')
    s.requestDone('KAZ-1', asked.at)
    assert.deepEqual(
      s.requests().map((r) => [r.key, r.error]),
      [['KAZ-2', 'no such issue']],
    )
    s.request('KAZ-2')
    assert.deepEqual(
      s.requests().map((r) => r.error),
      [null],
      'asked again: pending again',
    )
  })
  it('counts failed first checks since the last result; a result resets them', () => {
    const s = new Store(':memory:')
    s.recordResult(ref('KAZ-7'), { ...result, status: 'dry_run', comment: 'c' })
    s.recordResult(ref('KAZ-7'), { ...result, status: 'dry_run', comment: 'c' })
    assert.deepEqual(s.recordFailure(ref('KAZ-7'), 'boom', 3), { status: 'retry', attempts: 1 }, 'earlier results do not count')
  })
  it('a post Jira refused puts the bug back in line, at the cost of an attempt only when asked', () => {
    const s = new Store(':memory:')
    s.recordResult(ref('KAZ-8'), { ...result, status: 'posting', comment: 'c' })
    assert.deepEqual(s.postRefused('KAZ-8', 'HTTP 503', 3, false), { status: 'retry', attempts: 0 })
    s.recordResult(ref('KAZ-8'), { ...result, status: 'posting', comment: 'c' })
    assert.deepEqual(s.postRefused('KAZ-8', 'HTTP 400', 3, true), { status: 'retry', attempts: 1 })
    assert.equal(s.rows(['KAZ-8']).get('KAZ-8')?.runs, 2, "the refusal is the run's error, not a run of its own")
  })
  it('never forgets a comment id', () => {
    const s = new Store(':memory:')
    s.recordResult(ref('KAZ-9'), { ...result, status: 'commented', comment: 'c', commentId: '42' })
    s.recordResult(ref('KAZ-9'), { ...result, status: 'dry_run', comment: 'c', commentId: null })
    assert.equal(s.rows(['KAZ-9']).get('KAZ-9')?.commentId, '42')
  })
  it("takes a request from the UI into the service's database only, up to a cap", () => {
    const dir = tempDir()
    const file = join(dir, 'db.sqlite')
    assert.throws(() => requestCheck(file, 'KAZ-1'), /No database/)
    assert.equal(existsSync(file), false, 'never created')
    assert.throws(() => requestCheck(file, 'ABC-1'), /Not a KAZ or RPG issue/)
    new Store(file).close()
    for (let n = 1; n <= MAX_PENDING_REQUESTS; n++) requestCheck(file, `KAZ-${n}`)
    assert.equal(requestCheck(file, 'https://x.atlassian.net/browse/KAZ-1'), 'KAZ-1', 'asked again: replaced, not added')
    assert.throws(() => requestCheck(file, 'KAZ-999'), /already waiting/)
  })
  it('takes a post from the UI only for a comment not in Jira, and only the one the person read', () => {
    const dir = tempDir()
    const file = join(dir, 'db.sqlite')
    assert.throws(() => requestPost(file, 'KAZ-1', 't'), /No database/)
    const s = new Store(file)
    s.recordResult(ref('KAZ-1'), { ...result, status: 'dry_run', comment: 'Please add: HAR file' })
    s.recordResult(ref('KAZ-2'), result)
    s.recordResult(ref('KAZ-3'), { ...result, status: 'commented', comment: 'posted', commentId: '9' })
    const checkedAt = (key: string): string => {
      const db = new DatabaseSync(file, { readOnly: true })
      try {
        return (db.prepare('SELECT checked_at AS at FROM checks WHERE key = ?').get(key) as { at: string }).at
      } finally {
        db.close()
      }
    }
    assert.throws(() => requestPost(file, 'KAZ-1', '2026-01-01T00:00:00.000Z'), /checked again after the page was shown/)
    assert.equal(requestPost(file, 'kaz-1', checkedAt('KAZ-1')), 'KAZ-1')
    assert.deepEqual(
      s.posts().map((p) => [p.key, p.comment, p.error]),
      [['KAZ-1', 'Please add: HAR file', null]],
    )
    assert.throws(() => requestPost(file, 'KAZ-2', checkedAt('KAZ-2')), /no comment to post/)
    assert.throws(() => requestPost(file, 'KAZ-3', checkedAt('KAZ-3')), /already in Jira/)
    assert.throws(() => requestPost(file, 'KAZ-4', 't'), /not in the database/)
    s.close()
  })
  it('a result after a failure closes the bug; posting becomes commented', () => {
    const s = new Store(':memory:')
    s.recordFailure(ref('KAZ-4'), 'boom', 3)
    s.recordResult(ref('KAZ-4'), { ...result, status: 'posting', comment: 'hi' })
    s.markCommented('KAZ-4', '42')
    assert.deepEqual(s.rows(['KAZ-4']).get('KAZ-4'), { status: 'commented', fingerprint: 'f1', comment: 'hi', commentId: '42', runs: 2 })
  })
  it('a re-check updates the state and keeps the comment id; a failed one changes nothing but the error', () => {
    const s = new Store(':memory:')
    s.recordResult(ref('KAZ-6'), { ...result, status: 'posting', comment: 'v1' })
    s.markCommented('KAZ-6', '42')
    s.recordRecheckFailure('KAZ-6', 'agent run timed out')
    assert.deepEqual(s.rows(['KAZ-6']).get('KAZ-6'), { status: 'commented', fingerprint: 'f1', comment: 'v1', commentId: '42', runs: 2 })
    s.recordResult(ref('KAZ-6'), { ...result, status: 'commented', fingerprint: 'f2', comment: 'v2', commentId: '42' })
    assert.deepEqual(s.rows(['KAZ-6']).get('KAZ-6'), { status: 'commented', fingerprint: 'f2', comment: 'v2', commentId: '42', runs: 3 })
  })
  it('refresh: the row follows the report (summary, reporter, field checks), the state and the fingerprint stay', () => {
    const file = join(tempDir(), 'refresh.sqlite')
    const s = new Store(file)
    const r4 = (passed: boolean) => ({ id: 'R4', passed, detail: passed ? 'Affects versions: 5.11' : 'Affects versions is empty' })
    const r6 = (passed: boolean) => ({ id: 'R6', passed, detail: passed ? 'HAR attached' : 'no .har attachment' })
    s.recordResult(ref('KAZ-7'), { ...result, fieldChecks: [r4(false), r6(true)] })
    s.recordFailure(ref('KAZ-8'), 'agent run timed out', 3)
    s.bootstrap([ref('KAZ-9')])
    const seen = (key: string, checks: ReturnType<typeof r4>[], summary = 'Ports table is empty') => ({
      key,
      summary,
      reporter: 'A Tester',
      fieldChecks: checks,
    })
    assert.deepEqual(
      s.refresh([seen('KAZ-7', [r4(false), r6(true)]), seen('KAZ-8', [r4(true)]), seen('KAZ-9', [r4(true)])]),
      [],
      'nothing changed',
    )
    assert.deepEqual(s.refresh([seen('KAZ-7', [r4(true), r6(false)], 'Ports table is empty (5.11)')]), [
      { key: 'KAZ-7', passed: ['R4'], failed: ['R6'] },
    ])
    assert.deepEqual(
      s.refresh([seen('KAZ-7', [r4(true), r6(false)], 'Ports table stays empty')]),
      [],
      'a new summary alone is written in silence',
    )
    s.close()
    const db = new DatabaseSync(file)
    const row = db.prepare('SELECT status, summary, fingerprint, base_checks AS checks FROM checks WHERE key = ?').get('KAZ-7')
    assert.deepEqual(
      { ...row },
      { status: 'understood', summary: 'Ports table stays empty', fingerprint: 'f1', checks: JSON.stringify([r4(true), r6(false)]) },
    )
    const never = db
      .prepare('SELECT status, summary, base_checks AS checks FROM checks WHERE key IN (?, ?) ORDER BY key')
      .all('KAZ-8', 'KAZ-9')
    assert.deepEqual(
      never.map((n) => ({ ...n })),
      [
        { status: 'retry', summary: null, checks: null },
        { status: 'skipped', summary: null, checks: null },
      ],
      'a row never checked has nothing to follow',
    )
  })
  it('a bug moved to the other project keeps its row and history under the new key; an old row gets its id', () => {
    const s = new Store(':memory:')
    s.recordResult(ref('RPG-6223'), result)
    assert.deepEqual(s.track([{ id: 'id-RPG-6223', key: 'KAZ-9040' }]), [{ from: 'RPG-6223', to: 'KAZ-9040' }])
    assert.deepEqual(s.rows(['KAZ-9040']).get('KAZ-9040'), {
      status: 'understood',
      fingerprint: 'f1',
      comment: null,
      commentId: null,
      runs: 1,
    })
    assert.deepEqual(s.track([{ id: 'id-RPG-6223', key: 'KAZ-9040' }]), [], 'nothing moves twice')
  })
  it('opens a database made before meta and the late columns, and treats its rows as the first start', () => {
    const dir = tempDir()
    const file = join(dir, 'old.sqlite')
    const old = new DatabaseSync(file)
    old.exec(
      'CREATE TABLE checks (key TEXT PRIMARY KEY, status TEXT NOT NULL, attempts INTEGER NOT NULL DEFAULT 0, checked_at TEXT, base_checks TEXT, verdict TEXT, comment TEXT, comment_id TEXT, error TEXT)',
    )
    old.exec("INSERT INTO checks (key, status, checked_at, comment) VALUES ('KAZ-1', 'dry_run', 't', 'old comment')")
    old.close()

    const s = new Store(file)
    assert.equal(s.isBootstrapped(), true)
    assert.equal(readdirSync(dir).filter((f) => f.startsWith('old.sqlite.before-v')).length, 1, 'a copy before migrating')
    assert.deepEqual(s.rows(['KAZ-1']).get('KAZ-1'), {
      status: 'dry_run',
      fingerprint: null,
      comment: 'old comment',
      commentId: null,
      runs: 0,
    })
    assert.deepEqual(s.track([ref('KAZ-1')]), [])
    assert.deepEqual(s.track([{ id: 'id-KAZ-1', key: 'RPG-2' }]), [{ from: 'KAZ-1', to: 'RPG-2' }], 'the old row got its id')
    s.recordResult(ref('KAZ-5'), { ...result, agent: { model: 'haiku', instructions: 'abc', costUsd: 0.002, turns: 3, durationMs: 900 } })
    s.close()
    const db = new DatabaseSync(file)
    const row = db.prepare("SELECT summary, reporter, fingerprint FROM checks WHERE key = 'KAZ-5'").get()
    assert.deepEqual({ ...row }, { summary: 'Ports table is empty', reporter: 'A Tester', fingerprint: 'f1' })
    const figures = db.prepare("SELECT model, instructions, cost_usd, turns, agent_ms FROM runs WHERE key = 'KAZ-5'").get()
    assert.deepEqual({ ...figures }, { model: 'haiku', instructions: 'abc', cost_usd: 0.002, turns: 3, agent_ms: 900 })
    assert.equal((db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version, 5)
    db.close()
    new Store(file).close()
    assert.equal(readdirSync(dir).filter((f) => f.startsWith('old.sqlite.before-v')).length, 1, 'no copy when there is nothing to migrate')
    assert.equal(Store.recordedComment(file, 'RPG-2'), 'old comment')
    assert.equal(Store.recordedComment(file, 'KAZ-404'), null)
  })
  it("migrates a database of the list's check: complete is understood, old verdicts take the new shape, old runs are version 1 without reasoning", () => {
    const file = join(tempDir(), 'v3.sqlite')
    new Store(file).close()
    const db = new DatabaseSync(file)
    for (const column of ['webui_commit', 'files', 'version', 'reasoning']) db.exec(`ALTER TABLE runs DROP COLUMN ${column}`)
    db.exec('PRAGMA user_version = 3')
    db.exec(`INSERT INTO checks (key, issue_id, status, checked_at, verdict, comment) VALUES
      ('KAZ-1', 'i1', 'complete', 't', '{"comment_needed":false,"comment":"","missing":[],"related":[]}', NULL),
      ('KAZ-2', 'i2', 'dry_run', 't', '{"comment_needed":true,"comment":"[~accountid:r]\\nPlease add:\\n- HAR file","missing":["R6"],"related":[{"key":"KAZ-1","reason":"same"}]}', 'c')`)
    db.exec(
      `INSERT INTO runs (key, at, verdict, comment) VALUES ('KAZ-2', 't', '{"comment_needed":true,"comment":"c","missing":["R6"],"related":[]}', 'c'), ('KAZ-3', 't', 'broken', NULL)`,
    )
    db.close()
    const s = new Store(file)
    assert.equal(statusOf(s, 'KAZ-1'), 'understood')
    const read = new DatabaseSync(file, { readOnly: true })
    const verdicts = (read.prepare('SELECT verdict FROM checks ORDER BY key').all() as { verdict: string }[]).map((r) =>
      JSON.parse(r.verdict),
    )
    assert.deepEqual(verdicts, [
      { outcome: 'understood', reason: '', comment: '', related: [] },
      { outcome: 'not_understood', reason: '', comment: '[~accountid:r]\nPlease add:\n- HAR file', related: ['KAZ-1'] },
    ])
    const runs = read.prepare('SELECT key, verdict, version, reasoning FROM runs ORDER BY key').all() as {
      key: string
      verdict: string
      version: number
      reasoning: string | null
    }[]
    assert.deepEqual(
      runs.map((r) => [r.key, r.version, r.reasoning]),
      [
        ['KAZ-2', 1, null],
        ['KAZ-3', 1, null],
      ],
    )
    assert.equal(runs[1]!.verdict, '"broken"', 'a broken verdict is kept, as a string')
    s.recordResult(ref('KAZ-4'), result)
    assert.deepEqual(
      { ...read.prepare("SELECT version, webui_commit, files, reasoning FROM runs WHERE key = 'KAZ-4'").get() },
      { version: 2, webui_commit: 'abc', files: '[]', reasoning: 'Ports.vue filters the rows out' },
    )
    read.close()
    s.close()
    assert.ok(
      readdirSync(dirname(file)).some((f) => f.startsWith('v3.sqlite.before-v5-')),
      'a copy before the migration',
    )
  })
  it('backs up a database while it is open', () => {
    const dir = tempDir()
    const s = new Store(join(dir, 'db.sqlite'))
    s.recordResult(ref('KAZ-1'), result)
    Store.backup(join(dir, 'db.sqlite'), join(dir, 'copy.sqlite'))
    s.close()
    assert.equal(new Store(join(dir, 'copy.sqlite')).count(), 1)
  })
})
