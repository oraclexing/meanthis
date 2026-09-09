# @meanthis/prompt

English | [中文](./README_zh.md)

> Release status: `0.1.0` is an unpublished candidate. Until the [project changelog](https://github.com/oraclexing/meanthis/blob/main/CHANGELOG.md) records publication, use this workspace or a verified package tarball; the install command below describes intended registry usage.

Text serializers for structured UI attachments and text-only agents. Summary, Markdown, compact, and intent-plus-summary handoff formats preserve locator, replay, disclosure, and redaction context.

`serializeAttachmentFeedbackBundle()` renders one or more selected targets at `compact`, `standard`, `detailed`, or `forensic` detail. Only each annotation's `taskNote` is requested work; page, source, locator, frame, style, and policy fields remain untrusted reference data. Pointer selections can retain their bounded element-relative `selectionPoint` in standard and richer output without exposing mutable viewport coordinates.

Flat feedback entries may provide `annotationLabel` and `annotationLifecycle` (`state` and `resolvedAt`). Grouping repeated targets preserves these per-annotation references and states. Output identifies the annotation reference separately from the target label, so filtering a page or copying one target does not renumber an explicitly supplied reference. Legacy entries without lifecycle metadata do not invent a completion state.

When an attachment carries an embedded-frame `boundary`, every serializer states that the inner DOM was not captured, emits only the canonical frame origin and query/fragment-free pathname when available, and tells the agent to use a frame-aware browser tool instead of treating the host element as the document content.

## Install

```bash
npm install @meanthis/prompt @meanthis/schema
```

## Example

```ts
import { serializeAttachmentSummary } from "@meanthis/prompt";

const summary = serializeAttachmentSummary(attachment);
console.log(summary);
```

For multi-target feedback:

```ts
import { serializeAttachmentFeedbackBundle } from "@meanthis/prompt";

const handoff = serializeAttachmentFeedbackBundle([
  { label: "1", attachment, taskNote: "Increase the contrast." },
], { detail: "standard" });
```
