import type { Bug } from '../domain/bug.ts';
import { FIELD_FACTS } from '../domain/bug.ts';
import { runBaseChecks, type BaseCheck } from '../domain/checks.ts';
import { fingerprint } from '../domain/fingerprint.ts';
import { buildPrompt } from '../domain/prompt.ts';
import { parseVerdict, VerdictError, verdictJsonSchema, type Verdict } from '../domain/verdict.ts';
import { JiraError, type RawIssue } from '../jira/client.ts';
import { toBug } from '../jira/mapping.ts';
import type { Deps } from './deps.ts';

export interface CheckOutcome {
  bug: Bug;
  /** Of the report as the check read it. */
  fingerprint: string;
  baseChecks: BaseCheck[];
  verdict: Verdict;
  strippedMentions: string[];
  /** The comment as it would be posted, or null when the bug is complete. */
  comment: string | null;
  agent: { costUsd: number; durationMs: number; turns: number; model?: string | undefined; instructions?: string | undefined };
}

export interface CheckOptions {
  signal?: AbortSignal | undefined;
  /** A re-check: the comment the service made last time, which the agent edits. */
  previousComment?: string | null;
  /** The issue, when the caller has just read it. */
  issue?: RawIssue | undefined;
}

/** Checks one bug end to end. Reads Jira, runs the agent, writes nothing anywhere. */
export async function checkBug(deps: Pick<Deps, 'jira' | 'agent'>, key: string, options: CheckOptions = {}): Promise<CheckOutcome> {
  const previousComment = options.previousComment ?? null;
  const bug = toBug(options.issue ?? (await deps.jira.getIssue(key)));
  const baseChecks = runBaseChecks(bug);
  const run = await deps.agent.run(buildPrompt(bug, baseChecks, previousComment), verdictJsonSchema, options.signal);

  const failedFacts = baseChecks.filter((c) => !c.passed && FIELD_FACTS.includes(c.id)).map((c) => c.id);
  const { verdict, strippedMentions, keysInComment } = parseVerdict(run.output, bug.reporter?.accountId ?? null, failedFacts, previousComment);

  // A key the agent names must be a real issue; a made-up one fails the check (and is retried).
  // Read one by one: a read follows a bug moved to the other project, a search by key does not.
  const missing: string[] = [];
  for (const k of keysInComment.filter((k) => k !== bug.key)) {
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
    baseChecks,
    verdict,
    strippedMentions,
    comment: verdict.comment_needed ? verdict.comment : null,
    agent: { costUsd: run.costUsd, durationMs: run.durationMs, turns: run.turns, model: run.model, instructions: run.instructions },
  };
}
