/**
 * Small, dependency-free state primitives used by the Host translation service.
 *
 * Keeping cache, provider health and request metering outside the service
 * orchestration makes their lifecycle and invariants testable in isolation.
 */

/**
 * A bounded least-recently-used map of translated documents.
 */
export class TranslationCache {
  /**
   * @param {number} limit - Maximum number of retained entries.
   */
  constructor(limit) {
    this.limit = limit
    this.entries = new Map()
  }

  /**
   * Read one entry and mark it as recently used.
   * @param {string} key - Cache key.
   * @returns {unknown} The cached value, or undefined on a miss.
   */
  get(key) {
    if (!this.entries.has(key)) return undefined
    const value = this.entries.get(key)
    this.entries.delete(key)
    this.entries.set(key, value)
    return value
  }

  /**
   * Store one entry, evicting least-recently-used entries when full.
   * @param {string} key - Cache key.
   * @param {unknown} value - Value to retain.
   */
  set(key, value) {
    if (this.limit <= 0) return
    if (this.entries.has(key)) this.entries.delete(key)
    this.entries.set(key, value)
    while (this.entries.size > this.limit) {
      const oldest = this.entries.keys().next()
      if (oldest.done) break
      this.entries.delete(oldest.value)
    }
  }

  /** @returns {number} Number of retained entries. */
  get size() {
    return this.entries.size
  }
}

/**
 * Per-service observations of direct-provider availability.
 *
 * Health is intentionally ephemeral: it is scoped to one service instance
 * and is not persisted or shared between Harness processes.
 */
export class ProviderHealth {
  /**
   * @param {number} cooldownMs - How long one failure is remembered.
   * @param {string[]} providers - Provider ids included in snapshots.
   */
  constructor(cooldownMs, providers = ['bing', 'google']) {
    this.cooldownMs = cooldownMs
    this.providers = [...providers]
    this.failures = new Map()
  }

  /**
   * Remember a provider failure.
   * @param {string} provider - Provider id.
   * @param {string} reason - Stable failure code.
   * @param {number} now - Current timestamp, injectable for deterministic tests.
   */
  recordFailure(provider, reason, now = Date.now()) {
    if (this.cooldownMs <= 0) return
    this.failures.set(provider, {
      reason: typeof reason === 'string' ? reason : '',
      until: now + this.cooldownMs,
    })
  }

  /**
   * Forget a failure because the provider just answered.
   * @param {string} provider - Provider id.
   */
  recordSuccess(provider) {
    this.failures.delete(provider)
  }

  /**
   * Whether a provider may be tried now.
   * @param {string} provider - Provider id.
   * @param {number} now - Current timestamp, injectable for deterministic tests.
   * @returns {boolean} Whether the provider is outside its cooldown.
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
   * Serializable health facts for the panel.
   * @param {number} now - Current timestamp, injectable for deterministic tests.
   * @returns {Record<string, {unreachable: boolean, until?: string, reason?: string}>}
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

  /** Drop every observation when the service unloads. */
  reset() {
    this.failures.clear()
  }
}

/**
 * A token bucket that meters anonymous provider requests.
 *
 * The bucket refuses work immediately when empty instead of building an
 * unbounded queue. Timestamps are injectable so refill behavior is testable
 * without real sleeps or global clock mutation.
 */
export class TokenBucket {
  /**
   * @param {number} perMinute - Request capacity and refill rate per minute.
   * @param {number} now - Initial timestamp.
   */
  constructor(perMinute, now = Date.now()) {
    this.perMinute = perMinute
    this.capacity = perMinute
    this.tokens = perMinute
    this.updatedAt = now
  }

  /**
   * Take one token when the bucket still has one.
   * @param {number} now - Current timestamp.
   * @returns {boolean} Whether the request may proceed.
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
