import { isCaptureSessionAnnotationId, type CaptureRouteSegmentV1 } from "@meanthis/hub-core";
import {
  ANNOTATION_LIFECYCLE_CONTROL_SCHEMA_VERSION,
  ANNOTATION_LIFECYCLE_OPERATION_RECEIPT_KIND,
  createAnnotationLifecycleOperationFingerprintInput,
  validateMetadataDiagnosticsV1,
  type AnnotationLifecycleOperationReceiptV1,
  type AnnotationLifecycleOperationTerminalStatus,
  type MetadataDiagnosticsDeviceV1,
  type MetadataDiagnosticsV1,
} from "@meanthis/schema";
import { formatAnnotationLabel, type PersistentOverlayDisplayMode } from "@meanthis/web-picker";
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
  UI_ATTACH_CLEAR_PROJECTION,
  UI_ATTACH_CLEAR_PROJECTION_VERSION,
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
  UI_ATTACH_OVERLAY_SCOPE_VISIBILITY_GET,
  UI_ATTACH_OVERLAY_SCOPE_VISIBILITY_UPDATED,
  UI_ATTACH_OVERLAY_DISPLAY_MODE_GET,
  UI_ATTACH_OVERLAY_DISPLAY_MODE_UPDATED,
  UI_ATTACH_OVERLAY_ACTION_REQUEST,
  UI_ATTACH_OVERLAY_PROJECTION_ACK,
  UI_ATTACH_OVERLAY_PROJECTION_UPDATED,
  UI_ATTACH_OVERLAY_PROJECTION_REACK_REQUIRED,
  UI_ATTACH_PANEL_LIFECYCLE_PORT_PREFIX,
  UI_ATTACH_SELECTION_LIFECYCLE_HEARTBEAT,
  UI_ATTACH_SELECTION_LIFECYCLE_PORT,
  UI_ATTACH_SELECTION_SEED_CONTEXT_TARGET,
  UI_ATTACH_SESSION_UPDATED,
  OVERLAY_RESTORE_MAX_ITEMS,
  isEmbeddedFrameHostInspectResponse,
  isClearProjectionAckMessage,
  isOverlayActionRequestMessage,
  isOverlayProjectionAckMessage,
  isOverlayProjectionDescriptor,
  isOverlayRebindStatusResponse,
  type ActivePageContext,
  type ActiveSessionCommandData,
  type ActiveOriginChangedMessage,
  type CaptureCommitReceipt,
  type ClearProjectionAckMessage,
  type ClearProjectionReference,
  type CaptureFailedMessage,
  type ContentSettingsData,
  type ElementSelectionUpdatedMessage,
  type FrameScopeDescriptor,
  type FrameScopeListData,
  type WidgetFrameScopeDescriptor,
  type WidgetFrameScopeListData,
  type OverlayStateItem,
  type OverlayActionRequestMessage,
  type OverlayProjectionAckMessage,
  type OverlayProjectionDescriptor,
  type OverlayProjectionUpdatedMessage,
  type OverlayProjectionRef,
  type OverlayRestoreData,
  type OverlayRebindStatusData,
  type OverlayRestoreItem,
  type RuntimeCaptureRouteLease,
  type RuntimeCaptureRouteSegment,
  type RuntimeCaptureToken,
  type SavedSessionRouteResolutionData,
  type SessionCommand,
  type SessionCommandResponse,
  type SessionUpdatedMessage,
} from "./messages";
import { derivePanelCurrentScope } from "./panel-session-model";
import type {
  ActiveSessionReadback,
  ExtensionSessionStore,
  SessionMutationAuthority,
  SessionStoreResult,
} from "./session-store";
import type { CaptureClearOperationV1 } from "./clear-operation";
import {
  createClearProjectionStore,
  withClearProjectionOperationLease,
  type ClearProjectionAuthorityReference,
  type ClearProjectionBarrierScope,
  type ClearProjectionOperationLease,
  type ClearProjectionOperation,
  type ClearProjectionSubject,
  type PendingClearProjection,
} from "./clear-projection-store";
import {
  projectAuthoritativeClearReadback,
  projectAuthoritativeStoredSessions,
  readStableAuthoritativeClearSnapshot,
  type AuthoritativeClearSnapshot,
} from "./clear-status-readback";
import type { CaptureToken } from "./session-state";
import type { FirstCaptureDisclosureStore } from "./first-capture-disclosure";
import {
  collectOverlayReplayLocators,
  collectVerifiedOverlayReplayLocators,
} from "./overlay-restore";
import { deriveStoredSessionHandoff, deriveStoredSessionReview } from "./session-file";
import {
  readContextMenuSelectionMode,
  readOverlayDisplayModePreference,
  readOverlayVisibilityPreference,
  OVERLAY_DISPLAY_MODE_PREFERENCE_KEY,
  OVERLAY_VISIBILITY_PREFERENCE_KEY,
  type ContextMenuSelectionMode,
  type OverlayDisplayModePreference,
  type OverlayVisibilityPreference,
} from "./settings-preferences";
import {
  acquireFrameScopePermission,
  FrameScopeAccessError,
  type FrameScopePermissionLease,
} from "./frame-scope-access";
import { resolveSidePanelOpenOptions } from "./toolbar-entry";
import {
  UI_ATTACH_IN_PAGE_WIDGET_ACTION,
  UI_ATTACH_IN_PAGE_WIDGET_ENSURE,
  UI_ATTACH_IN_PAGE_WIDGET_PATH,
  UI_ATTACH_IN_PAGE_WIDGET_READY,
  createInPageWidgetInitMessage,
  parseInPageWidgetLifecyclePortName,
  parseInPageWidgetActionAckMessage,
  parseInPageWidgetCommand,
  parseInPageWidgetCommandEnvelope,
  parseInPageWidgetRegistration,
} from "./in-page-widget-contract";
import {
  createInPageWidgetLeaseStore,
  type PersistedInPageWidgetLease,
} from "./in-page-widget-lease-store";
import type { InPageWidgetCommand } from "./in-page-widget-contract";
import {
  createSelectionIntentStore,
} from "./selection-intent-store";
import { deriveCaptureReplayMetadataDiagnosticsV1 } from "./metadata-diagnostics";
import {
  createMetadataDiagnosticsSessionStore,
  canBindMetadataDiagnosticsSessionIdentity,
  METADATA_DIAGNOSTICS_SESSION_KIND,
  METADATA_DIAGNOSTICS_SESSION_SCHEMA_VERSION,
  type MetadataDiagnosticsSessionFingerprintItemV1,
} from "./metadata-diagnostics-session-store";
import {
  parseAnnotationLifecycleOperationClaim,
  parseAnnotationLifecycleControlAuthority,
  parseAnnotationLifecycleOperationView,
  type AnnotationLifecycleControlAuthorityV1,
  type AnnotationLifecycleOperationClaimV1,
  type AnnotationLifecycleOperationReferenceV1,
  type AnnotationLifecycleOperationViewV1,
} from "./annotation-lifecycle-control-client";
import {
  ANNOTATION_LIFECYCLE_CONTROL_EXECUTION_KIND,
  ANNOTATION_LIFECYCLE_CONTROL_EXECUTION_SCHEMA_VERSION,
  createAnnotationLifecycleControlExecutionStore,
  type ApprovedAnnotationLifecycleOperationV1,
} from "./annotation-lifecycle-control-execution-store";
import {
  ANNOTATION_LIFECYCLE_CONTROL_DELIVERY_KIND,
  ANNOTATION_LIFECYCLE_CONTROL_DELIVERY_SCHEMA_VERSION,
  createAnnotationLifecycleControlDeliveryStore,
  type DeliveredAnnotationLifecycleOperationV1,
} from "./annotation-lifecycle-control-delivery-store";

const SAFE_CAPTURE_ERROR = "ui-attach capture failed.";
const SIDE_PANEL_OPEN_TIMEOUT_MS = 4_000;
const SIDE_PANEL_OPEN_TIMEOUT_ERROR =
  "MeanThis side panel did not respond within 4 seconds. Try again.";
const FIRST_CAPTURE_DISCLOSURE_REQUIRED_ERROR =
  "Review and acknowledge the MeanThis data disclosure before capturing.";
const DISCLOSURE_MODE_KEY = "ui-attach:disclosure-mode";
const FRAME_SCOPE_SESSION_KEY = "ui-attach:frame-scopes-v1";
const FRAME_SCOPE_INVALIDATIONS_LOCAL_KEY = "ui-attach:frame-scope-invalidations-v1";
const IN_PAGE_WIDGET_LEASE_INVALIDATIONS_LOCAL_KEY =
  "ui-attach:in-page-widget-lease-invalidations-v1";
const FRAME_SCOPE_INVALIDATION_AUTHORITY_POISON_LOCAL_KEY =
  "ui-attach:frame-scope-invalidation-authority-poison-v1";
const IN_PAGE_WIDGET_LEASE_INVALIDATION_AUTHORITY_POISON_LOCAL_KEY =
  "ui-attach:in-page-widget-lease-invalidation-authority-poison-v1";
const OVERLAY_ACTIVE_ITEMS_SESSION_KEY = "ui-attach:overlay-active-items-v1";
const OVERLAY_PROJECTIONS_SESSION_KEY = "ui-attach:overlay-projections-v1";
const OVERLAY_PROJECTION_AUTHORITY_GENERATION_KEY =
  "ui-attach:overlay-projection-authority-generation-v1";
const MAX_RESUMABLE_FRAME_SCOPES = 64;
const MAX_IN_PAGE_WIDGET_LEASE_INVALIDATIONS = 64;
const MAX_OVERLAY_ACTIVE_ITEMS = 64;
const MAX_OVERLAY_PROJECTIONS = 128;
const MAX_PENDING_IN_PAGE_WIDGET_ACTIONS = 64;
const INVALIDATION_AUTHORITY_UNAVAILABLE = Object.freeze({
  authority: "unavailable" as const,
});
const SAVED_RESTORE_ACTIVATION_ATTEMPTS = 8;
const SAVED_RESTORE_DISCOVERY_ATTEMPTS = 8;
const SAVED_RESTORE_CONTENT_ATTEMPTS = 3;
const SAVED_RESTORE_RESPONSE_ATTEMPTS = 3;
const SAVED_RESTORE_ACTIVATION_RETRY_MS = 25;
const LIVE_CAPTURE_OVERLAY_SYNC_ATTEMPTS = 3;
const LIVE_CAPTURE_OVERLAY_SYNC_RETRY_MS = 25;
const CLEAR_PROJECTION_ACK_TIMEOUT_MS = 750;
const CLEAR_PROJECTION_MAX_DRAIN_TARGETS = 32;
const CLEAR_PROJECTION_RETRY_DELAY_MS = 1_000;
export const UI_ATTACH_CLEAR_PROJECTION_RETRY_ALARM =
  "ui-attach:clear-projection-retry";

type GuardResult<T> =
  | { ok: true; value: T }
  | { ok: false; issues: Array<{ path: string; message: string }>; unknownType?: true };

type RuntimeResponse = SessionCommandResponse<unknown> | undefined;

type SidePanelOpenOutcome = "opened" | "rejected" | "timeout";

interface WidgetAnnotationLifecycleControlProposal {
  itemId: string;
  label: string;
  operationId: string;
  fingerprint: string;
  expectedState: "open" | "resolved";
  nextState: "open" | "resolved";
  expiresAt: string;
  reference: AnnotationLifecycleOperationReferenceV1;
}

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

interface InPageWidgetLeaseInvalidation {
  surfaceId: string;
  tabId: number;
}

interface ActiveOverlayItemTransition {
  current: string | null;
  generation: number;
  origin: string;
  previous: string | null;
}

interface OverlayGroup {
  endpoint: OverlayEndpoint;
  items: OverlayStateItem[];
  subject?: OverlayProjectionDescriptor["subject"];
}

interface OverlayProjectionRecord {
  projection: OverlayProjectionDescriptor;
  itemIds: string[];
  activeItemId: string | null;
  delivery: "pending" | "acknowledged";
  updatedAt: number;
}

interface OverlayProjectionRegistryEnvelope {
  generation: number;
  records: OverlayProjectionRecord[];
}

interface OverlaySyncDelivery {
  acknowledged: number;
  pending: number;
}

interface OverlaySyncAuthority {
  isCurrent(): boolean;
  refresh?(): Promise<boolean>;
}

interface ClearProjectionAckWaiter {
  deliveryReady: Promise<void>;
  markDeliveryReady(): void;
  completion: Promise<boolean>;
  settle(accepted: boolean): void;
}

interface LiveClearTarget {
  subject: ClearProjectionSubject;
  removedItemIds: string[];
}

interface OverlayPreviewLease extends OverlayEndpoint {
  origin: string;
  pathname: string;
  itemId: string;
}

interface ElementSelectionPageContext extends ActivePageContext {
  windowId: number;
}

interface InPageWidgetLease {
  actionContext?: ActivePageContext;
  frameContext?: ActivePageContext;
  capability: string;
  documentId: string;
  origin: string;
  pathname: string;
  surfaceId: string;
  tabId: number;
  windowId: number;
  port?: UiAttachChromePort;
  disconnectPinCount: number;
  contextMutation: InPageWidgetContextMutationCoordinator;
}

interface InPageWidgetContextMutationCoordinator {
  cancelled: boolean;
  generation: number;
  mutating: boolean;
  terminalGeneration: number;
  tail: Promise<void>;
}

interface InPageWidgetContextMutationToken {
  generation: number;
  isCurrent(): boolean;
}

interface InPageWidgetShowToken {
  generation: number;
  isCurrent(): boolean;
}

interface InPageWidgetContextTransition {
  field: "actionContext" | "frameContext";
  expected: ActivePageContext | undefined;
  previous: ActivePageContext | undefined;
}

interface PendingInPageWidgetAction {
  action: "edit" | "more";
  actionId: string;
  clearActionToken: ClearActionBarrierToken;
  endpoint: OverlayEndpoint & { documentId: string };
  expectedEpoch: string;
  itemId: string;
  origin: string;
  pathname: string;
  projection: OverlayProjectionRef;
}

interface ClearActionBarrierToken {
  generation: number;
  origin: string;
  tabId: number | null;
}

interface ClearActionBarrierScope {
  attemptToken: string;
  origins: Set<string>;
  preDiscovery: boolean;
  tabIds: Set<number>;
}

interface ClearActionBarrierAttempt {
  operationId: string;
  attemptToken: string;
}

interface ClearPageContextFence {
  generation: number;
  endpoint: ClearProjectionSubject;
}

type InPageWidgetActionAckOutcome = "consumed" | "rejected" | "retry" | "dropped";

interface InPageWidgetActionAckWaiter {
  action: PendingInPageWidgetAction;
  port: UiAttachChromePort;
  settle(outcome: InPageWidgetActionAckOutcome): void;
}

const IN_PAGE_WIDGET_DISCONNECT_GRACE_MS = 6_000;
const IN_PAGE_WIDGET_TOP_FRAME_LOOKUP_ATTEMPTS = 3;
const IN_PAGE_WIDGET_TOP_FRAME_LOOKUP_RETRY_MS = 25;
const IN_PAGE_WIDGET_ACTION_ACK_TIMEOUT_MS = 4_000;

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

interface CaptureCommitGate {
  beforeWrite(operationId: string): Promise<void>;
  afterWrite(operationId: string): Promise<void>;
}

interface AnnotationLifecycleExecutionGate {
  afterApproved(operationId: string): Promise<void>;
  afterCanonicalCommit(operationId: string): Promise<void>;
  afterCommitted(operationId: string): Promise<void>;
}

interface ActiveRuntimeCaptureLease {
  current: boolean;
  token: RuntimeCaptureToken;
}

export interface BackgroundController {
  handleContextMenuClick(info: UiAttachChromeContextMenuClickData, tab?: UiAttachChromeTab): Promise<void>;
  handleRuntimeMessage(message: unknown, sender: UiAttachChromeMessageSender): Promise<RuntimeResponse>;
  handleNavigationCommitted(
    details: UiAttachChromeNavigationCommittedDetails,
    topDocumentCommitted?: boolean,
  ): Promise<void>;
  handleTabActivated(activeInfo: { tabId: number; windowId: number }): Promise<void>;
  handleTabUpdated(
    tabId: number,
    changeInfo: { status?: string; url?: string },
    tab: UiAttachChromeTab,
  ): Promise<void>;
  refreshActivePage(): Promise<void>;
  refreshInPageWidgetContext(tabId: number): Promise<void>;
  showInPageWidget(tabId: number): Promise<boolean>;
  register(): void;
}

export function createBackgroundController(options: {
  chrome: UiAttachChrome;
  store: ExtensionSessionStore;
  firstCaptureDisclosure: FirstCaptureDisclosureStore;
  runtimeFeatures?: readonly BackgroundRuntimeFeature[];
  ensureContentScript?: (tabId: number, frameId: number, documentId?: string) => Promise<boolean>;
  openSidePanel?: (options: UiAttachChromeSidePanelOpenOptions) => Promise<void>;
  onActiveSessionChanged?: (data: ActiveSessionCommandData) => Promise<boolean | void>;
  onActivePageInvalidated?: () => Promise<boolean | void>;
  storageAccessReady?: Promise<boolean>;
  captureCommitGate?: CaptureCommitGate;
  annotationLifecycleExecutionGate?: AnnotationLifecycleExecutionGate;
}): BackgroundController {
  const chrome = options.chrome;
  const store = options.store;
  const clearProjectionStore = createClearProjectionStore({ storage: chrome.storage.local });
  const metadataDiagnosticsStore = createMetadataDiagnosticsSessionStore({
    storage: chrome.storage.session,
  });
  const annotationLifecycleControlExecutionStore =
    createAnnotationLifecycleControlExecutionStore({ storage: chrome.storage.session });
  const annotationLifecycleControlDeliveryStore =
    createAnnotationLifecycleControlDeliveryStore({ storage: chrome.storage.session });
  let annotationLifecycleControlExecutionTail = Promise.resolve();
  let annotationLifecycleControlRecoveryTask: Promise<void> | null = null;
  let annotationLifecycleControlRecoveryRequested = false;
  const clearProjectionAckWaiters = new Map<string, ClearProjectionAckWaiter>();
  let clearProjectionDrainRequested = false;
  let clearProjectionDrainTask: Promise<void> | null = null;
  let clearProjectionReconcileTask: Promise<void> | null = null;
  let clearProjectionReconcileRequested = false;
  let clearProjectionAlarmAuthorityGeneration = 0;
  let clearProjectionAlarmMutationTail = Promise.resolve();
  const activeClearCanonicalMutationOperationIds = new Set<string>();
  const clearActionBarriersByOperationId = new Map<string, ClearActionBarrierScope>();
  let clearActionBarrierGeneration = 0;
  let clearActionBarriersLoaded = false;
  let clearActionBarriersLoadTask: Promise<boolean> | null = null;
  let clearPageContextGeneration = 0;
  let clearPageContextGenerationOverflowed = false;
  const firstCaptureDisclosure = options.firstCaptureDisclosure;
  const runtimeFeatures = options.runtimeFeatures ?? [];
  const storageAccessReady = (options.storageAccessReady ?? Promise.resolve(true)).then(
    (ready) => ready === true,
    () => false,
  );
  const ensureContentScript = options.ensureContentScript ?? (async () => true);
  const selectionIntentStore = createSelectionIntentStore({
    authorityStorage: chrome.storage.local,
    poisonStorage: chrome.storage.session,
  });
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
  let elementSelectionBasicDiagnosticsArm: {
    selectionRevision: number;
    selectionGeneration: number;
  } | null = null;
  let elementSelectionAuthorityGeneration: number | null = null;
  let elementSelectionLifecyclePort: UiAttachChromePort | null = null;
  let elementSelectionPermissionLease: FrameScopePermissionLease | null = null;
  const resumableElementSelectionScopes = new Map<number, ResumableElementSelectionScope>();
  const invalidatedResumableElementSelectionScopes =
    new Map<number, ResumableElementSelectionScope>();
  let resumableElementSelectionScopesLoadTask: Promise<void> | null = null;
  let resumableElementSelectionScopesWriteTail = Promise.resolve();
  let resumableElementSelectionScopeInvalidationsWriteTail = Promise.resolve();
  let resumableElementSelectionScopeInvalidationPoisonWriteTail = Promise.resolve();
  let resumableElementSelectionScopeInvalidationAuthorityAvailable = true;
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
  let elementSelectionCaptureMutationTail: Promise<void> = Promise.resolve();
  let captureRouteLeaseGeneration = 0;
  const activeRuntimeCaptureLeases = new Map<string, ActiveRuntimeCaptureLease>();
  let contextMenuInvocationRevision = 0;
  const knownOverlayEndpointsByOrigin = new Map<string, Map<string, OverlayEndpoint>>();
  const overlaySyncTails = new Map<string, Promise<void>>();
  const overlayProjectionsBySubject = new Map<string, OverlayProjectionRecord>();
  const overlayProjectionSubjectsIssuedByWorker = new Set<string>();
  let overlayProjectionRegistryLoadTask: Promise<void> | null = null;
  let overlayProjectionRegistryWriteTail = Promise.resolve();
  let overlayProjectionAuthorityGeneration: number | null = null;
  let overlayProjectionAuthorityAvailable = true;
  const activeOverlayItemIdsByOrigin = new Map<string, string>();
  const activeOverlayItemGenerationsByOrigin = new Map<string, number>();
  let activeOverlayItemIdsLoadTask: Promise<void> | null = null;
  let activeOverlayItemIdsWriteTail = Promise.resolve();
  const overlayPreviewLeasesByOrigin = new Map<string, OverlayPreviewLease>();
  const inPageWidgetLeasesBySurfaceId = new Map<string, InPageWidgetLease>();
  const inPageWidgetLeaseTerminalStatesByTab = new Map<
    number,
    { activeCount: number; revision: object }
  >();
  const invalidatedInPageWidgetLeasesBySurfaceId =
    new Map<string, InPageWidgetLeaseInvalidation>();
  let inPageWidgetLeaseInvalidationsLoadTask: Promise<void> | null = null;
  let inPageWidgetLeaseInvalidationsWriteTail = Promise.resolve();
  let inPageWidgetLeaseInvalidationPoisonWriteTail = Promise.resolve();
  let inPageWidgetLeaseInvalidationAuthorityAvailable = true;
  const inPageWidgetShowTasksByTab = new Map<number, Promise<boolean>>();
  const inPageWidgetShowTerminalGenerationsByTab = new Map<number, number>();
  const pendingInPageWidgetActionsBySurfaceId = new Map<string, PendingInPageWidgetAction[]>();
  const inPageWidgetActionDrainTasksBySurfaceId = new Map<string, Promise<void>>();
  const inPageWidgetActionAckWaitersBySurfaceId = new Map<
    string,
    InPageWidgetActionAckWaiter
  >();
  const inPageWidgetDisconnectTimersBySurfaceId = new Map<string, number>();
  const inPageWidgetRequestedTabs = new Set<number>();
  const inPageWidgetLeaseStore = createInPageWidgetLeaseStore({
    storage: chrome.storage.session,
  });

  async function coordinateInPageWidgetContextMutation<T>(
    lease: InPageWidgetLease,
    mutation: (token: InPageWidgetContextMutationToken) => Promise<T> | T,
  ): Promise<T> {
    const terminalGenerationAtEnqueue = lease.contextMutation.terminalGeneration;
    const previous = lease.contextMutation.tail;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    lease.contextMutation.tail = previous.then(() => gate, () => gate);
    await previous.catch(() => undefined);
    lease.contextMutation.cancelled = false;
    lease.contextMutation.mutating = true;
    lease.contextMutation.generation += 1;
    const generation = lease.contextMutation.generation;
    const token: InPageWidgetContextMutationToken = {
      generation,
      isCurrent: () => (
        inPageWidgetLeasesBySurfaceId.get(lease.surfaceId) === lease &&
        lease.contextMutation.mutating && !lease.contextMutation.cancelled &&
        lease.contextMutation.generation === generation &&
        lease.contextMutation.terminalGeneration === terminalGenerationAtEnqueue
      ),
    };
    try {
      return await mutation(token);
    } finally {
      lease.contextMutation.generation += 1;
      lease.contextMutation.mutating = false;
      lease.contextMutation.cancelled = false;
      release();
    }
  }

  function coordinateElementSelectionCaptureMutation<T>(
    mutation: () => Promise<T> | T,
  ): Promise<T> {
    const result = elementSelectionCaptureMutationTail
      .catch(() => undefined)
      .then(mutation);
    elementSelectionCaptureMutationTail = result.then(() => undefined, () => undefined);
    return result;
  }

  async function compensateCancelledInPageWidgetContextMutation(
    lease: InPageWidgetLease,
    token: InPageWidgetContextMutationToken,
    transitions: readonly InPageWidgetContextTransition[],
  ): Promise<void> {
    if (inPageWidgetLeasesBySurfaceId.get(lease.surfaceId) !== lease ||
        !lease.contextMutation.mutating || !lease.contextMutation.cancelled ||
        lease.contextMutation.generation === token.generation) return;
    for (const transition of transitions) {
      const current = lease[transition.field];
      if (current !== transition.expected && current !== transition.previous) return;
    }
    for (const transition of transitions) {
      if (lease[transition.field] === transition.expected) {
        lease[transition.field] = transition.previous;
      }
    }
    try {
      await persistInPageWidgetLease(lease);
    } catch {
      if (inPageWidgetLeasesBySurfaceId.get(lease.surfaceId) === lease) {
        await revokeInPageWidgetTab(lease.tabId, false);
      }
    }
  }

  function invalidateInPageWidgetContextMutation(
    lease: InPageWidgetLease,
    terminal = false,
  ): void {
    if (lease.contextMutation.mutating) lease.contextMutation.cancelled = true;
    lease.contextMutation.generation += 1;
    if (terminal) lease.contextMutation.terminalGeneration += 1;
  }

  function invalidateSelectionContextMutationsForClear(): void {
    for (const lease of inPageWidgetLeasesBySurfaceId.values()) {
      invalidateInPageWidgetContextMutation(lease, true);
      settleInPageWidgetActionAck(lease.surfaceId, undefined, undefined, "dropped");
      pendingInPageWidgetActionsBySurfaceId.delete(lease.surfaceId);
    }
  }

  function disconnectPortSafely(port: UiAttachChromePort | undefined): void {
    if (!port) return;
    try {
      port.disconnect();
    } catch {
      // Local authority is already detached even when the transport throws.
    }
  }
  const openSidePanel =
    options.openSidePanel ??
    (async (openOptions: UiAttachChromeSidePanelOpenOptions) => {
      if (!chrome.sidePanel?.open) {
        throw new Error("MeanThis side panel is unavailable.");
      }
      // Keep the browser result authoritative. Callers already translate a
      // rejected open into safe product feedback; swallowing it would make the
      // in-page widget report success while no native panel exists.
      await chrome.sidePanel.open(openOptions);
    });
  const publishActiveSession = options.onActiveSessionChanged ?? (async () => false);
  let reconciledActiveSessionTabId: number | null = null;
  const reconcileActiveSession = async (data: ActiveSessionCommandData): Promise<boolean | void> => {
    const reconciled = await publishActiveSession(data);
    if (reconciled === true) {
      reconciledActiveSessionTabId = data.enabled && data.activePage
        ? data.activePage.tabId
        : null;
    }
    return reconciled;
  };
  const invalidateActivePageContext = options.onActivePageInvalidated ?? (() =>
    reconcileActiveSession({
      enabled: false,
      origin: null,
      readback: null,
      activePage: null,
    })
  );

  async function ensureOverlayProjectionRegistryLoaded(): Promise<void> {
    if (!overlayProjectionRegistryLoadTask) {
      overlayProjectionRegistryLoadTask = (async () => {
        try {
          const authority = await chrome.storage.local.get(
            OVERLAY_PROJECTION_AUTHORITY_GENERATION_KEY,
          );
          const generation = parseStoredOverlayProjectionAuthorityGeneration(
            authority[OVERLAY_PROJECTION_AUTHORITY_GENERATION_KEY],
          );
          if (generation === null) {
            overlayProjectionAuthorityAvailable = false;
            return;
          }
          overlayProjectionAuthorityGeneration = generation;
          const stored = await chrome.storage.session.get(OVERLAY_PROJECTIONS_SESSION_KEY);
          const envelope = parseStoredOverlayProjectionRegistryEnvelope(
            stored[OVERLAY_PROJECTIONS_SESSION_KEY],
          );
          if (!envelope || envelope.generation !== generation) return;
          for (const record of envelope.records) {
            overlayProjectionsBySubject.set(
              overlayProjectionSubjectKey(record.projection.subject),
              { ...record, delivery: "pending" },
            );
          }
        } catch {
          overlayProjectionAuthorityAvailable = false;
          overlayProjectionAuthorityGeneration = null;
        }
      })();
    }
    await overlayProjectionRegistryLoadTask;
  }

  async function persistOverlayProjectionRegistry(): Promise<boolean> {
    let persisted = false;
    const write = overlayProjectionRegistryWriteTail.then(async () => {
      if (!overlayProjectionAuthorityAvailable ||
          overlayProjectionAuthorityGeneration === null) return;
      const snapshot = Array.from(overlayProjectionsBySubject.values())
        .sort((left, right) => left.updatedAt - right.updatedAt)
        .slice(-MAX_OVERLAY_PROJECTIONS)
        .map(cloneOverlayProjectionRecord);
      const generation = nextOverlayProjectionAuthorityGeneration(
        overlayProjectionAuthorityGeneration,
      );
      try {
        await chrome.storage.local.set({
          [OVERLAY_PROJECTION_AUTHORITY_GENERATION_KEY]: generation,
        });
      } catch {
        overlayProjectionAuthorityAvailable = false;
        overlayProjectionAuthorityGeneration = null;
        for (const record of overlayProjectionsBySubject.values()) {
          record.delivery = "pending";
        }
        try {
          await chrome.storage.session.remove(OVERLAY_PROJECTIONS_SESSION_KEY);
        } catch {
          // If both durable operations fail, this worker still rejects every projection.
        }
        return;
      }
      overlayProjectionAuthorityGeneration = generation;
      try {
        const envelope: OverlayProjectionRegistryEnvelope = { generation, records: snapshot };
        await chrome.storage.session.set({
          [OVERLAY_PROJECTIONS_SESSION_KEY]: envelope,
        });
        persisted = true;
      } catch {
        // The durable generation already invalidates the older session snapshot on restart.
        for (const record of overlayProjectionsBySubject.values()) {
          record.delivery = "pending";
        }
      }
    });
    overlayProjectionRegistryWriteTail = write.then(() => undefined, () => undefined);
    await write;
    return persisted;
  }

  async function awaitOverlayProjectionRegistryWritesThroughCurrentTail(): Promise<void> {
    const durableTail = overlayProjectionRegistryWriteTail;
    await durableTail;
  }

  async function createOverlayProjection(
    readback: ActiveSessionReadback,
    subject: OverlayProjectionDescriptor["subject"],
    items: readonly OverlayStateItem[],
    activeItemId: string | null,
    reuseIdenticalRestore: boolean,
    authority?: OverlaySyncAuthority,
  ): Promise<OverlayProjectionRecord | null> {
    await ensureOverlayProjectionRegistryLoaded();
    if (authority && !authority.isCurrent()) return null;
    if (!overlayProjectionAuthorityAvailable ||
        overlayProjectionAuthorityGeneration === null) {
      throw new Error("Overlay projection authority is unavailable.");
    }
    const key = overlayProjectionSubjectKey(subject);
    const previous = overlayProjectionsBySubject.get(key);
    const itemIds = items.slice(0, OVERLAY_RESTORE_MAX_ITEMS).map((item) => item.itemId);
    const resolvedActiveItemId = resolveOverlayActiveItemId(itemIds, activeItemId);
    if (reuseIdenticalRestore && previous &&
        overlayProjectionSubjectsIssuedByWorker.has(key) &&
        previous.projection.sessionEpoch === readback.epoch &&
        sameOverlayProjectionSubject(previous.projection.subject, subject) &&
        sameOverlayProjectionItemIds(previous.itemIds, itemIds) &&
        previous.activeItemId === resolvedActiveItemId) {
      if (authority && !authority.isCurrent()) return null;
      previous.updatedAt = Date.now();
      overlayProjectionsBySubject.delete(key);
      overlayProjectionsBySubject.set(key, previous);
      return previous;
    }
    const projection: OverlayProjectionDescriptor = {
      version: 1,
      projectionId: previous && previous.projection.revision < Number.MAX_SAFE_INTEGER
        ? previous.projection.projectionId
        : crypto.randomUUID(),
      revision: previous && previous.projection.revision < Number.MAX_SAFE_INTEGER
        ? previous.projection.revision + 1
        : 1,
      sessionEpoch: readback.epoch,
      subject: { ...subject },
    };
    const record: OverlayProjectionRecord = {
      projection,
      itemIds,
      activeItemId: resolvedActiveItemId,
      delivery: "pending",
      updatedAt: Date.now(),
    };
    if (authority && !authority.isCurrent()) return null;
    overlayProjectionsBySubject.delete(key);
    overlayProjectionsBySubject.set(key, record);
    while (overlayProjectionsBySubject.size > MAX_OVERLAY_PROJECTIONS) {
      const oldest = [...overlayProjectionsBySubject.entries()]
        .sort(([, left], [, right]) => left.updatedAt - right.updatedAt)[0]?.[0];
      if (!oldest) break;
      overlayProjectionsBySubject.delete(oldest);
      overlayProjectionSubjectsIssuedByWorker.delete(oldest);
    }
    if (!await persistOverlayProjectionRegistry()) {
      throw new Error("Overlay projection registry persistence failed.");
    }
    if (overlayProjectionsBySubject.get(key) === record) {
      overlayProjectionSubjectsIssuedByWorker.add(key);
    }
    return record;
  }

  async function resolveOverlayProjectionSubject(
    endpoint: OverlayEndpoint,
    expectedOrigin: string,
  ): Promise<OverlayProjectionDescriptor["subject"] | null> {
    try {
      let frame = await chrome.webNavigation.getFrame({
        tabId: endpoint.tabId,
        frameId: endpoint.frameId,
      });
      if (!frame) {
        const frames = await chrome.webNavigation.getAllFrames({ tabId: endpoint.tabId });
        frame = frames?.find((candidate) => candidate.frameId === endpoint.frameId);
      }
      const origin = originFromUrl(frame?.url);
      const pathname = pathnameFromUrl(frame?.url);
      if (!frame?.documentId || origin !== expectedOrigin || pathname === null ||
          (endpoint.documentId !== undefined && endpoint.documentId !== frame.documentId)) {
        return null;
      }
      return {
        tabId: endpoint.tabId,
        frameId: endpoint.frameId,
        documentId: frame.documentId,
        origin,
        pathname,
      };
    } catch {
      return null;
    }
  }

  async function acknowledgeOverlayProjection(
    message: OverlayProjectionAckMessage,
    sender: UiAttachChromeMessageSender,
  ): Promise<RuntimeResponse> {
    const endpoint = overlayEndpointFromSender(sender);
    const origin = contentOriginFromSender(sender);
    if (sender.id !== chrome.runtime.id || !endpoint?.documentId || !origin) {
      return untrustedSender();
    }
    // MessageSender.url may retain the initial document URL after a same-
    // document navigation. Resolve the current pathname from the exact live
    // document instead of trusting that stale hint.
    const exactEndpoint = { ...endpoint, documentId: endpoint.documentId };
    const expectedSubject = await resolveOverlayProjectionSubject(exactEndpoint, origin);
    if (!expectedSubject || !await isCurrentOverlayActionEndpoint(
      exactEndpoint,
      origin,
      expectedSubject.pathname,
    )) return untrustedSender();
    const pathname = expectedSubject.pathname;
    await ensureOverlayProjectionRegistryLoaded();
    const key = overlayProjectionSubjectKey(expectedSubject);
    const record = overlayProjectionsBySubject.get(key);
    if (!overlayProjectionAuthorityAvailable || !record ||
        !sameOverlayProjectionSubject(record.projection.subject, expectedSubject) ||
        !sameOverlayProjectionRef(record.projection, message.projection)) {
      return { ok: true, data: { accepted: false } };
    }
    const readback = await store.read(origin);
    const endpointCurrent = await isCurrentOverlayActionEndpoint(
          { ...endpoint, documentId: endpoint.documentId },
          origin,
          pathname,
        );
    const projectionRouteCurrent = readback.ok && endpointCurrent
      ? await overlayProjectionItemsMatchLiveRoute(
          readback.value,
          expectedSubject,
          record.itemIds,
        )
      : false;
    if (!readback.ok || !endpointCurrent ||
        !projectionRouteCurrent ||
        overlayProjectionsBySubject.get(key) !== record ||
        !sameOverlayProjectionSubject(record.projection.subject, expectedSubject) ||
        !sameOverlayProjectionRef(record.projection, message.projection) ||
        readback.value.epoch !== record.projection.sessionEpoch ||
        !record.itemIds.every((itemId) => overlayReadbackContainsItem(
          readback.value,
          itemId,
          origin,
        ))) {
      return { ok: true, data: { accepted: false } };
    }
    const previousUpdatedAt = record.updatedAt;
    record.delivery = "acknowledged";
    record.updatedAt = Date.now();
    if (!await persistOverlayProjectionRegistry()) {
      if (overlayProjectionsBySubject.get(key) === record) {
        record.delivery = "pending";
        record.updatedAt = previousUpdatedAt;
      }
      return { ok: true, data: { accepted: false } };
    }
    const projectionRouteStillCurrent = await overlayProjectionItemsMatchLiveRoute(
      readback.value,
      expectedSubject,
      record.itemIds,
    );
    if (!overlayProjectionAuthorityAvailable ||
        overlayProjectionAuthorityGeneration === null ||
        !projectionRouteStillCurrent ||
        overlayProjectionsBySubject.get(key) !== record ||
        record.delivery !== "acknowledged" ||
        !sameOverlayProjectionSubject(record.projection.subject, expectedSubject) ||
        !sameOverlayProjectionRef(record.projection, message.projection)) {
      if (overlayProjectionsBySubject.get(key) === record && !projectionRouteStillCurrent) {
        record.delivery = "pending";
        record.updatedAt = Date.now();
        await persistOverlayProjectionRegistry();
      } else if (overlayProjectionsBySubject.get(key) !== record) {
        await awaitOverlayProjectionRegistryWritesThroughCurrentTail();
      }
      return { ok: true, data: { accepted: false } };
    }
    await Promise.all([
      refreshInPageWidgetContext(endpoint.tabId).catch(() => undefined),
      publishRuntimeMessage({ type: UI_ATTACH_OVERLAY_PROJECTION_UPDATED }),
    ]);
    return { ok: true, data: { accepted: true } };
  }

  async function acknowledgeClearProjection(
    message: ClearProjectionAckMessage,
    sender: UiAttachChromeMessageSender,
  ): Promise<RuntimeResponse> {
    const endpoint = overlayEndpointFromSender(sender);
    const origin = contentOriginFromSender(sender);
    const pathname = sender.url ? pathnameFromUrl(sender.url) : null;
    if (sender.id !== chrome.runtime.id || !endpoint?.documentId || !origin || pathname === null) {
      return untrustedSender();
    }
    const exactSubject: ClearProjectionSubject = {
      tabId: endpoint.tabId,
      frameId: endpoint.frameId,
      documentId: endpoint.documentId,
      origin,
      pathname,
    };
    if (!sameClearProjectionSubject(message.clear.subject, exactSubject) ||
        message.clear.origin !== origin ||
        !await isCurrentOverlayActionEndpoint(
          { ...endpoint, documentId: endpoint.documentId },
          origin,
          pathname,
        )) return untrustedSender();

    const waiterKey = clearProjectionReferenceKey(message.clear);
    const waiter = clearProjectionAckWaiters.get(waiterKey);
    let authority = await validateClearProjectionAuthority(message.clear);
    if (!authority) {
      waiter?.settle(false);
      return { ok: true, data: { accepted: false } };
    }
    if (authority.targetState === "acknowledged") {
      await invalidateOverlayProjectionForClearSubject(message.clear.subject);
      waiter?.settle(true);
      await reconcileClearProjectionJournal();
      return { ok: true, data: { accepted: true } };
    }
    if (authority.targetState === "pending") {
      if (!waiter) return { ok: true, data: { accepted: false } };
      await waiter.deliveryReady;
      authority = await validateClearProjectionAuthority(message.clear);
    }
    if (!authority || authority.targetState !== "delivered" ||
        !await isCurrentOverlayActionEndpoint(
          { ...endpoint, documentId: endpoint.documentId },
          origin,
          pathname,
        )) {
      waiter?.settle(false);
      return { ok: true, data: { accepted: false } };
    }
    const acknowledged = await withClearProjectionOperationLease(
      message.clear.operationId,
      async (lease) => {
        const current = await validateClearProjectionAuthority(message.clear);
        if (!current || current.targetState !== "delivered") return null;
        return clearProjectionStore.acknowledge(current.reference, {
          subject: { ...message.clear.subject },
          projectionId: message.clear.projectionId,
          revision: message.clear.revision,
          readback: {
            appliedItemIds: [],
            markerCount: 0,
            selectionPreviewActive: false,
            digest: message.readback.digest,
          },
        }, lease);
      },
    );
    const accepted = acknowledged?.ok === true && acknowledged.value.state === "acknowledged";
    if (accepted) await invalidateOverlayProjectionForClearSubject(message.clear.subject);
    waiter?.settle(accepted);
    if (accepted) await reconcileClearProjectionJournal();
    return { ok: true, data: { accepted } };
  }

  async function validateClearProjectionAuthority(
    clear: ClearProjectionReference,
  ): Promise<{
    reference: ClearProjectionAuthorityReference;
    targetState: "pending" | "delivered" | "acknowledged" | "superseded";
  } | null> {
    const operations = await clearProjectionStore.listOperations();
    if (!operations.ok) return null;
    const operation = operations.value.find((candidate) =>
      candidate.operationId === clear.operationId &&
      candidate.authority?.authorityId === clear.authorityId &&
      candidate.authority.generation === clear.generation
    );
    const target = operation?.targets.find((candidate) =>
      sameClearProjectionSubject(candidate.subject, clear.subject) &&
      candidate.projectionId === clear.projectionId &&
      candidate.revision === clear.revision
    );
    const committed = operation?.origins.find((candidate) =>
      candidate.origin === clear.origin && candidate.originAfterEpoch === clear.afterEpoch
    );
    if (!operation?.authority || !target || !committed || target.state === "superseded") return null;

    const canonical = await store.listClearOperations();
    if (!canonical.ok) return null;
    const canonicalOperation = canonical.value.find((candidate) =>
      candidate.operationId === clear.operationId &&
      candidate.authorityId === clear.authorityId &&
      candidate.generation === clear.generation
    );
    if (!canonicalOperation?.origins.some((candidate) =>
      candidate.origin === clear.origin && candidate.afterEpoch === clear.afterEpoch &&
      candidate.canonical === "committed"
    )) return null;
    return { reference: operation.authority, targetState: target.state };
  }

  async function invalidateOverlayProjectionForClearSubject(
    subject: ClearProjectionSubject,
  ): Promise<void> {
    await ensureOverlayProjectionRegistryLoaded();
    const key = overlayProjectionSubjectKey(subject);
    if (!overlayProjectionsBySubject.delete(key)) return;
    overlayProjectionSubjectsIssuedByWorker.delete(key);
    await persistOverlayProjectionRegistry();
  }

  function nextClearActionBarrierGeneration(): void {
    clearActionBarrierGeneration = clearActionBarrierGeneration >= Number.MAX_SAFE_INTEGER
      ? 1
      : clearActionBarrierGeneration + 1;
  }

  function addClearActionBarrier(
    operationId: string,
    origins: Iterable<string>,
    options: { preDiscovery?: boolean; tabIds?: Iterable<number> } = {},
  ): ClearActionBarrierAttempt {
    const attemptToken = crypto.randomUUID();
    const scope: ClearActionBarrierScope = {
      attemptToken,
      origins: new Set<string>(),
      preDiscovery: false,
      tabIds: new Set<number>(),
    };
    for (const origin of origins) scope.origins.add(origin);
    for (const tabId of options.tabIds ?? []) scope.tabIds.add(tabId);
    if (options.preDiscovery === true) scope.preDiscovery = true;
    clearActionBarriersByOperationId.set(operationId, scope);
    nextClearActionBarrierGeneration();
    return { operationId, attemptToken };
  }

  function narrowClearActionBarrier(
    attempt: ClearActionBarrierAttempt,
    origins: Iterable<string>,
    tabIds: Iterable<number>,
  ): void {
    const scope = clearActionBarriersByOperationId.get(attempt.operationId);
    if (!scope || scope.attemptToken !== attempt.attemptToken) return;
    let changed = scope.preDiscovery;
    for (const origin of origins) scope.origins.add(origin);
    for (const tabId of tabIds) scope.tabIds.add(tabId);
    scope.preDiscovery = false;
    if (scope.origins.size > 0 || scope.tabIds.size > 0) changed = true;
    if (changed) nextClearActionBarrierGeneration();
  }

  function removeClearActionBarrier(attempt: ClearActionBarrierAttempt | null): void {
    if (!attempt) return;
    const scope = clearActionBarriersByOperationId.get(attempt.operationId);
    if (!scope || scope.attemptToken !== attempt.attemptToken) return;
    clearActionBarriersByOperationId.delete(attempt.operationId);
    nextClearActionBarrierGeneration();
  }

  function currentClearActionBarrierAttempt(
    operationId: string,
  ): ClearActionBarrierAttempt | null {
    const scope = clearActionBarriersByOperationId.get(operationId);
    return scope ? { operationId, attemptToken: scope.attemptToken } : null;
  }

  function hasClearActionBarrier(origin: string, tabId: number | null): boolean {
    return [...clearActionBarriersByOperationId.values()].some((scope) =>
      scope.preDiscovery || scope.origins.has(origin) ||
      (tabId !== null && scope.tabIds.has(tabId))
    );
  }

  function createClearActionBarrierToken(
    origin: string,
    tabId: number | null,
  ): ClearActionBarrierToken {
    return { generation: clearActionBarrierGeneration, origin, tabId };
  }

  function retargetClearActionBarrierToken(
    token: ClearActionBarrierToken,
    origin: string,
    tabId: number | null,
  ): ClearActionBarrierToken {
    return { generation: token.generation, origin, tabId };
  }

  function clearActionBarrierTokenIsCurrent(token: ClearActionBarrierToken): boolean {
    return token.generation === clearActionBarrierGeneration &&
      !hasClearActionBarrier(token.origin, token.tabId);
  }

  async function validateClearActionBarrierToken(
    token: ClearActionBarrierToken,
  ): Promise<boolean> {
    if (!await ensureClearActionBarriersLoaded() || hasClearActionBarrier(token.origin, token.tabId)) {
      return false;
    }
    token.generation = clearActionBarrierGeneration;
    return true;
  }

  function clearInProgress(): Extract<SessionCommandResponse<never>, { ok: false }> {
    return failure("CLEAR_IN_PROGRESS", "Page annotations are being cleared.");
  }

  async function readAuthoritativeClearSnapshot(): Promise<
    | { ok: true; value: AuthoritativeClearSnapshot }
    | { ok: false; response: Extract<SessionCommandResponse<never>, { ok: false }> }
  > {
    const snapshot = await readStableAuthoritativeClearSnapshot({
      readCanonical: () => store.listClearOperations(),
      readProjection: () => clearProjectionStore.listOperations(),
    });
    return snapshot.ok
      ? snapshot
      : {
          ok: false,
          response: failure(
            "STORAGE_ERROR",
            snapshot.code === "CONFLICT"
              ? "Clear authority sources conflict."
              : "Clear authority could not be read consistently.",
          ),
        };
  }

  async function readAuthoritativeSession(
    origin: string,
  ): Promise<SessionStoreResult<ActiveSessionReadback>> {
    const readback = await store.read(origin);
    if (!readback.ok) return readback;
    const snapshot = await readAuthoritativeClearSnapshot();
    return snapshot.ok
      ? { ok: true, value: projectAuthoritativeClearReadback(readback.value, snapshot.value) }
      : {
          ok: false,
          code: "STORAGE_ERROR",
          error: snapshot.response.error,
        };
  }

  async function listAuthoritativeStoredSessions(): Promise<RuntimeResponse> {
    const summaries = await store.list();
    if (!summaries.ok) return storeResult(summaries);
    const snapshot = await readAuthoritativeClearSnapshot();
    return snapshot.ok
      ? { ok: true, data: projectAuthoritativeStoredSessions(summaries.value, snapshot.value) }
      : snapshot.response;
  }

  function ensureClearActionBarriersLoaded(): Promise<boolean> {
    if (clearActionBarriersLoaded) return Promise.resolve(true);
    if (clearActionBarriersLoadTask) return clearActionBarriersLoadTask;
    const loadTask = (async () => {
      const operations = await clearProjectionStore.listOperations();
      if (!operations.ok) return false;
      for (const operation of operations.value) {
        if (clearActionBarriersByOperationId.has(operation.operationId)) continue;
        const barrierScope = clearProjectionRequestBarrierScope(operation.request);
        addClearActionBarrier(
          operation.operationId,
          operation.requestedOrigins,
          {
            preDiscovery: operation.authority === null && barrierScope !== "active-origin",
            tabIds: barrierScope === "active-origin"
              ? []
              : operation.targets.map((target) => target.subject.tabId),
          },
        );
      }
      clearActionBarriersLoaded = true;
      return true;
    })().catch(() => false);
    clearActionBarriersLoadTask = loadTask;
    void loadTask.then((loaded) => {
      if (!loaded && clearActionBarriersLoadTask === loadTask) {
        clearActionBarriersLoadTask = null;
      }
    });
    return loadTask;
  }

  async function settleClearActionBarrier(attempt: ClearActionBarrierAttempt): Promise<void> {
    const operations = await clearProjectionStore.listOperations();
    if (!operations.ok) return;
    const scope = clearActionBarriersByOperationId.get(attempt.operationId);
    if (!scope || scope.attemptToken !== attempt.attemptToken) return;
    const operation = operations.value.find((candidate) =>
      candidate.operationId === attempt.operationId
    );
    if (!operation) {
      removeClearActionBarrier(attempt);
      return;
    }
    let changed = scope.preDiscovery;
    for (const origin of operation.requestedOrigins) {
      if (!scope.origins.has(origin)) changed = true;
      scope.origins.add(origin);
    }
    if (clearProjectionRequestBarrierScope(operation.request) !== "active-origin") {
      for (const target of operation.targets) {
        if (!scope.tabIds.has(target.subject.tabId)) changed = true;
        scope.tabIds.add(target.subject.tabId);
      }
    }
    scope.preDiscovery = false;
    if (changed) nextClearActionBarrierGeneration();
  }

  async function overlayProjectionItemAuthority(
    readback: ActiveSessionReadback,
    projection: OverlayProjectionRef,
    itemId: string,
    endpoint: OverlayEndpoint & { documentId: string },
    origin: string,
    pathname: string,
  ): Promise<"acknowledged" | "pending" | null> {
    await ensureOverlayProjectionRegistryLoaded();
    if (!overlayProjectionAuthorityAvailable) return null;
    const record = overlayProjectionsBySubject.get(overlayProjectionSubjectKey({
      tabId: endpoint.tabId,
      frameId: endpoint.frameId,
      documentId: endpoint.documentId,
      origin,
      pathname,
    }));
    const subject = record?.projection.subject;
    const registryAuthorityMatches = record &&
      (record.delivery === "acknowledged" || record.delivery === "pending") &&
      subject?.tabId === endpoint.tabId &&
      subject.frameId === endpoint.frameId &&
      subject.documentId === endpoint.documentId &&
      subject.origin === origin &&
      subject.pathname === pathname &&
      sameOverlayProjectionRef(record.projection, projection) &&
      record.projection.sessionEpoch === readback.epoch &&
      record.itemIds.includes(itemId) &&
      overlayReadbackContainsItem(readback, itemId, origin);
    if (!registryAuthorityMatches || !subject) return null;
    return await overlayProjectionItemsMatchLiveRoute(readback, subject, record.itemIds)
      ? record.delivery
      : null;
  }

  async function acknowledgedProjectionOwnsItem(
    readback: ActiveSessionReadback,
    projection: OverlayProjectionRef,
    itemId: string,
    endpoint: OverlayEndpoint & { documentId: string },
    origin: string,
    pathname: string,
  ): Promise<boolean> {
    return await overlayProjectionItemAuthority(
      readback,
      projection,
      itemId,
      endpoint,
      origin,
      pathname,
    ) === "acknowledged";
  }

  function createOwnedOverlayMutationAuthority(
    readback: ActiveSessionReadback,
    projection: OverlayProjectionRef,
    itemId: string,
    endpoint: OverlayEndpoint & { documentId: string },
    origin: string,
    pathname: string,
    clearActionToken: ClearActionBarrierToken,
  ): SessionMutationAuthority | null {
    const key = overlayProjectionSubjectKey({
      tabId: endpoint.tabId,
      frameId: endpoint.frameId,
      documentId: endpoint.documentId,
      origin,
      pathname,
    });
    const record = overlayProjectionsBySubject.get(key);
    if (!record) return null;
    const ownedItem = readback.file?.session.attachments.find((item) =>
      item.id === itemId && item.sourceRecord.origin === origin
    );
    if (!ownedItem) return null;
    const ownedAttachmentId = ownedItem.sourceRecord.attachment.id;
    let live = true;
    const isCurrent = (): boolean => (
      live &&
      clearActionBarrierTokenIsCurrent(clearActionToken) &&
      overlayProjectionAuthorityAvailable &&
      overlayProjectionsBySubject.get(key) === record &&
      record.delivery === "acknowledged" &&
      sameOverlayProjectionRef(record.projection, projection) &&
      record.projection.sessionEpoch === readback.epoch &&
      record.itemIds.includes(itemId) &&
      overlayReadbackContainsItem(readback, itemId, origin)
    );
    return {
      isCurrent,
      refresh: async (currentRecord) => {
        if (!isCurrent() || currentRecord.attachment.id !== ownedAttachmentId) return false;
        if (!await overlayProjectionItemsMatchLiveRoute(
          readback,
          record.projection.subject,
          record.itemIds,
        )) {
          live = false;
          return false;
        }
        return isCurrent();
      },
    };
  }

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
        void showInPageWidget(tabId).catch(() => false);
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
        if (selection.data.enabled && permissionLease) {
          elementSelectionPermissionLease = permissionLease;
          permissionLease = null;
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

  async function showInPageWidget(tabId: number): Promise<boolean> {
    const current = inPageWidgetShowTasksByTab.get(tabId);
    if (current) return await current;
    const generation = inPageWidgetShowTerminalGenerationsByTab.get(tabId) ?? 0;
    const token: InPageWidgetShowToken = {
      generation,
      isCurrent: () => (
        (inPageWidgetShowTerminalGenerationsByTab.get(tabId) ?? 0) === generation
      ),
    };
    const task = showInPageWidgetOnce(tabId, token);
    inPageWidgetShowTasksByTab.set(tabId, task);
    try {
      return await task;
    } finally {
      if (inPageWidgetShowTasksByTab.get(tabId) === task) {
        inPageWidgetShowTasksByTab.delete(tabId);
      }
    }
  }

  async function showInPageWidgetOnce(
    tabId: number,
    token: InPageWidgetShowToken,
  ): Promise<boolean> {
    if (!(await storageAccessReady) || !token.isCurrent()) return false;
    const activeTab = await getActiveTabForTab(tabId);
    if (!token.isCurrent()) return false;
    const page = activePageContextFromTab(activeTab ?? undefined);
    if (!activeTab || !page) return false;
    let documentId = await readContextDocumentId(tabId, page.origin, page.pathname);
    if (!token.isCurrent()) return false;
    if (!documentId) {
      let unboundContentReady = false;
      try {
        unboundContentReady = await ensureContentScript(tabId, 0);
      } catch {
        unboundContentReady = false;
      }
      if (!token.isCurrent() || !unboundContentReady) return false;
      documentId = await readContextDocumentId(tabId, page.origin, page.pathname);
      if (!token.isCurrent() || !documentId) return false;
    }
    let contentReady = false;
    try {
      contentReady = await ensureContentScript(tabId, 0, documentId);
    } catch {
      contentReady = false;
    }
    if (!token.isCurrent() || !contentReady) return false;
    const currentLease = [...inPageWidgetLeasesBySurfaceId.values()].find((lease) =>
      lease.tabId === tabId && lease.documentId === documentId &&
      lease.origin === page.origin && lease.pathname === page.pathname
    );
    if (currentLease) {
      try {
        const ensured = await chrome.tabs.sendMessage(tabId, {
          type: UI_ATTACH_IN_PAGE_WIDGET_ENSURE,
        }, { frameId: 0, documentId });
        if (!token.isCurrent()) return false;
        if (isDelegatedWidgetSurfaceResponse(ensured)) {
          await revokeInPageWidgetTab(tabId, true);
          return token.isCurrent();
        }
        if (!isExactNullCommandResponse(ensured)) return false;
        const initialized = await chrome.tabs.sendMessage(
          tabId,
          createInPageWidgetInitMessage(currentLease.surfaceId, currentLease.capability),
          { frameId: 0, documentId },
        );
        if (!token.isCurrent() || !isExactNullCommandResponse(initialized)) return false;
        if (inPageWidgetLeasesBySurfaceId.get(currentLease.surfaceId) !== currentLease) return false;
        if (!currentLease.port) scheduleInPageWidgetDisconnectExpiry(currentLease);
        inPageWidgetRequestedTabs.add(tabId);
        requestOverlayVisibilityBroadcast();
        return true;
      } catch {
        return false;
      }
    }
    await revokeInPageWidgetTab(tabId, true);
    if (!token.isCurrent()) return false;
    let ensured: unknown;
    try {
      ensured = await chrome.tabs.sendMessage(tabId, {
        type: UI_ATTACH_IN_PAGE_WIDGET_ENSURE,
      }, { frameId: 0, documentId });
    } catch {
      return false;
    }
    if (!token.isCurrent()) return false;
    if (isDelegatedWidgetSurfaceResponse(ensured)) return true;
    if (!isExactNullCommandResponse(ensured)) return false;
    const surfaceId = crypto.randomUUID();
    const capability = createWidgetCapability();
    const lease: InPageWidgetLease = {
      capability,
      documentId,
      origin: page.origin,
      pathname: page.pathname,
      surfaceId,
      tabId,
      windowId: activeTab.windowId,
      disconnectPinCount: 0,
      contextMutation: createInPageWidgetContextMutationCoordinator(),
    };
    try {
      await persistInPageWidgetLease(lease);
      if (!token.isCurrent()) {
        await discardInPageWidgetShowLease(lease);
        return false;
      }
      inPageWidgetLeasesBySurfaceId.set(surfaceId, lease);
      await clearInPageWidgetLeaseInvalidationsForDurableReplacement(lease);
      if (!token.isCurrent()) {
        await discardInPageWidgetShowLease(lease);
        return false;
      }
      const initialized = await chrome.tabs.sendMessage(
        tabId,
        createInPageWidgetInitMessage(surfaceId, capability),
        { frameId: 0, documentId },
      );
      if (!token.isCurrent()) {
        await discardInPageWidgetShowLease(lease);
        return false;
      }
      if (!isExactNullCommandResponse(initialized)) throw new Error(SAFE_CAPTURE_ERROR);
      if (inPageWidgetLeasesBySurfaceId.get(surfaceId) !== lease) return false;
      scheduleInPageWidgetDisconnectExpiry(lease);
      inPageWidgetRequestedTabs.add(tabId);
      requestOverlayVisibilityBroadcast();
      return true;
    } catch {
      await discardInPageWidgetShowLease(lease);
      return false;
    }
  }

  async function discardInPageWidgetShowLease(lease: InPageWidgetLease): Promise<void> {
    await coordinateInPageWidgetLeaseTerminalMutation(lease.tabId, async () => {
      if (inPageWidgetLeasesBySurfaceId.get(lease.surfaceId) === lease) {
        inPageWidgetLeasesBySurfaceId.delete(lease.surfaceId);
      }
      markInPageWidgetLeaseInvalidated(lease);
      await persistInPageWidgetLeaseInvalidations();
      await inPageWidgetLeaseStore.revoke(lease.surfaceId).catch(() => undefined);
      requestOverlayVisibilityBroadcast();
    });
  }

  function cancelInPageWidgetShow(tabId: number): void {
    const generation = inPageWidgetShowTerminalGenerationsByTab.get(tabId) ?? 0;
    inPageWidgetShowTerminalGenerationsByTab.set(
      tabId,
      generation >= Number.MAX_SAFE_INTEGER ? 1 : generation + 1,
    );
    inPageWidgetShowTasksByTab.delete(tabId);
  }

  async function registerInPageWidget(
    registration: ReturnType<typeof parseInPageWidgetRegistration> & {},
    sender: UiAttachChromeMessageSender,
  ): Promise<RuntimeResponse> {
    const lease = await resolveInPageWidgetLease(
      registration.surfaceId,
      registration.capability,
    );
    if (!lease) {
      return {
        ...untrustedSender(),
        issues: [{ path: "widget", message: "WIDGET_REGISTER_LEASE" }],
      };
    }
    const releasePin = acquireInPageWidgetDisconnectPin(lease);
    try {
      const senderFailure = await inspectCurrentWidgetSender(sender, lease);
      if (inPageWidgetLeasesBySurfaceId.get(lease.surfaceId) !== lease) {
        return {
          ...untrustedSender(),
          issues: [{ path: "widget", message: "WIDGET_REGISTER_LEASE" }],
        };
      }
      if (senderFailure) {
        return {
          ...untrustedSender(),
          issues: [{ path: "widget", message: senderFailure }],
        };
      }
      requestOverlayVisibilityBroadcast();
      return { ok: true, data: { registered: true } };
    } finally {
      releasePin();
    }
  }

  async function retainInPageWidgetLifecyclePort(port: UiAttachChromePort): Promise<void> {
    const parsed = parseInPageWidgetLifecyclePortName(port.name);
    const lease = parsed
      ? await resolveInPageWidgetLease(parsed.surfaceId, parsed.capability)
      : undefined;
    let disconnected = false;
    port.onDisconnect.addListener(() => {
      disconnected = true;
      const waiter = lease
        ? inPageWidgetActionAckWaitersBySurfaceId.get(lease.surfaceId)
        : undefined;
      if (waiter?.port === port) waiter.settle("retry");
      if (!lease || lease.port !== port) return;
      lease.port = undefined;
      scheduleInPageWidgetDisconnectExpiry(lease);
    });
    if (!parsed || !lease || parsed.capability !== lease.capability || !port.sender ||
        !port.postMessage) {
      disconnectPortSafely(port);
      return;
    }
    const releasePin = acquireInPageWidgetDisconnectPin(lease);
    try {
      const senderIsCurrent = await isCurrentWidgetSender(port.sender, lease);
      if (!senderIsCurrent || disconnected ||
          inPageWidgetLeasesBySurfaceId.get(lease.surfaceId) !== lease) {
        disconnectPortSafely(port);
        return;
      }
      const previousPort = lease.port;
      lease.port = port;
      port.onMessage?.addListener((message) => {
        const acknowledgement = parseInPageWidgetActionAckMessage(message);
        const waiter = inPageWidgetActionAckWaitersBySurfaceId.get(lease.surfaceId);
        if (!acknowledgement || acknowledgement.surfaceId !== lease.surfaceId ||
            lease.port !== port || waiter?.port !== port ||
            waiter.action.actionId !== acknowledgement.actionId) return;
        waiter.settle(acknowledgement.outcome);
      });
      if (previousPort && previousPort !== port) {
        settleInPageWidgetActionAck(lease.surfaceId, undefined, previousPort, "retry");
        disconnectPortSafely(previousPort);
      }
      try {
        port.postMessage({
          type: UI_ATTACH_IN_PAGE_WIDGET_READY,
          surfaceId: lease.surfaceId,
        });
        await deliverPendingInPageWidgetActions(lease);
        void recoverAnnotationLifecycleControlExecutions();
      } catch {
        settleInPageWidgetActionAck(lease.surfaceId, undefined, port, "retry");
        if (inPageWidgetLeasesBySurfaceId.get(lease.surfaceId) === lease && lease.port === port) {
          lease.port = undefined;
        }
        disconnectPortSafely(port);
      }
    } finally {
      releasePin();
    }
  }

  async function deliverPendingInPageWidgetActions(lease: InPageWidgetLease): Promise<void> {
    if (inPageWidgetActionDrainTasksBySurfaceId.has(lease.surfaceId)) return;
    const pending = pendingInPageWidgetActionsBySurfaceId.get(lease.surfaceId);
    if (inPageWidgetLeasesBySurfaceId.get(lease.surfaceId) !== lease ||
        !lease.port?.postMessage || !pending?.length) return;
    const drain = drainPendingInPageWidgetActions(lease).catch(() => {
      settleInPageWidgetActionAck(lease.surfaceId, undefined, lease.port, "retry");
      const failedPort = lease.port;
      if (!failedPort) return;
      lease.port = undefined;
      scheduleInPageWidgetDisconnectExpiry(lease);
      disconnectPortSafely(failedPort);
    });
    inPageWidgetActionDrainTasksBySurfaceId.set(lease.surfaceId, drain);
    void drain.finally(() => {
      if (inPageWidgetActionDrainTasksBySurfaceId.get(lease.surfaceId) !== drain) return;
      inPageWidgetActionDrainTasksBySurfaceId.delete(lease.surfaceId);
      const remaining = pendingInPageWidgetActionsBySurfaceId.get(lease.surfaceId);
      if (inPageWidgetLeasesBySurfaceId.get(lease.surfaceId) === lease &&
          lease.port?.postMessage && remaining?.length) {
        void deliverPendingInPageWidgetActions(lease);
      }
    });
  }

  async function drainPendingInPageWidgetActions(lease: InPageWidgetLease): Promise<void> {
    const port = lease.port;
    const postMessage = port?.postMessage;
    const pending = pendingInPageWidgetActionsBySurfaceId.get(lease.surfaceId);
    if (!port || !postMessage || !pending?.length ||
        !isCurrentInPageWidgetActionDrain(lease, port, pending)) return;
    while (pending.length > 0) {
      const action = pending[0]!;
      if (!clearActionBarrierTokenIsCurrent(action.clearActionToken)) {
        pending.shift();
        continue;
      }
      const prepared = await preparePendingInPageWidgetAction(lease, port, pending, action);
      if (!isCurrentInPageWidgetActionDrain(lease, port, pending)) return;
      if (!prepared) continue;
      if (!clearActionBarrierTokenIsCurrent(action.clearActionToken)) {
        if (isCurrentInPageWidgetActionDrainHead(lease, port, pending, action)) pending.shift();
        continue;
      }
      const acknowledgement = waitForInPageWidgetActionAck(lease, port, action);
      try {
        postMessage.call(port, {
          type: UI_ATTACH_IN_PAGE_WIDGET_ACTION,
          surfaceId: lease.surfaceId,
          actionId: action.actionId,
          action: action.action,
          itemId: action.itemId,
        });
      } catch {
        settleInPageWidgetActionAck(lease.surfaceId, action, port, "retry");
        if (isCurrentInPageWidgetActionDrainHead(lease, port, pending, action)) {
          lease.port = undefined;
          scheduleInPageWidgetDisconnectExpiry(lease);
        }
        disconnectPortSafely(port);
        await acknowledgement;
        return;
      }
      const outcome = await acknowledgement;
      if (outcome === "retry") return;
      if (outcome === "rejected") {
        await rejectInPageWidgetActionSurface(lease, port);
        return;
      }
      if (outcome === "consumed" &&
          isCurrentInPageWidgetActionDrainHead(lease, port, pending, action)) {
        await coordinateInPageWidgetContextMutation(lease, () => {
          if (isCurrentInPageWidgetActionDrainHead(lease, port, pending, action)) pending.shift();
        });
      }
    }
    await coordinateInPageWidgetContextMutation(lease, () => {
      if (pendingInPageWidgetActionsBySurfaceId.get(lease.surfaceId) === pending &&
          pending.length === 0) {
        pendingInPageWidgetActionsBySurfaceId.delete(lease.surfaceId);
      }
    });
  }

  async function rejectInPageWidgetActionSurface(
    lease: InPageWidgetLease,
    port: UiAttachChromePort,
  ): Promise<void> {
    await coordinateInPageWidgetLeaseTerminalMutation(lease.tabId, async () => {
      const rejected = await coordinateInPageWidgetContextMutation(lease, () => {
        if (inPageWidgetLeasesBySurfaceId.get(lease.surfaceId) !== lease || lease.port !== port) {
          return false;
        }
        cancelInPageWidgetDisconnectExpiry(lease.surfaceId);
        inPageWidgetLeasesBySurfaceId.delete(lease.surfaceId);
        pendingInPageWidgetActionsBySurfaceId.delete(lease.surfaceId);
        lease.port = undefined;
        disconnectPortSafely(port);
        return true;
      });
      if (!rejected) return;
      markInPageWidgetLeaseInvalidated(lease);
      await persistInPageWidgetLeaseInvalidations();
      await inPageWidgetLeaseStore.revoke(lease.surfaceId).catch(() => undefined);
      requestOverlayVisibilityBroadcast();
    });
  }

  async function preparePendingInPageWidgetAction(
    lease: InPageWidgetLease,
    port: UiAttachChromePort,
    pending: PendingInPageWidgetAction[],
    action: PendingInPageWidgetAction,
  ): Promise<boolean> {
    let prepared = false;
    await enqueueOverlayOperation(action.origin, async () => {
      await coordinateInPageWidgetContextMutation(lease, async (token) => {
        if (!token.isCurrent() || !clearActionBarrierTokenIsCurrent(action.clearActionToken) ||
            !isCurrentInPageWidgetActionDrainHead(lease, port, pending, action)) return;
        const endpointCurrent = await isCurrentOverlayActionEndpoint(
          action.endpoint,
          action.origin,
          action.pathname,
        );
        if (!token.isCurrent() || !clearActionBarrierTokenIsCurrent(action.clearActionToken) ||
            !isCurrentInPageWidgetActionDrainHead(lease, port, pending, action)) return;
        if (!endpointCurrent) {
          pending.shift();
          return;
        }
        const read = await store.read(action.origin);
        if (!token.isCurrent() || !clearActionBarrierTokenIsCurrent(action.clearActionToken) ||
            !isCurrentInPageWidgetActionDrainHead(lease, port, pending, action)) return;
        if (!read.ok || read.value.epoch !== action.expectedEpoch ||
            !await acknowledgedProjectionOwnsItem(
              read.value,
              action.projection,
              action.itemId,
              action.endpoint,
              action.origin,
              action.pathname,
            )) {
          if (token.isCurrent() &&
              isCurrentInPageWidgetActionDrainHead(lease, port, pending, action)) pending.shift();
          return;
        }
        if (!token.isCurrent() || !clearActionBarrierTokenIsCurrent(action.clearActionToken) ||
            !isCurrentInPageWidgetActionDrainHead(lease, port, pending, action) ||
            !await isCurrentOverlayActionEndpoint(
              action.endpoint,
              action.origin,
            action.pathname,
            ) || !token.isCurrent() ||
            !clearActionBarrierTokenIsCurrent(action.clearActionToken) ||
            !isCurrentInPageWidgetActionDrainHead(lease, port, pending, action)) {
          if (token.isCurrent() &&
              isCurrentInPageWidgetActionDrainHead(lease, port, pending, action)) pending.shift();
          return;
        }
        const previousActionContext = lease.actionContext;
        const actionContext: ActivePageContext = {
          tabId: action.endpoint.tabId,
          frameId: action.endpoint.frameId,
          documentId: action.endpoint.documentId,
          origin: action.origin,
          pathname: action.pathname,
        };
        lease.actionContext = actionContext;
        try {
          await persistInPageWidgetLease(lease);
        } catch {
          if (lease.actionContext === actionContext) lease.actionContext = previousActionContext;
          if (token.isCurrent() &&
              isCurrentInPageWidgetActionDrainHead(lease, port, pending, action)) pending.shift();
          return;
        }
        if (!token.isCurrent() || !clearActionBarrierTokenIsCurrent(action.clearActionToken) ||
            !isCurrentInPageWidgetActionDrainHead(lease, port, pending, action)) {
          if (!token.isCurrent()) {
            await compensateCancelledInPageWidgetContextMutation(lease, token, [{
              field: "actionContext",
              expected: actionContext,
              previous: previousActionContext,
            }]);
          } else if (lease.actionContext === actionContext) {
            lease.actionContext = previousActionContext;
          }
          return;
        }
        if (!await validatePendingInPageWidgetAction(action) ||
            !token.isCurrent() || !clearActionBarrierTokenIsCurrent(action.clearActionToken) ||
            !isCurrentInPageWidgetActionDrainHead(lease, port, pending, action)) {
          if (!token.isCurrent()) {
            await compensateCancelledInPageWidgetContextMutation(lease, token, [{
              field: "actionContext",
              expected: actionContext,
              previous: previousActionContext,
            }]);
          } else if (lease.actionContext === actionContext) {
            lease.actionContext = previousActionContext;
            await persistInPageWidgetLease(lease).catch(() => undefined);
          }
          if (token.isCurrent() &&
              isCurrentInPageWidgetActionDrainHead(lease, port, pending, action)) pending.shift();
          return;
        }
        prepared = true;
      });
    });
    return prepared;
  }

  function waitForInPageWidgetActionAck(
    lease: InPageWidgetLease,
    port: UiAttachChromePort,
    action: PendingInPageWidgetAction,
  ): Promise<InPageWidgetActionAckOutcome> {
    return new Promise((resolve) => {
      let settled = false;
      const timer = setTimeout(() => {
        settle("retry");
        if (lease.port !== port) return;
        lease.port = undefined;
        scheduleInPageWidgetDisconnectExpiry(lease);
        disconnectPortSafely(port);
      }, IN_PAGE_WIDGET_ACTION_ACK_TIMEOUT_MS);
      const waiter: InPageWidgetActionAckWaiter = {
        action,
        port,
        settle,
      };
      function settle(outcome: InPageWidgetActionAckOutcome): void {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (inPageWidgetActionAckWaitersBySurfaceId.get(lease.surfaceId) === waiter) {
          inPageWidgetActionAckWaitersBySurfaceId.delete(lease.surfaceId);
        }
        resolve(outcome);
      }
      inPageWidgetActionAckWaitersBySurfaceId.set(lease.surfaceId, waiter);
    });
  }

  function settleInPageWidgetActionAck(
    surfaceId: string,
    action: PendingInPageWidgetAction | undefined,
    port: UiAttachChromePort | undefined,
    outcome: InPageWidgetActionAckOutcome,
  ): void {
    const waiter = inPageWidgetActionAckWaitersBySurfaceId.get(surfaceId);
    if (!waiter || (action && waiter.action !== action) || (port && waiter.port !== port)) return;
    waiter.settle(outcome);
  }

  function isCurrentInPageWidgetActionDrain(
    lease: InPageWidgetLease,
    port: UiAttachChromePort,
    pending: PendingInPageWidgetAction[],
  ): boolean {
    return inPageWidgetLeasesBySurfaceId.get(lease.surfaceId) === lease &&
      lease.port === port &&
      pendingInPageWidgetActionsBySurfaceId.get(lease.surfaceId) === pending;
  }

  function isCurrentInPageWidgetActionDrainHead(
    lease: InPageWidgetLease,
    port: UiAttachChromePort,
    pending: PendingInPageWidgetAction[],
    action: PendingInPageWidgetAction,
  ): boolean {
    return isCurrentInPageWidgetActionDrain(lease, port, pending) && pending[0] === action;
  }

  function pendingInPageWidgetActionHead(
    lease: InPageWidgetLease,
  ): PendingInPageWidgetAction | undefined {
    return pendingInPageWidgetActionsBySurfaceId.get(lease.surfaceId)?.[0];
  }

  function hasPendingInPageWidgetAction(lease: InPageWidgetLease): boolean {
    return pendingInPageWidgetActionHead(lease) !== undefined;
  }

  function pendingActionContext(
    lease: InPageWidgetLease,
    action: PendingInPageWidgetAction,
  ): ActivePageContext {
    return {
      tabId: lease.tabId,
      frameId: action.endpoint.frameId,
      documentId: action.endpoint.documentId,
      origin: action.origin,
      pathname: action.pathname,
    };
  }

  function sameActivePageContext(
    left: ActivePageContext | undefined,
    right: ActivePageContext,
  ): boolean {
    return left?.tabId === right.tabId && left.frameId === right.frameId &&
      left.documentId === right.documentId && left.origin === right.origin &&
      left.pathname === right.pathname;
  }

  async function validatePendingInPageWidgetAction(
    action: PendingInPageWidgetAction,
  ): Promise<boolean> {
    if (!clearActionBarrierTokenIsCurrent(action.clearActionToken)) return false;
    const read = await store.read(action.origin);
    if (!clearActionBarrierTokenIsCurrent(action.clearActionToken) ||
        !read.ok || read.value.epoch !== action.expectedEpoch ||
        !await isCurrentOverlayActionEndpoint(
          action.endpoint,
          action.origin,
          action.pathname,
        ) || !clearActionBarrierTokenIsCurrent(action.clearActionToken)) return false;
    const ownsItem = await acknowledgedProjectionOwnsItem(
        read.value,
        action.projection,
        action.itemId,
        action.endpoint,
        action.origin,
        action.pathname,
      );
    return clearActionBarrierTokenIsCurrent(action.clearActionToken) && ownsItem;
  }

  async function pendingInPageWidgetActionProjectionIsCurrent(
    action: PendingInPageWidgetAction,
    readback: ActiveSessionReadback,
  ): Promise<boolean> {
    if (!clearActionBarrierTokenIsCurrent(action.clearActionToken) ||
        readback.epoch !== action.expectedEpoch ||
        !await isCurrentOverlayActionEndpoint(
          action.endpoint,
          action.origin,
          action.pathname,
        ) || !clearActionBarrierTokenIsCurrent(action.clearActionToken)) return false;
    const ownsItem = await acknowledgedProjectionOwnsItem(
      readback,
      action.projection,
      action.itemId,
      action.endpoint,
      action.origin,
      action.pathname,
    );
    return clearActionBarrierTokenIsCurrent(action.clearActionToken) && ownsItem;
  }

  async function handleInPageWidgetCommand(
    envelope: ReturnType<typeof parseInPageWidgetCommandEnvelope> & {},
    sender: UiAttachChromeMessageSender,
  ): Promise<RuntimeResponse> {
    const lease = await resolveInPageWidgetLease(envelope.surfaceId, envelope.capability);
    if (!lease) return untrustedSender();
    const releasePin = acquireInPageWidgetDisconnectPin(lease);
    try {
      if (!await isCurrentWidgetSender(sender, lease) ||
          inPageWidgetLeasesBySurfaceId.get(lease.surfaceId) !== lease) return untrustedSender();
      const widgetCommand = parseInPageWidgetCommand(envelope.command);
      return widgetCommand
        ? await handleBoundWidgetCommand(widgetCommand, lease)
        : untrustedSender();
    } finally {
      releasePin();
    }
  }

  async function handleBoundWidgetCommand(
    command: InPageWidgetCommand,
    lease: InPageWidgetLease,
  ): Promise<RuntimeResponse> {
    if (command.type === "ui-attach:widget-surface-release") {
      return await coordinateInPageWidgetLeaseTerminalMutation(lease.tabId, () =>
        coordinateAnnotationLifecycleControlExecution(async () => {
        if (!inPageWidgetLeaseIsCurrent(lease)) {
          return failure("ACTIVE_PAGE_UNAVAILABLE", "MeanThis could not verify the widget page.");
        }
        invalidateInPageWidgetContextMutation(lease, true);
        markInPageWidgetLeaseInvalidated(lease);
        if (!await persistInPageWidgetLeaseInvalidations()) {
          return failure(
            "STORAGE_ERROR",
            "MeanThis could not persist the released widget authority.",
          );
        }
        inPageWidgetLeasesBySurfaceId.delete(lease.surfaceId);
        cancelInPageWidgetShow(lease.tabId);
        cancelInPageWidgetDisconnectExpiry(lease.surfaceId);
        settleInPageWidgetActionAck(lease.surfaceId, undefined, undefined, "dropped");
        pendingInPageWidgetActionsBySurfaceId.delete(lease.surfaceId);
        disconnectPortSafely(lease.port);
        requestOverlayVisibilityBroadcast();
        try {
          await inPageWidgetLeaseStore.revoke(lease.surfaceId);
        } catch {
          return failure(
            "STORAGE_ERROR",
            "MeanThis could not revoke the released widget authority.",
          );
        }
        if (!await terminateAnnotationLifecycleControlForCanonicalRemovalExclusive(
          (delivery) => delivery.surfaceId === lease.surfaceId,
          (execution) => execution.surfaceId === lease.surfaceId,
        )) {
          return failure(
            "STORAGE_ERROR",
            "MeanThis could not release the local Agent lifecycle proposal marker.",
          );
        }
        return { ok: true, data: null };
        })
      );
    }
    const clearActionToken = command.type === "ui-attach:widget-task-note-save" ||
        command.type === "ui-attach:widget-annotation-lifecycle-set" ||
        command.type === "ui-attach:widget-lifecycle-control-read-next" ||
        command.type === "ui-attach:widget-lifecycle-control-approve" ||
        command.type === "ui-attach:widget-item-remove"
      ? createClearActionBarrierToken(lease.origin, lease.tabId)
      : null;
    if (clearActionToken && !await validateClearActionBarrierToken(clearActionToken)) {
      return clearInProgress();
    }
    switch (command.type) {
      case "ui-attach:widget-session-read":
        return await getInPageWidgetSession(lease);
      case "ui-attach:widget-task-note-save": {
        const activePage = await requireWidgetCapturePageContext(lease);
        if (!activePage.ok) return activePage.response;
        const activeClearActionToken = clearActionToken
          ? retargetClearActionBarrierToken(
              clearActionToken,
              activePage.value.origin,
              activePage.value.tabId,
            )
          : null;
        if (!activeClearActionToken || !clearActionBarrierTokenIsCurrent(activeClearActionToken)) {
          return clearInProgress();
        }
        const read = await store.read(activePage.value.origin);
        if (!clearActionBarrierTokenIsCurrent(activeClearActionToken)) return clearInProgress();
        if (!read.ok) return storeResult(read);
        const item = findWidgetSessionItem(
          read.value,
          command.itemId,
          activePage.value.origin,
        );
        if (!item) {
          return failure("ITEM_NOT_FOUND", "MeanThis could not find the widget target.");
        }
        const mutationAuthority = createInPageWidgetMutationAuthority(
          lease,
          activePage.value,
          item.sourceRecord.attachment.id,
          activeClearActionToken,
        );
        const updated = await store.updateIntent(
          activePage.value.origin,
          command.expectedEpoch,
          command.itemId,
          command.taskNote,
          mutationAuthority,
        );
        return await storeResultWithWidgetReconcile(updated, lease, activeClearActionToken);
      }
      case "ui-attach:widget-annotation-lifecycle-set": {
        const activePage = await requireWidgetCapturePageContext(lease);
        if (!activePage.ok) return activePage.response;
        const activeClearActionToken = clearActionToken
          ? retargetClearActionBarrierToken(
              clearActionToken,
              activePage.value.origin,
              activePage.value.tabId,
            )
          : null;
        if (!activeClearActionToken || !clearActionBarrierTokenIsCurrent(activeClearActionToken)) {
          return clearInProgress();
        }
        const read = await store.read(activePage.value.origin);
        if (!clearActionBarrierTokenIsCurrent(activeClearActionToken)) return clearInProgress();
        if (!read.ok) return storeResult(read);
        const item = findWidgetSessionItem(
          read.value,
          command.itemId,
          activePage.value.origin,
        );
        if (!item) {
          return failure("ITEM_NOT_FOUND", "MeanThis could not find the widget target.");
        }
        const mutationAuthority = createInPageWidgetMutationAuthority(
          lease,
          activePage.value,
          item.sourceRecord.attachment.id,
          activeClearActionToken,
        );
        const updated = await store.updateAnnotationLifecycle(
          activePage.value.origin,
          command.expectedEpoch,
          command.itemId,
          command.annotationId,
          command.expectedState,
          command.nextState,
          mutationAuthority,
        );
        return await storeResultWithWidgetReconcile(updated, lease, activeClearActionToken);
      }
      case "ui-attach:widget-item-remove": {
        const activePage = await requireWidgetCapturePageContext(lease);
        if (!activePage.ok) return activePage.response;
        const activeClearActionToken = clearActionToken
          ? retargetClearActionBarrierToken(
              clearActionToken,
              activePage.value.origin,
              activePage.value.tabId,
            )
          : null;
        if (!activeClearActionToken || !clearActionBarrierTokenIsCurrent(activeClearActionToken)) {
          return clearInProgress();
        }
        const activeOrigin = activePage.value.origin;
        const previous = await store.read(activeOrigin);
        if (!clearActionBarrierTokenIsCurrent(activeClearActionToken)) return clearInProgress();
        if (!previous.ok) return storeResult(previous);
        const item = findWidgetSessionItem(previous.value, command.itemId, activeOrigin);
        // A prior durable remove may have succeeded while diagnostics cleanup failed.
        // Preserve the retry path; the store still owns missing-item validation.
        const expectedAttachmentId = item?.sourceRecord.attachment.id ?? command.itemId;
        const removal = await coordinateAnnotationLifecycleControlExecution(async () => {
          if (!clearActionBarrierTokenIsCurrent(activeClearActionToken) ||
              !inPageWidgetLeaseIsCurrent(lease)) return null;
          if (!await terminateAnnotationLifecycleControlForCanonicalRemovalExclusive(
            (delivery) => delivery.origin === activeOrigin,
            (execution) => execution.origin === activeOrigin && execution.itemId === command.itemId,
          )) return null;
          const mutationAuthority = createInPageWidgetMutationAuthority(
            lease,
            activePage.value,
            expectedAttachmentId,
            activeClearActionToken,
          );
          return await store.removeItem(
            activeOrigin,
            command.expectedEpoch,
            command.itemId,
            mutationAuthority,
          );
        });
        if (!removal) {
          if (!clearActionBarrierTokenIsCurrent(activeClearActionToken)) return clearInProgress();
          return failure(
            "STORAGE_ERROR",
            "MeanThis could not cancel pending Agent lifecycle approvals before removing this target.",
          );
        }
        if (!removal.ok) return storeResult(removal);
        const cleanup = await removeStaleSessionMetadataDiagnostics(activeOrigin);
        if (!cleanup.ok) {
          return metadataDiagnosticsCleanupPending();
        }
        const confirmed = cleanup.readback;
        if (confirmed.file?.session.attachments.some((item) => item.id === command.itemId)) {
          return failure("CAPTURE_FAILED", SAFE_CAPTURE_ERROR);
        }
        if (clearActionBarrierTokenIsCurrent(activeClearActionToken)) {
          await syncOverlaySession(confirmed, null, previous.ok ? previous.value : null);
        }
        if (clearActionBarrierTokenIsCurrent(activeClearActionToken)) {
          await reconcileWidgetSession(lease);
        }
        return { ok: true, data: confirmed };
      }
      case "ui-attach:widget-session-clear":
        return await clearWidgetSession(
          command.expectedEpoch,
          command.operationId,
          command.scope,
          lease,
        );
      case "ui-attach:widget-selection-read":
        return await widgetSelectionStateResponse(elementSelectionTabId === lease.tabId, lease.tabId);
      case "ui-attach:widget-selection-set":
        return await coordinateInPageWidgetContextMutation(lease, async (token) => {
          if (!token.isCurrent() || hasPendingInPageWidgetAction(lease)) {
            return failure(
              "WIDGET_STATE_UNAVAILABLE",
              "Finish the pending marker action before changing capture scope.",
            );
          }
          lease.actionContext = undefined;
          await persistInPageWidgetLease(lease);
          if (!token.isCurrent()) {
            return failure(
              "WIDGET_STATE_UNAVAILABLE",
              "MeanThis widget surface is no longer available.",
            );
          }
          if (!command.enabled) {
            const response = await setElementSelectionLease({
              type: "ui-attach:element-selection-set",
              enabled: false,
            }, undefined, undefined, undefined, undefined, undefined, token.isCurrent,
            command.intent, command.expectedGeneration);
            if (!token.isCurrent()) {
              return failure(
                "WIDGET_STATE_UNAVAILABLE",
                "MeanThis widget surface is no longer available.",
              );
            }
            return response.ok
              ? await widgetSelectionStateResponse(response.data.enabled, lease.tabId)
              : response;
          }
          const resumable = await getResumableElementSelectionScope(lease.tabId);
          if (!token.isCurrent()) {
            return failure(
              "WIDGET_STATE_UNAVAILABLE",
              "MeanThis widget surface is no longer available.",
            );
          }
          const response = await setElementSelectionLease(
            {
              type: "ui-attach:element-selection-set",
              enabled: true,
              tabId: lease.tabId,
              ...(command.collectBasicDiagnostics === true
                ? { collectBasicDiagnostics: true as const }
                : {}),
            },
            resumable?.target,
            resumable?.expectedPage,
            undefined,
            undefined,
            undefined,
            token.isCurrent,
            command.intent,
            command.expectedGeneration,
          );
          return response.ok
            ? await widgetSelectionStateResponse(response.data.enabled, lease.tabId)
            : response;
        });
      case "ui-attach:widget-basic-diagnostics-set":
        return await coordinateElementSelectionCaptureMutation(() =>
          coordinateInPageWidgetContextMutation(lease, async (token) => {
            if (!token.isCurrent() || hasPendingInPageWidgetAction(lease)) {
              return failure(
                "WIDGET_STATE_UNAVAILABLE",
                "Finish the pending marker action before changing capture diagnostics.",
              );
            }
            const selectionRevision = elementSelectionRevision;
            const selectionIntent = await selectionIntentStore.read();
            if (!token.isCurrent()) {
              return failure(
                "WIDGET_STATE_UNAVAILABLE",
                "MeanThis widget surface is no longer available.",
              );
            }
            if (!selectionIntent.ok ||
                selectionIntent.value.generation !== command.expectedGeneration) {
              return failure(
                "WIDGET_STATE_UNAVAILABLE",
                "The capture selection state changed before diagnostics were updated.",
              );
            }
            const selectionOwned = elementSelectionTabId === lease.tabId;
            if (
              selectionOwned && (
                elementSelectionRevision !== selectionRevision ||
                elementSelectionAuthorityGeneration !== command.expectedGeneration ||
                selectionIntent.value.desired !== "enabled" ||
                selectionIntent.value.clearOperationId !== null ||
                selectionIntent.value.ownerTabId !== lease.tabId
              )
            ) {
              return failure(
                "WIDGET_STATE_UNAVAILABLE",
                "The capture selection lease changed before diagnostics were updated.",
              );
            }
            if (selectionOwned) {
              elementSelectionBasicDiagnosticsArm = command.enabled
                ? {
                    selectionRevision,
                    selectionGeneration: command.expectedGeneration,
                  }
                : null;
            }
            return token.isCurrent()
              ? await widgetSelectionStateResponse(selectionOwned, lease.tabId)
              : failure(
                  "WIDGET_STATE_UNAVAILABLE",
                  "MeanThis widget surface is no longer available.",
                );
          })
        );
      case "ui-attach:widget-frame-scope-list":
        return await listWidgetFrameScopes(lease);
      case "ui-attach:widget-frame-scope-select":
        return await selectWidgetFrameScope(command, lease);
      case "ui-attach:widget-overlay-active":
      {
        const activePage = await requireWidgetCapturePageContext(lease);
        if (!activePage.ok) return activePage.response;
        const response = await syncStoredOverlaySession(activePage.value.origin, command.itemId);
        if (response?.ok) await reconcileWidgetSession(lease);
        return response;
      }
      case "ui-attach:widget-side-panel-open":
      {
        const outcome = await openSidePanelWithTimeout(
          openSidePanel,
          resolveSidePanelOpenOptions({ id: lease.tabId, windowId: lease.windowId }),
        );
        if (outcome === "timeout") {
          return failure("SIDE_PANEL_OPEN_TIMEOUT", SIDE_PANEL_OPEN_TIMEOUT_ERROR);
        }
        if (outcome === "rejected") return failure("CAPTURE_FAILED", SAFE_CAPTURE_ERROR);
        return { ok: true, data: null };
      }
      case "ui-attach:widget-lifecycle-control-read-next":
        return clearActionToken
          ? await readWidgetAnnotationLifecycleControlProposal(lease, clearActionToken)
          : clearInProgress();
      case "ui-attach:widget-lifecycle-control-approve":
        return command.userActivation && clearActionToken
          ? await approveWidgetAnnotationLifecycleControlProposal(
              lease,
              command.reference,
              clearActionToken,
            )
          : untrustedSender();
      case "ui-attach:widget-lifecycle-control-reject":
        return command.userActivation
          ? await rejectWidgetAnnotationLifecycleControlProposal(lease, command.reference)
          : untrustedSender();
      case "ui-attach:widget-bridge-read-status": {
        const bridgeCommand = { type: "ui-attach:local-agent-bridge", action: "read-status" };
        const runtimeFeature = runtimeFeatures.find((feature) => feature.matches(bridgeCommand));
        return runtimeFeature ? await runtimeFeature.handle(bridgeCommand) : untrustedSender();
      }
      case "ui-attach:widget-bridge-create-invitation":
        return await handleWidgetBridgeCommandWithReconcile({
          type: "ui-attach:local-agent-bridge",
          action: "create-connection-request",
          approvalMode: "browser_session",
        }, lease);
      case "ui-attach:widget-bridge-refresh":
        return await handleWidgetBridgeCommandWithReconcile({
          type: "ui-attach:local-agent-bridge",
          action: "refresh-connection",
        }, lease);
      case "ui-attach:widget-bridge-disconnect":
      {
        return await coordinateAnnotationLifecycleControlExecution(async () => {
          if (!inPageWidgetLeaseIsCurrent(lease)) {
            return failure("ACTIVE_PAGE_UNAVAILABLE", "MeanThis could not verify the widget page.");
          }
          if (!await terminateAnnotationLifecycleControlForCanonicalRemovalExclusive(
            () => true,
            () => true,
          )) {
            return failure(
              "CAPTURE_FAILED",
              "MeanThis could not finish pending Agent lifecycle approvals before disconnecting.",
            );
          }
          const disconnected = await handleWidgetBridgeCommand({
            type: "ui-attach:local-agent-bridge",
            action: "disconnect",
          });
          if (!disconnected?.ok) return disconnected;
          return disconnected;
        });
      }
      case "ui-attach:widget-disclosure-read":
        return { ok: true, data: { acknowledged: await isFirstCaptureDisclosureAcknowledged() } };
      case "ui-attach:widget-disclosure-acknowledge":
        await firstCaptureDisclosure.acknowledge();
        return { ok: true, data: { acknowledged: true } };
    }
  }

  async function readWidgetAnnotationLifecycleControlProposal(
    lease: InPageWidgetLease,
    clearActionToken: ClearActionBarrierToken,
  ): Promise<RuntimeResponse> {
    await recoverAnnotationLifecycleControlExecutions();
    return await coordinateAnnotationLifecycleControlExecution(async () => {
      if (!clearActionBarrierTokenIsCurrent(clearActionToken)) return clearInProgress();
      if (!inPageWidgetLeaseIsCurrent(lease)) {
        return failure("ACTIVE_PAGE_UNAVAILABLE", "MeanThis could not verify the widget page.");
      }
      let response: RuntimeResponse;
      try {
        response = await handleWidgetBridgeCommand({
          type: "ui-attach:local-agent-bridge",
          action: "control-read-next",
        });
      } catch {
        return failure("CAPTURE_FAILED", "MeanThis could not read Agent lifecycle proposals.");
      }
      if (!response?.ok) return response;
      if (!clearActionBarrierTokenIsCurrent(clearActionToken)) return clearInProgress();
      if (!inPageWidgetLeaseIsCurrent(lease)) {
        return failure("ACTIVE_PAGE_UNAVAILABLE", "MeanThis could not verify the widget page.");
      }
      if (response.data === null) {
        await removeDeliveredAnnotationLifecycleControlProposals((delivery) =>
          delivery.surfaceId === lease.surfaceId
        );
        return clearActionBarrierTokenIsCurrent(clearActionToken)
          ? { ok: true, data: null }
          : clearInProgress();
      }
      const view = parseAnnotationLifecycleOperationView(response.data);
      if (!view || !await annotationLifecycleControlFingerprintMatchesProposal(
        view.record.proposal,
        view.reference.fingerprint,
      )) {
        return failure("INVALID_COMMAND", "MeanThis received an invalid Agent lifecycle proposal.");
      }
      const resolved = await resolveWidgetAnnotationLifecycleControlProposal(lease, view);
      if (!resolved.ok) return resolved.response;
      const activeClearActionToken = retargetClearActionBarrierToken(
        clearActionToken,
        resolved.value.activePage.origin,
        resolved.value.activePage.tabId,
      );
      if (!clearActionBarrierTokenIsCurrent(activeClearActionToken)) return clearInProgress();
      if (!inPageWidgetLeaseIsCurrent(lease)) {
        return failure("ACTIVE_PAGE_UNAVAILABLE", "MeanThis could not verify the widget page.");
      }
      const persisted = await persistDeliveredAnnotationLifecycleControlProposal(
        lease,
        view.reference,
        resolved.value.activePage,
        view.record.expiresAt,
      );
      if (!persisted) {
        return failure("STORAGE_ERROR", "MeanThis could not persist the delivered Agent proposal.");
      }
      if (clearActionBarrierTokenIsCurrent(activeClearActionToken) && inPageWidgetLeaseIsCurrent(lease)) {
        return { ok: true, data: resolved.value.proposal };
      }
      try {
        await removeDeliveredAnnotationLifecycleControlProposals((delivery) =>
          delivery.surfaceId === lease.surfaceId &&
          delivery.reference.operationId === view.reference.operationId &&
          sameAnnotationLifecycleControlReference(delivery.reference, view.reference)
        );
      } catch {
        return failure("STORAGE_ERROR", "MeanThis could not retire a proposal delivered during clear.");
      }
      return clearActionBarrierTokenIsCurrent(activeClearActionToken)
        ? failure("ACTIVE_PAGE_UNAVAILABLE", "MeanThis could not verify the widget page.")
        : clearInProgress();
    });
  }

  async function approveWidgetAnnotationLifecycleControlProposal(
    lease: InPageWidgetLease,
    reference: AnnotationLifecycleOperationReferenceV1,
    clearActionToken: ClearActionBarrierToken,
  ): Promise<RuntimeResponse> {
    return await coordinateAnnotationLifecycleControlExecution(() =>
      approveWidgetAnnotationLifecycleControlProposalExclusive(
        lease,
        reference,
        clearActionToken,
      )
    );
  }

  async function approveWidgetAnnotationLifecycleControlProposalExclusive(
    lease: InPageWidgetLease,
    reference: AnnotationLifecycleOperationReferenceV1,
    clearActionToken: ClearActionBarrierToken,
  ): Promise<RuntimeResponse> {
    if (!clearActionBarrierTokenIsCurrent(clearActionToken)) return clearInProgress();
    if (!inPageWidgetLeaseIsCurrent(lease)) {
      return failure("ACTIVE_PAGE_UNAVAILABLE", "MeanThis could not verify the widget page.");
    }
    const delivered = await readCurrentWidgetAnnotationLifecycleControlView(lease, reference);
    if (!delivered.ok) return delivered.response;
    if (!inPageWidgetLeaseIsCurrent(lease)) {
      return failure("ACTIVE_PAGE_UNAVAILABLE", "MeanThis could not verify the widget page.");
    }
    let claimResponse: RuntimeResponse;
    try {
      claimResponse = await handleWidgetBridgeCommand({
        type: "ui-attach:local-agent-bridge",
        action: "control-claim",
        reference,
      });
    } catch {
      return failure("CAPTURE_FAILED", "MeanThis could not claim the Agent lifecycle proposal.");
    }
    if (!claimResponse?.ok) return claimResponse;
    const claim = parseAnnotationLifecycleOperationClaim(claimResponse.data);
    if (!claim || !sameAnnotationLifecycleControlReference(claim.reference, reference) ||
        !await annotationLifecycleControlFingerprintMatchesProposal(
          claim.record.proposal,
          claim.reference.fingerprint,
        )) {
      return failure("INVALID_COMMAND", "MeanThis received an invalid Agent lifecycle claim.");
    }
    if (!inPageWidgetLeaseIsCurrent(lease)) {
      return failure("ACTIVE_PAGE_UNAVAILABLE", "MeanThis could not verify the widget page.");
    }
    const resolved = await resolveWidgetAnnotationLifecycleControlProposal(lease, claim);
    if (!resolved.ok) return resolved.response;
    const activeClearActionToken = retargetClearActionBarrierToken(
      clearActionToken,
      resolved.value.activePage.origin,
      resolved.value.activePage.tabId,
    );
    if (!clearActionBarrierTokenIsCurrent(activeClearActionToken)) return clearInProgress();
    if (!inPageWidgetLeaseIsCurrent(lease)) {
      return failure("ACTIVE_PAGE_UNAVAILABLE", "MeanThis could not verify the widget page.");
    }

    const { activePage, item, readback } = resolved.value;
    const routeLeaseHash = await hashAnnotationLifecycleControlRouteLease(
      activePage,
      item.sourceRecord as OriginCaptureRecord,
    );
    if (!routeLeaseHash) {
      return failure("STORAGE_ERROR", "MeanThis could not bind the Agent lifecycle approval.");
    }
    if (!inPageWidgetLeaseIsCurrent(lease)) {
      return failure("ACTIVE_PAGE_UNAVAILABLE", "MeanThis could not verify the widget page.");
    }
    const approvedRecord: ApprovedAnnotationLifecycleOperationV1 = {
      schemaVersion: ANNOTATION_LIFECYCLE_CONTROL_EXECUTION_SCHEMA_VERSION,
      kind: ANNOTATION_LIFECYCLE_CONTROL_EXECUTION_KIND,
      phase: "approved",
      proposal: claim.record.proposal,
      reference: claim.reference,
      approval: claim.approval,
      origin: activePage.origin,
      epoch: readback.epoch!,
      itemId: item.id,
      surfaceId: lease.surfaceId,
      tabId: activePage.tabId,
      frameId: activePage.frameId,
      documentId: activePage.documentId,
      pathname: activePage.pathname,
      routeLeaseHash,
      terminalStatus: null,
      terminalObservedAt: null,
      committedReceipt: null,
    };
    let execution: ApprovedAnnotationLifecycleOperationV1;
    try {
      const existing = await annotationLifecycleControlExecutionStore.read(
        activePage.origin,
        claim.record.proposal.operationId,
      );
      if (existing && !approvedExecutionMatchesLiveApproval(existing, approvedRecord)) {
        return failure("STALE_SESSION", "The Agent lifecycle approval no longer matches this page.");
      }
      execution = existing ?? await annotationLifecycleControlExecutionStore.saveApproved(
        approvedRecord,
      );
      if (!inPageWidgetLeaseIsCurrent(lease)) {
        return failure("ACTIVE_PAGE_UNAVAILABLE", "MeanThis could not verify the widget page.");
      }
      if (!await removeDeliveredAnnotationLifecycleControlProposalForExecution(execution)) {
        return failure("STORAGE_ERROR", "MeanThis could not complete the lifecycle approval handoff.");
      }
    } catch {
      return failure("STORAGE_ERROR", "MeanThis could not persist the Agent lifecycle approval.");
    }
    try {
      await options.annotationLifecycleExecutionGate?.afterApproved(
        execution.proposal.operationId,
      );
    } catch {
      return failure("STORAGE_ERROR", "MeanThis could not verify the lifecycle approval checkpoint.");
    }
    if (!clearActionBarrierTokenIsCurrent(activeClearActionToken)) return clearInProgress();
    if (!inPageWidgetLeaseIsCurrent(lease)) {
      return failure("ACTIVE_PAGE_UNAVAILABLE", "MeanThis could not verify the widget page.");
    }

    return await continueWidgetAnnotationLifecycleControlExecution(
      lease,
      execution,
      activeClearActionToken,
      resolved.value,
    );
  }

  async function continueWidgetAnnotationLifecycleControlExecution(
    lease: InPageWidgetLease,
    execution: ApprovedAnnotationLifecycleOperationV1,
    clearActionToken: ClearActionBarrierToken,
    resolvedValue?: {
      activePage: ActivePageContext & { documentId: string };
      readback: ActiveSessionReadback;
      item: NonNullable<ActiveSessionReadback["file"]>["session"]["attachments"][number];
    },
  ): Promise<RuntimeResponse> {
    if (!clearActionBarrierTokenIsCurrent(clearActionToken)) return clearInProgress();
    const resolved = resolvedValue ?? await resolvePersistedAnnotationLifecycleControlExecution(
      lease,
      execution,
    );
    let committed = execution.phase === "committed" ? execution : null;
    if (!resolved) {
      if (execution.phase === "approved") {
        const recovery = await recoverCommittedAnnotationLifecycleControlExecution(execution);
        if (recovery.status === "unknown") {
          return failure(
            "STORAGE_ERROR",
            "MeanThis could not determine whether the lifecycle change was already committed.",
          );
        }
        committed = recovery.status === "committed" ? recovery.execution : null;
      }
      if (committed) {
        if (!await reconcileWidgetSession(lease)) {
          return failure(
            "CAPTURE_FAILED",
            "MeanThis saved the lifecycle change but is still waiting to publish Agent readback.",
          );
        }
        const finalized = await finalizeAnnotationLifecycleControlSuccess(committed);
        return finalized
          ? { ok: true, data: finalized }
          : failure(
              "CAPTURE_FAILED",
              "MeanThis saved the lifecycle change but did not receive its exact Agent ACK.",
            );
      }
      await finalizeAnnotationLifecycleControlFailure(execution, "blocked");
      return failure("STALE_SESSION", "The Agent lifecycle approval no longer matches this page.");
    }
    const { activePage, item, readback } = resolved;
    if (!committed) {
      const mutationAuthority = createInPageWidgetMutationAuthority(
        lease,
        activePage,
        item.sourceRecord.attachment.id,
        clearActionToken,
        execution.approval.expiresAt,
        execution.reference,
      );
      const applied = await store.applyAnnotationLifecycleOperation({
        origin: activePage.origin,
        epoch: readback.epoch!,
        itemId: item.id,
        annotationId: execution.proposal.annotationId,
        expectedState: execution.proposal.expectedState,
        nextState: execution.proposal.nextState,
        operationId: execution.proposal.operationId,
        requestHash: execution.reference.fingerprint,
      }, mutationAuthority);
      if (!applied.ok) {
        if (
          applied.code === "ANNOTATION_LIFECYCLE_NOT_COMMITTED" ||
          applied.code === "STALE_SESSION" ||
          applied.code === "ITEM_NOT_FOUND"
        ) {
          await finalizeAnnotationLifecycleControlFailure(execution, "blocked");
        }
        if (applied.code === "ANNOTATION_LIFECYCLE_NOT_COMMITTED") {
          return failure("STALE_SESSION", "The Agent lifecycle approval no longer matches this page.");
        }
        return failureFromStore(applied);
      }
      try {
        await options.annotationLifecycleExecutionGate?.afterCanonicalCommit(
          execution.proposal.operationId,
        );
      } catch {
        return failure(
          "STORAGE_ERROR",
          "MeanThis saved the lifecycle change but could not verify its commit checkpoint.",
        );
      }
      try {
        committed = await annotationLifecycleControlExecutionStore.markCommitted(
          activePage.origin,
          execution.proposal.operationId,
          execution.reference.fingerprint,
          applied.value.receipt,
        );
      } catch {
        return failure(
          "STORAGE_ERROR",
          "MeanThis committed the lifecycle change but could not persist its ACK state.",
        );
      }
      try {
        await options.annotationLifecycleExecutionGate?.afterCommitted(
          committed.proposal.operationId,
        );
      } catch {
        return failure(
          "STORAGE_ERROR",
          "MeanThis committed the lifecycle change but could not verify its ACK checkpoint.",
        );
      }
    }
    if (!committed.committedReceipt) {
      return failure("STORAGE_ERROR", "MeanThis could not read the committed lifecycle receipt.");
    }
    if (!clearActionBarrierTokenIsCurrent(clearActionToken)) return clearInProgress();
    if (!await reconcileWidgetSession(lease)) {
      return failure(
        "CAPTURE_FAILED",
        "MeanThis saved the lifecycle change but is still waiting to publish Agent readback.",
      );
    }
    if (!clearActionBarrierTokenIsCurrent(clearActionToken)) return clearInProgress();
    const finalized = await finalizeAnnotationLifecycleControlSuccess(committed);
    if (!finalized) {
      return failure(
        "CAPTURE_FAILED",
        "MeanThis saved the lifecycle change but did not receive its exact Agent ACK.",
      );
    }
    return { ok: true, data: finalized };
  }

  async function recoverCommittedAnnotationLifecycleControlExecution(
    execution: ApprovedAnnotationLifecycleOperationV1,
  ): Promise<
    | { status: "committed"; execution: ApprovedAnnotationLifecycleOperationV1 }
    | { status: "not_committed" }
    | { status: "unknown" }
  > {
    const replay = await store.applyAnnotationLifecycleOperation({
      origin: execution.origin,
      epoch: execution.epoch,
      itemId: execution.itemId,
      annotationId: execution.proposal.annotationId,
      expectedState: execution.proposal.expectedState,
      nextState: execution.proposal.nextState,
      operationId: execution.proposal.operationId,
      requestHash: execution.reference.fingerprint,
    }, {
      isCurrent: () => false,
      refresh: async () => false,
    });
    if (!replay.ok) {
      return replay.code === "ANNOTATION_LIFECYCLE_NOT_COMMITTED"
        ? { status: "not_committed" }
        : { status: "unknown" };
    }
    try {
      return {
        status: "committed",
        execution: await annotationLifecycleControlExecutionStore.markCommitted(
          execution.origin,
          execution.proposal.operationId,
          execution.reference.fingerprint,
          replay.value.receipt,
        ),
      };
    } catch {
      return { status: "unknown" };
    }
  }

  async function rejectWidgetAnnotationLifecycleControlProposal(
    lease: InPageWidgetLease,
    reference: AnnotationLifecycleOperationReferenceV1,
  ): Promise<RuntimeResponse> {
    return await coordinateAnnotationLifecycleControlExecution(async () => {
      if (!inPageWidgetLeaseIsCurrent(lease)) {
        return failure("ACTIVE_PAGE_UNAVAILABLE", "MeanThis could not verify the widget page.");
      }
    const delivered = await readCurrentWidgetAnnotationLifecycleControlView(lease, reference);
    if (!delivered.ok) return delivered.response;
    let response: RuntimeResponse;
    try {
      response = await handleWidgetBridgeCommand({
        type: "ui-attach:local-agent-bridge",
        action: "control-reject",
        reference,
      });
    } catch {
      return failure("CAPTURE_FAILED", "MeanThis could not reject the Agent lifecycle proposal.");
    }
    if (!response?.ok) return response;
    const rejected = parseAnnotationLifecycleOperationView(response.data);
    if (
      !rejected || rejected.record.phase !== "rejected" ||
      !sameAnnotationLifecycleControlReference(rejected.reference, reference) ||
      !await annotationLifecycleControlFingerprintMatchesProposal(
        rejected.record.proposal,
        rejected.reference.fingerprint,
      )
    ) return failure("INVALID_COMMAND", "MeanThis received an invalid Agent lifecycle rejection.");
    if (!inPageWidgetLeaseIsCurrent(lease)) {
      return failure("ACTIVE_PAGE_UNAVAILABLE", "MeanThis could not verify the widget page.");
    }
    try {
      await annotationLifecycleControlDeliveryStore.remove(
        lease.surfaceId,
        reference.operationId,
      );
    } catch {
      return failure(
        "STORAGE_ERROR",
        "MeanThis rejected the Agent lifecycle proposal but could not retire its local marker.",
      );
    }
    return { ok: true, data: rejected };
    });
  }

  async function readCurrentWidgetAnnotationLifecycleControlView(
    lease: InPageWidgetLease,
    reference: AnnotationLifecycleOperationReferenceV1,
  ): Promise<
    | { ok: true; value: AnnotationLifecycleOperationViewV1 }
    | { ok: false; response: SessionCommandResponse<never> }
  > {
    let response: RuntimeResponse;
    try {
      response = await handleWidgetBridgeCommand({
        type: "ui-attach:local-agent-bridge",
        action: "control-read-next",
      });
    } catch {
      return {
        ok: false,
        response: failure("CAPTURE_FAILED", "MeanThis could not refresh the Agent lifecycle proposal."),
      };
    }
    if (!response?.ok || response.data === null) {
      return {
        ok: false,
        response: response && !response.ok
          ? response as SessionCommandResponse<never>
          : failure("STALE_SESSION", "The Agent lifecycle proposal is no longer pending."),
      };
    }
    const view = parseAnnotationLifecycleOperationView(response.data);
    if (!view || !sameAnnotationLifecycleControlReference(view.reference, reference) ||
        !await annotationLifecycleControlFingerprintMatchesProposal(
          view.record.proposal,
          view.reference.fingerprint,
        )) {
      return {
        ok: false,
        response: failure("STALE_SESSION", "The Agent lifecycle proposal changed before approval."),
      };
    }
    const resolved = await resolveWidgetAnnotationLifecycleControlProposal(lease, view);
    return resolved.ok
      ? { ok: true, value: view }
      : { ok: false, response: resolved.response };
  }

  async function resolveWidgetAnnotationLifecycleControlProposal(
    lease: InPageWidgetLease,
    view: AnnotationLifecycleOperationViewV1 | AnnotationLifecycleOperationClaimV1,
  ): Promise<
    | {
        ok: true;
        value: {
          proposal: WidgetAnnotationLifecycleControlProposal;
          activePage: ActivePageContext & { documentId: string };
          readback: ActiveSessionReadback;
          item: NonNullable<ActiveSessionReadback["file"]>["session"]["attachments"][number];
        };
      }
    | { ok: false; response: SessionCommandResponse<never> }
  > {
    if (!inPageWidgetLeaseIsCurrent(lease)) {
      return {
        ok: false,
        response: failure("ACTIVE_PAGE_UNAVAILABLE", "MeanThis could not verify the widget page."),
      };
    }
    if (
      view.record.phase !== "awaiting_user" && view.record.phase !== "approved" &&
      view.record.phase !== "executing"
    ) {
      return {
        ok: false,
        response: failure("STALE_SESSION", "The Agent lifecycle proposal is no longer active."),
      };
    }
    const activePage = await getWidgetCapturePageContext(lease);
    if (!activePage?.documentId || !inPageWidgetLeaseIsCurrent(lease)) {
      return {
        ok: false,
        response: failure("ACTIVE_PAGE_UNAVAILABLE", "MeanThis could not verify the widget page."),
      };
    }
    const readbackResult = await store.read(activePage.origin);
    if (!inPageWidgetLeaseIsCurrent(lease)) {
      return {
        ok: false,
        response: failure("ACTIVE_PAGE_UNAVAILABLE", "MeanThis could not verify the widget page."),
      };
    }
    if (!readbackResult.ok) {
      return { ok: false, response: failureFromStore(readbackResult) };
    }
    const readback = readbackResult.value;
    const file = readback.file;
    if (
      readback.clearPending || !readback.epoch || !file || file.schemaVersion !== "0.3.0" ||
      file.session.id !== view.record.proposal.captureId
    ) {
      return {
        ok: false,
        response: failure("STALE_SESSION", "The Agent lifecycle proposal no longer matches this capture."),
      };
    }
    const matches = file.session.attachments.filter((candidate) =>
      candidate.annotationId === view.record.proposal.annotationId
    );
    const item = matches.length === 1 ? matches[0]! : null;
    if (!item || !isOverlayPreviewRecordOnPage(item.sourceRecord as OriginCaptureRecord, activePage)) {
      return {
        ok: false,
        response: failure("STALE_SESSION", "The Agent lifecycle target is no longer on this page."),
      };
    }
    if (!inPageWidgetLeaseIsCurrent(lease)) {
      return {
        ok: false,
        response: failure("ACTIVE_PAGE_UNAVAILABLE", "MeanThis could not verify the widget page."),
      };
    }
    let persisted: ApprovedAnnotationLifecycleOperationV1 | null;
    try {
      persisted = await annotationLifecycleControlExecutionStore.read(
        activePage.origin,
        view.record.proposal.operationId,
      );
    } catch {
      return {
        ok: false,
        response: failure(
          "STORAGE_ERROR",
          "MeanThis could not verify the persisted Agent lifecycle approval.",
        ),
      };
    }
    const expectedCurrentState = persisted?.phase === "committed"
      ? view.record.proposal.nextState
      : view.record.proposal.expectedState;
    if (item.annotationLifecycle.state !== expectedCurrentState) {
      return {
        ok: false,
        response: failure("STALE_SESSION", "The annotation lifecycle state changed before approval."),
      };
    }
    const label = item.labels.find((candidate) => candidate.trim())?.trim() ?? "?";
    return {
      ok: true,
      value: {
        proposal: {
          itemId: item.id,
          label,
          operationId: view.record.proposal.operationId,
          fingerprint: view.record.fingerprint,
          expectedState: view.record.proposal.expectedState,
          nextState: view.record.proposal.nextState,
          expiresAt: view.record.expiresAt,
          reference: view.reference,
        },
        activePage: { ...activePage, documentId: activePage.documentId },
        readback,
        item,
      },
    };
  }

  function approvedExecutionMatchesLiveApproval(
    existing: ApprovedAnnotationLifecycleOperationV1,
    expected: ApprovedAnnotationLifecycleOperationV1,
  ): boolean {
    return existing.phase !== "terminal" &&
      sameAnnotationLifecycleControlProposal(existing.proposal, expected.proposal) &&
      existing.reference.fingerprint === expected.reference.fingerprint &&
      existing.reference.ownerGeneration === expected.reference.ownerGeneration &&
      existing.reference.connectionGeneration === expected.reference.connectionGeneration &&
      existing.approval.approvedAt === expected.approval.approvedAt &&
      existing.approval.expiresAt === expected.approval.expiresAt &&
      existing.origin === expected.origin && existing.epoch === expected.epoch &&
      existing.itemId === expected.itemId && existing.surfaceId === expected.surfaceId &&
      existing.tabId === expected.tabId && existing.frameId === expected.frameId &&
      existing.documentId === expected.documentId && existing.pathname === expected.pathname &&
      existing.routeLeaseHash === expected.routeLeaseHash;
  }

  function sameAnnotationLifecycleControlProposal(
    left: ApprovedAnnotationLifecycleOperationV1["proposal"],
    right: ApprovedAnnotationLifecycleOperationV1["proposal"],
  ): boolean {
    return left.schemaVersion === right.schemaVersion && left.kind === right.kind &&
      left.operationId === right.operationId && left.instanceId === right.instanceId &&
      left.captureId === right.captureId && left.expectedSequence === right.expectedSequence &&
      left.annotationId === right.annotationId && left.expectedState === right.expectedState &&
      left.nextState === right.nextState;
  }

  function sameAnnotationLifecycleControlReference(
    left: AnnotationLifecycleOperationReferenceV1,
    right: AnnotationLifecycleOperationReferenceV1,
  ): boolean {
    return left.operationId === right.operationId && left.fingerprint === right.fingerprint &&
      left.ownerGeneration === right.ownerGeneration &&
      left.connectionGeneration === right.connectionGeneration;
  }

  function inPageWidgetLeaseIsCurrent(lease: InPageWidgetLease): boolean {
    return inPageWidgetLeasesBySurfaceId.get(lease.surfaceId) === lease &&
      !invalidatedInPageWidgetLeasesBySurfaceId.has(lease.surfaceId);
  }

  async function annotationLifecycleControlFingerprintMatchesProposal(
    proposal: AnnotationLifecycleOperationViewV1["record"]["proposal"],
    fingerprint: string,
  ): Promise<boolean> {
    const input = createAnnotationLifecycleOperationFingerprintInput(proposal);
    if (!input) return false;
    try {
      const bytes = new Uint8Array(input.byteLength);
      bytes.set(input);
      const digest = await crypto.subtle.digest("SHA-256", bytes.buffer);
      const actual = Array.from(
        new Uint8Array(digest),
        (byte) => byte.toString(16).padStart(2, "0"),
      ).join("");
      return actual === fingerprint;
    } catch {
      return false;
    }
  }

  function createAnnotationLifecycleControlSuccessReceipt(
    committed: ApprovedAnnotationLifecycleOperationV1,
  ): AnnotationLifecycleOperationReceiptV1 {
    const appliedAt = committed.committedReceipt!.appliedAt;
    return {
      schemaVersion: ANNOTATION_LIFECYCLE_CONTROL_SCHEMA_VERSION,
      kind: ANNOTATION_LIFECYCLE_OPERATION_RECEIPT_KIND,
      operationId: committed.proposal.operationId,
      fingerprint: committed.reference.fingerprint,
      receiptId: `ledger:${committed.proposal.operationId}`,
      status: "succeeded",
      observedAt: appliedAt,
      resultingState: committed.proposal.nextState,
      readbackAuthority: "durable_ledger",
      executionAuthority: {
        grantedByCapture: false,
        browserControl: false,
        liveDomMutation: false,
      },
    };
  }

  function createAnnotationLifecycleControlFailureReceipt(
    execution: ApprovedAnnotationLifecycleOperationV1,
  ): AnnotationLifecycleOperationReceiptV1 | null {
    if (
      execution.phase !== "terminal" || execution.terminalStatus === null ||
      execution.terminalObservedAt === null
    ) return null;
    return {
      schemaVersion: ANNOTATION_LIFECYCLE_CONTROL_SCHEMA_VERSION,
      kind: ANNOTATION_LIFECYCLE_OPERATION_RECEIPT_KIND,
      operationId: execution.proposal.operationId,
      fingerprint: execution.reference.fingerprint,
      receiptId: `control:${execution.proposal.operationId}:${execution.terminalStatus}`,
      status: execution.terminalStatus,
      observedAt: execution.terminalObservedAt,
      resultingState: null,
      readbackAuthority: "current_snapshot",
      executionAuthority: {
        grantedByCapture: false,
        browserControl: false,
        liveDomMutation: false,
      },
    };
  }

  async function finalizeAnnotationLifecycleControlSuccess(
    committed: ApprovedAnnotationLifecycleOperationV1,
  ): Promise<AnnotationLifecycleOperationViewV1 | null> {
    if (committed.phase !== "committed" || committed.committedReceipt === null) return null;
    const receipt = createAnnotationLifecycleControlSuccessReceipt(committed);
    let response: RuntimeResponse;
    try {
      response = await handleWidgetBridgeCommand({
        type: "ui-attach:local-agent-bridge",
        action: "control-finalize",
        reference: committed.reference,
        approval: committed.approval,
        receipt,
      });
    } catch {
      return null;
    }
    if (!response?.ok) return null;
    const finalized = parseAnnotationLifecycleOperationView(response.data);
    if (
      !finalized || finalized.record.phase !== "applied" ||
      !sameAnnotationLifecycleControlReference(finalized.reference, committed.reference) ||
      finalized.record.receipt?.receiptId !== receipt.receiptId ||
      finalized.record.receipt.observedAt !== receipt.observedAt ||
      finalized.record.receipt.status !== "succeeded" ||
      finalized.record.receipt.resultingState !== committed.proposal.nextState ||
      finalized.record.receipt.readbackAuthority !== "durable_ledger"
    ) return null;
    try {
      await annotationLifecycleControlExecutionStore.remove(
        committed.origin,
        committed.proposal.operationId,
      );
    } catch {
      return null;
    }
    return finalized;
  }

  async function finalizeAnnotationLifecycleControlFailure(
    execution: ApprovedAnnotationLifecycleOperationV1,
    status: Exclude<AnnotationLifecycleOperationTerminalStatus, "succeeded">,
  ): Promise<boolean> {
    if (execution.phase === "committed") return false;
    const expiresAtMs = Date.parse(execution.approval.expiresAt);
    if (
      (execution.phase === "approved" && Date.now() >= expiresAtMs) ||
      (execution.phase === "terminal" && execution.terminalObservedAt !== null &&
        Date.parse(execution.terminalObservedAt) >= expiresAtMs)
    ) {
      try {
        await annotationLifecycleControlExecutionStore.remove(
          execution.origin,
          execution.proposal.operationId,
        );
        return true;
      } catch {
        return false;
      }
    }
    let terminal = execution;
    if (execution.phase === "approved") {
      const observedAt = new Date().toISOString();
      if (Date.parse(observedAt) >= expiresAtMs) return false;
      try {
        terminal = await annotationLifecycleControlExecutionStore.markTerminal(
          execution.origin,
          execution.proposal.operationId,
          execution.reference.fingerprint,
          status,
          observedAt,
        );
      } catch {
        return false;
      }
    }
    if (terminal.terminalStatus !== status) return false;
    const receipt = createAnnotationLifecycleControlFailureReceipt(terminal);
    if (!receipt) return false;
    let response: RuntimeResponse;
    try {
      response = await handleWidgetBridgeCommand({
        type: "ui-attach:local-agent-bridge",
        action: "control-finalize",
        reference: terminal.reference,
        approval: terminal.approval,
        receipt,
      });
    } catch {
      return false;
    }
    if (!response?.ok) return false;
    const finalized = parseAnnotationLifecycleOperationView(response.data);
    if (
      !finalized ||
      !sameAnnotationLifecycleControlReference(finalized.reference, terminal.reference) ||
      finalized.record.receipt?.receiptId !== receipt.receiptId ||
      finalized.record.receipt.observedAt !== receipt.observedAt ||
      finalized.record.receipt.status !== status ||
      finalized.record.receipt.resultingState !== null
    ) return false;
    try {
      await annotationLifecycleControlExecutionStore.remove(
        execution.origin,
        execution.proposal.operationId,
      );
    } catch {
      return false;
    }
    return true;
  }

  async function resolvePersistedAnnotationLifecycleControlExecution(
    lease: InPageWidgetLease,
    execution: ApprovedAnnotationLifecycleOperationV1,
  ): Promise<{
    activePage: ActivePageContext & { documentId: string };
    readback: ActiveSessionReadback;
    item: NonNullable<ActiveSessionReadback["file"]>["session"]["attachments"][number];
  } | null> {
    if (
      inPageWidgetLeasesBySurfaceId.get(lease.surfaceId) !== lease ||
      execution.surfaceId !== lease.surfaceId || execution.tabId !== lease.tabId ||
      (execution.phase === "approved" && Date.now() >= Date.parse(execution.approval.expiresAt))
    ) return null;
    const activePage = await getWidgetCapturePageContext(lease);
    if (
      !activePage?.documentId || activePage.tabId !== execution.tabId ||
      activePage.frameId !== execution.frameId || activePage.documentId !== execution.documentId ||
      activePage.origin !== execution.origin || activePage.pathname !== execution.pathname
    ) return null;
    const readbackResult = await store.read(execution.origin);
    if (!readbackResult.ok) return null;
    const readback = readbackResult.value;
    const file = readback.file;
    if (
      readback.clearPending || readback.epoch !== execution.epoch || !file ||
      file.schemaVersion !== "0.3.0" || file.session.id !== execution.proposal.captureId
    ) return null;
    const matches = file.session.attachments.filter((candidate) =>
      candidate.id === execution.itemId &&
      candidate.annotationId === execution.proposal.annotationId
    );
    const item = matches.length === 1 ? matches[0]! : null;
    const expectedState = execution.phase === "committed"
      ? execution.proposal.nextState
      : execution.proposal.expectedState;
    if (
      !item || item.annotationLifecycle.state !== expectedState ||
      !isOverlayPreviewRecordOnPage(item.sourceRecord as OriginCaptureRecord, activePage)
    ) return null;
    if (
      execution.phase === "committed" && (
        !execution.committedReceipt || item.updatedAt !== execution.committedReceipt.appliedAt
      )
    ) return null;
    const routeLeaseHash = await hashAnnotationLifecycleControlRouteLease(
      { ...activePage, documentId: activePage.documentId },
      item.sourceRecord as OriginCaptureRecord,
    );
    return routeLeaseHash === execution.routeLeaseHash
      ? { activePage: { ...activePage, documentId: activePage.documentId }, readback, item }
      : null;
  }

  async function resolveDurablyCommittedAnnotationLifecycleControlExecution(
    execution: ApprovedAnnotationLifecycleOperationV1,
  ): Promise<{
    activePage: ActivePageContext & { documentId: string };
    readback: ActiveSessionReadback;
    item: NonNullable<ActiveSessionReadback["file"]>["session"]["attachments"][number];
  } | null> {
    if (execution.phase !== "committed" || !execution.committedReceipt) return null;
    const readbackResult = await store.read(execution.origin);
    if (!readbackResult.ok) return null;
    const readback = readbackResult.value;
    const file = readback.file;
    if (
      readback.clearPending || readback.epoch !== execution.epoch || !file ||
      file.schemaVersion !== "0.3.0" || file.session.id !== execution.proposal.captureId
    ) return null;
    const matches = file.session.attachments.filter((candidate) =>
      candidate.id === execution.itemId &&
      candidate.annotationId === execution.proposal.annotationId
    );
    const item = matches.length === 1 ? matches[0]! : null;
    const activePage = {
      tabId: execution.tabId,
      frameId: execution.frameId,
      documentId: execution.documentId,
      origin: execution.origin,
      pathname: execution.pathname,
    };
    if (
      !item || item.annotationLifecycle.state !== execution.proposal.nextState ||
      item.updatedAt !== execution.committedReceipt.appliedAt ||
      !isOverlayPreviewRecordOnPage(item.sourceRecord as OriginCaptureRecord, activePage)
    ) return null;
    const routeLeaseHash = await hashAnnotationLifecycleControlRouteLease(
      activePage,
      item.sourceRecord as OriginCaptureRecord,
    );
    return routeLeaseHash === execution.routeLeaseHash
      ? { activePage, readback, item }
      : null;
  }

  async function reconcileDurablyCommittedAnnotationLifecycleControlExecution(
    execution: ApprovedAnnotationLifecycleOperationV1,
  ): Promise<boolean> {
    const resolved = await resolveDurablyCommittedAnnotationLifecycleControlExecution(execution);
    if (!resolved) return false;
    const { activePage, readback, item } = resolved;
    const currentScope = derivePanelCurrentScope(readback.file, item.id, activePage);
    if (!currentScope.itemIds.includes(item.id)) return false;
    const metadataDiagnostics = await readSessionMetadataDiagnostics(
      activePage.origin,
      readback,
      new Set(currentScope.itemIds),
    );
    try {
      return await reconcileActiveSession({
        enabled: true,
        origin: activePage.origin,
        readback,
        activePage,
        selectedItemId: item.id,
        currentItemIds: currentScope.itemIds,
        ...(metadataDiagnostics ? { metadataDiagnostics } : {}),
      }) === true;
    } catch {
      return false;
    }
  }

  function coordinateAnnotationLifecycleControlExecution<T>(
    operation: () => Promise<T>,
  ): Promise<T> {
    const result = annotationLifecycleControlExecutionTail.then(operation, operation);
    annotationLifecycleControlExecutionTail = result.then(() => undefined, () => undefined);
    return result;
  }

  async function persistDeliveredAnnotationLifecycleControlProposal(
    lease: InPageWidgetLease,
    reference: AnnotationLifecycleOperationReferenceV1,
    activePage: ActivePageContext & { documentId: string },
    expiresAt: string,
  ): Promise<boolean> {
    try {
      const existing = await annotationLifecycleControlDeliveryStore.read(
        lease.surfaceId,
        reference.operationId,
      );
      const record: DeliveredAnnotationLifecycleOperationV1 = {
        schemaVersion: ANNOTATION_LIFECYCLE_CONTROL_DELIVERY_SCHEMA_VERSION,
        kind: ANNOTATION_LIFECYCLE_CONTROL_DELIVERY_KIND,
        reference,
        origin: activePage.origin,
        surfaceId: lease.surfaceId,
        tabId: lease.tabId,
        frameId: activePage.frameId,
        documentId: activePage.documentId,
        pathname: activePage.pathname,
        deliveredAt: existing?.deliveredAt ?? new Date().toISOString(),
        expiresAt,
      };
      const deliveries = await annotationLifecycleControlDeliveryStore.listAll();
      const previousSurfaces = deliveries.filter((delivery) =>
        delivery.reference.operationId === reference.operationId &&
        delivery.surfaceId !== lease.surfaceId
      );
      if (previousSurfaces.some((delivery) =>
        !sameAnnotationLifecycleControlReference(delivery.reference, reference) ||
        delivery.expiresAt !== expiresAt || delivery.origin !== activePage.origin ||
        delivery.tabId !== lease.tabId || delivery.frameId !== activePage.frameId ||
        delivery.documentId !== activePage.documentId ||
        delivery.pathname !== activePage.pathname
      )) return false;
      for (const delivery of previousSurfaces) {
        await annotationLifecycleControlDeliveryStore.remove(
          delivery.surfaceId,
          delivery.reference.operationId,
        );
      }
      await annotationLifecycleControlDeliveryStore.save(record);
      await removeDeliveredAnnotationLifecycleControlProposals((delivery) =>
        delivery.surfaceId === lease.surfaceId &&
        delivery.reference.operationId !== reference.operationId
      );
      return true;
    } catch {
      return false;
    }
  }

  async function removeDeliveredAnnotationLifecycleControlProposals(
    matches: (delivery: DeliveredAnnotationLifecycleOperationV1) => boolean,
  ): Promise<void> {
    const deliveries = await annotationLifecycleControlDeliveryStore.listAll();
    for (const delivery of deliveries.filter(matches)) {
      await annotationLifecycleControlDeliveryStore.remove(
        delivery.surfaceId,
        delivery.reference.operationId,
      );
    }
  }

  async function terminateDeliveredAnnotationLifecycleControlProposals(
    matches: (delivery: DeliveredAnnotationLifecycleOperationV1) => boolean,
  ): Promise<boolean> {
    let deliveries: DeliveredAnnotationLifecycleOperationV1[];
    try {
      deliveries = await annotationLifecycleControlDeliveryStore.listAll();
    } catch {
      return false;
    }
    for (const delivery of deliveries.filter(matches)) {
      if (Date.now() >= Date.parse(delivery.expiresAt)) {
        try {
          await annotationLifecycleControlDeliveryStore.remove(
            delivery.surfaceId,
            delivery.reference.operationId,
          );
        } catch {
          return false;
        }
        continue;
      }
      let response: RuntimeResponse;
      try {
        response = await handleWidgetBridgeCommand({
          type: "ui-attach:local-agent-bridge",
          action: "control-reject",
          reference: delivery.reference,
        });
      } catch {
        return false;
      }
      if (!response?.ok) {
        if (Date.now() < Date.parse(delivery.expiresAt)) return false;
        try {
          await annotationLifecycleControlDeliveryStore.remove(
            delivery.surfaceId,
            delivery.reference.operationId,
          );
        } catch {
          return false;
        }
        continue;
      }
      const rejected = parseAnnotationLifecycleOperationView(response.data);
      if (
        !rejected || rejected.record.phase !== "rejected" ||
        !sameAnnotationLifecycleControlReference(rejected.reference, delivery.reference)
      ) return false;
      try {
        await annotationLifecycleControlDeliveryStore.remove(
          delivery.surfaceId,
          delivery.reference.operationId,
        );
      } catch {
        return false;
      }
    }
    return true;
  }

  function recoverAnnotationLifecycleControlExecutions(): Promise<void> {
    annotationLifecycleControlRecoveryRequested = true;
    if (annotationLifecycleControlRecoveryTask) return annotationLifecycleControlRecoveryTask;
    const task = coordinateAnnotationLifecycleControlExecution(async () => {
      if (!(await storageAccessReady)) return;
      do {
        annotationLifecycleControlRecoveryRequested = false;
        let executions: ApprovedAnnotationLifecycleOperationV1[];
        try {
          executions = await annotationLifecycleControlExecutionStore.listAll();
        } catch {
          return;
        }
        const currentAuthority = await readCurrentAnnotationLifecycleControlAuthority();
        for (const execution of executions) {
          if (!await removeDeliveredAnnotationLifecycleControlProposalForExecution(execution)) {
            continue;
          }
          if (!await annotationLifecycleControlFingerprintMatchesProposal(
            execution.proposal,
            execution.reference.fingerprint,
          )) {
            await annotationLifecycleControlExecutionStore.remove(
              execution.origin,
              execution.proposal.operationId,
            ).catch(() => undefined);
            continue;
          }
          const authorityMatches = currentAuthority !== null &&
            annotationLifecycleControlExecutionUsesAuthority(execution, currentAuthority);
          if (execution.phase === "committed") {
            const lease = inPageWidgetLeasesBySurfaceId.get(execution.surfaceId);
            if (lease && lease.tabId === execution.tabId) {
              const clearActionToken = createClearActionBarrierToken(
                execution.origin,
                execution.tabId,
              );
              if (await validateClearActionBarrierToken(clearActionToken)) {
                if (authorityMatches) {
                  await continueWidgetAnnotationLifecycleControlExecution(
                    lease,
                    execution,
                    clearActionToken,
                  );
                } else if (currentAuthority) {
                  if (await reconcileDurablyCommittedAnnotationLifecycleControlExecution(execution)) {
                    await annotationLifecycleControlExecutionStore.remove(
                      execution.origin,
                      execution.proposal.operationId,
                    ).catch(() => undefined);
                  }
                }
              }
            } else if (authorityMatches) {
              if (await reconcileDurablyCommittedAnnotationLifecycleControlExecution(execution)) {
                await finalizeAnnotationLifecycleControlSuccess(execution);
              }
            } else if (currentAuthority &&
                await reconcileDurablyCommittedAnnotationLifecycleControlExecution(execution)) {
              await annotationLifecycleControlExecutionStore.remove(
                execution.origin,
                execution.proposal.operationId,
              ).catch(() => undefined);
            }
            continue;
          }
          if (execution.phase === "terminal") {
            if (currentAuthority && !authorityMatches) {
              await annotationLifecycleControlExecutionStore.remove(
                execution.origin,
                execution.proposal.operationId,
              ).catch(() => undefined);
              continue;
            }
            await finalizeAnnotationLifecycleControlFailure(execution, execution.terminalStatus!);
            continue;
          }
          const recovery = await recoverCommittedAnnotationLifecycleControlExecution(execution);
          if (recovery.status === "committed") {
            const committed = recovery.execution;
            const lease = inPageWidgetLeasesBySurfaceId.get(committed.surfaceId);
            if (lease && lease.tabId === committed.tabId) {
              const clearActionToken = createClearActionBarrierToken(
                committed.origin,
                committed.tabId,
              );
              if (await validateClearActionBarrierToken(clearActionToken)) {
                if (authorityMatches) {
                  await continueWidgetAnnotationLifecycleControlExecution(
                    lease,
                    committed,
                    clearActionToken,
                  );
                } else if (currentAuthority) {
                  if (await reconcileDurablyCommittedAnnotationLifecycleControlExecution(committed)) {
                    await annotationLifecycleControlExecutionStore.remove(
                      committed.origin,
                      committed.proposal.operationId,
                    ).catch(() => undefined);
                  }
                }
              }
            } else if (authorityMatches) {
              if (await reconcileDurablyCommittedAnnotationLifecycleControlExecution(committed)) {
                await finalizeAnnotationLifecycleControlSuccess(committed);
              }
            } else if (currentAuthority &&
                await reconcileDurablyCommittedAnnotationLifecycleControlExecution(committed)) {
              await annotationLifecycleControlExecutionStore.remove(
                committed.origin,
                committed.proposal.operationId,
              ).catch(() => undefined);
            }
            continue;
          }
          if (recovery.status === "unknown") continue;
          if (Date.now() >= Date.parse(execution.approval.expiresAt)) {
            await annotationLifecycleControlExecutionStore.remove(
              execution.origin,
              execution.proposal.operationId,
            ).catch(() => undefined);
            continue;
          }
          if (!currentAuthority) {
            // A persisted approval is not browser-write authority by itself.
            // Keep it for an exact later retry, but never mutate canonical state
            // while the current Owner/connection generation is unknowable.
            continue;
          }
          if (!authorityMatches) {
            await annotationLifecycleControlExecutionStore.remove(
              execution.origin,
              execution.proposal.operationId,
            ).catch(() => undefined);
            continue;
          }
          const lease = inPageWidgetLeasesBySurfaceId.get(execution.surfaceId);
          if (!lease || lease.tabId !== execution.tabId) continue;
          const clearActionToken = createClearActionBarrierToken(execution.origin, execution.tabId);
          if (!await validateClearActionBarrierToken(clearActionToken)) continue;
          await continueWidgetAnnotationLifecycleControlExecution(
            lease,
            execution,
            clearActionToken,
          );
        }
      } while (annotationLifecycleControlRecoveryRequested);
    });
    const recovery = task.finally(() => {
      if (annotationLifecycleControlRecoveryTask === recovery) {
        annotationLifecycleControlRecoveryTask = null;
      }
    });
    annotationLifecycleControlRecoveryTask = recovery;
    return annotationLifecycleControlRecoveryTask;
  }

  async function terminateAnnotationLifecycleControlExecutions(
    matches: (execution: ApprovedAnnotationLifecycleOperationV1) => boolean,
  ): Promise<boolean> {
    return await coordinateAnnotationLifecycleControlExecution(() =>
      terminateAnnotationLifecycleControlExecutionsExclusive(matches)
    );
  }

  async function terminateAnnotationLifecycleControlExecutionsExclusive(
    matches: (execution: ApprovedAnnotationLifecycleOperationV1) => boolean,
    onDurableSnapshotReconciled?: () => void,
  ): Promise<boolean> {
      let executions: ApprovedAnnotationLifecycleOperationV1[];
      try {
        executions = await annotationLifecycleControlExecutionStore.listAll();
      } catch {
        return false;
      }
      const currentAuthority = await readCurrentAnnotationLifecycleControlAuthority();
      for (const execution of executions.filter(matches)) {
        if (!await annotationLifecycleControlFingerprintMatchesProposal(
          execution.proposal,
          execution.reference.fingerprint,
        )) {
          try {
            await annotationLifecycleControlExecutionStore.remove(
              execution.origin,
              execution.proposal.operationId,
            );
          } catch {
            return false;
          }
          continue;
        }
        if (!await removeDeliveredAnnotationLifecycleControlProposalForExecution(execution)) {
          return false;
        }
        if (currentAuthority && !annotationLifecycleControlExecutionUsesAuthority(
          execution,
          currentAuthority,
        )) {
          if (execution.phase === "committed") {
            if (!await reconcileDurablyCommittedAnnotationLifecycleControlExecution(execution)) {
              return false;
            }
            onDurableSnapshotReconciled?.();
          } else if (execution.phase === "approved") {
            const recovery = await recoverCommittedAnnotationLifecycleControlExecution(execution);
            if (recovery.status === "unknown") return false;
            if (recovery.status === "committed" &&
                !await reconcileDurablyCommittedAnnotationLifecycleControlExecution(
                  recovery.execution,
                )) return false;
            if (recovery.status === "committed") onDurableSnapshotReconciled?.();
          }
          try {
            await annotationLifecycleControlExecutionStore.remove(
              execution.origin,
              execution.proposal.operationId,
            );
          } catch {
            return false;
          }
          continue;
        }
        if (execution.phase === "committed") {
          if (!await reconcileDurablyCommittedAnnotationLifecycleControlExecution(execution)) {
            return false;
          }
          onDurableSnapshotReconciled?.();
          if (!await finalizeAnnotationLifecycleControlSuccess(execution)) return false;
          continue;
        }
        if (execution.phase === "approved") {
          const recovery = await recoverCommittedAnnotationLifecycleControlExecution(execution);
          if (recovery.status === "committed") {
            if (!await reconcileDurablyCommittedAnnotationLifecycleControlExecution(
              recovery.execution,
            )) return false;
            onDurableSnapshotReconciled?.();
            if (!await finalizeAnnotationLifecycleControlSuccess(recovery.execution)) return false;
            continue;
          }
          if (recovery.status === "unknown") return false;
          if (Date.now() >= Date.parse(execution.approval.expiresAt)) {
            try {
              await annotationLifecycleControlExecutionStore.remove(
                execution.origin,
                execution.proposal.operationId,
              );
            } catch {
              return false;
            }
            continue;
          }
        }
        if (!await finalizeAnnotationLifecycleControlFailure(execution, "cancelled")) return false;
      }
      return true;
  }

  async function terminateAnnotationLifecycleControlForCanonicalRemovalExclusive(
    deliveryMatches: (delivery: DeliveredAnnotationLifecycleOperationV1) => boolean,
    executionMatches: (execution: ApprovedAnnotationLifecycleOperationV1) => boolean,
    onDurableSnapshotReconciled?: () => void,
  ): Promise<boolean> {
    if (!await terminateAnnotationLifecycleControlExecutionsExclusive(
      executionMatches,
      onDurableSnapshotReconciled,
    )) return false;
    return await terminateDeliveredAnnotationLifecycleControlProposals(deliveryMatches);
  }

  async function terminateAnnotationLifecycleControlForCanonicalRemoval(
    deliveryMatches: (delivery: DeliveredAnnotationLifecycleOperationV1) => boolean,
    executionMatches: (execution: ApprovedAnnotationLifecycleOperationV1) => boolean,
    onDurableSnapshotReconciled?: () => void,
  ): Promise<boolean> {
    return await coordinateAnnotationLifecycleControlExecution(() =>
      terminateAnnotationLifecycleControlForCanonicalRemovalExclusive(
        deliveryMatches,
        executionMatches,
        onDurableSnapshotReconciled,
      )
    );
  }

  async function removeDeliveredAnnotationLifecycleControlProposalForExecution(
    execution: ApprovedAnnotationLifecycleOperationV1,
  ): Promise<boolean> {
    try {
      const delivery = await annotationLifecycleControlDeliveryStore.read(
        execution.surfaceId,
        execution.proposal.operationId,
      );
      if (!delivery) return true;
      if (
        !sameAnnotationLifecycleControlReference(delivery.reference, execution.reference) ||
        delivery.origin !== execution.origin || delivery.surfaceId !== execution.surfaceId ||
        delivery.tabId !== execution.tabId || delivery.frameId !== execution.frameId ||
        delivery.documentId !== execution.documentId || delivery.pathname !== execution.pathname ||
        delivery.expiresAt !== execution.approval.expiresAt
      ) return false;
      await annotationLifecycleControlDeliveryStore.remove(
        delivery.surfaceId,
        delivery.reference.operationId,
      );
      return true;
    } catch {
      return false;
    }
  }

  async function readCurrentAnnotationLifecycleControlAuthority(): Promise<
    AnnotationLifecycleControlAuthorityV1 | null
  > {
    let response: RuntimeResponse;
    try {
      response = await handleWidgetBridgeCommand({
        type: "ui-attach:local-agent-bridge",
        action: "control-read-authority",
      });
    } catch {
      return null;
    }
    return response?.ok ? parseAnnotationLifecycleControlAuthority(response.data) : null;
  }

  function annotationLifecycleControlExecutionUsesAuthority(
    execution: ApprovedAnnotationLifecycleOperationV1,
    authority: AnnotationLifecycleControlAuthorityV1,
  ): boolean {
    return execution.reference.ownerGeneration === authority.ownerGeneration &&
      execution.reference.connectionGeneration === authority.connectionGeneration;
  }

  async function hashAnnotationLifecycleControlRouteLease(
    activePage: ActivePageContext & { documentId: string },
    record: OriginCaptureRecord,
  ): Promise<string | null> {
    try {
      const bytes = new TextEncoder().encode(JSON.stringify({
        tabId: activePage.tabId,
        frameId: activePage.frameId,
        documentId: activePage.documentId,
        origin: activePage.origin,
        pathname: activePage.pathname,
        routeChain: record.routeChain ?? [],
      }));
      const digest = await crypto.subtle.digest("SHA-256", bytes);
      return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
    } catch {
      return null;
    }
  }

  async function revokeInPageWidgetTab(
    tabId: number,
    keepRequested: boolean,
    onDurableSnapshotReconciled?: () => void,
  ): Promise<boolean> {
    return await coordinateInPageWidgetLeaseTerminalMutation(tabId, async () => {
      let changed = false;
      for (const [surfaceId, lease] of inPageWidgetLeasesBySurfaceId) {
        if (lease.tabId !== tabId) continue;
        markInPageWidgetLeaseInvalidated(lease);
        invalidateInPageWidgetContextMutation(lease, true);
        cancelInPageWidgetDisconnectExpiry(surfaceId);
        settleInPageWidgetActionAck(surfaceId, undefined, undefined, "dropped");
        inPageWidgetLeasesBySurfaceId.delete(surfaceId);
        pendingInPageWidgetActionsBySurfaceId.delete(surfaceId);
        disconnectPortSafely(lease.port);
        changed = true;
      }
      if (!keepRequested) {
        inPageWidgetRequestedTabs.delete(tabId);
        cancelInPageWidgetShow(tabId);
      }
      await persistInPageWidgetLeaseInvalidations();
      try {
        await inPageWidgetLeaseStore.revokeTab(tabId);
      } catch {
        if (!changed) {
          inPageWidgetLeaseInvalidationAuthorityAvailable = false;
          await persistInPageWidgetLeaseInvalidationPoison();
        }
      }
      try {
        if (!await terminateAnnotationLifecycleControlForCanonicalRemoval(
          (delivery) => delivery.tabId === tabId,
          (execution) => execution.tabId === tabId,
          onDurableSnapshotReconciled,
        )) return false;
      } catch {
        return false;
      }
      if (changed) requestOverlayVisibilityBroadcast();
      return changed;
    });
  }

  function cancelInPageWidgetDisconnectExpiry(surfaceId: string): void {
    const timer = inPageWidgetDisconnectTimersBySurfaceId.get(surfaceId);
    if (timer === undefined) return;
    clearTimeout(timer);
    inPageWidgetDisconnectTimersBySurfaceId.delete(surfaceId);
  }

  function acquireInPageWidgetDisconnectPin(lease: InPageWidgetLease): () => void {
    lease.disconnectPinCount += 1;
    if (lease.disconnectPinCount === 1) {
      cancelInPageWidgetDisconnectExpiry(lease.surfaceId);
    }
    let released = false;
    return () => {
      if (released) return;
      released = true;
      lease.disconnectPinCount = Math.max(0, lease.disconnectPinCount - 1);
      if (lease.disconnectPinCount === 0 &&
          inPageWidgetLeasesBySurfaceId.get(lease.surfaceId) === lease && !lease.port) {
        scheduleInPageWidgetDisconnectExpiry(lease);
      }
    };
  }

  function scheduleInPageWidgetDisconnectExpiry(lease: InPageWidgetLease): void {
    cancelInPageWidgetDisconnectExpiry(lease.surfaceId);
    if (lease.disconnectPinCount > 0) return;
    const timer = setTimeout(() => {
      if (inPageWidgetDisconnectTimersBySurfaceId.get(lease.surfaceId) !== timer) return;
      inPageWidgetDisconnectTimersBySurfaceId.delete(lease.surfaceId);
      if (lease.port || inPageWidgetLeasesBySurfaceId.get(lease.surfaceId) !== lease) return;
      invalidateInPageWidgetContextMutation(lease, true);
      cancelInPageWidgetShow(lease.tabId);
      settleInPageWidgetActionAck(lease.surfaceId, undefined, undefined, "dropped");
      inPageWidgetLeasesBySurfaceId.delete(lease.surfaceId);
      pendingInPageWidgetActionsBySurfaceId.delete(lease.surfaceId);
      // A missing lifecycle port means this renderer is dormant, not that the
      // user explicitly released the surface. Hide page overlays and discard
      // volatile delivery state, but retain the digest-bound persisted lease
      // so a replacement iframe document can recover after inspection or a
      // slow browser-context repair. Explicit surface release, navigation, and
      // tab cleanup remain the terminal invalidation paths.
      requestOverlayVisibilityBroadcast();
    }, IN_PAGE_WIDGET_DISCONNECT_GRACE_MS);
    inPageWidgetDisconnectTimersBySurfaceId.set(lease.surfaceId, timer);
  }

  async function resolveInPageWidgetLease(
    surfaceId: string,
    capability: string,
  ): Promise<InPageWidgetLease | undefined> {
    const current = inPageWidgetLeasesBySurfaceId.get(surfaceId);
    if (current) {
      return current.capability === capability &&
          !invalidatedInPageWidgetLeasesBySurfaceId.has(surfaceId)
        ? current
        : undefined;
    }
    const terminalRevisionsAtStart = new Map(
      Array.from(inPageWidgetLeaseTerminalStatesByTab, ([tabId, state]) => [tabId, state.revision]),
    );
    if (!(await storageAccessReady)) return undefined;
    await ensureInPageWidgetLeaseInvalidationsLoaded();
    if (!inPageWidgetLeaseInvalidationAuthorityAvailable ||
        invalidatedInPageWidgetLeasesBySurfaceId.has(surfaceId)) return undefined;
    const restored = await inPageWidgetLeaseStore.restore(surfaceId, capability, Date.now());
    if (!restored) return undefined;
    if (!inPageWidgetLeaseInvalidationAuthorityAvailable ||
        invalidatedInPageWidgetLeasesBySurfaceId.has(surfaceId) ||
        inPageWidgetLeaseTerminalStateChanged(restored.tabId, terminalRevisionsAtStart)) {
      return undefined;
    }
    const canonical = inPageWidgetLeasesBySurfaceId.get(surfaceId);
    if (canonical) {
      return canonical.capability === capability && canonical.tabId === restored.tabId
        ? canonical
        : undefined;
    }
    if (inPageWidgetLeaseTerminalStateChanged(restored.tabId, terminalRevisionsAtStart)) {
      return undefined;
    }
    const lease = leaseFromPersisted(restored, capability);
    inPageWidgetLeasesBySurfaceId.set(surfaceId, lease);
    requestOverlayVisibilityBroadcast();
    return lease;
  }

  async function coordinateInPageWidgetLeaseTerminalMutation<T>(
    tabId: number,
    mutation: () => Promise<T>,
  ): Promise<T> {
    advanceInPageWidgetLeaseTerminalState(tabId, 1);
    try {
      return await mutation();
    } finally {
      advanceInPageWidgetLeaseTerminalState(tabId, -1);
    }
  }

  function advanceInPageWidgetLeaseTerminalState(tabId: number, activeDelta: 1 | -1): void {
    const current = inPageWidgetLeaseTerminalStatesByTab.get(tabId);
    inPageWidgetLeaseTerminalStatesByTab.set(tabId, {
      activeCount: Math.max(0, (current?.activeCount ?? 0) + activeDelta),
      revision: {},
    });
  }

  function inPageWidgetLeaseTerminalStateChanged(
    tabId: number,
    revisionsAtStart: ReadonlyMap<number, object>,
  ): boolean {
    const state = inPageWidgetLeaseTerminalStatesByTab.get(tabId);
    return state !== undefined && (
      state.activeCount > 0 || state.revision !== revisionsAtStart.get(tabId)
    );
  }

  function markInPageWidgetLeaseInvalidated(lease: InPageWidgetLease): void {
    invalidatedInPageWidgetLeasesBySurfaceId.set(lease.surfaceId, {
      surfaceId: lease.surfaceId,
      tabId: lease.tabId,
    });
  }

  async function ensureInPageWidgetLeaseInvalidationsLoaded(): Promise<void> {
    if (!inPageWidgetLeaseInvalidationsLoadTask) {
      inPageWidgetLeaseInvalidationsLoadTask = (async () => {
        try {
          const poison = await chrome.storage.local.get(
            IN_PAGE_WIDGET_LEASE_INVALIDATION_AUTHORITY_POISON_LOCAL_KEY,
          );
          if (Object.hasOwn(
            poison,
            IN_PAGE_WIDGET_LEASE_INVALIDATION_AUTHORITY_POISON_LOCAL_KEY,
          )) {
            inPageWidgetLeaseInvalidationAuthorityAvailable = false;
            return;
          }
        } catch {
          inPageWidgetLeaseInvalidationAuthorityAvailable = false;
          await persistInPageWidgetLeaseInvalidationPoison();
          return;
        }
        try {
          const values = await chrome.storage.local.get(
            IN_PAGE_WIDGET_LEASE_INVALIDATIONS_LOCAL_KEY,
          );
          const raw = values[IN_PAGE_WIDGET_LEASE_INVALIDATIONS_LOCAL_KEY];
          const invalidations = parseStoredInPageWidgetLeaseInvalidations(raw);
          if (Object.hasOwn(values, IN_PAGE_WIDGET_LEASE_INVALIDATIONS_LOCAL_KEY) &&
              (!Array.isArray(raw) || invalidations === null)) {
            inPageWidgetLeaseInvalidationAuthorityAvailable = false;
            await persistInPageWidgetLeaseInvalidationPoison();
            return;
          }
          for (const invalidation of invalidations ?? []) {
            invalidatedInPageWidgetLeasesBySurfaceId.set(
              invalidation.surfaceId,
              invalidation,
            );
          }
        } catch {
          inPageWidgetLeaseInvalidationAuthorityAvailable = false;
          await persistInPageWidgetLeaseInvalidationPoison();
        }
      })();
    }
    await inPageWidgetLeaseInvalidationsLoadTask;
  }

  async function persistInPageWidgetLeaseInvalidations(): Promise<boolean> {
    await ensureInPageWidgetLeaseInvalidationsLoaded();
    const snapshot = Array.from(invalidatedInPageWidgetLeasesBySurfaceId.values(), (entry) => ({
      surfaceId: entry.surfaceId,
      tabId: entry.tabId,
    }));
    if (!inPageWidgetLeaseInvalidationAuthorityAvailable ||
        snapshot.length > MAX_IN_PAGE_WIDGET_LEASE_INVALIDATIONS) {
      inPageWidgetLeaseInvalidationAuthorityAvailable = false;
      await persistInPageWidgetLeaseInvalidationPoison();
      return false;
    }
    inPageWidgetLeaseInvalidationsWriteTail = inPageWidgetLeaseInvalidationsWriteTail
      .catch(() => undefined)
      .then(() => chrome.storage.local.set({
        [IN_PAGE_WIDGET_LEASE_INVALIDATIONS_LOCAL_KEY]: snapshot,
      }));
    try {
      await inPageWidgetLeaseInvalidationsWriteTail;
      return true;
    } catch {
      inPageWidgetLeaseInvalidationAuthorityAvailable = false;
      await persistInPageWidgetLeaseInvalidationPoison();
      return false;
    }
  }

  async function persistInPageWidgetLeaseInvalidationPoison(): Promise<boolean> {
    inPageWidgetLeaseInvalidationAuthorityAvailable = false;
    inPageWidgetLeaseInvalidationPoisonWriteTail =
      inPageWidgetLeaseInvalidationPoisonWriteTail
        .catch(() => undefined)
        .then(() => chrome.storage.local.set({
          [IN_PAGE_WIDGET_LEASE_INVALIDATION_AUTHORITY_POISON_LOCAL_KEY]:
            INVALIDATION_AUTHORITY_UNAVAILABLE,
        }));
    try {
      await inPageWidgetLeaseInvalidationPoisonWriteTail;
      return true;
    } catch {
      return false;
    }
  }

  async function clearInPageWidgetLeaseInvalidationsForDurableReplacement(
    lease: InPageWidgetLease,
  ): Promise<void> {
    await ensureInPageWidgetLeaseInvalidationsLoaded();
    const removed = [...invalidatedInPageWidgetLeasesBySurfaceId.values()].filter(
      (entry) => entry.tabId === lease.tabId,
    );
    if (removed.length === 0) return;
    for (const entry of removed) {
      invalidatedInPageWidgetLeasesBySurfaceId.delete(entry.surfaceId);
    }
    if (!await persistInPageWidgetLeaseInvalidations()) {
      for (const entry of removed) {
        invalidatedInPageWidgetLeasesBySurfaceId.set(entry.surfaceId, entry);
      }
    }
  }

  async function requireWidgetCapturePageContext(
    lease: InPageWidgetLease,
  ): Promise<
    | { ok: true; value: ActivePageContext }
    | { ok: false; response: SessionCommandResponse<never> }
  > {
    const activePage = await getWidgetCapturePageContext(lease);
    return activePage && inPageWidgetLeaseIsCurrent(lease)
      ? { ok: true, value: activePage }
      : {
          ok: false,
          response: failure(
            "ACTIVE_PAGE_UNAVAILABLE",
            "MeanThis could not verify the widget page.",
          ),
        };
  }

  function findWidgetSessionItem(
    readback: ActiveSessionReadback,
    itemId: string,
    origin: string,
  ): NonNullable<ActiveSessionReadback["file"]>["session"]["attachments"][number] | null {
    return readback.file?.session.attachments.find((item) =>
      item.id === itemId && item.sourceRecord.origin === origin
    ) ?? null;
  }

  function createInPageWidgetMutationAuthority(
    lease: InPageWidgetLease,
    activePage: ActivePageContext,
    expectedAttachmentId: string,
    clearActionToken: ClearActionBarrierToken,
    expiresAt?: string,
    lifecycleReference?: AnnotationLifecycleOperationReferenceV1,
  ): SessionMutationAuthority {
    let live = true;
    const isCurrent = (): boolean => (
      live &&
      (expiresAt === undefined || Date.now() < Date.parse(expiresAt)) &&
      clearActionBarrierTokenIsCurrent(clearActionToken) &&
      inPageWidgetLeaseIsCurrent(lease)
    );
    return {
      isCurrent,
      refresh: async (record) => {
        if (!isCurrent() || record.attachment.id !== expectedAttachmentId ||
            !isOverlayPreviewRecordOnPage(record, activePage)) return false;
        if (lifecycleReference) {
          const currentAuthority = await readCurrentAnnotationLifecycleControlAuthority();
          if (!currentAuthority ||
              lifecycleReference.ownerGeneration !== currentAuthority.ownerGeneration ||
              lifecycleReference.connectionGeneration !== currentAuthority.connectionGeneration) {
            live = false;
            return false;
          }
        }
        const refreshedPage = await getWidgetCapturePageContext(lease);
        if (!isCurrent() || !sameActivePageContext(refreshedPage ?? undefined, activePage)) {
          live = false;
          return false;
        }
        let frames: UiAttachChromeFrame[] | undefined;
        try {
          frames = await chrome.webNavigation.getAllFrames({ tabId: activePage.tabId });
        } catch {
          live = false;
          return false;
        }
        const liveRouteChain = frames
          ? captureRouteChainFromFrames(frames, {
              tabId: activePage.tabId,
              frameId: activePage.frameId,
            })
          : null;
        if (!isCurrent() || !liveRouteChain ||
            !storedCaptureRouteChainMatchesLive(record, liveRouteChain)) {
          live = false;
          return false;
        }
        return isCurrent();
      },
    };
  }

  async function handleWidgetBridgeCommand(
    bridgeCommand: Record<string, unknown>,
  ): Promise<RuntimeResponse> {
    const runtimeFeature = runtimeFeatures.find((feature) => feature.matches(bridgeCommand));
    return runtimeFeature ? await runtimeFeature.handle(bridgeCommand) : untrustedSender();
  }

  async function handleWidgetBridgeCommandWithReconcile(
    bridgeCommand: Record<string, unknown>,
    lease: InPageWidgetLease,
  ): Promise<RuntimeResponse> {
    const response = await handleWidgetBridgeCommand(bridgeCommand);
    if (!response?.ok) return response;
    await reconcileWidgetSession(lease);
    const reconciledStatus = await handleWidgetBridgeCommand({
      type: "ui-attach:local-agent-bridge",
      action: "read-status",
    });
    return reconciledStatus?.ok ? reconciledStatus : response;
  }

  async function widgetSelectionStateResponse(
    enabled: boolean,
    ownerTabId: number,
  ): Promise<SessionCommandResponse<{
    enabled: boolean;
    generation: number;
    resumeAllowed: boolean;
  }>> {
    if (!(await storageAccessReady)) {
      return failure("WIDGET_STATE_UNAVAILABLE", "Selection intent authority is unavailable.");
    }
    const intent = await selectionIntentStore.read();
    if (!intent.ok) return failure("WIDGET_STATE_UNAVAILABLE", intent.error);
    return {
      ok: true,
      data: {
        enabled,
        generation: intent.value.generation,
        resumeAllowed: intent.value.desired === "enabled" &&
          intent.value.clearOperationId === null && intent.value.ownerTabId === ownerTabId,
      },
    };
  }

  async function clearWidgetSession(
    expectedEpoch: string | null,
    operationId: string,
    scope: "live-page" | "active-origin",
    lease: InPageWidgetLease,
  ): Promise<SessionCommandResponse<ActiveSessionReadback>> {
    const clearBarrierAttempt = addClearActionBarrier(
      operationId,
      scope === "active-origin" ? [] : [lease.origin],
      { preDiscovery: true },
    );
    try {
    invalidateSelectionContextMutationsForClear();
    if (!await revokeElementSelectionLease(operationId)) {
      return failure("STORAGE_ERROR", "Selection stop could not be persisted.");
    }
    const requestedActivePage = scope === "active-origin"
      ? await getWidgetCapturePageContext(lease)
      : null;
    if (scope === "active-origin" && !requestedActivePage?.documentId) {
      return failure(
        "ACTIVE_PAGE_UNAVAILABLE",
        "MeanThis could not verify the widget page before clearing its site.",
      );
    }
    const resumed = await resumeExistingDurableClearProjection({
      operationId,
      origin: requestedActivePage?.origin ?? lease.origin,
      expectedEpoch,
      expectedBarrierScope: scope,
      readActivePage: () => getWidgetCapturePageContext(lease),
    });
    if (resumed.handled) {
      return resumed.response.ok
        ? await storeResultWithWidgetReconcile(
            { ok: true, value: resumed.response.data },
            lease,
          )
        : resumed.response;
    }
    const clearPageContextGenerationAtDiscovery = clearPageContextGeneration;
    const frames = await chrome.webNavigation.getAllFrames({ tabId: lease.tabId });
    const topFrame = frames?.find((frame) => frame.frameId === 0);
    if (!frames || topFrame?.documentId !== lease.documentId ||
        routeKeyFromUrl(topFrame.url) !== `${lease.origin}${lease.pathname}`) {
      return failure("ACTIVE_PAGE_UNAVAILABLE", "MeanThis could not verify the widget page before clearing it.");
    }
    const liveFrames = frames.flatMap((frame) => {
      const origin = originFromUrl(frame.url);
      const pathname = pathnameFromUrl(frame.url);
      return origin && pathname !== null && frame.documentId
        ? [{ frameId: frame.frameId, documentId: frame.documentId, origin, pathname }]
        : [];
    });
    const activePage = await getWidgetCapturePageContext(lease);
    if (!activePage?.documentId || (
      requestedActivePage !== null && !sameActivePageContext(requestedActivePage, activePage)
    )) {
      return failure("ACTIVE_PAGE_UNAVAILABLE", "MeanThis could not verify the widget page before clearing it.");
    }
    const activeOrigin = activePage.origin;
    const allOrigins = [...new Set(liveFrames.map(({ origin }) => origin))];
    if (!liveFrames.some((frame) =>
      frame.frameId === activePage.frameId &&
      frame.documentId === activePage.documentId &&
      frame.origin === activePage.origin &&
      frame.pathname === activePage.pathname
    )) {
      return failure("FRAME_UNAVAILABLE", "The selected frame is unavailable.");
    }
    const origins = scope === "active-origin" ? [activeOrigin] : allOrigins;
    const projectionFrames = scope === "active-origin"
      ? liveFrames.filter((frame) => frame.origin === activeOrigin)
      : liveFrames;
    narrowClearActionBarrier(
      clearBarrierAttempt,
      origins,
      scope === "active-origin" ? [] : [lease.tabId],
    );
    const targets: Array<{
      origin: string;
      epoch: string | null;
      previous: ActiveSessionReadback;
    }> = [];
    for (const origin of origins) {
      const previous = await store.read(origin);
      if (!previous.ok) return failureFromStore(previous);
      const originFrames = liveFrames.filter((frame) => frame.origin === origin);
      if (origin !== activeOrigin &&
          !readbackContainsLiveFrameSelection(previous.value, lease.tabId, originFrames)) continue;
      targets.push({
        origin,
        epoch: origin === activeOrigin ? expectedEpoch : previous.value.epoch,
        previous: previous.value,
      });
    }
    try {
      if (!await terminateAnnotationLifecycleControlForCanonicalRemoval(
        (delivery) => targets.some((target) => target.origin === delivery.origin),
        (execution) => targets.some((target) => target.origin === execution.origin),
      )) {
        return failure(
          "STORAGE_ERROR",
          "MeanThis could not cancel pending Agent lifecycle approvals before clearing.",
        );
      }
    } catch {
      return failure(
        "STORAGE_ERROR",
        "MeanThis could not clear pending Agent lifecycle approvals.",
      );
    }
    const cleared = await executeDurableClearProjection(
      operationId,
      activeOrigin,
      targets,
      lease.tabId,
      projectionFrames,
      () => getWidgetCapturePageContext(lease),
      clearPageContextGenerationAtDiscovery,
      scope,
    );
    return cleared.ok
      ? await storeResultWithWidgetReconcile({ ok: true, value: cleared.data }, lease)
      : cleared;
    } finally {
      await settleClearActionBarrier(clearBarrierAttempt);
    }
  }

  async function getInPageWidgetSession(
    lease: InPageWidgetLease,
  ): Promise<SessionCommandResponse<ActiveSessionCommandData>> {
    const terminalGeneration = lease.contextMutation.terminalGeneration;
    const leaseIsCurrent = (): boolean => (
      inPageWidgetLeasesBySurfaceId.get(lease.surfaceId) === lease &&
      lease.contextMutation.terminalGeneration === terminalGeneration
    );
    if (!leaseIsCurrent()) {
      return failure("ACTIVE_PAGE_UNAVAILABLE", "MeanThis could not verify the widget page.");
    }
    for (let attempt = 0; attempt < 2; attempt += 1) {
      if (lease.contextMutation.mutating) {
        return failure("ACTIVE_PAGE_UNAVAILABLE", "MeanThis could not verify the widget page.");
      }
      const generation = lease.contextMutation.generation;
      const activePage = await getWidgetCapturePageContext(lease);
      if (!leaseIsCurrent()) {
        return failure("ACTIVE_PAGE_UNAVAILABLE", "MeanThis could not verify the widget page.");
      }
      if (!activePage) {
        if (lease.contextMutation.mutating || lease.contextMutation.generation !== generation) {
          continue;
        }
        return failure("ACTIVE_PAGE_UNAVAILABLE", "MeanThis could not verify the widget page.");
      }
      const read = await readAuthoritativeSession(activePage.origin);
      if (!leaseIsCurrent()) {
        return failure("ACTIVE_PAGE_UNAVAILABLE", "MeanThis could not verify the widget page.");
      }
      if (!read.ok) return failureFromStore(read);
      const currentItemIds = await readWidgetCurrentScopeItemIds(
        lease,
        activePage,
        read.value,
      );
      if (!leaseIsCurrent()) {
        return failure("ACTIVE_PAGE_UNAVAILABLE", "MeanThis could not verify the widget page.");
      }
      await ensureActiveOverlayItemIdsLoaded();
      if (!leaseIsCurrent()) {
        return failure("ACTIVE_PAGE_UNAVAILABLE", "MeanThis could not verify the widget page.");
      }
      if (lease.contextMutation.mutating || lease.contextMutation.generation !== generation) {
        continue;
      }
      if (!activePage.documentId || !await isCurrentOverlayActionEndpoint({
        tabId: activePage.tabId,
        frameId: activePage.frameId,
        documentId: activePage.documentId,
      }, activePage.origin, activePage.pathname) || !leaseIsCurrent()) {
        return failure("ACTIVE_PAGE_UNAVAILABLE", "MeanThis could not verify the widget page.");
      }
      const allItemIds = (read.value.file?.session.attachments ?? []).map((item) => item.id);
      const selectedItemId = resolveOverlayActiveItemId(
        currentItemIds ?? allItemIds,
        activeOverlayItemIdsByOrigin.get(activePage.origin) ?? null,
      );
      const metadataDiagnostics = await readSessionMetadataDiagnostics(
        activePage.origin,
        read.value,
        new Set(currentItemIds ?? []),
      );
      if (!leaseIsCurrent() || !activePage.documentId ||
          !await isCurrentOverlayActionEndpoint({
            tabId: activePage.tabId,
            frameId: activePage.frameId,
            documentId: activePage.documentId,
          }, activePage.origin, activePage.pathname)) {
        return failure("ACTIVE_PAGE_UNAVAILABLE", "MeanThis could not verify the widget page.");
      }
      return {
        ok: true,
        data: {
          enabled: true,
          origin: activePage.origin,
          readback: read.value,
          activePage,
          ...(currentItemIds !== null ? { currentItemIds } : {}),
          ...(selectedItemId ? { selectedItemId } : {}),
          ...(metadataDiagnostics ? { metadataDiagnostics } : {}),
        },
      };
    }
    return failure("ACTIVE_PAGE_UNAVAILABLE", "MeanThis could not verify the widget page.");
  }

  async function storeResultWithWidgetReconcile(
    result: SessionStoreResult<ActiveSessionReadback>,
    lease: InPageWidgetLease,
    clearActionToken?: ClearActionBarrierToken,
  ): Promise<SessionCommandResponse<ActiveSessionReadback>> {
    if (result.ok && (!clearActionToken || clearActionBarrierTokenIsCurrent(clearActionToken))) {
      await reconcileWidgetSession(lease);
    }
    return storeResult(result);
  }

  async function reconcileWidgetSession(
    lease: InPageWidgetLease,
    authority?: OverlaySyncAuthority,
  ): Promise<boolean> {
    if (authority && !authority.isCurrent()) return false;
    const next = await getInPageWidgetSession(lease);
    if (!next.ok || (authority && !authority.isCurrent()) ||
        inPageWidgetLeasesBySurfaceId.get(lease.surfaceId) !== lease) return false;
    const activePage = next.data.activePage;
    if (activePage && (
      activePage.documentId === undefined ||
      !await isCurrentOverlayActionEndpoint({
        tabId: activePage.tabId,
        frameId: activePage.frameId,
        documentId: activePage.documentId,
       }, activePage.origin, activePage.pathname) ||
       (authority && !authority.isCurrent()) ||
       inPageWidgetLeasesBySurfaceId.get(lease.surfaceId) !== lease
    )) return false;
    try {
      if (authority && !authority.isCurrent()) return false;
      return await reconcileActiveSession(next.data) === true;
    } catch {
      // Agent publication is best-effort and never changes the durable capture result.
      return false;
    }
  }

  async function refreshInPageWidgetContext(tabId: number): Promise<void> {
    const lease = [...inPageWidgetLeasesBySurfaceId.values()].find((candidate) =>
      candidate.tabId === tabId
    );
    if (lease) await reconcileWidgetSession(lease);
  }

  async function getWidgetTopPageContext(
    lease: InPageWidgetLease,
  ): Promise<ActivePageContext | null> {
    try {
      const topFrame = await chrome.webNavigation.getFrame({ tabId: lease.tabId, frameId: 0 });
      return topFrame?.documentId === lease.documentId &&
          routeKeyFromUrl(topFrame.url) === `${lease.origin}${lease.pathname}`
        ? {
            tabId: lease.tabId,
            frameId: 0,
            documentId: lease.documentId,
            origin: lease.origin,
            pathname: lease.pathname,
          }
        : null;
    } catch {
      return null;
    }
  }

  async function getWidgetCapturePageContext(
    lease: InPageWidgetLease,
  ): Promise<ActivePageContext | null> {
    let topFrame: UiAttachChromeFrameDetails | undefined;
    try {
      topFrame = await chrome.webNavigation.getFrame({ tabId: lease.tabId, frameId: 0 });
    } catch {
      return null;
    }
    if (topFrame?.documentId !== lease.documentId ||
        routeKeyFromUrl(topFrame.url) !== `${lease.origin}${lease.pathname}`) return null;
    const pendingHead = pendingInPageWidgetActionHead(lease);
    if (pendingHead) {
      const expectedContext = pendingActionContext(lease, pendingHead);
      if (!sameActivePageContext(lease.actionContext, expectedContext)) return null;
      try {
        const frame = await chrome.webNavigation.getFrame({
          tabId: lease.tabId,
          frameId: expectedContext.frameId,
        });
        return pendingInPageWidgetActionHead(lease) === pendingHead &&
            sameActivePageContext(lease.actionContext, expectedContext) &&
            frame?.documentId === expectedContext.documentId &&
            routeKeyFromUrl(frame?.url) === `${expectedContext.origin}${expectedContext.pathname}`
          ? expectedContext
          : null;
      } catch {
        return null;
      }
    }
    if (lease.actionContext) {
      const actionContext = lease.actionContext;
      try {
        const frame = await chrome.webNavigation.getFrame({
          tabId: lease.tabId,
          frameId: actionContext.frameId,
        });
        const racedHead = pendingInPageWidgetActionHead(lease);
        if (racedHead) {
          const expectedContext = pendingActionContext(lease, racedHead);
          if (!sameActivePageContext(lease.actionContext, expectedContext) ||
              !sameActivePageContext(actionContext, expectedContext)) return null;
        }
        if (frame && frame.documentId === actionContext.documentId &&
            routeKeyFromUrl(frame.url) === `${actionContext.origin}${actionContext.pathname}`) {
          return actionContext;
        }
      } catch {
        // A stale marker scope has no read authority. Context cleanup is kept
        // out of this lock-free session-read path.
      }
    }
    const activeFrame = elementSelectionTabId === lease.tabId && elementSelectionFrameId !== null &&
        elementSelectionFrameId > 0 && elementSelectionFrameOrigin &&
        elementSelectionFramePathname
      ? {
          tabId: lease.tabId,
          frameId: elementSelectionFrameId,
          origin: elementSelectionFrameOrigin,
          pathname: elementSelectionFramePathname,
          ...(elementSelectionDocumentId ? { documentId: elementSelectionDocumentId } : {}),
        }
      : null;
    if (activeFrame) return activeFrame;
    const resumable = await getResumableElementSelectionScope(lease.tabId);
    if (hasPendingInPageWidgetAction(lease)) return null;
    if (resumable?.target.frameOrigin && resumable.target.framePathname) {
      return {
        tabId: lease.tabId,
        frameId: resumable.target.frameId,
        origin: resumable.target.frameOrigin,
        pathname: resumable.target.framePathname,
        ...(resumable.target.documentId ? { documentId: resumable.target.documentId } : {}),
      };
    }
    if (lease.frameContext) {
      const frameContext = lease.frameContext;
      try {
        const frame = await chrome.webNavigation.getFrame({
          tabId: lease.tabId,
          frameId: frameContext.frameId,
        });
        if (hasPendingInPageWidgetAction(lease)) return null;
        if (frame && frame.documentId === frameContext.documentId &&
            routeKeyFromUrl(frame.url) === `${frameContext.origin}${frameContext.pathname}`) {
          return frameContext;
        }
      } catch {
        // A stale frame context has no read authority. The next explicit
        // frame mutation replaces it through the coordinator.
      }
    }
    const restored = await getRestoredWidgetCapturePageContext(lease);
    if (hasPendingInPageWidgetAction(lease)) return null;
    if (restored) return restored;
    return {
      tabId: lease.tabId,
      frameId: 0,
      origin: lease.origin,
      pathname: lease.pathname,
      documentId: lease.documentId,
    };
  }

  async function getRestoredWidgetCapturePageContext(
    lease: InPageWidgetLease,
  ): Promise<ActivePageContext | null> {
    let frames: UiAttachChromeFrame[] | undefined;
    try {
      frames = await chrome.webNavigation.getAllFrames({ tabId: lease.tabId });
    } catch {
      return null;
    }
    if (!frames || frames.length === 0) return null;
    await ensureActiveOverlayItemIdsLoaded();
    const readbacks = new Map<string, ActiveSessionReadback | null>();
    const candidates: Array<{
      page: ActivePageContext;
      hasActiveItem: boolean;
    }> = [];
    for (const frame of frames) {
      const origin = originFromUrl(frame.url);
      const pathname = pathnameFromUrl(frame.url);
      if (!origin || pathname === null || !frame.documentId) continue;
      let readback = readbacks.get(origin);
      if (readback === undefined) {
        const read = await store.read(origin);
        readback = read.ok ? read.value : null;
        readbacks.set(origin, readback);
      }
      if (!readback) continue;
      const endpoint = { tabId: lease.tabId, frameId: frame.frameId };
      const restored = collectOverlayRestoreData(
        readback,
        origin,
        frame.url,
        endpoint,
        frames,
        activeOverlayItemIdsByOrigin.get(origin) ?? null,
        captureRouteChainFromFrames(frames, endpoint) ?? undefined,
      );
      if (restored.items.length === 0) continue;
      candidates.push({
        page: {
          tabId: lease.tabId,
          frameId: frame.frameId,
          documentId: frame.documentId,
          origin,
          pathname,
        },
        hasActiveItem: restored.activeItemId !== null,
      });
    }
    if (candidates.length === 1) return candidates[0]!.page;
    const activeCandidates = candidates.filter(({ hasActiveItem }) => hasActiveItem);
    if (activeCandidates.length === 1) return activeCandidates[0]!.page;
    return candidates.find(({ page }) => page.frameId === 0)?.page ?? null;
  }

  async function isCurrentWidgetSender(
    sender: UiAttachChromeMessageSender,
    lease: InPageWidgetLease,
  ): Promise<boolean> {
    return await inspectCurrentWidgetSender(sender, lease) === null;
  }

  async function inspectCurrentWidgetSender(
    sender: UiAttachChromeMessageSender,
    lease: InPageWidgetLease,
  ): Promise<string | null> {
    if (sender.id !== chrome.runtime.id) return "WIDGET_REGISTER_MISSING_ID";
    if (sender.tab?.id !== lease.tabId || sender.tab.windowId !== lease.windowId) {
      return "WIDGET_REGISTER_TAB_CONTEXT";
    }
    if (!sender.url || typeof sender.frameId !== "number" || sender.frameId <= 0 ||
        !sender.documentId) return "WIDGET_REGISTER_FRAME_CONTEXT";
    let senderUrl: URL;
    const expectedUrl = new URL(
      `chrome-extension://${chrome.runtime.id}${UI_ATTACH_IN_PAGE_WIDGET_PATH}`,
    );
    try {
      senderUrl = new URL(sender.url);
    } catch {
      return "WIDGET_REGISTER_WIDGET_URL";
    }
    if (senderUrl.origin !== expectedUrl.origin || senderUrl.pathname !== expectedUrl.pathname ||
        senderUrl.search !== "" || senderUrl.hash !== "" ||
        senderUrl.username !== "" || senderUrl.password !== "") {
      return "WIDGET_REGISTER_WIDGET_URL";
    }

    let topFrame: Awaited<ReturnType<typeof chrome.webNavigation.getFrame>> | undefined = undefined;
    let topUrl: URL | undefined;
    for (let attempt = 0; attempt < IN_PAGE_WIDGET_TOP_FRAME_LOOKUP_ATTEMPTS; attempt += 1) {
      try {
        const candidate = await chrome.webNavigation.getFrame({
          tabId: lease.tabId,
          frameId: 0,
        });
        if (candidate?.url) {
          topFrame = candidate;
          topUrl = new URL(candidate.url);
          if (
            candidate.documentId === lease.documentId &&
            topUrl.origin === lease.origin &&
            topUrl.pathname === lease.pathname
          ) {
            break;
          }
        }
      } catch {
        // Chrome can temporarily reject frame inventory while an extension
        // iframe is replaced. Retry the same exact lease without weakening any
        // sender, document, or route witness.
      }
      // A History event can update the exact lease before getFrame exposes the
      // new pathname. Treat that old route like transient inventory: retry the
      // same capability and accept only when every document/route witness agrees.
      if (attempt + 1 < IN_PAGE_WIDGET_TOP_FRAME_LOOKUP_ATTEMPTS) {
        await new Promise<void>((resolve) => {
          setTimeout(resolve, IN_PAGE_WIDGET_TOP_FRAME_LOOKUP_RETRY_MS);
        });
      }
    }
    if (!topFrame || !topUrl) return "WIDGET_REGISTER_TOP_INVENTORY";
    if (topFrame.documentId !== lease.documentId) return "WIDGET_REGISTER_TOP_DOCUMENT";

    // MessageSender is the authoritative witness for the document that sent
    // this registration. Chrome may omit an extension-origin child frame,
    // reject its lookup, or omit its duplicated documentId from webNavigation
    // inventory. When inventory exists, use it only as an additional
    // fail-closed witness.
    const widgetFrame = await chrome.webNavigation.getFrame({
      tabId: lease.tabId,
      frameId: sender.frameId,
      documentId: sender.documentId,
    }).catch(() => undefined);
    if (widgetFrame && (
      (widgetFrame.documentId !== undefined &&
        widgetFrame.documentId !== sender.documentId) ||
      widgetFrame.parentFrameId !== 0 ||
      widgetFrame.url !== expectedUrl.href
    )) {
      return "WIDGET_REGISTER_WIDGET_DOCUMENT";
    }
    return topUrl.origin === lease.origin && topUrl.pathname === lease.pathname
      ? null
      : "WIDGET_REGISTER_TOP_ROUTE";
  }

  function createWidgetCapability(): string {
    const bytes = new Uint8Array(32);
    crypto.getRandomValues(bytes);
    let binary = "";
    for (const byte of bytes) binary += String.fromCharCode(byte);
    return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "");
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
    let clearBarrierAttempt: ClearActionBarrierAttempt | null = null;
    let sessionMutationClearActionToken: ClearActionBarrierToken | null = null;
    try {
      const widgetRegistration = parseInPageWidgetRegistration(message);
      if (widgetRegistration) {
        try {
          return await registerInPageWidget(widgetRegistration, sender);
        } catch {
          return {
            ...failure("CAPTURE_FAILED", SAFE_CAPTURE_ERROR),
            issues: [{ path: "widget", message: "WIDGET_REGISTER_HANDLER_EXCEPTION" }],
          };
        }
      }
      const widgetEnvelope = parseInPageWidgetCommandEnvelope(message);
      if (widgetEnvelope) {
        return await handleInPageWidgetCommand(widgetEnvelope, sender);
      }
      if (isClearProjectionAckMessage(message)) {
        if (!(await storageAccessReady)) return failure("CAPTURE_FAILED", SAFE_CAPTURE_ERROR);
        return await acknowledgeClearProjection(message, sender);
      }
      if (isOverlayProjectionAckMessage(message)) {
        if (!(await storageAccessReady)) return failure("CAPTURE_FAILED", SAFE_CAPTURE_ERROR);
        return await acknowledgeOverlayProjection(message, sender);
      }
      if (isOverlayActionRequestMessage(message)) {
        if (!(await storageAccessReady)) return failure("CAPTURE_FAILED", SAFE_CAPTURE_ERROR);
        return await handleOverlayActionRequest(message, sender);
      }
      const runtimeFeature = runtimeFeatures.find((feature) => feature.matches(message));
      if (runtimeFeature) {
        if (!isExtensionPageSender(sender)) return untrustedSender();
        return await runtimeFeature.handle(message);
      }
      const command = parseSessionCommand(message);
      if (!command.ok) {
        if (command.unknownType) return undefined;
        return invalidCommand(command.issues);
      }
      const extensionClearOperationId = command.value.type === "ui-attach:session-clear" ||
        command.value.type === "ui-attach:session-clear-stored-origin"
        ? command.value.operationId
        : command.value.type === "ui-attach:session-clear-all-stored"
          ? "clear-all-stored"
          : null;
      if (command.value.type === "ui-attach:session-update-intent" ||
          command.value.type === "ui-attach:session-update-annotation-lifecycle" ||
          command.value.type === "ui-attach:session-remove-item") {
        if (!isExtensionPageSender(sender)) return untrustedSender();
        sessionMutationClearActionToken = createClearActionBarrierToken(
          command.value.origin,
          contentTabIdFromSender(sender),
        );
      }
      if (extensionClearOperationId !== null) {
        if (!isExtensionPageSender(sender)) return untrustedSender();
        if (command.value.type === "ui-attach:session-clear-stored-origin") {
          if (clearActionBarriersByOperationId.has(extensionClearOperationId) ||
              hasClearActionBarrier(command.value.origin, null)) return clearInProgress();
          clearBarrierAttempt = addClearActionBarrier(extensionClearOperationId, [command.value.origin]);
        } else if (command.value.type === "ui-attach:session-clear") {
          clearBarrierAttempt = addClearActionBarrier(
            command.value.operationId,
            [command.value.origin],
            { preDiscovery: true },
          );
        } else {
          clearBarrierAttempt = addClearActionBarrier(
            extensionClearOperationId,
            [],
            { preDiscovery: true },
          );
        }
        // Clear is a terminal selection event. Advance every widget mutation
        // generation and clear the live lease before the first async gate so a
        // pending readiness check cannot admit a stale enable/resume.
        invalidateSelectionContextMutationsForClear();
        if (!await revokeElementSelectionLease(extensionClearOperationId)) {
          removeClearActionBarrier(clearBarrierAttempt);
          return failure("STORAGE_ERROR", "Selection stop could not be persisted.");
        }
      }
      if (!(await storageAccessReady)) {
        removeClearActionBarrier(clearBarrierAttempt);
        return failure("CAPTURE_FAILED", SAFE_CAPTURE_ERROR);
      }
      if (sessionMutationClearActionToken &&
          !await validateClearActionBarrierToken(sessionMutationClearActionToken)) {
        return clearInProgress();
      }

      switch (command.value.type) {
        case "ui-attach:session-get-active": {
          if (!isExtensionPageSender(sender)) return untrustedSender();
          return await getActiveSession();
        }
        case "ui-attach:session-list-stored": {
          if (!isExtensionPageSender(sender)) return untrustedSender();
          return await listAuthoritativeStoredSessions();
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
          try {
            const cleared = await coordinateAnnotationLifecycleControlExecution(async () => {
              if (!await terminateAnnotationLifecycleControlForCanonicalRemovalExclusive(
                () => true,
                () => true,
              )) return null;
              return await store.clearAll();
            });
            if (!cleared) {
              return failure(
                "STORAGE_ERROR",
                "MeanThis could not cancel pending Agent lifecycle approvals before clearing saved captures.",
              );
            }
            if (cleared.ok) {
              await Promise.all(cleared.value.clearedOrigins.map((origin) => syncOverlaySession({
                origin,
                epoch: null,
                clearPending: false,
                activeClearOperationId: null,
                file: null,
                legacyRecord: null,
              }, null)));
              if (!await metadataDiagnosticsStore.clearAll()) {
                return failure(
                  "STORAGE_ERROR",
                  "Capture diagnostics cleanup could not be verified.",
                );
              }
            }
            return storeResult(cleared);
          } finally {
            removeClearActionBarrier(clearBarrierAttempt);
            clearBarrierAttempt = null;
          }
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
            data: { visible: (await effectiveOverlayDisplayMode(senderTabId, sender.tab?.windowId)) !== "hidden" },
          };
        }
        case UI_ATTACH_OVERLAY_SCOPE_VISIBILITY_GET: {
          const senderTabId = contentTabIdFromSender(sender);
          const senderFrameId = contentFrameIdFromSender(sender);
          const senderOrigin = contentOriginFromSender(sender);
          const senderPathname = pathnameFromUrl(sender.url);
          if (senderOrigin === null || senderPathname === null || senderTabId === null ||
              senderFrameId === null || typeof sender.documentId !== "string") {
            return untrustedSender();
          }
          return {
            ok: true,
            data: {
              visible: inPageWidgetOverlayScopeVisible({
                tabId: senderTabId,
                frameId: senderFrameId,
                documentId: sender.documentId,
                origin: senderOrigin,
                pathname: senderPathname,
              }),
            },
          };
        }
        case UI_ATTACH_OVERLAY_DISPLAY_MODE_GET: {
          const senderTabId = contentTabIdFromSender(sender);
          if (!contentOriginFromSender(sender) || senderTabId === null) return untrustedSender();
          return { ok: true, data: {
            displayMode: await effectiveOverlayDisplayMode(senderTabId, sender.tab?.windowId),
          } };
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
          if (sender.id !== chrome.runtime.id || !senderOrigin || !endpoint?.documentId ||
              !sender.url) return untrustedSender();
          const pathname = pathnameFromUrl(sender.url);
          if (pathname === null) return untrustedSender();
          await replaceClearProjectionTargetsForLiveSubject({
            tabId: endpoint.tabId,
            frameId: endpoint.frameId,
            documentId: endpoint.documentId,
            origin: senderOrigin,
            pathname,
          });
          void requestClearProjectionDrain();
          return await getOverlayRestore(senderOrigin, sender.url, {
            ...endpoint,
            documentId: endpoint.documentId,
          });
        }
        case "ui-attach:session-begin-capture": {
          const senderOrigin = contentOriginFromSender(sender);
          if (!senderOrigin) return untrustedSender();
          if (!hasElementSelectionLease(sender)) return selectionNotActive();
          return await beginRuntimeCapture(
            senderOrigin,
            command.value.replaceItemId,
            sender,
          );
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
          if (!sessionMutationClearActionToken ||
              !clearActionBarrierTokenIsCurrent(sessionMutationClearActionToken)) {
            return clearInProgress();
          }
          {
            const updated = await store.updateIntent(
            command.value.origin,
            command.value.epoch,
            command.value.itemId,
            command.value.intent,
            );
            if (updated.ok) {
              await reconcileActivePanelMutation(sessionMutationClearActionToken);
            }
            return storeResult(updated);
          }
        case "ui-attach:session-update-annotation-lifecycle":
          if (!isExtensionPageSender(sender)) return untrustedSender();
          if (!sessionMutationClearActionToken ||
              !clearActionBarrierTokenIsCurrent(sessionMutationClearActionToken)) {
            return clearInProgress();
          }
          {
            const updated = await store.updateAnnotationLifecycle(
              command.value.origin,
              command.value.epoch,
              command.value.itemId,
              command.value.annotationId,
              command.value.expectedState,
              command.value.nextState,
            );
            if (updated.ok) {
              await reconcileActivePanelMutation(sessionMutationClearActionToken);
            }
            return storeResult(updated);
          }
        case "ui-attach:session-remove-item": {
          if (!isExtensionPageSender(sender)) return untrustedSender();
          const { origin, epoch, itemId } = command.value;
          const previous = await store.read(origin);
          if (!sessionMutationClearActionToken ||
              !clearActionBarrierTokenIsCurrent(sessionMutationClearActionToken)) {
            return clearInProgress();
          }
          const panelClearActionToken = sessionMutationClearActionToken;
          const removal = await coordinateAnnotationLifecycleControlExecution(async () => {
            if (!clearActionBarrierTokenIsCurrent(panelClearActionToken)) return null;
            if (!await terminateAnnotationLifecycleControlForCanonicalRemovalExclusive(
              (delivery) => delivery.origin === origin,
              (execution) => execution.origin === origin && execution.itemId === itemId,
            )) return null;
            return await store.removeItem(origin, epoch, itemId);
          });
          if (!removal) {
            if (!clearActionBarrierTokenIsCurrent(panelClearActionToken)) {
              return clearInProgress();
            }
            return failure(
              "STORAGE_ERROR",
              "MeanThis could not cancel pending Agent lifecycle approvals before removing this target.",
            );
          }
          if (!removal.ok) return storeResult(removal);
          const cleanup = await removeStaleSessionMetadataDiagnostics(origin);
          if (!cleanup.ok) {
            return metadataDiagnosticsCleanupPending();
          }
          const confirmed = cleanup.readback;
          if (confirmed.file?.session.attachments.some((item) => item.id === itemId)) {
            return failure("CAPTURE_FAILED", SAFE_CAPTURE_ERROR);
          }
          if (clearActionBarrierTokenIsCurrent(panelClearActionToken)) {
            await syncOverlaySession(confirmed, null, previous.ok ? previous.value : null);
            await reconcileActivePanelMutation(panelClearActionToken);
          }
          return { ok: true, data: confirmed };
        }
        case "ui-attach:session-clear-stored-origin": {
          if (!isExtensionPageSender(sender)) return untrustedSender();
          if (!clearBarrierAttempt) return failure("CAPTURE_FAILED", SAFE_CAPTURE_ERROR);
          try {
            return await clearStoredOriginSession(command.value, clearBarrierAttempt);
          } finally {
            removeClearActionBarrier(clearBarrierAttempt);
            clearBarrierAttempt = null;
          }
        }
        case "ui-attach:session-clear": {
          if (!isExtensionPageSender(sender)) return untrustedSender();
          if (!clearBarrierAttempt) return failure("CAPTURE_FAILED", SAFE_CAPTURE_ERROR);
          const response = await clearActivePageSessions(command.value, clearBarrierAttempt);
          if (clearBarrierAttempt) await settleClearActionBarrier(clearBarrierAttempt);
          clearBarrierAttempt = null;
          return response;
        }
      }
    } catch {
      if (clearBarrierAttempt) await settleClearActionBarrier(clearBarrierAttempt);
      return failure("CAPTURE_FAILED", SAFE_CAPTURE_ERROR);
    }
  }

  async function handleOverlayActionRequest(
    message: OverlayActionRequestMessage,
    sender: UiAttachChromeMessageSender,
  ): Promise<RuntimeResponse> {
    const endpoint = overlayEndpointFromSender(sender);
    const origin = contentOriginFromSender(sender);
    const pathname = sender.url ? pathnameFromUrl(sender.url) : null;
    if (!endpoint || !origin || pathname === null || !endpoint.documentId ||
        sender.id !== chrome.runtime.id) return untrustedSender();
    const clearActionToken = createClearActionBarrierToken(origin, endpoint.tabId);
    if (!await validateClearActionBarrierToken(clearActionToken)) return clearInProgress();
    const exactEndpoint: OverlayEndpoint & { documentId: string } = {
      ...endpoint,
      documentId: endpoint.documentId,
    };
    const actionContext: ActivePageContext = {
      tabId: endpoint.tabId,
      frameId: endpoint.frameId,
      documentId: endpoint.documentId,
      origin,
      pathname,
    };
    const leaseAtRequest = [...inPageWidgetLeasesBySurfaceId.values()].find((candidate) =>
      candidate.tabId === endpoint.tabId
    );
    const leaseTerminalGenerationAtRequest = leaseAtRequest?.contextMutation.terminalGeneration;
    if (message.action === "save" || message.action === "remove") {
      return await handleOwnedOverlayMutation(
        message,
        exactEndpoint,
        actionContext,
        clearActionToken,
      );
    }
    if (message.action !== "edit" && message.action !== "more") return untrustedSender();
    const endpointCurrent = await isCurrentOverlayActionEndpoint(exactEndpoint, origin, pathname);
    if (!clearActionBarrierTokenIsCurrent(clearActionToken)) return clearInProgress();
    if (!endpointCurrent) {
      return untrustedSender();
    }
    const read = await store.read(origin);
    if (!clearActionBarrierTokenIsCurrent(clearActionToken)) return clearInProgress();
    if (!read.ok) return failureFromStore(read);
    const projectionAuthority = await overlayProjectionItemAuthority(
      read.value,
      message.projection,
      message.itemId,
      exactEndpoint,
      origin,
      pathname,
    );
    if (!clearActionBarrierTokenIsCurrent(clearActionToken)) return clearInProgress();
    if (projectionAuthority !== "acknowledged") return projectionAuthority === "pending"
      ? overlayProjectionReackRequired()
      : untrustedSender();
    if (read.value.epoch === null) return failure("CAPTURE_FAILED", SAFE_CAPTURE_ERROR);
    const pendingAction: PendingInPageWidgetAction = {
      action: message.action,
      actionId: crypto.randomUUID(),
      clearActionToken,
      endpoint: exactEndpoint,
      expectedEpoch: read.value.epoch,
      itemId: message.itemId,
      origin,
      pathname,
      projection: { ...message.projection },
    };
    const projectionCurrent = await pendingInPageWidgetActionProjectionIsCurrent(
      pendingAction,
      read.value,
    );
    if (!clearActionBarrierTokenIsCurrent(clearActionToken)) return clearInProgress();
    if (!projectionCurrent) {
      return untrustedSender();
    }
    if (!clearActionBarrierTokenIsCurrent(clearActionToken)) return clearInProgress();
    if (leaseAtRequest &&
        (inPageWidgetLeasesBySurfaceId.get(leaseAtRequest.surfaceId) !== leaseAtRequest ||
          leaseAtRequest.contextMutation.terminalGeneration !== leaseTerminalGenerationAtRequest)) {
      return untrustedSender();
    }
    const widgetShown = await showInPageWidget(endpoint.tabId);
    if (!clearActionBarrierTokenIsCurrent(clearActionToken)) return clearInProgress();
    if (!widgetShown) {
      if (leaseAtRequest && (
        inPageWidgetLeasesBySurfaceId.get(leaseAtRequest.surfaceId) !== leaseAtRequest ||
        leaseAtRequest.contextMutation.terminalGeneration !== leaseTerminalGenerationAtRequest
      )) return untrustedSender();
      return failure("WIDGET_UNAVAILABLE", "Open MeanThis to inspect this element.");
    }
    if (!clearActionBarrierTokenIsCurrent(clearActionToken)) return clearInProgress();
    if (leaseAtRequest && (
      inPageWidgetLeasesBySurfaceId.get(leaseAtRequest.surfaceId) !== leaseAtRequest ||
      leaseAtRequest.contextMutation.terminalGeneration !== leaseTerminalGenerationAtRequest
    )) return untrustedSender();
    const lease = leaseAtRequest ?? [...inPageWidgetLeasesBySurfaceId.values()].find(
      (candidate) => candidate.tabId === endpoint.tabId,
    );
    if (!lease) {
      return await openOverlayDetailsInSidePanel(
        pendingAction,
        sender.tab?.windowId,
        clearActionToken,
      );
    }
    const enqueueFailure = await coordinateInPageWidgetContextMutation(
      lease,
      async (token): Promise<RuntimeResponse | null> => {
        const actionLeaseIsCurrent = (): boolean => token.isCurrent() && (
          !leaseAtRequest || (
            lease === leaseAtRequest &&
            inPageWidgetLeasesBySurfaceId.get(leaseAtRequest.surfaceId) === leaseAtRequest &&
            lease.contextMutation.terminalGeneration === leaseTerminalGenerationAtRequest
          )
        );
        if (!clearActionBarrierTokenIsCurrent(clearActionToken)) return clearInProgress();
        if (!actionLeaseIsCurrent()) return untrustedSender();
        let pending = pendingInPageWidgetActionsBySurfaceId.get(lease.surfaceId) ?? [];
        if (pending.length >= MAX_PENDING_IN_PAGE_WIDGET_ACTIONS) {
          return failure("WIDGET_UNAVAILABLE", "Open MeanThis to inspect this element.");
        }
        const projectionCurrent = await pendingInPageWidgetActionProjectionIsCurrent(
          pendingAction,
          read.value,
        );
        if (!clearActionBarrierTokenIsCurrent(clearActionToken)) return clearInProgress();
        if (!actionLeaseIsCurrent() || !projectionCurrent) {
          return untrustedSender();
        }
        pending = pendingInPageWidgetActionsBySurfaceId.get(lease.surfaceId) ?? [];
        if (pending.length >= MAX_PENDING_IN_PAGE_WIDGET_ACTIONS) {
          return failure("WIDGET_UNAVAILABLE", "Open MeanThis to inspect this element.");
        }
        if (!clearActionBarrierTokenIsCurrent(clearActionToken)) return clearInProgress();
        if (!actionLeaseIsCurrent()) return untrustedSender();
        pending.push(pendingAction);
        pendingInPageWidgetActionsBySurfaceId.set(lease.surfaceId, pending);
        return null;
      },
    );
    if (enqueueFailure) return enqueueFailure;
    if (!clearActionBarrierTokenIsCurrent(clearActionToken)) return clearInProgress();
    await deliverPendingInPageWidgetActions(lease);
    if (!clearActionBarrierTokenIsCurrent(clearActionToken)) return clearInProgress();
    return { ok: true, data: null };
  }

  async function openOverlayDetailsInSidePanel(
    action: PendingInPageWidgetAction,
    windowId: number | undefined,
    clearActionToken: ClearActionBarrierToken,
  ): Promise<RuntimeResponse> {
    let sessionData: ActiveSessionCommandData | null = null;
    let activeTransition: ActiveOverlayItemTransition | null = null;
    let response: RuntimeResponse = failure("CAPTURE_FAILED", SAFE_CAPTURE_ERROR);
    await enqueueOverlayOperation(action.origin, async () => {
      if (!clearActionBarrierTokenIsCurrent(clearActionToken)) {
        response = clearInProgress();
        return;
      }
      const actionValid = await validatePendingInPageWidgetAction(action);
      if (!clearActionBarrierTokenIsCurrent(clearActionToken)) {
        response = clearInProgress();
        return;
      }
      if (!actionValid) {
        response = untrustedSender();
        return;
      }
      const read = await store.read(action.origin);
      if (!clearActionBarrierTokenIsCurrent(clearActionToken)) {
        response = clearInProgress();
        return;
      }
      if (!read.ok) {
        response = failureFromStore(read);
        return;
      }
      const ownsItem = await acknowledgedProjectionOwnsItem(
            read.value,
            action.projection,
            action.itemId,
            action.endpoint,
            action.origin,
            action.pathname,
          );
      if (!clearActionBarrierTokenIsCurrent(clearActionToken)) {
        response = clearInProgress();
        return;
      }
      if (read.value.epoch !== action.expectedEpoch || !ownsItem) {
        response = untrustedSender();
        return;
      }
      activeTransition = await rememberActiveOverlayItem(read.value, action.itemId);
      if (!clearActionBarrierTokenIsCurrent(clearActionToken)) {
        await restoreActiveOverlayItemIfCurrent(activeTransition);
        activeTransition = null;
        response = clearInProgress();
        return;
      }
      const stillValid = await validatePendingInPageWidgetAction(action);
      if (!clearActionBarrierTokenIsCurrent(clearActionToken)) {
        await restoreActiveOverlayItemIfCurrent(activeTransition);
        activeTransition = null;
        response = clearInProgress();
        return;
      }
      if (!stillValid) {
        await restoreActiveOverlayItemIfCurrent(activeTransition);
        activeTransition = null;
        response = untrustedSender();
        return;
      }
      const actionPage = {
        tabId: action.endpoint.tabId,
        frameId: action.endpoint.frameId,
        documentId: action.endpoint.documentId,
        origin: action.origin,
        pathname: action.pathname,
      } satisfies ActivePageContext;
      const actionScope = derivePanelCurrentScope(
        read.value.file,
        action.itemId,
        actionPage,
      );
      const metadataDiagnostics = await readSessionMetadataDiagnostics(
        action.origin,
        read.value,
        new Set(actionScope.itemIds),
      );
      if (!clearActionBarrierTokenIsCurrent(clearActionToken)) {
        await restoreActiveOverlayItemIfCurrent(activeTransition);
        activeTransition = null;
        response = clearInProgress();
        return;
      }
      sessionData = {
        enabled: true,
        origin: action.origin,
        readback: read.value,
        activePage: {
          tabId: action.endpoint.tabId,
          frameId: action.endpoint.frameId,
          documentId: action.endpoint.documentId,
          origin: action.origin,
          pathname: action.pathname,
        },
        selectedItemId: action.itemId,
        ...(metadataDiagnostics ? { metadataDiagnostics } : {}),
      };
      response = { ok: true, data: null };
    });
    if (!response.ok || !sessionData) return response;
    const failClosed = async (): Promise<RuntimeResponse> => {
      if (activeTransition) await restoreActiveOverlayItemIfCurrent(activeTransition);
      return untrustedSender();
    };
    if (!clearActionBarrierTokenIsCurrent(clearActionToken)) {
      if (activeTransition) await restoreActiveOverlayItemIfCurrent(activeTransition);
      return clearInProgress();
    }
    const actionValid = await validatePendingInPageWidgetAction(action);
    if (!clearActionBarrierTokenIsCurrent(clearActionToken)) {
      if (activeTransition) await restoreActiveOverlayItemIfCurrent(activeTransition);
      return clearInProgress();
    }
    if (!actionValid) return await failClosed();
    try {
      await reconcileActiveSession(sessionData);
    } catch {
      // Side-panel readback remains authoritative even if agent publication is unavailable.
    }
    if (!clearActionBarrierTokenIsCurrent(clearActionToken)) {
      if (activeTransition) await restoreActiveOverlayItemIfCurrent(activeTransition);
      return clearInProgress();
    }
    const finalActionValid = await validatePendingInPageWidgetAction(action);
    if (!clearActionBarrierTokenIsCurrent(clearActionToken)) {
      if (activeTransition) await restoreActiveOverlayItemIfCurrent(activeTransition);
      return clearInProgress();
    }
    if (!finalActionValid) return await failClosed();
    if (!clearActionBarrierTokenIsCurrent(clearActionToken)) return clearInProgress();
    await openSidePanel(resolveSidePanelOpenOptions({
      id: action.endpoint.tabId,
      ...(windowId === undefined ? {} : { windowId }),
    }));
    if (!clearActionBarrierTokenIsCurrent(clearActionToken)) return clearInProgress();
    const postOpenActionValid = await validatePendingInPageWidgetAction(action);
    if (!clearActionBarrierTokenIsCurrent(clearActionToken)) return clearInProgress();
    if (!postOpenActionValid) return await failClosed();
    return { ok: true, data: null };
  }

  async function handleOwnedOverlayMutation(
    message: OverlayActionRequestMessage,
    endpoint: OverlayEndpoint & { documentId: string },
    actionContext: ActivePageContext,
    clearActionToken: ClearActionBarrierToken,
  ): Promise<RuntimeResponse> {
    let response: RuntimeResponse = failure("CAPTURE_FAILED", SAFE_CAPTURE_ERROR);
    await enqueueOverlayOperation(actionContext.origin, async () => {
      if (!clearActionBarrierTokenIsCurrent(clearActionToken)) {
        response = clearInProgress();
        return;
      }
      const endpointCurrent = await isCurrentOverlayActionEndpoint(
        endpoint,
        actionContext.origin,
        actionContext.pathname,
      );
      if (!clearActionBarrierTokenIsCurrent(clearActionToken)) {
        response = clearInProgress();
        return;
      }
      if (!endpointCurrent) {
        response = untrustedSender();
        return;
      }
      const previous = await store.read(actionContext.origin);
      if (!clearActionBarrierTokenIsCurrent(clearActionToken)) {
        response = clearInProgress();
        return;
      }
      if (!previous.ok) {
        response = failureFromStore(previous);
        return;
      }
      const projectionAuthority = await overlayProjectionItemAuthority(
        previous.value,
        message.projection,
        message.itemId,
        endpoint,
        actionContext.origin,
          actionContext.pathname,
      );
      if (!clearActionBarrierTokenIsCurrent(clearActionToken)) {
        response = clearInProgress();
        return;
      }
      const endpointStillCurrent = await isCurrentOverlayActionEndpoint(
        endpoint,
        actionContext.origin,
        actionContext.pathname,
      );
      if (!clearActionBarrierTokenIsCurrent(clearActionToken)) {
        response = clearInProgress();
        return;
      }
      if (!endpointStillCurrent) {
        response = untrustedSender();
        return;
      }
      if (projectionAuthority !== "acknowledged") {
        response = projectionAuthority === "pending"
          ? overlayProjectionReackRequired()
          : untrustedSender();
        return;
      }
      if (previous.value.epoch === null) {
        response = failure("CAPTURE_FAILED", SAFE_CAPTURE_ERROR);
        return;
      }
      const previousEpoch = previous.value.epoch;
      const mutationAuthority = createOwnedOverlayMutationAuthority(
        previous.value,
        message.projection,
        message.itemId,
        endpoint,
        actionContext.origin,
        actionContext.pathname,
        clearActionToken,
      );
      if (!mutationAuthority?.isCurrent()) {
        response = untrustedSender();
        return;
      }
      if (message.action === "save") {
        if (!clearActionBarrierTokenIsCurrent(clearActionToken)) {
          response = clearInProgress();
          return;
        }
        const updated = await store.updateIntent(
          actionContext.origin,
          previousEpoch,
          message.itemId,
          message.taskNote,
          mutationAuthority,
        );
        if (!updated.ok) {
          response = failureFromStore(updated);
          return;
        }
        const returnedItem = updated.value.file?.session.attachments.find(
          (item) => item.id === message.itemId,
        );
        if (returnedItem?.sourceRecord.intent !== message.taskNote) {
          response = failure("CAPTURE_FAILED", SAFE_CAPTURE_ERROR);
          return;
        }
        const confirmed = await store.read(actionContext.origin);
        if (!confirmed.ok) {
          response = failureFromStore(confirmed);
          return;
        }
        const confirmedItem = confirmed.value.file?.session.attachments.find(
          (item) => item.id === message.itemId,
        );
        if (confirmed.value.epoch !== updated.value.epoch ||
            confirmedItem?.sourceRecord.intent !== message.taskNote ||
            !overlayReadbackContainsItem(
              confirmed.value,
              message.itemId,
              actionContext.origin,
            )) {
          response = failure("CAPTURE_FAILED", SAFE_CAPTURE_ERROR);
          return;
        }
        response = { ok: true, data: null };
        if (clearActionBarrierTokenIsCurrent(clearActionToken) &&
            await isCurrentOverlayActionEndpoint(
          endpoint,
          actionContext.origin,
          actionContext.pathname,
        )) {
          await performOverlaySyncPreservingActive(
            confirmed.value,
            previous.value,
            actionContext,
          ).catch(() => undefined);
        }
        return;
      }
      if (message.action !== "remove") {
        response = untrustedSender();
        return;
      }

      if (!clearActionBarrierTokenIsCurrent(clearActionToken)) {
        response = clearInProgress();
        return;
      }
      const removed = await coordinateAnnotationLifecycleControlExecution(async () => {
        if (!clearActionBarrierTokenIsCurrent(clearActionToken)) return null;
        if (!await terminateAnnotationLifecycleControlForCanonicalRemovalExclusive(
          (delivery) => delivery.origin === actionContext.origin,
          (execution) => execution.origin === actionContext.origin &&
            execution.itemId === message.itemId,
        )) return null;
        return await store.removeItem(
          actionContext.origin,
          previousEpoch,
          message.itemId,
          mutationAuthority,
        );
      });
      if (!removed) {
        if (!clearActionBarrierTokenIsCurrent(clearActionToken)) {
          response = clearInProgress();
          return;
        }
        response = failure(
          "STORAGE_ERROR",
          "MeanThis could not cancel pending Agent lifecycle approvals before removing this target.",
        );
        return;
      }
      if (!removed.ok) {
        response = failureFromStore(removed);
        return;
      }
      if (removed.value.file?.session.attachments.some((item) => item.id === message.itemId)) {
        response = failure("CAPTURE_FAILED", SAFE_CAPTURE_ERROR);
        return;
      }
      const confirmed = await store.read(actionContext.origin);
      if (!confirmed.ok) {
        response = failureFromStore(confirmed);
        return;
      }
      if (confirmed.value.epoch !== removed.value.epoch ||
          confirmed.value.file?.session.attachments.some((item) => item.id === message.itemId)) {
        response = failure("CAPTURE_FAILED", SAFE_CAPTURE_ERROR);
        return;
      }
      const cleanup = await removeStaleSessionMetadataDiagnostics(actionContext.origin);
      if (!cleanup.ok) {
        response = metadataDiagnosticsCleanupPending();
        return;
      }
      if (cleanup.readback.epoch !== removed.value.epoch ||
          cleanup.readback.file?.session.attachments.some((item) => item.id === message.itemId)) {
        response = failure("CAPTURE_FAILED", SAFE_CAPTURE_ERROR);
        return;
      }
      response = { ok: true, data: null };
      if (clearActionBarrierTokenIsCurrent(clearActionToken) &&
          await isCurrentOverlayActionEndpoint(
        endpoint,
        actionContext.origin,
        actionContext.pathname,
      )) {
        await performOverlaySyncPreservingActive(
          cleanup.readback,
          previous.value,
          actionContext,
        ).catch(() => undefined);
      }
    });
    if (response.ok && message.action !== "more") {
      await publishSessionUpdated(actionContext.origin, message.itemId);
    }
    if (response.ok && clearActionBarrierTokenIsCurrent(clearActionToken)) {
      await reconcileAvailableOverlayWidget(actionContext);
    }
    return response;
  }

  async function isCurrentOverlayActionEndpoint(
    endpoint: OverlayEndpoint & { documentId: string },
    origin: string,
    pathname: string,
  ): Promise<boolean> {
    try {
      const liveFrame = await chrome.webNavigation.getFrame({
        tabId: endpoint.tabId,
        frameId: endpoint.frameId,
      });
      return liveFrame?.documentId === endpoint.documentId &&
        routeKeyFromUrl(liveFrame.url) === `${origin}${pathname}`;
    } catch {
      return false;
    }
  }

  function overlayReadbackContainsItem(
    readback: ActiveSessionReadback,
    itemId: string,
    origin: string,
  ): boolean {
    return (readback.file?.session.attachments ?? []).some((item) =>
      item.id === itemId && item.sourceRecord.origin === origin
    );
  }

  async function overlayProjectionItemsMatchLiveRoute(
    readback: ActiveSessionReadback,
    subject: OverlayProjectionDescriptor["subject"],
    itemIds: readonly string[],
  ): Promise<boolean> {
    const liveSubject = await resolveOverlayProjectionSubject({
      tabId: subject.tabId,
      frameId: subject.frameId,
      documentId: subject.documentId,
    }, subject.origin);
    if (!liveSubject || !sameOverlayProjectionSubject(liveSubject, subject)) return false;
    const liveRouteChain = subject.frameId === 0
      ? [{ origin: liveSubject.origin, pathname: liveSubject.pathname }]
      : await readLiveCaptureRouteChain(chrome, {
          tabId: subject.tabId,
          frameId: subject.frameId,
        }, subject.documentId);
    if (liveRouteChain === null) return false;
    const attachments = readback.file?.session.attachments ?? [];
    return itemIds.every((itemId) => {
      const item = attachments.find((candidate) => candidate.id === itemId);
      const record = item?.sourceRecord as OriginCaptureRecord | undefined;
      if (!record || record.origin !== subject.origin ||
          pathnameFromUrl(record.pageUrl ?? undefined) !== subject.pathname ||
          ((record.frameId ?? 0) === 0) !== (subject.frameId === 0)) return false;
      return storedCaptureRouteChainMatchesLive(record, liveRouteChain);
    });
  }

  async function reconcileAvailableOverlayWidget(context: ActivePageContext): Promise<void> {
    if (!context.documentId || !await isCurrentOverlayActionEndpoint({
      tabId: context.tabId,
      frameId: context.frameId,
      documentId: context.documentId,
    }, context.origin, context.pathname)) return;
    const lease = [...inPageWidgetLeasesBySurfaceId.values()].find((candidate) =>
      candidate.tabId === context.tabId
    );
    if (!lease) return;
    const nextActionContext: ActivePageContext = {
      ...context,
    };
    let reconciledContext = false;
    await coordinateInPageWidgetContextMutation(lease, async (token) => {
      if (!token.isCurrent() || hasPendingInPageWidgetAction(lease) ||
          inPageWidgetLeasesBySurfaceId.get(lease.surfaceId) !== lease) return;
      const previousActionContext = lease.actionContext;
      try {
        lease.actionContext = nextActionContext;
        await persistInPageWidgetLease(lease);
        if (!token.isCurrent()) {
          await compensateCancelledInPageWidgetContextMutation(lease, token, [{
            field: "actionContext",
            expected: nextActionContext,
            previous: previousActionContext,
          }]);
          return;
        }
        const endpointCurrent = nextActionContext.documentId
          ? await isCurrentOverlayActionEndpoint({
              tabId: nextActionContext.tabId,
              frameId: nextActionContext.frameId,
              documentId: nextActionContext.documentId,
            }, nextActionContext.origin, nextActionContext.pathname)
          : false;
        if (!token.isCurrent() || hasPendingInPageWidgetAction(lease) ||
            inPageWidgetLeasesBySurfaceId.get(lease.surfaceId) !== lease ||
            !endpointCurrent) {
          if (!token.isCurrent()) {
            await compensateCancelledInPageWidgetContextMutation(lease, token, [{
              field: "actionContext",
              expected: nextActionContext,
              previous: previousActionContext,
            }]);
          } else if (lease.actionContext === nextActionContext) {
            lease.actionContext = previousActionContext;
            await persistInPageWidgetLease(lease).catch(() => undefined);
          }
          return;
        }
        reconciledContext = true;
      } catch {
        if (lease.actionContext === nextActionContext) {
          lease.actionContext = previousActionContext;
        }
      }
    });
    if (reconciledContext) await reconcileWidgetSession(lease);
  }

  async function persistInPageWidgetLease(lease: InPageWidgetLease): Promise<void> {
    if ((lease.actionContext && !lease.actionContext.documentId) ||
        (lease.frameContext && !lease.frameContext.documentId)) {
      throw new Error("MeanThis widget frame context is unavailable.");
    }
    await inPageWidgetLeaseStore.save({
      capability: lease.capability,
      documentId: lease.documentId,
      origin: lease.origin,
      pathname: lease.pathname,
      surfaceId: lease.surfaceId,
      tabId: lease.tabId,
      windowId: lease.windowId,
      actionContext: lease.actionContext ? {
        documentId: lease.actionContext.documentId!,
        frameId: lease.actionContext.frameId,
        origin: lease.actionContext.origin,
        pathname: lease.actionContext.pathname,
      } : null,
      frameContext: lease.frameContext ? {
        documentId: lease.frameContext.documentId!,
        frameId: lease.frameContext.frameId,
        origin: lease.frameContext.origin,
        pathname: lease.frameContext.pathname,
      } : null,
    }, Date.now());
  }

  async function handleTabActivated(activeInfo: { tabId: number; windowId: number }): Promise<void> {
    advanceClearPageContextGeneration();
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
    if (changeInfo.status === "loading" || changeInfo.url !== undefined) {
      advanceClearPageContextGeneration();
    }
    // `tabs.onUpdated.status` does not carry committed top-document identity.
    // Terminal widget revocation is owned by `handleNavigationCommitted`,
    // where the committed top-frame documentId can be compared exactly.
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
      if (await isCurrentWindowActiveTab(tabId)) {
        // A worker restart can recover and publish a committed lifecycle result
        // concurrently with the first navigation event. Wait for that exact
        // recovery before clearing the departing active page so it cannot
        // republish the old route after this handler has already returned.
        await recoverAnnotationLifecycleControlExecutions();
        if (await isCurrentWindowActiveTab(tabId)) {
          try {
            await invalidateActivePageContext();
          } catch {
            // Agent publication is best-effort and must not change navigation handling.
          }
        }
      }
      activeOriginPublished = true;
    }
    if (changeInfo.status === "complete") {
      await ensureContentScript(tabId, 0);
      if (!activeOriginPublished) await publishActiveOriginChanged();
    }
  }

  async function isCurrentWindowActiveTab(tabId: number): Promise<boolean> {
    try {
      return (await chrome.tabs.query({ active: true, currentWindow: true })).some((tab) =>
        tab.id === tabId
      );
    } catch {
      return false;
    }
  }

  async function handleNavigationCommitted(
    details: UiAttachChromeNavigationCommittedDetails,
    topDocumentCommitted = true,
  ): Promise<void> {
    invalidateRuntimeCaptureLeasesForNavigation(details);
    const widgetLeasesOnTabAtCommit = [...inPageWidgetLeasesBySurfaceId.values()].filter((lease) =>
      lease.tabId === details.tabId
    );
    const widgetLeasesAtCommit = details.frameId === 0
      ? widgetLeasesOnTabAtCommit
      : [];
    const terminalWidgetCommit = details.frameId === 0 && topDocumentCommitted && (
      widgetLeasesAtCommit.length === 0 || widgetLeasesAtCommit.some((lease) =>
        lease.documentId !== details.documentId
      )
    );
    let lifecycleSnapshotReconciledForNavigation = false;
    advanceClearPageContextGeneration();
    if (terminalWidgetCommit) {
      // Establish the per-tab terminal generation before any other navigation
      // await so a dormant session restore cannot publish the previous lease.
      await revokeInPageWidgetTab(details.tabId, false, () => {
        lifecycleSnapshotReconciledForNavigation = true;
      });
    } else if (details.frameId === 0) {
      // Same-document navigation is an out-of-band cancellation signal. Fence
      // in-flight context persistence before any projection/storage await.
      for (const lease of widgetLeasesAtCommit) {
        invalidateInPageWidgetContextMutation(lease);
      }
    }
    await invalidateOverlayProjectionsForNavigation(details);
    const clearOrigin = originFromUrl(details.url);
    const clearPathname = pathnameFromUrl(details.url);
    if (details.documentId && clearOrigin && clearPathname !== null) {
      await replaceClearProjectionTargetsForLiveSubject({
        tabId: details.tabId,
        frameId: details.frameId,
        documentId: details.documentId,
        origin: clearOrigin,
        pathname: clearPathname,
      });
    } else {
      void requestClearProjectionDrain();
    }
    await clearPendingInPageWidgetActionsForNavigation(details);
    if (details.frameId === 0) {
      const widgetLeases = [...inPageWidgetLeasesBySurfaceId.values()].filter((lease) =>
        lease.tabId === details.tabId
      );
      const documentChangedForWidget = widgetLeases.some((lease) =>
        lease.documentId !== details.documentId
      );
      if (!terminalWidgetCommit && documentChangedForWidget) {
        await revokeInPageWidgetTab(details.tabId, false);
      } else if (!terminalWidgetCommit) {
        const origin = originFromUrl(details.url);
        const pathname = pathnameFromUrl(details.url);
        if (origin && pathname !== null) {
          for (const lease of widgetLeases) {
            // Navigation is an out-of-band cancellation signal. It invalidates
            // an in-flight mutation rather than waiting behind stale page I/O.
            invalidateInPageWidgetContextMutation(lease);
            const nextActionContext = hasPendingInPageWidgetAction(lease)
              ? lease.actionContext
              : undefined;
            const contextChanged = lease.origin !== origin || lease.pathname !== pathname ||
              lease.actionContext !== nextActionContext;
            lease.origin = origin;
            lease.pathname = pathname;
            lease.actionContext = nextActionContext;
            if (!contextChanged) continue;
            try {
              await persistInPageWidgetLease(lease);
            } catch {
              await revokeInPageWidgetTab(details.tabId, false);
              break;
            }
          }
        }
      }
    }
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
    if (
      widgetLeasesOnTabAtCommit.length > 0 &&
      !terminalWidgetCommit &&
      hasInPageWidgetLeaseForTab(details.tabId)
    ) {
      // A same-document or child-frame navigation keeps the widget iframe alive,
      // so its in-memory panel snapshot needs an explicit wake after the exact
      // lease/projection route has been rebound. The widget then performs its
      // own capability-bound read; no session data is carried by this signal.
      await publishRuntimeMessage({ type: UI_ATTACH_OVERLAY_PROJECTION_UPDATED });
    }
    const activePageAfterTerminalCommit = terminalWidgetCommit
      ? await getActivePageContext()
      : null;
    const invalidateAllPageContext = terminalWidgetCommit && (
      lifecycleSnapshotReconciledForNavigation ||
      reconciledActiveSessionTabId === details.tabId ||
      activePageAfterTerminalCommit?.tabId === details.tabId
    );
    if (invalidateAllPageContext) {
      try {
        await invalidateActivePageContext();
        await refreshInPageWidgetContext(details.tabId);
      } catch {
        // Agent publication is best-effort and must not change navigation handling.
      }
    } else if (widgetLeasesOnTabAtCommit.length > 0) {
      try {
        await reconcileActiveSession({
          enabled: false,
          origin: null,
          readback: null,
          activePage: null,
        });
        await refreshInPageWidgetContext(details.tabId);
      } catch {
        // Agent publication is best-effort and must not change navigation handling.
      }
    }
  }

  async function invalidateOverlayProjectionsForNavigation(
    details: UiAttachChromeNavigationCommittedDetails,
  ): Promise<void> {
    await ensureOverlayProjectionRegistryLoaded();
    const readbacksByOrigin = new Map<string, ActiveSessionReadback | null>();
    let changed = false;
    for (const [key, record] of overlayProjectionsBySubject) {
      const subject = record.projection.subject;
      if (subject.tabId !== details.tabId) continue;
      if (!readbacksByOrigin.has(subject.origin)) {
        const readback = await readAuthoritativeSession(subject.origin);
        readbacksByOrigin.set(subject.origin, readback.ok ? readback.value : null);
      }
      const readback = readbacksByOrigin.get(subject.origin) ?? null;
      if (readback && await overlayProjectionItemsMatchLiveRoute(
        readback,
        subject,
        record.itemIds,
      )) continue;
      overlayProjectionsBySubject.delete(key);
      overlayProjectionSubjectsIssuedByWorker.delete(key);
      changed = true;
    }
    if (changed && !await persistOverlayProjectionRegistry()) {
      throw new Error("Overlay projection invalidation persistence failed.");
    }
  }

  async function clearPendingInPageWidgetActionsForNavigation(
    details: UiAttachChromeNavigationCommittedDetails,
  ): Promise<void> {
    const readbacksByOrigin = new Map<string, ActiveSessionReadback | null>();
    for (const [surfaceId, pending] of pendingInPageWidgetActionsBySurfaceId) {
      const retained: PendingInPageWidgetAction[] = [];
      for (const action of pending) {
        if (action.endpoint.tabId !== details.tabId) {
          retained.push(action);
          continue;
        }
        if (action.endpoint.frameId === details.frameId) {
          if (action.endpoint.documentId === details.documentId &&
              routeKeyFromUrl(details.url) === `${action.origin}${action.pathname}`) {
            retained.push(action);
          }
          continue;
        }
        if (!readbacksByOrigin.has(action.origin)) {
          const readback = await store.read(action.origin);
          readbacksByOrigin.set(action.origin, readback.ok ? readback.value : null);
        }
        const readback = readbacksByOrigin.get(action.origin) ?? null;
        if (readback && await overlayProjectionItemAuthority(
          readback,
          action.projection,
          action.itemId,
          action.endpoint,
          action.origin,
          action.pathname,
        ) === "acknowledged") retained.push(action);
      }
      if (retained.length === pending.length) continue;
      const lease = inPageWidgetLeasesBySurfaceId.get(surfaceId);
      if (lease) invalidateInPageWidgetContextMutation(lease);
      const waiter = inPageWidgetActionAckWaitersBySurfaceId.get(surfaceId);
      if (waiter && !retained.includes(waiter.action)) waiter.settle("dropped");
      if (retained.length > 0) pendingInPageWidgetActionsBySurfaceId.set(surfaceId, retained);
      else pendingInPageWidgetActionsBySurfaceId.delete(surfaceId);
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
      if (parseInPageWidgetLifecyclePortName(port.name)) {
        void retainInPageWidgetLifecyclePort(port);
        return;
      }
      if (port.name === UI_ATTACH_SELECTION_LIFECYCLE_PORT) {
        retainElementSelectionLifecyclePort(port);
        return;
      }
      const panelWindowId = panelLifecycleWindowId(port.name);
      if (
        panelWindowId !== null &&
        port.sender &&
        isExtensionPageSender(port.sender)
      ) {
        retainPanelVisibilityLease(panelWindowId, port);
        return;
      }
      disconnectPortSafely(port);
    });
    chrome.tabs.onActivated.addListener((activeInfo) => {
      void handleTabActivated(activeInfo);
    });
    chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
      void handleTabUpdated(tabId, changeInfo, tab);
    });
    chrome.alarms.onAlarm.addListener((alarm) => {
      if (alarm.name === UI_ATTACH_CLEAR_PROJECTION_RETRY_ALARM) {
        void reconcileClearProjectionJournal();
      }
    });
    chrome.webNavigation.onCommitted.addListener((details) => {
      void handleNavigationCommitted(details);
    });
    chrome.webNavigation.onHistoryStateUpdated.addListener((details) => {
      void handleNavigationCommitted(details, false);
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
        (OVERLAY_VISIBILITY_PREFERENCE_KEY in changes ||
          OVERLAY_DISPLAY_MODE_PREFERENCE_KEY in changes)
      ) {
        requestOverlayVisibilityBroadcast();
      }
    });
    void deliverContentSettings(currentDisclosureMode, null);
    void deliverOverlayVisibility("panel", "hover").then(async () => {
      if (await storageAccessReady) requestOverlayVisibilityBroadcast();
    }).catch(() => undefined);
    void reconcileClearProjectionJournal();
    void recoverAnnotationLifecycleControlExecutions();
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

  function retainElementSelectionLifecyclePort(port: UiAttachChromePort): void {
    if (
      !port.sender ||
      !contentOriginFromSender(port.sender) ||
      !hasElementSelectionLease(port.sender)
    ) {
      disconnectPortSafely(port);
      return;
    }
    const previous = elementSelectionLifecyclePort;
    elementSelectionLifecyclePort = port;
    if (previous && previous !== port) {
      disconnectPortSafely(previous);
    }
    port.onMessage?.addListener((message) => {
      if (
        elementSelectionLifecyclePort !== port ||
        !isSelectionLifecycleHeartbeat(message)
      ) return;
      // Message delivery is the keepalive signal. Selection authority remains
      // bound to the exact sender captured above and is never changed here.
    });
    port.onDisconnect.addListener(() => {
      if (elementSelectionLifecyclePort !== port) return;
      elementSelectionLifecyclePort = null;
      void revokeElementSelectionLease();
    });
  }

  function detachElementSelectionLifecyclePort(): void {
    const current = elementSelectionLifecyclePort;
    elementSelectionLifecyclePort = null;
    if (!current) return;
    disconnectPortSafely(current);
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

  async function listWidgetFrameScopes(
    lease: InPageWidgetLease,
  ): Promise<SessionCommandResponse<WidgetFrameScopeListData>> {
    const topPage = await getWidgetTopPageContext(lease);
    if (!topPage) {
      return failure(
        "ACTIVE_PAGE_UNAVAILABLE",
        "Capture scopes are available only on the current MeanThis page.",
      );
    }
    const scopes = await readLiveFrameScopes(topPage);
    if (!scopes) {
      return failure("FRAME_SCOPE_UNAVAILABLE", "MeanThis could not read the live frame tree.");
    }
    const activeContext = await getWidgetCapturePageContext(lease);
    const currentScope = activeContext
      ? scopes.find((scope) => (
          scope.frameId === activeContext.frameId && scope.selectable &&
          scope.origin === activeContext.origin && scope.pathname === activeContext.pathname &&
          (activeContext.documentId === undefined || scope.documentId === activeContext.documentId)
        ))
      : undefined;
    const currentFrameId = currentScope
      ? currentScope.frameId
      : 0;
    return {
      ok: true,
      data: {
        currentFrameId,
        scopes: await countWidgetFrameScopeItems(lease.tabId, scopes),
      },
    };
  }

  async function countWidgetFrameScopeItems(
    tabId: number,
    scopes: FrameScopeDescriptor[],
    seededReadbacks: ReadonlyMap<string, ActiveSessionReadback | null> = new Map(),
    requireAcknowledgedProjection = false,
  ): Promise<WidgetFrameScopeDescriptor[]> {
    await ensureOverlayProjectionRegistryLoaded();
    const readbacksByOrigin = new Map(seededReadbacks);
    await Promise.all([...new Set(scopes.map((scope) => scope.origin))].map(async (origin) => {
      if (readbacksByOrigin.has(origin)) return;
      const readback = await readAuthoritativeSession(origin);
      readbacksByOrigin.set(origin, readback.ok ? readback.value : null);
    }));
    const routeChainsByFrameId = new Map(scopes.map((scope) => [
      scope.frameId,
      captureRouteChainFromFrameScopes(scopes, scope.frameId),
    ]));
    const routeChainCounts = new Map<string, number>();
    for (const chain of routeChainsByFrameId.values()) {
      if (!chain) continue;
      const key = JSON.stringify(chain);
      routeChainCounts.set(key, (routeChainCounts.get(key) ?? 0) + 1);
    }
    return scopes.map((scope) => {
      const readback = readbacksByOrigin.get(scope.origin) ?? null;
      const liveRouteChain = routeChainsByFrameId.get(scope.frameId) ?? null;
      const liveRouteIsUnique = liveRouteChain !== null &&
        routeChainCounts.get(JSON.stringify(liveRouteChain)) === 1;
      const savedItemIds = readback === null
        ? null
        : (readback.file?.session.attachments ?? [])
            .filter(({ sourceRecord }) => {
              if (sourceRecord.origin !== scope.origin ||
                  routeKeyFromUrl(sourceRecord.pageUrl ?? undefined) !== `${scope.origin}${scope.pathname}` ||
                  (sourceRecord.tabId !== undefined && sourceRecord.tabId !== tabId)) return false;
              if ((sourceRecord.frameId ?? 0) > 0 || Object.hasOwn(sourceRecord, "routeChain")) {
                return liveRouteIsUnique &&
                  storedCaptureRouteChainMatchesLive(sourceRecord, liveRouteChain ?? undefined);
              }
              return (sourceRecord.frameId ?? 0) === scope.frameId;
            })
            .map((item) => item.id)
            .slice(0, OVERLAY_RESTORE_MAX_ITEMS);
      const subject = scope.documentId === null
        ? null
        : {
            tabId,
            frameId: scope.frameId,
            documentId: scope.documentId,
            origin: scope.origin,
            pathname: scope.pathname,
          };
      const projection = subject === null || !overlayProjectionAuthorityAvailable
        ? undefined
        : overlayProjectionsBySubject.get(overlayProjectionSubjectKey(subject));
      const currentProjection = subject !== null && projection && readback !== null &&
          projection.projection.sessionEpoch === readback.epoch &&
          sameOverlayProjectionSubject(projection.projection.subject, subject)
        ? projection
        : null;
      const acknowledgedProjection = currentProjection?.delivery === "acknowledged"
        ? currentProjection
        : null;
      const displayProjectionCandidate = acknowledgedProjection ?? (
        !requireAcknowledgedProjection && currentProjection && currentProjection.itemIds.length > 0
          ? currentProjection
          : null
      );
      const savedItemIdSet = savedItemIds === null ? null : new Set(savedItemIds);
      const displayProjection = displayProjectionCandidate && savedItemIdSet !== null &&
          displayProjectionCandidate.itemIds.every((itemId) => savedItemIdSet.has(itemId))
        ? displayProjectionCandidate
        : null;
      const authoritativeItemIds = subject !== null && overlayProjectionAuthorityAvailable
        ? displayProjection?.itemIds ?? []
        : null;
      const projectedItemIds = readback === null || authoritativeItemIds === null
        ? null
        : derivePanelCurrentScope(
            readback.file,
            null,
            subject,
            new Set(authoritativeItemIds),
          ).itemIds;
      const itemIds = displayProjection
        ? projectedItemIds
        : requireAcknowledgedProjection && subject !== null && overlayProjectionAuthorityAvailable
          ? []
          : savedItemIds;
      return {
        ...scope,
        itemCount: itemIds?.length ?? null,
        itemIds,
      };
    });
  }

  async function readWidgetCurrentScopeItemIds(
    lease: InPageWidgetLease,
    activePage: ActivePageContext,
    readback: ActiveSessionReadback,
  ): Promise<string[] | null> {
    const unavailable = (): string[] | null => activePage.frameId === 0 ? null : [];
    if (!activePage.documentId) return unavailable();
    const topPage = await getWidgetTopPageContext(lease);
    if (!topPage) return unavailable();
    const scopes = await readLiveFrameScopes(topPage);
    if (!scopes) return unavailable();
    const counted = await countWidgetFrameScopeItems(
      lease.tabId,
      scopes,
      new Map([[activePage.origin, readback]]),
    );
    const current = counted.find((scope) => (
      scope.frameId === activePage.frameId &&
      scope.documentId === activePage.documentId &&
      scope.origin === activePage.origin &&
      scope.pathname === activePage.pathname
    ));
    return current?.itemIds ? [...current.itemIds] : unavailable();
  }

  async function selectWidgetFrameScope(
    command: Extract<InPageWidgetCommand, { type: "ui-attach:widget-frame-scope-select" }>,
    lease: InPageWidgetLease,
  ): Promise<SessionCommandResponse<{ enabled: boolean }>> {
    const response = await coordinateInPageWidgetContextMutation(
      lease,
      (token) => selectWidgetFrameScopeMutation(command, lease, token),
    );
    if (response.ok) await reconcileWidgetSession(lease);
    return response;
  }

  async function selectWidgetFrameScopeMutation(
    command: Extract<InPageWidgetCommand, { type: "ui-attach:widget-frame-scope-select" }>,
    lease: InPageWidgetLease,
    token: InPageWidgetContextMutationToken,
  ): Promise<SessionCommandResponse<{ enabled: boolean }>> {
    if (!token.isCurrent() || hasPendingInPageWidgetAction(lease)) {
      return failure(
        "WIDGET_STATE_UNAVAILABLE",
        "Finish the pending marker action before changing capture scope.",
      );
    }
    const selectionIntent = await selectionIntentStore.read();
    if (!token.isCurrent()) {
      return failure(
        "WIDGET_STATE_UNAVAILABLE",
        "MeanThis widget surface is no longer available.",
      );
    }
    if (!selectionIntent.ok || selectionIntent.value.generation !== command.expectedGeneration) {
      return failure(
        "WIDGET_STATE_UNAVAILABLE",
        "The capture selection state changed before the frame scope was selected.",
      );
    }
    const listed = await listWidgetFrameScopes(lease);
    if (!token.isCurrent()) {
      return failure(
        "WIDGET_STATE_UNAVAILABLE",
        "MeanThis widget surface is no longer available.",
      );
    }
    if (!listed.ok) return listed;
    if (hasPendingInPageWidgetAction(lease)) {
      return failure(
        "WIDGET_STATE_UNAVAILABLE",
        "Finish the pending marker action before changing capture scope.",
      );
    }
    const scope = listed.data.scopes.find((candidate) => (
      candidate.frameId === command.frameId &&
      candidate.documentId === command.documentId &&
      candidate.origin === command.origin &&
      candidate.pathname === command.pathname
    ));
    if (!scope?.selectable) {
      return failure("FRAME_UNAVAILABLE", "The selected frame scope is no longer available.");
    }

    const documentId = scope.documentId ?? (scope.frameId === 0 ? lease.documentId : null);
    if (!documentId) {
      return failure("FRAME_UNAVAILABLE", "The selected frame scope is no longer available.");
    }
    const previousActionContext = lease.actionContext;
    const previousFrameContext = lease.frameContext;
    lease.actionContext = undefined;
    const nextFrameContext: ActivePageContext = {
      tabId: lease.tabId,
      frameId: scope.frameId,
      documentId,
      origin: scope.origin,
      pathname: scope.pathname,
    };
    lease.frameContext = nextFrameContext;
    try {
      await persistInPageWidgetLease(lease);
    } catch {
      lease.actionContext = previousActionContext;
      lease.frameContext = previousFrameContext;
      return failure("WIDGET_STATE_UNAVAILABLE", "MeanThis could not save the selected frame scope.");
    }
    if (!token.isCurrent()) {
      await compensateCancelledInPageWidgetContextMutation(lease, token, [{
        field: "frameContext",
        expected: nextFrameContext,
        previous: previousFrameContext,
      }]);
      return failure(
        "WIDGET_STATE_UNAVAILABLE",
        "MeanThis widget surface is no longer available.",
      );
    }
    if (hasPendingInPageWidgetAction(lease)) {
      const pendingHead = pendingInPageWidgetActionHead(lease)!;
      const expectedContext = pendingActionContext(lease, pendingHead);
      if (!sameActivePageContext(lease.actionContext, expectedContext)) {
        lease.actionContext = undefined;
      }
      lease.frameContext = previousFrameContext;
      if (token.isCurrent()) {
        await persistInPageWidgetLease(lease).catch(() => undefined);
      }
      return failure(
        "WIDGET_STATE_UNAVAILABLE",
        "Finish the pending marker action before changing capture scope.",
      );
    }
    const response = await selectFrameScope({
      type: "ui-attach:frame-scope-select",
      tabId: lease.tabId,
      frameId: scope.frameId,
      documentId: scope.documentId,
      origin: scope.origin,
      pathname: scope.pathname,
      startSelection: elementSelectionTabId === lease.tabId,
    }, { allowFrameDerivedTopPage: true, isMutationCurrent: token.isCurrent });
    if (!token.isCurrent()) {
      await compensateCancelledInPageWidgetContextMutation(lease, token, [{
        field: "frameContext",
        expected: nextFrameContext,
        previous: previousFrameContext,
      }]);
      return failure(
        "WIDGET_STATE_UNAVAILABLE",
        "MeanThis widget surface is no longer available.",
      );
    }
    if (!response.ok) {
      const pendingHead = pendingInPageWidgetActionHead(lease);
      lease.actionContext = pendingHead && sameActivePageContext(
        lease.actionContext,
        pendingActionContext(lease, pendingHead),
      )
        ? lease.actionContext
        : previousActionContext;
      lease.frameContext = previousFrameContext;
      try {
        if (token.isCurrent()) await persistInPageWidgetLease(lease);
      } catch {
        if (token.isCurrent()) await revokeInPageWidgetTab(lease.tabId, false);
      }
    } else {
      await requestInPageWidgetOverlayScopeRestore(nextFrameContext);
      if (!token.isCurrent()) {
        await compensateCancelledInPageWidgetContextMutation(lease, token, [{
          field: "frameContext",
          expected: nextFrameContext,
          previous: previousFrameContext,
        }]);
        requestOverlayVisibilityBroadcast();
        return failure(
          "WIDGET_STATE_UNAVAILABLE",
          "MeanThis widget surface is no longer available.",
        );
      }
      await deliverInPageWidgetOverlayScopeVisibility(lease, listed.data.scopes);
    }
    return response;
  }

  async function requestInPageWidgetOverlayScopeRestore(
    context: ActivePageContext,
  ): Promise<void> {
    if (!context.documentId) return;
    let ready = false;
    try {
      ready = await ensureContentScript(context.tabId, context.frameId, context.documentId);
    } catch {
      ready = false;
    }
    if (!ready) return;
    try {
      await chrome.tabs.sendMessage(context.tabId, {
        type: UI_ATTACH_OVERLAY_RESTORE_REFRESH,
      }, {
        frameId: context.frameId,
        documentId: context.documentId,
      });
    } catch {
      // A later content READY/restore wake can recover a temporarily unavailable frame runtime.
    }
  }

  async function deliverInPageWidgetOverlayScopeVisibility(
    lease: InPageWidgetLease,
    scopes: readonly FrameScopeDescriptor[],
  ): Promise<void> {
    await Promise.all(scopes.map(async (scope) => {
      if (scope.documentId === null) return;
      try {
        await chrome.tabs.sendMessage(lease.tabId, {
          type: UI_ATTACH_OVERLAY_SCOPE_VISIBILITY_UPDATED,
          visible: inPageWidgetOverlayScopeVisible({
            tabId: lease.tabId,
            frameId: scope.frameId,
            documentId: scope.documentId,
            origin: scope.origin,
            pathname: scope.pathname,
          }),
        }, { frameId: scope.frameId, documentId: scope.documentId });
      } catch {
        // A frame without the current content runtime cannot expose stale markers.
      }
    }));
  }

  async function selectFrameScope(
    command: Extract<SessionCommand, { type: "ui-attach:frame-scope-select" }>,
    options?: {
      allowFrameDerivedTopPage?: boolean;
      isMutationCurrent?: () => boolean;
    },
  ): Promise<SessionCommandResponse<{ enabled: boolean }>> {
    const mutationIsCurrent = options?.isMutationCurrent ?? (() => true);
    const cancelled = (): SessionCommandResponse<{ enabled: boolean }> => failure(
      "WIDGET_STATE_UNAVAILABLE",
      "MeanThis widget surface is no longer available.",
    );
    if (!mutationIsCurrent()) return cancelled();
    const activeTab = await getActiveTabForTab(command.tabId);
    if (!mutationIsCurrent()) return cancelled();
    if (!activeTab) {
      return failure("FRAME_UNAVAILABLE", "The selected frame scope is no longer available.");
    }
    let frames: UiAttachChromeFrame[] | undefined;
    try {
      frames = await chrome.webNavigation.getAllFrames({ tabId: command.tabId });
    } catch {
      frames = undefined;
    }
    if (!mutationIsCurrent()) return cancelled();
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
          undefined,
          undefined,
          undefined,
          mutationIsCurrent,
        );
      }
      if (!mutationIsCurrent()) return cancelled();
      await forgetResumableElementSelectionScope(command.tabId);
      if (!mutationIsCurrent()) return cancelled();
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
        undefined,
        undefined,
        undefined,
        mutationIsCurrent,
      );
    }
    if (typeof activeTab.windowId !== "number" || !Number.isInteger(activeTab.windowId)) {
      return failure("FRAME_UNAVAILABLE", "The selected frame scope is no longer available.");
    }
    if (!mutationIsCurrent()) return cancelled();
    const rememberedScope: ResumableElementSelectionScope = {
      tabId: command.tabId,
      windowId: activeTab.windowId,
      target,
      expectedPage,
    };
    await rememberResumableElementSelectionScope(rememberedScope);
    if (!mutationIsCurrent()) {
      await forgetResumableElementSelectionScopeIfCurrent(command.tabId, rememberedScope);
      return cancelled();
    }
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
    isMutationCurrent: () => boolean = () => true,
    authorityIntent: "explicit" | "resume" = "explicit",
    expectedAuthorityGeneration?: number,
  ): Promise<SessionCommandResponse<{ enabled: boolean }>> {
    const intentRevision = command.enabled
      ? expectedRevision ?? elementSelectionRevision
      : expectedRevision;
    const mutationCancelled = (): SessionCommandResponse<{ enabled: boolean }> => failure(
      "WIDGET_STATE_UNAVAILABLE",
      "MeanThis widget surface is no longer available.",
    );
    if (!isMutationCurrent()) return mutationCancelled();
    if (!command.enabled) {
      if (!await revokeElementSelectionLease(null, expectedAuthorityGeneration)) {
        return failure("WIDGET_STATE_UNAVAILABLE", "Selection stop could not be persisted.");
      }
      return isMutationCurrent()
        ? { ok: true, data: { enabled: false } }
        : mutationCancelled();
    }
    const disclosureAcknowledged = await isFirstCaptureDisclosureAcknowledged();
    if (!isMutationCurrent()) return mutationCancelled();
    if (!selectionIntentStillCurrent(intentRevision, expectedContextMenuRevision)) {
      return { ok: true, data: { enabled: false } };
    }
    if (!disclosureAcknowledged) {
      return failure("DISCLOSURE_REQUIRED", FIRST_CAPTURE_DISCLOSURE_REQUIRED_ERROR);
    }

    const activeTab = await getActiveTabForTab(command.tabId);
    if (!isMutationCurrent()) return mutationCancelled();
    if (!selectionIntentStillCurrent(intentRevision, expectedContextMenuRevision)) {
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
    if (!isMutationCurrent()) {
      if (pendingSelectionMatches(
        revision,
        activePage,
        target,
        expectedPage,
        expectedContextMenuRevision,
      )) clearPendingElementSelectionLease();
      return mutationCancelled();
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
    if (!isMutationCurrent()) {
      if (pendingSelectionMatches(
        revision,
        activePage,
        target,
        expectedPage,
        expectedContextMenuRevision,
      )) clearPendingElementSelectionLease();
      return mutationCancelled();
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

    const authorityBefore = await selectionIntentStore.read();
    if (!isMutationCurrent() || !pendingSelectionMatches(
      revision,
      activePage,
      target,
      expectedPage,
      expectedContextMenuRevision,
    )) {
      if (pendingSelectionMatches(revision, activePage, target, expectedPage)) {
        clearPendingElementSelectionLease();
      }
      return mutationCancelled();
    }
    if (!authorityBefore.ok) {
      clearPendingElementSelectionLease();
      return failure("WIDGET_STATE_UNAVAILABLE", authorityBefore.error);
    }
    const authorityGeneration = expectedAuthorityGeneration ?? authorityBefore.value.generation;
    const authorized = authorityIntent === "resume"
      ? await selectionIntentStore.resume(activePage.tabId, authorityGeneration)
      : await selectionIntentStore.startExplicit(activePage.tabId, authorityGeneration);
    if (!authorized.ok) {
      clearPendingElementSelectionLease();
      return authorityIntent === "resume"
        ? { ok: true, data: { enabled: false } }
        : failure("WIDGET_STATE_UNAVAILABLE", authorized.error);
    }
    if (!isMutationCurrent() || !pendingSelectionMatches(
      revision,
      activePage,
      target,
      expectedPage,
      expectedContextMenuRevision,
    )) {
      if (pendingSelectionMatches(revision, activePage, target, expectedPage)) {
        clearPendingElementSelectionLease();
      }
      await selectionIntentStore.stop(null, authorized.value.generation);
      return mutationCancelled();
    }

    detachElementSelectionLifecyclePort();
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
    elementSelectionAuthorityGeneration = authorized.value.generation;
    elementSelectionBasicDiagnosticsArm = command.collectBasicDiagnostics === true
      ? {
          selectionRevision: revision,
          selectionGeneration: authorized.value.generation,
        }
      : null;
    try {
      const disclosureMode = await readDisclosureModeSetting();
      if (!isMutationCurrent()) {
        if (activeSelectionMatches(
          revision,
          activePage,
          target,
          expectedPage,
        )) await revokeElementSelectionLease();
        return mutationCancelled();
      }
      if (!activeSelectionMatches(
        revision,
        activePage,
        target,
        expectedPage,
        expectedContextMenuRevision,
      )) {
        if (activeSelectionMatches(revision, activePage, target, expectedPage)) {
          await revokeElementSelectionLease();
        }
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
      if (!isMutationCurrent()) {
        if (activeSelectionMatches(
          revision,
          activePage,
          target,
          expectedPage,
        )) await revokeElementSelectionLease();
        return mutationCancelled();
      }
      if (!activeSelectionMatches(
        revision,
        activePage,
        target,
        expectedPage,
        expectedContextMenuRevision,
      )) {
        if (activeSelectionMatches(revision, activePage, target, expectedPage)) {
          await revokeElementSelectionLease();
        }
        return { ok: true, data: { enabled: false } };
      }
      if (!deliveredTabIds.has(endpointKey({ tabId: activePage.tabId, frameId: target.frameId }))) {
        await revokeElementSelectionLease();
        if (!isMutationCurrent()) return mutationCancelled();
        return failure(
          "CONTENT_UNAVAILABLE",
          "Element selection is not available on the active page.",
        );
      }
      const stillActive = await getActivePageContextForTab(activePage.tabId);
      if (!isMutationCurrent()) {
        if (activeSelectionMatches(
          revision,
          activePage,
          target,
          expectedPage,
        )) await revokeElementSelectionLease();
        return mutationCancelled();
      }
      if (!activeSelectionMatches(
        revision,
        activePage,
        target,
        expectedPage,
        expectedContextMenuRevision,
      )) {
        if (activeSelectionMatches(revision, activePage, target, expectedPage)) {
          await revokeElementSelectionLease();
        }
        return { ok: true, data: { enabled: false } };
      }
      if (!stillActive || stillActive.windowId !== activePage.windowId) {
        await revokeElementSelectionLease();
        if (!isMutationCurrent()) return mutationCancelled();
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
        if (!isMutationCurrent()) return mutationCancelled();
        return failure("FRAME_UNAVAILABLE", "The selected embedded frame is no longer available.");
      }
      const finalFrameStillMatches = target.frameId === 0 ||
        await embeddedFrameStillMatches(activePage.tabId, target);
      if (!isMutationCurrent()) {
        if (activeSelectionMatches(
          revision,
          activePage,
          target,
          expectedPage,
        )) await revokeElementSelectionLease();
        return mutationCancelled();
      }
      if (!activeSelectionMatches(
        revision,
        activePage,
        target,
        expectedPage,
        expectedContextMenuRevision,
      )) {
        if (activeSelectionMatches(revision, activePage, target, expectedPage)) {
          await revokeElementSelectionLease();
        }
        return { ok: true, data: { enabled: false } };
      }
      if (!finalFrameStillMatches) {
        await revokeElementSelectionLease();
        if (!isMutationCurrent()) return mutationCancelled();
        return failure("FRAME_UNAVAILABLE", "The selected embedded frame is no longer available.");
      }
      await publishElementSelectionUpdated(true);
      if (!isMutationCurrent()) {
        if (activeSelectionMatches(
          revision,
          activePage,
          target,
          expectedPage,
        )) await revokeElementSelectionLease();
        return mutationCancelled();
      }
      if (!activeSelectionMatches(
        revision,
        activePage,
        target,
        expectedPage,
        expectedContextMenuRevision,
      )) {
        if (activeSelectionMatches(revision, activePage, target, expectedPage)) {
          await revokeElementSelectionLease();
        }
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
      if (!isMutationCurrent()) {
        await forgetResumableElementSelectionScope(activePage.tabId);
        if (activeSelectionMatches(
          revision,
          activePage,
          target,
          expectedPage,
        )) await revokeElementSelectionLease();
        return mutationCancelled();
      }
      return { ok: true, data: { enabled: true } };
    } catch {
      if (activeSelectionMatches(
        revision,
        activePage,
        target,
        expectedPage,
      )) {
        await revokeElementSelectionLease();
      }
      if (!isMutationCurrent()) return mutationCancelled();
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

  async function revokeElementSelectionLease(
    clearOperationId: string | null = null,
    expectedGeneration?: number,
  ): Promise<boolean> {
    invalidateAllRuntimeCaptureLeases();
    const hadLease = elementSelectionTabId !== null;
    const permissionLease = elementSelectionPermissionLease;
    elementSelectionPermissionLease = null;
    detachElementSelectionLifecyclePort();
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
    elementSelectionAuthorityGeneration = null;
    elementSelectionBasicDiagnosticsArm = null;
    clearPendingElementSelectionLease();
    elementSelectionRevision += 1;
    const durableStop = await selectionIntentStore.stop(clearOperationId, expectedGeneration);
    try {
      await deliverContentSettings(currentDisclosureMode, null);
    } catch {
      // Background authority is already fail-closed even if a tab cannot be notified.
    }
    if (permissionLease) {
      try {
        await permissionLease.release();
      } catch (error) {
        await publishFailure(frameScopeAccessFailureMessage(error));
      }
    }
    if (hadLease) await publishElementSelectionUpdated(false);
    return durableStop.ok;
  }

  function hasElementSelectionLease(sender: UiAttachChromeMessageSender): boolean {
    const senderTabId = contentTabIdFromSender(sender);
    const senderFrameId = contentFrameIdFromSender(sender);
    return senderTabId !== null && senderFrameId !== null &&
      senderTabId === elementSelectionTabId &&
      senderFrameId === elementSelectionFrameId &&
      selectionDocumentMatches(sender.documentId);
  }

  function invalidateAllRuntimeCaptureLeases(): void {
    captureRouteLeaseGeneration += 1;
    for (const lease of activeRuntimeCaptureLeases.values()) lease.current = false;
    activeRuntimeCaptureLeases.clear();
  }

  function invalidateRuntimeCaptureLeasesForNavigation(
    details: UiAttachChromeNavigationCommittedDetails,
  ): void {
    let invalidated = details.tabId === elementSelectionTabId && (
      (details.frameId === 0 && (
        documentChanged(details.documentId, elementSelectionFrameId === 0
          ? elementSelectionDocumentId
          : null) ||
        routeChanged(details.url, elementSelectionTopOrigin, elementSelectionTopPathname)
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
    for (const [operationId, lease] of activeRuntimeCaptureLeases) {
      if (lease.token.routeLease.tabId !== details.tabId) continue;
      const segment = lease.token.routeLease.segments.find(
        (candidate) => candidate.frameId === details.frameId,
      );
      if (!segment || (
        details.documentId === segment.documentId &&
        !routeChanged(details.url, segment.origin, segment.pathname)
      )) continue;
      lease.current = false;
      activeRuntimeCaptureLeases.delete(operationId);
      invalidated = true;
    }
    if (invalidated) captureRouteLeaseGeneration += 1;
  }

  function selectionDocumentMatches(documentId: string | undefined): boolean {
    return elementSelectionDocumentId === null || documentId === elementSelectionDocumentId;
  }

  function isSelectionLifecycleHeartbeat(value: unknown): boolean {
    return isRecord(value) &&
      hasExactKeys(value, ["type"]) &&
      value.type === UI_ATTACH_SELECTION_LIFECYCLE_HEARTBEAT;
  }

  async function ensureResumableElementSelectionScopesLoaded(): Promise<void> {
    if (!resumableElementSelectionScopesLoadTask) {
      resumableElementSelectionScopesLoadTask = (async () => {
        try {
          const poison = await chrome.storage.local.get(
            FRAME_SCOPE_INVALIDATION_AUTHORITY_POISON_LOCAL_KEY,
          );
          if (Object.hasOwn(
            poison,
            FRAME_SCOPE_INVALIDATION_AUTHORITY_POISON_LOCAL_KEY,
          )) {
            resumableElementSelectionScopeInvalidationAuthorityAvailable = false;
            return;
          }
        } catch {
          resumableElementSelectionScopeInvalidationAuthorityAvailable = false;
          await persistResumableElementSelectionScopeInvalidationPoison();
          return;
        }
        try {
          const invalidationValues = await chrome.storage.local.get(
            FRAME_SCOPE_INVALIDATIONS_LOCAL_KEY,
          );
          const rawInvalidations = invalidationValues[FRAME_SCOPE_INVALIDATIONS_LOCAL_KEY];
          const invalidations = parseStoredResumableElementSelectionScopes(rawInvalidations);
          if (Object.hasOwn(invalidationValues, FRAME_SCOPE_INVALIDATIONS_LOCAL_KEY) && (
            !Array.isArray(rawInvalidations) || invalidations.length !== rawInvalidations.length
          )) {
            resumableElementSelectionScopeInvalidationAuthorityAvailable = false;
            await persistResumableElementSelectionScopeInvalidationPoison();
            return;
          }
          for (const scope of invalidations) {
            invalidatedResumableElementSelectionScopes.set(scope.tabId, scope);
          }
        } catch {
          resumableElementSelectionScopeInvalidationAuthorityAvailable = false;
          await persistResumableElementSelectionScopeInvalidationPoison();
          return;
        }
        if (!resumableElementSelectionScopeInvalidationAuthorityAvailable) return;
        try {
          const values = await chrome.storage.session.get(FRAME_SCOPE_SESSION_KEY);
          const scopes = parseStoredResumableElementSelectionScopes(
            values[FRAME_SCOPE_SESSION_KEY],
          );
          for (const scope of scopes) {
            const invalidated = invalidatedResumableElementSelectionScopes.get(scope.tabId);
            if (invalidated && sameResumableElementSelectionScope(invalidated, scope)) continue;
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
    const persisted = await persistResumableElementSelectionScopes();
    if (!persisted || resumableElementSelectionScopes.get(scope.tabId) !== scope) return;
    const invalidated = invalidatedResumableElementSelectionScopes.get(scope.tabId);
    if (!invalidated && resumableElementSelectionScopeInvalidationAuthorityAvailable) return;
    if (invalidated) invalidatedResumableElementSelectionScopes.delete(scope.tabId);
    if (!await persistResumableElementSelectionScopeInvalidations() && invalidated) {
      invalidatedResumableElementSelectionScopes.set(scope.tabId, invalidated);
    }
  }

  async function forgetResumableElementSelectionScope(tabId: number): Promise<void> {
    await ensureResumableElementSelectionScopesLoaded();
    const current = resumableElementSelectionScopes.get(tabId);
    if (!current) return;
    await forgetResumableElementSelectionScopeIfCurrent(tabId, current);
  }

  async function forgetResumableElementSelectionScopeIfCurrent(
    tabId: number,
    expected: ResumableElementSelectionScope,
  ): Promise<void> {
    await ensureResumableElementSelectionScopesLoaded();
    if (resumableElementSelectionScopes.get(tabId) !== expected) return;
    const invalidation = cloneResumableElementSelectionScope(expected);
    invalidatedResumableElementSelectionScopes.set(tabId, invalidation);
    const invalidationPersisted = await persistResumableElementSelectionScopeInvalidations();
    if (resumableElementSelectionScopes.get(tabId) !== expected) return;
    resumableElementSelectionScopes.delete(tabId);
    const cleaned = await persistResumableElementSelectionScopes();
    if (!cleaned || !invalidationPersisted ||
        !sameResumableElementSelectionScope(
          invalidatedResumableElementSelectionScopes.get(tabId),
          invalidation,
        )) return;
    invalidatedResumableElementSelectionScopes.delete(tabId);
    if (!await persistResumableElementSelectionScopeInvalidations()) {
      invalidatedResumableElementSelectionScopes.set(tabId, invalidation);
    }
  }

  async function persistResumableElementSelectionScopes(): Promise<boolean> {
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
      return true;
    } catch {
      return false;
    }
  }

  async function persistResumableElementSelectionScopeInvalidations(): Promise<boolean> {
    const snapshot = Array.from(
      invalidatedResumableElementSelectionScopes.values(),
      cloneResumableElementSelectionScope,
    );
    if (!resumableElementSelectionScopeInvalidationAuthorityAvailable ||
        snapshot.length > MAX_RESUMABLE_FRAME_SCOPES) {
      resumableElementSelectionScopeInvalidationAuthorityAvailable = false;
      await persistResumableElementSelectionScopeInvalidationPoison();
      return false;
    }
    resumableElementSelectionScopeInvalidationsWriteTail =
      resumableElementSelectionScopeInvalidationsWriteTail
        .catch(() => undefined)
        .then(() => chrome.storage.local.set({
          [FRAME_SCOPE_INVALIDATIONS_LOCAL_KEY]: snapshot,
        }));
    try {
      await resumableElementSelectionScopeInvalidationsWriteTail;
      return true;
    } catch {
      resumableElementSelectionScopeInvalidationAuthorityAvailable = false;
      await persistResumableElementSelectionScopeInvalidationPoison();
      return false;
    }
  }

  async function persistResumableElementSelectionScopeInvalidationPoison(): Promise<boolean> {
    resumableElementSelectionScopeInvalidationAuthorityAvailable = false;
    resumableElementSelectionScopeInvalidationPoisonWriteTail =
      resumableElementSelectionScopeInvalidationPoisonWriteTail
        .catch(() => undefined)
        .then(() => chrome.storage.local.set({
          [FRAME_SCOPE_INVALIDATION_AUTHORITY_POISON_LOCAL_KEY]:
            INVALIDATION_AUTHORITY_UNAVAILABLE,
        }));
    try {
      await resumableElementSelectionScopeInvalidationPoisonWriteTail;
      return true;
    } catch {
      return false;
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

  function metadataDiagnosticsFingerprint(
    readback: ActiveSessionReadback,
  ): MetadataDiagnosticsSessionFingerprintItemV1[] | null {
    if (!readback.file) return null;
    return readback.file.session.attachments.map((item) => ({
      itemId: item.id,
      capturedAt: item.sourceRecord.capturedAt,
    }));
  }

  async function readSessionMetadataDiagnostics(
    origin: string,
    readback: ActiveSessionReadback,
    allowedItemIds: ReadonlySet<string>,
  ): Promise<MetadataDiagnosticsV1 | null> {
    const file = readback.file;
    const fingerprint = metadataDiagnosticsFingerprint(readback);
    if (!file || !readback.epoch || !fingerprint) return null;
    const binding = await metadataDiagnosticsStore.readBinding(
      origin,
      readback.epoch,
      file.session.id,
      fingerprint,
    );
    return binding && allowedItemIds.has(binding.observedItemId)
      ? binding.sidecar
      : null;
  }

  async function replaceSessionMetadataDiagnostics(
    origin: string,
    readback: ActiveSessionReadback,
    observedItemId: string,
    observedAt: string,
    device: MetadataDiagnosticsDeviceV1 | undefined,
  ): Promise<boolean> {
    const file = readback.file;
    const fingerprint = metadataDiagnosticsFingerprint(readback);
    if (!file || !readback.epoch || !fingerprint || !device) {
      return await metadataDiagnosticsStore.remove(origin);
    }
    const replay = deriveCaptureReplayMetadataDiagnosticsV1({
      captureId: file.session.id,
      observedAt,
      replayAttemptGroups: file.session.attachments.map((item) =>
        (item.sourceRecord as OriginCaptureRecord).replayAttempts
      ),
    });
    if (!replay.ok) {
      await metadataDiagnosticsStore.remove(origin);
      return false;
    }
    const normalizedDevice: MetadataDiagnosticsV1["device"] =
      device.status === "collected" ? device : { status: "not_available" };
    const sidecar = validateMetadataDiagnosticsV1({
      ...replay.value,
      observedAt,
      device: normalizedDevice,
    });
    if (!sidecar.ok) {
      await metadataDiagnosticsStore.remove(origin);
      return false;
    }
    const written = await metadataDiagnosticsStore.write({
      schemaVersion: METADATA_DIAGNOSTICS_SESSION_SCHEMA_VERSION,
      kind: METADATA_DIAGNOSTICS_SESSION_KIND,
      origin,
      epoch: readback.epoch,
      observedItemId,
      fingerprint,
      sidecar: sidecar.value,
    });
    if (!written) await metadataDiagnosticsStore.remove(origin);
    return written;
  }

  async function removeStaleSessionMetadataDiagnostics(
    origin: string,
  ): Promise<{ ok: true; readback: ActiveSessionReadback } | { ok: false }> {
    const state: { readback?: ActiveSessionReadback } = {};
    const removed = await metadataDiagnosticsStore.removeUnlessCurrent(origin, async () => {
      const current = await store.read(origin);
      if (!current.ok) return undefined;
      state.readback = current.value;
      const file = current.value.file;
      const fingerprint = metadataDiagnosticsFingerprint(current.value);
      const identity = file && current.value.epoch && fingerprint
        ? {
            epoch: current.value.epoch,
            captureId: file.session.id,
            fingerprint,
          }
        : null;
      // The canonical session accepts IDs that the optional diagnostics schema
      // cannot represent. Such a session cannot have a matching valid sidecar.
      // Keep this decision inside the metadata queue after the verified read.
      return identity && canBindMetadataDiagnosticsSessionIdentity(origin, identity)
        ? identity
        : null;
    });
    return removed && state.readback
      ? { ok: true, readback: state.readback }
      : { ok: false };
  }

  async function removeSessionMetadataDiagnosticsForOrigins(
    origins: readonly string[],
  ): Promise<boolean> {
    const results = await Promise.all(origins.map((origin) =>
      metadataDiagnosticsStore.remove(origin)
    ));
    return results.every((removed) => removed);
  }

  async function getActiveSession(): Promise<SessionCommandResponse<ActiveSessionCommandData>> {
    const activePage = await getActiveCapturePageContext();
    if (!activePage) {
      return { ok: true, data: { enabled: false, origin: null, readback: null, activePage: null } };
    }
    const read = await readAuthoritativeSession(activePage.origin);
    if (!read.ok) return failureFromStore(read);
    await ensureActiveOverlayItemIdsLoaded();
    const selectedItemId = resolveOverlayActiveItemId(
      (read.value.file?.session.attachments ?? []).map((item) => item.id),
      activeOverlayItemIdsByOrigin.get(activePage.origin) ?? null,
    );
    const currentScope = derivePanelCurrentScope(
      read.value.file,
      selectedItemId,
      activePage,
    );
    const metadataDiagnostics = await readSessionMetadataDiagnostics(
      activePage.origin,
      read.value,
      new Set(currentScope.itemIds),
    );
    const confirmedActivePage = await getActiveCapturePageContext();
    if (!confirmedActivePage || !sameActivePage(activePage, confirmedActivePage) ||
        activePage.documentId !== confirmedActivePage.documentId) {
      return failure("ACTIVE_PAGE_UNAVAILABLE", "The active page could not be verified.");
    }
    return {
      ok: true,
      data: {
        enabled: true,
        origin: activePage.origin,
        readback: read.value,
        activePage,
        ...(selectedItemId ? { selectedItemId } : {}),
        ...(metadataDiagnostics ? { metadataDiagnostics } : {}),
      },
    };
  }

  async function reconcileActivePanelMutation(
    clearActionToken: ClearActionBarrierToken,
  ): Promise<void> {
    if (!clearActionBarrierTokenIsCurrent(clearActionToken)) return;
    try {
      const next = await getActiveSession();
      if (!next.ok || !clearActionBarrierTokenIsCurrent(clearActionToken)) return;
      await reconcileActiveSession(next.data);
    } catch {
      // The durable panel mutation remains authoritative when Agent publication is unavailable.
    }
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
    endpoint: OverlayEndpoint & { documentId: string },
  ): Promise<SessionCommandResponse<OverlayRestoreData>> {
    let response: SessionCommandResponse<OverlayRestoreData> = untrustedSender();
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
        frame.documentId === endpoint.documentId &&
        routeKeyFromUrl(frame.url) === routeKeyFromUrl(documentUrl)
      ))) return;
      const readback = await store.read(origin);
      if (!readback.ok) {
        response = failureFromStore(readback);
        return;
      }
      await ensureActiveOverlayItemIdsLoaded();
      const payload = collectOverlayRestoreData(
        readback.value,
        origin,
        documentUrl,
        endpoint,
        frames,
        activeOverlayItemIdsByOrigin.get(origin) ?? null,
        captureRouteChainFromFrames(frames, endpoint) ?? undefined,
      );
      const subject = await resolveOverlayProjectionSubject(endpoint, origin);
      if (!subject || subject.pathname !== pathnameFromUrl(documentUrl)) return;
      const projection = await createOverlayProjection(
        readback.value,
        subject,
        payload.items,
        payload.activeItemId,
        true,
      );
      if (!projection) return;
      response = {
        ok: true,
        data: { ...payload, projection: projection.projection },
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
        savedSessionStoredRouteChainMatches(record, command.frameKind, command.routeChain)
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
    if (frameKind === "embedded" && routeChain === undefined) return null;
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
      const liveRouteChain = await readLiveCaptureRouteChain(
        chrome,
        endpoint,
        frame.documentId,
      );
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

  async function resumeExistingDurableClearProjection(options: {
    operationId: string;
    origin: string;
    expectedEpoch: string | null;
    expectedBarrierScope: ClearProjectionBarrierScope;
    readActivePage(): Promise<ActivePageContext | null>;
  }): Promise<
    | { handled: false }
    | { handled: true; response: SessionCommandResponse<ActiveSessionReadback> }
  > {
    const setup = await withClearProjectionOperationLease(options.operationId, async (lease) => {
      const snapshot = await readAuthoritativeClearSnapshot();
      if (!snapshot.ok) return { kind: "response" as const, response: snapshot.response };
      const owned = snapshot.value.operations.find((operation) =>
        operation.origins.includes(options.origin)
      );
      if (!owned) return { kind: "unhandled" as const };
      if (owned.operationId !== options.operationId) {
        return { kind: "response" as const, response: clearInProgress() };
      }
      if (!owned.projection?.request) {
        return { kind: "response" as const, response: durableClearProjectionFailure(failure(
          "STORAGE_ERROR",
          "Clear request identity is unavailable for safe recovery.",
        )) };
      }
      let projection = owned.projection;
      const request = owned.projection.request;
      if (!authoritativeClearOperationMatchesBarrierScope(
        owned,
        options.expectedBarrierScope,
        options.expectedBarrierScope === "active-origin" ? [options.origin] : null,
      )) {
        return { kind: "response" as const, response: failure(
          "STALE_SESSION",
          "Clear retry scope does not match the durable clear request.",
        ) };
      }
      const contextFence = createClearPageContextFence(request.endpoint);
      const activePage = await options.readActivePage();
      if (!clearPageContextFenceIsCurrent(contextFence, request.endpoint)) {
        return { kind: "response" as const, response: clearPageContextChangedFailure() };
      }
      if (!await exactClearProjectionOperationIsCurrent(projection) ||
          !clearPageContextFenceIsCurrent(contextFence, request.endpoint)) {
        return { kind: "response" as const, response: clearProjectionChangedFailure() };
      }
      if (!activePage?.documentId || !sameClearProjectionSubject(
        request.endpoint,
        {
          tabId: activePage.tabId,
          frameId: activePage.frameId,
          documentId: activePage.documentId,
          origin: activePage.origin,
          pathname: activePage.pathname,
        },
      )) {
        return { kind: "response" as const, response: failure(
          "ACTIVE_PAGE_UNAVAILABLE",
          "MeanThis could not verify the exact active page for this clear retry.",
        ) };
      }
      const primaryRequest = request.origins.find((entry) =>
        entry.origin === options.origin
      );
      if (!primaryRequest || primaryRequest.beforeEpoch !== options.expectedEpoch) {
        return { kind: "response" as const, response: failure(
          "STALE_SESSION",
          "Clear retry belongs to a stale epoch.",
        ) };
      }

      let canonical = owned.canonical;
      const canonicalOrigin = canonical?.origins.find((entry) => entry.origin === options.origin);
      if (canonicalOrigin && canonicalOrigin.beforeEpoch !== options.expectedEpoch) {
        return { kind: "response" as const, response: failure(
          "STALE_SESSION",
          "Clear retry belongs to a stale epoch.",
        ) };
      }
      if (!canonical && projection.authority === null) {
        const verifiedEpochs = new Map<string, string | null>();
        for (const requestOrigin of request.origins) {
          const readback = await store.read(requestOrigin.origin);
          if (!readback.ok) return { kind: "response" as const, response: failureFromStore(readback) };
          if (!clearPageContextFenceIsCurrent(contextFence, request.endpoint)) {
            return { kind: "response" as const, response: clearPageContextChangedFailure() };
          }
          if (!await exactClearProjectionOperationIsCurrent(projection) ||
              !clearPageContextFenceIsCurrent(contextFence, request.endpoint)) {
            return { kind: "response" as const, response: clearProjectionChangedFailure() };
          }
          if (readback.value.epoch !== requestOrigin.beforeEpoch) {
            return { kind: "response" as const, response: failure(
              "STALE_SESSION",
              "A clear origin changed before durable recovery.",
            ) };
          }
          verifiedEpochs.set(requestOrigin.origin, readback.value.epoch);
        }
        if (!clearPageContextFenceIsCurrent(contextFence, request.endpoint) ||
            !requestEpochAuthorityIsVerified(request.origins, verifiedEpochs)) {
          return { kind: "response" as const, response: clearPageContextChangedFailure() };
        }
        const resumed = await store.clearOrigins({
          operationId: options.operationId,
          origins: request.origins.map((entry) => ({
            origin: entry.origin,
            epoch: entry.beforeEpoch,
          })),
        });
        if (!resumed.ok) {
          return { kind: "response" as const, response: durableClearProjectionFailure(
            failureFromStore(resumed),
          ) };
        }
        if (!await exactClearProjectionOperationIsCurrent(projection)) {
          return { kind: "response" as const, response: clearProjectionChangedFailure() };
        }
        canonical = resumed.value;
      } else if (canonical?.origins.some((origin) => origin.canonical === "pending")) {
        if (!clearPageContextFenceIsCurrent(contextFence, request.endpoint) ||
            !canonicalEpochAuthorityMatchesRequest(canonical, request.origins)) {
          return { kind: "response" as const, response: clearPageContextChangedFailure() };
        }
        const resumed = await store.clearOrigins({
          operationId: canonical.operationId,
          origins: canonical.origins.map((origin) => ({
            origin: origin.origin,
            epoch: origin.beforeEpoch,
          })),
        });
        if (!resumed.ok) {
          return { kind: "response" as const, response: durableClearProjectionFailure(
            failureFromStore(resumed),
          ) };
        }
        if (!await exactClearProjectionOperationIsCurrent(projection)) {
          return { kind: "response" as const, response: clearProjectionChangedFailure() };
        }
        canonical = resumed.value;
      }
      if (canonical?.origins.some((origin) => origin.canonical === "pending")) {
        return { kind: "response" as const, response: durableClearProjectionFailure(failure(
          "STORAGE_ERROR",
          "Canonical clear is pending durable recovery.",
        )) };
      }
      const authority = canonical ? clearProjectionAuthority(canonical) : projection.authority;
      if (!authority) {
        return { kind: "response" as const, response: durableClearProjectionFailure(failure(
          "STORAGE_ERROR",
          "Clear authority is not bound.",
        )) };
      }
      const committedOrigins = canonical
        ? canonical.origins.filter((origin) => origin.canonical === "committed")
            .map((origin) => ({ origin: origin.origin, originAfterEpoch: origin.afterEpoch }))
        : projection.origins.map((origin) => ({ ...origin }));
      if (committedOrigins.length === 0) {
        if (canonical) {
          const finalized = await store.finalizeClearOperation(authority);
          if (!finalized.ok) {
            return { kind: "response" as const, response: durableClearProjectionFailure(
              failureFromStore(finalized),
            ) };
          }
        }
        const removed = await clearProjectionStore.removeOperation(
          projection.authority ?? options.operationId,
          lease,
        );
        return { kind: "response" as const, response: removed.ok
          ? failure("STALE_SESSION", "No requested origin was canonically cleared.")
            : durableClearProjectionFailure(clearProjectionFailure(removed.code, removed.message)) };
      }
      if (!await removeSessionMetadataDiagnosticsForOrigins(
        committedOrigins.map((origin) => origin.origin),
      )) {
        return { kind: "response" as const, response: durableClearProjectionFailure(failure(
          "STORAGE_ERROR",
          "Capture diagnostics cleanup is pending durable recovery.",
        )) };
      }
      if (projection.authority === null) {
        const bound = await clearProjectionStore.commitOrigins(authority, committedOrigins, lease);
        if (!bound.ok) {
          return { kind: "response" as const, response: durableClearProjectionFailure(
            clearProjectionFailure(bound.code, bound.message),
          ) };
        }
        projection = bound.value;
      }
      const discovered = await clearProjectionStore.completeSubjectDiscovery(authority, lease);
      if (!discovered.ok) {
        return { kind: "response" as const, response: durableClearProjectionFailure(
          clearProjectionFailure(discovered.code, discovered.message),
        ) };
      }
      projection = discovered.value;
      const afterEpochByOrigin = new Map(committedOrigins.map((origin) => [
        origin.origin,
        origin.originAfterEpoch,
      ]));
      return {
        kind: "delivery" as const,
        authority,
        afterEpochByOrigin,
        retryTargets: projection.targets.filter((target) =>
          target.state === "pending" || target.state === "delivered"
        ),
      };
    });
    if (setup.kind === "unhandled") return { handled: false };
    if (setup.kind === "response") return { handled: true, response: setup.response };
    const { authority, afterEpochByOrigin, retryTargets } = setup;
    const acknowledgements = await Promise.all(retryTargets.map((target) => {
      const originAfterEpoch = afterEpochByOrigin.get(target.subject.origin);
      return originAfterEpoch === undefined
        ? Promise.resolve(false)
        : deliverClearProjectionTarget({ ...target, authority, originAfterEpoch });
    }));
    if (acknowledgements.some((accepted) => !accepted)) {
      return {
        handled: true,
        response: durableClearProjectionFailure(failure(
          "CONTENT_UNAVAILABLE",
          "Page markers are still pending exact zero-marker acknowledgement.",
        )),
      };
    }
    if (!await finalizeClearProjectionOperation(authority)) {
      return {
        handled: true,
        response: durableClearProjectionFailure(failure(
          "STORAGE_ERROR",
          "Clear completion could not be finalized durably.",
        )),
      };
    }
    const readback = await readAuthoritativeSession(options.origin);
    if (!readback.ok) return { handled: true, response: failureFromStore(readback) };
    if (readback.value.clearPending || readback.value.activeClearOperationId !== null) {
      return {
        handled: true,
        response: durableClearProjectionFailure(failure(
          "STORAGE_ERROR",
          "Clear completion is not authoritatively idle.",
        )),
      };
    }
    return { handled: true, response: { ok: true, data: readback.value } };
  }

  async function exactClearProjectionOperationIsCurrent(
    expected: ClearProjectionOperation,
  ): Promise<boolean> {
    const operations = await clearProjectionStore.listOperations();
    if (!operations.ok) return false;
    const current = operations.value.find((candidate) =>
      candidate.operationId === expected.operationId
    );
    return current !== undefined && sameExactClearProjectionOperation(current, expected);
  }

  function sameExactClearProjectionOperation(
    left: ClearProjectionOperation,
    right: ClearProjectionOperation,
  ): boolean {
    return JSON.stringify(sortStructuralValue(left)) ===
      JSON.stringify(sortStructuralValue(right));
  }

  function sortStructuralValue(value: unknown): unknown {
    if (Array.isArray(value)) return value.map(sortStructuralValue);
    if (typeof value !== "object" || value === null) return value;
    return Object.fromEntries(Object.keys(value).sort().map((key) => [
      key,
      sortStructuralValue((value as Record<string, unknown>)[key]),
    ]));
  }

  function clearProjectionChangedFailure(): Extract<SessionCommandResponse<never>, { ok: false }> {
    return durableClearProjectionFailure(failure(
      "STORAGE_ERROR",
      "Clear request identity changed during durable recovery.",
    ));
  }

  function advanceClearPageContextGeneration(): void {
    if (clearPageContextGeneration >= Number.MAX_SAFE_INTEGER) {
      clearPageContextGenerationOverflowed = true;
      return;
    }
    clearPageContextGeneration += 1;
  }

  function createClearPageContextFence(
    endpoint: ClearProjectionSubject,
  ): ClearPageContextFence {
    return {
      generation: clearPageContextGeneration,
      endpoint: { ...endpoint },
    };
  }

  function clearPageContextFenceIsCurrent(
    fence: ClearPageContextFence,
    endpoint: ClearProjectionSubject,
  ): boolean {
    return !clearPageContextGenerationOverflowed &&
      fence.generation === clearPageContextGeneration &&
      sameClearProjectionSubject(fence.endpoint, endpoint);
  }

  function clearPageContextGenerationIsCurrent(generation: number): boolean {
    return !clearPageContextGenerationOverflowed &&
      generation === clearPageContextGeneration;
  }

  function clearPageContextChangedFailure(): Extract<
    SessionCommandResponse<never>,
    { ok: false }
  > {
    return durableClearProjectionFailure(failure(
      "ACTIVE_PAGE_UNAVAILABLE",
      "The exact page context changed before the clear could be committed.",
    ));
  }

  async function retireExactUnboundClearProjection(
    expected: ClearProjectionOperation,
    lease: ClearProjectionOperationLease,
    contextGenerationAtRetirement: number,
  ): Promise<"retired" | "preserved" | "fault"> {
    if (expected.authority !== null || expected.request === null) return "preserved";
    const snapshot = await readAuthoritativeClearSnapshot();
    if (!snapshot.ok) return "fault";
    if (!clearPageContextGenerationIsCurrent(contextGenerationAtRetirement)) return "preserved";
    const owned = snapshot.value.operations.find((operation) =>
      operation.operationId === expected.operationId
    );
    if (!owned || owned.canonical !== null || owned.projection?.authority !== null ||
        owned.projection.request === null ||
        !sameExactClearProjectionOperation(owned.projection, expected)) return "preserved";
    const removed = await clearProjectionStore.removeExactUnboundOperation(
      expected,
      () => clearPageContextGenerationIsCurrent(contextGenerationAtRetirement),
      lease,
    );
    if (!removed.ok) return removed.code === "STALE_REFERENCE" ? "preserved" : "fault";
    return "retired";
  }

  async function failAfterPreparedClearContextChanged(
    prepared: ClearProjectionOperation,
    lease: ClearProjectionOperationLease,
  ): Promise<Extract<SessionCommandResponse<never>, { ok: false }>> {
    const retired = await retireExactUnboundClearProjection(
      prepared,
      lease,
      clearPageContextGeneration,
    );
    if (retired === "retired") return clearPageContextChangedFailure();
    return durableClearProjectionFailure(failure(
      "STORAGE_ERROR",
      retired === "fault"
        ? "Stale provisional clear retirement could not be persisted."
        : "Stale provisional clear authority changed before retirement.",
    ));
  }

  async function exactClearProjectionEndpointWasReplaced(
    endpoint: ClearProjectionSubject,
  ): Promise<boolean> {
    let frame: UiAttachChromeFrameDetails | undefined;
    try {
      frame = await chrome.webNavigation.getFrame({
        tabId: endpoint.tabId,
        frameId: endpoint.frameId,
      });
    } catch {
      return false;
    }
    if (!frame?.documentId) return false;
    const origin = originFromUrl(frame.url);
    const pathname = pathnameFromUrl(frame.url);
    if (!origin || pathname === null) return false;
    return frame.documentId !== endpoint.documentId ||
      origin !== endpoint.origin || pathname !== endpoint.pathname;
  }

  function requestEpochAuthorityIsVerified(
    requested: readonly { origin: string; beforeEpoch: string | null }[],
    verified: ReadonlyMap<string, string | null>,
  ): boolean {
    return requested.length === verified.size && requested.every((entry) =>
      verified.get(entry.origin) === entry.beforeEpoch && verified.has(entry.origin)
    );
  }

  function canonicalEpochAuthorityMatchesRequest(
    canonical: CaptureClearOperationV1,
    requested: readonly { origin: string; beforeEpoch: string | null }[],
  ): boolean {
    return canonical.origins.length === requested.length && canonical.origins.every((origin) =>
      requested.some((entry) => entry.origin === origin.origin &&
        entry.beforeEpoch === origin.beforeEpoch)
    );
  }

  function clearProjectionRequestBarrierScope(
    request: ClearProjectionOperation["request"],
  ): ClearProjectionBarrierScope {
    return request?.barrierScope ?? "live-page";
  }

  function sameExactOriginSet(
    actual: readonly string[],
    expected: readonly string[],
  ): boolean {
    const expectedSet = new Set(expected);
    return expectedSet.size === expected.length && actual.length === expectedSet.size &&
      actual.every((origin) => expectedSet.has(origin));
  }

  function authoritativeClearOperationMatchesBarrierScope(
    operation: AuthoritativeClearSnapshot["operations"][number],
    expectedScope: ClearProjectionBarrierScope,
    expectedOrigins: readonly string[] | null,
  ): boolean {
    const projection = operation.projection;
    if (!projection?.request ||
        clearProjectionRequestBarrierScope(projection.request) !== expectedScope) return false;
    if (expectedOrigins === null) return true;
    if (!sameExactOriginSet(operation.origins, expectedOrigins) ||
        !sameExactOriginSet(projection.requestedOrigins, expectedOrigins) ||
        !sameExactOriginSet(
          projection.request.origins.map((entry) => entry.origin),
          expectedOrigins,
        ) || projection.origins.some((entry) => !expectedOrigins.includes(entry.origin)) ||
        projection.targets.some((target) => !expectedOrigins.includes(target.subject.origin))) {
      return false;
    }
    return operation.canonical === null || sameExactOriginSet(
      operation.canonical.origins.map((entry) => entry.origin),
      expectedOrigins,
    );
  }

  function preparedRequestAuthorityMatches(
    operation: ClearProjectionOperation,
    endpoint: ClearProjectionSubject,
    targets: readonly { origin: string; epoch: string | null }[],
    barrierScope: ClearProjectionBarrierScope,
  ): boolean {
    if (operation.authority !== null || operation.origins.length !== 0 ||
        !operation.request || clearProjectionRequestBarrierScope(operation.request) !== barrierScope ||
        !sameClearProjectionSubject(operation.request.endpoint, endpoint)) {
      return false;
    }
    const expectedEpochs = new Map(targets.map((target) => [target.origin, target.epoch]));
    return operation.requestedOrigins.length === expectedEpochs.size &&
      operation.request.origins.length === expectedEpochs.size &&
      operation.requestedOrigins.every((origin) => expectedEpochs.has(origin)) &&
      operation.request.origins.every((entry) => expectedEpochs.has(entry.origin) &&
        expectedEpochs.get(entry.origin) === entry.beforeEpoch);
  }

  async function clearStoredOriginSession(
    command: Extract<SessionCommand, { type: "ui-attach:session-clear-stored-origin" }>,
    attempt: ClearActionBarrierAttempt,
  ): Promise<SessionCommandResponse<ActiveSessionReadback>> {
    const snapshot = await readAuthoritativeClearSnapshot();
    if (!snapshot.ok) return snapshot.response;
    if (snapshot.value.operations.some((operation) =>
      operation.operationId === command.operationId || operation.origins.includes(command.origin)
    )) return clearInProgress();
    const previous = await store.read(command.origin);
    // A cleanup-only saved entry has no valid epoch or prior readback. Let the
    // store recheck and recover that origin; unrelated read failures stay closed.
    if (!previous.ok && (command.epoch !== null || previous.code !== "INVALID_SESSION_FILE")) {
      return failureFromStore(previous);
    }
    const cleared = await coordinateAnnotationLifecycleControlExecution(async () => {
      if (!await terminateAnnotationLifecycleControlForCanonicalRemovalExclusive(
        (delivery) => delivery.origin === command.origin,
        (execution) => execution.origin === command.origin,
      )) return null;
      const current = await readAuthoritativeClearSnapshot();
      if (!current.ok) return { response: current.response };
      if (current.value.operations.some((operation) =>
        operation.operationId === command.operationId || operation.origins.includes(command.origin)
      ) || currentClearActionBarrierAttempt(attempt.operationId)?.attemptToken !== attempt.attemptToken) {
        return { response: clearInProgress() };
      }
      return { result: await store.clear(command.origin, command.epoch, command.operationId) };
    });
    if (!cleared) return failure(
      "STORAGE_ERROR", "MeanThis could not cancel pending Agent lifecycle approvals before clearing saved captures.",
    );
    if (cleared.response) return cleared.response;
    if (!cleared.result.ok) return failureFromStore(cleared.result);
    if (cleared.result.value.file !== null || cleared.result.value.legacyRecord !== null) {
      return failure("STALE_SESSION", "Saved captures changed after the clear operation.");
    }
    if (!await removeSessionMetadataDiagnosticsForOrigins([command.origin])) {
      return failure("STORAGE_ERROR", "Capture diagnostics cleanup could not be verified.");
    }
    // Saved-origin deletion has no live-page authority. Synchronize known
    // endpoints, without claiming durable exact marker acknowledgement.
    await syncOverlaySession(cleared.result.value, null, previous.ok ? previous.value : null);
    return { ok: true, data: cleared.result.value };
  }

  async function clearActivePageSessions(
    command: Extract<SessionCommand, { type: "ui-attach:session-clear" }>,
    clearBarrierAttempt: ClearActionBarrierAttempt,
  ): Promise<SessionCommandResponse<ActiveSessionReadback>> {
    const resumed = await resumeExistingDurableClearProjection({
      operationId: command.operationId,
      origin: command.origin,
      expectedEpoch: command.epoch,
      expectedBarrierScope: "live-page",
      readActivePage: getActiveCapturePageContext,
    });
    if (resumed.handled) return resumed.response;
    const clearPageContextGenerationAtDiscovery = clearPageContextGeneration;
    const topPage = await getActivePageContext();
    if (!topPage) {
      return failure(
        "ACTIVE_PAGE_UNAVAILABLE",
        "The active page could not be identified for exact marker cleanup.",
      );
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
    const liveFrames: Array<{
      frameId: number;
      documentId: string;
      origin: string;
      pathname: string;
    }> =
      frames.flatMap((frame) => {
        const origin = originFromUrl(frame.url);
        const pathname = pathnameFromUrl(frame.url);
        return origin && pathname !== null && frame.documentId
          ? [{ frameId: frame.frameId, documentId: frame.documentId, origin, pathname }]
          : [];
      });
    if (!liveFrames.some(({ origin }) => origin === topPage.origin)) {
      return failure(
        "ACTIVE_PAGE_UNAVAILABLE",
        "MeanThis could not verify the active document before clearing it.",
      );
    }

    const origins = [...new Set(liveFrames.map(({ origin }) => origin))];
    narrowClearActionBarrier(clearBarrierAttempt, origins, [topPage.tabId]);
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

    if (!await terminateAnnotationLifecycleControlForCanonicalRemoval(
      (delivery) => targets.some((target) => target.origin === delivery.origin),
      (execution) => targets.some((target) => target.origin === execution.origin),
    )) {
      return failure(
        "STORAGE_ERROR",
        "MeanThis could not cancel pending Agent lifecycle approvals before clearing.",
      );
    }

    return executeDurableClearProjection(
      command.operationId,
      command.origin,
      targets,
      topPage.tabId,
      liveFrames,
      getActiveCapturePageContext,
      clearPageContextGenerationAtDiscovery,
      "live-page",
    );
  }

  async function executeDurableClearProjection(
    operationId: string,
    primaryOrigin: string,
    targets: Array<{
      origin: string;
      epoch: string | null;
      previous: ActiveSessionReadback;
    }>,
    tabId: number | null,
    liveFrames: Array<{
      frameId: number;
      documentId: string;
      origin: string;
      pathname: string;
    }>,
    readRequestEndpoint: () => Promise<ActivePageContext | null>,
    contextGenerationAtDiscovery: number,
    barrierScope: ClearProjectionBarrierScope,
  ): Promise<SessionCommandResponse<ActiveSessionReadback>> {
    activeClearCanonicalMutationOperationIds.add(operationId);
    try {
    const requestedOrigins = targets.map((target) => target.origin)
      .sort((left, right) => left < right ? -1 : left > right ? 1 : 0);
    const liveTargets = tabId === null
      ? []
      : targets.flatMap((target) => collectLiveClearProjectionTargets(
        target.previous,
        tabId,
        liveFrames,
      ));
    const uniqueLiveTargets = new Map<string, LiveClearTarget>();
    for (const target of liveTargets) {
      uniqueLiveTargets.set(clearProjectionSubjectKey(target.subject), target);
    }

    for (const target of uniqueLiveTargets.values()) {
      let ready = false;
      try {
        ready = await ensureContentScript(
          target.subject.tabId,
          target.subject.frameId,
          target.subject.documentId,
        );
      } catch {
        ready = false;
      }
      if (!clearPageContextGenerationIsCurrent(contextGenerationAtDiscovery)) {
        return clearPageContextChangedFailure();
      }
      if (!ready) {
        return failure(
          "CONTENT_UNAVAILABLE",
          "MeanThis could not reconnect every selected frame before clearing its page markers.",
        );
      }
    }

    const requestEndpoint = await readRequestEndpoint();
    if (!clearPageContextGenerationIsCurrent(contextGenerationAtDiscovery) ||
        !requestEndpoint?.documentId || requestEndpoint.origin !== primaryOrigin) {
      return failure(
        "ACTIVE_PAGE_UNAVAILABLE",
        "MeanThis could not verify the exact active document before clearing it.",
      );
    }
    const requestDocumentId = requestEndpoint.documentId;
    const contextFence: ClearPageContextFence = {
      generation: contextGenerationAtDiscovery,
      endpoint: {
        tabId: requestEndpoint.tabId,
        frameId: requestEndpoint.frameId,
        documentId: requestDocumentId,
        origin: requestEndpoint.origin,
        pathname: requestEndpoint.pathname,
      },
    };

    const preparedTargets = [...uniqueLiveTargets.values()].map((target) => ({
      subject: { ...target.subject },
      removedItemIds: [...target.removedItemIds],
      projectionId: crypto.randomUUID(),
      revision: 1,
      nextAttemptAt: Date.now(),
    }));
    const setup = await withClearProjectionOperationLease(operationId, async (lease) => {
      if (!clearPageContextFenceIsCurrent(contextFence, contextFence.endpoint)) {
        return { ok: false as const, response: clearPageContextChangedFailure() };
      }
      const prepared = await clearProjectionStore.prepare({
        operationId,
        requestedOrigins,
        request: {
          nonce: crypto.randomUUID(),
          barrierScope,
          endpoint: {
            tabId: requestEndpoint.tabId,
            frameId: requestEndpoint.frameId,
            documentId: requestDocumentId,
            origin: requestEndpoint.origin,
            pathname: requestEndpoint.pathname,
          },
          origins: targets.map((target) => ({
            origin: target.origin,
            beforeEpoch: target.epoch,
          })).sort((left, right) => left.origin < right.origin ? -1 : left.origin > right.origin ? 1 : 0),
        },
        targets: preparedTargets,
      }, lease);
      if (!prepared.ok) {
        return { ok: false as const, response: clearProjectionFailure(prepared.code, prepared.message) };
      }

      if (!preparedRequestAuthorityMatches(
        prepared.value,
        contextFence.endpoint,
        targets,
        barrierScope,
      )) {
        return { ok: false as const, response: clearProjectionChangedFailure() };
      }
      if (!clearPageContextFenceIsCurrent(contextFence, contextFence.endpoint)) {
        return {
          ok: false as const,
          response: await failAfterPreparedClearContextChanged(prepared.value, lease),
        };
      }

      let canonical = await store.clearOrigins({
        operationId,
        origins: targets.map((target) => ({ origin: target.origin, epoch: target.epoch })),
      });
      if (!await exactClearProjectionOperationIsCurrent(prepared.value)) {
        return { ok: false as const, response: clearProjectionChangedFailure() };
      }
      if (!canonical.ok) {
        const originalFailure = canonical;
        const recovered = await reconcileClearProjectionAfterCanonicalFailure(operationId);
        if (!recovered) {
          return { ok: false as const, response: durableClearProjectionFailure(
            failureFromStore(originalFailure),
          ) };
        }
        canonical = { ok: true, value: recovered };
      }
      if (canonical.value.origins.some((origin) => origin.canonical === "pending")) {
        return { ok: false as const, response: durableClearProjectionFailure(
          failure("STORAGE_ERROR", "Canonical clear is pending durable recovery."),
        ) };
      }
      const authority = clearProjectionAuthority(canonical.value);
      const committedOrigins = canonical.value.origins
        .filter((origin) => origin.canonical === "committed")
        .map((origin) => ({ origin: origin.origin, originAfterEpoch: origin.afterEpoch }));
      if (committedOrigins.length === 0) {
        const finalized = await store.finalizeClearOperation(authority);
        const conflict = failure("STALE_SESSION", "No requested origin was canonically cleared.");
        if (!finalized.ok) {
          return { ok: false as const, response: durableClearProjectionFailure(conflict) };
        }
        const removed = await clearProjectionStore.removeOperation(operationId, lease);
        return { ok: false as const, response: removed.ok
          ? conflict
          : durableClearProjectionFailure(conflict) };
      }
      const bound = await clearProjectionStore.commitOrigins(authority, committedOrigins, lease);
      if (!bound.ok) {
        return { ok: false as const, response: durableClearProjectionFailure(
          clearProjectionFailure(bound.code, bound.message),
        ) };
      }
      const discovered = await clearProjectionStore.completeSubjectDiscovery(authority, lease);
      if (!discovered.ok) {
        return { ok: false as const, response: durableClearProjectionFailure(
          clearProjectionFailure(discovered.code, discovered.message),
        ) };
      }
      return {
        ok: true as const,
        authority,
        canonical: canonical.value,
        committedOrigins,
        currentTargets: discovered.value.targets.filter((target) =>
          target.state === "pending" || target.state === "delivered"
        ),
      };
    });
    if (!setup.ok) return setup.response;
    const { authority, canonical, committedOrigins, currentTargets } = setup;
    if (!await removeSessionMetadataDiagnosticsForOrigins(
      committedOrigins.map((origin) => origin.origin),
    )) {
      return durableClearProjectionFailure(failure(
        "STORAGE_ERROR",
        "Capture diagnostics cleanup is pending durable recovery.",
      ));
    }
    const acknowledgements = await Promise.all(currentTargets.map((target) =>
      deliverClearProjectionTarget({
        ...target,
        authority,
        originAfterEpoch: committedOrigins.find((origin) =>
          origin.origin === target.subject.origin
        )!.originAfterEpoch,
      })
    ));
    if (acknowledgements.some((accepted) => !accepted)) {
      return durableClearProjectionFailure(
        failure(
          "CONTENT_UNAVAILABLE",
          "Page markers are still pending exact zero-marker acknowledgement.",
        ),
      );
    }
    const finalized = await finalizeClearProjectionOperation(authority);
    if (!finalized) {
      return durableClearProjectionFailure(
        failure("STORAGE_ERROR", "Clear completion could not be finalized durably."),
      );
    }
    if (canonical.origins.some((origin) => origin.canonical === "conflict")) {
      return failure("STALE_SESSION", "Some page origins changed before they could be cleared.");
    }
    const readback = await readAuthoritativeSession(primaryOrigin);
    return readback.ok ? { ok: true, data: readback.value } : failureFromStore(readback);
    } finally {
      activeClearCanonicalMutationOperationIds.delete(operationId);
    }
  }

  function collectLiveClearProjectionTargets(
    readback: ActiveSessionReadback,
    tabId: number,
    frames: Array<{
      frameId: number;
      documentId: string;
      origin: string;
      pathname: string;
    }>,
  ): LiveClearTarget[] {
    const records = readback.file
      ? readback.file.session.attachments.map((item) => item.sourceRecord as OriginCaptureRecord)
      : readback.legacyRecord ? [readback.legacyRecord] : [];
    const removedItemIds = readback.file
      ? readback.file.session.attachments.map((item) => item.id)
      : readback.legacyRecord ? [readback.legacyRecord.attachment.id] : [];
    const targets = new Map<string, LiveClearTarget>();
    for (const record of records) {
      if (record.tabId !== tabId || record.origin !== readback.origin) continue;
      const frame = frames.find((candidate) =>
        candidate.frameId === (record.frameId ?? 0) &&
        candidate.origin === record.origin &&
        routeKeyFromUrl(record.pageUrl ?? undefined) ===
          `${candidate.origin}${candidate.pathname}`
      );
      if (!frame) continue;
      const subject: ClearProjectionSubject = {
        tabId,
        frameId: frame.frameId,
        documentId: frame.documentId,
        origin: frame.origin,
        pathname: frame.pathname,
      };
      targets.set(clearProjectionSubjectKey(subject), {
        subject,
        removedItemIds: [...new Set(removedItemIds)].sort(),
      });
    }
    return [...targets.values()];
  }

  async function reconcileClearProjectionAfterCanonicalFailure(
    operationId: string,
  ): Promise<CaptureClearOperationV1 | null> {
    const canonical = await store.listClearOperations();
    if (!canonical.ok) {
      await rescheduleClearProjectionAlarm();
      return null;
    }
    const operation = canonical.value.find((candidate) =>
      candidate.operationId === operationId
    );
    if (!operation) return null;
    if (!operation.origins.some((origin) => origin.canonical === "pending")) {
      return operation;
    }
    const resumed = await store.clearOrigins({
      operationId: operation.operationId,
      origins: operation.origins.map((origin) => ({
        origin: origin.origin,
        epoch: origin.beforeEpoch,
      })),
    });
    if (!resumed.ok) await rescheduleClearProjectionAlarm();
    return resumed.ok ? resumed.value : null;
  }

  function requestClearProjectionDrain(): Promise<void> {
    clearProjectionDrainRequested = true;
    if (clearProjectionDrainTask) return clearProjectionDrainTask;
    clearProjectionDrainTask = (async () => {
      clearProjectionDrainRequested = false;
      const pending = await clearProjectionStore.listPending(Date.now());
      if (!pending.ok) {
        scheduleConservativeClearProjectionRetry();
        return;
      }
      const batch = pending.value.slice(0, CLEAR_PROJECTION_MAX_DRAIN_TARGETS);
      if (pending.value.length > batch.length) clearProjectionDrainRequested = true;
      const results = await Promise.all(batch.map(async (target) => ({
        target,
        accepted: await deliverClearProjectionTarget(target),
      })));
      const completedAuthorities = new Map<string, ClearProjectionAuthorityReference>();
      for (const result of results) {
        if (!result.accepted) continue;
        completedAuthorities.set(
          `${result.target.authority.authorityId}:${result.target.authority.generation}`,
          result.target.authority,
        );
      }
      for (const authority of completedAuthorities.values()) {
        await finalizeClearProjectionOperation(authority);
      }
      await rescheduleClearProjectionAlarm();
    })().catch(() => {
      scheduleConservativeClearProjectionRetry();
    }).finally(() => {
      clearProjectionDrainTask = null;
      if (clearProjectionDrainRequested) void requestClearProjectionDrain();
    });
    return clearProjectionDrainTask;
  }

  async function rescheduleClearProjectionAlarm(): Promise<void> {
    const authorityGeneration = ++clearProjectionAlarmAuthorityGeneration;
    const operations = await clearProjectionStore.listOperations();
    if (!operations.ok) {
      scheduleConservativeClearProjectionRetry();
      return;
    }
    let earliest: number | null = null;
    for (const operation of operations.value) {
      let operationRetryAt: number | null = operation.authority
        ? Date.now() + CLEAR_PROJECTION_RETRY_DELAY_MS
        : null;
      if (!operation.authority) {
        const retryAt = Date.now() + CLEAR_PROJECTION_RETRY_DELAY_MS;
        earliest = earliest === null ? retryAt : Math.min(earliest, retryAt);
        continue;
      }
      for (const target of operation.targets) {
        if (target.state !== "pending" && target.state !== "delivered") continue;
        operationRetryAt = operationRetryAt === null
          ? target.nextAttemptAt
          : Math.min(operationRetryAt, target.nextAttemptAt);
      }
      if (operationRetryAt !== null) {
        earliest = earliest === null ? operationRetryAt : Math.min(earliest, operationRetryAt);
      }
    }
    if (earliest === null) {
      await applyClearProjectionAlarmDecision(authorityGeneration, null);
      return;
    }
    await applyClearProjectionAlarmDecision(authorityGeneration, earliest);
  }

  function scheduleConservativeClearProjectionRetry(): void {
    const authorityGeneration = ++clearProjectionAlarmAuthorityGeneration;
    const retryAt = Date.now() + CLEAR_PROJECTION_RETRY_DELAY_MS;
    void applyClearProjectionAlarmDecision(authorityGeneration, retryAt).catch(() => undefined);
  }

  function applyClearProjectionAlarmDecision(
    authorityGeneration: number,
    retryAt: number | null,
  ): Promise<void> {
    const applyDecision = async () => {
      if (authorityGeneration !== clearProjectionAlarmAuthorityGeneration) return;
      if (retryAt === null) {
        await chrome.alarms.clear(UI_ATTACH_CLEAR_PROJECTION_RETRY_ALARM);
        return;
      }
      chrome.alarms.create(UI_ATTACH_CLEAR_PROJECTION_RETRY_ALARM, {
        delayInMinutes: Math.max(0, retryAt - Date.now()) / 60_000,
      });
    };
    const mutation = clearProjectionAlarmMutationTail.then(applyDecision, applyDecision);
    clearProjectionAlarmMutationTail = mutation.catch(() => undefined);
    return mutation;
  }

  function durableClearProjectionFailure(
    response: Extract<SessionCommandResponse<never>, { ok: false }>,
  ): Extract<SessionCommandResponse<never>, { ok: false }> {
    scheduleConservativeClearProjectionRetry();
    return response;
  }

  function reconcileClearProjectionJournal(): Promise<void> {
    clearProjectionReconcileRequested = true;
    if (clearProjectionReconcileTask) return clearProjectionReconcileTask;
    clearProjectionReconcileTask = (async () => {
      while (clearProjectionReconcileRequested) {
        clearProjectionReconcileRequested = false;
        if (!(await storageAccessReady)) {
          scheduleConservativeClearProjectionRetry();
          continue;
        }
        const journal = await clearProjectionStore.listOperations();
        const canonical = await store.listClearOperations();
        if (!journal.ok || !canonical.ok) {
          scheduleConservativeClearProjectionRetry();
          continue;
        }
        for (const operation of journal.value) {
          if (activeClearCanonicalMutationOperationIds.has(operation.operationId)) continue;
          await withClearProjectionOperationLease(operation.operationId, async (lease) => {
            const currentJournal = await clearProjectionStore.listOperations();
            const currentCanonical = await store.listClearOperations();
            if (!currentJournal.ok || !currentCanonical.ok) {
              scheduleConservativeClearProjectionRetry();
              return;
            }
            let current = currentJournal.value.find((candidate) =>
              candidate.operationId === operation.operationId
            );
            if (!current) return;
            const barrierAttempt = currentClearActionBarrierAttempt(current.operationId);
            let canonicalOperation = currentCanonical.value.find((candidate) =>
              candidate.operationId === current!.operationId
            );
            if (!canonicalOperation) {
              if (current.authority === null) {
                if (!current.request) return;
                const contextGenerationAtEndpointRead = clearPageContextGeneration;
                const endpointWasReplaced = await exactClearProjectionEndpointWasReplaced(
                  current.request.endpoint,
                );
                if (!endpointWasReplaced ||
                    !clearPageContextGenerationIsCurrent(contextGenerationAtEndpointRead)) return;
                const retired = await retireExactUnboundClearProjection(
                  current,
                  lease,
                  contextGenerationAtEndpointRead,
                );
                if (retired === "retired") removeClearActionBarrier(barrierAttempt);
                else if (retired === "fault") scheduleConservativeClearProjectionRetry();
                return;
              }
              if (current.subjectDiscovery !== "complete" || current.targets.some((target) =>
                target.state !== "acknowledged" && target.state !== "superseded"
              )) {
                scheduleConservativeClearProjectionRetry();
                return;
              }
              const removed = await clearProjectionStore.removeOperation(current.authority, lease);
              if (removed.ok) removeClearActionBarrier(barrierAttempt);
              else scheduleConservativeClearProjectionRetry();
              return;
            }
            if (canonicalOperation.origins.some((origin) => origin.canonical === "pending")) {
              if (!current.request) {
                scheduleConservativeClearProjectionRetry();
                return;
              }
              const resumed = await store.clearOrigins({
                operationId: canonicalOperation.operationId,
                origins: canonicalOperation.origins.map((origin) => ({
                  origin: origin.origin,
                  epoch: origin.beforeEpoch,
                })),
              });
              if (!resumed.ok || !await exactClearProjectionOperationIsCurrent(current)) {
                scheduleConservativeClearProjectionRetry();
                return;
              }
              canonicalOperation = resumed.value;
            }
            if (canonicalOperation.origins.some((origin) => origin.canonical === "pending")) return;
            const authority = clearProjectionAuthority(canonicalOperation);
            const committedOrigins = canonicalOperation.origins
              .filter((origin) => origin.canonical === "committed")
              .map((origin) => ({
                origin: origin.origin,
                originAfterEpoch: origin.afterEpoch,
              }));
            if (committedOrigins.length === 0) {
              const finalized = await store.finalizeClearOperation(authority);
              if (!finalized.ok || !await exactClearProjectionOperationIsCurrent(current)) {
                scheduleConservativeClearProjectionRetry();
                return;
              }
              const removed = await clearProjectionStore.removeOperation(
                current.authority ?? current.operationId,
                lease,
              );
              if (removed.ok) removeClearActionBarrier(barrierAttempt);
              else scheduleConservativeClearProjectionRetry();
              return;
            }
            if (current.authority === null) {
              const bound = await clearProjectionStore.commitOrigins(
                authority,
                committedOrigins,
                lease,
              );
              if (!bound.ok) {
                scheduleConservativeClearProjectionRetry();
                return;
              }
              current = bound.value;
              if (current.subjectDiscovery === "pending") return;
            } else if (current.authority.authorityId !== authority.authorityId ||
                current.authority.generation !== authority.generation) {
              scheduleConservativeClearProjectionRetry();
              return;
            }
            await finalizeClearProjectionOperation(authority, lease);
          });
        }
        await requestClearProjectionDrain();
      }
    })().catch(() => {
      scheduleConservativeClearProjectionRetry();
    }).finally(() => {
      clearProjectionReconcileTask = null;
      if (clearProjectionReconcileRequested) void reconcileClearProjectionJournal();
    });
    return clearProjectionReconcileTask;
  }

  async function replaceClearProjectionTargetsForLiveSubject(
    subject: ClearProjectionSubject,
  ): Promise<void> {
    const operations = await clearProjectionStore.listOperations();
    if (!operations.ok) return;
    let changed = false;
    for (const snapshot of operations.value) {
      await withClearProjectionOperationLease(snapshot.operationId, async (lease) => {
        const currentOperations = await clearProjectionStore.listOperations();
        if (!currentOperations.ok) return;
        const operation = currentOperations.value.find((candidate) =>
          candidate.operationId === snapshot.operationId
        );
        if (!operation?.authority) return;
        for (const target of operation.targets) {
          if ((target.state !== "pending" && target.state !== "delivered") ||
              target.subject.tabId !== subject.tabId ||
              target.subject.frameId !== subject.frameId ||
              sameClearProjectionSubject(target.subject, subject)) continue;
          const committed = operation.origins.find((origin) =>
            origin.origin === target.subject.origin
          );
          if (!committed) continue;
          let transitioned = false;
          if (target.subject.origin === subject.origin && target.revision < Number.MAX_SAFE_INTEGER) {
            const replaced = await clearProjectionStore.replaceTarget(operation.authority, {
              previous: {
                subject: { ...target.subject },
                projectionId: target.projectionId,
                revision: target.revision,
              },
              target: {
                subject: { ...subject },
                removedItemIds: [...target.removedItemIds],
                projectionId: crypto.randomUUID(),
                revision: target.revision + 1,
                nextAttemptAt: Date.now(),
              },
            }, lease);
            transitioned = replaced.ok;
          } else if (target.subject.origin !== subject.origin) {
            const superseded = await clearProjectionStore.supersede(operation.authority, {
              subject: { ...target.subject },
              projectionId: target.projectionId,
              revision: target.revision,
            }, lease);
            transitioned = superseded.ok;
          }
          if (!transitioned) continue;
          changed = true;
          const oldReference: ClearProjectionReference = {
            version: UI_ATTACH_CLEAR_PROJECTION_VERSION,
            authorityId: operation.authority.authorityId,
            operationId: operation.authority.operationId,
            generation: operation.authority.generation,
            origin: target.subject.origin,
            afterEpoch: committed.originAfterEpoch,
            subject: { ...target.subject },
            projectionId: target.projectionId,
            revision: target.revision,
          };
          clearProjectionAckWaiters.get(clearProjectionReferenceKey(oldReference))?.settle(false);
        }
        await finalizeClearProjectionOperation(operation.authority, lease);
      });
    }
    if (changed) void requestClearProjectionDrain();
  }

  async function deliverClearProjectionTarget(
    target: PendingClearProjection,
  ): Promise<boolean> {
    const clear: ClearProjectionReference = {
      version: UI_ATTACH_CLEAR_PROJECTION_VERSION,
      authorityId: target.authority.authorityId,
      operationId: target.authority.operationId,
      generation: target.authority.generation,
      origin: target.subject.origin,
      afterEpoch: target.originAfterEpoch,
      subject: { ...target.subject },
      projectionId: target.projectionId,
      revision: target.revision,
    };
    const key = clearProjectionReferenceKey(clear);
    const existing = clearProjectionAckWaiters.get(key);
    if (existing) return await waitForClearProjectionAck(existing.completion);
    const waiter = createClearProjectionAckWaiter();
    clearProjectionAckWaiters.set(key, waiter);
    try {
      const delivered = await clearProjectionStore.markDelivered(target.authority, {
        subject: { ...target.subject },
        projectionId: target.projectionId,
        revision: target.revision,
        expectedAttemptCount: target.attemptCount,
        nextAttemptAt: Date.now() + CLEAR_PROJECTION_RETRY_DELAY_MS,
      });
      waiter.markDeliveryReady();
      if (!delivered.ok) {
        waiter.settle(false);
        return false;
      }
      let contentReady = false;
      try {
        contentReady = await ensureContentScript(
          target.subject.tabId,
          target.subject.frameId,
          target.subject.documentId,
        );
      } catch {
        contentReady = false;
      }
      if (!contentReady || !await isCurrentOverlayActionEndpoint(
        {
          tabId: target.subject.tabId,
          frameId: target.subject.frameId,
          documentId: target.subject.documentId,
        },
        target.subject.origin,
        target.subject.pathname,
      )) {
        waiter.settle(false);
        return false;
      }
      try {
        await chrome.tabs.sendMessage(target.subject.tabId, {
          type: UI_ATTACH_CLEAR_PROJECTION,
          clear,
        }, {
          frameId: target.subject.frameId,
          documentId: target.subject.documentId,
        });
      } catch {
        waiter.settle(false);
        return false;
      }
      return await waitForClearProjectionAck(waiter.completion);
    } finally {
      if (clearProjectionAckWaiters.get(key) === waiter) {
        clearProjectionAckWaiters.delete(key);
      }
    }
  }

  async function waitForClearProjectionAck(completion: Promise<boolean>): Promise<boolean> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        completion,
        new Promise<boolean>((resolve) => {
          timer = setTimeout(() => resolve(false), CLEAR_PROJECTION_ACK_TIMEOUT_MS);
        }),
      ]);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }

  async function finalizeClearProjectionOperation(
    authority: ClearProjectionAuthorityReference,
    lease?: ClearProjectionOperationLease,
  ): Promise<boolean> {
    if (!lease) {
      return withClearProjectionOperationLease(authority.operationId, (acquiredLease) =>
        finalizeClearProjectionOperation(authority, acquiredLease)
      );
    }
    if (!await ensureClearActionBarriersLoaded()) return false;
    const barrierAttempt = currentClearActionBarrierAttempt(authority.operationId);
    const operations = await clearProjectionStore.listOperations();
    if (!operations.ok) return false;
    const operation = operations.value.find((candidate) =>
      candidate.operationId === authority.operationId &&
      candidate.authority?.authorityId === authority.authorityId &&
      candidate.authority.generation === authority.generation
    );
    if (!operation) {
      const canonical = await store.listClearOperations();
      return canonical.ok && !canonical.value.some((candidate) =>
        candidate.operationId === authority.operationId
      );
    }
    if (operation.subjectDiscovery !== "complete" ||
        operation.targets.some((target) =>
          target.state !== "acknowledged" && target.state !== "superseded"
        )) return false;
    const finalized = await store.finalizeClearOperation(authority);
    if (!finalized.ok) {
      if (finalized.code !== "ITEM_NOT_FOUND") return false;
      const canonical = await store.listClearOperations();
      if (!canonical.ok || canonical.value.some((candidate) =>
        candidate.operationId === authority.operationId
      )) return false;
    }
    if (!await exactClearProjectionOperationIsCurrent(operation)) return false;
    const removed = await clearProjectionStore.removeOperation(authority, lease);
    if (removed.ok) {
      removeClearActionBarrier(barrierAttempt);
      await rescheduleClearProjectionAlarm();
    }
    return removed.ok;
  }

  function clearProjectionFailure(
    code: string,
    message: string,
  ): Extract<SessionCommandResponse<never>, { ok: false }> {
    if (code === "LIMIT_EXCEEDED") return failure("SESSION_FULL", message);
    if (code === "STORAGE_ERROR" || code === "INVALID_STORAGE") {
      return failure("STORAGE_ERROR", "Clear recovery storage is temporarily unavailable.");
    }
    return failure("STALE_SESSION", message);
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
    replaceItemId: string | null,
    sender: UiAttachChromeMessageSender,
  ): Promise<SessionCommandResponse<RuntimeCaptureToken>> {
    return await coordinateElementSelectionCaptureMutation(() =>
      beginRuntimeCaptureMutation(origin, replaceItemId, sender)
    );
  }

  async function beginRuntimeCaptureMutation(
    origin: string,
    replaceItemId: string | null,
    sender: UiAttachChromeMessageSender,
  ): Promise<SessionCommandResponse<RuntimeCaptureToken>> {
    invalidateAllRuntimeCaptureLeases();
    const routeLeaseGeneration = captureRouteLeaseGeneration;
    const routeLease = await resolveRuntimeCaptureRouteLease(sender);
    if (
      routeLease === null ||
      routeLeaseGeneration !== captureRouteLeaseGeneration ||
      !hasElementSelectionLease(sender)
    ) {
      return failure(
        "STALE_CAPTURE_OPERATION",
        "Capture operation does not match the active page route.",
      );
    }
    let verifiedReplacement: CaptureToken["replacement"] = null;
    if (replaceItemId !== null) {
      const selectedRoute = routeLease.segments.at(-1)!;
      const read = await store.read(origin);
      if (!read.ok) return failureFromStore(read);
      const item = read.value.file?.session.attachments.find(
        (candidate) => candidate.id === replaceItemId,
      );
      if (!item) return failure("ITEM_NOT_FOUND", "Capture session item was not found.");
      const storedRecord = item.sourceRecord as OriginCaptureRecord;
      if (
        selectedRoute.origin !== origin ||
        originFromUrl(storedRecord.pageUrl ?? undefined) !== origin ||
        selectedRoute.pathname !== pathnameFromUrl(storedRecord.pageUrl ?? undefined)
      ) {
        return failure(
          "STALE_CAPTURE_OPERATION",
          "Capture replacement does not match the active page route.",
        );
      }
      const liveRouteChain = routeLease.segments.map(({ origin, pathname }) => ({
        origin,
        pathname,
      }));
      if (!storedCaptureRouteChainMatchesLive(storedRecord, liveRouteChain)) {
        return failure(
          "STALE_CAPTURE_OPERATION",
          "Capture replacement does not match the active frame route.",
        );
      }
      const annotationId = sessionItemAnnotationId(read.value.file, item.id);
      verifiedReplacement = {
        itemId: item.id,
        annotationId,
        createdAt: item.createdAt,
        capturedAt: item.sourceRecord.capturedAt,
      };
    }
    const begun = await store.beginCapture(origin, replaceItemId);
    if (!begun.ok) return failureFromStore(begun);
    if (
      routeLeaseGeneration !== captureRouteLeaseGeneration ||
      !hasElementSelectionLease(sender)
    ) {
      return failure(
        "STALE_CAPTURE_OPERATION",
        "Capture operation does not match the active page route.",
      );
    }
    if (
      verifiedReplacement !== null &&
      !sameCaptureReplacement(begun.value.replacement, verifiedReplacement)
    ) {
      return failure(
        "STALE_CAPTURE_OPERATION",
        "Capture replacement changed after route validation.",
      );
    }
    const diagnosticsArm = elementSelectionBasicDiagnosticsArm;
    const collectBasicDiagnostics = diagnosticsArm !== null &&
      diagnosticsArm.selectionRevision === elementSelectionRevision &&
      diagnosticsArm.selectionGeneration === elementSelectionAuthorityGeneration;
    if (diagnosticsArm !== null && !collectBasicDiagnostics) {
      elementSelectionBasicDiagnosticsArm = null;
    }
    const token: RuntimeCaptureToken = {
      ...begun.value,
      routeLease,
      ...(collectBasicDiagnostics ? { collectBasicDiagnostics: true as const } : {}),
    };
    activeRuntimeCaptureLeases.set(token.operationId, { current: true, token });
    if (collectBasicDiagnostics) elementSelectionBasicDiagnosticsArm = null;
    return { ok: true, data: token };
  }

  async function resolveRuntimeCaptureRouteLease(
    sender: UiAttachChromeMessageSender,
  ): Promise<RuntimeCaptureRouteLease | null> {
    const tabId = contentTabIdFromSender(sender);
    const selectedFrameId = contentFrameIdFromSender(sender);
    if (
      tabId === null ||
      selectedFrameId === null ||
      !sender.documentId
    ) return null;
    const hasDeclaredTopRoute = elementSelectionTopOrigin !== null &&
      elementSelectionTopPathname !== null;
    const hasNoDeclaredTopRoute = elementSelectionTopOrigin === null &&
      elementSelectionTopPathname === null;
    if (!hasDeclaredTopRoute && !hasNoDeclaredTopRoute) return null;
    if (selectedFrameId !== 0 && !hasDeclaredTopRoute) return null;

    let frames: UiAttachChromeFrame[] | undefined;
    try {
      frames = await chrome.webNavigation.getAllFrames({ tabId });
    } catch {
      frames = undefined;
    }
    let segments = frames
      ? runtimeCaptureRouteSegmentsFromFrames(frames, selectedFrameId)
      : null;
    if (segments === null && selectedFrameId === 0) {
      let topFrame: UiAttachChromeFrameDetails | undefined;
      try {
        topFrame = await chrome.webNavigation.getFrame({ tabId, frameId: 0 });
      } catch {
        topFrame = undefined;
      }
      const origin = originFromUrl(topFrame?.url);
      const pathname = pathnameFromUrl(topFrame?.url);
      if (
        topFrame?.parentFrameId === -1 &&
        topFrame.documentId === sender.documentId &&
        origin !== null &&
        pathname !== null
      ) {
        segments = [{
          frameId: 0,
          documentId: sender.documentId,
          origin,
          pathname,
        }];
      }
    }
    const selected = segments?.at(-1);
    const top = segments?.[0];
    const expectedTopOrigin = hasDeclaredTopRoute ? elementSelectionTopOrigin : top?.origin ?? null;
    const expectedTopPathname = hasDeclaredTopRoute
      ? elementSelectionTopPathname
      : top?.pathname ?? null;
    const selectedOrigin = selectedFrameId === 0
      ? expectedTopOrigin
      : elementSelectionFrameOrigin;
    const selectedPathname = selectedFrameId === 0
      ? expectedTopPathname
      : elementSelectionFramePathname;
    if (
      !segments ||
      !selected ||
      !top ||
      expectedTopOrigin === null ||
      expectedTopPathname === null ||
      selectedOrigin === null ||
      selectedPathname === null ||
      top.frameId !== 0 ||
      top.origin !== expectedTopOrigin ||
      top.pathname !== expectedTopPathname ||
      selected.frameId !== selectedFrameId ||
      selected.documentId !== sender.documentId ||
      selected.origin !== selectedOrigin ||
      selected.pathname !== selectedPathname
    ) return null;
    return {
      epoch: crypto.randomUUID(),
      tabId,
      selectedFrameId,
      segments,
    };
  }

  async function commitRuntimeCapture(
    command: Extract<SessionCommand, { type: "ui-attach:session-commit-capture" }>,
    senderOrigin: string,
    sender: UiAttachChromeMessageSender,
  ): Promise<SessionCommandResponse<CaptureCommitReceipt>> {
    if (command.token.origin !== senderOrigin || command.record.origin !== senderOrigin) {
      return failure("STALE_CAPTURE_OPERATION", "Capture operation origin does not match the sender.");
    }
    const activeCaptureLease = activeRuntimeCaptureLeases.get(command.token.operationId);
    if (
      !activeCaptureLease?.current ||
      !sameRuntimeCaptureToken(activeCaptureLease.token, command.token) ||
      !runtimeCaptureRouteLeaseMatchesSender(command.token.routeLease, sender) ||
      !await runtimeCaptureRouteLeaseIsLive(command.token.routeLease, sender)
    ) {
      return failure(
        "STALE_CAPTURE_OPERATION",
        "Capture operation does not match the active page route.",
      );
    }
    const selectedRoute = command.token.routeLease.segments.at(-1);
    if (
      !selectedRoute ||
      originFromUrl(command.record.pageUrl ?? undefined) !== selectedRoute.origin ||
      pathnameFromUrl(command.record.pageUrl ?? undefined) !== selectedRoute.pathname
    ) {
      return failure(
        "STALE_CAPTURE_OPERATION",
        "Capture record does not match its route lease.",
      );
    }
    const selectionRevisionAtCommit = elementSelectionRevision;
    const stopAfterCommit = elementSelectionMode === "single";
    let routeAuthorityCurrent = true;
    const captureIsCurrent = (): boolean => (
      routeAuthorityCurrent &&
      activeCaptureLease.current &&
      activeRuntimeCaptureLeases.get(command.token.operationId) === activeCaptureLease &&
      selectionRevisionAtCommit === elementSelectionRevision &&
      hasElementSelectionLease(sender)
    );
    const captureAuthority = {
      isCurrent: captureIsCurrent,
      refresh: async () => {
        if (!captureIsCurrent()) return false;
        if (!await runtimeCaptureRouteLeaseIsLive(command.token.routeLease, sender)) {
          routeAuthorityCurrent = false;
          return false;
        }
        return captureIsCurrent();
      },
      beforeWrite: async () => {
        await options.captureCommitGate?.beforeWrite(command.token.operationId);
      },
    };

    const routeChain: CaptureRouteSegmentV1[] = command.token.routeLease.segments.map(
      ({ origin, pathname }) => ({ origin, pathname }),
    );
    let hasExistingReceipt = false;
    if (command.token.replacement !== null) {
      const inspection = await store.inspectCapture(senderOrigin, command.token.operationId);
      if (!inspection.ok) return failureFromStore(inspection);
      const receiptItemId = inspection.value.receiptItemId;
      if (receiptItemId !== null) {
        if (receiptItemId !== command.token.replacement.itemId) {
          return failure(
            "STALE_CAPTURE_OPERATION",
            "Capture receipt belongs to a different session item.",
          );
        }
        hasExistingReceipt = true;
      }
      const item = inspection.value.readback.file?.session.attachments.find(
        (candidate) => candidate.id === command.token.replacement?.itemId,
      );
      if (!hasExistingReceipt) {
        if (!item) return failure("ITEM_NOT_FOUND", "Capture session item was not found.");
        const annotationId = sessionItemAnnotationId(
          inspection.value.readback.file,
          item.id,
        );
        if (!sameCaptureReplacement(command.token.replacement, {
          itemId: item.id,
          annotationId,
          createdAt: item.createdAt,
          capturedAt: item.sourceRecord.capturedAt,
        })) {
          return failure(
            "STALE_CAPTURE_OPERATION",
            "Capture replacement belongs to a stale item version.",
          );
        }
        const storedRecord = item.sourceRecord as OriginCaptureRecord;
        const storedPathname = pathnameFromUrl(storedRecord.pageUrl ?? undefined);
        if (
          selectedRoute.origin !== senderOrigin ||
          originFromUrl(storedRecord.pageUrl ?? undefined) !== senderOrigin ||
          originFromUrl(command.record.pageUrl ?? undefined) !== senderOrigin ||
          storedPathname === null ||
          selectedRoute.pathname !== storedPathname ||
          pathnameFromUrl(command.record.pageUrl ?? undefined) !== storedPathname
        ) {
          return failure(
            "STALE_CAPTURE_OPERATION",
            "Capture replacement does not match the active page route.",
          );
        }
        if (!storedCaptureRouteChainMatchesLive(storedRecord, routeChain)) {
          return failure(
            "STALE_CAPTURE_OPERATION",
            "Capture replacement does not match the active frame route.",
          );
        }
      }
    }
    const record: OriginCaptureRecord = {
      ...command.record,
      ...(sender.tab?.id !== undefined ? { tabId: sender.tab.id } : {}),
      frameId: sender.frameId ?? 0,
      routeChain,
    };
    const committed = await store.commitCapture(command.token, record, captureAuthority);
    if (!committed.ok) return failureFromStore(committed);
    try {
      await replaceSessionMetadataDiagnostics(
        senderOrigin,
        committed.value.readback,
        committed.value.itemId,
        command.record.capturedAt,
        command.token.collectBasicDiagnostics === true
          ? command.metadataDiagnosticsDevice
          : undefined,
      );
    } catch {
      // Diagnostics are optional metadata. The canonical capture remains
      // authoritative, while exact fingerprint reads suppress any stale entry.
    }
    const committedIndex = (committed.value.readback.file?.session.attachments ?? [])
      .findIndex((item) => item.id === committed.value.itemId);
    const annotationLabel = committedIndex >= 0
      ? formatAnnotationLabel(committedIndex)
      : annotationLabelFromSessionLabel(committed.value.label);
    if (annotationLabel === null) {
      return failure("CAPTURE_FAILED", "Capture commit readback is incomplete.");
    }
    if (options.captureCommitGate) {
      try {
        await options.captureCommitGate.afterWrite(command.token.operationId);
      } catch {
        // The canonical write already succeeded. A development-only barrier
        // failure may suppress publication, but it must not report the durable
        // capture as failed.
        return captureCommitResponse(command, committed.value.itemId, annotationLabel);
      }
    }
    if (!await captureAuthority.refresh()) {
      return captureCommitResponse(command, committed.value.itemId, annotationLabel);
    }
    const senderTabId = contentTabIdFromSender(sender);
    const senderFrameId = contentFrameIdFromSender(sender);
    // MessageSender.url can retain the document's original URL across
    // history.pushState(). The captured record reflects the live page route;
    // collectLiveReboundOverlayGroup still verifies it against frame inventory
    // before creating an exact-document projection.
    const senderPathname = pathnameFromUrl(command.record.pageUrl ?? sender.url);
    const liveContext: ActivePageContext | undefined =
      senderTabId !== null && senderFrameId !== null && senderPathname !== null
        ? {
            tabId: senderTabId,
            frameId: senderFrameId,
            origin: senderOrigin,
            pathname: senderPathname,
            ...(sender.documentId ? { documentId: sender.documentId } : {}),
          }
        : undefined;
    if (captureAuthority.isCurrent()) {
      await syncOverlaySession(
        committed.value.readback,
        committed.value.itemId,
        null,
        liveContext,
        captureAuthority,
      );
      if (!await captureAuthority.refresh()) {
        return captureCommitResponse(command, committed.value.itemId, annotationLabel);
      }
      await publishSessionUpdated(
        command.record.origin,
        committed.value.itemId,
        captureAuthority,
      );
      if (!await captureAuthority.refresh()) {
        return captureCommitResponse(command, committed.value.itemId, annotationLabel);
      }
      const widgetLease = [...inPageWidgetLeasesBySurfaceId.values()].find((lease) =>
        lease.tabId === sender.tab?.id
      );
      if (widgetLease) await reconcileWidgetSession(widgetLease, captureAuthority);
      if (stopAfterCommit && captureAuthority.isCurrent()) {
        await revokeElementSelectionLease();
      }
    }
    return captureCommitResponse(command, committed.value.itemId, annotationLabel);
  }

  function captureCommitResponse(
    command: Extract<SessionCommand, { type: "ui-attach:session-commit-capture" }>,
    itemId: string,
    annotationLabel: string,
  ): SessionCommandResponse<CaptureCommitReceipt> {
    return {
      ok: true,
      data: {
        origin: command.record.origin,
        epoch: command.token.epoch,
        itemId,
        annotationLabel,
      },
    };
  }

  async function runtimeCaptureRouteLeaseIsLive(
    lease: RuntimeCaptureRouteLease,
    sender: UiAttachChromeMessageSender,
  ): Promise<boolean> {
    let frames: UiAttachChromeFrame[] | undefined;
    try {
      frames = await chrome.webNavigation.getAllFrames({ tabId: lease.tabId });
    } catch {
      frames = undefined;
    }
    const liveSegments = frames
      ? runtimeCaptureRouteSegmentsFromFrames(frames, lease.selectedFrameId)
      : null;
    if (liveSegments) return sameRuntimeCaptureRouteSegments(liveSegments, lease.segments);
    if (lease.selectedFrameId !== 0 || lease.segments.length !== 1) return false;
    const only = lease.segments[0]!;
    let topFrame: UiAttachChromeFrameDetails | undefined;
    try {
      topFrame = await chrome.webNavigation.getFrame({ tabId: lease.tabId, frameId: 0 });
    } catch {
      topFrame = undefined;
    }
    return sender.documentId === only.documentId &&
      topFrame?.parentFrameId === -1 &&
      topFrame.documentId === only.documentId &&
      originFromUrl(topFrame.url) === only.origin &&
      pathnameFromUrl(topFrame.url) === only.pathname;
  }

  async function syncOverlaySession(
    readback: ActiveSessionReadback,
    activeItemId: string | null,
    previousReadback: ActiveSessionReadback | null = null,
    liveContext?: ActivePageContext,
    authority?: OverlaySyncAuthority,
  ): Promise<void> {
    await enqueueOverlayOperation(readback.origin, async () => {
      if (authority && !authority.isCurrent()) return;
      const activeItemTransition = await rememberActiveOverlayItem(readback, activeItemId);
      try {
        if (!await refreshOverlaySyncAuthority(authority)) return;
        for (let attempt = 0; attempt < LIVE_CAPTURE_OVERLAY_SYNC_ATTEMPTS; attempt += 1) {
          const delivery = await performOverlaySync(
            readback,
            activeItemId,
            previousReadback,
            false,
            liveContext,
            liveContext ? activeItemId : undefined,
            authority,
          );
          if (!await refreshOverlaySyncAuthority(authority)) return;
          if (!liveContext || delivery.acknowledged + delivery.pending > 0) return;
          if (attempt + 1 < LIVE_CAPTURE_OVERLAY_SYNC_ATTEMPTS) {
            await new Promise<void>((resolve) => {
                setTimeout(resolve, LIVE_CAPTURE_OVERLAY_SYNC_RETRY_MS);
            });
            if (!await refreshOverlaySyncAuthority(authority)) return;
          }
        }
      } finally {
        if (authority && !authority.isCurrent()) {
          await restoreActiveOverlayItemIfCurrent(activeItemTransition);
        }
      }
    });
  }

  async function refreshOverlaySyncAuthority(
    authority: OverlaySyncAuthority | undefined,
  ): Promise<boolean> {
    if (!authority) return true;
    if (!authority.isCurrent()) return false;
    return authority.refresh ? await authority.refresh() : authority.isCurrent();
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

  async function performOverlaySyncPreservingActive(
    readback: ActiveSessionReadback,
    previousReadback: ActiveSessionReadback,
    liveContext: ActivePageContext,
  ): Promise<void> {
    await ensureActiveOverlayItemIdsLoaded();
    const activeItemId = resolveOverlayActiveItemId(
      (readback.file?.session.attachments ?? []).map((item) => item.id),
      activeOverlayItemIdsByOrigin.get(readback.origin) ?? null,
    );
    await rememberActiveOverlayItem(readback, activeItemId);
    await performOverlaySync(readback, activeItemId, previousReadback, false, liveContext);
  }

  async function rememberActiveOverlayItem(
    readback: ActiveSessionReadback,
    requestedItemId: string | null,
  ): Promise<ActiveOverlayItemTransition> {
    await ensureActiveOverlayItemIdsLoaded();
    const previous = activeOverlayItemIdsByOrigin.get(readback.origin) ?? null;
    const generation = (activeOverlayItemGenerationsByOrigin.get(readback.origin) ?? 0) + 1;
    activeOverlayItemGenerationsByOrigin.set(readback.origin, generation);
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
    return { current: activeItemId, generation, origin: readback.origin, previous };
  }

  async function restoreActiveOverlayItemIfCurrent(
    transition: ActiveOverlayItemTransition,
  ): Promise<void> {
    await ensureActiveOverlayItemIdsLoaded();
    if (activeOverlayItemGenerationsByOrigin.get(transition.origin) !== transition.generation) return;
    if ((activeOverlayItemIdsByOrigin.get(transition.origin) ?? null) !== transition.current) return;
    activeOverlayItemGenerationsByOrigin.set(transition.origin, transition.generation + 1);
    if (transition.previous === null) {
      activeOverlayItemIdsByOrigin.delete(transition.origin);
    } else {
      activeOverlayItemIdsByOrigin.delete(transition.origin);
      activeOverlayItemIdsByOrigin.set(transition.origin, transition.previous);
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

  async function persistActiveOverlayItemIds(): Promise<boolean> {
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
      return true;
    } catch {
      return false;
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
    liveContext?: ActivePageContext,
    exactLiveItemId?: string | null,
    authority?: OverlaySyncAuthority,
  ): Promise<OverlaySyncDelivery> {
    const emptyDelivery = (): OverlaySyncDelivery => ({ acknowledged: 0, pending: 0 });
    if (authority && !authority.isCurrent()) return emptyDelivery();
    const currentGroups = collectOverlayGroups(readback);
    let invalidLiveEndpointKey: string | null = null;
    if (includeLiveRebound || liveContext) {
      const liveResolution = await collectLiveReboundOverlayGroup(
        readback,
        liveContext,
        exactLiveItemId,
      );
      if (authority && !authority.isCurrent()) return emptyDelivery();
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

    const deliveredEndpoints = new Map<string, OverlayEndpoint>();
    const deliveries = await Promise.all(Array.from(endpoints.values(), async (endpoint) => {
      if (authority && !authority.isCurrent()) return null;
      const group = currentGroups.get(endpointKey(endpoint));
      const subject = await resolveOverlayProjectionSubject(endpoint, readback.origin);
      if (!subject) return null;
      if (group?.subject && !sameOverlayProjectionSubject(group.subject, subject)) return null;
      if (!group?.subject && authority && !authority.isCurrent()) return null;
      const authorityRouteChain = !group?.subject && authority
        ? subject.frameId === 0
          ? [{ origin: subject.origin, pathname: subject.pathname }]
          : await readLiveCaptureRouteChain(chrome, endpoint, subject.documentId)
        : null;
      if (!group?.subject && authority && (
        authorityRouteChain === null || !authority.isCurrent()
      )) return null;
      const items = (
        group?.subject
          ? group.items
          : authority
            ? collectAuthorityBoundOverlayItems(readback, subject, authorityRouteChain!)
            : group?.items ?? []
      ).slice(0, OVERLAY_RESTORE_MAX_ITEMS);
      const selected = resolveOverlayActiveItemId(
        items.map((item) => item.itemId),
        activeItemId,
      );
      const projection = await createOverlayProjection(
        readback,
        subject,
        items,
        selected,
        false,
        group?.subject ? undefined : authority,
      );
      if (!projection || (authority && !authority.isCurrent())) return null;
      const currentSubject = await resolveOverlayProjectionSubject({
        tabId: endpoint.tabId,
        frameId: endpoint.frameId,
        documentId: subject.documentId,
      }, readback.origin);
      if (!currentSubject || !sameOverlayProjectionSubject(currentSubject, subject) ||
          (group?.subject && !sameOverlayProjectionSubject(group.subject, currentSubject)) ||
          (authority && !authority.isCurrent())) return null;
      try {
        if (authority && !authority.isCurrent()) return null;
        await chrome.tabs.sendMessage(endpoint.tabId, {
          type: UI_ATTACH_OVERLAY_STATE,
          origin: readback.origin,
          projection: projection.projection,
          activeItemId: selected,
          items,
        }, {
          frameId: endpoint.frameId,
          documentId: subject.documentId,
        });
      } catch {
        // The pending projection survives for a later exact-document restore/ACK.
      }
      if (authority && !authority.isCurrent()) return null;
      deliveredEndpoints.set(endpointKey(endpoint), {
        tabId: endpoint.tabId,
        frameId: endpoint.frameId,
        documentId: subject.documentId,
      });
      return projection;
    }));

    if (authority && !authority.isCurrent()) return emptyDelivery();

    const currentEndpoints = new Map<string, OverlayEndpoint>();
    for (const group of currentGroups.values()) {
      const delivered = deliveredEndpoints.get(endpointKey(group.endpoint));
      if (delivered) currentEndpoints.set(endpointKey(delivered), delivered);
    }
    if (currentEndpoints.size > 0) {
      knownOverlayEndpointsByOrigin.set(readback.origin, currentEndpoints);
    } else {
      knownOverlayEndpointsByOrigin.delete(readback.origin);
    }
    overlayPreviewLeasesByOrigin.delete(readback.origin);
    return deliveries.reduce<OverlaySyncDelivery>((result, record) => {
      if (!record) return result;
      if (record.delivery === "acknowledged") result.acknowledged += 1;
      else result.pending += 1;
      return result;
    }, emptyDelivery());
  }

  async function collectLiveReboundOverlayGroup(
    readback: ActiveSessionReadback,
    exactContext?: ActivePageContext,
    exactLiveItemId?: string | null,
  ): Promise<{ endpointKey: string; group: OverlayGroup | null } | null> {
    let activePage: ActivePageContext | null;
    if (exactContext) {
      activePage = exactContext;
    } else {
      try {
        activePage = await getActiveCapturePageContext();
      } catch {
        return null;
      }
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
    const liveSubject: OverlayProjectionDescriptor["subject"] = {
      ...liveEndpoint,
      origin: activePage.origin,
      pathname: activePage.pathname,
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
    const items = restored.items.map(({ itemId, attachmentId, label, taskNote }) => ({
      itemId,
      attachmentId,
      label,
      taskNote,
    }));
    if (exactContext && exactLiveItemId && !items.some((item) => item.itemId === exactLiveItemId)) {
      const attachments = readback.file?.session.attachments ?? [];
      const exactIndex = attachments.findIndex((item) => item.id === exactLiveItemId);
      const exactItem = exactIndex >= 0 ? attachments[exactIndex] : undefined;
      const exactRecord = exactItem?.sourceRecord as OriginCaptureRecord | undefined;
      if (exactItem && exactRecord && isOverlayPreviewRecordOnPage(exactRecord, exactContext) &&
          storedCaptureRouteChainMatchesLive(exactRecord, liveRouteChain ?? undefined)) {
        items.push({
          itemId: exactItem.id,
          attachmentId: exactRecord.attachment.id,
          label: formatAnnotationLabel(exactIndex),
          taskNote: exactRecord.intent,
        });
      }
    }
    if (items.length === 0) {
      return exactContext
        ? {
            endpointKey: liveEndpointKey,
            group: { endpoint: liveEndpoint, items: [], subject: liveSubject },
          }
        : { endpointKey: liveEndpointKey, group: null };
    }
    return {
      endpointKey: liveEndpointKey,
      group: {
        endpoint: liveEndpoint,
        items,
        subject: liveSubject,
      },
    };
  }

  async function publishSessionUpdated(
    origin: string,
    itemId: string,
    authority?: OverlaySyncAuthority,
  ): Promise<boolean> {
    return await publishRuntimeMessage({
      type: UI_ATTACH_SESSION_UPDATED,
      origin,
      itemId,
    }, authority);
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
      elementSelectionEnabled:
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
          elementSelectionEnabled: false,
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
          elementSelectionEnabled: true,
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

  async function effectiveOverlayDisplayMode(
    tabId: number,
    windowId: number | undefined,
  ): Promise<PersistentOverlayDisplayMode> {
    try {
      const [leasePreference, displayPreference] = await Promise.all([
        readOverlayVisibilityPreference(chrome.storage.local),
        readOverlayDisplayModePreference(chrome.storage.local),
      ]);
      const leaseVisible = leasePreference === "always" || (
        typeof windowId === "number" &&
        panelVisibilityLeaseCountsByWindow.has(windowId)
      ) || hasInPageWidgetLeaseForTab(tabId);
      return leaseVisible ? displayPreference : "hidden";
    } catch {
      return "hidden";
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

  function hasInPageWidgetLeaseForTab(tabId: number): boolean {
    for (const lease of inPageWidgetLeasesBySurfaceId.values()) {
      if (lease.tabId === tabId) return true;
    }
    return false;
  }

  function inPageWidgetOverlayScopeVisible(context: ActivePageContext): boolean {
    const leases = [...inPageWidgetLeasesBySurfaceId.values()].filter((lease) => lease.tabId === context.tabId);
    if (leases.length === 0) return true;
    return leases.some((lease) => {
      const selected = lease.frameContext ?? {
        tabId: lease.tabId,
        frameId: 0,
        documentId: lease.documentId,
        origin: lease.origin,
        pathname: lease.pathname,
      };
      return sameActivePageContext(selected, context);
    });
  }

  async function drainOverlayVisibilityBroadcasts(): Promise<void> {
    try {
      while (overlayVisibilityBroadcastRequested) {
        overlayVisibilityBroadcastRequested = false;
        const [preference, displayPreference] = await Promise.all([
          readOverlayVisibilityPreference(chrome.storage.local),
          readOverlayDisplayModePreference(chrome.storage.local),
        ]);
        if (overlayVisibilityBroadcastRequested) continue;
        await deliverOverlayVisibility(preference, displayPreference);
      }
    } catch {
      overlayVisibilityBroadcastRequested = false;
      try {
        await deliverOverlayVisibility("panel", "hover");
      } catch {
        // Existing content remains fail-closed after a visibility broadcast failure.
      }
    }
  }

  async function deliverOverlayVisibility(
    preference: OverlayVisibilityPreference,
    displayPreference: OverlayDisplayModePreference,
  ): Promise<void> {
    const tabs = await chrome.tabs.query({});
    await Promise.all(tabs.map(async (tab) => {
      if (tab.id === undefined) return;
      const leaseVisible = preference === "always" || (
        typeof tab.windowId === "number" &&
        panelVisibilityLeaseCountsByWindow.has(tab.windowId)
      ) || hasInPageWidgetLeaseForTab(tab.id);
      const displayMode: PersistentOverlayDisplayMode = leaseVisible ? displayPreference : "hidden";
      const visibilityMessage = {
        type: UI_ATTACH_OVERLAY_VISIBILITY_UPDATED,
        visible: leaseVisible,
      };
      const displayModeMessage = { type: UI_ATTACH_OVERLAY_DISPLAY_MODE_UPDATED, displayMode };
      let frames: UiAttachChromeFrame[] | undefined;
      try {
        frames = await chrome.webNavigation.getAllFrames({ tabId: tab.id });
      } catch {
        frames = undefined;
      }
      if (!frames || frames.length === 0) {
        try {
          await chrome.tabs.sendMessage(tab.id, visibilityMessage);
          await chrome.tabs.sendMessage(tab.id, displayModeMessage);
        } catch {
          // Tabs without the content script are outside the marker visibility boundary.
        }
        return;
      }
      await Promise.all(frames.map(async (frame) => {
        try {
          const target = {
            frameId: frame.frameId,
            ...(frame.documentId ? { documentId: frame.documentId } : {}),
          };
          const origin = originFromUrl(frame.url);
          const pathname = pathnameFromUrl(frame.url);
          const scopeVisible = origin !== null && pathname !== null &&
            typeof frame.documentId === "string" && inPageWidgetOverlayScopeVisible({
              tabId: tab.id!,
              frameId: frame.frameId,
              documentId: frame.documentId,
              origin,
              pathname,
            });
          await chrome.tabs.sendMessage(tab.id!, {
            type: UI_ATTACH_OVERLAY_SCOPE_VISIBILITY_UPDATED,
            visible: scopeVisible,
          }, target);
          await chrome.tabs.sendMessage(tab.id!, visibilityMessage, target);
          await chrome.tabs.sendMessage(tab.id!, displayModeMessage, target);
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
      | OverlayProjectionUpdatedMessage
      | ActiveOriginChangedMessage
      | ElementSelectionUpdatedMessage,
    authority?: OverlaySyncAuthority,
  ): Promise<boolean> {
    if (authority && !authority.isCurrent()) return false;
    try {
      await chrome.runtime.sendMessage(message);
      return true;
    } catch {
      // The panel may not be open yet. The next explicit capture can try again.
      return false;
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
    refreshInPageWidgetContext,
    showInPageWidget,
    register,
  };
}

function parseSessionCommand(value: unknown): GuardResult<SessionCommand> {
  if (!isRecord(value) || typeof value.type !== "string") {
    return { ok: false, issues: [{ path: "type", message: "Expected a session command type." }] };
  }
  switch (value.type) {
    case "ui-attach:content-selection-disable":
    case "ui-attach:element-selection-get":
    case "ui-attach:frame-scope-list":
    case "ui-attach:content-settings-get":
    case UI_ATTACH_OVERLAY_VISIBILITY_GET:
    case UI_ATTACH_OVERLAY_SCOPE_VISIBILITY_GET:
    case UI_ATTACH_OVERLAY_DISPLAY_MODE_GET:
    case UI_ATTACH_OVERLAYS_RESTORE_GET:
    case "ui-attach:session-get-active":
    case "ui-attach:session-list-stored":
    case "ui-attach:session-clear-all-stored": {
      const issues = validateAllowedKeys(value, ["type"], "message");
      if (issues.length > 0) return { ok: false, issues };
      return { ok: true, value: { type: value.type } };
    }
    case "ui-attach:session-begin-capture": {
      const issues = [
        ...validateAllowedKeys(value, ["type", "replaceItemId"], "message"),
        ...(value.replaceItemId === null
          ? []
          : validateNonEmptyString(value.replaceItemId, "replaceItemId")),
      ];
      if (issues.length > 0) return { ok: false, issues };
      return {
        ok: true,
        value: {
          type: value.type,
          replaceItemId: value.replaceItemId as string | null,
        },
      };
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
          Object.hasOwn(value, "routeChain"),
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
          enabled === true
            ? ["type", "enabled", "tabId", "collectBasicDiagnostics"]
            : ["type", "enabled"],
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
        ...(enabled === true && Object.hasOwn(value, "collectBasicDiagnostics") &&
          value.collectBasicDiagnostics !== true
          ? [{
              path: "collectBasicDiagnostics",
              message: "Expected the one-shot diagnostics opt-in marker.",
            }]
          : []),
      ];
      if (issues.length > 0) return { ok: false, issues };
      return enabled === true
        ? {
            ok: true,
            value: {
              type: value.type,
              enabled: true,
              tabId: value.tabId as number,
              ...(value.collectBasicDiagnostics === true
                ? { collectBasicDiagnostics: true as const }
                : {}),
            },
          }
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
      const issues = validateAllowedKeys(
        value,
        ["type", "token", "record", "metadataDiagnosticsDevice"],
        "message",
      );
      const token = parseCaptureToken(value.token, "token", issues);
      const record = parseOriginCaptureRecord(value.record, "record", issues);
      const hasDevice = Object.hasOwn(value, "metadataDiagnosticsDevice");
      const metadataDiagnosticsDevice = hasDevice
        ? parseMetadataDiagnosticsDevice(
            value.metadataDiagnosticsDevice,
            "metadataDiagnosticsDevice",
            issues,
          )
        : null;
      if (token?.collectBasicDiagnostics === true && !hasDevice) {
        issues.push({
          path: "metadataDiagnosticsDevice",
          message: "Expected capture-time coarse device diagnostics.",
        });
      }
      if (token?.collectBasicDiagnostics !== true && hasDevice) {
        issues.push({
          path: "metadataDiagnosticsDevice",
          message: "Unexpected diagnostics without one-shot capture consent.",
        });
      }
      if (issues.length > 0 || !token || !record.ok) return { ok: false, issues };
      return {
        ok: true,
        value: {
          type: value.type,
          token,
          record: record.value,
          ...(metadataDiagnosticsDevice ? { metadataDiagnosticsDevice } : {}),
        },
      };
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
    case "ui-attach:session-update-annotation-lifecycle": {
      const lifecycleStateIsValid = (state: unknown): state is "open" | "resolved" => (
        state === "open" || state === "resolved"
      );
      const issues = [
        ...validateAllowedKeys(value, [
          "type",
          "origin",
          "epoch",
          "itemId",
          "annotationId",
          "expectedState",
          "nextState",
        ], "message"),
        ...validateOrigin(value.origin, "origin"),
        ...validateNonEmptyString(value.epoch, "epoch"),
        ...validateNonEmptyString(value.itemId, "itemId"),
        ...(isCaptureSessionAnnotationId(value.annotationId)
          ? []
          : [{ path: "annotationId", message: "Expected an opaque annotation identity." }]),
        ...(lifecycleStateIsValid(value.expectedState)
          ? []
          : [{ path: "expectedState", message: "Expected open or resolved." }]),
        ...(lifecycleStateIsValid(value.nextState)
          ? []
          : [{ path: "nextState", message: "Expected open or resolved." }]),
        ...(lifecycleStateIsValid(value.expectedState) &&
            lifecycleStateIsValid(value.nextState) &&
            value.expectedState === value.nextState
          ? [{ path: "nextState", message: "Expected a lifecycle state transition." }]
          : []),
      ];
      if (issues.length > 0) return { ok: false, issues };
      return {
        ok: true,
        value: {
          type: value.type,
          origin: value.origin as string,
          epoch: value.epoch as string,
          itemId: value.itemId as string,
          annotationId: value.annotationId as string,
          expectedState: value.expectedState as "open" | "resolved",
          nextState: value.nextState as "open" | "resolved",
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
    case "ui-attach:session-clear-stored-origin":
    case "ui-attach:session-clear": {
      const issues = [
        ...validateAllowedKeys(value, ["type", "origin", "epoch", "operationId"], "message"),
        ...validateOrigin(value.origin, "origin"),
        ...(value.epoch === null ? [] : validateNonEmptyString(value.epoch, "epoch")),
        ...validateBoundedIdentifier(value.operationId, "operationId", 128),
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
): RuntimeCaptureToken | null {
  if (!isRecord(value)) {
    issues.push({ path, message: "Expected a capture token object." });
    return null;
  }
  issues.push(...validateAllowedKeys(
    value,
    [
      "origin",
      "epoch",
      "operationId",
      "replacement",
      "routeLease",
      "collectBasicDiagnostics",
    ],
    path,
  ));
  issues.push(...validateOrigin(value.origin, `${path}.origin`));
  issues.push(...validateNonEmptyString(value.epoch, `${path}.epoch`));
  issues.push(...validateNonEmptyString(value.operationId, `${path}.operationId`));
  if (Object.hasOwn(value, "collectBasicDiagnostics") && value.collectBasicDiagnostics !== true) {
    issues.push({
      path: `${path}.collectBasicDiagnostics`,
      message: "Expected the one-shot diagnostics opt-in marker.",
    });
  }
  let replacement: CaptureToken["replacement"] = null;
  const routeLease = parseRuntimeCaptureRouteLease(value.routeLease, `${path}.routeLease`, issues);
  if (value.replacement !== null) {
    if (!isRecord(value.replacement)) {
      issues.push({ path: `${path}.replacement`, message: "Expected a replacement object or null." });
    } else {
      issues.push(...validateAllowedKeys(
        value.replacement,
        ["itemId", "annotationId", "createdAt", "capturedAt"],
        `${path}.replacement`,
      ));
      issues.push(...validateNonEmptyString(
        value.replacement.itemId,
        `${path}.replacement.itemId`,
      ));
      issues.push(...validateNonEmptyString(
        value.replacement.createdAt,
        `${path}.replacement.createdAt`,
      ));
      issues.push(...validateNonEmptyString(
        value.replacement.capturedAt,
        `${path}.replacement.capturedAt`,
      ));
      const hasAnnotationId = Object.hasOwn(value.replacement, "annotationId");
      if (
        hasAnnotationId &&
        value.replacement.annotationId !== null &&
        !isCaptureSessionAnnotationId(value.replacement.annotationId)
      ) {
        issues.push({
          path: `${path}.replacement.annotationId`,
          message: "Expected a canonical annotation identity or null.",
        });
      }
      replacement = {
        itemId: value.replacement.itemId as string,
        ...(hasAnnotationId
          ? { annotationId: value.replacement.annotationId as string | null }
          : {}),
        createdAt: value.replacement.createdAt as string,
        capturedAt: value.replacement.capturedAt as string,
      };
    }
  }
  if (issues.some((issue) => issue.path.startsWith(path)) || !routeLease) return null;
  return {
    origin: value.origin as string,
    epoch: value.epoch as string,
    operationId: value.operationId as string,
    replacement,
    routeLease,
    ...(value.collectBasicDiagnostics === true
      ? { collectBasicDiagnostics: true as const }
      : {}),
  };
}

function parseMetadataDiagnosticsDevice(
  value: unknown,
  path: string,
  issues: Array<{ path: string; message: string }>,
): MetadataDiagnosticsDeviceV1 | null {
  if (!isRecord(value) || Array.isArray(value)) {
    issues.push({ path, message: "Expected coarse device diagnostics." });
    return null;
  }
  const status = value.status;
  if (status === "collected") {
    issues.push(...validateAllowedKeys(
      value,
      ["status", "deviceClass", "viewportClass", "touch"],
      path,
    ));
    if (value.deviceClass !== "desktop" && value.deviceClass !== "tablet" &&
        value.deviceClass !== "mobile") {
      issues.push({ path: `${path}.deviceClass`, message: "Expected a coarse device class." });
    }
    if (value.viewportClass !== "small" && value.viewportClass !== "medium" &&
        value.viewportClass !== "large") {
      issues.push({ path: `${path}.viewportClass`, message: "Expected a coarse viewport class." });
    }
    if (value.touch !== "none" && value.touch !== "coarse" && value.touch !== "unknown") {
      issues.push({ path: `${path}.touch`, message: "Expected a coarse touch class." });
    }
  } else {
    issues.push(...validateAllowedKeys(value, ["status"], path));
    if (status !== "not_available" && status !== "malformed" && status !== "overbound") {
      issues.push({ path: `${path}.status`, message: "Expected a capture diagnostic status." });
    }
  }
  if (issues.some((issue) => issue.path === path || issue.path.startsWith(`${path}.`))) {
    return null;
  }
  return status === "collected"
    ? {
        status,
        deviceClass: value.deviceClass as "desktop" | "tablet" | "mobile",
        viewportClass: value.viewportClass as "small" | "medium" | "large",
        touch: value.touch as "none" | "coarse" | "unknown",
      }
    : { status: status as "not_available" | "malformed" | "overbound" };
}

function parseRuntimeCaptureRouteLease(
  value: unknown,
  path: string,
  issues: Array<{ path: string; message: string }>,
): RuntimeCaptureRouteLease | null {
  if (!isRecord(value) || Array.isArray(value)) {
    issues.push({ path, message: "Expected a route lease object." });
    return null;
  }
  issues.push(...validateAllowedKeys(
    value,
    ["epoch", "tabId", "selectedFrameId", "segments"],
    path,
  ));
  issues.push(...validateBoundedIdentifier(value.epoch, `${path}.epoch`, 128));
  if (!Number.isSafeInteger(value.tabId) || (value.tabId as number) < 0) {
    issues.push({ path: `${path}.tabId`, message: "Expected a non-negative safe integer." });
  }
  if (!Number.isSafeInteger(value.selectedFrameId) || (value.selectedFrameId as number) < 0) {
    issues.push({ path: `${path}.selectedFrameId`, message: "Expected a non-negative safe integer." });
  }
  if (!Array.isArray(value.segments) || value.segments.length < 1 || value.segments.length > 33) {
    issues.push({ path: `${path}.segments`, message: "Expected between 1 and 33 route segments." });
    return null;
  }
  const segments: RuntimeCaptureRouteSegment[] = [];
  const frameIds = new Set<number>();
  for (const [index, candidate] of value.segments.entries()) {
    const segmentPath = `${path}.segments[${index}]`;
    if (!isRecord(candidate)) {
      issues.push({ path: segmentPath, message: "Expected a route segment object." });
      continue;
    }
    issues.push(...validateAllowedKeys(
      candidate,
      ["frameId", "documentId", "origin", "pathname"],
      segmentPath,
    ));
    if (!Number.isSafeInteger(candidate.frameId) || (candidate.frameId as number) < 0) {
      issues.push({ path: `${segmentPath}.frameId`, message: "Expected a non-negative safe integer." });
    }
    issues.push(...validateBoundedIdentifier(
      candidate.documentId,
      `${segmentPath}.documentId`,
      256,
    ));
    issues.push(...validateOrigin(candidate.origin, `${segmentPath}.origin`));
    issues.push(...validatePathname(candidate.pathname, candidate.origin, `${segmentPath}.pathname`));
    if (
      Number.isSafeInteger(candidate.frameId) &&
      frameIds.has(candidate.frameId as number)
    ) {
      issues.push({ path: `${segmentPath}.frameId`, message: "Expected a unique frame id." });
    }
    if (Number.isSafeInteger(candidate.frameId)) frameIds.add(candidate.frameId as number);
    segments.push({
      frameId: candidate.frameId as number,
      documentId: candidate.documentId as string,
      origin: candidate.origin as string,
      pathname: candidate.pathname as string,
    });
  }
  if (segments[0]?.frameId !== 0) {
    issues.push({ path: `${path}.segments[0].frameId`, message: "Expected the top frame first." });
  }
  if (segments.at(-1)?.frameId !== value.selectedFrameId) {
    issues.push({ path: `${path}.selectedFrameId`, message: "Expected the final route segment frame." });
  }
  return issues.some((issue) => issue.path.startsWith(path))
    ? null
    : {
        epoch: value.epoch as string,
        tabId: value.tabId as number,
        selectedFrameId: value.selectedFrameId as number,
        segments,
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
  hasOwnRouteChain: boolean,
  path: string,
): Array<{ path: string; message: string }> {
  if (value === undefined) {
    return frameKind === "top" && !hasOwnRouteChain
      ? []
      : [{ path, message: "Expected an explicit canonical route chain." }];
  }
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

function validateBoundedIdentifier(
  value: unknown,
  path: string,
  maxLength: number,
): Array<{ path: string; message: string }> {
  return typeof value === "string" && value.length > 0 && value.length <= maxLength &&
      value.trim() === value && !/[\u0000-\u001f\u007f]/u.test(value)
    ? []
    : [{ path, message: `Expected a trimmed identifier up to ${maxLength} characters.` }];
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

function metadataDiagnosticsCleanupPending(): Extract<SessionCommandResponse<never>, { ok: false }> {
  return failure(
    "STORAGE_ERROR",
    "Capture diagnostics cleanup is pending retry.",
  );
}

function openSidePanelWithTimeout(
  openSidePanel: (options: UiAttachChromeSidePanelOpenOptions) => Promise<void>,
  openOptions: UiAttachChromeSidePanelOpenOptions,
): Promise<SidePanelOpenOutcome> {
  return new Promise((resolve) => {
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const finish = (outcome: SidePanelOpenOutcome): void => {
      if (settled) return;
      settled = true;
      if (timer !== undefined) clearTimeout(timer);
      resolve(outcome);
    };

    timer = setTimeout(() => finish("timeout"), SIDE_PANEL_OPEN_TIMEOUT_MS);
    let openPromise: Promise<void>;
    try {
      // Promise.resolve also turns a synchronous throw or an unexpectedly
      // thenable return into a handled rejection for the terminal mapping.
      openPromise = Promise.resolve(openSidePanel(openOptions));
    } catch {
      finish("rejected");
      return;
    }
    // Keep both handlers attached even after the timeout: Chrome's native
    // operation cannot be cancelled, so a late rejection must be consumed.
    void openPromise.then(
      () => finish("opened"),
      () => finish("rejected"),
    );
  });
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

function parseStoredOverlayProjectionRecords(value: unknown): OverlayProjectionRecord[] {
  if (!Array.isArray(value) || value.length > MAX_OVERLAY_PROJECTIONS) return [];
  const records: OverlayProjectionRecord[] = [];
  const subjects = new Set<string>();
  for (const candidate of value) {
    if (!isRecord(candidate) || !hasExactlyStoredKeys(candidate, [
      "projection",
      "itemIds",
      "activeItemId",
      "delivery",
      "updatedAt",
    ]) || !isOverlayProjectionDescriptor(candidate.projection) ||
        !Array.isArray(candidate.itemIds) || candidate.itemIds.length > OVERLAY_RESTORE_MAX_ITEMS ||
        !candidate.itemIds.every((itemId) => typeof itemId === "string" &&
          itemId.length > 0 && itemId.length <= 256 && !/\p{Cc}/u.test(itemId)) ||
        new Set(candidate.itemIds).size !== candidate.itemIds.length ||
        !(candidate.activeItemId === null || (
          typeof candidate.activeItemId === "string" &&
          candidate.itemIds.includes(candidate.activeItemId)
        )) ||
        (candidate.delivery !== "pending" && candidate.delivery !== "acknowledged") ||
        typeof candidate.updatedAt !== "number" ||
        !Number.isSafeInteger(candidate.updatedAt) || candidate.updatedAt < 0) return [];
    const key = overlayProjectionSubjectKey(candidate.projection.subject);
    if (subjects.has(key)) return [];
    subjects.add(key);
    records.push({
      projection: {
        ...candidate.projection,
        subject: { ...candidate.projection.subject },
      },
      itemIds: [...candidate.itemIds],
      activeItemId: candidate.activeItemId,
      delivery: candidate.delivery,
      updatedAt: candidate.updatedAt,
    });
  }
  return records;
}

function parseStoredOverlayProjectionRegistryEnvelope(
  value: unknown,
): OverlayProjectionRegistryEnvelope | null {
  if (!isRecord(value) || !hasExactlyStoredKeys(value, ["generation", "records"]) ||
      !isStoredOverlayProjectionAuthorityGeneration(value.generation)) return null;
  const records = parseStoredOverlayProjectionRecords(value.records);
  if (!Array.isArray(value.records) ||
      (value.records.length > 0 && records.length === 0)) return null;
  return { generation: value.generation, records };
}

function parseStoredOverlayProjectionAuthorityGeneration(value: unknown): number | null {
  if (value === undefined) return 0;
  return isStoredOverlayProjectionAuthorityGeneration(value) ? value : null;
}

function isStoredOverlayProjectionAuthorityGeneration(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

function nextOverlayProjectionAuthorityGeneration(current: number): number {
  return current >= Number.MAX_SAFE_INTEGER ? 1 : current + 1;
}

function cloneOverlayProjectionRecord(record: OverlayProjectionRecord): OverlayProjectionRecord {
  return {
    projection: {
      ...record.projection,
      subject: { ...record.projection.subject },
    },
    itemIds: [...record.itemIds],
    activeItemId: record.activeItemId,
    delivery: record.delivery,
    updatedAt: record.updatedAt,
  };
}

function overlayProjectionSubjectKey(
  subject: OverlayProjectionDescriptor["subject"],
): string {
  return JSON.stringify([
    subject.tabId,
    subject.frameId,
    subject.documentId,
    subject.origin,
    subject.pathname,
  ]);
}

function sameOverlayProjectionSubject(
  left: OverlayProjectionDescriptor["subject"],
  right: OverlayProjectionDescriptor["subject"],
): boolean {
  return left.tabId === right.tabId && left.frameId === right.frameId &&
    left.documentId === right.documentId && left.origin === right.origin &&
    left.pathname === right.pathname;
}

function sameOverlayProjectionItemIds(
  left: readonly string[],
  right: readonly string[],
): boolean {
  return left.length === right.length &&
    left.every((itemId, index) => itemId === right[index]);
}

function clearProjectionAuthority(
  operation: CaptureClearOperationV1,
): ClearProjectionAuthorityReference {
  return {
    authorityId: operation.authorityId,
    operationId: operation.operationId,
    generation: operation.generation,
  };
}

function clearProjectionSubjectKey(subject: ClearProjectionSubject): string {
  return JSON.stringify([
    subject.tabId,
    subject.frameId,
    subject.documentId,
    subject.origin,
    subject.pathname,
  ]);
}

function sameClearProjectionSubject(
  left: ClearProjectionSubject,
  right: ClearProjectionSubject,
): boolean {
  return left.tabId === right.tabId && left.frameId === right.frameId &&
    left.documentId === right.documentId && left.origin === right.origin &&
    left.pathname === right.pathname;
}

function clearProjectionReferenceKey(reference: ClearProjectionReference): string {
  return JSON.stringify([
    reference.version,
    reference.authorityId,
    reference.operationId,
    reference.generation,
    reference.origin,
    reference.afterEpoch,
    reference.subject.tabId,
    reference.subject.frameId,
    reference.subject.documentId,
    reference.subject.origin,
    reference.subject.pathname,
    reference.projectionId,
    reference.revision,
  ]);
}

function createClearProjectionAckWaiter(): ClearProjectionAckWaiter {
  let deliveryReady = false;
  let completed = false;
  let resolveDeliveryReady!: () => void;
  let resolveCompletion!: (accepted: boolean) => void;
  const deliveryReadyPromise = new Promise<void>((resolve) => {
    resolveDeliveryReady = resolve;
  });
  const completion = new Promise<boolean>((resolve) => {
    resolveCompletion = resolve;
  });
  return {
    deliveryReady: deliveryReadyPromise,
    markDeliveryReady() {
      if (deliveryReady) return;
      deliveryReady = true;
      resolveDeliveryReady();
    },
    completion,
    settle(accepted) {
      if (completed) return;
      completed = true;
      resolveCompletion(accepted);
    },
  };
}

function sameOverlayProjectionRef(
  descriptor: OverlayProjectionDescriptor,
  reference: OverlayProjectionRef,
): boolean {
  return descriptor.version === reference.version &&
    descriptor.projectionId === reference.projectionId &&
    descriptor.revision === reference.revision;
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

function cloneResumableElementSelectionScope(
  scope: ResumableElementSelectionScope,
): ResumableElementSelectionScope {
  return {
    tabId: scope.tabId,
    windowId: scope.windowId,
    target: { ...scope.target },
    expectedPage: { ...scope.expectedPage },
  };
}

function sameResumableElementSelectionScope(
  left: ResumableElementSelectionScope | undefined,
  right: ResumableElementSelectionScope | undefined,
): boolean {
  if (!left || !right) return left === right;
  return left.tabId === right.tabId && left.windowId === right.windowId &&
    left.expectedPage.origin === right.expectedPage.origin &&
    left.expectedPage.pathname === right.expectedPage.pathname &&
    left.target.frameId === right.target.frameId &&
    left.target.frameOrigin === right.target.frameOrigin &&
    left.target.framePathname === right.target.framePathname &&
    left.target.documentId === right.target.documentId &&
    left.target.parentFrameId === right.target.parentFrameId &&
    left.target.parentDocumentId === right.target.parentDocumentId &&
    left.target.parentFrameOrigin === right.target.parentFrameOrigin &&
    left.target.parentFramePathname === right.target.parentFramePathname;
}

function parseStoredInPageWidgetLeaseInvalidations(
  value: unknown,
): InPageWidgetLeaseInvalidation[] | null {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > MAX_IN_PAGE_WIDGET_LEASE_INVALIDATIONS) return null;
  const invalidations: InPageWidgetLeaseInvalidation[] = [];
  const surfaceIds = new Set<string>();
  for (const candidate of value) {
    if (!isRecord(candidate) || !hasOnlyStoredKeys(candidate, ["surfaceId", "tabId"]) ||
        typeof candidate.surfaceId !== "string" ||
        !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(
          candidate.surfaceId,
        ) || !isNonNegativeInteger(candidate.tabId) || surfaceIds.has(candidate.surfaceId)) {
      return null;
    }
    surfaceIds.add(candidate.surfaceId);
    invalidations.push({ surfaceId: candidate.surfaceId, tabId: candidate.tabId });
  }
  return invalidations;
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

function hasExactlyStoredKeys(value: Record<string, unknown>, allowed: string[]): boolean {
  const keys = Object.keys(value);
  return keys.length === allowed.length && keys.every((key) => allowed.includes(key));
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

function leaseFromPersisted(
  persisted: PersistedInPageWidgetLease,
  capability: string,
): InPageWidgetLease {
  return {
    capability,
    documentId: persisted.documentId,
    origin: persisted.origin,
    pathname: persisted.pathname,
    surfaceId: persisted.surfaceId,
    tabId: persisted.tabId,
    windowId: persisted.windowId,
    disconnectPinCount: 0,
    contextMutation: createInPageWidgetContextMutationCoordinator(),
    ...(persisted.frameContext ? {
      frameContext: {
        ...persisted.frameContext,
        tabId: persisted.tabId,
      },
    } : {}),
  };
}

function createInPageWidgetContextMutationCoordinator(): InPageWidgetContextMutationCoordinator {
  return {
    cancelled: false,
    generation: 0,
    mutating: false,
    terminalGeneration: 0,
    tail: Promise.resolve(),
  };
}

function overlayEndpointFromSender(sender: UiAttachChromeMessageSender): OverlayEndpoint | null {
  const tabId = sender.tab?.id;
  const frameId = sender.frameId ?? 0;
  return typeof tabId === "number" && Number.isInteger(tabId) && tabId >= 0 &&
    typeof frameId === "number" && Number.isInteger(frameId) && frameId >= 0
    ? { tabId, frameId, ...(sender.documentId ? { documentId: sender.documentId } : {}) }
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

function isExactNullCommandResponse(value: unknown): value is { ok: true; data: null } {
  if (typeof value !== "object" || value === null) return false;
  const record = value as Record<string, unknown>;
  return Object.keys(record).length === 2 && record.ok === true && record.data === null;
}

function isDelegatedWidgetSurfaceResponse(value: unknown): value is {
  ok: true;
  data: { delegated: true; surfaceOwner: "sdk" | "extension" };
} {
  if (!isRecord(value) || !hasExactKeys(value, ["ok", "data"]) || value.ok !== true) return false;
  if (!isRecord(value.data) || !hasExactKeys(value.data, ["delegated", "surfaceOwner"])) {
    return false;
  }
  return value.data.delegated === true &&
    (value.data.surfaceOwner === "sdk" || value.data.surfaceOwner === "extension");
}

function hasExactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const keys = Object.keys(value);
  return keys.length === expected.length && expected.every((key) => Object.hasOwn(value, key));
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

function overlayProjectionReackRequired(): Extract<SessionCommandResponse<never>, { ok: false }> {
  return failure(
    UI_ATTACH_OVERLAY_PROJECTION_REACK_REQUIRED,
    "The live overlay projection must be acknowledged again.",
  );
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
    case "ANNOTATION_LIFECYCLE_NOT_COMMITTED":
      return "Annotation lifecycle operation was not committed.";
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
      label: formatAnnotationLabel(index),
      taskNote: item.sourceRecord.intent,
    });
    groups.set(key, group);
  }
  return groups;
}

function collectAuthorityBoundOverlayItems(
  readback: ActiveSessionReadback,
  subject: OverlayProjectionDescriptor["subject"],
  liveRouteChain: readonly CaptureRouteSegmentV1[],
): OverlayStateItem[] {
  const items: OverlayStateItem[] = [];
  for (const [index, item] of (readback.file?.session.attachments ?? []).entries()) {
    const record = item.sourceRecord as OriginCaptureRecord;
    const frameId = record.frameId ?? 0;
    if (
      record.tabId !== subject.tabId ||
      frameId !== subject.frameId ||
      record.origin !== subject.origin ||
      pathnameFromUrl(record.pageUrl ?? undefined) !== subject.pathname
    ) continue;
    const hasStoredRouteChain = Object.hasOwn(record, "routeChain");
    if ((frameId > 0 || hasStoredRouteChain) &&
        !storedCaptureRouteChainMatchesLive(record, liveRouteChain)) continue;
    items.push({
      itemId: item.id,
      attachmentId: record.attachment.id,
      label: formatAnnotationLabel(index),
      taskNote: record.intent,
    });
  }
  return items;
}

function readCanonicalStoredRouteChain(
  record: Pick<OriginCaptureRecord, "frameId" | "pageUrl" | "routeChain">,
  frameId: number,
): CaptureRouteSegmentV1[] | null {
  const value: unknown = record.routeChain;
  if (!Array.isArray(value) || value.length === 0 || value.length > 33) return null;
  if ((frameId === 0 && value.length !== 1) || (frameId > 0 && value.length < 2)) return null;
  const routes: CaptureRouteSegmentV1[] = [];
  for (const segment of value) {
    if (!isRecord(segment)) return null;
    const keys = Reflect.ownKeys(segment);
    const origin = typeof segment.origin === "string" ? segment.origin : null;
    const pathname = canonicalStoredPathname(segment.pathname, origin);
    if (
      keys.length !== 2 ||
      !keys.includes("origin") ||
      !keys.includes("pathname") ||
      origin === null ||
      originFromUrl(origin) !== origin ||
      pathname === null
    ) return null;
    routes.push({ origin, pathname });
  }
  const pageOrigin = originFromUrl(record.pageUrl ?? undefined);
  const pagePathname = pathnameFromUrl(record.pageUrl ?? undefined);
  const terminal = routes.at(-1);
  return terminal && terminal.origin === pageOrigin && terminal.pathname === pagePathname
    ? routes
    : null;
}

function storedCaptureRouteChainMatchesLive(
  record: Pick<OriginCaptureRecord, "frameId" | "pageUrl" | "routeChain">,
  liveRouteChain: readonly CaptureRouteSegmentV1[] | undefined,
): boolean {
  const frameId = record.frameId ?? 0;
  if (frameId === 0 && !Object.hasOwn(record, "routeChain")) return true;
  const storedRouteChain = readCanonicalStoredRouteChain(record, frameId);
  return storedRouteChain !== null && liveRouteChain !== undefined &&
    sameCaptureRouteChain(storedRouteChain, liveRouteChain);
}

function savedSessionStoredRouteChainMatches(
  record: Pick<OriginCaptureRecord, "frameId" | "pageUrl" | "routeChain">,
  frameKind: "top" | "embedded",
  routeChain: readonly CaptureRouteSegmentV1[] | undefined,
): boolean {
  const frameId = record.frameId ?? 0;
  if ((frameId === 0 ? "top" : "embedded") !== frameKind) return false;
  if (routeChain === undefined) {
    return frameId === 0 && !Object.hasOwn(record, "routeChain");
  }
  const storedRouteChain = readCanonicalStoredRouteChain(record, frameId);
  return storedRouteChain !== null && sameCaptureRouteChain(storedRouteChain, routeChain);
}

function collectOverlayRestoreData(
  readback: ActiveSessionReadback,
  origin: string,
  documentUrl: string,
  endpoint: OverlayEndpoint,
  liveFrames: UiAttachChromeFrame[],
  activeItemId: string | null,
  liveRouteChain?: CaptureRouteSegmentV1[],
): Omit<OverlayRestoreData, "projection"> {
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
    const locators = sameRoute
      ? collectVerifiedOverlayReplayLocators(record)
      : [];
    if (
      record.origin !== origin ||
      recordedRouteKey === null ||
      !sameRoute ||
      locators.length === 0 ||
      !storedCaptureRouteChainMatchesLive(record, liveRouteChain) ||
      !overlayRecordMatchesLiveEndpoint(record.tabId, frameId, endpoint, routeKey, liveFrames)
    ) {
      continue;
    }
    items.push({
      itemId: item.id,
      attachmentId: record.attachment.id,
      label: formatAnnotationLabel(index),
      taskNote: record.intent,
      ...(record.attachment.selectionPoint ? {
        anchor: {
          xRatio: record.attachment.selectionPoint.xRatio,
          yRatio: record.attachment.selectionPoint.yRatio,
        },
      } : {}),
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

async function readLiveCaptureRouteChain(
  chrome: UiAttachChrome,
  endpoint: OverlayEndpoint,
  expectedDocumentId?: string,
): Promise<CaptureRouteSegmentV1[] | null> {
  let frames: UiAttachChromeFrame[] | undefined;
  try {
    frames = await chrome.webNavigation.getAllFrames({ tabId: endpoint.tabId });
  } catch {
    frames = undefined;
  }
  if (!frames) return null;
  if (
    expectedDocumentId !== undefined &&
    frames.find((frame) => frame.frameId === endpoint.frameId)?.documentId !== expectedDocumentId
  ) return null;
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

function runtimeCaptureRouteSegmentsFromFrames(
  frames: readonly UiAttachChromeFrame[],
  selectedFrameId: number,
): RuntimeCaptureRouteSegment[] | null {
  const byFrameId = new Map(frames.map((frame) => [frame.frameId, frame]));
  const segments: RuntimeCaptureRouteSegment[] = [];
  const visited = new Set<number>();
  let current = byFrameId.get(selectedFrameId);
  while (current && !visited.has(current.frameId) && segments.length < 33) {
    visited.add(current.frameId);
    const origin = originFromUrl(current.url);
    const pathname = pathnameFromUrl(current.url);
    if (!current.documentId || !origin || pathname === null) return null;
    segments.unshift({
      frameId: current.frameId,
      documentId: current.documentId,
      origin,
      pathname,
    });
    if (current.frameId === 0) return current.parentFrameId < 0 ? segments : null;
    if (current.parentFrameId < 0) return null;
    current = byFrameId.get(current.parentFrameId);
  }
  return null;
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

function captureRouteChainFromFrameScopes(
  scopes: readonly FrameScopeDescriptor[],
  frameId: number,
): CaptureRouteSegmentV1[] | null {
  const byFrameId = new Map(scopes.map((scope) => [scope.frameId, scope]));
  const chain: CaptureRouteSegmentV1[] = [];
  const visited = new Set<number>();
  let current = byFrameId.get(frameId);
  while (current && !visited.has(current.frameId) && chain.length <= 32) {
    visited.add(current.frameId);
    chain.unshift({ origin: current.origin, pathname: current.pathname });
    if (current.frameId === 0) return current.parentFrameId === null ? chain : null;
    if (current.parentFrameId === null) return null;
    current = byFrameId.get(current.parentFrameId);
  }
  return null;
}

function sameCaptureReplacement(
  left: CaptureToken["replacement"],
  right: CaptureToken["replacement"],
): boolean {
  if (left === null || right === null) return left === right;
  return left.itemId === right.itemId &&
    (left.annotationId ?? null) === (right.annotationId ?? null) &&
    left.createdAt === right.createdAt &&
    left.capturedAt === right.capturedAt;
}

function sessionItemAnnotationId(
  file: ActiveSessionReadback["file"],
  itemId: string,
): string | null {
  if (!file || file.schemaVersion === "0.1.0") return null;
  return file.session.attachments.find((item) => item.id === itemId)?.annotationId ?? null;
}

function sameRuntimeCaptureToken(
  left: RuntimeCaptureToken,
  right: RuntimeCaptureToken,
): boolean {
  return left.origin === right.origin &&
    left.epoch === right.epoch &&
    left.operationId === right.operationId &&
    left.collectBasicDiagnostics === right.collectBasicDiagnostics &&
    sameCaptureReplacement(left.replacement, right.replacement) &&
    left.routeLease.epoch === right.routeLease.epoch &&
    left.routeLease.tabId === right.routeLease.tabId &&
    left.routeLease.selectedFrameId === right.routeLease.selectedFrameId &&
    sameRuntimeCaptureRouteSegments(left.routeLease.segments, right.routeLease.segments);
}

function sameRuntimeCaptureRouteSegments(
  left: readonly RuntimeCaptureRouteSegment[],
  right: readonly RuntimeCaptureRouteSegment[],
): boolean {
  return left.length === right.length && left.every((segment, index) => {
    const candidate = right[index];
    return candidate !== undefined &&
      segment.frameId === candidate.frameId &&
      segment.documentId === candidate.documentId &&
      segment.origin === candidate.origin &&
      segment.pathname === candidate.pathname;
  });
}

function runtimeCaptureRouteLeaseMatchesSender(
  lease: RuntimeCaptureRouteLease,
  sender: UiAttachChromeMessageSender,
): boolean {
  return contentTabIdFromSender(sender) === lease.tabId &&
    contentFrameIdFromSender(sender) === lease.selectedFrameId &&
    sender.documentId === lease.segments.at(-1)?.documentId;
}

function collectOverlayEndpoints(readback: ActiveSessionReadback | null): OverlayEndpoint[] {
  return readback ? Array.from(collectOverlayGroups(readback).values(), (group) => group.endpoint) : [];
}

function endpointKey(endpoint: OverlayEndpoint): string {
  return `${endpoint.tabId}:${endpoint.frameId}`;
}

function annotationLabelFromSessionLabel(label: string): string | null {
  return /^[A-Z]$/u.test(label) ? String(label.charCodeAt(0) - 64) : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
