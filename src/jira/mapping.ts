import { z } from 'zod';
import type { Bug, Project } from '../domain/bug.ts';
import type { RawIssue } from './client.ts';

const Named = z.object({ name: z.string() });
const Valued = z.object({ value: z.string() });

const IssueFields = z.object({
  summary: z.string(),
  description: z.string().nullable().default(null),
  status: Named,
  project: z.object({ key: z.string() }),
  labels: z.array(z.string()).default([]),
  versions: z.array(Named).default([]),
  customfield_10033: z.array(Valued).nullable().default(null),
  attachment: z.array(z.object({ filename: z.string() })).default([]),
  reporter: z.object({ accountId: z.string(), displayName: z.string() }).nullable().default(null),
  comment: z
    .object({
      comments: z.array(z.object({ author: z.object({ displayName: z.string() }).nullable(), created: z.string(), body: z.string().nullable() })),
    })
    .optional(),
  created: z.string(),
  updated: z.string(),
});

/** The issue JSON is not what the service expects: a per-bug failure, retried. */
export class MappingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MappingError';
  }
}

function project(key: string): Project {
  if (key === 'KAZ' || key === 'RPG') return key;
  throw new MappingError(`issue in unexpected project ${key}`);
}

export function toBug(raw: RawIssue): Bug {
  const parsed = IssueFields.safeParse(raw.fields);
  if (!parsed.success) throw new MappingError(`${raw.key}: ${parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`);
  const f = parsed.data;
  return {
    key: raw.key,
    project: project(f.project.key),
    summary: f.summary,
    description: f.description ?? '',
    status: f.status.name,
    reporter: f.reporter,
    labels: f.labels,
    versions: f.versions.map((v) => v.name),
    devices: (f.customfield_10033 ?? []).map((v) => v.value),
    attachments: f.attachment.map((a) => ({ filename: a.filename })),
    comments: (f.comment?.comments ?? []).map((c) => ({ author: c.author?.displayName ?? '(unknown)', created: c.created, body: c.body ?? '' })),
    created: f.created,
    updated: f.updated,
  };
}
