# @ybbmm/dsh-translation-pane

A translation workbench for DeepSeek Harness: one sidebar entry, one full-width
translation page, and a `translate_text` tool for the agent.

Published as [`@ybbmm/dsh-translation-pane`](https://www.npmjs.com/package/@ybbmm/dsh-translation-pane)
on npm and on [GitHub](https://github.com/jack-001-a/deepseek-harness-translation-pane).

## What it adds

| Where | What |
|---|---|
| Sidebar panel rail | A **Translation** icon that opens the page in the main column |
| Translation page | Source/target language pickers, provider picker, source and result cards, a swap action, copy, clear, a live character counter, and `Ctrl+Enter` to translate |
| Failover | Falls over to the other anonymous provider when the selected one is unreachable, and says which service served the text |
| Agent tool | `translate_text(text, targetLanguage, sourceLanguage?, format?)` returning the translation |

The language, provider and format choices are remembered in the page's local storage.

Choose **JSON values only** in the Format selector to translate JSON safely. The parser validates the document, leaves object keys and all non-string values untouched, and translates only string values. It preserves the original JSON whitespace and layout rather than reserializing the document.

Choose **Markdown (preserve structure)** to translate prose while keeping fenced and inline code, Markdown link destinations and syntax, bare URLs, template placeholders, HTML tags, entities and common block prefixes out of provider requests. Link labels and ordinary prose are translated; protected source spans are reassembled unchanged and in their original order. This is a conservative Markdown lexer, not a full CommonMark parser, so project-specific extensions or unusual nested link syntax may need additional coverage. The agent tool accepts the same opt-in `format: "markdown"` argument. The default remains plain text.

Configure a **Glossary** in the profile patch to keep product names, technical vocabulary and preferred wording consistent. The original `{ source, target }` array remains supported. Advanced entries can scope a term to `sourceLanguage` / `targetLanguage`, choose case-sensitive or whole-word/substring matching, set `priority`, or disable an entry. Higher priority wins; ties use longest-match order. Duplicate conflicting source terms in one language pair are rejected, while overlapping terms are reported as warnings.

The page includes a glossary JSON editor with file import, live apply and JSON export. Import accepts the versioned `{ "version": 1, "glossary": [...] }` format or the legacy bare array. Applying changes invalidates the translation cache and affects the current Host session; add the exported terms to the profile patch to keep them after a Host restart. A source-language scope only matches that language (including regional subtags); when the request source is `auto`, only wildcard or `auto` rules apply, so the plugin never guesses a language-specific glossary.

## How translation runs

The Host half prefers the shipped `ctx.translator` service when the
composition mounts it — that service owns provider routing, request limits and
Session-bound result reuse. When it is absent, the Host half speaks the
Microsoft Edge and Google Translate endpoints directly. Both routes are
anonymous: no login, no API key, no Session.

`describe()` reports which route is live and **which providers that route can
actually serve**, so the page never offers a provider the active route cannot
use. It is deliberately synchronous: the shipped translator's
`availableProviders()` can await credential and model discovery for up to its
own 60-second deadline, which would leave the panel stuck on its first paint.

### Provider failover and health

The two anonymous endpoints are independent services, and a network that can
reach one may be unable to reach the other. The direct route therefore treats a
provider-level failure as a routing problem rather than a dead end:

- **What fails over.** A transport/connect error, the per-attempt header
  deadline, HTTP `429` and HTTP `5xx` prove the provider itself is unhealthy, so
  the fragment is handed to the other provider **once**. A `4xx`, a `200` whose
  body cannot be read, and the local rate limiter never fail over: none of them
  is fixed by asking a different provider.
- **What it costs.** `attemptTimeoutMs` (default `3000`) bounds the wait for
  response headers, so a dead provider is abandoned quickly. A provider that
  *does* answer may keep streaming under the whole-request deadline.
- **What is remembered.** A provider that failed is avoided for
  `providerCooldownMs` (default five minutes). Later requests go straight to the
  healthy provider instead of probing the dead one again, and `describe()` shows
  the observation as plain serializable data under `providerHealth`. A provider
  that recovers is retried automatically once its cooldown expires.
- **What is reported.** A result names a provider that actually served it in
  `provider`, and adds `requestedProvider` and `failover`. A long text may be
  split and answered by both providers; `failover` is then still `true`, and
  `providersServed` lists every service that answered. Cache entries keep the
  same facts, so a cache hit does not pretend the requested provider answered.
  The page names the services in the meta line, says which service served the
  text after a failover, and warns when the selected service is known to be
  unavailable.

The shipped-translator route owns its own routing, so it stays single-provider
here: the pane does not invent a cross-provider retry on top of it.

### Resilience

The anonymous endpoints rate-limit, return `5xx` and occasionally hang. The
Host therefore:

- **fails over** a provider-level fault to the other anonymous provider once,
  with a short per-attempt header deadline (`attemptTimeoutMs`) and a cooldown
  (`providerCooldownMs`) that keeps later requests off a provider known to be
  dead. See [Provider failover and health](#provider-failover-and-health).
- **retries** transient failures only — network errors, HTTP `429` and HTTP
  `5xx` — with exponential back-off and jitter, honouring a `Retry-After`
  header. Every other `4xx` fails immediately instead of burning the budget.
  The retry budget applies when a second provider is not available (the
  shipped-translator route, or `failover: false`); with two providers each is
  tried once, because the other provider is the better retry.
- **caps** the response body, so a broken or hostile endpoint cannot stream
  unbounded bytes into memory.
- **deadlines** every provider call, on both the direct and the translator
  route: a per-attempt header deadline plus one deadline for the whole request.
- **rate-limits** itself with a token bucket, so a burst of panel requests
  cannot hammer the provider. When the bucket is empty the request fails fast
  with `translation-pane/rate-limited` rather than queueing without bound.
- **caches** finished translations in a bounded LRU keyed by provider, language
  pair and source text, and **coalesces** identical concurrent requests into
  one provider call.
- **cancels** cleanly: the agent tool's cancellation signal and the service's
  own lifetime both abort an in-flight request.
- **invalidates on edits.** Changing the source while a translation is running
  aborts that request, clears the previous result and ignores any late
  response, so an answer cannot appear beside text that was not submitted.

Fragments of one long document are dispatched with bounded concurrency rather
than one at a time, so a large input is not many times slower than it needs to
be.

### Long input

Input longer than `maxTextChars` is split on paragraph, then line, then
sentence, then word boundaries before dispatch, and the fragments are rejoined
so the result matches the source structure exactly. Text beyond the limit is
refused with a readable message instead of being truncated silently.

### Privacy and third-party data handling

The plugin does not make translation local. Unless the shipped Harness
translator is selected and configured to use a different provider, the direct
route sends only fragments that remain after local glossary replacement and
format-specific structural filtering to the selected anonymous Microsoft
Edge/Bing or Google Translate endpoint. The provider that serves a fragment
may differ from the requested provider when failover is enabled. A long document can be sent
as several fragment requests, and a single document can be served by both
providers.

- **What leaves the Host.** In plain-text mode, only unmatched text segments
  are sent; configured glossary source terms are replaced locally with their
  preferred target wording. The source-language hint (when supplied), target
  language and protocol metadata are also sent. In JSON mode, only decoded
  string-value segments that are not matched by the glossary are sent; object
  keys, structural punctuation, whitespace, numbers, booleans and null remain
  local. In Markdown mode, only prose segments are sent; code, URLs, link
  destinations, placeholders, HTML tags and Markdown syntax stay local. Do not submit secrets,
  credentials, personal data or confidential source code unless the user is
  authorized to disclose them to that provider.
- **Who receives it.** Microsoft receives requests routed to the Edge/Bing
  endpoint; Google receives requests routed to Google Translate. The
  `ctx.translator` route follows the provider and account configuration of
  the Harness translator service. The plugin cannot verify or guarantee the
  providers' retention, review, training or processing policies; anonymous
  requests are not a promise of zero logging or zero retention.
- **Failover.** With the direct route and `failover: true`, a provider-level
  failure can cause the same fragment to be sent to the other provider. The
  result reports `provider`, `requestedProvider`, `failover` and, for
  mixed-provider long documents, `providersServed`.
- **Local storage.** Completed translations may be kept in the bounded in-memory
  LRU cache for the lifetime of this Host service. The cache is not a durable
  translation history and is discarded when the service unloads or restarts.
  Language, provider and format preferences are stored in the browser's local storage;
  source and translated text are not stored there by this plugin.
- **Logs.** The Host never logs source or translated content. Log records carry
  operational diagnostics only, such as provider names, lengths, ids and
  counters. Provider-side logging is outside the plugin's control.
- **Control.** Set `failover: false` to prevent automatic cross-provider
  fallback on the direct route. Configure only approved endpoints, or disable
  this plugin/tool where external processing is not permitted. The shipped
  translator route follows its own provider configuration and policy.

The `translate_text` agent tool's description also states that it sends the
unmatched text segments to an external machine-translation provider; configured
glossary matches are substituted locally. Applications should make this data
flow clear before users submit sensitive material.

## The panel and the tool share one code path

Both callers reach the same Host method, so a failure, a language tag, or a
limit behaves identically whether it came from the page or from the model. The
page reaches it over the shared connection RPC on `translationPane/describe`
and `translationPane/translate`; the tool calls the same service object
in-process.

That includes routing: the tool gets the same failover, and its output carries
the same additive `provider` / `requestedProvider` / `failover` facts (plus
`providersServed` when a split demand was answered by both), so it can tell the
user which service answered. Both paths surface the same stable error codes; no
raw diagnostic text reaches the page.

## The wire contract

The API Gateway derives a Remote method's wire fields from the method's
**parameter names**, rejects any argument the descriptor does not name, and
calls the method positionally in that order. Two consequences matter when
maintaining this plugin:

- A Remote method's signature must be plain identifiers — no default value,
  no destructuring, no rest parameter. The Gateway parses the signature as
  text and refuses anything else with `gateway/signature-invalid`.
- A trailing parameter named `signal` is the cancellation slot: the Gateway
  injects the caller's `AbortSignal` there, which is how the page's Cancel
  button aborts the Host request and not just the browser-side promise.

`translate` therefore declares both the flat and the nested request shape, so
the page and the in-process tool can share one entry point. The contract is
pinned by `test/gateway-contract.test.mjs`, which re-implements the Gateway's
own derivation, validation and dispatch and drives the real Host with the
payload the browser sends.

## Error codes

The Host answers with stable codes and the page localizes them, so a failure
never surfaces a raw diagnostic string.

| Code | Meaning |
|---|---|
| `translation-pane/invalid-request` | Malformed request (defensive) |
| `translation-pane/text-limit` | The text exceeds the configured limit |
| `translation-pane/provider-unavailable` | The selected provider cannot serve this request |
| `translation-pane/provider-unreachable` | The Host could not reach the provider over the network |
| `translation-pane/timeout` | The provider did not answer within the deadline |
| `translation-pane/rate-limited` | The local rate limiter refused the request |
| `translation-pane/provider-error` | The provider answered with an error status |
| `translation-pane/invalid-response` | The provider answered with an unusable body |
| `translation-pane/offline` | The Harness is not connected to its Host (carrier failure only) |

The Host raises `provider-unreachable` when its own network cannot reach the
provider, while `offline` is the browser losing its Host. Keeping them apart
matters: only the second one is fixed by checking that the Host is running.

## Accessibility

- The result is an atomic live region, so a screen reader announces a new
  translation as one sentence.
- Every control has a programmatic label. The counter and the keyboard hint are
  associated with the editor through `aria-describedby`, and the Translate
  action also describes the counter so an over-limit refusal is heard.
- An over-limit source is marked with `aria-invalid`, and the result region is
  announced even when the user never focuses it.
- Both text surfaces declare `dir="auto"`, so right-to-left source text and
  translations render in the correct direction.
- The in-flight request can be cancelled from the keyboard, and the shortcut
  is advertised with `aria-keyshortcuts`.
- Focus rings are visible on every interactive element, and the design uses
  only `--dsw-alias-*` theme tokens, so light and dark themes follow the app.

## Config

Tunables live in the profile patch so they survive upgrades. Every key is
optional — the Host falls back to the documented default when a key is absent
or invalid.

```yaml
- id: ybbmm-dsh-translation-pane
  name: '@ybbmm/dsh-translation-pane'
  config:
    bingEndpoint: https://edge.microsoft.com/translate/translatetext
    googleEndpoint: https://translate.googleapis.com/translate_a/single
    timeoutMs: 20000
    attemptTimeoutMs: 3000
    providerCooldownMs: 300000
    failover: true
    maxTextChars: 20000
    fragmentChars: 3000
    maxRetries: 2
    retryBaseMs: 250
    retryMaxMs: 4000
    maxResponseBytes: 1048576
    cacheSize: 64
    rateLimitPerMinute: 60
    maxConcurrency: 3
    glossary:
      # Legacy, language-agnostic form remains supported.
      - source: DeepSeek API
        target: 深度求索接口
      # Advanced form: language pair, matching rules and priority.
      - source: API
        target: 接口
        sourceLanguage: en
        targetLanguage: zh-Hans
        matchCase: false
        wholeWord: true
        priority: 10
        enabled: true
```

| Key | Default | Meaning |
|---|---|---|
| `bingEndpoint` | the Edge endpoint | Anonymous Bing-compatible endpoint |
| `googleEndpoint` | the Google endpoint | Anonymous Google-compatible endpoint |
| `timeoutMs` | `20000` | Deadline for the whole request, fragments included |
| `attemptTimeoutMs` | `3000` | Wait for one provider to start answering (response headers); capped by `timeoutMs` |
| `providerCooldownMs` | `300000` | How long a provider that failed is avoided; `0` disables the observation window |
| `failover` | `true` | Let a fragment fall over to the other direct provider once |
| `maxTextChars` | `20000` | Largest input accepted for one request |
| `fragmentChars` | `3000` | Provider-sized fragment length |
| `maxRetries` | `2` | Retries for transient failures only; used when no second provider is available |
| `retryBaseMs` | `250` | First back-off delay |
| `retryMaxMs` | `4000` | Ceiling of the back-off delay |
| `maxResponseBytes` | `1048576` | Largest provider response accepted |
| `cacheSize` | `64` | Bounded LRU of finished translations; `0` disables it |
| `rateLimitPerMinute` | `60` | Token bucket across all callers |
| `maxConcurrency` | `3` | Fragments of one long request in flight at once |
| `glossary` | `[]` | Up to 128 terms; each source/target is at most 128 characters. Supports language scopes, case/whole-word rules, priorities and enabled flags. Matched source terms stay local |


Glossary entry fields:

| Field | Default | Meaning |
|---|---|---|
| `source`, `target` | required | Source term and preferred target wording |
| `sourceLanguage`, `targetLanguage` | `*` | `*` matches every language; a BCP-47 tag also matches regional subtags |
| `matchCase` | `false` | Match exact letter case when `true` |
| `wholeWord` | inferred | Omit to infer ASCII boundaries; `true` requires whole-word boundaries, `false` allows substring matches |
| `priority` | `0` | Integer from `-1000` to `1000`; higher values win before longest-match ordering |
| `enabled` | `true` | Set to `false` to retain an entry without applying it |

The portable JSON format is:

```json
{
  "version": 1,
  "glossary": [
    {
      "source": "API",
      "target": "接口",
      "sourceLanguage": "en",
      "targetLanguage": "zh-Hans",
      "wholeWord": true,
      "priority": 10
    }
  ]
}
```

The editor's **Import JSON file** reads this format (and the legacy array); **Apply glossary** validates and activates it for the current Host session; **Copy / export JSON** copies the active terms in the portable format. Overlap warnings are non-fatal and deterministic. Conflicting duplicate source terms in the same language scope block import until resolved.

## Install

From the plugin market: search for **Translation Pane**, or add it by name:

```bash
dsh plugin add @ybbmm/dsh-translation-pane
```

From a local directory (development):

```bash
dsh plugin add ./dsh-translation-pane
```

Restart the Harness if your profile does not hot-reload plugin bundles.

## Layout and scrolling

The page fills the main column and is itself the scroll container, so a short
window scrolls instead of clipping the lower controls. Each text card is capped
at `45vh` (never below 264px): a long translation scrolls inside its own card
rather than stretching the page, and the source textarea scrolls internally
once the input outgrows the card.

## Development

```bash
npm test        # node --test
```

The fast unit suite uses a fake Cordis context and a stubbed `fetch`; it needs
no Harness installation and no network. Pull requests also run a separate
real-runtime compatibility matrix against pinned DeepSeek Harness
`0.2.2-rc.4` and `0.2.2-rc.5` revisions. See
[Harness runtime compatibility](docs/harness-runtime-compatibility.md) for
the exact scope and limits of that evidence.

## Known limitations

- The anonymous endpoints are not supported third-party APIs. They can
  rate-limit, change their response shape, or be unreachable from a given
  network. Failover keeps a translation working when one of them is, but it is
  still only two providers: when both are down, the request fails honestly.
- A provider's observed health is in-memory and per service instance. A restart
  forgets it, and the first request after a provider becomes unreachable pays
  one bounded attempt (`attemptTimeoutMs`) before the failover answers.
- UI copy is English and Simplified Chinese only; the language dropdown labels
  follow the active UI locale through the same two-language choice.
- Machine translation can alter Markdown or code examples. The source text is
  never modified.
- The cache is in-memory only and does not survive a restart, and a cached
  result keeps the provider and failover facts of the request that produced it.

## License

MIT
