// Which bugs of a poll are due: first checks, re-checks, the waiting ones.
import type { BugRow, CheckStatus, IssueRef } from '../store/store.ts'

/** A bug in the query, as one poll sees it. */
export interface Watched extends IssueRef {
  /** Epoch ms. */
  created: number
  updated: number
  /** Of the report now; null when the issue could not be read as a bug (its check will say why). */
  fingerprint: string | null
}

/** prd.md, Trigger: a report is checked once it has settled, and again when it changes. */
export const FIRST_CHECK_AGE_MS = 30 * 60_000
export const QUIET_BEFORE_RECHECK_MS = 15 * 60_000
/** Checks per bug, failed ones included: a guard against a bug that keeps changing or failing. */
export const MAX_CHECKS = 5

/** When a bug is due, as the console may set it (store/settings.ts); the three above are its defaults. */
export interface Timing {
  /** A new bug is first checked once it is this old. */
  firstCheckMinutes: number
  /** A changed report is re-checked once nothing has moved on it for this long. */
  quietMinutes: number
  /** Checks per bug, failed ones included. */
  maxChecks: number
}
export const DEFAULT_TIMING: Timing = {
  firstCheckMinutes: FIRST_CHECK_AGE_MS / 60_000,
  quietMinutes: QUIET_BEFORE_RECHECK_MS / 60_000,
  maxChecks: MAX_CHECKS,
}

/**
 * The rows a check continues as a re-check, editing their comment: a bug not understood, with
 * the comment made in the current mode. A bug understood, or not a WebUI bug, is done.
 */
export const recheckableStatuses = (dryRun: boolean): CheckStatus[] => (dryRun ? ['dry_run'] : ['commented'])

export interface Plan {
  first: Watched[]
  recheck: { bug: Watched; row: BugRow }[]
  /** Too young for the first check, or changed and not yet quiet. */
  waiting: number
}

/**
 * Which bugs of the query to check on this poll. A new bug waits until it is 30 minutes old; a
 * bug not understood whose report changed waits until nothing has moved on it for 15 minutes
 * (both, and the checks a bug gets, by `timing`: the defaults unless the console set others), so
 * a burst of edits gives one re-check. A re-check edits the comment made in the current mode: a dry-run
 * comment was never posted, and a dry run never overwrites a posted one. Live, a bug left
 * `posting` is checked again at once: the check finds the comment in Jira, if it got there, and
 * adopts it (handle.ts).
 */
export function plan(watched: Watched[], rows: Map<string, BugRow>, now: number, dryRun: boolean, timing: Timing = DEFAULT_TIMING): Plan {
  const firstCheckAge = timing.firstCheckMinutes * 60_000
  const quiet = timing.quietMinutes * 60_000
  const recheckable = recheckableStatuses(dryRun)
  const out: Plan = { first: [], recheck: [], waiting: 0 }
  for (const bug of watched) {
    const row = rows.get(bug.key)
    if (row?.status === 'posting') {
      if (!dryRun && row.runs < timing.maxChecks) out.first.push(bug)
      continue
    }
    if (!row || row.status === 'retry') {
      if (row || now - bug.created >= firstCheckAge) out.first.push(bug)
      else out.waiting += 1
      continue
    }
    const changed =
      recheckable.includes(row.status) &&
      row.fingerprint !== null &&
      bug.fingerprint !== null &&
      bug.fingerprint !== row.fingerprint &&
      row.runs < timing.maxChecks
    if (!changed) continue
    if (now - bug.updated >= quiet) out.recheck.push({ bug, row })
    else out.waiting += 1
  }
  return out
}
