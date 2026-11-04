/** The pages, as pure functions of what was read: a model in, an HTML string out. */

import { MAX_ATTEMPTS } from '../config.ts'
import { OUTCOMES, REQUIREMENTS, type Outcome } from '../domain/bug.ts'
import { ISSUE_KEY } from '../domain/key.ts'
import { cut, fmtAgo, fmtClock, fmtDate, fmtDay, fmtDuration, fmtTime, plural } from '../format.ts'
import { type BugView, type Heartbeat, type Request, type Result, type Run, checked, result } from './read.ts'
import { type LogEvent, type ServiceStatus, alive, liveness } from './service-log.ts'
import {
  type Day,
  PERIODS,
  PERIOD_LABEL,
  type Period,
  chartDays,
  checksPerDay,
  fieldChecksPassedAfterComment,
  gaps,
  needsAttention,
  periodBugs,
  periodStats,
} from './stats.ts'

const SUMMARY_WIDTH = 80
const ERROR_WIDTH = 120
const MENTION = /\[~accountid:[^\]]*\]/g

/** A notification after a POST: the redirect carries it as `?toast=<kind>:<text>`. */
export type ToastKind = 'success' | 'info' | 'error'
export interface Toast {
  kind: ToastKind
  text: string
}
const TOAST_KINDS: readonly ToastKind[] = ['success', 'info', 'error']

/** `?toast=success:Check requested` → the toast; nothing without the parameter. */
export function toastOf(params: URLSearchParams): Toast | null {
  const raw = params.get('toast')
  if (!raw) return null
  const colon = raw.indexOf(':')
  const kind = colon === -1 ? '' : raw.slice(0, colon)
  const text = (colon === -1 ? raw : raw.slice(colon + 1)).trim()
  if (!text) return null
  return { kind: (TOAST_KINDS as readonly string[]).includes(kind) ? (kind as ToastKind) : 'info', text }
}

/** The parameter a redirect carries, for `URLSearchParams`. */
export const toastParam = (toast: Toast): string => `${toast.kind}:${toast.text}`

/** What every page needs besides its own model. */
export interface PageContext {
  jiraBaseUrl: string
  /** The service's mode from its log; null when the log does not say. */
  dryRun: boolean | null
  now: Date
  /** The host the page was asked from, for the masthead. */
  host?: string | undefined
  /** A notification to show once, after a POST. */
  toast?: Toast | null | undefined
}

const esc = (value: unknown): string =>
  String(value).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] ?? c)

// ---- Tones

/** How a state is shown, as both consoles name it; `toneClass` gives the pill's class. */
export type Tone = 'ok' | 'bad' | 'live' | 'strong' | ''
export const toneClass = (tone: Tone): string => (tone === 'live' ? 'slate' : tone)

/** A bug's result: moss for understood, slate for a comment, strong for not the WebUI's, rust for an error, plain for skipped. */
export const RESULT_TONE: Record<Result, Tone> = {
  understood: 'ok',
  not_understood: 'live',
  not_webui: 'strong',
  error: 'bad',
  skipped: '',
}

// ---- Layout

/** The pages the masthead lists; a bug's page is under Bugs. */
export type Section = 'cockpit' | 'bugs' | 'stats'

function layout(title: string, main: string, ctx: PageContext, section: Section | null = null): string {
  const nav = (s: Section, href: string, name: string): string =>
    `<a class="btn${s === section ? ' active' : ''}" href="${href}">${name}</a>`
  // Without JavaScript the toast is a notice at the top of the page; app.js turns it into a toast.
  const toast = ctx.toast
    ? `<div class="notice${ctx.toast.kind === 'error' ? '' : ' calm'}" data-toast="${ctx.toast.kind}">${esc(ctx.toast.text)}</div>\n`
    : ''
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
<nav>${nav('cockpit', '/', 'Cockpit')}${nav('bugs', '/bugs', 'Bugs')}${nav('stats', '/stats', 'Statistics')}</nav>
<button class="btn theme" type="button" aria-label="Switch between light and dark"></button>
</header>
<main class="sheet">
${toast}${main}
</main>
<script src="/app.js"></script>
</body>
</html>
`
}

export function errorPage(status: number, message: string, ctx: PageContext): string {
  return layout(
    `${status} · Bug validator`,
    `<div class="page-head"><h1>${status}</h1></div><div class="notice">${esc(message)}</div>`,
    ctx,
  )
}

// ---- Cockpit

export interface HomeModel {
  bugs: BugView[]
  status: ServiceStatus | null
  logPath: string
  /** The latest events, oldest first, as the log keeps them. */
  recent: LogEvent[]
  requests: Request[]
  /** The service's heartbeat from the database; null when it never wrote one. */
  heartbeat: Heartbeat | null
  /** The database's path, and whether the file is there. */
  dbPath: string
  dbFound: boolean
}

/** One state source: what the console reads and whether it reads as it should. */
interface Source {
  name: string
  detail: string
  ok: boolean
}

export function homePage(m: HomeModel, ctx: PageContext): string {
  const now = ctx.now
  const attention = needsAttention(m.bugs)
  const sources = stateSources(m, now)
  const failing = sources.filter((s) => !s.ok).map((s) => s.name)
  // The checks asked for and not yet made; a failed request shows on its bug's page and in the log.
  const pending = m.requests.filter((r) => !r.error)
  const skipped = m.bugs.filter((b) => result(b) === 'skipped')
  const skippedFacts: [string, string][] = skipped.length
    ? [
        ['Bugs', String(skipped.length)],
        ['First start', fmtTime(new Date(Math.min(...skipped.map((b) => b.checkedAt.getTime()))))],
        ['Why', 'already in Created when the service first started, so never checked'],
      ]
    : []
  const main = `
<div class="cards">${cards(m, now)}</div>
<div class="cockpit">
<div class="stack">
<section class="frame sources" data-ok="${failing.length ? '0' : '1'}">
<button class="fold" type="button" aria-expanded="true"><span class="label">State sources</span><span class="lamp ${failing.length ? 'bad' : 'ok'}"></span><span class="state${failing.length ? ' err' : ''}">${failing.length ? `${esc(failing.join(', '))} not OK` : 'all OK'}</span><span class="chevron">−</span></button>
<div class="deps">${sources
    .map(
      (s) =>
        `<div class="dep"><div class="text"><div class="name">${esc(s.name)}</div><div class="detail" title="${esc(s.detail)}">${esc(s.detail)}</div></div><span class="pill ${s.ok ? 'ok' : 'bad'}">${s.ok ? 'OK' : 'not OK'}</span></div>`,
    )
    .join('')}
<div class="facts">${kv(serviceFacts(m, now))}</div>
</div>
</section>
<section class="frame requested">${frameHead('Requested', pending.length ? plural(pending.length, 'check') : '', 'checks asked for by hand, made before the next poll’s')}
${pending.length ? `<table class="wide"><thead><tr><th>Bug</th><th>Asked</th></tr></thead><tbody>${pending.map((r) => `<tr><td class="key">${bugLink(r.key)}</td><td class="num dim">${fmtAgo(r.at, now)}</td></tr>`).join('')}</tbody></table>` : '<p class="empty">Nothing requested.</p>'}</section>
${skipped.length ? `<section class="frame skipped">${frameHead('Skipped at the first start')}${kv(skippedFacts)}</section>` : ''}
</div>
<div class="stack">
<section class="frame attention">${frameHead('Needs attention', attention.length ? String(attention.length) : '', "failed checks, interrupted posts, bugs not the WebUI's")}
${attention.length ? attentionTable(attention) : '<p class="empty">Nothing to look at.</p>'}</section>
<section class="frame activity">${frameHead('Activity', '', 'the latest events of the log')}
${m.recent.length ? activityTable(m.recent) : '<p class="empty">Nothing logged yet.</p>'}</section>
</div>
</div>`
  return layout('Bug validator', main, ctx, 'cockpit')
}

/** The four cards: the service, the bug being checked, the bugs in Created, the mode. */
function cards(m: HomeModel, now: Date): string {
  const s = m.status
  const card = (name: string, label: string, value: string, notes: string): string =>
    `<section class="frame card ${name}"><div class="label">${label}</div>${value}${notes}</section>`
  const note = (text: string, cls = ''): string => `<div class="note one${cls ? ` ${cls}` : ''}" title="${esc(text)}">${esc(text)}</div>`

  let service: string
  if (!s) service = card('service', 'Service', `<div class="value">— <small>no log</small></div>`, note(`no log at ${m.logPath}`, 'err'))
  else {
    const state = liveness(s, now, m.heartbeat)
    const bad = state === 'stopped' || state === 'crashed' || state === 'silent'
    const since = state === 'running' || state === 'stopping' ? '' : s.lastSeen ? `<small>${fmtAgo(s.lastSeen, now)}</small>` : ''
    const value = `<div class="value${state === 'running' ? ' live' : bad ? ' err' : ''}">${state} ${since}</div>`
    let notes = ''
    if (state === 'crashed') notes += note(errorText(s.crashed, false), 'err')
    if (s.pollError) {
      notes += note(`last poll failed${s.pollFailures > 1 ? ` ${s.pollFailures} times in a row` : ''} · ${fmtAgo(s.lastPoll ?? now, now)}`)
      notes += note(errorText(s.pollError, false), 'err')
    } else if (s.lastPoll) notes += note(`last poll ${fmtAgo(s.lastPoll, now)}`)
    else notes += note('no poll yet')
    service = card('service', 'Service', value, notes)
  }

  const checking = s?.checking
    ? card(
        'checking',
        'Checking',
        `<div class="value">${esc(s.checking.key)}</div>`,
        `${note(`for ${fmtDuration((now.getTime() - s.checking.since.getTime()) / 1000)}`)}<div class="acts"><a class="btn tiny" href="/bugs/${esc(s.checking.key)}">Open</a></div>`,
      )
    : card('checking', 'Checking', '<div class="value">—</div>', note('nothing running'))

  const created =
    s && s.inQuery !== null
      ? card(
          'created',
          'In Created',
          `<div class="value">${s.inQuery}${s.waiting ? ` <small>${s.waiting} waiting</small>` : ''}</div>`,
          note(
            [
              s.pollError ? 'as of the last poll that went through' : s.lastPoll ? `as of ${fmtClock(s.lastPoll)}` : '',
              s.pollIntervalMs ? `poll every ${fmtDuration(s.pollIntervalMs / 1000)}` : '',
            ]
              .filter(Boolean)
              .join(' · '),
          ),
        )
      : card('created', 'In Created', '<div class="value">—</div>', note('no poll yet'))

  const mode =
    s && s.dryRun !== null
      ? card(
          'mode',
          'Mode',
          `<div class="value">${s.dryRun ? 'dry run' : 'live'}</div>`,
          note([s.model ? `model ${s.model}` : '', s.claudeVersion ? `claude ${s.claudeVersion}` : ''].filter(Boolean).join(' · ') || '—'),
        )
      : card('mode', 'Mode', '<div class="value">—</div>', note('not known: no service start in the log'))

  return service + checking + created + mode
}

/** What the console reads: the log, the database, and what the service's start said of Jira, claude and the clone. */
function stateSources(m: HomeModel, now: Date): Source[] {
  const s = m.status
  return [
    {
      name: 'Service log',
      detail: s ? `${m.logPath} · last line ${fmtAgo(s.lastSeen, now)}` : `no log at ${m.logPath}`,
      ok: s !== null,
    },
    {
      name: 'Database',
      detail: m.dbFound ? `${m.dbPath} · ${plural(m.bugs.length, 'bug')}` : `no database at ${m.dbPath}`,
      ok: m.dbFound,
    },
    {
      name: 'Jira',
      detail: !s
        ? 'not known without the log'
        : s.pollError
          ? `poll failed${s.pollFailures > 1 ? ` ${s.pollFailures} times in a row` : ''} · ${s.pollError}`
          : s.lastPoll
            ? `polled ${fmtAgo(s.lastPoll, now)}`
            : 'no poll yet',
      ok: s !== null && s.pollError === null,
    },
    {
      name: 'claude',
      detail: s?.claudeVersion
        ? `${s.claudeVersion}${s.model ? ` · model ${s.model}` : ''}`
        : 'version not known: no service start in the log',
      ok: !!s?.claudeVersion,
    },
    {
      name: 'WebUI clone',
      detail: s?.webuiCommit ? `master at ${s.webuiCommit.slice(0, 12)}` : 'commit not known: no service start in the log',
      ok: !!s?.webuiCommit,
    },
  ]
}

/** The facts under the sources: when the service started, its heartbeat, the poll interval. */
function serviceFacts(m: HomeModel, now: Date): [string, string][] {
  const s = m.status
  const rows: [string, string][] = []
  if (s?.started) rows.push(['Started', fmtTime(s.started)])
  rows.push(['Heartbeat', heartbeatText(m.heartbeat, now)])
  if (s?.webuiCommit) rows.push(['WebUI', `<code>${esc(s.webuiCommit.slice(0, 12))}</code> · master`])
  if (s?.pollIntervalMs) rows.push(['Poll every', fmtDuration(s.pollIntervalMs / 1000)])
  if (s?.agentTimeoutMs) rows.push(['Agent timeout', fmtDuration(s.agentTimeoutMs / 1000)])
  return rows
}

/** The heartbeat's age and the pid that wrote it; a stale one in rust, none in grey. */
function heartbeatText(h: Heartbeat | null, now: Date): string {
  if (!h) return '<span class="dim">none yet</span>'
  const text = `${fmtAgo(h.seenAt, now)} · pid ${h.pid} · started ${fmtTime(h.startedAt)}`
  return alive(h, now) ? text : `<span class="err">${text}</span>`
}

function attentionTable(bugs: BugView[]): string {
  return `<table class="wide"><thead><tr><th>Bug</th><th>Last check</th><th>What</th><th>Why</th></tr></thead><tbody>${bugs
    .map((b) => {
      // A bug not the WebUI's waits for a person's decision; its reason is the agent's.
      if (result(b) === 'not_webui' && b.error === null)
        return `<tr><td class="key">${bugLink(b.key)}</td><td class="num dim">${fmtTime(b.checkedAt)}</td><td><span class="pill strong">not a WebUI bug</span></td><td>${esc(b.reason)}</td></tr>`
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
      return `<tr><td class="key">${bugLink(b.key)}</td><td class="num dim">${fmtTime(b.checkedAt)}</td><td><span class="pill bad">${attempts}</span></td><td class="err">${esc(error)}</td></tr>`
    })
    .join('')}</tbody></table>`
}

function activityTable(recent: LogEvent[]): string {
  return `<table class="wide activity"><tbody>${[...recent]
    .reverse()
    .map((e) => {
      const key = typeof e.fields.key === 'string' ? e.fields.key : null
      const cls = e.level === 'error' ? 'err' : e.level === 'warn' ? 'warn' : ''
      return `<tr><td class="num dim">${fmtTime(e.ts)}</td><td class="key">${key ? bugLink(key) : ''}</td><td class="${cls}">${eventText(e)}</td></tr>`
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
const FILTERS: Record<Filter, string> = { all: 'All', ...OUTCOME_TEXT, error: 'error', skipped: 'skipped' }
/** The result chips as the filters row groups them: understood on its own, the two other outcomes together, error on its own. */
const FILTER_GROUPS: { tone: 'ok' | 'bad' | ''; filters: Result[] }[] = [
  { tone: 'ok', filters: ['understood'] },
  { tone: '', filters: ['not_understood', 'not_webui'] },
  { tone: 'bad', filters: ['error'] },
]

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
  // The chips count what the search lets through, so each says what it would show.
  const searched = filterBugs(all, { result: 'all', q: query.q })
  const count = (f: Filter): number => (f === 'all' ? searched.length : searched.filter((b) => result(b) === f).length)
  const narrowed = query.result !== 'all' || query.q !== ''
  const chip = (f: Filter, cls = ''): string =>
    `<a class="chip${cls ? ` ${cls}` : ''}${f === query.result ? ' on' : ''}" href="/bugs?${new URLSearchParams({ result: f, q: query.q })}">${FILTERS[f]} <b>${count(f)}</b></a>`
  const groups = FILTER_GROUPS.map(
    (g) => `<div class="group${g.tone ? ` ${g.tone}` : ''}">${g.filters.map((f) => chip(f, 'fam')).join('')}</div>`,
  ).join('')
  let rows = ''
  let day = ''
  for (const b of bugs) {
    // Bugs come latest first, so a day's checks sit together under one day row.
    const d = fmtDay(b.checkedAt)
    if (d !== day) {
      day = d
      rows += `<tr class="day"><th class="label" colspan="8">${d}</th></tr>`
    }
    rows += `<tr><td class="key">${bugLink(b.key)}</td><td class="jira">${jiraArrow(b.key, ctx)}</td><td class="summary one-line"><a href="/bugs/${esc(b.key)}" title="${esc(b.summary ?? '')}">${esc(cut(b.summary ?? '', SUMMARY_WIDTH))}</a></td><td class="num dim">${fmtClock(b.checkedAt)}</td><td>${resultPill(b)}</td><td class="absent">${absentChips(b)}</td><td class="num">${b.related.length || ''}</td><td class="num">${b.history.length > 1 ? b.history.length : ''}</td></tr>`
  }
  const main = `
<div class="page-head"><h1>All bugs</h1><span class="stats">${narrowed ? `${bugs.length} of ${plural(all.length, 'bug')} shown` : plural(all.length, 'bug')}</span></div>
<form class="filters" method="get" action="/bugs">
<div class="row"><span class="label">Result</span><div class="opts">${chip('all')}${groups}${chip('skipped')}</div></div>
<div class="row"><span class="label">Search</span><div class="opts"><input class="field" type="search" name="q" value="${esc(query.q)}" placeholder="A key, words of the summary, a reporter" aria-label="Search"></div>${narrowed ? '<a class="btn tiny clear" href="/bugs">Clear</a>' : ''}</div>
<input type="hidden" name="result" value="${query.result}">
</form>
<section class="frame">
${bugs.length ? `<table class="wide bugs"><thead><tr><th>Bug</th><th>Jira</th><th>Summary</th><th>Checked</th><th>Result</th><th>Absent</th><th class="num">Related</th><th class="num">Checks</th></tr></thead><tbody>${rows}</tbody></table>` : '<p class="empty">No bug matches.</p>'}
</section>`
  return layout(`Bugs · Bug validator`, main, ctx, 'bugs')
}

/** The field checks the first check found failed: what the report lacked as it arrived. */
const absentChips = (b: BugView): string =>
  (b.history.find((run) => run.error === null)?.fieldChecks ?? b.fieldChecks)
    .filter((c) => !c.passed)
    .map((c) => `<span class="req" title="${esc(REQUIREMENTS[c.id])}">${esc(c.id)}</span>`)
    .join(' ')

// ---- Statistics

/** The series of the chart, in the order they stack, each with the sheet's colour for how it ended. */
const SERIES: { kind: Exclude<Result, 'skipped'>; name: string; color: string }[] = [
  { kind: 'understood', name: 'understood', color: 'var(--chart-ok)' },
  { kind: 'not_understood', name: 'not understood', color: 'var(--chart-count)' },
  { kind: 'not_webui', name: 'not a WebUI bug', color: 'var(--chart-none)' },
  { kind: 'error', name: 'error', color: 'var(--chart-bad)' },
]

export function statsPage(all: BugView[], period: Period, ctx: PageContext): string {
  const now = ctx.now
  const bugs = periodBugs(all, period, now)
  const s = periodStats(bugs)
  const pct = (n: number): string => (s.checked ? `${Math.round((n / s.checked) * 100)}% of checked` : '—')
  const money = (usd: number | null): string => (usd === null ? '—' : `$${usd.toFixed(2)}`)
  const cells: { label: string; value: string; tone: Tone; note: string }[] = [
    {
      label: 'Checked',
      value: String(s.checked),
      tone: '',
      note: `${plural(s.checks, 'check')}${s.since ? ` · since ${fmtDate(s.since)}` : ''}`,
    },
    {
      label: 'Understood',
      value: String(s.byOutcome.understood.count),
      tone: s.byOutcome.understood.count ? 'ok' : '',
      note: pct(s.byOutcome.understood.count),
    },
    { label: 'Not understood', value: String(s.byOutcome.not_understood.count), tone: '', note: pct(s.byOutcome.not_understood.count) },
    { label: 'Not a WebUI bug', value: String(s.byOutcome.not_webui.count), tone: '', note: pct(s.byOutcome.not_webui.count) },
    { label: 'Failed', value: String(s.errors), tone: s.errors ? 'bad' : '', note: s.errors ? 'bugs whose last check failed' : 'none' },
    {
      label: 'Cost',
      value: money(s.costUsd),
      tone: '',
      note: s.medianCostUsd === null ? 'no check with a cost' : `median ${money(s.medianCostUsd)} per check`,
    },
  ]
  const strip = `<section class="frame strip">${cells
    .map(
      (c) =>
        `<div class="cell"><div class="label">${c.label}</div><div class="value${c.tone ? ` ${c.tone}` : ''}">${c.value}</div><div class="note" title="${esc(c.note)}">${esc(c.note)}</div></div>`,
    )
    .join('')}</section>`

  const chips = PERIODS.map((p) => `<a class="chip${p === period ? ' on' : ''}" href="/stats?period=${p}">${PERIOD_LABEL[p]}</a>`).join('')

  const found = gaps(bugs)
  const total = found[0]?.share.total ?? 0
  const gapBars = total
    ? `<div class="bars">${found
        .map((g) => {
          const share = g.share.count / total
          return `<div class="bar-row" title="${esc(`${g.share.count} of ${total} first checks found ${g.name} absent`)}"><span class="name">${g.id} · ${esc(g.name)}</span><span class="track"><i style="width:${(share * 100).toFixed(1)}%"></i></span><b class="num">${g.share.count}</b><span class="share num">${Math.round(share * 100)}%</span></div>`
        })
        .join('')}</div>`
    : '<p class="empty">No bug checked to the end in this period.</p>'

  const after = fieldChecksPassedAfterComment(bugs)
  const afterBars = after.total
    ? `<div class="bars"><div class="bar-row"><span class="name">passed later</span><span class="track"><i style="width:${((after.count / after.total) * 100).toFixed(1)}%"></i></span><b class="num">${after.count}</b><span class="share num">${Math.round((after.count / after.total) * 100)}%</span></div><div class="bar-row"><span class="name">still absent</span><span class="track"><i class="none" style="width:${(((after.total - after.count) / after.total) * 100).toFixed(1)}%"></i></span><b class="num">${after.total - after.count}</b><span class="share num">${Math.round(((after.total - after.count) / after.total) * 100)}%</span></div></div>`
    : '<p class="empty">No bug re-checked after its comment yet.</p>'

  const days = checksPerDay(all, now, chartDays(period, all, now))
  const inChart = days.reduce((n, d) => n + SERIES.reduce((m, x) => m + d.counts[x.kind], 0), 0)
  const main = `
<div class="page-head"><h1>Statistics</h1><span class="stats">${PERIOD_LABEL[period]} · bugs first checked in it, by their result now</span></div>
<div class="filters"><div class="row"><span class="label">Period</span><div class="opts">${chips}</div></div></div>
${strip}
<div class="stats-pair">
<section class="frame gaps">${frameHead('Field checks failed most often', total ? `first checks of ${plural(total, 'bug')}` : '', 'what the reports lacked as they arrived')}${gapBars}</section>
<section class="frame after">${frameHead('Field checks passed after the comment', after.total ? `${after.count} of ${after.total}` : '', 'what arrived while a commented bug was still in Created')}${afterBars}</section>
</div>
<section class="frame chart">${frameHead('Bugs checked per day', String(inChart), `${plural(days.length, 'day')} · by the day of the first check`)}${columnChart(days)}</section>`
  return layout('Statistics · Bug validator', main, ctx, 'stats')
}

/* The chart's geometry: the sheet's column chart (sheet.css, its markup contract) at the height
   pipeline-ui draws it. The width is the frame's, unknown here, so every x is a percentage of the
   plot and the axis numbers sit in the plot's left padding (app.css); the bar width and how many
   dates fit are judged on a plot about this wide. */
const CHART = { height: 180, top: 8, bottom: 22, gap: 2, assumedWidth: 900, minLabelPx: 48 }

/** Bugs checked per day as the sheet's stacked columns; `app.js` adds the tooltip from the `data-*` of each hit. */
export function columnChart(days: Day[]): string {
  const { height, top, bottom, gap } = CHART
  const plotH = height - top - bottom
  const n = Math.max(1, days.length)
  const slotPct = 100 / n
  const assumedSlot = CHART.assumedWidth / n
  const barW = Math.max(2, Math.min(24, assumedSlot * 0.62))
  const labelEvery = Math.max(1, Math.ceil(CHART.minLabelPx / assumedSlot))
  const totals = days.map((d) => SERIES.reduce((sum, s) => sum + d.counts[s.kind], 0))
  // Round grid steps: at most four lines above zero.
  const max = Math.max(1, ...totals)
  const step = [1, 2, 5, 10, 20, 25, 50, 100, 200, 500].find((s) => max / s <= 4) ?? Math.ceil(max / 4)
  const scaleTop = Math.ceil(max / step) * step
  const y = (v: number): number => top + plotH - (v / scaleTop) * plotH
  const ticks = Array.from({ length: scaleTop / step + 1 }, (_, i) => i * step)
  const px = (v: number): string => v.toFixed(1).replace(/\.0$/, '')
  const at = (i: number): string => `${((i + 0.5) * slotPct).toFixed(3)}%`

  const grid = ticks
    .map((t) => `<line x1="0" x2="100%" y1="${px(y(t))}" y2="${px(y(t))}"/><text x="-8" y="${px(y(t) + 4)}" text-anchor="end">${t}</text>`)
    .join('')
  // Each column is an svg of its own, placed at its slot's centre: a percentage x is allowed there,
  // and the parts inside are drawn in pixels around 0. A part under 2px is drawn at 2px so a 1 is seen.
  const columns = days
    .map((d, i) => {
      let base = top + plotH
      const shown = SERIES.filter((s) => d.counts[s.kind] > 0)
      const parts = shown.map((s, k) => {
        const h = Math.max(2, (d.counts[s.kind] / scaleTop) * plotH - (k > 0 ? gap : 0))
        const partTop = base - (k > 0 ? gap : 0) - h
        const last = k === shown.length - 1
        const r = last ? Math.min(4, h, barW / 2) : 0
        const x = -barW / 2
        const w = barW
        // The top part's upper corners are rounded; every other edge is square.
        const dd = `M${px(x)},${px(partTop + h)} V${px(partTop + r)} Q${px(x)},${px(partTop)} ${px(x + r)},${px(partTop)} H${px(x + w - r)} Q${px(x + w)},${px(partTop)} ${px(x + w)},${px(partTop + r)} V${px(partTop + h)} Z`
        base = partTop
        return `<path d="${dd}" fill="${s.color}"/>`
      })
      return parts.length ? `<svg class="col" x="${at(i)}" width="1" height="${height}" overflow="visible">${parts.join('')}</svg>` : ''
    })
    .join('')
  const dates = days
    .map((d, i) => (i % labelEvery === 0 ? `<text x="${at(i)}" y="${height - 6}" text-anchor="middle">${esc(shortDay(d.day))}</text>` : ''))
    .join('')
  const hits = days
    .map(
      (d, i) =>
        `<rect class="hit" x="${(i * slotPct).toFixed(3)}%" y="0" width="${slotPct.toFixed(3)}%" height="${height}" data-when="${esc(fmtDay(d.day))}" data-total="${totals[i]}" data-values="${SERIES.map((s) => d.counts[s.kind]).join(',')}"/>`,
    )
    .join('')
  const summary = `Bugs checked per day: ${totals.reduce((a, b) => a + b, 0)} in ${plural(days.length, 'day')}`
  return `<div class="columns"><ul class="legend">${SERIES.map((s) => `<li><i style="background:${s.color}"></i>${s.name}</li>`).join('')}</ul><div class="plot" tabindex="0" aria-label="${esc(summary)}"><svg width="100%" height="${height}" role="img" aria-label="${esc(summary)}" data-top="${top}" data-plot-height="${plotH}"><g class="grid">${grid}</g><g class="cols">${columns}</g><g class="dates">${dates}</g>${hits}</svg></div></div>`
}

/** `4 Nov`: a date under a column. */
const shortDay = (d: Date): string => `${d.getDate()} ${d.toLocaleDateString('en-GB', { month: 'short' })}`

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
    rows.push(['Checked', fmtTime(b.checkedAt)])
    if (b.history.length > 1) rows.push(['Checks', `${b.history.length} · first ${fmtTime(b.history[0]!.at)}`])
    if (b.related.length)
      rows.push(['Related', b.related.map((k) => `<a class="pill slate" href="/bugs/${esc(k)}">${esc(k)}</a>`).join(' ')])
  }
  if (request)
    rows.push([
      'Request',
      request.error ? `<span class="err">failed · ${esc(request.error)}</span>` : `waiting · ${fmtAgo(request.at, ctx.now)}`,
    ])
  if (post)
    rows.push(['Post', post.error ? `<span class="err">failed · ${esc(post.error)}</span>` : `waiting · ${fmtAgo(post.at, ctx.now)}`])
  rows.push(['Jira', jiraLink(key, ctx, esc(`${ctx.jiraBaseUrl}/browse/${key}`))])
  // Why the check did not end well, or why the bug is not the WebUI's: whole, under the facts.
  let reason = ''
  if (b?.status === 'posting')
    reason = reasonBlock(
      'bad',
      'Interrupted',
      `The post of this comment got no answer${b.error ? `: ${b.error}` : ''}. The next check of the bug, or a post asked again, looks in Jira first: a comment found there is kept, never posted twice.`,
    )
  else if (b?.error) reason = reasonBlock('bad', result(b) === 'error' ? 'Failed' : 'Re-check failed', b.error)
  else if (b && result(b) === 'not_webui') reason = reasonBlock('', 'Not a WebUI bug', b.reason || 'the agent gave no reason')
  // Posting is the one thing to press when a comment waits; otherwise the next check is.
  const canPost = b !== null && postable(b) && !(post && !post.error)
  const check =
    request && !request.error
      ? ''
      : `<form class="request" method="post" action="/requests"><input type="hidden" name="key" value="${key}"><button class="btn${canPost ? '' : ' primary'}">${b ? 'Check again' : 'Check'}</button></form>`
  // Posting asks first: the confirmation shows the comment as it will reach Jira.
  const posting = canPost ? `<a class="btn primary" href="/bugs/${key}?post" data-dialog="confirm-post">Post to Jira</a>` : ''
  const actions = check || posting ? `<div class="actions">${posting}${check}</div>` : ''
  // The dialog after the actions: without JavaScript it opens in the flow, under the buttons.
  const dialog = canPost ? confirmPost(b, m.confirmPost === true, ctx) : ''
  const head = `<header class="bug-head"><div class="page-head"><h1>${esc(key)}</h1><span class="stats">${esc(b?.summary ?? '')}</span></div>${kv(rows)}${reason}${actions}${dialog}</header>`
  if (!b)
    return layout(
      `${key} · Bug validator`,
      `${head}<p class="empty">Not checked yet. The page fills in when the service has checked the bug.</p>`,
      ctx,
      'bugs',
    )
  const subtitle =
    { dry_run: 'dry run · not posted', commented: 'posted to Jira', posting: 'interrupted while posting · the next check looks in Jira' }[
      b.status as string
    ] ?? ''
  const main = `
${head}
<div class="two">
<section class="frame checks">${frameHead('Checks')}${checks(b)}</section>
<section class="frame comment">${frameHead('Comment', '', subtitle)}${commentBlock(b)}</section>
</div>`
  return layout(`${key} · Bug validator`, main, ctx, 'bugs')
}

/** The sheet's reason block: a label and the text, a rust edge for a bad end. */
const reasonBlock = (tone: 'bad' | 'ok' | '', label: string, text: string): string =>
  `<div class="reason${tone ? ` ${tone}` : ''}"><span class="label">${esc(label)}</span><span>${esc(text)}</span></div>`

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
<div class="frame-head"><h2 id="confirm-post-title">Post this comment to ${esc(b.key)}?</h2><span class="note">checked ${fmtTime(b.checkedAt)}</span></div>
<p>It goes to Jira as it is, from the service's account, and mentions ${esc(b.reporter ?? 'the reporter')}: Jira notifies them. The UI cannot take it back.${dry}</p>
<div class="jira-comment">${commentHtml(b.comment ?? '', b.reporter)}</div>
<form method="post" action="/posts"><input type="hidden" name="key" value="${b.key}"><input type="hidden" name="checked" value="${b.checkedAt.toISOString()}"><button class="btn primary">Post</button><a class="btn" href="/bugs/${b.key}" data-close>Cancel</a></form>
</dialog>`
}

/** The field checks and every check of the bug with what it read and found. */
function checks(b: BugView): string {
  if (!checked(b) && b.status !== 'posting')
    return `<p class="empty">${result(b) === 'error' ? 'The check did not finish.' : 'Never checked.'}</p>`
  // The field checks are hints the agent got, not the verdict: steps without a heading are still steps.
  let html = `<h3>Field checks</h3><table class="wide requirements"><tbody>${b.fieldChecks
    .map(
      (c) =>
        `<tr><th>${c.id}</th><td>${esc(REQUIREMENTS[c.id])}</td><td><span class="${c.passed ? 'ok' : 'err'}">${c.passed ? '✓' : '✗'}</span> <span class="dim">${esc(c.detail)}</span></td></tr>`,
    )
    .join('')}</tbody></table>`
  if (b.history.length) {
    // Every check of the bug, oldest first: its outcome, what the agent read, and the comment it wrote.
    html += `<h3>History</h3><table class="wide history"><tbody>${b.history.map((run, i) => `<tr><td class="num dim">${fmtTime(run.at)}</td><td class="dim">${i === 0 ? 'first check' : 're-check'}</td><td>${runText(run, b.reporter)}</td></tr>`).join('')}</tbody></table>`
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
  return `<span class="dim">${parts.join(' · ')}</span>${comment}`
}

function commentBlock(b: BugView): string {
  if (result(b) === 'skipped') return `<p class="empty">${SKIPPED}</p>`
  if (b.status === 'posting') return `<div class="jira-comment">${commentHtml(b.comment ?? '', b.reporter)}</div>`
  if (result(b) === 'error') return '<p class="empty">No comment: the check did not finish.</p>'
  if (result(b) === 'understood')
    return `<p class="empty">The agent found the cause and understood the report: no comment.</p>${b.comment ? `<div class="jira-comment">${commentHtml(b.comment, b.reporter)}</div>` : ''}`
  if (result(b) === 'not_webui')
    return `<p class="empty">Not a WebUI bug, so no comment; a person decides where it goes.</p>${b.comment ? `<div class="jira-comment">${commentHtml(b.comment, b.reporter)}</div>` : ''}`
  if (!b.comment) return '<p class="empty">No comment recorded.</p>'
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

/** A frame's title line: its name, a count and a note beside it. */
const frameHead = (title: string, count = '', note = ''): string =>
  `<div class="frame-head"><h2>${title}</h2>${count ? `<span class="count">${esc(count)}</span>` : ''}${note ? `<span class="note">${note}</span>` : ''}</div>`

const modePill = (dryRun: boolean | null): string =>
  dryRun === null ? '' : dryRun ? '<span class="pill">dry run</span>' : '<span class="pill ok">live</span>'

const resultPill = (b: BugView): string => {
  const cls = toneClass(RESULT_TONE[result(b)])
  return `<span class="pill${cls ? ` ${cls}` : ''}">${esc(resultLabel(b))}</span>`
}

const kv = (rows: [string, string][]): string => `<dl class="kv">${rows.map(([k, v]) => `<dt>${esc(k)}</dt><dd>${v}</dd>`).join('')}</dl>`

const bugLink = (key: string): string => (ISSUE_KEY.test(key) ? `<a class="key" href="/bugs/${key}">${key}</a>` : esc(key))

function jiraLink(key: string, ctx: PageContext, text = 'Jira'): string {
  if (!ISSUE_KEY.test(key)) return ''
  return `<a class="jira" href="${esc(ctx.jiraBaseUrl)}/browse/${key}" target="_blank" rel="noopener">${text}</a>`
}

/** The arrow that opens the bug in Jira, as the sheet draws it in a `td.jira`. */
const jiraArrow = (key: string, ctx: PageContext): string =>
  ISSUE_KEY.test(key) ? `<a href="${esc(ctx.jiraBaseUrl)}/browse/${key}" target="_blank" rel="noopener" title="${key} in Jira">↗</a>` : ''

// ---- Formatting

/** An error message on one line; the whole of it on hover when it is cut (`title` false: the line alone). */
function errorText(error: unknown, title = true): string {
  const text = typeof error === 'string' ? error : error == null ? '' : String(error)
  const line = cut(text, ERROR_WIDTH)
  if (!title) return line
  return line === text ? esc(text) : `<span title="${esc(text)}">${esc(line)}</span>`
}
