import assert from 'node:assert/strict'
import { describe, it } from 'vitest'
import { issueKey } from './key.ts'

describe('issueKey', () => {
  it('reads a key out of what a person typed or pasted', () => {
    assert.equal(issueKey('KAZ-9043'), 'KAZ-9043')
    assert.equal(issueKey('  rpg-6242 '), 'RPG-6242')
    assert.equal(issueKey('https://cgstowernetworks.atlassian.net/browse/KAZ-9043'), 'KAZ-9043')
    assert.equal(
      issueKey('https://cgstowernetworks.atlassian.net/jira/software/c/projects/KAZ/boards/1?selectedIssue=KAZ-9043'),
      'KAZ-9043',
    )
    assert.equal(issueKey('https://x.atlassian.net/browse/KAZ-9043?focusedCommentId=1'), 'KAZ-9043')
  })
  it('is null for anything else', () => {
    for (const text of ['', 'KAZ', 'ABC-1', 'KAZ-', 'XKAZ-1', 'KAZ-1x', 'https://x.atlassian.net/browse/ABC-1'])
      assert.equal(issueKey(text), null, text)
  })
})
