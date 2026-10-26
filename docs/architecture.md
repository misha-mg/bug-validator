# Architecture

A small long-running program plus an agent with one read-only tool. The program does the plumbing
(query, field facts, state, posting) and keeps the guardrails; the agent reads, researches and
writes the comment. Why things are as they are: `prd.md`.

## Layers

```
src/
  main.ts            CLI: run | check <KEY> [--recheck] | request <KEY|URL> | ui
  config.ts          env → typed Config; fails fast on a bad value
  log.ts             one JSON line per event on stdout
  domain/            pure functions, no I/O
    bug.ts           Bug model, requirement ids R1–R7, which of them are field facts
    checks.ts        base checks: section headings, Affects versions, Devices, HAR
    fingerprint.ts   a hash of the report: what a re-check watches
    prompt.ts        Bug + field facts (+ the previous comment on a re-check) → the agent's prompt
    verdict.ts       the agent's JSON: schema and the guardrails, the comment's list included
  jira/
    client.ts        REST v2 through api.atlassian.com: search, get issue, changelog; add and edit comment (the only writes)
    mapping.ts       raw issue JSON → Bug; Jira times
    queries.ts       the trigger JQL
  claude/
    agent.ts         spawns `claude -p` with the Jira MCP server as its only tool
    jira-mcp.ts      that server: search_issues, get_issue — read-only, KAZ and RPG only
  db/
    store.ts         SQLite (node:sqlite): one row per bug (by issue id) in `checks`, one per check in `runs`, `meta`, and `requests` (checks asked for by hand)
  pipeline/
    deps.ts          what the pipeline needs: config, Jira, agent, store (Jira and agent are interfaces)
    checkBug.ts      one bug: fetch → base checks → agent → verdict → guardrails
    plan.ts          which bugs of a poll are due: first checks, re-checks, the waiting ones
    handle.ts        one check and its record / post / edit; which failures are the surroundings'
    requests.ts      a check asked for by hand: written to `requests`, served before each check of a poll and while the service waits
    poll.ts          one poll: query → first-start bootstrap → moved bugs → plan → checks, requests first
  commands/          run (the loop), check (one bug, writes nothing), request (the service checks a bug next), ui (the web UI)
  ui/                the web UI: a separate process that reads state/ and writes nothing but check requests
    config.ts        UI_HOST, UI_PORT, LOG_FILE, plus the service's DB_FILE and JIRA_BASE_URL
    read.ts          the database, read-only → one view per bug with its runs, the requests; never creates the file
    service-log.ts   service.log → the service's state and its latest events, read as it grows
    stats.ts         counts by period, the most common gaps, checks per day, items added after the comment
    html.ts          the three pages as pure functions: HTML strings from what was read
    server.ts        node:http: the pages, app.css and app.js; nothing cached
    static/          the stylesheet and the refresh script
agent/instructions.md   the agent's system prompt
deploy/*.service     systemd user units: the service and the UI
scripts/late-changes.ts   how reports change after creation (read-only measurement): `node scripts/late-changes.ts [days]`
test/                node:test; fixtures/ are real bugs saved from Jira (REST v2 JSON); ui/ builds its databases with the real Store
```

Dependencies: `zod` only. Node 24 runs the TypeScript directly and ships SQLite; there is no
build step. `claude` must be on PATH.

## One bug

1. `poll` runs the trigger JQL and reads every bug's report fields and times in the same request.
   A row whose issue id comes back under another key (the bug moved between KAZ and RPG) takes
   the new key.
2. `plan` picks the bugs due (constants in `plan.ts`):
   - a first check for a bug with no row once it is 30 minutes old, and for a `retry` row;
   - a re-check for a `complete` row, or a `dry_run` row in a dry run (`commented` live), whose
     stored fingerprint differs from the report's now, once `updated` is 15 minutes old;
   - nothing for a bug with 5 runs.

   The rest are counted as waiting when they are not settled yet.
3. `checkBug` fetches the issue, computes the field facts, builds the prompt and runs the agent.
   On a re-check the prompt ends with the comment the service made last time, and the agent
   edits it. The agent searches Jira for related bugs itself and writes the whole comment.
4. Guardrails (`verdict.ts`, `checkBug.ts`), each a failed check when broken:
   - the JSON matches the schema;
   - "comment needed" and the comment agree;
   - every failed field fact (R4–R6) is in `missing`;
   - the comment's list (R1–R6 by name) is exactly `missing`, and a first comment strikes
     nothing through;
   - a re-check keeps the comment and every item of it, and strikes through only items it had;
   - the reporter is mentioned and nobody else (other mentions are stripped and logged);
   - every issue key named is a KAZ or RPG issue that exists.
5. Every check adds a row to `runs`, and the bug's row takes the new state and fingerprint:
   - no comment → `complete`;
   - `DRY_RUN=true` → `dry_run` with the comment;
   - live, with a comment already in Jira → the edit, then `commented`, keeping the comment id;
   - live otherwise → `posting` with the comment, the post, then `commented` with the comment id.
6. A failure of this bug's first check → row `retry` with the error; the third → `failed`. A
   failed re-check sets the row's error and leaves the rest. A failure of the surroundings (see
   Failures) ends the poll instead and leaves rows alone.

A check asked for by hand (`request <KEY|URL>`, the UI's form) skips steps 1 and 2: the bug
is read by its key, whatever its age, its status in Jira or its row — skipped, failed, at the
cap — and goes through 3–6 as a re-check when its row holds the comment of the current mode,
as a first check otherwise. The service serves requests before each check of a poll and every
2 s while it waits for the next poll; after a failure of the surroundings they wait for a poll
that succeeds. A key Jira does not know fails the request, which keeps the reason until it is
asked again.

## Row statuses

| status | meaning |
|---|---|
| `skipped` | was already in the query at the first start, never checked |
| `complete` | checked, nothing missing, no comment |
| `dry_run` | comment composed and recorded, not posted |
| `posting` | the service stopped between the post and its record; a human looks in Jira, then asks for a check if needed |
| `commented` | comment posted (`comment_id` set) |
| `retry` | last attempt failed, tried again at the next poll |
| `failed` | 3 attempts failed, left alone; a request (`request <KEY>`, the UI) checks it again |

A re-check changes a row's comment, not its status. `meta.bootstrapped_at` records the first
start, so a first poll on an empty query still counts. Rows are never deleted. A row holds the
issue id; rows from before 2026-10-26 get it when their bug is next in the query. They have no
fingerprint and no runs, so they are never re-checked.

## Failures

`JiraError` without a status (network, timeout) or with 401, 403, 429 or 5xx, and `AgentError`
of kind `start` (claude cannot be started) are failures of the surroundings: the poll ends with
`poll_failed`, no row changes, the next poll tries again. Everything else — `VerdictError`,
`MappingError`, an agent run that times out or exits badly, a 4xx on one issue — is this bug's
failure and costs it an attempt (on a re-check, one of its 5 checks). At start the service runs `claude --version` and refuses to
start without it.

## The agent run

`claude -p` with `--tools ''` (no built-in tools), `--setting-sources ''` (no settings, no
CLAUDE.md), `--strict-mcp-config` with one server (the project's `jira-mcp.ts`, given the
`JIRA_*` variables), `--allowedTools` for its two tools, `--max-turns 25`,
`--no-session-persistence`, `--json-schema` for the verdict, `--system-prompt` from
`agent/instructions.md` (read on every run: an edit reaches the next bug without a restart). It
runs in a temp directory outside the repository. `AGENT_TIMEOUT_SECONDS` kills it; a stop of the
service kills it too. The agent sees attachment names only, never their content: a HAR holds
session cookies.

## Log

One JSON line per event: `ts`, `level`, `event`, then fields. The UI reads them all
(`src/ui/service-log.ts`, `html.ts`): the Service block from the ones marked, the Activity block
from every event but `poll` and `check_start`, one line each.

| event | fields | UI |
|---|---|---|
| `service_start` | dryRun, pollIntervalS, maxAttempts, model, claudeVersion, claudeAuth, dbFile | mode, model, claude, interval, started |
| `service_stopping`, `service_stopped` | signal | stopped |
| `poll` | inQuery, waiting, pending, checked, failed, ms | last poll, in Created, waiting |
| `poll_failed` | error, ms | last poll failed, error |
| `first_start` | skipped | |
| `key_changed` | from, to | |
| `check_start` | key, recheck, requested | liveness, checking |
| `bug_complete`, `comment_dry_run`, `comment_posted`, `comment_edited` | key, recheck, requested, failedBase, missing, related, agentMs, turns, costUsd, comment, commentId | |
| `check_failed` | key, recheck, requested, attempts (first check only), status, error, ms | |
| `request_failed` | key, error | |
| `mentions_stripped` | key, stripped | |
| `fatal` | error | |

The UI calls the service *silent* when nothing has been logged for two poll intervals plus five
minutes. The UI's own log (`ui_start`, `ui_stopping`, `ui_stopped`, `ui_error`) goes to
`state/ui.log` under systemd.

## Configuration

`.env` in the working directory is loaded if present. Only the first two have no default.

| variable | default | meaning |
|---|---|---|
| `JIRA_EMAIL`, `JIRA_API_TOKEN` | — | basic auth; a scoped API token (`jira-reference.md`) |
| `JIRA_BASE_URL` | the company site | for links |
| `JIRA_CLOUD_ID` | the company site's | every REST request goes through `api.atlassian.com/ex/jira/<id>` |
| `CLAUDE_CODE_OAUTH_TOKEN` | — | from `claude setup-token`; absent: the machine's own claude login |
| `DRY_RUN` | `true` | `false` posts comments |
| `POLL_INTERVAL_SECONDS` | `180` | |
| `AGENT_MODEL` | `haiku` | `sonnet` to compare on the same bugs with `check` |
| `AGENT_TIMEOUT_SECONDS` | `180` | one agent run |
| `DB_FILE` | `state/bug-validator.sqlite` | |
| `LOG_FILE` | `state/service.log` | the service's log as the systemd unit writes it; the UI reads it |
| `UI_HOST` | `0.0.0.0` | the UI listens on every interface: it is opened from the office network by the server's IP |
| `UI_PORT` | `8081` | |

Attempts at the first check (3), the query cap (200 issues per poll), the wait before the first
check (30 min), the quiet before a re-check (15 min) and the checks per bug (5) are constants in
the code.

## Running

```
npm install
cp .env.example .env && chmod 600 .env      # fill in JIRA_EMAIL, JIRA_API_TOKEN
npm run check -- KAZ-9025                   # one bug: the verdict and the comment, nothing written
npm run check -- KAZ-9025 --recheck         # as a re-check of the comment recorded in the database
npm start                                   # the loop, DRY_RUN=true by default; log on stdout
npm run request -- KAZ-9025                 # the running service checks the bug next (a key or a link)
npm run ui                                  # the web UI on http://<this host>:8081/
npm test && npm run typecheck
```

Tuning the agent: edit `agent/instructions.md`, run `check` on bugs with known gaps (the fixtures
in `test/fixtures/` are such bugs) and on a good one (RPG-6188); `check --recheck` on a bug whose
reporter added something after its comment (RPG-6219, KAZ-9035). Adding a requirement touches
`bug.ts`, `checks.ts` (if a field fact), `prd.md`, `agent/instructions.md` and a fixture; the
UI takes the ids and names from `bug.ts`.

### UI

`npm run ui` serves three pages on `UI_PORT`, read from `DB_FILE` and `LOG_FILE` on every
request; the log exists when the service runs under systemd (a local `npm start` logs to
stdout, so the Service block shows "no log"). The UI is opened from the office network as
`http://<server-ip>:8081/`: no login, no TLS, no proxy, nothing outside the LAN. It opens the
database read-only, never creates it, and writes nothing but a check request: the form in the
header (a key or a link to the bug) and the button on a bug's page ask the service to check
that bug next; the page then shows the request waiting and fills in with the result. No
external resources: the pages work on a network without internet access.

- `/` — the service (running, stopped or silent; last poll; mode; in Created and how many of
  them wait; started; model; claude version and auth; poll interval; the bug being checked;
  the checks requested and waiting; skipped at the first start), bugs checked today / 7 days / all time with and without a
  comment, failed checks, the items that arrived after a comment, bugs per day for 30 days, the
  requirements the first check found missing most often, the checks that need attention, and
  the latest 30 events of the log.
- `/bugs` — every bug by the day of its last check, latest first: result, what is missing,
  related bugs, how many checks. `?result=` narrows by result (chips), `?q=` searches keys,
  summaries and reporters (the form; Enter submits).
- `/bugs/<KEY>` — each requirement as the agent judged it beside the base check, the related
  bugs, every check with the comment it recorded, and the comment as it is (or would be) in
  Jira, the mention by name and arrived items struck through. For a bug asked for and not
  checked yet, the request alone.

The pages are rendered on the server (`html.ts`, pure functions tested in `test/ui/`); `app.js`
fetches the page again every 5 s and swaps `<main>` when it changed, not while the tab is hidden
or the search box has focus. Everything works with JavaScript off, minus the refresh. Times are
the server's local time. Jira links use `JIRA_BASE_URL`.

### Deploy

Home server (WSL, systemd user unit). Edit the two machine-specific lines in
`deploy/bug-validator.service` (working directory, node path; PATH must also hold `claude`).

```
mkdir -p ~/.config/systemd/user && cp deploy/bug-validator.service deploy/bug-validator-ui.service ~/.config/systemd/user/
systemctl --user daemon-reload && systemctl --user enable --now bug-validator bug-validator-ui
loginctl enable-linger $USER                  # survive logout
systemctl --user status bug-validator bug-validator-ui
tail -f state/service.log
```

The UI is then at `http://<server-ip>:8081/` from the office network; if the server has a
firewall, let the port through from the LAN. Its log is `state/ui.log`.

Claude auth: `claude setup-token` once (opens the browser), paste the token into `.env`, restart.
`service_start` logs `claudeAuth`: `oauth_token`, or `cli_login` when the machine's own login is
used. **Going live:** `DRY_RUN=false` in `.env`, `systemctl --user restart bug-validator`. The
log file grows about 50 KB a day and is not rotated.

Docker (`Dockerfile`, `compose.yaml`) is for a server without a Claude login: `docker compose up
-d` with `CLAUDE_CODE_OAUTH_TOKEN` in `.env`. The UI then has no `service.log` to read; the
database still works. Not used yet.
