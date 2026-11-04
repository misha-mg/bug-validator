// The web UI's settings: where it listens, who may open it, and the service's database, log and
// Jira site, which it shares so their defaults are written once. The UI starts without Jira
// credentials: it reads the database and the log, nothing else.
import { z } from 'zod'
import { Env, parseEnv } from '../config.ts'
import { type Guard, guardFromEnv } from './guard.ts'

const UiEnv = Env.pick({ JIRA_BASE_URL: true, DB_FILE: true, LOG_FILE: true }).extend({
  // This machine only, unless the deployment opens it on purpose (deploy/bug-validator-ui.service).
  UI_HOST: z.string().min(1).default('127.0.0.1'),
  UI_PORT: z.coerce.number().int().min(1).max(65535).default(8081),
  // Names the UI may be opened by besides IP addresses, localhost and this machine's name.
  UI_HOSTNAMES: z.string().default(''),
  // Both set: the pages ask for this login (HTTP basic auth).
  UI_USER: z.string().min(1).optional(),
  UI_PASSWORD: z.string().min(1).optional(),
})

export interface UiConfig {
  dbFile: string
  logFile: string
  jiraBaseUrl: string
  host: string
  port: number
  /** The hosts answered to and the optional login (guard.ts). */
  guard: Guard
}

/** The realm the browser's login prompt names. */
export const REALM = 'Bug validator'

export function loadUiConfig(env: NodeJS.ProcessEnv = process.env): UiConfig {
  const e = parseEnv(UiEnv, env)
  return {
    dbFile: e.DB_FILE,
    logFile: e.LOG_FILE,
    jiraBaseUrl: e.JIRA_BASE_URL,
    host: e.UI_HOST,
    port: e.UI_PORT,
    guard: guardFromEnv(e.UI_HOSTNAMES, e.UI_USER, e.UI_PASSWORD, REALM),
  }
}
