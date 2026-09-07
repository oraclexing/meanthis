import assert from "node:assert/strict";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { ListRootsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import {
  createSourceContentHash,
  createSourceMapSidecar,
} from "@meanthis/source-map-core";
import {
  UI_ATTACH_LOCAL_BRIDGE_PORT,
  isLocalBridgeMcpReadReceipt,
} from "@meanthis/schema";
import { fork } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer as createNetServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROLE_ENV = "UI_ATTACH_BRIDGE_PROCESS_SMOKE_ROLE";
const scriptPath = fileURLToPath(import.meta.url);
const repoRoot = resolve(dirname(scriptPath), "../../..");
const brokerEntryPath = resolve(
  dirname(scriptPath),
  "../dist/local-bridge-mcp-stdio-broker.js",
);
const extensionOrigin = "chrome-extension://bbiiccaidhlhdagmabkogleldjdnmlfn";
const expectedPageInstanceId = "chromium-tab:4242:frame:0";
const expectedRoute = "https://example.test/workspace";
const PROCESS_SMOKE_MCP_HTTP_DISCONNECT_GRACE_MS = 2_000;
const BROKER_PROCESS_CLEANUP_TIMEOUT_MS = 5_000;
const PROCESS_SMOKE_PORT_RELEASE_STABLE_MS = 3_000;
const PROCESS_SMOKE_PORT_RELEASE_PROBE_INTERVAL_MS = 50;
const FAILURE_DIAGNOSTIC_HEALTH_TIMEOUT_MS = 1_000;
const PROCESS_SMOKE_DIAGNOSTIC_MAX_CHARS = 4_096;
const PROCESS_SMOKE_MAX_WIRE_REQUEST_METHODS = 16;
const PROCESS_SMOKE_MAX_WIRE_COUNT = 1_000_000;
const PROCESS_SMOKE_WIRE_REQUEST_METHODS = new Set([
  "initialize",
  "ping",
  "roots/list",
  "tools/call",
  "tools/list",
]);
const PROCESS_SMOKE_DIAGNOSTIC_SELF_TEST_FLAG = "--diagnostic-self-test";
const PROCESS_SMOKE_CAPTURE_ID = "process-smoke-session";
const PROCESS_SMOKE_AGENT_COPY = "Agent-safe process-smoke handoff.\r\nExact UTF-8: 猫.";
const PROCESS_SMOKE_TARGET_ID = "target_process_smoke";
const PROCESS_SMOKE_ATTACHMENT_ID = "att_process_smoke";
const PROCESS_SMOKE_ANNOTATION_ID = "annotation_process_smoke";
const PROCESS_SMOKE_TASK_NOTE = "Shorten the primary action label.";
const PROCESS_SMOKE_CAPTURE_TIME = "2026-08-31T08:00:00.000Z";
const PROCESS_SMOKE_ANNOTATION_CREATED_AT = "2026-08-31T07:55:00.000Z";
const PROCESS_SMOKE_ANNOTATION_RESOLVED_AT = "2026-08-31T07:59:00.000Z";

const role = process.env[ROLE_ENV];
try {
  await dispatchProcessSmoke({
    args: process.argv,
    workerRole: role,
  });
} catch (error) {
  const diagnosticRole = role ?? "parent";
  const diagnosticStage = role ? "worker-bootstrap" : "parent";
  process.stderr.write(`${formatProcessSmokeFailure(error, {
    stage: diagnosticStage,
    role: diagnosticRole,
    secrets: collectProcessSmokeDiagnosticSecrets(process.env),
  })}\n`);
  process.exitCode = 1;
  if (process.connected) process.disconnect();
}

async function dispatchProcessSmoke({
  args,
  workerRole,
  runDiagnosticSelfTest = runProcessSmokeDiagnosticSelfTest,
  runWorkerProcess = runWorker,
  runParentProcess = runParent,
}) {
  if (args.includes(PROCESS_SMOKE_DIAGNOSTIC_SELF_TEST_FLAG)) {
    await runDiagnosticSelfTest({ writeSuccess: true });
    return;
  }
  if (workerRole) {
    await runWorkerProcess(workerRole);
    return;
  }
  await runDiagnosticSelfTest({ writeSuccess: false });
  await runParentProcess();
}

async function runWorker(workerRole) {
  const agentToken = requireEnvironment("UI_ATTACH_BRIDGE_PROCESS_AGENT_TOKEN");
  const ownerIdentity = JSON.parse(requireEnvironment("UI_ATTACH_BRIDGE_PROCESS_OWNER_IDENTITY"));

  if (workerRole === "owner") {
    const {
      fingerprintLocalBridgeOwnerIdentity,
      runDetachedLocalBridgeOwner,
    } = await import("../dist/local-bridge-owner.js");
    const {
      inspectLocalBridgeAgentToken,
      readLocalBridgeAgentToken,
    } = await import("../dist/local-bridge-agent-token.js");
    const codexHome = requireEnvironment("UI_ATTACH_BRIDGE_PROCESS_AGENT_CODEX_HOME");
    const sentinelPath = requireEnvironment("UI_ATTACH_BRIDGE_PROCESS_BUILD_SENTINEL");
    const configuredPort = Number(
      process.env.UI_ATTACH_BRIDGE_PROCESS_OWNER_PORT ?? "0",
    );
    assert.ok(
      Number.isSafeInteger(configuredPort) && configuredPort >= 0 && configuredPort <= 65_535,
      "The process-smoke browser owner port must be a valid loopback port.",
    );
    await runDetachedLocalBridgeOwner({
      agentToken,
      port: configuredPort,
      ownerIdentity,
      loadOwnerIdentity: () => ({
        ...ownerIdentity,
        buildHash: readFileSync(sentinelPath, "utf8").trim(),
      }),
      loadDesiredIdentity: async () => fingerprintLocalBridgeOwnerIdentity(
        ownerIdentity,
        agentToken,
      ),
      readAgentToken: () => readLocalBridgeAgentToken({ codexHome }),
      inspectAgentToken: () => inspectLocalBridgeAgentToken({ codexHome }),
      idleMs: Number(requireEnvironment("UI_ATTACH_BRIDGE_PROCESS_IDLE_MS")),
      idleCheckMs: Number(requireEnvironment("UI_ATTACH_BRIDGE_PROCESS_IDLE_CHECK_MS")),
      onReady: ({ origin }) => sendMessage({ type: "ready", origin }),
    });
    sendMessage({ type: "closed" });
    if (process.connected) process.disconnect();
    return;
  }

  if (workerRole === "mcp-http-owner") {
    const codexHome = requireEnvironment("UI_ATTACH_BRIDGE_PROCESS_BROKER_CODEX_HOME");
    const bearerToken = requireEnvironment("UI_ATTACH_BRIDGE_PROCESS_MCP_HTTP_TOKEN");
    const tokenFingerprint = requireEnvironment(
      "UI_ATTACH_BRIDGE_PROCESS_MCP_HTTP_TOKEN_FINGERPRINT",
    );
    const buildSentinel = requireEnvironment(
      "UI_ATTACH_BRIDGE_PROCESS_MCP_HTTP_BUILD_SENTINEL",
    );
    const {
      runDetachedLocalBridgeMcpHttpOwner,
    } = await import("../dist/local-bridge-mcp-http-owner.js");
    const {
      startLocalBridgeMcpHttpServer,
    } = await import("../dist/local-bridge-mcp-http.js");
    const {
      fingerprintLocalBridgeMcpHttpToken,
      inspectLocalBridgeMcpHttpToken,
      readLocalBridgeMcpHttpToken,
      readVerifiedLocalBridgeMcpHttpDesiredIdentity,
    } = await import("../dist/local-bridge-mcp-http-token.js");
    const { createLocalBridgeState } = await import("../dist/local-bridge.js");
    const reader = createLocalBridgeState({
      now: () => new Date(PROCESS_SMOKE_CAPTURE_TIME),
      randomInt: () => 482_193,
      randomBytes: (size) => Buffer.alloc(size, 7),
    });
    const paired = reader.pair(extensionOrigin, {
      schemaVersion: "0.1.0",
      kind: "ui-attach.local-bridge-pair",
      pairingCode: "482-193",
      installationId: "123e4567-e89b-42d3-a456-426614174001",
    });
    assert.equal(paired.ok, true);
    if (!paired.ok) throw new Error("The MCP HTTP owner process smoke could not pair its fixture.");
    const published = reader.publish(
      extensionOrigin,
      paired.value.token,
      createProcessSmokeIntentSnapshot(),
    );
    assert.equal(published.ok, true);
    if (!published.ok) {
      throw new Error("The MCP HTTP owner process smoke could not publish its fixture.");
    }
    await runDetachedLocalBridgeMcpHttpOwner({
      bearerToken,
      agentToken,
      ownerIdentity,
      tokenFingerprint,
      checkIntervalMs: 25,
      buildCheckIntervalMs: 25,
      port: Number(requireEnvironment("UI_ATTACH_BRIDGE_PROCESS_MCP_HTTP_PORT")),
      loadOwnerIdentity: () => ({
        ...ownerIdentity,
        buildHash: readFileSync(buildSentinel, "utf8").trim(),
      }),
      loadTokenFingerprint: async () => fingerprintLocalBridgeMcpHttpToken(
        await readLocalBridgeMcpHttpToken({ codexHome }),
      ),
      readTokenCredential: () => readLocalBridgeMcpHttpToken({ codexHome }),
      loadDesiredBuildHash: () =>
        readVerifiedLocalBridgeMcpHttpDesiredIdentity({ codexHome }),
      inspectTokenCredential: async () => {
        const inspection = await inspectLocalBridgeMcpHttpToken({ codexHome });
        return inspection.status === "ready";
      },
      createReader: () => reader,
      ensureBridgeOwner: async (sharedReader) => {
        await sharedReader.getStatus();
      },
      startServer: (httpReader, serverOptions) => startLocalBridgeMcpHttpServer(
        httpReader,
        {
          ...serverOptions,
          sessionDisconnectGraceMs: PROCESS_SMOKE_MCP_HTTP_DISCONNECT_GRACE_MS,
        },
      ),
      startBridgeOwnerLease: () => ({
        async refresh() {},
        stop() {},
      }),
      onReady: ({ origin, buildHash }) => sendMessage({
        type: "mcp-http-ready",
        origin,
        buildHash,
        instanceId: paired.value.instanceId,
      }),
    });
    sendMessage({ type: "mcp-http-closed" });
    if (process.connected) process.disconnect();
    return;
  }

  const {
    approveHttpLocalBridgeConnectionRequest,
    createHttpLocalBridgeReader,
    startLocalBridgeOwnerLease,
  } = await import("../dist/local-bridge-mcp.js");
  const origin = requireEnvironment("UI_ATTACH_BRIDGE_PROCESS_ORIGIN");
  const reader = createHttpLocalBridgeReader(origin, agentToken, {
    expectedOwnerIdentity: ownerIdentity,
    fetchImpl: closeConnectionFetch,
  });

  if (workerRole === "mcp-http-client-proxy") {
    const bearerToken = requireEnvironment("UI_ATTACH_BRIDGE_PROCESS_MCP_HTTP_TOKEN");
    const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
    const { StreamableHTTPClientTransport } = await import(
      "@modelcontextprotocol/sdk/client/streamableHttp.js"
    );
    const readHealth = () => readAuthenticatedMcpHttpHealth(origin, bearerToken);
    const before = await readHealth();
    const transport = new StreamableHTTPClientTransport(new URL(`${origin}/mcp`), {
      requestInit: {
        headers: { authorization: `Bearer ${bearerToken}` },
      },
    });
    const client = new Client({
      name: requireEnvironment("UI_ATTACH_BRIDGE_PROCESS_MCP_CLIENT_NAME"),
      version: "0.1.0",
    });
    let active;
    try {
      await client.connect(transport);
      const tools = await client.listTools();
      assert.deepEqual(
        tools.tools.map((tool) => tool.name),
        [
          "meanthis_list_captures",
          "meanthis_read_capture",
          "meanthis_ack_capture_read",
          "meanthis_wait_capture_change",
          "meanthis_resolve_source",
        ],
      );
      const captures = await client.callTool({
        name: "meanthis_list_captures",
        arguments: {},
      });
      assert.notEqual(captures.isError, true);
      assert.equal(captures.content.length, 1);
      assert.equal(captures.content[0]?.type, "text");
      assert.equal(
        JSON.parse(captures.content[0].text).kind,
        "ui-attach.capture-list",
      );
      active = await readHealth();
    } finally {
      await client.close();
    }
    const after = await readHealth();
    assert.equal(active.pid, before.pid);
    assert.equal(active.startCount, before.startCount);
    assert.equal(after.pid, before.pid);
    assert.equal(after.startCount, before.startCount);
    sendMessage({
      type: "mcp-http-client",
      pid: before.pid,
      startCount: before.startCount,
      buildHash: before.ownerIdentity?.buildHash,
    });
    if (process.connected) process.disconnect();
    return;
  }

  if (workerRole === "status-proxy") {
    const status = await reader.getStatus();
    sendMessage({
      type: "status",
      instanceCount: status.instances.length,
    });
    if (process.connected) process.disconnect();
    return;
  }

  if (workerRole === "lease-proxy") {
    const lease = startLocalBridgeOwnerLease({
      ensureOwner: async () => { await reader.getStatus(); },
    }, {
      intervalMs: Number(requireEnvironment("UI_ATTACH_BRIDGE_PROCESS_LEASE_INTERVAL_MS")),
    });
    try {
      await lease.refresh();
      await new Promise((resolveDelay) => setTimeout(
        resolveDelay,
        Number(requireEnvironment("UI_ATTACH_BRIDGE_PROCESS_LEASE_DURATION_MS")),
      ));
      await reader.getStatus();
      sendMessage({ type: "lease-held" });
    } finally {
      lease.stop();
    }
    if (process.connected) process.disconnect();
    return;
  }

  if (workerRole === "approve-proxy") {
    const approval = await approveHttpLocalBridgeConnectionRequest(
      origin,
      agentToken,
      requireEnvironment("UI_ATTACH_BRIDGE_PROCESS_REQUEST_ID"),
      requireEnvironment("UI_ATTACH_BRIDGE_PROCESS_APPROVAL_MODE"),
      requireEnvironment("UI_ATTACH_BRIDGE_PROCESS_APPROVAL_KEY"),
      { expectedOwnerIdentity: ownerIdentity, fetchImpl: closeConnectionFetch },
    );
    sendMessage({ type: "approved", approval });
    if (process.connected) process.disconnect();
    return;
  }

  if (workerRole === "read-proxy") {
    const expectedInstanceId = requireEnvironment("UI_ATTACH_BRIDGE_PROCESS_INSTANCE_ID");
    const instances = (await reader.listInstances()).filter((instance) => !instance.stale);
    assert.equal(instances.length, 1);
    assert.equal(instances[0].instanceId, expectedInstanceId);
    const exact = await reader.readInstance(expectedInstanceId);
    assert.equal(exact.ok, true);
    if (!exact.ok) throw new Error("Exact process-smoke instance read failed.");
    assert.equal(exact.value.snapshot.page.pageInstanceId, expectedPageInstanceId);
    assert.equal(exact.value.snapshot.page.route, expectedRoute);
    sendMessage({
      type: "read",
      instanceId: exact.value.instanceId,
      pageInstanceId: exact.value.snapshot.page.pageInstanceId,
      route: exact.value.snapshot.page.route,
    });
    if (process.connected) process.disconnect();
    return;
  }

  throw new Error(`Unsupported process-smoke worker role: ${workerRole}`);
}

async function runParent() {
  const temporaryRoot = await mkdtemp(join(tmpdir(), "ui-attach-bridge-process-"));
  const workers = new Set();
  const fixedPortsRequiringCleanup = new Set();
  try {
    const idleSentinel = join(temporaryRoot, "idle-build-hash.txt");
    const identity = {
      executablePath: process.execPath,
      entryPath: `${scriptPath}#idle-owner`,
      buildHash: "a".repeat(64),
    };
    const agentCodexHome = join(temporaryRoot, "agent-profile");
    await mkdir(agentCodexHome, { recursive: true });
    const { loadOrCreateLocalBridgeAgentToken } = await import(
      "../dist/local-bridge-agent-token.js"
    );
    const agentToken = await loadOrCreateLocalBridgeAgentToken({
      codexHome: agentCodexHome,
    });
    await writeFile(idleSentinel, identity.buildHash, "utf8");

    const owner = spawnWorker("owner", {
      agentToken,
      agentCodexHome,
      ownerIdentity: identity,
      sentinelPath: idleSentinel,
      idleMs: 5_000,
      idleCheckMs: 25,
    });
    workers.add(owner);
    const ready = await waitForMessage(owner, "ready");
    assert.match(ready.origin, /^http:\/\/127\.0\.0\.1:\d+$/);

    const status = await runProxy(workers, "status-proxy", {
      agentToken,
      ownerIdentity: identity,
      origin: ready.origin,
    }, "status");
    assert.equal(status.instanceCount, 0);
    assert.equal(owner.child.exitCode, null, "owner exited with its discovery proxy");

    const requestId = "95e3e7b1-6f74-44ae-8954-e11f7f2a7c58";
    const requestSecret = randomBytes(32).toString("base64url");
    const approvalKey = randomBytes(32).toString("base64url");
    const approvalVerifier = createHash("sha256")
      .update(Buffer.from(approvalKey, "base64url"))
      .digest("base64url");
    const requestedResponse = await closeConnectionFetch(`${ready.origin}/v1/connection-requests`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: extensionOrigin },
      body: JSON.stringify({
        schemaVersion: "0.1.0",
        kind: "ui-attach.local-bridge-connection-request",
        requestId,
        requestSecret,
        approvalVerifier,
        installationId: "123e4567-e89b-42d3-a456-426614174000",
        browserSessionId: "32b8d92d-c76e-4c72-9f3c-5ba5bf31cd22",
        approvalMode: "ask",
      }),
    });
    assert.equal(requestedResponse.status, 201);
    const requested = await requestedResponse.json();
    assert.equal(requested.data.status, "pending");
    assert.equal(JSON.stringify(requested).includes(requestSecret), false);

    const approved = await runProxy(workers, "approve-proxy", {
      agentToken,
      ownerIdentity: identity,
      origin: ready.origin,
      requestId,
      approvalMode: "ask",
      approvalKey,
    }, "approved");
    assert.equal(approved.approval.requestId, requestId);
    assert.equal(JSON.stringify(approved).includes("token"), false);
    const connectionResponse = await closeConnectionFetch(
      `${ready.origin}/v1/connection-requests/${requestId}`,
      {
        headers: {
          authorization: `Bearer ${requestSecret}`,
          origin: extensionOrigin,
        },
      },
    );
    assert.equal(connectionResponse.status, 200);
    const connection = await connectionResponse.json();
    assert.match(connection.data.instanceId, /^instance-[0-9a-f]{12}$/);
    assert.match(connection.data.token, /^[A-Za-z0-9_-]{43}$/);
    assert.match(connection.data.approvalProof, /^[A-Za-z0-9_-]{43}$/);

    const publishResponse = await closeConnectionFetch(`${ready.origin}/v1/snapshot`, {
      method: "PUT",
      headers: {
        authorization: `Bearer ${connection.data.token}`,
        "content-type": "application/json",
        origin: extensionOrigin,
      },
      body: JSON.stringify({
        schemaVersion: "0.1.0",
        kind: "ui-attach.local-bridge-snapshot",
        sequence: 1,
        publishedAt: new Date().toISOString(),
        page: { pageInstanceId: expectedPageInstanceId, route: expectedRoute },
        attachmentCount: 1,
        agentCopy: "Untrusted process-smoke attachment.",
      }),
    });
    assert.equal(publishResponse.status, 204);

    const firstRead = await runProxy(workers, "read-proxy", {
      agentToken,
      ownerIdentity: identity,
      origin: ready.origin,
      instanceId: connection.data.instanceId,
    }, "read");
    assert.equal(owner.child.exitCode, null, "owner exited with its first read proxy");
    const freshRead = await runProxy(workers, "read-proxy", {
      agentToken,
      ownerIdentity: identity,
      origin: ready.origin,
      instanceId: connection.data.instanceId,
    }, "read");
    assert.deepEqual(freshRead, firstRead);
    assert.equal(owner.child.exitCode, null, "owner exited with its fresh read proxy");
    await assertCleanExit(owner, 10_000, "idle owner");

    const leaseSentinel = join(temporaryRoot, "lease-build-hash.txt");
    const leaseIdentity = {
      executablePath: process.execPath,
      entryPath: `${scriptPath}#lease-owner`,
      buildHash: "d".repeat(64),
    };
    await writeFile(leaseSentinel, leaseIdentity.buildHash, "utf8");
    const leaseOwner = spawnWorker("owner", {
      agentToken,
      agentCodexHome,
      ownerIdentity: leaseIdentity,
      sentinelPath: leaseSentinel,
      idleMs: 2_000,
      idleCheckMs: 25,
    });
    workers.add(leaseOwner);
    const leaseReady = await waitForMessage(leaseOwner, "ready");
    await runProxy(workers, "lease-proxy", {
      agentToken,
      ownerIdentity: leaseIdentity,
      origin: leaseReady.origin,
      leaseDurationMs: 4_500,
      leaseIntervalMs: 250,
    }, "lease-held");
    assert.equal(leaseOwner.child.exitCode, null, "owner exited while an MCP lease was active");
    await assertCleanExit(leaseOwner, 4_000, "post-lease idle owner");

    const buildSentinel = join(temporaryRoot, "changed-build-hash.txt");
    const buildIdentity = {
      executablePath: process.execPath,
      entryPath: `${scriptPath}#build-owner`,
      buildHash: "b".repeat(64),
    };
    await writeFile(buildSentinel, buildIdentity.buildHash, "utf8");
    const buildOwner = spawnWorker("owner", {
      agentToken,
      agentCodexHome,
      ownerIdentity: buildIdentity,
      sentinelPath: buildSentinel,
      idleMs: 10_000,
      idleCheckMs: 25,
    });
    workers.add(buildOwner);
    await waitForMessage(buildOwner, "ready");
    await writeFile(buildSentinel, "c".repeat(64), "utf8");
    await assertCleanExit(buildOwner, 5_000, "build-changed owner");

    const {
      MEANTHIS_MCP_HTTP_DEFAULT_PORT,
    } = await import("../dist/local-bridge-mcp-http-health-proof.js");
    const { createMeanThisMcpDescriptor } = await import("../dist/mcp-host-config.js");
    const { MEANTHIS_MCP_STDIO_BROKER_URL } = await import(
      "../dist/local-bridge-mcp-stdio-broker.js"
    );
    const brokerRegistration = createMeanThisMcpDescriptor();
    assert.equal(brokerRegistration.transport.type, "stdio");
    assert.equal(brokerRegistration.transport.command, process.execPath);
    assert.deepEqual(brokerRegistration.transport.args, [brokerEntryPath]);
    assert.equal(brokerRegistration.transport.env, null);
    assert.equal(brokerRegistration.transport.cwd, null);
    assert.equal(
      MEANTHIS_MCP_STDIO_BROKER_URL,
      `http://127.0.0.1:${MEANTHIS_MCP_HTTP_DEFAULT_PORT}/mcp`,
    );
    await Promise.all([
      assertLoopbackPortAvailable(
        UI_ATTACH_LOCAL_BRIDGE_PORT,
        "shared browser owner preflight",
      ),
      assertLoopbackPortAvailable(
        MEANTHIS_MCP_HTTP_DEFAULT_PORT,
        "shared MCP owner preflight",
      ),
    ]);
    fixedPortsRequiringCleanup.add(UI_ATTACH_LOCAL_BRIDGE_PORT);
    fixedPortsRequiringCleanup.add(MEANTHIS_MCP_HTTP_DEFAULT_PORT);
    const brokerCodexHome = join(temporaryRoot, "broker-profile");
    const brokerAgentToken = await loadOrCreateLocalBridgeAgentToken({
      codexHome: brokerCodexHome,
    });
    const { loadLocalBridgeOwnerIdentity } = await import(
      "../dist/local-bridge-owner.js"
    );
    const browserOwnerIdentity = loadLocalBridgeOwnerIdentity();
    const browserOwnerBuildSentinel = join(
      temporaryRoot,
      "browser-owner-build-hash.txt",
    );
    await writeFile(
      browserOwnerBuildSentinel,
      browserOwnerIdentity.buildHash,
      "utf8",
    );
    const browserOwner = spawnWorker("owner", {
      agentToken: brokerAgentToken,
      agentCodexHome: brokerCodexHome,
      ownerIdentity: browserOwnerIdentity,
      sentinelPath: browserOwnerBuildSentinel,
      idleMs: 120_000,
      idleCheckMs: 25,
      ownerPort: UI_ATTACH_LOCAL_BRIDGE_PORT,
    });
    workers.add(browserOwner);
    const browserOwnerReady = await waitForMessage(browserOwner, "ready");
    assert.equal(
      browserOwnerReady.origin,
      `http://127.0.0.1:${UI_ATTACH_LOCAL_BRIDGE_PORT}`,
    );
    const mcpHttpToken = randomBytes(32).toString("base64url");
    const mcpHttpTokenFingerprint = `sha256:${createHash("sha256")
      .update(mcpHttpToken, "utf8")
      .digest("hex")
      .slice(0, 16)}`;
    const mcpHttpIdentity = {
      executablePath: process.execPath,
      entryPath: `${scriptPath}#mcp-http-owner`,
      buildHash: "e".repeat(64),
    };
    const {
      loadOrCreateLocalBridgeMcpHttpToken,
      writeLocalBridgeMcpHttpDesiredIdentity,
    } = await import(
      "../dist/local-bridge-mcp-http-token.js"
    );
    assert.equal(await loadOrCreateLocalBridgeMcpHttpToken({
      codexHome: brokerCodexHome,
      randomBytes: () => Buffer.from(mcpHttpToken, "base64url"),
    }), mcpHttpToken);
    await writeLocalBridgeMcpHttpDesiredIdentity(mcpHttpIdentity.buildHash, {
      codexHome: brokerCodexHome,
    });
    const mcpHttpBuildSentinel = join(temporaryRoot, "mcp-http-build-hash.txt");
    await writeFile(mcpHttpBuildSentinel, mcpHttpIdentity.buildHash, "utf8");
    const mcpHttpOwner = spawnWorker("mcp-http-owner", {
      agentToken,
      ownerIdentity: mcpHttpIdentity,
      mcpHttpToken,
      mcpHttpTokenFingerprint,
      mcpHttpBuildSentinel,
      mcpHttpPort: MEANTHIS_MCP_HTTP_DEFAULT_PORT,
      brokerCodexHome,
    });
    workers.add(mcpHttpOwner);
    const mcpHttpReady = await waitForMessage(mcpHttpOwner, "mcp-http-ready");
    assert.equal(
      mcpHttpReady.origin,
      `http://127.0.0.1:${MEANTHIS_MCP_HTTP_DEFAULT_PORT}`,
    );
    assert.equal(mcpHttpReady.buildHash, mcpHttpIdentity.buildHash);

    const anonymousHealth = await closeConnectionFetch(`${mcpHttpReady.origin}/health`);
    assert.equal(anonymousHealth.status, 401);
    assert.equal((await anonymousHealth.text()).includes(mcpHttpToken), false);

    const [firstClient, secondClient] = await Promise.all([
      runProxy(workers, "mcp-http-client-proxy", {
        agentToken,
        ownerIdentity: mcpHttpIdentity,
        origin: mcpHttpReady.origin,
        mcpHttpToken,
        mcpClientName: "meanthis-process-smoke-a",
      }, "mcp-http-client"),
      runProxy(workers, "mcp-http-client-proxy", {
        agentToken,
        ownerIdentity: mcpHttpIdentity,
        origin: mcpHttpReady.origin,
        mcpHttpToken,
        mcpClientName: "meanthis-process-smoke-b",
      }, "mcp-http-client"),
    ]);
    assert.deepEqual(secondClient, firstClient);
    assert.equal(firstClient.pid, mcpHttpOwner.child.pid);
    assert.equal(firstClient.startCount, 1);
    assert.equal(firstClient.buildHash, mcpHttpIdentity.buildHash);
    assert.equal(mcpHttpOwner.child.exitCode, null, "shared MCP owner exited with a client");
    assert.equal(mcpHttpOwner.diagnostics.join("").includes(mcpHttpToken), false);
    const directClientGraceHealth = await readAuthenticatedMcpHttpHealth(
      mcpHttpReady.origin,
      mcpHttpToken,
    );
    assert.equal(directClientGraceHealth.pid, mcpHttpOwner.child.pid);
    assert.equal(directClientGraceHealth.startCount, 1);
    assert.equal(
      directClientGraceHealth.activeSessions,
      2,
      "Client.close sessions should remain reusable during their bounded reconnect grace.",
    );
    assert.equal(directClientGraceHealth.retainedSessions, 2);
    const brokerBaselineHealth = await waitForMcpHttpHealth(
      mcpHttpReady.origin,
      mcpHttpToken,
      (health) => health.activeSessions === 0 && health.retainedSessions === 0,
      PROCESS_SMOKE_MCP_HTTP_DISCONNECT_GRACE_MS + 5_000,
    );
    assert.equal(brokerBaselineHealth.pid, mcpHttpOwner.child.pid);
    assert.equal(brokerBaselineHealth.startCount, 1);

    const sourceA = await createSourceFixture(
      join(temporaryRoot, "broker-root-a"),
      "A",
      "SettingsA",
    );
    const sourceB = await createSourceFixture(
      join(temporaryRoot, "broker-root-b"),
      "B",
      "SettingsB",
    );
    const hostileInheritedToken = randomBytes(32).toString("base64url");
    assert.notEqual(hostileInheritedToken, mcpHttpToken);
    const rootsA = { roots: [{ uri: pathToFileURL(sourceA.root).href, name: "root-a" }] };
    const rootsB = { roots: [{ uri: pathToFileURL(sourceB.root).href, name: "root-b" }] };
    const brokerA = createBrokerProcessClient({
      registration: brokerRegistration.transport,
      codexHome: brokerCodexHome,
      hostileInheritedToken,
      name: "meanthis-stdio-broker-a",
      rootsState: rootsA,
    });
    const brokerB = createBrokerProcessClient({
      registration: brokerRegistration.transport,
      codexHome: brokerCodexHome,
      hostileInheritedToken,
      name: "meanthis-stdio-broker-b",
      rootsState: rootsB,
    });
    let brokerStage = "connect";
    let brokerFailure;
    const brokerOperations = createBrokerOperationSettlements();
    try {
      await Promise.all([brokerA.client.connect(brokerA.transport), brokerB.client.connect(brokerB.transport)]);
      assert.notEqual(brokerA.transport.pid, null);
      assert.notEqual(brokerB.transport.pid, null);
      assert.notEqual(brokerA.transport.pid, brokerB.transport.pid);
      assert.notEqual(brokerA.transport.pid, mcpHttpOwner.child.pid);
      assert.notEqual(brokerB.transport.pid, mcpHttpOwner.child.pid);

      brokerStage = "tools-and-own-roots";
      const [toolsA, toolsB, resolvedA, resolvedB] = await Promise.all([
        trackBrokerOperation(brokerOperations, "toolsA", () => brokerA.client.listTools()),
        trackBrokerOperation(brokerOperations, "toolsB", () => brokerB.client.listTools()),
        trackBrokerOperation(brokerOperations, "resolvedA", () => brokerA.client.callTool({
          name: "meanthis_resolve_source",
          arguments: { sourceAnchor: sourceA.anchor },
        })),
        trackBrokerOperation(brokerOperations, "resolvedB", () => brokerB.client.callTool({
          name: "meanthis_resolve_source",
          arguments: { sourceAnchor: sourceB.anchor },
        })),
      ]);
      const expectedTools = [
        "meanthis_list_captures",
        "meanthis_read_capture",
        "meanthis_ack_capture_read",
        "meanthis_wait_capture_change",
        "meanthis_resolve_source",
      ];
      assert.deepEqual(toolsA.tools.map((tool) => tool.name), expectedTools);
      assert.deepEqual(toolsB.tools.map((tool) => tool.name), expectedTools);
      assert.equal(Object.hasOwn(toolsA, "nextCursor"), false);
      assert.equal(Object.hasOwn(toolsB, "nextCursor"), false);
      const parsedA = readToolJson(resolvedA);
      const parsedB = readToolJson(resolvedB);
      assert.equal(parsedA.status, "verified");
      assert.equal(parsedA.location?.path, "src/SettingsA.tsx");
      assert.equal(parsedA.location?.componentName, "SettingsA");
      assert.equal(parsedB.status, "verified");
      assert.equal(parsedB.location?.path, "src/SettingsB.tsx");
      assert.equal(parsedB.location?.componentName, "SettingsB");

      brokerStage = "progressive-capture-read";
      const progressiveRead = await trackBrokerOperation(
        brokerOperations,
        "progressiveReadA",
        () => verifyBrokerProgressiveCaptureRead(brokerA.client, mcpHttpReady.instanceId),
      );
      assert.deepEqual(progressiveRead, {
        annotationId: PROCESS_SMOKE_ANNOTATION_ID,
        annotationState: "resolved",
        captureId: PROCESS_SMOKE_CAPTURE_ID,
        expectedSequence: 1,
        instanceId: mcpHttpReady.instanceId,
        taskNote: PROCESS_SMOKE_TASK_NOTE,
      });

      brokerStage = "cross-root";
      const crossRoot = await brokerA.client.callTool({
        name: "meanthis_resolve_source",
        arguments: { sourceAnchor: sourceB.anchor },
      });
      assert.equal(readToolJson(crossRoot).status, "unavailable");
      assert.equal(readToolJson(crossRoot).reason, "build_mismatch");

      brokerStage = "roots-cleared";
      rootsB.roots = [];
      await brokerB.client.sendRootsListChanged();
      const withoutRoots = await brokerB.client.callTool({
        name: "meanthis_resolve_source",
        arguments: { sourceAnchor: sourceB.anchor },
      });
      assert.equal(readToolJson(withoutRoots).status, "unavailable");
      assert.equal(readToolJson(withoutRoots).reason, "workspace_unavailable");

      brokerStage = "owner-health";
      const withBrokersHealth = await readAuthenticatedMcpHttpHealth(
        mcpHttpReady.origin,
        mcpHttpToken,
      );
      assert.equal(withBrokersHealth.pid, mcpHttpOwner.child.pid);
      assert.equal(withBrokersHealth.startCount, 1);
      assert.equal(withBrokersHealth.activeSessions, brokerBaselineHealth.activeSessions + 2);
      assert.equal(withBrokersHealth.retainedSessions, brokerBaselineHealth.retainedSessions + 2);
    } catch (error) {
      brokerFailure = await createBrokerProcessSmokeFailure({
        stage: brokerStage,
        error,
        operations: brokerOperations,
        owner: mcpHttpOwner,
        origin: mcpHttpReady.origin,
        bearerToken: mcpHttpToken,
        hostileInheritedToken,
        agentToken,
        brokers: [brokerA, brokerB],
      });
    } finally {
      const cleanupSecrets = [mcpHttpToken, hostileInheritedToken, agentToken];
      let cleanupFailures;
      try {
        cleanupFailures = await cleanupBrokerProcessClients(
          [brokerA, brokerB],
          {
            secrets: cleanupSecrets,
            timeoutMs: BROKER_PROCESS_CLEANUP_TIMEOUT_MS,
          },
        );
      } catch (error) {
        cleanupFailures = [createBrokerCleanupFailure(
          "broker-group",
          "cleanup harness",
          error,
          cleanupSecrets,
        )];
      }
      if (cleanupFailures.length > 0) {
        brokerFailure = brokerFailure
          ? new AggregateError(
            [brokerFailure, ...cleanupFailures],
            "Thin stdio broker process smoke and cleanup failed.",
          )
          : new AggregateError(
            cleanupFailures,
            "Thin stdio broker process cleanup failed.",
          );
      }
    }
    if (brokerFailure) throw brokerFailure;

    await waitForMcpHttpHealth(
      mcpHttpReady.origin,
      mcpHttpToken,
      (health) => health.activeSessions === brokerBaselineHealth.activeSessions
        && health.retainedSessions === brokerBaselineHealth.retainedSessions,
      PROCESS_SMOKE_MCP_HTTP_DISCONNECT_GRACE_MS + 5_000,
    );
    assertBrokerProcessDidNotLeakToken(brokerA, mcpHttpToken);
    assertBrokerProcessDidNotLeakToken(brokerB, mcpHttpToken);
    assert.equal(mcpHttpOwner.diagnostics.join("").includes(mcpHttpToken), false);

    await writeFile(mcpHttpBuildSentinel, "f".repeat(64), "utf8");
    await assertCleanExit(mcpHttpOwner, 5_000, "shared MCP owner build turnover");
    await assertLoopbackPortAvailable(
      MEANTHIS_MCP_HTTP_DEFAULT_PORT,
      "shared MCP owner cleanup",
    );

    process.stdout.write(
      "Local bridge process smoke verified: browser lifecycle, direct HTTP clients, and two isolated thin stdio brokers reused one authenticated five-tool owner; one V3 resolved annotation completed list, summary, explicit read acknowledgement, composite Agent context, locator, exact handoff receipt, and stale-sequence reads without token disclosure or write authority.\n",
    );
  } finally {
    const cleanup = await Promise.allSettled([...workers].map(stopWorker));
    const failures = cleanup
      .filter((result) => result.status === "rejected")
      .map((result) => result.reason);
    for (const fixedPort of fixedPortsRequiringCleanup) {
      try {
        await assertLoopbackPortStablyAvailable(
          fixedPort,
          "shared owner final cleanup",
        );
      } catch (error) {
        failures.push(error);
      }
    }
    await rm(temporaryRoot, { recursive: true, force: true });
    if (failures.length > 0) {
      throw new AggregateError(failures, "Process-smoke child cleanup failed.");
    }
  }
}

function createBrokerProcessClient({
  registration,
  codexHome,
  hostileInheritedToken,
  name,
  rootsState,
}) {
  const server = {
    command: registration.command,
    args: registration.args,
    env: {
      CODEX_HOME: codexHome,
      MEANTHIS_MCP_HTTP_TOKEN: hostileInheritedToken,
    },
    stderr: "pipe",
  };
  const transport = new StdioClientTransport(server);
  const records = {
    command: JSON.stringify({
      command: server.command,
      args: server.args,
      env: server.env,
    }),
    stdin: [],
    stdout: [],
    stderr: [],
    wire: {
      hostToBroker: createBrokerWireSummary(),
      brokerToHost: createBrokerWireSummary(),
    },
    rootsHandlerInvocations: 0,
    pid: null,
    closed: false,
  };
  transport.stderr?.on("data", (chunk) => records.stderr.push(String(chunk)));
  transport.onclose = () => { records.closed = true; };

  const start = transport.start.bind(transport);
  transport.start = async () => {
    const onmessage = transport.onmessage;
    transport.onmessage = (message) => {
      records.stdout.push(JSON.stringify(message));
      recordBrokerWireMessage(records.wire.brokerToHost, message);
      onmessage?.(message);
    };
    const startPromise = start();
    records.pid = transport.pid;
    try {
      await startPromise;
    } finally {
      records.pid ??= transport.pid;
    }
  };
  const send = transport.send.bind(transport);
  transport.send = async (message) => {
    records.stdin.push(JSON.stringify(message));
    recordBrokerWireMessage(records.wire.hostToBroker, message);
    await send(message);
  };

  const client = new Client(
    { name, version: "0.1.0" },
    { capabilities: { roots: { listChanged: true } } },
  );
  client.setRequestHandler(ListRootsRequestSchema, async () => {
    records.rootsHandlerInvocations = incrementBrokerWireCount(
      records.rootsHandlerInvocations,
    );
    return { roots: rootsState.roots };
  });
  return { client, transport, records, hostileInheritedToken };
}

function createBrokerOperationSettlements() {
  return {
    toolsA: "not_started",
    toolsB: "not_started",
    resolvedA: "not_started",
    resolvedB: "not_started",
    progressiveReadA: "not_started",
  };
}

async function verifyBrokerProgressiveCaptureRead(client, expectedInstanceId) {
  const captureList = readToolJson(await client.callTool({
    name: "meanthis_list_captures",
    arguments: {},
  }));
  assert.equal(captureList.kind, "ui-attach.capture-list");
  assert.equal(captureList.state, "captures_available");
  assert.equal(captureList.captures?.length, 1);
  const listed = captureList.captures[0];
  assert.equal(listed.instanceId, expectedInstanceId);
  assert.equal(listed.captureId, PROCESS_SMOKE_CAPTURE_ID);
  assert.equal(listed.annotationLifecycleVersion, "v1");
  assert.equal(listed.targetCount, 1);
  assert.equal(listed.taskNoteCount, 1);
  assert.equal(listed.origin, "https://example.test");
  assert.deepEqual(listed.page, {
    pageInstanceId: "chromium-tab:842:frame:0",
    route: "https://example.test/settings",
  });
  assert.deepEqual(listed.snapshot, {
    sequence: 1,
    publishedAt: PROCESS_SMOKE_CAPTURE_TIME,
  });
  const listedJson = JSON.stringify(listed);
  assert.equal(listedJson.includes('"annotationLifecycle":'), false);
  assert.equal(listedJson.includes('"annotationIdentity":'), false);
  assert.equal(listedJson.includes('"resolvedAt":'), false);
  assert.equal(captureList.nextAction?.kind, "read_capture");
  assert.equal(captureList.nextAction?.tool, "meanthis_read_capture");
  assert.deepEqual(captureList.nextAction?.arguments, {
    instanceId: expectedInstanceId,
    captureId: PROCESS_SMOKE_CAPTURE_ID,
    expectedSequence: 1,
    detail: "agent_context",
  });

  const exactInput = {
    instanceId: expectedInstanceId,
    captureId: PROCESS_SMOKE_CAPTURE_ID,
    expectedSequence: 1,
  };
  const expectedAnnotationIdentity = {
    annotationId: PROCESS_SMOKE_ANNOTATION_ID,
    annotationIdScope: "capture_session",
    createdAt: PROCESS_SMOKE_ANNOTATION_CREATED_AT,
    updatedAt: PROCESS_SMOKE_ANNOTATION_RESOLVED_AT,
  };
  const summary = readToolJson(await client.callTool({
    name: "meanthis_read_capture",
    arguments: { ...exactInput, detail: "summary" },
  }));
  assert.equal(summary.kind, "ui-attach.capture-read");
  assert.equal(summary.detail, "summary");
  assert.equal(summary.capture?.captureId, PROCESS_SMOKE_CAPTURE_ID);
  assert.equal(summary.capture?.captureSequence, 1);
  assert.equal(summary.capture?.annotationLifecycleVersion, "v1");
  assert.equal(summary.capture?.targets?.length, 1);
  assert.equal(summary.capture.targets[0]?.targetId, PROCESS_SMOKE_TARGET_ID);
  assert.equal(summary.capture.targets[0]?.attachmentId, PROCESS_SMOKE_ATTACHMENT_ID);
  assert.deepEqual(
    summary.capture.targets[0]?.annotationIdentity,
    expectedAnnotationIdentity,
  );
  assert.deepEqual(summary.capture.targets[0]?.annotationLifecycle, {
    state: "resolved",
    resolvedAt: PROCESS_SMOKE_ANNOTATION_RESOLVED_AT,
  });
  assert.equal(summary.capture.targets[0]?.taskNotePresent, true);
  assert.deepEqual(summary.capture.targets[0]?.element, {
    tagName: "button",
    role: "button",
    accessibleName: "Save changes",
  });
  assert.deepEqual(summary.capture?.executionAuthority, {
    grantedByCapture: false,
    browserControl: false,
    liveDomMutation: false,
  });
  assert.deepEqual(summary.nextAction, {
    kind: "ack_capture_read",
    tool: "meanthis_ack_capture_read",
    arguments: {
      instanceId: expectedInstanceId,
      captureId: PROCESS_SMOKE_CAPTURE_ID,
      expectedSequence: 1,
      detail: "summary",
    },
    cli: {
      executable: "meanthis",
      arguments: [
        "capture",
        "ack",
        "--instance",
        expectedInstanceId,
        "--capture",
        PROCESS_SMOKE_CAPTURE_ID,
        "--sequence",
        "1",
        "--detail",
        "summary",
        "--json",
      ],
    },
  });
  const acknowledgement = readToolJson(await client.callTool({
    name: "meanthis_ack_capture_read",
    arguments: summary.nextAction.arguments,
  }));
  assert.equal(acknowledgement.acknowledgement?.kind, "ui-attach.local-bridge-read-acknowledgement");
  assert.equal(acknowledgement.acknowledgement?.status, "acknowledged_by_agent_client");
  assert.equal(acknowledgement.acknowledgement?.instanceId, expectedInstanceId);
  assert.equal(acknowledgement.acknowledgement?.captureId, PROCESS_SMOKE_CAPTURE_ID);
  assert.equal(acknowledgement.acknowledgement?.snapshotSequence, 1);
  assert.equal(acknowledgement.acknowledgement?.detail, "summary");
  assert.deepEqual(acknowledgement.limitations, [
    "does_not_prove_model_attention",
    "does_not_prove_task_creation",
    "does_not_prove_downstream_execution",
  ]);

  const agentContext = readToolJson(await client.callTool({
    name: "meanthis_read_capture",
    arguments: {
      ...exactInput,
      detail: "agent_context",
      targetIds: [PROCESS_SMOKE_TARGET_ID],
    },
  }));
  assert.equal(agentContext.detail, "agent_context");
  assert.equal(agentContext.capture?.targets?.length, 1);
  assert.deepEqual(
    agentContext.capture.targets[0]?.annotationIdentity,
    expectedAnnotationIdentity,
  );
  assert.deepEqual(agentContext.capture.targets[0]?.annotationLifecycle, {
    state: "resolved",
    resolvedAt: PROCESS_SMOKE_ANNOTATION_RESOLVED_AT,
  });
  assert.equal(agentContext.capture.targets[0]?.task?.text, PROCESS_SMOKE_TASK_NOTE);
  assert.equal(
    agentContext.capture.targets[0]?.task?.intentStatus,
    "user_authored_task_note",
  );
  assert.equal(
    agentContext.capture.targets[0]?.grounding?.recommendedLocator?.strategy,
    "playwright.role",
  );
  assert.deepEqual(agentContext.capture.targets[0]?.grounding?.sourceResolution, {
    schemaVersion: "0.1.0",
    kind: "ui-attach.source-resolution",
    status: "unavailable",
    reason: "source_anchor_missing",
  });
  assert.deepEqual(agentContext.capture.targets[0]?.visual, {
    bbox: { x: 10, y: 20, width: 80, height: 32 },
    visible: true,
    enabled: true,
    style: {
      display: "inline-flex",
      color: "rgb(255, 255, 255)",
      backgroundColor: "rgb(31, 99, 255)",
    },
  });
  assert.equal(Object.hasOwn(agentContext.capture.targets[0].visual, "artifacts"), false);
  assert.equal(Object.hasOwn(agentContext.capture.targets[0], "content"), false);
  assert.deepEqual(agentContext.capture.targets[0]?.authorization, {
    grantedByCapture: false,
    browserControl: false,
    liveDomMutation: false,
  });
  assert.deepEqual(agentContext.capture?.executionAuthority, {
    grantedByCapture: false,
    browserControl: false,
    liveDomMutation: false,
  });

  const locator = readToolJson(await client.callTool({
    name: "meanthis_read_capture",
    arguments: {
      ...exactInput,
      detail: "locator",
      attachmentIds: [PROCESS_SMOKE_ATTACHMENT_ID],
    },
  }));
  assert.equal(locator.detail, "locator");
  assert.equal(locator.capture?.targets?.length, 1);
  assert.deepEqual(
    locator.capture.targets[0]?.annotationIdentity,
    expectedAnnotationIdentity,
  );
  assert.deepEqual(locator.capture.targets[0]?.annotationLifecycle, {
    state: "resolved",
    resolvedAt: PROCESS_SMOKE_ANNOTATION_RESOLVED_AT,
  });
  assert.equal(
    locator.capture.targets[0]?.locator?.locatorBundle?.primary?.strategy,
    "playwright.role",
  );
  assert.deepEqual(locator.capture?.executionAuthority, {
    grantedByCapture: false,
    browserControl: false,
    liveDomMutation: false,
  });
  assert.equal(JSON.stringify(locator).includes('"rawText"'), false);
  assert.equal(JSON.stringify(locator).includes('"style"'), false);

  const handoff = readToolJson(await client.callTool({
    name: "meanthis_read_capture",
    arguments: {
      ...exactInput,
      detail: "handoff",
      includeReadReceipt: true,
    },
  }));
  assert.equal(handoff.detail, "handoff");
  assert.equal(handoff.capture?.handoff, PROCESS_SMOKE_AGENT_COPY);
  assert.equal(isLocalBridgeMcpReadReceipt(handoff.readReceipt), true);
  assert.equal(handoff.readReceipt.instanceId, expectedInstanceId);
  assert.equal(handoff.readReceipt.captureId, PROCESS_SMOKE_CAPTURE_ID);
  assert.equal(handoff.readReceipt.snapshotSequence, 1);
  assert.equal(handoff.readReceipt.status, "returned_to_mcp_client");
  assert.equal(
    handoff.readReceipt.handoffDigest,
    `sha256:${createHash("sha256")
      .update(handoff.capture.handoff, "utf8")
      .digest("hex")}`,
  );
  assert.deepEqual(handoff.readReceipt.executionAuthority, {
    grantedByCapture: false,
    browserControl: false,
    liveDomMutation: false,
  });
  assert.deepEqual(handoff.readReceipt.limitations, [
    "does_not_prove_model_attention",
    "does_not_prove_task_creation",
    "does_not_prove_downstream_execution",
  ]);

  const changed = await client.callTool({
    name: "meanthis_read_capture",
    arguments: {
      ...exactInput,
      expectedSequence: 0,
      detail: "summary",
    },
  });
  assert.equal(changed.isError, true);
  assert.equal(changed.content.length, 1);
  assert.equal(changed.content[0]?.type, "text");
  const changedReceipt = JSON.parse(changed.content[0].text);
  assert.equal(changedReceipt.error?.code, "CAPTURE_CHANGED");
  assert.deepEqual(changedReceipt.error?.nextAction, {
    kind: "relist_captures",
    tool: "meanthis_list_captures",
    cli: {
      executable: "meanthis",
      arguments: ["capture", "list", "--json"],
    },
  });

  return {
    annotationId: summary.capture.targets[0].annotationIdentity.annotationId,
    annotationState: summary.capture.targets[0].annotationLifecycle.state,
    captureId: listed.captureId,
    expectedSequence: 1,
    instanceId: listed.instanceId,
    taskNote: agentContext.capture.targets[0].task.text,
  };
}

function createProcessSmokeIntentSnapshot() {
  return {
    schemaVersion: "0.1.0",
    kind: "ui-attach.local-bridge-snapshot",
    sequence: 1,
    publishedAt: PROCESS_SMOKE_CAPTURE_TIME,
    page: {
      pageInstanceId: "chromium-tab:842:frame:0",
      route: "https://example.test/settings",
    },
    attachmentCount: 1,
    agentCopy: PROCESS_SMOKE_AGENT_COPY,
    capture: {
      captureId: PROCESS_SMOKE_CAPTURE_ID,
      title: "Settings action review",
      origin: "https://example.test",
      updatedAt: PROCESS_SMOKE_CAPTURE_TIME,
      authority: "capture_time",
      disclosureMode: "agent_safe",
      annotationLifecycleVersion: "v1",
      targets: [{
        targetId: PROCESS_SMOKE_TARGET_ID,
        attachmentId: PROCESS_SMOKE_ATTACHMENT_ID,
        label: "Primary action",
        taskNote: PROCESS_SMOKE_TASK_NOTE,
        annotationId: PROCESS_SMOKE_ANNOTATION_ID,
        annotationIdScope: "capture_session",
        annotationCreatedAt: PROCESS_SMOKE_ANNOTATION_CREATED_AT,
        annotationUpdatedAt: PROCESS_SMOKE_ANNOTATION_RESOLVED_AT,
        annotationLifecycle: {
          state: "resolved",
          resolvedAt: PROCESS_SMOKE_ANNOTATION_RESOLVED_AT,
        },
        attachment: {
          schemaVersion: "0.3.0",
          id: PROCESS_SMOKE_ATTACHMENT_ID,
          capturedAt: PROCESS_SMOKE_CAPTURE_TIME,
          source: { kind: "web", url: null, title: "Settings" },
          element: {
            tagName: "button",
            role: "button",
            text: "Save",
            accessibleName: "Save changes",
            contentParts: [{
              kind: "button",
              tagName: "button",
              role: "button",
              text: "Save",
              accessibleName: "Save changes",
            }],
            bbox: { x: 10, y: 20, width: 80, height: 32 },
            visible: true,
            enabled: true,
          },
          style: {
            display: "inline-flex",
            color: "rgb(255, 255, 255)",
            backgroundColor: "rgb(31, 99, 255)",
          },
          context: {
            parentSummary: "form settings",
            nearbyText: ["Profile", "Cancel"],
            selectorHints: ['button[type="submit"]'],
          },
          locatorBundle: {
            primary: {
              strategy: "playwright.role",
              value: 'page.getByRole("button", { name: "Save changes" })',
              confidence: 0.92,
            },
            candidates: [],
            stability: {
              score: 78,
              uniqueness: null,
              replayVerified: false,
              failureReason: null,
            },
          },
          policy: {
            disclosureMode: "agent_safe",
            redactionLevel: "strict",
            actionMode: "suggest_patch",
            allowScreenshot: false,
            allowDomSnippet: false,
            allowNetworkSend: false,
            allowedDomains: [],
            redactedFields: ["source.url"],
            sensitiveHints: [],
            includedSensitiveFields: [],
          },
          artifacts: { screenshotCrop: null, overlayImage: null },
        },
      }],
    },
  };
}

function trackBrokerOperation(settlements, name, operation) {
  settlements[name] = "pending";
  return Promise.resolve()
    .then(operation)
    .then(
      (value) => {
        settlements[name] = "fulfilled";
        return value;
      },
      (error) => {
        settlements[name] = "rejected";
        throw error;
      },
    );
}

function createBrokerWireSummary() {
  return {
    requestMethods: Object.create(null),
    responses: 0,
    errors: 0,
    notifications: 0,
    invalid: 0,
  };
}

function recordBrokerWireMessage(summary, message) {
  if (!isRecord(message)) {
    summary.invalid = incrementBrokerWireCount(summary.invalid);
    return;
  }
  if (typeof message.method === "string") {
    if (Object.hasOwn(message, "id")) {
      const method = boundedBrokerWireMethod(message.method);
      if (
        Object.hasOwn(summary.requestMethods, method) ||
        Object.keys(summary.requestMethods).length < PROCESS_SMOKE_MAX_WIRE_REQUEST_METHODS
      ) {
        summary.requestMethods[method] = incrementBrokerWireCount(
          summary.requestMethods[method] ?? 0,
        );
      } else {
        summary.requestMethods.other = incrementBrokerWireCount(
          summary.requestMethods.other ?? 0,
        );
      }
    } else {
      summary.notifications = incrementBrokerWireCount(summary.notifications);
    }
    return;
  }
  if (Object.hasOwn(message, "error")) {
    summary.errors = incrementBrokerWireCount(summary.errors);
    return;
  }
  if (Object.hasOwn(message, "result")) {
    summary.responses = incrementBrokerWireCount(summary.responses);
    return;
  }
  summary.invalid = incrementBrokerWireCount(summary.invalid);
}

function boundedBrokerWireMethod(method) {
  return PROCESS_SMOKE_WIRE_REQUEST_METHODS.has(method) ? method : "other";
}

function incrementBrokerWireCount(count) {
  return Math.min(count + 1, PROCESS_SMOKE_MAX_WIRE_COUNT);
}

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function createSourceFixture(root, marker, componentName) {
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
  await writeFile(sourcePath, source, "utf8");
  await writeFile(sidecarPath, `${JSON.stringify(sidecar)}\n`, "utf8");
  return {
    root,
    anchor: {
      schemaVersion: "0.1.0",
      kind: "ui-attach.opaque-source-anchor",
      buildId,
      sourceId,
    },
  };
}

function readToolJson(result) {
  assert.notEqual(result.isError, true);
  assert.equal(result.content.length, 1);
  assert.equal(result.content[0]?.type, "text");
  return JSON.parse(result.content[0].text);
}

async function waitForMcpHttpHealth(origin, bearerToken, predicate, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let lastHealth;
  while (Date.now() < deadline) {
    lastHealth = await readAuthenticatedMcpHttpHealth(origin, bearerToken);
    if (predicate(lastHealth)) return lastHealth;
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 25));
  }
  throw new Error(
    `Timed out waiting for MCP HTTP health state: ${JSON.stringify(lastHealth)}`,
  );
}

async function assertLoopbackPortAvailable(port, label) {
  assert.ok(Number.isSafeInteger(port) && port >= 1 && port <= 65_535);
  const server = createNetServer();
  server.unref();
  await new Promise((resolveAvailable, rejectUnavailable) => {
    const fail = () => rejectUnavailable(new Error(
      `${sanitizeProcessSmokeDiagnosticTag(label)} port ${port} is unavailable.`,
    ));
    server.once("error", fail);
    server.listen({ host: "127.0.0.1", port, exclusive: true }, () => {
      server.off("error", fail);
      server.close((error) => {
        if (error) rejectUnavailable(new Error(
          `${sanitizeProcessSmokeDiagnosticTag(label)} port ${port} could not be released.`,
        ));
        else resolveAvailable();
      });
    });
  });
}

async function assertLoopbackPortStablyAvailable(
  port,
  label,
  {
    stableMs = PROCESS_SMOKE_PORT_RELEASE_STABLE_MS,
    probeIntervalMs = PROCESS_SMOKE_PORT_RELEASE_PROBE_INTERVAL_MS,
  } = {},
) {
  assert.ok(Number.isSafeInteger(stableMs) && stableMs >= 1 && stableMs <= 30_000);
  assert.ok(
    Number.isSafeInteger(probeIntervalMs) &&
    probeIntervalMs >= 1 &&
    probeIntervalMs <= stableMs,
  );
  const deadline = Date.now() + stableMs;
  while (true) {
    await assertLoopbackPortAvailable(port, label);
    const remainingMs = deadline - Date.now();
    if (remainingMs <= 0) return;
    await new Promise((resolveDelay) => setTimeout(
      resolveDelay,
      Math.min(probeIntervalMs, remainingMs),
    ));
  }
}

async function waitForProcessExit(pid, timeoutMs, label) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      process.kill(pid, 0);
    } catch (error) {
      if (error?.code === "ESRCH") return;
      throw error;
    }
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 25));
  }
  throw new Error(`${label} process ${pid} did not exit within ${timeoutMs}ms.`);
}

async function cleanupBrokerProcessClients(brokers, { secrets, timeoutMs }) {
  const failures = await Promise.all(brokers.map(async (broker, index) => {
    const brokerName = index === 0 ? "broker-a" : "broker-b";
    const brokerFailures = [];
    broker.records.pid ??= broker.transport.pid;

    for (const [phase, close] of [
      ["client close", () => broker.client.close()],
      ["transport close", () => broker.transport.close()],
    ]) {
      try {
        await withBrokerCleanupTimeout(close, timeoutMs, `${brokerName} ${phase}`);
      } catch (error) {
        brokerFailures.push(createBrokerCleanupFailure(
          brokerName,
          phase,
          error,
          secrets,
        ));
      }
    }

    const pid = broker.records.pid;
    if (!Number.isSafeInteger(pid) || pid < 1) return brokerFailures;
    try {
      await waitForProcessExit(pid, timeoutMs, brokerName);
    } catch (error) {
      brokerFailures.push(createBrokerCleanupFailure(
        brokerName,
        "graceful process exit",
        error,
        secrets,
      ));
      try {
        await forceStopBrokerProcess(pid, timeoutMs, brokerName);
      } catch (forceError) {
        brokerFailures.push(createBrokerCleanupFailure(
          brokerName,
          "forced process exit",
          forceError,
          secrets,
        ));
      }
    }
    return brokerFailures;
  }));
  return failures.flat();
}

async function withBrokerCleanupTimeout(action, timeoutMs, label) {
  let timeout;
  try {
    return await Promise.race([
      Promise.resolve().then(action),
      new Promise((_, rejectTimeout) => {
        timeout = setTimeout(() => rejectTimeout(new Error(
          `${label} did not finish within ${timeoutMs}ms.`,
        )), timeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timeout);
  }
}

async function forceStopBrokerProcess(pid, timeoutMs, label) {
  const signalTimeoutMs = Math.min(timeoutMs, 2_000);
  let lastError;
  for (const signal of ["SIGTERM", "SIGKILL"]) {
    try {
      process.kill(pid, signal);
    } catch (error) {
      if (error?.code === "ESRCH") return;
      lastError = error;
      continue;
    }
    try {
      await waitForProcessExit(pid, signalTimeoutMs, `${label} ${signal}`);
      return;
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError ?? new Error(`${label} process ${pid} could not be stopped.`);
}

function createBrokerCleanupFailure(brokerName, phase, error, secrets) {
  const detail = redactProcessSmokeDiagnostic(
    error instanceof Error ? error.message : String(error),
    secrets,
  ).slice(0, 1_024);
  return new Error(`${brokerName} ${phase} failed${detail ? `: ${detail}` : "."}`);
}

async function createBrokerProcessSmokeFailure({
  stage,
  error,
  operations,
  owner,
  origin,
  bearerToken,
  hostileInheritedToken,
  agentToken,
  brokers,
}) {
  let ownerHealth = { status: "unavailable" };
  const diagnosticHealthAbort = new AbortController();
  const diagnosticHealthTimeout = setTimeout(
    () => diagnosticHealthAbort.abort(),
    FAILURE_DIAGNOSTIC_HEALTH_TIMEOUT_MS,
  );
  try {
    const health = await readAuthenticatedMcpHttpHealth(
      origin,
      bearerToken,
      { signal: diagnosticHealthAbort.signal },
    );
    ownerHealth = {
      status: "ready",
      pid: health.pid,
      startCount: health.startCount,
      activeSessions: health.activeSessions,
      retainedSessions: health.retainedSessions,
      buildHash: health.ownerIdentity?.buildHash,
    };
  } catch {
    // Failure diagnostics intentionally omit the underlying error text.
  } finally {
    clearTimeout(diagnosticHealthTimeout);
  }
  await new Promise((resolveImmediate) => setImmediate(resolveImmediate));
  const diagnostic = {
    stage,
    failure: summarizeBrokerOperationFailure(error, [
      bearerToken,
      hostileInheritedToken,
      agentToken,
    ]),
    operations: snapshotBrokerOperationSettlements(operations),
    owner: {
      pid: owner.child.pid,
      exitCode: owner.child.exitCode,
      signal: owner.child.signalCode,
      health: ownerHealth,
    },
    brokers: brokers.map((broker, index) => ({
      name: index === 0 ? "broker-a" : "broker-b",
      pid: broker.records.pid,
      exit: describeBrokerProcessState(broker),
      rootsHandlerInvocations: broker.records.rootsHandlerInvocations,
      wire: snapshotBrokerWireDirections(broker.records.wire),
      stderr: summarizeBrokerStderr(broker.records.stderr.join(""), [
        bearerToken,
        hostileInheritedToken,
        agentToken,
      ]),
    })),
  };
  const serialized = redactProcessSmokeDiagnostic(JSON.stringify(diagnostic), [
    bearerToken,
    hostileInheritedToken,
    agentToken,
  ]);
  assert.equal(serialized.includes(bearerToken), false);
  assert.equal(serialized.includes(hostileInheritedToken), false);
  assert.equal(serialized.includes(agentToken), false);
  return new Error(`Thin stdio broker process smoke failed: ${serialized}`);
}

function summarizeBrokerOperationFailure(error, secrets) {
  const detail = error instanceof Error
    ? `${error.name}: ${error.message}`
    : String(error);
  return redactProcessSmokeDiagnostic(detail, secrets, 512);
}

function snapshotBrokerOperationSettlements(operations) {
  const allowed = new Set(["not_started", "pending", "fulfilled", "rejected"]);
  return Object.fromEntries(
    ["toolsA", "toolsB", "resolvedA", "resolvedB", "progressiveReadA"].map((name) => [
      name,
      allowed.has(operations?.[name]) ? operations[name] : "unknown",
    ]),
  );
}

function snapshotBrokerWireDirections(wire) {
  return {
    hostToBroker: snapshotBrokerWireSummary(wire?.hostToBroker),
    brokerToHost: snapshotBrokerWireSummary(wire?.brokerToHost),
  };
}

function snapshotBrokerWireSummary(summary) {
  const requestMethods = Object.fromEntries(
    Object.entries(summary?.requestMethods ?? {})
      .slice(0, PROCESS_SMOKE_MAX_WIRE_REQUEST_METHODS)
      .map(([method, count]) => [
        boundedBrokerWireMethod(method),
        boundedBrokerDiagnosticCount(count),
      ]),
  );
  return {
    requestMethods,
    responses: boundedBrokerDiagnosticCount(summary?.responses),
    errors: boundedBrokerDiagnosticCount(summary?.errors),
    notifications: boundedBrokerDiagnosticCount(summary?.notifications),
    invalid: boundedBrokerDiagnosticCount(summary?.invalid),
  };
}

function boundedBrokerDiagnosticCount(value) {
  return Number.isSafeInteger(value) && value >= 0
    ? Math.min(value, PROCESS_SMOKE_MAX_WIRE_COUNT)
    : 0;
}

function describeBrokerProcessState(broker) {
  if (broker.records.closed) return "closed";
  const pid = broker.records.pid;
  if (!Number.isSafeInteger(pid) || pid < 1) return "not_started";
  try {
    process.kill(pid, 0);
    return "running";
  } catch (error) {
    return error?.code === "ESRCH" ? "exited" : "unknown";
  }
}

function summarizeBrokerStderr(stderr, secrets) {
  const redacted = redactProcessSmokeDiagnostic(stderr, secrets, 2_048);
  if (!redacted) return "<empty>";
  return redacted;
}

function redactProcessSmokeDiagnostic(
  value,
  secrets = [],
  maxChars = PROCESS_SMOKE_DIAGNOSTIC_MAX_CHARS,
) {
  let redacted = String(value);
  const exactSecrets = [...new Set(secrets
    .filter((secret) => typeof secret === "string" && secret.length > 0))]
    .sort((left, right) => right.length - left.length);
  redacted = redacted
    .replace(
      /(["']?authorization["']?\s*[:=]\s*["']?)(?:bearer\s+)?[^"',\s;)}\]]+/giu,
      "$1[REDACTED_AUTHORIZATION]",
    )
    .replace(/\bbearer\s+[A-Za-z0-9._~+\/-]+=*/giu, "[REDACTED_AUTHORIZATION]")
    .replace(
      /(["']?(?:mcp-session-id|sessionId|session_id)["']?\s*[:=]\s*["']?)[^"',\s;)}\]]+/giu,
      "$1[REDACTED_SESSION_ID]",
    )
    .replace(
      /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/giu,
      "[REDACTED_UUID]",
    );
  for (const secret of exactSecrets) {
    redacted = redacted.replaceAll(secret, "[REDACTED_SECRET]");
  }
  redacted = redacted.replace(
    /(^|[^A-Za-z0-9_-])([A-Za-z0-9_-]{43})(?=$|[^A-Za-z0-9_-])/gu,
    "$1[REDACTED_TOKEN]",
  );
  redacted = redactProcessSmokePaths(redacted);
  return boundProcessSmokeDiagnostic(redacted, maxChars);
}

function redactProcessSmokePaths(value) {
  let redacted = String(value)
    .replace(/file:\/\/\/[^\s"'`<>)}\],]+/giu, "file:///[REDACTED_PATH]")
    .replace(
      /(^|[^A-Za-z0-9])(?:[A-Za-z]:[\\/]|\\\\)[^\r\n"'`<>|)}\],]+/gu,
      "$1[REDACTED_PATH]",
    )
    .replace(/(^|[\s("'`=])\/(?!\/)[^\r\n\s"'`<>)}\],]+/gu, "$1[REDACTED_PATH]");
  const knownPaths = [repoRoot, scriptPath, process.cwd()]
    .filter(Boolean)
    .sort((left, right) => right.length - left.length);
  for (const path of new Set(knownPaths)) {
    if (!path) continue;
    redacted = redacted
      .replaceAll(path, "[REDACTED_PATH]")
      .replaceAll(path.replaceAll("\\", "/"), "[REDACTED_PATH]");
  }
  return redacted;
}

function boundProcessSmokeDiagnostic(value, maxChars = PROCESS_SMOKE_DIAGNOSTIC_MAX_CHARS) {
  const text = String(value);
  if (text.length <= maxChars) return text;
  const marker = "\n[...diagnostic truncated...]\n";
  const remaining = Math.max(0, maxChars - marker.length);
  const headLength = Math.ceil(remaining / 2);
  const tailLength = remaining - headLength;
  return `${text.slice(0, headLength)}${marker}${text.slice(text.length - tailLength)}`;
}

function formatProcessSmokeFailure(error, { stage, role, secrets = [] }) {
  const detail = formatProcessSmokeErrorDetail(error);
  return redactProcessSmokeDiagnostic(
    `Process smoke failure [stage=${sanitizeProcessSmokeDiagnosticTag(stage)} ` +
      `role=${sanitizeProcessSmokeDiagnosticTag(role)}]\n${detail}`,
    secrets,
  );
}

function formatProcessSmokeErrorDetail(error, depth = 0, seen = new Set()) {
  if (depth >= 4) return "[nested error depth limit reached]";
  if (typeof error !== "object" || error === null) return String(error);
  if (seen.has(error)) return "[circular error omitted]";
  seen.add(error);
  const primary = error instanceof Error
    ? error.stack ?? `${error.name}: ${error.message}`
    : String(error);
  if (!(error instanceof AggregateError)) return primary;
  const children = Array.from(error.errors).slice(0, 8);
  const details = children.map((child, index) =>
    `[aggregate error ${index + 1}]\n${formatProcessSmokeErrorDetail(
      child,
      depth + 1,
      seen,
    )}`
  );
  if (error.errors.length > children.length) {
    details.push(`[${error.errors.length - children.length} aggregate errors omitted]`);
  }
  return [primary, ...details].join("\n");
}

function collectProcessSmokeDiagnosticSecrets(environment) {
  return [
    "UI_ATTACH_BRIDGE_PROCESS_AGENT_TOKEN",
    "UI_ATTACH_BRIDGE_PROCESS_MCP_HTTP_TOKEN",
    "UI_ATTACH_BRIDGE_PROCESS_APPROVAL_KEY",
    "MEANTHIS_MCP_HTTP_TOKEN",
  ].map((name) => environment[name]).filter(
    (value) => typeof value === "string" && value.length > 0,
  );
}

function sanitizeProcessSmokeDiagnosticTag(value) {
  const normalized = String(value ?? "unknown")
    .replace(/[^A-Za-z0-9._:-]+/gu, "_")
    .slice(0, 64);
  return normalized || "unknown";
}

async function runProcessSmokeDiagnosticSelfTest({ writeSuccess = true } = {}) {
  const agentToken = Buffer.alloc(32, 0x11).toString("base64url");
  const mcpToken = Buffer.alloc(32, 0x22).toString("base64url");
  const sessionId = "opaque-process-smoke-session";
  const uuid = "95e3e7b1-6f74-44ae-8954-e11f7f2a7c58";
  const windowsPath = String.raw`C:\Users\example\private\worker.mjs:12:4`;
  const posixPath = "/home/example/private/worker.mjs:12:4";
  const fileUrlPath = "file:///D:/private/process-smoke/worker.mjs:12:4";
  const raw = [
    `agent=${agentToken}`,
    `Authorization: Bearer ${mcpToken}`,
    `mcp-session-id: ${sessionId}`,
    `sessionId=${sessionId}`,
    uuid,
    windowsPath,
    posixPath,
    fileUrlPath,
    "x".repeat(16_384),
  ].join("\n");
  const cases = [
    {
      diagnostic: formatProcessSmokeFailure(new Error(raw), {
        stage: "worker-bootstrap",
        role: "owner",
        secrets: [agentToken, mcpToken],
      }),
      stage: "worker-bootstrap",
      role: "owner",
    },
    {
      diagnostic: formatWorkerFailure({
        workerRole: "owner",
        diagnostics: [raw],
        diagnosticSecrets: [agentToken, mcpToken],
      }, "first-read"),
      stage: "first-read",
      role: "owner",
    },
    {
      diagnostic: formatWorkerFailure({
        workerRole: "read-proxy",
        diagnostics: [raw],
        diagnosticSecrets: [agentToken, mcpToken],
      }, "read"),
      stage: "read",
      role: "read-proxy",
    },
    {
      diagnostic: formatProcessSmokeFailure(new AggregateError([
        new Error(`broker child failure stage=connect role=broker-a\n${raw}`),
        new Error("broker cleanup failure stage=cleanup role=broker-b"),
      ], "Thin stdio broker process smoke and cleanup failed."), {
        stage: "parent",
        role: "parent",
        secrets: [agentToken, mcpToken],
      }),
      stage: "parent",
      role: "parent",
      aggregateStage: "connect",
      aggregateRole: "broker-a",
    },
  ];
  for (const {
    diagnostic,
    stage,
    role: expectedRole,
    aggregateStage,
    aggregateRole,
  } of cases) {
    assert.equal(diagnostic.includes(agentToken), false);
    assert.equal(diagnostic.includes(mcpToken), false);
    assert.equal(diagnostic.includes(sessionId), false);
    assert.equal(diagnostic.includes(uuid), false);
    assert.equal(diagnostic.includes(windowsPath), false);
    assert.equal(diagnostic.includes(posixPath), false);
    assert.equal(diagnostic.includes(fileUrlPath), false);
    assert.equal(diagnostic.includes("fil[REDACTED_PATH]"), false);
    assert.match(diagnostic, /\[REDACTED_SECRET\]/u);
    assert.match(diagnostic, /\[REDACTED_AUTHORIZATION\]/u);
    assert.match(diagnostic, /\[REDACTED_SESSION_ID\]/u);
    assert.match(diagnostic, /\[REDACTED_UUID\]/u);
    assert.match(diagnostic, /\[REDACTED_PATH\]/u);
    assert.match(diagnostic, /\[\.\.\.diagnostic truncated\.\.\.\]/u);
    assert.ok(diagnostic.includes(`stage=${stage}`));
    assert.ok(diagnostic.includes(`role=${expectedRole}`));
    if (aggregateStage) assert.ok(diagnostic.includes(`stage=${aggregateStage}`));
    if (aggregateRole) assert.ok(diagnostic.includes(`role=${aggregateRole}`));
    assert.ok(diagnostic.length <= PROCESS_SMOKE_DIAGNOSTIC_MAX_CHARS);
  }

  const hostToBroker = createBrokerWireSummary();
  const brokerToHost = createBrokerWireSummary();
  recordBrokerWireMessage(hostToBroker, {
    jsonrpc: "2.0",
    id: uuid,
    method: "tools/list",
    params: { token: mcpToken, path: windowsPath },
  });
  recordBrokerWireMessage(hostToBroker, {
    jsonrpc: "2.0",
    method: "notifications/initialized",
    params: { sessionId, path: posixPath },
  });
  recordBrokerWireMessage(brokerToHost, {
    jsonrpc: "2.0",
    id: sessionId,
    method: "roots/list",
    params: { token: agentToken, path: fileUrlPath },
  });
  recordBrokerWireMessage(brokerToHost, {
    jsonrpc: "2.0",
    id: windowsPath,
    result: { token: mcpToken, path: posixPath },
  });
  recordBrokerWireMessage(brokerToHost, {
    jsonrpc: "2.0",
    id: fileUrlPath,
    error: { code: -32_000, message: agentToken },
  });
  recordBrokerWireMessage(brokerToHost, {
    jsonrpc: "2.0",
    id: 99,
    method: windowsPath,
  });
  const wireDiagnostic = redactProcessSmokeDiagnostic(JSON.stringify({
    failure: summarizeBrokerOperationFailure(
      new Error(`Request timed out at ${windowsPath}: Bearer ${mcpToken}`),
      [agentToken, mcpToken],
    ),
    operations: snapshotBrokerOperationSettlements({
      toolsA: "fulfilled",
      toolsB: "fulfilled",
      resolvedA: "rejected",
      resolvedB: "pending",
      progressiveReadA: "fulfilled",
    }),
    rootsHandlerInvocations: 1,
    wire: snapshotBrokerWireDirections({ hostToBroker, brokerToHost }),
  }), [agentToken, mcpToken]);
  assert.equal(wireDiagnostic.includes(agentToken), false);
  assert.equal(wireDiagnostic.includes(mcpToken), false);
  assert.equal(wireDiagnostic.includes(sessionId), false);
  assert.equal(wireDiagnostic.includes(uuid), false);
  assert.equal(wireDiagnostic.includes(windowsPath), false);
  assert.equal(wireDiagnostic.includes(posixPath), false);
  assert.equal(wireDiagnostic.includes(fileUrlPath), false);
  assert.equal(wireDiagnostic.includes('"params"'), false);
  assert.match(wireDiagnostic, /"tools\/list":1/u);
  assert.match(wireDiagnostic, /"roots\/list":1/u);
  assert.match(wireDiagnostic, /"other":1/u);
  assert.match(wireDiagnostic, /"responses":1/u);
  assert.match(wireDiagnostic, /"errors":1/u);
  assert.match(wireDiagnostic, /"notifications":1/u);
  assert.match(wireDiagnostic, /"rootsHandlerInvocations":1/u);
  assert.match(wireDiagnostic, /"toolsA":"fulfilled"/u);
  assert.match(wireDiagnostic, /"resolvedA":"rejected"/u);
  assert.match(wireDiagnostic, /"progressiveReadA":"fulfilled"/u);
  assert.ok(wireDiagnostic.length <= PROCESS_SMOKE_DIAGNOSTIC_MAX_CHARS);

  const parentDispatch = [];
  await dispatchProcessSmoke({
    args: ["node", scriptPath],
    workerRole: undefined,
    runDiagnosticSelfTest: async (options) => { parentDispatch.push(["diagnostic", options]); },
    runWorkerProcess: async (workerRole) => { parentDispatch.push(["worker", workerRole]); },
    runParentProcess: async () => { parentDispatch.push(["parent"]); },
  });
  assert.deepEqual(parentDispatch, [
    ["diagnostic", { writeSuccess: false }],
    ["parent"],
  ]);

  const workerDispatch = [];
  await dispatchProcessSmoke({
    args: ["node", scriptPath],
    workerRole: "owner",
    runDiagnosticSelfTest: async (options) => { workerDispatch.push(["diagnostic", options]); },
    runWorkerProcess: async (workerRole) => { workerDispatch.push(["worker", workerRole]); },
    runParentProcess: async () => { workerDispatch.push(["parent"]); },
  });
  assert.deepEqual(workerDispatch, [["worker", "owner"]]);

  const explicitDispatch = [];
  await dispatchProcessSmoke({
    args: ["node", scriptPath, PROCESS_SMOKE_DIAGNOSTIC_SELF_TEST_FLAG],
    workerRole: "owner",
    runDiagnosticSelfTest: async (options) => { explicitDispatch.push(["diagnostic", options]); },
    runWorkerProcess: async (workerRole) => { explicitDispatch.push(["worker", workerRole]); },
    runParentProcess: async () => { explicitDispatch.push(["parent"]); },
  });
  assert.deepEqual(explicitDispatch, [["diagnostic", { writeSuccess: true }]]);

  if (writeSuccess) {
    process.stdout.write("Process smoke diagnostic redaction verified.\n");
  }
}

function assertBrokerProcessDidNotLeakToken(broker, bearerToken) {
  assert.equal(broker.records.command.includes(bearerToken), false);
  assert.equal(broker.records.stdin.join("").includes(bearerToken), false);
  assert.equal(broker.records.stdout.join("").includes(bearerToken), false);
  assert.equal(broker.records.stderr.join("").includes(bearerToken), false);
  assert.equal(broker.records.command.includes(broker.hostileInheritedToken), true);
  assert.equal(broker.records.stdin.join("").includes(broker.hostileInheritedToken), false);
  assert.equal(broker.records.stdout.join("").includes(broker.hostileInheritedToken), false);
  assert.equal(broker.records.stderr.join("").includes(broker.hostileInheritedToken), false);
}

function spawnWorker(workerRole, options) {
  const child = fork(scriptPath, [], {
    cwd: repoRoot,
    env: {
      ...process.env,
      [ROLE_ENV]: workerRole,
      UI_ATTACH_BRIDGE_PROCESS_AGENT_TOKEN: options.agentToken,
      UI_ATTACH_BRIDGE_PROCESS_OWNER_IDENTITY: JSON.stringify(options.ownerIdentity),
      ...(options.agentCodexHome ? {
        UI_ATTACH_BRIDGE_PROCESS_AGENT_CODEX_HOME: options.agentCodexHome,
      } : {}),
      ...(options.sentinelPath ? {
        UI_ATTACH_BRIDGE_PROCESS_BUILD_SENTINEL: options.sentinelPath,
        UI_ATTACH_BRIDGE_PROCESS_IDLE_MS: String(options.idleMs),
        UI_ATTACH_BRIDGE_PROCESS_IDLE_CHECK_MS: String(options.idleCheckMs),
      } : {}),
      ...(options.ownerPort !== undefined ? {
        UI_ATTACH_BRIDGE_PROCESS_OWNER_PORT: String(options.ownerPort),
      } : {}),
      ...(options.origin ? { UI_ATTACH_BRIDGE_PROCESS_ORIGIN: options.origin } : {}),
      ...(options.brokerCodexHome ? {
        UI_ATTACH_BRIDGE_PROCESS_BROKER_CODEX_HOME: options.brokerCodexHome,
      } : {}),
      ...(options.mcpHttpToken ? {
        UI_ATTACH_BRIDGE_PROCESS_MCP_HTTP_TOKEN: options.mcpHttpToken,
      } : {}),
      ...(options.mcpHttpTokenFingerprint ? {
        UI_ATTACH_BRIDGE_PROCESS_MCP_HTTP_TOKEN_FINGERPRINT:
          options.mcpHttpTokenFingerprint,
      } : {}),
      ...(options.mcpHttpBuildSentinel ? {
        UI_ATTACH_BRIDGE_PROCESS_MCP_HTTP_BUILD_SENTINEL:
          options.mcpHttpBuildSentinel,
      } : {}),
      ...(options.mcpHttpPort ? {
        UI_ATTACH_BRIDGE_PROCESS_MCP_HTTP_PORT: String(options.mcpHttpPort),
      } : {}),
      ...(options.mcpClientName ? {
        UI_ATTACH_BRIDGE_PROCESS_MCP_CLIENT_NAME: options.mcpClientName,
      } : {}),
      ...(options.instanceId ? { UI_ATTACH_BRIDGE_PROCESS_INSTANCE_ID: options.instanceId } : {}),
      ...(options.requestId ? { UI_ATTACH_BRIDGE_PROCESS_REQUEST_ID: options.requestId } : {}),
      ...(options.approvalMode ? {
        UI_ATTACH_BRIDGE_PROCESS_APPROVAL_MODE: options.approvalMode,
      } : {}),
      ...(options.approvalKey ? {
        UI_ATTACH_BRIDGE_PROCESS_APPROVAL_KEY: options.approvalKey,
      } : {}),
      ...(options.leaseDurationMs ? {
        UI_ATTACH_BRIDGE_PROCESS_LEASE_DURATION_MS: String(options.leaseDurationMs),
      } : {}),
      ...(options.leaseIntervalMs ? {
        UI_ATTACH_BRIDGE_PROCESS_LEASE_INTERVAL_MS: String(options.leaseIntervalMs),
      } : {}),
    },
    stdio: ["ignore", "pipe", "pipe", "ipc"],
    windowsHide: true,
  });
  const diagnostics = [];
  child.stdout.on("data", (chunk) => diagnostics.push(String(chunk)));
  child.stderr.on("data", (chunk) => diagnostics.push(String(chunk)));
  const diagnosticSecrets = [
    options.agentToken,
    options.mcpHttpToken,
    options.approvalKey,
  ].filter((value) => typeof value === "string" && value.length > 0);
  return { child, diagnostics, diagnosticSecrets, workerRole };
}

async function runProxy(workers, workerRole, options, messageType) {
  const worker = spawnWorker(workerRole, options);
  workers.add(worker);
  const messagePromise = waitForMessage(worker, messageType);
  const exitPromise = waitForExit(worker, 5_000);
  const message = await messagePromise;
  const exit = await exitPromise;
  assert.equal(exit.code, 0, formatWorkerFailure(worker, workerRole));
  return message;
}

async function assertCleanExit(worker, timeoutMs, label) {
  const exit = await waitForExit(worker, timeoutMs);
  assert.equal(exit.code, 0, formatWorkerFailure(worker, label));
}

function waitForMessage(worker, expectedType, timeoutMs = 5_000) {
  return new Promise((resolveMessage, rejectMessage) => {
    const timeout = setTimeout(() => finish(new Error(`Timed out waiting for ${expectedType}.`)), timeoutMs);
    const onMessage = (message) => {
      if (!message || message.type !== expectedType) return;
      finish(null, message);
    };
    const onExit = (code, signal) => finish(new Error(
      `Worker exited before ${expectedType}: code=${code} signal=${signal}.`,
    ));
    const onError = (error) => finish(error);
    const finish = (error, message) => {
      clearTimeout(timeout);
      worker.child.off("message", onMessage);
      worker.child.off("exit", onExit);
      worker.child.off("error", onError);
      if (error) rejectMessage(new Error(`${error.message}\n${formatWorkerFailure(worker, expectedType)}`));
      else resolveMessage(message);
    };
    worker.child.on("message", onMessage);
    worker.child.once("exit", onExit);
    worker.child.once("error", onError);
  });
}

function waitForExit(worker, timeoutMs) {
  if (worker.child.exitCode !== null) {
    return Promise.resolve({ code: worker.child.exitCode, signal: worker.child.signalCode });
  }
  return new Promise((resolveExit, rejectExit) => {
    const timeout = setTimeout(() => {
      cleanup();
      rejectExit(new Error(`Worker exit timed out.\n${formatWorkerFailure(worker, "exit")}`));
    }, timeoutMs);
    const onExit = (code, signal) => {
      cleanup();
      resolveExit({ code, signal });
    };
    const onError = (error) => {
      cleanup();
      rejectExit(error);
    };
    const cleanup = () => {
      clearTimeout(timeout);
      worker.child.off("exit", onExit);
      worker.child.off("error", onError);
    };
    worker.child.once("exit", onExit);
    worker.child.once("error", onError);
  });
}

async function stopWorker(worker) {
  if (worker.child.exitCode !== null) return;
  worker.child.kill();
  try {
    await waitForExit(worker, 2_000);
  } catch {
    worker.child.kill("SIGKILL");
    await waitForExit(worker, 2_000);
  }
}

function closeConnectionFetch(input, init = {}) {
  return fetch(input, {
    ...init,
    headers: { ...init.headers, connection: "close" },
  });
}

async function readAuthenticatedMcpHttpHealth(origin, bearerToken, { signal } = {}) {
  const {
    createLocalBridgeMcpHttpHealthProofRequest,
    isLocalBridgeMcpHttpHealth,
    verifyLocalBridgeMcpHttpHealthProofResponse,
  } = await import("../dist/local-bridge-mcp-http.js");
  const port = Number(new URL(origin).port);
  const proofRequest = createLocalBridgeMcpHttpHealthProofRequest(bearerToken, { port });
  assert.equal(JSON.stringify(proofRequest.headers).includes(bearerToken), false);
  const response = await closeConnectionFetch(`${origin}/health`, {
    headers: proofRequest.headers,
    signal,
  });
  const body = await response.text();
  assert.equal(response.status, 200);
  assert.equal(body.includes(bearerToken), false);
  assert.equal(verifyLocalBridgeMcpHttpHealthProofResponse(
    bearerToken,
    proofRequest,
    {
      port,
      status: response.status,
      headers: response.headers,
      body,
    },
  ), true);
  const health = JSON.parse(body);
  assert.equal(isLocalBridgeMcpHttpHealth(health), true);
  return health;
}

function sendMessage(message) {
  if (!process.send) throw new Error("Process-smoke worker is missing its IPC channel.");
  process.send(message);
}

function requireEnvironment(name) {
  const value = process.env[name];
  if (!value) throw new Error(`Missing process-smoke environment value: ${name}`);
  return value;
}

function formatWorkerFailure(worker, label) {
  const diagnostics = worker.diagnostics.join("").trim();
  return redactProcessSmokeDiagnostic(
    `Process smoke worker failure [` +
      `stage=${sanitizeProcessSmokeDiagnosticTag(label)} ` +
      `role=${sanitizeProcessSmokeDiagnosticTag(worker.workerRole)}]` +
      `${diagnostics ? `\n${diagnostics}` : "."}`,
    worker.diagnosticSecrets ?? [],
  );
}
