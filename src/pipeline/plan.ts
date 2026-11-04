import type { BugRow, CheckStatus, IssueRef } from '../db/store.ts';

/** A bug in the query, as one poll sees it. */
export interface Watched extends IssueRef {
  /** Epoch ms. */
  created: number;
  updated: number;
  /** Of the report now; null when the issue could not be read as a bug (its check will say why). */
  fingerprint: string | null;
}

/** prd.md, Trigger: a report is checked once it has settled, and again when it changes. */
export const FIRST_CHECK_AGE_MS = 30 * 60_000;
export const QUIET_BEFORE_RECHECK_MS = 15 * 60_000;
/** Checks per bug, failed ones included: a guard against a bug that keeps changing or failing. */
export const MAX_CHECKS = 5;

/**
 * The rows a check continues as a re-check, editing their comment: a bug not understood, with
 * the comment made in the current mode. A bug understood, or not a WebUI bug, is done.
 */
export const recheckableStatuses = (dryRun: boolean): CheckStatus[] => (dryRun ? ['dry_run'] : ['commented']);

export interface Plan {
  first: Watched[];
  recheck: { bug: Watched; row: BugRow }[];
  /** Too young for the first check, or changed and not yet quiet. */
  waiting: number;
}

/**
 * Which bugs of the query to check on this poll. A new bug waits until it is 30 minutes old; a
 * bug not understood whose report changed waits until nothing has moved on it for 15 minutes, so
 * a burst of edits gives one re-check. A re-check edits the comment made in the current mode: a dry-run
 * comment was never posted, and a dry run never overwrites a posted one. Live, a bug left
 * `posting` is checked again at once: the check finds the comment in Jira, if it got there, and
 * adopts it (handle.ts).
 */
export function plan(watched: Watched[], rows: Map<string, BugRow>, now: number, dryRun: boolean): Plan {
  const recheckable = recheckableStatuses(dryRun);
  const out: Plan = { first: [], recheck: [], waiting: 0 };
  for (const bug of watched) {
    const row = rows.get(bug.key);
    if (row?.status === 'posting') {
      if (!dryRun && row.runs < MAX_CHECKS) out.first.push(bug);
      continue;
    }
    if (!row || row.status === 'retry') {
      if (row || now - bug.created >= FIRST_CHECK_AGE_MS) out.first.push(bug);
      else out.waiting += 1;
      continue;
    }
    const changed =
      recheckable.includes(row.status) &&
      row.fingerprint !== null &&
      bug.fingerprint !== null &&
      bug.fingerprint !== row.fingerprint &&
      row.runs < MAX_CHECKS;
    if (!changed) continue;
    if (now - bug.updated >= QUIET_BEFORE_RECHECK_MS) out.recheck.push({ bug, row });
    else out.waiting += 1;
  }
  return out;
}
