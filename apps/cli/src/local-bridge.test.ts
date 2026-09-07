import { describe, expect, test } from "vitest";
import {
  MEANTHIS_CHROME_WEB_STORE_EXTENSION_ID,
  createLocalBridgeState,
  startLocalBridgeHttpServer,
} from "./local-bridge";
import {
  MEANTHIS_CHROME_WEB_STORE_ID,
} from "../../extension-mv3/scripts/extension-identity.mjs";
import { createAttachment } from "../../extension-mv3/test/session-fixtures";
import {
  createLocalBridgeAgentBodyRequestAuth,
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
const V2_ANNOTATION_IDENTITY = {
  annotationId: "annotation:save-v2",
  annotationIdScope: "capture_session" as const,
  annotationCreatedAt: "2026-07-11T10:00:00.000Z",
  annotationUpdatedAt: "2026-07-11T10:00:00.000Z",
};
const V3_ANNOTATION_LIFECYCLE = {
  state: "resolved" as const,
  resolvedAt: "2026-07-11T10:00:00.000Z",
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

function createReadAcknowledgement(
  instanceId: string,
  options: {
    captureId?: string;
    snapshotSequence?: number;
    detail?: "summary" | "agent_context" | "handoff";
    acknowledgementId?: string;
  } = {},
) {
  return {
    schemaVersion: "0.1.0" as const,
    kind: "ui-attach.local-bridge-read-acknowledgement" as const,
    acknowledgementId: options.acknowledgementId ?? "c8e59b7e-5b59-47e7-9b80-4cf92fbcf89d",
    status: "acknowledged_by_agent_client" as const,
    instanceId,
    captureId: options.captureId ?? "session-1",
    snapshotSequence: options.snapshotSequence ?? 1,
    detail: options.detail ?? "summary",
    acknowledgedAt: "2026-07-17T04:30:00.000Z",
    executionAuthority: {
      grantedByCapture: false as const,
      browserControl: false as const,
      liveDomMutation: false as const,
    },
    limitations: [
      "does_not_prove_model_attention",
      "does_not_prove_task_creation",
      "does_not_prove_downstream_execution",
    ] as const,
  };
}

function createAnnotatedSnapshot(sequence = 1) {
  const attachment = createAttachment("agent_safe");
  return {
    ...createSnapshot(sequence),
    page: {
      pageInstanceId: "chromium-tab:1199971128:frame:0",
      route: "https://app.example.test/settings",
    },
    capture: {
      captureId: "session-annotation",
      title: "Settings",
      origin: "https://app.example.test",
      updatedAt: "2026-07-11T10:00:00.000Z",
      authority: "capture_time" as const,
      disclosureMode: "agent_safe" as const,
      targets: [{
        targetId: "target_save",
        attachmentId: attachment.id,
        label: "Save changes",
        taskNote: "Update Save changes",
        ...V2_ANNOTATION_IDENTITY,
        attachment,
      }],
    },
  };
}

function createAcknowledgedBridgeState() {
  const state = createTestState();
  const paired = state.pair(EXTENSION_ORIGIN, {
    schemaVersion: "0.1.0",
    kind: "ui-attach.local-bridge-pair",
    pairingCode: "482-193",
    installationId: INSTALLATION_ID,
  });
  if (!paired.ok) throw new Error("Test bridge pairing failed.");
  const snapshot = createAnnotatedSnapshot(1);
  snapshot.capture.captureId = "session-1";
  if (!state.publish(EXTENSION_ORIGIN, paired.value.token, snapshot).ok) {
    throw new Error("Test bridge publish failed.");
  }
  const acknowledgement = createReadAcknowledgement(paired.value.instanceId);
  if (!state.acknowledgeCaptureRead(acknowledgement).ok) {
    throw new Error("Test bridge acknowledgement failed.");
  }
  return { acknowledgement, paired: paired.value, state };
}

function createLifecycleSnapshot(sequence = 1) {
  const legacy = createAnnotatedSnapshot(sequence);
  return {
    ...legacy,
    capture: {
      ...legacy.capture,
      annotationLifecycleVersion: "v1" as const,
      targets: legacy.capture.targets.map((target) => ({
        ...target,
        annotationLifecycle: V3_ANNOTATION_LIFECYCLE,
      })),
    },
  };
}

function createReplayDiagnosticsSnapshot(sequence = 1) {
  const snapshot = createLifecycleSnapshot(sequence);
  return {
    ...snapshot,
    capture: {
      ...snapshot.capture,
      metadataDiagnostics: {
        schemaVersion: "0.1.0" as const,
        kind: "ui-attach.metadata-only-diagnostics" as const,
        captureId: snapshot.capture.captureId,
        scope: "capture" as const,
        observedAt: snapshot.capture.updatedAt,
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

function readLifecycleContract(snapshot: unknown) {
  const value = snapshot as {
    capture?: {
      annotationLifecycleVersion?: unknown;
      targets?: Array<{ annotationLifecycle?: unknown }>;
    };
  };
  return {
    annotationLifecycleVersion: value.capture?.annotationLifecycleVersion,
    annotationLifecycle: value.capture?.targets?.[0]?.annotationLifecycle,
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

  test("preserves the last accepted replay diagnostics when a replacement is malformed", () => {
    const state = createTestState();
    const paired = state.pair(EXTENSION_ORIGIN, {
      schemaVersion: "0.1.0",
      kind: "ui-attach.local-bridge-pair",
      pairingCode: "482-193",
      installationId: INSTALLATION_ID,
    });
    expect(paired.ok).toBe(true);
    if (!paired.ok) return;
    const good = createReplayDiagnosticsSnapshot(1);
    expect(state.publish(EXTENSION_ORIGIN, paired.value.token, good)).toMatchObject({ ok: true });

    const malformedReplacements = [
      (() => {
        const malformed = createReplayDiagnosticsSnapshot(2);
        malformed.capture.metadataDiagnostics.captureId = "session-other";
        return malformed;
      })(),
      (() => {
        const malformed = createReplayDiagnosticsSnapshot(2) as any;
        malformed.capture.metadataDiagnostics.device = {
          status: "collected",
          deviceClass: "desktop",
          viewportClass: "large",
          touch: "none",
          viewportWidth: 1_920,
        };
        return malformed;
      })(),
      (() => {
        const malformed = createReplayDiagnosticsSnapshot(2);
        malformed.capture.metadataDiagnostics.replay = {
          status: "collected",
          attemptCount: 1,
          verifiedCount: 1,
          ambiguousCount: 1,
          missingCount: 1,
        };
        return malformed;
      })(),
    ];
    for (const malformed of malformedReplacements) {
      expect(state.publish(EXTENSION_ORIGIN, paired.value.token, malformed)).toEqual({
        ok: false,
        code: "INVALID_REQUEST",
      });
    }
    const readback = state.readInstance(paired.value.instanceId);
    expect(readback.ok).toBe(true);
    if (!readback.ok) return;
    expect(readback.value.snapshot?.sequence).toBe(1);
    expect(readback.value.snapshot?.capture?.metadataDiagnostics).toEqual(
      good.capture.metadataDiagnostics,
    );
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

  test("expires browser-created connection requests fail closed at the exact boundary", () => {
    let now = new Date("2026-07-17T04:30:00.000Z");
    const state = createTestState({ now: () => now });
    const request = createConnectionRequest();
    expect(state.createConnectionRequest(EXTENSION_ORIGIN, request).ok).toBe(true);
    now = new Date("2026-07-17T04:32:00.000Z");
    expect(state.approveConnectionRequest(request.requestId, APPROVAL_KEY)).toMatchObject({
      ok: false,
      code: "CONNECTION_INVITATION_EXPIRED",
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

  test("keeps an instance live without changing its shared snapshot", () => {
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

    now = new Date("2026-07-17T04:30:29.000Z");
    expect(state.heartbeat(EXTENSION_ORIGIN, paired.value.token)).toMatchObject({ ok: true });
    now = new Date("2026-07-17T04:30:45.000Z");
    expect(state.readInstance(paired.value.instanceId)).toMatchObject({
      ok: true,
      value: { snapshot: { sequence: 1, attachmentCount: 1 } },
    });
  });

  test("clears shared capture explicitly without disconnecting the instance", () => {
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

    expect(state.clearSharedCapture(EXTENSION_ORIGIN, paired.value.token)).toMatchObject({ ok: true });
    expect(state.readInstance(paired.value.instanceId)).toMatchObject({
      ok: true,
      value: { stale: false, snapshot: null },
    });
  });

  test("stores only the current acknowledgement, is idempotent per detail, and clears on replacement", () => {
    const state = createTestState();
    const paired = state.pair(EXTENSION_ORIGIN, {
      schemaVersion: "0.1.0",
      kind: "ui-attach.local-bridge-pair",
      pairingCode: "482-193",
      installationId: INSTALLATION_ID,
    });
    expect(paired.ok).toBe(true);
    if (!paired.ok) return;
    const initial = createAnnotatedSnapshot(1);
    initial.capture.captureId = "session-1";
    expect(state.publish(EXTENSION_ORIGIN, paired.value.token, initial)).toMatchObject({ ok: true });

    const summary = createReadAcknowledgement(paired.value.instanceId);
    const first = state.acknowledgeCaptureRead(summary);
    expect(first).toEqual({ ok: true, value: summary });
    const replay = state.acknowledgeCaptureRead({
      ...summary,
      acknowledgementId: "0c6c1f0a-1f0c-4b74-9bb1-1b24ac7f39e1",
    });
    expect(replay).toEqual(first);

    const agentContext = createReadAcknowledgement(paired.value.instanceId, {
      detail: "agent_context",
      acknowledgementId: "0c6c1f0a-1f0c-4b74-9bb1-1b24ac7f39e1",
    });
    expect(state.acknowledgeCaptureRead(agentContext)).toEqual({
      ok: true,
      value: agentContext,
    });
    expect(state.readCaptureReadAcknowledgement(EXTENSION_ORIGIN, paired.value.token)).toEqual({
      ok: true,
      value: agentContext,
    });

    const replacement = createAnnotatedSnapshot(2);
    replacement.capture.captureId = "session-1";
    expect(state.publish(EXTENSION_ORIGIN, paired.value.token, replacement)).toMatchObject({ ok: true });
    expect(state.readCaptureReadAcknowledgement(EXTENSION_ORIGIN, paired.value.token)).toEqual({
      ok: true,
      value: null,
    });
    expect(state.acknowledgeCaptureRead(agentContext)).toEqual({
      ok: false,
      code: "ACKNOWLEDGEMENT_MISMATCH",
    });
  });

  test("clears the read acknowledgement with an explicit shared-capture clear", () => {
    const { paired, state } = createAcknowledgedBridgeState();

    expect(state.clearSharedCapture(EXTENSION_ORIGIN, paired.token)).toMatchObject({ ok: true });
    expect(state.readCaptureReadAcknowledgement(EXTENSION_ORIGIN, paired.token)).toEqual({
      ok: true,
      value: null,
    });
  });

  test("removes the read acknowledgement when the browser instance disconnects", () => {
    const { paired, state } = createAcknowledgedBridgeState();

    expect(state.disconnect(EXTENSION_ORIGIN, paired.token)).toEqual({ ok: true, value: null });
    expect(state.readCaptureReadAcknowledgement(EXTENSION_ORIGIN, paired.token)).toEqual({
      ok: false,
      code: "AUTH_DENIED",
    });
    expect(state.readInstance(paired.instanceId)).toEqual({
      ok: false,
      code: "INSTANCE_NOT_FOUND",
    });
  });

  test("does not restore a read acknowledgement after owner-memory restart", () => {
    const beforeRestart = createAcknowledgedBridgeState();
    expect(beforeRestart.state.readCaptureReadAcknowledgement(
      EXTENSION_ORIGIN,
      beforeRestart.paired.token,
    )).toEqual({
      ok: true,
      value: beforeRestart.acknowledgement,
    });

    const restarted = createTestState();
    const paired = restarted.pair(EXTENSION_ORIGIN, {
      schemaVersion: "0.1.0",
      kind: "ui-attach.local-bridge-pair",
      pairingCode: "482-193",
      installationId: INSTALLATION_ID,
    });
    expect(paired.ok).toBe(true);
    if (!paired.ok) return;
    const snapshot = createAnnotatedSnapshot(1);
    snapshot.capture.captureId = "session-1";
    expect(restarted.publish(EXTENSION_ORIGIN, paired.value.token, snapshot)).toMatchObject({
      ok: true,
    });
    expect(restarted.readCaptureReadAcknowledgement(
      EXTENSION_ORIGIN,
      paired.value.token,
    )).toEqual({
      ok: true,
      value: null,
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
        structuredCapture: "v3",
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

      const heartbeat = await fetch(`${server.origin}/v1/heartbeat`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${paired.token}`,
          origin: EXTENSION_ORIGIN,
        },
      });
      expect(heartbeat.status).toBe(204);
      expect(activityCount).toBe(3);
      expect(state.readInstance(paired.instanceId)).toMatchObject({
        ok: true,
        value: { snapshot: { sequence: 1 } },
      });

      const cleared = await fetch(`${server.origin}/v1/shared-capture`, {
        method: "DELETE",
        headers: { authorization: `Bearer ${paired.token}` },
      });
      expect(cleared.status).toBe(204);
      expect(activityCount).toBe(4);
      expect(state.readInstance(paired.instanceId)).toMatchObject({
        ok: true,
        value: { snapshot: null },
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
      expect(activityCount).toBe(5);
    } finally {
      await server.close();
    }
  });

  test("preserves V2 annotation identity across HTTP PUT/readback and rejects malformed or stale replacements", async () => {
    const state = createTestState();
    const paired = state.pair(EXTENSION_ORIGIN, {
      schemaVersion: "0.1.0",
      kind: "ui-attach.local-bridge-pair",
      pairingCode: "482-193",
      installationId: INSTALLATION_ID,
    });
    expect(paired.ok).toBe(true);
    if (!paired.ok) return;
    const server = await startLocalBridgeHttpServer(state, { port: 0 });
    try {
      const good = createAnnotatedSnapshot(1);
      const put = await fetch(`${server.origin}/v1/snapshot`, {
        method: "PUT",
        headers: {
          authorization: `Bearer ${paired.value.token}`,
          "content-type": "application/json",
          origin: EXTENSION_ORIGIN,
        },
        body: JSON.stringify(good),
      });
      expect(put.status).toBe(204);
      const readAfterPut = state.readInstance(paired.value.instanceId);
      expect(readAfterPut.ok).toBe(true);
      if (!readAfterPut.ok || !readAfterPut.value.snapshot) return;
      expect(readAnnotationIdentity(readAfterPut.value.snapshot.capture?.targets[0]))
        .toEqual(V2_ANNOTATION_IDENTITY);

      const malformed = structuredClone(good);
      malformed.sequence = 2;
      delete (malformed.capture.targets[0] as unknown as Record<string, unknown>)
        .annotationUpdatedAt;
      const malformedResponse = await fetch(`${server.origin}/v1/snapshot`, {
        method: "PUT",
        headers: {
          authorization: `Bearer ${paired.value.token}`,
          "content-type": "application/json",
          origin: EXTENSION_ORIGIN,
        },
        body: JSON.stringify(malformed),
      });
      expect(malformedResponse.status).toBe(400);
      const readAfterMalformed = state.readInstance(paired.value.instanceId);
      expect(readAfterMalformed.ok).toBe(true);
      if (!readAfterMalformed.ok || !readAfterMalformed.value.snapshot) return;
      expect(readAnnotationIdentity(readAfterMalformed.value.snapshot.capture?.targets[0]))
        .toEqual(V2_ANNOTATION_IDENTITY);
      expect(readAfterMalformed.value.snapshot.sequence).toBe(1);

      const ownUndefined = structuredClone(good);
      ownUndefined.sequence = 2;
      (ownUndefined.capture.targets[0] as unknown as Record<string, unknown>)
        .annotationUpdatedAt = undefined;
      expect(state.publish(EXTENSION_ORIGIN, paired.value.token, ownUndefined)).toEqual({
        ok: false,
        code: "INVALID_REQUEST",
      });

      for (const sequence of [1, 0]) {
        const stale = createAnnotatedSnapshot(sequence);
        stale.capture.targets[0]!.annotationId = `annotation:stale-${sequence}`;
        const staleResponse = await fetch(`${server.origin}/v1/snapshot`, {
          method: "PUT",
          headers: {
            authorization: `Bearer ${paired.value.token}`,
            "content-type": "application/json",
            origin: EXTENSION_ORIGIN,
          },
          body: JSON.stringify(stale),
        });
        expect(staleResponse.status).toBe(409);
      }
      const finalRead = state.readInstance(paired.value.instanceId);
      expect(finalRead.ok).toBe(true);
      if (!finalRead.ok || !finalRead.value.snapshot) return;
      expect(finalRead.value.snapshot.sequence).toBe(1);
      expect(readAnnotationIdentity(finalRead.value.snapshot.capture?.targets[0]))
        .toEqual(V2_ANNOTATION_IDENTITY);
    } finally {
      await server.close();
    }
  });

  test("retains lifecycle-v1 through owner readback and preserves the prior snapshot on malformed or stale replacement", async () => {
    const state = createTestState();
    const paired = state.pair(EXTENSION_ORIGIN, {
      schemaVersion: "0.1.0",
      kind: "ui-attach.local-bridge-pair",
      pairingCode: "482-193",
      installationId: INSTALLATION_ID,
    });
    expect(paired.ok).toBe(true);
    if (!paired.ok) return;

    const initial = createLifecycleSnapshot(1);
    expect(state.publish(EXTENSION_ORIGIN, paired.value.token, initial)).toMatchObject({ ok: true });
    const readInitial = state.readInstance(paired.value.instanceId);
    expect(readInitial.ok).toBe(true);
    if (!readInitial.ok || !readInitial.value.snapshot) return;
    expect(readLifecycleContract(readInitial.value.snapshot)).toEqual({
      annotationLifecycleVersion: "v1",
      annotationLifecycle: V3_ANNOTATION_LIFECYCLE,
    });
    expect(readAnnotationIdentity(readInitial.value.snapshot.capture?.targets[0]))
      .toEqual(V2_ANNOTATION_IDENTITY);

    const malformed = createLifecycleSnapshot(2);
    delete (malformed.capture.targets[0] as unknown as Record<string, unknown>)
      .annotationLifecycle;
    expect(state.publish(EXTENSION_ORIGIN, paired.value.token, malformed)).toEqual({
      ok: false,
      code: "INVALID_REQUEST",
    });
    const afterMalformed = state.readInstance(paired.value.instanceId);
    expect(afterMalformed.ok).toBe(true);
    if (!afterMalformed.ok || !afterMalformed.value.snapshot) return;
    expect(afterMalformed.value.snapshot.sequence).toBe(1);
    expect(readLifecycleContract(afterMalformed.value.snapshot)).toEqual({
      annotationLifecycleVersion: "v1",
      annotationLifecycle: V3_ANNOTATION_LIFECYCLE,
    });

    expect(state.publish(
      EXTENSION_ORIGIN,
      paired.value.token,
      createLifecycleSnapshot(1),
    )).toEqual({ ok: false, code: "STALE_SNAPSHOT" });
    const afterStale = state.readInstance(paired.value.instanceId);
    expect(afterStale.ok).toBe(true);
    if (!afterStale.ok || !afterStale.value.snapshot) return;
    expect(afterStale.value.snapshot.sequence).toBe(1);
    expect(readLifecycleContract(afterStale.value.snapshot)).toEqual({
      annotationLifecycleVersion: "v1",
      annotationLifecycle: V3_ANNOTATION_LIFECYCLE,
    });

    const reopened = createLifecycleSnapshot(2);
    reopened.capture.targets[0]!.annotationLifecycle = { state: "open", resolvedAt: null };
    expect(state.publish(EXTENSION_ORIGIN, paired.value.token, reopened)).toMatchObject({ ok: true });
    const afterLifecycleOnlyChange = state.readInstance(paired.value.instanceId);
    expect(afterLifecycleOnlyChange.ok).toBe(true);
    if (!afterLifecycleOnlyChange.ok || !afterLifecycleOnlyChange.value.snapshot) return;
    expect(afterLifecycleOnlyChange.value.snapshot.sequence).toBe(2);
    expect(readLifecycleContract(afterLifecycleOnlyChange.value.snapshot)).toEqual({
      annotationLifecycleVersion: "v1",
      annotationLifecycle: { state: "open", resolvedAt: null },
    });
    expect(afterLifecycleOnlyChange.value.snapshot.agentCopy).toBe(initial.agentCopy);
  });

  test("rejects hostile publish inputs without invoking accessors or replacing the prior snapshot", () => {
    const state = createTestState();
    const paired = state.pair(EXTENSION_ORIGIN, {
      schemaVersion: "0.1.0",
      kind: "ui-attach.local-bridge-pair",
      pairingCode: "482-193",
      installationId: INSTALLATION_ID,
    });
    expect(paired.ok).toBe(true);
    if (!paired.ok) return;
    const initial = createLifecycleSnapshot(1);
    expect(state.publish(EXTENSION_ORIGIN, paired.value.token, initial)).toMatchObject({ ok: true });

    let getterCalls = 0;
    const accessor = createLifecycleSnapshot(2) as unknown as Record<string, unknown>;
    Object.defineProperty(accessor, "sequence", {
      enumerable: true,
      get() {
        getterCalls += 1;
        return 2;
      },
    });
    let accessorResult: ReturnType<typeof state.publish> | undefined;
    expect(() => {
      accessorResult = state.publish(EXTENSION_ORIGIN, paired.value.token, accessor);
    }).not.toThrow();
    expect(accessorResult).toEqual({
      ok: false,
      code: "INVALID_REQUEST",
    });
    expect(getterCalls).toBe(0);

    for (const trap of ["ownKeys", "getOwnPropertyDescriptor", "get"] as const) {
      const hostile = new Proxy(createLifecycleSnapshot(2), {
        [trap]() {
          throw new Error(`hostile-${trap}`);
        },
      });
      let hostileResult: ReturnType<typeof state.publish> | undefined;
      expect(() => {
        hostileResult = state.publish(EXTENSION_ORIGIN, paired.value.token, hostile);
      }).not.toThrow();
      expect(hostileResult).toEqual({
        ok: false,
        code: "INVALID_REQUEST",
      });
    }

    const beforeTransparent = state.readInstance(paired.value.instanceId);
    expect(beforeTransparent.ok).toBe(true);
    if (!beforeTransparent.ok || !beforeTransparent.value.snapshot) return;
    const beforeTransparentBytes = JSON.stringify(beforeTransparent.value.snapshot);
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
      const candidate = createLifecycleSnapshot(2);
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
        let hostileResult: ReturnType<typeof state.publish> | undefined;
        expect(() => {
          hostileResult = state.publish(EXTENSION_ORIGIN, paired.value.token, hostile);
        }).not.toThrow();
        expect(hostileResult, `${layer}:${trap}`).toEqual({
          ok: false,
          code: "INVALID_REQUEST",
        });
        if (trap === "get") {
          expect(trapCalls, `${layer}:${trap}`).toBe(0);
        } else {
          expect(trapCalls, `${layer}:${trap}`).toBeGreaterThan(0);
        }
      }
    }

    const read = state.readInstance(paired.value.instanceId);
    expect(read.ok).toBe(true);
    if (!read.ok || !read.value.snapshot) return;
    expect(read.value.snapshot.sequence).toBe(1);
    expect(JSON.stringify(read.value.snapshot)).toBe(beforeTransparentBytes);
    expect(readLifecycleContract(read.value.snapshot)).toEqual({
      annotationLifecycleVersion: "v1",
      annotationLifecycle: V3_ANNOTATION_LIFECYCLE,
    });
  });

  test("round-trips lifecycle-v1 over an ephemeral HTTP owner and preserves it after malformed or stale PUT", async () => {
    const state = createTestState();
    const paired = state.pair(EXTENSION_ORIGIN, {
      schemaVersion: "0.1.0",
      kind: "ui-attach.local-bridge-pair",
      pairingCode: "482-193",
      installationId: INSTALLATION_ID,
    });
    expect(paired.ok).toBe(true);
    if (!paired.ok) return;
    const server = await startLocalBridgeHttpServer(state, { port: 0 });
    const putSnapshot = (value: unknown) => fetch(`${server.origin}/v1/snapshot`, {
      method: "PUT",
      headers: {
        authorization: `Bearer ${paired.value.token}`,
        "content-type": "application/json",
        origin: EXTENSION_ORIGIN,
      },
      body: JSON.stringify(value),
    });
    try {
      expect((await putSnapshot(createLifecycleSnapshot(1))).status).toBe(204);
      const afterValid = state.readInstance(paired.value.instanceId);
      expect(afterValid.ok).toBe(true);
      if (!afterValid.ok || !afterValid.value.snapshot) return;
      expect(readLifecycleContract(afterValid.value.snapshot)).toEqual({
        annotationLifecycleVersion: "v1",
        annotationLifecycle: V3_ANNOTATION_LIFECYCLE,
      });

      const malformed = createLifecycleSnapshot(2);
      delete (malformed.capture.targets[0] as unknown as Record<string, unknown>)
        .annotationLifecycle;
      expect((await putSnapshot(malformed)).status).toBe(400);

      const stale = createLifecycleSnapshot(1);
      stale.capture.targets[0]!.annotationLifecycle = { state: "open", resolvedAt: null };
      expect((await putSnapshot(stale)).status).toBe(409);

      const afterRejected = state.readInstance(paired.value.instanceId);
      expect(afterRejected.ok).toBe(true);
      if (!afterRejected.ok || !afterRejected.value.snapshot) return;
      expect(afterRejected.value.snapshot.sequence).toBe(1);
      expect(readLifecycleContract(afterRejected.value.snapshot)).toEqual({
        annotationLifecycleVersion: "v1",
        annotationLifecycle: V3_ANNOTATION_LIFECYCLE,
      });
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

  test("exposes an extension read acknowledgement and accepts only authenticated current agent ACKs", async () => {
    const state = createTestState();
    const paired = state.pair(EXTENSION_ORIGIN, {
      schemaVersion: "0.1.0",
      kind: "ui-attach.local-bridge-pair",
      pairingCode: "482-193",
      installationId: INSTALLATION_ID,
    });
    expect(paired.ok).toBe(true);
    if (!paired.ok) return;
    const initial = createAnnotatedSnapshot(1);
    initial.capture.captureId = "session-1";
    expect(state.publish(EXTENSION_ORIGIN, paired.value.token, initial)).toMatchObject({ ok: true });
    const server = await startLocalBridgeHttpServer(state, {
      port: 0,
      agentToken: AGENT_TOKEN,
      ownerIdentity: OWNER_IDENTITY,
    });
    try {
      const path = "/v1/capture-read-acknowledgement";
      const before = await fetch(`${server.origin}${path}`, {
        headers: {
          authorization: `Bearer ${paired.value.token}`,
          origin: EXTENSION_ORIGIN,
        },
      });
      expect(before.status).toBe(200);
      expect(before.headers.get("access-control-allow-origin")).toBe(EXTENSION_ORIGIN);
      await expect(before.json()).resolves.toBeNull();

      // Chrome extension GET requests can omit Origin even though the same
      // extension's token remains the exact local capability. Match the
      // capabilities endpoint: resolve that token back to its bound extension
      // while continuing to reject any explicitly foreign Origin.
      const originlessBefore = await fetch(`${server.origin}${path}`, {
        headers: { authorization: `Bearer ${paired.value.token}` },
      });
      expect(originlessBefore.status).toBe(200);
      await expect(originlessBefore.json()).resolves.toBeNull();
      const foreignOrigin = await fetch(`${server.origin}${path}`, {
        headers: {
          authorization: `Bearer ${paired.value.token}`,
          origin: "https://foreign.example",
        },
      });
      expect(foreignOrigin.status).toBe(403);
      expect(foreignOrigin.headers.get("access-control-allow-origin")).toBeNull();
      const missingBearer = await fetch(`${server.origin}${path}`);
      expect(missingBearer.status).toBe(401);
      const wrongBearer = await fetch(`${server.origin}${path}`, {
        headers: { authorization: `Bearer ${"x".repeat(43)}` },
      });
      expect(wrongBearer.status).toBe(401);

      const acknowledgement = createReadAcknowledgement(paired.value.instanceId);
      const post = await agentBodyFetch(
        server.origin,
        "/v1/agent/capture-read-acknowledgement",
        acknowledgement,
      );
      expect(post.status).toBe(200);
      await expect(post.json()).resolves.toEqual(acknowledgement);

      const after = await fetch(`${server.origin}${path}`, {
        headers: {
          authorization: `Bearer ${paired.value.token}`,
          origin: EXTENSION_ORIGIN,
        },
      });
      expect(after.status).toBe(200);
      await expect(after.json()).resolves.toEqual(acknowledgement);

      const malformed = { ...acknowledgement, extra: true };
      const rejected = await agentBodyFetch(
        server.origin,
        "/v1/agent/capture-read-acknowledgement",
        malformed,
      );
      expect(rejected.status).toBe(400);
      const retained = await fetch(`${server.origin}${path}`, {
        headers: {
          authorization: `Bearer ${paired.value.token}`,
          origin: EXTENSION_ORIGIN,
        },
      });
      await expect(retained.json()).resolves.toEqual(acknowledgement);

      const replacement = createAnnotatedSnapshot(2);
      replacement.capture.captureId = "session-1";
      expect(state.publish(EXTENSION_ORIGIN, paired.value.token, replacement)).toMatchObject({ ok: true });
      const stale = await agentBodyFetch(
        server.origin,
        "/v1/agent/capture-read-acknowledgement",
        acknowledgement,
      );
      expect(stale.status).toBe(409);
      const afterReplacement = await fetch(`${server.origin}${path}`, {
        headers: {
          authorization: `Bearer ${paired.value.token}`,
          origin: EXTENSION_ORIGIN,
        },
      });
      await expect(afterReplacement.json()).resolves.toBeNull();
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

function agentBodyFetch(origin: string, path: string, value: unknown) {
  const body = Buffer.from(JSON.stringify(value), "utf8");
  const auth = createLocalBridgeAgentBodyRequestAuth(AGENT_TOKEN, path, body, { method: "POST" });
  return fetch(`${origin}${path}`, {
    method: "POST",
    headers: { ...auth.headers, "content-type": "application/json" },
    body,
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
