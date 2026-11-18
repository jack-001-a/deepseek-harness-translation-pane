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
      'field.source': 'Source',
      'field.target': 'Target',
      'field.service': 'Service',
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
      'hint.keyboard': 'Ctrl+Enter translates.',
      'notice.providerDown':
        'The {provider} service is unavailable right now; translations will automatically use the other service.',
      'notice.failover': 'The {requested} service could not answer, so the Host translated with {served}.',
      'notice.mixed': 'More than one service answered this text ({providers}).',
      'route.translator': 'Translation service',
      'route.direct': 'Direct endpoint',
    }

    /**
     * The Simplified Chinese UI dictionary; the key set mirrors {@link EN}.
     */
    const ZH = {
      'panel.title': '翻译',
      'page.title': '翻译',
      'page.subtitle': '不离开 Harness 就能翻译文本。',
      'field.source': '源语言',
      'field.target': '目标语言',
      'field.service': '翻译服务',
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
      'error.providerError': '翻译服务处理失败，请重试或更换服务。',
      'error.invalidResponse': '翻译服务返回了无法解析的内容，请重试。',
      'error.offline': 'Harness 无法连接到 Host，请确认 Host 正在运行后重试。',
      'error.providerUnreachable': 'Host 无法连接翻译服务，请重试或更换服务。',
      'error.copyFailed': '译文无法复制到剪贴板。',
      'swap.auto': '源语言为“自动检测”时无法交换，请先选择具体的源语言。',
      'swap.same': '源语言与目标语言相同，无需交换。',
      'swap.unknown': '尚未识别出源语言，暂时无法交换语言；先翻译一次即可交换。',
      'swap.pending': '已有翻译正在进行，请先取消再交换语言。',
      'hint.keyboard': 'Ctrl+Enter 直接翻译。',
      'notice.providerDown': '当前 {provider} 服务不可用，翻译将自动改用另一项服务。',
      'notice.failover': '{requested} 服务未能完成翻译，Host 已改用 {served} 完成。',
      'notice.mixed': '这篇文本由多项服务共同完成（{providers}）。',
      'route.translator': '翻译服务',
      'route.direct': '直连端点',
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
.dshTr-placeholder { color: var(--dsw-alias-label-secondary); }
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
.dshTr-icon { display: block; }
@container (max-width: 640px) { .dshTr { padding: 16px; } }
`

    /** One Host failure, carrying the stable code the Host raised. */
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
        return parsed !== null && typeof parsed === 'object' ? parsed : {}
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
     * Build the option list of one language select.
     * @param ids - the language ids the Host advertises, possibly empty.
     * @param includeAuto - whether the "Auto detect" entry is offered.
     * @returns the option list, keeping the built-in display names.
     */
    function languageOptions(ids, includeAuto) {
      const known = new Map(LANGUAGE_CATALOG.map((entry) => [entry.id, entry]))
      const source = ids.length > 0 ? ids : LANGUAGE_CATALOG.map((entry) => entry.id)
      const options = []
      for (const id of source) {
        if (id === 'auto' && !includeAuto) continue
        options.push(known.get(id) ?? { id, label: id, zh: id })
      }
      // The source select always offers auto-detection, even when the Host
      // catalog does not list it.
      if (includeAuto && !options.some((entry) => entry.id === 'auto')) {
        options.unshift(known.get('auto'))
      }
      return options
    }

    /**
     * Build the option list of the service select.
     * @param ids - the provider ids the active route can serve, possibly empty.
     * @returns the option list, keeping the built-in display names.
     */
    function providerOptions(ids) {
      if (ids.length === 0) return PROVIDER_CATALOG.slice(0, 1)
      const known = new Map(PROVIDER_CATALOG.map((entry) => [entry.id, entry]))
      return ids.map((id) => known.get(id) ?? { id, label: id, zh: id })
    }

    /**
     * Read the Host's observed provider health, tolerating an older Host.
     *
     * The Host sends plain serializable data keyed by provider id, for
     * example `{ google: { unreachable: true, until: '…' } }`. An older Host
     * omits the key entirely, and the panel simply has no health notice.
     * @param value - the Host's `providerHealth` field, possibly absent.
     * @returns the health facts the panel can render, keyed by provider id.
     */
    function readProviderHealth(value) {
      if (value === null || typeof value !== 'object' || Array.isArray(value)) return {}
      const health = {}
      for (const [provider, entry] of Object.entries(value)) {
        if (entry === null || typeof entry !== 'object' || typeof entry.unreachable !== 'boolean') continue
        health[provider] = {
          unreachable: entry.unreachable,
          reason: typeof entry.reason === 'string' ? entry.reason : '',
        }
      }
      return health
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
      try {
        const area = document.createElement('textarea')
        area.value = text
        area.setAttribute('readonly', '')
        area.style.position = 'fixed'
        area.style.top = '-1000px'
        area.style.opacity = '0'
        document.body.appendChild(area)
        area.select()
        area.setSelectionRange(0, text.length)
        const copied = document.execCommand('copy')
        document.body.removeChild(area)
        return copied
      } catch {
        return false
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

    /**
     * The translation workbench.
     * @param props - the slot props, carrying the bound translator.
     * @returns the workbench element.
     */
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
          counter: `${base}-counter`,
          hint: `${base}-hint`,
          note: `${base}-note`,
        }
      })

      const [sourceLanguage, setSourceLanguage] = React.useState(
        () => readPreferences().sourceLanguage ?? 'auto',
      )
      const [targetLanguage, setTargetLanguage] = React.useState(
        () => readPreferences().targetLanguage ?? 'zh-Hans',
      )
      const [provider, setProvider] = React.useState(() => {
        const saved = readPreferences().provider
        return PROVIDER_CATALOG.some((entry) => entry.id === saved) ? saved : 'bing'
      })
      const [source, setSource] = React.useState('')
      const [output, setOutput] = React.useState('')
      const [pending, setPending] = React.useState(false)
      const [error, setError] = React.useState(null)
      const [errorTitle, setErrorTitle] = React.useState(null)
      const [copied, setCopied] = React.useState(false)
      const [status, setStatus] = React.useState('idle')
      const [result, setResult] = React.useState(null)
      const [host, setHost] = React.useState({
        connected: false,
        offline: false,
        route: null,
        providers: [],
        languages: [],
        limit: null,
        // Plain Host data keyed by provider id; empty until `describe()` says
        // otherwise, and empty on an older Host that does not report it.
        providerHealth: {},
        failoverCapable: false,
      })

      // The request sequence is the reliable guard against a stale answer:
      // the carrier may not be able to cancel a request that already reached
      // the Host, so every response is checked against the latest sequence.
      const requestSeq = React.useRef(0)
      const abortRef = React.useRef(null)
      const inflightTextRef = React.useRef(null)
      const copiedTimerRef = React.useRef(null)
      // `describe()` retries on a timer; a closed panel must not be redrawn
      // when a late attempt settles.
      const mountedRef = React.useRef(true)

      /**
       * Read the Host's routing facts, limits and catalog.
       *
       * The panel can paint before the Host carrier is ready, so the call is
       * retried a few times instead of leaving the panel stuck on "Connecting".
       * @returns whether the Host answered.
       */
      const describeHost = React.useCallback(async () => {
        for (let attempt = 0; attempt <= DESCRIBE_RETRY_DELAYS_MS.length; attempt += 1) {
          if (!mountedRef.current) return false
          try {
            const value = await callHost(ctx, 'describe', {})
            if (!mountedRef.current) return false
            setHost({
              connected: true,
              offline: false,
              route: typeof value?.route === 'string' ? value.route : null,
              providers: Array.isArray(value?.providers) ? value.providers : [],
              languages: Array.isArray(value?.languages) ? value.languages : [],
              // The limit is the Host's own number; until it arrives the panel
              // must not claim a limit of its own.
              limit:
                typeof value?.maxTextChars === 'number' && value.maxTextChars > 0
                  ? value.maxTextChars
                  : null,
              // Absent on an older Host, which simply means no health notice.
              providerHealth: readProviderHealth(value?.providerHealth),
              // Whether the Host can actually fall over to another provider;
              // a health warning is only honest when it can.
              failoverCapable: value?.failover === true,
            })
            return true
          } catch {
            if (attempt < DESCRIBE_RETRY_DELAYS_MS.length) {
              await new Promise((resolve) => setTimeout(resolve, DESCRIBE_RETRY_DELAYS_MS[attempt]))
            }
          }
        }
        if (!mountedRef.current) return false
        // The retries are over: say plainly that the Host is out of reach
        // rather than waiting on "Connecting" forever.
        setHost((previous) => ({ ...previous, connected: false, offline: carrierUnreachable() }))
        return false
      }, [])

      React.useEffect(() => {
        void describeHost()
      }, [describeHost])

      // Re-read the Host facts after a reconnect: the limit, the providers and
      // the catalog may all have changed while the panel was offline.
      React.useEffect(() => {
        const state = optionalService(ctx, 'connection')?.state
        if (typeof state?.subscribe !== 'function') return undefined
        return state.subscribe(() => {
          const snapshot = state.getSnapshot?.()
          if (snapshot === 'connected') {
            void describeHost()
            return
          }
          if (snapshot === 'disconnected') {
            // The carrier dropped: say so at once instead of waiting for the
            // next request to fail.
            setHost((previous) => ({ ...previous, connected: false, offline: true }))
          }
        })
      }, [describeHost])

      // Keep the Service selector on a provider this Host actually offers.
      React.useEffect(() => {
        if (host.providers.length > 0 && !host.providers.includes(provider)) {
          setProvider(host.providers[0])
        }
      }, [host.providers, provider])

      React.useEffect(() => {
        writePreferences({ sourceLanguage, targetLanguage, provider })
      }, [sourceLanguage, targetLanguage, provider])

      React.useEffect(
        () => () => {
          // Abandon any in-flight request and clear the copy timer, so a
          // closed panel never keeps a timer alive and never redraws.
          mountedRef.current = false
          requestSeq.current += 1
          abortRef.current?.abort()
          abortRef.current = null
          if (copiedTimerRef.current !== null) {
            clearTimeout(copiedTimerRef.current)
            copiedTimerRef.current = null
          }
        },
        [],
      )

      const sourceOptions = React.useMemo(
        () => withValue(languageOptions(host.languages, true), sourceLanguage),
        [host.languages, sourceLanguage],
      )
      const targetOptions = React.useMemo(
        () => withValue(languageOptions(host.languages, false), targetLanguage),
        [host.languages, targetLanguage],
      )
      const serviceOptions = React.useMemo(
        () => withValue(providerOptions(host.providers), provider),
        [host.providers, provider],
      )
      // The service name as the select shows it, so the meta line and the
      // select never disagree about which service is active.
      const providerLabel = React.useMemo(
        () =>
          renderLanguage(
            serviceOptions.find((option) => option.id === provider) ?? {
              id: provider,
              label: provider,
              zh: provider,
            },
          ),
        [provider, renderLanguage, serviceOptions],
      )

      /**
       * Name one service id in the language the user is reading.
       * @param id - the provider id.
       * @returns the display name for the active locale.
       */
      const providerName = React.useCallback(
        (id) =>
          renderLanguage(
            PROVIDER_CATALOG.find((entry) => entry.id === id) ?? { id, label: id, zh: id },
          ),
        [renderLanguage],
      )

      const detectedSource = result?.detectedSourceLanguage ?? null
      const overLimit = host.limit !== null && source.length > host.limit
      const canTranslate = source.trim().length > 0 && !pending && !overLimit

      // The Host may already know the selected service is unreachable, either
      // from `describe()` or from the request that just failed over. Say so
      // before the user sends text into a service that cannot answer.
      const degradedProvider = host.providerHealth[provider]?.unreachable === true
      // One long demand can be split across both providers. The single-service
      // failover copy would then name the same service twice, so a mixed answer
      // gets its own sentence instead.
      const mixedServed =
        !pending && Array.isArray(result?.providersServed) && result.providersServed.length > 1
          ? result.providersServed
          : null
      const mixedNotice =
        mixedServed === null
          ? null
          : t('notice.mixed', { providers: mixedServed.map(providerName).join(' + ') })
      const failoverNotice =
        mixedServed === null &&
        !pending &&
        result?.failover === true &&
        typeof result.requestedProvider === 'string' &&
        typeof result.provider === 'string' &&
        (result.requestedProvider === provider || result.provider === provider)
          ? t('notice.failover', {
              requested: providerName(result.requestedProvider),
              served: providerName(result.provider),
            })
          : null
      // The warning promises an automatic switch, so it is only shown when the
      // Host can actually make one, and a live failure explains itself better.
      const healthNotice = degradedProvider && host.failoverCapable && error === null
        ? t('notice.providerDown', { provider: providerName(provider) })
        : null
      const notice = mixedNotice ?? failoverNotice ?? healthNotice
      // The meta line names every service that answered, not just the first.
      const servedLabel =
        mixedServed === null ? providerLabel : mixedServed.map(providerName).join(' + ')

      /**
       * Explain why the swap cannot act, when it cannot.
       * @returns the dictionary key for the reason, or null when swapping works.
       */
      const swapReason = React.useMemo(() => {
        if (pending) return 'swap.pending'
        if (sourceLanguage === 'auto') {
          // Reversing an auto-detected source needs the detected language.
          return detectedSource === null ? 'swap.auto' : null
        }
        if (sourceLanguage === targetLanguage) return 'swap.same'
        return null
      }, [detectedSource, pending, sourceLanguage, targetLanguage])

      /**
       * Send the current text to the Host and publish the answer.
       * @returns nothing; the result lands in the component state.
       */
      const run = React.useCallback(async () => {
        if (source.trim().length === 0) {
          setError(t('error.empty'))
          setErrorTitle(null)
          setStatus('failed')
          return
        }
        if (pending && inflightTextRef.current === source) {
          // The very same text is already in flight; restarting it would abort
          // a healthy request for nothing.
          return
        }
        // Supersede whatever is running. The sequence is bumped before the
        // abort, so the abandoned request is already stale when its promise
        // rejects; the signal then tears the HTTP call down.
        requestSeq.current += 1
        const seq = requestSeq.current
        abortRef.current?.abort()
        const controller = new AbortController()
        abortRef.current = controller
        inflightTextRef.current = source
        setPending(true)
        setStatus('working')
        setError(null)
        setErrorTitle(null)
        setCopied(false)
        try {
          const value = await callHost(
            ctx,
            'translate',
            {
              text: source,
              sourceLanguage,
              targetLanguage,
              provider,
            },
            controller.signal,
          )
          if (seq !== requestSeq.current) return
          setOutput(typeof value?.text === 'string' ? value.text : '')
          setResult({
            cached: value?.cached === true,
            durationMs: typeof value?.durationMs === 'number' ? value.durationMs : null,
            detectedSourceLanguage:
              typeof value?.detectedSourceLanguage === 'string'
                ? value.detectedSourceLanguage
                : null,
            // The served service and the fallback facts, when the Host reports
            // them; an older Host leaves them null and the panel stays quiet.
            provider: typeof value?.provider === 'string' ? value.provider : null,
            requestedProvider:
              typeof value?.requestedProvider === 'string' ? value.requestedProvider : null,
            failover: value?.failover === true,
            // Present only when one long demand was split across providers.
            providersServed: Array.isArray(value?.providersServed)
              ? value.providersServed.filter((entry) => typeof entry === 'string')
              : [],
          })
          setStatus('done')
          // Refresh the Host's view so the notice and the health facts agree:
          // a failover proves the selected service is unhealthy, and a
          // successful answer can prove one has recovered.
          if (typeof value?.provider === 'string' && value.provider !== 'none') {
            void describeHost()
          }
        } catch (failure) {
          if (seq !== requestSeq.current) return
          if (controller.signal.aborted) {
            setStatus('cancelled')
            return
          }
          setError(messageFor(failure, t))
          setErrorTitle(diagnosticFor(failure))
          setStatus('failed')
        } finally {
          // Only the newest request owns the pending state.
          if (seq === requestSeq.current) {
            inflightTextRef.current = null
            setPending(false)
          }
        }
      }, [describeHost, pending, provider, source, sourceLanguage, t, targetLanguage])

      /**
       * Abandon the running request and leave the panel in a clean state.
       * @returns nothing.
       */
      const cancel = React.useCallback(() => {
        if (!pending) return
        // Bump the sequence first: the abandoned answer must be ignored even
        // when the carrier answers it anyway.
        requestSeq.current += 1
        abortRef.current?.abort()
        abortRef.current = null
        inflightTextRef.current = null
        setPending(false)
        setStatus('cancelled')
        setError(null)
        setErrorTitle(null)
      }, [pending])

      /**
       * Reverse the translation direction.
       * @returns nothing.
       */
      const swap = React.useCallback(() => {
        if (swapReason !== null) return
        if (sourceLanguage === 'auto') {
          // Reverse the direction: the old target becomes the source, and the
          // detected source becomes the new target.
          if (detectedSource === null) return
          setSourceLanguage(targetLanguage)
          setTargetLanguage(detectedSource)
        } else {
          setSourceLanguage(targetLanguage)
          setTargetLanguage(sourceLanguage)
        }
        // Move the translation back into the source box so the reverse
        // direction can be translated straight away; the previous source
        // stays visible in the result box.
        if (output.length > 0) {
          setSource(output)
          setOutput(source)
        }
      }, [detectedSource, output, source, sourceLanguage, swapReason, targetLanguage])

      /**
       * Copy the translation to the clipboard.
       * @returns nothing; the outcome lands in the component state.
       */
      const copy = React.useCallback(async () => {
        if (output.length === 0) return
        const done = await copyText(output)
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
      }, [output, t])

      /**
       * Empty both text boxes and drop the previous result.
       * @returns nothing.
       */
      const clear = React.useCallback(() => {
        setSource('')
        setOutput('')
        setResult(null)
        setError(null)
        setErrorTitle(null)
        setStatus('idle')
      }, [])

      // The status pill carries a short state label; the alert region carries
      // the full sentence, so the pill is never the only signal.
      const alertMessage = error !== null ? error : host.offline ? t('error.offline') : null
      const state = host.offline
        ? 'offline'
        : error !== null
          ? 'error'
          : pending
            ? 'working'
            : overLimit
              ? 'limited'
              : status === 'cancelled'
                ? 'cancelled'
                : !host.connected
                  ? 'connecting'
                  : 'ready'
      const stateLabel = host.offline
        ? t('status.offline')
        : error !== null
          ? t('status.error')
          : pending
            ? t('status.translating')
            : overLimit
              ? t('status.limited')
              : status === 'cancelled'
                ? t('status.cancelled')
                : !host.connected
                  ? t('status.connecting')
                  : t('status.ready')
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
        h(
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
        ),
        h(
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
              title: swapReason === null ? t('action.swap') : t(swapReason),
              'aria-label': swapReason === null ? t('action.swap') : t(swapReason),
              'aria-describedby': swapReason === null ? undefined : ids.note,
              // `aria-disabled` keeps the control focusable, so a keyboard
              // user can reach it and hear why it cannot act.
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
        ),
        notice === null
          ? null
          : h('p', { className: 'dshTr-notice', role: 'status' }, notice),
        swapReason === null
          ? null
          : h('p', { className: 'dshTr-note', id: ids.note }, t(swapReason)),
        h(
          'div',
          { className: 'dshTr-grid', 'data-stacked': narrow ? 'true' : 'false' },
          h(
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
                    onClick: clear,
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
              onChange: (event) => {
                // Editing the submitted text invalidates its response. Abort
                // the Host request and clear the previous answer so it cannot
                // appear beside text that was never translated.
                if (pending) cancel()
                setSource(event.target.value)
                setOutput('')
                setResult(null)
                setCopied(false)
                setError(null)
                setErrorTitle(null)
                setStatus('idle')
              },
              onKeyDown: (event) => {
                if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') {
                  event.preventDefault()
                  void run()
                  return
                }
                if (event.key === 'Escape' && pending) {
                  // Escape cancels the running request instead of reaching the
                  // shell's own Escape handling.
                  event.preventDefault()
                  event.stopPropagation()
                  cancel()
                }
              },
            }),
          ),
          h(
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
                      void copy()
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
              output.length > 0
                ? output
                : h('span', { className: 'dshTr-placeholder', 'aria-hidden': true }, t('placeholder.result')),
            ),
          ),
        ),
        alertMessage !== null
          ? h(
              'div',
              {
                className: 'dshTr-error',
                role: 'alert',
                title: errorTitle ?? undefined,
              },
              alertMessage,
            )
          : null,
        h(
          'div',
          { className: 'dshTr-foot' },
          h(
            'button',
            {
              type: 'button',
              className: 'dshTr-button',
              disabled: !canTranslate,
              'aria-keyshortcuts': 'Control+Enter Meta+Enter',
              // The hint and the live counter both explain the action: the
              // counter is also where an over-limit refusal is stated.
              'aria-describedby': `${ids.hint} ${ids.counter}`,
              onClick: () => {
                void run()
              },
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
                  onClick: cancel,
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
            host.limit === null
              ? t('meta.limitPending')
              : overLimit
                ? t('meta.over', { count: source.length - host.limit })
                : t('meta.count', { count: source.length, limit: host.limit }),
          ),
        ),
        h(
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
          detectedSource !== null
            ? h('span', null, t('meta.detectedSource', { language: renderLanguage(
                LANGUAGE_CATALOG.find((entry) => entry.id === detectedSource) ?? {
                  id: detectedSource,
                  label: detectedSource,
                  zh: detectedSource,
                },
              ) }))
            : null,
        ),
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
