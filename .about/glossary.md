# bug-validator glossary

The words the service, its record and the console use. Where pipeline-ui has the same thing, the
word is the same (the console, the service, a run of the agent).

**Bug**: a Jira issue in KAZ or RPG labelled WebUI or Web_UI_2.0, in status Created. One row per
bug in `checks`, by its issue id, so it survives a move between the two projects.

**Report**: what the reporter wrote and attached: the summary, the description, the fields, the
attachments and the reporter's comments. What the agent reads, and what the fingerprint hashes.

**Check**: one run of the agent on one bug, from the fetch to the verdict, recorded as one row in
`runs`. A **first check** sees the report as it arrived and is what the statistics count; a
**re-check** follows a change of the report while the bug is not understood, and edits the
service's comment rather than adding one. _Avoid_: attempt (that is a failed first check counted
towards giving up), validation.

**Outcome**: the agent's word on a check: **understood** (the cause found in the code and the
report clear: nothing happens), **not understood** (a comment with the agent's questions), **not
a WebUI bug** (the report is clear and the cause is elsewhere: shown to a person with the agent's
reason).

**Field check**: one of the program's own looks at the report's fields — section headings,
Affects versions, Devices, a HAR — passed or failed, with a detail. Hints for the agent and
numbers for the console, never the verdict.

**Requirement**: one of the items R1–R7 a report may hold (steps, expected and actual result,
versions, device, HAR, project), the id a field check carries. The list is a hint, not a rule.

**Comment**: the text the agent writes for a not-understood bug: the reporter's mention alone on
the first line, then its questions. At most one per bug; a re-check edits it. In a dry run it is
recorded and shown, not posted, until a person posts it.

**Request**: a check asked for by hand (`bin/bug-validator request KEY`, the console's form or
button), one row in `requests`; the service serves it before the next check of a poll, whatever
the bug's age, status or row.

**Post**: a comment a person sends to Jira from the console after a confirmation, one row in
`posts`; the one write to Jira in a dry run.

**Dry run**: the service's mode until the rollout reaches "comments live" (`VALIDATOR_DRY_RUN`,
true by default): everything is checked and recorded, nothing is written to Jira but a post.

**Row status**: the state of a bug's row in `checks`: `skipped`, `understood`, `not_webui`,
`dry_run`, `posting`, `commented`, `retry`, `failed` (architecture.md, Row statuses). The console
shows it as a **result**: an outcome, `error` or `skipped`.

**Poll**: one pass of the service, every three minutes: the trigger JQL, the rows brought up to
date, the plan of what is due, the checks, requests first. A poll that fails on the surroundings
is `poll_failed`; the next one simply tries again.

**The agent**: `claude -p` with the instructions in `agent/instructions.md`, reading the WebUI
code, the run's files and Jira through its tool, answering with a verdict. It writes the whole
comment; the program only validates it.

**The sandbox**: the bubblewrap namespace each agent run gets: the clone read-only, the run's
files read-only, node and claude, an empty home, the network, and nothing of the service's.

**The clone**: the service's own clone of the WebUI repository under `state/webui`, brought to
`origin/master` before a check and never a developer's working tree. Its commit goes with every
check.

**The console**: the web UI (`bin/bug-validator ui`, port 8081): three pages read from the
database and the log on every request, writing nothing but requests and posts. "The UI" in
older text.

**Heartbeat**: the service's pid and the time, written into `meta` every 5 s; the console calls
the service running while it is fresh.
