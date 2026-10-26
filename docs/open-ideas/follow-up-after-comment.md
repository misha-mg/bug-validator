# Follow-up after the comment

Status: idea, not decided. Replaces the "re-read right before posting" step dropped on
2026-10-19, which measured nothing (it ran 10–15 s after the check).

## Question it would answer

Does the comment work? That is: after the service asks for steps, a HAR or a build, does the
reporter add them, and how fast? Since 2026-10-26 the re-checks record it while the bug is in
Created (the `runs` table), and the UI counts the items that arrived then ("Items added after the
comment"). Nothing records what arrives after the bug leaves Created.

## The idea

Some time after a comment (a day; or when the bug leaves Created), read the bug again, run the
field facts again, and record per bug which of the asked-for items arrived and when. Skipped and
complete bugs are not followed up. One more row status is not needed: a `follow_up` JSON column
on the same row (asked, arrived, at).

The UI then shows "asked → added" per requirement, which is the success metric of the PRD
measured directly, not through the triage count.

## Open

- Trigger: a fixed delay, or the status change out of Created, or both.
- R1–R3 cannot be judged by code; either the agent reads the bug again (one more run per
  commented bug) or the follow-up covers field facts only.
