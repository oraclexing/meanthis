import { describe, expect, test, vi } from "vitest";
import type { UiAttachChrome } from "./extension-api";
import { createContentScriptAccess } from "./content-script-access";
import {
  UI_ATTACH_CONTENT_DEACTIVATE,
  UI_ATTACH_CONTENT_PROTOCOL_VERSION,
  isContentReadyGetMessage,
} from "./messages";

describe("user-invoked content-script access", () => {
  test("advertises the capture-diagnostics capable content protocol", () => {
    expect(UI_ATTACH_CONTENT_PROTOCOL_VERSION).toBe(7);
  });

  test("accepts only exact current-protocol ready probes", () => {
    expect(isContentReadyGetMessage({
      type: "ui-attach:content-ready-get",
    })).toBe(false);
    expect(isContentReadyGetMessage({
      type: "ui-attach:content-ready-get",
      protocolVersion: UI_ATTACH_CONTENT_PROTOCOL_VERSION,
    })).toBe(true);
    expect(isContentReadyGetMessage({
      type: "ui-attach:content-ready-get",
      protocolVersion: UI_ATTACH_CONTENT_PROTOCOL_VERSION - 1,
    })).toBe(false);
    expect(isContentReadyGetMessage({
      type: "ui-attach:content-ready-get",
      protocolVersion: UI_ATTACH_CONTENT_PROTOCOL_VERSION,
      extra: true,
    })).toBe(false);
  });

  test("reuses an existing current-protocol exact-frame content endpoint without reinjecting", async () => {
    const chrome = createChromeHarness();
    chrome.tabs.sendMessage = vi.fn(async () => ({ ok: true, data: null }));
    const access = createContentScriptAccess({ chrome });

    await expect(access.ensure(7, 3)).resolves.toBe(true);
    expect(chrome.tabs.sendMessage).toHaveBeenCalledWith(
      7,
      { type: "ui-attach:content-ready-get", protocolVersion: UI_ATTACH_CONTENT_PROTOCOL_VERSION },
      { frameId: 3 },
    );
    expect(chrome.scripting.executeScript).not.toHaveBeenCalled();
  });

  test("injects directly when the requested frame has no receiver, then verifies the current protocol", async () => {
    const chrome = createChromeHarness();
    chrome.tabs.sendMessage = vi.fn()
      .mockRejectedValueOnce(new Error("no receiver"))
      .mockRejectedValueOnce(new Error("no receiver"))
      .mockResolvedValueOnce({ ok: true, data: null });
    const access = createContentScriptAccess({ chrome });

    await expect(access.ensure(7, 3)).resolves.toBe(true);
    expect(chrome.scripting.executeScript).toHaveBeenCalledWith({
      files: ["assets/content.js"],
      target: { tabId: 7, frameIds: [3] },
    });
    expect(chrome.tabs.sendMessage).toHaveBeenCalledTimes(3);
  });

  test("deactivates an old runtime exactly once before injecting and verifying the current runtime", async () => {
    const chrome = createChromeHarness();
    chrome.tabs.sendMessage = vi.fn()
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce({ ok: true, data: null })
      .mockResolvedValueOnce({ ok: true, data: null });
    const access = createContentScriptAccess({ chrome });

    await expect(access.ensure(7, 3)).resolves.toBe(true);

    expect(chrome.tabs.sendMessage).toHaveBeenNthCalledWith(
      1,
      7,
      { type: "ui-attach:content-ready-get", protocolVersion: UI_ATTACH_CONTENT_PROTOCOL_VERSION },
      { frameId: 3 },
    );
    expect(chrome.tabs.sendMessage).toHaveBeenNthCalledWith(
      2,
      7,
      { type: UI_ATTACH_CONTENT_DEACTIVATE },
      { frameId: 3 },
    );
    expect(chrome.tabs.sendMessage).toHaveBeenNthCalledWith(
      3,
      7,
      { type: "ui-attach:content-ready-get", protocolVersion: UI_ATTACH_CONTENT_PROTOCOL_VERSION },
      { frameId: 3 },
    );
    expect(chrome.scripting.executeScript).toHaveBeenCalledWith({
      files: ["assets/content.js"],
      target: { tabId: 7, frameIds: [3] },
    });
    expect(vi.mocked(chrome.tabs.sendMessage).mock.calls.filter(([, message]) => (
      typeof message === "object" && message !== null &&
      "type" in message && message.type === UI_ATTACH_CONTENT_DEACTIVATE
    ))).toHaveLength(1);
    expect(chrome.tabs.sendMessage).toHaveBeenCalledTimes(3);
  });

  test("still injects when neither readiness nor direct deactivation has a listener", async () => {
    const chrome = createChromeHarness();
    chrome.tabs.sendMessage = vi.fn()
      .mockRejectedValueOnce(new Error("no readiness listener"))
      .mockRejectedValueOnce(new Error("no deactivate listener"))
      .mockResolvedValueOnce({ ok: true, data: null });
    const access = createContentScriptAccess({ chrome });

    await expect(access.ensure(7, 3)).resolves.toBe(true);
    expect(chrome.scripting.executeScript).toHaveBeenCalledOnce();
    expect(chrome.tabs.sendMessage).toHaveBeenNthCalledWith(
      2,
      7,
      { type: UI_ATTACH_CONTENT_DEACTIVATE },
      { frameId: 3 },
    );
  });

  test("fails closed on a non-empty malformed deactivation response", async () => {
    const chrome = createChromeHarness();
    chrome.tabs.sendMessage = vi.fn()
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce({ ok: true, data: null, extra: true });
    const access = createContentScriptAccess({ chrome });

    await expect(access.ensure(7, 3)).resolves.toBe(false);
    expect(chrome.scripting.executeScript).not.toHaveBeenCalled();
    expect(chrome.tabs.sendMessage).toHaveBeenCalledTimes(2);
  });

  test("does not inject when both readiness and deactivation resolve undefined", async () => {
    const chrome = createChromeHarness();
    chrome.tabs.sendMessage = vi.fn()
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce(undefined);
    const access = createContentScriptAccess({ chrome });

    await expect(access.ensure(7, 3)).resolves.toBe(false);
    expect(chrome.tabs.sendMessage).toHaveBeenCalledTimes(2);
    expect(chrome.scripting.executeScript).not.toHaveBeenCalled();
  });

  test.each([
    ["bare", true],
    ["wrong", { ok: true, data: null, protocolVersion: 0 }],
    ["malformed", { ok: true }],
  ])("fails closed on a %s non-empty response without replacing it", async (_label, response) => {
    const chrome = createChromeHarness();
    chrome.tabs.sendMessage = vi.fn().mockResolvedValueOnce(response);
    const access = createContentScriptAccess({ chrome });

    await expect(access.ensure(7, 3)).resolves.toBe(false);

    expect(chrome.tabs.sendMessage).toHaveBeenCalledOnce();
    expect(chrome.scripting.executeScript).not.toHaveBeenCalled();
  });

  test("binds restore access checks and injection to the exact document when supplied", async () => {
    const chrome = createChromeHarness();
    chrome.tabs.sendMessage = vi.fn()
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce({ ok: true, data: null })
      .mockResolvedValueOnce({ ok: true, data: null });
    const access = createContentScriptAccess({ chrome });

    await expect(access.ensure(7, 3, "document-exact-01234567")).resolves.toBe(true);

    expect(chrome.tabs.sendMessage).toHaveBeenNthCalledWith(
      1,
      7,
      { type: "ui-attach:content-ready-get", protocolVersion: UI_ATTACH_CONTENT_PROTOCOL_VERSION },
      { documentId: "document-exact-01234567", frameId: 3 },
    );
    expect(chrome.tabs.sendMessage).toHaveBeenNthCalledWith(
      2,
      7,
      { type: UI_ATTACH_CONTENT_DEACTIVATE },
      { documentId: "document-exact-01234567", frameId: 3 },
    );
    expect(chrome.tabs.sendMessage).toHaveBeenNthCalledWith(
      3,
      7,
      { type: "ui-attach:content-ready-get", protocolVersion: UI_ATTACH_CONTENT_PROTOCOL_VERSION },
      { documentId: "document-exact-01234567", frameId: 3 },
    );
    expect(chrome.tabs.sendMessage).toHaveBeenCalledTimes(3);
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
    expect(chrome.tabs.sendMessage).toHaveBeenCalledTimes(3);
  });

  test("shares one frame mutation between concurrent unbound and exact-document checks but re-verifies the exact document", async () => {
    const chrome = createChromeHarness();
    let releaseUnboundProbe!: () => void;
    let releaseExactProbe!: () => void;
    let finishInjection!: () => void;
    let unboundReadyCalls = 0;
    let exactReadyCalls = 0;
    const unboundProbeGate = new Promise<void>((resolve) => {
      releaseUnboundProbe = resolve;
    });
    const exactProbeGate = new Promise<void>((resolve) => {
      releaseExactProbe = resolve;
    });
    const injectionGate = new Promise<void>((resolve) => {
      finishInjection = resolve;
    });
    chrome.tabs.sendMessage = vi.fn(async (
      _tabId: number,
      message: unknown,
      target?: { documentId?: string; frameId?: number },
    ) => {
      if (
        typeof message === "object" && message !== null &&
        "type" in message && message.type === "ui-attach:content-ready-get"
      ) {
        if (target?.documentId) {
          exactReadyCalls += 1;
          if (exactReadyCalls === 1) {
            await exactProbeGate;
            throw new Error("no exact-document receiver");
          }
          throw new Error("exact document remains unavailable after the shared mutation");
        } else {
          unboundReadyCalls += 1;
          if (unboundReadyCalls === 1) {
            await unboundProbeGate;
            throw new Error("no unbound receiver");
          }
        }
        return { ok: true, data: null };
      }
      return { ok: true, data: null };
    });
    chrome.scripting.executeScript = vi.fn(async () => {
      await injectionGate;
      return [];
    });
    const access = createContentScriptAccess({ chrome });

    const unbound = access.ensure(7, 3);
    const exact = access.ensure(7, 3, "document-exact-01234567");
    await vi.waitFor(() => {
      expect(unboundReadyCalls).toBe(1);
      expect(exactReadyCalls).toBe(1);
    });
    releaseUnboundProbe();
    await vi.waitFor(() => expect(chrome.scripting.executeScript).toHaveBeenCalledOnce());
    releaseExactProbe();
    await Promise.resolve();
    finishInjection();

    await expect(Promise.all([unbound, exact])).resolves.toEqual([true, false]);
    expect(chrome.scripting.executeScript).toHaveBeenCalledOnce();
    expect(vi.mocked(chrome.tabs.sendMessage).mock.calls.filter(([, message]) => (
      typeof message === "object" && message !== null &&
      "type" in message && message.type === UI_ATTACH_CONTENT_DEACTIVATE
    ))).toHaveLength(1);
    expect(vi.mocked(chrome.tabs.sendMessage).mock.calls.filter(([, message, target]) => (
      typeof message === "object" && message !== null &&
      "type" in message && message.type === "ui-attach:content-ready-get" &&
      target?.documentId === "document-exact-01234567"
    ))).toHaveLength(2);
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

  test("rejects an injected endpoint that does not return the exact current-protocol readiness shape", async () => {
    const chrome = createChromeHarness();
    chrome.tabs.sendMessage = vi.fn()
      .mockRejectedValueOnce(new Error("no receiver"))
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
