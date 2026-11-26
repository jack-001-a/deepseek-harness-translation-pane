/**
 * Host-half tests for @ybbmm/dsh-translation-pane.
 *
 * These run against the real module with a fake Cordis context and a fake
 * `globalThis.fetch`, so they pin down the splitter's fidelity, the language
 * handling, the error codes the browser localizes, the retry and rate-limit
 * policies, the cache and the coalescing, and the Remote marker the API
 * Gateway reads — without a running Harness.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { apply, resolveConfig, splitText, normalizeLanguage, providerLanguage } from '../index.js'

const REMOTE_METHODS = '@deepseek-ai/dsh-typert-protocol/remote-methods'

/**
 * Build a fake Cordis context around the plugin's real apply().
 * @param options - per-test overrides: `config`, `translator`, `fetch`.
 * @returns the captured service, the registered tools and every call.
 */
function harness(options = {}) {
  const services = new Map()
  const effects = []
  const tools = []
  const logs = { debug: [], warn: [] }
  const ctx = {
    get: (name) => services.get(name),
    logger: {
      debug: (message) => logs.debug.push(message),
      warn: (message) => logs.warn.push(message),
    },
    reflect: {
      provide: (name, value) => {
        services.set(name, value)
      },
    },
    effect: (setup) => {
      effects.push(setup())
    },
    tools: {
      register: (tool) => {
        tools.push(tool)
        return () => {}
      },
    },
  }
  if (options.translator !== undefined) services.set('translator', options.translator)

  apply(ctx, options.config)

  const service = services.get('translationPane')
  assert.ok(service, 'apply() must provide the translationPane service')
  return {
    ctx,
    service,
    tools,
    logs,
    /** Run every disposer the plugin registered, as an unload would. */
    unload: async () => {
      for (const dispose of effects) await dispose()
    },
  }
}

/**
 * A shipped-translator stand-in.
 * @param overrides - fields to replace on the fake service.
 * @returns the fake translator service.
 */
function fakeTranslator(overrides = {}) {
  return {
    maxTextChars: overrides.maxTextChars ?? 4000,
    resolve:
      overrides.resolve ??
      ((request) => ({
        text: request.text,
        targetLanguage: request.targetLanguage,
        sourceLanguage: request.sourceLanguage ?? 'auto',
        provider: request.provider ?? 'bing',
      })),
    translate: overrides.translate ?? (async (spec) => `[${spec.provider}] ${spec.text}`),
  }
}

/**
 * A JSON response like the anonymous endpoints send.
 * @param payload - the body to serialize.
 * @param init - status and headers.
 * @returns the response.
 */
function jsonResponse(payload, init = {}) {
  return new Response(JSON.stringify(payload), {
    status: init.status ?? 200,
    headers: { 'content-type': 'application/json', ...(init.headers ?? {}) },
  })
}

/**
 * Install a fake `globalThis.fetch`.
 * @param handler - the fake fetch implementation.
 * @param t - the running test, for cleanup.
 */
function mockFetch(handler, t) {
  const original = globalThis.fetch
  globalThis.fetch = handler
  t.after(() => {
    globalThis.fetch = original
  })
}

/**
 * A Bing-shaped translation payload.
 * @param text - the translated text.
 * @returns the payload.
 */
function bingPayload(text) {
  return [{ translations: [{ text }] }]
}

test('splitter: the fragments reproduce the source exactly', () => {
  const sources = [
    'short',
    'a'.repeat(5000),
    'First paragraph.\n\nSecond paragraph.\n\nThird paragraph that is quite long and keeps going for a while.',
    'Line one\nLine two\nLine three\nLine four\nLine five\nLine six\nLine seven\nLine eight\n',
    'One sentence. Two sentence. Three sentence. Four sentence. Five sentence. Six sentence.',
    'word '.repeat(2000),
    'no separators at all just a very long run of characters '.repeat(60),
    'trailing break\n\n',
    '。'.repeat(3000),
  ]
  for (const source of sources) {
    for (const maxChars of [16, 64, 300, 3000]) {
      const fragments = splitText(source, maxChars)
      assert.equal(
        fragments.join(''),
        source,
        `fragments must reproduce the source (maxChars=${maxChars})`,
      )
      for (const fragment of fragments) {
        assert.ok(fragment.length <= maxChars, 'no fragment may exceed the request size')
      }
    }
  }
})

test('splitter: the coarse boundaries are preferred', () => {
  const source = `${'x'.repeat(40)}\n\n${'y'.repeat(40)}\n\n${'z'.repeat(40)}`
  const fragments = splitText(source, 60)
  assert.ok(fragments.length > 1)
  assert.ok(fragments[0].endsWith('\n\n'), 'a paragraph break must close a fragment')
  assert.equal(fragments.join(''), source)
})

test('splitter: a text inside the request size is one fragment', () => {
  assert.deepEqual(splitText('hello', 100), ['hello'])
  assert.deepEqual(splitText('', 100), [''])
})

test('splitter: a hard cut never splits a surrogate pair', () => {
  const source = `${'x'.repeat(9)}😀${'y'.repeat(20)}`
  for (const maxChars of [10, 11, 12]) {
    const fragments = splitText(source, maxChars)
    assert.equal(fragments.join(''), source, 'the fragments must reproduce the source')
    for (const fragment of fragments) {
      assert.equal(
        /[\uD800-\uDBFF]$/.test(fragment),
        false,
        'a fragment must not end in a lone high surrogate',
      )
      assert.equal(
        /^[\uDC00-\uDFFF]/.test(fragment),
        false,
        'a fragment must not start with a lone low surrogate',
      )
      assert.ok(fragment.length <= maxChars, 'no fragment may exceed the request size')
    }
  }
})

test('language: the Chinese tags follow the shipped normalization', () => {
  assert.equal(providerLanguage('zh-Hans', 'bing'), 'zh-Hans')
  assert.equal(providerLanguage('zh-CN', 'bing'), 'zh-Hans')
  assert.equal(providerLanguage('zh-SG', 'bing'), 'zh-Hans')
  assert.equal(providerLanguage('zh', 'bing'), 'zh-Hans')
  assert.equal(providerLanguage('zh-Hant', 'bing'), 'zh-Hant')
  assert.equal(providerLanguage('zh-TW', 'bing'), 'zh-Hant')
  assert.equal(providerLanguage('zh-HK', 'bing'), 'zh-Hant')
  assert.equal(providerLanguage('zh-CN', 'google'), 'zh-CN')
  assert.equal(providerLanguage('zh-Hans', 'google'), 'zh-CN')
  assert.equal(providerLanguage('zh-TW', 'google'), 'zh-TW')
  assert.equal(providerLanguage('zh-Hant', 'google'), 'zh-TW')
  assert.equal(providerLanguage('en', 'bing'), 'en')
  assert.equal(providerLanguage('pt-BR', 'google'), 'pt-BR')
})

test('language: a hostile tag is refused instead of reaching the URL', () => {
  assert.throws(() => normalizeLanguage('en&to=xx', 'auto', true), (error) => {
    assert.equal(error.code, 'translation-pane/invalid-request')
    assert.equal(error.isDSHRemoteError, true)
    return true
  })
  assert.throws(() => normalizeLanguage('a b', 'auto', true), /not a usable language tag/)
  assert.equal(normalizeLanguage('auto', 'auto', true), 'auto')
  assert.equal(normalizeLanguage(undefined, 'auto', true), 'auto')
  assert.equal(normalizeLanguage('  ', 'auto', true), 'auto')
  assert.throws(() => normalizeLanguage('auto', 'zh-Hans', false), /cannot be "auto"/)
})

test('config: the defaults are the documented ones', () => {
  const config = resolveConfig(undefined)
  assert.equal(config.bingEndpoint, 'https://edge.microsoft.com/translate/translatetext')
  assert.equal(config.googleEndpoint, 'https://translate.googleapis.com/translate_a/single')
  assert.equal(config.timeoutMs, 20000)
  assert.equal(config.attemptTimeoutMs, 3000)
  assert.equal(config.providerCooldownMs, 300000)
  assert.equal(config.failover, true)
  assert.equal(config.maxTextChars, 20000)
  assert.equal(config.fragmentChars, 3000)
  assert.equal(config.maxRetries, 2)
  assert.equal(config.retryBaseMs, 250)
  assert.equal(config.retryMaxMs, 4000)
  assert.equal(config.maxResponseBytes, 1024 * 1024)
  assert.equal(config.cacheSize, 64)
  assert.equal(config.cacheMaxBytes, 8 * 1024 * 1024)
  assert.equal(config.rateLimitPerMinute, 60)
  assert.equal(config.maxConcurrency, 3)
  assert.equal(config.maxQueuedRequests, 24)
})

test('config: sensible overrides are accepted and unusable values fall back', () => {
  const config = resolveConfig({
    bingEndpoint: 'https://example.test/translate',
    googleEndpoint: 'https://example.test/google',
    timeoutMs: 1234,
    attemptTimeoutMs: 500,
    providerCooldownMs: 5000,
    failover: false,
    maxTextChars: 500,
    fragmentChars: 100,
    maxRetries: 0,
    cacheSize: 0,
    cacheMaxBytes: 2048,
    rateLimitPerMinute: 5,
    maxConcurrency: 7,
    maxResponseBytes: 2048,
  })
  assert.equal(config.bingEndpoint, 'https://example.test/translate')
  assert.equal(config.googleEndpoint, 'https://example.test/google')
  assert.equal(config.timeoutMs, 1234)
  assert.equal(config.attemptTimeoutMs, 500)
  assert.equal(config.providerCooldownMs, 5000)
  assert.equal(config.failover, false)
  assert.equal(config.maxTextChars, 500)
  assert.equal(config.fragmentChars, 100)
  assert.equal(config.maxRetries, 0)
  assert.equal(config.cacheSize, 0)
  assert.equal(config.cacheMaxBytes, 2048)
  assert.equal(config.rateLimitPerMinute, 5)
  assert.equal(config.maxConcurrency, 7)
  assert.equal(config.maxResponseBytes, 2048)

  const fractional = resolveConfig({
    timeoutMs: 0.5,
    attemptTimeoutMs: 0.5,
    providerCooldownMs: 0.5,
    maxTextChars: 0.5,
    fragmentChars: 0.5,
    maxRetries: 0.5,
    retryBaseMs: 0.5,
    retryMaxMs: 0.5,
    maxResponseBytes: 0.5,
    cacheSize: 0.5,
    rateLimitPerMinute: 0.5,
    maxConcurrency: 0.5,
  })
  assert.equal(fractional.timeoutMs, 20000)
  assert.equal(fractional.attemptTimeoutMs, 3000)
  assert.equal(fractional.providerCooldownMs, 300000)
  assert.equal(fractional.maxTextChars, 20000)
  assert.equal(fractional.fragmentChars, 3000)
  assert.equal(fractional.maxRetries, 2)
  assert.equal(fractional.retryBaseMs, 250)
  assert.equal(fractional.retryMaxMs, 4000)
  assert.equal(fractional.maxResponseBytes, 1024 * 1024)
  assert.equal(fractional.cacheSize, 64)
  assert.equal(fractional.rateLimitPerMinute, 60)
  assert.equal(fractional.maxConcurrency, 3)

  const broken = resolveConfig({
    bingEndpoint: 'not a url',
    timeoutMs: -1,
    attemptTimeoutMs: -5,
    providerCooldownMs: 'soon',
    failover: 'yes please',
    maxTextChars: 'many',
    maxRetries: -3,
    rateLimitPerMinute: 0,
    cacheMaxBytes: -1,
  })
  assert.equal(broken.bingEndpoint, 'https://edge.microsoft.com/translate/translatetext')
  assert.equal(broken.timeoutMs, 20000)
  assert.equal(broken.attemptTimeoutMs, 3000)
  assert.equal(broken.providerCooldownMs, 300000)
  assert.equal(broken.failover, true)
  assert.equal(broken.maxTextChars, 20000)
  assert.equal(broken.maxRetries, 2)
  assert.equal(broken.rateLimitPerMinute, 60)
  assert.equal(broken.cacheMaxBytes, 8 * 1024 * 1024)

  // One attempt can never outlive the whole request.
  assert.equal(resolveConfig({ timeoutMs: 800, attemptTimeoutMs: 5000 }).attemptTimeoutMs, 800)
  // A zero cooldown turns the observation window off without touching failover.
  assert.equal(resolveConfig({ providerCooldownMs: 0 }).providerCooldownMs, 0)
})

test('config: timer delays stay within Node\'s supported timeout range', () => {
  const config = resolveConfig({
    timeoutMs: 3_000_000_000,
    attemptTimeoutMs: 3_000_000_000,
    retryBaseMs: 3_000_000_000,
    retryMaxMs: 4_000_000_000,
  })
  assert.equal(config.timeoutMs, 2_147_483_647)
  assert.equal(config.attemptTimeoutMs, 2_147_483_647)
  assert.equal(config.retryBaseMs, 2_147_483_647)
  assert.equal(config.retryMaxMs, 2_147_483_647)
})

test('config: provider endpoints reject credentials and URL fragments', () => {
  const config = resolveConfig({
    bingEndpoint: 'https://user:password@example.test/translate',
    googleEndpoint: 'https://example.test/google#fragment',
  })
  assert.equal(config.bingEndpoint, 'https://edge.microsoft.com/translate/translatetext')
  assert.equal(config.googleEndpoint, 'https://translate.googleapis.com/translate_a/single')
})

test('describe: it reports the routing facts the browser needs', () => {
  const h = harness()
  const described = h.service.describe()
  assert.deepEqual(Object.keys(described).sort(), [
    'activeRequests',
    'cacheEntries',
    'cacheHits',
    'cacheMisses',
    'failover',
    'fragmentChars',
    'languages',
    'maxConcurrency',
    'maxQueuedRequests',
    'maxRetries',
    'maxTextChars',
    'providerHealth',
    'providers',
    'queuedRequests',
    'rateLimitPerMinute',
    'route',
  ])
  assert.equal(described.route, 'direct')
  assert.deepEqual(described.providers, ['bing', 'google'])
  assert.ok(described.languages.includes('zh-Hans'))
  assert.equal(described.maxTextChars, 20000)
  assert.equal(described.fragmentChars, 3000)
  assert.equal(described.maxRetries, 2)
  assert.equal(described.rateLimitPerMinute, 60)
  assert.equal(described.maxConcurrency, 3)
  assert.equal(described.maxQueuedRequests, 24)
  assert.equal(described.activeRequests, 0)
  assert.equal(described.queuedRequests, 0)
  assert.equal(described.cacheEntries, 0)
  assert.equal(described.cacheHits, 0)
  assert.equal(described.cacheMisses, 0)
  assert.equal(described.failover, true)
  // Plain, serializable facts; nothing has failed yet.
  assert.deepEqual(described.providerHealth, {
    bing: { unreachable: false },
    google: { unreachable: false },
  })
})

test('describe: the shipped translator changes the route', () => {
  const h = harness({ translator: fakeTranslator() })
  const described = h.service.describe()
  assert.equal(described.route, 'translator')
  assert.deepEqual(described.providers, ['bing', 'google'])
  // The shipped service owns its own routing, so the pane observes no
  // direct-provider health and cannot fail over itself.
  assert.deepEqual(described.providerHealth, {})
  assert.equal(described.failover, false)
})

test('translate: the direct route sends the shipped Bing request shape', async (t) => {
  const calls = []
  mockFetch(async (url, init) => {
    calls.push({ url: String(url), init })
    return jsonResponse(bingPayload('你好'))
  }, t)

  const h = harness()
  const result = await h.service.translate({ text: 'hello', targetLanguage: 'zh-Hans' })

  assert.equal(result.text, '你好')
  assert.equal(result.sourceLanguage, 'auto')
  assert.equal(result.targetLanguage, 'zh-Hans')
  assert.equal(result.provider, 'bing')
  assert.equal(result.cached, false)
  assert.equal(typeof result.durationMs, 'number')
  assert.equal(calls.length, 1)
  const url = new URL(calls[0].url)
  assert.equal(url.origin + url.pathname, 'https://edge.microsoft.com/translate/translatetext')
  assert.equal(url.searchParams.get('to'), 'zh-Hans')
  assert.equal(url.searchParams.get('isEnterpriseClient'), 'false')
  assert.equal(url.searchParams.get('from'), null, 'auto must not name a source')
  assert.equal(calls[0].init.method, 'POST')
  assert.equal(calls[0].init.body, JSON.stringify(['hello']))
  assert.equal(calls[0].init.headers['content-type'], 'application/json')
  assert.equal(calls[0].init.credentials, 'omit')
  assert.equal(calls[0].init.redirect, 'error')
})

test('translate: the direct route sends the shipped Google request shape', async (t) => {
  const calls = []
  mockFetch(async (url, init) => {
    calls.push({ url: String(url), init })
    return jsonResponse([[['你好', 'hello', null, null, 10]], null, 'en'])
  }, t)

  const h = harness()
  const result = await h.service.translate({
    text: 'hello',
    targetLanguage: 'zh-CN',
    provider: 'google',
  })

  assert.equal(result.text, '你好')
  assert.equal(result.provider, 'google')
  assert.equal(result.detectedSourceLanguage, 'en')
  const form = new URLSearchParams(calls[0].init.body)
  assert.equal(form.get('client'), 'gtx')
  assert.equal(form.get('sl'), 'auto')
  assert.equal(form.get('tl'), 'zh-CN')
  assert.equal(form.get('dt'), 't')
  assert.equal(form.get('q'), 'hello')
  assert.equal(calls[0].init.headers['content-type'], 'application/x-www-form-urlencoded')
})

test('translate: a named source is reported as requested', async (t) => {
  mockFetch(async () => jsonResponse([[['你好', 'hello', null, null, 10]], null, 'en']), t)
  const h = harness()
  const result = await h.service.translate({
    text: 'hello',
    targetLanguage: 'zh-Hans',
    sourceLanguage: 'en',
    provider: 'google',
  })
  assert.equal(result.sourceLanguage, 'en')
  assert.equal(result.detectedSourceLanguage, undefined, 'a named source needs no detection')
})

test('translate: long text is split and the fragments are rejoined in order', async (t) => {
  const bodies = []
  mockFetch(async (_url, init) => {
    bodies.push(JSON.parse(init.body)[0])
    return jsonResponse(bingPayload(`[${bodies.length}]`))
  }, t)

  const h = harness({ config: { fragmentChars: 100 } })
  const source = `${'a'.repeat(60)}\n\n${'b'.repeat(60)}\n\n${'c'.repeat(60)}`
  const result = await h.service.translate({ text: source, targetLanguage: 'zh-Hans' })

  assert.equal(bodies.length, 3)
  // The separator stays with the fragment it closes, so the fragments add up
  // to the source exactly.
  assert.deepEqual(
    bodies.map((body) => body.length),
    [62, 62, 60],
  )
  assert.equal(bodies.join(''), source)
  assert.equal(result.text, '[1][2][3]')
})

test('translate: an emoji exactly on the fragment boundary reaches every provider intact', async (t) => {
  const bodies = []
  mockFetch(async (_url, init) => {
    bodies.push(JSON.parse(init.body)[0])
    return jsonResponse(bingPayload('x'))
  }, t)

  const h = harness({ config: { fragmentChars: 3000 } })
  // The high surrogate sits exactly where a 3000-unit fragment would end.
  const source = `${'x'.repeat(2999)}😀${'y'.repeat(100)}`
  const result = await h.service.translate({ text: source, targetLanguage: 'en' })

  assert.ok(bodies.length >= 2)
  assert.equal(bodies.join(''), source, 'the fragments must round-trip the emoji')
  for (const body of bodies) {
    assert.equal(/[\uD800-\uDBFF]$/.test(body), false, 'no fragment may end in a lone surrogate')
    assert.equal(/^[\uDC00-\uDFFF]/.test(body), false, 'no fragment may start with a lone surrogate')
  }
  assert.equal(result.text, 'x'.repeat(bodies.length))
})

test('translate: an empty text needs no provider', async (t) => {
  let calls = 0
  mockFetch(async () => {
    calls += 1
    return jsonResponse(bingPayload(''))
  }, t)
  const h = harness()
  const result = await h.service.translate({ text: '   ', targetLanguage: 'zh-Hans' })
  assert.equal(result.text, '')
  assert.equal(result.provider, 'none')
  assert.equal(calls, 0)
})

test('translate: the shipped translator route is preferred and gets the signal', async (t) => {
  const seen = []
  const translator = fakeTranslator({
    translate: async (spec, signal) => {
      seen.push({ spec, signal })
      return '译文'
    },
  })
  mockFetch(async () => {
    throw new Error('the direct route must not be used')
  }, t)

  const h = harness({ translator })
  const controller = new AbortController()
  const result = await h.service.translateRequest(
    { text: 'hello', targetLanguage: 'zh-Hans' },
    controller.signal,
  )

  assert.equal(result.text, '译文')
  assert.equal(result.provider, 'bing')
  assert.equal(seen.length, 1)
  assert.equal(seen[0].spec.text, 'hello')
  assert.ok(seen[0].signal, 'the translator must receive a signal')
})

test('translate: the shipped translator route splits long text by its own limit', async (t) => {
  const sizes = []
  const translator = fakeTranslator({
    maxTextChars: 50,
    translate: async (spec) => {
      sizes.push(spec.text.length)
      return 'x'
    },
  })
  mockFetch(async () => {
    throw new Error('the direct route must not be used')
  }, t)

  const h = harness({ translator })
  await h.service.translate({ text: 'a'.repeat(120), targetLanguage: 'zh-Hans' })
  assert.deepEqual(sizes, [50, 50, 20])
})

test('translate: the shipped translator keeps its own provider default', async (t) => {
  const seen = []
  const translator = fakeTranslator({
    resolve: (request) => ({
      ...request,
      provider: request.provider ?? 'google',
    }),
    translate: async (spec) => {
      seen.push(spec)
      return 'ok'
    },
  })
  mockFetch(async () => {
    throw new Error('the direct route must not be used')
  }, t)

  const h = harness({ translator })
  const result = await h.service.translate({ text: 'hi', targetLanguage: 'en' })
  assert.equal(result.provider, 'google', 'the provider that answered must be reported')
  assert.equal(seen[0].provider, 'google')
})

test('wire: the nested and the flat request shapes both translate', async (t) => {
  const bodies = []
  mockFetch(async (_url, init) => {
    bodies.push(JSON.parse(init.body)[0])
    return jsonResponse(bingPayload('你好'))
  }, t)

  const h = harness()
  // The API Gateway derives the wire fields from the method's parameter
  // names, so both shapes must reach the same code path.
  const nested = await h.service.translate({ text: 'one', targetLanguage: 'zh-Hans' })
  const flat = await h.service.translate(undefined, 'two', 'zh-Hans', 'auto', 'bing')
  const enveloped = await h.service.translate({ request: { text: 'three', targetLanguage: 'zh-Hans' } })

  assert.equal(nested.text, '你好')
  assert.equal(flat.text, '你好')
  assert.equal(enveloped.text, '你好')
  assert.deepEqual(bodies, ['one', 'two', 'three'])
})

test('errors: the stable codes cross the wire', async (t) => {
  mockFetch(async () => jsonResponse(bingPayload('x')), t)
  const h = harness()

  await assert.rejects(h.service.translate({ text: 'hi', targetLanguage: 'en&x=1' }), (error) => {
    assert.equal(error.code, 'translation-pane/invalid-request')
    assert.equal(error.isDSHRemoteError, true)
    return true
  })
  await assert.rejects(
    h.service.translate({ text: 'x'.repeat(20001), targetLanguage: 'en' }),
    (error) => error.code === 'translation-pane/text-limit',
  )
  await assert.rejects(
    h.service.translate({ text: 'hi', targetLanguage: 'en', provider: 'deepl' }),
    (error) => {
      assert.equal(error.code, 'translation-pane/provider-unavailable')
      assert.equal(error.details.provider, 'deepl')
      return true
    },
  )
})

test('errors: the provider failures are classified', async (t) => {
  const h = harness({ config: { maxRetries: 0 } })

  mockFetch(async () => jsonResponse({}, { status: 400 }), t)
  await assert.rejects(
    h.service.translate({ text: 'hi', targetLanguage: 'en' }),
    (error) => {
      assert.equal(error.code, 'translation-pane/provider-error')
      assert.equal(error.details.status, 400)
      return true
    },
  )

  mockFetch(async () => {
    throw new TypeError('fetch failed')
  }, t)
  await assert.rejects(
    h.service.translate({ text: 'hi', targetLanguage: 'en' }),
    (error) => {
      // A provider the Host cannot reach is not the same failure as the
      // Harness losing its Host, so it must not reuse the carrier's code.
      assert.equal(error.code, 'translation-pane/provider-unreachable')
      assert.equal(error.isDSHRemoteError, true)
      return true
    },
  )

  mockFetch(async () => new Response('not json', { status: 200 }), t)
  await assert.rejects(
    h.service.translate({ text: 'hi', targetLanguage: 'en' }),
    (error) => error.code === 'translation-pane/invalid-response',
  )

  mockFetch(async () => jsonResponse([{}]), t)
  await assert.rejects(
    h.service.translate({ text: 'hi', targetLanguage: 'en' }),
    (error) => error.code === 'translation-pane/invalid-response',
  )
})

test('errors: the shipped translator failures are mapped onto the pane codes', async (t) => {
  mockFetch(async () => jsonResponse(bingPayload('x')), t)
  const cases = [
    ['TRANSLATION_TEXT_LIMIT', 'translation-pane/text-limit'],
    ['TRANSLATION_TIMEOUT', 'translation-pane/timeout'],
    ['TRANSLATION_SESSION_REQUIRED', 'translation-pane/provider-unavailable'],
    ['TRANSLATION_UNAVAILABLE', 'translation-pane/provider-unavailable'],
    ['TRANSLATION_INVALID_RESPONSE', 'translation-pane/invalid-response'],
    ['TRANSLATION_REQUEST_FAILED', 'translation-pane/provider-unreachable'],
    ['TRANSLATION_HTTP_ERROR', 'translation-pane/provider-error'],
  ]
  for (const [upstream, expected] of cases) {
    const error = new Error('upstream')
    error.code = upstream
    const translator = fakeTranslator({
      translate: async () => {
        throw error
      },
    })
    const h = harness({ translator })
    await assert.rejects(
      h.service.translate({ text: 'hi', targetLanguage: 'en' }),
      (failure) => {
        assert.equal(failure.code, expected, `${upstream} must map onto ${expected}`)
        assert.equal(failure.details.upstream, upstream)
        return true
      },
    )
  }
})

test('retry: a 5xx is retried with an exponential back-off', async (t) => {
  let attempts = 0
  mockFetch(async () => {
    attempts += 1
    if (attempts < 3) return jsonResponse({}, { status: 503 })
    return jsonResponse(bingPayload('ok'))
  }, t)

  // Pinned to a single-provider route: with an alternate provider available
  // the failover is the retry, which the failover tests cover separately.
  const h = harness({
    config: { failover: false, maxRetries: 2, retryBaseMs: 20, retryMaxMs: 1000, jitter: () => 1 },
  })
  const delays = []
  const realSleep = h.service.sleep.bind(h.service)
  h.service.sleep = async (ms, signal) => {
    delays.push(ms)
    return realSleep(ms, signal)
  }

  const result = await h.service.translate({ text: 'hi', targetLanguage: 'en' })
  assert.equal(result.text, 'ok')
  assert.equal(attempts, 3)
  assert.deepEqual(delays, [20, 40], 'the back-off doubles per attempt')
})

test('retry: a 4xx other than 429 is never retried', async (t) => {
  let attempts = 0
  mockFetch(async () => {
    attempts += 1
    return jsonResponse({}, { status: 404 })
  }, t)

  const h = harness({ config: { failover: false, maxRetries: 3, retryBaseMs: 1 } })
  await assert.rejects(
    h.service.translate({ text: 'hi', targetLanguage: 'en' }),
    (error) => error.code === 'translation-pane/provider-error',
  )
  assert.equal(attempts, 1)
})

test('retry: a 429 is retried and the Retry-After header is honoured', async (t) => {
  let attempts = 0
  mockFetch(async () => {
    attempts += 1
    if (attempts < 2) return jsonResponse({}, { status: 429, headers: { 'retry-after': '1' } })
    return jsonResponse(bingPayload('ok'))
  }, t)

  const h = harness({ config: { failover: false, maxRetries: 2, retryMaxMs: 500 } })
  const delays = []
  h.service.sleep = async (ms) => {
    delays.push(ms)
  }

  const result = await h.service.translate({ text: 'hi', targetLanguage: 'en' })
  assert.equal(result.text, 'ok')
  assert.equal(attempts, 2)
  assert.deepEqual(
    delays,
    [1000],
    'the Retry-After hint takes precedence even when it exceeds retryMaxMs',
  )
})

test('retry: malformed Retry-After values use bounded exponential back-off', async (t) => {
  let retryAfter = '-1'
  let attempts = 0
  mockFetch(async () => {
    attempts += 1
    if (attempts === 1) {
      return jsonResponse({}, { status: 429, headers: { 'retry-after': retryAfter } })
    }
    return jsonResponse(bingPayload('ok'))
  }, t)

  const h = harness({
    config: { failover: false, maxRetries: 1, retryBaseMs: 100, retryMaxMs: 1000, jitter: () => 1 },
  })
  const delays = []
  h.service.sleep = async (ms) => {
    delays.push(ms)
  }

  for (const malformed of [
    '-1',
    '1.5',
    '+2',
    '1e3',
    '0x10',
    'Thursday, 21-Oct-50 07:28:00 GMT',
    'Fri, 31 Feb 2099 07:28:00 GMT',
  ]) {
    retryAfter = malformed
    attempts = 0
    delays.length = 0
    const result = await h.service.translate({ text: 'malformed ' + malformed, targetLanguage: 'en' })
    assert.equal(result.text, 'ok')
    assert.equal(attempts, 2, 'one retry should be made for ' + malformed)
    assert.deepEqual(delays, [100], malformed + ' must not be interpreted as a delay or date')
  }
})

test('retry: overflowing but valid decimal Retry-After hints stay within the configured cap', async (t) => {
  let attempts = 0
  mockFetch(async () => {
    attempts += 1
    if (attempts === 1) {
      // This parses as a finite Number, but multiplying by 1000 would overflow.
      return jsonResponse({}, { status: 429, headers: { 'retry-after': '9'.repeat(308) } })
    }
    return jsonResponse(bingPayload('ok'))
  }, t)

  const h = harness({
    config: { failover: false, maxRetries: 1, retryBaseMs: 100, retryMaxMs: 1000, jitter: () => 1 },
  })
  const delays = []
  h.service.sleep = async (ms) => {
    delays.push(ms)
  }

  const result = await h.service.translate({ text: 'large delay-seconds', targetLanguage: 'en' })
  assert.equal(result.text, 'ok')
  assert.equal(attempts, 2)
  assert.deepEqual(delays, [2_147_483_647])
})

test('retry: RFC 850 dates more than 50 years ahead map to the most recent past year', async (t) => {
  let attempts = 0
  mockFetch(async () => {
    attempts += 1
    if (attempts === 1) {
      return jsonResponse({}, { status: 429, headers: { 'retry-after': 'Friday, 21-Oct-77 07:28:00 GMT' } })
    }
    return jsonResponse(bingPayload('ok'))
  }, t)

  const h = harness({
    config: { failover: false, maxRetries: 1, retryBaseMs: 100, retryMaxMs: 5000, jitter: () => 1 },
  })
  const delays = []
  h.service.sleep = async (ms) => {
    delays.push(ms)
  }

  const result = await h.service.translate({ text: 'RFC 850 past-century date', targetLanguage: 'en' })
  assert.equal(result.text, 'ok')
  assert.equal(attempts, 2)
  assert.deepEqual(
    delays,
    [0],
    '2077 is more than 50 years ahead in 2026, so the RFC 850 year must be interpreted as 1977',
  )
})

test('retry: valid HTTP-date forms are honoured as Retry-After values', async (t) => {
  let retryAfter = 'Wed, 21 Oct 2099 07:28:00 GMT'
  let attempts = 0
  mockFetch(async () => {
    attempts += 1
    if (attempts === 1) {
      return jsonResponse({}, { status: 429, headers: { 'retry-after': retryAfter } })
    }
    return jsonResponse(bingPayload('ok'))
  }, t)

  const h = harness({
    config: { failover: false, maxRetries: 1, retryBaseMs: 100, retryMaxMs: 5000, jitter: () => 1 },
  })
  const delays = []
  h.service.sleep = async (ms) => {
    delays.push(ms)
  }

  for (const [index, date] of [
    [0, 'Wed, 21 Oct 2099 07:28:00 GMT'],
    [1, 'Thursday, 21-Oct-49 07:28:00 GMT'],
    // A two-digit year still in the 50-year window maps to this century.
    [2, 'Friday, 21-Oct-50 07:28:00 GMT'],
    [3, 'Wed Oct 21 07:28:00 2099'],
  ]) {
    retryAfter = date
    attempts = 0
    delays.length = 0
    const result = await h.service.translate({ text: 'valid date ' + index, targetLanguage: 'en' })
    assert.equal(result.text, 'ok')
    assert.equal(attempts, 2)
    assert.deepEqual(delays, [2_147_483_647], date + ' should be capped by the platform timer maximum')
  }
})


test('retry: the budget is bounded', async (t) => {
  let attempts = 0
  mockFetch(async () => {
    attempts += 1
    return jsonResponse({}, { status: 500 })
  }, t)

  const h = harness({ config: { failover: false, maxRetries: 2, retryBaseMs: 1 } })
  h.service.sleep = async () => {}
  await assert.rejects(
    h.service.translate({ text: 'hi', targetLanguage: 'en' }),
    (error) => {
      assert.equal(error.code, 'translation-pane/provider-error')
      assert.equal(error.details.status, 500)
      return true
    },
  )
  assert.equal(attempts, 3, 'the first attempt plus two retries')
})

test('response: an oversized body is refused', async (t) => {
  mockFetch(async () => jsonResponse(bingPayload('x'.repeat(500))), t)
  const h = harness({ config: { maxResponseBytes: 64 } })
  await assert.rejects(
    h.service.translate({ text: 'hi', targetLanguage: 'en' }),
    (error) => {
      assert.equal(error.code, 'translation-pane/invalid-response')
      assert.equal(error.details.limit, 64)
      return true
    },
  )
})

test('cache: an identical demand is served from the cache', async (t) => {
  let calls = 0
  mockFetch(async () => {
    calls += 1
    return jsonResponse(bingPayload('ok'))
  }, t)

  const h = harness()
  const first = await h.service.translate({ text: 'hi', targetLanguage: 'en' })
  const second = await h.service.translate({ text: 'hi', targetLanguage: 'en' })

  assert.equal(calls, 1, 'the second demand must not reach the provider')
  assert.equal(first.cached, false)
  assert.equal(second.cached, true)
  assert.equal(second.text, 'ok')
  const described = h.service.describe()
  assert.equal(described.cacheHits, 1)
  assert.equal(described.cacheMisses, 1)
  assert.equal(described.cacheEntries, 1)
})



test('cache: an already-aborted caller cannot receive a cached result', async (t) => {
  let calls = 0
  mockFetch(async () => {
    calls += 1
    return jsonResponse(bingPayload('ok'))
  }, t)

  const h = harness()
  await h.service.translate({ text: 'hi', targetLanguage: 'en' })
  const controller = new AbortController()
  controller.abort(new Error('the caller no longer wants this result'))

  await assert.rejects(
    h.service.translateRequest({ text: 'hi', targetLanguage: 'en' }, controller.signal),
    (error) => error.message === 'the caller no longer wants this result',
  )
  assert.equal(calls, 1, 'an aborted cache hit must not reach the provider')
  assert.equal(h.service.describe().cacheHits, 0, 'an aborted demand must not be counted as a cache hit')
})

test('cache: the cache is bounded', async (t) => {
  mockFetch(async (_url, init) => jsonResponse(bingPayload(JSON.parse(init.body)[0])), t)
  const h = harness({ config: { cacheSize: 2 } })
  await h.service.translate({ text: 'one', targetLanguage: 'en' })
  await h.service.translate({ text: 'two', targetLanguage: 'en' })
  await h.service.translate({ text: 'three', targetLanguage: 'en' })
  assert.equal(h.service.describe().cacheEntries, 2)
})

test('cache: retained entries obey the UTF-8 byte budget as well as the entry limit', async (t) => {
  let calls = 0
  mockFetch(async (_url, init) => {
    calls += 1
    return jsonResponse(bingPayload(JSON.parse(init.body)[0]))
  }, t)

  const h = harness({ config: { cacheSize: 10, cacheMaxBytes: 1100 } })
  const first = 'a'.repeat(200)
  const second = 'b'.repeat(200)

  await h.service.translate({ text: first, targetLanguage: 'en' })
  assert.ok(h.service.cache.bytes <= 1100)

  await h.service.translate({ text: second, targetLanguage: 'en' })
  assert.equal(h.service.cache.size, 1, 'the older entry should be evicted to stay within the byte budget')
  assert.ok(h.service.cache.bytes <= 1100)

  await h.service.translate({ text: first, targetLanguage: 'en' })
  assert.equal(calls, 3, 'the evicted translation must be fetched again')
  assert.ok(h.service.cache.bytes <= 1100)
})

test('cache: a single entry larger than the byte budget is never retained', async (t) => {
  let calls = 0
  mockFetch(async (_url, init) => {
    calls += 1
    return jsonResponse(bingPayload(JSON.parse(init.body)[0]))
  }, t)

  const h = harness({ config: { cacheMaxBytes: 1024 } })
  await h.service.translate({ text: 'large'.repeat(500), targetLanguage: 'en' })

  assert.equal(calls, 1, 'the translation still succeeds')
  assert.equal(h.service.cache.size, 0, 'an oversized result must not be retained')
  assert.equal(h.service.cache.bytes, 0)
})

test('coalescing: identical concurrent demands share one provider call', async (t) => {
  let calls = 0
  mockFetch(async () => {
    calls += 1
    await new Promise((resolve) => setTimeout(resolve, 5))
    return jsonResponse(bingPayload('ok'))
  }, t)

  const h = harness()
  const [first, second] = await Promise.all([
    h.service.translate({ text: 'hi', targetLanguage: 'en' }),
    h.service.translate({ text: 'hi', targetLanguage: 'en' }),
  ])

  assert.equal(calls, 1, 'one network call must serve both callers')
  assert.equal(first.text, 'ok')
  assert.equal(second.text, 'ok')
})





test('coalescing: one caller cancelling does not abort another caller', async (t) => {
  let calls = 0
  mockFetch(async () => {
    calls += 1
    await new Promise((resolve) => setTimeout(resolve, 20))
    return jsonResponse(bingPayload('shared result'))
  }, t)

  const h = harness()
  const controller = new AbortController()
  const first = h.service.translateRequest(
    { text: 'shared demand', targetLanguage: 'en' },
    controller.signal,
  )
  const second = h.service.translate({ text: 'shared demand', targetLanguage: 'en' })
  await new Promise((resolve) => setTimeout(resolve, 5))
  controller.abort(new Error('one panel closed'))

  await assert.rejects(first, (error) => error.message === 'one panel closed')
  const result = await second
  assert.equal(result.text, 'shared result')
  assert.equal(calls, 1, 'the remaining waiter must keep the shared provider call alive')
})

test('coalescing: a new caller does not join work abandoned by every prior caller', async (t) => {
  let calls = 0
  mockFetch(async (_url, init) => {
    calls += 1
    if (calls === 1) {
      return await new Promise((_resolve, reject) => {
        init.signal.addEventListener('abort', () => reject(init.signal.reason), { once: true })
      })
    }
    return jsonResponse(bingPayload('fresh result'))
  }, t)

  const h = harness()
  const controller = new AbortController()
  const abandoned = h.service.translateRequest(
    { text: 'same demand', targetLanguage: 'en' },
    controller.signal,
  )
  await new Promise((resolve) => setTimeout(resolve, 5))
  controller.abort(new Error('the only caller left'))
  await assert.rejects(abandoned, (error) => error.message === 'the only caller left')

  const fresh = await h.service.translate({ text: 'same demand', targetLanguage: 'en' })
  assert.equal(fresh.text, 'fresh result')
  assert.equal(calls, 2, 'the new caller must start fresh provider work')
  assert.equal(fresh.cached, false)
})

test('rate limit: an exhausted bucket refuses the request', async (t) => {
  let calls = 0
  mockFetch(async () => {
    calls += 1
    return jsonResponse(bingPayload('ok'))
  }, t)

  const h = harness({ config: { rateLimitPerMinute: 1 } })
  await h.service.translate({ text: 'one', targetLanguage: 'en' })
  await assert.rejects(
    h.service.translate({ text: 'two', targetLanguage: 'en' }),
    (error) => {
      assert.equal(error.code, 'translation-pane/rate-limited')
      assert.equal(error.details.limit, 1)
      return true
    },
  )
  assert.equal(calls, 1, 'a refused request must not reach the provider')
})

test('failover: an unreachable provider hands the request to the other provider', async (t) => {
  const calls = []
  mockFetch(async (url) => {
    const target = String(url)
    calls.push(target)
    if (target.includes('google')) throw new TypeError('fetch failed')
    return jsonResponse(bingPayload('你好'))
  }, t)

  const h = harness()
  const result = await h.service.translate({
    text: 'hello',
    targetLanguage: 'zh-Hans',
    provider: 'google',
  })

  assert.equal(result.text, '你好')
  assert.equal(result.provider, 'bing', 'the provider that served must be reported')
  assert.equal(result.requestedProvider, 'google')
  assert.equal(result.failover, true)
  assert.equal(calls.length, 2)
  assert.ok(calls[0].includes('google'), 'the requested provider is asked first')
  assert.ok(calls[1].includes('microsoft'), 'the alternate provider answers after it fails')

  const described = h.service.describe()
  assert.equal(described.failover, true)
  assert.equal(described.providerHealth.google.unreachable, true)
  assert.equal(described.providerHealth.google.reason, 'translation-pane/provider-unreachable')
  assert.equal(typeof described.providerHealth.google.until, 'string')
  assert.equal(Number.isNaN(Date.parse(described.providerHealth.google.until)), false)
  assert.equal(described.providerHealth.bing.unreachable, false)
})

test('failover: later fragments of one document do not re-probe a dead provider', async (t) => {
  const calls = []
  mockFetch(async (url) => {
    const target = String(url)
    calls.push(target)
    if (target.includes('google')) throw new TypeError('fetch failed')
    return jsonResponse(bingPayload('x'))
  }, t)

  const h = harness({ config: { fragmentChars: 50, maxConcurrency: 1 } })
  // 200 characters split into four fragments of 50.
  await h.service.translate({
    text: 'a'.repeat(200),
    targetLanguage: 'en',
    provider: 'google',
  })

  assert.equal(
    calls.filter((url) => url.includes('google')).length,
    1,
    'the dead provider must be probed only once per request',
  )
  assert.equal(calls.filter((url) => url.includes('microsoft')).length, 4)
})

test('failover: a demand split across providers reports every provider that served', async (t) => {
  let googleAnswers = 0
  mockFetch(async (url) => {
    const target = String(url)
    if (target.includes('google')) {
      // The first fragment is answered by the requested provider; the second
      // proves that provider dead for the rest of the request.
      googleAnswers += 1
      if (googleAnswers === 1) return jsonResponse([[['你']], null, 'en'])
      throw new TypeError('fetch failed')
    }
    return jsonResponse(bingPayload('好'))
  }, t)

  const h = harness({ config: { fragmentChars: 10, maxConcurrency: 1 } })
  const result = await h.service.translate({
    text: 'a'.repeat(20),
    targetLanguage: 'zh-Hans',
    provider: 'google',
  })

  assert.equal(result.text, '你好', 'every fragment must be translated exactly once')
  assert.equal(result.requestedProvider, 'google')
  assert.equal(result.failover, true, 'a partially failed-over demand must still say so')
  assert.deepEqual(
    [...result.providersServed].sort(),
    ['bing', 'google'],
    'both providers that answered must be reported',
  )
})

test('failover: a cache hit replays the served provider and the failover fact', async (t) => {
  let calls = 0
  mockFetch(async (url) => {
    calls += 1
    if (String(url).includes('google')) throw new TypeError('fetch failed')
    return jsonResponse(bingPayload('ok'))
  }, t)

  const h = harness()
  const first = await h.service.translate({
    text: 'hi',
    targetLanguage: 'en',
    provider: 'google',
  })
  const second = await h.service.translate({
    text: 'hi',
    targetLanguage: 'en',
    provider: 'google',
  })

  assert.equal(calls, 2, 'the cache hit must not reach a provider')
  assert.equal(first.cached, false)
  assert.equal(second.cached, true)
  assert.equal(second.provider, 'bing')
  assert.equal(second.requestedProvider, 'google')
  assert.equal(second.failover, true)
})

test('failover: a provider that stalls before headers is bounded and replaced', async (t) => {
  mockFetch(
    async (url, init) => {
      if (String(url).includes('google')) {
        return await new Promise((_resolve, reject) => {
          init.signal.addEventListener('abort', () => reject(init.signal.reason), { once: true })
        })
      }
      return jsonResponse(bingPayload('你好'))
    },
    t,
  )

  const h = harness({ config: { attemptTimeoutMs: 25, timeoutMs: 2000 } })
  const started = Date.now()
  const result = await h.service.translate({
    text: 'hello',
    targetLanguage: 'zh-Hans',
    provider: 'google',
  })
  const elapsed = Date.now() - started

  assert.equal(result.provider, 'bing')
  assert.equal(result.failover, true)
  assert.ok(elapsed < 1000, `the stalled provider must be bounded (took ${elapsed}ms)`)
  assert.match(h.logs.warn.join('\n'), /falling back from the google provider/)
})

test('failover: a recently failed provider is skipped until its cooldown expires', async (t) => {
  let googleCalls = 0
  let bingCalls = 0
  mockFetch(async (url) => {
    if (String(url).includes('google')) {
      googleCalls += 1
      if (googleCalls === 1) throw new TypeError('fetch failed')
      return jsonResponse([[['你好', 'hello', null, null, 10]], null, 'en'])
    }
    bingCalls += 1
    return jsonResponse(bingPayload('你好'))
  }, t)

  const h = harness({ config: { providerCooldownMs: 40 } })
  const first = await h.service.translate({
    text: 'one',
    targetLanguage: 'zh-Hans',
    provider: 'google',
  })
  assert.equal(first.provider, 'bing')
  assert.equal(h.service.describe().providerHealth.google.unreachable, true)

  const second = await h.service.translate({
    text: 'two',
    targetLanguage: 'zh-Hans',
    provider: 'google',
  })
  assert.equal(second.provider, 'bing')
  assert.equal(second.failover, true)
  assert.equal(googleCalls, 1, 'a provider inside its cooldown must not be asked again')
  assert.equal(bingCalls, 2)

  await new Promise((resolve) => setTimeout(resolve, 60))
  assert.equal(
    h.service.describe().providerHealth.google.unreachable,
    false,
    'the cooldown must expire',
  )

  const third = await h.service.translate({
    text: 'three',
    targetLanguage: 'zh-Hans',
    provider: 'google',
  })
  assert.equal(third.provider, 'google', 'a recovered provider must be retried after the cooldown')
  assert.equal(third.failover, false)
  assert.equal(googleCalls, 2)
})

test('failover: a 4xx answer is never failed over', async (t) => {
  const calls = []
  mockFetch(async (url) => {
    calls.push(String(url))
    return jsonResponse({ error: 'bad request' }, { status: 400 })
  }, t)

  const h = harness({ config: { maxRetries: 3, retryBaseMs: 1 } })
  await assert.rejects(
    h.service.translate({ text: 'hi', targetLanguage: 'en', provider: 'google' }),
    (error) => {
      assert.equal(error.code, 'translation-pane/provider-error')
      assert.equal(error.details.status, 400)
      return true
    },
  )
  assert.equal(calls.length, 1, 'a 4xx must not be retried or failed over')
  assert.equal(h.service.describe().providerHealth.google.unreachable, false)
})

test('failover: the local rate limiter is never treated as a provider fault', async (t) => {
  let calls = 0
  mockFetch(async () => {
    calls += 1
    return jsonResponse(bingPayload('ok'))
  }, t)

  const h = harness({ config: { rateLimitPerMinute: 1 } })
  await h.service.translate({ text: 'one', targetLanguage: 'en' })
  await assert.rejects(
    h.service.translate({ text: 'two', targetLanguage: 'en' }),
    (error) => {
      assert.equal(error.code, 'translation-pane/rate-limited')
      assert.equal(error.details.limit, 1)
      return true
    },
  )
  assert.equal(calls, 1, 'a refused local request must not reach a second provider')
  assert.equal(h.service.describe().providerHealth.bing.unreachable, false)
  assert.equal(h.service.describe().providerHealth.google.unreachable, false)
})

test('failover: when both providers fail the last failure carries the providers tried', async (t) => {
  const calls = []
  mockFetch(async (url) => {
    calls.push(String(url))
    throw new TypeError('fetch failed')
  }, t)

  const h = harness()
  await assert.rejects(
    h.service.translate({ text: 'hi', targetLanguage: 'en', provider: 'google' }),
    (error) => {
      assert.equal(error.code, 'translation-pane/provider-unreachable')
      assert.equal(error.isDSHRemoteError, true)
      assert.deepEqual(error.details.providersTried, ['google', 'bing'])
      assert.equal(error.details.provider, 'bing')
      return true
    },
  )
  assert.equal(calls.length, 2, 'each provider gets exactly one attempt')
})

test('failover: a caller cancellation does not mark the provider unhealthy', async (t) => {
  mockFetch(
    async (_url, init) =>
      new Promise((_resolve, reject) => {
        init.signal.addEventListener('abort', () => reject(init.signal.reason), { once: true })
      }),
    t,
  )

  const h = harness()
  const controller = new AbortController()
  const pending = h.service.translateRequest(
    { text: 'hi', targetLanguage: 'en', provider: 'google' },
    controller.signal,
  )
  await new Promise((resolve) => setTimeout(resolve, 5))
  controller.abort(new Error('the panel moved on'))
  await assert.rejects(pending, (error) => error instanceof Error)
  assert.equal(h.service.describe().providerHealth.google.unreachable, false)
  assert.equal(h.service.describe().providerHealth.bing.unreachable, false)
})

test('failover: a response body that cannot be read is not failed over', async (t) => {
  const calls = []
  mockFetch(async (url) => {
    calls.push(String(url))
    return new Response('not json', { status: 200 })
  }, t)

  const h = harness()
  await assert.rejects(
    h.service.translate({ text: 'hi', targetLanguage: 'en', provider: 'google' }),
    (error) => error.code === 'translation-pane/invalid-response',
  )
  // The provider answered; another provider would not fix a parsing problem
  // and the request budget is better spent failing honestly.
  assert.equal(calls.length, 1)
})

test('cancellation: the caller signal ends the demand', async (t) => {
  mockFetch(
    async (_url, init) =>
      new Promise((resolve, reject) => {
        init.signal.addEventListener('abort', () => reject(init.signal.reason), { once: true })
      }),
    t,
  )

  const h = harness()
  const controller = new AbortController()
  const pending = h.service.translateRequest({ text: 'hi', targetLanguage: 'en' }, controller.signal)
  controller.abort(new Error('the panel moved on'))
  await assert.rejects(pending, (error) => {
    assert.ok(error instanceof Error)
    return true
  })
})

test('cancellation: a signal that is already aborted refuses the demand', async (t) => {
  mockFetch(async () => jsonResponse(bingPayload('ok')), t)
  const h = harness()
  const controller = new AbortController()
  controller.abort()
  await assert.rejects(
    h.service.translateRequest({ text: 'hi', targetLanguage: 'en' }, controller.signal),
    (error) => error instanceof Error,
  )
})

test('timeout: a request that never answers fails with the timeout code', async (t) => {
  mockFetch(
    async (_url, init) =>
      new Promise((resolve, reject) => {
        init.signal.addEventListener('abort', () => reject(init.signal.reason), { once: true })
      }),
    t,
  )

  const h = harness({ config: { timeoutMs: 25 } })
  await assert.rejects(
    h.service.translate({ text: 'hi', targetLanguage: 'en' }),
    (error) => {
      assert.equal(error.code, 'translation-pane/timeout')
      assert.equal(error.isDSHRemoteError, true)
      return true
    },
  )
})

test('timeout: one attempt is bounded even without a fallback provider', async (t) => {
  mockFetch(
    async (_url, init) =>
      new Promise((_resolve, reject) => {
        init.signal.addEventListener('abort', () => reject(init.signal.reason), { once: true })
      }),
    t,
  )

  const h = harness({
    config: { failover: false, maxRetries: 0, attemptTimeoutMs: 20, timeoutMs: 5000 },
  })
  const started = Date.now()
  await assert.rejects(
    h.service.translate({ text: 'hi', targetLanguage: 'en' }),
    (error) => {
      assert.equal(error.code, 'translation-pane/timeout')
      assert.equal(error.details.timeoutMs, 20)
      assert.equal(error.details.provider, 'bing')
      return true
    },
  )
  assert.ok(
    Date.now() - started < 500,
    'the header deadline must win over the whole-request deadline',
  )
})

test('unload: the service lifetime aborts the work in flight', async (t) => {
  mockFetch(
    async (_url, init) =>
      new Promise((resolve, reject) => {
        init.signal.addEventListener('abort', () => reject(init.signal.reason), { once: true })
      }),
    t,
  )

  const h = harness()
  const pending = h.service.translate({ text: 'hi', targetLanguage: 'en' })
  await h.unload()
  await assert.rejects(pending, (error) => error instanceof Error)
})

test('concurrency: the fragments are dispatched with a bounded concurrency', async (t) => {
  let running = 0
  let peak = 0
  mockFetch(async () => {
    running += 1
    peak = Math.max(peak, running)
    await new Promise((resolve) => setTimeout(resolve, 5))
    running -= 1
    return jsonResponse(bingPayload('ok'))
  }, t)

  const h = harness({ config: { fragmentChars: 50, maxConcurrency: 2 } })
  await h.service.translate({ text: 'a'.repeat(200), targetLanguage: 'en' })
  assert.equal(peak, 2, 'the concurrency must be bounded by the configuration')
})

test('concurrency: distinct translation demands share one service-wide limit', async (t) => {
  let running = 0
  let peak = 0
  mockFetch(async () => {
    running += 1
    peak = Math.max(peak, running)
    await new Promise((resolve) => setTimeout(resolve, 8))
    running -= 1
    return jsonResponse(bingPayload('ok'))
  }, t)

  const h = harness({ config: { maxConcurrency: 2 } })
  await Promise.all(
    ['first', 'second', 'third', 'fourth'].map((text) =>
      h.service.translateRequest({ text, targetLanguage: 'en' }),
    ),
  )
  assert.equal(peak, 2, 'unique requests must share the same provider concurrency budget')
})

test('concurrency: distinct shipped-translator demands share the same service-wide limit', async () => {
  let running = 0
  let peak = 0
  const translator = fakeTranslator({
    translate: async (spec) => {
      running += 1
      peak = Math.max(peak, running)
      await new Promise((resolve) => setTimeout(resolve, 8))
      running -= 1
      return `translated ${spec.text}`
    },
  })
  const h = harness({ translator, config: { maxConcurrency: 1 } })

  await Promise.all(
    ['one', 'two', 'three'].map((text) =>
      h.service.translateRequest({ text, targetLanguage: 'en' }),
    ),
  )
  assert.equal(peak, 1, 'the shipped translator route must share the same global slots')
})

test('scheduler: FIFO waiters are cancellable and do not consume slots after leaving', async (t) => {
  let releaseFirst
  let signalFirstStarted
  const firstStarted = new Promise((resolve) => {
    signalFirstStarted = resolve
  })
  const started = []
  mockFetch(async (_url, init) => {
    const source = JSON.parse(init.body)[0]
    started.push(source)
    if (source === 'first') {
      signalFirstStarted()
      await new Promise((resolve) => {
        releaseFirst = resolve
      })
    }
    return jsonResponse(bingPayload(source))
  }, t)

  const h = harness({ config: { maxConcurrency: 1, maxQueuedRequests: 2 } })
  const first = h.service.translateRequest({ text: 'first', targetLanguage: 'en' })
  await firstStarted

  const controller = new AbortController()
  const second = h.service.translateRequest(
    { text: 'second', targetLanguage: 'en' },
    controller.signal,
  )
  const third = h.service.translateRequest({ text: 'third', targetLanguage: 'en' })
  await new Promise((resolve) => setTimeout(resolve, 5))
  assert.equal(h.service.describe().queuedRequests, 2)

  controller.abort(new Error('the queued caller no longer wants this result'))
  await assert.rejects(second, /queued caller no longer wants this result/)
  assert.equal(h.service.describe().queuedRequests, 1, 'cancellation must remove the waiter immediately')

  releaseFirst()
  await Promise.all([first, third])
  assert.deepEqual(started, ['first', 'third'], 'the cancelled demand must never reach the provider')
  assert.equal(h.service.describe().activeRequests, 0)
  assert.equal(h.service.describe().queuedRequests, 0)
})

test('scheduler: a full FIFO queue refuses excess work with the busy code', async (t) => {
  let releaseFirst
  let signalFirstStarted
  const firstStarted = new Promise((resolve) => {
    signalFirstStarted = resolve
  })
  mockFetch(async (_url, init) => {
    const source = JSON.parse(init.body)[0]
    if (source === 'first') {
      signalFirstStarted()
      await new Promise((resolve) => {
        releaseFirst = resolve
      })
    }
    return jsonResponse(bingPayload(source))
  }, t)

  const h = harness({ config: { maxConcurrency: 1, maxQueuedRequests: 1 } })
  const first = h.service.translateRequest({ text: 'first', targetLanguage: 'en' })
  await firstStarted
  const second = h.service.translateRequest({ text: 'second', targetLanguage: 'en' })
  await new Promise((resolve) => setTimeout(resolve, 5))
  await assert.rejects(
    h.service.translateRequest({ text: 'third', targetLanguage: 'en' }),
    (error) => error.code === 'translation-pane/busy',
  )
  assert.equal(h.service.describe().queuedRequests, 1)
  releaseFirst()
  await Promise.all([first, second])
})

test('logging: the source text never reaches the log', async (t) => {
  mockFetch(async () => jsonResponse(bingPayload('ok')), t)
  const secret = 'a-very-private-sentence'
  const h = harness()
  await h.service.translate({ text: secret, targetLanguage: 'en' })
  const logged = [...h.logs.debug, ...h.logs.warn].join('\n')
  assert.ok(logged.length > 0, 'the plugin must log something')
  assert.equal(logged.includes(secret), false)
})

test('Remote marker: the descriptor names both methods', () => {
  const h = harness()
  const descriptor = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(h.service), REMOTE_METHODS)
  assert.ok(descriptor, 'the prototype must carry the Remote method descriptor')
  const marker = descriptor.value
  assert.equal(marker.version, 1)
  assert.ok(Object.isFrozen(marker))
  assert.ok(Object.isFrozen(marker.methods))
  assert.deepEqual(
    marker.methods.map((method) => method.method),
    ['describe', 'translate'],
  )
  for (const method of marker.methods) {
    assert.equal(method.invocation.kind, 'direct')
    assert.ok(Object.isFrozen(method))
  }
})

test('tool: the registration carries the documented schema', () => {
  const h = harness()
  const tool = h.tools.find((entry) => entry.name === 'translate_text')
  assert.ok(tool, 'the translate_text tool must be registered')
  assert.equal(tool.parameters.type, 'object')
  assert.equal(tool.parameters.additionalProperties, false)
  assert.deepEqual(tool.parameters.required, ['text', 'targetLanguage'])
  assert.equal(tool.parameters.properties.text.type, 'string')
  assert.equal(tool.parameters.properties.targetLanguage.type, 'string')
  assert.equal(tool.parameters.properties.sourceLanguage.type, 'string')
  assert.equal(tool.output.schema.type, 'object')
  assert.equal(tool.output.schema.additionalProperties, false)
  for (const field of ['text', 'sourceLanguage', 'targetLanguage', 'provider', 'cached', 'durationMs']) {
    assert.ok(tool.output.schema.properties[field], `the output schema must declare ${field}`)
  }
  assert.ok(tool.output.schema.properties.detectedSourceLanguage)
  // Additive routing facts: optional, so an older consumer keeps working.
  assert.equal(tool.output.schema.properties.requestedProvider.type, 'string')
  assert.equal(tool.output.schema.properties.failover.type, 'boolean')
  assert.equal(tool.output.schema.required.includes('requestedProvider'), false)
  assert.equal(tool.output.schema.required.includes('failover'), false)
  assert.equal(tool.isConcurrencySafe(), true)
  assert.match(tool.description, /split into provider-sized requests/)
})

test('tool: execute returns the translation and honours the exec signal', async (t) => {
  mockFetch(async () => jsonResponse(bingPayload('你好')), t)
  const h = harness()
  const tool = h.tools.find((entry) => entry.name === 'translate_text')

  const value = await tool.execute({ text: 'hello', targetLanguage: 'zh-Hans' }, { signal: undefined })
  assert.equal(value.text, '你好')
  assert.equal(value.sourceLanguage, 'auto')
  assert.equal(value.targetLanguage, 'zh-Hans')
  assert.equal(value.provider, 'bing')
  assert.equal(value.cached, false)
  assert.equal(typeof value.durationMs, 'number')

  const controller = new AbortController()
  controller.abort()
  await assert.rejects(tool.execute({ text: 'hello', targetLanguage: 'zh-Hans' }, { signal: controller.signal }))
})

test('tool: execute carries the additive routing facts on a failover', async (t) => {
  mockFetch(async (url) => {
    if (String(url).includes('microsoft')) throw new TypeError('fetch failed')
    return jsonResponse([[['你好', 'hello', null, null, 10]], null, 'en'])
  }, t)

  const h = harness()
  const tool = h.tools.find((entry) => entry.name === 'translate_text')
  const value = await tool.execute({ text: 'hello', targetLanguage: 'zh-Hans' }, { signal: undefined })

  assert.equal(value.text, '你好')
  assert.equal(value.provider, 'google', 'the tool reports the provider that served')
  assert.equal(value.requestedProvider, 'bing', 'the tool reports the default provider asked for')
  assert.equal(value.failover, true)
  assert.equal(typeof value.durationMs, 'number')
  assert.equal(value.cached, false)
})

test('tool: execute surfaces the same provider-unreachable code as the panel', async (t) => {
  mockFetch(async () => {
    throw new TypeError('fetch failed')
  }, t)

  const h = harness()
  const tool = h.tools.find((entry) => entry.name === 'translate_text')
  await assert.rejects(
    tool.execute({ text: 'hello', targetLanguage: 'zh-Hans' }, { signal: undefined }),
    (error) => {
      assert.equal(error.code, 'translation-pane/provider-unreachable')
      assert.equal(error.isDSHRemoteError, true)
      return true
    },
  )
})

test('concurrency: distinct shipped-translator demands share the same service-wide limit', async () => {
  let running = 0
  let peak = 0
  const translator = fakeTranslator({
    translate: async (spec) => {
      running += 1
      peak = Math.max(peak, running)
      await new Promise((resolve) => setTimeout(resolve, 8))
      running -= 1
      return `translated ${spec.text}`
    },
  })
  const h = harness({ translator, config: { maxConcurrency: 1 } })

  await Promise.all(
    ['one', 'two', 'three'].map((text) =>
      h.service.translateRequest({ text, targetLanguage: 'en' }),
    ),
  )
  assert.equal(peak, 1, 'the shipped translator route must share the same global slots')
})

test('scheduler: FIFO waiters are cancellable and do not consume slots after leaving', async (t) => {
  let releaseFirst
  let signalFirstStarted
  const firstStarted = new Promise((resolve) => {
    signalFirstStarted = resolve
  })
  const started = []
  mockFetch(async (_url, init) => {
    const source = JSON.parse(init.body)[0]
    started.push(source)
    if (source === 'first') {
      signalFirstStarted()
      await new Promise((resolve) => {
        releaseFirst = resolve
      })
    }
    return jsonResponse(bingPayload(source))
  }, t)

  const h = harness({ config: { maxConcurrency: 1, maxQueuedRequests: 2 } })
  const first = h.service.translateRequest({ text: 'first', targetLanguage: 'en' })
  await firstStarted

  const controller = new AbortController()
  const second = h.service.translateRequest(
    { text: 'second', targetLanguage: 'en' },
    controller.signal,
  )
  const third = h.service.translateRequest({ text: 'third', targetLanguage: 'en' })
  await new Promise((resolve) => setTimeout(resolve, 5))
  assert.equal(h.service.describe().queuedRequests, 2)

  controller.abort(new Error('the queued caller no longer wants this result'))
  await assert.rejects(second, /queued caller no longer wants this result/)
  assert.equal(h.service.describe().queuedRequests, 1, 'cancellation must remove the waiter immediately')

  releaseFirst()
  await Promise.all([first, third])
  assert.deepEqual(started, ['first', 'third'], 'the cancelled demand must never reach the provider')
  assert.equal(h.service.describe().activeRequests, 0)
  assert.equal(h.service.describe().queuedRequests, 0)
})

test('scheduler: a full FIFO queue refuses excess work with the busy code', async (t) => {
  let releaseFirst
  let signalFirstStarted
  const firstStarted = new Promise((resolve) => {
    signalFirstStarted = resolve
  })
  mockFetch(async (_url, init) => {
    const source = JSON.parse(init.body)[0]
    if (source === 'first') {
      signalFirstStarted()
      await new Promise((resolve) => {
        releaseFirst = resolve
      })
    }
    return jsonResponse(bingPayload(source))
  }, t)

  const h = harness({ config: { maxConcurrency: 1, maxQueuedRequests: 1 } })
  const first = h.service.translateRequest({ text: 'first', targetLanguage: 'en' })
  await firstStarted
  const second = h.service.translateRequest({ text: 'second', targetLanguage: 'en' })
  await new Promise((resolve) => setTimeout(resolve, 5))
  await assert.rejects(
    h.service.translateRequest({ text: 'third', targetLanguage: 'en' }),
    (error) => error.code === 'translation-pane/busy',
  )
  assert.equal(h.service.describe().queuedRequests, 1)
  releaseFirst()
  await Promise.all([first, second])
})

test('logging: the source text never reaches the log', async (t) => {
  mockFetch(async () => jsonResponse(bingPayload('ok')), t)
  const secret = 'a-very-private-sentence'
  const h = harness()
  await h.service.translate({ text: secret, targetLanguage: 'en' })
  const logged = [...h.logs.debug, ...h.logs.warn].join('\n')
  assert.ok(logged.length > 0, 'the plugin must log something')
  assert.equal(logged.includes(secret), false)
})

test('Remote marker: the descriptor names both methods', () => {
  const h = harness()
  const descriptor = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(h.service), REMOTE_METHODS)
  assert.ok(descriptor, 'the prototype must carry the Remote method descriptor')
  const marker = descriptor.value
  assert.equal(marker.version, 1)
  assert.ok(Object.isFrozen(marker))
  assert.ok(Object.isFrozen(marker.methods))
  assert.deepEqual(
    marker.methods.map((method) => method.method),
    ['describe', 'translate'],
  )
  for (const method of marker.methods) {
    assert.equal(method.invocation.kind, 'direct')
    assert.ok(Object.isFrozen(method))
  }
})

test('tool: the registration carries the documented schema', () => {
  const h = harness()
  const tool = h.tools.find((entry) => entry.name === 'translate_text')
  assert.ok(tool, 'the translate_text tool must be registered')
  assert.equal(tool.parameters.type, 'object')
  assert.equal(tool.parameters.additionalProperties, false)
  assert.deepEqual(tool.parameters.required, ['text', 'targetLanguage'])
  assert.equal(tool.parameters.properties.text.type, 'string')
  assert.equal(tool.parameters.properties.targetLanguage.type, 'string')
  assert.equal(tool.parameters.properties.sourceLanguage.type, 'string')
  assert.equal(tool.output.schema.type, 'object')
  assert.equal(tool.output.schema.additionalProperties, false)
  for (const field of ['text', 'sourceLanguage', 'targetLanguage', 'provider', 'cached', 'durationMs']) {
    assert.ok(tool.output.schema.properties[field], `the output schema must declare ${field}`)
  }
  assert.ok(tool.output.schema.properties.detectedSourceLanguage)
  // Additive routing facts: optional, so an older consumer keeps working.
  assert.equal(tool.output.schema.properties.requestedProvider.type, 'string')
  assert.equal(tool.output.schema.properties.failover.type, 'boolean')
  assert.equal(tool.output.schema.required.includes('requestedProvider'), false)
  assert.equal(tool.output.schema.required.includes('failover'), false)
  assert.equal(tool.isConcurrencySafe(), true)
  assert.match(tool.description, /split into provider-sized requests/)
})

test('tool: execute returns the translation and honours the exec signal', async (t) => {
  mockFetch(async () => jsonResponse(bingPayload('你好')), t)
  const h = harness()
  const tool = h.tools.find((entry) => entry.name === 'translate_text')

  const value = await tool.execute({ text: 'hello', targetLanguage: 'zh-Hans' }, { signal: undefined })
  assert.equal(value.text, '你好')
  assert.equal(value.sourceLanguage, 'auto')
  assert.equal(value.targetLanguage, 'zh-Hans')
  assert.equal(value.provider, 'bing')
  assert.equal(value.cached, false)
  assert.equal(typeof value.durationMs, 'number')

  const controller = new AbortController()
  controller.abort()
  await assert.rejects(tool.execute({ text: 'hello', targetLanguage: 'zh-Hans' }, { signal: controller.signal }))
})

test('tool: execute carries the additive routing facts on a failover', async (t) => {
  mockFetch(async (url) => {
    if (String(url).includes('microsoft')) throw new TypeError('fetch failed')
    return jsonResponse([[['你好', 'hello', null, null, 10]], null, 'en'])
  }, t)

  const h = harness()
  const tool = h.tools.find((entry) => entry.name === 'translate_text')
  const value = await tool.execute({ text: 'hello', targetLanguage: 'zh-Hans' }, { signal: undefined })

  assert.equal(value.text, '你好')
  assert.equal(value.provider, 'google', 'the tool reports the provider that served')
  assert.equal(value.requestedProvider, 'bing', 'the tool reports the default provider asked for')
  assert.equal(value.failover, true)
  assert.equal(typeof value.durationMs, 'number')
  assert.equal(value.cached, false)
})

test('tool: execute surfaces the same provider-unreachable code as the panel', async (t) => {
  mockFetch(async () => {
    throw new TypeError('fetch failed')
  }, t)

  const h = harness()
  const tool = h.tools.find((entry) => entry.name === 'translate_text')
  await assert.rejects(
    tool.execute({ text: 'hello', targetLanguage: 'zh-Hans' }, { signal: undefined }),
    (error) => {
      assert.equal(error.code, 'translation-pane/provider-unreachable')
      assert.equal(error.isDSHRemoteError, true)
      return true
    },
  )
})

test('scheduler: FIFO waiters are cancellable and do not consume slots after leaving', async (t) => {
  let releaseFirst
  let signalFirstStarted
  const firstStarted = new Promise((resolve) => {
    signalFirstStarted = resolve
  })
  const started = []
  mockFetch(async (_url, init) => {
    const source = JSON.parse(init.body)[0]
    started.push(source)
    if (source === 'first') {
      signalFirstStarted()
      await new Promise((resolve) => {
        releaseFirst = resolve
      })
    }
    return jsonResponse(bingPayload(source))
  }, t)

  const h = harness({ config: { maxConcurrency: 1, maxQueuedRequests: 2 } })
  const first = h.service.translateRequest({ text: 'first', targetLanguage: 'en' })
  await firstStarted

  const controller = new AbortController()
  const second = h.service.translateRequest(
    { text: 'second', targetLanguage: 'en' },
    controller.signal,
  )
  const third = h.service.translateRequest({ text: 'third', targetLanguage: 'en' })
  await new Promise((resolve) => setTimeout(resolve, 5))
  assert.equal(h.service.describe().queuedRequests, 2)

  controller.abort(new Error('the queued caller no longer wants this result'))
  await assert.rejects(second, /queued caller no longer wants this result/)
  assert.equal(h.service.describe().queuedRequests, 1, 'cancellation must remove the waiter immediately')

  releaseFirst()
  await Promise.all([first, third])
  assert.deepEqual(started, ['first', 'third'], 'the cancelled demand must never reach the provider')
  assert.equal(h.service.describe().activeRequests, 0)
  assert.equal(h.service.describe().queuedRequests, 0)
})

test('scheduler: a full FIFO queue refuses excess work with the busy code', async (t) => {
  let releaseFirst
  let signalFirstStarted
  const firstStarted = new Promise((resolve) => {
    signalFirstStarted = resolve
  })
  mockFetch(async (_url, init) => {
    const source = JSON.parse(init.body)[0]
    if (source === 'first') {
      signalFirstStarted()
      await new Promise((resolve) => {
        releaseFirst = resolve
      })
    }
    return jsonResponse(bingPayload(source))
  }, t)

  const h = harness({ config: { maxConcurrency: 1, maxQueuedRequests: 1 } })
  const first = h.service.translateRequest({ text: 'first', targetLanguage: 'en' })
  await firstStarted
  const second = h.service.translateRequest({ text: 'second', targetLanguage: 'en' })
  await new Promise((resolve) => setTimeout(resolve, 5))
  await assert.rejects(
    h.service.translateRequest({ text: 'third', targetLanguage: 'en' }),
    (error) => error.code === 'translation-pane/busy',
  )
  assert.equal(h.service.describe().queuedRequests, 1)
  releaseFirst()
  await Promise.all([first, second])
})

test('logging: the source text never reaches the log', async (t) => {
  mockFetch(async () => jsonResponse(bingPayload('ok')), t)
  const secret = 'a-very-private-sentence'
  const h = harness()
  await h.service.translate({ text: secret, targetLanguage: 'en' })
  const logged = [...h.logs.debug, ...h.logs.warn].join('\n')
  assert.ok(logged.length > 0, 'the plugin must log something')
  assert.equal(logged.includes(secret), false)
})

test('Remote marker: the descriptor names both methods', () => {
  const h = harness()
  const descriptor = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(h.service), REMOTE_METHODS)
  assert.ok(descriptor, 'the prototype must carry the Remote method descriptor')
  const marker = descriptor.value
  assert.equal(marker.version, 1)
  assert.ok(Object.isFrozen(marker))
  assert.ok(Object.isFrozen(marker.methods))
  assert.deepEqual(
    marker.methods.map((method) => method.method),
    ['describe', 'translate'],
  )
  for (const method of marker.methods) {
    assert.equal(method.invocation.kind, 'direct')
    assert.ok(Object.isFrozen(method))
  }
})

test('tool: the registration carries the documented schema', () => {
  const h = harness()
  const tool = h.tools.find((entry) => entry.name === 'translate_text')
  assert.ok(tool, 'the translate_text tool must be registered')
  assert.equal(tool.parameters.type, 'object')
  assert.equal(tool.parameters.additionalProperties, false)
  assert.deepEqual(tool.parameters.required, ['text', 'targetLanguage'])
  assert.equal(tool.parameters.properties.text.type, 'string')
  assert.equal(tool.parameters.properties.targetLanguage.type, 'string')
  assert.equal(tool.parameters.properties.sourceLanguage.type, 'string')
  assert.equal(tool.output.schema.type, 'object')
  assert.equal(tool.output.schema.additionalProperties, false)
  for (const field of ['text', 'sourceLanguage', 'targetLanguage', 'provider', 'cached', 'durationMs']) {
    assert.ok(tool.output.schema.properties[field], `the output schema must declare ${field}`)
  }
  assert.ok(tool.output.schema.properties.detectedSourceLanguage)
  // Additive routing facts: optional, so an older consumer keeps working.
  assert.equal(tool.output.schema.properties.requestedProvider.type, 'string')
  assert.equal(tool.output.schema.properties.failover.type, 'boolean')
  assert.equal(tool.output.schema.required.includes('requestedProvider'), false)
  assert.equal(tool.output.schema.required.includes('failover'), false)
  assert.equal(tool.isConcurrencySafe(), true)
  assert.match(tool.description, /split into provider-sized requests/)
})

test('tool: execute returns the translation and honours the exec signal', async (t) => {
  mockFetch(async () => jsonResponse(bingPayload('你好')), t)
  const h = harness()
  const tool = h.tools.find((entry) => entry.name === 'translate_text')

  const value = await tool.execute({ text: 'hello', targetLanguage: 'zh-Hans' }, { signal: undefined })
  assert.equal(value.text, '你好')
  assert.equal(value.sourceLanguage, 'auto')
  assert.equal(value.targetLanguage, 'zh-Hans')
  assert.equal(value.provider, 'bing')
  assert.equal(value.cached, false)
  assert.equal(typeof value.durationMs, 'number')

  const controller = new AbortController()
  controller.abort()
  await assert.rejects(tool.execute({ text: 'hello', targetLanguage: 'zh-Hans' }, { signal: controller.signal }))
})

test('tool: execute carries the additive routing facts on a failover', async (t) => {
  mockFetch(async (url) => {
    if (String(url).includes('microsoft')) throw new TypeError('fetch failed')
    return jsonResponse([[['你好', 'hello', null, null, 10]], null, 'en'])
  }, t)

  const h = harness()
  const tool = h.tools.find((entry) => entry.name === 'translate_text')
  const value = await tool.execute({ text: 'hello', targetLanguage: 'zh-Hans' }, { signal: undefined })

  assert.equal(value.text, '你好')
  assert.equal(value.provider, 'google', 'the tool reports the provider that served')
  assert.equal(value.requestedProvider, 'bing', 'the tool reports the default provider asked for')
  assert.equal(value.failover, true)
  assert.equal(typeof value.durationMs, 'number')
  assert.equal(value.cached, false)
})

test('tool: execute surfaces the same provider-unreachable code as the panel', async (t) => {
  mockFetch(async () => {
    throw new TypeError('fetch failed')
  }, t)

  const h = harness()
  const tool = h.tools.find((entry) => entry.name === 'translate_text')
  await assert.rejects(
    tool.execute({ text: 'hello', targetLanguage: 'zh-Hans' }, { signal: undefined }),
    (error) => {
      assert.equal(error.code, 'translation-pane/provider-unreachable')
      assert.equal(error.isDSHRemoteError, true)
      return true
    },
  )
})

test('scheduler: a full FIFO queue refuses excess work with the busy code', async (t) => {
  let releaseFirst
  let signalFirstStarted
  const firstStarted = new Promise((resolve) => {
    signalFirstStarted = resolve
  })
  mockFetch(async (_url, init) => {
    const source = JSON.parse(init.body)[0]
    if (source === 'first') {
      signalFirstStarted()
      await new Promise((resolve) => {
        releaseFirst = resolve
      })
    }
    return jsonResponse(bingPayload(source))
  }, t)

  const h = harness({ config: { maxConcurrency: 1, maxQueuedRequests: 1 } })
  const first = h.service.translateRequest({ text: 'first', targetLanguage: 'en' })
  await firstStarted
  const second = h.service.translateRequest({ text: 'second', targetLanguage: 'en' })
  await new Promise((resolve) => setTimeout(resolve, 5))
  await assert.rejects(
    h.service.translateRequest({ text: 'third', targetLanguage: 'en' }),
    (error) => error.code === 'translation-pane/busy',
  )
  assert.equal(h.service.describe().queuedRequests, 1)
  releaseFirst()
  await Promise.all([first, second])
})

test('logging: the source text never reaches the log', async (t) => {
  mockFetch(async () => jsonResponse(bingPayload('ok')), t)
  const secret = 'a-very-private-sentence'
  const h = harness()
  await h.service.translate({ text: secret, targetLanguage: 'en' })
  const logged = [...h.logs.debug, ...h.logs.warn].join('\n')
  assert.ok(logged.length > 0, 'the plugin must log something')
  assert.equal(logged.includes(secret), false)
})

test('Remote marker: the descriptor names both methods', () => {
  const h = harness()
  const descriptor = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(h.service), REMOTE_METHODS)
  assert.ok(descriptor, 'the prototype must carry the Remote method descriptor')
  const marker = descriptor.value
  assert.equal(marker.version, 1)
  assert.ok(Object.isFrozen(marker))
  assert.ok(Object.isFrozen(marker.methods))
  assert.deepEqual(
    marker.methods.map((method) => method.method),
    ['describe', 'translate'],
  )
  for (const method of marker.methods) {
    assert.equal(method.invocation.kind, 'direct')
    assert.ok(Object.isFrozen(method))
  }
})

test('tool: the registration carries the documented schema', () => {
  const h = harness()
  const tool = h.tools.find((entry) => entry.name === 'translate_text')
  assert.ok(tool, 'the translate_text tool must be registered')
  assert.equal(tool.parameters.type, 'object')
  assert.equal(tool.parameters.additionalProperties, false)
  assert.deepEqual(tool.parameters.required, ['text', 'targetLanguage'])
  assert.equal(tool.parameters.properties.text.type, 'string')
  assert.equal(tool.parameters.properties.targetLanguage.type, 'string')
  assert.equal(tool.parameters.properties.sourceLanguage.type, 'string')
  assert.equal(tool.output.schema.type, 'object')
  assert.equal(tool.output.schema.additionalProperties, false)
  for (const field of ['text', 'sourceLanguage', 'targetLanguage', 'provider', 'cached', 'durationMs']) {
    assert.ok(tool.output.schema.properties[field], `the output schema must declare ${field}`)
  }
  assert.ok(tool.output.schema.properties.detectedSourceLanguage)
  // Additive routing facts: optional, so an older consumer keeps working.
  assert.equal(tool.output.schema.properties.requestedProvider.type, 'string')
  assert.equal(tool.output.schema.properties.failover.type, 'boolean')
  assert.equal(tool.output.schema.required.includes('requestedProvider'), false)
  assert.equal(tool.output.schema.required.includes('failover'), false)
  assert.equal(tool.isConcurrencySafe(), true)
  assert.match(tool.description, /split into provider-sized requests/)
})

test('tool: execute returns the translation and honours the exec signal', async (t) => {
  mockFetch(async () => jsonResponse(bingPayload('你好')), t)
  const h = harness()
  const tool = h.tools.find((entry) => entry.name === 'translate_text')

  const value = await tool.execute({ text: 'hello', targetLanguage: 'zh-Hans' }, { signal: undefined })
  assert.equal(value.text, '你好')
  assert.equal(value.sourceLanguage, 'auto')
  assert.equal(value.targetLanguage, 'zh-Hans')
  assert.equal(value.provider, 'bing')
  assert.equal(value.cached, false)
  assert.equal(typeof value.durationMs, 'number')

  const controller = new AbortController()
  controller.abort()
  await assert.rejects(tool.execute({ text: 'hello', targetLanguage: 'zh-Hans' }, { signal: controller.signal }))
})

test('tool: execute carries the additive routing facts on a failover', async (t) => {
  mockFetch(async (url) => {
    if (String(url).includes('microsoft')) throw new TypeError('fetch failed')
    return jsonResponse([[['你好', 'hello', null, null, 10]], null, 'en'])
  }, t)

  const h = harness()
  const tool = h.tools.find((entry) => entry.name === 'translate_text')
  const value = await tool.execute({ text: 'hello', targetLanguage: 'zh-Hans' }, { signal: undefined })

  assert.equal(value.text, '你好')
  assert.equal(value.provider, 'google', 'the tool reports the provider that served')
  assert.equal(value.requestedProvider, 'bing', 'the tool reports the default provider asked for')
  assert.equal(value.failover, true)
  assert.equal(typeof value.durationMs, 'number')
  assert.equal(value.cached, false)
})

test('tool: execute surfaces the same provider-unreachable code as the panel', async (t) => {
  mockFetch(async () => {
    throw new TypeError('fetch failed')
  }, t)

  const h = harness()
  const tool = h.tools.find((entry) => entry.name === 'translate_text')
  await assert.rejects(
    tool.execute({ text: 'hello', targetLanguage: 'zh-Hans' }, { signal: undefined }),
    (error) => {
      assert.equal(error.code, 'translation-pane/provider-unreachable')
      assert.equal(error.isDSHRemoteError, true)
      return true
    },
  )
})

test('concurrency: a failed fragment prevents queued fragments from being dispatched', async (t) => {
  const calls = []
  mockFetch(async (_url, init) => {
    const fragment = JSON.parse(init.body)[0]
    calls.push(fragment)
    if (fragment.startsWith('a')) return new Response('bad request', { status: 400 })
    await new Promise((resolve) => setTimeout(resolve, 10))
    return jsonResponse(bingPayload('ok'))
  }, t)

  const h = harness({
    config: { fragmentChars: 50, maxConcurrency: 2, failover: false, maxRetries: 0 },
  })
  await assert.rejects(
    h.service.translate({ text: 'a'.repeat(50) + 'b'.repeat(50) + 'c'.repeat(50) + 'd'.repeat(50), targetLanguage: 'en' }),
    (error) => error.code === 'translation-pane/provider-error',
  )
  assert.equal(calls.length, 2, 'only the already-active fragments may reach the provider')
  assert.deepEqual(calls, ['a'.repeat(50), 'b'.repeat(50)])
})

test('logging: the source text never reaches the log', async (t) => {
  mockFetch(async () => jsonResponse(bingPayload('ok')), t)
  const secret = 'a-very-private-sentence'
  const h = harness()
  await h.service.translate({ text: secret, targetLanguage: 'en' })
  const logged = [...h.logs.debug, ...h.logs.warn].join('\n')
  assert.ok(logged.length > 0, 'the plugin must log something')
  assert.equal(logged.includes(secret), false)
})

test('Remote marker: the descriptor names both methods', () => {
  const h = harness()
  const descriptor = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(h.service), REMOTE_METHODS)
  assert.ok(descriptor, 'the prototype must carry the Remote method descriptor')
  const marker = descriptor.value
  assert.equal(marker.version, 1)
  assert.ok(Object.isFrozen(marker))
  assert.ok(Object.isFrozen(marker.methods))
  assert.deepEqual(
    marker.methods.map((method) => method.method),
    ['describe', 'translate'],
  )
  for (const method of marker.methods) {
    assert.equal(method.invocation.kind, 'direct')
    assert.ok(Object.isFrozen(method))
  }
})

test('tool: the registration carries the documented schema', () => {
  const h = harness()
  const tool = h.tools.find((entry) => entry.name === 'translate_text')
  assert.ok(tool, 'the translate_text tool must be registered')
  assert.equal(tool.parameters.type, 'object')
  assert.equal(tool.parameters.additionalProperties, false)
  assert.deepEqual(tool.parameters.required, ['text', 'targetLanguage'])
  assert.equal(tool.parameters.properties.text.type, 'string')
  assert.equal(tool.parameters.properties.targetLanguage.type, 'string')
  assert.equal(tool.parameters.properties.sourceLanguage.type, 'string')
  assert.equal(tool.output.schema.type, 'object')
  assert.equal(tool.output.schema.additionalProperties, false)
  for (const field of ['text', 'sourceLanguage', 'targetLanguage', 'provider', 'cached', 'durationMs']) {
    assert.ok(tool.output.schema.properties[field], `the output schema must declare ${field}`)
  }
  assert.ok(tool.output.schema.properties.detectedSourceLanguage)
  // Additive routing facts: optional, so an older consumer keeps working.
  assert.equal(tool.output.schema.properties.requestedProvider.type, 'string')
  assert.equal(tool.output.schema.properties.failover.type, 'boolean')
  assert.equal(tool.output.schema.required.includes('requestedProvider'), false)
  assert.equal(tool.output.schema.required.includes('failover'), false)
  assert.equal(tool.isConcurrencySafe(), true)
  assert.match(tool.description, /split into provider-sized requests/)
})

test('tool: execute returns the translation and honours the exec signal', async (t) => {
  mockFetch(async () => jsonResponse(bingPayload('你好')), t)
  const h = harness()
  const tool = h.tools.find((entry) => entry.name === 'translate_text')

  const value = await tool.execute({ text: 'hello', targetLanguage: 'zh-Hans' }, { signal: undefined })
  assert.equal(value.text, '你好')
  assert.equal(value.sourceLanguage, 'auto')
  assert.equal(value.targetLanguage, 'zh-Hans')
  assert.equal(value.provider, 'bing')
  assert.equal(value.cached, false)
  assert.equal(typeof value.durationMs, 'number')

  const controller = new AbortController()
  controller.abort()
  await assert.rejects(tool.execute({ text: 'hello', targetLanguage: 'zh-Hans' }, { signal: controller.signal }))
})

test('tool: execute carries the additive routing facts on a failover', async (t) => {
  mockFetch(async (url) => {
    if (String(url).includes('microsoft')) throw new TypeError('fetch failed')
    return jsonResponse([[['你好', 'hello', null, null, 10]], null, 'en'])
  }, t)

  const h = harness()
  const tool = h.tools.find((entry) => entry.name === 'translate_text')
  const value = await tool.execute({ text: 'hello', targetLanguage: 'zh-Hans' }, { signal: undefined })

  assert.equal(value.text, '你好')
  assert.equal(value.provider, 'google', 'the tool reports the provider that served')
  assert.equal(value.requestedProvider, 'bing', 'the tool reports the default provider asked for')
  assert.equal(value.failover, true)
  assert.equal(typeof value.durationMs, 'number')
  assert.equal(value.cached, false)
})

test('tool: execute surfaces the same provider-unreachable code as the panel', async (t) => {
  mockFetch(async () => {
    throw new TypeError('fetch failed')
  }, t)

  const h = harness()
  const tool = h.tools.find((entry) => entry.name === 'translate_text')
  await assert.rejects(
    tool.execute({ text: 'hello', targetLanguage: 'zh-Hans' }, { signal: undefined }),
    (error) => {
      assert.equal(error.code, 'translation-pane/provider-unreachable')
      assert.equal(error.isDSHRemoteError, true)
      return true
    },
  )
})


test('splitter: complete inline syntax tokens stay inside one fragment', () => {
  const cases = [
    { token: '{{customer_id}}', maxChars: 24 },
    { token: '`customer_id`', maxChars: 24 },
    { token: '<span data-id="customer">', maxChars: 36 },
    { token: '[account guide](https://example.com/account/reference)', maxChars: 64 },
    { token: 'https://example.com/path/to/resource', maxChars: 48 },
    { prefix: 'x\n', token: '```json\n', maxChars: 8 },
  ]

  for (const { token, maxChars, prefix = 'x'.repeat(20) } of cases) {
    const source = `${prefix}${token}${' y'.repeat(40)}`
    const fragments = splitText(source, maxChars)
    assert.equal(fragments.join(''), source, 'protected splitting must preserve every source character')
    assert.ok(fragments.some((fragment) => fragment.includes(token)), `token must remain whole: ${token}`)
    for (const fragment of fragments) {
      assert.ok(fragment.length <= maxChars, 'no fragment may exceed the provider limit')
    }
  }
})

test('splitter: boundaries preserve combining marks and emoji grapheme clusters', () => {
  const cases = [
    { source: 'a'.repeat(7) + 'é' + 'z'.repeat(20), maxChars: 8 },
    { source: 'a'.repeat(9) + '👩🏽‍💻' + 'z'.repeat(20), maxChars: 12 },
  ]

  for (const { source, maxChars } of cases) {
    const fragments = splitText(source, maxChars)
    assert.equal(fragments.join(''), source)
    for (const fragment of fragments) assert.ok(fragment.length <= maxChars)

    const boundaries = new Set()
    let offset = 0
    for (const fragment of fragments.slice(0, -1)) {
      offset += fragment.length
      boundaries.add(offset)
    }
    const graphemeBoundaries = new Set([0])
    for (const item of new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(source)) {
      graphemeBoundaries.add(item.index + item.segment.length)
    }
    for (const boundary of boundaries) {
      assert.ok(graphemeBoundaries.has(boundary), `fragment boundary ${boundary} must not split a grapheme`)
    }
  }
})

test('splitter: oversized graphemes fall back to code-point-safe boundaries', () => {
  // One grapheme exceeds the provider limit. The splitter may separate its
  // combining marks, but it must never emit half of the emoji surrogate pair.
  const source = '😀' + '\u0301'.repeat(8) + 'tail'
  const fragments = splitText(source, 3)

  assert.equal(fragments.join(''), source)
  for (const fragment of fragments) {
    assert.ok(fragment.length <= 3)
    assert.equal(/[\uD800-\uDBFF]$/.test(fragment), false, 'a fragment must not end with a high surrogate')
    assert.equal(/^[\uDC00-\uDFFF]/.test(fragment), false, 'a fragment must not start with a low surrogate')
  }
})

test('splitter: a fragment limit smaller than one Unicode code point fails safely', () => {
  assert.throws(() => splitText('😀x', 1), RangeError)
})

test('splitter: mixed-language and RTL text remains lossless around markup', () => {
  const source = [
    'English paragraph with 中文内容 and 日本語.',
    '```js',
    'const label = "{{account_name}}"',
    '```',
    '<span lang="ar">مرحبا بالعالم</span>',
    '[Documentation](https://example.com/docs)',
  ].join('\n\n')
  const fragments = splitText(source, 48)
  assert.equal(fragments.join(''), source)
  for (const fragment of fragments) {
    assert.ok(fragment.length <= 48)
  }
})

test('JSON mode translates only string values and preserves the original document layout', async (t) => {
  const requests = []
  mockFetch(async (_url, init) => {
    const source = JSON.parse(init.body)[0]
    requests.push(source)
    return jsonResponse(bingPayload(`translated:${source}`))
  }, t)

  const h = harness()
  const source = '{\n  "message": "hello",\n  "nested": { "label": "world", "count": 2, "enabled": true, "empty": "" },\n  "items": ["one", null, 3, {"name": "Ada"}]\n}'
  const result = await h.service.translate({
    text: source,
    targetLanguage: 'zh-Hans',
    format: 'json',
  })

  const expected = '{\n  "message": "translated:hello",\n  "nested": { "label": "translated:world", "count": 2, "enabled": true, "empty": "" },\n  "items": ["translated:one", null, 3, {"name": "translated:Ada"}]\n}'
  assert.equal(result.text, expected)
  assert.deepEqual(JSON.parse(result.text), {
    message: 'translated:hello',
    nested: { label: 'translated:world', count: 2, enabled: true, empty: '' },
    items: ['translated:one', null, 3, { name: 'translated:Ada' }],
  })
  assert.deepEqual(requests.sort(), ['Ada', 'hello', 'one', 'world'])
})

test('JSON mode rejects oversized input before attempting JSON parsing', async (t) => {
  let calls = 0
  mockFetch(async () => {
    calls += 1
    return jsonResponse(bingPayload('unexpected'))
  }, t)
  const h = harness({ config: { maxTextChars: 32 } })

  await assert.rejects(
    h.service.translate({ text: '{' + 'x'.repeat(64), targetLanguage: 'zh-Hans', format: 'json' }),
    (error) => error.code === 'translation-pane/text-limit',
  )
  assert.equal(calls, 0)
})

test('JSON mode rejects malformed JSON before contacting a provider', async (t) => {
  let calls = 0
  mockFetch(async () => {
    calls += 1
    return jsonResponse(bingPayload('unexpected'))
  }, t)
  const h = harness()

  await assert.rejects(
    h.service.translate({ text: '{"label": "unterminated}', targetLanguage: 'zh-Hans', format: 'json' }),
    (error) => error.code === 'translation-pane/invalid-request',
  )
  assert.equal(calls, 0)
})

test('JSON mode splits long string values and rejoins them without changing JSON structure', async (t) => {
  const bodies = []
  mockFetch(async (_url, init) => {
    const fragment = JSON.parse(init.body)[0]
    bodies.push(fragment)
    return jsonResponse(bingPayload(fragment.toUpperCase()))
  }, t)
  const h = harness({ config: { fragmentChars: 100 } })
  const value = 'a'.repeat(60) + '\n\n' + 'b'.repeat(60)
  const source = `{"keep":42,"text":${JSON.stringify(value)},"flag":false}`
  const result = await h.service.translate({ text: source, targetLanguage: 'zh-Hans', format: 'json' })

  assert.equal(bodies.length, 2)
  assert.equal(bodies.join(''), value)
  assert.deepEqual(JSON.parse(result.text), { keep: 42, text: value.toUpperCase(), flag: false })
})

test('JSON mode leaves documents without string values unchanged and makes no provider request', async (t) => {
  let calls = 0
  mockFetch(async () => {
    calls += 1
    return jsonResponse(bingPayload('unexpected'))
  }, t)
  const h = harness()
  const source = '{ "count": 1, "enabled": false, "value": null, "items": [2, true] }'
  const result = await h.service.translate({ text: source, targetLanguage: 'zh-Hans', format: 'json' })

  assert.equal(result.text, source)
  assert.equal(result.provider, 'none')
  assert.equal(calls, 0)
})


test('Markdown mode sends only prose to the provider and restores protected syntax', async (t) => {
  const bodies = []
  mockFetch(async (_url, init) => {
    const fragment = JSON.parse(init.body)[0]
    bodies.push(fragment)
    return jsonResponse(bingPayload(fragment.toUpperCase()))
  }, t)
  const h = harness({ config: { fragmentChars: 100 } })
  const tick = String.fromCharCode(96)
  const fence = tick.repeat(3)
  const source = [
    '# Welcome **reader**',
    '',
    '- Read ' + tick + 'const value = 1' + tick + ' and [the guide](https://example.test/docs).',
    '- Keep {{account.name}} and ' + '$' + '{runtime.value} unchanged.',
    '',
    fence + 'js',
    'const secret = "do not translate";',
    fence,
    'Use <kbd>Ctrl</kbd> and https://example.test/path.',
  ].join('\n')
  const result = await h.service.translate({
    text: source,
    targetLanguage: 'zh-Hans',
    format: 'markdown',
  })

  const submitted = bodies.join('')
  assert.ok(bodies.length > 0)
  for (const token of [
    'const value = 1',
    'https://example.test/docs',
    '{{account.name}}',
    '$' + '{runtime.value}',
    'const secret = "do not translate";',
    '<kbd>',
    '</kbd>',
    'https://example.test/path',
  ]) {
    assert.equal(submitted.includes(token), false, token + ' must not reach the provider')
    assert.ok(result.text.includes(token), token + ' must be restored unchanged')
  }
  assert.ok(result.text.includes(fence + 'js\nconst secret = "do not translate";\n' + fence))
  assert.ok(result.text.startsWith('# WELCOME **READER**'))
  assert.ok(result.text.includes('[THE GUIDE](https://example.test/docs)'))
  assert.equal(result.provider, 'bing')
})

test('Markdown code-only documents do not make provider requests', async (t) => {
  let calls = 0
  mockFetch(async () => {
    calls += 1
    return jsonResponse(bingPayload('unexpected'))
  }, t)
  const h = harness()
  const tick = String.fromCharCode(96)
  const fence = tick.repeat(3)
  const source = fence + 'json\n{"secret":"value"}\n' + fence + '\n' + tick + 'const x = 1' + tick
  const result = await h.service.translate({
    text: source,
    targetLanguage: 'zh-Hans',
    format: 'markdown',
  })
  assert.equal(result.text, source)
  assert.equal(result.provider, 'none')
  assert.equal(calls, 0)
})

test('translate_text agent tool exposes and forwards Markdown format', async (t) => {
  const submitted = []
  mockFetch(async (_url, init) => {
    const fragment = JSON.parse(init.body)[0]
    submitted.push(fragment)
    return jsonResponse(bingPayload('T:' + fragment))
  }, t)
  const h = harness()
  const tool = h.tools.find((entry) => entry.name === 'translate_text')
  assert.deepEqual(tool.parameters.properties.format.enum, ['text', 'json', 'markdown'])
  const tick = String.fromCharCode(96)
  const fence = tick.repeat(3)
  const source = ['# Hello', '', fence + 'js', 'const value = 1', fence].join('\n')
  const result = await tool.execute(
    { text: source, targetLanguage: 'zh-Hans', format: 'markdown' },
    { signal: new AbortController().signal },
  )
  assert.ok(submitted.length > 0)
  assert.equal(submitted.join(''), 'Hello\n\n')
  assert.ok(result.text.startsWith('# T:Hello'))
  assert.ok(result.text.includes(fence + 'js\nconst value = 1\n' + fence))
})

test('format is part of the cache key and defaults to text', async (t) => {
  const bodies = []
  mockFetch(async (_url, init) => {
    const fragment = JSON.parse(init.body)[0]
    bodies.push(fragment)
    return jsonResponse(bingPayload(`T:${fragment}`))
  }, t)
  const h = harness()
  const source = '{"label":"hello"}'

  const textResult = await h.service.translate({ text: source, targetLanguage: 'zh-Hans' })
  const jsonResult = await h.service.translate({ text: source, targetLanguage: 'zh-Hans', format: 'json' })

  assert.equal(textResult.text, `T:${source}`)
  assert.equal(jsonResult.text, '{"label":"T:hello"}')
  assert.deepEqual(bodies, [source, 'hello'])
})

test('translate_text agent tool exposes and forwards JSON format', async (t) => {
  mockFetch(async (_url, init) => jsonResponse(bingPayload(`T:${JSON.parse(init.body)[0]}`)), t)
  const h = harness()
  const tool = h.tools.find((entry) => entry.name === 'translate_text')

  assert.deepEqual(tool.parameters.properties.format.enum, ['text', 'json', 'markdown'])
  const result = await tool.execute(
    { text: '{"message":"hello"}', targetLanguage: 'zh-Hans', format: 'json' },
    { signal: new AbortController().signal },
  )
  assert.equal(result.text, '{"message":"T:hello"}')
})

test('dispatch: the first concurrent fragment failure wins and failed work is never cached', async (t) => {
  const calls = []
  let failedAttempt = true
  mockFetch(async (_url, init) => {
    const fragment = JSON.parse(init.body)[0]
    calls.push(fragment)
    if (failedAttempt && fragment.startsWith('a')) {
      await new Promise((resolve) => setTimeout(resolve, 15))
      return new Response('bad request', { status: 400 })
    }
    if (failedAttempt && fragment.startsWith('b')) {
      return new Response('rate limited', { status: 429 })
    }
    return jsonResponse(bingPayload(`translated:${fragment}`))
  }, t)

  const h = harness({
    config: { fragmentChars: 50, maxConcurrency: 2, failover: false, maxRetries: 0 },
  })
  const source = JSON.stringify({ a: 'a'.repeat(50), b: 'b'.repeat(50) })

  await assert.rejects(
    h.service.translate({ text: source, targetLanguage: 'en', format: 'json' }),
    (error) => {
      assert.equal(error.code, 'translation-pane/rate-limited')
      assert.equal(error.details.status, 429)
      return true
    },
  )
  assert.equal(calls.length, 2, 'both already-claimed fragments may settle, but no queued work starts')

  failedAttempt = false
  const result = await h.service.translate({ text: source, targetLanguage: 'en', format: 'json' })
  assert.deepEqual(JSON.parse(result.text), {
    a: `translated:${'a'.repeat(50)}`,
    b: `translated:${'b'.repeat(50)}`,
  })
  assert.equal(calls.length, 4, 'the failed partial demand must not have populated the cache')
  assert.equal(result.cached, false)
})

test('dispatch: the first failed fragment aborts other already-running provider requests', async (t) => {
  const calls = []
  let secondRequestAborted = false
  mockFetch(async (_url, init) => {
    const fragment = JSON.parse(init.body)[0]
    calls.push(fragment)
    if (fragment.startsWith('a')) {
      await new Promise((resolve) => setTimeout(resolve, 20))
      return new Response('bad request', { status: 400 })
    }
    return await new Promise((resolve, reject) => {
      const abort = () => {
        secondRequestAborted = true
        reject(init.signal.reason ?? new DOMException('Aborted', 'AbortError'))
      }
      if (init.signal.aborted) abort()
      else init.signal.addEventListener('abort', abort, { once: true })
    })
  }, t)

  const h = harness({
    config: { fragmentChars: 50, maxConcurrency: 2, failover: false, maxRetries: 0, timeoutMs: 1000 },
  })
  const source = JSON.stringify({
    a: 'a'.repeat(50),
    b: 'b'.repeat(50),
    c: 'c'.repeat(50),
  })

  await assert.rejects(
    h.service.translate({ text: source, targetLanguage: 'en', format: 'json' }),
    (error) => error.code === 'translation-pane/provider-error',
  )
  assert.deepEqual(calls, ['a'.repeat(50), 'b'.repeat(50)])
  assert.equal(secondRequestAborted, true, 'the in-flight request must be cancelled immediately')
})

test('JSON mode stops dispatching queued values after the first provider failure', async (t) => {
  const calls = []
  mockFetch(async (_url, init) => {
    const fragment = JSON.parse(init.body)[0]
    calls.push(fragment)
    if (fragment.startsWith('a')) return new Response('bad request', { status: 400 })
    await new Promise((resolve) => setTimeout(resolve, 10))
    return jsonResponse(bingPayload('ok'))
  }, t)

  const h = harness({
    config: { fragmentChars: 50, maxConcurrency: 2, failover: false, maxRetries: 0 },
  })
  const source = JSON.stringify({ a: 'a'.repeat(50), b: 'b'.repeat(50), c: 'c'.repeat(50), d: 'd'.repeat(50) })
  await assert.rejects(
    h.service.translate({ text: source, targetLanguage: 'en', format: 'json' }),
    (error) => error.code === 'translation-pane/provider-error',
  )
  assert.equal(calls.length, 2)
  assert.deepEqual(calls, ['a'.repeat(50), 'b'.repeat(50)])
})



test('JSON mode safely handles escaped keys and values plus translated JSON metacharacters', async (t) => {
  const requests = []
  mockFetch(async (_url, init) => {
    requests.push(JSON.parse(init.body)[0])
    return jsonResponse(bingPayload('译文 "quoted" \\ path\n🚀'))
  }, t)

  const h = harness()
  const source = String.raw`{"k\"ey":"hello\nworld","slash":"a\\b","unicode":"\uD83D\uDE80"}`
  const result = await h.service.translate({
    text: source,
    targetLanguage: 'zh-Hans',
    format: 'json',
  })

  assert.deepEqual(requests, ['hello\nworld', 'a\\b', '🚀'])
  assert.ok(result.text.startsWith(String.raw`{"k\"ey":`), 'escaped object keys must remain byte-for-byte unchanged')
  assert.deepEqual(JSON.parse(result.text), {
    'k"ey': '译文 "quoted" \\ path\n🚀',
    slash: '译文 "quoted" \\ path\n🚀',
    unicode: '译文 "quoted" \\ path\n🚀',
  })
})


test('JSON mode keeps grapheme clusters intact across provider fragment boundaries', async (t) => {
  const fragments = []
  mockFetch(async (_url, init) => {
    const fragment = JSON.parse(init.body)[0]
    fragments.push(fragment)
    return jsonResponse(bingPayload(fragment))
  }, t)

  const h = harness({ config: { fragmentChars: 12 } })
  const value = 'a'.repeat(7) + 'e\\u0301' + 'z'.repeat(10) + 'x'.repeat(9) + '👩🏽‍💻' + 'q'.repeat(20)
  const source = JSON.stringify({ message: value })
  const result = await h.service.translate({
    text: source,
    targetLanguage: 'zh-Hans',
    format: 'json',
  })

  assert.deepEqual(JSON.parse(result.text), { message: value })
  assert.ok(fragments.length > 2)
  for (const fragment of fragments) assert.ok(fragment.length <= 12)

  const boundaries = new Set()
  let offset = 0
  for (const fragment of fragments.slice(0, -1)) {
    offset += fragment.length
    boundaries.add(offset)
  }
  const graphemeBoundaries = new Set([0])
  for (const item of new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(value)) {
    graphemeBoundaries.add(item.index + item.segment.length)
  }
  for (const boundary of boundaries) {
    assert.ok(graphemeBoundaries.has(boundary), `JSON provider fragment boundary ${boundary} must not split a grapheme`)
  }
})


test('timeout: a request deadline after response headers preserves the structured timeout error', async (t) => {
  let calls = 0
  mockFetch(async (_url, init) => {
    calls += 1
    const body = new ReadableStream({
      start(controller) {
        init.signal.addEventListener('abort', () => {
          controller.error(new DOMException('The operation was aborted.', 'AbortError'))
        }, { once: true })
      },
    })
    return new Response(body)
  }, t)

  const h = harness({ config: { timeoutMs: 30, attemptTimeoutMs: 1000 } })
  await assert.rejects(
    h.service.translate({ text: 'hello', targetLanguage: 'en', provider: 'google' }),
    (error) => {
      assert.equal(error.code, 'translation-pane/timeout')
      assert.equal(error.details.timeoutMs, 30)
      return true
    },
  )
  assert.equal(calls, 1, 'an overall request deadline must not fail over to another provider')
})


test('timeout: the shipped translator preserves the request deadline during cancellation', async () => {
  for (const settle of ['reject', 'resolve']) {
    const translator = fakeTranslator({
      translate: (_spec, signal) => new Promise((resolve, reject) => {
        signal.addEventListener('abort', () => {
          if (settle === 'reject') {
            reject(new DOMException('The operation was aborted.', 'AbortError'))
          } else {
            resolve('late translation')
          }
        }, { once: true })
      }),
    })
    const h = harness({
      translator,
      config: { timeoutMs: 30 },
    })
    await assert.rejects(
      h.service.translate({ text: 'hello', targetLanguage: 'en' }),
      (error) => {
        assert.equal(error.code, 'translation-pane/timeout')
        assert.equal(error.details.timeoutMs, 30)
        return true
      },
    )
    await h.unload()
  }
})


test('cancellation: an abort after error response headers wins over HTTP status', async (t) => {
  const controller = new AbortController()
  const reason = new Error('caller left after response headers')
  mockFetch(async () => {
    const response = new Response(new ReadableStream({
      cancel: () => new Promise(() => {}),
    }), { status: 503 })
    controller.abort(reason)
    return response
  }, t)
  const h = harness()
  await assert.rejects(
    h.service.translateRequest({ text: 'hi', targetLanguage: 'en' }, controller.signal),
    (error) => error === reason,
  )
})

test('response: an oversized stream is rejected without awaiting a stalled cancel hook', async (t) => {
  mockFetch(async () => new Response(new ReadableStream({
    start(stream) {
      stream.enqueue(new Uint8Array(128))
    },
    cancel: () => new Promise(() => {}),
  })), t)
  const h = harness({ config: { maxResponseBytes: 64, timeoutMs: 1000 } })
  await assert.rejects(
    h.service.translate({ text: 'hi', targetLanguage: 'en' }),
    (error) => {
      assert.equal(error.code, 'translation-pane/invalid-response')
      assert.equal(error.details.limit, 64)
      return true
    },
  )
})


test('unload: disposed services reject empty, cached, and new demands', async (t) => {
  let calls = 0
  mockFetch(async () => {
    calls += 1
    return jsonResponse(bingPayload('ok'))
  }, t)
  const h = harness()
  await h.service.translate({ text: 'cached', targetLanguage: 'en' })
  const cacheHits = h.service.describe().cacheHits
  await h.unload()

  for (const request of [
    { text: '', targetLanguage: 'en' },
    { text: 'cached', targetLanguage: 'en' },
    { text: 'new demand', targetLanguage: 'en' },
  ]) {
    await assert.rejects(
      h.service.translateRequest(request),
      (error) => error.message === 'translationPane: the service was unloaded',
    )
  }
  assert.equal(calls, 1, 'no provider request may start after unload')
  assert.equal(h.service.describe().cacheHits, cacheHits, 'a disposed cache must not serve hits')
})


test('unload: waiters release when a translator ignores abort forever', { timeout: 1000 }, async () => {
  const h = harness({
    translator: {
      maxTextChars: 4000,
      resolve: (request) => request,
      translate: () => new Promise(() => {}),
    },
  })
  const pending = h.service.translate({ text: 'never settles', targetLanguage: 'en' })
  await Promise.resolve()
  assert.equal(h.service.inflight.size, 1, 'the shared request should be registered')
  const [entry] = h.service.inflight.values()
  assert.ok(entry, 'the shared entry should be observable before unload')
  await h.unload()

  await assert.rejects(
    pending,
    (error) => error.message === 'translationPane: the service was unloaded',
  )
  await assert.rejects(
    entry.promise,
    (error) => error.message === 'translationPane: the service was unloaded',
  )
  assert.equal(h.service.inflight.size, 0, 'unload must release the abandoned in-flight entry')
})


test('unload: a late empty-JSON completion cannot populate the cache', async (t) => {
  const h = harness()
  const pending = h.service.translateRequest({ text: '{"empty":""}', format: 'json', targetLanguage: 'en' })
  await h.unload()

  await assert.rejects(
    pending,
    (error) => error.message === 'translationPane: the service was unloaded',
  )
  assert.equal(h.service.cache.size, 0, 'an unloaded service must not publish a late cache entry')
})

test('concurrency: a failed fragment prevents queued fragments from being dispatched', async (t) => {
  const calls = []
  mockFetch(async (_url, init) => {
    const fragment = JSON.parse(init.body)[0]
    calls.push(fragment)
    if (fragment.startsWith('a')) return new Response('bad request', { status: 400 })
    await new Promise((resolve) => setTimeout(resolve, 10))
    return jsonResponse(bingPayload('ok'))
  }, t)

  const h = harness({
    config: { fragmentChars: 50, maxConcurrency: 2, failover: false, maxRetries: 0 },
  })
  await assert.rejects(
    h.service.translate({ text: 'a'.repeat(50) + 'b'.repeat(50) + 'c'.repeat(50) + 'd'.repeat(50), targetLanguage: 'en' }),
    (error) => error.code === 'translation-pane/provider-error',
  )
  assert.equal(calls.length, 2, 'only the already-active fragments may reach the provider')
  assert.deepEqual(calls, ['a'.repeat(50), 'b'.repeat(50)])
})
