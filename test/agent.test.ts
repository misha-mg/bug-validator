import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { AgentError, ClaudeAgent, parseClaudeResult, troubleKind } from '../src/claude/agent.ts';

describe('parseClaudeResult', () => {
  it('returns the structured output and the run figures', () => {
    const run = parseClaudeResult(JSON.stringify({ structured_output: { a: 1 }, total_cost_usd: 0.002, duration_ms: 1200, num_turns: 4 }));
    assert.deepEqual(run, { output: { a: 1 }, costUsd: 0.002, durationMs: 1200, turns: 4 });
  });
  it('turns every bad outcome into an AgentError, the Claude service\'s trouble into one that spares the bug', () => {
    assert.throws(() => parseClaudeResult('not json'), /something other than JSON/);
    assert.throws(() => parseClaudeResult(JSON.stringify({ result: 'I could not decide' })), /no structured output/);
    assert.throws(() => parseClaudeResult('{}'), AgentError);
    assert.throws(
      () => parseClaudeResult(JSON.stringify({ is_error: true, result: 'API Error: 529 Overloaded' })),
      (err: AgentError) => err.kind === 'service' && err.environmental,
    );
    assert.throws(
      () => parseClaudeResult(JSON.stringify({ is_error: true, subtype: 'error_max_turns', result: 'stopped' })),
      (err: AgentError) => err.kind === 'run' && !err.environmental,
    );
  });
  it('tells the service\'s trouble from the run\'s', () => {
    for (const m of ['Claude AI usage limit reached|1761000000', 'rate_limit_error', 'Invalid API key · Please run /login', 'OAuth token has expired', 'API Error: 500', 'connect ETIMEDOUT']) {
      assert.equal(troubleKind(m), 'service', m);
    }
    for (const m of ['Prompt is too long', 'Reached max turns (25)', 'exceeded --max-budget-usd', 'claude exited with 1: unknown option']) {
      assert.equal(troubleKind(m), 'run', m);
    }
  });
});

// A stand-in for `claude` on PATH: what it does is set by FAKE_CLAUDE.
const FAKE = `#!/usr/bin/env node
const fs = require('node:fs');
const args = process.argv.slice(2);
fs.writeFileSync(process.env.FAKE_CLAUDE_ARGS, JSON.stringify(args));
const config = args[args.indexOf('--mcp-config') + 1];
fs.writeFileSync(process.env.FAKE_CLAUDE_ARGS + '.mode', (fs.statSync(config).mode & 0o777).toString(8));
const ok = JSON.stringify({ structured_output: { ok: true }, total_cost_usd: 0.001, duration_ms: 5, num_turns: 1 });
switch (process.env.FAKE_CLAUDE) {
  case 'ok': process.stdout.write(ok); break;
  case 'hang': setTimeout(() => {}, 60000); break;
  case 'limit': process.stdout.write(JSON.stringify({ is_error: true, result: 'Claude AI usage limit reached' })); process.exit(1);
  case 'crash': process.stderr.write('boom'); process.exit(3);
  case 'jira-down': {
    const env = JSON.parse(fs.readFileSync(config, 'utf8')).mcpServers.jira.env;
    fs.appendFileSync(env.BUG_VALIDATOR_TOOL_ERRORS, 'search_issues: HTTP 503\\n');
    process.stdout.write(ok);
    break;
  }
}
`;

describe('ClaudeAgent', () => {
  const dir = mkdtempSync(join(tmpdir(), 'agent-'));
  const argsFile = join(dir, 'args.json');
  const saved = { PATH: process.env.PATH, JIRA_API_TOKEN: process.env.JIRA_API_TOKEN };
  const agent = (timeoutMs = 5000) => new ClaudeAgent({ model: 'haiku', timeoutMs, maxBudgetUsd: 0.5, auth: 'cli_login' });
  const run = (mode: string, a = agent(), signal?: AbortSignal) => {
    process.env.FAKE_CLAUDE = mode;
    return a.run('the prompt', { type: 'object' }, signal);
  };
  before(() => {
    writeFileSync(join(dir, 'claude'), FAKE);
    chmodSync(join(dir, 'claude'), 0o755);
    process.env.PATH = `${dir}:${process.env.PATH}`;
    process.env.FAKE_CLAUDE_ARGS = argsFile;
    process.env.JIRA_API_TOKEN = 'secret-token';
  });
  after(() => {
    Object.assign(process.env, saved);
    rmSync(dir, { recursive: true, force: true });
  });

  it('runs sandboxed: no built-in tools, no settings, one MCP server whose config, the token in it, is a private file', async () => {
    const result = await run('ok');
    assert.deepEqual(result.output, { ok: true });
    assert.equal(result.model, 'haiku');
    assert.match(result.instructions ?? '', /^[0-9a-f]{12}$/);
    const args = JSON.parse(readFileSync(argsFile, 'utf8')) as string[];
    const flag = (name: string) => args[args.indexOf(name) + 1];
    assert.equal(flag('--tools'), '');
    assert.equal(flag('--setting-sources'), '');
    assert.ok(args.includes('--strict-mcp-config'));
    assert.equal(flag('--allowedTools'), 'mcp__jira__search_issues,mcp__jira__get_issue');
    assert.equal(flag('--max-budget-usd'), '0.5');
    assert.doesNotMatch(JSON.stringify(args), /secret-token/, 'the token is never an argument');
    assert.equal(readFileSync(`${argsFile}.mode`, 'utf8'), '600');
  });
  it('a timeout is the run\'s failure; a stop, a usage limit or Jira failing the agent are not the bug\'s', async () => {
    await assert.rejects(run('hang', agent(300)), (err: AgentError) => /timed out/.test(err.message) && err.kind === 'run');
    const stop = new AbortController();
    setTimeout(() => stop.abort(), 100);
    await assert.rejects(run('hang', agent(), stop.signal), (err: AgentError) => err.kind === 'stopped');
    await assert.rejects(run('ok', agent(), AbortSignal.abort()), (err: AgentError) => err.kind === 'stopped', 'already stopped: not started');
    await assert.rejects(run('limit'), (err: AgentError) => /usage limit/.test(err.message) && err.kind === 'service');
    await assert.rejects(run('crash'), (err: AgentError) => /exited with 3: boom/.test(err.message) && err.kind === 'run');
    await assert.rejects(run('jira-down'), (err: AgentError) => /Jira failed for the agent: search_issues: HTTP 503/.test(err.message) && err.kind === 'service');
  });
});
