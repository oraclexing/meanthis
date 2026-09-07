import {
  isLocalBridgeSnapshot,
  parseAnnotationLifecycleOperationReceipt,
  type LocalBridgeApprovalMode,
} from "@meanthis/schema";
import {
  LOCAL_AGENT_BRIDGE_PERMISSION_ORIGIN,
  type LocalAgentBridgeClient,
  type LocalAgentBridgePublishInput,
  type LocalAgentBridgeStatus,
} from "./local-agent-bridge";
import type { BackgroundRuntimeFeature } from "./background-controller";
import type { SessionCommandResponse } from "./messages";
import {
  LocalAgentBridgeBootstrapError,
  type LocalAgentBridgeBootstrapErrorCode,
} from "./local-agent-bridge-bootstrap";
import {
  parseAnnotationLifecycleOperationApproval,
  parseAnnotationLifecycleOperationReference,
  type AnnotationLifecycleOperationApprovalV1,
  type AnnotationLifecycleOperationReferenceV1,
} from "./annotation-lifecycle-control-client";

export const LOCAL_AGENT_BRIDGE_RUNTIME_TYPE = "ui-attach:local-agent-bridge";

export class LocalAgentBridgeRuntimeError extends Error {
  constructor(readonly code: LocalAgentBridgeBootstrapErrorCode) {
    super("The local MeanThis companion is unavailable.");
    this.name = "LocalAgentBridgeRuntimeError";
  }
}

export type LocalAgentBridgeRuntimeCommand =
  | { type: typeof LOCAL_AGENT_BRIDGE_RUNTIME_TYPE; action: "read-status" }
  | {
      type: typeof LOCAL_AGENT_BRIDGE_RUNTIME_TYPE;
      action: "create-connection-request";
      approvalMode: LocalBridgeApprovalMode;
    }
  | { type: typeof LOCAL_AGENT_BRIDGE_RUNTIME_TYPE; action: "refresh-connection" }
  | { type: typeof LOCAL_AGENT_BRIDGE_RUNTIME_TYPE; action: "repair-connection" }
  | { type: typeof LOCAL_AGENT_BRIDGE_RUNTIME_TYPE; action: "refresh-connection-and-heartbeat" }
  | {
      type: typeof LOCAL_AGENT_BRIDGE_RUNTIME_TYPE;
      action: "publish";
      input: LocalAgentBridgePublishInput;
    }
  | {
      type: typeof LOCAL_AGENT_BRIDGE_RUNTIME_TYPE;
      action: "publish-session-context";
      input: LocalAgentBridgePublishInput;
  }
  | { type: typeof LOCAL_AGENT_BRIDGE_RUNTIME_TYPE; action: "clear-session-context" }
  | { type: typeof LOCAL_AGENT_BRIDGE_RUNTIME_TYPE; action: "clear-panel-context" }
  | { type: typeof LOCAL_AGENT_BRIDGE_RUNTIME_TYPE; action: "clear-shared-capture" }
  | { type: typeof LOCAL_AGENT_BRIDGE_RUNTIME_TYPE; action: "disconnect" }
  | { type: typeof LOCAL_AGENT_BRIDGE_RUNTIME_TYPE; action: "control-read-authority" | "control-read-next" }
  | {
      type: typeof LOCAL_AGENT_BRIDGE_RUNTIME_TYPE;
      action: "control-claim" | "control-reject";
      reference: AnnotationLifecycleOperationReferenceV1;
    }
  | {
      type: typeof LOCAL_AGENT_BRIDGE_RUNTIME_TYPE;
      action: "control-finalize";
      reference: AnnotationLifecycleOperationReferenceV1;
      approval: AnnotationLifecycleOperationApprovalV1;
      receipt: unknown;
    };

export function createBrowserLocalAgentBridgeProxy(): LocalAgentBridgeClient {
  return {
    annotationLifecycleControl: {
      async readAuthority() {
        return await sendCommand({
          type: LOCAL_AGENT_BRIDGE_RUNTIME_TYPE,
          action: "control-read-authority",
        }) as Awaited<ReturnType<NonNullable<LocalAgentBridgeClient["annotationLifecycleControl"]>["readAuthority"]>>;
      },
      async readNext() {
        return await sendCommand({
          type: LOCAL_AGENT_BRIDGE_RUNTIME_TYPE,
          action: "control-read-next",
        }) as Awaited<ReturnType<NonNullable<LocalAgentBridgeClient["annotationLifecycleControl"]>["readNext"]>>;
      },
      async claim(reference) {
        return await sendCommand({
          type: LOCAL_AGENT_BRIDGE_RUNTIME_TYPE,
          action: "control-claim",
          reference,
        }) as Awaited<ReturnType<NonNullable<LocalAgentBridgeClient["annotationLifecycleControl"]>["claim"]>>;
      },
      async reject(reference) {
        return await sendCommand({
          type: LOCAL_AGENT_BRIDGE_RUNTIME_TYPE,
          action: "control-reject",
          reference,
        }) as Awaited<ReturnType<NonNullable<LocalAgentBridgeClient["annotationLifecycleControl"]>["reject"]>>;
      },
      async finalize(reference, approval, receipt) {
        return await sendCommand({
          type: LOCAL_AGENT_BRIDGE_RUNTIME_TYPE,
          action: "control-finalize",
          reference,
          approval,
          receipt,
        }) as Awaited<ReturnType<NonNullable<LocalAgentBridgeClient["annotationLifecycleControl"]>["finalize"]>>;
      },
    },

    readStatus: () => sendStatusCommand({
      type: LOCAL_AGENT_BRIDGE_RUNTIME_TYPE,
      action: "read-status",
    }),

    async createConnectionRequest(approvalMode) {
      if (approvalMode !== "ask" && approvalMode !== "browser_session") {
        throw new Error("Invalid local agent approval mode.");
      }
      if (!await chrome.permissions.request({ origins: [LOCAL_AGENT_BRIDGE_PERMISSION_ORIGIN] })) {
        throw new Error("Loopback access was not granted.");
      }
      try {
        return await sendStatusCommand({
          type: LOCAL_AGENT_BRIDGE_RUNTIME_TYPE,
          action: "create-connection-request",
          approvalMode,
        });
      } catch (error) {
        await chrome.permissions.remove({ origins: [LOCAL_AGENT_BRIDGE_PERMISSION_ORIGIN] })
          .catch(() => false);
        throw error;
      }
    },

    refreshConnection: () => sendStatusCommand({
      type: LOCAL_AGENT_BRIDGE_RUNTIME_TYPE,
      action: "refresh-connection",
    }),

    async repairConnection() {
      const data = await sendCommand({
        type: LOCAL_AGENT_BRIDGE_RUNTIME_TYPE,
        action: "repair-connection",
      });
      if (data !== null) throw new Error("Local agent bridge returned an invalid result.");
    },

    refreshConnectionAndHeartbeat: () => sendStatusCommand({
      type: LOCAL_AGENT_BRIDGE_RUNTIME_TYPE,
      action: "refresh-connection-and-heartbeat",
    }),

    publish(input) {
      return sendBooleanCommand({
        type: LOCAL_AGENT_BRIDGE_RUNTIME_TYPE,
        action: "publish",
        input,
      });
    },

    publishSessionContext(input) {
      return sendBooleanCommand({
        type: LOCAL_AGENT_BRIDGE_RUNTIME_TYPE,
        action: "publish-session-context",
        input,
      });
    },

    clearSessionContext: () => sendBooleanCommand({
      type: LOCAL_AGENT_BRIDGE_RUNTIME_TYPE,
      action: "clear-session-context",
    }),

    clearPanelContext: () => sendBooleanCommand({
      type: LOCAL_AGENT_BRIDGE_RUNTIME_TYPE,
      action: "clear-panel-context",
    }),

    clearSharedCapture: () => sendBooleanCommand({
      type: LOCAL_AGENT_BRIDGE_RUNTIME_TYPE,
      action: "clear-shared-capture",
    }),

    async disconnect() {
      const response = await sendCommand({
        type: LOCAL_AGENT_BRIDGE_RUNTIME_TYPE,
        action: "disconnect",
      });
      if (response !== null) throw new Error("Local agent bridge returned an invalid response.");
    },
  };
}

export function parseLocalAgentBridgeRuntimeCommand(
  value: unknown,
): LocalAgentBridgeRuntimeCommand | null {
  const type = readOwnDataProperty(value, "type");
  const action = readOwnDataProperty(value, "action");
  if (!type.present || type.value !== LOCAL_AGENT_BRIDGE_RUNTIME_TYPE ||
      !action.present || typeof action.value !== "string") return null;
  switch (action.value) {
    case "read-status":
    case "refresh-connection":
    case "repair-connection":
    case "refresh-connection-and-heartbeat":
    case "clear-session-context":
    case "clear-panel-context":
    case "clear-shared-capture":
    case "disconnect":
    case "control-read-authority":
    case "control-read-next": {
      const record = readExactDataRecord(value, ["type", "action"]);
      return record
        ? record as unknown as LocalAgentBridgeRuntimeCommand
        : null;
    }
    case "create-connection-request":
    {
      const record = readExactDataRecord(value, ["type", "action", "approvalMode"]);
      return record && (record.approvalMode === "ask" || record.approvalMode === "browser_session")
        ? record as unknown as LocalAgentBridgeRuntimeCommand
        : null;
    }
    case "publish":
    case "publish-session-context": {
      const record = readExactDataRecord(value, ["type", "action", "input"]);
      return record && isPublishInput(record.input)
        ? record as unknown as LocalAgentBridgeRuntimeCommand
        : null;
    }
    case "control-claim":
    case "control-reject": {
      const record = readExactDataRecord(value, ["type", "action", "reference"]);
      const reference = record
        ? parseAnnotationLifecycleOperationReference(record.reference)
        : null;
      return record && reference
        ? { type: LOCAL_AGENT_BRIDGE_RUNTIME_TYPE, action: action.value, reference }
        : null;
    }
    case "control-finalize": {
      const record = readExactDataRecord(
        value,
        ["type", "action", "reference", "approval", "receipt"],
      );
      const reference = record
        ? parseAnnotationLifecycleOperationReference(record.reference)
        : null;
      const approval = record ? parseAnnotationLifecycleOperationApproval(record.approval) : null;
      const receipt = record
        ? parseAnnotationLifecycleOperationReceipt(record.receipt)
        : { ok: false as const };
      return record && reference && approval && receipt.ok
        ? {
            type: LOCAL_AGENT_BRIDGE_RUNTIME_TYPE,
            action: "control-finalize",
            reference,
            approval,
            receipt: receipt.value,
          }
        : null;
    }
    default:
      return null;
  }
}

export function isLocalAgentBridgeRuntimeMessage(value: unknown): boolean {
  return isRecord(value) && value.type === LOCAL_AGENT_BRIDGE_RUNTIME_TYPE;
}

export function createLocalAgentBridgeRuntimeFeature(
  client: LocalAgentBridgeClient,
): BackgroundRuntimeFeature {
  return {
    matches: isLocalAgentBridgeRuntimeMessage,
    async handle(message): Promise<SessionCommandResponse<unknown>> {
      const command = parseLocalAgentBridgeRuntimeCommand(message);
      if (!command) {
        return {
          ok: false,
          code: "INVALID_COMMAND",
          error: "Invalid ui-attach session command.",
          issues: [{ path: "command", message: "Expected a bounded local agent bridge command." }],
        };
      }
      switch (command.action) {
        case "control-read-authority":
          if (!client.annotationLifecycleControl) {
            throw new Error("Annotation lifecycle control is unavailable.");
          }
          return {
            ok: true,
            data: await client.annotationLifecycleControl.readAuthority(),
          };
        case "control-read-next":
          return {
            ok: true,
            data: await client.annotationLifecycleControl?.readNext() ?? null,
          };
        case "control-claim":
          if (!client.annotationLifecycleControl) {
            throw new Error("Annotation lifecycle control is unavailable.");
          }
          return {
            ok: true,
            data: await client.annotationLifecycleControl.claim(command.reference),
          };
        case "control-reject":
          if (!client.annotationLifecycleControl) {
            throw new Error("Annotation lifecycle control is unavailable.");
          }
          return {
            ok: true,
            data: await client.annotationLifecycleControl.reject(command.reference),
          };
        case "control-finalize":
          if (!client.annotationLifecycleControl) {
            throw new Error("Annotation lifecycle control is unavailable.");
          }
          return {
            ok: true,
            data: await client.annotationLifecycleControl.finalize(
              command.reference,
              command.approval,
              command.receipt as Parameters<NonNullable<LocalAgentBridgeClient["annotationLifecycleControl"]>["finalize"]>[2],
            ),
          };
        case "read-status":
          return { ok: true, data: await client.readStatus() };
        case "create-connection-request":
          try {
            return { ok: true, data: await client.createConnectionRequest(command.approvalMode) };
          } catch (error) {
            if (error instanceof LocalAgentBridgeBootstrapError) {
              return {
                ok: false,
                code: error.code,
                error: "The local MeanThis companion is unavailable.",
              };
            }
            throw error;
          }
        case "refresh-connection":
          return { ok: true, data: await client.refreshConnection() };
        case "repair-connection":
          try {
            await client.repairConnection?.();
            return { ok: true, data: null };
          } catch (error) {
            if (error instanceof LocalAgentBridgeBootstrapError) {
              return {
                ok: false,
                code: error.code,
                error: "The local MeanThis companion is unavailable.",
              };
            }
            throw error;
          }
        case "refresh-connection-and-heartbeat":
          return { ok: true, data: await client.refreshConnectionAndHeartbeat() };
        case "publish":
          return { ok: true, data: await client.publish(command.input) };
        case "publish-session-context":
          return { ok: true, data: await client.publishSessionContext(command.input) };
        case "clear-session-context":
          return { ok: true, data: await client.clearSessionContext() };
        case "clear-panel-context":
          return { ok: true, data: await client.clearPanelContext() };
        case "clear-shared-capture":
          return { ok: true, data: await client.clearSharedCapture?.() ?? false };
        case "disconnect":
          await client.disconnect();
          return { ok: true, data: null };
      }
    },
  };
}

async function sendStatusCommand(
  command: LocalAgentBridgeRuntimeCommand,
): Promise<LocalAgentBridgeStatus> {
  const data = await sendCommand(command);
  if (!isStatus(data)) throw new Error("Local agent bridge returned an invalid status.");
  return data;
}

async function sendBooleanCommand(
  command: LocalAgentBridgeRuntimeCommand,
): Promise<boolean> {
  const data = await sendCommand(command);
  if (typeof data !== "boolean") throw new Error("Local agent bridge returned an invalid result.");
  return data;
}

async function sendCommand(command: LocalAgentBridgeRuntimeCommand): Promise<unknown> {
  const response = await chrome.runtime.sendMessage(command);
  if (isRecord(response) && response.ok === false &&
      (response.code === "COMPANION_UNAVAILABLE" ||
        response.code === "BRIDGE_REPAIR_REQUIRED" ||
        response.code === "BRIDGE_SETUP_REQUIRED" ||
        response.code === "BRIDGE_ACTION_REQUIRED" ||
        response.code === "BRIDGE_START_FAILED")) {
    throw new LocalAgentBridgeRuntimeError(response.code);
  }
  if (!isRecord(response) || response.ok !== true || !hasExactKeys(response, ["ok", "data"])) {
    throw new Error("Local agent bridge action failed.");
  }
  return response.data;
}

function isStatus(value: unknown): value is LocalAgentBridgeStatus {
  if (!isRecord(value) || !hasExactKeys(value, [
    "connected",
    "instanceId",
    "pending",
    "approvalMode",
    "requestText",
    "expiresAt",
    "sharedTargetCount",
    "sharedSequence",
    ...(Object.hasOwn(value, "readAcknowledgementState")
      ? ["readAcknowledgementState"]
      : []),
  ])) {
    return false;
  }
  return typeof value.connected === "boolean" &&
    (typeof value.instanceId === "string" || value.instanceId === null) &&
    typeof value.pending === "boolean" &&
    (value.approvalMode === "ask" || value.approvalMode === "browser_session" || value.approvalMode === null) &&
    (typeof value.requestText === "string" || value.requestText === null) &&
    (typeof value.expiresAt === "string" || value.expiresAt === null) &&
    (value.sharedTargetCount === null || isNonNegativeSafeInteger(value.sharedTargetCount)) &&
    (value.sharedSequence === null || isNonNegativeSafeInteger(value.sharedSequence)) &&
    (!Object.hasOwn(value, "readAcknowledgementState") ||
      value.readAcknowledgementState === "waiting" ||
      value.readAcknowledgementState === "current" ||
      value.readAcknowledgementState === "unavailable");
}

function isNonNegativeSafeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function isPublishInput(value: unknown): value is LocalAgentBridgePublishInput {
  if (!isRecord(value) || !hasExactKeys(value, [
    "page",
    "attachmentCount",
    "agentCopy",
    ...(Object.hasOwn(value, "capture") ? ["capture"] : []),
    ...(Object.hasOwn(value, "observations") ? ["observations"] : []),
    ...(Object.hasOwn(value, "activity") ? ["activity"] : []),
  ])) {
    return false;
  }
  const validationPublishedAt = isRecord(value.observations) &&
      typeof value.observations.observedAt === "string"
    ? value.observations.observedAt
    : "2026-01-01T00:00:00.000Z";
  return isLocalBridgeSnapshot({
    schemaVersion: "0.1.0",
    kind: "ui-attach.local-bridge-snapshot",
    sequence: 1,
    // The background assigns the real publication time after this command crosses
    // the runtime boundary. Use the observation time here to validate structure
    // without coupling valid live-page evidence to a fixed calendar date.
    publishedAt: validationPublishedAt,
    page: value.page,
    attachmentCount: value.attachmentCount,
    agentCopy: value.agentCopy,
    ...(value.capture === undefined ? {} : { capture: value.capture }),
    ...(value.observations === undefined ? {} : { observations: value.observations }),
    ...(value.activity === undefined ? {} : { activity: value.activity }),
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function hasExactKeys(value: Record<string, unknown>, expected: string[]): boolean {
  const keys = Object.keys(value);
  return keys.length === expected.length && expected.every((key) => Object.hasOwn(value, key));
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
