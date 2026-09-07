export const LOCAL_AGENT_BRIDGE_NATIVE_HOST_NAME = "app.meanthis.bridge";

export type LocalAgentBridgeBootstrapErrorCode =
  | "COMPANION_UNAVAILABLE"
  | "BRIDGE_REPAIR_REQUIRED"
  | "BRIDGE_SETUP_REQUIRED"
  | "BRIDGE_ACTION_REQUIRED"
  | "BRIDGE_START_FAILED";

const NATIVE_BRIDGE_REQUEST_TIMEOUT_MS = 60_000;

export class LocalAgentBridgeBootstrapError extends Error {
  constructor(readonly code: LocalAgentBridgeBootstrapErrorCode) {
    super("The local MeanThis companion is unavailable.");
    this.name = "LocalAgentBridgeBootstrapError";
  }
}

export function createBrowserLocalAgentBridgeBootstrap(options: {
  timeoutMs?: number;
} = {}): () => Promise<void> {
  return createNativeRequest("ui-attach.native-bridge-start", options.timeoutMs);
}

export function createBrowserLocalAgentBridgeRepair(options: {
  timeoutMs?: number;
} = {}): () => Promise<void> {
  return createNativeRequest("ui-attach.native-bridge-repair", options.timeoutMs);
}

function createNativeRequest(
  kind: "ui-attach.native-bridge-start" | "ui-attach.native-bridge-repair",
  timeoutMs = NATIVE_BRIDGE_REQUEST_TIMEOUT_MS,
): () => Promise<void> {
  return async () => {
    const deadline = Date.now() + timeoutMs;
    const maxAttempts = kind === "ui-attach.native-bridge-start" ? 2 : 1;
    for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
      const requestId = crypto.randomUUID();
      let response: unknown;
      try {
        response = await withTimeout(chrome.runtime.sendNativeMessage(
          LOCAL_AGENT_BRIDGE_NATIVE_HOST_NAME,
          {
            schemaVersion: "0.1.0",
            kind,
            requestId,
          },
        ), Math.max(1, deadline - Date.now()));
      } catch {
        throw new LocalAgentBridgeBootstrapError("COMPANION_UNAVAILABLE");
      }
      const parsed = parseResponse(response, requestId);
      if (parsed === "ready") return;
      if (parsed === "BRIDGE_START_FAILED" && attempt + 1 < maxAttempts && Date.now() < deadline) {
        continue;
      }
      throw new LocalAgentBridgeBootstrapError(parsed);
    }
    throw new LocalAgentBridgeBootstrapError("BRIDGE_START_FAILED");
  };
}

function parseResponse(
  value: unknown,
  requestId: string,
): "ready" | LocalAgentBridgeBootstrapErrorCode {
  if (!isRecord(value) || value.schemaVersion !== "0.1.0" ||
      value.kind !== "ui-attach.native-bridge-start-result" ||
      value.requestId !== requestId) {
    return "COMPANION_UNAVAILABLE";
  }
  if (value.ok === true && hasExactKeys(value, [
    "schemaVersion",
    "kind",
    "requestId",
    "ok",
    "data",
  ]) && isRecord(value.data) && hasExactKeys(value.data, ["status"]) &&
      value.data.status === "ready") {
    return "ready";
  }
  if (value.ok !== false || !hasExactKeys(value, [
    "schemaVersion",
    "kind",
    "requestId",
    "ok",
    "error",
  ]) || !isRecord(value.error) || !hasExactKeys(value.error, ["code"])) {
    return "COMPANION_UNAVAILABLE";
  }
  return value.error.code === "BRIDGE_REPAIR_REQUIRED"
    ? "BRIDGE_REPAIR_REQUIRED"
    : value.error.code === "BRIDGE_SETUP_REQUIRED"
      ? "BRIDGE_SETUP_REQUIRED"
    : value.error.code === "BRIDGE_ACTION_REQUIRED"
      ? "BRIDGE_ACTION_REQUIRED"
    : value.error.code === "BRIDGE_START_FAILED"
      ? "BRIDGE_START_FAILED"
      : "COMPANION_UNAVAILABLE";
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("Native bridge request timed out.")), timeoutMs);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, expected: string[]): boolean {
  const actual = Object.keys(value);
  return actual.length === expected.length && expected.every((key) => Object.hasOwn(value, key));
}
