import { fingerprint } from '../domain/fingerprint.ts';
import { REPORT_FIELDS, type RawIssue } from '../jira/client.ts';
import { jiraTime, MappingError, toBug } from '../jira/mapping.ts';
import { TRIGGER_JQL } from '../jira/queries.ts';
import { log } from '../log.ts';
import type { Deps } from './deps.ts';
import { handle } from './handle.ts';
import { plan, type Watched } from './plan.ts';
import { serveRequests } from './requests.ts';

export interface PollSummary {
  inQuery: number;
  /** Bugs not checked on this poll because they have not settled yet (plan.ts). */
  waiting: number;
  /** First checks and re-checks due on this poll. */
  pending: number;
  checked: number;
  failed: number;
}

/** The query has more bugs than this only if something is very wrong; the rest wait for the next poll. */
const QUERY_LIMIT = 200;

/**
 * One poll: the query with every bug's report, the first-start bootstrap, moved bugs, then every
 * first check and re-check due, in turn, with the checks asked for by hand served before each.
 * Stops between bugs when `signal` aborts. A failure of the surroundings (Jira unreachable, claude
 * missing) is thrown and ends the poll without touching any bug's row.
 */
export async function poll(deps: Deps, signal?: AbortSignal): Promise<PollSummary> {
  const watched = (await deps.jira.search(TRIGGER_JQL, REPORT_FIELDS, QUERY_LIMIT)).map(watch);
  const keys = watched.map((w) => w.key);

  if (!deps.store.isBootstrapped()) {
    deps.store.bootstrap(watched);
    log.info('first_start', { skipped: keys });
    return { inQuery: keys.length, waiting: 0, pending: 0, checked: 0, failed: 0 };
  }

  for (const move of deps.store.track(watched)) log.info('key_changed', move);
  const due = plan(watched, deps.store.rows(keys), Date.now(), deps.config.dryRun);
  const checks = [...due.first.map((bug) => ({ bug, row: null })), ...due.recheck];
  const summary: PollSummary = { inQuery: keys.length, waiting: due.waiting, pending: checks.length, checked: 0, failed: 0 };
  const served = new Set<string>();
  for (const { bug, row } of checks) {
    for (const key of await serveRequests(deps, signal)) served.add(key);
    if (signal?.aborted) break;
    if (served.has(bug.key)) continue; // just checked on request
    if (await handle(deps, bug, row, signal)) summary.checked += 1;
    else summary.failed += 1;
  }
  return summary;
}

function watch(issue: RawIssue): Watched {
  let report: string | null = null;
  try {
    report = fingerprint(toBug(issue));
  } catch (err) {
    if (!(err instanceof MappingError)) throw err;
  }
  const { created, updated } = issue.fields as { created: string; updated: string };
  return { id: issue.id, key: issue.key, created: jiraTime(created), updated: jiraTime(updated), fingerprint: report };
}
