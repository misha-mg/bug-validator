import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { AgentError, type Agent, type AgentRun } from '../src/claude/agent.ts';
import { Store } from '../src/db/store.ts';
import { JiraError, type Jira, type RawIssue } from '../src/jira/client.ts';
import type { Deps } from '../src/pipeline/deps.ts';
import { poll } from '../src/pipeline/poll.ts';
import { serveRequests } from '../src/pipeline/requests.ts';
import { rawIssue } from './fixtures.ts';

// KAZ-9021: a video, no HAR, Devices = All, Affects versions set. Its field facts fail only R6.
// The fixtures were created days ago: old enough for the first check, quiet enough for a re-check.
const KEY = 'KAZ-9021';
const REPORTER = '712020:a91caa38-10e5-460c-86d2-5e9d9719237d';
const needsHar = { comment_needed: true, comment: `[~accountid:${REPORTER}]\nPlease add:\n- HAR file`, missing: ['R6'], related: [] };
const harArrived = { ...needsHar, comment: `[~accountid:${REPORTER}]\nPlease add:\n- -HAR file-`, missing: [] };
const minutesAgo = (m: number): string => new Date(Date.now() - m * 60_000).toISOString();

class FakeJira implements Jira {
  inQuery: string[] = [KEY];
  /** A bug's id; by default derived from its key, set to show a bug that moved. */
  ids: Record<string, string> = {};
  /** Fields that differ from the bug's fixture: what the reporter changed. */
  changes: Record<string, Record<string, unknown>> = {};
  posted: { key: string; body: string }[] = [];
  edited: { key: string; commentId: string; body: string }[] = [];
  async search(jql: string): Promise<RawIssue[]> {
    if (jql.startsWith('key IN')) return []; // no related bug exists
    return this.inQuery.map((key) => this.issue(key));
  }
  async getIssue(key: string): Promise<RawIssue> {
    if (!this.inQuery.includes(key) && !this.ids[key]) throw new JiraError(`HTTP 404 on GET /issue/${key}`, 404);
    return this.issue(key);
  }
  async addComment(key: string, body: string): Promise<{ id: string }> {
    this.posted.push({ key, body });
    return { id: String(this.posted.length) };
  }
  async editComment(key: string, commentId: string, body: string): Promise<void> {
    this.edited.push({ key, commentId, body });
  }
  /** The reporter attaches a HAR. */
  attachHar(key: string): void {
    const fields = rawIssue(key).fields as { attachment: object[] };
    this.changes[key] = { attachment: [...fields.attachment, { filename: 'session.har' }] };
  }
  private issue(key: string): RawIssue {
    const fixture = rawIssue(this.ids[key] ? KEY : key);
    return { id: this.ids[key] ?? `id-${key}`, key, fields: { ...fixture.fields, ...this.changes[key] } };
  }
}

/** Returns the outcomes in turn, the last one from then on. */
class FakeAgent implements Agent {
  private readonly outcomes: (unknown | Error)[];
  prompts: string[] = [];
  constructor(...outcomes: (unknown | Error)[]) {
    this.outcomes = outcomes;
  }
  async run(prompt: string, _jsonSchema: object, _signal?: AbortSignal): Promise<AgentRun> {
    this.prompts.push(prompt);
    const outcome = this.outcomes.length > 1 ? this.outcomes.shift() : this.outcomes[0];
    if (outcome instanceof Error) throw outcome;
    return { output: outcome, costUsd: 0, durationMs: 0, turns: 1 };
  }
}

function deps(agent: FakeAgent, dryRun = true): Deps & { jira: FakeJira; agent: FakeAgent } {
  const d = { config: { dryRun, maxAttempts: 3 }, jira: new FakeJira(), agent, store: new Store(':memory:') };
  d.store.bootstrap([]);
  return d;
}

describe('poll', () => {
  it('the first poll skips what is already in the query and checks nothing', async () => {
    const d = deps(new FakeAgent(needsHar));
    d.store = new Store(':memory:');
    assert.deepEqual(await poll(d), { inQuery: 1, waiting: 0, pending: 0, checked: 0, failed: 0 });
    assert.equal(d.store.status(KEY), 'skipped');
    d.jira.inQuery = [KEY, 'KAZ-9025'];
    assert.deepEqual((await poll(d)).pending, 1, 'only the new bug is pending');
  });
  it('a bug younger than 30 minutes waits for a later poll', async () => {
    const d = deps(new FakeAgent(needsHar));
    d.jira.changes[KEY] = { created: minutesAgo(10), updated: minutesAgo(10) };
    assert.deepEqual(await poll(d), { inQuery: 1, waiting: 1, pending: 0, checked: 0, failed: 0 });
    d.jira.changes[KEY] = { created: minutesAgo(31), updated: minutesAgo(10) };
    assert.deepEqual(await poll(d), { inQuery: 1, waiting: 0, pending: 1, checked: 1, failed: 0 });
  });
  it('a complete bug is recorded without a comment', async () => {
    const d = deps(new FakeAgent({ comment_needed: false, comment: '', missing: [], related: [] }));
    d.jira.inQuery = ['RPG-6192']; // HAR attached, every field fact passes
    assert.deepEqual(await poll(d), { inQuery: 1, waiting: 0, pending: 1, checked: 1, failed: 0 });
    assert.equal(d.store.status('RPG-6192'), 'complete');
  });
  it('dry run: the comment is recorded, nothing is posted, an unchanged bug is not checked again', async () => {
    const d = deps(new FakeAgent(needsHar));
    await poll(d);
    assert.equal(d.store.status(KEY), 'dry_run');
    assert.deepEqual(d.jira.posted, []);
    assert.deepEqual(await poll(d), { inQuery: 1, waiting: 0, pending: 0, checked: 0, failed: 0 });
  });
  it('a bug moved to the other project after its check is not checked again', async () => {
    const d = deps(new FakeAgent(needsHar));
    await poll(d);
    d.jira.inQuery = ['RPG-9999'];
    d.jira.ids = { 'RPG-9999': `id-${KEY}` };
    assert.deepEqual(await poll(d), { inQuery: 1, waiting: 0, pending: 0, checked: 0, failed: 0 });
    assert.equal(d.store.status('RPG-9999'), 'dry_run');
  });
  it('live: the row is written before the post, then marked commented', async () => {
    const d = deps(new FakeAgent(needsHar), false);
    await poll(d);
    assert.equal(d.store.status(KEY), 'commented');
    assert.deepEqual(d.jira.posted, [{ key: KEY, body: needsHar.comment }]);
  });
  it('live: a post that fails leaves the bug posting, for a human, never for a second post', async () => {
    const d = deps(new FakeAgent(needsHar), false);
    d.jira.addComment = async () => {
      throw new JiraError('request failed: fetch failed');
    };
    await assert.rejects(poll(d), JiraError);
    assert.equal(d.store.status(KEY), 'posting');
    d.jira.addComment = FakeJira.prototype.addComment;
    d.jira.attachHar(KEY);
    assert.equal((await poll(d)).pending, 0, 'not even when its report changes');
    assert.deepEqual(d.jira.posted, []);
  });
  it('a bad verdict costs an attempt; three of them mark the bug failed', async () => {
    const d = deps(new FakeAgent({ ...needsHar, missing: [] })); // R6 fails but is not named
    for (const n of [1, 2]) {
      assert.deepEqual(await poll(d), { inQuery: 1, waiting: 0, pending: 1, checked: 0, failed: 1 }, `attempt ${n}`);
      assert.equal(d.store.status(KEY), 'retry');
    }
    await poll(d);
    assert.equal(d.store.status(KEY), 'failed');
    assert.equal((await poll(d)).pending, 0);
  });
  it('a failure of the surroundings ends the poll and costs the bug nothing', async () => {
    for (const err of [new AgentError('cannot start claude: spawn claude ENOENT', 'start'), new JiraError('HTTP 503', 503)]) {
      const d = deps(new FakeAgent(err));
      await assert.rejects(poll(d), err.constructor as ErrorConstructor);
      assert.equal(d.store.status(KEY), null);
    }
  });
  it('a stop request ends the poll between bugs', async () => {
    const d = deps(new FakeAgent(needsHar));
    d.jira.inQuery = [KEY, 'KAZ-9025'];
    const stop = new AbortController();
    const agentRun = d.agent.run.bind(d.agent);
    d.agent.run = async (...args) => {
      stop.abort();
      return agentRun(...args);
    };
    assert.deepEqual(await poll(d, stop.signal), { inQuery: 2, waiting: 0, pending: 2, checked: 1, failed: 0 });
  });
});

describe('a re-check', () => {
  it('live: the report changed, so the comment is edited in place, never posted again', async () => {
    const d = deps(new FakeAgent(needsHar, harArrived), false);
    await poll(d);
    d.jira.attachHar(KEY);
    assert.deepEqual(await poll(d), { inQuery: 1, waiting: 0, pending: 1, checked: 1, failed: 0 });
    assert.match(d.agent.prompts[1] ?? '', /previous comment[\s\S]*- HAR file/);
    assert.equal(d.jira.posted.length, 1);
    assert.deepEqual(d.jira.edited, [{ key: KEY, commentId: '1', body: harArrived.comment }]);
    assert.deepEqual(d.store.rows([KEY]).get(KEY)?.comment, harArrived.comment);
    assert.equal((await poll(d)).pending, 0, 'the edit itself is not a change');
  });
  it('waits until nothing has moved on the bug for 15 minutes', async () => {
    const d = deps(new FakeAgent(needsHar, harArrived));
    await poll(d);
    d.jira.attachHar(KEY);
    d.jira.changes[KEY] = { ...d.jira.changes[KEY], updated: minutesAgo(5) };
    assert.deepEqual(await poll(d), { inQuery: 1, waiting: 1, pending: 0, checked: 0, failed: 0 });
    d.jira.changes[KEY] = { ...d.jira.changes[KEY], updated: minutesAgo(16) };
    assert.equal((await poll(d)).checked, 1);
    assert.equal(d.store.rows([KEY]).get(KEY)?.comment, harArrived.comment);
  });
  it('a failed re-check leaves the comment as it was and is tried again, up to 5 checks', async () => {
    const d = deps(new FakeAgent(needsHar, { ...needsHar, comment_needed: false, comment: '' }));
    await poll(d);
    d.jira.attachHar(KEY);
    for (let n = 2; n <= 5; n++) assert.equal((await poll(d)).failed, 1, `check ${n}`);
    assert.equal((await poll(d)).pending, 0, 'the cap');
    assert.deepEqual(d.store.rows([KEY]).get(KEY), { status: 'dry_run', fingerprint: d.store.rows([KEY]).get(KEY)?.fingerprint ?? '', comment: needsHar.comment, commentId: null, runs: 5 });
  });
});

describe('a request', () => {
  const requests = (d: Deps) => d.store.requests().map((r) => [r.key, r.error]);
  it('checks a bug whatever its age or row says, and is served before the planned checks', async () => {
    const d = deps(new FakeAgent(needsHar));
    d.jira.inQuery = [KEY, 'KAZ-9025'];
    d.jira.changes[KEY] = { created: minutesAgo(5), updated: minutesAgo(5) }; // too young for the poll
    d.store.bootstrap([{ id: 'id-KAZ-9025', key: 'KAZ-9025' }]); // skipped at the first start
    d.store.request(KEY);
    d.store.request('KAZ-9025');
    assert.deepEqual(await poll(d), { inQuery: 2, waiting: 1, pending: 0, checked: 0, failed: 0 }, 'nothing planned; the waiting loop serves requests');
    assert.deepEqual(await serveRequests(d), [KEY, 'KAZ-9025']);
    assert.equal(d.store.status(KEY), 'dry_run');
    assert.equal(d.store.status('KAZ-9025'), 'dry_run', 'a skipped bug is checked on request');
    assert.deepEqual(requests(d), [], 'served');
    assert.deepEqual(await serveRequests(d), []);
  });
  it('is served inside a poll, and its bug is not checked twice', async () => {
    const d = deps(new FakeAgent(needsHar));
    d.store.request(KEY);
    assert.deepEqual(await poll(d), { inQuery: 1, waiting: 0, pending: 1, checked: 0, failed: 0 });
    assert.equal(d.agent.prompts.length, 1);
    assert.equal(d.store.rows([KEY]).get(KEY)?.runs, 1);
  });
  it('re-checks a bug with a comment of the current mode, and checks a failed one afresh', async () => {
    const d = deps(new FakeAgent(needsHar, harArrived));
    await poll(d);
    d.jira.attachHar(KEY);
    d.store.request(KEY);
    await serveRequests(d);
    assert.match(d.agent.prompts[1] ?? '', /previous comment/);
    assert.equal(d.store.rows([KEY]).get(KEY)?.comment, harArrived.comment);

    const bad = { ...needsHar, missing: [] }; // R6 fails but is not named
    const failed = deps(new FakeAgent(bad, bad, bad, needsHar));
    for (const _ of [1, 2, 3]) await poll(failed);
    assert.equal(failed.store.status(KEY), 'failed');
    failed.store.request(KEY);
    await serveRequests(failed);
    assert.equal(failed.store.status(KEY), 'dry_run', 'the request replaces requeue');
  });
  it('fails for a key Jira does not know, keeps the reason, and follows a moved bug', async () => {
    const d = deps(new FakeAgent(needsHar));
    await poll(d);
    d.store.request('KAZ-1');
    d.store.request('RPG-9999');
    d.jira.inQuery = ['RPG-9999'];
    d.jira.ids = { 'RPG-9999': `id-${KEY}` };
    assert.deepEqual(await serveRequests(d), ['RPG-9999']);
    assert.deepEqual(requests(d), [['KAZ-1', 'JiraError: HTTP 404 on GET /issue/KAZ-1']]);
    assert.equal(d.store.status('RPG-9999'), 'dry_run', 'the row followed the key');
    assert.equal(d.store.rows(['RPG-9999']).get('RPG-9999')?.runs, 2, 'as a re-check of the moved bug');
  });
  it('a failure of the surroundings is thrown and leaves the request pending', async () => {
    const d = deps(new FakeAgent(new JiraError('HTTP 503', 503)));
    d.store.request(KEY);
    await assert.rejects(serveRequests(d), JiraError);
    assert.deepEqual(requests(d), [[KEY, null]]);
  });
});
