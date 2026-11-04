import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AgentRun } from '../claude/agent.ts';
import type { Bug, RunFile } from '../domain/bug.ts';
import { checkFields, type FieldCheck } from '../domain/checks.ts';
import { fingerprint } from '../domain/fingerprint.ts';
import { buildPrompt } from '../domain/prompt.ts';
import { parseVerdict, VerdictError, verdictJsonSchema, type Verdict } from '../domain/verdict.ts';
import { JiraError, type RawIssue } from '../jira/client.ts';
import { toBug } from '../jira/mapping.ts';
import { prepareFiles } from './attachments.ts';
import type { Deps } from './deps.ts';

export interface CheckOutcome {
  bug: Bug;
  /** Of the report as the check read it. */
  fingerprint: string;
  fieldChecks: FieldCheck[];
  verdict: Verdict;
  /** The agent's reasoning: printed by `check`, recorded with the run, shown in the UI, never posted. */
  reasoning: string;
  files: RunFile[];
  webuiCommit: string;
  strippedMentions: string[];
  agent: { costUsd: number; durationMs: number; turns: number; model?: string | undefined; instructions?: string | undefined };
}

export interface CheckOptions {
  signal?: AbortSignal | undefined;
  /** A re-check: the comment the service made last time, which the agent edits. */
  previousComment?: string | null;
  /** The issue, when the caller has just read it. */
  issue?: RawIssue | undefined;
  /** How old the clone's last fetch may be; the service passes its poll interval, `check` never fetches. */
  cloneMaxAgeMs?: number;
}

/** Checks one bug end to end. Reads Jira, brings the clone to master, runs the agent, writes nothing anywhere. */
export async function checkBug(deps: Pick<Deps, 'jira' | 'agent' | 'clone'>, key: string, options: CheckOptions = {}): Promise<CheckOutcome> {
  const previousComment = options.previousComment ?? null;
  const bug = toBug(options.issue ?? (await deps.jira.getIssue(key)));
  const fieldChecks = checkFields(bug);
  const webuiCommit = await deps.clone.update(options.cloneMaxAgeMs ?? Infinity);
  // The run's files, in a directory of this run's own; gone with the run.
  const runDir = mkdtempSync(join(tmpdir(), 'bug-validator-run-'));
  const bugDir = join(runDir, 'bug');
  let files: RunFile[];
  let run: AgentRun;
  try {
    mkdirSync(bugDir);
    files = await prepareFiles(deps.jira, bug, bugDir);
    run = await deps.agent.run(buildPrompt(bug, fieldChecks, files, webuiCommit, previousComment), verdictJsonSchema, bugDir, options.signal);
  } finally {
    rmSync(runDir, { recursive: true, force: true });
  }

  const { verdict, reasoning, strippedMentions } = parseVerdict(run.output, { bugKey: bug.key, reporterAccountId: bug.reporter?.accountId ?? null, secrets: run.secrets });

  // A key the agent names must be a real issue; a made-up one fails the check (and is retried).
  // Read one by one: a read follows a bug moved to the other project, a search by key does not.
  const missing: string[] = [];
  for (const k of verdict.related) {
    try {
      await deps.jira.getIssue(k);
    } catch (err) {
      if (err instanceof JiraError && err.status === 404) missing.push(k);
      else throw err;
    }
  }
  if (missing.length > 0) throw new VerdictError(`comment names issues that do not exist: ${missing.join(', ')}`);

  return {
    bug,
    fingerprint: fingerprint(bug),
    fieldChecks,
    verdict,
    reasoning,
    files,
    webuiCommit,
    strippedMentions,
    agent: { costUsd: run.costUsd, durationMs: run.durationMs, turns: run.turns, model: run.model, instructions: run.instructions },
  };
}
