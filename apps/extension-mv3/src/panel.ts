import { createBrowserCaptureObservationReader } from "./browser-capture-observation";
import "./extension-api";
import { createPanelCaptureComparison, type CaptureObservationReader } from "./panel-capture-comparison";
import {
  deriveCapturePageRoutingHint,
  type CapturePromptBundleFormat,
} from "@meanthis/hub-core";
import {
  DISCLOSURE_MODE_KEY,
  readDisclosureMode,
  type OriginCaptureRecord,
} from "./capture-store";
import {
  createFirstCaptureDisclosureStore,
  type FirstCaptureDisclosureStore,
} from "./first-capture-disclosure";
import {
  isLocalBridgeSnapshot,
  type LocalBridgeApprovalMode,
  type LocalBridgeActivityV1,
  type LocalBridgeObservationsV1,
  type LocalBridgePageV1,
  type UIAttachmentDisclosureMode,
} from "@meanthis/schema";
import {
  UI_ATTACH_ACTIVE_ORIGIN_CHANGED,
  UI_ATTACH_ELEMENT_SELECTION_UPDATED,
  UI_ATTACH_OVERLAY_PREVIEW,
  UI_ATTACH_OVERLAY_REBIND_STATUS_GET,
  UI_ATTACH_OVERLAY_RELATION_PREVIEW,
  UI_ATTACH_PANEL_LIFECYCLE_PORT_PREFIX,
  UI_ATTACH_SESSION_UPDATED,
  isCaptureFailedMessage,
  isOverlayRebindStatusResponse,
  type ActivePageContext,
  type ActiveSessionCommandData,
  type FrameScopeDescriptor,
  type FrameScopeListData,
  type OverlayRebindStatus,
  type OverlayRebindStatusData,
  type SavedSessionRouteResolutionData,
  type SessionCommand,
  type SessionCommandResponse,
} from "./messages";
import {
  createPanelSessionController,
  type PanelSessionClient,
  type PanelSessionController,
  type PanelSessionSnapshot,
} from "./panel-session-controller";
import {
  createSessionExportFilename,
  EXTENSION_SAVED_SNAPSHOT_MAX_BUNDLE_JSON_BYTES,
  EXTENSION_SAVED_SNAPSHOT_MAX_MARKDOWN_BYTES,
  serializeSavedSnapshotPromptBundleJson,
  type StoredSessionHandoffData,
  type StoredSessionReviewData,
  type StoredSessionRouteData,
} from "./session-file";
import {
  derivePanelCopyScope,
  derivePanelSessionPreview,
  findPanelSessionItem,
  groupPanelSessionRows,
  isCurrentPageRecord,
  requiresSourceExportConfirmation,
  summarizePanelSessionRows,
  summarizeSourceModes,
  type PanelCopyScope,
} from "./panel-session-model";
import {
  buildPanelAgentCopy,
  buildPanelBridgeAgentCopy,
  buildPanelBridgeCapture,
  composePanelMarkdown,
  formatCaptureFailureStatus,
  formatCaptureBoundaryView,
  formatCaptureMetadata,
  formatCurrentTargetStatus,
  formatElementSelectionFailureStatus,
  formatPanelActionFailureStatus,
  formatPanelStatus,
  formatSelectionStoppedStatus,
  summarizeElement,
  summarizeLocator,
} from "./panel-model";
import {
  buildPanelRelationIntent,
  buildPanelRelationModel,
  isPanelRelationAction,
  type PanelRelationAction,
  type PanelRelationModel,
} from "./panel-relation-task";
import type { ActiveSessionReadback, StoredOriginSessionSummary } from "./session-store";
import {
  type LocalAgentBridgeClient,
  type LocalAgentBridgeStatus,
} from "./local-agent-bridge";
import {
  createUiAttachI18n,
  localizeDocument,
  type UiAttachI18n,
  type UiAttachTranslate,
} from "./i18n";
import {
  applyPanelThemePreference,
  PANEL_THEME_KEY,
  readPanelThemePreference,
  type PanelThemePreference,
} from "./panel-theme";
import {
  readPanelHandoffFormatPreferences,
  savePanelHandoffFormatPreference,
  type PanelHandoffFormatPreferences,
  type PanelHandoffFormatScope,
} from "./panel-handoff-format";
import {
  acquireFrameScopePermission,
  createFrameScopeSelectionController,
  FrameScopeAccessError,
  readFrameScopes,
  type FrameScopeSelectionTarget,
} from "./frame-scope-access";
import {
  createAutomaticPageAccessController,
  type AutomaticPageAccessController,
} from "./automatic-page-access";
import type { ExtensionSurfaceProfile } from "./surface-profile";
import {
  INDEPENDENT_VIEW_MODE_KEY,
  FRAME_SCOPE_AUTO_START_KEY,
  PREVIEW_COPY_MODE_KEY,
  RELATION_SHORTCUTS_KEY,
  TIME_DISPLAY_PREFERENCE_KEY,
  formatDisplayTime,
  readPreviewCopyPreference,
  readFrameScopeAutoStart,
  readRelationShortcuts,
  readTimeDisplayPreference,
  UI_ATTACH_SETTINGS_UPDATED,
  type PreviewCopyPreference,
  type RelationShortcutPreference,
  type TimeDisplayPreference,
} from "./settings-preferences";

const SAFE_PANEL_ERROR = "Panel action failed. Try again.";
const PANEL_BOOTSTRAP_ATTEMPTS = 5;
const PANEL_BOOTSTRAP_RETRY_DELAY_MS = 100;
const DEFAULT_MULTI_TARGET_HANDOFF_FORMAT: CapturePromptBundleFormat = "compact";
const SAVED_ATTACHMENT_ID = /^att_[A-Za-z0-9_-]{1,252}$/u;
const SAVED_ATTACHMENT_REF_KEYS = [
  "accessibleName",
  "id",
  "label",
  "primaryLocator",
  "role",
  "target",
  "text",
] as const;

type PageAccessRecoveryKind = "permission" | "content";
type PageAccessAutomaticFeedback = "denied" | "failed" | "not_ready" | null;
type CurrentRebindObservation = OverlayRebindStatusData & { documentId?: string };
type DirtyIntentIdentity = Readonly<{
  origin: string;
  epoch: string;
  itemId: string;
  intent: string;
}>;

export interface PanelDependencies {
  controller: PanelSessionController;
  firstCaptureDisclosure: FirstCaptureDisclosureStore;
  clipboard: { writeText(value: string): Promise<void> };
  confirm(message: string): boolean;
  randomUUID(): string;
  createObjectURL(blob: Blob): string;
  revokeObjectURL(url: string): void;
  setTimeout(callback: () => void, delay: number): number;
  setInterval?(callback: () => void, delay: number): number;
  openOptionsPage?(): Promise<void>;
  openSavedRoute?(route: string): Promise<void>;
  automaticPageAccess?: AutomaticPageAccessController;
  i18n?: UiAttachI18n;
  surfaceProfile?: ExtensionSurfaceProfile;
  localBridge?: LocalAgentBridgeClient;
  syncOverlays?(origin: string, activeItemId: string | null): Promise<void>;
  previewOverlay?(origin: string, itemId: string | null): Promise<void>;
  previewRelationOverlay?(
    origin: string,
    sourceItemId: string,
    referenceItemId: string,
  ): Promise<void>;
  frameScopes?: {
    list(): Promise<FrameScopeListData>;
    select(target: FrameScopeSelectionTarget, startSelection: boolean): Promise<boolean>;
  };
  currentRebind?: {
    read(activePage: ActivePageContext): Promise<CurrentRebindObservation | null>;
  };
  captureComparison?: CaptureObservationReader;
  storedSessions?: {
    list(): Promise<SessionCommandResponse<StoredOriginSessionSummary[]>>;
    review(origin: string): Promise<SessionCommandResponse<StoredSessionReviewData>>;
    restoreRoute?(
      route: StoredSessionRouteData,
    ): Promise<SessionCommandResponse<OverlayRebindStatusData>>;
    prepareHandoff?(
      origin: string,
      epoch: string,
    ): Promise<SessionCommandResponse<StoredSessionHandoffData>>;
    clear(
      origin: string,
      epoch: string | null,
      operationId: string,
    ): Promise<SessionCommandResponse<ActiveSessionReadback>>;
    clearAll(): Promise<SessionCommandResponse<{ clearedOrigins: string[] }>>;
  };
}

interface PanelRuntimeDependencies extends PanelDependencies {
  captureMode?: {
    read(): Promise<UIAttachmentDisclosureMode>;
  };
  themePreference?: {
    read(): Promise<PanelThemePreference>;
  };
  previewCopy?: {
    read(): Promise<PreviewCopyPreference>;
  };
  timeDisplay?: {
    read(): Promise<TimeDisplayPreference>;
  };
  relationShortcuts?: {
    read(): Promise<RelationShortcutPreference[]>;
  };
  frameScopeAutoStart?: {
    read(): Promise<boolean>;
  };
  handoffFormatPreferences?: {
    read(): Promise<PanelHandoffFormatPreferences>;
    save(scope: PanelHandoffFormatScope, format: CapturePromptBundleFormat): Promise<void>;
  };
  elementSelection?: {
    read(): Promise<boolean>;
    save(enabled: boolean): Promise<void>;
  };
  addRuntimeMessageListener?(listener: (message: unknown) => void): void;
  addSettingsChangeListener?(listener: () => void): void;
  addWindowFocusListener?(listener: () => void): void;
  addWindowKeyDownListener?(listener: (event: KeyboardEvent) => void): void;
  addWindowBlurListener?(listener: () => void): void;
  addWindowPageHideListener?(listener: () => void): void;
}

export function createBrowserPanelDependencies(options: {
  localBridge?: LocalAgentBridgeClient;
  surfaceProfile?: ExtensionSurfaceProfile;
} = {}): PanelDependencies {
  const client = createRuntimeSessionClient();
  const frameScopeSelection = createFrameScopeSelectionController({
    permissions: chrome.permissions,
    selectTarget: async (target, startSelection) => {
      const response = await sendSessionCommand<{ enabled: boolean }>({
        type: "ui-attach:frame-scope-select",
        tabId: target.tabId,
        frameId: target.frameId,
        documentId: target.documentId,
        origin: target.origin,
        pathname: target.pathname,
        startSelection,
      });
      if (!response.ok) throw new FrameScopeAccessError(response.code);
      if (!isElementSelectionData(response.data) || response.data.enabled !== startSelection) {
        throw new FrameScopeAccessError("INVALID_SESSION_RESPONSE");
      }
      return response.data.enabled;
    },
    stopSelection: async () => {
      const response = await sendSessionCommand<{ enabled: boolean }>({
        type: "ui-attach:element-selection-set",
        enabled: false,
      });
      if (!response.ok) throw new FrameScopeAccessError(response.code);
      if (!isElementSelectionData(response.data) || response.data.enabled) {
        throw new FrameScopeAccessError("INVALID_SESSION_RESPONSE");
      }
      return false;
    },
  });
  maintainPanelOverlayVisibilityLease();
  window.addEventListener("pagehide", () => {
    void frameScopeSelection.releasePermission().catch(() => undefined);
  }, { once: true });
  return {
    controller: createPanelSessionController({
      client,
      setTimeout: (callback, delay) => window.setTimeout(callback, delay),
      clearTimeout: (id) => window.clearTimeout(id as number),
    }),
    firstCaptureDisclosure: {
      isAcknowledged: () => createFirstCaptureDisclosureStore({
        storage: chrome.storage.local,
      }).isAcknowledged(),
      acknowledge: () => createFirstCaptureDisclosureStore({
        storage: chrome.storage.local,
      }).acknowledge(),
    },
    clipboard: navigator.clipboard,
    confirm: (message) => window.confirm(message),
    randomUUID: () => crypto.randomUUID(),
    createObjectURL: (blob) => URL.createObjectURL(blob),
    revokeObjectURL: (url) => URL.revokeObjectURL(url),
    setTimeout: (callback, delay) => window.setTimeout(callback, delay),
    setInterval: (callback, delay) => window.setInterval(callback, delay),
    openOptionsPage: () => chrome.runtime.openOptionsPage(),
    openSavedRoute: async (route) => {
      await chrome.tabs.create({ url: route, active: true });
    },
    automaticPageAccess: createAutomaticPageAccessController(chrome),
    i18n: createUiAttachI18n(chrome.i18n),
    surfaceProfile: options.surfaceProfile ?? "development",
    localBridge: options.localBridge,
    syncOverlays: async (origin, activeItemId) => {
      const result = await sendSessionCommand<null>({
        type: "ui-attach:overlays-sync",
        origin,
        activeItemId,
      });
      if (!result.ok) throw new Error(result.error);
    },
    previewOverlay: async (origin, itemId) => {
      const result = await sendSessionCommand<null>({
        type: UI_ATTACH_OVERLAY_PREVIEW,
        origin,
        itemId,
      });
      if (!result.ok) throw new Error(result.error);
    },
    previewRelationOverlay: async (origin, sourceItemId, referenceItemId) => {
      const result = await sendSessionCommand<null>({
        type: UI_ATTACH_OVERLAY_RELATION_PREVIEW,
        origin,
        sourceItemId,
        referenceItemId,
      });
      if (!result.ok) throw new Error(result.error);
    },
    captureMode: {
      read: () => readDisclosureMode(chrome.storage.local),
    },
    themePreference: {
      read: () => readPanelThemePreference(chrome.storage.local),
    },
    previewCopy: {
      read: () => readPreviewCopyPreference(chrome.storage.local),
    },
    timeDisplay: {
      read: () => readTimeDisplayPreference(chrome.storage.local),
    },
    frameScopeAutoStart: {
      read: () => readFrameScopeAutoStart(chrome.storage.local),
    },
    relationShortcuts: {
      read: () => readRelationShortcuts(chrome.storage.local),
    },
    handoffFormatPreferences: {
      read: () => readPanelHandoffFormatPreferences(chrome.storage.local),
      save: (scope, format) => savePanelHandoffFormatPreference(
        chrome.storage.local,
        scope,
        format,
      ),
    },
    elementSelection: {
      read: async () => {
        const enabled = await readElementSelectionEnabled();
        if (!enabled) await frameScopeSelection.releasePermission();
        return enabled;
      },
      save: async (enabled) => {
        try {
          if (!enabled) {
            await frameScopeSelection.stop();
            return;
          }
          const scopes = await readFrameScopes((command) => sendSessionCommand<unknown>(command));
          const current = scopes.scopes.find((scope) => scope.frameId === scopes.currentFrameId);
          if (!current?.selectable) throw new FrameScopeAccessError("FRAME_UNAVAILABLE");
          await frameScopeSelection.select({
            tabId: scopes.tabId,
            frameId: current.frameId,
            documentId: current.documentId,
            origin: current.origin,
            pathname: current.pathname,
            requiresHostPermission: current.requiresHostPermission,
          }, true);
        } catch (error) {
          throw new Error(formatElementSelectionFailureStatus(
            error instanceof FrameScopeAccessError ? error.code : "FRAME_SCOPE_UNAVAILABLE",
          ));
        }
      },
    },
    frameScopes: {
      list: () => readFrameScopes((command) => sendSessionCommand<unknown>(command)),
      select: (target, startSelection) => frameScopeSelection.select(target, startSelection),
    },
    captureComparison: createBrowserCaptureObservationReader(chrome),
    currentRebind: {
      read: async (activePage) => {
        try {
          const frame = await chrome.webNavigation.getFrame({
            tabId: activePage.tabId,
            frameId: activePage.frameId,
          });
          if (typeof frame?.documentId !== "string" || frame.documentId.length === 0) return null;
          const frameUrl = new URL(frame.url);
          if (frameUrl.origin !== activePage.origin || frameUrl.pathname !== activePage.pathname) {
            return null;
          }
          const response = await chrome.tabs.sendMessage(
            activePage.tabId,
            { type: UI_ATTACH_OVERLAY_REBIND_STATUS_GET },
            {
              frameId: activePage.frameId,
              documentId: frame.documentId,
            },
          );
          if (!isOverlayRebindStatusResponse(response)) return null;
          return response.data.origin === activePage.origin &&
              response.data.pathname === activePage.pathname
            ? { ...response.data, documentId: frame.documentId }
            : null;
        } catch {
          return null;
        }
      },
    },
    storedSessions: {
      list: () => sendSessionCommand<StoredOriginSessionSummary[]>({
        type: "ui-attach:session-list-stored",
      }),
      review: (origin) => sendSessionCommand<StoredSessionReviewData>({
        type: "ui-attach:session-review-stored",
        origin,
      }),
      restoreRoute: async (route) => {
        type PermissionLease = Awaited<ReturnType<typeof acquireFrameScopePermission>>;
        const capturedTopOrigin = route.frameChain?.[0]?.origin ?? route.topPage?.origin ?? null;
        const permissionPreflight = route.frameKind === "embedded" &&
            (capturedTopOrigin === null || capturedTopOrigin !== route.origin)
          ? acquireFrameScopePermission(chrome.permissions, route.origin).then(
              (lease): { ok: true; lease: PermissionLease } => ({ ok: true, lease }),
              (error): { ok: false; error: unknown } => ({ ok: false, error }),
            )
          : null;
        let resolution: SessionCommandResponse<SavedSessionRouteResolutionData>;
        try {
          resolution = await sendSessionCommand<SavedSessionRouteResolutionData>({
            type: "ui-attach:saved-session-resolve-route",
            origin: route.origin,
            pathname: route.pathname,
            frameKind: route.frameKind,
            ...(route.frameChain ? { routeChain: route.frameChain } : {}),
          });
        } catch {
          resolution = { ok: false, code: "CAPTURE_FAILED", error: SAFE_PANEL_ERROR };
        }
        const preparedPermission = permissionPreflight ? await permissionPreflight : null;
        if (!resolution.ok) {
          if (preparedPermission?.ok) {
            try {
              await preparedPermission.lease.release();
            } catch {
              return {
                ok: false,
                code: "FRAME_PERMISSION_CLEANUP_FAILED",
                error: SAFE_PANEL_ERROR,
              };
            }
          }
          return resolution;
        }
        let permissionLease: Awaited<ReturnType<typeof acquireFrameScopePermission>> | null = null;
        try {
          if (resolution.data.requiresHostPermission) {
            if (preparedPermission && !preparedPermission.ok) throw preparedPermission.error;
            permissionLease = preparedPermission?.ok
              ? preparedPermission.lease
              : await acquireFrameScopePermission(chrome.permissions, route.origin);
          } else if (preparedPermission?.ok) {
            await preparedPermission.lease.release();
          }
        } catch (error) {
          return {
            ok: false,
            code: error instanceof FrameScopeAccessError
              ? error.code
              : "FRAME_PERMISSION_UNAVAILABLE",
            error: SAFE_PANEL_ERROR,
          };
        }
        let response: SessionCommandResponse<OverlayRebindStatusData>;
        try {
          response = await sendSessionCommand<OverlayRebindStatusData>({
            type: "ui-attach:saved-session-restore-route",
            origin: route.origin,
            pathname: route.pathname,
            frameKind: route.frameKind,
            ...(route.frameChain ? { routeChain: route.frameChain } : {}),
          });
        } catch {
          response = { ok: false, code: "CAPTURE_FAILED", error: SAFE_PANEL_ERROR };
        }
        if (permissionLease) {
          try {
            await permissionLease.release();
          } catch {
            return {
              ok: false,
              code: "FRAME_PERMISSION_CLEANUP_FAILED",
              error: SAFE_PANEL_ERROR,
            };
          }
        }
        return response;
      },
      prepareHandoff: (origin, epoch) => sendSessionCommand<StoredSessionHandoffData>({
        type: "ui-attach:session-prepare-snapshot-handoff",
        origin,
        epoch,
      }),
      clear: (origin, epoch, operationId) => sendSessionCommand<ActiveSessionReadback>({
        type: "ui-attach:session-clear-stored-origin",
        origin,
        epoch,
        operationId,
      }),
      clearAll: () => sendSessionCommand<{ clearedOrigins: string[] }>({
        type: "ui-attach:session-clear-all-stored",
      }),
    },
    addRuntimeMessageListener(listener) {
      chrome.runtime.onMessage.addListener((message) => {
        listener(message);
        return false;
      });
    },
    addSettingsChangeListener(listener) {
      chrome.storage.onChanged.addListener((changes, areaName) => {
        if (areaName !== "local") return;
        if ([
          DISCLOSURE_MODE_KEY,
          PANEL_THEME_KEY,
          INDEPENDENT_VIEW_MODE_KEY,
          PREVIEW_COPY_MODE_KEY,
          FRAME_SCOPE_AUTO_START_KEY,
          TIME_DISPLAY_PREFERENCE_KEY,
          RELATION_SHORTCUTS_KEY,
        ].some((key) => key in changes)) listener();
      });
    },
    addWindowFocusListener(listener) {
      window.addEventListener("focus", listener);
    },
    addWindowKeyDownListener(listener) {
      window.addEventListener("keydown", listener, { capture: true });
    },
    addWindowBlurListener(listener) {
      window.addEventListener("blur", listener);
    },
    addWindowPageHideListener(listener) {
      window.addEventListener("pagehide", listener);
    },
  } as PanelRuntimeDependencies;
}

function maintainPanelOverlayVisibilityLease(): void {
  void (async () => {
    try {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (
        typeof tab?.windowId !== "number" ||
        !Number.isInteger(tab.windowId) ||
        tab.windowId < 0
      ) return;
      const portName = `${UI_ATTACH_PANEL_LIFECYCLE_PORT_PREFIX}:${tab.windowId}`;
      let activePort: ReturnType<typeof chrome.runtime.connect> | null = null;
      let panelClosing = false;
      window.addEventListener("pagehide", () => {
        panelClosing = true;
        activePort?.disconnect();
        activePort = null;
      }, { once: true });
      const connect = (): void => {
        try {
          const port = chrome.runtime.connect({ name: portName });
          activePort = port;
          port.onDisconnect.addListener(() => {
            if (activePort === port) activePort = null;
            if (panelClosing) return;
            window.setTimeout(connect, PANEL_BOOTSTRAP_RETRY_DELAY_MS);
          });
        } catch {
          // The panel may be unloading or the extension may be reloading.
        }
      };
      connect();
    } catch {
      // Marker visibility remains hidden if the panel window cannot be resolved.
    }
  })();
}

export async function initializePanel(options: PanelDependencies): Promise<void> {
  const deps = options as PanelRuntimeDependencies;
  const i18n = options.i18n ?? createUiAttachI18n();
  const t = i18n.t;
  const surfaceProfile = deps.surfaceProfile ?? "development";
  localizeDocument(document, i18n);
  applyPanelSurfaceProfile(document, surfaceProfile);
  const elements = queryPanelElements();
  elements.elementSelectionToggle.disabled = true;
  let latestSnapshot = options.controller.getSnapshot();
  const captureComparison = deps.captureComparison ? createPanelCaptureComparison({
    anchor: elements.selectedTargetDetails,
    read: deps.captureComparison,
    clipboard: deps.clipboard,
    t,
  }) : null;
  let currentRecord: OriginCaptureRecord | null = null;
  let currentMarkdown = "";
  let currentSummary = "";
  let agentHandoffCopyFeedbackFor: string | null = null;
  let preferredSingleTargetHandoffFormat: CapturePromptBundleFormat = "exact";
  let preferredMultiTargetHandoffFormat = DEFAULT_MULTI_TARGET_HANDOFF_FORMAT;
  let persistedSingleTargetHandoffFormat: CapturePromptBundleFormat = "exact";
  let persistedMultiTargetHandoffFormat = DEFAULT_MULTI_TARGET_HANDOFF_FORMAT;
  const handoffFormatPreferenceRevisions: Record<PanelHandoffFormatScope, number> = {
    single: 0,
    multi: 0,
  };
  const handoffFormatPreferenceWriteQueues: Record<PanelHandoffFormatScope, Promise<void>> = {
    single: Promise.resolve(),
    multi: Promise.resolve(),
  };
  let handoffFormat: CapturePromptBundleFormat = preferredMultiTargetHandoffFormat;
  let handoffAttachmentCount = 0;
  let handoffTaskCount = 0;
  let bootstrapFailed = false;
  let lastOverlaySyncKey = "";
  let pendingOverlaySyncKey: string | null = null;
  let overlaySyncRevision = 0;
  let relationModel: PanelRelationModel | null = null;
  let generatedRelationIntent: {
    intent: string;
    origin: string;
    epoch: string;
    selectedItemId: string;
  } | null = null;
  let relationApplyFeedback: {
    sourceItemId: string;
    referenceItemId: string;
  } | null = null;
  let hoveredPreviewItemId: string | null = null;
  let focusedPreviewItemId: string | null = null;
  let relationPreviewItemId: string | null = null;
  let hoveredRelationAction: HTMLButtonElement | null = null;
  let focusedRelationAction: HTMLButtonElement | null = null;
  let previewedOverlayKey: string | null = null;
  let previewedOverlayOrigin: string | null = null;
  let activeOriginMessageRevision = 0;
  let elementSelectionRevision = 0;
  let elementSelectionEnabled = false;
  let selectionStoppedStatusKey: string | null = null;
  let selectionStopPending = false;
  let frameScopeData: FrameScopeListData | null = null;
  let frameScopeRefreshRevision = 0;
  let frameScopeActivationPending = false;
  let frameScopeAutoStart = false;
  let firstCaptureDisclosureAcknowledged = false;
  let pageAccessRecoveryStatus: string | null = null;
  let pageAccessRecoveryKind: PageAccessRecoveryKind | null = null;
  let pageAccessAutomaticPending = false;
  let pageAccessAutomaticFeedback: PageAccessAutomaticFeedback = null;
  let currentRebindRequestRevision = 0;
  let currentRebindRequestInFlight: { revision: number; pageKey: string } | null = null;
  let currentRebindPageKey: string | null = null;
  let currentRebindStateKey = "";
  let currentRebindObservedAt: string | null = null;
  let currentRebindDocumentId: string | null = null;
  let currentRebindUnavailable = false;
  let currentRebindStatuses = new Map<string, OverlayRebindStatus>();
  let workspaceRestoreNotice: { pageKey: string; message: string } | null = null;
  let captureMode: UIAttachmentDisclosureMode = "agent_safe";
  let previewCopyPreference: PreviewCopyPreference = {
    independent: false,
    mode: "agent_safe",
  };
  let themePreference: PanelThemePreference = "system";
  let timeDisplayPreference: TimeDisplayPreference = "local";
  let relationShortcuts: RelationShortcutPreference[] = [];
  let localBridgePublish = Promise.resolve();
  let localBridgePublishInFlight = false;
  let pendingLocalBridgeSnapshot: PanelSessionSnapshot | null = null;
  let localBridgeObservationPublishAttempts = 0;
  let localBridgeObservationPublishSettled = 0;
  let localBridgeIntentEditActive = false;
  let localBridgeRequestBusy = false;
  let localBridgeActivity: LocalBridgeActivityV1 | null = null;
  let localBridgeStatus: LocalAgentBridgeStatus = disconnectedLocalBridgeStatus();
  let localBridgeShareState:
    | "idle"
    | "shared"
    | "unavailable"
    | "publish_failed"
    | "clear_failed" = "idle";
  let localBridgeRefresh = Promise.resolve();
  const localBridgeRefreshInFlight = new Map<"connection" | "heartbeat", Promise<void>>();
  let storedSessionSummaries: StoredOriginSessionSummary[] = [];
  let storedSessionReview: StoredSessionReviewData | null = null;
  let storedSessionHandoff: StoredSessionHandoffData | null = null;
  let storedSessionMachineDisclosureOpen = false;
  let storedSessionsRevision = 0;
  let storedSessionRestoreRevision = 0;
  let storedSessionsBusy = false;
  let storedSessionsRenderSignature: string | null = null;
  let sessionGroupContext: string | null = null;
  let sessionGroupSelectedItemId: string | null = null;
  const sessionGroupOpenStates = new Map<string, boolean>();

  options.controller.subscribe((snapshot) => {
    latestSnapshot = snapshot;
    syncCurrentRebindPage(snapshot.activePage);
    if (generatedRelationIntent && !isCurrentGeneratedRelation(snapshot)) {
      generatedRelationIntent = null;
    }
    if (bootstrapFailed) return;
    renderSnapshot(snapshot);
    if (storedSessionReview) renderStoredSessions();
    requestOverlaySync(snapshot);
    requestCurrentRebindStatus(snapshot);
    requestLocalBridgePublish(snapshot);
  });

  wireControls();
  try {
    await initializeLocalSettings();
    await retryBootstrapRead(async () => {
      await options.controller.initialize();
      const status = options.controller.getSnapshot().status;
      if (status.kind === "error" && status.message === SAFE_PANEL_ERROR) {
        throw new Error(SAFE_PANEL_ERROR);
      }
    });
    await refreshFrameScopes();
    await refreshStoredSessions();
    if (deps.localBridge) {
      await initializeLocalBridge();
    }
    if (deps.currentRebind) {
      deps.setInterval?.(() => requestCurrentRebindStatus(latestSnapshot), 1_000);
    }
    if (deps.localBridge) {
      deps.setInterval?.(() => requestLocalBridgeRefresh(), 1_000);
      deps.setInterval?.(() => requestLocalBridgeHeartbeat(), 10_000);
    }
    elements.elementSelectionToggle.disabled = pageAccessRecoveryStatus !== null;
  } catch {
    bootstrapFailed = true;
    disableInteractiveControls();
    elements.status.textContent = t("panel_action_failed");
  }

  function wireControls(): void {
    elements.pageAccessEnableAutomatic.addEventListener("click", () => {
      requestAutomaticPageAccess();
    });
    elements.localBridgeApprovalMode.addEventListener("change", () => {
      renderLocalBridgeTrustHelp();
    });
    elements.localBridgeRequest.addEventListener("click", () => {
      void runLocalBridgeAction(async () => {
        if (!deps.localBridge) return;
        if (!localBridgeStatus.pending) {
          localBridgeStatus = await deps.localBridge.createConnectionRequest(
            parseLocalBridgeApprovalMode(elements.localBridgeApprovalMode.value),
          );
        }
        renderLocalBridgeStatus(localBridgeStatus);
        await requestLocalBridgePublish(latestSnapshot);
        if (localBridgeStatus.requestText) {
          try {
            await options.clipboard.writeText(localBridgeStatus.requestText);
            elements.localBridgeDetails.open = false;
            elements.localBridgeStatus.textContent =
              t("request_copied");
          } catch {
            elements.localBridgeDetails.open = true;
            elements.localBridgeStatus.textContent =
              t("request_ready");
          }
        }
      }, true);
    });

    elements.localBridgeDisconnect.addEventListener("click", () => {
      void runLocalBridgeAction(async () => {
        elements.localBridgeStatus.dataset.disconnectState = "requested";
        await deps.localBridge?.disconnect();
        elements.localBridgeStatus.dataset.disconnectState = "acknowledged";
        localBridgeStatus = disconnectedLocalBridgeStatus();
        renderLocalBridgeStatus(localBridgeStatus);
      });
    });

    elements.intent.addEventListener("input", () => {
      if (elements.intent.disabled) return;
      generatedRelationIntent = null;
      clearRelationApplyFeedback();
      markLocalBridgeIntentEditing();
      options.controller.setIntent(elements.intent.value);
      updatePromptMarkdown();
    });
    elements.intent.addEventListener("blur", () => {
      void runPanelAction(async () => {
        await options.controller.flushIntent();
        finishLocalBridgeIntentEditing();
      });
    });

    elements.removeSelectedItem.addEventListener("click", () => {
      const itemId = latestSnapshot.selectedItemId;
      if (elements.removeSelectedItem.disabled || !itemId) return;
      void runPanelAction(() => removeItem(itemId));
    });

    elements.relationReference.addEventListener("change", () => {
      clearRelationApplyFeedback();
      renderRelationRoleSummary(latestSnapshot);
      updateFocusedRelationPreview(elements.relationReference);
    });
    wireRelationPreview(elements.relationReference);
    wireRelationActionPreview(elements.applyRelation);
    elements.applyRelation.addEventListener("click", () => {
      const action = parseRelationShortcutValue(elements.relationAction.value);
      if (
        !relationModel ||
        elements.applyRelation.disabled ||
        action === null
      ) {
        return;
      }
      const result = buildPanelRelationIntent(
        relationModel,
        latestSnapshot.selectedItemId ?? "",
        action,
        elements.relationReference.value,
        t,
      );
      if (!result.ok) {
        elements.status.textContent = result.error;
        return;
      }
      generatedRelationIntent = null;
      if (
        latestSnapshot.origin
        && latestSnapshot.epoch
        && latestSnapshot.selectedItemId
      ) {
        generatedRelationIntent = {
          intent: result.intent,
          origin: latestSnapshot.origin,
          epoch: latestSnapshot.epoch,
          selectedItemId: latestSnapshot.selectedItemId,
        };
      }
      relationApplyFeedback = {
        sourceItemId: latestSnapshot.selectedItemId ?? "",
        referenceItemId: elements.relationReference.value,
      };
      elements.intent.value = result.intent;
      options.controller.setIntent(result.intent);
      updatePromptMarkdown();
      renderRelationRoleSummary(latestSnapshot);
      elements.intent.focus();
    });
    elements.changeGeneratedRelation.addEventListener("click", () => {
      const generated = generatedRelationIntent;
      if (
        elements.changeGeneratedRelation.disabled ||
        !generated ||
        !isCurrentGeneratedRelation(latestSnapshot) ||
        elements.intent.value !== generated.intent
      ) {
        return;
      }
      generatedRelationIntent = null;
      clearRelationApplyFeedback();
      elements.intent.value = "";
      options.controller.setIntent("");
      updatePromptMarkdown();
      if (elements.relationAction.disabled) elements.intent.focus();
      else elements.relationAction.focus();
    });

    elements.copyMarkdown.addEventListener("click", () => {
      void runPanelAction(() => copyText(elements.markdown.value, t("copied_markdown")));
    });

    elements.copyJson.addEventListener("click", () => {
      void runPanelAction(() => copyText(elements.json.value, t("copied_json")));
    });

    elements.copySummary.addEventListener("click", () => {
      const result = updateAgentHandoffPreview();
      if (!result) return;
      if (!result.ok) {
        elements.status.textContent = formatPanelStatus("failed", result.error, t);
        return;
      }
      const attemptedHandoff = result.text;
      clearAgentHandoffCopyStatus();
      void runPanelAction(() =>
        copyAgentHandoff(
          attemptedHandoff,
          result.attachmentCount === 1
            ? t("copied_agent_context")
            : t("copied_elements_for_agent", { count: result.attachmentCount }),
          handoffTaskCount === 0
            ? t("agent_handoff_context_only_next_step")
            : t("agent_handoff_copy_next_step"),
        ),
      );
    });

    elements.handoffFormat.addEventListener("change", () => {
      const nextFormat = parseCapturePromptBundleFormat(elements.handoffFormat.value);
      const scope = handoffAttachmentCount > 1 ? "multi" : "single";
      void runPanelAction(() => updateHandoffFormatPreference(scope, nextFormat));
    });

    elements.elementSelectionToggle.addEventListener("click", () => {
      const enabled = elements.elementSelectionToggle.getAttribute("aria-pressed") !== "true";
      void runPanelAction(() => requestElementSelectionSetting(enabled));
    });

    elements.reviewDataDisclosure.addEventListener("click", () => {
      openFirstCaptureDisclosure();
    });

    elements.acknowledgeFirstCapture.addEventListener("click", () => {
      void acknowledgeFirstCaptureDisclosure();
    });

    elements.dismissFirstCapture.addEventListener("click", () => {
      closeFirstCaptureDisclosure();
    });

    elements.captureScopeTree.addEventListener("click", (event) => {
      const target = event.target;
      if (!(target instanceof Element)) return;
      const button = target.closest<HTMLButtonElement>("[data-frame-scope-id]");
      const frameId = Number(button?.dataset.frameScopeId);
      if (!button || button.disabled || !Number.isInteger(frameId)) return;
      const scope = frameScopeData?.scopes.find((candidate) => candidate.frameId === frameId);
      if (!scope) return;
      void runPanelAction(() => requestFrameScopeSelection(scope));
    });

    document.addEventListener("click", (event) => {
      const target = event.target;
      if (
        elements.captureScope.open &&
        target instanceof Node &&
        !elements.captureScope.contains(target)
      ) {
        elements.captureScope.open = false;
      }
    });

    elements.openSettings.addEventListener("click", () => {
      void runPanelAction(async () => {
        await options.openOptionsPage?.();
      });
    });

    elements.clearSession.addEventListener("click", () => {
      void runPanelAction(() => clearSession());
    });

    elements.savedSitesList.addEventListener("click", (event) => {
      const target = event.target;
      if (!(target instanceof Element)) return;
      const machineSummary = target.closest<HTMLElement>(".saved-handoff-machine > summary");
      if (machineSummary) {
        const machine = machineSummary.closest<HTMLDetailsElement>(".saved-handoff-machine");
        storedSessionMachineDisclosureOpen = machine?.open !== true;
        return;
      }
      const closeReview = target.closest<HTMLButtonElement>("[data-close-saved-review]");
      if (closeReview && !closeReview.disabled) {
        const reviewedOrigin = storedSessionReview?.origin ?? null;
        storedSessionReview = null;
        storedSessionHandoff = null;
        storedSessionMachineDisclosureOpen = false;
        elements.savedSitesStatus.textContent = "";
        renderStoredSessions();
        if (reviewedOrigin) {
          Array.from(
            elements.savedSitesList.querySelectorAll<HTMLButtonElement>("[data-review-saved-origin]"),
          ).find((button) => button.dataset.reviewSavedOrigin === reviewedOrigin)?.focus();
        }
        return;
      }
      const copyHandoff = target.closest<HTMLButtonElement>("[data-copy-saved-handoff]");
      if (copyHandoff && !copyHandoff.disabled) {
        void runPanelAction(() => prepareStoredSessionHandoff("copy_markdown"));
        return;
      }
      const copyBundleJson = target.closest<HTMLButtonElement>("[data-copy-saved-bundle-json]");
      if (copyBundleJson && !copyBundleJson.disabled) {
        storedSessionMachineDisclosureOpen = true;
        void runPanelAction(() => prepareStoredSessionHandoff("copy_json"));
        return;
      }
      const restoreCurrent = target.closest<HTMLButtonElement>("[data-restore-saved-origin]");
      const restoreRouteKey = restoreCurrent?.dataset.restoreSavedRouteKey;
      const restoreRoute = storedSessionReview?.routes.find(
        (route) => storedSessionRouteKey(route) === restoreRouteKey,
      );
      if (restoreCurrent && restoreRoute && !restoreCurrent.disabled) {
        void runPanelAction(() => restoreStoredSessionRoute(restoreRoute));
        return;
      }
      const copyPageRoute = target.closest<HTMLButtonElement>("[data-copy-saved-page-route]");
      const copiedRoute = copyPageRoute?.dataset.copySavedPageRoute;
      if (copyPageRoute && copiedRoute && !copyPageRoute.disabled) {
        void runPanelAction(() => copyStoredSessionPageRoute(copiedRoute));
        return;
      }
      const openRoute = target.closest<HTMLButtonElement>("[data-open-saved-route]");
      const savedRoute = openRoute?.dataset.openSavedRoute;
      if (openRoute && savedRoute && !openRoute.disabled) {
        void runPanelAction(() => openStoredSessionRoute(savedRoute));
        return;
      }
      const reviewButton = target.closest<HTMLButtonElement>("[data-review-saved-origin]");
      const reviewOrigin = reviewButton?.dataset.reviewSavedOrigin;
      if (reviewButton && reviewOrigin && !reviewButton.disabled) {
        void runPanelAction(() => reviewStoredOrigin(reviewOrigin));
        return;
      }
      const button = target.closest<HTMLButtonElement>("[data-clear-saved-origin]");
      const origin = button?.dataset.clearSavedOrigin;
      if (!button || !origin || button.disabled) return;
      void runPanelAction(() => clearStoredOrigin(origin));
    });

    elements.clearAllSavedSites.addEventListener("click", () => {
      if (elements.clearAllSavedSites.disabled) return;
      void runPanelAction(() => clearAllStoredOrigins());
    });

    elements.exportSession.addEventListener("click", () => {
      void runPanelAction(() => exportSession());
    });

    elements.retryIntent.addEventListener("click", () => {
      void runPanelAction(() => options.controller.retryDirtyIntent());
    });

    elements.discardIntent.addEventListener("click", () => {
      void runPanelAction(() => options.controller.discardDirtyIntent());
    });

    deps.addRuntimeMessageListener?.((message) => {
      if (bootstrapFailed) return;
      if (isSettingsUpdatedMessage(message)) {
        void refreshGlobalSettings();
        return;
      }
      const refresh = parseSessionRefreshMessage(message);
      if (refresh) {
        const activeOriginRevision = refresh.activeOriginChange
          ? ++activeOriginMessageRevision
          : null;
        if (refresh.activeOriginChange) {
          renderActiveOriginAccessState(refresh.accessRequired);
        }
        if (
          !refresh.activeOriginChange &&
          refresh.origin &&
          storedSessionReview?.origin === refresh.origin
        ) {
          storedSessionRestoreRevision += 1;
          storedSessionReview = null;
          storedSessionHandoff = null;
          storedSessionMachineDisclosureOpen = false;
          elements.savedSitesStatus.textContent = t("saved_review_changed");
          renderStoredSessions();
        }
        void refreshStoredSessions();
        void runPanelAction(async () => {
          if (refresh.preferredItemId) {
            await options.controller.refreshActiveOrigin(refresh.preferredItemId);
          } else {
            await options.controller.refreshActiveOrigin();
          }
          await refreshFrameScopes();
          if (
            activeOriginRevision !== null &&
            activeOriginRevision === activeOriginMessageRevision
          ) {
            renderActiveOriginAccessState(refresh.accessRequired);
          }
        });
        return;
      }
      if (isCaptureFailedMessage(message)) {
        elements.status.textContent = formatCaptureFailureStatus(message.error, t);
        return;
      }
      if (isElementSelectionUpdatedMessage(message)) {
        const revision = ++elementSelectionRevision;
        if (!message.enabled) elements.captureScope.open = false;
        renderElementSelectionState(message.enabled);
        void (async () => {
          try {
            const observed = await (
              deps.elementSelection?.read() ?? Promise.resolve(message.enabled)
            );
            if (revision !== elementSelectionRevision) return;
            renderElementSelectionState(observed);
          } catch {
            // The authoritative notification already supplied the safest available state.
          }
        })();
      }
    });

    deps.addWindowFocusListener?.(() => {
      void refreshStoredSessions();
      void runPanelAction(async () => {
        await options.controller.refreshActiveOrigin();
        await refreshFrameScopes();
      });
    });
    deps.addWindowKeyDownListener?.((event) => {
      if (event.key === "Escape" && elements.captureScope.open) {
        event.preventDefault();
        elements.captureScope.open = false;
        elements.captureScope.querySelector<HTMLElement>("summary")?.focus();
        return;
      }
      if (
        event.key !== "Escape" ||
        !elementSelectionEnabled ||
        selectionStopPending ||
        elements.firstCaptureDisclosure.open
      ) return;
      event.preventDefault();
      selectionStopPending = true;
      void runPanelAction(async () => {
        try {
          await requestElementSelectionSetting(false);
        } finally {
          selectionStopPending = false;
        }
      });
    });
    deps.addSettingsChangeListener?.(() => {
      if (!bootstrapFailed) void refreshGlobalSettings();
    });
    deps.addWindowBlurListener?.(() => {
      elements.captureScope.open = false;
      clearOverlayPreview();
    });
    deps.addWindowPageHideListener?.(() => {
      clearOverlayPreview();
      void runPanelAction(async () => {
        await options.controller.flushIntent();
        finishLocalBridgeIntentEditing();
      });
    });
  }

  async function runPanelAction(action: () => Promise<void>): Promise<void> {
    if (bootstrapFailed) return;
    try {
      await action();
    } catch (error) {
      const statusMessage = formatPanelActionFailureStatus(error, t);
      elements.status.textContent = statusMessage;
      const accessRecovery = classifyPageAccessRecovery(error);
      if (accessRecovery) renderPageAccessRecovery(accessRecovery, statusMessage);
    }
  }

  function requestAutomaticPageAccess(): void {
    if (
      pageAccessAutomaticPending ||
      pageAccessRecoveryKind !== "permission" ||
      !deps.automaticPageAccess
    ) return;

    pageAccessAutomaticPending = true;
    pageAccessAutomaticFeedback = null;
    renderPageAccessAutomaticAction();
    const requestActiveOriginRevision = activeOriginMessageRevision;

    let request: Promise<boolean>;
    try {
      // This must remain the first async browser call in the click path so
      // Chrome associates permissions.request with the user's gesture.
      request = deps.automaticPageAccess.setEnabled(true);
    } catch {
      finishAutomaticPageAccessRequest("failed");
      return;
    }

    void request.then(async (granted) => {
      if (requestActiveOriginRevision !== activeOriginMessageRevision) {
        settleStaleAutomaticPageAccessRequest();
        return;
      }
      if (!granted) {
        finishAutomaticPageAccessRequest("denied");
        return;
      }
      try {
        await options.controller.refreshActiveOrigin();
        await refreshFrameScopes();
        if (requestActiveOriginRevision !== activeOriginMessageRevision) {
          settleStaleAutomaticPageAccessRequest();
          return;
        }
        const refreshedSnapshot = options.controller.getSnapshot();
        if (!refreshedSnapshot.activeSupported || !refreshedSnapshot.origin) {
          finishAutomaticPageAccessRequest("not_ready");
          return;
        }
        if (pageAccessRecoveryKind === "permission") {
          renderActiveOriginAccessState(false);
        }
        finishAutomaticPageAccessRequest(null);
      } catch {
        if (requestActiveOriginRevision !== activeOriginMessageRevision) {
          settleStaleAutomaticPageAccessRequest();
          return;
        }
        finishAutomaticPageAccessRequest("failed");
      }
    }, () => {
      if (requestActiveOriginRevision !== activeOriginMessageRevision) {
        settleStaleAutomaticPageAccessRequest();
        return;
      }
      finishAutomaticPageAccessRequest("failed");
    });
  }

  function settleStaleAutomaticPageAccessRequest(): void {
    pageAccessAutomaticPending = false;
    renderPageAccessAutomaticAction();
  }

  function finishAutomaticPageAccessRequest(feedback: PageAccessAutomaticFeedback): void {
    pageAccessAutomaticPending = false;
    pageAccessAutomaticFeedback = pageAccessRecoveryKind === "permission" ? feedback : null;
    renderPageAccessAutomaticAction();
  }

  async function runLocalBridgeAction(
    action: () => Promise<void>,
    announceStartup = false,
  ): Promise<void> {
    if (announceStartup) setLocalBridgeRequestBusy("preparing");
    elements.localBridgeRequest.disabled = true;
    elements.localBridgeDisconnect.disabled = true;
    elements.localBridgeApprovalMode.disabled = true;
    try {
      await action();
    } catch (error) {
      const code = isRecord(error) && typeof error.code === "string" ? error.code : null;
      if (
        (code === "BRIDGE_REPAIR_REQUIRED" || code === "BRIDGE_SETUP_REQUIRED") &&
        deps.localBridge?.repairConnection &&
        options.confirm(t(code === "BRIDGE_REPAIR_REQUIRED"
          ? "confirm_local_bridge_repair"
          : "confirm_local_bridge_setup"))
      ) {
        try {
          if (announceStartup) setLocalBridgeRequestBusy("repairing");
          await deps.localBridge.repairConnection();
          elements.localBridgeStatus.textContent = t("local_bridge_repaired_retry");
        } catch {
          elements.localBridgeStatus.textContent = t("local_bridge_start_failed");
        }
      } else {
        elements.localBridgeStatus.textContent = code === "COMPANION_UNAVAILABLE"
          ? t("local_companion_unavailable")
          : code === "BRIDGE_REPAIR_REQUIRED"
            ? t("local_bridge_repair_required")
            : code === "BRIDGE_SETUP_REQUIRED"
              ? t("local_bridge_setup_required")
            : code === "BRIDGE_ACTION_REQUIRED"
              ? t("local_bridge_action_required")
            : code === "BRIDGE_START_FAILED"
              ? t("local_bridge_start_failed")
              : t("local_connection_failed");
      }
    } finally {
      if (announceStartup) {
        localBridgeRequestBusy = false;
        elements.localBridgeRequest.setAttribute("aria-busy", "false");
        renderLocalBridgeRequestLabel(localBridgeStatus);
        renderLocalBridgeSteps(localBridgeStatus);
      }
      elements.localBridgeRequest.disabled = localBridgeStatus.connected;
      elements.localBridgeDisconnect.disabled = false;
      elements.localBridgeApprovalMode.disabled = localBridgeStatus.connected || localBridgeStatus.pending;
    }
  }

  async function initializeLocalSettings(): Promise<void> {
    try {
      firstCaptureDisclosureAcknowledged = await options.firstCaptureDisclosure.isAcknowledged();
    } catch {
      firstCaptureDisclosureAcknowledged = false;
    }
    const [
      captureMode,
      savedPreviewCopyPreference,
      elementSelectionEnabled,
      savedThemePreference,
      savedTimeDisplayPreference,
      savedRelationShortcuts,
      savedFrameScopeAutoStart,
      savedHandoffFormatPreferences,
    ] = await Promise.all([
      retryBootstrapRead(() =>
        deps.captureMode?.read() ?? Promise.resolve<UIAttachmentDisclosureMode>("agent_safe")),
      retryBootstrapRead(() => deps.previewCopy?.read() ?? Promise.resolve({
        independent: false,
        mode: "agent_safe" as const,
      })),
      retryBootstrapRead(() => deps.elementSelection?.read() ?? Promise.resolve(false)),
      retryBootstrapRead(() =>
        deps.themePreference?.read() ?? Promise.resolve<PanelThemePreference>("system")),
      retryBootstrapRead(() =>
        deps.timeDisplay?.read() ?? Promise.resolve<TimeDisplayPreference>("local")),
      retryBootstrapRead(() => deps.relationShortcuts?.read() ?? Promise.resolve([])),
      retryBootstrapRead(() => deps.frameScopeAutoStart?.read() ?? Promise.resolve(false)),
      retryBootstrapRead(() => deps.handoffFormatPreferences?.read() ?? Promise.resolve({
        singleTarget: "exact" as const,
        multiTarget: DEFAULT_MULTI_TARGET_HANDOFF_FORMAT,
      })),
    ]);
    applyGlobalSettings(
      captureMode,
      savedPreviewCopyPreference,
      savedThemePreference,
      savedTimeDisplayPreference,
      savedRelationShortcuts,
      savedFrameScopeAutoStart,
    );
    preferredSingleTargetHandoffFormat = savedHandoffFormatPreferences.singleTarget;
    preferredMultiTargetHandoffFormat = savedHandoffFormatPreferences.multiTarget;
    persistedSingleTargetHandoffFormat = savedHandoffFormatPreferences.singleTarget;
    persistedMultiTargetHandoffFormat = savedHandoffFormatPreferences.multiTarget;
    renderElementSelectionToggle(elementSelectionEnabled);
  }

  async function refreshGlobalSettings(): Promise<void> {
    try {
      const [
        savedCaptureMode,
        savedPreviewCopyPreference,
        savedThemePreference,
        savedTimeDisplayPreference,
        savedRelationShortcuts,
        savedFrameScopeAutoStart,
      ] =
        await Promise.all([
          deps.captureMode?.read() ?? Promise.resolve<UIAttachmentDisclosureMode>("agent_safe"),
          deps.previewCopy?.read() ?? Promise.resolve({
            independent: false,
            mode: "agent_safe" as const,
          }),
          deps.themePreference?.read() ?? Promise.resolve<PanelThemePreference>("system"),
          deps.timeDisplay?.read() ?? Promise.resolve<TimeDisplayPreference>("local"),
          deps.relationShortcuts?.read() ?? Promise.resolve([]),
          deps.frameScopeAutoStart?.read() ?? Promise.resolve(false),
        ]);
      applyGlobalSettings(
        savedCaptureMode,
        savedPreviewCopyPreference,
        savedThemePreference,
        savedTimeDisplayPreference,
        savedRelationShortcuts,
        savedFrameScopeAutoStart,
      );
      renderSnapshot(latestSnapshot);
      renderStoredSessions();
    } catch {
      // Keep the last verified settings if storage is temporarily unavailable.
    }
  }

  function applyGlobalSettings(
    nextCaptureMode: UIAttachmentDisclosureMode,
    nextPreviewCopyPreference: PreviewCopyPreference,
    nextThemePreference: PanelThemePreference,
    nextTimeDisplayPreference: TimeDisplayPreference,
    nextRelationShortcuts: RelationShortcutPreference[],
    nextFrameScopeAutoStart: boolean,
  ): void {
    captureMode = nextCaptureMode;
    previewCopyPreference = nextPreviewCopyPreference;
    themePreference = nextThemePreference;
    timeDisplayPreference = nextTimeDisplayPreference;
    relationShortcuts = nextRelationShortcuts;
    frameScopeAutoStart = nextFrameScopeAutoStart;
    renderRelationShortcutOptions();
    const effectiveViewMode = previewCopyPreference.independent
      ? previewCopyPreference.mode
      : captureMode;
    elements.currentContentMode.dataset.captureMode = captureMode;
    elements.currentContentMode.dataset.viewMode = effectiveViewMode;
    elements.currentContentMode.dataset.independent = String(previewCopyPreference.independent);
    options.controller.setViewMode(effectiveViewMode);
    applyPanelThemePreference(document.documentElement, themePreference);
    elements.currentContentMode.textContent = previewCopyPreference.independent
      ? t("separate_content_modes", {
          capture: formatDisclosureMode(captureMode, t),
          copy: formatDisclosureMode(effectiveViewMode, t),
        })
      : formatDisclosureMode(captureMode, t);
  }

  async function initializeLocalBridge(): Promise<void> {
    if (!deps.localBridge) {
      renderLocalBridgeStatus(localBridgeStatus);
      return;
    }
    try {
      localBridgeStatus = await deps.localBridge.readStatus();
      renderLocalBridgeStatus(localBridgeStatus);
      if (localBridgeStatus.connected || localBridgeStatus.pending) {
        await requestLocalBridgePublish(latestSnapshot);
      }
    } catch {
      elements.localBridgeStatus.textContent = t("local_status_unavailable");
      renderLocalBridgeReadAcknowledgement({
        ...localBridgeStatus,
        readAcknowledgementState: "unavailable",
      });
    }
  }

  function renderLocalBridgeStatus(status: LocalAgentBridgeStatus): void {
    elements.localBridgeStatus.dataset.sharedTargetCount =
      status.sharedTargetCount === null ? "unknown" : String(status.sharedTargetCount);
    elements.localBridgeStatus.dataset.sharedSequence =
      status.sharedSequence === null ? "unknown" : String(status.sharedSequence);
    renderLocalBridgeReadAcknowledgement(status);
    renderLocalBridgeSteps(status);
    renderLocalBridgeTrustHelp();
    elements.localBridgeApprovalMode.disabled = status.connected || status.pending;
    elements.localBridgeTrustField.hidden = status.connected;
    elements.localBridgeTrustHelp.hidden = status.connected;
    elements.localBridgeRequest.hidden = status.connected;
    renderLocalBridgeRequestLabel(status);
    elements.localBridgeDisconnect.hidden = !status.connected && !status.pending;
    elements.localBridgeDisconnect.textContent = status.pending
      ? t("cancel_request")
      : t("disconnect");
    elements.localBridgeRequestText.hidden = !status.pending || !status.requestText;
    elements.localBridgeRequestText.value = status.requestText ?? "";
    elements.localBridgeInstance.hidden = !status.connected;
    elements.localBridgeInstance.textContent = status.connected
      ? t("local_instance", { instanceId: status.instanceId ?? "" })
      : "";
    elements.localBridgeDetails.hidden = !status.pending && !status.connected;
    if (elements.localBridgeDetails.hidden) elements.localBridgeDetails.open = false;
    if (status.connected) {
      elements.localBridgeStatus.textContent = localBridgeShareState === "shared"
        ? status.sharedTargetCount !== null && status.sharedTargetCount > 0
          ? t("connected_local_targets", { count: status.sharedTargetCount })
          : t("connected_local")
        : localBridgeShareState === "unavailable"
          ? t("connected_share_unavailable")
          : localBridgeShareState === "publish_failed" || localBridgeShareState === "clear_failed"
            ? t("connected_agent_unreachable")
            : t("connected_no_selection");
    } else if (status.pending) {
      elements.localBridgeStatus.textContent = t("waiting_approval", {
        expiresAt: formatDisplayTime(status.expiresAt ?? "", timeDisplayPreference),
      });
    } else {
      elements.localBridgeStatus.textContent = t("ready_to_connect");
    }
  }

  function renderLocalBridgeReadAcknowledgement(status: LocalAgentBridgeStatus): void {
    const acknowledgementState = status.readAcknowledgementState ?? "unavailable";
    const visible = status.connected && status.sharedSequence !== null;
    elements.localBridgeReadAcknowledgementStatus.hidden = !visible;
    elements.localBridgeReadAcknowledgementLimitations.hidden = !visible;
    elements.localBridgeReadAcknowledgementStatus.dataset.state = acknowledgementState;
    elements.localBridgeReadAcknowledgementStatus.dataset.readAcknowledgementState =
      acknowledgementState;
    elements.localBridgeReadAcknowledgementStatus.dataset.sharedSequence = visible
      ? String(status.sharedSequence)
      : "unknown";
    elements.localBridgeReadAcknowledgementLimitations.dataset.state = acknowledgementState;
    elements.localBridgeReadAcknowledgementLimitations.dataset.readAcknowledgementState =
      acknowledgementState;
    elements.localBridgeReadAcknowledgementLimitations.dataset.sharedSequence = visible
      ? String(status.sharedSequence)
      : "unknown";
    elements.localBridgeReadAcknowledgementStatus.textContent = visible
      ? t(
          acknowledgementState === "current"
            ? "local_bridge_read_ack_current"
            : acknowledgementState === "waiting"
              ? "local_bridge_read_ack_waiting"
              : "local_bridge_read_ack_unavailable",
        )
      : "";
    elements.localBridgeReadAcknowledgementLimitations.textContent = visible
      ? t("local_bridge_read_ack_limitations")
      : "";
  }

  function renderLocalBridgeRequestLabel(status: LocalAgentBridgeStatus): void {
    if (localBridgeRequestBusy) return;
    elements.localBridgeRequest.textContent = status.pending
      ? t("copy_request_again")
      : t("create_copy_request");
  }

  function setLocalBridgeRequestBusy(phase: "preparing" | "repairing"): void {
    localBridgeRequestBusy = true;
    elements.localBridgeRequest.setAttribute("aria-busy", "true");
    elements.localBridgeRequest.textContent = t(
      phase === "repairing" ? "local_bridge_repairing" : "local_bridge_preparing",
    );
    elements.localBridgeStatus.textContent = t(
      phase === "repairing" ? "local_bridge_repairing_help" : "local_bridge_preparing_help",
    );
    renderLocalBridgeSteps(localBridgeStatus);
  }

  function renderLocalBridgeSteps(status: LocalAgentBridgeStatus): void {
    const states = localBridgeRequestBusy
      ? ["complete", "current", "upcoming", "upcoming"]
      : status.connected
      ? ["complete", "complete", "complete", "current"]
      : status.pending
        ? ["complete", "complete", "current", "upcoming"]
        : ["current", "upcoming", "upcoming", "upcoming"];
    elements.localBridgeSteps.forEach((step, index) => {
      const state = states[index] ?? "upcoming";
      step.dataset.state = state;
      if (state === "current") step.setAttribute("aria-current", "step");
      else step.removeAttribute("aria-current");
    });
  }

  function renderLocalBridgeTrustHelp(): void {
    elements.localBridgeTrustHelp.textContent = elements.localBridgeApprovalMode.value === "browser_session"
      ? t("bridge_trust_session_help")
      : t("bridge_trust_ask_help");
  }

  function enqueueLocalBridgeRefresh(
    kind: "connection" | "heartbeat",
    operation: () => Promise<void>,
  ): void {
    if (localBridgeRefreshInFlight.has(kind)) return;
    const run = localBridgeRefresh.then(operation, operation).catch(() => undefined);
    localBridgeRefresh = run;
    localBridgeRefreshInFlight.set(kind, run);
    void run.then(() => {
      if (localBridgeRefreshInFlight.get(kind) === run) {
        localBridgeRefreshInFlight.delete(kind);
      }
    });
  }

  function requestLocalBridgeRefresh(): void {
    if (!deps.localBridge || !localBridgeStatus.pending) return;
    enqueueLocalBridgeRefresh("connection", async () => {
      try {
        const previousPending = localBridgeStatus.pending;
        localBridgeStatus = await deps.localBridge!.refreshConnection();
        renderLocalBridgeStatus(localBridgeStatus);
        if (previousPending && localBridgeStatus.connected) {
          await requestLocalBridgePublish(latestSnapshot);
        }
      } catch {
        elements.localBridgeStatus.textContent = t("waiting_approval_bridge_unavailable");
        renderLocalBridgeReadAcknowledgement({
          ...localBridgeStatus,
          readAcknowledgementState: "unavailable",
        });
      }
    });
  }

  function requestLocalBridgeHeartbeat(): void {
    if (!deps.localBridge || !localBridgeStatus.connected) return;
    enqueueLocalBridgeRefresh("heartbeat", async () => {
      try {
        localBridgeStatus = await deps.localBridge!.refreshConnectionAndHeartbeat();
        renderLocalBridgeStatus(localBridgeStatus);
        if (
          localBridgeStatus.connected &&
          (localBridgeShareState === "publish_failed" || localBridgeShareState === "clear_failed")
        ) {
          // A liveness refresh may have brought the owner back without changing
          // the desired panel state. Reconcile the latest authoritative
          // snapshot through the same serialized queue, whether the failed
          // operation was a publish or a panel-channel revocation.
          await requestLocalBridgePublish(latestSnapshot);
        }
      } catch {
        if (localBridgeShareState !== "clear_failed") {
          localBridgeShareState = "publish_failed";
        }
        renderLocalBridgeStatus(localBridgeStatus);
        renderLocalBridgeReadAcknowledgement({
          ...localBridgeStatus,
          readAcknowledgementState: "unavailable",
        });
      }
    });
  }

  function requestLocalBridgePublish(snapshot: PanelSessionSnapshot): Promise<void> {
    if (!deps.localBridge) return Promise.resolve();
    pendingLocalBridgeSnapshot = snapshot;
    if (!localBridgePublishInFlight) {
      localBridgePublishInFlight = true;
      localBridgePublish = Promise.resolve().then(drainLocalBridgePublishes);
    }
    return localBridgePublish;
  }

  async function drainLocalBridgePublishes(): Promise<void> {
    try {
      while (pendingLocalBridgeSnapshot) {
        const snapshot = pendingLocalBridgeSnapshot;
        pendingLocalBridgeSnapshot = null;
        try {
          await publishLocalBridgeSnapshot(snapshot);
        } catch {
          localBridgeShareState = "publish_failed";
          renderLocalBridgeStatus(localBridgeStatus);
          // A later snapshot remains eligible to replace a failed publish.
        }
      }
    } finally {
      localBridgePublishInFlight = false;
    }
  }

  async function publishLocalBridgeSnapshot(snapshot: PanelSessionSnapshot): Promise<void> {
    if (!deps.localBridge) return;
    if (!localBridgeStatus.connected && !localBridgeStatus.pending) return;
    if (snapshot.intentDirty || localBridgeIntentEditActive) {
      // Persist local drafts on the controller's short debounce, but do not
      // share them while the textarea is still being edited. Publishing waits
      // for an explicit editing boundary and a persisted snapshot.
      return;
    }
    const focusedPage = deriveFocusedLocalBridgePage(snapshot.activePage);
    if (
      !snapshot.activeSupported ||
      snapshot.status.kind === "error" ||
      snapshot.clearPending ||
      !focusedPage
    ) {
      await clearLocalBridgePanelContext();
      return;
    }
    const selectedItem = findPanelSessionItem(snapshot.file, snapshot.selectedItemId);
    const selectedRecord = selectedItem
      ? selectedItem.sourceRecord as OriginCaptureRecord
      : snapshot.file
        ? null
        : snapshot.legacyRecord;
    const bridgeScope = snapshot.file
      ? derivePanelCopyScope(
          snapshot.file,
          snapshot.selectedItemId,
          snapshot.activePage,
          getLiveCurrentItemIds(snapshot),
          getLiveExcludedItemIds(snapshot),
        )
      : null;
    const attachmentIds = snapshot.file
      ? bridgeScope?.itemIds ?? []
      : selectedRecord
        ? [selectedRecord.attachment.id]
        : [];
    const representativeItem = selectedItem && attachmentIds.includes(selectedItem.id)
      ? selectedItem
      : findPanelSessionItem(snapshot.file, attachmentIds[0] ?? null);
    const candidateRecord = representativeItem
      ? representativeItem.sourceRecord as OriginCaptureRecord
      : selectedRecord;
    const candidateRoutingHint = candidateRecord
      ? deriveCapturePageRoutingHint(candidateRecord)
      : null;
    const record = candidateRecord && (
      snapshot.file !== null || (
        candidateRoutingHint?.pageInstanceId === focusedPage.pageInstanceId &&
        candidateRoutingHint.route === focusedPage.route
      )
    )
      ? candidateRecord
      : null;
    const bridgeInput = record
      ? {
          file: snapshot.file,
          attachmentIds,
          selectedItemId: snapshot.selectedItemId,
          selectedRecord: record,
          viewMode: "agent_safe" as const,
          intent: snapshot.intent,
          includeReplayDiagnostics: true as const,
        }
      : null;
    const handoff = bridgeInput
      ? buildPanelBridgeAgentCopy({
          ...bridgeInput,
        }, t)
      : null;
    const captureRoutingHint = record ? candidateRoutingHint : null;
    const observationCandidate = record ? getLocalBridgeObservations(snapshot) : null;
    const observationRoutingHint = observationCandidate && snapshot.activePage && record
      ? deriveCapturePageRoutingHint({
        ...record,
        tabId: snapshot.activePage.tabId,
        frameId: snapshot.activePage.frameId,
        origin: snapshot.activePage.origin,
        pageUrl: `${snapshot.activePage.origin}${snapshot.activePage.pathname}`,
      })
      : null;
    const availableObservations = observationCandidate && observationRoutingHint
      ? observationCandidate
      : null;
    const waitingForCurrentScopeObservation = isCurrentBridgeScopeObservationPending(
      snapshot,
      bridgeScope,
      attachmentIds,
    );
    const observations = waitingForCurrentScopeObservation ? null : availableObservations;
    if (observationCandidate && !observationRoutingHint) {
      elements.localBridgeStatus.dataset.observationState = "page_routing_unavailable";
    }
    const routingHint = observations ? observationRoutingHint : captureRoutingHint;
    const observedAttachmentIds = observations
      ? new Set(observations.targets.map((target) => target.attachmentId))
      : null;
    if (waitingForCurrentScopeObservation) {
      // A session update can reach the panel before the content script has
      // rebound every newly added target. Share the complete capture-time
      // attachment set immediately, then upgrade it with live observations
      // when rebind finishes. Optional live evidence must never make a local
      // capture invisible to the Agent or require the user to reselect it.
      elements.localBridgeStatus.dataset.observationState = "scope_pending";
    }
    const hasCurrentLiveBinding = Boolean(
      observations &&
      observedAttachmentIds &&
      observations.targets.length === attachmentIds.length &&
      attachmentIds.every((attachmentId) => observedAttachmentIds.has(attachmentId)) &&
      observations.targets.every((target) => target.status === "restored"),
    );
    const capture = bridgeInput
      ? buildPanelBridgeCapture(bridgeInput, hasCurrentLiveBinding ? "live_page" : "capture_time")
      : null;
    const publishInput = record && capture && captureRoutingHint
      ? {
          page: routingHint
            ? { pageInstanceId: routingHint.pageInstanceId, route: routingHint.route }
            : null,
          attachmentCount: capture.targets.length,
          agentCopy: handoff?.ok ? handoff.text : null,
          capture,
          ...(observations ? { observations } : {}),
          ...(localBridgeActivity ? { activity: localBridgeActivity } : {}),
        }
      : {
          page: focusedPage,
          attachmentCount: 0,
          agentCopy: null,
        };
    if (observations) {
      localBridgeObservationPublishAttempts += 1;
      elements.localBridgeStatus.dataset.observationPublishAttempts =
        String(localBridgeObservationPublishAttempts);
      elements.localBridgeStatus.dataset.observationPayloadValid = String(
        isLocalBridgeSnapshot({
          schemaVersion: "0.1.0",
          kind: "ui-attach.local-bridge-snapshot",
          sequence: 1,
          publishedAt: new Date().toISOString(),
          ...publishInput,
        }),
      );
    }
    let published: boolean;
    try {
      published = await deps.localBridge.publish(publishInput);
    } finally {
      if (observations) {
        localBridgeObservationPublishSettled += 1;
        elements.localBridgeStatus.dataset.observationPublishSettled =
          String(localBridgeObservationPublishSettled);
      }
    }
    if (observations) {
      elements.localBridgeStatus.dataset.observationState = published
        ? "published"
        : "publish_rejected";
    }
    localBridgeShareState = published ? "shared" : "publish_failed";
    if (published && localBridgeStatus.connected) {
      // publish() intentionally returns only success; readStatus performs the
      // authenticated, ephemeral ACK readback and makes a new sequence show
      // waiting immediately without persisting acknowledgement data.
      try {
        localBridgeStatus = await deps.localBridge.readStatus();
      } catch {
        localBridgeStatus = {
          ...localBridgeStatus,
          readAcknowledgementState: "unavailable",
        };
      }
    }
    renderLocalBridgeStatus(localBridgeStatus);
    if (!published && localBridgeStatus.connected) {
      const storedStatus = await deps.localBridge.readStatus();
      if (!storedStatus.connected) {
        localBridgeStatus = storedStatus;
        renderLocalBridgeStatus(localBridgeStatus);
      } else {
        elements.localBridgeStatus.textContent = t("connected_agent_unreachable");
      }
    }
  }

  function markLocalBridgeIntentEditing(): void {
    if (!deps.localBridge) return;
    localBridgeIntentEditActive = true;
  }

  function finishLocalBridgeIntentEditing(): void {
    if (!deps.localBridge || !localBridgeIntentEditActive) return;
    localBridgeIntentEditActive = false;
    // If persistence is still pending, intentDirty keeps this snapshot from
    // publishing. The controller's persisted readback will publish it later.
    void requestLocalBridgePublish(latestSnapshot);
  }

  function getLocalBridgeObservations(
    snapshot: PanelSessionSnapshot,
  ): LocalBridgeObservationsV1 | null {
    const scope = derivePanelCopyScope(
      snapshot.file,
      snapshot.selectedItemId,
      snapshot.activePage,
      getLiveCurrentItemIds(snapshot),
      getLiveExcludedItemIds(snapshot),
    );
    const pageKey = currentPageKey(snapshot.activePage);
    const observationState = !snapshot.activePage
      ? "active_page_unavailable"
      : !scope?.current
        ? "scope_not_current"
        : !deps.currentRebind || currentRebindUnavailable
          ? "rebind_unavailable"
          : pageKey === null || currentRebindPageKey !== pageKey
            ? "rebind_page_mismatch"
            : currentRebindObservedAt === null
              ? "observation_pending"
              : currentRebindDocumentId === null
                ? "document_unbound"
                : "ready";
    elements.localBridgeStatus.dataset.observationState = observationState;
    if (observationState !== "ready" || !scope || !snapshot.activePage ||
      currentRebindObservedAt === null || currentRebindDocumentId === null) return null;
    const targets = scope.itemIds.flatMap((attachmentId) => {
      if (!/^att_[A-Za-z0-9_-]{1,252}$/.test(attachmentId)) return [];
      const status = currentRebindStatuses.get(attachmentId) ?? (
        currentRebindStateKey === "checking" ? "checking" : null
      );
      return status ? [{ attachmentId, status }] : [];
    });
    if (targets.length === 0) {
      elements.localBridgeStatus.dataset.observationState = "targets_unavailable";
      return null;
    }
    elements.localBridgeStatus.dataset.observationDocumentIdLength =
      String(currentRebindDocumentId.length);
    elements.localBridgeStatus.dataset.observationDocumentIdSchemaValid = String(
      /^[A-Za-z0-9_-]{1,128}$/.test(currentRebindDocumentId),
    );
    elements.localBridgeStatus.dataset.observationObservedAtValid = String(
      new Date(currentRebindObservedAt).toISOString() === currentRebindObservedAt,
    );
    elements.localBridgeStatus.dataset.observationTargetCount = String(targets.length);
    elements.localBridgeStatus.dataset.observationTargetsValid = String(
      targets.length <= 26 &&
      new Set(targets.map((target) => target.attachmentId)).size === targets.length &&
      targets.every((target) => (
        /^att_[A-Za-z0-9_-]{1,252}$/.test(target.attachmentId) &&
        ["ambiguous", "checking", "missing", "restored"].includes(target.status)
      )),
    );
    return {
      observedAt: currentRebindObservedAt,
      documentInstanceId: currentRebindDocumentId,
      targets,
    };
  }

  async function retryBootstrapRead<T>(operation: () => Promise<T>): Promise<T> {
    let lastError: unknown;
    for (let attempt = 1; attempt <= PANEL_BOOTSTRAP_ATTEMPTS; attempt += 1) {
      try {
        return await operation();
      } catch (error) {
        lastError = error;
        if (attempt === PANEL_BOOTSTRAP_ATTEMPTS) break;
        await new Promise<void>((resolveDelay) => {
          deps.setTimeout(resolveDelay, PANEL_BOOTSTRAP_RETRY_DELAY_MS);
        });
      }
    }
    throw lastError;
  }

  async function updateElementSelectionSetting(enabled: boolean): Promise<void> {
    const revision = ++elementSelectionRevision;
    elements.elementSelectionToggle.disabled = true;
    try {
      await deps.elementSelection?.save(enabled);
      const observed = await (deps.elementSelection?.read() ?? Promise.resolve(false));
      if (revision !== elementSelectionRevision) return;
      if (observed) renderPageAccessRecovery(null);
      renderElementSelectionState(observed);
    } finally {
      elements.elementSelectionToggle.disabled = false;
    }
  }

  async function requestElementSelectionSetting(enabled: boolean): Promise<void> {
    if (!enabled) {
      await updateElementSelectionSetting(false);
      return;
    }
    if (!firstCaptureDisclosureAcknowledged) {
      openFirstCaptureDisclosure();
      return;
    }
    await updateElementSelectionSetting(true);
  }

  function openFirstCaptureDisclosure(): void {
    elements.firstCaptureDisclosureStatus.textContent = "";
    if (!elements.firstCaptureDisclosure.open) {
      if (typeof elements.firstCaptureDisclosure.showModal === "function") {
        elements.firstCaptureDisclosure.showModal();
      } else {
        elements.firstCaptureDisclosure.setAttribute("open", "");
      }
    }
    elements.acknowledgeFirstCapture.focus();
  }

  function closeFirstCaptureDisclosure(): void {
    elements.firstCaptureDisclosureStatus.textContent = "";
    if (elements.firstCaptureDisclosure.open) {
      if (typeof elements.firstCaptureDisclosure.close === "function") {
        elements.firstCaptureDisclosure.close();
      } else {
        elements.firstCaptureDisclosure.removeAttribute("open");
      }
    }
    elements.elementSelectionToggle.focus();
  }

  async function acknowledgeFirstCaptureDisclosure(): Promise<void> {
    elements.acknowledgeFirstCapture.disabled = true;
    elements.dismissFirstCapture.disabled = true;
    elements.firstCaptureDisclosureStatus.textContent = "";
    try {
      await options.firstCaptureDisclosure.acknowledge();
      firstCaptureDisclosureAcknowledged = true;
      closeFirstCaptureDisclosure();
    } catch {
      elements.firstCaptureDisclosureStatus.textContent = t("panel_action_failed");
    } finally {
      elements.acknowledgeFirstCapture.disabled = false;
      elements.dismissFirstCapture.disabled = false;
    }
  }

  async function requestFrameScopeSelection(scope: FrameScopeDescriptor): Promise<void> {
    const startSelection = elementSelectionEnabled || frameScopeAutoStart;
    if (startSelection && !firstCaptureDisclosureAcknowledged) {
      openFirstCaptureDisclosure();
      return;
    }
    if (!deps.frameScopes || !frameScopeData || !scope.selectable) {
      throw new Error(formatElementSelectionFailureStatus("FRAME_UNAVAILABLE"));
    }
    frameScopeActivationPending = true;
    renderFrameScopes();
    try {
      const enabled = await deps.frameScopes.select({
        tabId: frameScopeData.tabId,
        frameId: scope.frameId,
        documentId: scope.documentId,
        origin: scope.origin,
        pathname: scope.pathname,
        requiresHostPermission: scope.requiresHostPermission,
      }, startSelection);
      renderElementSelectionToggle(enabled);
      await options.controller.refreshActiveOrigin();
      await refreshFrameScopes();
      elements.captureScope.open = false;
      elements.status.textContent = enabled
        ? t("frame_scope_selection_enabled")
        : t("frame_scope_changed");
      renderPageAccessRecovery(null);
    } catch (error) {
      if (error instanceof FrameScopeAccessError) {
        throw new Error(formatElementSelectionFailureStatus(error.code));
      }
      throw error;
    } finally {
      frameScopeActivationPending = false;
      renderFrameScopes();
    }
  }

  async function refreshFrameScopes(): Promise<void> {
    const revision = ++frameScopeRefreshRevision;
    if (!deps.frameScopes || !latestSnapshot.activeSupported) {
      frameScopeData = null;
      renderFrameScopes();
      if (storedSessionReview) renderStoredSessions();
      return;
    }
    try {
      const next = await deps.frameScopes.list();
      if (revision !== frameScopeRefreshRevision) return;
      frameScopeData = next;
    } catch {
      if (revision !== frameScopeRefreshRevision) return;
      frameScopeData = null;
    }
    renderFrameScopes();
    if (storedSessionReview) renderStoredSessions();
  }

  function renderFrameScopes(): void {
    const data = frameScopeData;
    const visible = data !== null && data.scopes.length > 1;
    elements.captureScope.hidden = !visible;
    if (!visible || !data) {
      elements.captureScope.open = false;
      elements.captureScopeBreadcrumb.textContent = "";
      elements.captureScopeTree.replaceChildren();
      return;
    }

    const current = data.scopes.find((scope) => scope.frameId === data.currentFrameId)
      ?? data.scopes[0];
    const chain = current ? frameScopeAncestorChain(current, data.scopes) : [];
    elements.captureScopeBreadcrumb.textContent = chain
      .map((scope) => formatFrameScopeBreadcrumb(scope, t))
      .join(" › ");
    elements.captureScopeTree.replaceChildren();
    for (const scope of data.scopes) {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "capture-scope-row";
      button.dataset.frameScopeId = String(scope.frameId);
      button.setAttribute("role", "treeitem");
      button.setAttribute("aria-level", String(scope.depth + 1));
      button.setAttribute("aria-current", scope.frameId === data.currentFrameId ? "true" : "false");
      button.style.setProperty("--frame-scope-depth", String(scope.depth));
      button.disabled = frameScopeActivationPending || !scope.selectable;
      if (!scope.selectable) button.title = t("capture_scope_unavailable");

      const copy = document.createElement("span");
      copy.className = "capture-scope-row-copy";
      copy.append(
        createSpan(
          "capture-scope-row-title",
          scope.frameId === 0 ? t("top_page") : t("embedded_frame"),
        ),
        createSpan("capture-scope-row-route", formatFrameScopeRoute(scope)),
      );
      button.append(copy);
      if (scope.frameId === data.currentFrameId) {
        button.append(createSpan("capture-scope-current", t("current_scope")));
      }
      elements.captureScopeTree.append(button);
    }
  }

  function renderElementSelectionToggle(enabled: boolean): void {
    elementSelectionEnabled = enabled;
    elements.elementSelectionToggle.setAttribute("aria-pressed", enabled ? "true" : "false");
    elements.elementSelectionToggle.textContent = enabled
      ? t("stop_selecting")
      : t("add_elements");
    renderPrimaryActionHierarchy();
  }

  function renderPrimaryActionHierarchy(): void {
    const copyIsPrimary = handoffAttachmentCount > 0;
    elements.elementSelectionToggle.classList.add("primary-action");
    elements.elementSelectionToggle.classList.remove("utility-action");
    elements.copySummary.classList.toggle("primary-action", copyIsPrimary);
    elements.copySummary.classList.toggle("utility-action", !copyIsPrimary);
  }

  function renderElementSelectionState(enabled: boolean): void {
    renderElementSelectionToggle(enabled);
    const canRenderStatus = (
      canRenderSelectionStatus(latestSnapshot) &&
      pageAccessRecoveryStatus === null &&
      !hasActionableSelectedPreviewStatus(latestSnapshot)
    );
    selectionStoppedStatusKey = !enabled && canRenderStatus
      ? createSelectionStatusSnapshotKey(latestSnapshot)
      : null;
    const hasElements = (
      (latestSnapshot.file?.session.attachments.length ?? 0) > 0 ||
      latestSnapshot.legacyRecord !== null
    );
    if (canRenderStatus) {
      elements.status.textContent = enabled
        ? t("selection_enabled")
        : formatSelectionStoppedStatus(hasElements, t);
    }
    if (pageAccessRecoveryStatus !== null) {
      elements.status.textContent = pageAccessRecoveryStatus;
    }
  }

  async function updateHandoffFormatPreference(
    scope: PanelHandoffFormatScope,
    format: CapturePromptBundleFormat,
  ): Promise<void> {
    const revision = ++handoffFormatPreferenceRevisions[scope];
    if (scope === "multi") preferredMultiTargetHandoffFormat = format;
    else preferredSingleTargetHandoffFormat = format;
    handoffFormat = format;
    elements.handoffFormat.value = format;
    updateAgentHandoffPreview();
    const write = handoffFormatPreferenceWriteQueues[scope]
      .catch(() => undefined)
      .then(() => deps.handoffFormatPreferences?.save(scope, format));
    handoffFormatPreferenceWriteQueues[scope] = write.catch(() => undefined);
    try {
      await write;
      if (scope === "multi") persistedMultiTargetHandoffFormat = format;
      else persistedSingleTargetHandoffFormat = format;
    } catch (error) {
      if (handoffFormatPreferenceRevisions[scope] !== revision) return;
      const persistedFormat = scope === "multi"
        ? persistedMultiTargetHandoffFormat
        : persistedSingleTargetHandoffFormat;
      if (scope === "multi") preferredMultiTargetHandoffFormat = persistedFormat;
      else preferredSingleTargetHandoffFormat = persistedFormat;
      const activeScope = handoffAttachmentCount > 1 ? "multi" : "single";
      if (handoffAttachmentCount > 0 && activeScope === scope) {
        handoffFormat = persistedFormat;
        elements.handoffFormat.value = persistedFormat;
        updateAgentHandoffPreview();
      }
      throw error;
    }
  }

  async function refreshStoredSessions(): Promise<void> {
    if (!options.storedSessions) {
      storedSessionSummaries = [];
      renderStoredSessions();
      return;
    }
    const revision = ++storedSessionsRevision;
    try {
      const response = await options.storedSessions.list();
      if (revision !== storedSessionsRevision) return;
      if (!response.ok) {
        storedSessionSummaries = [];
        renderStoredSessions(true);
        return;
      }
      const summaries = parseStoredSessionSummaries(response.data);
      if (summaries === null) {
        storedSessionSummaries = [];
        renderStoredSessions(true);
        return;
      }
      storedSessionSummaries = summaries;
      if (storedSessionReview) {
        const current = storedSessionSummaries.find(
          (summary) => summary.origin === storedSessionReview?.origin,
        );
        if (
          !current ||
          current.state !== "ready" ||
          current.epoch !== storedSessionReview.epoch ||
          current.attachmentCount !== storedSessionReview.items.length
        ) {
          storedSessionRestoreRevision += 1;
          storedSessionReview = null;
          storedSessionHandoff = null;
          storedSessionMachineDisclosureOpen = false;
        }
      }
      renderStoredSessions();
    } catch {
      if (revision !== storedSessionsRevision) return;
      storedSessionSummaries = [];
      renderStoredSessions(true);
    }
  }

  function renderStoredSessions(failed = false): void {
    const renderSignature = JSON.stringify({
      failed,
      busy: storedSessionsBusy,
      summaries: storedSessionSummaries,
      review: storedSessionReview,
      handoff: storedSessionHandoff
        ? {
            origin: storedSessionHandoff.origin,
            epoch: storedSessionHandoff.epoch,
            attachmentCount: storedSessionHandoff.bundle.attachmentCount,
          }
        : null,
      machineDisclosureOpen: storedSessionMachineDisclosureOpen,
      timeDisplayPreference,
      activePage: latestSnapshot.activePage,
      frameScope: frameScopeData
        ? { tabId: frameScopeData.tabId, currentFrameId: frameScopeData.currentFrameId }
        : null,
    });
    if (renderSignature === storedSessionsRenderSignature) return;
    storedSessionsRenderSignature = renderSignature;
    elements.savedSites.hidden =
      !failed &&
      storedSessionReview === null &&
      storedSessionSummaries.length === 0;
    if (elements.savedSites.hidden) elements.savedSites.open = false;
    const renderedCount = failed ? "?" : String(storedSessionSummaries.length);
    elements.savedSitesCount.textContent = renderedCount;
    elements.savedSitesCount.setAttribute(
      "aria-label",
      t("saved_site_count_aria", { count: renderedCount }),
    );
    elements.savedSitesList.replaceChildren();
    elements.clearAllSavedSites.hidden = storedSessionReview !== null;
    elements.clearAllSavedSites.disabled = failed || storedSessionsBusy || storedSessionSummaries.length === 0;
    if (storedSessionReview === null) {
      elements.clearAllSavedSites.after(elements.savedSitesStatus);
    }
    if (!failed && storedSessionReview) {
      renderStoredSessionReview(storedSessionReview);
      return;
    }
    if (failed) {
      const message = document.createElement("p");
      message.className = "muted";
      message.textContent = t("saved_sites_unavailable");
      elements.savedSitesList.append(message);
      return;
    }
    if (storedSessionSummaries.length === 0) {
      const empty = document.createElement("p");
      empty.className = "muted";
      empty.textContent = t("no_saved_site_sessions");
      elements.savedSitesList.append(empty);
      return;
    }

    for (const summary of storedSessionSummaries) {
      const row = document.createElement("div");
      row.className = "saved-site-row";
      row.dataset.savedOrigin = summary.origin;
      const details = document.createElement("div");
      details.className = "saved-site-details";
      const origin = document.createElement("strong");
      origin.className = "saved-site-origin";
      origin.textContent = summary.origin;
      const count = document.createElement("span");
      count.className = "saved-site-count muted";
      count.textContent = summary.attachmentCount === null
        ? t("saved_site_needs_cleanup")
        : summary.attachmentCount === 1
          ? t("saved_site_target_one")
          : t("saved_site_target_many", { count: summary.attachmentCount });
      details.append(origin, count);

      const actions = document.createElement("div");
      actions.className = "saved-site-actions";
      if (summary.state === "ready") {
        const review = document.createElement("button");
        review.type = "button";
        review.className = "utility-action";
        review.dataset.reviewSavedOrigin = summary.origin;
        review.textContent = t("review_saved_site");
        review.setAttribute("aria-label", t("review_saved_site_aria", { origin: summary.origin }));
        review.disabled = storedSessionsBusy;
        actions.append(review);
      }

      const clear = document.createElement("button");
      clear.type = "button";
      clear.className = "utility-action destructive-action";
      clear.dataset.clearSavedOrigin = summary.origin;
      clear.textContent = summary.clearPending ? t("retry_clear") : t("clear_saved_site");
      clear.setAttribute("aria-label", t("clear_saved_site_aria", { origin: summary.origin }));
      clear.disabled = storedSessionsBusy;
      actions.append(clear);
      row.append(details, actions);
      elements.savedSitesList.append(row);
    }
  }

  function renderStoredSessionReview(review: StoredSessionReviewData): void {
    const header = document.createElement("div");
    header.className = "saved-review-header";
    const back = document.createElement("button");
    back.type = "button";
    back.className = "utility-action";
    back.dataset.closeSavedReview = "";
    back.textContent = t("back_to_saved_sites");
    back.disabled = storedSessionsBusy;
    const identity = document.createElement("div");
    identity.className = "saved-review-identity";
    const origin = document.createElement("strong");
    origin.className = "saved-review-origin";
    origin.textContent = review.origin;
    const state = document.createElement("span");
    state.className = "saved-review-state muted";
    state.textContent = t("saved_snapshot_read_only");
    identity.append(origin, state);
    header.append(back, identity);

    const help = document.createElement("p");
    help.className = "saved-review-help muted";
    help.textContent = t("saved_review_help");
    elements.savedSitesList.append(header, help, renderStoredSessionRoutes(review));

    if (review.items.length === 0) {
      const empty = document.createElement("p");
      empty.className = "muted";
      empty.textContent = t("saved_review_empty");
      elements.savedSitesList.append(empty, elements.savedSitesStatus);
      return;
    }
    const list = document.createElement("div");
    list.className = "saved-review-list";
    for (const item of review.items) {
      const card = document.createElement("article");
      card.className = "saved-review-item";
      const target = document.createElement("strong");
      target.className = "saved-review-target";
      target.textContent = `${item.label} · ${item.target}`;
      const taskNote = item.intent.trim();
      const intent = taskNote ? document.createElement("p") : null;
      if (intent) {
        intent.className = "saved-review-intent";
        intent.textContent = t("saved_review_task_note", { intent: taskNote });
      }
      const metaDisclosure = document.createElement("details");
      metaDisclosure.className = "saved-review-meta-disclosure";
      const metaSummary = document.createElement("summary");
      metaSummary.textContent = t("saved_review_capture_details");
      const meta = document.createElement("span");
      meta.className = "saved-review-meta muted";
      meta.textContent = `${formatDisplayTime(item.capturedAt, timeDisplayPreference)} · ${t("source")}: ${formatDisclosureMode(item.sourceDisclosureMode, t)}`;
      metaDisclosure.append(metaSummary, meta);
      card.append(target);
      if (intent) card.append(intent);
      card.append(metaDisclosure);
      list.append(card);
    }
    elements.savedSitesList.append(list);
    renderStoredSessionHandoffControls();
  }

  function renderStoredSessionRoutes(review: StoredSessionReviewData): HTMLElement {
    const section = document.createElement("section");
    section.className = "saved-review-routes";
    const heading = document.createElement("strong");
    heading.className = "saved-review-routes-heading";
    heading.textContent = t("saved_routes_heading");
    section.append(heading);
    const routes = Array.isArray(review.routes) ? review.routes : [];
    if (routes.length === 0) {
      const unavailable = document.createElement("p");
      unavailable.className = "saved-review-route-help muted";
      unavailable.textContent = t("saved_routes_unavailable");
      section.append(unavailable);
      return section;
    }
    for (const route of routes) {
      const routeUrl = canonicalStoredRouteUrl(route.origin, route.pathname);
      if (!routeUrl || route.origin !== review.origin) continue;
      const topPageUrl = storedSessionTopPageUrl(route);
      const row = document.createElement("div");
      row.className = "saved-review-route";
      const details = document.createElement("div");
      details.className = "saved-review-route-details";
      const identity = document.createElement("span");
      identity.className = "saved-review-route-identity saved-review-route-page";
      identity.textContent = topPageUrl ?? routeUrl;
      const meta = document.createElement("span");
      meta.className = "saved-review-route-meta saved-review-route-scope muted";
      const kind = route.frameKind === "top"
        ? t("saved_route_top")
        : t("embedded_frame_scope");
      const count = route.targetCount === 1
        ? t("saved_site_target_one")
        : t("saved_site_target_many", { count: route.targetCount });
      meta.textContent = `${t("capture_scope")}: ${formatStoredFrameChain(route)} · ${kind} · ${count}`;
      details.append(identity, meta);

      const actions = document.createElement("div");
      actions.className = "saved-review-route-actions";
      if (options.storedSessions?.restoreRoute) {
        const restore = document.createElement("button");
        restore.type = "button";
        restore.className = "utility-action";
        restore.dataset.restoreSavedOrigin = review.origin;
        restore.dataset.restoreSavedPathname = route.pathname;
        restore.dataset.restoreSavedFrameKind = route.frameKind;
        restore.dataset.restoreSavedRouteKey = storedSessionRouteKey(route);
        restore.textContent = t(
          canRestoreSavedRoute(route) ? "restore_current_page" : "find_and_restore_saved_route",
        );
        restore.disabled = storedSessionsBusy;
        actions.append(restore);
      }
      if (topPageUrl) {
        const copy = document.createElement("button");
        copy.type = "button";
        copy.className = "utility-action";
        copy.dataset.copySavedPageRoute = topPageUrl;
        copy.textContent = t("copy_page_address");
        copy.disabled = storedSessionsBusy;
        actions.append(copy);
      }
      if (topPageUrl && options.openSavedRoute) {
        const open = document.createElement("button");
        open.type = "button";
        open.className = "utility-action";
        open.dataset.openSavedRoute = topPageUrl;
        open.textContent = t("open_saved_page");
        open.disabled = storedSessionsBusy;
        actions.append(open);
      }
      row.append(details, actions);
      section.append(row);
    }
    if (section.children.length === 1) {
      const unavailable = document.createElement("p");
      unavailable.className = "saved-review-route-help muted";
      unavailable.textContent = t("saved_routes_unavailable");
      section.append(unavailable);
    }
    return section;
  }

  function savedRouteMatchesActivePage(
    route: StoredSessionReviewData["routes"][number],
  ): boolean {
    const activePage = latestSnapshot.activePage;
    return activePage !== null &&
      route.origin === activePage.origin &&
      route.pathname === activePage.pathname &&
      (route.frameKind === "top" ? activePage.frameId === 0 : activePage.frameId > 0);
  }

  function canRestoreSavedRoute(
    route: StoredSessionReviewData["routes"][number],
  ): boolean {
    if (!savedRouteMatchesActivePage(route)) return false;
    if (route.frameKind === "top") return true;
    const activePage = latestSnapshot.activePage;
    return activePage !== null &&
      frameScopeData?.tabId === activePage.tabId &&
      frameScopeData.currentFrameId === activePage.frameId &&
      frameScopeData.scopes.some((scope) => (
        scope.frameId === activePage.frameId &&
        scope.origin === activePage.origin &&
        scope.pathname === activePage.pathname &&
        scope.selectable
      ));
  }

  function canonicalStoredRouteUrl(origin: string, pathname: string): string | null {
    if (!pathname.startsWith("/")) return null;
    try {
      const url = new URL(`${origin}${pathname}`);
      let decodedPathname: string;
      try {
        decodedPathname = decodeURIComponent(url.pathname);
      } catch {
        return null;
      }
      if (
        (url.protocol !== "http:" && url.protocol !== "https:") ||
        url.origin !== origin ||
        url.pathname !== pathname ||
        url.search.length > 0 ||
        url.hash.length > 0 ||
        url.username.length > 0 ||
        url.password.length > 0 ||
        decodedPathname.toLowerCase().includes("[redacted:")
      ) return null;
      return `${url.origin}${url.pathname}`;
    } catch {
      return null;
    }
  }

  function storedSessionTopPageUrl(route: StoredSessionRouteData): string | null {
    if (route.topPage) {
      return canonicalStoredRouteUrl(route.topPage.origin, route.topPage.pathname);
    }
    return route.frameKind === "top"
      ? canonicalStoredRouteUrl(route.origin, route.pathname)
      : null;
  }

  function storedSessionRouteKey(route: StoredSessionRouteData): string {
    return JSON.stringify([
      route.origin,
      route.pathname,
      route.frameKind,
      route.topPage ?? null,
      route.frameChain ?? null,
    ]);
  }

  function formatStoredFrameChain(route: StoredSessionRouteData): string {
    const chain = route.frameChain?.length
      ? route.frameChain
      : [{ origin: route.origin, pathname: route.pathname }];
    return chain.map((segment) => {
      try {
        const host = new URL(segment.origin).host;
        return segment.pathname === "/" ? host : `${host}${segment.pathname}`;
      } catch {
        return `${segment.origin}${segment.pathname}`;
      }
    }).join(" › ");
  }

  async function restoreStoredSessionRoute(route: StoredSessionRouteData): Promise<void> {
    const review = storedSessionReview;
    const restoreRoute = options.storedSessions?.restoreRoute;
    const matchingRoute = review?.routes.find(
      (candidate) => storedSessionRouteKey(candidate) === storedSessionRouteKey(route),
    ) ?? null;
    if (
      !review ||
      review.origin !== route.origin ||
      !restoreRoute ||
      storedSessionsBusy ||
      !matchingRoute
    ) return;
    const restoreRevision = ++storedSessionRestoreRevision;
    const selectedItemIdBeforeRestore = latestSnapshot.selectedItemId;
    updateSavedRestoreActivity("pending", "panel_request", null);
    storedSessionsBusy = true;
    elements.savedSitesStatus.textContent = "";
    renderStoredSessions();
    try {
      if (elementSelectionEnabled) {
        selectionStopPending = true;
        try {
          await requestElementSelectionSetting(false);
        } finally {
          selectionStopPending = false;
        }
      }
      if (!storedRestoreStillCurrent(restoreRevision, review)) {
        updateSavedRestoreActivity("failed", "panel_reconciliation", "PANEL_STATE_CHANGED");
        return;
      }
      let response: SessionCommandResponse<OverlayRebindStatusData>;
      try {
        response = await restoreRoute(matchingRoute);
      } catch {
        response = { ok: false, code: "CAPTURE_FAILED", error: SAFE_PANEL_ERROR };
      }
      if (!storedRestoreStillCurrent(restoreRevision, review)) {
        updateSavedRestoreActivity("failed", "panel_reconciliation", "PANEL_STATE_CHANGED");
        return;
      }
      if (!response.ok) {
        updateSavedRestoreActivity(
          "failed",
          "background_response",
          normalizeSavedRestoreActivityCode(response.code),
        );
        if (response.code === "SAVED_ROUTE_NOT_OPEN") {
          elements.savedSitesStatus.textContent = t("saved_route_not_found");
          return;
        }
        if (response.code === "SAVED_ROUTE_AMBIGUOUS") {
          elements.savedSitesStatus.textContent = t("saved_route_ambiguous");
          return;
        }
        elements.savedSitesStatus.textContent = [
          "CONTENT_UNAVAILABLE",
          "FRAME_AMBIGUOUS",
          "FRAME_PERMISSION_CLEANUP_FAILED",
          "FRAME_PERMISSION_DENIED",
          "FRAME_PERMISSION_UNAVAILABLE",
          "FRAME_UNAVAILABLE",
        ].includes(response.code)
          ? formatElementSelectionFailureStatus(response.code, t)
          : t("saved_restore_failed");
        return;
      }
      if (
        response.data.origin !== matchingRoute.origin ||
        response.data.pathname !== matchingRoute.pathname
      ) {
        updateSavedRestoreActivity(
          "failed",
          "panel_reconciliation",
          "INVALID_SESSION_RESPONSE",
        );
        elements.savedSitesStatus.textContent = t("saved_restore_failed");
        return;
      }
      const restored = response.data.items.filter((item) => item.status === "restored").length;
      const missing = response.data.items.filter(
        (item) => item.status === "missing" || item.status === "checking",
      ).length;
      const ambiguous = response.data.items.filter((item) => item.status === "ambiguous").length;
      if (restored === 0) {
        updateSavedRestoreActivity("failed", "panel_reconciliation", "NO_TARGETS_RESTORED");
        elements.savedSitesStatus.textContent = t("saved_restore_result", {
          restored,
          missing,
          ambiguous,
        });
        return;
      }
      const restoredItemIds = response.data.items
        .filter((item) => item.status === "restored")
        .map((item) => item.itemId);
      const preferredItemId = selectedItemIdBeforeRestore &&
          restoredItemIds.includes(selectedItemIdBeforeRestore)
        ? selectedItemIdBeforeRestore
        : restoredItemIds[0];
      currentRebindRequestRevision += 1;
      currentRebindRequestInFlight = null;
      await options.controller.refreshActiveOrigin().catch(() => undefined);
      await refreshFrameScopes();
      if (!storedRestoreStillCurrent(restoreRevision, review)) {
        updateSavedRestoreActivity("failed", "panel_reconciliation", "PANEL_STATE_CHANGED");
        return;
      }
      const activePage = latestSnapshot.activePage;
      if (
        !activePage ||
        activePage.origin !== matchingRoute.origin ||
        activePage.pathname !== matchingRoute.pathname ||
        (matchingRoute.frameKind === "top" ? activePage.frameId !== 0 : activePage.frameId === 0)
      ) {
        updateSavedRestoreActivity(
          "failed",
          "panel_reconciliation",
          "PANEL_RECONCILIATION_FAILED",
        );
        elements.savedSitesStatus.textContent = t("saved_restore_failed");
        return;
      }
      syncCurrentRebindPage(activePage);
      currentRebindObservedAt = new Date().toISOString();
      currentRebindDocumentId = activePage.documentId ?? null;
      currentRebindUnavailable = false;
      currentRebindStatuses = new Map(response.data.items.map((item) => [item.itemId, item.status]));
      currentRebindStateKey = `${currentRebindDocumentId ?? "unbound"}:${JSON.stringify(response.data.items)}`;
      await options.controller.selectItem(preferredItemId);
      if (
        !storedRestoreStillCurrent(restoreRevision, review) ||
        latestSnapshot.selectedItemId !== preferredItemId
      ) {
        updateSavedRestoreActivity(
          "failed",
          "panel_reconciliation",
          "PANEL_RECONCILIATION_FAILED",
        );
        elements.savedSitesStatus.textContent = t("saved_restore_failed");
        return;
      }
      const pageKey = currentPageKey(activePage);
      workspaceRestoreNotice = pageKey
        ? {
            pageKey,
            message: t("saved_restore_workspace_ready", { restored, missing, ambiguous }),
          }
        : null;
      storedSessionReview = null;
      storedSessionHandoff = null;
      storedSessionMachineDisclosureOpen = false;
      elements.savedSitesStatus.textContent = "";
      elements.savedSites.open = false;
      renderSnapshot(latestSnapshot);
      requestCurrentRebindStatus(latestSnapshot);
      elements.status.tabIndex = -1;
      elements.session.scrollIntoView?.({ block: "start" });
      elements.status.focus({ preventScroll: true });
      updateSavedRestoreActivity("succeeded", "panel_reconciliation", null);
    } finally {
      storedSessionsBusy = false;
      renderStoredSessions();
    }
  }

  function updateSavedRestoreActivity(
    state: LocalBridgeActivityV1["state"],
    stage: LocalBridgeActivityV1["stage"],
    code: string | null,
  ): void {
    if (!deps.localBridge) return;
    localBridgeActivity = {
      operation: "saved_restore",
      state,
      stage,
      code,
      observedAt: new Date().toISOString(),
    };
    void requestLocalBridgePublish(latestSnapshot);
  }

  function normalizeSavedRestoreActivityCode(code: string): string {
    return /^[A-Z][A-Z0-9_]{0,63}$/.test(code) ? code : "RESTORE_FAILED";
  }

  function storedRestoreStillCurrent(
    revision: number,
    review: StoredSessionReviewData,
  ): boolean {
    return revision === storedSessionRestoreRevision &&
      storedSessionReview?.origin === review.origin &&
      storedSessionReview.epoch === review.epoch;
  }

  async function openStoredSessionRoute(routeUrl: string): Promise<void> {
    const review = storedSessionReview;
    if (!review || !options.openSavedRoute || storedSessionsBusy) return;
    const allowed = Array.isArray(review.routes) && review.routes.some(
      (route) => storedSessionTopPageUrl(route) === routeUrl,
    );
    if (!allowed) return;
    await options.openSavedRoute(routeUrl);
    if (storedSessionReview?.origin === review.origin && storedSessionReview.epoch === review.epoch) {
      elements.savedSitesStatus.textContent = t("saved_page_opened");
    }
  }

  async function copyStoredSessionPageRoute(routeUrl: string): Promise<void> {
    const review = storedSessionReview;
    if (!review || storedSessionsBusy) return;
    const allowed = Array.isArray(review.routes) && review.routes.some(
      (route) => storedSessionTopPageUrl(route) === routeUrl,
    );
    if (!allowed) return;
    await options.clipboard.writeText(routeUrl);
    if (storedSessionReview?.origin === review.origin && storedSessionReview.epoch === review.epoch) {
      elements.savedSitesStatus.textContent = t("page_address_copied");
    }
  }

  function renderStoredSessionHandoffControls(): void {
    if (!options.storedSessions?.prepareHandoff) return;
    const handoff = document.createElement("section");
    handoff.className = "saved-handoff";
    const authority = document.createElement("p");
    authority.className = "saved-handoff-authority";
    const authorityTitle = document.createElement("strong");
    authorityTitle.textContent = t("saved_handoff_authority");
    const authorityHelp = document.createElement("span");
    authorityHelp.className = "muted";
    authorityHelp.textContent = ` ${t("saved_handoff_authority_help")}`;
    authority.append(authorityTitle, authorityHelp);
    const copy = document.createElement("button");
    copy.type = "button";
    copy.className = "primary-action saved-handoff-copy";
    copy.dataset.copySavedHandoff = "";
    copy.textContent = t("copy_saved_handoff");
    copy.disabled = storedSessionsBusy;
    handoff.append(authority, copy, elements.savedSitesStatus);
    if (storedSessionHandoff) {
      const previewDisclosure = document.createElement("details");
      previewDisclosure.className = "saved-handoff-preview-disclosure";
      const previewSummary = document.createElement("summary");
      previewSummary.textContent = t("saved_handoff_preview_summary");
      const preview = document.createElement("textarea");
      preview.className = "saved-handoff-preview";
      preview.readOnly = true;
      preview.value = storedSessionHandoff.bundle.markdown;
      preview.setAttribute("aria-label", t("saved_handoff_preview_aria"));
      previewDisclosure.append(previewSummary, preview);
      handoff.append(previewDisclosure);
      if (surfaceProfile === "development") {
        const machine = document.createElement("details");
        machine.className = "saved-handoff-machine";
        machine.open = storedSessionMachineDisclosureOpen;
        const machineSummary = document.createElement("summary");
        machineSummary.textContent = t("saved_bundle_json_summary");
        const machineHelp = document.createElement("p");
        machineHelp.className = "muted";
        machineHelp.textContent = t("saved_bundle_json_help");
        const machinePreview = document.createElement("textarea");
        machinePreview.className = "saved-bundle-json-preview";
        machinePreview.readOnly = true;
        machinePreview.value = serializeSavedSnapshotPromptBundleJson(storedSessionHandoff.bundle);
        machinePreview.setAttribute("aria-label", t("saved_bundle_json_preview_aria"));
        const copyJson = document.createElement("button");
        copyJson.type = "button";
        copyJson.dataset.copySavedBundleJson = "";
        copyJson.textContent = t("copy_saved_bundle_json");
        copyJson.disabled = storedSessionsBusy;
        machine.append(machineSummary, machineHelp, machinePreview, copyJson);
        handoff.append(machine);
      }
    }
    elements.savedSitesList.append(handoff);
  }

  async function reviewStoredOrigin(origin: string): Promise<void> {
    const summary = storedSessionSummaries.find((candidate) => candidate.origin === origin);
    if (!summary || summary.state !== "ready" || !options.storedSessions || storedSessionsBusy) {
      return;
    }
    storedSessionsBusy = true;
    const inventoryRevision = storedSessionsRevision;
    renderStoredSessions();
    let response: SessionCommandResponse<StoredSessionReviewData>;
    try {
      response = await options.storedSessions.review(origin);
    } catch {
      response = { ok: false, code: "CAPTURE_FAILED", error: SAFE_PANEL_ERROR };
    }
    storedSessionsBusy = false;
    const currentSummary = storedSessionSummaries.find(
      (candidate) => candidate.origin === origin,
    );
    if (
      inventoryRevision !== storedSessionsRevision ||
      !currentSummary ||
      currentSummary.state !== "ready" ||
      !response.ok ||
      response.data.origin !== currentSummary.origin ||
      response.data.epoch !== currentSummary.epoch ||
      response.data.items.length !== currentSummary.attachmentCount
    ) {
      storedSessionReview = null;
      elements.savedSitesStatus.textContent = t("saved_review_failed");
      renderStoredSessions();
      return;
    }
    storedSessionReview = response.data;
    storedSessionHandoff = null;
    storedSessionMachineDisclosureOpen = false;
    elements.savedSitesStatus.textContent = "";
    elements.relationSettings.open = false;
    elements.optionalSettings.open = false;
    elements.agentHandoffPreview.open = false;
    renderStoredSessions();
    elements.savedSitesList
      .querySelector<HTMLButtonElement>("[data-close-saved-review]")
      ?.focus();
  }

  async function prepareStoredSessionHandoff(
    action: "copy_markdown" | "copy_json",
  ): Promise<void> {
    const review = storedSessionReview;
    const prepareHandoff = options.storedSessions?.prepareHandoff;
    if (!review || !prepareHandoff || storedSessionsBusy) return;
    const inventoryRevision = storedSessionsRevision;
    storedSessionsBusy = true;
    renderStoredSessions();
    let response: SessionCommandResponse<StoredSessionHandoffData>;
    try {
      response = await prepareHandoff(review.origin, review.epoch);
    } catch {
      response = { ok: false, code: "CAPTURE_FAILED", error: SAFE_PANEL_ERROR };
    }
    const currentSummary = storedSessionSummaries.find(
      (candidate) => candidate.origin === review.origin,
    );
    const currentReview = storedSessionReview;
    if (
      inventoryRevision !== storedSessionsRevision ||
      !currentSummary ||
      currentSummary.state !== "ready" ||
      currentSummary.epoch !== review.epoch ||
      currentSummary.attachmentCount !== review.items.length ||
      currentReview?.origin !== review.origin ||
      currentReview.epoch !== review.epoch ||
      !response.ok ||
      !isStoredSessionHandoffData(response.data) ||
      response.data.origin !== review.origin ||
      response.data.epoch !== review.epoch ||
      response.data.bundle.attachmentCount !== review.items.length ||
      response.data.bundle.authority.origin !== review.origin
    ) {
      storedSessionsBusy = false;
      storedSessionHandoff = null;
      storedSessionMachineDisclosureOpen = false;
      if (currentReview) {
        elements.savedSitesStatus.textContent = t("saved_handoff_failed");
      }
      renderStoredSessions();
      return;
    }
    storedSessionHandoff = response.data;
    let clipboardWriteSucceeded = false;
    try {
      await options.clipboard.writeText(
        action === "copy_json"
          ? serializeSavedSnapshotPromptBundleJson(response.data.bundle)
          : response.data.bundle.markdown,
      );
      clipboardWriteSucceeded = true;
    } catch {
      clipboardWriteSucceeded = false;
    }
    storedSessionsBusy = false;
    const copyStillCurrent =
      inventoryRevision === storedSessionsRevision &&
      storedSessionReview?.origin === review.origin &&
      storedSessionReview.epoch === review.epoch &&
      storedSessionHandoff?.origin === review.origin &&
      storedSessionHandoff.epoch === review.epoch;
    renderStoredSessions();
    if (!copyStillCurrent) return;
    if (clipboardWriteSucceeded) {
      elements.savedSitesStatus.textContent = t(
        action === "copy_json" ? "saved_bundle_json_copied" : "saved_handoff_copied",
      );
      return;
    }
    elements.savedSitesStatus.textContent = t(
      action === "copy_json"
        ? "saved_bundle_json_clipboard_failed"
        : "saved_handoff_clipboard_failed",
    );
  }

  async function clearStoredOrigin(origin: string): Promise<void> {
    const summary = storedSessionSummaries.find((candidate) => candidate.origin === origin);
    if (!summary || !options.storedSessions || storedSessionsBusy) return;
    const dirtyIntentIdentity = readDirtyIntentIdentity(latestSnapshot);
    const dirtyIntentBelongsToTarget = isDirtyIntentForStoredOrigin(
      dirtyIntentIdentity,
      summary,
    );
    if (!options.confirm(t(
      dirtyIntentBelongsToTarget ? "confirm_clear_saved_site_dirty" : "confirm_clear_saved_site",
      { origin },
    ))) return;
    storedSessionsBusy = true;
    renderStoredSessions();
    let response: SessionCommandResponse<ActiveSessionReadback>;
    try {
      const operationId = summary.clearPending
        ? summary.activeClearOperationId
        : options.randomUUID();
      if (!operationId) {
        elements.savedSitesStatus.textContent = t("saved_sites_action_failed");
        storedSessionsBusy = false;
        renderStoredSessions();
        return;
      }
      response = await options.storedSessions.clear(
        summary.origin,
        summary.epoch,
        operationId,
      );
    } catch {
      response = { ok: false, code: "CAPTURE_FAILED", error: SAFE_PANEL_ERROR };
    }
    storedSessionsBusy = false;
    if (!response.ok) {
      elements.savedSitesStatus.textContent = t("saved_sites_action_failed");
      renderStoredSessions();
      return;
    }
    const readback = parseStoredClearReadback(response.data);
    if (readback === null) {
      elements.savedSitesStatus.textContent = t("saved_sites_action_failed");
      renderStoredSessions();
      return;
    }
    if (
      !readback.clearPending &&
      isDirtyIntentForStoredOrigin(dirtyIntentIdentity, summary) &&
      sameDirtyIntentIdentity(dirtyIntentIdentity, readDirtyIntentIdentity(latestSnapshot))
    ) {
      await options.controller.discardDirtyIntent().catch(() => undefined);
    }
    if (!readback.clearPending) {
      await options.controller.refreshActiveOrigin().catch(() => undefined);
    }
    await refreshStoredSessions();
    elements.savedSites.hidden = false;
    elements.savedSitesStatus.textContent = readback.clearPending
      ? t("clear_in_progress")
      : t("saved_site_cleared");
  }

  function readDirtyIntentIdentity(snapshot: PanelSessionSnapshot): DirtyIntentIdentity | null {
    if (snapshot.recovery) {
      return {
        origin: snapshot.recovery.oldOrigin,
        epoch: snapshot.recovery.oldEpoch,
        itemId: snapshot.recovery.itemId,
        intent: snapshot.recovery.intent,
      };
    }
    if (!snapshot.intentDirty || !snapshot.origin || !snapshot.epoch || !snapshot.selectedItemId) {
      return null;
    }
    return {
      origin: snapshot.origin,
      epoch: snapshot.epoch,
      itemId: snapshot.selectedItemId,
      intent: snapshot.intent,
    };
  }

  function isDirtyIntentForStoredOrigin(
    identity: DirtyIntentIdentity | null,
    summary: StoredOriginSessionSummary,
  ): boolean {
    return identity !== null &&
      identity.origin === summary.origin &&
      (identity.epoch === summary.epoch || summary.clearPending);
  }

  function sameDirtyIntentIdentity(
    left: DirtyIntentIdentity | null,
    right: DirtyIntentIdentity | null,
  ): boolean {
    return left !== null && right !== null &&
      left.origin === right.origin &&
      left.epoch === right.epoch &&
      left.itemId === right.itemId &&
      left.intent === right.intent;
  }

  async function clearAllStoredOrigins(): Promise<void> {
    if (!options.storedSessions || storedSessionsBusy || storedSessionSummaries.length === 0) return;
    if (!options.confirm(t("confirm_clear_all_saved_sites"))) return;
    if (latestSnapshot.intentDirty || latestSnapshot.recovery) {
      await options.controller.discardDirtyIntent();
    }
    storedSessionsBusy = true;
    renderStoredSessions();
    let response: SessionCommandResponse<{ clearedOrigins: string[] }>;
    try {
      response = await options.storedSessions.clearAll();
    } catch {
      response = { ok: false, code: "CAPTURE_FAILED", error: SAFE_PANEL_ERROR };
    }
    storedSessionsBusy = false;
    if (!response.ok) {
      elements.savedSitesStatus.textContent = t("saved_sites_action_failed");
      renderStoredSessions();
      return;
    }
    await options.controller.refreshActiveOrigin().catch(() => undefined);
    await refreshStoredSessions();
    elements.savedSites.hidden = false;
    elements.savedSitesStatus.textContent = t("all_saved_captures_cleared");
  }

  function renderSnapshot(snapshot: PanelSessionSnapshot): void {
    const rows = summarizePanelSessionRows(
      snapshot.file,
      snapshot.selectedItemId,
      snapshot.viewMode,
      snapshot.activePage,
    );
    const hasSessionItems = rows.length > 0;
    const groups = groupPanelSessionRows(
      snapshot.file,
      rows,
      snapshot.activePage,
      getLiveCurrentItemIds(snapshot),
      getLiveExcludedItemIds(snapshot),
    );
    const currentRows = groups.find((group) => group.current)?.rows ?? [];
    const legacyRecord = getSameOriginLegacyRecord(snapshot);
    const selectionStatusSnapshotKey = createSelectionStatusSnapshotKey(snapshot);
    if (
      selectionStoppedStatusKey !== null &&
      (
        selectionStoppedStatusKey !== selectionStatusSnapshotKey ||
        !canRenderSelectionStatus(snapshot)
      )
    ) {
      selectionStoppedStatusKey = null;
    }
    elements.origin.hidden = snapshot.origin === null;
    elements.origin.textContent = snapshot.origin === null
      ? ""
      : snapshot.activePage && snapshot.activePage.frameId > 0
        ? `${snapshot.origin} · ${t("embedded_frame_scope")}`
        : snapshot.origin;
    elements.status.textContent = formatSnapshotStatus(snapshot, hasSessionItems, t);
    const activeWorkspaceRestoreNotice = (
      snapshot.status.kind === "ready" || snapshot.status.kind === "empty"
    ) && pageAccessRecoveryStatus === null &&
      workspaceRestoreNotice?.pageKey === currentPageKey(snapshot.activePage)
      ? workspaceRestoreNotice
      : null;
    elements.emptyWorkflow.hidden = (
      !snapshot.activeSupported ||
      !snapshot.origin ||
      hasSessionItems ||
      legacyRecord !== null
    );
    elements.session.hidden = !(
      hasSessionItems ||
      legacyRecord !== null ||
      snapshot.clearPending ||
      snapshot.sessionMutationPending ||
      snapshot.recovery !== null
    );
    elements.intentRecovery.hidden = snapshot.recovery === null;
    const recoveryDraft = snapshot.recovery?.intent ?? "";
    if (elements.intentRecoveryDraft.value !== recoveryDraft) elements.intentRecoveryDraft.value = recoveryDraft;
    const clearPending = snapshot.clearPending;
    const sessionMutationPending = snapshot.sessionMutationPending;
    const selectedRow = rows.find((row) => row.id === snapshot.selectedItemId);
    const selectedRowCurrent = selectedRow
      ? groups.some((group) => group.current && group.rows.some((row) => row.id === selectedRow.id))
      : false;
    renderSelectedTargetSummary(selectedRow, selectedRowCurrent, snapshot);
    elements.removeSelectedItem.disabled = (
      !selectedRow ||
      snapshot.recovery !== null ||
      clearPending ||
      sessionMutationPending
    );
    elements.removeSelectedItem.setAttribute(
      "aria-label",
      selectedRow
        ? t("remove_aria", { label: selectedRow.label, target: selectedRow.target })
        : t("remove_selected_element"),
    );
    renderSessionRows(snapshot, groups, clearPending || sessionMutationPending);
    const previewHasActionableStatus = renderSelectedPreview(snapshot, legacyRecord);

    const blocked = snapshot.recovery !== null || !snapshot.origin || sessionMutationPending;
    renderHandoffScope(snapshot, blocked);
    elements.intent.disabled = isIntentDisabled(snapshot);
    renderRelationComposer(currentRows, snapshot);
    elements.clearSession.disabled = blocked || (!hasSessionItems && !clearPending);
    elements.exportSession.disabled = blocked || clearPending || !hasSessionItems;
    renderSnapshotStatusOverride(
      snapshot,
      hasSessionItems || legacyRecord !== null,
      activeWorkspaceRestoreNotice,
      previewHasActionableStatus,
    );
  }

  function renderSnapshotStatusOverride(
    snapshot: PanelSessionSnapshot,
    hasElements: boolean,
    activeWorkspaceRestoreNotice: { pageKey: string; message: string } | null,
    previewHasActionableStatus: boolean,
  ): void {
    if (
      !previewHasActionableStatus &&
      canRenderSelectionStatus(snapshot) &&
      elementSelectionEnabled
    ) {
      elements.status.textContent = t("selection_enabled");
    } else if (
      !previewHasActionableStatus &&
      canRenderSelectionStatus(snapshot) &&
      selectionStoppedStatusKey !== null
    ) {
      elements.status.textContent = formatSelectionStoppedStatus(hasElements, t);
    }
    if (pageAccessRecoveryStatus !== null) {
      elements.status.textContent = pageAccessRecoveryStatus;
    }
    if (activeWorkspaceRestoreNotice) {
      elements.status.textContent = activeWorkspaceRestoreNotice.message;
    }
  }

  function renderPageAccessRecovery(
    kind: PageAccessRecoveryKind | null,
    statusMessage?: string,
  ): void {
    pageAccessRecoveryKind = kind;
    pageAccessRecoveryStatus = kind === null
      ? null
      : statusMessage ?? pageAccessRecoveryStatus ?? elements.status.textContent;
    elements.pageAccessRecovery.hidden = kind === null;
    if (kind !== "permission") pageAccessAutomaticFeedback = null;
    renderPageAccessAutomaticAction();
    if (kind === null) return;
    if (pageAccessRecoveryStatus !== null) {
      elements.status.textContent = pageAccessRecoveryStatus;
    }
    const permission = kind === "permission";
    elements.pageAccessTemporaryPath.hidden = !permission;
    elements.pageAccessRecoveryHeading.textContent = permission
      ? t("page_access_recovery_heading")
      : t("page_access_content_heading");
    elements.pageAccessRecoveryReason.textContent = permission
      ? t("page_access_permission_reason")
      : t("page_access_content_reason");
    elements.pageAccessRecoveryFirstStep.textContent = permission
      ? t("page_access_step_keep_active")
      : t("page_access_step_reload");
  }

  function renderPageAccessAutomaticAction(): void {
    const visible = pageAccessRecoveryKind === "permission" && Boolean(deps.automaticPageAccess);
    elements.pageAccessAutomatic.hidden = !visible;
    elements.pageAccessEnableAutomatic.disabled = !visible || pageAccessAutomaticPending;
    elements.pageAccessEnableAutomatic.setAttribute(
      "aria-busy",
      pageAccessAutomaticPending ? "true" : "false",
    );
    elements.pageAccessEnableAutomatic.textContent = pageAccessAutomaticPending
      ? t("page_access_enabling_automatic")
      : t("page_access_enable_automatic");
    const feedback = pageAccessAutomaticFeedback === "denied"
      ? t("page_access_automatic_denied")
      : pageAccessAutomaticFeedback === "failed"
        ? t("page_access_automatic_failed")
        : pageAccessAutomaticFeedback === "not_ready"
          ? t("page_access_automatic_not_ready")
        : "";
    elements.pageAccessAutomaticStatus.textContent = feedback;
    elements.pageAccessAutomaticStatus.hidden = feedback.length === 0;
  }

  function renderActiveOriginAccessState(accessRequired: boolean): void {
    if (accessRequired) renderElementSelectionToggle(false);
    elements.elementSelectionToggle.disabled = accessRequired;
    renderPageAccessRecovery(
      accessRequired ? "permission" : null,
      accessRequired ? t("permission_recovery") : undefined,
    );
  }

  function syncCurrentRebindPage(activePage: ActivePageContext | null): void {
    const nextKey = currentPageKey(activePage);
    if (nextKey === currentRebindPageKey) return;
    if (workspaceRestoreNotice?.pageKey !== nextKey) workspaceRestoreNotice = null;
    currentRebindPageKey = nextKey;
    currentRebindStateKey = "checking";
    currentRebindObservedAt = null;
    currentRebindDocumentId = null;
    currentRebindUnavailable = false;
    currentRebindStatuses = new Map();
    currentRebindRequestRevision += 1;
    currentRebindRequestInFlight = null;
  }

  function getLiveCurrentItemIds(snapshot: PanelSessionSnapshot): ReadonlySet<string> {
    const pageKey = currentPageKey(snapshot.activePage);
    if (
      !pageKey ||
      currentRebindPageKey !== pageKey ||
      currentRebindUnavailable ||
      currentRebindObservedAt === null
    ) return new Set();
    return new Set(
      [...currentRebindStatuses.entries()]
        .filter(([, status]) => status === "restored")
        .map(([itemId]) => itemId),
    );
  }

  function getLiveExcludedItemIds(snapshot: PanelSessionSnapshot): ReadonlySet<string> {
    const pageKey = currentPageKey(snapshot.activePage);
    if (
      !pageKey ||
      currentRebindPageKey !== pageKey ||
      currentRebindUnavailable ||
      currentRebindObservedAt === null
    ) return new Set();
    return new Set(
      [...currentRebindStatuses.entries()]
        .filter(([, status]) => status !== "restored")
        .map(([itemId]) => itemId),
    );
  }

  function requestCurrentRebindStatus(snapshot: PanelSessionSnapshot, force = false): void {
    const activePage = snapshot.activePage;
    if (!deps.currentRebind || !activePage) return;
    syncCurrentRebindPage(activePage);
    const pageKey = currentPageKey(activePage);
    if (pageKey === null) return;
    if (force) {
      // An overlay sync establishes a newer causal boundary than any read that
      // started before it. Invalidate that older read and observe the exact
      // post-sync target set immediately.
      currentRebindRequestRevision += 1;
      currentRebindRequestInFlight = null;
    }
    const revision = currentRebindRequestRevision;
    if (
      currentRebindRequestInFlight?.revision === revision &&
      currentRebindRequestInFlight.pageKey === pageKey
    ) return;
    const request = { revision, pageKey };
    currentRebindRequestInFlight = request;
    let readResult: Promise<CurrentRebindObservation | null>;
    try {
      readResult = deps.currentRebind.read(activePage);
    } catch {
      readResult = Promise.resolve(null);
    }
    void readResult.then((data) => {
      if (currentRebindRequestInFlight === request) currentRebindRequestInFlight = null;
      if (
        revision !== currentRebindRequestRevision ||
        currentRebindPageKey !== pageKey ||
        currentPageKey(latestSnapshot.activePage) !== pageKey
      ) return;
      const observedData = data?.origin === activePage.origin &&
          data.pathname === activePage.pathname
        ? data
        : null;
      const nextDocumentId = observedData?.documentId ?? null;
      const nextStateKey = observedData === null
        ? "unavailable"
        : `${nextDocumentId ?? "unbound"}:${JSON.stringify(observedData.items)}`;
      const observedAt = observedData === null ? null : new Date().toISOString();
      if (nextStateKey === currentRebindStateKey) {
        // A repeated rebind read is fresh live evidence even when its result did
        // not change. Refresh the evidence clock without rendering or publishing
        // another identical snapshot.
        currentRebindObservedAt = observedAt;
        return;
      }
      currentRebindStateKey = nextStateKey;
      currentRebindObservedAt = observedAt;
      currentRebindDocumentId = nextDocumentId;
      currentRebindUnavailable = observedData === null;
      currentRebindStatuses = new Map(
        observedData?.items.map((item) => [item.itemId, item.status]) ?? [],
      );
      renderSnapshot(latestSnapshot);
      void requestLocalBridgePublish(latestSnapshot);
    }).catch(() => {
      if (currentRebindRequestInFlight === request) currentRebindRequestInFlight = null;
      if (
        revision !== currentRebindRequestRevision ||
        currentRebindPageKey !== pageKey ||
        currentPageKey(latestSnapshot.activePage) !== pageKey ||
        currentRebindStateKey === "unavailable"
      ) return;
      currentRebindStateKey = "unavailable";
      currentRebindObservedAt = null;
      currentRebindDocumentId = null;
      currentRebindUnavailable = true;
      currentRebindStatuses = new Map();
      renderSnapshot(latestSnapshot);
      void requestLocalBridgePublish(latestSnapshot);
    });
  }

  function getCurrentRebindStatus(
    itemId: string,
    currentPage: boolean,
  ): OverlayRebindStatus | "unavailable" | null {
    if (
      !deps.currentRebind ||
      currentRebindPageKey === null ||
      (!currentPage && !currentRebindStatuses.has(itemId))
    ) return null;
    if (currentRebindUnavailable) return "unavailable";
    return currentRebindStatuses.get(itemId) ?? (
      currentRebindStateKey === "checking" ? "checking" : "unavailable"
    );
  }

  function currentPageKey(activePage: ActivePageContext | null | undefined): string | null {
    return activePage
      ? `${activePage.tabId}:${activePage.frameId}:${activePage.origin}${activePage.pathname}:` +
        (activePage.documentId ?? "unbound")
      : null;
  }

  function requestOverlaySync(snapshot: PanelSessionSnapshot): void {
    if (!snapshot.origin || !deps.syncOverlays) return;
    const itemIds = snapshot.file?.session.attachments.map((item) => item.id).join(",") ?? "";
    const key = `${currentPageKey(snapshot.activePage) ?? "no-active-page"}|` +
      `${snapshot.origin}|${itemIds}|${snapshot.selectedItemId ?? ""}`;
    if (key === lastOverlaySyncKey || key === pendingOverlaySyncKey) return;
    pendingOverlaySyncKey = key;
    const revision = ++overlaySyncRevision;
    void deps.syncOverlays(snapshot.origin, snapshot.selectedItemId).then(() => {
      if (revision !== overlaySyncRevision) return;
      lastOverlaySyncKey = key;
      pendingOverlaySyncKey = null;
      if (isCurrentBridgeScopeObservationPending(latestSnapshot)) {
        requestCurrentRebindStatus(latestSnapshot, true);
      }
    }).catch(() => {
      if (revision !== overlaySyncRevision) return;
      pendingOverlaySyncKey = null;
      // Page overlays are best-effort and must not replace session/capture status truth.
      // Keep the key retryable so a later render can recover without a page refresh.
    });
  }

  function isCurrentBridgeScopeObservationPending(
    snapshot: PanelSessionSnapshot,
    scope: PanelCopyScope | null = snapshot.file
      ? derivePanelCopyScope(
          snapshot.file,
          snapshot.selectedItemId,
          snapshot.activePage,
          getLiveCurrentItemIds(snapshot),
          getLiveExcludedItemIds(snapshot),
        )
      : null,
    attachmentIds: readonly string[] = scope?.itemIds ?? [],
  ): boolean {
    const activePageKey = currentPageKey(snapshot.activePage);
    return Boolean(
      scope?.current &&
      deps.currentRebind &&
      !currentRebindUnavailable &&
      activePageKey &&
      currentRebindPageKey === activePageKey &&
      currentRebindObservedAt !== null &&
      currentRebindDocumentId !== null &&
      attachmentIds.some((attachmentId) => !currentRebindStatuses.has(attachmentId))
    );
  }

  function selectedCapturedPageRoute(record: OriginCaptureRecord | undefined): string | null {
    if (!record?.pageUrl) return null;
    try {
      const url = new URL(record.pageUrl);
      if (url.username || url.password || url.origin !== record.origin) return null;
      return canonicalStoredRouteUrl(url.origin, url.pathname);
    } catch {
      return null;
    }
  }

  function renderSelectedTargetSummary(
    row: ReturnType<typeof summarizePanelSessionRows>[number] | undefined,
    previewEnabled: boolean,
    snapshot: PanelSessionSnapshot,
  ): void {
    captureComparison?.sync(snapshot, previewEnabled);
    const previousItemId = elements.selectedTargetDetails.dataset.selectedItemId;
    elements.selectedTargetPage.textContent = "";
    elements.selectedTargetPageHelp.hidden = true;
    elements.selectedTargetOpenPage.hidden = true;
    elements.selectedTargetOpenPage.onclick = null;
    if (!row) {
      elements.selectedTargetSummary.hidden = true;
      elements.selectedTargetSummary.textContent = "";
      elements.selectedTargetDetails.hidden = true;
      elements.selectedTargetDetails.open = false;
      delete elements.selectedTargetDetails.dataset.selectedItemId;
      elements.selectedTargetFull.textContent = "";
      elements.selectedTargetCapturedAt.textContent = "";
      elements.selectedTargetSource.textContent = "";
      elements.selectedTargetRebindRow.hidden = true;
      elements.selectedTargetRebindStatus.textContent = "";
      delete elements.selectedTargetRebindStatus.dataset.state;
      return;
    }

    if (previousItemId !== row.id) elements.selectedTargetDetails.open = false;
    elements.selectedTargetDetails.dataset.selectedItemId = row.id;
    elements.selectedTargetSummary.hidden = false;
    elements.selectedTargetSummary.textContent = t("editing_target", {
      label: row.label,
      target: summarizeTargetKind(row.target),
    });
    elements.selectedTargetDetails.hidden = false;
    const record = findPanelSessionItem(snapshot.file, row.id)?.sourceRecord as OriginCaptureRecord | undefined;
    const capturedRoute = selectedCapturedPageRoute(record);
    elements.selectedTargetPage.textContent = capturedRoute ?? t("captured_page_unavailable");
    const foreignPage = Boolean(capturedRoute && record &&
      (!snapshot.activePage || !isCurrentPageRecord(record, snapshot.activePage)));
    elements.selectedTargetPageHelp.hidden = !foreignPage;
    elements.selectedTargetPageHelp.textContent = foreignPage ? t("captured_page_elsewhere") : "";
    elements.selectedTargetOpenPage.hidden = !foreignPage || !options.openSavedRoute;
    if (foreignPage && capturedRoute && options.openSavedRoute) {
      const itemId = row.id;
      const origin = snapshot.origin;
      const epoch = snapshot.epoch;
      elements.selectedTargetOpenPage.onclick = () => {
        // Recheck the source binding at click time; a stale selected-item handler
        // must not open a page belonging to a replaced session or selection.
        const current = findPanelSessionItem(latestSnapshot.file, itemId)?.sourceRecord as OriginCaptureRecord | undefined;
        if (latestSnapshot.selectedItemId !== itemId || latestSnapshot.origin !== origin || latestSnapshot.epoch !== epoch ||
            selectedCapturedPageRoute(current) !== capturedRoute) return;
        void runPanelAction(() => options.openSavedRoute!(capturedRoute));
      };
    }
    elements.selectedTargetFull.textContent = `${row.label} · ${row.target}`;
    elements.selectedTargetCapturedAt.textContent = formatDisplayTime(
      row.capturedAt,
      timeDisplayPreference,
    );
    elements.selectedTargetSource.textContent = formatDisclosureMode(
      row.sourceDisclosureMode,
      t,
    );
    const rebindStatus = getCurrentRebindStatus(row.id, previewEnabled);
    elements.selectedTargetRebindRow.hidden = rebindStatus === null;
    elements.selectedTargetRebindStatus.textContent = rebindStatus
      ? formatCurrentTargetStatus(rebindStatus, t)
      : "";
    if (rebindStatus) {
      elements.selectedTargetRebindStatus.dataset.state = rebindStatus;
    } else {
      delete elements.selectedTargetRebindStatus.dataset.state;
    }
  }

  function renderSessionRows(
    snapshot: PanelSessionSnapshot,
    groups: ReturnType<typeof groupPanelSessionRows>,
    clearPending: boolean,
  ): void {
    const context = JSON.stringify([snapshot.origin, snapshot.epoch]);
    if (context !== sessionGroupContext) {
      sessionGroupOpenStates.clear();
      sessionGroupSelectedItemId = null;
    } else {
      // Read the live DOM before rebuilding; native details toggles can precede
      // their queued toggle event when a session notification arrives.
      for (const group of elements.sessionList.querySelectorAll<HTMLDetailsElement>("details[data-session-group-key]")) {
        sessionGroupOpenStates.set(group.dataset.sessionGroupKey!, group.open);
      }
    }
    const selectionChanged = sessionGroupSelectedItemId !== snapshot.selectedItemId;
    sessionGroupContext = context;
    sessionGroupSelectedItemId = snapshot.selectedItemId;
    clearOverlayPreview();
    const rows = groups.flatMap((group) => group.rows);
    const currentCount = groups.find((group) => group.current)?.rows.length ?? 0;
    const elsewhereCount = rows.length - currentCount;
    elements.sessionCount.textContent = rows.length === 0
      ? t("session_count_total", { count: 0 })
      : snapshot.activePage
      ? elsewhereCount > 0
        ? t("session_count_current_elsewhere", {
            current: currentCount,
            elsewhere: elsewhereCount,
            total: rows.length,
          })
        : t("session_count_current", { current: currentCount })
      : t("session_count_total", { count: rows.length });
    elements.sessionList.replaceChildren();

    if (snapshot.activePage && currentCount === 0) {
      const empty = document.createElement("p");
      empty.className = "session-empty-current";
      empty.textContent = t("no_targets_page");
      elements.sessionList.append(empty);
    }

    for (const group of groups) {
      const details = document.createElement("details");
      details.className = `session-group${group.current ? " current" : ""}`;
      details.dataset.sessionGroupKey = group.key;
      const selected = group.rows.some((row) => row.selected);
      details.open = selectionChanged && selected
        ? true
        : sessionGroupOpenStates.get(group.key) ?? (group.current || selected);

      const summary = document.createElement("summary");
      summary.setAttribute(
        "aria-label",
        group.rows.length === 1
          ? t("session_group_aria_one", { label: localizeSessionGroupLabel(group.label, t) })
          : t("session_group_aria_many", {
              label: localizeSessionGroupLabel(group.label, t),
              count: group.rows.length,
            }),
      );
      summary.append(
        createSpan("session-group-label", localizeSessionGroupLabel(group.label, t)),
        createSpan("session-group-count", String(group.rows.length)),
      );
      const groupRows = document.createElement("div");
      groupRows.className = "session-group-rows";

      for (const row of group.rows) {
        groupRows.append(createSessionRow(snapshot, row, clearPending, group.current));
      }
      details.append(summary, groupRows);
      elements.sessionList.append(details);
    }
  }

  function createSessionRow(
    snapshot: PanelSessionSnapshot,
    row: ReturnType<typeof summarizePanelSessionRows>[number],
    clearPending: boolean,
    previewEnabled: boolean,
  ): HTMLDivElement {
      const wrapper = document.createElement("div");
      wrapper.className = "session-row";

      const select = document.createElement("button");
      select.type = "button";
      select.className = "session-select";
      select.dataset.itemId = row.id;
      select.setAttribute("aria-pressed", row.selected ? "true" : "false");
      select.disabled = snapshot.recovery !== null || clearPending;
      const hasTaskNote = getSessionItemIntent(snapshot, row.id).trim().length > 0;
      const labelRow = document.createElement("span");
      labelRow.className = "session-label-row";
      const taskNoteStatus = createSpan(
        "session-intent-status",
        hasTaskNote ? t("task_note_added") : t("task_note_missing"),
      );
      taskNoteStatus.dataset.state = hasTaskNote ? "complete" : "missing";
      labelRow.append(
        createSpan("session-label", `${row.label} · ${row.target}`),
        taskNoteStatus,
      );
      select.append(labelRow);
      const rebindStatus = getCurrentRebindStatus(row.id, previewEnabled);
      if (rebindStatus && rebindStatus !== "restored" && rebindStatus !== "checking") {
        const status = createSpan(
          "session-row-warning session-rebind-status",
          formatCurrentTargetStatus(rebindStatus, t),
        );
        status.dataset.state = rebindStatus;
        select.append(status);
      }
      select.addEventListener("click", () => {
        void runPanelAction(() => options.controller.selectItem(row.id));
      });
      if (previewEnabled) {
        select.addEventListener("pointerenter", () => {
          hoveredPreviewItemId = row.id;
          updateOverlayPreview();
        });
        select.addEventListener("pointerleave", () => {
          if (hoveredPreviewItemId === row.id) hoveredPreviewItemId = null;
          updateOverlayPreview();
        });
        select.addEventListener("focus", () => {
          focusedPreviewItemId = row.id;
          updateOverlayPreview();
        });
        select.addEventListener("blur", () => {
          if (focusedPreviewItemId === row.id) focusedPreviewItemId = null;
          updateOverlayPreview();
        });
      }

      wrapper.append(select);
      return wrapper;
  }

  function updateOverlayPreview(): void {
    const relationPair = getRelationActionPreviewPair();
    const origin = latestSnapshot.origin;
    if (relationPair && origin && deps.previewRelationOverlay) {
      const key = `relation:${relationPair.sourceItemId}:${relationPair.referenceItemId}`;
      if (previewedOverlayOrigin === origin && previewedOverlayKey === key) return;
      if (previewedOverlayOrigin && previewedOverlayOrigin !== origin) {
        requestOverlayPreview(previewedOverlayOrigin, null);
      }
      previewedOverlayOrigin = origin;
      previewedOverlayKey = key;
      requestRelationOverlayPreview(
        origin,
        relationPair.sourceItemId,
        relationPair.referenceItemId,
      );
      return;
    }

    const nextItemId = relationPreviewItemId ?? hoveredPreviewItemId ?? focusedPreviewItemId;
    if (!nextItemId) {
      clearOverlayPreview();
      return;
    }
    if (!origin || !deps.previewOverlay) return;
    const key = `single:${nextItemId}`;
    if (previewedOverlayOrigin === origin && previewedOverlayKey === key) return;
    if (previewedOverlayOrigin && previewedOverlayOrigin !== origin) {
      requestOverlayPreview(previewedOverlayOrigin, null);
    }
    previewedOverlayOrigin = origin;
    previewedOverlayKey = key;
    requestOverlayPreview(origin, nextItemId);
  }

  function clearOverlayPreview(): void {
    hoveredPreviewItemId = null;
    focusedPreviewItemId = null;
    relationPreviewItemId = null;
    hoveredRelationAction = null;
    focusedRelationAction = null;
    if (!previewedOverlayOrigin || !previewedOverlayKey) return;
    const origin = previewedOverlayOrigin;
    previewedOverlayOrigin = null;
    previewedOverlayKey = null;
    requestOverlayPreview(origin, null);
  }

  function requestOverlayPreview(origin: string, itemId: string | null): void {
    void deps.previewOverlay?.(origin, itemId).catch(() => {
      // Ephemeral page emphasis is best-effort and never changes panel status truth.
    });
  }

  function requestRelationOverlayPreview(
    origin: string,
    sourceItemId: string,
    referenceItemId: string,
  ): void {
    void deps.previewRelationOverlay?.(origin, sourceItemId, referenceItemId).catch(() => {
      // Ephemeral page emphasis is best-effort and never changes panel status truth.
    });
  }

  function wireRelationActionPreview(actionButton: HTMLButtonElement): void {
    actionButton.addEventListener("pointerenter", () => {
      hoveredRelationAction = actionButton;
      updateOverlayPreview();
    });
    actionButton.addEventListener("pointerleave", () => {
      if (hoveredRelationAction === actionButton) hoveredRelationAction = null;
      updateOverlayPreview();
    });
    actionButton.addEventListener("focus", () => {
      focusedRelationAction = actionButton;
      updateOverlayPreview();
    });
    actionButton.addEventListener("blur", (event) => {
      const next = event.relatedTarget;
      focusedRelationAction = isRelationActionButton(next) ? next : null;
      updateOverlayPreview();
    });
  }

  function getRelationActionPreviewPair(): {
    sourceItemId: string;
    referenceItemId: string;
  } | null {
    const action = hoveredRelationAction ?? focusedRelationAction;
    if (!action || action.disabled || !relationModel) return null;
    const sourceItemId = latestSnapshot.selectedItemId;
    const referenceItemId = elements.relationReference.value;
    if (
      !sourceItemId ||
      sourceItemId === referenceItemId ||
      !relationModel.targets.some((target) => target.itemId === sourceItemId) ||
      !relationModel.targets.some((target) => target.itemId === referenceItemId)
    ) {
      return null;
    }
    return { sourceItemId, referenceItemId };
  }

  function isRelationActionButton(value: EventTarget | null): value is HTMLButtonElement {
    return value === elements.applyRelation;
  }

  function wireRelationPreview(select: HTMLSelectElement): void {
    select.addEventListener("focus", () => {
      updateFocusedRelationPreview(select);
    });
    select.addEventListener("blur", (event) => {
      const next = event.relatedTarget;
      if (
        next instanceof HTMLSelectElement
        && next === elements.relationReference
      ) {
        setRelationPreview(next);
        return;
      }
      if (isRelationActionButton(next)) {
        relationPreviewItemId = null;
        focusedRelationAction = next;
        updateOverlayPreview();
        return;
      }
      relationPreviewItemId = null;
      updateOverlayPreview();
    });
  }

  function updateFocusedRelationPreview(select: HTMLSelectElement): void {
    if (select.disabled || document.activeElement !== select) return;
    setRelationPreview(select);
  }

  function setRelationPreview(select: HTMLSelectElement): void {
    const itemId = select.value;
    if (
      select.disabled ||
      !relationModel?.targets.some((target) => target.itemId === itemId)
    ) {
      relationPreviewItemId = null;
      updateOverlayPreview();
      return;
    }
    relationPreviewItemId = itemId;
    updateOverlayPreview();
  }

  function renderRelationComposer(
    rows: ReturnType<typeof summarizePanelSessionRows>,
    snapshot: PanelSessionSnapshot,
  ): void {
    const previousReference = elements.relationReference.value;
    const nextRelationModel = buildPanelRelationModel(rows);
    relationModel = nextRelationModel?.targets.some(
      (target) => target.itemId === snapshot.selectedItemId,
    )
      ? nextRelationModel
      : null;
    elements.relationComposer.hidden = relationModel === null;
    updateOptionalSettingsVisibility();
    elements.relationReference.replaceChildren();
    if (!relationModel) {
      elements.relationAction.disabled = true;
      elements.relationReference.disabled = true;
      elements.applyRelation.disabled = true;
      elements.relationRoleSummary.hidden = true;
      elements.relationRoleSummary.textContent = "";
      clearRelationApplyFeedback();
      setGeneratedRelationChangeAvailable(false);
      return;
    }

    for (const target of relationModel.targets) {
      if (target.itemId === snapshot.selectedItemId) continue;
      elements.relationReference.append(createRelationOption(target));
    }
    const validIds = new Set(Array.from(
      elements.relationReference.options,
      (option) => option.value,
    ));
    elements.relationReference.value = validIds.has(previousReference)
      ? previousReference
      : elements.relationReference.options[0]?.value ?? "";
    renderRelationRoleSummary(snapshot);

    const relationControlsDisabled = (
      isIntentDisabled(snapshot) || snapshot.intent.trim().length > 0
    );
    elements.relationAction.disabled = relationControlsDisabled;
    elements.relationReference.disabled = relationControlsDisabled;
    elements.applyRelation.disabled = relationControlsDisabled;
    setGeneratedRelationChangeAvailable(
      !isIntentDisabled(snapshot) && isCurrentGeneratedRelation(snapshot),
    );
  }

  function clearRelationApplyFeedback(): void {
    relationApplyFeedback = null;
    elements.relationApplyStatus.hidden = true;
    elements.relationApplyStatus.textContent = "";
  }

  function renderRelationRoleSummary(snapshot: PanelSessionSnapshot): void {
    const source = relationModel?.targets.find(
      (target) => target.itemId === snapshot.selectedItemId,
    );
    const reference = relationModel?.targets.find(
      (target) => target.itemId === elements.relationReference.value,
    );
    if (!source || !reference) {
      elements.relationRoleSummary.hidden = true;
      elements.relationRoleSummary.textContent = "";
      clearRelationApplyFeedback();
      return;
    }

    elements.relationRoleSummary.textContent = t("relation_role_summary", {
      source: source.label,
      reference: reference.label,
    });
    elements.relationRoleSummary.hidden = false;

    const feedback = relationApplyFeedback;
    if (
      !feedback ||
      feedback.sourceItemId !== source.itemId ||
      feedback.referenceItemId !== reference.itemId
    ) {
      clearRelationApplyFeedback();
      return;
    }
    elements.relationApplyStatus.textContent = t("relation_applied_feedback", {
      source: source.label,
      reference: reference.label,
    });
    elements.relationApplyStatus.hidden = false;
  }

  function renderRelationShortcutOptions(): void {
    const previous = elements.relationAction.value;
    elements.relationAction.querySelectorAll("option[data-custom-relation-shortcut]")
      .forEach((option) => option.remove());
    for (const shortcut of relationShortcuts) {
      const option = document.createElement("option");
      option.value = `custom:${shortcut.id}`;
      option.textContent = shortcut.label;
      option.dataset.customRelationShortcut = shortcut.id;
      elements.relationAction.append(option);
    }
    const available = new Set(Array.from(elements.relationAction.options, (option) => option.value));
    elements.relationAction.value = available.has(previous)
      ? previous
      : elements.relationAction.options[0]?.value ?? "";
  }

  function parseRelationShortcutValue(
    value: string,
  ): PanelRelationAction | RelationShortcutPreference | null {
    if (isPanelRelationAction(value)) return value;
    if (!value.startsWith("custom:")) return null;
    return findRelationShortcut(value.slice("custom:".length));
  }

  function findRelationShortcut(id: string): RelationShortcutPreference | null {
    return relationShortcuts.find((shortcut) => shortcut.id === id) ?? null;
  }

  function setGeneratedRelationChangeAvailable(available: boolean): void {
    elements.changeGeneratedRelation.hidden = !available;
    elements.changeGeneratedRelation.disabled = !available;
  }

  function isCurrentGeneratedRelation(snapshot: PanelSessionSnapshot): boolean {
    return generatedRelationIntent !== null
      && snapshot.intent === generatedRelationIntent.intent
      && snapshot.origin === generatedRelationIntent.origin
      && snapshot.epoch === generatedRelationIntent.epoch
      && snapshot.selectedItemId === generatedRelationIntent.selectedItemId;
  }

  function renderSelectedPreview(
    snapshot: PanelSessionSnapshot,
    legacyRecord: OriginCaptureRecord | null,
  ): boolean {
    const result = derivePanelSessionPreview({
      file: snapshot.file,
      legacyRecord,
      selectedItemId: snapshot.selectedItemId,
      viewMode: snapshot.viewMode,
    });
    if (!result.ok) {
      const fallbackRecord = findPreviewFallbackRecord(snapshot, legacyRecord);
      if (!fallbackRecord) {
        clearCaptureDetails();
        if (
          snapshot.file &&
          snapshot.selectedItemId &&
          pageAccessRecoveryStatus === null &&
          canPreviewStatusOverride(snapshot)
        ) {
          elements.status.textContent = localizeKnownStatus(result.status, t);
        }
        return hasActionableSelectedPreviewStatus(snapshot);
      }
      renderCapture(fallbackRecord, localizeKnownStatus(result.status, t));
      return true;
    }

    renderCapture(
      result.record as OriginCaptureRecord,
      localizeKnownStatus(result.status, t),
    );
    return false;
  }

  function hasActionableSelectedPreviewStatus(snapshot: PanelSessionSnapshot): boolean {
    const legacyRecord = getSameOriginLegacyRecord(snapshot);
    const result = derivePanelSessionPreview({
      file: snapshot.file,
      legacyRecord,
      selectedItemId: snapshot.selectedItemId,
      viewMode: snapshot.viewMode,
    });
    if (result.ok) return false;
    return findPreviewFallbackRecord(snapshot, legacyRecord) !== null || Boolean(
      snapshot.file &&
      snapshot.selectedItemId &&
      pageAccessRecoveryStatus === null &&
      canPreviewStatusOverride(snapshot)
    );
  }

  function findPreviewFallbackRecord(
    snapshot: PanelSessionSnapshot,
    legacyRecord: OriginCaptureRecord | null,
  ): OriginCaptureRecord | null {
    const item = findPanelSessionItem(snapshot.file, snapshot.selectedItemId);
    if (item) return item.sourceRecord as OriginCaptureRecord;
    return legacyRecord;
  }

  function canPreviewStatusOverride(snapshot: PanelSessionSnapshot): boolean {
    return (
      snapshot.status.kind === "ready" &&
      snapshot.recovery === null &&
      !snapshot.clearPending &&
      (snapshot.status.message === "Capture session ready." ||
        snapshot.status.message === "Selected element preview ready.")
    );
  }

  function renderCapture(record: OriginCaptureRecord, statusText?: string): void {
    currentRecord = {
      ...record,
      intent: latestSnapshot.intent,
    };
    currentMarkdown = record.markdown;
    currentSummary = record.summary ?? "";
    if (
      statusText &&
      latestSnapshot.file &&
      pageAccessRecoveryStatus === null &&
      canPreviewStatusOverride(latestSnapshot)
    ) {
      elements.status.textContent = statusText;
    }
    elements.capture.hidden = false;
    elements.elementSummary.textContent = summarizeElement(record.attachment, t);
    const locatorSummary = summarizeLocator(record.attachment, t);
    const selectedRebindStatus = latestSnapshot.activePage &&
        latestSnapshot.selectedItemId &&
        isCurrentPageRecord(record, latestSnapshot.activePage)
      ? getCurrentRebindStatus(latestSnapshot.selectedItemId, true)
      : null;
    elements.locatorSummary.textContent = selectedRebindStatus
      ? `${locatorSummary} · ${formatCurrentTargetStatus(selectedRebindStatus, t)}`
      : locatorSummary;
    const boundary = formatCaptureBoundaryView(record.attachment, t);
    elements.captureBoundary.hidden = boundary === null;
    elements.captureBoundaryTitle.textContent = boundary?.title ?? "";
    elements.captureBoundaryMessage.textContent = boundary?.message ?? "";
    const metadata = formatCaptureMetadata({
      capturedAt: record.capturedAt,
      redactedFields: record.attachment.policy.redactedFields ?? [],
      sensitiveHints: record.attachment.policy.sensitiveHints ?? [],
      includedSensitiveFields: record.attachment.policy.includedSensitiveFields ?? [],
    }, t, timeDisplayPreference);
    elements.capturedAt.textContent = metadata.capturedAt;
    elements.redactedFields.textContent = metadata.redactedFields;
    elements.sensitiveHints.textContent = metadata.sensitiveHints;
    elements.includedSensitiveFields.textContent = metadata.includedSensitiveFields;
    elements.intent.value = latestSnapshot.intent;
    elements.agentSummary.value = currentSummary;
    elements.json.value = JSON.stringify(record.attachment, null, 2);
    updatePromptMarkdown();
  }

  function clearCaptureDetails(): void {
    currentRecord = null;
    currentMarkdown = "";
    currentSummary = "";
    elements.capture.hidden = true;
    elements.elementSummary.textContent = "";
    elements.locatorSummary.textContent = "";
    elements.captureBoundary.hidden = true;
    elements.captureBoundaryTitle.textContent = "";
    elements.captureBoundaryMessage.textContent = "";
    elements.capturedAt.textContent = "";
    elements.redactedFields.textContent = "";
    elements.sensitiveHints.textContent = "";
    elements.includedSensitiveFields.textContent = "";
    elements.intent.value = "";
    relationModel = null;
    elements.relationComposer.hidden = true;
    elements.agentSummary.value = "";
    elements.markdown.value = "";
    elements.json.value = "";
    elements.agentHandoffText.value = "";
    handoffFormat = "exact";
    elements.handoffFormat.value = handoffFormat;
    elements.handoffFormatField.hidden = true;
    elements.handoffOptions.hidden = true;
    elements.agentHandoffPreview.open = false;
    updateOptionalSettingsVisibility();
  }

  function updatePromptMarkdown(): void {
    if (!currentRecord) return;
    elements.markdown.value = composePanelMarkdown(
      currentMarkdown,
      elements.intent.value,
      currentSummary,
    );
    updateAgentHandoffPreview();
  }

  function renderHandoffScope(snapshot: PanelSessionSnapshot, blocked: boolean): void {
    const copyScope = snapshot.file
      ? derivePanelCopyScope(
          snapshot.file,
          snapshot.selectedItemId,
          snapshot.activePage,
          getLiveCurrentItemIds(snapshot),
          getLiveExcludedItemIds(snapshot),
        )
      : null;
    const attachmentIds = snapshot.file
      ? copyScope?.itemIds ?? []
      : currentRecord ? [currentRecord.attachment.id] : [];
    const count = attachmentIds.length;
    handoffAttachmentCount = count;
    const supportsCompact = count > 0 && snapshot.file !== null;
    const nextFormat = !supportsCompact
      ? "exact"
      : count > 1
        ? preferredMultiTargetHandoffFormat
        : preferredSingleTargetHandoffFormat;
    const formatChanged = handoffFormat !== nextFormat;
    handoffFormat = nextFormat;
    elements.handoffOptions.hidden = count === 0;
    if (count === 0) elements.agentHandoffPreview.open = false;
    updateOptionalSettingsVisibility();
    elements.handoffFormatField.hidden = !supportsCompact;
    elements.handoffFormat.disabled = blocked || !supportsCompact;
    elements.handoffFormat.value = handoffFormat;
    const elsewhere = Math.max(0, (snapshot.file?.session.attachments.length ?? count) - count);
    const attachmentIdSet = new Set(attachmentIds);
    const taskCount = snapshot.file
      ? snapshot.file.session.attachments.reduce((total, item) => {
          if (!attachmentIdSet.has(item.id)) return total;
          const intent = item.id === snapshot.selectedItemId
            ? snapshot.intent
            : item.sourceRecord.intent;
          return total + Number(intent.trim().length > 0);
        }, 0)
      : Number(count > 0 && elements.intent.value.trim().length > 0);
    const contextCount = Math.max(0, count - taskCount);
    handoffTaskCount = taskCount;
    elements.copySummary.textContent = count > 0
      ? t("copy_for_agent_count", { count })
      : t("copy_for_agent");
    elements.copySummary.disabled = blocked || count === 0;
    renderPrimaryActionHierarchy();
    elements.handoffScopeSummary.hidden = count === 0;
    const taskNoteSummary = taskCount === 0
      ? t("handoff_scope_none_noted")
      : taskCount === count
        ? t("handoff_scope_all_noted")
        : t(
            contextCount === 1
              ? "handoff_scope_partially_noted_one"
              : "handoff_scope_partially_noted_many",
            { taskCount, count, contextCount },
          );
    elements.handoffScopeSummary.textContent = count === 0
      ? ""
      : [
          count === 1 ? t("handoff_scope_one") : t("handoff_scope_many", { count }),
          taskNoteSummary,
          elsewhere > 0 ? t("handoff_scope_elsewhere", { count: elsewhere }) : "",
        ].filter(Boolean).join(" ");
    if (formatChanged) updateAgentHandoffPreview();
  }

  function getAgentHandoffAttachmentIds(
    snapshot: PanelSessionSnapshot = latestSnapshot,
    record: OriginCaptureRecord | null = currentRecord,
  ): string[] {
    if (snapshot.file) {
      return derivePanelCopyScope(
        snapshot.file,
        snapshot.selectedItemId,
        snapshot.activePage,
        getLiveCurrentItemIds(snapshot),
        getLiveExcludedItemIds(snapshot),
      )?.itemIds ?? [];
    }
    return record ? [record.attachment.id] : [];
  }

  function updateAgentHandoffPreview(): ReturnType<typeof buildPanelAgentCopy> | null {
    if (!currentRecord) {
      elements.agentHandoffText.value = "";
      clearAgentHandoffCopyStatus();
      return null;
    }
    const result = buildPanelAgentCopy({
      file: latestSnapshot.file,
      attachmentIds: getAgentHandoffAttachmentIds(),
      selectedItemId: latestSnapshot.selectedItemId,
      selectedRecord: currentRecord,
      viewMode: latestSnapshot.viewMode,
      intent: elements.intent.value,
      format: handoffFormat,
    }, t);
    const nextHandoff = result.ok ? result.text : "";
    elements.agentHandoffText.value = nextHandoff;
    if (
      agentHandoffCopyFeedbackFor !== null &&
      agentHandoffCopyFeedbackFor !== nextHandoff
    ) {
      clearAgentHandoffCopyStatus();
    }
    return result;
  }

  function clearAgentHandoffCopyStatus(): void {
    agentHandoffCopyFeedbackFor = null;
    elements.agentHandoffCopyStatus.textContent = "";
    elements.agentHandoffCopyStatus.hidden = true;
    elements.agentHandoffCopyNextStep.textContent = "";
    elements.agentHandoffCopyNextStep.hidden = true;
  }

  function showAgentHandoffCopyStatus(
    handoff: string,
    message: string,
    nextStep?: string,
  ): void {
    agentHandoffCopyFeedbackFor = handoff;
    elements.agentHandoffCopyStatus.textContent = message;
    elements.agentHandoffCopyStatus.hidden = false;
    elements.agentHandoffCopyNextStep.textContent = nextStep ?? "";
    elements.agentHandoffCopyNextStep.hidden = !nextStep;
  }

  function showAgentHandoffManualFallback(attemptedHandoff: string): void {
    elements.agentHandoffText.value = attemptedHandoff;
    elements.optionalSettings.open = true;
    elements.agentHandoffPreview.open = true;
    elements.agentHandoffText.focus();
    elements.agentHandoffText.select();
  }

  function updateOptionalSettingsVisibility(): void {
    elements.relationSettings.hidden = elements.relationComposer.hidden;
    if (elements.relationSettings.hidden) elements.relationSettings.open = false;
    elements.optionalSettings.hidden = elements.handoffOptions.hidden;
    if (elements.optionalSettings.hidden) elements.optionalSettings.open = false;
  }

  async function removeItem(itemId: string): Promise<void> {
    const selectedDirty = latestSnapshot.intentDirty && itemId === latestSnapshot.selectedItemId;
    if (selectedDirty) {
      const confirmed = options.confirm(t("confirm_discard_intent"));
      if (!confirmed) return;
      await options.controller.discardDirtyIntent();
    }
    await options.controller.removeItem(itemId);
    await refreshStoredSessions();
  }

  async function clearSession(): Promise<void> {
    const confirmed = options.confirm(
      latestSnapshot.intentDirty
        ? t("confirm_clear_selection_dirty")
        : t("confirm_clear_selection"),
    );
    if (!confirmed) return;
    if (latestSnapshot.intentDirty) {
      await options.controller.discardDirtyIntent();
    }
    const operationId = latestSnapshot.clearPending
      ? latestSnapshot.activeClearOperationId
      : options.randomUUID();
    if (!operationId) return;
    await options.controller.clearSession(operationId);
    await refreshStoredSessions();
  }

  async function clearLocalBridgePanelContext(): Promise<void> {
    if (!deps.localBridge || (!localBridgeStatus.connected && !localBridgeStatus.pending)) return;
    const cleared = await deps.localBridge.clearPanelContext();
    localBridgeShareState = cleared ? "unavailable" : "clear_failed";
    if (cleared && localBridgeStatus.connected) {
      try {
        localBridgeStatus = await deps.localBridge.readStatus();
      } catch {
        localBridgeStatus = {
          ...localBridgeStatus,
          readAcknowledgementState: "unavailable",
        };
      }
    }
    renderLocalBridgeStatus(localBridgeStatus);
  }

  async function exportSession(): Promise<void> {
    const result = await options.controller.readExport();
    if (!result.ok) {
      elements.status.textContent = formatExportError(result.error, result.error, t);
      return;
    }

    if (requiresSourceExportConfirmation(result.value.file)) {
      const warning = createSourceExportWarning(result.value.file, t);
      if (!options.confirm(warning)) return;
    }

    const blob = new Blob([result.value.text], { type: "application/json" });
    const url = options.createObjectURL(blob);
    try {
      const anchor = document.createElement("a");
      const filename = createSessionExportFilename(result.value.file.session.origin, new Date());
      anchor.href = url;
      anchor.download = filename;
      document.body.append(anchor);
      anchor.click();
      anchor.remove();
      elements.status.textContent = formatPanelStatus("export-started", filename, t);
    } catch (error) {
      options.revokeObjectURL(url);
      throw error;
    }
    options.setTimeout(() => options.revokeObjectURL(url), 0);
  }

  async function copyText(
    value: string,
    successMessage: string,
    onFailure?: () => void,
    failureMessage = t("clipboard_failed"),
  ): Promise<void> {
    try {
      await options.clipboard.writeText(value);
      elements.status.textContent = formatPanelStatus("copied", successMessage, t);
    } catch {
      onFailure?.();
      elements.status.textContent = failureMessage;
    }
  }

  async function copyAgentHandoff(
    value: string,
    successMessage: string,
    nextStep: string,
  ): Promise<void> {
    try {
      await options.clipboard.writeText(value);
      const message = formatPanelStatus("copied", successMessage, t);
      if (elements.agentHandoffText.value === value) {
        showAgentHandoffCopyStatus(value, message, nextStep);
      }
    } catch {
      showAgentHandoffManualFallback(value);
      const message = t("agent_handoff_clipboard_failed");
      elements.status.textContent = message;
      showAgentHandoffCopyStatus(value, message);
    }
  }
}

function getSessionItemIntent(snapshot: PanelSessionSnapshot, itemId: string): string {
  if (itemId === snapshot.selectedItemId) return snapshot.intent;
  const item = snapshot.file?.session.attachments.find((candidate) => candidate.id === itemId);
  return (item?.sourceRecord as OriginCaptureRecord | undefined)?.intent ?? "";
}

function applyPanelSurfaceProfile(
  root: Document,
  surfaceProfile: ExtensionSurfaceProfile,
): void {
  for (const element of root.querySelectorAll<HTMLElement>("[data-developer-tooling]")) {
    element.hidden = surfaceProfile === "consumer";
    if (element.hidden && element instanceof HTMLDetailsElement) element.open = false;
  }
}

function createRuntimeSessionClient(): PanelSessionClient {
  return {
    getActive: () => sendSessionCommand<ActiveSessionCommandData>({ type: "ui-attach:session-get-active" }),
    updateIntent: (origin, epoch, itemId, intent) =>
      sendSessionCommand<ActiveSessionReadback>({
        type: "ui-attach:session-update-intent",
        origin,
        epoch,
        itemId,
        intent,
      }),
    updateAnnotationLifecycle: (
      origin,
      epoch,
      itemId,
      annotationId,
      expectedState,
      nextState,
    ) => sendSessionCommand<ActiveSessionReadback>({
      type: "ui-attach:session-update-annotation-lifecycle",
      origin,
      epoch,
      itemId,
      annotationId,
      expectedState,
      nextState,
    }),
    removeItem: (origin, epoch, itemId) =>
      sendSessionCommand<ActiveSessionReadback>({
        type: "ui-attach:session-remove-item",
        origin,
        epoch,
        itemId,
      }),
    clear: (origin, epoch, operationId) =>
      sendSessionCommand<ActiveSessionReadback>({
        type: "ui-attach:session-clear",
        origin,
        epoch,
        operationId,
      }),
  };
}

async function sendSessionCommand<T>(
  command: SessionCommand,
): Promise<SessionCommandResponse<T>> {
  let response: unknown;
  try {
    response = await chrome.runtime.sendMessage(command);
  } catch {
    return {
      ok: false,
      code: "RUNTIME_ERROR",
      error: SAFE_PANEL_ERROR,
    };
  }
  if (isSessionCommandResponse<T>(response)) {
    return response;
  }
  return {
    ok: false,
    code: "INVALID_SESSION_RESPONSE",
    error: "Invalid ui-attach session response.",
  };
}

async function readElementSelectionEnabled(): Promise<boolean> {
  const result = await sendSessionCommand<{ enabled: boolean }>({
    type: "ui-attach:element-selection-get",
  });
  if (!result.ok) throw new Error(formatElementSelectionFailureStatus(result.code));
  if (!isElementSelectionData(result.data)) {
    throw new Error(formatElementSelectionFailureStatus("INVALID_SESSION_RESPONSE"));
  }
  return result.data.enabled;
}

async function saveElementSelectionEnabled(enabled: boolean): Promise<void> {
  let command: Extract<SessionCommand, { type: "ui-attach:element-selection-set" }>;
  if (enabled) {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (typeof tab?.id !== "number" || !Number.isInteger(tab.id) || tab.id < 0) {
      throw new Error(formatElementSelectionFailureStatus("ACTIVE_PAGE_UNAVAILABLE"));
    }
    command = { type: "ui-attach:element-selection-set", enabled: true, tabId: tab.id };
  } else {
    command = { type: "ui-attach:element-selection-set", enabled: false };
  }
  const result = await sendSessionCommand<{ enabled: boolean }>(command);
  if (!result.ok) throw new Error(formatElementSelectionFailureStatus(result.code));
  if (!isElementSelectionData(result.data)) {
    throw new Error(formatElementSelectionFailureStatus("INVALID_SESSION_RESPONSE"));
  }
}

function isElementSelectionData(value: unknown): value is { enabled: boolean } {
  return isRecord(value) &&
    Object.keys(value).every((key) => key === "enabled") &&
    typeof value.enabled === "boolean";
}

function isElementSelectionUpdatedMessage(
  value: unknown,
): value is { type: typeof UI_ATTACH_ELEMENT_SELECTION_UPDATED; enabled: boolean } {
  return isRecord(value) &&
    Object.keys(value).every((key) => key === "type" || key === "enabled") &&
    value.type === UI_ATTACH_ELEMENT_SELECTION_UPDATED &&
    typeof value.enabled === "boolean";
}

function isSettingsUpdatedMessage(message: unknown): boolean {
  return (
    typeof message === "object" &&
    message !== null &&
    "type" in message &&
    message.type === UI_ATTACH_SETTINGS_UPDATED
  );
}

function isSessionCommandResponse<T>(value: unknown): value is SessionCommandResponse<T> {
  if (!isRecord(value) || typeof value.ok !== "boolean") return false;
  if (value.ok) return "data" in value;
  return typeof value.code === "string" && typeof value.error === "string";
}

function isStoredSessionHandoffData(value: unknown): value is StoredSessionHandoffData {
  if (!isRecord(value)) return false;
  const expectedKeys = [
    "bundle",
    "epoch",
    "format",
    "origin",
  ];
  if (Object.keys(value).sort().join("\0") !== expectedKeys.join("\0")) return false;
  const bundle = value.bundle;
  if (
    typeof value.origin !== "string" ||
    typeof value.epoch !== "string" ||
    value.epoch.length === 0 ||
    value.epoch.length > 256 ||
    (value.format !== "exact" && value.format !== "compact") ||
    !isRecord(bundle)
  ) return false;
  const bundleKeys = [
    "attachmentCount",
    "attachmentIds",
    "attachmentRefs",
    "authority",
    "disclosureMode",
    "kind",
    "markdown",
    "sessionId",
    "title",
  ];
  if (Object.keys(bundle).sort().join("\0") !== bundleKeys.join("\0")) return false;
  if (
    bundle.kind !== "ui-attach.saved-snapshot-prompt-bundle" ||
    bundle.disclosureMode !== "agent_safe" ||
    typeof bundle.sessionId !== "string" ||
    bundle.sessionId.trim().length === 0 ||
    bundle.sessionId.length > 256 ||
    !(bundle.title === null || typeof bundle.title === "string") ||
    typeof bundle.attachmentCount !== "number" ||
    !Number.isInteger(bundle.attachmentCount) ||
    bundle.attachmentCount < 1 ||
    bundle.attachmentCount > 26 ||
    !Array.isArray(bundle.attachmentIds) ||
    !Array.isArray(bundle.attachmentRefs) ||
    typeof bundle.markdown !== "string" ||
    bundle.markdown.length === 0 ||
    new TextEncoder().encode(bundle.markdown).byteLength >
      EXTENSION_SAVED_SNAPSHOT_MAX_MARKDOWN_BYTES ||
    !bundle.markdown.includes("ui-attach.saved-snapshot-authority") ||
    !bundle.markdown.includes("not_rechecked") ||
    /pageInstanceId|"tabId"|"frameId"|## Local Page Routing|ui-attach\.page-routing-hint/u
      .test(bundle.markdown) ||
    !isRecord(bundle.authority)
  ) return false;
  const attachmentIds = bundle.attachmentIds;
  const attachmentRefs = bundle.attachmentRefs;
  if (
    attachmentIds.length !== bundle.attachmentCount ||
    attachmentIds.some((id) => typeof id !== "string" || !SAVED_ATTACHMENT_ID.test(id)) ||
    new Set(attachmentIds).size !== attachmentIds.length ||
    attachmentRefs.length !== bundle.attachmentCount ||
    attachmentRefs.some((ref, index) => !isSavedAttachmentRef(
      ref,
      attachmentIds[index] as string,
    ))
  ) return false;
  if ((bundle.attachmentCount === 1) !== (value.format === "exact")) return false;
  if (
    new TextEncoder().encode(serializeSavedSnapshotPromptBundleJson(
      bundle as unknown as StoredSessionHandoffData["bundle"],
    )).byteLength > EXTENSION_SAVED_SNAPSHOT_MAX_BUNDLE_JSON_BYTES
  ) return false;
  const authorityKeys = [
    "controlPolicy",
    "evidencePolicy",
    "kind",
    "origin",
    "routingPolicy",
    "schemaVersion",
    "status",
  ];
  const authority = bundle.authority;
  return Object.keys(authority).sort().join("\0") === authorityKeys.join("\0") &&
    authority.schemaVersion === "0.1.0" &&
    authority.kind === "ui-attach.saved-snapshot-authority" &&
    authority.status === "not_rechecked" &&
    authority.origin === value.origin &&
    authority.routingPolicy === "omitted" &&
    authority.evidencePolicy === "capture_time_observations_only" &&
    authority.controlPolicy === "live_recheck_and_user_confirmation_required";
}

function isSavedAttachmentRef(value: unknown, expectedId: string): boolean {
  if (!isRecord(value)) return false;
  if (Object.keys(value).sort().join("\0") !== SAVED_ATTACHMENT_REF_KEYS.join("\0")) return false;
  return value.id === expectedId &&
    typeof value.label === "string" &&
    typeof value.target === "string" &&
    isNullableString(value.role) &&
    isNullableString(value.accessibleName) &&
    isNullableString(value.text) &&
    isNullableString(value.primaryLocator);
}

function isNullableString(value: unknown): boolean {
  return value === null || typeof value === "string";
}

function parseSessionRefreshMessage(
  message: unknown,
): {
  accessRequired: boolean;
  activeOriginChange: boolean;
  preferredItemId?: string;
  origin?: string;
} | null {
  if (!isRecord(message)) return null;
  if (
    message.type === UI_ATTACH_SESSION_UPDATED &&
    typeof message.origin === "string" &&
    typeof message.itemId === "string" &&
    message.itemId.length > 0
  ) {
    return {
      accessRequired: false,
      activeOriginChange: false,
      preferredItemId: message.itemId,
      origin: message.origin,
    };
  }
  return message.type === UI_ATTACH_ACTIVE_ORIGIN_CHANGED
    ? {
        accessRequired: message.accessRequired === true,
        activeOriginChange: true,
      }
    : null;
}

function canRenderSelectionStatus(snapshot: PanelSessionSnapshot): boolean {
  return snapshot.activeSupported &&
    snapshot.origin !== null &&
    snapshot.recovery === null &&
    !snapshot.clearPending &&
    !snapshot.sessionMutationPending &&
    (
      snapshot.status.kind === "empty" ||
      (
        snapshot.status.kind === "ready" &&
        (
          snapshot.status.message === "Capture session ready." ||
          snapshot.status.message === "Selected element preview ready."
        )
      )
    );
}

function createSelectionStatusSnapshotKey(snapshot: PanelSessionSnapshot): string {
  return JSON.stringify({
    activePage: snapshot.activePage
      ? {
          tabId: snapshot.activePage.tabId,
          frameId: snapshot.activePage.frameId,
          origin: snapshot.activePage.origin,
          pathname: snapshot.activePage.pathname,
          documentId: snapshot.activePage.documentId ?? null,
        }
      : null,
    origin: snapshot.origin,
    epoch: snapshot.epoch,
    itemIds: snapshot.file?.session.attachments.map((item) => item.id) ?? [],
    legacyItemId: snapshot.legacyRecord?.attachment.id ?? null,
    currentItemIds: snapshot.currentItemIds,
    selectedItemId: snapshot.selectedItemId,
    viewMode: snapshot.viewMode,
  });
}

function formatSnapshotStatus(
  snapshot: PanelSessionSnapshot,
  hasSessionItems: boolean,
  translate: UiAttachTranslate,
): string {
  if (!snapshot.activeSupported) {
    return snapshot.status.message
      ? localizeKnownStatus(snapshot.status.message, translate)
      : translate("unsupported_page");
  }
  if (snapshot.recovery) {
    return formatPanelStatus("active-origin-changed", "", translate);
  }
  if (snapshot.clearPending) {
    return formatPanelStatus("clear-in-progress", "", translate);
  }
  if (snapshot.status.kind === "saving") {
    return formatExportError(
      snapshot.status.message,
      formatPanelStatus("saving-session", "", translate),
      translate,
    );
  }
  if (snapshot.status.kind === "success") {
    if (snapshot.status.message === "Session item removed.") {
      return formatPanelStatus("session-item-removed", "", translate);
    }
    if (snapshot.status.message === "Session cleared.") {
      return formatPanelStatus("session-cleared", "", translate);
    }
    return formatPanelStatus("session-saved", "", translate);
  }
  if (snapshot.status.kind === "error") {
    return formatExportError(snapshot.status.message, snapshot.status.message, translate);
  }
  if (!snapshot.origin || !hasSessionItems) {
    return formatPanelStatus("no-session", "", translate);
  }
  return localizeKnownStatus(snapshot.status.message, translate);
}

function formatExportError(
  message: string,
  fallback = message,
  translate: UiAttachTranslate = createUiAttachI18n().t,
): string {
  const normalized = message.toLowerCase();
  if (normalized.includes("active origin changed")) {
    return formatPanelStatus("active-origin-changed", "", translate);
  }
  if (normalized.includes("clear") && normalized.includes("progress")) {
    return formatPanelStatus("clear-in-progress", "", translate);
  }
  if (normalized.includes("26") || normalized.includes("session_full")) {
    return formatPanelStatus("session-full", "", translate);
  }
  return localizeKnownStatus(fallback, translate);
}

function getSameOriginLegacyRecord(snapshot: PanelSessionSnapshot): OriginCaptureRecord | null {
  if (snapshot.file) return null;
  if (!snapshot.legacyRecord) return null;
  if (!snapshot.activeSupported || !snapshot.origin) return null;
  if (snapshot.legacyRecord.origin !== snapshot.origin) return null;
  return snapshot.legacyRecord;
}

function frameScopeAncestorChain(
  current: FrameScopeDescriptor,
  scopes: FrameScopeDescriptor[],
): FrameScopeDescriptor[] {
  const byId = new Map(scopes.map((scope) => [scope.frameId, scope]));
  const chain: FrameScopeDescriptor[] = [];
  let next: FrameScopeDescriptor | undefined = current;
  const visited = new Set<number>();
  while (next && !visited.has(next.frameId)) {
    visited.add(next.frameId);
    chain.unshift(next);
    next = next.parentFrameId === null ? undefined : byId.get(next.parentFrameId);
  }
  return chain;
}

function formatFrameScopeBreadcrumb(
  scope: FrameScopeDescriptor,
  translate: UiAttachTranslate,
): string {
  if (scope.frameId === 0) return translate("top_page");
  try {
    return new URL(scope.origin).host;
  } catch {
    return scope.origin;
  }
}

function formatFrameScopeRoute(scope: FrameScopeDescriptor): string {
  try {
    const host = new URL(scope.origin).host;
    return scope.pathname === "/" ? host : `${host}${scope.pathname}`;
  } catch {
    return `${scope.origin}${scope.pathname}`;
  }
}

function isIntentDisabled(snapshot: PanelSessionSnapshot): boolean {
  return (
    snapshot.recovery !== null ||
    snapshot.clearPending ||
    snapshot.sessionMutationPending ||
    !snapshot.activeSupported ||
    !snapshot.origin ||
    !snapshot.file ||
    !snapshot.selectedItemId
  );
}

function classifyPageAccessRecovery(error: unknown): PageAccessRecoveryKind | null {
  const message = error instanceof Error ? error.message : "";
  if (message === formatElementSelectionFailureStatus("PERMISSION_DENIED")) {
    return "permission";
  }
  if (message === formatElementSelectionFailureStatus("CONTENT_UNAVAILABLE")) {
    return "content";
  }
  return null;
}

function disableInteractiveControls(): void {
  for (const element of document.querySelectorAll<
    HTMLButtonElement | HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement
  >("button, input, select, textarea")) {
    element.disabled = true;
  }
}

function createSourceExportWarning(
  file: NonNullable<PanelSessionSnapshot["file"]>,
  translate: UiAttachTranslate = createUiAttachI18n().t,
): string {
  const counts = summarizeSourceModes(file);
  return [
    translate("source_export_warning_data"),
    translate("source_export_warning_intent"),
    `agent_safe: ${counts.agent_safe}`,
    `developer_diagnostic: ${counts.developer_diagnostic}`,
    `full_debug: ${counts.full_debug}`,
  ].join("\n");
}

function createSpan(className: string, text: string): HTMLSpanElement {
  const span = document.createElement("span");
  span.className = className;
  span.textContent = text;
  return span;
}

function summarizeTargetKind(target: string): string {
  const separator = target.indexOf(" - ");
  return separator === -1 ? target : target.slice(0, separator);
}

function createRelationOption(target: PanelRelationModel["targets"][number]): HTMLOptionElement {
  const option = document.createElement("option");
  option.value = target.itemId;
  applyTargetOptionPresentation(option, target.label, target.target);
  return option;
}

const TARGET_OPTION_MAX_DISPLAY_WIDTH = 52;

function applyTargetOptionPresentation(
  option: HTMLOptionElement,
  label: string,
  target: string,
): void {
  const fullLabel = `${label} · ${target}`;
  option.textContent = truncateTargetOptionLabel(fullLabel);
  option.title = fullLabel;
  option.setAttribute("aria-label", fullLabel);
}

function truncateTargetOptionLabel(value: string): string {
  const width = Array.from(value).reduce(
    (total, character) => total + targetOptionCharacterWidth(character),
    0,
  );
  if (width <= TARGET_OPTION_MAX_DISPLAY_WIDTH) return value;

  const characters: string[] = [];
  let usedWidth = 0;
  const contentWidth = TARGET_OPTION_MAX_DISPLAY_WIDTH - 2;
  for (const character of value) {
    const characterWidth = targetOptionCharacterWidth(character);
    if (usedWidth + characterWidth > contentWidth) break;
    characters.push(character);
    usedWidth += characterWidth;
  }
  return `${characters.join("").trimEnd()}…`;
}

function targetOptionCharacterWidth(character: string): number {
  return (character.codePointAt(0) ?? 0) > 0x2ff ? 2 : 1;
}

function formatDisclosureMode(
  mode: UIAttachmentDisclosureMode,
  translate: UiAttachTranslate = createUiAttachI18n().t,
): string {
  if (mode === "developer_diagnostic") return translate("developer_diagnostic");
  if (mode === "full_debug") return translate("full_debug");
  return translate("agent_safe");
}

function localizeSessionGroupLabel(label: string, translate: UiAttachTranslate): string {
  if (label === "Captured targets") return translate("captured_targets");
  const separator = " · ";
  const separatorIndex = label.indexOf(separator);
  if (separatorIndex < 0) return label;
  const prefix = label.slice(0, separatorIndex);
  const keys: Record<string, string> = {
    "Current page": "current_page",
    "Other page": "other_page",
    "Embedded frame": "embedded_frame",
    "Other tab": "other_tab",
  };
  const key = keys[prefix];
  return key ? `${translate(key)}${label.slice(separatorIndex)}` : label;
}

function localizeKnownStatus(message: string, translate: UiAttachTranslate): string {
  const keys: Record<string, string> = {
    "Capture ready.": "capture_ready",
    "Capture session ready.": "capture_ready",
    "Selected element preview ready.": "capture_ready",
    "No selected capture.": "no_selected_capture",
    "Panel action failed. Try again.": "panel_action_failed",
    "This page is not supported. Open an HTTP(S) page to capture UI.": "unsupported_page",
  };
  const key = keys[message];
  return key ? translate(key) : message;
}

function parseDisclosureMode(value: string): UIAttachmentDisclosureMode {
  return value === "developer_diagnostic" || value === "full_debug" ? value : "agent_safe";
}

function parseLocalBridgeApprovalMode(value: string): LocalBridgeApprovalMode {
  return value === "browser_session" ? "browser_session" : "ask";
}

function deriveFocusedLocalBridgePage(
  activePage: ActivePageContext | null,
): LocalBridgePageV1 | null {
  if (
    !activePage ||
    !Number.isSafeInteger(activePage.tabId) ||
    activePage.tabId < 0 ||
    !Number.isSafeInteger(activePage.frameId) ||
    activePage.frameId < 0
  ) return null;
  const page = {
    pageInstanceId: `chromium-tab:${activePage.tabId}:frame:${activePage.frameId}`,
    route: `${activePage.origin}${activePage.pathname}`,
  };
  return isLocalBridgeSnapshot({
    schemaVersion: "0.1.0",
    kind: "ui-attach.local-bridge-snapshot",
    sequence: 0,
    publishedAt: "2026-01-01T00:00:00.000Z",
    page,
    attachmentCount: 0,
    agentCopy: null,
  }) ? page : null;
}

function disconnectedLocalBridgeStatus(): LocalAgentBridgeStatus {
  return {
    connected: false,
    instanceId: null,
    pending: false,
    approvalMode: null,
    requestText: null,
    expiresAt: null,
    sharedTargetCount: null,
    sharedSequence: null,
  };
}

function queryPanelElements() {
  return {
    status: query<HTMLElement>("#status"),
    pageAccessRecovery: query<HTMLElement>("#page-access-recovery"),
    pageAccessRecoveryHeading: query<HTMLElement>("#page-access-recovery-heading"),
    pageAccessRecoveryReason: query<HTMLElement>("#page-access-recovery-reason"),
    pageAccessRecoveryFirstStep: query<HTMLElement>("#page-access-recovery-first-step"),
    pageAccessAutomatic: query<HTMLElement>("#page-access-automatic"),
    pageAccessEnableAutomatic: query<HTMLButtonElement>("#page-access-enable-automatic"),
    pageAccessAutomaticStatus: query<HTMLElement>("#page-access-automatic-status"),
    pageAccessTemporaryPath: query<HTMLElement>("#page-access-temporary-path"),
    emptyWorkflow: query<HTMLElement>("#empty-workflow"),
    session: query<HTMLElement>("#session"),
    capture: query<HTMLElement>("#capture"),
    captureBoundary: query<HTMLElement>("#capture-boundary"),
    captureBoundaryTitle: query<HTMLElement>("#capture-boundary-title"),
    captureBoundaryMessage: query<HTMLElement>("#capture-boundary-message"),
    captureScope: query<HTMLDetailsElement>("#capture-scope"),
    captureScopeBreadcrumb: query<HTMLElement>("#capture-scope-breadcrumb"),
    captureScopeTree: query<HTMLElement>("#capture-scope-tree"),
    captureScopeHelp: query<HTMLElement>("#capture-scope-help"),
    origin: query<HTMLElement>("#origin"),
    elementSummary: query<HTMLElement>("#element-summary"),
    locatorSummary: query<HTMLElement>("#locator-summary"),
    capturedAt: query<HTMLElement>("#captured-at"),
    redactedFields: query<HTMLElement>("#redacted-fields"),
    sensitiveHints: query<HTMLElement>("#sensitive-hints"),
    includedSensitiveFields: query<HTMLElement>("#included-sensitive-fields"),
    selectedTargetSummary: query<HTMLElement>("#selected-target-summary"),
    selectedTargetDetails: query<HTMLDetailsElement>("#selected-target-details"),
    selectedTargetFull: query<HTMLElement>("#selected-target-full"),
    selectedTargetCapturedAt: query<HTMLElement>("#selected-target-captured-at"),
    selectedTargetSource: query<HTMLElement>("#selected-target-source"),
    selectedTargetPage: query<HTMLElement>("#selected-target-page"),
    selectedTargetPageHelp: query<HTMLElement>("#selected-target-page-help"),
    selectedTargetOpenPage: query<HTMLButtonElement>("#selected-target-open-page"),
    selectedTargetRebindRow: query<HTMLElement>("#selected-target-rebind-row"),
    selectedTargetRebindStatus: query<HTMLElement>("#selected-target-rebind-status"),
    removeSelectedItem: query<HTMLButtonElement>("#remove-selected-item"),
    intent: query<HTMLTextAreaElement>("#intent"),
    relationSettings: query<HTMLDetailsElement>("#relation-settings"),
    optionalSettings: query<HTMLDetailsElement>("#optional-settings"),
    relationComposer: query<HTMLElement>("#relation-composer"),
    relationRoleSummary: query<HTMLElement>("#relation-role-summary"),
    relationAction: query<HTMLSelectElement>("#relation-action"),
    relationReference: query<HTMLSelectElement>("#relation-reference"),
    applyRelation: query<HTMLButtonElement>("#apply-relation"),
    relationApplyStatus: query<HTMLElement>("#relation-apply-status"),
    changeGeneratedRelation: query<HTMLButtonElement>("#change-generated-relation"),
    agentSummary: query<HTMLTextAreaElement>("#agent-summary"),
    markdown: query<HTMLTextAreaElement>("#markdown"),
    json: query<HTMLTextAreaElement>("#json"),
    copySummary: query<HTMLButtonElement>("#copy-summary"),
    handoffScopeSummary: query<HTMLElement>("#handoff-scope-summary"),
    handoffOptions: query<HTMLElement>("#handoff-options"),
    handoffFormatField: query<HTMLElement>("#handoff-format-field"),
    handoffFormat: query<HTMLSelectElement>("#handoff-format"),
    agentHandoffPreview: query<HTMLDetailsElement>("#agent-handoff-preview"),
    agentHandoffText: query<HTMLTextAreaElement>("#agent-handoff-text"),
    agentHandoffCopyStatus: query<HTMLElement>("#agent-handoff-copy-status"),
    agentHandoffCopyNextStep: query<HTMLElement>("#agent-handoff-copy-next-step"),
    copyMarkdown: query<HTMLButtonElement>("#copy-markdown"),
    copyJson: query<HTMLButtonElement>("#copy-json"),
    elementSelectionToggle: query<HTMLButtonElement>("#element-selection-toggle"),
    reviewDataDisclosure: query<HTMLButtonElement>("#review-data-disclosure"),
    firstCaptureDisclosure: query<HTMLDialogElement>("#first-capture-disclosure"),
    firstCaptureDisclosureStatus: query<HTMLElement>("#first-capture-disclosure-status"),
    acknowledgeFirstCapture: query<HTMLButtonElement>("#acknowledge-first-capture"),
    dismissFirstCapture: query<HTMLButtonElement>("#dismiss-first-capture"),
    openSettings: query<HTMLButtonElement>("#open-settings"),
    currentContentMode: query<HTMLElement>("#current-content-mode"),
    localBridgeApprovalMode: queryBridge<HTMLSelectElement>("#local-bridge-approval-mode", "select"),
    localBridgeTrustField: queryBridge<HTMLElement>("#local-bridge-trust-field", "label"),
    localBridgeTrustHelp: queryBridge<HTMLElement>("#local-bridge-trust-help", "p"),
    localBridgeSteps: Array.from(
      document.querySelectorAll<HTMLElement>("[data-bridge-step]"),
    ),
    localBridgeRequest: queryBridge<HTMLButtonElement>("#local-bridge-request", "button"),
    localBridgeDisconnect: queryBridge<HTMLButtonElement>("#local-bridge-disconnect", "button"),
    localBridgeDetails: queryBridge<HTMLDetailsElement>("#local-bridge-details", "details"),
    localBridgeRequestText: queryBridge<HTMLTextAreaElement>("#local-bridge-request-text", "textarea"),
    localBridgeInstance: queryBridge<HTMLElement>("#local-bridge-instance", "p"),
    localBridgeStatus: queryBridge<HTMLElement>("#local-bridge-status", "p"),
    localBridgeReadAcknowledgementStatus: queryBridge<HTMLElement>(
      "#local-bridge-read-acknowledgement-status",
      "p",
    ),
    localBridgeReadAcknowledgementLimitations: queryBridge<HTMLElement>(
      "#local-bridge-read-acknowledgement-limitations",
      "p",
    ),
    sessionCount: query<HTMLElement>("#session-count"),
    sessionList: query<HTMLElement>("#session-list"),
    savedSites: query<HTMLDetailsElement>("#saved-sites"),
    savedSitesCount: query<HTMLElement>("#saved-sites-count"),
    savedSitesList: query<HTMLElement>("#saved-sites-list"),
    savedSitesStatus: query<HTMLElement>("#saved-sites-status"),
    clearAllSavedSites: query<HTMLButtonElement>("#clear-all-saved-sites"),
    clearSession: query<HTMLButtonElement>("#clear-session"),
    exportSession: query<HTMLButtonElement>("#export-session"),
    intentRecovery: query<HTMLElement>("#intent-recovery"),
    intentRecoveryDraft: query<HTMLTextAreaElement>("#intent-recovery-draft"),
    retryIntent: query<HTMLButtonElement>("#retry-intent"),
    discardIntent: query<HTMLButtonElement>("#discard-intent"),
  };
}

function parseCapturePromptBundleFormat(value: string): CapturePromptBundleFormat {
  return value === "compact" ? "compact" : "exact";
}

function query<T extends HTMLElement>(selector: string): T {
  const found = document.querySelector(selector);
  if (!(found instanceof HTMLElement)) {
    throw new Error(`Missing extension panel element: ${selector}`);
  }
  return found as T;
}

function queryBridge<T extends HTMLElement>(selector: string, tagName: string): T {
  const found = document.querySelector(selector);
  return (found instanceof HTMLElement ? found : document.createElement(tagName)) as T;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

const STORED_SESSION_SUMMARY_KEYS = [
  "origin",
  "epoch",
  "attachmentCount",
  "state",
  "clearPending",
  "activeClearOperationId",
] as const;

const ACTIVE_SESSION_READBACK_KEYS = [
  "origin",
  "epoch",
  "clearPending",
  "activeClearOperationId",
  "file",
  "legacyRecord",
] as const;

function parseStoredSessionSummaries(value: unknown): StoredOriginSessionSummary[] | null {
  if (!Array.isArray(value)) return null;
  const summaries: StoredOriginSessionSummary[] = [];
  for (const candidate of value) {
    const fields = readExactOwnDataProperties(candidate, STORED_SESSION_SUMMARY_KEYS);
    if (!fields) return null;
    const clearStatus = parseStoredClearStatus(
      fields.clearPending,
      fields.activeClearOperationId,
    );
    if (
      typeof fields.origin !== "string" || fields.origin.length === 0 ||
      !(fields.epoch === null || typeof fields.epoch === "string") ||
      !(
        fields.attachmentCount === null ||
        (Number.isSafeInteger(fields.attachmentCount) && (fields.attachmentCount as number) >= 0)
      ) ||
      !(
        fields.state === "ready" ||
        fields.state === "legacy" ||
        fields.state === "needs_cleanup"
      ) ||
      clearStatus === null
    ) {
      return null;
    }
    summaries.push({
      origin: fields.origin,
      epoch: fields.epoch,
      attachmentCount: fields.attachmentCount as number | null,
      state: fields.state,
      ...clearStatus,
    });
  }
  return summaries;
}

function parseStoredClearReadback(value: unknown): ActiveSessionReadback | null {
  const fields = readExactOwnDataProperties(value, ACTIVE_SESSION_READBACK_KEYS);
  if (!fields) return null;
  const clearStatus = parseStoredClearStatus(
    fields.clearPending,
    fields.activeClearOperationId,
  );
  if (
    typeof fields.origin !== "string" || fields.origin.length === 0 ||
    !(fields.epoch === null || typeof fields.epoch === "string") ||
    !(fields.file === null || isRecord(fields.file)) ||
    !(fields.legacyRecord === null || isRecord(fields.legacyRecord)) ||
    clearStatus === null
  ) {
    return null;
  }
  return {
    origin: fields.origin,
    epoch: fields.epoch,
    file: fields.file as ActiveSessionReadback["file"],
    legacyRecord: fields.legacyRecord as ActiveSessionReadback["legacyRecord"],
    ...clearStatus,
  };
}

type StoredClearStatus =
  | { clearPending: false; activeClearOperationId: null }
  | { clearPending: true; activeClearOperationId: string };

function parseStoredClearStatus(
  clearPending: unknown,
  activeClearOperationId: unknown,
): StoredClearStatus | null {
  if (clearPending === false && activeClearOperationId === null) {
    return { clearPending: false, activeClearOperationId: null };
  }
  return clearPending === true && isDurableStoredClearOperationId(activeClearOperationId)
    ? { clearPending: true, activeClearOperationId }
    : null;
}

function isDurableStoredClearOperationId(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 128 &&
    value.trim() === value && !/\p{Cc}/u.test(value);
}

function readExactOwnDataProperties<const TKey extends readonly string[]>(
  value: unknown,
  expectedKeys: TKey,
): Record<TKey[number], unknown> | null {
  if (!isRecord(value)) return null;
  const ownKeys = Reflect.ownKeys(value);
  if (
    ownKeys.length !== expectedKeys.length ||
    ownKeys.some((key) => typeof key !== "string" || !expectedKeys.includes(key))
  ) {
    return null;
  }
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const fields = {} as Record<TKey[number], unknown>;
  for (const key of expectedKeys) {
    const descriptor = descriptors[key];
    if (!descriptor || !("value" in descriptor)) return null;
    fields[key as TKey[number]] = descriptor.value;
  }
  return fields;
}
