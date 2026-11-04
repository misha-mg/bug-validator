// `maintain`: a backup of the database and the log cut down to size, daily from a systemd timer.
import { copyFileSync, existsSync, mkdirSync, readdirSync, rmSync, statSync, truncateSync } from 'node:fs'
import { basename, join } from 'node:path'
import { z } from 'zod'
import { Env, parseEnv } from '../config.ts'
import { Store } from '../store/store.ts'
import { log } from '../log.ts'

const MaintainEnv = Env.pick({ VALIDATOR_DB_FILE: true, VALIDATOR_LOG_FILE: true }).extend({
  VALIDATOR_BACKUP_DIR: z.string().min(1).default('state/backups'),
})

/** Daily backups kept: two weeks to notice that something went wrong. */
const KEEP = 14
/** The log is cut past this size, about three months of it; the cut part is kept as `<log>.1`. */
const LOG_MAX_BYTES = 5 * 1024 * 1024

/**
 * `maintain`: a consistent copy of the database into VALIDATOR_BACKUP_DIR, the oldest beyond KEEP removed,
 * and the service's log cut down when it is too big. Safe while the service runs; a systemd timer
 * runs it daily (deploy/). The log is copied, then emptied in place: the unit appends to the same
 * file and never notices. A line appended between the copy and the cut would be in neither
 * file, so the cut is made only when the file is still the size that was copied; otherwise the
 * next day's run tries again.
 */
export function maintain(): void {
  const e = parseEnv(MaintainEnv, process.env)
  if (!existsSync(e.VALIDATOR_DB_FILE)) throw new Error(`No database at ${e.VALIDATOR_DB_FILE}`)
  mkdirSync(e.VALIDATOR_BACKUP_DIR, { recursive: true })
  const stamp = new Date().toISOString().slice(0, 19).replace(/[-:]/g, '').replace('T', '-')
  const name = basename(e.VALIDATOR_DB_FILE, '.sqlite')
  const backup = join(e.VALIDATOR_BACKUP_DIR, `${name}-${stamp}.sqlite`)
  Store.backup(e.VALIDATOR_DB_FILE, backup)
  const old = readdirSync(e.VALIDATOR_BACKUP_DIR)
    .filter((f) => f.startsWith(`${name}-`) && f.endsWith('.sqlite'))
    .sort()
    .slice(0, -KEEP)
  for (const f of old) rmSync(join(e.VALIDATOR_BACKUP_DIR, f))
  log.info('backup', { file: backup, bytes: statSync(backup).size, removed: old.length })

  if (existsSync(e.VALIDATOR_LOG_FILE) && statSync(e.VALIDATOR_LOG_FILE).size > LOG_MAX_BYTES) {
    const bytes = statSync(e.VALIDATOR_LOG_FILE).size
    copyFileSync(e.VALIDATOR_LOG_FILE, `${e.VALIDATOR_LOG_FILE}.1`)
    if (statSync(e.VALIDATOR_LOG_FILE).size !== bytes) {
      log.warn('log_cut_skipped', { file: e.VALIDATOR_LOG_FILE, bytes, reason: 'the service wrote to it meanwhile' })
      return
    }
    truncateSync(e.VALIDATOR_LOG_FILE, 0)
    log.info('log_cut', { file: e.VALIDATOR_LOG_FILE, bytes, keptAs: `${e.VALIDATOR_LOG_FILE}.1` })
  }
}
