import { test } from 'node:test'
import assert from 'node:assert/strict'

import { ProviderHealth, TokenBucket, TranslationCache } from '../src/host/runtime-state.js'

test('TranslationCache maintains LRU order and enforces entry/byte budgets', () => {
  const cache = new TranslationCache(2, 900)
  cache.set('first', { text: 'one' })
  cache.set('second', { text: 'two' })
  assert.equal(cache.get('first').text, 'one')
  cache.set('third', { text: 'three' })
  assert.equal(cache.size, 2)
  assert.equal(cache.get('second'), undefined)
  assert.equal(cache.get('first').text, 'one')
  assert.equal(cache.get('third').text, 'three')
})

test('TranslationCache does not retain an oversized translation', () => {
  const cache = new TranslationCache(10, 512)
  cache.set('large', { text: 'x'.repeat(1000) })
  assert.equal(cache.size, 0)
  assert.equal(cache.get('large'), undefined)
})

test('TranslationCache replaces an existing entry without double-counting bytes', () => {
  const cache = new TranslationCache(4, 2048)
  cache.set('key', { text: 'first value' })
  cache.set('key', { text: 'second value' })
  assert.equal(cache.size, 1)
  assert.equal(cache.get('key').text, 'second value')
})

test('TranslationCache.clear releases retained values and byte accounting', () => {
  const cache = new TranslationCache(4, 2048)
  cache.set('first', { text: 'private source result' })
  cache.set('second', { text: 'another private result' })
  assert.ok(cache.bytes > 0)
  cache.clear()
  assert.equal(cache.size, 0)
  assert.equal(cache.bytes, 0)
  assert.equal(cache.get('first'), undefined)
  cache.clear()
  assert.equal(cache.bytes, 0, 'clear is idempotent')
})

test('ProviderHealth tracks cooldown, recovery, provider set and reset', () => {
  const health = new ProviderHealth(1000, ['bing', 'google'])
  health.recordFailure('bing', 'provider-unreachable', 5000)
  assert.equal(health.isAvailable('bing', 5999), false)
  assert.equal(health.isAvailable('google', 5999), true)
  assert.deepEqual(health.snapshot(5999), {
    bing: { unreachable: true, until: new Date(6000).toISOString(), reason: 'provider-unreachable' },
    google: { unreachable: false },
  })
  assert.equal(health.isAvailable('bing', 6000), true)
  health.recordFailure('google', 'temporary', 7000)
  health.recordSuccess('google')
  assert.equal(health.isAvailable('google', 7000), true)
  health.recordFailure('bing', 'temporary', 8000)
  health.reset()
  assert.deepEqual(health.snapshot(8000), {
    bing: { unreachable: false },
    google: { unreachable: false },
  })
})

test('ProviderHealth with zero cooldown does not retain failures', () => {
  const health = new ProviderHealth(0, ['bing'])
  health.recordFailure('bing', 'temporary', 100)
  assert.equal(health.isAvailable('bing', 100), true)
  assert.deepEqual(health.snapshot(100), { bing: { unreachable: false } })
})

test('TokenBucket enforces capacity and continuous refill', () => {
  const bucket = new TokenBucket(2, 0)
  assert.equal(bucket.take(0), true)
  assert.equal(bucket.take(0), true)
  assert.equal(bucket.take(0), false)
  assert.equal(bucket.take(30000), true)
  assert.equal(bucket.take(30000), false)
  assert.equal(bucket.take(120000), true)
  assert.equal(bucket.take(120000), true)
  assert.equal(bucket.take(120000), false)
})

test('TokenBucket with zero rate refuses every request', () => {
  const bucket = new TokenBucket(0, 0)
  assert.equal(bucket.take(60000), false)
})
