import { existsSync } from 'node:fs';
import { Store } from '../db/store.ts';
import { issueKey } from '../domain/key.ts';
import { describeError, log } from '../log.ts';
import type { Deps } from './deps.ts';
import { handle, isEnvironmental } from './handle.ts';
import { recheckableStatuses } from './plan.ts';

/**
 * Asks the service to check a bug: by key or by a link to it. Written to the service's database,
 * so the service must have made it. Returns the key.
 */
export function requestCheck(dbFile: string, text: string): string {
  const key = issueKey(text);
  if (!key) throw new Error(`Not a KAZ or RPG issue: ${text.trim() || '(nothing)'}`);
  if (!existsSync(dbFile)) throw new Error(`No database at ${dbFile}: the service has not started yet`);
  const store = new Store(dbFile);
  try {
    store.request(key);
  } finally {
    store.close();
  }
  return key;
}

/**
 * Checks every bug asked for, oldest request first, whatever its age, its status in Jira or its
 * row says: a request is a person's decision. The check and its record are the usual ones (a
 * re-check of the comment made in the current mode, a first check otherwise; `handle.ts`). A key
 * Jira does not know fails the request; a failure of the surroundings is thrown, and the request
 * stays for a later try. Returns the keys checked.
 */
export async function serveRequests(deps: Deps, signal?: AbortSignal): Promise<string[]> {
  const served: string[] = [];
  for (const { key } of deps.store.requests().filter((r) => r.error === null)) {
    if (signal?.aborted) break;
    let issue;
    try {
      const raw = await deps.jira.getIssue(key);
      issue = { id: raw.id, key: raw.key };
    } catch (err) {
      const error = describeError(err);
      log.error('request_failed', { key, error });
      if (isEnvironmental(err)) throw err;
      deps.store.requestFailed(key, error);
      continue;
    }
    for (const move of deps.store.track([issue])) log.info('key_changed', move);
    const row = deps.store.rows([issue.key]).get(issue.key);
    const previous = row && recheckableStatuses(deps.config.dryRun).includes(row.status) ? row : null;
    await handle(deps, issue, previous, signal, true);
    deps.store.requestDone(key);
    served.push(issue.key);
  }
  return served;
}
