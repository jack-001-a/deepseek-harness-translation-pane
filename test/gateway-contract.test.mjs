/**
 * Wire-contract tests for @ybbmm/dsh-translation-pane.
 *
 * The API Gateway derives a Remote method's wire fields from the method's
 * PARAMETER NAMES, rejects any argument the descriptor does not name, and
 * dispatches the call positionally in that same order. A plugin therefore
 * cannot be correct in isolation: a method whose signature and the browser's
 * payload disagree fail at runtime with `gateway/arguments-invalid`, long
 * after the unit tests pass.
 *
 * These tests re-implement that derivation, validation and dispatch exactly
 * as the shipped Gateway (`@deepseek-ai/dsh-api-gateway`) does it, and drive
 * the real module through it with the payload the browser half actually
 * sends. They are the guard against the two halves drifting apart.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { apply } from '../index.js'

const REMOTE_METHODS = '@deepseek-ai/dsh-typert-protocol/remote-methods'

/**
 * Derive a method's parameter names, exactly as the Gateway does.
 *
 * The Gateway reads the method's source text rather than any metadata, so a
 * default value, a destructuring pattern or a rest parameter would make the
 * signature unparseable. This port keeps that behaviour faithfully.
 * @param service - the service instance holding the method.
 * @param method - the method name.
 * @param endpoint - the endpoint, for the error message.
 * @returns the parameter names, in declaration order.
 */
function methodParameterNames(service, method, endpoint) {
  let prototype = Object.getPrototypeOf(service)
  let implementation
  while (prototype !== null) {
    const descriptor = Object.getOwnPropertyDescriptor(prototype, method)
    if (descriptor !== undefined) {
      if ('value' in descriptor && typeof descriptor.value === 'function') {
        implementation = descriptor.value
      }
      break
    }
    prototype = Object.getPrototypeOf(prototype)
  }
  if (implementation === undefined) {
    throw new Error(`gateway/method-unavailable ${endpoint}`)
  }
  const source = Function.prototype.toString.call(implementation)
  const open = source.indexOf('(')
  const close = source.indexOf(')', open + 1)
  if (open < 0 || close < 0) {
    throw new Error(`gateway/signature-invalid ${endpoint}`)
  }
  const body = source.slice(open + 1, close).trim()
  if (body.length === 0) return []
  const names = new Set()
  for (const part of body.split(',').map((entry) => entry.trim())) {
    if (!/^[$A-Z_a-z][$\w]*$/u.test(part) || names.has(part)) {
      throw new Error(`gateway/signature-invalid ${endpoint}`)
    }
    names.add(part)
  }
  return [...names]
}

/**
 * Build the descriptor the Gateway derives for one Remote method.
 * @param service - the service instance.
 * @param method - the method name.
 * @param endpoint - the endpoint, for the error message.
 * @returns the descriptor: its parameters, their wire fields and its
 * cancellation slot.
 */
function deriveDescriptor(service, method, endpoint) {
  const names = methodParameterNames(service, method, endpoint)
  const signalIndex = names.indexOf('signal')
  if (signalIndex >= 0 && signalIndex !== names.length - 1) {
    throw new Error(`gateway/signature-invalid ${endpoint}: signal must be last`)
  }
  const cancellation = signalIndex >= 0 ? { parameter: 'signal' } : undefined
  const businessNames = cancellation === undefined ? names : names.slice(0, -1)
  const wires = new Set()
  const parameters = []
  for (const name of businessNames) {
    if (wires.has(name)) {
      throw new Error(`gateway/signature-invalid ${endpoint}: duplicate wire ${name}`)
    }
    wires.add(name)
    parameters.push({ name, wire: name, source: 'json', codec: { mode: 'src-json' } })
  }
  return { method, parameters, cancellation }
}

/**
 * Reject any argument the descriptor does not name, exactly as the Gateway does.
 * @param args - the payload the browser sent.
 * @param descriptor - the derived descriptor.
 * @param endpoint - the endpoint, for the error message.
 */
function assertExactArguments(args, descriptor, endpoint) {
  if (args === null || typeof args !== 'object' || Array.isArray(args)) {
    throw new Error(`gateway/arguments-invalid ${endpoint}: args must be a plain object`)
  }
  const expected = new Set(descriptor.parameters.map((parameter) => parameter.wire))
  const extra = Reflect.ownKeys(args).filter(
    (key) => typeof key !== 'string' || !expected.has(key),
  )
  // Every SRC-derived parameter uses the `src-json` codec, which tolerates an
  // absent field: the Gateway then passes `undefined` in that position.
  const acceptsMissing = new Set(
    descriptor.parameters
      .filter(
        (parameter) =>
          parameter.source === 'json' &&
          (parameter.acceptsUndefined === true || parameter.codec.mode === 'src-json'),
      )
      .map((parameter) => parameter.wire),
  )
  const missing = [...expected].filter(
    (key) => !Object.hasOwn(args, key) && !acceptsMissing.has(key),
  )
  if (extra.length === 0 && missing.length === 0) return
  const clauses = []
  if (missing.length > 0) clauses.push(`missing ${missing.map((key) => JSON.stringify(key)).join(', ')}`)
  if (extra.length > 0) clauses.push(`unexpected ${extra.map((key) => JSON.stringify(String(key))).join(', ')}`)
  throw new Error(`gateway/arguments-invalid ${endpoint}: ${clauses.join('; ')}`)
}

/**
 * Decode the arguments the descriptor names into a validated record.
 * @param descriptor - the derived descriptor.
 * @param args - the payload the browser sent.
 * @returns the validated record.
 */
function validateArguments(descriptor, args) {
  const entries = []
  for (const parameter of descriptor.parameters) {
    if (!Object.hasOwn(args, parameter.wire)) continue
    entries.push([parameter.wire, args[parameter.wire]])
  }
  return Object.fromEntries(entries)
}

/**
 * Call a Remote method the way the Gateway does.
 *
 * The arguments are assembled in the descriptor's order, an absent field
 * keeps its position as `undefined`, and the cancellation signal is appended
 * last when the method declares one.
 * @param service - the service instance.
 * @param method - the method name.
 * @param args - the payload the browser sent.
 * @param signal - the caller's cancellation.
 * @returns the method's return value.
 */
async function callRemote(service, method, args, signal = new AbortController().signal) {
  const endpoint = `translationPane/${method}`
  const descriptor = deriveDescriptor(service, method, endpoint)
  assertExactArguments(args, descriptor, endpoint)
  const validated = validateArguments(descriptor, args)
  const positional = descriptor.parameters.map((parameter) =>
    Object.hasOwn(validated, parameter.wire) ? validated[parameter.wire] : undefined,
  )
  if (descriptor.cancellation !== undefined) positional.push(signal)
  return await service[method](...positional)
}

/**
 * Build a fake Cordis context and capture the registered service.
 * @returns the captured service.
 */
function harness() {
  const services = new Map()
  const ctx = {
    get: (name) => services.get(name),
    logger: { debug: () => {}, warn: () => {} },
    reflect: {
      provide: (name, value) => {
        services.set(name, value)
      },
    },
    effect: () => {},
    tools: {
      register: () => () => {},
    },
  }
  apply(ctx, {})
  const service = services.get('translationPane')
  assert.ok(service, 'apply() must provide the translationPane service')
  return service
}

test('the browser payload shape passes the Gateway argument check', () => {
  const service = harness()
  const descriptor = deriveDescriptor(service, 'translate', 'translationPane/translate')
  // The browser half sends these four fields and nothing else.
  const payload = {
    text: 'hello',
    sourceLanguage: 'auto',
    targetLanguage: 'zh-Hans',
    provider: 'bing',
    format: 'json',
  }
  assert.doesNotThrow(() => assertExactArguments(payload, descriptor, 'translationPane/translate'))
})

test('the nested request shape passes the Gateway argument check', () => {
  const service = harness()
  const descriptor = deriveDescriptor(service, 'translate', 'translationPane/translate')
  const payload = { request: { text: 'hello', targetLanguage: 'zh-Hans' } }
  assert.doesNotThrow(() => assertExactArguments(payload, descriptor, 'translationPane/translate'))
})

test('an argument the descriptor does not name is rejected', () => {
  const service = harness()
  const descriptor = deriveDescriptor(service, 'translate', 'translationPane/translate')
  assert.throws(
    () => assertExactArguments({ text: 'hello', nonsense: true }, descriptor, 'translationPane/translate'),
    /gateway\/arguments-invalid/,
  )
})

test('the flat payload reaches the method with the right positional values', async () => {
  const service = harness()
  const received = []
  const original = service.translateRequest
  service.translateRequest = async (request, signal) => {
    received.push({ request, signal })
    return { text: request.text, sourceLanguage: request.sourceLanguage, targetLanguage: request.targetLanguage, provider: request.provider ?? 'bing', cached: false, durationMs: 0 }
  }
  try {
    await callRemote(service, 'translate', {
      text: 'hello',
      sourceLanguage: 'en',
      targetLanguage: 'zh-Hans',
      provider: 'bing',
    })
  } finally {
    service.translateRequest = original
  }
  assert.equal(received.length, 1)
  assert.equal(received[0].request.text, 'hello')
  assert.equal(received[0].request.sourceLanguage, 'en')
  assert.equal(received[0].request.targetLanguage, 'zh-Hans')
  assert.equal(received[0].request.provider, 'bing')
})

test('the nested payload reaches the method with the right values', async () => {
  const service = harness()
  const received = []
  const original = service.translateRequest
  service.translateRequest = async (request) => {
    received.push(request)
    return { text: request.text, sourceLanguage: request.sourceLanguage, targetLanguage: request.targetLanguage, provider: 'bing', cached: false, durationMs: 0 }
  }
  try {
    await callRemote(service, 'translate', {
      request: { text: 'nested', targetLanguage: 'en' },
    })
  } finally {
    service.translateRequest = original
  }
  assert.equal(received.length, 1)
  assert.equal(received[0].text, 'nested')
  assert.equal(received[0].targetLanguage, 'en')
})

test('the cancellation signal reaches the method as its last argument', async () => {
  const service = harness()
  const controller = new AbortController()
  const received = []
  const original = service.translateRequest
  service.translateRequest = async (_request, signal) => {
    received.push(signal)
    return { text: '', sourceLanguage: 'auto', targetLanguage: 'en', provider: 'bing', cached: false, durationMs: 0 }
  }
  try {
    await callRemote(service, 'translate', { text: 'x', targetLanguage: 'en' }, controller.signal)
  } finally {
    service.translateRequest = original
  }
  assert.equal(received.length, 1)
  assert.equal(received[0], controller.signal, 'the Gateway injects the caller signal')
})

test('every Remote method has a Gateway-parseable signature', () => {
  const service = harness()
  const marker = Object.getOwnPropertyDescriptor(
    Object.getPrototypeOf(service),
    REMOTE_METHODS,
  )
  assert.ok(marker, 'the prototype must carry the Remote method descriptor')
  for (const method of marker.value.methods) {
    // A default value, a destructuring pattern or a rest parameter makes the
    // Gateway refuse the signature outright.
    assert.doesNotThrow(
      () => methodParameterNames(service, method.method, `translationPane/${method.method}`),
      `${method.method} must use plain identifier parameters`,
    )
  }
})

test('describe is callable with an empty payload', async () => {
  const service = harness()
  const descriptor = deriveDescriptor(service, 'describe', 'translationPane/describe')
  assert.deepEqual(descriptor.parameters, [])
  assert.doesNotThrow(() => assertExactArguments({}, descriptor, 'translationPane/describe'))
  const described = await callRemote(service, 'describe', {})
  assert.equal(typeof described.route, 'string')
  assert.equal(typeof described.maxTextChars, 'number')
})

test('setGlossary is a Gateway-callable Remote method', async () => {
  const service = harness()
  const descriptor = deriveDescriptor(service, 'setGlossary', 'translationPane/setGlossary')
  assert.deepEqual(descriptor.parameters.map((parameter) => parameter.wire), ['payload'])
  const result = await callRemote(service, 'setGlossary', {
    payload: JSON.stringify([{ source: 'API', target: '接口' }]),
  })
  assert.equal(result.count, 1)
  assert.equal((await callRemote(service, 'describe', {})).glossary[0].target, '接口')
})
