# Bug Validator — PRD

Status: dry run (rollout step 2) on the home server since 2026-10-17. Decisions are dated in
the Decisions section; the rest of the document states the current state.

A service that watches new WebUI bugs in Jira and, before the PM triages them, comments on what
the report is missing: steps, expected and actual result, build, device, HAR, the right project;
and names earlier bugs that look the same. While the reporter fills the gaps, it keeps the
comment current.

## Problem

Bugs reach development without the data needed to reproduce or verify them, and the gap is paid
for in QA rounds.

- 47% of the 849 bugs opened in the last six months fail the basic rules below (count by a
  colleague, 2026-10-14).
- A task that comes back from QA takes 12.7 days from the first Ready To Test to Done, against
  3.9 days without a return (medians; 165 of 898 WebUI tasks came back at least once).
- 61 bugs were closed as Cannot Reproduce, 20 of them for missing data; developers asked "how
  should it work?" 54 times. (Research report "Где буксует WebUI", see Sources.)

A form or tool outside Jira will not be adopted: the team works in Jira and takes nothing new.
The check has to come to the bug, as a Jira comment.

## Users

- **Reporters** — QA testers and the QA lead, sometimes the PO or a developer. They get the
  comment and fill in what is missing.
- **QA lead** — confirms every new bug about 15 minutes after creation (median), before the
  comment comes.
- **PM** — triages every new bug (Created → To Do) and sees the comment while doing it. The
  comment is for this moment.

## Success

- Primary: the share of new WebUI bugs that fail the basic rules at triage drops from 47%. The
  database holds every check of every bug: the field facts and the agent's list of failed
  requirements. The first check counts for the metric, since it sees the report as it arrived.
  The web UI shows the counts and the most common gaps. Measuring the metric over time is rollout
  step 4.
- Secondary: fewer Cannot Reproduce closures and fewer returns from QA for missing data.

## Scope

- Bugs in KAZ (Kazaar, NPB hardware) and RPG (Arpeggio, AFS) labelled WebUI or Web_UI_2.0, in
  status Created, whoever reported them. The exact query is `src/jira/queries.ts`.
- One comment per bug, kept current: what is missing, one line each; a question when the project
  looks wrong; earlier bugs that look the same.

Non-goals: linking issues, changing fields, labels, assignee or status (the service only
comments, and edits only its own comment); new Jira fields; any UI outside Jira for reporters (the web UI is for whoever runs the service); other projects or issue types; running on server
236 (the network monitor host): Claude must not run there.

## Bug requirements

**Field facts** (R4–R6) are plain code over the Jira API; the agent must name every one that
fails. For **R1–R3** the code only looks for a heading; the agent reads the description and
decides whether the content is there (numbered steps without a "Steps" heading are still steps).
**R7** is the agent's judgement alone. A bug is *complete* when nothing in R1–R7 is missing.

| # | Requirement | Rule |
|---|---|---|
| R1 | Steps to reproduce | Real steps a developer can follow, in text. A video is not steps |
| R2 | Expected result | How it should work. May be implicit when the summary makes it obvious |
| R3 | Actual result | What happens now |
| R4 | Affects versions | The field is not empty (daily builds like `5.10.0-commit.3089`) |
| R5 | Device | KAZ: the Devices field, or a board type or chip named in the text. RPG: AFS in the Devices field |
| R6 | HAR file | A `.har` attachment, on every bug, no exceptions |
| R7 | Project matches the product | RPG is AFS only; an RPG bug about NPB hardware, or a KAZ bug about AFS only, is asked about, not ruled on |

**Related bugs** are not a requirement of the report but what the service adds: the agent
searches Jira (read-only) for bugs with the same symptom and names up to five. The program checks
that every key named exists. Never linked.

Board types and products: `jira-reference.md`.

## Comment

- English, addressed to the reporter with an @mention; lists only what is missing, one line each,
  the item's name and nothing else. Reporters are QA engineers; how-to text read as noise.
- Related bugs, if found, as a short list of keys with a reason of a few words.
- Short enough to read in ten seconds: long questions go unanswered (research report).
- A complete bug gets no comment unless a related bug is worth naming; then the comment is only
  that. The database records every checked bug either way.
- When the report changes while the bug is in Created, the comment is edited in place. Items
  that have arrived are struck through, newly missing ones are added at the end, and nothing is
  removed. When everything has arrived, every item is struck through. The comment is never
  deleted, and no second comment is posted. A bug with no comment gets its first one if it now
  lacks something.

## Trigger

Polling, every 3 minutes. One Jira request a poll reads the report of every bug in the query
(about 9 at a time). A new bug waits for the QA lead (about 15 minutes), then for the PM's
triage (median time in Created 2.4 h over the last 90 days, 17 h over the year, measured
2026-10-26).

- **First check** once the bug is 30 minutes old. Reporters keep editing after they create a bug:
  a quarter of the reports change after their first 3 minutes, and a tenth after 30 minutes.
- **Re-check** when the report has changed since the last check and nothing has moved on the
  bug for 15 minutes, so a burst of edits gives one re-check. "The report" is a fingerprint of
  summary, description, attachment names, Affects versions, Devices and project. Comments,
  labels, assignee and status are left out: the service's own comment and the QA lead's hand-off
  are not changes.
- At most 5 checks per bug, failed ones included. Re-checks stop when the bug leaves Created.
- **On request**: whoever runs the service can ask for a check of any KAZ or RPG bug, by key or
  link, from the web UI or the command line. It runs next, whatever the bug's age, status or
  record, the caps included, and its result is recorded (or posted) as any check's.

Every WebUI bug counts, whoever reported it.

## State and failures

- One row per bug the service has dealt with, holding its current state
  (`docs/architecture.md`, Row statuses), and one row per check, the history. A row is never
  deleted, because it is the only thing that stops a second comment. The row follows the issue
  id, so a bug moved between KAZ and RPG is still the same bug.
- On the first start, every bug already in the query is recorded as skipped; the first start
  itself is recorded, so a start on an empty query still counts. A missing database is a first
  start. A skipped bug is never checked, not even when it changes, unless asked for.
- Bugs checked during the dry run stay recorded, and their dry-run comments are never posted or
  edited live. A bug found complete in the dry run gets a comment live only if its report
  changes and it then lacks something.
- Live, the row is written before a comment is posted. A service that dies in between leaves
  the bug as "posting": shown for a human, never posted again by the service. An edit can be
  repeated, so it goes before its record: a service that dies in between edits again at a later
  poll. A comment a human deleted makes the edit fail. The re-checks then stop at the cap, and
  no new comment is posted.
- A failed read is an error, never a clean result. A failure of the surroundings — Jira
  unreachable or refusing (401, 403, 429, 5xx), claude not startable — ends the poll as an
  error and costs no bug an attempt; the next poll tries again. A failure of one bug's check —
  the agent's verdict breaks the contract, times out, the issue JSON is not as expected — is
  tried at most 3 times, then the bug is recorded as "failed" and left alone. A failed re-check
  leaves the comment as it was and is tried at the next poll, within the 5 checks. A request
  (`request <KEY>`, the UI) checks a failed bug again; `check <KEY> [--recheck]` runs a bug by
  hand without writing anything.
- The service checks that claude starts before its first poll.

## Rollout

1. ✓ **Offline check** (2026-10-16): `check` on bugs the QA lead had sent back and on good ones.
2. **Dry run**, current, from 2026-10-17: the whole process runs as it will live; only the post
   is not sent. Comments go to the database and the log and are reviewed in the web UI; fixes to the
   agent's instructions follow. A re-check's comment replaces the recorded one, and the history
   keeps both. Going live is a judgement call, no formal exit criterion.
3. **Comments live** (`DRY_RUN=false`), from the personal account. Before that, check whether
   Jira notifies watchers when a comment is edited.
4. Later, separately decided: suggest links as Jira links; measure the success metric.

## Acceptance criteria

- AC1: A bug that matches the trigger is checked once it is 30 minutes old, and re-checked when
  its report changes while it is in Created, at most 5 checks in all. It gets at most one comment,
  which a re-check edits in place.
- AC2: Every failed field fact (R4–R6) is named in the comment. The comment's list is exactly
  what is missing, with the items that arrived struck through on a re-check. A bug with nothing
  missing gets no "Please add" list. Base checks have unit tests with real descriptions as
  fixtures.
- AC3: Restarting the service, deleting the database, a crash while posting, or a re-check never
  produces a second comment on the same bug.
- AC4: With `DRY_RUN=true` nothing is written to Jira.
- AC5: The agent's only tool is the project's read-only Jira server (search, read issue, KAZ and
  RPG only): no Jira write, no shell, no files, no web.
- AC6: A failed query, issue read or agent run is reported as an error and produces no comment.
  A bug's own check is tried at most 3 times, then recorded as "failed". A failed re-check leaves
  the comment as it was. Failures of the surroundings cost no attempt.

## Open questions

- About 11 of 60 recent WebUI bugs carried no WebUI label and are missed by the trigger. Accept
  the miss, or ask for the label somewhere?
- Does Jira notify watchers when a comment is edited? If it does, every re-check sends mail.

## Decisions

- 2026-10-14 — Requirements R1–R7, the comment as a Jira comment, no form outside Jira (with a
  colleague).
- 2026-10-16 — Trigger: any reporter, no quiet period (the first filter had four QA assignees and
  held a bug for the QA lead's 15 minutes). HAR required on every bug, which also covers "at
  least one attachment", the old R7.
- 2026-10-17 — Judgement in the model, guardrails in code: the program never composes text.
  Claude auth by `claude setup-token`. The TUI, Python + Textual like pipeline-tui, is the place
  to watch the service. Dry run on the home server as a systemd user unit.
- 2026-10-18 — The comment lists item names only: the template and the how-to lines read as noise
  to QA engineers.
- 2026-10-19 — Related bugs are not a requirement: `missing` is R1–R7, related bugs are their
  own output. Guardrails in code are: schema, "comment needed" and the comment agree, every
  failed field fact named, the reporter mentioned and nobody else, only existing KAZ/RPG keys.
  Failures of the surroundings do not count against a bug; `requeue` replaces deleting rows. The
  bug is no longer re-read right before posting: measured 10–15 s after the check, 6 of 6
  rechecks were identical to the check and the number said nothing (the idea it served lives on
  in `open-ideas/follow-up-after-comment.md`). `report` removed: the TUI shows the same. The
  agent is sandboxed by claude's flags, not by Docker; Docker is for a server without a Claude
  login.
- 2026-10-26 — Rows follow the issue id, not the key: RPG-6223 became KAZ-9040, and a move while
  in Created would have brought a second comment.
- 2026-10-26 — Check at 30 minutes and re-check on change, replacing "no quiet period" (from a
  meeting with the team lead on 2026-10-20). Measured with `scripts/late-changes.ts` on 233 bugs:
  - A check at 3 minutes missed later changes in a quarter of the reports. In the dry run, 3 of
    the 9 bugs checked that early got a comment that was out of date.
  - Triage takes 2.4 h at the median, so the wait is 30 minutes, not the 2 hours discussed: by
    2 hours, 45% of bugs are triaged.
  - Waiting on the bug's age, on its report standing unchanged or on `updated` standing still
    gave the same result (82–85% still in Created, 9–10% changed after), so the plain age is
    used.
  - Change is the fingerprint of the report, not `updated`: `updated` moves on the hand-off, on
    comments and on the service's own edit.

  The comment is edited in place, struck through, never deleted: a comment that asks for what is
  already there is the problem, and a deleted one loses the record. Leaving a written comment
  alone was considered and dropped. A new guardrail: the comment's list equals `missing`, and a
  re-check keeps every item of the previous list.
- 2026-10-26 — The TUI (Python + Textual) is replaced by a web UI in the service's own stack
  (TypeScript, `node:http`, server-rendered pages, no dependency, no build): the same
  information, opened from the office network by the server's IP, and nothing more — no login,
  no TLS, no proxy. One language and toolchain; the UI imports the requirement ids and the row
  statuses instead of copying them, so only the log events stay a hand-kept contract. Two views
  of the same data were one too many to keep current.
- 2026-10-26 — A check on request, from the UI and the command line, replacing `requeue`: a
  person picks the bug, the running service checks it next and records the result as usual. The
  request is a row in the service's database (the one thing the UI writes), served by the
  service's loop, so there is one checker and one record; it ignores the age, the status and
  the caps, because a person asked. `requeue` only put a failed bug back in line for the next
  poll; a request does that and more.

## Sources

- Research report "Где буксует WebUI" (Jira, Bitbucket and git, 2024-09 … 2026-10):
  https://claude.ai/artifact/RYpzUGUtCajj4nt9XGjZGA
- Prototype of the earlier idea (a form outside Jira, rejected for adoption):
  https://claude.ai/artifact/7tAQRCsBxqQ7vBKKitRUdt
- "Building effective agent automations" (claude.dev blog, 2026-10-08): failed reads are errors.
  https://claude.dev/blog/building-effective-agent-automations/
