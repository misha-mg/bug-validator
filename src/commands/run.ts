import { setTimeout as sleep } from 'node:timers/promises';
import { ClaudeAgent } from '../claude/agent.ts';
import { loadConfig } from '../config.ts';
import { Store } from '../db/store.ts';
import { JiraClient } from '../jira/client.ts';
import { describeError, log } from '../log.ts';
import type { Deps } from '../pipeline/deps.ts';
import { poll } from '../pipeline/poll.ts';
import { serveRequests } from '../pipeline/requests.ts';

/** How often the service looks for a check asked for by hand while it waits for the next poll. */
const REQUEST_TICK_MS = 2000;

/**
 * The service: poll, wait, repeat, until SIGINT or SIGTERM. Polls never overlap. While it waits,
 * checks asked for by hand are served as they come, unless the last poll (or request) failed on
 * the surroundings: then they wait for a poll that succeeds.
 */
export async function run(): Promise<void> {
  const config = loadConfig();
  const claudeVersion = ClaudeAgent.version();
  const deps: Deps = {
    config,
    jira: new JiraClient(config.jira),
    agent: new ClaudeAgent(config.agent),
    store: new Store(config.dbFile),
  };
  log.info('service_start', {
    dryRun: config.dryRun,
    pollIntervalS: config.pollIntervalMs / 1000,
    maxAttempts: config.maxAttempts,
    model: config.agent.model,
    claudeVersion,
    claudeAuth: config.agent.auth,
    dbFile: config.dbFile,
  });

  const stop = new AbortController();
  const onSignal = (signal: string): void => {
    log.info('service_stopping', { signal });
    stop.abort();
  };
  process.once('SIGINT', () => onSignal('SIGINT'));
  process.once('SIGTERM', () => onSignal('SIGTERM'));

  while (!stop.signal.aborted) {
    const started = Date.now();
    let ok = true;
    try {
      const summary = await poll(deps, stop.signal);
      log.info('poll', { ...summary, ms: Date.now() - started });
    } catch (err) {
      // Jira or claude is unavailable: an error, not a quiet poll. The next poll simply tries again.
      log.error('poll_failed', { error: describeError(err), ms: Date.now() - started });
      ok = false;
    }
    const due = Date.now() + config.pollIntervalMs;
    while (!stop.signal.aborted && Date.now() < due) {
      // A failure here is logged by serveRequests as the request's; the poll will say if it persists.
      if (ok) ok = await serveRequests(deps, stop.signal).then(() => true, () => false);
      await sleep(Math.min(REQUEST_TICK_MS, due - Date.now()), undefined, { signal: stop.signal }).catch(() => undefined);
    }
  }
  deps.store.close();
  log.info('service_stopped');
}
