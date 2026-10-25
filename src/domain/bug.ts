export type Project = 'KAZ' | 'RPG';

export interface Attachment {
  filename: string;
}

export interface Comment {
  author: string;
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

/** What a bug report must contain (prd.md, Bug requirements). Related bugs are not one of them. */
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

/** Field facts: the program checks these, and the agent must name every one that fails. */
export const FIELD_FACTS: readonly RequirementId[] = ['R4', 'R5', 'R6'];

export const PROJECT_NAMES: Record<Project, string> = {
  KAZ: 'Kazaar — NPB hardware boxes (several board types)',
  RPG: 'Arpeggio — AFS, a virtual appliance on a general-purpose server',
};
