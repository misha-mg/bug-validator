import { loadConfig } from '../config.ts'
import { requestCheck } from '../store/store.ts'

/**
 * `request <KEY|URL>`: the running service checks the bug next, and records (or posts) the result
 * as for any check. The way to re-run a failed or skipped bug, or to check one before its time.
 */
export function request(text: string): void {
  const key = requestCheck(loadConfig().dbFile, text)
  process.stdout.write(`${key}: check requested; the service runs it next (see the UI or the log)\n`)
}
