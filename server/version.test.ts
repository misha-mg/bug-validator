// Tests of version.ts: the version counted from the commits, the commit and its page, and what is said without git.
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { buildText, commitPage, readBuild } from './version.ts'

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'version-'))
afterAll(() => fs.rmSync(dir, { recursive: true, force: true }))
const git = (cwd: string, ...args: string[]) =>
  execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.com', '-C', cwd, ...args], { encoding: 'utf8' })

describe('readBuild', () => {
  it('counts the version from the commits and names the commit, its page and a tree that moved on', () => {
    const repo = path.join(dir, 'repo')
    fs.mkdirSync(path.join(repo, 'scripts'), { recursive: true })
    fs.copyFileSync(path.join(import.meta.dirname, '..', 'scripts', 'version.sh'), path.join(repo, 'scripts', 'version.sh'))
    git(repo, 'init', '-q')
    git(repo, 'remote', 'add', 'origin', 'https://someone:secret@github.com/owner/tool.git')
    for (const subject of ['feat: the first thing', 'fix: a slip', 'feat(ui): another', 'docs: words', 'chore: tidy']) {
      fs.writeFileSync(path.join(repo, 'file'), subject)
      git(repo, 'add', '-A')
      git(repo, 'commit', '-q', '-m', subject)
    }
    const build = readBuild(repo)
    const head = git(repo, 'rev-parse', 'HEAD').trim()
    expect(build).toEqual({
      version: '0.2.2',
      commit: git(repo, 'rev-parse', '--short', 'HEAD').trim(),
      dirty: false,
      commitUrl: `https://github.com/owner/tool/commit/${head}`,
    })
    expect(buildText(build)).toBe(`v0.2.2 (${build.commit})`)
    fs.writeFileSync(path.join(repo, 'file'), 'broken')
    git(repo, 'commit', '-q', '-am', 'feat!: a break')
    expect(readBuild(repo).version).toBe('1.0.0')
    fs.writeFileSync(path.join(repo, 'file'), 'edited')
    expect(buildText(readBuild(repo))).toMatch(/^v1\.0\.0 \([0-9a-f]+\+\)$/)
  })

  it('says 0.0.0 and no commit where there is no repository, and fails nothing', () => {
    const bare = path.join(dir, 'none')
    fs.mkdirSync(bare)
    const build = readBuild(bare)
    expect(build).toMatchObject({ version: '0.0.0', commitUrl: null })
    expect(buildText({ version: '0.0.0', commit: null, dirty: false, commitUrl: null })).toBe('v0.0.0 (dev)')
  })
})

describe('commitPage', () => {
  it('reads the host, the owner and the name from every form of address, and leaves a login out', () => {
    expect(commitPage('https://github.com/owner/tool.git', 'abc')).toBe('https://github.com/owner/tool/commit/abc')
    expect(commitPage('https://token@github.com/owner/tool', 'abc')).toBe('https://github.com/owner/tool/commit/abc')
    expect(commitPage('git@github.com:owner/tool.git', 'abc')).toBe('https://github.com/owner/tool/commit/abc')
    expect(commitPage('git@bitbucket.org:team/tool.git', 'abc')).toBe('https://bitbucket.org/team/tool/commits/abc')
    expect(commitPage('ssh://git@bitbucket.org/team/tool.git', 'abc')).toBe('https://bitbucket.org/team/tool/commits/abc')
    expect(commitPage('https://git.example.net/owner/tool.git', 'abc')).toBeNull()
    expect(commitPage('/srv/git/tool.git', 'abc')).toBeNull()
  })
})
