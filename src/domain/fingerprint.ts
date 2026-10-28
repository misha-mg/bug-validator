import { createHash } from 'node:crypto';
import type { Bug } from './bug.ts';

/**
 * A hash of the report: what the check reads. Labels, assignee and status are left out, and of the
 * comments only the reporter's count, so the service's own comment and the QA lead's hand-off are
 * not changes; a move to the other project is one, and so is the reporter answering in a comment.
 */
export function fingerprint(bug: Bug): string {
  const reporterId = bug.reporter?.accountId;
  // The service's comment opens with the reporter's mention; the service's account may be the
  // reporter's, and its own comment must not read as an answer.
  const answers = reporterId
    ? bug.comments.filter((c) => c.authorId === reporterId && !c.body.trimStart().startsWith(`[~accountid:${reporterId}]`)).map((c) => c.body)
    : [];
  const report = {
    project: bug.project,
    summary: bug.summary,
    description: bug.description,
    versions: [...bug.versions].sort(),
    devices: [...bug.devices].sort(),
    attachments: bug.attachments.map((a) => a.filename).sort(),
    // Only when there are some: the fingerprints of reports without them stay as they were.
    ...(answers.length > 0 ? { answers } : {}),
  };
  return createHash('sha256').update(JSON.stringify(report)).digest('hex').slice(0, 16);
}
