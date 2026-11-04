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
  /** Every check of these bugs, the re-checks and the failed ones included. */
  checks: number
  /** What the agent spent on every check of these bugs, the failed ones included. */
  costUsd: number
  /** The cost of the middle check; null before a check with a cost. */
  medianCostUsd: number | null
  /** The first check of the period's bugs, or null without one. */
  since: Date | null
}

/** The statistics page's periods: bugs first checked today, in the last 7 or 30 days, or ever. */
export type Period = 'today' | '7d' | '30d' | 'all'
export const PERIODS: readonly Period[] = ['today', '7d', '30d', 'all']
export const PERIOD_LABEL: Record<Period, string> = { today: 'Today', '7d': '7 days', '30d': '30 days', all: 'All time' }
const PERIOD_DAYS: Record<Period, number | null> = { today: 1, '7d': 7, '30d': 30, all: null }

/** `?period=`; 30 days unless the parameter names another period. */
export const periodOf = (value: string | null): Period => ((PERIODS as readonly string[]).includes(value ?? '') ? (value as Period) : '30d')

/** The moment a period starts: today's midnight, the same clock n days ago, or nothing for all time. */
export function periodStart(period: Period, now: Date): Date | undefined {
  const days = PERIOD_DAYS[period]
  if (days === null) return undefined
  const start = startOfDay(now)
  start.setDate(start.getDate() - (days - 1))
  return start
}

/** The bugs of a period: those first checked in it (skipped bugs never were, so a period has none). */
export const periodBugs = (bugs: BugView[], period: Period, now: Date): BugView[] => {
  const since = periodStart(period, now)
  return bugs.filter((b) => result(b) !== 'skipped' && (!since || b.firstCheckedAt >= since))
}

/** How many days the period's chart shows: the period's own, or for all time the days since the first check, 90 at most. */
export function chartDays(period: Period, bugs: BugView[], now: Date): number {
  const days = PERIOD_DAYS[period]
  if (days !== null) return days
  const first = bugs.filter((b) => result(b) !== 'skipped').map((b) => b.firstCheckedAt.getTime())
  if (!first.length) return 7
  const span = Math.floor((startOfDay(now).getTime() - startOfDay(new Date(Math.min(...first))).getTime()) / DAY_MS) + 1
  return Math.min(90, Math.max(7, span))
}
const DAY_MS = 24 * 60 * 60 * 1000

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
  const runs = inside.flatMap((b) => b.history)
  const costs = runs
    .map((run) => run.costUsd)
    .filter((c): c is number => c !== null)
    .sort((a, b) => a - b)
  const first = inside.map((b) => b.firstCheckedAt.getTime())
  return {
    checked: done.length,
    byOutcome,
    errors: inside.filter((b) => result(b) === 'error').length,
    checks: runs.length,
    costUsd: costs.reduce((sum, c) => sum + c, 0),
    medianCostUsd: costs.length ? costs[Math.floor(costs.length / 2)]! : null,
    since: first.length ? new Date(Math.min(...first)) : null,
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
