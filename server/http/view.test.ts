// Tests of view.ts: the three pages and a bug's page rendered from the sample state.
import assert from 'node:assert/strict'
import { describe, it } from 'vitest'
import {
  type HomeModel,
  type PageContext,
  RESULT_TONE,
  bugPage,
  bugsPage,
  bugsQuery,
  columnChart,
  commentHtml,
  errorPage,
  eventText,
  filterBugs,
  homePage,
  resultLabel,
  statsPage,
  toastOf,
  toastParam,
  toneClass,
} from './view.ts'
import { readBug, readBugs, readHeartbeat, readRequests } from './read.ts'
import { ServiceLog } from './service-log.ts'
import { checksPerDay } from './stats.ts'
import { daysAgo, sampleState } from './sample.ts'
import { fmtDate } from '../format.ts'

const state = sampleState()
const bugs = readBugs(state.dbFile)
const requests = readRequests(state.dbFile)
const log = new ServiceLog(state.logFile)
const bugModel = (key: string) => ({ key, bug: readBug(state.dbFile, key), request: requests.find((r) => r.key === key) ?? null })
const status = log.read()
const ctx: PageContext = { jiraBaseUrl: 'https://jira.example.com', dryRun: true, now: state.now }
const home: HomeModel = {
  bugs,
  status,
  logPath: state.logFile,
  recent: log.recent,
  requests,
  heartbeat: readHeartbeat(state.dbFile),
  dbPath: state.dbFile,
  dbFound: true,
}
const nothing: HomeModel = {
  bugs: [],
  status: null,
  logPath: '/x/service.log',
  recent: [],
  requests: [],
  heartbeat: null,
  dbPath: '/x/db.sqlite',
  dbFound: false,
}

/** The text of an HTML string: tags gone, whitespace folded. */
const text = (html: string): string =>
  html
    .replace(/<[^>]+>/g, ' ')
    .replace(/&quot;/g, '"')
    .replace(/\s+/g, ' ')
    .trim()
/** One section of a page by its frame's class, or one card's. */
const section = (html: string, cls: string): string => {
  const start = html.indexOf(`<section class="frame ${cls}"`)
  assert.notEqual(start, -1, `a frame ${cls}`)
  return html.slice(start, html.indexOf('</section>', start))
}
const card = (html: string, name: string): string => text(section(html, `card ${name}`))

describe('layout', () => {
  it('has the masthead with the three pages, the mode and the theme switch', () => {
    const html = homePage(home, ctx)
    assert.match(
      html,
      /<a class="btn active" href="\/">Cockpit<\/a><a class="btn" href="\/bugs">Bugs<\/a><a class="btn" href="\/stats">Statistics<\/a>/,
    )
    assert.match(html, /<span class="pill">dry run<\/span>/)
    assert.match(html, /<button class="btn theme" type="button"/)
    assert.match(bugsPage(bugs, bugsQuery(new URLSearchParams()), ctx), /<a class="btn active" href="\/bugs">Bugs<\/a>/)
    assert.match(statsPage(bugs, '30d', ctx), /<a class="btn active" href="\/stats">Statistics<\/a>/)
    assert.match(bugPage(bugModel('KAZ-2'), ctx), /<a class="btn active" href="\/bugs">Bugs<\/a>/, 'a bug is under Bugs')
    assert.doesNotMatch(homePage(home, { ...ctx, dryRun: null }), /<span class="pill[^"]*">(dry run|live)</)
  })
  it('shows the toast of a redirect as a notice, for a page without JavaScript', () => {
    assert.deepEqual(toastOf(new URLSearchParams('toast=success%3ACheck+of+KAZ-1+requested')), {
      kind: 'success',
      text: 'Check of KAZ-1 requested',
    })
    assert.deepEqual(toastOf(new URLSearchParams('toast=Plain+words')), { kind: 'info', text: 'Plain words' })
    assert.deepEqual(toastOf(new URLSearchParams('toast=nonsense%3Ax')), { kind: 'info', text: 'x' })
    assert.equal(toastOf(new URLSearchParams('toast=error%3A')), null)
    assert.equal(toastOf(new URLSearchParams()), null)
    assert.equal(toastParam({ kind: 'success', text: 'Done' }), 'success:Done')
    const html = homePage(home, { ...ctx, toast: { kind: 'success', text: 'Check of <KAZ-1> requested' } })
    assert.match(html, /<main class="sheet">\n<div class="notice calm" data-toast="success">Check of &lt;KAZ-1&gt; requested<\/div>/)
    assert.match(homePage(home, { ...ctx, toast: { kind: 'error', text: 'No' } }), /<div class="notice" data-toast="error">No<\/div>/)
    assert.doesNotMatch(homePage(home, ctx), /data-toast/)
  })
  it('an error page is a notice under its status', () => {
    const html = errorPage(404, 'No page at /x <y>.', ctx)
    assert.match(html, /<h1>404<\/h1><\/div><div class="notice">No page at \/x &lt;y&gt;\.<\/div>/)
  })
  it('maps a result to its tone and the pill class', () => {
    assert.deepEqual(RESULT_TONE, { understood: 'ok', not_understood: 'live', not_webui: 'strong', error: 'bad', skipped: '' })
    assert.deepEqual(
      ['ok', 'bad', 'live', 'strong', ''].map((t) => toneClass(t as never)),
      ['ok', 'bad', 'slate', 'strong', ''],
    )
  })
})

describe('cockpit', () => {
  const html = homePage(home, ctx)
  it('has the four cards', () => {
    assert.match(section(html, 'card service'), /<div class="value live">running <\/div>/)
    assert.match(card(html, 'service'), /^Service running last poll 1m 00s ago$/)
    assert.match(card(html, 'checking'), /^Checking — nothing running$/)
    assert.match(card(html, 'created'), /^In Created 7 2 waiting as of \d\d:\d\d · poll every 3m 00s$/)
    assert.match(card(html, 'mode'), /^Mode dry run model haiku · claude 2\.0\.30 · Slack on$/)
  })
  it('the cards say when the service is silent, crashed, polling badly or checking', () => {
    const stale = { ...home, heartbeat: { pid: 1, startedAt: state.now, seenAt: new Date(state.now.getTime() - 60_000) } }
    assert.match(section(homePage(stale, ctx), 'card service'), /<div class="value err">silent <small>1m 00s ago<\/small><\/div>/)
    const s = status!
    const crashed = { ...home, status: { ...s, crashed: 'Error: boom <x>' } }
    const crashedCard = section(homePage(crashed, ctx), 'card service')
    assert.match(crashedCard, /<div class="value err">crashed <small>/)
    assert.match(crashedCard, /<div class="note one err" title="Error: boom &lt;x&gt;">Error: boom &lt;x&gt;<\/div>/)
    const failing = { ...home, status: { ...s, pollError: 'HTTP 503', pollFailures: 3 } }
    const failingHtml = homePage(failing, ctx)
    assert.match(card(failingHtml, 'service'), /last poll failed 3 times in a row · 1m 00s ago HTTP 503$/)
    assert.match(section(failingHtml, 'card service'), /<div class="note one err" title="HTTP 503">HTTP 503<\/div>/)
    assert.match(card(failingHtml, 'created'), /^In Created 7 2 waiting as of the last poll that went through · poll every 3m 00s$/)
    const checking = { ...home, status: { ...s, checking: { key: 'KAZ-2', since: new Date(state.now.getTime() - 90_000) } } }
    const checkingCard = section(homePage(checking, ctx), 'card checking')
    assert.match(text(checkingCard), /^Checking KAZ-2 for 1m 30s Open$/)
    assert.match(checkingCard, /<a class="btn tiny" href="\/bugs\/KAZ-2">Open<\/a>/)
    assert.match(card(homePage({ ...home, status: { ...s, dryRun: false } }, ctx), 'mode'), /^Mode live/)
  })
  it('the state sources are open, all OK, with a pill each and the facts under them', () => {
    const sources = section(html, 'sources')
    assert.match(sources, /<section class="frame sources" data-ok="1">/)
    assert.match(
      sources,
      /<button class="fold" type="button" aria-expanded="true"><span class="label">State sources<\/span><span class="lamp ok"><\/span><span class="state">all OK<\/span>/,
    )
    const deps = [
      ...sources.matchAll(
        /<div class="name">([^<]+)<\/div><div class="detail" title="[^"]*">([^<]*)<\/div><\/div><span class="pill (ok|bad)">/g,
      ),
    ].map((m) => [m[1], m[2], m[3]])
    assert.deepEqual(deps, [
      ['Service log', `${state.logFile} · last line 1m 00s ago`, 'ok'],
      ['Database', `${state.dbFile} · 6 bugs`, 'ok'],
      ['Jira', 'polled 1m 00s ago', 'ok'],
      ['claude', '2.0.30 · model haiku', 'ok'],
      ['WebUI clone', 'master at b37045e50d97', 'ok'],
    ])
    const facts = text(sources.slice(sources.indexOf('<div class="facts">')))
    assert.match(
      facts,
      /^Started \d{4}-\d\d-\d\d \d\d:\d\d Heartbeat just now · pid 4242 · started \d{4}-\d\d-\d\d \d\d:\d\d WebUI b37045e50d97 · master Poll every 3m 00s$/,
    )
  })
  it('the state sources name what is not OK', () => {
    const failing = homePage({ ...home, status: { ...status!, pollError: 'HTTP 503', pollFailures: 2 } }, ctx)
    const sources = section(failing, 'sources')
    assert.match(sources, /data-ok="0"/)
    assert.match(sources, /<span class="lamp bad"><\/span><span class="state err">Jira not OK<\/span>/)
    assert.match(
      sources,
      /<div class="name">Jira<\/div><div class="detail" title="poll failed 2 times in a row · HTTP 503">[^<]*<\/div><\/div><span class="pill bad">not OK<\/span>/,
    )
    const empty = section(homePage(nothing, ctx), 'sources')
    assert.match(empty, /<span class="state err">Service log, Database, Jira, claude, WebUI clone not OK<\/span>/)
    assert.match(empty, /no log at \/x\/service.log/)
    assert.match(empty, /no database at \/x\/db.sqlite/)
    assert.match(text(empty), /Heartbeat none yet/)
  })
  it('lists the pending requests, the bugs skipped at the first start, what needs attention and the activity', () => {
    const requested = section(html, 'requested')
    assert.match(
      text(requested),
      /^Requested 1 check checks asked for by hand, made before the next poll’s Bug Asked KAZ-1 2m 00s ago$/,
      'the pending request, not the failed one',
    )
    assert.match(requested, /<table class="wide">.*<a class="key" href="\/bugs\/KAZ-1">KAZ-1<\/a>/)
    assert.match(
      text(section(html, 'skipped')),
      /^Skipped at the first start Bugs 1 First start \d{4}-\d\d-\d\d \d\d:\d\d Why already in Created/,
    )
    const attention = section(html, 'attention')
    assert.match(attention, /<table class="wide">/)
    assert.match(
      text(attention),
      /^Needs attention 2 failed checks, interrupted posts, bugs not the WebUI's Bug Last check What Why RPG-4 .* 3 of 3 failed, gave up Error: agent run timed out RPG-6 .* not a WebUI bug The UI shows the counter ConfD returns\.$/,
    )
    assert.match(attention, /href="\/bugs\/RPG-4"/)
    assert.match(attention, /<span class="pill bad">3 of 3 failed, gave up<\/span>/)
    assert.match(attention, /<span class="pill strong">not a WebUI bug<\/span>/)
    const activity = section(html, 'activity')
    assert.match(activity, /<table class="wide activity">/)
    assert.match(text(activity), /KAZ-2 re-check: not understood · comment · dry run/)
    assert.match(text(activity), /service started · dry run · haiku/)
  })
  it('says so when there is no log, no database and nothing to show', () => {
    const empty = homePage(nothing, { ...ctx, dryRun: null })
    assert.match(card(empty, 'service'), /^Service — no log no log at \/x\/service.log$/)
    assert.match(section(empty, 'card service'), /<div class="note one err"/)
    assert.match(card(empty, 'checking'), /^Checking — nothing running$/)
    assert.match(card(empty, 'created'), /^In Created — no poll yet$/)
    assert.match(card(empty, 'mode'), /^Mode — not known: no service start in the log$/)
    assert.match(section(empty, 'requested'), /<p class="empty">Nothing requested\.<\/p>/)
    assert.match(section(empty, 'attention'), /<p class="empty">Nothing to look at\.<\/p>/)
    assert.match(section(empty, 'activity'), /<p class="empty">Nothing logged yet\.<\/p>/)
    assert.doesNotMatch(empty, /class="frame skipped"/)
  })
  it('writes each event as one line', () => {
    const at = (event: string, fields: Record<string, unknown> = {}) => eventText({ ts: state.now, level: 'info', event, fields })
    assert.equal(at('bug_understood', { key: 'KAZ-1', outcome: 'understood' }), 'understood, no comment')
    assert.equal(at('bug_understood', { key: 'KAZ-1', recheck: true, kept: true }), 're-check: understood, no comment, the posted one kept')
    assert.equal(at('bug_not_webui', { key: 'KAZ-1', reason: 'ConfD <counts>' }), 'not a WebUI bug · ConfD &lt;counts&gt;')
    assert.equal(at('comment_posted', { key: 'KAZ-1', outcome: 'not_understood' }), 'not understood · comment posted')
    assert.equal(at('webui_fetched', { from: 'abc', to: 'def' }), 'WebUI master moved: abc → def')
    assert.equal(at('check_failed', { key: 'KAZ-1', attempts: 2, error: 'x <y>' }), 'check failed · attempt 2 · x &lt;y&gt;')
    assert.equal(at('check_failed', { key: 'KAZ-1', recheck: true, error: 'x' }), 're-check failed · x')
    assert.equal(at('key_changed', { from: 'RPG-1', to: 'KAZ-2' }), 'moved: RPG-1 → KAZ-2')
    assert.equal(at('poll_failed', { error: 'HTTP 503' }), 'poll failed · HTTP 503')
    assert.equal(at('request_failed', { key: 'KAZ-1', error: 'HTTP 404' }), 'request failed · HTTP 404')
    assert.equal(
      at('comment_dry_run', { key: 'KAZ-1', requested: true, recheck: true }),
      'requested · re-check: not understood · comment · dry run',
    )
    const long = `HTTP 403 on GET /search?${'x'.repeat(200)}`
    const line = at('poll_failed', { error: long })
    assert.ok(line.startsWith(`poll failed · <span title="${long}">HTTP 403 on GET /search?xxx`) && line.endsWith('…</span>'))
    assert.equal(line.length, long.length + 'poll failed · <span title="">'.length + 120 + '</span>'.length)
    assert.equal(at('first_start', { skipped: ['KAZ-1', 'RPG-2'] }), 'first start · 2 bugs already in Created skipped')
    assert.equal(at('service_start', { dryRun: true, model: 'sonnet', slack: true }), 'service started · dry run · sonnet · Slack on')
    assert.equal(at('service_start', { dryRun: false, model: 'sonnet', slack: false }), 'service started · live · sonnet')
    assert.equal(at('slack_notified', { key: 'KAZ-1', comment: 'waiting' }), 'Slack message sent')
    assert.equal(at('slack_failed', { key: 'KAZ-1', error: 'HTTP 404: no_service' }), 'Slack message failed · HTTP 404: no_service')
    assert.equal(at('check_deferred', { key: 'KAZ-1', error: 'HTTP 500' }), 'check put off · HTTP 500')
    assert.equal(at('request_failed', { key: 'KAZ-1', error: 'HTTP 503', gaveUp: true }), 'request failed, gave up · HTTP 503')
    assert.match(at('comment_adopted', { key: 'KAZ-1', commentId: '7' }), /found the service&#39;s comment in Jira \(7\)/)
    assert.equal(at('comment_edited', { key: 'KAZ-1', changed: false }), 're-check: comment unchanged')
    assert.equal(at('comment_edited', { key: 'KAZ-1', changed: true }), 'not understood · comment edited')
    assert.equal(at('comment_posted', { key: 'KAZ-1', byHand: true, commentId: '7' }), 'comment posted by hand')
    assert.equal(at('post_failed', { key: 'KAZ-1', error: 'the comment changed', gaveUp: false }), 'post failed · the comment changed')
    assert.equal(at('something_new'), 'something_new')
  })
})

describe('bugs', () => {
  const keys = (html: string) => [...html.matchAll(/<td class="key"><a class="key" href="\/bugs\/([A-Z]+-\d+)"/g)].map((m) => m[1])
  it('lists bugs by day with their result, filtered by result and search', () => {
    const html = bugsPage(bugs, bugsQuery(new URLSearchParams()), ctx)
    assert.deepEqual(keys(html), ['KAZ-2', 'RPG-4', 'KAZ-3', 'RPG-6', 'KAZ-5', 'KAZ-1'])
    assert.equal((html.match(/<tr class="day">/g) ?? []).length, 6)
    assert.match(html, /<table class="wide bugs">/)
    assert.equal(
      (html.match(/<form class="inline" method="post" action="\/requests">/g) ?? []).length,
      6,
      'a Run again button on every row',
    )
    assert.match(
      html,
      /<input type="hidden" name="key" value="KAZ-2"><button class="btn tiny icon" title="Run again" aria-label="Run KAZ-2 again">↻<\/button>/,
    )
    const page = text(html)
    assert.match(page, /All bugs 6 bugs/)
    assert.match(
      page,
      /KAZ-2 ↗ Ports table is empty after clearing the filter \d\d:\d\d comment · dry run R1 R4 R6 1 3/,
      'absent at the first check',
    )
    assert.match(page, /KAZ-3 ↗ Login page freezes \d\d:\d\d understood 1 /, 'one check is counted')
    assert.match(page, /RPG-6 ↗ Port counter lags behind the CLI \d\d:\d\d not a WebUI bug R6/)
    assert.match(page, /\w\w\w \d\d \w\w\w KAZ-1 ↗ \d\d:\d\d skipped ↻$/)
    assert.match(
      html,
      /<td class="jira"><a href="https:\/\/jira.example.com\/browse\/KAZ-2" target="_blank" rel="noopener" title="KAZ-2 in Jira">↗<\/a><\/td>/,
    )
    assert.match(html, /<span class="req" title="HAR file">R6<\/span>/)
    assert.match(html, /<span class="pill ok">understood<\/span>/)
    assert.match(html, /<span class="pill slate">comment · dry run<\/span>/)
    assert.match(html, /<span class="pill strong">not a WebUI bug<\/span>/)
    assert.match(html, /<span class="pill bad">check failed<\/span>/)
    assert.match(html, /<span class="pill">skipped<\/span>/)

    const commented = bugsPage(bugs, bugsQuery(new URLSearchParams('result=not_understood')), ctx)
    assert.deepEqual(keys(commented), ['KAZ-2', 'KAZ-5'])
    assert.match(text(commented), /All bugs 2 of 6 bugs shown/)
    assert.match(commented, /<a class="chip fam on" href="\/bugs\?result=not_understood&q=">not understood <b>2<\/b><\/a>/)

    const searched = bugsPage(bugs, bugsQuery(new URLSearchParams('q=LOGIN')), ctx)
    assert.deepEqual(
      filterBugs(bugs, { result: 'all', q: 'login' }).map((b) => b.key),
      ['KAZ-3'],
    )
    assert.match(text(searched), /All bugs 1 of 6 bugs shown/)
    assert.match(searched, /<input class="field" type="search" name="q" value="LOGIN"/)
    assert.match(text(bugsPage(bugs, bugsQuery(new URLSearchParams('result=nonsense&q=zzz')), ctx)), /No bug matches/)
    assert.match(bugsPage(bugs, bugsQuery(new URLSearchParams('q=zzz')), ctx), /<p class="empty">No bug matches\.<\/p>/)
  })
  it('the filters count each result, grouped by tone, with a Clear link once narrowed', () => {
    const html = bugsPage(bugs, bugsQuery(new URLSearchParams()), ctx)
    const start = html.indexOf('<form class="filters"')
    const filters = html.slice(start, html.indexOf('</form>', start))
    assert.match(
      filters,
      /<span class="label">Result<\/span><div class="opts"><a class="chip on" href="\/bugs\?result=all&q=">All <b>6<\/b><\/a>/,
    )
    assert.match(filters, /<div class="group ok"><a class="chip fam" [^>]*>understood <b>1<\/b><\/a><\/div>/)
    assert.match(
      filters,
      /<div class="group"><a class="chip fam" [^>]*>not understood <b>2<\/b><\/a><a class="chip fam" [^>]*>not a WebUI bug <b>1<\/b><\/a><\/div>/,
    )
    assert.match(filters, /<div class="group bad"><a class="chip fam" [^>]*>error <b>1<\/b><\/a><\/div>/)
    assert.match(filters, /<a class="chip" href="\/bugs\?result=skipped&q=">skipped <b>1<\/b><\/a><\/div><\/div>/)
    assert.match(filters, /<span class="label">Search<\/span><div class="opts"><input class="field" type="search" name="q" value=""/)
    assert.doesNotMatch(filters, /clear/)
    assert.match(filters, /<input type="hidden" name="result" value="all">/)
    const searched = bugsPage(bugs, bugsQuery(new URLSearchParams('q=KAZ')), ctx)
    assert.match(searched, /<a class="btn tiny clear" href="\/bugs">Clear<\/a>/)
    assert.match(searched, /All <b>4<\/b>/, 'the chips count what the search lets through')
    assert.match(searched, /error <b>0<\/b>/)
    assert.match(bugsPage(bugs, bugsQuery(new URLSearchParams('result=error')), ctx), /<a class="btn tiny clear" href="\/bugs">Clear<\/a>/)
  })
  it('escapes what the database holds', () => {
    const html = bugsPage(bugs, bugsQuery(new URLSearchParams('q=<script>')), ctx)
    assert.doesNotMatch(html, /<script>/)
    assert.match(html, /value="&lt;script&gt;"/)
    assert.match(bugsPage(bugs, bugsQuery(new URLSearchParams()), ctx), /Device list is cut &lt;b&gt;/)
  })
})

describe('statistics', () => {
  const html = statsPage(bugs, '30d', ctx)
  const cells = (page: string) =>
    [
      ...page.matchAll(
        /<div class="cell"><div class="label">([^<]+)<\/div><div class="value( [a-z]+)?">([^<]+)<\/div><div class="note" title="[^"]*">([^<]*)<\/div>/g,
      ),
    ].map((m) => [m[1], (m[2] ?? '').trim(), m[3], m[4]])
  it('has the period chips, the default being 30 days', () => {
    assert.match(
      text(html.slice(html.indexOf('<main'))),
      /^Statistics 30 days · bugs first checked in it, by their result now Period Today 7 days 30 days All time/,
    )
    assert.match(
      html,
      /<a class="chip" href="\/stats\?period=today">Today<\/a><a class="chip" href="\/stats\?period=7d">7 days<\/a><a class="chip on" href="\/stats\?period=30d">30 days<\/a><a class="chip" href="\/stats\?period=all">All time<\/a>/,
    )
    assert.match(statsPage(bugs, 'today', ctx), /<a class="chip on" href="\/stats\?period=today">Today<\/a>/)
  })
  it('the strip adds the period up', () => {
    assert.deepEqual(cells(html), [
      ['Checked', '', '4', `6 checks · since ${fmtDate(daysAgo(10, state.now))}`],
      ['Understood', 'ok', '1', '25% of checked'],
      ['Not understood', '', '2', '50% of checked'],
      ['Not a WebUI bug', '', '1', '25% of checked'],
      ['Failed', 'bad', '1', 'bugs whose last check failed'],
      ['Cost', '', '$0.15', 'median $0.03 per check'],
    ])
    assert.deepEqual(cells(statsPage(bugs, 'today', ctx)), [
      ['Checked', '', '1', `3 checks · since ${fmtDate(state.now)}`],
      ['Understood', '', '0', '0% of checked'],
      ['Not understood', '', '1', '100% of checked'],
      ['Not a WebUI bug', '', '0', '0% of checked'],
      ['Failed', '', '0', 'none'],
      ['Cost', '', '$0.06', 'median $0.03 per check'],
    ])
    assert.deepEqual(
      cells(statsPage([], 'all', ctx)).map((c) => c.slice(1)),
      [
        ['', '0', '0 checks'],
        ['', '0', '—'],
        ['', '0', '—'],
        ['', '0', '—'],
        ['', '0', 'none'],
        ['', '$0.00', 'no check with a cost'],
      ],
    )
  })
  it('the field checks failed most often as bars, and those passed after the comment', () => {
    const gaps = section(html, 'gaps')
    assert.match(
      text(gaps),
      /^Field checks failed most often first checks of 4 bugs what the reports lacked as they arrived R6 · HAR file 3 75% R1 · Steps to reproduce 1 25% R4 · Affects versions 1 25% R2 /,
    )
    assert.match(
      gaps,
      /<div class="bar-row" title="3 of 4 first checks found HAR file absent"><span class="name">R6 · HAR file<\/span><span class="track"><i style="width:75.0%"><\/i><\/span><b class="num">3<\/b><span class="share num">75%<\/span><\/div>/,
    )
    const after = section(html, 'after')
    assert.match(
      text(after),
      /^Field checks passed after the comment 1 of 3 what arrived while a commented bug was still in Created passed later 1 33% still absent 2 67%$/,
    )
    assert.match(after, /<i class="none" style="width:66.7%">/)
    assert.match(section(statsPage([], '7d', ctx), 'gaps'), /<p class="empty">No bug checked to the end in this period\.<\/p>/)
    assert.match(section(statsPage(bugs, 'today', ctx), 'after'), /^.*1 of 3/, 'KAZ-2 was re-checked today')
    assert.match(section(statsPage([], '7d', ctx), 'after'), /<p class="empty">No bug re-checked after its comment yet\.<\/p>/)
  })
  it('the chart has a column per day of the period, stacked by result, with a legend and a hit per day', () => {
    const chart = section(html, 'chart')
    assert.match(
      text(chart),
      /^Bugs checked per day 5 30 days · by the day of the first check understood not understood not a WebUI bug error/,
    )
    assert.match(
      chart,
      /<ul class="legend"><li><i style="background:var\(--chart-ok\)"><\/i>understood<\/li><li><i style="background:var\(--chart-count\)"><\/i>not understood<\/li><li><i style="background:var\(--chart-none\)"><\/i>not a WebUI bug<\/li><li><i style="background:var\(--chart-bad\)"><\/i>error<\/li><\/ul>/,
    )
    assert.match(
      chart,
      /<div class="plot" tabindex="0" aria-label="Bugs checked per day: 5 in 30 days"><svg width="100%" height="180" role="img"/,
    )
    assert.equal((chart.match(/<rect class="hit"/g) ?? []).length, 30)
    assert.equal((chart.match(/<svg class="col"/g) ?? []).length, 5, 'a column where a day has a check')
    assert.equal((chart.match(/<path /g) ?? []).length, 5)
    assert.match(
      chart,
      /<g class="grid"><line x1="0" x2="100%" y1="158" y2="158"\/><text x="-8" y="162" text-anchor="end">0<\/text><line [^>]*\/><text [^>]*>1<\/text><\/g>/,
      'a scale of one',
    )
    // Today's column, the last: one bug not understood, the full height, its top rounded; its hit says so.
    assert.match(
      chart,
      /<svg class="col" x="98.333%" width="1" height="180" overflow="visible"><path d="M-9.3,158 V12 Q-9.3,8 -5.3,8 H5.3 Q9.3,8 9.3,12 V158 Z" fill="var\(--chart-count\)"\/><\/svg>/,
    )
    assert.match(
      chart,
      /<rect class="hit" x="96.667%" y="0" width="3.333%" height="180" data-when="\w\w\w \d\d \w\w\w" data-total="1" data-values="0,1,0,0"\/>/,
    )
    assert.match(
      chart,
      /<g class="dates">(<text x="[\d.]+%" y="174" text-anchor="middle">\d+ \w\w\w<\/text>){15}<\/g>/,
      'a date every other day',
    )
    assert.doesNotMatch(columnChart(checksPerDay([], state.now, 7)), /<path/)
    assert.match(columnChart(checksPerDay([], state.now, 7)), /(<rect class="hit"[^>]*>){7}/)
  })
  it('the all-time chart spans the days since the first check', () => {
    assert.equal((section(statsPage(bugs, 'all', ctx), 'chart').match(/<rect class="hit"/g) ?? []).length, 11)
    assert.equal((section(statsPage(bugs, 'today', ctx), 'chart').match(/<rect class="hit"/g) ?? []).length, 1)
  })
})

describe('one bug', () => {
  it('shows the facts, the field checks, the related bugs, the history and the comment', () => {
    const html = bugPage(bugModel('KAZ-2'), ctx)
    const page = text(html)
    assert.match(page, /KAZ-2 Ports table is empty after clearing the filter/)
    assert.match(
      page,
      /Reporter A Tester Result comment · dry run Checked \d{4}-\d\d-\d\d \d\d:\d\d Checks 3 · first \d{4}-\d\d-\d\d \d\d:\d\d Related KAZ-1 Jira https:\/\/jira.example.com\/browse\/KAZ-2/,
    )
    assert.match(html, /<dd><a class="pill slate" href="\/bugs\/KAZ-1">KAZ-1<\/a><\/dd>/)
    assert.match(html, /href="https:\/\/jira.example.com\/browse\/KAZ-2"/)
    assert.match(html, /<table class="wide requirements">/)
    assert.match(page, /Field checks R1 Steps to reproduce ✓ detail of R1 .* R6 HAR file ✗ detail of R6/)
    assert.doesNotMatch(page, /R7 Project/, 'no field check for R7')
    assert.match(html, /<table class="wide history">/)
    assert.match(
      page,
      /first check not understood · abc123def456 · table\.png \(image\) · \$0\.03 reasoning Looked at Ports\.vue: .* comment .* re-check VerdictError: not_understood without a comment .* re-check not understood · abc123def456 · \$0\.03 reasoning The answer names the page; .* comment/,
    )
    assert.match(
      page,
      /Reasoning The answer names the page; the request is still missing\. History/,
      "the latest finished check's reasoning",
    )
    assert.match(
      html,
      /<details><summary>reasoning<\/summary><p class="reasoning">Looked at Ports\.vue: the filter is cleared, but the request that fills the table is not in the report\.<\/p><\/details>/,
    )
    assert.match(
      page,
      /Comment dry run · not posted @A Tester Which page shows the table\? Please attach a HAR of the page load\. Possibly related: KAZ-1 — the same empty table/,
    )
    assert.match(html, /<p><s>Which page shows the table\?<\/s><\/p><p>Please attach a HAR/)
    assert.match(
      html,
      /<div class="actions"><a class="btn primary" href="\/bugs\/KAZ-2\?post" data-dialog="confirm-post">Post to Jira<\/a><form class="request" method="post" action="\/requests"><input type="hidden" name="key" value="KAZ-2"><button class="btn">Check again<\/button><\/form><\/div>/,
      'posting is the one thing to press; the check is plain',
    )
    assert.doesNotMatch(page, /Request /)
    assert.doesNotMatch(html, /class="reason"/)
  })
  it('shows the check asked for: pending, failed, or for a bug not checked yet', () => {
    const pending = bugPage(bugModel('KAZ-1'), ctx)
    assert.match(text(pending), /Request waiting · 2m 00s ago/)
    assert.doesNotMatch(pending, /name="key" value="KAZ-1"/, 'already asked: no button')
    const unknown = bugPage(bugModel('KAZ-77'), ctx)
    assert.match(text(unknown), /KAZ-77 Request failed · JiraError: HTTP 404 on GET \/issue\/KAZ-77 Jira .* Not checked yet\./)
    assert.match(unknown, /<input type="hidden" name="key" value="KAZ-77"><button class="btn primary">Check<\/button>/)
    assert.match(unknown, /<p class="empty">Not checked yet\./)
    assert.doesNotMatch(unknown, /Requirements/)
  })
  it('offers to post a comment Jira does not have, behind a confirmation that names the check read', () => {
    const html = bugPage(bugModel('KAZ-2'), ctx)
    assert.match(html, /<\/div><dialog id="confirm-post" class="frame confirm" aria-labelledby="confirm-post-title">/, 'after the actions')
    const dialog = html.slice(html.indexOf('<dialog'), html.indexOf('</dialog>'))
    assert.match(
      dialog,
      /<div class="frame-head"><h2 id="confirm-post-title">Post this comment to KAZ-2\?<\/h2><span class="note">checked /,
    )
    assert.match(
      text(dialog),
      /Post this comment to KAZ-2\? checked .* mentions A Tester: Jira notifies them\. .* dry run: this one comment is posted all the same.* @A Tester Which page shows the table\? Please attach a HAR of the page load\. Possibly related: KAZ-1 — the same empty table Post Cancel/,
    )
    assert.match(
      dialog,
      new RegExp(
        `<form method="post" action="/posts"><input type="hidden" name="key" value="KAZ-2"><input type="hidden" name="checked" value="${readBug(state.dbFile, 'KAZ-2')!.checkedAt.toISOString()}"><button class="btn primary">Post</button><a class="btn" href="/bugs/KAZ-2" data-close>Cancel</a>`,
      ),
    )
    assert.doesNotMatch(text(bugPage(bugModel('KAZ-2'), { ...ctx, dryRun: false })), /dry run: this one/)
    assert.match(bugPage({ ...bugModel('KAZ-2'), confirmPost: true }, ctx), /<dialog [^>]* open>/, 'open without JavaScript')

    const pending = bugPage({ ...bugModel('KAZ-2'), post: { key: 'KAZ-2', at: state.now, error: null } }, ctx)
    assert.match(text(pending), /Post waiting · just now/)
    assert.doesNotMatch(pending, /Post to Jira|<dialog/, 'already asked: no button')
    assert.match(pending, /<button class="btn primary">Check again<\/button>/, 'the check is the one thing left to press')
    const failed = bugPage({ ...bugModel('KAZ-2'), post: { key: 'KAZ-2', at: state.now, error: 'Error: the comment changed' } }, ctx)
    assert.match(text(failed), /Post failed · Error: the comment changed/)
    assert.match(failed, /Post to Jira/, 'asked again after a failure')
    for (const key of ['KAZ-3', 'RPG-4', 'RPG-6', 'KAZ-1'])
      assert.doesNotMatch(bugPage(bugModel(key), ctx), /Post to Jira/, `${key} has no comment to post`)
    const posted = { ...readBug(state.dbFile, 'KAZ-2')!, status: 'commented' as const, commentId: '7' }
    assert.doesNotMatch(bugPage({ key: 'KAZ-2', bug: posted, request: null }, ctx), /Post to Jira/, 'already in Jira')
  })
  it("explains a failed, a skipped, an understood and a not-the-WebUI's bug, and marks a check by the list", () => {
    const failedHtml = bugPage(bugModel('RPG-4'), ctx)
    const failed = text(failedHtml)
    assert.match(failedHtml, /<div class="reason bad"><span class="label">Failed<\/span><span>Error: agent run timed out<\/span><\/div>/)
    assert.match(failed, /Result check failed .* Failed Error: agent run timed out/)
    assert.match(failedHtml, /<p class="empty">The check did not finish\.<\/p>/)
    assert.match(failedHtml, /<p class="empty">No comment: the check did not finish\.<\/p>/)
    const skipped = text(bugPage(bugModel('KAZ-1'), ctx))
    assert.match(skipped, /Never checked\./)
    assert.match(skipped, /Skipped: the bug was already in Created/)
    const understood = text(bugPage(bugModel('KAZ-3'), ctx))
    assert.match(understood, /Result understood/)
    assert.match(understood, /The agent found the cause and understood the report: no comment\./)
    assert.match(understood, /Checks 1 /, 'one check is said, not left blank')
    assert.doesNotMatch(understood, /Related|Checks \d · first/)
    const notWebuiHtml = bugPage(bugModel('RPG-6'), ctx)
    const notWebui = text(notWebuiHtml)
    assert.match(
      notWebuiHtml,
      /<div class="reason"><span class="label">Not a WebUI bug<\/span><span>The UI shows the counter ConfD returns\.<\/span><\/div>/,
    )
    assert.match(notWebui, /History .* first check not a WebUI bug · The UI shows the counter ConfD returns\. · abc123def456/)
    assert.match(notWebui, /Not a WebUI bug, so no comment; a person decides where it goes\./)
    assert.match(text(bugPage(bugModel('KAZ-5'), ctx)), /first check not understood · list check · abc123def456/)
    // A post interrupted between Jira and the record, and a re-check that failed on a commented bug.
    const kaz2 = readBug(state.dbFile, 'KAZ-2')!
    const posting = bugPage({ key: 'KAZ-2', bug: { ...kaz2, status: 'posting', error: 'ECONNRESET' }, request: null }, ctx)
    assert.match(
      posting,
      /<div class="reason bad"><span class="label">Interrupted<\/span><span>The post of this comment got no answer: ECONNRESET\. The next check/,
    )
    assert.match(posting, /Post to Jira/)
    const recheckFailed = bugPage({ key: 'KAZ-2', bug: { ...kaz2, error: 'Error: timed out' }, request: null }, ctx)
    assert.match(recheckFailed, /<div class="reason bad"><span class="label">Re-check failed<\/span><span>Error: timed out<\/span><\/div>/)
  })
  it('renders the comment as Jira shows it', () => {
    assert.equal(
      commentHtml('[~accountid:1]\nPlease add:\n- Steps to reproduce\n- -HAR file-\n\nSee KAZ-1 <x>', 'A Tester'),
      '<p>@A Tester</p><p>Please add:</p><ul><li>Steps to reproduce</li><li><s>HAR file</s></li></ul><p>See KAZ-1 &lt;x&gt;</p>',
    )
    assert.equal(commentHtml('[~accountid:1] hi', null), '<p>@reporter hi</p>')
    assert.equal(commentHtml('[~accountid:1]\n-Which page?-\nStill open?', 'A'), '<p>@A</p><p><s>Which page?</s></p><p>Still open?</p>')
  })
  it('labels every status', () => {
    const labels = bugs.map(resultLabel)
    assert.deepEqual(labels, ['comment · dry run', 'check failed', 'understood', 'not a WebUI bug', 'comment · dry run', 'skipped'])
    const retry = { ...bugs[1]!, status: 'retry' as const, attempts: 1 }
    assert.equal(resultLabel(retry), 'retrying · 1 of 3 failed')
    assert.equal(resultLabel({ ...retry, status: 'posting' }), 'interrupted while posting')
    assert.equal(resultLabel({ ...retry, status: 'commented' }), 'commented')
  })
})
