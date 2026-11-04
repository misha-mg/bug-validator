// The words both consoles write for a date, a duration and a time ago; the module itself is the
// same file as pipeline-ui's, so this pins what bug-validator's pages rely on.
import assert from 'node:assert/strict'
import { describe, it } from 'vitest'
import { DASH, cut, fmtAgo, fmtDate, fmtDay, fmtDuration, fmtShare, fmtTime, plural } from './format.ts'

const at = new Date(2026, 10, 4, 23, 10, 5) // Wed 4 Nov 2026, local time

describe('format', () => {
  it('writes a date and a time the ISO way, a day with its weekday', () => {
    assert.equal(fmtDate(at), '2026-11-04')
    assert.equal(fmtTime(at), '2026-11-04 23:10')
    assert.equal(fmtDay(at), 'Wed 04 Nov')
    assert.equal(fmtTime(null), DASH)
    assert.equal(fmtTime('not a date'), DASH)
  })
  it('writes a duration in two units at most', () => {
    assert.equal(fmtDuration(3), '3s')
    assert.equal(fmtDuration(303), '5m 03s')
    assert.equal(fmtDuration(3900), '1h 05m')
    assert.equal(fmtDuration(2 * 86400 + 4 * 3600), '2d 04h')
    assert.equal(fmtDuration(null), DASH)
  })
  it('writes a time ago in the same words', () => {
    const now = at
    assert.equal(fmtAgo(now, now), 'just now')
    assert.equal(fmtAgo(new Date(now.getTime() - 303_000), now), '5m 03s ago')
    assert.equal(fmtAgo(new Date(now.getTime() - 125 * 60_000), now), '2h 05m ago')
    assert.equal(fmtAgo(new Date(now.getTime() - (3 * 24 + 4) * 3_600_000), now), '3d 04h ago')
  })
  it('counts, shares and cuts', () => {
    assert.equal(plural(1, 'bug'), '1 bug')
    assert.equal(plural(3, 'bug'), '3 bugs')
    assert.equal(fmtShare(11, 13), '85% (11)')
    assert.equal(fmtShare(0, 0), DASH)
    assert.equal(cut('a  long\n line', 6), 'a lon…')
  })
})
