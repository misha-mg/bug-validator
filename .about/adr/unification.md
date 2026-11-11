# One product line: bug-validator reads, runs and is operated as pipeline-ui is

Date: 2026-11-04

bug-validator and pipeline-ui are two services of one author for one team: each polls a system,
runs an agent, keeps a SQLite record and shows it in a web console on the office network, under
systemd user units on the same server. They grew apart in small ways — `src/` against `server/`,
`docs/` against `.about/`, `node --test` against vitest, `DB_FILE` against `PIPELINE_DB`, two
ways to write a date — and every difference was something to remember when walking from one to
the other. From this change on, the two follow one set of conventions, kept in both
repositories' `CLAUDE.md`:

- **The layout.** `bin/bug-validator` execs `server/cli.ts`; `server/` holds the service with
  `config.ts`, `log.ts`, `format.ts`, `store/` and `http/`; `ui/` what the browser gets;
  `deploy/` the units; `.about/` the PRD (`prd/bug-validator.md`), the ADRs, the glossary, the
  architecture, the Jira reference and the open ideas. Tests sit next to the code as `*.test.ts`,
  fixtures in `test/fixtures/`.
- **The shared modules.** `server/format.ts` (dates `2026-11-04 23:10`, durations `1h 05m` /
  `5m 03s`, `5m 03s ago`, day rows `Tue 04 Nov`), `server/log.ts` (one JSON line per event,
  `parseLogLine`) and `server/http/guard.ts` (the security headers, the Host check, the
  same-origin check, the login, the body cap) are the same files in both repositories, byte for
  byte; an edit to one is copied to the other. The pages' own formatting helpers went.
- **The environment.** Everything of the service's own is `VALIDATOR_*` (pipeline-ui:
  `PIPELINE_*`), the console's settings `VALIDATOR_HOST`, `_PORT`, `_HOSTNAMES`, `_USER`,
  `_PASSWORD`; `JIRA_BASE_URL`, `JIRA_EMAIL`, `JIRA_API_TOKEN`, `JIRA_CLOUD_ID` and
  `CLAUDE_CODE_OAUTH_TOKEN` are the same names in both. An old name set while the new one is not
  refuses the start, naming the rename. The company's values left the code: the Jira site and
  the WebUI repository have no default, and the cloud id is read from the site's
  `/_edge/tenant_info` when it is not given, as pipeline-ui does.
- **The heartbeat.** The service writes its pid and the time into `meta` every 5 s; the console
  calls it running while the heartbeat is fresh, instead of guessing from how long the log has
  been quiet.
- **The tools.** vitest runs the tests, prettier formats the code (`.prettierrc.json`,
  `.prettierignore` the same in both), and the npm scripts have the same names: `start`,
  `check`, `test`, `format`. Conventional Commits.
- **The look.** `sheet.css` is pipeline-ui's; bug-validator holds a copy under `ui/`, refreshed
  by `npm run sheet:sync` and checked by `server/http/sheet.test.ts` (below, The pages).

## The pages (2026-11-05)

The console now has the three pages pipeline-ui's has, under the same names in the masthead —
**Cockpit** (`/`), **Bugs** (`/bugs`), **Statistics** (`/stats`) — and a bug's page under Bugs.
A person walking from one console to the other finds the same things in the same places: cards
across the top of the cockpit for what is going on now, state sources folded to a lamp, what
needs attention and the latest events; a filters row of counted chips over a wide table; a strip
of numbers, bars and stacked columns per day on the statistics page. Before, the home page held
everything at once — the service's facts, three period tiles, a chart, the gaps, the attention
list and the activity — and the numbers had no period of their own.

The pages are drawn only with the sheet's parts, so every reusable part lives in pipeline-ui's
`sheet.css` and bug-validator's `app.css` only lays them out. That holds for the column chart too:
the sheet documents the SVG markup it styles (`div.columns`, `ul.legend`, `div.plot`, the grid,
the columns' parts, the dates, the hit rects, `div.tip`), pipeline-ui writes it in the browser
(`Columns.vue`) and bug-validator writes the same markup on the server (`view.ts`,
`columnChart`), with `app.js` adding the tooltip from the hits' `data-*`. Drawing the chart its
own way would have meant a second set of chart rules to keep in step; following the contract
means one stylesheet styles both charts and a change to the chart's look is made once. The one
difference is forced by where it is drawn: the server does not know the frame's width, so the
columns are placed in percentages of the plot and the axis numbers sit in its left padding.

Toasts follow the same rule with no framework: a POST redirects with `?toast=<kind>:<text>`,
`app.js` renders the sheet's toast markup and drops the parameter, and a page without JavaScript
shows the text as a notice — the console keeps working with JavaScript off, as it always has.

## The mark and the page grids are the sheet's (2026-11-10)

The masthead's mark is drawn by the sheet (pipeline-ui's ADR glass-kit, The mark), so the
`<img>` this console put before its name and its rules in `app.css` went: with both, the mark
showed twice. `.cockpit` and `.stats-pair`, which each console had in its own stylesheet, are
the sheet's too, with one set of breakpoints; `app.css` keeps only what is this console's own.
`ui/logo.svg` stays as the tab's icon.

## The tools' frame (2026-11-11)

The team's other tools (the `tools` repository, served from one server behind a start page, the
portal) are framed alike: the logo in the header leads to the start page ("All tools"), and a
footer names the build, `Build v1.4.2 (commit)`, the version counted from the tool's commits by
its `scripts/version.sh` (a `feat` the minor, a breaking commit the major, any other the patch;
nothing tagged). The two consoles are tools of the same team kept in repositories of their own,
so they take the same frame:

- **The mark leads to the start page** where `VALIDATOR_PORTAL_URL` names one (pipeline-ui:
  `PIPELINE_PORTAL_URL`): an `a.home` before the name, which still leads to the cockpit. Unset,
  nothing changes: the address is a deployment's, and a console opened from outside the office
  network cannot reach the portal, so no address is written into the code.
- **The foot names the build**: the version by the same `scripts/version.sh`, the commit, a `+`
  when the working tree has moved on from it, the commit a link where origin is GitHub or
  Bitbucket (a login in the remote's address is never passed on). `server/version.ts` reads it
  once when the process starts, since a service runs the code it was started with; the service
  logs it in `service_start`, the console in `ui_start`. It is the fourth file the two
  repositories keep byte for byte the same.
- **Both are the sheet's parts** (`.masthead .home`, `.foot`), so the two consoles draw them alike.

Not taken: the tools' copyright line (pipeline-ui is under the MIT licence, and "all rights
reserved" would contradict it; the line is the owner's to decide), their full logo (the sheet
keeps its square mark) and their palette.

## Considered options

- **One repository for both** — one history, one node_modules, but two services with different
  lifecycles, deployments and secrets, and pipeline-ui's UI build would weigh on a service that
  has none. Two repositories, one set of conventions.
- **A shared npm package for format, log and guard** — a third thing to version and publish for
  three small files. A byte-identical copy, checked by eye on each edit, is enough at this size;
  a package can come when a fourth file joins.
- **Keep the old names with the new as aliases** — a deployment would keep running on a name
  nobody reads any more, and a typo would fall back to a default in silence. A refusal that
  names the rename costs one restart.

## Consequences

- `.env` on the server must be rewritten to the new names before the next restart; the start
  says which ones.
- `JIRA_BASE_URL` and `VALIDATOR_WEBUI_REPO_URL` must be in `.env`; a fresh clone no longer
  knows the company's site or repository.
- An edit to `format.ts`, `log.ts` or `guard.ts` is made in both repositories, or in neither.
