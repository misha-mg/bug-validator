import { z } from 'zod';
import { Env, parseEnv } from '../config.ts';

// The service's variables the UI shares, so their defaults are written once, plus its own.
const UiEnv = Env.pick({ JIRA_BASE_URL: true, DB_FILE: true }).extend({
  LOG_FILE: z.string().min(1).default('state/service.log'),
  UI_HOST: z.string().min(1).default('0.0.0.0'),
  UI_PORT: z.coerce.number().int().min(1).max(65535).default(8081),
});

export interface UiConfig {
  dbFile: string;
  logFile: string;
  jiraBaseUrl: string;
  host: string;
  port: number;
}

/** The UI starts without Jira credentials: it reads the database and the log, nothing else. */
export function loadUiConfig(env: NodeJS.ProcessEnv = process.env): UiConfig {
  const e = parseEnv(UiEnv, env);
  return { dbFile: e.DB_FILE, logFile: e.LOG_FILE, jiraBaseUrl: e.JIRA_BASE_URL, host: e.UI_HOST, port: e.UI_PORT };
}
