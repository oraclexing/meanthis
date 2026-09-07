export const UI_ATTACH_IN_PAGE_WIDGET_REGISTER = "ui-attach:in-page-widget-register";
export const UI_ATTACH_IN_PAGE_WIDGET_COMMAND = "ui-attach:in-page-widget-command";
export const UI_ATTACH_IN_PAGE_WIDGET_INIT = "ui-attach:in-page-widget-init";
export const UI_ATTACH_IN_PAGE_WIDGET_ENSURE = "ui-attach:in-page-widget-ensure";
export const UI_ATTACH_IN_PAGE_WIDGET_ACTION = "ui-attach:in-page-widget-action";
export const UI_ATTACH_IN_PAGE_WIDGET_ACTION_ACK = "ui-attach:in-page-widget-action-ack";
export const UI_ATTACH_IN_PAGE_WIDGET_LIFECYCLE_PORT_PREFIX =
  "ui-attach:in-page-widget-lifecycle";
export const UI_ATTACH_IN_PAGE_WIDGET_READY = "ui-attach:in-page-widget-ready";
export const UI_ATTACH_IN_PAGE_WIDGET_PATH = "/widget.html";
export const UI_ATTACH_IN_PAGE_WIDGET_PHASE = "meanthis.widget.phase";

export type InPageWidgetPrivatePhase =
  | "private-port-received"
  | "runtime-register-missing-id"
  | "runtime-register-tab-context"
  | "runtime-register-frame-context"
  | "runtime-register-lease"
  | "runtime-register-top-inventory"
  | "runtime-register-widget-url"
  | "runtime-register-top-document"
  | "runtime-register-widget-document"
  | "runtime-register-top-route"
  | "runtime-register-invalid-response"
  | "runtime-register-handler-exception"
  | "runtime-register-untrusted-response"
  | "runtime-register-unknown-issue"
  | "runtime-register-exception"
  | "runtime-register-ok"
  | "lifecycle-ready"
  | "authenticated-ui-failed"
  | "authenticated-ui-ready";

export type InPageWidgetCommand =
  | { type: "ui-attach:widget-session-read" }
  | {
      type: "ui-attach:widget-task-note-save";
      expectedEpoch: string;
      itemId: string;
      taskNote: string;
    }
  | {
      type: "ui-attach:widget-item-remove";
      expectedEpoch: string;
      itemId: string;
    }
  | {
      type: "ui-attach:widget-annotation-lifecycle-set";
      expectedEpoch: string;
      itemId: string;
      annotationId: string;
      expectedState: "open" | "resolved";
      nextState: "open" | "resolved";
    }
  | {
      type: "ui-attach:widget-session-clear";
      expectedEpoch: string | null;
      operationId: string;
      scope: "live-page" | "active-origin";
    }
  | { type: "ui-attach:widget-selection-read" }
  | {
      type: "ui-attach:widget-selection-set";
      enabled: boolean;
      intent: "explicit" | "resume";
      expectedGeneration: number;
      collectBasicDiagnostics?: true;
    }
  | {
      type: "ui-attach:widget-basic-diagnostics-set";
      enabled: boolean;
      expectedGeneration: number;
    }
  | { type: "ui-attach:widget-frame-scope-list" }
  | {
      type: "ui-attach:widget-frame-scope-select";
      frameId: number;
      documentId: string | null;
      origin: string;
      pathname: string;
      expectedGeneration: number;
    }
  | { type: "ui-attach:widget-overlay-active"; itemId: string | null }
  | { type: "ui-attach:widget-side-panel-open" }
  | { type: "ui-attach:widget-bridge-read-status" }
  | { type: "ui-attach:widget-bridge-create-invitation" }
  | { type: "ui-attach:widget-bridge-refresh" }
  | { type: "ui-attach:widget-bridge-disconnect" }
  | { type: "ui-attach:widget-lifecycle-control-read-next" }
  | {
      type:
        | "ui-attach:widget-lifecycle-control-approve"
        | "ui-attach:widget-lifecycle-control-reject";
      reference: AnnotationLifecycleOperationReferenceV1;
      userActivation: true;
    }
  | { type: "ui-attach:widget-disclosure-read" }
  | { type: "ui-attach:widget-disclosure-acknowledge" }
  | { type: "ui-attach:widget-surface-release" };

export interface InPageWidgetRegistration {
  type: typeof UI_ATTACH_IN_PAGE_WIDGET_REGISTER;
  surfaceId: string;
  capability: string;
}

export interface InPageWidgetCommandEnvelope {
  type: typeof UI_ATTACH_IN_PAGE_WIDGET_COMMAND;
  surfaceId: string;
  capability: string;
  command: unknown;
}

export interface InPageWidgetInitMessage {
  type: typeof UI_ATTACH_IN_PAGE_WIDGET_INIT;
  schemaVersion: "1";
  surfaceId: string;
  capability: string;
}

export interface InPageWidgetEnsureMessage {
  type: typeof UI_ATTACH_IN_PAGE_WIDGET_ENSURE;
}

export interface InPageWidgetFrameMessage {
  type: "meanthis.widget.connect";
}

export interface InPageWidgetPhaseMessage {
  type: typeof UI_ATTACH_IN_PAGE_WIDGET_PHASE;
  phase: InPageWidgetPrivatePhase;
}

export interface InPageWidgetActionMessage {
  type: typeof UI_ATTACH_IN_PAGE_WIDGET_ACTION;
  surfaceId: string;
  actionId: string;
  action: "edit" | "remove" | "more";
  itemId: string;
}

export interface InPageWidgetActionAckMessage {
  type: typeof UI_ATTACH_IN_PAGE_WIDGET_ACTION_ACK;
  surfaceId: string;
  actionId: string;
  outcome: "consumed" | "rejected";
}

export interface InPageWidgetReadyMessage {
  type: typeof UI_ATTACH_IN_PAGE_WIDGET_READY;
  surfaceId: string;
}

export function createInPageWidgetLifecyclePortName(
  surfaceId: string,
  capability: string,
): string {
  if (!isUuid(surfaceId) || !isCapability(capability)) {
    throw new Error("Invalid MeanThis in-page widget lifecycle capability.");
  }
  return `${UI_ATTACH_IN_PAGE_WIDGET_LIFECYCLE_PORT_PREFIX}:${surfaceId}:${capability}`;
}

export function parseInPageWidgetLifecyclePortName(
  value: string,
): { surfaceId: string; capability: string } | null {
  const prefix = `${UI_ATTACH_IN_PAGE_WIDGET_LIFECYCLE_PORT_PREFIX}:`;
  if (!value.startsWith(prefix)) return null;
  const parts = value.slice(prefix.length).split(":");
  if (parts.length !== 2) return null;
  const [surfaceId, capability] = parts;
  return isUuid(surfaceId) && isCapability(capability) ? { surfaceId, capability } : null;
}

export function createInPageWidgetInitMessage(
  surfaceId: string,
  capability: string,
): InPageWidgetInitMessage {
  if (!isUuid(surfaceId) || !isCapability(capability)) {
    throw new Error("Invalid MeanThis in-page widget capability.");
  }
  return {
    type: UI_ATTACH_IN_PAGE_WIDGET_INIT,
    schemaVersion: "1",
    surfaceId,
    capability,
  };
}

export function parseInPageWidgetRegistration(value: unknown): InPageWidgetRegistration | null {
  if (!isRecord(value) || !hasExactKeys(value, ["type", "surfaceId", "capability"])) return null;
  return value.type === UI_ATTACH_IN_PAGE_WIDGET_REGISTER &&
      isUuid(value.surfaceId) && isCapability(value.capability)
    ? value as unknown as InPageWidgetRegistration
    : null;
}

export function parseInPageWidgetCommandEnvelope(
  value: unknown,
): InPageWidgetCommandEnvelope | null {
  if (!isRecord(value) || !hasExactKeys(value, ["type", "surfaceId", "capability", "command"])) {
    return null;
  }
  return value.type === UI_ATTACH_IN_PAGE_WIDGET_COMMAND &&
      isUuid(value.surfaceId) && isCapability(value.capability) && isRecord(value.command)
    ? value as unknown as InPageWidgetCommandEnvelope
    : null;
}

export function parseInPageWidgetInitMessage(value: unknown): InPageWidgetInitMessage | null {
  if (!isRecord(value) || !hasExactKeys(value, [
    "type",
    "schemaVersion",
    "surfaceId",
    "capability",
  ])) return null;
  return value.type === UI_ATTACH_IN_PAGE_WIDGET_INIT && value.schemaVersion === "1" &&
      isUuid(value.surfaceId) && isCapability(value.capability)
    ? value as unknown as InPageWidgetInitMessage
    : null;
}

export function isInPageWidgetEnsureMessage(value: unknown): value is InPageWidgetEnsureMessage {
  return isRecord(value) && hasExactKeys(value, ["type"]) &&
    value.type === UI_ATTACH_IN_PAGE_WIDGET_ENSURE;
}

export function isInPageWidgetFrameMessage(value: unknown): value is InPageWidgetFrameMessage {
  return isRecord(value) && hasExactKeys(value, ["type"]) && value.type === "meanthis.widget.connect";
}

export function parseInPageWidgetPhaseMessage(value: unknown): InPageWidgetPhaseMessage | null {
  if (!isRecord(value) || !hasExactKeys(value, ["type", "phase"]) ||
      value.type !== UI_ATTACH_IN_PAGE_WIDGET_PHASE) return null;
  return value.phase === "private-port-received" ||
      value.phase === "runtime-register-missing-id" ||
      value.phase === "runtime-register-tab-context" ||
      value.phase === "runtime-register-frame-context" ||
      value.phase === "runtime-register-lease" ||
      value.phase === "runtime-register-top-inventory" ||
      value.phase === "runtime-register-widget-url" ||
      value.phase === "runtime-register-top-document" ||
      value.phase === "runtime-register-widget-document" ||
      value.phase === "runtime-register-top-route" ||
      value.phase === "runtime-register-invalid-response" ||
      value.phase === "runtime-register-handler-exception" ||
      value.phase === "runtime-register-untrusted-response" ||
      value.phase === "runtime-register-unknown-issue" ||
      value.phase === "runtime-register-exception" || value.phase === "runtime-register-ok" ||
      value.phase === "lifecycle-ready" || value.phase === "authenticated-ui-failed" ||
      value.phase === "authenticated-ui-ready"
    ? value as unknown as InPageWidgetPhaseMessage
    : null;
}

export function isInPageWidgetPrivateConnectEvent(
  event: Pick<MessageEvent, "data" | "ports" | "source">,
  parent: WindowProxy,
): boolean {
  // Chrome redacts `source` to null when a privileged extension context posts
  // into a web-accessible extension frame. The transferred port carries only a
  // candidate; the background still authenticates its unpersisted capability
  // against the exact tab, top document, widget frame, route, and lease.
  return (event.source === parent || event.source === null) &&
    event.ports.length === 1 && isInPageWidgetFrameMessage(event.data);
}

export function parseInPageWidgetActionMessage(value: unknown): InPageWidgetActionMessage | null {
  if (!isRecord(value) || !hasExactKeys(value, [
    "type", "surfaceId", "actionId", "action", "itemId",
  ])) {
    return null;
  }
  return value.type === UI_ATTACH_IN_PAGE_WIDGET_ACTION && isUuid(value.surfaceId) &&
      isUuid(value.actionId) &&
      (value.action === "edit" || value.action === "remove" || value.action === "more") &&
      isOpaqueId(value.itemId)
    ? value as unknown as InPageWidgetActionMessage
    : null;
}

export function parseInPageWidgetActionAckMessage(
  value: unknown,
): InPageWidgetActionAckMessage | null {
  if (!isRecord(value) || !hasExactKeys(value, [
    "type", "surfaceId", "actionId", "outcome",
  ])) return null;
  return value.type === UI_ATTACH_IN_PAGE_WIDGET_ACTION_ACK && isUuid(value.surfaceId) &&
      isUuid(value.actionId) && (value.outcome === "consumed" || value.outcome === "rejected")
    ? value as unknown as InPageWidgetActionAckMessage
    : null;
}

export function parseInPageWidgetReadyMessage(value: unknown): InPageWidgetReadyMessage | null {
  if (!isRecord(value) || !hasExactKeys(value, ["type", "surfaceId"])) return null;
  return value.type === UI_ATTACH_IN_PAGE_WIDGET_READY && isUuid(value.surfaceId)
    ? value as unknown as InPageWidgetReadyMessage
    : null;
}

export function parseInPageWidgetCommand(value: unknown): InPageWidgetCommand | null {
  const type = readOwnDataProperty(value, "type");
  if (!type.present || typeof type.value !== "string") return null;
  if (!isRecord(value)) return null;
  switch (type.value) {
    case "ui-attach:widget-session-read":
    case "ui-attach:widget-selection-read":
    case "ui-attach:widget-frame-scope-list":
    case "ui-attach:widget-side-panel-open":
    case "ui-attach:widget-bridge-read-status":
    case "ui-attach:widget-bridge-create-invitation":
    case "ui-attach:widget-bridge-refresh":
    case "ui-attach:widget-bridge-disconnect":
    case "ui-attach:widget-lifecycle-control-read-next":
    case "ui-attach:widget-disclosure-read":
    case "ui-attach:widget-disclosure-acknowledge":
    case "ui-attach:widget-surface-release":
      return hasExactKeys(value, ["type"]) ? value as unknown as InPageWidgetCommand : null;
    case "ui-attach:widget-lifecycle-control-approve":
    case "ui-attach:widget-lifecycle-control-reject": {
      const record = readExactDataRecord(value, ["type", "reference", "userActivation"]);
      const reference = record
        ? parseAnnotationLifecycleOperationReference(record.reference)
        : null;
      return record && reference && record.userActivation === true
        ? {
            type: type.value,
            reference,
            userActivation: true,
          }
        : null;
    }
    case "ui-attach:widget-task-note-save":
      return hasExactKeys(value, ["type", "expectedEpoch", "itemId", "taskNote"]) &&
          isBoundedString(value.expectedEpoch, 128) && isOpaqueId(value.itemId) &&
          isBoundedText(value.taskNote, 16_384)
        ? value as unknown as InPageWidgetCommand
        : null;
    case "ui-attach:widget-item-remove":
      return hasExactKeys(value, ["type", "expectedEpoch", "itemId"]) &&
          isBoundedString(value.expectedEpoch, 128) && isOpaqueId(value.itemId)
        ? value as unknown as InPageWidgetCommand
        : null;
    case "ui-attach:widget-annotation-lifecycle-set":
      return hasExactKeys(value, [
        "type",
        "expectedEpoch",
        "itemId",
        "annotationId",
        "expectedState",
        "nextState",
      ]) && isBoundedString(value.expectedEpoch, 128) && isOpaqueId(value.itemId) &&
          isOpaqueId(value.annotationId) &&
          (value.expectedState === "open" || value.expectedState === "resolved") &&
          (value.nextState === "open" || value.nextState === "resolved") &&
          value.expectedState !== value.nextState
        ? value as unknown as InPageWidgetCommand
        : null;
    case "ui-attach:widget-session-clear":
      return hasExactKeys(value, ["type", "expectedEpoch", "operationId", "scope"]) &&
          (value.expectedEpoch === null || isBoundedString(value.expectedEpoch, 128)) &&
          isBoundedId(value.operationId, 128) &&
          (value.scope === "live-page" || value.scope === "active-origin")
        ? value as unknown as InPageWidgetCommand
        : null;
    case "ui-attach:widget-selection-set":
      return hasExactKeys(
        value,
        Object.hasOwn(value, "collectBasicDiagnostics")
          ? [
              "type",
              "enabled",
              "intent",
              "expectedGeneration",
              "collectBasicDiagnostics",
            ]
          : ["type", "enabled", "intent", "expectedGeneration"],
      ) &&
          typeof value.enabled === "boolean" &&
          (value.intent === "explicit" || (value.intent === "resume" && value.enabled === true)) &&
          (!Object.hasOwn(value, "collectBasicDiagnostics") || (
            value.collectBasicDiagnostics === true && value.enabled === true &&
            value.intent === "explicit"
          )) &&
          isNonNegativeInteger(value.expectedGeneration)
        ? value as unknown as InPageWidgetCommand
        : null;
    case "ui-attach:widget-basic-diagnostics-set":
      return hasExactKeys(value, ["type", "enabled", "expectedGeneration"]) &&
          typeof value.enabled === "boolean" && isNonNegativeInteger(value.expectedGeneration)
        ? value as unknown as InPageWidgetCommand
        : null;
    case "ui-attach:widget-frame-scope-select":
      return hasExactKeys(value, [
        "type",
        "frameId",
        "documentId",
        "origin",
        "pathname",
        "expectedGeneration",
      ]) && isNonNegativeInteger(value.frameId) &&
          (value.documentId === null || isBoundedString(value.documentId, 256)) &&
          isCanonicalOrigin(value.origin) && isCanonicalPathname(value.pathname, value.origin) &&
          isNonNegativeInteger(value.expectedGeneration)
        ? value as unknown as InPageWidgetCommand
        : null;
    case "ui-attach:widget-overlay-active":
      return hasExactKeys(value, ["type", "itemId"]) &&
          (value.itemId === null || isOpaqueId(value.itemId))
        ? value as unknown as InPageWidgetCommand
        : null;
    default:
      return null;
  }
}

function readOwnDataProperty(
  value: unknown,
  key: string,
): { present: false } | { present: true; value: unknown } {
  try {
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      return { present: false };
    }
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    return descriptor?.enumerable && Object.hasOwn(descriptor, "value") &&
        descriptor.value !== undefined
      ? { present: true, value: descriptor.value }
      : { present: false };
  } catch {
    return { present: false };
  }
}

function readExactDataRecord(
  value: unknown,
  expected: readonly string[],
): Record<string, unknown> | null {
  try {
    if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) return null;
    const descriptors = Object.getOwnPropertyDescriptors(value);
    const keys = Reflect.ownKeys(descriptors);
    if (keys.length !== expected.length || keys.some((key) =>
      typeof key !== "string" || !expected.includes(key)
    )) return null;
    const result: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
    for (const key of expected) {
      const descriptor = descriptors[key];
      if (!descriptor?.enumerable || !Object.hasOwn(descriptor, "value") ||
          descriptor.value === undefined) return null;
      result[key] = descriptor.value;
    }
    return result;
  } catch {
    return null;
  }
}

export function isCapability(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9_-]{43}$/u.test(value);
}

function isOpaqueId(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 256 &&
    value.trim().length > 0 && !/[\u0000-\u001f\u007f]/u.test(value);
}

function isBoundedString(value: unknown, maxLength: number): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= maxLength &&
    !/[\u0000-\u001f\u007f]/u.test(value);
}

function isBoundedId(value: unknown, maxLength: number): value is string {
  return isBoundedString(value, maxLength) && value.trim() === value;
}

function isBoundedText(value: unknown, maxLength: number): value is string {
  return typeof value === "string" && value.length <= maxLength &&
    !/[\u0000\u000b\u000c\u000e-\u001f\u007f]/u.test(value);
}

function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function isCanonicalOrigin(value: unknown): value is string {
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

function isUuid(value: unknown): value is string {
  return typeof value === "string" &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const keys = Object.keys(value);
  return keys.length === expected.length && expected.every((key) => Object.hasOwn(value, key));
}
import {
  parseAnnotationLifecycleOperationReference,
  type AnnotationLifecycleOperationReferenceV1,
} from "./annotation-lifecycle-control-client";
