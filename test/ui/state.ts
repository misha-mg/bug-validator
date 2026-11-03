import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { REQUIREMENT_IDS } from '../../src/domain/bug.ts';
import { Store } from '../../src/db/store.ts';

export const MENTION = '[~accountid:712020:abc]';
/** KAZ-2's comment as first written, and as edited once the reporter answered the first question. */
export const ASKED = `${MENTION}\nWhich page shows the table?\nPlease attach a HAR of the page load.\n\nPossibly related: KAZ-1 — the same empty table`;
export const ANSWERED = `${MENTION}\n-Which page shows the table?-\nPlease attach a HAR of the page load.\n\nPossibly related: KAZ-1 — the same empty table`;
const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;
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

export function fieldChecks(failed: string[]): string {
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

const dirs: string[] = [];
// Every test file that makes a state cleans up after itself.
process.once('exit', () => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

/** The service's tables, made by the real Store, in a fresh directory. */
export function emptyState(): State {
  const dir = mkdtempSync(join(tmpdir(), 'ui-'));
  dirs.push(dir);
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

/** The verdict as the service records it; the comment says whether the bug was understood. */
export const verdict = (outcome: string, comment = '', related: string[] = [], reason = ''): string => JSON.stringify({ outcome, reason, comment, related });

export interface RunExtra {
  /** The outcome, when not told by the comment: `not_webui`, with its reason. */
  outcome?: string;
  reason?: string;
  version?: number;
  webuiCommit?: string;
  files?: { filename: string; path: string; kind: string; note: string }[];
  costUsd?: number;
}

/** One check in the history: the field checks it found failed (and so its outcome and comment), or the error it ended with. */
export function run(dbFile: string, key: string, at: Date, failed: string[] | null, error: string | null = null, comment: string | null = null, extra: RunExtra = {}): void {
  const db = new DatabaseSync(dbFile);
  const checks = failed && REQUIREMENT_IDS.filter((id) => id !== 'R7').map((id) => ({ id, passed: !failed.includes(id), detail: '' }));
  const outcome = extra.outcome ?? (comment ? 'not_understood' : 'understood');
  db.prepare('INSERT INTO runs (key, at, base_checks, verdict, comment, error, webui_commit, files, version, cost_usd) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run(
    key, stamp(at), checks ? JSON.stringify(checks) : null, failed ? verdict(outcome, comment ?? '', [], extra.reason ?? '') : null, comment, error,
    error ? null : (extra.webuiCommit ?? 'abc123def456'), error ? null : JSON.stringify(extra.files ?? []), extra.version ?? 2, error ? null : (extra.costUsd ?? 0.03),
  );
  db.close();
}

/** A check asked for by hand, pending (no error) or failed. */
export function request(dbFile: string, key: string, at: Date, error: string | null = null): void {
  const db = new DatabaseSync(dbFile);
  db.prepare('INSERT INTO requests (key, at, error) VALUES (?, ?, ?)').run(key, stamp(at), error);
  db.close();
}

/**
 * A state directory: one bug skipped at the first start, two not understood (one of them checked
 * three times, as its reporter answered), one understood, one not a WebUI bug, one whose check
 * failed; a check asked for the skipped bug and one that failed for a key Jira does not know; and
 * a log of a dry run polling a minute ago.
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
    base_checks: fieldChecks(['R4', 'R6']),
    verdict: verdict('not_understood', ANSWERED, ['KAZ-1']),
    comment: ANSWERED,
  });
  // Minutes apart, not hours: the first check must fall on today whenever the tests run.
  run(dbFile, 'KAZ-2', ago(2 * MINUTE, now), ['R1', 'R4', 'R6'], null, ASKED, { files: [{ filename: 'table.png', path: '1-table.png', kind: 'image', note: '51 KB' }] });
  run(dbFile, 'KAZ-2', ago(MINUTE, now), null, 'VerdictError: not_understood without a comment');
  run(dbFile, 'KAZ-2', now, ['R4', 'R6'], null, ANSWERED);
  insert(dbFile, {
    key: 'KAZ-3',
    status: 'understood',
    attempts: 1,
    checked_at: stamp(daysAgo(3, now)),
    summary: 'Login page freezes',
    reporter: 'B Tester',
    base_checks: fieldChecks([]),
    verdict: verdict('understood'),
  });
  run(dbFile, 'KAZ-3', daysAgo(3, now), []);
  insert(dbFile, { key: 'RPG-4', status: 'failed', attempts: 3, checked_at: stamp(daysAgo(1, now)), error: 'Error: agent run timed out' });
  insert(dbFile, {
    key: 'RPG-6',
    status: 'not_webui',
    attempts: 1,
    checked_at: stamp(daysAgo(5, now)),
    summary: 'Port counter lags behind the CLI',
    reporter: 'C Tester',
    base_checks: fieldChecks(['R6']),
    verdict: verdict('not_webui', '', [], 'The UI shows the counter ConfD returns.'),
  });
  run(dbFile, 'RPG-6', daysAgo(5, now), ['R6'], null, null, { outcome: 'not_webui', reason: 'The UI shows the counter ConfD returns.' });
  insert(dbFile, {
    key: 'KAZ-5',
    status: 'dry_run',
    attempts: 1,
    checked_at: stamp(daysAgo(10, now)),
    summary: 'Device list is cut <b>',
    base_checks: fieldChecks(['R6']),
    verdict: verdict('not_understood', `${MENTION}\nPlease add:\n- HAR file`),
    comment: `${MENTION}\nPlease add:\n- HAR file`,
  });
  // Checked by the list, before the check by code.
  run(dbFile, 'KAZ-5', daysAgo(10, now), ['R6'], null, `${MENTION}\nPlease add:\n- HAR file`, { version: 1 });
  request(dbFile, 'KAZ-1', ago(2 * 60 * 1000, now));
  request(dbFile, 'KAZ-77', ago(HOUR, now), 'JiraError: HTTP 404 on GET /issue/KAZ-77');
  writeFileSync(
    state.logFile,
    logLine('service_start', ago(2 * HOUR, now), { dryRun: true, pollIntervalS: 180, model: 'haiku', claudeVersion: '2.0.30', webuiCommit: 'b37045e50d974a58f2228325237e49010a887e97' }) +
      logLine('comment_dry_run', ago(HOUR, now), { key: 'KAZ-2', recheck: true, outcome: 'not_understood' }) +
      logLine('poll', ago(60 * 1000, now), { inQuery: 7, waiting: 2, pending: 0, checked: 0, failed: 0 }),
  );
  return state;
}

export function appendLog(state: State, text: string): void {
  appendFileSync(state.logFile, text);
}
