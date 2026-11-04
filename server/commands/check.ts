import { ClaudeAgent } from '../claude/agent.ts'
import { JiraTool } from '../claude/jira-mcp.ts'
import { loadConfig } from '../config.ts'
import { Store } from '../store/store.ts'
import { JiraClient } from '../jira/client.ts'
import { checkBug } from '../pipeline/checkBug.ts'
import { Clone } from '../webui/clone.ts'

/**
 * `check <KEY> [--recheck]`: one bug, everything printed, the agent's reasoning included, nothing
 * written — to Jira or to the database. With `--recheck`, the comment recorded for the bug is
 * given to the agent to edit, as on a re-check. The clone is read as it is, never fetched: a
 * tuning session sees one commit.
 */
export async function check(key: string, recheck = false): Promise<void> {
  const config = loadConfig()
  const previousComment = recheck ? Store.recordedComment(config.dbFile, key) : null
  if (recheck && previousComment === null) throw new Error(`${key} has no recorded comment to re-check`)
  const jira = new JiraClient(config.jira)
  const tool = new JiraTool(jira)
  await tool.listen()
  let out: Awaited<ReturnType<typeof checkBug>>
  try {
    const deps = {
      jira,
      agent: new ClaudeAgent(config.agent, config.webui.dir, tool),
      clone: new Clone(config.webui.dir, config.webui.repoUrl),
    }
    out = await checkBug(deps, key, { previousComment })
  } finally {
    await tool.close()
  }
  const report = {
    key: out.bug.key,
    summary: out.bug.summary,
    url: `${config.jira.baseUrl}/browse/${out.bug.key}`,
    recheck,
    outcome: out.verdict.outcome,
    reason: out.verdict.reason || undefined,
    related: out.verdict.related,
    fields: { versions: out.bug.versions, devices: out.bug.devices, comments: out.bug.comments.length },
    files: out.files.map((f) => `${f.filename}: ${f.kind} — ${f.note}`),
    fieldChecks: out.fieldChecks.map((c) => `${c.id} ${c.passed ? 'present' : 'absent'} — ${c.detail}`),
    webuiCommit: out.webuiCommit,
    strippedMentions: out.strippedMentions,
    agent: { ...out.agent, model: config.agent.model },
  }
  process.stdout.write(JSON.stringify(report, null, 2) + '\n')
  process.stdout.write('\n--- reasoning ---\n' + out.reasoning + '\n')
  if (previousComment !== null) process.stdout.write('\n--- previous comment ---\n' + previousComment + '\n')
  if (out.verdict.outcome === 'not_understood') process.stdout.write('\n--- comment ---\n' + out.verdict.comment + '\n')
}
