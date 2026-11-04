// What the pipeline needs: config, Jira, the agent, the clone, the store; interfaces, so tests use fakes.
import type { Agent } from '../claude/agent.ts'
import type { Config } from '../config.ts'
import type { Store } from '../store/store.ts'
import type { Jira } from '../jira/client.ts'
import type { Clone } from '../webui/clone.ts'

/** What the pipeline needs. Jira, the agent and the clone are interfaces, so tests run it with fakes. */
export interface Deps {
  config: Pick<Config, 'dryRun' | 'maxAttempts' | 'pollIntervalMs'>
  jira: Jira
  agent: Agent
  clone: Pick<Clone, 'update'>
  store: Store
}
