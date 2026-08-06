import { describe, expect, test, vi } from "vitest";
import {
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
});
