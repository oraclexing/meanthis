import { afterEach, describe, expect, test, vi } from "vitest";
import { createCaptureRecord, createSessionFile } from "../test/session-fixtures";
import {
  LOCAL_AGENT_BRIDGE_RUNTIME_TYPE,
  LocalAgentBridgeRuntimeError,
  createLocalAgentBridgeRuntimeFeature,
  createBrowserLocalAgentBridgeProxy,
  parseLocalAgentBridgeRuntimeCommand,
} from "./local-agent-bridge-runtime";
import type { LocalAgentBridgePublishInput } from "./local-agent-bridge";
import { LocalAgentBridgeBootstrapError } from "./local-agent-bridge-bootstrap";
import { buildPanelBridgeCapture } from "./panel-model";

const V2_ANNOTATION_IDENTITY = {
  annotationId: "annotation:save-v2",
  annotationIdScope: "capture_session" as const,
  annotationCreatedAt: "2026-07-11T10:00:00.000Z",
  annotationUpdatedAt: "2026-07-11T10:00:00.000Z",
};

describe("local agent bridge runtime proxy", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  test("requests loopback permission in the panel before background creation", async () => {
    const calls: string[] = [];
    const status = pendingStatus();
    vi.stubGlobal("chrome", {
      permissions: {
        request: vi.fn(async () => {
          calls.push("permission");
          return true;
        }),
        remove: vi.fn(async () => true),
      },
      runtime: {
        sendMessage: vi.fn(async (command: unknown) => {
          calls.push("background");
          expect(command).toEqual({
            type: LOCAL_AGENT_BRIDGE_RUNTIME_TYPE,
            action: "create-connection-request",
            approvalMode: "browser_session",
          });
          return { ok: true, data: status };
        }),
      },
    });

    await expect(createBrowserLocalAgentBridgeProxy().createConnectionRequest("browser_session"))
      .resolves.toEqual(status);
    expect(calls).toEqual(["permission", "background"]);
  });

  test("accepts the bounded read acknowledgement state across the runtime boundary", async () => {
    const status = { ...pendingStatus(), readAcknowledgementState: "current" as const };
    const sendMessage = vi.fn(async () => ({ ok: true, data: status }));
    vi.stubGlobal("chrome", {
      permissions: { request: vi.fn(async () => true), remove: vi.fn(async () => true) },
      runtime: { sendMessage },
    });

    await expect(createBrowserLocalAgentBridgeProxy().readStatus()).resolves.toEqual(status);
  });

  test.each([
    ["own undefined", { readAcknowledgementState: undefined }],
    ["an unknown enum value", { readAcknowledgementState: "viewed" }],
  ] as const)("rejects read acknowledgement status with %s", async (_label, extra) => {
    const status = { ...pendingStatus(), ...extra };
    vi.stubGlobal("chrome", {
      permissions: { request: vi.fn(async () => true), remove: vi.fn(async () => true) },
      runtime: { sendMessage: vi.fn(async () => ({ ok: true, data: status })) },
    });

    await expect(createBrowserLocalAgentBridgeProxy().readStatus())
      .rejects.toThrow("Local agent bridge returned an invalid status.");
  });

  test("routes session-context publish and clear through distinct bounded commands", async () => {
    const sendMessage = vi.fn(async () => ({ ok: true, data: true }));
    vi.stubGlobal("chrome", {
      permissions: { request: vi.fn(async () => true), remove: vi.fn(async () => true) },
      runtime: { sendMessage },
    });
    const proxy = createBrowserLocalAgentBridgeProxy();
    const input = { page: null, attachmentCount: 0, agentCopy: null };

    await expect(proxy.publishSessionContext(input)).resolves.toBe(true);
    await expect(proxy.clearSessionContext()).resolves.toBe(true);
    await expect(proxy.clearPanelContext()).resolves.toBe(true);

    expect(sendMessage.mock.calls.map(([command]) => command)).toEqual([
      {
        type: LOCAL_AGENT_BRIDGE_RUNTIME_TYPE,
        action: "publish-session-context",
        input,
      },
      {
        type: LOCAL_AGENT_BRIDGE_RUNTIME_TYPE,
        action: "clear-session-context",
      },
      {
        type: LOCAL_AGENT_BRIDGE_RUNTIME_TYPE,
        action: "clear-panel-context",
      },
    ]);
  });

  test("removes loopback permission when the background request fails", async () => {
    const remove = vi.fn(async () => true);
    vi.stubGlobal("chrome", {
      permissions: {
        request: vi.fn(async () => true),
        remove,
      },
      runtime: {
        sendMessage: vi.fn(async () => ({
          ok: false,
          code: "BRIDGE_FAILED",
          error: "safe failure",
        })),
      },
    });

    await expect(createBrowserLocalAgentBridgeProxy().createConnectionRequest("ask"))
      .rejects.toThrow("Local agent bridge action failed");
    expect(remove).toHaveBeenCalledOnce();
  });

  test("preserves only a bounded bootstrap error code across the trusted runtime boundary", async () => {
    const client = {
      readStatus: vi.fn(),
      createConnectionRequest: vi.fn(async () => {
        throw new LocalAgentBridgeBootstrapError("BRIDGE_REPAIR_REQUIRED");
      }),
      refreshConnection: vi.fn(),
      refreshConnectionAndHeartbeat: vi.fn(),
      publish: vi.fn(),
      publishSessionContext: vi.fn(),
      clearSessionContext: vi.fn(),
      clearPanelContext: vi.fn(),
      disconnect: vi.fn(),
    };
    const feature = createLocalAgentBridgeRuntimeFeature(client);
    const command = {
      type: LOCAL_AGENT_BRIDGE_RUNTIME_TYPE,
      action: "create-connection-request",
      approvalMode: "browser_session",
    } as const;

    const response = await feature.handle(command);
    expect(response).toEqual({
      ok: false,
      code: "BRIDGE_REPAIR_REQUIRED",
      error: "The local MeanThis companion is unavailable.",
    });

    vi.stubGlobal("chrome", {
      permissions: { request: vi.fn(async () => true), remove: vi.fn(async () => true) },
      runtime: { sendMessage: vi.fn(async () => response) },
    });
    await expect(createBrowserLocalAgentBridgeProxy().createConnectionRequest("browser_session"))
      .rejects.toEqual(new LocalAgentBridgeRuntimeError("BRIDGE_REPAIR_REQUIRED"));
  });

  test("parses only exact bounded background commands", () => {
    const publish = {
      type: LOCAL_AGENT_BRIDGE_RUNTIME_TYPE,
      action: "publish",
      input: {
        page: {
          pageInstanceId: "chromium-tab:1199972156:frame:0",
          route: "https://aistudio.google.com/prompts/new_chat",
        },
        attachmentCount: 1,
        agentCopy: "# MeanThis Capture Bundle\n\nAgent-safe handoff.",
      },
    };
    expect(parseLocalAgentBridgeRuntimeCommand(publish)).toEqual(publish);
    expect(parseLocalAgentBridgeRuntimeCommand({ ...publish, secret: "do-not-echo" })).toBeNull();
    expect(parseLocalAgentBridgeRuntimeCommand({
      ...publish,
      input: { ...publish.input, attachmentCount: -1 },
    })).toBeNull();

    const publishSessionContext = { ...publish, action: "publish-session-context" };
    expect(parseLocalAgentBridgeRuntimeCommand(publishSessionContext))
      .toEqual(publishSessionContext);
    expect(parseLocalAgentBridgeRuntimeCommand({
      type: LOCAL_AGENT_BRIDGE_RUNTIME_TYPE,
      action: "clear-session-context",
    })).toEqual({
      type: LOCAL_AGENT_BRIDGE_RUNTIME_TYPE,
      action: "clear-session-context",
    });
    expect(parseLocalAgentBridgeRuntimeCommand({
      type: LOCAL_AGENT_BRIDGE_RUNTIME_TYPE,
      action: "clear-panel-context",
    })).toEqual({
      type: LOCAL_AGENT_BRIDGE_RUNTIME_TYPE,
      action: "clear-panel-context",
    });
  });

  test("does not invoke accessors while parsing lifecycle control commands", () => {
    const reference = {
      operationId: "11111111-1111-4111-8111-111111111111",
      fingerprint: "a".repeat(64),
      ownerGeneration: 2,
      connectionGeneration: 3,
    };
    let topLevelGetterCalls = 0;
    const topLevel = Object.defineProperty({}, "type", {
      enumerable: true,
      get() {
        topLevelGetterCalls += 1;
        return LOCAL_AGENT_BRIDGE_RUNTIME_TYPE;
      },
    });
    expect(parseLocalAgentBridgeRuntimeCommand(topLevel)).toBeNull();
    expect(topLevelGetterCalls).toBe(0);

    let nestedGetterCalls = 0;
    const nested = Object.defineProperty({}, "operationId", {
      enumerable: true,
      get() {
        nestedGetterCalls += 1;
        return reference.operationId;
      },
    });
    expect(parseLocalAgentBridgeRuntimeCommand({
      type: LOCAL_AGENT_BRIDGE_RUNTIME_TYPE,
      action: "control-claim",
      reference: nested,
    })).toBeNull();
    expect(nestedGetterCalls).toBe(0);

    expect(parseLocalAgentBridgeRuntimeCommand({
      type: LOCAL_AGENT_BRIDGE_RUNTIME_TYPE,
      action: "control-claim",
      reference,
    })).toEqual({
      type: LOCAL_AGENT_BRIDGE_RUNTIME_TYPE,
      action: "control-claim",
      reference: expect.objectContaining(reference),
    });
  });

  test("accepts legacy annotation groups but rejects partial and own-undefined groups in the runtime parser", () => {
    const save = createCaptureRecord("save", "Save changes");
    const capture = buildPanelBridgeCapture({
      file: createSessionFile([save]),
      attachmentIds: ["att_save"],
      selectedItemId: "att_save",
      selectedRecord: save,
      viewMode: "agent_safe",
      intent: "Shorten the label.",
    }, "capture_time");
    expect(capture).not.toBeNull();
    if (!capture) return;

    const legacyCapture = structuredClone(capture);
    const legacyTarget = legacyCapture.targets[0];
    expect(legacyTarget).toBeDefined();
    if (!legacyTarget) return;
    const legacyTargetValue = legacyTarget as unknown as Record<string, unknown>;
    delete legacyTargetValue.annotationId;
    delete legacyTargetValue.annotationIdScope;
    delete legacyTargetValue.annotationCreatedAt;
    delete legacyTargetValue.annotationUpdatedAt;
    const legacyInput: LocalAgentBridgePublishInput = {
      page: null,
      attachmentCount: 1,
      agentCopy: "Legacy Agent-safe handoff.",
      capture: legacyCapture,
    };
    const legacyCommand = {
      type: LOCAL_AGENT_BRIDGE_RUNTIME_TYPE,
      action: "publish" as const,
      input: legacyInput,
    };

    expect(parseLocalAgentBridgeRuntimeCommand(legacyCommand)).toEqual(legacyCommand);
    expect(legacyCommand.input.capture?.targets[0]).not.toHaveProperty("annotationId");
    expect(legacyCommand.input.capture?.targets[0]).not.toHaveProperty("annotationIdScope");
    expect(legacyCommand.input.capture?.targets[0]).not.toHaveProperty("annotationCreatedAt");
    expect(legacyCommand.input.capture?.targets[0]).not.toHaveProperty("annotationUpdatedAt");

    const partialCommand = {
      ...legacyCommand,
      input: {
        ...legacyInput,
        capture: {
          ...legacyCapture,
          targets: [{ ...legacyTarget, annotationId: V2_ANNOTATION_IDENTITY.annotationId }],
        },
      },
    };
    expect(parseLocalAgentBridgeRuntimeCommand(partialCommand)).toBeNull();

    const ownUndefinedTarget = {
      ...legacyTarget,
      annotationId: undefined,
      annotationIdScope: V2_ANNOTATION_IDENTITY.annotationIdScope,
      annotationCreatedAt: V2_ANNOTATION_IDENTITY.annotationCreatedAt,
      annotationUpdatedAt: V2_ANNOTATION_IDENTITY.annotationUpdatedAt,
    };
    expect(Object.hasOwn(ownUndefinedTarget, "annotationId")).toBe(true);
    const ownUndefinedCommand = {
      ...legacyCommand,
      input: {
        ...legacyInput,
        capture: {
          ...legacyCapture,
          targets: [ownUndefinedTarget],
        },
      },
    };
    expect(parseLocalAgentBridgeRuntimeCommand(ownUndefinedCommand)).toBeNull();
  });

  test("accepts only a complete V3 lifecycle capture at the runtime boundary", () => {
    const save = createCaptureRecord("save", "Save changes");
    const capture = buildPanelBridgeCapture({
      file: createSessionFile([save]),
      attachmentIds: ["att_save"],
      selectedItemId: "att_save",
      selectedRecord: save,
      viewMode: "agent_safe",
      intent: "Shorten the label.",
    }, "capture_time");
    if (!capture) throw new Error("Expected structured capture fixture.");
    const v3 = {
      ...capture,
      annotationLifecycleVersion: "v1" as const,
      updatedAt: "2026-07-11T10:02:00.000Z",
      targets: capture.targets.map((target) => ({
        ...target,
        annotationId: "annotation:save-v3",
        annotationIdScope: "capture_session" as const,
        annotationCreatedAt: "2026-07-11T10:00:00.000Z",
        annotationUpdatedAt: "2026-07-11T10:02:00.000Z",
        annotationLifecycle: { state: "resolved" as const, resolvedAt: "2026-07-11T10:01:00.000Z" },
      })),
    };
    const command = {
      type: LOCAL_AGENT_BRIDGE_RUNTIME_TYPE,
      action: "publish" as const,
      input: { page: null, attachmentCount: 1, agentCopy: null, capture: v3 },
    };
    expect(parseLocalAgentBridgeRuntimeCommand(command)).toEqual(command);
    const malformed = structuredClone(command);
    delete (malformed.input.capture.targets[0] as unknown as Record<string, unknown>)
      .annotationLifecycle;
    expect(parseLocalAgentBridgeRuntimeCommand(malformed)).toBeNull();
  });

  test("dispatches session-context commands to their dedicated client methods", async () => {
    const input = { page: null, attachmentCount: 0, agentCopy: null };
    const client = {
      readStatus: vi.fn(),
      createConnectionRequest: vi.fn(),
      refreshConnection: vi.fn(),
      refreshConnectionAndHeartbeat: vi.fn(),
      publish: vi.fn(),
      publishSessionContext: vi.fn(async () => true),
      clearSessionContext: vi.fn(async () => true),
      clearPanelContext: vi.fn(async () => true),
      disconnect: vi.fn(),
    };
    const feature = createLocalAgentBridgeRuntimeFeature(client);

    await expect(feature.handle({
      type: LOCAL_AGENT_BRIDGE_RUNTIME_TYPE,
      action: "publish-session-context",
      input,
    })).resolves.toEqual({ ok: true, data: true });
    await expect(feature.handle({
      type: LOCAL_AGENT_BRIDGE_RUNTIME_TYPE,
      action: "clear-session-context",
    })).resolves.toEqual({ ok: true, data: true });
    await expect(feature.handle({
      type: LOCAL_AGENT_BRIDGE_RUNTIME_TYPE,
      action: "clear-panel-context",
    })).resolves.toEqual({ ok: true, data: true });

    expect(client.publish).not.toHaveBeenCalled();
    expect(client.publishSessionContext).toHaveBeenCalledWith(input);
    expect(client.clearSessionContext).toHaveBeenCalledOnce();
    expect(client.clearPanelContext).toHaveBeenCalledOnce();
  });

  test("preserves schema-valid completion observations across the runtime boundary", () => {
    const publish = {
      type: LOCAL_AGENT_BRIDGE_RUNTIME_TYPE,
      action: "publish",
      input: {
        page: {
          pageInstanceId: "chromium-tab:1199972156:frame:0",
          route: "https://aistudio.google.com/prompts/new_chat",
        },
        attachmentCount: 1,
        agentCopy: "# MeanThis Capture Bundle\n\nAgent-safe handoff.",
        observations: {
          observedAt: "2026-07-17T04:29:59.000Z",
          documentInstanceId: "0123456789abcdef0123456789abcdef",
          targets: [{ attachmentId: "att_save", status: "restored" }],
        },
      },
    };

    expect(parseLocalAgentBridgeRuntimeCommand(publish)).toEqual(publish);
    expect(parseLocalAgentBridgeRuntimeCommand({
      ...publish,
      input: {
        ...publish.input,
        observations: {
          ...publish.input.observations,
          targets: [{ attachmentId: "att_save", status: "unexpected" }],
        },
      },
    })).toBeNull();
  });

  test("accepts live-page observations independently of the calendar date", () => {
    const save = createCaptureRecord("save", "Save changes");
    const capture = buildPanelBridgeCapture({
      file: createSessionFile([save]),
      attachmentIds: ["att_save"],
      selectedItemId: "att_save",
      selectedRecord: save,
      viewMode: "agent_safe",
      intent: "Shorten the label.",
    }, "live_page");
    expect(capture).not.toBeNull();
    const publish = {
      type: LOCAL_AGENT_BRIDGE_RUNTIME_TYPE,
      action: "publish",
      input: {
        page: {
          pageInstanceId: "chromium-tab:1199980321:frame:0",
          route: "https://app.example.test/settings",
        },
        attachmentCount: 1,
        agentCopy: "# MeanThis Capture Bundle\n\nAgent-safe handoff.",
        capture,
        observations: {
          observedAt: "2026-08-08T02:00:00.000Z",
          documentInstanceId: "0123456789abcdef0123456789abcdef",
          targets: [{ attachmentId: "att_save", status: "restored" }],
        },
      },
    };

    expect(parseLocalAgentBridgeRuntimeCommand(publish)).toEqual(publish);
  });

  test("preserves only bounded saved-restore activity across the runtime boundary", () => {
    const publish = {
      type: LOCAL_AGENT_BRIDGE_RUNTIME_TYPE,
      action: "publish",
      input: {
        page: null,
        attachmentCount: 0,
        agentCopy: null,
        activity: {
          operation: "saved_restore",
          state: "failed",
          stage: "background_response",
          code: "FRAME_PERMISSION_DENIED",
          observedAt: "2026-07-17T04:29:59.000Z",
        },
      },
    };

    expect(parseLocalAgentBridgeRuntimeCommand(publish)).toEqual(publish);
    expect(parseLocalAgentBridgeRuntimeCommand({
      ...publish,
      input: {
        ...publish.input,
        activity: { ...publish.input.activity, code: "private page text" },
      },
    })).toBeNull();
  });
});

function pendingStatus() {
  return {
    connected: false,
    instanceId: null,
    pending: true,
    approvalMode: "browser_session" as const,
    requestText: "bounded request",
    expiresAt: "2026-07-18T01:27:43.939Z",
    sharedTargetCount: null,
    sharedSequence: null,
  };
}
