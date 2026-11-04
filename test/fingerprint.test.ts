import assert from 'node:assert/strict'
import { describe, it } from 'vitest'
import type { Comment } from '../src/domain/bug.ts'
import { fingerprint } from '../src/domain/fingerprint.ts'
import { bug } from './fixtures.ts'

describe('fingerprint', () => {
  const base = bug('KAZ-9021')
  const reporter = base.reporter!.accountId
  const comment = (authorId: string, body: string): Comment => ({ id: '1', author: 'Someone', authorId, created: '2026-10-26', body })
  it('changes with the report', () => {
    assert.notEqual(
      fingerprint({
        ...base,
        attachments: [...base.attachments, { id: '1', filename: 'session.har', size: 1, mimeType: 'application/json' }],
      }),
      fingerprint(base),
    )
    assert.notEqual(fingerprint({ ...base, description: base.description + '\n1. open the page' }), fingerprint(base))
    assert.notEqual(fingerprint({ ...base, project: 'RPG' }), fingerprint(base))
  })
  it('ignores labels, status, times and the order of lists', () => {
    const same = {
      ...base,
      labels: ['WebUI', 'R5.12'],
      status: 'To Do',
      updated: '2026-10-27T10:00:00.000+0300',
      attachments: [...base.attachments].reverse(),
    }
    assert.equal(fingerprint(same), fingerprint(base))
  })
  it('counts the reporter answering in a comment, not other people nor the service', () => {
    assert.notEqual(fingerprint({ ...base, comments: [comment(reporter, 'Steps: open Ports')] }), fingerprint(base))
    assert.equal(fingerprint({ ...base, comments: [comment('qa-lead', 'Assigned to the team')] }), fingerprint(base))
    // The service writes from a personal account, which may be the reporter's own.
    assert.equal(
      fingerprint({ ...base, comments: [comment(reporter, `[~accountid:${reporter}]\nPlease add:\n- HAR file`)] }),
      fingerprint(base),
    )
  })
})
