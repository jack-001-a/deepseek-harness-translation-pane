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
     * Resolve the compact status, full alert copy and visual state from the
     * current Host and request snapshot. Keep precedence in one pure function
     * so the header and alert cannot drift apart as new states are added.
     * @param options - Host/request facts and the active translator.
     * @returns the current status pill and alert presentation.
     */
    const STATUS_PRESENTATION = Object.freeze({
      offline: { state: 'offline', label: 'status.offline' },
      error: { state: 'error', label: 'status.error' },
      pending: { state: 'working', label: 'status.translating' },
      limited: { state: 'limited', label: 'status.limited' },
      cancelled: { state: 'cancelled', label: 'status.cancelled' },
      connecting: { state: 'connecting', label: 'status.connecting' },
      ready: { state: 'ready', label: 'status.ready' },
    })

    function resolveWorkbenchStatus(options) {
      const { error, offline, pending, overLimit, status, connected, t } = options
      // One ordered decision drives both the visual state and its spoken label.
      // Keep offline/error above work-in-progress and input-limit states.
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
     *
     * Auto detect has no effective source language until a translation returns
     * one. Once detected, that language must differ from the target before a
     * direction change is useful.
     * @param options - current request and language-selection state.
     * @returns the dictionary key for the reason, or null when swapping works.
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