// The configuration: the defaults, what is required, what is refused, and the old names.
import assert from 'node:assert/strict'
import { describe, it } from 'vitest'
import { loadConfig } from './config.ts'
import { loadUiConfig } from './http/config.ts'

// A plain object, not process.env: `.env` is loaded only into the real environment.
const env = (vars: Record<string, string> = {}) => ({
  JIRA_BASE_URL: 'https://jira.example.com/',
  JIRA_EMAIL: 'a@b.com',
  JIRA_API_TOKEN: 't',
  CLAUDE_CODE_OAUTH_TOKEN: 'sk-ant-oat01-x',
  VALIDATOR_WEBUI_REPO_URL: 'git@example.com:org/webui.git',
  ...vars,
})

describe('config', () => {
  it('is a dry run unless VALIDATOR_DRY_RUN=false is set on purpose', () => {
    assert.equal(loadConfig(env()).dryRun, true)
    assert.equal(loadConfig(env({ VALIDATOR_DRY_RUN: 'false' })).dryRun, false)
    for (const value of ['False', '0', 'no', ''])
      assert.throws(() => loadConfig(env({ VALIDATOR_DRY_RUN: value })), /VALIDATOR_DRY_RUN/, value)
  })
  it('needs the Jira site and login, the token and the WebUI repository, and fails fast on a bad value', () => {
    assert.throws(() => loadConfig({}), /JIRA_BASE_URL.*JIRA_EMAIL.*JIRA_API_TOKEN.*CLAUDE_CODE_OAUTH_TOKEN.*VALIDATOR_WEBUI_REPO_URL/)
    assert.throws(() => loadConfig(env({ VALIDATOR_POLL_INTERVAL_SECONDS: '0' })), /VALIDATOR_POLL_INTERVAL_SECONDS/)
    assert.throws(() => loadConfig(env({ VALIDATOR_AGENT_MAX_BUDGET_USD: '-1' })), /VALIDATOR_AGENT_MAX_BUDGET_USD/)
    assert.throws(() => loadConfig(env({ CLAUDE_CODE_OAUTH_TOKEN: '' })), /CLAUDE_CODE_OAUTH_TOKEN/, 'the sandbox has no other login')
    assert.deepEqual(loadConfig(env()).agent, {
      model: 'sonnet',
      timeoutMs: 600_000,
      maxTurns: 100,
      maxBudgetUsd: 2,
      token: 'sk-ant-oat01-x',
    })
  })
  it('takes the Jira site without its trailing slash; the cloud id is read from the site unless given', () => {
    assert.deepEqual(loadConfig(env()).jira, { baseUrl: 'https://jira.example.com', cloudId: null, email: 'a@b.com', apiToken: 't' })
    assert.equal(loadConfig(env({ JIRA_CLOUD_ID: 'abc' })).jira.cloudId, 'abc')
    assert.equal(loadUiConfig(env()).jiraBaseUrl, 'https://jira.example.com')
  })
  it('the WebUI clone has a place and a source', () => {
    assert.deepEqual(loadConfig(env()).webui, { repoUrl: 'git@example.com:org/webui.git', dir: 'state/webui' })
    assert.equal(loadConfig(env({ VALIDATOR_WEBUI_DIR: '/srv/webui' })).webui.dir, '/srv/webui')
  })
  it('refuses a variable under its old name, so a deployment cannot fall back to a default unnoticed', () => {
    assert.throws(() => loadConfig(env({ DB_FILE: 'x.sqlite' })), /DB_FILE is now VALIDATOR_DB_FILE/)
    assert.throws(
      () => loadUiConfig(env({ UI_HOST: '0.0.0.0', DRY_RUN: 'true' })),
      /DRY_RUN is now VALIDATOR_DRY_RUN; UI_HOST is now VALIDATOR_HOST/,
    )
    assert.equal(
      loadConfig(env({ DB_FILE: 'x.sqlite', VALIDATOR_DB_FILE: 'y.sqlite' })).dbFile,
      'y.sqlite',
      'both set: the new one is read',
    )
  })
  it('the UI listens on this machine only unless told otherwise; a login is a user and a password', () => {
    const ui = loadUiConfig(env())
    assert.equal(ui.host, '127.0.0.1')
    assert.equal(ui.port, 8081)
    assert.equal(ui.guard.login, null)
    assert.deepEqual(loadUiConfig(env({ VALIDATOR_HOSTNAMES: ' Validator.lan , x ' })).guard.hostnames, ['validator.lan', 'x'])
    assert.throws(() => loadUiConfig(env({ VALIDATOR_USER: 'qa' })), /go together/)
    assert.deepEqual(loadUiConfig(env({ VALIDATOR_USER: 'qa', VALIDATOR_PASSWORD: 'p' })).guard.login, { user: 'qa', password: 'p' })
    assert.throws(() => loadUiConfig({}), /JIRA_BASE_URL/, 'the pages link to Jira')
  })
})
