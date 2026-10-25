import { AgentError } from '../claude/agent.ts';
import type { IssueRef } from '../db/store.ts';
import { JiraError } from '../jira/client.ts';
import { TRIGGER_JQL } from '../jira/queries.ts';
import { describeError, log } from '../log.ts';
import { checkBug } from './checkBug.ts';
import type { Deps } from './deps.ts';

export interface PollSummary {
  inQuery: number;
  pending: number;
  checked: number;
  failed: number;
}

/** The query has more bugs than this only if something is very wrong; the rest wait for the next poll. */
const QUERY_LIMIT = 200;

/**
 * One poll: the query, the first-start bootstrap, then every pending bug in turn. Stops between
 * bugs when `signal` aborts. A failure of the surroundings (Jira unreachable, claude missing)
 * is thrown and ends the poll without touching any bug's row.
 */
export async function poll(deps: Deps, signal?: AbortSignal): Promise<PollSummary> {
  const issues: IssueRef[] = (await deps.jira.search(TRIGGER_JQL, ['updated'], QUERY_LIMIT)).map(({ id, key }) => ({ id, key }));
  const keys = issues.map((i) => i.key);

  if (!deps.store.isBootstrapped()) {
    deps.store.bootstrap(issues);
    log.info('first_start', { skipped: keys });
    return { inQuery: keys.length, pending: 0, checked: 0, failed: 0 };
  }

  for (const move of deps.store.track(issues)) log.info('key_changed', move);
  const pendingKeys = new Set(deps.store.pending(keys));
  const pending = issues.filter((i) => pendingKeys.has(i.key));
  const summary: PollSummary = { inQuery: keys.length, pending: pending.length, checked: 0, failed: 0 };
  for (const issue of pending) {
    if (signal?.aborted) break;
    if (await handle(deps, issue, signal)) summary.checked += 1;
    else summary.failed += 1;
  }
  return summary;
}

/** The failure is about the machine or Jira, not about this bug: it must not use up an attempt. */
function isEnvironmental(err: unknown): boolean {
  return (err instanceof JiraError && err.environmental) || (err instanceof AgentError && err.kind === 'start');
}

async function handle(deps: Deps, issue: IssueRef, signal?: AbortSignal): Promise<boolean> {
  const { key } = issue;
  const started = Date.now();
  log.info('check_start', { key });
  try {
    const out = await checkBug(deps, key, signal);
    const row = {
      summary: out.bug.summary,
      reporter: out.bug.reporter?.displayName ?? null,
      baseChecks: out.baseChecks,
      verdict: out.verdict,
    };
    const failedBase = out.baseChecks.filter((c) => !c.passed).map((c) => c.id);
    const fields = { key, failedBase, missing: out.verdict.missing, related: out.verdict.related.map((r) => r.key), agentMs: out.agent.durationMs, turns: out.agent.turns, costUsd: out.agent.costUsd };
    if (out.strippedMentions.length > 0) log.warn('mentions_stripped', { key, stripped: out.strippedMentions });

    if (out.comment === null) {
      deps.store.recordResult(issue, { ...row, status: 'complete', comment: null });
      log.info('bug_complete', fields);
      return true;
    }
    if (deps.config.dryRun) {
      deps.store.recordResult(issue, { ...row, status: 'dry_run', comment: out.comment });
      log.info('comment_dry_run', { ...fields, comment: out.comment });
      return true;
    }
    // The row goes first: if the process dies between the post and the record, the bug is
    // `posting` — shown for a human to look at, never posted again by the service.
    deps.store.recordResult(issue, { ...row, status: 'posting', comment: out.comment });
    const { id } = await deps.jira.addComment(key, out.comment);
    deps.store.markCommented(key, id);
    log.info('comment_posted', { ...fields, commentId: id, comment: out.comment });
    return true;
  } catch (err) {
    if (isEnvironmental(err)) throw err;
    const error = describeError(err);
    const { status, attempts } = deps.store.recordFailure(issue, error, deps.config.maxAttempts);
    log.error('check_failed', { key, attempts, status, error, ms: Date.now() - started });
    return false;
  }
}
