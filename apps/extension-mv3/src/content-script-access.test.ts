import { describe, expect, test, vi } from "vitest";
import type { UiAttachChrome } from "./extension-api";
import { createContentScriptAccess } from "./content-script-access";

describe("user-invoked content-script access", () => {
  test("reuses an existing exact-frame content endpoint without reinjecting", async () => {
    const chrome = createChromeHarness();
    chrome.tabs.sendMessage = vi.fn(async () => ({ ok: true, data: null }));
    const access = createContentScriptAccess({ chrome });

    await expect(access.ensure(7, 3)).resolves.toBe(true);
    expect(chrome.tabs.sendMessage).toHaveBeenCalledWith(
      7,
      { type: "ui-attach:content-ready-get" },
      { frameId: 3 },
    );
    expect(chrome.scripting.executeScript).not.toHaveBeenCalled();
  });

  test("injects the packaged classic script into only the requested frame, then verifies it", async () => {
    const chrome = createChromeHarness();
    chrome.tabs.sendMessage = vi.fn()
      .mockRejectedValueOnce(new Error("no receiver"))
      .mockResolvedValueOnce({ ok: true, data: null });
    const access = createContentScriptAccess({ chrome });

    await expect(access.ensure(7, 3)).resolves.toBe(true);
    expect(chrome.scripting.executeScript).toHaveBeenCalledWith({
      files: ["assets/content.js"],
      target: { tabId: 7, frameIds: [3] },
    });
    expect(chrome.tabs.sendMessage).toHaveBeenCalledTimes(2);
  });

  test("binds restore access checks and injection to the exact document when supplied", async () => {
    const chrome = createChromeHarness();
    chrome.tabs.sendMessage = vi.fn()
      .mockRejectedValueOnce(new Error("no receiver"))
      .mockResolvedValueOnce({ ok: true, data: null });
    const access = createContentScriptAccess({ chrome });

    await expect(access.ensure(7, 3, "document-exact-01234567")).resolves.toBe(true);

    expect(chrome.tabs.sendMessage).toHaveBeenNthCalledWith(
      1,
      7,
      { type: "ui-attach:content-ready-get" },
      { documentId: "document-exact-01234567", frameId: 3 },
    );
    expect(chrome.scripting.executeScript).toHaveBeenCalledWith({
      files: ["assets/content.js"],
      target: { documentIds: ["document-exact-01234567"], tabId: 7 },
    });
  });

  test("coalesces concurrent access checks for the same tab and frame", async () => {
    const chrome = createChromeHarness();
    let finishInjection!: () => void;
    chrome.tabs.sendMessage = vi.fn()
      .mockRejectedValueOnce(new Error("no receiver"))
      .mockResolvedValueOnce({ ok: true, data: null });
    chrome.scripting.executeScript = vi.fn(() => new Promise((resolve) => {
      finishInjection = () => resolve([]);
    }));
    const access = createContentScriptAccess({ chrome });

    const first = access.ensure(7, 3);
    const second = access.ensure(7, 3);
    await vi.waitFor(() => expect(chrome.scripting.executeScript).toHaveBeenCalledOnce());
    finishInjection();

    await expect(Promise.all([first, second])).resolves.toEqual([true, true]);
    expect(chrome.scripting.executeScript).toHaveBeenCalledOnce();
    expect(chrome.tabs.sendMessage).toHaveBeenCalledTimes(2);
  });

  test("fails closed without exposing injection or endpoint error payloads", async () => {
    const chrome = createChromeHarness();
    chrome.tabs.sendMessage = vi.fn(async () => {
      throw new Error("receiver secret");
    });
    chrome.scripting.executeScript = vi.fn(async () => {
      throw new Error("permission secret");
    });
    const access = createContentScriptAccess({ chrome });

    await expect(access.ensure(7, 0)).resolves.toBe(false);
  });

  test("rejects an injected endpoint that does not return the exact readiness shape", async () => {
    const chrome = createChromeHarness();
    chrome.tabs.sendMessage = vi.fn()
      .mockRejectedValueOnce(new Error("no receiver"))
      .mockResolvedValueOnce({ ok: true, data: null, secret: "unexpected" });
    const access = createContentScriptAccess({ chrome });

    await expect(access.ensure(7, 0)).resolves.toBe(false);
  });
});

function createChromeHarness(): UiAttachChrome {
  return {
    action: {
      onClicked: { addListener: vi.fn() },
      setBadgeText: vi.fn(async () => undefined),
      setTitle: vi.fn(async () => undefined),
    },
    contextMenus: {
      create: vi.fn(),
      onClicked: { addListener: vi.fn() },
      removeAll: vi.fn(),
    },
    runtime: {
      connect: vi.fn(),
      onConnect: { addListener: vi.fn() },
      onInstalled: { addListener: vi.fn() },
      onMessage: { addListener: vi.fn() },
      sendMessage: vi.fn(),
    },
    scripting: { executeScript: vi.fn(async () => []) },
    sidePanel: { open: vi.fn() },
    storage: {
      local: {
        get: vi.fn(),
        remove: vi.fn(),
        set: vi.fn(),
        setAccessLevel: vi.fn(),
      },
      onChanged: { addListener: vi.fn() },
    },
    tabs: {
      onActivated: { addListener: vi.fn() },
      onUpdated: { addListener: vi.fn() },
      query: vi.fn(),
      sendMessage: vi.fn(),
    },
  };
}
