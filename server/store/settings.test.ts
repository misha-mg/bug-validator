// Tests of settings.ts: the defaults until one is set, what is kept and forgotten, what a form may ask for.
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterAll, describe, it } from 'vitest'
import { changedSettings, parseSettings, readSettings, settingsDefaults, writeSettings } from './settings.ts'
import { Store } from './store.ts'

const dir = mkdtempSync(join(tmpdir(), 'bug-validator-settings-'))
afterAll(() => rmSync(dir, { recursive: true, force: true }))
const defaults = settingsDefaults(true)
const form = (fields: Record<string, string>) => new URLSearchParams(fields)

describe('settings', () => {
  it("are the plan's own and the environment's Slack switch until one is set", () => {
    assert.deepEqual(defaults, { firstCheckMinutes: 30, quietMinutes: 15, maxChecks: 5, slack: true })
    assert.equal(settingsDefaults(false).slack, false)
  })
  it('keeps what differs from the defaults and forgets what is put back', () => {
    const file = join(dir, 'kept.sqlite')
    new Store(file)
    assert.deepEqual(readSettings(file, defaults), { settings: defaults, kept: true })
    writeSettings(file, { firstCheckMinutes: 10, quietMinutes: 15, maxChecks: 3, slack: false }, defaults)
    assert.deepEqual(readSettings(file, defaults).settings, { firstCheckMinutes: 10, quietMinutes: 15, maxChecks: 3, slack: false })
    // The quiet was left at its default, so a new default of it shows; the ones set do not move.
    assert.deepEqual(readSettings(file, { ...defaults, quietMinutes: 20, maxChecks: 9 }).settings, {
      firstCheckMinutes: 10,
      quietMinutes: 20,
      maxChecks: 3,
      slack: false,
    })
    writeSettings(file, { ...defaults, maxChecks: 3 }, defaults)
    const db = new DatabaseSync(file, { readOnly: true })
    assert.deepEqual(
      db
        .prepare('SELECT name, value FROM settings')
        .all()
        .map((r) => ({ ...r })),
      [{ name: 'maxChecks', value: '3' }],
    )
    db.close()
  })
  it('reads the defaults, and keeps nothing, where the service has made no table yet', () => {
    assert.deepEqual(readSettings(join(dir, 'none.sqlite'), defaults), { settings: defaults, kept: false })
    const old = join(dir, 'old.sqlite')
    const db = new DatabaseSync(old)
    db.exec('CREATE TABLE checks (key TEXT)')
    db.close()
    assert.deepEqual(readSettings(old, defaults), { settings: defaults, kept: false })
    assert.throws(() => writeSettings(old, defaults, defaults), /no settings table/)
    assert.throws(() => writeSettings(join(dir, 'none.sqlite'), defaults, defaults), /No database/)
  })
  it('falls back to the default for a kept value out of its limits', () => {
    const file = join(dir, 'odd.sqlite')
    new Store(file)
    const db = new DatabaseSync(file)
    for (const [name, value] of [
      ['maxChecks', '0'],
      ['firstCheckMinutes', 'soon'],
      ['slack', 'maybe'],
    ])
      db.prepare('INSERT INTO settings (name, value, set_at) VALUES (?, ?, ?)').run(name!, value!, 't')
    db.close()
    assert.deepEqual(readSettings(file, defaults).settings, defaults)
  })
  it('takes whole numbers within their limits from a form; an unchecked switch is off', () => {
    assert.deepEqual(parseSettings(form({ firstCheckMinutes: '0', quietMinutes: ' 45 ', maxChecks: '20', slack: 'on' })), {
      firstCheckMinutes: 0,
      quietMinutes: 45,
      maxChecks: 20,
      slack: true,
    })
    assert.equal(parseSettings(form({ firstCheckMinutes: '30', quietMinutes: '15', maxChecks: '5' })).slack, false)
    const ok = { firstCheckMinutes: '30', quietMinutes: '15', maxChecks: '5' }
    assert.throws(() => parseSettings(form({ ...ok, maxChecks: '0' })), /checks per bug is a whole number from 1 to 20/)
    assert.throws(() => parseSettings(form({ ...ok, firstCheckMinutes: '1.5' })), /first check/)
    assert.throws(() => parseSettings(form({ ...ok, quietMinutes: '1441' })), /quiet/)
    assert.throws(() => parseSettings(form({ quietMinutes: '15', maxChecks: '5' })), /first check/)
  })
  it('names what changed', () => {
    assert.deepEqual(changedSettings(defaults, { ...defaults, maxChecks: 3, slack: false }), { maxChecks: 3, slack: false })
    assert.deepEqual(changedSettings(defaults, defaults), {})
  })
})
