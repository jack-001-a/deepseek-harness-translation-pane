import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
  GLOSSARY_WARNING_CODES,
  normalizeGlossaryEntries,
  normalizeGlossaryWarnings,
  resolveLanguageSwapReason,
  resolveWorkbenchStatus,
  uniqueCatalogIds,
} from '../src/client/domain.js'

test('domain: glossary records retain portable fields and reject malformed rows', () => {
  const entries = normalizeGlossaryEntries([
    null,
    'not an object',
    [],
    { source: '', target: 'empty source' },
    { source: 'unsafe' + String.fromCharCode(0) + 'term', target: 'unsafe' },
    { source: 'API', target: '接口', sourceLanguage: '*', targetLanguage: 'zh-Hans' },
    {
      source: ' cache ',
      target: ' 缓存 ',
      sourceLanguage: 'en',
      targetLanguage: 'zh-Hans',
      matchCase: true,
      wholeWord: false,
      enabled: false,
      priority: -20,
      ignored: 'field',
    },
    { source: 'bounded', target: '有界', priority: 1001 },
  ])
  assert.deepEqual(entries, [
    { source: 'API', target: '接口', targetLanguage: 'zh-Hans' },
    {
      source: 'cache',
      target: '缓存',
      sourceLanguage: 'en',
      targetLanguage: 'zh-Hans',
      matchCase: true,
      wholeWord: false,
      enabled: false,
      priority: -20,
    },
    { source: 'bounded', target: '有界' },
  ])
})

test('domain: glossary warnings are allowlisted and remote messages are discarded', () => {
  assert.deepEqual(GLOSSARY_WARNING_CODES, [
    'invalid-entry',
    'too-many-entries',
    'duplicate-entry',
    'conflicting-entry',
    'overlapping-terms',
  ])
  assert.deepEqual(normalizeGlossaryWarnings([
    null,
    'invalid-entry',
    [],
    { code: 'unknown-warning' },
    { code: 'overlapping-terms', message: 'untrusted diagnostic text', index: 9 },
    { code: 'duplicate-entry' },
  ]), [
    { code: 'overlapping-terms' },
    { code: 'duplicate-entry' },
  ])
  assert.deepEqual(normalizeGlossaryWarnings({ code: 'overlapping-terms' }), [])
})

test('domain: catalog ids are unique, non-empty strings in first-seen order', () => {
  assert.deepEqual(
    uniqueCatalogIds(['auto', 'en', 'en', ' custom ', 'custom', '', '  ', 42, null]),
    ['auto', 'en', ' custom ', 'custom'],
  )
  assert.deepEqual(uniqueCatalogIds('en'), [])
  assert.deepEqual(uniqueCatalogIds(null), [])
})

test('domain: language swap guards pending, unknown and same-language directions', () => {
  const reason = (options) => resolveLanguageSwapReason({
    pending: false,
    sourceLanguage: 'en',
    targetLanguage: 'zh-Hans',
    detectedSource: null,
    ...options,
  })
  assert.equal(reason({ pending: true }), 'swap.pending')
  assert.equal(reason({ sourceLanguage: 'auto' }), 'swap.auto')
  assert.equal(reason({ sourceLanguage: 'auto', detectedSource: '' }), 'swap.auto')
  assert.equal(reason({ sourceLanguage: 'auto', detectedSource: 'zh-Hans' }), 'swap.same')
  assert.equal(reason({ sourceLanguage: 'en', targetLanguage: 'en' }), 'swap.same')
  assert.equal(reason({ sourceLanguage: 'auto', detectedSource: 'en' }), null)
  assert.equal(reason({ sourceLanguage: 'en', targetLanguage: 'zh-Hans' }), null)
})

test('domain: workbench status follows one deterministic precedence table', () => {
  const t = (key) => 'translated:' + key
  const state = (overrides = {}) => resolveWorkbenchStatus({
    error: null,
    offline: false,
    pending: false,
    overLimit: false,
    status: 'idle',
    connected: true,
    t,
    ...overrides,
  })
  assert.deepEqual(state(), {
    alertMessage: null,
    state: 'ready',
    stateLabel: 'translated:status.ready',
  })
  assert.equal(state({ connected: false }).state, 'connecting')
  assert.equal(state({ status: 'cancelled' }).state, 'cancelled')
  assert.equal(state({ overLimit: true }).state, 'limited')
  assert.equal(state({ pending: true }).state, 'working')
  assert.equal(state({ error: 'request failed' }).state, 'error')
  assert.deepEqual(state({ offline: true }), {
    alertMessage: 'translated:error.offline',
    state: 'offline',
    stateLabel: 'translated:status.offline',
  })
  assert.deepEqual(state({ offline: true, error: 'specific failure' }), {
    alertMessage: 'specific failure',
    state: 'offline',
    stateLabel: 'translated:status.offline',
  })
})
