import { isLocalBridgeSnapshot, type LocalBridgeApprovalMode } from "@meanthis/schema";
import {
  LOCAL_AGENT_BRIDGE_PERMISSION_ORIGIN,
  type LocalAgentBridgeClient,
  type LocalAgentBridgePublishInput,
  type LocalAgentBridgeStatus,
} from "./local-agent-bridge";
import type { BackgroundRuntimeFeature } from "./background-controller";
import type { SessionCommandResponse } from "./messages";

export const LOCAL_AGENT_BRIDGE_RUNTIME_TYPE = "ui-attach:local-agent-bridge";

export type LocalAgentBridgeRuntimeCommand =
  | { type: typeof LOCAL_AGENT_BRIDGE_RUNTIME_TYPE; action: "read-status" }
  | {
      type: typeof LOCAL_AGENT_BRIDGE_RUNTIME_TYPE;
      action: "create-connection-request";
      approvalMode: LocalBridgeApprovalMode;
    }
  | { type: typeof LOCAL_AGENT_BRIDGE_RUNTIME_TYPE; action: "refresh-connection" }
  | { type: typeof LOCAL_AGENT_BRIDGE_RUNTIME_TYPE; action: "refresh-connection-and-publish" }
  | {
      type: typeof LOCAL_AGENT_BRIDGE_RUNTIME_TYPE;
      action: "publish";
      input: LocalAgentBridgePublishInput;
    }
  | { type: typeof LOCAL_AGENT_BRIDGE_RUNTIME_TYPE; action: "disconnect" };

export function createBrowserLocalAgentBridgeProxy(): LocalAgentBridgeClient {
  return {
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

    refreshConnectionAndPublish: () => sendStatusCommand({
      type: LOCAL_AGENT_BRIDGE_RUNTIME_TYPE,
      action: "refresh-connection-and-publish",
    }),

    publish(input) {
      return sendBooleanCommand({
        type: LOCAL_AGENT_BRIDGE_RUNTIME_TYPE,
        action: "publish",
        input,
      });
    },

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
  if (!isRecord(value) || value.type !== LOCAL_AGENT_BRIDGE_RUNTIME_TYPE) return null;
  switch (value.action) {
    case "read-status":
    case "refresh-connection":
    case "refresh-connection-and-publish":
    case "disconnect":
      return hasExactKeys(value, ["type", "action"])
        ? value as LocalAgentBridgeRuntimeCommand
        : null;
    case "create-connection-request":
      return hasExactKeys(value, ["type", "action", "approvalMode"]) &&
        (value.approvalMode === "ask" || value.approvalMode === "browser_session")
        ? value as LocalAgentBridgeRuntimeCommand
        : null;
    case "publish":
      return hasExactKeys(value, ["type", "action", "input"]) &&
        isPublishInput(value.input)
        ? value as LocalAgentBridgeRuntimeCommand
        : null;
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
        case "read-status":
          return { ok: true, data: await client.readStatus() };
        case "create-connection-request":
          return { ok: true, data: await client.createConnectionRequest(command.approvalMode) };
        case "refresh-connection":
          return { ok: true, data: await client.refreshConnection() };
        case "refresh-connection-and-publish":
          return { ok: true, data: await client.refreshConnectionAndPublish() };
        case "publish":
          return { ok: true, data: await client.publish(command.input) };
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
  ])) {
    return false;
  }
  return typeof value.connected === "boolean" &&
    (typeof value.instanceId === "string" || value.instanceId === null) &&
    typeof value.pending === "boolean" &&
    (value.approvalMode === "ask" || value.approvalMode === "browser_session" || value.approvalMode === null) &&
    (typeof value.requestText === "string" || value.requestText === null) &&
    (typeof value.expiresAt === "string" || value.expiresAt === null);
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
  return isLocalBridgeSnapshot({
    schemaVersion: "0.1.0",
    kind: "ui-attach.local-bridge-snapshot",
    sequence: 1,
    publishedAt: "2026-01-01T00:00:00.000Z",
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
