// Dates, clocks, durations and spans as both consoles (pipeline-ui and bug-validator) write
// them, so a person walking between the two reads the same words. This file is the same in both
// repositories. No Node imports: a browser bundle loads it too.

export type When = string | number | Date | null | undefined

export const DASH = '—'

const asDate = (when: When): Date | null => {
  if (when === null || when === undefined || when === '') return null
  const d = when instanceof Date ? when : new Date(when)
  return Number.isNaN(d.getTime()) ? null : d
}
const p = (n: number): string => String(n).padStart(2, '0')

/** `2026-11-04`, local time. */
export function fmtDate(when: When): string {
  const d = asDate(when)
  return d ? `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}` : DASH
}

/** `23:10`, local time. */
export function fmtClock(when: When): string {
  const d = asDate(when)
  return d ? `${p(d.getHours())}:${p(d.getMinutes())}` : DASH
}

/** `2026-11-04 23:10`, local time. */
export function fmtTime(when: When): string {
  const d = asDate(when)
  return d ? `${fmtDate(d)} ${fmtClock(d)}` : DASH
}

/** `Tue 04 Nov`: a day as a heading over its rows. */
export function fmtDay(when: When): string {
  const d = asDate(when)
  return d ? d.toLocaleDateString('en-GB', { weekday: 'short', day: '2-digit', month: 'short' }).replace(',', '') : DASH
}

/** `1h 05m`, `5m 03s`, `3s`; a day or more as `2d 04h`. */
export function fmtDuration(seconds: number | null | undefined): string {
  if (seconds === null || seconds === undefined || !Number.isFinite(seconds)) return DASH
  const s = Math.max(0, Math.round(seconds))
  const d = Math.floor(s / 86400)
  const h = Math.floor((s % 86400) / 3600)
  const m = Math.floor((s % 3600) / 60)
  if (d) return `${d}d ${p(h)}h`
  if (h) return `${h}h ${p(m)}m`
  if (m) return `${m}m ${p(s % 60)}s`
  return `${s}s`
}

/** `just now`, `5m 03s ago`, `2h 05m ago`, `3d 04h ago`. */
export function fmtAgo(then: When, now: When = new Date()): string {
  const t = asDate(then)
  const n = asDate(now)
  if (!t || !n) return DASH
  const seconds = Math.max(0, Math.round((n.getTime() - t.getTime()) / 1000))
  return seconds < 60 ? 'just now' : `${fmtDuration(seconds)} ago`
}

/** `1 bug`, `3 bugs`. */
export function plural(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`
}

/** `85% (11)`: the share of `total` that `count` is, and how many it is; a dash without a total. */
export function fmtShare(count: number, total: number): string {
  return total ? `${Math.round((count * 100) / total)}% (${count})` : DASH
}

/** One line of at most `width` characters, whitespace folded, cut with an ellipsis. */
export function cut(text: string, width: number): string {
  const line = text.split(/\s+/).join(' ').trim()
  return line.length <= width ? line : `${line.slice(0, width - 1)}…`
}
