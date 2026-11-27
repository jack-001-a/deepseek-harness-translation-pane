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


/**
 * Normalize a stored preference snapshot without discarding custom language
 * tags that may be supported by a newer Host.
 * @param {unknown} value - the parsed storage value.
 * @param {Array<string|{id?: string}>} providerCatalog - supported providers.
 * @returns {{sourceLanguage:string,targetLanguage:string,provider:string,format:string}}
 */
export function normalizePreferences(value, providerCatalog) {
  const saved = value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value
    : {}
  const nonEmptyString = (candidate, fallback) =>
    typeof candidate === 'string' && candidate.trim().length > 0 ? candidate : fallback
  const providerIds = Array.isArray(providerCatalog)
    ? providerCatalog.map((entry) => typeof entry === 'string' ? entry : entry?.id)
    : []

  return {
    sourceLanguage: nonEmptyString(saved.sourceLanguage, 'auto'),
    targetLanguage: nonEmptyString(saved.targetLanguage, 'zh-Hans'),
    provider: providerIds.includes(saved.provider) ? saved.provider : 'bing',
    format: saved.format === 'json' || saved.format === 'markdown' ? saved.format : 'text',
  }
}

/**
 * Build language picker options using local labels for known languages and
 * readable ids for future/custom Host languages.
 * @param {unknown} ids - Host-advertised language ids.
 * @param {boolean} includeAuto - whether Auto detect is available.
 * @param {Array<{id:string,label?:string,zh?:string}>} catalog - local labels.
 * @returns {Array<{id:string,label:string,zh:string}>}
 */
export function languageOptions(ids, includeAuto, catalog) {
  const entries = Array.isArray(catalog) ? catalog : []
  const known = new Map(entries.map((entry) => [entry.id, entry]))
  const advertised = uniqueCatalogIds(ids)
  const source = advertised.length > 0 ? advertised : entries.map((entry) => entry.id)
  const options = []
  for (const id of source) {
    if (id === 'auto' && !includeAuto) continue
    options.push(known.get(id) ?? { id, label: id, zh: id })
  }
  if (includeAuto && !options.some((entry) => entry.id === 'auto')) {
    options.unshift(known.get('auto') ?? { id: 'auto', label: 'Auto detect', zh: '自动检测' })
  }
  return options
}

/**
 * Build provider picker options from the Host's route-specific capabilities.
 * An empty Host catalog retains the historical single-provider fallback.
 * @param {unknown} ids - Host-advertised provider ids.
 * @param {Array<{id:string,label?:string,zh?:string}>} catalog - local labels.
 * @returns {Array<{id:string,label:string,zh:string}>}
 */
export function providerOptions(ids, catalog) {
  const entries = Array.isArray(catalog) ? catalog : []
  const advertised = uniqueCatalogIds(ids)
  if (advertised.length === 0) return entries.slice(0, 1)
  const known = new Map(entries.map((entry) => [entry.id, entry]))
  return advertised.map((id) => known.get(id) ?? { id, label: id, zh: id })
}

/**
 * Normalize the Host's serializable provider-health snapshot. A null-prototype
 * dictionary prevents special property names from changing its prototype.
 * @param {unknown} value - the Host's providerHealth field.
 * @returns {Record<string, {unreachable:boolean}>}
 */
export function normalizeProviderHealth(value) {
  const health = Object.create(null)
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return health
  for (const [provider, entry] of Object.entries(value)) {
    if (
      provider.trim().length === 0 ||
      entry === null ||
      typeof entry !== 'object' ||
      Array.isArray(entry) ||
      typeof entry.unreachable !== 'boolean'
    ) continue
    health[provider] = { unreachable: entry.unreachable }
  }
  return health
}

/**
 * Resolve provider notices and result-service metadata from request facts.
 * @param {object} options - provider health, response metadata and translators.
 * @returns {{notice:string|null,servedLabel:string}}
 */
export function resolveProviderPresentation(options) {
  const {
    pending,result,provider,providerHealth,failoverCapable,error,providerLabel,providerName,t,
  } = options
  const degradedProvider = providerHealth?.[provider]?.unreachable === true
  const mixedServed =
    !pending && Array.isArray(result?.providersServed) && result.providersServed.length > 1
      ? result.providersServed
      : null

  let notice = null
  if (mixedServed !== null) {
    notice = t('notice.mixed', { providers: mixedServed.map(providerName).join(' + ') })
  } else if (
    !pending &&
    result?.failover === true &&
    typeof result.requestedProvider === 'string' &&
    typeof result.provider === 'string' &&
    (result.requestedProvider === provider || result.provider === provider)
  ) {
    notice = t('notice.failover', {
      requested: providerName(result.requestedProvider),
      served: providerName(result.provider),
    })
  } else if (degradedProvider && failoverCapable && error === null) {
    notice = t('notice.providerDown', { provider: providerName(provider) })
  }

  const servedLabel =
    mixedServed !== null
      ? mixedServed.map(providerName).join(' + ')
      : typeof result?.provider === 'string' && result.provider.length > 0 && result.provider !== 'none'
        ? providerName(result.provider)
        : providerLabel
  return { notice, servedLabel }
}
