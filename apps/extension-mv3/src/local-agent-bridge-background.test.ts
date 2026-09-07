import { describe, expect, test, vi } from "vitest";
import type { LocalAgentBridgeClient, LocalAgentBridgeStatus } from "./local-agent-bridge";
import {
  LOCAL_AGENT_BRIDGE_REFRESH_ALARM,
  createLocalAgentBridgeBackgroundController,
} from "./local-agent-bridge-background";

describe("local agent bridge background lifecycle", () => {
  test("resumes a pending approval after the side panel closes", async () => {
    const harness = createHarness(pendingStatus());
    harness.bridge.refreshConnectionAndHeartbeat = vi.fn(async () => connectedStatus());
    const controller = createLocalAgentBridgeBackgroundController(harness.dependencies);

    await controller.initialize();
    expect(harness.alarms.create).toHaveBeenCalledWith(
      LOCAL_AGENT_BRIDGE_REFRESH_ALARM,
      { delayInMinutes: 0.5 },
    );

    await controller.handleAlarm({ name: LOCAL_AGENT_BRIDGE_REFRESH_ALARM });

    expect(harness.bridge.refreshConnectionAndHeartbeat).toHaveBeenCalledOnce();
    expect(harness.alarms.create).toHaveBeenLastCalledWith(
      LOCAL_AGENT_BRIDGE_REFRESH_ALARM,
      { delayInMinutes: 0.5 },
    );
  });

  test("clears background work when the browser session disconnects", async () => {
    const harness = createHarness(disconnectedStatus());
    const controller = createLocalAgentBridgeBackgroundController(harness.dependencies);

    await controller.handleSessionStorageChanged({
      "ui-attach.local-agent-bridge.session.v1": { oldValue: { pending: true } },
    }, "session");

    expect(harness.alarms.clear).toHaveBeenCalledWith(LOCAL_AGENT_BRIDGE_REFRESH_ALARM);
    expect(harness.removePermission).toHaveBeenCalledOnce();
    expect(harness.alarms.create).not.toHaveBeenCalled();
  });

  test("fails closed without a retry alarm when bridge state cannot be read", async () => {
    const harness = createHarness(disconnectedStatus());
    harness.bridge.readStatus = vi.fn(async () => {
      throw new Error("session storage unavailable");
    });
    const controller = createLocalAgentBridgeBackgroundController(harness.dependencies);

    await controller.initialize();

    expect(harness.alarms.clear).toHaveBeenCalledWith(LOCAL_AGENT_BRIDGE_REFRESH_ALARM);
    expect(harness.removePermission).toHaveBeenCalledOnce();
    expect(harness.alarms.create).not.toHaveBeenCalled();
  });

  test("fails closed after an alarm refresh error", async () => {
    const harness = createHarness(connectedStatus());
    harness.bridge.refreshConnectionAndHeartbeat = vi.fn(async () => {
      throw new Error("owner unavailable");
    });
    const controller = createLocalAgentBridgeBackgroundController(harness.dependencies);

    await controller.handleAlarm({ name: LOCAL_AGENT_BRIDGE_REFRESH_ALARM });

    expect(harness.alarms.clear).toHaveBeenCalledWith(LOCAL_AGENT_BRIDGE_REFRESH_ALARM);
    expect(harness.removePermission).toHaveBeenCalledOnce();
    expect(harness.alarms.create).not.toHaveBeenCalled();
  });

  test("ignores unrelated alarms and storage changes", async () => {
    const harness = createHarness(pendingStatus());
    const controller = createLocalAgentBridgeBackgroundController(harness.dependencies);

    await controller.handleAlarm({ name: "another-extension-alarm" });
    await controller.handleSessionStorageChanged({ other: { newValue: true } }, "session");
    await controller.handleSessionStorageChanged({
      "ui-attach.local-agent-bridge.session.v1": { newValue: { pending: true } },
    }, "local");

    expect(harness.bridge.readStatus).not.toHaveBeenCalled();
    expect(harness.bridge.refreshConnectionAndHeartbeat).not.toHaveBeenCalled();
    expect(harness.alarms.create).not.toHaveBeenCalled();
    expect(harness.alarms.clear).not.toHaveBeenCalled();
  });
});

function createHarness(initialStatus: LocalAgentBridgeStatus) {
  const bridge: LocalAgentBridgeClient = {
    readStatus: vi.fn(async () => initialStatus),
    createConnectionRequest: vi.fn(),
    refreshConnection: vi.fn(),
    refreshConnectionAndHeartbeat: vi.fn(async () => initialStatus),
    publish: vi.fn(),
    disconnect: vi.fn(),
  };
  const alarms = {
    create: vi.fn(),
    clear: vi.fn(async () => true),
    onAlarm: { addListener: vi.fn() },
  };
  const storage = {
    onChanged: { addListener: vi.fn() },
  };
  const removePermission = vi.fn(async () => true);
  return {
    bridge,
    alarms,
    removePermission,
    dependencies: { bridge, alarms, removePermission, storage },
  };
}

function disconnectedStatus(): LocalAgentBridgeStatus {
  return {
    connected: false,
    instanceId: null,
    pending: false,
    approvalMode: null,
    requestText: null,
    expiresAt: null,
  };
}

function pendingStatus(): LocalAgentBridgeStatus {
  return {
    connected: false,
    instanceId: null,
    pending: true,
    approvalMode: "browser_session",
    requestText: "bounded local request",
    expiresAt: "2026-07-18T01:05:20.431Z",
  };
}

function connectedStatus(): LocalAgentBridgeStatus {
  return {
    connected: true,
    instanceId: "instance-0123456789ab",
    pending: false,
    approvalMode: null,
    requestText: null,
    expiresAt: null,
  };
}
