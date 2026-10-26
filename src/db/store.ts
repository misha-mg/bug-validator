import { existsSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

/** A bug as the query names it. The id survives a move between KAZ and RPG; the key changes with it. */
export interface IssueRef {
  id: string;
  key: string;
}

/** A row's status: docs/architecture.md, Row statuses. */
export type CheckStatus = 'skipped' | 'complete' | 'dry_run' | 'posting' | 'commented' | 'retry' | 'failed';

/** A bug's row as the poll needs it to decide on a check. */
export interface BugRow {
  status: CheckStatus;
  /** The report's fingerprint at the last check; null on rows from before fingerprints were kept. */
  fingerprint: string | null;
  comment: string | null;
  commentId: string | null;
  /** Checks run on the bug, failed ones included. */
  runs: number;
}

export interface CheckResultRow {
  status: Extract<CheckStatus, 'complete' | 'dry_run' | 'posting' | 'commented'>;
  /** The bug's summary and reporter at the check, for the UI. */
  summary: string;
  reporter: string | null;
  fingerprint: string;
  baseChecks: unknown;
  verdict: unknown;
  comment: string | null;
  /** The comment in Jira, kept when a re-check edits it; null until a comment is posted. */
  commentId: string | null;
}

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
`;

// Columns added after the first database was made; an older one gets them when opened.
const ADDED_COLUMNS = ['summary TEXT', 'reporter TEXT', 'issue_id TEXT', 'fingerprint TEXT'];

const now = (): string => new Date().toISOString();

/** A check asked for by hand (`request <KEY>`, the UI), pending until the service takes it or failed to be. */
export interface CheckRequest {
  key: string;
  at: string;
  /** Why the service could not check it (no such issue); null while pending. */
  error: string | null;
}

/**
 * One row per bug the service has dealt with, its current state; one row in `runs` per check of
 * it, the history; `meta`; and `requests`, the checks asked for by hand. A bug's row is the only
 * thing that stops a second comment, so rows are never deleted; a request is the way to re-run a
 * bug.
 */
export class Store {
  private readonly db: DatabaseSync;

  constructor(file: string) {
    if (file !== ':memory:') mkdirSync(dirname(file), { recursive: true });
    // The UI reads the file while the service writes it: WAL lets both happen, the timeout
    // waits out the rare overlap instead of failing the write.
    this.db = new DatabaseSync(file, { timeout: 5000 });
    this.db.exec('PRAGMA journal_mode = WAL');
    this.db.exec(SCHEMA);
    const columns = this.db.prepare('PRAGMA table_info(checks)').all() as { name: string }[];
    const have = new Set(columns.map((c) => c.name));
    for (const column of ADDED_COLUMNS) {
      const name = column.split(' ')[0] ?? column;
      if (!have.has(name)) this.db.exec(`ALTER TABLE checks ADD COLUMN ${column}`);
    }
    // After the columns: an older database has no issue_id until the loop above adds it.
    this.db.exec('CREATE UNIQUE INDEX IF NOT EXISTS checks_issue_id ON checks (issue_id)');
    // A database from before `meta` existed has done its first start: it has rows.
    if (!this.isBootstrapped() && !this.isEmpty()) this.setMeta('bootstrapped_at', now());
  }

  /** The comment recorded for a bug, read without opening the database for writing (`check --recheck`). */
  static recordedComment(file: string, key: string): string | null {
    if (!existsSync(file)) return null;
    const db = new DatabaseSync(file, { readOnly: true });
    try {
      const row = db.prepare('SELECT comment FROM checks WHERE key = ?').get(key) as { comment: string | null } | undefined;
      return row?.comment ?? null;
    } finally {
      db.close();
    }
  }

  /** True once the first poll has recorded what was already in the query (a lost database starts over). */
  isBootstrapped(): boolean {
    return this.getMeta('bootstrapped_at') !== null;
  }

  /** The first poll: every bug already in the query is skipped, whatever their number. */
  bootstrap(issues: IssueRef[]): void {
    const insert = this.db.prepare("INSERT OR IGNORE INTO checks (key, issue_id, status, checked_at) VALUES (?, ?, 'skipped', ?)");
    const at = now();
    for (const issue of issues) insert.run(issue.key, issue.id, at);
    this.setMeta('bootstrapped_at', at);
  }

  /**
   * Brings rows up to date with the query, before anything is checked: a bug moved to the other
   * project keeps its row and its history under the new key, so it is not checked as a new bug.
   * A row from before ids were stored gets its id here. Returns the moves.
   */
  track(issues: IssueRef[]): { from: string; to: string }[] {
    const byId = this.db.prepare('SELECT key FROM checks WHERE issue_id = ?');
    const rename = this.db.prepare('UPDATE checks SET key = ? WHERE issue_id = ?');
    const renameRuns = this.db.prepare('UPDATE runs SET key = ? WHERE key = ?');
    const fillId = this.db.prepare('UPDATE checks SET issue_id = ? WHERE key = ? AND issue_id IS NULL');
    const moves: { from: string; to: string }[] = [];
    for (const issue of issues) {
      const row = byId.get(issue.id) as { key: string } | undefined;
      if (row && row.key !== issue.key) {
        this.transaction(() => {
          rename.run(issue.key, issue.id);
          renameRuns.run(issue.key, row.key);
        });
        moves.push({ from: row.key, to: issue.key });
      } else if (!row) {
        fillId.run(issue.id, issue.key);
      }
    }
    return moves;
  }

  /** The rows of the bugs among `keys` that have one. */
  rows(keys: string[]): Map<string, BugRow> {
    if (keys.length === 0) return new Map();
    const marks = keys.map(() => '?').join(',');
    const rows = this.db
      .prepare(
        `SELECT key, status, fingerprint, comment, comment_id AS commentId, (SELECT COUNT(*) FROM runs WHERE runs.key = checks.key) AS runs
         FROM checks WHERE key IN (${marks})`,
      )
      .all(...keys) as unknown as (BugRow & { key: string })[];
    return new Map(rows.map(({ key, ...row }) => [key, row]));
  }

  /** One more failed attempt at the first check: `retry`, or `failed` once the limit is reached. */
  recordFailure(issue: IssueRef, error: string, maxAttempts: number): { status: CheckStatus; attempts: number } {
    return this.transaction(() => {
      const at = now();
      this.addRun(issue.key, at, { error });
      const row = this.db
        .prepare(
          `INSERT INTO checks (key, issue_id, status, attempts, checked_at, error) VALUES (?, ?, 'retry', 1, ?, ?)
           ON CONFLICT(key) DO UPDATE SET
             attempts = attempts + 1,
             status = CASE WHEN attempts + 1 >= ? THEN 'failed' ELSE 'retry' END,
             checked_at = excluded.checked_at, error = excluded.error
           RETURNING status, attempts`,
        )
        .get(issue.key, issue.id, at, error, maxAttempts) as { status: CheckStatus; attempts: number };
      return { status: row.status, attempts: row.attempts };
    });
  }

  /** A failed re-check: recorded, and the bug's state (its comment above all) stays as it was. */
  recordRecheckFailure(key: string, error: string): void {
    this.transaction(() => {
      this.addRun(key, now(), { error });
      this.db.prepare('UPDATE checks SET error = ? WHERE key = ?').run(error, key);
    });
  }

  /** A finished check, first or re-check: the bug's new state and one more run. */
  recordResult(issue: IssueRef, r: CheckResultRow): void {
    this.transaction(() => {
      const at = now();
      this.addRun(issue.key, at, { fingerprint: r.fingerprint, baseChecks: r.baseChecks, verdict: r.verdict, comment: r.comment });
      this.db
        .prepare(
          `INSERT INTO checks (key, issue_id, status, attempts, checked_at, summary, reporter, fingerprint, base_checks, verdict, comment, comment_id, error)
           VALUES (?, ?, ?, 1, ?, ?, ?, ?, ?, ?, ?, ?, NULL)
           ON CONFLICT(key) DO UPDATE SET status = excluded.status, attempts = attempts + 1, checked_at = excluded.checked_at,
             summary = excluded.summary, reporter = excluded.reporter, fingerprint = excluded.fingerprint, base_checks = excluded.base_checks,
             verdict = excluded.verdict, comment = excluded.comment, comment_id = excluded.comment_id, error = NULL`,
        )
        .run(issue.key, issue.id, r.status, at, r.summary, r.reporter, r.fingerprint, JSON.stringify(r.baseChecks), JSON.stringify(r.verdict), r.comment, r.commentId);
    });
  }

  /** The comment is in Jira: `posting` → `commented`. */
  markCommented(key: string, commentId: string): void {
    this.db.prepare("UPDATE checks SET status = 'commented', comment_id = ? WHERE key = ?").run(commentId, key);
  }

  /** Asks for a check of the bug; a request already pending or failed for the key is replaced. */
  request(key: string): void {
    this.db.prepare('INSERT OR REPLACE INTO requests (key, at, error) VALUES (?, ?, NULL)').run(key, now());
  }

  /** Every request, oldest first: the pending ones and the ones the service could not serve. */
  requests(): CheckRequest[] {
    return this.db.prepare('SELECT key, at, error FROM requests ORDER BY at, rowid').all() as unknown as CheckRequest[];
  }

  /** The request is served: the check's outcome is in the bug's row. */
  requestDone(key: string): void {
    this.db.prepare('DELETE FROM requests WHERE key = ?').run(key);
  }

  /** The request cannot be served (no such issue); kept with the reason until it is replaced. */
  requestFailed(key: string, error: string): void {
    this.db.prepare('UPDATE requests SET error = ? WHERE key = ?').run(error, key);
  }

  status(key: string): CheckStatus | null {
    const row = this.db.prepare('SELECT status FROM checks WHERE key = ?').get(key) as { status: CheckStatus } | undefined;
    return row?.status ?? null;
  }

  close(): void {
    this.db.close();
  }

  private addRun(key: string, at: string, run: { fingerprint?: string; baseChecks?: unknown; verdict?: unknown; comment?: string | null; error?: string }): void {
    const json = (value: unknown): string | null => (value === undefined ? null : JSON.stringify(value));
    this.db
      .prepare('INSERT INTO runs (key, at, fingerprint, base_checks, verdict, comment, error) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(key, at, run.fingerprint ?? null, json(run.baseChecks), json(run.verdict), run.comment ?? null, run.error ?? null);
  }

  private transaction<T>(fn: () => T): T {
    this.db.exec('BEGIN');
    try {
      const result = fn();
      this.db.exec('COMMIT');
      return result;
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
  }

  private isEmpty(): boolean {
    return (this.db.prepare('SELECT COUNT(*) AS n FROM checks').get() as { n: number }).n === 0;
  }

  private getMeta(key: string): string | null {
    const row = this.db.prepare('SELECT value FROM meta WHERE key = ?').get(key) as { value: string } | undefined;
    return row?.value ?? null;
  }

  private setMeta(key: string, value: string): void {
    this.db.prepare('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, value);
  }
}
