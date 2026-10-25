# Bug Validator — PRD

Status: dry run (rollout step 2) on the home server since 2026-10-17. Decisions are dated in
the Decisions section; the rest of the document states the current state.

A service that watches new WebUI bugs in Jira and, before the PM triages them, comments on what
the report is missing: steps, expected and actual result, build, device, HAR, the right project;
and names earlier bugs that look the same.

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
- **QA lead** — confirms every new bug about 15 minutes after creation (median). The comment
  should be there by then.
- **PM** — triages every new bug (Created → To Do) and sees the comment while doing it.

## Success

- Primary: the share of new WebUI bugs that fail the basic rules at triage drops from 47%. The
  database holds, per bug, the field facts and the agent's list of failed requirements; the TUI
  shows the counts and the most common gaps. Measuring the metric over time is rollout step 4.
- Secondary: fewer Cannot Reproduce closures and fewer returns from QA for missing data.

## Scope

- Bugs in KAZ (Kazaar, NPB hardware) and RPG (Arpeggio, AFS) labelled WebUI or Web_UI_2.0, in
  status Created, whoever reported them. The exact query is `src/jira/queries.ts`.
- One comment per bug: what is missing, one line each; a question when the project looks wrong;
  earlier bugs that look the same.

Non-goals: linking issues, changing fields, labels, assignee or status (the service only
comments); new Jira fields; any UI outside Jira; other projects or issue types; running on server
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

## Trigger

Polling, every 3 minutes; a poll that finds nothing new costs one Jira request. A new bug waits
for the QA lead (about 15 minutes), then for the PM's triage (median time in Created 2.4 h over
the last 90 days, 17 h over the year, measured 2026-10-26); the bug is checked at the first poll after it is created, so the comment is there before
the QA lead looks. Every WebUI bug counts, whoever reported it, with no quiet period: a bug in
Created is a finished report, not a draft.

## State and failures

- One row per bug the service has dealt with (`docs/architecture.md`, Row statuses). A bug is
  checked once; a row is never deleted, because it is the only thing that stops a second comment.
  The row follows the issue id, so a bug moved between KAZ and RPG is still the same bug.
- On the first start, every bug already in the query is recorded as skipped; the first start
  itself is recorded, so a start on an empty query still counts. A missing database is a first
  start. Bugs checked during the dry run stay recorded, so going live brings no comments on them.
- Live, the row is written before the comment is posted. A service that dies in between leaves
  the bug as "posting": shown for a human, never posted again by the service.
- A failed read is an error, never a clean result. A failure of the surroundings — Jira
  unreachable or refusing (401, 403, 429, 5xx), claude not startable — ends the poll as an
  error and costs no bug an attempt; the next poll tries again. A failure of one bug's check —
  the agent's verdict breaks the contract, times out, the issue JSON is not as expected — is
  tried at most 3 times, then the bug is recorded as "failed" and left alone. `requeue <KEY>`
  puts a failed bug back in line; `check <KEY>` runs a bug by hand without writing anything.
- The service checks that claude starts before its first poll.

## Rollout

1. ✓ **Offline check** (2026-10-16): `check` on bugs the QA lead had sent back and on good ones.
2. **Dry run**, current, from 2026-10-17: the whole process runs as it will live; only the post
   is not sent. Comments go to the database and the log and are reviewed in the TUI; fixes to the
   agent's instructions follow. Going live is a judgement call, no formal exit criterion.
3. **Comments live** (`DRY_RUN=false`), from the personal account.
4. Later, separately decided: suggest links as Jira links; measure the success metric.

## Acceptance criteria

- AC1: A bug that matches the trigger is checked once, at the first poll after it is created, and
  gets at most one comment.
- AC2: Every failed field fact (R4–R6) is named in the comment; a bug with nothing missing gets no
  "Please add" list. Base checks have unit tests with real descriptions as fixtures.
- AC3: Restarting the service, deleting the database, or a crash while posting never produces a
  second comment on the same bug.
- AC4: With `DRY_RUN=true` nothing is written to Jira.
- AC5: The agent's only tool is the project's read-only Jira server (search, read issue, KAZ and
  RPG only): no Jira write, no shell, no files, no web.
- AC6: A failed query, issue read or agent run is reported as an error and produces no comment.
  A bug's own check is tried at most 3 times, then recorded as "failed"; failures of the
  surroundings cost no attempt.

## Open questions

- About 11 of 60 recent WebUI bugs carried no WebUI label and are missed by the trigger. Accept
  the miss, or ask for the label somewhere?

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
  in Created would have brought a second comment. Re-check on change agreed and not yet built:
  `open-ideas/recheck-on-change.md`.

## Sources

- Research report "Где буксует WebUI" (Jira, Bitbucket and git, 2024-09 … 2026-10):
  https://claude.ai/artifact/RYpzUGUtCajj4nt9XGjZGA
- Prototype of the earlier idea (a form outside Jira, rejected for adoption):
  https://claude.ai/artifact/7tAQRCsBxqQ7vBKKitRUdt
- "Building effective agent automations" (claude.dev blog, 2026-10-08): failed reads are errors.
  https://claude.dev/blog/building-effective-agent-automations/
