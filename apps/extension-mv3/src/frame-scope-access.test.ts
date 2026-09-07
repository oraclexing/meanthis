import { describe, expect, test, vi } from "vitest";
import {
  createFrameScopeSelectionController,
  FrameScopeAccessError,
  readFrameScopes,
  selectFrameScope,
  type FrameScopeSelectionTarget,
} from "./frame-scope-access";

const TARGET: FrameScopeSelectionTarget = {
  tabId: 7,
  frameId: 5,
  documentId: "inner-document",
  origin: "https://app-companion.example.test",
  pathname: "/docs/mcp/reference",
  requiresHostPermission: true,
};

describe("frame scope access", () => {
  test("reads a validated live frame tree", async () => {
    const sendCommand = vi.fn(async () => ({
      ok: true as const,
      data: {
        tabId: 7,
        currentFrameId: 5,
        scopes: [
          {
            frameId: 0,
            parentFrameId: null,
            documentId: "top-document",
            origin: "https://stitch.example.test",
            pathname: "/docs/mcp/reference",
            depth: 0,
            requiresHostPermission: false,
            selectable: true,
          },
          {
            frameId: 5,
            parentFrameId: 0,
            documentId: "inner-document",
            origin: TARGET.origin,
            pathname: TARGET.pathname,
            depth: 1,
            requiresHostPermission: true,
            selectable: true,
          },
        ],
      },
    }));

    await expect(readFrameScopes(sendCommand)).resolves.toMatchObject({
      currentFrameId: 5,
      scopes: [{ frameId: 0 }, { frameId: 5 }],
    });
    expect(sendCommand).toHaveBeenCalledWith({ type: "ui-attach:frame-scope-list" });
  });

  test("requests only the selected cross-origin scope and releases a new grant", async () => {
    const permissions = {
      contains: vi.fn(async () => false),
      request: vi.fn(async () => true),
      remove: vi.fn(async () => true),
    };
    const sendCommand = vi.fn(async () => ({
      ok: true as const,
      data: { enabled: true },
    }));

    await expect(selectFrameScope({
      permissions,
      sendCommand,
      target: TARGET,
      startSelection: true,
    })).resolves.toBe(true);

    const originPattern = `${TARGET.origin}/*`;
    expect(permissions.contains).toHaveBeenCalledWith({ origins: [originPattern] });
    expect(permissions.request).toHaveBeenCalledWith({ origins: [originPattern] });
    expect(sendCommand).toHaveBeenCalledWith({
      type: "ui-attach:frame-scope-select",
      tabId: TARGET.tabId,
      frameId: TARGET.frameId,
      documentId: TARGET.documentId,
      origin: TARGET.origin,
      pathname: TARGET.pathname,
      startSelection: true,
    });
    expect(permissions.remove).toHaveBeenCalledWith({ origins: [originPattern] });
  });

  test("activates a same-origin scope without requesting optional permission", async () => {
    const permissions = {
      contains: vi.fn(async () => false),
      request: vi.fn(async () => false),
      remove: vi.fn(async () => true),
    };
    const sendCommand = vi.fn(async () => ({
      ok: true as const,
      data: { enabled: true },
    }));

    await selectFrameScope({
      permissions,
      sendCommand,
      target: { ...TARGET, requiresHostPermission: false },
      startSelection: true,
    });

    expect(permissions.contains).not.toHaveBeenCalled();
    expect(permissions.request).not.toHaveBeenCalled();
    expect(permissions.remove).not.toHaveBeenCalled();
  });

  test("fails closed when a newly granted permission cannot be removed", async () => {
    const permissions = {
      contains: vi.fn(async () => false),
      request: vi.fn(async () => true),
      remove: vi.fn(async () => false),
    };
    const sendCommand = vi.fn(async () => ({
      ok: true as const,
      data: { enabled: true },
    }));

    await expect(selectFrameScope({
      permissions,
      sendCommand,
      target: TARGET,
      startSelection: true,
    }))
      .rejects.toEqual(expect.objectContaining({
        code: "FRAME_PERMISSION_CLEANUP_FAILED",
      }) satisfies Partial<FrameScopeAccessError>);
    expect(sendCommand).toHaveBeenLastCalledWith({
      type: "ui-attach:element-selection-set",
      enabled: false,
    });
  });

  test("changes a cross-origin scope without requesting permission when selection stays stopped", async () => {
    const permissions = {
      contains: vi.fn(async () => false),
      request: vi.fn(async () => false),
      remove: vi.fn(async () => true),
    };
    const sendCommand = vi.fn(async () => ({
      ok: true as const,
      data: { enabled: false },
    }));

    await expect(selectFrameScope({
      permissions,
      sendCommand,
      target: TARGET,
      startSelection: false,
    })).resolves.toBe(false);

    expect(permissions.request).not.toHaveBeenCalled();
    expect(sendCommand).toHaveBeenCalledWith({
      type: "ui-attach:frame-scope-select",
      tabId: TARGET.tabId,
      frameId: TARGET.frameId,
      documentId: TARGET.documentId,
      origin: TARGET.origin,
      pathname: TARGET.pathname,
      startSelection: false,
    });
  });

  test("retains a newly granted frame permission for the active selection lifetime", async () => {
    const permissions = {
      contains: vi.fn(async () => false),
      request: vi.fn(async () => true),
      remove: vi.fn(async () => true),
    };
    const selectTarget = vi.fn(async (_target: FrameScopeSelectionTarget, enabled: boolean) => enabled);
    const stopSelection = vi.fn(async () => false);
    const controller = createFrameScopeSelectionController({
      permissions,
      selectTarget,
      stopSelection,
    });

    await expect(controller.select(TARGET, true)).resolves.toBe(true);
    expect(permissions.remove).not.toHaveBeenCalled();

    await expect(controller.stop()).resolves.toBe(false);
    expect(stopSelection).toHaveBeenCalledOnce();
    expect(permissions.remove).toHaveBeenCalledWith({ origins: [`${TARGET.origin}/*`] });
  });

  test("uses a temporary frame permission while switching scope with selection stopped", async () => {
    const permissions = {
      contains: vi.fn(async () => false),
      request: vi.fn(async () => true),
      remove: vi.fn(async () => true),
    };
    let releaseCountDuringSelection = -1;
    const selectTarget = vi.fn(async () => {
      releaseCountDuringSelection = permissions.remove.mock.calls.length;
      return false;
    });
    const controller = createFrameScopeSelectionController({
      permissions,
      selectTarget,
      stopSelection: vi.fn(async () => false),
    });

    await expect(controller.select(TARGET, false)).resolves.toBe(false);

    expect(permissions.request).toHaveBeenCalledWith({ origins: [`${TARGET.origin}/*`] });
    expect(releaseCountDuringSelection).toBe(0);
    expect(selectTarget).toHaveBeenCalledWith(TARGET, false, undefined);
    expect(permissions.remove).toHaveBeenCalledWith({ origins: [`${TARGET.origin}/*`] });
  });

  test("keeps the old permission until a replacement scope is active", async () => {
    const secondOrigin = "https://nested.example.test";
    const permissions = {
      contains: vi.fn(async () => false),
      request: vi.fn(async () => true),
      remove: vi.fn(async () => true),
    };
    let releaseCountAtSecondActivation = -1;
    const selectTarget = vi.fn(async (target: FrameScopeSelectionTarget, enabled: boolean) => {
      if (target.origin === secondOrigin) {
        releaseCountAtSecondActivation = permissions.remove.mock.calls.length;
      }
      return enabled;
    });
    const controller = createFrameScopeSelectionController({
      permissions,
      selectTarget,
      stopSelection: vi.fn(async () => false),
    });

    await controller.select(TARGET, true);
    await controller.select({ ...TARGET, origin: secondOrigin }, true);

    expect(releaseCountAtSecondActivation).toBe(0);
    expect(permissions.remove).toHaveBeenCalledWith({ origins: [`${TARGET.origin}/*`] });
    expect(permissions.remove).not.toHaveBeenCalledWith({ origins: [`${secondOrigin}/*`] });
  });

  test("releases a failed replacement grant without dropping the active scope permission", async () => {
    const secondOrigin = "https://nested.example.test";
    const permissions = {
      contains: vi.fn(async () => false),
      request: vi.fn(async () => true),
      remove: vi.fn(async () => true),
    };
    const selectTarget = vi.fn(async (target: FrameScopeSelectionTarget) => {
      if (target.origin === secondOrigin) throw new FrameScopeAccessError("FRAME_UNAVAILABLE");
      return true;
    });
    const controller = createFrameScopeSelectionController({
      permissions,
      selectTarget,
      stopSelection: vi.fn(async () => false),
    });

    await controller.select(TARGET, true);
    await expect(controller.select({ ...TARGET, origin: secondOrigin }, true))
      .rejects.toMatchObject({ code: "FRAME_UNAVAILABLE" });

    expect(permissions.remove).toHaveBeenCalledWith({ origins: [`${secondOrigin}/*`] });
    expect(permissions.remove).not.toHaveBeenCalledWith({ origins: [`${TARGET.origin}/*`] });
  });

  test("does not let a queued old selection borrow a newer intent after permission acquisition", async () => {
    let generation = 0;
    const token = (expected: number) => ({
      isCurrent: () => generation === expected,
    });
    const oldIntent = token(generation);
    let permissionStarted!: () => void;
    let releasePermissionRequest!: (granted: boolean) => void;
    const permissionStart = new Promise<void>((resolve) => { permissionStarted = resolve; });
    const permissionRequest = new Promise<boolean>((resolve) => {
      releasePermissionRequest = resolve;
    });
    const permissions = {
      contains: vi.fn(async () => false),
      request: vi.fn(async () => {
        permissionStarted();
        return await permissionRequest;
      }),
      remove: vi.fn(async () => true),
    };
    const authoritativeCommands: boolean[] = [];
    const controller = createFrameScopeSelectionController<
      FrameScopeSelectionTarget,
      { isCurrent(): boolean }
    >({
      permissions,
      isOperationCurrent: (intent?: { isCurrent(): boolean }) => intent?.isCurrent() ?? true,
      selectTarget: vi.fn(async (_target: FrameScopeSelectionTarget, enabled: boolean) => {
        authoritativeCommands.push(enabled);
        return enabled;
      }),
      stopSelection: vi.fn(async () => {
        authoritativeCommands.push(false);
        return false;
      }),
    });

    const oldStart = controller.select(TARGET, true, oldIntent);
    await permissionStart;
    const stopIntent = token(++generation);
    const newerStop = controller.stop(stopIntent);
    releasePermissionRequest(true);

    await expect(oldStart).rejects.toMatchObject({ code: "FRAME_SCOPE_OPERATION_CANCELLED" });
    await expect(newerStop).resolves.toBe(false);
    expect(authoritativeCommands).toEqual([false]);
    expect(permissions.remove).toHaveBeenCalledWith({ origins: [`${TARGET.origin}/*`] });
  });

  test("does not request host permission for an operation that became stale in the queue", async () => {
    let generation = 0;
    const token = (expected: number) => ({
      isCurrent: () => generation === expected,
    });
    let releaseActiveSelection!: (enabled: boolean) => void;
    const activeSelection = new Promise<boolean>((resolve) => {
      releaseActiveSelection = resolve;
    });
    let activeSelectionStarted!: () => void;
    const activeStart = new Promise<void>((resolve) => { activeSelectionStarted = resolve; });
    const permissions = {
      contains: vi.fn(async () => false),
      request: vi.fn(async () => true),
      remove: vi.fn(async () => true),
    };
    const selectTarget = vi.fn(async (
      target: FrameScopeSelectionTarget,
      enabled: boolean,
    ) => {
      if (!target.requiresHostPermission) {
        activeSelectionStarted();
        return await activeSelection;
      }
      return enabled;
    });
    const controller = createFrameScopeSelectionController<
      FrameScopeSelectionTarget,
      { isCurrent(): boolean }
    >({
      permissions,
      isOperationCurrent: (intent) => intent?.isCurrent() ?? true,
      selectTarget,
      stopSelection: vi.fn(async () => false),
    });
    const activeIntent = token(generation);
    const active = controller.select({ ...TARGET, requiresHostPermission: false }, true, activeIntent);
    await activeStart;
    const queuedIntent = token(generation);
    const queued = controller.select(TARGET, true, queuedIntent);
    const stopIntent = token(++generation);
    const stopped = controller.stop(stopIntent);

    releaseActiveSelection(true);

    await expect(active).rejects.toMatchObject({ code: "FRAME_SCOPE_OPERATION_CANCELLED" });
    await expect(queued).rejects.toMatchObject({ code: "FRAME_SCOPE_OPERATION_CANCELLED" });
    await expect(stopped).resolves.toBe(false);
    expect(permissions.request).not.toHaveBeenCalled();
    expect(selectTarget).toHaveBeenCalledOnce();
  });
});
