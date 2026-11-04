---
name: operate
description: "Run and look after the service: the systemd units, what the log says at start and when something fails, a migration and its backup, the clone, the lock file, moving to another machine. Use when the service is to be started, stopped or restarted, when the UI says crashed, silent or stopped, when a poll keeps failing, or after a change to the code, claude, the token or the machine."
user-invocable: true
---

# Operate the service

Three systemd user units (`deploy/`): `bug-validator` (the service), `bug-validator-ui` (the
web UI on 8081) and the `bug-validator-maintain` timer (a daily backup, the log's size). The
whole of it: `.about/architecture.md`, Deploy and Log. Nothing below writes to Jira.

```
systemctl --user status bug-validator bug-validator-ui
systemctl --user restart bug-validator          # after a code change, a new claude, a new token
tail -f state/service.log                        # one JSON line per event
journalctl --user -u bug-validator-maintain      # backup, log_cut
curl -s http://127.0.0.1:8081/healthz            # 200 while it runs and polls succeed, 503 otherwise
```

An edit to `agent/instructions.md` needs no restart: the agent reads it on every run.

## What a start must show

The first line after a start is `service_start`: check `dryRun` (true until the PRD's "comments
live"), `model`, `claudeVersion` (asked inside the sandbox: bwrap and claude both work),
`webuiCommit` (the clone is at master), `dbFile` (the absolute path, the expected one) and
`bugs` (the rows: a database that is not the expected one shows here). A `first_start` line
after it means the database was empty: every bug in Created was skipped, which is right only on
the very first start of a new installation.

A start refused: the reason is in the log or the journal. `Bad configuration` is `.env`
(`CLAUDE_CODE_OAUTH_TOKEN` is required since 2026-11-04); `cannot start claude in the sandbox` is
bwrap (namespaces: Deploy), claude not under node's prefix, or the token; `git clone failed` /
`git fetch failed` is the SSH key or Bitbucket (SSH moves to `ssh.bitbucket.org` on 2026-11-12:
`VALIDATOR_WEBUI_REPO_URL`); `the database is locked by a service on <host>` is a lock file left by
another machine (Moving to another machine).

## A migration

The schema's version is `PRAGMA user_version`; the service migrates at start and copies the file
first (`<db>.before-v<N>-<time>`). Nothing to do but read `service_start` afterwards; the copy
can be deleted once the service has run a day. `maintain` keeps 14 daily backups in
`state/backups/`.

## The UI says…

- **crashed:** the latest start ended in `fatal`; systemd restarts it, up to 5 times in 10
  minutes. Read the error on the home page or in the log, fix the cause, `restart`.
- **silent:** nothing logged for two polls and an agent run. Usually a check that hangs past
  its timeout is impossible (the agent is killed), so look at `systemctl --user status`.
- **last poll failed N times in a row:** `poll_failed` with the error: Jira (401: the token;
  429/5xx: wait), Claude (a usage limit: wait; auth: `claude setup-token`, the token into
  `.env`, restart), the clone (`CloneError`: the key, the host). The checks wait; nothing is
  lost and no bug loses an attempt.
- **checking KEY for a long time:** the agent's cap is `VALIDATOR_AGENT_TIMEOUT_SECONDS` (600 by default);
  a stop kills the run and the bug is checked again later.

## Do not

- Delete or edit `state/bug-validator.sqlite`: the rows are what stops a second comment on a
  bug. Restore from `state/backups/` if it is lost, before a start.
- Run two services on one database, or the same service on two machines: the second checks
  every bug again and, live, edits the first one's comments.
- Delete `state/webui` while the service runs; stopped, it is only a clone that is made again.
