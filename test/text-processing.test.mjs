import { test } from 'node:test'
import assert from 'node:assert/strict'

import { jsonStringValueTokens, splitText } from '../src/host/text.js'
import { markdownSegments } from '../src/host/markdown.js'

test('JSON token scanning returns string values but never object keys', () => {
  const source = JSON.stringify({
    name: 'hello',
    nested: ['world', 42, null, true],
    'escaped"key': 'line\nvalue',
    empty: '',
  }, null, 2)
  const tokens = jsonStringValueTokens(source)
  assert.deepEqual(tokens.map((token) => token.value), ['hello', 'world', 'line\nvalue', ''])
  for (const token of tokens) {
    assert.equal(JSON.parse(source.slice(token.start, token.end)), token.value)
  }
})

test('JSON token scanning supports top-level strings and escaped quotes', () => {
  const source = JSON.stringify('say "hello"')
  const tokens = jsonStringValueTokens(source)
  assert.deepEqual(tokens.map((token) => token.value), ['say "hello"'])
})

test('JSON token scanning rejects malformed JSON before returning offsets', () => {
  assert.throws(() => jsonStringValueTokens('{"value": }'), SyntaxError)
})

test('splitText preserves text exactly after extraction', () => {
  const tick = String.fromCharCode(96)
  const source = [
    'A paragraph with a URL https://example.test/path and ' + tick + 'inline code' + tick + '.',
    '',
    'A second paragraph with {{placeholder}} and a [link](https://example.test).',
    'The final line contains 👩🏽‍💻 and é.',
  ].join('\n')
  const fragments = splitText(source, 32)
  assert.equal(fragments.join(''), source)
  assert.ok(fragments.every((fragment) => fragment.length <= 32))
})


test('Markdown segmentation translates prose and preserves structural spans', () => {
  const tick = String.fromCharCode(96)
  const source = [
    '# Welcome **reader**',
    '',
    '- Read ' + tick + 'const value = 1' + tick + ' and [the guide](https://example.test/docs).',
    '- Keep {{account.name}} and ${runtime.value} unchanged.',
    '',
    '```js',
    'const secret = "do not translate";',
    '```',
    'Use <kbd>Ctrl</kbd> and https://example.test/path.',
  ].join('\n')
  const segments = markdownSegments(source)
  assert.equal(segments.map((segment) => segment.text).join(''), source)

  const prose = segments.filter((segment) => segment.translate).map((segment) => segment.text).join('')
  const protectedSource = segments.filter((segment) => !segment.translate).map((segment) => segment.text).join('')

  assert.match(prose, /Welcome/)
  assert.match(prose, /reader/)
  assert.match(prose, /the guide/)
  assert.match(prose, /Use/)
  for (const token of [
    'const value = 1',
    'https://example.test/docs',
    '{{account.name}}',
    '${runtime.value}',
    'const secret = "do not translate";',
    '<kbd>',
    '</kbd>',
    'https://example.test/path',
  ]) {
    assert.ok(protectedSource.includes(token), token + ' must be protected')
    assert.equal(prose.includes(token), false, token + ' must not be sent for translation')
  }
  assert.ok(protectedSource.includes('```js'))
  assert.ok(protectedSource.includes('**'))
})

test('Markdown segmentation protects an unclosed fenced block through EOF', () => {
  const source = 'Translate this.\n\n```js\nconst secret = true;'
  const segments = markdownSegments(source)
  assert.equal(segments.map((segment) => segment.text).join(''), source)
  assert.deepEqual(segments.filter((segment) => segment.translate).map((segment) => segment.text), [
    'Translate this.\n\n',
  ])
  assert.equal(segments.filter((segment) => !segment.translate).map((segment) => segment.text).join(''), '```js\nconst secret = true;')
})

test('Markdown segmentation returns no translatable prose for a code-only document', () => {
  const source = '```json\n{"secret":"value"}\n```\n`const x = 1`'
  const segments = markdownSegments(source)
  assert.equal(segments.map((segment) => segment.text).join(''), source)
  assert.equal(segments.some((segment) => segment.translate), false)
})
