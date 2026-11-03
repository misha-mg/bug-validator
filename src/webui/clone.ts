import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { promisify } from 'node:util';

const git = promisify(execFile);
/** A clone of the WebUI repository is about a gigabyte; a fetch is seconds. */
const GIT_TIMEOUT_MS = 20 * 60_000;

/** The clone could not be made or brought to master: a failure of the surroundings, not of a bug. */
export class CloneError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CloneError';
  }
}

/**
 * The service's own clone of WebUI, read by the agent: never a developer's working tree. Checked
 * out detached at `origin/master`; nothing else is ever checked out, and no one commits here.
 */
export class Clone {
  readonly dir: string;
  private readonly url: string;
  private fetchedAt = 0;

  constructor(dir: string, url: string) {
    this.dir = dir;
    this.url = url;
  }

  /**
   * The clone at master, as of a fetch no older than `maxAgeMs` (0: fetch now; Infinity: as it
   * is), made when missing. Returns the commit. The working tree is forced to the commit, so a
   * stray change cannot stop a checkout.
   */
  async update(maxAgeMs: number): Promise<string> {
    if (!existsSync(this.dir)) {
      await this.run(['clone', '--quiet', '--no-checkout', '--branch', 'master', '--single-branch', this.url, this.dir], 'clone');
      this.fetchedAt = Date.now();
    } else if (Date.now() - this.fetchedAt > maxAgeMs) {
      await this.run(['-C', this.dir, 'fetch', '--quiet', 'origin', 'master'], 'fetch');
      this.fetchedAt = Date.now();
    }
    await this.run(['-C', this.dir, 'checkout', '--quiet', '--force', '--detach', 'origin/master'], 'checkout');
    return (await this.run(['-C', this.dir, 'rev-parse', 'HEAD'], 'rev-parse')).trim();
  }

  private async run(args: string[], what: string): Promise<string> {
    try {
      return (await git('git', args, { timeout: GIT_TIMEOUT_MS, maxBuffer: 1 << 20 })).stdout;
    } catch (err) {
      const e = err as NodeJS.ErrnoException & { stderr?: string };
      throw new CloneError(`git ${what} failed: ${(e.stderr?.trim() || e.message).slice(0, 300)}`);
    }
  }
}
