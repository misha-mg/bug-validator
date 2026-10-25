import type { Agent } from '../claude/agent.ts';
import type { Config } from '../config.ts';
import type { Store } from '../db/store.ts';
import type { Jira } from '../jira/client.ts';

/** What the pipeline needs. Jira and the agent are interfaces, so tests run it with fakes. */
export interface Deps {
  config: Pick<Config, 'dryRun' | 'maxAttempts'>;
  jira: Jira;
  agent: Agent;
  store: Store;
}
