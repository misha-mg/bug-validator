// The service's settings, read once from the environment through one zod schema into one typed
// Config; the other modules take config objects, never process.env. Every setting of the
// project's own carries the VALIDATOR_ prefix; the Jira login (JIRA_*) and the Claude token keep
// the names both projects share. A bad value fails fast, and so does an old, unprefixed name: a
// deployment must not fall back to a default without noticing.
import { existsSync } from 'node:fs'
import { z } from 'zod'

export const Env = z.object({
  // The Jira site, for links and for the cloud id lookup (jira/client.ts); no default: the site is the deployment's.
  JIRA_BASE_URL: z.url(),
  // Read once from <JIRA_BASE_URL>/_edge/tenant_info when unset.
  JIRA_CLOUD_ID: z.string().min(1).optional(),
  JIRA_EMAIL: z.email(),
  JIRA_API_TOKEN: z.string().min(1),
  // Safe default: nothing is written to Jira unless VALIDATOR_DRY_RUN=false is set on purpose.
  VALIDATOR_DRY_RUN: z.enum(['true', 'false']).default('true'),
  VALIDATOR_POLL_INTERVAL_SECONDS: z.coerce.number().int().positive().default(180),
  VALIDATOR_DB_FILE: z.string().min(1).default('state/bug-validator.sqlite'),
  // The service logs to stdout; this is where the systemd unit appends it (the UI and `maintain` read it).
  VALIDATOR_LOG_FILE: z.string().min(1).default('state/service.log'),
  // The agent's model and caps are provisional until the measurement (the PRD, Rollout, step 3).
  VALIDATOR_AGENT_MODEL: z.string().min(1).default('sonnet'),
  VALIDATOR_AGENT_TIMEOUT_SECONDS: z.coerce.number().int().positive().default(600),
  VALIDATOR_AGENT_MAX_TURNS: z.coerce.number().int().positive().default(100),
  VALIDATOR_AGENT_MAX_BUDGET_USD: z.coerce.number().positive().default(2),
  // Long-lived token from `claude setup-token`: the sandbox has no other login.
  CLAUDE_CODE_OAUTH_TOKEN: z.string().min(1),
  // The WebUI repository the agent reads, cloned by the service for itself with the machine's git
  // credentials; no default: the repository is the deployment's.
  VALIDATOR_WEBUI_REPO_URL: z.string().min(1),
  VALIDATOR_WEBUI_DIR: z.string().min(1).default('state/webui'),
  // Slack: an incoming webhook's URL, a secret; unset, no messages are sent. The switch keeps the
  // URL in place while the messages are off.
  VALIDATOR_SLACK_WEBHOOK_URL: z.url().optional(),
  VALIDATOR_SLACK_NOTIFICATIONS: z.enum(['true', 'false']).default('true'),
  // The console's address as a person opens it, for the link in a message; unset, the message links to Jira alone.
  VALIDATOR_CONSOLE_URL: z.url().optional(),
})

/** A bug's first check is tried this many times, then the bug is recorded as failed. */
export const MAX_ATTEMPTS = 3

/**
 * The names the variables had before the VALIDATOR_ prefix (2026-11-04). One of them set while
 * its new name is not fails the configuration, so a deployment cannot silently run on defaults.
 */
const RENAMED: Record<string, string> = {
  DRY_RUN: 'VALIDATOR_DRY_RUN',
  POLL_INTERVAL_SECONDS: 'VALIDATOR_POLL_INTERVAL_SECONDS',
  DB_FILE: 'VALIDATOR_DB_FILE',
  LOG_FILE: 'VALIDATOR_LOG_FILE',
  BACKUP_DIR: 'VALIDATOR_BACKUP_DIR',
  AGENT_MODEL: 'VALIDATOR_AGENT_MODEL',
  AGENT_TIMEOUT_SECONDS: 'VALIDATOR_AGENT_TIMEOUT_SECONDS',
  AGENT_MAX_TURNS: 'VALIDATOR_AGENT_MAX_TURNS',
  AGENT_MAX_BUDGET_USD: 'VALIDATOR_AGENT_MAX_BUDGET_USD',
  WEBUI_REPO_URL: 'VALIDATOR_WEBUI_REPO_URL',
  WEBUI_DIR: 'VALIDATOR_WEBUI_DIR',
  UI_HOST: 'VALIDATOR_HOST',
  UI_PORT: 'VALIDATOR_PORT',
  UI_HOSTNAMES: 'VALIDATOR_HOSTNAMES',
  UI_USER: 'VALIDATOR_USER',
  UI_PASSWORD: 'VALIDATOR_PASSWORD',
}

export interface Config {
  jira: JiraConfig
  dryRun: boolean
  pollIntervalMs: number
  dbFile: string
  agent: { model: string; timeoutMs: number; maxTurns: number; maxBudgetUsd: number; token: string }
  webui: { repoUrl: string; dir: string }
  /** Null: no Slack, by the switch or for want of a webhook. */
  slack: { webhookUrl: string; consoleUrl: string | null } | null
  maxAttempts: number
}

/** The Jira site and login; the cloud id, when null, is read from the site once (jira/client.ts). */
export interface JiraConfig {
  baseUrl: string
  cloudId: string | null
  email: string
  apiToken: string
}

/**
 * The environment through a schema; `.env` in the working directory is loaded first, and a
 * variable already in the environment wins. Fails fast with every problem named.
 */
export function parseEnv<T extends z.ZodType>(schema: T, env: NodeJS.ProcessEnv): z.infer<T> {
  if (env === process.env && existsSync('.env')) process.loadEnvFile('.env')
  const renamed = Object.entries(RENAMED)
    .filter(([old, now]) => env[old] !== undefined && env[now] === undefined)
    .map(([old, now]) => `${old} is now ${now}`)
  const parsed = schema.safeParse(env)
  const problems = parsed.success ? [] : parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`)
  if (renamed.length || !parsed.success) throw new Error(`Bad configuration: ${[...renamed, ...problems].join('; ')}`)
  return parsed.data
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const e = parseEnv(Env, env)
  return {
    jira: {
      baseUrl: e.JIRA_BASE_URL.replace(/\/+$/, ''),
      cloudId: e.JIRA_CLOUD_ID ?? null,
      email: e.JIRA_EMAIL,
      apiToken: e.JIRA_API_TOKEN,
    },
    dryRun: e.VALIDATOR_DRY_RUN === 'true',
    pollIntervalMs: e.VALIDATOR_POLL_INTERVAL_SECONDS * 1000,
    dbFile: e.VALIDATOR_DB_FILE,
    agent: {
      model: e.VALIDATOR_AGENT_MODEL,
      timeoutMs: e.VALIDATOR_AGENT_TIMEOUT_SECONDS * 1000,
      maxTurns: e.VALIDATOR_AGENT_MAX_TURNS,
      maxBudgetUsd: e.VALIDATOR_AGENT_MAX_BUDGET_USD,
      token: e.CLAUDE_CODE_OAUTH_TOKEN,
    },
    webui: { repoUrl: e.VALIDATOR_WEBUI_REPO_URL, dir: e.VALIDATOR_WEBUI_DIR },
    slack:
      e.VALIDATOR_SLACK_NOTIFICATIONS === 'true' && e.VALIDATOR_SLACK_WEBHOOK_URL !== undefined
        ? { webhookUrl: e.VALIDATOR_SLACK_WEBHOOK_URL, consoleUrl: e.VALIDATOR_CONSOLE_URL?.replace(/\/+$/, '') ?? null }
        : null,
    maxAttempts: MAX_ATTEMPTS,
  }
}
