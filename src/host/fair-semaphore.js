/**
 * A FIFO semaphore that bounds active provider attempts and pending work.
 *
 * Waiters are cancellable, and releasing a slot grants it to the oldest live
 * waiter. The queue cap prevents unbounded memory growth under load.
 */
export class FairSemaphore {
  /**
   * @param limit - maximum provider attempts active at once.
   * @param maxQueued - maximum pending attempts retained.
   * @param createQueueFullError - creates the caller-specific queue-full error.
   */
  constructor(limit, maxQueued, createQueueFullError) {
    if (typeof createQueueFullError !== 'function') {
      throw new TypeError('FairSemaphore requires a queue-full error factory')
    }
    this.limit = limit
    this.maxQueued = maxQueued
    this.createQueueFullError = createQueueFullError
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
      return Promise.reject(this.createQueueFullError())
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
