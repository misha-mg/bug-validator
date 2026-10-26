import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import { after, before, describe, it } from 'node:test';
import { startUi } from '../../src/ui/server.ts';
import { appendLog, logLine, sampleState } from './state.ts';

const state = sampleState();
let base = '';
let server: Awaited<ReturnType<typeof startUi>>;

const get = async (path: string): Promise<{ status: number; type: string; body: string; headers: Headers }> => {
  const res = await fetch(base + path);
  return { status: res.status, type: res.headers.get('content-type') ?? '', body: await res.text(), headers: res.headers };
};

describe('server', () => {
  before(async () => {
    server = await startUi({ dbFile: state.dbFile, logFile: state.logFile, jiraBaseUrl: 'https://jira.example.com', host: '127.0.0.1', port: 0 });
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  after(() => {
    server.closeAllConnections();
    server.close();
  });

  it('serves the three pages', async () => {
    const home = await get('/');
    assert.equal(home.status, 200);
    assert.equal(home.type, 'text/html; charset=utf-8');
    assert.match(home.body, /<title>Bug validator<\/title>/);
    assert.match(home.body, /running/);
    const bugs = await get('/bugs?result=comment');
    assert.equal(bugs.status, 200);
    assert.match(bugs.body, /KAZ-2/);
    assert.doesNotMatch(bugs.body, /RPG-4/);
    const bug = await get('/bugs/KAZ-2');
    assert.equal(bug.status, 200);
    assert.match(bug.body, /<title>KAZ-2 · Bug validator<\/title>/);
    assert.match(bug.body, /https:\/\/jira.example.com\/browse\/KAZ-2/);
  });
  it('answers 404 to an unknown bug or path, 400 to a bad key, 405 to a POST', async () => {
    assert.equal((await get('/bugs/KAZ-99')).status, 404);
    assert.equal((await get('/nothing')).status, 404);
    assert.equal((await get('/bugs/x')).status, 400);
    assert.equal((await fetch(`${base}/`, { method: 'POST' })).status, 405);
  });
  it('serves the stylesheet and the script with no-store and a CSP', async () => {
    const css = await get('/app.css');
    assert.equal(css.status, 200);
    assert.equal(css.type, 'text/css; charset=utf-8');
    assert.match(css.body, /--primary/);
    const js = await get('/app.js');
    assert.equal(js.type, 'text/javascript; charset=utf-8');
    assert.match(js.body, /setInterval/);
    assert.equal(css.headers.get('cache-control'), 'no-store');
    assert.match((await get('/')).headers.get('content-security-policy') ?? '', /default-src 'self'/);
  });
  it('shows the log as it grows', async () => {
    appendLog(state, logLine('poll_failed', new Date(), { error: 'Jira answered 503' }));
    assert.match((await get('/')).body, /failed · just now/);
  });
});
