<p align="center">
  <img src="./assets/meanthis-mark.svg" width="96" height="96" alt="MeanThis logo">
</p>

<h1 align="center">MeanThis</h1>

<p align="center"><strong>Point once. Give an Agent the UI context you mean.</strong></p>

<p align="center">
  English · <a href="./README_zh.md">简体中文</a> ·
  <a href="https://oraclexing.github.io/meanthis/privacy/">Privacy</a> ·
  <a href="./SECURITY.md">Security</a>
</p>

MeanThis is a local-first UI reference layer for human-to-Agent work. Select real elements in a Web page, review the captured facts, add task intent only where work is requested, and hand the result to a text Agent.

The deterministic Web surface comes first: DOM, accessibility, styles, bounds, context, locator candidates, replay evidence, and optional source anchors. MeanThis does not click, type, navigate, edit source, or grant downstream authority.

> **Release status:** `0.1.0` is an unpublished candidate. The repository, npm packages, and Chrome extension are being prepared for their first public release.

## Why MeanThis

Screenshots and prose often leave an Agent guessing which control, label, container, or state a person meant. MeanThis turns a human selection into a reviewable reference with explicit target identity and bounded context.

- **Precise:** A-Z labels connect page overlays, task notes, and handoff records.
- **Deterministic-first:** Browser facts are primary; vision remains optional.
- **Local-first:** Captures stay in the browser profile unless the user explicitly copies, exports, or approves the loopback companion.
- **Replay-aware:** Locator candidates retain uniqueness and verification evidence instead of pretending a selector is always stable.
- **Agent-safe by default:** The default projection redacts recognized secrets and excludes control authority.

## Three-step workflow

| Step | Human action | MeanThis result |
| --- | --- | --- |
| 1. Select | Choose **Add elements**, then select one or more page targets. | Visible A-Z references and structured target facts. |
| 2. Describe | Add a task note only to elements that require work. | Requested work stays separate from context-only elements. |
| 3. Handoff | Review the exact handoff and choose **Copy for Agent**. | Human-readable Agent-safe context ready to paste into a text Agent. |

The optional local companion can expose an explicitly approved Agent-safe capture through MCP, but the manual copy flow remains complete on its own.

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

Open MeanThis from the browser toolbar, choose **Add elements**, select targets, review the side panel, and copy the handoff.

To run only the standalone Web demo:

```bash
npm run demo
```

The demo does not replace the native extension side panel or its saved-capture flow.

## Optional host-neutral MCP companion

The CLI workspace in this public repository provides a default-off, read-only local companion. `meanthis mcp` is one standard stdio MCP server; it is not tied to Codex. Host adapters only describe how each client starts that same executable.

From a source checkout, the Codex adapter can install and read back the exact registration automatically:

```bash
npm run setup:codex-bridge
```

For other supported hosts, build once and generate their command or JSON configuration without changing the host:

```bash
npm run build
node apps/cli/dist/index.js bridge config --host claude-code --json
node apps/cli/dist/index.js bridge config --host vscode --json
node apps/cli/dist/index.js bridge config --host cursor --json
```

| Host | v0.1 setup boundary |
| --- | --- |
| Codex | Automated install, exact structured readback, and exact uninstall |
| Claude Code | Official stdio add command generated; the user runs and verifies it |
| VS Code | Official `code --add-mcp` command and server JSON generated |
| Cursor | `mcpServers` JSON generated for `~/.cursor/mcp.json` |

The shared descriptor and all four renderers are contract-tested. We do not claim a real-host canary for a client that was not actually installed and exercised. The bridge binds to `127.0.0.1`, requires an explicit extension connection request and short-lived local approval, and exposes only the approved Agent-safe projection. It does not provide arbitrary selectors or browser-control operations. The primary extension workflow does not require it.

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

MeanThis has no hosted capture service, analytics, telemetry, cloud sync, or remote model call. Captures remain local until an explicit copy, export, or approved loopback action. Redaction is best-effort and is not a data-loss-prevention guarantee; always review a handoff before sharing it.

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
