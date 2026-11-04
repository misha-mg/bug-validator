# Bug Validator

Checks new WebUI bugs in Jira (KAZ, RPG) before triage: an agent reads the report, its
attachments and the WebUI code and decides whether a developer could fix the bug from the
report; one it cannot understand gets a comment with the agent's questions, which a person
approves. Stage: the check by code built on 2026-11-04, its measurement on past bugs next (PRD
rollout step 3); the dry run runs as systemd user units `bug-validator`, `bug-validator-ui` (the
web UI, `http://<server-ip>:8081/`) and the `bug-validator-maintain` timer (backup, log size).
Nothing is posted to Jira but a comment a person posts from the UI. Moving it to another
machine: `docs/architecture.md`, Deploy.

- Scope, requirements, decisions: `docs/prd.md`. A decision made or changed goes into the PRD in
  the same change. Ideas discussed but not decided: `docs/open-ideas/`, one file each.
- Modules, data flow, row statuses, log events, configuration, how to run and deploy:
  `docs/architecture.md`. Jira ids, fields, workflow: `docs/jira-reference.md`.
- The agent writes the whole comment and investigates itself; the program only validates. Its
  prompt is `agent/instructions.md`: tune it with `npm run check -- KAZ-1234 [--recheck]` on
  real bugs (writes nothing, prints the agent's reasoning) and `node scripts/agreement.ts
  marks.tsv` against a developer's marks; the running service picks up edits without a restart.
- One thing is kept in step by hand: the log events in `docs/architecture.md` ↔
  `src/ui/service-log.ts` + `src/ui/html.ts` (the web UI reads them). The UI (`src/ui/`) reads
  `state/`, writes only check and post requests, and imports the tables, the statuses, the
  outcomes and the requirement ids from the service's own modules.
- The service writes nothing to Jira of its own until the PRD's rollout reaches "comments live":
  `DRY_RUN=true` is the default; the UI's Post to Jira posts one confirmed comment in any mode.
  The service's agent runs in a bubblewrap sandbox that holds only the WebUI clone, the run's
  files and claude (`docs/architecture.md`, The agent run); the deny list in
  `.claude/settings.json` protects only interactive Claude Code sessions in this repository.
- Credentials live in `.env` (gitignored, `chmod 600`, template `.env.example`). The agent's
  Jira tool runs in the service, so the Jira token never enters the sandbox; the Claude token
  does, and the program refuses any agent output that repeats it.
- Skills for the recurring work, in `.claude/skills/`: `tune-agent` (the instructions on real
  bugs, the agreement with a developer), `review-dry-run` (what the service recorded, what to
  post), `operate` (the units, the log, a migration, a move), `bug-fixture` (a real bug saved
  for a test), `decision` (a dated entry in the PRD and what it changes). Use the one that fits
  before working from scratch.
- Code, docs and Jira comments are in English. No AI attribution anywhere: commits, comments, Jira.
