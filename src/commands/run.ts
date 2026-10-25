import { setTimeout as sleep } from 'node:timers/promises';
import { ClaudeAgent } from '../claude/agent.ts';
import { loadConfig } from '../config.ts';
import { Store } from '../db/store.ts';
import { JiraClient } from '../jira/client.ts';
import { describeError, log } from '../log.ts';
import type { Deps } from '../pipeline/deps.ts';
import { poll } from '../pipeline/poll.ts';

/** The service: poll, sleep, repeat, until SIGINT or SIGTERM. Polls never overlap. */
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
    try {
      const summary = await poll(deps, stop.signal);
      log.info('poll', { ...summary, ms: Date.now() - started });
    } catch (err) {
      // Jira or claude is unavailable: an error, not a quiet poll. The next poll simply tries again.
      log.error('poll_failed', { error: describeError(err), ms: Date.now() - started });
    }
    await sleep(config.pollIntervalMs, undefined, { signal: stop.signal }).catch(() => undefined);
  }
  deps.store.close();
  log.info('service_stopped');
}
