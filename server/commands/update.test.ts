// Tests of update.ts on real git repositories (an origin and its clone), with systemctl and npm played by the test.
import { execFileSync, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest'
import { parseLogLine, setLogSink, type LogLine } from '../log.ts'
import { update, type Machine } from './update.ts'

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'update-'))
afterAll(() => fs.rmSync(root, { recursive: true, force: true }))

const git = (cwd: string, ...args: string[]): string =>
  execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.com', '-C', cwd, ...args], { encoding: 'utf8' }).trim()

let n = 0
let origin: string
let clone: string
let lines: LogLine[]
/** What the played systemctl and npm were asked, in order. */
let asked: string[]
/** Units that are running; a unit named in `broken` stops being so at a restart while the clone is at that commit. */
let active: Set<string>
let broken: { unit: string; at: string } | null
/** The check the service's log has in flight. */
let checking: { key: string; since: Date } | null

const commit = (repo: string, file: string, subject: string): string => {
  fs.mkdirSync(path.dirname(path.join(repo, file)), { recursive: true })
  fs.writeFileSync(path.join(repo, file), subject)
  git(repo, 'add', '-A')
  git(repo, 'commit', '-q', '-m', subject)
  return git(repo, 'rev-parse', 'HEAD')
}

const machine: Machine = {
  run: (file, args) => {
    if (file === 'git') {
      const r = spawnSync('git', args, { cwd: clone, encoding: 'utf8' })
      return { ok: r.status === 0, out: (r.status === 0 ? r.stdout : r.stderr).trim() }
    }
    asked.push([file, ...args.filter((a) => !a.startsWith('--'))].join(' '))
    if (file === 'systemctl' && args[1] === 'is-active') return { ok: active.has(args.at(-1)!), out: '' }
    if (file === 'systemctl' && args[1] === 'restart') {
      if (broken) {
        if (git(clone, 'rev-parse', 'HEAD') === broken.at) active.delete(broken.unit)
        else active.add(broken.unit)
      }
    }
    return { ok: true, out: '' }
  },
  sleep: async () => {},
  checking: () => checking,
}

const run = (): Promise<void> =>
  update(
    { VALIDATOR_DB_FILE: path.join(clone, 'state', 'db.sqlite'), VALIDATOR_LOG_FILE: path.join(clone, 'state', 'service.log') },
    machine,
  )
const events = (): string[] => lines.map((l) => l.event)
const restarts = (): string[] => asked.filter((a) => a.startsWith('systemctl restart'))

beforeEach(() => {
  const dir = path.join(root, String(n++))
  origin = path.join(dir, 'origin')
  clone = path.join(dir, 'clone')
  fs.mkdirSync(origin, { recursive: true })
  git(origin, 'init', '-q', '-b', 'main')
  commit(origin, 'package-lock.json', 'chore: the first lock')
  execFileSync('git', ['clone', '-q', origin, clone])
  lines = []
  asked = []
  active = new Set(['bug-validator', 'bug-validator-ui'])
  broken = null
  checking = null
  setLogSink((line) => lines.push(parseLogLine(line)!))
})
afterEach(() => setLogSink((line) => process.stdout.write(`${line}\n`)))

describe('update', () => {
  it('does and says nothing while origin has nothing new', async () => {
    await run()
    expect(lines).toEqual([])
    expect(asked).toEqual([])
  })

  it('moves to the new commit and restarts both units, without npm ci when the lock file is the same', async () => {
    const to = commit(origin, 'server/a.ts', 'feat: a thing')
    await run()
    expect(git(clone, 'rev-parse', 'HEAD')).toBe(to)
    expect(restarts()).toEqual(['systemctl restart bug-validator bug-validator-ui'])
    expect(asked.some((a) => a.startsWith('npm'))).toBe(false)
    expect(lines[0]).toMatchObject({
      event: 'update',
      to: to.slice(0, 12),
      dependencies: false,
      restarted: ['bug-validator', 'bug-validator-ui'],
    })
  })

  it('installs the dependencies when the lock file changed, before the restart', async () => {
    commit(origin, 'package-lock.json', 'chore: a new lock')
    await run()
    expect(asked.indexOf('npm ci')).toBeGreaterThanOrEqual(0)
    expect(asked.indexOf('npm ci')).toBeLessThan(asked.indexOf('systemctl restart bug-validator bug-validator-ui'))
    expect(lines[0]).toMatchObject({ event: 'update', dependencies: true })
  })

  it('leaves a unit the operator stopped as it is', async () => {
    active.delete('bug-validator')
    commit(origin, 'server/a.ts', 'feat: a thing')
    await run()
    expect(restarts()).toEqual(['systemctl restart bug-validator-ui'])
  })

  it('waits while the service checks a bug, but not for a check that never ended or a service that is stopped', async () => {
    const to = commit(origin, 'server/a.ts', 'feat: a thing')
    const from = git(clone, 'rev-parse', 'HEAD')
    checking = { key: 'KAZ-1', since: new Date(Date.now() - 60_000) }
    await run()
    expect(git(clone, 'rev-parse', 'HEAD')).toBe(from)
    expect(lines).toEqual([])

    active.delete('bug-validator')
    await run()
    expect(git(clone, 'rev-parse', 'HEAD')).toBe(to)

    active.add('bug-validator')
    checking = { key: 'KAZ-1', since: new Date(Date.now() - 31 * 60_000) }
    const next = commit(origin, 'server/a.ts', 'feat: another thing')
    await run()
    expect(git(clone, 'rev-parse', 'HEAD')).toBe(next)
  })

  it('reports a changed unit file and does not install it', async () => {
    commit(origin, 'deploy/bug-validator.service', 'chore: the unit')
    await run()
    expect(events()).toEqual(['update', 'update_units_changed'])
    expect(lines[1]).toMatchObject({ level: 'warn', files: ['deploy/bug-validator.service'] })
  })

  it('goes back when a unit does not come up, and does not try that commit again', async () => {
    const from = git(clone, 'rev-parse', 'HEAD')
    const to = commit(origin, 'server/a.ts', 'feat: a thing that breaks the start')
    broken = { unit: 'bug-validator', at: to }
    await expect(run()).rejects.toThrow(/was undone: bug-validator did not come up/)
    expect(git(clone, 'rev-parse', 'HEAD')).toBe(from)
    expect(active.has('bug-validator')).toBe(true)
    expect(restarts()).toHaveLength(2)
    expect(lines[0]).toMatchObject({ event: 'update_undone', level: 'error', failed: ['bug-validator'], afterGoingBack: [] })

    asked = []
    lines = []
    await run()
    expect(asked).toEqual([])
    expect(lines).toEqual([])

    const fixed = commit(origin, 'server/a.ts', 'fix: the start')
    await run()
    expect(git(clone, 'rev-parse', 'HEAD')).toBe(fixed)
    expect(events()).toEqual(['update'])
  })

  it.each([
    ['another branch is checked out', () => git(clone, 'switch', '-q', '-c', 'work'), /is on work, not main/],
    ['a tracked file is changed', () => fs.writeFileSync(path.join(clone, 'package-lock.json'), 'edited'), /tracked files are changed/],
    ['the checkout has its own commit', () => commit(clone, 'local.ts', 'feat: only here'), /has commits origin\/main does not/],
  ])('does nothing when %s', async (_name, prepare, reason) => {
    prepare()
    const before = git(clone, 'rev-parse', 'HEAD')
    commit(origin, 'server/a.ts', 'feat: a thing')
    await run()
    expect(git(clone, 'rev-parse', 'HEAD')).toBe(before)
    expect(restarts()).toEqual([])
    expect(lines).toHaveLength(1)
    expect(lines[0]).toMatchObject({ event: 'update_skipped', level: 'warn' })
    expect(String(lines[0]!['reason'])).toMatch(reason)
  })

  it('fails when origin cannot be fetched', async () => {
    fs.rmSync(origin, { recursive: true })
    await expect(run()).rejects.toThrow(/git fetch failed/)
  })
})
