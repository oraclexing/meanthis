import { describe, expect, test } from "vitest";
import {
  UI_ATTACH_LOCAL_BRIDGE_CAPABILITIES_PATH,
  UI_ATTACH_LOCAL_BRIDGE_ORIGIN,
  UI_ATTACH_LOCAL_BRIDGE_STRUCTURED_CAPTURE_CAPABILITIES_PATH,
  UI_ATTACHMENT_SCHEMA_VERSION,
  isLocalBridgeCapabilities,
  isLocalBridgeConnectionRequest,
  isLocalBridgePairRequest,
  isLocalBridgeSnapshot,
  isLocalBridgeStructuredCaptureCapabilities,
  type UIAttachment,
} from "./index";

const attachment: UIAttachment = {
  schemaVersion: UI_ATTACHMENT_SCHEMA_VERSION,
  id: "att_save",
  capturedAt: "2026-07-17T04:29:58.000Z",
  source: { kind: "web", url: null, title: "Settings" },
  element: {
    tagName: "button",
    role: "button",
    text: "Save",
    accessibleName: "Save changes",
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
    selectorHints: ["button[type=\"submit\"]"],
  },
  locatorBundle: {
    primary: {
      strategy: "playwright.role",
      value: "page.getByRole(\"button\", { name: \"Save changes\" })",
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
};

const pairRequest = {
  schemaVersion: "0.1.0",
  kind: "ui-attach.local-bridge-pair",
  pairingCode: "482-193",
  installationId: "5ea6b70f-48e8-4a7b-bc91-d943b0ef10f3",
};

const connectionRequest = {
  schemaVersion: "0.1.0",
  kind: "ui-attach.local-bridge-connection-request",
  requestId: "95e3e7b1-6f74-44ae-8954-e11f7f2a7c58",
  requestSecret: "CwsLCwsLCwsLCwsLCwsLCwsLCwsLCwsLCwsLCwsLCws",
  approvalVerifier: "2XFhhwHqI_j4roXwpQagX-Ss8A4Crj7r9vP2Uu7Z2yE",
  installationId: "5ea6b70f-48e8-4a7b-bc91-d943b0ef10f3",
  browserSessionId: "32b8d92d-c76e-4c72-9f3c-5ba5bf31cd22",
  approvalMode: "ask",
};

const snapshot = {
  schemaVersion: "0.1.0",
  kind: "ui-attach.local-bridge-snapshot",
  sequence: 4,
  publishedAt: "2026-07-17T04:30:00.000Z",
  page: {
    pageInstanceId: "chromium-tab:1199971128:frame:0",
    route: "https://aistudio.google.com/prompts/new_chat",
  },
  attachmentCount: 1,
  agentCopy: "# MeanThis Capture Bundle\n\nAgent-safe handoff.",
};

const capture = {
  captureId: "session-1",
  title: "Settings review",
  origin: "https://example.test",
  updatedAt: "2026-07-17T04:29:58.000Z",
  authority: "capture_time" as const,
  disclosureMode: "agent_safe" as const,
  targets: [{
    attachmentId: "att_save",
    label: "A",
    taskNote: "Shorten the label.",
    attachment,
  }],
};

const capabilities = {
  schemaVersion: "0.1.0",
  kind: "ui-attach.local-bridge-capabilities",
  snapshotObservations: "v1",
};

describe("local agent bridge protocol", () => {
  test("pins the loopback origin and accepts exact pairing requests", () => {
    expect(UI_ATTACH_LOCAL_BRIDGE_ORIGIN).toBe("http://127.0.0.1:38471");
    expect(UI_ATTACH_LOCAL_BRIDGE_CAPABILITIES_PATH).toBe("/v1/capabilities");
    expect(isLocalBridgePairRequest(pairRequest)).toBe(true);
    expect(isLocalBridgePairRequest({ ...pairRequest, pairingCode: "482193" })).toBe(false);
    expect(isLocalBridgePairRequest({ ...pairRequest, installationId: "profile-default" })).toBe(false);
    expect(isLocalBridgePairRequest({ ...pairRequest, secret: "unexpected" })).toBe(false);
  });

  test("accepts only the exact observation capability response", () => {
    expect(isLocalBridgeCapabilities(capabilities)).toBe(true);
    expect(isLocalBridgeCapabilities({ ...capabilities, structuredCapture: "v1" })).toBe(false);
    expect(isLocalBridgeCapabilities({ ...capabilities, snapshotObservations: "v2" })).toBe(false);
    expect(isLocalBridgeCapabilities({ ...capabilities, controls: true })).toBe(false);
  });

  test("keeps structured capture on a separate versioned capability contract", () => {
    expect(UI_ATTACH_LOCAL_BRIDGE_STRUCTURED_CAPTURE_CAPABILITIES_PATH).toBe(
      "/v1/capabilities/structured-capture",
    );
    const structured = {
      schemaVersion: "0.1.0",
      kind: "ui-attach.local-bridge-structured-capture-capabilities",
      structuredCapture: "v1",
    };
    expect(isLocalBridgeStructuredCaptureCapabilities(structured)).toBe(true);
    expect(isLocalBridgeStructuredCaptureCapabilities({
      ...structured,
      structuredCapture: "v2",
    })).toBe(false);
    expect(isLocalBridgeStructuredCaptureCapabilities({ ...structured, controls: true })).toBe(false);
  });

  test("accepts only exact browser-created connection requests", () => {
    expect(isLocalBridgeConnectionRequest(connectionRequest)).toBe(true);
    expect(isLocalBridgeConnectionRequest({
      ...connectionRequest,
      approvalMode: "browser_session",
    })).toBe(true);
    expect(isLocalBridgeConnectionRequest({ ...connectionRequest, approvalVerifier: "short" })).toBe(false);
    expect(isLocalBridgeConnectionRequest({ ...connectionRequest, requestSecret: "short" })).toBe(false);
    expect(isLocalBridgeConnectionRequest({ ...connectionRequest, approvalMode: "always" })).toBe(false);
    expect(isLocalBridgeConnectionRequest({ ...connectionRequest, page: { route: "https://example.test" } })).toBe(false);
  });

  test("accepts only bounded agent-safe snapshot fields", () => {
    expect(isLocalBridgeSnapshot(snapshot)).toBe(true);
    expect(isLocalBridgeSnapshot({
      ...snapshot,
      attachmentCount: 4,
      observations: {
        observedAt: "2026-07-17T04:29:59.000Z",
        documentInstanceId: "document-01234567",
        targets: [
          { attachmentId: "att_save", status: "restored" },
          { attachmentId: "att_cancel", status: "missing" },
          { attachmentId: "att_help", status: "ambiguous" },
          { attachmentId: "att_submit", status: "checking" },
        ],
      },
    })).toBe(true);
    expect(isLocalBridgeSnapshot({ ...snapshot, attachmentCount: 27 })).toBe(false);
    expect(isLocalBridgeSnapshot({ ...snapshot, sequence: -1 })).toBe(false);
    expect(isLocalBridgeSnapshot({ ...snapshot, sourceSession: {} })).toBe(false);
    expect(isLocalBridgeSnapshot({ ...snapshot, agentCopy: "x".repeat(262_145) })).toBe(false);
  });

  test("accepts one bounded structured capture without widening disclosure", () => {
    expect(isLocalBridgeSnapshot({ ...snapshot, capture })).toBe(true);
    expect(isLocalBridgeSnapshot({ ...snapshot, page: null, capture })).toBe(true);
    expect(isLocalBridgeSnapshot({
      ...snapshot,
      page: null,
      capture: { ...capture, authority: "current_unbound" },
    })).toBe(false);
    expect(isLocalBridgeSnapshot({
      ...snapshot,
      capture: { ...capture, disclosureMode: "developer_diagnostic" },
    })).toBe(false);
    expect(isLocalBridgeSnapshot({
      ...snapshot,
      capture: {
        ...capture,
        targets: [{ ...capture.targets[0], taskNote: "x".repeat(16_385) }],
      },
    })).toBe(false);
    expect(isLocalBridgeSnapshot({
      ...snapshot,
      attachmentCount: 2,
      capture,
    })).toBe(false);
    expect(isLocalBridgeSnapshot({
      ...snapshot,
      capture: {
        ...capture,
        targets: [{ ...capture.targets[0], attachment: { ...attachment, id: "att_other" } }],
      },
    })).toBe(false);
  });

  test("requires fresh exact restored observations for live-page capture authority", () => {
    const liveCapture = { ...capture, authority: "live_page" as const };
    const observations = {
      observedAt: "2026-07-17T04:29:59.000Z",
      documentInstanceId: "document-01234567",
      targets: [{ attachmentId: "att_save", status: "restored" as const }],
    };
    expect(isLocalBridgeSnapshot({ ...snapshot, capture: liveCapture })).toBe(false);
    expect(isLocalBridgeSnapshot({
      ...snapshot,
      capture: liveCapture,
      observations,
    })).toBe(true);
    expect(isLocalBridgeSnapshot({
      ...snapshot,
      capture: liveCapture,
      observations: {
        ...observations,
        targets: [{ attachmentId: "att_save", status: "missing" }],
      },
    })).toBe(false);
    expect(isLocalBridgeSnapshot({
      ...snapshot,
      capture: liveCapture,
      observations: { ...observations, observedAt: "2026-07-17T04:20:00.000Z" },
    })).toBe(false);
  });

  test("accepts only bounded saved-restore activity receipts", () => {
    const activity = {
      operation: "saved_restore",
      state: "failed",
      stage: "background_response",
      code: "FRAME_PERMISSION_DENIED",
      observedAt: "2026-07-17T04:29:59.000Z",
    };
    expect(isLocalBridgeSnapshot({ ...snapshot, activity })).toBe(true);
    expect(isLocalBridgeSnapshot({
      ...snapshot,
      activity: { ...activity, operation: "browser_control" },
    })).toBe(false);
    expect(isLocalBridgeSnapshot({
      ...snapshot,
      activity: { ...activity, stage: "page_text" },
    })).toBe(false);
    expect(isLocalBridgeSnapshot({
      ...snapshot,
      activity: { ...activity, code: "contains private page text" },
    })).toBe(false);
    expect(isLocalBridgeSnapshot({
      ...snapshot,
      activity: { ...activity, observedAt: "now" },
    })).toBe(false);
    expect(isLocalBridgeSnapshot({
      ...snapshot,
      activity: { ...activity, route: "https://private.example.test" },
    })).toBe(false);
  });

  test("accepts optional current-page observations while rejecting unsafe variants", () => {
    const observed = {
      ...snapshot,
      observations: {
        observedAt: "2026-07-17T04:29:59.000Z",
        documentInstanceId: "document-01234567",
        targets: [{ attachmentId: "att_save", status: "restored" }],
      },
    };

    expect(isLocalBridgeSnapshot(observed)).toBe(true);
    expect(isLocalBridgeSnapshot({
      ...observed,
      observations: {
        observedAt: "2026-07-17T04:29:59.000Z",
        documentInstanceId: "document-01234567",
        targets: [
          { attachmentId: "att_save", status: "restored" },
          { attachmentId: "att_save", status: "missing" },
        ],
      },
    })).toBe(false);
    expect(isLocalBridgeSnapshot({
      ...observed,
      observations: {
        observedAt: "2026-07-17T04:29:59.000Z",
        documentInstanceId: "document-01234567",
        targets: Array.from({ length: 27 }, (_, index) => ({
          attachmentId: `att_${index}`,
          status: "restored",
        })),
      },
    })).toBe(false);
    expect(isLocalBridgeSnapshot({
      ...observed,
      observations: {
        observedAt: "2026-07-17T04:29:59.000Z",
        documentInstanceId: "document-01234567",
        targets: [{ attachmentId: "Save button", status: "restored" }],
      },
    })).toBe(false);
    expect(isLocalBridgeSnapshot({
      ...observed,
      observations: {
        observedAt: "2026-07-17T04:29:59.000Z",
        documentInstanceId: "document-01234567",
        targets: [{ attachmentId: "att_save", status: "clicked" }],
      },
    })).toBe(false);
    expect(isLocalBridgeSnapshot({
      ...observed,
      observations: {
        observedAt: "2026-07-17T04:29:59.000Z",
        documentInstanceId: "document-01234567",
        targets: [],
        observedBy: "agent",
      },
    })).toBe(false);
    expect(isLocalBridgeSnapshot({
      ...observed,
      observations: {
        observedAt: "yesterday",
        documentInstanceId: "document-01234567",
        targets: [],
      },
    })).toBe(false);
    expect(isLocalBridgeSnapshot({
      ...observed,
      page: null,
    })).toBe(false);
    expect(isLocalBridgeSnapshot({
      ...observed,
      attachmentCount: 0,
    })).toBe(false);
    expect(isLocalBridgeSnapshot({
      ...observed,
      observations: {
        observedAt: "2026-07-17T04:29:59.000Z",
        documentInstanceId: "document-01234567",
        targets: [],
      },
    })).toBe(false);
    expect(isLocalBridgeSnapshot({
      ...observed,
      observations: {
        observedAt: "2026-07-17T04:29:59.000Z",
        documentInstanceId: "contains spaces",
        targets: [{ attachmentId: "att_save", status: "restored" }],
      },
    })).toBe(false);
    expect(isLocalBridgeSnapshot({
      ...observed,
      observations: {
        observedAt: "2026-07-17T04:29:59.000Z",
        targets: [{ attachmentId: "att_save", status: "restored" }],
      },
    })).toBe(false);
  });

  test("fails closed on unsafe or malformed routing data", () => {
    expect(isLocalBridgeSnapshot({ ...snapshot, page: null, agentCopy: null })).toBe(true);
    expect(isLocalBridgeSnapshot({
      ...snapshot,
      page: { ...snapshot.page, route: "https://example.test/account/%73%6b-test-secret" },
    })).toBe(false);
    expect(isLocalBridgeSnapshot({
      ...snapshot,
      page: { ...snapshot.page, route: "https://ada:secret@example.test/account" },
    })).toBe(false);
    expect(isLocalBridgeSnapshot({
      ...snapshot,
      page: { ...snapshot.page, pageInstanceId: "chromium-profile:Default" },
    })).toBe(false);
  });
});
