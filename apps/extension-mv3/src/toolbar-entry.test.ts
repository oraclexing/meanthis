import { describe, expect, test, vi } from "vitest";
import type { UiAttachChromeAction } from "./extension-api";
import { createToolbarEntryHandler } from "./toolbar-entry";

const TITLES = {
  readyTitle: "Open MeanThis",
  unsupportedPageTitle: "MeanThis works on HTTP(S) pages. Open a web page and try again.",
  contentUnavailableTitle: "MeanThis could not access this page. Reload it, then select MeanThis again.",
  sidePanelUnavailableTitle: "MeanThis could not open its side panel. Reload the page, then try again.",
};

describe("toolbar entry feedback", () => {
  test("keeps a per-tab error badge when content access fails", async () => {
    const action = createActionHarness();
    const ensureContentScript = vi.fn(async () => false);
    const openSidePanel = vi.fn(async () => undefined);
    const handleClick = createToolbarEntryHandler({
      action,
      ensureContentScript,
      openSidePanel,
      ...TITLES,
    });

    await expect(handleClick({ id: 7, windowId: 3, url: "https://app.example.test/settings" }))
      .resolves.toBe("content_unavailable");

    expect(ensureContentScript).toHaveBeenCalledWith(7, 0);
    expect(openSidePanel).toHaveBeenCalledWith({ windowId: 3 });
    expect(action.setBadgeText).toHaveBeenCalledWith({ tabId: 7, text: "!" });
    expect(action.setTitle).toHaveBeenCalledWith({
      tabId: 7,
      title: TITLES.contentUnavailableTitle,
    });
  });

  test("reports a known unsupported page without probing content and still opens the panel", async () => {
    const action = createActionHarness();
    const ensureContentScript = vi.fn(async () => true);
    const openSidePanel = vi.fn(async () => {
      throw new Error("panel unavailable on restricted page");
    });
    const handleClick = createToolbarEntryHandler({
      action,
      ensureContentScript,
      openSidePanel,
      ...TITLES,
    });

    await expect(handleClick({ id: 7, url: "chrome://extensions/" }))
      .resolves.toBe("unsupported_page");

    expect(ensureContentScript).not.toHaveBeenCalled();
    expect(openSidePanel).toHaveBeenCalledWith({ tabId: 7 });
    expect(action.setBadgeText).toHaveBeenCalledWith({ tabId: 7, text: "!" });
    expect(action.setTitle).toHaveBeenCalledWith({
      tabId: 7,
      title: TITLES.unsupportedPageTitle,
    });
  });

  test("clears stale per-tab feedback after content and panel both become ready", async () => {
    const action = createActionHarness();
    const operations: string[] = [];
    const handleClick = createToolbarEntryHandler({
      action,
      ensureContentScript: vi.fn(async () => {
        operations.push("content-ready");
        return true;
      }),
      openSidePanel: vi.fn(async () => {
        operations.push("panel-open");
      }),
      notifyReady: vi.fn(async () => {
        operations.push("panel-refresh");
      }),
      ...TITLES,
    });

    await handleClick({ id: 7 });

    expect(action.setBadgeText).toHaveBeenCalledWith({ tabId: 7, text: "" });
    expect(action.setTitle).toHaveBeenCalledWith({ tabId: 7, title: "Open MeanThis" });
    expect(operations).toEqual(["content-ready", "panel-open", "panel-refresh"]);
  });

  test("does not refresh an open panel when toolbar access is unavailable", async () => {
    const action = createActionHarness();
    const notifyReady = vi.fn(async () => undefined);
    const handleClick = createToolbarEntryHandler({
      action,
      ensureContentScript: vi.fn(async () => false),
      openSidePanel: vi.fn(async () => undefined),
      notifyReady,
      ...TITLES,
    });

    await expect(handleClick({ id: 7, url: "https://app.example.test/settings" }))
      .resolves.toBe("content_unavailable");

    expect(notifyReady).not.toHaveBeenCalled();
  });

  test("prioritizes a side-panel rejection when content is also unavailable and ignores invalid tab ids", async () => {
    const action = createActionHarness();
    const ensureContentScript = vi.fn(async () => false);
    const openSidePanel = vi.fn(async () => {
      throw new Error("panel unavailable");
    });
    const handleClick = createToolbarEntryHandler({
      action,
      ensureContentScript,
      openSidePanel,
      ...TITLES,
    });

    await expect(handleClick({ id: 7 })).resolves.toBe("side_panel_unavailable");
    await handleClick({ id: -1 });
    await handleClick({});

    expect(action.setBadgeText).toHaveBeenCalledTimes(1);
    expect(action.setBadgeText).toHaveBeenCalledWith({ tabId: 7, text: "!" });
    expect(action.setTitle).toHaveBeenCalledWith({
      tabId: 7,
      title: TITLES.sidePanelUnavailableTitle,
    });
    expect(ensureContentScript).toHaveBeenCalledTimes(1);
    expect(openSidePanel).toHaveBeenCalledTimes(1);
  });

  test("does not let an older failed click overwrite a newer success", async () => {
    const action = createActionHarness();
    const notifyReady = vi.fn(async () => undefined);
    const firstAccess = createDeferred<boolean>();
    const ensureContentScript = vi.fn()
      .mockImplementationOnce(() => firstAccess.promise)
      .mockResolvedValueOnce(true);
    const handleClick = createToolbarEntryHandler({
      action,
      ensureContentScript,
      openSidePanel: vi.fn(async () => undefined),
      notifyReady,
      ...TITLES,
    });

    const older = handleClick({ id: 7 });
    await handleClick({ id: 7 });
    firstAccess.resolve(false);
    await older;

    expect(action.setBadgeText).toHaveBeenCalledTimes(1);
    expect(action.setBadgeText).toHaveBeenLastCalledWith({ tabId: 7, text: "" });
    expect(action.setTitle).toHaveBeenLastCalledWith({ tabId: 7, title: "Open MeanThis" });
    expect(notifyReady).toHaveBeenCalledTimes(1);
  });

  test("does not let an older success clear a newer failed click", async () => {
    const action = createActionHarness();
    const notifyReady = vi.fn(async () => undefined);
    const firstAccess = createDeferred<boolean>();
    const ensureContentScript = vi.fn()
      .mockImplementationOnce(() => firstAccess.promise)
      .mockResolvedValueOnce(false);
    const handleClick = createToolbarEntryHandler({
      action,
      ensureContentScript,
      openSidePanel: vi.fn(async () => undefined),
      notifyReady,
      ...TITLES,
    });

    const older = handleClick({ id: 7 });
    await handleClick({ id: 7 });
    firstAccess.resolve(true);
    await older;

    expect(action.setBadgeText).toHaveBeenCalledTimes(1);
    expect(action.setBadgeText).toHaveBeenLastCalledWith({ tabId: 7, text: "!" });
    expect(action.setTitle).toHaveBeenLastCalledWith({
      tabId: 7,
      title: TITLES.contentUnavailableTitle,
    });
    expect(notifyReady).not.toHaveBeenCalled();
  });
});

function createActionHarness(): UiAttachChromeAction {
  return {
    onClicked: { addListener: vi.fn() },
    setBadgeText: vi.fn(async () => undefined),
    setTitle: vi.fn(async () => undefined),
  };
}

function createDeferred<T>(): {
  promise: Promise<T>;
  resolve(value: T): void;
} {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}
