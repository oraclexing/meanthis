import { describe, expect, test } from "vitest";
import {
  MEANTHIS_CHROME_WEB_STORE_EXTENSION_ID,
  createLocalBridgeState,
  startLocalBridgeHttpServer,
} from "./local-bridge";
import {
  MEANTHIS_CHROME_WEB_STORE_ID,
} from "../../extension-mv3/scripts/extension-identity.mjs";
import {
  createLocalBridgeAgentRequestAuth,
  sealLocalBridgeApprovalKey,
} from "./local-bridge-agent-auth";

const EXTENSION_ORIGIN = "chrome-extension://bbiiccaidhlhdagmabkogleldjdnmlfn";
const OTHER_EXTENSION_ORIGIN = "chrome-extension://abcdefghijklmnopabcdefghijklmnop";
const INSTALLATION_ID = "5ea6b70f-48e8-4a7b-bc91-d943b0ef10f3";
const AGENT_TOKEN = "CwsLCwsLCwsLCwsLCwsLCwsLCwsLCwsLCwsLCwsLCws";
const APPROVAL_KEY = "DAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAw";
const APPROVAL_VERIFIER = "MIwc-JegXDWE1xhuMLuAumhs4XH1TLOAsg-rk3mfc0E";
const OWNER_IDENTITY = {
  executablePath: "C:\\Program Files\\nodejs\\node.exe",
  entryPath: "C:\\fixtures\\ui-attach\\apps\\cli\\dist\\index.js",
  buildHash: "a".repeat(64),
};

function createSnapshot(sequence = 1) {
  return {
    schemaVersion: "0.1.0" as const,
    kind: "ui-attach.local-bridge-snapshot" as const,
    sequence,
    publishedAt: "2026-07-17T04:30:00.000Z",
    page: {
      pageInstanceId: "chromium-tab:1199971128:frame:0",
      route: "https://aistudio.google.com/prompts/new_chat",
    },
    attachmentCount: 1,
    agentCopy: "# MeanThis Capture Bundle\n\nAgent-safe handoff.",
  };
}

describe("local agent bridge state", () => {
  test("shares the exact Chrome Web Store identity with the extension release", () => {
    expect(MEANTHIS_CHROME_WEB_STORE_EXTENSION_ID).toBe(MEANTHIS_CHROME_WEB_STORE_ID);
  });

  test("accepts only the pinned Chrome Web Store extension identity", () => {
    const state = createTestState();
    const trusted = createConnectionRequest();
    const other = createConnectionRequest({
      requestId: "dc603c4d-a8e8-41e9-b440-c493181d9664",
    });

    expect(state.createConnectionRequest(EXTENSION_ORIGIN, trusted).ok).toBe(true);
    expect(state.createConnectionRequest(OTHER_EXTENSION_ORIGIN, other)).toEqual({
      ok: false,
      code: "ORIGIN_DENIED",
    });
  });

  test("requires authenticated agent approval before exposing a browser-created connection token", () => {
    const state = createTestState();
    const request = createConnectionRequest();

    const created = state.createConnectionRequest(EXTENSION_ORIGIN, request);
    expect(created).toMatchObject({
      ok: true,
      value: {
        requestId: request.requestId,
        approvalMode: "ask",
        status: "pending",
      },
    });
    expect(JSON.stringify(created)).not.toContain(request.requestSecret);
    expect(state.approveConnectionRequest(
      request.requestId,
      "DQ0NDQ0NDQ0NDQ0NDQ0NDQ0NDQ0NDQ0NDQ0NDQ0NDQ0",
    )).toMatchObject({
      ok: false,
      code: "PAIRING_DENIED",
    });
    expect(state.approveConnectionRequest(request.requestId, APPROVAL_KEY)).toMatchObject({
      ok: true,
      value: {
        requestId: request.requestId,
        approvalMode: "ask",
      },
    });
    expect(JSON.stringify(state.approveConnectionRequest(request.requestId, APPROVAL_KEY)))
      .not.toMatch(/token|requestSecret/);
    expect(state.readConnectionRequest(EXTENSION_ORIGIN, request.requestId, "wrong-secret")).toMatchObject({
      ok: false,
      code: "AUTH_DENIED",
    });
    expect(state.readConnectionRequest(EXTENSION_ORIGIN, request.requestId, request.requestSecret)).toMatchObject({
      ok: true,
      value: {
        requestId: request.requestId,
        status: "approved",
        instanceId: expect.stringMatching(/^instance-[0-9a-f]{12}$/),
        token: expect.stringMatching(/^[A-Za-z0-9_-]{43}$/),
        approvalProof: expect.stringMatching(/^[A-Za-z0-9_-]{43}$/),
      },
    });
  });

  test("auto-approves only the same explicitly trusted browser session and revokes it on disconnect", () => {
    const state = createTestState();
    const first = createConnectionRequest({ approvalMode: "browser_session" });
    expect(state.createConnectionRequest(EXTENSION_ORIGIN, first)).toMatchObject({
      ok: true,
      value: { status: "pending" },
    });
    expect(state.approveConnectionRequest(first.requestId, APPROVAL_KEY).ok).toBe(true);
    const firstRead = state.readConnectionRequest(EXTENSION_ORIGIN, first.requestId, first.requestSecret);
    expect(firstRead.ok).toBe(true);
    if (!firstRead.ok || firstRead.value.status !== "approved") return;
    expect(firstRead.value).toMatchObject({
      approvalProof: expect.stringMatching(/^[A-Za-z0-9_-]{43}$/),
      sessionTrustKey: expect.stringMatching(/^[A-Za-z0-9_-]{43}$/),
    });

    const sameSession = createConnectionRequest({
      approvalMode: "browser_session",
      requestId: "20a85d08-3aed-4c24-9006-221db95ab33c",
      requestSecret: "DAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAw",
    });
    expect(state.createConnectionRequest(EXTENSION_ORIGIN, sameSession)).toMatchObject({
      ok: true,
      value: { status: "approved", instanceId: firstRead.value.instanceId },
    });
    const sameRead = state.readConnectionRequest(
      EXTENSION_ORIGIN,
      sameSession.requestId,
      sameSession.requestSecret,
    );
    expect(sameRead.ok).toBe(true);
    if (!sameRead.ok || sameRead.value.status !== "approved") return;
    expect(state.disconnect(EXTENSION_ORIGIN, sameRead.value.token).ok).toBe(true);

    const afterDisconnect = createConnectionRequest({
      approvalMode: "browser_session",
      requestId: "41ea3cc5-4b2f-4bf5-8bd6-10ce0f5beef1",
      requestSecret: "DQ0NDQ0NDQ0NDQ0NDQ0NDQ0NDQ0NDQ0NDQ0NDQ0NDQ0",
    });
    expect(state.createConnectionRequest(EXTENSION_ORIGIN, afterDisconnect)).toMatchObject({
      ok: true,
      value: { status: "pending" },
    });

    const otherBrowserSession = createConnectionRequest({
      approvalMode: "browser_session",
      browserSessionId: "f4945dc2-64e4-4c97-86c2-b4eefbb3bb11",
      requestId: "8a4e3336-9cb7-4dde-8e92-7912ab0348db",
      requestSecret: "Dg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4",
    });
    expect(state.createConnectionRequest(EXTENSION_ORIGIN, otherBrowserSession)).toMatchObject({
      ok: true,
      value: { status: "pending" },
    });
  });

  test("explicit cancel revokes an already delivered instance and browser-session trust", () => {
    const state = createTestState();
    const request = createConnectionRequest({ approvalMode: "browser_session" });
    expect(state.createConnectionRequest(EXTENSION_ORIGIN, request).ok).toBe(true);
    expect(state.approveConnectionRequest(request.requestId, APPROVAL_KEY).ok).toBe(true);
    const delivered = state.readConnectionRequest(
      EXTENSION_ORIGIN,
      request.requestId,
      request.requestSecret,
    );
    expect(delivered.ok).toBe(true);
    if (!delivered.ok || !delivered.value.instanceId) return;

    expect(state.cancelConnectionRequest(
      EXTENSION_ORIGIN,
      request.requestId,
      request.requestSecret,
    )).toMatchObject({ ok: true });
    expect(state.readInstance(delivered.value.instanceId)).toMatchObject({
      ok: false,
      code: "INSTANCE_NOT_FOUND",
    });
    const next = createConnectionRequest({
      approvalMode: "browser_session",
      requestId: "20a85d08-3aed-4c24-9006-221db95ab33c",
      requestSecret: "DQ0NDQ0NDQ0NDQ0NDQ0NDQ0NDQ0NDQ0NDQ0NDQ0NDQ0",
    });
    expect(state.createConnectionRequest(EXTENSION_ORIGIN, next)).toMatchObject({
      ok: true,
      value: { status: "pending" },
    });
  });

  test("expires browser-created connection requests fail closed", () => {
    let now = new Date("2026-07-17T04:30:00.000Z");
    const state = createTestState({ now: () => now });
    const request = createConnectionRequest();
    expect(state.createConnectionRequest(EXTENSION_ORIGIN, request).ok).toBe(true);
    now = new Date("2026-07-17T04:32:00.001Z");
    expect(state.approveConnectionRequest(request.requestId, APPROVAL_KEY)).toMatchObject({
      ok: false,
      code: "PAIRING_DENIED",
    });
    expect(state.readConnectionRequest(EXTENSION_ORIGIN, request.requestId, request.requestSecret)).toMatchObject({
      ok: false,
      code: "PAIRING_DENIED",
    });
  });

  test("bounds pending browser-created requests per extension origin", () => {
    const state = createTestState();
    for (let index = 0; index < 8; index += 1) {
      const suffix = index.toString(16).padStart(12, "0");
      expect(state.createConnectionRequest(EXTENSION_ORIGIN, createConnectionRequest({
        requestId: `00000000-0000-4000-8000-${suffix}`,
        browserSessionId: `10000000-0000-4000-8000-${suffix}`,
      })).ok).toBe(true);
    }
    expect(state.createConnectionRequest(EXTENSION_ORIGIN, createConnectionRequest({
      requestId: "20000000-0000-4000-8000-000000000000",
      browserSessionId: "30000000-0000-4000-8000-000000000000",
    }))).toMatchObject({ ok: false, code: "PAIRING_DENIED" });
  });

  test("pairs one extension installation without exposing credentials", () => {
    const state = createTestState();
    expect(state.getStatus()).toMatchObject({
      kind: "ui-attach.local-bridge-status",
      pairing: { code: "482-193" },
      instances: [],
    });

    const paired = state.pair(EXTENSION_ORIGIN, {
      schemaVersion: "0.1.0",
      kind: "ui-attach.local-bridge-pair",
      pairingCode: "482-193",
      installationId: INSTALLATION_ID,
    });

    expect(paired.ok).toBe(true);
    if (!paired.ok) return;
    expect(paired.value.instanceId).toMatch(/^instance-[0-9a-f]{12}$/);
    expect(paired.value.token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(JSON.stringify(state.getStatus())).not.toContain(INSTALLATION_ID);
    expect(JSON.stringify(state.getStatus())).not.toContain(paired.value.token);
    expect(state.getStatus().pairing.code).toBe("482-194");
  });

  test("requires the extension origin, current one-time code, and monotonic sequence", () => {
    const state = createTestState();
    const request = {
      schemaVersion: "0.1.0" as const,
      kind: "ui-attach.local-bridge-pair" as const,
      pairingCode: "482-193",
      installationId: INSTALLATION_ID,
    };
    expect(state.pair("https://example.test", request)).toMatchObject({ ok: false, code: "ORIGIN_DENIED" });
    const paired = state.pair(EXTENSION_ORIGIN, request);
    expect(paired.ok).toBe(true);
    if (!paired.ok) return;
    expect(state.pair(EXTENSION_ORIGIN, request)).toMatchObject({ ok: false, code: "PAIRING_DENIED" });
    expect(state.publish(EXTENSION_ORIGIN, "wrong-token", createSnapshot())).toMatchObject({
      ok: false,
      code: "AUTH_DENIED",
    });
    expect(state.publish(EXTENSION_ORIGIN, paired.value.token, createSnapshot())).toMatchObject({ ok: true });
    expect(state.publish(EXTENSION_ORIGIN, paired.value.token, createSnapshot())).toMatchObject({
      ok: false,
      code: "STALE_SNAPSHOT",
    });
    expect(state.readInstance(paired.value.instanceId)).toMatchObject({
      ok: true,
      value: {
        instanceId: paired.value.instanceId,
        extensionId: "bbiiccaidhlhdagmabkogleldjdnmlfn",
        snapshot: { sequence: 1, attachmentCount: 1 },
      },
    });
  });

  test("rotates and temporarily locks pairing after five failed guesses", () => {
    let now = new Date("2026-07-17T04:30:00.000Z");
    const pairingCodes = [482_193, 482_194, 482_195];
    const state = createLocalBridgeState({
      now: () => now,
      randomInt: () => pairingCodes.shift() ?? 999_999,
      randomBytes: (size) => Buffer.alloc(size, 7),
    });
    const wrongRequest = {
      schemaVersion: "0.1.0",
      kind: "ui-attach.local-bridge-pair",
      pairingCode: "000-000",
      installationId: INSTALLATION_ID,
    };

    for (let attempt = 0; attempt < 5; attempt += 1) {
      expect(state.pair(EXTENSION_ORIGIN, wrongRequest)).toMatchObject({
        ok: false,
        code: "PAIRING_DENIED",
      });
    }
    expect(state.getStatus().pairing).toMatchObject({
      code: "482-194",
      attemptsRemaining: 5,
      lockedUntil: "2026-07-17T04:30:30.000Z",
    });

    const currentRequest = { ...wrongRequest, pairingCode: "482-194" };
    expect(state.pair(EXTENSION_ORIGIN, currentRequest)).toMatchObject({
      ok: false,
      code: "PAIRING_DENIED",
    });
    now = new Date("2026-07-17T04:30:30.000Z");
    expect(state.pair(EXTENSION_ORIGIN, currentRequest)).toMatchObject({ ok: true });
  });

  test("keeps status and list reads summary-only", () => {
    const state = createTestState();
    const paired = state.pair(EXTENSION_ORIGIN, {
      schemaVersion: "0.1.0",
      kind: "ui-attach.local-bridge-pair",
      pairingCode: "482-193",
      installationId: INSTALLATION_ID,
    });
    expect(paired.ok).toBe(true);
    if (!paired.ok) return;
    expect(state.publish(EXTENSION_ORIGIN, paired.value.token, createSnapshot())).toMatchObject({ ok: true });

    expect(JSON.stringify(state.getStatus())).not.toContain("Agent-safe handoff");
    expect(JSON.stringify(state.listInstances())).not.toContain("Agent-safe handoff");
    expect(state.listInstances()[0]).not.toHaveProperty("snapshot");
    expect(state.readInstance(paired.value.instanceId)).toMatchObject({
      ok: true,
      value: { snapshot: { agentCopy: expect.stringContaining("Agent-safe") } },
    });
  });

  test("fails closed when an exact instance snapshot is stale", () => {
    let now = new Date("2026-07-17T04:30:00.000Z");
    const state = createLocalBridgeState({
      now: () => now,
      randomInt: () => 482_193,
      randomBytes: (size) => Buffer.alloc(size, 7),
    });
    const paired = state.pair(EXTENSION_ORIGIN, {
      schemaVersion: "0.1.0",
      kind: "ui-attach.local-bridge-pair",
      pairingCode: "482-193",
      installationId: INSTALLATION_ID,
    });
    expect(paired.ok).toBe(true);
    if (!paired.ok) return;
    expect(state.publish(EXTENSION_ORIGIN, paired.value.token, createSnapshot())).toMatchObject({ ok: true });
    now = new Date("2026-07-17T04:30:31.000Z");

    expect(state.readInstance(paired.value.instanceId)).toMatchObject({
      ok: false,
      code: "INSTANCE_STALE",
    });
  });
});

describe("local agent bridge HTTP boundary", () => {
  test("requires owner identity for authenticated agent sharing", async () => {
    await expect(startLocalBridgeHttpServer(createTestState(), {
      port: 0,
      agentToken: AGENT_TOKEN,
    })).rejects.toThrow("owner identity");
  });

  test("rejects new requests after owner closing begins", async () => {
    let requestStarts = 0;
    const server = await startLocalBridgeHttpServer(createTestState(), {
      port: 0,
      isClosing: () => true,
      onRequestStart: () => { requestStarts += 1; },
    });
    try {
      const response = await fetch(`${server.origin}/health`);
      expect(response.status).toBe(503);
      expect(requestStarts).toBe(0);
    } finally {
      await server.close();
    }
  });

  test("binds loopback, rejects page origins, and accepts authenticated snapshots", async () => {
    let activityCount = 0;
    const state = createTestState();
    const server = await startLocalBridgeHttpServer(state, {
      port: 0,
      onActivity: () => { activityCount += 1; },
    });
    try {
      const deniedCapabilities = await fetch(`${server.origin}/v1/capabilities`, {
        headers: { origin: "https://example.test" },
      });
      expect(deniedCapabilities.status).toBe(403);

      const deniedOtherExtension = await fetch(`${server.origin}/v1/capabilities`, {
        headers: { origin: OTHER_EXTENSION_ORIGIN },
      });
      expect(deniedOtherExtension.status).toBe(403);
      expect(deniedOtherExtension.headers.get("access-control-allow-origin")).toBeNull();

      const capabilitiesWithoutToken = await fetch(`${server.origin}/v1/capabilities`, {
        headers: { origin: EXTENSION_ORIGIN },
      });
      expect(capabilitiesWithoutToken.status).toBe(401);
      expect(activityCount).toBe(0);

      const denied = await fetch(`${server.origin}/v1/pair`, {
        method: "POST",
        headers: { "content-type": "application/json", origin: "https://example.test" },
        body: JSON.stringify({
          schemaVersion: "0.1.0",
          kind: "ui-attach.local-bridge-pair",
          pairingCode: "482-193",
          installationId: INSTALLATION_ID,
        }),
      });
      expect(denied.status).toBe(403);
      expect(activityCount).toBe(0);

      const pairedResponse = await fetch(`${server.origin}/v1/pair`, {
        method: "POST",
        headers: { "content-type": "application/json", origin: EXTENSION_ORIGIN },
        body: JSON.stringify({
          schemaVersion: "0.1.0",
          kind: "ui-attach.local-bridge-pair",
          pairingCode: "482-193",
          installationId: INSTALLATION_ID,
        }),
      });
      expect(pairedResponse.status).toBe(200);
      expect(pairedResponse.headers.get("access-control-allow-origin")).toBe(EXTENSION_ORIGIN);
      const paired = await pairedResponse.json() as { token: string; instanceId: string };
      expect(activityCount).toBe(1);

      const capabilitiesWithWrongToken = await fetch(`${server.origin}/v1/capabilities`, {
        headers: { authorization: "Bearer wrong-token", origin: EXTENSION_ORIGIN },
      });
      expect(capabilitiesWithWrongToken.status).toBe(401);

      const deniedPageOriginCapabilities = await fetch(`${server.origin}/v1/capabilities`, {
        headers: {
          authorization: `Bearer ${paired.token}`,
          origin: "https://example.com",
        },
      });
      expect(deniedPageOriginCapabilities.status).toBe(403);

      const capabilitiesResponse = await fetch(`${server.origin}/v1/capabilities`, {
        headers: {
          authorization: `Bearer ${paired.token}`,
          origin: EXTENSION_ORIGIN,
        },
      });
      expect(capabilitiesResponse.status).toBe(200);
      expect(capabilitiesResponse.headers.get("access-control-allow-origin")).toBe(EXTENSION_ORIGIN);
      await expect(capabilitiesResponse.json()).resolves.toEqual({
        schemaVersion: "0.1.0",
        kind: "ui-attach.local-bridge-capabilities",
        snapshotObservations: "v1",
      });
      expect(activityCount).toBe(1);

      const tokenOnlyCapabilities = await fetch(`${server.origin}/v1/capabilities`, {
        headers: { authorization: `Bearer ${paired.token}` },
      });
      expect(tokenOnlyCapabilities.status).toBe(200);
      await expect(tokenOnlyCapabilities.json()).resolves.toMatchObject({
        kind: "ui-attach.local-bridge-capabilities",
        snapshotObservations: "v1",
      });
      expect(activityCount).toBe(1);

      const structuredCaptureCapabilities = await fetch(
        `${server.origin}/v1/capabilities/structured-capture`,
        {
          headers: {
            authorization: `Bearer ${paired.token}`,
            origin: EXTENSION_ORIGIN,
          },
        },
      );
      expect(structuredCaptureCapabilities.status).toBe(200);
      expect(structuredCaptureCapabilities.headers.get("access-control-allow-origin"))
        .toBe(EXTENSION_ORIGIN);
      await expect(structuredCaptureCapabilities.json()).resolves.toEqual({
        schemaVersion: "0.1.0",
        kind: "ui-attach.local-bridge-structured-capture-capabilities",
        structuredCapture: "v1",
      });
      expect(activityCount).toBe(1);

      const deniedPublish = await fetch(`${server.origin}/v1/snapshot`, {
        method: "PUT",
        headers: {
          authorization: "Bearer wrong-token",
          "content-type": "application/json",
          origin: EXTENSION_ORIGIN,
        },
        body: JSON.stringify(createSnapshot()),
      });
      expect(deniedPublish.status).toBe(401);
      expect(activityCount).toBe(1);

      const published = await fetch(`${server.origin}/v1/snapshot`, {
        method: "PUT",
        headers: {
          authorization: `Bearer ${paired.token}`,
          "content-type": "application/json",
          origin: EXTENSION_ORIGIN,
        },
        body: JSON.stringify(createSnapshot()),
      });
      expect(published.status).toBe(204);
      expect(activityCount).toBe(2);
      expect(state.readInstance(paired.instanceId)).toMatchObject({
        ok: true,
        value: { snapshot: { agentCopy: expect.stringContaining("Agent-safe") } },
      });

      const deniedPageOriginDisconnect = await fetch(`${server.origin}/v1/snapshot`, {
        method: "DELETE",
        headers: {
          authorization: `Bearer ${paired.token}`,
          origin: "https://example.com",
        },
      });
      expect(deniedPageOriginDisconnect.status).toBe(403);
      expect(state.readInstance(paired.instanceId).ok).toBe(true);

      const deniedTokenOnlyDisconnect = await fetch(`${server.origin}/v1/snapshot`, {
        method: "DELETE",
        headers: { authorization: "Bearer wrong-token" },
      });
      expect(deniedTokenOnlyDisconnect.status).toBe(401);
      expect(state.readInstance(paired.instanceId).ok).toBe(true);

      const disconnected = await fetch(`${server.origin}/v1/snapshot`, {
        method: "DELETE",
        headers: {
          authorization: `Bearer ${paired.token}`,
        },
      });
      expect(disconnected.status).toBe(204);
      expect(activityCount).toBe(3);
    } finally {
      await server.close();
    }
  });

  test("protects shared agent reads and keeps discovery summary-only", async () => {
    let activityCount = 0;
    const state = createTestState();
    const paired = state.pair(EXTENSION_ORIGIN, {
      schemaVersion: "0.1.0",
      kind: "ui-attach.local-bridge-pair",
      pairingCode: "482-193",
      installationId: INSTALLATION_ID,
    });
    expect(paired.ok).toBe(true);
    if (!paired.ok) return;
    expect(state.publish(EXTENSION_ORIGIN, paired.value.token, createSnapshot())).toMatchObject({ ok: true });
    const server = await startLocalBridgeHttpServer(state, {
      port: 0,
      agentToken: AGENT_TOKEN,
      ownerIdentity: OWNER_IDENTITY,
      onActivity: () => { activityCount += 1; },
    });
    try {
      const health = await fetch(`${server.origin}/health`);
      expect(await health.json()).toMatchObject({ sharing: "owner-proxy-v1" });

      const denied = await fetch(`${server.origin}/v1/agent/status`);
      expect(denied.status).toBe(401);
      expect(activityCount).toBe(0);

      const status = await agentFetch(server.origin, "/v1/agent/status");
      expect(status.status).toBe(200);
      expect(await status.text()).not.toContain("Agent-safe handoff");
      expect(activityCount).toBe(1);

      const list = await agentFetch(server.origin, "/v1/agent/instances");
      expect(list.status).toBe(200);
      expect(await list.text()).not.toContain("Agent-safe handoff");

      const exact = await agentFetch(
        server.origin,
        `/v1/agent/instances/${paired.value.instanceId}`,
      );
      expect(exact.status).toBe(200);
      expect(await exact.text()).toContain("Agent-safe handoff");
      expect(activityCount).toBe(3);
    } finally {
      await server.close();
    }
  });

  test("lets an authenticated agent approve a browser-created request without receiving its token", async () => {
    const state = createTestState();
    const request = createConnectionRequest();
    const server = await startLocalBridgeHttpServer(state, {
      port: 0,
      agentToken: AGENT_TOKEN,
      ownerIdentity: OWNER_IDENTITY,
    });
    try {
      const created = await fetch(`${server.origin}/v1/connection-requests`, {
        method: "POST",
        headers: { "content-type": "application/json", origin: EXTENSION_ORIGIN },
        body: JSON.stringify(request),
      });
      expect(created.status).toBe(201);
      expect(await created.json()).toMatchObject({
        kind: "ui-attach.local-bridge-connection-requested",
        data: { requestId: request.requestId, status: "pending" },
      });

      const sealedApprovalKey = sealLocalBridgeApprovalKey(AGENT_TOKEN, {
        requestId: request.requestId,
        approvalMode: request.approvalMode,
        approvalVerifier: request.approvalVerifier,
        expectedOwnerIdentity: OWNER_IDENTITY,
      }, APPROVAL_KEY, { randomBytes: (size) => Buffer.alloc(size, 14) });
      const approvalPath = `/v1/agent/connection-requests/${request.requestId}/${sealedApprovalKey}/approve`;
      const denied = await agentFetch(server.origin, approvalPath, "GET");
      expect(denied.status).toBe(404);

      const approved = await agentFetch(server.origin, approvalPath, "POST");
      expect(approved.status).toBe(200);
      const approvalText = await approved.text();
      expect(approvalText).toContain("ui-attach.local-bridge-connection-approved");
      expect(approvalText).not.toMatch(/token|requestSecret/);

      const originlessPoll = await fetch(
        `${server.origin}/v1/connection-requests/${request.requestId}`,
        { headers: { authorization: `Bearer ${request.requestSecret}` } },
      );
      expect(originlessPoll.status).toBe(403);

      const malformedClaim = await fetch(
        `${server.origin}/v1/connection-requests/${request.requestId}`,
        {
          method: "POST",
          headers: {
            authorization: `Bearer ${request.requestSecret}`,
            "content-type": "application/json",
            origin: EXTENSION_ORIGIN,
          },
          body: JSON.stringify({ extra: true }),
        },
      );
      expect(malformedClaim.status).toBe(400);

      const polled = await fetch(`${server.origin}/v1/connection-requests/${request.requestId}`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${request.requestSecret}`,
          "content-type": "application/json",
          origin: EXTENSION_ORIGIN,
        },
        body: "{}",
      });
      expect(polled.status).toBe(200);
      expect(await polled.json()).toMatchObject({
        kind: "ui-attach.local-bridge-connection-request",
        data: {
          requestId: request.requestId,
          status: "approved",
          token: expect.stringMatching(/^[A-Za-z0-9_-]{43}$/),
        },
      });
    } finally {
      await server.close();
    }
  });
});

function agentFetch(origin: string, path: string, method: "GET" | "POST" = "GET") {
  const auth = createLocalBridgeAgentRequestAuth(AGENT_TOKEN, path, { method });
  return fetch(`${origin}${path}`, {
    method,
    headers: auth.headers,
  });
}

function createTestState(overrides: Parameters<typeof createLocalBridgeState>[0] = {}) {
  const pairingCodes = [482_193, 482_194, 482_195];
  return createLocalBridgeState({
    now: () => new Date("2026-07-17T04:30:00.000Z"),
    randomInt: () => pairingCodes.shift() ?? 999_999,
    randomBytes: (size) => Buffer.alloc(size, 7),
    ...overrides,
  });
}

function createConnectionRequest(overrides: Record<string, unknown> = {}) {
  return {
    schemaVersion: "0.1.0",
    kind: "ui-attach.local-bridge-connection-request",
    requestId: "95e3e7b1-6f74-44ae-8954-e11f7f2a7c58",
    requestSecret: "CwsLCwsLCwsLCwsLCwsLCwsLCwsLCwsLCwsLCwsLCws",
    approvalVerifier: APPROVAL_VERIFIER,
    installationId: INSTALLATION_ID,
    browserSessionId: "32b8d92d-c76e-4c72-9f3c-5ba5bf31cd22",
    approvalMode: "ask",
    ...overrides,
  };
}
