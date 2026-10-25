# Architecture

A small long-running program plus an agent with one read-only tool. The program does the plumbing
(query, field facts, state, posting) and keeps the guardrails; the agent reads, researches and
writes the comment. Why things are as they are: `prd.md`.

## Layers

```
src/
  main.ts            CLI: run | check <KEY> [--recheck] | requeue <KEY>
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
    store.ts         SQLite (node:sqlite): one row per bug (by issue id) in `checks`, one per check in `runs`, plus `meta`
  pipeline/
    deps.ts          what the pipeline needs: config, Jira, agent, store (Jira and agent are interfaces)
    checkBug.ts      one bug: fetch → base checks → agent → verdict → guardrails
    plan.ts          which bugs of a poll are due: first checks, re-checks, the waiting ones
    poll.ts          one poll: query → first-start bootstrap → moved bugs → plan → checks → record / post / edit
  commands/          run (the loop), check (one bug, writes nothing), requeue (a failed bug back in line)
agent/instructions.md   the agent's system prompt
deploy/bug-validator.service   systemd user unit
scripts/late-changes.ts   how reports change after creation (read-only measurement): `node scripts/late-changes.ts [days]`
test/                node:test; fixtures/ are real bugs saved from Jira (REST v2 JSON)
tui/                 the terminal view: Python + Textual (uv); reads state/, never writes
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

## Row statuses

| status | meaning |
|---|---|
| `skipped` | was already in the query at the first start, never checked |
| `complete` | checked, nothing missing, no comment |
| `dry_run` | comment composed and recorded, not posted |
| `posting` | the service stopped between the post and its record; a human looks in Jira, then `requeue` if needed |
| `commented` | comment posted (`comment_id` set) |
| `retry` | last attempt failed, tried again at the next poll |
| `failed` | 3 attempts failed, left alone; `requeue <KEY>` puts it back |

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

One JSON line per event: `ts`, `level`, `event`, then fields. The TUI reads the ones marked.

| event | fields | TUI |
|---|---|---|
| `service_start` | dryRun, pollIntervalS, maxAttempts, model, claudeVersion, claudeAuth, dbFile | mode, model, interval |
| `service_stopping`, `service_stopped` | signal | stopped |
| `poll` | inQuery, waiting, pending, checked, failed, ms | last poll, in Created, waiting |
| `poll_failed` | error, ms | last poll failed, error |
| `first_start` | skipped | |
| `key_changed` | from, to | |
| `check_start` | key, recheck | liveness |
| `bug_complete`, `comment_dry_run`, `comment_posted`, `comment_edited` | key, recheck, failedBase, missing, related, agentMs, turns, costUsd, comment, commentId | |
| `check_failed` | key, recheck, attempts (first check only), status, error, ms | |
| `mentions_stripped` | key, stripped | |
| `fatal` | error | |

The TUI calls the service *silent* when nothing has been logged for two poll intervals plus
five minutes.

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
npm run requeue -- KAZ-9025                 # a failed bug back in line
npm run tui                                 # the terminal view (needs uv)
npm test && npm run typecheck && (cd tui && uv run pytest)
```

Tuning the agent: edit `agent/instructions.md`, run `check` on bugs with known gaps (the fixtures
in `test/fixtures/` are such bugs) and on a good one (RPG-6188); `check --recheck` on a bug whose
reporter added something after its comment (RPG-6219, KAZ-9035). Adding a requirement touches
`bug.ts`, `checks.ts` (if a field fact), `prd.md`, `agent/instructions.md`, `tui/.../checks.py`,
and a fixture.

### TUI

`npm run tui` (or `uv run --project tui bug-validator-tui [state-dir]`) reads `state/`: the
database, and `state/service.log`, which exists when the service runs under systemd (a local
`npm start` logs to stdout, so the Service block shows "no log"). Home: the service (running,
stopped or silent; mode; last poll; in Created and how many of them wait; started; model; skipped
at the first start), bugs checked today / 7 days / all time with and without a comment, failed
checks, bugs per day for 30 days, the requirements the first check found missing most often, and
the checks that need attention.
Keys: `b` all bugs · `Enter` open · `Esc` back · `r` reload · `q` quit; in all bugs `f` steps
the filter through the results and `/` searches keys, summaries and reporters. Screens reload
every 5 s. A bug's screen shows each requirement as the agent judged it beside the base check,
the related bugs, every check when there were several, and the comment as it is (or would be)
in Jira. The Jira link uses
`JIRA_BASE_URL` from the environment, else the company site.

### Deploy

Home server (WSL, systemd user unit). Edit the two machine-specific lines in
`deploy/bug-validator.service` (working directory, node path; PATH must also hold `claude`).

```
mkdir -p ~/.config/systemd/user && cp deploy/bug-validator.service ~/.config/systemd/user/
systemctl --user daemon-reload && systemctl --user enable --now bug-validator
loginctl enable-linger $USER                  # survive logout
systemctl --user status bug-validator
tail -f state/service.log
```

Claude auth: `claude setup-token` once (opens the browser), paste the token into `.env`, restart.
`service_start` logs `claudeAuth`: `oauth_token`, or `cli_login` when the machine's own login is
used. **Going live:** `DRY_RUN=false` in `.env`, `systemctl --user restart bug-validator`. The
log file grows about 50 KB a day and is not rotated.

Docker (`Dockerfile`, `compose.yaml`) is for a server without a Claude login: `docker compose up
-d` with `CLAUDE_CODE_OAUTH_TOKEN` in `.env`. The TUI then has no `service.log` to read; the
database still works. Not used yet.
