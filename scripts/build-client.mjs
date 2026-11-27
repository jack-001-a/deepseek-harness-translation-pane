#!/usr/bin/env node
/**
 * Deterministically assemble ordered browser source parts into the one file
 * consumed by DeepSeek Harness' ModuleLoader.
 *
 * The parts intentionally share the factory closure. They are not standalone
 * browser modules and must not add runtime imports or exports.
 */
import { readFile, writeFile } from 'node:fs/promises'

const OUTPUT = new URL('../client.js', import.meta.url)
const PARTS = [
  '00-contracts.part.js',
  '10-host-runtime.part.js',
  '20-state-hooks.part.js',
  '30-components.part.js',
  '40-workbench.part.js',
]

const PREFIX = "/**\n * Browser half of the @ybbmm/dsh-translation-pane bundle.\n *\n * Adds one sidebar panel icon and one full-width translation workbench. The\n * workbench translates through the Host half's `translationPane` Remote\n * endpoint over the shared connection RPC, so the same code path serves this\n * panel and the agent's `translate_text` tool.\n *\n * Styles are declared as a React element inside the page component, so\n * unmounting removes them, and use only `--dsw-alias-*` theme tokens so light\n * and dark themes follow the application.\n */\nwindow.__ModuleLoader__.load({\n  id: '@ybbmm/dsh-translation-pane',\n  factory(require) {\n    const React = require('react')\n    const h = React.createElement\n\n"
const SUFFIX = "  },\n})\n"

async function build() {
  const sources = await Promise.all(PARTS.map(async (name) => {
    const source = await readFile(new URL('../src/client/' + name, import.meta.url), 'utf8')
    if (source.includes('\0')) throw new Error('Client source part contains a NUL byte: ' + name)
    return source.replace(/\r\n/g, '\n').trimEnd()
  }))
  return PREFIX + sources.join('\n\n') + '\n\n' + SUFFIX
}

const generated = await build()
if (process.argv.includes('--check')) {
  const current = await readFile(OUTPUT, 'utf8')
  if (current !== generated) {
    console.error('client.js is out of date. Run npm run build:client and commit the generated bundle.')
    process.exitCode = 1
  } else {
    console.log('client.js matches the ordered src/client source parts.')
  }
} else {
  await writeFile(OUTPUT, generated)
  console.log('Built client.js from ' + PARTS.length + ' ordered source parts.')
}
