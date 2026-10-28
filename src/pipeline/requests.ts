import { describeError, log } from '../log.ts';
import type { Deps } from './deps.ts';
import { handle, isEnvironmental } from './handle.ts';

/**
 * Checks every bug asked for, oldest request first, whatever its age, its status in Jira or its
 * row says: a request is a person's decision. The check and its record are the usual ones
 * (`handle.ts`). A key Jira does not know fails the request. A failure of the surroundings is
 * thrown, and the request stays for a later try; the third such failure in a row fails it, so a
 * request that cannot be served stops holding up the rest. Returns the keys checked.
 */
export async function serveRequests(deps: Deps, signal?: AbortSignal): Promise<string[]> {
  const served: string[] = [];
  for (const { key, at } of deps.store.requests().filter((r) => r.error === null)) {
    if (signal?.aborted) break;
    try {
      const raw = await deps.jira.getIssue(key);
      const issue = { id: raw.id, key: raw.key };
      for (const move of deps.store.track([issue])) log.info('key_changed', move);
      await handle(deps, issue, deps.store.rows([issue.key]).get(issue.key) ?? null, signal, true);
      deps.store.requestDone(key, at);
      served.push(issue.key);
    } catch (err) {
      if (signal?.aborted) throw err;
      const error = describeError(err);
      if (!isEnvironmental(err)) {
        // Only the read can fail here for the bug's sake (no such issue): handle records its own failures.
        log.error('request_failed', { key, error });
        deps.store.requestFailed(key, error);
        continue;
      }
      const failed = deps.store.requestTried(key, error);
      log.error('request_failed', { key, error, gaveUp: failed });
      if (!failed) throw err;
    }
  }
  return served;
}
