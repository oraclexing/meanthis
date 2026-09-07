---
layout: default
title: MeanThis Privacy Notice
permalink: /privacy/
lang: en
---

# MeanThis Privacy Notice

English | [中文](https://github.com/oraclexing/meanthis/blob/main/PRIVACY_zh.md)

Last updated: August 10, 2026.

MeanThis is local-first. The consumer extension has no analytics, telemetry, cloud sync, remote model call, or hosted capture transport. Its optional local Agent bridge is default-off and loopback-only.

## What MeanThis reads

After a user invokes the extension and grants page access, MeanThis reads the selected HTTP(S) page only to extract bounded DOM, accessibility, style, bounds, and locator facts. The toolbar opens the extension-origin `widget.html` in-page tool by default. First-capture disclosure, selection, task notes, copy, and the narrow local invitation flow are available there; **More** opens the side panel. Captures are created only after an explicit selection action.

`widget.html` is the consumer manifest's only HTTP(S)-matched web-accessible resource and is embedded only after a user invocation. Its capability, task-note text, and invitation are not written into host-page DOM nodes or attributes, and ordinary host-page script cannot read the extension-origin frame document through the same-origin boundary. The page can still cover, move, or remove the outer host. This does not claim absolute isolation from another same-user extension with its own authority, browser/OS compromise, or browser-enforced policies such as Permissions Policy.

## What MeanThis stores

Captures, task notes, disclosure preferences, and saved-site metadata are stored in the extension's local browser profile. They remain until the user removes them, clears saved captures, removes the extension, or clears extension data.

## What leaves the browser

Nothing is sent to a MeanThis server. Text leaves the extension only when the user explicitly copies a handoff, exports a file, or authorizes a connection invitation accepted by the optional local companion. That bridge sends only the Agent-safe projection to `127.0.0.1`. The clipboard, filesystem, browser, operating system, and receiving application control that data afterward.

## Permissions

The consumer build uses `activeTab`, `alarms`, `contextMenus`, `nativeMessaging`, `scripting`, `sidePanel`, `storage`, and `webNavigation`. `nativeMessaging` sends only a fixed, bounded start request to the separately installed MeanThis companion when the user creates an invitation; it sends no executable path, command arguments, credential, or page content. `sidePanel` supports saved captures, detailed review, export, settings, and other advanced controls opened from **More**. The build has no unconditional `host_permissions` or static `content_scripts`. Optional HTTP(S) page access is requested only after an explicit user gesture in Settings or the page-access recovery card and can be revoked in the extension settings. Permission alone does not create a capture. Optional `http://127.0.0.1/*` access is requested only by the bridge connection action and is removed when that state ends.

## Disclosure limits

`Agent-safe` is the default disclosure mode. Redaction is best-effort recognition, not data-loss prevention. URLs, visible labels, task notes, and surrounding UI text can still contain sensitive information. Review the handoff before copying it.

## Chrome Web Store Limited Use

MeanThis's use of information complies with the [Chrome Web Store User Data Policy](https://developer.chrome.com/docs/webstore/program-policies/user-data-faq), including its Limited Use requirements. The consumer capture policy requires `allowNetworkSend: false`; MeanThis does not sell data, use it for advertising or credit decisions, or provide it to data brokers.

## Saved snapshots

A saved snapshot is historical context, not proof that a page is still open, unchanged, reachable, or authorized for control. A downstream consumer must recheck the live target and obtain any required user confirmation.

## Sensitive pages and user controls

- Prefer non-sensitive test or demo pages. Avoid capturing authentication, financial, health, private-message, secret-management, or production-admin surfaces unless the workflow is explicitly authorized and the output will be reviewed.
- Keep `Agent-safe` unless additional detail is necessary. Treat `full_debug` as deliberately sensitive.
- Use **Stop selecting** or **Escape** to end selection. Tab changes and navigation revoke selection automatically.
- Use **Remove** for one item, **Saved captures** to review or clear locally retained captures, and **Clear all saved captures** for all capture data owned by this feature. Use browser extension-data removal or uninstall for complete extension-storage removal, and delete exported files or clipboard contents separately.

MeanThis is a context-capture tool, not a credential manager, privacy scanner, data-loss-prevention system, or authorization system.

## Policy website

This notice is available in the GitHub repository and may also be served through GitHub Pages. GitHub may process request metadata under its own privacy statement. MeanThis adds no analytics, advertising, cookies, or tracking script to this policy website.

## Changes and contact

Material changes will be documented in the [MeanThis repository](https://github.com/oraclexing/meanthis). General privacy questions may use a public GitHub issue when no sensitive information is involved. For private or security-sensitive reports, follow the [security policy](https://github.com/oraclexing/meanthis/blob/main/SECURITY.md).
