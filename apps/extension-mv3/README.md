# MeanThis Browser Extension

English | [中文](./README_zh.md)

The Chrome Manifest V3 extension is the primary MeanThis capture surface. It lets a user select real UI elements, review A-Z references and task notes, and copy a bounded handoff for an agent.

The consumer build has no browser-control executor, source editor, analytics, telemetry, cloud sync, or remote model call.

## Build

From the repository root:

```bash
npm ci
npm run build
```

Open `chrome://extensions`, enable Developer mode, choose **Load unpacked**, and select `apps/extension-mv3/dist-consumer`.

## Use

1. Invoke MeanThis from the toolbar on an HTTP(S) page.
2. Choose **Add elements** and select one or more targets.
3. Review the references and optional task notes.
4. Choose **Copy for agent**.

The core flow ends at **Copy for agent** and does not require a CLI. The optional public `@meanthis/cli` companion can expose an explicitly approved Agent-safe projection through three read-only MCP tools. Captures saved elsewhere in the same origin session are visibly counted but excluded from the current page-scoped handoff.

## Permissions and privacy

The consumer artifact uses `activeTab`, `alarms`, `contextMenus`, `scripting`, `sidePanel`, `storage`, and `webNavigation`. It has no unconditional `host_permissions` or static `content_scripts`. Optional page and loopback access require separate user gestures.

Captures remain in the local browser profile until the user removes them or clears extension data. Copy and export are explicit actions. See the repository [Privacy Notice](../../PRIVACY.md).

## Package an unsigned candidate

```bash
npm run pack:extension
```

The command writes a deterministic local ZIP and checksum manifest under ignored `output/` state. It does not sign, upload, or publish the extension.
