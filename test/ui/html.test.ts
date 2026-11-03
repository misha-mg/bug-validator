import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { type PageContext, ago, bugPage, bugsPage, bugsQuery, commentHtml, dayChart, eventText, filterBugs, homePage, resultLabel } from '../../src/ui/html.ts';
import { readBug, readBugs, readRequests } from '../../src/ui/read.ts';
import { ServiceLog } from '../../src/ui/service-log.ts';
import { checksPerDay } from '../../src/ui/stats.ts';
import { DAY, sampleState } from './state.ts';

const state = sampleState();
const bugs = readBugs(state.dbFile);
const requests = readRequests(state.dbFile);
const log = new ServiceLog(state.logFile);
const bugModel = (key: string) => ({ key, bug: readBug(state.dbFile, key), request: requests.find((r) => r.key === key) ?? null });
const status = log.read();
const ctx: PageContext = { jiraBaseUrl: 'https://jira.example.com', dryRun: true, now: state.now };

/** The text of an HTML string: tags gone, whitespace folded. */
const text = (html: string): string =>
  html
    .replace(/<[^>]+>/g, ' ')
    .replace(/&quot;/g, '"')
    .replace(/\s+/g, ' ')
    .trim();
const section = (html: string, cls: string): string => {
  const start = html.indexOf(`<section class="frame ${cls}"`);
  return html.slice(start, html.indexOf('</section>', start));
};

describe('home', () => {
  const html = homePage({ bugs, status, logPath: state.logFile, recent: log.recent, requests }, ctx);
  it('shows the service, the statistics and the gaps', () => {
    const service = text(section(html, 'service'));
    assert.match(service, /State running/);
    assert.match(service, /Last poll 1m ago/);
    assert.match(service, /Mode dry run/);
    assert.match(service, /In Created 7 · 2 waiting/);
    assert.match(service, /Model haiku/);
    assert.match(service, /Claude 2\.0\.30 · oauth_token/);
    assert.match(service, /Poll every 3m/);
    assert.match(service, /Skipped 1 · \d\d \w\w\w/);
    assert.match(service, /Requested KAZ-1 · 2m ago Skipped/, 'the pending request, not the failed one');
    assert.match(section(html, 'service'), /<a class="key" href="\/bugs\/KAZ-1">KAZ-1<\/a> · 2m ago/);

    const tiles = text(html.slice(html.indexOf('<section class="cards">'), html.indexOf('<section class="frame service">')));
    assert.match(tiles, /^Checked today 1 100% \(1\) with comment Checked in 7 days 2 50% \(1\) with comment · 1 failed Checked all time 3 67% \(2\) with comment · 1 failed Field checks passed after the comment 1 of 3 re-checked bugs, all time$/);
    assert.match(html, /<button class="btn theme" type="button"/);

    const problems = text(section(html, 'problems'));
    assert.match(problems, /of 3 bugs checked · all time/);
    assert.match(problems, /^.*R6 HAR file 67% \(2\) R1 Steps to reproduce 33% \(1\)/);
    assert.match(section(html, 'problems'), /<tr class="dim"><th>R2<\/th>/);

    const attention = section(html, 'attention');
    assert.match(text(attention), /RPG-4 .* 3 of 3, gave up Error: agent run timed out/);
    assert.match(attention, /href="\/bugs\/RPG-4"/);

    const activity = text(section(html, 'activity'));
    assert.match(activity, /KAZ-2 re-check: comment · dry run · missing R4 R6/);
    assert.match(activity, /service started · dry run · haiku/);
  });
  it('says so when there is no log, no database and no failed check', () => {
    const empty = homePage({ bugs: [], status: null, logPath: '/x/service.log', recent: [], requests: [] }, { ...ctx, dryRun: null });
    const page = text(empty);
    assert.match(page, /State no log at \/x\/service.log/);
    assert.match(page, /Database none yet/);
    assert.match(page, /No bug has been checked yet/);
    assert.match(page, /No check has failed/);
    assert.match(page, /Nothing logged yet/);
    assert.match(page, /Checked today 0 no checks/);
    assert.doesNotMatch(empty, /<span class="pill[^"]*">(dry run|live)</);
  });
  it('the chart has one bar per day, stacked in order, with its count', () => {
    const svg = dayChart(checksPerDay(bugs, state.now, 30));
    assert.equal((svg.match(/<text class="day/g) ?? []).length, 30);
    assert.match(svg, /<text class="day today"[^>]*>\d+<\/text><\/svg>$/);
    // Today: one comment on a scale of one, the full height; a day with an error above a day with nothing.
    assert.equal((svg.match(/<rect/g) ?? []).length, 4);
    assert.match(svg, /<rect class="comment" x="[\d.]+" y="14.0" width="16" height="100.0"\/><text class="count"[^>]*>1<\/text>/);
    assert.match(svg, /<rect class="error"/);
    assert.match(svg, /<rect class="no_comment"/);
    assert.doesNotMatch(dayChart(checksPerDay([], state.now, 7)), /<rect/);
  });
  it('writes each event as one line', () => {
    const at = (event: string, fields: Record<string, unknown> = {}) => eventText({ ts: state.now, level: 'info', event, fields });
    assert.equal(at('bug_complete', { key: 'KAZ-1', missing: [] }), 'complete, no comment · nothing missing');
    assert.equal(at('comment_posted', { key: 'KAZ-1', missing: ['R1'] }), 'comment posted · missing R1');
    assert.equal(at('check_failed', { key: 'KAZ-1', attempts: 2, error: 'x <y>' }), 'check failed · attempt 2 · x &lt;y&gt;');
    assert.equal(at('check_failed', { key: 'KAZ-1', recheck: true, error: 'x' }), 're-check failed · x');
    assert.equal(at('key_changed', { from: 'RPG-1', to: 'KAZ-2' }), 'moved: RPG-1 → KAZ-2');
    assert.equal(at('poll_failed', { error: 'HTTP 503' }), 'poll failed · HTTP 503');
    assert.equal(at('request_failed', { key: 'KAZ-1', error: 'HTTP 404' }), 'request failed · HTTP 404');
    assert.equal(at('comment_dry_run', { key: 'KAZ-1', requested: true, recheck: true, missing: ['R1'] }), 'requested · re-check: comment · dry run · missing R1');
    const long = `HTTP 403 on GET /search?${'x'.repeat(200)}`;
    const line = at('poll_failed', { error: long });
    assert.ok(line.startsWith(`poll failed · <span title="${long}">HTTP 403 on GET /search?xxx`) && line.endsWith('…</span>'));
    assert.equal(line.length, long.length + 'poll failed · <span title="">'.length + 120 + '</span>'.length);
    assert.equal(at('first_start', { skipped: ['KAZ-1', 'RPG-2'] }), 'first start · 2 bugs already in Created skipped');
    assert.equal(at('check_deferred', { key: 'KAZ-1', error: 'HTTP 500' }), 'check put off · HTTP 500');
    assert.equal(at('request_failed', { key: 'KAZ-1', error: 'HTTP 503', gaveUp: true }), 'request failed, gave up · HTTP 503');
    assert.match(at('comment_adopted', { key: 'KAZ-1', commentId: '7' }), /found the service&#39;s comment in Jira \(7\)/);
    assert.equal(at('comment_edited', { key: 'KAZ-1', changed: false, missing: [] }), 're-check: comment unchanged · nothing missing');
    assert.equal(at('comment_posted', { key: 'KAZ-1', byHand: true, commentId: '7' }), 'comment posted by hand');
    assert.equal(at('post_failed', { key: 'KAZ-1', error: 'the comment changed', gaveUp: false }), 'post failed · the comment changed');
    assert.equal(at('something_new'), 'something_new');
  });
});

describe('bugs', () => {
  it('lists bugs by day with their result, filtered by result and search', () => {
    const html = bugsPage(bugs, bugsQuery(new URLSearchParams()), ctx);
    const keys = [...html.matchAll(/<a class="key" href="\/bugs\/([A-Z]+-\d+)"/g)].map((m) => m[1]);
    assert.deepEqual(keys, ['KAZ-2', 'RPG-4', 'KAZ-3', 'KAZ-5', 'KAZ-1']);
    assert.equal((html.match(/<tr class="day">/g) ?? []).length, 5);
    const page = text(html);
    assert.match(page, /All bugs 5 bugs/);
    assert.match(page, /KAZ-2 Jira Ports table is empty after clearing the filter \d\d:\d\d comment · dry run R4 R6 1 3/);
    assert.match(page, /KAZ-3 Jira Login page freezes \d\d:\d\d no comment/);
    assert.match(page, /\w\w\w \d\d \w\w\w KAZ-1 Jira \d\d:\d\d skipped$/);
    assert.match(html, /<span class="req" title="HAR file">R6<\/span>/);

    const commented = bugsPage(bugs, bugsQuery(new URLSearchParams('result=comment')), ctx);
    assert.deepEqual([...commented.matchAll(/<a class="key" href="\/bugs\/([A-Z]+-\d+)"/g)].map((m) => m[1]), ['KAZ-2', 'KAZ-5']);
    assert.match(text(commented), /All bugs · with comment 2 bugs/);
    assert.match(commented, /<a class="chip on" href="\/bugs\?result=comment&q=">with comment<\/a>/);

    const searched = bugsPage(bugs, bugsQuery(new URLSearchParams('q=LOGIN')), ctx);
    assert.deepEqual(filterBugs(bugs, { result: 'all', q: 'login' }).map((b) => b.key), ['KAZ-3']);
    assert.match(text(searched), /All bugs · “LOGIN” 1 bug/);
    assert.match(searched, /<input class="field" type="search" name="q" value="LOGIN"/);
    assert.match(text(bugsPage(bugs, bugsQuery(new URLSearchParams('result=nonsense&q=zzz')), ctx)), /No bug matches/);
  });
  it('escapes what the database holds', () => {
    const html = bugsPage(bugs, bugsQuery(new URLSearchParams('q=<script>')), ctx);
    assert.doesNotMatch(html, /<script>/);
    assert.match(html, /value="&lt;script&gt;"/);
    assert.match(bugsPage(bugs, bugsQuery(new URLSearchParams()), ctx), /Device list is cut &lt;b&gt;/);
  });
});

describe('one bug', () => {
  it('shows the facts, the requirements, the related bugs, the history and the comment', () => {
    const html = bugPage(bugModel('KAZ-2'), ctx);
    const page = text(html);
    assert.match(page, /KAZ-2 Ports table is empty after clearing the filter/);
    assert.match(page, /Reporter A Tester Result comment · dry run Checked \d\d \w\w\w \d\d:\d\d Checks 3 · first \d\d \w\w\w \d\d:\d\d Jira https:\/\/jira.example.com\/browse\/KAZ-2/);
    assert.match(html, /href="https:\/\/jira.example.com\/browse\/KAZ-2"/);
    assert.match(page, /R6 HAR file missing ✗ detail of R6/);
    assert.match(page, /R1 Steps to reproduce ok ✓ detail of R1/);
    assert.match(page, /R7 Project matches the product ok/);
    assert.match(page, /Related bugs KAZ-1 the same empty table/);
    assert.match(page, /Checks .* first check missing R1 R4 R6 comment .* re-check VerdictError: a re-check must keep the comment .* re-check missing R4 R6 comment/);
    assert.match(page, /Comment dry run · not posted @A Tester Please add: Steps to reproduce Affects versions HAR file/);
    assert.match(html, /<li><s>Steps to reproduce<\/s><\/li><li>Affects versions<\/li>/);
    assert.match(html, /<form class="request" method="post" action="\/requests"><input type="hidden" name="key" value="KAZ-2"><button class="btn primary">Check again<\/button>/);
    assert.doesNotMatch(page, /Request /);
  });
  it('shows the check asked for: pending, failed, or for a bug not checked yet', () => {
    const pending = bugPage(bugModel('KAZ-1'), ctx);
    assert.match(text(pending), /Request waiting · 2m ago/);
    assert.doesNotMatch(pending, /name="key" value="KAZ-1"/, 'already asked: no button');
    const unknown = bugPage(bugModel('KAZ-77'), ctx);
    assert.match(text(unknown), /KAZ-77 Request failed · JiraError: HTTP 404 on GET \/issue\/KAZ-77 Jira .* Not checked yet\./);
    assert.match(unknown, /<input type="hidden" name="key" value="KAZ-77"><button class="btn primary">Check<\/button>/);
    assert.doesNotMatch(unknown, /Requirements/);
  });
  it('offers to post a comment Jira does not have, behind a confirmation that names the check read', () => {
    const html = bugPage(bugModel('KAZ-2'), ctx);
    assert.match(html, /<a class="btn" href="\/bugs\/KAZ-2\?post" data-dialog="confirm-post">Post to Jira<\/a><dialog id="confirm-post" class="frame confirm" aria-labelledby="confirm-post-title">/);
    const dialog = html.slice(html.indexOf('<dialog'), html.indexOf('</dialog>'));
    assert.match(text(dialog), /Post this comment to KAZ-2\? checked .* mentions A Tester: Jira notifies them\. .* dry run: this one comment is posted all the same.* @A Tester Please add: Steps to reproduce Affects versions HAR file Post Cancel/);
    assert.match(dialog, new RegExp(`<form method="post" action="/posts"><input type="hidden" name="key" value="KAZ-2"><input type="hidden" name="checked" value="${readBug(state.dbFile, 'KAZ-2')!.checkedAt.toISOString()}">`));
    assert.doesNotMatch(text(bugPage(bugModel('KAZ-2'), { ...ctx, dryRun: false })), /dry run: this one/);
    assert.match(bugPage({ ...bugModel('KAZ-2'), confirmPost: true }, ctx), /<dialog [^>]* open>/, 'open without JavaScript');

    const pending = bugPage({ ...bugModel('KAZ-2'), post: { key: 'KAZ-2', at: state.now, error: null } }, ctx);
    assert.match(text(pending), /Post waiting · just now/);
    assert.doesNotMatch(pending, /Post to Jira|<dialog/, 'already asked: no button');
    const failed = bugPage({ ...bugModel('KAZ-2'), post: { key: 'KAZ-2', at: state.now, error: 'Error: the comment changed' } }, ctx);
    assert.match(text(failed), /Post failed · Error: the comment changed/);
    assert.match(failed, /Post to Jira/, 'asked again after a failure');
    for (const key of ['KAZ-3', 'RPG-4', 'KAZ-1']) assert.doesNotMatch(bugPage(bugModel(key), ctx), /Post to Jira/, `${key} has no comment to post`);
    const posted = { ...readBug(state.dbFile, 'KAZ-2')!, status: 'commented' as const, commentId: '7' };
    assert.doesNotMatch(bugPage({ key: 'KAZ-2', bug: posted, request: null }, ctx), /Post to Jira/, 'already in Jira');
  });
  it('explains a failed, a skipped and a complete bug', () => {
    const failed = text(bugPage(bugModel('RPG-4'), ctx));
    assert.match(failed, /Result check failed .* Error Error: agent run timed out/);
    assert.match(failed, /The check did not finish\./);
    assert.match(failed, /No comment: the check did not finish\./);
    const skipped = text(bugPage(bugModel('KAZ-1'), ctx));
    assert.match(skipped, /Never checked\./);
    assert.match(skipped, /Skipped: the bug was already in Created/);
    const complete = text(bugPage(bugModel('KAZ-3'), ctx));
    assert.match(complete, /Nothing is missing, so the bug got no comment\./);
    assert.doesNotMatch(complete, /Related bugs|Checks \d/);
  });
  it('renders the comment as Jira shows it', () => {
    assert.equal(commentHtml('[~accountid:1]\nPlease add:\n- Steps to reproduce\n- -HAR file-\n\nSee KAZ-1 <x>', 'A Tester'), '<p>@A Tester</p><p>Please add:</p><ul><li>Steps to reproduce</li><li><s>HAR file</s></li></ul><p>See KAZ-1 &lt;x&gt;</p>');
    assert.equal(commentHtml('[~accountid:1] hi', null), '<p>@reporter hi</p>');
  });
  it('labels every status', () => {
    const labels = bugs.map(resultLabel);
    assert.deepEqual(labels, ['comment · dry run', 'check failed', 'no comment', 'comment · dry run', 'skipped']);
    const retry = { ...bugs[1]!, status: 'retry' as const, attempts: 1 };
    assert.equal(resultLabel(retry), 'retrying · 1 of 3 failed');
    assert.equal(resultLabel({ ...retry, status: 'posting' }), 'interrupted while posting');
    assert.equal(resultLabel({ ...retry, status: 'commented' }), 'commented');
  });
  it('writes a time ago in short words', () => {
    const now = state.now;
    assert.equal(ago(now, now), 'just now');
    assert.equal(ago(now, new Date(now.getTime() - 5 * 60_000)), '5m ago');
    assert.equal(ago(now, new Date(now.getTime() - 125 * 60_000)), '2h 05m ago');
    assert.equal(ago(now, new Date(now.getTime() - 3 * DAY - 4 * 3_600_000)), '3d 04h ago');
  });
});
