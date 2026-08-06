# @meanthis/replay

English | [中文](./README_zh.md)

> Release status: `0.1.0` is an unpublished candidate. Until the [project changelog](https://github.com/oraclexing/meanthis/blob/main/CHANGELOG.md) records publication, use this workspace or a verified package tarball; the install command below describes intended registry usage.

Playwright-like locator replay verification for structured UI attachments. It checks the primary locator first, then deduplicated fallback candidates, and returns structured attempts for diagnostics without clicking, typing, mutating the page, or requiring Playwright as a dependency.

## Install

```bash
npm install @meanthis/replay @meanthis/schema
```

## Example

```ts
import { applyReplayResult, verifyAttachmentLocator } from "@meanthis/replay";

const replay = await verifyAttachmentLocator(pageAdapter, attachment);
const updated = applyReplayResult(attachment, replay);
```

Adapter implementations that need to resolve one already-selected strategy/value pair can use the higher-level `resolveReplayLocator` export. It returns either a replay locator or a fixed failure reason without exposing the locator-expression parser as public API.
