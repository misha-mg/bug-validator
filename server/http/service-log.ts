import { closeSync, existsSync, fstatSync, openSync, readFileSync, readSync } from 'node:fs'
import { StringDecoder } from 'node:string_decoder'
import { parseLogLine } from '../log.ts'
import type { Heartbeat } from './read.ts'

/** The service writes its heartbeat every 5 s (commands/run.ts); older than this, it is not running. */
export const HEARTBEAT_FRESH_MS = 15_000
/** Polls failed in a row before /healthz says so: a quarter of an hour at the default interval. */
export const UNHEALTHY_POLL_FAILURES = 5
/** How many of the latest events (other than `poll` and `check_start`) are kept for the Activity block. */
export const RECENT = 30
const CHECK_ENDS = new Set([
  'bug_understood',
  'bug_not_webui',
  'comment_dry_run',
  'comment_posted',
  'comment_edited',
  'check_failed',
  'check_deferred',
  'poll',
  'poll_failed',
  'service_start',
  'service_stopped',
  'fatal',
])

export interface ServiceStatus {
  /** From the latest `service_start`; null when the log does not reach back to it. */
  started: Date | null
  dryRun: boolean | null
  model: string | null
  pollIntervalMs: number | null
  agentTimeoutMs: number | null
  claudeVersion: string | null
  /** The WebUI commit the service started on; master moves on with `webui_fetched`. */
  webuiCommit: string | null
  stopped: boolean
  /** Asked to stop, not stopped yet (a check is being cut short). */
  stopping: boolean
  /** The error it died of, when its latest start ended in `fatal`; systemd starts it again. */
  crashed: string | null
  /** The latest line of any kind. */
  lastSeen: Date | null
  lastPoll: Date | null
  inQuery: number | null
  /** Of those, bugs not settled yet: too young for the first check, or changed and not yet quiet. */
  waiting: number | null
  /** The latest poll's error, when it failed. */
  pollError: string | null
  /** Polls failed in a row. */
  pollFailures: number
  /** The bug whose check started and has not ended: the agent is running. */
  checking: { key: string; since: Date } | null
}

export interface LogEvent {
  ts: Date
  level: string
  event: string
  fields: Record<string, unknown>
}

export type Liveness = 'running' | 'stopping' | 'stopped' | 'crashed' | 'silent'

const EMPTY: ServiceStatus = {
  started: null,
  dryRun: null,
  model: null,
  pollIntervalMs: null,
  agentTimeoutMs: null,
  claudeVersion: null,
  webuiCommit: null,
  stopped: false,
  stopping: false,
  crashed: null,
  lastSeen: null,
  lastPoll: null,
  inQuery: null,
  waiting: null,
  pollError: null,
  pollFailures: 0,
  checking: null,
}

/**
 * Crashed when its latest start ended in `fatal`; running (or stopping, when it said so) while
 * its heartbeat is fresh; with a stale heartbeat, stopped when the log ends in `service_stopped`
 * and silent when the log says nothing of a stop.
 */
export function liveness(status: ServiceStatus, now: Date, heartbeat: Heartbeat | null): Liveness {
  if (status.crashed !== null) return 'crashed'
  if (heartbeat && now.getTime() - heartbeat.seenAt.getTime() < HEARTBEAT_FRESH_MS) return status.stopping ? 'stopping' : 'running'
  return status.stopped ? 'stopped' : 'silent'
}

/** The heartbeat is fresh: the service process is alive, whatever the log says. */
export const alive = (heartbeat: Heartbeat | null, now: Date): boolean =>
  heartbeat !== null && now.getTime() - heartbeat.seenAt.getTime() < HEARTBEAT_FRESH_MS

/** What `/healthz` answers: ok while the service runs and its polls go through. */
export function health(
  status: ServiceStatus | null,
  now: Date,
  heartbeat: Heartbeat | null,
): { ok: boolean; state: Liveness | 'no_log'; pollFailures: number; lastSeen: string | null } {
  if (!status) return { ok: false, state: 'no_log', pollFailures: 0, lastSeen: heartbeat?.seenAt.toISOString() ?? null }
  const state = liveness(status, now, heartbeat)
  // The latest sign of life, from the log or the heartbeat, whichever is later.
  const seen = [status.lastSeen, heartbeat?.seenAt].filter((d): d is Date => d instanceof Date).sort((a, b) => b.getTime() - a.getTime())[0]
  return {
    ok: state === 'running' && status.pollFailures < UNHEALTHY_POLL_FAILURES,
    state,
    pollFailures: status.pollFailures,
    lastSeen: seen?.toISOString() ?? null,
  }
}

/**
 * `state/service.log`, one JSON line per event (server/log.ts), read as it grows: each read takes
 * only the bytes added since the last one. When the file is new to the reader, or was cut
 * (`maintain`), the cut part (`<log>.1`) is read first, so the service's start is still known.
 */
export class ServiceLog {
  private offset = 0
  /** The end of the file when it ends mid-line: the rest of the line comes with the next read. */
  private partial = ''
  /** A character split across two reads is joined, not garbled. */
  private decoder = new StringDecoder('utf8')
  private status: ServiceStatus = EMPTY
  /** The latest events other than `poll` and `check_start`, oldest first, at most RECENT. */
  readonly recent: LogEvent[] = []
  readonly path: string

  constructor(path: string) {
    this.path = path
  }

  /** The status as of the log's last line; null when there is no log. */
  read(): ServiceStatus | null {
    let fd: number
    try {
      fd = openSync(this.path, 'r')
    } catch {
      return null
    }
    try {
      const size = fstatSync(fd).size
      if (size < this.offset) {
        // Cut or emptied: read it again from the start.
        this.offset = 0
        this.partial = ''
        this.decoder = new StringDecoder('utf8')
        this.status = EMPTY
        this.recent.length = 0
      }
      if (this.offset === 0 && this.status === EMPTY) this.readCut()
      const buffer = Buffer.alloc(size - this.offset)
      const read = readSync(fd, buffer, 0, buffer.length, this.offset)
      this.offset += read
      const lines = (this.partial + this.decoder.write(buffer.subarray(0, read))).split('\n')
      this.partial = lines.pop() ?? ''
      for (const line of lines) this.take(line)
    } finally {
      closeSync(fd)
    }
    return this.status
  }

  /** The part `maintain` cut off, whole: older than anything in the log now. */
  private readCut(): void {
    const cut = `${this.path}.1`
    if (!existsSync(cut)) return
    for (const line of readFileSync(cut, 'utf8').split('\n')) this.take(line)
  }

  private take(line: string): void {
    const event = parse(line)
    // Not one of the service's lines: a crash's stack trace, say.
    if (!event) return
    const s = { ...this.status, lastSeen: event.ts }
    const f = event.fields
    if (event.event === 'service_start') {
      const interval = typeof f.pollIntervalS === 'number' ? f.pollIntervalS * 1000 : null
      Object.assign(s, {
        started: event.ts,
        dryRun: typeof f.dryRun === 'boolean' ? f.dryRun : null,
        model: str(f.model),
        pollIntervalMs: interval,
        agentTimeoutMs: typeof f.agentTimeoutS === 'number' ? f.agentTimeoutS * 1000 : null,
        claudeVersion: str(f.claudeVersion),
        webuiCommit: str(f.webuiCommit),
        stopped: false,
        stopping: false,
        crashed: null,
        pollFailures: 0,
      })
    } else if (event.event === 'service_stopping') {
      s.stopping = true
    } else if (event.event === 'service_stopped') {
      Object.assign(s, { stopped: true, stopping: false })
    } else if (event.event === 'fatal') {
      Object.assign(s, { crashed: str(f.error) ?? 'unknown error', stopping: false })
    } else if (event.event === 'poll') {
      Object.assign(s, { lastPoll: event.ts, inQuery: num(f.inQuery), waiting: num(f.waiting), pollError: null, pollFailures: 0 })
    } else if (event.event === 'poll_failed') {
      Object.assign(s, { lastPoll: event.ts, pollError: str(f.error) ?? 'unknown error', pollFailures: s.pollFailures + 1 })
    } else if (event.event === 'check_start' && typeof f.key === 'string') {
      s.checking = { key: f.key, since: event.ts }
    } else if (event.event === 'webui_fetched') {
      s.webuiCommit = str(f.to)
    }
    // A check ends with its result or its failure; a poll or a stop ends it too.
    if (CHECK_ENDS.has(event.event)) s.checking = null
    this.status = s
    // The Activity block: check_start is not kept, the check's end says what happened.
    if (event.event !== 'poll' && event.event !== 'check_start') {
      this.recent.push(event)
      if (this.recent.length > RECENT) this.recent.shift()
    }
  }
}

function parse(line: string): LogEvent | null {
  const parsed = parseLogLine(line)
  if (!parsed) return null
  const { ts, level, event, ...fields } = parsed
  const at = new Date(ts)
  if (Number.isNaN(at.getTime())) return null
  return { ts: at, level, event, fields }
}

const str = (value: unknown): string | null => (typeof value === 'string' ? value : null)
const num = (value: unknown): number | null => (typeof value === 'number' ? value : null)
