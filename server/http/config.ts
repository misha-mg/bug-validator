// The web UI's settings: where it listens, who may open it, and the service's database, log and
// Jira site, which it shares so their defaults are written once. The UI starts without Jira
// credentials: it reads the database and the log, nothing else.
import { z } from 'zod'
import { Env, parseEnv } from '../config.ts'
import { type CheckSettings, settingsDefaults } from '../store/settings.ts'
import type { Build } from '../version.ts'
import { type Guard, guardFromEnv } from './guard.ts'

const UiEnv = Env.pick({
  JIRA_BASE_URL: true,
  VALIDATOR_DB_FILE: true,
  VALIDATOR_LOG_FILE: true,
  // For the settings page: whether there is a webhook to tell, and the switch's default.
  VALIDATOR_SLACK_WEBHOOK_URL: true,
  VALIDATOR_SLACK_NOTIFICATIONS: true,
  VALIDATOR_PORTAL_URL: true,
}).extend({
  // This machine only, unless the deployment opens it on purpose (deploy/bug-validator-ui.service).
  VALIDATOR_HOST: z.string().min(1).default('127.0.0.1'),
  VALIDATOR_PORT: z.coerce.number().int().min(1).max(65535).default(8081),
  // Names the UI may be opened by besides IP addresses, localhost and this machine's name.
  VALIDATOR_HOSTNAMES: z.string().default(''),
  // Both set: the pages ask for this login (HTTP basic auth).
  VALIDATOR_USER: z.string().min(1).optional(),
  VALIDATOR_PASSWORD: z.string().min(1).optional(),
})

export interface UiConfig {
  dbFile: string
  logFile: string
  jiraBaseUrl: string
  host: string
  port: number
  /** The hosts answered to and the optional login (guard.ts). */
  guard: Guard
  /** The start page the masthead's mark leads to; the cockpit without it. */
  portalUrl?: string | undefined
  /** The code the console runs, for the footer (version.ts); none without it. */
  build?: Build | undefined
  /** The settings' defaults (store/settings.ts) and whether Slack has a webhook; the plan's own and no Slack when left out. */
  settings?: { defaults: CheckSettings; slackSetUp: boolean } | undefined
}

/** The realm the browser's login prompt names. */
export const REALM = 'Bug validator'

export function loadUiConfig(env: NodeJS.ProcessEnv = process.env): UiConfig {
  const e = parseEnv(UiEnv, env)
  return {
    dbFile: e.VALIDATOR_DB_FILE,
    logFile: e.VALIDATOR_LOG_FILE,
    jiraBaseUrl: e.JIRA_BASE_URL.replace(/\/+$/, ''),
    host: e.VALIDATOR_HOST,
    port: e.VALIDATOR_PORT,
    guard: guardFromEnv(e.VALIDATOR_HOSTNAMES, e.VALIDATOR_USER, e.VALIDATOR_PASSWORD, REALM),
    portalUrl: e.VALIDATOR_PORTAL_URL,
    settings: {
      defaults: settingsDefaults(e.VALIDATOR_SLACK_NOTIFICATIONS === 'true'),
      slackSetUp: e.VALIDATOR_SLACK_WEBHOOK_URL !== undefined,
    },
  }
}
