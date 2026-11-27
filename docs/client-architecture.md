# Browser client architecture

The browser entry point is intentionally distributed as one `client.js` file.
DeepSeek Harness loads it through `window.__ModuleLoader__.load()` and provides
React through the factory's `require('react')`. The shipped runtime must not
depend on relative browser imports or on a second network-loaded asset.

## Source layout

The editable source lives in `src/client/`. The numbered `.part.js` files are
ordered closure fragments, while `domain.js` is a real dependency-free ES
module. The browser build strips only the named `export` declarations from
that domain module and inlines its declarations before the ordered fragments.
This lets tests import domain rules directly while the browser still has no
runtime module graph.

| Part | Responsibility |
|---|---|
| `00-contracts.part.js` | Locale dictionaries, language/provider catalogs, error and visual contracts, stylesheet |
| `domain.js` | Importable pure rules for glossary validation, catalog de-duplication, status precedence and language swapping |
| `10-host-runtime.part.js` | Host RPC boundary, preference persistence, option and clipboard utilities |
| `20-state-hooks.part.js` | Locale, Host connection, translation request, glossary editor and provider-presentation state |
| `30-components.part.js` | Reusable controls, editor/result cards, status, notices, footer, metadata and glossary views |
| `40-workbench.part.js` | Workbench composition, responsive page observer, sidebar icon and plugin registration |

Add new fragments to the explicit ordered list in `scripts/build-client.mjs`.
Inline modules must be listed in `INLINE_MODULES`, have no imports, and expose
only named top-level `const` or function declarations. Test importable domain
rules from their original ES module rather than testing generated copies.

## Build and validation

After editing a source part:

```bash
npm run build:client
npm run check
npm test
```

The build has no third-party dependency and produces deterministic output.
`npm run check` compares the committed `client.js` with the assembled source
and then syntax-checks the generated bundle. `prepack` repeats the freshness
check before an npm archive can be created.

Both the source parts and builder are included in the package for traceability
and reproducible maintenance; Harness still loads only `client.js`.


### Language and provider controls

`useLanguageControls` owns the Host-advertised language/provider option lists, localized service labels, provider health/failover notices, and direction-switch semantics. `TranslationPane` passes it the current Host and translation facts, then renders the returned view model. This keeps the rendering component from reimplementing catalog or swap rules and makes the detected-language reverse-translation path easier to exercise through focused UI tests.


### Workbench actions

`useTranslationWorkbenchActions` owns the source editor handlers, clear/copy behavior, clipboard feedback timer and keyboard shortcuts. It receives the current source, preferences and the request hook's `run`/`cancel` actions; it does not own transport or translation request state. This keeps keyboard and editor behavior consistent between the visible buttons and shortcuts while leaving `TranslationPane` responsible for composing views.


### Host connection transitions

`useHostConnection` tracks the last observed connection snapshot. Duplicate notifications do not issue duplicate `describe()` RPCs. A transition to `connecting` invalidates any in-flight metadata read and clears the stale offline alert while keeping the panel in its connecting state; a transition to `disconnected` remains explicitly offline, and only a subsequent `connected` transition starts a fresh Host description.


### Glossary mutation lifecycle

The glossary editor owns an AbortController for its active Host mutation. Unmounting the panel aborts that RPC, and the same controller ref closes the same-turn duplicate-submit window before React publishes the busy state. A late response is ignored after cancellation.


### Shared preferences and imports

Translation preferences live in a factory-scoped shared snapshot and notify every mounted panel when one field changes. Persistence writes the merged current snapshot, so one panel cannot overwrite a sibling panel's newer preference with stale fields. Glossary imports use a monotonically increasing request sequence: the most recently selected file wins even when an earlier file read resolves later, and unmount invalidates outstanding reads.


Preference changes are also synchronized between same-origin browser tabs through one shared `storage` listener per plugin context. The listener is installed while at least one panel is mounted, filters unrelated storage areas and keys, normalizes incoming snapshots and is removed after the last panel unmounts. Incoming events update local subscribers without writing back to storage.


### Shared Host connection lifecycle

Host metadata is stored once per plugin factory and broadcast to each mounted panel. The factory holds one connection-state subscription and deduplicates concurrent `describe()` calls. Disconnect/reconnect transitions update every panel from the same snapshot; a panel unmount does not cancel shared work while another panel remains mounted, and the last unmount removes the subscription and aborts the active description.


Post-translation metadata reads supersede an older initial description, while simultaneous refreshes triggered by sibling panels share the same fresh request. This preserves the latest-result-wins guarantee without multiplying requests after a multi-panel translation completes.
