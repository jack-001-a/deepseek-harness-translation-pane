import { Buffer } from 'node:buffer'

const CACHE_ENTRY_OVERHEAD_BYTES = 256
// ECMAScript Date TimeClip's largest representable millisecond timestamp.
const MAX_DATE_TIMESTAMP = 8_640_000_000_000_000

/**
 * Copy the plain translation result stored in the cache.
 *
 * Cache results currently contain scalar fields and optional top-level arrays.
 * Copy those arrays both on ingress and egress so neither the original caller
 * nor a later cache-hit caller can mutate data retained for other requests.
 * @param value - the cached translation result.
 * @returns an isolated result object.
 */
function copyCacheValue(value) {
  if (value === null || typeof value !== 'object') return value
  const copy = { ...value }
  for (const [key, field] of Object.entries(copy)) {
    if (Array.isArray(field)) copy[key] = [...field]
  }
  return copy
}

export class TranslationCache {
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
    return copyCacheValue(entry.value)
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

    this.entries.set(key, { value: copyCacheValue(value), bytes: entryBytes })
    this.bytes += entryBytes
    while (this.entries.size > this.limit || this.bytes > this.maxBytes) {
      const oldest = this.entries.entries().next()
      if (oldest.done) break
      const [oldestKey, oldestEntry] = oldest.value
      this.entries.delete(oldestKey)
      this.bytes -= oldestEntry.bytes
    }
  }

  /** Remove every retained translation and reset byte accounting. */
  clear() {
    this.entries.clear()
    this.bytes = 0
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
export class ProviderHealth {
  /**
   * @param cooldownMs - how long one failure is remembered; `0` disables it.
   */
  constructor(cooldownMs, providers = ['bing', 'google']) {
    this.cooldownMs = cooldownMs
    this.providers = [...providers]
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
    // Date#toISOString() rejects timestamps outside the ECMAScript
    // TimeClip range. A large but valid integer config must not make
    // describe() throw after the provider records a failure.
    const until = Math.min(now + this.cooldownMs, MAX_DATE_TIMESTAMP)
    this.failures.set(provider, {
      reason: typeof reason === 'string' ? reason : '',
      until,
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
    for (const provider of this.providers) {
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
export class TokenBucket {
  /**
   * @param perMinute - how many requests are allowed per minute.
   */
  constructor(perMinute, now = Date.now()) {
    this.perMinute = perMinute
    this.capacity = perMinute
    this.tokens = perMinute
    this.updatedAt = now
  }

  /**
   * Take one token when the bucket still has one.
   * @returns whether the request may proceed.
   */
  take(now = Date.now()) {
    if (this.perMinute <= 0) return false
    // Date.now() may move backwards after a system-clock adjustment.
    // Keep a high-water mark so rolling the clock back cannot mint tokens.
    const timestamp = Number.isFinite(now) ? Math.max(this.updatedAt, now) : this.updatedAt
    const elapsed = timestamp - this.updatedAt
    this.updatedAt = timestamp
    this.tokens = Math.min(this.capacity, this.tokens + (elapsed * this.perMinute) / 60000)
    if (this.tokens < 1) return false
    this.tokens -= 1
    return true
  }
}
