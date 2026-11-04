import { z } from 'zod';
import { Env, parseEnv } from '../config.ts';

// The service's variables the UI shares, so their defaults are written once, plus its own.
const UiEnv = Env.pick({ JIRA_BASE_URL: true, DB_FILE: true, LOG_FILE: true }).extend({
  // This machine only, unless the deployment opens it on purpose (deploy/bug-validator-ui.service).
  UI_HOST: z.string().min(1).default('127.0.0.1'),
  UI_PORT: z.coerce.number().int().min(1).max(65535).default(8081),
  // Names the UI may be opened by besides IP addresses, localhost and this machine's name.
  UI_HOSTNAMES: z.string().default(''),
  // Both set: the pages ask for this login (HTTP basic auth).
  UI_USER: z.string().min(1).optional(),
  UI_PASSWORD: z.string().min(1).optional(),
});

export interface UiConfig {
  dbFile: string;
  logFile: string;
  jiraBaseUrl: string;
  host: string;
  port: number;
  hostnames: string[];
  login: { user: string; password: string } | null;
}

/** The UI starts without Jira credentials: it reads the database and the log, nothing else. */
export function loadUiConfig(env: NodeJS.ProcessEnv = process.env): UiConfig {
  const e = parseEnv(UiEnv, env);
  if (Boolean(e.UI_USER) !== Boolean(e.UI_PASSWORD)) throw new Error('Bad configuration: UI_USER and UI_PASSWORD go together');
  return {
    dbFile: e.DB_FILE,
    logFile: e.LOG_FILE,
    jiraBaseUrl: e.JIRA_BASE_URL,
    host: e.UI_HOST,
    port: e.UI_PORT,
    hostnames: e.UI_HOSTNAMES.split(',').map((h) => h.trim().toLowerCase()).filter(Boolean),
    login: e.UI_USER && e.UI_PASSWORD ? { user: e.UI_USER, password: e.UI_PASSWORD } : null,
  };
}
