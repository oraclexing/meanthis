# @meanthis/web-extractor

English | [中文](./README_zh.md)

> Release status: `0.1.0` is an unpublished candidate. Until the [project changelog](https://github.com/oraclexing/meanthis/blob/main/CHANGELOG.md) records publication, use this workspace or a verified package tarball; the install command below describes intended registry usage.

Deterministic browser-side DOM extraction for UI attachments. It captures element facts, accessibility metadata, bounds, computed styles, nearby context, locator candidates, and disclosure audit metadata. The default disclosure mode is `agent_safe`.

When an instrumented element carries both `data-ui-attach-build-id` and `data-ui-attach-source-id`, the extractor copies them into an experimental opaque `sourceAnchor`. Partial or malformed anchors are omitted. The extractor never reads a path-bearing source attribute and never treats the page value as verified.

## Resource limits

Selected DOM text is collected without first materializing the element's complete `textContent`. The bounded traversal collects at most 10,000 nodes, may inspect one additional node only to distinguish an exact boundary from truncation, and returns at most 16,000 characters; a truncated value ends with `[truncated]`, and that marker counts toward the character limit. Page attributes longer than 16,000 characters are not used to construct locator candidates, because truncating an attribute would create a selector that does not exist on the page. Emitted non-coordinate locators also obey the shared 4,096-character replay contract.

Stable-data locator discovery examines at most 256 attributes on the selected element, and form-label discovery examines at most 64 associated labels. These are fallback discovery bounds; direct `data-testid`, `id`, and accessible-name paths retain their normal priority.

The completed attachment must fit within 131,072 serialized JSON characters or extraction fails closed with an error. Embedded-URL redaction preserves the existing behavior for at most 64 URL starts in one value; encountering a 65th start stops collection and returns the fail-closed `[redacted:url]` value.

## Install

```bash
npm install @meanthis/web-extractor @meanthis/schema
```

## Example

```ts
import { extractElementAttachment } from "@meanthis/web-extractor";

const button = document.querySelector<HTMLButtonElement>("button[type=submit]");
if (button) {
  const attachment = extractElementAttachment(button);
  console.log(attachment.locatorBundle.primary);
}
```
