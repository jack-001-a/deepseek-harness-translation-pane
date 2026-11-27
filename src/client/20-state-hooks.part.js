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

    /**
     * Own the user's language, provider and translation-format preferences.
     *
     * Read storage once, normalize known enum values, preserve non-empty
     * language tags from older/custom Hosts, and keep the selected provider
     * inside the currently advertised Host catalog.
     * @param providers - provider ids advertised by the current Host.
     * @returns preference values and stable setters.
     */
    function useTranslationPreferences({ providers }) {
      const [preferences, setPreferences] = React.useState(() =>
        normalizePreferences(readPreferences(), PROVIDER_CATALOG),
      )

      const update = React.useCallback((key, value) => {
        setPreferences((previous) => {
          const next = typeof value === 'function' ? value(previous[key]) : value
          if (Object.is(next, previous[key])) return previous
          return { ...previous, [key]: next }
        })
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
        if (providers.length > 0 && !providers.includes(preferences.provider)) {
          setProvider(providers[0])
        }
      }, [providers, preferences.provider, setProvider])

      React.useEffect(() => {
        writePreferences(preferences)
      }, [preferences])

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
        return state.subscribe(() => {
          const snapshot = state.getSnapshot?.()
          if (snapshot === 'connected') {
            void describeHost()
            return
          }
          if (snapshot === 'disconnected') {
            describeSeq.current += 1
            describeAbortRef.current?.abort()
            describeAbortRef.current = null
            setHost((previous) => ({ ...previous, connected: false, offline: true }))
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

      const applyGlossary = React.useCallback(async () => {
        if (!mountedRef.current || !host.connected || glossaryBusy) return
        setGlossaryBusy(true)
        setGlossaryMessage(null)
        try {
          const value = await callHost(ctx, 'setGlossary', { payload: glossaryDraft })
          if (!mountedRef.current) return
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
          if (mountedRef.current) {
            setGlossaryMessage(diagnosticFor(failure) || t('error.generic'))
          }
        } finally {
          if (mountedRef.current) setGlossaryBusy(false)
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
        const file = event.target.files?.[0]
        if (!file) {
          event.target.value = ''
          return
        }
        event.target.value = ''
        if (file.size > 256 * 1024 || typeof file.text !== 'function') {
          setGlossaryMessage(t('glossary.invalidFile'))
          return
        }
        try {
          const contents = await file.text()
          if (!mountedRef.current) return
          setGlossaryDraft(contents)
          glossaryDraftDirtyRef.current = true
          setGlossaryMessage(null)
        } catch {
          if (mountedRef.current) setGlossaryMessage(t('glossary.invalidFile'))
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
