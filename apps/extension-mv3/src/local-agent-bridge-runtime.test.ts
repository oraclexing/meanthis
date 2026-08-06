import { afterEach, describe, expect, test, vi } from "vitest";
import {
  LOCAL_AGENT_BRIDGE_RUNTIME_TYPE,
  createBrowserLocalAgentBridgeProxy,
  parseLocalAgentBridgeRuntimeCommand,
} from "./local-agent-bridge-runtime";

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
  };
}
