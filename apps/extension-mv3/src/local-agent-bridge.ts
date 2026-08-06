import {
  UI_ATTACH_LOCAL_BRIDGE_CAPABILITIES_PATH,
  UI_ATTACH_LOCAL_BRIDGE_CONNECTION_REQUEST_PATH,
  UI_ATTACH_LOCAL_BRIDGE_ORIGIN,
  UI_ATTACH_LOCAL_BRIDGE_SNAPSHOT_PATH,
  UI_ATTACH_LOCAL_BRIDGE_STRUCTURED_CAPTURE_CAPABILITIES_PATH,
  createLocalBridgeApprovalProofMessage,
  isLocalBridgeCapabilities,
  isLocalBridgeSnapshot,
  isLocalBridgeStructuredCaptureCapabilities,
  type LocalBridgeApprovalMode,
  type LocalBridgeActivityV1,
  type LocalBridgeCaptureV1,
  type LocalBridgeObservationsV1,
  type LocalBridgePageV1,
} from "@meanthis/schema";
import type { ExtensionStorageArea } from "./capture-store";

export const LOCAL_AGENT_BRIDGE_INSTALLATION_STORAGE_KEY =
  "ui-attach.local-agent-bridge.installation.v1";
export const LOCAL_AGENT_BRIDGE_SESSION_STORAGE_KEY = "ui-attach.local-agent-bridge.session.v1";
export const LOCAL_AGENT_BRIDGE_STORAGE_KEY = "ui-attach.local-agent-bridge.v1";
export const LOCAL_AGENT_BRIDGE_PERMISSION_ORIGIN = "http://127.0.0.1/*";
const LOCAL_AGENT_BRIDGE_REQUEST_TIMEOUT_MS = 3_000;

interface LocalAgentBridgePersistentState {
  installationId: string;
}

interface LocalAgentBridgePendingRequest {
  requestId: string;
  requestSecret: string;
  approvalKey: string;
  approvalMode: LocalBridgeApprovalMode;
  expiresAt: string;
  requestText: string;
}

interface LocalAgentBridgeSessionState {
  browserSessionId: string;
  trustKey?: string;
  instanceId?: string;
  token?: string;
  sequence?: number;
  pending?: LocalAgentBridgePendingRequest;
  latestSnapshot?: LocalAgentBridgePublishInput;
  snapshotObservationCapability?: "v1" | "none";
  structuredCaptureCapability?: "v1" | "none";
}

export interface LocalAgentBridgeStatus {
  connected: boolean;
  instanceId: string | null;
  pending: boolean;
  approvalMode: LocalBridgeApprovalMode | null;
  requestText: string | null;
  expiresAt: string | null;
}

export interface LocalAgentBridgePublishInput {
  page: LocalBridgePageV1 | null;
  attachmentCount: number;
  agentCopy: string | null;
  capture?: LocalBridgeCaptureV1;
  observations?: LocalBridgeObservationsV1;
  activity?: LocalBridgeActivityV1;
}

function downgradeCachedSnapshot(
  input: LocalAgentBridgePublishInput,
): LocalAgentBridgePublishInput {
  return {
    page: input.page,
    attachmentCount: input.attachmentCount,
    agentCopy: input.agentCopy,
    ...(input.capture
      ? {
          capture: {
            ...input.capture,
            authority: input.capture.authority === "not_rechecked"
              ? "not_rechecked" as const
              : "capture_time" as const,
          },
        }
      : {}),
  };
}

export interface LocalAgentBridgeClient {
  readStatus(): Promise<LocalAgentBridgeStatus>;
  createConnectionRequest(approvalMode: LocalBridgeApprovalMode): Promise<LocalAgentBridgeStatus>;
  refreshConnection(): Promise<LocalAgentBridgeStatus>;
  refreshConnectionAndPublish(): Promise<LocalAgentBridgeStatus>;
  publish(input: LocalAgentBridgePublishInput): Promise<boolean>;
  disconnect(): Promise<void>;
}

export interface LocalAgentBridgeDependencies {
  extensionOrigin: string;
  persistentStorage: ExtensionStorageArea;
  sessionStorage: ExtensionStorageArea;
  fetch: typeof globalThis.fetch;
  requestPermission(): Promise<boolean>;
  removePermission(): Promise<boolean>;
  randomUUID(): string;
  randomBytes(size: number): Uint8Array;
  now(): Date;
  withSessionLock<T>(operation: () => Promise<T>): Promise<T>;
}

export interface BrowserLocalAgentBridgeClientOptions {
  requestPermission?(): Promise<boolean>;
  withSessionLock?<T>(operation: () => Promise<T>): Promise<T>;
}

export function createBrowserLocalAgentBridgeClient(
  options: BrowserLocalAgentBridgeClientOptions = {},
): LocalAgentBridgeClient {
  return createLocalAgentBridgeClient({
    extensionOrigin: `chrome-extension://${chrome.runtime.id}`,
    persistentStorage: chrome.storage.local,
    sessionStorage: chrome.storage.session,
    fetch: globalThis.fetch.bind(globalThis),
    requestPermission: options.requestPermission ?? (() => chrome.permissions.request({
      origins: [LOCAL_AGENT_BRIDGE_PERMISSION_ORIGIN],
    })),
    removePermission: () => chrome.permissions.remove({
      origins: [LOCAL_AGENT_BRIDGE_PERMISSION_ORIGIN],
    }),
    randomUUID: () => crypto.randomUUID(),
    randomBytes: (size) => crypto.getRandomValues(new Uint8Array(size)),
    now: () => new Date(),
    withSessionLock: options.withSessionLock ?? ((operation) => navigator.locks.request(
      LOCAL_AGENT_BRIDGE_SESSION_STORAGE_KEY,
      { mode: "exclusive" },
      operation,
    )),
  });
}

export function createLocalAgentBridgeClient(
  dependencies: LocalAgentBridgeDependencies,
): LocalAgentBridgeClient {
  let operationTail: Promise<void> = Promise.resolve();

  function enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const run = () => dependencies.withSessionLock(operation);
    const result = operationTail.then(run, run);
    operationTail = result.then(() => undefined, () => undefined);
    return result;
  }

  async function readPersistentState(): Promise<LocalAgentBridgePersistentState | null> {
    const entries = await dependencies.persistentStorage.get([
      LOCAL_AGENT_BRIDGE_INSTALLATION_STORAGE_KEY,
      LOCAL_AGENT_BRIDGE_STORAGE_KEY,
    ]);
    const current = entries[LOCAL_AGENT_BRIDGE_INSTALLATION_STORAGE_KEY];
    const legacy = entries[LOCAL_AGENT_BRIDGE_STORAGE_KEY];
    if (isPersistentState(current)) {
      if (legacy !== undefined) {
        await dependencies.persistentStorage.remove(LOCAL_AGENT_BRIDGE_STORAGE_KEY);
      }
      return current;
    }
    if (!isRecord(legacy) || !isUuidV4(legacy.installationId)) return null;
    const migrated = { installationId: legacy.installationId };
    await dependencies.persistentStorage.set({
      [LOCAL_AGENT_BRIDGE_INSTALLATION_STORAGE_KEY]: migrated,
    });
    await dependencies.persistentStorage.remove(LOCAL_AGENT_BRIDGE_STORAGE_KEY);
    return migrated;
  }

  async function ensurePersistentState(): Promise<LocalAgentBridgePersistentState> {
    const existing = await readPersistentState();
    if (existing) return existing;
    const created = { installationId: dependencies.randomUUID() };
    if (!isPersistentState(created)) throw new Error("Unable to create extension installation identity.");
    await dependencies.persistentStorage.set({
      [LOCAL_AGENT_BRIDGE_INSTALLATION_STORAGE_KEY]: created,
    });
    return created;
  }

  async function readSessionState(): Promise<LocalAgentBridgeSessionState | null> {
    const entries = await dependencies.sessionStorage.get(LOCAL_AGENT_BRIDGE_SESSION_STORAGE_KEY);
    const value = entries[LOCAL_AGENT_BRIDGE_SESSION_STORAGE_KEY];
    return isSessionState(value) ? value : null;
  }

  async function ensureSessionState(): Promise<LocalAgentBridgeSessionState> {
    const existing = await readSessionState();
    if (existing) return existing;
    const created = { browserSessionId: dependencies.randomUUID() };
    if (!isSessionState(created)) throw new Error("Unable to create browser session identity.");
    await saveSessionState(created);
    return created;
  }

  async function saveSessionState(value: LocalAgentBridgeSessionState): Promise<void> {
    await dependencies.sessionStorage.set({ [LOCAL_AGENT_BRIDGE_SESSION_STORAGE_KEY]: value });
  }

  async function clearSessionCredentials(
    state: LocalAgentBridgeSessionState,
    rotateBrowserSessionId = false,
    preserveTrust = false,
  ): Promise<void> {
    const browserSessionId = rotateBrowserSessionId
      ? dependencies.randomUUID()
      : state.browserSessionId;
    if (!isUuidV4(browserSessionId)) {
      throw new Error("Unable to rotate browser session identity.");
    }
    await saveSessionState({
      browserSessionId,
      ...(preserveTrust && !rotateBrowserSessionId && state.trustKey
        ? { trustKey: state.trustKey }
        : {}),
    });
  }

  async function refreshConnectionInternal(): Promise<LocalAgentBridgeStatus> {
    const state = await readSessionState();
    if (!state?.pending) return toStatus(state);
    let response: Response;
    try {
      response = await dependencies.fetch(
        `${UI_ATTACH_LOCAL_BRIDGE_ORIGIN}${UI_ATTACH_LOCAL_BRIDGE_CONNECTION_REQUEST_PATH}/${state.pending.requestId}`,
        {
          method: "POST",
          redirect: "error",
          signal: AbortSignal.timeout(LOCAL_AGENT_BRIDGE_REQUEST_TIMEOUT_MS),
          headers: {
            authorization: `Bearer ${state.pending.requestSecret}`,
            "content-type": "application/json",
          },
          body: "{}",
        },
      );
    } catch {
      return toStatus(state);
    }
    if (response.status === 401 || response.status === 403 || response.status === 404) {
      await clearSessionCredentials(state, false, true);
      await dependencies.removePermission().catch(() => false);
      return disconnectedStatus();
    }
    const body = await readJson(response);
    const parsed = parseConnectionResponse(
      body,
      "ui-attach.local-bridge-connection-request",
      state.pending.requestId,
      state.pending.approvalMode,
      true,
    );
    if (!response.ok || !parsed) throw new Error("Local agent connection request was rejected.");
    if (parsed.status === "pending") return toStatus(state);
    if (parsed.expiresAt !== state.pending.expiresAt) {
      throw new Error("Local agent connection approval expiry changed unexpectedly.");
    }
    if (!await verifyConnectionApproval(parsed, state.pending, state.trustKey ?? null)) {
      throw new Error("Local agent connection approval proof was rejected.");
    }
    const latest = await readSessionState();
    if (
      !latest?.pending ||
      latest.pending.requestId !== state.pending.requestId ||
      latest.pending.requestSecret !== state.pending.requestSecret
    ) {
      return toStatus(latest);
    }
    const connected: LocalAgentBridgeSessionState = {
      browserSessionId: state.browserSessionId,
      instanceId: parsed.instanceId,
      token: parsed.token,
      sequence: 0,
      ...(parsed.sessionTrustKey ? { trustKey: parsed.sessionTrustKey } : {}),
      ...(state.latestSnapshot ? { latestSnapshot: state.latestSnapshot } : {}),
    };
    await saveSessionState(connected);
    return toStatus(connected);
  }

  async function publishInternal(
    state: LocalAgentBridgeSessionState,
    input: LocalAgentBridgePublishInput,
  ): Promise<boolean> {
    if (!state.instanceId || !state.token) return false;
    const capabilities = await readSnapshotCapabilities(state, {
      observations: Boolean(input.observations),
      structuredCapture: Boolean(input.capture),
    });
    const snapshot = {
      schemaVersion: "0.1.0",
      kind: "ui-attach.local-bridge-snapshot",
      sequence: (state.sequence ?? 0) + 1,
      publishedAt: dependencies.now().toISOString(),
      page: input.page,
      attachmentCount: input.attachmentCount,
      agentCopy: input.agentCopy,
      ...(capabilities.structuredCapture && input.capture
        ? { capture: input.capture }
        : {}),
      ...(capabilities.observations && input.observations
        ? { observations: input.observations }
        : {}),
      ...(input.activity ? { activity: input.activity } : {}),
    };
    if (!isLocalBridgeSnapshot(snapshot)) return false;
    try {
      const response = await dependencies.fetch(
        `${UI_ATTACH_LOCAL_BRIDGE_ORIGIN}${UI_ATTACH_LOCAL_BRIDGE_SNAPSHOT_PATH}`,
        {
          method: "PUT",
          redirect: "error",
          signal: AbortSignal.timeout(LOCAL_AGENT_BRIDGE_REQUEST_TIMEOUT_MS),
          headers: {
            authorization: `Bearer ${state.token}`,
            "content-type": "application/json",
          },
          body: JSON.stringify(snapshot),
        },
      );
      if (response.status === 401) {
        const latest = await readSessionState();
        if (
          latest?.instanceId === state.instanceId &&
          latest.token === state.token
        ) {
          await clearSessionCredentials(latest, false, true);
        }
        await dependencies.removePermission().catch(() => false);
        return false;
      }
      if (!response.ok) return false;
      const latest = await readSessionState();
      if (
        !latest?.instanceId ||
        latest.instanceId !== state.instanceId ||
        latest.token !== state.token
      ) {
        return false;
      }
      await saveSessionState({
        ...latest,
        sequence: Math.max(latest.sequence ?? 0, snapshot.sequence),
      });
      return true;
    } catch {
      return false;
    }
  }

  async function readSnapshotCapabilities(
    state: LocalAgentBridgeSessionState,
    requested: { observations: boolean; structuredCapture: boolean },
  ): Promise<{ observations: boolean; structuredCapture: boolean }> {
    const observations = requested.observations
      ? await readSnapshotCapability(state, "observations")
      : false;
    const latest = await readSessionState();
    const structuredCapture = requested.structuredCapture
      ? await readSnapshotCapability(latest ?? state, "structuredCapture")
      : false;
    return { observations, structuredCapture };
  }

  async function readSnapshotCapability(
    state: LocalAgentBridgeSessionState,
    capability: "observations" | "structuredCapture",
  ): Promise<boolean> {
    const cached = capability === "observations"
      ? state.snapshotObservationCapability
      : state.structuredCaptureCapability;
    if (cached !== undefined) return cached === "v1";
    const path = capability === "observations"
      ? UI_ATTACH_LOCAL_BRIDGE_CAPABILITIES_PATH
      : UI_ATTACH_LOCAL_BRIDGE_STRUCTURED_CAPTURE_CAPABILITIES_PATH;
    let response: Response;
    try {
      response = await dependencies.fetch(
        `${UI_ATTACH_LOCAL_BRIDGE_ORIGIN}${path}`,
        {
          method: "GET",
          redirect: "error",
          signal: AbortSignal.timeout(LOCAL_AGENT_BRIDGE_REQUEST_TIMEOUT_MS),
          headers: {
            authorization: `Bearer ${state.token}`,
            "content-type": "application/json",
          },
        },
      );
    } catch {
      return false;
    }
    const body = await readJson(response);
    const supported = response.ok && (
      capability === "observations"
        ? isLocalBridgeCapabilities(body)
        : isLocalBridgeStructuredCaptureCapabilities(body)
    );
    const negotiated = supported ? "v1" as const : response.status === 404 ? "none" as const : null;
    if (negotiated === null) return false;
    const latest = await readSessionState();
    if (
      latest !== null &&
      latest.instanceId === state.instanceId &&
      latest.token === state.token
    ) {
      await saveSessionState({
        ...latest,
        ...(capability === "observations"
          ? { snapshotObservationCapability: negotiated }
          : { structuredCaptureCapability: negotiated }),
      });
    }
    return negotiated === "v1";
  }

  return {
    async readStatus() {
      await readPersistentState();
      return toStatus(await readSessionState());
    },

    createConnectionRequest(approvalMode) {
      return enqueue(async () => {
        if (approvalMode !== "ask" && approvalMode !== "browser_session") {
          throw new Error("Invalid local agent approval mode.");
        }
        if (!await dependencies.requestPermission()) {
          throw new Error("Loopback access was not granted.");
        }
        const persistent = await ensurePersistentState();
        let session = await ensureSessionState();
        if (session.instanceId && session.token) return toStatus(session);
        if (session.pending) return toStatus(session);
        if (approvalMode === "ask" && session.trustKey) {
          await clearSessionCredentials(session, true);
          session = (await readSessionState()) ?? await ensureSessionState();
        }
        const requestId = dependencies.randomUUID();
        const requestSecret = bytesToBase64Url(dependencies.randomBytes(32));
        const approvalKey = bytesToBase64Url(dependencies.randomBytes(32));
        const approvalVerifier = await sha256Base64Url(approvalKey);
        const request = {
          schemaVersion: "0.1.0" as const,
          kind: "ui-attach.local-bridge-connection-request" as const,
          requestId,
          requestSecret,
          approvalVerifier,
          installationId: persistent.installationId,
          browserSessionId: session.browserSessionId,
          approvalMode,
        };
        if (
          !isUuidV4(requestId) ||
          !/^[A-Za-z0-9_-]{43}$/.test(requestSecret) ||
          !/^[A-Za-z0-9_-]{43}$/.test(approvalKey) ||
          !/^[A-Za-z0-9_-]{43}$/.test(approvalVerifier)
        ) {
          throw new Error("Unable to create a bounded local agent connection request.");
        }
        try {
          const response = await dependencies.fetch(
            `${UI_ATTACH_LOCAL_BRIDGE_ORIGIN}${UI_ATTACH_LOCAL_BRIDGE_CONNECTION_REQUEST_PATH}`,
            {
              method: "POST",
              redirect: "error",
              signal: AbortSignal.timeout(LOCAL_AGENT_BRIDGE_REQUEST_TIMEOUT_MS),
              headers: { "content-type": "application/json" },
              body: JSON.stringify(request),
            },
          );
          const body = await readJson(response);
          const parsed = parseConnectionResponse(
            body,
            "ui-attach.local-bridge-connection-requested",
            requestId,
            approvalMode,
            false,
          );
          if (response.status !== 201 || !parsed) {
            throw new Error("Local agent connection request was rejected.");
          }
          if (approvalMode === "ask" && parsed.status !== "pending") {
            throw new Error("Ask-every-time requests require explicit approval.");
          }
          const pending: LocalAgentBridgePendingRequest = {
            requestId,
            requestSecret,
            approvalKey,
            approvalMode,
            expiresAt: parsed.expiresAt,
            requestText: createConnectionRequestText(
              requestId,
              approvalKey,
              approvalMode,
              parsed.expiresAt,
            ),
          };
          await saveSessionState({
            browserSessionId: session.browserSessionId,
            ...(session.trustKey ? { trustKey: session.trustKey } : {}),
            ...(session.latestSnapshot ? { latestSnapshot: session.latestSnapshot } : {}),
            pending,
          });
          return parsed.status === "approved"
            ? refreshConnectionInternal()
            : toStatus({
                browserSessionId: session.browserSessionId,
                ...(session.trustKey ? { trustKey: session.trustKey } : {}),
                ...(session.latestSnapshot ? { latestSnapshot: session.latestSnapshot } : {}),
                pending,
              });
        } catch (error) {
          await clearSessionCredentials(session, true);
          await dependencies.removePermission().catch(() => false);
          throw error;
        }
      });
    },

    refreshConnection() {
      return enqueue(refreshConnectionInternal);
    },

    refreshConnectionAndPublish() {
      return enqueue(async () => {
        await refreshConnectionInternal();
        const state = await readSessionState();
        if (state?.instanceId && state.token) {
          await publishInternal(state, state.latestSnapshot
            ? downgradeCachedSnapshot(state.latestSnapshot)
            : {
            page: null,
            attachmentCount: 0,
            agentCopy: null,
          });
        }
        return toStatus(await readSessionState());
      });
    },

    publish(input) {
      return enqueue(async () => {
        const state = await readSessionState();
        if (!state?.pending && (!state?.instanceId || !state.token)) return false;
        if (!isPublishInput(input)) return false;
        const latestState = {
          ...state,
          latestSnapshot: structuredClone(input),
        };
        await saveSessionState(latestState);
        return publishInternal(latestState, input);
      });
    },

    disconnect() {
      return enqueue(async () => {
        const state = await readSessionState();
        try {
          if (state) await clearSessionCredentials(state, true);
          if (state?.instanceId && state.token) {
            await dependencies.fetch(
              `${UI_ATTACH_LOCAL_BRIDGE_ORIGIN}${UI_ATTACH_LOCAL_BRIDGE_SNAPSHOT_PATH}`,
              {
                method: "DELETE",
                redirect: "error",
                signal: AbortSignal.timeout(LOCAL_AGENT_BRIDGE_REQUEST_TIMEOUT_MS),
                headers: { authorization: `Bearer ${state.token}` },
              },
            ).catch(() => undefined);
          } else if (state?.pending) {
            await dependencies.fetch(
              `${UI_ATTACH_LOCAL_BRIDGE_ORIGIN}${UI_ATTACH_LOCAL_BRIDGE_CONNECTION_REQUEST_PATH}/${state.pending.requestId}`,
              {
                method: "DELETE",
                redirect: "error",
                signal: AbortSignal.timeout(LOCAL_AGENT_BRIDGE_REQUEST_TIMEOUT_MS),
                headers: { authorization: `Bearer ${state.pending.requestSecret}` },
              },
            ).catch(() => undefined);
          }
        } finally {
          await dependencies.removePermission().catch(() => false);
        }
      });
    },
  };
}

function toStatus(state: LocalAgentBridgeSessionState | null): LocalAgentBridgeStatus {
  if (state?.instanceId && state.token) {
    return {
      connected: true,
      instanceId: state.instanceId,
      pending: false,
      approvalMode: null,
      requestText: null,
      expiresAt: null,
    };
  }
  if (state?.pending) {
    return {
      connected: false,
      instanceId: null,
      pending: true,
      approvalMode: state.pending.approvalMode,
      requestText: state.pending.requestText,
      expiresAt: state.pending.expiresAt,
    };
  }
  return disconnectedStatus();
}

function disconnectedStatus(): LocalAgentBridgeStatus {
  return {
    connected: false,
    instanceId: null,
    pending: false,
    approvalMode: null,
    requestText: null,
    expiresAt: null,
  };
}

function createConnectionRequestText(
  requestId: string,
  approvalKey: string,
  approvalMode: LocalBridgeApprovalMode,
  expiresAt: string,
): string {
  return [
    "# MeanThis Connection Request",
    "",
    `Request ID: ${requestId}`,
    `Approval mode: ${approvalMode}`,
    `Approval key: ${approvalKey}`,
    `Approval: ${approvalMode === "browser_session" ? "Trust this browser session" : "Ask every time"}`,
    `Expires at: ${expiresAt}`,
    "",
    "Agent action: approve this short-lived local capability with:",
    `meanthis bridge approve --request ${requestId} --mode ${approvalMode} --key ${approvalKey} --json`,
    "Keep this request on this device.",
  ].join("\n");
}

interface ConnectionResponseData {
  requestId: string;
  approvalMode: LocalBridgeApprovalMode;
  expiresAt: string;
  status: "pending" | "approved";
  instanceId?: string;
  token?: string;
  approvalProof?: string;
  sessionTrustKey?: string;
}

function parseConnectionResponse(
  value: unknown,
  expectedKind:
    | "ui-attach.local-bridge-connection-requested"
    | "ui-attach.local-bridge-connection-request",
  requestId: string,
  approvalMode: LocalBridgeApprovalMode,
  requireCredential: boolean,
): ConnectionResponseData | null {
  if (!isRecord(value) || !hasExactKeys(value, ["schemaVersion", "kind", "ok", "data"])) {
    return null;
  }
  if (
    value.schemaVersion !== "0.1.0" ||
    value.kind !== expectedKind ||
    value.ok !== true ||
    !isRecord(value.data)
  ) {
    return null;
  }
  const data = value.data;
  if (
    data.requestId !== requestId ||
    data.approvalMode !== approvalMode ||
    !isCanonicalIsoDate(data.expiresAt) ||
    (data.status !== "pending" && data.status !== "approved")
  ) {
    return null;
  }
  if (data.status === "pending") {
    return hasExactKeys(data, ["requestId", "approvalMode", "expiresAt", "status"])
      ? data as unknown as ConnectionResponseData
      : null;
  }
  const expectedKeys = requireCredential
    ? [
        "requestId",
        "approvalMode",
        "expiresAt",
        "status",
        "instanceId",
        "token",
        "approvalProof",
        ...(approvalMode === "browser_session" ? ["sessionTrustKey"] : []),
      ]
    : ["requestId", "approvalMode", "expiresAt", "status", "instanceId"];
  if (
    !hasExactKeys(data, expectedKeys) ||
    typeof data.instanceId !== "string" ||
    !/^instance-[0-9a-f]{12}$/.test(data.instanceId) ||
    (requireCredential && (
      typeof data.token !== "string" ||
      !/^[A-Za-z0-9_-]{43}$/.test(data.token) ||
      typeof data.approvalProof !== "string" ||
      !/^[A-Za-z0-9_-]{43}$/.test(data.approvalProof) ||
      (approvalMode === "browser_session" && (
        typeof data.sessionTrustKey !== "string" ||
        !/^[A-Za-z0-9_-]{43}$/.test(data.sessionTrustKey)
      ))
    ))
  ) {
    return null;
  }
  return data as unknown as ConnectionResponseData;
}

function isPersistentState(value: unknown): value is LocalAgentBridgePersistentState {
  return isRecord(value) &&
    hasExactKeys(value, ["installationId"]) &&
    isUuidV4(value.installationId);
}

function isSessionState(value: unknown): value is LocalAgentBridgeSessionState {
  if (!isRecord(value) || !isUuidV4(value.browserSessionId)) return false;
  if ("latestSnapshot" in value && !isPublishInput(value.latestSnapshot)) return false;
  if (
    "snapshotObservationCapability" in value &&
    value.snapshotObservationCapability !== "v1" &&
    value.snapshotObservationCapability !== "none"
  ) return false;
  if (
    "structuredCaptureCapability" in value &&
    value.structuredCaptureCapability !== "v1" &&
    value.structuredCaptureCapability !== "none"
  ) return false;
  if (hasSessionKeys(value, ["browserSessionId"])) return true;
  if (hasSessionKeys(value, ["browserSessionId", "trustKey"])) {
    return isSecretKey(value.trustKey);
  }
  if (
    hasSessionKeys(value, ["browserSessionId", "pending"]) ||
    hasSessionKeys(value, ["browserSessionId", "trustKey", "pending"])
  ) {
    if ("trustKey" in value && !isSecretKey(value.trustKey)) return false;
    return isPendingRequest(value.pending);
  }
  if (
    !hasSessionKeys(value, ["browserSessionId", "instanceId", "token", "sequence"]) &&
    !hasSessionKeys(value, ["browserSessionId", "trustKey", "instanceId", "token", "sequence"])
  ) {
    return false;
  }
  return ("trustKey" in value ? isSecretKey(value.trustKey) : true) &&
    typeof value.instanceId === "string" &&
    /^instance-[0-9a-f]{12}$/.test(value.instanceId) &&
    typeof value.token === "string" &&
    /^[A-Za-z0-9_-]{43}$/.test(value.token) &&
    Number.isSafeInteger(value.sequence) &&
    (value.sequence as number) >= 0;
}

function hasSessionKeys(value: Record<string, unknown>, expected: string[]): boolean {
  return hasExactKeys(value, [
    ...expected,
    ...(Object.hasOwn(value, "latestSnapshot") ? ["latestSnapshot"] : []),
    ...(Object.hasOwn(value, "snapshotObservationCapability")
      ? ["snapshotObservationCapability"]
      : []),
    ...(Object.hasOwn(value, "structuredCaptureCapability")
      ? ["structuredCaptureCapability"]
      : []),
  ]);
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
    publishedAt: validationPublishedAt,
    page: value.page,
    attachmentCount: value.attachmentCount,
    agentCopy: value.agentCopy,
    ...(value.capture === undefined ? {} : { capture: value.capture }),
    ...(value.observations === undefined ? {} : { observations: value.observations }),
    ...(value.activity === undefined ? {} : { activity: value.activity }),
  });
}

function isPendingRequest(value: unknown): value is LocalAgentBridgePendingRequest {
  return isRecord(value) &&
    hasExactKeys(value, [
      "requestId",
      "requestSecret",
      "approvalKey",
      "approvalMode",
      "expiresAt",
      "requestText",
    ]) &&
    isUuidV4(value.requestId) &&
    typeof value.requestSecret === "string" &&
    /^[A-Za-z0-9_-]{43}$/.test(value.requestSecret) &&
    isSecretKey(value.approvalKey) &&
    (value.approvalMode === "ask" || value.approvalMode === "browser_session") &&
    isCanonicalIsoDate(value.expiresAt) &&
    typeof value.requestText === "string" &&
    value.requestText.length <= 1_024 &&
    !value.requestText.includes(value.requestSecret) &&
    value.requestText.includes(value.approvalKey);
}

async function verifyConnectionApproval(
  response: ConnectionResponseData,
  pending: LocalAgentBridgePendingRequest,
  trustKey: string | null,
): Promise<boolean> {
  if (
    response.status !== "approved" ||
    !response.instanceId ||
    !response.token ||
    !response.approvalProof
  ) {
    return false;
  }
  const message = createLocalBridgeApprovalProofMessage({
    requestId: response.requestId,
    approvalMode: response.approvalMode,
    expiresAt: response.expiresAt,
    status: "approved",
    instanceId: response.instanceId,
    token: response.token,
    sessionTrustKey: response.sessionTrustKey ?? null,
  });
  const keys = [...new Set([pending.approvalKey, trustKey].filter(isSecretKey))];
  for (const key of keys) {
    const cryptoKey = await crypto.subtle.importKey(
      "raw",
      toArrayBuffer(base64UrlToBytes(key)),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign"],
    );
    const expected = new Uint8Array(await crypto.subtle.sign(
      "HMAC",
      cryptoKey,
      new TextEncoder().encode(message),
    ));
    const received = base64UrlToBytes(response.approvalProof);
    if (sameBytes(expected, received)) return true;
  }
  return false;
}

async function sha256Base64Url(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", toArrayBuffer(base64UrlToBytes(value)));
  return bytesToBase64Url(new Uint8Array(digest));
}

function base64UrlToBytes(value: string): Uint8Array {
  const base64 = value.replaceAll("-", "+").replaceAll("_", "/") +
    "=".repeat((4 - value.length % 4) % 4);
  const binary = atob(base64);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

function sameBytes(left: Uint8Array, right: Uint8Array): boolean {
  if (left.length !== right.length) return false;
  let difference = 0;
  for (let index = 0; index < left.length; index += 1) {
    difference |= left[index] ^ right[index];
  }
  return difference === 0;
}

function toArrayBuffer(value: Uint8Array): ArrayBuffer {
  return Uint8Array.from(value).buffer;
}

function isSecretKey(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9_-]{43}$/.test(value);
}

function bytesToBase64Url(value: Uint8Array): string {
  let binary = "";
  for (const byte of value) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

function isUuidV4(value: unknown): value is string {
  return typeof value === "string" &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

function isCanonicalIsoDate(value: unknown): value is string {
  if (typeof value !== "string") return false;
  try {
    return new Date(value).toISOString() === value;
  } catch {
    return false;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, expected: string[]): boolean {
  const actual = Object.keys(value).sort();
  const sortedExpected = [...expected].sort();
  return actual.length === sortedExpected.length &&
    actual.every((key, index) => key === sortedExpected[index]);
}

async function readJson(response: Response): Promise<unknown> {
  try {
    return await response.json() as unknown;
  } catch {
    return null;
  }
}
