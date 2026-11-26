# Security Policy

## Reporting a vulnerability

Please do not publish exploitable vulnerability details in a public issue or pull request.

Use GitHub's private vulnerability reporting flow for this repository when it is enabled (Security → Report a vulnerability). If private reporting is unavailable, contact the maintainer privately through the GitHub profile. Please include:

- the affected plugin version and, when relevant, the commit SHA;
- the DeepSeek Harness and Node.js versions and operating system;
- the affected component (Host service, browser panel, agent tool, or CI workflow);
- a concise impact statement and minimal reproduction that does not expose real user data;
- any practical mitigation or configuration required to reproduce the issue.

Please redact translation input/output, API credentials, private endpoints, personal information, and confidential source code from reports and logs. Do not use a live user's text in a proof of concept.

## Scope

Security reports are especially relevant to:

- disclosure of submitted text to an unintended provider or destination;
- unexpected cross-provider failover or leakage of text across provider boundaries;
- request/response handling that permits unbounded memory use, hangs, or resource exhaustion;
- URL/configuration handling, unsafe redirects, credential exposure, or unintended network access;
- injection or unsafe rendering in the browser panel;
- cancellation, caching, concurrency, or rate-limit behavior that crosses user/request boundaries;
- accidental logging or persistence of submitted or translated content;
- CI, release, or package-publishing paths that permit unauthorized code or artifacts.

The plugin accepts configurable HTTP(S) provider endpoints. Configure only destinations approved by the deploying administrator. The plugin's request path disables cookies and rejects redirects, but endpoint configuration remains an explicit trust decision.

## Data handling relevant to security reports

Translation is not local by default. In the direct route, source text is sent to Microsoft Edge/Bing or Google Translate according to the selected provider; when failover is enabled, a failed fragment may also be sent to the other provider. The shipped Harness translator route follows that service's provider and account configuration.

In JSON mode, only decoded JSON string values are sent for translation; keys and non-string values remain local. Completed translations may be held in a bounded in-memory cache for the Host service lifetime. Browser local storage contains language/provider/format preferences, not source or translated text. The Host plugin does not log source or translated content.

Provider-side retention, review, training, and processing practices are outside this plugin's control. Anonymous requests must not be interpreted as a zero-logging or zero-retention guarantee. Do not submit secrets or confidential data unless disclosure to the configured provider is authorized.

## Supported versions

Please reproduce reports against the latest published version or the current `main` branch. Security fixes are prioritized for the latest maintained release; older versions may not receive backports. No response-time SLA is implied by this policy.
