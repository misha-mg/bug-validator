import assert from 'node:assert/strict'
import { describe, it } from 'vitest'
import { loadConfig } from '../src/config.ts'
import { loadUiConfig } from '../src/ui/config.ts'

// A plain object, not process.env: `.env` is loaded only into the real environment.
const env = (vars: Record<string, string> = {}) => ({
  JIRA_EMAIL: 'a@b.com',
  JIRA_API_TOKEN: 't',
  CLAUDE_CODE_OAUTH_TOKEN: 'sk-ant-oat01-x',
  ...vars,
})

describe('config', () => {
  it('is a dry run unless DRY_RUN=false is set on purpose', () => {
    assert.equal(loadConfig(env()).dryRun, true)
    assert.equal(loadConfig(env({ DRY_RUN: 'false' })).dryRun, false)
    for (const value of ['False', '0', 'no', '']) assert.throws(() => loadConfig(env({ DRY_RUN: value })), /DRY_RUN/, value)
  })
  it('needs the Jira login and fails fast on a bad value', () => {
    assert.throws(() => loadConfig({}), /JIRA_EMAIL/)
    assert.throws(() => loadConfig(env({ POLL_INTERVAL_SECONDS: '0' })), /POLL_INTERVAL_SECONDS/)
    assert.throws(() => loadConfig(env({ AGENT_MAX_BUDGET_USD: '-1' })), /AGENT_MAX_BUDGET_USD/)
    assert.throws(() => loadConfig(env({ CLAUDE_CODE_OAUTH_TOKEN: '' })), /CLAUDE_CODE_OAUTH_TOKEN/, 'the sandbox has no other login')
    assert.deepEqual(loadConfig(env()).agent, {
      model: 'sonnet',
      timeoutMs: 600_000,
      maxTurns: 100,
      maxBudgetUsd: 2,
      token: 'sk-ant-oat01-x',
    })
  })
  it('the WebUI clone has a place and a source', () => {
    assert.deepEqual(loadConfig(env()).webui, { repoUrl: 'git@bitbucket.org:CGS/webui.git', dir: 'state/webui' })
    assert.equal(loadConfig(env({ WEBUI_DIR: '/srv/webui' })).webui.dir, '/srv/webui')
  })
  it('the UI listens on this machine only unless told otherwise; a login is a user and a password', () => {
    const ui = loadUiConfig({})
    assert.equal(ui.host, '127.0.0.1')
    assert.equal(ui.login, null)
    assert.deepEqual(loadUiConfig({ UI_HOSTNAMES: ' Validator.lan , x ' }).hostnames, ['validator.lan', 'x'])
    assert.throws(() => loadUiConfig({ UI_USER: 'qa' }), /go together/)
    assert.deepEqual(loadUiConfig({ UI_USER: 'qa', UI_PASSWORD: 'p' }).login, { user: 'qa', password: 'p' })
  })
})
