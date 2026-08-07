# MeanThis Companion

English | [中文](./README_zh.md)

`@meanthis/cli` is the optional local companion for the MeanThis browser extension. It exposes explicitly approved, Agent-safe captures to local agents through a read-only MCP surface. It does not control the browser, click, type, edit source files, or send captures to a hosted MeanThis service.

## Install

Requires Node.js `^22.12.0` or `^24.0.0`.

`0.1.0` is still unpublished. From this checkout:

```sh
npm ci
npm run build:bridge
npm link --workspace @meanthis/cli
```

After the package is published, the intended equivalent is:

```sh
npm install --global @meanthis/cli
```

## One MCP server, multiple hosts

`meanthis mcp` starts the same standard stdio MCP server in every client. Its public registration name is `meanthis`; lower-level `ui-attach.*` schema kinds remain stable compatibility identifiers and do not make the server Codex-only.

Codex is the first automated adapter because its CLI supports structured registration readback and exact removal:

```sh
meanthis bridge install --host codex --json
```

This command also starts and verifies the detached local owner. It safely migrates an exact legacy `ui-attach` registration that points to the same installation and never overwrites a conflicting registration. While an MCP host process is running, it renews an authenticated owner lease every 15 seconds and recreates a lost owner. After every host process exits, the owner still closes after 30 minutes without authenticated activity.

The older `meanthis bridge install --codex --json` command remains compatible. For other hosts, MeanThis generates the official command or JSON without modifying the host:

```sh
meanthis bridge config --host claude-code --json
meanthis bridge config --host vscode --json
meanthis bridge config --host cursor --json
```

After applying a generated artifact, run `meanthis bridge start --json` so the extension can connect before the host first invokes an MCP tool. Once that host starts the MCP server, the same lease behavior keeps the owner available.

| Host | Generated setup | Automatic verification |
| --- | --- | --- |
| Codex | `codex mcp add` registration | Yes: structured exact readback |
| Claude Code | `claude mcp add --transport stdio` argv | No: run and verify in Claude Code |
| VS Code | `code --add-mcp` argv plus server JSON | No: run and verify in VS Code |
| Cursor | `mcpServers` JSON for `~/.cursor/mcp.json` | No: merge and verify in Cursor |

The JSON output contains both the shared absolute-path stdio descriptor and the host-specific setup. Commands are returned as executable-plus-argv data rather than a shell-quoted string.

Then restart the agent client, open the MeanThis side panel, expand **Local agent bridge**, choose the trust scope, and select **Create & copy request**. Paste the copied request only into the intended local agent conversation.

## Default MCP surface

`meanthis mcp` exposes exactly three read-only tools:

- `meanthis_list_captures` lists bounded metadata for captures explicitly shared by the connected browser session.
- `meanthis_read_capture` reads one exact capture revision with progressive detail.
- `meanthis_resolve_source` resolves an opaque source anchor against trusted local sidecars under MCP workspace roots.

Maintainer-only legacy diagnostics require the explicit `meanthis mcp --compatibility` flag and are not part of the recommended product flow.

Capture-session file and stdin inputs are limited to 1 MiB before JSON parsing. A `bundle --intent-file` input is limited to 256 KiB.

## Trust and privacy

The bridge binds only to `127.0.0.1`, is disconnected by default, and requires an explicit browser gesture plus short-lived local approval. Its default public path accepts only Chrome Web Store extension ID `bbiiccaidhlhdagmabkogleldjdnmlfn`; no runtime or environment override is exposed. The browser extension requests its optional loopback host permission only when the user creates a connection request. Approval material must stay on the same device and must not be pasted into a webpage, public issue, log, or committed file.

See the repository [Privacy Notice](../../PRIVACY.md) and [Security Policy](../../SECURITY.md) for the complete boundary.

## Status

`0.1.0` is an unpublished candidate. The package metadata and offline pack checks prepare a public install path but do not publish the package.
