import { z } from 'zod';
import { REQUIREMENT_IDS, type RequirementId } from './bug.ts';

export const VerdictSchema = z.object({
  comment_needed: z.boolean(),
  comment: z.string().max(2000),
  missing: z.array(z.enum(REQUIREMENT_IDS)),
  related: z.array(z.object({ key: z.string().regex(/^(KAZ|RPG)-\d+$/), reason: z.string().max(200) })).max(5),
});

export type Verdict = z.infer<typeof VerdictSchema>;

/** The JSON Schema handed to `claude --json-schema` (which rejects the `$schema` key). */
const { $schema: _draft, ...verdictJsonSchemaBody } = z.toJSONSchema(VerdictSchema);
export const verdictJsonSchema: object = verdictJsonSchemaBody;

/** The agent's output broke the contract; the check fails and is retried. */
export class VerdictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'VerdictError';
  }
}

const MENTION = /\[~accountid:([^\]]*)\]/g;
const ANY_ISSUE_KEY = /\b[A-Z][A-Z0-9]*-\d+\b/g;
const OUR_KEY = /^(KAZ|RPG)-\d+$/;

export interface ParsedVerdict {
  verdict: Verdict;
  /** Mentions removed from the comment because they were not the reporter. */
  strippedMentions: string[];
  /** Every issue key the comment names; the caller checks they exist. */
  keysInComment: string[];
}

/**
 * Validates the agent's output and applies the guardrails that live in code: the JSON matches the
 * schema, "comment needed" and the comment agree, every failed field fact is named, the comment
 * mentions nobody but the reporter (and does mention them), and names only KAZ and RPG keys —
 * which the caller then checks exist.
 */
export function parseVerdict(raw: unknown, reporterAccountId: string | null, failedFacts: RequirementId[] = []): ParsedVerdict {
  const parsed = VerdictSchema.safeParse(raw);
  if (!parsed.success) {
    const problems = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`);
    throw new VerdictError(`agent output does not match the schema: ${problems.join('; ')}`);
  }
  const v = parsed.data;
  const missing = [...new Set(v.missing)].sort();

  const ignored = failedFacts.filter((id) => !missing.includes(id));
  if (ignored.length > 0) throw new VerdictError(`agent did not name failed field facts: ${ignored.join(', ')}`);
  if (missing.length > 0 && !v.comment_needed) throw new VerdictError(`requirements fail (${missing.join(', ')}) but no comment is needed`);

  const strippedMentions: string[] = [];
  let reporterMentioned = false;
  let comment = v.comment.replace(MENTION, (whole, id: string) => {
    if (id === reporterAccountId) {
      reporterMentioned = true;
      return whole;
    }
    strippedMentions.push(id);
    return '';
  });
  comment = comment.replace(/[ \t]+\n/g, '\n').trim();

  if (v.comment_needed) {
    if (comment === '') throw new VerdictError('a comment is needed but the comment is empty');
    if (reporterAccountId !== null && !reporterMentioned) throw new VerdictError('the comment does not mention the reporter');
  } else {
    comment = '';
  }

  const keysInComment = [...new Set(comment.match(ANY_ISSUE_KEY) ?? [])];
  const foreign = keysInComment.filter((k) => !OUR_KEY.test(k));
  if (foreign.length > 0) throw new VerdictError(`comment names issues outside KAZ and RPG: ${foreign.join(', ')}`);

  return { verdict: { ...v, comment, missing }, strippedMentions, keysInComment };
}
