import { serializeAttachmentMarkdown } from "@meanthis/prompt";
import type { UIAttachment, UIAttachmentDisclosureMode } from "@meanthis/schema";
import { extractElementAttachment } from "@meanthis/web-extractor";

export interface UiAttachPickerSelectEvent {
  attachment: UIAttachment;
  markdown: string;
  target: HTMLElement;
}

export interface UiAttachPickerSubmitEvent extends UiAttachPickerSelectEvent {
  intent: string;
}

export interface UiAttachPickerOptions {
  root?: Document;
  surface?: HTMLElement | string;
  onCancel?: () => void;
  onSelect?: (event: UiAttachPickerSelectEvent) => void;
  onSubmit: (event: UiAttachPickerSubmitEvent) => void;
  disclosureMode?: UIAttachmentDisclosureMode;
  isSelectableTarget?: (target: HTMLElement) => boolean;
  labels?: {
    cancel?: string;
    placeholder?: string;
    submit?: string;
  };
}

export interface UiAttachPicker {
  cancel: () => void;
  destroy: () => void;
  startComment: () => void;
}

export interface UiAttachInjectedRuntimeExportEvent extends UiAttachPickerSubmitEvent {
  json: string;
}

export interface UiAttachInjectedRuntimeOptions {
  root?: Document;
  surface?: HTMLElement | string;
  onCancel?: () => void;
  onExport: (event: UiAttachInjectedRuntimeExportEvent) => void;
  disclosureMode?: UIAttachmentDisclosureMode;
  isSelectableTarget?: (target: HTMLElement) => boolean;
  labels?: UiAttachPickerOptions["labels"];
}

export interface UiAttachInjectedRuntime {
  arm: () => void;
  cancel: () => void;
  destroy: () => void;
}

export interface UiAttachBookmarkletOptions {
  moduleUrl: string;
  runtimeKey?: string;
  lastExportKey?: string;
  armedEventName?: string;
  cancelEventName?: string;
  eventName?: string;
}

interface PickerState {
  armed: boolean;
  attachment: UIAttachment | null;
  host: HTMLElement;
  markdown: string;
  selectedElement: HTMLElement | null;
  selectedStyle: SelectedStyleSnapshot | null;
}

interface SelectedStyleSnapshot {
  boxShadow: string;
  outline: string;
  outlineOffset: string;
}

const DEFAULT_LABELS = {
  cancel: "Cancel",
  placeholder: "Describe the change you want",
  submit: "Add to prompt",
};

export function createUiAttachPicker(options: UiAttachPickerOptions): UiAttachPicker {
  const root = options.root ?? document;
  const labels = { ...DEFAULT_LABELS, ...options.labels };
  const host = root.createElement("div");
  host.setAttribute("data-ui-attach-picker-host", "true");
  host.style.position = "fixed";
  host.style.zIndex = "2147483647";
  host.style.display = "none";
  host.style.left = "0";
  host.style.top = "0";
  host.style.width = "min(360px, calc(100vw - 32px))";
  host.attachShadow({ mode: "open" });
  root.body.append(host);

  const state: PickerState = {
    armed: false,
    attachment: null,
    host,
    markdown: "",
    selectedElement: null,
    selectedStyle: null,
  };

  const handleDocumentClick = (event: MouseEvent): void => {
    if (!state.armed) {
      return;
    }

    const target = getComposedTarget(root, event);
    if (!isSelectableTarget(root, target, host, options)) {
      return;
    }

    event.preventDefault();
    event.stopImmediatePropagation();

    state.armed = false;
    setSelectedElement(state, target);
    state.attachment = extractElementAttachment(target, {
      disclosureMode: options.disclosureMode,
    });
    state.markdown = serializeAttachmentMarkdown(state.attachment);
    options.onSelect?.({
      attachment: state.attachment,
      markdown: state.markdown,
      target,
    });
    renderComposer(root, state, labels, options);
  };

  root.addEventListener("click", handleDocumentClick, { capture: true });

  return {
    cancel: () => cancelPicker(state, options, true),
    destroy: () => {
      cancelPicker(state, options, false);
      root.removeEventListener("click", handleDocumentClick, { capture: true });
      host.remove();
    },
    startComment: () => {
      state.armed = true;
    },
  };
}

export function createUiAttachInjectedRuntime(
  options: UiAttachInjectedRuntimeOptions,
): UiAttachInjectedRuntime {
  const picker = createUiAttachPicker({
    root: options.root,
    surface: options.surface,
    onCancel: options.onCancel,
    onSubmit: (event) => {
      options.onExport({
        ...event,
        json: JSON.stringify(event.attachment, null, 2),
      });
    },
    disclosureMode: options.disclosureMode,
    isSelectableTarget: options.isSelectableTarget,
    labels: options.labels,
  });

  return {
    arm: picker.startComment,
    cancel: picker.cancel,
    destroy: picker.destroy,
  };
}

export function createUiAttachBookmarklet(options: UiAttachBookmarkletOptions): string {
  const moduleUrl = normalizeBookmarkletModuleUrl(options.moduleUrl);
  const runtimeKey = options.runtimeKey ?? "__uiAttachRuntime";
  const lastExportKey = options.lastExportKey ?? "__uiAttachLastExport";
  const armedEventName = options.armedEventName ?? "ui-attach:armed";
  const cancelEventName = options.cancelEventName ?? "ui-attach:cancel";
  const eventName = options.eventName ?? "ui-attach:export";
  const source = `void (async () => {
  const w = window;
  const moduleUrl = ${JSON.stringify(moduleUrl)};
  const runtimeKey = ${JSON.stringify(runtimeKey)};
  const runtimeConfigKey = runtimeKey + "Config";
  const lastExportKey = ${JSON.stringify(lastExportKey)};
  const armedEventName = ${JSON.stringify(armedEventName)};
  const cancelEventName = ${JSON.stringify(cancelEventName)};
  const eventName = ${JSON.stringify(eventName)};
  const configSignature = JSON.stringify({ moduleUrl, lastExportKey, cancelEventName, eventName });
  const statusSelector = "[data-ui-attach-bookmarklet-status]";
  const hideBookmarkletStatus = () => {
    w.document?.querySelector(statusSelector)?.remove();
  };
  const showBookmarkletStatus = () => {
    if (!w.document?.body) {
      return;
    }
    hideBookmarkletStatus();
    const status = w.document.createElement("div");
    status.setAttribute("data-ui-attach-bookmarklet-status", "true");
    status.textContent = "ui-attach armed: Click an element";
    Object.assign(status.style, {
      position: "fixed",
      right: "16px",
      bottom: "16px",
      zIndex: "2147483647",
      padding: "10px 12px",
      borderRadius: "6px",
      color: "#10213f",
      background: "#ffc247",
      boxShadow: "0 12px 28px rgba(15, 23, 42, 0.24)",
      font: "13px/1.4 ui-sans-serif, system-ui, sans-serif",
      pointerEvents: "none",
    });
    w.document.body.append(status);
  };
  const isUiAttachRuntime = (candidate) =>
    !!candidate &&
    typeof candidate.arm === "function" &&
    typeof candidate.cancel === "function" &&
    typeof candidate.destroy === "function";
  const mod = await import(moduleUrl);
  const createRuntime = mod.createUiAttachInjectedRuntime;
  if (typeof createRuntime !== "function") {
    throw new Error("[ui-attach] module does not export createUiAttachInjectedRuntime");
  }
  const existingRuntime = w[runtimeKey];
  const shouldReuseRuntime =
    isUiAttachRuntime(existingRuntime) && w[runtimeConfigKey] === configSignature;
  if (isUiAttachRuntime(existingRuntime) && !shouldReuseRuntime) {
    hideBookmarkletStatus();
    existingRuntime.destroy();
  }
  const runtime = shouldReuseRuntime ? existingRuntime : (w[runtimeKey] = createRuntime({
    isSelectableTarget(target) {
      return !target.closest(statusSelector);
    },
    onCancel() {
      hideBookmarkletStatus();
      w.dispatchEvent(new CustomEvent(cancelEventName));
    },
    onExport(event) {
      const detail = {
        attachment: event.attachment,
        intent: event.intent,
        markdown: event.markdown,
        json: event.json,
      };
      hideBookmarkletStatus();
      w[lastExportKey] = detail;
      w.dispatchEvent(new CustomEvent(eventName, { detail }));
      console.info("[ui-attach] export ready", detail);
    },
  }));
  w[runtimeConfigKey] = configSignature;
  runtime.arm();
  showBookmarkletStatus();
  w.dispatchEvent(new CustomEvent(armedEventName));
  console.info("[ui-attach] capture armed");
})().catch((error) => {
  console.error("[ui-attach] bookmarklet failed", error);
});`;

  return `javascript:${encodeURIComponent(source)}`;
}

function isSelectableTarget(
  root: Document,
  target: EventTarget | null,
  host: HTMLElement,
  options: UiAttachPickerOptions,
): target is HTMLElement {
  if (!isRootHtmlElement(root, target) || isComposedWithin(root, host, target)) {
    return false;
  }

  const surface = resolveSurface(root, options.surface);
  if (options.surface !== undefined && !surface) {
    return false;
  }
  if (surface && (target === surface || !isComposedWithin(root, surface, target))) {
    return false;
  }

  if (options.isSelectableTarget && !options.isSelectableTarget(target)) {
    return false;
  }

  return target !== root.body && target !== root.documentElement;
}

function getComposedTarget(root: Document, event: MouseEvent): EventTarget | null {
  return (
    event.composedPath().find((candidate) => isRootHtmlElement(root, candidate)) ?? event.target
  );
}

function isComposedWithin(root: Document, container: HTMLElement, target: HTMLElement): boolean {
  let current: Node | null = target;
  while (current) {
    if (current === container) {
      return true;
    }
    if (current.parentNode) {
      current = current.parentNode;
      continue;
    }
    const shadowHost: Element | null = (current as ShadowRoot).host ?? null;
    current = isRootHtmlElement(root, shadowHost) ? shadowHost : null;
  }
  return false;
}

function resolveSurface(root: Document, surface: HTMLElement | string | undefined): HTMLElement | null {
  if (!surface) {
    return null;
  }

  if (typeof surface === "string") {
    const found = root.querySelector(surface);
    return isRootHtmlElement(root, found) ? found : null;
  }

  return isRootHtmlElement(root, surface) ? surface : null;
}

function isRootHtmlElement(root: Document, value: EventTarget | null): value is HTMLElement {
  if (!value || typeof value !== "object") {
    return false;
  }

  const candidate = value as HTMLElement;
  if (candidate.ownerDocument !== root) {
    return false;
  }

  const HTMLElementCtor = root.defaultView?.HTMLElement;
  if (HTMLElementCtor) {
    return value instanceof HTMLElementCtor;
  }

  return (
    candidate.nodeType === 1 &&
    candidate.namespaceURI === "http://www.w3.org/1999/xhtml" &&
    typeof candidate.setAttribute === "function" &&
    candidate.style !== undefined
  );
}

function setSelectedElement(state: PickerState, target: HTMLElement): void {
  restoreSelectedElement(state);
  state.selectedElement = target;
  state.selectedStyle = {
    boxShadow: target.style.boxShadow,
    outline: target.style.outline,
    outlineOffset: target.style.outlineOffset,
  };
  target.setAttribute("data-ui-attach-selected", "true");
  target.style.outline = "3px solid #ffc247";
  target.style.outlineOffset = "3px";
  target.style.boxShadow = "0 0 0 6px rgba(255, 194, 71, 0.24)";
}

function restoreSelectedElement(state: PickerState): void {
  if (!state.selectedElement) {
    return;
  }

  state.selectedElement.removeAttribute("data-ui-attach-selected");
  if (state.selectedStyle) {
    state.selectedElement.style.outline = state.selectedStyle.outline;
    state.selectedElement.style.outlineOffset = state.selectedStyle.outlineOffset;
    state.selectedElement.style.boxShadow = state.selectedStyle.boxShadow;
  }
  state.selectedElement = null;
  state.selectedStyle = null;
}

function renderComposer(
  root: Document,
  state: PickerState,
  labels: typeof DEFAULT_LABELS,
  options: UiAttachPickerOptions,
): void {
  const shadow = state.host.shadowRoot;
  if (!shadow || !state.selectedElement || !state.attachment) {
    return;
  }

  const composer = root.createElement("form");
  const style = root.createElement("style");
  const note = root.createElement("textarea");
  const actions = root.createElement("div");
  const cancel = root.createElement("button");
  const submit = root.createElement("button");

  composer.setAttribute("data-ui-attach-composer", "true");
  composer.setAttribute("aria-label", "UI attachment comment");
  note.placeholder = labels.placeholder;
  note.rows = 4;
  actions.className = "actions";
  cancel.type = "button";
  cancel.textContent = labels.cancel;
  submit.type = "submit";
  submit.textContent = labels.submit;
  submit.setAttribute("data-ui-attach-submit", "true");
  actions.append(cancel, submit);
  composer.append(note, actions);
  style.textContent = pickerCss();
  shadow.replaceChildren(style, composer);

  cancel.addEventListener("click", () => cancelPicker(state, options, true));
  composer.addEventListener("submit", (event) => {
    event.preventDefault();
    submitCurrentSelection(state, note.value, options);
  });

  positionHost(state.host, state.selectedElement.getBoundingClientRect());
  state.host.style.display = "block";
  note.focus();
}

function submitCurrentSelection(
  state: PickerState,
  intentValue: string,
  options: UiAttachPickerOptions,
): void {
  if (!state.attachment || !state.selectedElement || !state.markdown) {
    return;
  }

  const intent = intentValue.trim();
  const markdown = intent
    ? ["## User Intent", "", intent, "", state.markdown].join("\n")
    : state.markdown;

  options.onSubmit({
    attachment: state.attachment,
    intent,
    markdown,
    target: state.selectedElement,
  });
  state.armed = false;
  state.attachment = null;
  state.markdown = "";
  restoreSelectedElement(state);
  hideComposer(state);
}

function cancelPicker(
  state: PickerState,
  options: UiAttachPickerOptions,
  notify: boolean,
): void {
  state.armed = false;
  state.attachment = null;
  state.markdown = "";
  restoreSelectedElement(state);
  hideComposer(state);
  if (notify) {
    options.onCancel?.();
  }
}

function hideComposer(state: PickerState): void {
  state.host.style.display = "none";
  state.host.shadowRoot?.replaceChildren();
}

function positionHost(host: HTMLElement, rect: DOMRect): void {
  const view = host.ownerDocument.defaultView ?? window;
  const left = Math.round(Math.max(16, Math.min(rect.x + Math.min(rect.width, 24), view.innerWidth - 376)));
  const top = Math.round(Math.max(16, Math.min(rect.y + rect.height + 12, view.innerHeight - 180)));
  host.style.left = `${left}px`;
  host.style.top = `${top}px`;
}

function pickerCss(): string {
  return `
    :host {
      all: initial;
    }

    [data-ui-attach-composer] {
      display: grid;
      width: min(360px, calc(100vw - 32px));
      gap: 10px;
      box-sizing: border-box;
      padding: 14px;
      border-radius: 8px;
      color: #ffffff;
      background: #222222;
      box-shadow: 0 16px 44px rgba(15, 23, 42, 0.26);
      font: 14px/1.45 ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
    }

    textarea {
      min-height: 96px;
      box-sizing: border-box;
      resize: vertical;
      border: 1px solid #5f6673;
      border-radius: 6px;
      padding: 10px;
      color: #ffffff;
      background: #2f2f2f;
      font: inherit;
    }

    .actions {
      display: flex;
      justify-content: flex-end;
      gap: 8px;
    }

    button {
      min-height: 34px;
      border: 1px solid #ffffff;
      border-radius: 6px;
      padding: 0 12px;
      color: #17202a;
      background: #ffffff;
      cursor: pointer;
      font: inherit;
    }

    button[type="button"] {
      color: #ffffff;
      background: transparent;
    }
  `;
}

function normalizeBookmarkletModuleUrl(moduleUrl: string): string {
  const value = moduleUrl.trim();
  if (!value) {
    throw new Error("moduleUrl must be a non-empty absolute http(s) URL");
  }

  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("moduleUrl must be a valid absolute http(s) URL");
  }

  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("moduleUrl must use http: or https:");
  }

  return url.toString();
}
