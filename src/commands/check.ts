import { ClaudeAgent } from '../claude/agent.ts';
import { loadConfig } from '../config.ts';
import { JiraClient } from '../jira/client.ts';
import { checkBug } from '../pipeline/checkBug.ts';

/** `check <KEY>`: one bug, everything printed, nothing written — to Jira or to the database. */
export async function check(key: string): Promise<void> {
  const config = loadConfig();
  const out = await checkBug({ jira: new JiraClient(config.jira), agent: new ClaudeAgent(config.agent) }, key);
  const report = {
    key: out.bug.key,
    summary: out.bug.summary,
    url: `${config.jira.baseUrl}/browse/${out.bug.key}`,
    fields: { versions: out.bug.versions, devices: out.bug.devices, attachments: out.bug.attachments.map((a) => a.filename), comments: out.bug.comments.length },
    baseChecks: out.baseChecks.map((c) => `${c.id} ${c.passed ? 'PASS' : 'FAIL'} — ${c.detail}`),
    verdict: { comment_needed: out.verdict.comment_needed, missing: out.verdict.missing, related: out.verdict.related },
    strippedMentions: out.strippedMentions,
    agent: { ...out.agent, model: config.agent.model },
  };
  process.stdout.write(JSON.stringify(report, null, 2) + '\n');
  process.stdout.write('\n--- comment ---\n' + (out.comment ?? '(no comment: the bug is complete)') + '\n');
}
