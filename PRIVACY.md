---
layout: default
title: MeanThis Privacy Notice
permalink: /privacy/
lang: en
---

# MeanThis Privacy Notice

English | [中文](https://oraclexing.github.io/meanthis/zh/privacy/)

Last updated: August 6, 2026.

MeanThis is local-first. The consumer extension has no analytics, telemetry, cloud sync, remote model call, or hosted capture transport. Its optional local Agent bridge is default-off and loopback-only.

## What MeanThis reads

After a user invokes the extension and grants page access, MeanThis reads the selected HTTP(S) page only to extract bounded DOM, accessibility, style, bounds, and locator facts. Captures are created only after an explicit selection action.

## What MeanThis stores

Captures, task notes, disclosure preferences, and saved-site metadata are stored in the extension's local browser profile. They remain until the user removes them, clears saved captures, removes the extension, or clears extension data.

## What leaves the browser

Nothing is sent to a MeanThis server. Text leaves the extension only when the user explicitly copies a handoff, exports a file, or connects and approves the optional local companion. That bridge sends only the Agent-safe projection to `127.0.0.1`. The clipboard, filesystem, browser, operating system, and receiving application control that data afterward.

## Permissions

The consumer build uses `activeTab`, `alarms`, `contextMenus`, `scripting`, `sidePanel`, `storage`, and `webNavigation`. It has no unconditional `host_permissions` or static `content_scripts`. Optional HTTP(S) page access is requested only after an explicit user gesture and can be revoked in the extension settings. Optional `http://127.0.0.1/*` access is requested only by the bridge connection action and is removed when that state ends.

## Disclosure limits

`Agent-safe` is the default disclosure mode. Redaction is best-effort recognition, not data-loss prevention. URLs, visible labels, task notes, and surrounding UI text can still contain sensitive information. Review the handoff before copying it.

## Chrome Web Store Limited Use

MeanThis's use of information complies with the [Chrome Web Store User Data Policy](https://developer.chrome.com/docs/webstore/program-policies/user-data-faq), including its Limited Use requirements. The consumer capture policy requires `allowNetworkSend: false`; MeanThis does not sell data, use it for advertising or credit decisions, or provide it to data brokers.

## Saved snapshots

A saved snapshot is historical context, not proof that a page is still open, unchanged, reachable, or authorized for control. A downstream consumer must recheck the live target and obtain any required user confirmation.

## Policy website

This notice is hosted on GitHub Pages. GitHub may process request metadata under its own privacy statement. MeanThis adds no analytics, advertising, cookies, or tracking script to this policy website.

## Changes and contact

Material changes will be documented in the [MeanThis repository](https://github.com/oraclexing/meanthis). General privacy questions may use a public GitHub issue when no sensitive information is involved. For private or security-sensitive reports, follow the [security policy](https://github.com/oraclexing/meanthis/blob/main/SECURITY.md).
