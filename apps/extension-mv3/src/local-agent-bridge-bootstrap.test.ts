import { afterEach, describe, expect, test, vi } from "vitest";
import {
  LOCAL_AGENT_BRIDGE_NATIVE_HOST_NAME,
  LocalAgentBridgeBootstrapError,
  createBrowserLocalAgentBridgeBootstrap,
  createBrowserLocalAgentBridgeRepair,
} from "./local-agent-bridge-bootstrap";

describe("local agent bridge native bootstrap", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  test("sends one fixed bounded start request to the pinned host", async () => {
    const sendNativeMessage = vi.fn(async (_host: string, request: unknown) => ({
      schemaVersion: "0.1.0",
      kind: "ui-attach.native-bridge-start-result",
      requestId: (request as { requestId: string }).requestId,
      ok: true,
      data: { status: "ready" },
    }));
    vi.stubGlobal("chrome", { runtime: { sendNativeMessage } });
    vi.spyOn(crypto, "randomUUID").mockReturnValue("01234567-89ab-4cde-8fab-0123456789ab");

    await expect(createBrowserLocalAgentBridgeBootstrap()()).resolves.toBeUndefined();
    expect(sendNativeMessage).toHaveBeenCalledWith(
      LOCAL_AGENT_BRIDGE_NATIVE_HOST_NAME,
      {
        schemaVersion: "0.1.0",
        kind: "ui-attach.native-bridge-start",
        requestId: "01234567-89ab-4cde-8fab-0123456789ab",
      },
    );
  });

  test("retries one idempotent start when the owners are still converging", async () => {
    const sendNativeMessage = vi.fn()
      .mockImplementationOnce(async (_host: string, request: unknown) => ({
        schemaVersion: "0.1.0",
        kind: "ui-attach.native-bridge-start-result",
        requestId: (request as { requestId: string }).requestId,
        ok: false,
        error: { code: "BRIDGE_START_FAILED" },
      }))
      .mockImplementationOnce(async (_host: string, request: unknown) => ({
        schemaVersion: "0.1.0",
        kind: "ui-attach.native-bridge-start-result",
        requestId: (request as { requestId: string }).requestId,
        ok: true,
        data: { status: "ready" },
      }));
    vi.stubGlobal("chrome", { runtime: { sendNativeMessage } });

    await expect(createBrowserLocalAgentBridgeBootstrap()()).resolves.toBeUndefined();
    expect(sendNativeMessage).toHaveBeenCalledTimes(2);
    expect(sendNativeMessage.mock.calls[0]?.[1]).not.toEqual(sendNativeMessage.mock.calls[1]?.[1]);
  });

  test("uses a distinct fixed request only after the repair action is chosen", async () => {
    const sendNativeMessage = vi.fn(async (_host: string, request: unknown) => ({
      schemaVersion: "0.1.0",
      kind: "ui-attach.native-bridge-start-result",
      requestId: (request as { requestId: string }).requestId,
      ok: true,
      data: { status: "ready" },
    }));
    vi.stubGlobal("chrome", { runtime: { sendNativeMessage } });

    await createBrowserLocalAgentBridgeRepair()();

    expect(sendNativeMessage.mock.calls[0]?.[1]).toMatchObject({
      kind: "ui-attach.native-bridge-repair",
    });
  });

  test.each([
    ["BRIDGE_REPAIR_REQUIRED", "BRIDGE_REPAIR_REQUIRED"],
    ["BRIDGE_SETUP_REQUIRED", "BRIDGE_SETUP_REQUIRED"],
    ["BRIDGE_ACTION_REQUIRED", "BRIDGE_ACTION_REQUIRED"],
    ["BRIDGE_START_FAILED", "BRIDGE_START_FAILED"],
    ["NATIVE_CALLER_FORBIDDEN", "COMPANION_UNAVAILABLE"],
  ] as const)("maps %s to a bounded extension error", async (hostCode, expectedCode) => {
    vi.stubGlobal("chrome", {
      runtime: {
        sendNativeMessage: vi.fn(async (_host: string, request: unknown) => ({
          schemaVersion: "0.1.0",
          kind: "ui-attach.native-bridge-start-result",
          requestId: (request as { requestId: string }).requestId,
          ok: false,
          error: { code: hostCode },
        })),
      },
    });

    await expect(createBrowserLocalAgentBridgeBootstrap()()).rejects.toMatchObject({
      name: "LocalAgentBridgeBootstrapError",
      code: expectedCode,
    });
  });

  test("bounds a native host that never replies", async () => {
    vi.useFakeTimers();
    vi.stubGlobal("chrome", {
      runtime: {
        sendNativeMessage: vi.fn(() => new Promise(() => undefined)),
      },
    });

    const pending = createBrowserLocalAgentBridgeBootstrap({ timeoutMs: 25 })();
    const assertion = expect(pending).rejects.toMatchObject({
      code: "COMPANION_UNAVAILABLE",
    });
    await vi.advanceTimersByTimeAsync(25);
    await assertion;
    vi.useRealTimers();
  });

  test("treats a missing or malformed host as unavailable without echoing diagnostics", async () => {
    vi.stubGlobal("chrome", {
      runtime: {
        sendNativeMessage: vi.fn(async () => {
          throw new Error("Native messaging host path C:\\MeanThisFixture\\missing-host was not found");
        }),
      },
    });

    let error: unknown;
    try {
      await createBrowserLocalAgentBridgeBootstrap()();
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(LocalAgentBridgeBootstrapError);
    expect(error).toMatchObject({ code: "COMPANION_UNAVAILABLE" });
    expect(String(error)).not.toContain("Users");
  });
});
