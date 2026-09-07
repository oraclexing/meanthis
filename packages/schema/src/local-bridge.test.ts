import { describe, expect, test } from "vitest";
import {
  UI_ATTACH_LOCAL_BRIDGE_CAPABILITIES_PATH,
  UI_ATTACH_LOCAL_BRIDGE_HEARTBEAT_PATH,
  UI_ATTACH_LOCAL_BRIDGE_ORIGIN,
  UI_ATTACH_LOCAL_BRIDGE_SHARED_CAPTURE_PATH,
  UI_ATTACH_LOCAL_BRIDGE_STRUCTURED_CAPTURE_CAPABILITIES_PATH,
  UI_ATTACHMENT_SCHEMA_VERSION,
  createLocalBridgeConnectionCode,
  isLocalBridgeCapabilities,
  isLocalBridgeConnectionRequest,
  isLocalBridgeMcpReadReceipt,
  isLocalBridgeReadAcknowledgement,
  isLocalBridgePairRequest,
  isLocalBridgeSnapshot,
  isLocalBridgeStructuredCaptureCapabilities,
  parseLocalBridgeReadAcknowledgement,
  parseLocalBridgeMcpReadReceipt,
  parseLocalBridgeConnectionCode,
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
  origin: "https://aistudio.google.com",
  updatedAt: "2026-07-17T04:29:58.000Z",
  authority: "capture_time" as const,
  disclosureMode: "agent_safe" as const,
  targets: [{
    targetId: "target_A",
    attachmentId: "att_save",
    label: "A",
    taskNote: "Shorten the label.",
    attachment,
  }],
};

const replayDiagnostics = {
  schemaVersion: "0.1.0",
  kind: "ui-attach.metadata-only-diagnostics",
  captureId: capture.captureId,
  scope: "capture",
  observedAt: capture.updatedAt,
  consent: "explicit_capture",
  authority: "capture_time",
  replay: {
    status: "collected",
    attemptCount: 2,
    verifiedCount: 1,
    ambiguousCount: 1,
    missingCount: 0,
  },
  device: { status: "not_requested" },
  network: { status: "not_requested" },
  console: { status: "not_requested" },
  executionAuthority: {
    grantedByCapture: false,
    browserControl: false,
    liveDomMutation: false,
  },
} as const;

const capabilities = {
  schemaVersion: "0.1.0",
  kind: "ui-attach.local-bridge-capabilities",
  snapshotObservations: "v1",
};

const mcpReadReceipt = {
  schemaVersion: "0.1.0",
  kind: "ui-attach.mcp-read-receipt",
  receiptId: "cf9507f2-20c5-48aa-91f2-d3372c4bb42a",
  status: "returned_to_mcp_client",
  instanceId: "instance-0123456789ab",
  captureId: "session-1",
  snapshotSequence: 4,
  detail: "handoff",
  handoffDigest: `sha256:${"a".repeat(64)}`,
  issuedAt: "2026-09-02T14:00:00.000Z",
  executionAuthority: {
    grantedByCapture: false,
    browserControl: false,
    liveDomMutation: false,
  },
  limitations: [
    "does_not_prove_model_attention",
    "does_not_prove_task_creation",
    "does_not_prove_downstream_execution",
  ],
};

const readAcknowledgement = {
  schemaVersion: "0.1.0",
  kind: "ui-attach.local-bridge-read-acknowledgement",
  acknowledgementId: "c8e59b7e-5b59-47e7-9b80-4cf92fbcf89d",
  status: "acknowledged_by_agent_client",
  instanceId: "instance-0123456789ab",
  captureId: "session-1",
  snapshotSequence: 4,
  detail: "agent_context",
  acknowledgedAt: "2026-09-02T14:00:00.000Z",
  executionAuthority: {
    grantedByCapture: false,
    browserControl: false,
    liveDomMutation: false,
  },
  limitations: [
    "does_not_prove_model_attention",
    "does_not_prove_task_creation",
    "does_not_prove_downstream_execution",
  ],
};

describe("local agent bridge protocol", () => {
  test("accepts only an exact bounded MCP read receipt", () => {
    expect(isLocalBridgeMcpReadReceipt(mcpReadReceipt)).toBe(true);
    expect(parseLocalBridgeMcpReadReceipt(mcpReadReceipt)).toEqual(mcpReadReceipt);

    const malformed = [
      { ...mcpReadReceipt, receiptId: "receipt-1" },
      { ...mcpReadReceipt, status: "consumed_by_model" },
      { ...mcpReadReceipt, instanceId: "instance-current" },
      { ...mcpReadReceipt, captureId: "x".repeat(129) },
      { ...mcpReadReceipt, snapshotSequence: -1 },
      { ...mcpReadReceipt, snapshotSequence: 1.5 },
      { ...mcpReadReceipt, detail: "summary" },
      { ...mcpReadReceipt, handoffDigest: `sha256:${"A".repeat(64)}` },
      { ...mcpReadReceipt, issuedAt: "+020026-09-02T14:00:00.000Z" },
      {
        ...mcpReadReceipt,
        executionAuthority: { ...mcpReadReceipt.executionAuthority, browserControl: true },
      },
      {
        ...mcpReadReceipt,
        limitations: [...mcpReadReceipt.limitations].reverse(),
      },
      { ...mcpReadReceipt, unexpected: true },
    ];
    for (const value of malformed) {
      expect(isLocalBridgeMcpReadReceipt(value)).toBe(false);
      expect(parseLocalBridgeMcpReadReceipt(value)).toBeNull();
    }
  });

  test("distinguishes missing fields from own undefined in MCP read receipts", () => {
    const missing = { ...mcpReadReceipt } as Record<string, unknown>;
    delete missing.handoffDigest;
    const ownUndefined = { ...mcpReadReceipt, handoffDigest: undefined };

    expect(parseLocalBridgeMcpReadReceipt(missing)).toBeNull();
    expect(Object.hasOwn(ownUndefined, "handoffDigest")).toBe(true);
    expect(parseLocalBridgeMcpReadReceipt(ownUndefined)).toBeNull();
  });

  test("rejects MCP read receipt accessors without invoking them", () => {
    let getterCalls = 0;
    const hostile = { ...mcpReadReceipt } as Record<string, unknown>;
    Object.defineProperty(hostile, "handoffDigest", {
      enumerable: true,
      get() {
        getterCalls += 1;
        return mcpReadReceipt.handoffDigest;
      },
    });

    expect(parseLocalBridgeMcpReadReceipt(hostile)).toBeNull();
    expect(getterCalls).toBe(0);
  });

  test("accepts only an exact bounded Agent read acknowledgement", () => {
    expect(isLocalBridgeReadAcknowledgement(readAcknowledgement)).toBe(true);
    expect(parseLocalBridgeReadAcknowledgement(readAcknowledgement)).toEqual(readAcknowledgement);

    const malformed = [
      { ...readAcknowledgement, acknowledgementId: "ack-1" },
      { ...readAcknowledgement, status: "returned_to_mcp_client" },
      { ...readAcknowledgement, instanceId: "instance-current" },
      { ...readAcknowledgement, captureId: "x".repeat(129) },
      { ...readAcknowledgement, snapshotSequence: 0 },
      { ...readAcknowledgement, snapshotSequence: -1 },
      { ...readAcknowledgement, snapshotSequence: 1.5 },
      { ...readAcknowledgement, detail: "unknown" },
      { ...readAcknowledgement, acknowledgedAt: "+020026-09-02T14:00:00.000Z" },
      {
        ...readAcknowledgement,
        executionAuthority: { ...readAcknowledgement.executionAuthority, browserControl: true },
      },
      {
        ...readAcknowledgement,
        limitations: [...readAcknowledgement.limitations].reverse(),
      },
      { ...readAcknowledgement, unexpected: true },
    ];
    for (const value of malformed) {
      expect(isLocalBridgeReadAcknowledgement(value)).toBe(false);
      expect(parseLocalBridgeReadAcknowledgement(value)).toBeNull();
    }
  });

  test("rejects missing, own undefined, accessors, and overbound acknowledgement data", () => {
    const missing = { ...readAcknowledgement } as Record<string, unknown>;
    delete missing.detail;
    expect(parseLocalBridgeReadAcknowledgement(missing)).toBeNull();
    expect(parseLocalBridgeReadAcknowledgement({ ...readAcknowledgement, detail: undefined })).toBeNull();

    let getterCalls = 0;
    const accessor = { ...readAcknowledgement } as Record<string, unknown>;
    Object.defineProperty(accessor, "detail", {
      enumerable: true,
      get() {
        getterCalls += 1;
        return readAcknowledgement.detail;
      },
    });
    expect(parseLocalBridgeReadAcknowledgement(accessor)).toBeNull();
    expect(getterCalls).toBe(0);

    expect(parseLocalBridgeReadAcknowledgement({
      ...readAcknowledgement,
      captureId: "x".repeat(129),
    })).toBeNull();
  });

  test("round-trips one canonical compact connection code", () => {
    const code = createLocalBridgeConnectionCode({
      requestId: connectionRequest.requestId,
      approvalMode: "ask",
      approvalKey: "DAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAw",
    });

    expect(code).toMatch(/^[A-Za-z0-9]{68}$/);
    expect(code).not.toMatch(/[-_\\]/);
    expect(code).toHaveLength(68);
    expect(parseLocalBridgeConnectionCode(code)).toEqual({
      requestId: connectionRequest.requestId,
      approvalMode: "ask",
      approvalKey: "DAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAw",
    });
    expect(parseLocalBridgeConnectionCode(`${code}x`)).toBeNull();
    expect(parseLocalBridgeConnectionCode(`Ag${code.slice(2)}`)).toBeNull();
    expect(parseLocalBridgeConnectionCode(`AQI${code.slice(3)}`)).toBeNull();
  });

  test("round-trips the browser-session mode without changing the payload shape", () => {
    const code = createLocalBridgeConnectionCode({
      requestId: connectionRequest.requestId,
      approvalMode: "browser_session",
      approvalKey: "DAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAw",
    });

    expect(code).toMatch(/^[A-Za-z0-9]{68}$/);
    expect(code).toHaveLength(68);
    expect(parseLocalBridgeConnectionCode(code)).toEqual({
      requestId: connectionRequest.requestId,
      approvalMode: "browser_session",
      approvalKey: "DAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAw",
    });
  });

  test("pins the loopback origin and accepts exact pairing requests", () => {
    expect(UI_ATTACH_LOCAL_BRIDGE_ORIGIN).toBe("http://127.0.0.1:38471");
    expect(UI_ATTACH_LOCAL_BRIDGE_CAPABILITIES_PATH).toBe("/v1/capabilities");
    expect(UI_ATTACH_LOCAL_BRIDGE_HEARTBEAT_PATH).toBe("/v1/heartbeat");
    expect(UI_ATTACH_LOCAL_BRIDGE_SHARED_CAPTURE_PATH).toBe("/v1/shared-capture");
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
    })).toBe(true);
    expect(isLocalBridgeStructuredCaptureCapabilities({
      ...structured,
      structuredCapture: "v3",
    })).toBe(true);
    expect(isLocalBridgeStructuredCaptureCapabilities({
      ...structured,
      structuredCapture: "v4",
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
    expect(isLocalBridgeSnapshot({
      ...snapshot,
      capture: {
        ...capture,
        targets: [{
          ...capture.targets[0],
          attachment: {
            ...attachment,
            style: {
              ...attachment.style,
              position: "relative",
              padding: "6px 8px",
              fontSize: "14px",
            },
          },
        }],
      },
    })).toBe(true);
    for (const style of [
      { ...attachment.style, opacity: "0.5" },
      { ...attachment.style, position: undefined },
      { ...attachment.style, padding: "x".repeat(513) },
    ]) {
      expect(isLocalBridgeSnapshot({
        ...snapshot,
        capture: {
          ...capture,
          targets: [{
            ...capture.targets[0],
            attachment: { ...attachment, style },
          }],
        },
      })).toBe(false);
    }
    expect(isLocalBridgeSnapshot({
      ...snapshot,
      capture: { ...capture, origin: "https://other.example.test" },
    })).toBe(false);
    expect(isLocalBridgeSnapshot({
      ...snapshot,
      capture: {
        ...capture,
        targets: capture.targets.map(({ targetId: _targetId, ...target }) => target),
      },
    })).toBe(true);
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
    expect(isLocalBridgeSnapshot({
      ...snapshot,
      capture: {
        ...capture,
        targets: [{ ...capture.targets[0], targetId: "A" }],
      },
    })).toBe(false);
    expect(isLocalBridgeSnapshot({
      ...snapshot,
      capture: {
        ...capture,
        targets: [{
          ...capture.targets[0],
          attachment: {
            ...attachment,
            element: {
              ...attachment.element,
              contentParts: [{
                kind: "author",
                tagName: "span",
                role: null,
                text: "Tibo",
                accessibleName: "Tibo",
              }],
            },
          },
        }],
      },
    })).toBe(false);
  });

  test("binds capture-time replay diagnostics to the exact shared capture", () => {
    const diagnosticCapture = { ...capture, metadataDiagnostics: replayDiagnostics };
    expect(isLocalBridgeSnapshot({ ...snapshot, capture: diagnosticCapture })).toBe(true);
    const collectedDeviceDiagnostics = {
      ...replayDiagnostics,
      observedAt: "2026-07-17T04:29:57.000Z",
      device: {
        status: "collected",
        deviceClass: "desktop",
        viewportClass: "large",
        touch: "none",
      },
    };
    expect(isLocalBridgeSnapshot({
      ...snapshot,
      capture: { ...capture, metadataDiagnostics: collectedDeviceDiagnostics },
    })).toBe(true);

    for (const metadataDiagnostics of [
      { ...replayDiagnostics, captureId: "session-other" },
      { ...replayDiagnostics, observedAt: "2026-07-17T04:29:59.000Z" },
      { ...replayDiagnostics, authority: "live_page" },
      {
        ...replayDiagnostics,
        network: { status: "collected", requestCount: 1, failureCount: 0, windowMs: 10 },
      },
      {
        ...replayDiagnostics,
        console: { status: "collected", logCount: 1, warnCount: 0, errorCount: 0, windowMs: 10 },
      },
    ]) {
      expect(isLocalBridgeSnapshot({
        ...snapshot,
        capture: { ...capture, metadataDiagnostics },
      })).toBe(false);
    }
    expect(isLocalBridgeSnapshot({
      ...snapshot,
      capture: { ...capture, metadataDiagnostics: undefined },
    })).toBe(false);
  });

  test("accepts the complete annotation identity group and rejects unsafe variants", () => {
    const identity = {
      annotationId: "annotation-save",
      annotationIdScope: "capture_session" as const,
      annotationCreatedAt: "2026-07-17T04:29:57.000Z",
      annotationUpdatedAt: "2026-07-17T04:29:58.000Z",
    };
    const annotatedCapture = {
      ...capture,
      targets: [{ ...capture.targets[0], ...identity }],
    };
    expect(isLocalBridgeSnapshot({ ...snapshot, capture: annotatedCapture })).toBe(true);
    expect(isLocalBridgeSnapshot({ ...snapshot, capture })).toBe(true);
    expect(isLocalBridgeSnapshot({
      ...snapshot,
      capture: { ...capture, targets: [{ ...capture.targets[0], annotationId: identity.annotationId }] },
    })).toBe(false);
    expect(isLocalBridgeSnapshot({
      ...snapshot,
      capture: {
        ...capture,
        targets: [{
          ...capture.targets[0],
          annotationId: undefined,
          annotationIdScope: "capture_session",
          annotationCreatedAt: identity.annotationCreatedAt,
          annotationUpdatedAt: identity.annotationUpdatedAt,
        }],
      },
    })).toBe(false);
    expect(isLocalBridgeSnapshot({
      ...snapshot,
      capture: {
        ...capture,
        targets: [{
          ...capture.targets[0],
          annotationId: null,
          annotationIdScope: "capture_session",
          annotationCreatedAt: null,
          annotationUpdatedAt: null,
        }],
      },
    })).toBe(false);
    expect(isLocalBridgeSnapshot({
      ...snapshot,
      capture: {
        ...capture,
        targets: [{
          ...capture.targets[0],
          annotationId: "annotation-save",
          annotationIdScope: "unknown",
          annotationCreatedAt: identity.annotationCreatedAt,
          annotationUpdatedAt: identity.annotationUpdatedAt,
        }],
      },
    })).toBe(false);
    expect(isLocalBridgeSnapshot({
      ...snapshot,
      capture: {
        ...capture,
        targets: [{
          ...capture.targets[0],
          annotationId: "annotation-save",
          annotationIdScope: "capture_session",
          annotationCreatedAt: identity.annotationUpdatedAt,
          annotationUpdatedAt: identity.annotationCreatedAt,
        }],
      },
    })).toBe(false);
    expect(isLocalBridgeSnapshot({
      ...snapshot,
      capture: {
        ...capture,
        targets: [{
          ...capture.targets[0],
          annotationId: "annotation-save",
          annotationIdScope: "capture_session",
          annotationCreatedAt: identity.annotationCreatedAt,
          annotationUpdatedAt: "2026-07-17T04:29:59.000Z",
        }],
      },
    })).toBe(false);
    expect(isLocalBridgeSnapshot({
      ...snapshot,
      capture: {
        ...capture,
        targets: [{
          ...capture.targets[0],
          annotationId: "annotation/save",
          annotationIdScope: "capture_session",
          annotationCreatedAt: identity.annotationCreatedAt,
          annotationUpdatedAt: identity.annotationUpdatedAt,
        }],
      },
    })).toBe(false);
    expect(isLocalBridgeSnapshot({
      ...snapshot,
      capture: {
        ...capture,
        targets: [{
          ...capture.targets[0],
          annotationId: "a".repeat(129),
          annotationIdScope: "capture_session",
          annotationCreatedAt: identity.annotationCreatedAt,
          annotationUpdatedAt: identity.annotationUpdatedAt,
        }],
      },
    })).toBe(false);
    expect(isLocalBridgeSnapshot({
      ...snapshot,
      capture: {
        ...capture,
        targets: [{
          ...capture.targets[0],
          annotationId: "annotation-save",
          annotationIdScope: "capture_session",
          annotationCreatedAt: "not-a-date",
          annotationUpdatedAt: identity.annotationUpdatedAt,
        }],
      },
    })).toBe(false);
    expect(isLocalBridgeSnapshot({
      ...snapshot,
      attachmentCount: 2,
      capture: {
        ...capture,
        targets: [
          { ...capture.targets[0], ...identity },
          {
            ...capture.targets[0],
            targetId: "target_B",
            attachmentId: "att_other",
            attachment: { ...attachment, id: "att_other" },
            annotationId: identity.annotationId,
          },
        ],
      },
    })).toBe(false);
    expect(isLocalBridgeSnapshot({
      ...snapshot,
      attachmentCount: 2,
      capture: {
        ...capture,
        targets: [
          { ...capture.targets[0], ...identity },
          {
            ...capture.targets[0],
            targetId: "target_B",
            attachmentId: "att_other",
            attachment: { ...attachment, id: "att_other" },
            annotationId: null,
            annotationIdScope: "unknown",
            annotationCreatedAt: null,
            annotationUpdatedAt: null,
          },
        ],
      },
    })).toBe(false);
    expect(isLocalBridgeSnapshot({
      ...snapshot,
      capture: {
        ...capture,
        targets: [{
          ...capture.targets[0],
          annotationId: null,
          annotationIdScope: "unknown",
          annotationCreatedAt: null,
          annotationUpdatedAt: null,
        }],
      },
    })).toBe(true);
  });

  test("accepts exact lifecycle-v1 captures and rejects marker, identity, shape, time, and mode drift", () => {
    const identity = {
      annotationId: "annotation-save",
      annotationIdScope: "capture_session" as const,
      annotationCreatedAt: "2026-07-17T04:29:55.000Z",
      annotationUpdatedAt: "2026-07-17T04:29:57.000Z",
    };
    const resolvedLifecycle = {
      state: "resolved" as const,
      resolvedAt: "2026-07-17T04:29:56.000Z",
    };
    const lifecycleCapture = {
      ...capture,
      annotationLifecycleVersion: "v1" as const,
      targets: [{
        ...capture.targets[0],
        ...identity,
        annotationLifecycle: resolvedLifecycle,
      }],
    };
    const withTarget = (target: Record<string, unknown>) => ({
      ...snapshot,
      capture: { ...lifecycleCapture, targets: [target] },
    });

    expect(isLocalBridgeSnapshot({ ...snapshot, capture: lifecycleCapture })).toBe(true);
    expect(isLocalBridgeSnapshot(withTarget({
      ...lifecycleCapture.targets[0],
      annotationLifecycle: { state: "open", resolvedAt: null },
    }))).toBe(true);
    expect(isLocalBridgeSnapshot({
      ...snapshot,
      capture: {
        ...capture,
        targets: [{
          ...capture.targets[0],
          ...identity,
          annotationLifecycle: resolvedLifecycle,
        }],
      },
    })).toBe(false);

    for (const annotationLifecycleVersion of [undefined, null, "v2"]) {
      expect(isLocalBridgeSnapshot({
        ...snapshot,
        capture: { ...lifecycleCapture, annotationLifecycleVersion },
      })).toBe(false);
    }
    expect(isLocalBridgeSnapshot({
      ...snapshot,
      capture: { ...lifecycleCapture, lifecyclePolicy: "unknown" },
    })).toBe(false);

    const malformedLifecycles: unknown[] = [
      undefined,
      null,
      {},
      { state: "open" },
      { resolvedAt: null },
      { state: "open", resolvedAt: null, extra: true },
      { state: "unknown", resolvedAt: null },
      { state: "open", resolvedAt: resolvedLifecycle.resolvedAt },
      { state: "resolved", resolvedAt: null },
      { state: "resolved", resolvedAt: "not-a-date" },
      { state: "resolved", resolvedAt: "+010000-01-01T00:00:00.000Z" },
    ];
    for (const annotationLifecycle of malformedLifecycles) {
      expect(isLocalBridgeSnapshot(withTarget({
        ...lifecycleCapture.targets[0],
        annotationLifecycle,
      }))).toBe(false);
    }

    expect(isLocalBridgeSnapshot(withTarget({
      ...capture.targets[0],
      annotationLifecycle: resolvedLifecycle,
    }))).toBe(false);
    expect(isLocalBridgeSnapshot(withTarget({
      ...capture.targets[0],
      annotationId: null,
      annotationIdScope: "unknown",
      annotationCreatedAt: null,
      annotationUpdatedAt: null,
      annotationLifecycle: resolvedLifecycle,
    }))).toBe(false);
    expect(isLocalBridgeSnapshot(withTarget({
      ...lifecycleCapture.targets[0],
      annotationCreatedAt: "2026-07-17T04:29:56.500Z",
    }))).toBe(false);
    expect(isLocalBridgeSnapshot(withTarget({
      ...lifecycleCapture.targets[0],
      annotationUpdatedAt: "2026-07-17T04:29:55.500Z",
    }))).toBe(false);

    const secondAttachment = { ...attachment, id: "att_cancel" };
    expect(isLocalBridgeSnapshot({
      ...snapshot,
      attachmentCount: 2,
      capture: {
        ...lifecycleCapture,
        targets: [
          lifecycleCapture.targets[0],
          {
            ...capture.targets[0],
            targetId: "target_B",
            attachmentId: secondAttachment.id,
            annotationId: "annotation-cancel",
            annotationIdScope: "capture_session",
            annotationCreatedAt: identity.annotationCreatedAt,
            annotationUpdatedAt: identity.annotationUpdatedAt,
            attachment: secondAttachment,
          },
        ],
      },
    })).toBe(false);

    const extendedYearCapture = {
      ...lifecycleCapture,
      updatedAt: "+010000-01-01T00:00:03.000Z",
      targets: [{
        ...lifecycleCapture.targets[0],
        annotationCreatedAt: "+010000-01-01T00:00:00.000Z",
        annotationUpdatedAt: "+010000-01-01T00:00:02.000Z",
        annotationLifecycle: {
          state: "resolved" as const,
          resolvedAt: "+010000-01-01T00:00:01.000Z",
        },
      }],
    };
    expect(isLocalBridgeSnapshot({ ...snapshot, capture: extendedYearCapture })).toBe(false);
  });

  test("treats the complete snapshot graph as data-only and remains total for hostile proxies", () => {
    const lifecycleCapture = {
      ...capture,
      annotationLifecycleVersion: "v1" as const,
      targets: [{
        ...capture.targets[0],
        annotationId: "annotation-save",
        annotationIdScope: "capture_session" as const,
        annotationCreatedAt: "2026-07-17T04:29:55.000Z",
        annotationUpdatedAt: "2026-07-17T04:29:57.000Z",
        annotationLifecycle: {
          state: "resolved" as const,
          resolvedAt: "2026-07-17T04:29:56.000Z",
        },
      }],
    };
    const valid = { ...snapshot, capture: lifecycleCapture };

    const accessorCases: Array<{
      value: Record<string, unknown>;
      calls: () => number;
    }> = [];
    {
      let calls = 0;
      const value = { ...valid } as Record<string, unknown>;
      Object.defineProperty(value, "sequence", {
        enumerable: true,
        get() {
          calls += 1;
          return snapshot.sequence;
        },
      });
      accessorCases.push({ value, calls: () => calls });
    }
    {
      let calls = 0;
      const captureWithGetter = { ...lifecycleCapture } as Record<string, unknown>;
      Object.defineProperty(captureWithGetter, "annotationLifecycleVersion", {
        enumerable: true,
        get() {
          calls += 1;
          return "v1";
        },
      });
      accessorCases.push({ value: { ...valid, capture: captureWithGetter }, calls: () => calls });
    }
    {
      let calls = 0;
      const targetWithGetter = { ...lifecycleCapture.targets[0] } as Record<string, unknown>;
      Object.defineProperty(targetWithGetter, "annotationLifecycle", {
        enumerable: true,
        get() {
          calls += 1;
          return lifecycleCapture.targets[0].annotationLifecycle;
        },
      });
      accessorCases.push({
        value: {
          ...valid,
          capture: { ...lifecycleCapture, targets: [targetWithGetter] },
        },
        calls: () => calls,
      });
    }
    {
      let calls = 0;
      const lifecycleWithGetter = { resolvedAt: "2026-07-17T04:29:56.000Z" } as Record<string, unknown>;
      Object.defineProperty(lifecycleWithGetter, "state", {
        enumerable: true,
        get() {
          calls += 1;
          return "resolved";
        },
      });
      accessorCases.push({
        value: {
          ...valid,
          capture: {
            ...lifecycleCapture,
            targets: [{
              ...lifecycleCapture.targets[0],
              annotationLifecycle: lifecycleWithGetter,
            }],
          },
        },
        calls: () => calls,
      });
    }
    for (const accessorCase of accessorCases) {
      expect(() => isLocalBridgeSnapshot(accessorCase.value)).not.toThrow();
      expect(isLocalBridgeSnapshot(accessorCase.value)).toBe(false);
      expect(accessorCase.calls()).toBe(0);
    }

    const withSymbol = (value: object) => {
      Object.defineProperty(value, Symbol("unexpected"), { value: true, enumerable: true });
      return value;
    };
    expect(isLocalBridgeSnapshot(withSymbol({ ...valid }))).toBe(false);
    expect(isLocalBridgeSnapshot({
      ...valid,
      capture: withSymbol({ ...lifecycleCapture }),
    })).toBe(false);
    expect(isLocalBridgeSnapshot({
      ...valid,
      capture: {
        ...lifecycleCapture,
        targets: [withSymbol({ ...lifecycleCapture.targets[0] })],
      },
    })).toBe(false);
    expect(isLocalBridgeSnapshot({
      ...valid,
      capture: {
        ...lifecycleCapture,
        targets: [{
          ...lifecycleCapture.targets[0],
          annotationLifecycle: withSymbol({
            ...lifecycleCapture.targets[0].annotationLifecycle,
          }),
        }],
      },
    })).toBe(false);

    const throwingProxy = (trap: "ownKeys" | "getOwnPropertyDescriptor" | "get") => new Proxy(
      valid,
      {
        [trap]() {
          throw new Error(`hostile-${trap}`);
        },
      },
    );
    for (const trap of ["ownKeys", "getOwnPropertyDescriptor", "get"] as const) {
      const hostile = throwingProxy(trap);
      expect(() => isLocalBridgeSnapshot(hostile)).not.toThrow();
      expect(isLocalBridgeSnapshot(hostile)).toBe(false);
    }

    const transparentProxy = <T extends object>(
      value: T,
      trap: "ownKeys" | "getOwnPropertyDescriptor" | "get",
      onTrap: () => void,
    ): T => {
      if (trap === "ownKeys") {
        return new Proxy(value, {
          ownKeys(target) {
            onTrap();
            return Reflect.ownKeys(target);
          },
        });
      }
      if (trap === "getOwnPropertyDescriptor") {
        return new Proxy(value, {
          getOwnPropertyDescriptor(target, key) {
            onTrap();
            return Reflect.getOwnPropertyDescriptor(target, key);
          },
        });
      }
      return new Proxy(value, {
        get(target, key, receiver) {
          onTrap();
          return Reflect.get(target, key, receiver);
        },
      });
    };
    const atLayer = (
      layer: "root" | "capture" | "target" | "lifecycle",
      trap: "ownKeys" | "getOwnPropertyDescriptor" | "get",
      onTrap: () => void,
    ): unknown => {
      const candidate = structuredClone(valid);
      if (layer === "root") return transparentProxy(candidate, trap, onTrap);
      if (layer === "capture") {
        candidate.capture = transparentProxy(candidate.capture, trap, onTrap);
        return candidate;
      }
      if (layer === "target") {
        candidate.capture.targets[0] = transparentProxy(
          candidate.capture.targets[0],
          trap,
          onTrap,
        );
        return candidate;
      }
      candidate.capture.targets[0].annotationLifecycle = transparentProxy(
        candidate.capture.targets[0].annotationLifecycle,
        trap,
        onTrap,
      );
      return candidate;
    };
    for (const layer of ["root", "capture", "target", "lifecycle"] as const) {
      for (const trap of ["ownKeys", "getOwnPropertyDescriptor", "get"] as const) {
        let trapCalls = 0;
        const hostile = atLayer(layer, trap, () => {
          trapCalls += 1;
        });
        let result: boolean | undefined;
        expect(() => {
          result = isLocalBridgeSnapshot(hostile);
        }).not.toThrow();
        expect(result, `${layer}:${trap}`).toBe(false);
        if (trap === "get") {
          expect(trapCalls, `${layer}:${trap}`).toBe(0);
        } else {
          expect(trapCalls, `${layer}:${trap}`).toBeGreaterThan(0);
        }
      }
    }
    const nestedHostile = {
      ...valid,
      capture: new Proxy(lifecycleCapture, {
        ownKeys() {
          throw new Error("hostile-nested-ownKeys");
        },
      }),
    };
    expect(() => isLocalBridgeSnapshot(nestedHostile)).not.toThrow();
    expect(isLocalBridgeSnapshot(nestedHostile)).toBe(false);
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
