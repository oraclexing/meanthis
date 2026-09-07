# @meanthis/web-picker

English | [中文](./README_zh.md)

> Release status: `0.1.0` is an unpublished candidate. Until the [project changelog](https://github.com/oraclexing/meanthis/blob/main/CHANGELOG.md) records publication, use this workspace or a verified package tarball; the install command below describes intended registry usage.

The shared MeanThis browser core for applications that own their page code. It provides one continuous element-selection controller, persistent A-Z overlays, the floating widget view, and one-document surface arbitration. The SDK widget and MV3 extension adapters consume these same primitives instead of maintaining separate pointer, hover, Escape, and overlay implementations.

## Install

```bash
npm install @meanthis/web-picker
```

## SDK widget

```ts
import { createMeanThisWebWidget } from "@meanthis/web-picker";

const widget = createMeanThisWebWidget({
  initialOpen: true,
  onCopy: ({ text }) => {
    console.log(text);
  },
});

// Optional application controls can use the same controller.
widget.startSelection();
```

`createMeanThisWebWidget` keeps work mode active across multiple selections, shows hover preview before a click, supports anchored edit/remove actions, and produces the Agent-safe handoff from the current target set. Separate clicks on one DOM target create numbered annotations under that single target, so each comment and selection point stays independent without duplicating locator evidence. Call `stopSelection()` or press `Escape` to leave work mode, and call `destroy()` when the host page disposes the integration.

## Shared primitives

- `createElementSelectionController` owns the deterministic pointer, click, Escape, preview, and activation lifecycle. Adapters provide extraction, storage, and authorization.
- `createPersistentOverlayController` owns target outlines, labels, anchors, and per-target actions.
- `createInPageWidgetView` owns the reusable floating workbar and editor view.
- `claimMeanThisSurface` prevents the SDK and extension from mounting overlapping MeanThis surfaces in the same top-level document.

The surface claim contains only a public owner/version marker. It is collision avoidance, not authentication, and never stores task notes, invitations, captures, tokens, or capabilities.

## Debugging and safety

For local visual QA only, `debugInspectableDom: true` mounts the same shared view in light DOM so browser inspection and commenting tools can target its controls. This makes widget contents, including task notes, readable by the host page; never enable it on production pages or with sensitive content. The default is an isolated closed Shadow DOM.

The SDK runs with the host application's page privileges. It does not provide Native Messaging, extension storage, or local Agent invitations. Those capabilities remain in the extension adapter. Arbitrary pages that did not import this package still require the MeanThis extension.
