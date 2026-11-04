---
name: decision
description: "Record a product or design decision the way this project does: a dated entry in docs/prd.md Decisions, the sections that state the current state updated in the same change, docs/architecture.md when a mechanism changes, an open idea when nothing is decided. Use when a rule, a threshold, a trigger, an outcome's meaning, a rollout step or a non-goal changes, or when an idea is discussed and parked."
user-invocable: true
---

# Record a decision

`docs/prd.md` is the record of what was decided and why; `docs/architecture.md` of how it is
built. A decision made or changed goes into the PRD in the same change as the code (CLAUDE.md).
What is discussed but not decided goes to `docs/open-ideas/`, one file each.

## The entry

Under **Decisions**, dated, after the latest:

```
- 2026-11-03 — <what was decided>, <where it came from: an interview, a review, a measurement>.
  <The reason in a sentence or two; numbers when there are any.> Reversed: <the earlier
  decision and its date>, when one is.
```

Then update what the decision changes, so the document states the current state and no reader
has to replay the history: The check, Comment, Trigger, State and failures, Rollout, Acceptance
criteria, Open questions (strike the one answered), the status line at the top when the stage
moves. A decision that reverses an earlier one names it; the earlier entry is left as it was.

## What goes where

| It changes… | Then also… |
|---|---|
| a mechanism (a status, a step of a check, a log event, a configuration variable) | `docs/architecture.md`, the matching section; a log event is a hand-kept contract with `src/ui/service-log.ts` and `src/ui/html.ts` (CLAUDE.md) |
| what the agent must do or say | `agent/instructions.md`; the `tune-agent` skill |
| a field of Jira, an id, a status of the workflow | `docs/jira-reference.md` |
| a threshold or a cap | the constant or the default in code, `docs/architecture.md` Configuration, `.env.example` |
| the stage of the rollout | the status line of the PRD, CLAUDE.md's "Stage" |
| the agent's isolation or what it may read | `docs/architecture.md` The agent run, AC5 |

## An idea, not a decision

`docs/open-ideas/<kebab-name>.md`: the status line (`idea, not decided`, from whom, when), the
problem it addresses, the idea in a few lines, what is open. When it is decided, its substance
moves into the PRD and the file goes; when it is dropped, the PRD's entry says so and the file
goes too.

## Do not

- Put a decision in a commit message or a comment only; the PRD is what a reader finds.
- Write "currently", "for now", "later we will": state the current state, and put the future in
  Rollout or Open questions.
- Leave a sentence that was true before the decision standing elsewhere in the document.
