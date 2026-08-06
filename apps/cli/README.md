# MeanThis Companion

English | [中文](./README_zh.md)

`@meanthis/cli` is the optional local companion for the MeanThis browser extension. It exposes explicitly approved, Agent-safe captures to local agents through a read-only MCP surface. It does not control the browser, click, type, edit source files, or send captures to a hosted MeanThis service.

## Install

Requires Node.js `^22.12.0` or `^24.0.0`.

```sh
npm install --global @meanthis/cli
```

Register the default MCP surface with Codex:

```sh
meanthis bridge install --codex --json
```

Then restart the agent client, open the MeanThis side panel, expand **Local agent bridge**, choose the trust scope, and select **Create & copy request**. Paste the copied request only into the intended local agent conversation.

## Default MCP surface

`meanthis mcp` exposes exactly three read-only tools:

- `ui_attach_list_captures` lists bounded metadata for captures explicitly shared by the connected browser session.
- `ui_attach_read_capture` reads one exact capture revision with progressive detail.
- `ui_attach_resolve_source` resolves an opaque source anchor against trusted local sidecars under MCP workspace roots.

Maintainer-only legacy diagnostics require the explicit `meanthis mcp --compatibility` flag and are not part of the recommended product flow.

Capture-session file and stdin inputs are limited to 1 MiB before JSON parsing. A `bundle --intent-file` input is limited to 256 KiB.

## Trust and privacy

The bridge binds only to `127.0.0.1`, is disconnected by default, and requires an explicit browser gesture plus short-lived local approval. Its default public path accepts only Chrome Web Store extension ID `bbiiccaidhlhdagmabkogleldjdnmlfn`; no runtime or environment override is exposed. The browser extension requests its optional loopback host permission only when the user creates a connection request. Approval material must stay on the same device and must not be pasted into a webpage, public issue, log, or committed file.

See the repository [Privacy Notice](../../PRIVACY.md) and [Security Policy](../../SECURITY.md) for the complete boundary.

## Status

`0.1.0` is an unpublished candidate. The package metadata and offline pack checks prepare a public install path but do not publish the package.
