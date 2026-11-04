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
- **The look.** `sheet.css` is pipeline-ui's; bug-validator holds a copy under `ui/`. The
  `sheet:sync` script that refreshes the copy, and the test that checks it is current, come with
  the design change that follows this one.

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
