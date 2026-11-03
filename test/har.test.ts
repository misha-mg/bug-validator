import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import { cleanHar, MAX_BODY_CHARS } from '../src/domain/har.ts';

const fixture = readFileSync(new URL('./fixtures/session.har', import.meta.url), 'utf8');

describe('cleanHar', () => {
  const cleaned = cleanHar(fixture);
  const har = JSON.parse(cleaned) as { log: { entries: Record<string, any>[] } };
  const [login, image, form] = har.log.entries as [Record<string, any>, Record<string, any>, Record<string, any>];

  it('removes every secret it was given', () => {
    for (const secret of ['deadbeef', 'eyJ.secret', 'abc123', 'hunter2', 'k1', 't0k3n', 'newsid', 'iVBORw0KGgo=']) {
      assert.equal(cleaned.includes(secret), false, secret);
    }
  });
  it('keeps what the agent needs: method, URL, plain headers, parameters and JSON shape', () => {
    assert.equal(login.request.method, 'POST');
    assert.equal(login.request.url, 'https://10.0.0.5/api/login?access_token=%5Bremoved%5D&page=2');
    assert.deepEqual(login.request.headers[2], { name: 'Accept', value: 'application/json' });
    assert.deepEqual(login.request.queryString[1], { name: 'page', value: '2' });
    assert.deepEqual(login.request.cookies, []);
    assert.deepEqual(JSON.parse(login.request.postData.text), { user: 'qa', password: '[removed]', nested: { apiKey: '[removed]' } });
    assert.deepEqual(JSON.parse(login.response.content.text), { token: '[removed]', ok: true });
    assert.equal(form.request.postData.text, 'user=qa&password=[removed]&remember=1');
    assert.equal(form.response.content.text, '<html>fine</html>');
  });
  it('drops binary bodies and cuts long text ones', () => {
    assert.match(image.response.content.text, /^\[12 characters of image\/png removed\]$/);
    const long = fixture.replace('<html>fine</html>', 'x'.repeat(MAX_BODY_CHARS + 10));
    const cut = (JSON.parse(cleanHar(long)) as typeof har).log.entries[2]!.response.content.text as string;
    assert.match(cut, /\[… 10 more characters cut\]$/);
  });
  it('refuses what is not a HAR', () => {
    assert.throws(() => cleanHar('not json'), SyntaxError);
    assert.throws(() => cleanHar('{"log":{}}'), /not a HAR/);
  });
});
