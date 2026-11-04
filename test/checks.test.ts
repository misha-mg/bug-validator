import assert from 'node:assert/strict';
import { describe, it } from 'vitest';
import { hasSection, checkFields } from '../src/domain/checks.ts';
import { bug } from './fixtures.ts';

const result = (key: string, overrides = {}) =>
  Object.fromEntries(checkFields(bug(key, overrides)).map((c) => [c.id, c.passed]));

describe('section keys', () => {
  it('accepts inline keys and wiki headings', () => {
    assert.equal(hasSection('Steps to reproduce:\n1. open', ['steps to reproduce', 'steps']), true);
    assert.equal(hasSection('h3. Steps\nReplay one call', ['steps to reproduce', 'steps']), true);
    assert.equal(hasSection('*Expected result*\nworks', ['expected result', 'expected']), true);
    assert.equal(hasSection('ER: page scrolls', ['expected result', 'er']), true);
  });
  it('does not match the key inside other words or prose', () => {
    assert.equal(hasSection('the user: clicks', ['er']), false);
    assert.equal(hasSection('no steps were needed', ['steps']), false);
    assert.equal(hasSection('Set AR: 10 then click', ['actual result', 'ar']), false, 'an abbreviation counts only at the start of a line');
    assert.equal(hasSection('Then\nAR: nothing happens', ['actual result', 'ar']), true);
  });
});

describe('base checks on real bugs', () => {
  it('RPG-6188: h3. headings for steps, expected and actual; no HAR', () => {
    assert.deepEqual(result('RPG-6188'), { R1: true, R2: true, R3: true, R4: true, R5: true, R6: false });
  });
  it('KAZ-9025: numbered steps without a heading, screenshot only', () => {
    assert.deepEqual(result('KAZ-9025'), { R1: false, R2: false, R3: false, R4: true, R5: true, R6: false });
  });
  it('KAZ-8996: one line and a screenshot', () => {
    assert.deepEqual(result('KAZ-8996'), { R1: false, R2: false, R3: false, R4: true, R5: true, R6: false });
  });
  it('RPG-6192: HAR attached', () => {
    const r = result('RPG-6192');
    assert.equal(r['R6'], true);
  });
});

describe('R5 device', () => {
  it('KAZ: board type in the text counts', () => {
    const r = result('KAZ-9025', { devices: [], description: 'Seen on NPB-Ie8 after apply' });
    assert.equal(r['R5'], true);
  });
  it('KAZ: nothing in the field or the text fails', () => {
    const r = result('KAZ-9025', { devices: [], description: 'The table is empty', summary: 'Egress action' });
    assert.equal(r['R5'], false);
  });
  it('KAZ: a product name that is also a place is not a device', () => {
    const r = result('KAZ-9025', { devices: [], description: 'Reported by the customer in India after the upgrade' });
    assert.equal(r['R5'], false);
  });
  it('RPG: needs AFS in the field, text is not enough', () => {
    assert.equal(result('RPG-6188', { devices: [] })['R5'], false);
    assert.equal(result('RPG-6188', { devices: ['AFS'] })['R5'], true);
  });
});

describe('R4, R6', () => {
  it('fail on empty fields', () => {
    const r = result('RPG-6192', { versions: [], attachments: [] });
    assert.equal(r['R4'], false);
    assert.equal(r['R6'], false);
  });
});
