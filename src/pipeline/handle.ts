import { AgentError } from '../claude/agent.ts';
import type { BugRow, IssueRef } from '../db/store.ts';
import { JiraError } from '../jira/client.ts';
import { describeError, log } from '../log.ts';
import { checkBug } from './checkBug.ts';
import type { Deps } from './deps.ts';

/** The failure is about the machine or Jira, not about this bug: it must not use up an attempt. */
export function isEnvironmental(err: unknown): boolean {
  return (err instanceof JiraError && err.environmental) || (err instanceof AgentError && err.kind === 'start');
}

/**
 * One check of a bug and its record: the first check (`previous` null) or a re-check that edits
 * the comment of `previous`. `requested` marks a check asked for by hand. True when the check
 * finished; a failure of the surroundings is thrown.
 */
export async function handle(deps: Deps, bug: IssueRef, previous: BugRow | null, signal?: AbortSignal, requested = false): Promise<boolean> {
  const { key } = bug;
  const recheck = previous !== null;
  const started = Date.now();
  log.info('check_start', { key, recheck, requested });
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
    const fields = { key, recheck, requested, failedBase, missing: out.verdict.missing, related: out.verdict.related.map((r) => r.key), agentMs: out.agent.durationMs, turns: out.agent.turns, costUsd: out.agent.costUsd };
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
      log.error('check_failed', { key, recheck, requested, status: previous.status, error, ms });
      return false;
    }
    const { status, attempts } = deps.store.recordFailure(bug, error, deps.config.maxAttempts);
    log.error('check_failed', { key, recheck, requested, attempts, status, error, ms });
    return false;
  }
}
