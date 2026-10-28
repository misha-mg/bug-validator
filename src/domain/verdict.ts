import { z } from 'zod';
import { REQUIREMENT_IDS, REQUIREMENTS, type RequirementId } from './bug.ts';
import { ISSUE_KEY } from './key.ts';

export const VerdictSchema = z.object({
  comment_needed: z.boolean(),
  comment: z.string().max(2000),
  missing: z.array(z.enum(REQUIREMENT_IDS)),
  related: z.array(z.object({ key: z.string().regex(ISSUE_KEY), reason: z.string().max(200) })).max(5),
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

/** An item's names in a comment: its name in REQUIREMENTS, and "Device (AFS)" on an RPG bug. */
const ITEM_NAMES: [RequirementId, string][] = [...LISTED_IDS.map((id): [RequirementId, string] => [id, REQUIREMENTS[id]]), ['R5', 'Device (AFS)']];

/** R7's question, one per direction (agent/instructions.md, The comment). */
export const R7_QUESTIONS = ['This looks like an AFS issue — should it be in RPG?', 'This looks like an NPB hardware issue — should it be in KAZ?'];

// A reason of a few plain words: no Jira markup (links, images, mentions, macros, emphasis), no URL.
const RELATED_LINE = /^Possibly related: ((?:KAZ|RPG)-\d+) \(([^()[\]{}|!^*_~<>]{1,60})\)$/;
const URL_LIKE = /https?:|www\.|\/\//i;
const MENTION = /\[~accountid:([^\]]*)\]/gi;

export interface ListedItem {
  id: RequirementId;
  /** Struck through (`- -HAR file-`): asked for earlier, there now. */
  struck: boolean;
}

/** `-text-` → the text and true; anything else → itself and false. */
function unstrike(text: string): { text: string; struck: boolean } {
  const struck = /^-(.+)-$/.exec(text);
  return struck ? { text: struck[1]!.trim(), struck: true } : { text, struck: false };
}

/** The items a comment lists, by their names; lines that are not items are passed over. */
export function listedItems(comment: string): ListedItem[] {
  const items: ListedItem[] = [];
  for (const line of comment.split('\n')) {
    const text = /^- (.+)$/.exec(line.trim())?.[1]?.trim();
    if (!text) continue;
    const { text: name, struck } = unstrike(text);
    const id = ITEM_NAMES.find(([, n]) => n === name)?.[0];
    if (id) items.push({ id, struck });
  }
  return items;
}

/** What a comment is made of, line by line. */
export interface CommentParts {
  items: ListedItem[];
  /** R7's question, if the comment asks it. */
  question: { struck: boolean } | null;
  related: { key: string; reason: string }[];
  /** The related lines as written: a re-check keeps them as they were. */
  relatedLines: string[];
}

/**
 * Reads a comment in the one shape it may have (agent/instructions.md, The comment): the
 * reporter's mention on the first line, "Please add:" and the items, R7's question, the related
 * bugs, blank lines. Any other line — free text, a link, an image, an item that is not a
 * requirement — fails the check: whatever a report's text talked the agent into stays out of Jira.
 */
export function commentParts(comment: string, reporterAccountId: string | null): CommentParts {
  const parts: CommentParts = { items: [], question: null, related: [], relatedLines: [] };
  const lines = comment.split('\n').map((l) => l.trim());
  let first = true;
  let pleaseAdd = false;
  for (const line of lines) {
    if (line === '') continue;
    if (first) {
      first = false;
      if (reporterAccountId !== null) {
        if (line !== `[~accountid:${reporterAccountId}]`) throw new VerdictError(`the comment's first line is not the reporter's mention alone: "${line.slice(0, 80)}"`);
        continue;
      }
    }
    if (line === 'Please add:') {
      if (pleaseAdd || parts.items.length > 0) throw new VerdictError('"Please add:" is not once, before the items');
      pleaseAdd = true;
      continue;
    }
    const item = /^- (.+)$/.exec(line)?.[1];
    if (item !== undefined) {
      const { text, struck } = unstrike(item.trim());
      const id = ITEM_NAMES.find(([, n]) => n === text)?.[0];
      if (!id) throw new VerdictError(`the comment lists something that is not a requirement: "${line.slice(0, 80)}"`);
      if (!pleaseAdd) throw new VerdictError('the comment lists items without "Please add:"');
      parts.items.push({ id, struck });
      continue;
    }
    const { text: question, struck } = unstrike(line);
    if (R7_QUESTIONS.includes(question)) {
      if (parts.question) throw new VerdictError('the comment asks about the project twice');
      parts.question = { struck };
      continue;
    }
    const related = RELATED_LINE.exec(line);
    if (related && !URL_LIKE.test(related[2]!)) {
      parts.related.push({ key: related[1]!, reason: related[2]! });
      parts.relatedLines.push(line);
      continue;
    }
    throw new VerdictError(`the comment has a line its format does not allow: "${line.slice(0, 80)}"`);
  }
  if (pleaseAdd && parts.items.length === 0) throw new VerdictError('"Please add:" with no items');
  return parts;
}

export interface ParsedVerdict {
  verdict: Verdict;
  /** Mentions removed from the comment because they were not the reporter. */
  strippedMentions: string[];
  /** The issue keys the comment names as related; the caller checks they exist. */
  keysInComment: string[];
}

/**
 * Validates the agent's output and applies the guardrails that live in code: the JSON matches the
 * schema, "comment needed" and the comment agree, every failed field fact is named, the comment
 * mentions nobody but the reporter, has only the lines its format allows, lists exactly what is
 * missing, asks R7's question exactly when R7 is missing, and names only KAZ and RPG keys — which
 * the caller then checks exist. The related bugs are the ones the comment names. On a re-check
 * (`previousComment` given) the comment is the previous one edited: kept, with every item, the
 * question and the related lines it had, and struck through only where something was asked before.
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
  if (previousComment !== null && !v.comment_needed) throw new VerdictError('a re-check must keep the comment');
  if (!v.comment_needed) return { verdict: { ...v, comment: '', missing, related: [] }, strippedMentions: [], keysInComment: [] };

  const strippedMentions: string[] = [];
  let comment = v.comment.replace(MENTION, (whole, id: string) => {
    if (id === reporterAccountId) return `[~accountid:${id}]`;
    strippedMentions.push(id);
    return '';
  });
  comment = comment.replace(/[ \t]+\n/g, '\n').trim();
  if (comment === '') throw new VerdictError('a comment is needed but the comment is empty');

  const parts = commentParts(comment, reporterAccountId);
  checkList(parts.items, missing, previousComment);
  const asksR7 = parts.question !== null && !parts.question.struck;
  if (asksR7 !== missing.includes('R7')) throw new VerdictError(asksR7 ? 'the comment asks about the project but R7 is not missing' : 'R7 is missing but the comment does not ask about the project');

  if (previousComment === null) {
    if (parts.question?.struck) throw new VerdictError('a first comment strikes the project question through');
    if (missing.length === 0 && parts.related.length === 0) throw new VerdictError('a comment is needed but it neither asks for anything nor names a related bug');
  } else {
    // Read loosely: a comment recorded before a rule was tightened still has to be kept.
    const previous = previousComment.split('\n').map((l) => l.trim());
    const before = {
      question: previous.some((l) => unstrike(l).text.startsWith('This looks like')),
      relatedLines: previous.filter((l) => l.startsWith('Possibly related:')),
    };
    if (before.question && !parts.question) throw new VerdictError('the edited comment drops the project question');
    if (parts.question?.struck && !before.question) throw new VerdictError('the edited comment strikes through a project question never asked');
    if (parts.relatedLines.join('\n') !== before.relatedLines.join('\n')) throw new VerdictError('the edited comment changes the related bugs');
  }

  const keysInComment = [...new Set(parts.related.map((r) => r.key))];
  return { verdict: { ...v, comment, missing, related: parts.related }, strippedMentions, keysInComment };
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
  const ids = listed.map((i) => i.id);
  const twice = ids.filter((id, i) => ids.indexOf(id) !== i);
  if (twice.length > 0) throw new VerdictError(`the comment lists an item twice: ${[...new Set(twice)].join(', ')}`);
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
