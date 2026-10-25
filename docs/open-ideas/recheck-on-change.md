# Re-check on change

Status: agreed design, 2026-10-26, not built. From a meeting with the team lead on 2026-10-20
and a design session on 2026-10-26. When it is built, the PRD takes the decisions below (see the
last section) and this file is deleted. P7 was built on its own on 2026-10-26.

## Problem

The service checks a bug once, at the first poll after it is created (within 3 minutes), and
never looks at it again. Reporters keep editing after that: they add the description, the
build, the device and files. The comment then asks for things that are already there, and the
bug's row stops the service from noticing.

## What the data says

`node scripts/late-changes.ts`, run on 2026-10-26: 233 WebUI bugs in KAZ and RPG created in the
last 90 days, with their changelogs. "The report" means what the check reads: summary,
description, attachments, Affects versions, Devices, project.

| Check at | Bugs still in Created | Reports that change after the check |
|---|---|---|
| +3 min (today) | 96% | 25% |
| +15 min | 91% | 15% |
| +30 min | 85% | 10% |
| +1 h | 72% | 7% |
| +2 h | 55% | 5% |

- **A check at +3 minutes is often too early.** A quarter of the reports change after it. Of the
  changes, 85–95% are made by the reporter. A bug that changes is settled by 22 minutes (median
  of its last change).
- **Triage got fast.** The median time in Created is 2.4 h (90 days), against 17 h over the year
  and the "about 23 h" the PRD states. A 2-hour wait, as the meeting proposed, would put the
  comment after the triage on 45% of bugs.
- **What arrives late:** the description (17% of bugs), Devices (10%), attachments other than a
  HAR (8%), summary and Affects versions (6% each). A HAR arrives late on 2 bugs out of 233: it is
  attached at creation or never.
- **How to wait makes no difference.** Waiting until the bug is 30 minutes old, until its report
  has not changed for 30 minutes, or until `updated` is 30 minutes old: 85%, 83% and 82% of bugs
  are still in Created at the check, and 10%, 9% and 9% of reports change after it.
- **`updated` is not a content signal.** Assignee, labels, status and comments move it too: on 4
  bugs the last comment set it, on the rest some other change did. The QA lead's hand-off to the
  PM (about 15 minutes after creation) moves it on most bugs.
- **Dry run:** of the 9 bugs checked within minutes of creation, 3 got a comment that was out of
  date. On RPG-6219 the HAR and the description came 4 minutes after the check, and on RPG-6231
  the description came 54 minutes after. KAZ-9035 was read 30 seconds after its reporter filled in
  the description, build and device, yet the check saw all three empty: it asked for six items,
  and only the HAR is still missing.
- **Bugs move between projects.** RPG-6223 is now KAZ-9040. The service keys rows by issue key,
  so a bug moved while still in Created would look new and get a second comment.

## Result

- The service's comment matches the report as long as the bug is in Created. Items the reporter
  added are struck through, so the comment shows what was asked and what has arrived.
- Each bug has at most one comment from the service, as today.
- The database keeps every check, so "asked → added" can be counted per requirement.

## Decisions

- **P1. Check at 30 minutes.** A bug is checked once it is 30 minutes old: `created <= -30m` in
  the trigger. The comment then comes after the QA lead's look (about 15 minutes) and before the
  PM's triage (2.4 h median), and the PM's triage is the one that matters. A WebUI label added
  later brings the bug in at the first poll after the label.
- **P2. Fingerprint.** At every check the service stores a hash of the report: summary,
  description, attachment names, Affects versions, Devices, project. Comments, labels, assignee
  and status are left out, so the service's own comment and the hand-off are not changes.
- **P3. Re-check on change.** Every poll reads the report fields of every bug in the query
  (usually about 9) in the same single search request. A checked bug whose fingerprint differs is
  checked again once `updated` is 15 minutes old: a burst of edits gives one re-check. A bug
  gets at most 5 checks. Re-checks stop when the bug leaves Created.
- **P4. The comment is edited in place.** Items that have arrived are struck through (`-HAR
  file-`), and newly missing items are added. When nothing is missing, everything is struck
  through: there is no special case. A bug that had no comment and is now missing something gets
  its first comment. The agent writes the edited comment from the previous one. The code checks
  that every item still missing is not struck through and that every struck item is not missing.
- **P5. `failed` and `skipped` rows do not come back.** `requeue` stays the way back for a
  failed bug.
- **P6. Check history.** One row per check: time, fingerprint, verdict, comment. The bug's row
  keeps its current state. The TUI shows the history on a bug's screen and counts the first
  verdict for the 47% metric.
- **P7. Rows keyed by issue id.** The issue id stays the same when a bug moves between KAZ and
  RPG; the key does not. Built on 2026-10-26.

## Open questions

- Does Jira notify watchers when a comment is edited? If it does, each re-check sends mail. Check
  the notification scheme before going live.
- A human deletes the service's comment: the edit fails. Proposed: record it and leave the bug
  alone, with no new comment.
- Editing a comment is a new write to Jira, besides adding one. The token's "write Jira work"
  scope covers it.

## What changes in the PRD when built

- Trigger: check at 30 minutes, and re-check on change while the bug is in Created. The triage
  time is 2.4 h median, not 23 h. Users: the comment comes before the PM's triage, not before the
  QA lead's look.
- Decision 2026-10-16, "no quiet period": replaced by P1.
- AC1: "checked at 30 minutes, re-checked on change while in Created, at most one comment from
  the service, kept current".
- Non-goals: editing the service's own comment becomes allowed.
- Rollout: through the dry run first. In the dry run, a re-check's comment is recorded beside the
  first one.

## Not chosen

- `updated` as the change signal, with a re-read after posting: it moves on changes that are not
  content, and a re-read can capture someone else's edit made in between.
- Waiting until the report has not changed for 30 minutes, instead of a plain age: the same
  result in the data, and it needs the state of every waiting bug.
- A 2-hour wait: it comes after the triage on almost half of the bugs.
- Never touching a written comment: considered on 2026-10-26 and dropped. A comment that asks for
  what is already there is the problem this change solves.
- Deleting the comment when the bug is complete, or rewriting the list: struck-through items keep
  the record visible in Jira.
