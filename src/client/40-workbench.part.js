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

      const copiedTimerRef = React.useRef(null)
      // Surface terminology problems without making advanced configuration
      // consume the default workbench space.
      React.useEffect(() => {
        if (host.glossaryWarnings.length > 0) setGlossaryOpen(true)
      }, [host.glossaryWarnings.length])

      React.useEffect(
        () => () => {
          // Abandon any in-flight request and clear the copy timer, so a
          // closed panel never keeps a timer alive and never redraws.
          if (copiedTimerRef.current !== null) {
            clearTimeout(copiedTimerRef.current)
            copiedTimerRef.current = null
          }
        },
        [],
      )

      const sourceOptions = React.useMemo(
        () => withValue(languageOptions(host.languages, true, LANGUAGE_CATALOG), sourceLanguage),
        [host.languages, sourceLanguage],
      )
      const targetOptions = React.useMemo(
        () => withValue(languageOptions(host.languages, false, LANGUAGE_CATALOG), targetLanguage),
        [host.languages, targetLanguage],
      )
      const serviceOptions = React.useMemo(
        () => withValue(providerOptions(host.providers, PROVIDER_CATALOG), provider),
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

      const { notice, servedLabel } = resolveProviderPresentation({
        pending,
        result,
        provider,
        providerHealth: host.providerHealth,
        failoverCapable: host.failoverCapable,
        error,
        providerLabel,
        providerName,
        t,
      })

      /**
       * Keep the enabled state and its localized explanation in sync.
       */
      const swapReason = React.useMemo(
        () => resolveLanguageSwapReason({ pending, sourceLanguage, targetLanguage, detectedSource }),
        [detectedSource, pending, sourceLanguage, targetLanguage],
      )

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
      }, [output, t])

      /**
       * Empty both text boxes and drop the previous result.
       * @returns nothing.
       */
      const clear = React.useCallback(() => {
        setSource('')
        resetTranslation()
      }, [resetTranslation])

      /**
       * Editing submitted text cancels any active request and invalidates its result.
       */
      const handleSourceChange = React.useCallback((event) => {
        if (pending) cancel()
        setSource(event.target.value)
        resetTranslation()
      }, [cancel, pending, resetTranslation, setSource])

      /**
       * Keep keyboard shortcuts at the workbench boundary, next to request state.
       */
      const handleSourceKeyDown = React.useCallback((event) => {
        if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') {
          event.preventDefault()
          void run({ source, sourceLanguage, targetLanguage, provider, format })
          return
        }
        if (event.key === 'Escape' && pending) {
          // Escape cancels the running request instead of reaching the shell.
          event.preventDefault()
          event.stopPropagation()
          cancel()
        }
      }, [cancel, format, pending, provider, run, source, sourceLanguage, targetLanguage])

      const submitTranslation = React.useCallback(() => {
        void run({ source, sourceLanguage, targetLanguage, provider, format })
      }, [format, provider, run, source, sourceLanguage, targetLanguage])

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