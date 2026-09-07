import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { ListRootsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import {
  createSourceContentHash,
  createSourceMapSidecar,
} from "@meanthis/source-map-core";
import {
  isLocalBridgeMcpReadReceipt,
  type LocalBridgeCaptureV1,
} from "@meanthis/schema";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, test, vi } from "vitest";
import {
  MEANTHIS_CHROME_WEB_STORE_EXTENSION_ID,
  createLocalBridgeState,
} from "./local-bridge";
import { startLocalBridgeHttpServer } from "./local-bridge";
import {
  approveHttpLocalBridgeConnectionRequest,
  connectLocalBridgeMcpSurface,
  createHttpLocalBridgeReader,
  createLocalBridgeMcpServer,
  LocalBridgeConnectionInvitationExpiredError,
  listSharedCaptures,
  readSharedCapture,
  startLocalBridgeOwnerLease,
  type SharedCaptureSourceResolver,
  waitForSharedCaptureChange,
} from "./local-bridge-mcp";
import {
  RESPONSE_PROOF_HEADER,
  createLocalBridgeAgentResponseProof,
  verifyLocalBridgeAgentRequestAuth,
} from "./local-bridge-agent-auth";
import { AuthenticatedLocalBridgeOwnerIdentityMismatchError } from "./local-bridge-owner";

const EXTENSION_ORIGIN = `chrome-extension://${MEANTHIS_CHROME_WEB_STORE_EXTENSION_ID}`;
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
  annotationId: "annotation-save-v2",
  annotationIdScope: "capture_session" as const,
  annotationCreatedAt: "2026-07-17T04:29:57.000Z",
  annotationUpdatedAt: "2026-07-17T04:29:58.000Z",
};

function createCapture(): LocalBridgeCaptureV1 {
  return {
    captureId: "session-1",
    title: "Settings review",
    origin: "https://example.test",
    updatedAt: "2026-07-17T04:29:58.000Z",
    authority: "capture_time",
    disclosureMode: "agent_safe",
    targets: [{
      targetId: "target_A",
      attachmentId: "att_save",
      label: "A",
      taskNote: "Shorten the label.",
      annotationId: null,
      annotationIdScope: "unknown",
      annotationCreatedAt: null,
      annotationUpdatedAt: null,
      attachment: {
        schemaVersion: "0.3.0",
        id: "att_save",
        capturedAt: "2026-07-17T04:29:58.000Z",
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
          position: "relative",
          padding: "6px 8px",
          gap: "10px",
          fontSize: "14px",
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
      },
    }],
  };
}

function createCaptureInstanceView(sequence: number) {
  return {
    instanceId: "instance-0123456789ab",
    extensionId: MEANTHIS_CHROME_WEB_STORE_EXTENSION_ID,
    connectedAt: "2026-07-17T04:29:00.000Z",
    lastSeenAt: "2026-07-17T04:30:00.000Z",
    stale: false,
    snapshot: {
      schemaVersion: "0.1.0" as const,
      kind: "ui-attach.local-bridge-snapshot" as const,
      sequence,
      publishedAt: "2026-07-17T04:30:00.000Z",
      page: {
        pageInstanceId: "chromium-tab:7:frame:0",
        route: "https://example.test/settings",
      },
      attachmentCount: 1,
      agentCopy: null,
      capture: createCapture(),
    },
  };
}

describe("local agent bridge MCP read surface", () => {
  test("connects the MCP surface before best-effort bridge owner startup", async () => {
    const events: string[] = [];

    await expect(connectLocalBridgeMcpSurface({
      connect: async () => { events.push("connected"); },
      onReady: () => { events.push("ready"); },
      ensureOwner: async () => {
        events.push("owner-start");
        throw new Error("owner unavailable");
      },
      onOwnerUnavailable: () => { events.push("owner-unavailable"); },
    })).resolves.toBeUndefined();

    expect(events).toEqual([
      "connected",
      "ready",
      "owner-start",
      "owner-unavailable",
    ]);
  });

  test("normalizes old-wire and explicit legacy identity across every read detail", async () => {
    const details = [
      "summary",
      "content",
      "task",
      "agent_context",
      "locator",
      "visual",
      "context",
    ] as const;
    const readIdentity = async (
      capture: LocalBridgeCaptureV1,
      detail: (typeof details)[number] | "handoff",
    ) => {
      const instance = createCaptureInstanceView(1);
      instance.snapshot.agentCopy = "Agent-safe handoff.";
      instance.snapshot.capture = capture;
      const result = await readSharedCapture({
        getStatus: () => { throw new Error("unused"); },
        listInstances: () => [],
        readInstance: async () => ({ ok: true as const, value: instance }),
      }, {
        instanceId: instance.instanceId,
        captureId: "session-1",
        expectedSequence: 1,
        detail,
        ...(detail === "handoff" ? {} : { targetIds: ["target_A"] }),
      });
      const parsed = JSON.parse(readText(result));
      return parsed.capture.targets[0]?.annotationIdentity;
    };

    const oldCapture = createCapture();
    const oldTarget = oldCapture.targets[0]! as unknown as Record<string, unknown>;
    delete oldTarget.annotationId;
    delete oldTarget.annotationIdScope;
    delete oldTarget.annotationCreatedAt;
    delete oldTarget.annotationUpdatedAt;
    const explicitLegacy = createCapture();
    const expectedLegacy = {
      annotationId: null,
      annotationIdScope: "unknown",
      createdAt: null,
      updatedAt: null,
    };
    for (const capture of [oldCapture, explicitLegacy]) {
      const identities = await Promise.all([
        ...details.map((detail) => readIdentity(capture, detail)),
        readIdentity(capture, "handoff"),
      ]);
      expect(identities).toEqual(identities.map(() => expectedLegacy));
    }
  });

  test("carries canonical annotation identity byte-for-byte through every read detail and handoff", async () => {
    const capture = createCapture();
    Object.assign(capture.targets[0]!, {
      annotationId: "annotation-save",
      annotationIdScope: "capture_session",
      annotationCreatedAt: "2026-07-17T04:29:57.000Z",
      annotationUpdatedAt: "2026-07-17T04:29:58.000Z",
    });
    const details = [
      "summary",
      "content",
      "task",
      "agent_context",
      "locator",
      "visual",
      "context",
      "handoff",
    ] as const;
    const identities = [];
    for (const detail of details) {
      const instance = createCaptureInstanceView(1);
      instance.snapshot.agentCopy = "Agent-safe handoff.";
      instance.snapshot.capture = capture;
      const result = await readSharedCapture({
        getStatus: () => { throw new Error("unused"); },
        listInstances: () => [],
        readInstance: async () => ({ ok: true as const, value: instance }),
      }, {
        instanceId: instance.instanceId,
        captureId: "session-1",
        expectedSequence: 1,
        detail,
        ...(detail === "handoff" ? {} : { targetIds: ["target_A"] }),
      });
      const parsed = JSON.parse(readText(result));
      identities.push(parsed.capture.targets[0]?.annotationIdentity);
    }
    expect(identities).toEqual(identities.map(() => ({
      annotationId: "annotation-save",
      annotationIdScope: "capture_session",
      createdAt: "2026-07-17T04:29:57.000Z",
      updatedAt: "2026-07-17T04:29:58.000Z",
    })));
  });

  test("returns an opt-in MCP read receipt bound to the exact handoff bytes", async () => {
    const instance = createCaptureInstanceView(7);
    const handoff = "Agent-safe handoff.\r\nKeep these exact UTF-8 bytes: 猫.";
    instance.snapshot.agentCopy = handoff;
    const reader = {
      getStatus: () => { throw new Error("unused"); },
      listInstances: () => [{ instanceId: instance.instanceId, stale: false }],
      readInstance: vi.fn(async () => ({ ok: true as const, value: instance })),
    };
    const input = {
      instanceId: instance.instanceId,
      captureId: "session-1",
      expectedSequence: 7,
      detail: "handoff" as const,
      includeReadReceipt: true,
    };

    const response = JSON.parse(readText(await readSharedCapture(reader, input, {
      now: () => new Date("2026-09-02T14:00:00.000Z"),
      randomUUID: () => "cf9507f2-20c5-48aa-91f2-d3372c4bb42a",
    })));
    expect(response.capture.handoff).toBe(handoff);
    expect(response.readReceipt).toEqual({
      schemaVersion: "0.1.0",
      kind: "ui-attach.mcp-read-receipt",
      receiptId: "cf9507f2-20c5-48aa-91f2-d3372c4bb42a",
      status: "returned_to_mcp_client",
      instanceId: instance.instanceId,
      captureId: "session-1",
      snapshotSequence: 7,
      detail: "handoff",
      handoffDigest: `sha256:${createHash("sha256").update(handoff, "utf8").digest("hex")}`,
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
    });
    expect(isLocalBridgeMcpReadReceipt(response.readReceipt)).toBe(true);
    expect(response.readReceipt).not.toHaveProperty("handoff");

    const withoutReceipt = JSON.parse(readText(await readSharedCapture(reader, {
      ...input,
      includeReadReceipt: false,
    })));
    expect(withoutReceipt).not.toHaveProperty("readReceipt");

    const wrongDetailCalls = reader.readInstance.mock.calls.length;
    const wrongDetail = await readSharedCapture(reader, {
      ...input,
      detail: "summary",
    });
    expect(wrongDetail.isError).toBe(true);
    expect(JSON.parse(readText(wrongDetail))).toMatchObject({
      error: { code: "INVALID_REQUEST" },
    });
    expect(reader.readInstance).toHaveBeenCalledTimes(wrongDetailCalls);

    const changed = await readSharedCapture(reader, {
      ...input,
      expectedSequence: 6,
    });
    expect(changed.isError).toBe(true);
    expect(readText(changed)).not.toContain("mcp-read-receipt");

    const invalidClock = await readSharedCapture(reader, input, {
      now: () => new Date(Number.NaN),
      randomUUID: () => "cf9507f2-20c5-48aa-91f2-d3372c4bb42a",
    });
    expect(invalidClock.isError).toBe(true);
    expect(JSON.parse(readText(invalidClock))).toMatchObject({
      error: { code: "READ_RECEIPT_UNAVAILABLE" },
    });
    expect(readText(invalidClock)).not.toContain(handoff);
  });

  test("submits read acknowledgements through the authenticated HTTP reader", async () => {
    const state = createLocalBridgeState({
      now: () => new Date("2026-07-17T04:30:00.000Z"),
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
    const snapshot = {
      schemaVersion: "0.1.0" as const,
      kind: "ui-attach.local-bridge-snapshot" as const,
      sequence: 1,
      publishedAt: "2026-07-17T04:30:00.000Z",
      page: { pageInstanceId: "chromium-tab:7:frame:0", route: "https://example.test/settings" },
      attachmentCount: 1,
      agentCopy: "Agent-safe handoff.",
      capture: createCapture(),
    };
    expect(state.publish(EXTENSION_ORIGIN, paired.value.token, snapshot)).toMatchObject({ ok: true });
    const http = await startLocalBridgeHttpServer(state, {
      port: 0,
      agentToken: AGENT_TOKEN,
      ownerIdentity: OWNER_IDENTITY,
    });
    const reader = createHttpLocalBridgeReader(http.origin, AGENT_TOKEN, {
      expectedOwnerIdentity: OWNER_IDENTITY,
    });
    const acknowledgement = {
      schemaVersion: "0.1.0" as const,
      kind: "ui-attach.local-bridge-read-acknowledgement" as const,
      acknowledgementId: "c8e59b7e-5b59-47e7-9b80-4cf92fbcf89d",
      status: "acknowledged_by_agent_client" as const,
      instanceId: paired.value.instanceId,
      captureId: "session-1",
      snapshotSequence: 1,
      detail: "agent_context" as const,
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
    try {
      await expect(reader.acknowledgeCaptureRead?.(acknowledgement)).resolves.toEqual({
        ok: true,
        value: acknowledgement,
      });
      await expect(reader.acknowledgeCaptureRead?.({
        ...acknowledgement,
        snapshotSequence: 2,
      })).resolves.toEqual({
        ok: false,
        code: "ACKNOWLEDGEMENT_MISMATCH",
      });
    } finally {
      await http.close();
    }
  });

  test("rejects malformed direct capture reads before reader I/O without invoking accessors", async () => {
    const reader = {
      getStatus: () => { throw new Error("unused"); },
      listInstances: () => [],
      readInstance: vi.fn(async () => { throw new Error("must not run"); }),
    };
    const valid = {
      instanceId: "instance-0123456789ab",
      captureId: "session-1",
      expectedSequence: 1,
      detail: "handoff",
      includeReadReceipt: true,
    };
    let getterCalls = 0;
    const topLevelAccessor = { ...valid } as Record<string, unknown>;
    Object.defineProperty(topLevelAccessor, "captureId", {
      enumerable: true,
      get() {
        getterCalls += 1;
        return "session-1";
      },
    });
    const targetIdsAccessor = ["target_A"];
    Object.defineProperty(targetIdsAccessor, "0", {
      enumerable: true,
      get() {
        getterCalls += 1;
        return "target_A";
      },
    });
    const symbolKey = { ...valid };
    Object.defineProperty(symbolKey, Symbol("unexpected"), {
      enumerable: true,
      value: true,
    });
    const nullPrototypeTargetIds = ["target_A"];
    Object.setPrototypeOf(nullPrototypeTargetIds, null);
    const customPrototypeAttachmentIds = ["att_A"];
    Object.setPrototypeOf(customPrototypeAttachmentIds, { unexpected: true });
    const malformed: unknown[] = [
      null,
      {},
      { ...valid, includeReadReceipt: undefined },
      { ...valid, instanceId: "instance-current" },
      { ...valid, captureId: "x".repeat(129) },
      { ...valid, expectedSequence: Number.MAX_SAFE_INTEGER + 1 },
      { ...valid, detail: "everything" },
      { ...valid, includeReadReceipt: "yes" },
      { ...valid, targetIds: Array.from({ length: 27 }, (_, index) => `target_${index}`) },
      { ...valid, targetIds: [`target_${"x".repeat(65)}`] },
      { ...valid, targetIds: ["target_A"], attachmentIds: ["att_A"] },
      { ...valid, unexpected: true },
      { ...valid, targetIds: targetIdsAccessor },
      { ...valid, targetIds: nullPrototypeTargetIds },
      { ...valid, attachmentIds: customPrototypeAttachmentIds },
      topLevelAccessor,
      symbolKey,
    ];

    for (const input of malformed) {
      const result = await readSharedCapture(reader, input);
      expect(result.isError).toBe(true);
      const text = readText(result);
      expect(JSON.parse(text)).toMatchObject({ error: { code: "INVALID_REQUEST" } });
      expect(text).not.toContain("handoff");
      expect(text).not.toContain("mcp-read-receipt");
    }
    expect(reader.readInstance).not.toHaveBeenCalled();
    expect(getterCalls).toBe(0);
  });

  test("exposes the receipt option through the actual MCP tool schema", async () => {
    const instance = createCaptureInstanceView(9);
    instance.snapshot.agentCopy = "Exact Agent-safe handoff.";
    const reader = {
      getStatus: () => { throw new Error("unused"); },
      listInstances: () => [{ instanceId: instance.instanceId, stale: false }],
      readInstance: vi.fn(async () => ({ ok: true as const, value: instance })),
    };
    const server = createLocalBridgeMcpServer(reader, {
      captureReadReceipt: {
        now: () => new Date("2026-09-02T14:05:00.000Z"),
        randomUUID: () => "6e9c0bc6-c1d2-4783-bae8-aa3623f77c88",
      },
    });
    const client = new Client({ name: "meanthis-read-receipt-test", version: "0.1.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    try {
      const result = await client.callTool({
        name: "meanthis_read_capture",
        arguments: {
          instanceId: instance.instanceId,
          captureId: "session-1",
          expectedSequence: 9,
          detail: "handoff",
          includeReadReceipt: true,
        },
      });
      expect(result.isError).not.toBe(true);
      expect(JSON.parse(readText(result))).toMatchObject({
        detail: "handoff",
        readReceipt: {
          receiptId: "6e9c0bc6-c1d2-4783-bae8-aa3623f77c88",
          status: "returned_to_mcp_client",
          snapshotSequence: 9,
        },
      });

      const callsBeforeRejectedInput = reader.readInstance.mock.calls.length;
      const rejected = await client.callTool({
        name: "meanthis_read_capture",
        arguments: {
          instanceId: instance.instanceId,
          captureId: "session-1",
          expectedSequence: 9,
          detail: "summary",
          includeReadReceipt: true,
        },
      });
      expect(rejected.isError).toBe(true);
      expect(reader.readInstance).toHaveBeenCalledTimes(callsBeforeRejectedInput);
    } finally {
      await client.close();
      await server.close();
    }
  });

  test("projects V3 lifecycle only through discovery marker and structured capture reads", async () => {
    const capture = createCapture();
    const lifecycle = { state: "resolved" as const, resolvedAt: "2026-07-17T04:29:58.000Z" };
    capture.annotationLifecycleVersion = "v1";
    Object.assign(capture.targets[0]!, V2_ANNOTATION_IDENTITY, { annotationLifecycle: lifecycle });
    const instance = createCaptureInstanceView(1);
    const handoff = "Agent-safe handoff.\r\nKeep these bytes unchanged.";
    instance.snapshot.agentCopy = handoff;
    instance.snapshot.capture = capture;
    const reader = {
      getStatus: () => { throw new Error("unused"); },
      listInstances: () => [{ instanceId: instance.instanceId, stale: false }],
      readInstance: async () => ({ ok: true as const, value: instance }),
    };

    const listed = await listSharedCaptures(reader);
    expect(listed).toMatchObject({
      captures: [{
        instanceId: instance.instanceId,
        captureId: "session-1",
        annotationLifecycleVersion: "v1",
        snapshot: { sequence: 1 },
      }],
    });
    const discovery = (listed as { captures: Array<Record<string, unknown>> }).captures[0]!;
    expect(discovery).not.toHaveProperty("targets");
    expect(discovery).not.toHaveProperty("annotationLifecycle");
    expect(JSON.stringify(discovery)).not.toContain("resolvedAt");

    const details = ["summary", "content", "task", "locator", "visual", "context", "handoff"] as const;
    for (const detail of details) {
      const result = await readSharedCapture(reader, {
        instanceId: instance.instanceId,
        captureId: "session-1",
        expectedSequence: 1,
        detail,
        ...(detail === "handoff" ? {} : { targetIds: ["target_A"] }),
      });
      const parsed = JSON.parse(readText(result));
      expect(parsed.capture).toMatchObject({
        annotationLifecycleVersion: "v1",
        executionAuthority: {
          grantedByCapture: false,
          browserControl: false,
          liveDomMutation: false,
        },
        targets: [{
          annotationIdentity: {
            annotationId: V2_ANNOTATION_IDENTITY.annotationId,
            annotationIdScope: V2_ANNOTATION_IDENTITY.annotationIdScope,
            createdAt: V2_ANNOTATION_IDENTITY.annotationCreatedAt,
            updatedAt: V2_ANNOTATION_IDENTITY.annotationUpdatedAt,
          },
          annotationLifecycle: lifecycle,
        }],
      });
      if (detail === "handoff") {
        expect(parsed.capture.handoff).toBe(handoff);
      }
    }
  });

  test("discovers and reads capture-level replay diagnostics without widening target scope", async () => {
    const capture = createCapture();
    capture.metadataDiagnostics = {
      schemaVersion: "0.1.0",
      kind: "ui-attach.metadata-only-diagnostics",
      captureId: capture.captureId,
      scope: "capture",
      observedAt: capture.updatedAt,
      consent: "explicit_capture",
      authority: "capture_time",
      replay: {
        status: "collected",
        attemptCount: 3,
        verifiedCount: 1,
        ambiguousCount: 1,
        missingCount: 1,
      },
      device: { status: "not_requested" },
      network: { status: "not_requested" },
      console: { status: "not_requested" },
      executionAuthority: {
        grantedByCapture: false,
        browserControl: false,
        liveDomMutation: false,
      },
    };
    const instance = createCaptureInstanceView(7);
    instance.snapshot.capture = capture;
    const reader = {
      getStatus: () => { throw new Error("unused"); },
      listInstances: () => [{ instanceId: instance.instanceId, stale: false }],
      readInstance: async () => ({ ok: true as const, value: instance }),
    };

    const listed = await listSharedCaptures(reader) as { captures: Array<Record<string, unknown>> };
    expect(listed.captures[0]).toMatchObject({
      captureId: "session-1",
      metadataDiagnosticsVersion: "v1",
      snapshot: { sequence: 7 },
    });
    expect(listed.captures[0]).not.toHaveProperty("metadataDiagnostics");

    const read = JSON.parse(readText(await readSharedCapture(reader, {
      instanceId: instance.instanceId,
      captureId: "session-1",
      expectedSequence: 7,
      detail: "diagnostics",
    })));
    expect(read).toMatchObject({
      kind: "ui-attach.capture-read",
      detail: "diagnostics",
      capture: {
        captureId: "session-1",
        metadataDiagnostics: capture.metadataDiagnostics,
        executionAuthority: {
          grantedByCapture: false,
          browserControl: false,
          liveDomMutation: false,
        },
      },
    });
    expect(read.capture).not.toHaveProperty("targets");
    expect(read.capture).not.toHaveProperty("page");
    expect(JSON.stringify(read.capture)).not.toContain("/settings");

    const scoped = await readSharedCapture(reader, {
      instanceId: instance.instanceId,
      captureId: "session-1",
      expectedSequence: 7,
      detail: "diagnostics",
      targetIds: ["target_A"],
    });
    expect(scoped.isError).toBe(true);
    expect(JSON.parse(readText(scoped))).toMatchObject({
      error: { code: "DIAGNOSTICS_SCOPE_UNSUPPORTED" },
    });

    delete capture.metadataDiagnostics;
    const unavailable = JSON.parse(readText(await readSharedCapture(reader, {
      instanceId: instance.instanceId,
      captureId: "session-1",
      expectedSequence: 7,
      detail: "diagnostics",
    })));
    expect(unavailable.capture.metadataDiagnostics).toBeNull();
  });

  test("keeps V2 and legacy capture projection free of lifecycle markers", async () => {
    const captures = [createCapture(), createCapture()];
    const legacyTarget = captures[1]!.targets[0]! as unknown as Record<string, unknown>;
    delete legacyTarget.annotationId;
    delete legacyTarget.annotationIdScope;
    delete legacyTarget.annotationCreatedAt;
    delete legacyTarget.annotationUpdatedAt;
    for (const capture of captures) {
      const instance = createCaptureInstanceView(1);
      instance.snapshot.capture = capture;
      const reader = {
        getStatus: () => { throw new Error("unused"); },
        listInstances: () => [{ instanceId: instance.instanceId, stale: false }],
        readInstance: async () => ({ ok: true as const, value: instance }),
      };
      const listed = await listSharedCaptures(reader) as { captures: Array<Record<string, unknown>> };
      expect(listed.captures[0]).not.toHaveProperty("annotationLifecycleVersion");
      const read = JSON.parse(readText(await readSharedCapture(reader, {
        instanceId: instance.instanceId,
        captureId: "session-1",
        expectedSequence: 1,
        detail: "summary",
      })));
      expect(read.capture).not.toHaveProperty("annotationLifecycleVersion");
      expect(read.capture.targets[0]).not.toHaveProperty("annotationLifecycle");
    }
  });

  test("keeps renewing the authenticated owner lease and retries after failure", async () => {
    let renew: (() => void) | null = null;
    let attempts = 0;
    const unavailable = vi.fn();
    const unref = vi.fn();
    const clearInterval = vi.fn();
    const lease = startLocalBridgeOwnerLease({
      ensureOwner: async () => {
        attempts += 1;
        if (attempts === 1) throw new Error("owner unavailable");
      },
      onOwnerUnavailable: unavailable,
    }, {
      intervalMs: 15_000,
      setInterval: (callback, intervalMs) => {
        expect(intervalMs).toBe(15_000);
        renew = callback;
        return { unref } as unknown as ReturnType<typeof setInterval>;
      },
      clearInterval,
    });

    expect(attempts).toBe(0);
    expect(unref).toHaveBeenCalledTimes(1);
    await lease.refresh();
    expect(attempts).toBe(1);
    expect(unavailable).toHaveBeenCalledTimes(1);
    await lease.refresh();
    expect(attempts).toBe(2);
    expect(renew).not.toBeNull();
    renew?.();
    expect(attempts).toBe(3);
    await Promise.resolve();

    lease.stop();
    renew?.();
    await lease.refresh();
    expect(attempts).toBe(3);
    expect(clearInterval).toHaveBeenCalledTimes(1);
  });

  test("approves through the authenticated owner without returning the extension credential", async () => {
    let now = new Date("2026-07-17T04:30:00.000Z");
    const state = createLocalBridgeState({
      now: () => now,
      randomBytes: (size) => Buffer.alloc(size, 7),
    });
    const request = {
      schemaVersion: "0.1.0",
      kind: "ui-attach.local-bridge-connection-request",
      requestId: "95e3e7b1-6f74-44ae-8954-e11f7f2a7c58",
      requestSecret: "CwsLCwsLCwsLCwsLCwsLCwsLCwsLCwsLCwsLCwsLCws",
      approvalVerifier: APPROVAL_VERIFIER,
      installationId: INSTALLATION_ID,
      browserSessionId: "32b8d92d-c76e-4c72-9f3c-5ba5bf31cd22",
      approvalMode: "ask",
    };
    expect(state.createConnectionRequest(EXTENSION_ORIGIN, request).ok).toBe(true);
    const http = await startLocalBridgeHttpServer(state, {
      port: 0,
      agentToken: AGENT_TOKEN,
      ownerIdentity: OWNER_IDENTITY,
    });
    try {
      const approval = await approveHttpLocalBridgeConnectionRequest(
        http.origin,
        AGENT_TOKEN,
        request.requestId,
        request.approvalMode,
        APPROVAL_KEY,
        { expectedOwnerIdentity: OWNER_IDENTITY },
      );
      expect(approval).toEqual({
        requestId: request.requestId,
        approvalMode: "ask",
        expiresAt: "2026-07-17T04:32:00.000Z",
      });
      expect(JSON.stringify(approval)).not.toMatch(/token|requestSecret/);
      await expect(approveHttpLocalBridgeConnectionRequest(
        http.origin,
        AGENT_TOKEN,
        request.requestId,
        request.approvalMode,
        APPROVAL_KEY,
        { expectedOwnerIdentity: { ...OWNER_IDENTITY, buildHash: "b".repeat(64) } },
      )).rejects.toThrow("not approved");

      const expiredRequest = {
        ...request,
        requestId: "20a85d08-3aed-4c24-9006-221db95ab33c",
        requestSecret: "DQ0NDQ0NDQ0NDQ0NDQ0NDQ0NDQ0NDQ0NDQ0NDQ0NDQ0",
      };
      expect(state.createConnectionRequest(EXTENSION_ORIGIN, expiredRequest).ok).toBe(true);
      now = new Date("2026-07-17T04:32:00.001Z");
      await expect(approveHttpLocalBridgeConnectionRequest(
        http.origin,
        AGENT_TOKEN,
        expiredRequest.requestId,
        expiredRequest.approvalMode,
        APPROVAL_KEY,
        { expectedOwnerIdentity: OWNER_IDENTITY },
      )).rejects.toBeInstanceOf(LocalBridgeConnectionInvitationExpiredError);
    } finally {
      await http.close();
    }
  });

  test("keeps the default product surface to progressive capture reads and source resolution", async () => {
    const server = createLocalBridgeMcpServer(createLocalBridgeState());
    const client = new Client({ name: "meanthis-product-test", version: "0.1.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    try {
      const tools = await client.listTools();
      expect(tools.tools.map((tool) => tool.name)).toEqual([
        "meanthis_list_captures",
        "meanthis_read_capture",
        "meanthis_ack_capture_read",
        "meanthis_wait_capture_change",
        "meanthis_resolve_source",
      ]);
      const readTool = tools.tools.find((tool) => tool.name === "meanthis_read_capture");
      expect(readTool?.inputSchema).toMatchObject({
        properties: {
          detail: {
            enum: expect.arrayContaining(["summary", "diagnostics", "handoff"]),
          },
        },
      });
      const waitTool = tools.tools.find((tool) => tool.name === "meanthis_wait_capture_change");
      expect(waitTool?.annotations).toMatchObject({
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      });
      expect(waitTool?.inputSchema).toMatchObject({
        additionalProperties: false,
        properties: {
          timeoutMs: {
            default: 20_000,
            maximum: 25_000,
            minimum: 1,
          },
        },
        required: ["instanceId", "captureId", "afterSequence"],
        type: "object",
      });
    } finally {
      await client.close();
      await server.close();
    }
  });

  test("waits for one exact capture revision without disclosing capture content", async () => {
    let sequence = 1;
    let now = 0;
    const readInstance = vi.fn(async () => ({
      ok: true as const,
      value: createCaptureInstanceView(sequence),
    }));

    const result = await waitForSharedCaptureChange({
      getStatus: () => { throw new Error("unused"); },
      listInstances: () => [],
      readInstance,
    }, {
      instanceId: "instance-0123456789ab",
      captureId: "session-1",
      afterSequence: 1,
      timeoutMs: 20,
    }, {
      now: () => now,
      pollIntervalMs: 5,
      wait: async (delayMs) => {
        now += delayMs;
        sequence = 2;
      },
    });

    const text = readText(result);
    expect(JSON.parse(text)).toEqual({
      schemaVersion: "0.1.0",
      kind: "ui-attach.capture-change-wait",
      changed: true,
      timedOut: false,
      state: "changed",
      instanceId: "instance-0123456789ab",
      captureId: "session-1",
      previousSequence: 1,
      currentSequence: 2,
      executionAuthority: {
        grantedByCapture: false,
        browserControl: false,
        liveDomMutation: false,
      },
      nextAction: {
        kind: "read_capture",
        tool: "meanthis_read_capture",
        arguments: {
          instanceId: "instance-0123456789ab",
          captureId: "session-1",
          expectedSequence: 2,
          detail: "summary",
        },
      },
    });
    expect(readInstance).toHaveBeenCalledTimes(2);
    expect(text).not.toContain("Shorten the label");
    expect(text).not.toContain("Save changes");
    expect(text).not.toContain("locatorBundle");
    expect(text).not.toContain("agentCopy");
  });

  test("returns a bounded metadata-only timeout when the capture does not change", async () => {
    let now = 0;
    const result = await waitForSharedCaptureChange({
      getStatus: () => { throw new Error("unused"); },
      listInstances: () => [],
      readInstance: async () => ({
        ok: true as const,
        value: createCaptureInstanceView(4),
      }),
    }, {
      instanceId: "instance-0123456789ab",
      captureId: "session-1",
      afterSequence: 4,
      timeoutMs: 10,
    }, {
      now: () => now,
      pollIntervalMs: 5,
      wait: async (delayMs) => { now += delayMs; },
    });

    const text = readText(result);
    expect(JSON.parse(text)).toMatchObject({
      kind: "ui-attach.capture-change-wait",
      changed: false,
      timedOut: true,
      state: "timed_out",
      previousSequence: 4,
      currentSequence: 4,
      nextAction: null,
    });
    expect(text).not.toContain("Shorten the label");
    expect(text).not.toContain("Save changes");
    expect(text).not.toContain("locatorBundle");
  });

  test("cancels capture-change waiting and fails closed on sequence regression", async () => {
    let now = 0;
    const abortController = new AbortController();
    const reader = {
      getStatus: () => { throw new Error("unused"); },
      listInstances: () => [],
      readInstance: async () => ({
        ok: true as const,
        value: createCaptureInstanceView(3),
      }),
    };
    const cancelled = await waitForSharedCaptureChange(reader, {
      instanceId: "instance-0123456789ab",
      captureId: "session-1",
      afterSequence: 3,
      timeoutMs: 10,
    }, {
      signal: abortController.signal,
      now: () => now,
      pollIntervalMs: 5,
      wait: async (delayMs) => {
        now += delayMs;
        abortController.abort();
      },
    });
    expect(cancelled.isError).toBe(true);
    expect(JSON.parse(readText(cancelled))).toMatchObject({
      error: { code: "REQUEST_CANCELLED" },
    });

    const regressed = await waitForSharedCaptureChange(reader, {
      instanceId: "instance-0123456789ab",
      captureId: "session-1",
      afterSequence: 4,
      timeoutMs: 10,
    }, { now: () => now });
    expect(regressed.isError).toBe(true);
    expect(JSON.parse(readText(regressed))).toMatchObject({
      error: {
        code: "CAPTURE_CHANGED",
        nextAction: { kind: "relist_captures" },
      },
    });
  });

  test("fails capture-change waiting closed for stale, replaced, and unavailable owners", async () => {
    const input = {
      instanceId: "instance-0123456789ab",
      captureId: "session-1",
      afterSequence: 1,
      timeoutMs: 10,
    };
    const baseReader = {
      getStatus: () => { throw new Error("unused"); },
      listInstances: () => [],
    };
    const stale = await waitForSharedCaptureChange({
      ...baseReader,
      readInstance: async () => ({
        ok: true as const,
        value: { ...createCaptureInstanceView(1), stale: true },
      }),
    }, input);
    expect(stale.isError).toBe(true);
    expect(JSON.parse(readText(stale))).toMatchObject({
      error: {
        code: "INSTANCE_STALE",
        nextAction: { kind: "relist_captures" },
      },
    });

    const replaced = await waitForSharedCaptureChange({
      ...baseReader,
      readInstance: async () => ({
        ok: true as const,
        value: {
          ...createCaptureInstanceView(1),
          snapshot: {
            ...createCaptureInstanceView(1).snapshot,
            capture: {
              ...createCaptureInstanceView(1).snapshot.capture,
              captureId: "session-replaced",
            },
          },
        },
      }),
    }, input);
    expect(replaced.isError).toBe(true);
    expect(JSON.parse(readText(replaced))).toMatchObject({
      error: {
        code: "CAPTURE_NOT_FOUND",
        nextAction: { kind: "relist_captures" },
      },
    });

    const unavailable = await waitForSharedCaptureChange({
      ...baseReader,
      readInstance: async () => { throw new Error("owner stopped"); },
    }, input);
    expect(unavailable.isError).toBe(true);
    expect(JSON.parse(readText(unavailable))).toMatchObject({
      error: {
        code: "BRIDGE_OWNER_UNAVAILABLE",
        nextAction: { kind: "retry_list_captures" },
      },
    });
  });

  test("recommends summary when a shared capture has no authored task notes", async () => {
    const state = createLocalBridgeState({
      now: () => new Date("2026-07-17T04:30:00.000Z"),
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
    const capture = createCapture();
    capture.targets[0]!.taskNote = "";
    expect(state.publish(EXTENSION_ORIGIN, paired.value.token, {
      schemaVersion: "0.1.0",
      kind: "ui-attach.local-bridge-snapshot",
      sequence: 1,
      publishedAt: "2026-07-17T04:30:00.000Z",
      page: {
        pageInstanceId: "chromium-tab:7:frame:0",
        route: "https://example.test/settings",
      },
      attachmentCount: 1,
      agentCopy: null,
      capture,
    })).toMatchObject({ ok: true });
    const server = createLocalBridgeMcpServer(state);
    const client = new Client({ name: "meanthis-summary-next-action-test", version: "0.1.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    try {
      const list = await client.callTool({ name: "meanthis_list_captures", arguments: {} });
      expect(JSON.parse(readText(list))).toMatchObject({
        captures: [{ taskNoteCount: 0 }],
        nextAction: {
          kind: "read_capture",
          arguments: { detail: "summary" },
          cli: { arguments: expect.arrayContaining(["--detail", "summary"]) },
        },
      });
    } finally {
      await client.close();
      await server.close();
    }
  });

  test("distinguishes no connected browser from a connected browser without a shared capture", async () => {
    const state = createLocalBridgeState({
      now: () => new Date("2026-07-17T04:30:00.000Z"),
      randomInt: () => 482_193,
      randomBytes: (size) => Buffer.alloc(size, 7),
    });
    const server = createLocalBridgeMcpServer(state);
    const client = new Client({ name: "meanthis-empty-state-test", version: "0.1.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    try {
      const disconnected = await client.callTool({ name: "meanthis_list_captures", arguments: {} });
      expect(JSON.parse(readText(disconnected))).toMatchObject({
        state: "no_connected_instances",
        connectedInstanceCount: 0,
        instancesWithoutCaptureCount: 0,
        emptyReason: "no_connected_instances",
        nextAction: { kind: "connect_browser" },
        captures: [],
      });

      const paired = state.pair(EXTENSION_ORIGIN, {
        schemaVersion: "0.1.0",
        kind: "ui-attach.local-bridge-pair",
        pairingCode: "482-193",
        installationId: INSTALLATION_ID,
      });
      expect(paired.ok).toBe(true);
      if (!paired.ok) return;
      expect(state.heartbeat(EXTENSION_ORIGIN, paired.value.token)).toMatchObject({ ok: true });

      const connected = await client.callTool({ name: "meanthis_list_captures", arguments: {} });
      expect(JSON.parse(readText(connected))).toMatchObject({
        state: "connected_without_shared_capture",
        connectedInstanceCount: 1,
        instancesWithoutCaptureCount: 1,
        emptyReason: "connected_instances_without_shared_capture",
        nextAction: { kind: "select_targets" },
        focusedContexts: [],
        captures: [],
      });

      expect(state.publish(EXTENSION_ORIGIN, paired.value.token, {
        schemaVersion: "0.1.0",
        kind: "ui-attach.local-bridge-snapshot",
        sequence: 1,
        publishedAt: "2026-07-17T04:30:01.000Z",
        page: {
          pageInstanceId: "chromium-tab:7:frame:0",
          route: "https://example.test/settings",
        },
        attachmentCount: 0,
        agentCopy: null,
      })).toMatchObject({ ok: true });

      const focused = await client.callTool({ name: "meanthis_list_captures", arguments: {} });
      expect(JSON.parse(readText(focused))).toMatchObject({
        state: "connected_without_shared_capture",
        connectedInstanceCount: 1,
        instancesWithoutCaptureCount: 1,
        nextAction: { kind: "select_targets" },
        focusedContexts: [{
          instanceId: paired.value.instanceId,
          focusKind: "meanthis_shared_scope",
          state: "page_shared",
          page: {
            pageInstanceId: "chromium-tab:7:frame:0",
            route: "https://example.test/settings",
          },
          captureId: null,
          targetCount: 0,
          taskNoteCount: 0,
          captureTitle: null,
          captureUpdatedAt: null,
          snapshot: { sequence: 1, publishedAt: "2026-07-17T04:30:01.000Z" },
        }],
        captures: [],
      });
    } finally {
      await client.close();
      await server.close();
    }
  });

  test("rejects stale instance views even when a reader adapter returns them as successful", async () => {
    const state = createLocalBridgeState({
      now: () => new Date("2026-07-17T04:30:00.000Z"),
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
    expect(state.publish(EXTENSION_ORIGIN, paired.value.token, {
      schemaVersion: "0.1.0",
      kind: "ui-attach.local-bridge-snapshot",
      sequence: 1,
      publishedAt: "2026-07-17T04:30:00.000Z",
      page: { pageInstanceId: "chromium-tab:7:frame:0", route: "https://example.test/settings" },
      attachmentCount: 1,
      agentCopy: "Agent-safe handoff.",
      capture: createCapture(),
    })).toMatchObject({ ok: true });

    let throwReads = false;
    const reader = {
      getStatus: () => state.getStatus(),
      listInstances: () => state.listInstances(),
      readInstance(instanceId: string) {
        if (throwReads) throw new Error("owner read failed");
        const result = state.readInstance(instanceId);
        return result.ok
          ? { ok: true as const, value: { ...result.value, stale: true } }
          : result;
      },
    };
    const server = createLocalBridgeMcpServer(reader);
    const client = new Client({ name: "meanthis-stale-adapter-test", version: "0.1.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    try {
      const list = await client.callTool({ name: "meanthis_list_captures", arguments: {} });
      expect(JSON.parse(readText(list))).toMatchObject({ captures: [] });

      const read = await client.callTool({
        name: "meanthis_read_capture",
        arguments: {
          instanceId: paired.value.instanceId,
          captureId: "session-1",
          expectedSequence: 1,
          detail: "summary",
        },
      });
      expect(read.isError).toBe(true);
      expect(readText(read)).toContain("INSTANCE_STALE");

      throwReads = true;
      const unavailable = await client.callTool({
        name: "meanthis_list_captures",
        arguments: {},
      });
      expect(unavailable.isError).toBe(true);
      expect(readText(unavailable)).toContain("BRIDGE_OWNER_UNAVAILABLE");
    } finally {
      await client.close();
      await server.close();
    }
  });

  test("keeps legacy diagnostics available on the explicit compatibility surface", async () => {
    const state = createLocalBridgeState({
      now: () => new Date("2026-07-17T04:30:00.000Z"),
      randomInt: () => 482_193,
      randomBytes: (size) => Buffer.alloc(size, 7),
    });
    const server = createLocalBridgeMcpServer(state, { includeCompatibilityTools: true });
    const client = new Client({ name: "ui-attach-test", version: "0.1.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    try {
      const tools = await client.listTools();
      expect(tools.tools.map((tool) => tool.name)).toEqual([
        "meanthis_list_captures",
        "meanthis_read_capture",
        "meanthis_ack_capture_read",
        "meanthis_wait_capture_change",
        "ui_attach_bridge_status",
        "ui_attach_list_instances",
        "ui_attach_read_instance",
        "ui_attach_verify_page_completion",
        "meanthis_resolve_source",
      ]);
      for (const tool of tools.tools) {
        if (tool.name === "meanthis_ack_capture_read") {
          expect(tool.annotations).toMatchObject({
            readOnlyHint: false,
            destructiveHint: false,
            idempotentHint: true,
            openWorldHint: false,
          });
          continue;
        }
        expect(tool.annotations).toMatchObject({
          readOnlyHint: true,
          destructiveHint: false,
          idempotentHint: true,
          openWorldHint: false,
        });
      }

      const unavailableSource = await client.callTool({
        name: "meanthis_resolve_source",
        arguments: {
          sourceAnchor: {
            schemaVersion: "0.1.0",
            kind: "ui-attach.opaque-source-anchor",
            buildId: "A".repeat(43),
            sourceId: "B".repeat(43),
          },
        },
      });
      expect(unavailableSource.isError).not.toBe(true);
      expect(JSON.parse(readText(unavailableSource))).toMatchObject({
        status: "unavailable",
        reason: "workspace_unavailable",
      });

      const paired = state.pair(
        EXTENSION_ORIGIN,
        {
          schemaVersion: "0.1.0",
          kind: "ui-attach.local-bridge-pair",
          pairingCode: "482-193",
          installationId: "5ea6b70f-48e8-4a7b-bc91-d943b0ef10f3",
        },
      );
      expect(paired.ok).toBe(true);
      if (!paired.ok) return;
      expect(state.publish(
        EXTENSION_ORIGIN,
        paired.value.token,
        {
          schemaVersion: "0.1.0",
          kind: "ui-attach.local-bridge-snapshot",
          sequence: 1,
          publishedAt: "2026-07-17T04:30:00.000Z",
          page: {
            pageInstanceId: "chromium-tab:7:frame:0",
            route: "https://example.test/settings",
          },
          attachmentCount: 1,
          agentCopy: "Agent-safe handoff.",
          capture: createCapture(),
        },
      )).toMatchObject({ ok: true });

      const status = await client.callTool({ name: "ui_attach_bridge_status", arguments: {} });
      expect(readText(status)).toContain('"code":"482-193"');
      expect(readText(status)).not.toContain("token");
      expect(readText(status)).not.toContain("installationId");
      expect(readText(status)).not.toContain("Agent-safe handoff");

      const list = await client.callTool({ name: "ui_attach_list_instances", arguments: {} });
      expect(readText(list)).toContain(paired.value.instanceId);
      expect(readText(list)).not.toContain("Agent-safe handoff");

      const captures = await client.callTool({
        name: "meanthis_list_captures",
        arguments: {},
      });
      const captureList = JSON.parse(readText(captures));
      expect(captureList).toMatchObject({
        kind: "ui-attach.capture-list",
        state: "captures_available",
        nextAction: {
          kind: "read_capture",
          tool: "meanthis_read_capture",
          arguments: {
            instanceId: paired.value.instanceId,
            captureId: "session-1",
            expectedSequence: 1,
            detail: "agent_context",
          },
          cli: {
            executable: "meanthis",
            arguments: [
              "capture",
              "read",
              "--instance",
              paired.value.instanceId,
              "--capture",
              "session-1",
              "--sequence",
              "1",
              "--detail",
              "agent_context",
              "--json",
            ],
          },
        },
        captures: [{
          instanceId: paired.value.instanceId,
          captureId: "session-1",
          title: "Settings review",
          targetCount: 1,
          authority: "capture_time",
        }],
        focusedContexts: [{
          instanceId: paired.value.instanceId,
          focusKind: "meanthis_shared_scope",
          state: "intent_authored",
          page: {
            pageInstanceId: "chromium-tab:7:frame:0",
            route: "https://example.test/settings",
          },
          captureId: "session-1",
          targetCount: 1,
          taskNoteCount: 1,
          captureTitle: "Settings review",
          captureUpdatedAt: "2026-07-17T04:29:58.000Z",
          snapshot: { sequence: 1, publishedAt: "2026-07-17T04:30:00.000Z" },
        }],
      });
      expect(readText(captures)).not.toContain("Save changes");
      expect(readText(captures)).not.toContain("Shorten the label");

      const summary = await client.callTool({
        name: "meanthis_read_capture",
        arguments: {
          instanceId: paired.value.instanceId,
          captureId: "session-1",
          expectedSequence: 1,
          detail: "summary",
        },
      });
      expect(JSON.parse(readText(summary))).toMatchObject({
        kind: "ui-attach.capture-read",
        detail: "summary",
        nextAction: {
          kind: "ack_capture_read",
          tool: "meanthis_ack_capture_read",
          arguments: {
            instanceId: paired.value.instanceId,
            captureId: "session-1",
            expectedSequence: 1,
            detail: "summary",
          },
          cli: {
            executable: "meanthis",
            arguments: [
              "capture",
              "ack",
              "--instance",
              paired.value.instanceId,
              "--capture",
              "session-1",
              "--sequence",
              "1",
              "--detail",
              "summary",
              "--json",
            ],
          },
        },
        capture: {
          captureId: "session-1",
          captureSequence: 1,
          targetIdScope: "capture",
          executionAuthority: {
            grantedByCapture: false,
            browserControl: false,
            liveDomMutation: false,
          },
          targets: [{
            targetId: "target_A",
            targetIdScope: "capture",
            attachmentId: "att_save",
            label: "A",
            taskNotePresent: true,
            element: { tagName: "button", role: "button", accessibleName: "Save changes" },
          }],
        },
      });

      const acknowledgement = await client.callTool({
        name: "meanthis_ack_capture_read",
        arguments: {
          instanceId: paired.value.instanceId,
          captureId: "session-1",
          expectedSequence: 1,
          detail: "summary",
        },
      });
      expect(acknowledgement.isError).not.toBe(true);
      expect(JSON.parse(readText(acknowledgement))).toMatchObject({
        acknowledgement: {
          schemaVersion: "0.1.0",
          kind: "ui-attach.local-bridge-read-acknowledgement",
          status: "acknowledged_by_agent_client",
          instanceId: paired.value.instanceId,
          captureId: "session-1",
          snapshotSequence: 1,
          detail: "summary",
          executionAuthority: {
            grantedByCapture: false,
            browserControl: false,
            liveDomMutation: false,
          },
        },
        limitations: [
          "does_not_prove_model_attention",
          "does_not_prove_task_creation",
          "does_not_prove_downstream_execution",
        ],
      });

      const changed = await client.callTool({
        name: "meanthis_read_capture",
        arguments: {
          instanceId: paired.value.instanceId,
          captureId: "session-1",
          expectedSequence: 0,
          detail: "summary",
        },
      });
      expect(changed.isError).toBe(true);
      expect(JSON.parse(readText(changed))).toMatchObject({
        error: {
          code: "CAPTURE_CHANGED",
          nextAction: {
            kind: "relist_captures",
            tool: "meanthis_list_captures",
          },
        },
      });

      const content = await client.callTool({
        name: "meanthis_read_capture",
        arguments: {
          instanceId: paired.value.instanceId,
          captureId: "session-1",
          expectedSequence: 1,
          detail: "content",
          targetIds: ["target_A"],
        },
      });
      const contentRead = JSON.parse(readText(content));
      expect(contentRead).toMatchObject({
        detail: "content",
        capture: {
          targets: [{
            targetId: "target_A",
            attachmentId: "att_save",
            label: "A",
            content: {
              rawText: "Save",
              accessibleName: "Save changes",
              partsSource: "captured",
              parts: [{ kind: "button", text: "Save", accessibleName: "Save changes" }],
              nearbyText: ["Profile", "Cancel"],
            },
          }],
        },
      });
      expect(JSON.stringify(contentRead)).not.toContain("locatorBundle");
      expect(JSON.stringify(contentRead)).not.toContain("backgroundColor");

      const missingTarget = await client.callTool({
        name: "meanthis_read_capture",
        arguments: {
          instanceId: paired.value.instanceId,
          captureId: "session-1",
          expectedSequence: 1,
          detail: "content",
          targetIds: ["target_missing"],
        },
      });
      expect(missingTarget.isError).toBe(true);
      expect(JSON.parse(readText(missingTarget))).toMatchObject({
        error: {
          code: "TARGET_NOT_FOUND",
          nextAction: {
            kind: "relist_captures",
            tool: "meanthis_list_captures",
            cli: {
              executable: "meanthis",
              arguments: ["capture", "list", "--json"],
            },
          },
        },
      });

      const ambiguousScope = await client.callTool({
        name: "meanthis_read_capture",
        arguments: {
          instanceId: paired.value.instanceId,
          captureId: "session-1",
          expectedSequence: 1,
          detail: "content",
          targetIds: ["target_A"],
          attachmentIds: ["att_save"],
        },
      });
      expect(ambiguousScope.isError).toBe(true);

      const task = await client.callTool({
        name: "meanthis_read_capture",
        arguments: {
          instanceId: paired.value.instanceId,
          captureId: "session-1",
          expectedSequence: 1,
          detail: "task",
          attachmentIds: ["att_save"],
        },
      });
      expect(JSON.parse(readText(task))).toMatchObject({
        detail: "task",
        capture: {
          targets: [{
            targetId: "target_A",
            task: {
              text: "Shorten the label.",
              intentStatus: "user_authored_task_note",
            },
            grounding: {
              element: {
                tagName: "button",
                role: "button",
                accessibleName: "Save changes",
              },
              recommendedLocator: {
                strategy: "playwright.role",
                value: "page.getByRole(\"button\", { name: \"Save changes\" })",
                confidence: 0.92,
              },
              sourceAnchor: null,
              boundary: null,
            },
            authorization: {
              grantedByCapture: false,
              browserControl: false,
              liveDomMutation: false,
            },
          }],
        },
      });

      const locator = await client.callTool({
        name: "meanthis_read_capture",
        arguments: {
          instanceId: paired.value.instanceId,
          captureId: "session-1",
          expectedSequence: 1,
          detail: "locator",
          attachmentIds: ["att_save"],
        },
      });
      const locatorRead = JSON.parse(readText(locator));
      expect(locatorRead).toMatchObject({
        detail: "locator",
        capture: {
          targets: [{
            targetId: "target_A",
            locator: {
              selectorHints: ["button[type=\"submit\"]"],
              locatorBundle: { primary: { strategy: "playwright.role" } },
            },
          }],
        },
      });
      expect(JSON.stringify(locatorRead)).not.toContain('"rawText"');
      expect(JSON.stringify(locatorRead)).not.toContain('"style"');

      const visual = await client.callTool({
        name: "meanthis_read_capture",
        arguments: {
          instanceId: paired.value.instanceId,
          captureId: "session-1",
          expectedSequence: 1,
          detail: "visual",
          attachmentIds: ["att_save"],
        },
      });
      expect(JSON.parse(readText(visual))).toMatchObject({
        detail: "visual",
        capture: {
          targets: [{
            targetId: "target_A",
            visual: {
              bbox: { x: 10, y: 20, width: 80, height: 32 },
              visible: true,
              enabled: true,
              style: {
                display: "inline-flex",
                position: "relative",
                padding: "6px 8px",
                gap: "10px",
                fontSize: "14px",
              },
              artifacts: { screenshotCrop: null, overlayImage: null },
            },
          }],
        },
      });

      const context = await client.callTool({
        name: "meanthis_read_capture",
        arguments: {
          instanceId: paired.value.instanceId,
          captureId: "session-1",
          expectedSequence: 1,
          detail: "context",
          attachmentIds: ["att_save"],
        },
      });
      expect(JSON.parse(readText(context))).toMatchObject({
        kind: "ui-attach.capture-read",
        detail: "context",
        capture: {
          targets: [{
            attachmentId: "att_save",
            taskNote: "Shorten the label.",
            attachment: { policy: { disclosureMode: "agent_safe" } },
          }],
        },
      });

      const handoff = await client.callTool({
        name: "meanthis_read_capture",
        arguments: {
          instanceId: paired.value.instanceId,
          captureId: "session-1",
          expectedSequence: 1,
          detail: "handoff",
        },
      });
      expect(JSON.parse(readText(handoff))).toMatchObject({
        kind: "ui-attach.capture-read",
        detail: "handoff",
        capture: { handoff: "Agent-safe handoff." },
      });

      const missingCapture = await client.callTool({
        name: "meanthis_read_capture",
        arguments: {
          instanceId: paired.value.instanceId,
          captureId: "session-2",
          expectedSequence: 1,
          detail: "summary",
        },
      });
      expect(missingCapture.isError).toBe(true);
      expect(readText(missingCapture)).toContain("CAPTURE_NOT_FOUND");

      const exact = await client.callTool({
        name: "ui_attach_read_instance",
        arguments: { instanceId: paired.value.instanceId },
      });
      expect(exact.isError).not.toBe(true);
      expect(readText(exact)).toContain("Agent-safe handoff");

      const missing = await client.callTool({
        name: "ui_attach_read_instance",
        arguments: { instanceId: "instance-000000000000" },
      });
      expect(missing.isError).toBe(true);
      expect(readText(missing)).toContain("INSTANCE_NOT_FOUND");
    } finally {
      await client.close();
      await server.close();
    }
  });

  test("marks synthesized content parts as a legacy fallback", async () => {
    const state = createLocalBridgeState({
      now: () => new Date("2026-07-17T04:30:00.000Z"),
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
    const capture = createCapture();
    delete capture.targets[0]!.attachment.element.contentParts;
    expect(state.publish(EXTENSION_ORIGIN, paired.value.token, {
      schemaVersion: "0.1.0",
      kind: "ui-attach.local-bridge-snapshot",
      sequence: 1,
      publishedAt: "2026-07-17T04:30:00.000Z",
      page: {
        pageInstanceId: "chromium-tab:7:frame:0",
        route: "https://example.test/settings",
      },
      attachmentCount: 1,
      agentCopy: "Agent-safe handoff.",
      capture,
    })).toMatchObject({ ok: true });

    const read = await readSharedCapture(state, {
      instanceId: paired.value.instanceId,
      captureId: "session-1",
      expectedSequence: 1,
      detail: "content",
      targetIds: ["target_A"],
    });

    expect(JSON.parse(readText(read))).toMatchObject({
      detail: "content",
      capture: {
        targets: [{
          targetId: "target_A",
          content: {
            partsSource: "legacy_fallback",
            parts: [{ kind: "text", text: "Save", accessibleName: "Save changes" }],
          },
        }],
      },
    });

    capture.targets[0]!.attachment.element.contentParts = [];
    expect(state.publish(EXTENSION_ORIGIN, paired.value.token, {
      schemaVersion: "0.1.0",
      kind: "ui-attach.local-bridge-snapshot",
      sequence: 2,
      publishedAt: "2026-07-17T04:30:01.000Z",
      page: {
        pageInstanceId: "chromium-tab:7:frame:0",
        route: "https://example.test/settings",
      },
      attachmentCount: 1,
      agentCopy: "Agent-safe handoff.",
      capture,
    })).toMatchObject({ ok: true });
    const emptyCapturedRead = await readSharedCapture(state, {
      instanceId: paired.value.instanceId,
      captureId: "session-1",
      expectedSequence: 2,
      detail: "content",
      targetIds: ["target_A"],
    });
    expect(JSON.parse(readText(emptyCapturedRead))).toMatchObject({
      capture: {
        targets: [{ content: { partsSource: "captured", parts: [] } }],
      },
    });
  });

  test("returns deterministic page-completion receipts from one current snapshot", async () => {
    const state = createLocalBridgeState({
      now: () => new Date("2026-07-17T04:30:00.000Z"),
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
    expect(state.publish(EXTENSION_ORIGIN, paired.value.token, {
      schemaVersion: "0.1.0",
      kind: "ui-attach.local-bridge-snapshot",
      sequence: 4,
      publishedAt: "2026-07-17T04:30:00.000Z",
      page: {
        pageInstanceId: "chromium-tab:7:frame:0",
        route: "https://app.example.test/settings",
      },
      attachmentCount: 4,
      agentCopy: "Agent-safe handoff.",
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
    })).toMatchObject({ ok: true });
    const server = createLocalBridgeMcpServer(state, { includeCompatibilityTools: true });
    const client = new Client({ name: "ui-attach-receipt-test", version: "0.1.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    const expectedPage = {
      pageInstanceId: "chromium-tab:7:frame:0",
      route: "https://app.example.test/settings",
      documentInstanceId: "document-01234567",
    };
    const verify = async (arguments_: Record<string, unknown>) => {
      const result = await client.callTool({
        name: "ui_attach_verify_page_completion",
        arguments: arguments_,
      });
      expect(result.isError).not.toBe(true);
      return JSON.parse(readText(result));
    };
    try {
      await expect(verify({
        instanceId: paired.value.instanceId,
        baselineSequence: 3,
        baselineObservedAt: "2026-07-17T04:29:58.000Z",
        expectedPage,
        checks: [
          { attachmentId: "att_save", expected: "present" },
          { attachmentId: "att_cancel", expected: "absent" },
        ],
      })).resolves.toMatchObject({
        kind: "ui-attach.page-completion-receipt",
        status: "pass",
        snapshot: { sequence: 4, publishedAt: "2026-07-17T04:30:00.000Z" },
        checks: [
          { attachmentId: "att_save", observed: "restored", outcome: "pass" },
          { attachmentId: "att_cancel", observed: "missing", outcome: "pass" },
        ],
        evidenceSource: "extension-current-page-rebind",
        limitations: [
          "Does not attribute who caused the page change.",
          "Does not prove backend or business completion.",
          "Canonical route identity excludes query and fragment values.",
        ],
      });
      await expect(verify({
        instanceId: paired.value.instanceId,
        baselineSequence: 3,
        baselineObservedAt: "2026-07-17T04:29:58.000Z",
        expectedPage,
        checks: [{ attachmentId: "att_save", expected: "absent" }],
      })).resolves.toMatchObject({
        status: "fail",
        checks: [{ outcome: "fail", reasonCode: "expected_absent_but_restored" }],
      });
      await expect(verify({
        instanceId: paired.value.instanceId,
        baselineSequence: 3,
        baselineObservedAt: "2026-07-17T04:29:58.000Z",
        expectedPage,
        checks: [{ attachmentId: "att_help", expected: "present" }],
      })).resolves.toMatchObject({
        status: "inconclusive",
        checks: [{ observed: "ambiguous", outcome: "inconclusive", reasonCode: "observation_ambiguous" }],
      });
      await expect(verify({
        instanceId: paired.value.instanceId,
        baselineSequence: 4,
        baselineObservedAt: "2026-07-17T04:29:58.000Z",
        expectedPage,
        checks: [{ attachmentId: "att_save", expected: "present" }],
      })).resolves.toMatchObject({
        status: "inconclusive",
        checks: [{ observed: "unavailable", reasonCode: "baseline_not_advanced" }],
      });
      await expect(verify({
        instanceId: paired.value.instanceId,
        baselineSequence: 3,
        baselineObservedAt: "2026-07-17T04:29:58.000Z",
        expectedPage: { ...expectedPage, route: "https://app.example.test/account" },
        checks: [{ attachmentId: "att_save", expected: "present" }],
      })).resolves.toMatchObject({
        status: "inconclusive",
        checks: [{ observed: "unavailable", reasonCode: "page_mismatch" }],
      });
      await expect(verify({
        instanceId: paired.value.instanceId,
        baselineSequence: 3,
        baselineObservedAt: "2026-07-17T04:29:58.000Z",
        expectedPage: { ...expectedPage, documentInstanceId: "replacement-document" },
        checks: [{ attachmentId: "att_save", expected: "present" }],
      })).resolves.toMatchObject({
        status: "inconclusive",
        checks: [{ observed: "unavailable", reasonCode: "document_mismatch" }],
      });
      await expect(verify({
        instanceId: paired.value.instanceId,
        baselineSequence: 3,
        baselineObservedAt: "2026-07-17T04:29:58.000Z",
        expectedPage,
        checks: [{ attachmentId: "att_unknown", expected: "present" }],
      })).resolves.toMatchObject({
        status: "inconclusive",
        checks: [{ observed: "unavailable", reasonCode: "target_unobserved" }],
      });
      await expect(verify({
        instanceId: "instance-000000000000",
        baselineSequence: 3,
        baselineObservedAt: "2026-07-17T04:29:58.000Z",
        expectedPage,
        checks: [{ attachmentId: "att_save", expected: "present" }],
      })).resolves.toMatchObject({
        status: "inconclusive",
        snapshot: null,
        checks: [{ observed: "unavailable", reasonCode: "instance_not_found" }],
      });
      await expect(verify({
        instanceId: paired.value.instanceId,
        baselineSequence: 3,
        baselineObservedAt: "2026-07-17T04:29:59.000Z",
        expectedPage,
        checks: [{ attachmentId: "att_save", expected: "present" }],
      })).resolves.toMatchObject({
        status: "inconclusive",
        checks: [{ observed: "unavailable", reasonCode: "observation_not_advanced" }],
      });

      const duplicateChecks = await client.callTool({
        name: "ui_attach_verify_page_completion",
        arguments: {
          instanceId: paired.value.instanceId,
          baselineSequence: 3,
          baselineObservedAt: "2026-07-17T04:29:58.000Z",
          expectedPage,
          checks: [
            { attachmentId: "att_save", expected: "present" },
            { attachmentId: "att_save", expected: "absent" },
          ],
        },
      });
      expect(duplicateChecks.isError).toBe(true);

      const unsafeRoute = await client.callTool({
        name: "ui_attach_verify_page_completion",
        arguments: {
          instanceId: paired.value.instanceId,
          baselineSequence: 3,
          baselineObservedAt: "2026-07-17T04:29:58.000Z",
          expectedPage: {
            ...expectedPage,
            route: "https://app.example.test/settings?token=secret",
          },
          checks: [{ attachmentId: "att_save", expected: "present" }],
        },
      });
      expect(unsafeRoute.isError).toBe(true);
    } finally {
      await client.close();
      await server.close();
    }
  });

  test("rechecks stale and mismatched instance views inside the completion verifier", async () => {
    let view = {
      instanceId: "instance-fedcba987654",
      extensionId: MEANTHIS_CHROME_WEB_STORE_EXTENSION_ID,
      connectedAt: "2026-07-17T04:29:00.000Z",
      lastSeenAt: "2026-07-17T04:30:00.000Z",
      stale: false,
      snapshot: null,
    };
    const server = createLocalBridgeMcpServer({
      getStatus() { throw new Error("unused"); },
      listInstances() { return []; },
      readInstance() { return { ok: true as const, value: view }; },
    }, { includeCompatibilityTools: true });
    const client = new Client({ name: "ui-attach-receipt-identity-test", version: "0.1.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    const arguments_ = {
      instanceId: "instance-0123456789ab",
      baselineSequence: 3,
      baselineObservedAt: "2026-07-17T04:29:58.000Z",
      expectedPage: {
        pageInstanceId: "chromium-tab:7:frame:0",
        route: "https://app.example.test/settings",
        documentInstanceId: "document-01234567",
      },
      checks: [{ attachmentId: "att_save", expected: "present" }],
    };
    try {
      const mismatched = await client.callTool({
        name: "ui_attach_verify_page_completion",
        arguments: arguments_,
      });
      expect(mismatched.isError).not.toBe(true);
      expect(JSON.parse(readText(mismatched))).toMatchObject({
        status: "inconclusive",
        snapshot: null,
        checks: [{ reasonCode: "instance_identity_mismatch" }],
      });

      view = { ...view, instanceId: arguments_.instanceId, stale: true };
      const stale = await client.callTool({
        name: "ui_attach_verify_page_completion",
        arguments: arguments_,
      });
      expect(stale.isError).not.toBe(true);
      expect(JSON.parse(readText(stale))).toMatchObject({
        status: "inconclusive",
        snapshot: null,
        checks: [{ reasonCode: "instance_stale" }],
      });
    } finally {
      await client.close();
      await server.close();
    }
  });

  test("resolves an opaque anchor only through MCP-declared workspace roots", async () => {
    const workspaceRoot = await mkdtemp(join(tmpdir(), "ui-attach-mcp-source-root-"));
    const source = "export function Panel() {}\n";
    const sourcePath = join(workspaceRoot, "src", "Panel.tsx");
    const buildId = "A".repeat(43);
    const sourceId = "B".repeat(43);
    const sidecar = createSourceMapSidecar(buildId, [{
      sourceId,
      path: "src/Panel.tsx",
      line: 1,
      column: 8,
      tagName: "button",
      componentName: "Panel",
      componentBreadcrumb: [{
        path: "src/Panel.tsx",
        line: 1,
        column: 8,
        componentName: "Panel",
      }],
      contentHash: createSourceContentHash(source),
    }]);
    const sidecarPath = join(workspaceRoot, ".ui-attach", "source-map.json");
    await mkdir(dirname(sourcePath), { recursive: true });
    await mkdir(dirname(sidecarPath), { recursive: true });
    await writeFile(sourcePath, source);
    await writeFile(sidecarPath, `${JSON.stringify(sidecar)}\n`);

    const server = createLocalBridgeMcpServer(createLocalBridgeState());
    const client = new Client(
      { name: "ui-attach-source-test", version: "0.1.0" },
      { capabilities: { roots: { listChanged: false } } },
    );
    client.setRequestHandler(ListRootsRequestSchema, async () => ({
      roots: [{ uri: pathToFileURL(workspaceRoot).href, name: "source fixture" }],
    }));
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    try {
      const result = await client.callTool({
        name: "meanthis_resolve_source",
        arguments: {
          sourceAnchor: {
            schemaVersion: "0.1.0",
            kind: "ui-attach.opaque-source-anchor",
            buildId,
            sourceId,
          },
        },
      });
      expect(result.isError, readText(result)).not.toBe(true);
      expect(JSON.parse(readText(result))).toEqual({
        schemaVersion: "0.1.0",
        kind: "ui-attach.source-resolution",
        status: "verified",
        buildId,
        sourceId,
        location: {
          path: "src/Panel.tsx",
          line: 1,
          column: 8,
          tagName: "button",
          componentName: "Panel",
          componentBreadcrumb: [{
            path: "src/Panel.tsx",
            line: 1,
            column: 8,
            componentName: "Panel",
          }],
        },
      });
      expect(readText(result)).not.toContain(createSourceContentHash(source));
      expect(readText(result)).not.toContain(workspaceRoot);
      expect(readText(result)).not.toContain(source);

      const rejectedRootOverride = await client.callTool({
        name: "meanthis_resolve_source",
        arguments: {
          sourceAnchor: {
            schemaVersion: "0.1.0",
            kind: "ui-attach.opaque-source-anchor",
            buildId,
            sourceId,
          },
          workspaceRoot,
        },
      });
      expect(rejectedRootOverride.isError).toBe(true);
    } finally {
      await client.close();
      await server.close();
      await rm(workspaceRoot, { recursive: true, force: true });
    }
  });

  test("reads one Agent context with task, visual facts, and verified source grounding", async () => {
    const workspaceRoot = await mkdtemp(join(tmpdir(), "ui-attach-agent-context-root-"));
    const source = "export function SaveButton() { return <button>Save</button>; }\n";
    const sourcePath = join(workspaceRoot, "src", "SaveButton.tsx");
    const buildId = "E".repeat(43);
    const sourceId = "F".repeat(43);
    const sidecarPath = join(workspaceRoot, ".ui-attach", "source-map.json");
    await mkdir(dirname(sourcePath), { recursive: true });
    await mkdir(dirname(sidecarPath), { recursive: true });
    await writeFile(sourcePath, source);
    await writeFile(sidecarPath, `${JSON.stringify(createSourceMapSidecar(buildId, [{
      sourceId,
      path: "src/SaveButton.tsx",
      line: 1,
      column: 39,
      tagName: "button",
      componentName: "SaveButton",
      contentHash: createSourceContentHash(source),
    }]))}\n`);

    const instance = createCaptureInstanceView(7);
    const capture = createCapture();
    capture.targets[0]!.attachment.sourceAnchor = {
      schemaVersion: "0.1.0",
      kind: "ui-attach.opaque-source-anchor",
      buildId,
      sourceId,
    };
    instance.snapshot.capture = capture;
    const listWorkspaceRoots = vi.fn(async () => [workspaceRoot]);
    const reader = {
      getStatus: () => { throw new Error("unused"); },
      listInstances: () => [{ instanceId: instance.instanceId, stale: false }],
      readInstance: vi.fn(async () => ({ ok: true as const, value: instance })),
    };
    const server = createLocalBridgeMcpServer(reader, { listWorkspaceRoots });
    const client = new Client({ name: "agent-context-test", version: "0.1.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    try {
      const listed = JSON.parse(readText(await client.callTool({
        name: "meanthis_list_captures",
        arguments: {},
      })));
      expect(listed.nextAction).toMatchObject({
        kind: "read_capture",
        tool: "meanthis_read_capture",
        arguments: {
          instanceId: instance.instanceId,
          captureId: "session-1",
          expectedSequence: 7,
          detail: "agent_context",
        },
      });

      const result = await client.callTool({
        name: "meanthis_read_capture",
        arguments: {
          instanceId: instance.instanceId,
          captureId: "session-1",
          expectedSequence: 7,
          detail: "agent_context",
          targetIds: ["target_A"],
        },
      });
      expect(result.isError, readText(result)).not.toBe(true);
      const parsed = JSON.parse(readText(result));
      expect(parsed).toMatchObject({
        kind: "ui-attach.capture-read",
        detail: "agent_context",
        capture: {
          captureId: "session-1",
          captureSequence: 7,
          executionAuthority: {
            grantedByCapture: false,
            browserControl: false,
            liveDomMutation: false,
          },
          targets: [{
            targetId: "target_A",
            task: {
              text: "Shorten the label.",
              intentStatus: "user_authored_task_note",
            },
            grounding: {
              element: {
                tagName: "button",
                role: "button",
                accessibleName: "Save changes",
              },
              recommendedLocator: {
                strategy: "playwright.role",
                value: "page.getByRole(\"button\", { name: \"Save changes\" })",
                confidence: 0.92,
              },
              sourceResolution: {
                schemaVersion: "0.1.0",
                kind: "ui-attach.source-resolution",
                status: "verified",
                buildId,
                sourceId,
                location: {
                  path: "src/SaveButton.tsx",
                  line: 1,
                  column: 39,
                  tagName: "button",
                  componentName: "SaveButton",
                },
              },
              boundary: null,
            },
            visual: {
              bbox: { x: 10, y: 20, width: 80, height: 32 },
              visible: true,
              enabled: true,
              style: {
                display: "inline-flex",
                position: "relative",
                padding: "6px 8px",
                gap: "10px",
                fontSize: "14px",
              },
            },
            authorization: {
              grantedByCapture: false,
              browserControl: false,
              liveDomMutation: false,
            },
          }],
        },
      });
      expect(listWorkspaceRoots).toHaveBeenCalledTimes(1);
      expect(parsed.capture.targets[0].visual).not.toHaveProperty("artifacts");
      expect(parsed.capture.targets[0]).not.toHaveProperty("content");
      expect(readText(result)).not.toContain(createSourceContentHash(source));
      expect(readText(result)).not.toContain(workspaceRoot);
      expect(readText(result)).not.toContain(source);

      const callsBeforeStaleRead = listWorkspaceRoots.mock.calls.length;
      const stale = await client.callTool({
        name: "meanthis_read_capture",
        arguments: {
          instanceId: instance.instanceId,
          captureId: "session-1",
          expectedSequence: 6,
          detail: "agent_context",
        },
      });
      expect(stale.isError).toBe(true);
      expect(JSON.parse(readText(stale))).toMatchObject({
        error: { code: "CAPTURE_CHANGED" },
      });
      expect(listWorkspaceRoots).toHaveBeenCalledTimes(callsBeforeStaleRead);
    } finally {
      await client.close();
      await server.close();
      await rm(workspaceRoot, { recursive: true, force: true });
    }
  });

  test("fails closed for absent, failed, wrong-length, or malformed Agent-context resolver output", async () => {
    const instance = createCaptureInstanceView(7);
    const reader = {
      getStatus: () => { throw new Error("unused"); },
      listInstances: () => [{ instanceId: instance.instanceId, stale: false }],
      readInstance: vi.fn(async () => ({ ok: true as const, value: instance })),
    };
    const poisoned = {
      schemaVersion: "0.1.0",
      kind: "ui-attach.source-resolution",
      status: "unavailable",
      reason: "workspace_unavailable",
      workspaceRoot: "C:/private/workspace",
      contentHash: "private-hash",
      rawError: "private resolver failure",
    } as Record<string, unknown>;
    poisoned.self = poisoned;
    const cases: Array<{
      name: string;
      resolver?: SharedCaptureSourceResolver;
    }> = [
      { name: "absent" },
      {
        name: "failed",
        resolver: async () => { throw new Error("private thrown resolver failure"); },
      },
      { name: "wrong-length", resolver: async () => [] },
      {
        name: "malformed",
        resolver: (async () => [poisoned]) as unknown as SharedCaptureSourceResolver,
      },
    ];

    for (const testCase of cases) {
      const result = await readSharedCapture(reader, {
        instanceId: instance.instanceId,
        captureId: "session-1",
        expectedSequence: 7,
        detail: "agent_context",
      }, {}, testCase.resolver);
      const text = readText(result);
      expect(JSON.parse(text).capture.targets[0].grounding.sourceResolution, testCase.name)
        .toEqual({
          schemaVersion: "0.1.0",
          kind: "ui-attach.source-resolution",
          status: "unavailable",
          reason: "workspace_unavailable",
        });
      expect(text, testCase.name).not.toContain("C:/private/workspace");
      expect(text, testCase.name).not.toContain("private-hash");
      expect(text, testCase.name).not.toContain("private resolver failure");
      expect(text, testCase.name).not.toContain("private thrown resolver failure");
    }
  });

  test("preserves multi-target resolver order and rejects a verified result bound to another anchor", async () => {
    const instance = createCaptureInstanceView(7);
    const capture = createCapture();
    const firstBuildId = "G".repeat(43);
    const firstSourceId = "H".repeat(43);
    const secondBuildId = "I".repeat(43);
    const secondSourceId = "J".repeat(43);
    capture.targets[0]!.attachment.sourceAnchor = {
      schemaVersion: "0.1.0",
      kind: "ui-attach.opaque-source-anchor",
      buildId: firstBuildId,
      sourceId: firstSourceId,
    };
    const secondTarget = structuredClone(capture.targets[0]!);
    secondTarget.targetId = "target_B";
    secondTarget.attachmentId = "att_cancel";
    secondTarget.attachment.id = "att_cancel";
    secondTarget.label = "B";
    secondTarget.taskNote = "Move the secondary action.";
    secondTarget.attachment.sourceAnchor = {
      schemaVersion: "0.1.0",
      kind: "ui-attach.opaque-source-anchor",
      buildId: secondBuildId,
      sourceId: secondSourceId,
    };
    capture.targets.push(secondTarget);
    instance.snapshot.attachmentCount = 2;
    instance.snapshot.capture = capture;
    const sourceResolver = vi.fn(async () => [{
      schemaVersion: "0.1.0" as const,
      kind: "ui-attach.source-resolution" as const,
      status: "verified" as const,
      buildId: firstBuildId,
      sourceId: firstSourceId,
      location: {
        path: "src/PrimaryAction.tsx",
        line: 4,
        column: 5,
        tagName: "button",
        componentName: "PrimaryAction",
      },
    }, {
      schemaVersion: "0.1.0" as const,
      kind: "ui-attach.source-resolution" as const,
      status: "verified" as const,
      buildId: firstBuildId,
      sourceId: firstSourceId,
      location: {
        path: "src/WrongTarget.tsx",
        line: 9,
        column: 2,
        tagName: "button",
        componentName: "WrongTarget",
      },
    }]);
    const reader = {
      getStatus: () => { throw new Error("unused"); },
      listInstances: () => [{ instanceId: instance.instanceId, stale: false }],
      readInstance: vi.fn(async () => ({ ok: true as const, value: instance })),
    };

    const result = JSON.parse(readText(await readSharedCapture(reader, {
      instanceId: instance.instanceId,
      captureId: "session-1",
      expectedSequence: 7,
      detail: "agent_context",
      targetIds: ["target_A", "target_B"],
    }, {}, sourceResolver)));

    expect(sourceResolver).toHaveBeenCalledWith([
      { sourceAnchor: capture.targets[0]!.attachment.sourceAnchor },
      { sourceAnchor: secondTarget.attachment.sourceAnchor },
    ]);
    expect(result.capture.targets.map((target: { targetId: string }) => target.targetId))
      .toEqual(["target_A", "target_B"]);
    expect(result.capture.targets[0].grounding.sourceResolution).toMatchObject({
      status: "verified",
      location: { path: "src/PrimaryAction.tsx" },
    });
    expect(result.capture.targets[1].grounding.sourceResolution).toEqual({
      schemaVersion: "0.1.0",
      kind: "ui-attach.source-resolution",
      status: "unavailable",
      reason: "workspace_unavailable",
    });
    expect(JSON.stringify(result)).not.toContain("src/WrongTarget.tsx");
  });

  test("uses the MCP launch directory only when the client has no roots capability", async () => {
    const workspaceRoot = await mkdtemp(join(tmpdir(), "ui-attach-mcp-launch-root-"));
    const unrelatedRoot = await mkdtemp(join(tmpdir(), "ui-attach-mcp-declared-root-"));
    const source = "export function SettingsPanel() {}\n";
    const sourcePath = join(workspaceRoot, "src", "SettingsPanel.tsx");
    const buildId = "C".repeat(43);
    const sourceId = "D".repeat(43);
    const sidecar = createSourceMapSidecar(buildId, [{
      sourceId,
      path: "src/SettingsPanel.tsx",
      line: 1,
      column: 8,
      tagName: "button",
      componentName: "SettingsPanel",
      contentHash: createSourceContentHash(source),
    }]);
    const sidecarPath = join(workspaceRoot, ".ui-attach", "source-map.json");
    await mkdir(dirname(sourcePath), { recursive: true });
    await mkdir(dirname(sidecarPath), { recursive: true });
    await writeFile(sourcePath, source);
    await writeFile(sidecarPath, `${JSON.stringify(sidecar)}\n`);
    const anchor = {
      schemaVersion: "0.1.0",
      kind: "ui-attach.opaque-source-anchor",
      buildId,
      sourceId,
    };

    const launchServer = createLocalBridgeMcpServer(createLocalBridgeState(), {
      launchWorkspaceRoot: workspaceRoot,
    });
    const rootsUnavailableClient = new Client({ name: "codex-like-client", version: "0.1.0" });
    const [launchClientTransport, launchServerTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([
      launchServer.connect(launchServerTransport),
      rootsUnavailableClient.connect(launchClientTransport),
    ]);
    try {
      const result = await rootsUnavailableClient.callTool({
        name: "meanthis_resolve_source",
        arguments: { sourceAnchor: anchor },
      });
      expect(JSON.parse(readText(result))).toMatchObject({
        status: "verified",
        location: { path: "src/SettingsPanel.tsx" },
      });
    } finally {
      await rootsUnavailableClient.close();
      await launchServer.close();
    }

    const declaredServer = createLocalBridgeMcpServer(createLocalBridgeState(), {
      launchWorkspaceRoot: workspaceRoot,
    });
    const declaredClient = new Client(
      { name: "roots-capable-client", version: "0.1.0" },
      { capabilities: { roots: { listChanged: false } } },
    );
    declaredClient.setRequestHandler(ListRootsRequestSchema, async () => ({
      roots: [{ uri: pathToFileURL(unrelatedRoot).href, name: "explicit unrelated root" }],
    }));
    const [declaredClientTransport, declaredServerTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([
      declaredServer.connect(declaredServerTransport),
      declaredClient.connect(declaredClientTransport),
    ]);
    try {
      const result = await declaredClient.callTool({
        name: "meanthis_resolve_source",
        arguments: { sourceAnchor: anchor },
      });
      expect(JSON.parse(readText(result))).toMatchObject({
        status: "unavailable",
        reason: "sidecar_missing",
      });
    } finally {
      await declaredClient.close();
      await declaredServer.close();
      await rm(workspaceRoot, { recursive: true, force: true });
      await rm(unrelatedRoot, { recursive: true, force: true });
    }
  });

  test("lets a second MCP process read one authenticated loopback owner", async () => {
    const state = createLocalBridgeState({
      now: () => new Date("2026-07-17T04:30:00.000Z"),
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
    expect(state.publish(EXTENSION_ORIGIN, paired.value.token, {
      schemaVersion: "0.1.0",
      kind: "ui-attach.local-bridge-snapshot",
      sequence: 1,
      publishedAt: "2026-07-17T04:30:00.000Z",
      page: null,
      attachmentCount: 1,
      agentCopy: "Agent-safe shared handoff.",
    })).toMatchObject({ ok: true });
    const http = await startLocalBridgeHttpServer(state, {
      port: 0,
      agentToken: AGENT_TOKEN,
      ownerIdentity: OWNER_IDENTITY,
    });
    const server = createLocalBridgeMcpServer(createHttpLocalBridgeReader(http.origin, AGENT_TOKEN, {
      expectedOwnerIdentity: OWNER_IDENTITY,
    }), { includeCompatibilityTools: true });
    const client = new Client({ name: "ui-attach-shared-test", version: "0.1.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    try {
      const status = await client.callTool({ name: "ui_attach_bridge_status", arguments: {} });
      expect(readText(status)).not.toContain("Agent-safe shared handoff");
      expect(readText(status)).not.toContain("ownerIdentity");
      expect(readText(status)).not.toContain(OWNER_IDENTITY.buildHash);
      const list = await client.callTool({ name: "ui_attach_list_instances", arguments: {} });
      expect(readText(list)).not.toContain("Agent-safe shared handoff");
      const exact = await client.callTool({
        name: "ui_attach_read_instance",
        arguments: { instanceId: paired.value.instanceId },
      });
      expect(readText(exact)).toContain("Agent-safe shared handoff");
    } finally {
      await client.close();
      await server.close();
      await http.close();
    }
  });

  test("replays V2 annotation identity from authenticated HTTP PUT through the production MCP read entry", async () => {
    const state = createLocalBridgeState({
      now: () => new Date("2026-07-17T04:30:00.000Z"),
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

    const capture = createCapture();
    Object.assign(capture.targets[0]!, V2_ANNOTATION_IDENTITY);
    const snapshot = {
      schemaVersion: "0.1.0" as const,
      kind: "ui-attach.local-bridge-snapshot" as const,
      sequence: 1,
      publishedAt: "2026-07-17T04:30:00.000Z",
      page: {
        pageInstanceId: "chromium-tab:7:frame:0",
        route: "https://example.test/settings",
      },
      attachmentCount: 1,
      agentCopy: "Agent-safe shared handoff.",
      capture,
    };
    const http = await startLocalBridgeHttpServer(state, {
      port: 0,
      agentToken: AGENT_TOKEN,
      ownerIdentity: OWNER_IDENTITY,
    });
    const putSnapshot = (value: unknown) => fetch(`${http.origin}/v1/snapshot`, {
      method: "PUT",
      headers: {
        authorization: `Bearer ${paired.value.token}`,
        "content-type": "application/json",
        origin: EXTENSION_ORIGIN,
      },
      body: JSON.stringify(value),
    });
    const put = await putSnapshot(snapshot);
    expect(put.status).toBe(204);

    const reader = createHttpLocalBridgeReader(http.origin, AGENT_TOKEN, {
      expectedOwnerIdentity: OWNER_IDENTITY,
    });
    const server = createLocalBridgeMcpServer(reader);
    const client = new Client({ name: "ui-attach-v2-annotation-replay", version: "0.1.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    try {
      const listed = await client.callTool({ name: "meanthis_list_captures", arguments: {} });
      const list = JSON.parse(readText(listed));
      expect(list.captures).toHaveLength(1);
      expect(list.captures[0]).toMatchObject({
        instanceId: paired.value.instanceId,
        captureId: "session-1",
        snapshot: { sequence: 1 },
      });

      const selected = list.captures[0];
      const read = await client.callTool({
        name: "meanthis_read_capture",
        arguments: {
          instanceId: selected.instanceId,
          captureId: selected.captureId,
          expectedSequence: selected.snapshot.sequence,
          detail: "summary",
        },
      });
      expect(read.isError).not.toBe(true);
      const terminal = JSON.parse(readText(read));
      expect(terminal.capture.authority).toBe("capture_time");
      expect(terminal.capture.executionAuthority).toEqual({
        grantedByCapture: false,
        browserControl: false,
        liveDomMutation: false,
      });
      expect(terminal.capture.targets[0].annotationIdentity).toEqual({
        annotationId: V2_ANNOTATION_IDENTITY.annotationId,
        annotationIdScope: V2_ANNOTATION_IDENTITY.annotationIdScope,
        createdAt: V2_ANNOTATION_IDENTITY.annotationCreatedAt,
        updatedAt: V2_ANNOTATION_IDENTITY.annotationUpdatedAt,
      });

      const malformed = structuredClone(snapshot);
      malformed.sequence = 2;
      delete (malformed.capture.targets[0] as unknown as Record<string, unknown>).annotationUpdatedAt;
      const malformedPut = await putSnapshot(malformed);
      expect(malformedPut.status).toBe(400);

      const ownUndefined = structuredClone(snapshot);
      ownUndefined.sequence = 2;
      const ownUndefinedTarget = ownUndefined.capture.targets[0] as unknown as Record<string, unknown>;
      ownUndefinedTarget.annotationUpdatedAt = undefined;
      expect(Object.hasOwn(ownUndefinedTarget, "annotationUpdatedAt")).toBe(true);
      expect(state.publish(EXTENSION_ORIGIN, paired.value.token, ownUndefined)).toEqual({
        ok: false,
        code: "INVALID_REQUEST",
      });

      const afterBadRead = await client.callTool({
        name: "meanthis_read_capture",
        arguments: {
          instanceId: selected.instanceId,
          captureId: selected.captureId,
          expectedSequence: 1,
          detail: "summary",
        },
      });
      expect(afterBadRead.isError).not.toBe(true);
      const afterBad = JSON.parse(readText(afterBadRead));
      expect(afterBad.capture.executionAuthority).toEqual({
        grantedByCapture: false,
        browserControl: false,
        liveDomMutation: false,
      });
      expect(afterBad.capture.targets[0].annotationIdentity).toEqual({
        annotationId: V2_ANNOTATION_IDENTITY.annotationId,
        annotationIdScope: V2_ANNOTATION_IDENTITY.annotationIdScope,
        createdAt: V2_ANNOTATION_IDENTITY.annotationCreatedAt,
        updatedAt: V2_ANNOTATION_IDENTITY.annotationUpdatedAt,
      });
      expect(afterBad.capture).not.toHaveProperty("annotationLifecycleVersion");
      expect(afterBad.capture.targets[0]).not.toHaveProperty("annotationLifecycle");

      const v3Handoff = "Agent-safe shared handoff.\r\nV3 preserves exact bytes.";
      const v3Snapshot = structuredClone(snapshot);
      v3Snapshot.sequence = 2;
      v3Snapshot.agentCopy = v3Handoff;
      v3Snapshot.capture = {
        ...v3Snapshot.capture,
        annotationLifecycleVersion: "v1",
        targets: v3Snapshot.capture.targets.map((target) => ({
          ...target,
          annotationLifecycle: {
            state: "resolved" as const,
            resolvedAt: "2026-07-17T04:29:58.000Z",
          },
        })),
      };
      expect((await putSnapshot(v3Snapshot)).status).toBe(204);

      const v3Listed = JSON.parse(readText(await client.callTool({
        name: "meanthis_list_captures",
        arguments: {},
      })));
      expect(v3Listed.captures[0]).toMatchObject({
        instanceId: paired.value.instanceId,
        captureId: "session-1",
        annotationLifecycleVersion: "v1",
        snapshot: { sequence: 2 },
      });
      expect(v3Listed.captures[0]).not.toHaveProperty("targets");
      expect(v3Listed.captures[0]).not.toHaveProperty("annotationLifecycle");

      const v3Read = JSON.parse(readText(await client.callTool({
        name: "meanthis_read_capture",
        arguments: {
          instanceId: paired.value.instanceId,
          captureId: "session-1",
          expectedSequence: 2,
          detail: "handoff",
        },
      })));
      expect(v3Read.capture).toMatchObject({
        annotationLifecycleVersion: "v1",
        executionAuthority: {
          grantedByCapture: false,
          browserControl: false,
          liveDomMutation: false,
        },
        targets: [{
          annotationLifecycle: {
            state: "resolved",
            resolvedAt: "2026-07-17T04:29:58.000Z",
          },
        }],
        handoff: v3Handoff,
      });

      const acceptedV3 = state.readInstance(paired.value.instanceId);
      expect(acceptedV3.ok).toBe(true);
      if (!acceptedV3.ok || !acceptedV3.value.snapshot) return;
      const acceptedV3Bytes = JSON.stringify(acceptedV3.value.snapshot);

      // JSON cannot carry own `undefined`, so HTTP proves the missing-field case.
      const missingLifecycleV3 = structuredClone(v3Snapshot);
      missingLifecycleV3.sequence = 3;
      delete (missingLifecycleV3.capture.targets[0] as unknown as Record<string, unknown>)
        .annotationLifecycle;
      expect((await putSnapshot(missingLifecycleV3)).status).toBe(400);

      const directOwnUndefinedV3 = structuredClone(v3Snapshot);
      directOwnUndefinedV3.sequence = 3;
      const directTarget = directOwnUndefinedV3.capture.targets[0] as unknown as Record<string, unknown>;
      Object.defineProperty(directTarget, "annotationLifecycle", {
        value: undefined,
        enumerable: true,
        writable: true,
        configurable: true,
      });
      let ignoredAccessorCalls = 0;
      Object.defineProperty(directOwnUndefinedV3, "ignoredAccessor", {
        enumerable: false,
        get() {
          ignoredAccessorCalls += 1;
          return "not-readable";
        },
      });
      expect(state.publish(EXTENSION_ORIGIN, paired.value.token, directOwnUndefinedV3)).toEqual({
        ok: false,
        code: "INVALID_REQUEST",
      });
      expect(ignoredAccessorCalls).toBe(0);
      const afterDirectOwnUndefined = state.readInstance(paired.value.instanceId);
      expect(afterDirectOwnUndefined.ok).toBe(true);
      if (!afterDirectOwnUndefined.ok || !afterDirectOwnUndefined.value.snapshot) return;
      expect(JSON.stringify(afterDirectOwnUndefined.value.snapshot)).toBe(acceptedV3Bytes);

      const overboundV3 = structuredClone(v3Snapshot);
      overboundV3.sequence = 3;
      overboundV3.capture.targets[0]!.annotationId = "a".repeat(129);
      expect((await putSnapshot(overboundV3)).status).toBe(400);

      const afterRejectedV3 = JSON.parse(readText(await client.callTool({
        name: "meanthis_read_capture",
        arguments: {
          instanceId: paired.value.instanceId,
          captureId: "session-1",
          expectedSequence: 2,
          detail: "handoff",
        },
      })));
      expect(afterRejectedV3.capture).toMatchObject({
        annotationLifecycleVersion: "v1",
        captureSequence: 2,
        targets: [{ annotationLifecycle: { state: "resolved", resolvedAt: "2026-07-17T04:29:58.000Z" } }],
        handoff: v3Handoff,
      });
    } finally {
      await client.close();
      await server.close();
      await http.close();
    }
  });

  test("fails closed on an authenticated owner from a different build", async () => {
    const state = createLocalBridgeState();
    const http = await startLocalBridgeHttpServer(state, {
      port: 0,
      agentToken: AGENT_TOKEN,
      ownerIdentity: OWNER_IDENTITY,
    });
    const reader = createHttpLocalBridgeReader(http.origin, AGENT_TOKEN, {
      expectedOwnerIdentity: { ...OWNER_IDENTITY, buildHash: "b".repeat(64) },
    });
    try {
      await expect(reader.getStatus()).rejects.toBeInstanceOf(
        AuthenticatedLocalBridgeOwnerIdentityMismatchError,
      );
    } finally {
      await http.close();
    }
  });

  test("revalidates owner identity after the bound port changes owners", async () => {
    const first = await startLocalBridgeHttpServer(createLocalBridgeState(), {
      port: 0,
      agentToken: AGENT_TOKEN,
      ownerIdentity: OWNER_IDENTITY,
    });
    const reader = createHttpLocalBridgeReader(first.origin, AGENT_TOKEN, {
      expectedOwnerIdentity: OWNER_IDENTITY,
    });
    await reader.getStatus();
    const port = Number(new URL(first.origin).port);
    await first.close();

    const replacementIdentity = { ...OWNER_IDENTITY, buildHash: "b".repeat(64) };
    const replacement = await startLocalBridgeHttpServer(createLocalBridgeState(), {
      port,
      agentToken: AGENT_TOKEN,
      ownerIdentity: replacementIdentity,
    });
    try {
      await expect(reader.listInstances()).rejects.toThrow("invalid instance list");
      await expect(reader.readInstance("instance-000000000000"))
        .rejects.toThrow("invalid missing-instance response");
    } finally {
      await replacement.close();
    }
  });

  test("fails closed when a proxy cannot authenticate to the owner", async () => {
    const state = createLocalBridgeState();
    const http = await startLocalBridgeHttpServer(state, {
      port: 0,
      agentToken: AGENT_TOKEN,
      ownerIdentity: OWNER_IDENTITY,
    });
    const wrongToken = "DwsLCwsLCwsLCwsLCwsLCwsLCwsLCwsLCwsLCwsLCws";
    const server = createLocalBridgeMcpServer(createHttpLocalBridgeReader(http.origin, wrongToken, {
      expectedOwnerIdentity: OWNER_IDENTITY,
    }), { includeCompatibilityTools: true });
    const client = new Client({ name: "ui-attach-denied-test", version: "0.1.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    try {
      const status = await client.callTool({ name: "ui_attach_bridge_status", arguments: {} });
      expect(status.isError).toBe(true);
      expect(readText(status)).toContain("BRIDGE_OWNER_UNAVAILABLE");
      expect(readText(status)).not.toMatch(/\d{3}-\d{3}/);
    } finally {
      await client.close();
      await server.close();
      await http.close();
    }
  });

  test("does not disclose its credential to or trust a foreign fixed-port listener", async () => {
    let observedAuthorization: string | undefined;
    const foreign = createServer((request, response) => {
      observedAuthorization = request.headers.authorization;
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({
        schemaVersion: "0.1.0",
        kind: "ui-attach.local-bridge-status",
        origin: `http://127.0.0.1:${(foreign.address() as { port: number }).port}`,
        pairing: {
          code: "111-222",
          expiresAt: "2026-07-17T04:35:00.000Z",
          attemptsRemaining: 5,
          lockedUntil: null,
        },
        instances: [],
      }));
    });
    await new Promise<void>((resolve) => foreign.listen(0, "127.0.0.1", resolve));
    const address = foreign.address();
    if (!address || typeof address === "string") throw new Error("Expected TCP address.");
    const reader = createHttpLocalBridgeReader(`http://127.0.0.1:${address.port}`, AGENT_TOKEN, {
      expectedOwnerIdentity: OWNER_IDENTITY,
    });
    try {
      await expect(reader.getStatus()).rejects.toThrow();
      expect(observedAuthorization).toBeUndefined();
    } finally {
      await new Promise<void>((resolve, reject) => foreign.close((error) => error ? reject(error) : resolve()));
    }
  });

  test("rejects an exact read whose response identifies a different instance", async () => {
    const requested = "instance-000000000000";
    const returned = "instance-111111111111";
    const seenNonces = new Map<string, number>();
    const fetchImpl: typeof fetch = async (input, init) => {
      const url = new URL(typeof input === "string" ? input : input.toString());
      const requestAuth = verifyLocalBridgeAgentRequestAuth(
        AGENT_TOKEN,
        "GET",
        url.pathname,
        new Headers(init?.headers),
        seenNonces,
      );
      if (!requestAuth) return new Response("denied", { status: 401 });
      const body = `${JSON.stringify({
        schemaVersion: "0.1.0",
        kind: "ui-attach.local-bridge-instance",
        ok: true,
        data: {
          instanceId: returned,
          extensionId: MEANTHIS_CHROME_WEB_STORE_EXTENSION_ID,
          connectedAt: "2026-07-17T04:30:00.000Z",
          lastSeenAt: "2026-07-17T04:30:00.000Z",
          stale: false,
          snapshot: {
            schemaVersion: "0.1.0",
            kind: "ui-attach.local-bridge-snapshot",
            sequence: 1,
            publishedAt: "2026-07-17T04:30:00.000Z",
            page: null,
            attachmentCount: 0,
            agentCopy: null,
          },
        },
      })}\n`;
      return new Response(body, {
        status: 200,
        headers: {
          [RESPONSE_PROOF_HEADER]: createLocalBridgeAgentResponseProof(
            AGENT_TOKEN,
            requestAuth,
            200,
            body,
          ),
        },
      });
    };
    const reader = createHttpLocalBridgeReader(
      "http://127.0.0.1:38471",
      AGENT_TOKEN,
      { expectedOwnerIdentity: OWNER_IDENTITY, fetchImpl },
    );

    await expect(reader.readInstance(requested)).rejects.toThrow();
  });
});

function readText(result: Awaited<ReturnType<Client["callTool"]>>): string {
  const first = result.content[0];
  if (!first || first.type !== "text") throw new Error("Expected text tool content.");
  return first.text;
}
