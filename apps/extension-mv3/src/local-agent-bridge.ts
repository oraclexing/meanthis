import {
  UI_ATTACH_LOCAL_BRIDGE_CAPABILITIES_PATH,
  UI_ATTACH_LOCAL_BRIDGE_CONNECTION_REQUEST_PATH,
  UI_ATTACH_LOCAL_BRIDGE_HEARTBEAT_PATH,
  UI_ATTACH_LOCAL_BRIDGE_ORIGIN,
  UI_ATTACH_LOCAL_BRIDGE_READ_ACKNOWLEDGEMENT_PATH,
  UI_ATTACH_LOCAL_BRIDGE_SNAPSHOT_PATH,
  UI_ATTACH_LOCAL_BRIDGE_SHARED_CAPTURE_PATH,
  UI_ATTACH_LOCAL_BRIDGE_STRUCTURED_CAPTURE_CAPABILITIES_PATH,
  createLocalBridgeApprovalProofMessage,
  createLocalBridgeConnectionCode,
  isLocalBridgeCapabilities,
  isLocalBridgeSnapshot,
  isLocalBridgeStructuredCaptureCapabilities,
  parseLocalBridgeReadAcknowledgement,
  parseLocalBridgeConnectionCode,
  type LocalBridgeApprovalMode,
  type LocalBridgeActivityV1,
  type LocalBridgeCaptureV1,
  type LocalBridgeObservationsV1,
  type LocalBridgePageV1,
} from "@meanthis/schema";
import type { ExtensionStorageArea } from "./capture-store";
import {
  createAnnotationLifecycleControlTransport,
  type AnnotationLifecycleOperationApprovalV1,
  type AnnotationLifecycleOperationClaimV1,
  type AnnotationLifecycleControlAuthorityV1,
  type AnnotationLifecycleOperationReferenceV1,
  type AnnotationLifecycleOperationViewV1,
} from "./annotation-lifecycle-control-client";
import type { AnnotationLifecycleOperationReceiptV1 } from "@meanthis/schema";

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
  panelSnapshot?: LocalAgentBridgePublishInput;
  sessionSnapshot?: LocalAgentBridgePublishInput;
  activeSnapshotSource?: "panel" | "session" | "unknown";
  publishedSnapshot?: LocalAgentBridgePublishInput;
  clearPending?: true;
  snapshotObservationCapability?: LocalAgentBridgeCapabilityState;
  structuredCaptureCapability?: LocalAgentBridgeCapabilityState;
  /** One bounded v2 re-probe is allowed when an older v1 owner meets a V3 capture. */
  structuredCaptureV2UpgradeProbeUsed?: true;
  /** One bounded v3 re-probe is allowed when a v1/v2 owner meets replay diagnostics. */
  structuredCaptureV3UpgradeProbeUsed?: true;
}

type LocalAgentBridgeStructuredCaptureVersion = "v3" | "v2" | "v1";
type LocalAgentBridgeCapabilityState = LocalAgentBridgeStructuredCaptureVersion | "none" | "unknown";

interface EffectivePublishInput {
  input: LocalAgentBridgePublishInput;
  complete: boolean;
}

interface PublishInternalResult {
  status: "published" | "unchanged" | "failed";
  complete: boolean;
}

export interface LocalAgentBridgeStatus {
  connected: boolean;
  instanceId: string | null;
  pending: boolean;
  approvalMode: LocalBridgeApprovalMode | null;
  requestText: string | null;
  expiresAt: string | null;
  /** Exact target count from the last snapshot acknowledged by the local bridge. */
  sharedTargetCount: number | null;
  /** Sequence of that acknowledged snapshot, or null before the first publish. */
  sharedSequence: number | null;
  /** Ephemeral, authenticated read acknowledgement for the currently published snapshot. */
  readAcknowledgementState?: LocalAgentBridgeReadAcknowledgementState;
}

export type LocalAgentBridgeReadAcknowledgementState =
  | "waiting"
  | "current"
  | "unavailable";

export interface LocalAgentBridgePublishInput {
  page: LocalBridgePageV1 | null;
  attachmentCount: number;
  agentCopy: string | null;
  capture?: LocalBridgeCaptureV1;
  observations?: LocalBridgeObservationsV1;
  activity?: LocalBridgeActivityV1;
}

type LocalAgentBridgeStatusOperation =
  | "readStatus"
  | "refreshConnection"
  | "refreshConnectionAndHeartbeat";

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
  refreshConnectionAndHeartbeat(): Promise<LocalAgentBridgeStatus>;
  publish(input: LocalAgentBridgePublishInput): Promise<boolean>;
  publishSessionContext(input: LocalAgentBridgePublishInput): Promise<boolean>;
  clearSessionContext(): Promise<boolean>;
  clearPanelContext(): Promise<boolean>;
  clearSharedCapture?(): Promise<boolean>;
  disconnect(): Promise<void>;
  repairConnection?(): Promise<void>;
  annotationLifecycleControl?: {
    readAuthority(): Promise<AnnotationLifecycleControlAuthorityV1>;
    readNext(): Promise<AnnotationLifecycleOperationViewV1 | null>;
    claim(reference: AnnotationLifecycleOperationReferenceV1): Promise<AnnotationLifecycleOperationClaimV1>;
    reject(reference: AnnotationLifecycleOperationReferenceV1): Promise<AnnotationLifecycleOperationViewV1>;
    finalize(
      reference: AnnotationLifecycleOperationReferenceV1,
      approval: AnnotationLifecycleOperationApprovalV1,
      receipt: AnnotationLifecycleOperationReceiptV1,
    ): Promise<AnnotationLifecycleOperationViewV1>;
  };
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
  ensureOwnersReady?(): Promise<void>;
  repairOwners?(): Promise<void>;
}

export interface BrowserLocalAgentBridgeClientOptions {
  requestPermission?(): Promise<boolean>;
  withSessionLock?<T>(operation: () => Promise<T>): Promise<T>;
  ensureOwnersReady?(): Promise<void>;
  repairOwners?(): Promise<void>;
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
    ensureOwnersReady: options.ensureOwnersReady,
    repairOwners: options.repairOwners,
  });
}

export function createLocalAgentBridgeClient(
  dependencies: LocalAgentBridgeDependencies,
): LocalAgentBridgeClient {
  let operationTail: Promise<void> = Promise.resolve();
  let operationGeneration = 0;
  const statusOperations = new Map<
    LocalAgentBridgeStatusOperation,
    { generation: number; promise: Promise<LocalAgentBridgeStatus> }
  >();
  const annotationLifecycleTransport = createAnnotationLifecycleControlTransport({
    fetch: dependencies.fetch,
  });

  function enqueue<T>(operation: () => Promise<T>): Promise<T> {
    // Every non-status operation is a barrier for an older status read. A
    // status request created after this call must observe the queue after the
    // mutation, even if the older request is still waiting on the network.
    operationGeneration += 1;
    const promise = enqueueWithoutBarrier(operation);
    invalidateReadStatusAfterSettlement(promise);
    return promise;
  }

  function enqueueWithoutBarrier<T>(operation: () => Promise<T>): Promise<T> {
    const run = () => dependencies.withSessionLock(operation);
    const result = operationTail.then(run, run);
    operationTail = result.then(() => undefined, () => undefined);
    return result;
  }

  function enqueueStatusOperation(
    kind: LocalAgentBridgeStatusOperation,
    operation: () => Promise<LocalAgentBridgeStatus>,
  ): Promise<LocalAgentBridgeStatus> {
    const existing = statusOperations.get(kind);
    if (existing?.generation === operationGeneration) return existing.promise;

    const generation = ++operationGeneration;
    const promise = enqueueWithoutBarrier(operation);
    const tracked = trackStatusOperation(kind, generation, promise);
    invalidateReadStatusAfterSettlement(promise);
    return tracked;
  }

  function invalidateReadStatusAfterSettlement<T>(promise: Promise<T>): void {
    void promise.then(invalidateReadStatus, invalidateReadStatus);
  }

  function invalidateReadStatus(): void {
    // Settlement invalidates only the read result. Keep the generation stable
    // so a same-kind refresh already queued behind this operation can merge.
    statusOperations.delete("readStatus");
  }

  function trackStatusOperation(
    kind: LocalAgentBridgeStatusOperation,
    generation: number,
    promise: Promise<LocalAgentBridgeStatus>,
  ): Promise<LocalAgentBridgeStatus> {
    statusOperations.set(kind, { generation, promise });
    const clear = () => {
      const current = statusOperations.get(kind);
      if (current?.promise === promise) statusOperations.delete(kind);
    };
    // Use then rather than finally so the cleanup branch cannot create an
    // unhandled rejection for a caller that intentionally observes the error.
    void promise.then(clear, clear);
    return promise;
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
    return isSessionState(value) ? normalizeLegacySnapshotState(value) : null;
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
    preserveClearPending = true,
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
      ...(preserveClearPending && state.clearPending ? { clearPending: true as const } : {}),
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
      ...(state.panelSnapshot ? { panelSnapshot: state.panelSnapshot } : {}),
      ...(state.sessionSnapshot ? { sessionSnapshot: state.sessionSnapshot } : {}),
      ...(state.activeSnapshotSource
        ? { activeSnapshotSource: state.activeSnapshotSource }
        : {}),
      ...(state.clearPending ? { clearPending: true } : {}),
    };
    await saveSessionState(connected);
    return toStatus(connected);
  }

  async function publishInternal(
    state: LocalAgentBridgeSessionState,
    input: LocalAgentBridgePublishInput,
  ): Promise<PublishInternalResult> {
    if (!state.instanceId || !state.token) return { status: "failed", complete: false };
    const capabilities = await readSnapshotCapabilities(state, {
      observations: Boolean(input.observations),
      structuredCapture: Boolean(input.capture),
      requiredStructuredCapture: requiredStructuredCaptureVersion(input.capture),
    });
    const effective = toEffectivePublishInput(input, capabilities);
    const current = await readSessionState();
    if (
      !current?.instanceId ||
      current.instanceId !== state.instanceId ||
      current.token !== state.token ||
      current.clearPending
    ) {
      return { status: "failed", complete: false };
    }
    if (
      current.publishedSnapshot &&
      samePublishInput(current.publishedSnapshot, effective.input)
    ) {
      return { status: "unchanged", complete: effective.complete };
    }
    const snapshot = {
      schemaVersion: "0.1.0",
      kind: "ui-attach.local-bridge-snapshot",
      sequence: (current.sequence ?? 0) + 1,
      publishedAt: dependencies.now().toISOString(),
      ...effective.input,
    };
    if (!isLocalBridgeSnapshot(snapshot)) return { status: "failed", complete: false };
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
        return { status: "failed", complete: false };
      }
      if (!response.ok) return { status: "failed", complete: false };
      const latest = await readSessionState();
      if (
        !latest?.instanceId ||
        latest.instanceId !== state.instanceId ||
        latest.token !== state.token
      ) {
        return { status: "failed", complete: false };
      }
      await saveSessionState({
        ...latest,
        sequence: Math.max(latest.sequence ?? 0, snapshot.sequence),
        publishedSnapshot: structuredClone(effective.input),
      });
      return { status: "published", complete: effective.complete };
    } catch {
      return { status: "failed", complete: false };
    }
  }

  async function heartbeatInternal(state: LocalAgentBridgeSessionState): Promise<boolean> {
    if (!state.instanceId || !state.token) return false;
    try {
      const response = await dependencies.fetch(
        `${UI_ATTACH_LOCAL_BRIDGE_ORIGIN}${UI_ATTACH_LOCAL_BRIDGE_HEARTBEAT_PATH}`,
        {
          method: "POST",
          redirect: "error",
          signal: AbortSignal.timeout(LOCAL_AGENT_BRIDGE_REQUEST_TIMEOUT_MS),
          headers: { authorization: `Bearer ${state.token}` },
        },
      );
      if (response.status === 401) {
        const latest = await readSessionState();
        if (latest?.instanceId === state.instanceId && latest.token === state.token) {
          await clearSessionCredentials(latest, false, true);
        }
        await dependencies.removePermission().catch(() => false);
        return false;
      }
      return response.ok;
    } catch {
      return false;
    }
  }

  async function readAcknowledgementState(
    state: LocalAgentBridgeSessionState | null,
  ): Promise<LocalAgentBridgeStatus> {
    const base = toStatus(state);
    // A bridge without a published structured capture cannot have a matching
    // acknowledgement. Keep this status local and avoid an unnecessary probe.
    if (
      !state?.instanceId ||
      !state.token ||
      !state.publishedSnapshot?.capture
    ) {
      return base;
    }

    let response: Response;
    try {
      response = await dependencies.fetch(
        `${UI_ATTACH_LOCAL_BRIDGE_ORIGIN}${UI_ATTACH_LOCAL_BRIDGE_READ_ACKNOWLEDGEMENT_PATH}`,
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
      return { ...base, readAcknowledgementState: "unavailable" };
    }

    if (!response || typeof response.status !== "number" || typeof response.ok !== "boolean") {
      return { ...base, readAcknowledgementState: "unavailable" };
    }
    if (response.status === 401) {
      const latest = await readSessionState();
      if (latest?.instanceId === state.instanceId && latest.token === state.token) {
        await clearSessionCredentials(latest, false, true);
      }
      await dependencies.removePermission().catch(() => false);
      return disconnectedStatus();
    }
    if (!response.ok) {
      return { ...base, readAcknowledgementState: "unavailable" };
    }

    const bodyResult = await readJsonResult(response);
    if (!bodyResult.ok) {
      return { ...base, readAcknowledgementState: "unavailable" };
    }
    if (bodyResult.value === null) {
      return { ...base, readAcknowledgementState: "waiting" };
    }
    const acknowledgement = parseLocalBridgeReadAcknowledgement(bodyResult.value);
    if (!acknowledgement) {
      return { ...base, readAcknowledgementState: "unavailable" };
    }

    // Re-read session state after the network round trip so a snapshot
    // published while the GET was in flight cannot be marked current.
    const latest = await readSessionState();
    const latestBase = toStatus(latest);
    if (
      !latest?.instanceId ||
      latest.instanceId !== state.instanceId ||
      latest.token !== state.token ||
      !latest.publishedSnapshot?.capture
    ) {
      return latestBase;
    }
    const current = acknowledgement.instanceId === latest.instanceId &&
      acknowledgement.captureId === latest.publishedSnapshot.capture.captureId &&
      acknowledgement.snapshotSequence === latest.sequence;
    return {
      ...latestBase,
      // A valid acknowledgement for an older/newer snapshot is not current.
      // The bridge may return one transiently while the extension is catching
      // up, so expose the safe waiting state rather than treating it as an
      // unavailable transport.
      readAcknowledgementState: current ? "current" : "waiting",
    };
  }

  async function clearSharedCaptureInternal(
    state: LocalAgentBridgeSessionState,
  ): Promise<boolean> {
    if (!state.clearPending || !state.instanceId || !state.token) return false;
    try {
      const response = await dependencies.fetch(
        `${UI_ATTACH_LOCAL_BRIDGE_ORIGIN}${UI_ATTACH_LOCAL_BRIDGE_SHARED_CAPTURE_PATH}`,
        {
          method: "DELETE",
          redirect: "error",
          signal: AbortSignal.timeout(LOCAL_AGENT_BRIDGE_REQUEST_TIMEOUT_MS),
          headers: { authorization: `Bearer ${state.token}` },
        },
      );
      if (response.status === 401) {
        const latest = await readSessionState();
        if (latest?.instanceId === state.instanceId && latest.token === state.token) {
          await clearSessionCredentials(latest, false, true);
        }
        await dependencies.removePermission().catch(() => false);
        return false;
      }
      if (!response.ok) return false;
      const latest = await readSessionState();
      if (latest?.instanceId !== state.instanceId || latest.token !== state.token) return false;
      const {
        latestSnapshot: _latestSnapshot,
        panelSnapshot: _panelSnapshot,
        sessionSnapshot: _sessionSnapshot,
        activeSnapshotSource: _activeSnapshotSource,
        publishedSnapshot: _publishedSnapshot,
        clearPending: _clearPending,
        ...cleared
      } = latest;
      await saveSessionState(cleared);
      return true;
    } catch {
      return false;
    }
  }

  async function refreshConnectionAndPendingClearInternal(): Promise<LocalAgentBridgeStatus> {
    await refreshConnectionInternal();
    const state = await readSessionState();
    if (state?.clearPending && state.instanceId && state.token) {
      await clearSharedCaptureInternal(state);
    }
    return readAcknowledgementState(await readSessionState());
  }

  async function readSnapshotCapabilities(
    state: LocalAgentBridgeSessionState,
    requested: {
      observations: boolean;
      structuredCapture: boolean;
      requiredStructuredCapture: LocalAgentBridgeStructuredCaptureVersion;
    },
  ): Promise<{
    observations: LocalAgentBridgeCapabilityState;
    structuredCapture: LocalAgentBridgeCapabilityState;
  }> {
    const observations = requested.observations
      ? await readSnapshotCapability(state, "observations")
      : "none";
    const latest = await readSessionState();
    const structuredCapture = requested.structuredCapture
      ? await readSnapshotCapability(
        latest ?? state,
        "structuredCapture",
        requested.requiredStructuredCapture,
      )
      : "none";
    return { observations, structuredCapture };
  }

  async function readSnapshotCapability(
    state: LocalAgentBridgeSessionState,
    capability: "observations" | "structuredCapture",
    requiredStructuredCapture: LocalAgentBridgeStructuredCaptureVersion = "v1",
  ): Promise<LocalAgentBridgeCapabilityState> {
    const cached = capability === "observations"
      ? state.snapshotObservationCapability
      : state.structuredCaptureCapability;
    if (capability === "observations") {
      if (cached === "v1" || cached === "none") return cached;
    } else {
      const upgradeProbeUsed = requiredStructuredCapture === "v3"
        ? state.structuredCaptureV3UpgradeProbeUsed
        : requiredStructuredCapture === "v2"
          ? state.structuredCaptureV2UpgradeProbeUsed
          : false;
      // Each protocol generation gets one connection-scoped upgrade probe.
      // A timeout or lower-version response must not cause an unbounded probe
      // loop on every subsequent snapshot.
      if (cached === "none") return cached;
      if (
        isStructuredCaptureVersion(cached) &&
        supportsStructuredCapture(cached, requiredStructuredCapture)
      ) return cached;
      if (requiredStructuredCapture !== "v1" && cached !== undefined) {
        if (upgradeProbeUsed) return cached ?? "unknown";
        await markStructuredCaptureUpgradeProbeUsed(state, requiredStructuredCapture);
      }
    }
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
      if (capability === "structuredCapture" &&
        requiredStructuredCapture !== "v1" && cached === undefined) {
        await markStructuredCaptureUpgradeProbeUsed(state, requiredStructuredCapture);
      }
      await saveSnapshotCapability(state, capability, "unknown");
      return "unknown";
    }
    const body = await readJson(response);
    const negotiated: LocalAgentBridgeCapabilityState = capability === "observations"
      ? response.ok && isLocalBridgeCapabilities(body)
        ? "v1"
        : response.status === 404
          ? "none"
          : "unknown"
      : response.ok && isLocalBridgeStructuredCaptureCapabilities(body)
        ? body.structuredCapture
        : response.status === 404
          ? "none"
          : "unknown";
    if (capability === "structuredCapture" &&
      requiredStructuredCapture !== "v1" && cached === undefined && negotiated === "unknown") {
      await markStructuredCaptureUpgradeProbeUsed(state, requiredStructuredCapture);
    }
    await saveSnapshotCapability(state, capability, negotiated);
    return negotiated;
  }

  async function markStructuredCaptureUpgradeProbeUsed(
    state: LocalAgentBridgeSessionState,
    requiredVersion: LocalAgentBridgeStructuredCaptureVersion,
  ): Promise<void> {
    if (requiredVersion === "v1") return;
    const latest = await readSessionState();
    const key = requiredVersion === "v3"
      ? "structuredCaptureV3UpgradeProbeUsed"
      : "structuredCaptureV2UpgradeProbeUsed";
    if (
      latest !== null &&
      latest.instanceId === state.instanceId &&
      latest.token === state.token &&
      !latest[key]
    ) {
      await saveSessionState({ ...latest, [key]: true });
    }
  }

  async function saveSnapshotCapability(
    state: LocalAgentBridgeSessionState,
    capability: "observations" | "structuredCapture",
    negotiated: LocalAgentBridgeCapabilityState,
  ): Promise<void> {
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
  }

  return {
    annotationLifecycleControl: {
      readAuthority() {
        return enqueue(async () => {
          const state = await readSessionState();
          if (!state?.instanceId || !state.token || state.clearPending) {
            throw new Error("Local bridge control connection is unavailable.");
          }
          return await annotationLifecycleTransport.readAuthority(state.token);
        });
      },
      readNext() {
        return enqueue(async () => {
          const state = await readSessionState();
          if (!state?.instanceId || !state.token || state.clearPending) return null;
          return await annotationLifecycleTransport.readNext(state.token);
        });
      },

      claim(reference) {
        return enqueue(async () => {
          const state = await readSessionState();
          if (!state?.instanceId || !state.token || state.clearPending) {
            throw new Error("Local bridge control connection is unavailable.");
          }
          return await annotationLifecycleTransport.claim(state.token, reference);
        });
      },

      reject(reference) {
        return enqueue(async () => {
          const state = await readSessionState();
          if (!state?.instanceId || !state.token || state.clearPending) {
            throw new Error("Local bridge control connection is unavailable.");
          }
          return await annotationLifecycleTransport.reject(state.token, reference);
        });
      },

      finalize(reference, approval, receipt) {
        return enqueue(async () => {
          const state = await readSessionState();
          if (!state?.instanceId || !state.token || state.clearPending) {
            throw new Error("Local bridge control connection is unavailable.");
          }
          return await annotationLifecycleTransport.finalize(
            state.token,
            reference,
            approval,
            receipt,
          );
        });
      },
    },

    async repairConnection() {
      if (!dependencies.repairOwners) throw new Error("Local companion repair is unavailable.");
      await dependencies.repairOwners();
    },

    readStatus() {
      const existing = statusOperations.get("readStatus");
      if (existing?.generation === operationGeneration) return existing.promise;
      const promise = (async () => {
        await readPersistentState();
        return readAcknowledgementState(await readSessionState());
      })();
      return trackStatusOperation("readStatus", operationGeneration, promise);
    },

    createConnectionRequest(approvalMode) {
      return enqueue(async () => {
        if (approvalMode !== "ask" && approvalMode !== "browser_session") {
          throw new Error("Invalid local agent approval mode.");
        }
        if (!await dependencies.requestPermission()) {
          throw new Error("Loopback access was not granted.");
        }
        try {
          await dependencies.ensureOwnersReady?.();
        } catch (error) {
          await dependencies.removePermission().catch(() => false);
          throw error;
        }
        const persistent = await ensurePersistentState();
        let session = await ensureSessionState();
        if (session.instanceId && session.token) return toStatus(session);
        if (
          session.pending &&
          dependencies.now().getTime() >= Date.parse(session.pending.expiresAt)
        ) {
          const { pending: _expiredPending, ...remainingSession } = session;
          await saveSessionState(remainingSession);
          session = remainingSession;
        }
        if (session.pending) {
          if (session.pending.approvalMode !== approvalMode) {
            throw new Error(
              "A connection invitation with a different approval mode is already pending.",
            );
          }
          return toStatus(session);
        }
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
            ),
          };
          await saveSessionState({
            browserSessionId: session.browserSessionId,
            ...(session.trustKey ? { trustKey: session.trustKey } : {}),
            ...(session.latestSnapshot ? { latestSnapshot: session.latestSnapshot } : {}),
            ...(session.panelSnapshot ? { panelSnapshot: session.panelSnapshot } : {}),
            ...(session.sessionSnapshot ? { sessionSnapshot: session.sessionSnapshot } : {}),
            ...(session.activeSnapshotSource
              ? { activeSnapshotSource: session.activeSnapshotSource }
              : {}),
            ...(session.clearPending ? { clearPending: true } : {}),
            pending,
          });
          return parsed.status === "approved"
            ? refreshConnectionAndPendingClearInternal()
            : toStatus({
                browserSessionId: session.browserSessionId,
                ...(session.trustKey ? { trustKey: session.trustKey } : {}),
                ...(session.latestSnapshot ? { latestSnapshot: session.latestSnapshot } : {}),
                ...(session.panelSnapshot ? { panelSnapshot: session.panelSnapshot } : {}),
                ...(session.sessionSnapshot ? { sessionSnapshot: session.sessionSnapshot } : {}),
                ...(session.activeSnapshotSource
                  ? { activeSnapshotSource: session.activeSnapshotSource }
                  : {}),
                ...(session.clearPending ? { clearPending: true } : {}),
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
      return enqueueStatusOperation(
        "refreshConnection",
        refreshConnectionAndPendingClearInternal,
      );
    },

    refreshConnectionAndHeartbeat() {
      return enqueueStatusOperation("refreshConnectionAndHeartbeat", async () => {
        await refreshConnectionInternal();
        const state = await readSessionState();
        if (state?.instanceId && state.token) {
          if (state.clearPending) {
            await clearSharedCaptureInternal(state);
          } else if (
            state.latestSnapshot &&
            state.publishedSnapshot &&
            samePublishInput(state.latestSnapshot, state.publishedSnapshot)
          ) {
            await heartbeatInternal(state);
          } else if (state.latestSnapshot) {
            const result = await publishInternal(
              state,
              downgradeCachedSnapshot(state.latestSnapshot),
            );
            if (result.status === "unchanged") {
              await heartbeatInternal((await readSessionState()) ?? state);
            }
          } else {
            await heartbeatInternal(state);
          }
        }
        return readAcknowledgementState(await readSessionState());
      });
    },

    publish(input) {
      return enqueue(async () => {
        const state = await readSessionState();
        if (!state?.pending && (!state?.instanceId || !state.token)) return false;
        if (state.clearPending) return false;
        if (!isPublishInput(input)) return false;
        const merged = mergePanelContextPublishInput(state.sessionSnapshot, input);
        if (!isPublishInput(merged)) return false;
        const latestState = {
          ...state,
          latestSnapshot: structuredClone(merged),
          panelSnapshot: structuredClone(merged),
          activeSnapshotSource: "panel" as const,
        };
        await saveSessionState(latestState);
        const result = await publishInternal(latestState, merged);
        return result.status !== "failed" && result.complete;
      });
    },

    publishSessionContext(input) {
      return enqueue(async () => {
        const state = await readSessionState();
        if (!state?.pending && (!state?.instanceId || !state.token)) return false;
        if (state.clearPending || !isPublishInput(input)) return false;
        const merged = mergeSessionContextPublishInput(state.panelSnapshot, input);
        if (!isPublishInput(merged)) return false;
        const latestState = {
          ...state,
          latestSnapshot: structuredClone(merged),
          sessionSnapshot: structuredClone(input),
          activeSnapshotSource: "session" as const,
        };
        await saveSessionState(latestState);
        const result = await publishInternal(latestState, merged);
        return result.status !== "failed" && result.complete;
      });
    },

    clearSessionContext() {
      return enqueue(async () => {
        const state = await readSessionState();
        if (!state) return false;
        const {
          sessionSnapshot: _sessionSnapshot,
          ...withoutSessionSnapshot
        } = state;
        if (state.activeSnapshotSource !== "session") {
          await saveSessionState(withoutSessionSnapshot);
          return true;
        }
        if (state.panelSnapshot) {
          const fallback: LocalAgentBridgeSessionState = {
            ...withoutSessionSnapshot,
            latestSnapshot: structuredClone(state.panelSnapshot),
            activeSnapshotSource: "panel",
          };
          await saveSessionState(fallback);
          if (!state.instanceId || !state.token) return Boolean(state.pending);
          const result = await publishInternal(fallback, state.panelSnapshot);
          return result.status !== "failed" && result.complete;
        }
        const {
          latestSnapshot: _latestSnapshot,
          panelSnapshot: _panelSnapshot,
          activeSnapshotSource: _activeSnapshotSource,
          publishedSnapshot: _publishedSnapshot,
          ...withoutSnapshots
        } = withoutSessionSnapshot;
        const tombstone: LocalAgentBridgeSessionState = {
          ...withoutSnapshots,
          clearPending: true,
        };
        await saveSessionState(tombstone);
        if (!state.instanceId || !state.token) return Boolean(state.pending);
        return clearSharedCaptureInternal(tombstone);
      });
    },

    clearPanelContext() {
      return enqueue(async () => {
        const state = await readSessionState();
        if (!state) return false;
        const {
          panelSnapshot: _panelSnapshot,
          ...withoutPanelSnapshot
        } = state;
        if (
          state.activeSnapshotSource !== "panel" &&
          state.activeSnapshotSource !== "unknown"
        ) {
          await saveSessionState(withoutPanelSnapshot);
          return true;
        }
        if (state.sessionSnapshot) {
          const fallback: LocalAgentBridgeSessionState = {
            ...withoutPanelSnapshot,
            latestSnapshot: structuredClone(state.sessionSnapshot),
            activeSnapshotSource: "session",
          };
          await saveSessionState(fallback);
          if (!state.instanceId || !state.token) return Boolean(state.pending);
          const result = await publishInternal(fallback, state.sessionSnapshot);
          return result.status !== "failed" && result.complete;
        }
        const {
          latestSnapshot: _latestSnapshot,
          sessionSnapshot: _sessionSnapshot,
          activeSnapshotSource: _activeSnapshotSource,
          publishedSnapshot: _publishedSnapshot,
          ...withoutSnapshots
        } = withoutPanelSnapshot;
        const tombstone: LocalAgentBridgeSessionState = {
          ...withoutSnapshots,
          clearPending: true,
        };
        await saveSessionState(tombstone);
        if (!state.instanceId || !state.token) return Boolean(state.pending);
        return clearSharedCaptureInternal(tombstone);
      });
    },

    clearSharedCapture() {
      return enqueue(async () => {
        const state = await readSessionState();
        if (!state) return false;
        const {
          latestSnapshot: _latestSnapshot,
          panelSnapshot: _panelSnapshot,
          sessionSnapshot: _sessionSnapshot,
          activeSnapshotSource: _activeSnapshotSource,
          publishedSnapshot: _publishedSnapshot,
          ...withoutSnapshots
        } = state;
        const tombstone: LocalAgentBridgeSessionState = {
          ...withoutSnapshots,
          clearPending: true,
        };
        await saveSessionState(tombstone);
        if (!state.instanceId || !state.token) {
          if (!state.pending) return false;
          return true;
        }
        return clearSharedCaptureInternal(tombstone);
      });
    },

    disconnect() {
      return enqueue(async () => {
        const state = await readSessionState();
        try {
          if (state) await clearSessionCredentials(state, true, false, false);
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
      sharedTargetCount: state.publishedSnapshot?.attachmentCount ?? null,
      sharedSequence: state.publishedSnapshot ? state.sequence ?? null : null,
      readAcknowledgementState: "unavailable",
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
      sharedTargetCount: null,
      sharedSequence: null,
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
    sharedTargetCount: null,
    sharedSequence: null,
  };
}

function createConnectionRequestText(
  requestId: string,
  approvalKey: string,
  approvalMode: LocalBridgeApprovalMode,
): string {
  const code = createLocalBridgeConnectionCode({ requestId, approvalMode, approvalKey });
  return `meanthis bridge accept ${code} --json`;
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
  if ("panelSnapshot" in value && !isPublishInput(value.panelSnapshot)) return false;
  if ("sessionSnapshot" in value && !isPublishInput(value.sessionSnapshot)) return false;
  if (
    "activeSnapshotSource" in value &&
    value.activeSnapshotSource !== "panel" &&
    value.activeSnapshotSource !== "session" &&
    value.activeSnapshotSource !== "unknown"
  ) return false;
  const hasPanelSnapshot = Object.hasOwn(value, "panelSnapshot");
  const hasSessionSnapshot = Object.hasOwn(value, "sessionSnapshot");
  const hasActiveSnapshotSource = Object.hasOwn(value, "activeSnapshotSource");
  if (!hasActiveSnapshotSource && (hasPanelSnapshot || hasSessionSnapshot)) return false;
  if (hasActiveSnapshotSource) {
    if (!("latestSnapshot" in value)) return false;
    if (value.activeSnapshotSource === "panel" && (
      !hasPanelSnapshot ||
      !samePublishInput(value.latestSnapshot as LocalAgentBridgePublishInput,
        value.panelSnapshot as LocalAgentBridgePublishInput)
    )) return false;
    if (value.activeSnapshotSource === "session" && !hasSessionSnapshot) return false;
    if (value.activeSnapshotSource === "unknown" && (
      !hasPanelSnapshot ||
      hasSessionSnapshot ||
      !samePublishInput(value.latestSnapshot as LocalAgentBridgePublishInput,
        value.panelSnapshot as LocalAgentBridgePublishInput)
    )) return false;
  }
  if ("publishedSnapshot" in value && !isPublishInput(value.publishedSnapshot)) return false;
  if ("clearPending" in value && value.clearPending !== true) return false;
  if (
    "snapshotObservationCapability" in value &&
    value.snapshotObservationCapability !== "v1" &&
    value.snapshotObservationCapability !== "none" &&
    value.snapshotObservationCapability !== "unknown"
  ) return false;
  if (
    "structuredCaptureCapability" in value &&
    value.structuredCaptureCapability !== "v3" &&
    value.structuredCaptureCapability !== "v2" &&
    value.structuredCaptureCapability !== "v1" &&
    value.structuredCaptureCapability !== "none" &&
    value.structuredCaptureCapability !== "unknown"
  ) return false;
  if (
    "structuredCaptureV2UpgradeProbeUsed" in value &&
    value.structuredCaptureV2UpgradeProbeUsed !== true
  ) return false;
  if (
    "structuredCaptureV3UpgradeProbeUsed" in value &&
    value.structuredCaptureV3UpgradeProbeUsed !== true
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
    ...(Object.hasOwn(value, "panelSnapshot") ? ["panelSnapshot"] : []),
    ...(Object.hasOwn(value, "sessionSnapshot") ? ["sessionSnapshot"] : []),
    ...(Object.hasOwn(value, "activeSnapshotSource") ? ["activeSnapshotSource"] : []),
    ...(Object.hasOwn(value, "publishedSnapshot") ? ["publishedSnapshot"] : []),
    ...(Object.hasOwn(value, "clearPending") ? ["clearPending"] : []),
    ...(Object.hasOwn(value, "snapshotObservationCapability")
      ? ["snapshotObservationCapability"]
      : []),
    ...(Object.hasOwn(value, "structuredCaptureCapability")
      ? ["structuredCaptureCapability"]
      : []),
    ...(Object.hasOwn(value, "structuredCaptureV2UpgradeProbeUsed")
      ? ["structuredCaptureV2UpgradeProbeUsed"]
      : []),
    ...(Object.hasOwn(value, "structuredCaptureV3UpgradeProbeUsed")
      ? ["structuredCaptureV3UpgradeProbeUsed"]
      : []),
  ]);
}

function normalizeLegacySnapshotState(
  state: LocalAgentBridgeSessionState,
): LocalAgentBridgeSessionState {
  if (
    !state.latestSnapshot ||
    state.panelSnapshot ||
    state.sessionSnapshot ||
    state.activeSnapshotSource
  ) return state;
  return {
    ...state,
    panelSnapshot: structuredClone(state.latestSnapshot),
    activeSnapshotSource: "unknown",
  };
}

function samePublishInput(
  left: LocalAgentBridgePublishInput,
  right: LocalAgentBridgePublishInput,
): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function mergeSessionContextPublishInput(
  current: LocalAgentBridgePublishInput | undefined,
  next: LocalAgentBridgePublishInput,
): LocalAgentBridgePublishInput {
  if (!current || !sameSharedCaptureIdentity(current, next)) return next;
  return {
    ...next,
    ...(current.observations ? { observations: current.observations } : {}),
    ...(current.activity ? { activity: current.activity } : {}),
  };
}

function mergePanelContextPublishInput(
  currentSession: LocalAgentBridgePublishInput | undefined,
  nextPanel: LocalAgentBridgePublishInput,
): LocalAgentBridgePublishInput {
  if (!currentSession || !sameSharedCaptureIdentity(currentSession, nextPanel)) return nextPanel;
  const {
    page: _sessionPage,
    observations: _sessionObservations,
    activity: _sessionActivity,
    ...sessionCanonical
  } = currentSession;
  return {
    ...sessionCanonical,
    page: nextPanel.page,
    ...(nextPanel.observations ? { observations: nextPanel.observations } : {}),
    ...(nextPanel.activity ? { activity: nextPanel.activity } : {}),
  };
}

function sameSharedCaptureIdentity(
  left: LocalAgentBridgePublishInput,
  right: LocalAgentBridgePublishInput,
): boolean {
  if (!left.capture || !right.capture || left.attachmentCount !== right.attachmentCount) return false;
  if (JSON.stringify(left.page) !== JSON.stringify(right.page)) return false;
  if (left.capture.captureId !== right.capture.captureId) return false;
  if (left.capture.targets.length !== right.capture.targets.length) return false;
  return left.capture.targets.every((target, index) => {
    const candidate = right.capture!.targets[index];
    return candidate?.targetId === target.targetId &&
      candidate.attachmentId === target.attachmentId;
  });
}

function toEffectivePublishInput(
  input: LocalAgentBridgePublishInput,
  capabilities: {
    observations: LocalAgentBridgeCapabilityState;
    structuredCapture: LocalAgentBridgeCapabilityState;
  },
): EffectivePublishInput {
  const requiredStructuredCapture = requiredStructuredCaptureVersion(input.capture);
  const structuredCaptureSupported = supportsStructuredCapture(
    capabilities.structuredCapture,
    requiredStructuredCapture,
  );
  return {
    input: {
      page: input.page,
      attachmentCount: input.attachmentCount,
      agentCopy: input.agentCopy,
      ...(structuredCaptureSupported && input.capture
        ? { capture: input.capture }
        : {}),
      ...(capabilities.observations === "v1" && input.observations
        ? { observations: input.observations }
        : {}),
      ...(input.activity ? { activity: input.activity } : {}),
    },
    complete: (!input.capture || (requiredStructuredCapture === "v1"
      ? capabilities.structuredCapture !== "unknown"
      : structuredCaptureSupported)) &&
      (!input.observations || capabilities.observations !== "unknown"),
  };
}

function requiredStructuredCaptureVersion(
  capture: LocalBridgeCaptureV1 | undefined,
): LocalAgentBridgeStructuredCaptureVersion {
  if (capture?.metadataDiagnostics) return "v3";
  if (capture?.annotationLifecycleVersion === "v1") return "v2";
  return "v1";
}

function isStructuredCaptureVersion(
  value: LocalAgentBridgeCapabilityState | undefined,
): value is LocalAgentBridgeStructuredCaptureVersion {
  return value === "v1" || value === "v2" || value === "v3";
}

function supportsStructuredCapture(
  actual: LocalAgentBridgeCapabilityState,
  required: LocalAgentBridgeStructuredCaptureVersion,
): boolean {
  if (!isStructuredCaptureVersion(actual)) return false;
  const rank: Record<LocalAgentBridgeStructuredCaptureVersion, number> = {
    v1: 1,
    v2: 2,
    v3: 3,
  };
  return rank[actual] >= rank[required];
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
  if (!isRecord(value) ||
    hasExactKeys(value, [
      "requestId",
      "requestSecret",
      "approvalKey",
      "approvalMode",
      "expiresAt",
      "requestText",
    ]) === false ||
    !isUuidV4(value.requestId) ||
    typeof value.requestSecret !== "string" ||
    !/^[A-Za-z0-9_-]{43}$/.test(value.requestSecret) ||
    !isSecretKey(value.approvalKey) ||
    (value.approvalMode !== "ask" && value.approvalMode !== "browser_session") ||
    !isCanonicalIsoDate(value.expiresAt) ||
    typeof value.requestText !== "string" ||
    value.requestText.length > 1_024 ||
    value.requestText.includes(value.requestSecret)
  ) return false;
  const match = /^meanthis bridge accept ([A-Za-z0-9]{68}) --json$/.exec(value.requestText);
  const connection = parseLocalBridgeConnectionCode(match?.[1]);
  return connection !== null &&
    connection.requestId === value.requestId &&
    connection.approvalMode === value.approvalMode &&
    connection.approvalKey === value.approvalKey;
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

async function readJsonResult(response: Response): Promise<{ ok: boolean; value: unknown }> {
  try {
    const text = await response.text();
    if (!text.trim()) return { ok: false, value: null };
    return { ok: true, value: JSON.parse(text) as unknown };
  } catch {
    return { ok: false, value: null };
  }
}
