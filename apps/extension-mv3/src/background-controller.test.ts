// @vitest-environment jsdom

import { describe, expect, test, vi } from "vitest";
import { createCaptureRecord, createSessionFile } from "../test/session-fixtures";
import type { OriginCaptureRecord } from "./capture-store";
import type {
  UiAttachChrome,
  UiAttachChromeContextMenuClickData,
  UiAttachChromeMessageSender,
  UiAttachChromePort,
  UiAttachChromeTab,
} from "./extension-api";
import {
  UI_ATTACH_ACTIVE_ORIGIN_CHANGED,
  UI_ATTACH_CAPTURE_FAILED,
  UI_ATTACH_CONTENT_SETTINGS_UPDATED,
  UI_ATTACH_CONTEXT_MENU_ID,
  UI_ATTACH_ELEMENT_SELECTION_UPDATED,
  UI_ATTACH_OVERLAY_PREVIEW,
  UI_ATTACH_OVERLAY_REBIND_STATUS_GET,
  UI_ATTACH_OVERLAY_RELATION_PREVIEW,
  UI_ATTACH_OVERLAY_STATE,
  UI_ATTACH_OVERLAY_VISIBILITY_GET,
  UI_ATTACH_OVERLAY_VISIBILITY_UPDATED,
  UI_ATTACH_PANEL_LIFECYCLE_PORT_PREFIX,
  UI_ATTACH_SELECTION_SEED_CONTEXT_TARGET,
  UI_ATTACH_SESSION_UPDATED,
  isCaptureCommitResponse,
  isEmbeddedFrameHostInspectMessage,
  isEmbeddedFrameHostInspectResponse,
  isOverlayPreviewMessage,
  isOverlayPreviewForPage,
  isOverlayRebindStatusGetMessage,
  isOverlayRebindStatusResponse,
  isOverlayRelationPreviewForPage,
  isOverlayRelationPreviewMessage,
  isOverlayRestoreResponse,
  isOverlayStateMessage,
  type SessionCommand,
  type SessionCommandResponse,
} from "./messages";
import { createBackgroundController as createProductionBackgroundController } from "./background-controller";
import type { FirstCaptureDisclosureStore } from "./first-capture-disclosure";
import type { ActiveSessionReadback, ExtensionSessionStore } from "./session-store";
import type { CaptureToken } from "./session-state";
import type { LocalAgentBridgeClient } from "./local-agent-bridge";
import {
  CONTEXT_MENU_SELECTION_MODE_KEY,
  OVERLAY_VISIBILITY_PREFERENCE_KEY,
} from "./settings-preferences";
import {
  LOCAL_AGENT_BRIDGE_RUNTIME_TYPE,
  createLocalAgentBridgeRuntimeFeature,
} from "./local-agent-bridge-runtime";

const ORIGIN = "https://app.example.test";
const OTHER_ORIGIN = "https://other.example.test";
const FRAME_ORIGIN = "https://frame.example.test";
const TOKEN: CaptureToken = { origin: ORIGIN, epoch: "epoch-1", operationId: "op-1" };
const SAFE_CAPTURE_ERROR = "ui-attach capture failed.";
const SECRET = "sk-test-1234567890";

type TestBackgroundControllerOptions = Omit<
  Parameters<typeof createProductionBackgroundController>[0],
  "firstCaptureDisclosure"
> & {
  firstCaptureDisclosure?: FirstCaptureDisclosureStore;
};

const acknowledgedFirstCaptureDisclosure: FirstCaptureDisclosureStore = {
  isAcknowledged: async () => true,
  acknowledge: async () => undefined,
};

function createBackgroundController(options: TestBackgroundControllerOptions) {
  return createProductionBackgroundController({
    ...options,
    firstCaptureDisclosure:
      options.firstCaptureDisclosure ?? acknowledgedFirstCaptureDisclosure,
  });
}

type EmbeddedFrameSelectionCommand = Extract<
  SessionCommand,
  { type: "ui-attach:embedded-frame-selection-set" }
>;

const EMBEDDED_FRAME_SELECTION_COMMAND: EmbeddedFrameSelectionCommand = {
  type: "ui-attach:embedded-frame-selection-set",
  tabId: 7,
  pageOrigin: ORIGIN,
  pagePathname: "/settings",
  parentFrameId: 0,
  frameOrigin: FRAME_ORIGIN,
  framePathname: "/embedded",
};

function embeddedFrameSelectionCommand(
  overrides: Partial<EmbeddedFrameSelectionCommand> = {},
): EmbeddedFrameSelectionCommand {
  return { ...EMBEDDED_FRAME_SELECTION_COMMAND, ...overrides };
}

function embeddedFrameResolveCommand(overrides: Record<string, unknown> = {}) {
  return {
    type: "ui-attach:embedded-frame-selection-resolve",
    itemId: "att_frame",
    tabId: 7,
    pageOrigin: ORIGIN,
    pagePathname: "/settings",
    parentFrameId: 0,
    frameOrigin: FRAME_ORIGIN,
    framePathname: "/embedded",
    ...overrides,
  } as const;
}

function embeddedFrameActivateCommand(overrides: Record<string, unknown> = {}) {
  return {
    type: "ui-attach:embedded-frame-selection-activate",
    itemId: "att_frame",
    tabId: 7,
    pageOrigin: ORIGIN,
    pagePathname: "/settings",
    parentFrameId: 0,
    sourceFrameOrigin: FRAME_ORIGIN,
    sourceFramePathname: "/embedded",
    frameOrigin: OTHER_ORIGIN,
    framePathname: "/live",
    ...overrides,
  } as const;
}

describe("background session command guards", () => {
  test("blocks context-menu selection before first-capture disclosure acknowledgement", async () => {
    const chrome = createChromeHarness();
    const store = createStoreHarness();
    const ensureContentScript = vi.fn(async () => true);
    const openSidePanel = vi.fn(async () => undefined);
    const firstCaptureDisclosure: FirstCaptureDisclosureStore = {
      isAcknowledged: vi.fn(async () => false),
      acknowledge: vi.fn(async () => undefined),
    };
    const controller = createBackgroundController({
      chrome,
      store,
      ensureContentScript,
      openSidePanel,
      firstCaptureDisclosure,
    });

    await controller.handleContextMenuClick(
      createContextInfo(),
      { id: 7, url: `${ORIGIN}/settings` },
    );

    expect(firstCaptureDisclosure.isAcknowledged).toHaveBeenCalledTimes(1);
    expect(openSidePanel).toHaveBeenCalledWith({ tabId: 7 });
    expect(ensureContentScript).not.toHaveBeenCalled();
    expect(store.beginCapture).not.toHaveBeenCalled();
    expect(chrome.tabs.sendMessage).not.toHaveBeenCalled();
  });

  test("does not read disclosure authority before trusted storage access is ready", async () => {
    const chrome = createChromeHarness();
    const store = createStoreHarness();
    const ensureContentScript = vi.fn(async () => true);
    const openSidePanel = vi.fn(async () => undefined);
    const firstCaptureDisclosure: FirstCaptureDisclosureStore = {
      isAcknowledged: vi.fn(async () => true),
      acknowledge: vi.fn(async () => undefined),
    };
    const controller = createBackgroundController({
      chrome,
      store,
      ensureContentScript,
      openSidePanel,
      firstCaptureDisclosure,
      storageAccessReady: Promise.resolve(false),
    });

    await controller.handleContextMenuClick(
      createContextInfo(),
      { id: 7, url: `${ORIGIN}/settings` },
    );

    expect(firstCaptureDisclosure.isAcknowledged).not.toHaveBeenCalled();
    expect(openSidePanel).toHaveBeenCalledWith({ tabId: 7 });
    expect(ensureContentScript).not.toHaveBeenCalled();
    expect(store.beginCapture).not.toHaveBeenCalled();
    expect(chrome.runtime.sentMessages).toContainEqual({
      type: UI_ATTACH_CAPTURE_FAILED,
      error: SAFE_CAPTURE_ERROR,
    });
  });

  test("blocks selection enable but allows disable before first-capture disclosure acknowledgement", async () => {
    const chrome = createChromeHarness();
    chrome.tabs.query = vi.fn(async () => [{ id: 7, url: `${ORIGIN}/settings`, windowId: 1 }]);
    chrome.tabs.sendMessage = vi.fn(async () => undefined);
    const ensureContentScript = vi.fn(async () => true);
    const firstCaptureDisclosure: FirstCaptureDisclosureStore = {
      isAcknowledged: vi.fn(async () => false),
      acknowledge: vi.fn(async () => undefined),
    };
    const controller = createBackgroundController({
      chrome,
      store: createStoreHarness(),
      ensureContentScript,
      firstCaptureDisclosure,
    });

    await expect(dispatchRuntime(
      controller,
      { type: "ui-attach:element-selection-set", enabled: true, tabId: 7 },
      createExtensionSender(),
    )).resolves.toMatchObject({ ok: false, code: "DISCLOSURE_REQUIRED" });
    expect(ensureContentScript).not.toHaveBeenCalled();

    await expect(dispatchRuntime(
      controller,
      { type: "ui-attach:element-selection-set", enabled: false },
      createExtensionSender(),
    )).resolves.toEqual({ ok: true, data: { enabled: false } });
  });

  test("enables selection only in the unique direct embedded frame", async () => {
    const chrome = createChromeHarness();
    chrome.tabs.query = vi.fn(async () => [{ id: 7, url: `${ORIGIN}/settings`, windowId: 1 }]);
    chrome.tabs.sendMessage = vi.fn(async () => undefined);
    chrome.webNavigation.getAllFrames = vi.fn(async () => [
      { frameId: 0, parentFrameId: -1, url: `${ORIGIN}/settings`, documentId: "top-doc" },
      { frameId: 3, parentFrameId: 0, url: `${FRAME_ORIGIN}/embedded`, documentId: "frame-doc" },
    ]);
    chrome.webNavigation.getFrame = vi.fn(async () => ({
      parentFrameId: 0,
      url: `${FRAME_ORIGIN}/embedded`,
      documentId: "frame-doc",
    }));
    const ensureContentScript = vi.fn(async () => true);
    const controller = createBackgroundController({
      chrome,
      store: createStoreHarness(),
      ensureContentScript,
    });

    await expect(dispatchRuntime(
      controller,
      embeddedFrameSelectionCommand(),
      createExtensionSender(),
    )).resolves.toEqual({ ok: true, data: { enabled: true } });

    expect(ensureContentScript).toHaveBeenCalledWith(7, 3);
    expect(chrome.tabs.sendMessage).toHaveBeenCalledWith(7, expect.objectContaining({
      testClickCaptureEnabled: true,
    }), { documentId: "frame-doc", frameId: 3 });
    expect(chrome.tabs.sendMessage).not.toHaveBeenCalledWith(7, expect.objectContaining({
      testClickCaptureEnabled: true,
    }), { frameId: 0 });

    const wrongDocumentCapture = await dispatchRuntime(controller, {
      type: "ui-attach:session-begin-capture",
    }, {
      documentId: "replacement-doc",
      frameId: 3,
      url: `${FRAME_ORIGIN}/embedded`,
      tab: { id: 7, url: `${ORIGIN}/settings` },
    });
    expect(wrongDocumentCapture).toMatchObject({ ok: false, code: "SELECTION_NOT_ACTIVE" });

    const wrongDocumentDisable = await dispatchRuntime(controller, {
      type: "ui-attach:content-selection-disable",
    }, {
      documentId: "replacement-doc",
      frameId: 3,
      url: `${FRAME_ORIGIN}/embedded`,
      tab: { id: 7, url: `${ORIGIN}/settings` },
    });
    expect(wrongDocumentDisable).toMatchObject({ ok: false, code: "SELECTION_NOT_ACTIVE" });

    const selectedDocumentCapture = await dispatchRuntime(controller, {
      type: "ui-attach:session-begin-capture",
    }, {
      documentId: "frame-doc",
      frameId: 3,
      url: `${FRAME_ORIGIN}/embedded`,
      tab: { id: 7, url: `${ORIGIN}/settings` },
    });
    expect(selectedDocumentCapture).toMatchObject({ ok: true });

    const wrongFrameCapture = await dispatchRuntime(controller, {
      type: "ui-attach:session-begin-capture",
    }, {
      frameId: 4,
      url: `${FRAME_ORIGIN}/embedded`,
      tab: { id: 7, url: `${ORIGIN}/settings` },
    });
    expect(wrongFrameCapture).toMatchObject({ ok: false, code: "SELECTION_NOT_ACTIVE" });
  });

  test("uses the captured pathname to distinguish same-origin sibling frames", async () => {
    const chrome = createChromeHarness();
    chrome.tabs.query = vi.fn(async () => [{ id: 7, url: `${ORIGIN}/settings`, windowId: 1 }]);
    chrome.tabs.sendMessage = vi.fn(async () => undefined);
    chrome.webNavigation.getAllFrames = vi.fn(async () => [
      { frameId: 0, parentFrameId: -1, url: `${ORIGIN}/settings`, documentId: "top-doc" },
      { frameId: 3, parentFrameId: 0, url: `${FRAME_ORIGIN}/one`, documentId: "one-doc" },
      { frameId: 4, parentFrameId: 0, url: `${FRAME_ORIGIN}/two`, documentId: "two-doc" },
    ]);
    chrome.webNavigation.getFrame = vi.fn(async ({ frameId }) => frameId === 0
      ? { parentFrameId: -1, url: `${ORIGIN}/settings`, documentId: "top-doc" }
      : { parentFrameId: 0, url: `${FRAME_ORIGIN}/two`, documentId: "two-doc" });
    const ensureContentScript = vi.fn(async () => true);
    const controller = createBackgroundController({
      chrome,
      store: createStoreHarness(),
      ensureContentScript,
    });

    await expect(dispatchRuntime(
      controller,
      embeddedFrameSelectionCommand({ framePathname: "/two" }),
      createExtensionSender(),
    )).resolves.toEqual({ ok: true, data: { enabled: true } });
    expect(ensureContentScript).toHaveBeenCalledWith(7, 4);
  });

  test("resolves a redirected live route only from one replayed host and one live child", async () => {
    const chrome = createChromeHarness();
    const store = createStoreHarness();
    const record = createEmbeddedFrameRecord();
    store.read = vi.fn(async () => ({ ok: true, value: createSessionReadback(record) }));
    chrome.tabs.query = vi.fn(async () => [{ id: 7, url: `${ORIGIN}/settings`, windowId: 1 }]);
    chrome.webNavigation.getAllFrames = vi.fn(async () => [
      { frameId: 0, parentFrameId: -1, url: `${ORIGIN}/settings`, documentId: "top-doc" },
      {
        frameId: 3,
        parentFrameId: 0,
        url: `${OTHER_ORIGIN}/live?token=secret#private`,
        documentId: "frame-doc",
      },
    ]);
    chrome.tabs.sendMessage = vi.fn(async (_tabId, message) => (
      isRecord(message) && message.type === "ui-attach:embedded-frame-host-inspect"
        ? {
            ok: true,
            data: {
              frameHostCount: 1,
              frameOrigin: FRAME_ORIGIN,
              framePathname: "/embedded",
            },
          }
        : undefined
    ));
    const controller = createBackgroundController({ chrome, store });

    await expect(dispatchRuntime(
      controller,
      embeddedFrameResolveCommand(),
      createExtensionSender(),
    )).resolves.toEqual({
      ok: true,
      data: {
        tabId: 7,
        pageOrigin: ORIGIN,
        pagePathname: "/settings",
        parentFrameId: 0,
        frameOrigin: OTHER_ORIGIN,
        framePathname: "/live",
        requiresHostPermission: true,
      },
    });
    expect(chrome.tabs.sendMessage).toHaveBeenCalledWith(7, {
      type: "ui-attach:embedded-frame-host-inspect",
      locators: expect.arrayContaining([expect.objectContaining({
        strategy: "playwright.title",
        value: 'page.getByTitle("Documentation")',
      })]),
    }, { documentId: "top-doc", frameId: 0 });
    expect(JSON.stringify(await dispatchRuntime(
      controller,
      embeddedFrameResolveCommand(),
      createExtensionSender(),
    ))).not.toContain("secret");
  });

  test("keeps exact route disambiguation without requiring the single-host fallback", async () => {
    const chrome = createChromeHarness();
    const store = createStoreHarness();
    const record = createEmbeddedFrameRecord();
    store.read = vi.fn(async () => ({ ok: true, value: createSessionReadback(record) }));
    chrome.tabs.query = vi.fn(async () => [{ id: 7, url: `${ORIGIN}/settings`, windowId: 1 }]);
    chrome.webNavigation.getAllFrames = vi.fn(async () => [
      { frameId: 0, parentFrameId: -1, url: `${ORIGIN}/settings`, documentId: "top-doc" },
      { frameId: 3, parentFrameId: 0, url: `${FRAME_ORIGIN}/embedded`, documentId: "frame-doc" },
      { frameId: 4, parentFrameId: 0, url: `${FRAME_ORIGIN}/other`, documentId: "other-doc" },
    ]);
    chrome.tabs.sendMessage = vi.fn(async () => {
      throw new Error("host inspection must not run for an exact route");
    });
    const controller = createBackgroundController({ chrome, store });

    await expect(dispatchRuntime(
      controller,
      embeddedFrameResolveCommand(),
      createExtensionSender(),
    )).resolves.toEqual({
      ok: true,
      data: {
        tabId: 7,
        pageOrigin: ORIGIN,
        pagePathname: "/settings",
        parentFrameId: 0,
        frameOrigin: FRAME_ORIGIN,
        framePathname: "/embedded",
        requiresHostPermission: true,
      },
    });
    expect(chrome.tabs.sendMessage).not.toHaveBeenCalled();
  });

  test("rejects an exact route that navigates while the stored boundary is being read", async () => {
    const chrome = createChromeHarness();
    const store = createStoreHarness();
    const record = createEmbeddedFrameRecord();
    const delayedRead = createDeferred<{ ok: true; value: ActiveSessionReadback }>();
    store.read = vi.fn(async () => delayedRead.promise);
    chrome.tabs.query = vi.fn(async () => [{ id: 7, url: `${ORIGIN}/settings`, windowId: 1 }]);
    let frames = [
      { frameId: 0, parentFrameId: -1, url: `${ORIGIN}/settings`, documentId: "top-doc" },
      { frameId: 3, parentFrameId: 0, url: `${FRAME_ORIGIN}/embedded`, documentId: "frame-doc" },
    ];
    chrome.webNavigation.getAllFrames = vi.fn(async () => frames);
    const controller = createBackgroundController({ chrome, store });

    const resolution = dispatchRuntime(
      controller,
      embeddedFrameResolveCommand(),
      createExtensionSender(),
    );
    await vi.waitFor(() => expect(store.read).toHaveBeenCalled());
    frames = [
      { frameId: 0, parentFrameId: -1, url: `${ORIGIN}/settings`, documentId: "top-doc" },
      { frameId: 3, parentFrameId: 0, url: `${OTHER_ORIGIN}/changed`, documentId: "changed-doc" },
    ];
    delayedRead.resolve({ ok: true, value: createSessionReadback(record) });

    await expect(resolution).resolves.toMatchObject({ ok: false, code: "FRAME_UNAVAILABLE" });
    expect(chrome.webNavigation.getAllFrames).toHaveBeenCalledTimes(2);
  });

  test("rejects a fallback child that navigates while its host is being inspected", async () => {
    const chrome = createChromeHarness();
    const store = createStoreHarness();
    const record = createEmbeddedFrameRecord();
    store.read = vi.fn(async () => ({ ok: true, value: createSessionReadback(record) }));
    chrome.tabs.query = vi.fn(async () => [{ id: 7, url: `${ORIGIN}/settings`, windowId: 1 }]);
    let frames = [
      { frameId: 0, parentFrameId: -1, url: `${ORIGIN}/settings`, documentId: "top-doc" },
      { frameId: 3, parentFrameId: 0, url: `${OTHER_ORIGIN}/live`, documentId: "frame-doc" },
    ];
    chrome.webNavigation.getAllFrames = vi.fn(async () => frames);
    const delayedInspection = createDeferred<unknown>();
    chrome.tabs.sendMessage = vi.fn(async () => delayedInspection.promise);
    const controller = createBackgroundController({ chrome, store });

    const resolution = dispatchRuntime(
      controller,
      embeddedFrameResolveCommand(),
      createExtensionSender(),
    );
    await vi.waitFor(() => expect(chrome.tabs.sendMessage).toHaveBeenCalled());
    frames = [
      { frameId: 0, parentFrameId: -1, url: `${ORIGIN}/settings`, documentId: "top-doc" },
      { frameId: 3, parentFrameId: 0, url: `${OTHER_ORIGIN}/changed`, documentId: "changed-doc" },
    ];
    delayedInspection.resolve({
      ok: true,
      data: {
        frameHostCount: 1,
        frameOrigin: FRAME_ORIGIN,
        framePathname: "/embedded",
      },
    });

    await expect(resolution).resolves.toMatchObject({ ok: false, code: "FRAME_UNAVAILABLE" });
    expect(chrome.webNavigation.getAllFrames).toHaveBeenCalledTimes(2);
  });

  test("rejects a top pathname change observed only by the final fresh frame tree", async () => {
    const chrome = createChromeHarness();
    const store = createStoreHarness();
    const record = createEmbeddedFrameRecord();
    store.read = vi.fn(async () => ({ ok: true, value: createSessionReadback(record) }));
    chrome.tabs.query = vi.fn(async () => [{ id: 7, url: `${ORIGIN}/settings`, windowId: 1 }]);
    chrome.webNavigation.getAllFrames = vi.fn()
      .mockResolvedValueOnce([
        { frameId: 0, parentFrameId: -1, url: `${ORIGIN}/settings`, documentId: "top-doc" },
        { frameId: 3, parentFrameId: 0, url: `${FRAME_ORIGIN}/embedded`, documentId: "frame-doc" },
      ])
      .mockResolvedValueOnce([
        { frameId: 0, parentFrameId: -1, url: `${ORIGIN}/other`, documentId: "top-doc" },
        { frameId: 3, parentFrameId: 0, url: `${FRAME_ORIGIN}/embedded`, documentId: "frame-doc" },
      ]);
    const controller = createBackgroundController({ chrome, store });

    await expect(dispatchRuntime(
      controller,
      embeddedFrameResolveCommand(),
      createExtensionSender(),
    )).resolves.toMatchObject({ ok: false, code: "FRAME_UNAVAILABLE" });
    expect(chrome.webNavigation.getAllFrames).toHaveBeenCalledTimes(2);
  });

  test("re-resolves after permission and rejects a changed observed route before activation", async () => {
    const chrome = createChromeHarness();
    const store = createStoreHarness();
    const record = createEmbeddedFrameRecord();
    store.read = vi.fn(async () => ({ ok: true, value: createSessionReadback(record) }));
    chrome.tabs.query = vi.fn(async () => [{ id: 7, url: `${ORIGIN}/settings`, windowId: 1 }]);
    chrome.webNavigation.getAllFrames = vi.fn(async () => [
      { frameId: 0, parentFrameId: -1, url: `${ORIGIN}/settings`, documentId: "top-doc" },
      { frameId: 3, parentFrameId: 0, url: `${OTHER_ORIGIN}/changed`, documentId: "frame-doc" },
    ]);
    chrome.tabs.sendMessage = vi.fn(async () => ({
      ok: true,
      data: {
        frameHostCount: 1,
        frameOrigin: FRAME_ORIGIN,
        framePathname: "/embedded",
      },
    }));
    const ensureContentScript = vi.fn(async () => true);
    const controller = createBackgroundController({ chrome, store, ensureContentScript });

    await expect(dispatchRuntime(
      controller,
      embeddedFrameActivateCommand(),
      createExtensionSender(),
    )).resolves.toMatchObject({ ok: false, code: "FRAME_UNAVAILABLE" });
    expect(ensureContentScript).not.toHaveBeenCalled();
  });

  test("leases the exact document identity returned by the post-permission resolution", async () => {
    const chrome = createChromeHarness();
    const store = createStoreHarness();
    const record = createEmbeddedFrameRecord();
    store.read = vi.fn(async () => ({ ok: true, value: createSessionReadback(record) }));
    chrome.tabs.query = vi.fn(async () => [{ id: 7, url: `${ORIGIN}/settings`, windowId: 1 }]);
    chrome.webNavigation.getAllFrames = vi.fn(async () => [
      { frameId: 0, parentFrameId: -1, url: `${ORIGIN}/settings`, documentId: "top-doc" },
      { frameId: 3, parentFrameId: 0, url: `${OTHER_ORIGIN}/live`, documentId: "observed-doc" },
    ]);
    chrome.webNavigation.getFrame = vi.fn(async () => ({
      parentFrameId: 0,
      url: `${OTHER_ORIGIN}/live`,
      documentId: "observed-doc",
    }));
    chrome.tabs.sendMessage = vi.fn(async (_tabId, message) => (
      isRecord(message) && message.type === "ui-attach:embedded-frame-host-inspect"
        ? {
            ok: true,
            data: {
              frameHostCount: 1,
              frameOrigin: FRAME_ORIGIN,
              framePathname: "/embedded",
            },
          }
        : undefined
    ));
    const ensureContentScript = vi.fn(async () => true);
    const controller = createBackgroundController({ chrome, store, ensureContentScript });

    await expect(dispatchRuntime(
      controller,
      embeddedFrameActivateCommand(),
      createExtensionSender(),
    )).resolves.toEqual({ ok: true, data: { enabled: true } });
    expect(chrome.webNavigation.getAllFrames).toHaveBeenCalledTimes(2);
    expect(ensureContentScript).toHaveBeenCalledWith(7, 3);
  });

  test("does not map a changed route when the parent has more than one frame host", async () => {
    const chrome = createChromeHarness();
    const store = createStoreHarness();
    const record = createEmbeddedFrameRecord();
    store.read = vi.fn(async () => ({ ok: true, value: createSessionReadback(record) }));
    chrome.tabs.query = vi.fn(async () => [{ id: 7, url: `${ORIGIN}/settings`, windowId: 1 }]);
    chrome.webNavigation.getAllFrames = vi.fn(async () => [
      { frameId: 0, parentFrameId: -1, url: `${ORIGIN}/settings`, documentId: "top-doc" },
      { frameId: 3, parentFrameId: 0, url: `${OTHER_ORIGIN}/live`, documentId: "frame-doc" },
    ]);
    chrome.tabs.sendMessage = vi.fn(async () => ({
      ok: true,
      data: {
        frameHostCount: 2,
        frameOrigin: FRAME_ORIGIN,
        framePathname: "/embedded",
      },
    }));
    const controller = createBackgroundController({ chrome, store });

    await expect(dispatchRuntime(
      controller,
      embeddedFrameResolveCommand(),
      createExtensionSender(),
    )).resolves.toMatchObject({ ok: false, code: "FRAME_UNAVAILABLE" });
  });

  test("does not map one replayed host onto more than one live child", async () => {
    const chrome = createChromeHarness();
    const store = createStoreHarness();
    const record = createEmbeddedFrameRecord();
    store.read = vi.fn(async () => ({ ok: true, value: createSessionReadback(record) }));
    chrome.tabs.query = vi.fn(async () => [{ id: 7, url: `${ORIGIN}/settings`, windowId: 1 }]);
    chrome.webNavigation.getAllFrames = vi.fn(async () => [
      { frameId: 0, parentFrameId: -1, url: `${ORIGIN}/settings`, documentId: "top-doc" },
      { frameId: 3, parentFrameId: 0, url: `${OTHER_ORIGIN}/live`, documentId: "frame-doc" },
      { frameId: 4, parentFrameId: 0, url: `${OTHER_ORIGIN}/other`, documentId: "other-doc" },
    ]);
    chrome.tabs.sendMessage = vi.fn(async () => ({
      ok: true,
      data: {
        frameHostCount: 1,
        frameOrigin: FRAME_ORIGIN,
        framePathname: "/embedded",
      },
    }));
    const controller = createBackgroundController({ chrome, store });

    await expect(dispatchRuntime(
      controller,
      embeddedFrameResolveCommand(),
      createExtensionSender(),
    )).resolves.toMatchObject({ ok: false, code: "FRAME_UNAVAILABLE" });
  });

  test("fails closed when duplicate sibling frames share the same route", async () => {
    const chrome = createChromeHarness();
    chrome.tabs.query = vi.fn(async () => [{ id: 7, url: `${ORIGIN}/settings`, windowId: 1 }]);
    chrome.webNavigation.getAllFrames = vi.fn(async () => [
      { frameId: 0, parentFrameId: -1, url: `${ORIGIN}/settings`, documentId: "top-doc" },
      { frameId: 3, parentFrameId: 0, url: `${FRAME_ORIGIN}/embedded`, documentId: "one-doc" },
      { frameId: 4, parentFrameId: 0, url: `${FRAME_ORIGIN}/embedded`, documentId: "two-doc" },
    ]);
    const ensureContentScript = vi.fn(async () => true);
    const controller = createBackgroundController({
      chrome,
      store: createStoreHarness(),
      ensureContentScript,
    });

    await expect(dispatchRuntime(
      controller,
      embeddedFrameSelectionCommand(),
      createExtensionSender(),
    )).resolves.toMatchObject({
      ok: false,
      code: "FRAME_AMBIGUOUS",
    });
    expect(ensureContentScript).not.toHaveBeenCalled();
  });

  test("fails closed when the selected frame navigates during content injection", async () => {
    const chrome = createChromeHarness();
    chrome.tabs.query = vi.fn(async () => [{ id: 7, url: `${ORIGIN}/settings`, windowId: 1 }]);
    chrome.tabs.sendMessage = vi.fn(async () => undefined);
    chrome.webNavigation.getAllFrames = vi.fn(async () => [{
      frameId: 3,
      parentFrameId: 0,
      url: `${FRAME_ORIGIN}/embedded`,
      documentId: "old-doc",
    }]);
    chrome.webNavigation.getFrame = vi.fn(async () => ({
      frameId: 3,
      parentFrameId: 0,
      url: `${FRAME_ORIGIN}/embedded`,
      documentId: "new-doc",
    }));
    const ensureContentScript = vi.fn(async () => true);
    const controller = createBackgroundController({
      chrome,
      store: createStoreHarness(),
      ensureContentScript,
    });

    await expect(dispatchRuntime(
      controller,
      embeddedFrameSelectionCommand(),
      createExtensionSender(),
    )).resolves.toMatchObject({
      ok: false,
      code: "FRAME_UNAVAILABLE",
    });
    expect(chrome.tabs.sendMessage).not.toHaveBeenCalledWith(7, expect.objectContaining({
      testClickCaptureEnabled: true,
    }), { frameId: 3 });
  });

  test("requires a document identity before enabling embedded-frame selection", async () => {
    const chrome = createChromeHarness();
    chrome.tabs.query = vi.fn(async () => [{ id: 7, url: `${ORIGIN}/settings`, windowId: 1 }]);
    chrome.webNavigation.getAllFrames = vi.fn(async () => [{
      frameId: 3,
      parentFrameId: 0,
      url: `${FRAME_ORIGIN}/embedded`,
    }]);
    const ensureContentScript = vi.fn(async () => true);
    const controller = createBackgroundController({
      chrome,
      store: createStoreHarness(),
      ensureContentScript,
    });

    await expect(dispatchRuntime(
      controller,
      embeddedFrameSelectionCommand(),
      createExtensionSender(),
    )).resolves.toMatchObject({
      ok: false,
      code: "FRAME_UNAVAILABLE",
    });
    expect(ensureContentScript).not.toHaveBeenCalled();
  });

  test("revokes an embedded-frame lease when the selected frame commits a new document", async () => {
    const chrome = createChromeHarness();
    chrome.tabs.query = vi.fn(async () => [{ id: 7, url: `${ORIGIN}/settings`, windowId: 1 }]);
    chrome.tabs.sendMessage = vi.fn(async () => undefined);
    chrome.webNavigation.getAllFrames = vi.fn(async () => [{
      frameId: 3,
      parentFrameId: 0,
      url: `${FRAME_ORIGIN}/embedded`,
      documentId: "frame-doc",
    }]);
    chrome.webNavigation.getFrame = vi.fn(async () => ({
      frameId: 3,
      parentFrameId: 0,
      url: `${FRAME_ORIGIN}/embedded`,
      documentId: "frame-doc",
    }));
    const controller = createBackgroundController({
      chrome,
      store: createStoreHarness(),
      ensureContentScript: vi.fn(async () => true),
    });
    const command = embeddedFrameSelectionCommand();
    await expect(dispatchRuntime(controller, command, createExtensionSender()))
      .resolves.toEqual({ ok: true, data: { enabled: true } });

    await controller.handleNavigationCommitted({
      documentId: "replacement-doc",
      frameId: 3,
      parentFrameId: 0,
      tabId: 7,
      url: `${FRAME_ORIGIN}/replacement`,
    });

    await expect(dispatchRuntime(controller, {
      type: "ui-attach:session-begin-capture",
    }, {
      documentId: "frame-doc",
      frameId: 3,
      url: `${FRAME_ORIGIN}/embedded`,
      tab: { id: 7, url: `${ORIGIN}/settings` },
    })).resolves.toMatchObject({ ok: false, code: "SELECTION_NOT_ACTIVE" });
  });

  test("revokes an embedded-frame lease when its same document changes pathname", async () => {
    const chrome = createChromeHarness();
    chrome.tabs.query = vi.fn(async () => [{ id: 7, url: `${ORIGIN}/settings`, windowId: 1 }]);
    chrome.tabs.sendMessage = vi.fn(async () => undefined);
    chrome.webNavigation.getAllFrames = vi.fn(async () => [{
      frameId: 3,
      parentFrameId: 0,
      url: `${FRAME_ORIGIN}/embedded`,
      documentId: "frame-doc",
    }]);
    chrome.webNavigation.getFrame = vi.fn(async () => ({
      parentFrameId: 0,
      url: `${FRAME_ORIGIN}/embedded`,
      documentId: "frame-doc",
    }));
    const controller = createBackgroundController({
      chrome,
      store: createStoreHarness(),
      ensureContentScript: vi.fn(async () => true),
    });
    await expect(dispatchRuntime(
      controller,
      embeddedFrameSelectionCommand(),
      createExtensionSender(),
    )).resolves.toEqual({ ok: true, data: { enabled: true } });

    await controller.handleNavigationCommitted({
      documentId: "frame-doc",
      frameId: 3,
      parentFrameId: 0,
      tabId: 7,
      url: `${FRAME_ORIGIN}/other?ignored=yes#ignored`,
    });

    await expect(dispatchRuntime(controller, {
      type: "ui-attach:session-begin-capture",
    }, {
      documentId: "frame-doc",
      frameId: 3,
      url: `${FRAME_ORIGIN}/other`,
      tab: { id: 7, url: `${ORIGIN}/settings` },
    })).resolves.toMatchObject({ ok: false, code: "SELECTION_NOT_ACTIVE" });
  });

  test("keeps an embedded-frame lease across query and fragment-only history changes", async () => {
    const chrome = createChromeHarness();
    chrome.tabs.query = vi.fn(async () => [{ id: 7, url: `${ORIGIN}/settings`, windowId: 1 }]);
    chrome.tabs.sendMessage = vi.fn(async () => undefined);
    chrome.webNavigation.getAllFrames = vi.fn(async () => [{
      frameId: 3,
      parentFrameId: 0,
      url: `${FRAME_ORIGIN}/embedded`,
      documentId: "frame-doc",
    }]);
    chrome.webNavigation.getFrame = vi.fn(async () => ({
      parentFrameId: 0,
      url: `${FRAME_ORIGIN}/embedded`,
      documentId: "frame-doc",
    }));
    const controller = createBackgroundController({
      chrome,
      store: createStoreHarness(),
      ensureContentScript: vi.fn(async () => true),
    });
    await expect(dispatchRuntime(
      controller,
      embeddedFrameSelectionCommand(),
      createExtensionSender(),
    )).resolves.toEqual({ ok: true, data: { enabled: true } });

    await controller.handleNavigationCommitted({
      documentId: "frame-doc",
      frameId: 3,
      parentFrameId: 0,
      tabId: 7,
      url: `${FRAME_ORIGIN}/embedded?ignored=yes#ignored`,
    });

    await expect(dispatchRuntime(controller, {
      type: "ui-attach:session-begin-capture",
    }, {
      documentId: "frame-doc",
      frameId: 3,
      url: `${FRAME_ORIGIN}/embedded?ignored=yes#ignored`,
      tab: { id: 7, url: `${ORIGIN}/settings` },
    })).resolves.toMatchObject({ ok: true });
  });

  test("keeps an embedded-frame lease when the top tab reports only query and fragment changes", async () => {
    const chrome = createChromeHarness();
    chrome.tabs.query = vi.fn(async () => [{ id: 7, url: `${ORIGIN}/settings`, windowId: 1 }]);
    chrome.tabs.sendMessage = vi.fn(async () => undefined);
    chrome.webNavigation.getAllFrames = vi.fn(async () => [{
      frameId: 3,
      parentFrameId: 0,
      url: `${FRAME_ORIGIN}/embedded`,
      documentId: "frame-doc",
    }]);
    chrome.webNavigation.getFrame = vi.fn(async () => ({
      parentFrameId: 0,
      url: `${FRAME_ORIGIN}/embedded`,
      documentId: "frame-doc",
    }));
    const controller = createBackgroundController({
      chrome,
      store: createStoreHarness(),
      ensureContentScript: vi.fn(async () => true),
    });
    await expect(dispatchRuntime(
      controller,
      embeddedFrameSelectionCommand(),
      createExtensionSender(),
    )).resolves.toEqual({ ok: true, data: { enabled: true } });

    await controller.handleTabUpdated(
      7,
      { url: `${ORIGIN}/settings?ignored=yes#ignored` },
      { id: 7, url: `${ORIGIN}/settings?ignored=yes#ignored`, windowId: 1 },
    );

    await expect(dispatchRuntime(controller, {
      type: "ui-attach:element-selection-get",
    }, createExtensionSender())).resolves.toEqual({ ok: true, data: { enabled: true } });
  });

  test("revokes a direct embedded-frame lease when its top parent changes pathname", async () => {
    const chrome = createChromeHarness();
    chrome.tabs.query = vi.fn(async () => [{ id: 7, url: `${ORIGIN}/settings`, windowId: 1 }]);
    chrome.tabs.sendMessage = vi.fn(async () => undefined);
    chrome.webNavigation.getAllFrames = vi.fn(async () => [
      { frameId: 0, parentFrameId: -1, url: `${ORIGIN}/settings`, documentId: "top-doc" },
      {
        frameId: 3,
        parentFrameId: 0,
        url: `${FRAME_ORIGIN}/embedded`,
        documentId: "frame-doc",
      },
    ]);
    chrome.webNavigation.getFrame = vi.fn(async () => ({
      parentFrameId: 0,
      url: `${FRAME_ORIGIN}/embedded`,
      documentId: "frame-doc",
    }));
    const controller = createBackgroundController({
      chrome,
      store: createStoreHarness(),
      ensureContentScript: vi.fn(async () => true),
    });
    await expect(dispatchRuntime(
      controller,
      embeddedFrameSelectionCommand(),
      createExtensionSender(),
    )).resolves.toEqual({ ok: true, data: { enabled: true } });

    await controller.handleNavigationCommitted({
      documentId: "top-doc",
      frameId: 0,
      parentFrameId: -1,
      tabId: 7,
      url: `${ORIGIN}/other`,
    });

    await expect(dispatchRuntime(controller, {
      type: "ui-attach:element-selection-get",
    }, createExtensionSender())).resolves.toEqual({ ok: true, data: { enabled: false } });
  });

  test("subscribes lease invalidation to document and History API navigation", () => {
    const chrome = createChromeHarness();
    const controller = createBackgroundController({ chrome, store: createStoreHarness() });

    controller.register();

    expect(chrome.webNavigation.onCommitted.addListener).toHaveBeenCalledOnce();
    expect(chrome.webNavigation.onHistoryStateUpdated.addListener).toHaveBeenCalledOnce();
  });

  test("revokes a pending embedded-frame activation during async identity revalidation", async () => {
    const chrome = createChromeHarness();
    chrome.tabs.query = vi.fn(async () => [{ id: 7, url: `${ORIGIN}/settings`, windowId: 1 }]);
    chrome.tabs.sendMessage = vi.fn(async () => undefined);
    chrome.webNavigation.getAllFrames = vi.fn(async () => [{
      frameId: 3,
      parentFrameId: 0,
      url: `${FRAME_ORIGIN}/embedded`,
      documentId: "frame-doc",
    }]);
    const frameLookup = createDeferred<{
      documentId: string;
      parentFrameId: number;
      url: string;
    } | undefined>();
    chrome.webNavigation.getFrame = vi.fn(async () => await frameLookup.promise);
    const controller = createBackgroundController({
      chrome,
      store: createStoreHarness(),
      ensureContentScript: vi.fn(async () => true),
    });

    const activation = dispatchRuntime(
      controller,
      embeddedFrameSelectionCommand(),
      createExtensionSender(),
    );
    await waitFor(() => vi.mocked(chrome.webNavigation.getFrame).mock.calls.length === 1);
    await controller.handleNavigationCommitted({
      documentId: "replacement-doc",
      frameId: 3,
      parentFrameId: 0,
      tabId: 7,
      url: `${FRAME_ORIGIN}/replacement`,
    });
    frameLookup.resolve({
      documentId: "frame-doc",
      parentFrameId: 0,
      url: `${FRAME_ORIGIN}/embedded`,
    });

    await expect(activation).resolves.toEqual({ ok: true, data: { enabled: false } });
  });

  test("does not report enabled after navigation races the final frame revalidation", async () => {
    const chrome = createChromeHarness();
    chrome.tabs.query = vi.fn(async () => [{ id: 7, url: `${ORIGIN}/settings`, windowId: 1 }]);
    chrome.tabs.sendMessage = vi.fn(async () => undefined);
    chrome.webNavigation.getAllFrames = vi.fn(async () => [{
      frameId: 3,
      parentFrameId: 0,
      url: `${FRAME_ORIGIN}/embedded`,
      documentId: "frame-doc",
    }]);
    const finalLookup = createDeferred<{
      documentId: string;
      parentFrameId: number;
      url: string;
    } | undefined>();
    chrome.webNavigation.getFrame = vi.fn()
      .mockResolvedValueOnce({
        documentId: "frame-doc",
        parentFrameId: 0,
        url: `${FRAME_ORIGIN}/embedded`,
      })
      .mockImplementationOnce(async () => await finalLookup.promise);
    const controller = createBackgroundController({
      chrome,
      store: createStoreHarness(),
      ensureContentScript: vi.fn(async () => true),
    });

    const activation = dispatchRuntime(
      controller,
      embeddedFrameSelectionCommand(),
      createExtensionSender(),
    );
    await waitFor(() => vi.mocked(chrome.webNavigation.getFrame).mock.calls.length === 2);
    await controller.handleNavigationCommitted({
      documentId: "replacement-doc",
      frameId: 3,
      parentFrameId: 0,
      tabId: 7,
      url: `${FRAME_ORIGIN}/replacement`,
    });
    finalLookup.resolve({
      documentId: "frame-doc",
      parentFrameId: 0,
      url: `${FRAME_ORIGIN}/embedded`,
    });

    await expect(activation).resolves.toEqual({ ok: true, data: { enabled: false } });
  });

  test("fails closed when the top route changes during embedded-frame activation", async () => {
    const chrome = createChromeHarness();
    chrome.tabs.query = vi.fn()
      .mockResolvedValueOnce([{ id: 7, url: `${ORIGIN}/settings`, windowId: 1 }])
      .mockResolvedValueOnce([{ id: 7, url: `${ORIGIN}/settings`, windowId: 1 }])
      .mockResolvedValue([{ id: 7, url: `${ORIGIN}/other-route`, windowId: 1 }]);
    chrome.tabs.sendMessage = vi.fn(async () => undefined);
    chrome.webNavigation.getAllFrames = vi.fn(async () => [{
      frameId: 3,
      parentFrameId: 0,
      url: `${FRAME_ORIGIN}/embedded`,
      documentId: "frame-doc",
    }]);
    chrome.webNavigation.getFrame = vi.fn(async () => ({
      frameId: 3,
      parentFrameId: 0,
      url: `${FRAME_ORIGIN}/embedded`,
      documentId: "frame-doc",
    }));
    const controller = createBackgroundController({
      chrome,
      store: createStoreHarness(),
      ensureContentScript: vi.fn(async () => true),
    });

    await expect(dispatchRuntime(
      controller,
      embeddedFrameSelectionCommand(),
      createExtensionSender(),
    )).resolves.toMatchObject({
      ok: false,
      code: "FRAME_UNAVAILABLE",
    });
  });

  test("resolves a nested child only under the currently selected parent frame", async () => {
    const chrome = createChromeHarness();
    const store = createStoreHarness();
    chrome.tabs.query = vi.fn(async () => [{ id: 7, url: `${ORIGIN}/settings`, windowId: 1 }]);
    chrome.tabs.sendMessage = vi.fn(async () => undefined);
    chrome.webNavigation.getAllFrames = vi.fn(async () => [
      { frameId: 0, parentFrameId: -1, url: `${ORIGIN}/settings`, documentId: "top-doc" },
      { frameId: 8, parentFrameId: 0, url: `${FRAME_ORIGIN}/outer`, documentId: "parent-doc" },
    ]);
    chrome.webNavigation.getFrame = vi.fn(async ({ frameId }) => frameId === 8
      ? { parentFrameId: 0, url: `${FRAME_ORIGIN}/outer`, documentId: "parent-doc" }
      : { parentFrameId: 8, url: `${OTHER_ORIGIN}/nested`, documentId: "child-doc" });
    const ensureContentScript = vi.fn(async () => true);
    const controller = createBackgroundController({ chrome, store, ensureContentScript });

    await expect(dispatchRuntime(
      controller,
      embeddedFrameSelectionCommand({ framePathname: "/outer" }),
      createExtensionSender(),
    )).resolves.toEqual({ ok: true, data: { enabled: true } });

    chrome.webNavigation.getAllFrames = vi.fn(async () => [
      { frameId: 0, parentFrameId: -1, url: `${ORIGIN}/settings`, documentId: "top-doc" },
      { frameId: 8, parentFrameId: 0, url: `${FRAME_ORIGIN}/outer`, documentId: "parent-doc" },
      { frameId: 11, parentFrameId: 8, url: `${OTHER_ORIGIN}/nested`, documentId: "child-doc" },
      { frameId: 12, parentFrameId: 0, url: `${OTHER_ORIGIN}/nested`, documentId: "wrong-parent-doc" },
    ]);

    await expect(dispatchRuntime(
      controller,
      embeddedFrameSelectionCommand({
        pageOrigin: FRAME_ORIGIN,
        pagePathname: "/outer",
        parentFrameId: 8,
        frameOrigin: OTHER_ORIGIN,
        framePathname: "/nested",
      }),
      createExtensionSender(),
    )).resolves.toEqual({ ok: true, data: { enabled: true } });
    expect(ensureContentScript).toHaveBeenLastCalledWith(7, 11);

    await controller.handleNavigationCommitted({
      documentId: "parent-doc",
      frameId: 8,
      parentFrameId: 0,
      tabId: 7,
      url: `${FRAME_ORIGIN}/replacement`,
    });
    await expect(dispatchRuntime(controller, {
      type: "ui-attach:session-begin-capture",
    }, {
      documentId: "child-doc",
      frameId: 11,
      url: `${OTHER_ORIGIN}/nested`,
      tab: { id: 7, url: `${ORIGIN}/settings` },
    })).resolves.toMatchObject({ ok: false, code: "SELECTION_NOT_ACTIVE" });
  });

  test("resolves a same-origin child under the selected cross-origin parent and keeps top-host permission semantics", async () => {
    const chrome = createChromeHarness();
    const store = createStoreHarness();
    chrome.tabs.query = vi.fn(async () => [{ id: 7, url: `${ORIGIN}/settings`, windowId: 1 }]);
    chrome.tabs.sendMessage = vi.fn(async () => undefined);
    chrome.webNavigation.getAllFrames = vi.fn(async () => [
      { frameId: 0, parentFrameId: -1, url: `${ORIGIN}/settings`, documentId: "top-doc" },
      { frameId: 8, parentFrameId: 0, url: `${FRAME_ORIGIN}/outer`, documentId: "parent-doc" },
    ]);
    chrome.webNavigation.getFrame = vi.fn(async ({ frameId }) => frameId === 8
      ? { parentFrameId: 0, url: `${FRAME_ORIGIN}/outer`, documentId: "parent-doc" }
      : {
          parentFrameId: 8,
          url: `${FRAME_ORIGIN}/docs/mcp/reference/index.html`,
          documentId: "child-doc",
        });
    const ensureContentScript = vi.fn(async () => true);
    const controller = createBackgroundController({ chrome, store, ensureContentScript });

    await expect(dispatchRuntime(
      controller,
      embeddedFrameSelectionCommand({ framePathname: "/outer" }),
      createExtensionSender(),
    )).resolves.toEqual({ ok: true, data: { enabled: true } });

    const record = createEmbeddedFrameRecord();
    record.origin = FRAME_ORIGIN;
    record.pageUrl = `${FRAME_ORIGIN}/outer`;
    record.frameId = 8;
    record.attachment.boundary = {
      kind: "embedded_frame",
      innerDom: "not_captured",
      originRelation: "same_origin",
      frameOrigin: FRAME_ORIGIN,
      framePathname: "/docs/mcp/reference/index.html",
      dominantViewport: true,
    };
    store.read = vi.fn(async () => ({ ok: true, value: createSessionReadback(record) }));
    chrome.webNavigation.getAllFrames = vi.fn(async () => [
      { frameId: 0, parentFrameId: -1, url: `${ORIGIN}/settings`, documentId: "top-doc" },
      { frameId: 8, parentFrameId: 0, url: `${FRAME_ORIGIN}/outer`, documentId: "parent-doc" },
      {
        frameId: 11,
        parentFrameId: 8,
        url: `${FRAME_ORIGIN}/docs/mcp/reference/index.html`,
        documentId: "child-doc",
      },
    ]);

    await expect(dispatchRuntime(
      controller,
      embeddedFrameResolveCommand({
        pageOrigin: FRAME_ORIGIN,
        pagePathname: "/outer",
        parentFrameId: 8,
        frameOrigin: FRAME_ORIGIN,
        framePathname: "/docs/mcp/reference/index.html",
      }),
      createExtensionSender(),
    )).resolves.toEqual({
      ok: true,
      data: {
        tabId: 7,
        pageOrigin: FRAME_ORIGIN,
        pagePathname: "/outer",
        parentFrameId: 8,
        frameOrigin: FRAME_ORIGIN,
        framePathname: "/docs/mcp/reference/index.html",
        requiresHostPermission: true,
      },
    });

    await expect(dispatchRuntime(
      controller,
      embeddedFrameActivateCommand({
        pageOrigin: FRAME_ORIGIN,
        pagePathname: "/outer",
        parentFrameId: 8,
        sourceFrameOrigin: FRAME_ORIGIN,
        sourceFramePathname: "/docs/mcp/reference/index.html",
        frameOrigin: FRAME_ORIGIN,
        framePathname: "/docs/mcp/reference/index.html",
      }),
      createExtensionSender(),
    )).resolves.toEqual({ ok: true, data: { enabled: true } });
    expect(ensureContentScript).toHaveBeenLastCalledWith(7, 11);
  });

  test("marks a same-origin child of the top page as not requiring optional host permission", async () => {
    const chrome = createChromeHarness();
    const store = createStoreHarness();
    const record = createEmbeddedFrameRecord();
    record.attachment.boundary = {
      kind: "embedded_frame",
      innerDom: "not_captured",
      originRelation: "same_origin",
      frameOrigin: ORIGIN,
      framePathname: "/inline-docs",
      dominantViewport: true,
    };
    store.read = vi.fn(async () => ({ ok: true, value: createSessionReadback(record) }));
    chrome.tabs.query = vi.fn(async () => [{ id: 7, url: `${ORIGIN}/settings`, windowId: 1 }]);
    chrome.webNavigation.getAllFrames = vi.fn(async () => [
      { frameId: 0, parentFrameId: -1, url: `${ORIGIN}/settings`, documentId: "top-doc" },
      { frameId: 3, parentFrameId: 0, url: `${ORIGIN}/inline-docs`, documentId: "child-doc" },
    ]);
    const controller = createBackgroundController({ chrome, store });

    await expect(dispatchRuntime(
      controller,
      embeddedFrameResolveCommand({
        frameOrigin: ORIGIN,
        framePathname: "/inline-docs",
      }),
      createExtensionSender(),
    )).resolves.toEqual({
      ok: true,
      data: {
        tabId: 7,
        pageOrigin: ORIGIN,
        pagePathname: "/settings",
        parentFrameId: 0,
        frameOrigin: ORIGIN,
        framePathname: "/inline-docs",
        requiresHostPermission: false,
      },
    });
  });

  test("keeps local bridge mutations in the trusted background owner", async () => {
    const chrome = createChromeHarness();
    const store = createStoreHarness();
    const localAgentBridge = createLocalAgentBridgeHarness();
    const controller = createBackgroundController({
      chrome,
      store,
      runtimeFeatures: [createLocalAgentBridgeRuntimeFeature(localAgentBridge)],
    });

    await expect(dispatchRuntime(controller, {
      type: LOCAL_AGENT_BRIDGE_RUNTIME_TYPE,
      action: "create-connection-request",
      approvalMode: "browser_session",
    }, createExtensionSender())).resolves.toMatchObject({
      ok: true,
      data: { pending: true, approvalMode: "browser_session" },
    });
    expect(localAgentBridge.createConnectionRequest).toHaveBeenCalledWith("browser_session");

    const untrusted = await dispatchRuntime(controller, {
      type: LOCAL_AGENT_BRIDGE_RUNTIME_TYPE,
      action: "disconnect",
    }, createSender(`${ORIGIN}/settings`));
    expect(untrusted).toMatchObject({ ok: false, code: "UNTRUSTED_SENDER" });
    expect(localAgentBridge.disconnect).not.toHaveBeenCalled();

    const malformed = await dispatchRuntime(controller, {
      type: LOCAL_AGENT_BRIDGE_RUNTIME_TYPE,
      action: "publish",
      input: { page: null, attachmentCount: 0, agentCopy: null },
      secret: SECRET,
    }, createExtensionSender());
    expect(malformed).toMatchObject({ ok: false, code: "INVALID_COMMAND" });
    expect(JSON.stringify(malformed)).not.toContain(SECRET);
    expect(localAgentBridge.publish).not.toHaveBeenCalled();
  });

  test("consumer controller ignores bridge messages without scheduling bridge work", async () => {
    const chrome = createChromeHarness();
    const store = createStoreHarness();
    const controller = createBackgroundController({
      chrome,
      store,
      runtimeFeatures: [],
    });

    await expect(controller.handleRuntimeMessage(
      { type: LOCAL_AGENT_BRIDGE_RUNTIME_TYPE },
      createExtensionSender(),
    )).resolves.toBeUndefined();
    expect(store.calls).toEqual([]);
  });

  test("consumer ignores unknown messages before failed storage readiness but keeps known commands gated", async () => {
    const chrome = createChromeHarness();
    const store = createStoreHarness();
    const controller = createBackgroundController({
      chrome,
      store,
      runtimeFeatures: [],
      storageAccessReady: Promise.resolve(false),
    });

    await expect(controller.handleRuntimeMessage(
      { type: LOCAL_AGENT_BRIDGE_RUNTIME_TYPE },
      createExtensionSender(),
    )).resolves.toBeUndefined();
    await expect(controller.handleRuntimeMessage(
      { type: "ui-attach:content-settings-get" },
      createSender(`${ORIGIN}/settings`),
    )).resolves.toEqual({
      ok: false,
      code: "CAPTURE_FAILED",
      error: SAFE_CAPTURE_ERROR,
    });
    expect(store.calls).toEqual([]);
  });

  test("accepts only the minimal page overlay state shape", () => {
    expect(isEmbeddedFrameHostInspectMessage({
      type: "ui-attach:embedded-frame-host-inspect",
      locators: [{
        strategy: "playwright.title",
        value: 'page.getByTitle("Documentation")',
        confidence: 0.92,
      }],
    })).toBe(true);
    expect(isEmbeddedFrameHostInspectMessage({
      type: "ui-attach:embedded-frame-host-inspect",
      locators: [],
      secret: SECRET,
    })).toBe(false);
    expect(isEmbeddedFrameHostInspectResponse({
      ok: true,
      data: {
        frameHostCount: 1,
        frameOrigin: FRAME_ORIGIN,
        framePathname: "/embedded",
      },
    })).toBe(true);
    expect(isEmbeddedFrameHostInspectResponse({
      ok: true,
      data: {
        frameHostCount: 1,
        frameOrigin: FRAME_ORIGIN,
        framePathname: "/embedded?token=secret",
      },
    })).toBe(false);
    expect(isEmbeddedFrameHostInspectResponse({
      ok: true,
      data: {
        frameHostCount: 1,
        frameOrigin: FRAME_ORIGIN,
        framePathname: "/embedded",
        secret: SECRET,
      },
    })).toBe(false);

    const state = {
      type: UI_ATTACH_OVERLAY_STATE,
      origin: ORIGIN,
      activeItemId: "att_save",
      items: [{ itemId: "att_save", attachmentId: "att_save", label: "A" }],
    };
    expect(isOverlayStateMessage(state)).toBe(true);
    expect(isOverlayStateMessage({ ...state, sourceRecord: { secret: SECRET } })).toBe(false);
    expect(isOverlayStateMessage({
      ...state,
      items: [{ ...state.items[0], target: "button" }],
    })).toBe(false);

    const preview = {
      type: UI_ATTACH_OVERLAY_PREVIEW,
      origin: ORIGIN,
      pathname: "/settings",
      itemId: "att_save",
    };
    expect(isOverlayPreviewMessage(preview)).toBe(true);
    expect(isOverlayPreviewMessage({ ...preview, itemId: null })).toBe(true);
    expect(isOverlayPreviewMessage({ ...preview, sourceRecord: { secret: SECRET } })).toBe(false);
    expect(isOverlayPreviewMessage({ ...preview, origin: `${ORIGIN}/settings` })).toBe(false);
    expect(isOverlayPreviewMessage({ ...preview, pathname: "//other.example.test/settings" })).toBe(false);
    expect(isOverlayPreviewForPage(preview, { origin: ORIGIN, pathname: "/settings" })).toBe(true);
    expect(isOverlayPreviewForPage(preview, { origin: ORIGIN, pathname: "/account" })).toBe(false);
    expect(isOverlayPreviewForPage(
      { ...preview, itemId: null },
      { origin: ORIGIN, pathname: "/account" },
    )).toBe(true);
    expect(isOverlayPreviewForPage(
      { ...preview, itemId: null },
      { origin: OTHER_ORIGIN, pathname: "/settings" },
    )).toBe(false);

    const relationPreview = {
      type: UI_ATTACH_OVERLAY_RELATION_PREVIEW,
      origin: ORIGIN,
      pathname: "/settings",
      sourceItemId: "att_save",
      referenceItemId: "att_cancel",
    };
    expect(isOverlayRelationPreviewMessage(relationPreview)).toBe(true);
    expect(isOverlayRelationPreviewMessage({
      ...relationPreview,
      referenceItemId: "att_save",
    })).toBe(false);
    expect(isOverlayRelationPreviewMessage({
      ...relationPreview,
      sourceRecord: { secret: SECRET },
    })).toBe(false);
    expect(isOverlayRelationPreviewForPage(
      relationPreview,
      { origin: ORIGIN, pathname: "/settings" },
    )).toBe(true);
    expect(isOverlayRelationPreviewForPage(
      relationPreview,
      { origin: ORIGIN, pathname: "/account" },
    )).toBe(false);
  });

  test("accepts only the minimal locator-backed overlay restore response", () => {
    const response = {
      ok: true,
      data: {
        origin: ORIGIN,
        activeItemId: "att_save",
        items: [{
          itemId: "att_save",
          attachmentId: "att_save",
          label: "A",
          locators: [{
            strategy: "playwright.role",
            value: 'page.getByRole("button", { name: "Save changes" })',
            confidence: 0.92,
          }],
        }],
      },
    };

    expect(isOverlayRestoreResponse(response)).toBe(true);
    expect(isOverlayRestoreResponse({
      ...response,
      data: { ...response.data, pageUrl: `${ORIGIN}/settings?token=${SECRET}` },
    })).toBe(false);
    expect(isOverlayRestoreResponse({
      ...response,
      data: {
        ...response.data,
        items: [{ ...response.data.items[0], sourceRecord: { secret: SECRET } }],
      },
    })).toBe(false);
    expect(isOverlayRestoreResponse({
      ...response,
      data: {
        ...response.data,
        items: [{
          ...response.data.items[0],
          locators: [{ strategy: "coordinates", value: "10,20", confidence: 0.4 }],
        }],
      },
    })).toBe(false);
    expect(isOverlayRestoreResponse({
      ...response,
      data: {
        ...response.data,
        items: [{
          ...response.data.items[0],
          locators: Array.from({ length: 9 }, (_, index) => ({
            strategy: "css",
            value: `[data-index="${index}"]`,
            confidence: 0.5,
          })),
        }],
      },
    })).toBe(false);
  });

  test("accepts only bounded minimal current rebind status messages", () => {
    const response = {
      ok: true,
      data: {
        origin: ORIGIN,
        pathname: "/settings",
        items: [{ itemId: "att_save", status: "restored" }],
      },
    };

    expect(isOverlayRebindStatusGetMessage({
      type: UI_ATTACH_OVERLAY_REBIND_STATUS_GET,
    })).toBe(true);
    expect(isOverlayRebindStatusGetMessage({
      type: UI_ATTACH_OVERLAY_REBIND_STATUS_GET,
      origin: ORIGIN,
    })).toBe(false);
    expect(isOverlayRebindStatusResponse(response)).toBe(true);
    expect(isOverlayRebindStatusResponse({ ...response, sourceRecord: { secret: SECRET } }))
      .toBe(false);
    expect(isOverlayRebindStatusResponse({
      ...response,
      data: { ...response.data, pageUrl: `${ORIGIN}/settings?token=${SECRET}` },
    })).toBe(false);
    expect(isOverlayRebindStatusResponse({
      ...response,
      data: {
        ...response.data,
        items: [{ ...response.data.items[0], sourceRecord: { secret: SECRET } }],
      },
    })).toBe(false);
    expect(isOverlayRebindStatusResponse({
      ...response,
      data: {
        ...response.data,
        items: [response.data.items[0], response.data.items[0]],
      },
    })).toBe(false);
    expect(isOverlayRebindStatusResponse({
      ...response,
      data: { ...response.data, pathname: "//other.example.test/settings" },
    })).toBe(false);
    expect(isOverlayRebindStatusResponse({
      ...response,
      data: {
        ...response.data,
        items: Array.from({ length: 27 }, (_, index) => ({
          itemId: `att_${index}`,
          status: "checking",
        })),
      },
    })).toBe(false);
    expect(isOverlayRebindStatusResponse({
      ...response,
      data: {
        ...response.data,
        items: [{ itemId: "att_save", status: "stale" }],
      },
    })).toBe(false);
  });

  test("validates the exact minimal content commit receipt", () => {
    expect(isCaptureCommitResponse({
      ok: true,
      data: { origin: ORIGIN, epoch: "epoch-1", itemId: "att_save", label: "A" },
    })).toBe(true);
    expect(isCaptureCommitResponse({
      ok: true,
      data: { origin: ORIGIN, epoch: "epoch-1", itemId: "att_save", label: "A", file: {} },
    })).toBe(false);
    expect(isCaptureCommitResponse({
      ok: true,
      data: { origin: ORIGIN, epoch: "epoch-1", legacyRecord: {} },
    })).toBe(false);
    expect(isCaptureCommitResponse({
      ok: true,
      data: { origin: `${ORIGIN}/path`, epoch: "epoch-1", itemId: "att_save", label: "A" },
    })).toBe(false);
  });

  test("rejects undeclared runtime payload fields without echoing their values", async () => {
    const chrome = createChromeHarness();
    const store = createStoreHarness();
    const controller = createBackgroundController({ chrome, store });
    const commands: unknown[] = [
      { type: "ui-attach:session-begin-capture", extra: SECRET },
      { type: "ui-attach:content-selection-disable", extra: SECRET },
      { type: "ui-attach:element-selection-get", extra: SECRET },
      { type: "ui-attach:element-selection-set", enabled: true, tabId: 7, extra: SECRET },
      { type: "ui-attach:element-selection-set", enabled: true },
      { type: "ui-attach:element-selection-set", enabled: false, tabId: 7 },
      { type: "ui-attach:element-selection-set", enabled: SECRET },
      { ...embeddedFrameSelectionCommand(), framePathname: "/embedded?token=secret" },
      { ...embeddedFrameSelectionCommand(), parentFrameId: -1 },
      { ...embeddedFrameSelectionCommand(), extra: SECRET },
      { ...embeddedFrameResolveCommand(), itemId: "" },
      { ...embeddedFrameResolveCommand(), extra: SECRET },
      { ...embeddedFrameActivateCommand(), sourceFramePathname: "/embedded?token=secret" },
      { ...embeddedFrameActivateCommand(), extra: SECRET },
      { type: "ui-attach:content-settings-get", extra: SECRET },
      { type: "ui-attach:overlays-restore-get", extra: SECRET },
      { type: "ui-attach:session-get-active", extra: SECRET },
      { type: "ui-attach:session-list-stored", extra: SECRET },
      { type: "ui-attach:session-review-stored", origin: ORIGIN, extra: SECRET },
      {
        type: "ui-attach:session-prepare-snapshot-handoff",
        origin: ORIGIN,
        epoch: "epoch-1",
        extra: SECRET,
      },
      { type: "ui-attach:session-clear-all-stored", extra: SECRET },
      {
        type: "ui-attach:session-commit-capture",
        token: { ...TOKEN, extra: SECRET },
        record: createCaptureRecord("save", "Save changes"),
      },
    ];

    for (const command of commands) {
      const response = await dispatchRuntime(controller, command, createSender(`${ORIGIN}/settings`));
      expect(response).toMatchObject({ ok: false, code: "INVALID_COMMAND" });
      expect(JSON.stringify(response)).not.toContain(SECRET);
    }
    expect(store.calls).toEqual([]);
  });

  test("reject malformed nested command values before store methods and without echoing payloads", async () => {
    const chrome = createChromeHarness();
    const store = createStoreHarness();
    const controller = createBackgroundController({ chrome, store });
    const sender = createSender(`${ORIGIN}/settings`);
    const rejected = "sk-test-nested-secret";

    const response = await dispatchRuntime(controller, {
      type: "ui-attach:session-commit-capture",
      token: { origin: ORIGIN, epoch: "epoch-1", operationId: { rejected } },
      record: {
        origin: ORIGIN,
        attachment: { nested: { rejected } },
      },
    }, sender);

    expect(response).toMatchObject({
      ok: false,
      code: "INVALID_COMMAND",
      issues: expect.arrayContaining([
        { path: "token.operationId", message: expect.any(String) },
        { path: "record.pageUrl", message: expect.any(String) },
      ]),
    });
    expect(JSON.stringify(response)).not.toContain(rejected);
    expect(store.calls).toEqual([]);
  });

  test("rejects malformed panel mutation origins epochs ids intents and operation ids before store methods", async () => {
    const chrome = createChromeHarness();
    const store = createStoreHarness();
    const controller = createBackgroundController({ chrome, store });
    const sender = createSender(`${ORIGIN}/settings`);
    const commands: unknown[] = [
      { type: "ui-attach:session-update-intent", origin: `${ORIGIN}/bad`, epoch: "epoch-1", itemId: "att_1", intent: "Use it" },
      { type: "ui-attach:session-update-intent", origin: ORIGIN, epoch: "", itemId: "att_1", intent: "Use it" },
      { type: "ui-attach:session-remove-item", origin: ORIGIN, epoch: "epoch-1", itemId: "" },
      { type: "ui-attach:session-update-intent", origin: ORIGIN, epoch: "epoch-1", itemId: "att_1", intent: { unsafe: true } },
      { type: "ui-attach:session-clear", origin: ORIGIN, epoch: "epoch-1", operationId: "" },
      { type: "ui-attach:session-review-stored", origin: `${ORIGIN}/settings` },
      { type: "ui-attach:session-prepare-snapshot-handoff", origin: ORIGIN, epoch: "" },
      {
        type: "ui-attach:session-prepare-snapshot-handoff",
        origin: ORIGIN,
        epoch: "e".repeat(257),
      },
      {
        type: "ui-attach:session-prepare-snapshot-handoff",
        origin: `${ORIGIN}/settings`,
        epoch: "epoch-1",
      },
      { type: "ui-attach:overlays-sync", origin: ORIGIN, activeItemId: "" },
      { type: "ui-attach:overlay-preview", origin: ORIGIN, itemId: "" },
      {
        type: "ui-attach:overlay-relation-preview",
        origin: ORIGIN,
        sourceItemId: "att_save",
        referenceItemId: "att_save",
      },
    ];

    const responses = [];
    for (const command of commands) {
      responses.push(await dispatchRuntime(controller, command, sender));
    }

    expect(responses.every((response) => response.ok === false)).toBe(true);
    expect(responses.map((response) => response.ok === false ? response.code : "")).toEqual([
      "INVALID_COMMAND",
      "INVALID_COMMAND",
      "INVALID_COMMAND",
      "INVALID_COMMAND",
      "INVALID_COMMAND",
      "INVALID_COMMAND",
      "INVALID_COMMAND",
      "INVALID_COMMAND",
      "INVALID_COMMAND",
      "INVALID_COMMAND",
      "INVALID_COMMAND",
      "INVALID_COMMAND",
    ]);
    expect(store.calls).toEqual([]);
  });
});

describe("background context-menu selection orchestration", () => {
  test("opens a seeded picker without mutating the capture session", async () => {
    const chrome = createChromeHarness();
    const store = createStoreHarness();
    const ensureContentScript = vi.fn(async () => true);
    chrome.tabs.query = vi.fn(async () => [
      { id: 7, url: `${ORIGIN}/settings`, windowId: 2 },
    ]);
    chrome.webNavigation.getFrame = vi.fn(async () => ({
      documentId: "document-1",
      parentFrameId: -1,
      url: `${ORIGIN}/settings`,
    }));
    const controller = createBackgroundController({ chrome, store, ensureContentScript });

    await controller.handleContextMenuClick(
      createContextInfo(),
      { id: 7, windowId: 2, url: `${ORIGIN}/settings` },
    );

    expect(chrome.sidePanel?.open).toHaveBeenCalledWith({ windowId: 2 });
    expect(store.beginCapture).not.toHaveBeenCalled();
    expect(store.commitCapture).not.toHaveBeenCalled();
    expect(chrome.tabs.sendMessage).toHaveBeenCalledWith(7, {
      type: UI_ATTACH_CONTENT_SETTINGS_UPDATED,
      disclosureMode: "agent_safe",
      testClickCaptureEnabled: true,
    }, { frameId: 0, documentId: "document-1" });
    expect(chrome.tabs.sendMessage).toHaveBeenCalledWith(7, {
      type: UI_ATTACH_SELECTION_SEED_CONTEXT_TARGET,
    }, { frameId: 0, documentId: "document-1" });
    expect(chrome.runtime.sentMessages).not.toContainEqual(expect.objectContaining({
      type: UI_ATTACH_SESSION_UPDATED,
    }));
    await expect(dispatchRuntime(controller, {
      type: "ui-attach:element-selection-get",
    }, createExtensionSender())).resolves.toEqual({ ok: true, data: { enabled: true } });
  });

  test("single mode stops only after the first confirmed left-click capture", async () => {
    const chrome = createChromeHarness();
    const store = createStoreHarness();
    const record = createCaptureRecord("save", "Save changes");
    chrome.tabs.query = vi.fn(async () => [
      { id: 7, url: `${ORIGIN}/settings`, windowId: 2 },
    ]);
    chrome.webNavigation.getFrame = vi.fn(async () => ({
      documentId: "document-1",
      parentFrameId: -1,
      url: `${ORIGIN}/settings`,
    }));
    const controller = createBackgroundController({ chrome, store });

    await controller.handleContextMenuClick(
      createContextInfo(),
      { id: 7, windowId: 2, url: `${ORIGIN}/settings` },
    );
    expect(store.beginCapture).not.toHaveBeenCalled();
    await expect(dispatchRuntime(controller, {
      type: "ui-attach:element-selection-get",
    }, createExtensionSender())).resolves.toEqual({ ok: true, data: { enabled: true } });

    const sender = {
      ...createSender(`${ORIGIN}/settings`),
      documentId: "document-1",
    };
    await expect(dispatchRuntime(controller, {
      type: "ui-attach:session-begin-capture",
    }, sender)).resolves.toEqual({ ok: true, data: TOKEN });
    await expect(dispatchRuntime(controller, {
      type: "ui-attach:session-commit-capture",
      token: TOKEN,
      record,
    }, sender)).resolves.toMatchObject({ ok: true });

    expect(store.beginCapture).toHaveBeenCalledTimes(1);
    expect(store.commitCapture).toHaveBeenCalledTimes(1);
    await expect(dispatchRuntime(controller, {
      type: "ui-attach:element-selection-get",
    }, createExtensionSender())).resolves.toEqual({ ok: true, data: { enabled: false } });
  });

  test("continuous mode remains active after a confirmed left-click capture", async () => {
    const chrome = createChromeHarness();
    const store = createStoreHarness();
    const record = createCaptureRecord("save", "Save changes");
    chrome.storage.local.get = vi.fn(async (key) => key === CONTEXT_MENU_SELECTION_MODE_KEY
      ? { [CONTEXT_MENU_SELECTION_MODE_KEY]: "continuous" }
      : {});
    chrome.tabs.query = vi.fn(async () => [
      { id: 7, url: `${ORIGIN}/settings`, windowId: 2 },
    ]);
    chrome.webNavigation.getFrame = vi.fn(async () => ({
      documentId: "document-1",
      parentFrameId: -1,
      url: `${ORIGIN}/settings`,
    }));
    const controller = createBackgroundController({ chrome, store });

    await controller.handleContextMenuClick(
      createContextInfo(),
      { id: 7, windowId: 2, url: `${ORIGIN}/settings` },
    );
    const sender = {
      ...createSender(`${ORIGIN}/settings`),
      documentId: "document-1",
    };
    await dispatchRuntime(controller, { type: "ui-attach:session-begin-capture" }, sender);
    await dispatchRuntime(controller, {
      type: "ui-attach:session-commit-capture",
      token: TOKEN,
      record,
    }, sender);

    await expect(dispatchRuntime(controller, {
      type: "ui-attach:element-selection-get",
    }, createExtensionSender())).resolves.toEqual({ ok: true, data: { enabled: true } });
  });

  test("a newer Stop intent prevents a delayed context-menu start from rearming selection", async () => {
    const chrome = createChromeHarness();
    const store = createStoreHarness();
    const modeRead = createDeferred<Record<string, unknown>>();
    chrome.storage.local.get = vi.fn((key) => key === CONTEXT_MENU_SELECTION_MODE_KEY
      ? modeRead.promise
      : Promise.resolve({}));
    chrome.tabs.query = vi.fn(async () => [
      { id: 7, url: `${ORIGIN}/settings`, windowId: 2 },
    ]);
    chrome.webNavigation.getFrame = vi.fn(async () => ({
      documentId: "document-1",
      parentFrameId: -1,
      url: `${ORIGIN}/settings`,
    }));
    const controller = createBackgroundController({ chrome, store });

    const pendingStart = controller.handleContextMenuClick(
      createContextInfo(),
      { id: 7, windowId: 2, url: `${ORIGIN}/settings` },
    );
    await waitFor(() => vi.mocked(chrome.storage.local.get).mock.calls.length > 0);
    await expect(dispatchRuntime(controller, {
      type: "ui-attach:element-selection-set",
      enabled: false,
    }, createExtensionSender())).resolves.toEqual({ ok: true, data: { enabled: false } });
    modeRead.resolve({ [CONTEXT_MENU_SELECTION_MODE_KEY]: "continuous" });
    await pendingStart;

    expect(store.beginCapture).not.toHaveBeenCalled();
    expect(chrome.tabs.sendMessage).not.toHaveBeenCalledWith(
      7,
      { type: UI_ATTACH_SELECTION_SEED_CONTEXT_TARGET },
      expect.anything(),
    );
    await expect(dispatchRuntime(controller, {
      type: "ui-attach:element-selection-get",
    }, createExtensionSender())).resolves.toEqual({ ok: true, data: { enabled: false } });
  });

  test.each(["older-first", "newer-first"])(
    "the latest context-menu intent wins when async reads complete %s",
    async (completionOrder) => {
      const chrome = createChromeHarness();
      const store = createStoreHarness();
      const modeReads = [
        createDeferred<Record<string, unknown>>(),
        createDeferred<Record<string, unknown>>(),
      ];
      let modeReadIndex = 0;
      chrome.storage.local.get = vi.fn((key) => key === CONTEXT_MENU_SELECTION_MODE_KEY
        ? modeReads[modeReadIndex++]!.promise
        : Promise.resolve({}));
      chrome.tabs.query = vi.fn(async () => [
        { id: 7, url: `${ORIGIN}/settings`, windowId: 2 },
      ]);
      chrome.webNavigation.getFrame = vi.fn(async ({ frameId }) => frameId === 3
        ? {
            documentId: "child-document",
            parentFrameId: 0,
            url: `${ORIGIN}/embedded-settings`,
          }
        : {
            documentId: "top-document",
            parentFrameId: -1,
            url: `${ORIGIN}/settings`,
          });
      const controller = createBackgroundController({ chrome, store });

      const older = controller.handleContextMenuClick(
        createContextInfo(),
        { id: 7, windowId: 2, url: `${ORIGIN}/settings` },
      );
      await waitFor(() => modeReadIndex === 1);
      const newer = controller.handleContextMenuClick(
        createContextInfo({ frameId: 3, frameUrl: `${ORIGIN}/embedded-settings` }),
        { id: 7, windowId: 2, url: `${ORIGIN}/settings` },
      );
      await waitFor(() => modeReadIndex === 2);

      if (completionOrder === "older-first") {
        modeReads[0]!.resolve({ [CONTEXT_MENU_SELECTION_MODE_KEY]: "single" });
        await older;
        modeReads[1]!.resolve({ [CONTEXT_MENU_SELECTION_MODE_KEY]: "continuous" });
      } else {
        modeReads[1]!.resolve({ [CONTEXT_MENU_SELECTION_MODE_KEY]: "continuous" });
        await newer;
        modeReads[0]!.resolve({ [CONTEXT_MENU_SELECTION_MODE_KEY]: "single" });
      }
      await Promise.all([older, newer]);

      const enabledDeliveries = vi.mocked(chrome.tabs.sendMessage).mock.calls.filter(
        ([, message]) => isRecord(message) &&
          message.type === UI_ATTACH_CONTENT_SETTINGS_UPDATED &&
          message.testClickCaptureEnabled === true,
      );
      const seedDeliveries = vi.mocked(chrome.tabs.sendMessage).mock.calls.filter(
        ([, message]) => isRecord(message) &&
          message.type === UI_ATTACH_SELECTION_SEED_CONTEXT_TARGET,
      );
      expect(enabledDeliveries).toEqual([[7, {
        type: UI_ATTACH_CONTENT_SETTINGS_UPDATED,
        disclosureMode: "agent_safe",
        testClickCaptureEnabled: true,
      }, { frameId: 3, documentId: "child-document" }]]);
      expect(seedDeliveries).toEqual([[7, {
        type: UI_ATTACH_SELECTION_SEED_CONTEXT_TARGET,
      }, { frameId: 3, documentId: "child-document" }]]);
      expect(store.beginCapture).not.toHaveBeenCalled();
      expect(store.commitCapture).not.toHaveBeenCalled();
    },
  );

  test("a newer context intent synchronously cancels an older lease start stalled in injection", async () => {
    const chrome = createChromeHarness();
    const store = createStoreHarness();
    const olderInjection = createDeferred<boolean>();
    const ensureContentScript = vi.fn(async (_tabId: number, frameId: number) => (
      frameId === 0 ? olderInjection.promise : true
    ));
    chrome.tabs.query = vi.fn(async () => [
      { id: 7, url: `${ORIGIN}/settings`, windowId: 2 },
    ]);
    chrome.webNavigation.getFrame = vi.fn(async ({ frameId }) => frameId === 3
      ? {
          documentId: "child-document",
          parentFrameId: 0,
          url: `${ORIGIN}/embedded-settings`,
        }
      : {
          documentId: "top-document",
          parentFrameId: -1,
          url: `${ORIGIN}/settings`,
        });
    chrome.webNavigation.getAllFrames = vi.fn(async () => [
      { frameId: 0, parentFrameId: -1, url: `${ORIGIN}/settings`, documentId: "top-doc" },
      { frameId: 3, parentFrameId: 0, url: `${OTHER_ORIGIN}/embedded`, documentId: "child-doc" },
    ]);
    const controller = createBackgroundController({ chrome, store, ensureContentScript });

    const older = controller.handleContextMenuClick(
      createContextInfo(),
      { id: 7, windowId: 2, url: `${ORIGIN}/settings` },
    );
    await waitFor(() => ensureContentScript.mock.calls.some(([, frameId]) => frameId === 0));
    const newer = controller.handleContextMenuClick(
      createContextInfo({ frameId: 3, frameUrl: `${ORIGIN}/embedded-settings` }),
      { id: 7, windowId: 2, url: `${ORIGIN}/settings` },
    );
    await newer;
    olderInjection.resolve(true);
    await older;

    const enabledDeliveries = vi.mocked(chrome.tabs.sendMessage).mock.calls.filter(
      ([, message]) => isRecord(message) &&
        message.type === UI_ATTACH_CONTENT_SETTINGS_UPDATED &&
        message.testClickCaptureEnabled === true,
    );
    const seedDeliveries = vi.mocked(chrome.tabs.sendMessage).mock.calls.filter(
      ([, message]) => isRecord(message) &&
        message.type === UI_ATTACH_SELECTION_SEED_CONTEXT_TARGET,
    );
    expect(enabledDeliveries).toEqual([[7, {
      type: UI_ATTACH_CONTENT_SETTINGS_UPDATED,
      disclosureMode: "agent_safe",
      testClickCaptureEnabled: true,
    }, { frameId: 3, documentId: "child-document" }]]);
    expect(seedDeliveries).toEqual([[7, {
      type: UI_ATTACH_SELECTION_SEED_CONTEXT_TARGET,
    }, { frameId: 3, documentId: "child-document" }]]);
    expect(store.beginCapture).not.toHaveBeenCalled();
    expect(store.commitCapture).not.toHaveBeenCalled();
  });

  test("a missing context seed keeps the picker active without guessing or capturing", async () => {
    const chrome = createChromeHarness();
    const store = createStoreHarness();
    chrome.tabs.query = vi.fn(async () => [
      { id: 7, url: `${ORIGIN}/settings`, windowId: 2 },
    ]);
    chrome.webNavigation.getFrame = vi.fn(async () => ({
      documentId: "document-1",
      parentFrameId: -1,
      url: `${ORIGIN}/settings`,
    }));
    chrome.tabs.sendMessage = vi.fn(async (_tabId, message) => (
      isRecord(message) && message.type === UI_ATTACH_SELECTION_SEED_CONTEXT_TARGET
        ? { ok: true, data: { seeded: false } }
        : undefined
    ));
    const controller = createBackgroundController({ chrome, store });

    await controller.handleContextMenuClick(
      createContextInfo(),
      { id: 7, windowId: 2, url: `${ORIGIN}/settings` },
    );

    expect(store.beginCapture).not.toHaveBeenCalled();
    expect(store.commitCapture).not.toHaveBeenCalled();
    await expect(dispatchRuntime(controller, {
      type: "ui-attach:element-selection-get",
    }, createExtensionSender())).resolves.toEqual({ ok: true, data: { enabled: true } });
  });

  test("delivers same-origin child-frame selection and seed to the exact document", async () => {
    const chrome = createChromeHarness();
    const store = createStoreHarness();
    chrome.tabs.query = vi.fn(async () => [
      { id: 7, url: `${ORIGIN}/settings`, windowId: 2 },
    ]);
    chrome.webNavigation.getFrame = vi.fn(async ({ frameId }) => frameId === 3
      ? {
          documentId: "child-document",
          parentFrameId: 0,
          url: `${ORIGIN}/embedded-settings`,
        }
      : {
          documentId: "top-document",
          parentFrameId: -1,
          url: `${ORIGIN}/settings`,
        });
    const controller = createBackgroundController({ chrome, store });

    await controller.handleContextMenuClick(
      createContextInfo({ frameId: 3, frameUrl: `${ORIGIN}/embedded-settings` }),
      { id: 7, windowId: 2, url: `${ORIGIN}/settings` },
    );

    expect(chrome.tabs.sendMessage).toHaveBeenCalledWith(7, {
      type: UI_ATTACH_CONTENT_SETTINGS_UPDATED,
      disclosureMode: "agent_safe",
      testClickCaptureEnabled: true,
    }, { frameId: 3, documentId: "child-document" });
    expect(chrome.tabs.sendMessage).toHaveBeenCalledWith(7, {
      type: UI_ATTACH_SELECTION_SEED_CONTEXT_TARGET,
    }, { frameId: 3, documentId: "child-document" });
    expect(store.beginCapture).not.toHaveBeenCalled();
  });

  test("starts an unseeded top-frame picker when a freshly injected script missed contextmenu", async () => {
    const chrome = createChromeHarness();
    const store = createStoreHarness();
    chrome.tabs.query = vi.fn(async () => [
      { id: 7, url: `${ORIGIN}/settings`, windowId: 2 },
    ]);
    chrome.webNavigation.getFrame = vi.fn(async () => undefined);
    const controller = createBackgroundController({ chrome, store });

    await controller.handleContextMenuClick(
      createContextInfo(),
      { id: 7, windowId: 2, url: `${ORIGIN}/settings` },
    );

    expect(chrome.tabs.sendMessage).toHaveBeenCalledWith(7, {
      type: UI_ATTACH_SELECTION_SEED_CONTEXT_TARGET,
    }, { frameId: 0 });
    expect(store.beginCapture).not.toHaveBeenCalled();
    await expect(dispatchRuntime(controller, {
      type: "ui-attach:element-selection-get",
    }, createExtensionSender())).resolves.toEqual({ ok: true, data: { enabled: true } });
  });

  test("fails closed before session mutation when active-tab access cannot inject", async () => {
    const chrome = createChromeHarness();
    const store = createStoreHarness();
    const ensureContentScript = vi.fn(async () => false);
    chrome.tabs.query = vi.fn(async () => [
      { id: 7, url: `${ORIGIN}/settings`, windowId: 2 },
    ]);
    chrome.webNavigation.getFrame = vi.fn(async () => ({
      documentId: "document-1",
      parentFrameId: -1,
      url: `${ORIGIN}/settings`,
    }));
    const controller = createBackgroundController({ chrome, store, ensureContentScript });

    await controller.handleContextMenuClick(
      createContextInfo(),
      { id: 7, windowId: 2, url: `${ORIGIN}/settings` },
    );

    expect(ensureContentScript).toHaveBeenCalledWith(7, 0);
    expect(store.beginCapture).not.toHaveBeenCalled();
    expect(store.commitCapture).not.toHaveBeenCalled();
    expect(chrome.runtime.sentMessages).toContainEqual(expect.objectContaining({
      type: UI_ATTACH_CAPTURE_FAILED,
    }));
  });

  test("keeps the exact frame scope after stopping and resumes it on Add elements", async () => {
    const chrome = createChromeHarness();
    chrome.tabs.query = vi.fn(async () => [{ id: 7, url: `${ORIGIN}/settings`, windowId: 1 }]);
    chrome.tabs.sendMessage = vi.fn(async () => undefined);
    chrome.webNavigation.getAllFrames = vi.fn(async () => [
      { frameId: 0, parentFrameId: -1, url: `${ORIGIN}/settings`, documentId: "top-doc" },
      { frameId: 3, parentFrameId: 0, url: `${FRAME_ORIGIN}/embedded`, documentId: "frame-doc" },
    ]);
    chrome.webNavigation.getFrame = vi.fn(async ({ frameId }) => frameId === 0
      ? { frameId: 0, parentFrameId: -1, url: `${ORIGIN}/settings`, documentId: "top-doc" }
      : { frameId: 3, parentFrameId: 0, url: `${FRAME_ORIGIN}/embedded`, documentId: "frame-doc" });
    const ensureContentScript = vi.fn(async () => true);
    const store = createStoreHarness();
    const controller = createBackgroundController({ chrome, store, ensureContentScript });

    await dispatchRuntime(
      controller,
      embeddedFrameSelectionCommand(),
      createExtensionSender(),
    );
    await dispatchRuntime(
      controller,
      { type: "ui-attach:element-selection-set", enabled: false },
      createExtensionSender(),
    );

    const stopped = await dispatchRuntime(controller, {
      type: "ui-attach:session-get-active",
    }, createExtensionSender());
    const resumed = await dispatchRuntime(controller, {
      type: "ui-attach:element-selection-set",
      enabled: true,
      tabId: 7,
    }, createExtensionSender());

    expect(stopped).toMatchObject({
      ok: true,
      data: {
        origin: FRAME_ORIGIN,
        activePage: { tabId: 7, frameId: 3, origin: FRAME_ORIGIN, pathname: "/embedded" },
      },
    });
    expect(resumed).toEqual({ ok: true, data: { enabled: true } });
    expect(ensureContentScript).toHaveBeenLastCalledWith(7, 3);

    await dispatchRuntime(
      controller,
      { type: "ui-attach:element-selection-set", enabled: false },
      createExtensionSender(),
    );
    await controller.handleNavigationCommitted({
      documentId: "replacement-doc",
      frameId: 3,
      parentFrameId: 0,
      tabId: 7,
      url: `${FRAME_ORIGIN}/replacement`,
    });
    const invalidated = await dispatchRuntime(controller, {
      type: "ui-attach:session-get-active",
    }, createExtensionSender());

    expect(invalidated).toMatchObject({
      ok: true,
      data: {
        origin: ORIGIN,
        activePage: { tabId: 7, frameId: 0, origin: ORIGIN, pathname: "/settings" },
      },
    });
  });

  test("lists the live nested frame tree without requiring a captured iframe boundary", async () => {
    const chrome = createChromeHarness();
    chrome.tabs.query = vi.fn(async () => [{ id: 7, url: `${ORIGIN}/settings`, windowId: 1 }]);
    chrome.webNavigation.getAllFrames = vi.fn(async () => [
      {
        frameId: 5,
        parentFrameId: 3,
        url: `${FRAME_ORIGIN}/docs/mcp/reference`,
        documentId: "inner-doc",
      },
      {
        frameId: 0,
        parentFrameId: -1,
        url: `${ORIGIN}/settings`,
        documentId: "top-doc",
      },
      {
        frameId: 3,
        parentFrameId: 0,
        url: `${FRAME_ORIGIN}/embedded`,
        documentId: "outer-doc",
      },
    ]);
    const controller = createBackgroundController({ chrome, store: createStoreHarness() });

    const response = await dispatchRuntime(controller, {
      type: "ui-attach:frame-scope-list",
    }, createExtensionSender());

    expect(response).toEqual({
      ok: true,
      data: {
        tabId: 7,
        currentFrameId: 0,
        scopes: [
          {
            frameId: 0,
            parentFrameId: null,
            documentId: "top-doc",
            origin: ORIGIN,
            pathname: "/settings",
            depth: 0,
            requiresHostPermission: false,
            selectable: true,
          },
          {
            frameId: 3,
            parentFrameId: 0,
            documentId: "outer-doc",
            origin: FRAME_ORIGIN,
            pathname: "/embedded",
            depth: 1,
            requiresHostPermission: true,
            selectable: true,
          },
          {
            frameId: 5,
            parentFrameId: 3,
            documentId: "inner-doc",
            origin: FRAME_ORIGIN,
            pathname: "/docs/mcp/reference",
            depth: 2,
            requiresHostPermission: true,
            selectable: true,
          },
        ],
      },
    });
  });

  test("activates a live nested frame scope directly and rejects a stale document identity", async () => {
    const chrome = createChromeHarness();
    chrome.tabs.query = vi.fn(async () => [{ id: 7, url: `${ORIGIN}/settings`, windowId: 1 }]);
    chrome.tabs.sendMessage = vi.fn(async () => undefined);
    chrome.webNavigation.getAllFrames = vi.fn(async () => [
      {
        frameId: 0,
        parentFrameId: -1,
        url: `${ORIGIN}/settings`,
        documentId: "top-doc",
      },
      {
        frameId: 3,
        parentFrameId: 0,
        url: `${FRAME_ORIGIN}/embedded`,
        documentId: "outer-doc",
      },
      {
        frameId: 5,
        parentFrameId: 3,
        url: `${FRAME_ORIGIN}/docs/mcp/reference`,
        documentId: "inner-doc",
      },
    ]);
    chrome.webNavigation.getFrame = vi.fn(async ({ frameId }) => {
      if (frameId === 3) {
        return {
          parentFrameId: 0,
          url: `${FRAME_ORIGIN}/embedded`,
          documentId: "outer-doc",
        };
      }
      if (frameId === 5) {
        return {
          parentFrameId: 3,
          url: `${FRAME_ORIGIN}/docs/mcp/reference`,
          documentId: "inner-doc",
        };
      }
      return {
        parentFrameId: -1,
        url: `${ORIGIN}/settings`,
        documentId: "top-doc",
      };
    });
    const ensureContentScript = vi.fn(async () => true);
    const controller = createBackgroundController({
      chrome,
      store: createStoreHarness(),
      ensureContentScript,
    });

    const activated = await dispatchRuntime(controller, {
      type: "ui-attach:frame-scope-select",
      tabId: 7,
      frameId: 5,
      documentId: "inner-doc",
      origin: FRAME_ORIGIN,
      pathname: "/docs/mcp/reference",
      startSelection: true,
    }, createExtensionSender());
    const stale = await dispatchRuntime(controller, {
      type: "ui-attach:frame-scope-select",
      tabId: 7,
      frameId: 5,
      documentId: "replaced-doc",
      origin: FRAME_ORIGIN,
      pathname: "/docs/mcp/reference",
      startSelection: true,
    }, createExtensionSender());

    expect(activated).toEqual({ ok: true, data: { enabled: true } });
    expect(ensureContentScript).toHaveBeenCalledWith(7, 5);
    await expect(dispatchRuntime(controller, {
      type: "ui-attach:session-get-active",
    }, createExtensionSender())).resolves.toMatchObject({
      ok: true,
      data: {
        origin: FRAME_ORIGIN,
        activePage: {
          tabId: 7,
          frameId: 5,
          origin: FRAME_ORIGIN,
          pathname: "/docs/mcp/reference",
        },
      },
    });
    expect(stale).toMatchObject({ ok: false, code: "FRAME_UNAVAILABLE" });
  });

  test("starts the picker in the exact cross-origin frame chosen from the context menu", async () => {
    const chrome = createChromeHarness();
    const store = createStoreHarness();
    chrome.tabs.query = vi.fn(async () => [
      { id: 7, windowId: 2, url: `${ORIGIN}/settings` },
    ]);
    chrome.webNavigation.getFrame = vi.fn(async ({ frameId }) => frameId === 3
      ? {
          documentId: "child-doc",
          parentFrameId: 0,
          url: `${OTHER_ORIGIN}/embedded`,
        }
      : {
          documentId: "top-doc",
          parentFrameId: -1,
          url: `${ORIGIN}/settings`,
        });
    chrome.webNavigation.getAllFrames = vi.fn(async () => [
      { frameId: 0, parentFrameId: -1, url: `${ORIGIN}/settings`, documentId: "top-doc" },
      { frameId: 3, parentFrameId: 0, url: `${OTHER_ORIGIN}/embedded`, documentId: "child-doc" },
    ]);
    chrome.tabs.sendMessage = vi.fn(async () => undefined);
    chrome.permissions.contains = vi.fn(async () => false);
    chrome.permissions.request = vi.fn(async () => true);
    chrome.permissions.remove = vi.fn(async () => true);
    const controller = createBackgroundController({
      chrome,
      store,
      ensureContentScript: vi.fn(async () => true),
    });

    await controller.handleContextMenuClick(
      createContextInfo({ frameId: 3, frameUrl: `${OTHER_ORIGIN}/embedded` }),
      { id: 7, windowId: 2, url: `${ORIGIN}/settings` },
    );

    expect(store.beginCapture).not.toHaveBeenCalled();
    expect(store.commitCapture).not.toHaveBeenCalled();
    expect(chrome.permissions.request).toHaveBeenCalledWith({ origins: [`${OTHER_ORIGIN}/*`] });
    expect(chrome.tabs.sendMessage).toHaveBeenCalledWith(7, {
      type: UI_ATTACH_SELECTION_SEED_CONTEXT_TARGET,
    }, { frameId: 3, documentId: "child-doc" });
    expect(chrome.permissions.remove).toHaveBeenCalledWith({ origins: [`${OTHER_ORIGIN}/*`] });
    await expect(dispatchRuntime(controller, {
      type: "ui-attach:frame-scope-list",
    }, createExtensionSender())).resolves.toMatchObject({
      ok: true,
      data: { currentFrameId: 3 },
    });
  });

  test("keeps a manually selected frame scope per tab across tab switches and worker recreation", async () => {
    const chrome = createChromeHarness();
    let activeTab = { id: 7, windowId: 1, url: `${ORIGIN}/settings` };
    chrome.tabs.query = vi.fn(async () => [activeTab]);
    chrome.webNavigation.getAllFrames = vi.fn(async ({ tabId }) => tabId === 7
      ? [
          { frameId: 0, parentFrameId: -1, url: `${ORIGIN}/settings`, documentId: "top-doc" },
          { frameId: 3, parentFrameId: 0, url: `${FRAME_ORIGIN}/embedded`, documentId: "frame-doc" },
        ]
      : [
          { frameId: 0, parentFrameId: -1, url: `${OTHER_ORIGIN}/account`, documentId: "other-doc" },
        ]);
    chrome.webNavigation.getFrame = vi.fn(async ({ tabId, frameId }) => tabId === 7 && frameId === 3
      ? { parentFrameId: 0, url: `${FRAME_ORIGIN}/embedded`, documentId: "frame-doc" }
      : tabId === 7
        ? { parentFrameId: -1, url: `${ORIGIN}/settings`, documentId: "top-doc" }
        : { parentFrameId: -1, url: `${OTHER_ORIGIN}/account`, documentId: "other-doc" });
    const firstController = createBackgroundController({ chrome, store: createStoreHarness() });

    await expect(dispatchRuntime(firstController, {
      type: "ui-attach:frame-scope-select",
      tabId: 7,
      frameId: 3,
      documentId: "frame-doc",
      origin: FRAME_ORIGIN,
      pathname: "/embedded",
      startSelection: false,
    }, createExtensionSender())).resolves.toEqual({ ok: true, data: { enabled: false } });

    activeTab = { id: 8, windowId: 1, url: `${OTHER_ORIGIN}/account` };
    await firstController.handleTabActivated({ tabId: 8, windowId: 1 });
    activeTab = { id: 7, windowId: 1, url: `${ORIGIN}/settings` };
    await firstController.handleTabActivated({ tabId: 7, windowId: 1 });

    await expect(dispatchRuntime(firstController, {
      type: "ui-attach:frame-scope-list",
    }, createExtensionSender())).resolves.toMatchObject({
      ok: true,
      data: { tabId: 7, currentFrameId: 3 },
    });

    const recreatedController = createBackgroundController({ chrome, store: createStoreHarness() });
    await expect(dispatchRuntime(recreatedController, {
      type: "ui-attach:frame-scope-list",
    }, createExtensionSender())).resolves.toMatchObject({
      ok: true,
      data: { tabId: 7, currentFrameId: 3 },
    });
  });

  test("still rejects unsupported context-menu pages before selection", async () => {
    const chrome = createChromeHarness();
    const store = createStoreHarness();
    const controller = createBackgroundController({ chrome, store });

    await controller.handleContextMenuClick(
      createContextInfo({ pageUrl: "chrome://settings" }),
      { id: 7, windowId: 2, url: "chrome://settings" },
    );

    expect(chrome.tabs.sendMessage).not.toHaveBeenCalled();
    expect(chrome.runtime.sentMessages).toHaveLength(1);
  });
});

describe("background active-origin and runtime commands", () => {
  test.each([
    ["false", () => Promise.resolve(false)],
    ["rejected", () => Promise.reject(new Error(`access secret ${SECRET}`))],
  ])("fails closed across storage paths when readiness is %s", async (_label, createReadiness) => {
    const chrome = createChromeHarness();
    const store = createStoreHarness();
    let storageListener: ((
      changes: Record<string, { newValue?: unknown; oldValue?: unknown }>,
      areaName: string,
    ) => void) | undefined;
    chrome.storage.onChanged.addListener = vi.fn((listener) => {
      storageListener = listener;
    });
    const controller = createBackgroundController({
      chrome,
      store,
      storageAccessReady: createReadiness(),
    });
    controller.register();

    const response = await dispatchRuntime(
      controller,
      { type: "ui-attach:content-settings-get" },
      createSender(`${ORIGIN}/settings`),
    );
    await controller.handleContextMenuClick(
      createContextInfo(),
      { id: 7, url: `${ORIGIN}/settings` },
    );
    storageListener?.({
      "ui-attach:disclosure-mode": { newValue: "full_debug" },
    }, "local");
    await flushAsyncWork();

    expect(response).toEqual({
      ok: false,
      code: "CAPTURE_FAILED",
      error: SAFE_CAPTURE_ERROR,
    });
    expect(store.calls).toEqual([]);
    expect(chrome.storage.local.get).not.toHaveBeenCalled();
    expect(chrome.tabs.sendMessage).not.toHaveBeenCalled();
    expect(chrome.sidePanel?.open).toHaveBeenCalledWith({ tabId: 7 });
    expect(chrome.runtime.sentMessages).toEqual([
      { type: UI_ATTACH_CAPTURE_FAILED, error: SAFE_CAPTURE_ERROR },
    ]);
    expect(JSON.stringify({ response, messages: chrome.runtime.sentMessages })).not.toContain(SECRET);
  });

  test("allows begin and commit only from HTTP(S) content senders", async () => {
    const record = createCaptureRecord("save", "Save changes");
    const commands: unknown[] = [
      { type: "ui-attach:session-begin-capture" },
      { type: "ui-attach:session-commit-capture", token: TOKEN, record },
    ];
    const untrustedSenders: UiAttachChromeMessageSender[] = [
      createExtensionSender(),
      {},
      { url: `${ORIGIN}/settings` },
      { tab: { id: 7, url: `${ORIGIN}/settings` } },
      { url: `${ORIGIN}/settings`, tab: { id: 7, url: "chrome-extension://ui-attach/panel.html" } },
      { url: "not a url", tab: { id: 7, url: `${ORIGIN}/settings` } },
      { url: "ftp://app.example.test/settings", tab: { id: 7, url: `${ORIGIN}/settings` } },
      { url: `${ORIGIN}/settings`, tab: { id: 7, url: "data:text/plain,unsafe" } },
    ];

    for (const sender of untrustedSenders) {
      const store = createStoreHarness();
      const controller = createBackgroundController({ chrome: createChromeHarness(), store });
      for (const command of commands) {
        expect(await dispatchRuntime(controller, command, sender)).toMatchObject({
          ok: false,
          code: "UNTRUSTED_SENDER",
        });
      }
      expect(store.calls).toEqual([]);
    }
  });

  test("enforces the content and extension-page sender trust matrix", async () => {
    const panelCommands: unknown[] = [
      { type: "ui-attach:session-get-active" },
      { type: "ui-attach:session-list-stored" },
      { type: "ui-attach:session-review-stored", origin: ORIGIN },
      {
        type: "ui-attach:session-prepare-snapshot-handoff",
        origin: ORIGIN,
        epoch: "epoch-1",
      },
      { type: "ui-attach:session-clear-all-stored" },
      { type: "ui-attach:element-selection-get" },
      { type: "ui-attach:element-selection-set", enabled: false },
      {
        type: "ui-attach:session-update-intent",
        origin: ORIGIN,
        epoch: "epoch-1",
        itemId: "att_save",
        intent: "Explain save",
      },
      {
        type: "ui-attach:session-remove-item",
        origin: ORIGIN,
        epoch: "epoch-1",
        itemId: "att_save",
      },
      {
        type: "ui-attach:session-clear",
        origin: ORIGIN,
        epoch: "epoch-1",
        operationId: "clear-1",
      },
    ];
    const untrustedSenders: UiAttachChromeMessageSender[] = [
      createSender(`${ORIGIN}/settings`),
      {},
      { url: `${ORIGIN}/settings` },
      { url: "chrome-extension://ui-attach/panel.html", tab: { id: 7, url: `${ORIGIN}/settings` } },
      { url: "about:blank" },
      { url: "chrome-extension://" },
      { url: "ftp://ui-attach/panel.html" },
      { url: "not a url" },
    ];

    for (const sender of untrustedSenders) {
      const chrome = createChromeHarness();
      const store = createStoreHarness();
      const controller = createBackgroundController({ chrome, store });

      for (const command of panelCommands) {
        const response = await dispatchRuntime(controller, command, sender);
        expect(response).toMatchObject({ ok: false, code: "UNTRUSTED_SENDER" });
      }
      expect(store.calls).toEqual([]);
    }

    const chrome = createChromeHarness();
    const store = createStoreHarness();
    store.read = vi.fn(async (origin) => ({
      ok: true,
      value: createSessionReadback({ ...createCaptureRecord("save", "Save changes"), origin }),
    }));
    const controller = createBackgroundController({ chrome, store });
    for (const sender of [createExtensionSender(), createExtensionTabSender()]) {
      for (const command of panelCommands) {
        expect((await dispatchRuntime(controller, command, sender)).ok).toBe(true);
      }
    }
  });

  test("allows content settings reads only from HTTP(S) senders and ignores the legacy global flag", async () => {
    const chrome = createChromeHarness();
    chrome.storage.local.get = vi.fn(async () => ({
      "ui-attach:disclosure-mode": "full_debug",
      "ui-attach:test-click-capture-enabled": true,
      "ui-attach:capture:latest": { secret: SECRET },
    }));
    const controller = createBackgroundController({ chrome, store: createStoreHarness() });
    const command = { type: "ui-attach:content-settings-get" };

    const accepted = await dispatchRuntime(controller, command, createSender(`${ORIGIN}/settings`));
    expect(accepted).toEqual({
      ok: true,
      data: { disclosureMode: "full_debug", testClickCaptureEnabled: false },
    });
    expect(Object.keys((accepted as { data: object }).data)).toEqual([
      "disclosureMode",
      "testClickCaptureEnabled",
    ]);

    for (const sender of [createExtensionSender(), {}, { url: `${ORIGIN}/settings` }]) {
      expect(await dispatchRuntime(controller, command, sender)).toMatchObject({
        ok: false,
        code: "UNTRUSTED_SENDER",
      });
    }
  });

  test("defaults page markers to hidden and honors the explicit always-visible preference", async () => {
    const chrome = createChromeHarness();
    const controller = createBackgroundController({ chrome, store: createStoreHarness() });

    await expect(dispatchRuntime(
      controller,
      { type: UI_ATTACH_OVERLAY_VISIBILITY_GET },
      createSender(`${ORIGIN}/settings`),
    )).resolves.toEqual({ ok: true, data: { visible: false } });

    chrome.storage.local.get = vi.fn(async () => ({
      [OVERLAY_VISIBILITY_PREFERENCE_KEY]: "always",
    }));
    await expect(dispatchRuntime(
      controller,
      { type: UI_ATTACH_OVERLAY_VISIBILITY_GET },
      createSender(`${ORIGIN}/settings`),
    )).resolves.toEqual({ ok: true, data: { visible: true } });
  });

  test("shows markers for a panel window lease and hides them when the panel disconnects", async () => {
    const chrome = createChromeHarness();
    chrome.tabs.query = vi.fn(async () => [{
      id: 7,
      url: `${ORIGIN}/settings`,
      windowId: 2,
    }]);
    chrome.tabs.sendMessage = vi.fn(async () => undefined);
    const controller = createBackgroundController({ chrome, store: createStoreHarness() });
    controller.register();
    await flushAsyncWork();
    vi.mocked(chrome.tabs.sendMessage).mockClear();

    const connectListener = vi.mocked(chrome.runtime.onConnect.addListener).mock.calls[0]?.[0] as
      | ((port: UiAttachChromePort) => void)
      | undefined;
    const disconnectEvent = createEventHarness<() => void>();
    const port: UiAttachChromePort = {
      name: `${UI_ATTACH_PANEL_LIFECYCLE_PORT_PREFIX}:2`,
      sender: createExtensionSender(),
      disconnect: vi.fn(),
      onDisconnect: disconnectEvent,
    };
    connectListener?.(port);
    await flushAsyncWork();

    expect(chrome.tabs.sendMessage).toHaveBeenLastCalledWith(7, {
      type: UI_ATTACH_OVERLAY_VISIBILITY_UPDATED,
      visible: true,
    });

    const disconnectListener = vi.mocked(disconnectEvent.addListener).mock.calls[0]?.[0] as
      | (() => void)
      | undefined;
    disconnectListener?.();
    await flushAsyncWork();

    expect(chrome.tabs.sendMessage).toHaveBeenLastCalledWith(7, {
      type: UI_ATTACH_OVERLAY_VISIBILITY_UPDATED,
      visible: false,
    });
  });

  test("rejects selection stop without a matching active-tab lease", async () => {
    const chrome = createChromeHarness();
    const controller = createBackgroundController({ chrome, store: createStoreHarness() });
    const command = { type: "ui-attach:content-selection-disable" };

    expect(await dispatchRuntime(
      controller,
      command,
      createSender(`${ORIGIN}/settings`),
    )).toMatchObject({ ok: false, code: "SELECTION_NOT_ACTIVE" });

    for (const sender of [createExtensionSender(), {}, { url: `${ORIGIN}/settings` }]) {
      expect(await dispatchRuntime(controller, command, sender)).toMatchObject({
        ok: false,
        code: "UNTRUSTED_SENDER",
      });
    }
    expect(chrome.storage.local.set).not.toHaveBeenCalled();
  });

  test("leases element selection to the active HTTP(S) tab and rejects other tabs", async () => {
    const chrome = createChromeHarness();
    chrome.tabs.query = vi.fn(async (queryInfo) => queryInfo.active
      ? [{ id: 7, url: `${ORIGIN}/settings`, windowId: 1 }]
      : [
          { id: 7, url: `${ORIGIN}/settings`, windowId: 1 },
          { id: 8, url: `${OTHER_ORIGIN}/account`, windowId: 2 },
        ]);
    chrome.tabs.sendMessage = vi.fn(async () => undefined);
    const store = createStoreHarness();
    const controller = createBackgroundController({ chrome, store });

    expect(await dispatchRuntime(
      controller,
      { type: "ui-attach:element-selection-set", enabled: true, tabId: 7 },
      createExtensionSender(),
    )).toEqual({ ok: true, data: { enabled: true } });

    expect(await dispatchRuntime(
      controller,
      { type: "ui-attach:element-selection-get" },
      createExtensionSender(),
    )).toEqual({ ok: true, data: { enabled: true } });
    expect(await dispatchRuntime(
      controller,
      { type: "ui-attach:content-settings-get" },
      createSender(`${ORIGIN}/settings`, 7),
    )).toEqual({
      ok: true,
      data: { disclosureMode: "agent_safe", testClickCaptureEnabled: true },
    });
    expect(await dispatchRuntime(
      controller,
      { type: "ui-attach:content-settings-get" },
      createSender(`${OTHER_ORIGIN}/account`, 8),
    )).toEqual({
      ok: true,
      data: { disclosureMode: "agent_safe", testClickCaptureEnabled: false },
    });

    expect(await dispatchRuntime(
      controller,
      { type: "ui-attach:session-begin-capture" },
      createSender(`${OTHER_ORIGIN}/account`, 8),
    )).toMatchObject({ ok: false, code: "SELECTION_NOT_ACTIVE" });
    expect(store.calls).toEqual([]);
    expect(await dispatchRuntime(
      controller,
      { type: "ui-attach:content-selection-disable" },
      createSender(`${OTHER_ORIGIN}/account`, 8),
    )).toMatchObject({ ok: false, code: "SELECTION_NOT_ACTIVE" });

    expect(await dispatchRuntime(
      controller,
      { type: "ui-attach:session-begin-capture" },
      createSender(`${ORIGIN}/settings`, 7),
    )).toMatchObject({ ok: true });
    expect(await dispatchRuntime(
      controller,
      {
        type: "ui-attach:session-commit-capture",
        token: TOKEN,
        record: createCaptureRecord("save", "Save changes"),
      },
      createSender(`${OTHER_ORIGIN}/account`, 8),
    )).toMatchObject({ ok: false, code: "SELECTION_NOT_ACTIVE" });
    expect(await dispatchRuntime(
      controller,
      { type: "ui-attach:content-selection-disable" },
      createSender(`${ORIGIN}/settings`, 7),
    )).toEqual({ ok: true, data: null });
    expect(await dispatchRuntime(
      controller,
      {
        type: "ui-attach:session-commit-capture",
        token: TOKEN,
        record: createCaptureRecord("save", "Save changes"),
      },
      createSender(`${ORIGIN}/settings`, 7),
    )).toMatchObject({ ok: false, code: "SELECTION_NOT_ACTIVE" });
    expect(await dispatchRuntime(
      controller,
      { type: "ui-attach:element-selection-get" },
      createExtensionSender(),
    )).toEqual({ ok: true, data: { enabled: false } });
    expect(chrome.storage.local.set).not.toHaveBeenCalledWith({
      "ui-attach:test-click-capture-enabled": false,
    });
  });

  test("binds selection enable to the active tab chosen by the initiating panel window", async () => {
    const chrome = createChromeHarness();
    chrome.tabs.query = vi.fn(async (queryInfo) => {
      if (queryInfo.active && queryInfo.currentWindow) {
        return [{ id: 8, url: `${OTHER_ORIGIN}/account`, windowId: 2 }];
      }
      if (queryInfo.active) {
        return [
          { id: 7, url: `${ORIGIN}/settings`, windowId: 1 },
          { id: 8, url: `${OTHER_ORIGIN}/account`, windowId: 2 },
        ];
      }
      return [
        { id: 7, url: `${ORIGIN}/settings`, windowId: 1 },
        { id: 8, url: `${OTHER_ORIGIN}/account`, windowId: 2 },
      ];
    });
    chrome.tabs.sendMessage = vi.fn(async () => undefined);
    const controller = createBackgroundController({ chrome, store: createStoreHarness() });

    expect(await dispatchRuntime(
      controller,
      { type: "ui-attach:element-selection-set", enabled: true, tabId: 7 },
      createExtensionSender(),
    )).toEqual({ ok: true, data: { enabled: true } });
    expect(chrome.tabs.query).toHaveBeenCalledWith({ active: true });
    expect(chrome.tabs.sendMessage).toHaveBeenCalledWith(7, expect.objectContaining({
      type: "ui-attach:content-settings-updated",
      testClickCaptureEnabled: true,
    }), { frameId: 0 });
    await controller.handleTabActivated({ tabId: 8, windowId: 2 });
    expect(await dispatchRuntime(
      controller,
      { type: "ui-attach:element-selection-get" },
      createExtensionSender(),
    )).toEqual({ ok: true, data: { enabled: true } });

    await controller.handleTabActivated({ tabId: 9, windowId: 1 });
    expect(await dispatchRuntime(
      controller,
      { type: "ui-attach:element-selection-get" },
      createExtensionSender(),
    )).toEqual({ ok: true, data: { enabled: false } });

    expect(await dispatchRuntime(
      controller,
      { type: "ui-attach:element-selection-set", enabled: true, tabId: 9 },
      createExtensionSender(),
    )).toMatchObject({ ok: false, code: "ACTIVE_PAGE_UNAVAILABLE" });
  });

  test("fails closed when the initiating tab stops being active while enable is in flight", async () => {
    const chrome = createChromeHarness();
    let activeReadCount = 0;
    chrome.tabs.query = vi.fn(async (queryInfo) => {
      if (queryInfo.active) {
        activeReadCount += 1;
        return activeReadCount === 1
          ? [{ id: 7, url: `${ORIGIN}/settings`, windowId: 1 }]
          : [{ id: 8, url: `${OTHER_ORIGIN}/account`, windowId: 1 }];
      }
      return [
        { id: 7, url: `${ORIGIN}/settings`, windowId: 1 },
        { id: 8, url: `${OTHER_ORIGIN}/account`, windowId: 1 },
      ];
    });
    chrome.tabs.sendMessage = vi.fn(async () => undefined);
    const controller = createBackgroundController({ chrome, store: createStoreHarness() });

    expect(await dispatchRuntime(
      controller,
      { type: "ui-attach:element-selection-set", enabled: true, tabId: 7 },
      createExtensionSender(),
    )).toMatchObject({ ok: false, code: "ACTIVE_PAGE_UNAVAILABLE" });
    expect(await dispatchRuntime(
      controller,
      { type: "ui-attach:element-selection-get" },
      createExtensionSender(),
    )).toEqual({ ok: true, data: { enabled: false } });
    expect(chrome.tabs.sendMessage).toHaveBeenCalledWith(7, expect.objectContaining({
      type: "ui-attach:content-settings-updated",
      testClickCaptureEnabled: false,
    }));
  });

  test("does not revive selection when navigation occurs during content injection", async () => {
    const chrome = createChromeHarness();
    let currentUrl = `${ORIGIN}/settings`;
    chrome.tabs.query = vi.fn(async () => [{ id: 7, url: currentUrl, windowId: 1 }]);
    let finishInjection!: (ready: boolean) => void;
    const ensureContentScript = vi.fn(() => new Promise<boolean>((resolve) => {
      finishInjection = resolve;
    }));
    const controller = createBackgroundController({
      chrome,
      store: createStoreHarness(),
      ensureContentScript,
    });

    const enabling = dispatchRuntime(
      controller,
      { type: "ui-attach:element-selection-set", enabled: true, tabId: 7 },
      createExtensionSender(),
    );
    await vi.waitFor(() => expect(ensureContentScript).toHaveBeenCalledWith(7, 0));
    currentUrl = `${ORIGIN}/next`;
    await controller.handleTabUpdated(
      7,
      { status: "loading", url: currentUrl },
      { id: 7, url: currentUrl, windowId: 1 },
    );
    finishInjection(true);

    await expect(enabling).resolves.toEqual({ ok: true, data: { enabled: false } });
    await expect(dispatchRuntime(
      controller,
      { type: "ui-attach:element-selection-get" },
      createExtensionSender(),
    )).resolves.toEqual({ ok: true, data: { enabled: false } });
  });

  test("revokes the selection lease on tab activation and leased-tab navigation", async () => {
    const chrome = createChromeHarness();
    let activeTab = { id: 7, url: `${ORIGIN}/settings`, windowId: 1 };
    chrome.tabs.query = vi.fn(async (queryInfo) => queryInfo.active
      ? [activeTab]
      : [activeTab, { id: 8, url: `${OTHER_ORIGIN}/account`, windowId: 1 }]);
    chrome.tabs.sendMessage = vi.fn(async () => undefined);
    const controller = createBackgroundController({ chrome, store: createStoreHarness() });

    await dispatchRuntime(
      controller,
      { type: "ui-attach:element-selection-set", enabled: true, tabId: 7 },
      createExtensionSender(),
    );
    activeTab = { id: 8, url: `${OTHER_ORIGIN}/account`, windowId: 1 };
    await controller.handleTabActivated({ tabId: 8, windowId: 1 });
    expect(await dispatchRuntime(
      controller,
      { type: "ui-attach:element-selection-get" },
      createExtensionSender(),
    )).toEqual({ ok: true, data: { enabled: false } });

    activeTab = { id: 7, url: `${ORIGIN}/settings`, windowId: 1 };
    await dispatchRuntime(
      controller,
      { type: "ui-attach:element-selection-set", enabled: true, tabId: 7 },
      createExtensionSender(),
    );
    await controller.handleTabUpdated(
      7,
      { status: "complete" },
      { id: 7, url: `${ORIGIN}/settings` },
    );
    expect(await dispatchRuntime(
      controller,
      { type: "ui-attach:element-selection-get" },
      createExtensionSender(),
    )).toEqual({ ok: true, data: { enabled: true } });
    await controller.handleTabUpdated(
      7,
      { status: "loading", url: `${ORIGIN}/next` },
      { id: 7, url: `${ORIGIN}/next` },
    );
    expect(await dispatchRuntime(
      controller,
      { type: "ui-attach:element-selection-get" },
      createExtensionSender(),
    )).toEqual({ ok: true, data: { enabled: false } });
    expect(chrome.runtime.sentMessages).toEqual(expect.arrayContaining([
      { type: "ui-attach:element-selection-updated", enabled: false },
    ]));
  });

  test("fails closed when the active page is unsupported or has no content endpoint", async () => {
    const unsupportedChrome = createChromeHarness();
    unsupportedChrome.tabs.query = vi.fn(async (queryInfo) => queryInfo.active
      ? [{ id: 7, url: "chrome://extensions/", windowId: 1 }]
      : []);
    const unsupported = createBackgroundController({
      chrome: unsupportedChrome,
      store: createStoreHarness(),
    });

    expect(await dispatchRuntime(
      unsupported,
      { type: "ui-attach:element-selection-set", enabled: true, tabId: 7 },
      createExtensionSender(),
    )).toMatchObject({ ok: false, code: "ACTIVE_PAGE_UNAVAILABLE" });
    expect(unsupportedChrome.tabs.sendMessage).not.toHaveBeenCalled();

    const revokedGrantChrome = createChromeHarness();
    revokedGrantChrome.tabs.query = vi.fn(async (queryInfo) => queryInfo.active
      ? [{ id: 7, windowId: 1 }]
      : []);
    const revokedGrant = createBackgroundController({
      chrome: revokedGrantChrome,
      store: createStoreHarness(),
    });

    expect(await dispatchRuntime(
      revokedGrant,
      { type: "ui-attach:element-selection-set", enabled: true, tabId: 7 },
      createExtensionSender(),
    )).toMatchObject({ ok: false, code: "ACCESS_DENIED" });

    const unavailableChrome = createChromeHarness();
    unavailableChrome.tabs.query = vi.fn(async () => [{ id: 7, url: `${ORIGIN}/settings`, windowId: 1 }]);
    unavailableChrome.tabs.sendMessage = vi.fn(async () => {
      throw new Error("content unavailable");
    });
    const unavailable = createBackgroundController({
      chrome: unavailableChrome,
      store: createStoreHarness(),
    });

    expect(await dispatchRuntime(
      unavailable,
      { type: "ui-attach:element-selection-set", enabled: true, tabId: 7 },
      createExtensionSender(),
    )).toMatchObject({ ok: false, code: "CONTENT_UNAVAILABLE" });
    expect(await dispatchRuntime(
      unavailable,
      { type: "ui-attach:element-selection-get" },
      createExtensionSender(),
    )).toEqual({ ok: true, data: { enabled: false } });
  });

  test("requires exact-frame injection before enabling selection", async () => {
    const chrome = createChromeHarness();
    chrome.tabs.query = vi.fn(async () => [{ id: 7, url: `${ORIGIN}/settings`, windowId: 1 }]);
    const ensureContentScript = vi.fn(async () => false);
    const controller = createBackgroundController({
      chrome,
      store: createStoreHarness(),
      ensureContentScript,
    });

    expect(await dispatchRuntime(
      controller,
      { type: "ui-attach:element-selection-set", enabled: true, tabId: 7 },
      createExtensionSender(),
    )).toMatchObject({ ok: false, code: "ACCESS_DENIED" });
    expect(ensureContentScript).toHaveBeenCalledWith(7, 0);
    expect(chrome.tabs.sendMessage).not.toHaveBeenCalled();
  });

  test("register fail-closes surviving content scripts after a worker restart", async () => {
    const chrome = createChromeHarness();
    chrome.storage.local.get = vi.fn(async () => ({
      "ui-attach:test-click-capture-enabled": true,
    }));
    chrome.tabs.query = vi.fn(async () => [{ id: 7, url: `${ORIGIN}/settings`, windowId: 1 }]);
    chrome.tabs.sendMessage = vi.fn(async () => undefined);
    const controller = createBackgroundController({ chrome, store: createStoreHarness() });

    controller.register();
    await flushAsyncWork();

    expect(chrome.tabs.sendMessage).toHaveBeenCalledWith(7, {
      type: "ui-attach:content-settings-updated",
      disclosureMode: "agent_safe",
      testClickCaptureEnabled: false,
    });
    expect(chrome.storage.local.get).toHaveBeenCalledWith(
      OVERLAY_VISIBILITY_PREFERENCE_KEY,
    );
  });

  test("broadcasts only narrow content settings after trusted local setting changes", async () => {
    const chrome = createChromeHarness();
    let storageListener: ((
      changes: Record<string, { newValue?: unknown; oldValue?: unknown }>,
      areaName: string,
    ) => void) | undefined;
    chrome.storage.onChanged.addListener = vi.fn((listener) => {
      storageListener = listener;
    });
    chrome.storage.local.get = vi.fn(async () => ({
      "ui-attach:disclosure-mode": "developer_diagnostic",
      "ui-attach:test-click-capture-enabled": true,
      "ui-attach:capture:latest": { secret: SECRET },
    }));
    chrome.tabs.query = vi.fn(async () => [{ id: 7, url: `${ORIGIN}/settings` }]);
    const controller = createBackgroundController({ chrome, store: createStoreHarness() });
    controller.register();
    await flushAsyncWork();
    vi.mocked(chrome.tabs.sendMessage).mockClear();

    storageListener?.({
      "ui-attach:disclosure-mode": { oldValue: "agent_safe", newValue: "developer_diagnostic" },
    }, "local");
    await flushAsyncWork();

    expect(chrome.tabs.sendMessage).toHaveBeenCalledWith(7, {
      type: "ui-attach:content-settings-updated",
      disclosureMode: "developer_diagnostic",
      testClickCaptureEnabled: false,
    });
    expect(JSON.stringify(vi.mocked(chrome.tabs.sendMessage).mock.calls)).not.toContain(SECRET);
  });

  test("fails closed after a live permissive policy when trusted settings storage becomes unreadable", async () => {
    const chrome = createChromeHarness();
    let storageListener: ((
      changes: Record<string, { newValue?: unknown; oldValue?: unknown }>,
      areaName: string,
    ) => void) | undefined;
    chrome.storage.onChanged.addListener = vi.fn((listener) => {
      storageListener = listener;
    });
    let disclosureReadCount = 0;
    chrome.storage.local.get = vi.fn(async (keys) => {
      if (keys === OVERLAY_VISIBILITY_PREFERENCE_KEY) return {};
      disclosureReadCount += 1;
      if (disclosureReadCount === 1) {
        return { "ui-attach:disclosure-mode": "full_debug" };
      }
      throw new Error("trusted storage unavailable");
    });
    chrome.tabs.query = vi.fn(async () => [{ id: 7, url: `${ORIGIN}/settings`, windowId: 1 }]);
    chrome.tabs.sendMessage = vi.fn(async () => undefined);
    const controller = createBackgroundController({ chrome, store: createStoreHarness() });
    controller.register();
    await flushAsyncWork();
    vi.mocked(chrome.tabs.sendMessage).mockClear();

    expect(await dispatchRuntime(
      controller,
      { type: "ui-attach:element-selection-set", enabled: true, tabId: 7 },
      createExtensionSender(),
    )).toEqual({ ok: true, data: { enabled: true } });

    storageListener?.({
      "ui-attach:disclosure-mode": { oldValue: "agent_safe", newValue: "full_debug" },
    }, "local");
    await flushAsyncWork();

    expect(vi.mocked(chrome.tabs.sendMessage).mock.calls).toEqual([
      [7, {
        type: "ui-attach:content-settings-updated",
        disclosureMode: "full_debug",
        testClickCaptureEnabled: false,
      }],
      [7, {
        type: "ui-attach:content-settings-updated",
        disclosureMode: "full_debug",
        testClickCaptureEnabled: true,
      }, { frameId: 0 }],
      [7, {
        type: "ui-attach:content-settings-updated",
        disclosureMode: "agent_safe",
        testClickCaptureEnabled: false,
      }],
    ]);
    expect(disclosureReadCount).toBe(2);
    expect(await dispatchRuntime(
      controller,
      { type: "ui-attach:element-selection-get" },
      createExtensionSender(),
    )).toEqual({ ok: true, data: { enabled: false } });
  });

  test("coalesces overlapping settings reads so an older policy cannot follow a newer policy", async () => {
    const chrome = createChromeHarness();
    const reads: Array<ReturnType<typeof createDeferred<Record<string, unknown>>>> = [];
    let storageListener: ((
      changes: Record<string, { newValue?: unknown; oldValue?: unknown }>,
      areaName: string,
    ) => void) | undefined;
    chrome.storage.onChanged.addListener = vi.fn((listener) => {
      storageListener = listener;
    });
    chrome.storage.local.get = vi.fn((keys) => {
      if (keys === OVERLAY_VISIBILITY_PREFERENCE_KEY) return Promise.resolve({});
      const deferred = createDeferred<Record<string, unknown>>();
      reads.push(deferred);
      return deferred.promise;
    });
    chrome.tabs.query = vi.fn(async () => [{ id: 7, url: `${ORIGIN}/settings` }]);
    const controller = createBackgroundController({ chrome, store: createStoreHarness() });
    controller.register();
    await flushMicrotasks();
    vi.mocked(chrome.tabs.sendMessage).mockClear();

    storageListener?.({
      "ui-attach:disclosure-mode": { newValue: "full_debug" },
    }, "local");
    await flushMicrotasks();
    storageListener?.({
      "ui-attach:disclosure-mode": { newValue: "agent_safe" },
    }, "local");
    await flushMicrotasks();

    if (reads.length > 1) {
      for (const deferred of reads.slice(2)) {
        deferred.resolve({
          "ui-attach:disclosure-mode": "agent_safe",
        });
      }
      await flushMicrotasks();
      for (const deferred of reads.slice(0, 2)) {
        deferred.resolve({
          "ui-attach:disclosure-mode": "full_debug",
        });
      }
    } else {
      reads[0]?.resolve({
        "ui-attach:disclosure-mode": "full_debug",
      });
      await waitFor(() => reads.length > 1);
      reads[1]?.resolve({
        "ui-attach:disclosure-mode": "agent_safe",
      });
    }
    await flushAsyncWork();

    const contentSettingsCalls = vi.mocked(chrome.tabs.sendMessage).mock.calls.filter(
      ([, message]) => isRecord(message) && message.type === UI_ATTACH_CONTENT_SETTINGS_UPDATED,
    );
    expect(contentSettingsCalls).toEqual([[
      7,
      {
        type: "ui-attach:content-settings-updated",
        disclosureMode: "agent_safe",
        testClickCaptureEnabled: false,
      },
    ]]);
  });

  test("session-get-active queries the current active tab and never falls back to global latest", async () => {
    const chrome = createChromeHarness();
    const store = createStoreHarness();
    const controller = createBackgroundController({ chrome, store });
    chrome.tabs.query = vi.fn(async () => [{
      id: 8,
      url: `${OTHER_ORIGIN}/admin?token=${SECRET}#members`,
    }]);
    chrome.webNavigation.getFrame = vi.fn(async () => ({
      parentFrameId: -1,
      url: `${OTHER_ORIGIN}/admin?token=${SECRET}#members`,
      documentId: "document-01234567",
    }));
    store.read = vi.fn(async (origin) => ({
      ok: true,
      value: createReadback(createCaptureRecord("other", "Other"), origin),
    }));

    const active = await dispatchRuntime(controller, {
      type: "ui-attach:session-get-active",
    }, createExtensionSender());

    expect(chrome.tabs.query).toHaveBeenCalledWith({ active: true, currentWindow: true });
    expect(store.read).toHaveBeenCalledWith(OTHER_ORIGIN);
    expect(active).toMatchObject({
      ok: true,
      data: {
        enabled: true,
        origin: OTHER_ORIGIN,
        activePage: {
          tabId: 8,
          frameId: 0,
          origin: OTHER_ORIGIN,
          pathname: "/admin",
          documentId: "document-01234567",
        },
        readback: { origin: OTHER_ORIGIN },
      },
    });
    chrome.tabs.query = vi.fn(async () => []);
    store.calls.length = 0;
    const disabled = await dispatchRuntime(controller, {
      type: "ui-attach:session-get-active",
    }, createExtensionSender());

    expect(disabled).toEqual({
      ok: true,
      data: { enabled: false, origin: null, activePage: null, readback: null },
    });
    expect(store.calls).toEqual([]);
  });

  test("session-list-stored returns bounded summaries without querying or granting the active page", async () => {
    const chrome = createChromeHarness();
    const store = createStoreHarness();
    store.list = vi.fn(async () => ({
      ok: true,
      value: [{
        origin: OTHER_ORIGIN,
        epoch: "epoch-other",
        attachmentCount: 2,
        state: "ready" as const,
        clearPending: false,
        activeClearOperationId: null,
      }],
    }));
    const controller = createBackgroundController({ chrome, store });

    const response = await dispatchRuntime(controller, {
      type: "ui-attach:session-list-stored",
    }, createExtensionSender());

    expect(response).toEqual({
      ok: true,
      data: [{
        origin: OTHER_ORIGIN,
        epoch: "epoch-other",
        attachmentCount: 2,
        state: "ready",
        clearPending: false,
        activeClearOperationId: null,
      }],
    });
    expect(store.list).toHaveBeenCalledTimes(1);
    expect(chrome.tabs.query).not.toHaveBeenCalled();
  });

  test("session-review-stored returns a bounded Agent-safe review only to an extension page", async () => {
    const chrome = createChromeHarness();
    const store = createStoreHarness();
    const record = createCaptureRecord("save", "Save changes", "full_debug");
    const readback = createSessionReadback(record);
    store.read = vi.fn(async () => ({ ok: true, value: readback }));
    const controller = createBackgroundController({ chrome, store });

    const response = await dispatchRuntime(controller, {
      type: "ui-attach:session-review-stored",
      origin: ORIGIN,
    }, createExtensionSender());

    expect(response).toEqual({
      ok: true,
      data: {
        origin: ORIGIN,
        epoch: "epoch-1",
        routes: [{
          origin: ORIGIN,
          pathname: "/settings",
          frameKind: "top",
          targetCount: 1,
        }],
        items: [{
          label: "A",
          target: "button - Save changes",
          intent: "Update Save changes",
          capturedAt: "2026-07-11T10:00:00.000Z",
          sourceDisclosureMode: "full_debug",
        }],
      },
    });
    expect(JSON.stringify(response)).not.toContain("ada@example.com");
    expect(JSON.stringify(response)).not.toContain("sk-test-1234567890");
    expect(JSON.stringify(response)).not.toContain("att_save");
    expect(JSON.stringify(response)).not.toContain("pageUrl");
    expect(JSON.stringify(response)).not.toContain("tabId");
    expect(store.read).toHaveBeenCalledWith(ORIGIN);
    expect(chrome.tabs.query).not.toHaveBeenCalled();

    const untrusted = await dispatchRuntime(controller, {
      type: "ui-attach:session-review-stored",
      origin: ORIGIN,
    }, createSender(`${ORIGIN}/settings`));
    expect(untrusted).toMatchObject({ ok: false, code: "UNTRUSTED_SENDER" });
    expect(store.read).toHaveBeenCalledTimes(1);
  });

  test("prepares a bounded saved-snapshot handoff only for the exact reviewed epoch", async () => {
    const chrome = createChromeHarness();
    const store = createStoreHarness();
    const save = createCaptureRecord("save", "Save changes", "full_debug");
    save.intent = "Keep Save changes primary.";
    save.pageUrl = `${ORIGIN}/settings?token=stored-secret#private`;
    save.tabId = 77;
    save.frameId = 4;
    save.attachment.context.nearbyText = ["ada@example.com", "token=stored-secret"];
    const cancel = createCaptureRecord("cancel", "Cancel", "agent_safe");
    cancel.intent = "Use a quieter style.";
    store.read = vi.fn(async () => ({
      ok: true,
      value: createSessionReadbackMany([save, cancel]),
    }));
    const controller = createBackgroundController({ chrome, store });

    const response = await dispatchRuntime(controller, {
      type: "ui-attach:session-prepare-snapshot-handoff",
      origin: ORIGIN,
      epoch: "epoch-1",
    }, createExtensionSender());

    expect(response).toMatchObject({
      ok: true,
      data: {
        origin: ORIGIN,
        epoch: "epoch-1",
        format: "compact",
        bundle: {
          kind: "ui-attach.saved-snapshot-prompt-bundle",
          disclosureMode: "agent_safe",
          attachmentCount: 2,
          attachmentIds: ["att_save", "att_cancel"],
          authority: {
            status: "not_rechecked",
            routingPolicy: "omitted",
            evidencePolicy: "capture_time_observations_only",
            controlPolicy: "live_recheck_and_user_confirmation_required",
          },
          markdown: expect.stringContaining("Keep Save changes primary."),
        },
      },
    });
    const serialized = JSON.stringify(response);
    expect(serialized).not.toContain("stored-secret");
    expect(serialized).not.toContain("ada@example.com");
    expect(serialized).not.toContain("pageInstanceId");
    expect(serialized).not.toContain("tabId");
    expect(serialized).not.toContain("frameId");
    expect(store.read).toHaveBeenCalledWith(ORIGIN);
    expect(chrome.tabs.query).not.toHaveBeenCalled();

    const stale = await dispatchRuntime(controller, {
      type: "ui-attach:session-prepare-snapshot-handoff",
      origin: ORIGIN,
      epoch: "epoch-old",
    }, createExtensionSender());
    expect(stale).toMatchObject({ ok: false, code: "STALE_SESSION" });

    const untrusted = await dispatchRuntime(controller, {
      type: "ui-attach:session-prepare-snapshot-handoff",
      origin: ORIGIN,
      epoch: "epoch-1",
    }, createSender(`${ORIGIN}/settings`));
    expect(untrusted).toMatchObject({ ok: false, code: "UNTRUSTED_SENDER" });
  });

  test("session-clear-all-stored delegates only from an extension page and returns cleared origins", async () => {
    const chrome = createChromeHarness();
    const store = createStoreHarness();
    store.clearAll = vi.fn(async () => ({
      ok: true,
      value: { clearedOrigins: [OTHER_ORIGIN, ORIGIN] },
    }));
    const controller = createBackgroundController({ chrome, store });

    const response = await dispatchRuntime(controller, {
      type: "ui-attach:session-clear-all-stored",
    }, createExtensionSender());

    expect(response).toEqual({
      ok: true,
      data: { clearedOrigins: [OTHER_ORIGIN, ORIGIN] },
    });
    expect(store.clearAll).toHaveBeenCalledTimes(1);
    expect(chrome.tabs.query).not.toHaveBeenCalled();
  });

  test("runtime begin and commit validate sender origin and commit exactly once without retry", async () => {
    const chrome = createChromeHarness();
    const store = createStoreHarness();
    const record = createCaptureRecord("save", "Save changes");
    const controller = createBackgroundController({ chrome, store });
    chrome.tabs.query = vi.fn(async () => [{ id: 7, url: `${ORIGIN}/settings`, windowId: 1 }]);
    chrome.tabs.sendMessage = vi.fn(async () => undefined);
    store.beginCapture = vi.fn(async (origin) => ({ ok: true, value: { ...TOKEN, origin } }));
    store.commitCapture = vi.fn(async (_token, committedRecord) => ({
      ok: true,
      value: {
        itemId: "att_save",
        label: "A",
        readback: createSessionReadback(committedRecord),
      },
    }));
    await dispatchRuntime(
      controller,
      { type: "ui-attach:element-selection-set", enabled: true, tabId: 7 },
      createExtensionSender(),
    );
    chrome.runtime.sentMessages.length = 0;

    const begun = await dispatchRuntime(controller, {
      type: "ui-attach:session-begin-capture",
    }, createSender(`${ORIGIN}/settings`));
    expect(begun).toMatchObject({ ok: true, data: TOKEN });

    const stale = await dispatchRuntime(controller, {
      type: "ui-attach:session-commit-capture",
      token: { ...TOKEN, origin: OTHER_ORIGIN },
      record,
    }, createSender(`${ORIGIN}/settings`));
    expect(stale).toMatchObject({ ok: false, code: "STALE_CAPTURE_OPERATION" });

    const committed = await dispatchRuntime(controller, {
      type: "ui-attach:session-commit-capture",
      token: TOKEN,
      record,
    }, createSender(`${ORIGIN}/settings`));

    expect(committed).toEqual({
      ok: true,
      data: { origin: ORIGIN, epoch: "epoch-1", itemId: "att_save", label: "A" },
    });
    expect(Object.keys((committed as { data: object }).data)).toEqual([
      "origin",
      "epoch",
      "itemId",
      "label",
    ]);
    expect(JSON.stringify(committed)).not.toContain("file");
    expect(JSON.stringify(committed)).not.toContain("legacyRecord");
    expect(JSON.stringify(committed)).not.toContain("source");
    expect(store.commitCapture).toHaveBeenCalledTimes(1);
    expect(chrome.runtime.sentMessages.map((message) => message.type)).toEqual([
      UI_ATTACH_SESSION_UPDATED,
    ]);
  });

  test("runtime capture uses the sender frame origin instead of the top-level tab origin", async () => {
    const chrome = createChromeHarness();
    const store = createStoreHarness();
    const controller = createBackgroundController({ chrome, store });
    chrome.tabs.query = vi.fn(async () => [{ id: 7, url: `${ORIGIN}/host`, windowId: 1 }]);
    chrome.tabs.sendMessage = vi.fn(async () => undefined);
    const frameToken = { ...TOKEN, origin: OTHER_ORIGIN };
    const record = createCaptureRecord("frame-action", "Frame action");
    record.origin = OTHER_ORIGIN;
    record.pageUrl = `${OTHER_ORIGIN}/embedded`;
    record.attachment.source.url = `${OTHER_ORIGIN}/embedded`;
    record.attachment.policy.allowedDomains = [OTHER_ORIGIN];
    const sender: UiAttachChromeMessageSender & { url: string } = {
      documentId: "frame-doc",
      frameId: 3,
      url: `${OTHER_ORIGIN}/embedded`,
      tab: { id: 7, url: `${ORIGIN}/host` },
    };
    chrome.webNavigation.getAllFrames = vi.fn(async () => [{
      frameId: 3,
      parentFrameId: 0,
      url: `${OTHER_ORIGIN}/embedded`,
      documentId: "frame-doc",
    }]);
    chrome.webNavigation.getFrame = vi.fn(async () => ({
      frameId: 3,
      parentFrameId: 0,
      url: `${OTHER_ORIGIN}/embedded`,
      documentId: "frame-doc",
    }));
    await dispatchRuntime(
      controller,
      embeddedFrameSelectionCommand({
        pagePathname: "/host",
        frameOrigin: OTHER_ORIGIN,
      }),
      createExtensionSender(),
    );

    const activeFrameSession = await dispatchRuntime(controller, {
      type: "ui-attach:session-get-active",
    }, createExtensionSender());

    const begun = await dispatchRuntime(controller, {
      type: "ui-attach:session-begin-capture",
    }, sender);
    const committed = await dispatchRuntime(controller, {
      type: "ui-attach:session-commit-capture",
      token: frameToken,
      record,
    }, sender);

    expect(store.beginCapture).toHaveBeenCalledWith(OTHER_ORIGIN);
    expect(store.read).toHaveBeenLastCalledWith(OTHER_ORIGIN);
    expect(activeFrameSession).toMatchObject({
      ok: true,
      data: {
        origin: OTHER_ORIGIN,
        activePage: {
          tabId: 7,
          frameId: 3,
          origin: OTHER_ORIGIN,
          pathname: "/embedded",
        },
      },
    });
    expect(begun).toMatchObject({ ok: true, data: frameToken });
    expect(committed).toMatchObject({ ok: true, data: { origin: OTHER_ORIGIN } });
    expect(store.commitCapture).toHaveBeenCalledWith(frameToken, {
      ...record,
      tabId: 7,
      frameId: 3,
      routeChain: [
        { origin: ORIGIN, pathname: "/host" },
        { origin: OTHER_ORIGIN, pathname: "/embedded" },
      ],
    });
  });

  test("panel mutations delegate to the store and tab changes publish active origin only", async () => {
    const chrome = createChromeHarness();
    const store = createStoreHarness();
    const controller = createBackgroundController({ chrome, store });
    const readback = createReadback(createCaptureRecord("save", "Save changes"));
    store.updateIntent = vi.fn(async () => ({ ok: true, value: readback }));
    store.removeItem = vi.fn(async () => ({ ok: true, value: readback }));
    store.clear = vi.fn(async () => ({ ok: true, value: { ...readback, file: null } }));

    await dispatchRuntime(controller, {
      type: "ui-attach:session-update-intent",
      origin: ORIGIN,
      epoch: "epoch-1",
      itemId: "att_save",
      intent: "Explain save",
    }, createExtensionSender());
    await dispatchRuntime(controller, {
      type: "ui-attach:session-remove-item",
      origin: ORIGIN,
      epoch: "epoch-1",
      itemId: "att_save",
    }, createExtensionSender());
    await dispatchRuntime(controller, {
      type: "ui-attach:session-clear",
      origin: ORIGIN,
      epoch: "epoch-1",
      operationId: "clear-1",
    }, createExtensionSender());

    expect(store.updateIntent).toHaveBeenCalledWith(ORIGIN, "epoch-1", "att_save", "Explain save");
    expect(store.removeItem).toHaveBeenCalledWith(ORIGIN, "epoch-1", "att_save");
    expect(store.clear).toHaveBeenCalledWith(ORIGIN, "epoch-1", "clear-1");

    chrome.runtime.sentMessages.length = 0;
    chrome.tabs.query = vi.fn(async () => [{ id: 7, url: `${ORIGIN}/settings` }]);
    await controller.handleTabActivated({ tabId: 7, windowId: 1 });
    await controller.handleTabUpdated(7, { status: "complete", url: `${ORIGIN}/next` }, {
      id: 7,
      url: `${ORIGIN}/next`,
    });

    expect(chrome.runtime.sentMessages).toEqual([
      {
        type: UI_ATTACH_ACTIVE_ORIGIN_CHANGED,
        accessRequired: false,
        enabled: true,
        origin: ORIGIN,
      },
      {
        type: UI_ATTACH_ACTIVE_ORIGIN_CHANGED,
        accessRequired: false,
        enabled: true,
        origin: ORIGIN,
      },
    ]);
  });

  test("publishes a fresh active-page notification after toolbar access becomes ready", async () => {
    const chrome = createChromeHarness();
    chrome.tabs.query = vi.fn(async () => [{
      id: 8,
      url: `${OTHER_ORIGIN}/account`,
      windowId: 1,
    }]);
    const controller = createBackgroundController({ chrome, store: createStoreHarness() });

    await controller.refreshActivePage();

    expect(chrome.runtime.sentMessages).toEqual([{
      type: UI_ATTACH_ACTIVE_ORIGIN_CHANGED,
      accessRequired: false,
      enabled: true,
      origin: OTHER_ORIGIN,
    }]);
  });

  test("classifies a masked HTTP tab as requiring toolbar access", async () => {
    const chrome = createChromeHarness();
    chrome.tabs.query = vi.fn(async () => [{ id: 9, windowId: 1 }]);
    chrome.webNavigation.getAllFrames = vi.fn(async () => [{
      errorOccurred: false,
      frameId: 0,
      parentFrameId: -1,
      processId: 1,
      url: `${OTHER_ORIGIN}/account`,
    }]);
    const controller = createBackgroundController({ chrome, store: createStoreHarness() });

    await controller.refreshActivePage();

    expect(chrome.runtime.sentMessages).toEqual([{
      type: UI_ATTACH_ACTIVE_ORIGIN_CHANGED,
      accessRequired: true,
      enabled: false,
      origin: null,
    }]);
  });

  test("reclassifies a masked HTTP tab after navigation completes", async () => {
    const chrome = createChromeHarness();
    chrome.tabs.query = vi.fn(async () => [{ id: 9, windowId: 1 }]);
    chrome.webNavigation.getAllFrames = vi.fn()
      .mockResolvedValueOnce([])
      .mockResolvedValue([{ frameId: 0, url: `${OTHER_ORIGIN}/account` }]);
    const controller = createBackgroundController({ chrome, store: createStoreHarness() });

    await controller.handleTabActivated({ tabId: 9, windowId: 1 });
    await controller.handleTabUpdated(9, { status: "complete" }, { id: 9, windowId: 1 });

    expect(chrome.runtime.sentMessages).toEqual([
      {
        type: UI_ATTACH_ACTIVE_ORIGIN_CHANGED,
        accessRequired: false,
        enabled: false,
        origin: null,
      },
      {
        type: UI_ATTACH_ACTIVE_ORIGIN_CHANGED,
        accessRequired: true,
        enabled: false,
        origin: null,
      },
    ]);
  });

  test("syncs the complete labeled overlay set and selected item from a trusted panel", async () => {
    const chrome = createChromeHarness();
    const store = createStoreHarness();
    const save = { ...createCaptureRecord("save", "Save changes"), tabId: 7, frameId: 0 };
    const cancel = { ...createCaptureRecord("cancel", "Cancel"), tabId: 7, frameId: 0 };
    store.read = vi.fn(async () => ({ ok: true, value: createSessionReadbackMany([save, cancel]) }));
    const controller = createBackgroundController({ chrome, store });

    const response = await dispatchRuntime(controller, {
      type: "ui-attach:overlays-sync",
      origin: ORIGIN,
      activeItemId: "att_cancel",
    }, createExtensionSender());

    expect(response).toEqual({ ok: true, data: null });
    expect(chrome.tabs.sendMessage).toHaveBeenCalledWith(7, {
      type: UI_ATTACH_OVERLAY_STATE,
      origin: ORIGIN,
      activeItemId: "att_cancel",
      items: [
        { itemId: "att_save", attachmentId: "att_save", label: "A" },
        { itemId: "att_cancel", attachmentId: "att_cancel", label: "B" },
      ],
    }, { frameId: 0 });
  });

  test("forwards current-page preview and clear messages only to the active top frame", async () => {
    const chrome = createChromeHarness();
    const store = createStoreHarness();
    const save = { ...createCaptureRecord("save", "Save changes"), tabId: 7, frameId: 0 };
    store.read = vi.fn(async () => ({ ok: true, value: createSessionReadbackMany([save]) }));
    chrome.tabs.query = vi.fn(async () => [{ id: 7, url: `${ORIGIN}/settings?mode=compact#actions` }]);
    const controller = createBackgroundController({ chrome, store });

    const preview = await dispatchRuntime(controller, {
      type: UI_ATTACH_OVERLAY_PREVIEW,
      origin: ORIGIN,
      itemId: "att_save",
    }, createExtensionSender());
    const clear = await dispatchRuntime(controller, {
      type: UI_ATTACH_OVERLAY_PREVIEW,
      origin: ORIGIN,
      itemId: null,
    }, createExtensionSender());

    expect(preview).toEqual({ ok: true, data: null });
    expect(clear).toEqual({ ok: true, data: null });
    expect(chrome.tabs.sendMessage).toHaveBeenNthCalledWith(1, 7, {
      type: UI_ATTACH_OVERLAY_PREVIEW,
      origin: ORIGIN,
      pathname: "/settings",
      itemId: "att_save",
    }, { frameId: 0 });
    expect(chrome.tabs.sendMessage).toHaveBeenNthCalledWith(2, 7, {
      type: UI_ATTACH_OVERLAY_PREVIEW,
      origin: ORIGIN,
      pathname: "/settings",
      itemId: null,
    }, { frameId: 0 });
  });

  test("rejects preview targets outside the exact active page boundary", async () => {
    const chrome = createChromeHarness();
    const store = createStoreHarness();
    const current = { ...createCaptureRecord("save", "Save changes"), tabId: 7, frameId: 0 };
    const wrongPath = {
      ...createCaptureRecord("account", "Account"),
      pageUrl: `${ORIGIN}/account`,
      tabId: 7,
      frameId: 0,
    };
    const wrongTab = { ...createCaptureRecord("other", "Other"), tabId: 8, frameId: 0 };
    const wrongFrame = { ...createCaptureRecord("embed", "Embedded"), tabId: 7, frameId: 2 };
    store.read = vi.fn(async () => ({
      ok: true,
      value: createSessionReadbackMany([current, wrongPath, wrongTab, wrongFrame]),
    }));
    chrome.tabs.query = vi.fn(async () => [{ id: 7, url: `${ORIGIN}/settings` }]);
    const controller = createBackgroundController({ chrome, store });

    for (const itemId of ["att_account", "att_other", "att_embed", "att_missing"]) {
      const response = await dispatchRuntime(controller, {
        type: UI_ATTACH_OVERLAY_PREVIEW,
        origin: ORIGIN,
        itemId,
      }, createExtensionSender());
      expect(response).toMatchObject({ ok: false, code: "ITEM_NOT_FOUND" });
    }
    const relationAcrossRoutes = await dispatchRuntime(controller, {
      type: UI_ATTACH_OVERLAY_RELATION_PREVIEW,
      origin: ORIGIN,
      sourceItemId: "att_save",
      referenceItemId: "att_account",
    }, createExtensionSender());
    const wrongOriginClear = await dispatchRuntime(controller, {
      type: UI_ATTACH_OVERLAY_PREVIEW,
      origin: OTHER_ORIGIN,
      itemId: null,
    }, createExtensionSender());
    const untrusted = await dispatchRuntime(controller, {
      type: UI_ATTACH_OVERLAY_PREVIEW,
      origin: ORIGIN,
      itemId: "att_save",
    }, createSender(`${ORIGIN}/settings`));

    expect(relationAcrossRoutes).toMatchObject({ ok: false, code: "ITEM_NOT_FOUND" });
    expect(wrongOriginClear).toMatchObject({ ok: false, code: "ITEM_NOT_FOUND" });
    expect(untrusted).toMatchObject({ ok: false, code: "UNTRUSTED_SENDER" });
    expect(chrome.tabs.sendMessage).not.toHaveBeenCalled();
  });

  test("forwards a current-page relationship pair and clears it through the shared lease", async () => {
    const chrome = createChromeHarness();
    const store = createStoreHarness();
    const save = { ...createCaptureRecord("save", "Save changes"), tabId: 7, frameId: 0 };
    const cancel = { ...createCaptureRecord("cancel", "Cancel"), tabId: 7, frameId: 0 };
    store.read = vi.fn(async () => ({
      ok: true,
      value: createSessionReadbackMany([save, cancel]),
    }));
    chrome.tabs.query = vi.fn(async () => [{ id: 7, url: `${ORIGIN}/settings` }]);
    const controller = createBackgroundController({ chrome, store });

    const preview = await dispatchRuntime(controller, {
      type: UI_ATTACH_OVERLAY_RELATION_PREVIEW,
      origin: ORIGIN,
      sourceItemId: "att_save",
      referenceItemId: "att_cancel",
    }, createExtensionSender());
    const clear = await dispatchRuntime(controller, {
      type: UI_ATTACH_OVERLAY_PREVIEW,
      origin: ORIGIN,
      itemId: null,
    }, createExtensionSender());

    expect(preview).toEqual({ ok: true, data: null });
    expect(clear).toEqual({ ok: true, data: null });
    expect(chrome.tabs.sendMessage).toHaveBeenNthCalledWith(1, 7, {
      type: UI_ATTACH_OVERLAY_RELATION_PREVIEW,
      origin: ORIGIN,
      pathname: "/settings",
      sourceItemId: "att_save",
      referenceItemId: "att_cancel",
    }, { frameId: 0 });
    expect(chrome.tabs.sendMessage).toHaveBeenNthCalledWith(2, 7, {
      type: UI_ATTACH_OVERLAY_PREVIEW,
      origin: ORIGIN,
      pathname: "/settings",
      itemId: null,
    }, { frameId: 0 });
  });

  test("serializes rapid preview changes so an older send cannot finish last", async () => {
    const chrome = createChromeHarness();
    const store = createStoreHarness();
    const save = { ...createCaptureRecord("save", "Save changes"), tabId: 7, frameId: 0 };
    const cancel = { ...createCaptureRecord("cancel", "Cancel"), tabId: 7, frameId: 0 };
    store.read = vi.fn(async () => ({ ok: true, value: createSessionReadbackMany([save, cancel]) }));
    chrome.tabs.query = vi.fn(async () => [{ id: 7, url: `${ORIGIN}/settings` }]);
    const firstSend = createDeferred<unknown>();
    chrome.tabs.sendMessage = vi.fn()
      .mockImplementationOnce(async () => firstSend.promise)
      .mockImplementation(async () => undefined);
    const controller = createBackgroundController({ chrome, store });

    const first = dispatchRuntime(controller, {
      type: UI_ATTACH_OVERLAY_PREVIEW,
      origin: ORIGIN,
      itemId: "att_save",
    }, createExtensionSender());
    await waitFor(() => vi.mocked(chrome.tabs.sendMessage).mock.calls.length === 1);
    const second = dispatchRuntime(controller, {
      type: UI_ATTACH_OVERLAY_PREVIEW,
      origin: ORIGIN,
      itemId: "att_cancel",
    }, createExtensionSender());
    await waitFor(() => vi.mocked(chrome.tabs.sendMessage).mock.calls.length === 1);
    firstSend.resolve(undefined);
    await Promise.all([first, second]);
    expect(chrome.tabs.sendMessage).toHaveBeenNthCalledWith(2, 7, {
      type: UI_ATTACH_OVERLAY_PREVIEW,
      origin: ORIGIN,
      pathname: "/settings",
      itemId: "att_cancel",
    }, { frameId: 0 });
  });

  test("clears the original preview endpoint after the active tab changes", async () => {
    const chrome = createChromeHarness();
    const store = createStoreHarness();
    const save = { ...createCaptureRecord("save", "Save changes"), tabId: 7, frameId: 0 };
    store.read = vi.fn(async () => ({ ok: true, value: createSessionReadbackMany([save]) }));
    chrome.tabs.query = vi.fn(async () => [{ id: 7, url: `${ORIGIN}/settings` }]);
    const controller = createBackgroundController({ chrome, store });

    await dispatchRuntime(controller, {
      type: UI_ATTACH_OVERLAY_PREVIEW,
      origin: ORIGIN,
      itemId: "att_save",
    }, createExtensionSender());
    chrome.tabs.query = vi.fn(async () => [{ id: 8, url: `${OTHER_ORIGIN}/account` }]);
    const cleared = await dispatchRuntime(controller, {
      type: UI_ATTACH_OVERLAY_PREVIEW,
      origin: ORIGIN,
      itemId: null,
    }, createExtensionSender());

    expect(cleared).toEqual({ ok: true, data: null });
    expect(chrome.tabs.sendMessage).toHaveBeenNthCalledWith(2, 7, {
      type: UI_ATTACH_OVERLAY_PREVIEW,
      origin: ORIGIN,
      pathname: "/settings",
      itemId: null,
    }, { frameId: 0 });
  });

  test("clears an outstanding preview lease when another tab activates", async () => {
    const chrome = createChromeHarness();
    const store = createStoreHarness();
    const save = { ...createCaptureRecord("save", "Save changes"), tabId: 7, frameId: 0 };
    store.read = vi.fn(async () => ({ ok: true, value: createSessionReadbackMany([save]) }));
    chrome.tabs.query = vi.fn(async () => [{ id: 7, url: `${ORIGIN}/settings` }]);
    const controller = createBackgroundController({ chrome, store });

    await dispatchRuntime(controller, {
      type: UI_ATTACH_OVERLAY_PREVIEW,
      origin: ORIGIN,
      itemId: "att_save",
    }, createExtensionSender());
    chrome.tabs.query = vi.fn(async () => [{ id: 8, url: `${OTHER_ORIGIN}/account` }]);
    await controller.handleTabActivated({ tabId: 8, windowId: 1 });

    expect(chrome.tabs.sendMessage).toHaveBeenNthCalledWith(2, 7, {
      type: UI_ATTACH_OVERLAY_PREVIEW,
      origin: ORIGIN,
      pathname: "/settings",
      itemId: null,
    }, { frameId: 0 });
  });

  test("rechecks the active route after a delayed session read before preview send", async () => {
    const chrome = createChromeHarness();
    const store = createStoreHarness();
    const save = { ...createCaptureRecord("save", "Save changes"), tabId: 7, frameId: 0 };
    const delayedRead = createDeferred<ReturnType<ExtensionSessionStore["read"]> extends Promise<infer T> ? T : never>();
    store.read = vi.fn(async () => delayedRead.promise);
    chrome.tabs.query = vi.fn(async () => [{ id: 7, url: `${ORIGIN}/settings` }]);
    const controller = createBackgroundController({ chrome, store });

    const preview = dispatchRuntime(controller, {
      type: UI_ATTACH_OVERLAY_PREVIEW,
      origin: ORIGIN,
      itemId: "att_save",
    }, createExtensionSender());
    await flushMicrotasks();
    chrome.tabs.query = vi.fn(async () => [{ id: 7, url: `${ORIGIN}/account` }]);
    delayedRead.resolve({ ok: true, value: createSessionReadbackMany([save]) });

    expect(await preview).toMatchObject({ ok: false, code: "ITEM_NOT_FOUND" });
    expect(chrome.tabs.sendMessage).not.toHaveBeenCalled();
  });

  test("clears the sent endpoint when the active tab changes before preview send resolves", async () => {
    const chrome = createChromeHarness();
    const store = createStoreHarness();
    const save = { ...createCaptureRecord("save", "Save changes"), tabId: 7, frameId: 0 };
    store.read = vi.fn(async () => ({ ok: true, value: createSessionReadbackMany([save]) }));
    chrome.tabs.query = vi.fn(async () => [{ id: 7, url: `${ORIGIN}/settings` }]);
    const pendingSend = createDeferred<unknown>();
    chrome.tabs.sendMessage = vi.fn()
      .mockImplementationOnce(async () => pendingSend.promise)
      .mockImplementation(async () => undefined);
    const controller = createBackgroundController({ chrome, store });

    const preview = dispatchRuntime(controller, {
      type: UI_ATTACH_OVERLAY_PREVIEW,
      origin: ORIGIN,
      itemId: "att_save",
    }, createExtensionSender());
    await waitFor(() => vi.mocked(chrome.tabs.sendMessage).mock.calls.length === 1);
    chrome.tabs.query = vi.fn(async () => [{ id: 8, url: `${OTHER_ORIGIN}/account` }]);
    await controller.handleTabActivated({ tabId: 8, windowId: 1 });
    pendingSend.resolve(undefined);

    expect(await preview).toEqual({ ok: true, data: null });
    expect(chrome.tabs.sendMessage).toHaveBeenNthCalledWith(2, 7, {
      type: UI_ATTACH_OVERLAY_PREVIEW,
      origin: ORIGIN,
      pathname: "/settings",
      itemId: null,
    }, { frameId: 0 });
    const clearAfterRace = await dispatchRuntime(controller, {
      type: UI_ATTACH_OVERLAY_PREVIEW,
      origin: ORIGIN,
      itemId: null,
    }, createExtensionSender());
    expect(clearAfterRace).toMatchObject({ ok: false, code: "ITEM_NOT_FOUND" });
  });

  test("restores same-route overlays into a uniquely matched active frame after reopening in a new tab", async () => {
    const chrome = createChromeHarness();
    const store = createStoreHarness();
    const save = {
      ...createCaptureRecord("save", "Save changes"),
      pageUrl: `${ORIGIN}/settings?token=${SECRET}#billing`,
      tabId: 7,
      frameId: 3,
    };
    save.attachment.locatorBundle.primary = save.attachment.locatorBundle.primary && {
      ...save.attachment.locatorBundle.primary,
      notes: SECRET,
    };
    save.attachment.locatorBundle.candidates = [
      ...save.attachment.locatorBundle.candidates,
      { strategy: "xpath", value: "//button", confidence: 0.5 },
      { strategy: "coordinates", value: "10,20", confidence: 0.4 },
    ];
    const wrongFrame = {
      ...createCaptureRecord("cancel", "Cancel"),
      pageUrl: `${ORIGIN}/settings`,
      tabId: 7,
      frameId: 0,
    };
    store.read = vi.fn(async () => ({
      ok: true,
      value: createSessionReadbackMany([save, wrongFrame]),
    }));
    chrome.tabs.query = vi.fn(async () => [{
      id: 8,
      url: `${ORIGIN}/host`,
      windowId: 1,
    }]);
    chrome.webNavigation.getAllFrames = vi.fn(async () => [
      { frameId: 0, parentFrameId: -1, url: `${ORIGIN}/host`, documentId: "top-new" },
      { frameId: 5, parentFrameId: 0, url: `${ORIGIN}/settings?view=compact`, documentId: "frame-new" },
    ]);
    const controller = createBackgroundController({ chrome, store });

    const response = await dispatchRuntime(controller, {
      type: "ui-attach:overlays-restore-get",
    }, {
      url: `${ORIGIN}/settings?view=compact#top`,
      tab: { id: 8, url: `${ORIGIN}/host` },
      frameId: 5,
    });

    expect(response).toEqual({
      ok: true,
      data: {
        origin: ORIGIN,
        activeItemId: null,
        items: [{
          itemId: "att_save",
          attachmentId: "att_save",
          label: "A",
          locators: [
            {
              strategy: "playwright.role",
              value: 'page.getByRole("button", { name: "Save changes" })',
              confidence: 0.92,
            },
          ],
        }],
      },
    });
    expect(JSON.stringify(response)).not.toContain(SECRET);
    expect(store.read).toHaveBeenCalledWith(ORIGIN);
  });

  test("syncs the selected overlay to a uniquely rebound same-route page instance", async () => {
    const chrome = createChromeHarness();
    const store = createStoreHarness();
    const save = {
      ...createCaptureRecord("save", "Save changes"),
      pageUrl: `${ORIGIN}/settings`,
      tabId: 7,
      frameId: 0,
    };
    store.read = vi.fn(async () => ({
      ok: true,
      value: createSessionReadbackMany([save]),
    }));
    chrome.tabs.query = vi.fn(async () => [{
      id: 8,
      url: `${ORIGIN}/settings`,
      windowId: 1,
    }]);
    chrome.webNavigation.getAllFrames = vi.fn(async ({ tabId }) => tabId === 8
      ? [{
          frameId: 0,
          parentFrameId: -1,
          url: `${ORIGIN}/settings`,
          documentId: "document-reopened-01234567",
        }]
      : []);
    const controller = createBackgroundController({ chrome, store });

    const response = await dispatchRuntime(controller, {
      type: "ui-attach:overlays-sync",
      origin: ORIGIN,
      activeItemId: "att_save",
    }, createExtensionSender());

    expect(response).toEqual({ ok: true, data: null });
    expect(chrome.tabs.sendMessage).toHaveBeenCalledWith(8, {
      type: UI_ATTACH_OVERLAY_STATE,
      origin: ORIGIN,
      activeItemId: "att_save",
      items: [{ itemId: "att_save", attachmentId: "att_save", label: "A" }],
    }, { documentId: "document-reopened-01234567", frameId: 0 });
  });

  test("restores the panel-selected overlay after a document refresh instead of selecting the last item", async () => {
    const chrome = createChromeHarness();
    const store = createStoreHarness();
    const save = {
      ...createCaptureRecord("save", "Save changes"),
      pageUrl: `${ORIGIN}/settings`,
      tabId: 7,
      frameId: 0,
    };
    const cancel = {
      ...createCaptureRecord("cancel", "Cancel"),
      pageUrl: `${ORIGIN}/settings`,
      tabId: 7,
      frameId: 0,
    };
    cancel.attachment.locatorBundle.stability = {
      ...cancel.attachment.locatorBundle.stability,
      verifiedValue: 'page.getByRole("button", { name: "Cancel" })',
    };
    store.read = vi.fn(async () => ({
      ok: true,
      value: createSessionReadbackMany([save, cancel]),
    }));
    chrome.tabs.query = vi.fn(async () => [{
      id: 7,
      url: `${ORIGIN}/settings`,
      windowId: 1,
    }]);
    chrome.webNavigation.getAllFrames = vi.fn(async () => [{
      frameId: 0,
      parentFrameId: -1,
      url: `${ORIGIN}/settings`,
      documentId: "refreshed-document-01234567",
    }]);
    const controller = createBackgroundController({ chrome, store });

    await dispatchRuntime(controller, {
      type: "ui-attach:overlays-sync",
      origin: ORIGIN,
      activeItemId: "att_save",
    }, createExtensionSender());

    const response = await dispatchRuntime(controller, {
      type: "ui-attach:overlays-restore-get",
    }, {
      url: `${ORIGIN}/settings`,
      tab: { id: 7, url: `${ORIGIN}/settings`, windowId: 1 },
      frameId: 0,
      documentId: "refreshed-document-01234567",
    });

    expect(response).toMatchObject({
      ok: true,
      data: {
        activeItemId: "att_save",
        items: [
          { itemId: "att_save" },
          { itemId: "att_cancel" },
        ],
      },
    });
  });

  test("restores the selected overlay after the background restarts with the panel closed", async () => {
    const chrome = createChromeHarness();
    const sessionState: Record<string, unknown> = {};
    chrome.storage.session.get = vi.fn(async (key) => (
      typeof key === "string" && key in sessionState
        ? { [key]: sessionState[key] }
        : {}
    ));
    chrome.storage.session.set = vi.fn(async (values) => {
      Object.assign(sessionState, values);
    });
    const store = createStoreHarness();
    const save = {
      ...createCaptureRecord("save", "Save changes"),
      pageUrl: `${ORIGIN}/settings`,
      tabId: 7,
      frameId: 0,
    };
    const cancel = {
      ...createCaptureRecord("cancel", "Cancel"),
      pageUrl: `${ORIGIN}/settings`,
      tabId: 7,
      frameId: 0,
    };
    cancel.attachment.locatorBundle.stability = {
      ...cancel.attachment.locatorBundle.stability,
      verifiedValue: 'page.getByRole("button", { name: "Cancel" })',
    };
    store.read = vi.fn(async () => ({
      ok: true,
      value: createSessionReadbackMany([save, cancel]),
    }));
    chrome.tabs.query = vi.fn(async () => [{
      id: 7,
      url: `${ORIGIN}/settings`,
      windowId: 1,
    }]);
    chrome.webNavigation.getAllFrames = vi.fn(async () => [{
      frameId: 0,
      parentFrameId: -1,
      url: `${ORIGIN}/settings`,
      documentId: "current-document-01234567",
    }]);
    const firstController = createBackgroundController({ chrome, store });
    firstController.register();
    const connectListener = vi.mocked(chrome.runtime.onConnect.addListener).mock.calls[0]?.[0] as
      | ((port: UiAttachChromePort) => void)
      | undefined;
    const disconnectEvent = createEventHarness<() => void>();
    connectListener?.({
      name: `${UI_ATTACH_PANEL_LIFECYCLE_PORT_PREFIX}:1`,
      sender: createExtensionSender(),
      disconnect: vi.fn(),
      onDisconnect: disconnectEvent,
    });

    await dispatchRuntime(firstController, {
      type: "ui-attach:overlays-sync",
      origin: ORIGIN,
      activeItemId: "att_save",
    }, createExtensionSender());
    const disconnectListener = vi.mocked(disconnectEvent.addListener).mock.calls[0]?.[0] as
      | (() => void)
      | undefined;
    disconnectListener?.();
    await flushAsyncWork();

    const restartedController = createBackgroundController({ chrome, store });
    const activeSession = await dispatchRuntime(restartedController, {
      type: "ui-attach:session-get-active",
    }, createExtensionSender());
    const response = await dispatchRuntime(restartedController, {
      type: "ui-attach:overlays-restore-get",
    }, {
      url: `${ORIGIN}/settings`,
      tab: { id: 7, url: `${ORIGIN}/settings`, windowId: 1 },
      frameId: 0,
      documentId: "current-document-01234567",
    });

    expect(activeSession).toMatchObject({
      ok: true,
      data: { selectedItemId: "att_save" },
    });
    expect(response).toMatchObject({
      ok: true,
      data: { activeItemId: "att_save" },
    });
  });

  test("does not sync recorded overlays when the same tab and frame navigated to another route", async () => {
    const chrome = createChromeHarness();
    const store = createStoreHarness();
    const save = {
      ...createCaptureRecord("save", "Save changes"),
      pageUrl: `${ORIGIN}/settings`,
      tabId: 7,
      frameId: 0,
    };
    store.read = vi.fn(async () => ({
      ok: true,
      value: createSessionReadbackMany([save]),
    }));
    chrome.tabs.query = vi.fn(async () => [{
      id: 7,
      url: `${ORIGIN}/account`,
      windowId: 1,
    }]);
    chrome.webNavigation.getAllFrames = vi.fn(async () => [{
      frameId: 0,
      parentFrameId: -1,
      url: `${ORIGIN}/account`,
      documentId: "replacement-document-01234567",
    }]);
    const controller = createBackgroundController({ chrome, store });

    const response = await dispatchRuntime(controller, {
      type: "ui-attach:overlays-sync",
      origin: ORIGIN,
      activeItemId: "att_save",
    }, createExtensionSender());

    expect(response).toEqual({ ok: true, data: null });
    expect(chrome.tabs.sendMessage).not.toHaveBeenCalled();
  });

  test("restores a capture-verified content target across same-origin page views", async () => {
    const chrome = createChromeHarness();
    const store = createStoreHarness();
    const save = {
      ...createCaptureRecord("save", "Likes 10"),
      pageUrl: `${ORIGIN}/feed`,
      tabId: 7,
      frameId: 0,
    };
    const anchoredLocator = {
      strategy: "css" as const,
      value: 'article:has(a[href="/alice/status/1952521961831320123"]) [data-testid="like"]',
      confidence: 0.64,
      notes: "descendant anchored fallback",
    };
    save.attachment.locatorBundle.candidates = [
      ...save.attachment.locatorBundle.candidates,
      anchoredLocator,
    ];
    save.replayAttempts = [{
      strategy: anchoredLocator.strategy,
      value: anchoredLocator.value,
      replayVerified: true,
      uniqueness: true,
      failureReason: null,
      matchCount: 1,
      visible: true,
    }];
    store.read = vi.fn(async () => ({ ok: true, value: createSessionReadbackMany([save]) }));
    chrome.tabs.query = vi.fn(async () => [{
      id: 7,
      url: `${ORIGIN}/alice/status/1952521961831320123`,
      windowId: 1,
    }]);
    chrome.webNavigation.getAllFrames = vi.fn(async () => [{
      frameId: 0,
      parentFrameId: -1,
      url: `${ORIGIN}/alice/status/1952521961831320123`,
      documentId: "content-view-document-01234567",
    }]);
    const controller = createBackgroundController({ chrome, store });

    const response = await dispatchRuntime(controller, {
      type: "ui-attach:overlays-restore-get",
    }, {
      url: `${ORIGIN}/alice/status/1952521961831320123`,
      tab: { id: 7, url: `${ORIGIN}/alice/status/1952521961831320123` },
      frameId: 0,
    });

    expect(response).toEqual({
      ok: true,
      data: {
        origin: ORIGIN,
        activeItemId: null,
        items: [{
          itemId: "att_save",
          attachmentId: "att_save",
          label: "A",
          locators: [{
            strategy: anchoredLocator.strategy,
            value: anchoredLocator.value,
            confidence: anchoredLocator.confidence,
          }],
        }],
      },
    });
  });

  test("does not sync a recorded frame when its live ancestor route chain changed", async () => {
    const chrome = createChromeHarness();
    const store = createStoreHarness();
    const save = {
      ...createCaptureRecord("save", "Save changes"),
      origin: ORIGIN,
      pageUrl: `${ORIGIN}/embedded`,
      tabId: 7,
      frameId: 3,
      routeChain: [
        { origin: ORIGIN, pathname: "/settings" },
        { origin: ORIGIN, pathname: "/embedded" },
      ],
    };
    store.read = vi.fn(async () => ({
      ok: true,
      value: createSessionReadbackMany([save]),
    }));
    chrome.tabs.query = vi.fn(async () => [{
      id: 7,
      url: `${ORIGIN}/account`,
      windowId: 1,
    }]);
    chrome.webNavigation.getAllFrames = vi.fn(async () => [
      {
        frameId: 0,
        parentFrameId: -1,
        url: `${ORIGIN}/account`,
        documentId: "top-replacement-01234567",
      },
      {
        frameId: 3,
        parentFrameId: 0,
        url: `${ORIGIN}/embedded`,
        documentId: "frame-current-01234567",
      },
    ]);
    chrome.webNavigation.getFrame = vi.fn(async ({ frameId }) => frameId === 3
      ? {
          frameId: 3,
          parentFrameId: 0,
          url: `${ORIGIN}/embedded`,
          documentId: "frame-current-01234567",
        }
      : {
          frameId: 0,
          parentFrameId: -1,
          url: `${ORIGIN}/account`,
          documentId: "top-replacement-01234567",
        });
    const controller = createBackgroundController({ chrome, store });
    await expect(dispatchRuntime(controller, {
      type: "ui-attach:frame-scope-select",
      tabId: 7,
      frameId: 3,
      documentId: "frame-current-01234567",
      origin: ORIGIN,
      pathname: "/embedded",
      startSelection: false,
    }, createExtensionSender())).resolves.toEqual({ ok: true, data: { enabled: false } });
    await expect(dispatchRuntime(controller, {
      type: "ui-attach:session-get-active",
    }, createExtensionSender())).resolves.toMatchObject({
      ok: true,
      data: { activePage: { tabId: 7, frameId: 3, origin: ORIGIN, pathname: "/embedded" } },
    });
    vi.mocked(chrome.tabs.sendMessage).mockClear();

    const response = await dispatchRuntime(controller, {
      type: "ui-attach:overlays-sync",
      origin: ORIGIN,
      activeItemId: "att_save",
    }, createExtensionSender());

    expect(response).toEqual({ ok: true, data: null });
    expect(chrome.tabs.sendMessage).not.toHaveBeenCalled();
  });

  test("returns no restore targets for inactive, wrong-route, or ambiguous reopened frames", async () => {
    const chrome = createChromeHarness();
    const store = createStoreHarness();
    const save = {
      ...createCaptureRecord("save", "Save changes"),
      tabId: 7,
      frameId: 4,
    };
    store.read = vi.fn(async () => ({ ok: true, value: createSessionReadbackMany([save]) }));
    chrome.tabs.query = vi.fn(async () => [{
      id: 8,
      url: `${ORIGIN}/settings`,
      windowId: 1,
    }]);
    chrome.webNavigation.getAllFrames = vi.fn(async () => [
      { frameId: 0, parentFrameId: -1, url: `${ORIGIN}/settings`, documentId: "top-new" },
      { frameId: 2, parentFrameId: 0, url: `${ORIGIN}/settings`, documentId: "frame-a" },
      { frameId: 3, parentFrameId: 0, url: `${ORIGIN}/settings`, documentId: "frame-b" },
    ]);
    const controller = createBackgroundController({ chrome, store });

    const wrongPath = await dispatchRuntime(controller, {
      type: "ui-attach:overlays-restore-get",
    }, createSender(`${ORIGIN}/account`));
    const inactiveTab = await dispatchRuntime(controller, {
      type: "ui-attach:overlays-restore-get",
    }, { url: `${ORIGIN}/settings`, tab: { id: 9, url: `${ORIGIN}/settings` }, frameId: 0 });
    const ambiguousFrame = await dispatchRuntime(controller, {
      type: "ui-attach:overlays-restore-get",
    }, { url: `${ORIGIN}/settings`, tab: { id: 8, url: `${ORIGIN}/settings` }, frameId: 2 });
    const panel = await dispatchRuntime(controller, {
      type: "ui-attach:overlays-restore-get",
    }, createExtensionSender());

    for (const response of [wrongPath, inactiveTab, ambiguousFrame]) {
      expect(response).toEqual({
        ok: true,
        data: { origin: ORIGIN, activeItemId: null, items: [] },
      });
    }
    expect(panel).toMatchObject({ ok: false, code: "UNTRUSTED_SENDER" });
  });

  test("explicitly rechecks a saved capture only in the exact active page document", async () => {
    const chrome = createChromeHarness();
    const store = createStoreHarness();
    const save = { ...createCaptureRecord("save", "Save changes"), tabId: 7, frameId: 0 };
    store.read = vi.fn(async () => ({ ok: true, value: createSessionReadbackMany([save]) }));
    chrome.tabs.query = vi.fn(async () => [{
      id: 8,
      url: `${ORIGIN}/settings`,
      windowId: 1,
    }]);
    chrome.webNavigation.getFrame = vi.fn(async () => ({
      parentFrameId: -1,
      url: `${ORIGIN}/settings`,
      documentId: "document-new-01234567",
    }));
    chrome.tabs.sendMessage = vi.fn(async (_tabId, message) => (
      isRecord(message) && message.type === "ui-attach:content-ready-get"
        ? { ok: true, data: null }
        : {
            ok: true,
            data: {
              origin: ORIGIN,
              pathname: "/settings",
              items: [{ itemId: "att_save", status: "restored" }],
            },
          }
    ));
    const controller = createBackgroundController({ chrome, store });

    const response = await dispatchRuntime(controller, {
      type: "ui-attach:saved-session-restore-current",
      origin: ORIGIN,
    }, createExtensionSender());

    expect(response).toEqual({
      ok: true,
      data: {
        origin: ORIGIN,
        pathname: "/settings",
        items: [{ itemId: "att_save", status: "restored" }],
      },
    });
    expect(chrome.tabs.sendMessage).toHaveBeenLastCalledWith(8, {
      type: "ui-attach:overlay-restore-refresh",
    }, {
      frameId: 0,
      documentId: "document-new-01234567",
    });
  });

  test("retries transient frame discovery while resolving a newly opened saved route", async () => {
    const chrome = createChromeHarness();
    const store = createStoreHarness();
    const save = {
      ...createCaptureRecord("save", "Save changes"),
      origin: FRAME_ORIGIN,
      pageUrl: `${FRAME_ORIGIN}/docs/mcp/reference/index.html`,
      tabId: 7,
      frameId: 3,
    };
    save.attachment.source.url = save.pageUrl;
    save.attachment.policy.allowedDomains = [FRAME_ORIGIN];
    store.read = vi.fn(async () => ({ ok: true, value: createSessionReadbackMany([save]) }));
    chrome.tabs.query = vi.fn(async () => [{
      id: 8,
      url: `${ORIGIN}/host`,
      windowId: 1,
    }]);
    chrome.webNavigation.getFrame = vi.fn(async ({ tabId, frameId }) => {
      if (tabId !== 8) return undefined;
      return frameId === 0
        ? { parentFrameId: -1, url: `${ORIGIN}/host`, documentId: "top-doc" }
        : frameId === 3
          ? {
              parentFrameId: 0,
              url: `${FRAME_ORIGIN}/docs/mcp/reference/index.html`,
              documentId: "frame-doc",
            }
          : undefined;
    });
    let frameInventoryReads = 0;
    chrome.webNavigation.getAllFrames = vi.fn(async () => {
      frameInventoryReads += 1;
      if (frameInventoryReads <= 2) return undefined;
      return [
        { frameId: 0, parentFrameId: -1, url: `${ORIGIN}/host`, documentId: "top-doc" },
        {
          frameId: 3,
          parentFrameId: 0,
          url: `${FRAME_ORIGIN}/docs/mcp/reference/index.html`,
          documentId: "frame-doc",
        },
      ];
    });
    const controller = createBackgroundController({ chrome, store });

    const resolved = await dispatchRuntime(controller, {
      type: "ui-attach:saved-session-resolve-route",
      origin: FRAME_ORIGIN,
      pathname: "/docs/mcp/reference/index.html",
      frameKind: "embedded",
    }, createExtensionSender());

    expect(resolved).toEqual({
      ok: true,
      data: { location: "current_page", requiresHostPermission: true },
    });
    expect(frameInventoryReads).toBeGreaterThan(2);
  });

  test("discovers saved frames when the active tab URL grant was not refreshed", async () => {
    const chrome = createChromeHarness();
    const store = createStoreHarness();
    const routeChain = [
      { origin: ORIGIN, pathname: "/host" },
      { origin: FRAME_ORIGIN, pathname: "/docs/mcp/reference/index.html" },
    ];
    const save = {
      ...createCaptureRecord("save", "Save changes"),
      origin: FRAME_ORIGIN,
      pageUrl: `${FRAME_ORIGIN}/docs/mcp/reference/index.html`,
      tabId: 7,
      frameId: 3,
      routeChain,
    };
    save.attachment.source.url = save.pageUrl;
    save.attachment.policy.allowedDomains = [FRAME_ORIGIN];
    store.read = vi.fn(async () => ({ ok: true, value: createSessionReadbackMany([save]) }));
    chrome.tabs.query = vi.fn(async () => [{ id: 8, windowId: 1 }]);
    chrome.webNavigation.getFrame = vi.fn(async ({ tabId, frameId }) => {
      if (tabId !== 8) return undefined;
      return frameId === 0
        ? { parentFrameId: -1, url: `${ORIGIN}/host`, documentId: "top-doc" }
        : frameId === 5
          ? {
              parentFrameId: 0,
              url: `${FRAME_ORIGIN}/docs/mcp/reference/index.html`,
              documentId: "frame-doc",
            }
          : undefined;
    });
    chrome.webNavigation.getAllFrames = vi.fn(async ({ tabId }) => tabId === 8
      ? [
          { frameId: 0, parentFrameId: -1, url: `${ORIGIN}/host`, documentId: "top-doc" },
          {
            frameId: 5,
            parentFrameId: 0,
            url: `${FRAME_ORIGIN}/docs/mcp/reference/index.html`,
            documentId: "frame-doc",
          },
        ]
      : []);
    const controller = createBackgroundController({ chrome, store });

    const resolved = await dispatchRuntime(controller, {
      type: "ui-attach:saved-session-resolve-route",
      origin: FRAME_ORIGIN,
      pathname: "/docs/mcp/reference/index.html",
      frameKind: "embedded",
      routeChain,
    }, createExtensionSender());

    expect(resolved).toEqual({
      ok: true,
      data: { location: "current_page", requiresHostPermission: true },
    });
  });

  test("restores a discovered saved frame without requiring a refreshed active-tab URL grant", async () => {
    const chrome = createChromeHarness();
    const store = createStoreHarness();
    const routeChain = [
      { origin: ORIGIN, pathname: "/host" },
      { origin: FRAME_ORIGIN, pathname: "/docs/mcp/reference/index.html" },
    ];
    const save = {
      ...createCaptureRecord("save", "Save changes"),
      origin: FRAME_ORIGIN,
      pageUrl: `${FRAME_ORIGIN}/docs/mcp/reference/index.html`,
      tabId: 7,
      frameId: 3,
      routeChain,
    };
    save.attachment.source.url = save.pageUrl;
    save.attachment.policy.allowedDomains = [FRAME_ORIGIN];
    store.read = vi.fn(async () => ({ ok: true, value: createSessionReadbackMany([save]) }));
    chrome.tabs.query = vi.fn(async () => [{ id: 8, windowId: 1 }]);
    chrome.tabs.update = vi.fn(async () => ({ id: 8, windowId: 1 }));
    chrome.webNavigation.getFrame = vi.fn(async ({ tabId, frameId }) => {
      if (tabId !== 8) return undefined;
      return frameId === 0
        ? { parentFrameId: -1, url: `${ORIGIN}/host`, documentId: "top-doc" }
        : frameId === 5
          ? {
              parentFrameId: 0,
              url: `${FRAME_ORIGIN}/docs/mcp/reference/index.html`,
              documentId: "frame-doc",
            }
          : undefined;
    });
    chrome.webNavigation.getAllFrames = vi.fn(async ({ tabId }) => tabId === 8
      ? [
          { frameId: 0, parentFrameId: -1, url: `${ORIGIN}/host`, documentId: "top-doc" },
          {
            frameId: 5,
            parentFrameId: 0,
            url: `${FRAME_ORIGIN}/docs/mcp/reference/index.html`,
            documentId: "frame-doc",
          },
        ]
      : []);
    chrome.tabs.sendMessage = vi.fn(async (_tabId, message) => (
      isRecord(message) && message.type === "ui-attach:content-ready-get"
        ? { ok: true, data: null }
        : {
            ok: true,
            data: {
              origin: FRAME_ORIGIN,
              pathname: "/docs/mcp/reference/index.html",
              items: [{ itemId: "att_save", status: "restored" }],
            },
          }
    ));
    const ensureContentScript = vi.fn(async () => true);
    const controller = createBackgroundController({ chrome, store, ensureContentScript });

    const response = await dispatchRuntime(controller, {
      type: "ui-attach:saved-session-restore-route",
      origin: FRAME_ORIGIN,
      pathname: "/docs/mcp/reference/index.html",
      frameKind: "embedded",
      routeChain,
    }, createExtensionSender());
    const active = await dispatchRuntime(controller, {
      type: "ui-attach:session-get-active",
    }, createExtensionSender());
    const scopes = await dispatchRuntime(controller, {
      type: "ui-attach:frame-scope-list",
    }, createExtensionSender());

    expect(response).toMatchObject({ ok: true });
    expect(active).toMatchObject({
      ok: true,
      data: {
        enabled: true,
        origin: FRAME_ORIGIN,
        activePage: {
          tabId: 8,
          frameId: 5,
          origin: FRAME_ORIGIN,
          pathname: "/docs/mcp/reference/index.html",
          documentId: "frame-doc",
        },
      },
    });
    expect(scopes).toMatchObject({
      ok: true,
      data: {
        tabId: 8,
        currentFrameId: 5,
        scopes: [
          { frameId: 0, origin: ORIGIN, pathname: "/host" },
          {
            frameId: 5,
            origin: FRAME_ORIGIN,
            pathname: "/docs/mcp/reference/index.html",
          },
        ],
      },
    });
    expect(chrome.tabs.sendMessage).toHaveBeenLastCalledWith(8, {
      type: "ui-attach:overlay-restore-refresh",
    }, {
      frameId: 5,
      documentId: "frame-doc",
    });
  });

  test("finds the original live embedded frame, activates its tab, and restores it in one command", async () => {
    const chrome = createChromeHarness();
    const store = createStoreHarness();
    const routeChain = [
      { origin: ORIGIN, pathname: "/host" },
      { origin: FRAME_ORIGIN, pathname: "/docs/mcp/reference/index.html" },
    ];
    const save = {
      ...createCaptureRecord("save", "Save changes"),
      origin: FRAME_ORIGIN,
      pageUrl: `${FRAME_ORIGIN}/docs/mcp/reference/index.html`,
      tabId: 7,
      frameId: 3,
      routeChain,
    };
    save.attachment.source.url = save.pageUrl;
    save.attachment.policy.allowedDomains = [FRAME_ORIGIN];
    store.read = vi.fn(async () => ({ ok: true, value: createSessionReadbackMany([save]) }));
    let activationRequested = false;
    let activationQueryCount = 0;
    chrome.tabs.query = vi.fn(async (queryInfo) => {
      if (!queryInfo.active) return [];
      if (activationRequested) activationQueryCount += 1;
      return activationRequested && activationQueryCount >= 2
        ? [{ id: 7, url: `${ORIGIN}/host`, windowId: 1 }]
        : [{ id: 9, url: "chrome://newtab", windowId: 1 }];
    });
    chrome.tabs.update = vi.fn(async (tabId) => {
      activationRequested = true;
      return { id: tabId, url: `${ORIGIN}/host`, windowId: 1 };
    });
    chrome.windows = {
      update: vi.fn(async () => ({ id: 1, focused: true })),
    };
    chrome.webNavigation.getFrame = vi.fn(async ({ tabId, frameId }) => {
      if (tabId !== 7) return undefined;
      return frameId === 0
        ? { parentFrameId: -1, url: `${ORIGIN}/host`, documentId: "top-doc" }
        : frameId === 3
          ? {
              parentFrameId: 0,
              url: `${FRAME_ORIGIN}/docs/mcp/reference/index.html`,
              documentId: "frame-doc",
            }
          : undefined;
    });
    chrome.webNavigation.getAllFrames = vi.fn(async ({ tabId }) => tabId === 7
      ? [
          { frameId: 0, parentFrameId: -1, url: `${ORIGIN}/host`, documentId: "top-doc" },
          {
            frameId: 3,
            parentFrameId: 0,
            url: `${FRAME_ORIGIN}/docs/mcp/reference/index.html`,
            documentId: "frame-doc",
          },
        ]
      : []);
    let overlayRestoreRequestCount = 0;
    chrome.tabs.sendMessage = vi.fn(async (_tabId, message) => {
      if (isRecord(message) && message.type === "ui-attach:content-ready-get") {
        return { ok: true, data: null };
      }
      overlayRestoreRequestCount += 1;
      return overlayRestoreRequestCount === 1
        ? { ok: false, error: "content restore still settling" }
        : {
            ok: true,
            data: {
              origin: FRAME_ORIGIN,
              pathname: "/docs/mcp/reference/index.html",
              items: [{ itemId: "att_save", status: "restored" }],
            },
          };
    });
    const ensureContentScript = vi.fn()
      .mockResolvedValueOnce(false)
      .mockResolvedValue(true);
    const controller = createBackgroundController({ chrome, store, ensureContentScript });

    const resolved = await dispatchRuntime(controller, {
      type: "ui-attach:saved-session-resolve-route",
      origin: FRAME_ORIGIN,
      pathname: "/docs/mcp/reference/index.html",
      frameKind: "embedded",
      routeChain,
    }, createExtensionSender());
    const response = await dispatchRuntime(controller, {
      type: "ui-attach:saved-session-restore-route",
      origin: FRAME_ORIGIN,
      pathname: "/docs/mcp/reference/index.html",
      frameKind: "embedded",
      routeChain,
    }, createExtensionSender());

    expect(resolved).toEqual({
      ok: true,
      data: { location: "original_tab", requiresHostPermission: true },
    });
    expect(JSON.stringify(resolved)).not.toContain("tabId");
    expect(JSON.stringify(resolved)).not.toContain("frameId");
    expect(response).toMatchObject({
      ok: true,
      data: {
        origin: FRAME_ORIGIN,
        pathname: "/docs/mcp/reference/index.html",
        items: [{ itemId: "att_save", status: "restored" }],
      },
    });
    expect(chrome.tabs.update).toHaveBeenCalledWith(7, { active: true });
    expect(chrome.windows.update).toHaveBeenCalledWith(1, { focused: true });
    expect(activationQueryCount).toBeGreaterThanOrEqual(2);
    expect(ensureContentScript).toHaveBeenCalledTimes(2);
    expect(overlayRestoreRequestCount).toBe(2);
    expect(chrome.tabs.sendMessage).toHaveBeenLastCalledWith(7, {
      type: "ui-attach:overlay-restore-refresh",
    }, {
      frameId: 3,
      documentId: "frame-doc",
    });
  });

  test("stops content readiness retries when the saved frame changes document", async () => {
    const chrome = createChromeHarness();
    const store = createStoreHarness();
    const save = {
      ...createCaptureRecord("save", "Save changes"),
      pageUrl: `${ORIGIN}/settings`,
      tabId: 7,
      frameId: 0,
    };
    store.read = vi.fn(async () => ({ ok: true, value: createSessionReadbackMany([save]) }));
    chrome.tabs.query = vi.fn(async () => [{
      id: 7,
      url: `${ORIGIN}/settings`,
      windowId: 1,
    }]);
    chrome.tabs.update = vi.fn(async () => ({
      id: 7,
      url: `${ORIGIN}/settings`,
      windowId: 1,
    }));
    let documentId = "document-original-01234567";
    chrome.webNavigation.getFrame = vi.fn(async () => ({
      parentFrameId: -1,
      url: `${ORIGIN}/settings`,
      documentId,
    }));
    chrome.webNavigation.getAllFrames = vi.fn(async () => [{
      frameId: 0,
      parentFrameId: -1,
      url: `${ORIGIN}/settings`,
      documentId,
    }]);
    const ensureContentScript = vi.fn(async () => {
      documentId = "document-replacement-01234567";
      return false;
    });
    const controller = createBackgroundController({ chrome, store, ensureContentScript });

    const response = await dispatchRuntime(controller, {
      type: "ui-attach:saved-session-restore-route",
      origin: ORIGIN,
      pathname: "/settings",
      frameKind: "top",
    }, createExtensionSender());

    expect(response).toMatchObject({ ok: false, code: "FRAME_UNAVAILABLE" });
    expect(ensureContentScript).toHaveBeenCalledTimes(1);
    expect(chrome.tabs.sendMessage).not.toHaveBeenCalled();
  });

  test("stops response retries when the saved page changes route", async () => {
    const chrome = createChromeHarness();
    const store = createStoreHarness();
    const save = {
      ...createCaptureRecord("save", "Save changes"),
      pageUrl: `${ORIGIN}/settings`,
      tabId: 7,
      frameId: 0,
    };
    store.read = vi.fn(async () => ({ ok: true, value: createSessionReadbackMany([save]) }));
    chrome.tabs.query = vi.fn(async () => [{
      id: 7,
      url: `${ORIGIN}/settings`,
      windowId: 1,
    }]);
    chrome.tabs.update = vi.fn(async () => ({
      id: 7,
      url: `${ORIGIN}/settings`,
      windowId: 1,
    }));
    let frameUrl = `${ORIGIN}/settings`;
    chrome.webNavigation.getFrame = vi.fn(async () => ({
      parentFrameId: -1,
      url: frameUrl,
      documentId: "document-original-01234567",
    }));
    chrome.webNavigation.getAllFrames = vi.fn(async () => [{
      frameId: 0,
      parentFrameId: -1,
      url: frameUrl,
      documentId: "document-original-01234567",
    }]);
    chrome.tabs.sendMessage = vi.fn(async () => {
      frameUrl = `${ORIGIN}/account`;
      return { ok: false, error: "restore still settling" };
    });
    const controller = createBackgroundController({ chrome, store });

    const response = await dispatchRuntime(controller, {
      type: "ui-attach:saved-session-restore-route",
      origin: ORIGIN,
      pathname: "/settings",
      frameKind: "top",
    }, createExtensionSender());

    expect(response).toMatchObject({ ok: false, code: "FRAME_UNAVAILABLE" });
    expect(chrome.tabs.sendMessage).toHaveBeenCalledTimes(1);
  });

  test("stops response retries when the user switches away from the saved tab", async () => {
    const chrome = createChromeHarness();
    const store = createStoreHarness();
    const save = {
      ...createCaptureRecord("save", "Save changes"),
      pageUrl: `${ORIGIN}/settings`,
      tabId: 7,
      frameId: 0,
    };
    store.read = vi.fn(async () => ({ ok: true, value: createSessionReadbackMany([save]) }));
    let activeTabId = 7;
    chrome.tabs.query = vi.fn(async () => activeTabId === 7
      ? [{ id: 7, url: `${ORIGIN}/settings`, windowId: 1 }]
      : [{ id: 9, url: `${ORIGIN}/other`, windowId: 1 }]);
    chrome.tabs.update = vi.fn(async () => ({
      id: 7,
      url: `${ORIGIN}/settings`,
      windowId: 1,
    }));
    chrome.webNavigation.getFrame = vi.fn(async () => ({
      parentFrameId: -1,
      url: `${ORIGIN}/settings`,
      documentId: "document-original-01234567",
    }));
    chrome.webNavigation.getAllFrames = vi.fn(async () => [{
      frameId: 0,
      parentFrameId: -1,
      url: `${ORIGIN}/settings`,
      documentId: "document-original-01234567",
    }]);
    chrome.tabs.sendMessage = vi.fn(async () => {
      activeTabId = 9;
      return { ok: false, error: "restore still settling" };
    });
    const controller = createBackgroundController({ chrome, store });

    const response = await dispatchRuntime(controller, {
      type: "ui-attach:saved-session-restore-route",
      origin: ORIGIN,
      pathname: "/settings",
      frameKind: "top",
    }, createExtensionSender());

    expect(response).toMatchObject({ ok: false, code: "FRAME_UNAVAILABLE" });
    expect(chrome.tabs.sendMessage).toHaveBeenCalledTimes(1);
  });

  test("does not treat an empty saved-route rebind response as restored", async () => {
    const chrome = createChromeHarness();
    const store = createStoreHarness();
    const save = {
      ...createCaptureRecord("save", "Save changes"),
      pageUrl: `${ORIGIN}/settings`,
      tabId: 7,
      frameId: 0,
    };
    store.read = vi.fn(async () => ({ ok: true, value: createSessionReadbackMany([save]) }));
    chrome.tabs.query = vi.fn(async () => [{
      id: 7,
      url: `${ORIGIN}/settings`,
      windowId: 1,
    }]);
    chrome.tabs.update = vi.fn(async () => ({
      id: 7,
      url: `${ORIGIN}/settings`,
      windowId: 1,
    }));
    chrome.webNavigation.getFrame = vi.fn(async () => ({
      parentFrameId: -1,
      url: `${ORIGIN}/settings`,
      documentId: "document-original-01234567",
    }));
    chrome.webNavigation.getAllFrames = vi.fn(async () => [{
      frameId: 0,
      parentFrameId: -1,
      url: `${ORIGIN}/settings`,
      documentId: "document-original-01234567",
    }]);
    chrome.tabs.sendMessage = vi.fn(async () => ({
      ok: true,
      data: { origin: ORIGIN, pathname: "/settings", items: [] },
    }));
    const controller = createBackgroundController({ chrome, store });

    const response = await dispatchRuntime(controller, {
      type: "ui-attach:saved-session-restore-route",
      origin: ORIGIN,
      pathname: "/settings",
      frameKind: "top",
    }, createExtensionSender());

    expect(response).toMatchObject({ ok: false, code: "RESTORE_UNAVAILABLE" });
    expect(chrome.tabs.sendMessage).toHaveBeenCalledTimes(3);
  });

  test("falls back to one matching embedded frame in the current host page", async () => {
    const chrome = createChromeHarness();
    const store = createStoreHarness();
    const save = {
      ...createCaptureRecord("save", "Save changes"),
      origin: FRAME_ORIGIN,
      pageUrl: `${FRAME_ORIGIN}/docs/mcp/reference/index.html`,
      tabId: 7,
      frameId: 3,
    };
    save.attachment.source.url = save.pageUrl;
    save.attachment.policy.allowedDomains = [FRAME_ORIGIN];
    store.read = vi.fn(async () => ({ ok: true, value: createSessionReadbackMany([save]) }));
    chrome.tabs.query = vi.fn(async () => [{ id: 8, url: `${ORIGIN}/host`, windowId: 1 }]);
    chrome.tabs.update = vi.fn(async () => ({ id: 8, url: `${ORIGIN}/host`, windowId: 1 }));
    chrome.webNavigation.getFrame = vi.fn(async ({ tabId, frameId }) => {
      if (tabId === 7) return undefined;
      return tabId === 8 && frameId === 0
        ? { parentFrameId: -1, url: `${ORIGIN}/host`, documentId: "top-new" }
        : tabId === 8 && frameId === 5
          ? {
              parentFrameId: 0,
              url: `${FRAME_ORIGIN}/docs/mcp/reference/index.html`,
              documentId: "frame-new",
            }
          : undefined;
    });
    chrome.webNavigation.getAllFrames = vi.fn(async ({ tabId }) => tabId === 8
      ? [
          { frameId: 0, parentFrameId: -1, url: `${ORIGIN}/host`, documentId: "top-new" },
          {
            frameId: 5,
            parentFrameId: 0,
            url: `${FRAME_ORIGIN}/docs/mcp/reference/index.html`,
            documentId: "frame-new",
          },
        ]
      : []);
    chrome.tabs.sendMessage = vi.fn(async (_tabId, message) => (
      isRecord(message) && message.type === "ui-attach:content-ready-get"
        ? { ok: true, data: null }
        : {
            ok: true,
            data: {
              origin: FRAME_ORIGIN,
              pathname: "/docs/mcp/reference/index.html",
              items: [{ itemId: "att_save", status: "restored" }],
            },
          }
    ));
    const controller = createBackgroundController({ chrome, store });

    const response = await dispatchRuntime(controller, {
      type: "ui-attach:saved-session-restore-route",
      origin: FRAME_ORIGIN,
      pathname: "/docs/mcp/reference/index.html",
      frameKind: "embedded",
    }, createExtensionSender());

    expect(response).toMatchObject({ ok: true });
    expect(chrome.tabs.update).toHaveBeenCalledWith(8, { active: true });
    expect(chrome.tabs.sendMessage).toHaveBeenLastCalledWith(8, {
      type: "ui-attach:overlay-restore-refresh",
    }, {
      frameId: 5,
      documentId: "frame-new",
    });
  });

  test("requires the saved top-to-frame route chain before restoring a matching leaf frame", async () => {
    const chrome = createChromeHarness();
    const store = createStoreHarness();
    const framePathname = "/docs/mcp/reference/index.html";
    const routeChain = [
      { origin: ORIGIN, pathname: "/expected-host" },
      { origin: FRAME_ORIGIN, pathname: framePathname },
    ];
    const save = {
      ...createCaptureRecord("save", "Save changes"),
      origin: FRAME_ORIGIN,
      pageUrl: `${FRAME_ORIGIN}${framePathname}`,
      tabId: 7,
      frameId: 3,
      routeChain,
    };
    save.attachment.source.url = save.pageUrl;
    save.attachment.policy.allowedDomains = [FRAME_ORIGIN];
    store.read = vi.fn(async () => ({ ok: true, value: createSessionReadbackMany([save]) }));
    chrome.tabs.query = vi.fn(async () => [{ id: 8, url: `${ORIGIN}/wrong-host`, windowId: 1 }]);
    chrome.webNavigation.getFrame = vi.fn(async ({ tabId, frameId }) => {
      if (tabId === 7) return undefined;
      return tabId === 8 && frameId === 0
        ? { parentFrameId: -1, url: `${ORIGIN}/wrong-host`, documentId: "top-new" }
        : tabId === 8 && frameId === 5
          ? {
              parentFrameId: 0,
              url: `${FRAME_ORIGIN}${framePathname}`,
              documentId: "frame-new",
            }
          : undefined;
    });
    chrome.webNavigation.getAllFrames = vi.fn(async ({ tabId }) => tabId === 8
      ? [
          { frameId: 0, parentFrameId: -1, url: `${ORIGIN}/wrong-host`, documentId: "top-new" },
          {
            frameId: 5,
            parentFrameId: 0,
            url: `${FRAME_ORIGIN}${framePathname}`,
            documentId: "frame-new",
          },
        ]
      : []);
    const controller = createBackgroundController({ chrome, store });

    const response = await dispatchRuntime(controller, {
      type: "ui-attach:saved-session-restore-route",
      origin: FRAME_ORIGIN,
      pathname: framePathname,
      frameKind: "embedded",
      routeChain,
    }, createExtensionSender());

    expect(response).toMatchObject({ ok: false, code: "SAVED_ROUTE_NOT_OPEN" });
    expect(chrome.tabs.update).not.toHaveBeenCalled();
    expect(chrome.tabs.sendMessage).not.toHaveBeenCalledWith(
      8,
      { type: "ui-attach:overlay-restore-refresh" },
      expect.anything(),
    );
  });

  test("uses the selected scope when the current page has multiple matching embedded frames", async () => {
    const chrome = createChromeHarness();
    const store = createStoreHarness();
    const framePathname = "/docs/mcp/reference/index.html";
    const save = {
      ...createCaptureRecord("save", "Save changes"),
      origin: FRAME_ORIGIN,
      pageUrl: `${FRAME_ORIGIN}${framePathname}`,
      tabId: 7,
      frameId: 3,
    };
    save.attachment.source.url = save.pageUrl;
    save.attachment.policy.allowedDomains = [FRAME_ORIGIN];
    store.read = vi.fn(async () => ({ ok: true, value: createSessionReadbackMany([save]) }));
    chrome.tabs.query = vi.fn(async () => [{ id: 8, url: `${ORIGIN}/host`, windowId: 1 }]);
    chrome.tabs.update = vi.fn(async () => ({ id: 8, url: `${ORIGIN}/host`, windowId: 1 }));
    const frames = [
      { frameId: 0, parentFrameId: -1, url: `${ORIGIN}/host`, documentId: "top-new" },
      { frameId: 5, parentFrameId: 0, url: `${FRAME_ORIGIN}${framePathname}`, documentId: "frame-a" },
      { frameId: 6, parentFrameId: 0, url: `${FRAME_ORIGIN}${framePathname}`, documentId: "frame-b" },
    ];
    chrome.webNavigation.getAllFrames = vi.fn(async ({ tabId }) => tabId === 8 ? frames : []);
    chrome.webNavigation.getFrame = vi.fn(async ({ tabId, frameId }) => {
      if (tabId === 7) return undefined;
      const frame = tabId === 8 ? frames.find((candidate) => candidate.frameId === frameId) : null;
      return frame
        ? { parentFrameId: frame.parentFrameId, url: frame.url, documentId: frame.documentId }
        : undefined;
    });
    chrome.tabs.sendMessage = vi.fn(async (_tabId, message) => (
      isRecord(message) && message.type === "ui-attach:content-ready-get"
        ? { ok: true, data: null }
        : {
            ok: true,
            data: {
              origin: FRAME_ORIGIN,
              pathname: framePathname,
              items: [{ itemId: "att_save", status: "restored" }],
            },
          }
    ));
    const controller = createBackgroundController({ chrome, store });
    const selected = await dispatchRuntime(controller, {
      type: "ui-attach:frame-scope-select",
      tabId: 8,
      frameId: 6,
      documentId: "frame-b",
      origin: FRAME_ORIGIN,
      pathname: framePathname,
      startSelection: false,
    }, createExtensionSender());

    const response = await dispatchRuntime(controller, {
      type: "ui-attach:saved-session-restore-route",
      origin: FRAME_ORIGIN,
      pathname: framePathname,
      frameKind: "embedded",
    }, createExtensionSender());

    expect(selected).toMatchObject({ ok: true, data: { enabled: false } });
    expect(response).toMatchObject({ ok: true });
    expect(chrome.tabs.sendMessage).toHaveBeenLastCalledWith(8, {
      type: "ui-attach:overlay-restore-refresh",
    }, {
      frameId: 6,
      documentId: "frame-b",
    });
  });

  test("serializes same-origin overlay snapshots so an older send cannot arrive last", async () => {
    const chrome = createChromeHarness();
    const store = createStoreHarness();
    const save = { ...createCaptureRecord("save", "Save changes"), tabId: 7, frameId: 0 };
    const cancel = { ...createCaptureRecord("cancel", "Cancel"), tabId: 7, frameId: 0 };
    const firstSend = createDeferred<unknown>();
    const readbacks = [createSessionReadbackMany([save]), createSessionReadbackMany([save, cancel])];
    store.read = vi.fn(async () => ({ ok: true, value: readbacks.shift() ?? createSessionReadbackMany([save, cancel]) }));
    chrome.tabs.sendMessage = vi.fn()
      .mockImplementationOnce(async () => firstSend.promise)
      .mockImplementation(async () => undefined);
    const controller = createBackgroundController({ chrome, store });

    const first = dispatchRuntime(controller, {
      type: "ui-attach:overlays-sync",
      origin: ORIGIN,
      activeItemId: "att_save",
    }, createExtensionSender());
    await waitFor(() => vi.mocked(chrome.tabs.sendMessage).mock.calls.length === 1);
    const second = dispatchRuntime(controller, {
      type: "ui-attach:overlays-sync",
      origin: ORIGIN,
      activeItemId: "att_cancel",
    }, createExtensionSender());
    await flushMicrotasks();

    expect(chrome.tabs.sendMessage).toHaveBeenCalledTimes(1);
    firstSend.resolve(undefined);
    await Promise.all([first, second]);

    expect(chrome.tabs.sendMessage).toHaveBeenNthCalledWith(2, 7, {
      type: UI_ATTACH_OVERLAY_STATE,
      origin: ORIGIN,
      activeItemId: "att_cancel",
      items: [
        { itemId: "att_save", attachmentId: "att_save", label: "A" },
        { itemId: "att_cancel", attachmentId: "att_cancel", label: "B" },
      ],
    }, { frameId: 0 });
  });

  test("clears removed overlays using the pre-mutation readback after a controller restart", async () => {
    const chrome = createChromeHarness();
    const store = createStoreHarness();
    const save = { ...createCaptureRecord("save", "Save changes"), tabId: 7, frameId: 0 };
    const cancel = { ...createCaptureRecord("cancel", "Cancel"), tabId: 7, frameId: 0 };
    const previous = createSessionReadbackMany([save, cancel]);
    const remaining = {
      ...previous,
      file: previous.file && {
        ...previous.file,
        session: {
          ...previous.file.session,
          attachments: previous.file.session.attachments.filter((item) => item.id === "att_cancel"),
        },
      },
      legacyRecord: cancel,
    };
    store.read = vi.fn(async () => ({ ok: true, value: previous }));
    store.removeItem = vi.fn(async () => ({ ok: true, value: remaining }));
    const controller = createBackgroundController({ chrome, store });

    await dispatchRuntime(controller, {
      type: "ui-attach:session-remove-item",
      origin: ORIGIN,
      epoch: "epoch-1",
      itemId: "att_save",
    }, createExtensionSender());

    expect(chrome.tabs.sendMessage).toHaveBeenCalledWith(7, {
      type: UI_ATTACH_OVERLAY_STATE,
      origin: ORIGIN,
      activeItemId: null,
      items: [{ itemId: "att_cancel", attachmentId: "att_cancel", label: "B" }],
    }, { frameId: 0 });
  });

  test("clears every page overlay after session clear without relying on in-memory endpoints", async () => {
    const chrome = createChromeHarness();
    const store = createStoreHarness();
    const save = { ...createCaptureRecord("save", "Save changes"), tabId: 7, frameId: 0 };
    const previous = createSessionReadbackMany([save]);
    store.read = vi.fn(async () => ({ ok: true, value: previous }));
    store.clear = vi.fn(async () => ({
      ok: true,
      value: { ...previous, epoch: "epoch-2", file: null, legacyRecord: null },
    }));
    const controller = createBackgroundController({ chrome, store });

    await dispatchRuntime(controller, {
      type: "ui-attach:session-clear",
      origin: ORIGIN,
      epoch: "epoch-1",
      operationId: "clear-1",
    }, createExtensionSender());

    expect(chrome.tabs.sendMessage).toHaveBeenCalledWith(7, {
      type: UI_ATTACH_OVERLAY_STATE,
      origin: ORIGIN,
      activeItemId: null,
      items: [],
    }, { frameId: 0 });
  });

  test("clears stored selections and overlays across every live frame origin on the active page", async () => {
    const chrome = createChromeHarness();
    chrome.tabs.query = vi.fn(async () => [{ id: 7, url: `${ORIGIN}/settings`, windowId: 1 }]);
    chrome.webNavigation.getAllFrames = vi.fn(async () => [
      { frameId: 0, parentFrameId: -1, url: `${ORIGIN}/settings`, documentId: "top-doc" },
      { frameId: 3, parentFrameId: 0, url: `${FRAME_ORIGIN}/embedded`, documentId: "frame-doc" },
      { frameId: 4, parentFrameId: 0, url: `${ORIGIN}/inline`, documentId: "inline-doc" },
    ]);
    const topRecord = { ...createCaptureRecord("frame", "Documentation"), tabId: 7, frameId: 0 };
    const sameOriginFrameRecord = {
      ...createCaptureRecord("inline", "Inline"),
      tabId: 7,
      frameId: 4,
      pageUrl: `${ORIGIN}/inline`,
    };
    sameOriginFrameRecord.attachment.source.url = `${ORIGIN}/inline`;
    const frameRecord = { ...createCaptureRecord("inside", "Inside"), tabId: 7, frameId: 3 };
    frameRecord.origin = FRAME_ORIGIN;
    frameRecord.pageUrl = `${FRAME_ORIGIN}/embedded`;
    frameRecord.attachment.source.url = `${FRAME_ORIGIN}/embedded`;
    frameRecord.attachment.policy.allowedDomains = [FRAME_ORIGIN];
    const previousByOrigin = new Map([
      [ORIGIN, createSessionReadbackMany([topRecord, sameOriginFrameRecord])],
      [FRAME_ORIGIN, createSessionReadbackMany([frameRecord])],
    ]);
    const store = createStoreHarness();
    store.read = vi.fn(async (origin) => ({
      ok: true,
      value: previousByOrigin.get(origin) ?? createReadback(createCaptureRecord("empty", "Empty"), origin),
    }));
    store.clear = vi.fn(async (origin, _epoch, _operationId) => {
      const previous = previousByOrigin.get(origin) ?? createReadback(createCaptureRecord("empty", "Empty"), origin);
      return {
        ok: true,
        value: { ...previous, epoch: `cleared-${origin}`, file: null, legacyRecord: null },
      };
    });
    const ensureContentScript = vi.fn(async () => true);
    const controller = createBackgroundController({ chrome, store, ensureContentScript });

    await dispatchRuntime(controller, {
      type: "ui-attach:session-clear",
      origin: ORIGIN,
      epoch: "epoch-1",
      operationId: "clear-page",
    }, createExtensionSender());

    expect(store.clear).toHaveBeenCalledWith(ORIGIN, "epoch-1", "clear-page");
    expect(store.clear).toHaveBeenCalledWith(FRAME_ORIGIN, "epoch-1", "clear-page");
    expect(ensureContentScript).toHaveBeenCalledWith(7, 0);
    expect(ensureContentScript).toHaveBeenCalledWith(7, 3);
    expect(ensureContentScript).toHaveBeenCalledWith(7, 4);
    expect(chrome.tabs.sendMessage).toHaveBeenCalledWith(7, {
      type: UI_ATTACH_OVERLAY_STATE,
      origin: ORIGIN,
      activeItemId: null,
      items: [],
    }, { frameId: 0 });
    expect(chrome.tabs.sendMessage).toHaveBeenCalledWith(7, {
      type: UI_ATTACH_OVERLAY_STATE,
      origin: FRAME_ORIGIN,
      activeItemId: null,
      items: [],
    }, { frameId: 3 });
    expect(chrome.tabs.sendMessage).toHaveBeenCalledWith(7, {
      type: UI_ATTACH_OVERLAY_STATE,
      origin: ORIGIN,
      activeItemId: null,
      items: [],
    }, { frameId: 4 });
  });

  test("does not report a page clear when a selected live frame cannot be reconnected", async () => {
    const chrome = createChromeHarness();
    chrome.tabs.query = vi.fn(async () => [{ id: 7, url: `${ORIGIN}/settings`, windowId: 1 }]);
    chrome.webNavigation.getAllFrames = vi.fn(async () => [
      { frameId: 0, parentFrameId: -1, url: `${ORIGIN}/settings`, documentId: "top-doc" },
      { frameId: 4, parentFrameId: 0, url: `${ORIGIN}/inline`, documentId: "inline-doc" },
    ]);
    const inline = {
      ...createCaptureRecord("inline", "Inline"),
      tabId: 7,
      frameId: 4,
      pageUrl: `${ORIGIN}/inline`,
    };
    inline.attachment.source.url = `${ORIGIN}/inline`;
    const previous = createSessionReadbackMany([inline]);
    const store = createStoreHarness();
    store.read = vi.fn(async () => ({ ok: true, value: previous }));
    const ensureContentScript = vi.fn(async (_tabId: number, frameId: number) => frameId !== 4);
    const controller = createBackgroundController({ chrome, store, ensureContentScript });

    const response = await dispatchRuntime(controller, {
      type: "ui-attach:session-clear",
      origin: ORIGIN,
      epoch: "epoch-1",
      operationId: "clear-page",
    }, createExtensionSender());

    expect(response).toMatchObject({ ok: false, code: "CONTENT_UNAVAILABLE" });
    expect(store.clear).not.toHaveBeenCalled();
  });
});

describe("content context-target selection seed listener", () => {
  test("keeps locator-backed overlay restore intact after removing direct context capture", async () => {
    vi.resetModules();
    vi.doMock("./capture", () => ({ captureElementTarget: vi.fn() }));
    const runtimeListeners: Array<(
      message: unknown,
      sender: UiAttachChromeMessageSender,
      sendResponse: (response?: unknown) => void,
    ) => boolean | void> = [];
    const chrome = createChromeHarness();
    chrome.runtime.onMessage.addListener = vi.fn((listener) => runtimeListeners.push(listener));
    chrome.runtime.sendMessage = vi.fn(async (message: unknown) => {
      if (!isRecord(message)) return undefined;
      if (message.type === "ui-attach:content-settings-get") {
        return {
          ok: true,
          data: { disclosureMode: "agent_safe", testClickCaptureEnabled: false },
        };
      }
      if (message.type === UI_ATTACH_OVERLAY_VISIBILITY_GET) {
        return { ok: true, data: { visible: true } };
      }
      if (message.type === "ui-attach:overlays-restore-get") {
        return {
          ok: true,
          data: {
            origin: window.location.origin,
            activeItemId: "att_save",
            items: [{
              itemId: "att_save",
              attachmentId: "att_save",
              label: "A",
              locators: [{
                strategy: "playwright.testId",
                value: 'page.getByTestId("save")',
                confidence: 0.9,
              }],
            }],
          },
        };
      }
      return undefined;
    });
    vi.stubGlobal("chrome", chrome);
    document.body.innerHTML = '<button data-testid="save">Save changes</button>';
    const button = document.querySelector<HTMLElement>("button");
    if (!button) throw new Error("restore target fixture missing");
    button.getBoundingClientRect = () => ({
      x: 10,
      y: 20,
      width: 100,
      height: 36,
      top: 20,
      left: 10,
      right: 110,
      bottom: 56,
      toJSON: () => ({}),
    }) as DOMRect;

    await import("./content");
    await flushAsyncWork();

    const overlayHosts = Array.from(
      document.querySelectorAll<HTMLElement>("[data-ui-attach-overlay-root]"),
    );
    const overlay = overlayHosts.at(-1)?.shadowRoot?.querySelector<HTMLElement>(
      ".ui-attach-overlay",
    );
    expect(overlay?.textContent).toBe("A");
    expect(overlay?.dataset.active).toBe("true");

    let refreshResponse: unknown;
    const keepsChannelOpen = runtimeListeners[0](
      { type: "ui-attach:overlay-restore-refresh" },
      createSender(`${ORIGIN}/settings`),
      (response) => { refreshResponse = response; },
    );
    expect(keepsChannelOpen).toBe(true);
    await flushAsyncWork();
    expect(refreshResponse).toEqual({
      ok: true,
      data: {
        origin: window.location.origin,
        pathname: window.location.pathname,
        items: [{ itemId: "att_save", status: "restored" }],
      },
    });

    runtimeListeners[0](
      { type: "ui-attach:content-deactivate" },
      createSender(`${ORIGIN}/settings`),
      () => undefined,
    );
    vi.unstubAllGlobals();
    vi.doUnmock("./capture");
  });

  test("does not let a late startup restore overwrite newer live overlay state", async () => {
    vi.resetModules();
    vi.doMock("./capture", () => ({ captureElementTarget: vi.fn() }));
    const staleRestore = createDeferred<unknown>();
    const runtimeListeners: Array<(
      message: unknown,
      sender: UiAttachChromeMessageSender,
      sendResponse: (response?: unknown) => void,
    ) => boolean | void> = [];
    const chrome = createChromeHarness();
    chrome.runtime.onMessage.addListener = vi.fn((listener) => runtimeListeners.push(listener));
    let restoreCalls = 0;
    chrome.runtime.sendMessage = vi.fn(async (message: unknown) => {
      if (!isRecord(message)) return undefined;
      if (message.type === "ui-attach:content-settings-get") {
        return {
          ok: true,
          data: { disclosureMode: "agent_safe", testClickCaptureEnabled: false },
        };
      }
      if (message.type === UI_ATTACH_OVERLAY_VISIBILITY_GET) {
        return { ok: true, data: { visible: true } };
      }
      if (message.type === "ui-attach:overlays-restore-get") {
        restoreCalls += 1;
        return restoreCalls === 1
          ? staleRestore.promise
          : {
              ok: true,
              data: { origin: window.location.origin, activeItemId: null, items: [] },
            };
      }
      return undefined;
    });
    vi.stubGlobal("chrome", chrome);
    document.body.innerHTML = '<button data-testid="save">Save changes</button>';

    await import("./content");
    runtimeListeners[0]({
      type: UI_ATTACH_OVERLAY_STATE,
      origin: window.location.origin,
      activeItemId: null,
      items: [],
    }, createSender(`${ORIGIN}/settings`), () => undefined);
    staleRestore.resolve({
      ok: true,
      data: {
        origin: window.location.origin,
        activeItemId: "att_save",
        items: [{
          itemId: "att_save",
          attachmentId: "att_save",
          label: "A",
          locators: [{
            strategy: "playwright.testId",
            value: 'page.getByTestId("save")',
            confidence: 0.9,
          }],
        }],
      },
    });
    await flushAsyncWork();

    const overlayHosts = Array.from(
      document.querySelectorAll<HTMLElement>("[data-ui-attach-overlay-root]"),
    );
    expect(restoreCalls).toBe(2);
    expect(overlayHosts.at(-1)?.shadowRoot?.querySelector(".ui-attach-overlay")).toBeNull();

    runtimeListeners[0](
      { type: "ui-attach:content-deactivate" },
      createSender(`${ORIGIN}/settings`),
      () => undefined,
    );
    vi.unstubAllGlobals();
    vi.doUnmock("./capture");
  });

  test("previews the tracked right-click target without extracting or committing it", async () => {
    vi.resetModules();
    const captureElementTarget = vi.fn();
    vi.doMock("./capture", () => ({ captureElementTarget }));
    const runtimeListeners: Array<(
      message: unknown,
      sender: UiAttachChromeMessageSender,
      sendResponse: (response?: unknown) => void,
    ) => boolean | void> = [];
    const chrome = createChromeHarness();
    chrome.runtime.onMessage.addListener = vi.fn((listener) => runtimeListeners.push(listener));
    chrome.runtime.sendMessage = vi.fn(async (message: unknown) => {
      if (!isRecord(message)) return undefined;
      if (message.type === "ui-attach:content-settings-get") {
        return {
          ok: true,
          data: { disclosureMode: "agent_safe", testClickCaptureEnabled: true },
        };
      }
      if (message.type === UI_ATTACH_OVERLAY_VISIBILITY_GET) {
        return { ok: true, data: { visible: true } };
      }
      if (message.type === "ui-attach:overlays-restore-get") {
        return {
          ok: true,
          data: { origin: window.location.origin, activeItemId: null, items: [] },
        };
      }
      return undefined;
    });
    vi.stubGlobal("chrome", chrome);
    document.body.innerHTML = '<button id="save">Save changes</button>';

    await import("./content");
    await flushAsyncWork();
    const button = document.querySelector("#save");
    if (!(button instanceof HTMLButtonElement)) throw new Error("context target fixture missing");
    button.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true }));

    const responses: unknown[] = [];
    const keepAlive = runtimeListeners[0](
      { type: UI_ATTACH_SELECTION_SEED_CONTEXT_TARGET },
      createSender(`${ORIGIN}/settings`),
      (response) => responses.push(response),
    );

    const overlayHosts = Array.from(
      document.querySelectorAll<HTMLElement>("[data-ui-attach-overlay-root]"),
    );
    const overlay = overlayHosts.at(-1)?.shadowRoot?.querySelector<HTMLElement>(
      ".ui-attach-overlay",
    );
    expect(keepAlive).toBe(false);
    expect(responses).toEqual([{ ok: true, data: { seeded: true } }]);
    expect(overlay?.textContent).toBe("Select");
    expect(captureElementTarget).not.toHaveBeenCalled();

    runtimeListeners[0](
      { type: "ui-attach:content-deactivate" },
      createSender(`${ORIGIN}/settings`),
      () => undefined,
    );
    vi.unstubAllGlobals();
    vi.doUnmock("./capture");
  });

  test("consumes a seed once and does not retain it while selection is disabled", async () => {
    vi.resetModules();
    const captureElementTarget = vi.fn();
    vi.doMock("./capture", () => ({ captureElementTarget }));
    const runtimeListeners: Array<(
      message: unknown,
      sender: UiAttachChromeMessageSender,
      sendResponse: (response?: unknown) => void,
    ) => boolean | void> = [];
    const chrome = createChromeHarness();
    chrome.runtime.onMessage.addListener = vi.fn((listener) => runtimeListeners.push(listener));
    chrome.runtime.sendMessage = vi.fn(async (message: unknown) => (
      isRecord(message) && message.type === "ui-attach:content-settings-get"
        ? {
            ok: true,
            data: { disclosureMode: "agent_safe", testClickCaptureEnabled: false },
          }
        : undefined
    ));
    vi.stubGlobal("chrome", chrome);
    document.body.innerHTML = '<button id="save">Save changes</button>';

    await import("./content");
    await flushAsyncWork();
    const button = document.querySelector("#save");
    if (!(button instanceof HTMLButtonElement)) throw new Error("context target fixture missing");
    button.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true }));

    const responses: unknown[] = [];
    for (const malformedSettings of [
      {
        type: UI_ATTACH_CONTENT_SETTINGS_UPDATED,
        disclosureMode: "full_debug",
        testClickCaptureEnabled: true,
        extra: SECRET,
      },
      { type: UI_ATTACH_CONTENT_SETTINGS_UPDATED, disclosureMode: "full_debug" },
      {
        type: UI_ATTACH_CONTENT_SETTINGS_UPDATED,
        disclosureMode: "full_debug",
        testClickCaptureEnabled: "true",
      },
    ]) {
      runtimeListeners[0](malformedSettings, createExtensionSender(), () => undefined);
    }
    runtimeListeners[0](
      { type: UI_ATTACH_SELECTION_SEED_CONTEXT_TARGET },
      createSender(`${ORIGIN}/settings`),
      (response) => responses.push(response),
    );
    runtimeListeners[0]({
      type: UI_ATTACH_CONTENT_SETTINGS_UPDATED,
      disclosureMode: "agent_safe",
      testClickCaptureEnabled: true,
    }, createSender(`${ORIGIN}/settings`), () => undefined);
    runtimeListeners[0](
      { type: UI_ATTACH_SELECTION_SEED_CONTEXT_TARGET },
      createSender(`${ORIGIN}/settings`),
      (response) => responses.push(response),
    );

    expect(responses).toEqual([
      { ok: true, data: { seeded: false } },
      { ok: true, data: { seeded: false } },
    ]);
    expect(captureElementTarget).not.toHaveBeenCalled();

    runtimeListeners[0](
      { type: "ui-attach:content-deactivate" },
      createSender(`${ORIGIN}/settings`),
      () => undefined,
    );
    vi.unstubAllGlobals();
    vi.doUnmock("./capture");
  });

  test("rejects extra seed fields instead of broadening the internal protocol", async () => {
    vi.resetModules();
    vi.doMock("./capture", () => ({ captureElementTarget: vi.fn() }));
    const runtimeListeners: Array<(
      message: unknown,
      sender: UiAttachChromeMessageSender,
      sendResponse: (response?: unknown) => void,
    ) => boolean | void> = [];
    const chrome = createChromeHarness();
    chrome.runtime.onMessage.addListener = vi.fn((listener) => runtimeListeners.push(listener));
    chrome.runtime.sendMessage = vi.fn(async (message: unknown) => (
      isRecord(message) && message.type === "ui-attach:content-settings-get"
        ? {
            ok: true,
            data: { disclosureMode: "agent_safe", testClickCaptureEnabled: true },
          }
        : undefined
    ));
    vi.stubGlobal("chrome", chrome);
    document.body.innerHTML = '<button id="save">Save changes</button>';

    await import("./content");
    await flushAsyncWork();
    const button = document.querySelector("#save");
    if (!(button instanceof HTMLButtonElement)) throw new Error("context target fixture missing");
    button.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true }));

    const responses: unknown[] = [];
    const malformedResult = runtimeListeners[0](
      { type: UI_ATTACH_SELECTION_SEED_CONTEXT_TARGET, target: "#save" },
      createSender(`${ORIGIN}/settings`),
      (response) => responses.push(response),
    );
    const validResult = runtimeListeners[0](
      { type: UI_ATTACH_SELECTION_SEED_CONTEXT_TARGET },
      createSender(`${ORIGIN}/settings`),
      (response) => responses.push(response),
    );

    expect(malformedResult).toBe(false);
    expect(validResult).toBe(false);
    expect(responses).toEqual([{ ok: true, data: { seeded: true } }]);

    runtimeListeners[0](
      { type: "ui-attach:content-deactivate" },
      createSender(`${ORIGIN}/settings`),
      () => undefined,
    );
    vi.unstubAllGlobals();
    vi.doUnmock("./capture");
  });

  test("does not let a late startup response override a newer restrictive update", async () => {
    vi.resetModules();
    const startupSettings = createDeferred<unknown>();
    vi.doMock("./capture", () => ({ captureElementTarget: vi.fn() }));
    const runtimeListeners: Array<(
      message: unknown,
      sender: UiAttachChromeMessageSender,
      sendResponse: (response?: unknown) => void,
    ) => boolean | void> = [];
    const chrome = createChromeHarness();
    chrome.runtime.onMessage.addListener = vi.fn((listener) => runtimeListeners.push(listener));
    chrome.runtime.sendMessage = vi.fn(async (message: unknown) => (
      isRecord(message) && message.type === "ui-attach:content-settings-get"
        ? startupSettings.promise
        : undefined
    ));
    vi.stubGlobal("chrome", chrome);
    document.body.innerHTML = '<button id="save">Save changes</button>';

    await import("./content");
    runtimeListeners[0]({
      type: UI_ATTACH_CONTENT_SETTINGS_UPDATED,
      disclosureMode: "agent_safe",
      testClickCaptureEnabled: false,
    }, createSender(`${ORIGIN}/settings`), () => undefined);
    startupSettings.resolve({
      ok: true,
      data: { disclosureMode: "full_debug", testClickCaptureEnabled: true },
    });
    await flushAsyncWork();
    const button = document.querySelector("#save");
    if (!(button instanceof HTMLButtonElement)) throw new Error("context target fixture missing");
    button.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true }));

    const responses: unknown[] = [];
    runtimeListeners[0](
      { type: UI_ATTACH_SELECTION_SEED_CONTEXT_TARGET },
      createSender(`${ORIGIN}/settings`),
      (response) => responses.push(response),
    );

    expect(responses).toEqual([{ ok: true, data: { seeded: false } }]);

    runtimeListeners[0](
      { type: "ui-attach:content-deactivate" },
      createSender(`${ORIGIN}/settings`),
      () => undefined,
    );
    vi.unstubAllGlobals();
    vi.doUnmock("./capture");
  });
});

function createChromeHarness(): UiAttachChrome & {
  runtime: UiAttachChrome["runtime"] & { sentMessages: Array<Record<string, unknown>> };
} {
  const runtimeSentMessages: Array<Record<string, unknown>> = [];
  const sessionValues: Record<string, unknown> = {};
  return {
    action: {
      onClicked: createEventHarness(),
      setBadgeText: vi.fn(async () => undefined),
      setTitle: vi.fn(async () => undefined),
    },
    contextMenus: {
      create: vi.fn(),
      onClicked: createEventHarness(),
      removeAll: vi.fn((callback?: () => void) => callback?.()),
    },
    permissions: {
      contains: vi.fn(async () => false),
      request: vi.fn(async () => false),
      remove: vi.fn(async () => true),
    },
    runtime: {
      connect: vi.fn(() => ({
        name: "test-port",
        disconnect: vi.fn(),
        onDisconnect: createEventHarness(),
      })),
      onInstalled: createEventHarness(),
      onConnect: createEventHarness(),
      onMessage: createEventHarness(),
      sendMessage: vi.fn(async (message: unknown) => {
        runtimeSentMessages.push(message as Record<string, unknown>);
        return undefined;
      }),
      sentMessages: runtimeSentMessages,
    },
    scripting: {
      executeScript: vi.fn(async () => []),
    },
    webNavigation: {
      getAllFrames: vi.fn(async () => []),
      getFrame: vi.fn(async () => undefined),
      onCommitted: createEventHarness(),
      onHistoryStateUpdated: createEventHarness(),
    },
    sidePanel: {
      open: vi.fn(async () => undefined),
    },
    storage: {
      local: {
        get: vi.fn(async () => ({})),
        set: vi.fn(async () => undefined),
        remove: vi.fn(async () => undefined),
        setAccessLevel: vi.fn(async () => undefined),
      },
      session: {
        get: vi.fn(async (keys) => {
          if (keys === null) return { ...sessionValues };
          const requested = Array.isArray(keys) ? keys : [keys];
          return Object.fromEntries(requested.flatMap((key) => (
            Object.hasOwn(sessionValues, key) ? [[key, sessionValues[key]]] : []
          )));
        }),
        set: vi.fn(async (items) => {
          Object.assign(sessionValues, items);
        }),
        remove: vi.fn(async (keys) => {
          for (const key of Array.isArray(keys) ? keys : [keys]) delete sessionValues[key];
        }),
        setAccessLevel: vi.fn(async () => undefined),
      },
      onChanged: createEventHarness(),
    },
    tabs: {
      query: vi.fn(async () => []),
      create: vi.fn(async ({ url }: { url: string }) => ({ id: 99, url })),
      update: vi.fn(async (tabId: number) => ({ id: tabId })),
      sendMessage: vi.fn(async () => ({ ok: false, error: "not configured" })),
      onActivated: createEventHarness(),
      onUpdated: createEventHarness(),
    },
  };
}

function createLocalAgentBridgeHarness(): LocalAgentBridgeClient {
  const pendingStatus = {
    connected: false,
    instanceId: null,
    pending: true,
    approvalMode: "browser_session" as const,
    requestText: "bounded request",
    expiresAt: "2026-07-18T01:27:43.939Z",
  };
  return {
    readStatus: vi.fn(async () => pendingStatus),
    createConnectionRequest: vi.fn(async () => pendingStatus),
    refreshConnection: vi.fn(async () => pendingStatus),
    refreshConnectionAndPublish: vi.fn(async () => pendingStatus),
    publish: vi.fn(async () => true),
    disconnect: vi.fn(async () => undefined),
  };
}

function createStoreHarness(): ExtensionSessionStore & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    list: vi.fn(async () => {
      calls.push("list");
      return { ok: true, value: [] };
    }),
    clearAll: vi.fn(async () => {
      calls.push("clearAll");
      return { ok: true, value: { clearedOrigins: [] } };
    }),
    read: vi.fn(async (origin: string) => {
      calls.push(`read:${origin}`);
      return { ok: true, value: createReadback(createCaptureRecord("save", "Save changes"), origin) };
    }),
    beginCapture: vi.fn(async (origin: string) => {
      calls.push(`begin:${origin}`);
      return { ok: true, value: { ...TOKEN, origin } };
    }),
    commitCapture: vi.fn(async (token: CaptureToken, record: OriginCaptureRecord) => {
      calls.push(`commit:${token.operationId}:${record.origin}`);
      return {
        ok: true,
        value: { itemId: record.attachment.id, readback: createReadback(record) },
      };
    }),
    updateIntent: vi.fn(async (origin, epoch, itemId, intent) => {
      calls.push(`update:${origin}:${epoch}:${itemId}:${intent}`);
      return { ok: true, value: createReadback(createCaptureRecord("save", "Save changes"), origin) };
    }),
    removeItem: vi.fn(async (origin, epoch, itemId) => {
      calls.push(`remove:${origin}:${epoch}:${itemId}`);
      return { ok: true, value: createReadback(createCaptureRecord("save", "Save changes"), origin) };
    }),
    clear: vi.fn(async (origin, epoch, operationId) => {
      calls.push(`clear:${origin}:${epoch}:${operationId}`);
      return { ok: true, value: createReadback(createCaptureRecord("save", "Save changes"), origin) };
    }),
  };
}

function createEmbeddedFrameRecord(): OriginCaptureRecord {
  const record = createCaptureRecord("frame", "Documentation");
  record.origin = ORIGIN;
  record.pageUrl = `${ORIGIN}/settings`;
  record.tabId = 7;
  record.frameId = 0;
  record.attachment.element.tagName = "iframe";
  record.attachment.element.accessibleName = "Documentation";
  record.attachment.locatorBundle.primary = {
    strategy: "playwright.title",
    value: 'page.getByTitle("Documentation")',
    confidence: 0.9,
  };
  record.attachment.boundary = {
    kind: "embedded_frame",
    innerDom: "not_captured",
    originRelation: "cross_origin",
    frameOrigin: FRAME_ORIGIN,
    framePathname: "/embedded",
    dominantViewport: true,
  };
  return record;
}

function createReadback(record: OriginCaptureRecord, origin = record.origin): ActiveSessionReadback {
  return {
    origin,
    epoch: "epoch-1",
    clearPending: false,
    activeClearOperationId: null,
    file: null,
    legacyRecord: { ...record, origin },
  };
}

function createSessionReadback(record: OriginCaptureRecord): ActiveSessionReadback {
  return {
    origin: record.origin,
    epoch: "epoch-1",
    clearPending: false,
    activeClearOperationId: null,
    file: createSessionFile([record]),
    legacyRecord: record,
  };
}

function createSessionReadbackMany(records: OriginCaptureRecord[]): ActiveSessionReadback {
  return {
    origin: records[0]?.origin ?? ORIGIN,
    epoch: "epoch-1",
    clearPending: false,
    activeClearOperationId: null,
    file: createSessionFile(records),
    legacyRecord: records.at(-1) ?? null,
  };
}

function createContextInfo(
  overrides: Partial<UiAttachChromeContextMenuClickData> = {},
): UiAttachChromeContextMenuClickData {
  return {
    menuItemId: UI_ATTACH_CONTEXT_MENU_ID,
    frameId: 0,
    pageUrl: `${ORIGIN}/settings`,
    ...overrides,
  };
}

function createSender(url: string, tabId = 7, windowId = 1): UiAttachChromeMessageSender {
  return { url, tab: { id: tabId, url, windowId }, frameId: 0 };
}

function createExtensionSender(): UiAttachChromeMessageSender {
  return { url: "chrome-extension://ui-attach/panel.html" };
}

function createExtensionTabSender(): UiAttachChromeMessageSender {
  const url = "chrome-extension://ui-attach/panel.html";
  return { url, tab: { id: 9, url } };
}

function createEventHarness<T extends (...args: never[]) => unknown>() {
  return {
    addListener: vi.fn((_listener: T) => undefined),
  };
}

async function dispatchRuntime(
  controller: ReturnType<typeof createBackgroundController>,
  command: SessionCommand | unknown,
  sender: UiAttachChromeMessageSender,
): Promise<SessionCommandResponse<unknown>> {
  const response = await controller.handleRuntimeMessage(command, sender);
  return response as SessionCommandResponse<unknown>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

async function flushAsyncWork(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

async function flushMicrotasks(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    if (predicate()) return;
    await flushMicrotasks();
  }
  throw new Error("condition was not reached");
}

function createDeferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, reject, resolve };
}
