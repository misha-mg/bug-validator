# Architecture

A small long-running program plus an agent with one read-only tool. The program does the plumbing
(query, field facts, state, posting) and keeps the guardrails; the agent reads, researches and
writes the comment. Why things are as they are: `prd.md`.

## Layers

```
src/
  main.ts            CLI: run | check <KEY> [--recheck] | request <KEY|URL> | ui | maintain
  config.ts          env → typed Config; fails fast on a bad value
  log.ts             one JSON line per event on stdout
  domain/            pure functions, no I/O
    bug.ts           Bug model, requirement ids R1–R7, which of them are field facts
    checks.ts        base checks: section headings, Affects versions, Devices, HAR
    fingerprint.ts   a hash of the report: what a re-check watches
    prompt.ts        Bug + field facts (+ the previous comment on a re-check) → the agent's prompt
    verdict.ts       the agent's JSON: schema and the guardrails, the comment's lines included
  jira/
    client.ts        REST v2 through api.atlassian.com: search, get issue, myself, changelog; add and edit comment (the only writes)
    mapping.ts       raw issue JSON → Bug; Jira times
    queries.ts       the trigger JQL; the agent's JQL narrowed to KAZ and RPG
  claude/
    agent.ts         spawns `claude -p` with the Jira MCP server as its only tool
    jira-mcp.ts      that server: search_issues, get_issue — read-only, KAZ and RPG only
  db/
    store.ts         SQLite (node:sqlite): one row per bug (by issue id) in `checks`, one per check in `runs`, `meta`, `requests` (checks asked for by hand) and `posts` (comments a person posts from the UI); the schema's migrations; a request written by the UI or the CLI, a post by the UI; a backup
  pipeline/
    deps.ts          what the pipeline needs: config, Jira, agent, store (Jira and agent are interfaces)
    checkBug.ts      one bug: fetch → base checks → agent → verdict → guardrails
    plan.ts          which bugs of a poll are due: first checks, re-checks, the waiting ones
    handle.ts        one check and its record / post / edit; the service's comment found in Jira; which failures are the surroundings'
    requests.ts      the posts and the checks asked for by hand, served before each check of a poll and while the service waits
    poll.ts          one poll: query → first-start bootstrap → moved bugs → plan → checks, requests first
  commands/          run (the loop), check (one bug, writes nothing), request (the service checks a bug next), ui (the web UI), maintain (backup, log size)
  ui/                the web UI: a separate process that reads state/ and writes nothing but check and post requests
    config.ts        UI_HOST, UI_PORT, UI_HOSTNAMES, UI_USER, UI_PASSWORD, plus the service's DB_FILE, LOG_FILE and JIRA_BASE_URL
    read.ts          the database, read-only → one view per bug with its runs, the requests; never creates the file
    service-log.ts   service.log → the service's state and its latest events, read as it grows; /healthz's answer
    stats.ts         counts by period, the most common gaps, bugs per day, items added after the comment
    html.ts          the three pages as pure functions: HTML strings from what was read
    server.ts        node:http: the pages, the static files, /healthz; known hosts, same-origin requests, the optional login
    static/          sheet.css (the design system, shared with pipeline-ui), app.css (the faces and the pages' layout),
                     the fonts (Barlow, OFL), the theme switch (runs in <head>) and the refresh script
agent/instructions.md   the agent's system prompt
deploy/              systemd user units: the service, the UI, and maintain with its daily timer
scripts/late-changes.ts   how reports change after creation (read-only measurement): `node scripts/late-changes.ts [days]`
test/                node:test; fixtures/ are real bugs saved from Jira (REST v2 JSON); ui/ builds its databases with the real Store
```

Dependencies: `zod` only. Node 24 runs the TypeScript directly and ships SQLite; there is no
build step. `claude` must be on PATH. The UI imports the service's tables, statuses and
requirement ids, and nothing of the pipeline: it never loads the agent or the Jira client.

## One bug

1. `poll` runs the trigger JQL and reads every bug's report fields, reporter, comments and times
   in the same request. A row whose issue id comes back under another key (the bug moved between
   KAZ and RPG) takes the new key.
2. `plan` picks the bugs due (constants in `plan.ts`):
   - a first check for a bug with no row once it is 30 minutes old, and for a `retry` row;
   - live, a first check for a `posting` row at once (step 5 finds its comment in Jira);
   - a re-check for a `complete` row, or a `dry_run` row in a dry run (`commented` live), whose
     stored fingerprint differs from the report's now, once `updated` is 15 minutes old;
   - nothing for a bug with 5 runs.

   The rest are counted as waiting when they are not settled yet.
3. `checkBug` fetches the issue, computes the field facts, builds the prompt and runs the agent.
   On a re-check the prompt ends with the comment the service made last time, and the agent
   edits it. The agent searches Jira for related bugs itself and writes the whole comment. The
   reporter's text is fenced by a tag made from that text, so it cannot close its own fence; a
   description past 20 000 characters is cut.
4. Guardrails (`verdict.ts`, `checkBug.ts`), each a failed check when broken:
   - the JSON matches the schema;
   - "comment needed" and the comment agree; a first comment asks for something or names a
     related bug;
   - every failed field fact (R4–R6) is in `missing`;
   - every line of the comment is one of its kinds (the reporter's mention first, `Please add:`,
     `- <item>` or `- -<item>-`, R7's question plain or struck, `Possibly related: KEY (reason)`,
     blank): free text, links and images are refused, whatever the report asked for;
   - the list (R1–R6 by name) is exactly `missing`, and a first comment strikes nothing through;
     R7's question is there exactly when R7 is missing;
   - a re-check keeps the comment, every item of it, its project question and its related lines,
     and strikes through only what it had asked for;
   - the reporter is mentioned and nobody else (other mentions are stripped and logged);
   - every issue key named is a KAZ or RPG issue Jira can read (a read follows a moved bug).

   The related bugs recorded are the ones the comment names.
5. Every check adds a row to `runs` (with the agent's model, cost, turns, time and a hash of its
   instructions), and the bug's row takes the new state and fingerprint:
   - no comment → `complete`;
   - `DRY_RUN=true` → `dry_run` with the comment; a `commented` or `posting` row is left as it
     is and the check goes to `runs` only, so the record of the comment in Jira stays true;
   - live, with a comment id → the edit (skipped when the text is the same), then `commented`;
   - live otherwise: Jira is read for a comment of the service's (by the account `myself`
     returns, opening with the reporter's mention). Found → adopted: the check is a re-check of
     it, and step "with a comment id" follows. None → `posting` with the comment, the post, then
     `commented` with the comment id. A comment id, once recorded, is never forgotten.
6. A failure of this bug's first check → row `retry` with the error; the third in a row →
   `failed` (`attempts` counts failed first checks since the last result). A failed re-check, or
   any failed check of a row with a comment in Jira, sets the row's error and leaves the rest. A
   failure of the surroundings (see Failures) leaves rows alone.

A check asked for by hand (`request <KEY|URL>`, the UI's form) skips steps 1 and 2: the bug
is read by its key, whatever its age, its status in Jira or its row — skipped, failed, at the
cap — and goes through 3–6 as any check. The service serves requests before each check of a poll
and every 2 s while it waits for the next poll; after a failure of the surroundings they wait for
a poll that succeeds. A key Jira does not know fails the request, which keeps the reason until it
is asked again; so does a third failure of the surroundings in a row on it. At most 20 requests
wait at a time. A request asked again while its check runs is kept for another check.

A comment posted by hand (the UI's Post to Jira, after a confirmation) is a row in `posts` with the
text the person read; it is served before the checks, in a dry run as well. Only a comment Jira
does not have can be posted: a `dry_run` row, or a `posting` one. The UI refuses the post when
the bug was checked again after the page was shown; the service refuses it when the row's comment
is no longer the text confirmed, or is in Jira. Then as step 5 live: Jira is read for a comment of
the service's (found → adopted, nothing posted), the row goes `posting`, the post, `commented`
with the comment id. A post Jira refused puts the row back to `dry_run` and fails the request; one
without an answer leaves it `posting` and the request pending, and the next try looks in Jira
first. Failures count as a request's. In a dry run a `commented` row is not re-checked, and a
requested check of it goes to the history only, so the comment posted stays as posted.

## Row statuses

| status | meaning |
|---|---|
| `skipped` | was already in the query at the first start, never checked |
| `complete` | checked, nothing missing, no comment |
| `dry_run` | comment composed and recorded, not posted; a person may post it from the UI |
| `posting` | written before a post whose outcome is unknown (the service stopped, or Jira did not answer); live, the next poll checks it again, finds the comment in Jira if it got there and adopts it; a post by hand tried again does the same |
| `commented` | comment posted (`comment_id` set) |
| `retry` | last attempt failed, tried again at the next poll |
| `failed` | 3 attempts failed, left alone; a request (`request <KEY>`, the UI) checks it again |

A re-check changes a row's comment, not its status. `meta.bootstrapped_at` records the first
start, so a first poll on an empty query still counts. Rows are never deleted. A row holds the
issue id; rows from before 2026-10-26 get it when their bug is next in the query. They have no
fingerprint and no runs, so they are never re-checked.

The schema's version is `PRAGMA user_version`; `Store` (the service, at start) runs the
migrations it lacks, after a copy of the file (`<db>.before-v<N>-<time>`). The UI and `check`
never migrate.

## Failures

These are failures of the surroundings, and cost no bug anything:

- `JiraError` without an answer (network, timeout, a body that did not arrive) or with 401,
  403, 429 or 5xx;
- `AgentError` of kind `start` (claude cannot be started), `service` (Claude's auth, a usage or
  rate limit, overload, a 5xx, the network; or Jira failing a search the agent made), `stopped`
  (the service is stopping: a stop kills the agent run, and the bug is checked again later).

One of them on a bug puts it off (`check_deferred`) and the poll goes on to the next, so a bug
Jira chokes on does not hold up the rest; a second in a row, or one no later check of the poll
gets past, ends the poll with `poll_failed`. Everything else — `VerdictError`, `MappingError`,
an agent run that times out, exits badly or goes over its budget, a 4xx on one issue — is this
bug's failure and costs it an attempt (on a re-check, one of its 5 checks).

Writes: a post Jira refused (it answered with an error) made no comment: the row goes from
`posting` back to `retry`, at the cost of an attempt only for a 4xx other than 401 and 429. A post
without an answer may have made one: the row stays `posting`. An edit refused with such a 4xx (the
comment was deleted) is the bug's failure. At start the service runs `claude --version` and
refuses to start without it.

One service per database: `run` holds `<db>.lock` (host and pid) and refuses to start while a live
process of this service holds it on this host, or while another host's lock is there.

## The agent run

`claude -p` with `--tools ''` (no built-in tools), `--setting-sources ''` (no settings, no
CLAUDE.md), `--strict-mcp-config` with one server (the project's `jira-mcp.ts`, given the
`JIRA_*` variables), `--allowedTools` for its two tools, `--max-turns 25`,
`--max-budget-usd AGENT_MAX_BUDGET_USD`, `--no-session-persistence`, `--json-schema` for the
verdict, `--system-prompt` from `agent/instructions.md` (read on every run: an edit reaches the
next bug without a restart). It runs in a private temp directory (`mkdtemp`, 0700, removed at
exit). The MCP server's config, the Jira token in it, is a 0600 file there, never an argument: a
command line is visible to every user of the machine. The server notes Jira's own failures in
that directory, and a run with one is a `service` failure: a search that failed is not "nothing
found". `AGENT_TIMEOUT_SECONDS` kills a run; a stop of the service kills it too. The agent sees
attachment names only, never their content: a HAR holds session cookies.

## Log

One JSON line per event: `ts`, `level`, `event`, then fields. The UI reads them all
(`src/ui/service-log.ts`, `html.ts`): the Service block from the ones marked, the Activity block
from every event but `poll` and `check_start`, one line each.

| event | fields | UI |
|---|---|---|
| `service_start` | dryRun, pollIntervalS, maxAttempts, model, agentTimeoutS, claudeVersion, claudeAuth, host, dbFile (absolute), bugs (rows) | mode, model, claude, interval, started; ends a check cut short |
| `service_stopping` | signal | stopping |
| `service_stopped` | | stopped |
| `poll` | inQuery, waiting, pending, checked, failed, deferred, ms | last poll, in Created, waiting |
| `poll_failed` | error, ms, requests (when the waiting loop's requests failed) | last poll failed, error, failures in a row |
| `first_start` | skipped (the keys) | |
| `key_changed` | from, to | |
| `check_start` | key, recheck, requested | liveness, checking |
| `bug_complete`, `comment_dry_run`, `comment_posted`, `comment_edited` | key, recheck, requested, failedBase, missing, related, agentMs, turns, costUsd, comment, commentId; `kept` (dry run, a comment in Jira left as recorded), `changed` (edit); a post by hand: key, `byHand`, commentId, comment | |
| `comment_adopted` | key, commentId, status | |
| `check_failed` | key, recheck, requested, attempts (first check only), status, error, ms | |
| `check_deferred` | key, error | |
| `request_failed` | key, error, gaveUp | |
| `post_failed` | key, error, gaveUp | |
| `mentions_stripped` | key, stripped | |
| `fatal` | error | crashed, error |

The UI calls the service *crashed* when its latest start ended in `fatal` (systemd keeps starting
it), *silent* when nothing has been logged for two poll intervals plus the agent's timeout and two
minutes. `/healthz` answers 200 while it runs and fewer than 5 polls in a row have failed, 503
otherwise. The UI's own log (`ui_start`, `ui_stopping`, `ui_stopped`, `ui_error`) goes to
`state/ui.log` under systemd; `maintain` logs `backup` and `log_cut` to the journal.

## Configuration

`.env` in the working directory is loaded if present; a variable set in the environment wins.
Only the first two have no default.

| variable | default | meaning |
|---|---|---|
| `JIRA_EMAIL`, `JIRA_API_TOKEN` | — | basic auth; a scoped API token (`jira-reference.md`) |
| `JIRA_BASE_URL` | the company site | for links |
| `JIRA_CLOUD_ID` | the company site's | every REST request goes through `api.atlassian.com/ex/jira/<id>` |
| `CLAUDE_CODE_OAUTH_TOKEN` | — | from `claude setup-token`; absent: the machine's own claude login |
| `DRY_RUN` | `true` | `false` posts comments; anything else is refused |
| `POLL_INTERVAL_SECONDS` | `180` | |
| `AGENT_MODEL` | `haiku` | `sonnet` to compare on the same bugs with `check` |
| `AGENT_TIMEOUT_SECONDS` | `180` | one agent run |
| `AGENT_MAX_BUDGET_USD` | `0.5` | one agent run; a haiku check costs about $0.002 |
| `DB_FILE` | `state/bug-validator.sqlite` | |
| `LOG_FILE` | `state/service.log` | the service's log as the systemd unit writes it; the UI and `maintain` read it |
| `BACKUP_DIR` | `state/backups` | `maintain`'s copies of the database, the latest 14 kept |
| `UI_HOST` | `127.0.0.1` | this machine only; the UI's unit sets `0.0.0.0` for the office network |
| `UI_PORT` | `8081` | |
| `UI_HOSTNAMES` | — | names the UI may be opened by, comma-separated, besides IP addresses, localhost and the machine's name |
| `UI_USER`, `UI_PASSWORD` | — | both set: every page asks for this login (`/healthz` does not) |

Attempts at the first check (3), the query cap (200 issues per poll), the wait before the first
check (30 min), the quiet before a re-check (15 min), the checks per bug (5), the pending requests
(20) and the log's size before `maintain` cuts it (5 MB) are constants in the code.

## Running

```
npm install
cp .env.example .env && chmod 600 .env      # fill in JIRA_EMAIL, JIRA_API_TOKEN
npm run check -- KAZ-9025                   # one bug: the verdict and the comment, nothing written
npm run check -- KAZ-9025 --recheck         # as a re-check of the comment recorded in the database
npm start                                   # the loop, DRY_RUN=true by default; log on stdout
npm run request -- KAZ-9025                 # the running service checks the bug next (a key or a link)
npm run ui                                  # the web UI on http://127.0.0.1:8081/ (UI_HOST to open it wider)
node src/main.ts maintain                   # back up the database, cut the log down to size
npm test && npm run typecheck
```

Tuning the agent: edit `agent/instructions.md`, run `check` on bugs with known gaps (the fixtures
in `test/fixtures/` are such bugs) and on a good one (RPG-6188); `check --recheck` on a bug whose
reporter added something after its comment (RPG-6219, KAZ-9035). RPG-6245 (a visual bug: the way
to the screen is the steps) and KAZ-9043 (no steps, no related bug) are checks of the R1 rule and
of the related-bug search. Adding a requirement touches `bug.ts`, `checks.ts` (if a field fact),
`verdict.ts` (if it has a name of its own in the comment), `prd.md`, `agent/instructions.md` and a
fixture; the UI takes the ids and names from `bug.ts`.

### UI

`npm run ui` serves three pages on `UI_PORT`, read from `DB_FILE` and `LOG_FILE` on every
request; the log exists when the service runs under systemd (a local `npm start` logs to
stdout, so the Service block shows "no log"). It opens the database read-only, never creates it,
and writes nothing but requests: the form in the header (a key or a link to the bug) and the
button on a bug's page ask the service to check that bug next; Post to Jira on a bug's page, once
confirmed, asks it to post the comment shown. The page then shows the request waiting and fills
in with the result. No external resources: the pages work on a network
without internet access.

The UI is opened from the office network as `http://<server-ip>:8081/`; no TLS, no proxy, nothing
outside the LAN (firewall the port to it). It serves only a Host it knows (an IP address,
localhost, the machine's name, `UI_HOSTNAMES`), so a site that points its own name at the server
cannot read the pages through a visitor's browser; it takes a request only from its own pages
(`Origin`, `Sec-Fetch-Site`), so another site cannot make a visitor's browser ask for checks or
posts; a
body over 4 KB is refused. `UI_USER` and `UI_PASSWORD` add a login. The pages forbid framing.

- `/` — the service (running, stopping, stopped, crashed or silent; last poll and how many failed
  in a row; mode; in Created and how many of them wait; started; model; claude version and auth;
  poll interval; the bug being checked; the checks requested and waiting; skipped at the first
  start), bugs first checked today / 7 days / all time with the share that got a comment and the
  failed checks, the items that arrived after a comment, bugs per day of their first check for 30
  days, the requirements the first check found missing most often, the checks that need attention
  (failed first checks, failed re-checks of a bug with a comment, interrupted posts), and the
  latest 30 events of the log.
- `/bugs` — every bug by the day of its last check, latest first: result, what is missing,
  related bugs, how many checks. `?result=` narrows by result (chips), `?q=` searches keys,
  summaries and reporters (the form; Enter submits).
- `/bugs/<KEY>` — each requirement as the agent judged it beside the base check, the related
  bugs, every check with the comment it recorded, and the comment as it is (or would be) in
  Jira, the mention by name and arrived items struck through. A comment Jira does not have gets
  Post to Jira: a confirmation with the comment, the check it came from and the reporter it
  notifies, then a post request (`?post` opens the confirmation without JavaScript). For a bug
  asked for and not checked yet, the request alone.
- `/healthz` — JSON for a monitor: `ok`, `state`, `pollFailures`, `lastSeen`.

The pages are rendered on the server (`html.ts`, pure functions tested in `test/ui/`); `app.js`
fetches the page again every 5 s and swaps `<main>` when it changed, not while the tab is hidden,
the search box has focus or a confirmation is open, keeping an opened comment open, and opens the
confirmation as a modal; `theme.js` keeps the light or dark
choice made with the header's button in the browser (the system's setting until then). Everything
works with JavaScript off, minus the refresh and the switch. The look is the drafting sheet
pipeline-ui shares: one surface, hairline frames with a cross at each corner, Barlow Condensed for
titles and values, letter-spaced capitals for labels, slate for the one action and for a comment,
moss for ok, rust for an error; the dark theme is the same sheet in the dark. Its tokens and parts
(the masthead, the page width, frames, cards, buttons, pills, chips, tables) are
`static/sheet.css`, the same file as pipeline-ui's `ui/src/sheet.css`: an edit to one is copied to
the other. `app.css` only lays out the pages. Times are the server's local time (`TZ` in the
units: Europe/Warsaw). Jira links use `JIRA_BASE_URL`. Pages, styles and scripts are never
cached; the fonts are, for a year.

### Deploy

systemd user units (`deploy/`). Machine-specific in each: `WorkingDirectory`, the node path (in
`PATH` and `ExecStart`; `PATH` must also hold `claude`) and, for the service and the UI, the log
path. The units set `TZ=Europe/Warsaw`, keep claude from updating itself
(`DISABLE_AUTOUPDATER=1`: update it by hand, then `check` a bug), give up after 5 failed starts in
10 minutes, and give a stop 30 s (it kills the agent run in progress; nothing is lost).

```
mkdir -p ~/.config/systemd/user && cp deploy/bug-validator*.service deploy/bug-validator-maintain.timer ~/.config/systemd/user/
systemctl --user daemon-reload
systemctl --user enable --now bug-validator bug-validator-ui bug-validator-maintain.timer
loginctl enable-linger $USER                  # survive logout
systemctl --user status bug-validator bug-validator-ui
tail -f state/service.log
```

The UI is then at `http://<server-ip>:8081/`; let the port through the firewall from the LAN only.
Its log is `state/ui.log`. Point a monitor at `http://<server-ip>:8081/healthz`. `maintain` runs
daily at 04:30: a copy of the database in `state/backups/` (the latest 14 kept), and the log,
once past 5 MB, copied to `service.log.1` and emptied in place (the UI reads both). Its output:
`journalctl --user -u bug-validator-maintain`.

Claude auth: `claude setup-token` once (opens the browser), paste the token into `.env`, restart.
`service_start` logs `claudeAuth`: `oauth_token`, or `cli_login` when the machine's own login is
used. **Going live:** `DRY_RUN=false` in `.env`, `systemctl --user restart bug-validator`.

**Moving to another machine.** The rows are what keeps a bug from being checked as new; a missing
database is a first start that skips everything in Created.

1. On the old machine: wait for no check to run (the UI shows none), then
   `systemctl --user disable --now bug-validator bug-validator-ui bug-validator-maintain.timer`.
   A clean stop removes `<db>.lock`; one copied over from a machine that did not stop cleanly
   names that machine, and the new one refuses to start until the file is deleted.
2. Copy `state/` whole (`.sqlite`, `-wal`, `-shm`), or `node src/main.ts maintain` and copy the
   newest file in `state/backups/` as `state/bug-validator.sqlite`.
3. On the new machine: `.env` (chmod 600, a `claude setup-token` of its own), the units with its
   paths, the same claude version. Start, and check that `service_start` logs the expected
   `dbFile` and `bugs`, and that no `first_start` follows.
4. Keep the old machine's units disabled: two services check every bug twice. Live, the second
   finds the first's comment and edits it rather than posting one, but the two keep editing it.

Docker (`Dockerfile`, `compose.yaml`) builds and runs the service alone, for a server without a
Claude login; it is not the deployment and is not tested in use. Its UI would have no
`service.log` to read.
