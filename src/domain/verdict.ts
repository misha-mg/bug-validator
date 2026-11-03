import { z } from 'zod';
import { OUTCOMES, type Outcome } from './bug.ts';

/** What the agent returns (agent/instructions.md, Output). */
export const VerdictSchema = z.object({
  outcome: z.enum(OUTCOMES),
  /** For whoever tunes the instructions: `check` prints it, the service keeps nothing of it. */
  reasoning: z.string().max(6000),
  /** `not_webui`: why, for the person who decides. */
  reason: z.string().max(400),
  /** `not_understood`: the comment to the reporter. */
  comment: z.string().max(2000),
});

/** The JSON Schema handed to `claude --json-schema` (which rejects the `$schema` key). */
const { $schema: _draft, ...verdictJsonSchemaBody } = z.toJSONSchema(VerdictSchema);
export const verdictJsonSchema: object = verdictJsonSchemaBody;

/** The verdict as recorded: the outcome, what goes with it, and the bugs the comment names. */
export interface Verdict {
  outcome: Outcome;
  reason: string;
  comment: string;
  /** The KAZ and RPG keys the comment names, the bug's own left out; the caller checks they exist. */
  related: string[];
}

/** The agent's output broke the contract; the check fails and is retried. */
export class VerdictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'VerdictError';
  }
}

const MENTION = /\[~accountid:([^\]]*)\]/gi;
const KEY = /\b(?:KAZ|RPG)-\d+\b/g;

export interface ParsedVerdict {
  verdict: Verdict;
  reasoning: string;
  /** Mentions removed from the comment because they were not the reporter. */
  strippedMentions: string[];
}

export interface VerdictContext {
  bugKey: string;
  reporterAccountId: string | null;
  /** What the agent could read in its sandbox and must not repeat (claude/agent.ts). */
  secrets: string[];
}

/**
 * Validates the agent's output and applies the guardrails that live in code: the JSON matches the
 * schema; the outcome and the rest agree (a comment exactly when the bug is not understood, a
 * reason when it is not a WebUI bug); the comment opens with the reporter's mention alone — not
 * style: that line is how the service finds its own comment in Jira — and mentions nobody else;
 * no secret of the run is in any field. The wording is the agent's (prd.md, Comment). The keys
 * the comment names are returned for the caller to check against Jira.
 */
export function parseVerdict(raw: unknown, ctx: VerdictContext): ParsedVerdict {
  const parsed = VerdictSchema.safeParse(raw);
  if (!parsed.success) {
    const problems = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`);
    throw new VerdictError(`agent output does not match the schema: ${problems.join('; ')}`);
  }
  const v = parsed.data;
  for (const [field, text] of Object.entries(v)) {
    const leaked = ctx.secrets.find((s) => s !== '' && typeof text === 'string' && text.includes(s));
    if (leaked) throw new VerdictError(`the agent's ${field} holds a secret of the run`);
  }

  if (v.outcome !== 'not_understood') {
    if (v.comment.trim() !== '') throw new VerdictError(`outcome ${v.outcome} comes with a comment`);
    if (v.outcome === 'not_webui' && v.reason.trim() === '') throw new VerdictError('not_webui without a reason');
    return { verdict: { outcome: v.outcome, reason: v.outcome === 'not_webui' ? v.reason.trim() : '', comment: '', related: [] }, reasoning: v.reasoning, strippedMentions: [] };
  }

  const strippedMentions: string[] = [];
  let comment = v.comment.replace(MENTION, (_whole, id: string) => {
    if (id === ctx.reporterAccountId) return `[~accountid:${id}]`;
    strippedMentions.push(id);
    return '';
  });
  comment = comment.replace(/[ \t]+\n/g, '\n').trim();
  if (comment === '') throw new VerdictError('not_understood without a comment');
  if (ctx.reporterAccountId !== null) {
    const first = comment.split('\n')[0]!.trim();
    if (first !== `[~accountid:${ctx.reporterAccountId}]`) throw new VerdictError(`the comment's first line is not the reporter's mention alone: "${first.slice(0, 80)}"`);
    if (comment.split('\n').slice(1).join('\n').trim() === '') throw new VerdictError('the comment is the mention alone');
  }
  const related = [...new Set(comment.match(KEY) ?? [])].filter((k) => k !== ctx.bugKey);
  return { verdict: { outcome: 'not_understood', reason: '', comment, related }, reasoning: v.reasoning, strippedMentions };
}
