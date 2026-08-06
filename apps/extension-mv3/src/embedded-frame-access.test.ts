import { describe, expect, test, vi } from "vitest";
import {
  EmbeddedFrameAccessError,
  startEmbeddedFrameSelection,
  type EmbeddedFrameSelectionTarget,
} from "./embedded-frame-access";

const TARGET: EmbeddedFrameSelectionTarget = {
  itemId: "att_frame",
  tabId: 7,
  pageOrigin: "https://host.example.test",
  pagePathname: "/docs",
  parentFrameId: 0,
  frameOrigin: "https://frame.example.test",
  framePathname: "/embedded",
};

const OBSERVED_TARGET = {
  tabId: 7,
  pageOrigin: "https://host.example.test",
  pagePathname: "/docs",
  parentFrameId: 0,
  frameOrigin: "https://redirected.example.test",
  framePathname: "/live",
  requiresHostPermission: true,
};

const SAME_ORIGIN_TARGET: EmbeddedFrameSelectionTarget = {
  itemId: "att_nested_frame",
  tabId: 7,
  pageOrigin: "https://frame.example.test",
  pagePathname: "/outer",
  parentFrameId: 8,
  frameOrigin: "https://frame.example.test",
  framePathname: "/docs/mcp/reference/index.html",
};

describe("embedded frame access", () => {
  test("resolves the live frame route before requesting its exact observed origin", async () => {
    const permissions = createPermissions(false);
    const sendCommand = vi.fn(async (command: { type: string }) => (
      command.type === "ui-attach:embedded-frame-selection-resolve"
        ? { ok: true as const, data: OBSERVED_TARGET }
        : { ok: true as const, data: { enabled: true } }
    ));

    await startEmbeddedFrameSelection({ permissions, sendCommand, target: TARGET });

    expect(sendCommand.mock.calls[0]?.[0]).toEqual({
      type: "ui-attach:embedded-frame-selection-resolve",
      ...TARGET,
    });
    expect(permissions.request).toHaveBeenCalledWith({
      origins: ["https://redirected.example.test/*"],
    });
    expect(sendCommand).toHaveBeenCalledWith({
      type: "ui-attach:embedded-frame-selection-activate",
      itemId: TARGET.itemId,
      sourceFrameOrigin: TARGET.frameOrigin,
      sourceFramePathname: TARGET.framePathname,
      ...activationTarget(OBSERVED_TARGET),
    });
  });

  test("starts the observed-origin request before awaiting the preexisting-permission check", async () => {
    let finishContains!: (value: boolean) => void;
    const permissions = createPermissions(false);
    permissions.contains.mockImplementation(() => new Promise<boolean>((resolve) => {
      finishContains = resolve;
    }));
    const operation = startEmbeddedFrameSelection({
      permissions,
      sendCommand: createSuccessfulSendCommand(),
      target: TARGET,
    });

    await vi.waitFor(() => expect(permissions.request).toHaveBeenCalledWith({
      origins: ["https://frame.example.test/*"],
    }));
    finishContains(false);
    await operation;
  });

  test("requests one exact origin and removes a newly granted permission after exact-frame activation", async () => {
    const permissions = createPermissions(false);
    const sendCommand = createSuccessfulSendCommand();

    await startEmbeddedFrameSelection({ permissions, sendCommand, target: TARGET });

    expect(permissions.request).toHaveBeenCalledWith({
      origins: ["https://frame.example.test/*"],
    });
    expect(sendCommand).toHaveBeenCalledWith({
      type: "ui-attach:embedded-frame-selection-activate",
      itemId: TARGET.itemId,
      sourceFrameOrigin: TARGET.frameOrigin,
      sourceFramePathname: TARGET.framePathname,
      ...activationTarget(resolvedTarget(TARGET)),
    });
    expect(permissions.remove).toHaveBeenCalledWith({
      origins: ["https://frame.example.test/*"],
    });
  });

  test("activates a same-origin child without touching optional permissions when the top-page grant is enough", async () => {
    const permissions = createPermissions(false);
    const observed = resolvedTarget(SAME_ORIGIN_TARGET, false);
    const sendCommand = createSuccessfulSendCommand(observed);

    await startEmbeddedFrameSelection({
      permissions,
      sendCommand,
      target: SAME_ORIGIN_TARGET,
    });

    expect(permissions.contains).not.toHaveBeenCalled();
    expect(permissions.request).not.toHaveBeenCalled();
    expect(permissions.remove).not.toHaveBeenCalled();
    expect(sendCommand).toHaveBeenLastCalledWith({
      type: "ui-attach:embedded-frame-selection-activate",
      itemId: SAME_ORIGIN_TARGET.itemId,
      sourceFrameOrigin: SAME_ORIGIN_TARGET.frameOrigin,
      sourceFramePathname: SAME_ORIGIN_TARGET.framePathname,
      ...activationTarget(observed),
    });
  });

  test("does not revoke a host permission the user already had", async () => {
    const permissions = createPermissions(true);

    await startEmbeddedFrameSelection({
      permissions,
      sendCommand: createSuccessfulSendCommand(),
      target: TARGET,
    });

    expect(permissions.request).toHaveBeenCalledWith({
      origins: ["https://frame.example.test/*"],
    });
    expect(permissions.remove).not.toHaveBeenCalled();
  });

  test("conservatively removes a granted permission when its initial state cannot be read", async () => {
    const permissions = createPermissions(false);
    permissions.contains.mockRejectedValue(new Error("permission state unavailable"));
    const sendCommand = createSuccessfulSendCommand();

    await expect(startEmbeddedFrameSelection({ permissions, sendCommand, target: TARGET }))
      .rejects.toMatchObject({ code: "FRAME_PERMISSION_UNAVAILABLE" });

    expect(sendCommand).toHaveBeenCalledTimes(1);
    expect(sendCommand).toHaveBeenCalledWith({
      type: "ui-attach:embedded-frame-selection-resolve",
      ...TARGET,
    });
    expect(permissions.remove).toHaveBeenCalledWith({
      origins: ["https://frame.example.test/*"],
    });
  });

  test("does not activate the resolved frame when the user denies frame access", async () => {
    const permissions = createPermissions(false);
    permissions.request.mockResolvedValue(false);
    const sendCommand = createSuccessfulSendCommand();

    await expect(startEmbeddedFrameSelection({ permissions, sendCommand, target: TARGET }))
      .rejects.toMatchObject({ code: "FRAME_PERMISSION_DENIED" });
    expect(sendCommand).toHaveBeenCalledTimes(1);
    expect(permissions.remove).not.toHaveBeenCalled();
  });

  test("does not request permission when a delayed live frame resolution fails", async () => {
    const permissions = createPermissions(false);
    const resolution = createDeferred<{
      ok: false;
      code: string;
      error: string;
    }>();
    const sendCommand = vi.fn(async () => resolution.promise);

    const selection = startEmbeddedFrameSelection({ permissions, sendCommand, target: TARGET });
    await vi.waitFor(() => expect(sendCommand).toHaveBeenCalledTimes(1));
    resolution.resolve({
      ok: false,
      code: "FRAME_UNAVAILABLE",
      error: "The selected embedded frame is no longer available.",
    });

    await expect(selection)
      .rejects.toMatchObject({ code: "FRAME_UNAVAILABLE" });
    expect(permissions.contains).not.toHaveBeenCalled();
    expect(permissions.request).not.toHaveBeenCalled();
    expect(permissions.remove).not.toHaveBeenCalled();
  });

  test("stops selection if a newly granted host permission cannot be removed", async () => {
    const permissions = createPermissions(false);
    permissions.remove.mockResolvedValue(false);
    const sendCommand = vi.fn(async (command: { type: string }) => {
      if (command.type === "ui-attach:embedded-frame-selection-resolve") {
        return { ok: true as const, data: resolvedTarget(TARGET) };
      }
      return command.type === "ui-attach:embedded-frame-selection-activate"
        ? { ok: true as const, data: { enabled: true } }
        : { ok: true as const, data: { enabled: false } };
    });

    await expect(startEmbeddedFrameSelection({ permissions, sendCommand, target: TARGET }))
      .rejects.toEqual(expect.objectContaining({
        code: "FRAME_PERMISSION_CLEANUP_FAILED",
      } satisfies Partial<EmbeddedFrameAccessError>));
    expect(sendCommand).toHaveBeenLastCalledWith({
      type: "ui-attach:element-selection-set",
      enabled: false,
    });
  });
});

function createPermissions(alreadyGranted: boolean) {
  return {
    contains: vi.fn(async () => alreadyGranted),
    request: vi.fn(async () => true),
    remove: vi.fn(async () => true),
  };
}

function resolvedTarget(target: EmbeddedFrameSelectionTarget, requiresHostPermission = true) {
  const { itemId: _itemId, ...resolved } = target;
  return { ...resolved, requiresHostPermission };
}

function activationTarget(target: ReturnType<typeof resolvedTarget>) {
  const { requiresHostPermission: _requiresHostPermission, ...resolved } = target;
  return resolved;
}

function createSuccessfulSendCommand(
  observed = resolvedTarget(TARGET),
) {
  return vi.fn(async (command: { type: string }) => (
    command.type === "ui-attach:embedded-frame-selection-resolve"
      ? { ok: true as const, data: observed }
      : { ok: true as const, data: { enabled: true } }
  ));
}

function createDeferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}
