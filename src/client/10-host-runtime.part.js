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
     * Normalize one stored preference snapshot without discarding custom
     * language tags that may be supported by a newer Host.
     * @param value - the parsed storage value.
     * @returns a complete, safe preference snapshot.
     */
    function normalizePreferences(value) {
      const saved = value !== null && typeof value === 'object' && !Array.isArray(value)
        ? value
        : {}
      const nonEmptyString = (candidate, fallback) =>
        typeof candidate === 'string' && candidate.trim().length > 0 ? candidate : fallback

      return {
        sourceLanguage: nonEmptyString(saved.sourceLanguage, 'auto'),
        targetLanguage: nonEmptyString(saved.targetLanguage, 'zh-Hans'),
        provider: PROVIDER_CATALOG.some((entry) => entry.id === saved.provider)
          ? saved.provider
          : 'bing',
        format: saved.format === 'json' || saved.format === 'markdown' ? saved.format : 'text',
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