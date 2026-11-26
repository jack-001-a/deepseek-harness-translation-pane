import { test } from 'node:test'
import assert from 'node:assert/strict'

import { jsonStringValueTokens, splitText } from '../src/host/text.js'

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
