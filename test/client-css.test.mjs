import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'

const clientPath = new URL('../client.js', import.meta.url)
const clientSource = readFileSync(fileURLToPath(clientPath), 'utf8')
const stylesheet = clientSource.match(/const CSS = `([\s\S]*?)`/)?.[1]

test('quality: every translation-pane CSS class is used by the component', () => {
  assert.equal(typeof stylesheet, 'string', 'client.js must declare its scoped stylesheet')

  const componentSource = clientSource.replace(/const CSS = `[\s\S]*?`/, '')
  const classes = new Set(
    [...stylesheet.matchAll(/\.([A-Za-z_][\w-]*)/g)]
      .map((match) => match[1])
      .filter((name) => name.startsWith('dshTr-')),
  )
  const unused = [...classes].filter((name) => !componentSource.includes(name)).sort()

  assert.deepEqual(unused, [], 'remove obsolete translation-pane CSS classes')
})
