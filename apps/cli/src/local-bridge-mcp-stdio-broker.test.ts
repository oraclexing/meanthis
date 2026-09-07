import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { Protocol } from "@modelcontextprotocol/sdk/shared/protocol.js";
import {
  CallToolRequestSchema,
  ListRootsRequestSchema,
  type JSONRPCMessage,
  type Notification,
  type Request,
  type Result,
} from "@modelcontextprotocol/sdk/types.js";
import {
  createSourceContentHash,
  createSourceMapSidecar,
} from "@meanthis/source-map-core";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { EventEmitter } from "node:events";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { PassThrough, type Readable, Writable } from "node:stream";
import { fileURLToPath, pathToFileURL } from "node:url";
import { runInNewContext } from "node:vm";
import { describe, expect, test, vi } from "vitest";
import {
  MEANTHIS_MCP_HTTP_HEALTH_NONCE_HEADER,
  MEANTHIS_MCP_HTTP_HEALTH_PROOF_HEADER,
  MEANTHIS_MCP_HTTP_HEALTH_TIMESTAMP_HEADER,
  createLocalBridgeMcpHttpHealthProofResponse,
} from "./local-bridge-mcp-http-health-proof.js";
import { createLocalBridgeMcpHttpControlAwareFetch } from "./local-bridge-mcp-http-control.js";
import { startLocalBridgeMcpHttpServer } from "./local-bridge-mcp-http.js";
import { MEANTHIS_MCP_HTTP_TOKEN_ENV } from "./local-bridge-mcp-http-token.js";
import { createLocalBridgeState } from "./local-bridge.js";
import {
  MEANTHIS_MCP_STDIO_BROKER_MAX_FRAME_BYTES,
  MEANTHIS_MCP_STDIO_BROKER_URL,
  MEANTHIS_MCP_STDIO_WRITER_WORKER_SOURCE,
  type LocalBridgeMcpStdioBrokerOptions,
  isLocalBridgeMcpStdioBrokerDirectEntry,
  runLocalBridgeMcpStdioBrokerDirectEntry,
  startLocalBridgeMcpStdioBroker as startLocalBridgeMcpStdioBrokerImplementation,
  verifyLocalBridgeMcpStdioBrokerDaemon,
} from "./local-bridge-mcp-stdio-broker.js";

const TOKEN = Buffer.alloc(32, 7).toString("base64url");
const ROTATED_TOKEN = Buffer.alloc(32, 8).toString("base64url");
const EXPECTED_BUILD_HASH = "a".repeat(64);
const EXPECTED_TOOLS = [
  "meanthis_list_captures",
  "meanthis_read_capture",
  "meanthis_ack_capture_read",
  "meanthis_wait_capture_change",
  "meanthis_resolve_source",
];

function startLocalBridgeMcpStdioBroker(options: LocalBridgeMcpStdioBrokerOptions = {}) {
  return startLocalBridgeMcpStdioBrokerImplementation({
    ensureOwners: async () => undefined,
    ...options,
  });
}

class TestSdkProtocol extends Protocol<Request, Notification, Result> {
  protected override assertCapabilityForMethod(_method: Request["method"]): void {}
  protected override assertNotificationCapability(_method: Notification["method"]): void {}
  protected override assertRequestHandlerCapability(_method: string): void {}
  protected override assertTaskCapability(_method: string): void {}
  protected override assertTaskHandlerCapability(_method: string): void {}
}

class FakeTransport implements Transport {
  readonly sent: JSONRPCMessage[] = [];
  readonly protocolVersions: string[] = [];
  startCount = 0;
  closeCount = 0;
  onclose?: () => void;
  onerror?: (error: Error) => void;
  onmessage?: Transport["onmessage"];

  async start(): Promise<void> {
    this.startCount += 1;
  }

  async send(message: JSONRPCMessage): Promise<void> {
    this.sent.push(structuredClone(message));
  }

  async close(): Promise<void> {
    this.closeCount += 1;
    this.onclose?.();
  }

  setProtocolVersion(version: string): void {
    this.protocolVersions.push(version);
  }

  emitMessage(message: JSONRPCMessage): void {
    this.onmessage?.(message);
  }

  emitError(error: Error): void {
    this.onerror?.(error);
  }

  emitClose(): void {
    this.onclose?.();
  }
}

class FakeHttpTransport extends FakeTransport {
  terminateSessionCount = 0;

  async terminateSession(): Promise<void> {
    this.terminateSessionCount += 1;
  }
}

class FailingOnceHttpTransport extends FakeHttpTransport {
  failNextSend = false;

  constructor(private readonly failureCode = 404) {
    super();
  }

  override async send(message: JSONRPCMessage): Promise<void> {
    if (!this.failNextSend) return super.send(message);
    this.failNextSend = false;
    const error = Object.assign(new Error("owner session was replaced"), {
      code: this.failureCode,
    });
    this.onerror?.(error);
    throw error;
  }
}

class HangingTerminateHttpTransport extends FakeHttpTransport {
  override async terminateSession(): Promise<void> {
    this.terminateSessionCount += 1;
    await new Promise<void>(() => undefined);
  }
}

class DeferredStartHttpTransport extends FakeHttpTransport {
  private releaseStartPromise: (() => void) | undefined;

  override async start(): Promise<void> {
    this.startCount += 1;
    await new Promise<void>((resolvePromise) => {
      this.releaseStartPromise = resolvePromise;
    });
  }

  releaseStart(): void {
    this.releaseStartPromise?.();
  }
}

class HangingSendTransport extends FakeTransport {
  override async send(message: JSONRPCMessage): Promise<void> {
    this.sent.push(structuredClone(message));
    await new Promise<void>(() => undefined);
  }
}

class NeverDrainingWritable extends Writable {
  constructor() {
    super({ highWaterMark: 1 });
  }

  override _write(
    _chunk: Buffer,
    _encoding: BufferEncoding,
    _callback: (error?: Error | null) => void,
  ): void {
    // The host deliberately keeps its write pending and never emits drain.
  }
}

class NestedRootsHttpTransport extends FakeHttpTransport {
  private releaseToolCall: (() => void) | undefined;

  override async send(message: JSONRPCMessage): Promise<void> {
    this.sent.push(structuredClone(message));
    const record = message as Record<string, unknown>;
    if (record.method === "tools/call" && record.id === "nested-tool") {
      this.emitMessage({
        jsonrpc: "2.0",
        id: "nested-roots",
        method: "roots/list",
      });
      await new Promise<void>((resolve) => { this.releaseToolCall = resolve; });
      this.emitMessage({
        jsonrpc: "2.0",
        id: "nested-tool",
        result: { content: [{ type: "text", text: "done" }] },
      });
      return;
    }
    if (record.id === "nested-roots" && isRecord(record.result)) {
      this.releaseToolCall?.();
    }
  }
}

function createBrokerHarness() {
  const environment: NodeJS.ProcessEnv = {
    [MEANTHIS_MCP_HTTP_TOKEN_ENV]: "inherited-token-must-not-be-used",
  };
  const downstream = new FakeTransport();
  const upstream = new FakeHttpTransport();
  const inputLifecycle = new EventEmitter();
  const signalLifecycle = new EventEmitter();
  const readToken = vi.fn(async () => {
    expect(environment[MEANTHIS_MCP_HTTP_TOKEN_ENV]).toBeUndefined();
    return TOKEN;
  });
  const readDesiredBuildHash = vi.fn(async () => EXPECTED_BUILD_HASH);
  const ensureOwners = vi.fn(async (token: string) => {
    expect(token).toBe(TOKEN);
  });
  const verifyDaemon = vi.fn(async (token: string, expectedBuildHash: string) => {
    expect(token).toBe(TOKEN);
    expect(expectedBuildHash).toBe(EXPECTED_BUILD_HASH);
  });
  const createHttpTransport = vi.fn((input: { url: URL; bearerToken: string }) => {
    expect(input.url.href).toBe(MEANTHIS_MCP_STDIO_BROKER_URL);
    expect(input.bearerToken).toBe(TOKEN);
    return upstream;
  });

  return {
    environment,
    downstream,
    upstream,
    inputLifecycle,
    signalLifecycle,
    readToken,
    readDesiredBuildHash,
    ensureOwners,
    verifyDaemon,
    createHttpTransport,
    async start() {
      return startLocalBridgeMcpStdioBroker({
        environment,
        readToken,
        readDesiredBuildHash,
        ensureOwners,
        verifyDaemon,
        createStdioTransport: () => downstream,
        createHttpTransport,
        inputLifecycle,
        signalLifecycle,
      });
    },
  };
}

async function waitForSent(transport: FakeTransport, count: number): Promise<void> {
  await vi.waitFor(() => expect(transport.sent).toHaveLength(count));
}

async function initializeReconnectHarness(
  downstream: FakeTransport,
  upstream: FakeHttpTransport,
): Promise<void> {
  downstream.emitMessage({
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: {} },
  });
  await waitForSent(upstream, 1);
  upstream.emitMessage({
    jsonrpc: "2.0",
    id: 1,
    result: {
      protocolVersion: "2025-11-25",
      capabilities: { tools: {} },
      serverInfo: { name: "meanthis", version: "0.1.0" },
    },
  });
  await waitForSent(downstream, 1);
  downstream.emitMessage({ jsonrpc: "2.0", method: "notifications/initialized" });
  await waitForSent(upstream, 2);
}

async function settleTestPromise<T>(
  promise: Promise<T>,
  label: string,
  timeoutMs = 2_000,
): Promise<T> {
  let timeout: NodeJS.Timeout | undefined;
  return Promise.race([
    promise,
    new Promise<never>((_resolve, rejectPromise) => {
      timeout = setTimeout(() => rejectPromise(new Error(label)), timeoutMs);
    }),
  ]).finally(() => {
    if (timeout) clearTimeout(timeout);
  });
}

async function createBrokerSourceFixture(marker: string, componentName: string) {
  const root = await mkdtemp(join(tmpdir(), `meanthis-stdio-http-${marker.toLowerCase()}-`));
  const source = `export function ${componentName}() {}\n`;
  const sourcePath = join(root, "src", `${componentName}.tsx`);
  const buildId = marker.repeat(43);
  const sourceId = marker.toLowerCase().repeat(43);
  const sidecar = createSourceMapSidecar(buildId, [{
    sourceId,
    path: `src/${componentName}.tsx`,
    line: 1,
    column: 8,
    tagName: "button",
    componentName,
    contentHash: createSourceContentHash(source),
  }]);
  const sidecarPath = join(root, ".ui-attach", "source-map.json");
  await mkdir(dirname(sourcePath), { recursive: true });
  await mkdir(dirname(sidecarPath), { recursive: true });
  await writeFile(sourcePath, source);
  await writeFile(sidecarPath, `${JSON.stringify(sidecar)}\n`);
  return {
    root,
    anchor: {
      schemaVersion: "0.1.0" as const,
      kind: "ui-attach.opaque-source-anchor" as const,
      buildId,
      sourceId,
    },
  };
}

async function waitForStreamText(
  stream: Readable,
  marker: string,
  timeoutMs = 5_000,
): Promise<void> {
  await new Promise<void>((resolvePromise, rejectPromise) => {
    let text = "";
    const timeout = setTimeout(() => {
      cleanup();
      rejectPromise(new Error(`Timed out waiting for child marker ${marker}: ${text}`));
    }, timeoutMs);
    const onData = (chunk: Buffer | string) => {
      text += chunk.toString();
      if (text.includes(marker)) {
        cleanup();
        resolvePromise();
      }
    };
    const onClose = () => {
      cleanup();
      rejectPromise(new Error(`Child stream closed before marker ${marker}: ${text}`));
    };
    const cleanup = () => {
      clearTimeout(timeout);
      stream.off("data", onData);
      stream.off("close", onClose);
    };
    stream.on("data", onData);
    stream.once("close", onClose);
  });
}

async function waitForStreamByteCount(
  stream: Readable,
  byte: number,
  expectedCount: number,
  timeoutMs = 5_000,
): Promise<void> {
  await new Promise<void>((resolvePromise, rejectPromise) => {
    let count = 0;
    const timeout = setTimeout(() => {
      cleanup();
      rejectPromise(new Error(`Timed out after observing ${count}/${expectedCount} output frames.`));
    }, timeoutMs);
    const onData = (chunk: Buffer | string) => {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      for (const value of bytes) if (value === byte) count += 1;
      if (count >= expectedCount) {
        cleanup();
        resolvePromise();
      }
    };
    const onClose = () => {
      cleanup();
      rejectPromise(new Error(`Child output closed after ${count}/${expectedCount} frames.`));
    };
    const cleanup = () => {
      clearTimeout(timeout);
      stream.off("data", onData);
      stream.off("close", onClose);
    };
    stream.on("data", onData);
    stream.once("close", onClose);
  });
}

async function waitForChildExit(
  child: ChildProcessWithoutNullStreams,
  timeoutMs: number,
): Promise<{ code: number | null; signal: NodeJS.Signals | null }> {
  if (child.exitCode !== null || child.signalCode !== null) {
    return { code: child.exitCode, signal: child.signalCode };
  }
  return new Promise((resolvePromise, rejectPromise) => {
    const timeout = setTimeout(() => {
      cleanup();
      rejectPromise(new Error(`Broker child did not exit within ${timeoutMs}ms.`));
    }, timeoutMs);
    const onExit = (code: number | null, signal: NodeJS.Signals | null) => {
      cleanup();
      resolvePromise({ code, signal });
    };
    const onError = (error: Error) => {
      cleanup();
      rejectPromise(error);
    };
    const cleanup = () => {
      clearTimeout(timeout);
      child.off("exit", onExit);
      child.off("error", onError);
    };
    child.once("exit", onExit);
    child.once("error", onError);
  });
}

describe("MeanThis thin stdio MCP broker", () => {
  function createWriterWorkerHarness(write: (bytes: Buffer, offset: number, length: number) => number) {
    const parentPort = new EventEmitter() as EventEmitter & { postMessage: ReturnType<typeof vi.fn> };
    parentPort.postMessage = vi.fn();
    let now = 0;
    const wait = vi.fn((_array: Int32Array, _index: number, _value: number, timeout: number) => {
      now += timeout;
      return "timed-out";
    });
    runInNewContext(MEANTHIS_MCP_STDIO_WRITER_WORKER_SOURCE, {
      Buffer, Int32Array, SharedArrayBuffer,
      Atomics: { wait },
      require: (specifier: string) => {
        if (specifier === "node:fs") return {
          writeSync: (fd: number, bytes: Buffer, offset: number, length: number) => {
            expect(fd).toBe(1);
            return write(bytes, offset, length);
          },
        };
        if (specifier === "node:worker_threads") return { parentPort };
        if (specifier === "node:perf_hooks") return { performance: { now: () => now } };
        throw new Error(`Unexpected worker import: ${specifier}`);
      },
    });
    expect(parentPort.postMessage.mock.calls).toEqual([[{ kind: "ready" }]]);
    parentPort.postMessage.mockClear();
    return { parentPort, wait, advance: (milliseconds: number) => { now += milliseconds; } };
  }

  test.each(["EAGAIN", "EWOULDBLOCK", "EINTR"])(
    "retries worker %s without repeating or truncating a partial UTF-8 frame",
    (code) => {
      const frame = `${JSON.stringify({ id: 7, result: "你好🙂" })}\n`;
      const chunks: Buffer[] = [];
      let attempts = 0;
      const worker = createWriterWorkerHarness((bytes, offset, length) => {
        attempts += 1;
        if (attempts === 2) throw Object.assign(new Error("temporary"), { code });
        expect(offset).toBe(attempts === 1 ? 0 : 2);
        const written = attempts === 1 ? 2 : length;
        chunks.push(Buffer.from(bytes.subarray(offset, offset + written)));
        return written;
      });
      worker.parentPort.emit("message", { kind: "frame", id: 7, frame });
      expect(Buffer.concat(chunks)).toEqual(Buffer.from(frame));
      expect(worker.wait).toHaveBeenCalledTimes(1);
      expect(worker.parentPort.postMessage.mock.calls).toEqual([[{ kind: "ack", id: 7 }]]);
    },
  );

  test("bounds worker retries when the output makes no progress", () => {
    let attempts = 0;
    const worker = createWriterWorkerHarness(() => {
      attempts += 1;
      throw Object.assign(new Error("temporary"), { code: "EAGAIN" });
    });
    expect(() => worker.parentPort.emit("message", { kind: "frame", id: 1, frame: "x\n" }))
      .toThrow("writer stalled");
    expect(attempts).toBeGreaterThan(1);
    expect(attempts).toBeLessThanOrEqual(6_001);
    expect(worker.wait).toHaveBeenCalled();
    expect(worker.parentPort.postMessage).not.toHaveBeenCalled();
  });

  test("resets the worker no-progress deadline only after a positive write", () => {
    let attempts = 0;
    const worker = createWriterWorkerHarness(() => {
      attempts += 1;
      if (attempts % 2 === 1) {
        worker.advance(20_000);
        throw Object.assign(new Error("temporary"), { code: "EINTR" });
      }
      return 1;
    });
    worker.parentPort.emit("message", { kind: "frame", id: 2, frame: "ab" });
    expect(attempts).toBe(4);
    expect(worker.parentPort.postMessage.mock.calls).toEqual([[{ kind: "ack", id: 2 }]]);
  });

  test.each(["EPIPE", 0, -1, 3, 0.5])("fails the worker without acknowledgement for %s", (failure) => {
    const worker = createWriterWorkerHarness(() => {
      if (typeof failure === "string") throw Object.assign(new Error("closed pipe"), { code: failure });
      return failure;
    });
    expect(() => worker.parentPort.emit("message", { kind: "frame", id: 1, frame: "x\n" })).toThrow();
    expect(worker.wait).not.toHaveBeenCalled();
    expect(worker.parentPort.postMessage).not.toHaveBeenCalled();
  });

  test("ensures the shared owners before verifying and connecting to the daemon", async () => {
    const order: string[] = [];
    const downstream = new FakeTransport();
    const upstream = new FakeHttpTransport();
    const broker = await startLocalBridgeMcpStdioBroker({
      environment: {},
      readToken: async () => {
        order.push("read-token");
        return TOKEN;
      },
      ensureOwners: async (token) => {
        expect(token).toBe(TOKEN);
        order.push("ensure-owners");
      },
      readDesiredBuildHash: async () => {
        order.push("read-desired-build");
        return EXPECTED_BUILD_HASH;
      },
      verifyDaemon: async (token, expectedBuildHash) => {
        expect(token).toBe(TOKEN);
        expect(expectedBuildHash).toBe(EXPECTED_BUILD_HASH);
        order.push("verify-daemon");
        if (order.filter((entry) => entry === "verify-daemon").length === 1) {
          throw new Error("daemon is not running");
        }
      },
      createStdioTransport: () => downstream,
      createHttpTransport: () => upstream,
      inputLifecycle: new EventEmitter(),
      signalLifecycle: new EventEmitter(),
    });

    try {
      expect(order).toEqual([
        "read-token",
        "read-desired-build",
        "verify-daemon",
        "ensure-owners",
        "read-desired-build",
        "verify-daemon",
        "read-desired-build",
        "read-token",
      ]);
      expect(downstream.startCount).toBe(1);
      expect(upstream.startCount).toBe(1);
    } finally {
      await broker.close();
    }
  });

  test("fails closed before creating transports when owner startup is unavailable", async () => {
    const createStdioTransport = vi.fn(() => new FakeTransport());
    const createHttpTransport = vi.fn(() => new FakeHttpTransport());

    await expect(startLocalBridgeMcpStdioBroker({
      environment: {},
      readToken: async () => TOKEN,
      ensureOwners: async () => {
        throw new Error(`startup failed ${TOKEN}`);
      },
      readDesiredBuildHash: async () => EXPECTED_BUILD_HASH,
      verifyDaemon: async () => {
        throw new Error("daemon is not running");
      },
      createStdioTransport,
      createHttpTransport,
      inputLifecycle: new EventEmitter(),
      signalLifecycle: new EventEmitter(),
    })).rejects.toThrow("MeanThis MCP stdio broker unavailable.");
    expect(createStdioTransport).not.toHaveBeenCalled();
    expect(createHttpTransport).not.toHaveBeenCalled();
  });

  test("forwards initialize, roots, server requests, notifications, and concurrent IDs transparently", async () => {
    const harness = createBrokerHarness();
    const broker = await harness.start();

    try {
      expect(harness.environment[MEANTHIS_MCP_HTTP_TOKEN_ENV]).toBeUndefined();
      expect(harness.readToken).toHaveBeenCalledTimes(2);
      expect(harness.ensureOwners).not.toHaveBeenCalled();
      expect(harness.verifyDaemon).toHaveBeenCalledOnce();
      expect(harness.downstream.startCount).toBe(1);
      expect(harness.upstream.startCount).toBe(1);

      const initialize = {
        jsonrpc: "2.0" as const,
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2025-11-25",
          capabilities: { roots: { listChanged: true } },
          clientInfo: { name: "codex", version: "1.0.0" },
        },
      };
      harness.downstream.emitMessage(initialize);
      await waitForSent(harness.upstream, 1);
      expect(harness.upstream.sent[0]).toEqual(initialize);

      const initialized = {
        jsonrpc: "2.0" as const,
        id: 1,
        result: {
          protocolVersion: "2025-11-25",
          capabilities: { tools: {} },
          serverInfo: { name: "meanthis", version: "0.1.0" },
        },
      };
      harness.upstream.emitMessage(initialized);
      await waitForSent(harness.downstream, 1);
      expect(harness.upstream.protocolVersions).toEqual(["2025-11-25"]);
      expect(harness.downstream.sent[0]).toEqual(initialized);

      const initializedNotification = {
        jsonrpc: "2.0" as const,
        method: "notifications/initialized",
      };
      harness.downstream.emitMessage(initializedNotification);
      await waitForSent(harness.upstream, 2);
      expect(harness.upstream.sent[1]).toEqual(initializedNotification);

      const rootsRequest = {
        jsonrpc: "2.0" as const,
        id: "roots-1",
        method: "roots/list",
      };
      harness.upstream.emitMessage(rootsRequest);
      await waitForSent(harness.downstream, 2);
      expect(harness.downstream.sent[1]).toEqual(rootsRequest);

      const rootsResponse = {
        jsonrpc: "2.0" as const,
        id: "roots-1",
        result: { roots: [{ uri: "file:///D:/workspace", name: "workspace" }] },
      };
      harness.downstream.emitMessage(rootsResponse);
      await waitForSent(harness.upstream, 3);
      expect(harness.upstream.sent[2]).toEqual(rootsResponse);

      const rootsChanged = {
        jsonrpc: "2.0" as const,
        method: "notifications/roots/list_changed",
      };
      harness.downstream.emitMessage(rootsChanged);
      await waitForSent(harness.upstream, 4);
      expect(harness.upstream.sent[3]).toEqual(rootsChanged);

      const serverNotification = {
        jsonrpc: "2.0" as const,
        method: "notifications/tools/list_changed",
      };
      harness.upstream.emitMessage(serverNotification);
      await waitForSent(harness.downstream, 3);
      expect(harness.downstream.sent[2]).toEqual(serverNotification);

      const firstCall = {
        jsonrpc: "2.0" as const,
        id: 10,
        method: "tools/call",
        params: { name: "meanthis_list_captures", arguments: {} },
      };
      const secondCall = {
        jsonrpc: "2.0" as const,
        id: 11,
        method: "tools/call",
        params: { name: "meanthis_list_captures", arguments: {} },
      };
      harness.downstream.emitMessage(firstCall);
      harness.downstream.emitMessage(secondCall);
      await waitForSent(harness.upstream, 6);
      expect(harness.upstream.sent.slice(4)).toEqual([firstCall, secondCall]);

      const secondResult = { jsonrpc: "2.0" as const, id: 11, result: { content: [] } };
      const firstResult = { jsonrpc: "2.0" as const, id: 10, result: { content: [] } };
      harness.upstream.emitMessage(secondResult);
      harness.upstream.emitMessage(firstResult);
      await waitForSent(harness.downstream, 5);
      expect(harness.downstream.sent.slice(3)).toEqual([secondResult, firstResult]);
    } finally {
      await broker.close();
      await expect(broker.closed).resolves.toBeUndefined();
    }
  });

  test("forwards only an exact five-tool list", async () => {
    const harness = createBrokerHarness();
    const broker = await harness.start();

    try {
      const listRequest = { jsonrpc: "2.0" as const, id: "tools", method: "tools/list" };
      const listResponse = {
        jsonrpc: "2.0" as const,
        id: "tools",
        result: { tools: EXPECTED_TOOLS.map((name) => ({ name, inputSchema: { type: "object" } })) },
      };
      harness.downstream.emitMessage(listRequest);
      await waitForSent(harness.upstream, 1);
      harness.upstream.emitMessage(listResponse);
      await waitForSent(harness.downstream, 1);
      expect(harness.downstream.sent[0]).toEqual(listResponse);
    } finally {
      await broker.close();
    }
  });

  test("preserves SDK newline framing through the bounded default stdio transport", async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    const upstream = new FakeHttpTransport();
    let outputText = "";
    output.setEncoding("utf8");
    output.on("data", (chunk: string) => { outputText += chunk; });
    const broker = await startLocalBridgeMcpStdioBroker({
      environment: {},
      readToken: async () => TOKEN,
      readDesiredBuildHash: async () => EXPECTED_BUILD_HASH,
      verifyDaemon: async () => undefined,
      createHttpTransport: () => upstream,
      signalLifecycle: new EventEmitter(),
      stdin: input,
      stdout: output,
      sessionTerminationTimeoutMs: 10,
    });

    try {
      const request = {
        jsonrpc: "2.0" as const,
        id: "real-stdio",
        method: "tools/call",
        params: { name: "meanthis_list_captures", arguments: {} },
      };
      input.write(`${JSON.stringify(request)}\r\n`);
      await waitForSent(upstream, 1);
      expect(upstream.sent[0]).toEqual(request);

      const response = {
        jsonrpc: "2.0" as const,
        id: "real-stdio",
        result: { content: [{ type: "text", text: "ok" }] },
      };
      upstream.emitMessage(response);
      await vi.waitFor(() => expect(outputText).toBe(`${JSON.stringify(response)}\n`));

      input.end();
      await expect(broker.closed).resolves.toBeUndefined();
      expect(output.destroyed).toBe(false);
    } finally {
      input.destroy();
      output.destroy();
      await broker.close().catch(() => undefined);
    }
  });

  test("bounds outbound UTF-8 frames before they enter the stdio writer queue", async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    const upstream = new FakeHttpTransport();
    let outputText = "";
    output.setEncoding("utf8");
    output.on("data", (chunk: string) => { outputText += chunk; });
    const broker = await startLocalBridgeMcpStdioBroker({
      environment: {},
      readToken: async () => TOKEN,
      readDesiredBuildHash: async () => EXPECTED_BUILD_HASH,
      verifyDaemon: async () => undefined,
      createHttpTransport: () => upstream,
      signalLifecycle: new EventEmitter(),
      stdin: input,
      stdout: output,
      sessionTerminationTimeoutMs: 10,
    });

    const paddedNotification = (targetBytes: number, includePrivate = false): JSONRPCMessage => {
      const message = {
        jsonrpc: "2.0" as const,
        method: "notifications/test",
        params: { padding: "", ...(includePrivate ? { private: TOKEN } : {}) },
      };
      const base = JSON.stringify(message);
      message.params.padding = "x".repeat(targetBytes - Buffer.byteLength(base));
      expect(Buffer.byteLength(JSON.stringify(message))).toBe(targetBytes);
      return message;
    };

    try {
      const maximumFrame = paddedNotification(MEANTHIS_MCP_STDIO_BROKER_MAX_FRAME_BYTES);
      upstream.emitMessage(maximumFrame);
      await vi.waitFor(() => {
        expect(Buffer.byteLength(outputText)).toBe(MEANTHIS_MCP_STDIO_BROKER_MAX_FRAME_BYTES + 1);
      });

      const oversizedFrame = paddedNotification(
        MEANTHIS_MCP_STDIO_BROKER_MAX_FRAME_BYTES + 1,
        true,
      );
      upstream.emitMessage(oversizedFrame);
      await expect(broker.closed).rejects.toThrow("MeanThis MCP stdio broker unavailable.");
      await expect(broker.closed).rejects.not.toThrow(TOKEN);
      expect(outputText).toBe(`${JSON.stringify(maximumFrame)}\n`);
      expect(outputText).not.toContain(TOKEN);
      expect(upstream.terminateSessionCount).toBe(1);
      expect(upstream.closeCount).toBe(1);
    } finally {
      input.destroy();
      output.destroy();
      await broker.close().catch(() => undefined);
    }
  });

  test("parses multiple frames in one chunk and a UTF-8 code point split across chunks", async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    output.resume();
    const upstream = new FakeHttpTransport();
    const broker = await startLocalBridgeMcpStdioBroker({
      environment: {},
      readToken: async () => TOKEN,
      readDesiredBuildHash: async () => EXPECTED_BUILD_HASH,
      verifyDaemon: async () => undefined,
      createHttpTransport: () => upstream,
      signalLifecycle: new EventEmitter(),
      stdin: input,
      stdout: output,
      sessionTerminationTimeoutMs: 10,
    });

    try {
      const requests = [
        {
          jsonrpc: "2.0" as const,
          id: "same-chunk-1",
          method: "tools/call",
          params: { name: "meanthis_list_captures", arguments: {} },
        },
        {
          jsonrpc: "2.0" as const,
          id: "same-chunk-2",
          method: "tools/call",
          params: { name: "meanthis_read_capture", arguments: {} },
        },
        {
          jsonrpc: "2.0" as const,
          id: "split-utf8",
          method: "tools/call",
          params: { name: "meanthis_resolve_source", arguments: { note: "界" } },
        },
      ];
      input.write(`${JSON.stringify(requests[0])}\n${JSON.stringify(requests[1])}\n`);

      const splitFrame = Buffer.from(JSON.stringify(requests[2]), "utf8");
      const multibyteStart = splitFrame.indexOf(Buffer.from("界", "utf8"));
      expect(multibyteStart).toBeGreaterThanOrEqual(0);
      input.write(splitFrame.subarray(0, multibyteStart + 1));
      input.write(Buffer.concat([splitFrame.subarray(multibyteStart + 1), Buffer.from("\n")]));

      await waitForSent(upstream, 3);
      expect(upstream.sent).toEqual(requests);
      input.end();
      await expect(broker.closed).resolves.toBeUndefined();
    } finally {
      input.destroy();
      output.destroy();
      await broker.close().catch(() => undefined);
    }
  });

  test("accepts a one-MiB JSON payload with CR and LF split across chunks", async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    output.resume();
    const upstream = new FakeHttpTransport();
    const inputLifecycle = new EventEmitter();
    const broker = await startLocalBridgeMcpStdioBroker({
      environment: {},
      readToken: async () => TOKEN,
      readDesiredBuildHash: async () => EXPECTED_BUILD_HASH,
      verifyDaemon: async () => undefined,
      createHttpTransport: () => upstream,
      inputLifecycle,
      signalLifecycle: new EventEmitter(),
      stdin: input,
      stdout: output,
      sessionTerminationTimeoutMs: 10,
    });

    try {
      const request = {
        jsonrpc: "2.0" as const,
        id: "max-frame",
        method: "tools/call",
        params: { name: "meanthis_resolve_source", arguments: { padding: "" } },
      };
      const baseFrame = JSON.stringify(request);
      request.params.arguments.padding = "x".repeat(
        MEANTHIS_MCP_STDIO_BROKER_MAX_FRAME_BYTES - Buffer.byteLength(baseFrame),
      );
      const frame = JSON.stringify(request);
      expect(Buffer.byteLength(frame)).toBe(MEANTHIS_MCP_STDIO_BROKER_MAX_FRAME_BYTES);

      input.write(frame);
      input.write("\r");
      input.write("\n");
      await waitForSent(upstream, 1);
      expect(upstream.sent[0]).toEqual(request);
    } finally {
      inputLifecycle.emit("end");
      await broker.closed.catch(() => undefined);
      input.destroy();
      output.destroy();
    }
  });

  test("fails closed on an unterminated stdio frame above the HTTP request byte limit", async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    let outputText = "";
    output.setEncoding("utf8");
    output.on("data", (chunk: string) => { outputText += chunk; });
    const upstream = new FakeHttpTransport();
    const broker = await startLocalBridgeMcpStdioBroker({
      environment: {},
      readToken: async () => TOKEN,
      readDesiredBuildHash: async () => EXPECTED_BUILD_HASH,
      verifyDaemon: async () => undefined,
      createHttpTransport: () => upstream,
      inputLifecycle: new EventEmitter(),
      signalLifecycle: new EventEmitter(),
      stdin: input,
      stdout: output,
      sessionTerminationTimeoutMs: 10,
    });

    try {
      const privatePrefix = Buffer.from(`{"private":"${TOKEN}","padding":"`, "utf8");
      input.write(Buffer.concat([
        privatePrefix,
        Buffer.alloc(
          MEANTHIS_MCP_STDIO_BROKER_MAX_FRAME_BYTES + 1 - privatePrefix.length,
          0x78,
        ),
      ]));

      await expect(broker.closed).rejects.toThrow("MeanThis MCP stdio broker unavailable.");
      await expect(broker.closed).rejects.not.toThrow(TOKEN);
      expect(upstream.sent).toEqual([]);
      expect(upstream.terminateSessionCount).toBe(1);
      expect(upstream.closeCount).toBe(1);
      expect(outputText).toBe("");
      expect(input.listenerCount("data")).toBe(0);
    } finally {
      input.destroy();
      output.destroy();
      await broker.close().catch(() => undefined);
    }
  });

  test.each([
    ["invalid UTF-8", Buffer.concat([
      Buffer.from('{"jsonrpc":"2.0","id":"invalid-utf8","method":"tools/list","params":{"value":"'),
      Buffer.from([0xc3, 0x28]),
      Buffer.from('"}}\n'),
    ])],
    ["an empty frame", Buffer.from("\n")],
    ["a UTF-8 BOM before JSON", Buffer.concat([
      Buffer.from([0xef, 0xbb, 0xbf]),
      Buffer.from('{"jsonrpc":"2.0","id":"bom","method":"tools/list"}\n'),
    ])],
  ] as const)("fails closed generically on %s", async (_label, frame) => {
    const input = new PassThrough();
    const output = new PassThrough();
    let outputText = "";
    output.setEncoding("utf8");
    output.on("data", (chunk: string) => { outputText += chunk; });
    const upstream = new FakeHttpTransport();
    const broker = await startLocalBridgeMcpStdioBroker({
      environment: {},
      readToken: async () => TOKEN,
      readDesiredBuildHash: async () => EXPECTED_BUILD_HASH,
      verifyDaemon: async () => undefined,
      createHttpTransport: () => upstream,
      inputLifecycle: new EventEmitter(),
      signalLifecycle: new EventEmitter(),
      stdin: input,
      stdout: output,
      sessionTerminationTimeoutMs: 10,
    });

    try {
      input.write(frame);
      await expect(broker.closed).rejects.toThrow("MeanThis MCP stdio broker unavailable.");
      await expect(broker.closed).rejects.not.toThrow(TOKEN);
      expect(upstream.sent).toEqual([]);
      expect(outputText).toBe("");
      expect(outputText).not.toContain("�");
    } finally {
      input.destroy();
      output.destroy();
      await broker.close().catch(() => undefined);
    }
  });

  test("discards a partial final frame on EOF without forwarding or echoing it", async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    let outputText = "";
    output.setEncoding("utf8");
    output.on("data", (chunk: string) => { outputText += chunk; });
    const upstream = new FakeHttpTransport();
    const broker = await startLocalBridgeMcpStdioBroker({
      environment: {},
      readToken: async () => TOKEN,
      readDesiredBuildHash: async () => EXPECTED_BUILD_HASH,
      verifyDaemon: async () => undefined,
      createHttpTransport: () => upstream,
      signalLifecycle: new EventEmitter(),
      stdin: input,
      stdout: output,
      sessionTerminationTimeoutMs: 10,
    });

    try {
      input.end(`{"jsonrpc":"2.0","id":"partial","private":"${TOKEN}`);
      await expect(broker.closed).resolves.toBeUndefined();
      expect(upstream.sent).toEqual([]);
      expect(outputText).toBe("");
      expect(input.listenerCount("data")).toBe(0);
    } finally {
      input.destroy();
      output.destroy();
      await broker.close().catch(() => undefined);
    }
  });

  test("keeps bidirectional request ID namespaces independent", async () => {
    const harness = createBrokerHarness();
    const broker = await harness.start();

    try {
      harness.downstream.emitMessage({ jsonrpc: "2.0", id: "shared-id", method: "tools/list" });
      await waitForSent(harness.upstream, 1);
      const collidingServerRequest = {
        jsonrpc: "2.0" as const,
        id: "shared-id",
        method: "roots/list",
      };
      harness.upstream.emitMessage(collidingServerRequest);
      await waitForSent(harness.downstream, 1);
      expect(harness.downstream.sent[0]).toEqual(collidingServerRequest);

      harness.upstream.emitMessage({
        jsonrpc: "2.0",
        id: "shared-id",
        result: { tools: EXPECTED_TOOLS.map((name) => ({ name, inputSchema: { type: "object" } })) },
      });
      await waitForSent(harness.downstream, 2);
      expect(harness.downstream.sent[1]).toMatchObject({ id: "shared-id", result: { tools: expect.any(Array) } });
    } finally {
      await broker.close();
    }
  });

  test("does not serialize a nested roots response behind its pending tool call", async () => {
    const environment: NodeJS.ProcessEnv = {};
    const downstream = new FakeTransport();
    const upstream = new NestedRootsHttpTransport();
    const broker = await startLocalBridgeMcpStdioBroker({
      environment,
      readToken: async () => TOKEN,
      readDesiredBuildHash: async () => EXPECTED_BUILD_HASH,
      verifyDaemon: async () => undefined,
      createStdioTransport: () => downstream,
      createHttpTransport: () => upstream,
      inputLifecycle: new EventEmitter(),
      signalLifecycle: new EventEmitter(),
    });

    try {
      downstream.emitMessage({
        jsonrpc: "2.0",
        id: "nested-tool",
        method: "tools/call",
        params: { name: "meanthis_resolve_source", arguments: {} },
      });
      await waitForSent(downstream, 1);
      expect(downstream.sent[0]).toMatchObject({ id: "nested-roots", method: "roots/list" });

      downstream.emitMessage({
        jsonrpc: "2.0",
        id: "nested-roots",
        result: { roots: [{ uri: "file:///D:/workspace" }] },
      });
      await waitForSent(downstream, 2);
      expect(downstream.sent[1]).toMatchObject({ id: "nested-tool" });
      expect(upstream.sent.map((message) => (message as Record<string, unknown>).id)).toEqual([
        "nested-tool",
        "nested-roots",
      ]);
    } finally {
      await broker.close();
    }
  });

  test("reconnects the same-build HTTP owner without closing the task stdio transport", async () => {
    const environment: NodeJS.ProcessEnv = {};
    const downstream = new FakeTransport();
    const firstUpstream = new FakeHttpTransport();
    const replacementUpstream = new FakeHttpTransport();
    const upstreams = [firstUpstream, replacementUpstream];
    const createHttpTransport = vi.fn(() => {
      const next = upstreams.shift();
      if (!next) throw new Error("unexpected extra HTTP transport");
      return next;
    });
    const broker = await startLocalBridgeMcpStdioBroker({
      environment,
      readToken: async () => TOKEN,
      readDesiredBuildHash: async () => EXPECTED_BUILD_HASH,
      verifyDaemon: async () => undefined,
      createStdioTransport: () => downstream,
      createHttpTransport,
      inputLifecycle: new EventEmitter(),
      signalLifecycle: new EventEmitter(),
    });

    try {
      downstream.emitMessage({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2025-11-25",
          capabilities: {},
          clientInfo: { name: "codex", version: "1.0.0" },
        },
      });
      await waitForSent(firstUpstream, 1);
      firstUpstream.emitMessage({
        jsonrpc: "2.0",
        id: 1,
        result: {
          protocolVersion: "2025-11-25",
          capabilities: { tools: {} },
          serverInfo: { name: "meanthis", version: "0.1.0" },
        },
      });
      await waitForSent(downstream, 1);
      downstream.emitMessage({ jsonrpc: "2.0", method: "notifications/initialized" });
      await waitForSent(firstUpstream, 2);

      firstUpstream.emitClose();
      await vi.waitFor(() => expect(replacementUpstream.startCount).toBe(1));
      await waitForSent(replacementUpstream, 1);
      const reconnectInitialize = replacementUpstream.sent[0] as Record<string, unknown>;
      expect(reconnectInitialize).toMatchObject({
        jsonrpc: "2.0",
        method: "initialize",
        params: {
          protocolVersion: "2025-11-25",
          clientInfo: { name: "codex", version: "1.0.0" },
        },
      });
      expect(reconnectInitialize.id).not.toBe(1);
      replacementUpstream.emitMessage({
        jsonrpc: "2.0",
        id: reconnectInitialize.id as string,
        result: {
          protocolVersion: "2025-11-25",
          capabilities: { tools: {} },
          serverInfo: { name: "meanthis", version: "0.1.0" },
        },
      });
      await waitForSent(replacementUpstream, 3);
      const reconnectToolsList = replacementUpstream.sent[2] as Record<string, unknown>;
      expect(replacementUpstream.sent[1]).toEqual({
        jsonrpc: "2.0",
        method: "notifications/initialized",
      });
      expect(reconnectToolsList).toMatchObject({ jsonrpc: "2.0", method: "tools/list" });
      replacementUpstream.emitMessage({
        jsonrpc: "2.0",
        id: reconnectToolsList.id as string,
        result: {
          tools: EXPECTED_TOOLS.map((name) => ({ name, inputSchema: { type: "object" } })),
        },
      });

      downstream.emitMessage({
        jsonrpc: "2.0",
        id: "after-owner-restart",
        method: "tools/call",
        params: { name: "meanthis_list_captures", arguments: {} },
      });
      await waitForSent(replacementUpstream, 4);
      replacementUpstream.emitMessage({
        jsonrpc: "2.0",
        id: "after-owner-restart",
        result: { content: [{ type: "text", text: "ok" }] },
      });
      await waitForSent(downstream, 2);

      expect(downstream.sent[1]).toMatchObject({
        id: "after-owner-restart",
        result: { content: [{ type: "text", text: "ok" }] },
      });
      expect(downstream.closeCount).toBe(0);
      expect(createHttpTransport).toHaveBeenCalledTimes(2);
    } finally {
      await broker.close().catch(() => undefined);
    }
  });

  test("replays one read request after the previous owner session rejects its POST", async () => {
    const downstream = new FakeTransport();
    const firstUpstream = new FailingOnceHttpTransport();
    const replacementUpstream = new FakeHttpTransport();
    const upstreams = [firstUpstream, replacementUpstream];
    const broker = await startLocalBridgeMcpStdioBroker({
      environment: {},
      readToken: async () => TOKEN,
      readDesiredBuildHash: async () => EXPECTED_BUILD_HASH,
      verifyDaemon: async () => undefined,
      createStdioTransport: () => downstream,
      createHttpTransport: () => {
        const next = upstreams.shift();
        if (!next) throw new Error("unexpected extra HTTP transport");
        return next;
      },
      inputLifecycle: new EventEmitter(),
      signalLifecycle: new EventEmitter(),
    });

    try {
      downstream.emitMessage({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2025-11-25",
          capabilities: {},
          clientInfo: { name: "codex", version: "1.0.0" },
        },
      });
      await waitForSent(firstUpstream, 1);
      firstUpstream.emitMessage({
        jsonrpc: "2.0",
        id: 1,
        result: {
          protocolVersion: "2025-11-25",
          capabilities: { tools: {} },
          serverInfo: { name: "meanthis", version: "0.1.0" },
        },
      });
      await waitForSent(downstream, 1);
      downstream.emitMessage({ jsonrpc: "2.0", method: "notifications/initialized" });
      await waitForSent(firstUpstream, 2);

      firstUpstream.failNextSend = true;
      downstream.emitMessage({
        jsonrpc: "2.0",
        id: "recover-this-read",
        method: "tools/call",
        params: { name: "meanthis_list_captures", arguments: {} },
      });
      await waitForSent(replacementUpstream, 1);
      const reconnectInitialize = replacementUpstream.sent[0] as Record<string, unknown>;
      replacementUpstream.emitMessage({
        jsonrpc: "2.0",
        id: reconnectInitialize.id as string,
        result: {
          protocolVersion: "2025-11-25",
          capabilities: { tools: {} },
          serverInfo: { name: "meanthis", version: "0.1.0" },
        },
      });
      await waitForSent(replacementUpstream, 3);
      const reconnectToolsList = replacementUpstream.sent[2] as Record<string, unknown>;
      replacementUpstream.emitMessage({
        jsonrpc: "2.0",
        id: reconnectToolsList.id as string,
        result: {
          tools: EXPECTED_TOOLS.map((name) => ({ name, inputSchema: { type: "object" } })),
        },
      });
      await waitForSent(replacementUpstream, 4);
      expect(replacementUpstream.sent[3]).toMatchObject({
        id: "recover-this-read",
        method: "tools/call",
      });
      replacementUpstream.emitMessage({
        jsonrpc: "2.0",
        id: "recover-this-read",
        result: { content: [{ type: "text", text: "recovered" }] },
      });
      await waitForSent(downstream, 2);
      expect(downstream.sent[1]).toMatchObject({
        id: "recover-this-read",
        result: { content: [{ type: "text", text: "recovered" }] },
      });
      expect(downstream.closeCount).toBe(0);
    } finally {
      await broker.close().catch(() => undefined);
    }
  });

  test("does not reconnect or expose credentials after an authenticated POST is rejected", async () => {
    const downstream = new FakeTransport();
    const upstream = new FailingOnceHttpTransport(401);
    const createHttpTransport = vi.fn(() => upstream);
    const broker = await startLocalBridgeMcpStdioBroker({
      environment: {},
      readToken: async () => TOKEN,
      readDesiredBuildHash: async () => EXPECTED_BUILD_HASH,
      verifyDaemon: async () => undefined,
      createStdioTransport: () => downstream,
      createHttpTransport,
      inputLifecycle: new EventEmitter(),
      signalLifecycle: new EventEmitter(),
    });
    await initializeReconnectHarness(downstream, upstream);

    upstream.failNextSend = true;
    downstream.emitMessage({
      jsonrpc: "2.0",
      id: "unauthorized-read",
      method: "tools/call",
      params: { name: "meanthis_list_captures", arguments: {} },
    });

    await expect(broker.closed).rejects.toThrow("MeanThis MCP stdio broker unavailable.");
    expect(createHttpTransport).toHaveBeenCalledOnce();
    expect(JSON.stringify(downstream.sent)).not.toContain(TOKEN);
  });

  test("fails closed instead of reconnecting across a desired-build change", async () => {
    const downstream = new FakeTransport();
    const upstream = new FakeHttpTransport();
    let desiredBuildHash = EXPECTED_BUILD_HASH;
    const createHttpTransport = vi.fn(() => upstream);
    const broker = await startLocalBridgeMcpStdioBroker({
      environment: {},
      readToken: async () => TOKEN,
      readDesiredBuildHash: async () => desiredBuildHash,
      verifyDaemon: async () => undefined,
      createStdioTransport: () => downstream,
      createHttpTransport,
      inputLifecycle: new EventEmitter(),
      signalLifecycle: new EventEmitter(),
    });

    downstream.emitMessage({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: {} },
    });
    await waitForSent(upstream, 1);
    upstream.emitMessage({
      jsonrpc: "2.0",
      id: 1,
      result: {
        protocolVersion: "2025-11-25",
        capabilities: { tools: {} },
        serverInfo: { name: "meanthis", version: "0.1.0" },
      },
    });
    await waitForSent(downstream, 1);
    downstream.emitMessage({ jsonrpc: "2.0", method: "notifications/initialized" });
    await waitForSent(upstream, 2);

    desiredBuildHash = "b".repeat(64);
    upstream.emitClose();

    await expect(broker.closed).rejects.toThrow("MeanThis MCP stdio broker unavailable.");
    expect(createHttpTransport).toHaveBeenCalledOnce();
    expect(downstream.closeCount).toBe(1);
  });

  test("fails closed when an accepted request loses its response during owner replacement", async () => {
    const downstream = new FakeTransport();
    const upstream = new FakeHttpTransport();
    const createHttpTransport = vi.fn(() => upstream);
    const broker = await startLocalBridgeMcpStdioBroker({
      environment: {},
      readToken: async () => TOKEN,
      readDesiredBuildHash: async () => EXPECTED_BUILD_HASH,
      verifyDaemon: async () => undefined,
      createStdioTransport: () => downstream,
      createHttpTransport,
      inputLifecycle: new EventEmitter(),
      signalLifecycle: new EventEmitter(),
    });

    downstream.emitMessage({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: {} },
    });
    await waitForSent(upstream, 1);
    upstream.emitMessage({
      jsonrpc: "2.0",
      id: 1,
      result: {
        protocolVersion: "2025-11-25",
        capabilities: { tools: {} },
        serverInfo: { name: "meanthis", version: "0.1.0" },
      },
    });
    await waitForSent(downstream, 1);
    downstream.emitMessage({ jsonrpc: "2.0", method: "notifications/initialized" });
    await waitForSent(upstream, 2);
    downstream.emitMessage({
      jsonrpc: "2.0",
      id: "accepted-without-response",
      method: "tools/call",
      params: { name: "meanthis_list_captures", arguments: {} },
    });
    await waitForSent(upstream, 3);
    await Promise.resolve();

    upstream.emitClose();

    await expect(broker.closed).rejects.toThrow("MeanThis MCP stdio broker unavailable.");
    expect(createHttpTransport).toHaveBeenCalledOnce();
    expect(downstream.closeCount).toBe(1);
  });

  test.each([
    ["duplicate", ["same", "same"]],
    ["bounded", Array.from({ length: 17 }, (_, index) => `tools-${index}`)],
  ] as const)("fails closed on %s pending tools/list IDs", async (_case, ids) => {
    const harness = createBrokerHarness();
    const broker = await harness.start();
    for (const id of ids) {
      harness.downstream.emitMessage({ jsonrpc: "2.0", id, method: "tools/list" });
    }

    await expect(broker.closed).rejects.toThrow("MeanThis MCP stdio broker unavailable.");
    expect(harness.upstream.sent.length).toBeLessThanOrEqual(16);
  });

  test("fails closed on more than one pending initialize request", async () => {
    const harness = createBrokerHarness();
    const broker = await harness.start();
    harness.downstream.emitMessage({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {},
    });
    harness.downstream.emitMessage({
      jsonrpc: "2.0",
      id: 2,
      method: "initialize",
      params: {},
    });

    await expect(broker.closed).rejects.toThrow("MeanThis MCP stdio broker unavailable.");
    expect(harness.upstream.sent).toHaveLength(1);
  });

  test("bounds all pending client requests and rejects duplicate ordinary request IDs", async () => {
    const harness = createBrokerHarness();
    const broker = await harness.start();
    try {
      for (let index = 0; index < 64; index += 1) {
        harness.downstream.emitMessage({
          jsonrpc: "2.0",
          id: `call-${index}`,
          method: "tools/call",
          params: { name: "meanthis_list_captures", arguments: {} },
        });
      }
      harness.downstream.emitMessage({
        jsonrpc: "2.0",
        id: "call-64",
        method: "tools/call",
        params: { name: "meanthis_list_captures", arguments: {} },
      });
      const outcome = await Promise.race([
        broker.closed.then(() => "closed", () => "failed"),
        new Promise<"timed_out">((resolve) => setTimeout(() => resolve("timed_out"), 100)),
      ]);
      expect(outcome).toBe("failed");
      expect(harness.upstream.sent).toHaveLength(64);
    } finally {
      await broker.close().catch(() => undefined);
    }

    const duplicateHarness = createBrokerHarness();
    const duplicateBroker = await duplicateHarness.start();
    try {
      const request = {
        jsonrpc: "2.0" as const,
        id: "duplicate-call",
        method: "tools/call",
        params: { name: "meanthis_list_captures", arguments: {} },
      };
      duplicateHarness.downstream.emitMessage(request);
      duplicateHarness.downstream.emitMessage(request);
      const outcome = await Promise.race([
        duplicateBroker.closed.then(() => "closed", () => "failed"),
        new Promise<"timed_out">((resolve) => setTimeout(() => resolve("timed_out"), 100)),
      ]);
      expect(outcome).toBe("failed");
      expect(duplicateHarness.upstream.sent).toHaveLength(1);
    } finally {
      await duplicateBroker.close().catch(() => undefined);
    }
  });

  test("releases the global pending request slot only after the matching response", async () => {
    const harness = createBrokerHarness();
    const broker = await harness.start();
    try {
      for (let index = 0; index < 64; index += 1) {
        harness.downstream.emitMessage({
          jsonrpc: "2.0",
          id: `call-${index}`,
          method: "tools/call",
          params: { name: "meanthis_list_captures", arguments: {} },
        });
      }
      await waitForSent(harness.upstream, 64);
      harness.upstream.emitMessage({ jsonrpc: "2.0", id: "call-0", result: { content: [] } });
      await waitForSent(harness.downstream, 1);
      harness.downstream.emitMessage({
        jsonrpc: "2.0",
        id: "call-64",
        method: "tools/call",
        params: { name: "meanthis_list_captures", arguments: {} },
      });
      await waitForSent(harness.upstream, 65);
    } finally {
      await broker.close();
    }
  });

  test("releases cancelled client request slots and drops late responses without closing the session", async () => {
    const harness = createBrokerHarness();
    const broker = await harness.start();
    try {
      for (let index = 0; index < 65; index += 1) {
        const id = `cancelled-${index}`;
        harness.downstream.emitMessage({
          jsonrpc: "2.0",
          id,
          method: "tools/call",
          params: { name: "meanthis_list_captures", arguments: {} },
        });
        expect(harness.upstream.sent).toHaveLength((index * 2) + 1);
        await Promise.resolve();
        harness.downstream.emitMessage({
          jsonrpc: "2.0",
          method: "notifications/cancelled",
          params: { requestId: id, reason: "host cancelled" },
        });
        expect(harness.upstream.sent).toHaveLength((index * 2) + 2);
        await Promise.resolve();
      }

      harness.upstream.emitMessage({
        jsonrpc: "2.0",
        id: "cancelled-0",
        result: { content: [{ type: "text", text: "late" }] },
      });
      harness.upstream.emitMessage({
        jsonrpc: "2.0",
        id: "cancelled-0",
        error: { code: -32603, message: "duplicate late response" },
      });
      expect(harness.downstream.sent).toHaveLength(0);

      harness.downstream.emitMessage({
        jsonrpc: "2.0",
        id: "after-cancellations",
        method: "tools/call",
        params: { name: "meanthis_list_captures", arguments: {} },
      });
      await waitForSent(harness.upstream, 131);
      harness.upstream.emitMessage({
        jsonrpc: "2.0",
        id: "after-cancellations",
        result: { content: [] },
      });
      await waitForSent(harness.downstream, 1);
    } finally {
      await broker.close().catch(() => undefined);
    }
  });

  test("tracks a large string request ID by fixed-size identity across cancellation", async () => {
    const harness = createBrokerHarness();
    const broker = await harness.start();
    const largeId = `large-${"x".repeat(512 * 1024)}`;
    try {
      harness.downstream.emitMessage({
        jsonrpc: "2.0",
        id: largeId,
        method: "tools/call",
        params: { name: "meanthis_list_captures", arguments: {} },
      });
      harness.downstream.emitMessage({
        jsonrpc: "2.0",
        method: "notifications/cancelled",
        params: { requestId: largeId },
      });
      await waitForSent(harness.upstream, 2);
      harness.upstream.emitMessage({
        jsonrpc: "2.0",
        id: largeId,
        result: { content: [{ type: "text", text: "late" }] },
      });
      expect(harness.downstream.sent).toHaveLength(0);

      harness.downstream.emitMessage({
        jsonrpc: "2.0",
        id: "after-large-id",
        method: "tools/call",
        params: { name: "meanthis_list_captures", arguments: {} },
      });
      await waitForSent(harness.upstream, 3);
    } finally {
      await broker.close().catch(() => undefined);
    }
  });

  test("keeps cancelled request IDs quarantined for the session and rejects their reuse", async () => {
    const harness = createBrokerHarness();
    const broker = await harness.start();
    try {
      harness.downstream.emitMessage({
        jsonrpc: "2.0",
        id: "reused",
        method: "tools/call",
        params: { name: "meanthis_list_captures", arguments: {} },
      });
      harness.downstream.emitMessage({
        jsonrpc: "2.0",
        method: "notifications/cancelled",
        params: { requestId: "reused" },
      });
      await waitForSent(harness.upstream, 2);

      harness.upstream.emitMessage({
        jsonrpc: "2.0",
        id: "reused",
        result: { content: [{ type: "text", text: "late" }] },
      });
      expect(harness.downstream.sent).toHaveLength(0);

      harness.downstream.emitMessage({
        jsonrpc: "2.0",
        id: "reused",
        method: "tools/call",
        params: { name: "meanthis_list_captures", arguments: {} },
      });
      await expect(broker.closed).rejects.toThrow("MeanThis MCP stdio broker unavailable.");
      expect(harness.upstream.sent).toHaveLength(2);
    } finally {
      await broker.close().catch(() => undefined);
    }
  });

  test("releases initialize and tools-list sub-reservations when their outer requests are cancelled", async () => {
    const harness = createBrokerHarness();
    const broker = await harness.start();
    try {
      harness.downstream.emitMessage({
        jsonrpc: "2.0",
        id: "initialize-cancelled",
        method: "initialize",
        params: {},
      });
      harness.downstream.emitMessage({
        jsonrpc: "2.0",
        method: "notifications/cancelled",
        params: { requestId: "initialize-cancelled" },
      });
      harness.downstream.emitMessage({
        jsonrpc: "2.0",
        id: "initialize-after-cancel",
        method: "initialize",
        params: {},
      });
      await waitForSent(harness.upstream, 3);

      harness.downstream.emitMessage({
        jsonrpc: "2.0",
        id: "tools-cancelled",
        method: "tools/list",
      });
      harness.downstream.emitMessage({
        jsonrpc: "2.0",
        method: "notifications/cancelled",
        params: { requestId: "tools-cancelled" },
      });
      harness.downstream.emitMessage({
        jsonrpc: "2.0",
        id: "tools-after-cancel",
        method: "tools/list",
      });
      await waitForSent(harness.upstream, 6);
    } finally {
      await broker.close().catch(() => undefined);
    }
  });

  test("fails closed instead of evicting a live cancelled-request tombstone", async () => {
    const harness = createBrokerHarness();
    const broker = await harness.start();
    try {
      for (let index = 0; index < 256; index += 1) {
        const id = `bounded-tombstone-${index}`;
        harness.downstream.emitMessage({
          jsonrpc: "2.0",
          id,
          method: "tools/call",
          params: { name: "meanthis_list_captures", arguments: {} },
        });
        expect(harness.upstream.sent).toHaveLength((index * 2) + 1);
        await Promise.resolve();
        harness.downstream.emitMessage({
          jsonrpc: "2.0",
          method: "notifications/cancelled",
          params: { requestId: id },
        });
        expect(harness.upstream.sent).toHaveLength((index * 2) + 2);
        await Promise.resolve();
      }

      harness.downstream.emitMessage({
        jsonrpc: "2.0",
        id: "bounded-tombstone-overflow",
        method: "tools/call",
        params: { name: "meanthis_list_captures", arguments: {} },
      });
      await waitForSent(harness.upstream, 513);
      harness.downstream.emitMessage({
        jsonrpc: "2.0",
        method: "notifications/cancelled",
        params: { requestId: "bounded-tombstone-overflow" },
      });

      await expect(broker.closed).rejects.toThrow("MeanThis MCP stdio broker unavailable.");
      expect(harness.upstream.sent).toHaveLength(513);
    } finally {
      await broker.close().catch(() => undefined);
    }
  });

  test("bounds nested server cancellation tombstones without evicting a live generation", async () => {
    const harness = createBrokerHarness();
    const broker = await harness.start();
    try {
      for (let index = 0; index < 256; index += 1) {
        const id = `bounded-server-tombstone-${index}`;
        harness.upstream.emitMessage({ jsonrpc: "2.0", id, method: "roots/list" });
        expect(harness.downstream.sent).toHaveLength((index * 2) + 1);
        await Promise.resolve();
        harness.upstream.emitMessage({
          jsonrpc: "2.0",
          method: "notifications/cancelled",
          params: { requestId: id },
        });
        expect(harness.downstream.sent).toHaveLength((index * 2) + 2);
        await Promise.resolve();
      }

      harness.upstream.emitMessage({
        jsonrpc: "2.0",
        id: "bounded-server-tombstone-overflow",
        method: "roots/list",
      });
      await waitForSent(harness.downstream, 513);
      harness.upstream.emitMessage({
        jsonrpc: "2.0",
        method: "notifications/cancelled",
        params: { requestId: "bounded-server-tombstone-overflow" },
      });

      await expect(broker.closed).rejects.toThrow("MeanThis MCP stdio broker unavailable.");
      expect(harness.downstream.sent).toHaveLength(513);
    } finally {
      await broker.close().catch(() => undefined);
    }
  });

  test("keeps cancelled client IDs separate from nested server and typed-ID namespaces", async () => {
    const harness = createBrokerHarness();
    const broker = await harness.start();
    try {
      harness.downstream.emitMessage({
        jsonrpc: "2.0",
        id: "shared",
        method: "tools/call",
        params: { name: "meanthis_list_captures", arguments: {} },
      });
      harness.upstream.emitMessage({ jsonrpc: "2.0", id: "shared", method: "roots/list" });
      harness.downstream.emitMessage({
        jsonrpc: "2.0",
        method: "notifications/cancelled",
        params: { requestId: "shared" },
      });
      harness.downstream.emitMessage({
        jsonrpc: "2.0",
        id: "shared",
        result: { roots: [{ uri: "file:///D:/workspace" }] },
      });
      await waitForSent(harness.upstream, 3);

      harness.upstream.emitMessage({
        jsonrpc: "2.0",
        id: "shared",
        result: { content: [{ type: "text", text: "late" }] },
      });
      expect(harness.downstream.sent).toEqual([
        { jsonrpc: "2.0", id: "shared", method: "roots/list" },
      ]);

      harness.downstream.emitMessage({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name: "meanthis_list_captures", arguments: {} },
      });
      harness.downstream.emitMessage({
        jsonrpc: "2.0",
        method: "notifications/cancelled",
        params: { requestId: 1 },
      });
      harness.downstream.emitMessage({
        jsonrpc: "2.0",
        id: "1",
        method: "tools/call",
        params: { name: "meanthis_list_captures", arguments: {} },
      });
      await waitForSent(harness.upstream, 6);
      harness.upstream.emitMessage({ jsonrpc: "2.0", id: "1", result: { content: [] } });
      await waitForSent(harness.downstream, 2);
    } finally {
      await broker.close().catch(() => undefined);
    }
  });

  test("releases cancelled nested server request slots and drops their late responses", async () => {
    const harness = createBrokerHarness();
    const broker = await harness.start();
    try {
      for (let index = 0; index < 17; index += 1) {
        const id = `cancelled-server-${index}`;
        harness.upstream.emitMessage({ jsonrpc: "2.0", id, method: "roots/list" });
        expect(harness.downstream.sent).toHaveLength((index * 2) + 1);
        await Promise.resolve();
        harness.upstream.emitMessage({
          jsonrpc: "2.0",
          method: "notifications/cancelled",
          params: { requestId: id, reason: "server cancelled" },
        });
        expect(harness.downstream.sent).toHaveLength((index * 2) + 2);
        await Promise.resolve();
      }

      harness.downstream.emitMessage({
        jsonrpc: "2.0",
        id: "cancelled-server-0",
        result: { roots: [] },
      });
      harness.downstream.emitMessage({
        jsonrpc: "2.0",
        id: "cancelled-server-0",
        error: { code: -32603, message: "duplicate late response" },
      });
      expect(harness.upstream.sent).toHaveLength(0);

      harness.upstream.emitMessage({
        jsonrpc: "2.0",
        id: "server-after-cancellations",
        method: "roots/list",
      });
      await waitForSent(harness.downstream, 35);
      harness.downstream.emitMessage({
        jsonrpc: "2.0",
        id: "server-after-cancellations",
        result: { roots: [] },
      });
      await waitForSent(harness.upstream, 1);
    } finally {
      await broker.close().catch(() => undefined);
    }
  });

  test.each([0, ""] as const)(
    "aliases a falsy nested server request ID (%j) and restores it on the response",
    async (originalId) => {
    const harness = createBrokerHarness();
    const broker = await harness.start();
    try {
      harness.upstream.emitMessage({ jsonrpc: "2.0", id: originalId, method: "roots/list" });
      await waitForSent(harness.downstream, 1);
      const alias = (harness.downstream.sent[0] as Record<string, unknown>).id;
      expect(typeof alias).toBe("string");
      expect(alias).toBeTruthy();
      expect(alias).not.toBe(originalId);

      harness.downstream.emitMessage({
        jsonrpc: "2.0",
        id: alias as string,
        result: { roots: [{ uri: "file:///D:/workspace" }] },
      });
      await waitForSent(harness.upstream, 1);
      expect(harness.upstream.sent[0]).toEqual({
        jsonrpc: "2.0",
        id: originalId,
        result: { roots: [{ uri: "file:///D:/workspace" }] },
      });
    } finally {
      await broker.close().catch(() => undefined);
    }
    },
  );

  test.each([0, ""] as const)(
    "aliases cancellation for falsy server request %j and drops the late aliased response",
    async (originalId) => {
    const harness = createBrokerHarness();
    const broker = await harness.start();
    try {
      harness.upstream.emitMessage({ jsonrpc: "2.0", id: originalId, method: "roots/list" });
      await waitForSent(harness.downstream, 1);
      const alias = (harness.downstream.sent[0] as Record<string, unknown>).id;

      harness.upstream.emitMessage({
        jsonrpc: "2.0",
        method: "notifications/cancelled",
        params: { requestId: originalId, reason: "cancel falsy" },
      });
      await waitForSent(harness.downstream, 2);
      expect(harness.downstream.sent[1]).toEqual({
        jsonrpc: "2.0",
        method: "notifications/cancelled",
        params: { requestId: alias, reason: "cancel falsy" },
      });

      harness.downstream.emitMessage({
        jsonrpc: "2.0",
        id: alias as string,
        error: { code: -32800, message: "Request cancelled" },
      });
      expect(harness.upstream.sent).toHaveLength(0);

      harness.upstream.emitMessage({
        jsonrpc: "2.0",
        id: "server-still-open",
        method: "roots/list",
      });
      await waitForSent(harness.downstream, 3);
      harness.downstream.emitMessage({
        jsonrpc: "2.0",
        id: "server-still-open",
        result: { roots: [] },
      });
      await waitForSent(harness.upstream, 1);
    } finally {
      await broker.close().catch(() => undefined);
    }
    },
  );

  test.each([0, ""] as const)(
    "uses a new client generation alias when completed falsy ID %j is reused",
    async (originalId) => {
      const harness = createBrokerHarness();
      const broker = await harness.start();
      try {
        const request = {
          jsonrpc: "2.0" as const,
          id: originalId,
          method: "tools/call",
          params: { name: "meanthis_list_captures", arguments: {} },
        };
        harness.downstream.emitMessage(request);
        await waitForSent(harness.upstream, 1);
        const firstAlias = (harness.upstream.sent[0] as Record<string, unknown>).id;
        expect(typeof firstAlias).toBe("string");
        expect(firstAlias).toBeTruthy();
        expect(firstAlias).not.toBe(originalId);

        harness.upstream.emitMessage({
          jsonrpc: "2.0",
          id: firstAlias as string,
          result: { content: [{ type: "text", text: "first" }] },
        });
        await waitForSent(harness.downstream, 1);
        expect((harness.downstream.sent[0] as Record<string, unknown>).id).toBe(originalId);

        harness.downstream.emitMessage(request);
        await waitForSent(harness.upstream, 2);
        const secondAlias = (harness.upstream.sent[1] as Record<string, unknown>).id;
        expect(typeof secondAlias).toBe("string");
        expect(secondAlias).toBeTruthy();
        expect(secondAlias).not.toBe(firstAlias);

        harness.upstream.emitMessage({
          jsonrpc: "2.0",
          id: firstAlias as string,
          result: { content: [{ type: "text", text: "late old generation" }] },
        });
        expect(harness.downstream.sent).toHaveLength(1);
        harness.upstream.emitMessage({
          jsonrpc: "2.0",
          id: secondAlias as string,
          result: { content: [{ type: "text", text: "second" }] },
        });
        await waitForSent(harness.downstream, 2);
        expect((harness.downstream.sent[1] as Record<string, unknown>).id).toBe(originalId);
      } finally {
        await broker.close().catch(() => undefined);
      }
    },
  );

  test.each([0, ""] as const)(
    "uses a new server generation alias when completed falsy ID %j is reused",
    async (originalId) => {
      const harness = createBrokerHarness();
      const broker = await harness.start();
      try {
        const request = { jsonrpc: "2.0" as const, id: originalId, method: "roots/list" };
        harness.upstream.emitMessage(request);
        await waitForSent(harness.downstream, 1);
        const firstAlias = (harness.downstream.sent[0] as Record<string, unknown>).id;
        harness.downstream.emitMessage({
          jsonrpc: "2.0",
          id: firstAlias as string,
          result: { roots: [] },
        });
        await waitForSent(harness.upstream, 1);
        expect((harness.upstream.sent[0] as Record<string, unknown>).id).toBe(originalId);

        harness.upstream.emitMessage(request);
        await waitForSent(harness.downstream, 2);
        const secondAlias = (harness.downstream.sent[1] as Record<string, unknown>).id;
        expect(typeof secondAlias).toBe("string");
        expect(secondAlias).toBeTruthy();
        expect(secondAlias).not.toBe(firstAlias);

        harness.downstream.emitMessage({
          jsonrpc: "2.0",
          id: firstAlias as string,
          result: { roots: [{ uri: "file:///late" }] },
        });
        expect(harness.upstream.sent).toHaveLength(1);
        harness.downstream.emitMessage({
          jsonrpc: "2.0",
          id: secondAlias as string,
          result: { roots: [] },
        });
        await waitForSent(harness.upstream, 2);
        expect((harness.upstream.sent[1] as Record<string, unknown>).id).toBe(originalId);
      } finally {
        await broker.close().catch(() => undefined);
      }
    },
  );

  test("keeps numeric and string truthy IDs typed in the nested server namespace", async () => {
    const harness = createBrokerHarness();
    const broker = await harness.start();
    try {
      harness.upstream.emitMessage({ jsonrpc: "2.0", id: 1, method: "roots/list" });
      harness.upstream.emitMessage({ jsonrpc: "2.0", id: "1", method: "roots/list" });
      await waitForSent(harness.downstream, 2);
      expect(harness.downstream.sent.map((message) => (
        message as Record<string, unknown>
      ).id)).toEqual([1, "1"]);

      harness.downstream.emitMessage({ jsonrpc: "2.0", id: "1", result: { roots: [] } });
      harness.downstream.emitMessage({ jsonrpc: "2.0", id: 1, result: { roots: [] } });
      await waitForSent(harness.upstream, 2);
      expect(harness.upstream.sent.map((message) => (
        message as Record<string, unknown>
      ).id)).toEqual(["1", 1]);
    } finally {
      await broker.close().catch(() => undefined);
    }
  });

  test("keeps distinct unpaired UTF-16 surrogate request IDs independent", async () => {
    const harness = createBrokerHarness();
    const broker = await harness.start();
    const firstId = "\ud800";
    const secondId = "\ud801";
    try {
      for (const id of [firstId, secondId]) {
        harness.downstream.emitMessage({
          jsonrpc: "2.0",
          id,
          method: "tools/call",
          params: { name: "meanthis_list_captures", arguments: {} },
        });
      }
      await waitForSent(harness.upstream, 2);
      harness.upstream.emitMessage({ jsonrpc: "2.0", id: secondId, result: { content: [] } });
      harness.upstream.emitMessage({ jsonrpc: "2.0", id: firstId, result: { content: [] } });
      await waitForSent(harness.downstream, 2);
      expect(harness.downstream.sent.map((message) => (
        message as Record<string, unknown>
      ).id)).toEqual([secondId, firstId]);
    } finally {
      await broker.close().catch(() => undefined);
    }
  });

  test("drops response-before-cancel races without poisoning reused IDs", async () => {
    const harness = createBrokerHarness();
    const broker = await harness.start();
    try {
      harness.downstream.emitMessage({
        jsonrpc: "2.0",
        id: "client-race",
        method: "tools/call",
        params: { name: "meanthis_list_captures", arguments: {} },
      });
      harness.upstream.emitMessage({
        jsonrpc: "2.0",
        id: "client-race",
        result: { content: [] },
      });
      await waitForSent(harness.downstream, 1);
      harness.downstream.emitMessage({
        jsonrpc: "2.0",
        method: "notifications/cancelled",
        params: { requestId: "client-race" },
      });
      await Promise.resolve();
      expect(harness.upstream.sent).toHaveLength(1);

      harness.downstream.emitMessage({
        jsonrpc: "2.0",
        id: "client-race",
        method: "tools/call",
        params: { name: "meanthis_list_captures", arguments: {} },
      });
      await waitForSent(harness.upstream, 2);
      harness.upstream.emitMessage({
        jsonrpc: "2.0",
        id: "client-race",
        result: { content: [] },
      });
      await waitForSent(harness.downstream, 2);

      harness.upstream.emitMessage({
        jsonrpc: "2.0",
        id: "server-race",
        method: "roots/list",
      });
      harness.downstream.emitMessage({
        jsonrpc: "2.0",
        id: "server-race",
        result: { roots: [] },
      });
      await waitForSent(harness.upstream, 3);
      harness.upstream.emitMessage({
        jsonrpc: "2.0",
        method: "notifications/cancelled",
        params: { requestId: "server-race" },
      });
      await Promise.resolve();
      expect(harness.downstream.sent).toHaveLength(3);

      harness.upstream.emitMessage({
        jsonrpc: "2.0",
        id: "server-race",
        method: "roots/list",
      });
      await waitForSent(harness.downstream, 4);
      harness.downstream.emitMessage({
        jsonrpc: "2.0",
        id: "server-race",
        result: { roots: [] },
      });
      await waitForSent(harness.upstream, 4);
    } finally {
      await broker.close().catch(() => undefined);
    }
  });

  test("forwards only the first cancellation that matches an active request", async () => {
    const harness = createBrokerHarness();
    const broker = await harness.start();
    try {
      harness.downstream.emitMessage({
        jsonrpc: "2.0",
        id: "active-client-cancel",
        method: "tools/call",
        params: { name: "meanthis_list_captures", arguments: {} },
      });
      await waitForSent(harness.upstream, 1);
      const clientCancellation = {
        jsonrpc: "2.0" as const,
        method: "notifications/cancelled" as const,
        params: { requestId: "active-client-cancel" },
      };
      harness.downstream.emitMessage(clientCancellation);
      await waitForSent(harness.upstream, 2);
      harness.downstream.emitMessage(clientCancellation);
      harness.downstream.emitMessage({
        jsonrpc: "2.0",
        method: "notifications/cancelled",
        params: { requestId: "unknown-client-cancel" },
      });
      await Promise.resolve();
      expect(harness.upstream.sent).toHaveLength(2);

      harness.upstream.emitMessage({
        jsonrpc: "2.0",
        id: "active-server-cancel",
        method: "roots/list",
      });
      await waitForSent(harness.downstream, 1);
      const serverCancellation = {
        jsonrpc: "2.0" as const,
        method: "notifications/cancelled" as const,
        params: { requestId: "active-server-cancel" },
      };
      harness.upstream.emitMessage(serverCancellation);
      await waitForSent(harness.downstream, 2);
      harness.upstream.emitMessage(serverCancellation);
      harness.upstream.emitMessage({
        jsonrpc: "2.0",
        method: "notifications/cancelled",
        params: { requestId: "unknown-server-cancel" },
      });
      await Promise.resolve();
      expect(harness.downstream.sent).toHaveLength(2);
    } finally {
      await broker.close().catch(() => undefined);
    }
  });

  test.each([0, ""] as const)(
    "maps outer falsy request %j cancellation to the active client alias",
    async (originalId) => {
      const harness = createBrokerHarness();
      const broker = await harness.start();
      try {
        harness.downstream.emitMessage({
          jsonrpc: "2.0",
          id: originalId,
          method: "tools/call",
          params: { name: "meanthis_list_captures", arguments: {} },
        });
        await waitForSent(harness.upstream, 1);
        const alias = (harness.upstream.sent[0] as Record<string, unknown>).id;
        harness.downstream.emitMessage({
          jsonrpc: "2.0",
          method: "notifications/cancelled",
          params: { requestId: originalId, reason: "cancel falsy outer request" },
        });
        await waitForSent(harness.upstream, 2);
        expect(harness.upstream.sent[1]).toEqual({
          jsonrpc: "2.0",
          method: "notifications/cancelled",
          params: { requestId: alias, reason: "cancel falsy outer request" },
        });

        harness.upstream.emitMessage({
          jsonrpc: "2.0",
          id: alias as string,
          result: { content: [{ type: "text", text: "late" }] },
        });
        expect(harness.downstream.sent).toHaveLength(0);
        harness.downstream.emitMessage({
          jsonrpc: "2.0",
          id: originalId,
          method: "tools/call",
          params: { name: "meanthis_list_captures", arguments: {} },
        });
        await expect(broker.closed).rejects.toThrow("MeanThis MCP stdio broker unavailable.");
        expect(harness.upstream.sent).toHaveLength(2);
      } finally {
        await broker.close().catch(() => undefined);
      }
    },
  );

  test.each([0, ""] as const)(
    "aborts a real SDK outer handler when falsy host request %j is cancelled",
    async (originalId) => {
      const [brokerHttpTransport, sdkTransport] = InMemoryTransport.createLinkedPair();
      const receiver = new TestSdkProtocol();
      let handlerRequestId: string | number | undefined;
      let handlerSignal: AbortSignal | undefined;
      receiver.setRequestHandler(CallToolRequestSchema, async (_request, extra) => {
        handlerRequestId = extra.requestId;
        handlerSignal = extra.signal;
        await new Promise<void>((resolvePromise) => {
          if (extra.signal.aborted) resolvePromise();
          else extra.signal.addEventListener("abort", () => resolvePromise(), { once: true });
        });
        return { content: [] };
      });
      await receiver.connect(sdkTransport);
      const downstream = new FakeTransport();
      const broker = await startLocalBridgeMcpStdioBroker({
        environment: {},
        readToken: async () => TOKEN,
        readDesiredBuildHash: async () => EXPECTED_BUILD_HASH,
        verifyDaemon: async () => undefined,
        createStdioTransport: () => downstream,
        createHttpTransport: () => brokerHttpTransport,
        inputLifecycle: new EventEmitter(),
        signalLifecycle: new EventEmitter(),
      });
      try {
        downstream.emitMessage({
          jsonrpc: "2.0",
          id: originalId,
          method: "tools/call",
          params: { name: "meanthis_list_captures", arguments: {} },
        });
        await vi.waitFor(() => expect(handlerSignal).toBeDefined());
        expect(handlerRequestId).toBeTruthy();
        expect(handlerRequestId).not.toBe(originalId);

        downstream.emitMessage({
          jsonrpc: "2.0",
          method: "notifications/cancelled",
          params: { requestId: originalId, reason: "real SDK cancellation" },
        });
        await vi.waitFor(() => expect(handlerSignal?.aborted).toBe(true));
      } finally {
        await broker.close().catch(() => undefined);
        await receiver.close().catch(() => undefined);
      }
    },
  );

  test.each([0, ""] as const)(
    "aborts a real SDK roots handler when falsy server request %j is cancelled",
    async (originalId) => {
      const [brokerStdioTransport, sdkTransport] = InMemoryTransport.createLinkedPair();
      const receiver = new TestSdkProtocol();
      let handlerRequestId: string | number | undefined;
      let handlerSignal: AbortSignal | undefined;
      receiver.setRequestHandler(ListRootsRequestSchema, async (_request, extra) => {
        handlerRequestId = extra.requestId;
        handlerSignal = extra.signal;
        await new Promise<void>((resolvePromise) => {
          if (extra.signal.aborted) resolvePromise();
          else extra.signal.addEventListener("abort", () => resolvePromise(), { once: true });
        });
        return { roots: [] };
      });
      await receiver.connect(sdkTransport);
      const upstream = new FakeHttpTransport();
      const broker = await startLocalBridgeMcpStdioBroker({
        environment: {},
        readToken: async () => TOKEN,
        readDesiredBuildHash: async () => EXPECTED_BUILD_HASH,
        verifyDaemon: async () => undefined,
        createStdioTransport: () => brokerStdioTransport,
        createHttpTransport: () => upstream,
        inputLifecycle: new EventEmitter(),
        signalLifecycle: new EventEmitter(),
      });
      try {
        upstream.emitMessage({ jsonrpc: "2.0", id: originalId, method: "roots/list" });
        await vi.waitFor(() => expect(handlerSignal).toBeDefined());
        expect(handlerRequestId).toBeTruthy();
        expect(handlerRequestId).not.toBe(originalId);

        upstream.emitMessage({
          jsonrpc: "2.0",
          method: "notifications/cancelled",
          params: { requestId: originalId, reason: "real SDK roots cancellation" },
        });
        await vi.waitFor(() => expect(handlerSignal?.aborted).toBe(true));
        expect(upstream.sent).toHaveLength(0);
      } finally {
        await broker.close().catch(() => undefined);
        await receiver.close().catch(() => undefined);
      }
    },
  );

  test("reclaims cancelled production HTTP POST streams through the real broker", async () => {
    const cancellationCount = 10;
    const root = await createBrokerSourceFixture("B", "BrokerCancelledRoots");
    const http = await startLocalBridgeMcpHttpServer(createLocalBridgeState(), {
      bearerToken: TOKEN,
      port: 0,
    });
    const [brokerStdioTransport, hostTransport] = InMemoryTransport.createLinkedPair();
    const hostClient = new Client(
      { name: "meanthis-production-broker-cancellations", version: "0.1.0" },
      { capabilities: { roots: { listChanged: false } } },
    );
    const rootsEnteredResolvers: Array<() => void> = [];
    const rootsEntered = Array.from({ length: cancellationCount }, () => (
      new Promise<void>((resolvePromise) => { rootsEnteredResolvers.push(resolvePromise); })
    ));
    const rootsSettledResolvers: Array<() => void> = [];
    const rootsSettled = Array.from({ length: cancellationCount }, () => (
      new Promise<void>((resolvePromise) => { rootsSettledResolvers.push(resolvePromise); })
    ));
    const rootsSignals: AbortSignal[] = [];
    const rootsRequestIds: Array<string | number> = [];
    let rootsSettledCount = 0;
    hostClient.setRequestHandler(ListRootsRequestSchema, async (_request, extra) => {
      const index = rootsSignals.length;
      rootsSignals.push(extra.signal);
      rootsRequestIds.push(extra.requestId);
      rootsEnteredResolvers[index]?.();
      try {
        if (index < cancellationCount) {
          await new Promise<void>((resolvePromise) => {
            if (extra.signal.aborted) resolvePromise();
            else extra.signal.addEventListener("abort", () => resolvePromise(), { once: true });
          });
        }
        return { roots: [{ uri: pathToFileURL(root.root).href, name: "broker-roots" }] };
      } finally {
        rootsSettledCount += 1;
        rootsSettledResolvers[index]?.();
      }
    });

    const resolverPostStatuses: number[] = [];
    const resolverPostContentTypes: Array<string | null> = [];
    const resolverPostSettlements: Array<Promise<string>> = [];
    const controlFetch = createLocalBridgeMcpHttpControlAwareFetch();
    const controllers: AbortController[] = [];
    const broker = await startLocalBridgeMcpStdioBroker({
      environment: {},
      readToken: async () => TOKEN,
      readDesiredBuildHash: async () => EXPECTED_BUILD_HASH,
      verifyDaemon: async () => undefined,
      createStdioTransport: () => brokerStdioTransport,
      createHttpTransport: () => new StreamableHTTPClientTransport(new URL(http.url), {
        requestInit: {
          headers: { authorization: `Bearer ${TOKEN}` },
        },
        fetch: async (input, init) => {
          const isResolverToolPost = init?.method === "POST" &&
            typeof init.body === "string" &&
            init.body.includes('"method":"tools/call"') &&
            init.body.includes('"name":"meanthis_resolve_source"');
          const response = await controlFetch(input, init);
          if (isResolverToolPost) {
            resolverPostStatuses.push(response.status);
            resolverPostContentTypes.push(response.headers.get("content-type"));
            resolverPostSettlements.push(response.clone().text());
          }
          return response;
        },
      }),
      inputLifecycle: new EventEmitter(),
      signalLifecycle: new EventEmitter(),
      sessionTerminationTimeoutMs: 1_000,
    });

    try {
      await hostClient.connect(hostTransport);
      for (let index = 0; index < cancellationCount; index += 1) {
        const controller = new AbortController();
        controllers.push(controller);
        const call = hostClient.callTool(
          {
            name: "meanthis_resolve_source",
            arguments: { sourceAnchor: root.anchor },
          },
          undefined,
          { signal: controller.signal },
        ).then(
          (value) => ({ kind: "resolved" as const, value }),
          (error: unknown) => ({ kind: "rejected" as const, error }),
        );
        await settleTestPromise(
          rootsEntered[index]!,
          `Resolver ${index + 1} never reached the real SDK roots handler.`,
        );
        controller.abort(new Error(`cancel production resolver ${index + 1}`));
        await vi.waitFor(() => expect(rootsSignals[index]?.aborted).toBe(true));
        await settleTestPromise(
          rootsSettled[index]!,
          `Resolver ${index + 1} roots handler did not settle after cancellation.`,
        );
        const outcome = await settleTestPromise(
          call,
          `Resolver ${index + 1} did not reject after cancellation.`,
        );
        expect(outcome.kind).toBe("rejected");
      }

      const resolved = await settleTestPromise(
        hostClient.callTool({
          name: "meanthis_resolve_source",
          arguments: { sourceAnchor: root.anchor },
        }),
        "Resolver POST did not settle after more than eight cancellations.",
      );
      const resolvedText = (resolved.content[0] as { text?: unknown } | undefined)?.text;
      expect(typeof resolvedText).toBe("string");
      expect(JSON.parse(resolvedText as string)).toMatchObject({
        status: "verified",
        location: {
          path: "src/BrokerCancelledRoots.tsx",
          componentName: "BrokerCancelledRoots",
        },
      });
      expect(rootsSignals).toHaveLength(cancellationCount + 1);
      expect(rootsRequestIds[0]).toBeTruthy();
      expect(rootsRequestIds[0]).not.toBe(0);
      expect(rootsSignals.slice(0, cancellationCount).every((signal) => signal.aborted)).toBe(true);
      expect(rootsSettledCount).toBe(cancellationCount + 1);

      const healthy = await settleTestPromise(
        hostClient.callTool({ name: "meanthis_list_captures", arguments: {} }),
        "A normal tool request was not admitted after broker cancellations.",
      );
      const healthyText = (healthy.content[0] as { text?: unknown } | undefined)?.text;
      expect(typeof healthyText).toBe("string");
      expect(JSON.parse(healthyText as string)).toMatchObject({
        kind: "ui-attach.capture-list",
      });

      await vi.waitFor(() => {
        expect(resolverPostSettlements).toHaveLength(cancellationCount + 1);
      }, { timeout: 2_000 });
      const postBodies = await settleTestPromise(
        Promise.all(resolverPostSettlements),
        "Production resolver POST SSE streams did not all settle.",
      );
      expect(resolverPostStatuses).toEqual(
        Array.from({ length: cancellationCount + 1 }, () => 200),
      );
      expect(resolverPostContentTypes.every((value) => value?.includes("text/event-stream")))
        .toBe(true);
      expect(postBodies).toHaveLength(cancellationCount + 1);
      expect(postBodies.slice(0, cancellationCount).every((body) => (
        body.includes('"code":-32001') && body.includes('"message":"Request cancelled."')
      ))).toBe(true);
    } finally {
      for (const controller of controllers) controller.abort();
      await hostClient.close().catch(() => undefined);
      await broker.close().catch(() => undefined);
      await http.close();
      await Promise.allSettled(resolverPostSettlements);
      await rm(root.root, { recursive: true, force: true });
    }
  }, 20_000);

  test("keeps one real SDK stdio client alive across a same-build HTTP owner replacement", async () => {
    let http = await startLocalBridgeMcpHttpServer(createLocalBridgeState(), {
      bearerToken: TOKEN,
      port: 0,
    });
    let currentUrl = http.url;
    const [brokerStdioTransport, hostTransport] = InMemoryTransport.createLinkedPair();
    const hostClient = new Client(
      { name: "meanthis-production-broker-reconnect", version: "0.1.0" },
      { capabilities: {} },
    );
    const createHttpTransport = vi.fn(() => new StreamableHTTPClientTransport(
      new URL(currentUrl),
      {
        requestInit: { headers: { authorization: `Bearer ${TOKEN}` } },
        fetch: createLocalBridgeMcpHttpControlAwareFetch(),
      },
    ));
    const broker = await startLocalBridgeMcpStdioBroker({
      environment: {},
      readToken: async () => TOKEN,
      readDesiredBuildHash: async () => EXPECTED_BUILD_HASH,
      verifyDaemon: async () => undefined,
      createStdioTransport: () => brokerStdioTransport,
      createHttpTransport,
      inputLifecycle: new EventEmitter(),
      signalLifecycle: new EventEmitter(),
    });

    try {
      await hostClient.connect(hostTransport);
      const before = await hostClient.callTool({
        name: "meanthis_list_captures",
        arguments: {},
      });
      expect(JSON.parse((before.content[0] as { text: string }).text)).toMatchObject({
        kind: "ui-attach.capture-list",
      });

      await http.close();
      http = await startLocalBridgeMcpHttpServer(createLocalBridgeState(), {
        bearerToken: TOKEN,
        port: 0,
      });
      currentUrl = http.url;

      const after = await settleTestPromise(
        hostClient.callTool({ name: "meanthis_list_captures", arguments: {} }),
        "The real stdio client did not recover after its HTTP owner was replaced.",
      );
      expect(JSON.parse((after.content[0] as { text: string }).text)).toMatchObject({
        kind: "ui-attach.capture-list",
      });
      expect(createHttpTransport).toHaveBeenCalledTimes(2);
    } finally {
      await hostClient.close().catch(() => undefined);
      await broker.close().catch(() => undefined);
      await http.close();
    }
  }, 20_000);

  test.each(["end", "close"] as const)(
    "clears cancelled-request tracking on input %s and ignores later responses",
    async (event) => {
      const harness = createBrokerHarness();
      const broker = await harness.start();
      harness.downstream.emitMessage({
        jsonrpc: "2.0",
        id: "cancel-before-close",
        method: "tools/call",
        params: { name: "meanthis_list_captures", arguments: {} },
      });
      harness.downstream.emitMessage({
        jsonrpc: "2.0",
        method: "notifications/cancelled",
        params: { requestId: "cancel-before-close" },
      });
      await waitForSent(harness.upstream, 2);

      harness.inputLifecycle.emit(event);
      await expect(broker.closed).resolves.toBeUndefined();
      harness.upstream.emitMessage({
        jsonrpc: "2.0",
        id: "cancel-before-close",
        result: { content: [] },
      });
      expect(harness.downstream.sent).toHaveLength(0);
    },
  );

  test("reserves a bounded control lane for cancellation and nested server responses", async () => {
    const harness = createBrokerHarness();
    const broker = await harness.start();
    try {
      for (let index = 0; index < 64; index += 1) {
        harness.downstream.emitMessage({
          jsonrpc: "2.0",
          id: `call-${index}`,
          method: "tools/call",
          params: { name: "meanthis_list_captures", arguments: {} },
        });
      }
      harness.downstream.emitMessage({
        jsonrpc: "2.0",
        method: "notifications/cancelled",
        params: { requestId: "call-0", reason: "cancelled" },
      });
      await waitForSent(harness.upstream, 65);
      expect(harness.upstream.sent[64]).toMatchObject({ method: "notifications/cancelled" });

      harness.upstream.emitMessage({
        jsonrpc: "2.0",
        id: "nested-roots-under-load",
        method: "roots/list",
      });
      await waitForSent(harness.downstream, 1);
      harness.downstream.emitMessage({
        jsonrpc: "2.0",
        id: "nested-roots-under-load",
        result: { roots: [{ uri: "file:///D:/workspace" }] },
      });
      await waitForSent(harness.upstream, 66);
      expect(harness.upstream.sent[65]).toMatchObject({
        id: "nested-roots-under-load",
        result: { roots: expect.any(Array) },
      });
    } finally {
      await broker.close().catch(() => undefined);
    }
  });

  test("bounds the reserved control lane instead of allowing notification fanout", async () => {
    const harness = createBrokerHarness();
    const broker = await harness.start();
    try {
      for (let index = 0; index < 9; index += 1) {
        harness.downstream.emitMessage({
          jsonrpc: "2.0",
          id: `call-${index}`,
          method: "tools/call",
          params: { name: "meanthis_list_captures", arguments: {} },
        });
      }
      for (let index = 0; index < 9; index += 1) {
        harness.downstream.emitMessage({
          jsonrpc: "2.0",
          method: "notifications/cancelled",
          params: { requestId: `call-${index}` },
        });
      }
      const outcome = await Promise.race([
        broker.closed.then(() => "closed", () => "failed"),
        new Promise<"timed_out">((resolve) => setTimeout(() => resolve("timed_out"), 100)),
      ]);
      expect(outcome).toBe("failed");
      expect(harness.upstream.sent.length).toBeLessThanOrEqual(17);
    } finally {
      await broker.close().catch(() => undefined);
    }
  });

  test("keeps ordinary and spoofed client notifications out of the control lane", async () => {
    const environment: NodeJS.ProcessEnv = {};
    const downstream = new FakeTransport();
    const upstream = new HangingSendTransport();
    const broker = await startLocalBridgeMcpStdioBroker({
      environment,
      readToken: async () => TOKEN,
      readDesiredBuildHash: async () => EXPECTED_BUILD_HASH,
      verifyDaemon: async () => undefined,
      createStdioTransport: () => downstream,
      createHttpTransport: () => upstream,
      inputLifecycle: new EventEmitter(),
      signalLifecycle: new EventEmitter(),
      sessionTerminationTimeoutMs: 10,
    });
    try {
      for (const requestId of [
        ...Array.from({ length: 8 }, (_, index) => `exact-${index}`),
        "control-overflow",
      ]) {
        downstream.emitMessage({
          jsonrpc: "2.0",
          id: requestId,
          method: "tools/call",
          params: { name: "meanthis_list_captures", arguments: {} },
        });
      }
      for (let index = 0; index < 8; index += 1) {
        downstream.emitMessage({
          jsonrpc: "2.0",
          method: "notifications/cancelled",
          params: { requestId: `exact-${index}` },
        });
      }
      const dataLaneMessages = [
        {
          jsonrpc: "2.0",
          method: "notifications/roots/list_changed",
        },
        {
          jsonrpc: "2.0",
          method: "notifications/cancelled",
          params: { requestId: "extra-top-level" },
          extra: true,
        },
        {
          jsonrpc: "2.0",
          method: "notifications/cancelled",
          params: { requestId: "extra-param", extra: true },
        },
        {
          jsonrpc: "2.0",
          method: "notifications/cancelled",
          params: { requestId: "bad-reason", reason: 1 },
        },
        {
          jsonrpc: "2.0",
          id: "pseudo-request",
          method: "notifications/cancelled",
          params: { requestId: "has-own-id" },
        },
        {
          method: "notifications/cancelled",
          params: { requestId: "missing-envelope" },
        },
        {
          jsonrpc: "1.0",
          method: "notifications/cancelled",
          params: { requestId: "wrong-version" },
        },
        {
          jsonrpc: "2.0",
          method: "notifications/cancelled",
        },
        {
          jsonrpc: "2.0",
          method: "notifications/cancelled",
          params: { requestId: {} },
        },
        {
          jsonrpc: "2.0",
          method: "notifications/cancelled",
          params: { requestId: "bad-meta", _meta: "not-an-object" },
        },
      ] as unknown as JSONRPCMessage[];
      for (const message of dataLaneMessages) downstream.emitMessage(message);
      await waitForSent(upstream, 9 + 8 + dataLaneMessages.length);
      const stillOpen = await Promise.race([
        broker.closed.then(() => "closed", () => "failed"),
        new Promise<"open">((resolvePromise) => setTimeout(() => resolvePromise("open"), 25)),
      ]);
      expect(stillOpen).toBe("open");

      downstream.emitMessage({
        jsonrpc: "2.0",
        method: "notifications/cancelled",
        params: { requestId: "control-overflow" },
      });
      await expect(broker.closed).rejects.toThrow("MeanThis MCP stdio broker unavailable.");
      expect(upstream.sent).toHaveLength(9 + 8 + dataLaneMessages.length);
    } finally {
      await broker.close().catch(() => undefined);
    }
  });

  test("bounds blocked response writes while preserving the downstream server-request lane", async () => {
    const environment: NodeJS.ProcessEnv = {};
    const downstream = new HangingSendTransport();
    const upstream = new FakeHttpTransport();
    const broker = await startLocalBridgeMcpStdioBroker({
      environment,
      readToken: async () => TOKEN,
      readDesiredBuildHash: async () => EXPECTED_BUILD_HASH,
      verifyDaemon: async () => undefined,
      createStdioTransport: () => downstream,
      createHttpTransport: () => upstream,
      inputLifecycle: new EventEmitter(),
      signalLifecycle: new EventEmitter(),
      sessionTerminationTimeoutMs: 10,
    });
    try {
      for (let index = 0; index < 64; index += 1) {
        downstream.emitMessage({
          jsonrpc: "2.0",
          id: `call-${index}`,
          method: "tools/call",
          params: { name: "meanthis_list_captures", arguments: {} },
        });
        upstream.emitMessage({
          jsonrpc: "2.0",
          id: `call-${index}`,
          result: { content: [] },
        });
      }
      expect(downstream.sent).toHaveLength(64);

      upstream.emitMessage({
        jsonrpc: "2.0",
        id: "roots-under-response-load",
        method: "roots/list",
      });
      expect(downstream.sent).toHaveLength(65);
      downstream.emitMessage({
        jsonrpc: "2.0",
        id: "roots-under-response-load",
        result: { roots: [{ uri: "file:///D:/workspace" }] },
      });
      await waitForSent(upstream, 65);

      upstream.emitMessage({
        jsonrpc: "2.0",
        id: "server-cancel-under-response-load",
        method: "roots/list",
      });
      expect(downstream.sent).toHaveLength(66);
      upstream.emitMessage({
        jsonrpc: "2.0",
        method: "notifications/cancelled",
        params: { requestId: "server-cancel-under-response-load" },
      });
      expect(downstream.sent).toHaveLength(67);

      upstream.emitMessage({
        jsonrpc: "2.0",
        method: "notifications/tools/list_changed",
      });
      const outcome = await Promise.race([
        broker.closed.then(() => "closed", () => "failed"),
        new Promise<"timed_out">((resolve) => setTimeout(() => resolve("timed_out"), 100)),
      ]);
      expect(outcome).toBe("failed");
      expect(downstream.sent).toHaveLength(67);
    } finally {
      await broker.close().catch(() => undefined);
    }
  });

  test("rejects a drifted upstream tool surface without forwarding it", async () => {
    const harness = createBrokerHarness();
    const broker = await harness.start();
    const listRequest = { jsonrpc: "2.0" as const, id: "tools", method: "tools/list" };
    harness.downstream.emitMessage(listRequest);
    await waitForSent(harness.upstream, 1);

    harness.upstream.emitMessage({
      jsonrpc: "2.0",
      id: "tools",
      result: {
        tools: [
          ...EXPECTED_TOOLS.map((name) => ({ name, inputSchema: { type: "object" } })),
          { name: "unexpected_control_tool", inputSchema: { type: "object" } },
        ],
      },
    });

    await expect(broker.closed).rejects.toThrow("MeanThis MCP stdio broker unavailable.");
    expect(harness.downstream.sent).toEqual([{
      jsonrpc: "2.0",
      id: "tools",
      error: { code: -32603, message: "MeanThis MCP tool surface unavailable." },
    }]);
    expect(JSON.stringify(harness.downstream.sent)).not.toContain(TOKEN);
    expect(harness.upstream.terminateSessionCount).toBe(1);
  });

  test("bounds a blocked stdio error write before closing a drifted tool session", async () => {
    const environment: NodeJS.ProcessEnv = {};
    const downstream = new HangingSendTransport();
    const upstream = new FakeHttpTransport();
    const broker = await startLocalBridgeMcpStdioBroker({
      environment,
      readToken: async () => TOKEN,
      readDesiredBuildHash: async () => EXPECTED_BUILD_HASH,
      verifyDaemon: async () => undefined,
      createStdioTransport: () => downstream,
      createHttpTransport: () => upstream,
      inputLifecycle: new EventEmitter(),
      signalLifecycle: new EventEmitter(),
      sessionTerminationTimeoutMs: 10,
    });
    downstream.emitMessage({ jsonrpc: "2.0", id: "tools", method: "tools/list" });
    await waitForSent(upstream, 1);
    upstream.emitMessage({
      jsonrpc: "2.0",
      id: "tools",
      result: { tools: [{ name: "unexpected_control_tool", inputSchema: { type: "object" } }] },
    });

    const outcome = await Promise.race([
      broker.closed.then(() => "closed", () => "failed"),
      new Promise<"timed_out">((resolve) => setTimeout(() => resolve("timed_out"), 100)),
    ]);
    expect(outcome).toBe("failed");
    expect(downstream.sent).toHaveLength(1);
    expect(upstream.terminateSessionCount).toBe(1);
    expect(upstream.closeCount).toBe(1);
    expect(downstream.closeCount).toBe(1);
  });

  test.each(["end", "close", "SIGINT", "SIGTERM"] as const)(
    "terminates the HTTP session on %s",
    async (event) => {
      const harness = createBrokerHarness();
      const broker = await harness.start();
      if (event === "end" || event === "close") {
        harness.inputLifecycle.emit(event);
      } else {
        harness.signalLifecycle.emit(event);
      }

      await expect(broker.closed).resolves.toBeUndefined();
      expect(harness.upstream.terminateSessionCount).toBe(1);
      expect(harness.upstream.closeCount).toBe(1);
      expect(harness.downstream.closeCount).toBe(1);
    },
  );

  test.each([
    ["readable", "EOF", false],
    ["unread", "EOF", false],
    ["unread", "broker SIGTERM lifecycle", false],
    ["unread", "EOF", true],
  ] as const)(
    "lets a real direct-entry broker exit with %s stdout after %s (held worker termination: %s)",
    async (stdoutMode, shutdownMode, holdWorkerTermination) => {
    const temporaryDirectory = await mkdtemp(join(tmpdir(), "meanthis-stdio-broker-"));
    const loaderPath = join(temporaryDirectory, "typescript-loader.mjs");
    const childPath = join(temporaryDirectory, "broker-backpressure-probe.mjs");
    const repositoryRoot = resolve(fileURLToPath(new URL("../../..", import.meta.url)));
    const useCompiledBroker = process.env.MEANTHIS_MCP_STDIO_BROKER_TEST_COMPILED === "1";
    const brokerSourceUrl = useCompiledBroker
      ? pathToFileURL(join(
        repositoryRoot,
        "apps/cli/dist/local-bridge-mcp-stdio-broker.js",
      )).href
      : pathToFileURL(fileURLToPath(
        new URL("./local-bridge-mcp-stdio-broker.ts", import.meta.url),
      )).href;
    const typescriptModuleUrl = pathToFileURL(
      createRequire(import.meta.url).resolve("typescript"),
    ).href;

    await writeFile(loaderPath, `
import ts from ${JSON.stringify(typescriptModuleUrl)};
import { access, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

export async function resolve(specifier, context, nextResolve) {
  if (specifier.startsWith(".") && specifier.endsWith(".js") && context.parentURL) {
    const candidate = new URL(specifier.slice(0, -3) + ".ts", context.parentURL);
    try {
      await access(fileURLToPath(candidate));
      return { url: candidate.href, shortCircuit: true };
    } catch {
      // Fall through to Node for real JavaScript files.
    }
  }
  return nextResolve(specifier, context);
}

export async function load(url, context, nextLoad) {
  if (new URL(url).pathname.endsWith(".ts")) {
    const source = await readFile(fileURLToPath(url), "utf8");
    const output = ts.transpileModule(source, {
      compilerOptions: {
        module: ts.ModuleKind.ESNext,
        moduleResolution: ts.ModuleResolutionKind.Bundler,
        target: ts.ScriptTarget.ES2022,
        verbatimModuleSyntax: true,
      },
      fileName: fileURLToPath(url),
    }).outputText;
    return { format: "module", source: output, shortCircuit: true };
  }
  return nextLoad(url, context);
}
`, "utf8");
    await writeFile(childPath, `
import { writeSync } from "node:fs";
import { Worker } from "node:worker_threads";
const originalKill = process.kill.bind(process);
process.kill = (pid, signal) => {
  if (pid === process.pid && signal === "SIGKILL") writeSync(2, "FORCED_EXIT_REQUESTED\\n");
  return originalKill(pid, signal);
};
if (${JSON.stringify(holdWorkerTermination)}) {
  Worker.prototype.terminate = function () {
    writeSync(2, "WRITER_TERMINATE_HELD\\n");
    return new Promise(() => {});
  };
}
const { runLocalBridgeMcpStdioBrokerDirectEntry } = await import(${JSON.stringify(brokerSourceUrl)});
const token = Buffer.alloc(32, 7).toString("base64url");
const responseText = "x".repeat(512 * 1024);

class BackpressuredHttpTransport {
  count = 0;
  async start() { process.stderr.write("BROKER_READY\\n"); }
  async terminateSession() { process.stderr.write("HTTP_TERMINATED\\n"); }
  async close() {
    process.stderr.write("HTTP_CLOSED\\n");
    this.onclose?.();
  }
  setProtocolVersion() {}
  async send(message) {
    if (message.method === "probe/sigterm") {
      process.emit("SIGTERM");
      return;
    }
    if (message.method !== "tools/call") return;
    this.onmessage?.({
      jsonrpc: "2.0",
      id: message.id,
      result: { content: [{ type: "text", text: responseText }] },
    });
    this.count += 1;
    if (this.count === 16) process.stderr.write("RESPONSES_QUEUED\\n");
  }
}

await runLocalBridgeMcpStdioBrokerDirectEntry([], {
  environment: {},
  readToken: async () => token,
  ensureOwners: async () => undefined,
  readDesiredBuildHash: async () => "a".repeat(64),
  verifyDaemon: async () => undefined,
  createHttpTransport: () => new BackpressuredHttpTransport(),
  sessionTerminationTimeoutMs: 25,
});
process.stderr.write("BROKER_CLOSED\\n");
`, "utf8");

    const childArgs = useCompiledBroker
      ? ["--no-warnings", childPath]
      : [
        "--no-warnings",
        "--experimental-loader",
        pathToFileURL(loaderPath).href,
        childPath,
      ];
    let child: ChildProcessWithoutNullStreams | undefined;
    try {
      child = spawn(process.execPath, childArgs, {
        cwd: repositoryRoot,
        stdio: ["pipe", "pipe", "pipe"],
        windowsHide: true,
      });
      let stderr = "";
      child.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });
      const stderrEnded = new Promise<void>((resolveEnd) => { child!.stderr.once("end", resolveEnd); });
      const outputChunks: Buffer[] = [];
      const outputEnded = stdoutMode === "readable"
        ? new Promise<void>((resolveEnd) => {
          child!.stdout.on("data", (chunk: Buffer) => { outputChunks.push(Buffer.from(chunk)); });
          child!.stdout.once("end", resolveEnd);
        })
        : undefined;
      if (stdoutMode === "unread") child.stdout.pause();
      await waitForStreamText(child.stderr, "BROKER_READY\n");
      const allResponsesWritten = stdoutMode === "readable"
        ? waitForStreamByteCount(child.stdout, 0x0a, 16)
        : undefined;
      const responsesQueued = waitForStreamText(child.stderr, "RESPONSES_QUEUED\n");
      for (let index = 0; index < 16; index += 1) {
        child.stdin.write(`${JSON.stringify({
          jsonrpc: "2.0",
          id: `backpressure-${index}`,
          method: "tools/call",
          params: { name: "meanthis_list_captures", arguments: {} },
        })}\n`);
      }
      await responsesQueued;
      await allResponsesWritten;

      const httpTerminated = waitForStreamText(child.stderr, "HTTP_TERMINATED\n");
      const httpClosed = waitForStreamText(child.stderr, "HTTP_CLOSED\n");
      const childExit = waitForChildExit(child, 2_000);
      if (shutdownMode === "EOF") {
        child.stdin.end();
      } else {
        child.stdin.write(`${JSON.stringify({
          jsonrpc: "2.0",
          method: "probe/sigterm",
        })}\n`);
      }
      await httpTerminated;
      await httpClosed;
      const exit = await childExit;
      await stderrEnded;
      if (holdWorkerTermination || exit.code !== 0 || exit.signal !== null) {
        expect(stderr).toContain("FORCED_EXIT_REQUESTED\n");
        if (holdWorkerTermination) expect(stderr).toContain("WRITER_TERMINATE_HELD\n");
        if (process.platform === "win32") {
          expect(
            (exit.code === 1 && exit.signal === null) ||
            (exit.code === null && exit.signal === "SIGKILL"),
          ).toBe(true);
        } else {
          expect(exit).toEqual({ code: null, signal: "SIGKILL" });
        }
      } else {
        expect(exit).toEqual({ code: 0, signal: null });
        expect(stderr).toContain("BROKER_CLOSED\n");
      }
      if (stdoutMode === "readable") {
        expect(exit).toEqual({ code: 0, signal: null });
        await outputEnded;
        const output = Buffer.concat(outputChunks).toString("utf8");
        expect(output.endsWith("\n")).toBe(true);
        expect(output.trimEnd().split("\n").map((line) => JSON.parse(line))).toEqual(
          Array.from({ length: 16 }, (_, index) => ({
            jsonrpc: "2.0", id: `backpressure-${index}`,
            result: { content: [{ type: "text", text: "x".repeat(512 * 1024) }] },
          })),
        );
      }
    } finally {
      if (child?.pid !== undefined && child.exitCode === null && child.signalCode === null) {
        const forcedExit = waitForChildExit(child, 2_000);
        child.kill("SIGKILL");
        await forcedExit;
      }
      child?.stdin.destroy();
      child?.stdout.destroy();
      child?.stderr.destroy();
      await rm(temporaryDirectory, { recursive: true, force: true });
    }
    },
    15_000,
  );

  test("rejects its own drain waiter without destroying a caller-owned backpressured output", async () => {
    const input = new PassThrough();
    const output = new NeverDrainingWritable();
    const inputLifecycle = new EventEmitter();
    const upstream = new FakeHttpTransport();
    const broker = await startLocalBridgeMcpStdioBroker({
      environment: {},
      readToken: async () => TOKEN,
      readDesiredBuildHash: async () => EXPECTED_BUILD_HASH,
      verifyDaemon: async () => undefined,
      createHttpTransport: () => upstream,
      inputLifecycle,
      signalLifecycle: new EventEmitter(),
      stdin: input,
      stdout: output,
      sessionTerminationTimeoutMs: 1_000,
    });

    try {
      upstream.emitMessage({
        jsonrpc: "2.0",
        method: "notifications/test",
        params: { value: "blocked" },
      });
      await vi.waitFor(() => expect(output.listenerCount("drain")).toBe(1));

      inputLifecycle.emit("end");
      const outcome = await Promise.race([
        broker.closed.then(() => "closed", () => "failed"),
        new Promise<"timed_out">((resolvePromise) => {
          setTimeout(() => resolvePromise("timed_out"), 200);
        }),
      ]);
      expect(outcome).toBe("closed");
      expect(output.listenerCount("drain")).toBe(0);
      expect(output.destroyed).toBe(false);
      expect(output.writableLength).toBeGreaterThan(0);
    } finally {
      input.destroy();
      output.destroy();
      await broker.close().catch(() => undefined);
    }
  });

  test("never destroys global stdout when the exported library broker closes", async () => {
    const input = new PassThrough();
    const inputLifecycle = new EventEmitter();
    const upstream = new FakeHttpTransport();
    const destroyStdout = vi.spyOn(process.stdout, "destroy").mockImplementation(() => process.stdout);
    let broker: Awaited<ReturnType<typeof startLocalBridgeMcpStdioBroker>> | undefined;

    try {
      broker = await startLocalBridgeMcpStdioBroker({
        environment: {},
        readToken: async () => TOKEN,
        readDesiredBuildHash: async () => EXPECTED_BUILD_HASH,
        verifyDaemon: async () => undefined,
        createHttpTransport: () => upstream,
        inputLifecycle,
        signalLifecycle: new EventEmitter(),
        stdin: input,
        sessionTerminationTimeoutMs: 50,
      });
      inputLifecycle.emit("end");
      await expect(broker.closed).resolves.toBeUndefined();
      expect(destroyStdout).not.toHaveBeenCalled();
      expect(process.stdout.destroyed).toBe(false);
    } finally {
      destroyStdout.mockRestore();
      input.destroy();
      await broker?.close().catch(() => undefined);
    }
  });

  test("does not destroy an explicitly injected stdio output on EOF", async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    const inputLifecycle = new EventEmitter();
    const upstream = new FakeHttpTransport();
    const broker = await startLocalBridgeMcpStdioBroker({
      environment: {},
      readToken: async () => TOKEN,
      readDesiredBuildHash: async () => EXPECTED_BUILD_HASH,
      verifyDaemon: async () => undefined,
      createHttpTransport: () => upstream,
      inputLifecycle,
      signalLifecycle: new EventEmitter(),
      stdin: input,
      stdout: output,
      sessionTerminationTimeoutMs: 10,
    });

    try {
      inputLifecycle.emit("end");
      await expect(broker.closed).resolves.toBeUndefined();
      expect(output.destroyed).toBe(false);
    } finally {
      input.destroy();
      output.destroy();
    }
  });

  test("does not start stdio after EOF closes a pending HTTP start", async () => {
    const environment: NodeJS.ProcessEnv = {};
    const downstream = new FakeTransport();
    const upstream = new DeferredStartHttpTransport();
    const inputLifecycle = new EventEmitter();
    const startPromise = startLocalBridgeMcpStdioBroker({
      environment,
      readToken: async () => TOKEN,
      readDesiredBuildHash: async () => EXPECTED_BUILD_HASH,
      verifyDaemon: async () => undefined,
      createStdioTransport: () => downstream,
      createHttpTransport: () => upstream,
      inputLifecycle,
      signalLifecycle: new EventEmitter(),
      sessionTerminationTimeoutMs: 10,
    });

    try {
      await vi.waitFor(() => expect(upstream.startCount).toBe(1));
      inputLifecycle.emit("end");
      await vi.waitFor(() => {
        expect(upstream.closeCount).toBe(1);
        expect(downstream.closeCount).toBe(1);
      });
      expect(downstream.startCount).toBe(0);

      upstream.releaseStart();
      const broker = await startPromise;
      await expect(broker.closed).resolves.toBeUndefined();
      expect(downstream.startCount).toBe(0);
    } finally {
      upstream.releaseStart();
      await startPromise.then((broker) => broker.close(), () => undefined).catch(() => undefined);
    }
  });

  test("bounds a hung HTTP session DELETE before closing both transports", async () => {
    const environment: NodeJS.ProcessEnv = {};
    const downstream = new FakeTransport();
    const upstream = new HangingTerminateHttpTransport();
    const broker = await startLocalBridgeMcpStdioBroker({
      environment,
      readToken: async () => TOKEN,
      readDesiredBuildHash: async () => EXPECTED_BUILD_HASH,
      verifyDaemon: async () => undefined,
      createStdioTransport: () => downstream,
      createHttpTransport: () => upstream,
      inputLifecycle: new EventEmitter(),
      signalLifecycle: new EventEmitter(),
      sessionTerminationTimeoutMs: 10,
    });

    const outcome = await Promise.race([
      broker.close().then(() => "closed", () => "failed"),
      new Promise<"timed_out">((resolve) => setTimeout(() => resolve("timed_out"), 100)),
    ]);
    expect(outcome).toBe("closed");
    expect(upstream.terminateSessionCount).toBe(1);
    expect(upstream.closeCount).toBe(1);
    expect(downstream.closeCount).toBe(1);
  });

  test("coalesces repeated EOF, signal, upstream close, and explicit close", async () => {
    const harness = createBrokerHarness();
    const broker = await harness.start();
    harness.inputLifecycle.emit("end");
    harness.inputLifecycle.emit("close");
    harness.signalLifecycle.emit("SIGTERM");
    harness.upstream.emitClose();
    const firstClose = broker.close();
    const secondClose = broker.close();

    expect(firstClose).toBe(secondClose);
    await expect(firstClose).resolves.toBeUndefined();
    expect(harness.upstream.terminateSessionCount).toBe(1);
    expect(harness.upstream.closeCount).toBe(1);
    expect(harness.downstream.closeCount).toBe(1);
  });

  test("fails closed on an upstream 401 or rotation error without leaking the token", async () => {
    const harness = createBrokerHarness();
    const broker = await harness.start();
    harness.upstream.emitError(new Error(`401 Authorization: Bearer ${TOKEN}`));

    await expect(broker.closed).rejects.toThrow("MeanThis MCP stdio broker unavailable.");
    await expect(broker.closed).rejects.not.toThrow(TOKEN);
    expect(JSON.stringify(harness.downstream.sent)).not.toContain(TOKEN);
    expect(harness.upstream.terminateSessionCount).toBe(1);
  });

  test("does not create transports when daemon authentication fails", async () => {
    const environment: NodeJS.ProcessEnv = {
      [MEANTHIS_MCP_HTTP_TOKEN_ENV]: TOKEN,
    };
    const createStdioTransport = vi.fn(() => new FakeTransport());
    const createHttpTransport = vi.fn(() => new FakeHttpTransport());

    await expect(startLocalBridgeMcpStdioBroker({
      environment,
      readToken: async () => TOKEN,
      readDesiredBuildHash: async () => EXPECTED_BUILD_HASH,
      verifyDaemon: async () => { throw new Error(`foreign ${TOKEN}`); },
      createStdioTransport,
      createHttpTransport,
      inputLifecycle: new EventEmitter(),
      signalLifecycle: new EventEmitter(),
    })).rejects.toThrow("MeanThis MCP stdio broker unavailable.");
    expect(environment[MEANTHIS_MCP_HTTP_TOKEN_ENV]).toBeUndefined();
    expect(createStdioTransport).not.toHaveBeenCalled();
    expect(createHttpTransport).not.toHaveBeenCalled();
  });

  test("removes inherited bearer environment keys case-insensitively", async () => {
    const lowerCaseTokenName = MEANTHIS_MCP_HTTP_TOKEN_ENV.toLowerCase();
    const environment: NodeJS.ProcessEnv = {
      [lowerCaseTokenName]: TOKEN,
      MEANTHIS_UNRELATED: "preserved",
    };
    const downstream = new FakeTransport();
    const upstream = new FakeHttpTransport();

    const broker = await startLocalBridgeMcpStdioBroker({
      environment,
      readToken: async () => {
        expect(Object.keys(environment)).not.toContain(lowerCaseTokenName);
        return TOKEN;
      },
      readDesiredBuildHash: async () => EXPECTED_BUILD_HASH,
      verifyDaemon: async () => undefined,
      createStdioTransport: () => downstream,
      createHttpTransport: () => upstream,
      inputLifecycle: new EventEmitter(),
      signalLifecycle: new EventEmitter(),
    });

    expect(environment).toEqual({ MEANTHIS_UNRELATED: "preserved" });
    await broker.close();
  });
});

describe("MeanThis stdio broker daemon proof", () => {
  test("authenticates the fixed daemon without sending the raw bearer", async () => {
    const health = {
      schemaVersion: "0.1.0",
      kind: "ui-attach.mcp-http-health",
      ok: true,
      transport: "streamable-http",
      endpoint: "/mcp",
      pid: 123,
      startCount: 1,
      startedAt: "2026-08-11T00:00:00.000Z",
      activeSessions: 0,
      retainedSessions: 0,
      maxSessions: 64,
      ownerIdentity: { buildHash: EXPECTED_BUILD_HASH },
    };
    const body = `${JSON.stringify(health)}\n`;
    let requestSerialization = "";
    const fetch = vi.fn(async (url: string | URL, init?: RequestInit) => {
      const headers = new Headers(init?.headers);
      requestSerialization = JSON.stringify({
        url: String(url),
        method: init?.method,
        headers: Object.fromEntries(headers),
        body: init?.body ?? null,
      });
      const requestProof = {
        timestamp: headers.get(MEANTHIS_MCP_HTTP_HEALTH_TIMESTAMP_HEADER)!,
        nonce: headers.get(MEANTHIS_MCP_HTTP_HEALTH_NONCE_HEADER)!,
        proof: headers.get(MEANTHIS_MCP_HTTP_HEALTH_PROOF_HEADER)!,
      };
      const responseProof = createLocalBridgeMcpHttpHealthProofResponse(
        TOKEN,
        requestProof,
        body,
        { now: () => 1_786_406_400_000 },
      );
      return new Response(body, {
        status: 200,
        headers: { "content-type": "application/json", ...responseProof.headers },
      });
    });

    await expect(verifyLocalBridgeMcpStdioBrokerDaemon(TOKEN, EXPECTED_BUILD_HASH, {
      fetch,
      now: () => 1_786_406_400_000,
      randomBytes: () => Buffer.alloc(32, 9),
    })).resolves.toBeUndefined();
    expect(fetch).toHaveBeenCalledOnce();
    expect(requestSerialization).not.toContain(TOKEN);
    expect(requestSerialization).not.toContain("authorization");
  });

  test("rejects a foreign listener before sending the raw bearer", async () => {
    let requestSerialization = "";
    const fetch = vi.fn(async (url: string | URL, init?: RequestInit) => {
      requestSerialization = JSON.stringify({
        url: String(url),
        headers: Object.fromEntries(new Headers(init?.headers)),
        body: init?.body ?? null,
      });
      return new Response("foreign listener\n", { status: 200 });
    });

    await expect(verifyLocalBridgeMcpStdioBrokerDaemon(TOKEN, EXPECTED_BUILD_HASH, {
      fetch,
      now: () => 1_786_406_400_000,
      randomBytes: () => Buffer.alloc(32, 9),
    })).rejects.toThrow("MeanThis MCP stdio broker unavailable.");
    expect(requestSerialization).not.toContain(TOKEN);
    expect(requestSerialization).not.toContain("authorization");
  });

  test("rejects a stale authenticated owner whose build does not match the desired identity", async () => {
    const staleHealth = {
      schemaVersion: "0.1.0",
      kind: "ui-attach.mcp-http-health",
      ok: true,
      transport: "streamable-http",
      endpoint: "/mcp",
      ownerIdentity: { buildHash: "b".repeat(64) },
    };
    const body = `${JSON.stringify(staleHealth)}\n`;
    const fetch = vi.fn(async (_url: string | URL, init?: RequestInit) => {
      const headers = new Headers(init?.headers);
      const requestProof = {
        timestamp: headers.get(MEANTHIS_MCP_HTTP_HEALTH_TIMESTAMP_HEADER)!,
        nonce: headers.get(MEANTHIS_MCP_HTTP_HEALTH_NONCE_HEADER)!,
        proof: headers.get(MEANTHIS_MCP_HTTP_HEALTH_PROOF_HEADER)!,
      };
      const responseProof = createLocalBridgeMcpHttpHealthProofResponse(
        TOKEN,
        requestProof,
        body,
        { now: () => 1_786_406_400_000 },
      );
      return new Response(body, { status: 200, headers: responseProof.headers });
    });

    await expect(verifyLocalBridgeMcpStdioBrokerDaemon(TOKEN, EXPECTED_BUILD_HASH, {
      fetch,
      now: () => 1_786_406_400_000,
      randomBytes: () => Buffer.alloc(32, 9),
    })).rejects.toThrow("MeanThis MCP stdio broker unavailable.");
  });

  test("does not create transports when the desired identity changes across health verification", async () => {
    const environment: NodeJS.ProcessEnv = {};
    const readDesiredBuildHash = vi.fn()
      .mockResolvedValueOnce(EXPECTED_BUILD_HASH)
      .mockResolvedValueOnce("b".repeat(64));
    const createStdioTransport = vi.fn(() => new FakeTransport());
    const createHttpTransport = vi.fn(() => new FakeHttpTransport());

    await expect(startLocalBridgeMcpStdioBroker({
      environment,
      readToken: async () => TOKEN,
      readDesiredBuildHash,
      verifyDaemon: async (_token, expectedBuildHash) => {
        expect(expectedBuildHash).toBe(EXPECTED_BUILD_HASH);
      },
      createStdioTransport,
      createHttpTransport,
      inputLifecycle: new EventEmitter(),
      signalLifecycle: new EventEmitter(),
    })).rejects.toThrow("MeanThis MCP stdio broker unavailable.");
    expect(readDesiredBuildHash).toHaveBeenCalledTimes(2);
    expect(createStdioTransport).not.toHaveBeenCalled();
    expect(createHttpTransport).not.toHaveBeenCalled();
  });

  test("does not create transports when the credential changes across health verification", async () => {
    const environment: NodeJS.ProcessEnv = {};
    const readToken = vi.fn()
      .mockResolvedValueOnce(TOKEN)
      .mockResolvedValueOnce(ROTATED_TOKEN);
    const createStdioTransport = vi.fn(() => new FakeTransport());
    const createHttpTransport = vi.fn(() => new FakeHttpTransport());

    await expect(startLocalBridgeMcpStdioBroker({
      environment,
      readToken,
      readDesiredBuildHash: async () => EXPECTED_BUILD_HASH,
      verifyDaemon: async (token, expectedBuildHash) => {
        expect(token).toBe(TOKEN);
        expect(expectedBuildHash).toBe(EXPECTED_BUILD_HASH);
      },
      createStdioTransport,
      createHttpTransport,
      inputLifecycle: new EventEmitter(),
      signalLifecycle: new EventEmitter(),
    })).rejects.toThrow("MeanThis MCP stdio broker unavailable.");
    expect(readToken).toHaveBeenCalledTimes(2);
    expect(createStdioTransport).not.toHaveBeenCalled();
    expect(createHttpTransport).not.toHaveBeenCalled();
  });
});

test("recognizes only its exact compiled direct entry", () => {
  const entry = "D:\\MeanThis\\dist\\local-bridge-mcp-stdio-broker.js";
  expect(isLocalBridgeMcpStdioBrokerDirectEntry(entry, pathToFileURL(entry).href)).toBe(true);
  expect(isLocalBridgeMcpStdioBrokerDirectEntry(
    "D:\\MeanThis\\dist\\index.js",
    pathToFileURL(entry).href,
  )).toBe(false);
  expect(isLocalBridgeMcpStdioBrokerDirectEntry(undefined, pathToFileURL(entry).href)).toBe(false);
});

test("direct entry rejects every argument before reading the credential", async () => {
  const environment: NodeJS.ProcessEnv = {
    [MEANTHIS_MCP_HTTP_TOKEN_ENV]: TOKEN,
  };
  const readToken = vi.fn(async () => TOKEN);

  await expect(runLocalBridgeMcpStdioBrokerDirectEntry(["--unexpected"], {
    environment,
    readToken,
    inputLifecycle: new EventEmitter(),
    signalLifecycle: new EventEmitter(),
  })).rejects.toThrow("MeanThis MCP stdio broker unavailable.");
  expect(environment[MEANTHIS_MCP_HTTP_TOKEN_ENV]).toBeUndefined();
  expect(readToken).not.toHaveBeenCalled();
});

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
