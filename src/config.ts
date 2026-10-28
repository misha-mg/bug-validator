import { existsSync } from 'node:fs';
import { z } from 'zod';

export const Env = z.object({
  JIRA_BASE_URL: z.url().default('https://cgstowernetworks.atlassian.net'),
  JIRA_CLOUD_ID: z.string().min(1).default('0ba987c4-6759-4967-afaa-f80e0e69c8fc'),
  JIRA_EMAIL: z.email(),
  JIRA_API_TOKEN: z.string().min(1),
  // Safe default: nothing is written to Jira unless DRY_RUN=false is set on purpose.
  DRY_RUN: z.enum(['true', 'false']).default('true'),
  POLL_INTERVAL_SECONDS: z.coerce.number().int().positive().default(180),
  DB_FILE: z.string().min(1).default('state/bug-validator.sqlite'),
  // The service logs to stdout; this is where the systemd unit appends it (the UI and `maintain` read it).
  LOG_FILE: z.string().min(1).default('state/service.log'),
  AGENT_MODEL: z.string().min(1).default('haiku'),
  AGENT_TIMEOUT_SECONDS: z.coerce.number().int().positive().default(180),
  // A check costs about $0.002 on haiku; the cap stops a run that loops, not a normal one.
  AGENT_MAX_BUDGET_USD: z.coerce.number().positive().default(0.5),
  // Long-lived token from `claude setup-token`; without it claude uses the machine's own login.
  CLAUDE_CODE_OAUTH_TOKEN: z.string().min(1).optional(),
});

/** A bug's first check is tried this many times, then the bug is recorded as failed. */
export const MAX_ATTEMPTS = 3;

export interface Config {
  jira: { baseUrl: string; cloudId: string; email: string; apiToken: string };
  dryRun: boolean;
  pollIntervalMs: number;
  dbFile: string;
  agent: { model: string; timeoutMs: number; maxBudgetUsd: number; auth: 'oauth_token' | 'cli_login' };
  maxAttempts: number;
}

/** The environment through a schema; `.env` in the working directory is loaded first. Fails fast on a bad value. */
export function parseEnv<T extends z.ZodType>(schema: T, env: NodeJS.ProcessEnv): z.infer<T> {
  if (env === process.env && existsSync('.env')) process.loadEnvFile('.env');
  const parsed = schema.safeParse(env);
  if (!parsed.success) {
    const problems = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`);
    throw new Error(`Bad configuration: ${problems.join('; ')}`);
  }
  return parsed.data;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const e = parseEnv(Env, env);
  return {
    jira: { baseUrl: e.JIRA_BASE_URL, cloudId: e.JIRA_CLOUD_ID, email: e.JIRA_EMAIL, apiToken: e.JIRA_API_TOKEN },
    dryRun: e.DRY_RUN === 'true',
    pollIntervalMs: e.POLL_INTERVAL_SECONDS * 1000,
    dbFile: e.DB_FILE,
    agent: {
      model: e.AGENT_MODEL,
      timeoutMs: e.AGENT_TIMEOUT_SECONDS * 1000,
      maxBudgetUsd: e.AGENT_MAX_BUDGET_USD,
      auth: e.CLAUDE_CODE_OAUTH_TOKEN ? 'oauth_token' : 'cli_login',
    },
    maxAttempts: MAX_ATTEMPTS,
  };
}
