import assert from 'node:assert/strict'
import { afterAll, beforeAll, describe, it } from 'vitest'
import { JiraTool } from '../src/claude/jira-mcp.ts'
import { JiraError, type RawIssue } from '../src/jira/client.ts'
import { rawIssue } from './fixtures.ts'

describe('JiraTool', () => {
  const jqls: string[] = []
  let fail: JiraError | null = null
  const jira = {
    async search(jql: string): Promise<RawIssue[]> {
      jqls.push(jql)
      if (fail) throw fail
      return [rawIssue('KAZ-9025'), { id: '1', key: 'DM-1', fields: { summary: 'other project' } }]
    },
    async getIssue(key: string): Promise<RawIssue> {
      return rawIssue(key)
    },
  }
  const tool = new JiraTool(jira)
  let secret: string
  beforeAll(async () => {
    await tool.listen()
    secret = tool.grant()
  })
  afterAll(() => tool.close())

  const post = (body: unknown, auth: string | null = `Bearer ${secret}`) =>
    fetch(tool.url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(auth ? { Authorization: auth } : {}) },
      body: JSON.stringify(body),
    })
  const call = async (method: string, params: object = {}) =>
    (await post({ jsonrpc: '2.0', id: 1, method, params })).json() as Promise<{ result?: any; error?: any }>

  it('lets a run in by its secret only, on loopback', async () => {
    assert.match(tool.url, /^http:\/\/127\.0\.0\.1:\d+\/mcp$/)
    assert.equal((await post({ jsonrpc: '2.0', id: 1, method: 'ping' }, null)).status, 401)
    assert.equal((await post({ jsonrpc: '2.0', id: 1, method: 'ping' }, 'Bearer wrong')).status, 401)
    assert.deepEqual(await call('ping'), { jsonrpc: '2.0', id: 1, result: {} })
    assert.equal((await fetch(tool.url, { headers: { Authorization: `Bearer ${secret}` } })).status, 405, 'no server-sent stream')
    assert.equal((await post({ jsonrpc: '2.0', method: 'notifications/initialized' })).status, 202)
    assert.equal((await post(null)).status, 400, 'a body that is not a request')
    const cyrillic = await call('tools/call', { name: 'search_issues', arguments: { jql: 'summary ~ "Статистика фильтров"' } })
    assert.ok(cyrillic.result, 'a non-ASCII query arrives whole')
    assert.equal(jqls.at(-1), 'project IN (KAZ, RPG) AND (summary ~ "Статистика фильтров")')
  })
  it('speaks MCP: initialize, the two tools, a call', async () => {
    const init = await call('initialize', { protocolVersion: '2025-06-18' })
    assert.equal(init.result.protocolVersion, '2025-06-18')
    assert.deepEqual(
      (await call('tools/list')).result.tools.map((t: { name: string }) => t.name),
      ['search_issues', 'get_issue'],
    )
    const found = await call('tools/call', { name: 'search_issues', arguments: { jql: 'summary ~ "scroll"' } })
    assert.deepEqual(
      JSON.parse(found.result.content[0].text).map((i: { key: string }) => i.key),
      ['KAZ-9025'],
      'only KAZ and RPG',
    )
    assert.equal(jqls.at(-1), 'project IN (KAZ, RPG) AND (summary ~ "scroll")')
    const issue = await call('tools/call', { name: 'get_issue', arguments: { key: 'RPG-6188' } })
    assert.equal(JSON.parse(issue.result.content[0].text).key, 'RPG-6188')
    assert.match((await call('tools/call', { name: 'get_issue', arguments: { key: 'DM-1' } })).result.content[0].text, /^error:/)
    assert.equal((await call('nothing')).error.code, -32601)
  })
  it("notes Jira's own failure for the run, not a bad query; a revoked secret is out", async () => {
    fail = new JiraError('HTTP 400 bad jql', 400)
    assert.match((await call('tools/call', { name: 'search_issues', arguments: { jql: 'x' } })).result.content[0].text, /bad jql/)
    assert.equal(tool.failure(secret), null)
    fail = new JiraError('HTTP 503', 503)
    await call('tools/call', { name: 'search_issues', arguments: { jql: 'x' } })
    assert.equal(tool.failure(secret), 'search_issues: HTTP 503')
    tool.revoke(secret)
    assert.equal((await post({ jsonrpc: '2.0', id: 1, method: 'ping' })).status, 401)
    assert.equal(tool.failure(secret), null)
  })
})
