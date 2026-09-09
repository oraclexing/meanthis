import {
  serializeAttachmentFeedbackBundle,
  serializeAttachmentMarkdown,
  type AttachmentFeedbackDetail,
} from "@meanthis/prompt";
import type {
  UIAttachment,
  UIAttachmentDisclosureMode,
  UIAttachmentSelectionPoint,
} from "@meanthis/schema";
import { extractElementAttachment } from "@meanthis/web-extractor";
import {
  createAnnotationSurfaceController,
  formatAnnotationLabel,
  type AnnotationLifecycleState,
  type AnnotationSurfaceController,
  type AnnotationSurfaceReadback,
} from "./annotation-surface-controller.js";
import {
  createElementSelectionController,
  type ElementSelectionController,
} from "./element-selection-controller.js";
import {
  createInPageWidgetView,
  type InPageWidgetMode,
  type InPageWidgetStringsOverride,
  type InPageWidgetView,
  type InPageWidgetViewModel,
} from "./in-page-widget-view.js";
import {
  createPersistentOverlayController,
  type PersistentOverlayAnchor,
  type PersistentOverlayDisplayMode,
  type PersistentOverlayItem,
} from "./persistent-overlays.js";
import {
  claimMeanThisSurface,
  type MeanThisSurfaceClaimStatus,
} from "./surface-claim.js";

const WEB_WIDGET_HOST_SELECTOR = "[data-meanthis-web-widget-host]";
const SELECTION_PREVIEW_ITEM_ID = "meanthis-sdk-selection-preview";
const SDK_TOP_FRAME_SCOPE_ID = "meanthis-sdk-top-frame";
const MAX_ITEMS = 26;
const COLLAPSED_WIDGET_SIZE = 48;
const ANNOTATION_ID_SCOPE = "widget_instance" as const;
let nextWidgetInstanceSequence = 1;

export interface MeanThisWebWidgetAnnotation {
  annotationId: string;
  annotationIdScope: typeof ANNOTATION_ID_SCOPE;
  annotationLifecycle: {
    state: "open" | "resolved";
    resolvedAt: string | null;
  };
  label: string;
  taskNote: string;
  selectionPoint: UIAttachmentSelectionPoint | null;
}

export interface MeanThisWebWidgetTarget {
  targetId: string;
  label: string;
  attachment: UIAttachment;
  markdown: string;
  annotations: readonly MeanThisWebWidgetAnnotation[];
}

export interface MeanThisWebWidgetSnapshot {
  status: MeanThisSurfaceClaimStatus;
  mode: InPageWidgetMode;
  targets: readonly MeanThisWebWidgetTarget[];
  activeAnnotationId: string | null;
  outputDetail: AttachmentFeedbackDetail;
  displayMode: PersistentOverlayDisplayMode;
}

export interface MeanThisWebWidgetCopyEvent {
  text: string;
  snapshot: MeanThisWebWidgetSnapshot;
}

export interface CreateMeanThisWebWidgetOptions {
  root?: Document;
  surface?: HTMLElement | string;
  initialOpen?: boolean;
  /**
   * Mounts the shared view in page-readable light DOM for local visual QA.
   * This disables the normal widget-content isolation and must not be enabled
   * for production pages or sensitive task notes.
   */
  debugInspectableDom?: boolean;
  disclosureMode?: UIAttachmentDisclosureMode;
  outputDetail?: AttachmentFeedbackDetail;
  displayMode?: PersistentOverlayDisplayMode;
  strings?: InPageWidgetStringsOverride;
  isSelectableTarget?: (target: HTMLElement) => boolean;
  resolveAssetUrl?: (assetName: string) => string;
  writeText?: (text: string) => Promise<void>;
  onChange?: (snapshot: MeanThisWebWidgetSnapshot) => void;
  onCopy?: (event: MeanThisWebWidgetCopyEvent) => void | Promise<void>;
  onOpenSettings?: () => void;
}

export interface MeanThisWebWidget {
  readonly status: MeanThisSurfaceClaimStatus;
  readonly element: HTMLElement | null;
  open(): boolean;
  collapse(): void;
  startSelection(): boolean;
  stopSelection(): void;
  setOutputDetail(detail: AttachmentFeedbackDetail): void;
  setDisplayMode(mode: PersistentOverlayDisplayMode): void;
  setAnnotationLifecycle(annotationId: string, nextState: AnnotationLifecycleState): Promise<boolean>;
  copy(): Promise<string | null>;
  clear(): void;
  snapshot(): MeanThisWebWidgetSnapshot;
  destroy(): void;
}

interface OwnedAnnotation extends MeanThisWebWidgetAnnotation {
  anchor: PersistentOverlayAnchor;
}

interface OwnedTarget extends Omit<MeanThisWebWidgetTarget, "annotations"> {
  target: HTMLElement;
  annotations: OwnedAnnotation[];
}

/**
 * Creates the page-owned SDK surface. It shares the same view core as the MV3
 * widget, while keeping page trust and extension-only capabilities separate.
 */
export function createMeanThisWebWidget(
  options: CreateMeanThisWebWidgetOptions = {},
): MeanThisWebWidget {
  const root = options.root ?? document;
  const rootWindow = root.defaultView;
  if (!rootWindow || rootWindow.document !== root) {
    throw new Error("MeanThis requires the target document window.");
  }
  const viewWindow: Window & typeof globalThis = rootWindow;
  if (viewWindow.top && viewWindow.top !== viewWindow) {
    throw new Error("MeanThis web widget can only mount in the top document.");
  }

  let controller: MeanThisWebWidget | null = null;
  const claim = claimMeanThisSurface({
    root,
    owner: "sdk",
    onOpenRequest: () => controller?.open(),
    onClaimLost: () => controller?.destroy(),
  });
  if (claim.status !== "claimed") {
    controller = createDelegatedController(claim.status, claim.requestOpen);
    return controller;
  }

  const widgetInstanceId = createOpaqueWidgetInstanceId(viewWindow);
  const host = root.createElement("div");
  host.dataset.meanthisWebWidgetHost = "true";
  if (options.debugInspectableDom) host.dataset.meanthisInspectableDom = "true";
  else host.dataset.uiAttachIgnore = "true";
  applyHostStyle(host, options.initialOpen ? "ready" : "collapsed");
  const viewRoot: HTMLElement | ShadowRoot = options.debugInspectableDom
    ? host
    : host.attachShadow({ mode: "closed" });
  root.documentElement.append(host);

  const targets: OwnedTarget[] = [];
  const targetByElement = new Map<HTMLElement, OwnedTarget>();
  let nextAnnotationNumber = 1;
  let selecting = false;
  let selectionPreviewTarget: HTMLElement | null = null;
  let displayMode: PersistentOverlayDisplayMode = options.displayMode === "full" ||
      options.displayMode === "markers" || options.displayMode === "hidden" ? options.displayMode : "hover";
  let frameScopeOpen = false;
  let immediateClearRevision = 0;
  let disposed = false;
  let view: InPageWidgetView | null = null;
  let selectionController: ElementSelectionController;
  let annotationSurface: AnnotationSurfaceController | null = null;
  annotationSurface = createAnnotationSurfaceController({
    initialMode: options.initialOpen ? "ready" : "collapsed",
    initialOutputDetail: isAttachmentFeedbackDetail(options.outputDetail)
      ? options.outputDetail
      : "compact",
    initialReadiness: "ready",
    setTimeout: (callback, delay) => viewWindow.setTimeout(callback, delay),
    clearTimeout: (id) => viewWindow.clearTimeout(id as number),
    strings: {
      annotationRemoved: "Annotation removed.",
      annotationsCleared: "Annotations cleared.",
      copySucceeded: (count) => (
        `Copied ${count} annotation${count === 1 ? "" : "s"} across ` +
        `${targets.length} target${targets.length === 1 ? "" : "s"}.`
      ),
      copyFailed: "Copy was blocked. Select the text below to copy it manually.",
    },
    beforeClear: () => selectionController.setEnabled(false),
    adapter: {
      async activate(itemId) {
        if (!findAnnotation(itemId)) throw new Error("Selected annotation is no longer available.");
        return createSurfaceReadback(itemId);
      },
      stageTaskNote(itemId, note) {
        const owned = findAnnotation(itemId);
        if (!owned) throw new Error("Selected annotation is no longer available.");
        owned.annotation.taskNote = note;
      },
      async saveTaskNote(itemId, note) {
        const owned = findAnnotation(itemId);
        if (!owned) throw new Error("Selected annotation is no longer available.");
        owned.annotation.taskNote = note;
        return createSurfaceReadback(itemId);
      },
      async setAnnotationLifecycle(itemId, nextState) {
        const owned = findAnnotation(itemId);
        if (!owned) throw new Error("Selected annotation is no longer available.");
        if (owned.annotation.annotationLifecycle.state === nextState) {
          throw new Error("Annotation state is already current.");
        }
        owned.annotation.annotationLifecycle = nextState === "resolved"
          ? { state: "resolved", resolvedAt: new Date().toISOString() }
          : { state: "open", resolvedAt: null };
        return createSurfaceReadback(itemId);
      },
      async remove(itemId) {
        return removeAnnotationData(itemId);
      },
      async clear() {
        clearItemsData();
        return createSurfaceReadback(null);
      },
      async copy(detail) {
        const deliveryRevision = immediateClearRevision;
        const text = buildWidgetHandoff(targets, detail);
        const count = annotationCount(targets);
        const copySnapshot = snapshot();
        let copied = true;
        try {
          await writeText(text);
          if (disposed || deliveryRevision !== immediateClearRevision) {
            return { text, copied: false, count };
          }
          await options.onCopy?.({ text, snapshot: copySnapshot });
        } catch {
          copied = false;
        }
        return { text, copied, count };
      },
    },
    onChange: () => {
      if (!annotationSurface || disposed) return;
      emitChange();
      if (view) render();
    },
  });
  annotationSurface.applyReadback(createSurfaceReadback(null));
  const overlays = createPersistentOverlayController({
    root,
    initialDisplayMode: displayMode,
    actionLabels: {
      edit: "Edit selected element",
      remove: "Remove selected element",
      more: "Show annotation details",
    },
    editor: {
      onSave: async (itemId, note) => {
        if (!await annotationSurface?.saveInline(itemId, note)) {
          throw new Error("Task note was not saved.");
        }
      },
    },
    onRemove: (itemId) => void annotationSurface?.remove(itemId),
    onMore: (itemId) => void annotationSurface?.more(itemId).then((opened) => {
      if (opened) view?.focus();
    }),
  });

  const pickerSurface = resolveSurface(root, options.surface);
  selectionController = createElementSelectionController({
    root,
    isOwnedUiEvent: (event) => event.composedPath().some((node) => (
      node === host || (node instanceof Node && host.contains(node))
    )),
    resolveTarget: (event) => {
      const target = composedHTMLElement(root, event);
      return target && isSelectableTarget(target) ? target : null;
    },
    previewTarget: (target) => {
      selectionPreviewTarget = target;
      syncOverlays();
    },
    activateTarget: (target, anchor, selectionPoint) => {
      if (disposed) return;
      activateSelectionTarget(target, anchor, selectionPoint);
    },
    onEnabledChange: (enabled) => {
      selecting = enabled;
      frameScopeOpen = false;
      selectionPreviewTarget = null;
      if (disposed) return;
      annotationSurface?.setMode(enabled ? "selecting" : "ready");
      annotationSurface?.disarmClearConfirmation();
      if (enabled) annotationSurface?.setStatus(null);
    },
    reportFailure: () => {
      if (disposed) return;
      annotationSurface?.setStatus({
        kind: "error",
        message: "MeanThis could not select that element.",
      });
      annotationSurface?.setMode("details");
    },
  });

  function createOwnedAnnotation(
    anchor: PersistentOverlayAnchor,
    selectionPoint: UIAttachmentSelectionPoint | null,
  ): OwnedAnnotation {
    const number = nextAnnotationNumber++;
    return {
      annotationId: `${widgetInstanceId}::annotation-${number}`,
      annotationIdScope: ANNOTATION_ID_SCOPE,
      annotationLifecycle: { state: "open", resolvedAt: null },
      label: formatAnnotationLabel(annotationCount(targets)),
      taskNote: "",
      selectionPoint: selectionPoint ? { ...selectionPoint } : null,
      anchor: { ...anchor },
    };
  }

  function activateSelectionTarget(
    target: HTMLElement,
    anchor: PersistentOverlayAnchor,
    selectionPoint: UIAttachmentSelectionPoint | null,
  ): void {
    const existing = targetByElement.get(target);
    if (existing) {
      const nearby = findNearbyAnnotation(existing.annotations, selectionPoint);
      if (nearby) {
        annotationSurface?.applyReadback(createSurfaceReadback(nearby.annotationId));
        annotationSurface?.setMode("selecting");
        return;
      }
      if (annotationCount(targets) >= MAX_ITEMS) {
        selectionController.setEnabled(false);
        annotationSurface?.setStatus({
          kind: "error",
          message: `MeanThis supports up to ${MAX_ITEMS} annotations.`,
        });
        annotationSurface?.setMode("details");
        return;
      }
      const annotation = createOwnedAnnotation(anchor, selectionPoint);
      existing.annotations.push(annotation);
      overlays.suppressActionsUntilPointerReentry?.(annotation.annotationId);
      annotationSurface?.applyReadback(createSurfaceReadback(annotation.annotationId));
      annotationSurface?.setMode("selecting");
      annotationSurface?.setStatus(null);
      return;
    }
    if (annotationCount(targets) >= MAX_ITEMS || targets.length >= 26) {
      selectionController.setEnabled(false);
      annotationSurface?.setStatus({
        kind: "error",
        message: `MeanThis supports up to ${MAX_ITEMS} annotations.`,
      });
      annotationSurface?.setMode("details");
      return;
    }
    const attachment = withoutSelectionPoint(extractElementAttachment(target, {
      disclosureMode: options.disclosureMode,
    }));
    const ownedTarget: OwnedTarget = {
      targetId: attachment.id,
      label: String.fromCharCode(65 + targets.length),
      attachment,
      markdown: serializeAttachmentMarkdown(attachment),
      target,
      annotations: [],
    };
    const annotation = createOwnedAnnotation(anchor, selectionPoint);
    ownedTarget.annotations.push(annotation);
    targets.push(ownedTarget);
    targetByElement.set(target, ownedTarget);
    overlays.suppressActionsUntilPointerReentry?.(annotation.annotationId);
    annotationSurface?.applyReadback(createSurfaceReadback(annotation.annotationId));
    annotationSurface?.setMode("selecting");
    annotationSurface?.setStatus(null);
  }

  view = createInPageWidgetView({
    document: root,
    strings: {
      bridgeControlsLabel: "Page integration",
      bridgeUnavailableHelp:
        "This page uses the MeanThis Web SDK. Copy references directly for your agent.",
      ...options.strings,
      stateLabels: {
        unavailable: "Web SDK",
        ...options.strings?.stateLabels,
      },
    },
    resolveAssetUrl: options.resolveAssetUrl ?? resolveBuiltInAsset,
    initialModel: model(),
    callbacks: {
      onExpand: () => setMode("ready"),
      onCollapse: () => setMode("collapsed"),
      onStartSelection: () => startSelection(),
      onStopSelection: () => stopSelection(),
      onToggleFrameScopes: () => {
        annotationSurface?.disarmClearConfirmation();
        frameScopeOpen = !frameScopeOpen;
        annotationSurface?.setStatus(null);
        render();
      },
      onCloseFrameScopes: () => {
        frameScopeOpen = false;
        render();
      },
      onSelectFrameScope: (scopeId) => {
        if (scopeId !== SDK_TOP_FRAME_SCOPE_ID) return;
        frameScopeOpen = false;
        render();
      },
      onClear: () => {
        void annotationSurface?.requestClear();
      },
      onOpenSettings: () => {
        annotationSurface?.disarmClearConfirmation();
        frameScopeOpen = false;
        if (options.onOpenSettings) options.onOpenSettings();
        else {
          const mode = annotationSurface?.getSnapshot().mode;
          setMode(mode === "details" || mode === "editing" ? "ready" : "details");
        }
      },
      onOutputDetailChange: (detail) => {
        annotationSurface?.setOutputDetail(detail);
      },
      onDisplayModeChange: (nextMode) => {
        if (displayMode === nextMode) return;
        displayMode = nextMode;
        overlays.setDisplayMode(displayMode);
        render();
        emitChange();
      },
      onActivateTarget: (itemId) => {
        void annotationSurface?.edit(itemId).then((opened) => {
          if (opened) view?.focus();
        });
      },
      onTaskNoteChange: (itemId, note) => {
        annotationSurface?.setTaskNote(itemId, note);
      },
      onSave: (itemId, note) => {
        annotationSurface?.setTaskNote(itemId, note);
        void annotationSurface?.save(itemId);
      },
      onCopy: () => {
        annotationSurface?.disarmClearConfirmation();
        void annotationSurface?.copy();
      },
      onCloseEditor: () => annotationSurface?.closeEditor(),
      onEditTarget: (itemId) => {
        void annotationSurface?.edit(itemId).then((opened) => {
          if (opened) view?.focus();
        });
      },
      onRemoveTarget: (itemId) => void annotationSurface?.remove(itemId),
      onMoreTarget: (itemId) => {
        void annotationSurface?.more(itemId);
      },
      onSetAnnotationLifecycle: (itemId, nextState) => {
        void annotationSurface?.setAnnotationLifecycle(itemId, nextState);
      },
    },
  });
  viewRoot.append(view.element);

  controller = {
    status: "claimed",
    element: host,
    open(): boolean {
      if (disposed) return false;
      setMode("ready");
      view?.focus();
      return true;
    },
    collapse(): void {
      setMode("collapsed");
    },
    startSelection,
    stopSelection,
    setOutputDetail(detail): void {
      if (!isAttachmentFeedbackDetail(detail) ||
          annotationSurface?.getSnapshot().outputDetail === detail) return;
      annotationSurface?.setOutputDetail(detail);
    },
    setDisplayMode(nextMode): void {
      const nextDisplayMode = nextMode === "full" || nextMode === "markers" || nextMode === "hidden"
        ? nextMode
        : "hover";
      if (displayMode === nextDisplayMode) return;
      displayMode = nextDisplayMode;
      overlays.setDisplayMode(displayMode);
      render();
      emitChange();
    },
    setAnnotationLifecycle: (annotationId, nextState) => (
      annotationSurface?.setAnnotationLifecycle(annotationId, nextState) ?? Promise.resolve(false)
    ),
    copy: () => annotationSurface?.copy() ?? Promise.resolve(null),
    clear: clearItemsImmediate,
    snapshot,
    destroy(): void {
      if (disposed) return;
      disposed = true;
      annotationSurface?.dispose();
      selectionController.dispose();
      targets.length = 0;
      targetByElement.clear();
      overlays.dispose();
      view?.dispose();
      if (host.isConnected) host.remove();
      claim.release();
    },
  };
  emitChange();
  return controller;

  function startSelection(): boolean {
    if (disposed) return false;
    frameScopeOpen = false;
    selectionController.setEnabled(true);
    return true;
  }

  function stopSelection(): void {
    if (disposed) return;
    selectionController.setEnabled(false);
  }

  function setMode(next: InPageWidgetMode): void {
    if (disposed) return;
    frameScopeOpen = false;
    if (next === "selecting") {
      selectionController.setEnabled(true);
      return;
    }
    if (selectionController.isEnabled()) selectionController.setEnabled(false);
    annotationSurface?.setMode(next);
    annotationSurface?.disarmClearConfirmation();
  }

  function render(): void {
    if (disposed || !view || !annotationSurface) return;
    applyHostStyle(host, annotationSurface.getSnapshot().mode, frameScopeOpen);
    view.update(model());
    syncOverlays();
  }

  function syncOverlays(): void {
    if (disposed) return;
    overlays.setActionsEnabled(true);
    overlays.setDisplayMode(displayMode);
    const overlayItems: PersistentOverlayItem[] = targets.flatMap((ownedTarget) =>
      ownedTarget.annotations.map((annotation) => ({
        itemId: annotation.annotationId,
        label: annotation.label,
        name: `Target ${ownedTarget.label} · ${targetName(ownedTarget)}`,
        taskNote: annotation.taskNote,
        anchor: annotation.anchor,
        target: ownedTarget.target,
      }))
    );
    let overlayActiveItemId = annotationSurface?.getSnapshot().activeItemId ?? null;
    if (selecting && selectionPreviewTarget) {
      const existing = targetByElement.get(selectionPreviewTarget);
      if (existing) {
        overlayActiveItemId = existing.annotations[0]?.annotationId ?? null;
      } else {
        overlayItems.push({
          itemId: SELECTION_PREVIEW_ITEM_ID,
          label: "Select",
          name: "",
          taskNote: "",
          interactive: false,
          target: selectionPreviewTarget,
        });
        overlayActiveItemId = SELECTION_PREVIEW_ITEM_ID;
      }
    }
    overlays.sync(overlayItems, overlayActiveItemId);
    overlays.setTemporaryHighlight(selecting && selectionPreviewTarget ? overlayActiveItemId : null);
  }

  function model(): InPageWidgetViewModel {
    const surface = annotationSurface?.getSnapshot();
    return {
      mode: surface?.mode ?? "collapsed",
      selectionEnabled: selecting,
      readiness: surface?.readiness ?? "hydrating",
      bridgeState: "unavailable",
      disclosureRequired: false,
      clearConfirmationRequired: surface?.clearConfirmationRequired ?? false,
      clearStatus: surface?.clearStatus ?? { clearState: "idle", operationId: null },
      connectionRequestText: null,
      manualCopyText: surface?.manualCopyText ?? null,
      outputDetail: surface?.outputDetail ?? "compact",
      displayMode,
      frameScopeOpen,
      frameScopes: [{
        id: SDK_TOP_FRAME_SCOPE_ID,
        kind: "top",
        detail: documentRoute(root),
        depth: 0,
        current: true,
        selectable: true,
      }],
      targets: surface?.items.map(({ itemId, label, name, annotationLifecycle }) => ({
        itemId,
        label,
        name,
        annotationLifecycle: annotationLifecycle ? { ...annotationLifecycle } : null,
      })) ?? [],
      activeItemId: surface?.activeItemId ?? null,
      taskNote: surface?.taskNote ?? "",
      shortcuts: [],
      busyAction: surface?.busyAction ?? null,
      status: surface?.status ?? null,
    };
  }

  function snapshot(): MeanThisWebWidgetSnapshot {
    const surface = annotationSurface?.getSnapshot();
    return {
      status: "claimed",
      mode: surface?.mode ?? "collapsed",
      targets: targets.map(({ target: _target, annotations, ...ownedTarget }) => ({
        ...ownedTarget,
        attachment: cloneAttachment(ownedTarget.attachment),
        annotations: annotations.map(({ anchor: _anchor, ...annotation }) => ({
          ...annotation,
          annotationLifecycle: { ...annotation.annotationLifecycle },
          selectionPoint: annotation.selectionPoint
            ? { ...annotation.selectionPoint }
            : null,
        })),
      })),
      activeAnnotationId: surface?.activeItemId ?? null,
      outputDetail: surface?.outputDetail ?? "compact",
      displayMode,
    };
  }

  function emitChange(): void {
    options.onChange?.(snapshot());
  }

  function findAnnotation(annotationId: string): {
    target: OwnedTarget;
    annotation: OwnedAnnotation;
  } | null {
    for (const ownedTarget of targets) {
      const annotation = ownedTarget.annotations.find(
        (candidate) => candidate.annotationId === annotationId,
      );
      if (annotation) return { target: ownedTarget, annotation };
    }
    return null;
  }

  function createSurfaceReadback(activeItemId: string | null): AnnotationSurfaceReadback {
    return {
      items: targets.flatMap((ownedTarget) => ownedTarget.annotations.map((annotation) => ({
        itemId: annotation.annotationId,
        label: annotation.label,
        name: `Target ${ownedTarget.label} · ${targetName(ownedTarget)}`,
        taskNote: annotation.taskNote,
        annotationLifecycle: { ...annotation.annotationLifecycle },
      }))),
      activeItemId,
      clearStatus: { clearState: "idle", operationId: null },
    };
  }

  function removeAnnotationData(itemId: string): AnnotationSurfaceReadback {
    const owned = findAnnotation(itemId);
    if (!owned) throw new Error("Selected annotation is no longer available.");
    const annotationsBefore = allAnnotations(targets);
    const removedIndex = annotationsBefore.findIndex((annotation) => annotation.annotationId === itemId);
    const annotationIndex = owned.target.annotations.findIndex(
      (annotation) => annotation.annotationId === itemId,
    );
    owned.target.annotations.splice(annotationIndex, 1);
    if (owned.target.annotations.length === 0) {
      const targetIndex = targets.indexOf(owned.target);
      targets.splice(targetIndex, 1);
      targetByElement.delete(owned.target.target);
      relabelTargets(targets);
    }
    relabelAnnotations(targets);
    const annotations = allAnnotations(targets);
    const activeItemId = annotations[Math.min(removedIndex, annotations.length - 1)]
      ?.annotationId ?? null;
    return createSurfaceReadback(activeItemId);
  }

  function clearItemsData(): void {
    targets.length = 0;
    targetByElement.clear();
  }

  function clearItemsImmediate(): void {
    if (disposed) return;
    immediateClearRevision += 1;
    annotationSurface?.cancelPendingAction();
    selectionController.setEnabled(false);
    clearItemsData();
    annotationSurface?.applyReadback(createSurfaceReadback(null));
    annotationSurface?.setManualCopyText(null);
    annotationSurface?.setStatus(null);
    annotationSurface?.setMode("ready");
  }

  async function writeText(text: string): Promise<void> {
    if (options.writeText) return options.writeText(text);
    const clipboard = viewWindow.navigator.clipboard;
    if (!clipboard?.writeText) throw new Error("Clipboard unavailable.");
    await clipboard.writeText(text);
  }

  function isSelectableTarget(target: HTMLElement): boolean {
    if (host.contains(target) || target.closest(WEB_WIDGET_HOST_SELECTOR)) return false;
    if (target.closest("[data-ui-attach-ignore]")) return false;
    if (pickerSurface && !pickerSurface.contains(target)) return false;
    return options.isSelectableTarget?.(target) ?? true;
  }
}

function createDelegatedController(
  status: Exclude<MeanThisSurfaceClaimStatus, "claimed">,
  requestOpen: () => boolean,
): MeanThisWebWidget {
  const snapshot = (): MeanThisWebWidgetSnapshot => ({
    status,
    mode: "collapsed",
    targets: [],
    activeAnnotationId: null,
    outputDetail: "compact",
    displayMode: "hover",
  });
  return {
    status,
    element: null,
    open: requestOpen,
    collapse(): void {},
    startSelection(): boolean { return false; },
    stopSelection(): void {},
    setOutputDetail(): void {},
    setDisplayMode(): void {},
    async setAnnotationLifecycle(): Promise<boolean> { return false; },
    async copy(): Promise<null> { return null; },
    clear(): void {},
    snapshot,
    destroy(): void {},
  };
}

function createOpaqueWidgetInstanceId(viewWindow: Window & typeof globalThis): string {
  const sequence = nextWidgetInstanceSequence++;
  const cryptoApi = viewWindow.crypto ?? globalThis.crypto;
  try {
    const randomUUID = cryptoApi?.randomUUID;
    if (typeof randomUUID === "function") {
      return `widget-${randomUUID.call(cryptoApi)}-${sequence.toString(36)}`;
    }
  } catch {
    // Fall through to the available random-value or local fallback.
  }

  if (cryptoApi?.getRandomValues) {
    try {
      const bytes = cryptoApi.getRandomValues(new Uint8Array(16));
      const token = Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
      return `widget-${token}-${sequence.toString(36)}`;
    } catch {
      // Fall through to the local fallback when random values are unavailable.
    }
  }

  return `widget-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}-${sequence.toString(36)}`;
}

function applyHostStyle(
  host: HTMLElement,
  mode: InPageWidgetMode,
  frameScopeOpen = false,
): void {
  const detailed = mode === "details" || mode === "editing";
  const collapsed = mode === "collapsed";
  const workbar = !collapsed && !detailed && !frameScopeOpen;
  const reducedMotion = host.ownerDocument.defaultView
    ?.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;
  const declarations: Record<string, string> = {
    all: "initial",
    position: "fixed",
    right: "calc(12px + env(safe-area-inset-right, 0px))",
    bottom: "calc(12px + env(safe-area-inset-bottom, 0px))",
    display: "block",
    width: collapsed ? `${COLLAPSED_WIDGET_SIZE}px` : detailed || frameScopeOpen ? "360px" : "fit-content",
    height: collapsed ? `${COLLAPSED_WIDGET_SIZE}px` : detailed ? "560px" : frameScopeOpen ? "auto" : "64px",
    "max-width": "calc(100vw - 24px)",
    "max-height": "calc(100vh - 24px)",
    overflow: frameScopeOpen ? "visible" : "hidden",
    "border-radius": collapsed || workbar ? "999px" : "18px",
    "box-shadow": workbar
      ? "0 14px 34px rgb(0 0 0 / 38%), 0 2px 8px rgb(0 0 0 / 24%)"
      : collapsed
      ? "0 6px 18px rgb(0 0 0 / 24%), 0 1px 4px rgb(0 0 0 / 16%)"
      : "none",
    "pointer-events": "auto",
    "z-index": "2147483647",
    contain: workbar || frameScopeOpen ? "layout style" : "layout style paint",
    "color-scheme": "dark",
    transition: reducedMotion
      ? "none"
      : "width 170ms cubic-bezier(0.2, 0.8, 0.2, 1), height 170ms cubic-bezier(0.2, 0.8, 0.2, 1), border-radius 170ms cubic-bezier(0.2, 0.8, 0.2, 1)",
  };
  for (const [name, value] of Object.entries(declarations)) {
    host.style.setProperty(name, value, "important");
  }
}

function documentRoute(root: Document): string {
  try {
    const url = new URL(root.URL);
    return url.protocol === "http:" || url.protocol === "https:"
      ? `${url.origin}${url.pathname}`
      : url.href;
  } catch {
    return "";
  }
}

function composedHTMLElement(root: Document, event: Event): HTMLElement | null {
  const realm = root.defaultView;
  if (!realm) return null;
  for (const candidate of event.composedPath()) {
    if (candidate instanceof realm.HTMLElement) return candidate;
  }
  return event.target instanceof realm.HTMLElement ? event.target : null;
}

function resolveSurface(root: Document, surface: HTMLElement | string | undefined): HTMLElement | null {
  if (!surface) return null;
  if (typeof surface === "string") {
    const resolved = root.querySelector(surface);
    return resolved instanceof (root.defaultView?.HTMLElement ?? HTMLElement) ? resolved : null;
  }
  return surface.ownerDocument === root ? surface : null;
}

function cloneAttachment(attachment: UIAttachment): UIAttachment {
  if (typeof globalThis.structuredClone === "function") {
    return globalThis.structuredClone(attachment);
  }
  return JSON.parse(JSON.stringify(attachment)) as UIAttachment;
}

function relabelTargets(targets: OwnedTarget[]): void {
  targets.forEach((target, index) => { target.label = String.fromCharCode(65 + index); });
}

function relabelAnnotations(targets: OwnedTarget[]): void {
  allAnnotations(targets).forEach((annotation, index) => {
    annotation.label = formatAnnotationLabel(index);
  });
}

function allAnnotations(targets: readonly OwnedTarget[]): OwnedAnnotation[] {
  return targets.flatMap((target) => target.annotations);
}

function annotationCount(targets: readonly OwnedTarget[]): number {
  return targets.reduce((count, target) => count + target.annotations.length, 0);
}

function targetName(target: OwnedTarget): string {
  const element = target.attachment.element;
  return element.accessibleName || element.text || element.tagName || "Selected element";
}

function buildWidgetHandoff(
  targets: readonly OwnedTarget[],
  detail: AttachmentFeedbackDetail,
): string {
  return serializeAttachmentFeedbackBundle(
    targets.map((target) => ({
      label: target.label,
      attachment: target.attachment,
      annotations: target.annotations.map((annotation) => ({
        label: annotation.label,
        taskNote: annotation.taskNote,
        selectionPoint: annotation.selectionPoint,
        annotationLifecycle: { ...annotation.annotationLifecycle },
      })),
    })),
    { detail },
  );
}

function withoutSelectionPoint(
  attachment: UIAttachment,
): UIAttachment {
  const { selectionPoint: _selectionPoint, ...base } = attachment;
  return base;
}

function findNearbyAnnotation(
  annotations: readonly OwnedAnnotation[],
  selectionPoint: UIAttachmentSelectionPoint | null,
): OwnedAnnotation | null {
  if (!selectionPoint) return annotations[0] ?? null;
  const maximumDistance = 0.04;
  let nearest: { annotation: OwnedAnnotation; distance: number } | null = null;
  for (const annotation of annotations) {
    if (!annotation.selectionPoint) continue;
    const x = annotation.selectionPoint.xRatio - selectionPoint.xRatio;
    const y = annotation.selectionPoint.yRatio - selectionPoint.yRatio;
    const distance = Math.hypot(x, y);
    if (distance <= maximumDistance && (!nearest || distance < nearest.distance)) {
      nearest = { annotation, distance };
    }
  }
  return nearest?.annotation ?? null;
}

function isAttachmentFeedbackDetail(value: unknown): value is AttachmentFeedbackDetail {
  return value === "compact" || value === "standard" ||
    value === "detailed" || value === "forensic";
}

const BRAND_PNG =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAYAAABzenr0AAAD90lEQVR42sWXaUhUURTHhyD6INEQLWRQk9lCqwvtaYNFQlhJRCEmOEzYSgmWCi2MUElgGUmELQy02GISYiY22cTYplkz6mhEVKgRFdLop8yWE/8T5/Fm12xUOOqbue/8f/ecc8+9V6Px8TNs+Eht2MSVyaPn7DL9D4Mv+NQE+8Gg8QuPmSM3t1IoDL79gozQzoyK2FDnCpW4GDSgpQibcjNMEVNnDIq4GkKJhKvN6qKuBjp9pZFiDC00WBBIBwOsWKDTt9uvESA+vH1B2/ObBw2Co6CPDU/+VhVLjRW51PH6EYM8q7fTip2hjcbafU7auCk1U7NnU6QJALAv5XHU/OAMdX98wYa0/E9RpDj7VBO1Nr/kidqqS+yag1vCFQAxx41Uam8q50EYDNqBCmMyMrGyKgf7RI/wCSD2viaHujtqSYr0X8TVwupCjzfaaHKMwaTZuGaxXwBOS2UitT2/2O9opB5yclF7CiftqKLrRZnsmwESVyUEBBD7/jiFfn+uDhoNCJnLHDzO8tCuCGfsv0w28xbF39vSxL8pCAaQmbaMhofpqDRvLvVY4ujnmyK/0cAzPsessZyj0xoo60Axi3n6RRQYYGl8UkAAo8HAAAkLpymf9dYZiTptLISqhjj+4pmX8LbndDL/KK+q+nNLKH19NH26FePmFxFhAPwKBABxTwAYovGrvYRFMXNE5V71fSW/YmUFa2jshNlkKZjnFn5AKwAg7S+A9A3J+7u7W32+f9gwi99XAyAtbgDq4ugPAGYr+UfIAwHUn53Pz9CSdxQAfy/Dxoybwg7Sk2Z4fZeyt8ytCO1XN3iNQe5FHBHD+vcCQLX6S8PrS9F0IWeOVxF1Wo28zKT6sfTgp7I4w6cfwKEHqIEVADxgNn3pB9wTbMm8CrDkBEBarDQbRBXhRpok557mBiDNIlBBeoqrzw8CoW4+wcwLQHq051JSd0Nf4p4Q/r7vE4AY8om0mPIK2Uqv31Q6YCDnOEdgTF/2jYAAakOX8yWO/7HpwNRi+FxaMr4bEMCRc03KKUnEAeSsK6cfThO3ZaTmhyObvjYWue18KErukDVPyHzzqW8AXBr8iYsDqW7MBudHCKIV9zbsZgixnger2VwtFxkSG1LX+3tcuD9fHfdKHbT5MuJrS8WM1VsvZoBZQhhityqeeIUdYxEFjIEoQFG8eE+KU/2OcjRX34YwAAcJiMtOB3Fx+LTWEvDAChDA4RCDWWODQuRkUgBBWpVjuVzJcFmQLVV2OHEKADjDiwM9mCJKmJz1TrFVNylcxwDaUSO1l86fuO1ZbKG6FS2KW5dury2xF+ZnFTLA7asFLI5r2pBcTqPmTo/SL4/VD8X1/A/fPWV1Q28urQAAAABJRU5ErkJggg==";

const ICON_PATHS: Readonly<Record<string, string>> = {
  "pause.svg": "M15.75 5.25v13.5m-7.5-13.5v13.5",
  "play.svg": "M5.25 5.653c0-.856.917-1.398 1.667-.986l11.54 6.347a1.125 1.125 0 0 1 0 1.972l-11.54 6.347a1.125 1.125 0 0 1-1.667-.986V5.653Z",
  "rectangle-group.svg": "M2.25 7.125C2.25 6.504 2.754 6 3.375 6h6c.621 0 1.125.504 1.125 1.125v3.75c0 .621-.504 1.125-1.125 1.125h-6A1.125 1.125 0 0 1 2.25 10.875v-3.75ZM14.25 8.625c0-.621.504-1.125 1.125-1.125h5.25c.621 0 1.125.504 1.125 1.125v8.25c0 .621-.504 1.125-1.125 1.125h-5.25a1.125 1.125 0 0 1-1.125-1.125v-8.25Z",
  "document-duplicate.svg": "M15.75 17.25h3.375c.621 0 1.125-.504 1.125-1.125V8.625c0-.621-.504-1.125-1.125-1.125H15.75V4.125C15.75 3.504 15.246 3 14.625 3h-9.75C4.254 3 3.75 3.504 3.75 4.125v12.75C3.75 17.496 4.254 18 4.875 18h9.75c.621 0 1.125-.504 1.125-1.125V7.5",
  "trash.svg": "m14.74 9-.346 9m-4.788 0L9.26 9M4.772 5.79l1.068 13.883a2.25 2.25 0 0 0 2.244 2.077h7.832a2.25 2.25 0 0 0 2.244-2.077L19.228 5.79M9.75 5.393V4.477c0-1.18.91-2.164 2.09-2.201h.32c1.18.037 2.09 1.021 2.09 2.201v.916",
  "settings.svg": "M12 9a3 3 0 1 0 0 6 3 3 0 0 0 0-6Zm8.25 3a8.2 8.2 0 0 0-.09-1.2l1.32-1.03-1.5-2.6-1.57.62a8.1 8.1 0 0 0-2.08-1.2L16.08 4.9h-3l-.25 1.69a8.1 8.1 0 0 0-2.08 1.2l-1.57-.62-1.5 2.6L9 10.8A8.2 8.2 0 0 0 8.91 12c0 .41.03.81.09 1.2l-1.32 1.03 1.5 2.6 1.57-.62a8.1 8.1 0 0 0 2.08 1.2l.25 1.69h3l.25-1.69a8.1 8.1 0 0 0 2.08-1.2l1.57.62 1.5-2.6-1.32-1.03c.06-.39.09-.79.09-1.2Z",
  "x-mark.svg": "M6 18 18 6M6 6l12 12",
};

function resolveBuiltInAsset(assetName: string): string {
  if (assetName === "meanthis-32.png") return BRAND_PNG;
  const path = ICON_PATHS[assetName] ?? ICON_PATHS["x-mark.svg"];
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke="black" stroke-width="1.5"><path stroke-linecap="round" stroke-linejoin="round" d="${path}"/></svg>`;
  return `data:image/svg+xml,${encodeURIComponent(svg)}`;
}
