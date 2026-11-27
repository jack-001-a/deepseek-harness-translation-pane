# Browser client architecture

The browser entry point is intentionally distributed as one `client.js` file.
DeepSeek Harness loads it through `window.__ModuleLoader__.load()` and provides
React through the factory's `require('react')`. The shipped runtime must not
depend on relative browser imports or on a second network-loaded asset.

## Source layout

The editable source lives in `src/client/`. The numbered files are ordered
source parts, not standalone ES modules. The build script inserts them in order
inside the existing ModuleLoader factory, so they share the factory's lexical
scope and have no runtime import graph.

| Part | Responsibility |
|---|---|
| `00-contracts.part.js` | Locale dictionaries, language/provider catalogs, error and visual contracts, stylesheet |
| `10-host-runtime.part.js` | Host RPC boundary, preference persistence, glossary normalization, option and clipboard utilities |
| `20-state-hooks.part.js` | Locale, Host connection, translation request, glossary editor and provider-presentation state |
| `30-components.part.js` | Reusable controls, editor/result cards, status, notices, footer, metadata and glossary views |
| `40-workbench.part.js` | Workbench composition, responsive page observer, sidebar icon and plugin registration |

Add new parts to the explicit ordered list in `scripts/build-client.mjs`. Keep
shared declarations in the factory scope; do not introduce `import` or
`export` statements into a part.

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
