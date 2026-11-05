# Bug Validator — PRD

Status: dry run on the home server since 2026-10-17, reviewed and hardened for the move to a
server on 2026-10-28. On 2026-11-03 the check was redesigned: an agent that reads the WebUI code
decides whether a bug can be fixed from its report; built on 2026-11-04, measured next (rollout
step 3). Decisions are dated in the Decisions section; the rest of the document states the
current state.

A service that watches new WebUI bugs in Jira and, before the PM triages them, decides whether
the report is enough to fix the bug: an agent reads the report, its attachments and the WebUI
code, and looks for the cause. A bug it understands is left alone. A bug it cannot understand
gets a comment asking the reporter for what it needs. A bug whose cause is outside the WebUI is
shown to a person.

## Problem

Bugs reach development without the data needed to reproduce or verify them, and the gap is paid
for in QA rounds.

- 47% of the 849 bugs opened in the last six months fail the basic rules below (count by a
  colleague, 2026-10-14).
- A task that comes back from QA takes 12.7 days from the first Ready To Test to Done, against
  3.9 days without a return (medians; 165 of 898 WebUI tasks came back at least once).
- 61 bugs were closed as Cannot Reproduce, 20 of them for missing data; developers asked "how
  should it work?" 54 times. (Research report "Где буксует WebUI", see Sources.)

A checklist does not answer it. A report of one screenshot and a sentence (two buttons, one
always disabled; a redundant parameter to remove) is clear to a developer and fails half the
list. A comment that asks for what nobody needs teaches reporters to ignore comments.

A form or tool outside Jira will not be adopted: the team works in Jira and takes nothing new.
The check has to come to the bug, as a Jira comment.

## Users

- **Reporters** — QA testers and the QA lead, sometimes the PO or a developer. They get the
  comment and answer it.
- **QA lead** — confirms every new bug about 15 minutes after creation (median), before the
  comment comes.
- **PM** — triages every new bug (Created → To Do) and sees the comment while doing it. The
  comment is for this moment.

## Success

- Primary: fewer bugs reach development that cannot be fixed from their report. The database
  holds every check of every bug: its outcome and the field checks. The first check counts for
  the metric, since it sees the report as it arrived. The web UI shows the counts and the most
  common gaps. Measuring the metric over time is rollout step 6.
- The agent's outcome is trusted only once it agrees with a developer (AC7).
- Secondary: fewer Cannot Reproduce closures and fewer returns from QA for missing data; no
  comment on a bug that was clear.

## Scope

- Bugs in KAZ (Kazaar, NPB hardware) and RPG (Arpeggio, AFS) labelled WebUI or Web_UI_2.0, in
  status Created, whoever reported them. The exact query is `server/jira/queries.ts`.
- At most one comment per bug, on a bug the agent cannot understand: its questions to the
  reporter.

Non-goals: linking issues, changing fields, labels, assignee or status (the service only
comments, and edits only its own comment); new Jira fields; any UI outside Jira for reporters
(the web UI is for whoever runs the service); fixing the bug, or telling a developer the cause:
the agent's reasoning is kept for whoever runs the service and never reaches Jira; other
projects or issue types; running on server 236
(the network monitor host): Claude must not run there.

## The check

The agent reads the report (summary, description, fields, the reporter's own comments), its
attachments (screenshots, videos, HAR files) and a read-only clone of WebUI master, updated
before each check. It returns one of three outcomes:

| Outcome | When | What follows |
|---|---|---|
| Understood | The agent found the cause in the WebUI code, and it knows what the reporter means: what is wrong and how it should work | Recorded. No comment, and nothing else kept |
| Not understood | Either is missing | A comment to the reporter asking for what the agent needs |
| Not a WebUI bug | The report is clear and the cause is outside the WebUI code: the device, the backend, a chip | Recorded and shown in the web UI, no comment; a person decides |

A HAR file reaches the agent with its cookies, authorization headers and tokens removed.

**The list** (R1–R7) is a guide, not a rule. The agent sees it, with the program's field
checks, as hints for what to ask; nothing on it is forced into the comment. The field checks are
recorded on every check for the web UI's statistics. **Field facts** (R4–R6) are plain code
over the Jira API; for **R1–R3** the code only looks for a heading; **R7** is the agent's
judgement.

| # | Requirement | Rule |
|---|---|---|
| R1 | Steps to reproduce | Real steps a developer can follow, in text: the way to the page and what was done there counts; for a visual bug, the way to the screen. A video is not steps |
| R2 | Expected result | How it should work. May be implicit when the summary makes it obvious |
| R3 | Actual result | What happens now |
| R4 | Affects versions | The field is not empty (daily builds like `5.10.0-commit.3089`) |
| R5 | Device | KAZ: the Devices field, or a board type or chip named in the text. RPG: AFS in the Devices field |
| R6 | HAR file | A `.har` attachment |
| R7 | Project matches the product | RPG is AFS only; an RPG bug about NPB hardware, or a KAZ bug about AFS only, is asked about, not ruled on |

**Related bugs**: in a comment, the agent may name earlier bugs with the same symptom, after
reading them. The program checks that every key named exists. Never linked.

Board types and products: `jira-reference.md`.

## Comment

- Only on a bug the agent does not understand. English, addressed to the reporter with an
  @mention, in the agent's own words: what it needs to understand the bug, as short questions.
  Short enough to read in ten seconds: long questions go unanswered (research report).
- Warm and plain, the way a colleague writes: a greeting, a sentence that something is missing
  to fix the bug, the questions as polite requests, worded differently from one comment to the
  next so that no two open alike. No praise, no retelling of the bug, no filler: the warmth is
  in the wording, not in the length.
- A person approves every comment before it is posted (Post on request, Trigger). Posting
  without a person is rollout step 5.
- Every check that ends not understood is told to Slack, when the service has a webhook: the
  bug linked to Jira, what became of the comment (waiting for approval in a dry run; posted,
  edited or unchanged live), what the report lacks by the field checks, the comment proposed,
  a link to the bug's page in the console. An understood bug, one
  that is not a WebUI bug, a failed check and a post by hand send nothing. A message that
  fails costs the check nothing. A switch (`VALIDATOR_SLACK_NOTIFICATIONS=false`) turns the
  messages off.
- The program enforces only that the reporter is mentioned and nobody else, and that every
  issue key named is a real KAZ or RPG issue. Rules for the wording come later (Open
  questions); until then the person who approves is the guard.
- An understood bug, or one that is not a WebUI bug, gets no comment. The database records every
  checked bug either way.
- A comment is never deleted, and no second comment is posted. Until it is posted, a re-check's
  comment replaces the recorded one, and the history keeps both. A comment posted in the dry run
  is left as it is.

## Trigger

Polling, every 3 minutes. One Jira request a poll reads the report of every bug in the query
(about 9 at a time). A new bug waits for the QA lead (about 15 minutes), then for the PM's
triage (median time in Created 2.4 h over the last 90 days, 17 h over the year, measured
2026-10-26).

- **First check** once the bug is 30 minutes old. Reporters keep editing after they create a bug:
  a quarter of the reports change after their first 3 minutes, and a tenth after 30 minutes.
- **Re-check** of a bug the agent did not understand, when the report has changed since the last
  check and nothing has moved on the bug for 15 minutes, so a burst of edits gives one re-check.
  "The report" is a fingerprint of summary, description, attachment names, Affects versions,
  Devices, project and the reporter's own comments (an answer in a comment is an addition to the
  report). Other comments, labels, assignee and status are left out: the service's own comment
  and the QA lead's hand-off are not changes. A bug understood, or not a WebUI bug, is done.
- At most 5 checks per bug, failed ones included. Re-checks stop when the bug leaves Created.
- **On request**: whoever runs the service can ask for a check of any KAZ or RPG bug, by key or
  link, from the web UI or the command line. It runs next, whatever the bug's age, status or
  record, the caps included, and its result is recorded (or posted) as any check's.
- **Post on request**: whoever runs the service can post a bug's recorded comment from the web UI,
  in a dry run as well, after a confirmation that shows the comment. The text posted is the one
  confirmed; a comment changed since, or already in Jira, is not posted. The post follows the
  rules of any first post (State and failures), and the comment is then the bug's one comment.

Every WebUI bug counts, whoever reported it.

## State and failures

- One row per bug the service has dealt with, holding its current state
  (`.about/architecture.md`, Row statuses), and one row per check, the history. A row is never
  deleted, because it is the only thing that stops a second comment. The row follows the issue
  id, so a bug moved between KAZ and RPG is still the same bug.
- On the first start, every bug already in the query is recorded as skipped; the first start
  itself is recorded, so a start on an empty query still counts. A missing database is a first
  start. A skipped bug is never checked, not even when it changes, unless asked for.
- Bugs checked during the dry run stay recorded, and the service never posts or edits their
  dry-run comments live. A person may post one from the web UI (Trigger). A bug understood in
  the dry run gets a comment live only if it is asked for and the agent then does not
  understand it.
- Live, before a first comment is posted, Jira is read for a comment of the service's on the bug
  (by the service's account, opening with the reporter's mention). One found — after a crash
  while posting, a lost database, a second service — is adopted and edited, never posted again.
  The row is written before the post. A post Jira refused made no comment, and the bug goes back
  in line; a post with no answer leaves the bug "posting", and the next poll finds the comment, if
  it got there, and adopts it. An edit can be repeated, so it goes before its record: a service
  that dies in between edits again at a later poll. A comment a human deleted makes the edit
  fail. The re-checks then stop at the cap, and no new comment is posted. A dry run never writes
  over the record of a comment in Jira.
- A failed read is an error, never a clean result; that includes a Jira search the agent made
  and an attachment download. A failure of the surroundings — Jira unreachable or refusing (401,
  403, 429, 5xx), Claude failing (auth, a usage or rate limit, overload), claude not startable,
  the WebUI clone failing to update, the service stopping — costs no bug an attempt. One such
  failure puts its bug off to the next poll and the poll goes on; a second in a row ends the poll
  as an error, and the next poll tries again. A request the surroundings failed three times in a
  row fails, so it holds up nothing. A failure of one bug's check — the agent's verdict breaks
  the contract, times out, the issue JSON is not as expected — is tried at most 3 times, then the
  bug is recorded as "failed" and left alone. A failed re-check leaves the comment as it was and
  is tried at the next poll, within the 5 checks. A request (`request <KEY>`, the UI) checks a
  failed bug again; `check <KEY> [--recheck]` runs a bug by hand without writing anything.
- The service checks that claude starts before its first poll, and refuses to start on a
  database another running service holds.

## Rollout

1. ✓ **Offline check** (2026-10-16): `check` on bugs the QA lead had sent back and on good ones.
2. **Dry run** with the list, current, from 2026-10-17: the whole process runs as it will live;
   only the post is not sent, unless a person posts it from the web UI. Comments go to the
   database and the log and are reviewed in the web UI.
3. **Offline measurement** of the new check: `check` on about 20 past bugs a developer has marked
   understandable or not. It measures the agreement (AC7), the cost and the time of a check, and
   sets the budget cap per check. `check` prints the agent's reasoning for tuning; the service
   records it with every check, and the web UI shows it on the bug's page.
4. **Dry run** with the new check, the process of step 2 unchanged: every comment posted by a
   person. Going on is a judgement call, no formal exit criterion.
5. **Comments live** (`VALIDATOR_DRY_RUN=false`), from the personal account, once the comment's wording
   rules are set. Before that, check whether Jira notifies watchers when a comment is edited.
6. Later, separately decided: suggest links as Jira links; measure the success metric.

## Acceptance criteria

- AC1: A bug that matches the trigger is checked once it is 30 minutes old. A bug the agent did
  not understand is re-checked when its report changes while it is in Created, at most 5 checks
  in all. A bug gets at most one comment.
- AC2: Every check ends in one of the three outcomes. "Understood" and "not a WebUI bug" never
  produce a comment; "not understood" always does. The field checks are recorded on every check.
  Base checks have unit tests with real descriptions as fixtures.
- AC3: Restarting the service, deleting the database, a crash while posting, or a re-check never
  produces a second comment on the same bug.
- AC4: With `VALIDATOR_DRY_RUN=true` the service writes nothing to Jira of its own accord; only a comment a
  person confirms in the web UI is posted.
- AC5: The agent reads the bug through the project's read-only Jira server (KAZ and RPG only),
  the bug's attachments (a HAR file cleaned of cookies, authorization headers and tokens) and a
  read-only clone of WebUI master. It cannot write anything, run a shell, reach the web, or read
  any other file on the machine.
- AC6: A failed query, issue read, attachment download or agent run is reported as an error and
  produces no comment. A bug's own check is tried at most 3 times, then recorded as "failed". A
  failed re-check leaves the comment as it was. Failures of the surroundings cost no attempt.
- AC7: Before the service uses the new check (rollout step 4), its outcome agrees with a
  developer's on most of about 20 past bugs.

## Open questions

- About 11 of 60 recent WebUI bugs carried no WebUI label and are missed by the trigger. Accept
  the miss, or ask for the label somewhere?
- Does Jira notify watchers when a comment is edited? If it does, every re-check sends mail.
- The comment's wording rules, before posting without a person: length, links, images, what
  the program refuses.
- How a re-check edits a comment already posted, now that it is free text: strike through what
  was answered, or rewrite it.
- AC7: who marks the 20 bugs, which bugs, and how many must agree.
- The budget cap and timeout per check, from the offline measurement.

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

- 2026-10-28 — Before the move to a server, from a review of the code, the processing and the
  dry run's data:
  - No second comment, whatever happened before: before a first post, the service reads Jira
    for a comment of its own and adopts it. A `posting` row is checked again at the next poll
    instead of waiting for a human; a post Jira refused goes back in line. A comment id is never
    forgotten, and a dry run's check of a commented bug goes to the history only. One service per
    database (a lock file).
  - The comment's text is checked line by line against its format; any other line fails the
    check. The guardrails had covered the list, the mentions and the keys, and left free text —
    links, images, a remark a report talked the agent into — free to reach Jira. The related bugs
    recorded are the ones the comment names; a key is checked by reading it, which follows a
    moved bug.
  - Claude failing (auth, limits, overload, 5xx) and a stop of the service are failures of the
    surroundings: a 6-minute Claude outage had marked every due bug failed, and every restart
    had cost the bug being checked an attempt. A bug the surroundings fail on no longer holds up
    the poll.
  - The reporter's own comments are part of the report (fingerprint and prompt): a reporter who
    answers "Please add" in a comment is the natural case, and was ignored.
  - R1 counts the way to the page and the action, and for a visual bug the way to the screen:
    22 of 27 dry-run bugs were asked for steps, several of them wrongly (RPG-6245, RPG-6248,
    KAZ-9044). Related bugs are named only after reading them; half the dry run's matched a
    shared word.
  - The web UI listens on this machine unless its unit opens it, serves only known host names,
    takes requests only from its own pages, and may ask for a login (`VALIDATOR_USER`); the 2026-10-26
    "no login" holds on the LAN. `/healthz` for a monitor; the UI tells a crashed service from a
    running one.
  - Operations: the schema is versioned and backed up before a migration; `maintain` (a daily
    timer) backs up the database and cuts the log at 5 MB; the Jira token goes to the agent's
    tool in a private file, not on a command line; each agent run has a budget cap and records
    its model, cost and instructions. systemd stays the deployment; Docker is kept building, not
    used.

- 2026-10-29 — A comment can be posted by hand from the web UI, in a dry run as well: Post to
  Jira on a bug's page, a confirmation showing the comment, then the post. Reviewing dry-run
  comments showed ones worth posting before the whole service goes live. The UI writes a post
  request and the service posts, as with checks on request: one writer to Jira, one record, the
  same lookup before a post, so no second comment. The text confirmed is the text posted. A
  posted comment is then left as it is in the dry run (not re-checked, not edited).

- 2026-11-03 — The check is whether a developer could fix the bug from its report, not whether
  the report fills a list (an interview with the owner). A report of one screenshot and a
  sentence can be fully clear and failed half the list; asking for what nobody needs is noise.
  - An agent reads the report, its attachments (screenshots, videos, HAR files cleaned of
    cookies and tokens) and a read-only clone of WebUI master, and returns one of three
    outcomes: understood (the cause found in the code, and what the reporter means known), not
    understood, not a WebUI bug (clear, the cause outside the WebUI). Only "not understood" gets
    a comment. The master, not the reported build: simple, where the build would need Affects
    version mapped to a commit.
  - Nothing of an understood bug is kept but the outcome: the service does not point developers
    to the cause. "Not a WebUI bug" goes to a person in the web UI, not to Jira.
  - R1–R7 become a guide for the agent and the web UI's statistics, no longer a rule. Reversed:
    HAR on every bug (2026-10-16), field facts that must be named (2026-10-19).
  - The comment is the agent's own questions, free text, and a person approves every one before
    it is posted until the wording rules are set. Reversed: item names only (2026-10-18), the
    comment checked line by line (2026-10-28); the reporter-only mention and the real-keys check
    stay.
  - Re-checks only for a bug not understood: the others are done, and the check now costs far
    more.
  - The agent reads files, so it cannot be held by claude's flags alone (2026-10-19): it must
    see nothing on the machine but the WebUI clone and the bug (AC5). It runs in a bubblewrap
    sandbox, and its Jira tool runs outside it, in the service, so the Jira token never enters.
    Docker is no longer kept building (2026-10-28): the sandbox needs namespaces a container
    does not give without privileges.
  - The budget per check is set after measuring on real bugs; the outcome is trusted once it
    agrees with a developer on about 20 past bugs (AC7).
- 2026-11-04 — The agent's reasoning is recorded with every check and shown on the bug's page
  (the owner, reviewing the first checks by code in the web UI). The page showed the outcome
  and nothing of why, so reviewing the dry run and marking the bugs for AC7 meant running
  `check` again by hand. The reasoning is for whoever runs the service: it never reaches Jira,
  and no developer is pointed to the cause. Reversed: "nothing of an understood bug is kept but
  the outcome" (2026-11-03).
- 2026-11-04 — The comment is warm and plain (the owner): a greeting, a sentence that something
  is missing to fix the bug, the questions as polite requests, worded differently each time so
  that no two comments open alike; still no praise, no retelling of the bug, ten seconds to
  read. A bare list of questions reads as a bot, and a bot is ignored. Reversed: "no greeting,
  no closing line" in the agent's instructions (2026-11-04, the rework).
- 2026-11-05 — A Slack message for every check that ends not understood, through an incoming
  webhook, with a switch to turn the messages off (the owner). In the dry run every comment
  waits for a person, and nobody keeps the console open: a message is what gets the comment
  read and posted the same day instead of at the next look. Only "not understood" sends one:
  the other outcomes ask nothing of anyone. A webhook over a bot token: one message to one
  channel needs no scopes, no channel id and no app to keep; buttons in Slack, if ever wanted,
  would need the token.

## Sources

- Research report "Где буксует WebUI" (Jira, Bitbucket and git, 2024-09 … 2026-10):
  https://claude.ai/artifact/RYpzUGUtCajj4nt9XGjZGA
- Prototype of the earlier idea (a form outside Jira, rejected for adoption):
  https://claude.ai/artifact/7tAQRCsBxqQ7vBKKitRUdt
- "Building effective agent automations" (claude.dev blog, 2026-10-08): failed reads are errors.
  https://claude.dev/blog/building-effective-agent-automations/
