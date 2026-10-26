import { REQUIREMENT_IDS, REQUIREMENTS, type RequirementId } from '../domain/bug.ts';
import { listedItems } from '../domain/verdict.ts';
import { type BugView, type Result, checked, firstMissing, result } from './read.ts';

/** count of total; with a handful of bugs a percentage alone says little, so both are kept. */
export interface Share {
  count: number;
  total: number;
}

export interface Stats {
  /** Bugs checked to the end, by the time of the check. */
  checked: number;
  withoutComment: Share;
  withComment: Share;
  /** Bugs whose last attempt failed: to be tried again, or left after the last attempt. */
  errors: number;
}

/** Stats of the checks made at or after `since` (all of them when it is not given). */
export function periodStats(bugs: BugView[], since?: Date): Stats {
  const inside = bugs.filter((b) => !since || b.checkedAt >= since);
  const done = inside.filter(checked);
  const commented = done.filter((b) => result(b) === 'comment');
  return {
    checked: done.length,
    withoutComment: { count: done.length - commented.length, total: done.length },
    withComment: { count: commented.length, total: done.length },
    errors: inside.filter((b) => result(b) === 'error').length,
  };
}

export interface Problem {
  id: RequirementId;
  name: string;
  /** Bugs whose first check found this requirement failed, of every bug checked to the end. */
  share: Share;
}

/**
 * Every requirement with how often the first checks found it failed, the most common first: the
 * reports as they arrived, which is what the PRD's success metric is about.
 */
export function problems(bugs: BugView[]): Problem[] {
  const done = bugs.filter(checked);
  const failed = new Map<RequirementId, number>();
  for (const bug of done) for (const id of firstMissing(bug)) failed.set(id, (failed.get(id) ?? 0) + 1);
  const found = REQUIREMENT_IDS.map((id) => ({ id, name: REQUIREMENTS[id], share: { count: failed.get(id) ?? 0, total: done.length } }));
  // A stable sort keeps R1–R7 order among equal counts.
  return found.sort((a, b) => b.share.count - a.share.count);
}

export interface Day {
  day: Date;
  counts: Record<Result, number>;
}

/** Checks by the local day they were made and their result, oldest day first; skipped bugs left out. */
export function checksPerDay(bugs: BugView[], lastDay: Date, days: number): Day[] {
  const start = startOfDay(lastDay);
  const perDay = new Map<string, Day>();
  for (let i = days - 1; i >= 0; i--) {
    const day = new Date(start.getFullYear(), start.getMonth(), start.getDate() - i);
    perDay.set(dayKey(day), { day, counts: { comment: 0, no_comment: 0, error: 0, skipped: 0 } });
  }
  for (const bug of bugs) {
    const kind = result(bug);
    const day = perDay.get(dayKey(bug.checkedAt));
    if (kind !== 'skipped' && day) day.counts[kind] += 1;
  }
  return [...perDay.values()];
}

/** Checks whose last attempt failed, the latest first. */
export function needsAttention(bugs: BugView[]): BugView[] {
  return bugs.filter((b) => result(b) === 'error');
}

/**
 * Over bugs that were re-checked after their comment: the items the comment asked for, and how
 * many of them arrived (struck through) while the bug was still in Created.
 */
export function itemsAddedAfterComment(bugs: BugView[]): Share {
  const share = { count: 0, total: 0 };
  for (const bug of bugs) {
    if (!bug.comment || bug.history.filter((run) => run.error === null).length < 2) continue;
    for (const item of listedItems(bug.comment)) {
      share.total += 1;
      if (item.struck) share.count += 1;
    }
  }
  return share;
}

export const startOfDay = (d: Date): Date => new Date(d.getFullYear(), d.getMonth(), d.getDate());

const dayKey = (d: Date): string => `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
