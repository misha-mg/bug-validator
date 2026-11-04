// Counts by period and outcome, the field checks failed most often, bugs per day, field checks passed after a comment.
import { OUTCOMES, REQUIREMENT_IDS, REQUIREMENTS, type Outcome, type RequirementId } from '../domain/bug.ts'
import { type BugView, type Result, checked, firstRun, result } from './read.ts'

/** count of total; with a handful of bugs a percentage alone says little, so both are kept. */
export interface Share {
  count: number
  total: number
}

export interface Stats {
  /** Bugs checked to the end, by the time of their first check. */
  checked: number
  byOutcome: Record<Outcome, Share>
  /** Bugs whose last attempt failed: to be tried again, or left after the last attempt. */
  errors: number
  /** What the agent spent on every check of these bugs, the failed ones included. */
  costUsd: number
}

/**
 * Stats of the bugs first checked at or after `since` (all of them when it is not given): a bug
 * counts on the day the report arrived, so a later re-check does not move it.
 */
export function periodStats(bugs: BugView[], since?: Date): Stats {
  const inside = bugs.filter((b) => !since || b.firstCheckedAt >= since)
  const done = inside.filter(checked)
  const byOutcome = Object.fromEntries(
    OUTCOMES.map((o) => [o, { count: done.filter((b) => result(b) === o).length, total: done.length }]),
  ) as Record<Outcome, Share>
  return {
    checked: done.length,
    byOutcome,
    errors: inside.filter((b) => result(b) === 'error').length,
    costUsd: inside.reduce((sum, b) => sum + b.history.reduce((s, run) => s + (run.costUsd ?? 0), 0), 0),
  }
}

export interface Gap {
  id: RequirementId
  name: string
  /** Bugs whose first check found this field check failed, of every bug checked to the end. */
  share: Share
}

/**
 * Every item of the list with how often the first checks found it absent, the most common first:
 * the reports as they arrived, which is what the PRD's success metric is about. R7 has no field
 * check and shows as never found.
 */
export function gaps(bugs: BugView[]): Gap[] {
  const done = bugs.filter(checked)
  const failed = new Map<RequirementId, number>()
  for (const bug of done)
    for (const c of (firstRun(bug)?.fieldChecks ?? bug.fieldChecks).filter((c) => !c.passed)) failed.set(c.id, (failed.get(c.id) ?? 0) + 1)
  const found = REQUIREMENT_IDS.map((id) => ({ id, name: REQUIREMENTS[id], share: { count: failed.get(id) ?? 0, total: done.length } }))
  // A stable sort keeps R1–R7 order among equal counts.
  return found.sort((a, b) => b.share.count - a.share.count)
}

export interface Day {
  day: Date
  counts: Record<Result, number>
}

/** Bugs by the local day of their first check and their result now, oldest day first; skipped bugs left out. */
export function checksPerDay(bugs: BugView[], lastDay: Date, days: number): Day[] {
  const start = startOfDay(lastDay)
  const perDay = new Map<string, Day>()
  for (let i = days - 1; i >= 0; i--) {
    const day = new Date(start.getFullYear(), start.getMonth(), start.getDate() - i)
    perDay.set(dayKey(day), { day, counts: { understood: 0, not_understood: 0, not_webui: 0, error: 0, skipped: 0 } })
  }
  for (const bug of bugs) {
    const kind = result(bug)
    const day = perDay.get(dayKey(bug.firstCheckedAt))
    if (kind !== 'skipped' && day) day.counts[kind] += 1
  }
  return [...perDay.values()]
}

/** Bugs a person must look at: a failed check (a re-check of a commented bug included) or one not a WebUI bug; the latest first. */
export function needsAttention(bugs: BugView[]): BugView[] {
  return bugs.filter((b) => result(b) === 'error' || result(b) === 'not_webui' || b.error !== null)
}

/**
 * Over bugs re-checked after their comment: the field checks the first check found failed, and
 * how many of them the last check found passed — what arrived while the bug was still in Created.
 */
export function fieldChecksPassedAfterComment(bugs: BugView[]): Share {
  const share = { count: 0, total: 0 }
  for (const bug of bugs) {
    const finished = bug.history.filter((run) => run.error === null)
    if (!bug.comment || finished.length < 2) continue
    const last = finished.at(-1)!
    for (const check of finished[0]!.fieldChecks.filter((c) => !c.passed)) {
      share.total += 1
      if (last.fieldChecks.some((c) => c.id === check.id && c.passed)) share.count += 1
    }
  }
  return share
}

export const startOfDay = (d: Date): Date => new Date(d.getFullYear(), d.getMonth(), d.getDate())

const dayKey = (d: Date): string => `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`
