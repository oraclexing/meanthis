import "./extension-api";
import { captureElementTarget } from "./capture";
import type { UIAttachmentDisclosureMode } from "@meanthis/schema";
import type { OriginCaptureRecord } from "./capture-store";
import { createContextTargetTracker } from "./context-target";
import { createContentOverlayCoordinator } from "./content-overlays";
import {
  UI_ATTACH_CONTENT_DEACTIVATE,
  UI_ATTACH_CONTENT_READY_GET,
  UI_ATTACH_EMBEDDED_FRAME_HOST_INSPECT,
  UI_ATTACH_CONTENT_SETTINGS_UPDATED,
  UI_ATTACH_OVERLAYS_RESTORE_GET,
  UI_ATTACH_OVERLAY_STATE,
  UI_ATTACH_OVERLAY_VISIBILITY_GET,
  UI_ATTACH_SELECTION_LIFECYCLE_PORT,
  isCaptureCommitResponse,
  isOverlayPreviewForPage,
  isOverlayPreviewMessage,
  isOverlayRelationPreviewForPage,
  isOverlayRelationPreviewMessage,
  isOverlayRebindStatusGetMessage,
  isOverlayRestoreRefreshMessage,
  isOverlayRestoreResponse,
  isOverlayStateMessage,
  isOverlayVisibilityUpdatedMessage,
  isSelectionSeedContextTargetMessage,
  isEmbeddedFrameHostInspectMessage,
  type CaptureCommitReceipt,
  type ContentSettingsData,
  type OverlayRebindStatusData,
  type SessionCommandResponse,
} from "./messages";
import { inspectEmbeddedFrameHost } from "./embedded-frame-host";
import { createPersistentOverlayController } from "./persistent-overlays";
import { createOverlayRebindController } from "./overlay-rebind";
import { commitLiveOverlayCapture } from "./overlay-restore";
import { createTestClickCaptureController } from "./test-click-capture";
import { createSelectionLifecycleController } from "./selection-lifecycle";
import { createSelectionSurfaceController } from "./selection-surface";
import type { CaptureToken } from "./session-state";

const UI_ATTACH_CAPTURE_FAILED = "ui-attach:capture-failed";
const SAFE_CAPTURE_ERROR = "ui-attach capture failed.";

const tracker = createContextTargetTracker(document);
const persistentOverlays = createPersistentOverlayController({
  root: document,
  relationRoleLabels: {
    source: getLocalizedMessage("element", "Element"),
    reference: getLocalizedMessage("relative_to", "Relative to"),
  },
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
let overlayVisibilityRevision = 0;
let overlaysVisible = false;
let contentDeactivated = false;
const selectionSurface = createSelectionSurfaceController({ root: document });

function getLocalizedMessage(key: string, fallback: string): string {
  try {
    return chrome.i18n?.getMessage(key) || fallback;
  } catch {
    return fallback;
  }
}
const testClickCapture = createTestClickCaptureController({
  root: document,
  beginCapture,
  captureTarget: (target) =>
    captureElementTarget(target, {
      locationHref: window.location.href,
      documentTitle: document.title,
      disclosureMode: currentDisclosureMode,
    }),
  commitCapture,
  publishFailure,
  isTargetCommitted: (target) => overlayCoordinator.hasTarget(target),
  previewTarget: (target) => {
    overlayCoordinator.applySelectionPreview(target);
  },
  pointerEventTarget: selectionSurface.eventTarget,
  resolveTarget: (event) => selectionSurface.resolveTarget(event),
  onEnabledChange: (enabled) => selectionSurface.setEnabled(enabled),
  disableSelection: async () => {
    const response = await chrome.runtime.sendMessage({
      type: "ui-attach:content-selection-disable",
    });
    if (!isNullCommandResponse(response)) throw new Error(SAFE_CAPTURE_ERROR);
  },
  publishCommitted: (target, receipt, record) => commitLiveOverlayCapture({
    record,
    receipt,
    currentUrl: window.location.href,
    target,
    trackCurrentRoute: () => overlayRebind.trackCurrentRoute(),
    bindLiveTarget: (liveTarget, liveReceipt) => {
      overlayCoordinator.commitTarget(liveTarget, liveReceipt);
    },
    bindReplayTarget: (item, replayTarget) => overlayRebind.commitCurrent(item, replayTarget),
  }),
});
const selectionLifecycle = createSelectionLifecycleController({
  connect: () => chrome.runtime.connect({ name: UI_ATTACH_SELECTION_LIFECYCLE_PORT }),
  onDisconnect: () => testClickCapture.setEnabled(false),
});

void initializeTestClickCaptureMode();
void initializeOverlayVisibility();

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
  if (
    isRecord(message) &&
    hasOnlyKeys(message, ["type"]) &&
    message.type === UI_ATTACH_CONTENT_READY_GET
  ) {
    sendResponse({ ok: true, data: null });
    return false;
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
      overlayRebind.applyState(message);
      overlayCoordinator.applyState(message);
      void refreshOverlayDescriptors(liveOverlayStateRevision);
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
  if (isSelectionSeedContextTargetMessage(message)) {
    const target = tracker.takeLatestTarget();
    sendResponse({
      ok: true,
      data: { seeded: testClickCapture.seedPreview(target) },
    });
    return false;
  }
  return false;
});

function deactivateContentRuntime(): void {
  if (contentDeactivated) return;
  contentDeactivated = true;
  selectionLifecycle.disarm();
  testClickCapture.dispose();
  selectionSurface.dispose();
  tracker.dispose();
  overlayRebind.dispose();
  persistentOverlays.dispose();
}

async function initializeTestClickCaptureMode(): Promise<void> {
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

function applyOverlayVisibility(visible: boolean, refresh: boolean): void {
  const changed = overlaysVisible !== visible;
  overlaysVisible = visible;
  overlayCoordinator.setVisible(visible);
  if (visible && (changed || refresh)) {
    void requestOverlayRestore(liveOverlayStateRevision, true);
  }
}

async function refreshOverlayDescriptors(expectedRevision: number): Promise<void> {
  await requestOverlayRestore(expectedRevision, false);
}

function handleOverlayRouteChange(): void {
  liveOverlayStateRevision += 1;
  testClickCapture.disableForNavigation();
  overlayCoordinator.applySelectionPreview(null);
  overlayCoordinator.applyState({
    type: UI_ATTACH_OVERLAY_STATE,
    origin: window.location.origin,
    activeItemId: null,
    items: [],
  });
  if (overlaysVisible) void requestOverlayRestore(liveOverlayStateRevision, true);
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
      overlayCoordinator.applyState({
        type: UI_ATTACH_OVERLAY_STATE,
        origin: response.data.origin,
        activeItemId: response.data.activeItemId,
        items: response.data.items.map(({ itemId, attachmentId, label }) => ({
          itemId,
          attachmentId,
          label,
        })),
      });
    }
    await overlayRebind.restore(response.data);
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

function parseDisclosureMode(value: unknown): UIAttachmentDisclosureMode {
  return value === "developer_diagnostic" || value === "full_debug" ? value : "agent_safe";
}

function applyContentSettings(settings: ContentSettingsData): void {
  currentDisclosureMode = settings.disclosureMode;
  if (settings.testClickCaptureEnabled && selectionLifecycle.arm()) {
    testClickCapture.setEnabled(true);
    return;
  }
  testClickCapture.setEnabled(false);
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

function isContentSettingsUpdatedMessage(
  value: unknown,
): value is ContentSettingsData & { type: typeof UI_ATTACH_CONTENT_SETTINGS_UPDATED } {
  return (
    isRecord(value) &&
    hasOnlyKeys(value, ["type", "disclosureMode", "testClickCaptureEnabled"]) &&
    value.type === UI_ATTACH_CONTENT_SETTINGS_UPDATED &&
    parseDisclosureMode(value.disclosureMode) === value.disclosureMode &&
    typeof value.testClickCaptureEnabled === "boolean"
  );
}

function isContentSettingsData(value: unknown): value is ContentSettingsData {
  return (
    isRecord(value) &&
    hasOnlyKeys(value, ["disclosureMode", "testClickCaptureEnabled"]) &&
    parseDisclosureMode(value.disclosureMode) === value.disclosureMode &&
    typeof value.testClickCaptureEnabled === "boolean"
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function hasOnlyKeys(value: Record<string, unknown>, allowedKeys: string[]): boolean {
  const allowed = new Set(allowedKeys);
  return Object.keys(value).every((key) => allowed.has(key));
}

async function beginCapture(): Promise<SessionCommandResponse<CaptureToken>> {
  return chrome.runtime.sendMessage({
    type: "ui-attach:session-begin-capture",
  }) as Promise<SessionCommandResponse<CaptureToken>>;
}

async function commitCapture(
  token: CaptureToken,
  record: OriginCaptureRecord,
): Promise<SessionCommandResponse<CaptureCommitReceipt>> {
  const response = await chrome.runtime.sendMessage({
    type: "ui-attach:session-commit-capture",
    token,
    record,
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
