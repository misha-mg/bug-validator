// The settings a person may change from the console without a restart: when a new bug is first
// checked, how long a changed report must be quiet before its re-check, how many checks a bug
// gets, and whether Slack is told. The code and the environment give each its default; a value
// set in the console is kept in the database's `settings` table and wins over it, and one set
// back to the default is forgotten, so a later change of the default shows again. The service
// reads them at every poll: a change is for the next poll. The console writes them, as it writes
// requests and posts; the table is the service's own (migration 6), never made here.
import { existsSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { DEFAULT_TIMING, type Timing } from '../pipeline/plan.ts'

export interface CheckSettings extends Timing {
  /** Whether a check that ends not understood is told to Slack; nothing is sent without a webhook, whatever this says. */
  slack: boolean
}

/** What each number may be: a day at most for the waits, and a bug is checked at least once. */
export const LIMITS = {
  firstCheckMinutes: { min: 0, max: 24 * 60 },
  quietMinutes: { min: 0, max: 24 * 60 },
  maxChecks: { min: 1, max: 20 },
} as const

const NAMES = ['firstCheckMinutes', 'quietMinutes', 'maxChecks', 'slack'] as const

/** The defaults: the plan's own timing, and Slack as the environment says (VALIDATOR_SLACK_NOTIFICATIONS). */
export const settingsDefaults = (slack: boolean): CheckSettings => ({ ...DEFAULT_TIMING, slack })

/** True when the database has the table: the service that made it is one that reads the settings. */
function hasTable(db: DatabaseSync): boolean {
  return db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'settings'").get() !== undefined
}

/**
 * The settings in force: the default of each unless one was set. `kept` is false when there is
 * no database or it has no `settings` table yet (a service from before them): nothing can be set.
 */
export function readSettings(file: string, defaults: CheckSettings): { settings: CheckSettings; kept: boolean } {
  if (file === ':memory:' || !existsSync(file)) return { settings: defaults, kept: false }
  const db = new DatabaseSync(file, { readOnly: true, timeout: 5000 })
  try {
    if (!hasTable(db)) return { settings: defaults, kept: false }
    const set = new Map(
      (db.prepare('SELECT name, value FROM settings').all() as { name: string; value: string }[]).map((r) => [r.name, r.value]),
    )
    const number = (name: keyof typeof LIMITS): number => {
      const n = Number(set.get(name))
      return set.has(name) && Number.isInteger(n) && n >= LIMITS[name].min && n <= LIMITS[name].max ? n : defaults[name]
    }
    const slack = set.get('slack')
    return {
      settings: {
        firstCheckMinutes: number('firstCheckMinutes'),
        quietMinutes: number('quietMinutes'),
        maxChecks: number('maxChecks'),
        slack: slack === 'true' ? true : slack === 'false' ? false : defaults.slack,
      },
      kept: true,
    }
  } finally {
    db.close()
  }
}

/** Keeps what differs from the defaults and forgets what does not. The database must be the service's own, with the table. */
export function writeSettings(file: string, settings: CheckSettings, defaults: CheckSettings, at = new Date().toISOString()): void {
  if (!existsSync(file)) throw new Error(`No database at ${file}: the service has not started yet`)
  const db = new DatabaseSync(file, { timeout: 5000 })
  try {
    if (!hasTable(db)) throw new Error(`The database at ${file} has no settings table: is the service up to date?`)
    db.exec('BEGIN IMMEDIATE')
    for (const name of NAMES) {
      if (settings[name] === defaults[name]) db.prepare('DELETE FROM settings WHERE name = ?').run(name)
      else
        db.prepare(
          'INSERT INTO settings (name, value, set_at) VALUES (?, ?, ?) ON CONFLICT (name) DO UPDATE SET value = excluded.value, set_at = excluded.set_at',
        ).run(name, String(settings[name]), at)
    }
    db.exec('COMMIT')
  } finally {
    db.close()
  }
}

/**
 * The settings a posted form asks for: the three numbers, each whole and within its limits, and
 * the Slack switch, on only when the form carries it (an unchecked box is not sent). Throws with
 * what is wrong, for the page to say.
 */
export function parseSettings(form: URLSearchParams): CheckSettings {
  const number = (name: keyof typeof LIMITS, what: string): number => {
    const raw = (form.get(name) ?? '').trim()
    const n = Number(raw)
    const { min, max } = LIMITS[name]
    if (raw === '' || !Number.isInteger(n) || n < min || n > max) throw new Error(`${what} is a whole number from ${min} to ${max}`)
    return n
  }
  return {
    firstCheckMinutes: number('firstCheckMinutes', 'The wait before the first check, in minutes,'),
    quietMinutes: number('quietMinutes', 'The quiet before a re-check, in minutes,'),
    maxChecks: number('maxChecks', 'The checks per bug'),
    slack: form.get('slack') === 'on',
  }
}

/** What differs between two settings, by name, for the log. */
export function changedSettings(before: CheckSettings, after: CheckSettings): Partial<CheckSettings> {
  return Object.fromEntries(NAMES.filter((n) => before[n] !== after[n]).map((n) => [n, after[n]]))
}
