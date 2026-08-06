# Contributing to MeanThis

English | [中文](./CONTRIBUTING_zh.md)

Thank you for helping improve MeanThis. Keep changes narrow, reproducible, and aligned with the UI-reference boundary.

## Development setup

Use Node.js 22.12+ or 24.x and npm 11.16.0:

```bash
npm ci
npm test
npm run build
```

Run `npm run demo` for the browser demo. For the extension, build first and load `apps/extension-mv3/dist-consumer` as an unpacked extension in Chrome 120+.

## Change expectations

- Prefer deterministic DOM, accessibility, style, bounds, and locator facts.
- Do not add browser-control or source-edit execution to the product.
- Keep vision integrations optional.
- Add focused tests for non-trivial behavior changes.
- Keep English and Simplified Chinese public docs structurally aligned.
- Avoid new dependencies unless they clearly reduce implementation risk.

## Public-data boundary

Do not commit private page contents, raw captures, credentials, tokens, cookies, private source, personal configuration, browser recordings, model transcripts, or absolute machine paths. Use synthetic fixtures and sanitized examples.

Report suspected vulnerabilities privately as described in [SECURITY.md](./SECURITY.md).

## Before a pull request

```bash
npm test
npm run build
npm run pack:extension
npm audit --audit-level=moderate
git diff --check
```

Explain any check that could not run. Include the affected product surface, focused verification, and remaining risks in the pull request.
