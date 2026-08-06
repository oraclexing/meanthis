# Security Policy

English | [中文](./SECURITY_zh.md)

## Supported versions

Until the first stable release, security fixes target the latest commit on `main` and the current `0.1.x` candidate line.

## Reporting a vulnerability

Do not open a public issue for a suspected vulnerability. Use [GitHub private vulnerability reporting](https://github.com/oraclexing/meanthis/security/advisories/new) and include the affected version, reproducible conditions, impact, and the smallest sanitized evidence needed to validate the report.

Do not include credentials, private page contents, cookies, tokens, private source, or unrelated personal data. We will acknowledge the report, validate it against the supported boundary, and coordinate a fix and disclosure when appropriate.

## Product boundary

MeanThis captures and serializes UI reference context. It is not a browser-control executor or source-editing agent. Capture, locator replay, and saved-snapshot policy results do not grant downstream authority.

For data handling details, see [PRIVACY.md](./PRIVACY.md).
