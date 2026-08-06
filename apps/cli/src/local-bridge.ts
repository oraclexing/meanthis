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
  UI_ATTACH_LOCAL_BRIDGE_MAX_SNAPSHOT_BYTES,
  UI_ATTACH_LOCAL_BRIDGE_PAIR_PATH,
  UI_ATTACH_LOCAL_BRIDGE_PORT,
  UI_ATTACH_LOCAL_BRIDGE_SCHEMA_VERSION,
  UI_ATTACH_LOCAL_BRIDGE_SNAPSHOT_PATH,
  UI_ATTACH_LOCAL_BRIDGE_STRUCTURED_CAPTURE_CAPABILITIES_PATH,
  createLocalBridgeApprovalProofMessage,
  isLocalBridgeConnectionRequest,
  isLocalBridgePairRequest,
  isLocalBridgeSnapshot,
  type LocalBridgeApprovalMode,
  type LocalBridgeConnectionRequestV1,
  type LocalBridgePairRequestV1,
  type LocalBridgeSnapshotV1,
} from "@meanthis/schema";
import {
  RESPONSE_PROOF_HEADER,
  createLocalBridgeAgentResponseProof,
  openLocalBridgeApprovalKey,
  verifyLocalBridgeAgentRequestAuth,
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
const INSTANCE_STALE_AFTER_MS = 30_000;
const MAX_REQUEST_BYTES = UI_ATTACH_LOCAL_BRIDGE_MAX_SNAPSHOT_BYTES + 8_192;

export const MEANTHIS_CHROME_WEB_STORE_EXTENSION_ID = "bbiiccaidhlhdagmabkogleldjdnmlfn";

export type LocalBridgeErrorCode =
  | "ORIGIN_DENIED"
  | "PAIRING_DENIED"
  | "AUTH_DENIED"
  | "INVALID_REQUEST"
  | "STALE_SNAPSHOT"
  | "INSTANCE_STALE"
  | "INSTANCE_NOT_FOUND"
  | "BRIDGE_OWNER_UNAVAILABLE";

export type LocalBridgeResult<T> =
  | { ok: true; value: T }
  | { ok: false; code: LocalBridgeErrorCode };

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

export interface LocalBridgeStateOptions {
  now?: () => Date;
  randomInt?: (maximum: number) => number;
  randomBytes?: (size: number) => Uint8Array;
}

export interface LocalBridgeState {
  getStatus(): LocalBridgeStatusV1;
  authorize(extensionOrigin: string, token: string): LocalBridgeResult<null>;
  authorizeToken(token: string): LocalBridgeResult<null>;
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
  disconnect(extensionOrigin: string, token: string): LocalBridgeResult<null>;
  disconnectToken(token: string): LocalBridgeResult<null>;
  listInstances(): LocalBridgeInstanceSummary[];
  readInstance(instanceId: string): LocalBridgeResult<LocalBridgeInstanceView>;
}

export function createLocalBridgeState(options: LocalBridgeStateOptions = {}): LocalBridgeState {
  const now = options.now ?? (() => new Date());
  const randomInt = options.randomInt ?? ((maximum) => secureRandomInt(maximum));
  const randomBytes = options.randomBytes ?? ((size) => secureRandomBytes(size));
  const instances = new Map<string, LocalBridgeInstance>();
  const connectionRequests = new Map<string, LocalBridgeConnectionRequestRecord>();
  const browserSessionTrust = new Map<string, string>();
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
      if (currentTime > Date.parse(record.expiresAt)) cleanupConnectionRequest(record);
    }
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
      installationId: record.request.installationId,
      browserSessionId: record.request.browserSessionId,
      approvalMode: record.request.approvalMode,
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
        installationId: request.installationId,
        browserSessionId: null,
        approvalMode: null,
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
      if (!record) return { ok: false, code: "PAIRING_DENIED" };
      return approveWithKey(record, approvalKey);
    },

    approveSealedConnectionRequest(requestId, sealedApprovalKey, agentToken, ownerIdentity) {
      pruneExpiredConnectionRequests();
      const record = connectionRequests.get(requestId);
      if (!record) return { ok: false, code: "PAIRING_DENIED" };
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
      if (!isLocalBridgeSnapshot(snapshot)) return { ok: false, code: "INVALID_REQUEST" };
      if (instance.snapshot && snapshot.sequence <= instance.snapshot.sequence) {
        return { ok: false, code: "STALE_SNAPSHOT" };
      }
      instance.snapshot = structuredClone(snapshot);
      instance.lastSeenAt = now().toISOString();
      return { ok: true, value: toView(instance) };
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
  };
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
  if (request.url?.startsWith("/v1/agent/")) {
    handleAgentRequest(
      state,
      request,
      response,
      port,
      agentToken,
      ownerIdentity,
      agentNonces,
      onActivity,
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
          structuredCapture: "v1",
        });
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
  if (!extensionOrigin) {
    writeJson(response, 403, { error: "Request denied." });
    return;
  }
  setCors(response, extensionOrigin);

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

function handleAgentRequest(
  state: LocalBridgeState,
  request: IncomingMessage,
  response: ServerResponse,
  port: number,
  agentToken: string | null,
  ownerIdentity: LocalBridgeOwnerIdentity | null,
  agentNonces: Map<string, number>,
  onActivity: (() => void) | undefined,
): void {
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
      writeAgentJson(response, 401, {
        schemaVersion: UI_ATTACH_LOCAL_BRIDGE_SCHEMA_VERSION,
        kind: "ui-attach.local-bridge-error",
        ok: false,
        ownerIdentity,
        error: {
          code: "PAIRING_DENIED",
          message: "Connection request was not approved.",
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

export type { LocalBridgeConnectionRequestV1, LocalBridgePairRequestV1 };
