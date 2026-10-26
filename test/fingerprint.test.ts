import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { fingerprint } from '../src/domain/fingerprint.ts';
import { bug } from './fixtures.ts';

describe('fingerprint', () => {
  const base = bug('KAZ-9021');
  it('changes with the report', () => {
    assert.notEqual(fingerprint({ ...base, attachments: [...base.attachments, { filename: 'session.har' }] }), fingerprint(base));
    assert.notEqual(fingerprint({ ...base, description: base.description + '\n1. open the page' }), fingerprint(base));
    assert.notEqual(fingerprint({ ...base, project: 'RPG' }), fingerprint(base));
  });
  it('ignores comments, labels, status, times and the order of lists', () => {
    const same = { ...base, comments: [{ author: 'Bug validator', created: '2026-10-26', body: 'Please add:' }], labels: ['WebUI', 'R5.12'], status: 'To Do', updated: '2026-10-27T10:00:00.000+0300', attachments: [...base.attachments].reverse() };
    assert.equal(fingerprint(same), fingerprint(base));
  });
});
