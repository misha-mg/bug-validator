import { AgentError } from '../claude/agent.ts';
import type { BugRow, IssueRef } from '../db/store.ts';
import { type Jira, JiraError, type RawIssue } from '../jira/client.ts';
import { toBug } from '../jira/mapping.ts';
import { describeError, log } from '../log.ts';
import { checkBug } from './checkBug.ts';
import type { Deps } from './deps.ts';
import { recheckableStatuses } from './plan.ts';

/** The failure is about the machine, Jira, Claude or the stop, not about this bug: it must not use up an attempt. */
export function isEnvironmental(err: unknown): boolean {
  return (err instanceof JiraError && err.environmental) || (err instanceof AgentError && err.environmental);
}

/** Jira refused a write for this bug's sake (a 4xx other than 401 and 429): the bug's failure, not the surroundings'. */
class WriteRefused extends Error {
  constructor(err: JiraError) {
    super(err.message);
    this.name = 'WriteRefused';
  }
}

const refusedForTheBug = (err: unknown): boolean =>
  err instanceof JiraError && err.status !== undefined && err.status >= 400 && err.status < 500 && err.status !== 401 && err.status !== 429;

/**
 * The service's comment among the bug's, if it has one: written by the service's account and
 * opening with the reporter's mention, as every comment the service makes does. The first one
 * wins; there is never meant to be a second.
 */
export async function ownComment(jira: Jira, issue: RawIssue): Promise<{ id: string; body: string } | null> {
  const bug = toBug(issue);
  if (!bug.reporter) return null;
  const { accountId } = await jira.myself();
  const mention = `[~accountid:${bug.reporter.accountId}]`;
  return bug.comments.find((c) => c.authorId === accountId && c.body.trimStart().startsWith(mention)) ?? null;
}

/**
 * One check of a bug and its record, by the bug's row (null: none yet). A row holding the comment
 * of the current mode is re-checked: the agent edits that comment. Live, a bug with no comment id
 * is first looked up in Jira: a comment of the service's found there (a crash while posting, a
 * lost database, a second instance) is adopted and edited, never posted again. A dry run never
 * writes over the record of a comment that is (or may be) in Jira: its check goes to the history
 * only. `requested` marks a check asked for by hand. True when the check finished; a failure of
 * the surroundings, or a stop, is thrown and changes nothing.
 */
export async function handle(deps: Deps, bug: IssueRef, row: BugRow | null, signal?: AbortSignal, requested = false): Promise<boolean> {
  const { key } = bug;
  const dryRun = deps.config.dryRun;
  const inJira = row !== null && (row.status === 'commented' || row.status === 'posting');
  const previous = row !== null && (recheckableStatuses(dryRun).includes(row.status) || (dryRun && inJira)) ? row : null;
  let previousComment = previous?.comment ?? null;
  let commentId = previous?.commentId ?? null;
  const started = Date.now();
  log.info('check_start', { key, recheck: previousComment !== null, requested });
  let posting = false;
  try {
    let issue: RawIssue | undefined;
    if (!dryRun && commentId === null) {
      issue = await deps.jira.getIssue(key);
      const own = await ownComment(deps.jira, issue);
      if (own) {
        log.warn('comment_adopted', { key, commentId: own.id, status: row?.status ?? null });
        previousComment = own.body;
        commentId = own.id;
      }
    }
    const recheck = previousComment !== null;
    const out = await checkBug(deps, key, { signal, previousComment, issue, cloneMaxAgeMs: deps.config.pollIntervalMs });
    const comment = out.verdict.outcome === 'not_understood' ? out.verdict.comment : null;
    const record = {
      summary: out.bug.summary,
      reporter: out.bug.reporter?.displayName ?? null,
      fingerprint: out.fingerprint,
      fieldChecks: out.fieldChecks,
      verdict: out.verdict,
      agent: out.agent,
    };
    const failedFields = out.fieldChecks.filter((c) => !c.passed).map((c) => c.id);
    const fields = { key, recheck, requested, failedFields, related: out.verdict.related, agentMs: out.agent.durationMs, turns: out.agent.turns, costUsd: out.agent.costUsd };
    if (out.strippedMentions.length > 0) log.warn('mentions_stripped', { key, stripped: out.strippedMentions });

    if (dryRun && inJira) {
      deps.store.recordRun(key, { ...record, comment: comment });
      log.info('comment_dry_run', { ...fields, comment: comment, kept: true });
      return true;
    }
    // Only without an earlier comment: a re-check keeps the comment (verdict.ts).
    if (comment === null) {
      deps.store.recordResult(bug, { ...record, status: 'complete', comment: null, commentId: null });
      log.info('bug_complete', fields);
      return true;
    }
    if (dryRun) {
      deps.store.recordResult(bug, { ...record, status: 'dry_run', comment: comment, commentId: null });
      log.info('comment_dry_run', { ...fields, comment: comment });
      return true;
    }
    if (commentId !== null) {
      // An edit can be repeated, so it goes before the record: a service that dies in between
      // re-checks the bug at a later poll and edits again.
      if (comment !== previousComment) {
        try {
          await deps.jira.editComment(key, commentId, comment);
        } catch (err) {
          throw refusedForTheBug(err) ? new WriteRefused(err as JiraError) : err;
        }
      }
      deps.store.recordResult(bug, { ...record, status: 'commented', comment: comment, commentId });
      log.info('comment_edited', { ...fields, commentId, comment: comment, changed: comment !== previousComment });
      return true;
    }
    // A post cannot be repeated, so the row goes first: if the process dies between the post and
    // the record, the bug is `posting`, and its next check finds the comment in Jira and adopts it.
    deps.store.recordResult(bug, { ...record, status: 'posting', comment: comment, commentId: null });
    posting = true;
    let id: string;
    try {
      ({ id } = await deps.jira.addComment(key, comment));
    } catch (err) {
      // No answer (network, timeout): the comment may be in Jira, so the row stays `posting`.
      if (!(err instanceof JiraError && err.refused)) throw err;
      // Jira answered with an error: there is no comment, and the bug goes back in line.
      const error = describeError(err);
      const own = refusedForTheBug(err);
      const { status, attempts } = deps.store.postRefused(key, error, deps.config.maxAttempts, own);
      if (!own) throw err;
      log.error('check_failed', { key, recheck, requested, attempts, status, error, ms: Date.now() - started });
      return false;
    }
    deps.store.markCommented(key, id);
    log.info('comment_posted', { ...fields, commentId: id, comment: comment });
    return true;
  } catch (err) {
    // From `posting` on, only a human or the next check's lookup in Jira may change the row.
    if (posting || isEnvironmental(err) || signal?.aborted) throw err;
    const error = describeError(err);
    const ms = Date.now() - started;
    // A row whose comment is in Jira never goes back to a first check: only its error changes.
    if (previous || inJira || commentId !== null) {
      deps.store.recordRecheckFailure(key, error);
      log.error('check_failed', { key, recheck: true, requested, status: row?.status ?? null, error, ms });
      return false;
    }
    const { status, attempts } = deps.store.recordFailure(bug, error, deps.config.maxAttempts);
    log.error('check_failed', { key, recheck: false, requested, attempts, status, error, ms });
    return false;
  }
}
