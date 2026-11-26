# Changelog

All notable changes to `@ybbmm/dsh-translation-pane` are documented here.
The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/)
and the project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## Unreleased

### Added

- Add opt-in Markdown translation for the panel and `translate_text` tool.
  The Host translates prose while preserving code blocks, inline code, link
  destinations, URLs, placeholders, HTML tags, entities and common Markdown
  syntax, then reassembles the original document structure.
- Add an optional, bounded terminology glossary with source/target language
  scopes, case/whole-word controls, per-term priority, enabled flags and
  deterministic overlap diagnostics. Matched source terms are substituted
  locally and are not sent to translation providers.
- Add versioned JSON glossary import/export and live Host-session activation;
  glossary changes invalidate cached translations and cancel in-flight work.
- Add the `dsh-translation-glossary` CLI for CI validation, structured diagnostics and local replacement previews; previews make no provider requests.
- Add glossary revision diffing to report added, removed, changed and reordered rules with machine-readable output.
- Add a glossary match explanation command with occurrence offsets, overlap blockers, language-scope and boundary diagnostics, and a local preview.
- Add glossary coverage auditing for sample corpora, including active, unused, shadowed and out-of-scope rule counts with JSON output.
- Add optional audit CI failure policies for unused, shadowed, pattern-mismatched and out-of-scope rules.
- Emit GitHub Code Scanning-compatible SARIF 2.1.0 reports and add a reusable glossary-audit composite action.
- Add safe glossary normalization to a separate output file and emit GitHub Actions annotations plus a Job Summary.
- Add versioned glossary quality policies with coverage and finding thresholds for CLI and GitHub Actions.
- Publish a JSON Schema 2020-12 definition for quality policy files and editor validation.
- Add a standalone `policy validate` command to check quality policy files without running a glossary audit.
- Add strict, balanced and permissive quality policy starter presets with safe non-overwriting file creation.
- Clarify overlap precedence: earliest source position wins, then per-position priority, match length and original entry order.


### Fixed

- Require integer values for integer-valued configuration options, so fractional
  values fall back to documented defaults instead of flooring to zero.
- Reject provider endpoint URLs containing user information or fragments, in
  line with the configuration contract.
- Honor valid `Retry-After` delays independently of the local exponential
  back-off ceiling, while keeping the whole-request deadline authoritative.

### Changed

- Extract the Host cache, provider-health and token-bucket primitives into a
  dependency-free internal module, with focused unit tests and explicit npm
  package inclusion. Runtime behavior and public APIs remain unchanged.

- Move Markdown-aware text splitting and JSON string-value token scanning into
  a dependency-free Host text-processing module, retaining the existing
  `splitText` entrypoint export.

## [1.3.0] — 2026-11-21

### Added

- Add opt-in JSON translation mode for the panel and `translate_text` tool. Only
  JSON string values are sent to the selected provider; object keys, numbers,
  booleans, null values, nesting, and original whitespace remain unchanged.
- Add real DeepSeek Harness compatibility checks against pinned 0.2.2-rc.4 and
  0.2.2-rc.5 revisions.

### Changed

- Disclose external provider processing, the request data sent to Microsoft or
  Google, and the possibility of cross-provider failover before sensitive text
  is submitted.
- Keep inline code, template placeholders, HTML/XML tags, Markdown links,
  URLs, fences, and Unicode grapheme clusters intact at fragment boundaries
  whenever they fit within the provider request limit.

### Fixed

- Stop dispatching queued fragments after a provider request fails; allow
  already-running fragments to settle before returning the failure.
- Harden cancellation, request coalescing, timeout handling, and service unload
  so abandoned or late work cannot publish stale translations or cache entries.
- Reject oversized JSON input before parsing or contacting a provider.


## [1.2.1] — 2026-11-18

### Fixed

- Editing the source during a translation now aborts the in-flight request,
  clears the result associated with the previous text, and ignores late
  responses. A stale translation can no longer appear beside newly edited
  source text.

## [1.2.0] — 2026-10-23

### Added

- **Automatic provider failover.** The direct route no longer gives up when the
  selected anonymous provider is unreachable. A provider-level fault — a
  transport error, the header deadline, HTTP `429` or HTTP `5xx` — hands the
  fragment to the other provider once, so a network that cannot reach one
  endpoint still translates. A `4xx`, an unreadable `200` body or the local rate
  limiter never cause a failover: none of them is evidence about the provider.
- **A per-attempt transport deadline.** `attemptTimeoutMs` (default `3000`)
  bounds the wait for response headers. A provider that never starts answering
  can no longer consume the whole request deadline while a healthy provider is
  available; the body of a provider that did answer keeps the request deadline.
- **Provider health.** A provider that failed a provider-level fault is avoided
  for `providerCooldownMs` (default five minutes), so later requests go straight
  to the healthy one instead of paying the same failure again. A recovered
  provider is retried once its cooldown expires. The state is per service
  instance, never persisted, and cleared on unload.
- **Routing facts.** A translation reports a provider that actually served it in
  `provider`, plus `requestedProvider` and `failover`. A long demand whose
  fragments were answered by different providers is still reported truthfully:
  `failover` is `true` and `providersServed` lists every service that answered.
  Cache entries replay the same facts, so a cache hit is still truthful.
  `describe()` reports `providerHealth` as plain serializable data and a
  `failover` capability flag; neither probes the network.
- **A panel notice.** The page warns when the Host already knows the selected
  service is unreachable, names the service that served the text after a
  failover, and says when more than one service answered a long text, in both
  English and Chinese.

### Changed

- Provider transport failures now use their own
  `translation-pane/provider-unreachable` code. `translation-pane/offline` is
  reserved for the browser losing its Host, so the page no longer tells a user
  to check the Host when the provider (not the Harness) is unreachable.
- With two providers available, each is tried once: the second provider is a
  better retry than repeating the endpoint that just failed. The retry budget
  still applies when only one provider can serve the request (`failover: false`,
  or the shipped-translator route).
- The splitter no longer cuts a UTF-16 surrogate pair in half, so an emoji on a
  fragment boundary survives the round trip.
- The panel marks an over-limit source with `aria-invalid`, describes the
  Translate action with the character counter, declares `dir="auto"` on both
  text surfaces for right-to-left content, and announces the result as one
  atomic sentence.
- A `describe()` retry that settles after the panel unmounted no longer updates
  it.
- **Published release.** The bundle is now released as
  `@ybbmm/dsh-translation-pane` on npm, with its source on
  [GitHub](https://github.com/jack-001-a/deepseek-harness-translation-pane).
  The earlier `@local/` scope was a development-only placeholder.

## [1.1.0]

### Added

- **Stable error codes.** Every failure now carries a `translation-pane/*` code
  and the `isDSHRemoteError` marker, so the page localizes the failure
  instead of showing a raw diagnostic string.
- **Retries with back-off.** Transient failures — network errors, HTTP `429`
  and HTTP `5xx` — are retried with exponential back-off and jitter, and a
  `Retry-After` header is honoured. Other `4xx` responses fail immediately.
- **Response size cap.** A provider response larger than `maxResponseBytes` is
  refused instead of being buffered without bound.
- **Cache and request coalescing.** Finished translations are kept in a
  bounded LRU keyed by provider, language pair and source text; identical
  concurrent requests share one provider call.
- **Rate limiting.** A token bucket caps provider requests per minute across
  all callers; an exhausted bucket fails fast with
  `translation-pane/rate-limited`.
- **Cancellation.** The agent tool's cancellation signal and the service's own
  lifetime abort an in-flight request.
- **Bounded fragment concurrency.** A long document is dispatched with several
  fragments in flight at once instead of strictly one after another.
- **A test suite.** `npm test` runs the Host half against a fake Cordis
  context and a stubbed `fetch`, the browser half against a React stand-in,
  and the wire contract against a port of the API Gateway's own argument
  rules.

### Changed

- The page sources its character limit from the Host instead of assuming
  `4000`, which contradicted the Host's own limit.
- The page's result is a live region, so a screen reader announces a new
  translation; the controls are programmatically labelled and the counter and
  the keyboard hint are associated with the editor.
- The in-flight request can be cancelled from the page, and the copy is
  localized for every error code in English and Chinese.
- The language catalog comes from the Host, so the page and the Host cannot
  drift apart.

### Fixed

- The service picker rendered a blank entry in a Chinese interface. The
  service catalog carried no Chinese name, and the option renderer returned
  the missing field as it was, so the select showed an empty label. The
  catalog now carries both names, and the renderer falls back to the other
  name and then to the id, so an unnamed option can never blank a picker
  again.
- The tool description claimed long text was split automatically while the
  Host refused anything above the limit. Long text is now genuinely split.
- Splitting no longer drops the separator after a sentence, so the translated
  result keeps the source structure.
- Language tags are validated before they reach a provider URL.
- The clipboard fallback works in contexts where `navigator.clipboard` is
  unavailable, and its confirmation timer is cleared on unmount.

## [1.0.1]

### Fixed

- The panel no longer gets stuck on "Connecting" when the page paints before
  the Host carrier is ready.

## [1.0.0]

### Added

- The translation workbench page and the `translate_text` agent tool.
