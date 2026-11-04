---
name: review-dry-run
description: "Review what the service recorded in the dry run: outcomes since a date, the comments waiting for a person's approval, the bugs marked not a WebUI bug, the failed checks. Use when asked how the dry run is going, what to post, which comments look wrong, or for the numbers of a period. Reads state/ only; the one way to write is a request or a post from the web UI."
user-invocable: true
---

# Review the dry run

The service records every check (`docs/architecture.md`, Row statuses, One bug step 5). In a
dry run nothing reaches Jira unless a person posts it from the web UI. This skill reads the
record; it never writes the database (`state/bug-validator.sqlite`) and never posts.

## Where to look

- The web UI, `http://127.0.0.1:8081/` (or the server's IP): `/` for the numbers and what needs
  attention, `/bugs?result=not_understood` for the comments, `/bugs?result=not_webui` for the
  bugs a person must decide on, `/bugs/<KEY>` for one bug with its history and the Post button.
- Without the UI, the same data through the UI's reader (read-only, never creates the file):

```
node -e "
import('/home/cgs/npb/bug-validator/src/ui/read.ts').then(({ readBugs, result }) => {
  const since = new Date(process.argv[1]);
  for (const b of readBugs('state/bug-validator.sqlite').filter((b) => b.checkedAt >= since)) {
    console.log(b.key, result(b), b.history.length, '|', b.summary, b.reason ? '|' + b.reason : '');
  }
})" 2026-11-04
```

`result(b)` is `understood`, `not_understood`, `not_webui`, `error` or `skipped`; `b.comment`
holds the comment, `b.history[i]` each check with its `outcome`, `webuiCommit`, `files`,
`costUsd`, `version` (1: the list's check, before 2026-11-03).

## What to say

- **Numbers:** bugs checked in the period by outcome, failed checks, the agent's cost. The UI's
  home tiles have them; the PRD's metric counts the first check of each bug.
- **Comments to approve:** for each `not_understood` bug with a `dry_run` row, whether the
  questions are ones a QA engineer would answer in a minute, name the page and the control, and
  ask for nothing the report already has; whether it reads warm and plain, and opens differently
  from the last one (prd.md, Comment). A good one is posted from the bug's page (Post to
  Jira, a confirmation shows the text). A bad one is a prompt problem: the `tune-agent` skill.
- **Not a WebUI bug:** the agent's reason, and whether it holds; the decision (move the bug,
  reassign, leave it) is made in Jira by a person, not by the service.
- **Understood:** the bug's page shows the agent's reasoning (the file, the cause); a spot check
  is reading it against the code, and running `npm run check -- KEY` when it does not convince.
- **Failed checks:** the error on the bug's page. A `VerdictError` is the agent breaking the
  contract (tune), a timeout or budget is the caps (measure), the surroundings' failures
  (`check_deferred`, `poll_failed` in the log) are not the bug's.

## Do not

- Post a comment yourself, or edit the database. A request for a check (`npm run request --
  KEY`) is the only write from the command line, and it only asks the running service.
- Judge a bug from the comment alone: open the bug in Jira when the question is whether the
  report was clear.
