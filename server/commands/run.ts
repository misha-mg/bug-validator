// `run`: the service's loop: poll, serve requests, wait, repeat; the lock on the database, the heartbeat, the stop.
import { readFileSync, rmSync, writeFileSync } from 'node:fs'
import { hostname } from 'node:os'
import { resolve } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { ClaudeAgent } from '../claude/agent.ts'
import { JiraTool } from '../claude/jira-mcp.ts'
import { loadConfig } from '../config.ts'
import { readBuild } from '../version.ts'
import { type CheckSettings, changedSettings, readSettings, settingsDefaults } from '../store/settings.ts'
import { Store } from '../store/store.ts'
import { JiraClient } from '../jira/client.ts'
import { describeError, log } from '../log.ts'
import { type Notifier, SlackNotifier, silent } from '../notify/slack.ts'
import type { Deps } from '../pipeline/deps.ts'
import { poll } from '../pipeline/poll.ts'
import { serveRequests } from '../pipeline/requests.ts'
import { Clone } from '../webui/clone.ts'

/** How often the service looks for a check asked for by hand while it waits for the next poll. */
const REQUEST_TICK_MS = 2000
/** How often the service says it is alive (store.heartbeat); the UI calls it running within 15 s of the last. */
const HEARTBEAT_MS = 5000

/**
 * The service: poll, wait, repeat, until SIGINT or SIGTERM. Polls never overlap. While it waits,
 * checks asked for by hand are served as they come, unless the last poll (or request) failed on
 * the surroundings: then they wait for a poll that succeeds. A stop kills the agent run in
 * progress; the bug it was checking loses nothing and is checked at a later poll.
 */
export async function run(): Promise<void> {
  const config = loadConfig()
  // The lock first: the start checks fetch the clone, which two services must not do at once.
  lock(`${config.dbFile}.lock`)
  const jira = new JiraClient(config.jira)
  const tool = new JiraTool(jira)
  await tool.listen()
  const agent = new ClaudeAgent(config.agent, config.webui.dir, tool)
  const claudeVersion = await agent.version()
  const clone = new Clone(config.webui.dir, config.webui.repoUrl)
  const webuiCommit = await clone.update(0)
  const store = new Store(config.dbFile)
  // The settings the console may change (store/settings.ts), read when they are needed: the
  // timing at every poll, the Slack switch at every message.
  const defaults = settingsDefaults(config.slackNotifications)
  const settings = (): CheckSettings => readSettings(config.dbFile, defaults).settings
  const slack = config.slack
    ? new SlackNotifier(config.slack.webhookUrl, { jiraBaseUrl: config.jira.baseUrl, consoleUrl: config.slack.consoleUrl })
    : null
  const notifier: Notifier = slack ? { notify: (notice) => (settings().slack ? slack.notify(notice) : Promise.resolve()) } : silent
  let inForce = settings()
  const deps: Deps = {
    config,
    jira,
    agent,
    clone,
    store,
    notifier,
    timing: () => {
      // Said once when the console changed them, so the log shows from which poll on.
      const now = settings()
      const changed = changedSettings(inForce, now)
      if (Object.keys(changed).length) log.info('settings_changed', changed)
      inForce = now
      return now
    },
  }
  const build = readBuild(resolve(import.meta.dirname, '../..'))
  log.info('service_start', {
    version: build.version,
    commit: build.commit ? `${build.commit}${build.dirty ? '+' : ''}` : null,
    dryRun: config.dryRun,
    slack: config.slack !== null && inForce.slack,
    firstCheckMinutes: inForce.firstCheckMinutes,
    quietMinutes: inForce.quietMinutes,
    maxChecks: inForce.maxChecks,
    pollIntervalS: config.pollIntervalMs / 1000,
    maxAttempts: config.maxAttempts,
    model: config.agent.model,
    agentTimeoutS: config.agent.timeoutMs / 1000,
    claudeVersion,
    webuiCommit,
    host: hostname(),
    // The absolute path and the rows in it: a database that is not the expected one shows here.
    dbFile: resolve(config.dbFile),
    bugs: deps.store.count(),
  })

  // The heartbeat: the UI reads it to say the service is running; a write that fails is logged, not fatal.
  const startedAt = new Date().toISOString()
  const beat = (): void => {
    try {
      deps.store.heartbeat(process.pid, startedAt)
    } catch (err) {
      log.warn('heartbeat_failed', { error: describeError(err) })
    }
  }
  beat()
  const heartbeat = setInterval(beat, HEARTBEAT_MS)

  const stop = new AbortController()
  const onSignal = (signal: string): void => {
    log.info('service_stopping', { signal })
    stop.abort()
  }
  process.once('SIGINT', () => onSignal('SIGINT'))
  process.once('SIGTERM', () => onSignal('SIGTERM'))

  while (!stop.signal.aborted) {
    const started = Date.now()
    let ok = true
    beat()
    try {
      const summary = await poll(deps, stop.signal)
      log.info('poll', { ...summary, ms: Date.now() - started })
    } catch (err) {
      // Jira or Claude is unavailable: an error, not a quiet poll. The next poll simply tries again.
      // A stop is not a failure: the check it cut short is made again later.
      if (!stop.signal.aborted) log.error('poll_failed', { error: describeError(err), ms: Date.now() - started })
      ok = false
    }
    const due = Date.now() + config.pollIntervalMs
    while (!stop.signal.aborted && Date.now() < due) {
      if (ok) {
        // serveRequests logs each request's failure; this says the requests now wait for a poll.
        ok = await serveRequests(deps, stop.signal).then(
          () => true,
          (err: unknown) => {
            if (!stop.signal.aborted) log.error('poll_failed', { error: describeError(err), ms: 0, requests: true })
            return false
          },
        )
      }
      await sleep(Math.min(REQUEST_TICK_MS, due - Date.now()), undefined, { signal: stop.signal }).catch(() => undefined)
    }
  }
  clearInterval(heartbeat)
  deps.store.close()
  await tool.close()
  log.info('service_stopped')
}

/**
 * One service per database: a second one would check every bug twice and, live, comment twice.
 * The lock file names the host and the pid; a lock left by a process that is gone is taken over.
 * A lock from another host (a database copied while its service ran) is refused: that service may
 * still be running there.
 */
function lock(file: string): void {
  const me = `${hostname()} ${process.pid}`
  try {
    writeFileSync(file, me, { flag: 'wx' })
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err
    const [host, pid] = readFileSync(file, 'utf8').trim().split(' ')
    if (host !== hostname())
      throw new Error(`${file}: the database is locked by a service on ${host} (pid ${pid}); stop that one, then delete the file`)
    if (running(Number(pid))) throw new Error(`${file}: another service runs on this database (pid ${pid}); stop it first`)
    writeFileSync(file, me)
  }
  process.once('exit', () => rmSync(file, { force: true }))
}

/** The pid is a live `run` of this service's (a pid is reused after a reboot: the UI or a check may have it). */
function running(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0 || pid === process.pid) return false
  try {
    return readFileSync(`/proc/${pid}/cmdline`, 'utf8').includes('cli.ts\0run')
  } catch {
    return false
  }
}
