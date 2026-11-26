import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  MAX_GLOSSARY_ENTRIES,
  createTranslationPlan,
  countTranslationPlanFragments,
  glossarySegments,
  normalizeGlossary,
  renderTranslationPlans,
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
  assert.deepEqual(fragments, [' ', 'is ', 'usefu', 'l'])

  const results = fragments.map((text) => ({ text: '[' + text + ']' }))
  const rendered = renderTranslationPlans(plans, results)
  assert.deepEqual(rendered.texts, ['深度求索[ ][is ][usefu][l]', '接口'])
  assert.equal(rendered.consumed, results.length)
})

test('empty source strings make no provider fragments', () => {
  const plan = createTranslationPlan('', normalizeGlossary([{ source: 'a', target: 'b' }]), 10)
  assert.deepEqual(plan, [])
  assert.equal(countTranslationPlanFragments([plan]), 0)
  assert.deepEqual(renderTranslationPlans([plan], []).texts, [''])
})
