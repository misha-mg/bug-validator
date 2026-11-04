import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { AgentError, type Agent, type AgentRun } from '../src/claude/agent.ts';
import { Store } from '../src/db/store.ts';
import { JiraError, type Jira, type RawIssue } from '../src/jira/client.ts';
import type { Deps } from '../src/pipeline/deps.ts';
import { poll } from '../src/pipeline/poll.ts';
import { servePosts, serveRequests } from '../src/pipeline/requests.ts';
import { rawIssue } from './fixtures.ts';

// KAZ-9021: a video, no HAR, Devices = All, Affects versions set. Its field facts fail only R6.
// The fixtures were created days ago: old enough for the first check, quiet enough for a re-check.
const KEY = 'KAZ-9021';
const REPORTER = '712020:a91caa38-10e5-460c-86d2-5e9d9719237d';
const SERVICE = 'service-account';
const needsHar = { outcome: 'not_understood', reasoning: 'the request that fails is not in the report', reason: '', comment: `[~accountid:${REPORTER}]\nPlease attach a HAR file of the page load.` };
const harArrived = { ...needsHar, comment: `[~accountid:${REPORTER}]\n-Please attach a HAR file of the page load.-` };
const understood = { outcome: 'understood', reasoning: 'found it', reason: '', comment: '' };
const notWebui = { outcome: 'not_webui', reasoning: 'the UI shows what ConfD returns', reason: 'The counter comes from ConfD as shown.', comment: '' };
const minutesAgo = (m: number): string => new Date(Date.now() - m * 60_000).toISOString();

interface JiraComment {
  id: string;
  author: { accountId: string; displayName: string };
  created: string;
  body: string;
}

class FakeJira implements Jira {
  inQuery: string[] = [KEY];
  /** A bug's id; by default derived from its key, set to show a bug that moved. */
  ids: Record<string, string> = {};
  /** Fields that differ from the bug's fixture: what the reporter changed. */
  changes: Record<string, Record<string, unknown>> = {};
  /** The comments in Jira, by bug. */
  comments: Record<string, JiraComment[]> = {};
  posted: { key: string; body: string }[] = [];
  edited: { key: string; commentId: string; body: string }[] = [];
  async search(_jql: string): Promise<RawIssue[]> {
    return this.inQuery.map((key) => this.issue(key));
  }
  async getIssue(key: string): Promise<RawIssue> {
    if (!this.inQuery.includes(key) && !this.ids[key]) throw new JiraError(`HTTP 404 on GET /issue/${key}`, 404);
    return this.issue(key);
  }
  async attachment(): Promise<ReadableStream<Uint8Array>> {
    return new ReadableStream({ start: (c) => c.close() });
  }
  async myself(): Promise<{ accountId: string }> {
    return { accountId: SERVICE };
  }
  async addComment(key: string, body: string): Promise<{ id: string }> {
    this.posted.push({ key, body });
    const id = String(this.posted.length);
    (this.comments[key] ??= []).push({ id, author: { accountId: SERVICE, displayName: 'Service' }, created: new Date().toISOString(), body });
    return { id };
  }
  async editComment(key: string, commentId: string, body: string): Promise<void> {
    this.edited.push({ key, commentId, body });
    const comment = this.comments[key]?.find((c) => c.id === commentId);
    if (comment) comment.body = body;
  }
  /** The reporter attaches a HAR. */
  attachHar(key: string): void {
    const fields = rawIssue(key).fields as { attachment: object[] };
    this.changes[key] = { ...this.changes[key], attachment: [...fields.attachment, { id: '99', filename: 'session.har', size: 1, mimeType: 'application/json' }] };
  }
  private issue(key: string): RawIssue {
    const fixture = rawIssue(this.ids[key] ? KEY : key);
    return { id: this.ids[key] ?? `id-${key}`, key, fields: { ...fixture.fields, comment: { comments: this.comments[key] ?? [] }, ...this.changes[key] } };
  }
}

/** Returns the outcomes in turn, the last one from then on; `'hang'` runs until the stop. */
class FakeAgent implements Agent {
  private readonly outcomes: (unknown | Error)[];
  prompts: string[] = [];
  constructor(...outcomes: (unknown | Error)[]) {
    this.outcomes = outcomes;
  }
  async run(prompt: string, _jsonSchema: object, _bugDir: string, signal?: AbortSignal): Promise<AgentRun> {
    this.prompts.push(prompt);
    const outcome = this.outcomes.length > 1 ? this.outcomes.shift() : this.outcomes[0];
    if (outcome === 'hang') {
      // As the real agent: a stop kills the run, and one already asked for starts nothing.
      if (signal?.aborted) throw new AgentError('the service is stopping', 'stopped');
      await new Promise((_, reject) => signal?.addEventListener('abort', () => reject(new AgentError('the service is stopping', 'stopped'))));
    }
    if (outcome instanceof Error) throw outcome;
    return { output: outcome, costUsd: 0.002, durationMs: 10, turns: 1, model: 'haiku', instructions: 'abc', secrets: [] };
  }
}

function deps(agent: FakeAgent, dryRun = true): Deps & { jira: FakeJira; agent: FakeAgent } {
  const d = { config: { dryRun, maxAttempts: 3, pollIntervalMs: 180_000 }, jira: new FakeJira(), agent, clone: { update: async () => 'abc123def456' }, store: new Store(':memory:') };
  d.store.bootstrap([]);
  return d;
}

const row = (d: Deps, key = KEY) => d.store.rows([key]).get(key);
const summary = (s: Partial<Awaited<ReturnType<typeof poll>>>) => ({ inQuery: 1, waiting: 0, pending: 0, checked: 0, failed: 0, deferred: 0, ...s });

describe('poll', () => {
  it('the first poll skips what is already in the query and checks nothing', async () => {
    const d = deps(new FakeAgent(needsHar));
    d.store = new Store(':memory:');
    assert.deepEqual(await poll(d), summary({}));
    assert.equal(d.store.status(KEY), 'skipped');
    d.jira.inQuery = [KEY, 'KAZ-9025'];
    assert.deepEqual((await poll(d)).pending, 1, 'only the new bug is pending');
  });
  it('a bug younger than 30 minutes waits for a later poll', async () => {
    const d = deps(new FakeAgent(needsHar));
    d.jira.changes[KEY] = { created: minutesAgo(10), updated: minutesAgo(10) };
    assert.deepEqual(await poll(d), summary({ waiting: 1 }));
    d.jira.changes[KEY] = { created: minutesAgo(31), updated: minutesAgo(10) };
    assert.deepEqual(await poll(d), summary({ pending: 1, checked: 1 }));
  });
  it('a bug understood, or not a WebUI bug, is recorded without a comment and never checked again', async () => {
    const d = deps(new FakeAgent(understood, notWebui));
    d.jira.inQuery = ['RPG-6192', 'KAZ-9025'];
    assert.deepEqual(await poll(d), summary({ inQuery: 2, pending: 2, checked: 2 }));
    assert.deepEqual(row(d, 'RPG-6192'), { status: 'understood', fingerprint: row(d, 'RPG-6192')?.fingerprint, comment: null, commentId: null, runs: 1 });
    assert.equal(row(d, 'KAZ-9025')?.status, 'not_webui');
    d.jira.attachHar('RPG-6192');
    d.jira.attachHar('KAZ-9025');
    assert.deepEqual(await poll(d), summary({ inQuery: 2 }), 'a change brings no re-check');
    assert.deepEqual(d.jira.posted, []);
  });
  it('dry run: the comment is recorded, nothing is posted, an unchanged bug is not checked again', async () => {
    const d = deps(new FakeAgent(needsHar));
    await poll(d);
    assert.equal(d.store.status(KEY), 'dry_run');
    assert.deepEqual(d.jira.posted, []);
    assert.deepEqual(await poll(d), summary({}));
  });
  it('a bug moved to the other project after its check is not checked again', async () => {
    const d = deps(new FakeAgent(needsHar));
    await poll(d);
    d.jira.inQuery = ['RPG-9999'];
    d.jira.ids = { 'RPG-9999': `id-${KEY}` };
    assert.deepEqual(await poll(d), summary({}));
    assert.equal(d.store.status('RPG-9999'), 'dry_run');
  });
  it('a bad verdict costs an attempt; three of them mark the bug failed', async () => {
    const d = deps(new FakeAgent({ ...needsHar, comment: '' })); // not understood, yet no comment
    for (const n of [1, 2]) {
      assert.deepEqual(await poll(d), summary({ pending: 1, failed: 1 }), `attempt ${n}`);
      assert.equal(d.store.status(KEY), 'retry');
    }
    await poll(d);
    assert.equal(d.store.status(KEY), 'failed');
    assert.equal((await poll(d)).pending, 0);
  });
  it('a failure of the surroundings ends the poll and costs the bug nothing', async () => {
    const errors = [
      new AgentError('cannot start claude: spawn claude ENOENT', 'start'),
      new AgentError('claude reported an error: Claude AI usage limit reached', 'service'),
      new JiraError('HTTP 503', 503),
    ];
    for (const err of errors) {
      const d = deps(new FakeAgent(err));
      await assert.rejects(poll(d), err.constructor as ErrorConstructor);
      assert.equal(d.store.status(KEY), null);
    }
  });
  it('one bug the surroundings fail on is put off and does not hold up the next; two in a row end the poll', async () => {
    const d = deps(new FakeAgent(needsHar));
    d.jira.inQuery = [KEY, 'KAZ-9025'];
    const getIssue = d.jira.getIssue.bind(d.jira);
    d.jira.getIssue = async (key) => (key === KEY ? Promise.reject(new JiraError('HTTP 500 on GET', 500)) : getIssue(key));
    assert.deepEqual(await poll(d), summary({ inQuery: 2, pending: 2, checked: 1, deferred: 1 }));
    assert.equal(d.store.status(KEY), null, 'nothing recorded for the bug put off');
    assert.equal(d.store.status('KAZ-9025'), 'dry_run');

    const down = deps(new FakeAgent(new AgentError('API Error: 529 overloaded', 'service')));
    down.jira.inQuery = [KEY, 'KAZ-9025', 'KAZ-8996'];
    await assert.rejects(poll(down), /529/);
    assert.equal(down.agent.prompts.length, 2, 'the third bug is not tried');
  });
  it('a stop ends the poll between bugs', async () => {
    const d = deps(new FakeAgent(needsHar));
    d.jira.inQuery = [KEY, 'KAZ-9025'];
    const stop = new AbortController();
    const agentRun = d.agent.run.bind(d.agent);
    d.agent.run = async (...args) => {
      const result = await agentRun(...args);
      stop.abort();
      return result;
    };
    assert.deepEqual(await poll(d, stop.signal), summary({ inQuery: 2, pending: 2, checked: 1 }));
  });
  it('a stop in the middle of a check costs the bug nothing', async () => {
    const d = deps(new FakeAgent('hang'));
    const stop = new AbortController();
    const polled = poll(d, stop.signal);
    setTimeout(() => stop.abort(), 10);
    await assert.rejects(polled, /stopping/);
    assert.equal(d.store.status(KEY), null);
    assert.equal(row(d), undefined);
  });
});

describe('live', () => {
  it('the row is written before the post, then marked commented', async () => {
    const d = deps(new FakeAgent(needsHar), false);
    const addComment = d.jira.addComment.bind(d.jira);
    let before: string | null = null;
    d.jira.addComment = async (key, body) => {
      before = d.store.status(key);
      return addComment(key, body);
    };
    await poll(d);
    assert.equal(before, 'posting');
    assert.equal(d.store.status(KEY), 'commented');
    assert.deepEqual(d.jira.posted, [{ key: KEY, body: needsHar.comment }]);
  });
  it('a post with no answer leaves the bug posting; the next poll finds the comment in Jira and posts nothing', async () => {
    const d = deps(new FakeAgent(needsHar, harArrived), false);
    const addComment = d.jira.addComment.bind(d.jira);
    d.jira.addComment = async (key, body) => {
      await addComment(key, body); // it reached Jira, the answer did not come back
      throw new JiraError('request failed: fetch failed (socket hang up)');
    };
    await assert.rejects(poll(d), JiraError);
    assert.equal(d.store.status(KEY), 'posting');
    d.jira.addComment = addComment;
    d.jira.attachHar(KEY);
    assert.deepEqual(await poll(d), summary({ pending: 1, checked: 1 }));
    assert.equal(d.jira.posted.length, 1, 'never a second comment');
    assert.deepEqual(d.jira.edited, [{ key: KEY, commentId: '1', body: harArrived.comment }]);
    assert.match(d.agent.prompts[1] ?? '', /previous comment[\s\S]*Please attach a HAR/, 're-checked against the comment found');
    assert.deepEqual({ ...row(d), fingerprint: undefined }, { status: 'commented', fingerprint: undefined, comment: harArrived.comment, commentId: '1', runs: 2 });
  });
  it('a lost database: the comment already in Jira is adopted, not posted again', async () => {
    const d = deps(new FakeAgent(needsHar), false);
    await poll(d);
    d.store = new Store(':memory:');
    d.store.bootstrap([]);
    assert.deepEqual(await poll(d), summary({ pending: 1, checked: 1 }));
    assert.equal(d.jira.posted.length, 1);
    assert.deepEqual(d.jira.edited, [], 'the comment found says the same');
    assert.equal(row(d)?.commentId, '1');
  });
  it('a post Jira refuses for the bug costs an attempt; one refused by the surroundings does not', async () => {
    const d = deps(new FakeAgent(needsHar), false);
    d.jira.addComment = async () => {
      throw new JiraError('HTTP 400 on POST: body too long', 400);
    };
    assert.deepEqual(await poll(d), summary({ pending: 1, failed: 1 }));
    assert.equal(d.store.status(KEY), 'retry');

    const busy = deps(new FakeAgent(needsHar), false);
    busy.jira.addComment = async () => {
      throw new JiraError('HTTP 503 on POST', 503);
    };
    await assert.rejects(poll(busy), JiraError);
    assert.equal(busy.store.status(KEY), 'retry', 'no comment exists: back in line');
    busy.jira.addComment = FakeJira.prototype.addComment;
    await poll(busy);
    assert.equal(busy.store.status(KEY), 'commented');
    assert.equal(busy.jira.posted.length, 1);
  });
  it('after the post, any failure leaves the row posting: never a first check, never a second post', async () => {
    const d = deps(new FakeAgent(needsHar), false);
    d.store.markCommented = () => {
      throw new Error('SQLITE_FULL: database or disk is full');
    };
    await assert.rejects(poll(d), /disk is full/);
    assert.equal(d.store.status(KEY), 'posting');
    assert.equal(d.jira.posted.length, 1);
  });
});

describe('a re-check', () => {
  it('live: the report changed, so the comment is edited in place, never posted again', async () => {
    const d = deps(new FakeAgent(needsHar, harArrived), false);
    await poll(d);
    d.jira.attachHar(KEY);
    assert.deepEqual(await poll(d), summary({ pending: 1, checked: 1 }));
    assert.match(d.agent.prompts[1] ?? '', /previous comment[\s\S]*Please attach a HAR/);
    assert.equal(d.jira.posted.length, 1);
    assert.deepEqual(d.jira.edited, [{ key: KEY, commentId: '1', body: harArrived.comment }]);
    assert.deepEqual(row(d)?.comment, harArrived.comment);
    assert.equal((await poll(d)).pending, 0, 'the edit itself is not a change');
  });
  it('live: an unchanged comment is not edited', async () => {
    const d = deps(new FakeAgent(needsHar), false);
    await poll(d);
    d.jira.changes[KEY] = { description: 'Steps:\n1. open Ports' };
    assert.equal((await poll(d)).checked, 1);
    assert.deepEqual(d.jira.edited, []);
  });
  it('live: an edit Jira refuses (the comment was deleted) is the bug\'s failure, within its checks', async () => {
    const d = deps(new FakeAgent(needsHar, harArrived), false);
    await poll(d);
    d.jira.attachHar(KEY);
    d.jira.editComment = async () => {
      throw new JiraError('HTTP 404 on PUT', 404);
    };
    assert.deepEqual(await poll(d), summary({ pending: 1, failed: 1 }));
    assert.deepEqual({ ...row(d), fingerprint: undefined }, { status: 'commented', fingerprint: undefined, comment: needsHar.comment, commentId: '1', runs: 2 });
  });
  it('the reporter answering in a comment is a change', async () => {
    const d = deps(new FakeAgent(needsHar, needsHar));
    await poll(d);
    d.jira.comments[KEY] = [{ id: '9', author: { accountId: REPORTER, displayName: 'Reporter' }, created: minutesAgo(20), body: 'Steps: open Ports' }];
    d.jira.changes[KEY] = { updated: minutesAgo(20) };
    assert.equal((await poll(d)).checked, 1);
    assert.match(d.agent.prompts[1] ?? '', /\[Reporter \[reporter\], [\d-]+\] Steps: open Ports/);
  });
  it('waits until nothing has moved on the bug for 15 minutes', async () => {
    const d = deps(new FakeAgent(needsHar, harArrived));
    await poll(d);
    d.jira.attachHar(KEY);
    d.jira.changes[KEY] = { ...d.jira.changes[KEY], updated: minutesAgo(5) };
    assert.deepEqual(await poll(d), summary({ waiting: 1 }));
    d.jira.changes[KEY] = { ...d.jira.changes[KEY], updated: minutesAgo(16) };
    assert.equal((await poll(d)).checked, 1);
    assert.equal(row(d)?.comment, harArrived.comment);
  });
  it('a bug understood on a re-check is done: live, its comment stays in Jira as it is, and the row keeps it', async () => {
    const d = deps(new FakeAgent(needsHar, understood), false);
    await poll(d);
    d.jira.attachHar(KEY);
    assert.equal((await poll(d)).checked, 1);
    assert.deepEqual(d.jira.edited, [], 'not edited');
    assert.deepEqual({ ...row(d), fingerprint: undefined }, { status: 'understood', fingerprint: undefined, comment: needsHar.comment, commentId: '1', runs: 2 });
    d.jira.changes[KEY] = { ...d.jira.changes[KEY], description: 'changed again' };
    assert.deepEqual(await poll(d), summary({}), 'done');
  });
  it('a bug understood after its comment was found in Jira records that comment and its id', async () => {
    const d = deps(new FakeAgent(needsHar, understood), false);
    const addComment = d.jira.addComment.bind(d.jira);
    d.jira.addComment = async (key, body) => {
      await addComment(key, body); // it reached Jira, the answer did not come back
      throw new JiraError('request failed: fetch failed (socket hang up)');
    };
    await assert.rejects(poll(d), JiraError);
    d.jira.addComment = addComment;
    assert.equal((await poll(d)).checked, 1);
    assert.deepEqual({ ...row(d), fingerprint: undefined }, { status: 'understood', fingerprint: undefined, comment: needsHar.comment, commentId: '1', runs: 2 });
    assert.deepEqual(d.jira.edited, []);
  });
  it('a failed re-check leaves the comment and its fingerprint as they were and is tried again, up to 5 checks', async () => {
    const d = deps(new FakeAgent(needsHar, { ...needsHar, comment: '' }));
    await poll(d);
    const first = row(d)?.fingerprint;
    d.jira.attachHar(KEY);
    for (let n = 2; n <= 5; n++) assert.equal((await poll(d)).failed, 1, `check ${n}`);
    assert.equal((await poll(d)).pending, 0, 'the cap');
    assert.ok(first);
    assert.deepEqual(row(d), { status: 'dry_run', fingerprint: first, comment: needsHar.comment, commentId: null, runs: 5 });
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
    assert.deepEqual(await poll(d), summary({ inQuery: 2, waiting: 1 }), 'nothing planned; the waiting loop serves requests');
    assert.deepEqual(await serveRequests(d), [KEY, 'KAZ-9025']);
    assert.equal(d.store.status(KEY), 'dry_run');
    assert.equal(d.store.status('KAZ-9025'), 'dry_run', 'a skipped bug is checked on request');
    assert.deepEqual(requests(d), [], 'served');
    assert.deepEqual(await serveRequests(d), []);
  });
  it('is served inside a poll, and its bug is not checked twice', async () => {
    const d = deps(new FakeAgent(needsHar));
    d.store.request(KEY);
    assert.deepEqual(await poll(d), summary({ pending: 1 }));
    assert.equal(d.agent.prompts.length, 1);
    assert.equal(row(d)?.runs, 1);
  });
  it('re-checks a bug with a comment of the current mode, and checks a failed one afresh', async () => {
    const d = deps(new FakeAgent(needsHar, harArrived));
    await poll(d);
    d.jira.attachHar(KEY);
    d.store.request(KEY);
    await serveRequests(d);
    assert.match(d.agent.prompts[1] ?? '', /previous comment/);
    assert.equal(row(d)?.comment, harArrived.comment);

    const bad = { ...needsHar, comment: '' }; // not understood, yet no comment
    const failed = deps(new FakeAgent(bad, bad, bad, needsHar));
    for (const _ of [1, 2, 3]) await poll(failed);
    assert.equal(failed.store.status(KEY), 'failed');
    failed.store.request(KEY);
    await serveRequests(failed);
    assert.equal(failed.store.status(KEY), 'dry_run', 'the request replaces requeue');
  });
  it('dry run: a bug commented live is checked into the history only; its row and comment id stay', async () => {
    const d = deps(new FakeAgent(needsHar, harArrived), false);
    await poll(d);
    const live = row(d);
    d.config = { ...d.config, dryRun: true };
    d.jira.attachHar(KEY);
    d.store.request(KEY);
    await serveRequests(d);
    assert.match(d.agent.prompts[1] ?? '', /previous comment/, 'as a re-check of the posted comment');
    assert.deepEqual(row(d), { ...live, runs: 2 });
    assert.deepEqual(d.jira.edited, []);
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
    assert.equal(row(d, 'RPG-9999')?.runs, 2, 'as a re-check of the moved bug');
  });
  it('a failure of the surroundings is thrown and leaves the request pending; the third one fails it', async () => {
    const d = deps(new FakeAgent(new JiraError('HTTP 503', 503)));
    d.store.request(KEY);
    for (const _ of [1, 2]) {
      await assert.rejects(serveRequests(d), JiraError);
      assert.deepEqual(requests(d), [[KEY, null]]);
    }
    assert.deepEqual(await serveRequests(d), [], 'not thrown: the rest go on');
    assert.match(String(requests(d)[0]?.[1]), /failed 3 times: JiraError: HTTP 503/);
  });
  it('asked again while its check runs, it is not lost', async () => {
    const d = deps(new FakeAgent(needsHar));
    d.store.request(KEY);
    const agentRun = d.agent.run.bind(d.agent);
    d.agent.run = async (...args) => {
      await new Promise((r) => setTimeout(r, 5));
      d.store.request(KEY);
      return agentRun(...args);
    };
    await serveRequests(d);
    assert.deepEqual(requests(d), [[KEY, null]]);
  });
  it('a stop in the middle of its check leaves the request pending and costs the bug nothing', async () => {
    const d = deps(new FakeAgent('hang'));
    d.store.request(KEY);
    const stop = new AbortController();
    const served = serveRequests(d, stop.signal);
    setTimeout(() => stop.abort(), 10);
    await assert.rejects(served, /stopping/);
    assert.deepEqual(requests(d), [[KEY, null]]);
    assert.equal(row(d), undefined);
  });
});

describe('a post by hand', () => {
  const posts = (d: Deps) => d.store.posts().map((p) => [p.key, p.error]);
  it('dry run: posts the comment confirmed, once; the dry run then leaves it as it is', async () => {
    const d = deps(new FakeAgent(needsHar, harArrived));
    await poll(d);
    d.store.post(KEY, needsHar.comment);
    const addComment = d.jira.addComment.bind(d.jira);
    let before: string | null = null;
    d.jira.addComment = async (key, body) => {
      before = d.store.status(key);
      return addComment(key, body);
    };
    await serveRequests(d);
    assert.equal(before, 'posting', 'the row goes before the post');
    assert.deepEqual(d.jira.posted, [{ key: KEY, body: needsHar.comment }]);
    assert.deepEqual({ ...row(d), fingerprint: undefined }, { status: 'commented', fingerprint: undefined, comment: needsHar.comment, commentId: '1', runs: 1 });
    assert.deepEqual(posts(d), [], 'served');

    d.jira.attachHar(KEY);
    assert.deepEqual(await poll(d), summary({}), 'a dry run does not re-check a comment in Jira');
    d.store.request(KEY);
    await serveRequests(d);
    assert.deepEqual(d.jira.edited, [], 'nor edits it on request');
    assert.equal(row(d)?.comment, needsHar.comment);
  });
  it('a comment already in Jira is adopted, not posted again', async () => {
    const d = deps(new FakeAgent(needsHar));
    await poll(d);
    d.jira.comments[KEY] = [{ id: '7', author: { accountId: SERVICE, displayName: 'Service' }, created: minutesAgo(1), body: needsHar.comment }];
    d.store.post(KEY, needsHar.comment);
    await servePosts(d);
    assert.deepEqual(d.jira.posted, []);
    assert.equal(row(d)?.status, 'commented');
    assert.equal(row(d)?.commentId, '7');
  });
  it('fails, posting nothing, when the comment changed after it was confirmed, or is in Jira already', async () => {
    const d = deps(new FakeAgent(needsHar));
    await poll(d);
    d.store.post(KEY, 'the comment as it was before a re-check');
    await servePosts(d);
    assert.deepEqual(posts(d), [[KEY, 'Error: the comment changed after it was confirmed: read it again']]);
    d.store.post(KEY, needsHar.comment);
    await servePosts(d);
    d.store.post(KEY, needsHar.comment);
    await servePosts(d);
    assert.deepEqual(posts(d), [[KEY, 'Error: nothing to post: the bug is commented']]);
    assert.equal(d.jira.posted.length, 1);
  });
  it('a post Jira refuses leaves the comment unposted; one without an answer is looked up in Jira when tried again', async () => {
    const d = deps(new FakeAgent(needsHar));
    await poll(d);
    d.jira.addComment = async () => {
      throw new JiraError('HTTP 400 on POST: body too long', 400);
    };
    d.store.post(KEY, needsHar.comment);
    await servePosts(d);
    assert.equal(row(d)?.status, 'dry_run');
    assert.match(String(posts(d)[0]?.[1]), /HTTP 400/);

    const lost = deps(new FakeAgent(needsHar));
    await poll(lost);
    const addComment = lost.jira.addComment.bind(lost.jira);
    lost.jira.addComment = async (key, body) => {
      await addComment(key, body); // it reached Jira, the answer did not come back
      throw new JiraError('request failed: fetch failed (socket hang up)');
    };
    lost.store.post(KEY, needsHar.comment);
    await assert.rejects(serveRequests(lost), JiraError);
    assert.equal(row(lost)?.status, 'posting');
    assert.deepEqual(posts(lost), [[KEY, null]], 'still pending');
    await servePosts(lost);
    assert.equal(lost.jira.posted.length, 1, 'never a second comment');
    assert.equal(row(lost)?.status, 'commented');
    assert.deepEqual(posts(lost), []);
  });
});
