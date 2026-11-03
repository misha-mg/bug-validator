# Rework plan: the check by code

Working document for the rework decided on 2026-11-03 (`prd.md`, Decisions; `architecture.md`
describes the target). Each phase is one commit with tests green and `npm run typecheck` clean.
This file is deleted in the last phase: the PRD and the architecture doc are the record.

## 1. The target, analysed

After the rework the service is the same shape as today — poll, plan, check, record, post by
hand — with the check itself replaced. What a check is:

1. read the bug (Jira), compute the field checks (code);
2. bring the WebUI clone to master; download the attachments into a run directory (images as
   they are, HAR cleaned, video as frames);
3. run the agent in a sandbox that holds only the clone, the run directory and claude itself,
   with a Jira tool served by the service over loopback;
4. take one of three outcomes; a comment only for `not_understood`;
5. record; post nothing of its own in a dry run; a person approves a comment in the UI.

What stays untouched, because it is independent of the check: the trigger query, the fingerprint,
the 30-minute wait and the 15-minute quiet, the request and post queues, the one-comment rules
(adoption by the reporter's mention on the first line, `posting` before a post, the lock file),
the migrations, `maintain`, the web UI's server, the design system, the deploy units' shape.

What goes, because nothing uses it any more:

| gone | why |
|---|---|
| the comment's line format (`listedItems`, `commentParts`, `checkList`, `R7_QUESTIONS`, `ITEM_NAMES`, `LISTED_IDS`, `RELATED_LINE`) | the comment is free text a person approves |
| `missing` in the verdict, `FIELD_FACTS`, "every failed field fact named" | the list is a guide; statistics come from the field checks in code |
| `complete` status | `understood` |
| "Items added after the comment" (struck items) | replaced by field checks that passed after the comment |
| `config.agent.auth`, `claudeAuth` in the log and the UI | the token is required: the sandbox has no other login |
| the stdio Jira MCP started by claude, `TOOL_ERRORS_ENV`, the per-run `mcp.json` with `JIRA_*` | the tool runs in the service, over HTTP, with a per-run secret |
| `Dockerfile`, `compose.yaml`, `.dockerignore` | the sandbox needs namespaces a container does not give |
| "attachment names only" in the prompt | the agent reads them |

Invariants to keep in mind while coding:

- A comment's first non-empty line is the reporter's mention alone. This is not style: `ownComment`
  finds the service's comment in Jira by it. It stays a guardrail.
- A row is never deleted; a comment id is never forgotten; `understood` on a re-check keeps the
  comment id and leaves the Jira comment alone.
- The UI imports from the service's modules (`bug.ts`, `store.ts`) and never loads the agent,
  the clone or the Jira client.
- A failed read is an error. An attachment the reporter made unreadable is not an error.

Checked on this machine (WSL2, 2026-11-04): bwrap 0.6.1, ffmpeg, git, docker, claude 2.1.317;
`claude --version` runs inside a minimal bwrap (`--unshare-all --share-net`, `/usr` and the nvm
prefix read-only, tmpfs home); claude has `--restricted` (confines Read/Grep/Glob to the working
directories), `--add-dir`, `--tools`, `--json-schema`, http MCP servers in `--mcp-config`.

## 2. Phases

### Phase 0 — Design (done) and the server probe

- `prd.md`, `architecture.md` rewritten (2026-11-03/04). Commit: "Design: the check by code".
- On the server the service will run on: `bwrap --ro-bind / / --unshare-all --share-net true`,
  `ffmpeg -version`, `git ls-remote git@bitbucket.org:CGS/webui.git` as the service's user. A
  failure here changes Phase B (AppArmor: `kernel.apparmor_restrict_unprivileged_userns=0` or a
  profile; no SSH key: make one with read access).

### Phase A — The inputs: attachments and the clone (M)

Goal: everything the agent will read exists on disk, tested, with the pipeline not yet using it.

- `src/domain/bug.ts`: `Attachment` gains `id`, `size`, `mimeType`; `OUTCOMES`/`Outcome`;
  `FIELD_FACTS` removed. `src/jira/mapping.ts` fills the new fields (`attachment[].id`,
  `size`, `mimeType`). `docs/jira-reference.md`: the attachment content endpoint.
- `src/jira/client.ts`: `attachment(id): Promise<ReadableStream>` →
  `GET /rest/api/2/attachment/content/{id}` (follows the redirect, basic auth). The `Jira`
  interface gains it; `test/jira.test.ts` covers the redirect and a 4xx/5xx.
- `src/domain/har.ts` (pure): `cleanHar(text): string` — parse, drop `cookies`, blank the values
  of `Cookie`, `Set-Cookie`, `Authorization` and any header, query parameter or JSON field whose
  name matches `/token|secret|password|session|auth/i`, drop binary response bodies, cut text
  bodies at 64 KB, serialise. Throws on non-JSON. Test with a fixture HAR holding each case.
- `src/pipeline/attachments.ts`: `prepareFiles(jira, bug, dir): Promise<RunFile[]>`;
  `RunFile = { name, kind: 'image' | 'har' | 'frames' | 'text' | 'unread', note }`. Limits as
  constants (50 MB a file, a frame every 2 s, 30 a video). ffmpeg by `spawn` with a timeout.
  A `JiraError` propagates (a failed read); a HAR that is not JSON or a video ffmpeg refuses →
  `unread` with the reason. File names are sanitised (the attachment id as the prefix).
  Test with a generated 3-second video (`ffmpeg -f lavfi`) and a fake Jira.
- `src/webui/clone.ts`: `class Clone { constructor(dir, url); update(maxAgeMs): Promise<string> }`
  — clone when missing (`git clone --no-checkout`, then checkout detached), fetch
  `origin/master` when the last fetch is older than `maxAgeMs`, return the commit. `CloneError`
  (environmental). Test against a bare repository made in a temp dir.
- `src/config.ts`: `WEBUI_REPO_URL`, `WEBUI_DIR`; `.env.example`.

Done when: `node -e` scripts can prepare a real bug's files and update the clone; tests green.

### Phase B — The agent in the sandbox (L, starts with a spike)

Goal: `Agent.run` executes claude inside bwrap with Read/Grep/Glob over the clone and the run
directory, and a Jira tool it reaches over loopback.

Spike first (half a day, throwaway): by hand, `bwrap … claude -p --restricted --tools
Read,Grep,Glob --add-dir /work/bug --mcp-config <http server with a bearer header>
--json-schema …` on one real bug with a screenshot, against the clone. Confirm: Grep/Glob work
on `/work/webui`, Read shows the image, the MCP header is honoured, structured output comes
back, the cost. If the http MCP's header is not honoured: a 30-line stdio proxy inside the
sandbox that forwards JSON-RPC to the service's HTTP with the secret from its environment.

- `src/claude/sandbox.ts` (pure, tested): `bwrapArgs({ webuiDir, bugDir, toolchainDir, env })`
  → argv. Binds from `architecture.md`, The agent run. `toolchainDir` is the nvm prefix
  (`dirname(dirname(process.execPath))`), which holds node and claude.
- `src/claude/jira-mcp.ts` → `class JiraTool`: `node:http` on `127.0.0.1:0`, MCP streamable
  HTTP (POST JSON-RPC: `initialize`, `tools/list`, `tools/call`), the two tools as today;
  `issue(): { url, secret }` per run, `revoke(secret)`, `failures(secret): string | null` (what
  Jira failed during the run, replacing the file). Started by `run` and `check`; closed at exit.
- `src/claude/agent.ts`: `ClaudeAgent(config.agent, clone, jiraTool)`; `run(prompt, schema,
  bugDir, signal)` → spawns `bwrap` with the args and the claude flags
  (`--restricted`, `--tools Read,Grep,Glob`, `--add-dir /work/bug`, `--strict-mcp-config`,
  `--allowedTools Read,Grep,Glob,mcp__jira__search_issues,mcp__jira__get_issue`,
  `--max-turns`, `--max-budget-usd`, `--json-schema`, `--system-prompt`,
  `--no-session-persistence`, `--setting-sources ''`); the MCP config as a 0600 file inside
  the run directory, bound read-only. `AgentError` kinds unchanged; `start` covers bwrap too.
  `ClaudeAgent.version()` runs inside the sandbox (proves the sandbox at start).
- `src/config.ts`: `CLAUDE_CODE_OAUTH_TOKEN` required, `AGENT_MAX_TURNS`, provisional defaults
  (sonnet, 600 s, 100 turns, $2); `agent.auth` removed. `test/config.test.ts`.
- `test/agent.test.ts`: the argv (sandbox + claude flags), the result parsing as today, the
  secret revoked after a run.

Done when: `Agent.run` on a real bug returns structured output from inside the sandbox, and a
Read of `/home/cgs/.env`-like paths is refused (prove it once by hand in the spike, keep the test
on the argv).

### Phase C — The verdict, the prompt, the instructions, `check` (M)

Goal: `npm run check -- KEY` does the new check end to end and writes nothing.

- `src/domain/verdict.ts` rewritten: schema `{ outcome, reasoning, reason, comment }`;
  `parseVerdict(raw, reporterAccountId, secrets)` with the guardrails of `architecture.md` step
  4 (outcome agreement; the mention first and nobody else, stripped and reported; keys by
  regex; no secret in any field). Returns `{ verdict (without reasoning), reasoning,
  strippedMentions, keysInComment }`. `test/verdict.test.ts` rewritten.
- `src/domain/checks.ts`: `BaseCheck` → `FieldCheck`, `runBaseChecks` → `fieldChecks` (the
  `base_checks` column keeps its name). Tests follow.
- `src/domain/prompt.ts`: the report as today; the field checks "as hints"; the run's files with
  their kind and path under `/work/bug`; the clone at `/work/webui` and its commit; a re-check's
  previous comment. `test/prompt.test.ts`.
- `src/pipeline/checkBug.ts`: fetch → field checks → `clone.update(maxAge)` → `prepareFiles`
  into a `mkdtemp` run dir → prompt → agent → `parseVerdict` → keys exist → `CheckOutcome
  { bug, fingerprint, fieldChecks, verdict, reasoning, files, webuiCommit, strippedMentions,
  agent }`; the run dir removed in `finally`. `Deps` gains `clone`.
- `agent/instructions.md` rewritten: the goal; the three outcomes defined as the PRD does; how to
  investigate (read the WebUI's `CLAUDE.md` and `.about/` first; `apps/webui2` is Vue 3,
  `apps/webui` AngularJS; trace the steps or the screenshot to the component, store or API; stop
  when the cause is found or when it is clear what is missing); the comment (the mention alone
  on the first line, short questions, a related bug named only after reading it); the
  `not_webui` reason for a person; `reasoning` for whoever tunes the prompt.
- `src/commands/check.ts`: prints outcome, reason, reasoning, the files (kind, note), the field
  checks, the commit, cost, turns, time, the comment.

Done when: `check` on RPG-6245, KAZ-9043, RPG-6188 and one bug with a screenshot gives
outcomes you agree with, and a fabricated key in the comment fails the check.

### Phase D — The measurement (rollout step 3) (S code, then people's time)

- `scripts/agreement.ts`: `node scripts/agreement.ts marks.tsv` (`KEY<TAB>outcome` per line):
  runs `checkBug` on each in turn, writes nothing, prints per bug the developer's mark, the
  agent's outcome, cost and seconds; then agreement (count and share), mean and maximum cost
  and time, and every disagreement with the agent's reasoning. Reuses `check`'s deps.
- A developer marks about 20 past bugs (`prd.md`, Open questions: who, which, the threshold).
  Run; tune `agent/instructions.md`; run again. Set `AGENT_MODEL`, `AGENT_TIMEOUT_SECONDS`,
  `AGENT_MAX_TURNS`, `AGENT_MAX_BUDGET_USD` defaults from the numbers; record them in the
  PRD as a dated decision with the agreement reached.

Phases E–G need no result from D and go on in parallel.

### Phase E — State and the service (L)

Goal: the service runs the new check, records the outcomes, keeps every one-comment rule.

- `src/db/store.ts`: `CheckStatus` with `understood` and `not_webui`, without `complete`;
  migration v4: `checks.status` 'complete' → 'understood', `checks.reason`; `runs.outcome`,
  `runs.reason`, `runs.webui_commit`, `runs.files`, `runs.version` (default 1; old finished
  runs get `outcome` from their comment: none → 'understood', one → 'not_understood'); new runs
  write version 2. `CheckResultRow` carries outcome, reason, files, commit. `test/store.test.ts`:
  the migration from a v3 database fixture (`test/ui/state.ts` builds one).
- `src/pipeline/plan.ts`: `recheckableStatuses(dryRun)` = `['dry_run']` / `['commented']`;
  `understood` and `not_webui` are never due. `test/plan.test.ts`.
- `src/pipeline/handle.ts`: branch on `verdict.outcome`: `understood` → `recordResult`
  status `understood`, comment null, the row's comment id kept, `bug_understood`; `not_webui`
  → status `not_webui` with the reason, `bug_not_webui`; `not_understood` → today's comment
  path unchanged (dry run / edit / post). The log fields of `architecture.md`. `test/poll.test.ts`
  (it covers handle) rewritten for the outcomes; the one-comment cases kept as they are.
- `src/pipeline/poll.ts`, `requests.ts`: unchanged but for `Deps` and the `CloneError` being
  environmental (`isEnvironmental`).
- `src/commands/run.ts`: start the `JiraTool`; the start checks (`claude --version` in the
  sandbox, `ffmpeg -version`, `git --version`, `clone.update(0)`); `service_start` with
  `bwrapVersion` and `webuiCommit`, without `claudeAuth`; `webui_fetched` when the commit moved.
- `src/log.ts`: nothing new (events are strings); `architecture.md`'s Log table is the contract.

Done when: a local `npm start` in a dry run checks a requested bug end to end and the row and
the run show the outcome, the commit and the files.

### Phase F — The web UI (M)

- `src/ui/read.ts`: `Result = Outcome | 'error' | 'skipped'`; `RESULT_OF` by the new statuses;
  `BugView` gains `outcome`, `reason`; `Run` gains `outcome`, `webuiCommit`, `files`, `version`;
  `missing` and `firstMissing` removed; the field checks of the first finished run exposed
  (`firstFieldChecks`) for the statistics.
- `src/ui/stats.ts`: `periodStats` → checked, a `Share` per outcome, errors, cost;
  `problems` → `fieldChecksFailed` from the first run's field checks; `itemsAddedAfterComment`
  → `fieldChecksPassedAfterComment` (not-understood bugs with two finished runs: failed first,
  passed last); `checksPerDay` by `Result`; `needsAttention` adds `not_webui`.
- `src/ui/html.ts`: tiles per outcome; filters `all | understood | not_understood | not_webui |
  error | skipped`; the bug page: outcome pill, the reason, each run's outcome, commit, files
  (kind and note), version 1 runs labelled "list check"; the Claude row without auth, a WebUI
  commit row. `resultLabel`, `TONE` for the new results. `service-log.ts`: `bwrapVersion`,
  `webuiCommit`, the new events; `claudeAuth` gone. `server.ts`: the filter values.
- `test/ui/*`: `state.ts` builds a v4 database through the real `Store`; tests follow.

Done when: the three pages render the dry run's old rows (v1) and new rows (v2) without a gap.

### Phase G — Removal, docs, deploy (S)

- Delete `Dockerfile`, `compose.yaml`, `.dockerignore`. Delete this file.
- `CLAUDE.md`: the agent is sandboxed by bwrap, not by flags; the hand-kept contracts are the
  log events only (the comment's list is gone); the stage line.
- `docs/open-ideas/follow-up-after-comment.md`: "struck items" → "field checks passed after the
  comment", now measured on re-checks. `local-bug-index.md`: unchanged.
- `deploy/bug-validator.service`: `PATH` with bwrap, ffmpeg, git (`/usr/bin` is there); the
  header comment. `.env.example`: the token required, the WebUI variables, the agent's defaults.
- Sweep for the unused: `tsc --noUnusedLocals --noUnusedParameters` once by hand, a grep of every
  `export` for a second reference, `/simplify` on the diff, then `/code-review`.
- Commit, PR to `main`.

### Phase H — Deploy, dry run with the new check (rollout step 4)

- Stop the service; `maintain` (a backup); pull; `npm install` (nothing new); `.env`: the
  token, `WEBUI_REPO_URL`; start; check `service_start` (`webuiCommit`, `bwrapVersion`, no
  `first_start`); request one bug from the UI and read its page.
- Watch a week of checks in the UI; approve comments worth posting; tune the instructions
  (the service reads them on every run).

## 3. Risks, in the order they would hurt

1. bwrap on the server (user namespaces). Phase 0's probe answers it before any code.
2. claude inside bwrap doing a real run (tools, image Read, http MCP with a header). The Phase B
   spike answers it on day one of B; the stdio proxy is the fallback.
3. Cost and time per check. Phase D measures; the caps are provisional until then.
4. Prompt injection through the report or a HAR: the agent has no write and no network tool,
   the output is checked for secrets, and a person approves every comment. The residual risk is
   a comment that says something untrue, which the approval catches.
5. The clone's credentials on the server (an SSH key for the service's user). Phase 0.
6. A migration on the live database: `Store` copies the file before v4; `maintain` backs it up
   nightly; the move-to-another-machine steps cover a restore.

## 4. Decisions still to record in the PRD as they fall

- Phase D: the model, the caps, the agreement reached (who marked, how many agreed).
- Phase E: version 1 runs keep their stored verdict JSON (never deleted) and show as "list
  check" with no agent judgement displayed.
- Later, before rollout step 5: the comment's wording rules; how a re-check edits a posted
  free-text comment.
