import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { parseVerdict, VerdictError } from '../src/domain/verdict.ts';

const REPORTER = '712020:a91caa38';
const sample = {
  comment_needed: true,
  comment: `[~accountid:${REPORTER}]\nPlease add:\n- HAR file\n\nPossibly related: KAZ-8871 (same page), KAZ-8169`,
  missing: ['R6', 'R6', 'R1'],
  related: [{ key: 'KAZ-8871', reason: 'same page' }],
};

describe('parseVerdict', () => {
  it('keeps the reporter mention, dedupes missing, lists the keys named', () => {
    const { verdict, strippedMentions, keysInComment } = parseVerdict(sample, REPORTER);
    assert.ok(verdict.comment.startsWith(`[~accountid:${REPORTER}]\nPlease add:`));
    assert.deepEqual(strippedMentions, []);
    assert.deepEqual(verdict.missing, ['R1', 'R6']);
    assert.deepEqual(keysInComment, ['KAZ-8871', 'KAZ-8169']);
  });
  it('strips every mention that is not the reporter', () => {
    const { verdict, strippedMentions } = parseVerdict({ ...sample, comment: '[~accountid:someone-else] hi [~accountid:' + REPORTER + '] there' }, REPORTER);
    assert.equal(verdict.comment, 'hi [~accountid:' + REPORTER + '] there');
    assert.deepEqual(strippedMentions, ['someone-else']);
  });
  it('empties the comment when none is needed', () => {
    const { verdict, keysInComment } = parseVerdict({ ...sample, comment_needed: false, missing: [] }, REPORTER);
    assert.equal(verdict.comment, '');
    assert.deepEqual(keysInComment, []);
  });
  it('rejects unknown requirement ids and bad keys', () => {
    assert.throws(() => parseVerdict({ ...sample, missing: ['R10'] }, REPORTER), VerdictError);
    assert.throws(() => parseVerdict({ ...sample, related: [{ key: 'ABC-1', reason: '' }] }, REPORTER), VerdictError);
  });
  it('rejects a verdict whose parts disagree', () => {
    assert.throws(() => parseVerdict({ ...sample, comment: '' }, REPORTER), /comment is empty/);
    assert.throws(() => parseVerdict({ ...sample, comment: '[~accountid:other]' }, REPORTER), /comment is empty/, 'only a stripped mention');
    assert.throws(() => parseVerdict({ ...sample, comment_needed: false }, REPORTER), /no comment is needed/);
    assert.throws(() => parseVerdict({ ...sample, comment: 'Please add:\n- HAR file' }, REPORTER), /mention the reporter/);
    assert.doesNotThrow(() => parseVerdict({ ...sample, comment: 'Please add:\n- HAR file' }, null), 'no reporter known: nothing to mention');
  });
  it('requires every failed field fact to be named', () => {
    assert.throws(() => parseVerdict(sample, REPORTER, ['R4', 'R6']), /R4/);
    assert.doesNotThrow(() => parseVerdict(sample, REPORTER, ['R6']));
  });
  it('rejects issue keys outside KAZ and RPG', () => {
    assert.throws(() => parseVerdict({ ...sample, comment: `[~accountid:${REPORTER}]\nSee DM-123` }, REPORTER), /outside KAZ and RPG: DM-123/);
  });
});
