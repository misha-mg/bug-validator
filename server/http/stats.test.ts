// Tests of stats.ts: the numbers the home page shows.
import assert from 'node:assert/strict'
import { describe, it } from 'vitest'
import { readBugs } from './read.ts'
import {
  PERIODS,
  type Period,
  chartDays,
  checksPerDay,
  fieldChecksPassedAfterComment,
  gaps,
  needsAttention,
  periodBugs,
  periodOf,
  periodStart,
  periodStats,
  startOfDay,
} from './stats.ts'
import { DAY, ago, daysAgo, emptyState, insert, run, sampleState, stamp } from './sample.ts'

const state = sampleState()
const bugs = readBugs(state.dbFile)
const share = (count: number, total: number) => ({ count, total })

describe('stats', () => {
  it("counts the checks of each period by outcome, with the agent's cost", () => {
    const { since, ...all } = periodStats(bugs)
    assert.deepEqual(all, {
      checked: 4,
      byOutcome: { understood: share(1, 4), not_understood: share(2, 4), not_webui: share(1, 4) },
      errors: 1,
      checks: 6,
      costUsd: 0.15,
      medianCostUsd: 0.03,
    })
    assert.equal(since?.getTime(), daysAgo(20, state.now).getTime(), 'the skipped bug counts here; the page leaves it out')
    const week = periodStats(bugs, ago(7 * DAY, state.now))
    assert.deepEqual([week.checked, week.byOutcome.not_understood.count, week.errors, week.costUsd], [3, 1, 1, 0.12])
    const today = periodStats(bugs, startOfDay(state.now))
    assert.deepEqual([today.checked, today.byOutcome.not_understood.count, today.errors, today.costUsd], [1, 1, 0, 0.06])
    assert.deepEqual(periodStats([]).byOutcome.understood, share(0, 0))
    assert.deepEqual([periodStats([]).medianCostUsd, periodStats([]).since], [null, null])
  })
  it('a period is the bugs first checked in it, skipped ones never; its chart spans it, all time at most 90 days', () => {
    const keys = (period: Period) => periodBugs(bugs, period, state.now).map((b) => b.key)
    assert.deepEqual(keys('today'), ['KAZ-2'])
    assert.deepEqual(keys('7d'), ['KAZ-2', 'RPG-4', 'KAZ-3', 'RPG-6'])
    assert.deepEqual(keys('all'), ['KAZ-2', 'RPG-4', 'KAZ-3', 'RPG-6', 'KAZ-5'])
    assert.equal(periodStart('today', state.now)?.getTime(), startOfDay(state.now).getTime())
    assert.equal(periodStart('7d', state.now)?.getTime(), daysAgo(6, startOfDay(state.now)).getTime())
    assert.equal(periodStart('all', state.now), undefined)
    assert.deepEqual(
      PERIODS.map((p) => periodOf(p)),
      PERIODS,
    )
    assert.equal(periodOf('nonsense'), '30d')
    assert.equal(periodOf(null), '30d')
    assert.deepEqual([chartDays('today', bugs, state.now), chartDays('7d', bugs, state.now), chartDays('30d', bugs, state.now)], [1, 7, 30])
    assert.equal(chartDays('all', bugs, state.now), 11, 'from the first check 10 days ago to today')
    assert.equal(chartDays('all', [], state.now), 7)
    const s = emptyState()
    insert(s.dbFile, { key: 'KAZ-9', status: 'understood', checked_at: stamp(daysAgo(200, s.now)) })
    run(s.dbFile, 'KAZ-9', daysAgo(200, s.now), [])
    assert.equal(chartDays('all', readBugs(s.dbFile), s.now), 90)
  })
  it('gaps are the field checks found failed on the first check, the most common first', () => {
    const found = gaps(bugs)
    assert.deepEqual(
      found.slice(0, 3).map((p) => [p.id, p.share.count]),
      [
        ['R6', 3],
        ['R1', 1],
        ['R4', 1],
      ],
    )
    assert.equal(found[0]?.share.total, 4)
    assert.equal(found[0]?.name, 'HAR file')
    assert.deepEqual(found.map((p) => p.id).sort(), ['R1', 'R2', 'R3', 'R4', 'R5', 'R6', 'R7'])
  })
  it('checks per day leave out skipped bugs and cover every day of the span', () => {
    const days = checksPerDay(bugs, state.now, 30)
    assert.equal(days.length, 30)
    const none = { understood: 0, not_understood: 0, not_webui: 0, error: 0, skipped: 0 }
    assert.deepEqual(days[29]?.counts, { ...none, not_understood: 1 })
    assert.deepEqual(days[28]?.counts, { ...none, error: 1 })
    assert.deepEqual(days[26]?.counts, { ...none, understood: 1 })
    assert.deepEqual(days[24]?.counts, { ...none, not_webui: 1 })
    assert.equal(days[9]?.counts.skipped, 0)
    assert.equal(
      days.reduce((n, d) => n + d.counts.understood + d.counts.not_understood + d.counts.not_webui + d.counts.error, 0),
      5,
    )
  })
  it('a bug counts on the day of its first check: a later re-check does not move it', () => {
    const s = emptyState()
    insert(s.dbFile, { key: 'KAZ-8', status: 'dry_run', checked_at: stamp(s.now), comment: 'c' })
    run(s.dbFile, 'KAZ-8', daysAgo(3, s.now), ['R6'], null, 'c')
    run(s.dbFile, 'KAZ-8', s.now, [], null, 'c')
    const moved = readBugs(s.dbFile)
    assert.equal(periodStats(moved, startOfDay(s.now)).checked, 0, 'not checked today: re-checked today')
    assert.equal(checksPerDay(moved, s.now, 7)[3]?.counts.not_understood, 1)
  })
  it("needs attention is the failed checks, a failed re-check of a bug with a comment included, and the bugs not the WebUI's", () => {
    assert.deepEqual(
      needsAttention(bugs).map((b) => b.key),
      ['RPG-4', 'RPG-6'],
    )
    const s = emptyState()
    insert(s.dbFile, {
      key: 'KAZ-9',
      status: 'commented',
      checked_at: stamp(s.now),
      comment: 'c',
      comment_id: '1',
      error: 'WriteRefused: HTTP 404',
    })
    assert.deepEqual(
      needsAttention(readBugs(s.dbFile)).map((b) => b.key),
      ['KAZ-9'],
    )
  })
  it('field checks passed after the comment: failed at the first check, passed by the report now, over commented bugs', () => {
    // KAZ-2: one of the three failed at its first check passes now; KAZ-5: its one still fails.
    assert.deepEqual(fieldChecksPassedAfterComment(bugs), { count: 1, total: 4 })
  })
})
