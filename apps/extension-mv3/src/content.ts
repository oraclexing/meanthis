import "./extension-api";
import { captureElementTarget } from "./capture";
import { createCaptureObservation } from "./create-capture-observation";
import type {
  MetadataDiagnosticsDeviceV1,
  UIAttachmentDisclosureMode,
} from "@meanthis/schema";
import {
  claimMeanThisSurface,
  createPersistentOverlayController,
  type PersistentOverlayDisplayMode,
  type MeanThisSurfaceClaim,
} from "@meanthis/web-picker";
import type { OriginCaptureRecord } from "./capture-store";
import { createContextTargetTracker } from "./context-target";
import { createContentOverlayCoordinator } from "./content-overlays";
import {
  UI_ATTACH_CONTENT_DEACTIVATE,
  UI_ATTACH_CLEAR_PROJECTION_ACK,
  UI_ATTACH_EMPTY_APPLIED_ITEM_IDS_DIGEST,
  UI_ATTACH_EMBEDDED_FRAME_HOST_INSPECT,
  UI_ATTACH_CONTENT_SETTINGS_UPDATED,
  UI_ATTACH_CAPTURE_OBSERVATION_GET,
  UI_ATTACH_OVERLAYS_RESTORE_GET,
  UI_ATTACH_OVERLAY_ACTION_REQUEST,
  UI_ATTACH_OVERLAY_PROJECTION_ACK,
  UI_ATTACH_OVERLAY_PROJECTION_REACK_REQUIRED,
  UI_ATTACH_OVERLAY_STATE,
  UI_ATTACH_OVERLAY_VISIBILITY_GET,
  UI_ATTACH_OVERLAY_SCOPE_VISIBILITY_GET,
  UI_ATTACH_OVERLAY_DISPLAY_MODE_GET,
  UI_ATTACH_SELECTION_LIFECYCLE_PORT,
  isCaptureCommitResponse,
  isCaptureObservationGetMessage,
  isClearProjectionTombstoneMessage,
  isContentReadyGetMessage,
  isOverlayPreviewForPage,
  isOverlayPreviewMessage,
  isOverlayActionRequestMessage,
  isOverlayRelationPreviewForPage,
  isOverlayRelationPreviewMessage,
  isOverlayRebindStatusGetMessage,
  isOverlayRestoreRefreshMessage,
  isOverlayRestoreResponse,
  isOverlayStateMessage,
  isOverlayVisibilityUpdatedMessage,
  isOverlayScopeVisibilityUpdatedMessage,
  isOverlayDisplayModeUpdatedMessage,
  isSelectionSeedContextTargetMessage,
  isEmbeddedFrameHostInspectMessage,
  type CaptureCommitReceipt,
  type CaptureObservationGetMessage,
  type CaptureObservationResponse,
  type ClearProjectionReference,
  type ContentSettingsData,
  type OverlayRebindStatusData,
  type OverlayActionRequestAction,
  type OverlayActionRequestMessage,
  type OverlayProjectionDescriptor,
  type OverlayProjectionRef,
  type OverlayRestoreData,
  type OverlayStateMessage,
  type RuntimeCaptureToken,
  type SessionCommandResponse,
} from "./messages";
import { inspectEmbeddedFrameHost } from "./embedded-frame-host";
import { createOverlayRebindController } from "./overlay-rebind";
import { commitLiveOverlayCapture } from "./overlay-restore";
import { createCaptureSelectionController } from "./capture-selection-controller";
import { collectMetadataDiagnosticsDevice } from "./metadata-diagnostics";
import { createSelectionLifecycleController } from "./selection-lifecycle";
import { createSelectionSurfaceController } from "./selection-surface";
import {
  UI_ATTACH_IN_PAGE_WIDGET_ENSURE,
  UI_ATTACH_IN_PAGE_WIDGET_INIT,
  isInPageWidgetEnsureMessage,
  parseInPageWidgetInitMessage,
} from "./in-page-widget-contract";
import {
  createInPageWidgetHost,
  type InPageWidgetHostController,
} from "./in-page-widget-host";

const UI_ATTACH_CAPTURE_FAILED = "ui-attach:capture-failed";
const SAFE_CAPTURE_ERROR = "ui-attach capture failed.";

const tracker = createContextTargetTracker(document);
const persistentOverlays = createPersistentOverlayController({
  root: document,
  relationRoleLabels: {
    source: getLocalizedMessage("element", "Element"),
    reference: getLocalizedMessage("relative_to", "Relative to"),
  },
  actionLabels: {
    edit: getLocalizedMessage("edit", "Edit"),
    remove: getLocalizedMessage("remove_selected_element", "Remove selected element"),
    more: getLocalizedMessage("annotation_details", "Show annotation details"),
    open: getLocalizedMessage("open_annotation_actions", "Open actions for annotation"),
    notePresent: getLocalizedMessage("task_note_added", "Has task note"),
  },
  editor: {
    onSave: async (itemId, taskNote) => {
      if (!await requestOverlaySave(itemId, taskNote)) throw new Error(SAFE_CAPTURE_ERROR);
    },
  },
  onRemove: (itemId) => handleOverlayAction("remove", itemId),
  onMore: (itemId) => handleOverlayAction("more", itemId),
});
const overlayCoordinator = createContentOverlayCoordinator(persistentOverlays, {
  initiallyVisible: false,
});
const overlayRebind = createOverlayRebindController({
  root: document,
  bindTarget: (item, target) => overlayCoordinator.bindRestored(item, target),
  unbindTarget: (itemId) => overlayCoordinator.unbindRestored(itemId),
  onRouteChange: handleOverlayRouteChange,
});
let currentDisclosureMode: UIAttachmentDisclosureMode = "agent_safe";
let hasAppliedLiveSettings = false;
let liveOverlayStateRevision = 0;
let overlayProjectionApplicationRevision = 0;
let appliedOverlayProjection: OverlayProjectionDescriptor | null = null;
let acknowledgedOverlayProjection: OverlayProjectionDescriptor | null = null;
let clearProjectionFence: ClearProjectionReference | null = null;
let overlayVisibilityRevision = 0;
let overlayScopeVisibilityRevision = 0;
let overlaysVisible = false;
// Scope filtering is visual-only. Default visible preserves compatibility with a
// previous worker until the exact per-frame state arrives.
let overlayScopeVisible = true;
let contentDeactivated = false;
let overlayActionFailureHost: HTMLDivElement | null = null;
let overlayActionFailureTimer: number | null = null;
const selectionSurface = createSelectionSurfaceController({ root: document });
let inPageWidgetHost: InPageWidgetHostController | null = null;
let inPageWidgetSurfaceClaim: MeanThisSurfaceClaim | null = null;

function getLocalizedMessage(key: string, fallback: string): string {
  try {
    return chrome.i18n?.getMessage(key) || fallback;
  } catch {
    return fallback;
  }
}
const captureSelection = createCaptureSelectionController({
  root: document,
  beginCapture,
  captureTarget: (target, selectionPoint) =>
    captureElementTarget(target, {
      locationHref: window.location.href,
      documentTitle: document.title,
      disclosureMode: currentDisclosureMode,
      selectionPoint,
    }),
  collectMetadataDiagnosticsDevice,
  commitCapture,
  publishFailure,
  previewTarget: (target) => {
    overlayCoordinator.applySelectionPreview(target);
  },
  pointerEventTarget: selectionSurface.eventTarget,
  resolveTarget: (event) => selectionSurface.resolveTarget(event),
  onEnabledChange: (enabled) => {
    selectionSurface.setEnabled(enabled);
    persistentOverlays.setActionsEnabled(true);
  },
  disableSelection: async () => {
    const response = await chrome.runtime.sendMessage({
      type: "ui-attach:content-selection-disable",
    });
    if (!isNullCommandResponse(response)) throw new Error(SAFE_CAPTURE_ERROR);
  },
  publishCommitted: (target, receipt, record, anchor) => commitLiveOverlayCapture({
    record,
    receipt,
    currentUrl: window.location.href,
    target,
    trackCurrentRoute: () => overlayRebind.trackCurrentRoute(),
    bindLiveTarget: (liveTarget, liveReceipt) => {
      overlayCoordinator.commitTarget(liveTarget, liveReceipt, anchor);
    },
    bindReplayTarget: (item, replayTarget) => overlayRebind.commitCurrent(item, replayTarget),
  }),
});
const selectionLifecycle = createSelectionLifecycleController({
  connect: () => {
    const port = chrome.runtime.connect({ name: UI_ATTACH_SELECTION_LIFECYCLE_PORT });
    if (!port.postMessage) throw new Error(SAFE_CAPTURE_ERROR);
    return {
      disconnect: () => port.disconnect(),
      postMessage: (message: unknown) => port.postMessage?.(message),
      onDisconnect: port.onDisconnect,
    };
  },
  onDisconnect: () => captureSelection.setEnabled(false),
});

void initializeCaptureSelectionMode();
void initializeOverlayVisibility();
void initializeOverlayScopeVisibility();
void initializeOverlayDisplayMode();

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (
    isRecord(message) &&
    hasOnlyKeys(message, ["type"]) &&
    message.type === UI_ATTACH_CONTENT_DEACTIVATE
  ) {
    deactivateContentRuntime();
    sendResponse({ ok: true, data: null });
    return false;
  }
  if (contentDeactivated) return false;
  if (isContentReadyGetMessage(message)) {
    sendResponse({ ok: true, data: null });
    return false;
  }
  if (isInPageWidgetEnsureMessage(message)) {
    try {
      const surfaceOwner = ensureExtensionWidgetSurface();
      sendResponse(surfaceOwner === "extension"
        ? { ok: true, data: null }
        : { ok: true, data: { delegated: true, surfaceOwner } });
    } catch {
      sendResponse({ ok: false, error: SAFE_CAPTURE_ERROR });
    }
    return false;
  }
  const widgetInit = parseInPageWidgetInitMessage(message);
  if (widgetInit) {
    if (ensureExtensionWidgetSurface() !== "extension") {
      sendResponse({ ok: false, error: SAFE_CAPTURE_ERROR });
      return false;
    }
    inPageWidgetHost ??= createWidgetHost();
    let targetHost = inPageWidgetHost;
    let transferred = targetHost.initialize(widgetInit);
    if (!transferred) {
      targetHost.dispose();
      inPageWidgetHost = createWidgetHost();
      targetHost = inPageWidgetHost;
      transferred = targetHost.initialize(widgetInit);
    }
    if (!transferred) {
      sendResponse({ ok: false, error: SAFE_CAPTURE_ERROR });
      return false;
    }
    void targetHost.waitUntilReady().then((readiness) => {
      sendResponse(readiness.ready
        ? { ok: true, data: null }
        : { ok: false, error: SAFE_CAPTURE_ERROR });
    }).catch(() => {
      sendResponse({ ok: false, error: SAFE_CAPTURE_ERROR });
    });
    return true;
  }
  if (isOverlayRebindStatusGetMessage(message)) {
    sendResponse({
      ok: true,
      data: {
        origin: window.location.origin,
        pathname: window.location.pathname,
        items: overlayRebind.readStatus(),
      },
    });
    return false;
  }
  if (isCaptureObservationGetMessage(message)) {
    void requestCaptureObservation(message).then(sendResponse).catch(() => {
      sendResponse({ ok: false, code: "CAPTURE_UNAVAILABLE", error: SAFE_CAPTURE_ERROR });
    });
    return true;
  }
  if (isOverlayRestoreRefreshMessage(message)) {
    void requestOverlayRestore(liveOverlayStateRevision, true).then((data) => {
      sendResponse(data
        ? { ok: true, data }
        : { ok: false, error: SAFE_CAPTURE_ERROR });
    }).catch(() => {
      sendResponse({ ok: false, error: SAFE_CAPTURE_ERROR });
    });
    return true;
  }
  if (isEmbeddedFrameHostInspectMessage(message)) {
    void inspectEmbeddedFrameHost(document, message.locators).then((data) => {
      sendResponse(data === null
        ? { ok: false, error: SAFE_CAPTURE_ERROR }
        : { ok: true, data });
    }).catch(() => {
      sendResponse({ ok: false, error: SAFE_CAPTURE_ERROR });
    });
    return true;
  }
  if (isClearProjectionTombstoneMessage(message)) {
    if (clearProjectionMatchesCurrentRoute(message.clear)) {
      void applyClearProjectionTombstone(message.clear);
    }
    return false;
  }
  if (isOverlayPreviewMessage(message)) {
    if (isOverlayPreviewForPage(message, window.location)) {
      overlayCoordinator.applyPreview(message.itemId);
    }
    return false;
  }
  if (isOverlayRelationPreviewMessage(message)) {
    if (isOverlayRelationPreviewForPage(message, window.location)) {
      overlayCoordinator.applyRelationPreview(
        message.sourceItemId,
        message.referenceItemId,
      );
    }
    return false;
  }
  if (isOverlayStateMessage(message)) {
    if (message.origin === window.location.origin) {
      liveOverlayStateRevision += 1;
      const expectedRevision = liveOverlayStateRevision;
      void applyOverlayProjection(message).then((accepted) => {
        if (accepted && liveOverlayStateRevision === expectedRevision) {
          void refreshOverlayDescriptors(expectedRevision);
        }
      });
    }
    return false;
  }
  if (isContentSettingsUpdatedMessage(message)) {
    hasAppliedLiveSettings = true;
    applyContentSettings(message);
    return false;
  }
  if (isOverlayVisibilityUpdatedMessage(message)) {
    overlayVisibilityRevision += 1;
    applyOverlayVisibility(message.visible, true);
    return false;
  }
  if (isOverlayScopeVisibilityUpdatedMessage(message)) {
    overlayScopeVisibilityRevision += 1;
    applyOverlayScopeVisibility(message.visible, true);
    return false;
  }
  if (isOverlayDisplayModeUpdatedMessage(message)) {
    overlayVisibilityRevision += 1;
    applyOverlayDisplayMode(message.displayMode, true);
    return false;
  }
  if (isSelectionSeedContextTargetMessage(message)) {
    const target = tracker.takeLatestTarget();
    sendResponse({
      ok: true,
      data: { seeded: captureSelection.seedPreview(target) },
    });
    return false;
  }
  return false;
});

function createWidgetHost(): InPageWidgetHostController {
  const host = createInPageWidgetHost({
    document,
    sourceUrl: chrome.runtime.getURL("widget.html"),
    startingLabel: localizedContentMessage(
      "in_page_widget_starting",
      "MeanThis is starting\u2026",
    ),
    failureLabel: localizedContentMessage(
      "in_page_widget_start_failed",
      "MeanThis could not start",
    ),
    onFailure: (failure) => {
      if (inPageWidgetHost === host) inPageWidgetHost = null;
      console.debug(
        `[MeanThis] In-page widget failed: ${failure.code} at ${failure.phase}` +
          `${failure.integrityIssue ? ` (${failure.integrityIssue})` : ""}.`,
      );
    },
  });
  return host;
}

function ensureExtensionWidgetSurface(): "sdk" | "extension" {
  if (inPageWidgetSurfaceClaim?.status === "claimed") {
    if (inPageWidgetSurfaceClaim.requestOpen()) return "extension";
    inPageWidgetSurfaceClaim.release();
    inPageWidgetSurfaceClaim = null;
  }

  let claim: ReturnType<typeof claimMeanThisSurface>;
  claim = claimMeanThisSurface({
    root: document,
    owner: "extension",
    onOpenRequest: () => {
      inPageWidgetHost ??= createWidgetHost();
      inPageWidgetHost.show();
    },
    onClaimLost: () => {
      if (inPageWidgetSurfaceClaim !== claim) return;
      inPageWidgetHost?.dispose();
      inPageWidgetHost = null;
      inPageWidgetSurfaceClaim = null;
    },
  });
  if (claim.status === "conflict" || !claim.currentOwner) {
    throw new Error(SAFE_CAPTURE_ERROR);
  }
  if (claim.status === "delegated") {
    claim.requestOpen();
    return claim.currentOwner;
  }
  inPageWidgetSurfaceClaim = claim;
  inPageWidgetHost ??= createWidgetHost();
  inPageWidgetHost.show();
  return "extension";
}

function localizedContentMessage(key: string, fallback: string): string {
  try {
    return chrome.i18n?.getMessage(key) || fallback;
  } catch {
    return fallback;
  }
}

function deactivateContentRuntime(): void {
  if (contentDeactivated) return;
  contentDeactivated = true;
  clearOverlayActionFailure();
  selectionLifecycle.disarm();
  captureSelection.dispose();
  selectionSurface.dispose();
  inPageWidgetHost?.dispose();
  inPageWidgetHost = null;
  inPageWidgetSurfaceClaim?.release();
  inPageWidgetSurfaceClaim = null;
  tracker.dispose();
  overlayRebind.dispose();
  persistentOverlays.dispose();
}

async function initializeCaptureSelectionMode(): Promise<void> {
  try {
    const response = await chrome.runtime.sendMessage({
      type: "ui-attach:content-settings-get",
    });
    if (!hasAppliedLiveSettings && isContentSettingsResponse(response)) {
      applyContentSettings(response.data);
    }
  } catch {
    // Defaults remain fail-closed when the background is unavailable during startup.
  }
}

async function initializeOverlayVisibility(): Promise<void> {
  const expectedRevision = overlayVisibilityRevision;
  try {
    const response = await chrome.runtime.sendMessage({
      type: UI_ATTACH_OVERLAY_VISIBILITY_GET,
    });
    if (
      overlayVisibilityRevision !== expectedRevision ||
      !isOverlayVisibilityResponse(response)
    ) return;
    applyOverlayVisibility(response.data.visible, true);
  } catch {
    // Marker visibility defaults to hidden when the background is unavailable.
  }
}

async function initializeOverlayScopeVisibility(): Promise<void> {
  const expectedRevision = overlayScopeVisibilityRevision;
  try {
    const response = await chrome.runtime.sendMessage({
      type: UI_ATTACH_OVERLAY_SCOPE_VISIBILITY_GET,
    });
    if (
      overlayScopeVisibilityRevision !== expectedRevision ||
      !isOverlayVisibilityResponse(response)
    ) return;
    applyOverlayScopeVisibility(response.data.visible, true);
  } catch {
    // Scope visibility stays fail-closed until exact background authority is available.
  }
}

async function initializeOverlayDisplayMode(): Promise<void> {
  const expectedRevision = overlayVisibilityRevision;
  try {
    const response = await chrome.runtime.sendMessage({ type: UI_ATTACH_OVERLAY_DISPLAY_MODE_GET });
    if (overlayVisibilityRevision !== expectedRevision || !isOverlayDisplayModeResponse(response)) return;
    applyOverlayDisplayMode(response.data.displayMode, true);
  } catch {
    // Old workers do not know the display-mode message; hover remains the safe default.
  }
}

function applyOverlayVisibility(visible: boolean, refresh: boolean): void {
  const previous = effectiveOverlaysVisible();
  overlaysVisible = visible;
  applyEffectiveOverlayVisibility(previous, refresh);
}

function applyOverlayScopeVisibility(visible: boolean, refresh: boolean): void {
  const previous = effectiveOverlaysVisible();
  overlayScopeVisible = visible;
  applyEffectiveOverlayVisibility(previous, refresh);
}

function effectiveOverlaysVisible(): boolean {
  return overlaysVisible && overlayScopeVisible;
}

function applyEffectiveOverlayVisibility(previous: boolean, refresh: boolean): void {
  const visible = effectiveOverlaysVisible();
  overlayCoordinator.setVisible(visible);
  if (visible && (previous !== visible || refresh)) {
    void requestOverlayRestore(liveOverlayStateRevision, true);
  }
}

function applyOverlayDisplayMode(mode: PersistentOverlayDisplayMode, refresh: boolean): void {
  overlayCoordinator.setDisplayMode(mode);
  if (effectiveOverlaysVisible() && refresh) void requestOverlayRestore(liveOverlayStateRevision, true);
}

async function refreshOverlayDescriptors(expectedRevision: number): Promise<void> {
  await requestOverlayRestore(expectedRevision, false);
}

function handleOverlayRouteChange(): void {
  liveOverlayStateRevision += 1;
  overlayProjectionApplicationRevision += 1;
  captureSelection.disableForNavigation();
  overlayCoordinator.applySelectionPreview(null);
  clearAppliedOverlayProjection();
  if (effectiveOverlaysVisible()) void requestOverlayRestore(liveOverlayStateRevision, true);
}

async function requestOverlayRestore(
  expectedRevision: number,
  applyRestoredState: boolean,
): Promise<OverlayRebindStatusData | null> {
  try {
    const response = await chrome.runtime.sendMessage({
      type: UI_ATTACH_OVERLAYS_RESTORE_GET,
    });
    if (
      liveOverlayStateRevision !== expectedRevision ||
      !isOverlayRestoreResponse(response) ||
      response.data.origin !== window.location.origin
    ) {
      return null;
    }
    if (applyRestoredState) {
      const state: OverlayStateMessage = {
        type: UI_ATTACH_OVERLAY_STATE,
        origin: response.data.origin,
        projection: response.data.projection,
        activeItemId: response.data.activeItemId,
        items: response.data.items.map(({ itemId, attachmentId, label, taskNote }) => ({
          itemId,
          attachmentId,
          label,
          taskNote,
        })),
      };
      if (!await applyOverlayProjection(state, response.data)) return null;
    } else if (!await applyOverlayProjection(null, response.data)) {
      return null;
    }
    return {
      origin: window.location.origin,
      pathname: window.location.pathname,
      items: overlayRebind.readStatus(),
    };
  } catch {
    // Overlay restore is best-effort and never changes capture/session truth.
    return null;
  }
}

async function requestCaptureObservation(
  message: CaptureObservationGetMessage,
): Promise<CaptureObservationResponse> {
  const page = {
    origin: window.location.origin,
    pathname: window.location.pathname,
  };
  const response = (
    status: Extract<CaptureObservationResponse, { ok: true }>['data']['status'],
    observation: Extract<CaptureObservationResponse, { ok: true }>['data']['observation'] = null,
  ): CaptureObservationResponse => ({
    ok: true,
    data: {
      itemId: message.itemId,
      attachmentId: message.attachmentId,
      origin: page.origin,
      pathname: page.pathname,
      status,
      observation,
    },
  });

  if (message.origin !== page.origin || message.pathname !== page.pathname) {
    return response("stale");
  }
  const read = overlayRebind.readCurrentTarget(message.itemId, message.attachmentId);
  if (read.status !== "restored") {
    return response(read.status);
  }
  if (!read.target) return response("unavailable");

  let capture;
  try {
    capture = await captureElementTarget(read.target, {
      locationHref: window.location.href,
      documentTitle: document.title,
      disclosureMode: "agent_safe",
    });
  } catch {
    return response("unavailable");
  }
  if (contentDeactivated || !overlayRebind.isCurrentTarget(read)) {
    return response("stale");
  }
  if (!capture.ok) return response("unavailable");
  const observation = createCaptureObservation(capture.record.attachment);
  return observation ? response("observed", observation) : response("unavailable");
}

async function applyOverlayProjection(
  state: OverlayStateMessage | null,
  restore?: OverlayRestoreData,
): Promise<boolean> {
  const projection = state?.projection ?? restore?.projection;
  if (!projection || projection.subject.origin !== window.location.origin ||
      projection.subject.pathname !== window.location.pathname) return false;
  const itemCount = state?.items.length ?? restore?.items.length ?? 0;
  if (itemCount > 0 && violatesClearProjectionFence(projection)) {
    applyFencedEmptyState();
    return false;
  }
  const applicationRevision = ++overlayProjectionApplicationRevision;
  if (acknowledgedOverlayProjection &&
      !sameOverlayProjectionDescriptor(acknowledgedOverlayProjection, projection)) {
    acknowledgedOverlayProjection = null;
  }
  if (state) {
    overlayRebind.applyState(state);
    overlayCoordinator.applyState(state);
    appliedOverlayProjection = projection;
  }
  if (restore) {
    await overlayRebind.restore(restore);
    if (applicationRevision !== overlayProjectionApplicationRevision ||
        !projectionMatchesCurrentRoute(projection)) {
      clearAppliedOverlayProjection(projection);
      return false;
    }
    appliedOverlayProjection = projection;
  }
  const accepted = await acknowledgeOverlayProjection(projection);
  if (applicationRevision !== overlayProjectionApplicationRevision ||
      !projectionMatchesCurrentRoute(projection)) {
    clearAppliedOverlayProjection(projection);
    return false;
  }
  if (accepted) {
    appliedOverlayProjection = projection;
    acknowledgedOverlayProjection = projection;
    if (itemCount > 0) persistentOverlays.setActionsEnabled(true);
    return true;
  }
  clearAppliedOverlayProjection(projection);
  if (effectiveOverlaysVisible()) void requestOverlayRestore(liveOverlayStateRevision, true);
  return false;
}

async function applyClearProjectionTombstone(
  clear: ClearProjectionReference,
): Promise<void> {
  const previousFence = clearProjectionFence;
  if (previousFence && (
    clear.generation < previousFence.generation ||
    (clear.generation === previousFence.generation &&
      !sameClearProjectionReference(previousFence, clear))
  )) return;

  liveOverlayStateRevision += 1;
  overlayProjectionApplicationRevision += 1;
  captureSelection.setEnabled(false);
  selectionLifecycle.disarm();
  overlayCoordinator.applySelectionPreview(null);
  clearOverlayActionFailure();
  persistentOverlays.setActionsEnabled(false);
  appliedOverlayProjection = null;
  acknowledgedOverlayProjection = null;
  clearProjectionFence = cloneClearProjectionReference(clear);
  applyFencedEmptyState();

  let status: ReturnType<typeof overlayCoordinator.readStatus>;
  try {
    status = overlayCoordinator.readStatus();
  } catch {
    return;
  }
  if (status.appliedItemIds.length !== 0 || status.markerCount !== 0 ||
      status.selectionPreviewActive) return;
  try {
    await chrome.runtime.sendMessage({
      type: UI_ATTACH_CLEAR_PROJECTION_ACK,
      clear: cloneClearProjectionReference(clear),
      readback: {
        appliedItemIds: [],
        markerCount: 0,
        selectionPreviewActive: false,
        digest: UI_ATTACH_EMPTY_APPLIED_ITEM_IDS_DIGEST,
      },
    });
  } catch {
    // The durable background journal retries this exact tombstone after restart.
  }
}

function applyFencedEmptyState(): void {
  const clear = clearProjectionFence;
  if (!clear) return;
  const empty: OverlayStateMessage = {
    type: UI_ATTACH_OVERLAY_STATE,
    origin: clear.origin,
    projection: {
      version: 1,
      projectionId: clear.projectionId,
      revision: clear.revision,
      sessionEpoch: clear.afterEpoch,
      subject: { ...clear.subject },
    },
    activeItemId: null,
    items: [],
  };
  overlayRebind.applyState(empty);
  overlayCoordinator.applyState(empty);
}

function violatesClearProjectionFence(projection: OverlayProjectionDescriptor): boolean {
  const clear = clearProjectionFence;
  return clear !== null && clear.origin === projection.subject.origin &&
    clear.subject.pathname === projection.subject.pathname &&
    projection.sessionEpoch !== clear.afterEpoch;
}

function clearProjectionMatchesCurrentRoute(clear: ClearProjectionReference): boolean {
  return clear.origin === window.location.origin &&
    clear.subject.origin === window.location.origin &&
    clear.subject.pathname === window.location.pathname;
}

function sameClearProjectionReference(
  left: ClearProjectionReference,
  right: ClearProjectionReference,
): boolean {
  return left.version === right.version && left.authorityId === right.authorityId &&
    left.operationId === right.operationId && left.generation === right.generation &&
    left.origin === right.origin && left.afterEpoch === right.afterEpoch &&
    left.projectionId === right.projectionId && left.revision === right.revision &&
    left.subject.tabId === right.subject.tabId && left.subject.frameId === right.subject.frameId &&
    left.subject.documentId === right.subject.documentId &&
    left.subject.origin === right.subject.origin && left.subject.pathname === right.subject.pathname;
}

function cloneClearProjectionReference(
  clear: ClearProjectionReference,
): ClearProjectionReference {
  return { ...clear, subject: { ...clear.subject } };
}

function projectionMatchesCurrentRoute(projection: OverlayProjectionDescriptor): boolean {
  return projection.subject.origin === window.location.origin &&
    projection.subject.pathname === window.location.pathname;
}

function sameOverlayProjectionDescriptor(
  left: OverlayProjectionDescriptor,
  right: OverlayProjectionDescriptor,
): boolean {
  return left.version === right.version && left.projectionId === right.projectionId &&
    left.revision === right.revision && left.sessionEpoch === right.sessionEpoch &&
    left.subject.tabId === right.subject.tabId && left.subject.frameId === right.subject.frameId &&
    left.subject.documentId === right.subject.documentId &&
    left.subject.origin === right.subject.origin && left.subject.pathname === right.subject.pathname;
}

function clearAppliedOverlayProjection(expected?: OverlayProjectionDescriptor): void {
  const projection = appliedOverlayProjection ?? acknowledgedOverlayProjection;
  if (!projection || (expected && projection !== expected)) return;
  const cleared: OverlayStateMessage = {
    type: UI_ATTACH_OVERLAY_STATE,
    origin: projection.subject.origin,
    projection,
    activeItemId: null,
    items: [],
  };
  overlayRebind.applyState(cleared);
  overlayCoordinator.applyState(cleared);
  if (appliedOverlayProjection === projection) appliedOverlayProjection = null;
  if (acknowledgedOverlayProjection === projection) acknowledgedOverlayProjection = null;
}

async function acknowledgeOverlayProjection(
  projection: OverlayProjectionDescriptor,
): Promise<boolean> {
  try {
    const response = await chrome.runtime.sendMessage({
      type: UI_ATTACH_OVERLAY_PROJECTION_ACK,
      projection: overlayProjectionRef(projection),
    });
    return isOverlayProjectionAckResponse(response) && response.data.accepted;
  } catch {
    return false;
  }
}

function overlayProjectionRef(projection: OverlayProjectionDescriptor): OverlayProjectionRef {
  return {
    version: projection.version,
    projectionId: projection.projectionId,
    revision: projection.revision,
  };
}

function parseDisclosureMode(value: unknown): UIAttachmentDisclosureMode {
  return value === "developer_diagnostic" || value === "full_debug" ? value : "agent_safe";
}

function applyContentSettings(settings: ContentSettingsData): void {
  currentDisclosureMode = settings.disclosureMode;
  if (settings.elementSelectionEnabled && selectionLifecycle.arm()) {
    captureSelection.setEnabled(true);
    return;
  }
  captureSelection.setEnabled(false);
  selectionLifecycle.disarm();
}

function isContentSettingsResponse(
  value: unknown,
): value is { ok: true; data: ContentSettingsData } {
  return (
    isRecord(value) &&
    hasOnlyKeys(value, ["ok", "data"]) &&
    value.ok === true &&
    isContentSettingsData(value.data)
  );
}

function isNullCommandResponse(value: unknown): value is { ok: true; data: null } {
  return (
    isRecord(value) &&
    hasOnlyKeys(value, ["ok", "data"]) &&
    value.ok === true &&
    value.data === null
  );
}

function isOverlayProjectionAckResponse(
  value: unknown,
): value is { ok: true; data: { accepted: boolean } } {
  return isRecord(value) && hasOnlyKeys(value, ["ok", "data"]) && value.ok === true &&
    isRecord(value.data) && hasOnlyKeys(value.data, ["accepted"]) &&
    typeof value.data.accepted === "boolean";
}

function isOverlayVisibilityResponse(
  value: unknown,
): value is { ok: true; data: { visible: boolean } } {
  if (
    !isRecord(value) ||
    !hasOnlyKeys(value, ["ok", "data"]) ||
    value.ok !== true ||
    !isRecord(value.data)
  ) return false;
  return hasOnlyKeys(value.data, ["visible"]) && typeof value.data.visible === "boolean";
}

function isOverlayDisplayModeResponse(
  value: unknown,
): value is { ok: true; data: { displayMode: PersistentOverlayDisplayMode } } {
  return isRecord(value) && hasOnlyKeys(value, ["ok", "data"]) && value.ok === true &&
    isRecord(value.data) && hasOnlyKeys(value.data, ["displayMode"]) &&
    (value.data.displayMode === "full" || value.data.displayMode === "hover" ||
      value.data.displayMode === "markers" || value.data.displayMode === "hidden");
}

function isContentSettingsUpdatedMessage(
  value: unknown,
): value is ContentSettingsData & { type: typeof UI_ATTACH_CONTENT_SETTINGS_UPDATED } {
  return (
    isRecord(value) &&
    hasOnlyKeys(value, ["type", "disclosureMode", "elementSelectionEnabled"]) &&
    value.type === UI_ATTACH_CONTENT_SETTINGS_UPDATED &&
    parseDisclosureMode(value.disclosureMode) === value.disclosureMode &&
    typeof value.elementSelectionEnabled === "boolean"
  );
}

function isContentSettingsData(value: unknown): value is ContentSettingsData {
  return (
    isRecord(value) &&
    hasOnlyKeys(value, ["disclosureMode", "elementSelectionEnabled"]) &&
    parseDisclosureMode(value.disclosureMode) === value.disclosureMode &&
    typeof value.elementSelectionEnabled === "boolean"
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function hasOnlyKeys(value: Record<string, unknown>, allowedKeys: string[]): boolean {
  const allowed = new Set(allowedKeys);
  return Object.keys(value).every((key) => allowed.has(key));
}

async function beginCapture(
  replaceItemId: string | null = null,
): Promise<SessionCommandResponse<RuntimeCaptureToken>> {
  return chrome.runtime.sendMessage({
    type: "ui-attach:session-begin-capture",
    replaceItemId,
  }) as Promise<SessionCommandResponse<RuntimeCaptureToken>>;
}

async function commitCapture(
  token: RuntimeCaptureToken,
  record: OriginCaptureRecord,
  metadataDiagnosticsDevice?: MetadataDiagnosticsDeviceV1,
): Promise<SessionCommandResponse<CaptureCommitReceipt>> {
  const response = await chrome.runtime.sendMessage({
    type: "ui-attach:session-commit-capture",
    token,
    record,
    ...(metadataDiagnosticsDevice ? { metadataDiagnosticsDevice } : {}),
  });
  return isCaptureCommitResponse(response)
    ? response
    : { ok: false, code: "INVALID_RESPONSE", error: SAFE_CAPTURE_ERROR };
}

async function publishFailure(error: string): Promise<void> {
  await publishRuntimeMessage({
    type: UI_ATTACH_CAPTURE_FAILED,
    error,
  });
}

async function publishRuntimeMessage(message: unknown): Promise<void> {
  try {
    await chrome.runtime.sendMessage(message);
  } catch {
    // The side panel may not be open while page selection is active.
  }
}

async function handleOverlayAction(
  action: Exclude<OverlayActionRequestAction, "save">,
  itemId: string,
): Promise<void> {
  if (await requestOverlayAction(action, itemId)) {
    clearOverlayActionFailure();
    return;
  }
  showOverlayActionFailure();
}

function showOverlayActionFailure(): void {
  if (contentDeactivated) return;
  clearOverlayActionFailure();
  const host = document.createElement("div");
  host.dataset.uiAttachOverlayActionFailure = "true";
  host.dataset.uiAttachIgnore = "true";
  host.style.position = "fixed";
  host.style.right = "16px";
  host.style.bottom = "16px";
  host.style.zIndex = "2147483647";
  host.style.pointerEvents = "none";
  const shadow = host.attachShadow({ mode: "open" });
  const style = document.createElement("style");
  style.textContent = `
    :host { all: initial; }
    [role="alert"] {
      max-width: 320px;
      padding: 10px 12px;
      border: 1px solid rgb(244 114 182 / 55%);
      border-radius: 10px;
      background: #261820;
      color: #ffe7f0;
      box-shadow: 0 12px 34px rgb(0 0 0 / 34%);
      font: 600 12px/1.4 system-ui, sans-serif;
    }
  `;
  const alert = document.createElement("div");
  alert.setAttribute("role", "alert");
  alert.setAttribute("aria-live", "assertive");
  alert.textContent = "MeanThis could not complete this annotation action.";
  shadow.append(style, alert);
  document.documentElement.append(host);
  overlayActionFailureHost = host;
  overlayActionFailureTimer = window.setTimeout(clearOverlayActionFailure, 6_000);
}

function clearOverlayActionFailure(): void {
  if (overlayActionFailureTimer !== null) {
    window.clearTimeout(overlayActionFailureTimer);
    overlayActionFailureTimer = null;
  }
  overlayActionFailureHost?.remove();
  overlayActionFailureHost = null;
}

async function requestOverlayAction(
  action: Exclude<OverlayActionRequestAction, "save">,
  itemId: string,
): Promise<boolean> {
  const projection = acknowledgedOverlayProjection;
  if (!projection) return false;
  const message = {
    type: UI_ATTACH_OVERLAY_ACTION_REQUEST,
    action,
    itemId,
    projection: overlayProjectionRef(projection),
  } satisfies OverlayActionRequestMessage;
  if (!isOverlayActionRequestMessage(message)) return false;
  return await sendOverlayActionWithOneReack(message, projection);
}

async function requestOverlaySave(itemId: string, taskNote: string): Promise<boolean> {
  const projection = acknowledgedOverlayProjection;
  if (!projection) return false;
  const message = {
    type: UI_ATTACH_OVERLAY_ACTION_REQUEST,
    action: "save",
    itemId,
    taskNote,
    projection: overlayProjectionRef(projection),
  } satisfies OverlayActionRequestMessage;
  if (!isOverlayActionRequestMessage(message)) return false;
  return await sendOverlayActionWithOneReack(message, projection);
}

async function sendOverlayActionWithOneReack(
  message: OverlayActionRequestMessage,
  projection: OverlayProjectionDescriptor,
): Promise<boolean> {
  try {
    const first = await chrome.runtime.sendMessage(message);
    if (isNullCommandResponse(first)) return true;
    if (!isOverlayProjectionReackRequiredResponse(first) ||
        acknowledgedOverlayProjection !== projection ||
        !projectionMatchesCurrentRoute(projection) ||
        !await acknowledgeOverlayProjection(projection) ||
        acknowledgedOverlayProjection !== projection ||
        !projectionMatchesCurrentRoute(projection)) return false;
    return isNullCommandResponse(await chrome.runtime.sendMessage(message));
  } catch {
    return false;
  }
}

function isOverlayProjectionReackRequiredResponse(value: unknown): value is {
  ok: false;
  code: typeof UI_ATTACH_OVERLAY_PROJECTION_REACK_REQUIRED;
  error: string;
} {
  return isRecord(value) && hasOnlyKeys(value, ["ok", "code", "error"]) &&
    value.ok === false && value.code === UI_ATTACH_OVERLAY_PROJECTION_REACK_REQUIRED &&
    typeof value.error === "string";
}
