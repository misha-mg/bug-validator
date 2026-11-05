// Slack: one message per check that ends not understood, through an incoming webhook. Off without
// one. A message that fails is logged and costs the check nothing: the record in the database is
// what matters, the message only points a person at it.
import { describeError, log } from '../log.ts'

/** What became of the comment of a check that ended not understood. */
export type CommentState =
  // A dry run: the comment is recorded and waits for a person to post it from the console.
  | 'waiting'
  // A dry run re-check of a bug whose comment is already in Jira: the new one goes to the history, the posted one is kept.
  | 'kept'
  | 'posted'
  | 'edited'
  // A live re-check whose comment came out the same: nothing changed in Jira.
  | 'unchanged'

/** What a notification says. */
export interface Notice {
  key: string
  summary: string
  reporter: string | null
  recheck: boolean
  requested: boolean
  comment: CommentState
  /** The comment's text, as the agent wrote it (its first line is the reporter's mention). */
  text: string
}

export interface Notifier {
  /** Never throws: a message that fails is logged, and the check it is about is recorded all the same. */
  notify(notice: Notice): Promise<void>
}

/** No Slack: the notifier of a service without a webhook, and of `check`, which writes nothing. */
export const silent: Notifier = { notify: async () => {} }

/** Where the message links: the bug in Jira, and its page in the console when the console has an address. */
export interface Links {
  jiraBaseUrl: string
  consoleUrl: string | null
}

const TIMEOUT_MS = 10_000
/** The comment is quoted up to this many characters: the message is a pointer, the console has the whole text. */
const QUOTE_MAX = 1200

const STATE_TEXT: Record<CommentState, string> = {
  waiting: 'the comment waits for your approval',
  kept: 'a new comment recorded, the one in Jira kept',
  posted: 'comment posted',
  edited: 'comment edited',
  unchanged: 'comment unchanged',
}

/** Slack's mrkdwn reads `&`, `<` and `>` as markup. */
const escape = (s: string): string => s.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')

const link = (url: string, text: string): string => `<${url}|${escape(text)}>`

/**
 * The message, in Slack's mrkdwn: the bug and what happened on one line, who reported it and
 * where to look on the next, then the comment quoted without its mention line.
 */
export function message(n: Notice, links: Links): string {
  const what = `${n.requested ? 'requested ' : ''}${n.recheck ? 're-check' : 'check'}: not understood, ${STATE_TEXT[n.comment]}`
  const where = [
    n.reporter ? `reported by ${escape(n.reporter)}` : null,
    links.consoleUrl ? link(`${links.consoleUrl}/bugs/${encodeURIComponent(n.key)}`, 'console') : null,
    link(`${links.jiraBaseUrl}/browse/${encodeURIComponent(n.key)}`, 'Jira'),
  ]
    .filter((s): s is string => s !== null)
    .join(' · ')
  return [`*${escape(n.key)}* ${escape(n.summary.trim())}\n${what}`, where, quote(n.text)].filter((s) => s !== '').join('\n')
}

/** The comment as a quote: the mention line dropped (it is Jira's), the rest cut when long. */
function quote(text: string): string {
  const lines = text.trim().split('\n')
  if (/^\[~accountid:[^\]]+\]\s*$/.test(lines[0] ?? '')) lines.shift()
  let body = lines.join('\n').trim()
  if (body === '') return ''
  if (body.length > QUOTE_MAX) body = body.slice(0, QUOTE_MAX).trimEnd() + '…'
  return body
    .split('\n')
    .map((l) => `> ${escape(l)}`)
    .join('\n')
}

export class SlackNotifier implements Notifier {
  private readonly webhookUrl: string
  private readonly links: Links
  private readonly fetchFn: typeof fetch

  constructor(webhookUrl: string, links: Links, fetchFn: typeof fetch = fetch) {
    this.webhookUrl = webhookUrl
    this.links = links
    this.fetchFn = fetchFn
  }

  async notify(n: Notice): Promise<void> {
    try {
      const res = await this.fetchFn(this.webhookUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: message(n, this.links), unfurl_links: false, unfurl_media: false }),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      })
      if (!res.ok) throw new Error(`HTTP ${res.status}: ${(await res.text().catch(() => '')).slice(0, 200)}`)
      log.info('slack_notified', { key: n.key, comment: n.comment })
    } catch (err) {
      // The webhook URL is a secret (anyone holding it can post): it never reaches the log.
      log.warn('slack_failed', { key: n.key, error: describeError(err).replaceAll(this.webhookUrl, '<webhook>') })
    }
  }
}
