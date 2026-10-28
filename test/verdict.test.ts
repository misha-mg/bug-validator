import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { listedItems, parseVerdict, R7_QUESTIONS, VerdictError } from '../src/domain/verdict.ts';

const REPORTER = '712020:a91caa38';
const MENTION = `[~accountid:${REPORTER}]`;
const LIST = 'Please add:\n- Steps to reproduce\n- HAR file';
const sample = {
  comment_needed: true,
  comment: `${MENTION}\n${LIST}\n\nPossibly related: KAZ-8871 (same page, no scroll)\nPossibly related: KAZ-8169 (same filter)`,
  missing: ['R6', 'R6', 'R1'],
  related: [{ key: 'KAZ-8871', reason: 'same page' }],
};
const withLines = (...lines: string[]) => ({ ...sample, comment: [MENTION, LIST, ...lines].join('\n') });

describe('parseVerdict', () => {
  it('keeps the reporter mention, dedupes missing, takes the related bugs from the comment', () => {
    const { verdict, strippedMentions, keysInComment } = parseVerdict(sample, REPORTER);
    assert.ok(verdict.comment.startsWith(`${MENTION}\nPlease add:`));
    assert.deepEqual(strippedMentions, []);
    assert.deepEqual(verdict.missing, ['R1', 'R6']);
    assert.deepEqual(keysInComment, ['KAZ-8871', 'KAZ-8169']);
    assert.deepEqual(verdict.related, [
      { key: 'KAZ-8871', reason: 'same page, no scroll' },
      { key: 'KAZ-8169', reason: 'same filter' },
    ]);
  });
  it('strips every mention that is not the reporter, in any case', () => {
    const { verdict, strippedMentions } = parseVerdict({ ...sample, comment: `${MENTION}\n${LIST}\n[~ACCOUNTID:someone-else]` }, REPORTER);
    assert.equal(verdict.comment, `${MENTION}\n${LIST}`);
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
    assert.throws(() => parseVerdict({ ...sample, comment: LIST }, REPORTER), /first line is not the reporter's mention/);
    assert.doesNotThrow(() => parseVerdict({ ...sample, comment: LIST }, null), 'no reporter known: nothing to mention');
  });
  it('requires every failed field fact to be named', () => {
    assert.throws(() => parseVerdict(sample, REPORTER, ['R4', 'R6']), /R4/);
    assert.doesNotThrow(() => parseVerdict(sample, REPORTER, ['R6']));
  });
  it('requires the comment to list exactly what is missing', () => {
    assert.throws(() => parseVerdict({ ...sample, missing: ['R6'] }, REPORTER), /asked for but not missing R1/);
    assert.throws(() => parseVerdict({ ...sample, missing: ['R1', 'R4', 'R6'] }, REPORTER), /not asked for R4/);
    assert.throws(() => parseVerdict({ ...sample, comment: `${MENTION}\nPlease add:\n- Steps to reproduce\n- -HAR file-`, missing: ['R1'] }, REPORTER), /first comment strikes items through: R6/);
    assert.throws(() => parseVerdict(withLines('- HAR file'), REPORTER), /lists an item twice: R6/);
  });
  it('asks the project question exactly when R7 is missing', () => {
    assert.doesNotThrow(() => parseVerdict({ ...withLines(R7_QUESTIONS[0]!), missing: ['R1', 'R6', 'R7'] }, REPORTER));
    assert.throws(() => parseVerdict({ ...sample, missing: ['R1', 'R6', 'R7'] }, REPORTER), /does not ask about the project/);
    assert.throws(() => parseVerdict(withLines(R7_QUESTIONS[1]!), REPORTER), /R7 is not missing/);
  });
  it('a comment that asks for nothing names a related bug, or is not needed', () => {
    const related = { comment_needed: true, comment: `${MENTION}\n\nPossibly related: KAZ-1 (same page)`, missing: [], related: [] };
    assert.doesNotThrow(() => parseVerdict(related, REPORTER));
    assert.throws(() => parseVerdict({ ...related, comment: MENTION }, REPORTER), /neither asks for anything nor names a related bug/);
    assert.throws(() => parseVerdict({ ...related, comment: `${MENTION}\nPlease add:` }, REPORTER), /"Please add:" with no items/);
  });
  it('lets no other line through: whatever a report talks the agent into stays out of Jira', () => {
    const bad = [
      'Great report, thanks!',
      'See DM-123',
      '[portal|http://evil.example/login]',
      '!http://evil.example/p.png!',
      '- Screen recording',
      '- HAR file (please also attach the logs)',
      'Possibly related: KAZ-1 (see http://evil.example)',
      'Possibly related: KAZ-1 ([click|http://x])',
      'Possibly related: DM-1 (same page)',
      '{code}rm -rf{code}',
    ];
    for (const line of bad) assert.throws(() => parseVerdict(withLines(line), REPORTER), VerdictError, line);
    assert.doesNotThrow(() => parseVerdict(withLines('', 'Possibly related: KAZ-1 (UTF-8 names, same page)'), REPORTER), 'a key-like word in a reason');
  });
});

describe('a re-check', () => {
  const before = `${MENTION}\n${LIST}\n\nPossibly related: KAZ-8871 (same page)`;
  const edited = (list: string, tail = '\n\nPossibly related: KAZ-8871 (same page)') => ({ ...sample, comment: `${MENTION}\nPlease add:\n${list}${tail}` });
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
  it('keeps the related bugs and the project question as they were', () => {
    assert.throws(() => parseVerdict({ ...edited('- -Steps to reproduce-\n- -HAR file-', ''), missing: [] }, REPORTER, [], before), /changes the related bugs/);
    const asked = `${MENTION}\n${LIST}\n${R7_QUESTIONS[0]}`;
    assert.throws(() => parseVerdict({ ...edited('- -Steps to reproduce-\n- -HAR file-', ''), missing: [] }, REPORTER, [], asked), /drops the project question/);
    assert.doesNotThrow(() => parseVerdict({ ...edited('- -Steps to reproduce-\n- -HAR file-', `\n-${R7_QUESTIONS[0]}-`), missing: [] }, REPORTER, [], asked), 'struck once the project is right');
  });
  it('reads list items by name, struck or not', () => {
    assert.deepEqual(listedItems('Please add:\n- -Steps to reproduce-\n- Device (AFS)\n- something else\n\nPossibly related: KAZ-1 (x)'), [
      { id: 'R1', struck: true },
      { id: 'R5', struck: false },
    ]);
  });
});
