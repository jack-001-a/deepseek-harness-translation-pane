import { test } from 'node:test'
import assert from 'node:assert/strict'

import { ProviderHealth, TokenBucket, TranslationCache } from '../src/host/runtime-state.js'

test('TranslationCache maintains least-recently-used eviction order', () => {
  const cache = new TranslationCache(2)
  cache.set('first', 'one')
  cache.set('second', 'two')

  assert.equal(cache.get('first'), 'one')
  cache.set('third', 'three')

  assert.equal(cache.size, 2)
  assert.equal(cache.get('second'), undefined, 'the least-recently-used entry is evicted')
  assert.equal(cache.get('first'), 'one')
  assert.equal(cache.get('third'), 'three')
})

test('TranslationCache with a zero limit does not retain entries', () => {
  const cache = new TranslationCache(0)
  cache.set('key', 'value')
  assert.equal(cache.size, 0)
  assert.equal(cache.get('key'), undefined)
})

test('ProviderHealth tracks cooldown, recovery and reset', () => {
  const health = new ProviderHealth(1000, ['bing', 'google'])
  health.recordFailure('bing', 'translation-pane/provider-unreachable', 5000)

  assert.equal(health.isAvailable('bing', 5999), false)
  assert.equal(health.isAvailable('google', 5999), true)
  assert.deepEqual(health.snapshot(5999), {
    bing: {
      unreachable: true,
      until: new Date(6000).toISOString(),
      reason: 'translation-pane/provider-unreachable',
    },
    google: { unreachable: false },
  })

  assert.equal(health.isAvailable('bing', 6000), true)
  assert.deepEqual(health.snapshot(6000), {
    bing: { unreachable: false },
    google: { unreachable: false },
  })

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

test('ProviderHealth with a zero cooldown does not retain failures', () => {
  const health = new ProviderHealth(0, ['bing'])
  health.recordFailure('bing', 'temporary', 100)
  assert.equal(health.isAvailable('bing', 100), true)
  assert.deepEqual(health.snapshot(100), { bing: { unreachable: false } })
})

test('TokenBucket enforces capacity and refills continuously', () => {
  const bucket = new TokenBucket(2, 0)

  assert.equal(bucket.take(0), true)
  assert.equal(bucket.take(0), true)
  assert.equal(bucket.take(0), false)

  assert.equal(bucket.take(30000), true, 'half a minute restores one token at 2 requests/minute')
  assert.equal(bucket.take(30000), false)

  assert.equal(bucket.take(120000), true)
  assert.equal(bucket.take(120000), true)
  assert.equal(bucket.take(120000), false, 'refill is capped at bucket capacity')
})

test('TokenBucket with a zero rate refuses every request', () => {
  const bucket = new TokenBucket(0, 0)
  assert.equal(bucket.take(60000), false)
})
