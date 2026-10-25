# Bug Validator

Checks new WebUI bugs in Jira (KAZ, RPG) before triage and comments on what they are missing.
Stage: dry run on the home server (PRD rollout step 2), systemd user unit `bug-validator`.
Nothing is posted to Jira.

- Scope, requirements, decisions: `docs/prd.md`. A decision made or changed goes into the PRD in
  the same change. Ideas discussed but not decided: `docs/open-ideas/`, one file each.
- Modules, data flow, row statuses, log events, configuration, how to run and deploy:
  `docs/architecture.md`. Jira ids, fields, workflow: `docs/jira-reference.md`.
- The agent writes the whole comment and searches Jira itself; the program only validates.
  Its prompt is `agent/instructions.md`: tune it with `npm run check -- KAZ-1234 [--recheck]` on
  real bugs (writes nothing); the running service picks up edits without a restart.
- Three things are shared between the service and the TUI (`tui/`, Python + Textual, read-only)
  and change together: the tables in `src/db/store.ts` ↔ `tui/tests/schema.sql` + `checks.py`;
  the log events in `docs/architecture.md` ↔ `service.py`; the requirement ids and names in
  `src/domain/bug.ts` ↔ `agent/instructions.md` + `checks.py` (the comment's list is read by
  those names).
- Jira stays read-only until the PRD's rollout reaches "comments live": `DRY_RUN=true` is the
  default. The service's agent is sandboxed by its command-line flags; the deny list in
  `.claude/settings.json` protects only interactive Claude Code sessions in this repository.
- Credentials live in `.env` (gitignored, `chmod 600`, template `.env.example`).
- Code, docs and Jira comments are in English. No AI attribution anywhere: commits, comments, Jira.
