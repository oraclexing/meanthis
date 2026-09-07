import {
  createHash,
  createHmac,
  randomBytes as secureRandomBytes,
  randomInt as secureRandomInt,
  timingSafeEqual,
} from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import {
  UI_ATTACH_LOCAL_BRIDGE_HOST,
  UI_ATTACH_LOCAL_BRIDGE_CAPABILITIES_PATH,
  UI_ATTACH_LOCAL_BRIDGE_CONNECTION_REQUEST_PATH,
  UI_ATTACH_LOCAL_BRIDGE_READ_ACKNOWLEDGEMENT_PATH,
  UI_ATTACH_LOCAL_BRIDGE_AGENT_READ_ACKNOWLEDGEMENT_PATH,
  UI_ATTACH_LOCAL_BRIDGE_HEARTBEAT_PATH,
  UI_ATTACH_LOCAL_BRIDGE_MAX_READ_ACKNOWLEDGEMENT_BYTES,
  UI_ATTACH_LOCAL_BRIDGE_MAX_SNAPSHOT_BYTES,
  UI_ATTACH_LOCAL_BRIDGE_PAIR_PATH,
  UI_ATTACH_LOCAL_BRIDGE_PORT,
  UI_ATTACH_LOCAL_BRIDGE_SCHEMA_VERSION,
  UI_ATTACH_LOCAL_BRIDGE_SNAPSHOT_PATH,
  UI_ATTACH_LOCAL_BRIDGE_SHARED_CAPTURE_PATH,
  UI_ATTACH_LOCAL_BRIDGE_STRUCTURED_CAPTURE_CAPABILITIES_PATH,
  parseAnnotationLifecycleOperationProposal,
  createLocalBridgeApprovalProofMessage,
  isLocalBridgeConnectionRequest,
  isLocalBridgePairRequest,
  parseLocalBridgeReadAcknowledgement,
  parseLocalBridgeSnapshot,
  type LocalBridgeApprovalMode,
  type LocalBridgeConnectionRequestV1,
  type LocalBridgePairRequestV1,
  type LocalBridgeReadAcknowledgementV1,
  type LocalBridgeSnapshotV1,
} from "@meanthis/schema";
import {
  createAnnotationLifecycleControlState,
  type AnnotationLifecycleControlFailureCode,
  type AnnotationLifecycleControlRecord,
  type AnnotationLifecycleControlState,
  type AnnotationLifecycleOperationApproval,
  type AnnotationLifecycleOperationReference,
} from "./annotation-lifecycle-control-state.js";
import {
  RESPONSE_PROOF_HEADER,
  createLocalBridgeAgentBodyResponseProof,
  createLocalBridgeAgentResponseProof,
  openLocalBridgeApprovalKey,
  verifyLocalBridgeAgentBodyRequestAuth,
  verifyLocalBridgeAgentRequestAuth,
  type LocalBridgeAgentBodyRequestAuth,
  type LocalBridgeAgentRequestAuth,
} from "./local-bridge-agent-auth.js";

const PAIRING_TTL_MS = 5 * 60_000;
const PAIRING_MAX_FAILED_ATTEMPTS = 5;
const PAIRING_LOCKOUT_MS = 30_000;
const CONNECTION_REQUEST_TTL_MS = 2 * 60_000;
const CONNECTION_REQUEST_MAX_FAILED_ATTEMPTS = 5;
const MAX_CONNECTION_REQUESTS = 32;
const MAX_CONNECTION_REQUESTS_PER_ORIGIN = 8;
const MAX_BROWSER_SESSION_TRUSTS = 32;
const MAX_EXPIRED_CONNECTION_REQUESTS = 64;
const EXPIRED_CONNECTION_REQUEST_RETENTION_MS = 10 * 60_000;
const INSTANCE_STALE_AFTER_MS = 30_000;
const MAX_REQUEST_BYTES = UI_ATTACH_LOCAL_BRIDGE_MAX_SNAPSHOT_BYTES + 8_192;
const ANNOTATION_LIFECYCLE_CONTROL_MAX_REQUEST_BYTES = 16_384;

export const MEANTHIS_CHROME_WEB_STORE_EXTENSION_ID = "bbiiccaidhlhdagmabkogleldjdnmlfn";

export type LocalBridgeErrorCode =
  | "ORIGIN_DENIED"
  | "PAIRING_DENIED"
  | "CONNECTION_INVITATION_EXPIRED"
  | "AUTH_DENIED"
  | "INVALID_REQUEST"
  | "STALE_SNAPSHOT"
  | "CAPTURE_NOT_FOUND"
  | "ACKNOWLEDGEMENT_MISMATCH"
  | "INSTANCE_STALE"
  | "INSTANCE_NOT_FOUND"
  | "BRIDGE_OWNER_UNAVAILABLE";

export type LocalBridgeResult<T> =
  | { ok: true; value: T }
  | { ok: false; code: LocalBridgeErrorCode };

export type LocalBridgeAnnotationLifecycleControlFailureCode =
  | AnnotationLifecycleControlFailureCode
  | "AUTH_DENIED"
  | "INSTANCE_STALE"
  | "INSTANCE_NOT_FOUND";

export type LocalBridgeAnnotationLifecycleControlResult<T> =
  | { ok: true; value: T }
  | { ok: false; code: LocalBridgeAnnotationLifecycleControlFailureCode };

export interface LocalBridgeAnnotationLifecycleOperationView {
  record: AnnotationLifecycleControlRecord;
  reference: AnnotationLifecycleOperationReference;
}

export interface LocalBridgeAnnotationLifecycleOperationClaim
  extends LocalBridgeAnnotationLifecycleOperationView {
  approval: AnnotationLifecycleOperationApproval;
}

export interface LocalBridgeInstanceView {
  instanceId: string;
  extensionId: string;
  connectedAt: string;
  lastSeenAt: string | null;
  stale: boolean;
  snapshot: LocalBridgeSnapshotV1 | null;
}

export type LocalBridgeInstanceSummary = Omit<LocalBridgeInstanceView, "snapshot">;

export interface LocalBridgeStatusV1 {
  schemaVersion: typeof UI_ATTACH_LOCAL_BRIDGE_SCHEMA_VERSION;
  kind: "ui-attach.local-bridge-status";
  origin: string;
  pairing: {
    code: string;
    expiresAt: string;
    attemptsRemaining: number;
    lockedUntil: string | null;
  };
  instances: LocalBridgeInstanceSummary[];
}

export interface LocalBridgeConnectionRequestView {
  requestId: string;
  approvalMode: LocalBridgeApprovalMode;
  expiresAt: string;
  status: "pending" | "approved";
  instanceId?: string;
  token?: string;
  approvalProof?: string;
  sessionTrustKey?: string;
}

export interface LocalBridgeConnectionApproval {
  requestId: string;
  approvalMode: LocalBridgeApprovalMode;
  expiresAt: string;
}

interface LocalBridgeInstance extends LocalBridgeInstanceView {
  extensionOrigin: string;
  token: string;
  installationId: string | null;
  browserSessionId: string | null;
  approvalMode: LocalBridgeApprovalMode | null;
  connectionGeneration: number;
  readAcknowledgement: LocalBridgeReadAcknowledgementV1 | null;
  annotationLifecycleControl: AnnotationLifecycleControlState;
}

interface LocalBridgeConnectionRequestRecord {
  extensionId: string;
  extensionOrigin: string;
  request: LocalBridgeConnectionRequestV1;
  expiresAt: string;
  failedAttempts: number;
  status: "pending" | "approved";
  instanceId: string | null;
  token: string | null;
  approvalProofKey: string | null;
  sessionTrustKey: string | null;
  delivered: boolean;
}

interface ExpiredLocalBridgeConnectionRequestRecord {
  requestId: string;
  approvalMode: LocalBridgeApprovalMode;
  approvalVerifier: string;
  expiredAt: string;
}

export interface LocalBridgeStateOptions {
  now?: () => Date;
  randomInt?: (maximum: number) => number;
  randomBytes?: (size: number) => Uint8Array;
}

export interface LocalBridgeState {
  getStatus(): LocalBridgeStatusV1;
  authorize(extensionOrigin: string, token: string): LocalBridgeResult<null>;
  authorizeToken(token: string): LocalBridgeResult<null>;
  resolveExtensionOriginToken(token: string): LocalBridgeResult<string>;
  pair(
    extensionOrigin: string,
    request: unknown,
  ): LocalBridgeResult<{ instanceId: string; token: string }>;
  createConnectionRequest(
    extensionOrigin: string,
    request: unknown,
  ): LocalBridgeResult<LocalBridgeConnectionRequestView>;
  readConnectionRequest(
    extensionOrigin: string,
    requestId: string,
    requestSecret: string,
  ): LocalBridgeResult<LocalBridgeConnectionRequestView>;
  approveConnectionRequest(
    requestId: string,
    approvalKey: string,
  ): LocalBridgeResult<LocalBridgeConnectionApproval>;
  approveSealedConnectionRequest(
    requestId: string,
    sealedApprovalKey: string,
    agentToken: string,
    ownerIdentity: LocalBridgeOwnerIdentity,
  ): LocalBridgeResult<LocalBridgeConnectionApproval>;
  cancelConnectionRequest(
    extensionOrigin: string,
    requestId: string,
    requestSecret: string,
  ): LocalBridgeResult<null>;
  publish(
    extensionOrigin: string,
    token: string,
    snapshot: unknown,
  ): LocalBridgeResult<LocalBridgeInstanceView>;
  heartbeat(extensionOrigin: string, token: string): LocalBridgeResult<LocalBridgeInstanceView>;
  clearSharedCapture(
    extensionOrigin: string,
    token: string,
  ): LocalBridgeResult<LocalBridgeInstanceView>;
  clearSharedCaptureToken(token: string): LocalBridgeResult<LocalBridgeInstanceView>;
  readCaptureReadAcknowledgement(
    extensionOrigin: string,
    token: string,
  ): LocalBridgeResult<LocalBridgeReadAcknowledgementV1 | null>;
  acknowledgeCaptureRead(
    acknowledgement: unknown,
  ): LocalBridgeResult<LocalBridgeReadAcknowledgementV1>;
  disconnect(extensionOrigin: string, token: string): LocalBridgeResult<null>;
  disconnectToken(token: string): LocalBridgeResult<null>;
  listInstances(): LocalBridgeInstanceSummary[];
  readInstance(instanceId: string): LocalBridgeResult<LocalBridgeInstanceView>;
  submitAnnotationLifecycleOperation(
    proposal: unknown,
  ): LocalBridgeAnnotationLifecycleControlResult<LocalBridgeAnnotationLifecycleOperationView>;
  readAnnotationLifecycleOperation(
    reference: unknown,
  ): LocalBridgeAnnotationLifecycleControlResult<LocalBridgeAnnotationLifecycleOperationView>;
  readNextAnnotationLifecycleOperation(
    extensionOrigin: string,
    token: string,
  ): LocalBridgeAnnotationLifecycleControlResult<LocalBridgeAnnotationLifecycleOperationView | null>;
  readAnnotationLifecycleControlAuthority(
    extensionOrigin: string,
    token: string,
  ): LocalBridgeAnnotationLifecycleControlResult<{
    ownerGeneration: number;
    connectionGeneration: number;
  }>;
  claimAnnotationLifecycleOperation(
    extensionOrigin: string,
    token: string,
    reference: unknown,
  ): LocalBridgeAnnotationLifecycleControlResult<LocalBridgeAnnotationLifecycleOperationClaim>;
  rejectAnnotationLifecycleOperation(
    extensionOrigin: string,
    token: string,
    reference: unknown,
  ): LocalBridgeAnnotationLifecycleControlResult<LocalBridgeAnnotationLifecycleOperationView>;
  finalizeAnnotationLifecycleOperation(
    extensionOrigin: string,
    token: string,
    input: unknown,
  ): LocalBridgeAnnotationLifecycleControlResult<LocalBridgeAnnotationLifecycleOperationView>;
}

export function createLocalBridgeState(options: LocalBridgeStateOptions = {}): LocalBridgeState {
  const now = options.now ?? (() => new Date());
  const randomInt = options.randomInt ?? ((maximum) => secureRandomInt(maximum));
  const randomBytes = options.randomBytes ?? ((size) => secureRandomBytes(size));
  const instances = new Map<string, LocalBridgeInstance>();
  const connectionRequests = new Map<string, LocalBridgeConnectionRequestRecord>();
  const expiredConnectionRequests = new Map<string, ExpiredLocalBridgeConnectionRequestRecord>();
  const browserSessionTrust = new Map<string, string>();
  const operationOwners = new Map<string, string>();
  const ownerGeneration = safeGenerationFromBytes(randomBytes(6));
  let connectionGeneration = 0;
  let pairing = createPairing();
  let failedPairingAttempts = 0;
  let pairingLockedUntil: string | null = null;

  function createPairing(): { code: string; expiresAt: string } {
    const digits = String(randomInt(1_000_000)).padStart(6, "0");
    return {
      code: `${digits.slice(0, 3)}-${digits.slice(3)}`,
      expiresAt: new Date(now().getTime() + PAIRING_TTL_MS).toISOString(),
    };
  }

  function createInstanceControl(instanceId: string): {
    connectionGeneration: number;
    annotationLifecycleControl: AnnotationLifecycleControlState;
  } {
    connectionGeneration += 1;
    if (!Number.isSafeInteger(connectionGeneration) || connectionGeneration > Number.MAX_SAFE_INTEGER) {
      throw new Error("Local bridge connection generation is exhausted.");
    }
    for (const [operationId, ownerInstanceId] of operationOwners) {
      if (ownerInstanceId === instanceId) operationOwners.delete(operationId);
    }
    return {
      connectionGeneration,
      annotationLifecycleControl: createAnnotationLifecycleControlState({
        ownerGeneration,
        connectionGeneration,
        now: () => now().getTime(),
      }),
    };
  }

  function ensureCurrentPairing(): void {
    const currentTime = now().getTime();
    if (currentTime >= Date.parse(pairing.expiresAt)) {
      pairing = createPairing();
      failedPairingAttempts = 0;
      pairingLockedUntil = null;
    } else if (pairingLockedUntil && currentTime >= Date.parse(pairingLockedUntil)) {
      pairingLockedUntil = null;
    }
  }

  function toView(instance: LocalBridgeInstance): LocalBridgeInstanceView {
    const lastSeenAt = instance.lastSeenAt;
    return {
      instanceId: instance.instanceId,
      extensionId: instance.extensionId,
      connectedAt: instance.connectedAt,
      lastSeenAt,
      stale: lastSeenAt === null || now().getTime() - Date.parse(lastSeenAt) > INSTANCE_STALE_AFTER_MS,
      snapshot: instance.snapshot ? structuredClone(instance.snapshot) : null,
    };
  }

  function toSummary(instance: LocalBridgeInstance): LocalBridgeInstanceSummary {
    const view = toView(instance);
    return {
      instanceId: view.instanceId,
      extensionId: view.extensionId,
      connectedAt: view.connectedAt,
      lastSeenAt: view.lastSeenAt,
      stale: view.stale,
    };
  }

  function rejectPairingAttempt(): LocalBridgeResult<never> {
    failedPairingAttempts += 1;
    if (failedPairingAttempts >= PAIRING_MAX_FAILED_ATTEMPTS) {
      pairing = createPairing();
      failedPairingAttempts = 0;
      pairingLockedUntil = new Date(now().getTime() + PAIRING_LOCKOUT_MS).toISOString();
    }
    return { ok: false, code: "PAIRING_DENIED" };
  }

  function findAuthorized(extensionOrigin: string, token: string): LocalBridgeInstance | null {
    for (const instance of instances.values()) {
      if (instance.extensionOrigin !== extensionOrigin || !sameSecret(instance.token, token)) continue;
      return instance;
    }
    return null;
  }

  function findAuthorizedToken(token: string): LocalBridgeInstance | null {
    for (const instance of instances.values()) {
      if (sameSecret(instance.token, token)) return instance;
    }
    return null;
  }

  function isCurrentReadAcknowledgement(
    instance: LocalBridgeInstance,
    acknowledgement: LocalBridgeReadAcknowledgementV1,
  ): boolean {
    const snapshot = instance.snapshot;
    return snapshot !== null &&
      snapshot.capture !== undefined &&
      acknowledgement.instanceId === instance.instanceId &&
      acknowledgement.captureId === snapshot.capture.captureId &&
      acknowledgement.snapshotSequence === snapshot.sequence;
  }

  function trustKey(
    extensionOrigin: string,
    installationId: string,
    browserSessionId: string,
  ): string {
    return `${extensionOrigin}\0${installationId}\0${browserSessionId}`;
  }

  function cleanupConnectionRequest(record: LocalBridgeConnectionRequestRecord): void {
    if (!record.delivered && record.instanceId && record.token) {
      const instance = instances.get(record.instanceId);
      if (instance && sameSecret(instance.token, record.token)) {
        instances.delete(record.instanceId);
      }
      browserSessionTrust.delete(trustKey(
        record.extensionOrigin,
        record.request.installationId,
        record.request.browserSessionId,
      ));
    }
    connectionRequests.delete(record.request.requestId);
  }

  function revokeConnectionRequest(record: LocalBridgeConnectionRequestRecord): void {
    if (record.instanceId && record.token) {
      const instance = instances.get(record.instanceId);
      if (instance && sameSecret(instance.token, record.token)) {
        instances.delete(record.instanceId);
      }
    }
    browserSessionTrust.delete(trustKey(
      record.extensionOrigin,
      record.request.installationId,
      record.request.browserSessionId,
    ));
    connectionRequests.delete(record.request.requestId);
  }

  function disconnectInstance(instance: LocalBridgeInstance): LocalBridgeResult<null> {
    instances.delete(instance.instanceId);
    for (const [operationId, ownerInstanceId] of operationOwners) {
      if (ownerInstanceId === instance.instanceId) operationOwners.delete(operationId);
    }
    if (instance.installationId && instance.browserSessionId) {
      browserSessionTrust.delete(trustKey(
        instance.extensionOrigin,
        instance.installationId,
        instance.browserSessionId,
      ));
    }
    for (const record of connectionRequests.values()) {
      if (
        record.extensionOrigin === instance.extensionOrigin &&
        record.request.installationId === instance.installationId &&
        record.request.browserSessionId === instance.browserSessionId
      ) {
        connectionRequests.delete(record.request.requestId);
      }
    }
    return { ok: true, value: null };
  }

  function pruneExpiredConnectionRequests(): void {
    const currentTime = now().getTime();
    for (const record of connectionRequests.values()) {
      if (currentTime >= Date.parse(record.expiresAt)) {
        rememberExpiredConnectionRequest(record);
        cleanupConnectionRequest(record);
      }
    }
    for (const record of expiredConnectionRequests.values()) {
      if (currentTime - Date.parse(record.expiredAt) > EXPIRED_CONNECTION_REQUEST_RETENTION_MS) {
        expiredConnectionRequests.delete(record.requestId);
      }
    }
  }

  function rememberExpiredConnectionRequest(record: LocalBridgeConnectionRequestRecord): void {
    expiredConnectionRequests.delete(record.request.requestId);
    expiredConnectionRequests.set(record.request.requestId, {
      requestId: record.request.requestId,
      approvalMode: record.request.approvalMode,
      approvalVerifier: record.request.approvalVerifier,
      expiredAt: record.expiresAt,
    });
    while (expiredConnectionRequests.size > MAX_EXPIRED_CONNECTION_REQUESTS) {
      const oldest = expiredConnectionRequests.keys().next().value;
      if (typeof oldest !== "string") break;
      expiredConnectionRequests.delete(oldest);
    }
  }

  function approveExpiredWithKey(
    record: ExpiredLocalBridgeConnectionRequestRecord,
    approvalKey: string,
  ): LocalBridgeResult<never> {
    if (!/^[A-Za-z0-9_-]{43}$/.test(approvalKey)) {
      return { ok: false, code: "PAIRING_DENIED" };
    }
    const verifier = createHash("sha256").update(Buffer.from(approvalKey, "base64url"))
      .digest("base64url");
    return sameSecret(verifier, record.approvalVerifier)
      ? { ok: false, code: "CONNECTION_INVITATION_EXPIRED" }
      : { ok: false, code: "PAIRING_DENIED" };
  }

  function connectionRequestView(
    record: LocalBridgeConnectionRequestRecord,
    exposeToken: boolean,
  ): LocalBridgeConnectionRequestView {
    const sessionTrustKey = record.request.approvalMode === "browser_session"
      ? record.sessionTrustKey
      : null;
    const approvalProof = exposeToken && record.token && record.instanceId && record.approvalProofKey
      ? createHmac("sha256", Buffer.from(record.approvalProofKey, "base64url"))
          .update(createLocalBridgeApprovalProofMessage({
            requestId: record.request.requestId,
            approvalMode: record.request.approvalMode,
            expiresAt: record.expiresAt,
            status: "approved",
            instanceId: record.instanceId,
            token: record.token,
            sessionTrustKey,
          }), "utf8")
          .digest("base64url")
      : null;
    return {
      requestId: record.request.requestId,
      approvalMode: record.request.approvalMode,
      expiresAt: record.expiresAt,
      status: record.status,
      ...(record.instanceId ? { instanceId: record.instanceId } : {}),
      ...(exposeToken && record.token ? { token: record.token } : {}),
      ...(approvalProof ? { approvalProof } : {}),
      ...(exposeToken && sessionTrustKey ? { sessionTrustKey } : {}),
    };
  }

  function approveConnectionRecord(
    record: LocalBridgeConnectionRequestRecord,
    approvalProofKey: string,
    existingSessionTrustKey: string | null = null,
  ): void {
    if (record.status === "approved") return;
    const instanceId = deriveInstanceId(record.extensionOrigin, record.request.installationId);
    const token = Buffer.from(randomBytes(32)).toString("base64url");
    instances.set(instanceId, {
      instanceId,
      extensionId: record.extensionId,
      extensionOrigin: record.extensionOrigin,
      token,
      connectedAt: now().toISOString(),
      lastSeenAt: null,
      stale: true,
      snapshot: null,
      readAcknowledgement: null,
      installationId: record.request.installationId,
      browserSessionId: record.request.browserSessionId,
      approvalMode: record.request.approvalMode,
      ...createInstanceControl(instanceId),
    });
    record.status = "approved";
    record.instanceId = instanceId;
    record.token = token;
    record.approvalProofKey = approvalProofKey;
    if (record.request.approvalMode === "browser_session") {
      const key = trustKey(
        record.extensionOrigin,
        record.request.installationId,
        record.request.browserSessionId,
      );
      const sessionTrustKey = existingSessionTrustKey ?? Buffer.from(randomBytes(32)).toString("base64url");
      record.sessionTrustKey = sessionTrustKey;
      if (!browserSessionTrust.has(key) && browserSessionTrust.size >= MAX_BROWSER_SESSION_TRUSTS) {
        const oldest = browserSessionTrust.keys().next().value;
        if (typeof oldest === "string") browserSessionTrust.delete(oldest);
      }
      browserSessionTrust.set(key, sessionTrustKey);
    }
  }

  function rejectConnectionApproval(
    record: LocalBridgeConnectionRequestRecord,
  ): LocalBridgeResult<never> {
    record.failedAttempts += 1;
    if (record.failedAttempts >= CONNECTION_REQUEST_MAX_FAILED_ATTEMPTS) {
      revokeConnectionRequest(record);
    }
    return { ok: false, code: "PAIRING_DENIED" };
  }

  function approveWithKey(
    record: LocalBridgeConnectionRequestRecord,
    approvalKey: string,
  ): LocalBridgeResult<LocalBridgeConnectionApproval> {
    if (!/^[A-Za-z0-9_-]{43}$/.test(approvalKey)) return rejectConnectionApproval(record);
    const verifier = createHash("sha256")
      .update(Buffer.from(approvalKey, "base64url"))
      .digest("base64url");
    if (!sameSecret(record.request.approvalVerifier, verifier)) {
      return rejectConnectionApproval(record);
    }
    approveConnectionRecord(record, approvalKey);
    return {
      ok: true,
      value: {
        requestId: record.request.requestId,
        approvalMode: record.request.approvalMode,
        expiresAt: record.expiresAt,
      },
    };
  }

  function controlView(record: AnnotationLifecycleControlRecord): LocalBridgeAnnotationLifecycleOperationView {
    return {
      record: structuredClone(record),
      reference: {
        operationId: record.proposal.operationId,
        fingerprint: record.fingerprint,
        ownerGeneration: record.ownerGeneration,
        connectionGeneration: record.connectionGeneration,
      },
    };
  }

  function controlFailure<T>(
    code: LocalBridgeAnnotationLifecycleControlFailureCode,
  ): LocalBridgeAnnotationLifecycleControlResult<T> {
    return { ok: false, code };
  }

  function authorizedControlInstance(
    extensionOrigin: string,
    token: string,
  ): LocalBridgeAnnotationLifecycleControlResult<LocalBridgeInstance> {
    const instance = findAuthorized(extensionOrigin, token);
    if (!instance) return controlFailure("AUTH_DENIED");
    const view = toView(instance);
    return view.stale ? controlFailure("INSTANCE_STALE") : { ok: true, value: instance };
  }

  function lifecycleBinding(
    instance: LocalBridgeInstance,
    proposal: {
      instanceId: string;
      captureId: string;
      expectedSequence: number;
      annotationId: string;
      expectedState: "open" | "resolved";
    },
    options: { requireExpectedSequence?: boolean } = {},
  ): LocalBridgeAnnotationLifecycleControlResult<{
    ownerGeneration: number;
    connectionGeneration: number;
    instanceId: string;
    captureId: string;
    sequence: number;
    annotationId: string;
    state: "open" | "resolved";
  }> {
    if (instance.instanceId !== proposal.instanceId) return controlFailure("INSTANCE_MISMATCH");
    const snapshot = instance.snapshot;
    if (!snapshot?.capture) return controlFailure("CAPTURE_MISMATCH");
    if (snapshot.capture.captureId !== proposal.captureId) return controlFailure("CAPTURE_MISMATCH");
    if (options.requireExpectedSequence !== false &&
        snapshot.sequence !== proposal.expectedSequence) {
      return controlFailure("SEQUENCE_MISMATCH");
    }
    const targets = snapshot.capture.targets.filter(
      (target) => target.annotationId === proposal.annotationId,
    );
    if (targets.length !== 1) return controlFailure("ANNOTATION_MISMATCH");
    const state = targets[0]?.annotationLifecycle?.state;
    if (state !== proposal.expectedState) return controlFailure("STATE_MISMATCH");
    return {
      ok: true,
      value: {
        ownerGeneration,
        connectionGeneration: instance.connectionGeneration,
        instanceId: instance.instanceId,
        captureId: snapshot.capture.captureId,
        sequence: snapshot.sequence,
        annotationId: proposal.annotationId,
        state,
      },
    };
  }

  function exactResultEnvelope(value: unknown): {
    reference: unknown;
    approval: unknown;
    receipt: unknown;
  } | null {
    if (!isExactDataRecord(value, ["reference", "approval", "receipt"])) return null;
    return value as { reference: unknown; approval: unknown; receipt: unknown };
  }

  function successfulReceiptMatchesSnapshot(
    instance: LocalBridgeInstance,
    record: AnnotationLifecycleControlRecord,
    receipt: unknown,
  ): boolean {
    if (!isExactDataRecord(receipt, [
      "schemaVersion", "kind", "operationId", "fingerprint", "receiptId", "status",
      "observedAt", "resultingState", "readbackAuthority", "executionAuthority",
    ])) return false;
    if (receipt.status !== "succeeded") {
      return receipt.readbackAuthority === "current_snapshot";
    }
    if (
      receipt.readbackAuthority !== "durable_ledger" &&
      receipt.readbackAuthority !== "current_snapshot"
    ) return false;
    const snapshot = instance.snapshot;
    if (
      !snapshot?.capture ||
      snapshot.capture.captureId !== record.proposal.captureId ||
      snapshot.sequence <= record.proposal.expectedSequence
    ) return false;
    const targets = snapshot.capture.targets.filter(
      (target) => target.annotationId === record.proposal.annotationId,
    );
    return targets.length === 1 &&
      targets[0]?.annotationLifecycle?.state === record.proposal.nextState &&
      targets[0]?.annotationUpdatedAt === receipt.observedAt &&
      receipt.resultingState === record.proposal.nextState;
  }

  return {
    authorize(extensionOrigin, token) {
      return findAuthorized(extensionOrigin, token)
        ? { ok: true, value: null }
        : { ok: false, code: "AUTH_DENIED" };
    },

    authorizeToken(token) {
      return findAuthorizedToken(token)
        ? { ok: true, value: null }
        : { ok: false, code: "AUTH_DENIED" };
    },

    resolveExtensionOriginToken(token) {
      const instance = findAuthorizedToken(token);
      return instance
        ? { ok: true, value: instance.extensionOrigin }
        : { ok: false, code: "AUTH_DENIED" };
    },

    getStatus() {
      ensureCurrentPairing();
      return {
        schemaVersion: UI_ATTACH_LOCAL_BRIDGE_SCHEMA_VERSION,
        kind: "ui-attach.local-bridge-status",
        origin: `http://${UI_ATTACH_LOCAL_BRIDGE_HOST}:${UI_ATTACH_LOCAL_BRIDGE_PORT}`,
        pairing: {
          ...pairing,
          attemptsRemaining: PAIRING_MAX_FAILED_ATTEMPTS - failedPairingAttempts,
          lockedUntil: pairingLockedUntil,
        },
        instances: this.listInstances(),
      };
    },

    pair(extensionOrigin, request) {
      const extensionId = parseExtensionOrigin(extensionOrigin);
      if (!extensionId) return { ok: false, code: "ORIGIN_DENIED" };
      ensureCurrentPairing();
      if (pairingLockedUntil) return { ok: false, code: "PAIRING_DENIED" };
      if (!isLocalBridgePairRequest(request) || request.pairingCode !== pairing.code) {
        return rejectPairingAttempt();
      }

      const instanceId = deriveInstanceId(extensionOrigin, request.installationId);
      const token = Buffer.from(randomBytes(32)).toString("base64url");
      const connectedAt = now().toISOString();
      instances.set(instanceId, {
        instanceId,
        extensionId,
        extensionOrigin,
        token,
        connectedAt,
        lastSeenAt: null,
        stale: true,
        snapshot: null,
        readAcknowledgement: null,
        installationId: request.installationId,
        browserSessionId: null,
        approvalMode: null,
        ...createInstanceControl(instanceId),
      });
      pairing = createPairing();
      failedPairingAttempts = 0;
      pairingLockedUntil = null;
      return { ok: true, value: { instanceId, token } };
    },

    createConnectionRequest(extensionOrigin, request) {
      const extensionId = parseExtensionOrigin(extensionOrigin);
      if (!extensionId) return { ok: false, code: "ORIGIN_DENIED" };
      if (!isLocalBridgeConnectionRequest(request)) {
        return { ok: false, code: "INVALID_REQUEST" };
      }
      pruneExpiredConnectionRequests();
      if (connectionRequests.has(request.requestId)) {
        return { ok: false, code: "PAIRING_DENIED" };
      }
      for (const record of connectionRequests.values()) {
        if (
          record.extensionOrigin === extensionOrigin &&
          record.request.installationId === request.installationId &&
          record.request.browserSessionId === request.browserSessionId
        ) {
          cleanupConnectionRequest(record);
        }
      }
      if (connectionRequests.size >= MAX_CONNECTION_REQUESTS) {
        return { ok: false, code: "PAIRING_DENIED" };
      }
      if (
        [...connectionRequests.values()].filter(
          (record) => record.extensionOrigin === extensionOrigin,
        ).length >= MAX_CONNECTION_REQUESTS_PER_ORIGIN
      ) {
        return { ok: false, code: "PAIRING_DENIED" };
      }
      const record: LocalBridgeConnectionRequestRecord = {
        extensionId,
        extensionOrigin,
        request: structuredClone(request),
        expiresAt: new Date(now().getTime() + CONNECTION_REQUEST_TTL_MS).toISOString(),
        failedAttempts: 0,
        status: "pending",
        instanceId: null,
        token: null,
        approvalProofKey: null,
        sessionTrustKey: null,
        delivered: false,
      };
      expiredConnectionRequests.delete(request.requestId);
      connectionRequests.set(request.requestId, record);
      if (
        request.approvalMode === "browser_session" &&
        browserSessionTrust.has(trustKey(extensionOrigin, request.installationId, request.browserSessionId))
      ) {
        const sessionTrustKey = browserSessionTrust.get(trustKey(
          extensionOrigin,
          request.installationId,
          request.browserSessionId,
        ));
        if (sessionTrustKey) approveConnectionRecord(record, sessionTrustKey, sessionTrustKey);
      }
      return { ok: true, value: connectionRequestView(record, false) };
    },

    readConnectionRequest(extensionOrigin, requestId, requestSecret) {
      if (!parseExtensionOrigin(extensionOrigin)) return { ok: false, code: "ORIGIN_DENIED" };
      pruneExpiredConnectionRequests();
      const record = connectionRequests.get(requestId);
      if (!record) return { ok: false, code: "PAIRING_DENIED" };
      if (
        record.extensionOrigin !== extensionOrigin ||
        !sameSecret(record.request.requestSecret, requestSecret)
      ) {
        return { ok: false, code: "AUTH_DENIED" };
      }
      if (record.status === "approved") record.delivered = true;
      return { ok: true, value: connectionRequestView(record, true) };
    },

    approveConnectionRequest(requestId, approvalKey) {
      pruneExpiredConnectionRequests();
      const record = connectionRequests.get(requestId);
      if (!record) {
        const expired = expiredConnectionRequests.get(requestId);
        return expired
          ? approveExpiredWithKey(expired, approvalKey)
          : { ok: false, code: "PAIRING_DENIED" };
      }
      return approveWithKey(record, approvalKey);
    },

    approveSealedConnectionRequest(requestId, sealedApprovalKey, agentToken, ownerIdentity) {
      pruneExpiredConnectionRequests();
      const record = connectionRequests.get(requestId);
      if (!record) {
        const expired = expiredConnectionRequests.get(requestId);
        if (!expired) return { ok: false, code: "PAIRING_DENIED" };
        const approvalKey = openLocalBridgeApprovalKey(agentToken, {
          requestId,
          approvalMode: expired.approvalMode,
          approvalVerifier: expired.approvalVerifier,
          expectedOwnerIdentity: ownerIdentity,
        }, sealedApprovalKey);
        return approvalKey
          ? approveExpiredWithKey(expired, approvalKey)
          : { ok: false, code: "PAIRING_DENIED" };
      }
      const approvalKey = openLocalBridgeApprovalKey(agentToken, {
        requestId,
        approvalMode: record.request.approvalMode,
        approvalVerifier: record.request.approvalVerifier,
        expectedOwnerIdentity: ownerIdentity,
      }, sealedApprovalKey);
      return approvalKey ? approveWithKey(record, approvalKey) : rejectConnectionApproval(record);
    },

    cancelConnectionRequest(extensionOrigin, requestId, requestSecret) {
      if (!parseExtensionOrigin(extensionOrigin)) return { ok: false, code: "ORIGIN_DENIED" };
      pruneExpiredConnectionRequests();
      const record = connectionRequests.get(requestId);
      if (!record) return { ok: false, code: "PAIRING_DENIED" };
      if (
        record.extensionOrigin !== extensionOrigin ||
        !sameSecret(record.request.requestSecret, requestSecret)
      ) {
        return { ok: false, code: "AUTH_DENIED" };
      }
      revokeConnectionRequest(record);
      return { ok: true, value: null };
    },

    publish(extensionOrigin, token, snapshot) {
      const instance = findAuthorized(extensionOrigin, token);
      if (!instance) return { ok: false, code: "AUTH_DENIED" };
      const parsedSnapshot = parseLocalBridgeSnapshot(snapshot);
      if (!parsedSnapshot) return { ok: false, code: "INVALID_REQUEST" };
      if (instance.snapshot && parsedSnapshot.sequence <= instance.snapshot.sequence) {
        return { ok: false, code: "STALE_SNAPSHOT" };
      }
      instance.snapshot = structuredClone(parsedSnapshot);
      instance.readAcknowledgement = null;
      instance.lastSeenAt = now().toISOString();
      return { ok: true, value: toView(instance) };
    },

    heartbeat(extensionOrigin, token) {
      const instance = findAuthorized(extensionOrigin, token);
      if (!instance) return { ok: false, code: "AUTH_DENIED" };
      instance.lastSeenAt = now().toISOString();
      return { ok: true, value: toView(instance) };
    },

    clearSharedCapture(extensionOrigin, token) {
      const instance = findAuthorized(extensionOrigin, token);
      if (!instance) return { ok: false, code: "AUTH_DENIED" };
      instance.snapshot = null;
      instance.readAcknowledgement = null;
      instance.lastSeenAt = now().toISOString();
      return { ok: true, value: toView(instance) };
    },

    clearSharedCaptureToken(token) {
      const instance = findAuthorizedToken(token);
      if (!instance) return { ok: false, code: "AUTH_DENIED" };
      instance.snapshot = null;
      instance.readAcknowledgement = null;
      instance.lastSeenAt = now().toISOString();
      return { ok: true, value: toView(instance) };
    },

    readCaptureReadAcknowledgement(extensionOrigin, token) {
      const instance = findAuthorized(extensionOrigin, token);
      if (!instance) return { ok: false, code: "AUTH_DENIED" };
      const acknowledgement = instance.readAcknowledgement;
      return {
        ok: true,
        value: acknowledgement && isCurrentReadAcknowledgement(instance, acknowledgement)
          ? structuredClone(acknowledgement)
          : null,
      };
    },

    acknowledgeCaptureRead(acknowledgementInput) {
      const acknowledgement = parseLocalBridgeReadAcknowledgement(acknowledgementInput);
      if (!acknowledgement) return { ok: false, code: "INVALID_REQUEST" };
      const instance = instances.get(acknowledgement.instanceId);
      if (!instance) return { ok: false, code: "INSTANCE_NOT_FOUND" };
      if (toView(instance).stale) return { ok: false, code: "INSTANCE_STALE" };
      const snapshot = instance.snapshot;
      if (!snapshot?.capture) return { ok: false, code: "CAPTURE_NOT_FOUND" };
      if (!isCurrentReadAcknowledgement(instance, acknowledgement)) {
        return { ok: false, code: "ACKNOWLEDGEMENT_MISMATCH" };
      }
      if (
        instance.readAcknowledgement &&
        isCurrentReadAcknowledgement(instance, instance.readAcknowledgement) &&
        instance.readAcknowledgement.detail === acknowledgement.detail
      ) {
        return { ok: true, value: structuredClone(instance.readAcknowledgement) };
      }
      instance.readAcknowledgement = structuredClone(acknowledgement);
      return { ok: true, value: structuredClone(instance.readAcknowledgement) };
    },

    disconnect(extensionOrigin, token) {
      const instance = findAuthorized(extensionOrigin, token);
      if (!instance) return { ok: false, code: "AUTH_DENIED" };
      return disconnectInstance(instance);
    },

    disconnectToken(token) {
      const instance = findAuthorizedToken(token);
      if (!instance) return { ok: false, code: "AUTH_DENIED" };
      return disconnectInstance(instance);
    },

    listInstances() {
      return [...instances.values()]
        .map(toSummary)
        .sort((left, right) => left.instanceId.localeCompare(right.instanceId));
    },

    readInstance(instanceId) {
      const instance = instances.get(instanceId);
      if (!instance) return { ok: false, code: "INSTANCE_NOT_FOUND" };
      const view = toView(instance);
      return view.stale
        ? { ok: false, code: "INSTANCE_STALE" }
        : { ok: true, value: view };
    },

    submitAnnotationLifecycleOperation(proposalInput) {
      const parsed = parseAnnotationLifecycleOperationProposal(proposalInput);
      if (!parsed.ok) return controlFailure("INVALID_PROPOSAL");
      const proposal = parsed.value;
      const existingOwner = operationOwners.get(proposal.operationId);
      if (existingOwner && existingOwner !== proposal.instanceId) {
        return controlFailure("OPERATION_ID_CONFLICT");
      }
      const instance = instances.get(proposal.instanceId);
      if (!instance) return controlFailure("INSTANCE_NOT_FOUND");
      if (toView(instance).stale) return controlFailure("INSTANCE_STALE");
      if (existingOwner === instance.instanceId) {
        const replayed = instance.annotationLifecycleControl.submit(proposal, {
          ownerGeneration,
          connectionGeneration: instance.connectionGeneration,
          instanceId: proposal.instanceId,
          captureId: proposal.captureId,
          sequence: proposal.expectedSequence,
          annotationId: proposal.annotationId,
          state: proposal.expectedState,
        });
        return replayed.ok
          ? { ok: true, value: controlView(replayed.record) }
          : controlFailure(replayed.code);
      }
      const binding = lifecycleBinding(instance, proposal);
      if (!binding.ok) return binding;
      const submitted = instance.annotationLifecycleControl.submit(proposal, binding.value);
      if (!submitted.ok) return controlFailure(submitted.code);
      operationOwners.set(proposal.operationId, instance.instanceId);
      return { ok: true, value: controlView(submitted.record) };
    },

    readAnnotationLifecycleOperation(referenceInput) {
      const operationId = readOperationId(referenceInput);
      if (!operationId) return controlFailure("INVALID_REFERENCE");
      const instanceId = operationOwners.get(operationId);
      if (!instanceId) return controlFailure("NOT_FOUND");
      const instance = instances.get(instanceId);
      if (!instance) return controlFailure("INSTANCE_NOT_FOUND");
      const read = instance.annotationLifecycleControl.read(referenceInput);
      return read.ok
        ? { ok: true, value: controlView(read.record) }
        : controlFailure(read.code);
    },

    readNextAnnotationLifecycleOperation(extensionOrigin, token) {
      const authorized = authorizedControlInstance(extensionOrigin, token);
      if (!authorized.ok) return authorized;
      const record = authorized.value.annotationLifecycleControl.listActive()[0] ?? null;
      return { ok: true, value: record ? controlView(record) : null };
    },

    readAnnotationLifecycleControlAuthority(extensionOrigin, token) {
      const authorized = authorizedControlInstance(extensionOrigin, token);
      if (!authorized.ok) return authorized;
      return {
        ok: true,
        value: {
          ownerGeneration,
          connectionGeneration: authorized.value.connectionGeneration,
        },
      };
    },

    claimAnnotationLifecycleOperation(extensionOrigin, token, referenceInput) {
      const authorized = authorizedControlInstance(extensionOrigin, token);
      if (!authorized.ok) return authorized;
      const instance = authorized.value;
      const read = instance.annotationLifecycleControl.read(referenceInput);
      if (!read.ok) return controlFailure(read.code);
      const binding = lifecycleBinding(instance, read.record.proposal, {
        requireExpectedSequence: false,
      });
      if (!binding.ok) return binding;
      const approved = read.record.phase === "awaiting_user"
        ? instance.annotationLifecycleControl.approveCurrent(referenceInput)
        : read;
      if (!approved.ok) return controlFailure(approved.code);
      if (!approved.record.approvedAt) return controlFailure("APPROVAL_MISMATCH");
      const approval = {
        approvedAt: approved.record.approvedAt,
        expiresAt: approved.record.expiresAt,
      };
      const executing = instance.annotationLifecycleControl.markExecuting(referenceInput, approval);
      if (!executing.ok) return controlFailure(executing.code);
      return {
        ok: true,
        value: { ...controlView(executing.record), approval: structuredClone(approval) },
      };
    },

    rejectAnnotationLifecycleOperation(extensionOrigin, token, referenceInput) {
      const authorized = authorizedControlInstance(extensionOrigin, token);
      if (!authorized.ok) return authorized;
      const instance = authorized.value;
      const read = instance.annotationLifecycleControl.read(referenceInput);
      if (!read.ok) return controlFailure(read.code);
      // Rejection is a non-mutation terminal transition. The exact reference
      // already binds owner and connection generations, so navigation/clear
      // may cancel a delivered proposal even after the live snapshot moved.
      const rejected = instance.annotationLifecycleControl.rejectCurrent(referenceInput);
      return rejected.ok
        ? { ok: true, value: controlView(rejected.record) }
        : controlFailure(rejected.code);
    },

    finalizeAnnotationLifecycleOperation(extensionOrigin, token, input) {
      const authorized = authorizedControlInstance(extensionOrigin, token);
      if (!authorized.ok) return authorized;
      const envelope = exactResultEnvelope(input);
      if (!envelope) return controlFailure("INVALID_RECEIPT");
      const instance = authorized.value;
      const read = instance.annotationLifecycleControl.read(envelope.reference);
      if (!read.ok) return controlFailure(read.code);
      if (!successfulReceiptMatchesSnapshot(instance, read.record, envelope.receipt)) {
        return controlFailure("RECEIPT_MISMATCH");
      }
      const finalized = instance.annotationLifecycleControl.finalize(
        envelope.reference,
        envelope.approval,
        envelope.receipt,
      );
      return finalized.ok
        ? { ok: true, value: controlView(finalized.record) }
        : controlFailure(finalized.code);
    },
  };
}

function safeGenerationFromBytes(bytes: Uint8Array): number {
  if (!(bytes instanceof Uint8Array) || bytes.byteLength !== 6) {
    throw new Error("Invalid local bridge owner generation entropy.");
  }
  let value = 0;
  for (const byte of bytes) value = value * 256 + byte;
  return value + 1;
}

function isExactDataRecord(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  try {
    if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) return false;
    const descriptors = Object.getOwnPropertyDescriptors(value);
    const ownKeys = Reflect.ownKeys(descriptors);
    if (
      ownKeys.length !== keys.length ||
      ownKeys.some((key) => typeof key !== "string" || !keys.includes(key))
    ) return false;
    return keys.every((key) => {
      const descriptor = descriptors[key];
      return Boolean(
        descriptor?.enumerable &&
        Object.hasOwn(descriptor, "value") &&
        descriptor.value !== undefined
      );
    });
  } catch {
    return false;
  }
}

function readOperationId(value: unknown): string | null {
  if (!isExactDataRecord(value, [
    "operationId", "fingerprint", "ownerGeneration", "connectionGeneration",
  ])) return null;
  const operationId = value.operationId;
  return typeof operationId === "string" ? operationId : null;
}

function parseExtensionOrigin(value: string): string | null {
  const match = /^chrome-extension:\/\/([a-p]{32})$/.exec(value);
  return match?.[1] === MEANTHIS_CHROME_WEB_STORE_EXTENSION_ID ? match[1] : null;
}

function deriveInstanceId(extensionOrigin: string, installationId: string): string {
  return `instance-${createHash("sha256")
    .update(`${extensionOrigin}\0${installationId}`, "utf8")
    .digest("hex")
    .slice(0, 12)}`;
}

function sameSecret(expected: string, received: string): boolean {
  const left = Buffer.from(expected);
  const right = Buffer.from(received);
  return left.length === right.length && timingSafeEqual(left, right);
}

export interface LocalBridgeHttpServer {
  origin: string;
  close(): Promise<void>;
}

export interface LocalBridgeOwnerIdentity {
  executablePath: string;
  entryPath: string;
  buildHash: string;
}

export interface LocalBridgeHttpServerOptions {
  port?: number;
  agentToken?: string;
  ownerIdentity?: LocalBridgeOwnerIdentity;
  onActivity?: () => void;
  onRequestStart?: () => void;
  onRequestEnd?: () => void;
  isClosing?: () => boolean;
  enableAnnotationLifecycleControl?: boolean;
}

export async function startLocalBridgeHttpServer(
  state: LocalBridgeState,
  options: LocalBridgeHttpServerOptions = {},
): Promise<LocalBridgeHttpServer> {
  if (options.agentToken !== undefined && !/^[A-Za-z0-9_-]{43}$/.test(options.agentToken)) {
    throw new Error("Invalid local bridge agent token.");
  }
  if (options.agentToken !== undefined && !isLocalBridgeOwnerIdentity(options.ownerIdentity)) {
    throw new Error("Invalid local bridge owner identity.");
  }
  let listeningPort = options.port ?? UI_ATTACH_LOCAL_BRIDGE_PORT;
  const agentNonces = new Map<string, number>();
  const server = createServer((request, response) => {
    if (options.isClosing?.()) {
      writeJson(response, 503, { error: "Bridge owner is closing." });
      return;
    }
    options.onRequestStart?.();
    void handleRequest(
      state,
      request,
      response,
      listeningPort,
      options.agentToken ?? null,
      options.ownerIdentity ?? null,
      agentNonces,
      options.onActivity,
      options.enableAnnotationLifecycleControl === true,
    ).finally(() => options.onRequestEnd?.());
  });
  server.maxHeadersCount = 32;
  server.headersTimeout = 5_000;
  server.requestTimeout = 5_000;

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(listeningPort, UI_ATTACH_LOCAL_BRIDGE_HOST, () => {
      server.off("error", reject);
      const address = server.address();
      if (!address || typeof address === "string") {
        reject(new Error("Local bridge address unavailable."));
        return;
      }
      listeningPort = address.port;
      resolve();
    });
  });

  return {
    origin: `http://${UI_ATTACH_LOCAL_BRIDGE_HOST}:${listeningPort}`,
    close: () => new Promise<void>((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
    }),
  };
}

async function handleRequest(
  state: LocalBridgeState,
  request: IncomingMessage,
  response: ServerResponse,
  port: number,
  agentToken: string | null,
  ownerIdentity: LocalBridgeOwnerIdentity | null,
  agentNonces: Map<string, number>,
  onActivity: (() => void) | undefined,
  enableAnnotationLifecycleControl: boolean,
): Promise<void> {
  const host = request.headers.host;
  if (host !== `${UI_ATTACH_LOCAL_BRIDGE_HOST}:${port}`) {
    writeJson(response, 403, { error: "Request denied." });
    return;
  }
  const origin = typeof request.headers.origin === "string" ? request.headers.origin : "";
  const extensionOrigin = parseExtensionOrigin(origin) ? origin : null;
  if (request.method === "OPTIONS") {
    if (!extensionOrigin) {
      writeJson(response, 403, { error: "Request denied." });
      return;
    }
    setCors(response, extensionOrigin);
    response.setHeader("access-control-allow-methods", "GET, POST, PUT, DELETE, OPTIONS");
    response.setHeader("access-control-allow-headers", "authorization, content-type");
    response.writeHead(204).end();
    return;
  }
  if (request.method === "GET" && request.url === "/health") {
    writeJson(response, 200, {
      schemaVersion: UI_ATTACH_LOCAL_BRIDGE_SCHEMA_VERSION,
      kind: "ui-attach.local-bridge-health",
      ok: true,
      ...(agentToken ? { sharing: "owner-proxy-v1" } : {}),
    });
    return;
  }
  const annotationLifecycleAgentRoute = request.url?.startsWith(
    "/v1/agent/annotation-lifecycle/",
  ) === true;
  if (annotationLifecycleAgentRoute && !enableAnnotationLifecycleControl) {
    writeJson(response, 404, { error: "Not found." });
    return;
  }
  if (request.url?.startsWith("/v1/agent/")) {
    await handleAgentRequest(
      state,
      request,
      response,
      port,
      agentToken,
      ownerIdentity,
      agentNonces,
      onActivity,
      enableAnnotationLifecycleControl,
    );
    return;
  }
  if (
    request.method === "GET" &&
    (
      request.url === UI_ATTACH_LOCAL_BRIDGE_CAPABILITIES_PATH ||
      request.url === UI_ATTACH_LOCAL_BRIDGE_STRUCTURED_CAPTURE_CAPABILITIES_PATH
    )
  ) {
    if (origin && !extensionOrigin) {
      writeJson(response, 403, { error: "Request denied." });
      return;
    }
    const token = readBearerToken(request);
    const authorized = token
      ? extensionOrigin
        ? state.authorize(extensionOrigin, token)
        : state.authorizeToken(token)
      : { ok: false as const, code: "AUTH_DENIED" as const };
    if (!authorized.ok) {
      writeJson(response, 401, { error: "Authentication denied." });
      return;
    }
    if (extensionOrigin) setCors(response, extensionOrigin);
    writeJson(response, 200, request.url === UI_ATTACH_LOCAL_BRIDGE_CAPABILITIES_PATH
      ? {
          schemaVersion: UI_ATTACH_LOCAL_BRIDGE_SCHEMA_VERSION,
          kind: "ui-attach.local-bridge-capabilities",
          snapshotObservations: "v1",
        }
      : {
          schemaVersion: UI_ATTACH_LOCAL_BRIDGE_SCHEMA_VERSION,
          kind: "ui-attach.local-bridge-structured-capture-capabilities",
          structuredCapture: "v3",
        });
    return;
  }
  if (
    request.method === "GET" &&
    request.url === UI_ATTACH_LOCAL_BRIDGE_READ_ACKNOWLEDGEMENT_PATH
  ) {
    if (origin && !extensionOrigin) {
      writeJson(response, 403, { error: "Request denied." });
      return;
    }
    const token = readBearerToken(request);
    const resolvedOrigin = token
      ? extensionOrigin
        ? { ok: true as const, value: extensionOrigin }
        : state.resolveExtensionOriginToken(token)
      : { ok: false as const, code: "AUTH_DENIED" as const };
    const result = token && resolvedOrigin.ok
      ? state.readCaptureReadAcknowledgement(resolvedOrigin.value, token)
      : { ok: false as const, code: "AUTH_DENIED" as const };
    if (!result.ok) {
      writeJson(response, 401, { error: "Authentication denied." });
      return;
    }
    if (extensionOrigin) setCors(response, extensionOrigin);
    writeJson(response, 200, result.value);
    return;
  }
  if (
    !origin &&
    request.method === "DELETE" &&
    request.url === UI_ATTACH_LOCAL_BRIDGE_SHARED_CAPTURE_PATH
  ) {
    const token = readBearerToken(request);
    const result = token
      ? state.clearSharedCaptureToken(token)
      : { ok: false as const, code: "AUTH_DENIED" as const };
    if (!result.ok) {
      writeJson(response, 401, { error: "Authentication denied." });
      return;
    }
    onActivity?.();
    response.writeHead(204).end();
    return;
  }
  if (
    !origin &&
    request.method === "DELETE" &&
    request.url === UI_ATTACH_LOCAL_BRIDGE_SNAPSHOT_PATH
  ) {
    const token = readBearerToken(request);
    const result = token
      ? state.disconnectToken(token)
      : { ok: false as const, code: "AUTH_DENIED" as const };
    if (!result.ok) {
      writeJson(response, 401, { error: "Authentication denied." });
      return;
    }
    onActivity?.();
    response.writeHead(204).end();
    return;
  }
  const annotationLifecycleExtensionRoute = request.url ===
      "/v1/annotation-lifecycle/proposals" ||
    request.url === "/v1/annotation-lifecycle/authority" ||
    /^\/v1\/annotation-lifecycle\/proposals\/[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\/(claim|reject|result)$/iu.test(
      request.url ?? "",
    );
  if (enableAnnotationLifecycleControl && annotationLifecycleExtensionRoute) {
    if (origin && !extensionOrigin) {
      writeJson(response, 403, { error: "Request denied." });
      return;
    }
    const token = readBearerToken(request);
    const resolvedOrigin = extensionOrigin ?? (
      token ? state.resolveExtensionOriginToken(token) : { ok: false as const, code: "AUTH_DENIED" as const }
    );
    const authorizedOrigin = typeof resolvedOrigin === "string"
      ? resolvedOrigin
      : resolvedOrigin.ok ? resolvedOrigin.value : null;
    if (!authorizedOrigin) {
      writeJson(response, 401, { error: "Authentication denied." });
      return;
    }
    if (extensionOrigin) setCors(response, extensionOrigin);
    const handled = await handleExtensionAnnotationLifecycleControlRequest(
      state,
      request,
      response,
      authorizedOrigin,
      onActivity,
    );
    if (!handled) writeJson(response, 404, { error: "Not found." });
    return;
  }
  if (!extensionOrigin) {
    writeJson(response, 403, { error: "Request denied." });
    return;
  }
  setCors(response, extensionOrigin);

  if (request.method === "POST" && request.url === UI_ATTACH_LOCAL_BRIDGE_HEARTBEAT_PATH) {
    const token = readBearerToken(request);
    const result = token
      ? state.heartbeat(extensionOrigin, token)
      : { ok: false as const, code: "AUTH_DENIED" as const };
    if (!result.ok) {
      writeJson(response, 401, { error: "Authentication denied." });
      return;
    }
    onActivity?.();
    response.writeHead(204).end();
    return;
  }

  if (request.method === "DELETE" && request.url === UI_ATTACH_LOCAL_BRIDGE_SHARED_CAPTURE_PATH) {
    const token = readBearerToken(request);
    const result = token
      ? state.clearSharedCapture(extensionOrigin, token)
      : { ok: false as const, code: "AUTH_DENIED" as const };
    if (!result.ok) {
      writeJson(response, 401, { error: "Authentication denied." });
      return;
    }
    onActivity?.();
    response.writeHead(204).end();
    return;
  }

  if (request.method === "POST" && request.url === UI_ATTACH_LOCAL_BRIDGE_CONNECTION_REQUEST_PATH) {
    const body = await readJsonBody(request);
    if (!body.ok) {
      writeJson(response, 400, { error: "Invalid request." });
      return;
    }
    const result = state.createConnectionRequest(extensionOrigin, body.value);
    if (!result.ok) {
      const status = result.code === "ORIGIN_DENIED" ? 403
        : result.code === "INVALID_REQUEST" ? 400
        : 401;
      writeJson(response, status, { error: "Connection request denied." });
      return;
    }
    writeJson(response, 201, {
      schemaVersion: UI_ATTACH_LOCAL_BRIDGE_SCHEMA_VERSION,
      kind: "ui-attach.local-bridge-connection-requested",
      ok: true,
      data: result.value,
    });
    return;
  }

  const connectionRequestMatch = /^\/v1\/connection-requests\/([0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})$/i.exec(
    request.url ?? "",
  );
  if (
    connectionRequestMatch &&
    (request.method === "GET" || request.method === "POST" || request.method === "DELETE")
  ) {
    const requestSecret = readBearerToken(request);
    if (!requestSecret) {
      writeJson(response, 401, { error: "Authentication denied." });
      return;
    }
    if (request.method === "DELETE") {
      const result = state.cancelConnectionRequest(
        extensionOrigin,
        connectionRequestMatch[1],
        requestSecret,
      );
      if (!result.ok) {
        writeJson(response, result.code === "ORIGIN_DENIED" ? 403 : 401, {
          error: "Connection request denied.",
        });
        return;
      }
      response.writeHead(204).end();
      return;
    }
    if (request.method === "POST") {
      const body = await readJsonBody(request);
      if (
        !body.ok ||
        typeof body.value !== "object" ||
        body.value === null ||
        Array.isArray(body.value) ||
        Object.keys(body.value).length !== 0
      ) {
        writeJson(response, 400, { error: "Invalid request." });
        return;
      }
    }
    const result = state.readConnectionRequest(
      extensionOrigin,
      connectionRequestMatch[1],
      requestSecret,
    );
    if (!result.ok) {
      writeJson(response, result.code === "ORIGIN_DENIED" ? 403 : 401, {
        error: "Connection request denied.",
      });
      return;
    }
    if (result.value.status === "approved") onActivity?.();
    writeJson(response, 200, {
      schemaVersion: UI_ATTACH_LOCAL_BRIDGE_SCHEMA_VERSION,
      kind: "ui-attach.local-bridge-connection-request",
      ok: true,
      data: result.value,
    });
    return;
  }

  if (request.method === "POST" && request.url === UI_ATTACH_LOCAL_BRIDGE_PAIR_PATH) {
    const body = await readJsonBody(request);
    if (!body.ok) {
      writeJson(response, 400, { error: "Invalid request." });
      return;
    }
    const result = state.pair(extensionOrigin, body.value);
    if (!result.ok) {
      writeJson(response, result.code === "ORIGIN_DENIED" ? 403 : 401, { error: "Pairing denied." });
      return;
    }
    onActivity?.();
    writeJson(response, 200, {
      schemaVersion: UI_ATTACH_LOCAL_BRIDGE_SCHEMA_VERSION,
      kind: "ui-attach.local-bridge-paired",
      instanceId: result.value.instanceId,
      token: result.value.token,
    });
    return;
  }

  if (request.url === UI_ATTACH_LOCAL_BRIDGE_SNAPSHOT_PATH) {
    const token = readBearerToken(request);
    if (!token) {
      writeJson(response, 401, { error: "Authentication denied." });
      return;
    }
    if (request.method === "DELETE") {
      const result = state.disconnect(extensionOrigin, token);
      if (!result.ok) {
        writeJson(response, 401, { error: "Authentication denied." });
        return;
      }
      onActivity?.();
      response.writeHead(204).end();
      return;
    }
    if (request.method === "PUT") {
      const body = await readJsonBody(request);
      if (!body.ok) {
        writeJson(response, 400, { error: "Invalid request." });
        return;
      }
      const result = state.publish(extensionOrigin, token, body.value);
      if (!result.ok) {
        const status = result.code === "AUTH_DENIED"
          ? 401
          : result.code === "STALE_SNAPSHOT"
            ? 409
            : 400;
        writeJson(response, status, { error: "Snapshot rejected." });
        return;
      }
      onActivity?.();
      response.writeHead(204).end();
      return;
    }
  }
  writeJson(response, 404, { error: "Not found." });
}

async function handleExtensionAnnotationLifecycleControlRequest(
  state: LocalBridgeState,
  request: IncomingMessage,
  response: ServerResponse,
  extensionOrigin: string,
  onActivity: (() => void) | undefined,
): Promise<boolean> {
  if (
    request.method === "GET" &&
    request.url === "/v1/annotation-lifecycle/authority"
  ) {
    const token = readBearerToken(request);
    const result = token
      ? state.readAnnotationLifecycleControlAuthority(extensionOrigin, token)
      : { ok: false as const, code: "AUTH_DENIED" as const };
    if (!result.ok) {
      writeJson(response, controlHttpStatus(result.code), controlError(null, result.code));
      return true;
    }
    writeJson(response, 200, {
      schemaVersion: UI_ATTACH_LOCAL_BRIDGE_SCHEMA_VERSION,
      kind: "ui-attach.annotation-lifecycle-control-authority",
      ok: true,
      data: result.value,
    });
    return true;
  }
  if (
    request.method === "GET" &&
    request.url === "/v1/annotation-lifecycle/proposals"
  ) {
    const token = readBearerToken(request);
    const result = token
      ? state.readNextAnnotationLifecycleOperation(extensionOrigin, token)
      : { ok: false as const, code: "AUTH_DENIED" as const };
    if (!result.ok) {
      writeJson(response, controlHttpStatus(result.code), controlError(null, result.code));
      return true;
    }
    writeJson(response, 200, {
      schemaVersion: UI_ATTACH_LOCAL_BRIDGE_SCHEMA_VERSION,
      kind: "ui-attach.annotation-lifecycle-operation-delivery",
      ok: true,
      data: result.value,
    });
    return true;
  }
  const match = /^\/v1\/annotation-lifecycle\/proposals\/([0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})\/(claim|reject|result)$/i.exec(
    request.url ?? "",
  );
  if (request.method !== "POST" || !match) return false;
  const token = readBearerToken(request);
  if (!token) {
    writeJson(response, 401, controlError(null, "AUTH_DENIED"));
    return true;
  }
  const body = await readRawJsonBody(request, ANNOTATION_LIFECYCLE_CONTROL_MAX_REQUEST_BYTES);
  if (!body.ok) {
    writeJson(response, 400, controlError(null, "INVALID_REFERENCE"));
    return true;
  }
  const operationId = match[1]!;
  const action = match[2]!;
  const referencedOperationId = action === "result"
    ? isExactDataRecord(body.value, ["reference", "approval", "receipt"])
      ? readOperationId(body.value.reference)
      : null
    : readOperationId(body.value);
  if (referencedOperationId !== operationId) {
    writeJson(response, 400, controlError(null, "INVALID_REFERENCE"));
    return true;
  }
  const result = action === "claim"
    ? state.claimAnnotationLifecycleOperation(extensionOrigin, token, body.value)
    : action === "reject"
      ? state.rejectAnnotationLifecycleOperation(extensionOrigin, token, body.value)
      : state.finalizeAnnotationLifecycleOperation(extensionOrigin, token, body.value);
  if (!result.ok) {
    writeJson(response, controlHttpStatus(result.code), controlError(null, result.code));
    return true;
  }
  onActivity?.();
  writeJson(response, 200, {
    schemaVersion: UI_ATTACH_LOCAL_BRIDGE_SCHEMA_VERSION,
    kind: action === "claim"
      ? "ui-attach.annotation-lifecycle-operation-claimed"
      : action === "reject"
        ? "ui-attach.annotation-lifecycle-operation-rejected"
        : "ui-attach.annotation-lifecycle-operation-finalized",
    ok: true,
    data: result.value,
  });
  return true;
}

async function handleAgentRequest(
  state: LocalBridgeState,
  request: IncomingMessage,
  response: ServerResponse,
  port: number,
  agentToken: string | null,
  ownerIdentity: LocalBridgeOwnerIdentity | null,
  agentNonces: Map<string, number>,
  onActivity: (() => void) | undefined,
  enableAnnotationLifecycleControl: boolean,
): Promise<void> {
  if (
    request.method === "POST" &&
    request.url === UI_ATTACH_LOCAL_BRIDGE_AGENT_READ_ACKNOWLEDGEMENT_PATH
  ) {
    const raw = await readRawJsonBody(request, UI_ATTACH_LOCAL_BRIDGE_MAX_READ_ACKNOWLEDGEMENT_BYTES);
    const requestAuth = raw.ok && agentToken
      ? verifyLocalBridgeAgentBodyRequestAuth(
          agentToken,
          request.method,
          request.url,
          raw.bytes,
          request.headers,
          agentNonces,
        )
      : null;
    if (!agentToken || !ownerIdentity || !raw.ok || !requestAuth) {
      writeJson(response, raw.ok ? 401 : 400, {
        error: raw.ok ? "Authentication denied." : "Invalid request.",
      });
      return;
    }
    const result = state.acknowledgeCaptureRead(raw.value);
    if (!result.ok) {
      const status = result.code === "AUTH_DENIED"
        ? 401
        : result.code === "INSTANCE_NOT_FOUND" || result.code === "CAPTURE_NOT_FOUND"
          ? 404
          : result.code === "INSTANCE_STALE" ||
              result.code === "STALE_SNAPSHOT" ||
              result.code === "ACKNOWLEDGEMENT_MISMATCH"
            ? 409
            : 400;
      writeAgentBodyJson(response, status, {
        schemaVersion: UI_ATTACH_LOCAL_BRIDGE_SCHEMA_VERSION,
        kind: "ui-attach.local-bridge-error",
        ok: false,
        ownerIdentity,
        error: { code: result.code, message: "Capture read acknowledgement was rejected." },
      }, agentToken, requestAuth);
      return;
    }
    onActivity?.();
    writeAgentBodyJson(response, 200, result.value, agentToken, requestAuth);
    return;
  }
  if (enableAnnotationLifecycleControl && request.method === "POST" && (
    request.url === "/v1/agent/annotation-lifecycle/proposals" ||
    request.url === "/v1/agent/annotation-lifecycle/proposals/status"
  )) {
    const raw = await readRawJsonBody(request, ANNOTATION_LIFECYCLE_CONTROL_MAX_REQUEST_BYTES);
    const requestAuth = raw.ok && agentToken
      ? verifyLocalBridgeAgentBodyRequestAuth(
          agentToken,
          request.method,
          request.url,
          raw.bytes,
          request.headers,
          agentNonces,
        )
      : null;
    if (!agentToken || !ownerIdentity || !raw.ok || !requestAuth) {
      writeJson(response, raw.ok ? 401 : 400, {
        error: raw.ok ? "Authentication denied." : "Invalid request.",
      });
      return;
    }
    const result = request.url.endsWith("/status")
      ? state.readAnnotationLifecycleOperation(raw.value)
      : state.submitAnnotationLifecycleOperation(raw.value);
    if (!result.ok) {
      writeAgentBodyJson(
        response,
        controlHttpStatus(result.code),
        controlError(ownerIdentity, result.code),
        agentToken,
        requestAuth,
      );
      return;
    }
    onActivity?.();
    writeAgentBodyJson(response, request.url.endsWith("/status") ? 200 : 201, {
      schemaVersion: UI_ATTACH_LOCAL_BRIDGE_SCHEMA_VERSION,
      kind: request.url.endsWith("/status")
        ? "ui-attach.annotation-lifecycle-operation-read"
        : "ui-attach.annotation-lifecycle-operation-submitted",
      ok: true,
      ownerIdentity,
      data: result.value,
    }, agentToken, requestAuth);
    return;
  }
  const requestAuth = agentToken
    ? verifyLocalBridgeAgentRequestAuth(
        agentToken,
        request.method ?? "",
        request.url ?? "",
        request.headers,
        agentNonces,
      )
    : null;
  if (!agentToken || !ownerIdentity || !requestAuth) {
    writeJson(response, 401, { error: "Authentication denied." });
    return;
  }
  onActivity?.();
  if (request.method === "GET" && request.url === "/v1/agent/status") {
    writeAgentJson(response, 200, {
      ...state.getStatus(),
      origin: `http://${UI_ATTACH_LOCAL_BRIDGE_HOST}:${port}`,
      ownerIdentity,
    }, agentToken, requestAuth);
    return;
  }
  if (request.method === "GET" && request.url === "/v1/agent/instances") {
    writeAgentJson(response, 200, {
      schemaVersion: UI_ATTACH_LOCAL_BRIDGE_SCHEMA_VERSION,
      kind: "ui-attach.local-bridge-instance-list",
      ownerIdentity,
      instances: state.listInstances(),
    }, agentToken, requestAuth);
    return;
  }
  const approvalMatch = /^\/v1\/agent\/connection-requests\/([0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})\/([A-Za-z0-9_-]{80})\/approve$/i.exec(
    request.url ?? "",
  );
  if (request.method === "POST" && approvalMatch) {
    const result = state.approveSealedConnectionRequest(
      approvalMatch[1],
      approvalMatch[2],
      agentToken,
      ownerIdentity,
    );
    if (!result.ok) {
      const invitationExpired = result.code === "CONNECTION_INVITATION_EXPIRED";
      writeAgentJson(response, invitationExpired ? 410 : 401, {
        schemaVersion: UI_ATTACH_LOCAL_BRIDGE_SCHEMA_VERSION,
        kind: "ui-attach.local-bridge-error",
        ok: false,
        ownerIdentity,
        error: {
          code: invitationExpired ? "CONNECTION_INVITATION_EXPIRED" : "PAIRING_DENIED",
          message: invitationExpired
            ? "Connection invitation expired. Create a new invitation."
            : "Connection request was not approved.",
        },
      }, agentToken, requestAuth);
      return;
    }
    writeAgentJson(response, 200, {
      schemaVersion: UI_ATTACH_LOCAL_BRIDGE_SCHEMA_VERSION,
      kind: "ui-attach.local-bridge-connection-approved",
      ok: true,
      ownerIdentity,
      data: result.value,
    }, agentToken, requestAuth);
    return;
  }
  const match = request.method === "GET"
    ? /^\/v1\/agent\/instances\/(instance-[0-9a-f]{12})$/.exec(request.url ?? "")
    : null;
  if (!match) {
    writeAgentJson(response, 404, { error: "Not found." }, agentToken, requestAuth);
    return;
  }
  const result = state.readInstance(match[1]);
  if (!result.ok) {
    writeAgentJson(response, result.code === "INSTANCE_STALE" ? 409 : 404, {
      schemaVersion: UI_ATTACH_LOCAL_BRIDGE_SCHEMA_VERSION,
      kind: "ui-attach.local-bridge-error",
      ok: false,
      ownerIdentity,
      error: { code: result.code, message: "Page instance is not available." },
    }, agentToken, requestAuth);
    return;
  }
  writeAgentJson(response, 200, {
    schemaVersion: UI_ATTACH_LOCAL_BRIDGE_SCHEMA_VERSION,
    kind: "ui-attach.local-bridge-instance",
    ok: true,
    ownerIdentity,
    data: result.value,
  }, agentToken, requestAuth);
}

function isLocalBridgeOwnerIdentity(value: unknown): value is LocalBridgeOwnerIdentity {
  return Boolean(
    value &&
    typeof value === "object" &&
    typeof (value as LocalBridgeOwnerIdentity).executablePath === "string" &&
    (value as LocalBridgeOwnerIdentity).executablePath.length > 0 &&
    typeof (value as LocalBridgeOwnerIdentity).entryPath === "string" &&
    (value as LocalBridgeOwnerIdentity).entryPath.length > 0 &&
    typeof (value as LocalBridgeOwnerIdentity).buildHash === "string" &&
    /^[0-9a-f]{64}$/.test((value as LocalBridgeOwnerIdentity).buildHash)
  );
}

function controlHttpStatus(code: LocalBridgeAnnotationLifecycleControlFailureCode): number {
  if (code === "AUTH_DENIED") return 401;
  if (code === "NOT_FOUND" || code === "INSTANCE_NOT_FOUND") return 404;
  if (code === "EXPIRED") return 410;
  if (
    code.endsWith("_MISMATCH") ||
    code === "OPERATION_ID_CONFLICT" ||
    code === "TERMINAL_CONFLICT" ||
    code === "INVALID_TRANSITION" ||
    code === "INSTANCE_STALE"
  ) return 409;
  return 400;
}

function controlError(
  ownerIdentity: LocalBridgeOwnerIdentity | null,
  code: LocalBridgeAnnotationLifecycleControlFailureCode,
): Record<string, unknown> {
  return {
    schemaVersion: UI_ATTACH_LOCAL_BRIDGE_SCHEMA_VERSION,
    kind: "ui-attach.local-bridge-error",
    ok: false,
    ...(ownerIdentity ? { ownerIdentity } : {}),
    error: { code, message: "Annotation lifecycle operation was rejected." },
  };
}

type RawJsonBodyResult =
  | { ok: true; bytes: Buffer; value: unknown }
  | { ok: false };

async function readRawJsonBody(
  request: IncomingMessage,
  maxBytes: number,
): Promise<RawJsonBodyResult> {
  if (!request.headers["content-type"]?.toLowerCase().startsWith("application/json")) {
    return { ok: false };
  }
  const declared = request.headers["content-length"];
  if (
    typeof declared === "string" &&
    (!/^\d+$/.test(declared) || Number(declared) > maxBytes)
  ) return { ok: false };
  const chunks: Buffer[] = [];
  let size = 0;
  try {
    for await (const chunk of request) {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      size += bytes.length;
      if (size === 0 || size > maxBytes) return { ok: false };
      chunks.push(bytes);
    }
    const bytes = Buffer.concat(chunks);
    if (bytes.byteLength === 0) return { ok: false };
    return { ok: true, bytes, value: JSON.parse(bytes.toString("utf8")) as unknown };
  } catch {
    return { ok: false };
  }
}

async function readJsonBody(request: IncomingMessage): Promise<LocalBridgeResult<unknown>> {
  if (!request.headers["content-type"]?.toLowerCase().startsWith("application/json")) {
    return { ok: false, code: "INVALID_REQUEST" };
  }
  const chunks: Buffer[] = [];
  let size = 0;
  try {
    for await (const chunk of request) {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      size += bytes.length;
      if (size > MAX_REQUEST_BYTES) return { ok: false, code: "INVALID_REQUEST" };
      chunks.push(bytes);
    }
    return { ok: true, value: JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown };
  } catch {
    return { ok: false, code: "INVALID_REQUEST" };
  }
}

function readBearerToken(request: IncomingMessage): string | null {
  const authorization = request.headers.authorization;
  const match = typeof authorization === "string" ? /^Bearer ([A-Za-z0-9_-]{43})$/.exec(authorization) : null;
  return match?.[1] ?? null;
}

function setCors(response: ServerResponse, extensionOrigin: string): void {
  response.setHeader("access-control-allow-origin", extensionOrigin);
  response.setHeader("vary", "Origin");
}

function writeJson(response: ServerResponse, status: number, value: unknown): void {
  response.setHeader("content-type", "application/json; charset=utf-8");
  response.setHeader("cache-control", "no-store");
  response.writeHead(status).end(`${JSON.stringify(value)}\n`);
}

function writeAgentJson(
  response: ServerResponse,
  status: number,
  value: unknown,
  agentToken: string,
  requestAuth: LocalBridgeAgentRequestAuth,
): void {
  const body = `${JSON.stringify(value)}\n`;
  response.setHeader("content-type", "application/json; charset=utf-8");
  response.setHeader("cache-control", "no-store");
  response.setHeader(
    RESPONSE_PROOF_HEADER,
    createLocalBridgeAgentResponseProof(agentToken, requestAuth, status, body),
  );
  response.writeHead(status).end(body);
}

function writeAgentBodyJson(
  response: ServerResponse,
  status: number,
  value: unknown,
  agentToken: string,
  requestAuth: LocalBridgeAgentBodyRequestAuth,
): void {
  const body = Buffer.from(`${JSON.stringify(value)}\n`, "utf8");
  response.setHeader("content-type", "application/json; charset=utf-8");
  response.setHeader("cache-control", "no-store");
  response.setHeader(
    RESPONSE_PROOF_HEADER,
    createLocalBridgeAgentBodyResponseProof(agentToken, requestAuth, status, body),
  );
  response.writeHead(status).end(body);
}

export type { LocalBridgeConnectionRequestV1, LocalBridgePairRequestV1 };
