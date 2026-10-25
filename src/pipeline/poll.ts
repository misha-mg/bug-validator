import { AgentError } from '../claude/agent.ts';
import type { BugRow } from '../db/store.ts';
import { fingerprint } from '../domain/fingerprint.ts';
import { JiraError, REPORT_FIELDS, type RawIssue } from '../jira/client.ts';
import { jiraTime, MappingError, toBug } from '../jira/mapping.ts';
import { TRIGGER_JQL } from '../jira/queries.ts';
import { describeError, log } from '../log.ts';
import { checkBug } from './checkBug.ts';
import type { Deps } from './deps.ts';
import { plan, type Watched } from './plan.ts';

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
 * first check and re-check due, in turn. Stops between bugs when `signal` aborts. A failure of the
 * surroundings (Jira unreachable, claude missing) is thrown and ends the poll without touching any
 * bug's row.
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
  for (const { bug, row } of checks) {
    if (signal?.aborted) break;
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

/** The failure is about the machine or Jira, not about this bug: it must not use up an attempt. */
function isEnvironmental(err: unknown): boolean {
  return (err instanceof JiraError && err.environmental) || (err instanceof AgentError && err.kind === 'start');
}

/** One check: the first one (`previous` null) or a re-check of a bug whose report changed. */
async function handle(deps: Deps, bug: Watched, previous: BugRow | null, signal?: AbortSignal): Promise<boolean> {
  const { key } = bug;
  const recheck = previous !== null;
  const started = Date.now();
  log.info('check_start', { key, recheck });
  try {
    const out = await checkBug(deps, key, { signal, previousComment: previous?.comment ?? null });
    const row = {
      summary: out.bug.summary,
      reporter: out.bug.reporter?.displayName ?? null,
      fingerprint: out.fingerprint,
      baseChecks: out.baseChecks,
      verdict: out.verdict,
    };
    const failedBase = out.baseChecks.filter((c) => !c.passed).map((c) => c.id);
    const fields = { key, recheck, failedBase, missing: out.verdict.missing, related: out.verdict.related.map((r) => r.key), agentMs: out.agent.durationMs, turns: out.agent.turns, costUsd: out.agent.costUsd };
    if (out.strippedMentions.length > 0) log.warn('mentions_stripped', { key, stripped: out.strippedMentions });

    // Only without an earlier comment: a re-check keeps the comment (verdict.ts).
    if (out.comment === null) {
      deps.store.recordResult(bug, { ...row, status: 'complete', comment: null, commentId: null });
      log.info('bug_complete', fields);
      return true;
    }
    if (deps.config.dryRun) {
      deps.store.recordResult(bug, { ...row, status: 'dry_run', comment: out.comment, commentId: null });
      log.info('comment_dry_run', { ...fields, comment: out.comment });
      return true;
    }
    if (previous?.commentId) {
      // An edit can be repeated, so it goes before the record: a service that dies in between
      // re-checks the bug at a later poll and edits again.
      if (out.comment !== previous.comment) await deps.jira.editComment(key, previous.commentId, out.comment);
      deps.store.recordResult(bug, { ...row, status: 'commented', comment: out.comment, commentId: previous.commentId });
      log.info('comment_edited', { ...fields, commentId: previous.commentId, comment: out.comment });
      return true;
    }
    // A post cannot be repeated, so the row goes first: if the process dies between the post and
    // the record, the bug is `posting` — shown for a human to look at, never posted again.
    deps.store.recordResult(bug, { ...row, status: 'posting', comment: out.comment, commentId: null });
    const { id } = await deps.jira.addComment(key, out.comment);
    deps.store.markCommented(key, id);
    log.info('comment_posted', { ...fields, commentId: id, comment: out.comment });
    return true;
  } catch (err) {
    if (isEnvironmental(err)) throw err;
    const error = describeError(err);
    const ms = Date.now() - started;
    if (previous) {
      deps.store.recordRecheckFailure(key, error);
      log.error('check_failed', { key, recheck, status: previous.status, error, ms });
      return false;
    }
    const { status, attempts } = deps.store.recordFailure(bug, error, deps.config.maxAttempts);
    log.error('check_failed', { key, recheck, attempts, status, error, ms });
    return false;
  }
}
