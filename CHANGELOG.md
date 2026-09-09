# Changelog

English | [中文](./CHANGELOG_zh.md)

All notable changes will be documented in this file.

## Unreleased

- Keep capture counts, deletion results, and task-note edits consistent between the floating widget and side panel, including saved-site cleanup and recovery after a failed save.
- Show the active capture state when opening settings, preserve scroll position during connection updates, and soften the floating controls' edges and shadows.
- Compare a saved capture with the current page through explicit, bounded observations.
- Reduce repeated bridge startup checks and coalesce concurrent status refreshes without allowing timer requests to accumulate behind slow operations.

## [0.1.0] - Early testing

- Initial MeanThis browser extension candidate.
- Six public `@meanthis/*` packages for schema, prompt, DOM extraction, selection, replay, and capture sessions.
- Browser demo and saved-snapshot integration examples.
- Independent annotation editing and deletion when the same target is captured more than once.
- Saved-site cleanup can recover a corrupted session while preserving other sites and the latest capture; cancelling leaves storage unchanged.
- Overlapping frame-scope reads no longer leave a false operation error after the floating widget is reopened.
- Agent-safe capture and handoff redact additional recognized provider-token formats.
- The optional MCP broker preserves complete responses when a POSIX output pipe is temporarily full, with bounded retries and verified shutdown under backpressure.
- Optional MCP companion with four read-only tools (`meanthis_list_captures`, metadata-only bounded `meanthis_wait_capture_change`, `meanthis_read_capture`, and `meanthis_resolve_source`) plus the narrow transient `meanthis_ack_capture_read` acknowledgement mutation, using one thin stdio broker per task plus one detached Streamable HTTP owner. Host registration stores only absolute Node plus the broker entry, with no environment, working directory, or token; each broker authenticates the owner with nonce/timestamp request-and-response HMAC before using the protected profile credential in memory, transparently forwards capabilities and `roots/list`, receives independent session roots with no daemon-cwd fallback, and, when stdio ends, first requests immediate HTTP-session deletion; if DELETE or the daemon is unavailable, bounded disconnected-grace/idle cleanup reclaims the retained session. Direct HTTP, full stdio, and the standalone resolver remain compatibility or migration paths.
- Read-only doctor inspection of `agentCredential` plus explicit `meanthis bridge rotate-agent-token --host codex --json` recovery for `bridge-agent-key-v2` ACL drift or possible exposure. Normal start and credential-load paths never repair or reuse an insecure key. Recovery rotates the MCP HTTP bearer first and Agent token second under the profile transition lock so both owners turn over. Current registrations restart and verify both owners and require affected tasks or hosts to restart. For missing or managed legacy registrations, secure readback is followed by publishing the A2-bound desired marker and verified browser-owner start or turnover; the MCP HTTP owner is not started, the complete MCP runtime is not claimed, and the result is `runtimeActive:false`, `browserOwnerActive:true`, with install next. Drifted registrations fail closed. Partial or committed-but-unverified reports omit tokens, credential paths, and underlying causes.

Available extension downloads are listed in [GitHub Releases](https://github.com/oraclexing/meanthis/releases). npm packages and Chrome Web Store distribution remain unpublished.
