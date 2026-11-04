// The service's log: one JSON line per event on stdout (`ts`, `level`, `event`, then the
// event's fields), as both services (pipeline-ui and bug-validator) write it. A console reads
// the lines back for its activity feed and the service's state. This file is the same in both
// repositories.

export type Level = 'info' | 'warn' | 'error'
export type Fields = Record<string, unknown>

export type LogLine = { ts: string; level: Level; event: string } & Fields

let sink: (line: string) => void = (line) => process.stdout.write(`${line}\n`)

/** Where the lines go; tests swap it for a collector. */
export function setLogSink(write: (line: string) => void): void {
  sink = write
}

function write(level: Level, event: string, fields: Fields = {}): void {
  sink(JSON.stringify({ ts: new Date().toISOString(), level, event, ...fields }))
}

export const log = {
  info: (event: string, fields?: Fields): void => write('info', event, fields),
  warn: (event: string, fields?: Fields): void => write('warn', event, fields),
  error: (event: string, fields?: Fields): void => write('error', event, fields),
}

/** An error on one line: its name, its message and its cause's message when it has one. */
export function describeError(err: unknown): string {
  if (!(err instanceof Error)) return String(err)
  const cause = err.cause instanceof Error ? ` (cause: ${err.cause.message})` : ''
  return `${err.name}: ${err.message}${cause}`
}

/** A line of the log read back; null for a line that is not one. */
export function parseLogLine(line: string): LogLine | null {
  try {
    const parsed: unknown = JSON.parse(line)
    if (typeof parsed !== 'object' || parsed === null) return null
    const { ts, level, event } = parsed as Record<string, unknown>
    if (typeof ts !== 'string' || typeof event !== 'string' || (level !== 'info' && level !== 'warn' && level !== 'error')) return null
    return parsed as LogLine
  } catch {
    return null
  }
}
