// The agent against a developer's marks (prd.md, Rollout step 3; AC7). Runs the check on each
// bug of a TSV file (`KEY<TAB>understood|not_understood|not_webui` per line, `#` comments), writes
// nothing, and prints per bug the mark, the agent's outcome, cost and time; then the agreement,
// the cost and time figures, and every disagreement with the agent's reasoning.
//   node scripts/agreement.ts marks.tsv
import { readFileSync } from 'node:fs'
import { ClaudeAgent } from '../src/claude/agent.ts'
import { JiraTool } from '../src/claude/jira-mcp.ts'
import { loadConfig } from '../src/config.ts'
import { OUTCOMES, type Outcome } from '../src/domain/bug.ts'
import { ISSUE_KEY } from '../src/domain/key.ts'
import { JiraClient } from '../src/jira/client.ts'
import { checkBug } from '../src/pipeline/checkBug.ts'
import { Clone } from '../src/webui/clone.ts'

const file = process.argv[2]
if (!file) {
  process.stderr.write('usage: node scripts/agreement.ts <marks.tsv>\n')
  process.exit(2)
}
const marks: { key: string; mark: Outcome }[] = []
for (const [n, line] of readFileSync(file, 'utf8').split('\n').entries()) {
  if (!line.trim() || line.startsWith('#')) continue
  const [key, mark] = line.split('\t').map((s) => s.trim())
  if (!key || !ISSUE_KEY.test(key) || !(OUTCOMES as readonly string[]).includes(mark ?? ''))
    throw new Error(`${file}:${n + 1}: expected KEY<TAB>outcome, got "${line}"`)
  marks.push({ key, mark: mark as Outcome })
}

const config = loadConfig()
const jira = new JiraClient(config.jira)
const tool = new JiraTool(jira)
await tool.listen()
const deps = {
  jira,
  agent: new ClaudeAgent(config.agent, config.webui.dir, tool),
  clone: new Clone(config.webui.dir, config.webui.repoUrl),
}

interface Row {
  key: string
  mark: Outcome
  outcome: Outcome | 'failed'
  costUsd: number
  seconds: number
  reasoning: string
}
const rows: Row[] = []
const pad = (s: string, n: number): string => s.padEnd(n)
process.stdout.write(`${pad('bug', 10)}${pad('developer', 16)}${pad('agent', 16)}${pad('cost', 8)}s\n`)
for (const { key, mark } of marks) {
  const started = Date.now()
  let row: Row
  try {
    const out = await checkBug(deps, key)
    row = {
      key,
      mark,
      outcome: out.verdict.outcome,
      costUsd: out.agent.costUsd,
      seconds: (Date.now() - started) / 1000,
      reasoning: out.reasoning,
    }
  } catch (err) {
    row = {
      key,
      mark,
      outcome: 'failed',
      costUsd: 0,
      seconds: (Date.now() - started) / 1000,
      reasoning: err instanceof Error ? err.message : String(err),
    }
  }
  rows.push(row)
  process.stdout.write(
    `${pad(key, 10)}${pad(mark, 16)}${pad(row.outcome, 16)}${pad(`$${row.costUsd.toFixed(3)}`, 8)}${row.seconds.toFixed(0)}${row.outcome === mark ? '' : '   ✗'}\n`,
  )
}
await tool.close()

const agreed = rows.filter((r) => r.outcome === r.mark).length
const cost = rows.map((r) => r.costUsd)
const time = rows.map((r) => r.seconds)
const mean = (xs: number[]): number => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0)
process.stdout.write(`\nagreement: ${agreed} of ${rows.length} (${rows.length ? Math.round((agreed * 100) / rows.length) : 0}%)\n`)
process.stdout.write(
  `cost: mean $${mean(cost).toFixed(3)}, max $${Math.max(0, ...cost).toFixed(3)}, total $${cost.reduce((a, b) => a + b, 0).toFixed(2)}\n`,
)
process.stdout.write(`time: mean ${mean(time).toFixed(0)} s, max ${Math.max(0, ...time).toFixed(0)} s\n`)
for (const r of rows.filter((r) => r.outcome !== r.mark)) {
  process.stdout.write(`\n--- ${r.key}: developer ${r.mark}, agent ${r.outcome} ---\n${r.reasoning}\n`)
}
