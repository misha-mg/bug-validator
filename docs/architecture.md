# Architecture

A small long-running program plus an agent in a sandbox. The program does the plumbing (query,
field checks, attachments, the WebUI clone, state, posting) and keeps the guardrails; the agent
reads the report, the attachments and the WebUI code, decides whether the bug is understood and,
when it is not, writes the comment. Why things are as they are: `prd.md`.

## Layers

```
src/
  main.ts            CLI: run | check <KEY> [--recheck] | request <KEY|URL> | ui | maintain
  config.ts          env → typed Config; fails fast on a bad value
  log.ts             one JSON line per event on stdout
  domain/            pure functions, no I/O
    bug.ts           Bug model, the run's files, the outcomes, requirement ids R1–R7
    checks.ts        field checks: section headings, Affects versions, Devices, HAR
    fingerprint.ts   a hash of the report: what a re-check watches
    har.ts           a HAR file → the same HAR without cookies, tokens and binary bodies
    prompt.ts        Bug + field checks + the run's files + the clone's commit (+ the previous comment on a re-check) → the agent's prompt
    verdict.ts       the agent's JSON: schema and the guardrails
  jira/
    client.ts        REST v2 through api.atlassian.com: search, get issue, attachment bytes, myself, changelog; add and edit comment (the only writes)
    mapping.ts       raw issue JSON → Bug; Jira times
    queries.ts       the trigger JQL; the agent's JQL narrowed to KAZ and RPG
  webui/
    clone.ts         the service's clone of WebUI: clone if missing, fetch master, check it out detached; the commit
  claude/
    sandbox.ts       the bwrap arguments: what the agent sees (pure, tested)
    agent.ts         runs `claude -p` inside bwrap, with the file tools and the Jira tool
    jira-mcp.ts      the agent's Jira tool: search_issues, get_issue — read-only, KAZ and RPG only, served over HTTP by the service itself
  db/
    store.ts         SQLite (node:sqlite): one row per bug (by issue id) in `checks`, one per check in `runs`, `meta`, `requests` (checks asked for by hand) and `posts` (comments a person posts from the UI); the schema's migrations; a request written by the UI or the CLI, a post by the UI; a backup
  pipeline/
    deps.ts          what the pipeline needs: config, Jira, agent, clone, store (Jira, the agent and the clone are interfaces)
    attachments.ts   the bug's attachments → the run's files: downloaded, HAR cleaned, video cut to frames (ffmpeg)
    checkBug.ts      one bug: fetch → field checks → clone → files → agent → verdict → guardrails
    plan.ts          which bugs of a poll are due: first checks, re-checks, the waiting ones
    handle.ts        one check and its record / post / edit; the service's comment found in Jira; which failures are the surroundings'
    requests.ts      the posts and the checks asked for by hand, served before each check of a poll and while the service waits
    poll.ts          one poll: query → first-start bootstrap → moved bugs → plan → checks, requests first
  commands/          run (the loop), check (one bug, writes nothing), request (the service checks a bug next), ui (the web UI), maintain (backup, log size)
  ui/                the web UI: a separate process that reads state/ and writes nothing but check and post requests
    config.ts        UI_HOST, UI_PORT, UI_HOSTNAMES, UI_USER, UI_PASSWORD, plus the service's DB_FILE, LOG_FILE and JIRA_BASE_URL
    read.ts          the database, read-only → one view per bug with its runs, the requests; never creates the file
    service-log.ts   service.log → the service's state and its latest events, read as it grows; /healthz's answer
    stats.ts         counts by period and outcome, the field checks failed most often, bugs per day, field checks passed after a comment
    html.ts          the three pages as pure functions: HTML strings from what was read
    server.ts        node:http: the pages, the static files, /healthz; known hosts, same-origin requests, the optional login
    static/          sheet.css (the design system, shared with pipeline-ui), app.css (the faces and the pages' layout),
                     the fonts (Barlow, OFL), the theme switch (runs in <head>) and the refresh script
agent/instructions.md   the agent's system prompt
deploy/              systemd user units: the service, the UI, and maintain with its daily timer
scripts/late-changes.ts   how reports change after creation (read-only measurement): `node scripts/late-changes.ts [days]`
scripts/agreement.ts      the agent against a developer's marks (rollout step 3): `node scripts/agreement.ts marks.tsv`
test/                node:test; fixtures/ are real bugs saved from Jira (REST v2 JSON) and a HAR; ui/ builds its databases with the real Store
```

Dependencies: `zod` only. Node 24 runs the TypeScript directly and ships SQLite; there is no
build step. `claude` must be installed with npm under node's prefix (the sandbox binds that
prefix, which gives it both); `bwrap` (bubblewrap), `ffmpeg` and `git` must be on PATH. The UI
imports the service's tables, statuses, outcomes and requirement ids, and nothing of the
pipeline: it never loads the agent, the clone or the Jira client.

## One bug

1. `poll` runs the trigger JQL and reads every bug's report fields, reporter, comments and times
   in the same request. A row whose issue id comes back under another key (the bug moved between
   KAZ and RPG) takes the new key.
2. `plan` picks the bugs due (constants in `plan.ts`):
   - a first check for a bug with no row once it is 30 minutes old, and for a `retry` row;
   - live, a first check for a `posting` row at once (step 5 finds its comment in Jira);
   - a re-check for a `dry_run` row in a dry run (`commented` live) whose stored fingerprint
     differs from the report's now, once `updated` is 15 minutes old;
   - nothing for an `understood` or `not_webui` row, or a bug with 5 runs.

   The rest are counted as waiting when they are not settled yet.
3. `checkBug` fetches the issue and computes the field checks. It brings the clone to master
   (The WebUI clone) and makes the run's files (Attachments) in a directory of the run's own. It
   builds the prompt: the report, the files with what each is, the clone and its commit, the
   field checks as hints, and on a re-check the comment the service made last time. The
   reporter's text is fenced by a tag made from that text, so it cannot close its own fence; a
   description past 20 000 characters is cut. Then the agent runs (The agent run): it reads the
   code and the files, searches Jira for related bugs itself, and returns its outcome. The run's
   directory is removed whatever happens.
4. Guardrails (`verdict.ts`, `checkBug.ts`), each a failed check when broken:
   - the JSON matches the schema;
   - the outcome and the rest agree: `not_understood` has a comment, `understood` and `not_webui`
     have none, `not_webui` has a reason;
   - the comment's first line is the reporter's mention alone (not style: that is how the
     service finds its own comment in Jira), and it mentions nobody else (other mentions are
     stripped and logged);
   - every KAZ or RPG key the comment names is an issue Jira can read (a read follows a moved
     bug); those keys are the related bugs recorded;
   - no field holds a secret the agent could read in its sandbox: the run's Jira tool secret,
     the Claude token.

   The wording is the agent's: no line format, until the PRD's wording rules. The agent's
   reasoning, part of its JSON, stops here: `check` prints it, the service keeps nothing of it.
5. Every check adds a row to `runs`: the verdict (outcome, reason, comment, related), the field
   checks, the WebUI commit, the files (name, kind, note), the agent's model, cost, turns, time
   and a hash of its instructions, and the check's version (1 the list, 2 the code). The bug's
   row takes the new state and fingerprint:
   - `understood` or `not_webui` → that status, no comment. A row with a comment id keeps the
     id and the text, and the comment in Jira is left as it is (prd.md, Open questions);
   - `not_understood` with `DRY_RUN=true` → `dry_run` with the comment; a `commented` or
     `posting` row is left as it is and the check goes to `runs` only, whatever its outcome, so
     the record of the comment in Jira stays true;
   - live, with a comment id → the edit to the agent's new text (skipped when the text is the
     same), then `commented`;
   - live otherwise: Jira is read for a comment of the service's (by the account `myself`
     returns, opening with the reporter's mention). Found → adopted: the check is a re-check of
     it, and step "with a comment id" follows. None → `posting` with the comment, the post, then
     `commented` with the comment id. A comment id, once recorded, is never forgotten.
6. A failure of this bug's first check → row `retry` with the error; the third in a row →
   `failed` (`attempts` counts failed first checks since the last result). A failed re-check, or
   any failed check of a row with a comment in Jira, sets the row's error and leaves the rest. A
   failure of the surroundings (see Failures) leaves rows alone.

A check asked for by hand (`request <KEY|URL>`, the UI's form) skips steps 1 and 2: the bug
is read by its key, whatever its age, its status in Jira or its row — skipped, understood, not a
WebUI bug, failed, at the cap — and goes through 3–6 as any check. The service serves requests
before each check of a poll and every 2 s while it waits for the next poll; after a failure of the
surroundings they wait for a poll that succeeds. A key Jira does not know fails the request,
which keeps the reason until it is asked again; so does a third failure of the surroundings in a
row on it. At most 20 requests wait at a time. A request asked again while its check runs is kept
for another check.

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
| `understood` | the agent found the cause and knows what the reporter means; no comment, not re-checked |
| `not_webui` | the report is clear and the cause is outside the WebUI; no comment, not re-checked; the reason is shown in the UI for a person |
| `dry_run` | not understood, comment recorded, not posted; a person may post it from the UI |
| `posting` | written before a post whose outcome is unknown (the service stopped, or Jira did not answer); live, the next poll checks it again, finds the comment in Jira if it got there and adopts it; a post by hand tried again does the same |
| `commented` | not understood, comment posted (`comment_id` set) |
| `retry` | last attempt failed, tried again at the next poll |
| `failed` | 3 attempts failed, left alone; a request (`request <KEY>`, the UI) checks it again |

A re-check of a bug not understood changes its comment, not its status, unless the outcome
changes. `meta.bootstrapped_at` records the first start, so a first poll on an empty query still
counts. Rows are never deleted. A row holds the issue id; rows from before 2026-10-26 get it when
their bug is next in the query. They have no fingerprint and no runs, so they are never
re-checked.

The schema's version is `PRAGMA user_version`; `Store` (the service, at start) runs the
migrations it lacks, after a copy of the file (`<db>.before-v<N>-<time>`). The UI and `check`
never migrate. Version 4 (the check by code) renames `complete` to `understood`, keeps the
list's verdicts in the new shape (a comment means not understood), and adds the commit, the
files and the version to `runs`; the runs before it are version 1.

## Attachments

`attachments.ts` makes the run's files in a fresh directory, read-only to the agent, in the
attachments' order:

- an image (png, jpg, gif, webp) as it is; the agent's Read shows it;
- a HAR file through `har.ts`: the `cookies` lists go, the values of `Cookie`, `Set-Cookie` and
  `Authorization` headers and of any header, query parameter, URL parameter or JSON field whose
  name looks like a token, secret, password, session or key go, binary response bodies (images,
  fonts, anything base64) are dropped and text bodies cut at 64 KB;
- a video as JPEG frames in a directory, one every 2 s, at most 30, by `ffmpeg`; the video
  itself is not kept;
- text (txt, log, json, csv, md, xml, yaml, html) as it is; anything else, or a file over 50 MB,
  is listed by name only.

A download Jira fails is a failed read (Failures). A file that is the reporter's and cannot be
read as its kind — a HAR that is not JSON, a video ffmpeg cannot open — is not an error: the
prompt lists it as not available with the reason, and the agent may ask for it.

## The WebUI clone

`WEBUI_DIR` holds a clone of `WEBUI_REPO_URL`, the service's own, never a developer's working
tree, made with the machine's git credentials (an SSH key with read access), which the agent
never sees. `Clone.update(maxAge)` clones it when missing and fetches `origin/master` when the
last fetch is older than `maxAge`; only a fetch is followed by a checkout (detached, forced, so a
stray change cannot stop it), so a run that does not fetch only reads the clone, and two `check`s
at once do not trip over git's lock. The commit goes with the check. The service fetches at
start and before a check at most once a poll, and logs `webui_fetched` when master moved;
`check` and `scripts/agreement.ts` never fetch, so a tuning session sees one commit.

## Failures

These are failures of the surroundings, and cost no bug anything:

- `JiraError` without an answer (network, timeout, a body that did not arrive) or with 401,
  403, 429 or 5xx, an attachment download included;
- `AgentError` of kind `start` (claude or bwrap cannot be started), `service` (Claude's auth, a
  usage or rate limit, overload, a 5xx, the network; or Jira failing a search the agent made),
  `stopped` (the service is stopping: a stop kills the agent run, and the bug is checked again
  later);
- `CloneError`: the clone or the fetch of WebUI failed (network, credentials, Bitbucket).

One of them on a bug puts it off (`check_deferred`) and the poll goes on to the next, so a bug
Jira chokes on does not hold up the rest; a second in a row, or one no later check of the poll
gets past, ends the poll with `poll_failed`. Everything else — `VerdictError`, `MappingError`,
an agent run that times out, exits badly or goes over its budget, a 4xx on one issue or one
attachment — is this bug's failure and costs it an attempt (on a re-check, one of its 5 checks).

Writes: a post Jira refused (it answered with an error) made no comment: the row goes from
`posting` back to `retry`, at the cost of an attempt only for a 4xx other than 401 and 429. A post
without an answer may have made one: the row stays `posting`. An edit refused with such a 4xx (the
comment was deleted) is the bug's failure. At start the service asks claude its version inside
the sandbox (which proves bwrap and claude), brings the clone to master, and refuses to start
when either fails.

One service per database: `run` holds `<db>.lock` (host and pid) and refuses to start while a live
process of this service holds it on this host, or while another host's lock is there.

## The agent run

The agent reads files, so claude's flags alone cannot keep it from the rest of the machine (the
service's `.env`, `~/.claude`, `state/`). Each run is `bwrap` around `claude -p`, and the sandbox
(`sandbox.ts`) holds only:

| inside | what | how |
|---|---|---|
| `/work/webui` | the WebUI clone | read-only; the working directory |
| `/work/bug` | the run's files (Attachments) | read-only |
| `/home/agent/mcp.json` | the Jira tool's URL and the run's secret | read-only, a 0600 file of the run's private temp directory |
| `/usr`, `/etc/resolv.conf`, `/etc/hosts`, `/etc/ssl`, … | the system, name resolution, certificates | read-only |
| node's prefix | node and claude | read-only |
| `/home/agent`, `/tmp` | claude's own files for the run | empty tmpfs, gone with the run |

Everything is unshared but the network, which claude needs for the API and for the Jira tool on
loopback; `--die-with-parent`, so a stop of the service ends the run. The environment inside is
the one the service starts bwrap with — `HOME`, `PATH`, `CLAUDE_CODE_OAUTH_TOKEN` (the machine's
claude login is in `~/.claude`, which the sandbox does not have), no updates, no telemetry — and
nothing of the service's: the token goes that way, never as an argument, since a command line
is visible to every user of the machine. `bwrap` is found on the service's PATH at start;
`claude` is `<prefix>/bin/claude` under node's prefix.

Inside: `claude -p --restricted` (no shell, no edits, no web; the file tools confined to the
working directories, a second fence under bwrap's) with `--tools Read,Grep,Glob`, `--add-dir
/work/bug`, `--setting-sources ''` (no settings, no CLAUDE.md of its own: the instructions point
the agent to the WebUI's), `--strict-mcp-config` with one server, the Jira tool, `--allowedTools`
for those five tools, `--max-turns AGENT_MAX_TURNS`, `--max-budget-usd AGENT_MAX_BUDGET_USD`,
`--no-session-persistence`, `--json-schema` for the verdict, `--system-prompt` from
`agent/instructions.md` (read on every run: an edit reaches the next bug without a restart).
`AGENT_TIMEOUT_SECONDS` kills a run.

The Jira tool (`jira-mcp.ts`, MCP over streamable HTTP, hand-written JSON-RPC) runs in the
service, not in the sandbox, so the Jira token never enters it: it listens on `127.0.0.1` at a
port of its own, and each run gets a secret, carried as a bearer token and revoked when the run
ends. A Jira failure of the surroundings' kind while it serves a run marks that run a `service`
failure: a search that failed is not "nothing found". The agent can read that secret and the
Claude token in its sandbox; the guardrails refuse any output that holds either, and there is no
tool that sends anything out.

## Log

One JSON line per event: `ts`, `level`, `event`, then fields. The UI reads them all
(`src/ui/service-log.ts`, `html.ts`): the Service block from the ones marked, the Activity block
from every event but `poll` and `check_start`, one line each.

| event | fields | UI |
|---|---|---|
| `service_start` | dryRun, pollIntervalS, maxAttempts, model, agentTimeoutS, claudeVersion, webuiCommit, host, dbFile (absolute), bugs (rows) | mode, model, claude, WebUI commit, interval, started; ends a check cut short |
| `service_stopping` | signal | stopping |
| `service_stopped` | | stopped |
| `poll` | inQuery, waiting, pending, checked, failed, deferred, ms | last poll, in Created, waiting |
| `poll_failed` | error, ms, requests (when the waiting loop's requests failed) | last poll failed, error, failures in a row |
| `first_start` | skipped (the keys) | |
| `key_changed` | from, to | |
| `webui_fetched` | from, to (commits) | WebUI commit |
| `check_start` | key, recheck, requested | liveness, checking |
| `bug_understood`, `bug_not_webui`, `comment_dry_run`, `comment_posted`, `comment_edited` | key, recheck, requested, outcome, failedFields, related, webuiCommit, files, agentMs, turns, costUsd, reason, comment, commentId; `kept` (dry run, a comment in Jira left as recorded), `changed` (edit); a post by hand: key, `byHand`, commentId, comment | |
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
Only the first three have no default. The agent's model, timeout, turns and budget are
provisional until rollout step 3 measures them.

| variable | default | meaning |
|---|---|---|
| `JIRA_EMAIL`, `JIRA_API_TOKEN` | — | basic auth; a scoped API token (`jira-reference.md`) |
| `CLAUDE_CODE_OAUTH_TOKEN` | — | from `claude setup-token`; the only Claude login the sandbox has |
| `JIRA_BASE_URL` | the company site | for links |
| `JIRA_CLOUD_ID` | the company site's | every REST request goes through `api.atlassian.com/ex/jira/<id>` |
| `DRY_RUN` | `true` | `false` posts comments; anything else is refused |
| `POLL_INTERVAL_SECONDS` | `180` | also how old the clone's fetch may be before a check |
| `AGENT_MODEL` | `sonnet` | compare models on the same bugs with `scripts/agreement.ts` |
| `AGENT_TIMEOUT_SECONDS` | `600` | one agent run |
| `AGENT_MAX_TURNS` | `100` | one agent run |
| `AGENT_MAX_BUDGET_USD` | `2` | one agent run; a sonnet check of a clear bug costs about $0.04 |
| `WEBUI_REPO_URL` | `git@bitbucket.org:CGS/webui.git` | read with the machine's git credentials; Bitbucket moves SSH to `ssh.bitbucket.org` on 2026-11-12 |
| `WEBUI_DIR` | `state/webui` | the service's clone |
| `DB_FILE` | `state/bug-validator.sqlite` | |
| `LOG_FILE` | `state/service.log` | the service's log as the systemd unit writes it; the UI and `maintain` read it |
| `BACKUP_DIR` | `state/backups` | `maintain`'s copies of the database, the latest 14 kept |
| `UI_HOST` | `127.0.0.1` | this machine only; the UI's unit sets `0.0.0.0` for the office network |
| `UI_PORT` | `8081` | |
| `UI_HOSTNAMES` | — | names the UI may be opened by, comma-separated, besides IP addresses, localhost and the machine's name |
| `UI_USER`, `UI_PASSWORD` | — | both set: every page asks for this login (`/healthz` does not) |

Attempts at the first check (3), the query cap (200 issues per poll), the wait before the first
check (30 min), the quiet before a re-check (15 min), the checks per bug (5), the pending requests
(20), the attachment limits (50 MB a file, 64 KB a HAR body, a frame every 2 s and 30 a video) and
the log's size before `maintain` cuts it (5 MB) are constants in the code.

## Running

```
npm install
cp .env.example .env && chmod 600 .env      # fill in JIRA_EMAIL, JIRA_API_TOKEN, CLAUDE_CODE_OAUTH_TOKEN
npm run check -- KAZ-9025                   # one bug: the outcome, the agent's reasoning, the comment; nothing written
npm run check -- KAZ-9025 --recheck         # as a re-check of the comment recorded in the database
node scripts/agreement.ts marks.tsv         # KEY<TAB>understood|not_understood|not_webui per line: agreement, cost, time
npm start                                   # the loop, DRY_RUN=true by default; log on stdout
npm run request -- KAZ-9025                 # the running service checks the bug next (a key or a link)
npm run ui                                  # the web UI on http://127.0.0.1:8081/ (UI_HOST to open it wider)
node src/main.ts maintain                   # back up the database, cut the log down to size
npm test && npm run typecheck
```

The first `check` or `start` clones WebUI into `state/webui` (about half a minute, 200 MB).
Tuning the agent: edit `agent/instructions.md`, then run `scripts/agreement.ts` on the bugs a
developer marked (rollout step 3; AC7): it checks each, writes nothing, and prints the agreement,
the cost and time of each run, and every disagreement with the agent's reasoning. `check` on one
bug prints the same for it; `check --recheck` on a bug whose reporter answered its comment. The
field checks keep their fixtures in `test/fixtures/`; adding an item to the list touches
`bug.ts`, `checks.ts` (if a field check), `prd.md`, `agent/instructions.md` and a fixture; the UI
takes the ids and names from `bug.ts`.

### UI

`npm run ui` serves three pages on `UI_PORT`, read from `DB_FILE` and `LOG_FILE` on every
request; the log exists when the service runs under systemd (a local `npm start` logs to
stdout, so the Service block shows "no log"). It opens the database read-only, never creates it,
and writes nothing but requests: the form in the header (a key or a link to the bug) and the
button on a bug's page ask the service to check that bug next; Post to Jira on a bug's page, once
confirmed, asks it to post the comment shown. The page then shows the request waiting and fills
in with the result. No external resources: the pages work on a network without internet access.

The UI is opened from the office network as `http://<server-ip>:8081/`; no TLS, no proxy, nothing
outside the LAN (firewall the port to it). It serves only a Host it knows (an IP address,
localhost, the machine's name, `UI_HOSTNAMES`), so a site that points its own name at the server
cannot read the pages through a visitor's browser; it takes a request only from its own pages
(`Origin`, `Sec-Fetch-Site`), so another site cannot make a visitor's browser ask for checks or
posts; a body over 4 KB is refused. `UI_USER` and `UI_PASSWORD` add a login. The pages forbid
framing.

- `/` — the service (running, stopping, stopped, crashed or silent; last poll and how many failed
  in a row; mode; in Created and how many of them wait; started; model; claude version; the
  WebUI commit; poll interval; the bug being checked; the checks requested and waiting; skipped
  at the first start), bugs first checked today / 7 days / all time by outcome with the failed
  checks and the agent's cost, the field checks that passed after a comment, bugs per day of
  their first check for 30 days by outcome, the field checks failed most often at first checks,
  what needs attention (failed first checks, failed re-checks of a bug with a comment,
  interrupted posts, bugs not the WebUI's with the agent's reason), and the latest 30 events of
  the log.
- `/bugs` — every bug by the day of its last check, latest first: outcome, the field checks
  absent at the first check, related bugs, how many checks. `?result=` narrows by outcome, error
  or skipped (chips), `?q=` searches keys, summaries and reporters (the form; Enter submits).
- `/bugs/<KEY>` — the outcome, the reason (not a WebUI bug), the field checks, the related
  bugs, every check with its outcome, commit, files, cost and the comment it recorded (a
  version 1 check marked "list check"), and the comment as it is (or would be) in Jira, the
  mention by name, answered questions struck through. A comment Jira does not have gets Post to
  Jira: a confirmation with the comment, the check it came from and the reporter it notifies,
  then a post request (`?post` opens the confirmation without JavaScript). For a bug asked for
  and not checked yet, the request alone.
- `/healthz` — JSON for a monitor: `ok`, `state`, `pollFailures`, `lastSeen`.

The pages are rendered on the server (`html.ts`, pure functions tested in `test/ui/`); `app.js`
fetches the page again every 5 s and swaps `<main>` when it changed, not while the tab is hidden,
the search box has focus or a confirmation is open, keeping an opened comment open, and opens the
confirmation as a modal; `theme.js` keeps the light or dark choice made with the header's button
in the browser (the system's setting until then). Everything works with JavaScript off, minus the
refresh and the switch. The look is the drafting sheet pipeline-ui shares: one surface, hairline
frames with a cross at each corner, Barlow Condensed for titles and values, letter-spaced
capitals for labels, slate for the one action and for a comment, moss for understood, rust for an
error; the dark theme is the same sheet in the dark. Its tokens and parts (the masthead, the page
width, frames, cards, buttons, pills, chips, tables) are `static/sheet.css`, the same file as
pipeline-ui's `ui/src/sheet.css`: an edit to one is copied to the other. `app.css` only lays out
the pages. Times are the server's local time (`TZ` in the units: Europe/Warsaw). Jira links use
`JIRA_BASE_URL`. Pages, styles and scripts are never cached; the fonts are, for a year.

### Deploy

systemd user units (`deploy/`). Machine-specific in each: `WorkingDirectory`, the node path (in
`PATH` and `ExecStart`; claude is installed with npm under that node, and `PATH` must also hold
`bwrap`, `ffmpeg` and `git`) and, for the service and the UI, the log path. The units set
`TZ=Europe/Warsaw`, keep claude from updating itself (`DISABLE_AUTOUPDATER=1`: update it by hand,
then `check` a bug), give up after 5 failed starts in 10 minutes, and give a stop 30 s (it kills
the agent run in progress; nothing is lost). The machine must let an unprivileged user make
namespaces, which bwrap needs (Ubuntu 24.04: `kernel.apparmor_restrict_unprivileged_userns=0`,
or an AppArmor profile for bwrap), and the service's user needs an SSH key that reads WebUI.

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
`journalctl --user -u bug-validator-maintain`. The WebUI clone is not backed up: it is cloned
again when missing.

Claude auth: `claude setup-token` once (opens the browser), paste the token into `.env`, restart.
**Going live:** `DRY_RUN=false` in `.env`, `systemctl --user restart bug-validator`.

**Moving to another machine.** The rows are what keeps a bug from being checked as new; a missing
database is a first start that skips everything in Created.

1. On the old machine: wait for no check to run (the UI shows none), then
   `systemctl --user disable --now bug-validator bug-validator-ui bug-validator-maintain.timer`.
   A clean stop removes `<db>.lock`; one copied over from a machine that did not stop cleanly
   names that machine, and the new one refuses to start until the file is deleted.
2. Copy `state/` without `webui/` (`.sqlite`, `-wal`, `-shm`), or `node src/main.ts maintain`
   and copy the newest file in `state/backups/` as `state/bug-validator.sqlite`.
3. On the new machine: `.env` (chmod 600, a `claude setup-token` of its own), the units with its
   paths, the same claude version, `bwrap`, `ffmpeg`, `git` and an SSH key that reads WebUI.
   Start, and check that `service_start` logs the expected `dbFile`, `bugs` and `webuiCommit`,
   and that no `first_start` follows.
4. Keep the old machine's units disabled: two services check every bug twice. Live, the second
   finds the first's comment and edits it rather than posting one, but the two keep editing it.

There is no container image: the sandbox makes namespaces, which a container does not allow
without privileges.
