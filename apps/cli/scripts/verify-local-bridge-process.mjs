import assert from "node:assert/strict";
import { fork } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROLE_ENV = "UI_ATTACH_BRIDGE_PROCESS_SMOKE_ROLE";
const scriptPath = fileURLToPath(import.meta.url);
const repoRoot = resolve(dirname(scriptPath), "../../..");
const extensionOrigin = "chrome-extension://bbiiccaidhlhdagmabkogleldjdnmlfn";
const expectedPageInstanceId = "chromium-tab:4242:frame:0";
const expectedRoute = "https://example.test/workspace";

const role = process.env[ROLE_ENV];
if (role) {
  try {
    await runWorker(role);
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
    process.exitCode = 1;
    if (process.connected) process.disconnect();
  }
} else {
  await runParent();
}

async function runWorker(workerRole) {
  const agentToken = requireEnvironment("UI_ATTACH_BRIDGE_PROCESS_AGENT_TOKEN");
  const ownerIdentity = JSON.parse(requireEnvironment("UI_ATTACH_BRIDGE_PROCESS_OWNER_IDENTITY"));

  if (workerRole === "owner") {
    const { runDetachedLocalBridgeOwner } = await import("../dist/local-bridge-owner.js");
    const sentinelPath = requireEnvironment("UI_ATTACH_BRIDGE_PROCESS_BUILD_SENTINEL");
    await runDetachedLocalBridgeOwner({
      agentToken,
      port: 0,
      ownerIdentity,
      loadOwnerIdentity: () => ({
        ...ownerIdentity,
        buildHash: readFileSync(sentinelPath, "utf8").trim(),
      }),
      idleMs: Number(requireEnvironment("UI_ATTACH_BRIDGE_PROCESS_IDLE_MS")),
      idleCheckMs: Number(requireEnvironment("UI_ATTACH_BRIDGE_PROCESS_IDLE_CHECK_MS")),
      onReady: ({ origin }) => sendMessage({ type: "ready", origin }),
    });
    sendMessage({ type: "closed" });
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
  try {
    const idleSentinel = join(temporaryRoot, "idle-build-hash.txt");
    const identity = {
      executablePath: process.execPath,
      entryPath: `${scriptPath}#idle-owner`,
      buildHash: "a".repeat(64),
    };
    const agentToken = randomBytes(32).toString("base64url");
    await writeFile(idleSentinel, identity.buildHash, "utf8");

    const owner = spawnWorker("owner", {
      agentToken,
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
      ownerIdentity: leaseIdentity,
      sentinelPath: leaseSentinel,
      idleMs: 250,
      idleCheckMs: 10,
    });
    workers.add(leaseOwner);
    const leaseReady = await waitForMessage(leaseOwner, "ready");
    await runProxy(workers, "lease-proxy", {
      agentToken,
      ownerIdentity: leaseIdentity,
      origin: leaseReady.origin,
      leaseDurationMs: 750,
      leaseIntervalMs: 50,
    }, "lease-held");
    assert.equal(leaseOwner.child.exitCode, null, "owner exited while an MCP lease was active");
    await assertCleanExit(leaseOwner, 2_000, "post-lease idle owner");

    const buildSentinel = join(temporaryRoot, "changed-build-hash.txt");
    const buildIdentity = {
      executablePath: process.execPath,
      entryPath: `${scriptPath}#build-owner`,
      buildHash: "b".repeat(64),
    };
    await writeFile(buildSentinel, buildIdentity.buildHash, "utf8");
    const buildOwner = spawnWorker("owner", {
      agentToken,
      ownerIdentity: buildIdentity,
      sentinelPath: buildSentinel,
      idleMs: 10_000,
      idleCheckMs: 25,
    });
    workers.add(buildOwner);
    await waitForMessage(buildOwner, "ready");
    await writeFile(buildSentinel, "c".repeat(64), "utf8");
    await assertCleanExit(buildOwner, 5_000, "build-changed owner");

    process.stdout.write(
      "Local bridge owner process smoke verified: browser request approval, fresh proxy read, active MCP lease, post-lease idle cleanup, and build-change cleanup passed.\n",
    );
  } finally {
    const cleanup = await Promise.allSettled([...workers].map(stopWorker));
    await rm(temporaryRoot, { recursive: true, force: true });
    const failures = cleanup
      .filter((result) => result.status === "rejected")
      .map((result) => result.reason);
    if (failures.length > 0) {
      throw new AggregateError(failures, "Process-smoke child cleanup failed.");
    }
  }
}

function spawnWorker(workerRole, options) {
  const child = fork(scriptPath, [], {
    cwd: repoRoot,
    env: {
      ...process.env,
      [ROLE_ENV]: workerRole,
      UI_ATTACH_BRIDGE_PROCESS_AGENT_TOKEN: options.agentToken,
      UI_ATTACH_BRIDGE_PROCESS_OWNER_IDENTITY: JSON.stringify(options.ownerIdentity),
      ...(options.sentinelPath ? {
        UI_ATTACH_BRIDGE_PROCESS_BUILD_SENTINEL: options.sentinelPath,
        UI_ATTACH_BRIDGE_PROCESS_IDLE_MS: String(options.idleMs),
        UI_ATTACH_BRIDGE_PROCESS_IDLE_CHECK_MS: String(options.idleCheckMs),
      } : {}),
      ...(options.origin ? { UI_ATTACH_BRIDGE_PROCESS_ORIGIN: options.origin } : {}),
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
  return { child, diagnostics };
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
  return `${label} failed${diagnostics ? `: ${diagnostics}` : "."}`;
}
