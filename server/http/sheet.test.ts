// The sheet's copy is current: ui/sheet.css, ui/theme.js and ui/fonts/ match pipeline-ui's
// (scripts/sheet-sync.sh brings them up to date). Skipped where pipeline-ui is not checked out.
import assert from 'node:assert/strict'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { describe, it } from 'vitest'

const root = resolve(import.meta.dirname, '../..')
const source = process.env.PIPELINE_UI_DIR ?? resolve(root, '../pipeline-ui')
const present = existsSync(join(source, 'ui/src/sheet.css'))

describe.skipIf(!present)(`the sheet's copy (source: ${source}${present ? '' : ', not checked out: skipped'})`, () => {
  it('sheet.css and theme.js are byte-identical to the source', () => {
    for (const [from, to] of [
      ['ui/src/sheet.css', 'ui/sheet.css'],
      ['ui/public/theme.js', 'ui/theme.js'],
    ])
      assert.ok(readFileSync(join(source, from!)).equals(readFileSync(join(root, to!))), `${to} is behind: npm run sheet:sync`)
  })
  it('every font file is here', () => {
    const fonts = readdirSync(join(source, 'ui/public/fonts')).filter((f) => f.endsWith('.woff2') || f === 'OFL.txt')
    assert.ok(fonts.length > 0)
    for (const f of fonts)
      assert.ok(
        readFileSync(join(source, 'ui/public/fonts', f)).equals(readFileSync(join(root, 'ui/fonts', f))),
        `ui/fonts/${f} is behind: npm run sheet:sync`,
      )
  })
})
