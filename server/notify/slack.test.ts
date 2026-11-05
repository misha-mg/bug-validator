// The Slack message and the notifier: what it says, where it links, and that a failure is logged, never thrown.
import assert from 'node:assert/strict'
import { afterEach, beforeEach, describe, it } from 'vitest'
import { type LogLine, parseLogLine, setLogSink } from '../log.ts'
import { type Notice, SlackNotifier, message, silent } from './slack.ts'

const WEBHOOK = 'https://hooks.slack.com/services/T1/B2/secret'
const links = { jiraBaseUrl: 'https://jira.example.com', consoleUrl: 'http://validator.lan:8081' }
const notice: Notice = {
  key: 'KAZ-9021',
  summary: 'Ports page <empty> & slow',
  reporter: 'Ann Reporter',
  recheck: false,
  requested: false,
  comment: 'waiting',
  text: '[~accountid:712020:abc]\nHi Ann,\nCould you attach a HAR of the page load?',
}

describe('message', () => {
  it('names the bug, what happened, who reported it, where to look, and quotes the comment without its mention line', () => {
    assert.equal(
      message(notice, links),
      [
        '*KAZ-9021* Ports page &lt;empty&gt; &amp; slow',
        'check: not understood, the comment waits for your approval',
        'reported by Ann Reporter · <http://validator.lan:8081/bugs/KAZ-9021|console> · <https://jira.example.com/browse/KAZ-9021|Jira>',
        '> Hi Ann,',
        '> Could you attach a HAR of the page load?',
      ].join('\n'),
    )
  })
  it('says a re-check, a request and each state of the comment; links to Jira alone without a console address', () => {
    const live = message({ ...notice, recheck: true, requested: true, comment: 'edited', reporter: null }, { ...links, consoleUrl: null })
    assert.match(live, /\nrequested re-check: not understood, comment edited\n<https:\/\/jira.example.com\/browse\/KAZ-9021\|Jira>\n/)
    assert.match(message({ ...notice, comment: 'kept' }, links), /a new comment recorded, the one in Jira kept/)
    assert.match(message({ ...notice, comment: 'posted' }, links), /comment posted/)
    assert.match(message({ ...notice, comment: 'unchanged' }, links), /comment unchanged/)
  })
  it('cuts a long comment and leaves out an empty one', () => {
    const long = message({ ...notice, text: `[~accountid:x]\n${'a'.repeat(2000)}` }, links)
    assert.ok(long.endsWith(`> ${'a'.repeat(1200)}…`))
    assert.ok(!message({ ...notice, text: '[~accountid:x]\n' }, links).includes('\n> '))
  })
})

describe('SlackNotifier', () => {
  const lines: LogLine[] = []
  beforeEach(() => {
    lines.length = 0
    setLogSink((line) => {
      const parsed = parseLogLine(line)
      if (parsed) lines.push(parsed)
    })
  })
  afterEach(() => setLogSink((line) => process.stdout.write(`${line}\n`)))

  it('posts the message as JSON to the webhook and logs it', async () => {
    const calls: { url: string; init: RequestInit }[] = []
    const fetchFn = (async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(url), init: init ?? {} })
      return new Response('ok', { status: 200 })
    }) as typeof fetch
    await new SlackNotifier(WEBHOOK, links, fetchFn).notify(notice)
    assert.equal(calls.length, 1)
    assert.equal(calls[0]?.url, WEBHOOK)
    assert.equal(calls[0]?.init.method, 'POST')
    const body = JSON.parse(String(calls[0]?.init.body)) as { text: string; unfurl_links: boolean }
    assert.equal(body.text, message(notice, links))
    assert.equal(body.unfurl_links, false)
    assert.deepEqual(
      lines.map((l) => [l.level, l.event, l.key, l.comment]),
      [['info', 'slack_notified', 'KAZ-9021', 'waiting']],
    )
  })
  it('logs a refusal and a failed request with the webhook kept out, and throws neither', async () => {
    const refused = (async () => new Response('no_service', { status: 404 })) as typeof fetch
    await new SlackNotifier(WEBHOOK, links, refused).notify(notice)
    const down = (async () => {
      throw new TypeError('fetch failed', { cause: new Error(`connect ECONNREFUSED ${WEBHOOK}`) })
    }) as typeof fetch
    await new SlackNotifier(WEBHOOK, links, down).notify(notice)
    assert.deepEqual(
      lines.map((l) => [l.level, l.event, l.key, l.error]),
      [
        ['warn', 'slack_failed', 'KAZ-9021', 'Error: HTTP 404: no_service'],
        ['warn', 'slack_failed', 'KAZ-9021', 'TypeError: fetch failed (cause: connect ECONNREFUSED <webhook>)'],
      ],
    )
  })
  it('the silent notifier does nothing', async () => {
    await silent.notify(notice)
    assert.deepEqual(lines, [])
  })
})
