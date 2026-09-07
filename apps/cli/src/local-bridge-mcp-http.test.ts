import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { ListRootsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import {
  createSourceContentHash,
  createSourceMapSidecar,
} from "@meanthis/source-map-core";
import { createHash, createHmac } from "node:crypto";
import { once } from "node:events";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { request, ServerResponse } from "node:http";
import { connect } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, test, vi } from "vitest";
import {
  MEANTHIS_CHROME_WEB_STORE_EXTENSION_ID,
  createLocalBridgeState,
} from "./local-bridge";
import {
  MEANTHIS_MCP_HTTP_DEFAULT_MAX_CONTROL_IN_FLIGHT_REQUESTS,
  MEANTHIS_MCP_HTTP_DEFAULT_MAX_CONTROL_REQUESTS_PER_SESSION,
  MEANTHIS_MCP_HTTP_DEFAULT_MAX_IN_FLIGHT_REQUESTS,
  MEANTHIS_MCP_HTTP_DEFAULT_MAX_REQUESTS_PER_SESSION,
  MEANTHIS_MCP_HTTP_DEFAULT_MAX_SESSIONS,
  MEANTHIS_MCP_HTTP_DEFAULT_MAX_SOCKETS,
  MEANTHIS_MCP_HTTP_DEFAULT_MAX_SSE_CONNECTIONS_PER_SESSION,
  MEANTHIS_MCP_HTTP_DEFAULT_PORT,
  MEANTHIS_MCP_HTTP_HEALTH_NONCE_HEADER,
  MEANTHIS_MCP_HTTP_HEALTH_PROOF_HEADER,
  MEANTHIS_MCP_HTTP_HEALTH_RESPONSE_NONCE_HEADER,
  MEANTHIS_MCP_HTTP_HEALTH_RESPONSE_PROOF_HEADER,
  MEANTHIS_MCP_HTTP_HEALTH_RESPONSE_TIMESTAMP_HEADER,
  MEANTHIS_MCP_HTTP_HEALTH_TIMESTAMP_HEADER,
  createLocalBridgeMcpHttpHealthProofRequest,
  createLocalBridgeMcpHttpHealthProofResponse,
  verifyLocalBridgeMcpHttpHealthProofResponse,
  isLocalBridgeMcpHttpHealth,
  parseLocalBridgeMcpHttpArgs,
  runLocalBridgeMcpHttpServer,
  startLocalBridgeMcpHttpServer,
  type LocalBridgeMcpHttpServerOptions,
} from "./local-bridge-mcp-http.js";
import {
  MEANTHIS_MCP_HTTP_KEY_KIND,
  MEANTHIS_MCP_HTTP_TOKEN_ENV,
} from "./local-bridge-mcp-http-token.js";
import {
  MEANTHIS_MCP_HTTP_CONTROL_HEADER,
  MEANTHIS_MCP_HTTP_CONTROL_VALUE,
  createLocalBridgeMcpHttpControlAwareFetch,
} from "./local-bridge-mcp-http-control.js";

const EXTENSION_ORIGIN = `chrome-extension://${MEANTHIS_CHROME_WEB_STORE_EXTENSION_ID}`;
const TEST_BEARER_TOKEN = Buffer.alloc(32, 7).toString("base64url");
const WRONG_BEARER_TOKEN = Buffer.alloc(32, 8).toString("base64url");
const TEST_OWNER_IDENTITY = {
  buildHash: "a".repeat(64),
  executablePath: "C:\\private\\node.exe",
  entryPath: "C:\\private\\meanthis\\index.js",
};

describe("shared MeanThis Streamable HTTP MCP", () => {
  test("marks only bounded broker control traffic and strips hostile marker input", async () => {
    const observed: Array<{ method: string | undefined; marker: string | null }> = [];
    const controlFetch = createLocalBridgeMcpHttpControlAwareFetch(async (_input, init) => {
      observed.push({
        method: init?.method,
        marker: new Headers(init?.headers).get("x-meanthis-mcp-control"),
      });
      return new Response(null, { status: 200 });
    });
    const send = (method: string, body?: unknown) => controlFetch("http://127.0.0.1/mcp", {
      method,
      headers: { "x-meanthis-mcp-control": "hostile" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });

    await send("POST", { jsonrpc: "2.0", id: 1, result: {} });
    await send("POST", {
      jsonrpc: "2.0",
      id: 2,
      error: { code: -32603, message: "failed" },
    });
    await send("POST", {
      jsonrpc: "2.0",
      method: "notifications/cancelled",
      params: { requestId: 3, reason: "stopped" },
    });
    await send("DELETE");
    await send("POST", { jsonrpc: "2.0", method: "notifications/initialized" });
    await send("POST", { jsonrpc: "2.0", method: "notifications/roots/list_changed" });
    await send("POST", { jsonrpc: "2.0", id: 4, method: "tools/list" });

    expect(observed).toEqual([
      { method: "POST", marker: "broker-v1" },
      { method: "POST", marker: "broker-v1" },
      { method: "POST", marker: "broker-v1" },
      { method: "DELETE", marker: "broker-v1" },
      { method: "POST", marker: null },
      { method: "POST", marker: null },
      { method: "POST", marker: null },
    ]);
  });

  test("serves two concurrent MCP clients from one process and survives one session closing", async () => {
    const state = createSharedReaderState();
    const http = await startTestMcpHttpServer(state, { port: 0 });
    const firstTransport = createAuthenticatedTransport(http.url);
    const secondTransport = createAuthenticatedTransport(http.url);
    const first = new Client({ name: "meanthis-http-a", version: "0.1.0" });
    const second = new Client({ name: "meanthis-http-b", version: "0.1.0" });

    try {
      await Promise.all([
        first.connect(firstTransport),
        second.connect(secondTransport),
      ]);

      expect(firstTransport.sessionId).toMatch(/^[0-9a-f-]{36}$/);
      expect(secondTransport.sessionId).toMatch(/^[0-9a-f-]{36}$/);
      expect(secondTransport.sessionId).not.toBe(firstTransport.sessionId);

      const [firstTools, secondTools, firstCaptures, secondCaptures] = await Promise.all([
        first.listTools(),
        second.listTools(),
        first.callTool({ name: "meanthis_list_captures", arguments: {} }),
        second.callTool({ name: "meanthis_list_captures", arguments: {} }),
      ]);
      const expectedTools = [
        "meanthis_list_captures",
        "meanthis_read_capture",
        "meanthis_ack_capture_read",
        "meanthis_wait_capture_change",
        "meanthis_resolve_source",
      ];
      expect(firstTools.tools.map((tool) => tool.name)).toEqual(expectedTools);
      expect(secondTools.tools.map((tool) => tool.name)).toEqual(expectedTools);
      expect(JSON.parse(readText(firstCaptures))).toMatchObject({
        connectedInstanceCount: 1,
        state: "connected_without_shared_capture",
      });
      expect(JSON.parse(readText(secondCaptures))).toMatchObject({
        connectedInstanceCount: 1,
        state: "connected_without_shared_capture",
      });
      expect(readText(firstCaptures)).not.toContain("agent-copy-a");
      expect(readText(secondCaptures)).not.toContain("agent-copy-b");

      const health = await readHealth(http.origin);
      expect(health).toMatchObject({
        kind: "ui-attach.mcp-http-health",
        ok: true,
        pid: process.pid,
        startCount: http.startCount,
        activeSessions: 2,
        maxSessions: MEANTHIS_MCP_HTTP_DEFAULT_MAX_SESSIONS,
        ownerIdentity: { buildHash: TEST_OWNER_IDENTITY.buildHash },
      });
      expect(isLocalBridgeMcpHttpHealth(health)).toBe(true);
      expect(isLocalBridgeMcpHttpHealth({ ...health, executablePath: "private" })).toBe(false);
      expect(JSON.stringify(health)).not.toMatch(/token|invitation|approval|credential/i);
      expect(JSON.stringify(health)).not.toMatch(/executablePath|entryPath|C:\\private/i);

      await firstTransport.terminateSession();
      const afterFirstClosed = await second.listTools();
      expect(afterFirstClosed.tools.map((tool) => tool.name)).toEqual(expectedTools);
      await expect.poll(async () => (await readHealth(http.origin)).activeSessions).toBe(1);
    } finally {
      await Promise.allSettled([first.close(), second.close()]);
      await http.close();
    }
  });

  test("daemon close bypasses reconnect grace after two real SDK clients disconnect", async () => {
    const disconnectGraceMs = 1_000;
    const http = await startTestMcpHttpServer(createLocalBridgeState(), {
      port: 0,
      sessionDisconnectGraceMs: disconnectGraceMs,
      sessionIdleTtlMs: disconnectGraceMs * 2,
    });
    const first = new Client({ name: "meanthis-daemon-close-a", version: "0.1.0" });
    const second = new Client({ name: "meanthis-daemon-close-b", version: "0.1.0" });
    let closePromise: Promise<void> | undefined;

    try {
      await Promise.all([
        first.connect(createAuthenticatedTransport(http.url)),
        second.connect(createAuthenticatedTransport(http.url)),
      ]);
      await Promise.all([first.close(), second.close()]);
      expect(await readHealth(http.origin)).toMatchObject({
        activeSessions: 2,
        retainedSessions: 2,
      });

      closePromise = http.close();
      expect(http.close()).toBe(closePromise);
      await expect(Promise.race([
        closePromise.then(() => "closed" as const),
        delay(250).then(() => "timed_out" as const),
      ])).resolves.toBe("closed");
    } finally {
      await Promise.allSettled([first.close(), second.close()]);
      await closePromise;
    }
  });

  test("reclaims Client.close sessions after grace without disturbing another active client", async () => {
    const serverClose = vi.spyOn(McpServer.prototype, "close");
    const transportClose = vi.spyOn(StreamableHTTPServerTransport.prototype, "close");
    const http = await startTestMcpHttpServer(createLocalBridgeState(), {
      port: 0,
      sessionDisconnectGraceMs: 40,
      sessionIdleTtlMs: 400,
    });
    const first = new Client({ name: "meanthis-close-a", version: "0.1.0" });
    const second = new Client({ name: "meanthis-close-b", version: "0.1.0" });
    const firstTransport = createAuthenticatedTransport(http.url);
    const secondTransport = createAuthenticatedTransport(http.url);

    try {
      await Promise.all([first.connect(firstTransport), second.connect(secondTransport)]);
      await expect.poll(async () => (await readHealth(http.origin)).activeSessions).toBe(2);

      await first.close();

      await expect.poll(async () => (await readHealth(http.origin)).activeSessions).toBe(1);
      expect(serverClose).toHaveBeenCalled();
      expect(transportClose).toHaveBeenCalled();
      await expect(second.listTools()).resolves.toMatchObject({ tools: expect.any(Array) });
    } finally {
      await Promise.allSettled([first.close(), second.close()]);
      await http.close();
      serverClose.mockRestore();
      transportClose.mockRestore();
    }
  });

  test("reclaims an unexpectedly lost SSE client that cannot reconnect", async () => {
    const http = await startTestMcpHttpServer(createLocalBridgeState(), {
      port: 0,
      sessionDisconnectGraceMs: 40,
      sessionIdleTtlMs: 400,
    });
    const controlled = createControlledSseTransport(http.url, {
      initialReconnectionDelay: 10,
      maxRetries: 0,
    });
    const client = new Client({ name: "meanthis-lost", version: "0.1.0" });

    try {
      await client.connect(controlled.transport);
      await expect.poll(() => controlled.openedGetCount()).toBeGreaterThanOrEqual(1);
      controlled.abortCurrentGet();

      await expect.poll(async () => (await readHealth(http.origin)).activeSessions).toBe(0);
    } finally {
      await Promise.allSettled([client.close()]);
      await http.close();
    }
  });

  test("keeps a session alive when its SSE connection returns within the grace period", async () => {
    const disconnectGraceMs = 120;
    const http = await startTestMcpHttpServer(createLocalBridgeState(), {
      port: 0,
      sessionDisconnectGraceMs: disconnectGraceMs,
      sessionIdleTtlMs: 600,
    });
    const controlled = createControlledSseTransport(http.url, {
      initialReconnectionDelay: 10,
      maxRetries: 3,
    });
    const client = new Client({ name: "meanthis-reconnect", version: "0.1.0" });

    try {
      await client.connect(controlled.transport);
      await expect.poll(() => controlled.openedGetCount()).toBeGreaterThanOrEqual(1);
      controlled.abortCurrentGet();

      await delay(disconnectGraceMs / 2);
      expect(await readHealth(http.origin)).toMatchObject({ activeSessions: 1 });
      await expect.poll(() => controlled.openedGetCount()).toBeGreaterThanOrEqual(2);
      await delay(disconnectGraceMs + 30);
      expect(await readHealth(http.origin)).toMatchObject({ activeSessions: 1 });
      await expect(client.listTools()).resolves.toMatchObject({ tools: expect.any(Array) });
    } finally {
      await Promise.allSettled([client.close()]);
      await http.close();
    }
  });

  test("expires initialized sessions that never establish SSE", async () => {
    const http = await startTestMcpHttpServer(createLocalBridgeState(), {
      port: 0,
      sessionDisconnectGraceMs: 30,
      sessionIdleTtlMs: 80,
    });

    try {
      const initialized = await rawInitialize(http.origin);
      expect(initialized.status).toBe(200);
      expect(initialized.sessionId).toMatch(/^[0-9a-f-]{36}$/);
      expect(await readHealth(http.origin)).toMatchObject({ activeSessions: 1 });
      await expect.poll(async () => (await readHealth(http.origin)).activeSessions).toBe(0);
    } finally {
      await http.close();
    }
  });

  test("closes initialized resources when transport request handling throws", async () => {
    const originalHandleRequest = StreamableHTTPServerTransport.prototype.handleRequest;
    const handleRequest = vi.spyOn(
      StreamableHTTPServerTransport.prototype,
      "handleRequest",
    ).mockImplementationOnce(async function (request, response, body) {
      await originalHandleRequest.call(this, request, response, body);
      throw new Error("Injected transport failure after initialization.");
    });
    const http = await startTestMcpHttpServer(createLocalBridgeState(), {
      port: 0,
      sessionDisconnectGraceMs: 30,
      sessionIdleTtlMs: 100,
    });

    try {
      const initialized = await rawInitialize(http.origin);
      expect(initialized.status).toBe(200);
      await expect.poll(async () => (await readHealth(http.origin)).activeSessions).toBe(0);
    } finally {
      handleRequest.mockRestore();
      await http.close();
    }
  });

  test("keeps client-declared workspace roots isolated and has no daemon cwd fallback", async () => {
    const state = createSharedReaderState();
    const rootA = await createSourceFixture("A", "SettingsA");
    const rootB = await createSourceFixture("B", "SettingsB");
    const http = await startTestMcpHttpServer(state, { port: 0 });
    const clientA = createRootsClient("meanthis-roots-a", rootA.root);
    const clientB = createRootsClient("meanthis-roots-b", rootB.root);
    const noRootsClient = new Client({ name: "meanthis-no-roots", version: "0.1.0" });
    const transportA = createAuthenticatedTransport(http.url);
    const transportB = createAuthenticatedTransport(http.url);
    const noRootsTransport = createAuthenticatedTransport(http.url);

    try {
      await Promise.all([
        clientA.connect(transportA),
        clientB.connect(transportB),
        noRootsClient.connect(noRootsTransport),
      ]);

      const [listA, listB, sourceA, sourceB, sourceWithoutRoots] = await Promise.all([
        clientA.callTool({
          name: "meanthis_list_captures",
          arguments: {},
        }),
        clientB.callTool({
          name: "meanthis_list_captures",
          arguments: {},
        }),
        clientA.callTool({
          name: "meanthis_resolve_source",
          arguments: { sourceAnchor: rootA.anchor },
        }),
        clientB.callTool({
          name: "meanthis_resolve_source",
          arguments: { sourceAnchor: rootB.anchor },
        }),
        noRootsClient.callTool({
          name: "meanthis_resolve_source",
          arguments: { sourceAnchor: rootA.anchor },
        }),
      ]);
      expect(JSON.parse(readText(listA))).toMatchObject({ connectedInstanceCount: 1 });
      expect(JSON.parse(readText(listB))).toMatchObject({ connectedInstanceCount: 1 });
      expect(JSON.parse(readText(sourceA))).toMatchObject({
        status: "verified",
        location: { path: "src/SettingsA.tsx", componentName: "SettingsA" },
      });
      expect(JSON.parse(readText(sourceB))).toMatchObject({
        status: "verified",
        location: { path: "src/SettingsB.tsx", componentName: "SettingsB" },
      });
      expect(JSON.parse(readText(sourceWithoutRoots))).toMatchObject({
        status: "unavailable",
        reason: "workspace_unavailable",
      });

      const crossRoot = await clientA.callTool({
        name: "meanthis_resolve_source",
        arguments: { sourceAnchor: rootB.anchor },
      });
      expect(JSON.parse(readText(crossRoot))).toMatchObject({
        status: "unavailable",
        reason: "build_mismatch",
      });
    } finally {
      await Promise.allSettled([clientA.close(), clientB.close(), noRootsClient.close()]);
      await http.close();
      await Promise.all([
        rm(rootA.root, { recursive: true, force: true }),
        rm(rootB.root, { recursive: true, force: true }),
      ]);
    }
  });

  test("resolves roots on the current tool POST before standalone SSE is established", async () => {
    const root = await createSourceFixture("P", "PostBoundRoots");
    const http = await startTestMcpHttpServer(createSharedReaderState(), { port: 0 });
    const client = new Client(
      { name: "meanthis-related-request-roots", version: "0.1.0" },
      { capabilities: { roots: { listChanged: false } } },
    );
    let rootsRequestCount = 0;
    client.setRequestHandler(ListRootsRequestSchema, async () => {
      rootsRequestCount += 1;
      return { roots: [{ uri: pathToFileURL(root.root).href, name: "post-bound" }] };
    });

    let markStandaloneGetEntered!: () => void;
    const standaloneGetEntered = new Promise<void>((resolve) => {
      markStandaloneGetEntered = resolve;
    });
    let releaseStandaloneGet!: () => void;
    const standaloneGetGate = new Promise<void>((resolve) => {
      releaseStandaloneGet = resolve;
    });
    let standaloneGetForwarded = false;
    let standaloneGetRequest: Promise<Response> | undefined;
    let resolverPostContentType: string | null = null;
    const transport = new StreamableHTTPClientTransport(new URL(http.url), {
      requestInit: authenticatedRequestInit(),
      fetch: async (input, init) => {
        if (init?.method === "GET") {
          markStandaloneGetEntered();
          standaloneGetRequest = (async () => {
            await standaloneGetGate;
            if (init.signal?.aborted) throw init.signal.reason;
            standaloneGetForwarded = true;
            return await fetch(input, init);
          })();
          return await standaloneGetRequest;
        }

        const isResolverToolPost = typeof init?.body === "string" &&
          init.body.includes('"method":"tools/call"') &&
          init.body.includes('"name":"meanthis_resolve_source"');
        const response = await fetch(input, init);
        if (isResolverToolPost) {
          resolverPostContentType = response.headers.get("content-type");
        }
        return response;
      },
    });
    let toolCall: ReturnType<Client["callTool"]> | undefined;

    try {
      await client.connect(transport);
      toolCall = client.callTool({
        name: "meanthis_resolve_source",
        arguments: { sourceAnchor: root.anchor },
      });

      let timeout: NodeJS.Timeout | undefined;
      const outcome = await Promise.race([
        Promise.all([toolCall, standaloneGetEntered]).then(([result]) => ({
          kind: "resolved" as const,
          result,
        })),
        new Promise<{ kind: "timeout" }>((resolve) => {
          timeout = setTimeout(() => resolve({ kind: "timeout" }), 1_000);
        }),
      ]).finally(() => {
        if (timeout) clearTimeout(timeout);
      });

      expect(outcome.kind).toBe("resolved");
      if (outcome.kind !== "resolved") throw new Error("Resolver tool POST did not settle in time.");
      expect(JSON.parse(readText(outcome.result))).toMatchObject({
        status: "verified",
        location: { path: "src/PostBoundRoots.tsx", componentName: "PostBoundRoots" },
      });
      expect(rootsRequestCount).toBe(1);
      expect(resolverPostContentType).toContain("text/event-stream");
      expect(standaloneGetForwarded).toBe(false);
    } finally {
      await client.close().catch(() => undefined);
      releaseStandaloneGet();
      await Promise.allSettled([
        toolCall ?? Promise.resolve(),
        standaloneGetRequest ?? Promise.resolve(),
      ]);
      await http.close();
      await rm(root.root, { recursive: true, force: true });
    }
  });

  test("releases cancelled tool POST streams without exhausting one live session", async () => {
    const cancellationCount = MEANTHIS_MCP_HTTP_DEFAULT_MAX_REQUESTS_PER_SESSION + 2;
    const root = await createSourceFixture("C", "CancelledRoots");
    const http = await startTestMcpHttpServer(createSharedReaderState(), { port: 0 });
    const client = new Client(
      { name: "meanthis-cancelled-post-streams", version: "0.1.0" },
      { capabilities: { roots: { listChanged: false } } },
    );
    const rootsEnteredResolvers: Array<() => void> = [];
    const rootsEntered = Array.from({ length: cancellationCount }, () => (
      new Promise<void>((resolve) => { rootsEnteredResolvers.push(resolve); })
    ));
    const rootsSignals: AbortSignal[] = [];
    let rootsSettled = 0;
    let markCancellableRootsSettled!: () => void;
    const cancellableRootsSettled = new Promise<void>((resolve) => {
      markCancellableRootsSettled = resolve;
    });
    client.setRequestHandler(ListRootsRequestSchema, async (_request, extra) => {
      const index = rootsSignals.length;
      rootsSignals.push(extra.signal);
      rootsEnteredResolvers[index]?.();
      try {
        await new Promise<void>((resolve) => {
          if (extra.signal.aborted) {
            resolve();
            return;
          }
          extra.signal.addEventListener("abort", () => resolve(), { once: true });
        });
        return { roots: [{ uri: pathToFileURL(root.root).href, name: "cancelled" }] };
      } finally {
        rootsSettled += 1;
        if (rootsSettled === cancellationCount - 1) markCancellableRootsSettled();
      }
    });

    let markStandaloneGetEstablished!: () => void;
    const standaloneGetEstablished = new Promise<void>((resolve) => {
      markStandaloneGetEstablished = resolve;
    });
    const resolverPostStatuses: number[] = [];
    const resolverPostSettlements: Array<Promise<string>> = [];
    const toolPostRequests: Array<{ id: string | number; name: string }> = [];
    const controlFetch = createLocalBridgeMcpHttpControlAwareFetch();
    const transport = new StreamableHTTPClientTransport(new URL(http.url), {
      requestInit: authenticatedRequestInit(),
      fetch: async (input, init) => {
        const toolPost = readToolPostRequest(init?.body);
        if (toolPost) toolPostRequests.push(toolPost);
        const isResolverToolPost = toolPost?.name === "meanthis_resolve_source";
        const response = await controlFetch(input, init);
        if (init?.method === "GET" && response.status === 200) {
          markStandaloneGetEstablished();
        }
        if (isResolverToolPost) {
          resolverPostStatuses.push(response.status);
          resolverPostSettlements.push(response.clone().text());
        }
        return response;
      },
    });
    const controllers: AbortController[] = [];
    const calls: Array<Promise<{
      kind: "resolved";
      value: Awaited<ReturnType<Client["callTool"]>>;
    } | { kind: "rejected"; error: unknown }>> = [];

    try {
      await client.connect(transport);
      await settleWithin(standaloneGetEstablished, 1_000, "Standalone SSE GET was not established.");
      const sendCancellation = async (requestId: string | number) => {
        if (!transport.sessionId) throw new Error("Expected an initialized MCP session.");
        return await controlFetch(http.url, {
          method: "POST",
          headers: {
            accept: "application/json, text/event-stream",
            authorization: `Bearer ${TEST_BEARER_TOKEN}`,
            "content-type": "application/json",
            "mcp-protocol-version": "2025-11-25",
            "mcp-session-id": transport.sessionId,
          },
          body: JSON.stringify({
            jsonrpc: "2.0",
            method: "notifications/cancelled",
            params: { requestId, reason: "duplicate or late cancellation" },
          }),
        });
      };

      for (let index = 0; index < cancellationCount; index += 1) {
        const controller = new AbortController();
        controllers.push(controller);
        const call = client.callTool(
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
        calls.push(call);

        await settleWithin(
          rootsEntered[index]!,
          1_000,
          `Cancelled resolver ${index + 1} never reached roots/list.`,
        );
        controller.abort(new Error(`cancel resolver ${index + 1}`));
        if (index === 0) {
          const duplicateRequestId = toolPostRequests.find(
            (request) => request.name === "meanthis_resolve_source",
          )?.id;
          if (duplicateRequestId === undefined) {
            throw new Error("Expected the first resolver request ID.");
          }
          const [duplicate, unknown] = await Promise.all([
            sendCancellation(duplicateRequestId),
            sendCancellation("unknown-cancelled-request"),
          ]);
          expect([duplicate.status, unknown.status]).toEqual([202, 202]);
        }
        const outcome = await settleWithin(
          call,
          1_000,
          `Cancelled resolver ${index + 1} did not reject.`,
        );
        expect(outcome.kind).toBe("rejected");
      }

      expect(resolverPostStatuses).toEqual(
        Array.from({ length: cancellationCount }, () => 200),
      );
      const cancelledPostBodies = await settleWithin(
        Promise.all(resolverPostSettlements),
        1_000,
        "Cancelled resolver POST SSE responses did not all settle.",
      );
      expect(cancelledPostBodies).toHaveLength(cancellationCount);
      for (const body of cancelledPostBodies) {
        expect(body).toContain('"code":-32001');
        expect(body).toContain('"message":"Request cancelled."');
      }
      // SDK 1.29 does not abort a nested request whose direct-HTTP ID is numeric zero.
      // The production stdio broker aliases falsey IDs; this HTTP-only regression leaves
      // that first handler to client.close() and verifies every later request here.
      await settleWithin(
        cancellableRootsSettled,
        1_000,
        "Cancellable roots handlers did not settle.",
      );
      expect(rootsSignals).toHaveLength(cancellationCount);
      expect(rootsSignals.slice(1).every((signal) => signal.aborted)).toBe(true);

      const healthyCall = await settleWithin(
        client.callTool({ name: "meanthis_list_captures", arguments: {} }),
        1_000,
        "A normal tool POST was not admitted after cancellations.",
      );
      expect(JSON.parse(readText(healthyCall))).toMatchObject({
        kind: "ui-attach.capture-list",
      });
      const completedRequestId = toolPostRequests.findLast(
        (request) => request.name === "meanthis_list_captures",
      )?.id;
      if (completedRequestId === undefined) throw new Error("Expected a completed tool request ID.");
      await expect(sendCancellation(completedRequestId)).resolves.toMatchObject({ status: 202 });
      const followupCall = await settleWithin(
        client.callTool({ name: "meanthis_list_captures", arguments: {} }),
        1_000,
        "A normal tool POST failed after a late cancellation raced its completed result.",
      );
      expect(JSON.parse(readText(followupCall))).toMatchObject({
        kind: "ui-attach.capture-list",
      });
      expect((await readHealth(http.origin)).activeSessions).toBe(1);
    } finally {
      for (const controller of controllers) controller.abort();
      await Promise.allSettled(calls);
      await client.close().catch(() => undefined);
      await http.close();
      await Promise.allSettled(resolverPostSettlements);
      await rm(root.root, { recursive: true, force: true });
    }
  });

  test("retires a natural tool terminal before the response finish fallback runs", async () => {
    const http = await startTestMcpHttpServer(createSharedReaderState(), { port: 0 });
    const client = new Client({ name: "meanthis-terminal-retirement", version: "0.1.0" });
    const controlFetch = createLocalBridgeMcpHttpControlAwareFetch();
    let completedRequestId: string | number | undefined;
    const transport = new StreamableHTTPClientTransport(new URL(http.url), {
      requestInit: authenticatedRequestInit(),
      fetch: async (input, init) => {
        const toolPost = readToolPostRequest(init?.body);
        if (toolPost?.name === "meanthis_list_captures") completedRequestId = toolPost.id;
        return await controlFetch(input, init);
      },
    });
    let releaseResponseFallback!: () => void;
    const responseFallbackGate = new Promise<void>((resolve) => {
      releaseResponseFallback = resolve;
    });
    let markResponseFallbackBlocked!: () => void;
    const responseFallbackBlocked = new Promise<void>((resolve) => {
      markResponseFallbackBlocked = resolve;
    });
    let fallbackBlockCount = 0;
    const originalOnce = ServerResponse.prototype.once;
    const responseOnce = vi.spyOn(ServerResponse.prototype, "once")
      .mockImplementation(function (
        this: ServerResponse,
        eventName: string | symbol,
        listener: (...args: unknown[]) => void,
      ) {
        if (
          (eventName === "finish" || eventName === "close") &&
          listener.name === "settleResponse"
        ) {
          const response = this;
          const delayedListener = (...args: unknown[]) => {
            fallbackBlockCount += 1;
            markResponseFallbackBlocked();
            void responseFallbackGate.then(() => {
              Reflect.apply(listener, response, args);
            });
          };
          return Reflect.apply(originalOnce, this, [eventName, delayedListener]);
        }
        return Reflect.apply(originalOnce, this, [eventName, listener]);
      });
    const originalSend = StreamableHTTPServerTransport.prototype.send;
    let lateCancellationTerminalAttempts = 0;
    const transportSend = vi.spyOn(StreamableHTTPServerTransport.prototype, "send")
      .mockImplementation(async function (message, options) {
        if (
          "error" in message &&
          message.id === completedRequestId &&
          message.error.code === -32_001 &&
          message.error.message === "Request cancelled."
        ) {
          lateCancellationTerminalAttempts += 1;
        }
        return await originalSend.call(this, message, options);
      });

    try {
      await client.connect(transport);
      const completed = await settleWithin(
        client.callTool({ name: "meanthis_list_captures", arguments: {} }),
        1_000,
        "Natural tool result did not arrive.",
      );
      expect(JSON.parse(readText(completed))).toMatchObject({
        kind: "ui-attach.capture-list",
      });
      if (completedRequestId === undefined) throw new Error("Expected a completed request ID.");
      await settleWithin(
        responseFallbackBlocked,
        1_000,
        "Response finish fallback was not held after the natural result.",
      );

      if (!transport.sessionId) throw new Error("Expected an initialized MCP session.");
      const lateCancellation = await settleWithin(
        controlFetch(http.url, {
          method: "POST",
          headers: {
            accept: "application/json, text/event-stream",
            authorization: `Bearer ${TEST_BEARER_TOKEN}`,
            "content-type": "application/json",
            "mcp-protocol-version": "2025-11-25",
            "mcp-session-id": transport.sessionId,
          },
          body: JSON.stringify({
            jsonrpc: "2.0",
            method: "notifications/cancelled",
            params: { requestId: completedRequestId, reason: "late cancellation" },
          }),
        }),
        1_000,
        "Late cancellation did not settle.",
      );
      expect(lateCancellation.status).toBe(202);
      expect(lateCancellationTerminalAttempts).toBe(0);

      const followup = await settleWithin(
        client.callTool({ name: "meanthis_list_captures", arguments: {} }),
        1_000,
        "Session was not healthy after a late cancellation.",
      );
      expect(JSON.parse(readText(followup))).toMatchObject({
        kind: "ui-attach.capture-list",
      });
      expect((await readHealth(http.origin)).activeSessions).toBe(1);
      expect(fallbackBlockCount).toBeGreaterThan(0);
    } finally {
      releaseResponseFallback();
      responseOnce.mockRestore();
      transportSend.mockRestore();
      await client.close().catch(() => undefined);
      await http.close();
    }
  });

  test("coalesces concurrent cancellation terminals for one active tool request", async () => {
    const root = await createSourceFixture("G", "ConcurrentCancellation");
    const http = await startTestMcpHttpServer(createSharedReaderState(), { port: 0 });
    const client = new Client(
      { name: "meanthis-concurrent-cancellation", version: "0.1.0" },
      { capabilities: { roots: { listChanged: false } } },
    );
    let markRootsEntered!: () => void;
    const rootsEntered = new Promise<void>((resolve) => { markRootsEntered = resolve; });
    client.setRequestHandler(ListRootsRequestSchema, async (_request, extra) => {
      markRootsEntered();
      await new Promise<void>((resolve) => {
        if (extra.signal.aborted) {
          resolve();
          return;
        }
        extra.signal.addEventListener("abort", () => resolve(), { once: true });
      });
      return { roots: [{ uri: pathToFileURL(root.root).href, name: "concurrent" }] };
    });
    const controlFetch = createLocalBridgeMcpHttpControlAwareFetch();
    let toolRequestId: string | number | undefined;
    let toolPostSettlement: Promise<string> | undefined;
    const transport = new StreamableHTTPClientTransport(new URL(http.url), {
      requestInit: authenticatedRequestInit(),
      fetch: async (input, init) => {
        const toolPost = readToolPostRequest(init?.body);
        if (toolPost?.name === "meanthis_resolve_source") toolRequestId = toolPost.id;
        const response = await controlFetch(input, init);
        if (toolPost?.name === "meanthis_resolve_source") {
          toolPostSettlement = response.clone().text();
        }
        return response;
      },
    });
    let markTerminalEntered!: () => void;
    const terminalEntered = new Promise<void>((resolve) => { markTerminalEntered = resolve; });
    let releaseTerminal!: () => void;
    const terminalGate = new Promise<void>((resolve) => { releaseTerminal = resolve; });
    let cancellationTerminalAttempts = 0;
    const originalSend = StreamableHTTPServerTransport.prototype.send;
    const transportSend = vi.spyOn(StreamableHTTPServerTransport.prototype, "send")
      .mockImplementation(async function (message, options) {
        if (
          "error" in message &&
          message.error.code === -32_001 &&
          message.error.message === "Request cancelled."
        ) {
          cancellationTerminalAttempts += 1;
          markTerminalEntered();
          await terminalGate;
        }
        return await originalSend.call(this, message, options);
      });
    let toolCall: Promise<{ kind: "resolved" } | { kind: "rejected" }> | undefined;
    const controller = new AbortController();

    try {
      await client.connect(transport);
      toolCall = client.callTool({
        name: "meanthis_resolve_source",
        arguments: { sourceAnchor: root.anchor },
      }, undefined, { signal: controller.signal }).then(
        () => ({ kind: "resolved" as const }),
        () => ({ kind: "rejected" as const }),
      );
      await settleWithin(rootsEntered, 1_000, "Resolver never reached roots/list.");
      if (toolRequestId === undefined || !transport.sessionId) {
        throw new Error("Expected an active tool request and MCP session.");
      }
      const sendCancellation = () => fetch(http.url, {
        method: "POST",
        headers: {
          accept: "application/json, text/event-stream",
          authorization: `Bearer ${TEST_BEARER_TOKEN}`,
          "content-type": "application/json",
          "mcp-protocol-version": "2025-11-25",
          "mcp-session-id": transport.sessionId!,
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          method: "notifications/cancelled",
          params: { requestId: toolRequestId, reason: "concurrent cancellation" },
        }),
      });

      const firstCancellation = sendCancellation();
      await settleWithin(terminalEntered, 1_000, "First cancellation terminal was not attempted.");
      const secondCancellation = await settleWithin(
        sendCancellation(),
        1_000,
        "Duplicate cancellation waited on the first terminal send.",
      );
      expect(secondCancellation.status).toBe(202);
      expect(cancellationTerminalAttempts).toBe(1);
      controller.abort(new Error("cancel client after duplicate control"));
      expect((await settleWithin(toolCall, 1_000, "Cancelled tool call did not settle.")).kind)
        .toBe("rejected");
      releaseTerminal();
      expect((await firstCancellation).status).toBe(202);
      if (!toolPostSettlement) throw new Error("Expected the tool POST SSE response.");
      const toolPostBody = await settleWithin(
        toolPostSettlement,
        1_000,
        "Cancelled tool POST SSE response did not settle.",
      );
      expect(toolPostBody.match(/"code":-32001/g)).toHaveLength(1);

      const followup = await client.callTool({
        name: "meanthis_list_captures",
        arguments: {},
      });
      expect(JSON.parse(readText(followup))).toMatchObject({
        kind: "ui-attach.capture-list",
      });
      expect((await readHealth(http.origin)).activeSessions).toBe(1);
    } finally {
      controller.abort();
      releaseTerminal();
      transportSend.mockRestore();
      await Promise.allSettled([
        toolCall ?? Promise.resolve(),
        client.close(),
      ]);
      await http.close();
      await Promise.allSettled([toolPostSettlement ?? Promise.resolve("")]);
      await rm(root.root, { recursive: true, force: true });
    }
  });

  test("holds an early cancellation until its tool POST is registered", async () => {
    const root = await createSourceFixture("H", "EarlyCancellation");
    const http = await startTestMcpHttpServer(createSharedReaderState(), { port: 0 });
    const client = new Client(
      { name: "meanthis-delayed-early-cancellation", version: "0.1.0" },
      { capabilities: { roots: { listChanged: false } } },
    );
    let rootsRequestCount = 0;
    let markCancelledRootsEntered!: () => void;
    const cancelledRootsEntered = new Promise<void>((resolve) => {
      markCancelledRootsEntered = resolve;
    });
    let markCancelledRootsAborted!: () => void;
    const cancelledRootsAborted = new Promise<void>((resolve) => {
      markCancelledRootsAborted = resolve;
    });
    client.setRequestHandler(ListRootsRequestSchema, async (_request, extra) => {
      rootsRequestCount += 1;
      if (rootsRequestCount === 1) {
        return { roots: [{ uri: pathToFileURL(root.root).href, name: "warmup" }] };
      }
      markCancelledRootsEntered();
      await new Promise<void>((resolve) => {
        if (extra.signal.aborted) {
          resolve();
          return;
        }
        extra.signal.addEventListener("abort", () => resolve(), { once: true });
      });
      markCancelledRootsAborted();
      return { roots: [{ uri: pathToFileURL(root.root).href, name: "cancelled" }] };
    });
    const controlFetch = createLocalBridgeMcpHttpControlAwareFetch();
    let resolverToolPostCount = 0;
    let markDelayedToolPostHeld!: () => void;
    const delayedToolPostHeld = new Promise<void>((resolve) => {
      markDelayedToolPostHeld = resolve;
    });
    let releaseDelayedToolPost!: () => void;
    const delayedToolPostGate = new Promise<void>((resolve) => {
      releaseDelayedToolPost = resolve;
    });
    let markEarlyCancellationAccepted!: (status: number) => void;
    const earlyCancellationAccepted = new Promise<number>((resolve) => {
      markEarlyCancellationAccepted = resolve;
    });
    let delayedToolPostSettlement: Promise<string> | undefined;
    const transport = new StreamableHTTPClientTransport(new URL(http.url), {
      requestInit: authenticatedRequestInit(),
      fetch: async (input, init) => {
        const toolPost = readToolPostRequest(init?.body);
        if (toolPost?.name === "meanthis_resolve_source") {
          resolverToolPostCount += 1;
          if (resolverToolPostCount === 2) {
            markDelayedToolPostHeld();
            await delayedToolPostGate;
          }
        }
        const isCancellation = typeof init?.body === "string" &&
          (JSON.parse(init.body) as { method?: string }).method === "notifications/cancelled";
        const response = await controlFetch(input, init);
        if (isCancellation) markEarlyCancellationAccepted(response.status);
        if (toolPost?.name === "meanthis_resolve_source" && resolverToolPostCount === 2) {
          delayedToolPostSettlement = response.clone().text();
        }
        return response;
      },
    });
    const controller = new AbortController();
    let cancelledCall: Promise<{ kind: "resolved" } | { kind: "rejected" }> | undefined;

    try {
      await client.connect(transport);
      const warmup = await client.callTool({
        name: "meanthis_resolve_source",
        arguments: { sourceAnchor: root.anchor },
      });
      expect(JSON.parse(readText(warmup))).toMatchObject({ status: "verified" });

      cancelledCall = client.callTool({
        name: "meanthis_resolve_source",
        arguments: { sourceAnchor: root.anchor },
      }, undefined, { signal: controller.signal }).then(
        () => ({ kind: "resolved" as const }),
        () => ({ kind: "rejected" as const }),
      );
      await settleWithin(
        delayedToolPostHeld,
        1_000,
        "The delayed resolver POST was not held before HTTP admission.",
      );
      controller.abort(new Error("cancel before original HTTP admission"));
      expect((await settleWithin(cancelledCall, 1_000, "Client call did not reject.")).kind)
        .toBe("rejected");
      expect(await settleWithin(
        earlyCancellationAccepted,
        1_000,
        "Early cancellation control did not settle immediately.",
      )).toBe(202);

      // This intentionally exceeds the removed 250 ms heuristic. The cancellation
      // is durable session state, not a timing window.
      await delay(300);
      releaseDelayedToolPost();
      await settleWithin(
        cancelledRootsEntered,
        1_000,
        "Delayed resolver never reached roots/list after HTTP admission.",
      );
      await settleWithin(
        cancelledRootsAborted,
        1_000,
        "Durable early cancellation did not abort the roots handler.",
      );

      if (!delayedToolPostSettlement) throw new Error("Expected delayed resolver POST SSE body.");
      const cancelledToolPostBody = await settleWithin(
        delayedToolPostSettlement,
        1_000,
        "Early-cancelled tool POST SSE response did not settle.",
      );
      expect(cancelledToolPostBody).toContain('"code":-32001');
      expect(cancelledToolPostBody).toContain('"message":"Request cancelled."');

      const followup = await settleWithin(
        client.callTool({ name: "meanthis_list_captures", arguments: {} }),
        1_000,
        "Session did not admit a normal tool POST after early cancellation.",
      );
      expect(JSON.parse(readText(followup))).toMatchObject({
        kind: "ui-attach.capture-list",
      });
      expect((await readHealth(http.origin)).activeSessions).toBe(1);
    } finally {
      controller.abort();
      releaseDelayedToolPost();
      await Promise.allSettled([
        cancelledCall ?? Promise.resolve(),
        client.close(),
        delayedToolPostSettlement ?? Promise.resolve(""),
      ]);
      await http.close();
      await rm(root.root, { recursive: true, force: true });
    }
  });

  test("wakes an early cancellation when a fast natural terminal wins before readiness", async () => {
    const http = await startTestMcpHttpServer(createSharedReaderState(), {
      port: 0,
      maxControlRequestsPerSession: 1,
    });
    const initialized = await rawInitialize(http.origin);
    if (!initialized.sessionId) throw new Error("Expected an initialized MCP session.");
    const controlFetch = createLocalBridgeMcpHttpControlAwareFetch();
    const requestId = 421;
    const sendCancellation = (cancelledRequestId: string | number) => controlFetch(http.url, {
      method: "POST",
      headers: {
        accept: "application/json, text/event-stream",
        authorization: `Bearer ${TEST_BEARER_TOKEN}`,
        "content-type": "application/json",
        "mcp-protocol-version": "2025-11-25",
        "mcp-session-id": initialized.sessionId!,
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        method: "notifications/cancelled",
        params: { requestId: cancelledRequestId, reason: "fast natural terminal race" },
      }),
    });
    const cancellationRequests = [sendCancellation(requestId), sendCancellation(requestId)];
    let releaseCancellationReadiness!: () => void;
    const cancellationReadinessGate = new Promise<void>((resolve) => {
      releaseCancellationReadiness = resolve;
    });
    let markCancellationReadinessBlocked!: () => void;
    const cancellationReadinessBlocked = new Promise<void>((resolve) => {
      markCancellationReadinessBlocked = resolve;
    });
    const originalSetImmediate = globalThis.setImmediate;
    const setImmediateSpy = vi.spyOn(globalThis, "setImmediate")
      .mockImplementation(((callback, ...args) => originalSetImmediate(
        (...callbackArgs: unknown[]) => {
          if (callback.name !== "allowSessionRequestCancellation") {
            Reflect.apply(callback, undefined, callbackArgs);
            return;
          }
          markCancellationReadinessBlocked();
          void cancellationReadinessGate.then(() => {
            Reflect.apply(callback, undefined, callbackArgs);
          });
        },
        ...args,
      )) as typeof setImmediate);

    try {
      const controlResponses = await settleWithin(
        Promise.all(cancellationRequests),
        1_000,
        "Duplicate early cancellation intents did not settle immediately.",
      );
      expect(controlResponses.map((response) => response.status)).toEqual([202, 202]);

      const fastToolPost = rawSessionJsonRpc(http.origin, initialized.sessionId, {
        jsonrpc: "2.0",
        id: requestId,
        method: "tools/call",
        params: { name: "meanthis_list_captures", arguments: {} },
      });
      await settleWithin(
        cancellationReadinessBlocked,
        1_000,
        "Fast tool POST did not reach the held cancellation-readiness turn.",
      );
      const toolResponse = await settleWithin(
        fastToolPost,
        1_000,
        "Natural terminal did not wake its early cancellation waiter.",
      );
      expect(toolResponse.status).toBe(200);
      expect(toolResponse.body).toContain("ui-attach.capture-list");
      expect(toolResponse.body).not.toContain('"message":"Request cancelled."');

      const followupControl = await settleWithin(
        sendCancellation("after-fast-natural-terminal"),
        1_000,
        "Control capacity was not reusable after the natural-terminal race.",
      );
      expect(followupControl.status).toBe(202);
      expect((await readHealth(http.origin)).activeSessions).toBe(1);
    } finally {
      releaseCancellationReadiness();
      setImmediateSpy.mockRestore();
      await http.close();
      await Promise.allSettled(cancellationRequests);
    }
  });

  test("fails closed when typed early cancellation intents exceed their session bound", async () => {
    const http = await startTestMcpHttpServer(createSharedReaderState(), {
      port: 0,
      maxControlRequestsPerSession: 4,
    });
    const initialized = await rawInitialize(http.origin);
    if (!initialized.sessionId) throw new Error("Expected an initialized MCP session.");
    const controlFetch = createLocalBridgeMcpHttpControlAwareFetch();
    const sendCancellation = (requestId: string | number) => controlFetch(http.url, {
      method: "POST",
      headers: {
        accept: "application/json, text/event-stream",
        authorization: `Bearer ${TEST_BEARER_TOKEN}`,
        "content-type": "application/json",
        "mcp-protocol-version": "2025-11-25",
        "mcp-session-id": initialized.sessionId!,
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        method: "notifications/cancelled",
        params: { requestId, reason: "bounded early intent" },
      }),
    });

    try {
      await expect(sendCancellation(1)).resolves.toMatchObject({ status: 202 });
      await expect(sendCancellation(1)).resolves.toMatchObject({ status: 202 });
      await expect(sendCancellation("1")).resolves.toMatchObject({ status: 202 });
      await expect(sendCancellation("\ud800")).resolves.toMatchObject({ status: 202 });
      await expect(sendCancellation("\ufffd")).resolves.toMatchObject({ status: 202 });
      await expect(sendCancellation("overflow")).resolves.toMatchObject({ status: 503 });
      expect((await readHealth(http.origin)).activeSessions).toBe(0);

      const replacement = await rawInitialize(http.origin);
      expect(replacement.status).toBe(200);
      expect(replacement.sessionId).not.toBeNull();
    } finally {
      await http.close();
    }
  });

  test("fails closed when a cancelled request terminal cannot be sent", async () => {
    const root = await createSourceFixture("F", "FailedCancelTerminal");
    const http = await startTestMcpHttpServer(createSharedReaderState(), { port: 0 });
    const client = new Client(
      { name: "meanthis-cancel-terminal-failure", version: "0.1.0" },
      { capabilities: { roots: { listChanged: false } } },
    );
    let markRootsEntered!: () => void;
    const rootsEntered = new Promise<void>((resolve) => { markRootsEntered = resolve; });
    client.setRequestHandler(ListRootsRequestSchema, async (_request, extra) => {
      markRootsEntered();
      await new Promise<void>((resolve) => {
        if (extra.signal.aborted) {
          resolve();
          return;
        }
        extra.signal.addEventListener("abort", () => resolve(), { once: true });
      });
      return { roots: [{ uri: pathToFileURL(root.root).href, name: "failed-terminal" }] };
    });
    const controlFetch = createLocalBridgeMcpHttpControlAwareFetch();
    let resolverPostSettlement: Promise<string> | undefined;
    const transport = new StreamableHTTPClientTransport(new URL(http.url), {
      requestInit: authenticatedRequestInit(),
      fetch: async (input, init) => {
        const toolPost = readToolPostRequest(init?.body);
        const response = await controlFetch(input, init);
        if (toolPost?.name === "meanthis_resolve_source") {
          resolverPostSettlement = response.clone().text();
        }
        return response;
      },
    });
    const controller = new AbortController();
    let call: Promise<{ kind: "resolved" } | { kind: "rejected" }> | undefined;
    let terminalSendFailures = 0;
    let transportSend: ReturnType<typeof vi.spyOn> | undefined;
    let replacement: Client | undefined;

    try {
      await client.connect(transport);
      call = client.callTool(
        {
          name: "meanthis_resolve_source",
          arguments: { sourceAnchor: root.anchor },
        },
        undefined,
        { signal: controller.signal },
      ).then(
        () => ({ kind: "resolved" as const }),
        () => ({ kind: "rejected" as const }),
      );
      await settleWithin(rootsEntered, 1_000, "Resolver never reached roots/list.");

      const originalSend = StreamableHTTPServerTransport.prototype.send;
      transportSend = vi.spyOn(
        StreamableHTTPServerTransport.prototype,
        "send",
      ).mockImplementation(async function (message, options) {
        if (
          "error" in message &&
          message.error.code === -32_001 &&
          message.error.message === "Request cancelled."
        ) {
          terminalSendFailures += 1;
          throw new Error("injected cancellation terminal failure");
        }
        return await originalSend.call(this, message, options);
      });
      controller.abort(new Error("cancel with failed terminal"));

      expect((await settleWithin(call, 1_000, "Cancelled call did not reject.")).kind)
        .toBe("rejected");
      if (!resolverPostSettlement) throw new Error("Expected resolver POST SSE settlement.");
      await settleWithin(
        resolverPostSettlement,
        1_000,
        "Fail-closed resolver POST SSE did not settle.",
      );
      expect(terminalSendFailures).toBe(1);
      expect((await readHealth(http.origin)).activeSessions).toBe(0);

      transportSend.mockRestore();
      transportSend = undefined;
      replacement = new Client({ name: "meanthis-after-cancel-failure", version: "0.1.0" });
      await replacement.connect(createControlAwareAuthenticatedTransport(http.url));
      const replacementCall = await replacement.callTool({
        name: "meanthis_list_captures",
        arguments: {},
      });
      expect(JSON.parse(readText(replacementCall))).toMatchObject({
        kind: "ui-attach.capture-list",
      });
    } finally {
      controller.abort();
      transportSend?.mockRestore();
      await Promise.allSettled([
        call ?? Promise.resolve(),
        replacement?.close() ?? Promise.resolve(),
        client.close(),
      ]);
      await http.close();
      await Promise.allSettled([resolverPostSettlement ?? Promise.resolve("")]);
      await rm(root.root, { recursive: true, force: true });
    }
  });

  test("rejects duplicate request IDs without conflating numeric and string IDs", async () => {
    for (const duplicateId of [71, "71"] as const) {
      const http = await startTestMcpHttpServer(createSharedReaderState(), { port: 0 });
      const initialized = await rawInitialize(http.origin);
      if (!initialized.sessionId) throw new Error("Expected an initialized MCP session.");
      const originalSend = StreamableHTTPServerTransport.prototype.send;
      let markResultEntered!: () => void;
      let releaseResult!: () => void;
      const resultEntered = new Promise<void>((resolve) => { markResultEntered = resolve; });
      const resultGate = new Promise<void>((resolve) => { releaseResult = resolve; });
      const send = vi.spyOn(StreamableHTTPServerTransport.prototype, "send")
        .mockImplementation(async function (message, options) {
          if (("result" in message || "error" in message) && message.id === duplicateId) {
            markResultEntered();
            await resultGate;
          }
          return await originalSend.call(this, message, options);
        });
      const first = rawSessionJsonRpc(http.origin, initialized.sessionId, {
        jsonrpc: "2.0",
        id: duplicateId,
        method: "tools/call",
        params: { name: "meanthis_list_captures", arguments: {} },
      });
      try {
        await settleWithin(resultEntered, 1_000, "First duplicate-ID request did not reach result send.");
        const duplicate = await settleWithin(
          rawSessionJsonRpc(http.origin, initialized.sessionId, {
            jsonrpc: "2.0",
            id: duplicateId,
            method: "tools/call",
            params: { name: "meanthis_list_captures", arguments: {} },
          }),
          1_000,
          "Duplicate request ID was not rejected.",
        );
        expect(duplicate).toMatchObject({ status: 400 });
        expect(duplicate.body).toContain("Duplicate request ID.");
        expect((await readHealth(http.origin)).activeSessions).toBe(0);
      } finally {
        releaseResult();
        await Promise.allSettled([first]);
        send.mockRestore();
        await http.close();
      }
    }

    const http = await startTestMcpHttpServer(createSharedReaderState(), { port: 0 });
    const initialized = await rawInitialize(http.origin);
    if (!initialized.sessionId) throw new Error("Expected an initialized MCP session.");
    try {
      const withinBatch = await rawSessionJsonRpc(http.origin, initialized.sessionId, [
        {
          jsonrpc: "2.0",
          id: 81,
          method: "tools/call",
          params: { name: "meanthis_list_captures", arguments: {} },
        },
        {
          jsonrpc: "2.0",
          id: 81,
          method: "tools/call",
          params: { name: "meanthis_list_captures", arguments: {} },
        },
      ]);
      expect(withinBatch).toMatchObject({ status: 400 });
      expect(withinBatch.body).toContain("Duplicate request ID.");
      expect((await readHealth(http.origin)).activeSessions).toBe(0);
    } finally {
      await http.close();
    }

    const distinctHttp = await startTestMcpHttpServer(createSharedReaderState(), { port: 0 });
    const distinctSession = await rawInitialize(distinctHttp.origin);
    if (!distinctSession.sessionId) throw new Error("Expected an initialized MCP session.");
    try {
      const [numeric, string] = await Promise.all([
        rawSessionJsonRpc(distinctHttp.origin, distinctSession.sessionId, {
          jsonrpc: "2.0",
          id: 91,
          method: "tools/call",
          params: { name: "meanthis_list_captures", arguments: {} },
        }),
        rawSessionJsonRpc(distinctHttp.origin, distinctSession.sessionId, {
          jsonrpc: "2.0",
          id: "91",
          method: "tools/call",
          params: { name: "meanthis_list_captures", arguments: {} },
        }),
      ]);
      expect([numeric.status, string.status]).toEqual([200, 200]);
      expect((await readHealth(distinctHttp.origin)).activeSessions).toBe(1);
    } finally {
      await distinctHttp.close();
    }
  });

  test("authenticates health and every MCP method before parsing or session lookup", async () => {
    const http = await startTestMcpHttpServer(createLocalBridgeState(), { port: 0 });
    const client = new Client({ name: "meanthis-auth", version: "0.1.0" });
    const transport = createAuthenticatedTransport(http.url);
    try {
      await client.connect(transport);
      const before = await readHealth(http.origin);
      expect(before).toMatchObject({ activeSessions: 1, retainedSessions: 1 });

      const unauthorizedResponses = await Promise.all([
        fetch(http.url, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: "not-json",
        }),
        fetch(http.url, {
          method: "GET",
          headers: {
            accept: "text/event-stream",
            authorization: `Bearer ${WRONG_BEARER_TOKEN}`,
          },
        }),
        fetch(http.url, {
          method: "DELETE",
          headers: { authorization: "Basic malformed" },
        }),
      ]);
      const unauthorizedHealth = await fetch(`${http.origin}/health`);
      const unauthorizedBodies = await Promise.all(
        unauthorizedResponses.map((response) => response.text()),
      );
      const unauthorizedHealthBody = await unauthorizedHealth.text();

      for (const response of unauthorizedResponses) {
        expect(response.status).toBe(401);
        expect(response.headers.get("www-authenticate")).toBe('Bearer realm="meanthis-mcp"');
      }
      expect(unauthorizedHealth.status).toBe(401);
      expect(unauthorizedHealth.headers.get("www-authenticate"))
        .toBe('MeanThis-HMAC realm="meanthis-mcp-health"');
      for (const body of unauthorizedBodies) {
        expect(body).toBe(unauthorizedBodies[0]);
        expect(JSON.parse(body)).toMatchObject({
          error: { code: -32001, message: "Unauthorized." },
        });
      }
      expect(unauthorizedHealthBody).toBe(unauthorizedBodies[0]);
      const unauthorizedText = [...unauthorizedBodies, unauthorizedHealthBody].join("");
      expect(unauthorizedText).not.toContain(TEST_BEARER_TOKEN);
      expect(unauthorizedText).not.toContain(WRONG_BEARER_TOKEN);
      expect(await readHealth(http.origin)).toMatchObject({
        activeSessions: 1,
        retainedSessions: 1,
      });
      await expect(client.listTools()).resolves.toMatchObject({ tools: expect.any(Array) });
    } finally {
      await Promise.allSettled([client.close()]);
      await http.close();
    }
  });

  test("fails closed on forged, malformed, or unbound broker control admission", async () => {
    const http = await startTestMcpHttpServer(createLocalBridgeState(), { port: 0 });
    const initialized = await rawInitialize(http.origin);
    if (!initialized.sessionId) throw new Error("Expected an initialized MCP session.");
    const baseHeaders = {
      authorization: `Bearer ${TEST_BEARER_TOKEN}`,
      "content-type": "application/json",
      "mcp-protocol-version": "2025-06-18",
    };

    try {
      const responses = await Promise.all([
        fetch(http.url, {
          method: "POST",
          headers: {
            ...baseHeaders,
            [MEANTHIS_MCP_HTTP_CONTROL_HEADER]: "wrong",
            "mcp-session-id": initialized.sessionId,
          },
          body: "not-json",
        }),
        fetch(http.url, {
          method: "POST",
          headers: {
            ...baseHeaders,
            [MEANTHIS_MCP_HTTP_CONTROL_HEADER]: MEANTHIS_MCP_HTTP_CONTROL_VALUE,
          },
          body: JSON.stringify({ jsonrpc: "2.0", id: 11, result: {} }),
        }),
        fetch(http.url, {
          method: "POST",
          headers: {
            ...baseHeaders,
            [MEANTHIS_MCP_HTTP_CONTROL_HEADER]: MEANTHIS_MCP_HTTP_CONTROL_VALUE,
            "mcp-session-id": initialized.sessionId,
          },
          body: JSON.stringify({ jsonrpc: "2.0", id: 12, method: "ping" }),
        }),
        fetch(http.url, {
          method: "DELETE",
          headers: {
            authorization: `Bearer ${TEST_BEARER_TOKEN}`,
            [MEANTHIS_MCP_HTTP_CONTROL_HEADER]: MEANTHIS_MCP_HTTP_CONTROL_VALUE,
            "mcp-protocol-version": "2025-06-18",
            "mcp-session-id": initialized.sessionId,
          },
          body: "x",
        }),
      ]);
      const bodies = await Promise.all(responses.map((response) => response.text()));

      expect(responses.map((response) => response.status)).toEqual([400, 400, 400, 400]);
      expect(responses.map((response) => response.headers.get("connection")))
        .toEqual(["close", "close", "close", "close"]);
      for (const body of bodies) {
        expect(JSON.parse(body)).toMatchObject({
          error: { code: -32600, message: "Invalid control request." },
        });
      }
      expect(await readHealth(http.origin)).toMatchObject({ activeSessions: 1 });
    } finally {
      await http.close();
    }
  });

  test("rejects every non-empty or ambiguous health framing before proof validation", async () => {
    const http = await startTestMcpHttpServer(createLocalBridgeState(), { port: 0 });
    const port = Number(new URL(http.origin).port);
    try {
      const malformedWithoutProof = await rawSocketRequest(
        http.origin,
        createRawHealthRequest(port, {}, ["Content-Length: 1"], "x"),
      );
      expect(malformedWithoutProof.status).toBe(400);
      expect(malformedWithoutProof.headers.connection).toBe("close");

      const framingCases = [
        { name: "non-empty", headers: ["Content-Length: 1"], body: "x" },
        { name: "chunked", headers: ["Transfer-Encoding: chunked"], body: "0\r\n\r\n" },
        { name: "duplicate", headers: ["Content-Length: 0", "Content-Length: 0"], body: "" },
        { name: "comma-joined", headers: ["Content-Length: 0, 0"], body: "" },
        { name: "non-canonical zero", headers: ["Content-Length: 00"], body: "" },
        {
          name: "conflicting transfer encoding",
          headers: ["Content-Length: 0", "Transfer-Encoding: chunked"],
          body: "0\r\n\r\n",
        },
      ] as const;

      for (const [index, framing] of framingCases.entries()) {
        const proof = createLocalBridgeMcpHttpHealthProofRequest(TEST_BEARER_TOKEN, {
          port,
          randomBytes: () => Buffer.alloc(32, index + 10),
        });
        const rejected = await rawSocketRequest(
          http.origin,
          createRawHealthRequest(port, proof.headers, framing.headers, framing.body),
        );
        expect(rejected.status, framing.name).toBe(400);
        expect(rejected.headers.connection, framing.name).toBe("close");

        const retried = await fetch(`${http.origin}/health`, { headers: proof.headers });
        expect(retried.status, `${framing.name} nonce reuse`).toBe(200);
        await retried.text();
      }

      const explicitZeroProof = createLocalBridgeMcpHttpHealthProofRequest(TEST_BEARER_TOKEN, {
        port,
        randomBytes: () => Buffer.alloc(32, 30),
      });
      const explicitZero = await rawGet(http.origin, "/health", {
        ...explicitZeroProof.headers,
        "Content-Length": "0",
      });
      expect(explicitZero.status).toBe(200);
    } finally {
      await http.close();
    }
  });

  test("binds health proof to fresh nonce, request, response, and body without bearer disclosure", async () => {
    const http = await startTestMcpHttpServer(createLocalBridgeState(), { port: 0 });
    const port = Number(new URL(http.origin).port);
    const requestProof = createLocalBridgeMcpHttpHealthProofRequest(TEST_BEARER_TOKEN, {
      port,
      randomBytes: () => Buffer.alloc(32, 3),
    });
    try {
      expect(JSON.stringify(requestProof.headers)).not.toContain(TEST_BEARER_TOKEN);
      expect(new Headers(requestProof.headers).get("authorization")).toBeNull();

      const malleatedRequestProofValue = malleateBase64urlPadBits(requestProof.proof);
      expect(Buffer.from(malleatedRequestProofValue, "base64url"))
        .toEqual(Buffer.from(requestProof.proof, "base64url"));
      const malleatedRequestProof = {
        ...requestProof,
        proof: malleatedRequestProofValue,
        headers: {
          ...requestProof.headers,
          [MEANTHIS_MCP_HTTP_HEALTH_PROOF_HEADER]: malleatedRequestProofValue,
        },
      };
      const rejectedMalleatedProof = await fetch(`${http.origin}/health`, {
        headers: malleatedRequestProof.headers,
      });
      expect(rejectedMalleatedProof.status).toBe(401);
      expect(rejectedMalleatedProof.headers.get("connection")).toBe("close");
      await rejectedMalleatedProof.text();

      const nonCanonicalNonce = malleateBase64urlPadBits(
        Buffer.alloc(32, 6).toString("base64url"),
      );
      const requestWithNonCanonicalNonce = createCustomHealthProofRequest({
        port,
        nonce: nonCanonicalNonce,
      });
      expect((await fetch(`${http.origin}/health`, {
        headers: requestWithNonCanonicalNonce.headers,
      })).status).toBe(401);
      expect(() => createLocalBridgeMcpHttpHealthProofResponse(
        TEST_BEARER_TOKEN,
        { ...requestProof, nonce: nonCanonicalNonce },
        "{}\n",
        { port },
      )).toThrow("health proof request");

      const response = await fetch(`${http.origin}/health`, { headers: requestProof.headers });
      const body = await response.text();
      expect(response.status).toBe(200);
      expect(verifyLocalBridgeMcpHttpHealthProofResponse(
        TEST_BEARER_TOKEN,
        requestProof,
        { port, status: response.status, headers: response.headers, body },
      )).toBe(true);

      const responseTimestamp = response.headers.get(
        MEANTHIS_MCP_HTTP_HEALTH_RESPONSE_TIMESTAMP_HEADER,
      );
      const responseNonce = response.headers.get(MEANTHIS_MCP_HTTP_HEALTH_RESPONSE_NONCE_HEADER);
      const responseProof = response.headers.get(MEANTHIS_MCP_HTTP_HEALTH_RESPONSE_PROOF_HEADER);
      if (!responseTimestamp || !responseNonce || !responseProof) {
        throw new Error("Expected authenticated health response headers.");
      }
      const tamperedTimestampHeaders = new Headers(response.headers);
      tamperedTimestampHeaders.set(
        MEANTHIS_MCP_HTTP_HEALTH_RESPONSE_TIMESTAMP_HEADER,
        String(Number(responseTimestamp) + 1),
      );
      expect(verifyLocalBridgeMcpHttpHealthProofResponse(
        TEST_BEARER_TOKEN,
        requestProof,
        { port, status: response.status, headers: tamperedTimestampHeaders, body },
      )).toBe(false);

      const tamperedNonceHeaders = new Headers(response.headers);
      tamperedNonceHeaders.set(
        MEANTHIS_MCP_HTTP_HEALTH_RESPONSE_NONCE_HEADER,
        tamperCanonicalBase64url(responseNonce),
      );
      expect(verifyLocalBridgeMcpHttpHealthProofResponse(
        TEST_BEARER_TOKEN,
        requestProof,
        { port, status: response.status, headers: tamperedNonceHeaders, body },
      )).toBe(false);

      const malleatedResponseNonceHeaders = new Headers(response.headers);
      malleatedResponseNonceHeaders.set(
        MEANTHIS_MCP_HTTP_HEALTH_RESPONSE_NONCE_HEADER,
        malleateBase64urlPadBits(responseNonce),
      );
      expect(verifyLocalBridgeMcpHttpHealthProofResponse(
        TEST_BEARER_TOKEN,
        requestProof,
        { port, status: response.status, headers: malleatedResponseNonceHeaders, body },
      )).toBe(false);

      const tamperedProofHeaders = new Headers(response.headers);
      tamperedProofHeaders.set(
        MEANTHIS_MCP_HTTP_HEALTH_RESPONSE_PROOF_HEADER,
        tamperCanonicalBase64url(responseProof),
      );
      expect(verifyLocalBridgeMcpHttpHealthProofResponse(
        TEST_BEARER_TOKEN,
        requestProof,
        { port, status: response.status, headers: tamperedProofHeaders, body },
      )).toBe(false);

      const malleatedResponseProofHeaders = new Headers(response.headers);
      malleatedResponseProofHeaders.set(
        MEANTHIS_MCP_HTTP_HEALTH_RESPONSE_PROOF_HEADER,
        malleateBase64urlPadBits(responseProof),
      );
      expect(verifyLocalBridgeMcpHttpHealthProofResponse(
        TEST_BEARER_TOKEN,
        requestProof,
        { port, status: response.status, headers: malleatedResponseProofHeaders, body },
      )).toBe(false);

      expect(verifyLocalBridgeMcpHttpHealthProofResponse(
        TEST_BEARER_TOKEN,
        requestProof,
        { port, status: response.status, headers: response.headers, body: `${body} ` },
      )).toBe(false);
      expect(verifyLocalBridgeMcpHttpHealthProofResponse(
        TEST_BEARER_TOKEN,
        requestProof,
        { port, status: 201, headers: response.headers, body },
      )).toBe(false);
      expect(verifyLocalBridgeMcpHttpHealthProofResponse(
        TEST_BEARER_TOKEN,
        requestProof,
        { port: port === 65_535 ? port - 1 : port + 1, status: response.status, headers: response.headers, body },
      )).toBe(false);

      const otherRequestProof = createLocalBridgeMcpHttpHealthProofRequest(TEST_BEARER_TOKEN, {
        port,
        randomBytes: () => Buffer.alloc(32, 34),
      });
      expect(verifyLocalBridgeMcpHttpHealthProofResponse(
        TEST_BEARER_TOKEN,
        otherRequestProof,
        { port, status: response.status, headers: response.headers, body },
      )).toBe(false);

      const expiredResponseBody = "{}\n";
      const expiredResponseProof = createLocalBridgeMcpHttpHealthProofResponse(
        TEST_BEARER_TOKEN,
        otherRequestProof,
        expiredResponseBody,
        {
          port,
          status: 200,
          now: () => Date.now() - 30_001,
          randomBytes: () => Buffer.alloc(32, 35),
        },
      );
      expect(verifyLocalBridgeMcpHttpHealthProofResponse(
        TEST_BEARER_TOKEN,
        otherRequestProof,
        {
          port,
          status: 200,
          headers: new Headers(expiredResponseProof.headers),
          body: expiredResponseBody,
        },
      )).toBe(false);

      const replay = await fetch(`${http.origin}/health`, { headers: requestProof.headers });
      expect(replay.status).toBe(401);
      const expired = createLocalBridgeMcpHttpHealthProofRequest(TEST_BEARER_TOKEN, {
        port,
        now: () => Date.now() - 30_001,
        randomBytes: () => Buffer.alloc(32, 4),
      });
      expect((await fetch(`${http.origin}/health`, { headers: expired.headers })).status).toBe(401);
      const future = createLocalBridgeMcpHttpHealthProofRequest(TEST_BEARER_TOKEN, {
        port,
        now: () => Date.now() + 60_000,
        randomBytes: () => Buffer.alloc(32, 31),
      });
      expect((await fetch(`${http.origin}/health`, { headers: future.headers })).status).toBe(401);
      const wrongKey = createLocalBridgeMcpHttpHealthProofRequest(WRONG_BEARER_TOKEN, {
        port,
        randomBytes: () => Buffer.alloc(32, 5),
      });
      expect((await fetch(`${http.origin}/health`, { headers: wrongKey.headers })).status).toBe(401);

      const wrongPort = createLocalBridgeMcpHttpHealthProofRequest(TEST_BEARER_TOKEN, {
        port: port === 65_535 ? port - 1 : port + 1,
        randomBytes: () => Buffer.alloc(32, 32),
      });
      expect((await fetch(`${http.origin}/health`, { headers: wrongPort.headers })).status).toBe(401);

      const wrongHost = createCustomHealthProofRequest({
        port,
        host: `localhost:${port}`,
        nonce: Buffer.alloc(32, 33).toString("base64url"),
      });
      expect((await fetch(`${http.origin}/health`, { headers: wrongHost.headers })).status).toBe(401);

      for (const [index, canonicalOverride] of [
        { method: "POST" },
        { path: "/health/" },
      ].entries()) {
        const tamperedCanonical = createCustomHealthProofRequest({
          port,
          nonce: Buffer.alloc(32, index + 40).toString("base64url"),
          ...canonicalOverride,
        });
        expect((await fetch(`${http.origin}/health`, {
          headers: tamperedCanonical.headers,
        })).status).toBe(401);
      }
    } finally {
      await http.close();
    }
  });

  test("bounds the health nonce cache and admits fresh proofs after expiry", async () => {
    const http = await startTestMcpHttpServer(createLocalBridgeState(), { port: 0 });
    const port = Number(new URL(http.origin).port);
    let now = Date.now();
    const dateNow = vi.spyOn(Date, "now").mockImplementation(() => now);
    try {
      const statuses: number[] = [];
      for (let batchStart = 0; batchStart < 1_024; batchStart += 64) {
        const batch = Array.from({ length: 64 }, (_, offset) => {
          const index = batchStart + offset;
          const nonceBytes = Buffer.alloc(32);
          nonceBytes.writeUInt32BE(index, 28);
          const proof = createLocalBridgeMcpHttpHealthProofRequest(TEST_BEARER_TOKEN, {
            port,
            now: () => now,
            randomBytes: () => nonceBytes,
          });
          return fetch(`${http.origin}/health`, { headers: proof.headers }).then(async (response) => {
            await response.text();
            return response.status;
          });
        });
        statuses.push(...await Promise.all(batch));
      }
      expect(statuses).toHaveLength(1_024);
      expect(new Set(statuses)).toEqual(new Set([200]));

      const capped = createLocalBridgeMcpHttpHealthProofRequest(TEST_BEARER_TOKEN, {
        port,
        now: () => now,
        randomBytes: () => Buffer.alloc(32, 250),
      });
      const cappedResponse = await fetch(`${http.origin}/health`, { headers: capped.headers });
      expect(cappedResponse.status).toBe(401);
      expect(cappedResponse.headers.get("connection")).toBe("close");
      await cappedResponse.text();

      now += 30_001;
      const afterExpiry = createLocalBridgeMcpHttpHealthProofRequest(TEST_BEARER_TOKEN, {
        port,
        now: () => now,
        randomBytes: () => Buffer.alloc(32, 251),
      });
      const admitted = await fetch(`${http.origin}/health`, { headers: afterExpiry.headers });
      expect(admitted.status).toBe(200);
      await admitted.text();
    } finally {
      dateNow.mockRestore();
      await http.close();
    }
  }, 30_000);

  test("reports no MCP build identity unless the transport caller injects one", async () => {
    const http = await startLocalBridgeMcpHttpServer(createLocalBridgeState(), {
      bearerToken: TEST_BEARER_TOKEN,
      port: 0,
    });
    try {
      const health = await readHealth(http.origin);
      expect(health).toMatchObject({ ownerIdentity: null });
      expect(isLocalBridgeMcpHttpHealth(health)).toBe(true);
    } finally {
      await http.close();
    }
  });

  test("fails startup without a valid independent v1 key or bounded capacity", async () => {
    await expect(startLocalBridgeMcpHttpServer(createLocalBridgeState(), {
      bearerToken: "too-short",
      port: 0,
    })).rejects.toThrow(MEANTHIS_MCP_HTTP_TOKEN_ENV);
    await expect(startLocalBridgeMcpHttpServer(createLocalBridgeState(), {
      bearerToken: `${"A".repeat(42)}B`,
      port: 0,
    })).rejects.toThrow(MEANTHIS_MCP_HTTP_TOKEN_ENV);
    await expect(startLocalBridgeMcpHttpServer(createLocalBridgeState(), {
      bearerToken: TEST_BEARER_TOKEN,
      maxSessions: 0,
      port: 0,
    })).rejects.toThrow("max sessions");
    for (const options of [
      { maxControlInFlightRequests: 0 },
      { maxControlRequestsPerSession: 0 },
      { maxInFlightRequests: 0 },
      { maxRequestsPerSession: 0 },
      { maxSockets: 0 },
      { maxSseConnectionsPerSession: 0 },
    ]) {
      await expect(startLocalBridgeMcpHttpServer(createLocalBridgeState(), {
        bearerToken: TEST_BEARER_TOKEN,
        port: 0,
        ...options,
      })).rejects.toThrow("limit");
    }
    await expect(startLocalBridgeMcpHttpServer(createLocalBridgeState(), {
      bearerToken: TEST_BEARER_TOKEN,
      ownerIdentity: { buildHash: "not-a-build-hash" },
      port: 0,
    })).rejects.toThrow("owner identity");

    const originalBearerToken = process.env[MEANTHIS_MCP_HTTP_TOKEN_ENV];
    delete process.env[MEANTHIS_MCP_HTTP_TOKEN_ENV];
    try {
      await expect(runLocalBridgeMcpHttpServer(0))
        .rejects.toThrow(MEANTHIS_MCP_HTTP_TOKEN_ENV);
    } finally {
      if (originalBearerToken === undefined) {
        delete process.env[MEANTHIS_MCP_HTTP_TOKEN_ENV];
      } else {
        process.env[MEANTHIS_MCP_HTTP_TOKEN_ENV] = originalBearerToken;
      }
    }
  });

  test("counts initializing resources toward the bounded session capacity", async () => {
    const originalHandleRequest = StreamableHTTPServerTransport.prototype.handleRequest;
    let markHandleEntered!: () => void;
    let releaseHandle!: () => void;
    const handleEntered = new Promise<void>((resolve) => { markHandleEntered = resolve; });
    const handleGate = new Promise<void>((resolve) => { releaseHandle = resolve; });
    const handleRequest = vi.spyOn(
      StreamableHTTPServerTransport.prototype,
      "handleRequest",
    ).mockImplementationOnce(async function (request, response, body) {
      markHandleEntered();
      await handleGate;
      await originalHandleRequest.call(this, request, response, body);
    });
    const http = await startTestMcpHttpServer(createLocalBridgeState(), {
      maxSessions: 1,
      port: 0,
      sessionDisconnectGraceMs: 30,
      sessionIdleTtlMs: 100,
    });
    let pendingInitialize: ReturnType<typeof rawInitialize> | undefined;

    try {
      pendingInitialize = rawInitialize(http.origin);
      await handleEntered;

      const rejected = await rawMcpPostBody(http.origin, "not-json");
      expect(rejected).toMatchObject({
        status: 503,
        connection: "close",
        sessionId: null,
      });
      expect(JSON.parse(rejected.body)).toMatchObject({
        error: { code: -32002, message: "MCP session capacity reached." },
      });
      expect(handleRequest).toHaveBeenCalledTimes(1);
      expect(await readHealth(http.origin)).toMatchObject({
        activeSessions: 0,
        retainedSessions: 1,
        maxSessions: 1,
      });

      releaseHandle();
      expect(await pendingInitialize).toMatchObject({ status: 200 });
    } finally {
      releaseHandle();
      if (pendingInitialize) await Promise.allSettled([pendingInitialize]);
      handleRequest.mockRestore();
      await http.close();
    }
  });

  test("bounds concurrent initialization before SDK handling and recovers after release", async () => {
    const originalHandleRequest = StreamableHTTPServerTransport.prototype.handleRequest;
    let entered = 0;
    let markAllEntered!: () => void;
    let releaseHandles!: () => void;
    const allEntered = new Promise<void>((resolve) => { markAllEntered = resolve; });
    const handleGate = new Promise<void>((resolve) => { releaseHandles = resolve; });
    const handleRequest = vi.spyOn(
      StreamableHTTPServerTransport.prototype,
      "handleRequest",
    ).mockImplementation(async function (
      this: StreamableHTTPServerTransport,
      request,
      response,
      body,
    ) {
      if (!request.headers["mcp-session-id"] && entered < 4) {
        entered += 1;
        if (entered === 4) markAllEntered();
        await handleGate;
      }
      await originalHandleRequest.call(this, request, response, body);
    });
    const http = await startTestMcpHttpServer(createLocalBridgeState(), {
      maxInFlightRequests: 4,
      maxSessions: 8,
      port: 0,
    });
    const pendingInitializations = Array.from({ length: 4 }, () => rawInitialize(http.origin));

    try {
      await allEntered;

      const rejected = await rawSocketRequest(
        http.origin,
        createRawMcpPostRequest(http.port, "not-json"),
      );
      expect(rejected).toMatchObject({
        status: 503,
        headers: { connection: "close" },
      });
      expect(rejected.body).toContain('\"message\":\"Server busy.\"');
      expect(handleRequest).toHaveBeenCalledTimes(4);

      releaseHandles();
      const admitted = await Promise.all(pendingInitializations);
      expect(admitted.map((response) => response.status)).toEqual([200, 200, 200, 200]);
      await expect(rawInitialize(http.origin)).resolves.toMatchObject({ status: 200 });
    } finally {
      releaseHandles();
      await Promise.allSettled(pendingInitializations);
      handleRequest.mockRestore();
      await http.close();
    }
  });

  test("bounds same-session POST handling before the SDK and recovers after release", async () => {
    const http = await startTestMcpHttpServer(createLocalBridgeState(), {
      maxInFlightRequests: 8,
      maxRequestsPerSession: 2,
      maxSessions: 2,
      port: 0,
    });
    const initialized = await rawInitialize(http.origin);
    if (!initialized.sessionId) throw new Error("Expected an initialized MCP session.");
    const originalHandleRequest = StreamableHTTPServerTransport.prototype.handleRequest;
    let entered = 0;
    let markBothEntered!: () => void;
    let releaseHandles!: () => void;
    const bothEntered = new Promise<void>((resolve) => { markBothEntered = resolve; });
    const handleGate = new Promise<void>((resolve) => { releaseHandles = resolve; });
    const handleRequest = vi.spyOn(
      StreamableHTTPServerTransport.prototype,
      "handleRequest",
    ).mockImplementation(async function (
      this: StreamableHTTPServerTransport,
      request,
      response,
      body,
    ) {
      if (
        request.method === "POST" &&
        request.headers["mcp-session-id"] === initialized.sessionId &&
        entered < 2
      ) {
        entered += 1;
        if (entered === 2) markBothEntered();
        await handleGate;
      }
      await originalHandleRequest.call(this, request, response, body);
    });
    const pendingPosts = [
      rawSessionPost(http.origin, initialized.sessionId, 2),
      rawSessionPost(http.origin, initialized.sessionId, 3),
    ];

    try {
      await bothEntered;

      const rejected = await rawSocketRequest(
        http.origin,
        createRawMcpPostRequest(http.port, "not-json", initialized.sessionId),
      );
      expect(rejected).toMatchObject({
        status: 503,
        headers: { connection: "close" },
      });
      expect(rejected.body).toContain('\"message\":\"Server busy.\"');
      expect(handleRequest).toHaveBeenCalledTimes(2);

      releaseHandles();
      const admitted = await Promise.all(pendingPosts);
      expect(admitted.map((response) => response.status)).toEqual([200, 200]);
      await expect(rawSessionPost(http.origin, initialized.sessionId, 5))
        .resolves.toMatchObject({ status: 200 });
    } finally {
      releaseHandles();
      await Promise.allSettled(pendingPosts);
      handleRequest.mockRestore();
      await http.close();
    }
  });

  test("keeps roots responses reachable when one session saturates its data request lane", async () => {
    const root = await createSourceFixture("R", "SaturatedRoots");
    const http = await startTestMcpHttpServer(createSharedReaderState(), {
      maxInFlightRequests: 8,
      // The long-lived SSE connection consumes one ordinary session slot.
      maxRequestsPerSession: 9,
      maxSessions: 2,
      port: 0,
    });
    const client = new Client(
      { name: "meanthis-control-reserve", version: "0.1.0" },
      { capabilities: { roots: { listChanged: false } } },
    );
    let enteredRoots = 0;
    let markAllRootsEntered!: () => void;
    let releaseRoots!: () => void;
    const allRootsEntered = new Promise<void>((resolve) => { markAllRootsEntered = resolve; });
    const rootsGate = new Promise<void>((resolve) => { releaseRoots = resolve; });
    client.setRequestHandler(ListRootsRequestSchema, async () => {
      enteredRoots += 1;
      if (enteredRoots === 8) markAllRootsEntered();
      await rootsGate;
      return { roots: [{ uri: pathToFileURL(root.root).href, name: "saturated" }] };
    });
    const transport = createControlAwareAuthenticatedTransport(http.url);

    try {
      await client.connect(transport);
      const pending = Array.from({ length: 8 }, () => client.callTool({
        name: "meanthis_resolve_source",
        arguments: { sourceAnchor: root.anchor },
      }));
      await allRootsEntered;
      releaseRoots();

      const resolved = await Promise.all(pending);
      expect(resolved.map((result) => JSON.parse(readText(result)).status))
        .toEqual(Array.from({ length: 8 }, () => "verified"));
    } finally {
      releaseRoots();
      await Promise.allSettled([client.close()]);
      await http.close();
      await rm(root.root, { recursive: true, force: true });
    }
  });

  test("keeps roots responses reachable when multiple sessions saturate global data capacity", async () => {
    const root = await createSourceFixture("G", "GlobalRoots");
    const http = await startTestMcpHttpServer(createSharedReaderState(), {
      maxControlInFlightRequests: 8,
      maxControlRequestsPerSession: 4,
      maxInFlightRequests: 8,
      // Each client holds one SSE connection and four ordinary POST requests.
      maxRequestsPerSession: 5,
      maxSessions: 4,
      port: 0,
    });
    let enteredRoots = 0;
    let markAllRootsEntered!: () => void;
    let releaseRoots!: () => void;
    const allRootsEntered = new Promise<void>((resolve) => { markAllRootsEntered = resolve; });
    const rootsGate = new Promise<void>((resolve) => { releaseRoots = resolve; });
    const createClient = (name: string) => {
      const client = new Client(
        { name, version: "0.1.0" },
        { capabilities: { roots: { listChanged: false } } },
      );
      client.setRequestHandler(ListRootsRequestSchema, async () => {
        enteredRoots += 1;
        if (enteredRoots === 8) markAllRootsEntered();
        await rootsGate;
        return { roots: [{ uri: pathToFileURL(root.root).href, name }] };
      });
      return client;
    };
    const first = createClient("meanthis-global-control-a");
    const second = createClient("meanthis-global-control-b");

    try {
      await Promise.all([
        first.connect(createControlAwareAuthenticatedTransport(http.url)),
        second.connect(createControlAwareAuthenticatedTransport(http.url)),
      ]);
      const pending = [first, second].flatMap((client) =>
        Array.from({ length: 4 }, () => client.callTool({
          name: "meanthis_resolve_source",
          arguments: { sourceAnchor: root.anchor },
        }))
      );
      await allRootsEntered;
      releaseRoots();

      const resolved = await Promise.all(pending);
      expect(resolved.map((result) => JSON.parse(readText(result)).status))
        .toEqual(Array.from({ length: 8 }, () => "verified"));
    } finally {
      releaseRoots();
      await Promise.allSettled([first.close(), second.close()]);
      await http.close();
      await rm(root.root, { recursive: true, force: true });
    }
  });

  test("keeps explicit session deletion reachable while a data request is blocked", async () => {
    const http = await startTestMcpHttpServer(createLocalBridgeState(), {
      maxInFlightRequests: 1,
      maxRequestsPerSession: 1,
      maxSessions: 2,
      port: 0,
    });
    const initialized = await rawInitialize(http.origin);
    if (!initialized.sessionId) throw new Error("Expected an initialized MCP session.");
    const originalHandleRequest = StreamableHTTPServerTransport.prototype.handleRequest;
    let markDataEntered!: () => void;
    let releaseData!: () => void;
    const dataEntered = new Promise<void>((resolve) => { markDataEntered = resolve; });
    const dataGate = new Promise<void>((resolve) => { releaseData = resolve; });
    const handleRequest = vi.spyOn(
      StreamableHTTPServerTransport.prototype,
      "handleRequest",
    ).mockImplementation(async function (
      this: StreamableHTTPServerTransport,
      request,
      response,
      body,
    ) {
      if (
        request.method === "POST" &&
        request.headers["mcp-session-id"] === initialized.sessionId &&
        typeof body === "object" &&
        body !== null &&
        (body as Record<string, unknown>).method === "ping"
      ) {
        markDataEntered();
        await dataGate;
        response.writeHead(200, { "content-type": "application/json" });
        response.end(`${JSON.stringify({ jsonrpc: "2.0", id: 2, result: {} })}\n`);
        return;
      }
      await originalHandleRequest.call(this, request, response, body);
    });
    const pendingData = rawSessionPost(http.origin, initialized.sessionId, 2);
    const controlFetch = createLocalBridgeMcpHttpControlAwareFetch();

    try {
      await dataEntered;
      const termination = controlFetch(`${http.origin}/mcp`, {
        method: "DELETE",
        headers: {
          authorization: `Bearer ${TEST_BEARER_TOKEN}`,
          "mcp-protocol-version": "2025-06-18",
          "mcp-session-id": initialized.sessionId,
        },
      });
      await delay(20);
      releaseData();

      await expect(termination).resolves.toMatchObject({ status: 200 });
      await expect.poll(async () => (await readHealth(http.origin)).activeSessions).toBe(0);
    } finally {
      releaseData();
      await Promise.allSettled([pendingData]);
      handleRequest.mockRestore();
      await http.close();
    }
  });

  test("bounds the reserved control lane without consuming ordinary request capacity", async () => {
    const http = await startTestMcpHttpServer(createLocalBridgeState(), {
      maxControlInFlightRequests: 1,
      maxControlRequestsPerSession: 1,
      maxInFlightRequests: 2,
      maxRequestsPerSession: 2,
      maxSessions: 2,
      port: 0,
    });
    const initialized = await rawInitialize(http.origin);
    if (!initialized.sessionId) throw new Error("Expected an initialized MCP session.");
    const originalHandleRequest = StreamableHTTPServerTransport.prototype.handleRequest;
    const originalSend = StreamableHTTPServerTransport.prototype.send;
    let markResultEntered!: () => void;
    let releaseResult!: () => void;
    const resultEntered = new Promise<void>((resolve) => { markResultEntered = resolve; });
    const resultGate = new Promise<void>((resolve) => { releaseResult = resolve; });
    const send = vi.spyOn(StreamableHTTPServerTransport.prototype, "send")
      .mockImplementation(async function (message, options) {
        if (("result" in message || "error" in message) && message.id === 1) {
          markResultEntered();
          await resultGate;
        }
        return await originalSend.call(this, message, options);
      });
    let markControlEntered!: () => void;
    let releaseControl!: () => void;
    const controlEntered = new Promise<void>((resolve) => { markControlEntered = resolve; });
    const controlGate = new Promise<void>((resolve) => { releaseControl = resolve; });
    const handleRequest = vi.spyOn(
      StreamableHTTPServerTransport.prototype,
      "handleRequest",
    ).mockImplementation(async function (
      this: StreamableHTTPServerTransport,
      request,
      response,
      body,
    ) {
      if (
        request.method === "POST" &&
        typeof body === "object" &&
        body !== null &&
        (body as Record<string, unknown>).method === "notifications/cancelled"
      ) {
        markControlEntered();
        await controlGate;
      }
      await originalHandleRequest.call(this, request, response, body);
    });
    const controlFetch = createLocalBridgeMcpHttpControlAwareFetch();
    const sendCancel = (requestId: number) => controlFetch(http.url, {
      method: "POST",
      headers: {
        accept: "application/json, text/event-stream",
        authorization: `Bearer ${TEST_BEARER_TOKEN}`,
        "content-type": "application/json",
        "mcp-protocol-version": "2025-06-18",
        "mcp-session-id": initialized.sessionId!,
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        method: "notifications/cancelled",
        params: { requestId },
      }),
    });
    const pendingData = rawSessionPost(http.origin, initialized.sessionId, 1);
    let firstControl: Promise<Response> | undefined;

    try {
      await resultEntered;
      firstControl = sendCancel(1);
      await controlEntered;
      const [rejectedControl, admittedData] = await Promise.all([
        sendCancel(2),
        rawSessionPost(http.origin, initialized.sessionId, 3),
      ]);
      expect(rejectedControl.status).toBe(503);
      expect(rejectedControl.headers.get("connection")).toBe("close");
      expect(admittedData.status).toBe(200);

      releaseControl();
      await expect(firstControl).resolves.toMatchObject({ status: 202 });
      releaseResult();
      await expect(pendingData).resolves.toMatchObject({ status: 200 });
    } finally {
      releaseControl();
      releaseResult();
      await Promise.allSettled([firstControl ?? Promise.resolve(), pendingData]);
      handleRequest.mockRestore();
      send.mockRestore();
      await http.close();
    }
  });

  test("bounds same-session SSE connections and admits a reconnect after release", async () => {
    const http = await startTestMcpHttpServer(createLocalBridgeState(), {
      maxSseConnectionsPerSession: 1,
      maxSessions: 2,
      port: 0,
    });
    const initialized = await rawInitialize(http.origin);
    if (!initialized.sessionId) throw new Error("Expected an initialized MCP session.");
    let first: OpenSseConnection | undefined;
    let rejected: OpenSseConnection | undefined;
    let reconnected: OpenSseConnection | undefined;

    try {
      first = await openSessionSse(http.origin, initialized.sessionId);
      expect(first.response.status).toBe(200);

      rejected = await openSessionSse(http.origin, initialized.sessionId);
      expect(rejected.response.status).toBe(503);
      expect(rejected.response.headers.get("connection")).toBe("close");
      expect(JSON.parse(await rejected.response.text())).toMatchObject({
        error: { code: -32003, message: "Server busy." },
      });

      await first.close();
      first = undefined;
      reconnected = await waitForSessionSse(http.origin, initialized.sessionId);
      expect(reconnected.response.status).toBe(200);
    } finally {
      await Promise.allSettled([
        first?.close() ?? Promise.resolve(),
        rejected?.close() ?? Promise.resolve(),
        reconnected?.close() ?? Promise.resolve(),
      ]);
      await http.close();
    }
  });

  test("keeps non-SSE request capacity while every session holds an SSE connection", async () => {
    const http = await startTestMcpHttpServer(createLocalBridgeState(), {
      maxInFlightRequests: 2,
      maxSessions: 2,
      maxSseConnectionsPerSession: 1,
      port: 0,
    });
    const firstSession = await rawInitialize(http.origin);
    const secondSession = await rawInitialize(http.origin);
    if (!firstSession.sessionId || !secondSession.sessionId) {
      throw new Error("Expected two initialized MCP sessions.");
    }
    let firstSse: OpenSseConnection | undefined;
    let secondSse: OpenSseConnection | undefined;

    try {
      [firstSse, secondSse] = await Promise.all([
        openSessionSse(http.origin, firstSession.sessionId),
        openSessionSse(http.origin, secondSession.sessionId),
      ]);
      expect([firstSse.response.status, secondSse.response.status]).toEqual([200, 200]);

      await expect(rawSessionPost(http.origin, firstSession.sessionId, 6))
        .resolves.toMatchObject({ status: 200 });
    } finally {
      await Promise.allSettled([
        firstSse?.close() ?? Promise.resolve(),
        secondSse?.close() ?? Promise.resolve(),
      ]);
      await http.close();
    }
  });

  test("bounds accepted sockets and reuses capacity after a socket closes", async () => {
    const http = await startTestMcpHttpServer(createLocalBridgeState(), {
      maxSockets: 2,
      port: 0,
    });
    const first = await openIdleSocket(http.origin);
    const second = await openIdleSocket(http.origin);
    const requestText = createRawMcpGetRequest(http.port);

    try {
      const rejected = await rawSocketRequest(http.origin, requestText);
      expect(rejected).toMatchObject({
        status: 503,
        headers: { connection: "close" },
      });
      expect(JSON.parse(rejected.body)).toMatchObject({
        error: { code: -32003, message: "Server busy." },
      });

      const firstClosed = once(first, "close");
      first.destroy();
      await firstClosed;

      // A local close does not acknowledge the server's peer-close event.
      // Observe released capacity through the actual server response.
      await expect.poll(() => rawSocketRequest(http.origin, requestText)).toMatchObject({
        status: 400,
        body: expect.stringContaining("Mcp-Session-Id header is required."),
      });
    } finally {
      first.destroy();
      second.destroy();
      await http.close();
    }
  });

  test("reuses bounded capacity after reclaiming an abandoned session", async () => {
    const originalServerClose = McpServer.prototype.close;
    let markCloseEntered!: () => void;
    let releaseClose!: () => void;
    const closeEntered = new Promise<void>((resolve) => { markCloseEntered = resolve; });
    const closeGate = new Promise<void>((resolve) => { releaseClose = resolve; });
    const serverClose = vi.spyOn(McpServer.prototype, "close")
      .mockImplementationOnce(async function () {
        markCloseEntered();
        await closeGate;
        await originalServerClose.call(this);
      });
    const http = await startTestMcpHttpServer(createLocalBridgeState(), {
      maxSessions: 1,
      port: 0,
      sessionDisconnectGraceMs: 40,
      sessionIdleTtlMs: 400,
    });
    const first = new Client({ name: "meanthis-capacity-a", version: "0.1.0" });
    const replacement = new Client({ name: "meanthis-capacity-b", version: "0.1.0" });
    const firstTransport = createAuthenticatedTransport(http.url);
    const replacementTransport = createAuthenticatedTransport(http.url);

    try {
      await first.connect(firstTransport);
      const rejected = await rawInitialize(http.origin);
      expect(rejected.status).toBe(503);
      await expect(first.listTools()).resolves.toMatchObject({ tools: expect.any(Array) });
      expect(await readHealth(http.origin)).toMatchObject({
        activeSessions: 1,
        maxSessions: 1,
      });

      await first.close();
      await closeEntered;
      expect(await readHealth(http.origin)).toMatchObject({
        activeSessions: 0,
        retainedSessions: 1,
      });
      const rejectedWhileClosing = await rawInitialize(http.origin);
      expect(rejectedWhileClosing.status).toBe(503);

      releaseClose();
      await expect.poll(async () => (await readHealth(http.origin)).retainedSessions).toBe(0);

      await replacement.connect(replacementTransport);
      await expect(replacement.listTools()).resolves.toMatchObject({ tools: expect.any(Array) });
      expect(await readHealth(http.origin)).toMatchObject({ activeSessions: 1 });
    } finally {
      releaseClose();
      await Promise.allSettled([first.close(), replacement.close()]);
      await http.close();
      serverClose.mockRestore();
    }
  });

  test("enforces loopback Host and Origin, reports port conflicts, and can restart", async () => {
    const first = await startTestMcpHttpServer(createLocalBridgeState(), { port: 0 });
    const port = Number(new URL(first.origin).port);
    const firstStartCount = first.startCount;
    try {
      await expect(rawGet(first.origin, "/health", {
        Host: `localhost:${port}`,
      })).resolves.toMatchObject({ status: 403 });
      await expect(rawGet(first.origin, "/health", {
        Origin: "https://attacker.example",
      })).resolves.toMatchObject({ status: 403 });
      await expect(startTestMcpHttpServer(createLocalBridgeState(), { port }))
        .rejects.toThrow(`MeanThis MCP HTTP port ${port} is already in use.`);
    } finally {
      await first.close();
    }

    const replacement = await startTestMcpHttpServer(createLocalBridgeState(), { port });
    try {
      await expect(readHealth(replacement.origin)).resolves.toMatchObject({
        ok: true,
        pid: process.pid,
        startCount: firstStartCount + 1,
      });
    } finally {
      await replacement.close();
    }
    await expect(fetch(`${replacement.origin}/health`)).rejects.toThrow();
  });

  test("parses only a bounded configurable port", () => {
    expect(parseLocalBridgeMcpHttpArgs([])).toEqual({
      ok: true,
      port: MEANTHIS_MCP_HTTP_DEFAULT_PORT,
    });
    expect(parseLocalBridgeMcpHttpArgs(["--port", "40123"]))
      .toEqual({ ok: true, port: 40123 });
    expect(parseLocalBridgeMcpHttpArgs(["--port", "0"]))
      .toMatchObject({ ok: false, code: "INVALID_ARGUMENTS" });
    expect(parseLocalBridgeMcpHttpArgs(["--host", "0.0.0.0"]))
      .toMatchObject({ ok: false, code: "INVALID_ARGUMENTS" });
    expect(MEANTHIS_MCP_HTTP_DEFAULT_MAX_SESSIONS).toBe(64);
    expect(MEANTHIS_MCP_HTTP_DEFAULT_MAX_IN_FLIGHT_REQUESTS).toBe(64);
    expect(MEANTHIS_MCP_HTTP_DEFAULT_MAX_CONTROL_IN_FLIGHT_REQUESTS).toBe(64);
    expect(MEANTHIS_MCP_HTTP_DEFAULT_MAX_REQUESTS_PER_SESSION).toBe(8);
    expect(MEANTHIS_MCP_HTTP_DEFAULT_MAX_CONTROL_REQUESTS_PER_SESSION).toBe(8);
    expect(MEANTHIS_MCP_HTTP_DEFAULT_MAX_SSE_CONNECTIONS_PER_SESSION).toBe(2);
    expect(MEANTHIS_MCP_HTTP_DEFAULT_MAX_SOCKETS).toBe(256);
    expect(MEANTHIS_MCP_HTTP_KEY_KIND).toBe("mcp-http-key-v1");
    expect(MEANTHIS_MCP_HTTP_TOKEN_ENV).toBe("MEANTHIS_MCP_HTTP_TOKEN");
  });
});

function createSharedReaderState() {
  const state = createLocalBridgeState({
    now: () => new Date("2026-08-10T08:00:00.000Z"),
    randomInt: () => 482_193,
    randomBytes: (size) => Buffer.alloc(size, 7),
  });
  const paired = state.pair(EXTENSION_ORIGIN, {
    schemaVersion: "0.1.0",
    kind: "ui-attach.local-bridge-pair",
    pairingCode: "482-193",
    installationId: "5ea6b70f-48e8-4a7b-bc91-d943b0ef10f3",
  });
  if (!paired.ok) throw new Error("Expected paired test instance.");
  const published = state.publish(EXTENSION_ORIGIN, paired.value.token, {
    schemaVersion: "0.1.0",
    kind: "ui-attach.local-bridge-snapshot",
    sequence: 1,
    publishedAt: "2026-08-10T08:00:00.000Z",
    page: null,
    attachmentCount: 1,
    agentCopy: "agent-copy-a",
  });
  if (!published.ok) throw new Error("Expected published test snapshot.");
  return state;
}

function createRootsClient(name: string, root: string): Client {
  const client = new Client(
    { name, version: "0.1.0" },
    { capabilities: { roots: { listChanged: false } } },
  );
  client.setRequestHandler(ListRootsRequestSchema, async () => ({
    roots: [{ uri: pathToFileURL(root).href, name }],
  }));
  return client;
}

async function createSourceFixture(marker: string, componentName: string) {
  const root = await mkdtemp(join(tmpdir(), `meanthis-mcp-http-${marker.toLowerCase()}-`));
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

async function readHealth(origin: string): Promise<Record<string, unknown>> {
  const port = Number(new URL(origin).port);
  const proofRequest = createLocalBridgeMcpHttpHealthProofRequest(TEST_BEARER_TOKEN, {
    port,
  });
  const response = await fetch(`${origin}/health`, { headers: proofRequest.headers });
  expect(response.status).toBe(200);
  const body = await response.text();
  expect(verifyLocalBridgeMcpHttpHealthProofResponse(
    TEST_BEARER_TOKEN,
    proofRequest,
    {
      port,
      status: response.status,
      headers: response.headers,
      body,
    },
  )).toBe(true);
  return JSON.parse(body) as Record<string, unknown>;
}

async function rawGet(
  origin: string,
  path: string,
  headers: Record<string, string>,
): Promise<{ status: number; body: string }> {
  const url = new URL(path, origin);
  return await new Promise((resolve, reject) => {
    const outgoing = request(url, { method: "GET", headers }, (response) => {
      const chunks: Buffer[] = [];
      response.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
      response.on("end", () => resolve({
        status: response.statusCode ?? 0,
        body: Buffer.concat(chunks).toString("utf8"),
      }));
    });
    outgoing.once("error", reject);
    outgoing.end();
  });
}

function createCustomHealthProofRequest(options: {
  port: number;
  nonce: string;
  host?: string;
  method?: string;
  path?: string;
  timestamp?: string;
}) {
  const timestamp = options.timestamp ?? String(Date.now());
  const host = options.host ?? `127.0.0.1:${options.port}`;
  const method = options.method ?? "GET";
  const path = options.path ?? "/health";
  const emptyBodyHash = createHash("sha256").update("", "utf8").digest("hex");
  const canonical = [
    "meanthis-mcp-http-health-proof-v1",
    "request",
    method,
    path,
    host,
    timestamp,
    options.nonce,
    emptyBodyHash,
  ].join("\n");
  const proof = createHmac("sha256", Buffer.from(TEST_BEARER_TOKEN, "base64url"))
    .update(canonical, "utf8")
    .digest("base64url");
  return {
    timestamp,
    nonce: options.nonce,
    proof,
    headers: {
      [MEANTHIS_MCP_HTTP_HEALTH_TIMESTAMP_HEADER]: timestamp,
      [MEANTHIS_MCP_HTTP_HEALTH_NONCE_HEADER]: options.nonce,
      [MEANTHIS_MCP_HTTP_HEALTH_PROOF_HEADER]: proof,
    },
  };
}

function malleateBase64urlPadBits(value: string): string {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
  const lastIndex = alphabet.indexOf(value.at(-1) ?? "");
  if (value.length !== 43 || lastIndex < 0 || (lastIndex & 0b11) !== 0) {
    throw new Error("Expected canonical unpadded base64url for 32 bytes.");
  }
  return `${value.slice(0, -1)}${alphabet[lastIndex | 0b01]}`;
}

function tamperCanonicalBase64url(value: string): string {
  return `${value.startsWith("A") ? "B" : "A"}${value.slice(1)}`;
}

function createRawHealthRequest(
  port: number,
  proofHeaders: Record<string, string>,
  framingHeaders: readonly string[],
  body: string,
): string {
  return [
    "GET /health HTTP/1.1",
    `Host: 127.0.0.1:${port}`,
    ...Object.entries(proofHeaders).map(([name, value]) => `${name}: ${value}`),
    ...framingHeaders,
    "",
    body,
  ].join("\r\n");
}

async function rawSocketRequest(
  origin: string,
  requestText: string,
): Promise<{ status: number; headers: Record<string, string>; body: string }> {
  const url = new URL(origin);
  return await new Promise((resolve, reject) => {
    const socket = connect({ host: url.hostname, port: Number(url.port) });
    let received = Buffer.alloc(0);
    let settled = false;

    const settle = (response: { status: number; headers: Record<string, string>; body: string }) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(response);
    };
    const parse = (connectionEnded: boolean) => {
      const headerEnd = received.indexOf("\r\n\r\n");
      if (headerEnd < 0) return;
      const headerText = received.subarray(0, headerEnd).toString("latin1");
      const lines = headerText.split("\r\n");
      const status = Number(lines.shift()?.match(/^HTTP\/1\.1 (\d{3})/)?.[1] ?? 0);
      const headers: Record<string, string> = {};
      for (const line of lines) {
        const separator = line.indexOf(":");
        if (separator < 0) continue;
        const name = line.slice(0, separator).trim().toLowerCase();
        const value = line.slice(separator + 1).trim();
        headers[name] = headers[name] ? `${headers[name]}, ${value}` : value;
      }
      const bodyBytes = received.subarray(headerEnd + 4);
      const contentLength = headers["content-length"];
      if (contentLength && /^\d+$/.test(contentLength)) {
        const expectedLength = Number(contentLength);
        if (bodyBytes.byteLength >= expectedLength) {
          if (headers.connection?.toLowerCase() === "close" && !connectionEnded) return;
          settle({
            status,
            headers,
            body: bodyBytes.subarray(0, expectedLength).toString("utf8"),
          });
        }
        return;
      }
      if (headers["transfer-encoding"]?.toLowerCase() === "chunked") {
        const chunkedBody = bodyBytes.toString("latin1");
        if (chunkedBody.endsWith("\r\n0\r\n\r\n")) {
          if (headers.connection?.toLowerCase() === "close" && !connectionEnded) return;
          settle({ status, headers, body: chunkedBody });
        }
        return;
      }
      if (connectionEnded) settle({ status, headers, body: bodyBytes.toString("utf8") });
    };

    socket.setTimeout(5_000, () => reject(new Error("Raw HTTP response timed out.")));
    socket.once("connect", () => socket.write(requestText, "latin1"));
    socket.on("data", (chunk) => {
      received = Buffer.concat([received, Buffer.from(chunk)]);
      parse(false);
    });
    socket.once("end", () => parse(true));
    socket.once("close", () => parse(true));
    socket.once("error", reject);
  });
}

function readText(result: Awaited<ReturnType<Client["callTool"]>>): string {
  const block = result.content.find((item) => item.type === "text");
  if (!block || block.type !== "text") throw new Error("Expected MCP text content.");
  return block.text;
}

function createControlledSseTransport(
  url: string,
  options: { initialReconnectionDelay: number; maxRetries: number },
) {
  let getCount = 0;
  let openedGetCount = 0;
  let currentGetController: AbortController | undefined;
  const transport = new StreamableHTTPClientTransport(new URL(url), {
    requestInit: authenticatedRequestInit(),
    fetch: async (input, init) => {
      if (init?.method !== "GET") return await fetch(input, init);
      getCount += 1;
      const controller = new AbortController();
      currentGetController = controller;
      if (init.signal?.aborted) {
        controller.abort();
      } else {
        init.signal?.addEventListener("abort", () => controller.abort(), { once: true });
      }
      const response = await fetch(input, { ...init, signal: controller.signal });
      openedGetCount += 1;
      return response;
    },
    reconnectionOptions: {
      initialReconnectionDelay: options.initialReconnectionDelay,
      maxReconnectionDelay: options.initialReconnectionDelay,
      reconnectionDelayGrowFactor: 1,
      maxRetries: options.maxRetries,
    },
  });
  return {
    transport,
    getCount: () => getCount,
    openedGetCount: () => openedGetCount,
    abortCurrentGet: () => {
      if (!currentGetController) throw new Error("Expected an active SSE GET request.");
      currentGetController.abort();
    },
  };
}

async function rawInitialize(
  origin: string,
  capabilities: Record<string, unknown> = {},
): Promise<{
  status: number;
  sessionId: string | null;
  connection: string | null;
  body: string;
}> {
  const response = await fetch(`${origin}/mcp`, {
    method: "POST",
    headers: {
      accept: "application/json, text/event-stream",
      authorization: `Bearer ${TEST_BEARER_TOKEN}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2025-06-18",
        capabilities,
        clientInfo: { name: "meanthis-raw", version: "0.1.0" },
      },
    }),
  });
  const body = await response.text();
  return {
    status: response.status,
    sessionId: response.headers.get("mcp-session-id"),
    connection: response.headers.get("connection"),
    body,
  };
}

async function rawMcpPostBody(
  origin: string,
  body: string,
): Promise<{
  status: number;
  sessionId: string | null;
  connection: string | null;
  body: string;
}> {
  const response = await fetch(`${origin}/mcp`, {
    method: "POST",
    headers: {
      accept: "application/json, text/event-stream",
      authorization: `Bearer ${TEST_BEARER_TOKEN}`,
      "content-type": "application/json",
    },
    body,
  });
  return {
    status: response.status,
    sessionId: response.headers.get("mcp-session-id"),
    connection: response.headers.get("connection"),
    body: await response.text(),
  };
}

async function rawSessionPost(
  origin: string,
  sessionId: string,
  id: number,
): Promise<{ status: number; connection: string | null; body: string }> {
  const response = await fetch(`${origin}/mcp`, {
    method: "POST",
    headers: {
      accept: "application/json, text/event-stream",
      authorization: `Bearer ${TEST_BEARER_TOKEN}`,
      "content-type": "application/json",
      "mcp-session-id": sessionId,
    },
    body: JSON.stringify({ jsonrpc: "2.0", id, method: "ping" }),
  });
  return {
    status: response.status,
    connection: response.headers.get("connection"),
    body: await response.text(),
  };
}

async function rawSessionJsonRpc(
  origin: string,
  sessionId: string,
  message: unknown,
): Promise<{ status: number; connection: string | null; body: string }> {
  const response = await fetch(`${origin}/mcp`, {
    method: "POST",
    headers: {
      accept: "application/json, text/event-stream",
      authorization: `Bearer ${TEST_BEARER_TOKEN}`,
      "content-type": "application/json",
      "mcp-protocol-version": "2025-11-25",
      "mcp-session-id": sessionId,
    },
    body: JSON.stringify(message),
  });
  return {
    status: response.status,
    connection: response.headers.get("connection"),
    body: await response.text(),
  };
}

interface OpenSseConnection {
  response: Response;
  close(): Promise<void>;
}

async function openSessionSse(origin: string, sessionId: string): Promise<OpenSseConnection> {
  const controller = new AbortController();
  const response = await fetch(`${origin}/mcp`, {
    method: "GET",
    headers: {
      accept: "text/event-stream",
      authorization: `Bearer ${TEST_BEARER_TOKEN}`,
      "mcp-session-id": sessionId,
    },
    signal: controller.signal,
  });
  let closed = false;
  return {
    response,
    async close() {
      if (closed) return;
      closed = true;
      controller.abort();
      await response.body?.cancel().catch(() => undefined);
    },
  };
}

async function waitForSessionSse(origin: string, sessionId: string): Promise<OpenSseConnection> {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const connection = await openSessionSse(origin, sessionId);
    if (connection.response.status === 200) return connection;
    await connection.response.text();
    await connection.close();
    await delay(10);
  }
  throw new Error("Timed out waiting for released SSE capacity.");
}

async function openIdleSocket(origin: string): Promise<ReturnType<typeof connect>> {
  const url = new URL(origin);
  const socket = connect({ host: url.hostname, port: Number(url.port) });
  await once(socket, "connect");
  return socket;
}

function createRawMcpGetRequest(port: number): string {
  return [
    "GET /mcp HTTP/1.1",
    `Host: 127.0.0.1:${port}`,
    `Authorization: Bearer ${TEST_BEARER_TOKEN}`,
    "Accept: text/event-stream",
    "Connection: close",
    "",
    "",
  ].join("\r\n");
}

function createRawMcpPostRequest(port: number, body: string, sessionId?: string): string {
  return [
    "POST /mcp HTTP/1.1",
    `Host: 127.0.0.1:${port}`,
    `Authorization: Bearer ${TEST_BEARER_TOKEN}`,
    "Accept: application/json, text/event-stream",
    "Content-Type: application/json",
    ...(sessionId ? [`Mcp-Session-Id: ${sessionId}`] : []),
    `Content-Length: ${Buffer.byteLength(body)}`,
    "",
    body,
  ].join("\r\n");
}

async function delay(milliseconds: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function settleWithin<T>(
  promise: Promise<T>,
  milliseconds: number,
  message: string,
): Promise<T> {
  let timeout: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(() => reject(new Error(message)), milliseconds);
      }),
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

function readToolPostRequest(
  body: BodyInit | null | undefined,
): { id: string | number; name: string } | null {
  if (typeof body !== "string") return null;
  try {
    const message = JSON.parse(body) as unknown;
    if (
      typeof message !== "object" ||
      message === null ||
      Array.isArray(message) ||
      (message as Record<string, unknown>).method !== "tools/call"
    ) return null;
    const id = (message as Record<string, unknown>).id;
    const params = (message as Record<string, unknown>).params;
    if (
      (typeof id !== "string" && typeof id !== "number") ||
      typeof params !== "object" ||
      params === null ||
      Array.isArray(params)
    ) return null;
    const name = (params as Record<string, unknown>).name;
    return typeof name === "string" ? { id, name } : null;
  } catch {
    return null;
  }
}

function startTestMcpHttpServer(
  reader: Parameters<typeof startLocalBridgeMcpHttpServer>[0],
  options: Omit<LocalBridgeMcpHttpServerOptions, "bearerToken"> = {},
) {
  return startLocalBridgeMcpHttpServer(reader, {
    bearerToken: TEST_BEARER_TOKEN,
    ownerIdentity: TEST_OWNER_IDENTITY,
    ...options,
  });
}

function authenticatedRequestInit(): RequestInit {
  return {
    headers: {
      authorization: `Bearer ${TEST_BEARER_TOKEN}`,
    },
  };
}

function createAuthenticatedTransport(url: string): StreamableHTTPClientTransport {
  return new StreamableHTTPClientTransport(new URL(url), {
    requestInit: authenticatedRequestInit(),
  });
}

function createControlAwareAuthenticatedTransport(url: string): StreamableHTTPClientTransport {
  return new StreamableHTTPClientTransport(new URL(url), {
    requestInit: authenticatedRequestInit(),
    fetch: createLocalBridgeMcpHttpControlAwareFetch(),
  });
}
