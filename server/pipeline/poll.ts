// One poll: query → first-start bootstrap → moved bugs → rows brought up to date → plan → checks, requests first.
import { checkFields } from '../domain/checks.ts'
import { fingerprint } from '../domain/fingerprint.ts'
import { REPORT_FIELDS, type RawIssue } from '../jira/client.ts'
import { jiraTime, MappingError, toBug } from '../jira/mapping.ts'
import { TRIGGER_JQL } from '../jira/queries.ts'
import { describeError, log } from '../log.ts'
import type { ReportSeen } from '../store/store.ts'
import type { Deps } from './deps.ts'
import { handle, isEnvironmental } from './handle.ts'
import { plan, type Watched } from './plan.ts'
import { serveRequests } from './requests.ts'

/** A bug of the query with its report as this poll read it, for the row to follow. */
interface Seen extends Watched {
  /** Null when the issue could not be read as a bug. */
  report: ReportSeen | null
}

export interface PollSummary {
  inQuery: number
  /** Bugs not checked on this poll because they have not settled yet (plan.ts). */
  waiting: number
  /** First checks and re-checks due on this poll. */
  pending: number
  checked: number
  failed: number
  /** Checks the surroundings failed on this poll while others went through: tried again next poll. */
  deferred: number
}

/** The query has more bugs than this only if something is very wrong; the rest wait for the next poll. */
const QUERY_LIMIT = 200

/**
 * One poll: the query with every bug's report, the first-start bootstrap, moved bugs, the rows of
 * checked bugs brought up to date with their reports (the console shows the report as it is; a
 * field check that changed is `report_changed` in the log), then every first check and re-check
 * due, in turn, with the checks asked for by hand served before each.
 * Stops between bugs when `signal` aborts. A failure of the surroundings (Jira unreachable or
 * refusing, Claude failing, claude missing) touches no bug's row. One such failure moves on to the
 * next bug, so a bug Jira chokes on does not hold up the rest; a second in a row, or one that no
 * later check gets past, is thrown and ends the poll: the surroundings are down.
 */
export async function poll(deps: Deps, signal?: AbortSignal): Promise<PollSummary> {
  const watched = (await deps.jira.search(TRIGGER_JQL, REPORT_FIELDS, QUERY_LIMIT)).map(watch)
  const keys = watched.map((w) => w.key)

  if (!deps.store.isBootstrapped()) {
    deps.store.bootstrap(watched)
    log.info('first_start', { skipped: keys })
    return { inQuery: keys.length, waiting: 0, pending: 0, checked: 0, failed: 0, deferred: 0 }
  }

  for (const move of deps.store.track(watched)) log.info('key_changed', move)
  for (const change of deps.store.refresh(watched.flatMap((w) => (w.report ? [w.report] : [])))) log.info('report_changed', { ...change })
  const rows = deps.store.rows(keys)
  const due = plan(watched, rows, Date.now(), deps.config.dryRun)
  const checks = [...due.first.map((bug) => ({ bug, row: rows.get(bug.key) ?? null })), ...due.recheck]
  const summary: PollSummary = { inQuery: keys.length, waiting: due.waiting, pending: checks.length, checked: 0, failed: 0, deferred: 0 }
  const served = new Set<string>()
  let unresolved: unknown = null
  for (const { bug, row } of checks) {
    for (const key of await serveRequests(deps, signal)) served.add(key)
    if (signal?.aborted) break
    if (served.has(bug.key)) continue // just checked on request
    try {
      if (await handle(deps, bug, row, signal)) summary.checked += 1
      else summary.failed += 1
      unresolved = null
    } catch (err) {
      if (!isEnvironmental(err) || signal?.aborted || unresolved !== null) throw err
      log.warn('check_deferred', { key: bug.key, error: describeError(err) })
      summary.deferred += 1
      unresolved = err
    }
  }
  if (unresolved !== null) throw unresolved
  return summary
}

function watch(issue: RawIssue): Seen {
  let hash: string | null = null
  let report: ReportSeen | null = null
  try {
    const bug = toBug(issue)
    hash = fingerprint(bug)
    report = { key: issue.key, summary: bug.summary, reporter: bug.reporter?.displayName ?? null, fieldChecks: checkFields(bug) }
  } catch (err) {
    if (!(err instanceof MappingError)) throw err
  }
  const { created, updated } = issue.fields as { created: string; updated: string }
  return { id: issue.id, key: issue.key, created: jiraTime(created), updated: jiraTime(updated), fingerprint: hash, report }
}
