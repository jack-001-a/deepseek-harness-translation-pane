#!/usr/bin/env node
/**
 * Smoke-test the plugin inside real, pinned DeepSeek Harness runtime packages.
 * This deliberately exercises Cordis composition and the AgentLoop tool service,
 * rather than the lightweight fake context used by the unit tests.
 */
import assert from 'node:assert/strict'
import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { apply, inject, TranslationPaneService } from '../index.js'

const harnessRoot = process.env.DSH_HARNESS_ROOT
const harnessVersion = process.env.DSH_HARNESS_VERSION
const manifestPath = process.env.DSH_COMPATIBILITY_MANIFEST

if (!harnessRoot || !harnessVersion || !manifestPath) {
  throw new Error('Set DSH_HARNESS_ROOT, DSH_HARNESS_VERSION and DSH_COMPATIBILITY_MANIFEST.')
}

const root = resolve(harnessRoot)
const packages = {
  '@deepseek-ai/cordis': 'vendor/cordis',
  '@deepseek-ai/dsh-agent-loop-testkit': 'packages/test-support/agent-loop-testkit',
  '@deepseek-ai/dsh-agent-loop': 'packages/core/agent-loop',
}

async function importHarnessPackage(name) {
  const path = packages[name]
  if (!path) throw new Error('No pinned workspace path configured for ' + name)
  return import(pathToFileURL(join(root, path, 'lib/index.js')).href)
}

const originalFetch = globalThis.fetch
const providerRequests = []
let context
let outcome = 'FAIL'
let failure

try {
  const [{ Context }, testkit, agentLoop] = await Promise.all([
    importHarnessPackage('@deepseek-ai/cordis'),
    importHarnessPackage('@deepseek-ai/dsh-agent-loop-testkit'),
    importHarnessPackage('@deepseek-ai/dsh-agent-loop'),
  ])

  context = new Context()
  await testkit.mountAgentLoopTestDependencies(context)
  await context.plugin(agentLoop.default, { agents: [] })

  // Load the production plugin descriptor through Cordis so its declared
  // `tools` dependency is resolved as it is in a Host plugin composition.
  await context.plugin({ name: 'dsh-translation-pane-compatibility', inject, apply })
  const service = context.get('translationPane')
  assert.ok(service, 'the real Cordis context must expose translationPane')
  assert.equal(service.describe().route, 'direct')
  assert.deepEqual(service.describe().providers, ['bing', 'google'])

  // The descriptor is attached to the exported concrete service class; read
  // it there rather than through Cordis's traceable service proxy.
  const remote = TranslationPaneService.prototype['@deepseek-ai/dsh-typert-protocol/remote-methods']
  assert.equal(remote?.version, 1)
  assert.deepEqual(remote?.methods?.map((entry) => entry.method), ['describe', 'translate', 'setGlossary'])

  globalThis.fetch = async (_url, init) => {
    const fragment = JSON.parse(init.body)[0]
    providerRequests.push(fragment)
    return new Response(JSON.stringify([{ translations: [{ text: 'translated:' + fragment }] }]), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })
  }

  const source = '{\n  "label": "hello",\n  "count": 7,\n  "enabled": true\n}'
  const translated = await service.translate({
    text: source,
    targetLanguage: 'zh-Hans',
    format: 'json',
  })
  assert.equal(translated.text, '{\n  "label": "translated:hello",\n  "count": 7,\n  "enabled": true\n}')
  assert.deepEqual(providerRequests, ['hello'])

  const beforeInvalid = providerRequests.length
  await assert.rejects(
    service.translate({ text: '{"label":', targetLanguage: 'zh-Hans', format: 'json' }),
    (error) => error.code === 'translation-pane/invalid-request',
  )
  assert.equal(providerRequests.length, beforeInvalid, 'invalid JSON must fail before provider I/O')

  const glossaryUpdate = service.setGlossary(JSON.stringify({
    version: 1,
    glossary: [{ source: 'DeepSeek', target: '深度求索', sourceLanguage: 'en', targetLanguage: 'zh-Hans' }],
  }))
  assert.equal(glossaryUpdate.count, 1)
  const afterGlossary = await service.translate({
    text: 'DeepSeek',
    sourceLanguage: 'en',
    targetLanguage: 'zh-Hans',
  })
  assert.equal(afterGlossary.text, '深度求索')
  assert.deepEqual(providerRequests, ['hello'], 'glossary replacements must remain local to the Host')

  outcome = 'PASS'
} catch (error) {
  failure = error instanceof Error ? error.stack ?? error.message : String(error)
  throw error
} finally {
  globalThis.fetch = originalFetch
  if (context?.fiber?.dispose) await context.fiber.dispose()
  await mkdir(dirname(manifestPath), { recursive: true })
  const manifest = {
    schemaVersion: 1,
    status: outcome,
    harnessVersion,
    nodeVersion: process.version,
    cases: [
      'real-cordis-composition',
      'real-agentloop-tool-service-registration',
      'remote-method-descriptor',
      'json-value-only-translation',
      'invalid-json-rejected-before-provider-io',
      'runtime-glossary-update-over-real-cordis-service',
      'glossary-source-kept-out-of-provider-io',
    ],
    providerRequests,
    ...(failure === undefined ? {} : { failure }),
  }
  await writeFile(manifestPath, JSON.stringify(manifest, null, 2) + '\n')
}
