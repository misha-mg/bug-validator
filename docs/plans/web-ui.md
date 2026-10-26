# Plan: a web UI in place of the TUI

Status: plan, to be implemented. When the work lands, its substance goes into `architecture.md`,
`prd.md` (a dated decision) and `CLAUDE.md`, and this file is deleted: the docs describe the
current state, not plans.

## Goal

A local web page that shows everything the TUI shows today, in a form that is easier to read
(links, hover details, a real chart, the comment as Jira renders it), and that is cheaper to
keep: same language and runtime as the service, no second toolchain, no duplicated schema or
requirement names, no build step, no dependencies beyond what the service has.

## Decisions

1. **Same stack as the service.** TypeScript on Node 24, `node:http` + `node:sqlite`, no
   framework, no bundler, no new npm dependency. The UI imports `REQUIREMENTS` from
   `src/domain/bug.ts`, `CheckStatus` from `src/db/store.ts` and `listedItems` from
   `src/domain/verdict.ts`, so two of the three "shared things" in `CLAUDE.md` stop being shared
   by hand. Only the log event names stay a contract between `log.ts` callers and the UI.
2. **HTML rendered on the server; the browser only refreshes.** Every page is a pure function
   `model → HTML string`, tested with `node:test` like the rest. The client script is about 20
   lines: fetch the same URL every 5 s, swap `<main>` when the HTML changed. No client-side
   state, no routing, no templates in two places. Every page works with JavaScript off (minus
   the auto-refresh).
3. **A separate process, read-only.** `node src/main.ts ui` is its own systemd unit, like the TUI
   was its own program: the UI's first job is to say whether the service is running, so it must
   not die with it. It opens the database read-only on every request and never creates it; it
   reads the log incrementally. It writes nothing anywhere.
4. **LAN only, no auth, nothing else.** The UI runs on the server next to the service and is
   opened from the office network as `http://<server-ip>:8081/`. It binds to all interfaces;
   there is no login, no TLS, no reverse proxy, no public exposure, and none of these is
   planned. No external resources (fonts, CDNs): the page is self-contained and works on a
   network without internet access.
5. **The TUI is removed in the last step**, once the UI shows everything it showed. Two views
   of the same data are one too many to keep current (`quality-bar`: delete redundancy rather
   than document it). `tui/`, `npm run tui`, `uv`, and every TUI mention in the docs go.

## Pages

Three URLs. Times are shown in the server's local time, as the TUI did (same machine).

### `/` — Home

What the TUI home shows, plus the service's settings and recent activity.

| Block | Content | Source |
|---|---|---|
| Service | State: **running** / **stopped · 2h ago** / **silent · 1h 10m** (same rule as the TUI: silent after two intervals + 5 min, or no log at all); last poll (or **failed · ago** + the error); mode **dry run** / **live**; in Created `N · M waiting`; started; model; claude version and auth (`oauth_token` / `cli_login`); poll interval; skipped at the first start `N · date`; "no log at …" when the log is missing | `service.log` |
| Statistics | Table Today / 7 days / All time × Checked, Without comment `85% (11)`, With comment, Check failed (red when > 0). New row: **Items added after the comment** `k of n asked` — over bugs whose latest comment has struck-through items; `listedItems()` counts struck vs listed | `checks` |
| Checked per day | SVG stacked bars for the last 30 days (no comment / comment / error, errors on top), count above each bar, day numbers below, legend; a day with nothing is an empty column. Fixed 30 days: a page has the width | `checks` |
| Most common gaps | R1–R7 with name, bar and `share (count)` of first checks that found it missing, most common first; "of N checked · all time"; a requirement never found missing is dimmed | `checks` + `runs` |
| Needs attention | Failed checks, latest first: key (link), last try, `attempts of 3` (+ "gave up"), error (full, wrapped); `posting` rows here with "interrupted while posting · look in Jira". Hidden with "No check has failed." when empty | `checks` |
| Activity (new) | The last 30 non-poll events from the log, latest first: time, key (link), one line each — `comment · dry run · missing R1 R6`, `complete`, `comment posted / edited`, `re-check`, `check failed · <error>`, `key changed A → B`, `mentions stripped`, `poll failed`, `service start / stop`, `fatal`. A dry run is reviewed by reading these | `service.log` |

Header on every page: "Bug validator", links Home · Bugs, the mode (dry run / live) as a badge.

### `/bugs` — All bugs

The TUI's list, with filtering by URL instead of keys.

- Query: `?result=all|comment|no_comment|error|skipped` as chips (links), `?q=` as a search
  form (GET, Enter submits; matches key, summary, reporter, case-insensitive). The title says
  what narrows the list ("All bugs · with comment · “login”").
- Rows grouped by the day of the last check (a heading row per day), latest first. Columns:
  key (link to the bug page, with a small Jira link beside it), summary (one line, cut with an
  ellipsis, full text in `title`), checked `HH:MM`, result (coloured label exactly as the TUI:
  `comment · dry run`, `commented`, `no comment`, `retrying · 1 of 3 failed`, `check failed`,
  `interrupted while posting`, `skipped`), missing as chips `R1 R6` (requirement name in
  `title`), related count, **checks** count (new: `2` when the bug was re-checked).
- A row is a link to `/bugs/<KEY>`.

### `/bugs/<KEY>` — One bug

- Header: key, summary, reporter, result label, checked at, `checks: 3 · first <date>`,
  error (if any), Jira link.
- Requirements: R1–R7 × *Agent* (`missing` / `ok`) × *Base check* (`✓`/`✗` + detail). The
  detail is the full string, not cut.
- Related bugs: key (Jira link) and the reason.
- Checks (history), oldest first, each run: time, `first check` / `re-check`, what it found
  missing or its error, and the comment it recorded in a collapsed `<details>` (new: the TUI
  showed only the list). Shown only when there is more than one run.
- Comment, as it is or would be in Jira: the mention as `@Reporter`, `- item` as a list,
  `- -item-` struck through, the rest as text. Subtitle: `dry run · not posted`, `posted to
  Jira`, `interrupted while posting · look in Jira: if it is not there, requeue the bug`. The
  same three fallback texts as the TUI for skipped / failed / nothing missing.
- Unknown or malformed key → 404 / 400.

## Modules

```
src/
  main.ts                 + `ui` command
  config.ts               Env split: shared fields (JIRA_BASE_URL, DB_FILE) picked by the UI's schema
  commands/ui.ts          loads the UI config, starts the server, logs `ui_start` {host, port}, stops on SIGTERM
  ui/
    config.ts             UiConfig: dbFile, logFile, jiraBaseUrl, host, port
    read.ts               the database, read-only → BugView[]; [] when there is no database or no table yet
    service-log.ts        service.log → ServiceStatus + recent events; incremental, restarts on truncation
    stats.ts              periodStats, problems, checksPerDay, needsAttention, itemsAddedAfterComment
    html.ts               layout, homePage, bugsPage, bugPage, comment rendering, the SVG chart, esc()
    server.ts             node:http: routes, 404/400, headers (no-store, CSP default-src 'self')
    static/app.css        theme (the TUI's colours: blue frames, green ok, pink comment, red error), light/dark via prefers-color-scheme
    static/app.js         the 5-second refresh
deploy/bug-validator-ui.service
test/ui/*.test.ts
```

### `read.ts`

```ts
type Result = 'comment' | 'no_comment' | 'error' | 'skipped';   // RESULTS table of the TUI's checks.py
interface Run { at: Date; missing: RequirementId[]; comment: string | null; error: string | null }
interface BugView {
  key: string; status: CheckStatus; attempts: number; checkedAt: Date;
  summary: string | null; reporter: string | null;
  baseChecks: BaseCheck[]; missing: RequirementId[]; related: { key: string; reason: string }[];
  comment: string | null; commentId: string | null; error: string | null;
  history: Run[];                       // oldest first; [] on rows from before runs were kept
}
readBugs(dbFile): BugView[]            // latest check first
result(status): Result; firstMissing(bug): RequirementId[]; checked(bug): boolean
```

`new DatabaseSync(file, { readOnly: true })` per request, closed in `finally`. A missing file,
a missing table or a non-database file → `[]` (the service may be creating it). `SELECT *` on
`checks`, then `runs ORDER BY at, rowid`; times parsed from ISO UTC. Never `PRAGMA`, never a
write: the UI must not create the database (a stray empty one would look like a first start).

### `service-log.ts`

A port of `tui/.../service.py`: `ServiceStatus` (started, dryRun, model, pollInterval,
claudeVersion, claudeAuth, stopped, lastSeen, lastPoll, inQuery, waiting, pollError) built line
by line from the file's new bytes since the last read; a partial last line waits for the next
read; a file shorter than the offset is read again from the start. Lines that are not JSON (a
stack trace) are skipped. Plus `recent: LogEvent[]`, the last 30 events other than `poll`,
with `ts`, `event`, `key` and a one-line text made in `html.ts`. `liveness(status, now)` as the
TUI's.

### `stats.ts`

Ports `stats.py` one to one (`periodStats`, `problems` on `firstMissing`, `checksPerDay` without
skipped bugs, `needsAttention`), and adds `itemsAddedAfterComment(bugs)`: over bugs with a
comment and more than one successful run, `listedItems(comment)` → struck count / listed count.

### `html.ts`

Pure functions returning strings. One `esc()` for every value that reaches the page: summaries,
comments, errors, reporters and base-check details are untrusted text. `commentHtml(comment,
reporter)` handles exactly what the service produces (`verdict.ts`): the mention, `- item`
lines, `- -item-` lines, plain lines; nothing else of Jira markup. `dayChart(days)` returns an
inline `<svg>` with one `<rect>` per stack segment, `<text>` for counts and day numbers, classes
for the colours. Jira links: `${jiraBaseUrl}/browse/${key}` only for keys matching
`^(KAZ|RPG)-\d+$`.

### `server.ts`

`startUi(config): Promise<http.Server>`. Routes: `GET /`, `GET /bugs`, `GET /bugs/:key`,
`GET /app.css`, `GET /app.js`; anything else 404; `HEAD` as GET. Static files are read from
disk per request (no cache; an edit shows on reload). Headers: `Content-Type` with charset,
`Cache-Control: no-store`, `Content-Security-Policy: default-src 'self'`. A request error
(database locked past the 5 s timeout, say) → 500 with the message, logged as `ui_error`. One
`ServiceLog` instance lives for the server's life; the database is reopened per request.

### `static/app.js`

```js
setInterval(async () => {
  if (document.hidden || document.activeElement?.matches('input')) return;
  const html = await (await fetch(location.href, { headers: { Accept: 'text/html' } })).text();
  const next = new DOMParser().parseFromString(html, 'text/html').querySelector('main');
  const main = document.querySelector('main');
  if (next && next.innerHTML !== main.innerHTML) main.innerHTML = next.innerHTML;
}, 5000);
```

Nothing else. No framework, no state.

### `static/app.css`

System font stack, monospace for keys and the comment. CSS variables for the TUI's colours
(`--primary #7aa2f7`, `--ok #9ece6a`, `--comment #f5a3c8`, `--error #e5484d`, `--warning
#e0af68`, `--muted`), dark values under `prefers-color-scheme: dark`, light ones otherwise.
Layout: Home as a two-column grid (Service | Statistics + chart; Gaps | Needs attention;
Activity full width), collapsing to one column under 900 px. About 150 lines; no reset
framework.

## Configuration

Added to `config.ts`'s table in `architecture.md`:

| variable | default | meaning |
|---|---|---|
| `LOG_FILE` | `state/service.log` | the service's log, as the systemd unit writes it; the UI reads it |
| `UI_HOST` | `0.0.0.0` | every interface: the UI is opened from the office network by the server's IP |
| `UI_PORT` | `8081` | |

The UI's schema is `Env.pick({ JIRA_BASE_URL, DB_FILE })` extended with the three above, so the
UI starts without Jira credentials and the defaults are written once. `.env` is loaded the
same way.

## Running and deploying

```
npm run ui                                  # http://<server-ip>:8081/, reads state/
```

`deploy/bug-validator-ui.service`: a copy of the service's unit with `ExecStart=… ui`, its own
log `state/ui.log`, `Restart=always`. Install next to the other unit on the same server;
`architecture.md` Deploy gets the two lines and the URL to open. Make sure the server's
firewall, if any, lets the port through from the office network; nothing else is needed. The Docker note changes from "the TUI has no `service.log`" to the same
about the UI.

## Tests

`node:test`, under `test/ui/`. Databases are built with the real `Store` (no `schema.sql`
copy), logs are temp files. Port the TUI's cases:

- `read.test.ts`: every row latest first; history and the first verdict; a database made
  before `summary`/`reporter`/`runs` existed and rows without a time; a file that is not a
  database; no database yet → `[]`; the UI never creates the file.
- `service-log.test.ts`: mode and last poll; only the added bytes are read and a line cut in
  half is finished; a log started again is read from the start; stopped or silent is not
  running; recent events keep the last 30 and leave out `poll`.
- `stats.test.ts`: counts per period; problems most common first on the first check; checks
  per day without skipped bugs; needs attention; items added after the comment.
- `html.test.ts`: home shows the service, the statistics and the gaps; the chart has one bar
  per day stacked in order with its count; bugs are listed by day with their result and
  filtered by `result` and `q`; a bug shows the comment with the mention by name and the
  strike-through; every untrusted string is escaped (a summary with `<script>`).
- `server.test.ts`: on an ephemeral port: `/`, `/bugs`, `/bugs/KAZ-1`, 404 on an unknown bug
  and path, 400 on `/bugs/x`, the headers, `/app.css` served.

`npm test && npm run typecheck` is the whole check; the `uv run pytest` leg goes.

## Steps

Each step leaves `npm test && npm run typecheck` green. Commit per step; no AI attribution.

1. `ui/config.ts`, `read.ts`, `stats.ts`, `service-log.ts` with their tests. No HTML yet.
2. `html.ts` (layout, the three pages, the comment, the chart) + `static/` + tests.
3. `server.ts`, `commands/ui.ts`, the `ui` command in `main.ts`, `npm run ui`, server tests.
   Run it against the real `state/` and compare each block with the TUI side by side.
4. `deploy/bug-validator-ui.service`; install on the home server, `systemctl --user enable
   --now bug-validator-ui`, check from the browser.
5. Docs: `architecture.md` (Layers; Log table's `TUI` column → `UI`, with the activity events
   marked; Configuration; Running; a `### UI` section replacing `### TUI`; Deploy; Docker note),
   `prd.md` (Success and Rollout mention the UI; a dated decision: web UI in the service's
   stack replaces the TUI, with the reasons of the Decisions section above), `CLAUDE.md` (the
   stage line, the shared-things bullet shrinks to the log events ↔ `service-log.ts`),
   `jira-reference.md` and `open-ideas/*` (TUI → UI). `package.json` description of the
   scripts.
6. Remove the TUI: `tui/`, `npm run tui`, the `.gitignore` lines for `.venv`/pytest, the `tui`
   line in `.dockerignore`, the `uv` mention in `architecture.md`. Delete this plan file.

## Out of scope

- Login, TLS, a reverse proxy, a domain name, exposure outside the office network. The UI is
  `http://<server-ip>:8081/` on the LAN and stays that.
- Any write: requeue, restart, editing instructions. The UI stays read-only; those are CLI.
- Showing which bugs are waiting: the `poll` event logs counts only. If wanted later, add
  `waitingKeys` to the event and a line to the Service block.
- Follow-up after Created (`open-ideas/follow-up-after-comment.md`): the new statistics row
  measures only what arrived while the bug was still in Created.
- Pagination: the list reads every row. Fine to thousands of bugs; revisit when the page is
  slow, not before.
- Agent cost and turns: removed from the TUI on 2026-10-19 on purpose, not brought back.
