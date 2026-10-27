import { appendFileSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { Store } from '../../src/db/store.ts';

export const MENTION = '[~accountid:712020:abc]';
const HOUR = 60 * 60 * 1000;
export const DAY = 24 * HOUR;

export const ago = (ms: number, now = new Date()): Date => new Date(now.getTime() - ms);

/** The same time of day n days earlier: stable across a clock change, unlike ago(n * DAY). */
export const daysAgo = (days: number, now: Date): Date => {
  const d = new Date(now);
  d.setDate(d.getDate() - days);
  return d;
};

/** A time as the service writes it: ISO, UTC, "Z". */
export const stamp = (at: Date): string => at.toISOString();

export function baseChecks(failed: string[]): string {
  return JSON.stringify([1, 2, 3, 4, 5, 6].map((n) => ({ id: `R${n}`, passed: !failed.includes(`R${n}`), detail: `detail of R${n}` })));
}

export function logLine(event: string, at: Date, fields: Record<string, unknown> = {}): string {
  return `${JSON.stringify({ ts: stamp(at), level: 'info', event, ...fields })}\n`;
}

export interface State {
  dir: string;
  dbFile: string;
  logFile: string;
  now: Date;
}

/** The service's tables, made by the real Store, in a fresh directory. */
export function emptyState(): State {
  const dir = mkdtempSync(join(tmpdir(), 'ui-'));
  const dbFile = join(dir, 'bug-validator.sqlite');
  new Store(dbFile).close();
  return { dir, dbFile, logFile: join(dir, 'service.log'), now: new Date() };
}

export function insert(dbFile: string, row: Record<string, unknown>): void {
  const db = new DatabaseSync(dbFile);
  const columns = Object.keys(row);
  db.prepare(`INSERT INTO checks (${columns.join(', ')}) VALUES (${columns.map(() => '?').join(', ')})`).run(...(Object.values(row) as (string | number | null)[]));
  db.close();
}

/** One check in the history: what it found missing, or the error it ended with. */
export function run(dbFile: string, key: string, at: Date, missing: string[] | null, error: string | null = null, comment: string | null = null): void {
  const db = new DatabaseSync(dbFile);
  db.prepare('INSERT INTO runs (key, at, verdict, comment, error) VALUES (?, ?, ?, ?, ?)').run(key, stamp(at), missing ? JSON.stringify({ missing }) : null, comment, error);
  db.close();
}

/** A check asked for by hand, pending (no error) or failed. */
export function request(dbFile: string, key: string, at: Date, error: string | null = null): void {
  const db = new DatabaseSync(dbFile);
  db.prepare('INSERT INTO requests (key, at, error) VALUES (?, ?, ?)').run(key, stamp(at), error);
  db.close();
}

/**
 * A state directory: one bug skipped at the first start, two commented on (one of them checked
 * three times, as its reporter added steps), one complete, one whose check failed; a check
 * asked for the skipped bug and one that failed for a key Jira does not know; and a log of a
 * dry run polling a minute ago.
 */
export function sampleState(): State {
  const state = emptyState();
  const { dbFile, now } = state;
  insert(dbFile, { key: 'KAZ-1', status: 'skipped', checked_at: stamp(daysAgo(20, now)) });
  insert(dbFile, {
    key: 'KAZ-2',
    status: 'dry_run',
    attempts: 1,
    checked_at: stamp(now),
    summary: 'Ports table is empty after clearing the filter',
    reporter: 'A Tester',
    base_checks: baseChecks(['R4', 'R6']),
    verdict: JSON.stringify({ comment_needed: true, comment: '…', missing: ['R4', 'R6'], related: [{ key: 'KAZ-1', reason: 'the same empty table' }] }),
    comment: `${MENTION}\nPlease add:\n- -Steps to reproduce-\n- Affects versions\n- HAR file`,
  });
  run(dbFile, 'KAZ-2', ago(2 * HOUR, now), ['R1', 'R4', 'R6'], null, `${MENTION}\nPlease add:\n- Steps to reproduce\n- Affects versions\n- HAR file`);
  run(dbFile, 'KAZ-2', ago(HOUR, now), null, 'VerdictError: a re-check must keep the comment');
  run(dbFile, 'KAZ-2', now, ['R4', 'R6'], null, `${MENTION}\nPlease add:\n- -Steps to reproduce-\n- Affects versions\n- HAR file`);
  insert(dbFile, {
    key: 'KAZ-3',
    status: 'complete',
    attempts: 1,
    checked_at: stamp(daysAgo(3, now)),
    summary: 'Login page freezes',
    reporter: 'B Tester',
    base_checks: baseChecks([]),
    verdict: JSON.stringify({ comment_needed: false, comment: '', missing: [], related: [] }),
  });
  insert(dbFile, { key: 'RPG-4', status: 'failed', attempts: 3, checked_at: stamp(daysAgo(1, now)), error: 'Error: agent run timed out' });
  insert(dbFile, {
    key: 'KAZ-5',
    status: 'dry_run',
    attempts: 1,
    checked_at: stamp(daysAgo(10, now)),
    summary: 'Device list is cut <b>',
    base_checks: baseChecks(['R6']),
    verdict: JSON.stringify({ comment_needed: true, comment: '…', missing: ['R6'], related: [] }),
    comment: `${MENTION}\nPlease add:\n- HAR file`,
  });
  request(dbFile, 'KAZ-1', ago(2 * 60 * 1000, now));
  request(dbFile, 'KAZ-77', ago(HOUR, now), 'JiraError: HTTP 404 on GET /issue/KAZ-77');
  writeFileSync(
    state.logFile,
    logLine('service_start', ago(2 * HOUR, now), { dryRun: true, pollIntervalS: 180, model: 'haiku', claudeVersion: '2.0.30', claudeAuth: 'oauth_token' }) +
      logLine('comment_dry_run', ago(HOUR, now), { key: 'KAZ-2', recheck: true, missing: ['R4', 'R6'] }) +
      logLine('poll', ago(60 * 1000, now), { inQuery: 7, waiting: 2, pending: 0, checked: 0, failed: 0 }),
  );
  return state;
}

export function appendLog(state: State, text: string): void {
  appendFileSync(state.logFile, text);
}
