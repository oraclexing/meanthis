import { createHmac } from "node:crypto";
import {
  createLocalBridgeApprovalProofMessage,
  createLocalBridgeConnectionCode,
  UI_ATTACH_LOCAL_BRIDGE_READ_ACKNOWLEDGEMENT_LIMITATIONS,
} from "@meanthis/schema";
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
const CONNECTION_CODE = createLocalBridgeConnectionCode({
  requestId: REQUEST_ID,
  approvalMode: "ask",
  approvalKey: APPROVAL_KEY,
});
const APPROVAL_VERIFIER = "MIwc-JegXDWE1xhuMLuAumhs4XH1TLOAsg-rk3mfc0E";
const TRUST_KEY = "Dg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4";
const TOKEN = "BwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwc";
const V2_ANNOTATION_IDENTITY = {
  annotationId: "annotation:save-v2",
  annotationIdScope: "capture_session" as const,
  annotationCreatedAt: "2026-07-11T10:00:00.000Z",
  annotationUpdatedAt: "2026-07-11T10:00:00.000Z",
};

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

function createV2StructuredCapture() {
  const capture = createStructuredCapture();
  return {
    ...capture,
    targets: capture.targets.map((target) => ({
      ...target,
      ...V2_ANNOTATION_IDENTITY,
    })),
  };
}

function createV3StructuredCapture() {
  const capture = createV2StructuredCapture();
  return {
    ...capture,
    annotationLifecycleVersion: "v1" as const,
    updatedAt: "2026-07-11T10:02:00.000Z",
    targets: capture.targets.map((target) => ({
      ...target,
      annotationUpdatedAt: "2026-07-11T10:02:00.000Z",
      annotationLifecycle: {
        state: "resolved" as const,
        resolvedAt: "2026-07-11T10:01:00.000Z",
      },
    })),
  };
}

function createReplayDiagnosticsCapture() {
  const capture = createV3StructuredCapture();
  return {
    ...capture,
    metadataDiagnostics: {
      schemaVersion: "0.1.0" as const,
      kind: "ui-attach.metadata-only-diagnostics" as const,
      captureId: capture.captureId,
      scope: "capture" as const,
      observedAt: capture.updatedAt,
      consent: "explicit_capture" as const,
      authority: "capture_time" as const,
      replay: {
        status: "collected" as const,
        attemptCount: 1,
        verifiedCount: 1,
        ambiguousCount: 0,
        missingCount: 0,
      },
      device: { status: "not_requested" as const },
      network: { status: "not_requested" as const },
      console: { status: "not_requested" as const },
      executionAuthority: {
        grantedByCapture: false as const,
        browserControl: false as const,
        liveDomMutation: false as const,
      },
    },
  };
}

function readAnnotationIdentity(target: unknown) {
  const value = target as Record<string, unknown>;
  return {
    annotationId: value.annotationId,
    annotationIdScope: value.annotationIdScope,
    annotationCreatedAt: value.annotationCreatedAt,
    annotationUpdatedAt: value.annotationUpdatedAt,
  };
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
      sharedTargetCount: null,
      sharedSequence: null,
    });
    expect(harness.fetch).not.toHaveBeenCalled();
    expect(harness.requestPermission).not.toHaveBeenCalled();
  });

  test.each([
    ["waiting", 200, null],
    ["unavailable", 200, { malformed: true }],
    ["unavailable", 404, null],
  ] as const)("reads the ephemeral acknowledgement as %s", async (expected, responseStatus, body) => {
    const capture = createStructuredCapture();
    const publishedSnapshot: LocalAgentBridgePublishInput = {
      page: null,
      attachmentCount: capture.targets.length,
      agentCopy: "Agent-safe handoff.",
      capture,
    };
    const harness = createHarness({
      persistent: { installationId: INSTALLATION_ID },
      session: {
        browserSessionId: BROWSER_SESSION_ID,
        instanceId: "instance-0123456789ab",
        token: TOKEN,
        sequence: 4,
        latestSnapshot: publishedSnapshot,
        panelSnapshot: publishedSnapshot,
        activeSnapshotSource: "panel",
        publishedSnapshot,
      },
    });
    harness.fetch.mockResolvedValueOnce(new Response(JSON.stringify(body), {
      status: responseStatus,
      headers: { "content-type": "application/json" },
    }));
    const client = createLocalAgentBridgeClient(harness.dependencies);

    await expect(client.readStatus()).resolves.toMatchObject({
      connected: true,
      readAcknowledgementState: expected,
    });
    expect(harness.fetch).toHaveBeenCalledWith(
      "http://127.0.0.1:38471/v1/capture-read-acknowledgement",
      expect.objectContaining({ method: "GET" }),
    );
    expect(harness.sessionValue).not.toHaveProperty("readAcknowledgement");
  });

  test("only marks the exact current snapshot acknowledgement as current", async () => {
    const capture = createStructuredCapture();
    const publishedSnapshot: LocalAgentBridgePublishInput = {
      page: null,
      attachmentCount: capture.targets.length,
      agentCopy: "Agent-safe handoff.",
      capture,
    };
    const harness = createHarness({
      persistent: { installationId: INSTALLATION_ID },
      session: {
        browserSessionId: BROWSER_SESSION_ID,
        instanceId: "instance-0123456789ab",
        token: TOKEN,
        sequence: 4,
        latestSnapshot: publishedSnapshot,
        panelSnapshot: publishedSnapshot,
        activeSnapshotSource: "panel",
        publishedSnapshot,
      },
    });
    harness.fetch.mockResolvedValueOnce(new Response(JSON.stringify({
      schemaVersion: "0.1.0",
      kind: "ui-attach.local-bridge-read-acknowledgement",
      acknowledgementId: "c8e59b7e-5b59-47e7-9b80-4cf92fbcf89d",
      status: "acknowledged_by_agent_client",
      instanceId: "instance-0123456789ab",
      captureId: capture.captureId,
      snapshotSequence: 4,
      detail: "agent_context",
      acknowledgedAt: "2026-09-02T14:00:00.000Z",
      executionAuthority: {
        grantedByCapture: false,
        browserControl: false,
        liveDomMutation: false,
      },
      limitations: UI_ATTACH_LOCAL_BRIDGE_READ_ACKNOWLEDGEMENT_LIMITATIONS,
    }), { status: 200, headers: { "content-type": "application/json" } }));
    const client = createLocalAgentBridgeClient(harness.dependencies);

    await expect(client.readStatus()).resolves.toMatchObject({
      connected: true,
      readAcknowledgementState: "current",
    });

    const staleHarness = createHarness({
      persistent: { installationId: INSTALLATION_ID },
      session: {
        browserSessionId: BROWSER_SESSION_ID,
        instanceId: "instance-0123456789ab",
        token: TOKEN,
        sequence: 4,
        publishedSnapshot,
      },
    });
    staleHarness.fetch.mockResolvedValueOnce(new Response(JSON.stringify({
      schemaVersion: "0.1.0",
      kind: "ui-attach.local-bridge-read-acknowledgement",
      acknowledgementId: "c8e59b7e-5b59-47e7-9b80-4cf92fbcf89d",
      status: "acknowledged_by_agent_client",
      instanceId: "instance-0123456789ab",
      captureId: capture.captureId,
      snapshotSequence: 3,
      detail: "agent_context",
      acknowledgedAt: "2026-09-02T14:00:00.000Z",
      executionAuthority: {
        grantedByCapture: false,
        browserControl: false,
        liveDomMutation: false,
      },
      limitations: UI_ATTACH_LOCAL_BRIDGE_READ_ACKNOWLEDGEMENT_LIMITATIONS,
    }), { status: 200, headers: { "content-type": "application/json" } }));
    const staleClient = createLocalAgentBridgeClient(staleHarness.dependencies);

    await expect(staleClient.readStatus()).resolves.toMatchObject({
      connected: true,
      readAcknowledgementState: "waiting",
    });
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

  test("rejects a cached connection code that does not match its pending request", async () => {
    const mismatchedCode = createLocalBridgeConnectionCode({
      requestId: "20a85d08-3aed-4c24-9006-221db95ab33c",
      approvalMode: "ask",
      approvalKey: APPROVAL_KEY,
    });
    const harness = createHarness({
      session: {
        browserSessionId: BROWSER_SESSION_ID,
        pending: {
          ...pendingRequest(),
          requestText: `meanthis bridge accept ${mismatchedCode} --json`,
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

  test("creates only a safe browser-originated connection invitation", async () => {
    const harness = createHarness();
    harness.fetch.mockResolvedValueOnce(connectionResponse("pending", "ask", true));
    const client = createLocalAgentBridgeClient(harness.dependencies);

    const status = await client.createConnectionRequest("ask");

    expect(status).toMatchObject({
      connected: false,
      pending: true,
      approvalMode: "ask",
      expiresAt: "2026-07-17T04:32:00.000Z",
      requestText: `meanthis bridge accept ${CONNECTION_CODE} --json`,
    });
    expect(status.requestText).not.toContain(REQUEST_ID);
    expect(status.requestText).not.toContain(APPROVAL_KEY);
    expect(status.requestText?.split(/\r?\n/u)).toHaveLength(1);
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

  test("replaces an expired cached invitation instead of returning it again", async () => {
    const expiredRequestId = "20a85d08-3aed-4c24-9006-221db95ab33c";
    const expiredCode = createLocalBridgeConnectionCode({
      requestId: expiredRequestId,
      approvalMode: "browser_session",
      approvalKey: TRUST_KEY,
    });
    const nextCode = createLocalBridgeConnectionCode({
      requestId: REQUEST_ID,
      approvalMode: "browser_session",
      approvalKey: APPROVAL_KEY,
    });
    const latestSnapshot: LocalAgentBridgePublishInput = {
      page: null,
      attachmentCount: 1,
      agentCopy: "Agent-safe handoff.",
    };
    const harness = createHarness({
      persistent: { installationId: INSTALLATION_ID },
      session: {
        browserSessionId: BROWSER_SESSION_ID,
        trustKey: TRUST_KEY,
        clearPending: true,
        latestSnapshot,
        pending: {
          ...pendingRequest(),
          requestId: expiredRequestId,
          approvalKey: TRUST_KEY,
          approvalMode: "browser_session",
          expiresAt: "2026-07-17T04:30:00.000Z",
          requestText: `meanthis bridge accept ${expiredCode} --json`,
        },
      },
      uuids: [REQUEST_ID],
    });
    harness.fetch.mockResolvedValueOnce(connectionResponse("pending", "browser_session", true));
    const client = createLocalAgentBridgeClient(harness.dependencies);

    await expect(client.createConnectionRequest("browser_session")).resolves.toMatchObject({
      pending: true,
      requestText: `meanthis bridge accept ${nextCode} --json`,
      expiresAt: "2026-07-17T04:32:00.000Z",
    });
    expect(harness.fetch).toHaveBeenCalledTimes(1);
    expect(harness.fetch).toHaveBeenCalledWith(
      "http://127.0.0.1:38471/v1/connection-requests",
      expect.objectContaining({ method: "POST" }),
    );
    expect(harness.sessionValue).toMatchObject({
      browserSessionId: BROWSER_SESSION_ID,
      trustKey: TRUST_KEY,
      clearPending: true,
      latestSnapshot,
      pending: {
        requestId: REQUEST_ID,
        approvalMode: "browser_session",
        expiresAt: "2026-07-17T04:32:00.000Z",
      },
    });
  });

  test.each([
    ["ask", "browser_session"],
    ["browser_session", "ask"],
  ] as const)(
    "rejects unexpired %s invitation reuse when %s authority was requested",
    async (pendingMode, requestedMode) => {
      const pendingCode = createLocalBridgeConnectionCode({
        requestId: REQUEST_ID,
        approvalMode: pendingMode,
        approvalKey: APPROVAL_KEY,
      });
      const harness = createHarness({
        persistent: { installationId: INSTALLATION_ID },
        session: {
          browserSessionId: BROWSER_SESSION_ID,
          pending: {
            ...pendingRequest(),
            approvalMode: pendingMode,
            requestText: `meanthis bridge accept ${pendingCode} --json`,
          },
        },
      });
      const client = createLocalAgentBridgeClient(harness.dependencies);

      await expect(client.createConnectionRequest(requestedMode)).rejects.toThrow(
        "A connection invitation with a different approval mode is already pending.",
      );
      expect(harness.fetch).not.toHaveBeenCalled();
      expect(harness.sessionValue.pending?.approvalMode).toBe(pendingMode);
      expect(harness.sessionValue.pending?.requestText)
        .toBe(`meanthis bridge accept ${pendingCode} --json`);
    },
  );

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

    await expect(client.refreshConnectionAndHeartbeat()).resolves.toMatchObject({
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
    await expect(client.readStatus()).resolves.toMatchObject({
      connected: true,
      sharedTargetCount: 1,
      sharedSequence: 1,
    });
  });

  test("merges a background session projection without dropping panel observations or activity", async () => {
    const capture = createStructuredCapture();
    const page = {
      pageInstanceId: "chromium-tab:7:frame:0",
      route: "https://app.example.test/settings",
    };
    const panelSnapshot: LocalAgentBridgePublishInput = {
      page,
      attachmentCount: capture.targets.length,
      agentCopy: "Agent-safe handoff.",
      capture,
      observations: {
        observedAt: "2026-07-17T04:29:59.000Z",
        documentInstanceId: "document-01234567",
        targets: capture.targets.map((target) => ({
          attachmentId: target.attachmentId,
          status: "restored" as const,
        })),
      },
      activity: {
        operation: "saved_restore",
        state: "succeeded",
        stage: "panel_reconciliation",
        code: null,
        observedAt: "2026-07-17T04:29:59.000Z",
      },
    };
    const sessionProjection: LocalAgentBridgePublishInput = {
      page,
      attachmentCount: capture.targets.length,
      agentCopy: "Updated Agent-safe handoff.",
      capture,
    };
    const harness = createHarness({
      persistent: { installationId: INSTALLATION_ID },
      session: {
        browserSessionId: BROWSER_SESSION_ID,
        instanceId: "instance-0123456789ab",
        token: TOKEN,
        sequence: 3,
        latestSnapshot: panelSnapshot,
        publishedSnapshot: panelSnapshot,
        snapshotObservationCapability: "v1",
        structuredCaptureCapability: "v1",
      },
    });
    harness.fetch.mockResolvedValueOnce(new Response(null, { status: 204 }));
    const client = createLocalAgentBridgeClient(harness.dependencies);

    await expect(client.publishSessionContext(sessionProjection)).resolves.toBe(true);

    const body = JSON.parse(String((harness.fetch.mock.calls[0]![1] as RequestInit).body));
    expect(body).toMatchObject({
      sequence: 4,
      agentCopy: "Updated Agent-safe handoff.",
      observations: panelSnapshot.observations,
      activity: panelSnapshot.activity,
    });
    expect(harness.sessionValue.latestSnapshot).toMatchObject({
      observations: panelSnapshot.observations,
      activity: panelSnapshot.activity,
    });
    expect(harness.sessionValue).toMatchObject({
      panelSnapshot,
      sessionSnapshot: sessionProjection,
      activeSnapshotSource: "session",
    });
  });

  test("does not let a stale panel snapshot erase newer session task notes", async () => {
    const save = createCaptureRecord("save", "Save changes");
    const cancel = createCaptureRecord("cancel", "Cancel review");
    save.intent = "Keep the current default selection.";
    cancel.intent = "Keep cancel review secondary.";
    const file = createSessionFile([save, cancel]);
    const sessionCapture = buildPanelBridgeCapture({
      file,
      attachmentIds: ["att_save", "att_cancel"],
      selectedItemId: "att_save",
      selectedRecord: save,
      viewMode: "agent_safe",
      intent: save.intent,
    }, "capture_time");
    if (!sessionCapture) throw new Error("Expected a structured capture fixture.");
    const page = {
      pageInstanceId: "chromium-tab:7:frame:0",
      route: "https://app.example.test/settings",
    };
    const sessionProjection: LocalAgentBridgePublishInput = {
      page,
      attachmentCount: sessionCapture.targets.length,
      agentCopy: "Updated Agent-safe handoff.",
      capture: sessionCapture,
    };
    const stalePanelCapture = {
      ...sessionCapture,
      targets: sessionCapture.targets.map((target) => ({
        ...target,
        taskNote: "",
      })),
    };
    const stalePanelProjection: LocalAgentBridgePublishInput = {
      page,
      attachmentCount: stalePanelCapture.targets.length,
      agentCopy: "Stale panel handoff.",
      capture: stalePanelCapture,
      observations: {
        observedAt: "2026-07-17T04:29:59.000Z",
        documentInstanceId: "document-01234567",
        targets: stalePanelCapture.targets.map((target) => ({
          attachmentId: target.attachmentId,
          status: "restored" as const,
        })),
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
        snapshotObservationCapability: "v1",
        structuredCaptureCapability: "v1",
      },
    });
    harness.fetch
      .mockResolvedValueOnce(new Response(null, { status: 204 }))
      .mockResolvedValueOnce(new Response(null, { status: 204 }));
    const client = createLocalAgentBridgeClient(harness.dependencies);

    await expect(client.publishSessionContext(sessionProjection)).resolves.toBe(true);
    await expect(client.publish(stalePanelProjection)).resolves.toBe(true);

    expect(harness.fetch).toHaveBeenCalledTimes(2);
    const published = JSON.parse(String((harness.fetch.mock.calls[1]![1] as RequestInit).body));
    expect(published.capture.targets.map((target: { taskNote: string }) => target.taskNote))
      .toEqual([
        "Keep the current default selection.",
        "Keep cancel review secondary.",
      ]);
    expect(published.agentCopy).toBe("Updated Agent-safe handoff.");
    expect(published.capture).toEqual(sessionCapture);
    expect(published).toMatchObject({
      observations: stalePanelProjection.observations,
      activity: stalePanelProjection.activity,
    });
    for (const snapshot of [
      harness.sessionValue.latestSnapshot,
      harness.sessionValue.panelSnapshot,
      harness.sessionValue.publishedSnapshot,
    ]) {
      expect(snapshot?.agentCopy).toBe("Updated Agent-safe handoff.");
      expect(snapshot?.capture).toEqual(sessionCapture);
    }
  });

  test.each(["page", "capture", "target"] as const)(
    "does not carry session task notes across a different %s identity",
    async (differentIdentity) => {
      const sessionCapture = createStructuredCapture();
      const page = {
        pageInstanceId: "chromium-tab:7:frame:0",
        route: "https://app.example.test/settings",
      };
      const sessionProjection: LocalAgentBridgePublishInput = {
        page,
        attachmentCount: sessionCapture.targets.length,
        agentCopy: "Current session handoff.",
        capture: sessionCapture,
      };
      const staleCapture = {
        ...sessionCapture,
        ...(differentIdentity === "capture" ? { captureId: "session-other" } : {}),
        targets: sessionCapture.targets.map((target) => ({
          ...target,
          ...(differentIdentity === "target" ? { targetId: "target_Z" } : {}),
          taskNote: "",
        })),
      };
      const stalePanelProjection: LocalAgentBridgePublishInput = {
        page: differentIdentity === "page"
          ? { ...page, route: "https://app.example.test/billing" }
          : page,
        attachmentCount: staleCapture.targets.length,
        agentCopy: "Stale panel handoff.",
        capture: staleCapture,
      };
      const harness = createHarness({
        persistent: { installationId: INSTALLATION_ID },
        session: {
          browserSessionId: BROWSER_SESSION_ID,
          instanceId: "instance-0123456789ab",
          token: TOKEN,
          sequence: 3,
          latestSnapshot: sessionProjection,
          sessionSnapshot: sessionProjection,
          activeSnapshotSource: "session",
          publishedSnapshot: sessionProjection,
          structuredCaptureCapability: "v1",
        },
      });
      harness.fetch.mockResolvedValueOnce(new Response(null, { status: 204 }));
      const client = createLocalAgentBridgeClient(harness.dependencies);

      await expect(client.publish(stalePanelProjection)).resolves.toBe(true);

      const published = JSON.parse(String((harness.fetch.mock.calls[0]![1] as RequestInit).body));
      expect(published.agentCopy).toBe("Stale panel handoff.");
      expect(published.capture.targets[0].taskNote).toBe("");
      expect(harness.sessionValue.publishedSnapshot?.agentCopy).toBe("Stale panel handoff.");
      expect(harness.sessionValue.publishedSnapshot?.capture?.targets[0]?.taskNote).toBe("");
    },
  );

  test("does not clear a panel snapshot when the session writer has never published", async () => {
    const panelSnapshot = {
      page: null,
      attachmentCount: 1,
      agentCopy: "Panel-owned handoff.",
    };
    const harness = createHarness({
      persistent: { installationId: INSTALLATION_ID },
      session: {
        browserSessionId: BROWSER_SESSION_ID,
        instanceId: "instance-0123456789ab",
        token: TOKEN,
        sequence: 3,
        latestSnapshot: panelSnapshot,
        panelSnapshot,
        activeSnapshotSource: "panel",
        publishedSnapshot: panelSnapshot,
      },
    });
    const client = createLocalAgentBridgeClient(harness.dependencies);

    await expect(client.clearSessionContext()).resolves.toBe(true);

    expect(harness.fetch).not.toHaveBeenCalled();
    expect(harness.sessionValue).toMatchObject({
      latestSnapshot: panelSnapshot,
      panelSnapshot,
      activeSnapshotSource: "panel",
      publishedSnapshot: panelSnapshot,
    });
  });

  test("does not clear a newer panel snapshot when removing a stale session channel", async () => {
    const sessionSnapshot = {
      page: null,
      attachmentCount: 1,
      agentCopy: "Earlier session handoff.",
    };
    const panelSnapshot = {
      page: null,
      attachmentCount: 2,
      agentCopy: "Newer panel handoff.",
    };
    const harness = createHarness({
      persistent: { installationId: INSTALLATION_ID },
      session: {
        browserSessionId: BROWSER_SESSION_ID,
        instanceId: "instance-0123456789ab",
        token: TOKEN,
        sequence: 2,
      },
    });
    harness.fetch
      .mockResolvedValueOnce(new Response(null, { status: 204 }))
      .mockResolvedValueOnce(new Response(null, { status: 204 }));
    const client = createLocalAgentBridgeClient(harness.dependencies);

    await expect(client.publishSessionContext(sessionSnapshot)).resolves.toBe(true);
    await expect(client.publish(panelSnapshot)).resolves.toBe(true);
    await expect(client.clearSessionContext()).resolves.toBe(true);

    expect(harness.fetch).toHaveBeenCalledTimes(2);
    expect(harness.fetch.mock.calls.every(([, init]) => init?.method === "PUT")).toBe(true);
    expect(harness.sessionValue).not.toHaveProperty("sessionSnapshot");
    expect(harness.sessionValue).toMatchObject({
      latestSnapshot: panelSnapshot,
      panelSnapshot,
      activeSnapshotSource: "panel",
      publishedSnapshot: panelSnapshot,
    });
  });

  test("falls back to and republishes the panel snapshot when clearing active session context", async () => {
    const panelSnapshot = {
      page: null,
      attachmentCount: 1,
      agentCopy: "Panel fallback handoff.",
    };
    const sessionSnapshot = {
      page: null,
      attachmentCount: 2,
      agentCopy: "Active session handoff.",
    };
    const harness = createHarness({
      persistent: { installationId: INSTALLATION_ID },
      session: {
        browserSessionId: BROWSER_SESSION_ID,
        instanceId: "instance-0123456789ab",
        token: TOKEN,
        sequence: 4,
        latestSnapshot: sessionSnapshot,
        panelSnapshot,
        sessionSnapshot,
        activeSnapshotSource: "session",
        publishedSnapshot: sessionSnapshot,
      },
    });
    harness.fetch.mockResolvedValueOnce(new Response(null, { status: 204 }));
    const client = createLocalAgentBridgeClient(harness.dependencies);

    await expect(client.clearSessionContext()).resolves.toBe(true);

    expect(harness.fetch).toHaveBeenCalledWith(
      "http://127.0.0.1:38471/v1/snapshot",
      expect.objectContaining({ method: "PUT" }),
    );
    expect(JSON.parse(String((harness.fetch.mock.calls[0]![1] as RequestInit).body)))
      .toMatchObject({ sequence: 5, ...panelSnapshot });
    expect(harness.sessionValue).not.toHaveProperty("sessionSnapshot");
    expect(harness.sessionValue).toMatchObject({
      sequence: 5,
      latestSnapshot: panelSnapshot,
      panelSnapshot,
      activeSnapshotSource: "panel",
      publishedSnapshot: panelSnapshot,
    });
  });

  test("persists and completes a durable clear when session context is the only channel", async () => {
    const sessionSnapshot = {
      page: null,
      attachmentCount: 1,
      agentCopy: "Session-only handoff.",
    };
    const harness = createHarness({
      persistent: { installationId: INSTALLATION_ID },
      session: {
        browserSessionId: BROWSER_SESSION_ID,
        instanceId: "instance-0123456789ab",
        token: TOKEN,
        sequence: 4,
        latestSnapshot: sessionSnapshot,
        sessionSnapshot,
        activeSnapshotSource: "session",
        publishedSnapshot: sessionSnapshot,
      },
    });
    harness.fetch.mockResolvedValueOnce(new Response(null, { status: 204 }));
    const client = createLocalAgentBridgeClient(harness.dependencies);

    await expect(client.clearSessionContext()).resolves.toBe(true);

    expect(harness.fetch).toHaveBeenCalledWith(
      "http://127.0.0.1:38471/v1/shared-capture",
      expect.objectContaining({ method: "DELETE" }),
    );
    expect(harness.sessionValue).toEqual({
      browserSessionId: BROWSER_SESSION_ID,
      instanceId: "instance-0123456789ab",
      token: TOKEN,
      sequence: 4,
    });
  });

  test("parses legacy latest-only restart state fail-safe and rejects incomplete channel state", async () => {
    const legacySnapshot = {
      page: null,
      attachmentCount: 1,
      agentCopy: "Legacy panel-or-unknown handoff.",
    };
    const compatibleHarness = createHarness({
      persistent: { installationId: INSTALLATION_ID },
      session: {
        browserSessionId: BROWSER_SESSION_ID,
        instanceId: "instance-0123456789ab",
        token: TOKEN,
        sequence: 3,
        latestSnapshot: legacySnapshot,
        publishedSnapshot: legacySnapshot,
      },
    });
    const compatibleClient = createLocalAgentBridgeClient(compatibleHarness.dependencies);

    await expect(compatibleClient.clearSessionContext()).resolves.toBe(true);
    expect(compatibleHarness.fetch).not.toHaveBeenCalled();
    expect(compatibleHarness.sessionValue).toMatchObject({
      latestSnapshot: legacySnapshot,
      panelSnapshot: legacySnapshot,
      activeSnapshotSource: "unknown",
    });

    const invalidHarness = createHarness({
      persistent: { installationId: INSTALLATION_ID },
      session: {
        browserSessionId: BROWSER_SESSION_ID,
        instanceId: "instance-0123456789ab",
        token: TOKEN,
        sequence: 3,
        latestSnapshot: legacySnapshot,
        activeSnapshotSource: "session",
        publishedSnapshot: legacySnapshot,
      },
    });
    const invalidClient = createLocalAgentBridgeClient(invalidHarness.dependencies);

    await expect(invalidClient.readStatus()).resolves.toMatchObject({
      connected: false,
      pending: false,
    });
  });

  test("withdraws panel observations and error activity when falling back to session context", async () => {
    const capture = createStructuredCapture();
    const page = {
      pageInstanceId: "chromium-tab:7:frame:0",
      route: "https://app.example.test/settings",
    };
    const sessionSnapshot = {
      page,
      attachmentCount: capture.targets.length,
      agentCopy: "Session-owned handoff.",
      capture,
    };
    const panelSnapshot: LocalAgentBridgePublishInput = {
      ...sessionSnapshot,
      observations: {
        observedAt: "2026-07-17T04:29:59.000Z",
        documentInstanceId: "document-01234567",
        targets: [{ attachmentId: "att_save", status: "restored" }],
      },
      activity: {
        operation: "saved_restore",
        state: "failed",
        stage: "background_response",
        code: "FRAME_PERMISSION_DENIED",
        observedAt: "2026-07-17T04:29:59.000Z",
      },
    };
    const harness = createHarness({
      persistent: { installationId: INSTALLATION_ID },
      session: {
        browserSessionId: BROWSER_SESSION_ID,
        instanceId: "instance-0123456789ab",
        token: TOKEN,
        sequence: 4,
        latestSnapshot: panelSnapshot,
        panelSnapshot,
        sessionSnapshot,
        activeSnapshotSource: "panel",
        publishedSnapshot: panelSnapshot,
        snapshotObservationCapability: "v1",
        structuredCaptureCapability: "v1",
      },
    });
    harness.fetch
      .mockResolvedValueOnce(new Response("null", { status: 200 }))
      .mockResolvedValueOnce(new Response(null, { status: 204 }));
    const client = createLocalAgentBridgeClient(harness.dependencies);

    await expect(client.readStatus()).resolves.toMatchObject({ connected: true });
    await expect(client.clearPanelContext()).resolves.toBe(true);

    const published = JSON.parse(String((harness.fetch.mock.calls[1]![1] as RequestInit).body));
    expect(published).toMatchObject({ sequence: 5, ...sessionSnapshot });
    expect(published).not.toHaveProperty("observations");
    expect(published).not.toHaveProperty("activity");
    expect(harness.sessionValue).not.toHaveProperty("panelSnapshot");
    expect(harness.sessionValue).toMatchObject({
      latestSnapshot: sessionSnapshot,
      sessionSnapshot,
      activeSnapshotSource: "session",
      publishedSnapshot: sessionSnapshot,
    });
  });

  test("republishes the session snapshot when the active panel channel is cleared", async () => {
    const sessionSnapshot = {
      page: null,
      attachmentCount: 1,
      agentCopy: "Session fallback handoff.",
    };
    const panelSnapshot = {
      page: null,
      attachmentCount: 2,
      agentCopy: "Newer panel handoff.",
    };
    const harness = createHarness({
      persistent: { installationId: INSTALLATION_ID },
      session: {
        browserSessionId: BROWSER_SESSION_ID,
        instanceId: "instance-0123456789ab",
        token: TOKEN,
        sequence: 2,
      },
    });
    harness.fetch
      .mockResolvedValueOnce(new Response(null, { status: 204 }))
      .mockResolvedValueOnce(new Response(null, { status: 204 }))
      .mockResolvedValueOnce(new Response(null, { status: 204 }));
    const client = createLocalAgentBridgeClient(harness.dependencies);

    await expect(client.publishSessionContext(sessionSnapshot)).resolves.toBe(true);
    await expect(client.publish(panelSnapshot)).resolves.toBe(true);
    await expect(client.clearPanelContext()).resolves.toBe(true);

    expect(harness.fetch).toHaveBeenCalledTimes(3);
    const fallback = JSON.parse(String((harness.fetch.mock.calls[2]![1] as RequestInit).body));
    expect(fallback).toMatchObject({ sequence: 5, ...sessionSnapshot });
    expect(harness.sessionValue).not.toHaveProperty("panelSnapshot");
    expect(harness.sessionValue).toMatchObject({
      latestSnapshot: sessionSnapshot,
      sessionSnapshot,
      activeSnapshotSource: "session",
    });
  });

  test("persists and completes a durable clear when panel context is the only channel", async () => {
    const panelSnapshot = {
      page: null,
      attachmentCount: 1,
      agentCopy: "Panel-only handoff.",
    };
    const harness = createHarness({
      persistent: { installationId: INSTALLATION_ID },
      session: {
        browserSessionId: BROWSER_SESSION_ID,
        instanceId: "instance-0123456789ab",
        token: TOKEN,
        sequence: 4,
        latestSnapshot: panelSnapshot,
        panelSnapshot,
        activeSnapshotSource: "panel",
        publishedSnapshot: panelSnapshot,
      },
    });
    harness.fetch.mockResolvedValueOnce(new Response(null, { status: 204 }));
    const client = createLocalAgentBridgeClient(harness.dependencies);

    await expect(client.clearPanelContext()).resolves.toBe(true);

    expect(harness.fetch).toHaveBeenCalledWith(
      "http://127.0.0.1:38471/v1/shared-capture",
      expect.objectContaining({ method: "DELETE" }),
    );
    expect(harness.sessionValue).toEqual({
      browserSessionId: BROWSER_SESSION_ID,
      instanceId: "instance-0123456789ab",
      token: TOKEN,
      sequence: 4,
    });
  });

  test("removes a stale panel channel without touching active session context", async () => {
    const panelSnapshot = {
      page: null,
      attachmentCount: 2,
      agentCopy: "Earlier panel handoff.",
    };
    const sessionSnapshot = {
      page: null,
      attachmentCount: 1,
      agentCopy: "Active session handoff.",
    };
    const harness = createHarness({
      persistent: { installationId: INSTALLATION_ID },
      session: {
        browserSessionId: BROWSER_SESSION_ID,
        instanceId: "instance-0123456789ab",
        token: TOKEN,
        sequence: 4,
        latestSnapshot: sessionSnapshot,
        panelSnapshot,
        sessionSnapshot,
        activeSnapshotSource: "session",
        publishedSnapshot: sessionSnapshot,
      },
    });
    const client = createLocalAgentBridgeClient(harness.dependencies);

    await expect(client.clearPanelContext()).resolves.toBe(true);

    expect(harness.fetch).not.toHaveBeenCalled();
    expect(harness.sessionValue).not.toHaveProperty("panelSnapshot");
    expect(harness.sessionValue).toMatchObject({
      latestSnapshot: sessionSnapshot,
      sessionSnapshot,
      activeSnapshotSource: "session",
      publishedSnapshot: sessionSnapshot,
    });
  });

  test("lets the panel withdraw a legacy unknown-source snapshot fail-safe", async () => {
    const legacySnapshot = {
      page: null,
      attachmentCount: 1,
      agentCopy: "Legacy panel-or-unknown handoff.",
    };
    const harness = createHarness({
      persistent: { installationId: INSTALLATION_ID },
      session: {
        browserSessionId: BROWSER_SESSION_ID,
        instanceId: "instance-0123456789ab",
        token: TOKEN,
        sequence: 4,
        latestSnapshot: legacySnapshot,
        publishedSnapshot: legacySnapshot,
      },
    });
    harness.fetch.mockResolvedValueOnce(new Response(null, { status: 204 }));
    const client = createLocalAgentBridgeClient(harness.dependencies);

    await expect(client.clearPanelContext()).resolves.toBe(true);

    expect(harness.fetch).toHaveBeenCalledWith(
      "http://127.0.0.1:38471/v1/shared-capture",
      expect.objectContaining({ method: "DELETE" }),
    );
    expect(harness.sessionValue).not.toHaveProperty("latestSnapshot");
    expect(harness.sessionValue).not.toHaveProperty("panelSnapshot");
    expect(harness.sessionValue).not.toHaveProperty("sessionSnapshot");
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

  test("sends V3 captures only after exact v2 negotiation and retains the raw snapshot while incomplete", async () => {
    const capture = createV3StructuredCapture();
    const input: LocalAgentBridgePublishInput = {
      page: { pageInstanceId: "chromium-tab:7:frame:0", route: "https://app.example.test/settings" },
      attachmentCount: 1,
      agentCopy: "Agent-safe handoff.",
      capture,
    };
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
      .mockResolvedValueOnce(new Response(null, { status: 204 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        schemaVersion: "0.1.0",
        kind: "ui-attach.local-bridge-structured-capture-capabilities",
        structuredCapture: "v2",
      }), { status: 200, headers: { "content-type": "application/json" } }))
      .mockResolvedValueOnce(new Response(null, { status: 204 }));
    const client = createLocalAgentBridgeClient(harness.dependencies);

    await expect(client.publish(input)).resolves.toBe(false);
    const incomplete = JSON.parse(String((harness.fetch.mock.calls[1]![1] as RequestInit).body));
    expect(incomplete).not.toHaveProperty("capture");
    expect(harness.sessionValue.latestSnapshot).toEqual(input);
    expect(harness.sessionValue.structuredCaptureCapability).toBe("v1");

    await expect(client.publish(input)).resolves.toBe(true);
    const published = JSON.parse(String((harness.fetch.mock.calls[3]![1] as RequestInit).body));
    expect(published.capture).toEqual(capture);
    expect(harness.sessionValue).toMatchObject({
      structuredCaptureCapability: "v2",
      structuredCaptureV2UpgradeProbeUsed: true,
    });
  });

  test("re-probes a cached v2 owner once and publishes replay diagnostics only after exact v3 negotiation", async () => {
    const capture = createReplayDiagnosticsCapture();
    const input: LocalAgentBridgePublishInput = {
      page: { pageInstanceId: "chromium-tab:7:frame:0", route: "https://app.example.test/settings" },
      attachmentCount: 1,
      agentCopy: "Agent-safe handoff.",
      capture,
    };
    const harness = createHarness({
      persistent: { installationId: INSTALLATION_ID },
      session: {
        browserSessionId: BROWSER_SESSION_ID,
        instanceId: "instance-0123456789ab",
        token: TOKEN,
        sequence: 3,
        structuredCaptureCapability: "v2",
      },
    });
    harness.fetch
      .mockResolvedValueOnce(new Response(JSON.stringify({
        schemaVersion: "0.1.0",
        kind: "ui-attach.local-bridge-structured-capture-capabilities",
        structuredCapture: "v3",
      }), { status: 200, headers: { "content-type": "application/json" } }))
      .mockResolvedValueOnce(new Response(null, { status: 204 }));
    const client = createLocalAgentBridgeClient(harness.dependencies);

    await expect(client.publish(input)).resolves.toBe(true);
    expect(harness.fetch.mock.calls[0]?.[0]).toBe(
      "http://127.0.0.1:38471/v1/capabilities/structured-capture",
    );
    const published = JSON.parse(String((harness.fetch.mock.calls[1]?.[1] as RequestInit).body));
    expect(published.capture.metadataDiagnostics).toEqual(capture.metadataDiagnostics);
    expect(harness.sessionValue).toMatchObject({
      structuredCaptureCapability: "v3",
      structuredCaptureV3UpgradeProbeUsed: true,
      publishedSnapshot: { capture: { metadataDiagnostics: capture.metadataDiagnostics } },
    });
  });

  test("fails closed once when a cached v2 owner cannot accept replay diagnostics", async () => {
    const capture = createReplayDiagnosticsCapture();
    const input: LocalAgentBridgePublishInput = {
      page: { pageInstanceId: "chromium-tab:7:frame:0", route: "https://app.example.test/settings" },
      attachmentCount: 1,
      agentCopy: "Agent-safe handoff.",
      capture,
    };
    const harness = createHarness({
      persistent: { installationId: INSTALLATION_ID },
      session: {
        browserSessionId: BROWSER_SESSION_ID,
        instanceId: "instance-0123456789ab",
        token: TOKEN,
        sequence: 3,
        structuredCaptureCapability: "v2",
      },
    });
    harness.fetch
      .mockResolvedValueOnce(new Response(JSON.stringify({
        schemaVersion: "0.1.0",
        kind: "ui-attach.local-bridge-structured-capture-capabilities",
        structuredCapture: "v2",
      }), { status: 200, headers: { "content-type": "application/json" } }))
      .mockResolvedValueOnce(new Response(null, { status: 204 }));
    const client = createLocalAgentBridgeClient(harness.dependencies);

    await expect(client.publish(input)).resolves.toBe(false);
    await expect(client.publish(input)).resolves.toBe(false);

    const capabilityRequests = harness.fetch.mock.calls.filter(([url]) =>
      String(url).endsWith("/capabilities/structured-capture")
    );
    expect(capabilityRequests).toHaveLength(1);
    const published = JSON.parse(String((harness.fetch.mock.calls[1]?.[1] as RequestInit).body));
    expect(published).not.toHaveProperty("capture");
    expect(harness.sessionValue).toMatchObject({
      latestSnapshot: input,
      structuredCaptureCapability: "v2",
      structuredCaptureV3UpgradeProbeUsed: true,
      publishedSnapshot: {
        page: input.page,
        attachmentCount: input.attachmentCount,
        agentCopy: input.agentCopy,
      },
    });
  });

  test("bounds a fresh V3 diagnostics probe failure until a new connection", async () => {
    const capture = createReplayDiagnosticsCapture();
    const input: LocalAgentBridgePublishInput = {
      page: null,
      attachmentCount: 1,
      agentCopy: "Agent-safe handoff.",
      capture,
    };
    const first = createHarness({
      persistent: { installationId: INSTALLATION_ID },
      session: {
        browserSessionId: BROWSER_SESSION_ID,
        instanceId: "instance-0123456789ab",
        token: TOKEN,
        sequence: 0,
      },
    });
    first.fetch
      .mockResolvedValueOnce(new Response(null, { status: 503 }))
      .mockResolvedValueOnce(new Response(null, { status: 204 }));
    const firstClient = createLocalAgentBridgeClient(first.dependencies);

    await expect(firstClient.publish(input)).resolves.toBe(false);
    await expect(firstClient.publish(input)).resolves.toBe(false);
    expect(first.fetch.mock.calls.filter(([url]) =>
      String(url).endsWith("/capabilities/structured-capture")
    )).toHaveLength(1);
    expect(first.sessionValue).toMatchObject({
      structuredCaptureCapability: "unknown",
      structuredCaptureV3UpgradeProbeUsed: true,
      latestSnapshot: input,
    });

    const reconnected = createHarness({
      persistent: { installationId: INSTALLATION_ID },
      session: {
        browserSessionId: BROWSER_SESSION_ID,
        instanceId: "instance-fedcba987654",
        token: TOKEN,
        sequence: 0,
      },
    });
    reconnected.fetch
      .mockResolvedValueOnce(new Response(JSON.stringify({
        schemaVersion: "0.1.0",
        kind: "ui-attach.local-bridge-structured-capture-capabilities",
        structuredCapture: "v3",
      }), { status: 200, headers: { "content-type": "application/json" } }))
      .mockResolvedValueOnce(new Response(null, { status: 204 }));
    const reconnectedClient = createLocalAgentBridgeClient(reconnected.dependencies);

    await expect(reconnectedClient.publish(input)).resolves.toBe(true);
    expect(reconnected.fetch.mock.calls.filter(([url]) =>
      String(url).endsWith("/capabilities/structured-capture")
    )).toHaveLength(1);
  });

  test("bounds a cached-v1 V3 upgrade timeout across repeated publish and reopens only after reconnect", async () => {
    const capture = createV3StructuredCapture();
    const input: LocalAgentBridgePublishInput = {
      page: null,
      attachmentCount: 1,
      agentCopy: "Agent-safe handoff.",
      capture,
    };
    const harness = createHarness({
      persistent: { installationId: INSTALLATION_ID },
      session: {
        browserSessionId: BROWSER_SESSION_ID,
        instanceId: "instance-0123456789ab",
        token: TOKEN,
        sequence: 3,
        structuredCaptureCapability: "v1",
      },
      uuids: ["aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", REQUEST_ID],
    });
    harness.fetch
      .mockRejectedValueOnce(new Error("timed out"))
      .mockResolvedValueOnce(new Response(null, { status: 204 }))
      .mockResolvedValueOnce(new Response(null, { status: 204 }))
      .mockResolvedValueOnce(connectionResponse("pending", "ask", true))
      .mockResolvedValueOnce(connectionResponse("approved"))
      .mockResolvedValueOnce(new Response(null, { status: 503 }))
      .mockResolvedValueOnce(new Response(null, { status: 204 }));
    const client = createLocalAgentBridgeClient(harness.dependencies);

    await expect(client.publish(input)).resolves.toBe(false);
    await expect(client.publish(input)).resolves.toBe(false);
    expect(harness.fetch.mock.calls.filter(([url]) => String(url).endsWith("/capabilities/structured-capture")))
      .toHaveLength(1);
    expect(harness.sessionValue).toMatchObject({
      latestSnapshot: input,
      structuredCaptureCapability: "unknown",
      structuredCaptureV2UpgradeProbeUsed: true,
    });
    const incompleteSnapshot = JSON.parse(
      String((harness.fetch.mock.calls[1]![1] as RequestInit).body),
    );
    expect(incompleteSnapshot).not.toHaveProperty("capture");

    await client.disconnect();
    expect(harness.sessionValue).toEqual({
      browserSessionId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    });
    await expect(client.createConnectionRequest("ask")).resolves.toMatchObject({ pending: true });
    await expect(client.refreshConnection()).resolves.toMatchObject({ connected: true });
    await expect(client.publish(input)).resolves.toBe(false);
    expect(harness.fetch.mock.calls.filter(([url]) => String(url).endsWith("/capabilities/structured-capture")))
      .toHaveLength(2);
    const renewedSnapshot = JSON.parse(String((harness.fetch.mock.calls.at(-1)?.[1] as RequestInit).body));
    expect(renewedSnapshot).not.toHaveProperty("capture");
    expect(harness.sessionValue.latestSnapshot).toEqual(input);
  });

  test("fails V3 closed for v1, none, and unknown capability outcomes while preserving raw input", async () => {
    for (const response of [
      new Response(JSON.stringify({
        schemaVersion: "0.1.0",
        kind: "ui-attach.local-bridge-structured-capture-capabilities",
        structuredCapture: "v1",
      }), { status: 200, headers: { "content-type": "application/json" } }),
      new Response(null, { status: 404 }),
      new Response(null, { status: 503 }),
    ]) {
      const capture = createV3StructuredCapture();
      const input: LocalAgentBridgePublishInput = {
        page: null,
        attachmentCount: 1,
        agentCopy: "Agent-safe handoff.",
        capture,
      };
      const harness = createHarness({
        persistent: { installationId: INSTALLATION_ID },
        session: {
          browserSessionId: BROWSER_SESSION_ID,
          instanceId: "instance-0123456789ab",
          token: TOKEN,
          sequence: 3,
        },
      });
      harness.fetch.mockResolvedValueOnce(response).mockResolvedValueOnce(new Response(null, { status: 204 }));
      const client = createLocalAgentBridgeClient(harness.dependencies);

      await expect(client.publish(input)).resolves.toBe(false);
      const snapshot = JSON.parse(String((harness.fetch.mock.calls[1]![1] as RequestInit).body));
      expect(snapshot).not.toHaveProperty("capture");
      expect(harness.sessionValue.latestSnapshot).toEqual(input);
    }
  });

  test("preserves the exact V2 annotation identity through publish, clone, and republish", async () => {
    const panelInput: LocalAgentBridgePublishInput = {
      page: {
        pageInstanceId: "chromium-tab:7:frame:0",
        route: "https://app.example.test/settings",
      },
      attachmentCount: 1,
      agentCopy: "Panel Agent-safe handoff.",
      capture: createV2StructuredCapture(),
    };
    const sessionInput: LocalAgentBridgePublishInput = {
      ...panelInput,
      agentCopy: "Session Agent-safe handoff.",
      capture: structuredClone(panelInput.capture),
    };
    const harness = createHarness({
      persistent: { installationId: INSTALLATION_ID },
      session: {
        browserSessionId: BROWSER_SESSION_ID,
        instanceId: "instance-0123456789ab",
        token: TOKEN,
        sequence: 3,
        structuredCaptureCapability: "v1",
      },
    });
    harness.fetch
      .mockResolvedValueOnce(new Response(null, { status: 204 }))
      .mockResolvedValueOnce(new Response(null, { status: 204 }))
      .mockResolvedValueOnce(new Response(null, { status: 204 }));
    const client = createLocalAgentBridgeClient(harness.dependencies);

    await expect(client.publish(panelInput)).resolves.toBe(true);
    const firstPublished = JSON.parse(String((harness.fetch.mock.calls[0]![1] as RequestInit).body));
    expect(readAnnotationIdentity(firstPublished.capture.targets[0])).toEqual(V2_ANNOTATION_IDENTITY);
    expect(harness.sessionValue.panelSnapshot).not.toBe(panelInput);
    expect(readAnnotationIdentity(harness.sessionValue.panelSnapshot?.capture?.targets[0]))
      .toEqual(V2_ANNOTATION_IDENTITY);
    expect(readAnnotationIdentity(harness.sessionValue.publishedSnapshot?.capture?.targets[0]))
      .toEqual(V2_ANNOTATION_IDENTITY);

    await expect(client.publishSessionContext(sessionInput)).resolves.toBe(true);
    const sessionPublished = JSON.parse(String((harness.fetch.mock.calls[1]![1] as RequestInit).body));
    expect(readAnnotationIdentity(sessionPublished.capture.targets[0])).toEqual(V2_ANNOTATION_IDENTITY);
    expect(readAnnotationIdentity(harness.sessionValue.sessionSnapshot?.capture?.targets[0]))
      .toEqual(V2_ANNOTATION_IDENTITY);

    await expect(client.clearSessionContext()).resolves.toBe(true);
    const republished = JSON.parse(String((harness.fetch.mock.calls[2]![1] as RequestInit).body));
    expect(republished.sequence).toBe(6);
    expect(readAnnotationIdentity(republished.capture.targets[0])).toEqual(V2_ANNOTATION_IDENTITY);
    expect(readAnnotationIdentity(harness.sessionValue.latestSnapshot?.capture?.targets[0]))
      .toEqual(V2_ANNOTATION_IDENTITY);
    expect(readAnnotationIdentity(harness.sessionValue.publishedSnapshot?.capture?.targets[0]))
      .toEqual(V2_ANNOTATION_IDENTITY);
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

    await expect(client.refreshConnectionAndHeartbeat()).resolves.toMatchObject({ connected: true });

    const published = JSON.parse(String((harness.fetch.mock.calls[0][1] as RequestInit).body));
    expect(published).toMatchObject({
      sequence: 4,
      capture: { captureId: "session-1", authority: "capture_time" },
    });
    expect(published).not.toHaveProperty("observations");
    expect(published).not.toHaveProperty("activity");
    expect(harness.sessionValue.latestSnapshot).toEqual(cached);
  });

  test("heartbeats after a cached live-page snapshot has already been effectively published", async () => {
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
    };
    const harness = createHarness({
      persistent: { installationId: INSTALLATION_ID },
      session: {
        browserSessionId: BROWSER_SESSION_ID,
        instanceId: "instance-0123456789ab",
        token: TOKEN,
        sequence: 3,
        latestSnapshot: cached,
        structuredCaptureCapability: "v1",
      },
    });
    harness.fetch
      .mockResolvedValueOnce(new Response(null, { status: 204 }))
      .mockResolvedValueOnce(new Response("null", { status: 200 }))
      .mockResolvedValueOnce(new Response(null, { status: 204 }))
      .mockResolvedValueOnce(new Response("null", { status: 200 }));
    const client = createLocalAgentBridgeClient(harness.dependencies);

    await expect(client.refreshConnectionAndHeartbeat()).resolves.toMatchObject({ connected: true });
    await expect(client.refreshConnectionAndHeartbeat()).resolves.toMatchObject({ connected: true });

    expect(harness.fetch).toHaveBeenCalledTimes(4);
    expect(harness.fetch.mock.calls[0][0]).toBe("http://127.0.0.1:38471/v1/snapshot");
    expect(harness.fetch.mock.calls[0][1]).toEqual(expect.objectContaining({ method: "PUT" }));
    expect(harness.fetch.mock.calls[1][0]).toBe(
      "http://127.0.0.1:38471/v1/capture-read-acknowledgement",
    );
    expect(harness.fetch.mock.calls[1][1]).toEqual(expect.objectContaining({ method: "GET" }));
    expect(harness.fetch.mock.calls[2][0]).toBe("http://127.0.0.1:38471/v1/heartbeat");
    expect(harness.fetch.mock.calls[2][1]).toEqual(expect.objectContaining({ method: "POST" }));
    expect(harness.fetch.mock.calls[3][0]).toBe(
      "http://127.0.0.1:38471/v1/capture-read-acknowledgement",
    );
    expect(harness.fetch.mock.calls[3][1]).toEqual(expect.objectContaining({ method: "GET" }));
    expect(harness.sessionValue).toMatchObject({
      sequence: 4,
      latestSnapshot: cached,
      publishedSnapshot: {
        capture: { authority: "capture_time" },
      },
    });
  });

  test("heartbeats an acknowledged live-page snapshot without downgrading or advancing it", async () => {
    const liveSnapshot: LocalAgentBridgePublishInput = {
      page: {
        pageInstanceId: "chromium-tab:7:frame:0",
        route: "https://app.example.test/settings",
      },
      attachmentCount: 1,
      agentCopy: "Agent-safe handoff.",
      capture: { ...createStructuredCapture(), authority: "live_page" },
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
        sequence: 4,
        latestSnapshot: liveSnapshot,
        publishedSnapshot: liveSnapshot,
        structuredCaptureCapability: "v1",
      },
    });
    harness.fetch
      .mockResolvedValueOnce(new Response(null, { status: 204 }))
      .mockResolvedValueOnce(new Response("null", { status: 200 }));
    const client = createLocalAgentBridgeClient(harness.dependencies);

    await expect(client.refreshConnectionAndHeartbeat()).resolves.toMatchObject({ connected: true });

    expect(harness.fetch).toHaveBeenCalledTimes(2);
    expect(harness.fetch).toHaveBeenCalledWith(
      "http://127.0.0.1:38471/v1/heartbeat",
      expect.objectContaining({ method: "POST" }),
    );
    expect(harness.fetch).toHaveBeenCalledWith(
      "http://127.0.0.1:38471/v1/capture-read-acknowledgement",
      expect.objectContaining({ method: "GET" }),
    );
    expect(harness.sessionValue).toMatchObject({
      sequence: 4,
      latestSnapshot: { capture: { authority: "live_page" } },
      publishedSnapshot: { capture: { authority: "live_page" } },
    });
  });

  test("retries structured capture after an unknown capability probe recovers", async () => {
    const capture = createStructuredCapture();
    const input: LocalAgentBridgePublishInput = {
      page: {
        pageInstanceId: "chromium-tab:7:frame:0",
        route: "https://app.example.test/settings",
      },
      attachmentCount: 1,
      agentCopy: "Agent-safe handoff.",
      capture,
    };
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
      .mockResolvedValueOnce(new Response(null, { status: 503 }))
      .mockResolvedValueOnce(new Response(null, { status: 204 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        schemaVersion: "0.1.0",
        kind: "ui-attach.local-bridge-structured-capture-capabilities",
        structuredCapture: "v1",
      }), { status: 200, headers: { "content-type": "application/json" } }))
      .mockResolvedValueOnce(new Response(null, { status: 204 }));
    const client = createLocalAgentBridgeClient(harness.dependencies);

    await expect(client.publish(input)).resolves.toBe(false);

    const firstSnapshot = JSON.parse(String((harness.fetch.mock.calls[1][1] as RequestInit).body));
    expect(firstSnapshot).not.toHaveProperty("capture");
    expect(harness.sessionValue.publishedSnapshot).not.toHaveProperty("capture");
    expect(harness.sessionValue.structuredCaptureCapability).toBe("unknown");

    await expect(client.publish(input)).resolves.toBe(true);

    const secondSnapshot = JSON.parse(String((harness.fetch.mock.calls[3][1] as RequestInit).body));
    expect(secondSnapshot).toMatchObject({ sequence: 5, capture });
    expect(harness.sessionValue).toMatchObject({
      sequence: 5,
      latestSnapshot: input,
      publishedSnapshot: input,
      structuredCaptureCapability: "v1",
    });
  });

  test("retries a newer desired snapshot after an older snapshot was published", async () => {
    const published = {
      page: null,
      attachmentCount: 1,
      agentCopy: "Earlier Agent-safe handoff.",
    };
    const desired = {
      page: null,
      attachmentCount: 3,
      agentCopy: "Current Agent-safe handoff.",
    };
    const harness = createHarness({
      persistent: { installationId: INSTALLATION_ID },
      session: {
        browserSessionId: BROWSER_SESSION_ID,
        instanceId: "instance-0123456789ab",
        token: TOKEN,
        sequence: 3,
        latestSnapshot: desired,
        publishedSnapshot: published,
      },
    });
    harness.fetch.mockResolvedValueOnce(new Response(null, { status: 204 }));
    const client = createLocalAgentBridgeClient(harness.dependencies);

    await expect(client.refreshConnectionAndHeartbeat()).resolves.toMatchObject({ connected: true });

    expect(harness.fetch).toHaveBeenCalledWith(
      "http://127.0.0.1:38471/v1/snapshot",
      expect.objectContaining({ method: "PUT" }),
    );
    expect(JSON.parse(String((harness.fetch.mock.calls[0][1] as RequestInit).body))).toMatchObject({
      sequence: 4,
      attachmentCount: 3,
      agentCopy: desired.agentCopy,
    });
    expect(harness.sessionValue).toMatchObject({
      sequence: 4,
      latestSnapshot: desired,
      publishedSnapshot: desired,
    });
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
        route: "https://app.example.test/settings",
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

    expect(harness.fetch).toHaveBeenCalledTimes(3);
    expect(harness.fetch.mock.calls[0][0]).toBe("http://127.0.0.1:38471/v1/capabilities");
    expect(harness.fetch.mock.calls[1][0]).toBe(
      "http://127.0.0.1:38471/v1/capabilities/structured-capture",
    );
    const firstSnapshot = JSON.parse(String((harness.fetch.mock.calls[2][1] as RequestInit).body));
    expect(firstSnapshot).not.toHaveProperty("observations");
    expect(firstSnapshot).not.toHaveProperty("capture");
    expect(firstSnapshot).toMatchObject({ sequence: 4, agentCopy: input.agentCopy });
    expect(harness.sessionValue).toMatchObject({
      latestSnapshot: input,
      publishedSnapshot: {
        page: input.page,
        attachmentCount: input.attachmentCount,
        agentCopy: input.agentCopy,
      },
      sequence: 4,
      snapshotObservationCapability: "none",
      structuredCaptureCapability: "none",
    });
  });

  test("sends a lightweight heartbeat without publishing an empty snapshot", async () => {
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

    await expect(client.refreshConnectionAndHeartbeat()).resolves.toMatchObject({ connected: true });

    expect(harness.fetch).toHaveBeenCalledWith(
      "http://127.0.0.1:38471/v1/heartbeat",
      expect.objectContaining({ method: "POST" }),
    );
    expect((harness.fetch.mock.calls[0][1] as RequestInit).body).toBeUndefined();
    expect(harness.sessionValue).toEqual({
      browserSessionId: BROWSER_SESSION_ID,
      instanceId: "instance-0123456789ab",
      token: TOKEN,
      sequence: 3,
    });
  });

  test("clears cached and owner-shared capture only through the explicit clear action", async () => {
    const input = { page: null, attachmentCount: 1, agentCopy: "Agent-safe handoff." };
    const panelSnapshot = { page: null, attachmentCount: 2, agentCopy: "Panel handoff." };
    const harness = createHarness({
      persistent: { installationId: INSTALLATION_ID },
      session: {
        browserSessionId: BROWSER_SESSION_ID,
        instanceId: "instance-0123456789ab",
        token: TOKEN,
        sequence: 3,
        latestSnapshot: input,
        panelSnapshot,
        sessionSnapshot: input,
        activeSnapshotSource: "session",
        publishedSnapshot: input,
      },
    });
    harness.fetch.mockResolvedValueOnce(new Response(null, { status: 204 }));
    const client = createLocalAgentBridgeClient(harness.dependencies);

    await expect(client.clearSharedCapture()).resolves.toBe(true);

    expect(harness.fetch).toHaveBeenCalledWith(
      "http://127.0.0.1:38471/v1/shared-capture",
      expect.objectContaining({ method: "DELETE" }),
    );
    expect(harness.sessionValue).toEqual({
      browserSessionId: BROWSER_SESSION_ID,
      instanceId: "instance-0123456789ab",
      token: TOKEN,
      sequence: 3,
    });
  });

  test("persists a clear tombstone and retries DELETE before any old capture can republish", async () => {
    const input = { page: null, attachmentCount: 1, agentCopy: "Agent-safe handoff." };
    const harness = createHarness({
      persistent: { installationId: INSTALLATION_ID },
      session: {
        browserSessionId: BROWSER_SESSION_ID,
        instanceId: "instance-0123456789ab",
        token: TOKEN,
        sequence: 3,
        latestSnapshot: input,
        publishedSnapshot: input,
      },
    });
    harness.fetch
      .mockResolvedValueOnce(new Response(null, { status: 503 }))
      .mockResolvedValueOnce(new Response(null, { status: 204 }));
    const client = createLocalAgentBridgeClient(harness.dependencies);

    await expect(client.clearSharedCapture()).resolves.toBe(false);

    expect(harness.sessionValue).toMatchObject({ clearPending: true, sequence: 3 });
    expect(harness.sessionValue).not.toHaveProperty("latestSnapshot");
    expect(harness.sessionValue).not.toHaveProperty("publishedSnapshot");
    await expect(client.publish(input)).resolves.toBe(false);
    expect(harness.fetch).toHaveBeenCalledTimes(1);

    await expect(client.refreshConnectionAndHeartbeat()).resolves.toMatchObject({ connected: true });

    expect(harness.fetch).toHaveBeenCalledTimes(2);
    expect(harness.fetch.mock.calls.map(([url]) => url)).toEqual([
      "http://127.0.0.1:38471/v1/shared-capture",
      "http://127.0.0.1:38471/v1/shared-capture",
    ]);
    expect(harness.fetch.mock.calls.every(([, init]) => init?.method === "DELETE")).toBe(true);
    expect(harness.sessionValue).toEqual({
      browserSessionId: BROWSER_SESSION_ID,
      instanceId: "instance-0123456789ab",
      token: TOKEN,
      sequence: 3,
    });
  });

  test("drops a pending cached capture when the user clears before approval", async () => {
    const harness = createHarness({
      persistent: { installationId: INSTALLATION_ID },
      session: {
        browserSessionId: BROWSER_SESSION_ID,
        pending: pendingRequest(),
        latestSnapshot: { page: null, attachmentCount: 1, agentCopy: "Agent-safe handoff." },
      },
    });
    const client = createLocalAgentBridgeClient(harness.dependencies);

    await expect(client.clearSharedCapture()).resolves.toBe(true);

    expect(harness.fetch).not.toHaveBeenCalled();
    expect(harness.sessionValue).toMatchObject({
      browserSessionId: BROWSER_SESSION_ID,
      pending: { requestId: REQUEST_ID },
      clearPending: true,
    });
    expect(harness.sessionValue).not.toHaveProperty("latestSnapshot");
  });

  test("accepts and preserves an old cached capture with no annotation identity group", async () => {
    const legacyCapture = structuredClone(createStructuredCapture());
    for (const target of legacyCapture.targets) {
      const value = target as unknown as Record<string, unknown>;
      delete value.annotationId;
      delete value.annotationIdScope;
      delete value.annotationCreatedAt;
      delete value.annotationUpdatedAt;
    }
    const cached: LocalAgentBridgePublishInput = {
      page: {
        pageInstanceId: "chromium-tab:7:frame:0",
        route: "https://app.example.test/settings",
      },
      attachmentCount: 1,
      agentCopy: "Legacy Agent-safe handoff.",
      capture: legacyCapture,
    };
    const harness = createHarness({
      persistent: { installationId: INSTALLATION_ID },
      session: {
        browserSessionId: BROWSER_SESSION_ID,
        instanceId: "instance-0123456789ab",
        token: TOKEN,
        sequence: 3,
        latestSnapshot: cached,
        panelSnapshot: cached,
        activeSnapshotSource: "panel",
        publishedSnapshot: cached,
        structuredCaptureCapability: "v1",
      },
    });
    const client = createLocalAgentBridgeClient(harness.dependencies);

    await expect(client.readStatus()).resolves.toMatchObject({
      connected: true,
      pending: false,
    });
    expect(harness.sessionValue.latestSnapshot).toEqual(cached);
    expect(harness.sessionValue.latestSnapshot?.capture?.targets[0])
      .not.toHaveProperty("annotationId");
    expect(harness.sessionValue.latestSnapshot?.capture?.targets[0])
      .not.toHaveProperty("annotationIdScope");
    expect(harness.sessionValue.latestSnapshot?.capture?.targets[0])
      .not.toHaveProperty("annotationCreatedAt");
    expect(harness.sessionValue.latestSnapshot?.capture?.targets[0])
      .not.toHaveProperty("annotationUpdatedAt");
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

  test("ensures the local owners before generating invitation secrets or posting", async () => {
    const harness = createHarness();
    const ensureOwnersReady = vi.fn(async () => {
      expect(harness.fetch).not.toHaveBeenCalled();
      expect(harness.sessionValue).toEqual({});
    });
    harness.dependencies.ensureOwnersReady = ensureOwnersReady;
    harness.fetch.mockResolvedValueOnce(connectionResponse("pending", "browser_session", true));
    const client = createLocalAgentBridgeClient(harness.dependencies);

    await client.createConnectionRequest("browser_session");

    expect(ensureOwnersReady).toHaveBeenCalledOnce();
    expect(harness.fetch).toHaveBeenCalledOnce();
  });

  test("fails before invitation creation and removes loopback permission when bootstrap is blocked", async () => {
    const harness = createHarness();
    harness.dependencies.ensureOwnersReady = vi.fn(async () => {
      throw new Error("safe bootstrap failure");
    });
    const client = createLocalAgentBridgeClient(harness.dependencies);

    await expect(client.createConnectionRequest("browser_session")).rejects.toThrow(
      "safe bootstrap failure",
    );

    expect(harness.fetch).not.toHaveBeenCalled();
    expect(harness.sessionValue).toEqual({});
    expect(harness.dependencies.removePermission).toHaveBeenCalledOnce();
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
  panelSnapshot?: LocalAgentBridgePublishInput;
  sessionSnapshot?: LocalAgentBridgePublishInput;
  activeSnapshotSource?: "panel" | "session" | "unknown";
  publishedSnapshot?: LocalAgentBridgePublishInput;
  clearPending?: true;
  snapshotObservationCapability?: "v1" | "none" | "unknown";
  structuredCaptureCapability?: "v3" | "v2" | "v1" | "none" | "unknown";
  structuredCaptureV2UpgradeProbeUsed?: true;
  structuredCaptureV3UpgradeProbeUsed?: true;
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
    requestText: `meanthis bridge accept ${CONNECTION_CODE} --json`,
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
