import { closeSync, fstatSync, openSync, readSync } from 'node:fs';

// config.ts's default, for a log that starts after the service did.
const DEFAULT_INTERVAL_MS = 3 * 60 * 1000;
// A poll that checks bugs logs nothing while the agent runs, up to its timeout (3 minutes).
const AGENT_MARGIN_MS = 5 * 60 * 1000;
/** How many of the latest events (other than `poll`) are kept for the Activity block. */
export const RECENT = 30;

export interface ServiceStatus {
  /** From the latest `service_start`; null when the log does not reach back to it. */
  started: Date | null;
  dryRun: boolean | null;
  model: string | null;
  pollIntervalMs: number | null;
  claudeVersion: string | null;
  claudeAuth: string | null;
  stopped: boolean;
  /** The latest line of any kind. */
  lastSeen: Date | null;
  lastPoll: Date | null;
  inQuery: number | null;
  /** Of those, bugs not settled yet: too young for the first check, or changed and not yet quiet. */
  waiting: number | null;
  /** The latest poll's error, when it failed. */
  pollError: string | null;
}

export interface LogEvent {
  ts: Date;
  level: string;
  event: string;
  fields: Record<string, unknown>;
}

export type Liveness = 'running' | 'stopped' | 'silent';

const EMPTY: ServiceStatus = {
  started: null,
  dryRun: null,
  model: null,
  pollIntervalMs: null,
  claudeVersion: null,
  claudeAuth: null,
  stopped: false,
  lastSeen: null,
  lastPoll: null,
  inQuery: null,
  waiting: null,
  pollError: null,
};

/** Stopped when it said so; silent when it has written nothing for two polls and an agent run. */
export function liveness(status: ServiceStatus, now: Date): Liveness {
  if (status.stopped) return 'stopped';
  const interval = status.pollIntervalMs ?? DEFAULT_INTERVAL_MS;
  if (!status.lastSeen || now.getTime() - status.lastSeen.getTime() > 2 * interval + AGENT_MARGIN_MS) return 'silent';
  return 'running';
}

/**
 * `state/service.log`, one JSON line per event (src/log.ts), read as it grows: each read takes
 * only the bytes added since the last one.
 */
export class ServiceLog {
  private offset = 0;
  /** The end of the file when it ends mid-line: the rest of the line comes with the next read. */
  private partial = '';
  private status: ServiceStatus = EMPTY;
  /** The latest events other than `poll`, oldest first, at most RECENT. */
  readonly recent: LogEvent[] = [];
  readonly path: string;

  constructor(path: string) {
    this.path = path;
  }

  /** The status as of the log's last line; null when there is no log. */
  read(): ServiceStatus | null {
    let fd: number;
    try {
      fd = openSync(this.path, 'r');
    } catch {
      return null;
    }
    try {
      const size = fstatSync(fd).size;
      if (size < this.offset) {
        // Rotated or emptied: read it again from the start.
        this.offset = 0;
        this.partial = '';
        this.status = EMPTY;
        this.recent.length = 0;
      }
      const buffer = Buffer.alloc(size - this.offset);
      const read = readSync(fd, buffer, 0, buffer.length, this.offset);
      this.offset += read;
      const lines = (this.partial + buffer.toString('utf8', 0, read)).split('\n');
      this.partial = lines.pop() ?? '';
      for (const line of lines) this.take(line);
    } finally {
      closeSync(fd);
    }
    return this.status;
  }

  private take(line: string): void {
    const event = parse(line);
    // Not one of the service's lines: a crash's stack trace, say.
    if (!event) return;
    const s = { ...this.status, lastSeen: event.ts };
    const f = event.fields;
    if (event.event === 'service_start') {
      const interval = typeof f.pollIntervalS === 'number' ? f.pollIntervalS * 1000 : null;
      Object.assign(s, {
        started: event.ts,
        dryRun: typeof f.dryRun === 'boolean' ? f.dryRun : null,
        model: str(f.model),
        pollIntervalMs: interval,
        claudeVersion: str(f.claudeVersion),
        claudeAuth: str(f.claudeAuth),
        stopped: false,
      });
    } else if (event.event === 'service_stopped') {
      s.stopped = true;
    } else if (event.event === 'poll') {
      Object.assign(s, { lastPoll: event.ts, inQuery: num(f.inQuery), waiting: num(f.waiting), pollError: null });
    } else if (event.event === 'poll_failed') {
      Object.assign(s, { lastPoll: event.ts, pollError: str(f.error) ?? 'unknown error' });
    }
    this.status = s;
    if (event.event !== 'poll') {
      this.recent.push(event);
      if (this.recent.length > RECENT) this.recent.shift();
    }
  }
}

function parse(line: string): LogEvent | null {
  try {
    const { ts, level, event, ...fields } = JSON.parse(line) as Record<string, unknown>;
    if (typeof ts !== 'string' || typeof event !== 'string') return null;
    const at = new Date(ts);
    if (Number.isNaN(at.getTime())) return null;
    return { ts: at, level: typeof level === 'string' ? level : 'info', event, fields };
  } catch {
    return null;
  }
}

const str = (value: unknown): string | null => (typeof value === 'string' ? value : null);
const num = (value: unknown): number | null => (typeof value === 'number' ? value : null);
