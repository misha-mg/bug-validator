import { readFileSync } from 'node:fs'
import type { Bug } from '../server/domain/bug.ts'
import type { RawIssue } from '../server/jira/client.ts'
import { toBug } from '../server/jira/mapping.ts'

export function rawIssue(key: string): RawIssue {
  return JSON.parse(readFileSync(new URL(`./fixtures/${key}.json`, import.meta.url), 'utf8')) as RawIssue
}

export function bug(key: string, overrides: Partial<Bug> = {}): Bug {
  return { ...toBug(rawIssue(key)), ...overrides }
}
