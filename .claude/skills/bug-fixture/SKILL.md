---
name: bug-fixture
description: "Save a real Jira bug as a test fixture (test/fixtures/<KEY>.json, the REST v2 issue JSON the service reads) and use it in a test. Use when a field check, the fingerprint, the prompt or a pipeline test needs a bug of a particular shape — a description without headings, a HAR attached, a reporter's comment — and no fixture has it. Reads Jira only."
user-invocable: true
---

# Save a bug as a fixture

The fixtures in `test/fixtures/` are real issues saved from Jira, with the fields the service
reads (`ISSUE_FIELDS` in `server/jira/client.ts`): `test/fixtures.ts` turns one into a `Bug` with
`bug('KAZ-9025')`. They are data, never edited by hand but for a field a test needs.

## Save one

From the repository root (the imports are relative to it):

```
node -e "
import('./server/config.ts').then(async ({ loadConfig }) => {
  const { JiraClient } = await import('./server/jira/client.ts');
  const key = process.argv[1];
  const issue = await new JiraClient(loadConfig().jira).getIssue(key);
  require('node:fs').writeFileSync('test/fixtures/' + key + '.json', JSON.stringify(issue, null, 2) + '\n');
  console.log(key, Object.keys(issue.fields).join(', '));
})" KAZ-1234
```

It writes `test/fixtures/KAZ-1234.json`. Check that `attachment[]` entries carry `id`, `size`
and `mimeType` (the mapping needs them), and that the description is the one the test is about:
reporters keep editing, so a bug that just arrived may change.

## Use it

- A field check: `test/checks.test.ts`, with `result('KAZ-1234')` and a comment on what the bug
  shows (no "Steps" heading but numbered steps, say).
- The prompt, the fingerprint, the poll: `bug('KAZ-1234', { ...overrides })` from
  `test/fixtures.ts`; the fake Jira in `test/poll.test.ts` serves fixtures by key.
- A HAR for the cleaner is `test/fixtures/session.har`, hand-made: a real one holds a session.

## Keep in mind

- A fixture holds real text, names and account ids of colleagues; it stays in the repository as
  the others do, but do not add one for a bug whose text should not be there.
- The comment on the fixture's purpose goes in the test that uses it, not in the JSON.
- `.about/architecture.md`, Running, names the fixtures a tuning session uses; a new one that
  shows a rule of the instructions can be named there too.
