import { createCaptureHub, type OriginCaptureRecordLike } from "@meanthis/hub-core";
import { serializeAttachmentMarkdown } from "@meanthis/prompt";
import {
  applyReplayResult,
  verifyAttachmentLocator,
  type LocatorReplayResult,
} from "@meanthis/replay";
import type { UIAttachment } from "@meanthis/schema";
import {
  createUiAttachBookmarklet,
  createUiAttachInjectedRuntime,
  createUiAttachPicker,
  type UiAttachInjectedRuntime,
} from "@meanthis/web-picker";
import { createDomReplayPage } from "./replay-dom";

export function attachDemoSelection(root: Document): void {
  const demoMode = new URLSearchParams(root.location.search).get("ui-attach-demo") === "extension-target"
    ? "extension-target"
    : "standalone";
  const standaloneTools = root.querySelector<HTMLElement>("#standalone-demo-tools");
  const standaloneOutput = root.querySelector<HTMLElement>("#standalone-demo-output");
  const extensionGuide = root.querySelector<HTMLElement>("#extension-demo-guide");
  if (root.body) root.body.dataset.uiAttachDemoMode = demoMode;
  if (standaloneTools) standaloneTools.hidden = demoMode === "extension-target";
  if (standaloneOutput) standaloneOutput.hidden = demoMode === "extension-target";
  if (extensionGuide) extensionGuide.hidden = demoMode !== "extension-target";
  if (demoMode === "extension-target") return;

  const action = root.querySelector<HTMLButtonElement>("#comment-action");
  const bundleAction = root.querySelector<HTMLButtonElement>("#bundle-action");
  const bundleList = root.querySelector<HTMLElement>("#bundle-list");
  const injectedAction = root.querySelector<HTMLButtonElement>("#injected-action");
  const bookmarkletLink = root.querySelector<HTMLAnchorElement>("#bookmarklet-link");
  const output = root.querySelector<HTMLPreElement>("#output");
  const surface = root.querySelector<HTMLElement>("[data-ui-attach-surface]");
  if (!action || !output || !surface) {
    return;
  }

  let latestAttachment: UIAttachment | null = null;
  let latestMarkdown = "";
  let injectedRuntime: UiAttachInjectedRuntime | null = null;
  let pickerMode: "single" | "bundle" = "single";
  const captureHub = createCaptureHub();
  const bundleSession = captureHub.createSession({
    id: "demo-bundle",
    title: root.title || "ui-attach demo",
    origin: root.location.origin,
  });
  const bundleAttachmentIds: string[] = [];
  const isDemoControl = (target: HTMLElement): boolean =>
    target.id === "comment-action" ||
    target.id === "bundle-action" ||
    target.id === "injected-action" ||
    target.id === "bookmarklet-link" ||
    Boolean(target.closest("[data-ui-attach-ignore]"));

  if (bookmarkletLink) {
    bookmarkletLink.href = createUiAttachBookmarklet({
      moduleUrl: new URL("/ui-attach-runtime.js", root.location.href).href,
    });
    bookmarkletLink.setAttribute("aria-pressed", "false");
    bindBookmarkletStatus(root, bookmarkletLink, output);
  }

  const picker = createUiAttachPicker({
    root,
    surface,
    isSelectableTarget: (target) => !isDemoControl(target) && !target.closest("aside"),
    onCancel: () => {
      action.setAttribute("aria-pressed", "false");
      bundleAction?.setAttribute("aria-pressed", "false");
    },
    onSelect: ({ attachment, markdown, target }) => {
      action.setAttribute("aria-pressed", "false");
      bundleAction?.setAttribute("aria-pressed", "false");
      latestAttachment = attachment;
      latestMarkdown = markdown;
      renderPreview(root, target, attachment);
      output.textContent = "";
      void replaySelection(root, surface, attachment).then((result) => {
        const replayedAttachment = applyReplayResult(attachment, result);
        latestAttachment = replayedAttachment;
        latestMarkdown = serializeAttachmentMarkdown(replayedAttachment);
        renderReplayPreview(root, result);
      });
    },
    onSubmit: ({ attachment, intent, markdown }) => {
      const exportAttachment = latestAttachment?.id === attachment.id ? latestAttachment : attachment;
      const exportMarkdown =
        latestAttachment?.id === attachment.id ? latestMarkdown : serializeAttachmentMarkdown(exportAttachment);
      if (pickerMode === "bundle") {
        pickerMode = "single";
        const label = formatBundleLabel(bundleAttachmentIds.length);
        const record = createDemoOriginRecord(root, exportAttachment, exportMarkdown, intent);
        const result = captureHub.addAttachment(bundleSession.id, record, { labels: [label] });
        if (!result.ok) {
          output.textContent = result.error;
          return;
        }

        bundleAttachmentIds.push(result.item.id);
        renderBundleList(root, bundleList, captureHub, bundleSession.id);
        const bundle = captureHub.buildPromptBundle({
          sessionId: bundleSession.id,
          attachmentIds: bundleAttachmentIds,
          intent,
        });
        if (!bundle.ok) {
          output.textContent = bundle.error;
          return;
        }

        output.textContent = bundle.markdown;
        return;
      }

      output.textContent = intent
        ? ["## User Intent", "", intent, "", exportMarkdown].join("\n")
        : exportMarkdown || markdown;
    },
  });

  action.addEventListener("click", () => {
    armPicker("single");
  });

  bundleAction?.addEventListener("click", () => {
    armPicker("bundle");
  });

  function armPicker(mode: "single" | "bundle"): void {
    pickerMode = mode;
    injectedRuntime?.cancel();
    injectedAction?.setAttribute("aria-pressed", "false");
    picker.startComment();
    action?.setAttribute("aria-pressed", String(mode === "single"));
    bundleAction?.setAttribute("aria-pressed", String(mode === "bundle"));
  }

  if (injectedAction) {
    const runtime = createUiAttachInjectedRuntime({
      root,
      surface,
      isSelectableTarget: (target) => !isDemoControl(target) && !target.closest("aside"),
      labels: {
        placeholder: "Describe what the injected runtime should capture",
        submit: "Export attachment",
      },
      onCancel: () => {
        injectedAction.setAttribute("aria-pressed", "false");
      },
      onExport: ({ attachment, markdown, json, target }) => {
        injectedAction.setAttribute("aria-pressed", "false");
        renderPreview(root, target, attachment);
        output.textContent = [
          "## Injected Runtime Export",
          "",
          "### JSON",
          "```json",
          json,
          "```",
          "",
          "### Markdown",
          markdown,
        ].join("\n");
      },
    });
    injectedRuntime = runtime;

    injectedAction.addEventListener("click", () => {
      picker.cancel();
      action.setAttribute("aria-pressed", "false");
      bundleAction?.setAttribute("aria-pressed", "false");
      runtime.arm();
      injectedAction.setAttribute("aria-pressed", "true");
    });
  }
}

function createDemoOriginRecord(
  root: Document,
  attachment: UIAttachment,
  markdown: string,
  intent: string,
): OriginCaptureRecordLike {
  return {
    origin: root.location.origin,
    pageUrl: attachment.source.url ?? root.location.href,
    pageTitle: root.title || null,
    attachment,
    intent,
    markdown,
    capturedAt: attachment.capturedAt,
  };
}

function renderBundleList(
  root: Document,
  bundleList: HTMLElement | null,
  captureHub: ReturnType<typeof createCaptureHub>,
  sessionId: string,
): void {
  if (!bundleList) {
    return;
  }

  const summary = captureHub.summarizeSession(sessionId);
  if (!summary.ok) {
    bundleList.textContent = summary.error;
    return;
  }

  bundleList.replaceChildren(
    ...summary.items.map((item, index) => {
      const row = root.createElement("div");
      const label = root.createElement("strong");
      const target = root.createElement("span");
      const replay = root.createElement("span");

      row.setAttribute("data-ui-attach-bundle-item", "true");
      label.textContent = item.labels[0] ?? formatBundleLabel(index);
      target.textContent = item.target;
      replay.textContent = item.replayVerified ? "verified" : "not verified";
      row.append(label, target, replay);
      return row;
    }),
  );
}

function formatBundleLabel(index: number): string {
  let value = index + 1;
  let label = "";
  while (value > 0) {
    value -= 1;
    label = String.fromCharCode(65 + (value % 26)) + label;
    value = Math.floor(value / 26);
  }
  return label;
}

function bindBookmarkletStatus(
  root: Document,
  bookmarkletLink: HTMLAnchorElement,
  output: HTMLPreElement,
): void {
  const view = root.defaultView;
  if (!view) {
    return;
  }

  const setArmed = (armed: boolean): void => {
    bookmarkletLink.setAttribute("aria-pressed", String(armed));
    bookmarkletLink.textContent = armed ? "Bookmarklet armed" : "MeanThis Bookmarklet";
  };

  view.addEventListener("ui-attach:armed", () => setArmed(true));
  view.addEventListener("ui-attach:cancel", () => setArmed(false));
  view.addEventListener("ui-attach:export", (event) => {
    const detail = getBookmarkletExportDetail(event);
    if (!detail) {
      return;
    }

    setArmed(false);
    output.textContent = [
      "## Bookmarklet Runtime Export",
      "",
      "### JSON",
      "```json",
      detail.json,
      "```",
      "",
      "### Markdown",
      detail.markdown,
    ].join("\n");
  });
}

function getBookmarkletExportDetail(event: Event): {
  attachment: unknown;
  intent: string;
  json: string;
  markdown: string;
} | null {
  const detail = event instanceof CustomEvent ? event.detail : null;
  if (
    !detail ||
    typeof detail.intent !== "string" ||
    typeof detail.json !== "string" ||
    typeof detail.markdown !== "string"
  ) {
    return null;
  }

  return detail;
}

async function replaySelection(
  root: Document,
  surface: HTMLElement,
  attachment: UIAttachment,
): Promise<LocatorReplayResult> {
  return verifyAttachmentLocator(createDomReplayPage(root, surface), attachment);
}

if (typeof document !== "undefined" && document.body.hasAttribute("data-ui-attach-demo")) {
  attachDemoSelection(document);
}

function renderPreview(root: Document, target: HTMLElement, attachment: UIAttachment): void {
  const preview = root.querySelector<HTMLElement>("#preview");
  if (!preview) {
    return;
  }

  const bounds = attachment.element.bbox;
  const visual = root.createElement("div");
  visual.setAttribute("data-ui-attach-preview-visual", "true");
  visual.append(createElementPreview(root, target, attachment.id, bounds));

  preview.replaceChildren(
    visual,
    previewRow(root, "Tag", attachment.element.tagName),
    previewRow(root, "Role", attachment.element.role ?? "none"),
    previewRow(root, "Text", attachment.element.text ?? "none"),
    previewRow(
      root,
      "Bounds",
      `x=${bounds.x} y=${bounds.y} width=${bounds.width} height=${bounds.height}`,
    ),
    previewRow(
      root,
      "Selectors",
      attachment.context.selectorHints.length ? attachment.context.selectorHints.join(", ") : "none",
    ),
  );
}

function renderReplayPreview(root: Document, result: LocatorReplayResult): void {
  const preview = root.querySelector<HTMLElement>("#preview");
  if (!preview) {
    return;
  }

  preview.querySelector("[data-ui-attach-replay-panel]")?.remove();

  const panel = root.createElement("div");
  const status = root.createElement("div");
  const attempts = root.createElement("ol");

  panel.setAttribute("data-ui-attach-replay-panel", "true");
  status.setAttribute("data-ui-attach-replay-status", "true");
  status.textContent = result.replayVerified
    ? `Replay verified by ${result.matchedBy ?? "unknown"}`
    : `Replay failed: ${result.failureReason ?? "unknown"}`;

  result.attempts.forEach((attempt) => {
    const item = root.createElement("li");
    item.setAttribute("data-ui-attach-replay-attempt", "true");
    item.textContent = attempt.replayVerified
      ? `${attempt.strategy}: verified`
      : `${attempt.strategy}: ${attempt.failureReason ?? "not verified"}`;
    attempts.append(item);
  });

  panel.append(status, attempts);
  preview.append(panel);
}

function createElementPreview(
  root: Document,
  selected: HTMLElement,
  attachmentId: string,
  bounds: UIAttachment["element"]["bbox"],
): HTMLElement {
  if (!selected.isConnected) {
    const fallback = root.createElement("span");
    fallback.textContent = attachmentId;
    return fallback;
  }

  const clone = selected.cloneNode(true) as HTMLElement;
  clone.removeAttribute("id");
  clone.removeAttribute("data-ui-attach-selected");
  clone.setAttribute("data-ui-attach-preview-clone", "true");
  clone.querySelectorAll("[id]").forEach((node) => node.removeAttribute("id"));
  clone.querySelectorAll("[data-ui-attach-selected]").forEach((node) => {
    node.removeAttribute("data-ui-attach-selected");
  });
  freezePreviewStyle(selected, clone, bounds);
  syncFormState(selected, clone);

  return clone;
}

function freezePreviewStyle(
  source: HTMLElement,
  clone: HTMLElement,
  bounds: UIAttachment["element"]["bbox"],
): void {
  const style = getComputedStyle(source);
  const cloneStyle = clone.style;

  cloneStyle.width = `${bounds.width}px`;
  cloneStyle.height = `${bounds.height}px`;
  cloneStyle.boxSizing = style.boxSizing;
  cloneStyle.display = normalizedPreviewDisplay(style.display);
  cloneStyle.alignItems = "center";
  cloneStyle.justifyContent = "center";
  cloneStyle.backgroundColor = style.backgroundColor;
  cloneStyle.borderColor = style.borderColor;
  cloneStyle.borderRadius = style.borderRadius;
  cloneStyle.borderStyle = style.borderStyle;
  cloneStyle.borderWidth = style.borderWidth;
  cloneStyle.color = style.color;
  cloneStyle.font = style.font;
  cloneStyle.fontFamily = style.fontFamily;
  cloneStyle.fontSize = style.fontSize;
  cloneStyle.fontWeight = style.fontWeight;
  cloneStyle.lineHeight = style.lineHeight;
  cloneStyle.padding = style.padding;
  cloneStyle.margin = "0";
  cloneStyle.maxWidth = "100%";
}

function normalizedPreviewDisplay(display: string): string {
  if (display.includes("flex")) {
    return display;
  }

  if (display === "inline-block" || display === "inline" || display === "block") {
    return "inline-flex";
  }

  return display || "inline-flex";
}

function syncFormState(source: HTMLElement, clone: HTMLElement): void {
  if (source instanceof HTMLInputElement && clone instanceof HTMLInputElement) {
    clone.value = source.value;
  }

  const sourceFields = source.querySelectorAll("input, textarea, select");
  const cloneFields = clone.querySelectorAll("input, textarea, select");
  sourceFields.forEach((sourceField, index) => {
    const cloneField = cloneFields.item(index);
    if (sourceField instanceof HTMLInputElement && cloneField instanceof HTMLInputElement) {
      cloneField.value = sourceField.value;
    }
    if (sourceField instanceof HTMLTextAreaElement && cloneField instanceof HTMLTextAreaElement) {
      cloneField.value = sourceField.value;
    }
    if (sourceField instanceof HTMLSelectElement && cloneField instanceof HTMLSelectElement) {
      cloneField.value = sourceField.value;
    }
  });
}

function previewRow(root: Document, label: string, value: string): HTMLElement {
  const row = root.createElement("div");
  const labelNode = root.createElement("strong");
  const valueNode = root.createElement("span");

  row.setAttribute("data-ui-attach-preview-row", "true");
  labelNode.textContent = label;
  valueNode.textContent = value;
  row.append(labelNode, valueNode);

  return row;
}
