# Bug Validator

Checks new WebUI bugs in Jira (KAZ, RPG) before triage. An agent reads each report in Created —
its text, its screenshots, HAR files and videos — and the WebUI source, and decides whether a
developer could find and fix the bug from the report:

- **understood** — the cause found in the code, the report clear: nothing happens;
- **not understood** — a comment to the reporter with the agent's own questions, which a person
  reads and posts from the web UI;
- **not a WebUI bug** — the report is clear and the cause is elsewhere: shown in the web UI for a
  person to decide.

A report of one screenshot and a sentence can be enough; asking for what nobody needs is noise.
The service runs as a dry run: everything is recorded and shown in its web UI, and nothing
reaches Jira but a comment a person approves.

## How it works

A poll every three minutes reads the bugs in Created. A bug is checked once it is 30 minutes
old, and again when the reporter changes it while it is not understood. Each check runs
`claude -p` inside a bubblewrap sandbox that holds only a read-only clone of WebUI master, the
run's files and claude itself; Jira is reached through a read-only tool the service serves on
loopback. The program keeps the guardrails — the outcome and the comment agree, the reporter is
mentioned and nobody else, every bug named exists, no secret of the run is repeated — and the
record: one row per bug, one per check, never a second comment on a bug.

What it checks and why: [`.about/prd/bug-validator.md`](.about/prd/bug-validator.md). Why it is
built this way: [`.about/adr/`](.about/adr/). Modules, data flow, statuses, log, configuration,
running and deploying: [`.about/architecture.md`](.about/architecture.md). The words:
[`.about/glossary.md`](.about/glossary.md). Jira's ids and fields:
[`.about/jira-reference.md`](.about/jira-reference.md). The agent's prompt:
[`agent/instructions.md`](agent/instructions.md).

## Running it

Node 24, `claude` installed with npm under that node, `bwrap`, `ffmpeg`, `git`, and an SSH key
that reads the WebUI repository.

```sh
cp .env.example .env && chmod 600 .env   # JIRA_BASE_URL, JIRA_EMAIL, JIRA_API_TOKEN, CLAUDE_CODE_OAUTH_TOKEN, VALIDATOR_WEBUI_REPO_URL
npm install
bin/bug-validator check KAZ-9025         # one bug: the outcome, the agent's reasoning, the comment; nothing written
node scripts/agreement.ts marks.tsv      # the agent against a developer's marks: agreement, cost, time
bin/bug-validator run                    # the service (npm start), VALIDATOR_DRY_RUN=true by default
bin/bug-validator ui                     # the web console (npm run ui), http://127.0.0.1:8081/
npm run sheet:sync                       # the design system copied from ../pipeline-ui (or PIPELINE_UI_DIR)
npm run check && npm test                # tsc and prettier, then vitest
```

Every setting of the service's own is a `VALIDATOR_*` variable (`.env.example` lists them;
`.about/architecture.md`, Configuration); the Jira login is `JIRA_*`. The first run clones WebUI
into `state/webui`. Deployment is three systemd user units (`deploy/`): the service, the web
console and a daily maintenance timer — `.about/architecture.md`, Deploy.

## Working on it

The console (`.about/architecture.md`, UI) has three pages, Cockpit, Bugs and Statistics, drawn
with the design system pipeline-ui owns: `ui/sheet.css`, `ui/theme.js` and `ui/fonts/` are copies
made by `npm run sheet:sync`, and a test fails when they fall behind.

`CLAUDE.md` holds the rules for the code and the docs; `.claude/skills/` the recurring work:
tuning the agent, reviewing the dry run, operating the service, saving a bug as a fixture,
recording a decision. A decision made or changed goes into the PRD, dated, in the same change.
