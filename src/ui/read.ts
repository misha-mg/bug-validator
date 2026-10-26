import { existsSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import type { CheckStatus } from '../db/store.ts';
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
  if (!existsSync(dbFile)) return [];
  // Read-only; the timeout waits out the service's write instead of failing.
  const db = new DatabaseSync(dbFile, { readOnly: true, timeout: 5000 });
  try {
    const rows = db.prepare('SELECT * FROM checks').all() as Record<string, unknown>[];
    const history = readRuns(db);
    return rows.map((row) => toBug(row, history.get(row.key as string) ?? [])).sort((a, b) => b.checkedAt.getTime() - a.checkedAt.getTime());
  } catch (err) {
    // The file is there, the table not yet (the service is creating it), or it is not a database.
    if (err instanceof Error && /no such table|not a database/.test(err.message)) return [];
    throw err;
  } finally {
    db.close();
  }
}

export function readBug(dbFile: string, key: string): BugView | null {
  return readBugs(dbFile).find((bug) => bug.key === key) ?? null;
}

/** The runs of every bug, oldest first; none in a database from before runs were kept. */
function readRuns(db: DatabaseSync): Map<string, Run[]> {
  const runs = new Map<string, Run[]>();
  const table = db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'runs'").get();
  if (!table) return runs;
  for (const row of db.prepare('SELECT * FROM runs ORDER BY at, rowid').all() as Record<string, unknown>[]) {
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
  return {
    key: row.key as string,
    status: row.status as CheckStatus,
    attempts: Number(row.attempts ?? 0),
    checkedAt: time(row.checked_at),
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
const json = (value: unknown): unknown => (typeof value === 'string' && value ? JSON.parse(value) : null);
// Times are ISO UTC as the service writes them; a Date is an instant, the pages format it in local time.
const time = (value: unknown): Date => (typeof value === 'string' && value ? new Date(value) : new Date(0));
