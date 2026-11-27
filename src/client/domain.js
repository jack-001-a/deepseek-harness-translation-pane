/**
 * Framework-independent client domain rules.
 *
 * This is a real ES module for direct Node tests. The browser build inlines
 * these declarations into the existing ModuleLoader factory; no module
 * imports execute in the browser.
 */

export const GLOSSARY_WARNING_CODES = Object.freeze([
  'invalid-entry',
  'too-many-entries',
  'duplicate-entry',
  'conflicting-entry',
  'overlapping-terms',
])

/**
 * Normalize plain glossary records received across the Host RPC boundary.
 * Invalid rows are skipped instead of turning a valid Host snapshot into a
 * connection failure.
 * @param {unknown} glossary - untrusted Host glossary data.
 * @returns {Array<object>} portable records with only supported fields.
 */
export function normalizeGlossaryEntries(glossary) {
  if (!Array.isArray(glossary)) return []
  return glossary.flatMap((entry) => {
    if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) return []
    if (typeof entry.source !== 'string' || typeof entry.target !== 'string') return []
    const source = entry.source.trim()
    const target = entry.target.trim()
    const hasControlCharacters = (value) => {
      for (let index = 0; index < value.length; index += 1) {
        const code = value.charCodeAt(index)
        if (code <= 0x1f || code === 0x7f) return true
      }
      return false
    }
    if (
      source.length === 0 ||
      target.length === 0 ||
      hasControlCharacters(source) ||
      hasControlCharacters(target)
    ) return []

    const normalized = { source, target }
    if (
      typeof entry.sourceLanguage === 'string' &&
      entry.sourceLanguage.trim().length > 0 &&
      entry.sourceLanguage !== '*'
    ) normalized.sourceLanguage = entry.sourceLanguage
    if (
      typeof entry.targetLanguage === 'string' &&
      entry.targetLanguage.trim().length > 0 &&
      entry.targetLanguage !== '*'
    ) normalized.targetLanguage = entry.targetLanguage
    if (entry.matchCase === true) normalized.matchCase = true
    if (typeof entry.wholeWord === 'boolean') normalized.wholeWord = entry.wholeWord
    if (entry.enabled === false) normalized.enabled = false
    if (
      Number.isInteger(entry.priority) &&
      entry.priority >= -1000 &&
      entry.priority <= 1000 &&
      entry.priority !== 0
    ) normalized.priority = entry.priority
    return [normalized]
  })
}

/**
 * Keep only warning records the current locale can render.
 * @param {unknown} warnings - untrusted Host warning data.
 * @returns {Array<{code: string}>} warning records with known localization keys.
 */
export function normalizeGlossaryWarnings(warnings) {
  if (!Array.isArray(warnings)) return []
  return warnings.filter((warning) =>
    warning !== null &&
    typeof warning === 'object' &&
    !Array.isArray(warning) &&
    GLOSSARY_WARNING_CODES.includes(warning.code),
  ).map((warning) => ({ code: warning.code }))
}

/**
 * Keep Host-advertised ids unique while preserving their first-seen order.
 * @param {unknown} ids - values advertised by the Host.
 * @returns {string[]} unique, non-empty string ids in Host order.
 */
export function uniqueCatalogIds(ids) {
  if (!Array.isArray(ids)) return []
  const seen = new Set()
  return ids.filter((id) => {
    if (typeof id !== 'string' || id.trim().length === 0 || seen.has(id)) return false
    seen.add(id)
    return true
  })
}

/** One visual and localized presentation for each workbench status. */
export const STATUS_PRESENTATION = Object.freeze({
  offline: Object.freeze({ state: 'offline', label: 'status.offline' }),
  error: Object.freeze({ state: 'error', label: 'status.error' }),
  pending: Object.freeze({ state: 'working', label: 'status.translating' }),
  limited: Object.freeze({ state: 'limited', label: 'status.limited' }),
  cancelled: Object.freeze({ state: 'cancelled', label: 'status.cancelled' }),
  connecting: Object.freeze({ state: 'connecting', label: 'status.connecting' }),
  ready: Object.freeze({ state: 'ready', label: 'status.ready' }),
})

/**
 * Resolve status and alert presentation from Host/request facts.
 * Offline and error states take precedence over work-in-progress and limits.
 * @param {object} options - Host/request facts and the active translator.
 * @returns {{alertMessage: string|null, state: string, stateLabel: string}}
 */
export function resolveWorkbenchStatus(options) {
  const { error, offline, pending, overLimit, status, connected, t } = options
  const presentation = offline
    ? STATUS_PRESENTATION.offline
    : error !== null
      ? STATUS_PRESENTATION.error
      : pending
        ? STATUS_PRESENTATION.pending
        : overLimit
          ? STATUS_PRESENTATION.limited
          : status === 'cancelled'
            ? STATUS_PRESENTATION.cancelled
            : !connected
              ? STATUS_PRESENTATION.connecting
              : STATUS_PRESENTATION.ready
  const alertMessage = error !== null ? error : offline ? t('error.offline') : null
  return {
    alertMessage,
    state: presentation.state,
    stateLabel: t(presentation.label),
  }
}

/**
 * Decide whether reversing the current direction would produce a no-op.
 * Auto detect is unavailable until a translation returns a concrete source.
 * @param {object} options - current request and language-selection state.
 * @returns {string|null} reason key, or null when swapping works.
 */
export function resolveLanguageSwapReason({ pending, sourceLanguage, targetLanguage, detectedSource }) {
  if (pending) return 'swap.pending'
  if (sourceLanguage === 'auto') {
    if (typeof detectedSource !== 'string' || detectedSource.trim().length === 0) return 'swap.auto'
    return detectedSource === targetLanguage ? 'swap.same' : null
  }
  return sourceLanguage === targetLanguage ? 'swap.same' : null
}
