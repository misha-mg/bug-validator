// Tests of server.ts: the pages, the static files, the requests and posts, the guards, /healthz.
import assert from 'node:assert/strict'
import type { AddressInfo } from 'node:net'
import { request } from 'node:http'
import { afterAll, beforeAll, describe, it } from 'vitest'
import { startUi } from './server.ts'
import { readBug, readPosts, readRequests } from './read.ts'
import { appendLog, heartbeat, logLine, sampleState } from './sample.ts'

const state = sampleState()
let base = ''
let server: Awaited<ReturnType<typeof startUi>>

const get = async (path: string): Promise<{ status: number; type: string; body: string; headers: Headers }> => {
  const res = await fetch(base + path)
  return { status: res.status, type: res.headers.get('content-type') ?? '', body: await res.text(), headers: res.headers }
}

describe('server', () => {
  beforeAll(async () => {
    server = await startUi({
      dbFile: state.dbFile,
      logFile: state.logFile,
      jiraBaseUrl: 'https://jira.example.com',
      host: '127.0.0.1',
      port: 0,
      guard: { hostnames: ['validator.lan'], login: null, realm: 'Bug validator' },
    })
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  })
  afterAll(() => {
    server.closeAllConnections()
    server.close()
  })

  it('serves the pages', async () => {
    const home = await get('/')
    assert.equal(home.status, 200)
    assert.equal(home.type, 'text/html; charset=utf-8')
    assert.match(home.body, /<title>Bug validator<\/title>/)
    assert.match(home.body, /running/)
    const bugs = await get('/bugs?result=not_understood')
    assert.equal(bugs.status, 200)
    assert.match(bugs.body, /KAZ-2/)
    assert.doesNotMatch(bugs.body, /RPG-4/)
    const stats = await get('/stats?period=7d')
    assert.equal(stats.status, 200)
    assert.match(stats.body, /<a class="chip on" href="\/stats\?period=7d">7 days<\/a>/)
    assert.match((await get('/stats?period=x')).body, /<a class="chip on" href="\/stats\?period=30d">/, '30 days unless a period is named')
    const bug = await get('/bugs/KAZ-2')
    assert.equal(bug.status, 200)
    assert.match(bug.body, /<title>KAZ-2 · Bug validator<\/title>/)
    assert.match(bug.body, /https:\/\/jira.example.com\/browse\/KAZ-2/)
  })
  it('answers 404 to an unknown bug or path, 400 to a bad key, 405 to a POST', async () => {
    assert.equal((await get('/bugs/KAZ-99')).status, 404)
    assert.equal((await get('/nothing')).status, 404)
    assert.equal((await get('/bugs/x')).status, 400)
    assert.equal((await fetch(`${base}/`, { method: 'POST' })).status, 405)
  })
  it('serves the stylesheet, its fonts and the scripts with no-store and a CSP', async () => {
    const logo = await get('/logo.svg')
    assert.equal(logo.status, 200)
    assert.equal(logo.type, 'image/svg+xml')
    const css = await get('/app.css')
    assert.equal(css.status, 200)
    assert.equal(css.type, 'text/css; charset=utf-8')
    assert.doesNotMatch(css.body, /@font-face/, "the faces are the sheet's")
    const sheet = (await get('/sheet.css')).body
    assert.match(sheet, /--accent/)
    assert.match(sheet, /@font-face/)
    const font = await fetch(`${base}/fonts/inter-latin-400-normal.woff2`)
    assert.equal(font.status, 200)
    assert.equal(font.headers.get('content-type'), 'font/woff2')
    assert.equal((await font.arrayBuffer()).byteLength > 10_000, true)
    assert.equal((await get('/fonts/nothing.woff2')).status, 404)
    const js = await get('/app.js')
    assert.equal(js.type, 'text/javascript; charset=utf-8')
    assert.match(js.body, /setInterval/)
    assert.match((await get('/theme.js')).body, /localStorage/)
    assert.equal(css.headers.get('cache-control'), 'no-store')
    assert.match(font.headers.get('cache-control') ?? '', /immutable/, 'a font never changes under its name')
    const home = await get('/')
    assert.match(home.headers.get('content-security-policy') ?? '', /default-src 'self'.*frame-ancestors 'none'.*form-action 'self'/)
    assert.equal(home.headers.get('x-content-type-options'), 'nosniff')
  })
  it('takes a check request and shows it on the bug page', async () => {
    const post = (key: string, referer?: string) =>
      fetch(`${base}/requests`, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded', ...(referer ? { referer } : {}) },
        body: new URLSearchParams({ key }),
        redirect: 'manual',
      })
    const res = await post('https://jira.example.com/browse/RPG-4', `${base}/bugs?result=all&toast=success%3Aold`)
    assert.equal(res.status, 303)
    const location = res.headers.get('location') ?? ''
    assert.match(location, /^\/bugs\?result=all&toast=success%3ACheck\+of\+RPG-4\+requested/, 'the page asked from, with the toast')
    assert.match(
      (await get(location)).body,
      /<div class="notice calm" data-toast="success">Check of RPG-4 requested: the service takes it before its next poll<\/div>/,
    )
    assert.deepEqual(
      readRequests(state.dbFile).map((r) => r.key),
      ['KAZ-77', 'KAZ-1', 'RPG-4'],
    )
    assert.match((await get('/bugs/RPG-4')).body, /Request<\/dt><dd>waiting · just now/)
    assert.match((await get('/')).body, /RPG-4<\/a><\/td><td class="num dim">just now/)
    assert.match((await post('KAZ-9')).headers.get('location') ?? '', /^\/\?toast=/, 'no referer: the Cockpit')
    assert.match(
      (await post('KAZ-9', 'https://evil.example/bugs')).headers.get('location') ?? '',
      /^\/\?toast=/,
      'another site: the Cockpit',
    )
    const page = await get('/bugs/KAZ-9')
    assert.equal(page.status, 200, 'a page for a bug not checked yet')
    assert.match(page.body, /Not checked yet/)
    const bad = await post('ABC-1')
    assert.equal(bad.status, 400)
    assert.match(await bad.text(), /Not a KAZ or RPG issue: ABC-1/)
  })
  it('takes a post of a recorded comment, only the one the page showed, and shows it on the bug page', async () => {
    const post = (key: string, checked: string) =>
      fetch(`${base}/posts`, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded', referer: `${base}/bugs/${key}?post` },
        body: new URLSearchParams({ key, checked }),
        redirect: 'manual',
      })
    assert.match((await get('/bugs/KAZ-5?post')).body, /<dialog [^>]* open>/)
    const stale = await post('KAZ-5', '2026-01-01T00:00:00.000Z')
    assert.equal(stale.status, 400)
    assert.match(await stale.text(), /checked again after the page was shown/)
    assert.equal((await post('KAZ-3', readBug(state.dbFile, 'KAZ-3')!.checkedAt.toISOString())).status, 400, 'no comment to post')
    const res = await post('KAZ-5', readBug(state.dbFile, 'KAZ-5')!.checkedAt.toISOString())
    assert.equal(res.status, 303)
    assert.match(
      res.headers.get('location') ?? '',
      /^\/bugs\/KAZ-5\?toast=success%3APost\+of\+the\+comment\+on\+KAZ-5\+requested/,
      'the bug’s page without the confirmation it was asked from',
    )
    assert.deepEqual(
      readPosts(state.dbFile).map((p) => [p.key, p.error]),
      [['KAZ-5', null]],
    )
    const page = (await get('/bugs/KAZ-5')).body
    assert.match(page, /Post<\/dt><dd>waiting · just now/)
    assert.doesNotMatch(page, /Post to Jira/)
    assert.equal(
      (await fetch(`${base}/posts`, { method: 'POST', headers: { origin: 'http://evil.example' }, body: 'key=KAZ-5', redirect: 'manual' }))
        .status,
      403,
    )
  })
  it('shows the log as it grows', async () => {
    appendLog(state, logLine('poll_failed', new Date(), { error: 'Jira answered 503' }))
    assert.match((await get('/')).body, /failed · just now/)
  })
  it('answers a monitor on /healthz', async () => {
    const res = await get('/healthz')
    assert.equal(res.type, 'application/json; charset=utf-8')
    assert.equal(res.status, 200)
    assert.equal(JSON.parse(res.body).state, 'running')
    heartbeat(state.dbFile, new Date(Date.now() - 60_000))
    const stale = await get('/healthz')
    assert.equal(stale.status, 503, 'a stale heartbeat: the service is not running')
    assert.equal(JSON.parse(stale.body).state, 'silent')
    assert.match((await get('/')).body, /silent/)
    heartbeat(state.dbFile, new Date())
    assert.equal((await get('/healthz')).status, 200)
  })
  it("serves only a host it knows: another site cannot read the pages through a visitor's browser", async () => {
    const as = (host: string) =>
      new Promise<number>((resolve, reject) => {
        const port = (server.address() as AddressInfo).port
        request({ host: '127.0.0.1', port, path: '/', headers: { host } }, (res) => {
          res.resume()
          resolve(res.statusCode ?? 0)
        })
          .on('error', reject)
          .end()
      })
    assert.equal(await as('evil.example'), 421)
    assert.equal(await as('evil.example:8081'), 421)
    for (const host of ['10.0.0.5:8081', 'localhost', 'validator.lan', '[::1]:8081']) assert.equal(await as(host), 200, host)
  })
  it('takes a request only from its own pages, and only a form-sized one', async () => {
    const post = (headers: Record<string, string>, body = 'key=KAZ-3') =>
      fetch(`${base}/requests`, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded', ...headers },
        body,
        redirect: 'manual',
      })
    assert.equal((await post({ origin: 'http://evil.example' })).status, 403)
    assert.equal((await post({ 'sec-fetch-site': 'cross-site' })).status, 403)
    assert.equal((await post({ origin: base, 'sec-fetch-site': 'same-origin' })).status, 303)
    assert.equal((await post({}, `key=${'x'.repeat(10_000)}`)).status, 413)
    assert.equal((await get('/bugs?result=constructor')).body.includes('native code'), false, 'no inherited name is a filter')
  })
  it('asks for the login when one is set', async () => {
    const locked = await startUi({
      dbFile: state.dbFile,
      logFile: state.logFile,
      jiraBaseUrl: 'https://jira.example.com',
      host: '127.0.0.1',
      port: 0,
      guard: { hostnames: [], login: { user: 'qa', password: 'secret' }, realm: 'Bug validator' },
    })
    const url = `http://127.0.0.1:${(locked.address() as AddressInfo).port}`
    try {
      const denied = await fetch(`${url}/`)
      assert.equal(denied.status, 401)
      assert.match(denied.headers.get('www-authenticate') ?? '', /Basic/)
      assert.equal(
        (await fetch(`${url}/`, { headers: { authorization: `Basic ${Buffer.from('qa:wrong').toString('base64')}` } })).status,
        401,
      )
      assert.equal(
        (await fetch(`${url}/`, { headers: { authorization: `Basic ${Buffer.from('qa:secret').toString('base64')}` } })).status,
        200,
      )
      assert.equal((await fetch(`${url}/healthz`)).status, 200, 'a monitor needs no login')
    } finally {
      locked.closeAllConnections()
      locked.close()
    }
  })
})
