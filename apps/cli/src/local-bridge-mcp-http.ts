import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import {
  CancelledNotificationSchema,
  ErrorCode,
  isInitializeRequest,
  isJSONRPCErrorResponse,
  isJSONRPCRequest,
  isJSONRPCResultResponse,
} from "@modelcontextprotocol/sdk/types.js";
import {
  createHash,
  randomUUID,
  timingSafeEqual,
} from "node:crypto";
import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import type { Socket } from "node:net";
import { loadOrCreateLocalBridgeAgentToken } from "./local-bridge-agent-token.js";
import {
  MEANTHIS_MCP_HTTP_CONTROL_HEADER,
  MEANTHIS_MCP_HTTP_CONTROL_VALUE,
  isLocalBridgeMcpHttpControlMessage,
} from "./local-bridge-mcp-http-control.js";
import {
  MEANTHIS_MCP_HTTP_DEFAULT_PORT,
  MEANTHIS_MCP_HTTP_HEALTH_KIND,
  MEANTHIS_MCP_HTTP_HEALTH_NONCE_HEADER,
  MEANTHIS_MCP_HTTP_HEALTH_PROOF_HEADER,
  MEANTHIS_MCP_HTTP_HEALTH_PROOF_MAX_CLOCK_SKEW_MS,
  MEANTHIS_MCP_HTTP_HEALTH_TIMESTAMP_HEADER,
  MEANTHIS_MCP_HTTP_HOST,
  MEANTHIS_MCP_HTTP_PATH,
  LocalBridgeMcpHttpBearerTokenError,
  createLocalBridgeMcpHttpHealthProofResponse,
  verifyLocalBridgeMcpHttpHealthProofRequest,
  type LocalBridgeMcpHttpHealthProofRequest,
} from "./local-bridge-mcp-http-health-proof.js";
import {
  MEANTHIS_MCP_HTTP_KEY_KIND,
  MEANTHIS_MCP_HTTP_TOKEN_ENV,
  validateLocalBridgeMcpHttpToken,
} from "./local-bridge-mcp-http-token.js";
import {
  ensureLocalBridgeOwner,
  loadLocalBridgeOwnerIdentity,
  spawnDetachedLocalBridgeOwner,
  waitForLocalBridgeOwner,
} from "./local-bridge-owner.js";
import {
  createHttpLocalBridgeReader,
  createLocalBridgeMcpServer,
  type LocalBridgeReader,
} from "./local-bridge-mcp.js";
import { UI_ATTACH_LOCAL_BRIDGE_ORIGIN } from "@meanthis/schema";

export {
  MEANTHIS_MCP_HTTP_DEFAULT_PORT,
  MEANTHIS_MCP_HTTP_HEALTH_KIND,
  MEANTHIS_MCP_HTTP_HEALTH_NONCE_HEADER,
  MEANTHIS_MCP_HTTP_HEALTH_PROOF_HEADER,
  MEANTHIS_MCP_HTTP_HEALTH_PROOF_MAX_CLOCK_SKEW_MS,
  MEANTHIS_MCP_HTTP_HEALTH_RESPONSE_NONCE_HEADER,
  MEANTHIS_MCP_HTTP_HEALTH_RESPONSE_PROOF_HEADER,
  MEANTHIS_MCP_HTTP_HEALTH_RESPONSE_TIMESTAMP_HEADER,
  MEANTHIS_MCP_HTTP_HEALTH_TIMESTAMP_HEADER,
  MEANTHIS_MCP_HTTP_HOST,
  MEANTHIS_MCP_HTTP_PATH,
  LocalBridgeMcpHttpBearerTokenError,
  createLocalBridgeMcpHttpHealthProofRequest,
  createLocalBridgeMcpHttpHealthProofResponse,
  isLocalBridgeMcpHttpVerifiedOwnerHealth,
  verifyLocalBridgeMcpHttpHealthProofRequest,
  verifyLocalBridgeMcpHttpHealthProofResponse,
  type LocalBridgeMcpHttpHealthProofRequest,
  type LocalBridgeMcpHttpHealthProofResponse,
  type LocalBridgeMcpHttpVerifiedOwnerHealth,
} from "./local-bridge-mcp-http-health-proof.js";
export const MEANTHIS_MCP_HTTP_DEFAULT_MAX_SESSIONS = 64;
export const MEANTHIS_MCP_HTTP_DEFAULT_MAX_IN_FLIGHT_REQUESTS = 64;
export const MEANTHIS_MCP_HTTP_DEFAULT_MAX_CONTROL_IN_FLIGHT_REQUESTS = 64;
export const MEANTHIS_MCP_HTTP_DEFAULT_MAX_REQUESTS_PER_SESSION = 8;
export const MEANTHIS_MCP_HTTP_DEFAULT_MAX_CONTROL_REQUESTS_PER_SESSION = 8;
export const MEANTHIS_MCP_HTTP_DEFAULT_MAX_SSE_CONNECTIONS_PER_SESSION = 2;
export const MEANTHIS_MCP_HTTP_DEFAULT_MAX_SOCKETS = 256;

const MAX_MCP_REQUEST_BYTES = 1_048_576;
const MAX_CONFIGURED_MCP_HTTP_SESSIONS = 4_096;
const MAX_CONFIGURED_MCP_HTTP_RESOURCE_LIMIT = 4_096;
const MCP_RESOURCE_CAPACITY_BODY = `${JSON.stringify({
  jsonrpc: "2.0",
  error: { code: -32003, message: "Server busy." },
  id: null,
})}\n`;
const HEALTH_PROOF_MAX_REPLAY_NONCES = 1_024;
export const MEANTHIS_MCP_HTTP_SESSION_DISCONNECT_GRACE_MS = 30_000;
export const MEANTHIS_MCP_HTTP_SESSION_IDLE_TTL_MS = 30 * 60_000;
const MAX_SESSION_LIFETIME_MS = 24 * 60 * 60_000;
let processStartCount = 0;

export type LocalBridgeMcpHttpArgs =
  | { ok: true; port: number }
  | { ok: false; code: "INVALID_ARGUMENTS"; message: string };

export interface LocalBridgeMcpHttpServerOptions {
  bearerToken: string;
  maxControlInFlightRequests?: number;
  maxControlRequestsPerSession?: number;
  maxInFlightRequests?: number;
  maxRequestsPerSession?: number;
  maxSessions?: number;
  maxSockets?: number;
  maxSseConnectionsPerSession?: number;
  ownerIdentity?: { buildHash: string };
  port?: number;
  sessionDisconnectGraceMs?: number;
  sessionIdleTtlMs?: number;
}

export interface LocalBridgeMcpHttpHealth {
  schemaVersion: "0.1.0";
  kind: typeof MEANTHIS_MCP_HTTP_HEALTH_KIND;
  ok: true;
  transport: "streamable-http";
  endpoint: typeof MEANTHIS_MCP_HTTP_PATH;
  pid: number;
  startCount: number;
  startedAt: string;
  activeSessions: number;
  retainedSessions: number;
  maxSessions: number;
  ownerIdentity: { buildHash: string } | null;
}

export interface LocalBridgeMcpHttpServer {
  origin: string;
  url: string;
  port: number;
  pid: number;
  startCount: number;
  close(): Promise<void>;
}

interface McpSession {
  /** Transport lifecycle only; tool, bridge, and caller state remain outside this record. */
  server: McpServer;
  transport: IdempotentStreamableHTTPServerTransport;
  sessionId?: string;
  lastActivityAt: number;
  disconnectedAt?: number;
  activeRequests: number;
  activeControlRequests: number;
  hasSeenSse: boolean;
  requestResponses: Map<string | number, McpRequestResponse>;
  pendingCancellationIntents: Set<string>;
  nextRequestGeneration: number;
  sseResponses: Set<ServerResponse>;
  disconnectTimer?: NodeJS.Timeout;
  idleTimer?: NodeJS.Timeout;
  cleanupPromise?: Promise<void>;
}

interface McpRequestResponse {
  requestId: string | number;
  response: ServerResponse;
  generation: number;
  cancellationSettling: boolean;
  pendingCancellationIntent: boolean;
  cancellationReady: Promise<void>;
  markCancellationReady(): void;
}

class IdempotentStreamableHTTPServerTransport extends StreamableHTTPServerTransport {
  #closePromise: Promise<void> | undefined;
  onTerminalResponse?: (requestId: string | number) => void;

  override async send(
    message: Parameters<StreamableHTTPServerTransport["send"]>[0],
    options?: Parameters<StreamableHTTPServerTransport["send"]>[1],
  ): Promise<void> {
    await super.send(message, options);
    if (isJSONRPCResultResponse(message) || isJSONRPCErrorResponse(message)) {
      const requestId = message.id;
      if (typeof requestId === "string" || typeof requestId === "number") {
        this.onTerminalResponse?.(requestId);
      }
    }
  }

  override close(): Promise<void> {
    this.#closePromise ??= super.close();
    return this.#closePromise;
  }
}

export class LocalBridgeMcpHttpPortInUseError extends Error {
  readonly code = "EADDRINUSE";

  constructor(readonly port: number) {
    super(`MeanThis MCP HTTP port ${port} is already in use.`);
    this.name = "LocalBridgeMcpHttpPortInUseError";
  }
}

export function parseLocalBridgeMcpHttpArgs(args: readonly string[]): LocalBridgeMcpHttpArgs {
  if (args.length === 0) return { ok: true, port: MEANTHIS_MCP_HTTP_DEFAULT_PORT };
  if (args.length !== 2 || args[0] !== "--port" || !/^\d{1,5}$/.test(args[1] ?? "")) {
    return invalidMcpHttpArgs();
  }
  const port = Number(args[1]);
  if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) return invalidMcpHttpArgs();
  return { ok: true, port };
}

export function renderLocalBridgeMcpHttpHelp(): string {
  return [
    "MeanThis shared Streamable HTTP MCP server",
    "",
    "Usage:",
    "  meanthis mcp-http [--port <1-65535>]",
    "",
    `Defaults to http://${MEANTHIS_MCP_HTTP_HOST}:${MEANTHIS_MCP_HTTP_DEFAULT_PORT}${MEANTHIS_MCP_HTTP_PATH}.`,
    `The listener always binds ${MEANTHIS_MCP_HTTP_HOST}; remote bind addresses are not supported.`,
    `An independent 32-byte base64url ${MEANTHIS_MCP_HTTP_KEY_KIND} bearer token is required in ${MEANTHIS_MCP_HTTP_TOKEN_ENV}.`,
    `At most ${MEANTHIS_MCP_HTTP_DEFAULT_MAX_SESSIONS} initializing or active sessions are retained by default.`,
    `Disconnected SSE sessions get ${MEANTHIS_MCP_HTTP_SESSION_DISCONNECT_GRACE_MS / 1_000} seconds to reconnect; sessions without SSE expire after ${MEANTHIS_MCP_HTTP_SESSION_IDLE_TTL_MS / 60_000} idle minutes.`,
    "",
  ].join("\n");
}

export async function startLocalBridgeMcpHttpServer(
  reader: LocalBridgeReader,
  options: LocalBridgeMcpHttpServerOptions,
): Promise<LocalBridgeMcpHttpServer> {
  const bearerToken = requireMcpHttpBearerToken(options.bearerToken);
  const bearerTokenDigest = createHash("sha256").update(bearerToken, "utf8").digest();
  const ownerIdentity = validateMcpHttpOwnerIdentity(options.ownerIdentity);
  const requestedPort = options.port ?? MEANTHIS_MCP_HTTP_DEFAULT_PORT;
  if (!Number.isSafeInteger(requestedPort) || requestedPort < 0 || requestedPort > 65_535) {
    throw new Error("Invalid MeanThis MCP HTTP port.");
  }
  const maxSessions = validateMaxSessions(
    options.maxSessions ?? MEANTHIS_MCP_HTTP_DEFAULT_MAX_SESSIONS,
  );
  const maxInFlightRequests = validateResourceLimit(
    "in-flight requests",
    options.maxInFlightRequests ?? MEANTHIS_MCP_HTTP_DEFAULT_MAX_IN_FLIGHT_REQUESTS,
  );
  const maxControlInFlightRequests = validateResourceLimit(
    "control in-flight requests",
    options.maxControlInFlightRequests ??
      MEANTHIS_MCP_HTTP_DEFAULT_MAX_CONTROL_IN_FLIGHT_REQUESTS,
  );
  const maxRequestsPerSession = validateResourceLimit(
    "requests per session",
    options.maxRequestsPerSession ?? MEANTHIS_MCP_HTTP_DEFAULT_MAX_REQUESTS_PER_SESSION,
  );
  const maxControlRequestsPerSession = validateResourceLimit(
    "control requests per session",
    options.maxControlRequestsPerSession ??
      MEANTHIS_MCP_HTTP_DEFAULT_MAX_CONTROL_REQUESTS_PER_SESSION,
  );
  const maxSseConnectionsPerSession = validateResourceLimit(
    "SSE connections per session",
    options.maxSseConnectionsPerSession ??
      MEANTHIS_MCP_HTTP_DEFAULT_MAX_SSE_CONNECTIONS_PER_SESSION,
  );
  const maxSockets = validateResourceLimit(
    "sockets",
    options.maxSockets ?? MEANTHIS_MCP_HTTP_DEFAULT_MAX_SOCKETS,
  );
  const sessionDisconnectGraceMs = validateSessionLifetime(
    "disconnect grace",
    options.sessionDisconnectGraceMs ?? MEANTHIS_MCP_HTTP_SESSION_DISCONNECT_GRACE_MS,
  );
  const sessionIdleTtlMs = validateSessionLifetime(
    "idle TTL",
    options.sessionIdleTtlMs ?? MEANTHIS_MCP_HTTP_SESSION_IDLE_TTL_MS,
  );
  if (sessionIdleTtlMs < sessionDisconnectGraceMs) {
    throw new Error("MeanThis MCP HTTP session idle TTL must not be shorter than disconnect grace.");
  }

  const sessions = new Map<string, McpSession>();
  const sessionResources = new Set<McpSession>();
  const sockets = new Set<Socket>();
  const rejectedSockets = new WeakSet<Socket>();
  const healthProofNonces = new Map<string, number>();
  let inFlightMcpRequests = 0;
  let inFlightMcpControlRequests = 0;
  let initializingSessions = 0;
  let listeningPort = requestedPort;
  let startCount = 0;
  let startedAt = "";
  let closing = false;
  let closePromise: Promise<void> | undefined;

  const httpServer = createServer((request, response) => {
    if (rejectedSockets.has(request.socket)) return;
    response.setHeader("cache-control", "no-store");
    void handleRequest(request, response).catch(() => {
      if (!response.headersSent) {
        writeJsonRpcError(response, 500, -32603, "Internal server error.");
      } else if (!response.writableEnded) {
        response.end();
      }
    });
  });
  // Keep one bounded overflow connection available for a generic HTTP rejection.
  httpServer.maxConnections = maxSockets + 1;
  httpServer.maxHeadersCount = 32;
  httpServer.headersTimeout = 5_000;
  httpServer.requestTimeout = 30_000;
  httpServer.keepAliveTimeout = 5_000;
  httpServer.on("connection", (socket) => {
    if (sockets.size >= maxSockets) {
      rejectedSockets.add(socket);
      closeSocketWithCapacityError(socket);
      return;
    }
    sockets.add(socket);
    let released = false;
    socket.once("close", () => {
      if (released) return;
      released = true;
      sockets.delete(socket);
    });
  });
  httpServer.on("clientError", (_error, socket) => {
    if (socket.writable) socket.end("HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n");
  });

  await new Promise<void>((resolve, reject) => {
    const onError = (error: NodeJS.ErrnoException) => {
      httpServer.off("listening", onListening);
      if (error.code === "EADDRINUSE" && requestedPort !== 0) {
        reject(new LocalBridgeMcpHttpPortInUseError(requestedPort));
        return;
      }
      reject(error);
    };
    const onListening = () => {
      httpServer.off("error", onError);
      const address = httpServer.address();
      if (!address || typeof address === "string") {
        reject(new Error("MeanThis MCP HTTP address unavailable."));
        return;
      }
      listeningPort = address.port;
      startCount = ++processStartCount;
      startedAt = new Date().toISOString();
      resolve();
    };
    httpServer.once("error", onError);
    httpServer.once("listening", onListening);
    httpServer.listen(requestedPort, MEANTHIS_MCP_HTTP_HOST);
  });

  const origin = `http://${MEANTHIS_MCP_HTTP_HOST}:${listeningPort}`;

  // Transport-only abandoned-session lifecycle; it carries no tool or bridge state.
  function cleanupSession(session: McpSession): Promise<void> {
    if (session.cleanupPromise) return session.cleanupPromise;
    let resolveCleanup!: () => void;
    session.cleanupPromise = new Promise<void>((resolve) => {
      resolveCleanup = resolve;
    });
    if (session.sessionId && sessions.get(session.sessionId) === session) {
      sessions.delete(session.sessionId);
    }
    clearSessionTimers(session);
    for (const requestResponse of session.requestResponses.values()) {
      requestResponse.markCancellationReady();
    }
    session.requestResponses.clear();
    session.pendingCancellationIntents.clear();
    const sseResponses = [...session.sseResponses];
    session.sseResponses.clear();
    for (const response of sseResponses) {
      if (!response.writableEnded && !response.destroyed) response.end();
      if (!response.destroyed) response.destroy();
    }
    void (async () => {
      try {
        await session.server.close().catch(() => undefined);
        await session.transport.close().catch(() => undefined);
      } finally {
        // Keep closing resources charged against capacity until both close paths settle.
        sessionResources.delete(session);
        resolveCleanup();
      }
    })();
    return session.cleanupPromise;
  }

  function clearSessionTimers(session: McpSession): void {
    if (session.disconnectTimer) clearTimeout(session.disconnectTimer);
    if (session.idleTimer) clearTimeout(session.idleTimer);
    session.disconnectTimer = undefined;
    session.idleTimer = undefined;
  }

  function scheduleIdleCleanup(session: McpSession): void {
    if (session.cleanupPromise) return;
    if (session.idleTimer) clearTimeout(session.idleTimer);
    const remainingMs = Math.max(
      1,
      sessionIdleTtlMs - (Date.now() - session.lastActivityAt),
    );
    session.idleTimer = setTimeout(() => {
      session.idleTimer = undefined;
      if (session.cleanupPromise) return;
      if (
        session.activeRequests > 0 ||
        session.activeControlRequests > 0 ||
        session.sseResponses.size > 0
      ) {
        session.lastActivityAt = Date.now();
        scheduleIdleCleanup(session);
        return;
      }
      if (Date.now() - session.lastActivityAt < sessionIdleTtlMs) {
        scheduleIdleCleanup(session);
        return;
      }
      void cleanupSession(session);
    }, remainingMs);
    session.idleTimer.unref();
  }

  function scheduleDisconnectCleanup(session: McpSession): void {
    if (
      session.cleanupPromise ||
      !session.hasSeenSse ||
      session.sseResponses.size > 0 ||
      session.disconnectedAt === undefined
    ) {
      if (session.disconnectTimer) clearTimeout(session.disconnectTimer);
      session.disconnectTimer = undefined;
      return;
    }
    if (session.disconnectTimer) clearTimeout(session.disconnectTimer);
    const remainingMs = Math.max(
      1,
      sessionDisconnectGraceMs - (Date.now() - session.disconnectedAt),
    );
    session.disconnectTimer = setTimeout(() => {
      session.disconnectTimer = undefined;
      if (session.cleanupPromise || session.sseResponses.size > 0) return;
      if (session.activeRequests > 0 || session.activeControlRequests > 0) {
        session.disconnectedAt = Date.now();
        scheduleDisconnectCleanup(session);
        return;
      }
      if (
        session.disconnectedAt !== undefined &&
        Date.now() - session.disconnectedAt < sessionDisconnectGraceMs
      ) {
        scheduleDisconnectCleanup(session);
        return;
      }
      void cleanupSession(session);
    }, remainingMs);
    session.disconnectTimer.unref();
  }

  function noteSessionActivity(session: McpSession, sseAttempt = false): void {
    if (session.cleanupPromise) return;
    const now = Date.now();
    session.lastActivityAt = now;
    scheduleIdleCleanup(session);
    if (sseAttempt || session.sseResponses.size > 0) {
      session.disconnectedAt = undefined;
      scheduleDisconnectCleanup(session);
      return;
    }
    if (session.hasSeenSse) {
      session.disconnectedAt = now;
      scheduleDisconnectCleanup(session);
    }
  }

  function reserveInFlightMcpRequest(control: boolean): (() => void) | null {
    const current = control ? inFlightMcpControlRequests : inFlightMcpRequests;
    const maximum = control ? maxControlInFlightRequests : maxInFlightRequests;
    if (current >= maximum) return null;
    if (control) inFlightMcpControlRequests += 1;
    else inFlightMcpRequests += 1;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      if (control) {
        inFlightMcpControlRequests = Math.max(0, inFlightMcpControlRequests - 1);
      } else {
        inFlightMcpRequests = Math.max(0, inFlightMcpRequests - 1);
      }
    };
  }

  function reserveInitializingSession(): (() => void) | null {
    if (sessionResources.size + initializingSessions >= maxSessions) return null;
    initializingSessions += 1;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      initializingSessions = Math.max(0, initializingSessions - 1);
    };
  }

  function beginSessionRequest(
    session: McpSession,
    request: IncomingMessage,
    response: ServerResponse,
    control: boolean,
  ): (() => void) | null {
    if (control) {
      if (session.activeControlRequests >= maxControlRequestsPerSession) return null;
      session.activeControlRequests += 1;
      noteSessionActivity(session);
      let released = false;
      return () => {
        if (released) return;
        released = true;
        session.activeControlRequests = Math.max(0, session.activeControlRequests - 1);
        noteSessionActivity(session);
      };
    }
    if (
      session.activeRequests >= maxRequestsPerSession ||
      (request.method === "GET" &&
        session.sseResponses.size >= maxSseConnectionsPerSession)
    ) return null;
    session.activeRequests += 1;
    if (request.method !== "GET") {
      noteSessionActivity(session);
    } else {
      session.sseResponses.add(response);
      noteSessionActivity(session, true);
      let settled = false;
      const settleSseResponse = () => {
        if (settled) return;
        settled = true;
        response.off("finish", settleSseResponse);
        response.off("close", settleSseResponse);
        session.sseResponses.delete(response);
        const contentType = response.getHeader("content-type");
        if (typeof contentType === "string" && contentType.includes("text/event-stream")) {
          session.hasSeenSse = true;
        }
        if (
          !session.cleanupPromise &&
          session.hasSeenSse &&
          session.sseResponses.size === 0
        ) {
          const now = Date.now();
          session.lastActivityAt = now;
          session.disconnectedAt = now;
          scheduleIdleCleanup(session);
          scheduleDisconnectCleanup(session);
        }
      };
      response.once("finish", settleSseResponse);
      response.once("close", settleSseResponse);
    }
    let ended = false;
    return () => {
      if (ended) return;
      ended = true;
      session.activeRequests = Math.max(0, session.activeRequests - 1);
      noteSessionActivity(session);
    };
  }

  function trackSessionRequestResponses(
    session: McpSession,
    response: ServerResponse,
    body: unknown,
  ): McpRequestResponse[] | null {
    const messages = Array.isArray(body) ? body : [body];
    const requestIds = messages.filter(isJSONRPCRequest).map((message) => message.id);
    if (requestIds.length === 0) return [];
    const uniqueRequestIds = new Set<string | number>();
    for (const requestId of requestIds) {
      if (uniqueRequestIds.has(requestId) || session.requestResponses.has(requestId)) {
        return null;
      }
      uniqueRequestIds.add(requestId);
    }
    const requestResponses: McpRequestResponse[] = [];
    for (const requestId of requestIds) {
      let markCancellationReady!: () => void;
      const cancellationReady = new Promise<void>((resolve) => {
        markCancellationReady = resolve;
      });
      session.nextRequestGeneration += 1;
      const requestResponse: McpRequestResponse = {
        requestId,
        response,
        generation: session.nextRequestGeneration,
        cancellationSettling: false,
        pendingCancellationIntent: session.pendingCancellationIntents.delete(
          mcpRequestIdDigest(requestId),
        ),
        cancellationReady,
        markCancellationReady,
      };
      session.requestResponses.set(requestId, requestResponse);
      requestResponses.push(requestResponse);
    }
    let settled = false;
    const settleResponse = () => {
      if (settled) return;
      settled = true;
      response.off("finish", settleResponse);
      response.off("close", settleResponse);
      for (const requestResponse of requestResponses) {
        if (session.requestResponses.get(requestResponse.requestId) === requestResponse) {
          requestResponse.markCancellationReady();
          session.requestResponses.delete(requestResponse.requestId);
        }
      }
    };
    response.once("finish", settleResponse);
    response.once("close", settleResponse);
    return requestResponses;
  }

  function markSessionRequestResponsesCancellationReady(
    session: McpSession,
    requestResponses: readonly McpRequestResponse[],
  ): void {
    for (const requestResponse of requestResponses) {
      if (session.requestResponses.get(requestResponse.requestId) === requestResponse) {
        requestResponse.markCancellationReady();
      }
    }
  }

  function reservePendingCancellationIntent(
    session: McpSession,
    requestId: string | number,
  ): boolean {
    const digest = mcpRequestIdDigest(requestId);
    if (session.pendingCancellationIntents.has(digest)) return true;
    if (session.pendingCancellationIntents.size >= maxControlRequestsPerSession) return false;
    session.pendingCancellationIntents.add(digest);
    return true;
  }

  async function replayPendingSessionCancellations(
    session: McpSession,
    requestResponses: readonly McpRequestResponse[],
  ): Promise<void> {
    for (const requestResponse of requestResponses) {
      if (
        !requestResponse.pendingCancellationIntent ||
        session.requestResponses.get(requestResponse.requestId) !== requestResponse
      ) continue;
      requestResponse.pendingCancellationIntent = false;
      const onmessage = session.transport.onmessage;
      if (!onmessage) throw new Error("MCP session transport is not connected.");
      onmessage({
        jsonrpc: "2.0",
        method: "notifications/cancelled",
        params: {
          requestId: requestResponse.requestId,
          reason: "Request cancelled before HTTP admission.",
        },
      });
      // Protocol notification handlers start in a microtask. Let cancellation abort
      // nested request work (and emit its related cancellation) before the outer SSE
      // terminal below closes the request-scoped stream.
      await Promise.resolve();
      await completeCancelledSessionRequest(
        session,
        requestResponse.requestId,
        requestResponse,
      );
    }
  }

  async function completeCancelledSessionRequest(
    session: McpSession,
    requestId: string | number,
    expectedRequestResponse: McpRequestResponse,
  ): Promise<void> {
    if (session.cleanupPromise) return;
    const requestResponse = session.requestResponses.get(requestId);
    if (
      requestResponse !== expectedRequestResponse ||
      requestResponse.cancellationSettling
    ) return;
    requestResponse.cancellationSettling = true;
    try {
      await session.transport.send({
        jsonrpc: "2.0",
        id: requestId,
        error: {
          code: ErrorCode.RequestTimeout,
          message: "Request cancelled.",
        },
      });
    } catch {
      const activeRequestResponse = session.requestResponses.get(requestId);
      if (
        activeRequestResponse === requestResponse &&
        activeRequestResponse.generation === requestResponse.generation
      ) {
        if (requestResponse.response.writableEnded || requestResponse.response.destroyed) {
          session.requestResponses.delete(requestId);
        } else {
          await cleanupSession(session);
        }
      }
    }
  }

  async function handleRequest(request: IncomingMessage, response: ServerResponse): Promise<void> {
    if (!isAllowedLoopbackRequest(request, listeningPort)) {
      writeJson(response, 403, { error: "Request denied." });
      return;
    }
    const requestUrl = new URL(request.url ?? "/", origin);
    if (requestUrl.origin !== origin || requestUrl.pathname + requestUrl.search !== request.url) {
      writeJson(response, 400, { error: "Invalid request target." });
      return;
    }
    if (request.method === "GET" && requestUrl.pathname === "/health" && !requestUrl.search) {
      if (!hasStrictEmptyRequestFraming(request)) {
        writeHealthProofFramingError(response);
        return;
      }
      const requestProof = verifyHealthProofRequest(
        request,
        listeningPort,
        bearerToken,
        healthProofNonces,
      );
      if (!requestProof) {
        writeHealthProofUnauthorized(response);
        return;
      }
      if (closing) {
        writeJson(response, 503, { error: "MeanThis MCP HTTP server is closing." });
        return;
      }
      const health: LocalBridgeMcpHttpHealth = {
        schemaVersion: "0.1.0",
        kind: MEANTHIS_MCP_HTTP_HEALTH_KIND,
        ok: true,
        transport: "streamable-http",
        endpoint: MEANTHIS_MCP_HTTP_PATH,
        pid: process.pid,
        startCount,
        startedAt,
        activeSessions: sessions.size,
        retainedSessions: sessionResources.size,
        maxSessions,
        ownerIdentity,
      };
      const body = `${JSON.stringify(health)}\n`;
      const responseProof = createLocalBridgeMcpHttpHealthProofResponse(
        bearerToken,
        requestProof,
        body,
        { port: listeningPort },
      );
      for (const [name, value] of Object.entries(responseProof.headers)) {
        response.setHeader(name, value);
      }
      writeJsonText(response, 200, body);
      return;
    }
    if (requestUrl.pathname !== MEANTHIS_MCP_HTTP_PATH || requestUrl.search) {
      writeJson(response, 404, { error: "Not found." });
      return;
    }
    if (!isAuthorizedRequest(request, bearerTokenDigest)) {
      writeUnauthorized(response);
      return;
    }
    if (closing) {
      writeJson(response, 503, { error: "MeanThis MCP HTTP server is closing." });
      return;
    }
    if (request.method !== "GET" && request.method !== "POST" && request.method !== "DELETE") {
      response.setHeader("allow", "GET, POST, DELETE");
      writeJsonRpcError(response, 405, -32000, "Method not allowed.");
      return;
    }

    const suppliedControlHeader = request.headers[MEANTHIS_MCP_HTTP_CONTROL_HEADER];
    const controlRequest = suppliedControlHeader === MEANTHIS_MCP_HTTP_CONTROL_VALUE;
    if (suppliedControlHeader !== undefined && !controlRequest) {
      writeMcpControlError(response);
      return;
    }
    const releaseMcpRequest = reserveInFlightMcpRequest(controlRequest);
    if (!releaseMcpRequest) {
      writeMcpCapacityError(response);
      return;
    }
    try {
      await handleAuthorizedMcpRequest(
        request,
        response,
        releaseMcpRequest,
        controlRequest,
      );
    } finally {
      releaseMcpRequest();
    }
  }

  async function handleAuthorizedMcpRequest(
    request: IncomingMessage,
    response: ServerResponse,
    releaseMcpRequest: () => void,
    controlRequest: boolean,
  ): Promise<void> {
    const sessionId = singleHeader(request.headers["mcp-session-id"]);
    if (sessionId) {
      const session = sessions.get(sessionId);
      if (!session) {
        writeJsonRpcError(response, 404, -32001, "Session not found.");
        return;
      }
      if (
        controlRequest &&
        request.method !== "POST" &&
        request.method !== "DELETE"
      ) {
        writeMcpControlError(response);
        return;
      }
      if (
        controlRequest &&
        request.method === "DELETE" &&
        !hasStrictEmptyRequestFraming(request)
      ) {
        writeMcpControlError(response);
        return;
      }
      const endSessionRequest = beginSessionRequest(
        session,
        request,
        response,
        controlRequest,
      );
      if (!endSessionRequest) {
        writeMcpCapacityError(response);
        return;
      }
      // GET has no body and is separately bounded for the lifetime of its SSE response.
      // Release its global admission slot before the SDK waits on the long-lived stream.
      if (request.method === "GET") releaseMcpRequest();
      try {
        const parsedBody = request.method === "POST"
          ? await readMcpJsonBody(request, response)
          : undefined;
        if (parsedBody === INVALID_BODY) return;
        const exactControlMessage = request.method === "POST" &&
          isLocalBridgeMcpHttpControlMessage(parsedBody);
        if (
          controlRequest &&
          request.method === "POST" &&
          !exactControlMessage
        ) {
          writeMcpControlError(response);
          return;
        }
        const cancelledRequest = exactControlMessage
          ? CancelledNotificationSchema.safeParse(parsedBody)
          : null;
        const cancelledRequestId = cancelledRequest?.success
          ? cancelledRequest.data.params.requestId
          : undefined;
        const cancelledRequestResponse = cancelledRequestId !== undefined
          ? session.requestResponses.get(cancelledRequestId)
          : undefined;
        if (
          controlRequest &&
          cancelledRequestId !== undefined &&
          !cancelledRequestResponse
        ) {
          if (!reservePendingCancellationIntent(session, cancelledRequestId)) {
            writeMcpCapacityError(response);
            await cleanupSession(session);
            return;
          }
          writeMcpAccepted(response);
          return;
        }
        if (cancelledRequestResponse) {
          await cancelledRequestResponse.cancellationReady;
        }
        let requestResponses: McpRequestResponse[] = [];
        if (!controlRequest && request.method === "POST") {
          const trackedRequestResponses = trackSessionRequestResponses(
            session,
            response,
            parsedBody,
          );
          if (!trackedRequestResponses) {
            writeJsonRpcError(response, 400, ErrorCode.InvalidRequest, "Duplicate request ID.");
            await cleanupSession(session);
            return;
          }
          requestResponses = trackedRequestResponses;
        }
        const handledRequest = session.transport.handleRequest(request, response, parsedBody);
        if (!controlRequest && request.method === "POST") {
          await new Promise<void>((resolve) => {
            setImmediate(function allowSessionRequestCancellation() {
              resolve();
            });
          });
          markSessionRequestResponsesCancellationReady(session, requestResponses);
          await replayPendingSessionCancellations(session, requestResponses);
        }
        await handledRequest;
        if (cancelledRequestId !== undefined && cancelledRequestResponse) {
          await completeCancelledSessionRequest(
            session,
            cancelledRequestId,
            cancelledRequestResponse,
          );
        }
      } catch (error) {
        await cleanupSession(session);
        throw error;
      } finally {
        endSessionRequest();
      }
      return;
    }

    if (controlRequest) {
      writeMcpControlError(response);
      return;
    }
    if (request.method !== "POST") {
      writeJsonRpcError(response, 400, -32000, "Mcp-Session-Id header is required.");
      return;
    }
    const releaseInitializationCapacity = reserveInitializingSession();
    if (!releaseInitializationCapacity) {
      writeSessionCapacityError(response);
      return;
    }
    try {
      const parsedBody = await readMcpJsonBody(request, response);
      if (parsedBody === INVALID_BODY) return;
      if (!isInitializeRequest(parsedBody)) {
        writeJsonRpcError(response, 400, -32000, "Initialization request required.");
        return;
      }

      const server = createLocalBridgeMcpServer(reader);
      let session!: McpSession;
      const transport = new IdempotentStreamableHTTPServerTransport({
        sessionIdGenerator: randomUUID,
        enableJsonResponse: false,
        onsessioninitialized: (initializedSessionId) => {
          session.sessionId = initializedSessionId;
          sessions.set(initializedSessionId, session);
          noteSessionActivity(session);
        },
        onsessionclosed: () => {
          void cleanupSession(session);
        },
      });
      session = {
        server,
        transport,
        lastActivityAt: Date.now(),
        activeRequests: 1,
        activeControlRequests: 0,
        hasSeenSse: false,
        requestResponses: new Map(),
        pendingCancellationIntents: new Set(),
        nextRequestGeneration: 0,
        sseResponses: new Set(),
      };
      transport.onTerminalResponse = (requestId) => {
        const requestResponse = session.requestResponses.get(requestId);
        requestResponse?.markCancellationReady();
        if (session.requestResponses.get(requestId) === requestResponse) {
          session.requestResponses.delete(requestId);
        }
      };
      sessionResources.add(session);
      // Transfer the synchronous pre-body reservation to the retained resource.
      releaseInitializationCapacity();
      transport.onclose = () => {
        void cleanupSession(session);
      };
      try {
        await server.connect(transport);
        await transport.handleRequest(request, response, parsedBody);
      } catch (error) {
        await cleanupSession(session);
        throw error;
      } finally {
        session.activeRequests = Math.max(0, session.activeRequests - 1);
        if (!session.sessionId) {
          await cleanupSession(session);
        } else {
          noteSessionActivity(session);
        }
      }
    } finally {
      releaseInitializationCapacity();
    }
  }

  const close = (): Promise<void> => {
    if (closePromise) return closePromise;
    closing = true;
    closePromise = (async () => {
      const closed = new Promise<void>((resolve, reject) => {
        httpServer.close((error) => error ? reject(error) : resolve());
      });
      const active = [...sessionResources];
      const cleanup = Promise.allSettled(active.map(cleanupSession));
      httpServer.closeIdleConnections();
      httpServer.closeAllConnections();
      for (const socket of sockets) socket.destroy();
      await Promise.all([closed, cleanup]);
    })();
    return closePromise;
  };

  return {
    origin,
    url: `${origin}${MEANTHIS_MCP_HTTP_PATH}`,
    port: listeningPort,
    pid: process.pid,
    startCount,
    close,
  };
}

export async function runLocalBridgeMcpHttpServer(port: number): Promise<void> {
  const bearerToken = requireMcpHttpBearerToken(
    process.env[MEANTHIS_MCP_HTTP_TOKEN_ENV],
  );
  const agentToken = await loadOrCreateLocalBridgeAgentToken();
  const expectedOwnerIdentity = loadLocalBridgeOwnerIdentity();
  const reader = createHttpLocalBridgeReader(UI_ATTACH_LOCAL_BRIDGE_ORIGIN, agentToken, {
    expectedOwnerIdentity,
  });
  const startupReader = createHttpLocalBridgeReader(UI_ATTACH_LOCAL_BRIDGE_ORIGIN, agentToken, {
    expectedOwnerIdentity,
    requestTimeoutMs: 250,
  });
  const http = await startLocalBridgeMcpHttpServer(reader, {
    bearerToken,
    port,
  });
  let shuttingDown = false;
  let resolveShutdown!: () => void;
  let rejectShutdown!: (error: unknown) => void;
  const shutdownComplete = new Promise<void>((resolve, reject) => {
    resolveShutdown = resolve;
    rejectShutdown = reject;
  });
  const shutdown = () => {
    if (shuttingDown) return;
    shuttingDown = true;
    void http.close().then(resolveShutdown, rejectShutdown);
  };
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
  process.stderr.write(
    `MeanThis shared MCP ready at ${http.url} (pid ${http.pid}, start ${http.startCount}).\n`,
  );
  try {
    await ensureLocalBridgeOwner({
      probe: async () => { await startupReader.getStatus(); },
      spawnOwner: spawnDetachedLocalBridgeOwner,
      wait: waitForLocalBridgeOwner,
    });
  } catch {
    process.stderr.write("MeanThis browser bridge owner unavailable; bridge reads fail closed.\n");
  }
  try {
    await shutdownComplete;
  } finally {
    process.off("SIGINT", shutdown);
    process.off("SIGTERM", shutdown);
  }
}

const INVALID_BODY = Symbol("invalid-mcp-body");

async function readMcpJsonBody(
  request: IncomingMessage,
  response: ServerResponse,
): Promise<unknown | typeof INVALID_BODY> {
  const contentType = singleHeader(request.headers["content-type"]);
  if (!contentType || !/^application\/json(?:\s*;|$)/i.test(contentType)) {
    writeJsonRpcError(response, 415, -32000, "Content-Type must be application/json.");
    return INVALID_BODY;
  }
  const declaredLength = Number(singleHeader(request.headers["content-length"]));
  if (Number.isFinite(declaredLength) && declaredLength > MAX_MCP_REQUEST_BYTES) {
    writeJsonRpcError(response, 413, -32000, "Request body is too large.");
    return INVALID_BODY;
  }
  const chunks: Buffer[] = [];
  let length = 0;
  try {
    for await (const chunk of request) {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      length += bytes.length;
      if (length > MAX_MCP_REQUEST_BYTES) {
        writeJsonRpcError(response, 413, -32000, "Request body is too large.");
        return INVALID_BODY;
      }
      chunks.push(bytes);
    }
    return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
  } catch {
    writeJsonRpcError(response, 400, -32700, "Parse error.");
    return INVALID_BODY;
  }
}

function isAllowedLoopbackRequest(request: IncomingMessage, port: number): boolean {
  const expectedOrigin = `http://${MEANTHIS_MCP_HTTP_HOST}:${port}`;
  if (singleHeader(request.headers.host) !== `${MEANTHIS_MCP_HTTP_HOST}:${port}`) return false;
  const origin = singleHeader(request.headers.origin);
  return origin === undefined || origin === expectedOrigin;
}

function hasStrictEmptyRequestFraming(request: IncomingMessage): boolean {
  let contentLengthCount = 0;
  for (let index = 0; index < request.rawHeaders.length; index += 2) {
    const name = request.rawHeaders[index]?.toLowerCase();
    const value = request.rawHeaders[index + 1];
    if (name === "transfer-encoding") return false;
    if (name !== "content-length") continue;
    contentLengthCount += 1;
    if (contentLengthCount !== 1 || value !== "0") return false;
  }

  if (request.headers["transfer-encoding"] !== undefined) return false;
  const contentLength = request.headers["content-length"];
  if (contentLength === undefined) return contentLengthCount === 0;
  return contentLengthCount === 1 && contentLength === "0";
}

function isAuthorizedRequest(
  request: IncomingMessage,
  expectedTokenDigest: Buffer,
): boolean {
  const authorization = singleHeader(request.headers.authorization);
  const match = authorization?.match(/^Bearer ([A-Za-z0-9_-]{43})$/i);
  if (!match) return false;
  const suppliedTokenDigest = createHash("sha256").update(match[1], "utf8").digest();
  return timingSafeEqual(suppliedTokenDigest, expectedTokenDigest);
}

function verifyHealthProofRequest(
  request: IncomingMessage,
  port: number,
  bearerToken: string,
  seenNonces: Map<string, number>,
): Pick<LocalBridgeMcpHttpHealthProofRequest, "timestamp" | "nonce" | "proof"> | null {
  const timestamp = singleHeader(request.headers[MEANTHIS_MCP_HTTP_HEALTH_TIMESTAMP_HEADER]);
  const nonce = singleHeader(request.headers[MEANTHIS_MCP_HTTP_HEALTH_NONCE_HEADER]);
  const proof = singleHeader(request.headers[MEANTHIS_MCP_HTTP_HEALTH_PROOF_HEADER]);
  if (!timestamp || !nonce || !proof) return null;
  const requestProof = { timestamp, nonce, proof };
  const now = Date.now();
  if (!verifyLocalBridgeMcpHttpHealthProofRequest(
    bearerToken,
    requestProof,
    { port, now: () => now },
  )) return null;
  for (const [seenNonce, seenAt] of seenNonces) {
    if (Math.abs(now - seenAt) > MEANTHIS_MCP_HTTP_HEALTH_PROOF_MAX_CLOCK_SKEW_MS) {
      seenNonces.delete(seenNonce);
    }
  }
  if (seenNonces.has(nonce) || seenNonces.size >= HEALTH_PROOF_MAX_REPLAY_NONCES) return null;
  seenNonces.set(nonce, Number(timestamp));
  return requestProof;
}

function singleHeader(value: string | string[] | undefined): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function mcpRequestIdDigest(requestId: string | number): string {
  return createHash("sha256")
    .update(Buffer.from([typeof requestId === "string" ? 0 : 1]))
    .update(String(requestId), "utf16le")
    .digest("base64url");
}

function invalidMcpHttpArgs(): LocalBridgeMcpHttpArgs {
  return {
    ok: false,
    code: "INVALID_ARGUMENTS",
    message: "Usage: meanthis mcp-http [--port <1-65535>]",
  };
}

function requireMcpHttpBearerToken(value: string | undefined): string {
  if (!value || !validateLocalBridgeMcpHttpToken(value)) {
    throw new LocalBridgeMcpHttpBearerTokenError();
  }
  return value;
}

function validateMcpHttpOwnerIdentity(
  value: { buildHash: string } | undefined,
): { buildHash: string } | null {
  if (value === undefined) return null;
  if (!/^[a-f0-9]{64}$/.test(value.buildHash)) {
    throw new Error("Invalid MeanThis MCP HTTP owner identity.");
  }
  return { buildHash: value.buildHash };
}

export function isLocalBridgeMcpHttpHealth(value: unknown): value is LocalBridgeMcpHttpHealth {
  if (!isRecord(value) || !hasExactKeys(value, [
    "schemaVersion",
    "kind",
    "ok",
    "transport",
    "endpoint",
    "pid",
    "startCount",
    "startedAt",
    "activeSessions",
    "retainedSessions",
    "maxSessions",
    "ownerIdentity",
  ])) return false;
  return value.schemaVersion === "0.1.0" &&
    value.kind === MEANTHIS_MCP_HTTP_HEALTH_KIND &&
    value.ok === true &&
    value.transport === "streamable-http" &&
    value.endpoint === MEANTHIS_MCP_HTTP_PATH &&
    isPositiveInteger(value.pid) &&
    isPositiveInteger(value.startCount) &&
    isCanonicalIsoDate(value.startedAt) &&
    isNonNegativeInteger(value.activeSessions) &&
    isNonNegativeInteger(value.retainedSessions) &&
    isPositiveInteger(value.maxSessions) &&
    value.activeSessions <= value.retainedSessions &&
    value.retainedSessions <= value.maxSessions &&
    isMcpHttpHealthOwnerIdentity(value.ownerIdentity);
}

function isMcpHttpHealthOwnerIdentity(value: unknown): boolean {
  return value === null || (
    isRecord(value) &&
    hasExactKeys(value, ["buildHash"]) &&
    typeof value.buildHash === "string" &&
    /^[a-f0-9]{64}$/.test(value.buildHash)
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

function isPositiveInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function isCanonicalIsoDate(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) && new Date(timestamp).toISOString() === value;
}

function writeUnauthorized(response: ServerResponse): void {
  response.setHeader("connection", "close");
  response.setHeader("www-authenticate", 'Bearer realm="meanthis-mcp"');
  writeJsonRpcError(response, 401, -32001, "Unauthorized.");
}

function writeMcpCapacityError(response: ServerResponse): void {
  response.setHeader("connection", "close");
  response.shouldKeepAlive = false;
  writeJsonText(response, 503, MCP_RESOURCE_CAPACITY_BODY);
}

function writeMcpAccepted(response: ServerResponse): void {
  response.writeHead(202).end();
}

function writeMcpControlError(response: ServerResponse): void {
  response.setHeader("connection", "close");
  response.shouldKeepAlive = false;
  writeJsonRpcError(response, 400, -32600, "Invalid control request.");
}

function writeSessionCapacityError(response: ServerResponse): void {
  response.setHeader("connection", "close");
  response.shouldKeepAlive = false;
  writeJsonRpcError(response, 503, -32002, "MCP session capacity reached.");
}

function closeSocketWithCapacityError(socket: Socket): void {
  if (socket.destroyed) return;
  const responseHead = [
    "HTTP/1.1 503 Service Unavailable",
    "Connection: close",
    "Content-Type: application/json; charset=utf-8",
    "Cache-Control: no-store",
    `Content-Length: ${Buffer.byteLength(MCP_RESOURCE_CAPACITY_BODY)}`,
    "",
    "",
  ].join("\r\n");
  socket.setTimeout(1_000, () => socket.destroy());
  socket.end(`${responseHead}${MCP_RESOURCE_CAPACITY_BODY}`, "utf8");
}

function writeHealthProofUnauthorized(response: ServerResponse): void {
  response.setHeader("connection", "close");
  response.setHeader("www-authenticate", 'MeanThis-HMAC realm="meanthis-mcp-health"');
  writeJsonRpcError(response, 401, -32001, "Unauthorized.");
}

function writeHealthProofFramingError(response: ServerResponse): void {
  response.setHeader("connection", "close");
  response.shouldKeepAlive = false;
  writeJsonRpcError(response, 400, -32000, "Invalid health request framing.");
}

function validateMaxSessions(value: number): number {
  if (
    !Number.isSafeInteger(value) ||
    value < 1 ||
    value > MAX_CONFIGURED_MCP_HTTP_SESSIONS
  ) {
    throw new Error(
      `MeanThis MCP HTTP max sessions must be an integer between 1 and ${MAX_CONFIGURED_MCP_HTTP_SESSIONS}.`,
    );
  }
  return value;
}

function validateResourceLimit(name: string, value: number): number {
  if (
    !Number.isSafeInteger(value) ||
    value < 1 ||
    value > MAX_CONFIGURED_MCP_HTTP_RESOURCE_LIMIT
  ) {
    throw new Error(
      `MeanThis MCP HTTP ${name} limit must be an integer between 1 and ${MAX_CONFIGURED_MCP_HTTP_RESOURCE_LIMIT}.`,
    );
  }
  return value;
}

function validateSessionLifetime(name: string, value: number): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > MAX_SESSION_LIFETIME_MS) {
    throw new Error(`Invalid MeanThis MCP HTTP session ${name}.`);
  }
  return value;
}

function writeJsonRpcError(
  response: ServerResponse,
  status: number,
  code: number,
  message: string,
): void {
  writeJson(response, status, {
    jsonrpc: "2.0",
    error: { code, message },
    id: null,
  });
}

function writeJson(response: ServerResponse, status: number, value: unknown): void {
  writeJsonText(response, status, `${JSON.stringify(value)}\n`);
}

function writeJsonText(response: ServerResponse, status: number, body: string): void {
  response.setHeader("content-type", "application/json; charset=utf-8");
  response.setHeader("cache-control", "no-store");
  response.writeHead(status).end(body);
}
