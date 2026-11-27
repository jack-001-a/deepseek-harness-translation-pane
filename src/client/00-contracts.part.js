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