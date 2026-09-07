import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { deserializeMessage, serializeMessage } from "@modelcontextprotocol/sdk/shared/stdio.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { JSONRPCMessage } from "@modelcontextprotocol/sdk/types.js";
import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import { resolve } from "node:path";
import process from "node:process";
import type { Readable, Writable } from "node:stream";
import { pathToFileURL } from "node:url";
import { TextDecoder } from "node:util";
import { Worker } from "node:worker_threads";
import { UI_ATTACH_LOCAL_BRIDGE_ORIGIN } from "@meanthis/schema";
import { readVerifiedLocalBridgeAgentToken } from "./local-bridge-agent-token.js";
import {
  createLocalBridgeMcpHttpControlAwareFetch,
  isLocalBridgeMcpHttpControlMessage,
} from "./local-bridge-mcp-http-control.js";
import {
  MEANTHIS_MCP_HTTP_DEFAULT_PORT,
  MEANTHIS_MCP_HTTP_HEALTH_NONCE_HEADER,
  MEANTHIS_MCP_HTTP_HEALTH_PROOF_HEADER,
  MEANTHIS_MCP_HTTP_HEALTH_TIMESTAMP_HEADER,
  createLocalBridgeMcpHttpHealthProofRequest,
  isLocalBridgeMcpHttpVerifiedOwnerHealth,
  verifyLocalBridgeMcpHttpHealthProofResponse,
} from "./local-bridge-mcp-http-health-proof.js";
import { ensureDetachedLocalBridgeMcpHttpOwner } from "./local-bridge-mcp-http-owner.js";
import { createHttpLocalBridgeReader } from "./local-bridge-mcp.js";
import {
  MEANTHIS_MCP_HTTP_TOKEN_ENV,
  readVerifiedLocalBridgeMcpHttpDesiredIdentity,
  readVerifiedLocalBridgeMcpHttpToken,
  validateLocalBridgeMcpHttpToken,
} from "./local-bridge-mcp-http-token.js";
import {
  ensureLocalBridgeOwner,
  loadLocalBridgeOwnerIdentity,
  spawnDetachedLocalBridgeOwner,
  waitForLocalBridgeOwner,
} from "./local-bridge-owner.js";

export const MEANTHIS_MCP_STDIO_BROKER_URL =
  `http://127.0.0.1:${MEANTHIS_MCP_HTTP_DEFAULT_PORT}/mcp` as const;

const MEANTHIS_MCP_STDIO_BROKER_HEALTH_URL =
  `http://127.0.0.1:${MEANTHIS_MCP_HTTP_DEFAULT_PORT}/health` as const;
const MEANTHIS_MCP_STDIO_BROKER_MAX_HEALTH_BYTES = 64 * 1024;
const MEANTHIS_MCP_STDIO_BROKER_HEALTH_TIMEOUT_MS = 1_000;
const MEANTHIS_MCP_STDIO_BROKER_ERROR_MESSAGE =
  "MeanThis MCP stdio broker unavailable." as const;
const MEANTHIS_MCP_STDIO_BROKER_TOOL_ERROR_MESSAGE =
  "MeanThis MCP tool surface unavailable." as const;
const MEANTHIS_MCP_STDIO_BROKER_MAX_PENDING_INITIALIZE = 1;
const MEANTHIS_MCP_STDIO_BROKER_MAX_PENDING_TOOLS_LIST = 16;
const MEANTHIS_MCP_STDIO_BROKER_MAX_PENDING_CLIENT_REQUESTS = 64;
const MEANTHIS_MCP_STDIO_BROKER_MAX_CANCELLED_REQUEST_TOMBSTONES = 256;
const MEANTHIS_MCP_STDIO_BROKER_MAX_ACTIVE_UPSTREAM_SENDS = 64;
const MEANTHIS_MCP_STDIO_BROKER_MAX_ACTIVE_CONTROL_SENDS = 8;
const MEANTHIS_MCP_STDIO_BROKER_MAX_PENDING_SERVER_REQUESTS = 16;
const MEANTHIS_MCP_STDIO_BROKER_SESSION_TERMINATION_TIMEOUT_MS = 1_000;
const MEANTHIS_MCP_STDIO_BROKER_RECONNECT_TIMEOUT_MS = 10_000;
const MEANTHIS_MCP_STDIO_WRITER_STARTUP_TIMEOUT_MS = 1_000;
export const MEANTHIS_MCP_STDIO_BROKER_MAX_FRAME_BYTES = 1_048_576;
const MEANTHIS_MCP_STDIO_BROKER_MAX_BUFFERED_FRAME_BYTES =
  MEANTHIS_MCP_STDIO_BROKER_MAX_FRAME_BYTES + 1;
const MEANTHIS_MCP_STDIO_BROKER_INITIAL_FRAME_BUFFER_BYTES = 8 * 1024;
const MEANTHIS_MCP_STDIO_BROKER_RETAINED_FRAME_BUFFER_BYTES = 64 * 1024;
const MEANTHIS_MCP_STDIO_WRITER_WORKER_SOURCE = `
const { writeSync } = require("node:fs");
const { parentPort } = require("node:worker_threads");

function hasExactKeys(value, expected) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const keys = Reflect.ownKeys(value);
  return keys.length === expected.length && expected.every((key) => keys.includes(key));
}

parentPort.on("message", (message) => {
  if (
    !hasExactKeys(message, ["kind", "id", "frame"]) ||
    message.kind !== "frame" ||
    !Number.isSafeInteger(message.id) ||
    typeof message.frame !== "string"
  ) throw new Error("invalid writer frame");
  const bytes = Buffer.from(message.frame, "utf8");
  let offset = 0;
  while (offset < bytes.length) {
    const written = writeSync(1, bytes, offset, bytes.length - offset);
    if (!Number.isSafeInteger(written) || written < 1) throw new Error("writer stalled");
    offset += written;
  }
  parentPort.postMessage({ kind: "ack", id: message.id });
});
parentPort.postMessage({ kind: "ready" });
`;
const EXPECTED_TOOL_NAMES = [
  "meanthis_list_captures",
  "meanthis_read_capture",
  "meanthis_ack_capture_read",
  "meanthis_wait_capture_change",
  "meanthis_resolve_source",
] as const;

type BrokerFetch = (input: string | URL, init?: RequestInit) => Promise<Response>;

interface BrokerLifecycleSource {
  once(event: string, listener: () => void): unknown;
  off(event: string, listener: () => void): unknown;
}

interface BrokerHttpTransport extends Transport {
  terminateSession?(): Promise<void>;
}

interface BrokerStdioWriter {
  onerror?: () => void;
  start(): Promise<void>;
  send(frame: string): Promise<void>;
  close(): Promise<void>;
}

interface BrokerRequestIdAlias {
  alias: string;
  originalId: string | number;
  originalKey: string;
}

export interface LocalBridgeMcpStdioBrokerOptions {
  environment?: NodeJS.ProcessEnv;
  readToken?: () => Promise<string>;
  ensureOwners?: (bearerToken: string) => Promise<void>;
  readDesiredBuildHash?: () => Promise<string>;
  verifyDaemon?: (bearerToken: string, expectedBuildHash: string) => Promise<void>;
  createStdioTransport?: () => Transport;
  createHttpTransport?: (input: {
    url: URL;
    bearerToken: string;
  }) => BrokerHttpTransport;
  inputLifecycle?: BrokerLifecycleSource;
  signalLifecycle?: BrokerLifecycleSource;
  stdin?: Readable;
  stdout?: Writable;
  sessionTerminationTimeoutMs?: number;
}

export interface LocalBridgeMcpStdioBroker {
  closed: Promise<void>;
  close(): Promise<void>;
}

export interface LocalBridgeMcpStdioBrokerDaemonVerificationOptions {
  fetch?: BrokerFetch;
  now?: () => number;
  randomBytes?: (size: number) => Uint8Array;
  timeoutMs?: number;
}

class LocalBridgeMcpStdioBrokerError extends Error {
  constructor() {
    super(MEANTHIS_MCP_STDIO_BROKER_ERROR_MESSAGE);
    this.name = "LocalBridgeMcpStdioBrokerError";
  }
}

class RecoveringBrokerHttpTransport implements BrokerHttpTransport {
  onclose?: () => void;
  onerror?: (error: Error) => void;
  onmessage?: Transport["onmessage"];

  private current: BrokerHttpTransport;
  private currentGeneration = 0;
  private activeSends = 0;
  private closing = false;
  private recoveryPromise: Promise<void> | null = null;
  private initializeMessage: JSONRPCMessage | null = null;
  private initializedNotification: JSONRPCMessage | null = null;
  private protocolVersion: string | null = null;
  private canReconnect = () => false;
  private shouldReplay = (_message: JSONRPCMessage) => false;
  private internalResponse: {
    id: string;
    resolve: (message: JSONRPCMessage) => void;
    reject: (error: Error) => void;
    timeout: NodeJS.Timeout;
  } | null = null;
  private reconnectSequence = 0;

  constructor(private readonly options: {
    initialTransport: BrokerHttpTransport;
    createTransport: () => BrokerHttpTransport;
    prepareReconnect: () => Promise<void>;
    reconnectTimeoutMs: number;
  }) {
    this.current = options.initialTransport;
    this.bindCurrentTransport();
  }

  setRecoveryGuard(guard: () => boolean): void {
    this.canReconnect = guard;
  }

  setReplayGuard(guard: (message: JSONRPCMessage) => boolean): void {
    this.shouldReplay = guard;
  }

  async start(): Promise<void> {
    await this.current.start();
  }

  async send(message: JSONRPCMessage): Promise<void> {
    this.rememberHandshakeMessage(message);
    if (this.recoveryPromise) await this.recoveryPromise;
    const transport = this.current;
    const generation = this.currentGeneration;
    this.activeSends += 1;
    try {
      await transport.send(message);
      if (generation !== this.currentGeneration) {
        if (this.recoveryPromise) await this.recoveryPromise;
        if (this.shouldReplay(message)) await this.current.send(message);
      }
    } catch (error) {
      if (this.closing) throw brokerUnavailable();
      if (generation !== this.currentGeneration) {
        if (this.recoveryPromise) await this.recoveryPromise;
        if (this.shouldReplay(message)) await this.current.send(message);
        return;
      }
      if (isFatalBrokerHttpError(error)) throw brokerUnavailable();
      await this.recover(transport, generation);
      if (this.shouldReplay(message)) await this.current.send(message);
    } finally {
      this.activeSends -= 1;
    }
  }

  setProtocolVersion(version: string): void {
    this.protocolVersion = version;
    this.current.setProtocolVersion?.(version);
  }

  async terminateSession(): Promise<void> {
    await this.current.terminateSession?.();
  }

  async close(): Promise<void> {
    if (this.closing) return;
    this.closing = true;
    this.cancelInternalResponse();
    await this.current.close();
  }

  private rememberHandshakeMessage(message: JSONRPCMessage): void {
    const request = messageRequest(message);
    if (request?.method === "initialize") {
      this.initializeMessage = structuredClone(message);
      return;
    }
    const record = message as Record<string, unknown>;
    if (
      record.method === "notifications/initialized" &&
      messageResponseId(message) === undefined
    ) {
      this.initializedNotification = structuredClone(message);
    }
  }

  private bindCurrentTransport(): void {
    const transport = this.current;
    const generation = this.currentGeneration;
    transport.onmessage = (message) => {
      if (this.closing || transport !== this.current || generation !== this.currentGeneration) return;
      if (this.internalResponse && messageResponseId(message) === this.internalResponse.id) {
        const waiter = this.internalResponse;
        this.internalResponse = null;
        waiter.resolve(message);
        return;
      }
      this.onmessage?.(message);
    };
    transport.onerror = (error) => {
      if (this.closing || transport !== this.current || generation !== this.currentGeneration) return;
      // StreamableHTTPClientTransport reports a failed POST through onerror
      // before rejecting send(). Let that call classify and recover the error
      // once; unsolicited/SSE errors remain fail-closed.
      if (this.activeSends > 0 || this.recoveryPromise) return;
      this.onerror?.(brokerUnavailable());
    };
    transport.onclose = () => {
      if (this.closing || transport !== this.current || generation !== this.currentGeneration) return;
      void this.recover(transport, generation).catch(() => {
        this.onerror?.(brokerUnavailable());
      });
    };
  }

  private recover(failedTransport: BrokerHttpTransport, failedGeneration: number): Promise<void> {
    if (this.recoveryPromise) return this.recoveryPromise;
    if (
      this.closing || failedTransport !== this.current ||
      failedGeneration !== this.currentGeneration || !this.canReconnect() ||
      !this.initializeMessage || !this.initializedNotification || !this.protocolVersion
    ) {
      return Promise.reject(brokerUnavailable());
    }
    this.recoveryPromise = this.performRecovery(failedTransport)
      .finally(() => { this.recoveryPromise = null; });
    return this.recoveryPromise;
  }

  private async performRecovery(failedTransport: BrokerHttpTransport): Promise<void> {
    await this.options.prepareReconnect();
    if (this.closing || failedTransport !== this.current) throw brokerUnavailable();

    const replacement = this.options.createTransport();
    this.current = replacement;
    this.currentGeneration += 1;
    this.bindCurrentTransport();
    try {
      await replacement.start();
      const reconnectPrefix = `meanthis-stdio-reconnect-${randomUUID()}-${this.reconnectSequence++}`;
      const initializeId = `${reconnectPrefix}-initialize`;
      const initializeResponse = this.waitForInternalResponse(initializeId);
      await replacement.send(replaceMessageId(this.initializeMessage!, initializeId));
      const initialized = await initializeResponse;
      const version = initializeProtocolVersion(initialized);
      if (!version || version !== this.protocolVersion) throw brokerUnavailable();
      replacement.setProtocolVersion?.(version);
      await replacement.send(this.initializedNotification!);

      const toolsListId = `${reconnectPrefix}-tools-list`;
      const toolsListResponse = this.waitForInternalResponse(toolsListId);
      await replacement.send({
        jsonrpc: "2.0",
        id: toolsListId,
        method: "tools/list",
      });
      if (!hasExactToolSurface(await toolsListResponse)) throw brokerUnavailable();
      await settleWithin(Promise.resolve().then(() => failedTransport.close()),
        this.options.reconnectTimeoutMs);
    } catch {
      this.cancelInternalResponse();
      await settleWithin(Promise.resolve().then(() => replacement.close()),
        this.options.reconnectTimeoutMs);
      throw brokerUnavailable();
    }
  }

  private waitForInternalResponse(id: string): Promise<JSONRPCMessage> {
    if (this.internalResponse) return Promise.reject(brokerUnavailable());
    const response = new Promise<JSONRPCMessage>((resolveResponse, rejectResponse) => {
      const timeout = setTimeout(() => {
        if (this.internalResponse?.id === id) this.internalResponse = null;
        rejectResponse(brokerUnavailable());
      }, this.options.reconnectTimeoutMs);
      this.internalResponse = {
        id,
        timeout,
        resolve: (message) => {
          clearTimeout(timeout);
          resolveResponse(message);
        },
        reject: rejectResponse,
      };
    });
    void response.catch(() => undefined);
    return response;
  }

  private cancelInternalResponse(): void {
    const waiter = this.internalResponse;
    if (!waiter) return;
    this.internalResponse = null;
    clearTimeout(waiter.timeout);
    waiter.reject(brokerUnavailable());
  }
}

async function ensureInstalledLocalBridgeOwners(bearerToken: string): Promise<void> {
  // MCP startup may start the singleton owners only from already-installed,
  // protected credentials. Neither this parent path nor either child process
  // creates or repairs credential storage.
  const agentToken = await readVerifiedLocalBridgeAgentToken();
  const browserOwnerIdentity = loadLocalBridgeOwnerIdentity();
  const startupReader = createHttpLocalBridgeReader(
    UI_ATTACH_LOCAL_BRIDGE_ORIGIN,
    agentToken,
    { expectedOwnerIdentity: browserOwnerIdentity, requestTimeoutMs: 250 },
  );
  await ensureLocalBridgeOwner({
    probe: async () => { await startupReader.getStatus(); },
    spawnOwner: spawnDetachedLocalBridgeOwner,
    wait: waitForLocalBridgeOwner,
  }, {
    agentToken,
    expectedIdentity: browserOwnerIdentity,
  });
  await ensureDetachedLocalBridgeMcpHttpOwner(bearerToken);
}

class WritableStdioWriter implements BrokerStdioWriter {
  onerror?: () => void;

  private readonly pendingDrains = new Set<{
    listener: () => void;
    reject: (error: Error) => void;
  }>();
  private closing = false;

  constructor(private readonly output: Writable) {}

  async start(): Promise<void> {}

  send(frame: string): Promise<void> {
    if (this.closing) return Promise.reject(brokerUnavailable());
    return new Promise((resolveSend, rejectSend) => {
      const pending = {
        listener: () => {
          this.pendingDrains.delete(pending);
          resolveSend();
        },
        reject: rejectSend,
      };
      this.pendingDrains.add(pending);
      this.output.once("drain", pending.listener);
      try {
        if (!this.output.write(frame)) return;
        this.output.off("drain", pending.listener);
        if (this.pendingDrains.delete(pending)) {
          resolveSend();
        }
      } catch (error) {
        this.output.off("drain", pending.listener);
        this.pendingDrains.delete(pending);
        rejectSend(error);
      }
    });
  }

  async close(): Promise<void> {
    if (this.closing) return;
    this.closing = true;
    const error = brokerUnavailable();
    for (const pending of this.pendingDrains) {
      this.output.off("drain", pending.listener);
      pending.reject(error);
    }
    this.pendingDrains.clear();
  }
}

interface PendingWriterFrame {
  id: number;
  frame?: string;
  resolve: () => void;
  reject: (error: Error) => void;
}

class WorkerThreadStdioWriter implements BrokerStdioWriter {
  onerror?: () => void;

  private worker: Worker | undefined;
  private exitPromise: Promise<void> = Promise.resolve();
  private resolveExit: (() => void) | undefined;
  private startPromise: Promise<void> | undefined;
  private resolveReady: (() => void) | undefined;
  private rejectReady: ((error: Error) => void) | undefined;
  private nextId = 1;
  private active: PendingWriterFrame | undefined;
  private readonly queue: PendingWriterFrame[] = [];
  private ready = false;
  private closing = false;
  private failed = false;

  constructor(private readonly startupTimeoutMs: number) {}

  start(): Promise<void> {
    if (this.startPromise) return this.startPromise;
    this.startPromise = this.startWriter();
    void this.startPromise.catch(() => undefined);
    return this.startPromise;
  }

  send(frame: string): Promise<void> {
    if (
      !this.ready ||
      this.closing ||
      this.failed ||
      Buffer.byteLength(frame, "utf8") > MEANTHIS_MCP_STDIO_BROKER_MAX_BUFFERED_FRAME_BYTES
    ) return Promise.reject(brokerUnavailable());
    return new Promise<void>((resolveFrame, rejectFrame) => {
      const pending = {
        id: this.nextId,
        frame,
        resolve: resolveFrame,
        reject: rejectFrame,
      };
      this.nextId = this.nextId === Number.MAX_SAFE_INTEGER ? 1 : this.nextId + 1;
      this.queue.push(pending);
      this.dispatchNext();
    });
  }

  async close(): Promise<void> {
    if (this.closing) return this.exitPromise;
    this.closing = true;
    const error = brokerUnavailable();
    this.rejectReady?.(error);
    this.rejectPending(error);
    const worker = this.worker;
    if (!worker) return;
    let termination: Promise<number> | undefined;
    try {
      termination = worker.terminate();
    } catch {
      // The exit promise below remains the authority for the hard-kill fuse.
    }
    worker.unref();
    void termination?.catch(() => undefined);
    return this.exitPromise;
  }

  private async startWriter(): Promise<void> {
    if (this.closing) throw brokerUnavailable();
    let worker: Worker;
    try {
      worker = new Worker(MEANTHIS_MCP_STDIO_WRITER_WORKER_SOURCE, { eval: true });
    } catch {
      this.fail();
      throw brokerUnavailable();
    }
    this.worker = worker;
    this.exitPromise = new Promise<void>((resolveExit) => {
      this.resolveExit = resolveExit;
    });
    worker.on("message", this.onWorkerMessage);
    worker.once("error", this.onWorkerFailure);
    worker.once("exit", this.onWorkerExit);
    worker.unref();

    let timeout: NodeJS.Timeout | undefined;
    try {
      await Promise.race([
        new Promise<void>((resolveReady, rejectReady) => {
          this.resolveReady = resolveReady;
          this.rejectReady = rejectReady;
        }),
        new Promise<void>((_resolve, rejectTimeout) => {
          timeout = setTimeout(() => rejectTimeout(brokerUnavailable()), this.startupTimeoutMs);
        }),
      ]);
    } catch {
      this.fail();
      throw brokerUnavailable();
    } finally {
      if (timeout) clearTimeout(timeout);
      this.resolveReady = undefined;
      this.rejectReady = undefined;
    }
  }

  private readonly onWorkerMessage = (message: unknown): void => {
    if (!this.ready) {
      if (!isExactWriterReady(message)) {
        this.fail();
        return;
      }
      this.ready = true;
      this.resolveReady?.();
      return;
    }
    const active = this.active;
    if (!active || !isExactWriterAck(message, active.id)) {
      this.fail();
      return;
    }
    this.active = undefined;
    active.resolve();
    this.dispatchNext();
  };

  private readonly onWorkerFailure = (): void => {
    this.fail();
  };

  private readonly onWorkerExit = (): void => {
    this.resolveExit?.();
    if (!this.closing) this.fail();
  };

  private dispatchNext(): void {
    if (this.active || this.closing || this.failed) return;
    const worker = this.worker;
    const next = this.queue.shift();
    if (!next) return;
    if (!worker || next.frame === undefined) {
      next.reject(brokerUnavailable());
      this.fail();
      return;
    }
    this.active = next;
    try {
      worker.postMessage({ kind: "frame", id: next.id, frame: next.frame });
      next.frame = undefined;
    } catch {
      this.fail();
    }
  }

  private rejectPending(error: Error): void {
    this.active?.reject(error);
    this.active = undefined;
    for (const pending of this.queue.splice(0)) pending.reject(error);
  }

  private fail(): void {
    if (this.failed || this.closing) return;
    this.failed = true;
    const error = brokerUnavailable();
    this.rejectReady?.(error);
    this.rejectPending(error);
    this.onerror?.();
  }
}

class BoundedStdioServerTransport implements Transport {
  onclose?: () => void;
  onerror?: (error: Error) => void;
  onmessage?: Transport["onmessage"];

  private started = false;
  private closed = false;
  private failed = false;
  private frameBuffer = Buffer.alloc(0);
  private frameLength = 0;

  constructor(
    private readonly input: Readable,
    private readonly output: BrokerStdioWriter,
  ) {}

  private readonly onInputData = (chunk: Buffer | string): void => {
    if (this.closed || this.failed) return;
    try {
      this.processChunk(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    } catch {
      this.fail();
    }
  };

  private readonly onInputError = (): void => {
    this.fail();
  };

  async start(): Promise<void> {
    if (this.started) throw brokerUnavailable();
    if (this.closed) throw brokerUnavailable();
    this.started = true;
    this.output.onerror = this.onOutputError;
    await this.output.start();
    if (this.closed) return;
    this.input.on("data", this.onInputData);
    this.input.on("error", this.onInputError);
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.input.off("data", this.onInputData);
    this.input.off("error", this.onInputError);
    this.output.onerror = undefined;
    if (this.input.listenerCount("data") === 0) this.input.pause();
    this.clearFrame();
    this.onclose?.();
    await this.output.close();
  }

  send(message: JSONRPCMessage): Promise<void> {
    if (this.closed || this.failed) return Promise.reject(brokerUnavailable());
    let frame: string;
    try {
      frame = serializeMessage(message);
      if (
        Buffer.byteLength(frame, "utf8") > MEANTHIS_MCP_STDIO_BROKER_MAX_BUFFERED_FRAME_BYTES
      ) throw brokerUnavailable();
    } catch {
      this.fail();
      return Promise.reject(brokerUnavailable());
    }
    return this.output.send(frame);
  }

  private readonly onOutputError = (): void => {
    this.fail();
  };

  private processChunk(chunk: Buffer): void {
    let offset = 0;
    while (offset < chunk.length && !this.closed && !this.failed) {
      const newlineIndex = chunk.indexOf(0x0a, offset);
      const segmentEnd = newlineIndex === -1 ? chunk.length : newlineIndex;
      if (!this.appendFrameSegment(chunk.subarray(offset, segmentEnd))) return;
      if (newlineIndex === -1) return;

      const frameLength = this.frameLength > 0 && this.frameBuffer[this.frameLength - 1] === 0x0d
        ? this.frameLength - 1
        : this.frameLength;
      let line: string;
      try {
        line = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(
          this.frameBuffer.subarray(0, frameLength),
        );
      } catch {
        this.fail();
        return;
      }
      this.resetFrameAfterMessage();
      let message: JSONRPCMessage;
      try {
        message = deserializeMessage(line);
      } catch {
        this.fail();
        return;
      }
      this.onmessage?.(message);
      offset = newlineIndex + 1;
    }
  }

  private appendFrameSegment(segment: Buffer): boolean {
    const nextLength = this.frameLength + segment.length;
    const terminalByte = segment.length > 0
      ? segment[segment.length - 1]
      : this.frameLength > 0
      ? this.frameBuffer[this.frameLength - 1]
      : undefined;
    if (
      nextLength > MEANTHIS_MCP_STDIO_BROKER_MAX_BUFFERED_FRAME_BYTES ||
      (
        nextLength === MEANTHIS_MCP_STDIO_BROKER_MAX_BUFFERED_FRAME_BYTES &&
        terminalByte !== 0x0d
      )
    ) {
      this.fail();
      return false;
    }
    if (nextLength > this.frameBuffer.length) {
      let nextCapacity = Math.max(
        MEANTHIS_MCP_STDIO_BROKER_INITIAL_FRAME_BUFFER_BYTES,
        this.frameBuffer.length * 2,
      );
      while (nextCapacity < nextLength) nextCapacity *= 2;
      nextCapacity = Math.min(nextCapacity, MEANTHIS_MCP_STDIO_BROKER_MAX_BUFFERED_FRAME_BYTES);
      const nextBuffer = Buffer.allocUnsafe(nextCapacity);
      this.frameBuffer.copy(nextBuffer, 0, 0, this.frameLength);
      this.frameBuffer = nextBuffer;
    }
    segment.copy(this.frameBuffer, this.frameLength);
    this.frameLength = nextLength;
    return true;
  }

  private resetFrameAfterMessage(): void {
    this.frameLength = 0;
    if (this.frameBuffer.length > MEANTHIS_MCP_STDIO_BROKER_RETAINED_FRAME_BUFFER_BYTES) {
      this.frameBuffer = Buffer.alloc(0);
    }
  }

  private clearFrame(): void {
    this.frameBuffer = Buffer.alloc(0);
    this.frameLength = 0;
  }

  private fail(): void {
    if (this.failed || this.closed) return;
    this.failed = true;
    this.clearFrame();
    this.onerror?.(brokerUnavailable());
  }
}

export async function verifyLocalBridgeMcpStdioBrokerDaemon(
  bearerToken: string,
  expectedBuildHash: string,
  options: LocalBridgeMcpStdioBrokerDaemonVerificationOptions = {},
): Promise<void> {
  try {
    if (!validateLocalBridgeMcpHttpToken(bearerToken)) throw brokerUnavailable();
    if (!/^[0-9a-f]{64}$/.test(expectedBuildHash)) throw brokerUnavailable();
    const now = options.now ?? Date.now;
    const requestProof = createLocalBridgeMcpHttpHealthProofRequest(bearerToken, {
      port: MEANTHIS_MCP_HTTP_DEFAULT_PORT,
      now,
      randomBytes: options.randomBytes,
    });
    const abortController = new AbortController();
    const timeoutMs = options.timeoutMs ?? MEANTHIS_MCP_STDIO_BROKER_HEALTH_TIMEOUT_MS;
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 30_000) {
      throw brokerUnavailable();
    }
    const timeout = setTimeout(() => abortController.abort(), timeoutMs);
    timeout.unref?.();
    try {
      const response = await (options.fetch ?? fetch)(MEANTHIS_MCP_STDIO_BROKER_HEALTH_URL, {
        method: "GET",
        headers: requestProof.headers,
        redirect: "error",
        signal: abortController.signal,
      });
      const body = await readBoundedHealthBody(response);
      if (
        response.status !== 200 ||
        !verifyLocalBridgeMcpHttpHealthProofResponse(
          bearerToken,
          requestProof,
          {
            port: MEANTHIS_MCP_HTTP_DEFAULT_PORT,
            status: response.status,
            headers: response.headers,
            body,
          },
          { now },
        )
      ) {
        throw brokerUnavailable();
      }
      const health: unknown = JSON.parse(body);
      if (
        !isLocalBridgeMcpHttpVerifiedOwnerHealth(health) ||
        health.ownerIdentity.buildHash !== expectedBuildHash
      ) {
        throw brokerUnavailable();
      }
    } finally {
      clearTimeout(timeout);
    }
  } catch {
    throw brokerUnavailable();
  }
}

export async function startLocalBridgeMcpStdioBroker(
  options: LocalBridgeMcpStdioBrokerOptions = {},
): Promise<LocalBridgeMcpStdioBroker> {
  return startLocalBridgeMcpStdioBrokerInternal(options, false);
}

async function startLocalBridgeMcpStdioBrokerInternal(
  options: LocalBridgeMcpStdioBrokerOptions,
  forceProcessExitOnBlockedOwnedOutput: boolean,
): Promise<LocalBridgeMcpStdioBroker> {
  const environment = options.environment ?? process.env;
  removeInheritedBearer(environment);
  const sessionTerminationTimeoutMs = options.sessionTerminationTimeoutMs ??
    MEANTHIS_MCP_STDIO_BROKER_SESSION_TERMINATION_TIMEOUT_MS;
  if (
    !Number.isSafeInteger(sessionTerminationTimeoutMs) ||
    sessionTerminationTimeoutMs < 1 ||
    sessionTerminationTimeoutMs > 30_000
  ) {
    throw brokerUnavailable();
  }

  const readToken = options.readToken ?? readVerifiedLocalBridgeMcpHttpToken;
  const readDesiredBuildHash = options.readDesiredBuildHash ??
    readVerifiedLocalBridgeMcpHttpDesiredIdentity;
  const verifyDaemon = options.verifyDaemon ?? verifyLocalBridgeMcpStdioBrokerDaemon;
  const ensureOwners = options.ensureOwners ?? ensureInstalledLocalBridgeOwners;
  let bearerToken: string;
  let desiredBuildHash: string;
  try {
    bearerToken = await readToken();
    if (!validateLocalBridgeMcpHttpToken(bearerToken)) throw brokerUnavailable();
    let verifiedBuildHash: string | undefined;
    try {
      const currentDesiredBuildHash = await readDesiredBuildHash();
      if (!/^[0-9a-f]{64}$/.test(currentDesiredBuildHash)) throw brokerUnavailable();
      await verifyDaemon(bearerToken, currentDesiredBuildHash);
      verifiedBuildHash = currentDesiredBuildHash;
    } catch {
      // The authenticated fast path is intentionally tried first so every
      // Codex task can cheaply reuse the singleton owner. Only an unavailable
      // or stale daemon enters the bounded, credential-preserving start path.
    }
    if (!verifiedBuildHash) {
      await ensureOwners(bearerToken);
      verifiedBuildHash = await readDesiredBuildHash();
      if (!/^[0-9a-f]{64}$/.test(verifiedBuildHash)) throw brokerUnavailable();
      await verifyDaemon(bearerToken, verifiedBuildHash);
    }
    desiredBuildHash = verifiedBuildHash;
    const [finalDesiredBuildHash, finalBearerToken] = await Promise.all([
      readDesiredBuildHash(),
      readToken(),
    ]);
    if (
      finalDesiredBuildHash !== desiredBuildHash ||
      !equalVerifiedBearerTokens(finalBearerToken, bearerToken)
    ) throw brokerUnavailable();
  } catch {
    throw brokerUnavailable();
  }

  const stdioInput = options.stdin ?? process.stdin;
  const stdioOutput = options.stdout ?? process.stdout;
  const ownedStdioOutput = options.createStdioTransport === undefined && options.stdout === undefined;
  const workerStdioWriter = ownedStdioOutput
    ? new WorkerThreadStdioWriter(MEANTHIS_MCP_STDIO_WRITER_STARTUP_TIMEOUT_MS)
    : undefined;
  const stdioTransport = options.createStdioTransport?.() ?? new BoundedStdioServerTransport(
    stdioInput,
    workerStdioWriter ?? new WritableStdioWriter(stdioOutput),
  );
  const createHttpTransport = (): BrokerHttpTransport =>
    options.createHttpTransport?.({
      url: new URL(MEANTHIS_MCP_STDIO_BROKER_URL),
      bearerToken,
    }) ?? new StreamableHTTPClientTransport(
      new URL(MEANTHIS_MCP_STDIO_BROKER_URL),
      {
        requestInit: { headers: { authorization: `Bearer ${bearerToken}` } },
        fetch: createLocalBridgeMcpHttpControlAwareFetch(),
      },
    );
  const prepareReconnect = async (): Promise<void> => {
    const [candidateBuildHash, candidateToken] = await Promise.all([
      readDesiredBuildHash(),
      readToken(),
    ]);
    if (
      candidateBuildHash !== desiredBuildHash ||
      !equalVerifiedBearerTokens(candidateToken, bearerToken)
    ) throw brokerUnavailable();
    try {
      await verifyDaemon(bearerToken, desiredBuildHash);
    } catch {
      await ensureOwners(bearerToken);
      await verifyDaemon(bearerToken, desiredBuildHash);
    }
    const [finalBuildHash, finalToken] = await Promise.all([
      readDesiredBuildHash(),
      readToken(),
    ]);
    if (
      finalBuildHash !== desiredBuildHash ||
      !equalVerifiedBearerTokens(finalToken, bearerToken)
    ) throw brokerUnavailable();
  };
  const httpTransport = new RecoveringBrokerHttpTransport({
    initialTransport: createHttpTransport(),
    createTransport: createHttpTransport,
    prepareReconnect,
    reconnectTimeoutMs: MEANTHIS_MCP_STDIO_BROKER_RECONNECT_TIMEOUT_MS,
  });
  const inputLifecycle = options.inputLifecycle ?? stdioInput;
  const signalLifecycle = options.signalLifecycle ?? process;

  return connectBrokerTransports({
    stdioTransport,
    httpTransport,
    inputLifecycle,
    signalLifecycle,
    sessionTerminationTimeoutMs,
    workerStdioWriter,
    forceProcessExitOnBlockedOwnedOutput,
  });
}

export async function runLocalBridgeMcpStdioBroker(
  options: LocalBridgeMcpStdioBrokerOptions = {},
): Promise<void> {
  const broker = await startLocalBridgeMcpStdioBroker(options);
  await broker.closed;
}

export async function runLocalBridgeMcpStdioBrokerDirectEntry(
  args: readonly string[] = process.argv.slice(2),
  options: LocalBridgeMcpStdioBrokerOptions = {},
): Promise<void> {
  removeInheritedBearer(options.environment ?? process.env);
  if (args.length !== 0) throw brokerUnavailable();
  const broker = await startLocalBridgeMcpStdioBrokerInternal(options, true);
  await broker.closed;
}

export function isLocalBridgeMcpStdioBrokerDirectEntry(
  entryPath: string | undefined = process.argv[1],
  moduleUrl = import.meta.url,
): boolean {
  if (!entryPath) return false;
  try {
    return pathToFileURL(resolve(entryPath)).href === moduleUrl;
  } catch {
    return false;
  }
}

async function connectBrokerTransports(input: {
  stdioTransport: Transport;
  httpTransport: BrokerHttpTransport;
  inputLifecycle: BrokerLifecycleSource;
  signalLifecycle: BrokerLifecycleSource;
  sessionTerminationTimeoutMs: number;
  workerStdioWriter?: WorkerThreadStdioWriter;
  forceProcessExitOnBlockedOwnedOutput: boolean;
}): Promise<LocalBridgeMcpStdioBroker> {
  const {
    stdioTransport,
    httpTransport,
    inputLifecycle,
    signalLifecycle,
    sessionTerminationTimeoutMs,
    workerStdioWriter,
    forceProcessExitOnBlockedOwnedOutput,
  } = input;
  const pendingInitialize = new Set<string>();
  const pendingToolsList = new Set<string>();
  const pendingClientRequests = new Set<string>();
  const pendingServerRequests = new Set<string>();
  const cancelledClientRequestTombstones = new Map<string, string | null>();
  const cancelledServerRequestTombstones = new Map<string, string | null>();
  const clientAliasesByOriginalKey = new Map<string, BrokerRequestIdAlias>();
  const clientAliasesByAlias = new Map<string, BrokerRequestIdAlias>();
  const serverAliasesByOriginalKey = new Map<string, BrokerRequestIdAlias>();
  const serverAliasesByAlias = new Map<string, BrokerRequestIdAlias>();
  const aliasSessionId = randomUUID();
  const clientAliasPrefix = `meanthis-stdio-client-request-${aliasSessionId}-`;
  const serverAliasPrefix = `meanthis-stdio-server-request-${aliasSessionId}-`;
  let nextClientAlias = 0;
  let nextServerAlias = 0;
  const pendingDownstreamSends = new Set<Promise<void>>();
  let activeUpstreamSends = 0;
  let activeClientRequestSends = 0;
  let activeControlSends = 0;
  let activeDownstreamSends = 0;
  let activeDownstreamControlSends = 0;
  let closing = false;
  let closePromise: Promise<void> | undefined;
  let resolveClosed!: () => void;
  let rejectClosed!: (error: Error) => void;
  const closed = new Promise<void>((resolveClosedPromise, rejectClosedPromise) => {
    resolveClosed = resolveClosedPromise;
    rejectClosed = rejectClosedPromise;
  });
  void closed.catch(() => undefined);
  if (httpTransport instanceof RecoveringBrokerHttpTransport) {
    httpTransport.setRecoveryGuard(() =>
      !closing && pendingInitialize.size === 0 && pendingServerRequests.size === 0 &&
      pendingClientRequests.size === activeClientRequestSends
    );
    httpTransport.setReplayGuard((message) => {
      const request = messageRequest(message);
      if (!request) return false;
      const alias = typeof request.id === "string"
        ? clientAliasesByAlias.get(request.id)
        : undefined;
      return pendingClientRequests.has(alias?.originalKey ?? requestIdKey(request.id));
    });
  }

  const removeLifecycleListeners = () => {
    inputLifecycle.off("end", onInputEnd);
    inputLifecycle.off("close", onInputEnd);
    signalLifecycle.off("SIGINT", onSignal);
    signalLifecycle.off("SIGTERM", onSignal);
  };

  const clearRequestTracking = () => {
    pendingInitialize.clear();
    pendingToolsList.clear();
    pendingClientRequests.clear();
    pendingServerRequests.clear();
    cancelledClientRequestTombstones.clear();
    cancelledServerRequestTombstones.clear();
    clientAliasesByOriginalKey.clear();
    clientAliasesByAlias.clear();
    serverAliasesByOriginalKey.clear();
    serverAliasesByAlias.clear();
  };

  const beginClose = (failed: boolean): Promise<void> => {
    if (closePromise) return closePromise;
    closing = true;
    removeLifecycleListeners();
    clearRequestTracking();
    closePromise = (async () => {
      if (httpTransport.terminateSession) {
        await settleWithin(
          Promise.resolve().then(() => httpTransport.terminateSession!()),
          sessionTerminationTimeoutMs,
        );
      }
      const pendingDownstreamSettlement = Promise.allSettled([
        ...pendingDownstreamSends,
      ]).then(() => undefined);
      await settleWithin(Promise.allSettled([
        Promise.resolve().then(() => httpTransport.close()),
        Promise.resolve().then(() => stdioTransport.close()),
        pendingDownstreamSettlement,
      ]).then(() => undefined), sessionTerminationTimeoutMs);
      const workerClosed = workerStdioWriter
        ? await settlesWithin(workerStdioWriter.close(), sessionTerminationTimeoutMs)
        : true;
      if (failed) {
        const error = brokerUnavailable();
        rejectClosed(error);
        if (!workerClosed && forceProcessExitOnBlockedOwnedOutput) {
          scheduleForcedBrokerProcessExit();
        }
        throw error;
      }
      resolveClosed();
      if (!workerClosed && forceProcessExitOnBlockedOwnedOutput) {
        scheduleForcedBrokerProcessExit();
      }
    })();
    void closePromise.catch(() => undefined);
    return closePromise;
  };

  const fail = (): void => {
    void beginClose(true);
  };

  const rejectToolSurface = async (message: JSONRPCMessage): Promise<void> => {
    const id = messageResponseId(message);
    if (id !== undefined) {
      await settleWithin(
        Promise.resolve().then(() => stdioTransport.send({
          jsonrpc: "2.0",
          id,
          error: { code: -32603, message: MEANTHIS_MCP_STDIO_BROKER_TOOL_ERROR_MESSAGE },
        })),
        sessionTerminationTimeoutMs,
      );
    }
    await beginClose(true).catch(() => undefined);
  };

  stdioTransport.onmessage = (message) => {
    if (closing) return;
    let upstreamMessage: JSONRPCMessage = message;
    const isControlMessage = isLocalBridgeMcpHttpControlMessage(message);
    const cancelledRequestId = isControlMessage
      ? exactCancelledRequestId(message)
      : undefined;
    const request = messageRequest(message);
    const responseId = messageResponseId(message);
    if (request) {
      const key = requestIdKey(request.id);
      if (
        isRequestIdAlias(request.id, clientAliasPrefix) ||
        !reservePendingClientRequest(
          key,
          pendingClientRequests,
          cancelledClientRequestTombstones,
        )
      ) {
        fail();
        return;
      }
      if (request.method === "initialize" && !reserveSpecialPendingRequest(
        key,
        pendingInitialize,
        MEANTHIS_MCP_STDIO_BROKER_MAX_PENDING_INITIALIZE,
      )) {
        pendingClientRequests.delete(key);
        fail();
        return;
      }
      if (request.method === "tools/list" && !reserveSpecialPendingRequest(
        key,
        pendingToolsList,
        MEANTHIS_MCP_STDIO_BROKER_MAX_PENDING_TOOLS_LIST,
      )) {
        pendingClientRequests.delete(key);
        fail();
        return;
      }
      if (isFalsyRequestId(request.id)) {
        const alias = allocateRequestIdAlias(clientAliasPrefix, nextClientAlias);
        if (!alias) {
          pendingInitialize.delete(key);
          pendingToolsList.delete(key);
          pendingClientRequests.delete(key);
          fail();
          return;
        }
        nextClientAlias += 1;
        const record = { alias, originalId: request.id, originalKey: key };
        clientAliasesByOriginalKey.set(key, record);
        clientAliasesByAlias.set(alias, record);
        upstreamMessage = replaceMessageId(message, alias);
      }
    } else if (responseId !== undefined) {
      const aliasedRequest = typeof responseId === "string"
        ? serverAliasesByAlias.get(responseId)
        : undefined;
      if (!aliasedRequest && isRequestIdAlias(responseId, serverAliasPrefix)) return;
      const originalResponseId = aliasedRequest?.originalId ?? responseId;
      const key = aliasedRequest?.originalKey ?? requestIdKey(originalResponseId);
      if (cancelledServerRequestTombstones.has(key)) return;
      if (isFalsyRequestId(responseId) && serverAliasesByOriginalKey.has(key)) {
        fail();
        return;
      }
      if (!pendingServerRequests.delete(key)) {
        fail();
        return;
      }
      if (aliasedRequest) {
        deleteRequestIdAlias(
          aliasedRequest,
          serverAliasesByOriginalKey,
          serverAliasesByAlias,
        );
        upstreamMessage = replaceMessageId(message, aliasedRequest.originalId);
      }
    } else if (cancelledRequestId !== undefined) {
      const key = requestIdKey(cancelledRequestId);
      const aliasedRequest = clientAliasesByOriginalKey.get(key);
      if (!pendingClientRequests.delete(key)) return;
      pendingInitialize.delete(key);
      pendingToolsList.delete(key);
      if (isFalsyRequestId(cancelledRequestId) && !aliasedRequest) {
        fail();
        return;
      }
      if (!reserveCancelledRequestTombstone(
        key,
        aliasedRequest?.alias ?? null,
        cancelledClientRequestTombstones,
      )) {
        fail();
        return;
      }
      if (aliasedRequest) {
        deleteRequestIdAlias(
          aliasedRequest,
          clientAliasesByOriginalKey,
          clientAliasesByAlias,
        );
        upstreamMessage = replaceCancelledRequestId(message, aliasedRequest.alias);
      }
    }
    if (
      isControlMessage
        ? activeControlSends >= MEANTHIS_MCP_STDIO_BROKER_MAX_ACTIVE_CONTROL_SENDS
        : activeUpstreamSends >= MEANTHIS_MCP_STDIO_BROKER_MAX_ACTIVE_UPSTREAM_SENDS
    ) {
      fail();
      return;
    }
    if (isControlMessage) activeControlSends += 1;
    else {
      activeUpstreamSends += 1;
      if (request) activeClientRequestSends += 1;
    }
    const releaseSend = () => {
      if (isControlMessage) activeControlSends -= 1;
      else {
        activeUpstreamSends -= 1;
        if (request) activeClientRequestSends -= 1;
      }
    };
    try {
      void httpTransport.send(upstreamMessage).then(
        releaseSend,
        () => {
          releaseSend();
          fail();
        },
      );
    } catch {
      releaseSend();
      fail();
    }
  };
  stdioTransport.onerror = fail;
  stdioTransport.onclose = () => {
    if (!closing) void beginClose(false);
  };

  httpTransport.onmessage = (message) => {
    if (closing) return;
    let downstreamMessage: JSONRPCMessage = message;
    const isHttpControlMessage = isLocalBridgeMcpHttpControlMessage(message);
    const cancelledRequestId = isHttpControlMessage
      ? exactCancelledRequestId(message)
      : undefined;
    const request = messageRequest(message);
    if (request) {
      const key = requestIdKey(request.id);
      if (
        isRequestIdAlias(request.id, serverAliasPrefix) ||
        !reservePendingServerRequest(
          key,
          pendingServerRequests,
          cancelledServerRequestTombstones,
        )
      ) {
        fail();
        return;
      }
      if (isFalsyRequestId(request.id)) {
        const alias = allocateRequestIdAlias(serverAliasPrefix, nextServerAlias);
        if (!alias) {
          pendingServerRequests.delete(key);
          fail();
          return;
        }
        nextServerAlias += 1;
        const record = { alias, originalId: request.id, originalKey: key };
        serverAliasesByOriginalKey.set(key, record);
        serverAliasesByAlias.set(alias, record);
        downstreamMessage = replaceMessageId(message, alias);
      }
    } else if (cancelledRequestId !== undefined) {
      const key = requestIdKey(cancelledRequestId);
      const aliasedRequest = serverAliasesByOriginalKey.get(key);
      if (!pendingServerRequests.delete(key)) return;
      if (isFalsyRequestId(cancelledRequestId) && !aliasedRequest) {
        fail();
        return;
      }
      if (!reserveCancelledRequestTombstone(
        key,
        aliasedRequest?.alias ?? null,
        cancelledServerRequestTombstones,
      )) {
        fail();
        return;
      }
      if (aliasedRequest) {
        deleteRequestIdAlias(
          aliasedRequest,
          serverAliasesByOriginalKey,
          serverAliasesByAlias,
        );
        downstreamMessage = replaceCancelledRequestId(message, aliasedRequest.alias);
      }
    }
    const id = messageResponseId(message);
    if (id !== undefined) {
      const aliasedRequest = typeof id === "string"
        ? clientAliasesByAlias.get(id)
        : undefined;
      if (!aliasedRequest && isRequestIdAlias(id, clientAliasPrefix)) return;
      const originalResponseId = aliasedRequest?.originalId ?? id;
      const key = aliasedRequest?.originalKey ?? requestIdKey(originalResponseId);
      if (cancelledClientRequestTombstones.has(key)) return;
      if (isFalsyRequestId(id) && clientAliasesByOriginalKey.has(key)) {
        fail();
        return;
      }
      if (!pendingClientRequests.delete(key)) {
        fail();
        return;
      }
      if (aliasedRequest) {
        deleteRequestIdAlias(
          aliasedRequest,
          clientAliasesByOriginalKey,
          clientAliasesByAlias,
        );
        downstreamMessage = replaceMessageId(message, aliasedRequest.originalId);
      }
      if (pendingInitialize.delete(key)) {
        const protocolVersion = initializeProtocolVersion(message);
        if (!protocolVersion || !httpTransport.setProtocolVersion) {
          fail();
          return;
        }
        httpTransport.setProtocolVersion(protocolVersion);
      }
      if (pendingToolsList.delete(key) && !hasExactToolSurface(message)) {
        void rejectToolSurface(downstreamMessage);
        return;
      }
    }
    const isControlMessage = request !== null || (
      id === undefined && isHttpControlMessage
    );
    if (
      isControlMessage
        ? activeDownstreamControlSends >= MEANTHIS_MCP_STDIO_BROKER_MAX_ACTIVE_CONTROL_SENDS
        : activeDownstreamSends >= MEANTHIS_MCP_STDIO_BROKER_MAX_ACTIVE_UPSTREAM_SENDS
    ) {
      fail();
      return;
    }
    if (isControlMessage) activeDownstreamControlSends += 1;
    else activeDownstreamSends += 1;
    const releaseSend = () => {
      if (isControlMessage) activeDownstreamControlSends -= 1;
      else activeDownstreamSends -= 1;
    };
    let sendPromise: Promise<void> | undefined;
    try {
      sendPromise = stdioTransport.send(downstreamMessage);
      pendingDownstreamSends.add(sendPromise);
      void sendPromise.then(
        () => {
          pendingDownstreamSends.delete(sendPromise!);
          releaseSend();
        },
        () => {
          pendingDownstreamSends.delete(sendPromise!);
          releaseSend();
          fail();
        },
      );
    } catch {
      if (sendPromise) pendingDownstreamSends.delete(sendPromise);
      releaseSend();
      fail();
    }
  };
  httpTransport.onerror = fail;
  httpTransport.onclose = () => {
    if (!closing) fail();
  };

  function onInputEnd(): void {
    if (!closing) void beginClose(false);
  }

  function onSignal(): void {
    if (!closing) void beginClose(false);
  }

  inputLifecycle.once("end", onInputEnd);
  inputLifecycle.once("close", onInputEnd);
  signalLifecycle.once("SIGINT", onSignal);
  signalLifecycle.once("SIGTERM", onSignal);

  try {
    await httpTransport.start();
    if (!closing) await stdioTransport.start();
  } catch {
    await beginClose(true).catch(() => undefined);
    throw brokerUnavailable();
  }

  return {
    closed,
    close: () => beginClose(false),
  };
}

async function readBoundedHealthBody(response: Response): Promise<string> {
  const contentLength = response.headers.get("content-length");
  if (
    contentLength !== null &&
    (!/^\d+$/.test(contentLength) || Number(contentLength) > MEANTHIS_MCP_STDIO_BROKER_MAX_HEALTH_BYTES)
  ) {
    await response.body?.cancel().catch(() => undefined);
    throw brokerUnavailable();
  }
  if (!response.body) throw brokerUnavailable();
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      totalBytes += value.byteLength;
      if (totalBytes > MEANTHIS_MCP_STDIO_BROKER_MAX_HEALTH_BYTES) {
        await reader.cancel().catch(() => undefined);
        throw brokerUnavailable();
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks).toString("utf8");
}

function removeInheritedBearer(environment: NodeJS.ProcessEnv): void {
  try {
    const tokenEnvironmentName = MEANTHIS_MCP_HTTP_TOKEN_ENV.toUpperCase();
    for (const name of Object.keys(environment)) {
      if (name.toUpperCase() === tokenEnvironmentName) delete environment[name];
    }
  } catch {
    throw brokerUnavailable();
  }
  if (Object.keys(environment).some(
    (name) => name.toUpperCase() === MEANTHIS_MCP_HTTP_TOKEN_ENV.toUpperCase(),
  )) throw brokerUnavailable();
}

function equalVerifiedBearerTokens(left: string, right: string): boolean {
  if (!validateLocalBridgeMcpHttpToken(left) || !validateLocalBridgeMcpHttpToken(right)) {
    return false;
  }
  const leftBytes = Buffer.from(left, "utf8");
  const rightBytes = Buffer.from(right, "utf8");
  return leftBytes.length === rightBytes.length && timingSafeEqual(leftBytes, rightBytes);
}

function messageRequest(message: JSONRPCMessage): {
  id: string | number;
  method: string;
} | null {
  const record = message as Record<string, unknown>;
  return (typeof record.id === "string" || typeof record.id === "number") &&
    typeof record.method === "string"
    ? { id: record.id, method: record.method }
    : null;
}

function messageResponseId(message: JSONRPCMessage): string | number | undefined {
  const record = message as Record<string, unknown>;
  const id = record.id;
  return (record.method === undefined && (record.result !== undefined || record.error !== undefined)) &&
    (typeof id === "string" || typeof id === "number")
    ? id
    : undefined;
}

function exactCancelledRequestId(message: JSONRPCMessage): string | number | undefined {
  const record = message as Record<string, unknown>;
  if (record.method !== "notifications/cancelled") return undefined;
  const params = record.params;
  if (!isRecord(params)) return undefined;
  const requestId = params.requestId;
  return typeof requestId === "string" || typeof requestId === "number"
    ? requestId
    : undefined;
}

function replaceMessageId(
  message: JSONRPCMessage,
  id: string | number,
): JSONRPCMessage {
  return { ...(message as Record<string, unknown>), id } as JSONRPCMessage;
}

function replaceCancelledRequestId(
  message: JSONRPCMessage,
  requestId: string | number,
): JSONRPCMessage {
  const record = message as Record<string, unknown>;
  return {
    ...record,
    params: {
      ...(record.params as Record<string, unknown>),
      requestId,
    },
  } as unknown as JSONRPCMessage;
}

function requestIdKey(id: string | number): string {
  return typeof id === "string"
    ? `string:${createHash("sha256").update(id, "utf16le").digest("base64url")}`
    : `number:${String(id)}`;
}

function isFalsyRequestId(id: string | number): boolean {
  return id === 0 || id === "";
}

function allocateRequestIdAlias(prefix: string, generation: number): string | undefined {
  return Number.isSafeInteger(generation) && generation >= 0
    ? `${prefix}${generation}`
    : undefined;
}

function isRequestIdAlias(id: string | number, prefix: string): boolean {
  return typeof id === "string" && id.startsWith(prefix);
}

function deleteRequestIdAlias(
  record: BrokerRequestIdAlias,
  aliasesByOriginalKey: Map<string, BrokerRequestIdAlias>,
  aliasesByAlias: Map<string, BrokerRequestIdAlias>,
): void {
  if (aliasesByOriginalKey.get(record.originalKey) === record) {
    aliasesByOriginalKey.delete(record.originalKey);
  }
  if (aliasesByAlias.get(record.alias) === record) aliasesByAlias.delete(record.alias);
}

function reservePendingClientRequest(
  key: string,
  pendingClientRequests: Set<string>,
  cancelledClientRequestTombstones: Map<string, string | null>,
): boolean {
  if (
    pendingClientRequests.has(key) ||
    cancelledClientRequestTombstones.has(key) ||
    pendingClientRequests.size >= MEANTHIS_MCP_STDIO_BROKER_MAX_PENDING_CLIENT_REQUESTS
  ) return false;
  pendingClientRequests.add(key);
  return true;
}

function reservePendingServerRequest(
  key: string,
  pendingServerRequests: Set<string>,
  cancelledServerRequestTombstones: Map<string, string | null>,
): boolean {
  if (
    pendingServerRequests.has(key) ||
    cancelledServerRequestTombstones.has(key) ||
    pendingServerRequests.size >= MEANTHIS_MCP_STDIO_BROKER_MAX_PENDING_SERVER_REQUESTS
  ) return false;
  pendingServerRequests.add(key);
  return true;
}

function reserveCancelledRequestTombstone(
  key: string,
  alias: string | null,
  tombstones: Map<string, string | null>,
): boolean {
  if (
    tombstones.has(key) ||
    tombstones.size >= MEANTHIS_MCP_STDIO_BROKER_MAX_CANCELLED_REQUEST_TOMBSTONES
  ) return false;
  tombstones.set(key, alias);
  return true;
}

function reserveSpecialPendingRequest(
  key: string,
  pending: Set<string>,
  maxPending: number,
): boolean {
  if (pending.has(key) || pending.size >= maxPending) return false;
  pending.add(key);
  return true;
}

function isExactWriterReady(value: unknown): boolean {
  return isRecord(value) && hasExactOwnKeys(value, ["kind"]) && value.kind === "ready";
}

function isExactWriterAck(value: unknown, expectedId: number): boolean {
  return isRecord(value) &&
    hasExactOwnKeys(value, ["kind", "id"]) &&
    value.kind === "ack" &&
    value.id === expectedId;
}

function hasExactOwnKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const keys = Reflect.ownKeys(value);
  return keys.length === expected.length && expected.every((key) => keys.includes(key));
}

async function settleWithin(promise: Promise<unknown>, timeoutMs: number): Promise<void> {
  await settlesWithin(promise, timeoutMs);
}

async function settlesWithin(promise: Promise<unknown>, timeoutMs: number): Promise<boolean> {
  let timeout: NodeJS.Timeout | undefined;
  const settled = await Promise.race([
    promise.then(() => true, () => true),
    new Promise<false>((resolve) => {
      timeout = setTimeout(() => resolve(false), timeoutMs);
    }),
  ]);
  if (timeout) clearTimeout(timeout);
  return settled;
}

function scheduleForcedBrokerProcessExit(): void {
  setImmediate(() => {
    try {
      process.kill(process.pid, "SIGKILL");
    } catch {
      process.abort();
    }
  });
}

function initializeProtocolVersion(message: JSONRPCMessage): string | null {
  const record = message as Record<string, unknown>;
  if (!isRecord(record.result)) return null;
  const version = record.result.protocolVersion;
  return typeof version === "string" && version.length > 0 && version.length <= 64
    ? version
    : null;
}

function hasExactToolSurface(message: JSONRPCMessage): boolean {
  const record = message as Record<string, unknown>;
  if (!isRecord(record.result) || !Array.isArray(record.result.tools)) return false;
  const names = record.result.tools.map((tool) => isRecord(tool) ? tool.name : undefined);
  return names.length === EXPECTED_TOOL_NAMES.length &&
    names.every((name, index) => name === EXPECTED_TOOL_NAMES[index]) &&
    record.result.nextCursor === undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isFatalBrokerHttpError(value: unknown): boolean {
  if (!isRecord(value)) return false;
  return value.code === 401 || value.code === 403;
}

function brokerUnavailable(): LocalBridgeMcpStdioBrokerError {
  return new LocalBridgeMcpStdioBrokerError();
}

if (isLocalBridgeMcpStdioBrokerDirectEntry()) {
  try {
    await runLocalBridgeMcpStdioBrokerDirectEntry();
  } catch {
    try {
      delete process.env[MEANTHIS_MCP_HTTP_TOKEN_ENV];
    } catch {
      // The direct entry still emits only the generic, secret-free error below.
    }
    process.stderr.write(`${JSON.stringify({
      schemaVersion: "0.1.0",
      kind: "ui-attach.error",
      ok: false,
      error: {
        code: "MCP_STDIO_BROKER_UNAVAILABLE",
        message: MEANTHIS_MCP_STDIO_BROKER_ERROR_MESSAGE,
      },
    })}\n`);
    process.exitCode = 1;
  }
}
