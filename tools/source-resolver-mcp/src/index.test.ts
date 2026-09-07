import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import {
  CancelledNotificationSchema,
  ListRootsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import {
  createSourceContentHash,
  createSourceMapSidecar,
} from "@meanthis/source-map-core";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, test } from "vitest";
import {
  MEANTHIS_SOURCE_RESOLVER_MAX_BATCH_SIZE,
  createSourceResolverMcpServer,
  resolveSourceInputsAcrossWorkspaces,
} from "./index.js";

const BUILD_ID = "A".repeat(43);
const SOURCE_ID = "B".repeat(43);
const SOURCE = "export function Panel() {}\n";
const SOURCE_ANCHOR = {
  schemaVersion: "0.1.0",
  kind: "ui-attach.opaque-source-anchor",
  buildId: BUILD_ID,
  sourceId: SOURCE_ID,
} as const;
const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) =>
    rm(root, { recursive: true, force: true })));
});

describe("minimal source resolver MCP", () => {
  test("rejects an oversized internal resolution batch before workspace access", async () => {
    await expect(resolveSourceInputsAcrossWorkspaces(
      ["C:/must-not-be-read"],
      Array.from(
        { length: MEANTHIS_SOURCE_RESOLVER_MAX_BATCH_SIZE + 1 },
        () => ({ sourceAnchor: SOURCE_ANCHOR }),
      ),
    )).rejects.toThrow("capture target limit");
  });

  test("exposes one strict read-only tool and returns domain failures as text JSON", async () => {
    const server = createSourceResolverMcpServer();
    const client = new Client({ name: "source-resolver-contract", version: "0.1.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    try {
      const tools = await client.listTools();
      expect(tools.tools).toHaveLength(1);
      expect(tools.tools[0]).toMatchObject({
        name: "meanthis_resolve_source",
        annotations: {
          readOnlyHint: true,
          destructiveHint: false,
          idempotentHint: true,
          openWorldHint: false,
        },
      });
      expect(tools.tools[0]?.inputSchema).toMatchObject({
        additionalProperties: false,
        required: ["sourceAnchor"],
      });

      const unavailable = await client.callTool({
        name: "meanthis_resolve_source",
        arguments: { sourceAnchor: SOURCE_ANCHOR },
      });
      expect(unavailable.isError).not.toBe(true);
      expect(JSON.parse(readText(unavailable))).toMatchObject({
        schemaVersion: "0.1.0",
        kind: "ui-attach.source-resolution",
        status: "unavailable",
        reason: "workspace_unavailable",
      });

      for (const invalid of [
        { sourceAnchor: JSON.stringify(SOURCE_ANCHOR) },
        { resolverInput: { sourceAnchor: SOURCE_ANCHOR } },
        { sourceAnchor: SOURCE_ANCHOR, workspaceRoot: "C:/untrusted" },
      ]) {
        const result = await client.callTool({
          name: "meanthis_resolve_source",
          arguments: invalid,
        });
        expect(result.isError).toBe(true);
      }
    } finally {
      await client.close();
      await server.close();
    }
  });

  test("resolves one exact match through MCP roots without exposing trusted internals", async () => {
    const matchingRoot = await createWorkspace();
    const unrelatedRoot = await createEmptyRoot("meanthis-source-resolver-unrelated-");
    const server = createSourceResolverMcpServer({ launchWorkspaceRoot: unrelatedRoot });
    const client = rootsClient([unrelatedRoot, matchingRoot]);
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    try {
      const result = await client.callTool({
        name: "meanthis_resolve_source",
        arguments: { sourceAnchor: SOURCE_ANCHOR },
      });
      expect(result.isError, readText(result)).not.toBe(true);
      expect(JSON.parse(readText(result))).toEqual({
        schemaVersion: "0.1.0",
        kind: "ui-attach.source-resolution",
        status: "verified",
        buildId: BUILD_ID,
        sourceId: SOURCE_ID,
        location: {
          path: "src/Panel.tsx",
          line: 1,
          column: 8,
          tagName: "button",
          componentName: "Panel",
        },
      });
      expect(readText(result)).not.toContain(createSourceContentHash(SOURCE));
      expect(readText(result)).not.toContain(matchingRoot);
    } finally {
      await client.close();
      await server.close();
    }
  });

  test("binds and cancels nested roots/list with the current tools/call", async () => {
    const server = createSourceResolverMcpServer();
    const client = new Client(
      { name: "cancelling-roots-client", version: "0.1.0" },
      { capabilities: { roots: { listChanged: false } } },
    );
    let markRootsStarted!: () => void;
    const rootsStarted = new Promise<void>((resolve) => {
      markRootsStarted = resolve;
    });
    client.setRequestHandler(ListRootsRequestSchema, async (_request, extra) => {
      markRootsStarted();
      await new Promise<void>((resolve) => {
        if (extra.signal.aborted) resolve();
        else extra.signal.addEventListener("abort", () => resolve(), { once: true });
      });
      throw new Error("roots request cancelled");
    });

    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const clientSend = clientTransport.send.bind(clientTransport);
    const serverSend = serverTransport.send.bind(serverTransport);
    let toolCallRequestId: string | number | undefined;
    let nestedRequestId: string | number | undefined;
    let rootsRelatedRequestId: string | number | undefined;
    let markNestedCancelled!: (requestId: string | number) => void;
    const nestedCancelled = new Promise<string | number>((resolve) => {
      markNestedCancelled = resolve;
    });
    clientTransport.send = async (message, options) => {
      if ("method" in message && message.method === "tools/call" && "id" in message) {
        toolCallRequestId = message.id;
      }
      await clientSend(message, options);
    };
    serverTransport.send = async (message, options) => {
      if ("method" in message && message.method === "roots/list" && "id" in message) {
        nestedRequestId = message.id;
        rootsRelatedRequestId = options?.relatedRequestId;
      }
      const cancellation = CancelledNotificationSchema.safeParse(message);
      if (cancellation.success && cancellation.data.params.requestId === nestedRequestId) {
        markNestedCancelled(cancellation.data.params.requestId);
      }
      await serverSend(message, options);
    };

    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    try {
      const abortController = new AbortController();
      const callState = client.callTool(
        {
          name: "meanthis_resolve_source",
          arguments: { sourceAnchor: SOURCE_ANCHOR },
        },
        undefined,
        { signal: abortController.signal },
      ).then(() => "resolved", () => "rejected");
      await rootsStarted;
      expect(toolCallRequestId).toBeDefined();
      expect(nestedRequestId).toBeDefined();
      expect(rootsRelatedRequestId).toBe(toolCallRequestId);

      abortController.abort();
      expect(await callState).toBe("rejected");
      let cancellationTimeout!: ReturnType<typeof setTimeout>;
      const cancellation = await Promise.race([
        nestedCancelled.then((requestId) => ({ status: "cancelled" as const, requestId })),
        new Promise<{ status: "timeout" }>((resolve) => {
          cancellationTimeout = setTimeout(() => resolve({ status: "timeout" }), 1_000);
        }),
      ]);
      clearTimeout(cancellationTimeout);
      expect(cancellation).toEqual({ status: "cancelled", requestId: nestedRequestId });
    } finally {
      await client.close();
      await server.close();
    }
  });

  test("uses launch cwd only when the client has no roots capability", async () => {
    const matchingRoot = await createWorkspace();

    const fallbackServer = createSourceResolverMcpServer({ launchWorkspaceRoot: matchingRoot });
    const fallbackClient = new Client({ name: "no-roots-client", version: "0.1.0" });
    const [fallbackClientTransport, fallbackServerTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([
      fallbackServer.connect(fallbackServerTransport),
      fallbackClient.connect(fallbackClientTransport),
    ]);
    try {
      const result = await fallbackClient.callTool({
        name: "meanthis_resolve_source",
        arguments: { sourceAnchor: SOURCE_ANCHOR },
      });
      expect(JSON.parse(readText(result))).toMatchObject({ status: "verified" });
    } finally {
      await fallbackClient.close();
      await fallbackServer.close();
    }

    const explicitServer = createSourceResolverMcpServer({ launchWorkspaceRoot: matchingRoot });
    const explicitClient = rootsClient([]);
    const [explicitClientTransport, explicitServerTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([
      explicitServer.connect(explicitServerTransport),
      explicitClient.connect(explicitClientTransport),
    ]);
    try {
      const result = await explicitClient.callTool({
        name: "meanthis_resolve_source",
        arguments: { sourceAnchor: SOURCE_ANCHOR },
      });
      expect(JSON.parse(readText(result))).toMatchObject({
        status: "unavailable",
        reason: "workspace_unavailable",
      });
    } finally {
      await explicitClient.close();
      await explicitServer.close();
    }
  });

  test("does not fall back to launch cwd when roots discovery fails", async () => {
    const matchingRoot = await createWorkspace();
    const server = createSourceResolverMcpServer({ launchWorkspaceRoot: matchingRoot });
    const client = new Client(
      { name: "failing-roots-client", version: "0.1.0" },
      { capabilities: { roots: { listChanged: false } } },
    );
    client.setRequestHandler(ListRootsRequestSchema, async () => {
      throw new Error("roots unavailable");
    });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    try {
      const result = await client.callTool({
        name: "meanthis_resolve_source",
        arguments: { sourceAnchor: SOURCE_ANCHOR },
      });
      expect(result.isError).not.toBe(true);
      expect(JSON.parse(readText(result))).toMatchObject({
        status: "unavailable",
        reason: "workspace_unavailable",
      });
    } finally {
      await client.close();
      await server.close();
    }
  });

  test("honors an injected roots provider and fails closed on ambiguity or stale bytes", async () => {
    const firstRoot = await createWorkspace();
    const secondRoot = await createWorkspace();
    const ambiguousServer = createSourceResolverMcpServer({
      listWorkspaceRoots: () => [firstRoot, secondRoot],
      launchWorkspaceRoot: firstRoot,
    });
    const ambiguousClient = rootsClient([firstRoot]);
    const [ambiguousClientTransport, ambiguousServerTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([
      ambiguousServer.connect(ambiguousServerTransport),
      ambiguousClient.connect(ambiguousClientTransport),
    ]);
    try {
      const result = await ambiguousClient.callTool({
        name: "meanthis_resolve_source",
        arguments: { sourceAnchor: SOURCE_ANCHOR },
      });
      expect(JSON.parse(readText(result))).toMatchObject({
        status: "unavailable",
        reason: "workspace_ambiguous",
      });
    } finally {
      await ambiguousClient.close();
      await ambiguousServer.close();
    }

    await writeFile(join(firstRoot, "src", "Panel.tsx"), "export function Changed() {}\n");
    const staleServer = createSourceResolverMcpServer({ listWorkspaceRoots: () => [firstRoot] });
    const staleClient = new Client({ name: "stale-source-client", version: "0.1.0" });
    const [staleClientTransport, staleServerTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([staleServer.connect(staleServerTransport), staleClient.connect(staleClientTransport)]);
    try {
      const result = await staleClient.callTool({
        name: "meanthis_resolve_source",
        arguments: { sourceAnchor: SOURCE_ANCHOR },
      });
      expect(JSON.parse(readText(result))).toMatchObject({
        status: "unavailable",
        reason: "source_hash_mismatch",
      });
    } finally {
      await staleClient.close();
      await staleServer.close();
    }
  });
});

function rootsClient(roots: readonly string[]): Client {
  const client = new Client(
    { name: "roots-client", version: "0.1.0" },
    { capabilities: { roots: { listChanged: false } } },
  );
  client.setRequestHandler(ListRootsRequestSchema, async () => ({
    roots: roots.map((root) => ({ uri: pathToFileURL(root).href })),
  }));
  return client;
}

async function createWorkspace(): Promise<string> {
  const root = await createEmptyRoot("meanthis-source-resolver-workspace-");
  const sourcePath = join(root, "src", "Panel.tsx");
  const sidecarPath = join(root, ".ui-attach", "source-map.json");
  await mkdir(dirname(sourcePath), { recursive: true });
  await mkdir(dirname(sidecarPath), { recursive: true });
  await writeFile(sourcePath, SOURCE);
  await writeFile(sidecarPath, `${JSON.stringify(createSourceMapSidecar(BUILD_ID, [{
    sourceId: SOURCE_ID,
    path: "src/Panel.tsx",
    line: 1,
    column: 8,
    tagName: "button",
    componentName: "Panel",
    contentHash: createSourceContentHash(SOURCE),
  }]))}\n`);
  return root;
}

async function createEmptyRoot(prefix: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), prefix));
  temporaryRoots.push(root);
  return root;
}

function readText(result: { content?: Array<{ type: string; text?: string }> }): string {
  const text = result.content?.find((item) => item.type === "text")?.text;
  if (typeof text !== "string") throw new Error("Expected one text result.");
  return text;
}
