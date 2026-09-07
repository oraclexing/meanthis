/** Shared page-target overlays used by both the Web SDK and MV3 adapter. */
export type PersistentOverlayDisplayMode = "full" | "hover" | "markers" | "hidden";

export const DEFAULT_PERSISTENT_OVERLAY_DISPLAY_MODE: PersistentOverlayDisplayMode = "hover";

export function sanitizePersistentOverlayDisplayMode(
  value: unknown,
): PersistentOverlayDisplayMode {
  return value === "full" || value === "hover" || value === "markers" || value === "hidden"
    ? value
    : DEFAULT_PERSISTENT_OVERLAY_DISPLAY_MODE;
}
export interface PersistentOverlayAnchor {
  xRatio: number;
  yRatio: number;
}

export interface PersistentOverlayItem {
  itemId: string;
  label: string;
  name?: string;
  taskNote?: string;
  interactive?: boolean;
  target: HTMLElement;
  anchor?: PersistentOverlayAnchor;
}

export interface PersistentOverlayRelationPreview {
  sourceItemId: string;
  referenceItemId: string;
}

export interface PersistentOverlayStatus {
  itemIds: string[];
  markerCount: number;
}

export interface PersistentOverlayController {
  sync(
    items: PersistentOverlayItem[],
    activeItemId: string | null,
    relationPreview?: PersistentOverlayRelationPreview,
  ): void;
  readStatus(): PersistentOverlayStatus;
  refresh(): void;
  setDisplayMode(mode: PersistentOverlayDisplayMode): void;
  setTemporaryHighlight(itemId: string | null): void;
  suppressActionsUntilPointerReentry?(itemId: string): void;
  openEditor(itemId: string): boolean;
  closeEditor(): void;
  setActionsEnabled(enabled: boolean): void;
  dispose(): void;
}

export interface PersistentOverlayControllerOptions {
  root: Document;
  relationRoleLabels?: {
    source: string;
    reference: string;
  };
  actionLabels?: {
    edit?: string;
    remove?: string;
    more?: string;
    open?: string;
    notePresent?: string;
  };
  editor?: {
    taskNoteLabel?: string;
    placeholder?: string;
    cancelLabel?: string;
    saveLabel?: string;
    saveFailedLabel?: string;
    onSave(itemId: string, note: string): void | Promise<void>;
  };
  onEdit?(itemId: string): void;
  onRemove?(itemId: string): void;
  onMore?(itemId: string): void;
  requestAnimationFrame?(callback: FrameRequestCallback): number;
  cancelAnimationFrame?(handle: number): void;
  resizeObserverFactory?(onChange: () => void): OverlayResizeObserver;
  mutationObserverFactory?(onChange: () => void): OverlayMutationObserver;
  initialDisplayMode?: PersistentOverlayDisplayMode;
}

export interface OverlayResizeObserver {
  observe(target: Element): void;
  unobserve(target: Element): void;
  disconnect(): void;
}

export interface OverlayMutationObserver {
  observe(target: Node, options: MutationObserverInit): void;
  disconnect(): void;
}

interface OverlayEntry {
  element: HTMLDivElement;
  visual: HTMLDivElement | null;
  capsule: HTMLDivElement;
  label: HTMLElement;
  noteBadge: HTMLSpanElement;
  actions: HTMLDivElement | null;
  anchor: PersistentOverlayAnchor | null;
  name: string;
  taskNote: string;
  interactive: boolean;
  target: HTMLElement;
  closeActionsTimer: number | null;
  onCapsulePointerEnter: EventListener | null;
  onCapsulePointerLeave: EventListener | null;
  onCapsuleFocusIn: EventListener | null;
  onCapsuleFocusOut: EventListener | null;
}

interface OverlayRect {
  left: number;
  top: number;
  right: number;
  bottom: number;
  width: number;
  height: number;
}

const MARKER_CLOSED_HEIGHT = 28;
const MARKER_ACTION_SIZE = 28;
const MARKER_ACTION_GAP = 2;
const MARKER_ACTION_END_PADDING = 4;
const NOTE_BADGE_EDGE_INSET = 2;

export function createPersistentOverlayController(
  options: PersistentOverlayControllerOptions,
): PersistentOverlayController {
  options.root.querySelectorAll("[data-ui-attach-overlay-root]").forEach((element) => {
    element.remove();
  });
  const rootView = options.root.defaultView;
  if (!rootView) {
    throw new Error("Persistent overlays require a document with a window.");
  }
  const view: Window = rootView;

  const requestFrame = options.requestAnimationFrame ?? (
    typeof view.requestAnimationFrame === "function"
      ? view.requestAnimationFrame.bind(view)
      : (callback: FrameRequestCallback) => view.setTimeout(
          () => callback(view.performance.now()),
          16,
        )
  );
  const cancelFrame = options.cancelAnimationFrame ?? (
    typeof view.cancelAnimationFrame === "function"
      ? view.cancelAnimationFrame.bind(view)
      : (handle: number) => view.clearTimeout(handle)
  );
  const host = options.root.createElement("div");
  const hasActions = Boolean(options.onEdit || options.onRemove || options.onMore);
  let actionsEnabled = hasActions;
  let displayMode = sanitizePersistentOverlayDisplayMode(options.initialDisplayMode);
  host.dataset.uiAttachOverlayRoot = "true";
  host.dataset.uiAttachIgnore = "true";
  host.dataset.actionsEnabled = String(actionsEnabled);
  host.dataset.displayMode = displayMode;
  if (!hasActions) {
    host.setAttribute("aria-hidden", "true");
  }
  Object.assign(host.style, {
    all: "initial",
    position: "fixed",
    inset: "0",
    pointerEvents: "none",
    zIndex: "2147483647",
  });
  const shadow = host.attachShadow({ mode: "open" });
  const style = options.root.createElement("style");
  style.textContent = `
    :host { all: initial; }
    :host([data-actions-enabled="false"]) .ui-attach-actions {
      display: none !important;
      pointer-events: none !important;
    }
    :host([data-actions-enabled="false"]) .ui-attach-marker-capsule {
      width: var(--ui-attach-marker-closed-width, 28px) !important;
      height: 28px !important;
      pointer-events: none !important;
    }
    :host([data-display-mode="hover"]) .ui-attach-overlay-visual,
    :host([data-display-mode="markers"]) .ui-attach-overlay-visual {
      display: none;
    }
    :host([data-display-mode="hover"]) .ui-attach-overlay[data-highlight-visible="true"] .ui-attach-overlay-visual {
      display: block;
    }
    :host([data-display-mode="hidden"]) .ui-attach-overlay {
      display: none !important;
      pointer-events: none !important;
    }
    :host([data-temporary-highlight="true"]) .ui-attach-overlay[data-temporary-preview="true"] {
      display: block !important;
    }
    :host([data-temporary-highlight="true"]) .ui-attach-overlay[data-temporary-preview="true"] .ui-attach-overlay-visual {
      display: block !important;
    }
    .ui-attach-overlay {
      position: fixed;
      z-index: 0;
      box-sizing: border-box;
      pointer-events: none;
    }
    .ui-attach-overlay[data-active="true"] {
      z-index: 1;
    }
    .ui-attach-overlay:focus-within {
      z-index: 2;
    }
    .ui-attach-overlay[data-actions-open="true"] {
      z-index: 3;
    }
    .ui-attach-overlay-visual {
      position: absolute;
      inset: 0;
      box-sizing: border-box;
      pointer-events: none;
      border: 2px solid rgb(80, 146, 255);
      border-radius: 4px;
      background: rgba(80, 146, 255, 0.1);
      box-shadow: 0 0 0 1px rgba(255, 255, 255, 0.82), 0 3px 14px rgba(17, 37, 68, 0.2);
    }
    .ui-attach-overlay[data-active="true"]:not([data-suppressed-active="true"]) .ui-attach-overlay-visual,
    .ui-attach-overlay[data-target-active="true"] .ui-attach-overlay-visual {
      border-color: rgb(255, 174, 45);
      background: rgba(255, 174, 45, 0.14);
      box-shadow: 0 0 0 2px rgba(255, 255, 255, 0.9), 0 4px 18px rgba(17, 37, 68, 0.3);
    }
    .ui-attach-marker-capsule {
      position: absolute;
      z-index: 2;
      top: 0;
      left: 0;
      display: flex;
      width: var(--ui-attach-marker-closed-width, 28px);
      height: 28px;
      align-items: center;
      overflow: hidden;
      pointer-events: auto;
      border-radius: 999px;
      background: rgb(42, 105, 211);
      color: white;
      box-shadow: inset 0 0 0 2px white, 0 2px 7px rgba(17, 37, 68, 0.32);
      box-sizing: border-box;
      transform: translateY(-50%);
      transform-origin: left center;
      transition:
        width 170ms cubic-bezier(0.2, 0.8, 0.2, 1),
        height 170ms cubic-bezier(0.2, 0.8, 0.2, 1),
        background-color 120ms ease;
    }
    .ui-attach-marker-capsule[data-placement="left"] {
      flex-direction: row-reverse;
      transform-origin: right center;
    }
    .ui-attach-overlay[data-actions-open="true"] .ui-attach-marker-capsule,
    .ui-attach-overlay:focus-within .ui-attach-marker-capsule {
      width: var(--ui-attach-marker-open-width, 28px);
      height: 32px;
    }
    .ui-attach-overlay[data-active="true"]:not([data-suppressed-active="true"]) .ui-attach-marker-capsule,
    .ui-attach-overlay[data-hovered="true"] .ui-attach-marker-capsule {
      background: rgb(213, 117, 0);
    }
    .ui-attach-label {
      all: unset;
      position: relative;
      display: grid;
      flex: 0 0 auto;
      min-width: 28px;
      height: 100%;
      padding: 0 7px;
      place-items: center;
      color: inherit;
      font: 700 12px/1 system-ui, sans-serif;
      letter-spacing: 0;
      white-space: nowrap;
      box-sizing: border-box;
    }
    .ui-attach-note-badge {
      position: absolute;
      z-index: 3;
      display: none;
      width: 9px;
      height: 9px;
      pointer-events: none;
      border: 2px solid rgba(255, 255, 255, 0.98);
      border-radius: 999px;
      background: rgb(158, 133, 255);
      box-shadow: 0 1px 3px rgba(17, 20, 30, 0.38);
      box-sizing: border-box;
      transform: translate(-50%, -50%);
    }
    .ui-attach-note-badge[data-visible="true"] {
      display: block;
    }
    button.ui-attach-label {
      pointer-events: auto;
      cursor: pointer;
      -webkit-tap-highlight-color: transparent;
      touch-action: manipulation;
    }
    button.ui-attach-label:focus-visible {
      outline: none;
      border-radius: 999px;
      box-shadow: inset 0 0 0 2px rgba(255, 255, 255, 0.88);
    }
    .ui-attach-actions {
      position: static;
      display: flex;
      flex: 0 0 auto;
      box-sizing: border-box;
      height: 100%;
      align-items: center;
      gap: 2px;
      padding: 2px 4px 2px 0;
      pointer-events: none;
      opacity: 0;
      transform: translateX(-4px);
      transition: opacity 90ms ease, transform 120ms ease;
    }
    .ui-attach-marker-capsule[data-placement="left"] .ui-attach-actions {
      padding: 2px 0 2px 4px;
      transform: translateX(4px);
    }
    .ui-attach-overlay[data-actions-open="true"] .ui-attach-actions,
    .ui-attach-overlay:focus-within .ui-attach-actions {
      opacity: 1;
      transform: translateX(0);
      transition-delay: 55ms;
    }
    .ui-attach-overlay[data-actions-open="true"] .ui-attach-action,
    .ui-attach-overlay:focus-within .ui-attach-action {
      pointer-events: auto;
    }
    .ui-attach-action {
      all: unset;
      display: grid;
      box-sizing: border-box;
      position: relative;
      width: 28px;
      height: 28px;
      margin: 0;
      padding: 0;
      pointer-events: none;
      place-items: center;
      border-radius: 999px;
      color: white;
      background: transparent;
      cursor: pointer;
      transition: color 100ms ease, background-color 100ms ease;
      -webkit-tap-highlight-color: transparent;
      touch-action: manipulation;
    }
    .ui-attach-action:hover {
      color: white;
      background: rgba(255, 255, 255, 0.22);
    }
    .ui-attach-action:focus-visible {
      outline: none;
      box-shadow: inset 0 0 0 2px rgba(255, 255, 255, 0.88);
    }
    .ui-attach-action[data-action="remove"]:hover {
      color: white;
      background: rgba(122, 20, 28, 0.54);
    }
    .ui-attach-action svg {
      width: 17px;
      height: 17px;
      fill: none;
      stroke: currentColor;
      stroke-width: 1.8;
      stroke-linecap: round;
      stroke-linejoin: round;
      pointer-events: none;
    }
    .ui-attach-anchored-editor {
      all: initial;
      position: fixed;
      display: grid;
      box-sizing: border-box;
      width: min(320px, calc(100vw - 16px));
      gap: 12px;
      padding: 14px;
      pointer-events: auto;
      border: 1px solid rgba(153, 163, 184, 0.3);
      border-radius: 14px;
      color: rgb(239, 242, 250);
      background: rgb(17, 20, 30);
      box-shadow: 0 18px 48px rgba(0, 0, 0, 0.34), 0 4px 16px rgba(0, 0, 0, 0.24);
      color-scheme: dark;
      font: 500 14px/1.4 system-ui, sans-serif;
    }
    .ui-attach-editor-heading {
      display: flex;
      min-width: 0;
      align-items: center;
      gap: 8px;
      font: 700 14px/1.25 system-ui, sans-serif;
    }
    .ui-attach-editor-badge {
      display: grid;
      flex: 0 0 auto;
      width: 24px;
      height: 24px;
      place-items: center;
      border-radius: 999px;
      color: white;
      background: rgb(103, 83, 225);
      font: 700 12px/1 system-ui, sans-serif;
    }
    .ui-attach-editor-name {
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .ui-attach-editor-field {
      display: grid;
      gap: 6px;
      color: rgb(203, 210, 226);
      font: 600 12px/1.3 system-ui, sans-serif;
    }
    .ui-attach-editor-textarea {
      box-sizing: border-box;
      width: 100%;
      min-height: 96px;
      resize: vertical;
      padding: 10px 11px;
      border: 1px solid rgb(58, 66, 85);
      border-radius: 10px;
      color: rgb(239, 242, 250);
      background: rgb(11, 14, 22);
      font: 500 14px/1.45 system-ui, sans-serif;
    }
    .ui-attach-editor-textarea:focus-visible {
      outline: 2px solid rgb(124, 107, 244);
      outline-offset: 1px;
    }
    .ui-attach-editor-status {
      min-height: 16px;
      color: rgb(255, 165, 165);
      font: 600 12px/1.3 system-ui, sans-serif;
    }
    .ui-attach-editor-footer {
      display: flex;
      justify-content: flex-end;
      gap: 8px;
    }
    .ui-attach-editor-button {
      box-sizing: border-box;
      min-height: 34px;
      padding: 0 13px;
      border: 1px solid rgb(61, 69, 88);
      border-radius: 9px;
      color: rgb(224, 229, 241);
      background: rgb(27, 31, 44);
      cursor: pointer;
      font: 700 13px/1 system-ui, sans-serif;
    }
    .ui-attach-editor-button[data-primary="true"] {
      border-color: rgb(124, 107, 244);
      color: rgb(16, 14, 27);
      background: rgb(139, 121, 255);
    }
    .ui-attach-editor-button:focus-visible {
      outline: 2px solid rgb(139, 121, 255);
      outline-offset: 2px;
    }
    .ui-attach-editor-button:disabled,
    .ui-attach-editor-textarea:disabled {
      cursor: wait;
      opacity: 0.65;
    }
    @media (prefers-reduced-motion: reduce) {
      .ui-attach-marker-capsule,
      .ui-attach-actions,
      .ui-attach-action {
        transition: none;
      }
    }
    @media (forced-colors: active) {
      .ui-attach-overlay-visual,
      .ui-attach-overlay[data-active="true"] .ui-attach-overlay-visual {
        border-color: Highlight;
        background: transparent;
        box-shadow: none;
      }
      .ui-attach-marker-capsule,
      .ui-attach-overlay[data-active="true"] .ui-attach-marker-capsule {
        border: 1px solid CanvasText;
        color: CanvasText;
        background: Canvas;
        box-shadow: none;
      }
      .ui-attach-label {
        color: inherit;
      }
      .ui-attach-note-badge {
        border-color: Canvas;
        background: Highlight;
        box-shadow: none;
      }
      .ui-attach-action,
      .ui-attach-action:hover,
      .ui-attach-action[data-action="remove"]:hover {
        border: 1px solid ButtonText;
        color: ButtonText;
        background: ButtonFace;
      }
      .ui-attach-label:focus-visible,
      .ui-attach-action:focus-visible {
        outline: 2px solid Highlight;
        outline-offset: -3px;
        box-shadow: none;
      }
      .ui-attach-anchored-editor,
      .ui-attach-editor-textarea,
      .ui-attach-editor-button,
      .ui-attach-editor-button[data-primary="true"] {
        border-color: CanvasText;
        color: CanvasText;
        background: Canvas;
        box-shadow: none;
      }
    }
  `;
  shadow.append(style);
  options.root.documentElement.append(host);

  const entries = new Map<string, OverlayEntry>();
  let disposed = false;
  let pendingFrame: number | null = null;
  let editorElement: HTMLDivElement | null = null;
  let editorItemId: string | null = null;
  let temporaryHighlightItemId: string | null = null;
  let hoveredItemId: string | null = null;
  const pointerReentrySuppressedItemIds = new Set<string>();
  let relationPreviewItemIds = new Set<string>();
  const observedScrollRoots = new Set<ShadowRoot>();

  const scheduleRefresh = (): void => {
    if (disposed || pendingFrame !== null) return;
    pendingFrame = requestFrame(() => {
      pendingFrame = null;
      refresh();
    });
  };
  const resizeObserver = options.resizeObserverFactory?.(scheduleRefresh) ?? (
    typeof ResizeObserver === "function"
      ? new ResizeObserver(() => scheduleRefresh())
      : null
  );
  const mutationObserver = options.mutationObserverFactory?.(scheduleRefresh) ?? (
    typeof MutationObserver === "function"
      ? new MutationObserver(() => scheduleRefresh())
      : null
  );
  let observingMutations = false;

  view.addEventListener("scroll", scheduleRefresh, true);
  view.addEventListener("resize", scheduleRefresh);

  function synchronizeScrollRoots(): void {
    const next = new Set<ShadowRoot>();
    for (const entry of entries.values()) {
      let rootNode: Node = entry.target.getRootNode();
      while (isShadowRoot(rootNode)) {
        next.add(rootNode);
        rootNode = rootNode.host.getRootNode();
      }
    }
    for (const rootNode of observedScrollRoots) {
      if (next.has(rootNode)) continue;
      rootNode.removeEventListener("scroll", scheduleRefresh, true);
      observedScrollRoots.delete(rootNode);
    }
    for (const rootNode of next) {
      if (observedScrollRoots.has(rootNode)) continue;
      rootNode.addEventListener("scroll", scheduleRefresh, true);
      observedScrollRoots.add(rootNode);
    }
  }

  function updateTaskNotePresentation(entry: OverlayEntry): void {
    const hasTaskNote = entry.taskNote.trim().length > 0;
    entry.label.dataset.hasTaskNote = String(hasTaskNote);
    entry.noteBadge.dataset.visible = String(hasTaskNote);
    if (!(entry.label instanceof HTMLButtonElement)) return;
    const openLabel = options.actionLabels?.open ?? "Open actions for annotation";
    const notePresentLabel = options.actionLabels?.notePresent ?? "Has task note";
    const markerLabel = entry.label.textContent ?? "";
    entry.label.setAttribute(
      "aria-label",
      `${openLabel} ${markerLabel}${hasTaskNote ? `; ${notePresentLabel}` : ""}`,
    );
  }

  function sync(
    items: PersistentOverlayItem[],
    activeItemId: string | null,
    relationPreview?: PersistentOverlayRelationPreview,
  ): void {
    if (disposed) return;
    relationPreviewItemIds = relationPreview
      ? new Set([relationPreview.sourceItemId, relationPreview.referenceItemId])
      : new Set();
    const retainedIds = new Set(items.map((item) => item.itemId));
    for (const itemId of pointerReentrySuppressedItemIds) {
      if (!retainedIds.has(itemId)) pointerReentrySuppressedItemIds.delete(itemId);
    }
    for (const [itemId, entry] of entries) {
      if (!retainedIds.has(itemId)) {
        if (editorItemId === itemId) closeEditor();
        resizeObserver?.unobserve(entry.target);
        unbindActionHover(entry);
        entry.element.remove();
        entries.delete(itemId);
      }
    }

    for (const item of items) {
      const interactive = item.interactive !== false;
      let entry = entries.get(item.itemId);
      if (entry && entry.interactive !== interactive) {
        if (editorItemId === item.itemId) closeEditor();
        resizeObserver?.unobserve(entry.target);
        unbindActionHover(entry);
        entry.element.remove();
        entries.delete(item.itemId);
        entry = undefined;
      }
      const created = entry === undefined;
      if (!entry) {
        const element = options.root.createElement("div");
        element.className = "ui-attach-overlay";
        element.dataset.itemId = item.itemId;
        element.dataset.actionsOpen = "false";
        element.style.pointerEvents = "none";
        const visual = options.root.createElement("div");
        visual.className = "ui-attach-overlay-visual";
        visual.setAttribute("aria-hidden", "true");
        const capsule = options.root.createElement("div");
        capsule.className = "ui-attach-marker-capsule";
        capsule.style.pointerEvents = hasActions && interactive ? "auto" : "none";
        for (const eventName of [
          "pointerdown",
          "pointerup",
          "mousedown",
          "mouseup",
          "touchstart",
          "touchend",
          "click",
          "dblclick",
          "contextmenu",
        ]) {
          capsule.addEventListener(eventName, suppressActionEvent);
        }
        const label = hasActions && interactive
          ? options.root.createElement("button")
          : options.root.createElement("span");
        label.className = "ui-attach-label";
        const noteBadge = options.root.createElement("span");
        noteBadge.className = "ui-attach-note-badge";
        noteBadge.dataset.visible = "false";
        noteBadge.setAttribute("aria-hidden", "true");
        if (label instanceof HTMLButtonElement) {
          label.type = "button";
          label.tabIndex = actionsEnabled ? 0 : -1;
          label.setAttribute("aria-expanded", "false");
          for (const eventName of [
            "pointerdown",
            "pointerup",
            "mousedown",
            "mouseup",
            "touchstart",
            "touchend",
            "dblclick",
            "contextmenu",
          ]) {
            label.addEventListener(eventName, suppressActionEvent, { capture: true });
          }
          label.addEventListener("click", (event) => {
            suppressActionEvent(event);
            toggleActions(item.itemId, isPointerClick(event));
          }, { capture: true });
        } else {
          label.setAttribute("aria-hidden", "true");
        }
        const actions = actionsEnabled && interactive
          ? createActionRail(options.root, item.itemId, options, handleEdit, closeActionsForItem)
          : null;
        capsule.append(label);
        if (actions) {
          capsule.append(actions);
        }
        element.append(visual, capsule, noteBadge);
        shadow.append(element);
        entry = {
          element,
          visual,
          capsule,
          label,
          noteBadge,
          actions,
          anchor: normalizeAnchor(item.anchor),
          name: item.name ?? "",
          taskNote: item.taskNote ?? "",
          interactive,
          target: item.target,
          closeActionsTimer: null,
          onCapsulePointerEnter: null,
          onCapsulePointerLeave: null,
          onCapsuleFocusIn: null,
          onCapsuleFocusOut: null,
        };
        if (actions) {
          bindActionHover(entry);
        }
        entries.set(item.itemId, entry);
      }
      if (created) {
        resizeObserver?.observe(item.target);
      } else if (entry.target !== item.target) {
        resizeObserver?.unobserve(entry.target);
        entry.target = item.target;
        resizeObserver?.observe(item.target);
      }
      entry.target = item.target;
      entry.anchor = normalizeAnchor(item.anchor);
      entry.name = item.name ?? "";
      entry.taskNote = item.taskNote ?? "";
      const relationRole = !relationPreview
        ? null
        : item.itemId === relationPreview.sourceItemId
          ? options.relationRoleLabels?.source ?? "Element"
          : item.itemId === relationPreview.referenceItemId
            ? options.relationRoleLabels?.reference ?? "Relative to"
            : null;
      entry.label.textContent = relationRole ? `${item.label} · ${relationRole}` : item.label;
      if (entry.label instanceof HTMLButtonElement) {
        entry.label.removeAttribute("title");
      }
      updateTaskNotePresentation(entry);
      entry.element.dataset.active = (
        relationPreview ? relationRole !== null : item.itemId === activeItemId
      ) ? "true" : "false";
      entry.element.dataset.pointerReentryPending = String(
        pointerReentrySuppressedItemIds.has(item.itemId),
      );
      entry.element.dataset.temporaryPreview = String(item.itemId === temporaryHighlightItemId);
    }
    deduplicateTargetVisuals();
    updateHighlightVisibility();
    if (entries.size > 0 && !observingMutations) {
      mutationObserver?.observe(options.root.documentElement, {
        attributes: true,
        attributeFilter: ["class", "style", "hidden"],
        childList: true,
        characterData: true,
        subtree: true,
      });
      observingMutations = mutationObserver !== null;
    } else if (entries.size === 0 && observingMutations) {
      mutationObserver?.disconnect();
      observingMutations = false;
    }
    synchronizeScrollRoots();
    refresh();
  }

  function refresh(): void {
    if (disposed) return;
    const visibleEntries: Array<{ entry: OverlayEntry; bounds: OverlayRect }> = [];
    for (const entry of entries.values()) {
      if (!entry.target.isConnected) {
        entry.element.style.display = "none";
        setActionsOpen(entry, false);
        continue;
      }
      const bounds = entry.target.getBoundingClientRect();
      if (bounds.width <= 0 || bounds.height <= 0) {
        entry.element.style.display = "none";
        continue;
      }
      if (
        bounds.right <= 0 ||
        bounds.bottom <= 0 ||
        bounds.left >= view.innerWidth ||
        bounds.top >= view.innerHeight
      ) {
        entry.element.style.display = "none";
        continue;
      }
      entry.element.style.display = "block";
      entry.element.style.left = `${bounds.left}px`;
      entry.element.style.top = `${bounds.top}px`;
      entry.element.style.width = `${bounds.width}px`;
      entry.element.style.height = `${bounds.height}px`;
      visibleEntries.push({ entry, bounds });
    }

    const targetBounds = visibleEntries.map(({ bounds }) => bounds);
    const placedLabels: OverlayRect[] = [];
    for (const { entry, bounds } of visibleEntries) {
      const labelBounds = entry.label.getBoundingClientRect();
      const labelWidth = Math.max(MARKER_CLOSED_HEIGHT, labelBounds.width);
      const labelHeight = MARKER_CLOSED_HEIGHT;
      const labelPosition = entry.anchor
        ? chooseAnchoredLabelPosition({
            target: bounds,
            anchor: entry.anchor,
            width: labelWidth,
            height: labelHeight,
            viewportWidth: view.innerWidth,
            viewportHeight: view.innerHeight,
          })
        : chooseLabelPosition({
            target: bounds,
            width: labelWidth,
            height: labelHeight,
            viewportWidth: view.innerWidth,
            viewportHeight: view.innerHeight,
            targetBounds,
            placedLabels,
          });
      if (entry.anchor && pointerReentrySuppressedItemIds.has(
        entry.element.dataset.itemId ?? "",
      )) {
        const captureX = bounds.left + bounds.width * entry.anchor.xRatio;
        const captureY = bounds.top + bounds.height * entry.anchor.yRatio;
        if (
          captureX < labelPosition.left || captureX > labelPosition.right ||
          captureY < labelPosition.top || captureY > labelPosition.bottom
        ) {
          const itemId = entry.element.dataset.itemId;
          if (itemId) pointerReentrySuppressedItemIds.delete(itemId);
          entry.element.dataset.pointerReentryPending = "false";
        }
      }
      positionMarkerCapsule(entry, bounds, labelPosition, labelWidth);
      placedLabels.push(labelPosition);
    }
    if (editorItemId) {
      const editorEntry = entries.get(editorItemId);
      if (!editorEntry || editorEntry.element.style.display === "none") closeEditor();
      else positionEditor(editorEntry);
    }
  }

  function readStatus(): PersistentOverlayStatus {
    if (disposed || !host.isConnected) {
      return { itemIds: [], markerCount: 0 };
    }
    const markers = Array.from(
      shadow.querySelectorAll<HTMLElement>(".ui-attach-marker-capsule"),
    ).filter((marker) => marker.isConnected);
    const itemIds = markers.flatMap((marker) => {
      const itemId = marker.closest<HTMLElement>(".ui-attach-overlay")?.dataset.itemId;
      return itemId ? [itemId] : [];
    }).sort();
    return { itemIds, markerCount: markers.length };
  }

  function positionMarkerCapsule(
    entry: OverlayEntry,
    targetBounds: OverlayRect,
    labelBounds: OverlayRect,
    labelWidth: number,
  ): void {
    const actionCount = entry.actions?.childElementCount ?? 0;
    const actionsWidth = actionCount > 0
      ? actionCount * MARKER_ACTION_SIZE
        + Math.max(0, actionCount - 1) * MARKER_ACTION_GAP
        + MARKER_ACTION_END_PADDING
      : 0;
    const openWidth = labelWidth + actionsWidth;
    const margin = 4;
    const fitsRight = labelBounds.left + openWidth <= view.innerWidth - margin;
    const fitsLeft = labelBounds.right - openWidth >= margin;
    const rightSpace = view.innerWidth - margin - labelBounds.left;
    const leftSpace = labelBounds.right - margin;
    const placement = fitsRight
      ? "right"
      : fitsLeft
        ? "left"
        : rightSpace >= leftSpace ? "right" : "left";

    entry.capsule.dataset.placement = placement;
    entry.capsule.style.setProperty("--ui-attach-marker-closed-width", `${labelWidth}px`);
    entry.capsule.style.setProperty("--ui-attach-marker-open-width", `${openWidth}px`);
    entry.capsule.style.top = `${labelBounds.top + labelBounds.height / 2 - targetBounds.top}px`;
    entry.noteBadge.style.left = `${labelBounds.right - targetBounds.left - NOTE_BADGE_EDGE_INSET}px`;
    entry.noteBadge.style.top = `${labelBounds.top - targetBounds.top + NOTE_BADGE_EDGE_INSET}px`;
    if (placement === "right") {
      entry.capsule.style.left = `${labelBounds.left - targetBounds.left}px`;
      entry.capsule.style.right = "";
    } else {
      entry.capsule.style.left = "auto";
      entry.capsule.style.right = `${targetBounds.right - labelBounds.right}px`;
    }
  }

  function deduplicateTargetVisuals(): void {
    const visualOwnerByTarget = new Map<HTMLElement, OverlayEntry>();
    for (const entry of entries.values()) {
      const owner = visualOwnerByTarget.get(entry.target);
      if (!owner) {
        visualOwnerByTarget.set(entry.target, entry);
        if (!entry.visual) {
          const visual = options.root.createElement("div");
          visual.className = "ui-attach-overlay-visual";
          visual.setAttribute("aria-hidden", "true");
          entry.element.prepend(visual);
          entry.visual = visual;
        }
      } else if (entry.visual) {
        entry.visual.remove();
        entry.visual = null;
      }
    }
  }

  function updateHighlightVisibility(): void {
    const groups = new Map<HTMLElement, OverlayEntry[]>();
    for (const entry of entries.values()) {
      const group = groups.get(entry.target) ?? [];
      group.push(entry);
      groups.set(entry.target, group);
    }
    for (const group of groups.values()) {
      const targetHovered = group.some((entry) => entry.element.dataset.hovered === "true");
      const targetActive = !targetHovered && group.some((entry) => entry.element.dataset.active === "true");
      const visible = group.some((entry) => entry.element.dataset.temporaryPreview === "true") ||
        displayMode === "full" || (
        displayMode === "hover" && group.some((entry) => (
          entry.element.dataset.actionsOpen === "true" ||
          entry.element.dataset.focusActive === "true" ||
          entry.element.dataset.itemId === temporaryHighlightItemId ||
          relationPreviewItemIds.has(entry.element.dataset.itemId ?? "")
        ))
      );
      for (const entry of group) {
        entry.element.dataset.targetActive = String(targetActive);
        entry.element.dataset.suppressedActive = String(targetHovered && entry.element.dataset.active === "true");
        entry.element.dataset.highlightVisible = String(Boolean(entry.visual && visible));
      }
    }
  }

  function dispose(): void {
    if (disposed) return;
    disposed = true;
    if (pendingFrame !== null) {
      cancelFrame(pendingFrame);
      pendingFrame = null;
    }
    view.removeEventListener("scroll", scheduleRefresh, true);
    view.removeEventListener("resize", scheduleRefresh);
    for (const rootNode of observedScrollRoots) {
      rootNode.removeEventListener("scroll", scheduleRefresh, true);
    }
    observedScrollRoots.clear();
    resizeObserver?.disconnect();
    mutationObserver?.disconnect();
    closeEditor();
    for (const entry of entries.values()) {
      unbindActionHover(entry);
    }
    entries.clear();
    pointerReentrySuppressedItemIds.clear();
    host.remove();
  }

  function bindActionHover(entry: OverlayEntry): void {
    const onCapsulePointerEnter = (): void => {
      const itemId = entry.element.dataset.itemId;
      if (itemId && pointerReentrySuppressedItemIds.has(itemId)) return;
      setActionsOpen(entry, true);
    };
    const onCapsulePointerLeave = (event: Event): void => {
      if (isMovingWithinCapsule(entry, event)) return;
      const itemId = entry.element.dataset.itemId;
      if (itemId && pointerReentrySuppressedItemIds.delete(itemId)) {
        entry.element.dataset.pointerReentryPending = "false";
        setActionsOpen(entry, false);
        return;
      }
      scheduleActionsClose(entry);
    };
    const onCapsuleFocusIn = (): void => {
      const itemId = entry.element.dataset.itemId;
      if (itemId) pointerReentrySuppressedItemIds.delete(itemId);
      entry.element.dataset.pointerReentryPending = "false";
      entry.element.dataset.focusActive = "true";
      setActionsOpen(entry, true);
    };
    const onCapsuleFocusOut = (event: Event): void => {
      if (isMovingWithinCapsule(entry, event)) return;
      entry.element.dataset.focusActive = "false";
      scheduleActionsClose(entry);
    };
    entry.onCapsulePointerEnter = onCapsulePointerEnter;
    entry.onCapsulePointerLeave = onCapsulePointerLeave;
    entry.onCapsuleFocusIn = onCapsuleFocusIn;
    entry.onCapsuleFocusOut = onCapsuleFocusOut;
    entry.capsule.addEventListener("pointerenter", onCapsulePointerEnter);
    entry.capsule.addEventListener("pointerleave", onCapsulePointerLeave);
    entry.capsule.addEventListener("focusin", onCapsuleFocusIn);
    entry.capsule.addEventListener("focusout", onCapsuleFocusOut);
  }

  function unbindActionHover(entry: OverlayEntry): void {
    if (entry.onCapsulePointerEnter) {
      entry.capsule.removeEventListener("pointerenter", entry.onCapsulePointerEnter);
    }
    if (entry.onCapsulePointerLeave) {
      entry.capsule.removeEventListener("pointerleave", entry.onCapsulePointerLeave);
    }
    if (entry.onCapsuleFocusIn) {
      entry.capsule.removeEventListener("focusin", entry.onCapsuleFocusIn);
    }
    if (entry.onCapsuleFocusOut) {
      entry.capsule.removeEventListener("focusout", entry.onCapsuleFocusOut);
    }
    if (entry.closeActionsTimer !== null) {
      view.clearTimeout(entry.closeActionsTimer);
      entry.closeActionsTimer = null;
    }
    entry.onCapsulePointerEnter = null;
    entry.onCapsulePointerLeave = null;
    entry.onCapsuleFocusIn = null;
    entry.onCapsuleFocusOut = null;
    entry.element.dataset.focusActive = "false";
    applyActionsOpenState(entry, false);
  }

  function isMovingWithinCapsule(entry: OverlayEntry, event: Event): boolean {
    const relatedTarget = (event as MouseEvent).relatedTarget ?? null;
    return isNode(relatedTarget) && entry.capsule.contains(relatedTarget);
  }

  function setActionsOpen(entry: OverlayEntry, open: boolean): void {
    if (entry.closeActionsTimer !== null) {
      view.clearTimeout(entry.closeActionsTimer);
      entry.closeActionsTimer = null;
    }
    const shouldOpen = Boolean(open && actionsEnabled && entry.actions);
    if (shouldOpen) {
      hoveredItemId = entry.element.dataset.itemId ?? null;
      for (const candidate of entries.values()) {
        candidate.element.dataset.hovered = String(candidate === entry);
      }
    } else if (hoveredItemId === entry.element.dataset.itemId) {
      hoveredItemId = null;
      entry.element.dataset.hovered = "false";
    }
    if (shouldOpen) {
      for (const candidate of entries.values()) {
        if (candidate === entry) continue;
        if (candidate.closeActionsTimer !== null) {
          view.clearTimeout(candidate.closeActionsTimer);
          candidate.closeActionsTimer = null;
        }
        applyActionsOpenState(candidate, false);
      }
    }
    applyActionsOpenState(entry, shouldOpen);
  }

  function applyActionsOpenState(entry: OverlayEntry, open: boolean): void {
    entry.element.dataset.actionsOpen = String(open);
    if (entry.label instanceof HTMLButtonElement) {
      entry.label.setAttribute("aria-expanded", String(open));
    }
    updateHighlightVisibility();
  }

  function scheduleActionsClose(entry: OverlayEntry): void {
    if (entry.closeActionsTimer !== null) view.clearTimeout(entry.closeActionsTimer);
    entry.closeActionsTimer = view.setTimeout(() => {
      entry.closeActionsTimer = null;
      setActionsOpen(entry, false);
    }, 150);
  }

  function allowActionActivation(itemId: string, pointerInitiated: boolean): boolean {
    if (!pointerReentrySuppressedItemIds.has(itemId)) return true;
    const entry = entries.get(itemId);
    if (entry) setActionsOpen(entry, false);
    if (pointerInitiated) return false;
    pointerReentrySuppressedItemIds.delete(itemId);
    if (entry) entry.element.dataset.pointerReentryPending = "false";
    return true;
  }

  function toggleActions(itemId: string, pointerInitiated: boolean): void {
    const entry = entries.get(itemId);
    if (!entry || !actionsEnabled || !entry.actions) return;
    if (!allowActionActivation(itemId, pointerInitiated)) return;
    setActionsOpen(entry, entry.element.dataset.actionsOpen !== "true");
  }

  function setActionsEnabled(enabled: boolean): void {
    const nextActionsEnabled = hasActions && enabled;
    if (actionsEnabled === nextActionsEnabled) return;
    actionsEnabled = nextActionsEnabled;
    host.dataset.actionsEnabled = String(actionsEnabled);
    if (actionsEnabled) host.removeAttribute("aria-hidden");
    else host.setAttribute("aria-hidden", "true");
    for (const [itemId, entry] of entries) {
      if (entry.label instanceof HTMLButtonElement) {
        entry.label.tabIndex = actionsEnabled && displayMode !== "hidden" ? 0 : -1;
      }
      if (actionsEnabled && entry.interactive && !entry.actions) {
        const actions = createActionRail(
          options.root,
          itemId,
          options,
          handleEdit,
          closeActionsForItem,
        );
        entry.actions = actions;
        entry.capsule.append(actions);
        bindActionHover(entry);
      } else if (!actionsEnabled && entry.actions) {
        unbindActionHover(entry);
        entry.actions.remove();
        entry.actions = null;
      }
    }
    refresh();
  }

  function setDisplayMode(mode: PersistentOverlayDisplayMode): void {
    if (disposed) return;
    const nextMode = sanitizePersistentOverlayDisplayMode(mode);
    if (displayMode === nextMode) return;
    displayMode = nextMode;
    host.dataset.displayMode = displayMode;
    if (displayMode === "hidden") {
      pointerReentrySuppressedItemIds.clear();
      const active = shadow.activeElement;
      if (active && shadow.contains(active)) (active as HTMLElement).blur();
      closeEditor();
      for (const entry of entries.values()) {
        entry.element.dataset.pointerReentryPending = "false";
        entry.element.dataset.focusActive = "false";
        setActionsOpen(entry, false);
        if (entry.label instanceof HTMLButtonElement) entry.label.tabIndex = -1;
      }
    } else {
      for (const entry of entries.values()) {
        if (entry.label instanceof HTMLButtonElement) entry.label.tabIndex = actionsEnabled ? 0 : -1;
      }
    }
    updateHighlightVisibility();
    refresh();
  }

  function setTemporaryHighlight(itemId: string | null): void {
    if (temporaryHighlightItemId === itemId) return;
    temporaryHighlightItemId = itemId;
    host.dataset.temporaryHighlight = String(itemId !== null);
    for (const entry of entries.values()) {
      entry.element.dataset.temporaryPreview = String(entry.element.dataset.itemId === itemId);
    }
    updateHighlightVisibility();
  }

  function suppressActionsUntilPointerReentry(itemId: string): void {
    if (disposed) return;
    pointerReentrySuppressedItemIds.add(itemId);
    const entry = entries.get(itemId);
    if (!entry) return;
    entry.element.dataset.pointerReentryPending = "true";
    setActionsOpen(entry, false);
  }

  function handleEdit(itemId: string): void {
    if (options.editor) openEditor(itemId);
    options.onEdit?.(itemId);
  }

  function closeActionsForItem(itemId: string, pointerInitiated: boolean): boolean {
    const entry = entries.get(itemId);
    if (!entry) return false;
    if (!allowActionActivation(itemId, pointerInitiated)) return false;
    setActionsOpen(entry, false);
    return true;
  }

  function openEditor(itemId: string): boolean {
    if (disposed || !options.editor) return false;
    const entry = entries.get(itemId);
    if (!entry || !entry.interactive || !entry.target.isConnected) return false;
    closeEditor();

    const editor = options.root.createElement("div");
    editor.className = "ui-attach-anchored-editor";
    editor.dataset.uiAttachAnchoredEditor = "true";
    editor.dataset.itemId = itemId;
    editor.setAttribute("role", "dialog");
    editor.setAttribute("aria-modal", "false");

    const heading = options.root.createElement("div");
    heading.className = "ui-attach-editor-heading";
    const badge = options.root.createElement("span");
    badge.className = "ui-attach-editor-badge";
    badge.textContent = entry.label.textContent ?? "";
    const name = options.root.createElement("span");
    name.className = "ui-attach-editor-name";
    name.textContent = entry.name || `${options.editor.taskNoteLabel ?? "Task note"} ${badge.textContent}`;
    heading.append(badge, name);

    const field = options.root.createElement("label");
    field.className = "ui-attach-editor-field";
    const fieldLabel = options.root.createElement("span");
    fieldLabel.textContent = options.editor.taskNoteLabel ?? "Task note";
    const textarea = options.root.createElement("textarea");
    textarea.className = "ui-attach-editor-textarea";
    textarea.maxLength = 16_384;
    textarea.rows = 4;
    textarea.value = entry.taskNote;
    textarea.placeholder = options.editor.placeholder ?? "Tell the agent what should change…";
    textarea.autocomplete = "off";
    textarea.spellcheck = true;
    field.append(fieldLabel, textarea);

    const status = options.root.createElement("div");
    status.className = "ui-attach-editor-status";
    status.setAttribute("aria-live", "polite");

    const footer = options.root.createElement("div");
    footer.className = "ui-attach-editor-footer";
    const cancel = options.root.createElement("button");
    cancel.type = "button";
    cancel.className = "ui-attach-editor-button";
    cancel.dataset.action = "cancel-note";
    cancel.textContent = options.editor.cancelLabel ?? "Cancel";
    const save = options.root.createElement("button");
    save.type = "button";
    save.className = "ui-attach-editor-button";
    save.dataset.action = "save-note";
    save.dataset.primary = "true";
    save.textContent = options.editor.saveLabel ?? "Save";
    footer.append(cancel, save);
    editor.append(heading, field, status, footer);

    const close = (): void => {
      if (editorElement === editor) closeEditor();
    };
    const saveNote = async (): Promise<void> => {
      const note = sanitizeTaskNote(textarea.value);
      textarea.value = note;
      textarea.disabled = true;
      cancel.disabled = true;
      save.disabled = true;
      status.textContent = "";
      try {
        await options.editor?.onSave(itemId, note);
        entry.taskNote = note;
        updateTaskNotePresentation(entry);
        close();
      } catch {
        textarea.disabled = false;
        cancel.disabled = false;
        save.disabled = false;
        status.textContent = options.editor?.saveFailedLabel ?? "Task note was not saved.";
        textarea.focus();
      }
    };
    cancel.addEventListener("click", (event) => {
      suppressActionEvent(event);
      close();
    }, { capture: true });
    save.addEventListener("click", (event) => {
      suppressActionEvent(event);
      void saveNote();
    }, { capture: true });
    editor.addEventListener("keydown", (event) => {
      event.stopPropagation();
      if (event.key === "Escape") {
        event.preventDefault();
        close();
      } else if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) {
        event.preventDefault();
        void saveNote();
      }
    }, { capture: true });
    for (const eventName of ["pointerdown", "pointerup", "click", "dblclick", "contextmenu"] ) {
      editor.addEventListener(eventName, stopActionEventPropagation);
    }

    editorElement = editor;
    editorItemId = itemId;
    shadow.append(editor);
    positionEditor(entry);
    textarea.focus();
    return true;
  }

  function closeEditor(): void {
    editorElement?.remove();
    editorElement = null;
    editorItemId = null;
  }

  function positionEditor(entry: OverlayEntry): void {
    if (!editorElement) return;
    const targetBounds = entry.target.getBoundingClientRect();
    const labelBounds = entry.label.getBoundingClientRect();
    const bounds = labelBounds.width > 0 && labelBounds.height > 0
      ? labelBounds
      : targetBounds;
    const gap = 10;
    const margin = 8;
    const width = Math.min(320, Math.max(240, view.innerWidth - margin * 2));
    const estimatedHeight = 222;
    let left = bounds.right + gap;
    if (left + width > view.innerWidth - margin) left = bounds.left - width - gap;
    if (left < margin) left = Math.min(
      Math.max(margin, bounds.left),
      Math.max(margin, view.innerWidth - width - margin),
    );
    let top = bounds.top;
    if (top + estimatedHeight > view.innerHeight - margin) {
      top = Math.max(margin, view.innerHeight - estimatedHeight - margin);
    }
    editorElement.style.width = `${width}px`;
    editorElement.style.left = `${Math.round(left)}px`;
    editorElement.style.top = `${Math.round(top)}px`;
  }

  return {
    sync,
    readStatus,
    refresh,
    setDisplayMode,
    setTemporaryHighlight,
    suppressActionsUntilPointerReentry,
    openEditor,
    closeEditor,
    setActionsEnabled,
    dispose,
  };
}

function createActionRail(
  root: Document,
  itemId: string,
  options: PersistentOverlayControllerOptions,
  handleEdit: (itemId: string) => void,
  beforeAction: (itemId: string, pointerInitiated: boolean) => boolean,
): HTMLDivElement {
  const actions = root.createElement("div");
  actions.className = "ui-attach-actions";
  actions.setAttribute("role", "group");
  actions.style.pointerEvents = "none";
  const specs: Array<{
    action: "edit" | "remove" | "more";
    label: string;
    callback: ((selectedItemId: string) => void) | undefined;
  }> = [
    {
      action: "edit",
      label: options.actionLabels?.edit ?? "Edit selected element",
      callback: options.onEdit || options.editor ? handleEdit : undefined,
    },
    {
      action: "remove",
      label: options.actionLabels?.remove ?? "Remove selected element",
      callback: options.onRemove,
    },
    {
      action: "more",
      label: options.actionLabels?.more ?? "Show annotation details",
      callback: options.onMore,
    },
  ];
  for (const spec of specs) {
    if (!spec.callback) continue;
    const button = root.createElement("button");
    button.type = "button";
    button.className = "ui-attach-action";
    button.dataset.action = spec.action;
    button.setAttribute("aria-label", spec.label);
    button.append(createActionIcon(root, spec.action));
    for (const eventName of [
      "pointerdown",
      "pointerup",
      "mousedown",
      "mouseup",
      "touchstart",
      "touchend",
      "dblclick",
      "contextmenu",
    ]) {
      button.addEventListener(eventName, suppressActionEvent, { capture: true });
    }
    button.addEventListener("keydown", stopActionEventPropagation, { capture: true });
    button.addEventListener("keyup", stopActionEventPropagation, { capture: true });
    button.addEventListener("click", (event) => {
      suppressActionEvent(event);
      if (!beforeAction(itemId, isPointerClick(event))) return;
      spec.callback?.(itemId);
    }, { capture: true });
    actions.append(button);
  }
  return actions;
}

function createActionIcon(
  root: Document,
  action: "edit" | "remove" | "more",
): SVGSVGElement {
  const namespace = "http://www.w3.org/2000/svg";
  const svg = root.createElementNS(namespace, "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("aria-hidden", "true");
  svg.setAttribute("focusable", "false");
  svg.dataset.icon = action;
  const paths: Record<typeof action, string[]> = {
    edit: [
      "M4 20h4l11-11a2.8 2.8 0 0 0-4-4L4 16v4Z",
      "m13-13 4 4",
    ],
    remove: [
      "M6 6l12 12",
      "M18 6 6 18",
    ],
    more: [
      "M12 6h.01",
      "M12 12h.01",
      "M12 18h.01",
    ],
  };
  for (const pathData of paths[action]) {
    const path = root.createElementNS(namespace, "path");
    path.setAttribute("d", pathData);
    svg.append(path);
  }
  return svg;
}

function sanitizeTaskNote(value: string): string {
  return value
    .replace(/\r\n?/gu, "\n")
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/gu, "")
    .slice(0, 16_384);
}

function suppressActionEvent(event: Event): void {
  event.preventDefault();
  event.stopPropagation();
}

function stopActionEventPropagation(event: Event): void {
  event.stopPropagation();
}

function isPointerClick(event: Event): boolean {
  return typeof (event as MouseEvent).detail === "number" && (event as MouseEvent).detail > 0;
}

function isNode(target: EventTarget | null): target is Node {
  return target !== null && typeof (target as Node).nodeType === "number";
}

function chooseAnchoredLabelPosition(input: {
  target: OverlayRect;
  anchor: PersistentOverlayAnchor;
  width: number;
  height: number;
  viewportWidth: number;
  viewportHeight: number;
}): OverlayRect {
  const margin = 4;
  const centerX = input.target.left + input.target.width * input.anchor.xRatio;
  const centerY = input.target.top + input.target.height * input.anchor.yRatio;
  return overlayRect(
    clamp(centerX - input.width / 2, margin, Math.max(margin, input.viewportWidth - input.width - margin)),
    clamp(centerY - input.height / 2, margin, Math.max(margin, input.viewportHeight - input.height - margin)),
    input.width,
    input.height,
  );
}

function chooseLabelPosition(input: {
  target: OverlayRect;
  width: number;
  height: number;
  viewportWidth: number;
  viewportHeight: number;
  targetBounds: OverlayRect[];
  placedLabels: OverlayRect[];
}): OverlayRect {
  const margin = 4;
  const gap = 4;
  const { target, width, height } = input;
  const candidateOrigins: Array<{ left: number; top: number }> = [];
  const isWideRow = target.width >= Math.max(160, width * 4, target.height * 4);
  if (isWideRow) {
    const centeredTop = target.top + (target.height - height) / 2;
    candidateOrigins.push(
      { left: target.left - width - gap, top: centeredTop },
      { left: target.right + gap, top: centeredTop },
    );
  }
  const laneCount = Math.min(26, Math.max(4, input.placedLabels.length + 2));
  for (let lane = 0; lane < laneCount; lane += 1) {
    const verticalGap = gap + lane * (height + gap);
    const horizontalGap = gap + lane * (width + gap);
    candidateOrigins.push(
      { left: target.left, top: target.top - height - verticalGap },
      { left: target.right - width, top: target.top - height - verticalGap },
      { left: target.left, top: target.bottom + verticalGap },
      { left: target.right - width, top: target.bottom + verticalGap },
      { left: target.left - width - horizontalGap, top: target.top },
      { left: target.left - width - horizontalGap, top: target.bottom - height },
      { left: target.right + horizontalGap, top: target.top },
      { left: target.right + horizontalGap, top: target.bottom - height },
    );
  }
  const seenCandidates = new Set<string>();
  const candidates = candidateOrigins.flatMap(({ left, top }) => {
    const candidate = overlayRect(
      clamp(left, margin, Math.max(margin, input.viewportWidth - width - margin)),
      clamp(top, margin, Math.max(margin, input.viewportHeight - height - margin)),
      width,
      height,
    );
    const key = `${candidate.left}:${candidate.top}`;
    if (seenCandidates.has(key)) return [];
    seenCandidates.add(key);
    return [candidate];
  });

  let best = candidates[0] ?? overlayRect(margin, margin, width, height);
  let bestScore = Number.POSITIVE_INFINITY;
  candidates.forEach((candidate, priority) => {
    const labelCollisionArea = input.placedLabels.reduce(
      (total, placed) => total + overlapArea(candidate, placed),
      0,
    );
    const targetCollisionArea = input.targetBounds.reduce(
      (total, bounds) => total + overlapArea(candidate, bounds),
      0,
    );
    const score = labelCollisionArea * 100_000 + targetCollisionArea * 1_000 + priority;
    if (score < bestScore) {
      best = candidate;
      bestScore = score;
    }
  });
  return best;
}

function overlayRect(left: number, top: number, width: number, height: number): OverlayRect {
  return {
    left,
    top,
    right: left + width,
    bottom: top + height,
    width,
    height,
  };
}

function overlapArea(first: OverlayRect, second: OverlayRect): number {
  return Math.max(0, Math.min(first.right, second.right) - Math.max(first.left, second.left))
    * Math.max(0, Math.min(first.bottom, second.bottom) - Math.max(first.top, second.top));
}

function isShadowRoot(value: Node): value is ShadowRoot {
  const candidate = value as ShadowRoot;
  return value.nodeType === 11 && typeof candidate.host?.getRootNode === "function";
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value));
}

function normalizeAnchor(anchor: PersistentOverlayAnchor | undefined): PersistentOverlayAnchor | null {
  if (!anchor || !Number.isFinite(anchor.xRatio) || !Number.isFinite(anchor.yRatio)) return null;
  return {
    xRatio: clamp(anchor.xRatio, 0, 1),
    yRatio: clamp(anchor.yRatio, 0, 1),
  };
}
