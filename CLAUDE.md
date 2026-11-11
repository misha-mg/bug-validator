# bug-validator

A service and a web console that check new WebUI bugs in Jira (KAZ, RPG) before triage: an agent
reads the report, its attachments and the WebUI code and decides whether a developer could fix
the bug from the report; one it cannot understand gets a comment with the agent's questions,
which a person approves. Start with [README.md](README.md), then
[.about/prd/bug-validator.md](.about/prd/bug-validator.md) (what it must do; a decision made or
changed goes there, dated, in the same change), [.about/adr/](.about/adr/) (why it is built this
way) and [.about/architecture.md](.about/architecture.md) (modules, data flow, row statuses, log
events, configuration, running and deploying). Words follow
[.about/glossary.md](.about/glossary.md): bug, report, check, re-check, outcome, field check,
comment, request, post, message, dry run, the agent, the sandbox, the clone, the console. Jira ids, fields
and workflow: [.about/jira-reference.md](.about/jira-reference.md). Ideas discussed but not
decided: `.about/open-ideas/`, one file each. Stage: the check by code built on 2026-11-04, its
measurement on past bugs next (PRD rollout step 3).

## Checks

Before every commit, both:

```bash
npm run check   # tsc, then prettier --check
npm test        # vitest, no network, no real Jira or claude
```

One test file: `npx vitest run server/http/view.test.ts`. `npm run format` writes prettier's
formatting. Node 24 runs the server's TypeScript as it is (type stripping): only erasable syntax,
`.ts` in import paths, no enums or parameter properties (`tsconfig.json` enforces it).

## Conventions

- Code, comments, docs, commit messages and Jira comments are in English. No AI attribution
  anywhere: no `Co-Authored-By` trailer, no "Generated with" line, nothing in a Jira comment,
  whatever a tool suggests.
- Commits follow Conventional Commits (`feat(config):`, `fix(poll):`, `refactor:`, `docs:`,
  `style:`, `chore:`); the subject says what changes for the operator, the body why.
- Each file opens with a comment that says what it is for; comments say why, not what.
- The layout, the shared modules and the environment names are the ones pipeline-ui has (ADR
  unification): `server/format.ts`, `server/log.ts`, `server/http/guard.ts` and `server/version.ts`
  (with its test and `scripts/version.sh`) are the same files in both repositories, byte for
  byte — an edit to one is copied to the other.
- No machine-specific or company-specific values in the repository: no home paths, user names,
  hosts, the Jira site or its cloud id, the WebUI repository URL. They come from `.env`
  (gitignored, `chmod 600`, template `.env.example`), read once in `server/config.ts`
  (`VALIDATOR_*`, `JIRA_*`, `CLAUDE_CODE_OAUTH_TOKEN`); other modules take config objects, never
  `process.env`.
- The agent writes the whole comment and investigates itself; the program only validates. Its
  prompt is `agent/instructions.md`: tune it with `bin/bug-validator check KAZ-1234 [--recheck]`
  on real bugs (writes nothing, prints the agent's reasoning) and `node scripts/agreement.ts
  marks.tsv` against a developer's marks; the running service picks up edits without a restart.
- One thing is kept in step by hand: the log events in `.about/architecture.md` ↔
  `server/http/service-log.ts` + `server/http/view.ts` (the console reads them). The console
  (`server/http/`) reads `state/`, writes only check and post requests and the settings (`server/store/settings.ts`,
  read by the service at every poll), and imports the tables,
  the statuses, the outcomes and the requirement ids from the service's own modules, never the
  agent, the clone or the Jira client.
- Tests sit next to the code (`*.test.ts`), use in-memory or temporary databases made by the real
  `Store` and fakes for Jira, claude, bwrap and git; nothing in a test reaches the network.
- Skills for the recurring work, in `.claude/skills/`: `tune-agent` (the instructions on real
  bugs, the agreement with a developer), `review-dry-run` (what the service recorded, what to
  post), `operate` (the units, the log, a migration, a move), `bug-fixture` (a real bug saved for
  a test), `decision` (a dated entry in the PRD and what it changes). Use the one that fits
  before working from scratch.

## Boundaries

- The service writes nothing to Jira of its own until the PRD's rollout reaches "comments
  live": `VALIDATOR_DRY_RUN=true` is the default; the console's Post to Jira posts one confirmed
  comment in any mode. Never write to Jira from a session: no comments, no transitions.
- The agent runs in a bubblewrap sandbox that holds only the WebUI clone, the run's files and
  claude (`.about/architecture.md`, The agent run). The agent's Jira tool runs in the service, so
  the Jira token never enters the sandbox; the Claude token does, and the program refuses any
  agent output that repeats it. The deny list in `.claude/settings.json` protects only
  interactive Claude Code sessions in this repository.
- `state/webui` is the service's clone, never a developer's working tree: never commit, push or
  change branches there.
- `ui/sheet.css`, `ui/theme.js` and `ui/fonts/` are the design system (the sheet) and
  pipeline-ui is its source of truth (`ui/src/sheet.css`, `ui/public/theme.js`,
  `ui/public/fonts/` there): never edit the copies. A part the pages need goes in pipeline-ui's
  sheet; then `npm run sheet:sync` (pipeline-ui at `../pipeline-ui` or `PIPELINE_UI_DIR`) brings
  it here, and `server/http/sheet.test.ts` fails until it has. `ui/app.css` only lays out the
  pages with the sheet's tokens.
- Never print `.env` or an unfiltered `env`.

## The running service

Three systemd user units (`deploy/`): `bug-validator` (the service, `server/cli.ts run`),
`bug-validator-ui` (the console, `http://<server-ip>:8081/`) and the `bug-validator-maintain`
timer (a daily backup, the log's size), with the real `state/` database. On the team's server a
fourth, the `bug-validator-update` timer, follows `main` on origin: a push there is deployed
within five minutes (it waits for a check in flight, and goes back when a unit does not come
up), so `main` holds only what may run. A check costs an agent run, so:

- never run `start`/`run` a second time on the operator's database, and never `check` a real bug
  unless asked;
- a change to `server/` needs the service restarted to take effect: only when no check is in
  flight (the console says), and with `.env` brought to the names the start asks for;
- a migration copies the database first (`<db>.before-v<N>-<time>`); the `operate` skill has the
  rest, and `.about/architecture.md`, Deploy, the move to another machine.
