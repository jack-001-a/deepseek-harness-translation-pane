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

const INLINE_MODULES = ['domain.js']

async function readSource(url, name) {
  const source = await readFile(url, 'utf8')
  if (source.includes('\0')) throw new Error('Client source contains a NUL byte: ' + name)
  return source.replace(/\r\n/g, '\n').trimEnd()
}

/**
 * Inline a dependency-free ES module into the ModuleLoader factory.
 * Only named top-level const/function exports are supported.
 */
function inlineModule(source, name) {
  if (/^\s*import\s/m.test(source)) {
    throw new Error('Inline client modules cannot import runtime dependencies: ' + name)
  }
  const declarations = source.match(/^export\s+(?=(?:const|function)\b)/gm) ?? []
  if (declarations.length === 0) {
    throw new Error('Inline client module has no supported named declarations: ' + name)
  }
  const inlined = source.replace(/^export\s+(?=(?:const|function)\b)/gm, '')
  if (/^\s*(?:import|export)\s/m.test(inlined)) {
    throw new Error('Unsupported module syntax in client inline module: ' + name)
  }
  return inlined.trimEnd()
}

async function build() {
  const [modules, parts] = await Promise.all([
    Promise.all(INLINE_MODULES.map(async (name) =>
      inlineModule(await readSource(new URL('../src/client/' + name, import.meta.url), name), name),
    )),
    Promise.all(PARTS.map((name) =>
      readSource(new URL('../src/client/' + name, import.meta.url), name),
    )),
  ])
  return PREFIX + [...modules, ...parts].join('\n\n') + '\n\n' + SUFFIX
}

const generated = await build()
if (process.argv.includes('--check')) {
  const current = await readFile(OUTPUT, 'utf8')
  if (current !== generated) {
    console.error('client.js is out of date. Run npm run build:client and commit the generated bundle.')
    process.exitCode = 1
  }
} else {
  await writeFile(OUTPUT, generated)
  console.log('Built client.js from ' + PARTS.length + ' ordered source parts.')
}
