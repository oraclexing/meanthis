import type {
  MetadataDiagnosticsDeviceV1,
  MetadataDiagnosticsV1,
  UIAttachmentDisclosureMode,
  UIAttachmentLocator,
  UILocatorStrategy,
} from "@meanthis/schema";
import type { CaptureSessionAnnotationLifecycleStateV3 } from "@meanthis/hub-core";
import type { PersistentOverlayDisplayMode } from "@meanthis/web-picker";
import type { OriginCaptureRecord } from "./capture-store";
import type { ActiveSessionReadback } from "./session-store";
import type { CaptureToken } from "./session-state";
import { isCaptureObservation, type CaptureObservation } from "./capture-comparison";

export const UI_ATTACH_CONTEXT_MENU_ID = "meanthis-add-page-element";
export const UI_ATTACH_CONTENT_READY_GET = "ui-attach:content-ready-get";
// Bump for every content-message contract or capability change. The strict ready
// request parser, not the null response body, proves the active content generation.
export const UI_ATTACH_CONTENT_PROTOCOL_VERSION = 7;
export const UI_ATTACH_EMBEDDED_FRAME_HOST_INSPECT = "ui-attach:embedded-frame-host-inspect";
export const UI_ATTACH_CAPTURE_FAILED = "ui-attach:capture-failed";
export const UI_ATTACH_SESSION_UPDATED = "ui-attach:session-updated";
export const UI_ATTACH_ACTIVE_ORIGIN_CHANGED = "ui-attach:active-origin-changed";
export const UI_ATTACH_CONTENT_DEACTIVATE = "ui-attach:content-deactivate";
export const UI_ATTACH_ELEMENT_SELECTION_UPDATED = "ui-attach:element-selection-updated";
export const UI_ATTACH_SELECTION_LIFECYCLE_PORT = "ui-attach:selection-lifecycle";
export const UI_ATTACH_SELECTION_LIFECYCLE_HEARTBEAT =
  "ui-attach:selection-lifecycle-heartbeat";
export const UI_ATTACH_PANEL_LIFECYCLE_PORT_PREFIX = "ui-attach:panel-lifecycle";
export const UI_ATTACH_SELECTION_SEED_CONTEXT_TARGET =
  "ui-attach:selection-seed-context-target";
export const UI_ATTACH_CONTENT_SETTINGS_UPDATED = "ui-attach:content-settings-updated";
export const UI_ATTACH_OVERLAY_STATE = "ui-attach:overlay-state";
export const UI_ATTACH_OVERLAY_PREVIEW = "ui-attach:overlay-preview";
export const UI_ATTACH_OVERLAY_RELATION_PREVIEW = "ui-attach:overlay-relation-preview";
export const UI_ATTACH_OVERLAYS_RESTORE_GET = "ui-attach:overlays-restore-get";
export const UI_ATTACH_OVERLAY_RESTORE_REFRESH = "ui-attach:overlay-restore-refresh";
export const UI_ATTACH_OVERLAY_REBIND_STATUS_GET = "ui-attach:overlay-rebind-status-get";
export const UI_ATTACH_CAPTURE_OBSERVATION_GET = "ui-attach:capture-observation-get";
export const UI_ATTACH_OVERLAY_VISIBILITY_GET = "ui-attach:overlay-visibility-get";
export const UI_ATTACH_OVERLAY_VISIBILITY_UPDATED = "ui-attach:overlay-visibility-updated";
export const UI_ATTACH_OVERLAY_SCOPE_VISIBILITY_GET =
  "ui-attach:overlay-scope-visibility-get";
export const UI_ATTACH_OVERLAY_SCOPE_VISIBILITY_UPDATED =
  "ui-attach:overlay-scope-visibility-updated";
export const UI_ATTACH_OVERLAY_DISPLAY_MODE_GET = "ui-attach:overlay-display-mode-get";
export const UI_ATTACH_OVERLAY_DISPLAY_MODE_UPDATED = "ui-attach:overlay-display-mode-updated";
export const UI_ATTACH_OVERLAY_ACTION_REQUEST = "ui-attach:overlay-action-request";
export const UI_ATTACH_OVERLAY_PROJECTION_ACK = "ui-attach:overlay-projection-ack";
export const UI_ATTACH_OVERLAY_PROJECTION_UPDATED = "ui-attach:overlay-projection-updated";
export const UI_ATTACH_OVERLAY_PROJECTION_REACK_REQUIRED =
  "OVERLAY_PROJECTION_REACK_REQUIRED";
export const UI_ATTACH_OVERLAY_PROJECTION_VERSION = 1;
export const UI_ATTACH_CLEAR_PROJECTION = "ui-attach:clear-projection";
export const UI_ATTACH_CLEAR_PROJECTION_ACK = "ui-attach:clear-projection-ack";
export const UI_ATTACH_CLEAR_PROJECTION_VERSION = 1;
export const UI_ATTACH_EMPTY_APPLIED_ITEM_IDS_DIGEST =
  "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";
export const OVERLAY_RESTORE_MAX_ITEMS = 26;
export const OVERLAY_RESTORE_MAX_LOCATORS = 8;
export const OVERLAY_ACTION_ITEM_ID_MAX_LENGTH = 256;
export const OVERLAY_ATTACHMENT_ID_MAX_LENGTH = 256;
export const OVERLAY_REPLAY_LOCATOR_VALUE_MAX_LENGTH = 16_384;
export const OVERLAY_TASK_NOTE_MAX_LENGTH = 16_384;
export const OVERLAY_PROJECTION_ID_MAX_LENGTH = 64;
export const OVERLAY_PROJECTION_DOCUMENT_ID_MAX_LENGTH = 256;

export interface CaptureFailedMessage {
  type: typeof UI_ATTACH_CAPTURE_FAILED;
  error: string;
}

export interface SessionUpdatedMessage {
  type: typeof UI_ATTACH_SESSION_UPDATED;
  origin: string;
  itemId: string;
}

export interface OverlayProjectionUpdatedMessage {
  type: typeof UI_ATTACH_OVERLAY_PROJECTION_UPDATED;
}

export interface ActiveOriginChangedMessage {
  type: typeof UI_ATTACH_ACTIVE_ORIGIN_CHANGED;
  accessRequired: boolean;
  enabled: boolean;
  origin: string | null;
}

export interface ElementSelectionUpdatedMessage {
  type: typeof UI_ATTACH_ELEMENT_SELECTION_UPDATED;
  enabled: boolean;
}

export interface ContentSettingsData {
  disclosureMode: UIAttachmentDisclosureMode;
  elementSelectionEnabled: boolean;
}

export interface ContentReadyGetMessage {
  type: typeof UI_ATTACH_CONTENT_READY_GET;
  protocolVersion: typeof UI_ATTACH_CONTENT_PROTOCOL_VERSION;
}

export interface SelectionSeedContextTargetMessage {
  type: typeof UI_ATTACH_SELECTION_SEED_CONTEXT_TARGET;
}

export interface ContentSettingsUpdatedMessage extends ContentSettingsData {
  type: typeof UI_ATTACH_CONTENT_SETTINGS_UPDATED;
}

export interface OverlayVisibilityUpdatedMessage {
  type: typeof UI_ATTACH_OVERLAY_VISIBILITY_UPDATED;
  visible: boolean;
}

export interface OverlayScopeVisibilityUpdatedMessage {
  type: typeof UI_ATTACH_OVERLAY_SCOPE_VISIBILITY_UPDATED;
  visible: boolean;
}

export interface OverlayDisplayModeUpdatedMessage {
  type: typeof UI_ATTACH_OVERLAY_DISPLAY_MODE_UPDATED;
  displayMode: PersistentOverlayDisplayMode;
}

export interface CaptureCommitReceipt {
  origin: string;
  epoch: string;
  itemId: string;
  annotationLabel: string;
}

export interface OverlayStateItem {
  itemId: string;
  attachmentId: string;
  label: string;
  taskNote: string;
}

export interface OverlayProjectionRef {
  version: typeof UI_ATTACH_OVERLAY_PROJECTION_VERSION;
  projectionId: string;
  revision: number;
}

export interface OverlayProjectionDescriptor extends OverlayProjectionRef {
  sessionEpoch: string | null;
  subject: {
    tabId: number;
    frameId: number;
    documentId: string;
    origin: string;
    pathname: string;
  };
}

export interface OverlayStateMessage {
  type: typeof UI_ATTACH_OVERLAY_STATE;
  origin: string;
  projection: OverlayProjectionDescriptor;
  activeItemId: string | null;
  items: OverlayStateItem[];
}

export interface OverlayPreviewMessage {
  type: typeof UI_ATTACH_OVERLAY_PREVIEW;
  origin: string;
  pathname: string;
  itemId: string | null;
}

export interface OverlayRelationPreviewMessage {
  type: typeof UI_ATTACH_OVERLAY_RELATION_PREVIEW;
  origin: string;
  pathname: string;
  sourceItemId: string;
  referenceItemId: string;
}

export type OverlayActionRequestAction = "edit" | "remove" | "more" | "save";

export type OverlayActionRequestMessage = {
  type: typeof UI_ATTACH_OVERLAY_ACTION_REQUEST;
  action: "edit" | "remove" | "more";
  itemId: string;
  projection: OverlayProjectionRef;
} | {
  type: typeof UI_ATTACH_OVERLAY_ACTION_REQUEST;
  action: "save";
  itemId: string;
  taskNote: string;
  projection: OverlayProjectionRef;
};

export interface OverlayProjectionAckMessage {
  type: typeof UI_ATTACH_OVERLAY_PROJECTION_ACK;
  projection: OverlayProjectionRef;
}

export interface ClearProjectionReference {
  version: typeof UI_ATTACH_CLEAR_PROJECTION_VERSION;
  authorityId: string;
  operationId: string;
  generation: number;
  origin: string;
  afterEpoch: string;
  subject: OverlayProjectionDescriptor["subject"];
  projectionId: string;
  revision: number;
}

export interface ClearProjectionTombstoneMessage {
  type: typeof UI_ATTACH_CLEAR_PROJECTION;
  clear: ClearProjectionReference;
}

export interface ClearProjectionZeroReadback {
  appliedItemIds: [];
  markerCount: 0;
  selectionPreviewActive: false;
  digest: typeof UI_ATTACH_EMPTY_APPLIED_ITEM_IDS_DIGEST;
}

export interface ClearProjectionAckMessage {
  type: typeof UI_ATTACH_CLEAR_PROJECTION_ACK;
  clear: ClearProjectionReference;
  readback: ClearProjectionZeroReadback;
}

export type OverlayReplayLocatorStrategy = Exclude<
  UILocatorStrategy,
  "coordinates" | "xpath"
>;

export interface OverlayReplayLocator
  extends Pick<UIAttachmentLocator, "value" | "confidence"> {
  strategy: OverlayReplayLocatorStrategy;
}

export interface EmbeddedFrameHostInspectMessage {
  type: typeof UI_ATTACH_EMBEDDED_FRAME_HOST_INSPECT;
  locators: OverlayReplayLocator[];
}

export interface EmbeddedFrameHostInspectData {
  frameHostCount: number;
  frameOrigin: string | null;
  framePathname: string | null;
}

export interface FrameScopeDescriptor {
  frameId: number;
  parentFrameId: number | null;
  documentId: string | null;
  origin: string;
  pathname: string;
  depth: number;
  requiresHostPermission: boolean;
  selectable: boolean;
}

export interface FrameScopeListData {
  tabId: number;
  currentFrameId: number;
  scopes: FrameScopeDescriptor[];
}

export interface WidgetFrameScopeDescriptor extends FrameScopeDescriptor {
  itemCount: number | null;
  itemIds: string[] | null;
}

export interface WidgetFrameScopeListData {
  currentFrameId: number;
  scopes: WidgetFrameScopeDescriptor[];
}

export interface OverlayRestoreItem extends OverlayStateItem {
  anchor?: {
    xRatio: number;
    yRatio: number;
  };
  locators: OverlayReplayLocator[];
}

export interface OverlayRestoreData {
  origin: string;
  projection: OverlayProjectionDescriptor;
  activeItemId: string | null;
  items: OverlayRestoreItem[];
}

export type OverlayRebindStatus = "checking" | "restored" | "missing" | "ambiguous";

export interface OverlayRebindStatusItem {
  itemId: string;
  status: OverlayRebindStatus;
}

export interface OverlayRebindStatusData {
  origin: string;
  pathname: string;
  items: OverlayRebindStatusItem[];
}

export interface CaptureObservationGetMessage {
  type: typeof UI_ATTACH_CAPTURE_OBSERVATION_GET;
  origin: string;
  pathname: string;
  itemId: string;
  attachmentId: string;
}

export type CaptureObservationStatus =
  | "observed"
  | "checking"
  | "missing"
  | "ambiguous"
  | "stale"
  | "unavailable";

export interface CaptureObservationData {
  itemId: string;
  attachmentId: string;
  origin: string;
  pathname: string;
  status: CaptureObservationStatus;
  observation: CaptureObservation | null;
}

export type SavedSessionRouteFrameKind = "top" | "embedded";

export interface SavedSessionRouteSegment {
  origin: string;
  pathname: string;
}

export interface SavedSessionRouteTarget {
  origin: string;
  pathname: string;
  frameKind: SavedSessionRouteFrameKind;
  routeChain?: SavedSessionRouteSegment[];
}

export interface SavedSessionRouteResolutionData {
  location: "current_page" | "original_tab";
  requiresHostPermission: boolean;
}

export interface RuntimeCaptureRouteSegment {
  frameId: number;
  documentId: string;
  origin: string;
  pathname: string;
}

export interface RuntimeCaptureRouteLease {
  epoch: string;
  tabId: number;
  selectedFrameId: number;
  segments: RuntimeCaptureRouteSegment[];
}

export interface RuntimeCaptureToken extends CaptureToken {
  routeLease: RuntimeCaptureRouteLease;
  /** Present only for the one capture explicitly armed by the user. */
  collectBasicDiagnostics?: true;
}

export type SessionCommand =
  | { type: "ui-attach:session-begin-capture"; replaceItemId: string | null }
  | { type: "ui-attach:content-selection-disable" }
  | { type: "ui-attach:element-selection-get" }
  | { type: "ui-attach:element-selection-set"; enabled: false }
  | {
      type: "ui-attach:element-selection-set";
      enabled: true;
      tabId: number;
      collectBasicDiagnostics?: true;
    }
  | { type: "ui-attach:frame-scope-list" }
  | {
      type: "ui-attach:frame-scope-select";
      tabId: number;
      frameId: number;
      documentId: string | null;
      origin: string;
      pathname: string;
      startSelection: boolean;
    }
  | {
      type: "ui-attach:embedded-frame-selection-resolve";
      itemId: string;
      tabId: number;
      pageOrigin: string;
      pagePathname: string;
      parentFrameId: number;
      frameOrigin: string;
      framePathname: string;
    }
  | {
      type: "ui-attach:embedded-frame-selection-activate";
      itemId: string;
      tabId: number;
      pageOrigin: string;
      pagePathname: string;
      parentFrameId: number;
      sourceFrameOrigin: string;
      sourceFramePathname: string;
      frameOrigin: string;
      framePathname: string;
    }
  | {
      type: "ui-attach:embedded-frame-selection-set";
      tabId: number;
      pageOrigin: string;
      pagePathname: string;
      parentFrameId: number;
      frameOrigin: string;
      framePathname: string;
    }
  | {
      type: "ui-attach:session-commit-capture";
      token: RuntimeCaptureToken;
      record: OriginCaptureRecord;
      metadataDiagnosticsDevice?: MetadataDiagnosticsDeviceV1;
    }
  | { type: "ui-attach:content-settings-get" }
  | { type: typeof UI_ATTACH_OVERLAY_VISIBILITY_GET }
  | { type: typeof UI_ATTACH_OVERLAY_SCOPE_VISIBILITY_GET }
  | { type: typeof UI_ATTACH_OVERLAY_DISPLAY_MODE_GET }
  | { type: typeof UI_ATTACH_OVERLAYS_RESTORE_GET }
  | OverlayProjectionAckMessage
  | OverlayActionRequestMessage
  | { type: "ui-attach:session-get-active" }
  | { type: "ui-attach:session-list-stored" }
  | { type: "ui-attach:session-review-stored"; origin: string }
  | { type: "ui-attach:saved-session-restore-current"; origin: string }
  | ({ type: "ui-attach:saved-session-resolve-route" } & SavedSessionRouteTarget)
  | ({ type: "ui-attach:saved-session-restore-route" } & SavedSessionRouteTarget)
  | {
      type: "ui-attach:session-prepare-snapshot-handoff";
      origin: string;
      epoch: string;
    }
  | { type: "ui-attach:session-clear-all-stored" }
  | { type: "ui-attach:overlays-sync"; origin: string; activeItemId: string | null }
  | { type: typeof UI_ATTACH_OVERLAY_PREVIEW; origin: string; itemId: string | null }
  | {
      type: typeof UI_ATTACH_OVERLAY_RELATION_PREVIEW;
      origin: string;
      sourceItemId: string;
      referenceItemId: string;
    }
  | {
      type: "ui-attach:session-update-intent";
      origin: string;
      epoch: string;
      itemId: string;
      intent: string;
    }
  | {
      type: "ui-attach:session-update-annotation-lifecycle";
      origin: string;
      epoch: string;
      itemId: string;
      annotationId: string;
      expectedState: CaptureSessionAnnotationLifecycleStateV3;
      nextState: CaptureSessionAnnotationLifecycleStateV3;
    }
  | { type: "ui-attach:session-remove-item"; origin: string; epoch: string; itemId: string }
  | { type: "ui-attach:session-clear"; origin: string; epoch: string | null; operationId: string }
  | { type: "ui-attach:session-clear-stored-origin"; origin: string; epoch: string | null; operationId: string };

export type SessionCommandResponse<T> =
  | { ok: true; data: T }
  | {
      ok: false;
      code: string;
      error: string;
      issues?: Array<{ path: string; message: string }>;
    };

export type CaptureObservationResponse = SessionCommandResponse<CaptureObservationData>;

export interface ActivePageContext {
  tabId: number;
  frameId: number;
  origin: string;
  pathname: string;
  documentId?: string;
}

export interface ActiveSessionCommandData {
  enabled: boolean;
  origin: string | null;
  readback: ActiveSessionReadback | null;
  activePage: ActivePageContext | null;
  selectedItemId?: string | null;
  currentItemIds?: string[];
  /** Ephemeral, capture-bound diagnostics; never part of the durable session file. */
  metadataDiagnostics?: MetadataDiagnosticsV1;
}

export function isEmbeddedFrameHostInspectMessage(
  value: unknown,
): value is EmbeddedFrameHostInspectMessage {
  return isRecord(value) &&
    hasOnlyKeys(value, ["type", "locators"]) &&
    value.type === UI_ATTACH_EMBEDDED_FRAME_HOST_INSPECT &&
    Array.isArray(value.locators) &&
    value.locators.length > 0 &&
    value.locators.length <= OVERLAY_RESTORE_MAX_LOCATORS &&
    value.locators.every(isOverlayReplayLocator);
}

export function isContentReadyGetMessage(value: unknown): value is ContentReadyGetMessage {
  return isRecord(value) &&
    value.type === UI_ATTACH_CONTENT_READY_GET &&
    hasExactKeys(value, ["type", "protocolVersion"]) &&
    value.protocolVersion === UI_ATTACH_CONTENT_PROTOCOL_VERSION;
}

export function isEmbeddedFrameHostInspectResponse(
  value: unknown,
): value is { ok: true; data: EmbeddedFrameHostInspectData } {
  if (
    !isRecord(value) ||
    !hasOnlyKeys(value, ["ok", "data"]) ||
    value.ok !== true ||
    !isRecord(value.data) ||
    !hasOnlyKeys(value.data, [
      "frameHostCount",
      "frameOrigin",
      "framePathname",
    ]) ||
    typeof value.data.frameHostCount !== "number" ||
    !Number.isInteger(value.data.frameHostCount) ||
    value.data.frameHostCount < 0 ||
    value.data.frameHostCount > 1024
  ) return false;
  if (value.data.frameOrigin === null || value.data.framePathname === null) {
    return value.data.frameOrigin === null && value.data.framePathname === null;
  }
  return isCanonicalHttpOrigin(value.data.frameOrigin) &&
    isCanonicalPathname(value.data.framePathname, value.data.frameOrigin);
}

export function isCaptureFailedMessage(message: unknown): message is CaptureFailedMessage {
  return (
    isRecord(message) &&
    message.type === UI_ATTACH_CAPTURE_FAILED &&
    typeof message.error === "string"
  );
}

export function isSelectionSeedContextTargetMessage(
  value: unknown,
): value is SelectionSeedContextTargetMessage {
  return (
    isRecord(value) &&
    hasOnlyKeys(value, ["type"]) &&
    value.type === UI_ATTACH_SELECTION_SEED_CONTEXT_TARGET
  );
}

export function isCaptureCommitResponse(
  value: unknown,
): value is SessionCommandResponse<CaptureCommitReceipt> {
  if (!isRecord(value) || typeof value.ok !== "boolean") return false;
  if (value.ok === false) {
    return (
      hasOnlyKeys(value, ["ok", "code", "error", "issues"]) &&
      typeof value.code === "string" &&
      typeof value.error === "string" &&
      (value.issues === undefined || isCommandIssues(value.issues))
    );
  }
  return (
    hasOnlyKeys(value, ["ok", "data"]) &&
    isRecord(value.data) &&
    hasOnlyKeys(value.data, ["origin", "epoch", "itemId", "annotationLabel"]) &&
    isCanonicalHttpOrigin(value.data.origin) &&
    typeof value.data.epoch === "string" &&
    value.data.epoch.length > 0 &&
    typeof value.data.itemId === "string" &&
    value.data.itemId.length > 0 &&
    typeof value.data.annotationLabel === "string" &&
    /^(?:[1-9]|1[0-9]|2[0-6])$/u.test(value.data.annotationLabel)
  );
}

export function isOverlayStateMessage(value: unknown): value is OverlayStateMessage {
  if (!isRecord(value) ||
      !hasOnlyKeys(value, ["type", "origin", "projection", "activeItemId", "items"]) ||
      value.type !== UI_ATTACH_OVERLAY_STATE ||
      !isCanonicalHttpOrigin(value.origin) ||
      !isOverlayProjectionDescriptor(value.projection) ||
      value.projection.subject.origin !== value.origin ||
      !Array.isArray(value.items) ||
      value.items.length > OVERLAY_RESTORE_MAX_ITEMS) return false;
  const itemIds = new Set<string>();
  const labels = new Set<string>();
  if (!value.items.every((item) => isOverlayStateItem(item, itemIds, labels, false))) return false;
  return value.activeItemId === null || (
    isBoundedOverlayIdentity(value.activeItemId, OVERLAY_ACTION_ITEM_ID_MAX_LENGTH) &&
    itemIds.has(value.activeItemId)
  );
}

export function isOverlayPreviewMessage(value: unknown): value is OverlayPreviewMessage {
  return (
    isRecord(value) &&
    hasOnlyKeys(value, ["type", "origin", "pathname", "itemId"]) &&
    value.type === UI_ATTACH_OVERLAY_PREVIEW &&
    isBoundedCanonicalHttpOrigin(value.origin) &&
    isBoundedCanonicalPathname(value.pathname, value.origin) &&
    (value.itemId === null || (typeof value.itemId === "string" && value.itemId.length > 0))
  );
}

export function isOverlayActionRequestMessage(
  value: unknown,
): value is OverlayActionRequestMessage {
  if (!isRecord(value) || value.type !== UI_ATTACH_OVERLAY_ACTION_REQUEST ||
      !isOverlayActionRequestAction(value.action) || typeof value.itemId !== "string" ||
      value.itemId.length === 0 || value.itemId.length > OVERLAY_ACTION_ITEM_ID_MAX_LENGTH ||
      /\p{Cc}/u.test(value.itemId) || !isOverlayProjectionRef(value.projection)) return false;
  if (value.action === "save") {
    return hasOnlyKeys(value, ["type", "action", "itemId", "taskNote", "projection"]) &&
      typeof value.taskNote === "string" && value.taskNote.length <= OVERLAY_TASK_NOTE_MAX_LENGTH;
  }
  return hasOnlyKeys(value, ["type", "action", "itemId", "projection"]);
}

export function isOverlayProjectionAckMessage(
  value: unknown,
): value is OverlayProjectionAckMessage {
  return isRecord(value) &&
    hasOnlyKeys(value, ["type", "projection"]) &&
    value.type === UI_ATTACH_OVERLAY_PROJECTION_ACK &&
    isOverlayProjectionRef(value.projection);
}

export function isClearProjectionTombstoneMessage(
  value: unknown,
): value is ClearProjectionTombstoneMessage {
  return isRecord(value) &&
    hasExactKeys(value, ["type", "clear"]) &&
    value.type === UI_ATTACH_CLEAR_PROJECTION &&
    isClearProjectionReference(value.clear);
}

export function isClearProjectionAckMessage(
  value: unknown,
): value is ClearProjectionAckMessage {
  if (!isRecord(value) || !hasExactKeys(value, ["type", "clear", "readback"]) ||
      value.type !== UI_ATTACH_CLEAR_PROJECTION_ACK ||
      !isClearProjectionReference(value.clear) || !isRecord(value.readback) ||
      !hasExactKeys(value.readback, [
        "appliedItemIds",
        "markerCount",
        "selectionPreviewActive",
        "digest",
      ])) return false;
  return Array.isArray(value.readback.appliedItemIds) &&
    value.readback.appliedItemIds.length === 0 &&
    value.readback.markerCount === 0 &&
    value.readback.selectionPreviewActive === false &&
    value.readback.digest === UI_ATTACH_EMPTY_APPLIED_ITEM_IDS_DIGEST;
}

export function isOverlayPreviewForPage(
  message: OverlayPreviewMessage,
  page: { origin: string; pathname: string },
): boolean {
  return message.origin === page.origin &&
    (message.itemId === null || message.pathname === page.pathname);
}

export function isOverlayRelationPreviewMessage(
  value: unknown,
): value is OverlayRelationPreviewMessage {
  return (
    isRecord(value) &&
    hasOnlyKeys(value, [
      "type",
      "origin",
      "pathname",
      "sourceItemId",
      "referenceItemId",
    ]) &&
    value.type === UI_ATTACH_OVERLAY_RELATION_PREVIEW &&
    isBoundedCanonicalHttpOrigin(value.origin) &&
    isBoundedCanonicalPathname(value.pathname, value.origin) &&
    typeof value.sourceItemId === "string" &&
    value.sourceItemId.length > 0 &&
    typeof value.referenceItemId === "string" &&
    value.referenceItemId.length > 0 &&
    value.sourceItemId !== value.referenceItemId
  );
}

export function isOverlayRelationPreviewForPage(
  message: OverlayRelationPreviewMessage,
  page: { origin: string; pathname: string },
): boolean {
  return message.origin === page.origin && message.pathname === page.pathname;
}

export function isOverlayRestoreResponse(
  value: unknown,
): value is { ok: true; data: OverlayRestoreData } {
  if (
    !isRecord(value) ||
    !hasOnlyKeys(value, ["ok", "data"]) ||
    value.ok !== true
  ) {
    return false;
  }

  const data = value.data;
  if (
    !isRecord(data) ||
    !hasOnlyKeys(data, ["origin", "projection", "activeItemId", "items"]) ||
    !isCanonicalHttpOrigin(data.origin) ||
    !isOverlayProjectionDescriptor(data.projection) ||
    data.projection.subject.origin !== data.origin ||
    !Array.isArray(data.items) ||
    data.items.length > OVERLAY_RESTORE_MAX_ITEMS
  ) {
    return false;
  }
  const items = data.items;
  const itemIds = new Set<string>();
  const labels = new Set<string>();
  const itemsAreValid = items.every((item) => (
    isOverlayStateItem(item, itemIds, labels, true) &&
    (item.anchor === undefined || (
      isRecord(item.anchor) &&
      hasOnlyKeys(item.anchor, ["xRatio", "yRatio"]) &&
      typeof item.anchor.xRatio === "number" &&
      Number.isFinite(item.anchor.xRatio) &&
      item.anchor.xRatio >= 0 && item.anchor.xRatio <= 1 &&
      typeof item.anchor.yRatio === "number" &&
      Number.isFinite(item.anchor.yRatio) &&
      item.anchor.yRatio >= 0 && item.anchor.yRatio <= 1
    )) &&
    Array.isArray(item.locators) &&
    item.locators.length > 0 &&
    item.locators.length <= OVERLAY_RESTORE_MAX_LOCATORS &&
    item.locators.every(isOverlayReplayLocator)
  ));
  if (!itemsAreValid) return false;

  return data.activeItemId === null || (
    isBoundedOverlayIdentity(data.activeItemId, OVERLAY_ACTION_ITEM_ID_MAX_LENGTH) &&
    itemIds.has(data.activeItemId)
  );
}

export function isOverlayVisibilityUpdatedMessage(
  value: unknown,
): value is OverlayVisibilityUpdatedMessage {
  return (
    isRecord(value) &&
    hasOnlyKeys(value, ["type", "visible"]) &&
    value.type === UI_ATTACH_OVERLAY_VISIBILITY_UPDATED &&
    typeof value.visible === "boolean"
  );
}

export function isOverlayScopeVisibilityUpdatedMessage(
  value: unknown,
): value is OverlayScopeVisibilityUpdatedMessage {
  return (
    isRecord(value) &&
    hasOnlyKeys(value, ["type", "visible"]) &&
    value.type === UI_ATTACH_OVERLAY_SCOPE_VISIBILITY_UPDATED &&
    typeof value.visible === "boolean"
  );
}

export function isOverlayDisplayModeUpdatedMessage(
  value: unknown,
): value is OverlayDisplayModeUpdatedMessage {
  return isRecord(value) && hasOnlyKeys(value, ["type", "displayMode"]) &&
    value.type === UI_ATTACH_OVERLAY_DISPLAY_MODE_UPDATED &&
    (value.displayMode === "full" || value.displayMode === "hover" ||
      value.displayMode === "markers" || value.displayMode === "hidden")
}

export function isOverlayRebindStatusGetMessage(
  value: unknown,
): value is { type: typeof UI_ATTACH_OVERLAY_REBIND_STATUS_GET } {
  return isRecord(value) &&
    hasOnlyKeys(value, ["type"]) &&
    value.type === UI_ATTACH_OVERLAY_REBIND_STATUS_GET;
}

export function isCaptureObservationGetMessage(
  value: unknown,
): value is CaptureObservationGetMessage {
  return isRecord(value) &&
    hasExactKeys(value, ["type", "origin", "pathname", "itemId", "attachmentId"]) &&
    value.type === UI_ATTACH_CAPTURE_OBSERVATION_GET &&
    isBoundedCanonicalHttpOrigin(value.origin) &&
    isBoundedCanonicalPathname(value.pathname, value.origin) &&
    isBoundedOverlayIdentity(value.itemId, OVERLAY_ACTION_ITEM_ID_MAX_LENGTH) &&
    isBoundedOverlayIdentity(value.attachmentId, OVERLAY_ATTACHMENT_ID_MAX_LENGTH);
}

export function isCaptureObservationResponse(
  value: unknown,
): value is CaptureObservationResponse {
  if (!isRecord(value) || typeof value.ok !== "boolean") return false;
  if (value.ok === false) {
    return hasOnlyKeys(value, ["ok", "code", "error", "issues"]) &&
      Object.hasOwn(value, "ok") &&
      Object.hasOwn(value, "code") &&
      Object.hasOwn(value, "error") &&
      typeof value.code === "string" &&
      typeof value.error === "string" &&
      (value.issues === undefined || isCommandIssues(value.issues));
  }
  if (!hasExactKeys(value, ["ok", "data"]) || !isRecord(value.data)) return false;
  const data = value.data;
  if (!hasExactKeys(data, [
    "itemId",
    "attachmentId",
    "origin",
    "pathname",
    "status",
    "observation",
  ]) ||
    !isBoundedOverlayIdentity(data.itemId, OVERLAY_ACTION_ITEM_ID_MAX_LENGTH) ||
    !isBoundedOverlayIdentity(data.attachmentId, OVERLAY_ATTACHMENT_ID_MAX_LENGTH) ||
    !isBoundedCanonicalHttpOrigin(data.origin) ||
    !isBoundedCanonicalPathname(data.pathname, data.origin) ||
    !isCaptureObservationStatus(data.status)) return false;
  return data.status === "observed"
    ? isCaptureObservation(data.observation)
    : data.observation === null;
}

export function isOverlayRestoreRefreshMessage(
  value: unknown,
): value is { type: typeof UI_ATTACH_OVERLAY_RESTORE_REFRESH } {
  return isRecord(value) &&
    hasOnlyKeys(value, ["type"]) &&
    value.type === UI_ATTACH_OVERLAY_RESTORE_REFRESH;
}

export function isOverlayRebindStatusResponse(
  value: unknown,
): value is { ok: true; data: OverlayRebindStatusData } {
  if (
    !isRecord(value) ||
    !hasOnlyKeys(value, ["ok", "data"]) ||
    value.ok !== true ||
    !isRecord(value.data)
  ) return false;
  const data = value.data;
  if (
    !hasOnlyKeys(data, ["origin", "pathname", "items"]) ||
    !isCanonicalHttpOrigin(data.origin) ||
    !isCanonicalPathname(data.pathname, data.origin) ||
    !Array.isArray(data.items) ||
    data.items.length > OVERLAY_RESTORE_MAX_ITEMS
  ) return false;
  const itemIds = new Set<string>();
  return data.items.every((item) => {
    if (
      !isRecord(item) ||
      !hasOnlyKeys(item, ["itemId", "status"]) ||
      typeof item.itemId !== "string" ||
      item.itemId.length === 0 ||
      itemIds.has(item.itemId) ||
      !isOverlayRebindStatus(item.status)
    ) return false;
    itemIds.add(item.itemId);
    return true;
  });
}

function isOverlayRebindStatus(value: unknown): value is OverlayRebindStatus {
  return value === "checking" || value === "restored" ||
    value === "missing" || value === "ambiguous";
}

function isCaptureObservationStatus(value: unknown): value is CaptureObservationStatus {
  return value === "observed" || value === "checking" || value === "missing" ||
    value === "ambiguous" || value === "stale" || value === "unavailable";
}

function isOverlayReplayLocator(value: unknown): value is OverlayReplayLocator {
  return (
    isRecord(value) &&
    hasOnlyKeys(value, ["strategy", "value", "confidence"]) &&
    isOverlayReplayLocatorStrategy(value.strategy) &&
    typeof value.value === "string" &&
    value.value.length > 0 &&
    value.value.length <= OVERLAY_REPLAY_LOCATOR_VALUE_MAX_LENGTH &&
    typeof value.confidence === "number" &&
    Number.isFinite(value.confidence) &&
    value.confidence >= 0 &&
    value.confidence <= 1
  );
}

function isOverlayStateItem(
  value: unknown,
  itemIds: Set<string>,
  labels: Set<string>,
  restore: boolean,
): value is OverlayRestoreItem {
  if (!isRecord(value) ||
      !hasOnlyKeys(value, restore
        ? ["itemId", "attachmentId", "label", "taskNote", "anchor", "locators"]
        : ["itemId", "attachmentId", "label", "taskNote"]) ||
      !isBoundedOverlayIdentity(value.itemId, OVERLAY_ACTION_ITEM_ID_MAX_LENGTH) ||
      !isBoundedOverlayIdentity(value.attachmentId, OVERLAY_ATTACHMENT_ID_MAX_LENGTH) ||
      typeof value.label !== "string" ||
      !/^(?:[1-9]|1[0-9]|2[0-6])$/u.test(value.label) ||
      typeof value.taskNote !== "string" ||
      value.taskNote.length > OVERLAY_TASK_NOTE_MAX_LENGTH ||
      itemIds.has(value.itemId) || labels.has(value.label)) return false;
  itemIds.add(value.itemId);
  labels.add(value.label);
  return true;
}

function isBoundedOverlayIdentity(value: unknown, maxLength: number): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= maxLength &&
    !/\p{Cc}/u.test(value);
}

function isOverlayReplayLocatorStrategy(
  value: unknown,
): value is OverlayReplayLocatorStrategy {
  return value === "playwright.role" ||
    value === "playwright.label" ||
    value === "playwright.testId" ||
    value === "playwright.text" ||
    value === "playwright.altText" ||
    value === "playwright.title" ||
    value === "playwright.placeholder" ||
    value === "css";
}

function isOverlayActionRequestAction(value: unknown): value is OverlayActionRequestAction {
  return value === "edit" || value === "remove" || value === "more" || value === "save";
}

export function isOverlayProjectionRef(value: unknown): value is OverlayProjectionRef {
  return isRecord(value) &&
    hasOnlyKeys(value, ["version", "projectionId", "revision"]) &&
    value.version === UI_ATTACH_OVERLAY_PROJECTION_VERSION &&
    typeof value.projectionId === "string" &&
    value.projectionId.length > 0 &&
    value.projectionId.length <= OVERLAY_PROJECTION_ID_MAX_LENGTH &&
    !/\p{Cc}/u.test(value.projectionId) &&
    Number.isSafeInteger(value.revision) &&
    (value.revision as number) > 0;
}

export function isOverlayProjectionDescriptor(
  value: unknown,
): value is OverlayProjectionDescriptor {
  if (!isRecord(value) ||
      !hasOnlyKeys(value, ["version", "projectionId", "revision", "sessionEpoch", "subject"]) ||
      !isOverlayProjectionRef({
        version: value.version,
        projectionId: value.projectionId,
        revision: value.revision,
      }) ||
      !(value.sessionEpoch === null || (
        typeof value.sessionEpoch === "string" &&
        value.sessionEpoch.length > 0 &&
        value.sessionEpoch.length <= OVERLAY_PROJECTION_ID_MAX_LENGTH &&
        !/\p{Cc}/u.test(value.sessionEpoch)
      ))) return false;
  return isOverlayProjectionSubject(value.subject);
}

export function isClearProjectionReference(
  value: unknown,
): value is ClearProjectionReference {
  return isRecord(value) && hasExactKeys(value, [
    "version",
    "authorityId",
    "operationId",
    "generation",
    "origin",
    "afterEpoch",
    "subject",
    "projectionId",
    "revision",
  ]) && value.version === UI_ATTACH_CLEAR_PROJECTION_VERSION &&
    isBoundedClearProjectionIdentity(value.authorityId, 128) &&
    isBoundedClearProjectionIdentity(value.operationId, 128) &&
    Number.isSafeInteger(value.generation) && (value.generation as number) > 0 &&
    isBoundedCanonicalHttpOrigin(value.origin) &&
    isBoundedClearProjectionIdentity(value.afterEpoch, 128) &&
    isClearProjectionSubject(value.subject) &&
    isBoundedClearProjectionIdentity(value.subject.documentId, 256) &&
    value.subject.origin === value.origin &&
    isBoundedClearProjectionIdentity(
      value.projectionId,
      OVERLAY_PROJECTION_ID_MAX_LENGTH,
    ) &&
    Number.isSafeInteger(value.revision) && (value.revision as number) > 0;
}

function isBoundedClearProjectionIdentity(value: unknown, maxLength: number): value is string {
  return isBoundedOverlayIdentity(value, maxLength) && value.trim() === value;
}

function isOverlayProjectionSubject(
  subject: unknown,
): subject is OverlayProjectionDescriptor["subject"] {
  return isRecord(subject) &&
    hasOnlyKeys(subject, ["tabId", "frameId", "documentId", "origin", "pathname"]) &&
    Number.isSafeInteger(subject.tabId) && (subject.tabId as number) >= 0 &&
    Number.isSafeInteger(subject.frameId) && (subject.frameId as number) >= 0 &&
    typeof subject.documentId === "string" &&
    subject.documentId.length > 0 &&
    subject.documentId.length <= OVERLAY_PROJECTION_DOCUMENT_ID_MAX_LENGTH &&
    !/\p{Cc}/u.test(subject.documentId) &&
    isBoundedCanonicalHttpOrigin(subject.origin) &&
    isBoundedCanonicalPathname(subject.pathname, subject.origin);
}

function isClearProjectionSubject(
  subject: unknown,
): subject is OverlayProjectionDescriptor["subject"] {
  return isRecord(subject) &&
    hasExactKeys(subject, ["tabId", "frameId", "documentId", "origin", "pathname"]) &&
    isOverlayProjectionSubject(subject);
}

function isBoundedCanonicalHttpOrigin(value: unknown): value is string {
  return typeof value === "string" && value.length <= 2048 && isCanonicalHttpOrigin(value);
}

function isBoundedCanonicalPathname(value: unknown, origin: string): value is string {
  return typeof value === "string" && value.length <= 8192 &&
    isCanonicalPathname(value, origin);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function hasOnlyKeys(value: Record<string, unknown>, allowedKeys: string[]): boolean {
  const allowed = new Set(allowedKeys);
  return Object.keys(value).every((key) => allowed.has(key));
}

function hasExactKeys(value: Record<string, unknown>, expectedKeys: readonly string[]): boolean {
  const keys = Object.keys(value);
  return keys.length === expectedKeys.length &&
    expectedKeys.every((key) => Object.hasOwn(value, key));
}

function isCommandIssues(value: unknown): boolean {
  return Array.isArray(value) && value.every((issue) => (
    isRecord(issue) &&
    hasOnlyKeys(issue, ["path", "message"]) &&
    typeof issue.path === "string" &&
    typeof issue.message === "string"
  ));
}

function isCanonicalHttpOrigin(value: unknown): value is string {
  if (typeof value !== "string") return false;
  try {
    const url = new URL(value);
    return (url.protocol === "http:" || url.protocol === "https:") && url.origin === value;
  } catch {
    return false;
  }
}

function isCanonicalPathname(value: unknown, origin: string): value is string {
  if (typeof value !== "string" || !value.startsWith("/")) return false;
  try {
    const url = new URL(value, `${origin}/`);
    return url.origin === origin && url.pathname === value && url.search === "" && url.hash === "";
  } catch {
    return false;
  }
}
