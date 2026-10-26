import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { readBugs } from '../../src/ui/read.ts';
import { checksPerDay, itemsAddedAfterComment, needsAttention, periodStats, problems, startOfDay } from '../../src/ui/stats.ts';
import { DAY, ago, sampleState } from './state.ts';

const state = sampleState();
const bugs = readBugs(state.dbFile);

describe('stats', () => {
  it('counts the checks of each period', () => {
    const all = periodStats(bugs);
    assert.deepEqual(all, { checked: 3, withoutComment: { count: 1, total: 3 }, withComment: { count: 2, total: 3 }, errors: 1 });
    const week = periodStats(bugs, ago(7 * DAY, state.now));
    assert.deepEqual([week.checked, week.withComment.count, week.errors], [2, 1, 1]);
    const today = periodStats(bugs, startOfDay(state.now));
    assert.deepEqual([today.checked, today.withComment.count, today.errors], [1, 1, 0]);
    assert.deepEqual(periodStats([]).withComment, { count: 0, total: 0 });
  });
  it('problems are the requirements found failed on the first check, the most common first', () => {
    const found = problems(bugs);
    assert.deepEqual(found.slice(0, 3).map((p) => [p.id, p.share.count]), [['R6', 2], ['R1', 1], ['R4', 1]]);
    assert.equal(found[0]?.share.total, 3);
    assert.equal(found[0]?.name, 'HAR file');
    assert.deepEqual(found.map((p) => p.id).sort(), ['R1', 'R2', 'R3', 'R4', 'R5', 'R6', 'R7']);
  });
  it('checks per day leave out skipped bugs and cover every day of the span', () => {
    const days = checksPerDay(bugs, state.now, 30);
    assert.equal(days.length, 30);
    assert.deepEqual(days[29]?.counts, { comment: 1, no_comment: 0, error: 0, skipped: 0 });
    assert.deepEqual(days[28]?.counts, { comment: 0, no_comment: 0, error: 1, skipped: 0 });
    assert.deepEqual(days[26]?.counts, { comment: 0, no_comment: 1, error: 0, skipped: 0 });
    assert.equal(days[9]?.counts.skipped, 0);
    assert.equal(days.reduce((n, d) => n + d.counts.comment + d.counts.no_comment + d.counts.error, 0), 4);
  });
  it('needs attention is the failed checks', () => {
    assert.deepEqual(needsAttention(bugs).map((b) => b.key), ['RPG-4']);
  });
  it('items added after the comment are the struck-through ones of re-checked bugs', () => {
    // KAZ-2 was re-checked and its comment strikes one of three items; KAZ-5 was checked once.
    assert.deepEqual(itemsAddedAfterComment(bugs), { count: 1, total: 3 });
  });
});
