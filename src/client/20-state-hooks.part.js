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
      } else if (preferenceSubscribers.size === 0) {
        // No storage listener is retained while every panel is closed. Read
        // the latest persisted value on the next mount, but preserve the
        // in-memory snapshot when storage is unavailable or access is denied.
        try {
          const storage = globalThis.localStorage
          if (typeof storage?.getItem === 'function') {
            const raw = storage.getItem(STORAGE_KEY)
            const saved = typeof raw === 'string' ? JSON.parse(raw) : {}
            sharedPreferencesSnapshot = normalizePreferences(saved, PROVIDER_CATALOG)
          }
        } catch {
          // Keep the last in-memory value when localStorage cannot be read.
        }
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
     * The Host description is shared by every view mounted from this plugin
     * factory. Keep one connection subscription and one in-flight metadata
     * request for the whole workbench, not one per visible panel.
     */
    function emptySharedHostSnapshot() {
      return {
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
      }
    }
    let sharedHostSnapshot = emptySharedHostSnapshot()
    const hostSubscribers = new Set()
    let hostConnectionUnsubscribe = null
    let hostConnectionSnapshot = undefined
    let hostDescribeSeq = 0
    let hostDescribeAbortRef = null
    let hostDescribePromise = null
    let hostDescribeIsRefresh = false

    function publishSharedHost(next) {
      sharedHostSnapshot = typeof next === 'function' ? next(sharedHostSnapshot) : next
      for (const subscriber of [...hostSubscribers]) subscriber(sharedHostSnapshot)
      return sharedHostSnapshot
    }

    function cancelSharedHostDescription() {
      hostDescribeSeq += 1
      hostDescribeAbortRef?.abort()
      hostDescribeAbortRef = null
      hostDescribePromise = null
      hostDescribeIsRefresh = false
    }

    function refreshSharedHost(force = false) {
      if (hostSubscribers.size === 0) return Promise.resolve(false)
      if (hostDescribePromise !== null) {
        // A successful translation requires a fresh metadata read even when
        // the initial load is still pending. Concurrent post-translation
        // refreshes, however, should converge on that one fresh request.
        if (!force || hostDescribeIsRefresh) return hostDescribePromise
        cancelSharedHostDescription()
      }

      const seq = ++hostDescribeSeq
      hostDescribeIsRefresh = force
      const controller = new AbortController()
      hostDescribeAbortRef = controller
      const isCurrent = () =>
        hostSubscribers.size > 0 &&
        seq === hostDescribeSeq &&
        !controller.signal.aborted

      const request = (async () => {
        try {
          for (let attempt = 0; attempt <= DESCRIBE_RETRY_DELAYS_MS.length; attempt += 1) {
            if (!isCurrent()) return false
            try {
              const value = await callHost(ctx, 'describe', {}, controller.signal)
              if (!isCurrent()) return false
              publishSharedHost({
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
          publishSharedHost((previous) => ({
            ...previous,
            connected: false,
            offline: carrierUnreachable(),
          }))
          return false
        } finally {
          if (hostDescribeAbortRef === controller) hostDescribeAbortRef = null
          if (hostDescribePromise === request) {
            hostDescribePromise = null
            hostDescribeIsRefresh = false
          }
        }
      })()
      hostDescribePromise = request
      return request
    }

    function onSharedConnectionChange(state) {
      const snapshot = state.getSnapshot?.()
      if (Object.is(snapshot, hostConnectionSnapshot)) return
      hostConnectionSnapshot = snapshot

      if (snapshot === 'connected') {
        void refreshSharedHost()
        return
      }
      if (snapshot === 'disconnected' || snapshot === 'connecting') {
        cancelSharedHostDescription()
        publishSharedHost((previous) => ({
          ...previous,
          connected: false,
          offline: snapshot === 'disconnected',
        }))
      }
    }

    function subscribeSharedHost(subscriber) {
      hostSubscribers.add(subscriber)
      subscriber(sharedHostSnapshot)

      if (hostSubscribers.size === 1) {
        const state = optionalService(ctx, 'connection')?.state
        hostConnectionSnapshot = state?.getSnapshot?.()
        if (typeof state?.subscribe === 'function') {
          hostConnectionUnsubscribe = state.subscribe(() => onSharedConnectionChange(state))
        }
        if (hostConnectionSnapshot === 'disconnected' || hostConnectionSnapshot === 'connecting') {
          publishSharedHost((previous) => ({
            ...previous,
            connected: false,
            offline: hostConnectionSnapshot === 'disconnected',
          }))
        } else {
          void refreshSharedHost()
        }
      }

      return () => {
        hostSubscribers.delete(subscriber)
        if (hostSubscribers.size > 0) return
        hostConnectionUnsubscribe?.()
        hostConnectionUnsubscribe = null
        hostConnectionSnapshot = undefined
        cancelSharedHostDescription()
        // The connection subscription is intentionally absent while no view
        // is mounted. Do not carry a possibly stale Host snapshot into the
        // next opening; its first subscriber will read the current connection.
        sharedHostSnapshot = emptySharedHostSnapshot()
      }
    }

    function useHostConnection({ setGlossaryDraft, glossaryDraftDirtyRef }) {
      const [host, setHost] = React.useState(sharedHostSnapshot)
      const mountedRef = React.useRef(true)
      const describeHost = React.useCallback(() => refreshSharedHost(true), [])

      React.useEffect(() => {
        mountedRef.current = true
        const sync = (snapshot) => {
          setHost(snapshot)
          if (!glossaryDraftDirtyRef.current) {
            setGlossaryDraft(glossaryJson(snapshot.glossary))
          }
        }
        const unsubscribe = subscribeSharedHost(sync)
        return () => {
          mountedRef.current = false
          unsubscribe()
        }
      }, [])

      return { host, setHost: publishSharedHost, describeHost, mountedRef }
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
