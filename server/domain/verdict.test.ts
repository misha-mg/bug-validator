import assert from 'node:assert/strict'
import { describe, it } from 'vitest'
import { parseVerdict, VerdictError, verdictJsonSchema } from './verdict.ts'

const REPORTER = '712020:abc'
const MENTION = `[~accountid:${REPORTER}]`
const ctx = { bugKey: 'KAZ-9025', reporterAccountId: REPORTER, secrets: ['run-secret-1', 'sk-ant-oat01-x'] }
const base = { outcome: 'not_understood', reasoning: 'looked at Ports.vue', reason: '', comment: `${MENTION}\nWhich page shows the table?` }

describe('parseVerdict', () => {
  it('hands claude a schema without the draft key', () => {
    assert.ok(!('$schema' in verdictJsonSchema))
    assert.deepEqual(Object.keys((verdictJsonSchema as { properties: object }).properties), ['outcome', 'reasoning', 'reason', 'comment'])
  })
  it('refuses output that is not the schema', () => {
    assert.throws(
      () => parseVerdict({ outcome: 'maybe', reasoning: '', reason: '', comment: '' }, ctx),
      /does not match the schema: outcome/,
    )
    assert.throws(() => parseVerdict({ outcome: 'understood' }, ctx), VerdictError)
  })
  it("not understood: the comment, the reporter's mention first and alone, the keys it names", () => {
    const { verdict, reasoning, strippedMentions } = parseVerdict(
      { ...base, comment: `${MENTION}  \nIs this KAZ-8871 again, or KAZ-9025 itself?\n\nPossibly related: KAZ-8871 — same table` },
      ctx,
    )
    assert.equal(verdict.outcome, 'not_understood')
    assert.equal(verdict.comment, `${MENTION}\nIs this KAZ-8871 again, or KAZ-9025 itself?\n\nPossibly related: KAZ-8871 — same table`)
    assert.deepEqual(verdict.related, ['KAZ-8871'], "the bug's own key is not related")
    assert.equal(reasoning, 'looked at Ports.vue')
    assert.deepEqual(strippedMentions, [])
    assert.throws(() => parseVerdict({ ...base, comment: '' }, ctx), /not_understood without a comment/)
    assert.throws(() => parseVerdict({ ...base, comment: 'Which page?' }, ctx), /first line is not the reporter's mention/)
    assert.throws(() => parseVerdict({ ...base, comment: `${MENTION} which page?` }, ctx), /first line is not the reporter's mention/)
    assert.throws(() => parseVerdict({ ...base, comment: `${MENTION}\n\n` }, ctx), /the mention alone/)
    assert.equal(
      parseVerdict({ ...base, comment: 'Which page?' }, { ...ctx, reporterAccountId: null }).verdict.comment,
      'Which page?',
      'no reporter: no mention to demand',
    )
  })
  it('mentions nobody but the reporter, and says whom it removed', () => {
    const { verdict, strippedMentions } = parseVerdict({ ...base, comment: `${MENTION}\nAsk [~accountid:dev1] or [~accountid:dev2]?` }, ctx)
    assert.equal(verdict.comment, `${MENTION}\nAsk  or ?`)
    assert.deepEqual(strippedMentions, ['dev1', 'dev2'])
  })
  it('understood keeps nothing but the outcome; not a WebUI bug keeps its reason; neither has a comment', () => {
    assert.deepEqual(parseVerdict({ outcome: 'understood', reasoning: 'Ports.vue line 40', reason: 'ignored', comment: '' }, ctx).verdict, {
      outcome: 'understood',
      reason: '',
      comment: '',
      related: [],
    })
    assert.deepEqual(
      parseVerdict({ outcome: 'not_webui', reasoning: '', reason: ' The UI shows the counter ConfD returns. ', comment: '' }, ctx).verdict,
      { outcome: 'not_webui', reason: 'The UI shows the counter ConfD returns.', comment: '', related: [] },
    )
    assert.throws(() => parseVerdict({ outcome: 'not_webui', reasoning: '', reason: '', comment: '' }, ctx), /not_webui without a reason/)
    assert.throws(
      () => parseVerdict({ outcome: 'understood', reasoning: '', reason: '', comment: `${MENTION}\nhi` }, ctx),
      /understood comes with a comment/,
    )
  })
  it('refuses a secret of the run in any field', () => {
    assert.throws(() => parseVerdict({ ...base, comment: `${MENTION}\nToken run-secret-1` }, ctx), /comment holds a secret/)
    assert.throws(() => parseVerdict({ ...base, reasoning: 'saw sk-ant-oat01-x in mcp.json' }, ctx), /reasoning holds a secret/)
    assert.doesNotThrow(() => parseVerdict(base, { ...ctx, secrets: [''] }), 'an empty secret matches nothing')
  })
})
