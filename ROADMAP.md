# Roadmap

This roadmap describes proposed directions, not committed release dates. Priorities may change based on user feedback, Harness API changes and maintenance cost.

## Near term

- [ ] Keep provider request handling and retry semantics covered by deterministic regression tests.
- [ ] Complete the Host module decomposition without changing the public plugin, RPC or Agent Tool contracts.
- [ ] Add automated UI-level tests for the panel lifecycle, keyboard behavior, responsive layout and accessibility.
- [ ] Improve first-run documentation with real, current screenshots and a short installation walkthrough.

## Product capabilities

- [ ] Terminology glossary with preferred translations and protected terms.
- [ ] Bilingual paragraph comparison and easier source/result navigation.
- [ ] Markdown-aware translation that protects code blocks, inline code, links, placeholders and front matter where possible.
- [ ] Batch translation for Markdown and subtitle formats such as SRT and VTT, with structure-preservation tests.
- [ ] Optional translation history with explicit storage controls and clear retention behavior.

## Provider and reliability

- [ ] Keep provider adapters isolated and contract-tested.
- [ ] Improve diagnostics for provider latency, rate limits and failover outcomes without collecting source or translated content.
- [ ] Revalidate provider integrations against supported Harness translator capabilities as upstream APIs evolve.

## Community and documentation

- [ ] Maintain complete English and Simplified Chinese documentation.
- [ ] Publish contribution guidance and reproducible bug-report templates.
- [ ] Collect feature requests and prioritize them by user impact rather than adding features for their own sake.

## Non-goals

- The plugin will not claim that anonymous third-party translation endpoints are private, stable or local.
- The plugin will not silently store source text or translated content as durable history.
- Provider failover will remain visible to the user rather than hiding which service processed the text.
