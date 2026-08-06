import { createHmac } from "node:crypto";
import { createLocalBridgeApprovalProofMessage } from "@meanthis/schema";
import { describe, expect, test, vi } from "vitest";
import { createCaptureRecord, createSessionFile } from "../test/session-fixtures";
import {
  createLocalAgentBridgeClient,
  type LocalAgentBridgePublishInput,
} from "./local-agent-bridge";
import { buildPanelBridgeCapture } from "./panel-model";

const EXTENSION_ORIGIN = "chrome-extension://abcdefghijklmnopabcdefghijklmnop";
const INSTALLATION_ID = "5ea6b70f-48e8-4a7b-bc91-d943b0ef10f3";
const BROWSER_SESSION_ID = "32b8d92d-c76e-4c72-9f3c-5ba5bf31cd22";
const REQUEST_ID = "95e3e7b1-6f74-44ae-8954-e11f7f2a7c58";
const REQUEST_SECRET = "CwsLCwsLCwsLCwsLCwsLCwsLCwsLCwsLCwsLCwsLCws";
const APPROVAL_KEY = "DAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAw";
const APPROVAL_VERIFIER = "MIwc-JegXDWE1xhuMLuAumhs4XH1TLOAsg-rk3mfc0E";
const TRUST_KEY = "Dg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4";
const TOKEN = "BwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwc";

function createStructuredCapture() {
  const save = createCaptureRecord("save", "Save changes");
  const capture = buildPanelBridgeCapture({
    file: createSessionFile([save]),
    attachmentIds: ["att_save"],
    selectedItemId: "att_save",
    selectedRecord: save,
    viewMode: "agent_safe",
    intent: "Shorten the label.",
  }, "capture_time");
  if (!capture) throw new Error("Expected a structured capture fixture.");
  return capture;
}

describe("extension local agent bridge client", () => {
  test("is disconnected by default and does not touch loopback", async () => {
    const harness = createHarness();
    const client = createLocalAgentBridgeClient(harness.dependencies);

    await expect(client.readStatus()).resolves.toEqual({
      connected: false,
      instanceId: null,
      pending: false,
      approvalMode: null,
      requestText: null,
      expiresAt: null,
    });
    expect(harness.fetch).not.toHaveBeenCalled();
    expect(harness.requestPermission).not.toHaveBeenCalled();
  });

  test("scrubs legacy local credentials while preserving only the installation identity", async () => {
    const harness = createHarness({
      legacy: {
        installationId: INSTALLATION_ID,
        instanceId: "instance-0123456789ab",
        token: TOKEN,
        sequence: 3,
      },
    });
    const client = createLocalAgentBridgeClient(harness.dependencies);

    await expect(client.readStatus()).resolves.toMatchObject({ connected: false, pending: false });
    expect(harness.persistentValue).toEqual({ installationId: INSTALLATION_ID });
    expect(harness.legacyValue).toBeUndefined();
    expect(JSON.stringify(harness.persistentValue)).not.toMatch(/token|instance/i);
  });

  test("creates and copies only a safe browser-originated approval request", async () => {
    const harness = createHarness();
    harness.fetch.mockResolvedValueOnce(connectionResponse("pending", "ask", true));
    const client = createLocalAgentBridgeClient(harness.dependencies);

    const status = await client.createConnectionRequest("ask");

    expect(status).toMatchObject({
      connected: false,
      pending: true,
      approvalMode: "ask",
      expiresAt: "2026-07-17T04:32:00.000Z",
      requestText: expect.stringContaining(`Request ID: ${REQUEST_ID}`),
    });
    expect(status.requestText).toContain(`Approval key: ${APPROVAL_KEY}`);
    expect(status.requestText).not.toContain(REQUEST_SECRET);
    expect(status.requestText).not.toMatch(/token|https?:\/\//i);
    expect(harness.requestPermission).toHaveBeenCalledTimes(1);
    expect(harness.fetch).toHaveBeenCalledWith(
      "http://127.0.0.1:38471/v1/connection-requests",
      expect.objectContaining({ method: "POST" }),
    );
    const request = JSON.parse(String((harness.fetch.mock.calls[0][1] as RequestInit).body));
    expect(request).toEqual({
      schemaVersion: "0.1.0",
      kind: "ui-attach.local-bridge-connection-request",
      requestId: REQUEST_ID,
      requestSecret: REQUEST_SECRET,
      approvalVerifier: APPROVAL_VERIFIER,
      installationId: INSTALLATION_ID,
      browserSessionId: BROWSER_SESSION_ID,
      approvalMode: "ask",
    });
    expect(harness.persistentValue).toEqual({ installationId: INSTALLATION_ID });
    expect(harness.sessionValue).toMatchObject({
      browserSessionId: BROWSER_SESSION_ID,
      pending: {
        requestId: REQUEST_ID,
        requestSecret: REQUEST_SECRET,
        approvalKey: APPROVAL_KEY,
      },
    });
    expect(JSON.stringify(harness.persistentValue)).not.toMatch(/secret|token/i);
  });

  test("polls an approved request, then publishes and disconnects session credentials", async () => {
    const harness = createHarness({
      persistent: { installationId: INSTALLATION_ID },
      session: {
        browserSessionId: BROWSER_SESSION_ID,
        pending: pendingRequest(),
      },
      uuids: ["20a85d08-3aed-4c24-9006-221db95ab33c"],
    });
    harness.fetch
      .mockResolvedValueOnce(connectionResponse("approved"))
      .mockResolvedValueOnce(new Response(null, { status: 204 }))
      .mockResolvedValueOnce(new Response(null, { status: 204 }));
    const client = createLocalAgentBridgeClient(harness.dependencies);

    await expect(client.refreshConnection()).resolves.toMatchObject({
      connected: true,
      pending: false,
      instanceId: "instance-0123456789ab",
    });
    expect(harness.fetch.mock.calls[0]).toEqual([
      `http://127.0.0.1:38471/v1/connection-requests/${REQUEST_ID}`,
      expect.objectContaining({
        method: "POST",
        headers: {
          authorization: `Bearer ${REQUEST_SECRET}`,
          "content-type": "application/json",
        },
        body: "{}",
      }),
    ]);
    expect(harness.sessionValue).toEqual({
      browserSessionId: BROWSER_SESSION_ID,
      instanceId: "instance-0123456789ab",
      token: TOKEN,
      sequence: 0,
    });

    await expect(client.publish({
      page: {
        pageInstanceId: "chromium-tab:1199971128:frame:0",
        route: "https://aistudio.google.com/prompts/new_chat",
      },
      attachmentCount: 1,
      agentCopy: "# MeanThis Capture Bundle\n\nAgent-safe handoff.",
      activity: {
        operation: "saved_restore",
        state: "failed",
        stage: "background_response",
        code: "FRAME_PERMISSION_DENIED",
        observedAt: "2026-07-17T04:29:59.000Z",
      },
    })).resolves.toBe(true);
    expect(JSON.parse(String((harness.fetch.mock.calls[1][1] as RequestInit).body))).toMatchObject({
      kind: "ui-attach.local-bridge-snapshot",
      sequence: 1,
      publishedAt: "2026-07-17T04:30:00.000Z",
      activity: {
        operation: "saved_restore",
        state: "failed",
        stage: "background_response",
        code: "FRAME_PERMISSION_DENIED",
      },
    });

    await client.disconnect();
    expect(harness.fetch.mock.calls[2][1]).toMatchObject({ method: "DELETE" });
    expect(harness.sessionValue.browserSessionId).not.toBe(BROWSER_SESSION_ID);
    expect(Object.keys(harness.sessionValue)).toEqual(["browserSessionId"]);
    expect(harness.persistentValue).toEqual({ installationId: INSTALLATION_ID });
    expect(harness.removePermission).toHaveBeenCalledTimes(1);
  });

  test("keeps the latest Agent-safe snapshot while approval is pending and publishes it in background", async () => {
    const harness = createHarness({
      persistent: { installationId: INSTALLATION_ID },
      session: {
        browserSessionId: BROWSER_SESSION_ID,
        pending: pendingRequest(),
      },
    });
    harness.fetch
      .mockResolvedValueOnce(connectionResponse("approved"))
      .mockResolvedValueOnce(new Response(null, { status: 204 }));
    const client = createLocalAgentBridgeClient(harness.dependencies);
    const input = {
      page: {
        pageInstanceId: "chromium-tab:1199972156:frame:0",
        route: "https://aistudio.google.com/prompts/new_chat",
      },
      attachmentCount: 1,
      agentCopy: "# MeanThis Capture Bundle\n\nAgent-safe handoff.",
      observations: {
        observedAt: "2026-07-17T04:29:59.000Z",
        documentInstanceId: "document-01234567",
        targets: [{ attachmentId: "att_save", status: "restored" as const }],
      },
    };

    await expect(client.publish(input)).resolves.toBe(false);
    expect(harness.fetch).not.toHaveBeenCalled();
    expect(harness.sessionValue).toMatchObject({ latestSnapshot: input });

    await expect(client.refreshConnectionAndPublish()).resolves.toMatchObject({
      connected: true,
      instanceId: "instance-0123456789ab",
    });

    expect(harness.fetch).toHaveBeenCalledTimes(2);
    expect(JSON.parse(String((harness.fetch.mock.calls[1][1] as RequestInit).body))).toMatchObject({
      page: input.page,
      attachmentCount: 1,
      agentCopy: input.agentCopy,
      sequence: 1,
    });
    expect(JSON.parse(String((harness.fetch.mock.calls[1][1] as RequestInit).body)))
      .not.toHaveProperty("observations");
    expect(harness.sessionValue).toMatchObject({
      latestSnapshot: input,
      sequence: 1,
    });
  });

  test("publishes structured capture only after owner capability negotiation", async () => {
    const harness = createHarness({
      persistent: { installationId: INSTALLATION_ID },
      session: {
        browserSessionId: BROWSER_SESSION_ID,
        instanceId: "instance-0123456789ab",
        token: TOKEN,
        sequence: 3,
      },
    });
    harness.fetch
      .mockResolvedValueOnce(new Response(JSON.stringify({
        schemaVersion: "0.1.0",
        kind: "ui-attach.local-bridge-structured-capture-capabilities",
        structuredCapture: "v1",
      }), { status: 200, headers: { "content-type": "application/json" } }))
      .mockResolvedValueOnce(new Response(null, { status: 204 }));
    const client = createLocalAgentBridgeClient(harness.dependencies);
    const capture = createStructuredCapture();

    await expect(client.publish({
      page: { pageInstanceId: "chromium-tab:7:frame:0", route: "https://app.example.test/settings" },
      attachmentCount: 1,
      agentCopy: "Agent-safe handoff.",
      capture,
    })).resolves.toBe(true);

    expect(harness.fetch.mock.calls[0][0]).toBe(
      "http://127.0.0.1:38471/v1/capabilities/structured-capture",
    );

    expect(JSON.parse(String((harness.fetch.mock.calls[1][1] as RequestInit).body))).toMatchObject({
      sequence: 4,
      capture: {
        captureId: "session-1",
        disclosureMode: "agent_safe",
        targets: [{ attachmentId: "att_save", taskNote: "Shorten the label." }],
      },
    });
    expect(harness.sessionValue).toMatchObject({
      latestSnapshot: { capture },
      structuredCaptureCapability: "v1",
    });
  });

  test("downgrades cached live-page evidence before background republish", async () => {
    const capture = { ...createStructuredCapture(), authority: "live_page" as const };
    const cached: LocalAgentBridgePublishInput = {
      page: {
        pageInstanceId: "chromium-tab:7:frame:0",
        route: "https://app.example.test/settings",
      },
      attachmentCount: 1,
      agentCopy: "Agent-safe handoff.",
      capture,
      observations: {
        observedAt: "2026-07-17T04:29:59.000Z",
        documentInstanceId: "document-01234567",
        targets: [{ attachmentId: "att_save", status: "restored" }],
      },
      activity: {
        operation: "saved_restore",
        state: "succeeded",
        stage: "panel_reconciliation",
        code: null,
        observedAt: "2026-07-17T04:29:59.000Z",
      },
    };
    const harness = createHarness({
      persistent: { installationId: INSTALLATION_ID },
      session: {
        browserSessionId: BROWSER_SESSION_ID,
        instanceId: "instance-0123456789ab",
        token: TOKEN,
        sequence: 3,
        latestSnapshot: cached,
        snapshotObservationCapability: "v1",
        structuredCaptureCapability: "v1",
      },
    });
    harness.fetch.mockResolvedValueOnce(new Response(null, { status: 204 }));
    const client = createLocalAgentBridgeClient(harness.dependencies);

    await expect(client.refreshConnectionAndPublish()).resolves.toMatchObject({ connected: true });

    const published = JSON.parse(String((harness.fetch.mock.calls[0][1] as RequestInit).body));
    expect(published).toMatchObject({
      sequence: 4,
      capture: { captureId: "session-1", authority: "capture_time" },
    });
    expect(published).not.toHaveProperty("observations");
    expect(published).not.toHaveProperty("activity");
    expect(harness.sessionValue.latestSnapshot).toEqual(cached);
  });

  test("keeps base handoff compatible when an older owner has no observation capability", async () => {
    const harness = createHarness({
      persistent: { installationId: INSTALLATION_ID },
      session: {
        browserSessionId: BROWSER_SESSION_ID,
        instanceId: "instance-0123456789ab",
        token: TOKEN,
        sequence: 3,
      },
    });
    harness.fetch
      .mockResolvedValueOnce(new Response(null, { status: 404 }))
      .mockResolvedValueOnce(new Response(null, { status: 404 }))
      .mockResolvedValueOnce(new Response(null, { status: 204 }))
      .mockResolvedValueOnce(new Response(null, { status: 204 }));
    const client = createLocalAgentBridgeClient(harness.dependencies);
    const input = {
      page: {
        pageInstanceId: "chromium-tab:1199972156:frame:0",
        route: "https://aistudio.google.com/prompts/new_chat",
      },
      attachmentCount: 1,
      agentCopy: "# MeanThis Capture Bundle\n\nAgent-safe handoff.",
      capture: createStructuredCapture(),
      observations: {
        observedAt: "2026-07-17T04:29:59.000Z",
        documentInstanceId: "document-01234567",
        targets: [{ attachmentId: "att_save", status: "restored" as const }],
      },
    };

    await expect(client.publish(input)).resolves.toBe(true);
    await expect(client.publish(input)).resolves.toBe(true);

    expect(harness.fetch).toHaveBeenCalledTimes(4);
    expect(harness.fetch.mock.calls[0][0]).toBe("http://127.0.0.1:38471/v1/capabilities");
    expect(harness.fetch.mock.calls[1][0]).toBe(
      "http://127.0.0.1:38471/v1/capabilities/structured-capture",
    );
    const firstSnapshot = JSON.parse(String((harness.fetch.mock.calls[2][1] as RequestInit).body));
    const secondSnapshot = JSON.parse(String((harness.fetch.mock.calls[3][1] as RequestInit).body));
    expect(firstSnapshot).not.toHaveProperty("observations");
    expect(secondSnapshot).not.toHaveProperty("observations");
    expect(firstSnapshot).not.toHaveProperty("capture");
    expect(secondSnapshot).not.toHaveProperty("capture");
    expect(firstSnapshot).toMatchObject({ sequence: 4, agentCopy: input.agentCopy });
    expect(secondSnapshot).toMatchObject({ sequence: 5, agentCopy: input.agentCopy });
    expect(harness.sessionValue).toMatchObject({
      latestSnapshot: input,
      sequence: 5,
      snapshotObservationCapability: "none",
      structuredCaptureCapability: "none",
    });
  });

  test("publishes a bounded empty heartbeat when no panel snapshot was cached", async () => {
    const harness = createHarness({
      persistent: { installationId: INSTALLATION_ID },
      session: {
        browserSessionId: BROWSER_SESSION_ID,
        instanceId: "instance-0123456789ab",
        token: TOKEN,
        sequence: 3,
      },
    });
    harness.fetch.mockResolvedValueOnce(new Response(null, { status: 204 }));
    const client = createLocalAgentBridgeClient(harness.dependencies);

    await expect(client.refreshConnectionAndPublish()).resolves.toMatchObject({ connected: true });

    expect(JSON.parse(String((harness.fetch.mock.calls[0][1] as RequestInit).body))).toMatchObject({
      page: null,
      attachmentCount: 0,
      agentCopy: null,
      sequence: 4,
    });
    expect(harness.sessionValue).toEqual({
      browserSessionId: BROWSER_SESSION_ID,
      instanceId: "instance-0123456789ab",
      token: TOKEN,
      sequence: 4,
    });
  });

  test("fails closed on a malformed cached background snapshot", async () => {
    const harness = createHarness({
      persistent: { installationId: INSTALLATION_ID },
      session: {
        browserSessionId: BROWSER_SESSION_ID,
        pending: pendingRequest(),
        latestSnapshot: {
          page: null,
          attachmentCount: -1,
          agentCopy: "invalid",
        },
      },
    });
    const client = createLocalAgentBridgeClient(harness.dependencies);

    await expect(client.readStatus()).resolves.toMatchObject({
      connected: false,
      pending: false,
    });
    expect(harness.fetch).not.toHaveBeenCalled();
  });

  test("sends the explicit browser-session trust choice without making it persistent", async () => {
    const harness = createHarness();
    harness.fetch.mockResolvedValueOnce(connectionResponse("pending", "browser_session", true));
    const client = createLocalAgentBridgeClient(harness.dependencies);

    await client.createConnectionRequest("browser_session");

    const request = JSON.parse(String((harness.fetch.mock.calls[0][1] as RequestInit).body));
    expect(request.approvalMode).toBe("browser_session");
    expect(harness.persistentValue).toEqual({ installationId: INSTALLATION_ID });
    expect(harness.sessionValue).toMatchObject({
      browserSessionId: BROWSER_SESSION_ID,
      pending: { approvalMode: "browser_session" },
    });
  });

  test("finishes an owner-trusted browser-session request without asking for another copy", async () => {
    const harness = createHarness({
      persistent: { installationId: INSTALLATION_ID },
      session: { browserSessionId: BROWSER_SESSION_ID, trustKey: TRUST_KEY },
      uuids: [REQUEST_ID],
    });
    harness.fetch
      .mockResolvedValueOnce(connectionResponse("approved", "browser_session", true))
      .mockResolvedValueOnce(connectionResponse(
        "approved",
        "browser_session",
        false,
        TRUST_KEY,
      ));
    const client = createLocalAgentBridgeClient(harness.dependencies);

    await expect(client.createConnectionRequest("browser_session")).resolves.toMatchObject({
      connected: true,
      pending: false,
      instanceId: "instance-0123456789ab",
      requestText: null,
    });
    expect(harness.fetch).toHaveBeenCalledTimes(2);
    expect(harness.sessionValue).toEqual({
      browserSessionId: BROWSER_SESSION_ID,
      instanceId: "instance-0123456789ab",
      token: TOKEN,
      sequence: 0,
      trustKey: TRUST_KEY,
    });
  });

  test("rejects a shape-valid approval from a foreign loopback listener", async () => {
    const harness = createHarness({
      persistent: { installationId: INSTALLATION_ID },
      session: {
        browserSessionId: BROWSER_SESSION_ID,
        pending: pendingRequest(),
      },
    });
    harness.fetch.mockResolvedValueOnce(connectionResponse(
      "approved",
      "ask",
      false,
      "DQ0NDQ0NDQ0NDQ0NDQ0NDQ0NDQ0NDQ0NDQ0NDQ0NDQ0",
    ));
    const client = createLocalAgentBridgeClient(harness.dependencies);

    await expect(client.refreshConnection()).rejects.toThrow("approval proof");
    expect(harness.sessionValue).toMatchObject({
      browserSessionId: BROWSER_SESSION_ID,
      pending: { requestId: REQUEST_ID },
    });
    expect(JSON.stringify(harness.sessionValue)).not.toContain(TOKEN);
  });

  test("does not let another panel client resurrect disconnected credentials", async () => {
    const harness = createHarness({
      persistent: { installationId: INSTALLATION_ID },
      session: {
        browserSessionId: BROWSER_SESSION_ID,
        instanceId: "instance-0123456789ab",
        token: TOKEN,
        sequence: 3,
      },
    });
    let finishPublish!: (response: Response) => void;
    harness.fetch
      .mockImplementationOnce(() => new Promise<Response>((resolve) => {
        finishPublish = resolve;
      }))
      .mockResolvedValueOnce(new Response(null, { status: 204 }));
    const publisher = createLocalAgentBridgeClient(harness.dependencies);
    const disconnector = createLocalAgentBridgeClient(harness.dependencies);

    const publishing = publisher.publish({ page: null, attachmentCount: 0, agentCopy: null });
    await vi.waitFor(() => expect(harness.fetch).toHaveBeenCalledTimes(1));
    const disconnecting = disconnector.disconnect();
    finishPublish(new Response(null, { status: 204 }));
    await expect(publishing).resolves.toBe(true);
    await disconnecting;
    await expect(publisher.readStatus()).resolves.toMatchObject({ connected: false, pending: false });
    expect(harness.sessionValue.browserSessionId).not.toBe(BROWSER_SESSION_ID);
    expect(Object.keys(harness.sessionValue)).toEqual(["browserSessionId"]);
  });

  test("serializes approval refresh with another panel disconnect", async () => {
    const harness = createHarness({
      persistent: { installationId: INSTALLATION_ID },
      session: {
        browserSessionId: BROWSER_SESSION_ID,
        pending: pendingRequest(),
      },
      uuids: ["20a85d08-3aed-4c24-9006-221db95ab33c"],
    });
    let finishRefresh!: (response: Response) => void;
    harness.fetch
      .mockImplementationOnce(() => new Promise<Response>((resolve) => {
        finishRefresh = resolve;
      }))
      .mockResolvedValueOnce(new Response(null, { status: 204 }));
    const refresher = createLocalAgentBridgeClient(harness.dependencies);
    const disconnector = createLocalAgentBridgeClient(harness.dependencies);

    const refreshing = refresher.refreshConnection();
    await vi.waitFor(() => expect(harness.fetch).toHaveBeenCalledTimes(1));
    const disconnecting = disconnector.disconnect();
    await Promise.resolve();
    expect(harness.fetch).toHaveBeenCalledTimes(1);
    finishRefresh(connectionResponse("approved"));
    await expect(refreshing).resolves.toMatchObject({ connected: true });
    await disconnecting;

    await expect(refresher.readStatus()).resolves.toMatchObject({ connected: false, pending: false });
    expect(harness.fetch).toHaveBeenCalledTimes(2);
    expect(harness.sessionValue.browserSessionId).not.toBe(BROWSER_SESSION_ID);
    expect(Object.keys(harness.sessionValue)).toEqual(["browserSessionId"]);
  });
});

interface PersistentState {
  installationId?: string;
}

interface LegacyState extends PersistentState {
  instanceId?: string;
  token?: string;
  sequence?: number;
}

interface SessionState {
  browserSessionId?: string;
  trustKey?: string;
  instanceId?: string;
  token?: string;
  sequence?: number;
  pending?: ReturnType<typeof pendingRequest>;
  latestSnapshot?: LocalAgentBridgePublishInput;
  snapshotObservationCapability?: "v1" | "none";
  structuredCaptureCapability?: "v1" | "none";
}

function createHarness(initial: {
  persistent?: PersistentState;
  session?: SessionState;
  legacy?: LegacyState;
  uuids?: string[];
} = {}) {
  let persistentValue: PersistentState = structuredClone(initial.persistent ?? {});
  let sessionValue: SessionState = structuredClone(initial.session ?? {});
  let legacyValue: LegacyState | undefined = structuredClone(initial.legacy);
  const fetch = vi.fn<typeof globalThis.fetch>();
  const requestPermission = vi.fn(async () => true);
  const removePermission = vi.fn(async () => true);
  const uuids = [...(initial.uuids ?? [INSTALLATION_ID, BROWSER_SESSION_ID, REQUEST_ID])];
  let randomBytesCall = 0;
  let sessionLockTail: Promise<void> = Promise.resolve();
  function withSessionLock<T>(operation: () => Promise<T>): Promise<T> {
    const result = sessionLockTail.then(operation, operation);
    sessionLockTail = result.then(() => undefined, () => undefined);
    return result;
  }
  return {
    fetch,
    requestPermission,
    removePermission,
    get persistentValue() {
      return persistentValue;
    },
    get sessionValue() {
      return sessionValue;
    },
    get legacyValue() {
      return legacyValue;
    },
    dependencies: {
      extensionOrigin: EXTENSION_ORIGIN,
      persistentStorage: {
        async get() {
          return {
            "ui-attach.local-agent-bridge.installation.v1": structuredClone(persistentValue),
            "ui-attach.local-agent-bridge.v1": structuredClone(legacyValue),
          };
        },
        async set(items: Record<string, unknown>) {
          persistentValue = structuredClone(
            items["ui-attach.local-agent-bridge.installation.v1"] as PersistentState,
          );
        },
        async remove(keys: string | string[]) {
          const requested = Array.isArray(keys) ? keys : [keys];
          if (requested.includes("ui-attach.local-agent-bridge.installation.v1")) persistentValue = {};
          if (requested.includes("ui-attach.local-agent-bridge.v1")) legacyValue = undefined;
        },
      },
      sessionStorage: {
        async get() {
          return { "ui-attach.local-agent-bridge.session.v1": structuredClone(sessionValue) };
        },
        async set(items: Record<string, unknown>) {
          sessionValue = structuredClone(
            items["ui-attach.local-agent-bridge.session.v1"] as SessionState,
          );
        },
        async remove() {
          sessionValue = {};
        },
      },
      fetch,
      requestPermission,
      removePermission,
      randomUUID: () => uuids.shift() ?? REQUEST_ID,
      randomBytes: (size: number) => Buffer.alloc(size, randomBytesCall++ === 0 ? 11 : 12),
      now: () => new Date("2026-07-17T04:30:00.000Z"),
      withSessionLock,
    },
  };
}

function pendingRequest() {
  return {
    requestId: REQUEST_ID,
    requestSecret: REQUEST_SECRET,
    approvalKey: APPROVAL_KEY,
    approvalMode: "ask" as const,
    expiresAt: "2026-07-17T04:32:00.000Z",
    requestText: [
      "# MeanThis Connection Request",
      `Request ID: ${REQUEST_ID}`,
      `Approval key: ${APPROVAL_KEY}`,
    ].join("\n"),
  };
}

function connectionResponse(
  status: "pending" | "approved",
  approvalMode: "ask" | "browser_session" = "ask",
  requested = false,
  proofKey = APPROVAL_KEY,
): Response {
  const sessionTrustKey = approvalMode === "browser_session" ? TRUST_KEY : null;
  const approvalProof = createHmac("sha256", Buffer.from(proofKey, "base64url"))
    .update(createLocalBridgeApprovalProofMessage({
      requestId: REQUEST_ID,
      approvalMode,
      expiresAt: "2026-07-17T04:32:00.000Z",
      status: "approved",
      instanceId: "instance-0123456789ab",
      token: TOKEN,
      sessionTrustKey,
    }), "utf8")
    .digest("base64url");
  return new Response(JSON.stringify({
    schemaVersion: "0.1.0",
    kind: requested
      ? "ui-attach.local-bridge-connection-requested"
      : "ui-attach.local-bridge-connection-request",
    ok: true,
    data: {
      requestId: REQUEST_ID,
      approvalMode,
      expiresAt: "2026-07-17T04:32:00.000Z",
      status,
      ...(status === "approved" ? {
        instanceId: "instance-0123456789ab",
        ...(!requested ? {
          token: TOKEN,
          approvalProof,
          ...(sessionTrustKey ? { sessionTrustKey } : {}),
        } : {}),
      } : {}),
    },
  }), { status: requested ? 201 : 200, headers: { "content-type": "application/json" } });
}
