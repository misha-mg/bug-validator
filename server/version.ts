// What code is running, for the console's footer and the log: the version counted from the
// repository's commits (scripts/version.sh: a `feat` bumps the minor, a breaking commit the
// major, any other the patch), the commit, whether the working tree differs from it, and the
// commit's page where origin is a host that has one. Read once, when the process starts: a
// service runs the code it was started with, whatever is committed later. Nothing here fails a
// start: without git, or in a shallow clone, the version is 0.0.0 and no commit is named. The
// same file in pipeline-ui and bug-validator.
import { execFileSync } from 'node:child_process'
import path from 'node:path'

export type Build = {
  version: string
  /** The short hash of HEAD; null when git cannot say. */
  commit: string | null
  /** Tracked files differ from the commit: what runs is not exactly it. */
  dirty: boolean
  /** The commit's page on origin; null when origin is not GitHub or Bitbucket, or there is none. */
  commitUrl: string | null
}

export function readBuild(repo: string): Build {
  const run = (file: string, args: string[]): string | null => {
    try {
      return execFileSync(file, args, { cwd: repo, encoding: 'utf8', timeout: 10_000, stdio: ['ignore', 'pipe', 'ignore'] }).trim()
    } catch {
      return null
    }
  }
  const version = run('sh', [path.join(repo, 'scripts', 'version.sh')])
  const commit = run('git', ['rev-parse', '--short', 'HEAD']) || null
  const full = run('git', ['rev-parse', 'HEAD'])
  const status = run('git', ['status', '--porcelain', '--untracked-files=no'])
  const origin = run('git', ['remote', 'get-url', 'origin'])
  return {
    version: version && /^\d+\.\d+\.\d+$/.test(version) ? version : '0.0.0',
    commit,
    dirty: status !== null && status !== '',
    commitUrl: full && origin ? commitPage(origin, full) : null,
  }
}

/**
 * A commit's page from the remote's address, `https://host/owner/repo(.git)` or
 * `git@host:owner/repo(.git)`. Whatever login the address carries is left out: the result goes
 * to the browser.
 */
export function commitPage(origin: string, commit: string): string | null {
  const m = /^(?:https?:\/\/(?:[^@/]*@)?|ssh:\/\/(?:[^@/]*@)?|[^@/]+@)([^/:]+)[:/](?:\d+\/)?([^/]+)\/([^/]+?)(?:\.git)?\/?$/.exec(
    origin.trim(),
  )
  if (!m) return null
  const [, host, owner, name] = m
  if (host === 'github.com') return `https://github.com/${owner}/${name}/commit/${commit}`
  if (host === 'bitbucket.org') return `https://bitbucket.org/${owner}/${name}/commits/${commit}`
  return null
}

/** `v1.4.2 (abc1234)`, with `+` after a commit the working tree has moved on from; `v0.0.0 (dev)` when no commit is known. */
export function buildText(build: Build): string {
  return `v${build.version} (${build.commit ? `${build.commit}${build.dirty ? '+' : ''}` : 'dev'})`
}
