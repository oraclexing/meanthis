import type {
  UIAttachmentDisclosureMode,
  UIAttachmentLocator,
  UILocatorStrategy,
} from "@meanthis/schema";
import type { OriginCaptureRecord } from "./capture-store";
import type { ActiveSessionReadback } from "./session-store";
import type { CaptureToken } from "./session-state";

export const UI_ATTACH_CONTEXT_MENU_ID = "meanthis-add-page-element";
export const UI_ATTACH_CONTENT_READY_GET = "ui-attach:content-ready-get";
export const UI_ATTACH_EMBEDDED_FRAME_HOST_INSPECT = "ui-attach:embedded-frame-host-inspect";
export const UI_ATTACH_CAPTURE_FAILED = "ui-attach:capture-failed";
export const UI_ATTACH_SESSION_UPDATED = "ui-attach:session-updated";
export const UI_ATTACH_ACTIVE_ORIGIN_CHANGED = "ui-attach:active-origin-changed";
export const UI_ATTACH_CONTENT_DEACTIVATE = "ui-attach:content-deactivate";
export const UI_ATTACH_ELEMENT_SELECTION_UPDATED = "ui-attach:element-selection-updated";
export const UI_ATTACH_SELECTION_LIFECYCLE_PORT = "ui-attach:selection-lifecycle";
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
export const UI_ATTACH_OVERLAY_VISIBILITY_GET = "ui-attach:overlay-visibility-get";
export const UI_ATTACH_OVERLAY_VISIBILITY_UPDATED = "ui-attach:overlay-visibility-updated";
export const OVERLAY_RESTORE_MAX_ITEMS = 26;
export const OVERLAY_RESTORE_MAX_LOCATORS = 8;

export interface CaptureFailedMessage {
  type: typeof UI_ATTACH_CAPTURE_FAILED;
  error: string;
}

export interface SessionUpdatedMessage {
  type: typeof UI_ATTACH_SESSION_UPDATED;
  origin: string;
  itemId: string;
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
  testClickCaptureEnabled: boolean;
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

export interface CaptureCommitReceipt {
  origin: string;
  epoch: string;
  itemId: string;
  label: string;
}

export interface OverlayStateItem {
  itemId: string;
  attachmentId: string;
  label: string;
}

export interface OverlayStateMessage {
  type: typeof UI_ATTACH_OVERLAY_STATE;
  origin: string;
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

export interface OverlayRestoreItem extends OverlayStateItem {
  locators: OverlayReplayLocator[];
}

export interface OverlayRestoreData {
  origin: string;
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

export type SessionCommand =
  | { type: "ui-attach:session-begin-capture" }
  | { type: "ui-attach:content-selection-disable" }
  | { type: "ui-attach:element-selection-get" }
  | { type: "ui-attach:element-selection-set"; enabled: false }
  | { type: "ui-attach:element-selection-set"; enabled: true; tabId: number }
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
  | { type: "ui-attach:session-commit-capture"; token: CaptureToken; record: OriginCaptureRecord }
  | { type: "ui-attach:content-settings-get" }
  | { type: typeof UI_ATTACH_OVERLAY_VISIBILITY_GET }
  | { type: typeof UI_ATTACH_OVERLAYS_RESTORE_GET }
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
  | { type: "ui-attach:session-remove-item"; origin: string; epoch: string; itemId: string }
  | { type: "ui-attach:session-clear"; origin: string; epoch: string | null; operationId: string };

export type SessionCommandResponse<T> =
  | { ok: true; data: T }
  | {
      ok: false;
      code: string;
      error: string;
      issues?: Array<{ path: string; message: string }>;
    };

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
    hasOnlyKeys(value.data, ["origin", "epoch", "itemId", "label"]) &&
    isCanonicalHttpOrigin(value.data.origin) &&
    typeof value.data.epoch === "string" &&
    value.data.epoch.length > 0 &&
    typeof value.data.itemId === "string" &&
    value.data.itemId.length > 0 &&
    typeof value.data.label === "string" &&
    value.data.label.length > 0
  );
}

export function isOverlayStateMessage(value: unknown): value is OverlayStateMessage {
  return (
    isRecord(value) &&
    hasOnlyKeys(value, ["type", "origin", "activeItemId", "items"]) &&
    value.type === UI_ATTACH_OVERLAY_STATE &&
    isCanonicalHttpOrigin(value.origin) &&
    (value.activeItemId === null || (typeof value.activeItemId === "string" && value.activeItemId.length > 0)) &&
    Array.isArray(value.items) &&
    value.items.every((item) => (
      isRecord(item) &&
      hasOnlyKeys(item, ["itemId", "attachmentId", "label"]) &&
      typeof item.itemId === "string" && item.itemId.length > 0 &&
      typeof item.attachmentId === "string" && item.attachmentId.length > 0 &&
      typeof item.label === "string" && item.label.length > 0
    ))
  );
}

export function isOverlayPreviewMessage(value: unknown): value is OverlayPreviewMessage {
  return (
    isRecord(value) &&
    hasOnlyKeys(value, ["type", "origin", "pathname", "itemId"]) &&
    value.type === UI_ATTACH_OVERLAY_PREVIEW &&
    isCanonicalHttpOrigin(value.origin) &&
    isCanonicalPathname(value.pathname, value.origin) &&
    (value.itemId === null || (typeof value.itemId === "string" && value.itemId.length > 0))
  );
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
    isCanonicalHttpOrigin(value.origin) &&
    isCanonicalPathname(value.pathname, value.origin) &&
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
    !hasOnlyKeys(data, ["origin", "activeItemId", "items"]) ||
    !isCanonicalHttpOrigin(data.origin) ||
    !Array.isArray(data.items) ||
    data.items.length > OVERLAY_RESTORE_MAX_ITEMS
  ) {
    return false;
  }
  const items = data.items;
  const itemsAreValid = items.every((item) => (
    isRecord(item) &&
    hasOnlyKeys(item, ["itemId", "attachmentId", "label", "locators"]) &&
    typeof item.itemId === "string" && item.itemId.length > 0 &&
    typeof item.attachmentId === "string" && item.attachmentId.length > 0 &&
    typeof item.label === "string" && item.label.length > 0 &&
    Array.isArray(item.locators) &&
    item.locators.length > 0 &&
    item.locators.length <= OVERLAY_RESTORE_MAX_LOCATORS &&
    item.locators.every(isOverlayReplayLocator)
  ));
  if (!itemsAreValid) return false;

  return data.activeItemId === null || (
    typeof data.activeItemId === "string" &&
    data.activeItemId.length > 0 &&
    items.some((item) => (
      isRecord(item) && item.itemId === data.activeItemId
    ))
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

export function isOverlayRebindStatusGetMessage(
  value: unknown,
): value is { type: typeof UI_ATTACH_OVERLAY_REBIND_STATUS_GET } {
  return isRecord(value) &&
    hasOnlyKeys(value, ["type"]) &&
    value.type === UI_ATTACH_OVERLAY_REBIND_STATUS_GET;
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

function isOverlayReplayLocator(value: unknown): value is OverlayReplayLocator {
  return (
    isRecord(value) &&
    hasOnlyKeys(value, ["strategy", "value", "confidence"]) &&
    isOverlayReplayLocatorStrategy(value.strategy) &&
    typeof value.value === "string" &&
    value.value.length > 0 &&
    typeof value.confidence === "number" &&
    Number.isFinite(value.confidence) &&
    value.confidence >= 0 &&
    value.confidence <= 1
  );
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function hasOnlyKeys(value: Record<string, unknown>, allowedKeys: string[]): boolean {
  const allowed = new Set(allowedKeys);
  return Object.keys(value).every((key) => allowed.has(key));
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
