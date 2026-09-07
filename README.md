<p align="center">
  <img src="./assets/meanthis-mark.svg" width="96" height="96" alt="MeanThis logo">
</p>

<h1 align="center">MeanThis</h1>

<p align="center"><strong>Point once. Give an Agent the UI context you mean.</strong></p>

<p align="center">
  English · <a href="./README_zh.md">简体中文</a> ·
  <a href="./PRIVACY.md">Privacy</a> ·
  <a href="./SECURITY.md">Security</a>
</p>

MeanThis is a local-first UI reference layer for human-to-Agent work. Select real elements in a Web page, review the captured facts, add task intent only where work is requested, and hand the result to a text Agent.

The deterministic Web surface comes first: DOM, accessibility, styles, bounds, context, locator candidates, replay evidence, and optional source anchors. MeanThis does not click, type, navigate, edit source, or grant downstream authority.

> **Release status:** `0.1.0` is intended for early testing. Use the source checkout or an available GitHub Release. npm packages and Chrome Web Store distribution are not yet published.

## Why MeanThis

Screenshots and prose often leave an Agent guessing which control, label, container, or state a person meant. MeanThis turns a human selection into a reviewable reference with explicit target identity and bounded context.

- **Precise:** Reference labels connect page overlays, task notes, and handoff records.
- **Deterministic-first:** Browser facts are primary; vision remains optional.
- **Local-first:** Captures stay in the browser profile unless the user explicitly copies, exports, or authorizes the loopback companion.
- **Replay-aware:** Locator candidates retain uniqueness and verification evidence instead of pretending a selector is always stable.
- **Agent-safe by default:** The default projection redacts recognized secrets and excludes control authority.

## Three-step workflow

| Step | Human action | MeanThis result |
| --- | --- | --- |
| 1. Select | Choose **Add elements**, then select one or more page targets. | Visible reference labels and structured target facts. |
| 2. Describe | Add a task note only to elements that require work. | Requested work stays separate from context-only elements. |
| 3. Handoff | Review the exact handoff and choose **Copy for Agent**. | Human-readable Agent-safe context ready to paste into a text Agent. |

The optional local companion can expose an explicitly user-authorized Agent-safe capture through MCP, but the manual copy flow remains complete on its own.

## What the Agent receives

Depending on the selected disclosure mode and available browser evidence, a handoff can include:

| Evidence | Examples |
| --- | --- |
| Semantic identity | tag, inferred role, accessible name, visible text |
| Geometry and state | viewport bounds, visibility, enabled state |
| Visual facts | selected computed styles such as display, color, and background |
| Page context | parent summary, nearby text, source URL/path after policy projection |
| Re-resolution | selector hints, locator candidates, uniqueness and replay evidence |
| Intent | per-target task notes plus context-only/requested-work classification |
| Source mapping | optional reviewed source anchors when an integration can verify them |

This is reference context, not permission to operate the browser, filesystem, source tree, or another service.

## Install the extension

### Release download (no build required)

After a release is published, download all three matching assets from [GitHub Releases](https://github.com/oraclexing/meanthis/releases): `meanthis-extension-mv3-<version>.zip`, its `.manifest.json`, and `.sha256`. Keep them in one directory and run `sha256sum --check meanthis-extension-mv3-<version>.sha256`; the checksum file verifies both the ZIP and manifest. Then extract the ZIP, open `chrome://extensions`, enable **Developer mode**, choose **Load unpacked**, and select the extracted directory containing `manifest.json`.

On Windows, use PowerShell in the download directory instead (replace `<version>` with the downloaded version). Compare both displayed hashes with the corresponding entries in the checksum file before extracting:

```powershell
Get-FileHash -Algorithm SHA256 -LiteralPath "meanthis-extension-mv3-<version>.zip", "meanthis-extension-mv3-<version>.manifest.json"
Get-Content -LiteralPath "meanthis-extension-mv3-<version>.sha256"
```

This avoids a local Node.js build, but it is still an unpacked developer installation. A signed Chrome Web Store listing is the future true one-click install path; GitHub cannot directly install an ordinary CRX into Chrome.

### Build from source

Requirements: Node.js 22.12+ or 24.x and npm 11.16.0.

```bash
npm ci
npm test
npm run build
```

Then open `chrome://extensions`, enable **Developer mode**, choose **Load unpacked**, and select:

```text
apps/extension-mv3/dist-consumer
```

Open MeanThis from the browser toolbar, choose **Add elements**, select targets, review the floating widget, and copy the handoff. **More** opens the side panel for saved captures and detailed review.

To run only the standalone Web demo:

```bash
npm run demo
```

The demo does not replace the native extension side panel or its saved-capture flow.

## Install with an Agent

You can give a coding Agent the repository URL and ask it to install MeanThis. The deterministic, bilingual setup contract is [AGENT_INSTALL.md](./AGENT_INSTALL.md). It tells the Agent how to clone and verify the source, build and register the host-neutral thin stdio broker, start both local owners, restart the affected task or host, and verify the four read-only `meanthis_*` tools, including the metadata-only bounded `meanthis_wait_capture_change`.

The Agent can prepare the extension files and open the relevant browser page, but Chrome must still show the extension installation or permission step to the user for confirmation. MeanThis does not require a separate Skill. Before the first npm and Chrome Web Store releases, the repository checkout is the authoritative installation source.

## Optional host-neutral MCP companion

The CLI workspace in this public repository provides a default-off, read-only local companion. The default `meanthis` registration starts one thin stdio broker per Agent task with an absolute Node executable and one broker-entry argument, with no environment, working directory, or token. Each broker reads the protected profile credential, authenticates the detached HTTP owner through nonce/timestamp request-and-response HMAC proofs without sending the raw token, then holds the Bearer credential in memory for fixed loopback `/mcp`. It transparently forwards client capabilities and server `roots/list`, exposing exactly `meanthis_list_captures`, metadata-only bounded `meanthis_wait_capture_change`, `meanthis_read_capture`, and `meanthis_resolve_source`. Every broker gets an independent HTTP session and workspace roots; source resolution never falls back to the daemon working directory. The former direct-HTTP registration, `meanthis mcp` full stdio entry, and standalone resolver remain compatibility or migration paths, not parallel defaults.

From a source checkout, the Codex adapter can install and read back the exact registration automatically:

```bash
npm run setup:bridge:codex
meanthis bridge doctor --json
meanthis bridge start --json
# Fully close and reopen the affected Codex task or host.
```

The npm setup wrapper builds and links the CLI before it invokes the registration install; those immediate local side effects remain if the later CLI preflight fails closed. Direct `meanthis bridge install --host codex --dry-run --json` is narrower: it creates no credential, starts no owner, and changes no configuration. `doctor` is read-only and checks `agentCredential`; an `insecure` result points to `rotate-agent-token`. Normal start and credential-load paths never reuse or repair an insecure `bridge-agent-key-v2`. Use the recovery command only for ACL drift or possible Agent-key exposure. It rotates the MCP HTTP bearer first and the Agent token second under the existing profile transition lock. With a current registration it restarts and verifies both owners before affected tasks or hosts restart. With a missing or managed legacy registration, secure readback is followed by publishing the A2-bound desired marker and verified browser-owner start or turnover; the MCP HTTP owner is not started, the complete MCP runtime is not claimed, and the result is `runtimeActive:false`, `browserOwnerActive:true`, with install next. A drifted registration fails closed. Partial or committed-but-unverified results omit tokens, credential paths, and underlying causes. After install, system restart, or token rotation, fully restart the affected task or host so it starts a new broker. Do not run `bridge launch`: packaged Codex Desktop cannot reliably receive per-launch environment injection, and that command now fails safely as unsupported. The installer removes only exact managed legacy `ui-attach`, direct-HTTP/full-stdio `meanthis`, and standalone-resolver registrations from the same installation and fails closed on conflicts; this documentation does not claim that a machine's global configuration has already been migrated.

For other supported hosts, build once and generate their command or JSON configuration without changing the host:

```bash
npm run build:bridge
npm link --workspace @meanthis/cli
meanthis bridge start --json
meanthis bridge config --host claude-code --json
meanthis bridge config --host vscode --json
meanthis bridge config --host cursor --json
```

| Host | v0.1 setup boundary |
| --- | --- |
| Codex | Automated install, exact structured readback, and exact uninstall |
| Claude Code | Manual stdio command and argument |
| VS Code | Manual stdio command and argument |
| Cursor | Manual stdio command and argument |

The shared descriptor and all four renderers are contract-tested. Non-Codex adapters return only the manual stdio command and broker argument; they do not modify the host, expose a credential, or claim a real-host canary. The broker persists no capture, MCP session, or token. When stdio ends it first requests immediate HTTP-session deletion; if that DELETE or the daemon is unavailable, the daemon's bounded disconnected-grace/idle cleanup reclaims the retained session. The host does not hold the token, but after the HMAC owner preflight the broker sends Bearer to fixed loopback `/mcp`; if that owner later dies and another local process takes the port before reconnect, the token could be exposed because v1 has no TLS or channel binding. The token is a same-user, local-process capability for Agent-safe capture reads and the narrow transient read acknowledgement, not browser-control authority. A successful invitation acceptance returns the exact capture-discovery next action. If the current Agent task cannot call the registered MCP tools, `meanthis capture list/read/ack --json` provides a host-neutral fallback over the same progressive read and explicit acknowledgement implementations. The primary extension workflow does not require the companion.

## Packages

| Package | Purpose |
| --- | --- |
| `@meanthis/schema` | Attachment schemas, validation, and saved-snapshot policy guards |
| `@meanthis/prompt` | Human-readable Agent handoff serialization |
| `@meanthis/web-extractor` | Bounded deterministic DOM extraction |
| `@meanthis/web-picker` | Reusable element-selection workflow |
| `@meanthis/replay` | Locator replay and verification contracts |
| `@meanthis/hub-core` | Transport-neutral capture sessions and handoff assembly |
| `@meanthis/source-map-core` | Source-anchor matching primitives |
| `@meanthis/source-resolver-mcp` | Read-only exact source resolver MCP |
| `@meanthis/cli` | Optional local Agent bridge and MCP companion |

## Repository map

```text
apps/
  cli/             optional local companion
  demo-web/        standalone capture and replay demo
  extension-mv3/   Chrome MV3 extension
packages/
  hub-core/        capture sessions and handoff assembly
  prompt/          text serialization
  replay/          locator replay contract
  schema/          schemas and policy guards
  web-extractor/   DOM extraction
  web-picker/      element selection
tools/
  source-map-core/       source-anchor matching
  source-resolver-mcp/   read-only source resolver
examples/
  saved-snapshot-trusted-host/
  saved-snapshot-text-consumer/
```

## Privacy and security

MeanThis has no hosted capture service, analytics, telemetry, cloud sync, or remote model call. Captures remain local until an explicit copy, export, or user-authorized loopback action. Redaction is best-effort and is not a data-loss-prevention guarantee; always review a handoff before sharing it.

Read the [Privacy Notice](./PRIVACY.md) and [Security Policy](./SECURITY.md). Report suspected vulnerabilities through GitHub private vulnerability reporting rather than a public issue.

## Project boundary

- MeanThis captures, serializes, restores, and helps re-resolve UI references.
- It prioritizes Web/DOM and accessibility facts over probabilistic vision.
- A saved snapshot is historical context until a live consumer rechecks it.
- Capture, replay, source resolution, and MCP reads do not authorize downstream control.
- Hosts that add network transport, model calls, storage, or execution must disclose and secure those additions separately.

## Contributing and releasing

See [CONTRIBUTING.md](./CONTRIBUTING.md) for development expectations and [RELEASING.md](./RELEASING.md) for the owner-only release checklist. Before proposing a change, run:

```bash
npm test
npm run build
npm run pack:extension
npm audit --audit-level=moderate
git diff --check
```

## License

MIT. See [LICENSE](./LICENSE) and [THIRD_PARTY_NOTICES.md](./THIRD_PARTY_NOTICES.md).
