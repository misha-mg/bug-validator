import { existsSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import type { CheckRequest, CheckStatus } from '../db/store.ts';
import type { RequirementId } from '../domain/bug.ts';
import type { BaseCheck } from '../domain/checks.ts';

/**
 * What a row's status means to a reader. A dry-run comment counts as a comment: it was written,
 * only not posted. A `posting` row was interrupted between the post and its record: whether the
 * comment reached Jira is for a human to check, so it needs attention.
 */
export type Result = 'comment' | 'no_comment' | 'error' | 'skipped';

const RESULT_OF: Record<CheckStatus, Result> = {
  commented: 'comment',
  dry_run: 'comment',
  complete: 'no_comment',
  posting: 'error',
  retry: 'error',
  failed: 'error',
  skipped: 'skipped',
};

/** One check of a bug: what it found missing, or why it failed. */
export interface Run {
  at: Date;
  missing: RequirementId[];
  comment: string | null;
  error: string | null;
}

export interface Related {
  key: string;
  reason: string;
}

/** A bug's row (`checks`) with its history (`runs`), as the pages show it. */
export interface BugView {
  key: string;
  status: CheckStatus;
  attempts: number;
  /** The last attempt; the epoch on a hand-made row without a time, so it sorts last. */
  checkedAt: Date;
  /** The first check that finished: the report as it arrived, what the statistics count by. */
  firstCheckedAt: Date;
  /** Rows written before the service kept them have neither, and a skipped bug was never read. */
  summary: string | null;
  reporter: string | null;
  baseChecks: BaseCheck[];
  /** The agent's list of failed requirements, R1–R7. */
  missing: RequirementId[];
  related: Related[];
  comment: string | null;
  commentId: string | null;
  error: string | null;
  /** Every check of the bug, oldest first; empty for rows from before the service kept them. */
  history: Run[];
}

export const result = (bug: BugView): Result => RESULT_OF[bug.status] ?? 'error';

/** Checked to the end, with a comment or without one. */
export const checked = (bug: BugView): boolean => result(bug) === 'comment' || result(bug) === 'no_comment';

/** What the first finished check found missing: the report as it arrived, before any re-check. */
export const firstMissing = (bug: BugView): RequirementId[] => bug.history.find((run) => run.error === null)?.missing ?? bug.missing;

/**
 * Every row, the latest check first; none before the service has made its database. The file is
 * opened read-only and never created: a stray empty database would look like a first start to
 * the service.
 */
export function readBugs(dbFile: string): BugView[] {
  return read(dbFile, [], (db) => {
    const rows = db.prepare('SELECT * FROM checks').all() as Record<string, unknown>[];
    const history = readRuns(db);
    return rows.map((row) => toBug(row, history.get(row.key as string) ?? [])).sort((a, b) => b.checkedAt.getTime() - a.checkedAt.getTime());
  });
}

/** One bug, read by its key alone. */
export function readBug(dbFile: string, key: string): BugView | null {
  return read(dbFile, null, (db) => {
    const row = db.prepare('SELECT * FROM checks WHERE key = ?').get(key) as Record<string, unknown> | undefined;
    return row ? toBug(row, readRuns(db, key).get(key) ?? []) : null;
  });
}

/**
 * The database opened read-only for one read; `none` without it. The file is never created: a
 * stray empty database would look like a first start to the service. The timeout waits out the
 * service's write instead of failing.
 */
function read<T>(dbFile: string, none: T, fn: (db: DatabaseSync) => T): T {
  if (!existsSync(dbFile)) return none;
  const db = new DatabaseSync(dbFile, { readOnly: true, timeout: 5000 });
  try {
    return fn(db);
  } catch (err) {
    // The service is creating the tables right now.
    if (err instanceof Error && /no such table/.test(err.message)) return none;
    throw err;
  } finally {
    db.close();
  }
}

/** A check or a post asked for by hand, pending or failed, as the pages show it. */
export interface Request {
  key: string;
  at: Date;
  error: string | null;
}

/** Every request, oldest first; none without the database. */
export function readRequests(dbFile: string): Request[] {
  return read(dbFile, [], (db) => {
    const rows = db.prepare('SELECT key, at, error FROM requests ORDER BY at, rowid').all() as unknown as CheckRequest[];
    return rows.map((r) => ({ key: r.key, at: time(r.at), error: r.error }));
  });
}

/** Every post asked for, pending or failed, oldest first; none without the database or its table. */
export function readPosts(dbFile: string): Request[] {
  return read(dbFile, [], (db) => {
    const rows = db.prepare('SELECT key, at, error FROM posts ORDER BY at, rowid').all() as unknown as CheckRequest[];
    return rows.map((r) => ({ key: r.key, at: time(r.at), error: r.error }));
  });
}

/** The runs of every bug, or of one, oldest first; none before the service has migrated an old database. */
function readRuns(db: DatabaseSync, key?: string): Map<string, Run[]> {
  const runs = new Map<string, Run[]>();
  if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'runs'").get()) return runs;
  const rows = key
    ? db.prepare('SELECT * FROM runs WHERE key = ? ORDER BY at, rowid').all(key)
    : db.prepare('SELECT * FROM runs ORDER BY at, rowid').all();
  for (const row of rows as Record<string, unknown>[]) {
    const verdict = json(row.verdict) as { missing?: RequirementId[] } | null;
    const run: Run = { at: time(row.at), missing: verdict?.missing ?? [], comment: text(row.comment), error: text(row.error) };
    const list = runs.get(row.key as string);
    if (list) list.push(run);
    else runs.set(row.key as string, [run]);
  }
  return runs;
}

function toBug(row: Record<string, unknown>, history: Run[]): BugView {
  const verdict = (json(row.verdict) ?? {}) as { missing?: RequirementId[]; related?: Related[] };
  const checkedAt = time(row.checked_at);
  return {
    key: row.key as string,
    status: row.status as CheckStatus,
    attempts: Number(row.attempts ?? 0),
    checkedAt,
    firstCheckedAt: history.find((run) => run.error === null)?.at ?? checkedAt,
    summary: text(row.summary),
    reporter: text(row.reporter),
    baseChecks: (json(row.base_checks) as BaseCheck[] | null) ?? [],
    missing: verdict.missing ?? [],
    related: verdict.related ?? [],
    comment: text(row.comment),
    commentId: text(row.comment_id),
    error: text(row.error),
    history,
  };
}

const text = (value: unknown): string | null => (typeof value === 'string' ? value : null);
// One broken value shows as missing, not as a page that fails.
const json = (value: unknown): unknown => {
  if (typeof value !== 'string' || !value) return null;
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
};
// Times are ISO UTC as the service writes them; a Date is an instant, the pages format it in local time.
const time = (value: unknown): Date => (typeof value === 'string' && value ? new Date(value) : new Date(0));
