// The service's clone of WebUI: cloned when missing, fetched to master, checked out detached; its commit.
import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { promisify } from 'node:util'
import { log } from '../log.ts'

const git = promisify(execFile)
/** A clone of the WebUI repository is about a gigabyte; a fetch is seconds. */
const GIT_TIMEOUT_MS = 20 * 60_000

/** The clone could not be made or brought to master: a failure of the surroundings, not of a bug. */
export class CloneError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'CloneError'
  }
}

/**
 * The service's own clone of WebUI, read by the agent: never a developer's working tree. Checked
 * out detached at `origin/master`; nothing else is ever checked out, and no one commits here.
 */
export class Clone {
  readonly dir: string
  private readonly url: string
  private fetchedAt = 0
  /** HEAD as last read; null before the first update. */
  private commit: string | null = null

  constructor(dir: string, url: string) {
    this.dir = dir
    this.url = url
  }

  /**
   * The clone at master, as of a fetch no older than `maxAgeMs` (0: fetch now; Infinity: as it
   * is), made when missing. Returns the commit. Only a fetch is followed by a checkout, forced,
   * so a stray change cannot stop it; without one the clone is only read, so two `check`s at
   * once do not trip over each other's git lock.
   */
  async update(maxAgeMs: number): Promise<string> {
    let fetched = false
    if (!existsSync(this.dir)) {
      await this.run(['clone', '--quiet', '--no-checkout', '--branch', 'master', '--single-branch', this.url, this.dir], 'clone')
      fetched = true
    } else if (Date.now() - this.fetchedAt > maxAgeMs) {
      await this.run(['-C', this.dir, 'fetch', '--quiet', 'origin', 'master'], 'fetch')
      fetched = true
    }
    if (fetched) {
      this.fetchedAt = Date.now()
      const before = this.commit === null ? null : await this.head()
      await this.run(['-C', this.dir, 'checkout', '--quiet', '--force', '--detach', 'origin/master'], 'checkout')
      const after = await this.head()
      if (before !== null && before !== after) log.info('webui_fetched', { from: before.slice(0, 12), to: after.slice(0, 12) })
      this.commit = after
    }
    return this.commit ?? (this.commit = await this.head())
  }

  private async head(): Promise<string> {
    return (await this.run(['-C', this.dir, 'rev-parse', 'HEAD'], 'rev-parse')).trim()
  }

  private async run(args: string[], what: string): Promise<string> {
    try {
      return (await git('git', args, { timeout: GIT_TIMEOUT_MS, maxBuffer: 1 << 20 })).stdout
    } catch (err) {
      const e = err as NodeJS.ErrnoException & { stderr?: string }
      throw new CloneError(`git ${what} failed: ${(e.stderr?.trim() || e.message).slice(0, 300)}`)
    }
  }
}
