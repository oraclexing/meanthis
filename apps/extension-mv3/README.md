# MeanThis Browser Extension

English | [中文](./README_zh.md)

The Chrome Manifest V3 extension is the primary MeanThis capture surface. It lets a user select real UI elements, review reference labels and task notes, and copy a bounded handoff for an agent.

The consumer build has no browser-control executor, source editor, analytics, telemetry, cloud sync, or remote model call.

## Build

From the repository root:

```bash
npm ci
npm run build
```

Open `chrome://extensions`, enable Developer mode, choose **Load unpacked**, and select `apps/extension-mv3/dist-consumer`.

## Use

1. Invoke MeanThis from the toolbar on an HTTP(S) page. The toolbar opens the extension-origin in-page tool by default. Review the first-capture disclosure when shown. For repeated use across pages, the page-access recovery card can explicitly request optional persistent HTTP(S) access instead.
2. Choose **Add elements** and select one or more targets in the in-page tool.
3. Review the references and optional task notes.
4. Choose **Copy for agent**.

The core flow ends at **Copy for agent** and does not require a CLI. First-capture disclosure, selection, task-note editing, copy, and the narrow local connection-invitation flow are available in the in-page tool. Choose **More** to open the side panel for saved captures, detailed review, export, settings, and other advanced controls. The optional public `@meanthis/cli` companion can expose the selected scope as an explicitly user-authorized Agent-safe projection through four read-only MCP tools, including the metadata-only bounded `meanthis_wait_capture_change`, plus a narrow transient read-acknowledgement mutation. After connection, changes publish automatically; no separate Share action is required. Captures saved elsewhere in the same origin session are visibly counted but excluded from the current page-scoped handoff.

## Permissions and privacy

The consumer artifact uses `activeTab`, `alarms`, `contextMenus`, `nativeMessaging`, `scripting`, `sidePanel`, `storage`, and `webNavigation`. `nativeMessaging` sends only a fixed, bounded start request to the separately installed companion when the user creates an invitation. It has no unconditional `host_permissions` or static `content_scripts`. Optional page and loopback access require separate user gestures. Persistent page access does not create captures; **Add elements** remains explicit.

`widget.html` is the consumer manifest's only HTTP(S)-matched web-accessible resource and is embedded only after a user invocation. The capability, task-note text, and invitation are not written into host-page DOM nodes or attributes, and ordinary host-page script cannot read the extension-origin frame document through the same-origin boundary. The page can still cover, move, or remove the outer host. This does not claim absolute isolation from another same-user extension with its own authority, browser/OS compromise, or browser-enforced policies such as Permissions Policy.

Captures remain in the local browser profile until the user removes them or clears extension data. Copy and export are explicit actions. See the repository [Privacy Notice](../../PRIVACY.md).

## Package an unsigned candidate

```bash
npm run pack:extension
```

The command writes a deterministic local ZIP and checksum manifest under ignored `output/` state. It does not sign, upload, or publish the extension.
