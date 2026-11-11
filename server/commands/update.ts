// `update`: bring this checkout to the branch's head on origin and restart the units, from a systemd timer.
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { z } from 'zod'
import { Env, parseEnv } from '../config.ts'
import { ServiceLog } from '../http/service-log.ts'
import { log } from '../log.ts'

const UpdateEnv = Env.pick({ VALIDATOR_DB_FILE: true, VALIDATOR_LOG_FILE: true }).extend({
  VALIDATOR_UPDATE_BRANCH: z.string().min(1).default('main'),
})

/** The units an update restarts, when they run: the service and the console. */
const UNITS = ['bug-validator', 'bug-validator-ui']
/** After a restart a unit is looked at this many times, this far apart: a start that fails shows between systemd's tries. */
const LOOKS = 6
const LOOK_EVERY_MS = 5_000
/** A check the log has had in flight for longer than this is one whose end was never logged: it holds nothing up. */
const CHECK_MAX_MS = 30 * 60_000
/** `npm ci` on a slow disk; a fetch is seconds. */
const COMMAND_TIMEOUT_MS = 10 * 60_000

export type Ran = { ok: boolean; out: string }
/** What `update` needs of the machine; the tests give their own. */
export type Machine = {
  /** A command run in the checkout: whether it exited 0, and its trimmed stdout (stderr on a failure). */
  run: (file: string, args: string[]) => Ran
  sleep: (ms: number) => Promise<void>
  /** The bug the service's log says is being checked now, and since when; null when none is. */
  checking: (logFile: string) => { key: string; since: Date } | null
}

const machine: Machine = {
  run: (file, args) => {
    // A fetch that needs a password must fail, not wait for a person the timer does not have.
    const r = spawnSync(file, args, { encoding: 'utf8', timeout: COMMAND_TIMEOUT_MS, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } })
    const ok = r.status === 0
    return { ok, out: (ok ? r.stdout : r.stderr || r.error?.message || r.stdout || '').trim() }
  },
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  checking: (logFile) => new ServiceLog(logFile).read()?.checking ?? null,
}

/**
 * `update`: when origin's branch has moved on, fast-forward the checkout to it, install the
 * dependencies if the lock file changed, restart the units that were running and watch them
 * come up; a unit that does not, and the checkout goes back to the commit it was at, the units
 * are restarted again, and that commit is remembered (`update-failed`, beside the database) so
 * the timer does not try it every few minutes: the next commit pushed is tried as usual.
 *
 * A restart kills the agent run in progress, which costs that run, so while the service is
 * checking a bug the update waits for the timer's next turn.
 *
 * It never touches a checkout a person is working in: another branch checked out, tracked files
 * changed, or commits origin does not have are each a reason to do nothing and say so. The unit
 * files are machine-specific (deploy/), so a change to them is only reported.
 *
 * Says nothing when there is nothing new; throws when the update was undone or could not be made.
 */
export async function update(env: NodeJS.ProcessEnv = process.env, m: Machine = machine): Promise<void> {
  const e = parseEnv(UpdateEnv, env)
  const branch = e.VALIDATOR_UPDATE_BRANCH
  const remote = `origin/${branch}`
  const failedFile = join(dirname(e.VALIDATOR_DB_FILE), 'update-failed')
  const git = (...args: string[]): string => {
    const r = m.run('git', args)
    if (!r.ok) throw new Error(`git ${args[0]} failed: ${r.out}`)
    return r.out
  }

  git('fetch', '--quiet', 'origin', branch)
  const from = git('rev-parse', 'HEAD')
  const to = git('rev-parse', remote)
  if (from === to) return
  if (existsSync(failedFile) && readFileSync(failedFile, 'utf8').trim() === to) return

  const skip = (reason: string): void => log.warn('update_skipped', { from: from.slice(0, 12), to: to.slice(0, 12), reason })
  const current = m.run('git', ['symbolic-ref', '--quiet', '--short', 'HEAD'])
  if (!current.ok || current.out !== branch) return skip(`the checkout is on ${current.ok ? current.out : 'no branch'}, not ${branch}`)
  if (git('status', '--porcelain', '--untracked-files=no') !== '') return skip('tracked files are changed')
  if (!m.run('git', ['merge-base', '--is-ancestor', from, to]).ok) return skip(`the checkout has commits ${remote} does not`)

  const changed = git('diff', '--name-only', from, to).split('\n')
  const lockChanged = changed.includes('package-lock.json')
  const units = UNITS.filter((unit) => m.run('systemctl', ['--user', 'is-active', '--quiet', unit]).ok)
  // Only the service's restart ends a check; with the service stopped there is none to wait for.
  const checking = units.includes('bug-validator') ? m.checking(e.VALIDATOR_LOG_FILE) : null
  if (checking && Date.now() - checking.since.getTime() < CHECK_MAX_MS) return

  /** The checkout at `commit` with its dependencies, the running units restarted; the units that did not come up. */
  const bring = async (commit: string, how: string[]): Promise<string[]> => {
    git(...how, commit)
    if (lockChanged) {
      const ci = m.run('npm', ['ci', '--no-audit', '--no-fund'])
      if (!ci.ok) return [`npm ci: ${ci.out.split('\n').at(-1)}`]
    }
    if (units.length === 0) return []
    const restart = m.run('systemctl', ['--user', 'restart', ...units])
    if (!restart.ok) return [`systemctl restart: ${restart.out}`]
    const down = new Set<string>()
    for (let look = 0; look < LOOKS; look++) {
      await m.sleep(LOOK_EVERY_MS)
      for (const unit of units) if (!m.run('systemctl', ['--user', 'is-active', '--quiet', unit]).ok) down.add(unit)
    }
    return [...down]
  }

  const down = await bring(to, ['merge', '--quiet', '--ff-only'])
  if (down.length === 0) {
    rmSync(failedFile, { force: true })
    log.info('update', { from: from.slice(0, 12), to: to.slice(0, 12), dependencies: lockChanged, restarted: units })
    const unitFiles = changed.filter((f) => f.startsWith('deploy/'))
    // Each machine edits its copies (the paths), so they are not overwritten from here.
    if (unitFiles.length > 0)
      log.warn('update_units_changed', { files: unitFiles, todo: 'compare with ~/.config/systemd/user and install by hand' })
    return
  }

  // The tree was clean and is an ancestor's, so going back loses nothing.
  const stillDown = await bring(from, ['reset', '--quiet', '--hard'])
  mkdirSync(dirname(failedFile), { recursive: true })
  writeFileSync(failedFile, `${to}\n`)
  log.error('update_undone', { from: from.slice(0, 12), to: to.slice(0, 12), failed: down, afterGoingBack: stillDown })
  throw new Error(`The update to ${to.slice(0, 12)} was undone: ${down.join(', ')} did not come up`)
}
