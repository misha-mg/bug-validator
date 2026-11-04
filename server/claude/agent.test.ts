// Tests of agent.ts: the result parsing, the kinds of trouble, and a run with a stand-in bwrap and claude.
import assert from 'node:assert/strict'
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, it } from 'vitest'
import { AgentError, ClaudeAgent, parseClaudeResult, troubleKind } from './agent.ts'
import { JiraTool } from './jira-mcp.ts'
import { JiraError } from '../jira/client.ts'

describe('parseClaudeResult', () => {
  it('returns the structured output and the run figures', () => {
    const run = parseClaudeResult(JSON.stringify({ structured_output: { a: 1 }, total_cost_usd: 0.002, duration_ms: 1200, num_turns: 4 }))
    assert.deepEqual(run, { output: { a: 1 }, costUsd: 0.002, durationMs: 1200, turns: 4 })
  })
  it("turns every bad outcome into an AgentError, the Claude service's trouble into one that spares the bug", () => {
    assert.throws(() => parseClaudeResult('not json'), /something other than JSON/)
    assert.throws(() => parseClaudeResult(JSON.stringify({ result: 'I could not decide' })), /no structured output/)
    assert.throws(() => parseClaudeResult('{}'), AgentError)
    assert.throws(
      () => parseClaudeResult(JSON.stringify({ is_error: true, result: 'API Error: 529 Overloaded' })),
      (err: AgentError) => err.kind === 'service' && err.environmental,
    )
    assert.throws(
      () => parseClaudeResult(JSON.stringify({ is_error: true, subtype: 'error_max_turns', result: 'stopped' })),
      (err: AgentError) => err.kind === 'run' && !err.environmental,
    )
  })
  it("tells the service's trouble from the run's", () => {
    for (const m of [
      'Claude AI usage limit reached|1761000000',
      'rate_limit_error',
      'Invalid API key · Please run /login',
      'OAuth token has expired',
      'API Error: 500',
      'connect ETIMEDOUT',
    ]) {
      assert.equal(troubleKind(m), 'service', m)
    }
    for (const m of [
      'Prompt is too long',
      'Reached max turns (25)',
      'exceeded --max-budget-usd',
      'claude exited with 1: unknown option',
      'claude returned no structured output: see the network page, /login, bug RPG-6503 at line 503',
    ]) {
      assert.equal(troubleKind(m), 'run', m)
    }
  })
})

// A stand-in for `bwrap` on PATH: it records its arguments and plays claude, as FAKE_CLAUDE says.
const FAKE = `#!/usr/bin/env node
// The agent gives bwrap a clean environment, so the fake finds its orders beside itself.
const fs = require('node:fs');
const path = require('node:path');
const dir = path.dirname(fs.realpathSync(process.argv[1]));
const ARGS = path.join(dir, 'args.json');
const mode = fs.readFileSync(path.join(dir, 'mode'), 'utf8');
const args = process.argv.slice(2);
fs.writeFileSync(ARGS, JSON.stringify(args));
fs.writeFileSync(ARGS + '.env', JSON.stringify(process.env));
const claude = args.slice(args.indexOf('--') + 1);
if (claude[1] === '--version') { process.stdout.write('9.9.9 (Claude Code)\\n'); process.exit(0); }
// The config as claude would read it: the bound path's source is in the bind.
const config = args[args.indexOf('/home/agent/mcp.json') - 1];
fs.writeFileSync(ARGS + '.mode', (fs.statSync(config).mode & 0o777).toString(8));
const ok = JSON.stringify({ structured_output: { ok: true }, total_cost_usd: 0.001, duration_ms: 5, num_turns: 1 });
switch (mode) {
  case 'ok': process.stdout.write(ok); break;
  case 'hang': setTimeout(() => {}, 60000); break;
  case 'limit': process.stdout.write(JSON.stringify({ is_error: true, result: 'Claude AI usage limit reached' })); process.exit(1);
  case 'crash': process.stderr.write('boom'); process.exit(3);
  case 'search': {
    // As claude would: a tool call over the MCP server in the config, with its secret.
    const { url, headers } = JSON.parse(fs.readFileSync(config, 'utf8')).mcpServers.jira;
    fetch(url, { method: 'POST', headers: { ...headers, 'Content-Type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'search_issues', arguments: { jql: 'x' } } }) })
      .then((r) => r.text()).then((t) => { fs.writeFileSync(ARGS + '.search', t); process.stdout.write(ok); });
    break;
  }
}
`

describe('ClaudeAgent', () => {
  const dir = mkdtempSync(join(tmpdir(), 'agent-'))
  const argsFile = join(dir, 'args.json')
  const saved = { PATH: process.env.PATH }
  let jiraDown = false
  const tool = new JiraTool({
    async search() {
      if (jiraDown) throw new JiraError('HTTP 503', 503)
      return []
    },
    async getIssue() {
      throw new Error('not here')
    },
  })
  const agent = (timeoutMs = 5000) =>
    new ClaudeAgent({ model: 'sonnet', timeoutMs, maxTurns: 100, maxBudgetUsd: 2, token: 'sk-ant-oat01-secret' }, '/srv/webui', tool)
  const run = (mode: string, a = agent(), signal?: AbortSignal) => {
    writeFileSync(join(dir, 'mode'), mode)
    return a.run('the prompt', { type: 'object' }, join(dir, 'bug'), signal)
  }
  beforeAll(async () => {
    writeFileSync(join(dir, 'bwrap'), FAKE)
    chmodSync(join(dir, 'bwrap'), 0o755)
    mkdirSync(join(dir, 'bug'))
    process.env.PATH = `${dir}:${process.env.PATH}`
    await tool.listen()
  })
  afterAll(async () => {
    Object.assign(process.env, saved)
    await tool.close()
    rmSync(dir, { recursive: true, force: true })
  })

  it("runs claude in the sandbox: the file tools over the clone and the run's files, the Jira tool, no settings; the secrets never arguments", async () => {
    const result = await run('ok')
    assert.deepEqual(result.output, { ok: true })
    assert.equal(result.model, 'sonnet')
    assert.match(result.instructions ?? '', /^[0-9a-f]{12}$/)
    assert.equal(result.secrets.length, 2)
    assert.ok(result.secrets.includes('sk-ant-oat01-secret'))
    const args = JSON.parse(readFileSync(argsFile, 'utf8')) as string[]
    const claude = args.slice(args.indexOf('--') + 1)
    const flag = (name: string) => claude[claude.indexOf(name) + 1]
    assert.ok(args.slice(0, args.indexOf('--')).includes('--unshare-all'), 'bwrap first')
    assert.ok(args.includes('/srv/webui') && args.includes(join(dir, 'bug')), 'the clone and the files are bound')
    assert.ok(claude.includes('--restricted'))
    assert.equal(flag('--tools'), 'Read,Grep,Glob')
    assert.equal(flag('--add-dir'), '/work/bug')
    assert.equal(flag('--mcp-config'), '/home/agent/mcp.json')
    assert.ok(claude.includes('--strict-mcp-config'))
    assert.equal(flag('--allowedTools'), 'Read,Grep,Glob,mcp__jira__search_issues,mcp__jira__get_issue')
    assert.equal(flag('--setting-sources'), '')
    assert.equal(flag('--max-turns'), '100')
    assert.equal(flag('--max-budget-usd'), '2')
    const line = JSON.stringify(args)
    for (const s of result.secrets) assert.doesNotMatch(line, new RegExp(s), 'no secret is an argument')
    const env = JSON.parse(readFileSync(`${argsFile}.env`, 'utf8')) as Record<string, string>
    assert.equal(env.CLAUDE_CODE_OAUTH_TOKEN, 'sk-ant-oat01-secret', 'the token goes through the environment')
    assert.equal(env.HOME, '/home/agent')
    assert.ok(!('JIRA_API_TOKEN' in env) && !('FAKE_CLAUDE' in env), "nothing of the service's environment")
    assert.equal(readFileSync(`${argsFile}.mode`, 'utf8'), '600')
  })
  it('asks claude its version inside the sandbox', async () => {
    assert.equal(await agent().version(), '9.9.9 (Claude Code)')
  })
  it("the Jira tool answers the run by its secret, and a Jira failure during the run fails the run as the surroundings'", async () => {
    await run('search')
    assert.match(readFileSync(`${argsFile}.search`, 'utf8'), /"content"/, 'the tool answered')
    jiraDown = true
    await assert.rejects(
      run('search'),
      (err: AgentError) => /Jira failed for the agent: search_issues: HTTP 503/.test(err.message) && err.kind === 'service',
    )
    jiraDown = false
  })
  it("a timeout is the run's failure; a stop, a usage limit or a crash are told apart", async () => {
    await assert.rejects(run('hang', agent(300)), (err: AgentError) => /timed out/.test(err.message) && err.kind === 'run')
    const stop = new AbortController()
    setTimeout(() => stop.abort(), 100)
    await assert.rejects(run('hang', agent(), stop.signal), (err: AgentError) => err.kind === 'stopped')
    await assert.rejects(
      run('ok', agent(), AbortSignal.abort()),
      (err: AgentError) => err.kind === 'stopped',
      'already stopped: not started',
    )
    await assert.rejects(run('limit'), (err: AgentError) => /usage limit/.test(err.message) && err.kind === 'service')
    await assert.rejects(run('crash'), (err: AgentError) => /exited with 3: boom/.test(err.message) && err.kind === 'run')
  })
})
