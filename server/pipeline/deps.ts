// What the pipeline needs: config, Jira, the agent, the clone, the store, the notifier; interfaces, so tests use fakes.
import type { Agent } from '../claude/agent.ts'
import type { Config } from '../config.ts'
import type { Store } from '../store/store.ts'
import type { Jira } from '../jira/client.ts'
import type { Notifier } from '../notify/slack.ts'
import type { Clone } from '../webui/clone.ts'
import type { Timing } from './plan.ts'

/** What the pipeline needs. Jira, the agent, the clone and the notifier are interfaces, so tests run it with fakes. */
export interface Deps {
  config: Pick<Config, 'dryRun' | 'maxAttempts' | 'pollIntervalMs'>
  jira: Jira
  agent: Agent
  clone: Pick<Clone, 'update'>
  store: Store
  /** Told of every check that ends not understood, after its record. */
  notifier: Notifier
  /** When a bug is due, asked at every poll: the console may change it (store/settings.ts). The plan's defaults without it. */
  timing?: () => Timing
}
