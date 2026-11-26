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
function protectedTextRanges(text) {
  const patterns = [
    /(`+)[^\n]*?\1/g, // inline code spans, including multi-backtick delimiters
    /^ {0,3}(?:`{3,}|~{3,})[^\n]*(?:\n|$)/gm, // Markdown fence marker lines
    /\{\{[\s\S]*?\}\}/g, // common template placeholders
    /\$\{[^}\n]*\}/g, // interpolation placeholders
    /<\/?[A-Za-z][^>\n]*>/g, // HTML/XML tags
    /\[[^\]\n]*\]\([^)]+\)/g, // Markdown links
    /https?:\/\/[^\s<>()]+/g, // URLs
  ]
  const ranges = []
  for (const pattern of patterns) {
    for (const match of text.matchAll(pattern)) {
      ranges.push({ start: match.index, end: match.index + match[0].length })
    }
  }
  ranges.sort((a, b) => a.start - b.start || a.end - b.end)
  const merged = []
  for (const range of ranges) {
    const previous = merged.at(-1)
    if (previous && range.start <= previous.end) {
      previous.end = Math.max(previous.end, range.end)
    } else {
      merged.push({ ...range })
    }
  }
  return merged
}

/**
 * Move a proposed fragment boundary out of a protected syntax token when the
 * complete token fits in one provider request.
 * @param ranges - protected source ranges, in UTF-16 offsets.
 * @param offset - current fragment's source offset.
 * @param boundary - proposed local boundary.
 * @param maxChars - maximum fragment size.
 * @returns a local boundary that does not bisect a protected token.
 */
function protectBoundary(ranges, offset, boundary, maxChars) {
  const absolute = offset + boundary
  const range = ranges.find((item) =>
    item.start < absolute && item.end > absolute && item.end - item.start <= maxChars,
  )
  if (range === undefined) return boundary
  if (range.start > offset) return range.start - offset
  if (range.end - offset <= maxChars) return range.end - offset
  return boundary
}

/**
 * Split text into request-sized pieces on paragraph, then line, then sentence,
 * then word boundaries. Complete inline syntax tokens (code spans, template
 * placeholders, HTML tags, Markdown links and URLs) are kept in one fragment
 * whenever the token itself fits the provider limit.
 *
 * The separator always stays with the fragment it closes, so concatenating
 * the fragments reproduces the source exactly.
 * @param text - source text.
 * @param maxChars - per-fragment limit in UTF-16 code units.
 * @returns the fragments in source order.
 */
/**
 * Validate JSON and locate only string-value tokens, never object keys.
 *
 * Source offsets let us replace values without reserializing the document:
 * whitespace, key spelling, numeric notation, booleans, null and nesting
 * remain unchanged.
 * @param source - the JSON source text.
 * @returns string-value tokens in source order.
 */
function jsonStringValueTokens(source) {
  JSON.parse(source)
  const tokens = []
  let index = 0
  while (index < source.length) {
    if (source[index] !== '"') {
      index += 1
      continue
    }
    const start = index
    index += 1
    while (index < source.length) {
      const character = source[index]
      if (character === '\\') {
        index += 2
        continue
      }
      index += 1
      if (character === '"') break
    }
    const end = index
    let next = end
    while (next < source.length && /[\t\n\r ]/u.test(source[next])) next += 1
    if (source[next] !== ':') {
      const value = JSON.parse(source.slice(start, end))
      tokens.push({ start, end, value })
    }
  }
  return tokens
}

// Reuse the ICU segmenter across fragment boundaries. Its iterator stops
// at the first boundary that crosses the proposed cut.
const GRAPHEME_SEGMENTER = new Intl.Segmenter(undefined, { granularity: 'grapheme' })

/**
 * Keep fragment boundaries on grapheme boundaries whenever the complete
 * grapheme fits. Oversized graphemes may be divided between code points, but
 * never inside a UTF-16 surrogate pair.
 * @param text - the remaining source text.
 * @param boundary - proposed UTF-16 boundary.
 * @param maxChars - provider fragment limit.
 * @returns a safe local boundary.
 */
function adjustGraphemeBoundary(text, boundary, maxChars) {
  for (const item of GRAPHEME_SEGMENTER.segment(text)) {
    const start = item.index
    const end = start + item.segment.length
    if (start < boundary && end > boundary) {
      if (start > 0) return start
      if (end <= maxChars) return end

      // This one grapheme is larger than the whole fragment budget. Preserve
      // code points even though keeping the grapheme intact is impossible.
      let safe = 0
      while (safe < text.length) {
        const point = text.codePointAt(safe)
        const width = point > 0xffff ? 2 : 1
        if (safe + width > maxChars) break
        safe += width
        if (safe >= boundary) break
      }
      if (safe === 0) {
        throw new RangeError('splitText: maxChars is smaller than one Unicode code point')
      }
      return safe
    }
  }
  return boundary
}

export function splitText(text, maxChars) {
  if (maxChars < 1) throw new RangeError('splitText: maxChars must be positive')
  if (text.length <= maxChars) return [text]
  const fragments = []
  const ranges = protectedTextRanges(text)
  let rest = text
  let offset = 0
  // A break earlier than this would produce a run of tiny fragments; the
  // coarse separators are preferred, but only when they still fill the
  // request reasonably well.
  const minCut = Math.floor(maxChars / 2)
  while (rest.length > maxChars) {
    const window = rest.slice(0, maxChars)
    let cut = -1
    let size = 0
    for (const separator of ['\n\n', '\n', '. ', ' ']) {
      const found = window.lastIndexOf(separator)
      if (found >= minCut) {
        cut = found
        size = separator.length
        break
      }
    }
    let boundary = cut < 0 ? maxChars : cut + size
    boundary = protectBoundary(ranges, offset, boundary, maxChars)
    // Keep a complete grapheme together when it fits. If a single grapheme
    // exceeds the provider limit, fall back to code-point-safe boundaries.
    boundary = adjustGraphemeBoundary(rest, boundary, maxChars)
    fragments.push(rest.slice(0, boundary))
    rest = rest.slice(boundary)
    offset += boundary
  }
  if (rest.length > 0) fragments.push(rest)
  return fragments
}

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
class TranslationCache {
  /**
   * @param limit - how many entries are retained.
   * @param maxBytes - the approximate UTF-8 byte budget for retained values.
   */
  constructor(limit, maxBytes) {
    this.limit = limit
    this.maxBytes = maxBytes
    this.bytes = 0
    this.entries = new Map()
  }

  /**
   * Read one entry and mark it as recently used.
   * @param key - cache key.
   * @returns the cached value, or `undefined` on a miss.
   */
  get(key) {
    const entry = this.entries.get(key)
    if (entry === undefined) return undefined
    this.entries.delete(key)
    this.entries.set(key, entry)
    return entry.value
  }

  /**
   * Store one entry, evicting least-recently-used entries until both limits fit.
   * Oversized individual translations are returned to the caller but not cached.
   * @param key - cache key.
   * @param value - the translation.
   */
  set(key, value) {
    if (this.limit <= 0 || this.maxBytes <= 0) return
    const entryBytes =
      Buffer.byteLength(key, 'utf8') +
      Buffer.byteLength(typeof value?.text === 'string' ? value.text : '', 'utf8') +
      CACHE_ENTRY_OVERHEAD_BYTES

    const previous = this.entries.get(key)
    if (previous !== undefined) {
      this.entries.delete(key)
      this.bytes -= previous.bytes
    }
    if (entryBytes > this.maxBytes) return

    this.entries.set(key, { value, bytes: entryBytes })
    this.bytes += entryBytes
    while (this.entries.size > this.limit || this.bytes > this.maxBytes) {
      const oldest = this.entries.entries().next()
      if (oldest.done) break
      const [oldestKey, oldestEntry] = oldest.value
      this.entries.delete(oldestKey)
      this.bytes -= oldestEntry.bytes
    }
  }

  /** How many entries are retained. */
  get size() {
    return this.entries.size
  }
}

/**
 * The observed availability of the direct providers.
 *
 * A provider that failed a transport-level fault is not asked again for a
 * while: the panel reports it, and the next demand goes straight to the other
 * provider instead of paying the same failure first. The state is plain data
 * and in-memory per service instance; `snapshot()` never touches the network.
 */
class ProviderHealth {
  /**
   * @param cooldownMs - how long one failure is remembered; `0` disables it.
   */
  constructor(cooldownMs) {
    this.cooldownMs = cooldownMs
    this.failures = new Map()
  }

  /**
   * Remember one provider failure.
   * @param provider - provider id.
   * @param reason - the stable failure code, kept per provider.
   * @param now - the current time, injectable for diagnostics.
   */
  recordFailure(provider, reason, now = Date.now()) {
    if (this.cooldownMs <= 0) return
    this.failures.set(provider, {
      reason: typeof reason === 'string' ? reason : '',
      until: now + this.cooldownMs,
    })
  }

  /**
   * Forget a provider failure, because the provider just answered.
   * @param provider - provider id.
   */
  recordSuccess(provider) {
    this.failures.delete(provider)
  }

  /**
   * Whether a provider may be tried now.
   * @param provider - provider id.
   * @param now - the current time, injectable for diagnostics.
   * @returns whether the provider is not inside its cooldown.
   */
  isAvailable(provider, now = Date.now()) {
    const failure = this.failures.get(provider)
    if (failure === undefined) return true
    if (now >= failure.until) {
      this.failures.delete(provider)
      return true
    }
    return false
  }

  /**
   * The serializable health facts the panel reports.
   * @param now - the current time, injectable for diagnostics.
   * @returns plain data keyed by provider id.
   */
  snapshot(now = Date.now()) {
    const health = {}
    for (const provider of DIRECT_PROVIDERS) {
      const failure = this.failures.get(provider)
      if (failure === undefined || now >= failure.until) {
        health[provider] = { unreachable: false }
        continue
      }
      health[provider] = {
        unreachable: true,
        until: new Date(failure.until).toISOString(),
        reason: failure.reason,
      }
    }
    return health
  }

  /** Drop every observation, so an unloaded service leaves nothing behind. */
  reset() {
    this.failures.clear()
  }
}

/**
 * A token bucket that meters anonymous provider requests.
 *
 * The endpoints rate-limit aggressively, so an exhausted bucket refuses the
 * request instead of queueing it: an unbounded queue would grow until the
 * panel looks frozen rather than reporting that it is busy.
 */
class TokenBucket {
  /**
   * @param perMinute - how many requests are allowed per minute.
   */
  constructor(perMinute) {
    this.perMinute = perMinute
    this.capacity = perMinute
    this.tokens = perMinute
    this.updatedAt = Date.now()
  }

  /**
   * Take one token when the bucket still has one.
   * @returns whether the request may proceed.
   */
  take() {
    if (this.perMinute <= 0) return false
    const now = Date.now()
    const elapsed = Math.max(0, now - this.updatedAt)
    this.updatedAt = now
    this.tokens = Math.min(this.capacity, this.tokens + (elapsed * this.perMinute) / 60000)
    if (this.tokens < 1) return false
    this.tokens -= 1
    return true
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
    /** Observed direct-provider availability, in-memory only. */
    this.health = new ProviderHealth(config.providerCooldownMs)
    this.cacheHits = 0
    this.cacheMisses = 0
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
      cacheEntries: this.cache.size,
      cacheHits: this.cacheHits,
      cacheMisses: this.cacheMisses,
      // Plain data, computed from what was observed so far; this call never
      // probes the network or awaits anything. The translator route owns its
      // own routing, so it reports no direct-provider health.
      providerHealth: route === 'direct' ? this.health.snapshot() : {},
      // Whether a failed provider is retried automatically on another one.
      failover: route === 'direct' && this.config.failover,
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

    const key = `${spec.format}|${spec.providerKey}|${spec.sourceLanguage}|${spec.targetLanguage}|${spec.text}`
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
    if (format !== 'text' && format !== 'json') {
      throw new TranslationPaneError(CODE.invalidRequest, 'translationPane: format must be "text" or "json"')
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
    if (format === 'json') {
      try {
        jsonTokens = jsonStringValueTokens(text)
      } catch {
        throw new TranslationPaneError(CODE.invalidRequest, 'translationPane: JSON mode requires valid JSON text')
      }
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
      sourceLanguage,
      targetLanguage,
      // The direct route always names a provider; the shipped translator
      // keeps its own configured default when the caller names none.
      provider: requested ?? providers[0],
      requested,
      // The cache key must name whatever decides the result, so an unnamed
      // provider is keyed apart from every named one.
      providerKey: route === 'direct' ? (requested ?? providers[0]) : (requested ?? 'default'),
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
      const groups = spec.format === 'json'
        ? spec.jsonTokens.map((token) => token.value.length === 0 ? [] : splitText(token.value, fragmentSize))
        : [splitText(spec.text, fragmentSize)]
      const fragments = groups.flat()
      const results = fragments.length === 0
        ? []
        : await this.dispatch(fragments, spec, route, translator, deadline.signal)
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
          ? this.replaceJsonStringValues(spec.text, spec.jsonTokens, groups, results)
          : results.map((entry) => entry.text).join(''),
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
   * @param groups - fragments belonging to each string value.
   * @param results - translated fragment results in dispatch order.
   * @returns valid JSON with only string values translated.
   */
  replaceJsonStringValues(source, tokens, groups, results) {
    let cursor = 0
    const replacements = tokens.map((token, index) => {
      const count = groups[index].length
      const translated = results.slice(cursor, cursor + count).map((entry) => entry.text).join('')
      cursor += count
      return { ...token, encoded: JSON.stringify(count === 0 ? token.value : translated) }
    })
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
      if (!this.bucket.take()) {
        // The local bucket is shared by every provider, so another provider
        // would be refused too; this failure must never cause a failover.
        throw new TranslationPaneError(
          CODE.rateLimited,
          `translationPane: the ${this.config.rateLimitPerMinute}-request-per-minute limit is exhausted`,
          { limit: this.config.rateLimitPerMinute },
        )
      }
      try {
        return await this.attempt(provider, url, init, signal)
      } catch (error) {
        if (error?.retryable !== true || attempt >= budget) throw error
        const wait = this.backoff(attempt, error)
        this.log('debug', `retrying the ${provider} request after ${wait}ms`)
        await this.sleep(wait, signal)
        attempt += 1
      }
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
        description: `Translate text between languages by sending the submitted text (or, in JSON mode, only decoded JSON string values) to the configured machine-translation provider (Microsoft Edge/Bing or Google Translate on the direct route; the configured provider on the shipped-translator route). Tell the user that their text is processed by that external provider before submitting sensitive or confidential content. Use it when the user asks for a translation, or when you need a sentence rendered in another language. Returns only the translation. For JSON input, pass format="json" to preserve keys, structure and non-string values while translating string values only. Text up to ${resolved.maxTextChars} characters is accepted; longer text is split into provider-sized requests and translated in order, so the result keeps the structure of the source. On the direct endpoint route, if one endpoint cannot be reached and failover is enabled, the other provider may receive the same fragment.`,
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
              enum: ['text', 'json'],
              description: 'Use "json" to preserve JSON keys, nesting, whitespace and non-string values while translating only string values. Defaults to "text".',
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
    ]),
  }),
})
