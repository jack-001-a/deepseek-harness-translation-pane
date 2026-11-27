/**
 * Browser half of the @ybbmm/dsh-translation-pane bundle.
 *
 * Adds one sidebar panel icon and one full-width translation workbench. The
 * workbench translates through the Host half's `translationPane` Remote
 * endpoint over the shared connection RPC, so the same code path serves this
 * panel and the agent's `translate_text` tool.
 *
 * Styles are declared as a React element inside the page component, so
 * unmounting removes them, and use only `--dsw-alias-*` theme tokens so light
 * and dark themes follow the application.
 */
window.__ModuleLoader__.load({
  id: '@ybbmm/dsh-translation-pane',
  factory(require) {
    const React = require('react')
    const h = React.createElement

/**
 * Framework-independent client domain rules.
 *
 * This is a real ES module for direct Node tests. The browser build inlines
 * these declarations into the existing ModuleLoader factory; no module
 * imports execute in the browser.
 */

const GLOSSARY_WARNING_CODES = Object.freeze([
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
function normalizeGlossaryEntries(glossary) {
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
function normalizeGlossaryWarnings(warnings) {
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
function uniqueCatalogIds(ids) {
  if (!Array.isArray(ids)) return []
  const seen = new Set()
  return ids.filter((id) => {
    if (typeof id !== 'string' || id.trim().length === 0 || seen.has(id)) return false
    seen.add(id)
    return true
  })
}

/** One visual and localized presentation for each workbench status. */
const STATUS_PRESENTATION = Object.freeze({
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
function resolveWorkbenchStatus(options) {
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
function resolveLanguageSwapReason({ pending, sourceLanguage, targetLanguage, detectedSource }) {
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
function normalizePreferences(value, providerCatalog) {
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
function languageOptions(ids, includeAuto, catalog) {
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
function providerOptions(ids, catalog) {
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
function normalizeProviderHealth(value) {
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
function resolveProviderPresentation(options) {
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

    // Client source part: locale dictionaries, catalogs and theme-aware stylesheet.
    const NS = 'ybbmm.dsh-translation-pane'
    const PANEL_ID = 'translation-pane'
    const PLUGIN = '@ybbmm/dsh-translation-pane'
    const STORAGE_KEY = 'dsh.translationPane.preferences'
    /** How long the "Copied" confirmation stays visible. */
    const COPIED_FEEDBACK_MS = 1500
    /** Waits between `describe()` attempts while the Host carrier warms up. */
    const DESCRIBE_RETRY_DELAYS_MS = [400, 1200]
    /** Counter behind the per-instance element ids, so two panels never clash. */
    let instanceCount = 0

    /**
     * The English UI dictionary.
     *
     * The key set is the contract of this namespace: `zh` must carry exactly
     * the same keys. Every user-facing sentence lives here, never in the
     * component code, so the panel can be translated without touching logic.
     */
    const EN = {
      'panel.title': 'Translation',
      'page.title': 'Translation',
      'page.subtitle': 'Translate text without leaving the Harness.',
      'empty.title': 'Your translation will appear here',
      'empty.description': 'Add text on the left, choose your languages, and translate when you are ready.',
      'field.source': 'Source',
      'field.target': 'Target',
      'field.service': 'Service',
      'field.format': 'Format',
      'format.text': 'Plain text',
      'format.json': 'JSON values only',
      'format.markdown': 'Markdown (preserve structure)',
      'note.json': 'JSON mode preserves keys, nesting, whitespace, and non-string values. Only string values are sent to the translation provider.',
      'note.markdown': 'Markdown mode translates prose while preserving code blocks, inline code, URLs, link destinations, placeholders, HTML tags, entities, and common Markdown syntax.',
      'label.source': 'Source text',
      'label.result': 'Translation',
      'placeholder.source': 'Type or paste the text to translate.',
      'placeholder.result': 'The translation appears here.',
      'action.translate': 'Translate',
      'action.translating': 'Translating…',
      'action.cancel': 'Cancel',
      'action.swap': 'Swap languages',
      'action.copy': 'Copy',
      'action.copied': 'Copied',
      'action.clear': 'Clear',
      'action.retry': 'Retry',
      'meta.route': 'Route: {route}',
      'meta.provider': 'Service: {provider}',
      'meta.count': '{count} / {limit}',
      'meta.over': 'Too long by {count} characters; shorten it and translate again.',
      'meta.limitPending': 'Checking the length limit…',
      'meta.duration': '{ms} ms',
      'meta.cached': 'From cache',
      'meta.fresh': 'Translated',
      'meta.detectedSource': 'Detected source: {language}',
      'status.ready': 'Ready',
      'status.connecting': 'Connecting to the Host…',
      'status.translating': 'Translating',
      'status.error': 'Failed',
      'status.offline': 'Offline',
      'status.limited': 'Too long',
      'status.cancelled': 'Cancelled',
      'error.empty': 'Enter the text to translate first.',
      'error.generic': 'The translation failed.',
      'error.disconnected': 'The Harness is not connected to its Host.',
      'error.invalidRequest':
        'The translation request was rejected as invalid. Check the text and the language choices.',
      'error.textLimit':
        'The text is longer than this Host accepts in one request. Shorten it and translate again.',
      'error.providerUnavailable':
        'The selected translation service is unavailable right now. Choose another service, or try again in a moment.',
      'error.timeout': 'The translation service did not answer in time. Try again, or shorten the text.',
      'error.rateLimited':
        'Too many translation requests were sent too quickly. Wait a moment before trying again.',
      'error.busy':
        'The translation service is busy. Wait for a request to finish, or cancel an older request and try again.',
      'error.providerError':
        'The translation service failed to translate the text. Try again, or choose another service.',
      'error.invalidResponse':
        'The translation service answered with something the Harness could not read. Try again.',
      'error.offline':
        'The Harness cannot reach its Host. Check that the Host is running, then try again.',
      'error.providerUnreachable':
        'The Host could not reach the translation service. Try again, or choose another service.',
      'error.copyFailed': 'The translation could not be copied to the clipboard.',
      'swap.auto':
        'The source language is Auto detect, so the languages cannot be swapped yet. Pick a specific source language first.',
      'swap.same': 'The source and target languages are the same, so there is nothing to swap.',
      'swap.unknown':
        'The source language has not been detected yet, so the languages cannot be swapped. Translate once, then swap.',
      'swap.pending': 'A translation is already running. Cancel it before swapping languages.',
      'hint.keyboard': 'Ctrl/⌘+Enter translates · Esc cancels while translating.',
      'notice.providerDown':
        'The {provider} service is unavailable right now; translations will automatically use the other service.',
      'notice.failover': 'The {requested} service could not answer, so the Host translated with {served}.',
      'notice.mixed': 'More than one service answered this text ({providers}).',
      'route.translator': 'Translation service',
      'route.direct': 'Direct endpoint',
      'glossary.title': 'Terminology glossary',
      'glossary.note': 'Import versioned JSON or a legacy array. Changes apply to this Host session; export the JSON and add it to the profile patch to keep it after restart.',
      'glossary.placeholder': 'Paste glossary JSON here…',
      'glossary.apply': 'Apply glossary',
      'glossary.export': 'Copy / export JSON',
      'glossary.import': 'Import JSON file',
      'glossary.applied': 'Applied {count} glossary terms to this Host session.',
      'glossary.exported': 'Glossary JSON copied to the clipboard.',
      'glossary.invalidFile': 'Could not read this glossary file.',
      'glossary.warning.invalid-entry': 'An invalid glossary entry was skipped.',
      'glossary.warning.too-many-entries': 'The glossary exceeds the maximum of 128 entries.',
      'glossary.warning.duplicate-entry': 'Duplicate source term; the first entry is retained.',
      'glossary.warning.conflicting-entry': 'A source term has conflicting translations; resolve the duplicate before importing.',
      'glossary.warning.overlapping-terms': 'Overlapping terms detected. Priority wins first, then the longest match.',
      'glossary.warningCount': '{count} glossary warnings need review.',
    }

    /**
     * The Simplified Chinese UI dictionary; the key set mirrors {@link EN}.
     */
    const ZH = {
      'panel.title': '翻译',
      'page.title': '翻译',
      'page.subtitle': '不离开 Harness 就能翻译文本。',
      'empty.title': '译文将在这里呈现',
      'empty.description': '在左侧输入文本，选择语言，然后开始翻译。',
      'field.source': '源语言',
      'field.target': '目标语言',
      'field.service': '翻译服务',
      'field.format': '内容格式',
      'format.text': '普通文本',
      'format.json': '仅翻译 JSON 字符串值',
      'format.markdown': 'Markdown（保留文档结构）',
      'note.json': 'JSON 模式会保留键名、层级、空白格式及非字符串值，只会将字符串值发送给翻译服务。',
      'note.markdown': 'Markdown 模式只翻译自然语言文本，保留代码块、行内代码、URL、链接目标、模板变量、HTML 标签、实体和常见 Markdown 语法。',
      'label.source': '原文',
      'label.result': '译文',
      'placeholder.source': '输入或粘贴要翻译的文本。',
      'placeholder.result': '译文会显示在这里。',
      'action.translate': '翻译',
      'action.translating': '翻译中…',
      'action.cancel': '取消',
      'action.swap': '交换语言',
      'action.copy': '复制',
      'action.copied': '已复制',
      'action.clear': '清空',
      'action.retry': '重试',
      'meta.route': '通道：{route}',
      'meta.provider': '服务：{provider}',
      'meta.count': '{count} / {limit}',
      'meta.over': '超出 {count} 个字符，请精简后再翻译。',
      'meta.limitPending': '正在检查长度上限…',
      'meta.duration': '{ms} 毫秒',
      'meta.cached': '来自缓存',
      'meta.fresh': '已翻译',
      'meta.detectedSource': '检测到的源语言：{language}',
      'status.ready': '就绪',
      'status.connecting': '正在连接 Host…',
      'status.translating': '翻译中',
      'status.error': '失败',
      'status.offline': '离线',
      'status.limited': '超长',
      'status.cancelled': '已取消',
      'error.empty': '请先输入要翻译的文本。',
      'error.generic': '翻译失败。',
      'error.disconnected': 'Harness 未连接到 Host。',
      'error.invalidRequest': '翻译请求无效，请检查文本和语言设置。',
      'error.textLimit': '文本超过 Host 单次请求的长度上限，请精简后再翻译。',
      'error.providerUnavailable': '当前选中的翻译服务不可用，请更换服务或稍后重试。',
      'error.timeout': '翻译服务响应超时，请重试或缩短文本。',
      'error.rateLimited': '翻译请求过于频繁，请稍候再试。',
      'error.busy': '翻译服务当前繁忙，请等待已有请求完成，或取消较早的请求后重试。',
      'error.providerError': '翻译服务处理失败，请重试或更换服务。',
      'error.invalidResponse': '翻译服务返回了无法解析的内容，请重试。',
      'error.offline': 'Harness 无法连接到 Host，请确认 Host 正在运行后重试。',
      'error.providerUnreachable': 'Host 无法连接翻译服务，请重试或更换服务。',
      'error.copyFailed': '译文无法复制到剪贴板。',
      'swap.auto': '源语言为“自动检测”时无法交换，请先选择具体的源语言。',
      'swap.same': '源语言与目标语言相同，无需交换。',
      'swap.unknown': '尚未识别出源语言，暂时无法交换语言；先翻译一次即可交换。',
      'swap.pending': '已有翻译正在进行，请先取消再交换语言。',
      'hint.keyboard': 'Ctrl/⌘+Enter 翻译 · 翻译中按 Esc 取消。',
      'notice.providerDown': '当前 {provider} 服务不可用，翻译将自动改用另一项服务。',
      'notice.failover': '{requested} 服务未能完成翻译，Host 已改用 {served} 完成。',
      'notice.mixed': '这篇文本由多项服务共同完成（{providers}）。',
      'route.translator': '翻译服务',
      'route.direct': '直连端点',
      'glossary.title': '术语表',
      'glossary.note': '支持导入版本化 JSON 或旧版数组。修改仅在当前 Host 会话生效；如需重启后保留，请导出 JSON 并写入插件 profile 配置。',
      'glossary.placeholder': '在此粘贴术语表 JSON…',
      'glossary.apply': '应用术语表',
      'glossary.export': '复制 / 导出 JSON',
      'glossary.import': '导入 JSON 文件',
      'glossary.applied': '已在当前 Host 会话应用 {count} 条术语。',
      'glossary.exported': '术语表 JSON 已复制到剪贴板。',
      'glossary.invalidFile': '无法读取术语表文件。',
      'glossary.warning.invalid-entry': '已跳过无效术语条目。',
      'glossary.warning.too-many-entries': '术语表超过 128 条上限。',
      'glossary.warning.duplicate-entry': '发现重复原文术语，保留第一条。',
      'glossary.warning.conflicting-entry': '同一原文术语存在不同译法，请先解决冲突。',
      'glossary.warning.overlapping-terms': '发现术语重叠；将先按优先级、再按最长匹配处理。',
      'glossary.warningCount': '有 {count} 条术语警告需要检查。',
    }

    /**
     * The languages the panel can name; the ids match the Host catalog.
     *
     * The Host's `describe()` catalog wins at runtime; this list is the
     * fallback for the moment before the Host has answered, and the source of
     * the display names.
     */
    const LANGUAGE_CATALOG = [
      { id: 'auto', label: 'Auto detect', zh: '自动检测' },
      { id: 'zh-Hans', label: 'Chinese (Simplified)', zh: '简体中文' },
      { id: 'zh-Hant', label: 'Chinese (Traditional)', zh: '繁体中文' },
      { id: 'en', label: 'English', zh: '英语' },
      { id: 'ja', label: 'Japanese', zh: '日语' },
      { id: 'ko', label: 'Korean', zh: '韩语' },
      { id: 'fr', label: 'French', zh: '法语' },
      { id: 'de', label: 'German', zh: '德语' },
      { id: 'es', label: 'Spanish', zh: '西班牙语' },
      { id: 'ru', label: 'Russian', zh: '俄语' },
      { id: 'pt', label: 'Portuguese', zh: '葡萄牙语' },
      { id: 'it', label: 'Italian', zh: '意大利语' },
      { id: 'ar', label: 'Arabic', zh: '阿拉伯语' },
      { id: 'th', label: 'Thai', zh: '泰语' },
      { id: 'vi', label: 'Vietnamese', zh: '越南语' },
    ]

    /** The translation services the panel can name; ids match the Host catalog. */
    const PROVIDER_CATALOG = [
      // Every entry carries both names: the panel renders an option through the
      // active locale, and a missing translation would leave the select blank.
      { id: 'bing', label: 'Bing', zh: '必应' },
      { id: 'google', label: 'Google', zh: '谷歌' },
    ]

    /**
     * The Host's stable error codes mapped to this namespace's dictionary keys.
     *
     * The Host classifies every failure it can and raises one of these codes;
     * the API Gateway forwards the code unchanged because the Host error is a
     * DSH remote error. Unknown codes fall back to generic copy, because the
     * Host's raw message is diagnostic text meant for logs, not for users.
     */
    const HOST_ERROR_KEYS = Object.freeze({
      'translation-pane/invalid-request': 'error.invalidRequest',
      'translation-pane/text-limit': 'error.textLimit',
      'translation-pane/provider-unavailable': 'error.providerUnavailable',
      'translation-pane/timeout': 'error.timeout',
      'translation-pane/rate-limited': 'error.rateLimited',
      'translation-pane/busy': 'error.busy',
      'translation-pane/provider-error': 'error.providerError',
      'translation-pane/invalid-response': 'error.invalidResponse',
      'translation-pane/offline': 'error.offline',
      'translation-pane/provider-unreachable': 'error.providerUnreachable',
    })

    /** The page's own stylesheet, rendered as an element so it unmounts. */
    const CSS = `
.dshTr-page { box-sizing: border-box; width: 100%; height: 100%; min-height: 0; flex: 1 1 auto; overflow-y: auto; overscroll-behavior: contain; }
.dshTr { box-sizing: border-box; width: 100%; max-width: 900px; margin: 0 auto; padding: 20px 24px 40px; color: var(--dsw-alias-label-primary); }
.dshTr *, .dshTr *::before, .dshTr *::after { box-sizing: border-box; }
.dshTr-head { display: flex; align-items: flex-start; justify-content: space-between; gap: 16px; margin-bottom: 18px; }
.dshTr-title { margin: 0; font-size: 18px; line-height: 26px; font-weight: 650; letter-spacing: .01em; }
.dshTr-subtitle { margin: 2px 0 0; color: var(--dsw-alias-label-secondary); font-size: 12px; line-height: 18px; }
.dshTr-status { flex: none; display: inline-flex; align-items: center; gap: 6px; padding: 3px 9px; border: 1px solid var(--dsw-alias-border-l1); border-radius: 999px; color: var(--dsw-alias-label-secondary); background: var(--dsw-alias-bg-layer-1); font-size: 11px; line-height: 16px; white-space: nowrap; }
.dshTr-status[data-state="ready"] { color: var(--dsw-alias-state-success-primary); border-color: color-mix(in srgb, var(--dsw-alias-state-success-primary) 30%, var(--dsw-alias-border-l1)); }
.dshTr-status[data-state="error"] { color: var(--dsw-alias-state-error-primary); border-color: color-mix(in srgb, var(--dsw-alias-state-error-primary) 30%, var(--dsw-alias-border-l1)); }
.dshTr-status[data-state="working"] { color: var(--dsw-alias-brand-primary); border-color: color-mix(in srgb, var(--dsw-alias-brand-primary) 30%, var(--dsw-alias-border-l1)); }
.dshTr-status[data-state="limited"] { color: var(--dsw-alias-state-warn-primary); border-color: color-mix(in srgb, var(--dsw-alias-state-warn-primary) 30%, var(--dsw-alias-border-l1)); }
.dshTr-status[data-state="offline"] { color: var(--dsw-alias-state-error-primary); border-color: color-mix(in srgb, var(--dsw-alias-state-error-primary) 30%, var(--dsw-alias-border-l1)); }
.dshTr-status[data-state="cancelled"] { color: var(--dsw-alias-label-secondary); }
.dshTr-statusDot { width: 6px; height: 6px; border-radius: 50%; background: currentColor; }
.dshTr-controls { display: flex; align-items: flex-end; flex-wrap: wrap; gap: 10px; margin-bottom: 14px; padding: 12px 14px; border: 1px solid var(--dsw-alias-border-l1); border-radius: 12px; background: var(--dsw-alias-bg-layer-1); }
.dshTr-field { display: grid; gap: 5px; min-width: 0; flex: 1 1 150px; }
.dshTr-fieldLabel { color: var(--dsw-alias-label-secondary); font-size: 11px; line-height: 16px; font-weight: 500; letter-spacing: .02em; }
.dshTr-select { width: 100%; min-height: 34px; padding: 6px 10px; border: 1px solid var(--dsw-alias-border-l2); border-radius: 8px; color: var(--dsw-alias-label-primary); background: var(--dsw-alias-bg-base); font: inherit; font-size: 13px; line-height: 20px; cursor: pointer; }
.dshTr-select:hover:not(:disabled) { border-color: color-mix(in srgb, var(--dsw-alias-brand-primary) 45%, var(--dsw-alias-border-l2)); }
.dshTr-select:focus-visible, .dshTr-button:focus-visible, .dshTr-ghost:focus-visible, .dshTr-swap:focus-visible { outline: 2px solid var(--dsw-alias-brand-primary); outline-offset: 2px; }
.dshTr-select:disabled { opacity: .55; cursor: default; }
.dshTr-swap { flex: none; width: 34px; height: 34px; display: grid; place-items: center; padding: 0; border: 1px solid var(--dsw-alias-border-l2); border-radius: 8px; color: var(--dsw-alias-label-secondary); background: var(--dsw-alias-bg-base); cursor: pointer; }
.dshTr-swap:hover:not([aria-disabled="true"]) { color: var(--dsw-alias-brand-primary); border-color: color-mix(in srgb, var(--dsw-alias-brand-primary) 45%, var(--dsw-alias-border-l2)); }
.dshTr-swap[aria-disabled="true"] { opacity: .55; cursor: default; }
.dshTr-grid { display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 1fr); gap: 12px; }
.dshTr-grid[data-stacked="true"] { grid-template-columns: minmax(0, 1fr); }
.dshTr-card { display: flex; flex-direction: column; min-width: 0; max-height: max(45vh, 264px); border: 1px solid var(--dsw-alias-border-l1); border-radius: 12px; background: var(--dsw-alias-bg-layer-1); overflow: hidden; }
.dshTr-cardHead { display: flex; align-items: center; justify-content: space-between; gap: 8px; padding: 9px 12px; border-bottom: 1px solid var(--dsw-alias-border-l1); background: var(--dsw-alias-bg-layer-2); }
.dshTr-cardTitle { color: var(--dsw-alias-label-secondary); font-size: 11px; line-height: 16px; font-weight: 600; letter-spacing: .04em; text-transform: uppercase; }
.dshTr-cardTools { display: flex; align-items: center; gap: 4px; }
.dshTr-area { width: 100%; min-height: 220px; flex: 1 1 auto; padding: 12px 14px; border: 0; color: var(--dsw-alias-label-primary); background: transparent; font: inherit; font-size: 14px; line-height: 22px; resize: none; overflow-y: auto; }
.dshTr-area::placeholder { color: var(--dsw-alias-label-secondary); }
.dshTr-area:focus-visible { outline: 2px solid var(--dsw-alias-brand-primary); outline-offset: -2px; }
.dshTr-out { min-height: 220px; flex: 1 1 auto; padding: 12px 14px; overflow-y: auto; overflow-wrap: anywhere; font-size: 14px; line-height: 22px; white-space: pre-wrap; user-select: text; -webkit-user-select: text; }
.dshTr-out:focus-visible { outline: 2px solid var(--dsw-alias-brand-primary); outline-offset: -2px; }
.dshTr-out[data-empty="true"] { color: var(--dsw-alias-label-secondary); }
.dshTr-ghost { padding: 3px 8px; border: 1px solid transparent; border-radius: 6px; color: var(--dsw-alias-label-secondary); background: transparent; font: inherit; font-size: 11px; line-height: 16px; cursor: pointer; }
.dshTr-ghost:hover:not(:disabled) { color: var(--dsw-alias-label-primary); background: var(--dsw-alias-bg-base); border-color: var(--dsw-alias-border-l2); }
.dshTr-ghost:disabled { opacity: .45; cursor: default; }
.dshTr-foot { display: flex; align-items: center; flex-wrap: wrap; gap: 10px; margin-top: 12px; }
.dshTr-button { display: inline-flex; align-items: center; justify-content: center; gap: 6px; min-height: 34px; padding: 7px 18px; border: 1px solid transparent; border-radius: 8px; color: #fff; background: var(--dsw-alias-brand-primary); font: inherit; font-size: 13px; line-height: 20px; font-weight: 600; cursor: pointer; }
.dshTr-button:hover:not(:disabled) { filter: brightness(1.06); }
.dshTr-button:disabled { opacity: .55; cursor: default; }
.dshTr-buttonGhost { color: var(--dsw-alias-label-primary); background: transparent; border-color: var(--dsw-alias-border-l2); }
.dshTr-buttonGhost:hover:not(:disabled) { background: var(--dsw-alias-bg-layer-2); filter: none; }
.dshTr-counter { margin-left: auto; color: var(--dsw-alias-label-secondary); font-size: 11px; line-height: 16px; font-variant-numeric: tabular-nums; }
.dshTr-counter[data-over="true"] { color: var(--dsw-alias-state-error-primary); font-weight: 600; }
.dshTr-meta { display: flex; align-items: center; flex-wrap: wrap; gap: 12px; margin-top: 10px; color: var(--dsw-alias-label-secondary); font-size: 11px; line-height: 16px; }
.dshTr-note { margin: 0; color: var(--dsw-alias-label-secondary); font-size: 11px; line-height: 17px; }
.dshTr-notice { margin: 0 0 12px; padding: 8px 12px; border: 1px solid color-mix(in srgb, var(--dsw-alias-state-warn-primary) 32%, var(--dsw-alias-border-l2)); border-radius: 10px; color: var(--dsw-alias-state-warn-primary); background: color-mix(in srgb, var(--dsw-alias-state-warn-primary) 7%, transparent); font-size: 12px; line-height: 18px; overflow-wrap: anywhere; }
.dshTr-hint { color: var(--dsw-alias-label-secondary); font-size: 11px; line-height: 16px; }
.dshTr-error { margin-top: 12px; padding: 10px 12px; border: 1px solid color-mix(in srgb, var(--dsw-alias-state-error-primary) 32%, var(--dsw-alias-border-l2)); border-radius: 10px; color: var(--dsw-alias-state-error-primary); background: color-mix(in srgb, var(--dsw-alias-state-error-primary) 7%, transparent); font-size: 12px; line-height: 19px; overflow-wrap: anywhere; }
.dshTr-glossary { display: grid; gap: 8px; margin-top: 20px; padding: 14px; border: 1px solid var(--dsw-alias-border-l1); border-radius: 12px; background: var(--dsw-alias-bg-layer-1); }
.dshTr-glossaryHead, .dshTr-glossaryActions { display: flex; align-items: center; flex-wrap: wrap; gap: 8px; }
.dshTr-glossaryHead { justify-content: space-between; }
.dshTr-glossaryTitle { margin: 0; color: var(--dsw-alias-label-primary); font-size: 13px; font-weight: 650; }
.dshTr-glossaryCount { color: var(--dsw-alias-label-secondary); font-size: 11px; font-variant-numeric: tabular-nums; }
.dshTr-glossaryArea { width: 100%; min-height: 160px; padding: 10px 12px; border: 1px solid var(--dsw-alias-border-l2); border-radius: 8px; color: var(--dsw-alias-label-primary); background: var(--dsw-alias-bg-base); font: 12px/18px ui-monospace, SFMono-Regular, Consolas, monospace; resize: vertical; }
.dshTr-glossaryArea:focus-visible { outline: 2px solid var(--dsw-alias-brand-primary); outline-offset: 1px; }
.dshTr-glossaryActions { align-items: center; }
.dshTr-import { display: inline-flex; align-items: center; min-height: 34px; padding: 7px 12px; border: 1px solid var(--dsw-alias-border-l2); border-radius: 8px; color: var(--dsw-alias-label-primary); font-size: 12px; cursor: pointer; }
.dshTr-import input { max-width: 180px; font-size: 11px; }
.dshTr-glossaryMessage, .dshTr-glossaryWarnings { margin: 0; color: var(--dsw-alias-label-secondary); font-size: 11px; line-height: 17px; overflow-wrap: anywhere; }
.dshTr-glossaryWarnings { padding-left: 18px; color: var(--dsw-alias-state-warn-primary); }

.dshTr-icon { display: block; }

/* A calm, high-density workbench with the host application's theme as its source of truth. */
.dshTr-page { container-type: inline-size; }
.dshTr { max-width: 1120px; padding: clamp(20px, 2.8vw, 36px) clamp(16px, 3vw, 40px) 48px; }
.dshTr-head { align-items: center; margin-bottom: 22px; }
.dshTr-title { font-size: 24px; line-height: 32px; font-weight: 700; letter-spacing: -.025em; }
.dshTr-subtitle { margin-top: 4px; font-size: 13px; line-height: 20px; }
.dshTr-status { padding: 5px 11px; gap: 8px; font-size: 12px; backdrop-filter: blur(12px); }
.dshTr-statusDot { width: 7px; height: 7px; }
.dshTr-status[data-state="working"] .dshTr-statusDot { animation: dshTr-pulse 1.15s ease-in-out infinite; }
.dshTr-controls {
  display: grid;
  grid-template-columns: minmax(0, 1fr) 38px minmax(0, 1fr) minmax(130px, .82fr) minmax(150px, 1fr);
  align-items: end;
  gap: 12px;
  margin-bottom: 18px;
  padding: 16px;
  border-radius: 16px;
  box-shadow: 0 1px 2px color-mix(in srgb, var(--dsw-alias-label-primary) 5%, transparent);
}
.dshTr-field { flex: initial; gap: 6px; }
.dshTr-fieldLabel { font-size: 12px; line-height: 17px; }
.dshTr-select { min-height: 40px; padding: 8px 12px; border-radius: 10px; transition: border-color .16s ease, background-color .16s ease; }
.dshTr-swap { width: 38px; height: 40px; margin-bottom: 0; border-radius: 10px; transition: color .16s ease, border-color .16s ease, background-color .16s ease, transform .16s ease; }
.dshTr-swap:hover:not([aria-disabled="true"]) { transform: translateY(-1px); }
.dshTr-grid { align-items: stretch; gap: 16px; }
.dshTr-card { min-height: 360px; max-height: 560px; border-radius: 16px; box-shadow: 0 1px 2px color-mix(in srgb, var(--dsw-alias-label-primary) 5%, transparent); }
.dshTr-cardHead { min-height: 48px; padding: 12px 16px; }
.dshTr-cardTitle { font-size: 12px; letter-spacing: .06em; }
.dshTr-area, .dshTr-out { min-height: 300px; padding: 18px 20px; font-size: 14px; line-height: 24px; }
.dshTr-ghost { padding: 5px 10px; border-radius: 8px; font-size: 12px; line-height: 18px; transition: color .16s ease, background-color .16s ease, border-color .16s ease; }
.dshTr-button { min-height: 40px; padding: 9px 20px; border-radius: 10px; transition: transform .16s ease, filter .16s ease, box-shadow .16s ease; box-shadow: 0 1px 2px color-mix(in srgb, var(--dsw-alias-label-primary) 12%, transparent); }
.dshTr-button:hover:not(:disabled) { transform: translateY(-1px); box-shadow: 0 4px 12px color-mix(in srgb, var(--dsw-alias-label-primary) 12%, transparent); }
.dshTr-button:active:not(:disabled) { transform: translateY(0); }
.dshTr-buttonGhost { box-shadow: none; }
.dshTr-foot { margin-top: 16px; gap: 12px; }
.dshTr-hint, .dshTr-counter { font-size: 12px; line-height: 18px; }
.dshTr-meta { gap: 8px; margin-top: 14px; }
.dshTr-meta > span { display: inline-flex; align-items: center; min-height: 26px; padding: 4px 9px; border: 1px solid var(--dsw-alias-border-l1); border-radius: 999px; background: var(--dsw-alias-bg-layer-1); }
.dshTr-note { font-size: 12px; line-height: 19px; }
.dshTr-notice, .dshTr-error { padding: 10px 14px; border-radius: 12px; font-size: 12px; line-height: 19px; }
.dshTr-glossary { margin-top: 24px; padding: 16px; border-radius: 16px; }
.dshTr-glossaryDetails { display: grid; gap: 10px; }
.dshTr-glossarySummary { display: flex; align-items: center; gap: 12px; list-style: none; cursor: pointer; }
.dshTr-glossarySummary::-webkit-details-marker { display: none; }
.dshTr-glossarySummary:focus-visible { outline: 2px solid var(--dsw-alias-brand-primary); outline-offset: 4px; border-radius: 6px; }
.dshTr-glossarySummary::after { content: '+'; flex: none; color: var(--dsw-alias-label-secondary); font-size: 20px; line-height: 20px; }
.dshTr-glossaryDetails[open] > .dshTr-glossarySummary::after { content: '−'; }
.dshTr-glossaryHead { display: flex; align-items: center; justify-content: space-between; gap: 12px; min-width: 0; flex: 1 1 auto; }
.dshTr-glossaryArea { min-height: 150px; border-radius: 10px; font-size: 12px; line-height: 19px; }
.dshTr-import { gap: 8px; border-radius: 10px; }
.dshTr-empty {
  display: flex;
  min-height: 300px;
  height: 100%;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 9px;
  padding: 28px;
  text-align: center;
}
.dshTr-emptyIcon { display: grid; width: 48px; height: 48px; place-items: center; margin-bottom: 3px; border: 1px solid color-mix(in srgb, var(--dsw-alias-brand-primary) 22%, var(--dsw-alias-border-l1)); border-radius: 15px; color: var(--dsw-alias-brand-primary); background: color-mix(in srgb, var(--dsw-alias-brand-primary) 8%, var(--dsw-alias-bg-layer-2)); }
.dshTr-emptyIcon .dshTr-icon { width: 24px; height: 24px; }
.dshTr-emptyTitle { color: var(--dsw-alias-label-primary); font-size: 14px; line-height: 20px; font-weight: 650; }
.dshTr-emptyDescription { max-width: 36ch; color: var(--dsw-alias-label-secondary); font-size: 12px; line-height: 19px; }
.dshTr-loading { display: flex; min-height: 300px; height: 100%; align-items: center; justify-content: center; gap: 10px; color: var(--dsw-alias-label-secondary); font-size: 13px; }
.dshTr-spinner { display: block; width: 18px; height: 18px; border: 2px solid var(--dsw-alias-border-l2); border-top-color: var(--dsw-alias-brand-primary); border-radius: 50%; animation: dshTr-spin .8s linear infinite; }
@keyframes dshTr-spin { to { transform: rotate(360deg); } }
@keyframes dshTr-pulse { 0%, 100% { opacity: 1; } 50% { opacity: .42; } }

@container (max-width: 720px) {
  .dshTr { padding: 18px 16px 34px; }
  .dshTr-controls { grid-template-columns: minmax(0, 1fr) 36px minmax(0, 1fr); gap: 10px; padding: 12px; }
  .dshTr-grid { grid-template-columns: minmax(0, 1fr); }
  .dshTr-card { min-height: 280px; max-height: 440px; }
  .dshTr-area, .dshTr-out, .dshTr-empty, .dshTr-loading { min-height: 230px; }
  .dshTr-title { font-size: 21px; line-height: 28px; }
}
@container (max-width: 420px) {
  .dshTr { padding: 16px 12px 28px; }
  .dshTr-head { align-items: flex-start; flex-direction: column; gap: 10px; }
  .dshTr-controls { grid-template-columns: minmax(0, 1fr) 34px minmax(0, 1fr); gap: 8px; padding: 10px; }
  .dshTr-select { padding: 7px 8px; font-size: 12px; }
  .dshTr-card { min-height: 250px; }
  .dshTr-area, .dshTr-out, .dshTr-empty, .dshTr-loading { min-height: 210px; }
  .dshTr-area, .dshTr-out { padding: 14px; }
  .dshTr-foot { gap: 8px; }
  .dshTr-button { min-height: 38px; padding: 8px 14px; }
}
@media (prefers-reduced-motion: reduce) {
  .dshTr *, .dshTr *::before, .dshTr *::after {
    animation-duration: .01ms !important;
    animation-iteration-count: 1 !important;
    transition-duration: .01ms !important;
    scroll-behavior: auto !important;
  }
}
`

    /** One Host failure, carrying the stable code the Host raised. */

    // Client source part: Host transport, preferences, glossary normalization and display utilities.
    class HostError extends Error {
      /**
       * @param code - the Host's stable error code, empty when there is none.
       * @param message - the Host's diagnostic message.
       * @param details - the Host's structured error details, when present.
       */
      constructor(code, message, details) {
        super(message)
        this.name = 'HostError'
        this.code = code
        this.details = details
      }
    }

    /**
     * Read an optional client service without failing when it is absent.
     * @param ctx - the client plugin context.
     * @param name - the Cordis service key.
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
     * Read the saved preferences, tolerating a locked-down storage.
     * @returns the stored preferences, or an empty object.
     */
    function readPreferences() {
      try {
        const raw = globalThis.localStorage?.getItem(STORAGE_KEY)
        if (typeof raw !== 'string') return {}
        const parsed = JSON.parse(raw)
        return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {}
      } catch {
        return {}
      }
    }

    /**
     * Save the preferences, ignoring a locked-down storage.
     * @param next - the preferences to store.
     * @returns nothing.
     */
    function writePreferences(next) {
      try {
        globalThis.localStorage?.setItem(STORAGE_KEY, JSON.stringify(next))
      } catch {
        // A read-only storage only costs the user their last selection.
      }
    }

    /**
     * The translator bound to this plugin's locale namespace.
     * @returns the translator, or a key-echoing stub before the locale service exists.
     */
    function boundTranslate() {
      try {
        const locale = optionalService(ctx, 'locale')
        if (typeof locale?.bind === 'function') return locale.bind(NS)
      } catch {
        // The locale service is not mounted yet; the key echo keeps the UI legible.
      }
      return (key) => key
    }

    /**
     * Serialize a glossary into the portable, versioned JSON format.
     * @param glossary - Host glossary entries.
     * @returns formatted JSON suitable for export or editing.
     */
    function glossaryJson(glossary) {
      return JSON.stringify({ version: 1, glossary: normalizeGlossaryEntries(glossary) }, null, 2)
    }

    /**
     * Call one Host method of this bundle.
     *
     * The shipped `dsh-client-connection` RPC takes the cancellation signal as
     * its fourth argument — `call(channel, endpoint, payload, signal)` — and
     * forwards it to the underlying `fetch`, so aborting a request tears the
     * HTTP call down instead of merely ignoring its answer.
     * @param ctx - the client plugin context.
     * @param method - Host method name on the `translationPane` service.
     * @param args - named arguments for that method.
     * @param signal - cancellation signal for this call.
     * @returns the Host's returned value.
     */
    async function callHost(ctx, method, args, signal) {
      const connection = optionalService(ctx, 'connection')
      if (connection === undefined || typeof connection.rpc?.call !== 'function') {
        throw new HostError('translation-pane/offline', 'the connection service is unavailable')
      }
      let result
      try {
        result = await connection.rpc.call('/api', `translationPane/${method}`, { args }, signal)
      } catch (failure) {
        // A rejected carrier is a transport failure, not a Host verdict; the
        // caller still checks the signal so an abort is not reported offline.
        throw new HostError(
          'translation-pane/offline',
          failure instanceof Error ? failure.message : String(failure),
        )
      }
      if (result?.ok !== true) {
        const failure = result?.error
        throw new HostError(
          typeof failure?.code === 'string' ? failure.code : '',
          typeof failure?.message === 'string' ? failure.message : '',
          failure?.details,
        )
      }
      return result.value
    }

    /**
     * Whether the carrier reports that it cannot reach the Host.
     *
     * The panel must say so plainly instead of waiting forever, but a carrier
     * that is still dialling the Host is not a failure yet.
     * @returns whether the Host is known to be unreachable.
     */
    function carrierUnreachable() {
      const state = optionalService(ctx, 'connection')?.state
      const snapshot = state?.getSnapshot?.()
      // Without a connection state service, the failed calls are the only
      // evidence available.
      if (snapshot === undefined) return true
      if (snapshot === 'connecting') return false
      return snapshot !== 'connected'
    }

    /**
     * Localize one Host failure.
     * @param failure - the thrown failure.
     * @param t - the bound translation function.
     * @returns the localized sentence for the failure.
     */
    function messageFor(failure, t) {
      const code = typeof failure?.code === 'string' ? failure.code : ''
      const key = HOST_ERROR_KEYS[code]
      if (key !== undefined) return t(key)
      // An unclassified failure still carries a Host diagnostic; it is kept
      // out of the sentence, because it is written for logs rather than users.
      return t('error.generic')
    }

    /**
     * The diagnostic text behind one failure, for the console and the title.
     * @param failure - the thrown failure.
     * @returns the diagnostic message, or an empty string.
     */
    function diagnosticFor(failure) {
      const message = typeof failure?.message === 'string' ? failure.message : ''
      return message
    }

    /**
     * Ensure a control's current value has a matching option.
     * @param options - the option list.
     * @param value - the currently selected id.
     * @returns the option list, with the value appended when it is missing.
     */
    function withValue(options, value) {
      if (options.some((option) => option.id === value)) return options
      return [...options, { id: value, label: value, zh: value }]
    }

    /**
     * Copy text to the clipboard, falling back to the legacy selection path.
     *
     * `navigator.clipboard` is unavailable in insecure contexts and can be
     * denied by the user, and the panel must still copy in both cases.
     * @param text - the text to copy.
     * @returns whether the text reached the clipboard.
     */
    async function copyText(text) {
      try {
        if (typeof navigator?.clipboard?.writeText === 'function') {
          await navigator.clipboard.writeText(text)
          return true
        }
      } catch {
        // Fall through to the legacy path rather than lose the copy.
      }
      let area
      try {
        area = document.createElement('textarea')
        area.value = text
        area.setAttribute('readonly', '')
        area.style.position = 'fixed'
        area.style.top = '-1000px'
        area.style.opacity = '0'
        document.body.appendChild(area)
        area.select()
        area.setSelectionRange(0, text.length)
        return document.execCommand('copy')
      } catch {
        return false
      } finally {
        // execCommand may throw after the node was attached; never leak it into
        // the Host document, including when the legacy clipboard API fails.
        if (area?.parentNode) area.parentNode.removeChild(area)
      }
    }

    /**
     * The page's own stylesheet, rendered as an element so it unmounts.
     * @returns the style element.
     */
    function Styles() {
      return h('style', {
        'data-plugin': PLUGIN,
        dangerouslySetInnerHTML: { __html: CSS },
      })
    }

    /**
     * One labeled select with an explicit label/control pairing.
     * @param props - the field description.
     * @returns the labeled select.
     */
    function Field({ id, label, value, options, onChange, disabled, describedBy, renderOption }) {
      return h(
        'div',
        { className: 'dshTr-field' },
        h('label', { className: 'dshTr-fieldLabel', htmlFor: id }, label),
        h(
          'select',
          {
            id,
            className: 'dshTr-select',
            value,
            disabled,
            'aria-describedby': describedBy,
            onChange: (event) => {
              onChange(event.target.value)
            },
          },
          options.map((option) =>
            h('option', { key: option.id, value: option.id }, renderOption(option)),
          ),
        ),
      )
    }

    /**
     * The active locale id, kept live across language switches.
     * @returns the active locale id.
     */

    // Client source part: locale, Host, translation and glossary lifecycle hooks.
    function useActiveLocale() {
      const read = () => {
        try {
          return optionalService(ctx, 'locale')?.getLocale?.().active ?? 'en'
        } catch {
          return 'en'
        }
      }
      const [active, setActive] = React.useState(read)
      React.useEffect(() => {
        const locale = optionalService(ctx, 'locale')
        if (typeof locale?.subscribe !== 'function') return undefined
        return locale.subscribe(() => {
          setActive(read())
        })
      }, [])
      return active
    }

    // Multiple mounted panels belong to one workbench context. Keep their
    // preference snapshot in the shared factory closure so updates merge
    // against the latest value and every mounted panel sees the same choice.
    let sharedPreferencesSnapshot = null
    const preferenceSubscribers = new Set()
    let preferenceStorageListening = false

    function getSharedPreferences() {
      if (sharedPreferencesSnapshot === null) {
        sharedPreferencesSnapshot = normalizePreferences(readPreferences(), PROVIDER_CATALOG)
      }
      return sharedPreferencesSnapshot
    }

    function notifyPreferenceSubscribers(next) {
      for (const subscriber of [...preferenceSubscribers]) subscriber(next)
    }

    function handlePreferenceStorage(event) {
      if (event?.key !== STORAGE_KEY && event?.key !== null) return
      try {
        const storage = globalThis.localStorage
        if (event.storageArea != null && event.storageArea !== storage) return
      } catch {
        return
      }

      let saved = {}
      if (event.key === STORAGE_KEY && typeof event.newValue === 'string') {
        try {
          saved = JSON.parse(event.newValue)
        } catch {
          // Treat malformed external snapshots like an empty preference file.
        }
      }
      const next = normalizePreferences(saved, PROVIDER_CATALOG)
      sharedPreferencesSnapshot = next
      // Storage events are inbound notifications; never echo them back to
      // localStorage or another tab.
      notifyPreferenceSubscribers(next)
    }

    function subscribeSharedPreferences(subscriber) {
      preferenceSubscribers.add(subscriber)
      if (
        !preferenceStorageListening &&
        typeof globalThis.addEventListener === 'function'
      ) {
        globalThis.addEventListener('storage', handlePreferenceStorage)
        preferenceStorageListening = true
      }
      return () => {
        preferenceSubscribers.delete(subscriber)
        if (preferenceSubscribers.size === 0 && preferenceStorageListening) {
          globalThis.removeEventListener?.('storage', handlePreferenceStorage)
          preferenceStorageListening = false
        }
      }
    }

    function publishSharedPreferences(next) {
      sharedPreferencesSnapshot = next
      writePreferences(next)
      notifyPreferenceSubscribers(next)
    }

    /**
     * Own the user's language, provider and translation-format preferences.
     *
     * A factory-scoped snapshot prevents simultaneously mounted panels from
     * overwriting each other's newer fields with stale local snapshots.
     * @param providers - provider ids advertised by the current Host.
     * @returns preference values and stable setters.
     */
    function useTranslationPreferences({ providers }) {
      const [preferences, setPreferences] = React.useState(getSharedPreferences)

      const update = React.useCallback((key, value) => {
        const previous = getSharedPreferences()
        const nextValue = typeof value === 'function' ? value(previous[key]) : value
        if (Object.is(nextValue, previous[key])) return
        publishSharedPreferences({ ...previous, [key]: nextValue })
      }, [])
      const setSourceLanguage = React.useCallback(
        (value) => update('sourceLanguage', value),
        [update],
      )
      const setTargetLanguage = React.useCallback(
        (value) => update('targetLanguage', value),
        [update],
      )
      const setProvider = React.useCallback((value) => update('provider', value), [update])
      const setFormat = React.useCallback((value) => update('format', value), [update])

      React.useEffect(() => {
        const sync = (next) => setPreferences(next)
        const unsubscribe = subscribeSharedPreferences(sync)
        sync(getSharedPreferences())
        // Persist the normalized initial snapshot, but always read the
        // current shared value so a late mount cannot restore stale state.
        writePreferences(getSharedPreferences())
        return unsubscribe
      }, [])

      React.useEffect(() => {
        if (providers.length > 0 && !providers.includes(preferences.provider)) {
          setProvider(providers[0])
        }
      }, [providers, preferences.provider, setProvider])

      return {
        ...preferences,
        setSourceLanguage,
        setTargetLanguage,
        setProvider,
        setFormat,
      }
    }

    /**
     * Own the Host connection snapshot and its refresh lifecycle.
     *
     * A reconnect can change provider availability, limits and glossary
     * warnings. One sequence-guarded request is authoritative at a time, and
     * both the RPC and its retry delay are cancelled when the hook unmounts.
     * @param options - the glossary draft setter and its dirty-state ref.
     * @returns the current Host snapshot and a refresh callback.
     */
    function useHostConnection({ setGlossaryDraft, glossaryDraftDirtyRef }) {
      const [host, setHost] = React.useState({
        connected: false,
        offline: false,
        route: null,
        providers: [],
        languages: [],
        limit: null,
        providerHealth: {},
        failoverCapable: false,
        glossary: [],
        glossaryWarnings: [],
      })
      const describeSeq = React.useRef(0)
      const describeAbortRef = React.useRef(null)
      const mountedRef = React.useRef(true)
      const connectionSnapshotRef = React.useRef(undefined)

      const describeHost = React.useCallback(async () => {
        if (!mountedRef.current) return false
        const seq = ++describeSeq.current
        describeAbortRef.current?.abort()
        const controller = new AbortController()
        describeAbortRef.current = controller
        const isCurrent = () =>
          mountedRef.current && seq === describeSeq.current && !controller.signal.aborted
        try {
          for (let attempt = 0; attempt <= DESCRIBE_RETRY_DELAYS_MS.length; attempt += 1) {
            if (!isCurrent()) return false
            try {
              const value = await callHost(ctx, 'describe', {}, controller.signal)
              if (!isCurrent()) return false
              setHost({
                connected: true,
                offline: false,
                route: typeof value?.route === 'string' ? value.route : null,
                providers: Array.isArray(value?.providers) ? value.providers : [],
                languages: Array.isArray(value?.languages) ? value.languages : [],
                limit:
                  typeof value?.maxTextChars === 'number' && value.maxTextChars > 0
                    ? value.maxTextChars
                    : null,
                providerHealth: normalizeProviderHealth(value?.providerHealth),
                failoverCapable: value?.failover === true,
                glossary: normalizeGlossaryEntries(value?.glossary),
                glossaryWarnings: normalizeGlossaryWarnings(value?.glossaryWarnings),
              })
              if (!glossaryDraftDirtyRef.current) {
                setGlossaryDraft(glossaryJson(value?.glossary))
              }
              return true
            } catch {
              if (!isCurrent()) return false
              if (attempt < DESCRIBE_RETRY_DELAYS_MS.length) {
                const waited = await new Promise((resolve) => {
                  const signal = controller.signal
                  let timer
                  const onAbort = () => {
                    clearTimeout(timer)
                    signal.removeEventListener('abort', onAbort)
                    resolve(false)
                  }
                  timer = setTimeout(() => {
                    signal.removeEventListener('abort', onAbort)
                    resolve(true)
                  }, DESCRIBE_RETRY_DELAYS_MS[attempt])
                  signal.addEventListener('abort', onAbort, { once: true })
                  if (signal.aborted) onAbort()
                })
                if (!waited || !isCurrent()) return false
              }
            }
          }
          if (!isCurrent()) return false
          setHost((previous) => ({ ...previous, connected: false, offline: carrierUnreachable() }))
          return false
        } finally {
          if (describeAbortRef.current === controller) describeAbortRef.current = null
        }
      }, [])

      React.useEffect(() => {
        mountedRef.current = true
        return () => {
          mountedRef.current = false
          describeSeq.current += 1
          describeAbortRef.current?.abort()
          describeAbortRef.current = null
        }
      }, [])

      React.useEffect(() => {
        void describeHost()
      }, [describeHost])

      React.useEffect(() => {
        const state = optionalService(ctx, 'connection')?.state
        if (typeof state?.subscribe !== 'function') return undefined
        // Metadata notifications can arrive without a connection transition.
        // Only a real snapshot change should start or invalidate a Host read.
        connectionSnapshotRef.current = state.getSnapshot?.()
        return state.subscribe(() => {
          const snapshot = state.getSnapshot?.()
          if (Object.is(snapshot, connectionSnapshotRef.current)) return
          connectionSnapshotRef.current = snapshot

          if (snapshot === 'connected') {
            void describeHost()
            return
          }
          if (snapshot === 'disconnected' || snapshot === 'connecting') {
            describeSeq.current += 1
            describeAbortRef.current?.abort()
            describeAbortRef.current = null
            setHost((previous) => ({
              ...previous,
              connected: false,
              offline: snapshot === 'disconnected',
            }))
          }
        })
      }, [describeHost])

      return { host, setHost, describeHost, mountedRef }
    }

    /**
     * Own one translation request lifecycle, independent of the workbench view.
     *
     * Request generations prevent late carriers from publishing stale answers;
     * each active request also receives an AbortSignal and is cancelled on
     * source reset or component unmount.
     * @param options - Host refresh, lifecycle guard, locale and clipboard state.
     * @returns translation state and request actions.
     */
    function useTranslationRequest({ mountedRef, describeHost, t, setCopied }) {
      const [output, setOutput] = React.useState('')
      const [pending, setPending] = React.useState(false)
      const [error, setError] = React.useState(null)
      const [errorTitle, setErrorTitle] = React.useState(null)
      const [status, setStatus] = React.useState('idle')
      const [result, setResult] = React.useState(null)
      const requestSeq = React.useRef(0)
      const abortRef = React.useRef(null)
      const inflightTextRef = React.useRef(null)

      const reset = React.useCallback(() => {
        requestSeq.current += 1
        abortRef.current?.abort()
        abortRef.current = null
        inflightTextRef.current = null
        setOutput('')
        setPending(false)
        setError(null)
        setErrorTitle(null)
        setStatus('idle')
        setResult(null)
        setCopied(false)
      }, [])

      const run = React.useCallback(async ({ source, sourceLanguage, targetLanguage, provider, format }) => {
        if (!mountedRef.current) return
        if (source.trim().length === 0) {
          setError(t('error.empty'))
          setErrorTitle(null)
          setStatus('failed')
          return
        }
        // The ref is set synchronously before the first await, so two clicks in
        // the same event turn cannot cancel and restart the same demand.
        if (inflightTextRef.current === source) return

        requestSeq.current += 1
        const seq = requestSeq.current
        abortRef.current?.abort()
        const controller = new AbortController()
        abortRef.current = controller
        inflightTextRef.current = source
        setOutput('')
        setResult(null)
        setPending(true)
        setStatus('working')
        setError(null)
        setErrorTitle(null)
        setCopied(false)
        try {
          const value = await callHost(
            ctx,
            'translate',
            { text: source, sourceLanguage, targetLanguage, provider, format },
            controller.signal,
          )
          if (!mountedRef.current || seq !== requestSeq.current) return
          if (typeof value?.text !== 'string') {
            throw new HostError(
              'translation-pane/invalid-response',
              'translationPane: the Host returned a response without text',
            )
          }
          setOutput(value.text)
          setResult({
            cached: value?.cached === true,
            durationMs: typeof value?.durationMs === 'number' ? value.durationMs : null,
            detectedSourceLanguage:
              typeof value?.detectedSourceLanguage === 'string'
                ? value.detectedSourceLanguage
                : null,
            provider: typeof value?.provider === 'string' ? value.provider : null,
            requestedProvider:
              typeof value?.requestedProvider === 'string' ? value.requestedProvider : null,
            failover: value?.failover === true,
            providersServed: Array.isArray(value?.providersServed)
              ? value.providersServed.filter((entry) => typeof entry === 'string')
              : [],
          })
          setStatus('done')
          // A completed request may change the provider health shown beside
          // the controls, so refresh the Host snapshot after publishing it.
          if (typeof value?.provider === 'string' && value.provider !== 'none') {
            void describeHost()
          }
        } catch (failure) {
          if (!mountedRef.current || seq !== requestSeq.current) return
          if (controller.signal.aborted) {
            setStatus('cancelled')
            return
          }
          setError(messageFor(failure, t))
          setErrorTitle(diagnosticFor(failure))
          setStatus('failed')
        } finally {
          if (mountedRef.current && seq === requestSeq.current) {
            inflightTextRef.current = null
            abortRef.current = null
            setPending(false)
          }
        }
      }, [describeHost, mountedRef, t])

      const cancel = React.useCallback(() => {
        if (!mountedRef.current || abortRef.current === null) return
        requestSeq.current += 1
        abortRef.current.abort()
        abortRef.current = null
        inflightTextRef.current = null
        setPending(false)
        setStatus('cancelled')
        setError(null)
        setErrorTitle(null)
      }, [mountedRef])

      React.useEffect(() => () => {
        requestSeq.current += 1
        abortRef.current?.abort()
        abortRef.current = null
        inflightTextRef.current = null
      }, [])

      return {
        output,
        setOutput,
        pending,
        error,
        setError,
        errorTitle,
        setErrorTitle,
        status,
        setStatus,
        result,
        reset,
        run,
        cancel,
      }
    }

    /**
     * Own the glossary editor draft and its Host import/export actions.
     *
     * The Host remains authoritative: applying a draft validates it, reports
     * warnings and updates the active glossary before the editor is reset.
     * @param options - Host state, lifecycle guard and translation reset action.
     * @returns glossary editor state and event handlers.
     */
    function useGlossaryEditor(options) {
      const { host, setHost, mountedRef, resetTranslation, t } = options
      const [glossaryBusy, setGlossaryBusy] = React.useState(false)
      const [glossaryMessage, setGlossaryMessage] = React.useState(null)
      const [glossaryOpen, setGlossaryOpen] = React.useState(false)
      const { glossaryDraft, setGlossaryDraft, glossaryDraftDirtyRef } = options
      const applyAbortRef = React.useRef(null)
      const importSeqRef = React.useRef(0)

      // Applying a glossary is a Host mutation, so stop its transport work
      // when this editor leaves the page. The ref also closes the same-turn
      // double-click window before React can publish the busy state.
      React.useEffect(() => () => {
        applyAbortRef.current?.abort()
        applyAbortRef.current = null
        importSeqRef.current += 1
      }, [])

      const applyGlossary = React.useCallback(async () => {
        if (
          !mountedRef.current ||
          !host.connected ||
          glossaryBusy ||
          applyAbortRef.current !== null
        ) return
        const controller = new AbortController()
        applyAbortRef.current = controller
        setGlossaryBusy(true)
        setGlossaryMessage(null)
        try {
          const value = await callHost(
            ctx,
            'setGlossary',
            { payload: glossaryDraft },
            controller.signal,
          )
          if (!mountedRef.current || controller.signal.aborted) return
          const nextGlossary = normalizeGlossaryEntries(value?.glossary)
          const warnings = normalizeGlossaryWarnings(value?.warnings)
          glossaryDraftDirtyRef.current = false
          setGlossaryDraft(glossaryJson(nextGlossary))
          setHost((previous) => ({
            ...previous,
            glossary: nextGlossary,
            glossaryWarnings: warnings,
          }))
          resetTranslation()
          setGlossaryMessage(
            warnings.length > 0
              ? t('glossary.warningCount', { count: warnings.length })
              : t('glossary.applied', { count: nextGlossary.length }),
          )
        } catch (failure) {
          if (mountedRef.current && !controller.signal.aborted) {
            setGlossaryMessage(diagnosticFor(failure) || t('error.generic'))
          }
        } finally {
          if (applyAbortRef.current === controller) applyAbortRef.current = null
          if (mountedRef.current && !controller.signal.aborted) setGlossaryBusy(false)
        }
      }, [glossaryBusy, glossaryDraft, host.connected, mountedRef, resetTranslation, setHost, t])

      const exportGlossary = React.useCallback(async () => {
        if (!mountedRef.current) return
        const copied = await copyText(glossaryJson(host.glossary))
        if (!mountedRef.current) return
        setGlossaryMessage(copied ? t('glossary.exported') : t('error.copyFailed'))
      }, [host.glossary, mountedRef, t])

      const importGlossaryFile = React.useCallback(async (event) => {
        if (!mountedRef.current) return
        const seq = ++importSeqRef.current
        const file = event.target.files?.[0]
        if (!file) {
          event.target.value = ''
          return
        }
        event.target.value = ''
        if (file.size > 256 * 1024 || typeof file.text !== 'function') {
          if (seq === importSeqRef.current) setGlossaryMessage(t('glossary.invalidFile'))
          return
        }
        try {
          const contents = await file.text()
          if (!mountedRef.current || seq !== importSeqRef.current) return
          setGlossaryDraft(contents)
          glossaryDraftDirtyRef.current = true
          setGlossaryMessage(null)
        } catch {
          if (mountedRef.current && seq === importSeqRef.current) {
            setGlossaryMessage(t('glossary.invalidFile'))
          }
        }
      }, [mountedRef, t])

      return {
        glossaryDraft,
        setGlossaryDraft,
        glossaryBusy,
        glossaryMessage,
        setGlossaryMessage,
        glossaryOpen,
        setGlossaryOpen,
        glossaryDraftDirtyRef,
        applyGlossary,
        exportGlossary,
        importGlossaryFile,
      }
    }

    /**
     * Own language/provider option derivation and direction-switch behavior.
     * Host catalogs, localized labels, provider health and detected-language
     * semantics stay outside the workbench rendering component.
     * @param options - Host catalogs, current preferences and translation facts.
     * @returns picker options, provider messaging and the swap action.
     */
    function useLanguageControls(options) {
      const { languages, providers, sourceLanguage, targetLanguage, provider, providerHealth,
        failoverCapable, pending, error, result, source, output, setSource, setOutput,
        setSourceLanguage, setTargetLanguage, renderLanguage, t } = options
      const sourceOptions = React.useMemo(
        () => withValue(languageOptions(languages, true, LANGUAGE_CATALOG), sourceLanguage),
        [languages, sourceLanguage],
      )
      const targetOptions = React.useMemo(
        () => withValue(languageOptions(languages, false, LANGUAGE_CATALOG), targetLanguage),
        [languages, targetLanguage],
      )
      const serviceOptions = React.useMemo(
        () => withValue(providerOptions(providers, PROVIDER_CATALOG), provider),
        [provider, providers],
      )
      const providerLabel = React.useMemo(
        () => renderLanguage(serviceOptions.find((option) => option.id === provider) ?? {
          id: provider, label: provider, zh: provider,
        }),
        [provider, renderLanguage, serviceOptions],
      )
      const providerName = React.useCallback(
        (id) => renderLanguage(
          PROVIDER_CATALOG.find((entry) => entry.id === id) ?? { id, label: id, zh: id },
        ),
        [renderLanguage],
      )
      const detectedSource = result?.detectedSourceLanguage ?? null
      const { notice, servedLabel } = resolveProviderPresentation({
        pending, result, provider, providerHealth, failoverCapable, error, providerLabel, providerName, t,
      })
      const swapReason = React.useMemo(
        () => resolveLanguageSwapReason({ pending, sourceLanguage, targetLanguage, detectedSource }),
        [detectedSource, pending, sourceLanguage, targetLanguage],
      )
      const swap = React.useCallback(() => {
        if (swapReason !== null) return
        if (sourceLanguage === 'auto') {
          if (detectedSource === null) return
          setSourceLanguage(targetLanguage)
          setTargetLanguage(detectedSource)
        } else {
          setSourceLanguage(targetLanguage)
          setTargetLanguage(sourceLanguage)
        }
        if (output.length > 0) {
          setSource(output)
          setOutput(source)
        }
      }, [detectedSource, output, setOutput, setSource, setSourceLanguage, setTargetLanguage,
        source, sourceLanguage, swapReason, targetLanguage])

      return {
        sourceOptions, targetOptions, serviceOptions, providerLabel, providerName,
        detectedSource, notice, servedLabel, swapReason, swap,
      }
    }

    /**
     * Own the workbench's source/result actions and keyboard interaction.
     * Request execution remains in `useTranslationRequest`; this hook binds
     * the current editor/preferences to those request actions and owns the
     * transient clipboard confirmation lifecycle.
     * @param options - editor state, translation preferences and request actions.
     * @returns stable handlers consumed by the workbench and its views.
     */
    function useTranslationWorkbenchActions(options) {
      const {
        source, setSource, output, setOutput, pending,
        sourceLanguage, targetLanguage, provider, format,
        run, cancel, resetTranslation, mountedRef, t,
        setCopied, setError, setErrorTitle, setStatus,
      } = options
      const copiedTimerRef = React.useRef(null)

      React.useEffect(() => () => {
        if (copiedTimerRef.current !== null) {
          clearTimeout(copiedTimerRef.current)
          copiedTimerRef.current = null
        }
      }, [])

      const submitTranslation = React.useCallback(() => {
        void run({ source, sourceLanguage, targetLanguage, provider, format })
      }, [format, provider, run, source, sourceLanguage, targetLanguage])

      const copy = React.useCallback(async () => {
        if (output.length === 0) return
        const done = await copyText(output)
        if (!mountedRef.current) return
        if (!done) {
          setError(t('error.copyFailed'))
          setErrorTitle(null)
          setStatus('failed')
          return
        }
        setCopied(true)
        if (copiedTimerRef.current !== null) clearTimeout(copiedTimerRef.current)
        copiedTimerRef.current = setTimeout(() => {
          copiedTimerRef.current = null
          setCopied(false)
        }, COPIED_FEEDBACK_MS)
      }, [mountedRef, output, setCopied, setError, setErrorTitle, setStatus, t])

      const clear = React.useCallback(() => {
        setSource('')
        resetTranslation()
      }, [resetTranslation, setSource])

      const handleSourceChange = React.useCallback((event) => {
        if (pending) cancel()
        setSource(event.target.value)
        resetTranslation()
      }, [cancel, pending, resetTranslation, setSource])

      const handleSourceKeyDown = React.useCallback((event) => {
        if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') {
          event.preventDefault()
          submitTranslation()
          return
        }
        if (event.key === 'Escape' && pending) {
          event.preventDefault()
          event.stopPropagation()
          cancel()
        }
      }, [cancel, pending, submitTranslation])

      return { copy, clear, handleSourceChange, handleSourceKeyDown, submitTranslation }
    }

    // Client source part: reusable workbench controls, cards, status and metadata views.
    function ProviderStatusNotice({ notice }) {
      return notice === null ? null : h('p', { className: 'dshTr-notice', role: 'status' }, notice)
    }

    /**
     * Render the language, provider and format controls as a controlled view.
     * Direction changes stay owned by TranslationPane; this component only
     * renders the current values and forwards user actions.
     * @param props - current preferences, options and event callbacks.
     * @returns the workbench control group.
     */
    function TranslationControls(props) {
      const {
        ids,
        sourceLanguage,
        targetLanguage,
        provider,
        format,
        sourceOptions,
        targetOptions,
        serviceOptions,
        pending,
        setSourceLanguage,
        setTargetLanguage,
        setProvider,
        setFormat,
        renderLanguage,
        swapReason,
        swap,
        t,
      } = props
      const swapLabel = swapReason === null ? t('action.swap') : t(swapReason)

      return h(
        'div',
        { className: 'dshTr-controls' },
        h(Field, {
          id: ids.source,
          label: t('field.source'),
          value: sourceLanguage,
          options: sourceOptions,
          disabled: pending,
          onChange: setSourceLanguage,
          renderOption: renderLanguage,
        }),
        h(
          'button',
          {
            type: 'button',
            className: 'dshTr-swap',
            title: swapLabel,
            'aria-label': swapLabel,
            'aria-describedby': swapReason === null ? undefined : ids.note,
            // aria-disabled keeps the control focusable so keyboard users
            // can reach it and hear why it cannot act.
            'aria-disabled': swapReason === null ? undefined : 'true',
            onClick: () => {
              if (swapReason === null) swap()
            },
          },
          h(
            'svg',
            {
              className: 'dshTr-icon',
              width: 16,
              height: 16,
              viewBox: '0 0 16 16',
              fill: 'none',
              stroke: 'currentColor',
              strokeWidth: 1.4,
              strokeLinecap: 'round',
              strokeLinejoin: 'round',
              'aria-hidden': true,
            },
            h('path', { d: 'M2.5 5.5h9M9 3l2.5 2.5L9 8' }),
            h('path', { d: 'M13.5 10.5h-9M7 8l-2.5 2.5L7 13' }),
          ),
        ),
        h(Field, {
          id: ids.target,
          label: t('field.target'),
          value: targetLanguage,
          options: targetOptions,
          disabled: pending,
          onChange: setTargetLanguage,
          renderOption: renderLanguage,
        }),
        h(Field, {
          id: ids.service,
          label: t('field.service'),
          value: provider,
          options: serviceOptions,
          disabled: pending || serviceOptions.length <= 1,
          onChange: setProvider,
          renderOption: renderLanguage,
        }),
        h(Field, {
          id: ids.format,
          label: t('field.format'),
          value: format,
          options: [
            { id: 'text', label: t('format.text') },
            { id: 'json', label: t('format.json') },
            { id: 'markdown', label: t('format.markdown') },
          ],
          disabled: pending,
          onChange: setFormat,
          renderOption: (option) => option.label,
        }),
      )
    }

    /**
     * Render the editable source card without owning translation state.
     * @param props - source value, validity, labels and event callbacks.
     * @returns the source editor card.
     */
    function TranslationSourceCard(props) {
      const { ids, source, pending, overLimit, onClear, onChange, onKeyDown, t } = props
      return h(
        'div',
        { className: 'dshTr-card' },
        h(
          'div',
          { className: 'dshTr-cardHead' },
          h('span', { className: 'dshTr-cardTitle' }, t('label.source')),
          h(
            'div',
            { className: 'dshTr-cardTools' },
            h(
              'button',
              {
                type: 'button',
                className: 'dshTr-ghost',
                disabled: pending || source.length === 0,
                onClick: onClear,
              },
              t('action.clear'),
            ),
          ),
        ),
        h('textarea', {
          className: 'dshTr-area',
          value: source,
          placeholder: t('placeholder.source'),
          spellCheck: false,
          // The text may be RTL, so the editor follows its own content.
          dir: 'auto',
          'aria-label': t('label.source'),
          'aria-describedby': ids.counter,
          // Over-limit is a validity state, not just a red number: a
          // screen reader must hear that the text cannot be sent.
          'aria-invalid': overLimit ? 'true' : undefined,
          onChange,
          onKeyDown,
        }),
      )
    }

    /**
     * Render the result card and its deliberate empty/loading states.
     * @param props - result text, request state, clipboard feedback and labels.
     * @returns the accessible translation result card.
     */
    function TranslationResultCard(props) {
      const { output, pending, copied, onCopy, t } = props
      return h(
        'div',
        { className: 'dshTr-card' },
        h(
          'div',
          { className: 'dshTr-cardHead' },
          h('span', { className: 'dshTr-cardTitle' }, t('label.result')),
          h(
            'div',
            { className: 'dshTr-cardTools' },
            h(
              'button',
              {
                type: 'button',
                className: 'dshTr-ghost',
                disabled: output.length === 0,
                onClick: () => {
                  void onCopy()
                },
              },
              copied ? t('action.copied') : t('action.copy'),
            ),
          ),
        ),
        h(
          'div',
          {
            className: 'dshTr-out',
            'data-empty': output.length === 0 ? 'true' : 'false',
            // A region with a live role announces the new translation and
            // is not announced as an editable field.
            role: 'region',
            'aria-label': t('label.result'),
            'aria-live': 'polite',
            // Announce the finished translation as one sentence instead of
            // a stream of partial updates.
            'aria-atomic': 'true',
            'aria-busy': pending,
            // The translation may be in an RTL language.
            dir: 'auto',
            // A scrollable region must be reachable with the keyboard.
            tabIndex: 0,
          },
          pending
            ? h(
                'div',
                { className: 'dshTr-loading' },
                h('span', { className: 'dshTr-spinner', 'aria-hidden': true }),
                h('span', null, t('action.translating')),
              )
            : output.length > 0
              ? output
              : h(
                  'div',
                  { className: 'dshTr-empty' },
                  h(
                    'span',
                    { className: 'dshTr-emptyIcon', 'aria-hidden': true },
                    h(
                      'svg',
                      {
                        className: 'dshTr-icon',
                        width: 24,
                        height: 24,
                        viewBox: '0 0 24 24',
                        fill: 'none',
                        stroke: 'currentColor',
                        strokeWidth: 1.6,
                        strokeLinecap: 'round',
                        strokeLinejoin: 'round',
                      },
                      h('circle', { cx: 12, cy: 12, r: 8.5 }),
                      h('path', { d: 'M3.8 12h16.4' }),
                      h('path', { d: 'M12 3.5c2.1 2.3 3.1 5.1 3.1 8.5s-1 6.2-3.1 8.5' }),
                      h('path', { d: 'M12 3.5c-2.1 2.3-3.1 5.1-3.1 8.5s1 6.2 3.1 8.5' }),
                    ),
                  ),
                  h('strong', { className: 'dshTr-emptyTitle' }, t('empty.title')),
                  h('span', { className: 'dshTr-emptyDescription' }, t('empty.description')),
                ),
        ),
      )
    }

    /**
     * Render the translation action row and character-limit feedback.
     * @param props - request state, character counts, ids and action callbacks.
     * @returns the accessible workbench footer.
     */
    function TranslationFooter(props) {
      const {
        ids,
        canTranslate,
        pending,
        error,
        sourceLength,
        limit,
        overLimit,
        onTranslate,
        onCancel,
        t,
      } = props
      return h(
        'div',
        { className: 'dshTr-foot' },
        h(
          'button',
          {
            type: 'button',
            className: 'dshTr-button',
            disabled: !canTranslate,
            'aria-keyshortcuts': 'Control+Enter Meta+Enter',
            // The hint and live counter explain the action and its limit.
            'aria-describedby': `${ids.hint} ${ids.counter}`,
            onClick: onTranslate,
          },
          pending ? t('action.translating') : error !== null ? t('action.retry') : t('action.translate'),
        ),
        pending
          ? h(
              'button',
              {
                type: 'button',
                className: 'dshTr-button dshTr-buttonGhost',
                'aria-keyshortcuts': 'Escape',
                onClick: onCancel,
              },
              t('action.cancel'),
            )
          : null,
        h('span', { className: 'dshTr-hint', id: ids.hint }, t('hint.keyboard')),
        h(
          'span',
          {
            className: 'dshTr-counter',
            id: ids.counter,
            'data-over': overLimit ? 'true' : 'false',
          },
          limit === null
            ? t('meta.limitPending')
            : overLimit
              ? t('meta.over', { count: sourceLength - limit })
              : t('meta.count', { count: sourceLength, limit }),
        ),
      )
    }

    /**
     * Render service, route and result metadata for the completed request.
     * @param props - resolved labels and translation result details.
     * @returns the result metadata row.
     */
    function TranslationMetadata(props) {
      const { routeLabel, servedLabel, result, detectedSource, renderLanguage, t } = props
      const detectedLanguage = detectedSource === null
        ? null
        : renderLanguage(
            LANGUAGE_CATALOG.find((entry) => entry.id === detectedSource) ?? {
              id: detectedSource,
              label: detectedSource,
              zh: detectedSource,
            },
          )
      return h(
        'div',
        { className: 'dshTr-meta' },
        routeLabel !== null ? h('span', null, t('meta.route', { route: routeLabel })) : null,
        h('span', null, t('meta.provider', { provider: servedLabel })),
        result?.durationMs !== null && result?.durationMs !== undefined
          ? h('span', null, t('meta.duration', { ms: result.durationMs }))
          : null,
        result !== null
          ? h('span', null, result.cached ? t('meta.cached') : t('meta.fresh'))
          : null,
        detectedLanguage !== null
          ? h('span', null, t('meta.detectedSource', { language: detectedLanguage }))
          : null,
      )
    }

    /**
     * Render terminology editing, import/export actions and Host diagnostics.
     * The parent owns glossary state and Host operations; this view only
     * forwards disclosure, draft and action events.
     * @param props - glossary values, capabilities, callbacks and translator.
     * @returns the progressive glossary disclosure.
     */
    function GlossaryPanel(props) {
      const {
        id,
        open,
        onToggle,
        glossaryCount,
        draft,
        onDraftChange,
        busy,
        pending,
        connected,
        onApply,
        onExport,
        onImport,
        message,
        warnings,
        t,
      } = props
      return h(
        'section',
        { className: 'dshTr-glossary', 'aria-labelledby': id },
        h(
          'details',
          {
            className: 'dshTr-glossaryDetails',
            open,
            onToggle,
          },
          h(
            'summary',
            { className: 'dshTr-glossarySummary' },
            h(
              'span',
              { className: 'dshTr-glossaryHead' },
              h(
                'span',
                { className: 'dshTr-glossaryTitle', id, role: 'heading', 'aria-level': 3 },
                t('glossary.title'),
              ),
              h('span', { className: 'dshTr-glossaryCount' }, String(glossaryCount)),
            ),
          ),
          h('p', { className: 'dshTr-note' }, t('glossary.note')),
          h('textarea', {
            className: 'dshTr-glossaryArea',
            value: draft,
            placeholder: t('glossary.placeholder'),
            spellCheck: false,
            'aria-label': t('glossary.title'),
            onChange: onDraftChange,
          }),
          h(
            'div',
            { className: 'dshTr-glossaryActions' },
            h(
              'button',
              {
                type: 'button',
                className: 'dshTr-button',
                disabled: !connected || busy || pending || !draft.trim(),
                onClick: onApply,
              },
              busy ? t('action.translating') : t('glossary.apply'),
            ),
            h(
              'button',
              {
                type: 'button',
                className: 'dshTr-button dshTr-buttonGhost',
                disabled: glossaryCount === 0,
                onClick: onExport,
              },
              t('glossary.export'),
            ),
            h(
              'label',
              { className: 'dshTr-import' },
              t('glossary.import'),
              h('input', {
                type: 'file',
                accept: '.json,application/json',
                onChange: onImport,
              }),
            ),
          ),
          message !== null
            ? h('p', { className: 'dshTr-glossaryMessage', role: 'status' }, message)
            : null,
          warnings.length > 0
            ? h(
                'ul',
                { className: 'dshTr-glossaryWarnings', role: 'status' },
                ...warnings.map((warning, index) =>
                  h('li', { key: warning.code + '-' + index },
                    t('glossary.warning.' + warning.code),
                  ),
                ),
              )
            : null,
        ),
      )
    }

    /**
     * Render the workbench heading and its compact, accessible status pill.
     * @param props - resolved state and the active translator.
     * @returns the page header.
     */
    function TranslationHeader({ state, stateLabel, t }) {
      return h(
        'div',
        { className: 'dshTr-head' },
        h(
          'div',
          null,
          h('h2', { className: 'dshTr-title' }, t('page.title')),
          h('p', { className: 'dshTr-subtitle' }, t('page.subtitle')),
        ),
        h(
          'span',
          { className: 'dshTr-status', 'data-state': state },
          h('span', { className: 'dshTr-statusDot', 'aria-hidden': true }),
          stateLabel,
        ),
      )
    }

    /**
     * Render the full-sentence error/offline feedback separately from the pill.
     * @param props - user-facing message and optional diagnostic title.
     * @returns an alert region, or nothing when no alert is active.
     */
    function TranslationAlert({ message, title }) {
      return message === null
        ? null
        : h('div', { className: 'dshTr-error', role: 'alert', title: title ?? undefined }, message)
    }

    /**
     * Render the contextual notes that explain current format and language
     * choices, alongside provider health/failover feedback.
     * @param props - format mode, provider notice, swap guidance and ids.
     * @returns the applicable workbench notices.
     */
    function TranslationNotices({ format, notice, swapReason, noteId, t }) {
      const formatNote = format === 'json'
        ? t('note.json')
        : format === 'markdown'
          ? t('note.markdown')
          : null
      return h(
        React.Fragment,
        null,
        formatNote !== null ? h('p', { className: 'dshTr-note', role: 'note' }, formatNote) : null,
        h(ProviderStatusNotice, { notice }),
        swapReason === null
          ? null
          : h('p', { className: 'dshTr-note', id: noteId }, t(swapReason)),
      )
    }

    /**
     * The translation workbench.
     * @param props - the slot props, carrying the bound translator.
     * @returns the workbench element.
     */

    // Client source part: workbench composition, responsive page and plugin registration.
    function TranslationPane(props) {
      // The slot renderer injects `t` from the registered locale namespace; a
      // missing injection would otherwise render every label blank.
      const t = typeof props.t === 'function' ? props.t : boundTranslate()
      const narrow = props.narrow === true
      const active = useActiveLocale()
      /**
       * Name one option in the language the user is reading.
       *
       * The fallback chain matters: an option without a name in the active
       * locale must still render something, because a blank option makes the
       * select unreadable and the user cannot tell which service is chosen.
       * @param option - the catalog entry to name.
       * @returns the display name for the active locale.
       */
      const renderLanguage = React.useCallback(
        (option) => {
          if (option === null || option === undefined) return ''
          if (active.startsWith('zh')) return option.zh ?? option.label ?? option.id
          return option.label ?? option.zh ?? option.id
        },
        [active],
      )

      const [ids] = React.useState(() => {
        instanceCount += 1
        const base = `dshTr-${instanceCount}`
        return {
          source: `${base}-source`,
          target: `${base}-target`,
          service: `${base}-service`,
          format: `${base}-format`,
          counter: `${base}-counter`,
          hint: `${base}-hint`,
          note: `${base}-note`,
          glossary: `${base}-glossary`,
        }
      })

      const [source, setSource] = React.useState('')
      const [copied, setCopied] = React.useState(false)
      const glossaryDraftDirtyRef = React.useRef(false)
      const [glossaryDraft, setGlossaryDraft] = React.useState('')
      const { host, setHost, describeHost, mountedRef } = useHostConnection({
        setGlossaryDraft,
        glossaryDraftDirtyRef,
      })
      const {
        sourceLanguage,
        targetLanguage,
        provider,
        format,
        setSourceLanguage,
        setTargetLanguage,
        setProvider,
        setFormat,
      } = useTranslationPreferences({ providers: host.providers })
      const {
        output,
        setOutput,
        pending,
        error,
        setError,
        errorTitle,
        setErrorTitle,
        status,
        setStatus,
        result,
        reset: resetTranslation,
        run,
        cancel,
      } = useTranslationRequest({ mountedRef, describeHost, t, setCopied })
      const {
        glossaryBusy,
        glossaryMessage,
        setGlossaryMessage,
        glossaryOpen,
        setGlossaryOpen,
        applyGlossary,
        exportGlossary,
        importGlossaryFile,
      } = useGlossaryEditor({
        host,
        setHost,
        mountedRef,
        resetTranslation,
        t,
        glossaryDraft,
        setGlossaryDraft,
        glossaryDraftDirtyRef,
      })

      // Keep Host-reported glossary problems visible without requiring the
      // user to discover the advanced section manually.
      React.useEffect(() => {
        if (host.glossaryWarnings.length > 0) setGlossaryOpen(true)
      }, [host.glossaryWarnings.length])

      const {
        sourceOptions, targetOptions, serviceOptions, providerLabel, providerName,
        detectedSource, notice, servedLabel, swapReason, swap,
      } = useLanguageControls({
        languages: host.languages,
        providers: host.providers,
        sourceLanguage,
        targetLanguage,
        provider,
        providerHealth: host.providerHealth,
        failoverCapable: host.failoverCapable,
        pending,
        error,
        result,
        source,
        output,
        setSource,
        setOutput,
        setSourceLanguage,
        setTargetLanguage,
        renderLanguage,
        t,
      })

      const overLimit = host.limit !== null && source.length > host.limit
      const canTranslate = source.trim().length > 0 && !pending && !overLimit

      const {
        copy,
        clear,
        handleSourceChange,
        handleSourceKeyDown,
        submitTranslation,
      } = useTranslationWorkbenchActions({
        source,
        setSource,
        output,
        setOutput,
        pending,
        sourceLanguage,
        targetLanguage,
        provider,
        format,
        run,
        cancel,
        resetTranslation,
        mountedRef,
        t,
        setCopied,
        setError,
        setErrorTitle,
        setStatus,
      })

      const handleGlossaryToggle = React.useCallback((event) => {
        setGlossaryOpen(event.currentTarget.open)
      }, [setGlossaryOpen])

      const handleGlossaryDraftChange = React.useCallback((event) => {
        glossaryDraftDirtyRef.current = true
        setGlossaryDraft(event.target.value)
        setGlossaryMessage(null)
      }, [setGlossaryDraft, setGlossaryMessage])

      const { alertMessage, state, stateLabel } = resolveWorkbenchStatus({
        error,
        offline: host.offline,
        pending,
        overLimit,
        status,
        connected: host.connected,
        t,
      })

      const routeLabel = (() => {
        if (host.route === null) return null
        if (host.route === 'translator') return t('route.translator')
        if (host.route === 'direct') return t('route.direct')
        return host.route
      })()

      return h(
        'div',
        { className: 'dshTr' },
        h(Styles, null),
        h(TranslationHeader, { state, stateLabel, t }),
        h(TranslationControls, {
          ids,
          sourceLanguage,
          targetLanguage,
          provider,
          format,
          sourceOptions,
          targetOptions,
          serviceOptions,
          pending,
          setSourceLanguage,
          setTargetLanguage,
          setProvider,
          setFormat,
          renderLanguage,
          swapReason,
          swap,
          t,
        }),
        h(TranslationNotices, { format, notice, swapReason, noteId: ids.note, t }),
        h(
          'div',
          { className: 'dshTr-grid', 'data-stacked': narrow ? 'true' : 'false' },
          h(TranslationSourceCard, {
            ids,
            source,
            pending,
            overLimit,
            onClear: clear,
            onChange: handleSourceChange,
            onKeyDown: handleSourceKeyDown,
            t,
          }),
          h(TranslationResultCard, {
            output,
            pending,
            copied,
            onCopy: copy,
            t,
          }),
        ),
        h(TranslationAlert, { message: alertMessage, title: errorTitle }),
        h(TranslationFooter, {
          ids,
          canTranslate,
          pending,
          error,
          sourceLength: source.length,
          limit: host.limit,
          overLimit,
          onTranslate: submitTranslation,
          onCancel: cancel,
          t,
        }),
        h(TranslationMetadata, {
          routeLabel,
          servedLabel,
          result,
          detectedSource,
          renderLanguage,
          t,
        }),
        h(GlossaryPanel, {
          id: ids.glossary,
          open: glossaryOpen,
          onToggle: handleGlossaryToggle,
          glossaryCount: host.glossary.length,
          draft: glossaryDraft,
          onDraftChange: handleGlossaryDraftChange,
          busy: glossaryBusy,
          pending,
          connected: host.connected,
          onApply: () => { void applyGlossary() },
          onExport: () => { void exportGlossary() },
          onImport: (event) => { void importGlossaryFile(event) },
          message: glossaryMessage,
          warnings: host.glossaryWarnings,
          t,
        }),

      )
    }

    // The component reads the client context at call time; the slot renderer
    // supplies `t` from the registered locale namespace.
    let ctx

    /**
     * The `main`-slot page. It measures its own container so the workbench
     * stacks on a narrow column instead of squeezing two text cards.
     *
     * The shell's centre column is a flex column with `overflow:hidden`, and
     * slot anchors use `display:contents`, so this page is the only scroll
     * container between the workbench and the window: it must own a full
     * height and `overflow-y:auto` or content taller than the column is
     * clipped with no way to scroll (`dshTr-page`).
     * @param props - the slot props, carrying the bound translator.
     * @returns the page element.
     */
    function TranslationPanePage(props) {
      const hostRef = React.useRef(null)
      const [narrow, setNarrow] = React.useState(false)
      React.useEffect(() => {
        const element = hostRef.current
        if (element === null || typeof ResizeObserver !== 'function') return undefined
        const observer = new ResizeObserver((records) => {
          const width = records[0]?.contentRect?.width ?? element.clientWidth
          setNarrow(width > 0 && width < 720)
        })
        observer.observe(element)
        return () => {
          observer.disconnect()
        }
      }, [])
      return h(
        'div',
        { ref: hostRef, className: 'dshTr-page' },
        h(TranslationPane, { ...props, narrow }),
      )
    }

    /**
     * Sidebar icon: a speech bubble with a globe, sized by the owner.
     * @param props - the icon size and whether it is the active panel.
     * @returns the icon element.
     */
    function TranslationIcon({ size = 20, active = false }) {
      return h(
        'svg',
        {
          className: 'dshTr-icon',
          width: size,
          height: size,
          viewBox: '0 0 16 16',
          fill: 'none',
          stroke: 'currentColor',
          strokeWidth: active ? 1.6 : 1.4,
          strokeLinecap: 'round',
          strokeLinejoin: 'round',
          'aria-hidden': true,
          focusable: false,
        },
        h('path', { d: 'M2.5 3.2h6.2v4.3H6L4.2 9.2V7.5H2.5z' }),
        h('circle', { cx: 11, cy: 10.4, r: 3 }),
        h('path', { d: 'M8.2 10.4h5.6' }),
        h('path', { d: 'M11 7.4c.9 1.8.9 4.2 0 6' }),
        h('path', { d: 'M11 7.4c-.9 1.8-.9 4.2 0 6' }),
      )
    }

    return {
      inject: ['slots', 'locale'],
      apply(clientCtx) {
        ctx = clientCtx

        clientCtx.effect(
          () => clientCtx.locale.register(NS, { zh: ZH, en: EN }),
          'dsh-translation-pane: dictionaries',
        )

        // Sidebar entry: the icon owns its own list id, and the `main` panel
        // below answers that same id.
        clientCtx.slots.inject('sidebar.panellist', () =>
          clientCtx.slots.register(
            {
              name: 'sidebar.panellist',
              id: PANEL_ID,
              order: 20,
              label: () => clientCtx.locale.bind(NS)('panel.title'),
              locale: NS,
            },
            TranslationIcon,
          ),
        )

        // Full-width workbench in the main column.
        clientCtx.slots.inject('main', () =>
          clientCtx.slots.register(
            {
              name: 'main',
              key: PANEL_ID,
              locale: NS,
            },
            TranslationPanePage,
          ),
        )
      },
    }

  },
})
