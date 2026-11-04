import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, it } from 'vitest'
import { Clone, CloneError } from './clone.ts'

const git = (dir: string, ...args: string[]): string =>
  execFileSync('git', ['-C', dir, ...args], {
    encoding: 'utf8',
    env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' },
  }).trim()

describe('Clone', () => {
  let work: string
  let origin: string
  let upstream: string
  beforeAll(() => {
    work = mkdtempSync(join(tmpdir(), 'bv-clone-'))
    upstream = join(work, 'upstream')
    execFileSync('git', ['init', '--quiet', '-b', 'master', upstream])
    writeFileSync(join(upstream, 'README.md'), 'one')
    git(upstream, 'add', '.')
    git(upstream, 'commit', '--quiet', '-m', 'one')
    origin = join(work, 'origin.git')
    execFileSync('git', ['clone', '--quiet', '--bare', upstream, origin])
  })
  afterAll(() => rmSync(work, { recursive: true, force: true }))

  it('clones when missing, fetches when stale, keeps the tree at master and tells the commit', async () => {
    const clone = new Clone(join(work, 'clone'), origin)
    const first = await clone.update(Infinity)
    assert.equal(first, git(upstream, 'rev-parse', 'HEAD'))
    assert.equal(git(clone.dir, 'show', 'HEAD:README.md'), 'one')

    writeFileSync(join(upstream, 'README.md'), 'two')
    git(upstream, 'commit', '--quiet', '-am', 'two')
    git(upstream, 'push', '--quiet', origin, 'master')
    writeFileSync(join(clone.dir, 'README.md'), 'a stray change')
    assert.equal(await clone.update(Infinity), first, 'fresh enough: not fetched')
    assert.equal(git(clone.dir, 'status', '--porcelain'), 'M README.md', 'and nothing written to the clone')
    const second = await clone.update(0)
    assert.equal(second, git(upstream, 'rev-parse', 'HEAD'))
    assert.equal(git(clone.dir, 'show', 'HEAD:README.md'), 'two')
    assert.equal(git(clone.dir, 'status', '--porcelain'), '', 'the stray change is gone')
  })
  it('a repository that cannot be reached is a CloneError', async () => {
    await assert.rejects(
      new Clone(join(work, 'nowhere'), join(work, 'missing.git')).update(0),
      (err: CloneError) => err.name === 'CloneError' && /git clone failed/.test(err.message),
    )
  })
})
