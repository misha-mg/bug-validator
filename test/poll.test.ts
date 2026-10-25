import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { AgentError, type Agent, type AgentRun } from '../src/claude/agent.ts';
import { Store } from '../src/db/store.ts';
import { JiraError, type Jira, type RawIssue } from '../src/jira/client.ts';
import type { Deps } from '../src/pipeline/deps.ts';
import { poll } from '../src/pipeline/poll.ts';
import { rawIssue } from './fixtures.ts';

// KAZ-9021: a video, no HAR, Devices = All, Affects versions set. Its field facts fail only R6.
const KEY = 'KAZ-9021';
const REPORTER = '712020:a91caa38-10e5-460c-86d2-5e9d9719237d';
const needsHar = { comment_needed: true, comment: `[~accountid:${REPORTER}]\nPlease add:\n- HAR file`, missing: ['R6'], related: [] };

class FakeJira implements Jira {
  inQuery: string[] = [KEY];
  /** A bug's id; by default derived from its key, set to show a bug that moved. */
  ids: Record<string, string> = {};
  posted: { key: string; body: string }[] = [];
  failWith: Error | null = null;
  async search(jql: string): Promise<RawIssue[]> {
    if (this.failWith) throw this.failWith;
    if (jql.startsWith('key IN')) return []; // no related bug exists
    return this.inQuery.map((key) => ({ id: this.ids[key] ?? `id-${key}`, key, fields: {} }));
  }
  async getIssue(key: string): Promise<RawIssue> {
    return rawIssue(key);
  }
  async addComment(key: string, body: string): Promise<{ id: string }> {
    this.posted.push({ key, body });
    return { id: String(this.posted.length) };
  }
}

class FakeAgent implements Agent {
  private readonly outcome: unknown | Error;
  constructor(outcome: unknown | Error) {
    this.outcome = outcome;
  }
  async run(): Promise<AgentRun> {
    if (this.outcome instanceof Error) throw this.outcome;
    return { output: this.outcome, costUsd: 0, durationMs: 0, turns: 1 };
  }
}

function deps(agentOutcome: unknown | Error, dryRun = true): Deps & { jira: FakeJira } {
  const d = { config: { dryRun, maxAttempts: 3 }, jira: new FakeJira(), agent: new FakeAgent(agentOutcome), store: new Store(':memory:') };
  d.store.bootstrap([]);
  return d;
}

describe('poll', () => {
  it('the first poll skips what is already in the query and checks nothing', async () => {
    const d = deps(needsHar);
    d.store = new Store(':memory:');
    assert.deepEqual(await poll(d), { inQuery: 1, pending: 0, checked: 0, failed: 0 });
    assert.equal(d.store.status(KEY), 'skipped');
    d.jira.inQuery = [KEY, 'KAZ-9025'];
    assert.deepEqual((await poll(d)).pending, 1, 'only the new bug is pending');
  });
  it('a complete bug is recorded without a comment', async () => {
    const d = deps({ comment_needed: false, comment: '', missing: [], related: [] });
    d.jira.inQuery = ['RPG-6192']; // HAR attached, every field fact passes
    assert.deepEqual(await poll(d), { inQuery: 1, pending: 1, checked: 1, failed: 0 });
    assert.equal(d.store.status('RPG-6192'), 'complete');
  });
  it('dry run: the comment is recorded, nothing is posted, the bug is not checked twice', async () => {
    const d = deps(needsHar);
    await poll(d);
    assert.equal(d.store.status(KEY), 'dry_run');
    assert.deepEqual(d.jira.posted, []);
    assert.deepEqual(await poll(d), { inQuery: 1, pending: 0, checked: 0, failed: 0 });
  });
  it('a bug moved to the other project after its check is not checked again', async () => {
    const d = deps(needsHar);
    await poll(d);
    d.jira.inQuery = ['RPG-9999'];
    d.jira.ids = { 'RPG-9999': `id-${KEY}` };
    assert.deepEqual(await poll(d), { inQuery: 1, pending: 0, checked: 0, failed: 0 });
    assert.equal(d.store.status('RPG-9999'), 'dry_run');
  });
  it('live: the row is written before the post, then marked commented', async () => {
    const d = deps(needsHar, false);
    await poll(d);
    assert.equal(d.store.status(KEY), 'commented');
    assert.deepEqual(d.jira.posted, [{ key: KEY, body: needsHar.comment }]);
  });
  it('live: a post that fails leaves the bug posting, for a human, never for a second post', async () => {
    const d = deps(needsHar, false);
    d.jira.addComment = async () => {
      throw new JiraError('request failed: fetch failed');
    };
    await assert.rejects(poll(d), JiraError);
    assert.equal(d.store.status(KEY), 'posting');
    d.jira.addComment = FakeJira.prototype.addComment;
    assert.equal((await poll(d)).pending, 0);
    assert.deepEqual(d.jira.posted, []);
  });
  it('a bad verdict costs an attempt; three of them mark the bug failed', async () => {
    const d = deps({ ...needsHar, missing: [] }); // R6 fails but is not named
    for (const n of [1, 2]) {
      assert.deepEqual(await poll(d), { inQuery: 1, pending: 1, checked: 0, failed: 1 }, `attempt ${n}`);
      assert.equal(d.store.status(KEY), 'retry');
    }
    await poll(d);
    assert.equal(d.store.status(KEY), 'failed');
    assert.equal((await poll(d)).pending, 0);
  });
  it('a failure of the surroundings ends the poll and costs the bug nothing', async () => {
    for (const err of [new AgentError('cannot start claude: spawn claude ENOENT', 'start'), new JiraError('HTTP 503', 503)]) {
      const d = deps(err);
      await assert.rejects(poll(d), err.constructor as ErrorConstructor);
      assert.equal(d.store.status(KEY), null);
    }
  });
  it('a stop request ends the poll between bugs', async () => {
    const d = deps(needsHar);
    d.jira.inQuery = [KEY, 'KAZ-9025'];
    const stop = new AbortController();
    const agentRun = d.agent.run.bind(d.agent);
    d.agent.run = async (...args) => {
      stop.abort();
      return agentRun(...args);
    };
    assert.deepEqual(await poll(d, stop.signal), { inQuery: 2, pending: 2, checked: 1, failed: 0 });
  });
});
