// The posts and the checks asked for by hand, served before each check of a poll and while the service waits.
import { JiraError } from '../jira/client.ts'
import { describeError, log } from '../log.ts'
import type { Deps } from './deps.ts'
import { handle, isEnvironmental, ownComment } from './handle.ts'

/**
 * Serves what a person asked for: the posts first (`servePosts`), then every check asked for,
 * oldest request first, whatever its age, its status in Jira or its row says: a request is a
 * person's decision. The check and its record are the usual ones (`handle.ts`). A key Jira does
 * not know fails the request. A failure of the surroundings is thrown, and the request stays for
 * a later try; the third such failure in a row fails it, so a request that cannot be served stops
 * holding up the rest. Returns the keys checked.
 */
export async function serveRequests(deps: Deps, signal?: AbortSignal): Promise<string[]> {
  await servePosts(deps, signal)
  const served: string[] = []
  for (const { key, at } of deps.store.requests().filter((r) => r.error === null)) {
    if (signal?.aborted) break
    try {
      const raw = await deps.jira.getIssue(key)
      const issue = { id: raw.id, key: raw.key }
      for (const move of deps.store.track([issue])) log.info('key_changed', move)
      await handle(deps, issue, deps.store.rows([issue.key]).get(issue.key) ?? null, signal, true)
      deps.store.requestDone(key, at)
      served.push(issue.key)
    } catch (err) {
      if (signal?.aborted) throw err
      const error = describeError(err)
      if (!isEnvironmental(err)) {
        // Only the read can fail here for the bug's sake (no such issue): handle records its own failures.
        log.error('request_failed', { key, error })
        deps.store.requestFailed(key, error)
        continue
      }
      const failed = deps.store.requestTried(key, error)
      log.error('request_failed', { key, error, gaveUp: failed })
      if (!failed) throw err
    }
  }
  return served
}

/**
 * Posts the comments a person asked to post from the UI, oldest first, in a dry run as well: the
 * person read the comment and confirmed it. What is posted is the text they confirmed; a comment
 * changed since, or one already in Jira, fails the post. As before any first post, Jira is read
 * for a comment of the service's, and one found there is adopted, never posted again; the row is
 * `posting` while the post is sent. Failures are handled as a request's.
 */
export async function servePosts(deps: Deps, signal?: AbortSignal): Promise<void> {
  for (const { key, at, comment } of deps.store.posts().filter((p) => p.error === null)) {
    if (signal?.aborted) break
    try {
      await post(deps, key, comment)
      deps.store.postDone(key, at)
    } catch (err) {
      const error = describeError(err)
      if (!isEnvironmental(err)) {
        log.error('post_failed', { key, error })
        deps.store.postFailed(key, error)
        continue
      }
      const failed = deps.store.postTried(key, error)
      log.error('post_failed', { key, error, gaveUp: failed })
      if (!failed) throw err
    }
  }
}

async function post(deps: Deps, asked: string, comment: string): Promise<void> {
  const raw = await deps.jira.getIssue(asked)
  const issue = { id: raw.id, key: raw.key }
  for (const move of deps.store.track([issue])) log.info('key_changed', move)
  const { key } = issue
  const row = deps.store.rows([key]).get(key)
  if (!row || row.commentId !== null || (row.status !== 'dry_run' && row.status !== 'posting')) {
    throw new Error(`nothing to post: the bug is ${row ? (row.commentId !== null ? 'commented' : row.status) : 'not in the database'}`)
  }
  if (row.comment !== comment) throw new Error('the comment changed after it was confirmed: read it again')
  const own = await ownComment(deps.jira, raw)
  if (own) {
    deps.store.markCommented(key, own.id, own.body)
    log.warn('comment_adopted', { key, commentId: own.id, status: row.status })
    return
  }
  deps.store.markPosting(key)
  let id: string
  try {
    ;({ id } = await deps.jira.addComment(key, comment))
  } catch (err) {
    // Jira answered with an error: there is no comment. Without an answer there may be one, and
    // the row stays `posting` until the post is tried again, which looks in Jira first.
    if (err instanceof JiraError && err.refused) deps.store.postRefusedByHand(key)
    throw err
  }
  deps.store.markCommented(key, id)
  log.info('comment_posted', { key, byHand: true, commentId: id, comment })
}
