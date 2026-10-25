import { createHash } from 'node:crypto';
import type { Bug } from './bug.ts';

/**
 * A hash of the report: what the check reads. Comments, labels, assignee and status are left out,
 * so the service's own comment and the QA lead's hand-off are not changes; a move to the other
 * project is one.
 */
export function fingerprint(bug: Bug): string {
  const report = {
    project: bug.project,
    summary: bug.summary,
    description: bug.description,
    versions: [...bug.versions].sort(),
    devices: [...bug.devices].sort(),
    attachments: bug.attachments.map((a) => a.filename).sort(),
  };
  return createHash('sha256').update(JSON.stringify(report)).digest('hex').slice(0, 16);
}
