// Tests of sandbox.ts: what the bwrap arguments let the agent see.
import assert from 'node:assert/strict'
import { describe, it } from 'vitest'
import { bwrapArgs, HOME, MCP_CONFIG, WORK_BUG, WORK_WEBUI } from './sandbox.ts'

describe('bwrapArgs', () => {
  const args = bwrapArgs({
    webuiDir: '/srv/bv/state/webui',
    bugDir: '/tmp/run-1/bug',
    mcpConfig: '/tmp/run-1/mcp.json',
    toolchainDir: '/home/svc/.nvm/versions/node/v24.19.0',
  })
  const binds = (): [string, string][] => {
    const out: [string, string][] = []
    for (let i = 0; i < args.length; i++) if (args[i] === '--ro-bind' || args[i] === '--ro-bind-try') out.push([args[i + 1]!, args[i + 2]!])
    return out
  }

  it("binds the clone, the run's files, the MCP config, the toolchain and the system, all read-only", () => {
    assert.deepEqual(
      binds().filter(([from]) => from.startsWith('/srv') || from.startsWith('/tmp') || from.startsWith('/home')),
      [
        ['/home/svc/.nvm/versions/node/v24.19.0', '/home/svc/.nvm/versions/node/v24.19.0'],
        ['/srv/bv/state/webui', WORK_WEBUI],
        ['/tmp/run-1/bug', WORK_BUG],
        ['/tmp/run-1/mcp.json', MCP_CONFIG],
      ],
    )
    assert.ok(!args.includes('--bind'), 'nothing is writable but tmpfs')
    assert.ok(binds().some(([from]) => from === '/usr'))
    assert.ok(!binds().some(([from]) => from === '/home' || from === '/' || from === '/etc'), 'no home, no root, no whole /etc')
  })
  it('an empty home and tmp, no namespace but the network, dies with the service; the environment is not an argument', () => {
    for (const flag of ['--unshare-all', '--share-net', '--die-with-parent', '--new-session']) assert.ok(args.includes(flag), flag)
    assert.deepEqual(args.slice(args.indexOf('--tmpfs'), args.indexOf('--tmpfs') + 2), ['--tmpfs', HOME])
    assert.ok(
      !args.includes('--setenv') && !args.includes('--clearenv'),
      'the environment comes from the process, so no secret is on the command line',
    )
    assert.deepEqual(args.slice(-2), ['--chdir', WORK_WEBUI])
  })
  it('the MCP config is bound after the home it lives in, so the tmpfs does not hide it', () => {
    assert.ok(args.indexOf(MCP_CONFIG) > args.indexOf(HOME))
  })
})
