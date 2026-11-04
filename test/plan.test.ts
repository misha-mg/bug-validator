import assert from 'node:assert/strict';
import { describe, it } from 'vitest';
import type { BugRow } from '../src/db/store.ts';
import { FIRST_CHECK_AGE_MS, MAX_CHECKS, plan, QUIET_BEFORE_RECHECK_MS, type Watched } from '../src/pipeline/plan.ts';

const NOW = Date.parse('2026-10-26T12:00:00Z');
const MIN = 60_000;
const bug = (key: string, ageMin: number, quietMin = ageMin, fingerprint = 'new'): Watched => ({ id: `id-${key}`, key, created: NOW - ageMin * MIN, updated: NOW - quietMin * MIN, fingerprint });
const row = (status: BugRow['status'], fingerprint: string | null = 'old', runs = 1): BugRow => ({ status, fingerprint, comment: 'c', commentId: status === 'commented' ? '9' : null, runs });
const keys = (p: ReturnType<typeof plan>) => ({ first: p.first.map((b) => b.key), recheck: p.recheck.map((r) => r.bug.key), waiting: p.waiting });

describe('plan', () => {
  it('a new bug waits until it is 30 minutes old; a failed attempt is retried at once', () => {
    assert.equal(FIRST_CHECK_AGE_MS, 30 * MIN);
    const p = plan([bug('KAZ-1', 29), bug('KAZ-2', 30), bug('KAZ-3', 5)], new Map([['KAZ-3', row('retry')]]), NOW, true);
    assert.deepEqual(keys(p), { first: ['KAZ-2', 'KAZ-3'], recheck: [], waiting: 1 });
  });
  it('a changed report is re-checked once nothing has moved on the bug for 15 minutes', () => {
    assert.equal(QUIET_BEFORE_RECHECK_MS, 15 * MIN);
    const rows = new Map([['KAZ-1', row('dry_run')], ['KAZ-2', row('dry_run')], ['KAZ-3', row('dry_run', 'new')]]);
    const p = plan([bug('KAZ-1', 90, 14), bug('KAZ-2', 90, 15), bug('KAZ-3', 90, 60)], rows, NOW, true);
    assert.deepEqual(keys(p), { first: [], recheck: ['KAZ-2'], waiting: 1 }, 'KAZ-3 did not change');
  });
  it('re-checks only bugs not understood, with the comment of the current mode, a fingerprint, and up to the cap', () => {
    const rows = new Map([
      ['KAZ-1', row('commented')],
      ['KAZ-2', row('dry_run')],
      ['KAZ-3', row('dry_run', null)],
      ['KAZ-4', row('dry_run', 'old', MAX_CHECKS)],
      ['KAZ-5', row('failed')],
      ['KAZ-6', row('skipped')],
      ['KAZ-7', row('posting')],
      ['KAZ-8', row('understood')],
      ['KAZ-9', row('not_webui')],
    ]);
    const all = [1, 2, 3, 4, 5, 6, 7, 8, 9].map((n) => bug(`KAZ-${n}`, 90));
    assert.deepEqual(keys(plan(all, rows, NOW, true)).recheck, ['KAZ-2']);
    assert.deepEqual(keys(plan(all, rows, NOW, false)).recheck, ['KAZ-1']);
  });
  it('an issue that cannot be read as a bug is not re-checked', () => {
    const p = plan([{ ...bug('KAZ-1', 90), fingerprint: null }], new Map([['KAZ-1', row('dry_run')]]), NOW, true);
    assert.deepEqual(keys(p), { first: [], recheck: [], waiting: 0 });
  });
});
