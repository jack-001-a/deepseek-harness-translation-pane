import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
  GLOSSARY_WARNING_CODES,
  normalizeGlossaryEntries,
  normalizeGlossaryWarnings,
  normalizePreferences,
  normalizeProviderHealth,
  languageOptions,
  providerOptions,
  resolveProviderPresentation,
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


test('domain: stored preferences normalize unsupported values but preserve custom languages', () => {
  const providers = ['bing', 'google']
  assert.deepEqual(normalizePreferences(null, providers), {
    sourceLanguage: 'auto', targetLanguage: 'zh-Hans', provider: 'bing', format: 'text',
  })
  assert.deepEqual(normalizePreferences([], providers), {
    sourceLanguage: 'auto', targetLanguage: 'zh-Hans', provider: 'bing', format: 'text',
  })
  assert.deepEqual(normalizePreferences({
    sourceLanguage: ' custom-lang ', targetLanguage: '', provider: 'retired-provider', format: 'xml',
  }, providers), {
    sourceLanguage: ' custom-lang ', targetLanguage: 'zh-Hans', provider: 'bing', format: 'text',
  })
  assert.deepEqual(normalizePreferences({
    sourceLanguage: 'ja', targetLanguage: 'en', provider: 'google', format: 'markdown',
  }, providers), {
    sourceLanguage: 'ja', targetLanguage: 'en', provider: 'google', format: 'markdown',
  })
  assert.equal(normalizePreferences({ provider: 'custom' }, []).provider, 'bing')
})

test('domain: provider health is normalized into a prototype-safe dictionary', () => {
  const source = JSON.parse('{"google":{"unreachable":true,"until":"ignored"},"bing":{"unreachable":false},"bad":{"unreachable":"yes"},"empty":null,"__proto__":{"unreachable":true}}')
  const health = normalizeProviderHealth(source)
  assert.equal(Object.getPrototypeOf(health), null)
  assert.deepEqual(health.google, { unreachable: true })
  assert.deepEqual(health.bing, { unreachable: false })
  assert.equal(health.bad, undefined)
  assert.equal(health.empty, undefined)
  assert.deepEqual(health.__proto__, { unreachable: true })
  assert.equal(Object.getPrototypeOf(normalizeProviderHealth(null)), null)
  assert.equal(Object.getPrototypeOf(normalizeProviderHealth([])), null)
})

test('domain: language and provider options preserve Host order and catalog labels', () => {
  const languages = [
    { id: 'auto', label: 'Auto detect', zh: '自动检测' },
    { id: 'en', label: 'English', zh: '英语' },
    { id: 'ja', label: 'Japanese', zh: '日语' },
  ]
  const providers = [
    { id: 'bing', label: 'Bing', zh: '必应' },
    { id: 'google', label: 'Google', zh: '谷歌' },
  ]
  assert.deepEqual(languageOptions(['en', 'custom-lang', 'en', '', 42], true, languages), [
    languages[0], languages[1],
    { id: 'custom-lang', label: 'custom-lang', zh: 'custom-lang' },
  ])
  assert.deepEqual(languageOptions(['auto', 'ja'], false, languages), [languages[2]])
  assert.deepEqual(languageOptions([], false, languages), [languages[1], languages[2]])
  assert.deepEqual(providerOptions([], providers), [providers[0]])
  assert.deepEqual(providerOptions(['google', 'custom-provider', 'google'], providers), [
    providers[1],
    { id: 'custom-provider', label: 'custom-provider', zh: 'custom-provider' },
  ])
})

test('domain: provider presentation keeps failover notices and served metadata consistent', () => {
  const providerName = (id) => ({ bing: 'Bing', google: 'Google' })[id] ?? id
  const t = (key, values) => key + ':' + JSON.stringify(values)
  const base = {
    pending: false, result: null, provider: 'bing', providerHealth: {}, failoverCapable: true,
    error: null, providerLabel: 'Bing', providerName, t,
  }
  assert.deepEqual(resolveProviderPresentation({
    ...base, result: { providersServed: ['bing', 'google'], provider: 'bing' },
  }), {
    notice: 'notice.mixed:{"providers":"Bing + Google"}', servedLabel: 'Bing + Google',
  })
  assert.deepEqual(resolveProviderPresentation({
    ...base, result: { failover: true, requestedProvider: 'bing', provider: 'google' },
  }), {
    notice: 'notice.failover:{"requested":"Bing","served":"Google"}', servedLabel: 'Google',
  })
  assert.deepEqual(resolveProviderPresentation({
    ...base, provider: 'google', providerHealth: { google: { unreachable: true } },
  }), {
    notice: 'notice.providerDown:{"provider":"Google"}', servedLabel: 'Bing',
  })
  assert.deepEqual(resolveProviderPresentation({
    ...base, pending: true, result: { failover: true, requestedProvider: 'bing', provider: 'google' },
  }), { notice: null, servedLabel: 'Google' })
  assert.deepEqual(resolveProviderPresentation({
    ...base, provider: 'google', providerHealth: { google: { unreachable: true } }, failoverCapable: false,
  }), { notice: null, servedLabel: 'Bing' })
})
