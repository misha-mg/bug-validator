import { z } from 'zod';
import { REQUIREMENT_IDS, REQUIREMENTS, type RequirementId } from './bug.ts';

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

// The requirements the comment lists, one line each; R7 is a question, not an item.
const LISTED_IDS: RequirementId[] = REQUIREMENT_IDS.filter((id) => id !== 'R7');

export interface ListedItem {
  id: RequirementId;
  /** Struck through (`- -HAR file-`): asked for earlier, there now. */
  struck: boolean;
}

/** The items a comment lists, by their names in REQUIREMENTS ("Device (AFS)" is the Device item). */
export function listedItems(comment: string): ListedItem[] {
  const items: ListedItem[] = [];
  for (const line of comment.split('\n')) {
    const text = /^- (.+)$/.exec(line.trim())?.[1]?.trim();
    if (!text) continue;
    const struck = /^-(.+)-$/.exec(text);
    const name = (struck?.[1] ?? text).trim();
    const id = LISTED_IDS.find((r) => name === REQUIREMENTS[r] || name.startsWith(`${REQUIREMENTS[r]} (`));
    if (id) items.push({ id, struck: struck !== null });
  }
  return items;
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
 * mentions nobody but the reporter (and does mention them), lists exactly what is missing, and
 * names only KAZ and RPG keys — which the caller then checks exist. On a re-check
 * (`previousComment` given) the comment is the previous one edited: kept, with every item it had,
 * and struck through only where the item was asked for before.
 */
export function parseVerdict(
  raw: unknown,
  reporterAccountId: string | null,
  failedFacts: RequirementId[] = [],
  previousComment: string | null = null,
): ParsedVerdict {
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

  if (previousComment !== null && !v.comment_needed) throw new VerdictError('a re-check must keep the comment');
  if (v.comment_needed) {
    if (comment === '') throw new VerdictError('a comment is needed but the comment is empty');
    if (reporterAccountId !== null && !reporterMentioned) throw new VerdictError('the comment does not mention the reporter');
    checkList(listedItems(comment), missing, previousComment);
  } else {
    comment = '';
  }

  const keysInComment = [...new Set(comment.match(ANY_ISSUE_KEY) ?? [])];
  const foreign = keysInComment.filter((k) => !OUR_KEY.test(k));
  if (foreign.length > 0) throw new VerdictError(`comment names issues outside KAZ and RPG: ${foreign.join(', ')}`);

  return { verdict: { ...v, comment, missing }, strippedMentions, keysInComment };
}

/** The comment's list agrees with `missing`; a re-check's list keeps the previous one's items. */
function checkList(listed: ListedItem[], missing: RequirementId[], previousComment: string | null): void {
  const asked = new Set(listed.filter((i) => !i.struck).map((i) => i.id));
  const struck = listed.filter((i) => i.struck).map((i) => i.id);
  const unlisted = missing.filter((id) => LISTED_IDS.includes(id) && !asked.has(id));
  const extra = [...asked].filter((id) => !missing.includes(id));
  if (unlisted.length > 0 || extra.length > 0) {
    throw new VerdictError(`the comment's list and missing disagree: not asked for ${unlisted.join(', ') || '-'}, asked for but not missing ${extra.join(', ') || '-'}`);
  }
  if (previousComment === null) {
    if (struck.length > 0) throw new VerdictError(`a first comment strikes items through: ${struck.join(', ')}`);
    return;
  }
  const before = new Set(listedItems(previousComment).map((i) => i.id));
  const dropped = [...before].filter((id) => !listed.some((i) => i.id === id));
  if (dropped.length > 0) throw new VerdictError(`the edited comment drops items of the previous one: ${dropped.join(', ')}`);
  const neverAsked = struck.filter((id) => !before.has(id));
  if (neverAsked.length > 0) throw new VerdictError(`the edited comment strikes items never asked for: ${neverAsked.join(', ')}`);
}
