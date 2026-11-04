---
name: tune-agent
description: "Tune the agent's instructions (agent/instructions.md) on real bugs: run `check` on one bug or `scripts/agreement.ts` on a developer's marks, read the agent's reasoning, change the prompt, run again. Use when an outcome looks wrong, a comment asks for what nobody needs, the agreement with a developer is measured (PRD rollout step 3), or a model or cap is compared. Never for changing what the program enforces: that is code (server/domain/verdict.ts) and a PRD decision."
user-invocable: true
---

# Tune the agent

The agent writes the whole verdict; the program only validates it (`.about/architecture.md`, One
bug, step 4). So a wrong outcome or a bad question is almost always the prompt's, and the prompt
is `agent/instructions.md`, read on every run: the running service picks up an edit without a
restart. Nothing here writes to Jira or to the database.

## One bug

```
npm run check -- KAZ-1234            # the outcome, the files it got, the field checks, the reasoning, the comment
npm run check -- KAZ-1234 --recheck  # as a re-check of the comment recorded for the bug
VALIDATOR_AGENT_MODEL=haiku npm run check -- KAZ-1234   # another model, same bug
```

Read in this order: the **outcome**, then the **reasoning** (where it looked, what it found,
why it decided), then the **comment**. The reasoning is for you; it is never recorded or posted.
Two runs of the same bug can differ: run a doubtful one twice before changing anything.

## Many bugs: the agreement

A developer marks past bugs in a TSV, one per line, `KEY<TAB>understood|not_understood|not_webui`
(`#` comments allowed). Then:

```
node scripts/agreement.ts marks.tsv
```

It checks each bug, prints the mark, the agent's outcome, cost and seconds, then the agreement,
the cost and time figures, and every disagreement with the agent's reasoning. The clone is not
fetched, so the whole run sees one commit. Each check costs real money (about $0.04 on sonnet
for a clear bug); keep the file to the bugs the question is about.

## Changing the prompt

- Change one thing at a time and run the same bugs again. Keep the edit in the voice of the
  file: short, concrete, an example where a rule is subtle.
- The outcomes' definitions and the comment's shape come from `.about/prd/bug-validator.md` (The check,
  Comment). A change there is a decision: use the `decision` skill, not only this file.
- The output contract (`outcome`, `reasoning`, `reason`, `comment`) is enforced by
  `server/domain/verdict.ts`; the instructions describe it and must stay in step. Adding a field is
  code, tests and the PRD, not a prompt edit.
- The list R1–R7 is a hint in the prompt (`server/domain/prompt.ts`), never a rule: do not write
  "always ask for a HAR" back into the instructions; the 2026-11-03 decision removed exactly that.
- A model or cap found better goes into the defaults (`server/config.ts`, `.env.example`,
  `.about/architecture.md` Configuration) and into the PRD as a dated decision with the numbers.

## When the prompt is not the problem

- The agent could not read something: the `files` list says `unread` with the reason
  (`server/pipeline/attachments.ts`). A kind the agent should read is code.
- The verdict was refused (`VerdictError` in `check`'s error): the agent broke the contract.
  Usually the mention line or a comment on an understood bug; the instructions' Output section
  is where to make it clearer.
- Jira or Claude failed (`service` kind): not the bug's, try again later.
