import { copyFileSync, existsSync, mkdirSync, readdirSync, rmSync, statSync, truncateSync } from 'node:fs';
import { basename, join } from 'node:path';
import { z } from 'zod';
import { Env, parseEnv } from '../config.ts';
import { Store } from '../db/store.ts';
import { log } from '../log.ts';

const MaintainEnv = Env.pick({ DB_FILE: true, LOG_FILE: true }).extend({
  BACKUP_DIR: z.string().min(1).default('state/backups'),
});

/** Daily backups kept: two weeks to notice that something went wrong. */
const KEEP = 14;
/** The log is cut past this size, about three months of it; the cut part is kept as `<log>.1`. */
const LOG_MAX_BYTES = 5 * 1024 * 1024;

/**
 * `maintain`: a consistent copy of the database into BACKUP_DIR, the oldest beyond KEEP removed,
 * and the service's log cut down when it is too big. Safe while the service runs; a systemd timer
 * runs it daily (deploy/). The log is copied, then emptied in place: the unit appends to the same
 * file and never notices.
 */
export function maintain(): void {
  const e = parseEnv(MaintainEnv, process.env);
  if (!existsSync(e.DB_FILE)) throw new Error(`No database at ${e.DB_FILE}`);
  mkdirSync(e.BACKUP_DIR, { recursive: true });
  const stamp = new Date().toISOString().slice(0, 19).replace(/[-:]/g, '').replace('T', '-');
  const name = basename(e.DB_FILE, '.sqlite');
  const backup = join(e.BACKUP_DIR, `${name}-${stamp}.sqlite`);
  Store.backup(e.DB_FILE, backup);
  const old = readdirSync(e.BACKUP_DIR).filter((f) => f.startsWith(`${name}-`) && f.endsWith('.sqlite')).sort().slice(0, -KEEP);
  for (const f of old) rmSync(join(e.BACKUP_DIR, f));
  log.info('backup', { file: backup, bytes: statSync(backup).size, removed: old.length });

  if (existsSync(e.LOG_FILE) && statSync(e.LOG_FILE).size > LOG_MAX_BYTES) {
    const bytes = statSync(e.LOG_FILE).size;
    copyFileSync(e.LOG_FILE, `${e.LOG_FILE}.1`);
    truncateSync(e.LOG_FILE, 0);
    log.info('log_cut', { file: e.LOG_FILE, bytes, keptAs: `${e.LOG_FILE}.1` });
  }
}
