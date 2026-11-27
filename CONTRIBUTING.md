# Contributing

Thanks for considering a contribution to Translation Pane.

## Development setup

Requirements:

- Node.js 22 or newer.
- Git and npm.
- A local clone of this repository.

The fast test suite does not require a running DeepSeek Harness installation or network access.

```bash
npm run check
npm test
```

## What to work on

Useful areas include:

- Correctness and resilience of translation requests, cancellation and provider failover.
- Markdown, JSON and Unicode preservation.
- Accessibility, keyboard operation and responsive layout.
- Provider compatibility and honest error reporting.
- Documentation, reproducible bug reports and automated tests.

Prioritize user-visible correctness, privacy boundaries, accessibility and maintainability over feature count.

## Bug reports and feature requests

Use the repository's GitHub issue forms when available. Bug reports should include exact reproduction steps, Harness and plugin versions, operating system, translation route, and sanitized error details. Never attach real confidential source text, translated text, credentials or personal information.

## Pull request expectations

Please keep changes focused and explain:

1. The user-visible problem or engineering invariant being addressed.
2. The behavior before and after the change.
3. The tests added or updated.
4. Any compatibility or privacy implications.

Before opening a pull request:

- Run `npm run check` and `npm test`.
- Add regression tests for bug fixes.
- Update `CHANGELOG.md` under `Unreleased` when behavior changes.
- Update README or configuration documentation when user-facing behavior changes.
- Keep the Host and Client wire contract aligned.
- Preserve stable error codes or document intentional changes.
- Never log source text, translated text, credentials or other user content.
- If adding an internal runtime module, include it in the `package.json` `files` allowlist and syntax-check script.

## Compatibility notes

The API Gateway derives Remote method wire fields from method parameter names. Keep Remote method parameters as plain identifiers: no defaults, destructuring or rest parameters. A trailing parameter named `signal` is the cancellation slot.

The regular CI matrix tests Node.js 22, 24 and 26 on Linux, macOS and Windows. A separate workflow exercises pinned DeepSeek Harness revisions. Passing those checks proves only the specific runtime contracts exercised by that workflow; it is not a full desktop or web application boot test.

## Provider tests

Tests should use mocked `fetch` responses. Do not make CI depend on anonymous public translation endpoints, their availability, or their response speed.

## Style

- Prefer small, dependency-free modules.
- Keep error messages safe for the UI; put operational diagnostics in logs without user text.
- Validate untrusted inputs at the Host boundary, even when the Client already validates them.
- Favor deterministic tests over timing-sensitive sleeps.
