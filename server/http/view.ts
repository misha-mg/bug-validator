/** The pages, as pure functions of what was read: a model in, an HTML string out. */

import { MAX_ATTEMPTS } from '../config.ts'
import { OUTCOMES, REQUIREMENTS, type Outcome } from '../domain/bug.ts'
import { ISSUE_KEY } from '../domain/key.ts'
import { cut, fmtAgo, fmtClock, fmtDate, fmtDay, fmtDuration, fmtShare, fmtTime, plural } from '../format.ts'
import { type BugView, type Heartbeat, type Request, type Result, type Run, checked, result } from './read.ts'
import { type LogEvent, type ServiceStatus, alive, liveness } from './service-log.ts'
import { type Day, checksPerDay, fieldChecksPassedAfterComment, gaps, needsAttention, periodStats, startOfDay } from './stats.ts'

const CHART_DAYS = 30
const WEEK_MS = 7 * 24 * 60 * 60 * 1000
const SUMMARY_WIDTH = 80
const ERROR_WIDTH = 120
const MENTION = /\[~accountid:[^\]]*\]/g

/** What every page needs besides its own model. */
export interface PageContext {
  jiraBaseUrl: string
  /** The service's mode from its log; null when the log does not say. */
  dryRun: boolean | null
  now: Date
  /** The host the page was asked from, for the masthead. */
  host?: string | undefined
}

const esc = (value: unknown): string =>
  String(value).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] ?? c)

// ---- Layout

/** The pages the masthead lists; a bug's page is under Bugs. */
export type Section = 'home' | 'bugs'

function layout(title: string, main: string, ctx: PageContext, section: Section | null = null): string {
  const nav = (s: Section, href: string, name: string): string =>
    `<a class="btn${s === section ? ' active' : ''}" href="${href}">${name}</a>`
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title>
<link rel="stylesheet" href="/sheet.css">
<link rel="stylesheet" href="/app.css">
<script src="/theme.js"></script>
</head>
<body>
<header class="masthead">
<a class="brand" href="/">Bug validator</a>
<span class="divider"></span>
<span class="where">console${ctx.host ? ` · ${esc(ctx.host)}` : ''}</span>
${modePill(ctx.dryRun)}
<span class="spacer"></span>
<form class="request" method="post" action="/requests"><input class="field" name="key" placeholder="KAZ-1234 or a link" required aria-label="Bug to check"><button class="btn">Check</button></form>
<nav>${nav('home', '/', 'Home')}${nav('bugs', '/bugs', 'Bugs')}</nav>
<button class="btn theme" type="button" aria-label="Switch between light and dark"></button>
</header>
<main class="sheet">
${main}
</main>
<script src="/app.js"></script>
</body>
</html>
`
}

export function errorPage(status: number, message: string, ctx: PageContext): string {
  return layout(`${status} · Bug validator`, `<section class="frame"><h2>${status}</h2><p>${esc(message)}</p></section>`, ctx)
}

// ---- Home

export interface HomeModel {
  bugs: BugView[]
  status: ServiceStatus | null
  logPath: string
  /** The latest events, oldest first, as the log keeps them. */
  recent: LogEvent[]
  requests: Request[]
  /** The service's heartbeat from the database; null when it never wrote one. */
  heartbeat: Heartbeat | null
}

export function homePage(m: HomeModel, ctx: PageContext): string {
  const found = gaps(m.bugs)
  const total = found[0]?.share.total ?? 0
  const attention = needsAttention(m.bugs)
  const main = `
<div class="home">
<section class="cards">${tiles(m.bugs, ctx.now)}</section>
<section class="frame service">${frameHead('Service')}${kv(serviceRows(m, ctx.now))}</section>
<section class="frame statistics">${frameHead('Bugs checked per day', `${CHART_DAYS} days`)}
<figure class="chart">${dayChart(checksPerDay(m.bugs, ctx.now, CHART_DAYS))}
<div class="legend">${OUTCOMES.map((o) => `<span class="sw ${o}"></span>${OUTCOME_TEXT[o]} `).join('')}<span class="sw error"></span>error</div></figure></section>
<section class="frame problems">${frameHead('Field checks failed most often', total ? `first checks of ${plural(total, 'bug')} · all time` : '')}
${total ? gapsTable(found) : '<p class="muted">No bug has been checked yet.</p>'}</section>
<section class="frame attention">${frameHead('Needs attention', "failed checks, bugs not the WebUI's")}
${attention.length ? attentionTable(attention) : '<p class="muted">Nothing to look at.</p>'}</section>
<section class="frame activity">${frameHead('Activity', 'the latest events of the log')}
${m.recent.length ? activityTable(m.recent) : '<p class="muted">Nothing logged yet.</p>'}</section>
</div>`
  return layout('Bug validator', main, ctx, 'home')
}

function serviceRows(m: HomeModel, now: Date): [string, string][] {
  const rows: [string, string][] = []
  const s = m.status
  if (!s) {
    rows.push(['State', `<span class="muted">no log at ${esc(m.logPath)}</span>`])
  } else {
    const state = liveness(s, now, m.heartbeat)
    if (state === 'running') rows.push(['State', '<span class="ok">running</span>'])
    else if (state === 'stopping') rows.push(['State', '<span class="warn">stopping</span>'])
    else if (state === 'stopped')
      rows.push(['State', `<span class="warn">stopped${s.lastSeen ? ` · ${fmtAgo(s.lastSeen, now)}` : ''}</span>`])
    else if (state === 'crashed') {
      rows.push(['State', `<span class="err">crashed${s.lastSeen ? ` · ${fmtAgo(s.lastSeen, now)}` : ''}</span>`])
      rows.push(['Error', `<span class="err">${errorText(s.crashed)}</span>`])
    } else
      rows.push([
        'State',
        `<span class="err">silent${s.lastSeen ? ` · ${fmtDuration((now.getTime() - s.lastSeen.getTime()) / 1000)}` : ''}</span>`,
      ])
    rows.push(['Heartbeat', heartbeatText(m.heartbeat, now)])
    if (s.pollError) {
      rows.push([
        'Last poll',
        `<span class="err">failed${s.pollFailures > 1 ? ` ${s.pollFailures} times in a row` : ''} · ${fmtAgo(s.lastPoll ?? now, now)}</span>`,
      ])
      rows.push(['Error', `<span class="err">${errorText(s.pollError)}</span>`])
    } else if (s.lastPoll) rows.push(['Last poll', fmtAgo(s.lastPoll, now)])
    else rows.push(['Last poll', '<span class="muted">none yet</span>'])
    if (s.dryRun !== null) rows.push(['Mode', modePill(s.dryRun)])
    if (s.inQuery !== null && !s.pollError) rows.push(['In Created', `${s.inQuery}${s.waiting ? ` · ${s.waiting} waiting` : ''}`])
    if (s.started) rows.push(['Started', fmtTime(s.started)])
    if (s.model) rows.push(['Model', esc(s.model)])
    if (s.claudeVersion) rows.push(['Claude', esc(s.claudeVersion)])
    if (s.webuiCommit) rows.push(['WebUI', `<code>${esc(s.webuiCommit.slice(0, 12))}</code> · master`])
    if (s.pollIntervalMs) rows.push(['Poll every', fmtDuration(s.pollIntervalMs / 1000)])
    if (s.checking)
      rows.push(['Checking', `${bugLink(s.checking.key)} · ${fmtDuration((now.getTime() - s.checking.since.getTime()) / 1000)}`])
  }
  // The checks asked for and not yet made; a failed request shows on its bug's page and in the log.
  const pending = m.requests.filter((r) => !r.error)
  if (pending.length) rows.push(['Requested', pending.map((r) => `${bugLink(r.key)} · ${fmtAgo(r.at, now)}`).join('<br>')])
  const skipped = m.bugs.filter((b) => result(b) === 'skipped')
  if (skipped.length) {
    // Bugs already in Created at the first start, never checked.
    const first = new Date(Math.min(...skipped.map((b) => b.checkedAt.getTime())))
    rows.push(['Skipped', `${skipped.length} · ${fmtDate(first)}`])
  }
  if (!m.bugs.length) rows.push(['Database', '<span class="muted">none yet</span>'])
  return rows
}

/** The heartbeat's age and the pid that wrote it; a stale one in rust, none in grey. */
function heartbeatText(h: Heartbeat | null, now: Date): string {
  if (!h) return '<span class="muted">none yet</span>'
  const text = `${fmtAgo(h.seenAt, now)} · pid ${h.pid} · started ${fmtTime(h.startedAt)}`
  return alive(h, now) ? text : `<span class="err">${text}</span>`
}

/** Bugs checked today, in 7 days and all time, by outcome and with the agent's cost; and what arrived after a comment. */
function tiles(bugs: BugView[], now: Date): string {
  const periods = [
    ['Checked today', periodStats(bugs, startOfDay(now))],
    ['Checked in 7 days', periodStats(bugs, new Date(now.getTime() - WEEK_MS))],
    ['Checked all time', periodStats(bugs)],
  ] as const
  const tile = (label: string, value: string, note: string): string =>
    `<div class="frame card"><div class="label">${label}</div><div class="value">${value}</div><div class="note">${note}</div></div>`
  const added = fieldChecksPassedAfterComment(bugs)
  return (
    periods
      .map(([label, s]) => {
        const failed = s.errors ? ` · <span class="err">${s.errors} failed</span>` : ''
        const cost = s.costUsd ? ` · $${s.costUsd.toFixed(2)}` : ''
        const outcomes = OUTCOMES.filter((o) => s.byOutcome[o].count)
          .map((o) => `${fmtShare(s.byOutcome[o].count, s.byOutcome[o].total)} ${OUTCOME_TEXT[o]}`)
          .join(' · ')
        return tile(label, String(s.checked), s.checked ? `${outcomes}${failed}${cost}` : `no checks${failed}`)
      })
      .join('') +
    tile(
      'Field checks passed after the comment',
      added.total ? `${added.count} <small>of ${added.total}</small>` : '–',
      're-checked bugs, all time',
    )
  )
}

function gapsTable(found: ReturnType<typeof gaps>): string {
  const top = Math.max(...found.map((p) => p.share.count))
  return `<table class="problems"><tbody>${found
    .map((p) => {
      const n = p.share.count
      const width = n ? Math.max(Math.round((n * 100) / top), 4) : 0
      return `<tr class="${n ? '' : 'dim'}"><th>${p.id}</th><td>${esc(p.name)}</td><td class="bar"><div style="width:${width}%"></div></td><td class="num">${fmtShare(p.share.count, p.share.total)}</td></tr>`
    })
    .join('')}</tbody></table>`
}

function attentionTable(bugs: BugView[]): string {
  return `<table class="list"><thead><tr><th>Bug</th><th>Last check</th><th>What</th><th>Why</th></tr></thead><tbody>${bugs
    .map((b) => {
      // A bug not the WebUI's waits for a person's decision; its reason is the agent's.
      if (result(b) === 'not_webui' && b.error === null)
        return `<tr><td>${bugLink(b.key)}</td><td class="time">${fmtTime(b.checkedAt)}</td><td>not a WebUI bug</td><td>${esc(b.reason)}</td></tr>`
      // A failed re-check leaves the bug's result as it was: its comment stands, only the error is new.
      const attempts =
        result(b) !== 'error'
          ? 're-check failed'
          : b.status === 'posting'
            ? 'post'
            : `${b.attempts} of ${MAX_ATTEMPTS} failed${b.status === 'failed' ? ', gave up' : ''}`
      const error =
        b.status === 'posting'
          ? `interrupted while posting · the next check looks in Jira${b.error ? ` · ${b.error}` : ''}`
          : (b.error ?? '')
      return `<tr><td>${bugLink(b.key)}</td><td class="time">${fmtTime(b.checkedAt)}</td><td>${attempts}</td><td class="err">${esc(error)}</td></tr>`
    })
    .join('')}</tbody></table>`
}

function activityTable(recent: LogEvent[]): string {
  return `<table class="list activity"><tbody>${[...recent]
    .reverse()
    .map((e) => {
      const key = typeof e.fields.key === 'string' ? e.fields.key : null
      const cls = e.level === 'error' ? 'err' : e.level === 'warn' ? 'warn' : ''
      return `<tr><td class="time">${fmtTime(e.ts)}</td><td>${key ? bugLink(key) : ''}</td><td class="${cls}">${eventText(e)}</td></tr>`
    })
    .join('')}</tbody></table>`
}

/** One line per event, escaped. */
export function eventText(e: LogEvent): string {
  const f = e.fields
  const re = f.recheck === true
  const by = f.requested === true ? 'requested · ' : ''
  switch (e.event) {
    case 'service_start':
      return esc(
        ['service started', f.dryRun === true ? 'dry run' : f.dryRun === false ? 'live' : null, f.model].filter(Boolean).join(' · '),
      )
    case 'service_stopping':
      return esc(`stopping · ${f.signal ?? ''}`)
    case 'service_stopped':
      return 'service stopped'
    case 'first_start': {
      const n = Array.isArray(f.skipped) ? f.skipped.length : 0
      return esc(`first start · ${n} ${n === 1 ? 'bug' : 'bugs'} already in Created skipped`)
    }
    case 'poll_failed':
      return `poll failed · ${errorText(f.error)}`
    case 'check_deferred':
      return `check put off · ${errorText(f.error)}`
    case 'request_failed':
      return `request failed${f.gaveUp === true ? ', gave up' : ''} · ${errorText(f.error)}`
    case 'comment_adopted':
      return esc(`found the service's comment in Jira (${f.commentId}); keeps it, posts none`)
    case 'key_changed':
      return esc(`moved: ${f.from} → ${f.to}`)
    case 'webui_fetched':
      return esc(`WebUI master moved: ${f.from} → ${f.to}`)
    case 'bug_understood':
      return esc(`${by}${re ? 're-check: ' : ''}understood, no comment${f.kept === true ? ', the posted one kept' : ''}`)
    case 'bug_not_webui':
      return esc(`${by}${re ? 're-check: ' : ''}not a WebUI bug${typeof f.reason === 'string' && f.reason ? ` · ${f.reason}` : ''}`)
    case 'comment_dry_run':
      return esc(`${by}${re ? 're-check: ' : ''}not understood · comment · dry run${f.kept === true ? ', the posted one kept' : ''}`)
    case 'comment_posted':
      return esc(f.byHand === true ? 'comment posted by hand' : `${by}not understood · comment posted`)
    case 'post_failed':
      return `post failed${f.gaveUp === true ? ', gave up' : ''} · ${errorText(f.error)}`
    case 'comment_edited':
      return esc(`${by}${f.changed === false ? 're-check: comment unchanged' : 'not understood · comment edited'}`)
    case 'check_failed':
      return `${by}${re ? 're-check' : 'check'} failed${f.attempts ? ` · attempt ${esc(f.attempts)}` : ''} · ${errorText(f.error)}`
    case 'mentions_stripped':
      return esc(`mentions stripped: ${Array.isArray(f.stripped) ? f.stripped.join(', ') : ''}`)
    case 'fatal':
      return `fatal · ${errorText(f.error)}`
    default:
      return esc(e.event)
  }
}

// ---- Bugs

/** An outcome in words, as the pages name it. */
const OUTCOME_TEXT: Record<Outcome, string> = { understood: 'understood', not_understood: 'not understood', not_webui: 'not a WebUI bug' }

export type Filter = 'all' | Result
const FILTERS: Record<Filter, string> = { all: 'all', ...OUTCOME_TEXT, error: 'error', skipped: 'skipped' }

export interface BugsQuery {
  result: Filter
  q: string
}

export function bugsQuery(params: URLSearchParams): BugsQuery {
  const result = params.get('result') ?? 'all'
  return { result: Object.hasOwn(FILTERS, result) ? (result as Filter) : 'all', q: (params.get('q') ?? '').trim() }
}

export function filterBugs(bugs: BugView[], query: BugsQuery): BugView[] {
  const q = query.q.toLowerCase()
  return bugs.filter(
    (b) =>
      (query.result === 'all' || result(b) === query.result) &&
      (!q || [b.key, b.summary ?? '', b.reporter ?? ''].join(' ').toLowerCase().includes(q)),
  )
}

export function bugsPage(all: BugView[], query: BugsQuery, ctx: PageContext): string {
  const bugs = filterBugs(all, query)
  const narrowed = [query.result !== 'all' ? FILTERS[query.result] : null, query.q ? `“${query.q}”` : null].filter(Boolean)
  const chips = (Object.keys(FILTERS) as Filter[])
    .map(
      (f) =>
        `<a class="chip${f === query.result ? ' on' : ''}" href="/bugs?${new URLSearchParams({ result: f, q: query.q })}">${FILTERS[f]}</a>`,
    )
    .join('')
  let rows = ''
  let day = ''
  for (const b of bugs) {
    // Bugs come latest first, so a day's checks sit together under one day row.
    const d = fmtDay(b.checkedAt)
    if (d !== day) {
      day = d
      rows += `<tr class="day"><th class="label" colspan="7">${d}</th></tr>`
    }
    rows += `<tr><td>${bugLink(b.key)} ${jiraLink(b.key, ctx)}</td><td class="summary"><a href="/bugs/${esc(b.key)}" title="${esc(b.summary ?? '')}">${esc(cut(b.summary ?? '', SUMMARY_WIDTH))}</a></td><td class="time">${fmtClock(b.checkedAt)}</td><td>${resultPill(b)}</td><td>${absentChips(b)}</td><td class="num">${b.related.length || ''}</td><td class="num">${b.history.length > 1 ? b.history.length : ''}</td></tr>`
  }
  const main = `
<div class="page-head"><h1>All bugs${narrowed.map((n) => ` · ${esc(n)}`).join('')}</h1><span class="stats">${plural(bugs.length, 'bug')}</span></div>
<form class="toolbar" method="get" action="/bugs">
<nav class="chips">${chips}</nav>
<input type="hidden" name="result" value="${query.result}">
<input class="field" type="search" name="q" value="${esc(query.q)}" placeholder="Search a bug, its summary or reporter">
</form>
${bugs.length ? `<table class="list bugs"><thead><tr><th>Bug</th><th>Summary</th><th>Checked</th><th>Result</th><th>Absent</th><th class="num">Related</th><th class="num">Checks</th></tr></thead><tbody>${rows}</tbody></table>` : '<p class="muted">No bug matches.</p>'}`
  return layout(`Bugs · Bug validator`, main, ctx, 'bugs')
}

/** The field checks the first check found failed: what the report lacked as it arrived. */
const absentChips = (b: BugView): string =>
  (b.history.find((run) => run.error === null)?.fieldChecks ?? b.fieldChecks)
    .filter((c) => !c.passed)
    .map((c) => `<span class="req" title="${esc(REQUIREMENTS[c.id])}">${esc(c.id)}</span>`)
    .join(' ')

// ---- One bug

const SKIPPED = 'Skipped: the bug was already in Created when the service first started, so it was never checked.'

/** A bug's row, if it has one, and the check asked for it, if any. One of the two exists. */
export interface BugModel {
  key: string
  bug: BugView | null
  request: Request | null
  /** The post of its comment asked for, if any. */
  post?: Request | null
  /** The confirmation of a post shown open: the page without JavaScript (`?post`). */
  confirmPost?: boolean
}

/** A comment the service recorded and Jira does not have: a dry run's, or one whose post got no answer. */
const postable = (b: BugView): boolean => b.comment !== null && b.commentId === null && (b.status === 'dry_run' || b.status === 'posting')

export function bugPage(m: BugModel, ctx: PageContext): string {
  const { key, bug: b, request, post = null } = m
  const rows: [string, string][] = []
  if (b?.reporter) rows.push(['Reporter', esc(b.reporter)])
  if (b) {
    rows.push(['Result', resultPill(b)])
    if (result(b) === 'not_webui') rows.push(['Why', esc(b.reason)])
    rows.push(['Checked', fmtTime(b.checkedAt)])
    if (b.history.length > 1) rows.push(['Checks', `${b.history.length} · first ${fmtTime(b.history[0]!.at)}`])
    if (b.error) rows.push(['Error', `<span class="err">${esc(b.error)}</span>`])
  }
  if (request)
    rows.push([
      'Request',
      request.error ? `<span class="err">failed · ${esc(request.error)}</span>` : `waiting · ${fmtAgo(request.at, ctx.now)}`,
    ])
  if (post)
    rows.push(['Post', post.error ? `<span class="err">failed · ${esc(post.error)}</span>` : `waiting · ${fmtAgo(post.at, ctx.now)}`])
  rows.push(['Jira', jiraLink(key, ctx, esc(`${ctx.jiraBaseUrl}/browse/${key}`))])
  // A pending request is enough; otherwise one click asks for the next check.
  const check =
    request && !request.error
      ? ''
      : `<form class="request" method="post" action="/requests"><input type="hidden" name="key" value="${key}"><button class="btn primary">${b ? 'Check again' : 'Check'}</button></form>`
  // Posting asks first: the confirmation shows the comment as it will reach Jira.
  const posting =
    b && postable(b) && !(post && !post.error)
      ? `<a class="btn" href="/bugs/${key}?post" data-dialog="confirm-post">Post to Jira</a>${confirmPost(b, m.confirmPost === true, ctx)}`
      : ''
  const actions = check || posting ? `<div class="actions">${check}${posting}</div>` : ''
  const head = `<header class="bug-head"><div class="page-head"><h1>${esc(key)}</h1><span class="stats">${esc(b?.summary ?? '')}</span></div>${kv(rows)}${actions}</header>`
  if (!b)
    return layout(
      `${key} · Bug validator`,
      `${head}<p class="muted">Not checked yet. The page fills in when the service has checked the bug.</p>`,
      ctx,
      'bugs',
    )
  const subtitle =
    { dry_run: 'dry run · not posted', commented: 'posted to Jira', posting: 'interrupted while posting · the next check looks in Jira' }[
      b.status as string
    ] ?? ''
  const main = `
${head}
<div class="columns">
<section class="frame">${frameHead('Checks')}${checks(b, ctx)}</section>
<section class="frame comment">${frameHead('Comment', subtitle)}${commentBlock(b)}</section>
</div>`
  return layout(`${key} · Bug validator`, main, ctx, 'bugs')
}

/**
 * The confirmation of a post: the comment as Jira will show it, and what posting means. The form
 * carries the check the person read, so a re-check made meanwhile refuses the post (store.ts).
 * A modal opened by app.js; without JavaScript the Post link opens the page with it open.
 */
function confirmPost(b: BugView, open: boolean, ctx: PageContext): string {
  const dry =
    ctx.dryRun === false
      ? ''
      : ' The service is in a dry run: this one comment is posted all the same, and re-checks in the dry run leave it as it is.'
  return `<dialog id="confirm-post" class="frame confirm" aria-labelledby="confirm-post-title"${open ? ' open' : ''}>
${frameHead(`<span id="confirm-post-title">Post this comment to ${esc(b.key)}?</span>`, `checked ${fmtTime(b.checkedAt)}`)}
<p>It goes to Jira as it is, from the service's account, and mentions ${esc(b.reporter ?? 'the reporter')}: Jira notifies them. The UI cannot take it back.${dry}</p>
<div class="jira-comment">${commentHtml(b.comment ?? '', b.reporter)}</div>
<form method="post" action="/posts"><input type="hidden" name="key" value="${b.key}"><input type="hidden" name="checked" value="${b.checkedAt.toISOString()}"><button class="btn primary">Post</button><a class="btn" href="/bugs/${b.key}" data-close>Cancel</a></form>
</dialog>`
}

/** The field checks, the related bugs, and every check of the bug with what it read and found. */
function checks(b: BugView, ctx: PageContext): string {
  if (!checked(b) && b.status !== 'posting')
    return `<p class="muted">${result(b) === 'error' ? 'The check did not finish.' : 'Never checked.'}</p>`
  // The field checks are hints the agent got, not the verdict: steps without a heading are still steps.
  let html = `<h3>Field checks</h3><table class="requirements"><tbody>${b.fieldChecks
    .map(
      (c) =>
        `<tr><th>${c.id}</th><td>${esc(REQUIREMENTS[c.id])}</td><td><span class="${c.passed ? 'ok' : 'err'}">${c.passed ? '✓' : '✗'}</span> <span class="muted">${esc(c.detail)}</span></td></tr>`,
    )
    .join('')}</tbody></table>`
  if (b.related.length) html += `<h3>Related bugs</h3><p>${b.related.map((k) => jiraLink(k, ctx, esc(k))).join(', ')}</p>`
  if (b.history.length) {
    // Every check of the bug, oldest first: its outcome, what the agent read, and the comment it wrote.
    html += `<h3>History</h3><table class="history"><tbody>${b.history.map((run, i) => `<tr><td class="time">${fmtTime(run.at)}</td><td class="muted">${i === 0 ? 'first check' : 're-check'}</td><td>${runText(run, b.reporter)}</td></tr>`).join('')}</tbody></table>`
  }
  return html
}

/** One check of the history: its outcome or error, the commit and the files it read, its comment. */
function runText(run: Run, reporter: string | null): string {
  if (run.error) return `<span class="err">${esc(run.error)}</span>`
  const parts = [run.outcome ? OUTCOME_TEXT[run.outcome] : 'no outcome']
  if (run.version < 2) parts.push('list check')
  if (run.reason) parts.push(esc(run.reason))
  if (run.webuiCommit) parts.push(`<code>${esc(run.webuiCommit.slice(0, 12))}</code>`)
  if (run.files.length)
    parts.push(run.files.map((f) => `${esc(f.filename)} (${f.kind === 'unread' ? `not read: ${esc(f.note)}` : esc(f.kind)})`).join(', '))
  if (run.costUsd) parts.push(`$${run.costUsd.toFixed(2)}`)
  const comment = run.comment
    ? `<details><summary>comment</summary><div class="jira-comment">${commentHtml(run.comment, reporter)}</div></details>`
    : ''
  return `<span class="muted">${parts.join(' · ')}</span>${comment}`
}

function commentBlock(b: BugView): string {
  if (result(b) === 'skipped') return `<p class="muted">${SKIPPED}</p>`
  if (b.status === 'posting')
    return `<p class="warn">The post of this comment got no answer. Its next check of the bug (live, at the next poll) or a post asked again looks in Jira first: a comment found there is kept, never posted twice.</p><div class="jira-comment">${commentHtml(b.comment ?? '', b.reporter)}</div>`
  if (result(b) === 'error') return '<p class="muted">No comment: the check did not finish.</p>'
  if (result(b) === 'understood')
    return `<p class="muted">The agent found the cause and understood the report: no comment.</p>${b.comment ? `<div class="jira-comment">${commentHtml(b.comment, b.reporter)}</div>` : ''}`
  if (result(b) === 'not_webui')
    return `<p class="muted">Not a WebUI bug, so no comment; a person decides where it goes.</p>${b.comment ? `<div class="jira-comment">${commentHtml(b.comment, b.reporter)}</div>` : ''}`
  if (!b.comment) return '<p class="muted">No comment recorded.</p>'
  return `<div class="jira-comment">${commentHtml(b.comment, b.reporter)}</div>`
}

/**
 * The comment as Jira shows it: the mention by name, `- item` lines as a list, a line or an item
 * `-struck-` struck through. Nothing more of Jira's markup: the comments are short questions.
 */
export function commentHtml(comment: string, reporter: string | null): string {
  const mention = `@${reporter ?? 'reporter'}`
  const out: string[] = []
  let items: string[] = []
  const flush = (): void => {
    if (items.length) out.push(`<ul>${items.join('')}</ul>`)
    items = []
  }
  for (const raw of comment.split('\n')) {
    const line = raw.replace(MENTION, mention)
    const item = /^- (.+)$/.exec(line.trim())
    if (item) {
      const struck = /^-(.+)-$/.exec(item[1]!.trim())
      items.push(struck ? `<li><s>${esc(struck[1]!.trim())}</s></li>` : `<li>${esc(item[1])}</li>`)
      continue
    }
    flush()
    const struck = /^-(.+)-$/.exec(line.trim())
    if (struck) out.push(`<p><s>${esc(struck[1]!.trim())}</s></p>`)
    else if (line.trim()) out.push(`<p>${esc(line)}</p>`)
  }
  flush()
  return out.join('')
}

// ---- Pieces

export function resultLabel(b: BugView): string {
  switch (b.status) {
    case 'dry_run':
      return 'comment · dry run'
    case 'commented':
      return 'commented'
    case 'retry':
      return `retrying · ${b.attempts} of ${MAX_ATTEMPTS} failed`
    case 'failed':
      return 'check failed'
    case 'posting':
      return 'interrupted while posting'
    case 'understood':
      return 'understood'
    case 'not_webui':
      return 'not a WebUI bug'
    case 'skipped':
      return 'skipped'
    default:
      return b.status
  }
}

/** A frame's title line: its name and, beside it, a note. */
const frameHead = (title: string, note = ''): string =>
  `<div class="frame-head"><h2>${title}</h2>${note ? `<span class="note">${note}</span>` : ''}</div>`

const modePill = (dryRun: boolean | null): string =>
  dryRun === null ? '' : dryRun ? '<span class="pill">dry run</span>' : '<span class="pill ok">live</span>'

/** A bug's result as a pill: moss for understood, slate for a comment, plain for not the WebUI's, rust for an error. */
const TONE: Record<Result, string> = { understood: ' ok', not_understood: ' slate', not_webui: ' strong', error: ' bad', skipped: '' }
const resultPill = (b: BugView): string => `<span class="pill${TONE[result(b)]}">${esc(resultLabel(b))}</span>`

const kv = (rows: [string, string][]): string => `<dl class="kv">${rows.map(([k, v]) => `<dt>${esc(k)}</dt><dd>${v}</dd>`).join('')}</dl>`

const bugLink = (key: string): string => (ISSUE_KEY.test(key) ? `<a class="key" href="/bugs/${key}">${key}</a>` : esc(key))

function jiraLink(key: string, ctx: PageContext, text = 'Jira'): string {
  if (!ISSUE_KEY.test(key)) return ''
  return `<a class="jira" href="${esc(ctx.jiraBaseUrl)}/browse/${key}" target="_blank" rel="noopener">${text}</a>`
}

/** Bugs checked per day as stacked bars; the busiest day fills the height, its count above it. */
export function dayChart(days: Day[]): string {
  const col = 24
  const bar = 16
  const area = 100
  const stacked = ['understood', 'not_understood', 'not_webui', 'error'] as const
  const sum = (d: Day): number => stacked.reduce((n, kind) => n + d.counts[kind], 0)
  const top = Math.max(0, ...days.map(sum))
  const parts: string[] = []
  days.forEach((d, i) => {
    const x = i * col + (col - bar) / 2
    let y = 14 + area
    for (const kind of stacked) {
      const h = top ? (d.counts[kind] * area) / top : 0
      if (h > 0) {
        y -= h
        parts.push(`<rect class="${kind}" x="${x}" y="${y.toFixed(1)}" width="${bar}" height="${h.toFixed(1)}"/>`)
      }
    }
    const total = sum(d)
    if (total) parts.push(`<text class="count" x="${x + bar / 2}" y="${(y - 3).toFixed(1)}">${total}</text>`)
    parts.push(
      `<text class="day${i === days.length - 1 ? ' today' : ''}" x="${x + bar / 2}" y="${14 + area + 13}">${d.day.getDate()}</text>`,
    )
  })
  return `<svg class="days" viewBox="0 0 ${days.length * col} ${14 + area + 18}" width="100%" role="img" aria-label="Bugs checked per day">${parts.join('')}</svg>`
}

// ---- Formatting

/** An error message on one line; the whole of it on hover when it is cut. */
function errorText(error: unknown): string {
  const text = typeof error === 'string' ? error : error == null ? '' : String(error)
  const line = cut(text, ERROR_WIDTH)
  return line === text ? esc(text) : `<span title="${esc(text)}">${esc(line)}</span>`
}
