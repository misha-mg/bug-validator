# Bug Validator

Checks new WebUI bugs in Jira (KAZ, RPG) before triage and comments on what they are missing.
Stage: dry run on the home server (PRD rollout step 2), systemd user units `bug-validator`,
`bug-validator-ui` (the web UI, `http://<server-ip>:8081/`) and the `bug-validator-maintain` timer
(backup, log size). Nothing is posted to Jira. Moving it to another machine: `docs/architecture.md`,
Deploy.

- Scope, requirements, decisions: `docs/prd.md`. A decision made or changed goes into the PRD in
  the same change. Ideas discussed but not decided: `docs/open-ideas/`, one file each.
- Modules, data flow, row statuses, log events, configuration, how to run and deploy:
  `docs/architecture.md`. Jira ids, fields, workflow: `docs/jira-reference.md`.
- The agent writes the whole comment and searches Jira itself; the program only validates.
  Its prompt is `agent/instructions.md`: tune it with `npm run check -- KAZ-1234 [--recheck]` on
  real bugs (writes nothing); the running service picks up edits without a restart.
- Two things are kept in step by hand: the log events in `docs/architecture.md` ↔
  `src/ui/service-log.ts` + `src/ui/html.ts` (the web UI reads them); the requirement ids and
  names in `src/domain/bug.ts` ↔ `agent/instructions.md` (the comment's list is read by those
  names). The UI (`src/ui/`) reads `state/`, writes only check requests, and imports the tables
  and the requirements from the service's own modules.
- Jira stays read-only until the PRD's rollout reaches "comments live": `DRY_RUN=true` is the
  default. The service's agent is sandboxed by its command-line flags; the deny list in
  `.claude/settings.json` protects only interactive Claude Code sessions in this repository.
- Credentials live in `.env` (gitignored, `chmod 600`, template `.env.example`).
- Code, docs and Jira comments are in English. No AI attribution anywhere: commits, comments, Jira.
