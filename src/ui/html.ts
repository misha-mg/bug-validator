/** The pages, as pure functions of what was read: a model in, an HTML string out. */

import { MAX_ATTEMPTS } from '../config.ts';
import { REQUIREMENT_IDS, REQUIREMENTS } from '../domain/bug.ts';
import { type BugView, type Result, checked, result } from './read.ts';
import { type LogEvent, type ServiceStatus, liveness } from './service-log.ts';
import { type Day, type Share, checksPerDay, itemsAddedAfterComment, needsAttention, periodStats, problems, startOfDay } from './stats.ts';

export const CHART_DAYS = 30;
const WEEK_MS = 7 * 24 * 60 * 60 * 1000;
const SUMMARY_WIDTH = 80;
const ERROR_WIDTH = 120;
const KEY = /^(KAZ|RPG)-\d+$/;
const MENTION = /\[~accountid:[^\]]*\]/g;

/** What every page needs besides its own model. */
export interface PageContext {
  jiraBaseUrl: string;
  /** The service's mode from its log; null when the log does not say. */
  dryRun: boolean | null;
  now: Date;
}

export const esc = (value: unknown): string =>
  String(value).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] ?? c);

// ---- Layout

export function layout(title: string, main: string, ctx: PageContext): string {
  const mode = ctx.dryRun === null ? '' : ctx.dryRun ? '<span class="badge dry">dry run</span>' : '<span class="badge live">live</span>';
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title>
<link rel="stylesheet" href="/app.css">
</head>
<body>
<header class="top">
<a class="brand" href="/">Bug validator</a>
<nav><a href="/">Home</a><a href="/bugs">Bugs</a></nav>
${mode}
</header>
<main>
${main}
</main>
<script src="/app.js"></script>
</body>
</html>
`;
}

export function errorPage(status: number, message: string, ctx: PageContext): string {
  return layout(`${status} · Bug validator`, `<section class="block"><h2>${status}</h2><p>${esc(message)}</p></section>`, ctx);
}

// ---- Home

export interface HomeModel {
  bugs: BugView[];
  status: ServiceStatus | null;
  logPath: string;
  /** The latest events, oldest first, as the log keeps them. */
  recent: LogEvent[];
}

export function homePage(m: HomeModel, ctx: PageContext): string {
  const found = problems(m.bugs);
  const total = found[0]?.share.total ?? 0;
  const attention = needsAttention(m.bugs);
  const main = `
<section class="block service"><h2>Service</h2>${kv(serviceRows(m, ctx.now))}</section>
<section class="block statistics"><h2>Statistics</h2>${statsTable(m.bugs, ctx.now)}
<figure class="chart"><figcaption>Bugs checked per day</figcaption>${dayChart(checksPerDay(m.bugs, ctx.now, CHART_DAYS))}
<div class="legend"><span class="sw no_comment"></span>without comment <span class="sw comment"></span>with comment <span class="sw error"></span>error</div></figure></section>
<section class="block problems"><h2>Most common gaps <small>${total ? `of ${bugsText(total)} checked · all time` : ''}</small></h2>
${total ? problemsTable(found) : '<p class="muted">No bug has been checked yet.</p>'}</section>
<section class="block attention"><h2>Needs attention <small>failed checks</small></h2>
${attention.length ? attentionTable(attention, ctx) : '<p class="muted">No check has failed.</p>'}</section>
<section class="block activity"><h2>Activity <small>the latest events of the log</small></h2>
${m.recent.length ? activityTable(m.recent, ctx) : '<p class="muted">Nothing logged yet.</p>'}</section>`;
  return layout('Bug validator', main, ctx);
}

function serviceRows(m: HomeModel, now: Date): [string, string][] {
  const rows: [string, string][] = [];
  const s = m.status;
  if (!s) {
    rows.push(['State', `<span class="muted">no log at ${esc(m.logPath)}</span>`]);
  } else {
    const state = liveness(s, now);
    if (state === 'running') rows.push(['State', '<span class="ok">running</span>']);
    else if (state === 'stopped') rows.push(['State', `<span class="warn">stopped${s.lastSeen ? ` · ${ago(now, s.lastSeen)}` : ''}</span>`]);
    else rows.push(['State', `<span class="err">silent${s.lastSeen ? ` · ${span(now.getTime() - s.lastSeen.getTime())}` : ''}</span>`]);
    if (s.pollError) {
      rows.push(['Last poll', `<span class="err">failed · ${ago(now, s.lastPoll ?? now)}</span>`]);
      rows.push(['Error', `<span class="err">${errorText(s.pollError)}</span>`]);
    } else if (s.lastPoll) rows.push(['Last poll', ago(now, s.lastPoll)]);
    else rows.push(['Last poll', '<span class="muted">none yet</span>']);
    if (s.dryRun === true) rows.push(['Mode', '<span class="badge dry">dry run</span>']);
    else if (s.dryRun === false) rows.push(['Mode', '<span class="badge live">live</span>']);
    if (s.inQuery !== null && !s.pollError) rows.push(['In Created', `${s.inQuery}${s.waiting ? ` · ${s.waiting} waiting` : ''}`]);
    if (s.started) rows.push(['Started', fmtTime(s.started)]);
    if (s.model) rows.push(['Model', esc(s.model)]);
    if (s.claudeVersion || s.claudeAuth) rows.push(['Claude', esc([s.claudeVersion, s.claudeAuth].filter(Boolean).join(' · '))]);
    if (s.pollIntervalMs) rows.push(['Poll every', span(s.pollIntervalMs)]);
    if (s.checking) rows.push(['Checking', `${bugLink(s.checking.key)} · ${span(now.getTime() - s.checking.since.getTime())}`]);
  }
  const skipped = m.bugs.filter((b) => result(b) === 'skipped');
  if (skipped.length) {
    // Bugs already in Created at the first start, never checked.
    const first = new Date(Math.min(...skipped.map((b) => b.checkedAt.getTime())));
    rows.push(['Skipped', `${skipped.length} · ${fmtDate(first)}`]);
  }
  if (!m.bugs.length) rows.push(['Database', '<span class="muted">none yet</span>']);
  return rows;
}

function statsTable(bugs: BugView[], now: Date): string {
  const columns = [
    ['Today', periodStats(bugs, startOfDay(now))],
    ['7 days', periodStats(bugs, new Date(now.getTime() - WEEK_MS))],
    ['All time', periodStats(bugs)],
  ] as const;
  const row = (label: string, cell: (s: (typeof columns)[number][1]) => string): string =>
    `<tr><th>${label}</th>${columns.map(([, s]) => `<td>${cell(s)}</td>`).join('')}</tr>`;
  const added = itemsAddedAfterComment(bugs);
  return `<table class="stats"><thead><tr><th></th>${columns.map(([title]) => `<th>${title}</th>`).join('')}</tr></thead><tbody>
${row('Checked', (s) => String(s.checked))}
${row('Without comment', (s) => shareText(s.withoutComment))}
${row('With comment', (s) => shareText(s.withComment))}
${row('Check failed', (s) => (s.errors ? `<span class="err">${s.errors}</span>` : '0'))}
</tbody></table>
<p class="after-comment">Items added after the comment: <strong>${added.total ? `${added.count} of ${added.total} asked` : '–'}</strong> <small>re-checked bugs, all time</small></p>`;
}

function problemsTable(found: ReturnType<typeof problems>): string {
  const top = Math.max(...found.map((p) => p.share.count));
  return `<table class="problems"><tbody>${found
    .map((p) => {
      const n = p.share.count;
      const width = n ? Math.max(Math.round((n * 100) / top), 4) : 0;
      return `<tr class="${n ? '' : 'dim'}"><th>${p.id}</th><td>${esc(p.name)}</td><td class="bar"><div style="width:${width}%"></div></td><td class="num">${shareText(p.share)}</td></tr>`;
    })
    .join('')}</tbody></table>`;
}

function attentionTable(bugs: BugView[], ctx: PageContext): string {
  return `<table class="list"><thead><tr><th>Bug</th><th>Last try</th><th>Attempts</th><th>Error</th></tr></thead><tbody>${bugs
    .map((b) => {
      const attempts = `${b.attempts} of ${MAX_ATTEMPTS}${b.status === 'failed' ? ', gave up' : ''}`;
      const error = b.status === 'posting' ? 'interrupted while posting · look in Jira' : (b.error ?? '');
      return `<tr><td>${bugLink(b.key)}</td><td class="time">${fmtTime(b.checkedAt)}</td><td>${attempts}</td><td class="err">${esc(error)}</td></tr>`;
    })
    .join('')}</tbody></table>`;
}

function activityTable(recent: LogEvent[], ctx: PageContext): string {
  return `<table class="list activity"><tbody>${[...recent]
    .reverse()
    .map((e) => {
      const key = typeof e.fields.key === 'string' ? e.fields.key : null;
      const cls = e.level === 'error' ? 'err' : e.level === 'warn' ? 'warn' : '';
      return `<tr><td class="time">${fmtTime(e.ts)}</td><td>${key ? bugLink(key) : ''}</td><td class="${cls}">${eventText(e)}</td></tr>`;
    })
    .join('')}</tbody></table>`;
}

/** One line per event, escaped. */
export function eventText(e: LogEvent): string {
  const f = e.fields;
  const missing = Array.isArray(f.missing) ? (f.missing.length ? ` · missing ${f.missing.join(' ')}` : ' · nothing missing') : '';
  const re = f.recheck === true;
  switch (e.event) {
    case 'service_start':
      return esc(['service started', f.dryRun === true ? 'dry run' : f.dryRun === false ? 'live' : null, f.model].filter(Boolean).join(' · '));
    case 'service_stopping':
      return esc(`stopping · ${f.signal ?? ''}`);
    case 'service_stopped':
      return 'service stopped';
    case 'first_start':
      return esc(`first start · ${f.skipped ?? 0} bugs already in Created skipped`);
    case 'poll_failed':
      return `poll failed · ${errorText(f.error)}`;
    case 'key_changed':
      return esc(`moved: ${f.from} → ${f.to}`);
    case 'bug_complete':
      return esc(`${re ? 're-check: ' : ''}complete, no comment${missing}`);
    case 'comment_dry_run':
      return esc(`${re ? 're-check: ' : ''}comment · dry run${missing}`);
    case 'comment_posted':
      return esc(`comment posted${missing}`);
    case 'comment_edited':
      return esc(`comment edited${missing}`);
    case 'check_failed':
      return `${re ? 're-check' : 'check'} failed${f.attempts ? ` · attempt ${f.attempts}` : ''} · ${errorText(f.error)}`;
    case 'mentions_stripped':
      return esc(`mentions stripped: ${Array.isArray(f.stripped) ? f.stripped.join(', ') : ''}`);
    case 'fatal':
      return `fatal · ${errorText(f.error)}`;
    default:
      return esc(e.event);
  }
}

// ---- Bugs

export type Filter = 'all' | Result;
export const FILTERS: Record<Filter, string> = { all: 'all', comment: 'with comment', no_comment: 'without comment', error: 'error', skipped: 'skipped' };

export interface BugsQuery {
  result: Filter;
  q: string;
}

export function bugsQuery(params: URLSearchParams): BugsQuery {
  const result = params.get('result') ?? 'all';
  return { result: result in FILTERS ? (result as Filter) : 'all', q: (params.get('q') ?? '').trim() };
}

export function filterBugs(bugs: BugView[], query: BugsQuery): BugView[] {
  const q = query.q.toLowerCase();
  return bugs.filter((b) => (query.result === 'all' || result(b) === query.result) && (!q || [b.key, b.summary ?? '', b.reporter ?? ''].join(' ').toLowerCase().includes(q)));
}

export function bugsPage(all: BugView[], query: BugsQuery, ctx: PageContext): string {
  const bugs = filterBugs(all, query);
  const narrowed = [query.result !== 'all' ? FILTERS[query.result] : null, query.q ? `“${query.q}”` : null].filter(Boolean);
  const chips = (Object.keys(FILTERS) as Filter[])
    .map((f) => `<a class="chip${f === query.result ? ' active' : ''}" href="/bugs?${new URLSearchParams({ result: f, q: query.q })}">${FILTERS[f]}</a>`)
    .join('');
  let rows = '';
  let day = '';
  for (const b of bugs) {
    // Bugs come latest first, so a day's checks sit together under one day row.
    const d = fmtDay(b.checkedAt);
    if (d !== day) {
      day = d;
      rows += `<tr class="day"><th colspan="7">${d}</th></tr>`;
    }
    rows += `<tr><td>${bugLink(b.key)} ${jiraLink(b.key, ctx)}</td><td class="summary"><a href="/bugs/${b.key}" title="${esc(b.summary ?? '')}">${esc(cut(b.summary ?? '', SUMMARY_WIDTH))}</a></td><td class="time">${fmtClock(b.checkedAt)}</td><td><span class="result ${result(b)}">${esc(resultLabel(b))}</span></td><td>${chips_(b.missing)}</td><td class="num">${b.related.length || ''}</td><td class="num">${b.history.length > 1 ? b.history.length : ''}</td></tr>`;
  }
  const main = `
<h1>All bugs${narrowed.map((n) => ` · ${esc(n)}`).join('')} <small>${bugsText(bugs.length)}</small></h1>
<form class="toolbar" method="get" action="/bugs">
<nav class="chips">${chips}</nav>
<input type="hidden" name="result" value="${query.result}">
<input type="search" name="q" value="${esc(query.q)}" placeholder="Search a bug, its summary or reporter">
</form>
${bugs.length ? `<table class="list bugs"><thead><tr><th>Bug</th><th>Summary</th><th>Checked</th><th>Result</th><th>Missing</th><th>Related</th><th>Checks</th></tr></thead><tbody>${rows}</tbody></table>` : '<p class="muted">No bug matches.</p>'}`;
  return layout(`Bugs · Bug validator`, main, ctx);
}

const chips_ = (missing: string[]): string => missing.map((id) => `<span class="req" title="${esc(REQUIREMENTS[id as keyof typeof REQUIREMENTS] ?? '')}">${esc(id)}</span>`).join(' ');

// ---- One bug

const SKIPPED = 'Skipped: the bug was already in Created when the service first started, so it was never checked.';

export function bugPage(b: BugView, ctx: PageContext): string {
  const rows: [string, string][] = [];
  if (b.reporter) rows.push(['Reporter', esc(b.reporter)]);
  rows.push(['Result', `<span class="result ${result(b)}">${esc(resultLabel(b))}</span>`]);
  rows.push(['Checked', fmtTime(b.checkedAt)]);
  if (b.history.length > 1) rows.push(['Checks', `${b.history.length} · first ${fmtTime(b.history[0]!.at)}`]);
  if (b.error) rows.push(['Error', `<span class="err">${esc(b.error)}</span>`]);
  rows.push(['Jira', jiraLink(b.key, ctx, esc(`${ctx.jiraBaseUrl}/browse/${b.key}`))]);
  const subtitle = { dry_run: 'dry run · not posted', commented: 'posted to Jira', posting: 'interrupted while posting · look in Jira' }[b.status as string] ?? '';
  const main = `
<header class="bug-head"><h1>${esc(b.key)} <span class="summary">${esc(b.summary ?? '')}</span></h1>${kv(rows)}</header>
<div class="columns">
<section class="block"><h2>Requirements</h2>${requirements(b, ctx)}</section>
<section class="block comment"><h2>Comment <small>${subtitle}</small></h2>${commentBlock(b)}</section>
</div>`;
  return layout(`${b.key} · Bug validator`, main, ctx);
}

function requirements(b: BugView, ctx: PageContext): string {
  if (!checked(b) && b.status !== 'posting') return `<p class="muted">${result(b) === 'error' ? 'The check did not finish.' : 'Never checked.'}</p>`;
  const base = new Map(b.baseChecks.map((c) => [c.id, c]));
  // The agent's verdict decides what the comment asks for; the base checks are the facts it was
  // given, and it may overrule them (steps written without a "Steps" heading are still steps).
  let html = `<table class="requirements"><thead><tr><th></th><th></th><th>Agent</th><th>Base check</th></tr></thead><tbody>${REQUIREMENT_IDS.map((id) => {
    const verdict = b.missing.includes(id) ? '<span class="missing">missing</span>' : '<span class="ok">ok</span>';
    const fact = base.get(id);
    const detail = fact ? `<span class="${fact.passed ? 'ok' : 'err'}">${fact.passed ? '✓' : '✗'}</span> <span class="muted">${esc(fact.detail)}</span>` : '';
    return `<tr><th>${id}</th><td>${esc(REQUIREMENTS[id])}</td><td>${verdict}</td><td>${detail}</td></tr>`;
  }).join('')}</tbody></table>`;
  if (b.related.length) {
    html += `<h3>Related bugs</h3><table class="related"><tbody>${b.related.map((r) => `<tr><th>${jiraLink(r.key, ctx, esc(r.key))}</th><td class="muted">${esc(r.reason)}</td></tr>`).join('')}</tbody></table>`;
  }
  if (b.history.length > 1) {
    // Every check of the bug, oldest first: what each found missing, so what the reporter added shows.
    html += `<h3>Checks</h3><table class="history"><tbody>${b.history
      .map((run, i) => {
        const found = run.error ? `<span class="err">${esc(run.error)}</span>` : `<span class="muted">${run.missing.length ? `missing ${run.missing.join(' ')}` : 'nothing missing'}</span>`;
        const comment = run.comment ? `<details><summary>comment</summary><div class="jira-comment">${commentHtml(run.comment, b.reporter)}</div></details>` : '';
        return `<tr><td class="time">${fmtTime(run.at)}</td><td class="muted">${i === 0 ? 'first check' : 're-check'}</td><td>${found}${comment}</td></tr>`;
      })
      .join('')}</tbody></table>`;
  }
  return html;
}

function commentBlock(b: BugView): string {
  if (result(b) === 'skipped') return `<p class="muted">${SKIPPED}</p>`;
  if (b.status === 'posting') return `<p class="warn">The service stopped while posting this comment. Look in Jira: if it is not there, requeue the bug.</p><div class="jira-comment">${commentHtml(b.comment ?? '', b.reporter)}</div>`;
  if (result(b) === 'error') return '<p class="muted">No comment: the check did not finish.</p>';
  if (!b.comment) return '<p class="muted">Nothing is missing, so the bug got no comment.</p>';
  return `<div class="jira-comment">${commentHtml(b.comment, b.reporter)}</div>`;
}

/**
 * The comment as Jira shows it: the mention by name, `- item` lines as a list, `- -item-` struck
 * through. Only what the service produces (verdict.ts), nothing more of Jira's markup.
 */
export function commentHtml(comment: string, reporter: string | null): string {
  const mention = `@${reporter ?? 'reporter'}`;
  const out: string[] = [];
  let items: string[] = [];
  const flush = (): void => {
    if (items.length) out.push(`<ul>${items.join('')}</ul>`);
    items = [];
  };
  for (const raw of comment.split('\n')) {
    const line = raw.replace(MENTION, mention);
    const item = /^- (.+)$/.exec(line.trim());
    if (item) {
      const struck = /^-(.+)-$/.exec(item[1]!.trim());
      items.push(struck ? `<li><s>${esc(struck[1]!.trim())}</s></li>` : `<li>${esc(item[1])}</li>`);
      continue;
    }
    flush();
    if (line.trim()) out.push(`<p>${esc(line)}</p>`);
  }
  flush();
  return out.join('');
}

// ---- Pieces

export function resultLabel(b: BugView): string {
  switch (b.status) {
    case 'dry_run':
      return 'comment · dry run';
    case 'commented':
      return 'commented';
    case 'retry':
      return `retrying · ${b.attempts} of ${MAX_ATTEMPTS} failed`;
    case 'failed':
      return 'check failed';
    case 'posting':
      return 'interrupted while posting';
    case 'complete':
      return 'no comment';
    case 'skipped':
      return 'skipped';
    default:
      return b.status;
  }
}

const kv = (rows: [string, string][]): string => `<dl class="kv">${rows.map(([k, v]) => `<dt>${esc(k)}</dt><dd>${v}</dd>`).join('')}</dl>`;

const bugLink = (key: string): string => (KEY.test(key) ? `<a class="key" href="/bugs/${key}">${key}</a>` : esc(key));

function jiraLink(key: string, ctx: PageContext, text = 'Jira'): string {
  if (!KEY.test(key)) return '';
  return `<a class="jira" href="${esc(ctx.jiraBaseUrl)}/browse/${key}" target="_blank" rel="noopener">${text}</a>`;
}

/** Bugs checked per day as stacked bars; the busiest day fills the height, its count above it. */
export function dayChart(days: Day[]): string {
  const col = 24;
  const bar = 16;
  const area = 100;
  const top = Math.max(0, ...days.map((d) => d.counts.no_comment + d.counts.comment + d.counts.error));
  const parts: string[] = [];
  days.forEach((d, i) => {
    const x = i * col + (col - bar) / 2;
    let y = 14 + area;
    for (const kind of ['no_comment', 'comment', 'error'] as const) {
      const h = top ? (d.counts[kind] * area) / top : 0;
      if (h > 0) {
        y -= h;
        parts.push(`<rect class="${kind}" x="${x}" y="${y.toFixed(1)}" width="${bar}" height="${h.toFixed(1)}"/>`);
      }
    }
    const total = d.counts.no_comment + d.counts.comment + d.counts.error;
    if (total) parts.push(`<text class="count" x="${x + bar / 2}" y="${(y - 3).toFixed(1)}">${total}</text>`);
    parts.push(`<text class="day${i === days.length - 1 ? ' today' : ''}" x="${x + bar / 2}" y="${14 + area + 13}">${d.day.getDate()}</text>`);
  });
  return `<svg class="days" viewBox="0 0 ${days.length * col} ${14 + area + 18}" width="100%" role="img" aria-label="Bugs checked per day">${parts.join('')}</svg>`;
}

// ---- Formatting

const EN = 'en-GB';
export const fmtClock = (d: Date): string => d.toLocaleTimeString(EN, { hour: '2-digit', minute: '2-digit', hour12: false });
export const fmtDate = (d: Date): string => d.toLocaleDateString(EN, { day: '2-digit', month: 'short' });
export const fmtTime = (d: Date): string => `${fmtDate(d)} ${fmtClock(d)}`;
export const fmtDay = (d: Date): string => d.toLocaleDateString(EN, { weekday: 'short', day: '2-digit', month: 'short' });

export function span(ms: number): string {
  const minutes = Math.floor(ms / 60_000);
  return minutes >= 60 ? `${Math.floor(minutes / 60)}h ${String(minutes % 60).padStart(2, '0')}m` : `${minutes}m`;
}

/** "just now", "5m ago", "2h 05m ago", "3d 04h ago". */
export function ago(now: Date, then: Date): string {
  const ms = now.getTime() - then.getTime();
  if (ms < 60_000) return 'just now';
  const day = 24 * 60 * 60_000;
  if (ms < day) return `${span(ms)} ago`;
  return `${Math.floor(ms / day)}d ${String(Math.floor((ms % day) / 3_600_000)).padStart(2, '0')}h ago`;
}

export const bugsText = (n: number): string => `${n} bug${n === 1 ? '' : 's'}`;

/** "85% (11)": the percentage, and how many it is. */
export const shareText = (s: Share): string => (s.total ? `${Math.round((s.count * 100) / s.total)}% (${s.count})` : '–');

/** An error message on one line; the whole of it on hover when it is cut. */
function errorText(error: unknown): string {
  const text = typeof error === 'string' ? error : error == null ? '' : String(error);
  const line = cut(text, ERROR_WIDTH);
  return line === text ? esc(text) : `<span title="${esc(text)}">${esc(line)}</span>`;
}

/** One line of at most width characters. */
export function cut(text: string, width: number): string {
  const line = text.split(/\s+/).join(' ').trim();
  return line.length <= width ? line : `${line.slice(0, width - 1)}…`;
}
