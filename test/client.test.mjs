/**
 * Browser-half tests for @ybbmm/dsh-translation-pane.
 *
 * The bundle is a module-loader side effect, so this test supplies a tiny
 * `window.__ModuleLoader__` and a hook-capable React stand-in, then drives
 * the real registration and panel code.
 *
 * The tests that matter most here are the rendering ones: a select whose
 * option has no name in the active locale renders a blank entry, and a blank
 * entry is invisible in the UI but still passes every unit test that only
 * looks at ids. The panel must therefore never render an unnamed option, in
 * any locale.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'

const NS = 'ybbmm.dsh-translation-pane'
/** The preferences key the panel's own `localStorage` document uses. */
const STORAGE_KEY = 'dsh.translationPane.preferences'

/** The mount whose render is in progress, read by the React stand-in. */
let currentOwner

/**
 * Build a minimal React stand-in: createElement plus per-mount state, refs,
 * memos, callbacks and effects.
 * @returns the stand-in.
 */
function createReact() {
  const element = (type, props, ...children) => {
    const merged = { ...(props ?? {}) }
    if (children.length > 0) merged.children = children.length === 1 ? children[0] : children
    return { type, props: merged, children: children.flat() }
  }

  /**
   * Whether a dependency list changed since the previous render.
   * @param previous - the recorded dependencies.
   * @param next - the current dependencies.
   * @returns whether the list changed.
   */
  const changed = (previous, next) => {
    if (previous === undefined || next === undefined) return true
    if (previous.length !== next.length) return true
    return next.some((dep, index) => !Object.is(dep, previous[index]))
  }

  return {
    Fragment: 'Fragment',
    createElement: element,
    useState(initial) {
      const owner = currentOwner
      const index = owner.index
      owner.index += 1
      if (!(index in owner.values)) {
        owner.values[index] = typeof initial === 'function' ? initial() : initial
      }
      return [
        owner.values[index],
        (next) => {
          owner.values[index] = typeof next === 'function' ? next(owner.values[index]) : next
          owner.schedule()
        },
      ]
    },
    useRef(initial) {
      const owner = currentOwner
      const index = owner.index
      owner.index += 1
      if (!(index in owner.values)) owner.values[index] = { current: initial }
      return owner.values[index]
    },
    useMemo(factory, deps) {
      const owner = currentOwner
      const index = owner.index
      owner.index += 1
      const previous = owner.values[index]
      if (previous === undefined || changed(previous.deps, deps)) {
        owner.values[index] = { deps: deps === undefined ? undefined : [...deps], value: factory() }
      }
      return owner.values[index].value
    },
    useCallback(callback, deps) {
      const owner = currentOwner
      const index = owner.index
      owner.index += 1
      const previous = owner.values[index]
      if (previous === undefined || changed(previous.deps, deps)) {
        owner.values[index] = { deps: deps === undefined ? undefined : [...deps], value: callback }
      }
      return owner.values[index].value
    },
    useEffect(effect, deps) {
      const owner = currentOwner
      const index = owner.index
      owner.index += 1
      const previous = owner.values[index]
      const isChanged =
        previous === undefined ||
        previous.deps === undefined ||
        deps === undefined ||
        changed(previous.deps, deps)
      owner.values[index] = { deps: deps === undefined ? undefined : [...deps] }
      // Effects run after the render, exactly like the browser does. Keep
      // their cleanup so unmount and Strict Mode replay can be exercised.
      if (isChanged) {
        owner.effects.push(() => {
          owner.cleanups[index]?.()
          const cleanup = effect()
          owner.cleanups[index] = typeof cleanup === 'function' ? cleanup : undefined
        })
      }
    },
  }
}

let cachedDefinition

/**
 * Load the bundle once (the module loader fires on the first import only).
 * @returns the plugin definition plus its React stand-in.
 */
async function loadPlugin() {
  if (cachedDefinition === undefined) {
    globalThis.window = {
      __ModuleLoader__: {
        load: (loaded) => {
          cachedDefinition = loaded
        },
      },
    }
    await import('../client.js')
  }
  assert.ok(cachedDefinition, 'client.js must register itself with the module loader')
  const React = createReact()
  const require = (spec) => {
    if (spec === 'react') return React
    throw new Error(`unexpected require: ${spec}`)
  }
  return { plugin: cachedDefinition.factory(require), React }
}

/** The routing facts a current Host reports. */
const HOST_DESCRIBE = {
  route: 'direct',
  providers: ['bing', 'google'],
  languages: ['auto', 'zh-Hans', 'en'],
  maxTextChars: 20000,
  fragmentChars: 3000,
  maxRetries: 2,
  rateLimitPerMinute: 60,
  cacheEntries: 0,
  cacheHits: 0,
  cacheMisses: 0,
  glossaryEntries: 0,
  glossary: [],
  glossaryWarnings: [],
  providerHealth: {
    bing: { unreachable: false },
    google: { unreachable: false },
  },
  failover: true,
}

/**
 * Apply the plugin to a fake client context.
 * @param plugin - the plugin object.
 * @param locale - the active UI locale.
 * @param options - `describe`, `translate` and `connectionState` overrides.
 * @returns the captured registrations, dictionaries and fake services.
 */
function applyPlugin(plugin, locale, options = {}) {
  const dictionaries = {}
  const registrations = {}
  const generators = {}
  const describe = options.describe ?? HOST_DESCRIBE
  const translate = options.translate ?? (() => ({ text: '' }))
  const stateListeners = new Set()
  let stateSnapshot = options.connectionState ?? 'connected'
  const services = {
    locale: {
      register: (namespace, dicts) => {
        dictionaries[namespace] = dicts
        return () => {}
      },
      bind: (namespace) => (key) => dictionaries[namespace]?.[locale]?.[key] ?? key,
      getLocale: () => ({ active: locale }),
      subscribe: () => () => {},
    },
    connection: {
      state: {
        getSnapshot: () => stateSnapshot,
        subscribe: (listener) => {
          stateListeners.add(listener)
          return () => stateListeners.delete(listener)
        },
      },
      rpc: {
        call: (_channel, endpoint, payload, signal) => {
          if (endpoint === 'translationPane/describe') {
            const value = typeof describe === 'function' ? describe(signal) : describe
            return Promise.resolve(value).then((resolved) => ({ ok: true, value: resolved }))
          }
          if (endpoint === 'translationPane/translate') {
            return Promise.resolve(translate(payload?.args, signal)).then((value) => {
              // A test may return a whole RPC result to simulate a Host failure.
              if (value !== null && typeof value === 'object' && typeof value.ok === 'boolean') {
                return value
              }
              return { ok: true, value }
            })
          }
          if (endpoint === 'translationPane/setGlossary') {
            const action = options.setGlossary ?? ((args) => {
              const parsed = JSON.parse(args.payload)
              const glossary = Array.isArray(parsed) ? parsed : parsed.glossary
              return { glossary, warnings: [], count: glossary.length, revision: 1 }
            })
            return Promise.resolve(action(payload?.args)).then((value) => {
              if (value !== null && typeof value === 'object' && typeof value.ok === 'boolean') return value
              return { ok: true, value }
            })
          }
          return Promise.resolve({ ok: true, value: {} })
        },
      },
    },
  }
  const ctx = {
    effect: (setup) => setup(),
    locale: services.locale,
    slots: {
      inject: (name, generator) => {
        generators[name] = generator
      },
      register: (spec, component) => {
        registrations[spec.name] = { spec, component }
        return () => {}
      },
    },
    get: (name) => services[name],
  }
  plugin.apply(ctx)
  for (const [name, generator] of Object.entries(generators)) {
    // A slot callback may be a plain function or a generator function; the
    // registration happens either way.
    const produced = generator()
    if (typeof produced?.next === 'function') {
      const step = produced.next()
      assert.equal(step.done, false, `${name} must yield its slot registration`)
    }
  }
  return {
    registrations,
    dictionaries,
    services,
    setConnectionState: (snapshot) => {
      stateSnapshot = snapshot
      for (const listener of stateListeners) listener()
    },
  }
}

/**
 * Mount one component function; `tree` reflects the latest render.
 *
 * The tree is expanded: a child that is itself a component is rendered in
 * place, so the test sees the real `<select>` and `<option>` elements rather
 * than the component elements that produce them.
 * @param Component - the function component.
 * @param props - its props.
 * @returns the mount handle.
 */
function mount(Component, props) {
  const owner = { index: 0, values: [], tree: undefined, scheduled: false, unmounted: false, scheduleCalls: 0, effects: [], cleanups: [] }

  /**
   * Replace every component element with the tree it renders.
   * @param node - the node to expand.
   * @returns the expanded node.
   */
  const expand = (node) => {
    if (node === null || node === undefined || typeof node !== 'object') return node
    if (Array.isArray(node)) return node.map(expand)
    if (typeof node.type === 'function') {
      const previous = currentOwner
      currentOwner = owner
      try {
        return expand(node.type(node.props))
      } finally {
        currentOwner = previous
      }
    }
    return { ...node, children: (node.children ?? []).map(expand) }
  }

  const draw = () => {
    owner.index = 0
    owner.effects = []
    const previous = currentOwner
    currentOwner = owner
    try {
      owner.tree = expand(Component(props))
    } finally {
      currentOwner = previous
    }
    const effects = owner.effects
    owner.effects = []
    for (const effect of effects) effect()
  }
  owner.schedule = () => {
    owner.scheduleCalls += 1
    if (owner.unmounted || owner.scheduled) return
    owner.scheduled = true
    queueMicrotask(() => {
      owner.scheduled = false
      draw()
    })
  }
  draw()
  owner.unmount = () => {
    owner.unmounted = true
    for (let index = owner.cleanups.length - 1; index >= 0; index -= 1) {
      owner.cleanups[index]?.()
      owner.cleanups[index] = undefined
    }
  }
  return owner
}

/**
 * Collect every element of a tree that satisfies a predicate.
 * @param node - the tree or a subtree.
 * @param predicate - the test each element must pass.
 * @returns the matching elements.
 */
function findAll(node, predicate) {
  if (node === null || node === undefined || typeof node !== 'object') return []
  if (Array.isArray(node)) return node.flatMap((child) => findAll(child, predicate))
  const found = predicate(node) ? [node] : []
  return found.concat(findAll(node.children ?? [], predicate))
}

/**
 * The text a node renders.
 * @param node - the node.
 * @returns the concatenated text.
 */
function textOf(node) {
  if (node === null || node === undefined || typeof node === 'boolean') return ''
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  if (Array.isArray(node)) return node.map(textOf).join('')
  return textOf(node.children ?? [])
}

/**
 * Render the panel in one locale and return its selects.
 * @param locale - the active UI locale.
 * @param options - `describe`, `translate` and `connectionState` overrides.
 * @returns the rendered selects.
 */
function renderPanel(locale, options = {}) {
  const rendered = mountPanel({ ...options, locale })
  return findAll(rendered.mounted.tree, (node) => node.type === 'select')
}

/**
 * Mount the page component with a real locale-bound `t`.
 * @param options - `locale`, `describe`, `translate` and `connectionState`.
 * @returns the mount handle plus the bound translator.
 */
function mountPanel(options = {}) {
  const locale = options.locale ?? 'en'
  const { plugin } = loadPluginState
  const { registrations, dictionaries, setConnectionState } = applyPlugin(plugin, locale, options)
  const table = dictionaries[NS][locale]
  const t = (key, params) => {
    const template = table[key] ?? key
    if (!params) return template
    return template.replace(/\{(\w+)\}/g, (match, name) =>
      name in params ? String(params[name]) : match,
    )
  }
  // The `main` slot owns the page component, which renders the panel.
  const page = registrations['main'].component
  return { mounted: mount(page, { t }), t, locale, setConnectionState }
}

/**
 * Let every queued promise, effect and redraw settle.
 * @returns resolution once the panel is idle.
 */
async function flushPanel() {
  for (let index = 0; index < 5; index += 1) {
    await new Promise((resolve) => setTimeout(resolve, 0))
  }
}

/**
 * Find one rendered node, failing the test when it is absent.
 * @param tree - the rendered tree.
 * @param predicate - the test the element must pass.
 * @param label - what is being looked for, for the assertion message.
 * @returns the matching element.
 */
function findOne(tree, predicate, label) {
  const found = findAll(tree, predicate)
  assert.ok(found.length > 0, `the panel must render ${label}`)
  return found[0]
}

/** The primary Translate button. */
function translateButton(tree) {
  return findOne(
    tree,
    (node) =>
      node.type === 'button' &&
      String(node.props?.className).split(' ').includes('dshTr-button') &&
      !String(node.props?.className).includes('buttonGhost'),
    'the Translate button',
  )
}

/** The source textarea. */
function sourceArea(tree) {
  return findOne(tree, (node) => node.type === 'textarea', 'the source editor')
}

/**
 * Type into the source editor and let the panel redraw.
 * @param mounted - the mount handle.
 * @param text - the new source text.
 * @returns resolution once the redraw settled.
 */
async function typeSource(mounted, text) {
  sourceArea(mounted.tree).props.onChange({ target: { value: text } })
  await flushPanel()
}

/**
 * Run one block with a fake `localStorage`, restoring the global afterwards.
 * @param preferences - the saved preferences object.
 * @param run - the block to run.
 * @returns the block's result.
 */
async function withPreferences(preferences, run) {
  const previous = globalThis.localStorage
  const store = new Map([[STORAGE_KEY, JSON.stringify(preferences)]])
  globalThis.localStorage = {
    getItem: (key) => store.get(key) ?? null,
    setItem: (key, value) => {
      store.set(key, value)
    },
  }
  try {
    return await run(store)
  } finally {
    if (previous === undefined) delete globalThis.localStorage
    else globalThis.localStorage = previous
  }
}

/** The loaded plugin, shared by every test. */
let loadPluginState

test('stored translation preferences are restored and persisted as one snapshot', async () => {
  loadPluginState = await loadPlugin()
  await withPreferences({
    sourceLanguage: 'fr',
    targetLanguage: 'ja',
    provider: 'google',
    format: 'markdown',
    legacyFlag: true,
  }, async (store) => {
    const { mounted } = mountPanel()
    await flushPanel()

    const selectValue = (suffix) => findOne(
      mounted.tree,
      (node) => node.type === 'select' && String(node.props?.id).endsWith(suffix),
      `the ${suffix} selector`,
    ).props.value
    assert.equal(selectValue('-source'), 'fr')
    assert.equal(selectValue('-target'), 'ja')
    assert.equal(selectValue('-service'), 'google')
    assert.equal(selectValue('-format'), 'markdown')

    const change = (suffix, value) => {
      findOne(
        mounted.tree,
        (node) => node.type === 'select' && String(node.props?.id).endsWith(suffix),
        `the ${suffix} selector`,
      ).props.onChange({ target: { value } })
    }
    change('-source', 'en')
    change('-target', 'zh-Hans')
    change('-service', 'bing')
    change('-format', 'json')
    await flushPanel()

    assert.deepEqual(JSON.parse(store.get(STORAGE_KEY)), {
      sourceLanguage: 'en',
      targetLanguage: 'zh-Hans',
      provider: 'bing',
      format: 'json',
    })
    mounted.unmount()
  })
})

test('invalid stored preference values fall back without rejecting custom language tags', async () => {
  loadPluginState = await loadPlugin()
  await withPreferences({
    sourceLanguage: 'custom-lang-x',
    targetLanguage: '',
    provider: 'not-a-provider',
    format: 'xml',
  }, async (store) => {
    const { mounted } = mountPanel()
    await flushPanel()

    const value = (suffix) => findOne(
      mounted.tree,
      (node) => node.type === 'select' && String(node.props?.id).endsWith(suffix),
      `the ${suffix} selector`,
    ).props.value
    assert.equal(value('-source'), 'custom-lang-x', 'custom language tags remain compatible with newer Hosts')
    assert.equal(value('-target'), 'zh-Hans')
    assert.equal(value('-service'), 'bing')
    assert.equal(value('-format'), 'text')
    assert.deepEqual(JSON.parse(store.get(STORAGE_KEY)), {
      sourceLanguage: 'custom-lang-x',
      targetLanguage: 'zh-Hans',
      provider: 'bing',
      format: 'text',
    })
    mounted.unmount()
  })
})

test('a provider removed from the Host catalog is corrected and persisted', async () => {
  loadPluginState = await loadPlugin()
  await withPreferences({ provider: 'google' }, async (store) => {
    const { mounted } = mountPanel({
      describe: { ...HOST_DESCRIBE, providers: ['bing'] },
    })
    await flushPanel()

    const service = findOne(
      mounted.tree,
      (node) => node.type === 'select' && String(node.props?.id).endsWith('-service'),
      'the service selector',
    )
    assert.equal(service.props.value, 'bing')
    assert.equal(JSON.parse(store.get(STORAGE_KEY)).provider, 'bing')
    mounted.unmount()
  })
})

test('blocked local storage falls back to defaults without breaking the workbench', async () => {
  loadPluginState = await loadPlugin()
  const previous = globalThis.localStorage
  globalThis.localStorage = {
    getItem() {
      throw new Error('storage access denied')
    },
    setItem() {
      throw new Error('storage access denied')
    },
  }
  try {
    const { mounted } = mountPanel()
    await flushPanel()
    const service = findOne(
      mounted.tree,
      (node) => node.type === 'select' && String(node.props?.id).endsWith('-service'),
      'the service selector',
    )
    const format = findOne(
      mounted.tree,
      (node) => node.type === 'select' && String(node.props?.id).endsWith('-format'),
      'the format selector',
    )
    assert.equal(service.props.value, 'bing')
    assert.equal(format.props.value, 'text')
    mounted.unmount()
  } finally {
    if (previous === undefined) delete globalThis.localStorage
    else globalThis.localStorage = previous
  }
})

test('the bundle registers its sidebar entry and its main panel', async () => {
  loadPluginState = await loadPlugin()
  const { registrations } = applyPlugin(loadPluginState.plugin, 'en')
  assert.ok(registrations['sidebar.panellist'], 'the sidebar entry must be registered')
  assert.equal(registrations['sidebar.panellist'].spec.id, 'translation-pane')
  assert.ok(registrations['main'], 'the main panel must be registered')
  assert.equal(registrations['main'].spec.key, 'translation-pane')
})

test('every option of every select has a name in the Chinese UI', async () => {
  loadPluginState = await loadPlugin()
  const selects = renderPanel('zh')
  assert.ok(selects.length >= 3, 'the panel has a source, a target and a service select')
  for (const select of selects) {
    const options = findAll(select.children, (node) => node.type === 'option')
    assert.ok(options.length > 0, 'a select must offer at least one option')
    for (const option of options) {
      const text = textOf(option)
      assert.equal(
        text.trim().length > 0,
        true,
        `an option rendered blank (value ${String(option.props?.value)})`,
      )
    }
  }
})

test('every option of every select has a name in the English UI', async () => {
  loadPluginState = await loadPlugin()
  const selects = renderPanel('en')
  for (const select of selects) {
    const options = findAll(select.children, (node) => node.type === 'option')
    for (const option of options) {
      assert.equal(
        textOf(option).trim().length > 0,
        true,
        `an option rendered blank (value ${String(option.props?.value)})`,
      )
    }
  }
})

test('duplicate Host catalog ids render once and retain advertised order', async () => {
  loadPluginState = await loadPlugin()
  const { mounted } = mountPanel({
    describe: {
      ...HOST_DESCRIBE,
      languages: ['auto', 'en', 'en', 'custom-lang-x', 'custom-lang-x', 'zh-Hans'],
      providers: ['google', 'bing', 'google', 'bing'],
    },
  })
  await flushPanel()

  const optionValues = (suffix) => {
    const select = findOne(
      mounted.tree,
      (node) => node.type === 'select' && String(node.props?.id).endsWith(suffix),
      `the ${suffix} selector`,
    )
    return findAll(select.children, (node) => node.type === 'option').map((node) => node.props.value)
  }

  assert.deepEqual(optionValues('-source'), ['auto', 'en', 'custom-lang-x', 'zh-Hans'])
  assert.deepEqual(optionValues('-target'), ['en', 'custom-lang-x', 'zh-Hans'])
  assert.deepEqual(optionValues('-service'), ['google', 'bing'])
  mounted.unmount()
})

test('the service select names the services in the active locale', async () => {
  loadPluginState = await loadPlugin()
  const chinese = renderPanel('zh')
  const service = chinese.find((select) => select.props?.id?.endsWith('-service'))
  assert.ok(service, 'the service select must be rendered')
  const names = findAll(service.children, (node) => node.type === 'option').map(textOf)
  assert.deepEqual(names, ['必应'])

  const english = renderPanel('en')
  const englishService = english.find((select) => select.props?.id?.endsWith('-service'))
  const englishNames = findAll(englishService.children, (node) => node.type === 'option').map(textOf)
  assert.deepEqual(englishNames, ['Bing'])
})

test('both dictionaries carry exactly the same keys', async () => {
  loadPluginState = await loadPlugin()
  const { dictionaries } = applyPlugin(loadPluginState.plugin, 'en')
  const en = Object.keys(dictionaries[NS].en).sort()
  const zh = Object.keys(dictionaries[NS].zh).sort()
  assert.deepEqual(en, zh, 'the two dictionaries must stay in step')
  assert.ok(en.length > 20, 'the panel needs a full dictionary')
})

test('the panel exposes its constraints and text direction to assistive technology', async () => {
  loadPluginState = await loadPlugin()
  const { mounted } = mountPanel()
  await flushPanel()

  const editor = sourceArea(mounted.tree)
  const counter = findOne(
    mounted.tree,
    (node) => node.type === 'span' && String(node.props?.id).endsWith('-counter'),
    'the character counter',
  )
  const hint = findOne(
    mounted.tree,
    (node) => node.type === 'span' && String(node.props?.id).endsWith('-hint'),
    'the keyboard hint',
  )
  const describedBy = String(translateButton(mounted.tree).props['aria-describedby']).split(' ')
  assert.ok(describedBy.includes(counter.props.id), 'the action must describe its character counter')
  assert.ok(describedBy.includes(hint.props.id), 'the action must describe its shortcut hint')
  assert.equal(editor.props.dir, 'auto', 'the source editor must follow its content direction')
  assert.equal(editor.props['aria-invalid'], undefined)

  const region = findOne(mounted.tree, (node) => node.props?.role === 'region', 'the result region')
  assert.equal(region.props.dir, 'auto', 'the result must follow its content direction')
  assert.equal(region.props['aria-atomic'], 'true')
  assert.equal(region.props['aria-live'], 'polite')
  assert.equal(region.props.tabIndex, 0)
  // A Host that predates providerHealth must render without a notice.
  assert.equal(findAll(mounted.tree, (node) => node.props?.className === 'dshTr-notice').length, 0)
})

test('an over-limit source is marked invalid and cannot be translated', async () => {
  loadPluginState = await loadPlugin()
  const { mounted } = mountPanel({ describe: { ...HOST_DESCRIBE, maxTextChars: 5 } })
  await flushPanel()
  await typeSource(mounted, 'abcdef')

  assert.equal(sourceArea(mounted.tree).props['aria-invalid'], 'true')
  assert.equal(translateButton(mounted.tree).props.disabled, true)
  const counter = findOne(
    mounted.tree,
    (node) => node.type === 'span' && String(node.props?.id).endsWith('-counter'),
    'the character counter',
  )
  assert.match(textOf(counter), /Too long by 1 characters/)
  const status = findOne(
    mounted.tree,
    (node) => node.props?.className === 'dshTr-status',
    'the status pill',
  )
  assert.equal(textOf(status), 'Too long')

  // Shortening the text clears the invalid state and enables the action.
  await typeSource(mounted, 'abc')
  assert.equal(sourceArea(mounted.tree).props['aria-invalid'], undefined)
  assert.equal(translateButton(mounted.tree).props.disabled, false)
})

test('a running translation disables translating and can be cancelled', async () => {
  loadPluginState = await loadPlugin()
  const { mounted } = mountPanel({ translate: () => new Promise(() => {}) })
  await flushPanel()
  await typeSource(mounted, 'hello')
  translateButton(mounted.tree).props.onClick()
  await flushPanel()

  assert.equal(translateButton(mounted.tree).props.disabled, true)
  assert.equal(textOf(translateButton(mounted.tree)), 'Translating…')
  const cancel = findOne(
    mounted.tree,
    (node) => node.type === 'button' && String(node.props?.className).includes('buttonGhost'),
    'the Cancel button',
  )
  cancel.props.onClick()
  await flushPanel()

  const status = findOne(
    mounted.tree,
    (node) => node.props?.className === 'dshTr-status',
    'the status pill',
  )
  assert.equal(textOf(status), 'Cancelled')
  assert.equal(translateButton(mounted.tree).props.disabled, false)
})

test('the latest Host description wins when refresh responses arrive out of order', async () => {
  loadPluginState = await loadPlugin()
  const pendingDescriptions = []
  const signals = []
  const { mounted } = mountPanel({
    describe: (signal) => new Promise((resolve) => {
      signals.push(signal)
      pendingDescriptions.push(resolve)
    }),
    translate: () => ({
      text: 'translated',
      provider: 'bing',
      requestedProvider: 'bing',
      failover: false,
    }),
  })
  await flushPanel()
  assert.equal(pendingDescriptions.length, 1, 'the panel should start with one Host description')

  await typeSource(mounted, 'hello')
  translateButton(mounted.tree).props.onClick()
  await flushPanel()
  assert.equal(pendingDescriptions.length, 2, 'a successful translation should refresh Host metadata')
  assert.equal(signals[0].aborted, true, 'the newer refresh must cancel the superseded RPC')

  pendingDescriptions[1]({ ...HOST_DESCRIBE, maxTextChars: 1234 })
  await flushPanel()
  assert.ok(textOf(mounted.tree).includes('/ 1234'), 'the newer metadata should become visible')

  // Simulate an RPC carrier that still delivers a response after cancellation.
  pendingDescriptions[0]({ ...HOST_DESCRIBE, maxTextChars: 111 })
  await flushPanel()
  assert.ok(textOf(mounted.tree).includes('/ 1234'), 'a stale response must not overwrite the latest Host facts')

  mounted.unmount()
})

test('a successful Host description does not retrigger on metadata state updates', async () => {
  loadPluginState = await loadPlugin()
  let descriptions = 0
  const { mounted } = mountPanel({
    describe: () => {
      descriptions += 1
      return { ...HOST_DESCRIBE, maxTextChars: 1234 }
    },
  })
  await flushPanel()

  assert.equal(descriptions, 1, 'publishing Host metadata must not restart its own refresh effect')
  assert.ok(textOf(mounted.tree).includes('/ 1234'))
  mounted.unmount()
})

test('reconnecting refreshes the Host routing facts', async () => {
  loadPluginState = await loadPlugin()
  let descriptions = 0
  const { mounted, setConnectionState } = mountPanel({
    describe: () => {
      descriptions += 1
      return {
        ...HOST_DESCRIBE,
        maxTextChars: descriptions === 1 ? 1234 : 4321,
      }
    },
  })
  await flushPanel()
  assert.equal(descriptions, 1)

  setConnectionState('disconnected')
  await flushPanel()
  assert.match(textOf(mounted.tree), /Offline/)

  setConnectionState('connected')
  await flushPanel()
  assert.equal(descriptions, 2, 'a reconnect must request a fresh Host description')
  assert.ok(textOf(mounted.tree).includes('/ 4321'))
  mounted.unmount()
})

test('disconnect invalidates an in-flight Host description', async () => {
  loadPluginState = await loadPlugin()
  let resolveDescription
  let requestSignal
  const { mounted, setConnectionState } = mountPanel({
    describe: (signal) => {
      requestSignal = signal
      return new Promise((resolve) => {
        resolveDescription = resolve
      })
    },
  })
  await flushPanel()
  assert.ok(requestSignal, 'the initial Host description must start')
  setConnectionState('disconnected')
  await flushPanel()
  assert.equal(requestSignal.aborted, true, 'disconnect must cancel the stale Host read')

  // Simulate a carrier that delivers a response after its request was aborted.
  resolveDescription({ ...HOST_DESCRIBE, maxTextChars: 111 })
  await flushPanel()
  assert.ok(
    textOf(mounted.tree).includes('Checking the length limit'),
    'a late success must not restore stale connected metadata',
  )
  mounted.unmount()
})

test('unmount aborts a pending Host description', async () => {
  loadPluginState = await loadPlugin()
  let requestSignal
  const { mounted } = mountPanel({
    describe: (signal) => {
      requestSignal = signal
      return new Promise(() => {})
    },
  })
  await flushPanel()
  assert.ok(requestSignal, 'the Host description RPC must receive an AbortSignal')
  assert.equal(requestSignal.aborted, false)
  mounted.unmount()
  assert.equal(requestSignal.aborted, true, 'closing the panel must stop the metadata request')
})

test('same-text submissions in one event turn share a single request', async () => {
  loadPluginState = await loadPlugin()
  let calls = 0
  const { mounted } = mountPanel({
    translate: () => {
      calls += 1
      return new Promise(() => {})
    },
  })
  await flushPanel()
  await typeSource(mounted, 'same source')
  const button = translateButton(mounted.tree)
  button.props.onClick()
  button.props.onClick()
  await flushPanel()

  assert.equal(calls, 1, 'an immediate duplicate click must not restart the active request')
  mounted.unmount()
})

test('unmount aborts an active translation request', async () => {
  loadPluginState = await loadPlugin()
  let requestSignal
  const { mounted } = mountPanel({
    translate: (_args, signal) => {
      requestSignal = signal
      return new Promise(() => {})
    },
  })
  await flushPanel()
  await typeSource(mounted, 'pending translation')
  translateButton(mounted.tree).props.onClick()
  await flushPanel()

  assert.ok(requestSignal, 'the translation RPC must receive an AbortSignal')
  assert.equal(requestSignal.aborted, false)
  mounted.unmount()
  assert.equal(requestSignal.aborted, true, 'closing the workbench must abort its translation request')
})

test('editing the source cancels the request and ignores its late result', async () => {
  loadPluginState = await loadPlugin()
  let resolveTranslation
  let requestSignal
  const { mounted } = mountPanel({
    translate: (_args, signal) => {
      requestSignal = signal
      return new Promise((resolve) => {
        resolveTranslation = resolve
      })
    },
  })
  await flushPanel()
  await typeSource(mounted, 'first source')
  translateButton(mounted.tree).props.onClick()
  await flushPanel()

  assert.ok(requestSignal, 'the Host request must receive an AbortSignal')
  assert.equal(requestSignal.aborted, false)
  await typeSource(mounted, 'updated source')
  assert.equal(requestSignal.aborted, true, 'editing must abort the submitted request')

  resolveTranslation({
    text: 'stale translation',
    provider: 'bing',
    requestedProvider: 'bing',
    failover: false,
  })
  await flushPanel()

  const region = findOne(mounted.tree, (node) => node.props?.role === 'region', 'the result region')
  assert.equal(textOf(region).includes('stale translation'), false)
  assert.equal(translateButton(mounted.tree).props.disabled, false)
  const status = findOne(
    mounted.tree,
    (node) => node.props?.className === 'dshTr-status',
    'the status pill',
  )
  assert.equal(textOf(status), 'Ready')
})
test('a failover result names the served service in a status notice', async () => {
  loadPluginState = await loadPlugin()
  await withPreferences({ provider: 'google' }, async () => {
    const { mounted } = mountPanel({
      translate: () => ({
        text: '你好',
        provider: 'bing',
        requestedProvider: 'google',
        failover: true,
        cached: false,
        durationMs: 4,
      }),
    })
    await flushPanel()
    await typeSource(mounted, 'hello')
    translateButton(mounted.tree).props.onClick()
    await flushPanel()

    const notice = findOne(
      mounted.tree,
      (node) => node.props?.className === 'dshTr-notice',
      'the failover notice',
    )
    assert.equal(notice.props.role, 'status')
    assert.match(
      textOf(notice),
      /The Google service could not answer, so the Host translated with Bing\./,
    )
    const region = findOne(mounted.tree, (node) => node.props?.role === 'region', 'the result region')
    assert.equal(textOf(region), '你好')
    const meta = findOne(mounted.tree, (node) => node.props?.className === 'dshTr-meta', 'the result metadata')
    assert.match(textOf(meta), /Service: Bing/, 'metadata must name the provider that actually served the result')
    assert.doesNotMatch(textOf(meta), /Service: Google/)
  })
})

test('the failover notice is localized in Chinese', async () => {
  loadPluginState = await loadPlugin()
  await withPreferences({ provider: 'google' }, async () => {
    const { mounted } = mountPanel({
      locale: 'zh',
      translate: () => ({
        text: '你好',
        provider: 'bing',
        requestedProvider: 'google',
        failover: true,
        cached: false,
        durationMs: 4,
      }),
    })
    await flushPanel()
    await typeSource(mounted, 'hello')
    translateButton(mounted.tree).props.onClick()
    await flushPanel()

    const notice = findOne(
      mounted.tree,
      (node) => node.props?.className === 'dshTr-notice',
      'the failover notice',
    )
    assert.match(textOf(notice), /Host 已改用 必应 完成。/)
  })
})

test('a mixed-provider answer names every service that answered', async () => {
  loadPluginState = await loadPlugin()
  await withPreferences({ provider: 'google' }, async () => {
    const { mounted } = mountPanel({
      // A mixed answer must describe the services that contributed, even if
      // the originally selected provider is currently marked unreachable.
      describe: {
        ...HOST_DESCRIBE,
        providerHealth: {
          bing: { unreachable: false },
          google: { unreachable: true },
        },
      },
      translate: () => ({
        text: '你好世界',
        provider: 'google',
        requestedProvider: 'google',
        // Fragment one was answered by Google, fragment two failed over to Bing.
        providersServed: ['google', 'bing'],
        failover: true,
        cached: false,
        durationMs: 42,
      }),
    })
    await flushPanel()
    await typeSource(mounted, 'hello world')
    translateButton(mounted.tree).props.onClick()
    await flushPanel()

    const notice = findOne(
      mounted.tree,
      (node) => node.props?.className === 'dshTr-notice',
      'the mixed-provider notice',
    )
    assert.match(textOf(notice), /More than one service answered this text \(Google \+ Bing\)\./)
    // The single-service failover copy would name Google twice, so it must not
    // be what the panel shows.
    assert.doesNotMatch(textOf(notice), /could not answer/)

    const meta = findOne(
      mounted.tree,
      (node) => node.props?.className === 'dshTr-meta',
      'the meta line',
    )
    assert.match(textOf(meta), /Service: Google \+ Bing/)
  })
})

test('a provider the Host reports unreachable is flagged before translating', async () => {
  loadPluginState = await loadPlugin()
  await withPreferences({ provider: 'google' }, async () => {
    const { mounted } = mountPanel({
      describe: {
        ...HOST_DESCRIBE,
        providerHealth: {
          bing: { unreachable: false },
          google: { unreachable: true, reason: 'translation-pane/provider-unreachable', until: '2026-01-01T00:00:00.000Z' },
        },
      },
    })
    await flushPanel()
    const notice = findOne(
      mounted.tree,
      (node) => node.props?.className === 'dshTr-notice',
      'the provider health notice',
    )
    assert.match(
      textOf(notice),
      /The Google service is unavailable right now; translations will automatically use the other service\./,
    )

    // Choosing the healthy service clears the notice.
    const service = findOne(
      mounted.tree,
      (node) => node.type === 'select' && String(node.props?.id).endsWith('-service'),
      'the service select',
    )
    service.props.onChange({ target: { value: 'bing' } })
    await flushPanel()
    assert.equal(findAll(mounted.tree, (node) => node.props?.className === 'dshTr-notice').length, 0)
  })
})

test('a health warning is not shown when the Host cannot fail over', async () => {
  loadPluginState = await loadPlugin()
  await withPreferences({ provider: 'google' }, async () => {
    const { mounted } = mountPanel({
      describe: {
        ...HOST_DESCRIBE,
        failover: false,
        providerHealth: {
          bing: { unreachable: false },
          google: { unreachable: true, reason: 'translation-pane/provider-unreachable' },
        },
      },
    })
    await flushPanel()
    // The notice promises an automatic switch, which this Host cannot make.
    assert.equal(findAll(mounted.tree, (node) => node.props?.className === 'dshTr-notice').length, 0)
  })
})

test('a successful RPC with a malformed translation payload is shown as an error', async () => {
  loadPluginState = await loadPlugin()
  const { mounted } = mountPanel({
    translate: () => ({ text: 42, provider: 'bing', cached: false, durationMs: 1 }),
  })
  await flushPanel()
  await typeSource(mounted, 'hello')
  translateButton(mounted.tree).props.onClick()
  await flushPanel()

  const alert = findOne(mounted.tree, (node) => node.props?.role === 'alert', 'the invalid-response alert')
  assert.equal(
    textOf(alert),
    'The translation service answered with something the Harness could not read. Try again.',
  )
  const status = findOne(
    mounted.tree,
    (node) => node.props?.className === 'dshTr-status',
    'the failed request status',
  )
  assert.equal(textOf(status), 'Failed')
  assert.equal(textOf(translateButton(mounted.tree)), 'Retry')
  const region = findOne(mounted.tree, (node) => node.props?.role === 'region', 'the result region')
  assert.equal(region.props['data-empty'], 'true')
  mounted.unmount()
})

test('the provider-unreachable failure is distinct from the carrier failure', async () => {
  loadPluginState = await loadPlugin()
  const failing = (code) => ({
    ok: false,
    error: { code, message: 'a Host diagnostic', details: { provider: 'google' } },
  })
  for (const [code, expected] of [
    [
      'translation-pane/provider-unreachable',
      'The Host could not reach the translation service. Try again, or choose another service.',
    ],
    [
      'translation-pane/offline',
      'The Harness cannot reach its Host. Check that the Host is running, then try again.',
    ],
  ]) {
    const { mounted } = mountPanel({ translate: () => failing(code) })
    await flushPanel()
    await typeSource(mounted, 'hello')
    translateButton(mounted.tree).props.onClick()
    await flushPanel()
    const alert = findOne(mounted.tree, (node) => node.props?.role === 'alert', 'the error alert')
    assert.equal(textOf(alert), expected, `${code} must map onto its own copy`)
  }
})

test('the Format selector sends JSON mode to the Host and explains its boundary', async () => {
  loadPluginState = await loadPlugin()
  let submitted
  const { mounted } = mountPanel({
    translate: (args) => {
      submitted = args
      return { text: '{"message":"你好"}', provider: 'bing', cached: false, durationMs: 1 }
    },
  })
  await flushPanel()
  const format = findOne(
    mounted.tree,
    (node) => node.type === 'select' && String(node.props?.id).endsWith('-format'),
    'the Format selector',
  )
  format.props.onChange({ target: { value: 'json' } })
  await flushPanel()
  assert.match(textOf(mounted.tree), /Only string values are sent to the translation provider/)
  await typeSource(mounted, '{"message":"hello"}')
  translateButton(mounted.tree).props.onClick()
  await flushPanel()

  assert.equal(submitted.format, 'json')
  assert.equal(submitted.text, '{"message":"hello"}')
})


test('the Format selector sends Markdown mode to the Host and explains protected spans', async () => {
  loadPluginState = await loadPlugin()
  let submitted
  const { mounted } = mountPanel({
    translate: (args) => {
      submitted = args
      return { text: '# 你好', provider: 'bing', cached: false, durationMs: 1 }
    },
  })
  await flushPanel()
  const format = findOne(
    mounted.tree,
    (node) => node.type === 'select' && String(node.props?.id).endsWith('-format'),
    'the Format selector',
  )
  format.props.onChange({ target: { value: 'markdown' } })
  await flushPanel()
  assert.match(textOf(mounted.tree), /Markdown mode translates prose while preserving code blocks/)
  assert.match(textOf(mounted.tree), /Markdown \(preserve structure\)/)
  await typeSource(mounted, '# Hello')
  translateButton(mounted.tree).props.onClick()
  await flushPanel()

  assert.equal(submitted.format, 'markdown')
  assert.equal(submitted.text, '# Hello')
})


test('the glossary editor imports JSON and applies it through the Host', async () => {
  loadPluginState = await loadPlugin()
  let submitted
  const { mounted } = mountPanel({
    translate: (args) => ({
      text: 'old-glossary:' + args.text,
      provider: 'bing',
      cached: false,
      durationMs: 1,
    }),
    setGlossary: (args) => {
      submitted = args.payload
      const parsed = JSON.parse(args.payload)
      return {
        glossary: parsed.glossary,
        warnings: [{ code: 'overlapping-terms', message: 'overlap' }],
        count: parsed.glossary.length,
        revision: 1,
      }
    },
  })
  await flushPanel()
  await typeSource(mounted, 'API docs')
  translateButton(mounted.tree).props.onClick()
  await flushPanel()
  const resultRegion = findOne(mounted.tree, (node) => node.props?.role === 'region', 'the result region')
  assert.match(textOf(resultRegion), /old-glossary:API docs/)

  const editor = findOne(
    mounted.tree,
    (node) => node.type === 'textarea' && String(node.props?.className).includes('dshTr-glossaryArea'),
    'the glossary JSON editor',
  )
  const portable = {
    version: 1,
    glossary: [{
      source: 'API',
      target: '接口',
      sourceLanguage: 'en',
      targetLanguage: 'zh-Hans',
      wholeWord: true,
      priority: 5,
    }],
  }
  editor.props.onChange({ target: { value: JSON.stringify(portable, null, 2) } })
  await flushPanel()

  const apply = findOne(
    mounted.tree,
    (node) => node.type === 'button' && textOf(node) === 'Apply glossary',
    'the Apply glossary action',
  )
  apply.props.onClick()
  await flushPanel()

  assert.equal(JSON.parse(submitted).glossary[0].sourceLanguage, 'en')
  const updatedRegion = findOne(mounted.tree, (node) => node.props?.role === 'region', 'the updated result region')
  assert.equal(textOf(updatedRegion).includes('old-glossary:'), false, 'a previous translation must be cleared after glossary activation')
  assert.match(textOf(mounted.tree), /1 glossary warnings need review/)
  assert.match(textOf(mounted.tree), /Overlap/)
})

test('the glossary editor can load a JSON file into its draft', async () => {
  loadPluginState = await loadPlugin()
  const { mounted } = mountPanel()
  await flushPanel()
  const fileInput = findOne(
    mounted.tree,
    (node) => node.type === 'input' && node.props?.type === 'file',
    'the glossary JSON file input',
  )
  fileInput.props.onChange({
    target: {
      files: [{
        size: 100,
        text: async () => JSON.stringify({ version: 1, glossary: [{ source: 'API', target: '接口' }] }),
      }],
      value: 'glossary.json',
    },
  })
  await flushPanel()

  const editor = findOne(
    mounted.tree,
    (node) => node.type === 'textarea' && String(node.props?.className).includes('dshTr-glossaryArea'),
    'the glossary JSON editor',
  )
  assert.deepEqual(JSON.parse(editor.props.value).glossary, [{ source: 'API', target: '接口' }])
})

test('the workbench has deliberate empty/loading states and a progressive glossary disclosure', async () => {
  loadPluginState = await loadPlugin()
  let requestCount = 0
  let finishSecondRequest
  const { mounted } = mountPanel({
    translate: () => {
      requestCount += 1
      if (requestCount === 1) {
        return { text: '你好', provider: 'bing', cached: false, durationMs: 12 }
      }
      return new Promise((resolve) => {
        finishSecondRequest = resolve
      })
    },
  })
  await flushPanel()

  const empty = findOne(
    mounted.tree,
    (node) => node.props?.className === 'dshTr-empty',
    'the result empty state',
  )
  assert.match(textOf(empty), /Your translation will appear here/)

  const glossary = findOne(
    mounted.tree,
    (node) => node.type === 'details' && node.props?.className === 'dshTr-glossaryDetails',
    'the advanced glossary disclosure',
  )
  assert.equal(glossary.props.open, false, 'advanced editing should not crowd the default workbench')

  await typeSource(mounted, 'hello')
  translateButton(mounted.tree).props.onClick()
  await flushPanel()
  assert.equal(requestCount, 1)
  const firstResult = findOne(mounted.tree, (node) => node.props?.role === 'region', 'the result region')
  assert.equal(textOf(firstResult), '你好')

  // Re-running the same source must not leave an old answer visible while the
  // next request is in flight.
  translateButton(mounted.tree).props.onClick()
  await flushPanel()
  const loading = findOne(
    mounted.tree,
    (node) => node.props?.className === 'dshTr-loading',
    'the in-flight translation indicator',
  )
  assert.match(textOf(loading), /Translating/)
  const pendingResult = findOne(mounted.tree, (node) => node.props?.role === 'region', 'the pending result region')
  assert.doesNotMatch(textOf(pendingResult), /你好/)

  const style = findOne(mounted.tree, (node) => node.type === 'style', 'the scoped workbench stylesheet')
  const css = style.props?.dangerouslySetInnerHTML?.__html ?? ''
  assert.match(css, /prefers-reduced-motion/)
  assert.match(css, /@container \(max-width: 720px\)/)

  assert.equal(typeof finishSecondRequest, 'function')
  finishSecondRequest({ text: '再次翻译', provider: 'bing', cached: false, durationMs: 8 })
  await flushPanel()
  const finalResult = findOne(mounted.tree, (node) => node.props?.role === 'region', 'the completed result region')
  assert.equal(textOf(finalResult), '再次翻译')
  mounted.unmount()
})

test('the glossary disclosure uses valid summary content and stays user-toggleable', async () => {
  loadPluginState = await loadPlugin()
  const { mounted } = mountPanel()
  await flushPanel()

  const details = findOne(
    mounted.tree,
    (node) => node.type === 'details' && node.props?.className === 'dshTr-glossaryDetails',
    'the glossary disclosure',
  )
  assert.equal(details.props.open, false)
  const summary = findOne(details, (node) => node.type === 'summary', 'the glossary summary')
  const summaryChildren = summary.children.filter((node) => node && typeof node === 'object')
  assert.ok(summaryChildren.every((node) => node.type === 'span'), 'summary content must remain phrasing markup')
  const heading = findOne(
    summary,
    (node) => node.props?.role === 'heading' && node.props?.['aria-level'] === 3,
    'the accessible glossary heading',
  )
  assert.equal(textOf(heading), 'Terminology glossary')

  details.props.onToggle({ currentTarget: { open: true } })
  await flushPanel()
  let currentDetails = findOne(
    mounted.tree,
    (node) => node.type === 'details' && node.props?.className === 'dshTr-glossaryDetails',
    'the expanded glossary disclosure',
  )
  assert.equal(currentDetails.props.open, true)

  currentDetails.props.onToggle({ currentTarget: { open: false } })
  await flushPanel()
  currentDetails = findOne(
    mounted.tree,
    (node) => node.type === 'details' && node.props?.className === 'dshTr-glossaryDetails',
    'the collapsed glossary disclosure',
  )
  assert.equal(currentDetails.props.open, false)
  mounted.unmount()
})
 
test('malformed Host glossary rows are ignored without marking the Host offline', async () => {
  loadPluginState = await loadPlugin()
  const { mounted } = mountPanel({
    describe: {
      ...HOST_DESCRIBE,
      glossary: [
        null,
        'not-an-entry',
        { source: '', target: 'empty source' },
        { source: 'control' + String.fromCharCode(0) + 'term', target: 'unsafe source' },
        {
          source: ' API ',
          target: ' 接口 ',
          sourceLanguage: '*',
          targetLanguage: 'zh-Hans',
          matchCase: false,
          wholeWord: null,
          enabled: true,
          priority: 0,
        },
      ],
      glossaryWarnings: [
        null,
        'not-a-warning',
        { code: 'unknown-warning' },
        { code: 'overlapping-terms', message: 'ignored remote message' },
      ],
    },
  })
  await flushPanel()

  const status = findOne(
    mounted.tree,
    (node) => node.props?.className === 'dshTr-status',
    'the workbench status',
  )
  assert.equal(textOf(status), 'Ready', 'invalid optional glossary rows must not fail Host metadata refresh')

  const details = findOne(
    mounted.tree,
    (node) => node.type === 'details' && node.props?.className === 'dshTr-glossaryDetails',
    'the glossary disclosure',
  )
  assert.equal(details.props.open, true)
  const count = findOne(
    details,
    (node) => node.props?.className === 'dshTr-glossaryCount',
    'the normalized glossary count',
  )
  assert.equal(textOf(count), '1')

  const editor = findOne(
    details,
    (node) => node.type === 'textarea' && node.props?.className === 'dshTr-glossaryArea',
    'the normalized glossary draft',
  )
  assert.deepEqual(JSON.parse(editor.props.value), {
    version: 1,
    glossary: [{ source: 'API', target: '接口', targetLanguage: 'zh-Hans' }],
  })
  const warnings = findAll(details, (node) => node.type === 'li')
  assert.equal(warnings.length, 1)
  assert.match(textOf(warnings[0]), /Overlapping terms detected/)
  mounted.unmount()
})

test('Host glossary warnings open the advanced glossary section automatically', async () => {
  loadPluginState = await loadPlugin()
  const { mounted } = mountPanel({
    describe: {
      ...HOST_DESCRIBE,
      glossaryWarnings: [{ code: 'overlapping-terms', message: 'overlap' }],
    },
  })
  await flushPanel()

  const details = findOne(
    mounted.tree,
    (node) => node.type === 'details' && node.props?.className === 'dshTr-glossaryDetails',
    'the glossary disclosure',
  )
  assert.equal(details.props.open, true)
  assert.match(textOf(mounted.tree), /Overlapping terms detected/)
  mounted.unmount()
})

test('an imported glossary file finishing after unmount does not update panel state', async () => {
  loadPluginState = await loadPlugin()
  const { mounted } = mountPanel()
  await flushPanel()
  let finishRead
  const read = new Promise((resolve) => {
    finishRead = resolve
  })
  const fileInput = findOne(
    mounted.tree,
    (node) => node.type === 'input' && node.props?.type === 'file',
    'the glossary JSON file input',
  )
  fileInput.props.onChange({
    target: {
      files: [{ size: 20, text: () => read }],
      value: 'glossary.json',
    },
  })
  const schedulesAtUnmount = mounted.scheduleCalls
  mounted.unmount()

  finishRead(JSON.stringify({ version: 1, glossary: [{ source: 'API', target: '接口' }] }))
  await flushPanel()
  assert.equal(mounted.scheduleCalls, schedulesAtUnmount)
})

test('a glossary apply finishing after unmount does not update panel state', async () => {
  loadPluginState = await loadPlugin()
  let finishApply
  const { mounted } = mountPanel({
    setGlossary: () => new Promise((resolve) => {
      finishApply = resolve
    }),
  })
  await flushPanel()
  const apply = findOne(
    mounted.tree,
    (node) => node.type === 'button' && textOf(node) === 'Apply glossary',
    'the Apply glossary action',
  )
  apply.props.onClick()
  await flushPanel()
  const schedulesAtUnmount = mounted.scheduleCalls
  mounted.unmount()

  finishApply({ glossary: [], warnings: [], count: 0, revision: 1 })
  await flushPanel()
  assert.equal(mounted.scheduleCalls, schedulesAtUnmount)
})

test('language and provider controls preserve swap accessibility and direction changes', async () => {
  loadPluginState = await loadPlugin()
  const { mounted } = mountPanel()
  await flushPanel()

  const controlGroup = findOne(
    mounted.tree,
    (node) => node.props?.className === 'dshTr-controls',
    'the translation control group',
  )
  const controls = findAll(controlGroup, (node) => node.type === 'select')
  assert.equal(controls.length, 4, 'source, target, service and format controls stay grouped')

  const source = findOne(
    controlGroup,
    (node) => node.type === 'select' && String(node.props?.id).endsWith('-source'),
    'the source language selector',
  )
  const swap = findOne(
    controlGroup,
    (node) => node.type === 'button' && node.props?.className === 'dshTr-swap',
    'the language swap control',
  )
  const reason = findOne(
    mounted.tree,
    (node) => node.type === 'p' && String(node.props?.className).includes('dshTr-note') && node.props?.id,
    'the swap explanation',
  )
  assert.equal(swap.props['aria-disabled'], 'true')
  assert.equal(swap.props['aria-describedby'], reason.props.id)
  assert.match(swap.props['aria-label'], /Auto detect/)

  source.props.onChange({ target: { value: 'en' } })
  await flushPanel()
  const enabledSwap = findOne(
    mounted.tree,
    (node) => node.type === 'button' && node.props?.className === 'dshTr-swap',
    'the enabled language swap control',
  )
  assert.equal(enabledSwap.props['aria-disabled'], undefined)
  enabledSwap.props.onClick()
  await flushPanel()

  const currentSource = findOne(
    mounted.tree,
    (node) => node.type === 'select' && String(node.props?.id).endsWith('-source'),
    'the updated source language selector',
  )
  const currentTarget = findOne(
    mounted.tree,
    (node) => node.type === 'select' && String(node.props?.id).endsWith('-target'),
    'the updated target language selector',
  )
  assert.equal(currentSource.props.value, 'zh-Hans')
  assert.equal(currentTarget.props.value, 'en')
  mounted.unmount()
})

test('auto-detected source does not offer a no-op swap when it matches the target', async () => {
  loadPluginState = await loadPlugin()
  await withPreferences({ sourceLanguage: 'auto', targetLanguage: 'en' }, async () => {
    const { mounted } = mountPanel({
      translate: () => ({
        text: 'translated text',
        provider: 'bing',
        requestedProvider: 'bing',
        failover: false,
        detectedSourceLanguage: 'en',
      }),
    })
    await flushPanel()
    await typeSource(mounted, 'source text')
    translateButton(mounted.tree).props.onClick()
    await flushPanel()

    const swap = findOne(
      mounted.tree,
      (node) => node.type === 'button' && node.props?.className === 'dshTr-swap',
      'the unavailable language swap control',
    )
    assert.equal(swap.props['aria-disabled'], 'true')
    assert.match(swap.props['aria-label'], /source and target languages are the same/i)

    const reason = findOne(
      mounted.tree,
      (node) => node.type === 'p' && String(node.props?.className).includes('dshTr-note') && node.props?.id,
      'the same-language swap explanation',
    )
    assert.match(textOf(reason), /source and target languages are the same/i)

    swap.props.onClick()
    await flushPanel()
    const source = findOne(
      mounted.tree,
      (node) => node.type === 'select' && String(node.props?.id).endsWith('-source'),
      'the source language selector',
    )
    const target = findOne(
      mounted.tree,
      (node) => node.type === 'select' && String(node.props?.id).endsWith('-target'),
      'the target language selector',
    )
    assert.equal(source.props.value, 'auto')
    assert.equal(target.props.value, 'en')
    mounted.unmount()
  })
})

test('source editor shortcuts submit and cancel through parent-owned request state', async () => {
  loadPluginState = await loadPlugin()
  let submitted
  let requestSignal
  const { mounted } = mountPanel({
    translate: (args, signal) => {
      submitted = args
      requestSignal = signal
      return new Promise(() => {})
    },
  })
  await flushPanel()
  await typeSource(mounted, 'shortcut request')

  let submitPrevented = false
  sourceArea(mounted.tree).props.onKeyDown({
    ctrlKey: true,
    key: 'Enter',
    preventDefault: () => { submitPrevented = true },
    stopPropagation: () => {},
  })
  await flushPanel()

  assert.equal(submitPrevented, true)
  assert.equal(submitted.text, 'shortcut request')
  assert.ok(requestSignal, 'the keyboard shortcut must use the Host translation request')

  let cancelPrevented = false
  let cancelStopped = false
  sourceArea(mounted.tree).props.onKeyDown({
    ctrlKey: false,
    metaKey: false,
    key: 'Escape',
    preventDefault: () => { cancelPrevented = true },
    stopPropagation: () => { cancelStopped = true },
  })
  await flushPanel()

  assert.equal(cancelPrevented, true)
  assert.equal(cancelStopped, true)
  assert.equal(requestSignal.aborted, true, 'Escape must abort the in-flight request')
  mounted.unmount()
})

test('the extracted footer and metadata retain accessible request context', async () => {
  loadPluginState = await loadPlugin()
  const { mounted } = mountPanel()
  await flushPanel()

  const footer = findOne(
    mounted.tree,
    (node) => node.props?.className === 'dshTr-foot',
    'the translation footer',
  )
  const action = findOne(
    footer,
    (node) => node.type === 'button' && String(node.props?.className).split(' ').includes('dshTr-button') && !String(node.props?.className).includes('buttonGhost'),
    'the primary translation action',
  )
  const hint = findOne(footer, (node) => String(node.props?.className).includes('dshTr-hint'), 'the shortcut hint')
  const counter = findOne(footer, (node) => String(node.props?.className).includes('dshTr-counter'), 'the character counter')
  assert.equal(action.props['aria-keyshortcuts'], 'Control+Enter Meta+Enter')
  assert.deepEqual(String(action.props['aria-describedby']).split(' '), [hint.props.id, counter.props.id])
  assert.match(textOf(counter), /0 \/ 20000/)

  const metadata = findOne(
    mounted.tree,
    (node) => node.props?.className === 'dshTr-meta',
    'the translation metadata',
  )
  assert.match(textOf(metadata), /Route: Direct endpoint/)
  assert.match(textOf(metadata), /Service: Bing/)
  mounted.unmount()
})

test('the extracted glossary view forwards draft edits and Host action state', async () => {
  loadPluginState = await loadPlugin()
  const { mounted } = mountPanel()
  await flushPanel()

  const panel = findOne(
    mounted.tree,
    (node) => node.props?.className === 'dshTr-glossary',
    'the glossary panel',
  )
  const details = findOne(panel, (node) => node.type === 'details', 'the glossary disclosure')
  assert.equal(details.props.open, false)

  const editor = findOne(
    panel,
    (node) => node.type === 'textarea' && node.props?.className === 'dshTr-glossaryArea',
    'the glossary editor',
  )
  editor.props.onChange({ target: { value: '{"version":1,"glossary":[]}' } })
  await flushPanel()

  const updatedEditor = findOne(
    mounted.tree,
    (node) => node.type === 'textarea' && node.props?.className === 'dshTr-glossaryArea',
    'the updated glossary editor',
  )
  assert.equal(updatedEditor.props.value, '{"version":1,"glossary":[]}')
  const updatedPanel = findOne(
    mounted.tree,
    (node) => node.props?.className === 'dshTr-glossary',
    'the updated glossary panel',
  )
  const apply = findOne(
    updatedPanel,
    (node) => node.type === 'button' && textOf(node) === 'Apply glossary',
    'the Apply glossary action',
  )
  assert.equal(apply.props.disabled, false, 'a valid draft can be applied when the Host is connected')
  const exportAction = findOne(
    updatedPanel,
    (node) => node.type === 'button' && textOf(node) === 'Copy / export JSON',
    'the Export glossary action',
  )
  assert.equal(exportAction.props.disabled, true, 'an empty active glossary cannot be exported')
  mounted.unmount()
})

test('the extracted header and alert keep offline state visible and recover on reconnect', async () => {
  loadPluginState = await loadPlugin()
  const { mounted, setConnectionState } = mountPanel()
  await flushPanel()

  setConnectionState('disconnected')
  await flushPanel()
  const header = findOne(
    mounted.tree,
    (node) => node.props?.className === 'dshTr-head',
    'the translation header',
  )
  const offlineStatus = findOne(
    header,
    (node) => node.props?.className === 'dshTr-status',
    'the offline status pill',
  )
  assert.equal(offlineStatus.props['data-state'], 'offline')
  assert.equal(textOf(offlineStatus), 'Offline')

  const alert = findOne(
    mounted.tree,
    (node) => node.props?.className === 'dshTr-error' && node.props?.role === 'alert',
    'the offline alert',
  )
  assert.match(textOf(alert), /cannot reach its Host/)
  assert.equal(alert.props.title, undefined)

  setConnectionState('connected')
  await flushPanel()
  const readyStatus = findOne(
    mounted.tree,
    (node) => node.props?.className === 'dshTr-status',
    'the recovered status pill',
  )
  assert.equal(readyStatus.props['data-state'], 'ready')
  assert.equal(textOf(readyStatus), 'Ready')
  assert.equal(
    findAll(mounted.tree, (node) => node.props?.className === 'dshTr-error').length,
    0,
    'the offline alert must disappear after the Host reconnects',
  )
  mounted.unmount()
})

test('format, provider and swap guidance render independently without hiding one another', async () => {
  loadPluginState = await loadPlugin()
  await withPreferences({ provider: 'google' }, async () => {
    const { mounted } = mountPanel({
      describe: {
        ...HOST_DESCRIBE,
        providerHealth: {
          bing: { unreachable: false },
          google: { unreachable: true, reason: 'translation-pane/provider-unreachable' },
        },
      },
    })
    await flushPanel()

    const findFormatNote = () => findOne(
      mounted.tree,
      (node) => node.type === 'p' && node.props?.role === 'note' && String(node.props?.className).includes('dshTr-note'),
      'the format guidance note',
    )
    const format = findOne(
      mounted.tree,
      (node) => node.type === 'select' && String(node.props?.id).endsWith('-format'),
      'the format selector',
    )
    format.props.onChange({ target: { value: 'json' } })
    await flushPanel()
    const initialFormatNote = findFormatNote()
    assert.match(textOf(initialFormatNote), /JSON mode preserves keys/)
    const providerNotice = findOne(
      mounted.tree,
      (node) => node.props?.className === 'dshTr-notice',
      'the provider health notice',
    )
    assert.equal(providerNotice.props.role, 'status')
    assert.match(textOf(providerNotice), /Google service is unavailable/)
    const swapReason = findOne(
      mounted.tree,
      (node) => node.type === 'p' && node.props?.id && String(node.props?.className).includes('dshTr-note') && node.props?.role !== 'note',
      'the language swap explanation',
    )
    assert.match(textOf(swapReason), /Auto detect/)

    format.props.onChange({ target: { value: 'markdown' } })
    await flushPanel()
    assert.match(textOf(findFormatNote()), /Markdown mode translates prose/)
    assert.equal(findAll(mounted.tree, (node) => node.props?.className === 'dshTr-notice').length, 1)

    const source = findOne(
      mounted.tree,
      (node) => node.type === 'select' && String(node.props?.id).endsWith('-source'),
      'the source language selector',
    )
    source.props.onChange({ target: { value: 'en' } })
    await flushPanel()
    assert.equal(
      findAll(mounted.tree, (node) => node.type === 'p' && node.props?.id && String(node.props?.className).includes('dshTr-note') && node.props?.role !== 'note').length,
      0,
      'selecting a concrete source language should remove swap-only guidance',
    )
    assert.equal(findAll(mounted.tree, (node) => node.props?.className === 'dshTr-notice').length, 1)
    mounted.unmount()
  })
})


test('auto-detected source swaps to the detected language and carries the translation back', async () => {
  loadPluginState = await loadPlugin()
  await withPreferences({ sourceLanguage: 'auto', targetLanguage: 'zh-Hans' }, async () => {
    const { mounted } = mountPanel({
      translate: () => ({
        text: 'translated text',
        provider: 'bing',
        requestedProvider: 'bing',
        failover: false,
        detectedSourceLanguage: 'en',
      }),
    })
    await flushPanel()
    await typeSource(mounted, 'original source')
    translateButton(mounted.tree).props.onClick()
    await flushPanel()

    const swap = findOne(
      mounted.tree,
      (node) => node.type === 'button' && node.props?.className === 'dshTr-swap',
      'the enabled Auto-detect direction swap',
    )
    assert.equal(swap.props['aria-disabled'], undefined)
    swap.props.onClick()
    await flushPanel()

    const sourceLanguage = findOne(
      mounted.tree,
      (node) => node.type === 'select' && String(node.props?.id).endsWith('-source'),
      'the reversed source language selector',
    )
    const targetLanguage = findOne(
      mounted.tree,
      (node) => node.type === 'select' && String(node.props?.id).endsWith('-target'),
      'the reversed target language selector',
    )
    assert.equal(sourceLanguage.props.value, 'zh-Hans')
    assert.equal(targetLanguage.props.value, 'en')
    assert.equal(sourceArea(mounted.tree).props.value, 'translated text')
    mounted.unmount()
  })
})

test('Meta+Enter submits through the same workbench translation action', async () => {
  loadPluginState = await loadPlugin()
  let submitted
  const { mounted } = mountPanel({
    translate: (args) => {
      submitted = args
      return { text: 'meta translated', provider: 'bing', requestedProvider: 'bing', failover: false }
    },
  })
  await flushPanel()
  await typeSource(mounted, 'meta shortcut request')

  let prevented = false
  sourceArea(mounted.tree).props.onKeyDown({
    ctrlKey: false,
    metaKey: true,
    key: 'Enter',
    preventDefault: () => { prevented = true },
    stopPropagation: () => {},
  })
  await flushPanel()

  assert.equal(prevented, true)
  assert.equal(submitted.text, 'meta shortcut request')
  const result = findOne(mounted.tree, (node) => node.props?.role === 'region', 'the translated result region')
  assert.match(textOf(result), /meta translated/)
  mounted.unmount()
})

test('connection lifecycle clears offline during reconnect and ignores duplicate snapshots', async () => {
  loadPluginState = await loadPlugin()
  let descriptions = 0
  const { mounted, setConnectionState } = mountPanel({
    describe: () => {
      descriptions += 1
      return { ...HOST_DESCRIBE, maxTextChars: 4321 }
    },
  })
  await flushPanel()
  assert.equal(descriptions, 1)

  setConnectionState('disconnected')
  await flushPanel()
  assert.match(textOf(mounted.tree), /Offline/)
  assert.equal(descriptions, 1)

  setConnectionState('disconnected')
  await flushPanel()
  assert.equal(descriptions, 1, 'a duplicate disconnected snapshot must not do extra work')

  setConnectionState('connecting')
  await flushPanel()
  const connectingStatus = findOne(
    mounted.tree,
    (node) => node.props?.className === 'dshTr-status',
    'the connecting status pill',
  )
  assert.equal(connectingStatus.props['data-state'], 'connecting')
  assert.match(textOf(connectingStatus), /Connecting/)
  assert.equal(
    findAll(mounted.tree, (node) => node.props?.className === 'dshTr-error').length,
    0,
    'the stale offline alert must clear while the Host is actively reconnecting',
  )

  setConnectionState('connecting')
  await flushPanel()
  assert.equal(descriptions, 1, 'a duplicate connecting snapshot must not start a Host read')

  setConnectionState('connected')
  await flushPanel()
  assert.equal(descriptions, 2, 'a real transition to connected must refresh Host facts')
  assert.ok(textOf(mounted.tree).includes('/ 4321'))
  mounted.unmount()
})
