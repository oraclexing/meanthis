import type { CaptureRouteSegmentV1 } from "@meanthis/hub-core";
import type { OriginCaptureRecord } from "./capture-store";
import type {
  UiAttachChrome,
  UiAttachChromeContextMenuClickData,
  UiAttachChromeFrame,
  UiAttachChromeFrameDetails,
  UiAttachChromeMessageSender,
  UiAttachChromeNavigationCommittedDetails,
  UiAttachChromePort,
  UiAttachChromeSidePanelOpenOptions,
  UiAttachChromeTab,
} from "./extension-api";
import {
  UI_ATTACH_ACTIVE_ORIGIN_CHANGED,
  UI_ATTACH_CAPTURE_FAILED,
  UI_ATTACH_CONTENT_SETTINGS_UPDATED,
  UI_ATTACH_CONTEXT_MENU_ID,
  UI_ATTACH_EMBEDDED_FRAME_HOST_INSPECT,
  UI_ATTACH_ELEMENT_SELECTION_UPDATED,
  UI_ATTACH_OVERLAY_PREVIEW,
  UI_ATTACH_OVERLAY_RELATION_PREVIEW,
  UI_ATTACH_OVERLAY_RESTORE_REFRESH,
  UI_ATTACH_OVERLAYS_RESTORE_GET,
  UI_ATTACH_OVERLAY_STATE,
  UI_ATTACH_OVERLAY_VISIBILITY_GET,
  UI_ATTACH_OVERLAY_VISIBILITY_UPDATED,
  UI_ATTACH_PANEL_LIFECYCLE_PORT_PREFIX,
  UI_ATTACH_SELECTION_LIFECYCLE_PORT,
  UI_ATTACH_SELECTION_SEED_CONTEXT_TARGET,
  UI_ATTACH_SESSION_UPDATED,
  OVERLAY_RESTORE_MAX_ITEMS,
  isEmbeddedFrameHostInspectResponse,
  isOverlayRebindStatusResponse,
  type ActivePageContext,
  type ActiveSessionCommandData,
  type ActiveOriginChangedMessage,
  type CaptureCommitReceipt,
  type CaptureFailedMessage,
  type ContentSettingsData,
  type ElementSelectionUpdatedMessage,
  type FrameScopeDescriptor,
  type FrameScopeListData,
  type OverlayStateItem,
  type OverlayRestoreData,
  type OverlayRebindStatusData,
  type OverlayRestoreItem,
  type SavedSessionRouteResolutionData,
  type SessionCommand,
  type SessionCommandResponse,
  type SessionUpdatedMessage,
} from "./messages";
import type { ActiveSessionReadback, ExtensionSessionStore, SessionStoreResult } from "./session-store";
import type { CaptureToken } from "./session-state";
import type { FirstCaptureDisclosureStore } from "./first-capture-disclosure";
import {
  collectOverlayReplayLocators,
  collectVerifiedContentAnchoredOverlayReplayLocators,
  collectVerifiedOverlayReplayLocators,
} from "./overlay-restore";
import { deriveStoredSessionHandoff, deriveStoredSessionReview } from "./session-file";
import {
  readContextMenuSelectionMode,
  readOverlayVisibilityPreference,
  OVERLAY_VISIBILITY_PREFERENCE_KEY,
  type ContextMenuSelectionMode,
  type OverlayVisibilityPreference,
} from "./settings-preferences";
import {
  acquireFrameScopePermission,
  FrameScopeAccessError,
  type FrameScopePermissionLease,
} from "./frame-scope-access";
import { resolveSidePanelOpenOptions } from "./toolbar-entry";

const SAFE_CAPTURE_ERROR = "ui-attach capture failed.";
const FIRST_CAPTURE_DISCLOSURE_REQUIRED_ERROR =
  "Review and acknowledge the MeanThis data disclosure before capturing.";
const DISCLOSURE_MODE_KEY = "ui-attach:disclosure-mode";
const FRAME_SCOPE_SESSION_KEY = "ui-attach:frame-scopes-v1";
const OVERLAY_ACTIVE_ITEMS_SESSION_KEY = "ui-attach:overlay-active-items-v1";
const MAX_RESUMABLE_FRAME_SCOPES = 64;
const MAX_OVERLAY_ACTIVE_ITEMS = 64;
const SAVED_RESTORE_ACTIVATION_ATTEMPTS = 8;
const SAVED_RESTORE_DISCOVERY_ATTEMPTS = 8;
const SAVED_RESTORE_CONTENT_ATTEMPTS = 3;
const SAVED_RESTORE_RESPONSE_ATTEMPTS = 3;
const SAVED_RESTORE_ACTIVATION_RETRY_MS = 25;

type GuardResult<T> =
  | { ok: true; value: T }
  | { ok: false; issues: Array<{ path: string; message: string }>; unknownType?: true };

type RuntimeResponse = SessionCommandResponse<unknown> | undefined;

export interface BackgroundRuntimeFeature {
  matches(message: unknown): boolean;
  handle(message: unknown): Promise<SessionCommandResponse<unknown>>;
}

interface OverlayEndpoint {
  tabId: number;
  frameId: number;
  documentId?: string;
}

interface ElementSelectionEndpoint extends OverlayEndpoint {
  documentId?: string;
}

interface ElementSelectionTarget {
  frameId: number;
  frameOrigin?: string;
  framePathname?: string;
  documentId?: string;
  parentFrameId?: number;
  parentDocumentId?: string;
  parentFrameOrigin?: string;
  parentFramePathname?: string;
}

interface ResumableElementSelectionScope {
  tabId: number;
  windowId: number;
  target: ElementSelectionTarget;
  expectedPage: { origin: string; pathname: string };
}

interface OverlayGroup {
  endpoint: OverlayEndpoint;
  items: OverlayStateItem[];
}

interface OverlayPreviewLease extends OverlayEndpoint {
  origin: string;
  pathname: string;
  itemId: string;
}

interface ElementSelectionPageContext extends ActivePageContext {
  windowId: number;
}

interface ResolvedEmbeddedFrameSelection {
  target: {
    tabId: number;
    pageOrigin: string;
    pagePathname: string;
    parentFrameId: number;
    frameOrigin: string;
    framePathname: string;
    requiresHostPermission: boolean;
  };
  selectionTarget: ElementSelectionTarget;
  expectedPage: { origin: string; pathname: string };
}

interface SavedSessionRestoreTarget {
  tabId: number;
  frameId: number;
  documentId: string;
  origin: string;
  pathname: string;
  topOrigin: string;
  topPathname: string;
  routeChain?: CaptureRouteSegmentV1[];
  location: SavedSessionRouteResolutionData["location"];
}

export interface BackgroundController {
  handleContextMenuClick(info: UiAttachChromeContextMenuClickData, tab?: UiAttachChromeTab): Promise<void>;
  handleRuntimeMessage(message: unknown, sender: UiAttachChromeMessageSender): Promise<RuntimeResponse>;
  handleNavigationCommitted(details: UiAttachChromeNavigationCommittedDetails): Promise<void>;
  handleTabActivated(activeInfo: { tabId: number; windowId: number }): Promise<void>;
  handleTabUpdated(
    tabId: number,
    changeInfo: { status?: string; url?: string },
    tab: UiAttachChromeTab,
  ): Promise<void>;
  refreshActivePage(): Promise<void>;
  register(): void;
}

export function createBackgroundController(options: {
  chrome: UiAttachChrome;
  store: ExtensionSessionStore;
  firstCaptureDisclosure: FirstCaptureDisclosureStore;
  runtimeFeatures?: readonly BackgroundRuntimeFeature[];
  ensureContentScript?: (tabId: number, frameId: number, documentId?: string) => Promise<boolean>;
  openSidePanel?: (options: UiAttachChromeSidePanelOpenOptions) => Promise<void>;
  storageAccessReady?: Promise<boolean>;
}): BackgroundController {
  const chrome = options.chrome;
  const store = options.store;
  const firstCaptureDisclosure = options.firstCaptureDisclosure;
  const runtimeFeatures = options.runtimeFeatures ?? [];
  const storageAccessReady = (options.storageAccessReady ?? Promise.resolve(true)).then(
    (ready) => ready === true,
    () => false,
  );
  const ensureContentScript = options.ensureContentScript ?? (async () => true);
  let settingsBroadcastRequested = false;
  let settingsBroadcastTask: Promise<void> | null = null;
  let settingsDeliveryTail = Promise.resolve();
  let currentDisclosureMode: ContentSettingsData["disclosureMode"] = "agent_safe";
  let overlayVisibilityBroadcastRequested = false;
  let overlayVisibilityBroadcastTask: Promise<void> | null = null;
  const panelVisibilityLeaseCountsByWindow = new Map<number, number>();
  let elementSelectionTabId: number | null = null;
  let elementSelectionFrameId: number | null = null;
  let elementSelectionDocumentId: string | null = null;
  let elementSelectionFrameOrigin: string | null = null;
  let elementSelectionFramePathname: string | null = null;
  let elementSelectionParentFrameId: number | null = null;
  let elementSelectionParentDocumentId: string | null = null;
  let elementSelectionParentFrameOrigin: string | null = null;
  let elementSelectionParentFramePathname: string | null = null;
  let elementSelectionTopOrigin: string | null = null;
  let elementSelectionTopPathname: string | null = null;
  let elementSelectionWindowId: number | null = null;
  let elementSelectionMode: ContextMenuSelectionMode = "continuous";
  const resumableElementSelectionScopes = new Map<number, ResumableElementSelectionScope>();
  let resumableElementSelectionScopesLoadTask: Promise<void> | null = null;
  let resumableElementSelectionScopesWriteTail = Promise.resolve();
  let elementSelectionPendingTabId: number | null = null;
  let elementSelectionPendingFrameId: number | null = null;
  let elementSelectionPendingDocumentId: string | null = null;
  let elementSelectionPendingFrameOrigin: string | null = null;
  let elementSelectionPendingFramePathname: string | null = null;
  let elementSelectionPendingParentFrameId: number | null = null;
  let elementSelectionPendingParentDocumentId: string | null = null;
  let elementSelectionPendingParentFrameOrigin: string | null = null;
  let elementSelectionPendingParentFramePathname: string | null = null;
  let elementSelectionPendingTopOrigin: string | null = null;
  let elementSelectionPendingTopPathname: string | null = null;
  let elementSelectionPendingWindowId: number | null = null;
  let elementSelectionRevision = 0;
  let contextMenuInvocationRevision = 0;
  const knownOverlayEndpointsByOrigin = new Map<string, Map<string, OverlayEndpoint>>();
  const overlaySyncTails = new Map<string, Promise<void>>();
  const activeOverlayItemIdsByOrigin = new Map<string, string>();
  let activeOverlayItemIdsLoadTask: Promise<void> | null = null;
  let activeOverlayItemIdsWriteTail = Promise.resolve();
  const overlayPreviewLeasesByOrigin = new Map<string, OverlayPreviewLease>();
  const openSidePanel =
    options.openSidePanel ??
    (async (openOptions: UiAttachChromeSidePanelOpenOptions) => {
      try {
        await chrome.sidePanel?.open(openOptions);
      } catch {
        // Some Chromium builds expose sidePanel only behind permissions or user gestures.
      }
    });

  async function handleContextMenuClick(
    info: UiAttachChromeContextMenuClickData,
    tab?: UiAttachChromeTab,
  ): Promise<void> {
    try {
      if (info.menuItemId !== UI_ATTACH_CONTEXT_MENU_ID) {
        return;
      }
      const tabId = tab?.id;
      if (tabId === undefined) {
        await publishFailure("ui-attach could not resolve the active tab.");
        return;
      }
      const frameId = info.frameId ?? 0;
      const documentUrl = frameId === 0 ? info.pageUrl ?? tab?.url : info.frameUrl;
      const origin = originFromUrl(documentUrl);
      const pathname = pathnameFromUrl(documentUrl);
      const topOrigin = originFromUrl(tab?.url ?? info.pageUrl);
      const topPathname = pathnameFromUrl(tab?.url ?? info.pageUrl);
      if (!origin || pathname === null || topOrigin === null || topPathname === null) {
        await publishFailure("ui-attach can only capture HTTP(S) pages.");
        return;
      }
      const permissionLeasePromise = frameId !== 0 && origin !== topOrigin
        ? acquireFrameScopePermission(chrome.permissions, origin)
        : null;
      const contextInvocationRevision = ++contextMenuInvocationRevision;
      let permissionLease: FrameScopePermissionLease | null = null;
      try {
        void openSidePanel(resolveSidePanelOpenOptions({
          id: tabId,
          windowId: tab?.windowId,
        })).catch(() => undefined);
        const previousSelectionRevocation = revokeElementSelectionLease();
        const selectionRevisionAtContextInvocation = elementSelectionRevision;
        if (permissionLeasePromise) {
          try {
            permissionLease = await permissionLeasePromise;
          } catch (error) {
            await publishFailure(frameScopeAccessFailureMessage(error));
            return;
          }
        }
        await previousSelectionRevocation;
        if (
          contextInvocationRevision !== contextMenuInvocationRevision ||
          selectionRevisionAtContextInvocation !== elementSelectionRevision
        ) return;
        if (!(await storageAccessReady)) {
          await publishFailure(SAFE_CAPTURE_ERROR);
          return;
        }
        const contextMenuSelectionMode = await readContextMenuSelectionMode(chrome.storage.local);
        if (
          contextInvocationRevision !== contextMenuInvocationRevision ||
          selectionRevisionAtContextInvocation !== elementSelectionRevision
        ) return;
        const selectionTarget = await readContextSelectionTarget(
          tabId,
          frameId,
          origin,
          pathname,
        );
        if (
          contextInvocationRevision !== contextMenuInvocationRevision ||
          selectionRevisionAtContextInvocation !== elementSelectionRevision
        ) return;
        if (!selectionTarget) {
          await publishFailure("The right-clicked page frame is no longer available.");
          return;
        }
        const selection = await setElementSelectionLease({
          type: "ui-attach:element-selection-set",
          enabled: true,
          tabId,
        }, selectionTarget, {
          origin: topOrigin,
          pathname: topPathname,
        }, contextMenuSelectionMode, selectionRevisionAtContextInvocation, contextInvocationRevision);
        if (!selection.ok) {
          if (contextInvocationRevision !== contextMenuInvocationRevision) return;
          await publishFailure(selection.error);
          return;
        }
        if (
          selection.data.enabled &&
          contextInvocationRevision === contextMenuInvocationRevision &&
          contextSelectionLeaseMatches(tabId, selectionTarget, {
            origin: topOrigin,
            pathname: topPathname,
          })
        ) {
          try {
            await chrome.tabs.sendMessage(tabId, {
              type: UI_ATTACH_SELECTION_SEED_CONTEXT_TARGET,
            }, {
              frameId,
              ...(selectionTarget.documentId
                ? { documentId: selectionTarget.documentId }
                : {}),
            });
          } catch {
            // Freshly injected scripts may not have observed the original contextmenu event.
            // Selection remains active and waits for pointer movement instead of guessing.
          }
        }
      } finally {
        if (permissionLease) {
          try {
            await permissionLease.release();
          } catch (error) {
            await revokeElementSelectionLease();
            await publishFailure(frameScopeAccessFailureMessage(error));
          }
        }
      }
    } catch {
      await publishFailure(SAFE_CAPTURE_ERROR);
      return;
    }
  }

  async function readContextSelectionTarget(
    tabId: number,
    frameId: number,
    expectedOrigin: string,
    expectedPathname: string,
  ): Promise<ElementSelectionTarget | null> {
    try {
      const frame = await chrome.webNavigation.getFrame({ tabId, frameId });
      if (!frame) return frameId === 0 ? { frameId } : null;
      if (
        originFromUrl(frame.url) !== expectedOrigin ||
        pathnameFromUrl(frame.url) !== expectedPathname
      ) return null;
      if (frameId === 0) {
        return {
          frameId,
          ...(frame.documentId ? { documentId: frame.documentId } : {}),
        };
      }
      if (!frame.documentId || frame.parentFrameId < 0) return null;
      const target: ElementSelectionTarget = {
        frameId,
        documentId: frame.documentId,
        frameOrigin: expectedOrigin,
        framePathname: expectedPathname,
        parentFrameId: frame.parentFrameId,
      };
      if (frame.parentFrameId > 0) {
        const parent = await chrome.webNavigation.getFrame({
          tabId,
          frameId: frame.parentFrameId,
        });
        const parentOrigin = originFromUrl(parent?.url);
        const parentPathname = pathnameFromUrl(parent?.url);
        if (!parent?.documentId || !parentOrigin || !parentPathname) return null;
        target.parentDocumentId = parent.documentId;
        target.parentFrameOrigin = parentOrigin;
        target.parentFramePathname = parentPathname;
      }
      return target;
    } catch {
      return frameId === 0 ? { frameId } : null;
    }
  }

  async function readContextDocumentId(
    tabId: number,
    expectedOrigin: string,
    expectedPathname: string,
  ): Promise<string | null> {
    try {
      const frame = await chrome.webNavigation.getFrame({ tabId, frameId: 0 });
      return frame?.documentId &&
          originFromUrl(frame.url) === expectedOrigin &&
          pathnameFromUrl(frame.url) === expectedPathname
        ? frame.documentId
        : null;
    } catch {
      return null;
    }
  }

  async function handleRuntimeMessage(
    message: unknown,
    sender: UiAttachChromeMessageSender,
  ): Promise<RuntimeResponse> {
    try {
      const runtimeFeature = runtimeFeatures.find((feature) => feature.matches(message));
      if (runtimeFeature) {
        if (!isExtensionPageSender(sender)) return untrustedSender();
        return runtimeFeature.handle(message);
      }
      const command = parseSessionCommand(message);
      if (!command.ok) {
        if (command.unknownType) return undefined;
        return invalidCommand(command.issues);
      }
      if (!(await storageAccessReady)) return failure("CAPTURE_FAILED", SAFE_CAPTURE_ERROR);

      switch (command.value.type) {
        case "ui-attach:session-get-active": {
          if (!isExtensionPageSender(sender)) return untrustedSender();
          return await getActiveSession();
        }
        case "ui-attach:session-list-stored": {
          if (!isExtensionPageSender(sender)) return untrustedSender();
          return storeResult(await store.list());
        }
        case "ui-attach:session-review-stored": {
          if (!isExtensionPageSender(sender)) return untrustedSender();
          const readback = await store.read(command.value.origin);
          if (!readback.ok) return storeResult(readback);
          if (
            !readback.value.epoch ||
            readback.value.clearPending ||
            !readback.value.file
          ) {
            return failure("INVALID_SESSION_FILE", "Stored capture session is unavailable.");
          }
          const review = deriveStoredSessionReview(
            readback.value.file,
            readback.value.origin,
            readback.value.epoch,
          );
          return review.ok
            ? { ok: true, data: review.value }
            : failure(review.code, review.error);
        }
        case "ui-attach:saved-session-restore-current": {
          if (!isExtensionPageSender(sender)) return untrustedSender();
          return await restoreSavedSessionOnCurrentPage(command.value.origin);
        }
        case "ui-attach:saved-session-resolve-route": {
          if (!isExtensionPageSender(sender)) return untrustedSender();
          const resolved = await findSavedSessionRestoreTarget(command.value);
          return resolved.ok
            ? {
                ok: true,
                data: {
                  location: resolved.data.location,
                  requiresHostPermission:
                    resolved.data.frameId > 0 &&
                    resolved.data.origin !== resolved.data.topOrigin,
                },
              }
            : resolved;
        }
        case "ui-attach:saved-session-restore-route": {
          if (!isExtensionPageSender(sender)) return untrustedSender();
          return await restoreSavedSessionRoute(command.value);
        }
        case "ui-attach:session-prepare-snapshot-handoff": {
          if (!isExtensionPageSender(sender)) return untrustedSender();
          const readback = await store.read(command.value.origin);
          if (!readback.ok) return storeResult(readback);
          if (
            !readback.value.epoch ||
            readback.value.clearPending ||
            !readback.value.file
          ) {
            return failure("INVALID_SESSION_FILE", "Stored capture session is unavailable.");
          }
          if (readback.value.epoch !== command.value.epoch) {
            return failure("STALE_SESSION", "Stored capture session changed after review.");
          }
          const handoff = deriveStoredSessionHandoff(
            readback.value.file,
            readback.value.origin,
            readback.value.epoch,
          );
          return handoff.ok
            ? { ok: true, data: handoff.value }
            : failure(handoff.code, handoff.error);
        }
        case "ui-attach:session-clear-all-stored": {
          if (!isExtensionPageSender(sender)) return untrustedSender();
          const cleared = await store.clearAll();
          if (cleared.ok) {
            await Promise.all(cleared.value.clearedOrigins.map((origin) => syncOverlaySession({
              origin,
              epoch: null,
              clearPending: false,
              activeClearOperationId: null,
              file: null,
              legacyRecord: null,
            }, null)));
          }
          return storeResult(cleared);
        }
        case "ui-attach:content-settings-get": {
          const senderTabId = contentTabIdFromSender(sender);
          const senderFrameId = contentFrameIdFromSender(sender);
          if (!contentOriginFromSender(sender) || senderTabId === null || senderFrameId === null) {
            return untrustedSender();
          }
          return {
            ok: true,
            data: await readContentSettings(senderTabId, senderFrameId, sender.documentId),
          };
        }
        case UI_ATTACH_OVERLAY_VISIBILITY_GET: {
          const senderTabId = contentTabIdFromSender(sender);
          if (!contentOriginFromSender(sender) || senderTabId === null) {
            return untrustedSender();
          }
          return {
            ok: true,
            data: {
              visible: await shouldShowOverlaysInWindow(sender.tab?.windowId),
            },
          };
        }
        case "ui-attach:content-selection-disable": {
          const senderTabId = contentTabIdFromSender(sender);
          const senderFrameId = contentFrameIdFromSender(sender);
          if (!contentOriginFromSender(sender) || senderTabId === null || senderFrameId === null) {
            return untrustedSender();
          }
          if (
            senderTabId !== elementSelectionTabId ||
            senderFrameId !== elementSelectionFrameId ||
            !selectionDocumentMatches(sender.documentId)
          ) return selectionNotActive();
          await revokeElementSelectionLease();
          return { ok: true, data: null };
        }
        case "ui-attach:element-selection-get": {
          if (!isExtensionPageSender(sender)) return untrustedSender();
          return { ok: true, data: { enabled: elementSelectionTabId !== null } };
        }
        case "ui-attach:element-selection-set": {
          if (!isExtensionPageSender(sender)) return untrustedSender();
          if (command.value.enabled) {
            const resumable = await getResumableElementSelectionScope(command.value.tabId);
            if (resumable) {
              return await setElementSelectionLease(
                command.value,
                resumable.target,
                resumable.expectedPage,
              );
            }
          }
          return await setElementSelectionLease(command.value);
        }
        case "ui-attach:frame-scope-list": {
          if (!isExtensionPageSender(sender)) return untrustedSender();
          return await listFrameScopes();
        }
        case "ui-attach:frame-scope-select": {
          if (!isExtensionPageSender(sender)) return untrustedSender();
          return await selectFrameScope(command.value);
        }
        case "ui-attach:embedded-frame-selection-resolve": {
          if (!isExtensionPageSender(sender)) return untrustedSender();
          return await resolveEmbeddedFrameSelectionTarget(command.value);
        }
        case "ui-attach:embedded-frame-selection-activate": {
          if (!isExtensionPageSender(sender)) return untrustedSender();
          return await activateResolvedEmbeddedFrameSelection(command.value);
        }
        case "ui-attach:embedded-frame-selection-set": {
          if (!isExtensionPageSender(sender)) return untrustedSender();
          return await setEmbeddedFrameSelectionLease(command.value);
        }
        case UI_ATTACH_OVERLAYS_RESTORE_GET: {
          const senderOrigin = contentOriginFromSender(sender);
          const endpoint = overlayEndpointFromSender(sender);
          if (!senderOrigin || !endpoint || !sender.url) return untrustedSender();
          return await getOverlayRestore(senderOrigin, sender.url, endpoint);
        }
        case "ui-attach:session-begin-capture": {
          const senderOrigin = contentOriginFromSender(sender);
          if (!senderOrigin) return untrustedSender();
          if (!hasElementSelectionLease(sender)) return selectionNotActive();
          return await beginRuntimeCapture(senderOrigin);
        }
        case "ui-attach:session-commit-capture": {
          const senderOrigin = contentOriginFromSender(sender);
          if (!senderOrigin) return untrustedSender();
          if (!hasElementSelectionLease(sender)) return selectionNotActive();
          return await commitRuntimeCapture(command.value, senderOrigin, sender);
        }
        case "ui-attach:overlays-sync": {
          if (!isExtensionPageSender(sender)) return untrustedSender();
          return await syncStoredOverlaySession(
            command.value.origin,
            command.value.activeItemId,
          );
        }
        case UI_ATTACH_OVERLAY_PREVIEW: {
          if (!isExtensionPageSender(sender)) return untrustedSender();
          return await previewStoredOverlayTarget(
            command.value.origin,
            command.value.itemId,
          );
        }
        case UI_ATTACH_OVERLAY_RELATION_PREVIEW: {
          if (!isExtensionPageSender(sender)) return untrustedSender();
          return await previewStoredOverlayRelation(
            command.value.origin,
            command.value.sourceItemId,
            command.value.referenceItemId,
          );
        }
        case "ui-attach:session-update-intent":
          if (!isExtensionPageSender(sender)) return untrustedSender();
          return storeResult(await store.updateIntent(
            command.value.origin,
            command.value.epoch,
            command.value.itemId,
            command.value.intent,
          ));
        case "ui-attach:session-remove-item": {
          if (!isExtensionPageSender(sender)) return untrustedSender();
          const previous = await store.read(command.value.origin);
          const removed = await store.removeItem(
            command.value.origin,
            command.value.epoch,
            command.value.itemId,
          );
          if (removed.ok) {
            await syncOverlaySession(removed.value, null, previous.ok ? previous.value : null);
          }
          return storeResult(removed);
        }
        case "ui-attach:session-clear": {
          if (!isExtensionPageSender(sender)) return untrustedSender();
          return await clearActivePageSessions(command.value);
        }
      }
    } catch {
      return failure("CAPTURE_FAILED", SAFE_CAPTURE_ERROR);
    }
  }

  async function handleTabActivated(activeInfo: { tabId: number; windowId: number }): Promise<void> {
    if (
      (elementSelectionWindowId === activeInfo.windowId &&
        elementSelectionTabId !== null &&
        elementSelectionTabId !== activeInfo.tabId) ||
      (elementSelectionPendingWindowId === activeInfo.windowId &&
        elementSelectionPendingTabId !== null &&
        elementSelectionPendingTabId !== activeInfo.tabId)
    ) {
      await revokeElementSelectionLease();
    }
    await clearOverlayPreviewLeases();
    await publishActiveOriginChanged();
  }

  async function handleTabUpdated(
    tabId: number,
    changeInfo: { status?: string; url?: string },
    _tab: UiAttachChromeTab,
  ): Promise<void> {
    await ensureResumableElementSelectionScopesLoaded();
    let activeOriginPublished = false;
    const activeLeaseOnTab = elementSelectionTabId === tabId;
    const pendingLeaseOnTab = elementSelectionPendingTabId === tabId;
    const resumableScope = resumableElementSelectionScopes.get(tabId) ?? null;
    const activeRouteChanged = changeInfo.url !== undefined && activeLeaseOnTab && (
      elementSelectionTopOrigin === null ||
      elementSelectionTopPathname === null ||
      routeChanged(changeInfo.url, elementSelectionTopOrigin, elementSelectionTopPathname)
    );
    const pendingRouteChanged = changeInfo.url !== undefined && pendingLeaseOnTab && (
      elementSelectionPendingTopOrigin === null ||
      elementSelectionPendingTopPathname === null ||
      routeChanged(
        changeInfo.url,
        elementSelectionPendingTopOrigin,
        elementSelectionPendingTopPathname,
      )
    );
    if (changeInfo.status === "loading" || changeInfo.url) {
      if (
        resumableScope &&
        (changeInfo.status === "loading" || (
          changeInfo.url !== undefined && routeChanged(
            changeInfo.url,
            resumableScope.expectedPage.origin,
            resumableScope.expectedPage.pathname,
          )
        ))
      ) {
        await forgetResumableElementSelectionScope(tabId);
      }
      if (
        (changeInfo.status === "loading" && (activeLeaseOnTab || pendingLeaseOnTab)) ||
        activeRouteChanged ||
        pendingRouteChanged
      ) {
        await revokeElementSelectionLease();
      }
      await clearOverlayPreviewLeases(tabId);
      await publishActiveOriginChanged();
      activeOriginPublished = true;
    }
    if (changeInfo.status === "complete") {
      await ensureContentScript(tabId, 0);
      if (!activeOriginPublished) await publishActiveOriginChanged();
    }
  }

  async function handleNavigationCommitted(
    details: UiAttachChromeNavigationCommittedDetails,
  ): Promise<void> {
    await ensureResumableElementSelectionScopesLoaded();
    const resumableScope = resumableElementSelectionScopes.get(details.tabId) ?? null;
    const activeLeaseChanged = details.tabId === elementSelectionTabId && (
      (details.frameId === 0 && routeChanged(
        details.url,
        elementSelectionTopOrigin,
        elementSelectionTopPathname,
      )) ||
      (details.frameId === elementSelectionFrameId && (
        documentChanged(details.documentId, elementSelectionDocumentId) ||
        routeChanged(details.url, elementSelectionFrameOrigin, elementSelectionFramePathname)
      )) ||
      (details.frameId === elementSelectionParentFrameId && (
        documentChanged(details.documentId, elementSelectionParentDocumentId) ||
        routeChanged(
          details.url,
          elementSelectionParentFrameOrigin,
          elementSelectionParentFramePathname,
        )
      ))
    );
    const pendingLeaseChanged = details.tabId === elementSelectionPendingTabId && (
      (details.frameId === 0 && routeChanged(
        details.url,
        elementSelectionPendingTopOrigin,
        elementSelectionPendingTopPathname,
      )) ||
      (details.frameId === elementSelectionPendingFrameId && (
        documentChanged(details.documentId, elementSelectionPendingDocumentId) ||
        routeChanged(
          details.url,
          elementSelectionPendingFrameOrigin,
          elementSelectionPendingFramePathname,
        )
      )) ||
      (details.frameId === elementSelectionPendingParentFrameId && (
        documentChanged(details.documentId, elementSelectionPendingParentDocumentId) ||
        routeChanged(
          details.url,
          elementSelectionPendingParentFrameOrigin,
          elementSelectionPendingParentFramePathname,
        )
      ))
    );
    const resumableScopeChanged = resumableScope !== null && (
      (details.frameId === 0 && routeChanged(
        details.url,
        resumableScope.expectedPage.origin,
        resumableScope.expectedPage.pathname,
      )) ||
      (details.frameId === resumableScope.target.frameId && (
        documentChanged(details.documentId, resumableScope.target.documentId ?? null) ||
        routeChanged(
          details.url,
          resumableScope.target.frameOrigin ?? null,
          resumableScope.target.framePathname ?? null,
        )
      )) ||
      (details.frameId === resumableScope.target.parentFrameId && (
        documentChanged(
          details.documentId,
          resumableScope.target.parentDocumentId ?? null,
        ) ||
        routeChanged(
          details.url,
          resumableScope.target.parentFrameOrigin ?? null,
          resumableScope.target.parentFramePathname ?? null,
        )
      ))
    );
    if (resumableScopeChanged) await forgetResumableElementSelectionScope(details.tabId);
    if (activeLeaseChanged || pendingLeaseChanged) {
      await revokeElementSelectionLease();
    }
  }

  function register(): void {
    chrome.contextMenus.onClicked.addListener((info, tab) => {
      void handleContextMenuClick(info, tab);
    });
    chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
      void handleRuntimeMessage(message, sender).then(sendResponse);
      return true;
    });
    chrome.runtime.onConnect.addListener((port) => {
      if (
        port.name === UI_ATTACH_SELECTION_LIFECYCLE_PORT &&
        port.sender &&
        contentOriginFromSender(port.sender)
      ) return;
      const panelWindowId = panelLifecycleWindowId(port.name);
      if (
        panelWindowId !== null &&
        port.sender &&
        isExtensionPageSender(port.sender)
      ) {
        retainPanelVisibilityLease(panelWindowId, port);
        return;
      }
      port.disconnect();
    });
    chrome.tabs.onActivated.addListener((activeInfo) => {
      void handleTabActivated(activeInfo);
    });
    chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
      void handleTabUpdated(tabId, changeInfo, tab);
    });
    chrome.webNavigation.onCommitted.addListener((details) => {
      void handleNavigationCommitted(details);
    });
    chrome.webNavigation.onHistoryStateUpdated.addListener((details) => {
      void handleNavigationCommitted(details);
    });
    chrome.storage.onChanged.addListener((changes, areaName) => {
      if (
        areaName === "local" &&
        DISCLOSURE_MODE_KEY in changes
      ) {
        requestContentSettingsBroadcast();
      }
      if (
        areaName === "local" &&
        OVERLAY_VISIBILITY_PREFERENCE_KEY in changes
      ) {
        requestOverlayVisibilityBroadcast();
      }
    });
    void deliverContentSettings(currentDisclosureMode, null);
    void deliverOverlayVisibility("panel").then(async () => {
      if (await storageAccessReady) requestOverlayVisibilityBroadcast();
    }).catch(() => undefined);
  }

  function retainPanelVisibilityLease(
    windowId: number,
    port: UiAttachChromePort,
  ): void {
    panelVisibilityLeaseCountsByWindow.set(
      windowId,
      (panelVisibilityLeaseCountsByWindow.get(windowId) ?? 0) + 1,
    );
    let released = false;
    port.onDisconnect.addListener(() => {
      if (released) return;
      released = true;
      const remaining = (panelVisibilityLeaseCountsByWindow.get(windowId) ?? 1) - 1;
      if (remaining > 0) panelVisibilityLeaseCountsByWindow.set(windowId, remaining);
      else panelVisibilityLeaseCountsByWindow.delete(windowId);
      requestOverlayVisibilityBroadcast();
    });
    requestOverlayVisibilityBroadcast();
  }

  async function listFrameScopes(): Promise<SessionCommandResponse<FrameScopeListData>> {
    let topPage = await getActivePageContext();
    if (!topPage && elementSelectionTabId === null) {
      const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
      const tabId = tabs[0]?.id;
      if (typeof tabId === "number" && Number.isInteger(tabId) && tabId >= 0) {
        const resumable = await getResumableElementSelectionScope(tabId);
        if (resumable) {
          topPage = {
            tabId,
            frameId: 0,
            origin: resumable.expectedPage.origin,
            pathname: resumable.expectedPage.pathname,
          };
        }
      }
    }
    if (!topPage) {
      return failure(
        "ACTIVE_PAGE_UNAVAILABLE",
        "Capture scopes are available only on an active HTTP(S) page.",
      );
    }
    const scopes = await readLiveFrameScopes(topPage);
    if (!scopes) {
      return failure("FRAME_SCOPE_UNAVAILABLE", "MeanThis could not read the live frame tree.");
    }
    const resumable = elementSelectionTabId === null
      ? await getResumableElementSelectionScope(topPage.tabId)
      : null;
    const requestedCurrentFrameId = elementSelectionTabId === topPage.tabId
      ? elementSelectionFrameId ?? 0
      : resumable?.target.frameId ?? 0;
    const currentFrameId = scopes.some((scope) => (
      scope.frameId === requestedCurrentFrameId && scope.selectable
    ))
      ? requestedCurrentFrameId
      : 0;
    return {
      ok: true,
      data: {
        tabId: topPage.tabId,
        currentFrameId,
        scopes,
      },
    };
  }

  async function selectFrameScope(
    command: Extract<SessionCommand, { type: "ui-attach:frame-scope-select" }>,
    options?: { allowFrameDerivedTopPage?: boolean },
  ): Promise<SessionCommandResponse<{ enabled: boolean }>> {
    const activeTab = await getActiveTabForTab(command.tabId);
    if (!activeTab) {
      return failure("FRAME_UNAVAILABLE", "The selected frame scope is no longer available.");
    }
    let frames: UiAttachChromeFrame[] | undefined;
    try {
      frames = await chrome.webNavigation.getAllFrames({ tabId: command.tabId });
    } catch {
      frames = undefined;
    }
    if (!frames) {
      return failure("FRAME_SCOPE_UNAVAILABLE", "MeanThis could not read the live frame tree.");
    }
    const topPage = activePageContextFromTab(activeTab) ?? (
      options?.allowFrameDerivedTopPage
        ? activePageContextFromFrameInventory(command.tabId, frames)
        : null
    );
    if (!topPage) {
      return failure("FRAME_UNAVAILABLE", "The selected frame scope is no longer available.");
    }
    const frame = frames.find((candidate) => candidate.frameId === command.frameId);
    const liveOrigin = originFromUrl(frame?.url);
    const livePathname = pathnameFromUrl(frame?.url);
    if (
      !frame ||
      liveOrigin !== command.origin ||
      livePathname !== command.pathname ||
      (command.frameId > 0 && (
        !command.documentId ||
        frame.documentId !== command.documentId
      )) ||
      (command.documentId !== null && frame.documentId !== command.documentId)
    ) {
      return failure("FRAME_UNAVAILABLE", "The selected frame scope is no longer available.");
    }
    if (command.frameId === 0) {
      if (topPage.origin !== command.origin || topPage.pathname !== command.pathname) {
        return failure("FRAME_UNAVAILABLE", "The selected frame scope is no longer available.");
      }
      const target: ElementSelectionTarget = {
        frameId: 0,
        ...(frame.documentId ? { documentId: frame.documentId } : {}),
      };
      if (command.startSelection) {
        return setElementSelectionLease(
          { type: "ui-attach:element-selection-set", enabled: true, tabId: command.tabId },
          target,
          { origin: topPage.origin, pathname: topPage.pathname },
        );
      }
      await forgetResumableElementSelectionScope(command.tabId);
      return { ok: true, data: { enabled: false } };
    }

    if (frame.parentFrameId < 0) {
      return failure("FRAME_UNAVAILABLE", "The selected frame scope is no longer available.");
    }
    const target: ElementSelectionTarget = {
      frameId: frame.frameId,
      frameOrigin: command.origin,
      framePathname: command.pathname,
      documentId: command.documentId ?? undefined,
      parentFrameId: frame.parentFrameId,
    };
    if (frame.parentFrameId > 0) {
      const parent = frames.find((candidate) => candidate.frameId === frame.parentFrameId);
      const parentOrigin = originFromUrl(parent?.url);
      const parentPathname = pathnameFromUrl(parent?.url);
      if (!parent?.documentId || !parentOrigin || parentPathname === null) {
        return failure("FRAME_UNAVAILABLE", "The selected frame scope is no longer available.");
      }
      target.parentDocumentId = parent.documentId;
      target.parentFrameOrigin = parentOrigin;
      target.parentFramePathname = parentPathname;
    }
    const expectedPage = { origin: topPage.origin, pathname: topPage.pathname };
    if (command.startSelection) {
      return setElementSelectionLease(
        { type: "ui-attach:element-selection-set", enabled: true, tabId: command.tabId },
        target,
        expectedPage,
      );
    }
    if (typeof activeTab.windowId !== "number" || !Number.isInteger(activeTab.windowId)) {
      return failure("FRAME_UNAVAILABLE", "The selected frame scope is no longer available.");
    }
    await rememberResumableElementSelectionScope({
      tabId: command.tabId,
      windowId: activeTab.windowId,
      target,
      expectedPage,
    });
    return { ok: true, data: { enabled: false } };
  }

  async function readLiveFrameScopes(
    topPage: ActivePageContext,
  ): Promise<FrameScopeDescriptor[] | null> {
    let frames: UiAttachChromeFrame[] | undefined;
    try {
      frames = await chrome.webNavigation.getAllFrames({ tabId: topPage.tabId });
    } catch {
      frames = undefined;
    }
    if (!frames) return null;

    const normalized = new Map<number, {
      frameId: number;
      parentFrameId: number;
      documentId: string | null;
      origin: string;
      pathname: string;
    }>();
    for (const frame of frames) {
      const origin = originFromUrl(frame.url);
      const pathname = pathnameFromUrl(frame.url);
      if (!origin || pathname === null || normalized.has(frame.frameId)) continue;
      normalized.set(frame.frameId, {
        frameId: frame.frameId,
        parentFrameId: frame.parentFrameId,
        documentId: typeof frame.documentId === "string" && frame.documentId.length > 0
          ? frame.documentId
          : null,
        origin,
        pathname,
      });
    }
    const root = normalized.get(0);
    if (!root || root.origin !== topPage.origin || root.pathname !== topPage.pathname) {
      normalized.set(0, {
        frameId: 0,
        parentFrameId: -1,
        documentId: topPage.documentId ?? null,
        origin: topPage.origin,
        pathname: topPage.pathname,
      });
    }

    const childrenByParent = new Map<number, number[]>();
    for (const frame of normalized.values()) {
      if (frame.frameId === 0) continue;
      const children = childrenByParent.get(frame.parentFrameId) ?? [];
      children.push(frame.frameId);
      childrenByParent.set(frame.parentFrameId, children);
    }
    for (const children of childrenByParent.values()) children.sort((left, right) => left - right);

    const result: FrameScopeDescriptor[] = [];
    const visited = new Set<number>();
    const visit = (frameId: number, depth: number): void => {
      if (visited.has(frameId) || depth > 32) return;
      const frame = normalized.get(frameId);
      if (!frame) return;
      visited.add(frameId);
      result.push({
        frameId,
        parentFrameId: frameId === 0 ? null : frame.parentFrameId,
        documentId: frame.documentId,
        origin: frame.origin,
        pathname: frame.pathname,
        depth,
        requiresHostPermission: frame.origin !== topPage.origin,
        selectable: frameId === 0 || frame.documentId !== null,
      });
      for (const childId of childrenByParent.get(frameId) ?? []) visit(childId, depth + 1);
    };
    visit(0, 0);
    return result;
  }

  async function setEmbeddedFrameSelectionLease(
    command: Extract<SessionCommand, { type: "ui-attach:embedded-frame-selection-set" }>,
  ): Promise<SessionCommandResponse<{ enabled: boolean }>> {
    const activeTab = await getActiveTabForTab(command.tabId);
    const page = activePageContextFromTab(activeTab ?? undefined);
    if (
      !activeTab ||
      !page
    ) {
      return failure("FRAME_UNAVAILABLE", "The selected embedded frame is no longer available.");
    }

    let frames;
    try {
      frames = await chrome.webNavigation.getAllFrames({ tabId: command.tabId });
    } catch {
      frames = undefined;
    }
    const parent = command.parentFrameId === 0
      ? (page.origin === command.pageOrigin && page.pathname === command.pagePathname
        ? (frames ?? []).find((frame) => frame.frameId === 0)
        : undefined)
      : (frames ?? []).find((frame) => (
        frame.frameId === command.parentFrameId &&
        originFromUrl(frame.url) === command.pageOrigin &&
        pathnameFromUrl(frame.url) === command.pagePathname &&
        typeof frame.documentId === "string" &&
        frame.documentId.length > 0 &&
        elementSelectionTabId === command.tabId &&
        elementSelectionFrameId === command.parentFrameId &&
        elementSelectionDocumentId === frame.documentId &&
        elementSelectionFrameOrigin === command.pageOrigin &&
        elementSelectionFramePathname === command.pagePathname
      ));
    if (command.parentFrameId === 0) {
      if (page.origin !== command.pageOrigin || page.pathname !== command.pagePathname) {
        return failure("FRAME_UNAVAILABLE", "The selected embedded frame is no longer available.");
      }
    } else if (!parent) {
      return failure("FRAME_UNAVAILABLE", "The selected embedded frame is no longer available.");
    }
    const matches = (frames ?? []).filter((frame) => (
      frame.frameId > 0 &&
      frame.parentFrameId === command.parentFrameId &&
      originFromUrl(frame.url) === command.frameOrigin &&
      pathnameFromUrl(frame.url) === command.framePathname
    ));
    if (matches.length > 1) {
      return failure("FRAME_AMBIGUOUS", "More than one matching embedded frame is open.");
    }
    const frame = matches[0];
    if (
      !frame ||
      typeof frame.documentId !== "string" ||
      frame.documentId.length === 0
    ) {
      return failure("FRAME_UNAVAILABLE", "The selected embedded frame is no longer available.");
    }
    return setElementSelectionLease(
      { type: "ui-attach:element-selection-set", enabled: true, tabId: command.tabId },
      {
        frameId: frame.frameId,
        frameOrigin: command.frameOrigin,
        framePathname: command.framePathname,
        documentId: frame.documentId,
        parentFrameId: command.parentFrameId,
        ...(parent?.documentId ? { parentDocumentId: parent.documentId } : {}),
        parentFrameOrigin: command.pageOrigin,
        parentFramePathname: command.pagePathname,
      },
      { origin: page.origin, pathname: page.pathname },
    );
  }

  async function resolveEmbeddedFrameSelectionTarget(
    command: Extract<SessionCommand, { type: "ui-attach:embedded-frame-selection-resolve" }>,
  ): Promise<SessionCommandResponse<{
    tabId: number;
    pageOrigin: string;
    pagePathname: string;
    parentFrameId: number;
    frameOrigin: string;
    framePathname: string;
    requiresHostPermission: boolean;
  }>> {
    const resolved = await resolveEmbeddedFrameSelectionIdentity(command);
    return resolved.ok ? { ok: true, data: resolved.data.target } : resolved;
  }

  async function resolveEmbeddedFrameSelectionIdentity(
    command: Extract<SessionCommand, { type: "ui-attach:embedded-frame-selection-resolve" }>,
  ): Promise<SessionCommandResponse<ResolvedEmbeddedFrameSelection>> {
    const activeTab = await getActiveTabForTab(command.tabId);
    const page = activePageContextFromTab(activeTab ?? undefined);
    if (!activeTab || !page) {
      return failure("FRAME_UNAVAILABLE", "The selected embedded frame is no longer available.");
    }

    let frames;
    try {
      frames = await chrome.webNavigation.getAllFrames({ tabId: command.tabId });
    } catch {
      frames = undefined;
    }
    const parent = command.parentFrameId === 0
      ? (page.origin === command.pageOrigin && page.pathname === command.pagePathname
        ? (frames ?? []).find((frame) => frame.frameId === 0)
        : undefined)
      : (frames ?? []).find((frame) => (
        frame.frameId === command.parentFrameId &&
        originFromUrl(frame.url) === command.pageOrigin &&
        pathnameFromUrl(frame.url) === command.pagePathname &&
        typeof frame.documentId === "string" &&
        frame.documentId.length > 0 &&
        elementSelectionTabId === command.tabId &&
        elementSelectionFrameId === command.parentFrameId &&
        elementSelectionDocumentId === frame.documentId &&
        elementSelectionFrameOrigin === command.pageOrigin &&
        elementSelectionFramePathname === command.pagePathname
      ));
    if (
      (command.parentFrameId === 0 && (
        page.origin !== command.pageOrigin || page.pathname !== command.pagePathname
      )) ||
      (command.parentFrameId > 0 && !parent)
    ) {
      return failure("FRAME_UNAVAILABLE", "The selected embedded frame is no longer available.");
    }

    const record = await readEmbeddedFrameSelectionRecord(command);
    if (!record) {
      return failure("FRAME_UNAVAILABLE", "The selected embedded frame is no longer available.");
    }
    const locators = collectOverlayReplayLocators(record.attachment.locatorBundle);
    if (locators.length === 0) {
      return failure("FRAME_UNAVAILABLE", "The selected embedded frame is no longer available.");
    }
    const children = (frames ?? []).filter((frame) => (
      frame.frameId > 0 && frame.parentFrameId === command.parentFrameId
    ));
    const exactMatches = children.filter((frame) => (
      originFromUrl(frame.url) === command.frameOrigin &&
      pathnameFromUrl(frame.url) === command.framePathname
    ));
    if (exactMatches.length > 1) {
      return failure("FRAME_AMBIGUOUS", "More than one matching embedded frame is open.");
    }
    if (exactMatches.length === 1) {
      return revalidateResolvedEmbeddedFrameIdentity(
        resolvedEmbeddedFrameIdentity(command, exactMatches[0], parent, page),
      );
    }

    let inspection: unknown;
    try {
      inspection = await chrome.tabs.sendMessage(command.tabId, {
        type: UI_ATTACH_EMBEDDED_FRAME_HOST_INSPECT,
        locators,
      }, {
        frameId: command.parentFrameId,
        ...(parent?.documentId ? { documentId: parent.documentId } : {}),
      });
    } catch {
      inspection = undefined;
    }
    if (
      !isEmbeddedFrameHostInspectResponse(inspection) ||
      inspection.data.frameHostCount !== 1 ||
      inspection.data.frameOrigin === null ||
      inspection.data.framePathname === null ||
      children.length !== 1
    ) {
      return failure("FRAME_UNAVAILABLE", "The selected embedded frame is no longer available.");
    }
    return revalidateResolvedEmbeddedFrameIdentity(
      resolvedEmbeddedFrameIdentity(command, children[0], parent, page),
    );
  }

  async function revalidateResolvedEmbeddedFrameIdentity(
    resolved: SessionCommandResponse<ResolvedEmbeddedFrameSelection>,
  ): Promise<SessionCommandResponse<ResolvedEmbeddedFrameSelection>> {
    if (!resolved.ok) return resolved;
    const activeTab = await getActiveTabForTab(resolved.data.target.tabId);
    const topPage = activePageContextFromTab(activeTab ?? undefined);
    if (
      !activeTab ||
      !topPage ||
      topPage.origin !== resolved.data.expectedPage.origin ||
      topPage.pathname !== resolved.data.expectedPage.pathname
    ) {
      return failure("FRAME_UNAVAILABLE", "The selected embedded frame is no longer available.");
    }

    let frames;
    try {
      frames = await chrome.webNavigation.getAllFrames({ tabId: resolved.data.target.tabId });
    } catch {
      frames = undefined;
    }
    const freshTop = (frames ?? []).find((frame) => frame.frameId === 0);
    if (
      !freshTop ||
      originFromUrl(freshTop.url) !== resolved.data.expectedPage.origin ||
      pathnameFromUrl(freshTop.url) !== resolved.data.expectedPage.pathname
    ) {
      return failure("FRAME_UNAVAILABLE", "The selected embedded frame is no longer available.");
    }
    const target = resolved.data.selectionTarget;
    const parent = (frames ?? []).find((frame) => frame.frameId === target.parentFrameId);
    if (
      target.parentFrameId !== undefined &&
      target.parentFrameId > 0 &&
      (
        !parent ||
        parent.documentId !== target.parentDocumentId ||
        originFromUrl(parent.url) !== target.parentFrameOrigin ||
        pathnameFromUrl(parent.url) !== target.parentFramePathname
      )
    ) {
      return failure("FRAME_UNAVAILABLE", "The selected embedded frame is no longer available.");
    }
    if (
      target.parentFrameId === 0 &&
      target.parentDocumentId &&
      parent?.documentId !== target.parentDocumentId
    ) {
      return failure("FRAME_UNAVAILABLE", "The selected embedded frame is no longer available.");
    }
    const frame = (frames ?? []).find((candidate) => candidate.frameId === target.frameId);
    if (
      !frame ||
      frame.parentFrameId !== target.parentFrameId ||
      frame.documentId !== target.documentId ||
      originFromUrl(frame.url) !== target.frameOrigin ||
      pathnameFromUrl(frame.url) !== target.framePathname
    ) {
      return failure("FRAME_UNAVAILABLE", "The selected embedded frame is no longer available.");
    }
    return resolved;
  }

  async function activateResolvedEmbeddedFrameSelection(
    command: Extract<SessionCommand, { type: "ui-attach:embedded-frame-selection-activate" }>,
  ): Promise<SessionCommandResponse<{ enabled: boolean }>> {
    const resolved = await resolveEmbeddedFrameSelectionIdentity({
      type: "ui-attach:embedded-frame-selection-resolve",
      itemId: command.itemId,
      tabId: command.tabId,
      pageOrigin: command.pageOrigin,
      pagePathname: command.pagePathname,
      parentFrameId: command.parentFrameId,
      frameOrigin: command.sourceFrameOrigin,
      framePathname: command.sourceFramePathname,
    });
    if (!resolved.ok) return resolved;
    if (
      resolved.data.target.frameOrigin !== command.frameOrigin ||
      resolved.data.target.framePathname !== command.framePathname
    ) {
      return failure("FRAME_UNAVAILABLE", "The selected embedded frame is no longer available.");
    }
    return setElementSelectionLease(
      { type: "ui-attach:element-selection-set", enabled: true, tabId: command.tabId },
      resolved.data.selectionTarget,
      resolved.data.expectedPage,
    );
  }

  async function readEmbeddedFrameSelectionRecord(
    command: Extract<SessionCommand, { type: "ui-attach:embedded-frame-selection-resolve" }>,
  ): Promise<OriginCaptureRecord | null> {
    const read = await store.read(command.pageOrigin);
    if (!read.ok) return null;
    const stored = read.value.file?.session.attachments.find(
      (item) => item.id === command.itemId,
    )?.sourceRecord ?? (
      read.value.legacyRecord?.attachment.id === command.itemId
        ? read.value.legacyRecord
        : null
    );
    if (!stored) return null;
    const record = stored as OriginCaptureRecord;
    const boundary = record.attachment.boundary;
    const pageRoute = routeKeyFromUrl(record.pageUrl ?? undefined);
    return record.origin === command.pageOrigin &&
      record.tabId === command.tabId &&
      (record.frameId ?? 0) === command.parentFrameId &&
      pageRoute === `${command.pageOrigin}${command.pagePathname}` &&
      record.attachment.element.tagName.toLowerCase() === "iframe" &&
      boundary?.kind === "embedded_frame" &&
      boundary.originRelation === (
        command.frameOrigin === command.pageOrigin ? "same_origin" : "cross_origin"
      ) &&
      boundary.frameOrigin === command.frameOrigin &&
      boundary.framePathname === command.framePathname
      ? record
      : null;
  }

  async function embeddedFrameStillMatches(
    tabId: number,
    target: ElementSelectionTarget,
  ): Promise<boolean> {
    if (!target.frameOrigin || !target.framePathname || !target.documentId) return false;
    try {
      if (
        target.parentFrameId !== undefined &&
        target.parentFrameId > 0
      ) {
        if (
          !target.parentDocumentId ||
          !target.parentFrameOrigin ||
          !target.parentFramePathname
        ) return false;
        const parent = await chrome.webNavigation.getFrame({
          tabId,
          frameId: target.parentFrameId,
        });
        if (
          !parent ||
          parent.documentId !== target.parentDocumentId ||
          originFromUrl(parent.url) !== target.parentFrameOrigin ||
          pathnameFromUrl(parent.url) !== target.parentFramePathname
        ) return false;
      }
      const frame = await chrome.webNavigation.getFrame({ tabId, frameId: target.frameId });
      return frame !== undefined &&
        frame.parentFrameId === (target.parentFrameId ?? 0) &&
        originFromUrl(frame.url) === target.frameOrigin &&
        pathnameFromUrl(frame.url) === target.framePathname &&
        frame.documentId === target.documentId;
    } catch {
      return false;
    }
  }

  function pendingSelectionMatches(
    revision: number,
    activePage: ElementSelectionPageContext,
    target: ElementSelectionTarget,
    expectedPage?: { origin: string; pathname: string },
    expectedContextMenuRevision?: number,
  ): boolean {
    return (
      expectedContextMenuRevision === undefined ||
      expectedContextMenuRevision === contextMenuInvocationRevision
    ) && revision === elementSelectionRevision &&
      elementSelectionPendingTabId === activePage.tabId &&
      elementSelectionPendingFrameId === target.frameId &&
      elementSelectionPendingDocumentId === (target.documentId ?? null) &&
      elementSelectionPendingFrameOrigin === (target.frameOrigin ?? null) &&
      elementSelectionPendingFramePathname === (target.framePathname ?? null) &&
      elementSelectionPendingParentFrameId === (target.parentFrameId ?? null) &&
      elementSelectionPendingParentDocumentId === (target.parentDocumentId ?? null) &&
      elementSelectionPendingParentFrameOrigin === (target.parentFrameOrigin ?? null) &&
      elementSelectionPendingParentFramePathname === (target.parentFramePathname ?? null) &&
      elementSelectionPendingTopOrigin === (expectedPage?.origin ?? null) &&
      elementSelectionPendingTopPathname === (expectedPage?.pathname ?? null) &&
      elementSelectionPendingWindowId === activePage.windowId;
  }

  function activeSelectionMatches(
    revision: number,
    activePage: ElementSelectionPageContext,
    target: ElementSelectionTarget,
    expectedPage?: { origin: string; pathname: string },
    expectedContextMenuRevision?: number,
  ): boolean {
    return (
      expectedContextMenuRevision === undefined ||
      expectedContextMenuRevision === contextMenuInvocationRevision
    ) && revision === elementSelectionRevision &&
      elementSelectionTabId === activePage.tabId &&
      elementSelectionFrameId === target.frameId &&
      elementSelectionDocumentId === (target.documentId ?? null) &&
      elementSelectionFrameOrigin === (target.frameOrigin ?? null) &&
      elementSelectionFramePathname === (target.framePathname ?? null) &&
      elementSelectionParentFrameId === (target.parentFrameId ?? null) &&
      elementSelectionParentDocumentId === (target.parentDocumentId ?? null) &&
      elementSelectionParentFrameOrigin === (target.parentFrameOrigin ?? null) &&
      elementSelectionParentFramePathname === (target.parentFramePathname ?? null) &&
      elementSelectionTopOrigin === (expectedPage?.origin ?? null) &&
      elementSelectionTopPathname === (expectedPage?.pathname ?? null) &&
      elementSelectionWindowId === activePage.windowId;
  }

  function contextSelectionLeaseMatches(
    tabId: number,
    target: ElementSelectionTarget,
    expectedPage: { origin: string; pathname: string },
  ): boolean {
    return elementSelectionTabId === tabId &&
      elementSelectionFrameId === target.frameId &&
      elementSelectionDocumentId === (target.documentId ?? null) &&
      elementSelectionFrameOrigin === (target.frameOrigin ?? null) &&
      elementSelectionFramePathname === (target.framePathname ?? null) &&
      elementSelectionParentFrameId === (target.parentFrameId ?? null) &&
      elementSelectionParentDocumentId === (target.parentDocumentId ?? null) &&
      elementSelectionParentFrameOrigin === (target.parentFrameOrigin ?? null) &&
      elementSelectionParentFramePathname === (target.parentFramePathname ?? null) &&
      elementSelectionTopOrigin === expectedPage.origin &&
      elementSelectionTopPathname === expectedPage.pathname;
  }

  function clearPendingElementSelectionLease(): void {
    elementSelectionPendingTabId = null;
    elementSelectionPendingFrameId = null;
    elementSelectionPendingDocumentId = null;
    elementSelectionPendingFrameOrigin = null;
    elementSelectionPendingFramePathname = null;
    elementSelectionPendingParentFrameId = null;
    elementSelectionPendingParentDocumentId = null;
    elementSelectionPendingParentFrameOrigin = null;
    elementSelectionPendingParentFramePathname = null;
    elementSelectionPendingTopOrigin = null;
    elementSelectionPendingTopPathname = null;
    elementSelectionPendingWindowId = null;
  }

  function selectionIntentStillCurrent(
    expectedRevision?: number,
    expectedContextMenuRevision?: number,
  ): boolean {
    return (
      expectedRevision === undefined || expectedRevision === elementSelectionRevision
    ) && (
      expectedContextMenuRevision === undefined ||
      expectedContextMenuRevision === contextMenuInvocationRevision
    );
  }

  async function setElementSelectionLease(
    command: Extract<SessionCommand, { type: "ui-attach:element-selection-set" }>,
    target: ElementSelectionTarget = { frameId: 0 },
    expectedPage?: { origin: string; pathname: string },
    mode: ContextMenuSelectionMode = "continuous",
    expectedRevision?: number,
    expectedContextMenuRevision?: number,
  ): Promise<SessionCommandResponse<{ enabled: boolean }>> {
    if (!command.enabled) {
      await revokeElementSelectionLease();
      return { ok: true, data: { enabled: false } };
    }
    const disclosureAcknowledged = await isFirstCaptureDisclosureAcknowledged();
    if (!selectionIntentStillCurrent(expectedRevision, expectedContextMenuRevision)) {
      return { ok: true, data: { enabled: false } };
    }
    if (!disclosureAcknowledged) {
      return failure("DISCLOSURE_REQUIRED", FIRST_CAPTURE_DISCLOSURE_REQUIRED_ERROR);
    }

    const activeTab = await getActiveTabForTab(command.tabId);
    if (!selectionIntentStillCurrent(expectedRevision, expectedContextMenuRevision)) {
      return { ok: true, data: { enabled: false } };
    }
    if (!activeTab) {
      return failure(
        "ACTIVE_PAGE_UNAVAILABLE",
        "Element selection is available only on an active HTTP(S) page.",
      );
    }
    const page = activePageContextFromTab(activeTab);
    if (!page) {
      if (typeof activeTab.url !== "string" || activeTab.url.length === 0) {
        return failure(
          "ACCESS_DENIED",
          "MeanThis requires a user-invoked active-tab grant before selection.",
        );
      }
      return failure(
        "ACTIVE_PAGE_UNAVAILABLE",
        "Element selection is available only on an active HTTP(S) page.",
      );
    }
    const activePage = { ...page, windowId: activeTab.windowId };
    if (
      expectedPage &&
      (activePage.origin !== expectedPage.origin || activePage.pathname !== expectedPage.pathname)
    ) {
      return failure("FRAME_UNAVAILABLE", "The selected embedded frame is no longer available.");
    }

    const revision = ++elementSelectionRevision;
    elementSelectionPendingTabId = activePage.tabId;
    elementSelectionPendingFrameId = target.frameId;
    elementSelectionPendingDocumentId = target.documentId ?? null;
    elementSelectionPendingFrameOrigin = target.frameOrigin ?? null;
    elementSelectionPendingFramePathname = target.framePathname ?? null;
    elementSelectionPendingParentFrameId = target.parentFrameId ?? null;
    elementSelectionPendingParentDocumentId = target.parentDocumentId ?? null;
    elementSelectionPendingParentFrameOrigin = target.parentFrameOrigin ?? null;
    elementSelectionPendingParentFramePathname = target.parentFramePathname ?? null;
    elementSelectionPendingTopOrigin = expectedPage?.origin ?? null;
    elementSelectionPendingTopPathname = expectedPage?.pathname ?? null;
    elementSelectionPendingWindowId = activePage.windowId;
    let contentReady = false;
    try {
      contentReady = await ensureContentScript(activePage.tabId, target.frameId);
    } catch {
      contentReady = false;
    }
    if (!pendingSelectionMatches(
      revision,
      activePage,
      target,
      expectedPage,
      expectedContextMenuRevision,
    )) {
      return { ok: true, data: { enabled: false } };
    }
    const frameStillMatches = !contentReady || target.frameId === 0 ||
      await embeddedFrameStillMatches(activePage.tabId, target);
    if (!pendingSelectionMatches(
      revision,
      activePage,
      target,
      expectedPage,
      expectedContextMenuRevision,
    )) {
      return { ok: true, data: { enabled: false } };
    }
    if (!contentReady) {
      clearPendingElementSelectionLease();
      return failure(
        "ACCESS_DENIED",
        "MeanThis requires a user-invoked active-tab grant before selection.",
      );
    }
    if (!frameStillMatches) {
      clearPendingElementSelectionLease();
      return failure("FRAME_UNAVAILABLE", "The selected embedded frame is no longer available.");
    }

    clearPendingElementSelectionLease();
    elementSelectionTabId = activePage.tabId;
    elementSelectionFrameId = target.frameId;
    elementSelectionDocumentId = target.documentId ?? null;
    elementSelectionFrameOrigin = target.frameOrigin ?? null;
    elementSelectionFramePathname = target.framePathname ?? null;
    elementSelectionParentFrameId = target.parentFrameId ?? null;
    elementSelectionParentDocumentId = target.parentDocumentId ?? null;
    elementSelectionParentFrameOrigin = target.parentFrameOrigin ?? null;
    elementSelectionParentFramePathname = target.parentFramePathname ?? null;
    elementSelectionTopOrigin = expectedPage?.origin ?? null;
    elementSelectionTopPathname = expectedPage?.pathname ?? null;
    elementSelectionWindowId = activePage.windowId;
    elementSelectionMode = mode;
    try {
      const disclosureMode = await readDisclosureModeSetting();
      if (!activeSelectionMatches(
        revision,
        activePage,
        target,
        expectedPage,
        expectedContextMenuRevision,
      )) {
        return { ok: true, data: { enabled: false } };
      }
      const deliveredTabIds = await deliverContentSettings(
        disclosureMode,
        {
          tabId: activePage.tabId,
          frameId: target.frameId,
          ...(target.documentId ? { documentId: target.documentId } : {}),
        },
      );
      if (!activeSelectionMatches(
        revision,
        activePage,
        target,
        expectedPage,
        expectedContextMenuRevision,
      )) {
        return { ok: true, data: { enabled: false } };
      }
      if (!deliveredTabIds.has(endpointKey({ tabId: activePage.tabId, frameId: target.frameId }))) {
        await revokeElementSelectionLease();
        return failure(
          "CONTENT_UNAVAILABLE",
          "Element selection is not available on the active page.",
        );
      }
      const stillActive = await getActivePageContextForTab(activePage.tabId);
      if (!activeSelectionMatches(
        revision,
        activePage,
        target,
        expectedPage,
        expectedContextMenuRevision,
      )) {
        return { ok: true, data: { enabled: false } };
      }
      if (!stillActive || stillActive.windowId !== activePage.windowId) {
        await revokeElementSelectionLease();
        return failure(
          "ACTIVE_PAGE_UNAVAILABLE",
          "Element selection is available only on an active HTTP(S) page.",
        );
      }
      if (
        expectedPage &&
        (stillActive.origin !== expectedPage.origin || stillActive.pathname !== expectedPage.pathname)
      ) {
        await revokeElementSelectionLease();
        return failure("FRAME_UNAVAILABLE", "The selected embedded frame is no longer available.");
      }
      const finalFrameStillMatches = target.frameId === 0 ||
        await embeddedFrameStillMatches(activePage.tabId, target);
      if (!activeSelectionMatches(
        revision,
        activePage,
        target,
        expectedPage,
        expectedContextMenuRevision,
      )) {
        return { ok: true, data: { enabled: false } };
      }
      if (!finalFrameStillMatches) {
        await revokeElementSelectionLease();
        return failure("FRAME_UNAVAILABLE", "The selected embedded frame is no longer available.");
      }
      await publishElementSelectionUpdated(true);
      if (!activeSelectionMatches(
        revision,
        activePage,
        target,
        expectedPage,
        expectedContextMenuRevision,
      )) {
        return { ok: true, data: { enabled: false } };
      }
      if (target.frameId > 0 && expectedPage) {
        await rememberResumableElementSelectionScope({
            tabId: activePage.tabId,
            windowId: activePage.windowId,
            target: { ...target },
            expectedPage: { ...expectedPage },
        });
      } else {
        await forgetResumableElementSelectionScope(activePage.tabId);
      }
      return { ok: true, data: { enabled: true } };
    } catch {
      if (activeSelectionMatches(
        revision,
        activePage,
        target,
        expectedPage,
        expectedContextMenuRevision,
      )) {
        await revokeElementSelectionLease();
      }
      return failure("CONTENT_UNAVAILABLE", "Element selection is not available on the active page.");
    }
  }

  async function isFirstCaptureDisclosureAcknowledged(): Promise<boolean> {
    try {
      return await firstCaptureDisclosure.isAcknowledged();
    } catch {
      return false;
    }
  }

  async function revokeElementSelectionLease(): Promise<void> {
    const hadLease = elementSelectionTabId !== null;
    elementSelectionTabId = null;
    elementSelectionFrameId = null;
    elementSelectionDocumentId = null;
    elementSelectionFrameOrigin = null;
    elementSelectionFramePathname = null;
    elementSelectionParentFrameId = null;
    elementSelectionParentDocumentId = null;
    elementSelectionParentFrameOrigin = null;
    elementSelectionParentFramePathname = null;
    elementSelectionTopOrigin = null;
    elementSelectionTopPathname = null;
    elementSelectionWindowId = null;
    elementSelectionMode = "continuous";
    clearPendingElementSelectionLease();
    elementSelectionRevision += 1;
    try {
      await deliverContentSettings(currentDisclosureMode, null);
    } catch {
      // Background authority is already fail-closed even if a tab cannot be notified.
    }
    if (hadLease) await publishElementSelectionUpdated(false);
  }

  function hasElementSelectionLease(sender: UiAttachChromeMessageSender): boolean {
    const senderTabId = contentTabIdFromSender(sender);
    const senderFrameId = contentFrameIdFromSender(sender);
    return senderTabId !== null && senderFrameId !== null &&
      senderTabId === elementSelectionTabId &&
      senderFrameId === elementSelectionFrameId &&
      selectionDocumentMatches(sender.documentId);
  }

  function selectionDocumentMatches(documentId: string | undefined): boolean {
    return elementSelectionDocumentId === null || documentId === elementSelectionDocumentId;
  }

  async function ensureResumableElementSelectionScopesLoaded(): Promise<void> {
    if (!resumableElementSelectionScopesLoadTask) {
      resumableElementSelectionScopesLoadTask = (async () => {
        try {
          const values = await chrome.storage.session.get(FRAME_SCOPE_SESSION_KEY);
          const scopes = parseStoredResumableElementSelectionScopes(
            values[FRAME_SCOPE_SESSION_KEY],
          );
          for (const scope of scopes) {
            resumableElementSelectionScopes.set(scope.tabId, scope);
          }
        } catch {
          // Keep the in-memory scope cache usable when session storage is unavailable.
        }
      })();
    }
    await resumableElementSelectionScopesLoadTask;
  }

  async function rememberResumableElementSelectionScope(
    scope: ResumableElementSelectionScope,
  ): Promise<void> {
    await ensureResumableElementSelectionScopesLoaded();
    resumableElementSelectionScopes.delete(scope.tabId);
    resumableElementSelectionScopes.set(scope.tabId, scope);
    while (resumableElementSelectionScopes.size > MAX_RESUMABLE_FRAME_SCOPES) {
      const oldestTabId = resumableElementSelectionScopes.keys().next().value;
      if (typeof oldestTabId !== "number") break;
      resumableElementSelectionScopes.delete(oldestTabId);
    }
    await persistResumableElementSelectionScopes();
  }

  async function forgetResumableElementSelectionScope(tabId: number): Promise<void> {
    await ensureResumableElementSelectionScopesLoaded();
    if (!resumableElementSelectionScopes.delete(tabId)) return;
    await persistResumableElementSelectionScopes();
  }

  async function persistResumableElementSelectionScopes(): Promise<void> {
    const snapshot = Array.from(resumableElementSelectionScopes.values(), (scope) => ({
      tabId: scope.tabId,
      windowId: scope.windowId,
      target: { ...scope.target },
      expectedPage: { ...scope.expectedPage },
    }));
    resumableElementSelectionScopesWriteTail = resumableElementSelectionScopesWriteTail
      .catch(() => undefined)
      .then(() => chrome.storage.session.set({ [FRAME_SCOPE_SESSION_KEY]: snapshot }));
    try {
      await resumableElementSelectionScopesWriteTail;
    } catch {
      // The verified in-memory scope remains available for this worker lifetime.
    }
  }

  async function getResumableElementSelectionScope(
    tabId: number,
  ): Promise<ResumableElementSelectionScope | null> {
    await ensureResumableElementSelectionScopesLoaded();
    const resumable = resumableElementSelectionScopes.get(tabId) ?? null;
    if (!resumable) return null;
    const activeTab = await getActiveTabForTab(tabId);
    const topPage = activePageContextFromTab(activeTab ?? undefined) ?? (
      activeTab ? await readFrameDerivedActiveTopPage(tabId) : null
    );
    if (
      !activeTab ||
      !topPage ||
      activeTab.windowId !== resumable.windowId ||
      topPage.origin !== resumable.expectedPage.origin ||
      topPage.pathname !== resumable.expectedPage.pathname ||
      !(await embeddedFrameStillMatches(tabId, resumable.target))
    ) {
      await forgetResumableElementSelectionScope(tabId);
      return null;
    }
    return resumable;
  }

  async function getActiveSession(): Promise<SessionCommandResponse<ActiveSessionCommandData>> {
    const activePage = await getActiveCapturePageContext();
    if (!activePage) {
      return { ok: true, data: { enabled: false, origin: null, readback: null, activePage: null } };
    }
    const read = await store.read(activePage.origin);
    if (!read.ok) return failureFromStore(read);
    await ensureActiveOverlayItemIdsLoaded();
    const selectedItemId = resolveOverlayActiveItemId(
      (read.value.file?.session.attachments ?? []).map((item) => item.id),
      activeOverlayItemIdsByOrigin.get(activePage.origin) ?? null,
    );
    return {
      ok: true,
      data: {
        enabled: true,
        origin: activePage.origin,
        readback: read.value,
        activePage,
        ...(selectedItemId ? { selectedItemId } : {}),
      },
    };
  }

  async function getActiveCapturePageContext(): Promise<ActivePageContext | null> {
    let topPage = await getActivePageContext();
    let resumable: ResumableElementSelectionScope | null = null;
    if (!topPage) {
      const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
      const tabId = tabs[0]?.id;
      if (
        elementSelectionTabId !== null ||
        typeof tabId !== "number" ||
        !Number.isInteger(tabId) ||
        tabId < 0
      ) return null;
      resumable = await getResumableElementSelectionScope(tabId);
      if (!resumable) return null;
      topPage = {
        tabId,
        frameId: 0,
        origin: resumable.expectedPage.origin,
        pathname: resumable.expectedPage.pathname,
      };
    } else if (elementSelectionTabId === null) {
      resumable = await getResumableElementSelectionScope(topPage.tabId);
    }
    const scopedFrame = elementSelectionTabId === topPage.tabId &&
        elementSelectionFrameId !== null &&
        elementSelectionFrameId > 0 &&
        elementSelectionFrameOrigin !== null &&
        elementSelectionFramePathname !== null
      ? {
          frameId: elementSelectionFrameId,
          origin: elementSelectionFrameOrigin,
          pathname: elementSelectionFramePathname,
          documentId: elementSelectionDocumentId,
        }
      : resumable
        ? {
            frameId: resumable.target.frameId,
            origin: resumable.target.frameOrigin ?? null,
            pathname: resumable.target.framePathname ?? null,
            documentId: resumable.target.documentId ?? null,
          }
        : null;
    return (
      scopedFrame && scopedFrame.origin !== null && scopedFrame.pathname !== null
        ? {
            tabId: topPage.tabId,
            frameId: scopedFrame.frameId,
            origin: scopedFrame.origin,
            pathname: scopedFrame.pathname,
            ...(scopedFrame.documentId
              ? { documentId: scopedFrame.documentId }
              : {}),
          }
        : topPage
    );
  }

  async function getOverlayRestore(
    origin: string,
    documentUrl: string,
    endpoint: OverlayEndpoint,
  ): Promise<SessionCommandResponse<OverlayRestoreData>> {
    const empty = (): SessionCommandResponse<OverlayRestoreData> => ({
      ok: true,
      data: { origin, activeItemId: null, items: [] },
    });
    let response: SessionCommandResponse<OverlayRestoreData> = empty();
    await enqueueOverlayOperation(origin, async () => {
      const activeTab = await getActiveTabForTab(endpoint.tabId);
      if (!activeTab) return;
      let frames: UiAttachChromeFrame[] | undefined;
      try {
        frames = await chrome.webNavigation.getAllFrames({ tabId: endpoint.tabId });
      } catch {
        frames = undefined;
      }
      if (!frames?.some((frame) => (
        frame.frameId === endpoint.frameId &&
        routeKeyFromUrl(frame.url) === routeKeyFromUrl(documentUrl)
      ))) return;
      const readback = await store.read(origin);
      if (!readback.ok) {
        response = failureFromStore(readback);
        return;
      }
      await ensureActiveOverlayItemIdsLoaded();
      response = {
        ok: true,
        data: collectOverlayRestoreData(
          readback.value,
          origin,
          documentUrl,
          endpoint,
          frames,
          activeOverlayItemIdsByOrigin.get(origin) ?? null,
          captureRouteChainFromFrames(frames, endpoint) ?? undefined,
        ),
      };
    });
    return response;
  }

  async function restoreSavedSessionOnCurrentPage(
    origin: string,
  ): Promise<SessionCommandResponse<OverlayRebindStatusData>> {
    const active = await getActiveSession();
    if (!active.ok) return active;
    const activePage = active.data.activePage;
    if (!active.data.enabled || !activePage || activePage.origin !== origin) {
      return failure(
        "RESTORE_PAGE_MISMATCH",
        "Open the saved page and grant MeanThis access before restoring it.",
      );
    }
    let ready = false;
    try {
      ready = await ensureContentScript(activePage.tabId, activePage.frameId);
    } catch {
      ready = false;
    }
    if (!ready) {
      return failure(
        "CONTENT_UNAVAILABLE",
        "MeanThis could not reconnect the current page for restore.",
      );
    }
    let frame: UiAttachChromeFrameDetails | undefined;
    try {
      frame = await chrome.webNavigation.getFrame({
        tabId: activePage.tabId,
        frameId: activePage.frameId,
      });
    } catch {
      frame = undefined;
    }
    if (
      !frame?.documentId ||
      originFromUrl(frame.url) !== activePage.origin ||
      pathnameFromUrl(frame.url) !== activePage.pathname
    ) {
      return failure(
        "FRAME_UNAVAILABLE",
        "The saved page frame is no longer available for restore.",
      );
    }
    let response: unknown;
    try {
      response = await chrome.tabs.sendMessage(activePage.tabId, {
        type: UI_ATTACH_OVERLAY_RESTORE_REFRESH,
      }, {
        frameId: activePage.frameId,
        documentId: frame.documentId,
      });
    } catch {
      response = null;
    }
    if (
      !isOverlayRebindStatusResponse(response) ||
      response.data.origin !== activePage.origin ||
      response.data.pathname !== activePage.pathname
    ) {
      return failure(
        "RESTORE_UNAVAILABLE",
        "The saved targets could not be rechecked on the current page.",
      );
    }
    return response;
  }

  async function findSavedSessionRestoreTarget(
    command: Extract<SessionCommand, {
      type: "ui-attach:saved-session-resolve-route" | "ui-attach:saved-session-restore-route";
    }>,
  ): Promise<SessionCommandResponse<SavedSessionRestoreTarget>> {
    let result = await findSavedSessionRestoreTargetOnce(command);
    for (let attempt = 1; attempt < SAVED_RESTORE_DISCOVERY_ATTEMPTS; attempt += 1) {
      if (
        result.ok ||
        (result.code !== "SAVED_ROUTE_NOT_OPEN" && result.code !== "FRAME_SCOPE_UNAVAILABLE")
      ) {
        return result;
      }
      await savedRestoreRetryDelay();
      result = await findSavedSessionRestoreTargetOnce(command);
    }
    return result;
  }

  async function findSavedSessionRestoreTargetOnce(
    command: Extract<SessionCommand, {
      type: "ui-attach:saved-session-resolve-route" | "ui-attach:saved-session-restore-route";
    }>,
  ): Promise<SessionCommandResponse<SavedSessionRestoreTarget>> {
    const readback = await store.read(command.origin);
    if (!readback.ok) return failureFromStore(readback);
    if (readback.value.clearPending || !readback.value.file) {
      return failure("INVALID_SESSION_FILE", "Stored capture session is unavailable.");
    }
    const routeKey = `${command.origin}${command.pathname}`;
    const matchingRecords = readback.value.file.session.attachments
      .map((item) => item.sourceRecord)
      .filter((record) => (
        record.origin === command.origin &&
        routeKeyFromUrl(record.pageUrl ?? undefined) === routeKey &&
        ((record.frameId ?? 0) === 0 ? "top" : "embedded") === command.frameKind &&
        sameCaptureRouteChain(record.routeChain, command.routeChain)
      ));
    if (matchingRecords.length === 0) {
      return failure("SAVED_ROUTE_UNAVAILABLE", "This route is not part of the saved capture.");
    }

    let currentPage: ActivePageContext | null = null;
    let currentFrames: UiAttachChromeFrame[] | undefined;
    try {
      currentPage = await getActivePageContext();
    } catch {
      currentPage = null;
    }
    if (!currentPage) {
      try {
        const activeTabs = await chrome.tabs.query({ active: true, currentWindow: true });
        const activeTabId = activeTabs[0]?.id;
        if (
          typeof activeTabId === "number" &&
          Number.isInteger(activeTabId) &&
          activeTabId >= 0
        ) {
          currentFrames = await chrome.webNavigation.getAllFrames({ tabId: activeTabId });
          const topFrame = currentFrames?.find((frame) => frame.frameId === 0);
          const topOrigin = originFromUrl(topFrame?.url);
          const topPathname = pathnameFromUrl(topFrame?.url);
          if (topOrigin && topPathname !== null) {
            currentPage = {
              tabId: activeTabId,
              frameId: 0,
              origin: topOrigin,
              pathname: topPathname,
              ...(topFrame?.documentId ? { documentId: topFrame.documentId } : {}),
            };
          }
        }
      } catch {
        currentFrames = undefined;
      }
    }
    const originalEndpoints = new Map<string, OverlayEndpoint>();
    for (const record of matchingRecords) {
      const tabId = record.tabId;
      const frameId = record.frameId ?? 0;
      if (
        typeof tabId !== "number" ||
        !Number.isSafeInteger(tabId) ||
        tabId < 0 ||
        !Number.isSafeInteger(frameId) ||
        frameId < 0
      ) continue;
      originalEndpoints.set(`${tabId}:${frameId}`, { tabId, frameId });
    }
    const originalTargets: SavedSessionRestoreTarget[] = [];
    for (const endpoint of originalEndpoints.values()) {
      const target = await readSavedSessionRestoreTarget(
        endpoint,
        command.origin,
        command.pathname,
        command.frameKind,
        command.routeChain,
        currentPage?.tabId === endpoint.tabId ? "current_page" : "original_tab",
      );
      if (target) originalTargets.push(target);
    }
    if (originalTargets.length > 1) {
      return failure(
        "SAVED_ROUTE_AMBIGUOUS",
        "More than one original page still contains this saved route.",
      );
    }
    if (originalTargets[0]) return { ok: true, data: originalTargets[0] };

    if (!currentPage) {
      return failure(
        "SAVED_ROUTE_NOT_OPEN",
        "Open the page that contains this saved frame and try again.",
      );
    }
    const selectedScopes = await listFrameScopes();
    if (selectedScopes.ok && selectedScopes.data.tabId === currentPage.tabId) {
      const selectedScope = selectedScopes.data.scopes.find((scope) => (
        scope.frameId === selectedScopes.data.currentFrameId &&
        scope.origin === command.origin &&
        scope.pathname === command.pathname &&
        (scope.frameId === 0 ? "top" : "embedded") === command.frameKind &&
        scope.selectable
      ));
      if (selectedScope) {
        const selectedTarget = await readSavedSessionRestoreTarget(
          { tabId: currentPage.tabId, frameId: selectedScope.frameId },
          command.origin,
          command.pathname,
          command.frameKind,
          command.routeChain,
          "current_page",
        );
        if (selectedTarget) return { ok: true, data: selectedTarget };
      }
    }
    let frames = currentFrames;
    if (!frames) {
      try {
        frames = await chrome.webNavigation.getAllFrames({ tabId: currentPage.tabId });
      } catch {
        frames = undefined;
      }
    }
    if (!frames) {
      return failure("FRAME_SCOPE_UNAVAILABLE", "MeanThis could not read the live frame tree.");
    }
    const candidates = frames.filter((frame) => (
      routeKeyFromUrl(frame.url) === routeKey &&
      (frame.frameId === 0 ? "top" : "embedded") === command.frameKind &&
      typeof frame.documentId === "string" &&
      frame.documentId.length > 0
    ));
    const candidateTargets: SavedSessionRestoreTarget[] = [];
    for (const candidate of candidates) {
      const target = await readSavedSessionRestoreTarget(
        { tabId: currentPage.tabId, frameId: candidate.frameId },
        command.origin,
        command.pathname,
        command.frameKind,
        command.routeChain,
        "current_page",
      );
      if (target) candidateTargets.push(target);
    }
    if (candidateTargets.length > 1) {
      return failure(
        "SAVED_ROUTE_AMBIGUOUS",
        "The current page contains more than one matching saved frame.",
      );
    }
    const target = candidateTargets[0];
    if (!target) {
      return failure(
        "SAVED_ROUTE_NOT_OPEN",
        "Open the page that contains this saved frame and try again.",
      );
    }
    return { ok: true, data: target };
  }

  async function readSavedSessionRestoreTarget(
    endpoint: OverlayEndpoint,
    origin: string,
    pathname: string,
    frameKind: "top" | "embedded",
    routeChain: CaptureRouteSegmentV1[] | undefined,
    location: SavedSessionRestoreTarget["location"],
  ): Promise<SavedSessionRestoreTarget | null> {
    let frame: UiAttachChromeFrameDetails | undefined;
    let topFrame: UiAttachChromeFrameDetails | undefined;
    try {
      frame = await chrome.webNavigation.getFrame({
        tabId: endpoint.tabId,
        frameId: endpoint.frameId,
      });
      topFrame = endpoint.frameId === 0
        ? frame
        : await chrome.webNavigation.getFrame({ tabId: endpoint.tabId, frameId: 0 });
    } catch {
      return null;
    }
    const topOrigin = originFromUrl(topFrame?.url);
    const topPathname = pathnameFromUrl(topFrame?.url);
    if (
      !frame?.documentId ||
      !topOrigin ||
      topPathname === null ||
      originFromUrl(frame.url) !== origin ||
      pathnameFromUrl(frame.url) !== pathname ||
      (endpoint.frameId === 0 ? "top" : "embedded") !== frameKind
    ) return null;
    if (routeChain) {
      const liveRouteChain = await readLiveCaptureRouteChain(chrome, endpoint);
      if (!sameCaptureRouteChain(liveRouteChain ?? undefined, routeChain)) return null;
    }
    return {
      tabId: endpoint.tabId,
      frameId: endpoint.frameId,
      documentId: frame.documentId,
      origin,
      pathname,
      topOrigin,
      topPathname,
      ...(routeChain ? { routeChain: routeChain.map((route) => ({ ...route })) } : {}),
      location,
    };
  }

  async function restoreSavedSessionRoute(
    command: Extract<SessionCommand, { type: "ui-attach:saved-session-restore-route" }>,
  ): Promise<SessionCommandResponse<OverlayRebindStatusData>> {
    const resolved = await findSavedSessionRestoreTarget(command);
    if (!resolved.ok) return resolved;
    const target = resolved.data;
    let activatedTab: UiAttachChromeTab;
    try {
      activatedTab = await chrome.tabs.update(target.tabId, { active: true });
    } catch {
      return failure("FRAME_UNAVAILABLE", "The saved page is no longer available.");
    }
    if (
      activatedTab.id !== target.tabId ||
      typeof activatedTab.windowId !== "number" ||
      !Number.isInteger(activatedTab.windowId)
    ) {
      return failure("FRAME_UNAVAILABLE", "The saved page is no longer available.");
    }
    if (chrome.windows) {
      try {
        const focusedWindow = await chrome.windows.update(activatedTab.windowId, { focused: true });
        if (
          (focusedWindow.id !== undefined && focusedWindow.id !== activatedTab.windowId) ||
          focusedWindow.focused === false
        ) {
          return failure("FRAME_UNAVAILABLE", "The saved page window could not be focused.");
        }
      } catch {
        return failure("FRAME_UNAVAILABLE", "The saved page window could not be focused.");
      }
    }
    if (!(await waitForActiveTab(target.tabId))) {
      return failure("FRAME_UNAVAILABLE", "The saved page did not become active in time.");
    }
    const selected = await selectFrameScope({
      type: "ui-attach:frame-scope-select",
      tabId: target.tabId,
      frameId: target.frameId,
      documentId: target.documentId,
      origin: target.origin,
      pathname: target.pathname,
      startSelection: false,
    }, { allowFrameDerivedTopPage: true });
    if (!selected.ok) return selected;

    let ready = false;
    for (let attempt = 0; attempt < SAVED_RESTORE_CONTENT_ATTEMPTS; attempt += 1) {
      if (!(await savedRestoreTargetStillActive(target))) {
        return failure("FRAME_UNAVAILABLE", "The saved page frame changed before restore.");
      }
      try {
        ready = await ensureContentScript(target.tabId, target.frameId, target.documentId);
      } catch {
        ready = false;
      }
      if (!(await savedRestoreTargetStillActive(target))) {
        return failure("FRAME_UNAVAILABLE", "The saved page frame changed before restore.");
      }
      if (ready) break;
      if (attempt + 1 < SAVED_RESTORE_CONTENT_ATTEMPTS) {
        await savedRestoreRetryDelay();
      }
    }
    if (!ready) {
      return failure("CONTENT_UNAVAILABLE", "MeanThis could not reconnect the saved page.");
    }
    for (let attempt = 0; attempt < SAVED_RESTORE_RESPONSE_ATTEMPTS; attempt += 1) {
      if (!(await savedRestoreTargetStillActive(target))) {
        return failure("FRAME_UNAVAILABLE", "The saved page frame changed before restore.");
      }
      let response: unknown;
      try {
        response = await chrome.tabs.sendMessage(target.tabId, {
          type: UI_ATTACH_OVERLAY_RESTORE_REFRESH,
        }, {
          frameId: target.frameId,
          documentId: target.documentId,
        });
      } catch {
        response = null;
      }
      if (!(await savedRestoreTargetStillActive(target))) {
        return failure("FRAME_UNAVAILABLE", "The saved page frame changed before restore.");
      }
      if (
        isOverlayRebindStatusResponse(response) &&
        response.data.origin === target.origin &&
        response.data.pathname === target.pathname &&
        response.data.items.length > 0
      ) {
        return response;
      }
      if (attempt + 1 < SAVED_RESTORE_RESPONSE_ATTEMPTS) {
        await savedRestoreRetryDelay();
      }
    }
    return failure("RESTORE_UNAVAILABLE", "The saved targets could not be rechecked.");
  }

  async function savedRestoreTargetStillActive(
    target: SavedSessionRestoreTarget,
  ): Promise<boolean> {
    if (!(await getActiveTabForTab(target.tabId))) return false;
    const live = await readSavedSessionRestoreTarget(
      { tabId: target.tabId, frameId: target.frameId },
      target.origin,
      target.pathname,
      target.frameId === 0 ? "top" : "embedded",
      target.routeChain,
      target.location,
    );
    return live?.documentId === target.documentId &&
      live.topOrigin === target.topOrigin &&
      live.topPathname === target.topPathname;
  }

  async function clearActivePageSessions(
    command: Extract<SessionCommand, { type: "ui-attach:session-clear" }>,
  ): Promise<SessionCommandResponse<ActiveSessionReadback>> {
    const topPage = await getActivePageContext();
    if (!topPage) {
      return clearSingleSession(command.origin, command.epoch, command.operationId);
    }

    let frames: UiAttachChromeFrame[] | undefined;
    try {
      frames = await chrome.webNavigation.getAllFrames({ tabId: topPage.tabId });
    } catch {
      return failure(
        "ACTIVE_PAGE_UNAVAILABLE",
        "MeanThis could not verify every live frame before clearing this page.",
      );
    }
    if (!frames) {
      return failure(
        "ACTIVE_PAGE_UNAVAILABLE",
        "MeanThis could not verify every live frame before clearing this page.",
      );
    }
    const liveFrames: Array<{ frameId: number; origin: string; pathname: string }> =
      frames.flatMap((frame) => {
        const origin = originFromUrl(frame.url);
        const pathname = pathnameFromUrl(frame.url);
        return origin && pathname !== null ? [{ frameId: frame.frameId, origin, pathname }] : [];
      });
    if (!liveFrames.some(({ origin }) => origin === topPage.origin)) {
      liveFrames.push({
        frameId: 0,
        origin: topPage.origin,
        pathname: topPage.pathname,
      });
    }

    const origins = [...new Set(liveFrames.map(({ origin }) => origin))];
    if (!origins.includes(command.origin)) {
      return failure(
        "FRAME_UNAVAILABLE",
        "The selected embedded frame is no longer available.",
      );
    }

    const targets: Array<{
      origin: string;
      epoch: string | null;
      previous: ActiveSessionReadback;
    }> = [];
    for (const origin of origins) {
      const previous = await store.read(origin);
      if (!previous.ok) return failureFromStore(previous);
      const originFrames = liveFrames.filter((frame) => frame.origin === origin);
      if (
        origin !== command.origin &&
        !readbackContainsLiveFrameSelection(previous.value, topPage.tabId, originFrames)
      ) continue;
      targets.push({
        origin,
        epoch: origin === command.origin ? command.epoch : previous.value.epoch,
        previous: previous.value,
      });
    }

    const ordered = [
      ...targets.filter(({ origin }) => origin !== command.origin),
      ...targets.filter(({ origin }) => origin === command.origin),
    ];
    const liveEndpoints = new Map<string, OverlayEndpoint>();
    for (const target of targets) {
      const originFrames = liveFrames.filter((frame) => frame.origin === target.origin);
      for (const endpoint of collectLiveFrameSelectionEndpoints(
        target.previous,
        topPage.tabId,
        originFrames,
      )) {
        liveEndpoints.set(endpointKey(endpoint), endpoint);
      }
    }
    for (const endpoint of liveEndpoints.values()) {
      let ready = false;
      try {
        ready = await ensureContentScript(endpoint.tabId, endpoint.frameId);
      } catch {
        ready = false;
      }
      if (!ready) {
        return failure(
          "CONTENT_UNAVAILABLE",
          "MeanThis could not reconnect every selected frame before clearing its page markers.",
        );
      }
    }
    let activeResult: ActiveSessionReadback | null = null;
    for (const target of ordered) {
      const cleared = await store.clear(target.origin, target.epoch, command.operationId);
      if (!cleared.ok) return failureFromStore(cleared);
      await syncOverlaySession(cleared.value, null, target.previous);
      if (target.origin === command.origin) activeResult = cleared.value;
    }
    if (activeResult) return { ok: true, data: activeResult };
    return clearSingleSession(command.origin, command.epoch, command.operationId);
  }

  async function clearSingleSession(
    origin: string,
    epoch: string | null,
    operationId: string,
  ): Promise<SessionCommandResponse<ActiveSessionReadback>> {
    const previous = await store.read(origin);
    if (!previous.ok) return failureFromStore(previous);
    const cleared = await store.clear(origin, epoch, operationId);
    if (!cleared.ok) return failureFromStore(cleared);
    await syncOverlaySession(cleared.value, null, previous.value);
    return { ok: true, data: cleared.value };
  }

  function readbackContainsLiveFrameSelection(
    readback: ActiveSessionReadback,
    tabId: number,
    frames: Array<{ frameId: number; origin: string; pathname: string }>,
  ): boolean {
    return collectLiveFrameSelectionEndpoints(readback, tabId, frames).length > 0;
  }

  function collectLiveFrameSelectionEndpoints(
    readback: ActiveSessionReadback,
    tabId: number,
    frames: Array<{ frameId: number; origin: string; pathname: string }>,
  ): OverlayEndpoint[] {
    const records = readback.file
      ? readback.file.session.attachments.map((item) => item.sourceRecord as OriginCaptureRecord)
      : readback.legacyRecord
        ? [readback.legacyRecord]
        : [];
    const endpoints = new Map<string, OverlayEndpoint>();
    for (const record of records) {
      const route = routeKeyFromUrl(record.pageUrl ?? undefined);
      const matched = record.tabId === tabId && frames.some(({ frameId, origin, pathname }) => (
        (record.frameId ?? 0) === frameId &&
        record.origin === origin &&
        route === `${origin}${pathname}`
      ));
      if (!matched) continue;
      const endpoint = { tabId, frameId: record.frameId ?? 0 };
      endpoints.set(endpointKey(endpoint), endpoint);
    }
    return [...endpoints.values()];
  }

  async function beginRuntimeCapture(
    origin: string,
  ): Promise<SessionCommandResponse<CaptureToken>> {
    return storeResult(await store.beginCapture(origin));
  }

  async function commitRuntimeCapture(
    command: Extract<SessionCommand, { type: "ui-attach:session-commit-capture" }>,
    senderOrigin: string,
    sender: UiAttachChromeMessageSender,
  ): Promise<SessionCommandResponse<CaptureCommitReceipt>> {
    if (command.token.origin !== senderOrigin || command.record.origin !== senderOrigin) {
      return failure("STALE_CAPTURE_OPERATION", "Capture operation origin does not match the sender.");
    }
    const selectionRevisionAtCommit = elementSelectionRevision;
    const stopAfterCommit = elementSelectionMode === "single";

    const routeChain = await readCaptureRouteChain(chrome, command.record, sender);
    const record = {
      ...command.record,
      ...(sender.tab?.id !== undefined ? { tabId: sender.tab.id } : {}),
      frameId: sender.frameId ?? 0,
      ...(routeChain ? { routeChain } : {}),
    };
    const committed = await store.commitCapture(command.token, record);
    if (!committed.ok) return failureFromStore(committed);
    await syncOverlaySession(committed.value.readback, committed.value.itemId);
    await publishCommitted(command.record.origin, committed.value.itemId);
    if (
      stopAfterCommit &&
      selectionRevisionAtCommit === elementSelectionRevision &&
      hasElementSelectionLease(sender)
    ) {
      await revokeElementSelectionLease();
    }
    return {
      ok: true,
      data: {
        origin: command.record.origin,
        epoch: command.token.epoch,
        itemId: committed.value.itemId,
        label: committed.value.label,
      },
    };
  }

  async function syncOverlaySession(
    readback: ActiveSessionReadback,
    activeItemId: string | null,
    previousReadback: ActiveSessionReadback | null = null,
  ): Promise<void> {
    await enqueueOverlayOperation(readback.origin, async () => {
      await rememberActiveOverlayItem(readback, activeItemId);
      await performOverlaySync(readback, activeItemId, previousReadback, false);
    });
  }

  async function syncStoredOverlaySession(
    origin: string,
    activeItemId: string | null,
  ): Promise<RuntimeResponse> {
    let response: RuntimeResponse = failure("CAPTURE_FAILED", SAFE_CAPTURE_ERROR);
    await enqueueOverlayOperation(origin, async () => {
      const read = await store.read(origin);
      if (!read.ok) {
        response = failureFromStore(read);
        return;
      }
      await rememberActiveOverlayItem(read.value, activeItemId);
      await performOverlaySync(read.value, activeItemId, null, true);
      response = { ok: true, data: null };
    });
    return response;
  }

  async function rememberActiveOverlayItem(
    readback: ActiveSessionReadback,
    requestedItemId: string | null,
  ): Promise<void> {
    await ensureActiveOverlayItemIdsLoaded();
    const activeItemId = resolveOverlayActiveItemId(
      (readback.file?.session.attachments ?? []).map((item) => item.id),
      requestedItemId,
    );
    if (activeItemId) {
      activeOverlayItemIdsByOrigin.delete(readback.origin);
      activeOverlayItemIdsByOrigin.set(readback.origin, activeItemId);
      while (activeOverlayItemIdsByOrigin.size > MAX_OVERLAY_ACTIVE_ITEMS) {
        const oldestOrigin = activeOverlayItemIdsByOrigin.keys().next().value as string | undefined;
        if (oldestOrigin === undefined) break;
        activeOverlayItemIdsByOrigin.delete(oldestOrigin);
      }
    } else {
      activeOverlayItemIdsByOrigin.delete(readback.origin);
    }
    await persistActiveOverlayItemIds();
  }

  async function ensureActiveOverlayItemIdsLoaded(): Promise<void> {
    if (!activeOverlayItemIdsLoadTask) {
      activeOverlayItemIdsLoadTask = (async () => {
        try {
          const stored = await chrome.storage.session.get(OVERLAY_ACTIVE_ITEMS_SESSION_KEY);
          for (const item of parseStoredActiveOverlayItems(
            stored[OVERLAY_ACTIVE_ITEMS_SESSION_KEY],
          )) {
            activeOverlayItemIdsByOrigin.set(item.origin, item.itemId);
          }
        } catch {
          // Selection emphasis remains available only for this worker lifetime.
        }
      })();
    }
    await activeOverlayItemIdsLoadTask;
  }

  async function persistActiveOverlayItemIds(): Promise<void> {
    const snapshot = Array.from(activeOverlayItemIdsByOrigin, ([origin, itemId]) => ({
      origin,
      itemId,
    }));
    activeOverlayItemIdsWriteTail = activeOverlayItemIdsWriteTail
      .catch(() => undefined)
      .then(() => chrome.storage.session.set({
        [OVERLAY_ACTIVE_ITEMS_SESSION_KEY]: snapshot,
      }));
    try {
      await activeOverlayItemIdsWriteTail;
    } catch {
      // The validated in-memory selection remains authoritative for this worker lifetime.
    }
  }

  async function previewStoredOverlayTarget(
    origin: string,
    itemId: string | null,
  ): Promise<RuntimeResponse> {
    let response: RuntimeResponse = failure("CAPTURE_FAILED", SAFE_CAPTURE_ERROR);
    await enqueueOverlayOperation(origin, async () => {
      if (itemId === null) {
        const lease = overlayPreviewLeasesByOrigin.get(origin);
        if (!lease) {
          response = overlayPreviewTargetNotFound();
          return;
        }
        overlayPreviewLeasesByOrigin.delete(origin);
        await sendOverlayPreview(lease, null);
        response = { ok: true, data: null };
        return;
      }

      const beforeRead = await getActivePageContext();
      if (!beforeRead || beforeRead.origin !== origin) {
        response = overlayPreviewTargetNotFound();
        return;
      }
      const read = await store.read(origin);
      if (!read.ok) {
        response = failureFromStore(read);
        return;
      }
      const activePage = await getActivePageContext();
      const item = read.value.file?.session.attachments.find(
        (candidate) => candidate.id === itemId,
      );
      const record = item?.sourceRecord as OriginCaptureRecord | undefined;
      if (
        !activePage ||
        !sameActivePage(beforeRead, activePage) ||
        !record ||
        !isOverlayPreviewRecordOnPage(record, activePage)
      ) {
        response = overlayPreviewTargetNotFound();
        return;
      }

      const previousLease = overlayPreviewLeasesByOrigin.get(origin);
      const nextLease: OverlayPreviewLease = { ...activePage, itemId };
      if (previousLease && !sameOverlayPreviewEndpoint(previousLease, nextLease)) {
        await sendOverlayPreview(previousLease, null);
      }
      const sent = await sendOverlayPreview(nextLease, itemId);
      const afterSend = sent ? await getActivePageContext() : null;
      if (sent && afterSend && sameActivePage(activePage, afterSend)) {
        overlayPreviewLeasesByOrigin.set(origin, nextLease);
      } else {
        overlayPreviewLeasesByOrigin.delete(origin);
        if (sent) await sendOverlayPreview(nextLease, null);
      }
      response = { ok: true, data: null };
    });
    return response;
  }

  async function previewStoredOverlayRelation(
    origin: string,
    sourceItemId: string,
    referenceItemId: string,
  ): Promise<RuntimeResponse> {
    let response: RuntimeResponse = failure("CAPTURE_FAILED", SAFE_CAPTURE_ERROR);
    await enqueueOverlayOperation(origin, async () => {
      const beforeRead = await getActivePageContext();
      if (!beforeRead || beforeRead.origin !== origin) {
        response = overlayPreviewTargetNotFound();
        return;
      }
      const read = await store.read(origin);
      if (!read.ok) {
        response = failureFromStore(read);
        return;
      }
      const activePage = await getActivePageContext();
      const source = read.value.file?.session.attachments.find(
        (candidate) => candidate.id === sourceItemId,
      )?.sourceRecord as OriginCaptureRecord | undefined;
      const reference = read.value.file?.session.attachments.find(
        (candidate) => candidate.id === referenceItemId,
      )?.sourceRecord as OriginCaptureRecord | undefined;
      if (
        !activePage ||
        !sameActivePage(beforeRead, activePage) ||
        !source ||
        !reference ||
        !isOverlayPreviewRecordOnPage(source, activePage) ||
        !isOverlayPreviewRecordOnPage(reference, activePage)
      ) {
        response = overlayPreviewTargetNotFound();
        return;
      }

      const previousLease = overlayPreviewLeasesByOrigin.get(origin);
      const nextLease: OverlayPreviewLease = { ...activePage, itemId: sourceItemId };
      if (previousLease && !sameOverlayPreviewEndpoint(previousLease, nextLease)) {
        await sendOverlayPreview(previousLease, null);
      }
      const sent = await sendOverlayRelationPreview(
        nextLease,
        sourceItemId,
        referenceItemId,
      );
      const afterSend = sent ? await getActivePageContext() : null;
      if (sent && afterSend && sameActivePage(activePage, afterSend)) {
        overlayPreviewLeasesByOrigin.set(origin, nextLease);
      } else {
        overlayPreviewLeasesByOrigin.delete(origin);
        if (sent) await sendOverlayPreview(nextLease, null);
      }
      response = { ok: true, data: null };
    });
    return response;
  }

  async function sendOverlayPreview(
    lease: OverlayPreviewLease,
    itemId: string | null,
  ): Promise<boolean> {
    try {
      await chrome.tabs.sendMessage(lease.tabId, {
        type: UI_ATTACH_OVERLAY_PREVIEW,
        origin: lease.origin,
        pathname: lease.pathname,
        itemId,
      }, { frameId: lease.frameId });
      return true;
    } catch {
      // Preview rendering is best-effort and never changes capture/session truth.
      return false;
    }
  }

  async function sendOverlayRelationPreview(
    lease: OverlayPreviewLease,
    sourceItemId: string,
    referenceItemId: string,
  ): Promise<boolean> {
    try {
      await chrome.tabs.sendMessage(lease.tabId, {
        type: UI_ATTACH_OVERLAY_RELATION_PREVIEW,
        origin: lease.origin,
        pathname: lease.pathname,
        sourceItemId,
        referenceItemId,
      }, { frameId: lease.frameId });
      return true;
    } catch {
      // Preview rendering is best-effort and never changes capture/session truth.
      return false;
    }
  }

  async function clearOverlayPreviewLeases(tabId?: number): Promise<void> {
    const origins = Array.from(overlayPreviewLeasesByOrigin.entries())
      .filter(([, lease]) => tabId === undefined || lease.tabId === tabId)
      .map(([origin]) => origin);
    await Promise.all(origins.map((origin) => enqueueOverlayOperation(origin, async () => {
      const lease = overlayPreviewLeasesByOrigin.get(origin);
      if (!lease || (tabId !== undefined && lease.tabId !== tabId)) return;
      overlayPreviewLeasesByOrigin.delete(origin);
      await sendOverlayPreview(lease, null);
    })));
  }

  async function enqueueOverlayOperation(
    origin: string,
    operation: () => Promise<void>,
  ): Promise<void> {
    const previous = overlaySyncTails.get(origin) ?? Promise.resolve();
    const queued = previous.then(
      operation,
      operation,
    );
    overlaySyncTails.set(origin, queued);
    try {
      await queued;
    } finally {
      if (overlaySyncTails.get(origin) === queued) {
        overlaySyncTails.delete(origin);
      }
    }
  }

  async function performOverlaySync(
    readback: ActiveSessionReadback,
    activeItemId: string | null,
    previousReadback: ActiveSessionReadback | null,
    includeLiveRebound: boolean,
  ): Promise<void> {
    const currentGroups = collectOverlayGroups(readback);
    let invalidLiveEndpointKey: string | null = null;
    if (includeLiveRebound) {
      const liveResolution = await collectLiveReboundOverlayGroup(readback);
      if (liveResolution) {
        currentGroups.delete(liveResolution.endpointKey);
        if (liveResolution.group) {
          currentGroups.set(liveResolution.endpointKey, liveResolution.group);
        } else {
          invalidLiveEndpointKey = liveResolution.endpointKey;
        }
      }
    }
    const endpoints = new Map(knownOverlayEndpointsByOrigin.get(readback.origin) ?? []);
    const previewLease = overlayPreviewLeasesByOrigin.get(readback.origin);
    if (previewLease) endpoints.set(endpointKey(previewLease), previewLease);
    for (const endpoint of collectOverlayEndpoints(previousReadback)) {
      endpoints.set(endpointKey(endpoint), endpoint);
    }
    for (const group of currentGroups.values()) {
      endpoints.set(endpointKey(group.endpoint), group.endpoint);
    }
    if (invalidLiveEndpointKey) endpoints.delete(invalidLiveEndpointKey);

    await Promise.all(Array.from(endpoints.values(), async (endpoint) => {
      const group = currentGroups.get(endpointKey(endpoint));
      const items = group?.items ?? [];
      const selected = resolveOverlayActiveItemId(
        items.map((item) => item.itemId),
        activeItemId,
      );
      try {
        await chrome.tabs.sendMessage(endpoint.tabId, {
          type: UI_ATTACH_OVERLAY_STATE,
          origin: readback.origin,
          activeItemId: selected,
          items,
        }, {
          frameId: endpoint.frameId,
          ...(endpoint.documentId ? { documentId: endpoint.documentId } : {}),
        });
      } catch {
        // Overlay rendering is best-effort and never changes capture/session truth.
      }
    }));

    const currentEndpoints = new Map<string, OverlayEndpoint>();
    for (const group of currentGroups.values()) {
      currentEndpoints.set(endpointKey(group.endpoint), group.endpoint);
    }
    if (currentEndpoints.size > 0) {
      knownOverlayEndpointsByOrigin.set(readback.origin, currentEndpoints);
    } else {
      knownOverlayEndpointsByOrigin.delete(readback.origin);
    }
    overlayPreviewLeasesByOrigin.delete(readback.origin);
  }

  async function collectLiveReboundOverlayGroup(
    readback: ActiveSessionReadback,
  ): Promise<{ endpointKey: string; group: OverlayGroup | null } | null> {
    let activePage: ActivePageContext | null;
    try {
      activePage = await getActiveCapturePageContext();
    } catch {
      return null;
    }
    if (!activePage || activePage.origin !== readback.origin) return null;
    const endpoint = { tabId: activePage.tabId, frameId: activePage.frameId };
    const liveEndpointKey = endpointKey(endpoint);

    let frames: UiAttachChromeFrame[] | undefined;
    try {
      frames = await chrome.webNavigation.getAllFrames({ tabId: activePage.tabId });
    } catch {
      frames = undefined;
    }
    const frame = frames?.find((candidate) => candidate.frameId === activePage.frameId);
    if (
      !frames ||
      !frame ||
      typeof frame.documentId !== "string" ||
      (activePage.documentId !== undefined && frame.documentId !== activePage.documentId) ||
      originFromUrl(frame.url) !== activePage.origin ||
      pathnameFromUrl(frame.url) !== activePage.pathname
    ) return { endpointKey: liveEndpointKey, group: null };

    const liveEndpoint = {
      ...endpoint,
      documentId: frame.documentId,
    };
    const liveRouteChain = captureRouteChainFromFrames(frames, liveEndpoint);

    const restored = collectOverlayRestoreData(
      readback,
      activePage.origin,
      frame.url,
      liveEndpoint,
      frames,
      activeOverlayItemIdsByOrigin.get(readback.origin) ?? null,
      liveRouteChain ?? undefined,
    );
    if (restored.items.length === 0) {
      return { endpointKey: liveEndpointKey, group: null };
    }
    return {
      endpointKey: liveEndpointKey,
      group: {
        endpoint: liveEndpoint,
        items: restored.items.map(({ itemId, attachmentId, label }) => ({
          itemId,
          attachmentId,
          label,
        })),
      },
    };
  }

  async function publishCommitted(
    origin: string,
    itemId: string,
  ): Promise<void> {
    await publishRuntimeMessage({
      type: UI_ATTACH_SESSION_UPDATED,
      origin,
      itemId,
    });
  }

  async function readDisclosureModeSetting(): Promise<ContentSettingsData["disclosureMode"]> {
    const values = await chrome.storage.local.get(DISCLOSURE_MODE_KEY);
    currentDisclosureMode = parseDisclosureMode(values[DISCLOSURE_MODE_KEY]);
    return currentDisclosureMode;
  }

  async function readContentSettings(
    tabId: number,
    frameId: number,
    documentId?: string,
  ): Promise<ContentSettingsData> {
    return {
      disclosureMode: await readDisclosureModeSetting(),
      testClickCaptureEnabled:
        tabId === elementSelectionTabId &&
        frameId === elementSelectionFrameId &&
        selectionDocumentMatches(documentId),
    };
  }

  function requestContentSettingsBroadcast(): void {
    settingsBroadcastRequested = true;
    if (settingsBroadcastTask) return;
    settingsBroadcastTask = drainContentSettingsBroadcasts().finally(() => {
      settingsBroadcastTask = null;
      if (settingsBroadcastRequested) requestContentSettingsBroadcast();
    });
  }

  async function drainContentSettingsBroadcasts(): Promise<void> {
    try {
      if (!(await storageAccessReady)) {
        settingsBroadcastRequested = false;
        return;
      }
      while (settingsBroadcastRequested) {
        settingsBroadcastRequested = false;
        const disclosureMode = await readDisclosureModeSetting();
        if (settingsBroadcastRequested) continue;
        await deliverContentSettings(
          disclosureMode,
          elementSelectionTabId !== null && elementSelectionFrameId !== null
            ? {
                tabId: elementSelectionTabId,
                frameId: elementSelectionFrameId,
                ...(elementSelectionDocumentId
                  ? { documentId: elementSelectionDocumentId }
                  : {}),
              }
            : null,
        );
      }
    } catch {
      settingsBroadcastRequested = false;
      const hadLease = elementSelectionTabId !== null;
      elementSelectionTabId = null;
      elementSelectionFrameId = null;
      elementSelectionDocumentId = null;
      elementSelectionFrameOrigin = null;
      elementSelectionFramePathname = null;
      elementSelectionParentFrameId = null;
      elementSelectionParentDocumentId = null;
      elementSelectionParentFrameOrigin = null;
      elementSelectionParentFramePathname = null;
      elementSelectionTopOrigin = null;
      elementSelectionTopPathname = null;
      elementSelectionWindowId = null;
      clearPendingElementSelectionLease();
      elementSelectionRevision += 1;
      currentDisclosureMode = "agent_safe";
      try {
        await deliverContentSettings("agent_safe", null);
      } catch {
        // A failed restrictive broadcast is not retried recursively.
      }
      if (hadLease) await publishElementSelectionUpdated(false);
    }
  }

  function deliverContentSettings(
    disclosureMode: ContentSettingsData["disclosureMode"],
    selectedEndpoint: ElementSelectionEndpoint | null,
  ): Promise<Set<string>> {
    const delivery = settingsDeliveryTail.then(
      () => broadcastContentSettings(disclosureMode, selectedEndpoint),
      () => broadcastContentSettings(disclosureMode, selectedEndpoint),
    );
    settingsDeliveryTail = delivery.then(() => undefined, () => undefined);
    return delivery;
  }

  async function broadcastContentSettings(
    disclosureMode: ContentSettingsData["disclosureMode"],
    selectedEndpoint: ElementSelectionEndpoint | null,
  ): Promise<Set<string>> {
    const tabs = await chrome.tabs.query({});
    const deliveredEndpoints = new Set<string>();
    await Promise.all(tabs.map(async (tab) => {
      if (tab.id === undefined) return;
      try {
        await chrome.tabs.sendMessage(tab.id, {
          type: UI_ATTACH_CONTENT_SETTINGS_UPDATED,
          disclosureMode,
          testClickCaptureEnabled: false,
        });
      } catch {
        // Tabs without the content script are outside the content settings boundary.
      }
    }));
    if (selectedEndpoint) {
      try {
        await chrome.tabs.sendMessage(selectedEndpoint.tabId, {
          type: UI_ATTACH_CONTENT_SETTINGS_UPDATED,
          disclosureMode,
          testClickCaptureEnabled: true,
        }, {
          frameId: selectedEndpoint.frameId,
          ...(selectedEndpoint.documentId
            ? { documentId: selectedEndpoint.documentId }
            : {}),
        });
        deliveredEndpoints.add(endpointKey(selectedEndpoint));
      } catch {
        // Exact-frame delivery is required before a selection lease becomes active.
      }
    }
    return deliveredEndpoints;
  }

  async function shouldShowOverlaysInWindow(windowId: number | undefined): Promise<boolean> {
    try {
      const preference = await readOverlayVisibilityPreference(chrome.storage.local);
      return preference === "always" || (
        typeof windowId === "number" &&
        panelVisibilityLeaseCountsByWindow.has(windowId)
      );
    } catch {
      return false;
    }
  }

  function requestOverlayVisibilityBroadcast(): void {
    overlayVisibilityBroadcastRequested = true;
    if (overlayVisibilityBroadcastTask) return;
    overlayVisibilityBroadcastTask = drainOverlayVisibilityBroadcasts().finally(() => {
      overlayVisibilityBroadcastTask = null;
      if (overlayVisibilityBroadcastRequested) requestOverlayVisibilityBroadcast();
    });
  }

  async function drainOverlayVisibilityBroadcasts(): Promise<void> {
    try {
      while (overlayVisibilityBroadcastRequested) {
        overlayVisibilityBroadcastRequested = false;
        const preference = await readOverlayVisibilityPreference(chrome.storage.local);
        if (overlayVisibilityBroadcastRequested) continue;
        await deliverOverlayVisibility(preference);
      }
    } catch {
      overlayVisibilityBroadcastRequested = false;
      try {
        await deliverOverlayVisibility("panel");
      } catch {
        // Existing content remains fail-closed after a visibility broadcast failure.
      }
    }
  }

  async function deliverOverlayVisibility(
    preference: OverlayVisibilityPreference,
  ): Promise<void> {
    const tabs = await chrome.tabs.query({});
    await Promise.all(tabs.map(async (tab) => {
      if (tab.id === undefined) return;
      const visible = preference === "always" || (
        typeof tab.windowId === "number" &&
        panelVisibilityLeaseCountsByWindow.has(tab.windowId)
      );
      const message = {
        type: UI_ATTACH_OVERLAY_VISIBILITY_UPDATED,
        visible,
      };
      let frames: UiAttachChromeFrame[] | undefined;
      try {
        frames = await chrome.webNavigation.getAllFrames({ tabId: tab.id });
      } catch {
        frames = undefined;
      }
      if (!frames || frames.length === 0) {
        try {
          await chrome.tabs.sendMessage(tab.id, message);
        } catch {
          // Tabs without the content script are outside the marker visibility boundary.
        }
        return;
      }
      await Promise.all(frames.map(async (frame) => {
        try {
          await chrome.tabs.sendMessage(tab.id!, message, {
            frameId: frame.frameId,
            ...(frame.documentId ? { documentId: frame.documentId } : {}),
          });
        } catch {
          // Frames without the content script are outside the marker visibility boundary.
        }
      }));
    }));
  }

  async function publishFailure(error: string): Promise<void> {
    await publishRuntimeMessage({ type: UI_ATTACH_CAPTURE_FAILED, error });
  }

  async function publishActiveOriginChanged(): Promise<void> {
    const activePage = await getActivePageContext();
    const origin = activePage?.origin ?? null;
    await publishRuntimeMessage({
      type: UI_ATTACH_ACTIVE_ORIGIN_CHANGED,
      accessRequired: origin === null && await activeHttpPageRequiresAccess(),
      enabled: origin !== null,
      origin,
    });
  }

  async function activeHttpPageRequiresAccess(): Promise<boolean> {
    const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
    const tab = tabs[0];
    if (activePageContextFromTab(tab) !== null || typeof tab?.id !== "number") return false;
    try {
      const frames = await chrome.webNavigation.getAllFrames({ tabId: tab.id });
      const topFrameUrl = frames?.find((frame) => frame.frameId === 0)?.url;
      if (!topFrameUrl) return false;
      const url = new URL(topFrameUrl);
      return url.protocol === "http:" || url.protocol === "https:";
    } catch {
      return false;
    }
  }

  async function publishElementSelectionUpdated(enabled: boolean): Promise<void> {
    await publishRuntimeMessage({
      type: UI_ATTACH_ELEMENT_SELECTION_UPDATED,
      enabled,
    });
  }

  async function publishRuntimeMessage(
    message:
      | CaptureFailedMessage
      | SessionUpdatedMessage
      | ActiveOriginChangedMessage
      | ElementSelectionUpdatedMessage,
  ): Promise<void> {
    try {
      await chrome.runtime.sendMessage(message);
    } catch {
      // The panel may not be open yet. The next explicit capture can try again.
    }
  }

  async function getActivePageContext(): Promise<ActivePageContext | null> {
    const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
    const page = activePageContextFromTab(tabs[0]);
    if (!page) return null;
    const documentId = await readContextDocumentId(
      page.tabId,
      page.origin,
      page.pathname,
    );
    return documentId ? { ...page, documentId } : page;
  }

  async function readFrameDerivedActiveTopPage(
    tabId: number,
  ): Promise<ActivePageContext | null> {
    try {
      const frames = await chrome.webNavigation.getAllFrames({ tabId });
      return activePageContextFromFrameInventory(tabId, frames);
    } catch {
      return null;
    }
  }

  async function getActivePageContextForTab(tabId: number): Promise<ElementSelectionPageContext | null> {
    const tab = await getActiveTabForTab(tabId);
    if (!tab) return null;
    const page = activePageContextFromTab(tab);
    return page ? { ...page, windowId: tab.windowId } : null;
  }

  async function getActiveTabForTab(
    tabId: number,
  ): Promise<(UiAttachChromeTab & { windowId: number }) | null> {
    const tabs = await chrome.tabs.query({ active: true });
    const tab = tabs.find((candidate) => candidate.id === tabId);
    if (
      typeof tab?.windowId !== "number" ||
      !Number.isInteger(tab.windowId) ||
      tab.windowId < 0
    ) {
      return null;
    }
    return { ...tab, windowId: tab.windowId };
  }

  async function waitForActiveTab(
    tabId: number,
  ): Promise<(UiAttachChromeTab & { windowId: number }) | null> {
    for (let attempt = 0; attempt < SAVED_RESTORE_ACTIVATION_ATTEMPTS; attempt += 1) {
      const activeTab = await getActiveTabForTab(tabId);
      if (activeTab) return activeTab;
      if (attempt + 1 < SAVED_RESTORE_ACTIVATION_ATTEMPTS) {
        await savedRestoreRetryDelay();
      }
    }
    return null;
  }

  async function savedRestoreRetryDelay(): Promise<void> {
    await new Promise<void>((resolve) => {
      setTimeout(resolve, SAVED_RESTORE_ACTIVATION_RETRY_MS);
    });
  }

  function activePageContextFromTab(tab: UiAttachChromeTab | undefined): ActivePageContext | null {
    if (typeof tab?.id !== "number" || !Number.isInteger(tab.id) || tab.id < 0 || !tab.url) {
      return null;
    }
    try {
      const url = new URL(tab.url);
      if (url.protocol !== "http:" && url.protocol !== "https:") return null;
      return {
        tabId: tab.id,
        frameId: 0,
        origin: url.origin,
        pathname: url.pathname,
      };
    } catch {
      return null;
    }
  }

  function activePageContextFromFrameInventory(
    tabId: number,
    frames: UiAttachChromeFrame[] | undefined,
  ): ActivePageContext | null {
    const topFrame = frames?.find((frame) => frame.frameId === 0);
    const origin = originFromUrl(topFrame?.url);
    const pathname = pathnameFromUrl(topFrame?.url);
    if (!origin || pathname === null) return null;
    return {
      tabId,
      frameId: 0,
      origin,
      pathname,
      ...(topFrame?.documentId ? { documentId: topFrame.documentId } : {}),
    };
  }

  return {
    handleContextMenuClick,
    handleNavigationCommitted,
    handleRuntimeMessage,
    handleTabActivated,
    handleTabUpdated,
    refreshActivePage: publishActiveOriginChanged,
    register,
  };
}

function parseSessionCommand(value: unknown): GuardResult<SessionCommand> {
  if (!isRecord(value) || typeof value.type !== "string") {
    return { ok: false, issues: [{ path: "type", message: "Expected a session command type." }] };
  }
  switch (value.type) {
    case "ui-attach:session-begin-capture":
    case "ui-attach:content-selection-disable":
    case "ui-attach:element-selection-get":
    case "ui-attach:frame-scope-list":
    case "ui-attach:content-settings-get":
    case UI_ATTACH_OVERLAY_VISIBILITY_GET:
    case UI_ATTACH_OVERLAYS_RESTORE_GET:
    case "ui-attach:session-get-active":
    case "ui-attach:session-list-stored":
    case "ui-attach:session-clear-all-stored": {
      const issues = validateAllowedKeys(value, ["type"], "message");
      if (issues.length > 0) return { ok: false, issues };
      return { ok: true, value: { type: value.type } };
    }
    case "ui-attach:session-review-stored":
    case "ui-attach:saved-session-restore-current": {
      const issues = [
        ...validateAllowedKeys(value, ["type", "origin"], "message"),
        ...validateOrigin(value.origin, "origin"),
      ];
      if (issues.length > 0) return { ok: false, issues };
      return {
        ok: true,
        value: { type: value.type, origin: value.origin as string },
      };
    }
    case "ui-attach:saved-session-resolve-route":
    case "ui-attach:saved-session-restore-route": {
      const issues = [
        ...validateAllowedKeys(
          value,
          ["type", "origin", "pathname", "frameKind", "routeChain"],
          "message",
        ),
        ...validateOrigin(value.origin, "origin"),
        ...validatePathname(value.pathname, value.origin, "pathname"),
        ...(value.frameKind === "top" || value.frameKind === "embedded"
          ? []
          : [{ path: "frameKind", message: "Expected top or embedded." }]),
        ...validateSavedSessionRouteChain(
          value.routeChain,
          value.origin,
          value.pathname,
          value.frameKind,
          "routeChain",
        ),
      ];
      if (issues.length > 0) return { ok: false, issues };
      return {
        ok: true,
        value: {
          type: value.type,
          origin: value.origin as string,
          pathname: value.pathname as string,
          frameKind: value.frameKind as "top" | "embedded",
          ...(Array.isArray(value.routeChain)
            ? {
                routeChain: value.routeChain.map((route) => ({
                  origin: (route as Record<string, unknown>).origin as string,
                  pathname: (route as Record<string, unknown>).pathname as string,
                })),
              }
            : {}),
        },
      };
    }
    case "ui-attach:session-prepare-snapshot-handoff": {
      const issues = [
        ...validateAllowedKeys(value, ["type", "origin", "epoch"], "message"),
        ...validateOrigin(value.origin, "origin"),
        ...validateBoundedNonEmptyString(value.epoch, "epoch", 256),
      ];
      if (issues.length > 0) return { ok: false, issues };
      return {
        ok: true,
        value: {
          type: value.type,
          origin: value.origin as string,
          epoch: value.epoch as string,
        },
      };
    }
    case "ui-attach:element-selection-set": {
      const enabled = value.enabled;
      const issues = [
        ...validateAllowedKeys(
          value,
          enabled === true ? ["type", "enabled", "tabId"] : ["type", "enabled"],
          "message",
        ),
        ...(typeof enabled === "boolean"
          ? []
          : [{ path: "enabled", message: "Expected a boolean." }]),
        ...(enabled === true && (
          typeof value.tabId !== "number" ||
          !Number.isInteger(value.tabId) ||
          value.tabId < 0
        )
          ? [{ path: "tabId", message: "Expected a non-negative integer." }]
          : []),
      ];
      if (issues.length > 0) return { ok: false, issues };
      return enabled === true
        ? { ok: true, value: { type: value.type, enabled: true, tabId: value.tabId as number } }
        : { ok: true, value: { type: value.type, enabled: false } };
    }
    case "ui-attach:frame-scope-select": {
      const issues = [
        ...validateAllowedKeys(
          value,
          ["type", "tabId", "frameId", "documentId", "origin", "pathname", "startSelection"],
          "message",
        ),
        ...(typeof value.tabId === "number" && Number.isInteger(value.tabId) && value.tabId >= 0
          ? []
          : [{ path: "tabId", message: "Expected a non-negative integer." }]),
        ...(typeof value.frameId === "number" && Number.isInteger(value.frameId) && value.frameId >= 0
          ? []
          : [{ path: "frameId", message: "Expected a non-negative integer." }]),
        ...(value.documentId === null
          ? []
          : validateBoundedNonEmptyString(value.documentId, "documentId", 256)),
        ...validateOrigin(value.origin, "origin"),
        ...validatePathname(value.pathname, value.origin, "pathname"),
        ...(typeof value.startSelection === "boolean"
          ? []
          : [{ path: "startSelection", message: "Expected a boolean." }]),
      ];
      if (issues.length > 0) return { ok: false, issues };
      return {
        ok: true,
        value: {
          type: value.type,
          tabId: value.tabId as number,
          frameId: value.frameId as number,
          documentId: value.documentId as string | null,
          origin: value.origin as string,
          pathname: value.pathname as string,
          startSelection: value.startSelection as boolean,
        },
      };
    }
    case "ui-attach:embedded-frame-selection-resolve":
    case "ui-attach:embedded-frame-selection-set": {
      const resolving = value.type === "ui-attach:embedded-frame-selection-resolve";
      const issues = [
        ...validateAllowedKeys(
          value,
          [
            "type",
            ...(resolving ? ["itemId"] : []),
            "tabId",
            "pageOrigin",
            "pagePathname",
            "parentFrameId",
            "frameOrigin",
            "framePathname",
          ],
          "message",
        ),
        ...(typeof value.tabId === "number" && Number.isInteger(value.tabId) && value.tabId >= 0
          ? []
          : [{ path: "tabId", message: "Expected a non-negative integer." }]),
        ...(resolving ? validateNonEmptyString(value.itemId, "itemId") : []),
        ...validateOrigin(value.pageOrigin, "pageOrigin"),
        ...validateOrigin(value.frameOrigin, "frameOrigin"),
        ...validatePathname(value.pagePathname, value.pageOrigin, "pagePathname"),
        ...validatePathname(value.framePathname, value.frameOrigin, "framePathname"),
        ...(typeof value.parentFrameId === "number" &&
          Number.isInteger(value.parentFrameId) &&
          value.parentFrameId >= 0
          ? []
          : [{ path: "parentFrameId", message: "Expected a non-negative integer." }]),
      ];
      if (issues.length > 0) return { ok: false, issues };
      const target = {
        tabId: value.tabId as number,
        pageOrigin: value.pageOrigin as string,
        pagePathname: value.pagePathname as string,
        parentFrameId: value.parentFrameId as number,
        frameOrigin: value.frameOrigin as string,
        framePathname: value.framePathname as string,
      };
      return resolving
        ? {
            ok: true,
            value: {
              type: "ui-attach:embedded-frame-selection-resolve",
              itemId: value.itemId as string,
              ...target,
            },
          }
        : {
            ok: true,
            value: { type: "ui-attach:embedded-frame-selection-set", ...target },
          };
    }
    case "ui-attach:embedded-frame-selection-activate": {
      const issues = [
        ...validateAllowedKeys(value, [
          "type",
          "itemId",
          "tabId",
          "pageOrigin",
          "pagePathname",
          "parentFrameId",
          "sourceFrameOrigin",
          "sourceFramePathname",
          "frameOrigin",
          "framePathname",
        ], "message"),
        ...validateNonEmptyString(value.itemId, "itemId"),
        ...(typeof value.tabId === "number" && Number.isInteger(value.tabId) && value.tabId >= 0
          ? []
          : [{ path: "tabId", message: "Expected a non-negative integer." }]),
        ...(typeof value.parentFrameId === "number" &&
          Number.isInteger(value.parentFrameId) && value.parentFrameId >= 0
          ? []
          : [{ path: "parentFrameId", message: "Expected a non-negative integer." }]),
        ...validateOrigin(value.pageOrigin, "pageOrigin"),
        ...validateOrigin(value.sourceFrameOrigin, "sourceFrameOrigin"),
        ...validateOrigin(value.frameOrigin, "frameOrigin"),
        ...validatePathname(value.pagePathname, value.pageOrigin, "pagePathname"),
        ...validatePathname(
          value.sourceFramePathname,
          value.sourceFrameOrigin,
          "sourceFramePathname",
        ),
        ...validatePathname(value.framePathname, value.frameOrigin, "framePathname"),
      ];
      if (issues.length > 0) return { ok: false, issues };
      return {
        ok: true,
        value: {
          type: value.type,
          itemId: value.itemId as string,
          tabId: value.tabId as number,
          pageOrigin: value.pageOrigin as string,
          pagePathname: value.pagePathname as string,
          parentFrameId: value.parentFrameId as number,
          sourceFrameOrigin: value.sourceFrameOrigin as string,
          sourceFramePathname: value.sourceFramePathname as string,
          frameOrigin: value.frameOrigin as string,
          framePathname: value.framePathname as string,
        },
      };
    }
    case "ui-attach:overlays-sync": {
      const issues = [
        ...validateAllowedKeys(value, ["type", "origin", "activeItemId"], "message"),
        ...validateOrigin(value.origin, "origin"),
        ...(value.activeItemId === null ? [] : validateNonEmptyString(value.activeItemId, "activeItemId")),
      ];
      if (issues.length > 0) return { ok: false, issues };
      return {
        ok: true,
        value: {
          type: value.type,
          origin: value.origin as string,
          activeItemId: value.activeItemId as string | null,
        },
      };
    }
    case UI_ATTACH_OVERLAY_PREVIEW: {
      const issues = [
        ...validateAllowedKeys(value, ["type", "origin", "itemId"], "message"),
        ...validateOrigin(value.origin, "origin"),
        ...(value.itemId === null ? [] : validateNonEmptyString(value.itemId, "itemId")),
      ];
      if (issues.length > 0) return { ok: false, issues };
      return {
        ok: true,
        value: {
          type: value.type,
          origin: value.origin as string,
          itemId: value.itemId as string | null,
        },
      };
    }
    case UI_ATTACH_OVERLAY_RELATION_PREVIEW: {
      const issues = [
        ...validateAllowedKeys(
          value,
          ["type", "origin", "sourceItemId", "referenceItemId"],
          "message",
        ),
        ...validateOrigin(value.origin, "origin"),
        ...validateNonEmptyString(value.sourceItemId, "sourceItemId"),
        ...validateNonEmptyString(value.referenceItemId, "referenceItemId"),
      ];
      if (
        typeof value.sourceItemId === "string" &&
        value.sourceItemId === value.referenceItemId
      ) {
        issues.push({
          path: "referenceItemId",
          message: "Expected a different relationship reference item.",
        });
      }
      if (issues.length > 0) return { ok: false, issues };
      return {
        ok: true,
        value: {
          type: value.type,
          origin: value.origin as string,
          sourceItemId: value.sourceItemId as string,
          referenceItemId: value.referenceItemId as string,
        },
      };
    }
    case "ui-attach:session-commit-capture": {
      const issues = validateAllowedKeys(value, ["type", "token", "record"], "message");
      const token = parseCaptureToken(value.token, "token", issues);
      const record = parseOriginCaptureRecord(value.record, "record", issues);
      if (issues.length > 0 || !token || !record.ok) return { ok: false, issues };
      return { ok: true, value: { type: value.type, token, record: record.value } };
    }
    case "ui-attach:session-update-intent": {
      const issues = [
        ...validateAllowedKeys(value, ["type", "origin", "epoch", "itemId", "intent"], "message"),
        ...validateOrigin(value.origin, "origin"),
        ...validateNonEmptyString(value.epoch, "epoch"),
        ...validateNonEmptyString(value.itemId, "itemId"),
        ...validateString(value.intent, "intent"),
      ];
      if (issues.length > 0) return { ok: false, issues };
      return {
        ok: true,
        value: {
          type: value.type,
          origin: value.origin as string,
          epoch: value.epoch as string,
          itemId: value.itemId as string,
          intent: value.intent as string,
        },
      };
    }
    case "ui-attach:session-remove-item": {
      const issues = [
        ...validateAllowedKeys(value, ["type", "origin", "epoch", "itemId"], "message"),
        ...validateOrigin(value.origin, "origin"),
        ...validateNonEmptyString(value.epoch, "epoch"),
        ...validateNonEmptyString(value.itemId, "itemId"),
      ];
      if (issues.length > 0) return { ok: false, issues };
      return {
        ok: true,
        value: {
          type: value.type,
          origin: value.origin as string,
          epoch: value.epoch as string,
          itemId: value.itemId as string,
        },
      };
    }
    case "ui-attach:session-clear": {
      const issues = [
        ...validateAllowedKeys(value, ["type", "origin", "epoch", "operationId"], "message"),
        ...validateOrigin(value.origin, "origin"),
        ...(value.epoch === null ? [] : validateNonEmptyString(value.epoch, "epoch")),
        ...validateNonEmptyString(value.operationId, "operationId"),
      ];
      if (issues.length > 0) return { ok: false, issues };
      return {
        ok: true,
        value: {
          type: value.type,
          origin: value.origin as string,
          epoch: value.epoch as string | null,
          operationId: value.operationId as string,
        },
      };
    }
    default:
      return {
        ok: false,
        unknownType: true,
        issues: [{ path: "type", message: "Unsupported session command type." }],
      };
  }
}

function parseCaptureToken(
  value: unknown,
  path: string,
  issues: Array<{ path: string; message: string }>,
): CaptureToken | null {
  if (!isRecord(value)) {
    issues.push({ path, message: "Expected a capture token object." });
    return null;
  }
  issues.push(...validateAllowedKeys(value, ["origin", "epoch", "operationId"], path));
  issues.push(...validateOrigin(value.origin, `${path}.origin`));
  issues.push(...validateNonEmptyString(value.epoch, `${path}.epoch`));
  issues.push(...validateNonEmptyString(value.operationId, `${path}.operationId`));
  if (issues.some((issue) => issue.path.startsWith(path))) return null;
  return {
    origin: value.origin as string,
    epoch: value.epoch as string,
    operationId: value.operationId as string,
  };
}

function parseOriginCaptureRecord(
  value: unknown,
  path = "record",
  issues: Array<{ path: string; message: string }> = [],
): GuardResult<OriginCaptureRecord> {
  if (!isRecord(value)) {
    issues.push({ path, message: "Expected a capture record object." });
    return { ok: false, issues };
  }
  issues.push(...validateAllowedKeys(value, [
    "origin",
    "pageUrl",
    "pageTitle",
    "attachment",
    "intent",
    "markdown",
    "summary",
    "replayAttempts",
    "capturedAt",
    "tabId",
    "frameId",
  ], path));
  issues.push(...validateOrigin(value.origin, `${path}.origin`));
  if (!(typeof value.pageUrl === "string" || value.pageUrl === null)) {
    issues.push({ path: `${path}.pageUrl`, message: "Expected a page URL string or null." });
  }
  if (!(typeof value.pageTitle === "string" || value.pageTitle === null)) {
    issues.push({ path: `${path}.pageTitle`, message: "Expected a page title string or null." });
  }
  if (!isRecord(value.attachment)) {
    issues.push({ path: `${path}.attachment`, message: "Expected an attachment object." });
  }
  issues.push(...validateString(value.intent, `${path}.intent`));
  issues.push(...validateString(value.markdown, `${path}.markdown`));
  issues.push(...validateNonEmptyString(value.capturedAt, `${path}.capturedAt`));
  if ("summary" in value && value.summary !== undefined && typeof value.summary !== "string") {
    issues.push({ path: `${path}.summary`, message: "Expected a summary string." });
  }
  if ("tabId" in value && value.tabId !== undefined && typeof value.tabId !== "number") {
    issues.push({ path: `${path}.tabId`, message: "Expected a tab id number." });
  }
  if ("frameId" in value && value.frameId !== undefined && typeof value.frameId !== "number") {
    issues.push({ path: `${path}.frameId`, message: "Expected a frame id number." });
  }
  if (issues.some((issue) => issue.path === path || issue.path.startsWith(`${path}.`))) {
    return { ok: false, issues };
  }
  return { ok: true, value: value as unknown as OriginCaptureRecord };
}

function validateOrigin(value: unknown, path: string): Array<{ path: string; message: string }> {
  return typeof value === "string" && originFromUrl(value) === value
    ? []
    : [{ path, message: "Expected a canonical HTTP(S) origin." }];
}

function validateString(value: unknown, path: string): Array<{ path: string; message: string }> {
  return typeof value === "string" ? [] : [{ path, message: "Expected a string." }];
}

function validatePathname(
  value: unknown,
  origin: unknown,
  path: string,
): Array<{ path: string; message: string }> {
  if (typeof value !== "string" || typeof origin !== "string" || !value.startsWith("/")) {
    return [{ path, message: "Expected a canonical pathname." }];
  }
  try {
    const url = new URL(value, `${origin}/`);
    return url.origin === origin && url.pathname === value && url.search === "" && url.hash === ""
      ? []
      : [{ path, message: "Expected a canonical pathname." }];
  } catch {
    return [{ path, message: "Expected a canonical pathname." }];
  }
}

function validateSavedSessionRouteChain(
  value: unknown,
  selectedOrigin: unknown,
  selectedPathname: unknown,
  frameKind: unknown,
  path: string,
): Array<{ path: string; message: string }> {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length === 0 || value.length > 33) {
    return [{ path, message: "Expected 1 to 33 canonical route segments." }];
  }
  const issues: Array<{ path: string; message: string }> = [];
  for (const [index, route] of value.entries()) {
    const routePath = `${path}[${index}]`;
    if (!isRecord(route)) {
      issues.push({ path: routePath, message: "Expected a canonical route segment." });
      continue;
    }
    issues.push(
      ...validateAllowedKeys(route, ["origin", "pathname"], routePath),
      ...validateOrigin(route.origin, `${routePath}.origin`),
      ...validatePathname(route.pathname, route.origin, `${routePath}.pathname`),
    );
  }
  const last = value.at(-1);
  if (
    !isRecord(last) ||
    last.origin !== selectedOrigin ||
    last.pathname !== selectedPathname
  ) {
    issues.push({ path, message: "Expected the route chain to end at the selected route." });
  }
  if (
    (frameKind === "top" && value.length !== 1) ||
    (frameKind === "embedded" && value.length < 2)
  ) {
    issues.push({ path, message: "Expected the route chain depth to match frameKind." });
  }
  return issues;
}

function validateNonEmptyString(
  value: unknown,
  path: string,
): Array<{ path: string; message: string }> {
  return typeof value === "string" && value.length > 0
    ? []
    : [{ path, message: "Expected a non-empty string." }];
}

function validateBoundedNonEmptyString(
  value: unknown,
  path: string,
  maxLength: number,
): Array<{ path: string; message: string }> {
  return typeof value === "string" && value.length > 0 && value.length <= maxLength
    ? []
    : [{ path, message: `Expected a non-empty string up to ${maxLength} characters.` }];
}

function validateAllowedKeys(
  value: Record<string, unknown>,
  allowedKeys: string[],
  path: string,
): Array<{ path: string; message: string }> {
  const allowed = new Set(allowedKeys);
  return Object.keys(value).some((key) => !allowed.has(key))
    ? [{ path, message: "Payload contains an undeclared field." }]
    : [];
}

function storeResult<T>(result: SessionStoreResult<T>): SessionCommandResponse<T> {
  return result.ok ? { ok: true, data: result.value } : failureFromStore(result);
}

function failureFromStore(
  result: Extract<SessionStoreResult<unknown>, { ok: false }>,
): Extract<SessionCommandResponse<never>, { ok: false }> {
  const error = safeStoreError(result);
  return result.issues === undefined
    ? { ok: false, code: result.code, error }
    : { ok: false, code: result.code, error, issues: result.issues };
}

function invalidCommand(
  issues: Array<{ path: string; message: string }>,
): Extract<SessionCommandResponse<never>, { ok: false }> {
  return {
    ok: false,
    code: "INVALID_COMMAND",
    error: "Invalid ui-attach session command.",
    issues,
  };
}

function failure(
  code: string,
  error: string,
): Extract<SessionCommandResponse<never>, { ok: false }> {
  return { ok: false, code, error };
}

function frameScopeAccessFailureMessage(error: unknown): string {
  const code = error instanceof FrameScopeAccessError ? error.code : "FRAME_PERMISSION_UNAVAILABLE";
  if (code === "FRAME_PERMISSION_DENIED") {
    return "Frame access was not granted. Nothing inside the frame was captured.";
  }
  if (code === "FRAME_PERMISSION_CLEANUP_FAILED") {
    return "Chrome could not release temporary frame access. Selection was stopped; review MeanThis site access in the extension settings.";
  }
  return "Frame access is unavailable in this browser. Reload the extension and try again.";
}

function overlayPreviewTargetNotFound(): Extract<SessionCommandResponse<never>, { ok: false }> {
  return failure("ITEM_NOT_FOUND", "Capture session item was not found.");
}

function sameActivePage(left: ActivePageContext, right: ActivePageContext): boolean {
  return left.tabId === right.tabId &&
    left.frameId === right.frameId &&
    left.origin === right.origin &&
    left.pathname === right.pathname;
}

function sameOverlayPreviewEndpoint(
  left: OverlayPreviewLease,
  right: OverlayPreviewLease,
): boolean {
  return left.tabId === right.tabId &&
    left.frameId === right.frameId &&
    left.origin === right.origin &&
    left.pathname === right.pathname;
}

function isOverlayPreviewRecordOnPage(
  record: OriginCaptureRecord,
  page: ActivePageContext,
): boolean {
  return record.origin === page.origin &&
    record.tabId === page.tabId &&
    (record.frameId ?? 0) === page.frameId &&
    routeKeyFromUrl(record.pageUrl ?? undefined) === `${page.origin}${page.pathname}`;
}

function parseStoredActiveOverlayItems(
  value: unknown,
): Array<{ origin: string; itemId: string }> {
  if (!Array.isArray(value) || value.length > MAX_OVERLAY_ACTIVE_ITEMS) return [];
  const items: Array<{ origin: string; itemId: string }> = [];
  const origins = new Set<string>();
  for (const candidate of value) {
    if (!isRecord(candidate) || !hasOnlyStoredKeys(candidate, ["origin", "itemId"])) return [];
    const origin = canonicalStoredOrigin(candidate.origin);
    const itemId = boundedStoredString(candidate.itemId, 256);
    if (
      !origin ||
      !itemId ||
      !/^att_[A-Za-z0-9_-]{1,252}$/u.test(itemId) ||
      origins.has(origin)
    ) return [];
    origins.add(origin);
    items.push({ origin, itemId });
  }
  return items;
}

function parseStoredResumableElementSelectionScopes(
  value: unknown,
): ResumableElementSelectionScope[] {
  if (!Array.isArray(value) || value.length > MAX_RESUMABLE_FRAME_SCOPES) return [];
  const scopes: ResumableElementSelectionScope[] = [];
  const tabIds = new Set<number>();
  for (const candidate of value) {
    const scope = parseStoredResumableElementSelectionScope(candidate);
    if (!scope || tabIds.has(scope.tabId)) return [];
    tabIds.add(scope.tabId);
    scopes.push(scope);
  }
  return scopes;
}

function parseStoredResumableElementSelectionScope(
  value: unknown,
): ResumableElementSelectionScope | null {
  if (!isRecord(value) || !hasOnlyStoredKeys(value, [
    "tabId",
    "windowId",
    "target",
    "expectedPage",
  ])) return null;
  if (!isNonNegativeInteger(value.tabId) || !isNonNegativeInteger(value.windowId)) return null;
  if (!isRecord(value.expectedPage) || !hasOnlyStoredKeys(value.expectedPage, [
    "origin",
    "pathname",
  ])) return null;
  const expectedOrigin = canonicalStoredOrigin(value.expectedPage.origin);
  const expectedPathname = canonicalStoredPathname(value.expectedPage.pathname, expectedOrigin);
  if (!expectedOrigin || expectedPathname === null) return null;

  const target = parseStoredElementSelectionTarget(value.target);
  if (!target) return null;
  return {
    tabId: value.tabId,
    windowId: value.windowId,
    target,
    expectedPage: { origin: expectedOrigin, pathname: expectedPathname },
  };
}

function parseStoredElementSelectionTarget(value: unknown): ElementSelectionTarget | null {
  if (!isRecord(value) || !hasOnlyStoredKeys(value, [
    "frameId",
    "frameOrigin",
    "framePathname",
    "documentId",
    "parentFrameId",
    "parentDocumentId",
    "parentFrameOrigin",
    "parentFramePathname",
  ])) return null;
  if (!isNonNegativeInteger(value.frameId) || value.frameId === 0) return null;
  if (!isNonNegativeInteger(value.parentFrameId)) return null;
  const frameOrigin = canonicalStoredOrigin(value.frameOrigin);
  const framePathname = canonicalStoredPathname(value.framePathname, frameOrigin);
  const documentId = boundedStoredString(value.documentId, 256);
  if (!frameOrigin || framePathname === null || !documentId) return null;

  const target: ElementSelectionTarget = {
    frameId: value.frameId,
    frameOrigin,
    framePathname,
    documentId,
    parentFrameId: value.parentFrameId,
  };
  if (value.parentFrameId > 0) {
    const parentDocumentId = boundedStoredString(value.parentDocumentId, 256);
    const parentFrameOrigin = canonicalStoredOrigin(value.parentFrameOrigin);
    const parentFramePathname = canonicalStoredPathname(
      value.parentFramePathname,
      parentFrameOrigin,
    );
    if (!parentDocumentId || !parentFrameOrigin || parentFramePathname === null) return null;
    target.parentDocumentId = parentDocumentId;
    target.parentFrameOrigin = parentFrameOrigin;
    target.parentFramePathname = parentFramePathname;
  } else if (
    value.parentDocumentId !== undefined ||
    value.parentFrameOrigin !== undefined ||
    value.parentFramePathname !== undefined
  ) {
    return null;
  }
  return target;
}

function hasOnlyStoredKeys(value: Record<string, unknown>, allowed: string[]): boolean {
  return Object.keys(value).every((key) => allowed.includes(key));
}

function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0;
}

function boundedStoredString(value: unknown, maxLength: number): string | null {
  return typeof value === "string" && value.length > 0 && value.length <= maxLength
    ? value
    : null;
}

function canonicalStoredOrigin(value: unknown): string | null {
  return typeof value === "string" && originFromUrl(value) === value ? value : null;
}

function canonicalStoredPathname(value: unknown, origin: string | null): string | null {
  if (!origin || typeof value !== "string" || !value.startsWith("/")) return null;
  return pathnameFromUrl(`${origin}${value}`) === value ? value : null;
}

function originFromUrl(value: string | undefined): string | null {
  if (!value) return null;
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:" ? url.origin : null;
  } catch {
    return null;
  }
}

function pathnameFromUrl(value: string | undefined): string | null {
  if (!value) return null;
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:" ? url.pathname : null;
  } catch {
    return null;
  }
}

function documentChanged(observed: string | undefined, expected: string | null): boolean {
  return expected !== null && observed !== expected;
}

function routeChanged(
  url: string,
  expectedOrigin: string | null,
  expectedPathname: string | null,
): boolean {
  return expectedOrigin !== null &&
    expectedPathname !== null &&
    (originFromUrl(url) !== expectedOrigin || pathnameFromUrl(url) !== expectedPathname);
}

function resolvedEmbeddedFrameIdentity(
  command: Extract<SessionCommand, { type: "ui-attach:embedded-frame-selection-resolve" }>,
  frame: UiAttachChromeFrame,
  parent: UiAttachChromeFrame | undefined,
  page: ActivePageContext,
): SessionCommandResponse<ResolvedEmbeddedFrameSelection> {
  const frameOrigin = originFromUrl(frame.url);
  const framePathname = pathnameFromUrl(frame.url);
  if (
    !frameOrigin ||
    !framePathname ||
    typeof frame.documentId !== "string" ||
    frame.documentId.length === 0
  ) {
    return failure("FRAME_UNAVAILABLE", "The selected embedded frame is no longer available.");
  }
  return {
    ok: true,
    data: {
      target: {
        tabId: command.tabId,
        pageOrigin: command.pageOrigin,
        pagePathname: command.pagePathname,
        parentFrameId: command.parentFrameId,
        frameOrigin,
        framePathname,
        requiresHostPermission: frameOrigin !== page.origin,
      },
      selectionTarget: {
        frameId: frame.frameId,
        frameOrigin,
        framePathname,
        documentId: frame.documentId,
        parentFrameId: command.parentFrameId,
        ...(parent?.documentId ? { parentDocumentId: parent.documentId } : {}),
        parentFrameOrigin: command.pageOrigin,
        parentFramePathname: command.pagePathname,
      },
      expectedPage: { origin: page.origin, pathname: page.pathname },
    },
  };
}

function parseDisclosureMode(value: unknown): ContentSettingsData["disclosureMode"] {
  return value === "developer_diagnostic" || value === "full_debug" ? value : "agent_safe";
}

function contentOriginFromSender(sender: UiAttachChromeMessageSender): string | null {
  if (!sender.tab || !sender.url) return null;
  const senderOrigin = originFromUrl(sender.url);
  if (!senderOrigin) return null;
  if (sender.tab.url !== undefined && !originFromUrl(sender.tab.url)) return null;
  return senderOrigin;
}

function contentTabIdFromSender(sender: UiAttachChromeMessageSender): number | null {
  const tabId = sender.tab?.id;
  return typeof tabId === "number" && Number.isInteger(tabId) && tabId >= 0
    ? tabId
    : null;
}

function contentFrameIdFromSender(sender: UiAttachChromeMessageSender): number | null {
  const frameId = sender.frameId ?? 0;
  return typeof frameId === "number" && Number.isInteger(frameId) && frameId >= 0
    ? frameId
    : null;
}

function overlayEndpointFromSender(sender: UiAttachChromeMessageSender): OverlayEndpoint | null {
  const tabId = sender.tab?.id;
  const frameId = sender.frameId ?? 0;
  return typeof tabId === "number" && Number.isInteger(tabId) && tabId >= 0 &&
    typeof frameId === "number" && Number.isInteger(frameId) && frameId >= 0
    ? { tabId, frameId }
    : null;
}

function isExtensionPageSender(sender: UiAttachChromeMessageSender): boolean {
  if (!sender.url) return false;
  try {
    const url = new URL(sender.url);
    if (url.protocol !== "chrome-extension:" || url.hostname.length === 0) return false;
    if (sender.tab?.url === undefined) return true;
    const tabUrl = new URL(sender.tab.url);
    return tabUrl.protocol === "chrome-extension:" && tabUrl.origin === url.origin;
  } catch {
    return false;
  }
}

function panelLifecycleWindowId(portName: string): number | null {
  const prefix = `${UI_ATTACH_PANEL_LIFECYCLE_PORT_PREFIX}:`;
  if (!portName.startsWith(prefix)) return null;
  const value = portName.slice(prefix.length);
  if (!/^(?:0|[1-9][0-9]*)$/u.test(value)) return null;
  const windowId = Number(value);
  return Number.isSafeInteger(windowId) && windowId >= 0 ? windowId : null;
}

function untrustedSender(): Extract<SessionCommandResponse<never>, { ok: false }> {
  return failure("UNTRUSTED_SENDER", "Runtime message sender is not trusted for this command.");
}

function selectionNotActive(): Extract<SessionCommandResponse<never>, { ok: false }> {
  return failure(
    "SELECTION_NOT_ACTIVE",
    "Element selection is not active for this tab.",
  );
}

function safeStoreError(result: Extract<SessionStoreResult<unknown>, { ok: false }>): string {
  switch (result.code) {
    case "CLEAR_IN_PROGRESS":
      return "A session clear is already in progress.";
    case "INVALID_SESSION_FILE":
      return "Capture session is invalid.";
    case "ITEM_NOT_FOUND":
      return "Capture session item was not found.";
    case "SESSION_FULL":
      return "Capture session already contains 26 items.";
    case "SESSION_TOO_LARGE":
      return "Capture session is too large.";
    case "STALE_CAPTURE_OPERATION":
      return "Capture operation belongs to a stale epoch.";
    case "STALE_SESSION":
      return "Session mutation belongs to a stale epoch.";
    case "UNSUPPORTED_ORIGIN":
      return "Only canonical HTTP(S) origins are supported.";
    case "STORAGE_ERROR":
      return SAFE_CAPTURE_ERROR;
  }
}

function collectOverlayGroups(readback: ActiveSessionReadback): Map<string, OverlayGroup> {
  const groups = new Map<string, OverlayGroup>();
  for (const [index, item] of (readback.file?.session.attachments ?? []).entries()) {
    const tabId = item.sourceRecord.tabId;
    const frameId = item.sourceRecord.frameId ?? 0;
    if (typeof tabId !== "number" || !Number.isInteger(tabId) || !Number.isInteger(frameId)) {
      continue;
    }
    const endpoint = { tabId, frameId };
    const key = endpointKey(endpoint);
    const group: OverlayGroup = groups.get(key) ?? { endpoint, items: [] };
    group.items.push({
      itemId: item.id,
      attachmentId: item.sourceRecord.attachment.id,
      label: item.labels.find((candidate) => candidate.trim().length > 0) ?? formatOverlayLabel(index),
    });
    groups.set(key, group);
  }
  return groups;
}

function collectOverlayRestoreData(
  readback: ActiveSessionReadback,
  origin: string,
  documentUrl: string,
  endpoint: OverlayEndpoint,
  liveFrames: UiAttachChromeFrame[],
  activeItemId: string | null,
  liveRouteChain?: CaptureRouteSegmentV1[],
): OverlayRestoreData {
  const routeKey = routeKeyFromUrl(documentUrl);
  const items: OverlayRestoreItem[] = [];
  if (routeKey === null) {
    return { origin, activeItemId: null, items };
  }

  for (const [index, item] of (readback.file?.session.attachments ?? []).entries()) {
    if (items.length === OVERLAY_RESTORE_MAX_ITEMS) break;
    const record = item.sourceRecord;
    const frameId = record.frameId ?? 0;
    const recordedRouteKey = routeKeyFromUrl(record.pageUrl ?? undefined);
    const sameRoute = recordedRouteKey === routeKey;
    const crossView = !sameRoute && frameId === 0 && endpoint.frameId === 0;
    const locators = sameRoute
      ? collectVerifiedOverlayReplayLocators(record)
      : crossView
        ? collectVerifiedContentAnchoredOverlayReplayLocators(record)
        : [];
    if (
      record.origin !== origin ||
      recordedRouteKey === null ||
      locators.length === 0 ||
      (!crossView && record.routeChain !== undefined &&
        !sameCaptureRouteChain(record.routeChain, liveRouteChain)) ||
      !overlayRecordMatchesLiveEndpoint(record.tabId, frameId, endpoint, routeKey, liveFrames)
    ) {
      continue;
    }
    items.push({
      itemId: item.id,
      attachmentId: record.attachment.id,
      label: item.labels.find((candidate) => candidate.trim().length > 0) ?? formatOverlayLabel(index),
      locators,
    });
  }

  return {
    origin,
    activeItemId: resolveOverlayActiveItemId(
      items.map((item) => item.itemId),
      activeItemId,
    ),
    items,
  };
}

function resolveOverlayActiveItemId(
  itemIds: Iterable<string>,
  requestedItemId: string | null,
): string | null {
  if (requestedItemId === null) return null;
  for (const itemId of itemIds) {
    if (itemId === requestedItemId) return requestedItemId;
  }
  return null;
}

function overlayRecordMatchesLiveEndpoint(
  recordedTabId: number | undefined,
  recordedFrameId: number,
  endpoint: OverlayEndpoint,
  routeKey: string,
  liveFrames: UiAttachChromeFrame[],
): boolean {
  if (!Number.isSafeInteger(recordedTabId) || recordedTabId === undefined || recordedTabId < 0) {
    return false;
  }
  if (recordedTabId === endpoint.tabId && recordedFrameId === endpoint.frameId) return true;
  const recordedFrameKind = recordedFrameId === 0 ? "top" : "embedded";
  const candidates = liveFrames.filter((frame) => (
    routeKeyFromUrl(frame.url) === routeKey &&
    (frame.frameId === 0 ? "top" : "embedded") === recordedFrameKind
  ));
  return candidates.length === 1 && candidates[0]?.frameId === endpoint.frameId;
}

function routeKeyFromUrl(value: string | undefined): string | null {
  if (!value) return null;
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:"
      ? `${url.origin}${url.pathname}`
      : null;
  } catch {
    return null;
  }
}

async function readCaptureRouteChain(
  chrome: UiAttachChrome,
  record: OriginCaptureRecord,
  sender: UiAttachChromeMessageSender,
): Promise<CaptureRouteSegmentV1[] | null> {
  const tabId = sender.tab?.id;
  const frameId = sender.frameId ?? 0;
  const topRoute = captureRouteSegmentFromUrl(sender.tab?.url);
  const selectedRoute = captureRouteSegmentFromUrl(record.pageUrl ?? undefined);
  if (
    tabId === undefined ||
    !Number.isSafeInteger(tabId) ||
    tabId < 0 ||
    !Number.isSafeInteger(frameId) ||
    frameId < 0 ||
    !topRoute ||
    !selectedRoute
  ) return null;
  if (frameId === 0) {
    return sameCaptureRoute(topRoute, selectedRoute) ? [topRoute] : null;
  }

  let frames: UiAttachChromeFrame[] | undefined;
  try {
    frames = await chrome.webNavigation.getAllFrames({ tabId });
  } catch {
    frames = undefined;
  }
  if (!frames) return null;
  const byId = new Map(frames.map((frame) => [frame.frameId, frame]));
  const chain: CaptureRouteSegmentV1[] = [];
  const visited = new Set<number>();
  let current = byId.get(frameId);
  while (current && current.frameId > 0 && !visited.has(current.frameId) && chain.length < 32) {
    visited.add(current.frameId);
    const route = captureRouteSegmentFromUrl(current.url);
    if (!route) return null;
    chain.unshift(route);
    if (current.parentFrameId === 0) break;
    if (current.parentFrameId < 0) return null;
    current = byId.get(current.parentFrameId);
  }
  if (!current || current.parentFrameId !== 0 || chain.length === 0) return null;
  chain.unshift(topRoute);
  return sameCaptureRoute(chain.at(-1), selectedRoute) ? chain : null;
}

async function readLiveCaptureRouteChain(
  chrome: UiAttachChrome,
  endpoint: OverlayEndpoint,
): Promise<CaptureRouteSegmentV1[] | null> {
  let frames: UiAttachChromeFrame[] | undefined;
  try {
    frames = await chrome.webNavigation.getAllFrames({ tabId: endpoint.tabId });
  } catch {
    frames = undefined;
  }
  if (!frames) return null;
  return captureRouteChainFromFrames(frames, endpoint);
}

function captureRouteChainFromFrames(
  frames: UiAttachChromeFrame[],
  endpoint: OverlayEndpoint,
): CaptureRouteSegmentV1[] | null {
  const byId = new Map(frames.map((frame) => [frame.frameId, frame]));
  const topRoute = captureRouteSegmentFromUrl(byId.get(0)?.url);
  if (!topRoute) return null;
  if (endpoint.frameId === 0) return [topRoute];

  const chain: CaptureRouteSegmentV1[] = [];
  const visited = new Set<number>();
  let current = byId.get(endpoint.frameId);
  while (current && current.frameId > 0 && !visited.has(current.frameId) && chain.length < 32) {
    visited.add(current.frameId);
    const route = captureRouteSegmentFromUrl(current.url);
    if (!route) return null;
    chain.unshift(route);
    if (current.parentFrameId === 0) break;
    if (current.parentFrameId < 0) return null;
    current = byId.get(current.parentFrameId);
  }
  if (!current || current.parentFrameId !== 0 || chain.length === 0) return null;
  chain.unshift(topRoute);
  return chain;
}

function captureRouteSegmentFromUrl(value: string | undefined): CaptureRouteSegmentV1 | null {
  if (!value) return null;
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:"
      ? { origin: url.origin, pathname: url.pathname }
      : null;
  } catch {
    return null;
  }
}

function sameCaptureRoute(
  left: CaptureRouteSegmentV1 | undefined,
  right: CaptureRouteSegmentV1 | undefined,
): boolean {
  return left !== undefined && right !== undefined &&
    left.origin === right.origin && left.pathname === right.pathname;
}

function sameCaptureRouteChain(
  left: readonly CaptureRouteSegmentV1[] | undefined,
  right: readonly CaptureRouteSegmentV1[] | undefined,
): boolean {
  if (left === undefined || right === undefined) return left === right;
  return left.length === right.length && left.every((route, index) => (
    sameCaptureRoute(route, right[index])
  ));
}

function collectOverlayEndpoints(readback: ActiveSessionReadback | null): OverlayEndpoint[] {
  return readback ? Array.from(collectOverlayGroups(readback).values(), (group) => group.endpoint) : [];
}

function endpointKey(endpoint: OverlayEndpoint): string {
  return `${endpoint.tabId}:${endpoint.frameId}`;
}

function formatOverlayLabel(index: number): string {
  return String.fromCharCode("A".charCodeAt(0) + index);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
