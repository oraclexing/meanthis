import { describe, expect, test, vi } from "vitest";
import {
  AUTOMATIC_PAGE_ACCESS_ORIGINS,
  createAutomaticPageAccessController,
} from "./automatic-page-access";

describe("automatic page access", () => {
  test("reads the persistent HTTP(S) host permission as the switch state", async () => {
    const permissions = createPermissions();
    permissions.contains.mockResolvedValue(true);

    const controller = createAutomaticPageAccessController(createChrome(permissions));

    await expect(controller.read()).resolves.toBe(true);
    expect(permissions.contains).toHaveBeenCalledWith({
      origins: [...AUTOMATIC_PAGE_ACCESS_ORIGINS],
    });
  });

  test("starts the browser permission request directly when enabling", async () => {
    let resolveRequest!: (granted: boolean) => void;
    const permissions = createPermissions();
    permissions.request.mockReturnValue(new Promise<boolean>((resolve) => {
      resolveRequest = resolve;
    }));
    permissions.contains.mockResolvedValue(true);

    const controller = createAutomaticPageAccessController(createChrome(permissions));
    const enabling = controller.setEnabled(true);

    expect(permissions.request).toHaveBeenCalledWith({
      origins: [...AUTOMATIC_PAGE_ACCESS_ORIGINS],
    });
    expect(permissions.contains).not.toHaveBeenCalled();

    resolveRequest(true);
    await expect(enabling).resolves.toBe(true);
    expect(permissions.contains).toHaveBeenCalledTimes(1);
  });

  test("keeps the switch off when Chrome denies the request", async () => {
    const permissions = createPermissions();
    permissions.request.mockResolvedValue(false);

    const controller = createAutomaticPageAccessController(createChrome(permissions));

    await expect(controller.setEnabled(true)).resolves.toBe(false);
    expect(permissions.contains).not.toHaveBeenCalled();
  });

  test("removes the broad permission and verifies that it is gone", async () => {
    const permissions = createPermissions();
    permissions.remove.mockResolvedValue(true);
    permissions.contains.mockResolvedValue(false);

    const operations: string[] = [];
    permissions.remove.mockImplementation(async () => {
      operations.push("remove");
      return true;
    });
    const chrome = createChrome(permissions, operations);
    const controller = createAutomaticPageAccessController(chrome);

    await expect(controller.setEnabled(false)).resolves.toBe(false);
    expect(operations).toEqual(["query", "deactivate:7", "deactivate:8", "remove"]);
    expect(permissions.remove).toHaveBeenCalledWith({
      origins: [...AUTOMATIC_PAGE_ACCESS_ORIGINS],
    });
  });
});

function createPermissions() {
  return {
    contains: vi.fn<(permissions: { origins: string[] }) => Promise<boolean>>(
      async () => false,
    ),
    request: vi.fn<(permissions: { origins: string[] }) => Promise<boolean>>(
      async () => false,
    ),
    remove: vi.fn<(permissions: { origins: string[] }) => Promise<boolean>>(
      async () => false,
    ),
  };
}

function createChrome(
  permissions: ReturnType<typeof createPermissions>,
  operations: string[] = [],
) {
  return {
    permissions,
    tabs: {
      query: vi.fn(async () => {
        operations.push("query");
        return [{ id: 7 }, { id: 8 }, {}];
      }),
      sendMessage: vi.fn(async (tabId: number) => {
        operations.push(`deactivate:${tabId}`);
        return undefined;
      }),
    },
  } as never;
}
