import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

/** A bug as the query names it. The id survives a move between KAZ and RPG; the key changes with it. */
export interface IssueRef {
  id: string;
  key: string;
}

/** A row's status: docs/architecture.md, Row statuses. */
export type CheckStatus = 'skipped' | 'complete' | 'dry_run' | 'posting' | 'commented' | 'retry' | 'failed';

export interface CheckResultRow {
  status: Extract<CheckStatus, 'complete' | 'dry_run' | 'posting'>;
  /** The bug's summary and reporter at the check, for the TUI. */
  summary: string;
  reporter: string | null;
  baseChecks: unknown;
  verdict: unknown;
  comment: string | null;
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
  base_checks TEXT,
  verdict     TEXT,
  comment     TEXT,
  comment_id  TEXT,
  error       TEXT
);
CREATE INDEX IF NOT EXISTS checks_status ON checks (status);
CREATE TABLE IF NOT EXISTS meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
`;

// Columns added after the first database was made; an older one gets them when opened.
const ADDED_COLUMNS = ['summary TEXT', 'reporter TEXT', 'issue_id TEXT'];

const now = (): string => new Date().toISOString();

/**
 * One row per bug the service has dealt with, plus `meta`. A bug's row is the only thing that
 * stops a second comment, so rows are never deleted; `requeue` is the way to re-run a bug.
 */
export class Store {
  private readonly db: DatabaseSync;

  constructor(file: string) {
    if (file !== ':memory:') mkdirSync(dirname(file), { recursive: true });
    // The TUI reads the file while the service writes it: WAL lets both happen, the timeout
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
   * Brings rows up to date with the query, before anything is pending: a bug moved to the other
   * project keeps its row under the new key, so it is not checked a second time. A row from before
   * ids were stored gets its id here. Returns the moves.
   */
  track(issues: IssueRef[]): { from: string; to: string }[] {
    const byId = this.db.prepare('SELECT key FROM checks WHERE issue_id = ?');
    const rename = this.db.prepare('UPDATE checks SET key = ? WHERE issue_id = ?');
    const fillId = this.db.prepare('UPDATE checks SET issue_id = ? WHERE key = ? AND issue_id IS NULL');
    const moves: { from: string; to: string }[] = [];
    for (const issue of issues) {
      const row = byId.get(issue.id) as { key: string } | undefined;
      if (row && row.key !== issue.key) {
        rename.run(issue.key, issue.id);
        moves.push({ from: row.key, to: issue.key });
      } else if (!row) {
        fillId.run(issue.id, issue.key);
      }
    }
    return moves;
  }

  /** Keys with no row yet, or whose last attempt failed and may be retried. */
  pending(keys: string[]): string[] {
    if (keys.length === 0) return [];
    const marks = keys.map(() => '?').join(',');
    const rows = this.db.prepare(`SELECT key, status FROM checks WHERE key IN (${marks})`).all(...keys) as { key: string; status: CheckStatus }[];
    const known = new Map(rows.map((r) => [r.key, r.status]));
    return keys.filter((k) => !known.has(k) || known.get(k) === 'retry');
  }

  /** One more failed attempt: `retry`, or `failed` once the limit is reached. */
  recordFailure(issue: IssueRef, error: string, maxAttempts: number): { status: CheckStatus; attempts: number } {
    const row = this.db
      .prepare(
        `INSERT INTO checks (key, issue_id, status, attempts, checked_at, error) VALUES (?, ?, 'retry', 1, ?, ?)
         ON CONFLICT(key) DO UPDATE SET
           attempts = attempts + 1,
           status = CASE WHEN attempts + 1 >= ? THEN 'failed' ELSE 'retry' END,
           checked_at = excluded.checked_at, error = excluded.error
         RETURNING status, attempts`,
      )
      .get(issue.key, issue.id, now(), error, maxAttempts) as { status: CheckStatus; attempts: number };
    return { status: row.status, attempts: row.attempts };
  }

  recordResult(issue: IssueRef, r: CheckResultRow): void {
    this.db
      .prepare(
        `INSERT INTO checks (key, issue_id, status, attempts, checked_at, summary, reporter, base_checks, verdict, comment, comment_id, error)
         VALUES (?, ?, ?, 1, ?, ?, ?, ?, ?, ?, NULL, NULL)
         ON CONFLICT(key) DO UPDATE SET status = excluded.status, attempts = attempts + 1, checked_at = excluded.checked_at,
           summary = excluded.summary, reporter = excluded.reporter, base_checks = excluded.base_checks, verdict = excluded.verdict,
           comment = excluded.comment, comment_id = NULL, error = NULL`,
      )
      .run(issue.key, issue.id, r.status, now(), r.summary, r.reporter, JSON.stringify(r.baseChecks), JSON.stringify(r.verdict), r.comment);
  }

  /** The comment is in Jira: `posting` → `commented`. */
  markCommented(key: string, commentId: string): void {
    this.db.prepare("UPDATE checks SET status = 'commented', comment_id = ? WHERE key = ?").run(commentId, key);
  }

  /** Lets a `failed` (or `posting`) bug be checked again on the next poll. False when there is no such row. */
  requeue(key: string): boolean {
    const r = this.db.prepare("UPDATE checks SET status = 'retry', attempts = 0, error = NULL WHERE key = ? AND status IN ('failed', 'posting')").run(key);
    return r.changes > 0;
  }

  status(key: string): CheckStatus | null {
    const row = this.db.prepare('SELECT status FROM checks WHERE key = ?').get(key) as { status: CheckStatus } | undefined;
    return row?.status ?? null;
  }

  close(): void {
    this.db.close();
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
