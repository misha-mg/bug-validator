import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { listedItems, parseVerdict, VerdictError } from '../src/domain/verdict.ts';

const REPORTER = '712020:a91caa38';
const LIST = 'Please add:\n- Steps to reproduce\n- HAR file';
const sample = {
  comment_needed: true,
  comment: `[~accountid:${REPORTER}]\n${LIST}\n\nPossibly related: KAZ-8871 (same page), KAZ-8169`,
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
    const { verdict, strippedMentions } = parseVerdict({ ...sample, comment: `[~accountid:someone-else] hi [~accountid:${REPORTER}]\n${LIST}` }, REPORTER);
    assert.equal(verdict.comment, `hi [~accountid:${REPORTER}]\n${LIST}`);
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
    assert.throws(() => parseVerdict({ ...sample, comment: LIST }, REPORTER), /mention the reporter/);
    assert.doesNotThrow(() => parseVerdict({ ...sample, comment: LIST }, null), 'no reporter known: nothing to mention');
  });
  it('requires every failed field fact to be named', () => {
    assert.throws(() => parseVerdict(sample, REPORTER, ['R4', 'R6']), /R4/);
    assert.doesNotThrow(() => parseVerdict(sample, REPORTER, ['R6']));
  });
  it('rejects issue keys outside KAZ and RPG', () => {
    assert.throws(() => parseVerdict({ ...sample, comment: `[~accountid:${REPORTER}]\n${LIST}\nSee DM-123` }, REPORTER), /outside KAZ and RPG: DM-123/);
  });
  it('requires the comment to list exactly what is missing; R7 is a question, not an item', () => {
    assert.throws(() => parseVerdict({ ...sample, missing: ['R6'] }, REPORTER), /asked for but not missing R1/);
    assert.throws(() => parseVerdict({ ...sample, missing: ['R1', 'R4', 'R6'] }, REPORTER), /not asked for R4/);
    assert.doesNotThrow(() => parseVerdict({ ...sample, missing: ['R1', 'R6', 'R7'] }, REPORTER));
    assert.throws(() => parseVerdict({ ...sample, comment: `[~accountid:${REPORTER}]\nPlease add:\n- Steps to reproduce\n- -HAR file-`, missing: ['R1'] }, REPORTER), /first comment strikes items through: R6/);
  });
});

describe('a re-check', () => {
  const before = `[~accountid:${REPORTER}]\n${LIST}\n\nPossibly related: KAZ-8871 (same page)`;
  const edited = (list: string) => ({ ...sample, comment: `[~accountid:${REPORTER}]\nPlease add:\n${list}\n\nPossibly related: KAZ-8871 (same page)` });
  it('accepts the previous comment with what arrived struck through and what is new added', () => {
    const { verdict } = parseVerdict({ ...edited('- -Steps to reproduce-\n- HAR file\n- Affects versions'), missing: ['R4', 'R6'] }, REPORTER, ['R4', 'R6'], before);
    assert.deepEqual(verdict.missing, ['R4', 'R6']);
    assert.doesNotThrow(() => parseVerdict({ ...edited('- -Steps to reproduce-\n- -HAR file-'), missing: [] }, REPORTER, [], before), 'complete: all struck, comment kept');
  });
  it('keeps the comment and every item of it, and strikes only what was asked for', () => {
    assert.throws(() => parseVerdict({ ...sample, comment_needed: false, missing: [] }, REPORTER, [], before), /must keep the comment/);
    assert.throws(() => parseVerdict({ ...edited('- HAR file'), missing: ['R6'] }, REPORTER, [], before), /drops items of the previous one: R1/);
    assert.throws(() => parseVerdict({ ...edited('- -Steps to reproduce-\n- -HAR file-\n- -Device-'), missing: [] }, REPORTER, [], before), /never asked for: R5/);
    assert.throws(() => parseVerdict({ ...edited('- -Steps to reproduce-\n- -HAR file-'), missing: ['R6'] }, REPORTER, ['R6'], before), /not asked for R6/, 'a missing item struck');
  });
  it('reads list items by name, struck or not', () => {
    assert.deepEqual(listedItems('Please add:\n- -Steps to reproduce-\n- Device (AFS)\n- something else\n\nPossibly related: KAZ-1 (x)'), [
      { id: 'R1', struck: true },
      { id: 'R5', struck: false },
    ]);
  });
});
