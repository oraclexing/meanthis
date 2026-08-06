# @meanthis/web-picker

English | [中文](./README_zh.md)

> Release status: `0.1.0` is an unpublished candidate. Until the [project changelog](https://github.com/oraclexing/meanthis/blob/main/CHANGELOG.md) records publication, use this workspace or a verified package tarball; the install command below describes intended registry usage.

Reusable anchored UI comment and element-selection flow for web apps. It can run as an imported picker, an injected reference runtime, or a bookmarklet wrapper, then emits an attachment, human intent, and agent-readable Markdown.

## Install

```bash
npm install @meanthis/web-picker
```

## Example

```ts
import { createUiAttachPicker } from "@meanthis/web-picker";

const picker = createUiAttachPicker({
  onSubmit: ({ attachment, intent, markdown }) => {
    console.log({ attachment, intent, markdown });
  },
});

picker.startComment();
```

## Safety defaults

The picker and injected runtime use deterministic extraction and default to `agent_safe` disclosure. They do not send data over the network, read browser storage, click, type, navigate, or submit forms.

The bookmarklet helper loads a caller-supplied trusted or self-hosted browser ESM module with normal page-script privileges. Its events and latest export are page-visible, so use that preview path only on pages whose existing JavaScript you trust.
