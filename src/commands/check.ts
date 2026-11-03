import { ClaudeAgent } from '../claude/agent.ts';
import { JiraTool } from '../claude/jira-mcp.ts';
import { loadConfig } from '../config.ts';
import { Store } from '../db/store.ts';
import { JiraClient } from '../jira/client.ts';
import { checkBug } from '../pipeline/checkBug.ts';

/**
 * `check <KEY> [--recheck]`: one bug, everything printed, nothing written — to Jira or to the
 * database. With `--recheck`, the comment recorded for the bug is given to the agent to edit, as on
 * a re-check.
 */
export async function check(key: string, recheck = false): Promise<void> {
  const config = loadConfig();
  const previousComment = recheck ? Store.recordedComment(config.dbFile, key) : null;
  if (recheck && previousComment === null) throw new Error(`${key} has no recorded comment to re-check`);
  const jira = new JiraClient(config.jira);
  const tool = new JiraTool(jira);
  await tool.listen();
  let out: Awaited<ReturnType<typeof checkBug>>;
  try {
    out = await checkBug({ jira, agent: new ClaudeAgent(config.agent, config.webui.dir, tool) }, key, { previousComment });
  } finally {
    await tool.close();
  }
  const report = {
    key: out.bug.key,
    summary: out.bug.summary,
    url: `${config.jira.baseUrl}/browse/${out.bug.key}`,
    recheck,
    fields: { versions: out.bug.versions, devices: out.bug.devices, attachments: out.bug.attachments.map((a) => a.filename), comments: out.bug.comments.length },
    baseChecks: out.baseChecks.map((c) => `${c.id} ${c.passed ? 'PASS' : 'FAIL'} — ${c.detail}`),
    verdict: { comment_needed: out.verdict.comment_needed, missing: out.verdict.missing, related: out.verdict.related },
    strippedMentions: out.strippedMentions,
    agent: { ...out.agent, model: config.agent.model },
  };
  process.stdout.write(JSON.stringify(report, null, 2) + '\n');
  if (previousComment !== null) process.stdout.write('\n--- previous comment ---\n' + previousComment + '\n');
  process.stdout.write('\n--- comment ---\n' + (out.comment ?? '(no comment: the bug is complete)') + '\n');
}
