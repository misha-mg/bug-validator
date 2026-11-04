/**
 * How bug reports change after they are created: the measurement behind
 * docs/open-ideas/recheck-on-change.md. Reads Jira and the database, writes nothing.
 *
 *   node scripts/late-changes.ts [days]     WebUI bugs created in the last `days` (default 90)
 */
import { existsSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { loadConfig } from '../src/config.ts'
import { FIELD_FACTS, type RequirementId } from '../src/domain/bug.ts'
import { checkFields } from '../src/domain/checks.ts'
import { type ChangelogEntry, ISSUE_FIELDS, JiraClient, type RawIssue } from '../src/jira/client.ts'
import { jiraTime as time, toBug } from '../src/jira/mapping.ts'

/** What the check reads, as changelog fields; everything else (assignee, links, labels) is not content. */
const KINDS = ['description', 'summary', 'HAR', 'other attachment', 'Affects versions', 'Devices', 'project'] as const
type Kind = (typeof KINDS)[number]

/** The service checks a bug at the first poll after it is created: within 3 minutes. */
const FIRST_POLL_MS = 3 * 60_000
const CHECKED_AT = [3, 15, 30, 60, 120, 240, 24 * 60].map((m) => m * 60_000)
const WEBUI_LABELS = ['WebUI', 'Web_UI_2.0']

interface Change {
  /** Milliseconds after the bug was created. */
  at: number
  kind: Kind
  byReporter: boolean
}

interface Measured {
  key: string
  created: number
  /** When the bug left Created, ms after creation; null while it is still there. */
  leftCreated: number | null
  /** Content changes while the bug was in Created, oldest first. */
  changes: Change[]
  /** When a WebUI label was added after creation, ms after creation; the bug entered the trigger then. */
  labelledAt: number | null
  /** Which of the issue's last change, last comment or neither `updated` equals. */
  updatedFrom: 'changelog' | 'comment' | 'neither'
  failingNow: RequirementId[]
}

function kindOf(item: ChangelogEntry['items'][number]): Kind | null {
  switch (item.fieldId ?? item.field) {
    case 'description':
      return 'description'
    case 'summary':
      return 'summary'
    case 'attachment':
      if (!item.toString) return null // a removal
      return item.toString.toLowerCase().endsWith('.har') ? 'HAR' : 'other attachment'
    case 'versions':
      return 'Affects versions'
    case 'customfield_10033':
      return 'Devices'
    case 'project':
    case 'Key':
      return 'project'
    default:
      return null
  }
}

const hasWebUiLabel = (labels: string | null): boolean => (labels ?? '').split(' ').some((l) => WEBUI_LABELS.includes(l))

function measure(issue: RawIssue, changelog: ChangelogEntry[]): Measured {
  const bug = toBug(issue)
  const created = time(bug.created)
  const leftEntry = changelog.find((e) => e.items.some((i) => i.field === 'status' && i.fromString === 'Created'))
  const leftCreated = leftEntry ? time(leftEntry.created) - created : null

  const changes: Change[] = []
  let labelledAt: number | null = null
  for (const entry of changelog) {
    const at = time(entry.created) - created
    if (labelledAt === null && entry.items.some((i) => i.field === 'labels' && !hasWebUiLabel(i.fromString) && hasWebUiLabel(i.toString))) {
      labelledAt = at
    }
    if (leftCreated !== null && at >= leftCreated) continue
    for (const item of entry.items) {
      const kind = kindOf(item)
      if (kind) changes.push({ at, kind, byReporter: entry.author?.accountId === bug.reporter?.accountId })
    }
  }

  const updated = time(bug.updated)
  const lastChange = Math.max(created, ...changelog.map((e) => time(e.created)))
  const comments = (issue.fields.comment as { comments?: { created: string; updated: string }[] } | undefined)?.comments ?? []
  const lastComment = Math.max(0, ...comments.flatMap((c) => [time(c.created), time(c.updated)]))
  const near = (t: number): boolean => Math.abs(t - updated) < 1000
  const updatedFrom = near(lastChange) ? 'changelog' : near(lastComment) ? 'comment' : 'neither'

  const failingNow = checkFields(bug)
    .filter((c) => !c.passed && FIELD_FACTS.includes(c.id))
    .map((c) => c.id)
  return { key: bug.key, created, leftCreated, changes, labelledAt, updatedFrom, failingNow }
}

function duration(ms: number): string {
  const m = ms / 60_000
  if (m < 1) return `${Math.round(ms / 1000)}s`
  if (m < 60) return `${Math.round(m)}m`
  if (m < 48 * 60) return `${(m / 60).toFixed(m < 600 ? 1 : 0)}h`
  return `${Math.round(m / 1440)}d`
}

/** Nearest-rank percentile of `values`, as a duration. */
function pct(values: number[], p: number): string {
  if (values.length === 0) return '-'
  const sorted = [...values].sort((a, b) => a - b)
  return duration(sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)] ?? 0)
}

const share = (n: number, of: number): string => `${n} (${of === 0 ? 0 : Math.round((100 * n) / of)}%)`

function table(rows: string[][]): string {
  const widths = rows[0]?.map((_, i) => Math.max(...rows.map((r) => (r[i] ?? '').length))) ?? []
  return rows
    .map(
      (r) =>
        '  ' +
        r
          .map((c, i) => c.padEnd(widths[i] ?? 0))
          .join('   ')
          .trimEnd(),
    )
    .join('\n')
}

/** Runs `fn` over `items`, `limit` at a time, keeping the order. */
async function inPool<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length)
  let next = 0
  const worker = async (): Promise<void> => {
    while (next < items.length) {
      const i = next++
      out[i] = await fn(items[i] as T)
    }
  }
  await Promise.all(Array.from({ length: limit }, worker))
  return out
}

interface CheckedRow {
  key: string
  checked_at: string
  verdict: string
}

function checkedRows(file: string): CheckedRow[] {
  if (!existsSync(file)) return []
  const db = new DatabaseSync(file, { readOnly: true })
  try {
    return db
      .prepare('SELECT key, checked_at, verdict FROM checks WHERE verdict IS NOT NULL ORDER BY checked_at')
      .all() as unknown as CheckedRow[]
  } finally {
    db.close()
  }
}

const days = Number(process.argv[2] ?? 90)
const config = loadConfig()
const jira = new JiraClient(config.jira)

const jql = `type = Bug AND labels IN (WebUI, Web_UI_2.0) AND project IN (Arpeggio, Kazaar) AND created >= -${days}d ORDER BY created ASC`
const issues = await jira.search(jql, ISSUE_FIELDS, 2000)
const sampleSize = issues.length
const checked = checkedRows(config.dbFile)
// Checked bugs are normally in the sample. One created earlier or relabelled since is fetched alone;
// one moved to the other project comes back under its new key.
const currentKey = new Map<string, string>()
for (const row of checked) {
  if (issues.some((i) => i.key === row.key)) continue
  const issue = await jira.getIssue(row.key)
  currentKey.set(row.key, issue.key)
  if (!issues.some((i) => i.key === issue.key)) issues.push(issue)
}

const measured = await inPool(issues, 4, async (issue) => measure(issue, await jira.changelog(issue.key)))
const byKey = new Map(measured.map((m) => [m.key, m]))
const sample = measured.slice(0, sampleSize)
const n = sample.length

const out: string[] = []
const first = sample[0]
const last = sample.at(-1)
out.push(
  `Sample: ${n} WebUI bugs in KAZ and RPG created in the last ${days} days` +
    (first && last
      ? ` (${new Date(first.created).toISOString().slice(0, 10)} … ${new Date(last.created).toISOString().slice(0, 10)}).`
      : '.'),
)
const left = sample.flatMap((m) => (m.leftCreated === null ? [] : [m.leftCreated]))
out.push(`Time in Created: median ${pct(left, 50)}, p90 ${pct(left, 90)}; ${n - left.length} still in Created.`)

out.push('', 'A check at a given time after creation: how many bugs are still in Created, and how many reports change after it')
out.push('(the report: summary, description, attachments, Affects versions, Devices, project):', '')
out.push(
  table([
    ['checked at', 'still in Created', 'report changes later'],
    ...CHECKED_AT.map((t) => [
      `+${duration(t)}`,
      share(sample.filter((m) => m.leftCreated === null || m.leftCreated > t).length, n),
      share(sample.filter((m) => m.changes.some((c) => c.at > t)).length, n),
    ]),
  ]),
)

const late = (m: Measured): Change[] => m.changes.filter((c) => c.at > FIRST_POLL_MS)
out.push('', `By field, changes later than +${duration(FIRST_POLL_MS)} (the service's check):`, '')
out.push(
  table([
    ['field', 'bugs', 'changes by reporter', 'last change: median', 'p90'],
    ...KINDS.map((kind) => {
      const hits = sample.map((m) => late(m).filter((c) => c.kind === kind)).filter((cs) => cs.length > 0)
      const all = hits.flat()
      const lastAt = hits.map((cs) => Math.max(...cs.map((c) => c.at)))
      return [kind, share(hits.length, n), share(all.filter((c) => c.byReporter).length, all.length), pct(lastAt, 50), pct(lastAt, 90)]
    }),
  ]),
)

const settled = sample
  .map(late)
  .filter((cs) => cs.length > 0)
  .map((cs) => Math.max(...cs.map((c) => c.at)))
out.push(
  '',
  `Last change per bug, of the ${settled.length} that change after +${duration(FIRST_POLL_MS)}: ` +
    `median ${pct(settled, 50)}, p75 ${pct(settled, 75)}, p90 ${pct(settled, 90)}, max ${pct(settled, 100)}.`,
)

const labelled = sample.flatMap((m) => (m.labelledAt === null ? [] : [m.labelledAt]))
out.push(
  `WebUI label added after creation (the bug enters the trigger then): ${labelled.length} bugs, median +${pct(labelled, 50)}, max +${pct(labelled, 100)}.`,
)

const from = (f: Measured['updatedFrom']): number => sample.filter((m) => m.updatedFrom === f).length
out.push(
  `What \`updated\` equals: the last changelog entry ${from('changelog')}, the last comment ${from('comment')}, neither ${from('neither')}.`,
)

if (checked.length > 0) {
  out.push('', `Checked by the service (${checked.length} bugs): what arrived after the check, while in Created.`)
  out.push('"checked" is when the row was written, after the agent run: a change made during the run counts as before.', '')
  out.push(
    table([
      ['bug', 'checked', 'missing', 'arrived after the check', 'field facts failing now'],
      ...checked.map((row) => {
        const key = currentKey.get(row.key) ?? row.key
        const m = byKey.get(key)
        if (!m) return [row.key, '?', '', '', '']
        const at = time(row.checked_at) - m.created
        const missing = (JSON.parse(row.verdict) as { missing: string[] }).missing
        const arrived = KINDS.flatMap((kind) => {
          const offsets = m.changes.filter((c) => c.kind === kind && c.at > at).map((c) => `+${duration(c.at - at)}`)
          return offsets.length > 0 ? [`${kind} ${offsets.join(' ')}`] : []
        })
        const name = key === row.key ? row.key : `${row.key}→${key}`
        return [name, `+${duration(at)}`, missing.join(' ') || '-', arrived.join(', ') || '-', m.failingNow.join(' ') || '-']
      }),
    ]),
  )
}

process.stdout.write(out.join('\n') + '\n')
