import { test } from 'node:test'
import assert from 'node:assert/strict'

import { apply, resolveConfig, TranslationPaneService } from '../index.js'
import {
  MAX_GLOSSARY_ENTRIES,
  createTranslationPlan,
  countTranslationPlanFragments,
  glossarySegments,
  inspectGlossary,
  languageScopeMatches,
  normalizeGlossary,
  parseGlossaryImport,
  renderTranslationPlans,
  serializeGlossaryExport,
} from '../src/host/glossary.js'

test('glossary normalization accepts valid terms and skips malformed or duplicate entries', () => {
  const glossary = normalizeGlossary([
    { source: ' API ', target: '接口' },
    { source: 'api', target: '重复项' },
    { source: '', target: '空源词' },
    { source: 'invalid', target: '' },
    { source: 'bad\nterm', target: '无效' },
    { source: 'DeepSeek', target: '深度求索' },
  ])

  assert.deepEqual(
    glossary.map(({ source, target }) => ({ source, target })),
    [
      { source: 'DeepSeek', target: '深度求索' },
      { source: 'API', target: '接口' },
    ],
  )
  assert.ok(Object.isFrozen(glossary))
  assert.ok(glossary.every(Object.isFrozen))
  assert.equal(normalizeGlossary({ API: '接口' }).length, 0)
})

test('the Host config disables the glossary by default', () => {
  assert.deepEqual(resolveConfig(undefined).glossary, [])
})

test('glossary normalization caps the number and length of configured terms', () => {
  const glossary = normalizeGlossary(
    Array.from({ length: MAX_GLOSSARY_ENTRIES + 20 }, (_, index) => ({
      source: 'term-' + index,
      target: '译法-' + index,
    })),
  )
  assert.equal(glossary.length, MAX_GLOSSARY_ENTRIES)
  assert.equal(normalizeGlossary([{ source: 'x'.repeat(129), target: 'y' }]).length, 0)
  assert.equal(normalizeGlossary([{ source: 'x', target: 'y'.repeat(129) }]).length, 0)
})

test('glossary matching is case-insensitive, longest-first and boundary-aware', () => {
  const glossary = normalizeGlossary([
    { source: 'API', target: '接口' },
    { source: 'DeepSeek API', target: '深度求索接口' },
    { source: 'C++', target: 'C++' },
  ])
  const source = 'DeepSeek API, API gateway, rapid, APIs and C++.'
  const segments = glossarySegments(source, glossary)

  assert.equal(segments.map((segment) => segment.text).join(''), '深度求索接口, 接口 gateway, rapid, APIs and C++.')
  assert.deepEqual(
    segments.filter((segment) => !segment.translate).map((segment) => segment.text),
    ['深度求索接口', '接口', 'C++'],
  )
  assert.equal(segments.filter((segment) => segment.translate).map((segment) => segment.text).join(''), ',  gateway, rapid, APIs and .')
})

test('CJK terms match within continuous text and replacements are not translatable', () => {
  const glossary = normalizeGlossary([{ source: '人工智能', target: 'AI' }])
  const segments = glossarySegments('使用人工智能工具', glossary)
  assert.deepEqual(segments, [
    { text: '使用', translate: true },
    { text: 'AI', translate: false },
    { text: '工具', translate: true },
  ])
})

test('translation plans split only prose and reassemble results in their original order', () => {
  const glossary = normalizeGlossary([
    { source: 'DeepSeek', target: '深度求索' },
    { source: 'API', target: '接口' },
  ])
  const plans = [
    createTranslationPlan('DeepSeek API is useful', glossary, 6),
    createTranslationPlan('API', glossary, 6),
  ]

  const fragmentCount = countTranslationPlanFragments(plans)
  const fragments = plans.flatMap((plan) =>
    plan.flatMap((segment) => segment.fragments),
  )
  assert.equal(fragmentCount, fragments.length)
  assert.deepEqual(fragments, [' ', ' is ', 'useful'])

  const results = fragments.map((text) => ({ text: '[' + text + ']' }))
  const rendered = renderTranslationPlans(plans, results)
  assert.deepEqual(rendered.texts, ['深度求索[ ]接口[ is ][useful]', '接口'])
  assert.equal(rendered.consumed, results.length)
})

test('empty source strings make no provider fragments', () => {
  const plan = createTranslationPlan('', normalizeGlossary([{ source: 'a', target: 'b' }]), 10)
  assert.deepEqual(plan, [])
  assert.equal(countTranslationPlanFragments([plan]), 0)
  assert.deepEqual(renderTranslationPlans([plan], []).texts, [''])
})

/**
 * Create the real Host service with a fake shipped translator that records
 * every source fragment sent to the provider.
 * @param config - plugin configuration.
 * @returns the service and captured provider requests.
 */
function translatedHarness(config) {
  const requests = []
  const translator = {
    maxTextChars: 4000,
    resolve: (request) => ({ ...request, provider: 'bing' }),
    translate: async (request) => {
      requests.push(request.text)
      return request.text.toUpperCase()
    },
  }
  const ctx = {
    get: (name) => name === 'translator' ? translator : undefined,
    logger: {},
  }
  return {
    requests,
    service: new TranslationPaneService(ctx, resolveConfig(config)),
  }
}

test('Host text translation applies glossary terms locally before provider dispatch', async () => {
  const h = translatedHarness({
    glossary: [
      { source: 'DeepSeek API', target: '深度求索接口' },
      { source: 'API', target: '接口' },
    ],
  })
  const result = await h.service.translateRequest({
    text: 'DeepSeek API is great',
    sourceLanguage: 'en',
    targetLanguage: 'zh-Hans',
  })

  assert.deepEqual(h.requests, [' is great'])
  assert.equal(result.text, '深度求索接口 IS GREAT')
  assert.equal(h.service.describe().glossaryEntries, 2)
})

test('a glossary-only source is returned locally without contacting a provider', async () => {
  const h = translatedHarness({
    glossary: [{ source: 'DeepSeek API', target: '深度求索接口' }],
  })
  const result = await h.service.translateRequest({
    text: 'DeepSeek API',
    sourceLanguage: 'en',
    targetLanguage: 'zh-Hans',
  })

  assert.deepEqual(h.requests, [])
  assert.equal(result.text, '深度求索接口')
  assert.equal(result.provider, 'none')
})

test('JSON mode applies the glossary only to string values and keeps keys and structure', async () => {
  const h = translatedHarness({
    glossary: [
      { source: 'API', target: '接口' },
      { source: 'DeepSeek', target: '深度求索' },
    ],
  })
  const source = '{ "API": "API works with DeepSeek", "count": 1, "enabled": false }'
  const result = await h.service.translateRequest({
    text: source,
    sourceLanguage: 'en',
    targetLanguage: 'zh-Hans',
    format: 'json',
  })

  assert.deepEqual(h.requests, [' works with '])
  assert.equal(result.text, '{ "API": "接口 WORKS WITH 深度求索", "count": 1, "enabled": false }')
  assert.deepEqual(JSON.parse(result.text), {
    API: '接口 WORKS WITH 深度求索',
    count: 1,
    enabled: false,
  })
})

test('Markdown mode applies the glossary only to prose, not protected syntax or code', async () => {
  const h = translatedHarness({
    glossary: [
      { source: 'DeepSeek API', target: '深度求索接口' },
      { source: 'API', target: '接口' },
    ],
  })
  const tick = String.fromCharCode(96)
  const fence = tick.repeat(3)
  const source = [
    '# DeepSeek API',
    '',
    'Use API with ' + tick + 'DeepSeek API' + tick + ' [API](https://example.test/API)',
    '',
    fence + 'js',
    'DeepSeek API',
    fence,
  ].join('\n')

  const result = await h.service.translateRequest({
    text: source,
    sourceLanguage: 'en',
    targetLanguage: 'zh-Hans',
    format: 'markdown',
  })

  assert.deepEqual(h.requests, ['\n\nUse ', ' with '])
  assert.equal(result.text.startsWith('# 深度求索接口'), true)
  assert.ok(result.text.includes(tick + 'DeepSeek API' + tick), 'inline code must remain unchanged')
  assert.ok(result.text.includes('[接口](https://example.test/API)'), 'link labels use the glossary but destinations stay unchanged')
  assert.ok(result.text.includes(fence + 'js\nDeepSeek API\n' + fence), 'fenced code must remain unchanged')
  assert.equal(h.requests.join('').includes('DeepSeek'), false)
  assert.equal(h.requests.join('').includes('API'), false)
})

test('translate_text describes local glossary handling and uses the same Host path', async () => {
  const requests = []
  const translator = {
    maxTextChars: 4000,
    resolve: (request) => ({ ...request, provider: 'bing' }),
    translate: async (request) => {
      requests.push(request.text)
      return 'T:' + request.text
    },
  }
  const tools = []
  const services = new Map([['translator', translator]])
  const ctx = {
    get: (name) => services.get(name),
    logger: {},
    reflect: { provide: (name, service) => services.set(name, service) },
    effect: (setup) => setup(),
    tools: { register: (tool) => { tools.push(tool); return () => {} } },
  }
  apply(ctx, {
    glossary: [{ source: 'DeepSeek', target: '深度求索' }],
  })
  const tool = tools.find((entry) => entry.name === 'translate_text')

  assert.match(tool.description, /glossary terms are replaced locally/)
  const result = await tool.execute(
    { text: 'DeepSeek is useful', targetLanguage: 'zh-Hans', sourceLanguage: 'en' },
    { signal: new AbortController().signal },
  )

  assert.deepEqual(requests, [' is useful'])
  assert.equal(result.text, '深度求索T: is useful')
})


test('language scopes isolate source/target pairs and accept regional variants', () => {
  assert.equal(languageScopeMatches('*', 'fr'), true)
  assert.equal(languageScopeMatches('en', 'en-US'), true)
  assert.equal(languageScopeMatches('en', 'fr'), false)
  assert.equal(languageScopeMatches('fr', 'auto'), false)
  const glossary = normalizeGlossary([
    { source: 'API', target: '接口', sourceLanguage: 'en', targetLanguage: 'zh-Hans' },
    { source: 'API', target: 'API', sourceLanguage: 'en', targetLanguage: 'fr' },
    { source: 'API', target: 'API', sourceLanguage: 'fr', targetLanguage: 'zh-Hans' },
  ])
  assert.deepEqual(
    glossarySegments('API docs', glossary, { sourceLanguage: 'en-US', targetLanguage: 'zh-Hans' }),
    [
      { text: '接口', translate: false },
      { text: ' docs', translate: true },
    ],
  )
  assert.deepEqual(
    glossarySegments('API docs', glossary, { sourceLanguage: 'en', targetLanguage: 'fr' }),
    [
      { text: 'API', translate: false },
      { text: ' docs', translate: true },
    ],
  )
})

test('case-sensitive, substring and whole-word rules are configurable per term', () => {
  const glossary = normalizeGlossary([
    { source: 'DeepSeek', target: 'DS', matchCase: true },
    { source: 'API', target: '接口', wholeWord: true },
    { source: 'rapid', target: 'FAST' },
    { source: 'kit', target: '组件', wholeWord: false },
  ])
  assert.deepEqual(glossarySegments('DeepSeek deepseek API rapid kit', glossary).map((x) => x.text), [
    'DS deepseek ',
    '接口',
    ' ',
    'FAST',
    ' ',
    '组件',
  ])
})

test('priority wins before longest-match order and disabled entries never match', () => {
  const glossary = normalizeGlossary([
    { source: 'DeepSeek API', target: 'LONG', priority: 0 },
    { source: 'DeepSeek', target: 'SHORT', priority: 10 },
    { source: 'ignored', target: '忽略', enabled: false },
  ])
  const segments = glossarySegments('DeepSeek API ignored', glossary)
  assert.equal(segments.map((x) => x.text).join(''), 'SHORT API ignored')
  assert.deepEqual(segments.filter((x) => !x.translate).map((x) => x.text), ['SHORT'])
})

test('inspection diagnoses duplicate conflicts and overlapping terms', () => {
  const inspected = inspectGlossary([
    { source: 'API', target: '接口' },
    { source: 'api', target: '应用程序接口' },
    { source: 'DeepSeek API', target: '深度求索接口' },
  ])
  assert.equal(inspected.errors.length, 1)
  assert.equal(inspected.errors[0].code, 'conflicting-entry')
  assert.ok(inspected.warnings.some((warning) => warning.code === 'conflicting-entry'))
  assert.ok(inspected.warnings.some((warning) => warning.code === 'overlapping-terms'))
  assert.equal(inspected.entries.length, 2, 'the first duplicate wins')
})

test('versioned glossary JSON import and export round-trip all rule fields', () => {
  const source = [
    {
      source: 'DeepSeek',
      target: '深度求索',
      sourceLanguage: 'en',
      targetLanguage: 'zh-Hans',
      matchCase: true,
      wholeWord: false,
      enabled: false,
      priority: 8,
    },
  ]
  const normalized = normalizeGlossary(source)
  const exported = serializeGlossaryExport(normalized)
  const imported = parseGlossaryImport(exported)
  assert.equal(imported.errors.length, 0)
  assert.deepEqual(
    imported.entries.map(({ source: a, target, sourceLanguage, targetLanguage, matchCase, wholeWord, enabled, priority }) =>
      ({ source: a, target, sourceLanguage, targetLanguage, matchCase, wholeWord, enabled, priority })),
    [{
      source: 'DeepSeek',
      target: '深度求索',
      sourceLanguage: 'en',
      targetLanguage: 'zh-hans',
      matchCase: true,
      wholeWord: false,
      enabled: false,
      priority: 8,
    }],
  )
})

test('glossary JSON import reports malformed files, unsupported versions and conflicts', () => {
  assert.equal(parseGlossaryImport('{').errors[0].code, 'invalid-json')
  assert.equal(parseGlossaryImport('{"version":9,"glossary":[]}').errors[0].code, 'unsupported-format')
  assert.equal(parseGlossaryImport(JSON.stringify([
    { source: 'API', target: '接口' },
    { source: 'api', target: '程序接口' },
  ])).errors[0].code, 'conflicting-entry')
})
