import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { AgentError, parseClaudeResult } from '../src/claude/agent.ts';

describe('parseClaudeResult', () => {
  it('returns the structured output and the run figures', () => {
    const run = parseClaudeResult(JSON.stringify({ structured_output: { a: 1 }, total_cost_usd: 0.002, duration_ms: 1200, num_turns: 4 }));
    assert.deepEqual(run, { output: { a: 1 }, costUsd: 0.002, durationMs: 1200, turns: 4 });
  });
  it('turns every bad outcome into an AgentError', () => {
    assert.throws(() => parseClaudeResult('not json'), /something other than JSON/);
    assert.throws(() => parseClaudeResult(JSON.stringify({ is_error: true, result: 'rate limited' })), /rate limited/);
    assert.throws(() => parseClaudeResult(JSON.stringify({ result: 'I could not decide' })), /no structured output/);
    assert.throws(() => parseClaudeResult('{}'), AgentError);
  });
});
