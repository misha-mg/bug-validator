import { existsSync, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { issueKey } from '../domain/key.ts'

/** A bug as the query names it. The id survives a move between KAZ and RPG; the key changes with it. */
export interface IssueRef {
  id: string
  key: string
}

/** A row's status: .about/architecture.md, Row statuses. */
export type CheckStatus = 'skipped' | 'understood' | 'not_webui' | 'dry_run' | 'posting' | 'commented' | 'retry' | 'failed'

/** The check as it is now: 1 judged the report against the list, 2 reads the code (prd.md, 2026-11-03). */
const CHECK_VERSION = 2

/** A bug's row as the poll needs it to decide on a check. */
export interface BugRow {
  status: CheckStatus
  /** The report's fingerprint at the last check; null on rows from before fingerprints were kept. */
  fingerprint: string | null
  comment: string | null
  commentId: string | null
  /** Checks run on the bug, failed ones included. */
  runs: number
}

export interface CheckResultRow {
  status: Extract<CheckStatus, 'understood' | 'not_webui' | 'dry_run' | 'posting' | 'commented'>
  /** The bug's summary and reporter at the check, for the UI. */
  summary: string
  reporter: string | null
  fingerprint: string
  fieldChecks: unknown
  verdict: unknown
  comment: string | null
  /** The comment in Jira, kept when a re-check edits it; null until a comment is posted. */
  commentId: string | null
  /** The WebUI commit the agent read, and the files it got of the attachments. */
  webuiCommit: string
  files: unknown
  agent?: RunFigures
}

// The tables as the first database had them; later versions are migrations below.
const SCHEMA = `
CREATE TABLE IF NOT EXISTS checks (
  key         TEXT PRIMARY KEY,
  issue_id    TEXT,
  status      TEXT NOT NULL,
  attempts    INTEGER NOT NULL DEFAULT 0,
  checked_at  TEXT NOT NULL,
  summary     TEXT,
  reporter    TEXT,
  fingerprint TEXT,
  base_checks TEXT,
  verdict     TEXT,
  comment     TEXT,
  comment_id  TEXT,
  error       TEXT
);
CREATE INDEX IF NOT EXISTS checks_status ON checks (status);
CREATE TABLE IF NOT EXISTS runs (
  key         TEXT NOT NULL,
  at          TEXT NOT NULL,
  fingerprint TEXT,
  base_checks TEXT,
  verdict     TEXT,
  comment     TEXT,
  error       TEXT
);
CREATE INDEX IF NOT EXISTS runs_key ON runs (key);
CREATE TABLE IF NOT EXISTS meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS requests (
  key   TEXT PRIMARY KEY,
  at    TEXT NOT NULL,
  error TEXT
);
`

/**
 * The schema's versions, in order; `PRAGMA user_version` says how many a database has had. Only
 * the service migrates (`new Store`); the UI and `check` open the file without changing it.
 */
const MIGRATIONS: ((db: DatabaseSync) => void)[] = [
  // 1: the tables, and the columns databases from before 2026-10-26 lack.
  (db) => {
    db.exec(SCHEMA)
    const have = new Set((db.prepare('PRAGMA table_info(checks)').all() as { name: string }[]).map((c) => c.name))
    for (const column of ['summary TEXT', 'reporter TEXT', 'issue_id TEXT', 'fingerprint TEXT']) {
      if (!have.has(column.split(' ')[0]!)) db.exec(`ALTER TABLE checks ADD COLUMN ${column}`)
    }
    db.exec('CREATE UNIQUE INDEX IF NOT EXISTS checks_issue_id ON checks (issue_id)')
  },
  // 2: `attempts` counts the failed first checks since the last result, not every check; a
  // request remembers how often the surroundings failed it; a run records the agent's figures.
  (db) => {
    db.exec("UPDATE checks SET attempts = 0 WHERE status NOT IN ('retry', 'failed')")
    db.exec('ALTER TABLE requests ADD COLUMN tries INTEGER NOT NULL DEFAULT 0')
    for (const column of ['model TEXT', 'instructions TEXT', 'cost_usd REAL', 'turns INTEGER', 'agent_ms INTEGER'])
      db.exec(`ALTER TABLE runs ADD COLUMN ${column}`)
  },
  // 3: comments a person posts by hand from the UI, in a dry run as well.
  (db) => {
    db.exec(
      'CREATE TABLE posts (key TEXT PRIMARY KEY, at TEXT NOT NULL, comment TEXT NOT NULL, error TEXT, tries INTEGER NOT NULL DEFAULT 0)',
    )
  },
  // 4: the check by code. `complete` is `understood`; a run records the WebUI commit, the files
  // and the check's version; a verdict of the list's check is kept in the shape of the new one.
  (db) => {
    db.exec("UPDATE checks SET status = 'understood' WHERE status = 'complete'")
    for (const column of ['webui_commit TEXT', 'files TEXT', 'version INTEGER NOT NULL DEFAULT 1'])
      db.exec(`ALTER TABLE runs ADD COLUMN ${column}`)
    for (const table of ['checks', 'runs']) {
      const rows = db.prepare(`SELECT rowid, verdict FROM ${table} WHERE verdict IS NOT NULL`).all() as { rowid: number; verdict: string }[]
      const update = db.prepare(`UPDATE ${table} SET verdict = ? WHERE rowid = ?`)
      for (const row of rows) update.run(JSON.stringify(listVerdict(row.verdict)), row.rowid)
    }
  },
]

/** A verdict of the list's check (comment_needed, missing, related with reasons) in the new shape; a broken one is left as it is. */
function listVerdict(text: string): unknown {
  let old: { comment_needed?: boolean; comment?: string; related?: { key: string }[]; outcome?: string }
  try {
    old = JSON.parse(text) as typeof old
  } catch {
    return text
  }
  if (typeof old !== 'object' || old === null || 'outcome' in old) return old
  const comment = old.comment_needed && old.comment ? old.comment : ''
  return { outcome: comment ? 'not_understood' : 'understood', reason: '', comment, related: (old.related ?? []).map((r) => r.key) }
}

const now = (): string => new Date().toISOString()

/** What the agent spent on a check: stored with its run. */
export interface RunFigures {
  model?: string | undefined
  instructions?: string | undefined
  costUsd: number
  turns: number
  durationMs: number
}

/** A check asked for by hand (`request <KEY>`, the UI), pending until the service takes it or failed to be. */
export interface CheckRequest {
  key: string
  at: string
  /** Why the service could not check it (no such issue); null while pending. */
  error: string | null
}

/**
 * A comment a person asked to post (the UI's Post button): the text they confirmed, pending until
 * the service posts it, or failed to be.
 */
export interface PostRequest {
  key: string
  at: string
  comment: string
  /** Why the service did not post it; null while pending. */
  error: string | null
}

/** Pending requests at most: a form is for a person asking for a few bugs, not for a script. */
export const MAX_PENDING_REQUESTS = 20
/** A request the surroundings failed this many times in a row fails, so it stops holding up the rest. */
const MAX_REQUEST_TRIES = 3

/**
 * Asks the service to check a bug: by key or by a link to it. Written to the service's database,
 * so the service must have made it. Returns the key.
 */
export function requestCheck(dbFile: string, text: string): string {
  const key = issueKey(text)
  if (!key) throw new Error(`Not a KAZ or RPG issue: ${text.trim().slice(0, 100) || '(nothing)'}`)
  Store.addRequest(dbFile, key)
  return key
}

/**
 * Asks the service to post a bug's recorded comment to Jira, in a dry run as well. `checkedAt` is
 * the check whose comment the person read and confirmed: a check made since (a re-check that
 * changed the comment) refuses the post. Returns the key.
 */
export function requestPost(dbFile: string, text: string, checkedAt: string): string {
  const key = issueKey(text)
  if (!key) throw new Error(`Not a KAZ or RPG issue: ${text.trim().slice(0, 100) || '(nothing)'}`)
  Store.addPost(dbFile, key, checkedAt)
  return key
}

/**
 * One row per bug the service has dealt with, its current state; one row in `runs` per check of
 * it, the history; `meta`; `requests`, the checks asked for by hand; and `posts`, the comments a
 * person posts from the UI. A bug's row keeps it from
 * being checked as a new bug (the lookup in Jira before a post is what stops a second comment), so
 * rows are never deleted; a request is the way to re-run a bug.
 */
export class Store {
  private readonly db: DatabaseSync

  constructor(file: string) {
    if (file !== ':memory:') mkdirSync(dirname(file), { recursive: true })
    const existed = file !== ':memory:' && existsSync(file)
    // The UI reads the file while the service writes it: WAL lets both happen, the timeout
    // waits out the rare overlap instead of failing the write.
    this.db = new DatabaseSync(file, { timeout: 5000 })
    this.db.exec('PRAGMA journal_mode = WAL')
    const version = (this.db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version
    if (version < MIGRATIONS.length && existed) {
      // A copy as it was, in case a migration goes wrong: the rows are what stops a second comment.
      const copy = `${file}.before-v${MIGRATIONS.length}-${now().replace(/[:.]/g, '')}`
      this.db.exec(`VACUUM INTO '${copy.replaceAll("'", "''")}'`)
    }
    for (let v = version; v < MIGRATIONS.length; v++) {
      this.transaction(() => {
        MIGRATIONS[v]!(this.db)
        this.db.exec(`PRAGMA user_version = ${v + 1}`)
      })
    }
    // A database from before `meta` existed has done its first start: it has rows.
    if (!this.isBootstrapped() && !this.isEmpty()) this.setMeta('bootstrapped_at', now())
  }

  /**
   * Asks the running service to check a bug: one row in `requests`, nothing else. The UI and the
   * command line write it; the database must exist and be the service's own (never created here:
   * a stray empty database would look like a first start to the service).
   */
  static addRequest(file: string, key: string): void {
    if (!existsSync(file)) throw new Error(`No database at ${file}: the service has not started yet`)
    const db = new DatabaseSync(file, { timeout: 5000 })
    try {
      const table = db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'requests'").get()
      if (!table) throw new Error(`The database at ${file} has no requests table: is the service up to date?`)
      const { n } = db.prepare('SELECT COUNT(*) AS n FROM requests WHERE error IS NULL AND key <> ?').get(key) as { n: number }
      if (n >= MAX_PENDING_REQUESTS) throw new Error(`${n} checks are already waiting; ask again when the service has made them`)
      db.prepare('INSERT OR REPLACE INTO requests (key, at, error) VALUES (?, ?, NULL)').run(key, now())
    } finally {
      db.close()
    }
  }

  /**
   * Asks the running service to post a bug's comment: one row in `posts` with the comment as it
   * is now, nothing else. Only a comment not in Jira can be posted (a `dry_run` row, or a
   * `posting` one whose post got no answer), and only the one the person saw: the row's last
   * check must be `checkedAt`.
   */
  static addPost(file: string, key: string, checkedAt: string): void {
    if (!existsSync(file)) throw new Error(`No database at ${file}: the service has not started yet`)
    const db = new DatabaseSync(file, { timeout: 5000 })
    try {
      const table = db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'posts'").get()
      if (!table) throw new Error(`The database at ${file} has no posts table: is the service up to date?`)
      // IMMEDIATE: the row read is the row the post is asked for, whatever the service writes meanwhile.
      db.exec('BEGIN IMMEDIATE')
      try {
        const row = db
          .prepare('SELECT status, comment, comment_id AS commentId, checked_at AS checkedAt FROM checks WHERE key = ?')
          .get(key) as { status: CheckStatus; comment: string | null; commentId: string | null; checkedAt: string } | undefined
        if (!row) throw new Error(`${key} is not in the database`)
        if (row.commentId !== null) throw new Error(`${key}: the comment is already in Jira`)
        if (!row.comment || (row.status !== 'dry_run' && row.status !== 'posting')) throw new Error(`${key} has no comment to post`)
        if (new Date(row.checkedAt).getTime() !== new Date(checkedAt).getTime())
          throw new Error(`${key} was checked again after the page was shown: read the comment again`)
        db.prepare('INSERT OR REPLACE INTO posts (key, at, comment, error, tries) VALUES (?, ?, ?, NULL, 0)').run(key, now(), row.comment)
        db.exec('COMMIT')
      } catch (err) {
        db.exec('ROLLBACK')
        throw err
      }
    } finally {
      db.close()
    }
  }

  /** A consistent copy of the database, taken while the service runs (`maintain`). */
  static backup(file: string, to: string): void {
    const db = new DatabaseSync(file, { readOnly: true, timeout: 5000 })
    try {
      db.exec(`VACUUM INTO '${to.replaceAll("'", "''")}'`)
    } finally {
      db.close()
    }
  }

  /** The comment recorded for a bug, read without opening the database for writing (`check --recheck`). */
  static recordedComment(file: string, key: string): string | null {
    if (!existsSync(file)) return null
    const db = new DatabaseSync(file, { readOnly: true })
    try {
      const row = db.prepare('SELECT comment FROM checks WHERE key = ?').get(key) as { comment: string | null } | undefined
      return row?.comment ?? null
    } finally {
      db.close()
    }
  }

  /** How many bugs have a row: logged at start, so a database that is not the expected one shows. */
  count(): number {
    return (this.db.prepare('SELECT COUNT(*) AS n FROM checks').get() as { n: number }).n
  }

  /**
   * The service is alive: its pid, when it started and when it last said so, in `meta`. Written
   * every few seconds and at every poll; the UI calls the service running while it is fresh.
   */
  heartbeat(pid: number, startedAt: string, seenAt = now()): void {
    this.transaction(() => {
      this.setMeta('heartbeat_pid', String(pid))
      this.setMeta('heartbeat_started_at', startedAt)
      this.setMeta('heartbeat_seen_at', seenAt)
    })
  }

  /** True once the first poll has recorded what was already in the query (a lost database starts over). */
  isBootstrapped(): boolean {
    return this.getMeta('bootstrapped_at') !== null
  }

  /** The first poll: every bug already in the query is skipped, whatever their number. */
  bootstrap(issues: IssueRef[]): void {
    const insert = this.db.prepare("INSERT OR IGNORE INTO checks (key, issue_id, status, checked_at) VALUES (?, ?, 'skipped', ?)")
    const at = now()
    for (const issue of issues) insert.run(issue.key, issue.id, at)
    this.setMeta('bootstrapped_at', at)
  }

  /**
   * Brings rows up to date with the query, before anything is checked: a bug moved to the other
   * project keeps its row and its history under the new key, so it is not checked as a new bug.
   * A row from before ids were stored gets its id here. Returns the moves.
   */
  track(issues: IssueRef[]): { from: string; to: string }[] {
    const byId = this.db.prepare('SELECT key FROM checks WHERE issue_id = ?')
    const rename = this.db.prepare('UPDATE checks SET key = ? WHERE issue_id = ?')
    const renameRuns = this.db.prepare('UPDATE runs SET key = ? WHERE key = ?')
    const fillId = this.db.prepare('UPDATE checks SET issue_id = ? WHERE key = ? AND issue_id IS NULL')
    const moves: { from: string; to: string }[] = []
    for (const issue of issues) {
      const row = byId.get(issue.id) as { key: string } | undefined
      if (row && row.key !== issue.key) {
        this.transaction(() => {
          rename.run(issue.key, issue.id)
          renameRuns.run(issue.key, row.key)
        })
        moves.push({ from: row.key, to: issue.key })
      } else if (!row) {
        fillId.run(issue.id, issue.key)
      }
    }
    return moves
  }

  /** The rows of the bugs among `keys` that have one. */
  rows(keys: string[]): Map<string, BugRow> {
    if (keys.length === 0) return new Map()
    const marks = keys.map(() => '?').join(',')
    const rows = this.db
      .prepare(
        `SELECT key, status, fingerprint, comment, comment_id AS commentId, (SELECT COUNT(*) FROM runs WHERE runs.key = checks.key) AS runs
         FROM checks WHERE key IN (${marks})`,
      )
      .all(...keys) as unknown as (BugRow & { key: string })[]
    return new Map(rows.map(({ key, ...row }) => [key, row]))
  }

  /** One more failed attempt at the first check: `retry`, or `failed` once the limit is reached. */
  recordFailure(issue: IssueRef, error: string, maxAttempts: number): { status: CheckStatus; attempts: number } {
    return this.transaction(() => {
      const at = now()
      this.addRun(issue.key, at, { error })
      const row = this.db
        .prepare(
          `INSERT INTO checks (key, issue_id, status, attempts, checked_at, error) VALUES (?, ?, 'retry', 1, ?, ?)
           ON CONFLICT(key) DO UPDATE SET
             attempts = attempts + 1,
             status = CASE WHEN attempts + 1 >= ? THEN 'failed' ELSE 'retry' END,
             checked_at = excluded.checked_at, error = excluded.error
           RETURNING status, attempts`,
        )
        .get(issue.key, issue.id, at, error, maxAttempts) as { status: CheckStatus; attempts: number }
      return { status: row.status, attempts: row.attempts }
    })
  }

  /** A failed re-check: recorded, and the bug's state (its comment above all) stays as it was. */
  recordRecheckFailure(key: string, error: string): void {
    this.transaction(() => {
      this.addRun(key, now(), { error })
      this.db.prepare('UPDATE checks SET error = ? WHERE key = ?').run(error, key)
    })
  }

  /** A finished check, first or re-check: the bug's new state and one more run. A comment id, once known, is never forgotten. */
  recordResult(issue: IssueRef, r: CheckResultRow): void {
    this.transaction(() => {
      const at = now()
      this.addRun(issue.key, at, {
        fingerprint: r.fingerprint,
        fieldChecks: r.fieldChecks,
        verdict: r.verdict,
        comment: r.comment,
        webuiCommit: r.webuiCommit,
        files: r.files,
        agent: r.agent,
      })
      this.db
        .prepare(
          `INSERT INTO checks (key, issue_id, status, attempts, checked_at, summary, reporter, fingerprint, base_checks, verdict, comment, comment_id, error)
           VALUES (?, ?, ?, 0, ?, ?, ?, ?, ?, ?, ?, ?, NULL)
           ON CONFLICT(key) DO UPDATE SET status = excluded.status, attempts = 0, checked_at = excluded.checked_at,
             summary = excluded.summary, reporter = excluded.reporter, fingerprint = excluded.fingerprint, base_checks = excluded.base_checks,
             verdict = excluded.verdict, comment = excluded.comment, comment_id = COALESCE(excluded.comment_id, comment_id), error = NULL`,
        )
        .run(
          issue.key,
          issue.id,
          r.status,
          at,
          r.summary,
          r.reporter,
          r.fingerprint,
          JSON.stringify(r.fieldChecks),
          JSON.stringify(r.verdict),
          r.comment,
          r.commentId,
        )
    })
  }

  /**
   * A check recorded in the history only, the bug's row left as it is: a dry run's check of a bug
   * whose comment is (or may be) in Jira, so the record of that comment stays true to Jira.
   */
  recordRun(
    key: string,
    r: Pick<CheckResultRow, 'fingerprint' | 'fieldChecks' | 'verdict' | 'comment' | 'webuiCommit' | 'files' | 'agent'>,
  ): void {
    this.addRun(key, now(), r)
  }

  /** The comment is in Jira: `posting` → `commented`. `comment`: the text found there, when it was adopted. */
  markCommented(key: string, commentId: string, comment?: string): void {
    this.db
      .prepare("UPDATE checks SET status = 'commented', comment_id = ?, comment = COALESCE(?, comment) WHERE key = ?")
      .run(commentId, comment ?? null, key)
  }

  /** A post by hand is about to be sent: the row goes first, as for any post (handle.ts). */
  markPosting(key: string): void {
    this.db
      .prepare("UPDATE checks SET status = 'posting' WHERE key = ? AND comment_id IS NULL AND status IN ('dry_run', 'posting')")
      .run(key)
  }

  /** Jira refused a post by hand, so the comment does not exist: `posting` → `dry_run` as it was. */
  postRefusedByHand(key: string): void {
    this.db.prepare("UPDATE checks SET status = 'dry_run' WHERE key = ? AND status = 'posting'").run(key)
  }

  /**
   * Jira refused the post, so the comment does not exist: `posting` → back in line as `retry`.
   * The refusal is the run's error. It costs an attempt only when it was about this bug.
   */
  postRefused(key: string, error: string, maxAttempts: number, costsAttempt: boolean): { status: CheckStatus; attempts: number } {
    return this.transaction(() => {
      this.db.prepare('UPDATE runs SET error = ? WHERE rowid = (SELECT MAX(rowid) FROM runs WHERE key = ?)').run(error, key)
      const add = costsAttempt ? 1 : 0
      const row = this.db
        .prepare(
          `UPDATE checks SET attempts = attempts + ?, status = CASE WHEN attempts + ? >= ? THEN 'failed' ELSE 'retry' END, error = ?
           WHERE key = ? AND status = 'posting' RETURNING status, attempts`,
        )
        .get(add, add, maxAttempts, error, key) as { status: CheckStatus; attempts: number }
      return { status: row.status, attempts: row.attempts }
    })
  }

  /** Asks for a check of the bug; a request already pending or failed for the key is replaced. */
  request(key: string): void {
    this.db.prepare('INSERT OR REPLACE INTO requests (key, at, error, tries) VALUES (?, ?, NULL, 0)').run(key, now())
  }

  /** Every request, oldest first: the pending ones and the ones the service could not serve. */
  requests(): CheckRequest[] {
    return this.db.prepare('SELECT key, at, error FROM requests ORDER BY at, rowid').all() as unknown as CheckRequest[]
  }

  /** The request is served: the check's outcome is in the bug's row. One asked again meanwhile (a later `at`) stays. */
  requestDone(key: string, at: string): void {
    this.db.prepare('DELETE FROM requests WHERE key = ? AND at = ?').run(key, at)
  }

  /** The surroundings failed the request once more; after MAX_REQUEST_TRIES it fails. True when it failed. */
  requestTried(key: string, error: string): boolean {
    return this.tried('requests', key, error)
  }

  /** The request cannot be served (no such issue); kept with the reason until it is replaced. */
  requestFailed(key: string, error: string): void {
    this.db.prepare('UPDATE requests SET error = ? WHERE key = ?').run(error, key)
  }

  /** Asks for a post of the comment, as `addPost` does from outside the service; one pending or failed for the key is replaced. */
  post(key: string, comment: string): void {
    this.db.prepare('INSERT OR REPLACE INTO posts (key, at, comment, error, tries) VALUES (?, ?, ?, NULL, 0)').run(key, now(), comment)
  }

  /** Every post asked for, oldest first: the pending ones and the ones the service did not make. */
  posts(): PostRequest[] {
    return this.db.prepare('SELECT key, at, comment, error FROM posts ORDER BY at, rowid').all() as unknown as PostRequest[]
  }

  /** The post is made (or the comment was found in Jira): the bug's row says so. */
  postDone(key: string, at: string): void {
    this.db.prepare('DELETE FROM posts WHERE key = ? AND at = ?').run(key, at)
  }

  /** The surroundings failed the post once more; after MAX_REQUEST_TRIES it fails. True when it failed. */
  postTried(key: string, error: string): boolean {
    return this.tried('posts', key, error)
  }

  /** The post will not be made (the comment changed, Jira refused it); kept with the reason until it is asked again. */
  postFailed(key: string, error: string): void {
    this.db.prepare('UPDATE posts SET error = ? WHERE key = ?').run(error, key)
  }

  status(key: string): CheckStatus | null {
    const row = this.db.prepare('SELECT status FROM checks WHERE key = ?').get(key) as { status: CheckStatus } | undefined
    return row?.status ?? null
  }

  close(): void {
    this.db.close()
  }

  private tried(table: 'requests' | 'posts', key: string, error: string): boolean {
    const row = this.db.prepare(`UPDATE ${table} SET tries = tries + 1 WHERE key = ? RETURNING tries`).get(key) as
      { tries: number } | undefined
    if (!row || row.tries < MAX_REQUEST_TRIES) return false
    this.db.prepare(`UPDATE ${table} SET error = ? WHERE key = ?`).run(`failed ${row.tries} times: ${error}`, key)
    return true
  }

  private addRun(
    key: string,
    at: string,
    run: {
      fingerprint?: string
      fieldChecks?: unknown
      verdict?: unknown
      comment?: string | null
      error?: string
      webuiCommit?: string
      files?: unknown
      agent?: RunFigures | undefined
    },
  ): void {
    const json = (value: unknown): string | null => (value === undefined ? null : JSON.stringify(value))
    const a = run.agent
    this.db
      .prepare(
        'INSERT INTO runs (key, at, fingerprint, base_checks, verdict, comment, error, model, instructions, cost_usd, turns, agent_ms, webui_commit, files, version) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      )
      .run(
        key,
        at,
        run.fingerprint ?? null,
        json(run.fieldChecks),
        json(run.verdict),
        run.comment ?? null,
        run.error ?? null,
        a?.model ?? null,
        a?.instructions ?? null,
        a?.costUsd ?? null,
        a?.turns ?? null,
        a?.durationMs ?? null,
        run.webuiCommit ?? null,
        json(run.files),
        CHECK_VERSION,
      )
  }

  private transaction<T>(fn: () => T): T {
    this.db.exec('BEGIN')
    try {
      const result = fn()
      this.db.exec('COMMIT')
      return result
    } catch (err) {
      this.db.exec('ROLLBACK')
      throw err
    }
  }

  private isEmpty(): boolean {
    return (this.db.prepare('SELECT COUNT(*) AS n FROM checks').get() as { n: number }).n === 0
  }

  private getMeta(key: string): string | null {
    const row = this.db.prepare('SELECT value FROM meta WHERE key = ?').get(key) as { value: string } | undefined
    return row?.value ?? null
  }

  private setMeta(key: string, value: string): void {
    this.db.prepare('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, value)
  }
}
