# Security Policy

English | [中文](./SECURITY_zh.md)

## Supported versions

Until the first stable release, security fixes target the latest commit on `main` and the current `0.1.x` candidate line.

## Reporting a vulnerability

Do not open a public issue for a suspected vulnerability. Use [GitHub private vulnerability reporting](https://github.com/oraclexing/meanthis/security/advisories/new) and include the affected version, reproducible conditions, impact, and the smallest sanitized evidence needed to validate the report.

Do not include credentials, private page contents, cookies, tokens, private source, or unrelated personal data. We will acknowledge the report, validate it against the supported boundary, and coordinate a fix and disclosure when appropriate.

## Product boundary

MeanThis captures and serializes UI reference context. It is not a browser-control executor or source-editing agent. Capture, locator replay, and saved-snapshot policy results do not grant downstream authority.

The local companion uses separate protected Agent and MCP HTTP credentials. Normal start and credential-load paths never reuse or repair an insecure `bridge-agent-key-v2`. Use the explicit `meanthis bridge rotate-agent-token --host codex --json` recovery only when read-only `meanthis bridge doctor --json` reports `agentCredential` as insecure because of ACL drift, or when the Agent key may have been exposed. It rotates the MCP HTTP bearer first and Agent token second under the profile transition lock. Current registrations restart and verify both owners and require affected tasks or hosts to restart. For missing or managed legacy registrations, secure readback is followed by publishing the A2-bound desired marker and verified browser-owner start or turnover; the MCP HTTP owner is not started, the complete MCP runtime is not claimed, and the result is `runtimeActive:false`, `browserOwnerActive:true`, with install next. Marker-aware builds turn over automatically from their first supported build. A much older browser owner that does not recognize the desired-marker protocol may not exit; the CLI then fails closed and directs the user to stop the old process occupying `127.0.0.1:38471` before retrying. Drifted registrations fail closed. Partial or committed-but-unverified reports omit tokens, credential paths, and underlying causes. This does not remove the accepted fixed-port, no-TLS/channel-binding residual and grants no browser-control authority.

For data handling details, see [PRIVACY.md](./PRIVACY.md).
