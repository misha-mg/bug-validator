export type Project = 'KAZ' | 'RPG';

export interface Attachment {
  /** Jira's id: what the content is read by. */
  id: string;
  filename: string;
  /** Bytes. */
  size: number;
  mimeType: string;
}

export interface Comment {
  id: string;
  author: string;
  /** Null for a deleted user. */
  authorId: string | null;
  created: string;
  body: string;
}

export interface Bug {
  key: string;
  project: Project;
  summary: string;
  description: string;
  status: string;
  reporter: { accountId: string; displayName: string } | null;
  labels: string[];
  /** Affects versions, by name. */
  versions: string[];
  /** The Devices field, by value. */
  devices: string[];
  attachments: Attachment[];
  comments: Comment[];
  created: string;
  updated: string;
}

/** What the agent gets of an attachment: the kind says how it was made, `unread` why it was not. */
export type FileKind = 'image' | 'har' | 'frames' | 'text' | 'unread';

export interface RunFile {
  /** The attachment's name as the reporter gave it. */
  filename: string;
  /** The path under the run's directory: a file, or a directory of frames. Empty when unread. */
  path: string;
  kind: FileKind;
  note: string;
}

/** What a check ends in (prd.md, The check). Only `not_understood` gets a comment. */
export const OUTCOMES = ['understood', 'not_understood', 'not_webui'] as const;
export type Outcome = (typeof OUTCOMES)[number];

/** The list (prd.md, The check): a guide for the agent and the web UI's statistics, not a rule. */
export const REQUIREMENT_IDS = ['R1', 'R2', 'R3', 'R4', 'R5', 'R6', 'R7'] as const;
export type RequirementId = (typeof REQUIREMENT_IDS)[number];

export const REQUIREMENTS: Record<RequirementId, string> = {
  R1: 'Steps to reproduce',
  R2: 'Expected result',
  R3: 'Actual result',
  R4: 'Affects versions',
  R5: 'Device',
  R6: 'HAR file',
  R7: 'Project matches the product',
};

/** The field checks that are facts of the fields (R4–R6); for R1–R3 the code only looks for a heading. `scripts/late-changes.ts` measures by them. */
export const FIELD_FACTS: readonly RequirementId[] = ['R4', 'R5', 'R6'];

export const PROJECT_NAMES: Record<Project, string> = {
  KAZ: 'Kazaar — NPB hardware boxes (several board types)',
  RPG: 'Arpeggio — AFS, a virtual appliance on a general-purpose server',
};
