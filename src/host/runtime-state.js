import { Buffer } from 'node:buffer'

const CACHE_ENTRY_OVERHEAD_BYTES = 256

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
    const elapsed = Math.max(0, now - this.updatedAt)
    this.updatedAt = now
    this.tokens = Math.min(this.capacity, this.tokens + (elapsed * this.perMinute) / 60000)
    if (this.tokens < 1) return false
    this.tokens -= 1
    return true
  }
}
