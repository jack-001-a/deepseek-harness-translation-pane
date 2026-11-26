/**
 * Host half of the @ybbmm/dsh-translation-pane bundle.
 *
 * Owns two things:
 *
 * 1. `translationPane` — a translation service the browser panel reaches over
 *    the API Gateway's runtime dispatch: a Cordis service carrying a
 *    `typertRemote` binding plus a hand-written Remote method marker.
 * 2. `translate_text` — an agent tool that runs the same code path, so the
 *    panel and the model never drift apart.
 *
 * Translation prefers the shipped `ctx.translator` service when the
 * composition mounts it (that service owns provider routing, request limits,
 * and Session-bound reuse). When it is absent, the service speaks the
 * anonymous Microsoft Edge and Google endpoints directly. Both routes are
 * anonymous: no login, no API key, no Session.
 *
 * Every route is bounded on purpose. One request has a deadline, one
 * response body has a byte cap, one document is split into provider-sized
 * fragments, and the fragments are dispatched with a bounded concurrency. A
 * burst of panel requests is metered by a token bucket, and identical
 * requests are coalesced and cached, so the anonymous endpoints are neither
 * hammered nor asked for the same paragraph twice.
 *
 * The bundle deliberately has no package dependencies — an installed package
 * resolves its imports from its own directory — so every import would have to
 * be a Node built-in. Only `node:buffer` is needed.
 */
import { Buffer } from 'node:buffer'
import { ProviderHealth, TokenBucket, TranslationCache } from './src/host/runtime-state.js'
import { jsonStringValueTokens, splitText } from './src/host/text.js'
import { markdownSegments } from './src/host/markdown.js'
import {
  countTranslationPlanFragments,
  createTranslationPlan,
  inspectGlossary,
  parseGlossaryImport,
  renderTranslationPlans,
} from './src/host/glossary.js'
export { splitText }

/** Cordis service key and API Gateway wire namespace. */
const SERVICE_KEY = 'translationPane'
/** Property the Typert protocol stores Remote method markers under. */
const REMOTE_METHODS = '@deepseek-ai/dsh-typert-protocol/remote-methods'
/** Shared symbol Cordis uses to bind a service value to its owning context. */
const TRACKER = Symbol.for('cordis.tracker')

/** Anonymous Microsoft Edge endpoint, used when the shipped translator is absent. */
const DEFAULT_BING_ENDPOINT = 'https://edge.microsoft.com/translate/translatetext'
/** Anonymous Google endpoint, used when the shipped translator is absent. */
const DEFAULT_GOOGLE_ENDPOINT = 'https://translate.googleapis.com/translate_a/single'
/** Upper bound on one submitted demand, in UTF-16 code units. */
const DEFAULT_MAX_TEXT_CHARS = 20000
/** Size of one provider request; longer text is split before dispatch. */
const DEFAULT_FRAGMENT_CHARS = 3000
/** Wall clock for one complete request, every fragment included. */
const DEFAULT_TIMEOUT_MS = 20000
/** Wait for one provider to start answering, before another provider is tried. */
const DEFAULT_ATTEMPT_TIMEOUT_MS = 3000
/** How long a provider that just failed is avoided in favour of another. */
const DEFAULT_PROVIDER_COOLDOWN_MS = 300000
/** Extra attempts after the first one for a retryable failure. */
const DEFAULT_MAX_RETRIES = 2
/** First back-off delay; doubled per attempt up to the ceiling. */
const DEFAULT_RETRY_BASE_MS = 250
/** Ceiling of the back-off delay. */
const DEFAULT_RETRY_MAX_MS = 4000
/** Largest response body accepted from an anonymous endpoint. */
const DEFAULT_MAX_RESPONSE_BYTES = 1024 * 1024
/** Translated documents kept for reuse. */
const DEFAULT_CACHE_SIZE = 64
/** Approximate UTF-8 byte budget for retained cache keys and translated text. */
const DEFAULT_CACHE_MAX_BYTES = 8 * 1024 * 1024
/** Per-entry allowance for object and Map bookkeeping not represented by string bytes. */
const CACHE_ENTRY_OVERHEAD_BYTES = 256
/** Anonymous provider requests allowed per minute. */
const DEFAULT_RATE_LIMIT_PER_MINUTE = 60
/** Fragments dispatched at the same time. */
const DEFAULT_MAX_CONCURRENCY = 3
/** Waiting provider attempts retained before new demands are rejected as busy. */
const DEFAULT_MAX_QUEUED_REQUESTS = 24
/** Node clamps timer delays above this value to 1 ms; cap configured deadlines. */
const MAX_TIMER_DELAY_MS = 2_147_483_647

/**
 * Failure codes the browser localizes.
 *
 * The names are part of the wire contract: the browser maps each code onto
 * its own copy, and a code it does not know falls back to the generic
 * failure message.
 */
const CODE = Object.freeze({
  invalidRequest: 'translation-pane/invalid-request',
  textLimit: 'translation-pane/text-limit',
  providerUnavailable: 'translation-pane/provider-unavailable',
  // The Host's own network cannot reach the provider. Deliberately distinct
  // from `offline`, which the browser half raises when it loses the Host.
  providerUnreachable: 'translation-pane/provider-unreachable',
  timeout: 'translation-pane/timeout',
  rateLimited: 'translation-pane/rate-limited',
  busy: 'translation-pane/busy',
  providerError: 'translation-pane/provider-error',
  invalidResponse: 'translation-pane/invalid-response',
  // Kept for the shared vocabulary: the browser half raises it against the
  // carrier, and the Host itself never sends it.
  offline: 'translation-pane/offline',
})

/** Languages this Host advertises; other tags pass through to the endpoint. */
const LANGUAGES = Object.freeze([
  'auto',
  'zh-Hans',
  'zh-Hant',
  'en',
  'ja',
  'ko',
  'fr',
  'de',
  'es',
  'ru',
  'pt',
  'it',
  'ar',
  'th',
  'vi',
])

/** Providers the anonymous direct route can serve. */
const DIRECT_PROVIDERS = Object.freeze(['bing', 'google'])

/** Providers the shipped translator route can serve without a durable Session. */
const TRANSLATOR_PROVIDERS = Object.freeze(['bing', 'google'])

/**
 * Language tags accepted from a caller.
 *
 * The tag ends up in a provider URL, so it is matched against a strict
 * BCP-47-shaped pattern: a hostile tag must not be able to append a query
 * parameter of its own.
 */
const LANGUAGE_PATTERN = /^[A-Za-z]{2,3}(-[A-Za-z0-9]{2,8})*$/

/**
 * One translation failure with a stable code and caller-facing message.
 *
 * The Gateway forwards any thrown value carrying the protocol's structural
 * Remote marker unchanged, so `code` crosses the wire instead of folding into
 * `gateway/internal`; a plain Error would lose it.
 */
export class TranslationPaneError extends Error {
  /**
   * @param code - stable failure code the browser localizes.
   * @param message - diagnostic text, also the browser's fallback copy.
   * @param details - structured payload for the browser.
   * @param retryable - whether the provider may be asked again.
   * @param failover - whether another provider may serve the request instead.
   */
  constructor(code, message, details = {}, retryable = false, failover = false) {
    super(message)
    this.name = 'TranslationPaneError'
    this.code = code
    this.details = details
    // Cross-bundle identification: the Gateway tests this marker rather than
    // `instanceof`, because the protocol package resolves separately.
    this.isDSHRemoteError = true
    this.retryable = retryable
    // `retryable` asks the same provider again; `failover` asks a different
    // provider. A 4xx is neither: the request itself is the problem.
    this.failover = failover
  }
}

/**
 * Read an optional service without failing when the composition lacks it.
 * @param ctx - the owning plugin context.
 * @param name - Cordis service key.
 * @returns the service, or `undefined`.
 */
function optionalService(ctx, name) {
  try {
    return ctx.get(name)
  } catch {
    return undefined
  }
}

/**
 * Normalize one caller-supplied language tag.
 * @param tag - raw language tag, possibly omitted.
 * @param fallback - value used when the tag is missing or empty.
 * @param allowAuto - whether `auto` is an acceptable result.
 * @returns a provider language tag.
 * @throws TranslationPaneError when the tag cannot be used safely.
 */
export function normalizeLanguage(tag, fallback, allowAuto) {
  if (typeof tag !== 'string') return fallback
  const trimmed = tag.trim()
  if (trimmed.length === 0) return fallback
  if (trimmed.toLowerCase() === 'auto') {
    if (allowAuto) return 'auto'
    throw new TranslationPaneError(
      CODE.invalidRequest,
      'translationPane: the target language cannot be "auto"',
      { language: trimmed },
    )
  }
  if (!LANGUAGE_PATTERN.test(trimmed)) {
    throw new TranslationPaneError(
      CODE.invalidRequest,
      `translationPane: "${trimmed}" is not a usable language tag`,
      { language: trimmed },
    )
  }
  return trimmed
}

/**
 * Map one language tag onto the tag the given provider expects.
 * @param tag - validated language tag.
 * @param provider - provider id.
 * @returns the provider-specific language tag.
 */
export function providerLanguage(tag, provider) {
  const lower = tag.toLowerCase()
  if (['zh', 'zh-cn', 'zh-sg', 'zh-hans'].includes(lower)) {
    return provider === 'google' ? 'zh-CN' : 'zh-Hans'
  }
  if (['zh-tw', 'zh-hk', 'zh-mo', 'zh-hant'].includes(lower)) {
    return provider === 'google' ? 'zh-TW' : 'zh-Hant'
  }
  return tag
}

/**
 * Find syntax tokens that should not be divided between provider requests.
 * Tokens larger than the request limit are deliberately left splittable.
 * @param text - complete source text.
 * @returns sorted, non-overlapping source ranges.
 */
const HTTP_DATE_MONTHS = Object.freeze({
  Jan: 0, Feb: 1, Mar: 2, Apr: 3, May: 4, Jun: 5,
  Jul: 6, Aug: 7, Sep: 8, Oct: 9, Nov: 10, Dec: 11,
})
const HTTP_DATE_WEEKDAYS = Object.freeze({
  Sun: 0, Sunday: 0,
  Mon: 1, Monday: 1,
  Tue: 2, Tuesday: 2,
  Wed: 3, Wednesday: 3,
  Thu: 4, Thursday: 4,
  Fri: 5, Friday: 5,
  Sat: 6, Saturday: 6,
})
const IMF_FIXDATE_PATTERN =
  /^(Sun|Mon|Tue|Wed|Thu|Fri|Sat), (\d{2}) (Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) (\d{4}) (\d{2}):(\d{2}):(\d{2}) GMT$/
const RFC850_DATE_PATTERN =
  /^(Sunday|Monday|Tuesday|Wednesday|Thursday|Friday|Saturday), (\d{2})-(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)-(\d{2}) (\d{2}):(\d{2}):(\d{2}) GMT$/
const ASCTIME_DATE_PATTERN =
  /^(Sun|Mon|Tue|Wed|Thu|Fri|Sat) (Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) ( [1-9]|[12]\d|3[01]) (\d{2}):(\d{2}):(\d{2}) (\d{4})$/

function makeHttpDateTimestamp(weekdayName, dayText, monthName, year, hourText, minuteText, secondText) {
  const month = HTTP_DATE_MONTHS[monthName]
  const expectedWeekday = HTTP_DATE_WEEKDAYS[weekdayName]
  const day = Number(dayText)
  const hour = Number(hourText)
  const minute = Number(minuteText)
  const second = Number(secondText)
  if (
    month === undefined ||
    expectedWeekday === undefined ||
    !Number.isInteger(year) ||
    day < 1 || day > 31 ||
    hour < 0 || hour > 23 ||
    minute < 0 || minute > 59 ||
    second < 0 || second > 59
  ) return undefined

  // Date.UTC() treats years 0..99 as 1900..1999. HTTP-date carries
  // an explicit four-digit year, so construct the UTC value without that
  // legacy offset (including for years before 0100).
  const date = new Date(0)
  date.setUTCFullYear(year, month, day)
  date.setUTCHours(hour, minute, second, 0)
  const timestamp = date.getTime()
  if (
    !Number.isFinite(timestamp) ||
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month ||
    date.getUTCDate() !== day ||
    date.getUTCHours() !== hour ||
    date.getUTCMinutes() !== minute ||
    date.getUTCSeconds() !== second ||
    date.getUTCDay() !== expectedWeekday
  ) return undefined
  return timestamp
}

function parseHttpDate(value) {
  let match = IMF_FIXDATE_PATTERN.exec(value)
  if (match) {
    return makeHttpDateTimestamp(
      match[1], match[2], match[3], Number(match[4]), match[5], match[6], match[7],
    )
  }

  match = RFC850_DATE_PATTERN.exec(value)
  if (match) {
    const currentYear = new Date(Date.now()).getUTCFullYear()
    let year = Math.floor(currentYear / 100) * 100 + Number(match[4])
    const candidate = Date.UTC(
      year,
      HTTP_DATE_MONTHS[match[3]],
      Number(match[2]),
      Number(match[5]),
      Number(match[6]),
      Number(match[7]),
    )
    const fiftyYearsFromNow = new Date(Date.now())
    fiftyYearsFromNow.setUTCFullYear(fiftyYearsFromNow.getUTCFullYear() + 50)
    // RFC 850's obsolete two-digit year form means the most recent matching
    // past year when the initial interpretation would be over 50 years ahead.
    if (candidate > fiftyYearsFromNow.getTime()) year -= 100
    return makeHttpDateTimestamp(
      match[1], match[2], match[3], year, match[5], match[6], match[7],
    )
  }

  match = ASCTIME_DATE_PATTERN.exec(value)
  if (match) {
    return makeHttpDateTimestamp(
      match[1], match[3], match[2], Number(match[7]), match[4], match[5], match[6],
    )
  }
  return undefined
}

/**
 * Read a `Retry-After` header as a delay.
 * @param value - the raw header value.
 * @returns the delay in milliseconds, or `undefined` when absent or unusable.
 */
function parseRetryAfter(value) {
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim()
  if (trimmed.length === 0) return undefined

  // RFC delay-seconds is one or more decimal digits, not JavaScript's wider
  // Number() grammar (which also accepts signs, fractions and exponent/hex
  // notation). Keep large valid values finite; backoff() applies our cap.
  if (/^\d+$/.test(trimmed)) {
    const seconds = Number(trimmed)
    if (!Number.isFinite(seconds)) return Number.MAX_VALUE
    const milliseconds = seconds * 1000
    return Number.isFinite(milliseconds)
      ? Math.min(milliseconds, MAX_TIMER_DELAY_MS)
      : MAX_TIMER_DELAY_MS
  }

  const when = parseHttpDate(trimmed)
  if (when === undefined) return undefined
  return Math.min(Math.max(0, when - Date.now()), MAX_TIMER_DELAY_MS)
}
/**
 * A bounded least-recently-used map of translated documents.
 *
 * The panel re-translates the same paragraph often and the anonymous
 * endpoints rate-limit, so a small cache removes most of the traffic.
 */
class FairSemaphore {
  /**
   * @param limit - maximum provider attempts active at once.
   * @param maxQueued - maximum pending attempts retained.
   */
  constructor(limit, maxQueued) {
    this.limit = limit
    this.maxQueued = maxQueued
    this.active = 0
    this.queue = []
  }

  /**
   * Acquire one slot in arrival order.
   * @param signal - optional deadline/cancellation signal.
   * @returns an idempotent release callback.
   */
  acquire(signal) {
    if (signal?.aborted) return Promise.reject(this.abortReason(signal))
    if (this.active < this.limit && this.queue.length === 0) {
      this.active += 1
      return Promise.resolve(this.releaseHandle())
    }
    if (this.queue.length >= this.maxQueued) {
      return Promise.reject(
        new TranslationPaneError(
          CODE.busy,
          'translationPane: the local request queue is full',
          { limit: this.maxQueued },
        ),
      )
    }
    return new Promise((resolve, reject) => {
      const waiter = { signal, resolve, reject, onAbort: undefined }
      if (signal !== undefined && signal !== null) {
        waiter.onAbort = () => {
          const index = this.queue.indexOf(waiter)
          if (index >= 0) this.queue.splice(index, 1)
          signal.removeEventListener('abort', waiter.onAbort)
          reject(this.abortReason(signal))
          this.drain()
        }
        signal.addEventListener('abort', waiter.onAbort, { once: true })
      }
      this.queue.push(waiter)
      // Close the small race between the initial check and listener install.
      if (signal?.aborted) waiter.onAbort()
      else this.drain()
    })
  }

  /** @returns an idempotent callback that releases one active slot. */
  releaseHandle() {
    let released = false
    return () => {
      if (released) return
      released = true
      this.active -= 1
      this.drain()
    }
  }

  /** Grant free slots to the oldest live waiters. */
  drain() {
    while (this.active < this.limit && this.queue.length > 0) {
      const waiter = this.queue.shift()
      waiter.signal?.removeEventListener('abort', waiter.onAbort)
      if (waiter.signal?.aborted) {
        waiter.reject(this.abortReason(waiter.signal))
        continue
      }
      this.active += 1
      waiter.resolve(this.releaseHandle())
    }
  }

  /** @param signal - the aborted signal. */
  abortReason(signal) {
    const reason = signal?.reason
    return reason instanceof Error ? reason : new Error('translationPane: the request was cancelled')
  }

  /** Number of provider attempts currently holding a slot. */
  get activeCount() {
    return this.active
  }

  /** Number of live provider attempts waiting for a slot. */
  get queuedCount() {
    return this.queue.length
  }
}


/**
 * Read a positive number from the config.
 * @param value - the raw config value.
 * @param fallback - the default used when the value is unusable.
 * @returns a positive integer.
 */
function positive(value, fallback) {
  if (!Number.isInteger(value) || value <= 0) return fallback
  return value
}

/**
 * Read a non-negative number from the config.
 * @param value - the raw config value.
 * @param fallback - the default used when the value is unusable.
 * @returns a non-negative integer.
 */
function nonNegative(value, fallback) {
  if (!Number.isInteger(value) || value < 0) return fallback
  return value
}

/**
 * Read an HTTP(S) endpoint from the config, without URL credentials or fragments.
 * @param value - the raw config value.
 * @param fallback - the default used when the value is unusable.
 * @returns a normalized endpoint URL.
 */
function endpoint(value, fallback) {
  if (typeof value !== 'string' || value.trim().length === 0) return fallback
  try {
    const url = new URL(value.trim())
    if (
      !['http:', 'https:'].includes(url.protocol) ||
      url.username.length > 0 ||
      url.password.length > 0 ||
      url.hash.length > 0 ||
      url.href.includes('#')
    ) return fallback
    return url.href
  } catch {
    return fallback
  }
}

/**
 * Resolve the plugin config over the code defaults.
 *
 * Every value is validated here, so the rest of the plugin may trust its
 * config: an unusable number falls back to the default instead of breaking a
 * translation at request time.
 * @param config - the row's raw config, possibly empty.
 * @returns a complete, frozen config.
 */
export function resolveConfig(config) {
  const raw = config !== null && typeof config === 'object' ? config : {}
  const maxTextChars = positive(raw.maxTextChars, DEFAULT_MAX_TEXT_CHARS)
  const timeoutMs = positive(raw.timeoutMs, DEFAULT_TIMEOUT_MS)
  const glossaryInspection = inspectGlossary(raw.glossary)
  const glossaryInspection = inspectGlossary(raw.glossary)
  return Object.freeze({
    bingEndpoint: endpoint(raw.bingEndpoint, DEFAULT_BING_ENDPOINT),
    googleEndpoint: endpoint(raw.googleEndpoint, DEFAULT_GOOGLE_ENDPOINT),
    timeoutMs: Math.min(timeoutMs, MAX_TIMER_DELAY_MS),
    // One attempt must never outlive the whole request, so the header deadline
    // is capped by the request deadline.
    attemptTimeoutMs: Math.min(
      positive(raw.attemptTimeoutMs, DEFAULT_ATTEMPT_TIMEOUT_MS),
      Math.min(timeoutMs, MAX_TIMER_DELAY_MS),
    ),
    // The observation window is per service instance, never persisted.
    providerCooldownMs: nonNegative(raw.providerCooldownMs, DEFAULT_PROVIDER_COOLDOWN_MS),
    // Automatic cross-provider failover can be turned off; the direct route
    // then behaves like a single-provider route and keeps its retry budget.
    failover: raw.failover !== false,
    maxTextChars,
    // A fragment larger than the whole demand would only ever be one
    // oversized request, so the fragment size never exceeds the demand.
    fragmentChars: Math.min(positive(raw.fragmentChars, DEFAULT_FRAGMENT_CHARS), maxTextChars),
    maxRetries: nonNegative(raw.maxRetries, DEFAULT_MAX_RETRIES),
    retryBaseMs: Math.min(positive(raw.retryBaseMs, DEFAULT_RETRY_BASE_MS), MAX_TIMER_DELAY_MS),
    retryMaxMs: Math.min(positive(raw.retryMaxMs, DEFAULT_RETRY_MAX_MS), MAX_TIMER_DELAY_MS),
    maxResponseBytes: positive(raw.maxResponseBytes, DEFAULT_MAX_RESPONSE_BYTES),
    cacheSize: nonNegative(raw.cacheSize, DEFAULT_CACHE_SIZE),
    cacheMaxBytes: nonNegative(raw.cacheMaxBytes, DEFAULT_CACHE_MAX_BYTES),
    rateLimitPerMinute: positive(raw.rateLimitPerMinute, DEFAULT_RATE_LIMIT_PER_MINUTE),
    maxConcurrency: positive(raw.maxConcurrency, DEFAULT_MAX_CONCURRENCY),
    // Terms are bounded and frozen at service creation; matched source terms stay local.
    glossary: glossaryInspection.entries,
    glossaryWarnings: Object.freeze([...glossaryInspection.errors, ...glossaryInspection.warnings]),
    maxQueuedRequests: nonNegative(raw.maxQueuedRequests, DEFAULT_MAX_QUEUED_REQUESTS),
    // The jitter source is injectable so the back-off is exactly testable.
    jitter: typeof raw.jitter === 'function' ? raw.jitter : Math.random,
  })
}

/** The translation service exposed to the browser and to the agent tool. */
export class TranslationPaneService {
  /**
   * @param ctx - the owning plugin context.
   * @param config - resolved plugin config.
   */
  constructor(ctx, config) {
    this.ctx = ctx
    this.name = SERVICE_KEY
    this.config = config
    /** Aborted when the plugin unloads, so no request outlives the service. */
    this.lifetime = new AbortController()
    /** Translated documents kept for reuse. */
    this.cache = new TranslationCache(config.cacheSize, config.cacheMaxBytes)
    /** Requests in flight, so identical demands share one network call. */
    this.inflight = new Map()
    /** Meter of anonymous provider requests. */
    this.bucket = new TokenBucket(config.rateLimitPerMinute)
    /** FIFO service-wide cap shared by direct and shipped-translator routes. */
    this.requestSlots = new FairSemaphore(config.maxConcurrency, config.maxQueuedRequests)
    /** Observed direct-provider availability, in-memory only. */
    this.health = new ProviderHealth(config.providerCooldownMs, DIRECT_PROVIDERS)
    this.cacheHits = 0
    this.cacheMisses = 0
    /** Mutable glossary snapshot; edits are scoped to this Host lifetime. */
    this.glossary = config.glossary
    this.glossaryWarnings = config.glossaryWarnings
    this.glossaryRevision = 0
    this.typertRemote = Object.freeze({
      service: this,
      serviceKey: SERVICE_KEY,
      namespace: SERVICE_KEY,
    })
  }

  /**
   * The routes and limits this deployment can translate with.
   *
   * Deliberately synchronous and free of native provider discovery: the
   * shipped translator's `availableProviders()` may await credential and model
   * discovery for up to its own 60s deadline, which would leave the panel
   * stuck on its first paint. Both anonymous routes exist regardless, and the
   * panel sends an explicit provider, so the catalog is static.
   * @returns the routing facts the panel reports.
   */
  describe() {
    const route = this.route()
    return {
      route,
      providers: route === 'translator' ? [...TRANSLATOR_PROVIDERS] : [...DIRECT_PROVIDERS],
      languages: LANGUAGES,
      maxTextChars: this.config.maxTextChars,
      fragmentChars: this.config.fragmentChars,
      maxRetries: this.config.maxRetries,
      rateLimitPerMinute: this.config.rateLimitPerMinute,
      maxConcurrency: this.config.maxConcurrency,
      maxQueuedRequests: this.config.maxQueuedRequests,
      activeRequests: this.requestSlots.activeCount,
      queuedRequests: this.requestSlots.queuedCount,
      cacheEntries: this.cache.size,
      cacheHits: this.cacheHits,
      cacheMisses: this.cacheMisses,
      glossaryEntries: this.glossary.length,
      glossary: this.glossary.map((entry) => ({
        source: entry.source,
        target: entry.target,
        sourceLanguage: entry.sourceLanguage,
        targetLanguage: entry.targetLanguage,
        matchCase: entry.matchCase,
        wholeWord: entry.wholeWord,
        enabled: entry.enabled,
        priority: entry.priority,
      })),
      glossaryWarnings: this.glossaryWarnings,
      // Plain data, computed from what was observed so far; this call never
      // probes the network or awaits anything. The translator route owns its
      // own routing, so it reports no direct-provider health.
      providerHealth: route === 'direct' ? this.health.snapshot() : {},
      // Whether a failed provider is retried automatically on another one.
      failover: route === 'direct' && this.config.failover,
    }
  }

  /**
   * Import and activate a validated glossary JSON document for this Host session.
   * The current in-flight requests are cancelled and cached results invalidated,
   * so later translations cannot reuse outputs from the previous terminology.
   * @param payload - versioned or legacy glossary JSON text.
   * @returns active entries and any non-fatal overlap/duplicate warnings.
   */
  setGlossary(payload) {
    const inspection = parseGlossaryImport(payload)
    if (inspection.errors.length > 0) {
      throw new TranslationPaneError(
        CODE.invalidRequest,
        'translationPane: the glossary import contains invalid entries',
        { errors: inspection.errors },
      )
    }
    this.glossary = inspection.entries
    this.glossaryWarnings = inspection.warnings
    this.glossaryRevision += 1
    for (const entry of this.inflight.values()) {
      entry.controller.abort(new Error('translationPane: the glossary changed during translation'))
    }
    this.cache = new TranslationCache(this.config.cacheSize, this.config.cacheMaxBytes)
    return {
      glossary: this.glossary.map((entry) => ({
        source: entry.source,
        target: entry.target,
        sourceLanguage: entry.sourceLanguage,
        targetLanguage: entry.targetLanguage,
        matchCase: entry.matchCase,
        wholeWord: entry.wholeWord,
        enabled: entry.enabled,
        priority: entry.priority,
      })),
      warnings: this.glossaryWarnings,
      count: this.glossary.length,
      revision: this.glossaryRevision,
    }
  }

  /**
   * The route this deployment translates with.
   * @returns `translator` when the shipped service is mounted, `direct` otherwise.
   */
  route() {
    return optionalService(this.ctx, 'translator') === undefined ? 'direct' : 'translator'
  }

  /**
   * Translate one text.
   *
   * The API Gateway derives its wire fields from the parameter names below,
   * so a caller may send the request either nested or flat: `{ request: {
   * text, targetLanguage } }` or `{ text, targetLanguage }`. Both shapes are
   * declared here, because the Gateway refuses an argument the descriptor
   * does not name.
   * @param request - the request object, when the caller sent one.
   * @param text - the source text, when the caller sent it flat.
   * @param targetLanguage - the target language, when sent flat.
   * @param sourceLanguage - the source language, when sent flat.
   * @param provider - the provider, when sent flat.
   * @param signal - the caller's cancellation; the Gateway injects it.
   * @returns the translation and the facts behind it.
   */
  async translate(request, text, targetLanguage, sourceLanguage, provider, format, signal) {
    const nested = request !== null && typeof request === 'object' ? request : {}
    const envelope = nested.request !== null && typeof nested.request === 'object' ? nested.request : {}
    return await this.translateRequest(
      {
        text: envelope.text ?? nested.text ?? text,
        targetLanguage: envelope.targetLanguage ?? nested.targetLanguage ?? targetLanguage,
        sourceLanguage: envelope.sourceLanguage ?? nested.sourceLanguage ?? sourceLanguage,
        provider: envelope.provider ?? nested.provider ?? provider,
        format: envelope.format ?? nested.format ?? format,
      },
      signal,
    )
  }

  /**
   * Translate one text; the shared path of the panel and the agent tool.
   * @param request - source text plus language and provider choices.
   * @param signal - optional caller cancellation.
   * @returns the translation and the facts behind it.
   */
  async translateRequest(request, signal) {
    const started = Date.now()
    // Cancellation applies to every path, including empty input and cache hits.
    if (signal?.aborted) throw this.abortReason(signal)
    // A disposed service must reject even if a caller races a new request
    // against unload; no work may start after its lifetime has ended.
    if (this.lifetime.signal.aborted) throw this.abortReason(this.lifetime.signal)
    const spec = this.parseRequest(request)
    if (spec.format === 'text' && spec.text.trim().length === 0) {
      return {
        text: '',
        sourceLanguage: spec.sourceLanguage,
        targetLanguage: spec.targetLanguage,
        provider: 'none',
        cached: false,
        durationMs: Date.now() - started,
      }
    }

    const key = `${spec.glossaryRevision}|${spec.format}|${spec.providerKey}|${spec.sourceLanguage}|${spec.targetLanguage}|${spec.text}`
    const cached = this.cache.get(key)
    if (cached !== undefined) {
      this.cacheHits += 1
      this.log('debug', `cache hit for a ${spec.text.length}-character demand`)
      return { ...cached, cached: true, durationMs: Date.now() - started }
    }
    this.cacheMisses += 1

    let entry = this.inflight.get(key)
    if (entry === undefined) {
      entry = this.startRequest(key, spec)
      this.inflight.set(key, entry)
    } else {
      this.log('debug', `joined a concurrent request for a ${spec.text.length}-character demand`)
    }
    return await this.join(entry, signal, started)
  }

  /**
   * Validate one caller request.
   * @param request - the caller's request object.
   * @returns the validated request.
   * @throws TranslationPaneError when the request cannot be served.
   */
  parseRequest(request) {
    const raw = request !== null && typeof request === 'object' ? request : {}
    // The Gateway hands the request's own fields to the method; a nested
    // `request` envelope is accepted too, so either wire shape works.
    const source = raw.request !== null && typeof raw.request === 'object' ? raw.request : raw
    const text = typeof source.text === 'string' ? source.text : ''
    const targetLanguage = normalizeLanguage(source.targetLanguage, 'zh-Hans', false)
    const sourceLanguage = normalizeLanguage(source.sourceLanguage, 'auto', true)
    const requested =
      typeof source.provider === 'string' && source.provider.trim().length > 0
        ? source.provider.trim()
        : undefined
    const format = source.format === undefined ? 'text' : source.format
    if (format !== 'text' && format !== 'json' && format !== 'markdown') {
      throw new TranslationPaneError(
        CODE.invalidRequest,
        'translationPane: format must be "text", "json" or "markdown"',
      )
    }
    // Enforce the raw input bound before parsing JSON: callers can reach the
    // Host without the panel's client-side counter, and an oversized document
    // must not consume parser work before it is rejected.
    if (text.length > this.config.maxTextChars) {
      throw new TranslationPaneError(
        CODE.textLimit,
        `translationPane: text exceeds the ${this.config.maxTextChars}-character limit`,
        { limit: this.config.maxTextChars, length: text.length },
      )
    }
    let jsonTokens
    let markdownSegmentsValue
    if (format === 'json') {
      try {
        jsonTokens = jsonStringValueTokens(text)
      } catch {
        throw new TranslationPaneError(CODE.invalidRequest, 'translationPane: JSON mode requires valid JSON text')
      }
    } else if (format === 'markdown') {
      markdownSegmentsValue = markdownSegments(text)
    }
    const route = this.route()
    const providers = route === 'translator' ? TRANSLATOR_PROVIDERS : DIRECT_PROVIDERS
    if (requested !== undefined && !providers.includes(requested)) {
      throw new TranslationPaneError(
        CODE.providerUnavailable,
        `translationPane: the ${route} route cannot serve the "${requested}" provider`,
        { provider: requested, route, providers: [...providers] },
      )
    }
    return {
      text,
      format,
      ...(jsonTokens === undefined ? {} : { jsonTokens }),
      ...(markdownSegmentsValue === undefined ? {} : { markdownSegments: markdownSegmentsValue }),
      sourceLanguage,
      targetLanguage,
      // The direct route always names a provider; the shipped translator
      // keeps its own configured default when the caller names none.
      provider: requested ?? providers[0],
      requested,
      // The cache key must name whatever decides the result, so an unnamed
      // provider is keyed apart from every named one.
      providerKey: route === 'direct' ? (requested ?? providers[0]) : (requested ?? 'default'),
      glossary: this.glossary,
      glossaryRevision: this.glossaryRevision,
    }
  }

  /**
   * Start one shared translation.
   *
   * The shared work is bound to the service lifetime, not to one caller: a
   * caller that walks away must not cancel a translation another caller is
   * still waiting for.
   * @param key - the cache key of the demand.
   * @param spec - the validated request.
   * @returns the in-flight entry.
   */
  startRequest(key, spec) {
    const controller = new AbortController()
    const entry = { key, controller, waiters: 0, promise: undefined }
    const onLifetime = () => controller.abort(this.lifetime.signal.reason)
    this.lifetime.signal.addEventListener('abort', onLifetime, { once: true })
    entry.promise = (async () => {
      try {
        const result = await this.run(spec, controller)
        // Do not publish a result if unload won the race with a fast path
        // (for example, JSON containing only empty string values).
        if (this.lifetime.signal.aborted) throw this.abortReason(this.lifetime.signal)
        this.cache.set(key, result)
        return result
      } finally {
        this.lifetime.signal.removeEventListener('abort', onLifetime)
        if (this.inflight.get(key) === entry) this.inflight.delete(key)
      }
    })()
    // The shared promise is awaited by every caller, but a caller that walks
    // away may be the last one: keep its rejection from surfacing as an
    // unhandled rejection.
    entry.promise.catch(() => {})
    return entry
  }

  /**
   * Await one shared translation on behalf of one caller.
   * @param entry - the in-flight entry.
   * @param signal - the caller's cancellation.
   * @param started - when the call began, for the duration.
   * @returns the translation.
   */
  async join(entry, signal, started) {
    entry.waiters += 1
    let released = false
    const release = () => {
      if (released) return
      released = true
      entry.waiters -= 1
      // The last caller left: stop the shared work instead of burning the
      // anonymous endpoint on a result nobody wants.
      if (entry.waiters <= 0) {
        entry.controller.abort(new Error('translationPane: every caller left the request'))
        // Do not let a new caller join work that has already been abandoned.
        // The old promise's finally block is identity-guarded, so it cannot
        // remove a replacement entry installed for the same key.
        if (this.inflight.get(entry.key) === entry) this.inflight.delete(entry.key)
      }
    }
    try {
      // A translator implementation may ignore AbortSignal and never settle.
      // Race each waiter against service lifetime as well as caller lifetime,
      // so unload releases callers even when underlying work is uncooperative.
      const waiterSignal =
        signal === undefined || signal === null
          ? this.lifetime.signal
          : AbortSignal.any([signal, this.lifetime.signal])
      const result = await this.race(entry.promise, waiterSignal)
      return { ...result, cached: false, durationMs: Date.now() - started }
    } finally {
      release()
    }
  }

  /**
   * Await a promise on behalf of one caller, ending early when the caller
   * cancels.
   * @param promise - the shared work.
   * @param signal - the caller's cancellation.
   * @returns the shared result.
   */
  race(promise, signal) {
    if (signal === undefined || signal === null) return promise
    if (signal.aborted) return Promise.reject(this.abortReason(signal))
    return new Promise((resolve, reject) => {
      const onAbort = () => reject(this.abortReason(signal))
      signal.addEventListener('abort', onAbort, { once: true })
      promise.then(
        (value) => {
          signal.removeEventListener('abort', onAbort)
          resolve(value)
        },
        (error) => {
          signal.removeEventListener('abort', onAbort)
          reject(error)
        },
      )
    })
  }

  /**
   * The reason a signal carries, as an Error.
   * @param signal - the aborted signal.
   * @returns the abort reason.
   */
  abortReason(signal) {
    const reason = signal?.reason
    return reason instanceof Error ? reason : new Error('translationPane: the request was cancelled')
  }

  /**
   * Translate one validated request.
   * @param spec - the validated request.
   * @param controller - the shared request cancellation.
   * @returns the translation.
   */
  async run(spec, controller) {
    const translator = optionalService(this.ctx, 'translator')
    const route = translator === undefined ? 'direct' : 'translator'
    const deadline = this.deadline(controller.signal, this.config.timeoutMs)
    try {
      const fragmentSize = this.fragmentSize(translator)
      const languages = {
        sourceLanguage: spec.sourceLanguage,
        targetLanguage: spec.targetLanguage,
      }
      const makePlan = (source) =>
        createTranslationPlan(source, spec.glossary, fragmentSize, languages)
      const plans = spec.format === 'json'
        ? spec.jsonTokens.map((token) => makePlan(token.value))
        : spec.format === 'markdown'
          ? spec.markdownSegments.map((segment) =>
              segment.translate
                ? makePlan(segment.text)
                : [{ text: segment.text, translate: false, fragments: [] }],
            )
          : [makePlan(spec.text)]
      const fragmentCount = countTranslationPlanFragments(plans)
      const fragments = plans.flatMap((plan) =>
        plan.flatMap((segment) => segment.fragments),
      )
      if (fragments.length !== fragmentCount) {
        throw new Error('translationPane: glossary fragment count is inconsistent')
      }
      const results = fragments.length === 0
        ? []
        : await this.dispatch(fragments, spec, route, translator, deadline.signal)
      const rendered = renderTranslationPlans(plans, results)
      // The shipped service may resolve a different provider than the caller
      // asked for, and the direct route may fall over to another provider; the
      // providers that actually answered are the ones to report. A long demand
      // may even be split across both (fragment 1 answered by the requested
      // provider, fragment 2 failed over), so the facts are derived from every
      // served fragment instead of the first one.
      const served = [
        ...new Set(
          results
            .map((entry) => entry.provider)
            .filter((value) => typeof value === 'string' && value.length > 0),
        ),
      ]
      const provider = served[0] ?? (results.length === 0 ? 'none' : spec.provider)
      this.log(
        'debug',
        `translated ${spec.text.length} characters with ${served.join('+') || provider} in ${fragments.length} fragments`,
      )
      // A detection is only meaningful when the caller did not name a source.
      const detected =
        spec.sourceLanguage === 'auto'
          ? results.find((entry) => entry.detected !== undefined)?.detected
          : undefined
      const requestedProvider = spec.requested ?? spec.provider
      return {
        text: spec.format === 'json'
          ? this.replaceJsonStringValues(spec.text, spec.jsonTokens, rendered.texts)
          : rendered.texts.join(''),
        sourceLanguage: spec.sourceLanguage,
        ...(detected === undefined ? {} : { detectedSourceLanguage: detected }),
        targetLanguage: spec.targetLanguage,
        // `provider` is who served the text; the direct route adds what the
        // caller asked for and whether any fragment was answered elsewhere, so
        // the panel can say so and a cache hit can replay the same facts.
        provider,
        ...(route === 'direct'
          ? {
              requestedProvider,
              failover: served.some((value) => value !== requestedProvider),
              ...(served.length > 1 ? { providersServed: served } : {}),
            }
          : {}),
      }
    } catch (error) {
      // Stop the other fragments: their results are no longer needed.
      controller.abort(error)
      throw error
    } finally {
      deadline.dispose()
    }
  }

  /**
   * Replace JSON string values in reverse source order so offsets remain valid.
   * Object keys and non-string JSON tokens are never sent to a provider.
   * @param source - the original JSON document.
   * @param tokens - string-value tokens from the validated source.
   * @param translatedValues - fully reconstructed string values in source order.
   * @returns valid JSON with only string values translated.
   */
  replaceJsonStringValues(source, tokens, translatedValues) {
    const replacements = tokens.map((token, index) => ({
      ...token,
      encoded: JSON.stringify(translatedValues[index] ?? token.value),
    }))
    let output = source
    for (let index = replacements.length - 1; index >= 0; index -= 1) {
      const token = replacements[index]
      output = output.slice(0, token.start) + token.encoded + output.slice(token.end)
    }
    JSON.parse(output)
    return output
  }

  /**
   * The size of one provider request.
   * @param translator - the shipped translator service, when mounted.
   * @returns the fragment size in UTF-16 code units.
   */
  fragmentSize(translator) {
    if (translator === undefined) return this.config.fragmentChars
    const limit =
      typeof translator.maxTextChars === 'number' && translator.maxTextChars > 0
        ? translator.maxTextChars
        : this.config.fragmentChars
    // The shipped service refuses anything above its own limit, so a
    // fragment must never be larger than that.
    return Math.min(this.config.fragmentChars, limit)
  }

  /**
   * Bound one request with a deadline.
   * @param signal - the shared cancellation.
   * @param timeoutMs - the deadline length.
   * @returns the combined signal and its disposer.
   */
  deadline(signal, timeoutMs) {
    const controller = new AbortController()
    const timer = setTimeout(() => {
      controller.abort(
        new TranslationPaneError(
          CODE.timeout,
          `translationPane: the request exceeded ${timeoutMs}ms`,
          { timeoutMs },
        ),
      )
    }, timeoutMs)
    const combined = signal === undefined ? controller.signal : AbortSignal.any([signal, controller.signal])
    return {
      signal: combined,
      dispose: () => clearTimeout(timer),
    }
  }

  /**
   * The direct providers to try, in order.
   *
   * The requested provider is preferred, but one that just failed is skipped
   * in favour of a healthy alternative: the point of the cooldown is that a
   * later demand does not pay the same failure again. With both providers
   * inside their cooldown the requested one is still probed last, so a
   * recovered network is picked up instead of being blocked forever.
   * @param requested - the provider the caller chose.
   * @returns the providers to try, at most one failover hop apart.
   */
  directCandidates(requested) {
    if (!this.config.failover) return [requested]
    const alternate = DIRECT_PROVIDERS.find((provider) => provider !== requested)
    if (alternate === undefined) return [requested]
    if (this.health.isAvailable(requested)) return [requested, alternate]
    if (this.health.isAvailable(alternate)) return [alternate, requested]
    return [requested, alternate]
  }

  /**
   * Dispatch every fragment with a bounded concurrency.
   * @param fragments - the source fragments.
   * @param spec - the validated request.
   * @param route - the active route.
   * @param translator - the shipped translator service, when mounted.
   * @param signal - the deadline signal.
   * @returns one result per fragment, in source order.
   */
  async dispatch(fragments, spec, route, translator, signal) {
    const results = new Array(fragments.length)
    // A failed fragment must cancel other already-running requests immediately.
    // Waiting for Promise.all before aborting can otherwise hold the request
    // open until the global deadline and waste provider capacity.
    const cancellation = new AbortController()
    const workerSignal =
      signal === undefined ? cancellation.signal : AbortSignal.any([signal, cancellation.signal])
    let next = 0
    let failed = false
    let failure
    const worker = async () => {
      for (;;) {
        // Stop claiming queued work after any fragment fails. Workers already
        // in flight settle before the first failure is rethrown.
        if (failed) return
        const index = next
        next += 1
        if (index >= fragments.length) return
        try {
          results[index] =
            route === 'translator'
              ? await this.translateFragment(translator, spec, fragments[index], workerSignal)
              : await this.translateDirect(spec, fragments[index], workerSignal)
        } catch (error) {
          if (!failed) {
            failure = error
            failed = true
            cancellation.abort(error)
          }
          return
        }
      }
    }
    const workers = []
    const count = Math.min(this.config.maxConcurrency, fragments.length)
    for (let index = 0; index < count; index += 1) workers.push(worker())
    await Promise.all(workers)
    if (failed) throw failure
    return results
  }

  /**
   * Translate one fragment through the anonymous endpoints, falling over to
   * the next provider on a provider-level failure.
   *
   * Only one hop is ever taken, and only for faults that prove the provider
   * itself is unhealthy: transport errors, the header deadline, 429 and 5xx.
   * A 4xx or an unreadable 200 body means the provider answered, so asking a
   * different one would not be a retry of the same problem.
   *
   * The candidate order is resolved per fragment rather than per request: once
   * one fragment proves a provider dead, the remaining fragments of the same
   * long document go straight to the healthy one instead of paying the same
   * bounded failure each.
   * @param spec - the validated request.
   * @param fragment - the source fragment.
   * @param signal - the deadline signal.
   * @returns the translated fragment and the provider that served it.
   */
  async translateDirect(spec, fragment, signal) {
    const providers = this.directCandidates(spec.provider)
    // One candidate keeps the historical retry budget. With a second provider
    // available, that provider is a better retry than the endpoint that just
    // failed, so each candidate gets exactly one attempt.
    const retries = providers.length > 1 ? 0 : this.config.maxRetries
    for (let index = 0; index < providers.length; index += 1) {
      const provider = providers[index]
      if (signal?.aborted) throw this.abortReason(signal)
      const source = providerLanguage(spec.sourceLanguage, provider)
      const target = providerLanguage(spec.targetLanguage, provider)
      const { url, init } = this.buildRequest(provider, fragment, source, target)
      try {
        const result = await this.request(provider, url, init, signal, retries)
        this.health.recordSuccess(provider)
        return { ...result, provider }
      } catch (error) {
        // A caller cancellation says nothing about the provider.
        if (signal?.aborted) throw error
        const last = index === providers.length - 1
        if (error?.failover === true) this.health.recordFailure(provider, error.code)
        if (error?.failover !== true || last) {
          if (last && providers.length > 1) this.noteProvidersTried(error, providers)
          throw error
        }
        this.log(
          'warn',
          `falling back from the ${provider} provider to ${providers[index + 1]} after ${error.code}`,
        )
      }
    }
  }

  /**
   * Record the bounded set of providers behind one failed demand.
   * @param error - the last failure of the demand.
   * @param providers - every provider that was tried, in order.
   */
  noteProvidersTried(error, providers) {
    if (!(error instanceof TranslationPaneError)) return
    error.details = { ...error.details, providersTried: [...providers] }
  }

  /**
   * Build the request of one anonymous provider.
   * @param provider - provider id.
   * @param text - the source fragment.
   * @param source - the source language tag.
   * @param target - the target language tag.
   * @returns the request URL and init.
   */
  buildRequest(provider, text, source, target) {
    if (provider === 'google') {
      const url = new URL(this.config.googleEndpoint)
      const form = new URLSearchParams({
        client: 'gtx',
        sl: source,
        tl: target,
        dt: 't',
        q: text,
      })
      // The endpoint may carry its own query parameters; only the ones this
      // request owns are replaced.
      for (const key of form.keys()) url.searchParams.delete(key)
      return {
        url,
        init: {
          method: 'POST',
          body: form.toString(),
          headers: { 'content-type': 'application/x-www-form-urlencoded' },
        },
      }
    }
    const url = new URL(this.config.bingEndpoint)
    if (source !== 'auto') url.searchParams.set('from', source)
    url.searchParams.set('to', target)
    url.searchParams.set('isEnterpriseClient', 'false')
    return {
      url,
      init: {
        method: 'POST',
        body: JSON.stringify([text]),
        headers: { 'content-type': 'application/json' },
      },
    }
  }

  /**
   * Send one provider request, retrying the failures that may succeed later.
   * @param provider - provider id.
   * @param url - the request URL.
   * @param init - the request init.
   * @param signal - the deadline signal.
   * @param retries - retries left for this provider; at most the configured
   * budget, and zero when another provider is available instead.
   * @returns the translated fragment.
   */
  async request(provider, url, init, signal, retries) {
    const budget =
      typeof retries === 'number' ? Math.min(retries, this.config.maxRetries) : this.config.maxRetries
    let attempt = 0
    for (;;) {
      // Acquire before spending a provider token. A queued or cancelled
      // demand must not reserve rate-limit capacity before it can run.
      const release = await this.requestSlots.acquire(signal)
      let failure
      try {
        if (signal?.aborted) throw this.abortReason(signal)
        if (!this.bucket.take()) {
          // The local bucket is shared by every provider, so another provider
          // would be refused too; this failure must never cause a failover.
          throw new TranslationPaneError(
            CODE.rateLimited,
            `translationPane: the ${this.config.rateLimitPerMinute}-request-per-minute limit is exhausted`,
            { limit: this.config.rateLimitPerMinute },
          )
        }
        return await this.attempt(provider, url, init, signal)
      } catch (error) {
        if (error?.retryable !== true || attempt >= budget) throw error
        failure = error
      } finally {
        // Back-off never holds a scarce provider slot.
        release()
      }
      const wait = this.backoff(attempt, failure)
      this.log('debug', `retrying the ${provider} request after ${wait}ms`)
      await this.sleep(wait, signal)
      attempt += 1
    }
  }

  /**
   * Perform one provider attempt.
   *
   * The attempt deadline covers the wait for response headers only: a
   * provider that never starts answering must not consume the whole request
   * budget while a healthy provider is available, but a provider that is
   * answering may keep streaming under the request's own deadline.
   * @param provider - provider id.
   * @param url - the request URL.
   * @param init - the request init.
   * @param signal - the deadline signal.
   * @returns the translated fragment.
   */
  async attempt(provider, url, init, signal) {
    const transport = new AbortController()
    const timer = setTimeout(() => {
      transport.abort(
        new TranslationPaneError(
          CODE.timeout,
          `translationPane: the ${provider} request did not start answering within ${this.config.attemptTimeoutMs}ms`,
          { provider, timeoutMs: this.config.attemptTimeoutMs },
          true,
          true,
        ),
      )
    }, this.config.attemptTimeoutMs)
    const combined =
      signal === undefined ? transport.signal : AbortSignal.any([signal, transport.signal])
    let response
    try {
      response = await fetch(url, {
        ...init,
        // No cookies, no credentials, no redirect: the anonymous endpoints
        // answer a plain request and a redirect is never legitimate here.
        credentials: 'omit',
        redirect: 'error',
        signal: combined,
      })
    } catch {
      // A request-wide abort (caller or deadline) wins: it is not evidence
      // about the provider. A transport abort is the provider's own deadline.
      if (signal?.aborted) throw this.abortReason(signal)
      if (transport.signal.aborted) throw this.abortReason(transport.signal)
      throw new TranslationPaneError(
        CODE.providerUnreachable,
        `translationPane: the ${provider} request could not be sent`,
        { provider },
        true,
        true,
      )
    } finally {
      // Headers arrived (or failed): the body is bounded by the request
      // deadline from here on, not by the attempt deadline.
      clearTimeout(timer)
    }
    if (!response.ok) {
      // The caller/request deadline remains authoritative after headers arrive.
      if (signal?.aborted) throw this.abortReason(signal)
      // Error bodies are irrelevant. Cancellation is best-effort and must not
      // hold the request open if a stream's underlying cancel hook stalls.
      try {
        const cancellation = response.body?.cancel?.()
        cancellation?.catch?.(() => {})
      } catch {}
      const status = response.status
      const retryAfterMs = parseRetryAfter(response.headers?.get?.('retry-after'))
      if (status === 429) {
        throw new TranslationPaneError(
          CODE.rateLimited,
          `translationPane: the ${provider} endpoint is rate limiting this client`,
          { provider, status, retryAfterMs },
          true,
          true,
        )
      }
      if (status >= 500) {
        throw new TranslationPaneError(
          CODE.providerError,
          `translationPane: the ${provider} endpoint answered HTTP ${status}`,
          { provider, status, retryAfterMs },
          true,
          true,
        )
      }
      // Any other 4xx is the caller's own doing; asking again, on this
      // provider or another, would only earn the same answer.
      throw new TranslationPaneError(
        CODE.providerError,
        `translationPane: the ${provider} endpoint answered HTTP ${status}`,
        { provider, status },
      )
    }
    let body
    try {
      body = await this.readBody(response, this.config.maxResponseBytes, provider)
    } catch (error) {
      // Fetch aborts body consumption when its signal fires after headers.
      // Preserve the request's structured timeout/cancellation reason rather
      // than leaking the implementation-specific AbortError from the reader.
      if (signal?.aborted) throw this.abortReason(signal)
      throw error
    }
    let payload
    try {
      payload = JSON.parse(body)
    } catch {
      throw new TranslationPaneError(
        CODE.invalidResponse,
        `translationPane: the ${provider} endpoint returned invalid JSON`,
        { provider },
      )
    }
    return this.parsePayload(provider, payload)
  }

  /**
   * Read a response body under a byte cap.
   *
   * A broken or hostile endpoint could stream without end, so the body is
   * counted while it arrives rather than after it has been buffered.
   * @param response - the fetch response.
   * @param limit - the largest accepted body, in bytes.
   * @param provider - the provider id, for diagnostics.
   * @returns the body as text.
   */
  async readBody(response, limit, provider) {
    const body = response.body
    if (body === undefined || body === null || typeof body.getReader !== 'function') {
      const text = await response.text()
      if (Buffer.byteLength(text, 'utf8') > limit) {
        throw new TranslationPaneError(
          CODE.invalidResponse,
          `translationPane: the ${provider} response exceeds ${limit} bytes`,
          { provider, limit },
        )
      }
      return text
    }
    const reader = body.getReader()
    const chunks = []
    let bytes = 0
    try {
      for (;;) {
        const chunk = await reader.read()
        if (chunk.done) break
        bytes += chunk.value.byteLength
        if (bytes > limit) {
          // Reject immediately; a hostile stream may never settle its cancel hook.
          try {
            const cancellation = reader.cancel()
            cancellation?.catch?.(() => {})
          } catch {}
          throw new TranslationPaneError(
            CODE.invalidResponse,
            `translationPane: the ${provider} response exceeds ${limit} bytes`,
            { provider, limit },
          )
        }
        chunks.push(Buffer.from(chunk.value))
      }
    } finally {
      reader.releaseLock()
    }
    return Buffer.concat(chunks).toString('utf8')
  }

  /**
   * Read the translated text out of a provider payload.
   * @param provider - provider id.
   * @param payload - the parsed payload.
   * @returns the translated text and, when the provider reports one, the
   * detected source language.
   */
  parsePayload(provider, payload) {
    const invalid = () =>
      new TranslationPaneError(
        CODE.invalidResponse,
        `translationPane: the ${provider} endpoint returned an unexpected response`,
        { provider },
      )
    if (!Array.isArray(payload) || payload.length === 0) throw invalid()
    if (provider === 'google') {
      const segments = payload[0]
      if (!Array.isArray(segments) || segments.length === 0) throw invalid()
      const text = segments.map((segment) => {
        if (!Array.isArray(segment) || typeof segment[0] !== 'string') throw invalid()
        return segment[0]
      }).join('')
      // The anonymous Google response reports the detected source language
      // next to the segments; it is only meaningful when the caller did not
      // name a source.
      const detected = payload[2]
      return {
        text,
        detected: typeof detected === 'string' && LANGUAGE_PATTERN.test(detected) ? detected : undefined,
      }
    }
    const first = payload[0]
    if (typeof first !== 'object' || first === null || !Array.isArray(first.translations)) throw invalid()
    const translated = first.translations[0]
    if (typeof translated !== 'object' || translated === null || typeof translated.text !== 'string') {
      throw invalid()
    }
    return { text: translated.text }
  }

  /**
   * Translate one fragment through the shipped translator service.
   * @param translator - the shipped translator service.
   * @param spec - the validated request.
   * @param fragment - the source fragment.
   * @param signal - the deadline signal.
   * @returns the translated fragment.
   */
  async translateFragment(translator, spec, fragment, signal) {
    const release = await this.requestSlots.acquire(signal)
    try {
      if (signal?.aborted) throw this.abortReason(signal)
      return await this.translateFragmentWithSlot(translator, spec, fragment, signal)
    } finally {
      release()
    }
  }

  /**
   * Translate one fragment while holding a service-wide provider slot.
   * @param translator - the shipped translator service.
   * @param spec - the validated request.
   * @param fragment - the source fragment.
   * @param signal - the deadline signal.
   * @returns the translated fragment.
   */
  async translateFragmentWithSlot(translator, spec, fragment, signal) {
    let resolved
    try {
      resolved = translator.resolve({
        text: fragment,
        targetLanguage: spec.targetLanguage,
        sourceLanguage: spec.sourceLanguage === 'auto' ? undefined : spec.sourceLanguage,
        // An unnamed provider lets the shipped service apply its own
        // configured default instead of this plugin's guess.
        provider: spec.requested,
      })
    } catch (error) {
      throw this.mapTranslatorError(error, spec)
    }
    let text
    try {
      // Detach the service pipeline from a translator that ignores abort and never settles.
      // The provider's own Promise may remain pending, but this request can release
      // its workers, deadline, shared entry, and service-owned references promptly.
      text = await this.race(Promise.resolve(translator.translate(resolved, signal)), signal)
    } catch (error) {
      // A request-wide deadline or caller cancellation is authoritative even
      // when the upstream translator rejects with its own AbortError shape.
      if (signal?.aborted) throw this.abortReason(signal)
      throw this.mapTranslatorError(error, spec)
    }
    // Some translator implementations may settle after receiving abort.
    // Do not accept a late success after the shared request deadline.
    if (signal?.aborted) throw this.abortReason(signal)
    if (typeof text !== 'string') {
      throw new TranslationPaneError(
        CODE.invalidResponse,
        'translationPane: the translator returned no text',
        { provider: spec.provider },
      )
    }
    const detected = resolved?.detectedSourceLanguage
    return {
      text,
      detected: typeof detected === 'string' ? detected : undefined,
      provider: typeof resolved?.provider === 'string' ? resolved.provider : undefined,
    }
  }

  /**
   * Map a shipped translator failure onto this plugin's codes.
   *
   * The shipped service has its own vocabulary; the browser only localizes
   * this plugin's codes, so the upstream code is translated here.
   * @param error - the upstream failure.
   * @param spec - the validated request.
   * @returns the failure to raise.
   */
  mapTranslatorError(error, spec) {
    if (error instanceof TranslationPaneError) return error
    const upstream = typeof error?.code === 'string' ? error.code : ''
    const details = { provider: spec.provider, upstream }
    switch (upstream) {
      case 'TRANSLATION_TEXT_LIMIT':
        return new TranslationPaneError(
          CODE.textLimit,
          `translationPane: text exceeds the ${this.config.maxTextChars}-character limit`,
          { ...details, limit: this.config.maxTextChars },
        )
      case 'TRANSLATION_TIMEOUT':
        return new TranslationPaneError(CODE.timeout, 'translationPane: the translator timed out', details)
      case 'TRANSLATION_SESSION_REQUIRED':
      case 'TRANSLATION_SESSION_INACTIVE':
      case 'TRANSLATION_UNAVAILABLE':
        return new TranslationPaneError(
          CODE.providerUnavailable,
          `translationPane: the "${spec.provider}" provider is unavailable`,
          details,
        )
      case 'TRANSLATION_INVALID_RESPONSE':
      case 'TRANSLATION_RESPONSE_LIMIT':
        return new TranslationPaneError(
          CODE.invalidResponse,
          'translationPane: the translator returned an unexpected response',
          details,
        )
      case 'TRANSLATION_REQUEST_FAILED':
        return new TranslationPaneError(
          CODE.providerUnreachable,
          'translationPane: the translator request could not be sent',
          details,
        )
      case 'TRANSLATION_HTTP_ERROR':
        return new TranslationPaneError(
          CODE.providerError,
          'translationPane: the translator provider failed the request',
          details,
        )
      default:
        return new TranslationPaneError(
          CODE.providerError,
          'translationPane: the translation failed',
          details,
        )
    }
  }

  /**
   * The back-off delay before the next attempt.
   * @param attempt - the 0-based number of the attempt that just failed.
   * @param error - the failure, which may carry a `Retry-After` hint.
   * @returns the delay in milliseconds.
   */
  backoff(attempt, error) {
    const hinted = error?.details?.retryAfterMs
    if (typeof hinted === 'number' && Number.isFinite(hinted) && hinted >= 0) {
      // Retry-After is a server instruction, not the local exponential
      // back-off. The request deadline will abort a wait that cannot fit.
      return hinted
    }
    const base = Math.min(this.config.retryBaseMs * 2 ** attempt, this.config.retryMaxMs)
    // Jitter keeps a burst of clients from retrying in lockstep, which the
    // anonymous endpoints punish with their own rate limit.
    return Math.round(base * (0.5 + this.config.jitter() * 0.5))
  }

  /**
   * Pause between retries.
   * @param ms - how long to wait.
   * @param signal - cancellation that ends the wait early.
   * @returns resolution once the wait is over.
   */
  sleep(ms, signal) {
    return new Promise((resolve, reject) => {
      let timer
      const onAbort = () => {
        clearTimeout(timer)
        reject(this.abortReason(signal))
      }
      timer = setTimeout(() => {
        signal?.removeEventListener('abort', onAbort)
        resolve()
      }, ms)
      if (signal?.aborted) {
        onAbort()
        return
      }
      signal?.addEventListener('abort', onAbort, { once: true })
    })
  }

  /**
   * Log one event, never touching the translated or the source text.
   * @param level - `debug` or `warn`.
   * @param message - the diagnostic.
   */
  log(level, message) {
    const logger = this.ctx?.logger
    if (typeof logger?.[level] !== 'function') return
    logger[level](`translationPane: ${message}`)
  }
}

/** Host services this plugin consumes. */
export const inject = ['tools']

/**
 * Register the translation service, its wire endpoint, and the agent tool.
 * @param ctx - the owning plugin context.
 * @param config - the row's config.
 */
export function apply(ctx, config) {
  const resolved = resolveConfig(config)
  const service = new TranslationPaneService(ctx, resolved)
  // Bind the service to the calling context the way a Cordis Service does, so
  // the API Gateway reaches it through the same traced proxy.
  Object.defineProperty(service, TRACKER, {
    value: { associate: SERVICE_KEY, property: 'ctx' },
  })
  ctx.reflect.provide(SERVICE_KEY, service, undefined)

  // The service outlives no request: unloading the plugin aborts everything
  // in flight, so a translation never outlives the bundle that started it.
  ctx.effect(
    () => async () => {
      service.lifetime.abort(new Error('translationPane: the service was unloaded'))
      // Observed health belongs to this instance; an unloaded service must
      // not leave a failure behind for a future composition to inherit.
      service.health.reset()
    },
    'dsh-translation-pane: service lifetime',
  )

  ctx.effect(
    () =>
      ctx.tools.register({
        name: 'translate_text',
        description: `Translate text between languages by sending translatable content to the configured machine-translation provider (Microsoft Edge/Bing or Google Translate on the direct route; the configured provider on the shipped-translator route). Configured glossary terms are replaced locally with their preferred target wording and are not sent to that provider; only unmatched text is submitted. Tell the user that their text is processed by that external provider before submitting sensitive or confidential content. Use it when the user asks for a translation, or when you need a sentence rendered in another language. Returns only the translation. For JSON input, pass format="json" to preserve keys, structure and non-string values while translating string values only. For Markdown input, pass format="markdown" to translate prose while preserving fenced/inline code, URLs, link destinations, template placeholders, HTML tags, entities and common Markdown syntax. Text up to ${resolved.maxTextChars} characters is accepted; longer translatable text is split into provider-sized requests and translated in order. On the direct endpoint route, if one endpoint cannot be reached and failover is enabled, the other provider may receive the same fragment.`,
        parameters: {
          type: 'object',
          additionalProperties: false,
          properties: {
            text: {
              type: 'string',
              description: `Source text to translate, up to ${resolved.maxTextChars} characters; longer text is split into provider-sized requests automatically.`,
            },
            targetLanguage: {
              type: 'string',
              description:
                'Target language tag, for example zh-Hans, zh-Hant, en, ja, ko, fr, de, es, ru.',
            },
            sourceLanguage: {
              type: 'string',
              description: 'Source language tag; omit or pass "auto" to detect it.',
            },
            format: {
              type: 'string',
              enum: ['text', 'json', 'markdown'],
              description: 'Use "json" to translate only JSON string values, or "markdown" to translate prose while preserving code, URLs, links, placeholders and common Markdown syntax. Defaults to "text".',
            },
          },
          required: ['text', 'targetLanguage'],
        },
        output: {
          schema: {
            type: 'object',
            additionalProperties: false,
            properties: {
              text: { type: 'string' },
              sourceLanguage: { type: 'string' },
              detectedSourceLanguage: { type: 'string' },
              targetLanguage: { type: 'string' },
              provider: { type: 'string' },
              requestedProvider: { type: 'string' },
              failover: { type: 'boolean' },
              providersServed: { type: 'array', items: { type: 'string' } },
              cached: { type: 'boolean' },
              durationMs: { type: 'number' },
            },
            required: ['text', 'sourceLanguage', 'targetLanguage', 'provider', 'cached', 'durationMs'],
          },
          render: (_args, value) => [{ type: 'text', text: value.text }],
        },
        async execute(args, exec) {
          exec.signal?.throwIfAborted?.()
          const result = await service.translateRequest(
            {
              text: args.text,
              targetLanguage: args.targetLanguage,
              sourceLanguage: args.sourceLanguage,
              format: args.format,
            },
            exec.signal,
          )
          return {
            text: result.text,
            sourceLanguage: result.sourceLanguage,
            ...(result.detectedSourceLanguage === undefined
              ? {}
              : { detectedSourceLanguage: result.detectedSourceLanguage }),
            targetLanguage: result.targetLanguage,
            provider: result.provider,
            // Additive routing facts, present only on the direct route: the
            // model can tell a user why a different service answered.
            ...(result.requestedProvider === undefined
              ? {}
              : { requestedProvider: result.requestedProvider }),
            ...(result.failover === undefined ? {} : { failover: result.failover }),
            // Present only when one long demand was split across providers.
            ...(result.providersServed === undefined
              ? {}
              : { providersServed: result.providersServed }),
            cached: result.cached,
            durationMs: result.durationMs,
          }
        },
        isConcurrencySafe: () => true,
      }),
    'dsh-translation-pane: translate_text tool',
  )
}

// Declare the Remote methods for the API Gateway's runtime dispatch. The
// marker format is the Typert protocol's public, versioned descriptor: a frozen
// record on the class prototype naming the exported methods.
Object.defineProperty(TranslationPaneService.prototype, REMOTE_METHODS, {
  configurable: true,
  value: Object.freeze({
    version: 1,
    methods: Object.freeze([
      Object.freeze({ method: 'describe', invocation: Object.freeze({ kind: 'direct' }) }),
      Object.freeze({ method: 'translate', invocation: Object.freeze({ kind: 'direct' }) }),
      Object.freeze({ method: 'setGlossary', invocation: Object.freeze({ kind: 'direct' }) }),
    ]),
  }),
})
