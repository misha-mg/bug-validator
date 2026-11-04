import { readFileSync } from 'node:fs'
import type { Bug } from '../src/domain/bug.ts'
import type { RawIssue } from '../src/jira/client.ts'
import { toBug } from '../src/jira/mapping.ts'

export function rawIssue(key: string): RawIssue {
  return JSON.parse(readFileSync(new URL(`./fixtures/${key}.json`, import.meta.url), 'utf8')) as RawIssue
}

export function bug(key: string, overrides: Partial<Bug> = {}): Bug {
  return { ...toBug(rawIssue(key)), ...overrides }
}
