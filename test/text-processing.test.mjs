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

test('splitText preserves source, size bounds and complete fitting graphemes', () => {
  const source = [
    'A paragraph with a URL https://example.test/path and `inline code`.',
    '',
    'A second paragraph with {{placeholder}} and a [link](https://example.test).',
    'The final line contains 👩🏽‍💻 and é.',
  ].join('\n')
  const fragments = splitText(source, 32)
  assert.equal(fragments.join(''), source)
  assert.ok(fragments.every((fragment) => fragment.length <= 32))
})

test('splitText rejects a limit smaller than one code point when a cut is required', () => {
  assert.throws(() => splitText('😀x', 1), RangeError)
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


test('Markdown segmentation preserves reference-style link definitions and identifiers', () => {
  const source = [
    '[guide]: https://example.test/docs "Do not translate this title"',
    '[reference]: <https://example.test/reference> \'Reference title\'',
    '',
    'Read the [installation guide][guide], the [reference][], and [guide] again.',
    '![diagram][diagram]',
    '[diagram]: https://example.test/diagram.png "Architecture diagram"',
  ].join('\n')
  const segments = markdownSegments(source)
  assert.equal(segments.map((segment) => segment.text).join(''), source)

  const prose = segments.filter((segment) => segment.translate).map((segment) => segment.text).join('')
  const protectedSource = segments.filter((segment) => !segment.translate).map((segment) => segment.text).join('')

  for (const label of ['installation guide', 'reference', 'guide again']) {
    assert.ok(prose.includes(label), label + ' should remain translatable')
  }
  for (const token of [
    '[guide]: https://example.test/docs "Do not translate this title"',
    '[reference]: <https://example.test/reference> \'Reference title\'',
    '][guide]',
    '[]',
    '![diagram][diagram]',
    '[diagram]: https://example.test/diagram.png "Architecture diagram"',
  ]) {
    assert.ok(protectedSource.includes(token), token + ' must be preserved')
    assert.equal(prose.includes(token), false, token + ' must not be sent for translation')
  }
});


test('Markdown segmentation protects multiline and unclosed HTML comments', () => {
  const source = [
    'Translate this sentence.',
    '<!-- translator note:',
    'Do not translate this hidden annotation or {{runtime.value}}.',
    '-->',
    'Translate this sentence too.',
  ].join('\n')
  const segments = markdownSegments(source)
  assert.equal(segments.map((segment) => segment.text).join(''), source)

  const prose = segments.filter((segment) => segment.translate).map((segment) => segment.text).join('')
  const protectedSource = segments.filter((segment) => !segment.translate).map((segment) => segment.text).join('')
  assert.match(prose, /Translate this sentence/)
  assert.match(prose, /Translate this sentence too/)
  assert.ok(protectedSource.includes('<!-- translator note:'))
  assert.ok(protectedSource.includes('Do not translate this hidden annotation'))
  assert.ok(protectedSource.includes('{{runtime.value}}'))
  assert.equal(prose.includes('hidden annotation'), false)

  const unclosed = 'Translate this.\n<!-- unfinished comment\nprivate annotation'
  const unclosedSegments = markdownSegments(unclosed)
  assert.equal(unclosedSegments.map((segment) => segment.text).join(''), unclosed)
  assert.deepEqual(
    unclosedSegments.filter((segment) => segment.translate).map((segment) => segment.text),
    ['Translate this.\n'],
  )
})


test('Markdown segmentation preserves reference definition titles on following lines', () => {
  for (const newline of ['\n', '\r\n']) {
    const source = [
      '[guide]: https://example.test/guide',
      '  "Do not translate this continuation title"',
      '',
      'Read the [guide].',
      'Translate this paragraph.',
    ].join(newline)
    const segments = markdownSegments(source)
    assert.equal(segments.map((segment) => segment.text).join(''), source)
    const prose = segments.filter((segment) => segment.translate).map((segment) => segment.text).join('')
    const protectedSource = segments.filter((segment) => !segment.translate).map((segment) => segment.text).join('')
    assert.match(prose, /Read the/)
    assert.match(prose, /Translate this paragraph/)
    assert.ok(protectedSource.includes('"Do not translate this continuation title"'))
    assert.equal(prose.includes('continuation title'), false)
   }
})


test('Markdown segmentation handles CR-only line endings', () => {
  const newline = '\r'
  const fence = String.fromCharCode(96).repeat(3)
  const source = [
    '[guide]: https://example.test/guide',
    '  "Do not translate this title"',
    '',
    'Read the [guide].',
    fence + 'js',
    'const privateValue = "do not translate";',
    fence,
    'Translate this sentence.',
  ].join(newline)
  const segments = markdownSegments(source)
  assert.equal(segments.map((segment) => segment.text).join(''), source)
  const prose = segments.filter((segment) => segment.translate).map((segment) => segment.text).join('')
  const protectedSource = segments.filter((segment) => !segment.translate).map((segment) => segment.text).join('')
  assert.match(prose, /Read the/)
  assert.match(prose, /Translate this sentence/)
  assert.ok(protectedSource.includes('"Do not translate this title"'))
  assert.ok(protectedSource.includes(fence + 'js' + newline + 'const privateValue = "do not translate";'))
  assert.equal(prose.includes('privateValue'), false)
})
