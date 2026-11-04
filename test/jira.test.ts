import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';
import { JiraClient, JiraError } from '../src/jira/client.ts';
import { scopedJql } from '../src/jira/queries.ts';

describe('JiraError', () => {
  it('is the surroundings\' without an answer and on 401, 403, 429 and 5xx; a refusal whenever Jira answered', () => {
    for (const status of [undefined, 401, 403, 429, 500, 503]) assert.equal(new JiraError('x', status).environmental, true, String(status));
    for (const status of [400, 404]) assert.equal(new JiraError('x', status).environmental, false, String(status));
    assert.equal(new JiraError('x').refused, false);
    assert.equal(new JiraError('x', 503).refused, true);
  });
});

describe('JiraClient', () => {
  const realFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = realFetch;
  });
  const client = () => new JiraClient({ baseUrl: 'https://x', cloudId: 'c', email: 'a@b.com', apiToken: 't' });
  it('a body that does not arrive is a failure without an answer, not the bug\'s', async () => {
    globalThis.fetch = async () =>
      new Response(new ReadableStream({ start: (c) => c.error(new Error('socket hang up')) }), { status: 201 });
    await assert.rejects(client().addComment('KAZ-1', 'hi'), (err: JiraError) => err.status === undefined && err.environmental && /socket hang up/.test(err.message));
  });
  it('an error answer keeps its status; an empty answer is fine', async () => {
    globalThis.fetch = async () => new Response('no', { status: 404 });
    await assert.rejects(client().getIssue('KAZ-1'), (err: JiraError) => err.status === 404 && !err.environmental);
    globalThis.fetch = async () => new Response(null, { status: 204 });
    await client().editComment('KAZ-1', '1', 'hi');
  });
  it('an attachment is read as a stream; a refusal keeps its status', async () => {
    globalThis.fetch = async () => new Response('bytes', { status: 200 });
    const stream = await client().attachment('10001');
    assert.equal(await new Response(stream).text(), 'bytes');
    globalThis.fetch = async () => new Response('gone', { status: 404 });
    await assert.rejects(client().attachment('10001'), (err: JiraError) => err.status === 404 && /attachment\/content\/10001/.test(err.message));
  });
  it('asks who it is once', async () => {
    let asked = 0;
    globalThis.fetch = async () => {
      asked += 1;
      return Response.json({ accountId: 'me' });
    };
    const c = client();
    assert.deepEqual(await c.myself(), { accountId: 'me' });
    await c.myself();
    assert.equal(asked, 1);
  });
});

describe('scopedJql', () => {
  it('narrows the agent\'s query to KAZ and RPG, its ORDER BY kept at the end', () => {
    assert.equal(scopedJql('summary ~ "scroll" ORDER BY updated DESC'), 'project IN (KAZ, RPG) AND (summary ~ "scroll") ORDER BY updated DESC');
    assert.equal(scopedJql('project = DM OR text ~ "x"'), 'project IN (KAZ, RPG) AND (project = DM OR text ~ "x")');
    assert.equal(scopedJql('order by created'), 'project IN (KAZ, RPG) order by created');
  });
});
