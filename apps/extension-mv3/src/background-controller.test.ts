// @vitest-environment jsdom

import { createHash } from "node:crypto";
import { createAnnotationLifecycleOperationFingerprintInput } from "@meanthis/schema";
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
  UI_ATTACH_CLEAR_PROJECTION,
  UI_ATTACH_CLEAR_PROJECTION_ACK,
  UI_ATTACH_CONTENT_SETTINGS_UPDATED,
  UI_ATTACH_CONTEXT_MENU_ID,
  UI_ATTACH_ELEMENT_SELECTION_UPDATED,
  UI_ATTACH_OVERLAY_PREVIEW,
  UI_ATTACH_OVERLAY_ACTION_REQUEST,
  UI_ATTACH_OVERLAY_PROJECTION_ACK,
  UI_ATTACH_OVERLAY_PROJECTION_UPDATED,
  UI_ATTACH_OVERLAY_REBIND_STATUS_GET,
  UI_ATTACH_OVERLAY_RELATION_PREVIEW,
  UI_ATTACH_OVERLAY_RESTORE_REFRESH,
  UI_ATTACH_OVERLAY_STATE,
  UI_ATTACH_OVERLAY_VISIBILITY_GET,
  UI_ATTACH_OVERLAY_VISIBILITY_UPDATED,
  UI_ATTACH_PANEL_LIFECYCLE_PORT_PREFIX,
  UI_ATTACH_SELECTION_LIFECYCLE_HEARTBEAT,
  UI_ATTACH_SELECTION_LIFECYCLE_PORT,
  UI_ATTACH_SELECTION_SEED_CONTEXT_TARGET,
  UI_ATTACH_SESSION_UPDATED,
  UI_ATTACH_EMPTY_APPLIED_ITEM_IDS_DIGEST,
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
  type ActiveSessionCommandData,
  type RuntimeCaptureToken,
  type SessionCommand,
  type SessionCommandResponse,
} from "./messages";
import {
  UI_ATTACH_IN_PAGE_WIDGET_ACTION,
  UI_ATTACH_IN_PAGE_WIDGET_ACTION_ACK,
  UI_ATTACH_IN_PAGE_WIDGET_COMMAND,
  UI_ATTACH_IN_PAGE_WIDGET_ENSURE,
  UI_ATTACH_IN_PAGE_WIDGET_INIT,
  UI_ATTACH_IN_PAGE_WIDGET_READY,
  UI_ATTACH_IN_PAGE_WIDGET_REGISTER,
  createInPageWidgetLifecyclePortName,
  parseInPageWidgetActionMessage,
  parseInPageWidgetInitMessage,
  type InPageWidgetInitMessage,
} from "./in-page-widget-contract";
import { createBackgroundController as createProductionBackgroundController } from "./background-controller";
import type { FirstCaptureDisclosureStore } from "./first-capture-disclosure";
import {
  createExtensionSessionStore,
  type ActiveSessionReadback,
  type ExtensionSessionStore,
  type SessionMutationAuthority,
} from "./session-store";
import type { CaptureToken } from "./session-state";
import type { CaptureClearOperationV1 } from "./clear-operation";
import {
  CLEAR_PROJECTION_JOURNAL_STORAGE_KEY,
  parseClearProjectionJournal,
  type ClearProjectionOperation,
} from "./clear-projection-store";
import type {
  LocalAgentBridgeClient,
  LocalAgentBridgePublishInput,
} from "./local-agent-bridge";
import {
  SELECTION_INTENT_AUTHORITY_STORAGE_KEY,
  createSelectionIntentStore,
} from "./selection-intent-store";
import {
  CONTEXT_MENU_SELECTION_MODE_KEY,
  OVERLAY_DISPLAY_MODE_PREFERENCE_KEY,
  OVERLAY_VISIBILITY_PREFERENCE_KEY,
} from "./settings-preferences";
import {
  LOCAL_AGENT_BRIDGE_RUNTIME_TYPE,
  createLocalAgentBridgeRuntimeFeature,
} from "./local-agent-bridge-runtime";
import { createLocalAgentBridgeSessionPublisher } from "./local-agent-bridge-session-publisher";
import { getMetadataDiagnosticsSessionStorageKey } from "./metadata-diagnostics-session-store";
import { createAnnotationLifecycleControlExecutionStore } from "./annotation-lifecycle-control-execution-store";

const ORIGIN = "https://app.example.test";
const OTHER_ORIGIN = "https://other.example.test";
const FRAME_ORIGIN = "https://frame.example.test";
const WIDGET_RUNTIME_ID = "ui-attach";
const WIDGET_TAB_ID = 7;
const WIDGET_WINDOW_ID = 1;
const WIDGET_FRAME_ID = 11;
const WIDGET_TOP_DOCUMENT_ID = "widget-top-document";
const WIDGET_DOCUMENT_ID = "widget-iframe-document";
const WIDGET_URL = `chrome-extension://${WIDGET_RUNTIME_ID}/widget.html`;
const TOKEN: CaptureToken = {
  origin: ORIGIN,
  epoch: "epoch-1",
  operationId: "op-1",
  replacement: null,
};
const RUNTIME_TOKEN: RuntimeCaptureToken = {
  ...TOKEN,
  routeLease: {
    epoch: "route-lease-1",
    tabId: 7,
    selectedFrameId: 0,
    segments: [{
      frameId: 0,
      documentId: "document-1",
      origin: ORIGIN,
      pathname: "/settings",
    }],
  },
};
const SAFE_CAPTURE_ERROR = "ui-attach capture failed.";
const SECRET = "sk-test-1234567890";
const OVERLAY_ACTIVE_ITEMS_SESSION_KEY = "ui-attach:overlay-active-items-v1";
const OVERLAY_PROJECTIONS_SESSION_KEY = "ui-attach:overlay-projections-v1";
const OVERLAY_PROJECTION_AUTHORITY_GENERATION_KEY =
  "ui-attach:overlay-projection-authority-generation-v1";
const FRAME_SCOPE_SESSION_KEY = "ui-attach:frame-scopes-v1";
const IN_PAGE_WIDGET_LEASE_STORAGE_KEY = "ui-attach:in-page-widget-leases:v1";
const FRAME_SCOPE_INVALIDATIONS_LOCAL_KEY = "ui-attach:frame-scope-invalidations-v1";
const IN_PAGE_WIDGET_LEASE_INVALIDATIONS_LOCAL_KEY =
  "ui-attach:in-page-widget-lease-invalidations-v1";
const FRAME_SCOPE_INVALIDATION_AUTHORITY_POISON_LOCAL_KEY =
  "ui-attach:frame-scope-invalidation-authority-poison-v1";
const IN_PAGE_WIDGET_LEASE_INVALIDATION_AUTHORITY_POISON_LOCAL_KEY =
  "ui-attach:in-page-widget-lease-invalidation-authority-poison-v1";
const WIDGET_OVERLAY_PROJECTION = {
  version: 1 as const,
  projectionId: "e45df1ad-c16d-49ec-984b-12d5b0cb6051",
  revision: 1,
};
const WIDGET_OVERLAY_PROJECTION_DESCRIPTOR = {
  ...WIDGET_OVERLAY_PROJECTION,
  sessionEpoch: "epoch-1",
  subject: {
    tabId: WIDGET_TAB_ID,
    frameId: 0,
    documentId: WIDGET_TOP_DOCUMENT_ID,
    origin: ORIGIN,
    pathname: "/settings",
  },
};

function createTestOverlayProjectionDescriptor(
  origin: string,
  pathname: string,
  documentId = "test-overlay-document",
) {
  return {
    ...WIDGET_OVERLAY_PROJECTION,
    sessionEpoch: "epoch-1",
    subject: {
      tabId: 7,
      frameId: 0,
      documentId,
      origin,
      pathname,
    },
  };
}

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
    expect(openSidePanel).not.toHaveBeenCalled();
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
    expect(openSidePanel).not.toHaveBeenCalled();
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
      elementSelectionEnabled: true,
    }), { documentId: "frame-doc", frameId: 3 });
    expect(chrome.tabs.sendMessage).not.toHaveBeenCalledWith(7, expect.objectContaining({
      elementSelectionEnabled: true,
    }), { frameId: 0 });

    const wrongDocumentCapture = await dispatchRuntime(controller, {
      type: "ui-attach:session-begin-capture",
      replaceItemId: null,
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
      replaceItemId: null,
    }, {
      documentId: "frame-doc",
      frameId: 3,
      url: `${FRAME_ORIGIN}/embedded`,
      tab: { id: 7, url: `${ORIGIN}/settings` },
    });
    expect(selectedDocumentCapture).toMatchObject({ ok: true });

    const wrongFrameCapture = await dispatchRuntime(controller, {
      type: "ui-attach:session-begin-capture",
      replaceItemId: null,
    }, {
      frameId: 4,
      url: `${FRAME_ORIGIN}/embedded`,
      tab: { id: 7, url: `${ORIGIN}/settings` },
    });
    expect(wrongFrameCapture).toMatchObject({ ok: false, code: "SELECTION_NOT_ACTIVE" });
  });

  test("EA-01B-CLEAR-C2 does not authorize resume when content injection fails", async () => {
    const chrome = createChromeHarness();
    chrome.tabs.query = vi.fn(async () => [{ id: 7, url: `${ORIGIN}/settings`, windowId: 1 }]);
    chrome.webNavigation.getAllFrames = vi.fn(async () => [
      { frameId: 0, parentFrameId: -1, url: `${ORIGIN}/settings`, documentId: "top-doc" },
      { frameId: 3, parentFrameId: 0, url: `${FRAME_ORIGIN}/embedded`, documentId: "frame-doc" },
    ]);
    const controller = createBackgroundController({
      chrome,
      store: createStoreHarness(),
      ensureContentScript: vi.fn(async () => false),
    });

    await expect(dispatchRuntime(
      controller,
      embeddedFrameSelectionCommand(),
      createExtensionSender(),
    )).resolves.toMatchObject({ ok: false, code: "ACCESS_DENIED" });
    await expect(chrome.storage.local.get(SELECTION_INTENT_AUTHORITY_STORAGE_KEY))
      .resolves.toEqual({});
  });

  test("EA-01B-CLEAR-C2 does not authorize resume when the selected frame changes", async () => {
    const chrome = createChromeHarness();
    chrome.tabs.query = vi.fn(async () => [{ id: 7, url: `${ORIGIN}/settings`, windowId: 1 }]);
    chrome.webNavigation.getAllFrames = vi.fn(async () => [
      { frameId: 0, parentFrameId: -1, url: `${ORIGIN}/settings`, documentId: "top-doc" },
      { frameId: 3, parentFrameId: 0, url: `${FRAME_ORIGIN}/embedded`, documentId: "frame-doc" },
    ]);
    chrome.webNavigation.getFrame = vi.fn(async () => ({
      parentFrameId: 0,
      url: `${FRAME_ORIGIN}/embedded`,
      documentId: "replacement-frame-doc",
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
    )).resolves.toMatchObject({ ok: false, code: "FRAME_UNAVAILABLE" });
    await expect(chrome.storage.local.get(SELECTION_INTENT_AUTHORITY_STORAGE_KEY))
      .resolves.toEqual({});
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
      elementSelectionEnabled: true,
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
      frameId: 0,
      parentFrameId: -1,
      url: `${ORIGIN}/settings`,
      documentId: "top-doc",
    }, {
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
      replaceItemId: null,
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
      replaceItemId: null,
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
      frameId: 0,
      parentFrameId: -1,
      url: `${ORIGIN}/settings`,
      documentId: "top-doc",
    }, {
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
      replaceItemId: null,
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
      replaceItemId: null,
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

  test("returns a bounded failure when a trusted runtime feature rejects asynchronously", async () => {
    const chrome = createChromeHarness();
    const store = createStoreHarness();
    const controller = createBackgroundController({
      chrome,
      store,
      runtimeFeatures: [{
        matches: () => true,
        handle: async () => {
          throw new Error(`runtime feature failed: ${SECRET}`);
        },
      }],
    });

    await expect(controller.handleRuntimeMessage(
      { type: LOCAL_AGENT_BRIDGE_RUNTIME_TYPE, action: "publish" },
      createExtensionSender(),
    )).resolves.toEqual({
      ok: false,
      code: "CAPTURE_FAILED",
      error: SAFE_CAPTURE_ERROR,
    });
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
    await expect(controller.handleRuntimeMessage({
      type: UI_ATTACH_OVERLAY_ACTION_REQUEST,
      action: "more",
      itemId: "att_save",
      projection: WIDGET_OVERLAY_PROJECTION,
    }, createSender(`${ORIGIN}/settings`))).resolves.toEqual({
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
      projection: WIDGET_OVERLAY_PROJECTION_DESCRIPTOR,
      activeItemId: "att_save",
      items: [{
        itemId: "att_save",
        attachmentId: "att_save",
        label: "1",
        taskNote: "Update Save changes.",
      }],
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
        projection: WIDGET_OVERLAY_PROJECTION_DESCRIPTOR,
        activeItemId: "att_save",
        items: [{
          itemId: "att_save",
          attachmentId: "att_save",
          label: "1",
          taskNote: "Update Save changes.",
          anchor: { xRatio: 0.25, yRatio: 0.75 },
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
        items: [{ ...response.data.items[0], anchor: { xRatio: 1.01, yRatio: 0.5 } }],
      },
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
      data: { origin: ORIGIN, epoch: "epoch-1", itemId: "att_save", annotationLabel: "1" },
    })).toBe(true);
    expect(isCaptureCommitResponse({
      ok: true,
      data: { origin: ORIGIN, epoch: "epoch-1", itemId: "att_save", annotationLabel: "1", file: {} },
    })).toBe(false);
    expect(isCaptureCommitResponse({
      ok: true,
      data: { origin: ORIGIN, epoch: "epoch-1", itemId: "att_save", annotationLabel: "A" },
    })).toBe(false);
    expect(isCaptureCommitResponse({
      ok: true,
      data: { origin: ORIGIN, epoch: "epoch-1", itemId: "att_save", annotationLabel: "0" },
    })).toBe(false);
    expect(isCaptureCommitResponse({
      ok: true,
      data: { origin: ORIGIN, epoch: "epoch-1", itemId: "att_save", annotationLabel: "27" },
    })).toBe(false);
    expect(isCaptureCommitResponse({
      ok: true,
      data: { origin: ORIGIN, epoch: "epoch-1", legacyRecord: {} },
    })).toBe(false);
    expect(isCaptureCommitResponse({
      ok: true,
      data: { origin: `${ORIGIN}/path`, epoch: "epoch-1", itemId: "att_save", annotationLabel: "1" },
    })).toBe(false);
  });

  test("rejects undeclared runtime payload fields without echoing their values", async () => {
    const chrome = createChromeHarness();
    const store = createStoreHarness();
    const controller = createBackgroundController({ chrome, store });
    const commands: unknown[] = [
      { type: "ui-attach:session-begin-capture", replaceItemId: null, extra: SECRET },
      { type: "ui-attach:session-begin-capture" },
      { type: "ui-attach:session-begin-capture", replaceItemId: "" },
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
      {
        type: "ui-attach:session-update-annotation-lifecycle",
        origin: ORIGIN,
        epoch: "epoch-1",
        itemId: "att_1",
        annotationId: undefined,
        expectedState: "open",
        nextState: "resolved",
      },
      {
        type: "ui-attach:session-update-annotation-lifecycle",
        origin: ORIGIN,
        epoch: "epoch-1",
        itemId: "att_1",
        annotationId: "opaque-annotation-a",
        expectedState: "open",
        nextState: "open",
      },
      {
        type: "ui-attach:session-update-annotation-lifecycle",
        origin: ORIGIN,
        epoch: "epoch-1",
        itemId: "att_1",
        annotationId: "opaque-annotation-a",
        expectedState: "open",
        nextState: "closed",
      },
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
    expect(responses.map((response) => response.ok === false ? response.code : ""))
      .toEqual(commands.map(() => "INVALID_COMMAND"));
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

    expect(chrome.sidePanel?.open).not.toHaveBeenCalled();
    expect(store.beginCapture).not.toHaveBeenCalled();
    expect(store.commitCapture).not.toHaveBeenCalled();
    expect(chrome.tabs.sendMessage).toHaveBeenCalledWith(7, {
      type: UI_ATTACH_CONTENT_SETTINGS_UPDATED,
      disclosureMode: "agent_safe",
      elementSelectionEnabled: true,
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
    const begun = await dispatchRuntime(controller, {
      type: "ui-attach:session-begin-capture",
      replaceItemId: null,
    }, sender);
    expect(begun).toMatchObject({ ok: true, data: TOKEN });
    if (!begun.ok) throw new Error("capture begin failed");
    await expect(dispatchRuntime(controller, {
      type: "ui-attach:session-commit-capture",
      token: begun.data,
      record,
    }, sender)).resolves.toMatchObject({ ok: true });

    expect(store.beginCapture).toHaveBeenCalledTimes(1);
    expect(store.commitCapture).toHaveBeenCalledTimes(1);
    await expect(dispatchRuntime(controller, {
      type: "ui-attach:element-selection-get",
    }, createExtensionSender())).resolves.toEqual({ ok: true, data: { enabled: false } });
  });

  test("binds an exact live replacement in a restored same-path tab without trusting the old tab id", async () => {
    const chrome = createChromeHarness();
    const store = createStoreHarness();
    const stored = createCaptureRecord("save", "Save changes");
    stored.tabId = 99;
    store.read = vi.fn(async () => ({ ok: true, value: createSessionReadback(stored) }));
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

    const begun = await dispatchRuntime(controller, {
      type: "ui-attach:session-begin-capture",
      replaceItemId: "att_save",
    }, sender);

    expect(begun).toMatchObject({
      ok: true,
      data: {
        origin: ORIGIN,
        replacement: {
          itemId: "att_save",
          createdAt: "2026-07-11T10:00:00.000Z",
          capturedAt: "2026-07-11T10:00:00.000Z",
        },
      },
    });
    expect(store.beginCapture).toHaveBeenCalledWith(ORIGIN, "att_save");
  });

  test("rejects a replacement token when the item version changes after route validation", async () => {
    const chrome = createChromeHarness();
    const store = createStoreHarness();
    const stored = createCaptureRecord("save", "Save changes");
    const readback = createSessionReadback(stored);
    const item = readback.file!.session.attachments[0]!;
    store.read = vi.fn(async () => ({ ok: true, value: readback }));
    store.beginCapture = vi.fn(async () => ({
      ok: true,
      value: {
        ...TOKEN,
        replacement: {
          itemId: item.id,
          createdAt: item.createdAt,
          capturedAt: "2026-07-11T10:01:00.000Z",
        },
      },
    }));
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
    const begun = await dispatchRuntime(controller, {
      type: "ui-attach:session-begin-capture",
      replaceItemId: item.id,
    }, {
      ...createSender(`${ORIGIN}/settings`),
      documentId: "document-1",
    });

    expect(begun).toMatchObject({ ok: false, code: "STALE_CAPTURE_OPERATION" });
    expect(store.beginCapture).toHaveBeenCalledWith(ORIGIN, item.id);
  });

  test("rejects an exact replacement from a different current pathname", async () => {
    const chrome = createChromeHarness();
    const store = createStoreHarness();
    const stored = createCaptureRecord("save", "Save changes");
    store.read = vi.fn(async () => ({ ok: true, value: createSessionReadback(stored) }));
    chrome.tabs.query = vi.fn(async () => [
      { id: 7, url: `${ORIGIN}/account`, windowId: 2 },
    ]);
    chrome.webNavigation.getFrame = vi.fn(async () => ({
      documentId: "document-1",
      parentFrameId: -1,
      url: `${ORIGIN}/account`,
    }));
    const controller = createBackgroundController({ chrome, store });

    await controller.handleContextMenuClick(
      createContextInfo({ pageUrl: `${ORIGIN}/account` }),
      { id: 7, windowId: 2, url: `${ORIGIN}/account` },
    );
    const begun = await dispatchRuntime(controller, {
      type: "ui-attach:session-begin-capture",
      replaceItemId: "att_save",
    }, {
      ...createSender(`${ORIGIN}/account`),
      documentId: "document-1",
    });

    expect(begun).toMatchObject({ ok: false, code: "STALE_CAPTURE_OPERATION" });
    expect(store.beginCapture).not.toHaveBeenCalled();
  });

  test("rejects an exact replacement commit after the live page pathname changes", async () => {
    const chrome = createChromeHarness();
    const store = createStoreHarness();
    const stored = createCaptureRecord("save", "Save changes");
    const readback = createSessionReadback(stored);
    const item = readback.file!.session.attachments[0]!;
    store.read = vi.fn(async () => ({ ok: true, value: readback }));
    chrome.tabs.query = vi.fn(async () => [
      { id: 7, url: `${ORIGIN}/settings`, windowId: 2 },
    ]);
    let livePathname = "/settings";
    chrome.webNavigation.getFrame = vi.fn(async () => ({
      documentId: "document-1",
      parentFrameId: -1,
      url: `${ORIGIN}${livePathname}`,
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
    const begun = await dispatchRuntime(controller, {
      type: "ui-attach:session-begin-capture",
      replaceItemId: item.id,
    }, sender);
    if (!begun.ok) throw new Error("capture begin failed");
    livePathname = "/account";
    const committed = await dispatchRuntime(controller, {
      type: "ui-attach:session-commit-capture",
      token: begun.data,
      record: createCaptureRecord("save-refresh", "Fresh save"),
    }, {
      ...createSender(`${ORIGIN}/account`),
      documentId: "document-1",
    });

    expect(committed).toMatchObject({ ok: false, code: "STALE_CAPTURE_OPERATION" });
    expect(store.commitCapture).not.toHaveBeenCalled();
  });

  test("rejects an exact replacement commit after the stored item version changes", async () => {
    const chrome = createChromeHarness();
    const store = createStoreHarness();
    const original = createSessionReadback(createCaptureRecord("save", "Save changes"));
    const originalItem = original.file!.session.attachments[0]!;
    const changed = createCaptureRecord("save", "Changed save");
    changed.capturedAt = "2026-07-11T10:01:00.000Z";
    changed.attachment.capturedAt = changed.capturedAt;
    const current = createSessionReadback(changed);
    store.read = vi.fn()
      .mockResolvedValueOnce({ ok: true, value: original })
      .mockResolvedValue({ ok: true, value: current });
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
    const begun = await dispatchRuntime(controller, {
      type: "ui-attach:session-begin-capture",
      replaceItemId: originalItem.id,
    }, sender);
    if (!begun.ok) throw new Error("capture begin failed");
    const committed = await dispatchRuntime(controller, {
      type: "ui-attach:session-commit-capture",
      token: begun.data,
      record: createCaptureRecord("save-refresh", "Fresh save"),
    }, sender);

    expect(committed).toMatchObject({ ok: false, code: "STALE_CAPTURE_OPERATION" });
    expect(store.commitCapture).not.toHaveBeenCalled();
  });

  test("retries an already-receipted exact replacement without reapplying stale preflight checks", async () => {
    const chrome = createChromeHarness();
    const store = createStoreHarness();
    const original = createSessionReadback(createCaptureRecord("save", "Save changes"));
    const originalItem = original.file!.session.attachments[0]!;
    const current = structuredClone(original);
    const currentItem = current.file!.session.attachments[0]!;
    currentItem.sourceRecord.capturedAt = "2026-07-11T10:01:00.000Z";
    currentItem.sourceRecord.attachment.capturedAt = currentItem.sourceRecord.capturedAt;
    store.read = vi.fn()
      .mockResolvedValueOnce({ ok: true, value: original })
      .mockResolvedValue({ ok: true, value: current });
    const inspectCapture = vi.fn(async () => ({
      ok: true as const,
      value: { readback: current, receiptItemId: originalItem.id },
    }));
    Object.assign(store, { inspectCapture });
    store.commitCapture = vi.fn(async () => ({
      ok: true,
      value: { itemId: originalItem.id, label: "A", readback: current },
    }));
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
    const begun = await dispatchRuntime(controller, {
      type: "ui-attach:session-begin-capture",
      replaceItemId: originalItem.id,
    }, sender);
    if (!begun.ok) throw new Error("capture begin failed");
    const retried = await dispatchRuntime(controller, {
      type: "ui-attach:session-commit-capture",
      token: begun.data,
      record: createCaptureRecord("changed-retry", "Changed retry"),
    }, sender);

    expect(retried).toMatchObject({
      ok: true,
      data: { itemId: originalItem.id, annotationLabel: "1" },
    });
    expect(inspectCapture).toHaveBeenCalledWith(ORIGIN, TOKEN.operationId);
    expect(store.commitCapture).toHaveBeenCalledTimes(1);
  });

  test("rejects an already-receipted replacement when the receipt belongs to another item", async () => {
    const chrome = createChromeHarness();
    const store = createStoreHarness();
    const current = createSessionReadback(createCaptureRecord("save", "Save changes"));
    const item = current.file!.session.attachments[0]!;
    store.read = vi.fn(async () => ({ ok: true, value: current }));
    const inspectCapture = vi.fn(async () => ({
      ok: true as const,
      value: { readback: current, receiptItemId: "att_other" },
    }));
    Object.assign(store, { inspectCapture });
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
    const begun = await dispatchRuntime(controller, {
      type: "ui-attach:session-begin-capture",
      replaceItemId: item.id,
    }, sender);
    if (!begun.ok) throw new Error("capture begin failed");
    const retried = await dispatchRuntime(controller, {
      type: "ui-attach:session-commit-capture",
      token: begun.data,
      record: createCaptureRecord("changed-retry", "Changed retry"),
    }, sender);

    expect(retried).toMatchObject({ ok: false, code: "STALE_CAPTURE_OPERATION" });
    expect(store.commitCapture).not.toHaveBeenCalled();
  });

  test.each([
    ["is unavailable", [], `${ORIGIN}/settings`],
    ["differs", [
      { frameId: 0, parentFrameId: -1, url: `${ORIGIN}/other-host`, documentId: "top-doc" },
      { frameId: 3, parentFrameId: 0, url: `${FRAME_ORIGIN}/embedded`, documentId: "frame-doc" },
    ], `${ORIGIN}/other-host`],
  ])("rejects an exact embedded replacement commit when the live route chain %s", async (
    _case,
    liveFrames,
    liveTopUrl,
  ) => {
    const chrome = createChromeHarness();
    const store = createStoreHarness();
    const stored = createCaptureRecord("save", "Save changes");
    stored.origin = FRAME_ORIGIN;
    stored.pageUrl = `${FRAME_ORIGIN}/embedded`;
    stored.attachment.source.url = stored.pageUrl;
    stored.attachment.policy.allowedDomains = [FRAME_ORIGIN];
    stored.tabId = 7;
    stored.frameId = 3;
    stored.routeChain = [
      { origin: ORIGIN, pathname: "/settings" },
      { origin: FRAME_ORIGIN, pathname: "/embedded" },
    ];
    const readback = createSessionReadback(stored);
    readback.file!.session.origin = FRAME_ORIGIN;
    const item = readback.file!.session.attachments[0]!;
    store.read = vi.fn(async () => ({ ok: true, value: readback }));
    chrome.tabs.query = vi.fn(async () => [
      { id: 7, url: `${ORIGIN}/settings`, windowId: 1 },
    ]);
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
    const controller = createBackgroundController({
      chrome,
      store,
      ensureContentScript: vi.fn(async () => true),
    });
    await dispatchRuntime(controller, embeddedFrameSelectionCommand(), createExtensionSender());
    const sender = {
      documentId: "frame-doc",
      frameId: 3,
      url: `${FRAME_ORIGIN}/embedded`,
      tab: { id: 7, url: `${ORIGIN}/settings` },
    };
    const begun = await dispatchRuntime(controller, {
      type: "ui-attach:session-begin-capture",
      replaceItemId: item.id,
    }, sender);
    if (!begun.ok) throw new Error("capture begin failed");
    chrome.webNavigation.getAllFrames = vi.fn(async () => liveFrames);

    const recaptured = structuredClone(stored);
    delete recaptured.routeChain;
    const committed = await dispatchRuntime(controller, {
      type: "ui-attach:session-commit-capture",
      token: begun.data,
      record: recaptured,
    }, {
      ...sender,
      tab: { id: 7, url: liveTopUrl },
    });

    expect(committed).toMatchObject({ ok: false, code: "STALE_CAPTURE_OPERATION" });
    expect(store.commitCapture).not.toHaveBeenCalled();
  });

  test.each([
    ["matching full chain", "matching", true],
    ["missing chain", "missing", false],
    ["own undefined chain", "undefined", false],
    ["malformed chain", "malformed", false],
    ["empty chain", "empty", false],
    ["same terminal with another ancestor", "ancestor", false],
    ["over-bound chain", "over-bound", false],
  ] as const)("validates a nested replacement with %s", async (_name, variant, accepted) => {
    const chrome = createChromeHarness();
    const store = createStoreHarness();
    const stored = createCaptureRecord("save", "Save changes");
    stored.origin = FRAME_ORIGIN;
    stored.pageUrl = `${FRAME_ORIGIN}/embedded`;
    stored.attachment.source.url = stored.pageUrl;
    stored.attachment.policy.allowedDomains = [FRAME_ORIGIN];
    stored.tabId = 7;
    stored.frameId = 3;
    const untypedStored = stored as OriginCaptureRecord & { routeChain?: unknown };
    switch (variant) {
      case "matching":
        stored.routeChain = [
          { origin: ORIGIN, pathname: "/settings" },
          { origin: FRAME_ORIGIN, pathname: "/embedded" },
        ];
        break;
      case "missing":
        delete stored.routeChain;
        break;
      case "undefined":
        untypedStored.routeChain = undefined;
        break;
      case "malformed":
        untypedStored.routeChain = [
          { origin: ORIGIN, pathname: "/settings" },
          { origin: FRAME_ORIGIN, pathname: 7 },
        ];
        break;
      case "empty":
        stored.routeChain = [];
        break;
      case "ancestor":
        stored.routeChain = [
          { origin: ORIGIN, pathname: "/other-host" },
          { origin: FRAME_ORIGIN, pathname: "/embedded" },
        ];
        break;
      case "over-bound":
        stored.routeChain = Array.from({ length: 34 }, (_, index) => ({
          origin: index === 33 ? FRAME_ORIGIN : ORIGIN,
          pathname: index === 33 ? "/embedded" : `/ancestor-${index}`,
        }));
        break;
    }
    const readback = createSessionReadback(stored);
    if (variant === "undefined") {
      Object.defineProperty(readback.file!.session.attachments[0]!.sourceRecord, "routeChain", {
        configurable: true,
        enumerable: true,
        value: undefined,
        writable: true,
      });
    }
    store.read = vi.fn(async () => ({ ok: true, value: readback }));
    chrome.tabs.query = vi.fn(async () => [
      { id: 7, url: `${ORIGIN}/settings`, windowId: 1 },
    ]);
    chrome.webNavigation.getAllFrames = vi.fn(async () => [
      { frameId: 0, parentFrameId: -1, url: `${ORIGIN}/settings`, documentId: "top-doc" },
      { frameId: 3, parentFrameId: 0, url: `${FRAME_ORIGIN}/embedded`, documentId: "frame-doc" },
    ]);
    chrome.webNavigation.getFrame = vi.fn(async () => ({
      frameId: 3,
      parentFrameId: 0,
      url: `${FRAME_ORIGIN}/embedded`,
      documentId: "frame-doc",
    }));
    const controller = createBackgroundController({
      chrome,
      store,
      ensureContentScript: vi.fn(async () => true),
    });
    await dispatchRuntime(controller, embeddedFrameSelectionCommand(), createExtensionSender());
    const begun = await dispatchRuntime(controller, {
      type: "ui-attach:session-begin-capture",
      replaceItemId: stored.attachment.id,
    }, {
      documentId: "frame-doc",
      frameId: 3,
      url: `${FRAME_ORIGIN}/embedded`,
      tab: { id: 7, url: `${ORIGIN}/settings` },
    });

    expect(begun.ok).toBe(accepted);
    if (!accepted) expect(begun).toMatchObject({ ok: false, code: "STALE_CAPTURE_OPERATION" });
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
    const begun = await dispatchRuntime(controller, {
      type: "ui-attach:session-begin-capture",
      replaceItemId: null,
    }, sender);
    if (!begun.ok) throw new Error("capture begin failed");
    await expect(dispatchRuntime(controller, {
      type: "ui-attach:session-commit-capture",
      token: begun.data,
      record,
    }, sender)).resolves.toMatchObject({ ok: true });

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
          message.elementSelectionEnabled === true,
      );
      const seedDeliveries = vi.mocked(chrome.tabs.sendMessage).mock.calls.filter(
        ([, message]) => isRecord(message) &&
          message.type === UI_ATTACH_SELECTION_SEED_CONTEXT_TARGET,
      );
      expect(enabledDeliveries).toEqual([[7, {
        type: UI_ATTACH_CONTENT_SETTINGS_UPDATED,
        disclosureMode: "agent_safe",
        elementSelectionEnabled: true,
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
        message.elementSelectionEnabled === true,
    );
    const seedDeliveries = vi.mocked(chrome.tabs.sendMessage).mock.calls.filter(
      ([, message]) => isRecord(message) &&
        message.type === UI_ATTACH_SELECTION_SEED_CONTEXT_TARGET,
    );
    expect(enabledDeliveries).toEqual([[7, {
      type: UI_ATTACH_CONTENT_SETTINGS_UPDATED,
      disclosureMode: "agent_safe",
      elementSelectionEnabled: true,
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
      elementSelectionEnabled: true,
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

  test("binds selection lifecycle traffic to the exact active frame and revokes on disconnect", async () => {
    const chrome = createChromeHarness();
    chrome.tabs.query = vi.fn(async () => [{ id: 7, url: `${ORIGIN}/settings`, windowId: 1 }]);
    chrome.tabs.sendMessage = vi.fn(async () => undefined);
    const controller = createBackgroundController({
      chrome,
      store: createStoreHarness(),
      ensureContentScript: vi.fn(async () => true),
    });
    controller.register();
    await expect(dispatchRuntime(controller, {
      type: "ui-attach:element-selection-set",
      enabled: true,
      tabId: 7,
    }, createExtensionSender())).resolves.toEqual({ ok: true, data: { enabled: true } });

    const connectListener = vi.mocked(chrome.runtime.onConnect.addListener).mock.calls[0]?.[0] as
      | ((port: UiAttachChromePort) => void)
      | undefined;
    if (!connectListener) throw new Error("runtime connect listener was not registered");
    const rejectedPort = {
      name: UI_ATTACH_SELECTION_LIFECYCLE_PORT,
      sender: { ...createSender(`${ORIGIN}/settings`), frameId: 3 },
      disconnect: vi.fn(),
      onDisconnect: createEventHarness<() => void>(),
      onMessage: createEventHarness<(message: unknown) => void>(),
    } satisfies UiAttachChromePort;
    connectListener(rejectedPort);
    expect(rejectedPort.disconnect).toHaveBeenCalledOnce();

    const disconnectEvent = createEventHarness<() => void>();
    const messageEvent = createEventHarness<(message: unknown) => void>();
    const activePort = {
      name: UI_ATTACH_SELECTION_LIFECYCLE_PORT,
      sender: createSender(`${ORIGIN}/settings`),
      disconnect: vi.fn(),
      onDisconnect: disconnectEvent,
      onMessage: messageEvent,
    } satisfies UiAttachChromePort;
    connectListener(activePort);
    expect(activePort.disconnect).not.toHaveBeenCalled();

    const heartbeatListener = vi.mocked(messageEvent.addListener).mock.calls[0]?.[0] as
      | ((message: unknown) => void)
      | undefined;
    heartbeatListener?.({ type: UI_ATTACH_SELECTION_LIFECYCLE_HEARTBEAT });
    const disconnectListener = vi.mocked(disconnectEvent.addListener).mock.calls[0]?.[0] as
      | (() => void)
      | undefined;
    disconnectListener?.();

    await waitFor(() => chrome.runtime.sentMessages.some((message) => (
      message.type === UI_ATTACH_ELEMENT_SELECTION_UPDATED && message.enabled === false
    )));
    await expect(dispatchRuntime(controller, {
      type: "ui-attach:element-selection-get",
    }, createExtensionSender())).resolves.toEqual({ ok: true, data: { enabled: false } });
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
    expect(chrome.permissions.remove).not.toHaveBeenCalled();
    await expect(dispatchRuntime(controller, {
      type: "ui-attach:element-selection-set",
      enabled: false,
    }, createExtensionSender())).resolves.toEqual({ ok: true, data: { enabled: false } });
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
    [
      "session clear / false readiness",
      () => Promise.resolve(false),
      {
        type: "ui-attach:session-clear",
        origin: ORIGIN,
        epoch: "epoch-1",
        operationId: "clear-before-readiness",
      },
      "clear-before-readiness",
    ],
    [
      "session clear / rejected readiness",
      () => Promise.reject(new Error(`access secret ${SECRET}`)),
      {
        type: "ui-attach:session-clear",
        origin: ORIGIN,
        epoch: "epoch-1",
        operationId: "clear-before-readiness",
      },
      "clear-before-readiness",
    ],
    [
      "clear all / false readiness",
      () => Promise.resolve(false),
      { type: "ui-attach:session-clear-all-stored" },
      "clear-all-stored",
    ],
    [
      "clear all / rejected readiness",
      () => Promise.reject(new Error(`access secret ${SECRET}`)),
      { type: "ui-attach:session-clear-all-stored" },
      "clear-all-stored",
    ],
  ] as const)("durably stops selection before %s fails closed", async (
    _label,
    createReadiness,
    command,
    clearOperationId,
  ) => {
    const chrome = createChromeHarness();
    const store = createStoreHarness();
    await chrome.storage.local.set({
      [SELECTION_INTENT_AUTHORITY_STORAGE_KEY]: {
        version: 1,
        authorityId: "selection-authority",
        generation: 1,
        desired: "enabled",
        clearOperationId: null,
        ownerTabId: 7,
      },
    });
    const controller = createBackgroundController({
      chrome,
      store,
      storageAccessReady: createReadiness(),
    });

    await expect(dispatchRuntime(
      controller,
      command,
      createExtensionSender(),
    )).resolves.toEqual({
      ok: false,
      code: "CAPTURE_FAILED",
      error: SAFE_CAPTURE_ERROR,
    });

    const restartedAuthority = await createSelectionIntentStore({
      authorityStorage: chrome.storage.local,
      poisonStorage: chrome.storage.session,
      randomUUID: () => "unexpected-new-authority",
    }).read();
    expect(restartedAuthority).toMatchObject({
      ok: true,
      value: {
        authorityId: "selection-authority",
        generation: 2,
        desired: "stopped",
        clearOperationId,
        ownerTabId: null,
      },
    });
    expect(store.calls).toEqual([]);
  });

  test("linearizes selection stop before awaiting extension clear storage readiness", async () => {
    const chrome = createChromeHarness();
    const store = createStoreHarness();
    const readiness = createDeferred<boolean>();
    await chrome.storage.local.set({
      [SELECTION_INTENT_AUTHORITY_STORAGE_KEY]: {
        version: 1,
        authorityId: "selection-authority",
        generation: 1,
        desired: "enabled",
        clearOperationId: null,
        ownerTabId: 7,
      },
    });
    const controller = createBackgroundController({
      chrome,
      store,
      storageAccessReady: readiness.promise,
    });

    let settled = false;
    const clearing = dispatchRuntime(controller, {
      type: "ui-attach:session-clear",
      origin: ORIGIN,
      epoch: "epoch-1",
      operationId: "clear-linearization",
    }, createExtensionSender()).finally(() => {
      settled = true;
    });

    await vi.waitFor(async () => {
      const values = await chrome.storage.local.get(SELECTION_INTENT_AUTHORITY_STORAGE_KEY);
      expect(values[SELECTION_INTENT_AUTHORITY_STORAGE_KEY]).toMatchObject({
        generation: 2,
        desired: "stopped",
        clearOperationId: "clear-linearization",
        ownerTabId: null,
      });
    });
    expect(settled).toBe(false);
    expect(store.calls).toEqual([]);

    readiness.resolve(false);
    await expect(clearing).resolves.toMatchObject({ ok: false, code: "CAPTURE_FAILED" });
  });

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
    expect(chrome.storage.local.get).toHaveBeenCalledWith(SELECTION_INTENT_AUTHORITY_STORAGE_KEY);
    expect(chrome.storage.local.set).toHaveBeenCalledWith({
      [SELECTION_INTENT_AUTHORITY_STORAGE_KEY]: expect.objectContaining({
        desired: "stopped",
        ownerTabId: null,
      }),
    });
    expect(chrome.tabs.sendMessage).not.toHaveBeenCalled();
    expect(chrome.sidePanel?.open).not.toHaveBeenCalled();
    expect(chrome.runtime.sentMessages).toEqual([
      { type: UI_ATTACH_CAPTURE_FAILED, error: SAFE_CAPTURE_ERROR },
    ]);
    expect(JSON.stringify({ response, messages: chrome.runtime.sentMessages })).not.toContain(SECRET);
  });

  test("allows begin and commit only from HTTP(S) content senders", async () => {
    const record = createCaptureRecord("save", "Save changes");
    const commands: unknown[] = [
      { type: "ui-attach:session-begin-capture", replaceItemId: null },
      { type: "ui-attach:session-commit-capture", token: RUNTIME_TOKEN, record },
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
        type: "ui-attach:session-update-annotation-lifecycle",
        origin: ORIGIN,
        epoch: "epoch-1",
        itemId: "att_save",
        annotationId: "opaque-annotation-a",
        expectedState: "open",
        nextState: "resolved",
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

    for (const sender of [createExtensionSender(), createExtensionTabSender()]) {
      const chrome = createChromeHarness();
      const store = createStoreHarness();
      let current = createSessionReadback({
        ...createCaptureRecord("save", "Save changes"),
        origin: ORIGIN,
      });
      store.read = vi.fn(async () => ({ ok: true, value: current }));
      store.removeItem = vi.fn(async () => {
        current = {
          ...current,
          file: current.file ? {
            ...current.file,
            session: { ...current.file.session, attachments: [] },
          } : null,
        };
        return { ok: true, value: current };
      });
      const controller = createBackgroundController({ chrome, store });
      for (const command of panelCommands) {
        const response = await dispatchRuntime(controller, command, sender);
        if (isRecord(command) && command.type === "ui-attach:session-clear") {
          expect(response).toMatchObject({ ok: false, code: "ACTIVE_PAGE_UNAVAILABLE" });
        } else {
          expect(response.ok).toBe(true);
        }
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
      data: { disclosureMode: "full_debug", elementSelectionEnabled: false },
    });
    expect(Object.keys((accepted as { data: object }).data)).toEqual([
      "disclosureMode",
      "elementSelectionEnabled",
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
      type: "ui-attach:overlay-display-mode-updated", displayMode: "hover",
    });

    const disconnectListener = vi.mocked(disconnectEvent.addListener).mock.calls[0]?.[0] as
      | (() => void)
      | undefined;
    disconnectListener?.();
    await flushAsyncWork();

    expect(chrome.tabs.sendMessage).toHaveBeenLastCalledWith(7, {
      type: "ui-attach:overlay-display-mode-updated", displayMode: "hidden",
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
    chrome.webNavigation.getAllFrames = vi.fn(async ({ tabId }) => tabId === 7
      ? [{
          frameId: 0,
          parentFrameId: -1,
          documentId: "document-1",
          url: `${ORIGIN}/settings`,
        }]
      : []);
    chrome.webNavigation.getFrame = vi.fn(async ({ tabId, frameId }) => tabId === 7 &&
      (frameId ?? 0) === 0
      ? {
          frameId: 0,
          parentFrameId: -1,
          documentId: "document-1",
          url: `${ORIGIN}/settings`,
        }
      : undefined);
    const store = createStoreHarness();
    const controller = createBackgroundController({ chrome, store });
    const activeSender = {
      ...createSender(`${ORIGIN}/settings`, 7),
      documentId: "document-1",
    };

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
      data: { disclosureMode: "agent_safe", elementSelectionEnabled: true },
    });
    expect(await dispatchRuntime(
      controller,
      { type: "ui-attach:content-settings-get" },
      createSender(`${OTHER_ORIGIN}/account`, 8),
    )).toEqual({
      ok: true,
      data: { disclosureMode: "agent_safe", elementSelectionEnabled: false },
    });

    expect(await dispatchRuntime(
      controller,
      { type: "ui-attach:session-begin-capture", replaceItemId: null },
      createSender(`${OTHER_ORIGIN}/account`, 8),
    )).toMatchObject({ ok: false, code: "SELECTION_NOT_ACTIVE" });
    expect(store.calls).toEqual([]);
    expect(await dispatchRuntime(
      controller,
      { type: "ui-attach:content-selection-disable" },
      createSender(`${OTHER_ORIGIN}/account`, 8),
    )).toMatchObject({ ok: false, code: "SELECTION_NOT_ACTIVE" });

    const begun = await dispatchRuntime(
      controller,
      { type: "ui-attach:session-begin-capture", replaceItemId: null },
      activeSender,
    );
    expect(begun).toMatchObject({ ok: true });
    if (!begun.ok) throw new Error("capture begin failed");
    expect(await dispatchRuntime(
      controller,
      {
        type: "ui-attach:session-commit-capture",
        token: begun.data,
        record: createCaptureRecord("save", "Save changes"),
      },
      createSender(`${OTHER_ORIGIN}/account`, 8),
    )).toMatchObject({ ok: false, code: "SELECTION_NOT_ACTIVE" });
    expect(await dispatchRuntime(
      controller,
      { type: "ui-attach:content-selection-disable" },
      activeSender,
    )).toEqual({ ok: true, data: null });
    expect(await dispatchRuntime(
      controller,
      {
        type: "ui-attach:session-commit-capture",
        token: begun.data,
        record: createCaptureRecord("save", "Save changes"),
      },
      activeSender,
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

  test("consumes the one-shot basic diagnostics opt-in on the first runtime capture token", async () => {
    const chrome = createChromeHarness();
    const route = configureTopFrameRuntimeCaptureRoute(chrome, `${ORIGIN}/settings`);
    const store = createStoreHarness();
    const controller = createBackgroundController({ chrome, store });
    const sender = createTopFrameRuntimeCaptureSender(route);

    await expect(dispatchRuntime(controller, {
      type: "ui-attach:element-selection-set",
      enabled: true,
      tabId: route.tabId,
      collectBasicDiagnostics: true,
    }, createExtensionSender())).resolves.toEqual({ ok: true, data: { enabled: true } });

    const first = await dispatchRuntime(controller, {
      type: "ui-attach:session-begin-capture",
      replaceItemId: null,
    }, sender);
    expect(first).toMatchObject({
      ok: true,
      data: { collectBasicDiagnostics: true },
    });

    const second = await dispatchRuntime(controller, {
      type: "ui-attach:session-begin-capture",
      replaceItemId: null,
    }, sender);
    expect(second).toMatchObject({ ok: true });
    if (!second.ok) throw new Error(`capture begin failed: ${second.code}`);
    expect(Object.hasOwn(second.data, "collectBasicDiagnostics")).toBe(false);
    expect(store.beginCapture).toHaveBeenCalledTimes(2);
  });

  test("rejects missing, malformed, raw, or unconsented diagnostics before capture commit", async () => {
    const chrome = createChromeHarness();
    const route = configureTopFrameRuntimeCaptureRoute(chrome, `${ORIGIN}/settings`);
    const store = createStoreHarness();
    const controller = createBackgroundController({ chrome, store });
    const sender = createTopFrameRuntimeCaptureSender(route);
    const record = createCaptureRecord("diagnostics-guard", "Diagnostics guard");

    await dispatchRuntime(controller, {
      type: "ui-attach:element-selection-set",
      enabled: true,
      tabId: route.tabId,
      collectBasicDiagnostics: true,
    }, createExtensionSender());
    const begun = await dispatchRuntime(controller, {
      type: "ui-attach:session-begin-capture",
      replaceItemId: null,
    }, sender);
    if (!begun.ok) throw new Error(`capture begin failed: ${begun.code}`);
    expect(begun.data.collectBasicDiagnostics).toBe(true);

    const unarmedToken = { ...begun.data } as Record<string, unknown>;
    delete unarmedToken.collectBasicDiagnostics;
    const rejectedSecret = `${SECRET}-diagnostics`;
    const commands: unknown[] = [
      {
        type: "ui-attach:session-commit-capture",
        token: begun.data,
        record,
      },
      {
        type: "ui-attach:session-commit-capture",
        token: begun.data,
        record,
        metadataDiagnosticsDevice: undefined,
      },
      {
        type: "ui-attach:session-commit-capture",
        token: begun.data,
        record,
        metadataDiagnosticsDevice: {
          status: "collected",
          deviceClass: "desktop",
          viewportClass: "large",
          touch: "none",
          unknown: rejectedSecret,
        },
      },
      {
        type: "ui-attach:session-commit-capture",
        token: begun.data,
        record,
        metadataDiagnosticsDevice: {
          status: "collected",
          deviceClass: "desktop",
          viewportClass: "large",
          touch: "none",
          viewportWidth: 1920,
        },
      },
      {
        type: "ui-attach:session-commit-capture",
        token: unarmedToken,
        record,
        metadataDiagnosticsDevice: {
          status: "collected",
          deviceClass: "desktop",
          viewportClass: "large",
          touch: "none",
        },
      },
    ];

    for (const command of commands) {
      const response = await dispatchRuntime(controller, command, sender);
      expect(response).toMatchObject({ ok: false, code: "INVALID_COMMAND" });
      expect(JSON.stringify(response)).not.toContain(rejectedSecret);
    }
    expect(store.commitCapture).not.toHaveBeenCalled();
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
      elementSelectionEnabled: true,
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
      elementSelectionEnabled: false,
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

  test("EA-01B-CLEAR-C2 cancels an older selection enable before clearing all stored sessions", async () => {
    const chrome = createChromeHarness();
    chrome.tabs.query = vi.fn(async () => [{ id: 7, url: `${ORIGIN}/settings`, windowId: 1 }]);
    let finishInjection!: (ready: boolean) => void;
    const ensureContentScript = vi.fn(() => new Promise<boolean>((resolve) => {
      finishInjection = resolve;
    }));
    const store = createStoreHarness();
    store.clearAll = vi.fn(async () => ({
      ok: true,
      value: { clearedOrigins: [ORIGIN] },
    }));
    const controller = createBackgroundController({ chrome, store, ensureContentScript });

    const enabling = dispatchRuntime(
      controller,
      { type: "ui-attach:element-selection-set", enabled: true, tabId: 7 },
      createExtensionSender(),
    );
    await vi.waitFor(() => expect(ensureContentScript).toHaveBeenCalledWith(7, 0));

    await expect(dispatchRuntime(controller, {
      type: "ui-attach:session-clear-all-stored",
    }, createExtensionSender())).resolves.toMatchObject({ ok: true });
    finishInjection(true);

    await expect(enabling).resolves.toEqual({ ok: true, data: { enabled: false } });
    await expect(dispatchRuntime(
      controller,
      { type: "ui-attach:element-selection-get" },
      createExtensionSender(),
    )).resolves.toEqual({ ok: true, data: { enabled: false } });
  });

  test("EA-01B-CLEAR-C2 keeps selection stopped when page clear validation fails", async () => {
    const chrome = createChromeHarness();
    chrome.tabs.query = vi.fn(async () => [{ id: 7, url: `${ORIGIN}/settings`, windowId: 1 }]);
    chrome.tabs.sendMessage = vi.fn(async () => undefined);
    const controller = createBackgroundController({ chrome, store: createStoreHarness() });

    await expect(dispatchRuntime(
      controller,
      { type: "ui-attach:element-selection-set", enabled: true, tabId: 7 },
      createExtensionSender(),
    )).resolves.toEqual({ ok: true, data: { enabled: true } });
    chrome.webNavigation.getAllFrames = vi.fn(async () => undefined);

    await expect(dispatchRuntime(controller, {
      type: "ui-attach:session-clear",
      origin: ORIGIN,
      epoch: "epoch-1",
      operationId: "clear-stops-selection",
    }, createExtensionSender())).resolves.toMatchObject({
      ok: false,
      code: "ACTIVE_PAGE_UNAVAILABLE",
    });
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
      elementSelectionEnabled: false,
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
      elementSelectionEnabled: false,
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
      if (keys === OVERLAY_VISIBILITY_PREFERENCE_KEY ||
          keys === OVERLAY_DISPLAY_MODE_PREFERENCE_KEY ||
          keys === FRAME_SCOPE_INVALIDATIONS_LOCAL_KEY ||
          keys === IN_PAGE_WIDGET_LEASE_INVALIDATIONS_LOCAL_KEY ||
          keys === FRAME_SCOPE_INVALIDATION_AUTHORITY_POISON_LOCAL_KEY ||
          keys === IN_PAGE_WIDGET_LEASE_INVALIDATION_AUTHORITY_POISON_LOCAL_KEY ||
          keys === CLEAR_PROJECTION_JOURNAL_STORAGE_KEY ||
          keys === SELECTION_INTENT_AUTHORITY_STORAGE_KEY) return {};
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
        elementSelectionEnabled: false,
      }],
      [7, {
        type: "ui-attach:content-settings-updated",
        disclosureMode: "full_debug",
        elementSelectionEnabled: true,
      }, { frameId: 0 }],
      [7, {
        type: "ui-attach:content-settings-updated",
        disclosureMode: "agent_safe",
        elementSelectionEnabled: false,
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
      if (keys === OVERLAY_VISIBILITY_PREFERENCE_KEY ||
          keys === OVERLAY_DISPLAY_MODE_PREFERENCE_KEY ||
          keys === CLEAR_PROJECTION_JOURNAL_STORAGE_KEY) return Promise.resolve({});
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
        elementSelectionEnabled: false,
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

  test("session-list-stored fails closed on hostile storage without invoking getters or writing", async () => {
    const chrome = createChromeHarness();
    const sessionKey = `ui-attach:session:v1:${ORIGIN}`;
    const sessionGetter = vi.fn(() => createSessionFile([]));
    const hostileValues: Record<string, unknown> = {};
    Object.defineProperty(hostileValues, sessionKey, {
      configurable: true,
      enumerable: true,
      get: sessionGetter,
    });
    const originalGet = chrome.storage.local.get;
    chrome.storage.local.get = vi.fn(async (keys) =>
      keys === null ? hostileValues : originalGet(keys));
    const store = createExtensionSessionStore({ storage: chrome.storage.local });
    const controller = createBackgroundController({ chrome, store });
    vi.mocked(chrome.storage.local.set).mockClear();
    vi.mocked(chrome.storage.local.remove).mockClear();

    await expect(dispatchRuntime(controller, {
      type: "ui-attach:session-list-stored",
    }, createExtensionSender())).resolves.toEqual({
      ok: false,
      code: "INVALID_SESSION_FILE",
      error: "Capture session is invalid.",
    });
    expect(sessionGetter).not.toHaveBeenCalled();
    expect(chrome.storage.local.set).not.toHaveBeenCalled();
    expect(chrome.storage.local.remove).not.toHaveBeenCalled();

    const nestedGetter = vi.fn(() => "ui-attach.capture-session");
    const nestedSession = createSessionFile([]) as unknown as Record<string, unknown>;
    Object.defineProperty(nestedSession, "kind", {
      configurable: true,
      enumerable: true,
      get: nestedGetter,
    });
    const valueGetTrap = vi.fn(() => {
      throw new Error("hostile nested list get");
    });
    chrome.storage.local.get = vi.fn(async (keys) =>
      keys === null
        ? { [sessionKey]: new Proxy(nestedSession, { get: valueGetTrap }) }
        : originalGet(keys));
    const nestedController = createBackgroundController({
      chrome,
      store: createExtensionSessionStore({ storage: chrome.storage.local }),
    });
    vi.mocked(chrome.storage.local.set).mockClear();
    vi.mocked(chrome.storage.local.remove).mockClear();
    await expect(dispatchRuntime(nestedController, {
      type: "ui-attach:session-list-stored",
    }, createExtensionSender())).resolves.toMatchObject({
      ok: false,
      code: "INVALID_SESSION_FILE",
    });
    expect(nestedGetter).not.toHaveBeenCalled();
    expect(valueGetTrap).not.toHaveBeenCalled();
    expect(chrome.storage.local.set).not.toHaveBeenCalled();
    expect(chrome.storage.local.remove).not.toHaveBeenCalled();

    const ownKeysTrap = vi.fn(() => {
      throw new Error("hostile list ownKeys");
    });
    chrome.storage.local.get = vi.fn(async (keys) =>
      keys === null
        ? new Proxy({} as Record<string, unknown>, { ownKeys: ownKeysTrap })
        : originalGet(keys));
    const recreatedController = createBackgroundController({
      chrome,
      store: createExtensionSessionStore({ storage: chrome.storage.local }),
    });
    vi.mocked(chrome.storage.local.set).mockClear();
    vi.mocked(chrome.storage.local.remove).mockClear();

    await expect(dispatchRuntime(recreatedController, {
      type: "ui-attach:session-list-stored",
    }, createExtensionSender())).resolves.toMatchObject({
      ok: false,
      code: "INVALID_SESSION_FILE",
    });
    expect(ownKeysTrap).toHaveBeenCalledTimes(1);
    expect(chrome.storage.local.set).not.toHaveBeenCalled();
    expect(chrome.storage.local.remove).not.toHaveBeenCalled();
  });

  test("session-list-stored catches a throwing getOwnPropertyDescriptor proxy without side effects", async () => {
    const chrome = createChromeHarness();
    const sessionKey = `ui-attach:session:v1:${ORIGIN}`;
    const ordinaryGetter = vi.fn(() => "ui-attach.capture-session");
    const session = createSessionFile([]) as unknown as Record<string, unknown>;
    Object.defineProperty(session, "kind", {
      configurable: true,
      enumerable: true,
      get: ordinaryGetter,
    });
    const getTrap = vi.fn(() => {
      throw new Error("hostile background list get");
    });
    const descriptorTrap = vi.fn(() => {
      throw new Error("hostile background list descriptor");
    });
    const originalGet = chrome.storage.local.get;
    chrome.storage.local.get = vi.fn(async (keys) => keys === null
      ? {
          [sessionKey]: new Proxy(session, {
            get: getTrap,
            getOwnPropertyDescriptor: descriptorTrap,
          }),
        }
      : originalGet(keys));
    const controller = createBackgroundController({
      chrome,
      store: createExtensionSessionStore({ storage: chrome.storage.local }),
    });
    vi.mocked(chrome.storage.local.set).mockClear();
    vi.mocked(chrome.storage.local.remove).mockClear();

    await expect(dispatchRuntime(controller, {
      type: "ui-attach:session-list-stored",
    }, createExtensionSender())).resolves.toEqual({
      ok: false,
      code: "INVALID_SESSION_FILE",
      error: "Capture session is invalid.",
    });
    expect(descriptorTrap).toHaveBeenCalledTimes(1);
    expect(ordinaryGetter).not.toHaveBeenCalled();
    expect(getTrap).not.toHaveBeenCalled();
    expect(chrome.storage.local.set).not.toHaveBeenCalled();
    expect(chrome.storage.local.remove).not.toHaveBeenCalled();
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

  test("stored-origin clear works without an active page and keeps the request origin scoped", async () => {
    const chrome = createChromeHarness();
    chrome.tabs.query = vi.fn(async () => [{ id: 7, url: "about:blank" }]);
    const store = createStoreHarness();
    const cleared: ActiveSessionReadback = {
      origin: ORIGIN, epoch: "cleared-epoch", file: null, legacyRecord: null,
      clearPending: false, activeClearOperationId: null,
    };
    store.clear = vi.fn(async () => ({ ok: true, value: cleared }));
    store.read = vi.fn(async () => ({ ok: true, value: cleared }));
    const controller = createBackgroundController({ chrome, store });
    await expect(dispatchRuntime(controller, {
      type: "ui-attach:session-clear-stored-origin", origin: ORIGIN,
      epoch: "epoch-1", operationId: "stored-clear-1",
    }, createExtensionSender())).resolves.toEqual({ ok: true, data: cleared });
    expect(store.clear).toHaveBeenCalledWith(ORIGIN, "epoch-1", "stored-clear-1");
    expect(store.clearAll).not.toHaveBeenCalled();
    expect(store.clearOrigins).not.toHaveBeenCalled();
  });

  test("stored-origin clear rejects a content sender and a missing epoch before mutation", async () => {
    const chrome = createChromeHarness();
    const store = createStoreHarness();
    const controller = createBackgroundController({ chrome, store });
    const command = { type: "ui-attach:session-clear-stored-origin", origin: ORIGIN,
      epoch: "epoch-1", operationId: "stored-clear-1" };
    await expect(dispatchRuntime(controller, command, createSender(`${ORIGIN}/settings`)))
      .resolves.toMatchObject({ ok: false, code: "UNTRUSTED_SENDER" });
    await expect(dispatchRuntime(controller, { ...command, epoch: undefined }, createExtensionSender()))
      .resolves.toMatchObject({ ok: false, code: "INVALID_COMMAND" });
    expect(store.clear).not.toHaveBeenCalled();
  });

  test("stored-origin clear preserves other stored captures and supports stale rejection and retry", async () => {
    const chrome = createChromeHarness();
    chrome.tabs.query = vi.fn(async () => [{ id: 7, url: "about:blank" }]);
    const store = createExtensionSessionStore({ storage: chrome.storage.local });
    for (const origin of [ORIGIN, OTHER_ORIGIN]) {
      const token = await store.beginCapture(origin);
      expect(token.ok).toBe(true);
      if (!token.ok) throw new Error("Capture setup failed.");
      const record = createCaptureRecord("save", "Save changes");
      record.origin = origin;
      record.pageUrl = `${origin}/settings`;
      record.attachment.source.url = record.pageUrl;
      expect((await store.commitCapture(token.value, record)).ok).toBe(true);
    }
    const before = await store.read(ORIGIN);
    const otherBefore = await store.read(OTHER_ORIGIN);
    if (!before.ok || !before.value.epoch) throw new Error("Saved capture setup failed.");
    const controller = createBackgroundController({ chrome, store });
    const request = { type: "ui-attach:session-clear-stored-origin", origin: ORIGIN,
      epoch: before.value.epoch, operationId: "stored-clear-real" };
    await expect(dispatchRuntime(controller, { ...request, epoch: "stale" }, createExtensionSender()))
      .resolves.toMatchObject({ ok: false, code: "STALE_SESSION" });
    await expect(dispatchRuntime(controller, { ...request, epoch: null }, createExtensionSender()))
      .resolves.toMatchObject({ ok: false, code: "STALE_SESSION" });
    expect(await store.read(ORIGIN)).toEqual(before);
    const originalRemove = chrome.storage.local.remove;
    chrome.storage.local.remove = vi.fn(async (keys) => {
      if ((Array.isArray(keys) ? keys : [keys]).includes(`ui-attach:session:v1:${ORIGIN}`)) {
        throw new Error("Simulated storage interruption.");
      }
      return originalRemove(keys);
    });
    await expect(dispatchRuntime(controller, request, createExtensionSender()))
      .resolves.toMatchObject({ ok: false, code: "STORAGE_ERROR" });
    expect(await store.read(OTHER_ORIGIN)).toEqual(otherBefore);
    await expect(dispatchRuntime(controller, { ...request, operationId: "different-clear" }, createExtensionSender()))
      .resolves.toMatchObject({ ok: false, code: "CLEAR_IN_PROGRESS" });
    chrome.storage.local.remove = originalRemove;
    const cleared = await dispatchRuntime(controller, request, createExtensionSender());
    expect(cleared).toMatchObject({ ok: true, data: {
      origin: ORIGIN, file: null, legacyRecord: null, clearPending: false,
    } });
    expect(await store.read(OTHER_ORIGIN)).toEqual(otherBefore);
    await expect(dispatchRuntime(controller, request, createExtensionSender())).resolves.toEqual(cleared);
    expect(await store.read(OTHER_ORIGIN)).toEqual(otherBefore);
    const recapture = await store.beginCapture(ORIGIN);
    if (!recapture.ok) throw new Error("Recapture setup failed.");
    expect((await store.commitCapture(recapture.value, createCaptureRecord("save", "Save again"))).ok).toBe(true);
    const replacement = await store.read(ORIGIN);
    await expect(dispatchRuntime(controller, request, createExtensionSender()))
      .resolves.toMatchObject({ ok: false, code: "STALE_SESSION" });
    expect(await store.read(ORIGIN)).toEqual(replacement);
  });

  test("stored-origin clear recovers corrupt records without removing another origin or its latest capture", async () => {
    const chrome = createChromeHarness();
    chrome.tabs.query = vi.fn(async () => [{ id: 7, url: "about:blank" }]);
    const store = createExtensionSessionStore({ storage: chrome.storage.local });
    const token = await store.beginCapture(OTHER_ORIGIN);
    if (!token.ok) throw new Error("Capture setup failed.");
    const record = createCaptureRecord("save", "Save changes");
    record.origin = OTHER_ORIGIN;
    record.pageUrl = `${OTHER_ORIGIN}/settings`;
    record.attachment.source.url = record.pageUrl;
    expect((await store.commitCapture(token.value, record)).ok).toBe(true);
    const latestKey = "ui-attach:capture:latest";
    await chrome.storage.local.set({
      [`ui-attach:session:v1:${ORIGIN}`]: { corrupt: true },
      [`ui-attach:session-meta:v1:${ORIGIN}`]: { corrupt: true },
      [latestKey]: record,
    });
    const otherBefore = await store.read(OTHER_ORIGIN);
    const latestBefore = await chrome.storage.local.get(latestKey);
    expect(await store.read(ORIGIN)).toMatchObject({ ok: false, code: "INVALID_SESSION_FILE" });
    const controller = createBackgroundController({ chrome, store });
    await expect(dispatchRuntime(controller, {
      type: "ui-attach:session-clear-stored-origin", origin: ORIGIN,
      epoch: null, operationId: "recover-corrupt-stored-origin",
    }, createExtensionSender())).resolves.toMatchObject({ ok: true, data: {
      origin: ORIGIN, file: null, legacyRecord: null, clearPending: false,
    } });
    expect(await store.read(ORIGIN)).toMatchObject({ ok: true, value: { file: null } });
    expect(await store.read(OTHER_ORIGIN)).toEqual(otherBefore);
    expect(await chrome.storage.local.get(latestKey)).toEqual(latestBefore);
  });

  test.each([
    { code: "INVALID_SESSION_FILE" as const, epoch: "stale-epoch" },
    { code: "STORAGE_ERROR" as const, epoch: null },
  ])("stored-origin recovery preserves read failure $code with epoch $epoch", async ({ code, epoch }) => {
    const chrome = createChromeHarness();
    const store = createStoreHarness();
    store.read = vi.fn(async () => ({ ok: false, code, error: "Simulated read failure." }));
    const controller = createBackgroundController({ chrome, store });
    await expect(dispatchRuntime(controller, {
      type: "ui-attach:session-clear-stored-origin", origin: ORIGIN,
      epoch, operationId: "failed-recovery-read",
    }, createExtensionSender())).resolves.toMatchObject({ ok: false, code });
    expect(store.clear).not.toHaveBeenCalled();
  });

  test("stored-origin clear does not let a concurrent operation ID replace its barrier", async () => {
    const chrome = createChromeHarness();
    const store = createStoreHarness();
    const pending = createDeferred<Awaited<ReturnType<ExtensionSessionStore["clear"]>>>();
    store.clear = vi.fn(() => pending.promise);
    const controller = createBackgroundController({ chrome, store });
    const request = { type: "ui-attach:session-clear-stored-origin", origin: ORIGIN,
      epoch: "epoch-1", operationId: "held-stored-clear" };
    const first = dispatchRuntime(controller, request, createExtensionSender());
    await vi.waitFor(() => expect(store.clear).toHaveBeenCalledOnce());
    await expect(dispatchRuntime(controller, { ...request, origin: OTHER_ORIGIN }, createExtensionSender()))
      .resolves.toMatchObject({ ok: false, code: "CLEAR_IN_PROGRESS" });
    expect(store.clear).toHaveBeenCalledOnce();
    pending.resolve({ ok: false, code: "STORAGE_ERROR", error: "simulated" });
    await expect(first).resolves.toMatchObject({ ok: false, code: "STORAGE_ERROR" });
    await expect(dispatchRuntime(controller, { ...request, operationId: "retry-stored-clear" }, createExtensionSender()))
      .resolves.toMatchObject({ ok: false, code: "STORAGE_ERROR" });
    expect(store.clear).toHaveBeenCalledTimes(2);
  });

  test("stored-origin clear cannot take over an existing durable page clear", async () => {
    const chrome = createChromeHarness();
    const operation = boundClearProjectionOperation("stored-clear-1", "existing-document");
    await chrome.storage.local.set({
      [CLEAR_PROJECTION_JOURNAL_STORAGE_KEY]: clearProjectionJournal(operation),
    });
    const store = createStoreHarness();
    const controller = createBackgroundController({ chrome, store });
    await expect(dispatchRuntime(controller, {
      type: "ui-attach:session-clear-stored-origin", origin: ORIGIN,
      epoch: "epoch-1", operationId: "stored-clear-1",
    }, createExtensionSender())).resolves.toMatchObject({ ok: false, code: "CLEAR_IN_PROGRESS" });
    expect(store.clear).not.toHaveBeenCalled();
    expect(await chrome.storage.local.get(CLEAR_PROJECTION_JOURNAL_STORAGE_KEY)).toEqual({
      [CLEAR_PROJECTION_JOURNAL_STORAGE_KEY]: clearProjectionJournal(operation),
    });
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
    expect(chrome.tabs.query).toHaveBeenCalledWith({});
  });

  test("EA-01B-CLEAR-C2 rejects a non-canonical clear operation ID before stopping selection", async () => {
    const chrome = createChromeHarness();
    const store = createStoreHarness();
    const controller = createBackgroundController({ chrome, store });

    await expect(dispatchRuntime(controller, {
      type: "ui-attach:session-clear",
      origin: ORIGIN,
      epoch: null,
      operationId: " padded-operation ",
    }, createExtensionSender())).resolves.toMatchObject({
      ok: false,
      code: "INVALID_COMMAND",
    });
    expect(store.clear).not.toHaveBeenCalled();
    expect(chrome.tabs.query).not.toHaveBeenCalled();
  });

  test("C4 projects one journal-only authoritative pair into panel active and stored list", async () => {
    const chrome = createChromeHarness();
    chrome.tabs.query = vi.fn(async () => [{
      id: 7,
      url: `${ORIGIN}/settings`,
      windowId: 1,
    }]);
    chrome.webNavigation.getFrame = vi.fn(async () => ({
      parentFrameId: -1,
      url: `${ORIGIN}/settings`,
      documentId: "c4-active-document",
    }));
    await chrome.storage.local.set({
      [CLEAR_PROJECTION_JOURNAL_STORAGE_KEY]: clearProjectionJournal(
        boundClearProjectionOperation("clear-c4-status", "c4-status-document"),
      ),
    });
    const store = createStoreHarness();
    store.read = vi.fn(async () => ({
      ok: true,
      value: createSessionReadback(createCaptureRecord("save", "Save changes")),
    }));
    store.list = vi.fn(async () => ({ ok: true, value: [] }));
    const controller = createBackgroundController({ chrome, store });

    const active = await dispatchRuntime(controller, {
      type: "ui-attach:session-get-active",
    }, createExtensionSender());
    const stored = await dispatchRuntime(controller, {
      type: "ui-attach:session-list-stored",
    }, createExtensionSender());

    expect(active).toMatchObject({
      ok: true,
      data: { readback: { clearPending: true, activeClearOperationId: "clear-c4-status" } },
    });
    expect(stored).toEqual({
      ok: true,
      data: [{
        origin: ORIGIN,
        epoch: "after-clear-c4-status",
        attachmentCount: null,
        state: "needs_cleanup",
        clearPending: true,
        activeClearOperationId: "clear-c4-status",
      }],
    });
  });

  test("runtime begin and commit validate sender origin and commit exactly once without retry", async () => {
    const chrome = createChromeHarness();
    const store = createStoreHarness();
    const record = createCaptureRecord("save", "Save changes");
    const controller = createBackgroundController({ chrome, store });
    const route = configureTopFrameRuntimeCaptureRoute(chrome, `${ORIGIN}/settings`);
    const sender = createTopFrameRuntimeCaptureSender(route);
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
      replaceItemId: null,
    }, sender);
    expect(begun).toMatchObject({ ok: true, data: TOKEN });
    if (!begun.ok) throw new Error("capture begin failed");
    const token = begun.data as RuntimeCaptureToken;

    const stale = await dispatchRuntime(controller, {
      type: "ui-attach:session-commit-capture",
      token: { ...token, origin: OTHER_ORIGIN },
      record,
    }, sender);
    expect(stale).toMatchObject({ ok: false, code: "STALE_CAPTURE_OPERATION" });

    const committed = await dispatchRuntime(controller, {
      type: "ui-attach:session-commit-capture",
      token,
      record,
    }, sender);

    expect(committed).toEqual({
      ok: true,
      data: {
        origin: ORIGIN,
        epoch: "epoch-1",
        itemId: "att_save",
        annotationLabel: "1",
      },
    });
    expect(Object.keys((committed as { data: object }).data)).toEqual([
      "origin",
      "epoch",
      "itemId",
      "annotationLabel",
    ]);
    expect(JSON.stringify(committed)).not.toContain("file");
    expect(JSON.stringify(committed)).not.toContain("legacyRecord");
    expect(JSON.stringify(committed)).not.toContain("source");
    expect(store.commitCapture).toHaveBeenCalledTimes(1);
    expect(chrome.runtime.sentMessages.map((message) => message.type)).toEqual([
      UI_ATTACH_SESSION_UPDATED,
    ]);
  });

  test("preserves V3 annotation identity, timestamps, and lifecycle through production recapture", async () => {
    const chrome = createChromeHarness();
    const randomIds = [
      "epoch-identity-recapture",
      "operation-identity-create",
      "operation-identity-recapture",
    ];
    let now = "2026-08-30T03:00:00.000Z";
    const store = createExtensionSessionStore({
      storage: chrome.storage.local,
      now: () => new Date(now),
      randomUUID: () => randomIds.shift() ?? "unexpected-identity-recapture-id",
      createAnnotationId: () => "annotation-identity-stable",
    });
    const route = configureTopFrameRuntimeCaptureRoute(chrome, `${ORIGIN}/settings`);
    const controller = createBackgroundController({ chrome, store });
    await activateTopFrameRuntimeCaptureRoute(controller, route);
    const sender = createTopFrameRuntimeCaptureSender(route);
    const originalRecord = createCaptureRecord("identity-original", "Original identity target");
    originalRecord.pageUrl = route.url;
    originalRecord.attachment.source.url = route.url;

    const originalBegin = await dispatchRuntime(controller, {
      type: "ui-attach:session-begin-capture",
      replaceItemId: null,
    }, sender);
    if (!originalBegin.ok) throw new Error(`capture begin failed: ${originalBegin.code}`);
    const originalCommit = await dispatchRuntime(controller, {
      type: "ui-attach:session-commit-capture",
      token: originalBegin.data,
      record: originalRecord,
    }, sender);
    expect(originalCommit).toMatchObject({
      ok: true,
      data: { itemId: originalRecord.attachment.id },
    });

    const replacementBegin = await dispatchRuntime(controller, {
      type: "ui-attach:session-begin-capture",
      replaceItemId: originalRecord.attachment.id,
    }, sender);
    expect(replacementBegin).toMatchObject({
      ok: true,
      data: {
        replacement: {
          itemId: originalRecord.attachment.id,
          annotationId: "annotation-identity-stable",
          createdAt: "2026-08-30T03:00:00.000Z",
        },
      },
    });
    if (!replacementBegin.ok) {
      throw new Error(`replacement begin failed: ${replacementBegin.code}`);
    }

    now = "2026-08-30T03:01:00.000Z";
    const replacementRecord = createCaptureRecord("identity-refresh", "Refreshed identity target");
    replacementRecord.pageUrl = route.url;
    replacementRecord.attachment.source.url = route.url;
    const replacementCommit = await dispatchRuntime(controller, {
      type: "ui-attach:session-commit-capture",
      token: replacementBegin.data,
      record: replacementRecord,
    }, sender);

    expect(replacementCommit).toMatchObject({
      ok: true,
      data: { itemId: originalRecord.attachment.id },
    });
    const durable = await store.read(ORIGIN);
    expect(durable).toMatchObject({ ok: true });
    if (!durable.ok) throw new Error(durable.error);
    expect(durable.value.file).toMatchObject({
      schemaVersion: "0.3.0",
      session: {
        attachments: [{
          id: originalRecord.attachment.id,
          annotationId: "annotation-identity-stable",
          createdAt: "2026-08-30T03:00:00.000Z",
          updatedAt: "2026-08-30T03:01:00.000Z",
          annotationLifecycle: {
            state: "open",
            resolvedAt: null,
          },
          sourceRecord: {
            attachment: {
              id: originalRecord.attachment.id,
              element: { accessibleName: "Refreshed identity target" },
            },
          },
        }],
      },
    });
  });

  test("keeps a resolved V3 annotation resolved through production recapture", async () => {
    const chrome = createChromeHarness();
    const randomIds = [
      "epoch-resolved-recapture",
      "operation-resolved-create",
      "operation-resolved-recapture",
    ];
    let now = "2026-08-30T03:30:00.000Z";
    const store = createExtensionSessionStore({
      storage: chrome.storage.local,
      now: () => new Date(now),
      randomUUID: () => randomIds.shift() ?? "unexpected-resolved-recapture-id",
      createAnnotationId: () => "annotation-resolved-stable",
    });
    const route = configureTopFrameRuntimeCaptureRoute(chrome, `${ORIGIN}/settings`);
    const controller = createBackgroundController({ chrome, store });
    await activateTopFrameRuntimeCaptureRoute(controller, route);
    const sender = createTopFrameRuntimeCaptureSender(route);
    const originalRecord = createCaptureRecord("resolved-original", "Resolved target");
    originalRecord.pageUrl = route.url;
    originalRecord.attachment.source.url = route.url;
    const originalBegin = await dispatchRuntime(controller, {
      type: "ui-attach:session-begin-capture",
      replaceItemId: null,
    }, sender);
    if (!originalBegin.ok) throw new Error(`capture begin failed: ${originalBegin.code}`);
    await expect(dispatchRuntime(controller, {
      type: "ui-attach:session-commit-capture",
      token: originalBegin.data,
      record: originalRecord,
    }, sender)).resolves.toMatchObject({ ok: true });

    const sessionKey = `ui-attach:session:v1:${ORIGIN}`;
    const stored = await chrome.storage.local.get(sessionKey);
    const resolvedFile = structuredClone(stored[sessionKey]) as {
      session: {
        updatedAt: string;
        attachments: Array<{
          updatedAt: string;
          annotationLifecycle: { state: string; resolvedAt: string | null };
        }>;
      };
    };
    resolvedFile.session.updatedAt = "2026-08-30T03:30:30.000Z";
    resolvedFile.session.attachments[0]!.updatedAt = "2026-08-30T03:30:30.000Z";
    resolvedFile.session.attachments[0]!.annotationLifecycle = {
      state: "resolved",
      resolvedAt: "2026-08-30T03:30:30.000Z",
    };
    await chrome.storage.local.set({ [sessionKey]: resolvedFile });

    now = "2026-08-30T03:31:00.000Z";
    const replacementBegin = await dispatchRuntime(controller, {
      type: "ui-attach:session-begin-capture",
      replaceItemId: originalRecord.attachment.id,
    }, sender);
    expect(replacementBegin).toMatchObject({
      ok: true,
      data: {
        replacement: {
          annotationId: "annotation-resolved-stable",
          createdAt: "2026-08-30T03:30:00.000Z",
        },
      },
    });
    if (!replacementBegin.ok) throw new Error(`replacement begin failed: ${replacementBegin.code}`);
    const replacementRecord = createCaptureRecord("resolved-refresh", "Resolved target refreshed");
    replacementRecord.pageUrl = route.url;
    replacementRecord.attachment.source.url = route.url;
    await expect(dispatchRuntime(controller, {
      type: "ui-attach:session-commit-capture",
      token: replacementBegin.data,
      record: replacementRecord,
    }, sender)).resolves.toMatchObject({ ok: true });

    await expect(store.read(ORIGIN)).resolves.toMatchObject({
      ok: true,
      value: {
        file: {
          schemaVersion: "0.3.0",
          session: {
            updatedAt: "2026-08-30T03:31:00.000Z",
            attachments: [{
              annotationId: "annotation-resolved-stable",
              createdAt: "2026-08-30T03:30:00.000Z",
              updatedAt: "2026-08-30T03:31:00.000Z",
              annotationLifecycle: {
                state: "resolved",
                resolvedAt: "2026-08-30T03:30:30.000Z",
              },
            }],
          },
        },
      },
    });
  });

  test("reads a durable V2 annotation identity before migrating its recapture to V3", async () => {
    const chrome = createChromeHarness();
    const storedRecord = createCaptureRecord("v2-identity", "V2 identity target");
    const route = configureTopFrameRuntimeCaptureRoute(chrome, `${ORIGIN}/settings`);
    storedRecord.pageUrl = route.url;
    storedRecord.attachment.source.url = route.url;
    const v1File = createSessionFile([storedRecord]);
    const v2File = {
      ...v1File,
      schemaVersion: "0.2.0" as const,
      session: {
        ...v1File.session,
        attachments: v1File.session.attachments.map((item) => ({
          ...item,
          annotationId: "annotation-v2-durable",
          updatedAt: item.createdAt,
        })),
      },
    };
    await chrome.storage.local.set({
      [`ui-attach:session:v1:${ORIGIN}`]: v2File,
      [`ui-attach:session:v1:meta:${ORIGIN}`]: {
        epoch: "epoch-v2-durable",
        clearPending: false,
        activeClearOperationId: null,
        lastCompletedClearOperationId: null,
        receipts: [],
      },
    });
    const createAnnotationId = vi.fn(() => "must-not-reallocate-v2-identity");
    const store = createExtensionSessionStore({
      storage: chrome.storage.local,
      now: () => new Date("2026-08-30T03:35:00.000Z"),
      randomUUID: () => "operation-v2-recapture",
      createAnnotationId,
    });
    const controller = createBackgroundController({ chrome, store });
    await activateTopFrameRuntimeCaptureRoute(controller, route);
    const sender = createTopFrameRuntimeCaptureSender(route);
    const begun = await dispatchRuntime(controller, {
      type: "ui-attach:session-begin-capture",
      replaceItemId: storedRecord.attachment.id,
    }, sender);
    expect(begun).toMatchObject({
      ok: true,
      data: {
        replacement: {
          itemId: storedRecord.attachment.id,
          annotationId: "annotation-v2-durable",
        },
      },
    });
    if (!begun.ok) throw new Error(`replacement begin failed: ${begun.code}`);
    const replacementRecord = createCaptureRecord("v2-refresh", "V2 target refreshed");
    replacementRecord.pageUrl = route.url;
    replacementRecord.attachment.source.url = route.url;
    await expect(dispatchRuntime(controller, {
      type: "ui-attach:session-commit-capture",
      token: begun.data,
      record: replacementRecord,
    }, sender)).resolves.toMatchObject({ ok: true });
    expect(createAnnotationId).not.toHaveBeenCalled();
    await expect(store.read(ORIGIN)).resolves.toMatchObject({
      ok: true,
      value: {
        file: {
          schemaVersion: "0.3.0",
          session: {
            attachments: [{
              id: storedRecord.attachment.id,
              annotationId: "annotation-v2-durable",
              annotationLifecycle: { state: "open", resolvedAt: null },
            }],
          },
        },
      },
    });
  });

  test("rejects a pre-restart runtime capture token while a fresh post-restart begin succeeds", async () => {
    const chrome = createChromeHarness();
    const randomIds = [
      "epoch-runtime-restart",
      "operation-before-restart",
      "operation-after-restart",
    ];
    const store = createExtensionSessionStore({
      storage: chrome.storage.local,
      now: () => new Date("2026-08-30T03:40:00.000Z"),
      randomUUID: () => randomIds.shift() ?? "unexpected-runtime-restart-id",
      createAnnotationId: () => "annotation-runtime-restart",
    });
    const route = configureTopFrameRuntimeCaptureRoute(chrome, `${ORIGIN}/settings`);
    const firstController = createBackgroundController({ chrome, store });
    await activateTopFrameRuntimeCaptureRoute(firstController, route);
    const sender = createTopFrameRuntimeCaptureSender(route);
    const staleBegin = await dispatchRuntime(firstController, {
      type: "ui-attach:session-begin-capture",
      replaceItemId: null,
    }, sender);
    if (!staleBegin.ok) throw new Error(`capture begin failed: ${staleBegin.code}`);

    const recreatedController = createBackgroundController({ chrome, store });
    await activateTopFrameRuntimeCaptureRoute(recreatedController, route);
    const record = createCaptureRecord("restart-token", "Restart token target");
    record.pageUrl = route.url;
    record.attachment.source.url = route.url;
    await expect(dispatchRuntime(recreatedController, {
      type: "ui-attach:session-commit-capture",
      token: staleBegin.data,
      record,
    }, sender)).resolves.toMatchObject({ ok: false, code: "STALE_CAPTURE_OPERATION" });

    const freshBegin = await dispatchRuntime(recreatedController, {
      type: "ui-attach:session-begin-capture",
      replaceItemId: null,
    }, sender);
    expect(freshBegin).toMatchObject({
      ok: true,
      data: { operationId: "operation-after-restart" },
    });
    if (!freshBegin.ok) throw new Error(`fresh begin failed: ${freshBegin.code}`);
    await expect(dispatchRuntime(recreatedController, {
      type: "ui-attach:session-commit-capture",
      token: freshBegin.data,
      record,
    }, sender)).resolves.toMatchObject({ ok: true });
    await expect(store.read(ORIGIN)).resolves.toMatchObject({
      ok: true,
      value: {
        file: {
          schemaVersion: "0.3.0",
          session: { attachments: [{ annotationId: "annotation-runtime-restart" }] },
        },
      },
    });
  });

  test("rejects an authority-compatible controller ABA replay after delete, recreation, and restart", async () => {
    const chrome = createChromeHarness();
    const randomIds = [
      "epoch-controller-aba",
      "operation-controller-a",
      "operation-controller-b",
    ];
    const annotationIds = ["annotation-controller-a", "annotation-controller-b"];
    let now = "2026-08-30T06:00:00.000Z";
    const initialStore = createExtensionSessionStore({
      storage: chrome.storage.local,
      now: () => new Date(now),
      randomUUID: () => randomIds.shift() ?? "unexpected-controller-aba-id",
      createAnnotationId: () => annotationIds.shift() ?? "unexpected-controller-annotation",
    });
    const route = configureTopFrameRuntimeCaptureRoute(chrome, `${ORIGIN}/settings`);
    const firstController = createBackgroundController({ chrome, store: initialStore });
    await activateTopFrameRuntimeCaptureRoute(firstController, route);
    const sender = createTopFrameRuntimeCaptureSender(route);
    const recordA = createCaptureRecord("controller-aba", "Controller target A");
    recordA.pageUrl = route.url;
    recordA.attachment.source.url = route.url;

    const beginA = await dispatchRuntime(firstController, {
      type: "ui-attach:session-begin-capture",
      replaceItemId: null,
    }, sender);
    if (!beginA.ok) throw new Error(`capture A begin failed: ${beginA.code}`);
    const runtimeTokenA = structuredClone(beginA.data) as RuntimeCaptureToken;
    await expect(dispatchRuntime(firstController, {
      type: "ui-attach:session-commit-capture",
      token: runtimeTokenA,
      record: recordA,
    }, sender)).resolves.toMatchObject({
      ok: true,
      data: { itemId: "att_controller-aba" },
    });

    now = "2026-08-30T06:01:00.000Z";
    await expect(dispatchRuntime(firstController, {
      type: "ui-attach:session-remove-item",
      origin: ORIGIN,
      epoch: runtimeTokenA.epoch,
      itemId: recordA.attachment.id,
    }, createExtensionSender())).resolves.toMatchObject({
      ok: true,
      data: { file: { session: { attachments: [] } } },
    });

    await activateTopFrameRuntimeCaptureRoute(firstController, route);
    const beginB = await dispatchRuntime(firstController, {
      type: "ui-attach:session-begin-capture",
      replaceItemId: null,
    }, sender);
    if (!beginB.ok) throw new Error(`capture B begin failed: ${beginB.code}`);
    expect(beginB.data).toMatchObject({ operationId: "operation-controller-b" });
    now = "2026-08-30T06:02:00.000Z";
    const recordB = createCaptureRecord("controller-aba", "Controller target B");
    recordB.pageUrl = route.url;
    recordB.attachment.source.url = route.url;
    await expect(dispatchRuntime(firstController, {
      type: "ui-attach:session-commit-capture",
      token: beginB.data,
      record: recordB,
    }, sender)).resolves.toMatchObject({
      ok: true,
      data: { itemId: "att_controller-aba" },
    });

    const sessionKey = `ui-attach:session:v1:${ORIGIN}`;
    const metaKey = `ui-attach:session:v1:meta:${ORIGIN}`;
    const originProjectionKey = `ui-attach:capture:${ORIGIN}`;
    const latestProjectionKey = "ui-attach:capture:latest";
    const durableKeys = [sessionKey, metaKey, originProjectionKey, latestProjectionKey];
    const durableBeforeReplay = await chrome.storage.local.get(durableKeys);
    const durableBytesBeforeReplay = Object.fromEntries(durableKeys.map((key) => [
      key,
      JSON.stringify(durableBeforeReplay[key]),
    ]));
    expect(durableBeforeReplay[sessionKey]).toMatchObject({
      schemaVersion: "0.3.0",
      session: {
        attachments: [{
          id: "att_controller-aba",
          annotationId: "annotation-controller-b",
          annotationLifecycle: { state: "open", resolvedAt: null },
          sourceRecord: {
            attachment: { element: { accessibleName: "Controller target B" } },
          },
        }],
      },
    });
    expect(durableBeforeReplay[metaKey]).toMatchObject({
      receipts: [
        {
          operationId: "operation-controller-a",
          itemId: "att_controller-aba",
          annotationId: "annotation-controller-a",
        },
        {
          operationId: "operation-controller-b",
          itemId: "att_controller-aba",
          annotationId: "annotation-controller-b",
        },
      ],
    });

    const replayAnnotationId = vi.fn(() => "must-not-create-replay-annotation");
    const restartedStore = createExtensionSessionStore({
      storage: chrome.storage.local,
      now: () => new Date("2026-08-30T06:03:00.000Z"),
      randomUUID: () => "operation-controller-a",
      createAnnotationId: replayAnnotationId,
    });
    const originalCommitCapture = restartedStore.commitCapture.bind(restartedStore);
    const terminalAuthorityAtEntry: boolean[] = [];
    restartedStore.commitCapture = vi.fn(async (token, record, authority) => {
      terminalAuthorityAtEntry.push(authority?.isCurrent() ?? false);
      return originalCommitCapture(token, record, authority);
    });
    const afterWrite = vi.fn(async () => undefined);
    const onActiveSessionChanged = vi.fn(async () => undefined);
    const restartedController = createBackgroundController({
      chrome,
      store: restartedStore,
      onActiveSessionChanged,
      captureCommitGate: {
        beforeWrite: async () => undefined,
        afterWrite,
      },
    });
    await activateTopFrameRuntimeCaptureRoute(restartedController, route);

    await expect(dispatchRuntime(restartedController, {
      type: "ui-attach:session-commit-capture",
      token: runtimeTokenA,
      record: createCaptureRecord("literal-old-a", "Literal old A"),
    }, sender)).resolves.toMatchObject({
      ok: false,
      code: "STALE_CAPTURE_OPERATION",
    });
    expect(restartedStore.commitCapture).not.toHaveBeenCalled();

    const replayBegin = await dispatchRuntime(restartedController, {
      type: "ui-attach:session-begin-capture",
      replaceItemId: null,
    }, sender);
    if (!replayBegin.ok) throw new Error(`ABA replay begin failed: ${replayBegin.code}`);
    expect(replayBegin.data).toMatchObject({
      epoch: "epoch-controller-aba",
      operationId: "operation-controller-a",
      replacement: null,
    });
    chrome.runtime.sentMessages.length = 0;
    vi.mocked(chrome.tabs.sendMessage).mockClear();
    vi.mocked(chrome.storage.local.set).mockClear();
    vi.mocked(chrome.storage.local.remove).mockClear();
    vi.mocked(restartedStore.commitCapture).mockClear();
    onActiveSessionChanged.mockClear();
    afterWrite.mockClear();

    const staleReplayRecord = createCaptureRecord("controller-aba-stale", "Stale A replay");
    staleReplayRecord.pageUrl = route.url;
    staleReplayRecord.attachment.source.url = route.url;
    await expect(dispatchRuntime(restartedController, {
      type: "ui-attach:session-commit-capture",
      token: replayBegin.data,
      record: staleReplayRecord,
    }, sender)).resolves.toMatchObject({
      ok: false,
      code: "STALE_CAPTURE_OPERATION",
    });
    await flushAsyncWork();
    expect(restartedStore.commitCapture).toHaveBeenCalledTimes(1);
    expect(vi.mocked(restartedStore.commitCapture).mock.calls[0]?.[0]).toMatchObject({
      epoch: "epoch-controller-aba",
      operationId: "operation-controller-a",
      replacement: null,
    });
    expect(terminalAuthorityAtEntry).toEqual([true]);
    expect(replayAnnotationId).not.toHaveBeenCalled();
    expect(afterWrite).not.toHaveBeenCalled();
    expect(onActiveSessionChanged).not.toHaveBeenCalled();
    expect(chrome.runtime.sentMessages).not.toContainEqual(expect.objectContaining({
      type: UI_ATTACH_SESSION_UPDATED,
    }));
    expect(chrome.tabs.sendMessage).not.toHaveBeenCalled();
    expect(chrome.storage.local.set).not.toHaveBeenCalled();
    expect(chrome.storage.local.remove).not.toHaveBeenCalled();

    const postCallbackStore = createExtensionSessionStore({ storage: chrome.storage.local });
    const postCallbackController = createBackgroundController({
      chrome,
      store: postCallbackStore,
    });
    await expect(dispatchRuntime(postCallbackController, {
      type: "ui-attach:session-list-stored",
    }, createExtensionSender())).resolves.toMatchObject({
      ok: true,
      data: [{ origin: ORIGIN, epoch: "epoch-controller-aba", attachmentCount: 1, state: "ready" }],
    });
    await expect(postCallbackStore.read(ORIGIN)).resolves.toMatchObject({
      ok: true,
      value: {
        file: {
          schemaVersion: "0.3.0",
          session: {
            attachments: [{
              id: "att_controller-aba",
              annotationId: "annotation-controller-b",
              annotationLifecycle: { state: "open", resolvedAt: null },
              sourceRecord: {
                attachment: { element: { accessibleName: "Controller target B" } },
              },
            }],
          },
        },
      },
    });
    const durableAfterReplay = await chrome.storage.local.get(durableKeys);
    expect(Object.fromEntries(durableKeys.map((key) => [
      key,
      JSON.stringify(durableAfterReplay[key]),
    ]))).toEqual(durableBytesBeforeReplay);
    expect(chrome.storage.local.set).not.toHaveBeenCalled();
    expect(chrome.storage.local.remove).not.toHaveBeenCalled();
  });

  test.each([
    ["missing", "STALE_CAPTURE_OPERATION"],
    ["own undefined", "INVALID_COMMAND"],
    ["null", "STALE_CAPTURE_OPERATION"],
    ["malformed", "INVALID_COMMAND"],
    ["another valid identity", "STALE_CAPTURE_OPERATION"],
    ["extra field", "INVALID_COMMAND"],
  ] as const)("fails closed when a V3 replacement annotation identity is %s", async (
    variant,
    expectedCode,
  ) => {
    const chrome = createChromeHarness();
    let randomId = 0;
    const store = createExtensionSessionStore({
      storage: chrome.storage.local,
      now: () => new Date("2026-08-30T03:10:00.000Z"),
      randomUUID: () => `identity-token-${++randomId}`,
      createAnnotationId: () => "annotation-identity-current",
    });
    const route = configureTopFrameRuntimeCaptureRoute(chrome, `${ORIGIN}/settings`);
    const controller = createBackgroundController({ chrome, store });
    await activateTopFrameRuntimeCaptureRoute(controller, route);
    const sender = createTopFrameRuntimeCaptureSender(route);
    const originalRecord = createCaptureRecord("identity-token", "Identity token target");
    originalRecord.pageUrl = route.url;
    originalRecord.attachment.source.url = route.url;
    const originalBegin = await dispatchRuntime(controller, {
      type: "ui-attach:session-begin-capture",
      replaceItemId: null,
    }, sender);
    if (!originalBegin.ok) throw new Error(`capture begin failed: ${originalBegin.code}`);
    await expect(dispatchRuntime(controller, {
      type: "ui-attach:session-commit-capture",
      token: originalBegin.data,
      record: originalRecord,
    }, sender)).resolves.toMatchObject({ ok: true });

    await activateTopFrameRuntimeCaptureRoute(controller, route);
    const replacementBegin = await dispatchRuntime(controller, {
      type: "ui-attach:session-begin-capture",
      replaceItemId: originalRecord.attachment.id,
    }, sender);
    if (!replacementBegin.ok) {
      throw new Error(`replacement begin failed: ${replacementBegin.code}`);
    }
    const token = structuredClone(replacementBegin.data) as RuntimeCaptureToken & {
      replacement: NonNullable<RuntimeCaptureToken["replacement"]>;
    };
    switch (variant) {
      case "missing":
        delete token.replacement.annotationId;
        break;
      case "own undefined":
        token.replacement.annotationId = undefined;
        break;
      case "null":
        token.replacement.annotationId = null;
        break;
      case "malformed":
        token.replacement.annotationId = " annotation identity ";
        break;
      case "another valid identity":
        token.replacement.annotationId = "annotation-identity-other";
        break;
      case "extra field":
        (token.replacement as Record<string, unknown>).unexpected = true;
        break;
    }
    const replacementRecord = createCaptureRecord("identity-token-refresh", "Refreshed token target");
    replacementRecord.pageUrl = route.url;
    replacementRecord.attachment.source.url = route.url;

    await expect(dispatchRuntime(controller, {
      type: "ui-attach:session-commit-capture",
      token,
      record: replacementRecord,
    }, sender)).resolves.toMatchObject({ ok: false, code: expectedCode });
    const durable = await store.read(ORIGIN);
    expect(durable).toMatchObject({
      ok: true,
      value: {
        file: {
          schemaVersion: "0.3.0",
          session: {
            attachments: [{
              annotationId: "annotation-identity-current",
              updatedAt: "2026-08-30T03:10:00.000Z",
              annotationLifecycle: { state: "open", resolvedAt: null },
              sourceRecord: {
                attachment: {
                  element: { accessibleName: "Identity token target" },
                },
              },
            }],
          },
        },
      },
    });
  });

  test("accepts a legacy replacement token without inventing identity before the migration commit", async () => {
    const chrome = createChromeHarness();
    const legacyRecord = createCaptureRecord("legacy-identity", "Legacy identity target");
    await chrome.storage.local.set({
      [`ui-attach:session:v1:${ORIGIN}`]: createSessionFile([legacyRecord]),
      [`ui-attach:session:v1:meta:${ORIGIN}`]: {
        epoch: "epoch-legacy-identity",
        clearPending: false,
        activeClearOperationId: null,
        lastCompletedClearOperationId: null,
        receipts: [],
      },
    });
    const store = createExtensionSessionStore({
      storage: chrome.storage.local,
      now: () => new Date("2026-08-30T03:20:00.000Z"),
      randomUUID: () => "operation-legacy-identity",
      createAnnotationId: () => "annotation-identity-migrated",
    });
    const commitCapture = vi.spyOn(store, "commitCapture");
    const route = configureTopFrameRuntimeCaptureRoute(chrome, `${ORIGIN}/settings`);
    const controller = createBackgroundController({ chrome, store });
    await activateTopFrameRuntimeCaptureRoute(controller, route);
    const sender = createTopFrameRuntimeCaptureSender(route);
    const begun = await dispatchRuntime(controller, {
      type: "ui-attach:session-begin-capture",
      replaceItemId: legacyRecord.attachment.id,
    }, sender);
    expect(begun).toMatchObject({
      ok: true,
      data: {
        replacement: {
          itemId: legacyRecord.attachment.id,
          annotationId: null,
        },
      },
    });
    if (!begun.ok) throw new Error(`replacement begin failed: ${begun.code}`);
    expect(Object.hasOwn(begun.data.replacement ?? {}, "annotationId")).toBe(true);
    const replacementRecord = createCaptureRecord("legacy-identity-refresh", "Refreshed legacy target");
    replacementRecord.pageUrl = route.url;
    replacementRecord.attachment.source.url = route.url;

    await expect(dispatchRuntime(controller, {
      type: "ui-attach:session-commit-capture",
      token: begun.data,
      record: replacementRecord,
    }, sender)).resolves.toMatchObject({ ok: true });
    expect(commitCapture).toHaveBeenCalledWith(
      expect.objectContaining({
        replacement: expect.objectContaining({ annotationId: null }),
      }),
      expect.any(Object),
      expect.any(Object),
    );
    const durable = await store.read(ORIGIN);
    expect(durable).toMatchObject({
      ok: true,
      value: {
        file: {
          schemaVersion: "0.3.0",
          session: {
            attachments: [{
              id: legacyRecord.attachment.id,
              annotationId: "annotation-identity-migrated",
              createdAt: legacyRecord.capturedAt,
              updatedAt: "2026-08-30T03:20:00.000Z",
              annotationLifecycle: { state: "open", resolvedAt: null },
            }],
          },
        },
      },
    });
  });

  test("invalidates at the terminal pre-write barrier from live pathname even before navigation events arrive", async () => {
    const chrome = createChromeHarness();
    const store = createStoreHarness();
    const route = configureTopFrameRuntimeCaptureRoute(chrome, `${ORIGIN}/spa/a`);
    const beforeWriteEntered = createDeferred<void>();
    const releaseBeforeWrite = createDeferred<void>();
    const onActiveSessionChanged = vi.fn(async () => undefined);
    let gatedOperationId: string | null = null;
    let terminalStoreMutations = 0;
    const commitCapture: ExtensionSessionStore["commitCapture"] = async (
      _token,
      committedRecord,
      authority,
    ) => {
      expect(authority?.isCurrent()).toBe(true);
      await authority?.beforeWrite?.();
      if (authority?.refresh && !await authority.refresh()) {
        return {
          ok: false,
          code: "STALE_CAPTURE_OPERATION",
          error: "Capture operation is stale.",
        };
      }
      if (!authority?.isCurrent()) {
        return {
          ok: false,
          code: "STALE_CAPTURE_OPERATION",
          error: "Capture operation is stale.",
        };
      }
      terminalStoreMutations += 1;
      return {
        ok: true,
        value: {
          itemId: committedRecord.attachment.id,
          label: "A",
          readback: createSessionReadback(committedRecord),
        },
      };
    };
    store.commitCapture = vi.fn(commitCapture);
    const controller = createBackgroundController({
      chrome,
      store,
      ensureContentScript: vi.fn(async () => true),
      onActiveSessionChanged,
      captureCommitGate: {
        beforeWrite: async (operationId) => {
          gatedOperationId = operationId;
          beforeWriteEntered.resolve(undefined);
          await releaseBeforeWrite.promise;
        },
        afterWrite: async () => undefined,
      },
    });
    await activateTopFrameRuntimeCaptureRoute(controller, route);
    const sender = createTopFrameRuntimeCaptureSender(route);
    const begun = await dispatchRuntime(controller, {
      type: "ui-attach:session-begin-capture",
      replaceItemId: null,
    }, sender);
    if (!begun.ok) throw new Error(`capture begin failed: ${begun.code}`);
    const token = begun.data as RuntimeCaptureToken;
    const record = createCaptureRecord("route-a", "Route A target");
    record.pageUrl = route.url;
    record.attachment.source.url = route.url;
    chrome.runtime.sentMessages.length = 0;
    vi.mocked(chrome.tabs.sendMessage).mockClear();
    onActiveSessionChanged.mockClear();

    const commit = dispatchRuntime(controller, {
      type: "ui-attach:session-commit-capture",
      token,
      record,
    }, sender);
    await beforeWriteEntered.promise;
    route.url = `${ORIGIN}/spa/b`;
    releaseBeforeWrite.resolve(undefined);

    await expect(commit).resolves.toMatchObject({
      ok: false,
      code: "STALE_CAPTURE_OPERATION",
    });
    expect(gatedOperationId).toBe(token.operationId);
    expect(terminalStoreMutations).toBe(0);
    expect(chrome.runtime.sentMessages).not.toContainEqual(expect.objectContaining({
      type: UI_ATTACH_SESSION_UPDATED,
    }));
    expect(vi.mocked(chrome.tabs.sendMessage).mock.calls.some(([, message]) => (
      isRecord(message) && (
        message.type === UI_ATTACH_OVERLAY_STATE ||
        message.type === UI_ATTACH_OVERLAY_PREVIEW ||
        message.type === UI_ATTACH_CAPTURE_FAILED
      )
    ))).toBe(false);
    expect(onActiveSessionChanged).not.toHaveBeenCalled();
  });

  test.each([
    ["live top-frame fallback", "live"],
    ["unavailable live frame APIs", "unavailable"],
  ] as const)("fails closed at the real-store pre-write boundary with %s", async (_label, fallback) => {
    const chrome = createChromeHarness();
    const ids = [`epoch-real-${fallback}`, `operation-real-${fallback}`];
    const store = createExtensionSessionStore({
      storage: chrome.storage.local,
      now: () => new Date("2026-08-24T04:00:00.000Z"),
      randomUUID: () => ids.shift() ?? `unexpected-real-${fallback}-id`,
    });
    const route = configureTopFrameRuntimeCaptureRoute(chrome, `${ORIGIN}/spa/a`);
    const beforeWriteEntered = createDeferred<void>();
    const releaseBeforeWrite = createDeferred<void>();
    const afterWrite = vi.fn(async () => undefined);
    const controller = createBackgroundController({
      chrome,
      store,
      ensureContentScript: vi.fn(async () => true),
      captureCommitGate: {
        beforeWrite: async () => {
          beforeWriteEntered.resolve(undefined);
          await releaseBeforeWrite.promise;
        },
        afterWrite,
      },
    });
    await activateTopFrameRuntimeCaptureRoute(controller, route);
    const sender = createTopFrameRuntimeCaptureSender(route);
    const begun = await dispatchRuntime(controller, {
      type: "ui-attach:session-begin-capture",
      replaceItemId: null,
    }, sender);
    if (!begun.ok) throw new Error(`capture begin failed: ${begun.code}`);
    const record = createCaptureRecord(`route-a-real-${fallback}`, "Route A target");
    record.pageUrl = route.url;
    record.attachment.source.url = route.url;

    const commit = dispatchRuntime(controller, {
      type: "ui-attach:session-commit-capture",
      token: begun.data,
      record,
    }, sender);
    await beforeWriteEntered.promise;
    route.url = `${ORIGIN}/spa/b`;
    chrome.webNavigation.getAllFrames = vi.fn(async () => {
      throw new Error("frame inventory unavailable");
    });
    chrome.webNavigation.getFrame = fallback === "live"
      ? vi.fn(async ({ frameId }) => frameId === 0
        ? {
            frameId: 0,
            parentFrameId: -1,
            documentId: route.documentId,
            url: route.url,
          }
        : undefined)
      : vi.fn(async () => {
          throw new Error("top frame unavailable");
        });
    releaseBeforeWrite.resolve(undefined);

    await expect(commit).resolves.toMatchObject({
      ok: false,
      code: "STALE_CAPTURE_OPERATION",
    });
    expect(afterWrite).not.toHaveBeenCalled();
    const freshStore = createExtensionSessionStore({ storage: chrome.storage.local });
    await expect(freshStore.read(ORIGIN)).resolves.toMatchObject({
      ok: true,
      value: {
        file: null,
        legacyRecord: null,
        epoch: `epoch-real-${fallback}`,
      },
    });
    const raw = await chrome.storage.local.get(null);
    expect(raw).not.toHaveProperty(`ui-attach:session:v1:${ORIGIN}`);
    expect(raw).not.toHaveProperty(`ui-attach:capture:${ORIGIN}`);
    expect(raw).not.toHaveProperty("ui-attach:capture:latest");
  });

  test("keeps a durable route-A commit from publishing into route B after a post-write navigation", async () => {
    const chrome = createChromeHarness();
    await chrome.storage.local.set({
      [OVERLAY_PROJECTION_AUTHORITY_GENERATION_KEY]: 1,
    });
    const ids = ["epoch-real-post-write", "operation-real-post-write"];
    const store = createExtensionSessionStore({
      storage: chrome.storage.local,
      now: () => new Date("2026-08-24T04:00:00.000Z"),
      randomUUID: () => ids.shift() ?? "unexpected-real-post-write-id",
    });
    const route = configureTopFrameRuntimeCaptureRoute(chrome, `${ORIGIN}/spa/a`);
    const afterWriteEntered = createDeferred<void>();
    const releaseAfterWrite = createDeferred<void>();
    const onActiveSessionChanged = vi.fn(async () => undefined);
    let gatedOperationId: string | null = null;
    let durableReadbackAtBarrier: ActiveSessionReadback | null = null;
    const controller = createBackgroundController({
      chrome,
      store,
      ensureContentScript: vi.fn(async () => true),
      onActiveSessionChanged,
      captureCommitGate: {
        beforeWrite: async () => undefined,
        afterWrite: async (operationId) => {
          gatedOperationId = operationId;
          const durable = await store.read(ORIGIN);
          if (!durable.ok) throw new Error(durable.error);
          durableReadbackAtBarrier = durable.value;
          afterWriteEntered.resolve(undefined);
          await releaseAfterWrite.promise;
        },
      },
    });
    await activateTopFrameRuntimeCaptureRoute(controller, route);
    const sender = createTopFrameRuntimeCaptureSender(route);
    const begun = await dispatchRuntime(controller, {
      type: "ui-attach:session-begin-capture",
      replaceItemId: null,
    }, sender);
    if (!begun.ok) throw new Error(`capture begin failed: ${begun.code}`);
    const token = begun.data as RuntimeCaptureToken;
    const record = createCaptureRecord("route-a-real-post-write", "Route A durable target");
    record.pageUrl = route.url;
    record.attachment.source.url = route.url;
    chrome.runtime.sentMessages.length = 0;
    vi.mocked(chrome.tabs.sendMessage).mockClear();
    onActiveSessionChanged.mockClear();

    const commit = dispatchRuntime(controller, {
      type: "ui-attach:session-commit-capture",
      token,
      record,
    }, sender);
    await afterWriteEntered.promise;
    expect(gatedOperationId).toBe(token.operationId);
    expect(durableReadbackAtBarrier?.file?.session.attachments).toHaveLength(1);
    expect(durableReadbackAtBarrier?.file?.session.attachments[0]?.id).toBe(
      record.attachment.id,
    );
    route.url = `${ORIGIN}/spa/b`;
    releaseAfterWrite.resolve(undefined);

    await expect(commit).resolves.toMatchObject({
      ok: true,
      data: { itemId: record.attachment.id },
    });
    await expect(store.read(ORIGIN)).resolves.toMatchObject({
      ok: true,
      value: {
        file: { session: { attachments: [{ id: record.attachment.id }] } },
      },
    });
    expect(chrome.runtime.sentMessages).not.toContainEqual(expect.objectContaining({
      type: UI_ATTACH_SESSION_UPDATED,
    }));
    expect(vi.mocked(chrome.tabs.sendMessage).mock.calls.some(([, message]) => (
      isRecord(message) && (
        message.type === UI_ATTACH_OVERLAY_STATE ||
        message.type === UI_ATTACH_OVERLAY_PREVIEW ||
        message.type === UI_ATTACH_CAPTURE_FAILED
      )
    ))).toBe(false);
    expect(onActiveSessionChanged).not.toHaveBeenCalled();
    await controller.handleNavigationCommitted({
      tabId: route.tabId,
      frameId: 0,
      parentFrameId: -1,
      documentId: route.documentId,
      url: route.url,
    }, false);
  });

  test("keeps route-A projection publication fenced after a post-write navigation", async () => {
    const chrome = createChromeHarness();
    await chrome.storage.local.set({
      [OVERLAY_PROJECTION_AUTHORITY_GENERATION_KEY]: 1,
    });
    const store = createStoreHarness();
    const route = configureTopFrameRuntimeCaptureRoute(chrome, `${ORIGIN}/spa/a`);
    const postWriteSubjectLookupEntered = createDeferred<void>();
    const releasePostWriteSubjectLookup = createDeferred<void>();
    const onActiveSessionChanged = vi.fn(async () => undefined);
    let terminalStoreMutations = 0;
    let deferPostWriteSubjectLookup = true;
    const originalGetFrame = chrome.webNavigation.getFrame;
    chrome.webNavigation.getFrame = vi.fn(async (details) => {
      if (terminalStoreMutations === 1 && deferPostWriteSubjectLookup) {
        deferPostWriteSubjectLookup = false;
        postWriteSubjectLookupEntered.resolve(undefined);
        await releasePostWriteSubjectLookup.promise;
      }
      return await originalGetFrame(details);
    });
    store.commitCapture = vi.fn(async (_token, committedRecord, authority) => {
      expect(authority?.isCurrent()).toBe(true);
      terminalStoreMutations += 1;
      return {
        ok: true,
        value: {
          itemId: committedRecord.attachment.id,
          label: "A",
          readback: createSessionReadback(committedRecord),
        },
      };
    });
    const controller = createBackgroundController({
      chrome,
      store,
      ensureContentScript: vi.fn(async () => true),
      onActiveSessionChanged,
    });
    await activateTopFrameRuntimeCaptureRoute(controller, route);
    const sender = createTopFrameRuntimeCaptureSender(route);
    const begun = await dispatchRuntime(controller, {
      type: "ui-attach:session-begin-capture",
      replaceItemId: null,
    }, sender);
    if (!begun.ok) throw new Error(`capture begin failed: ${begun.code}`);
    const token = begun.data as RuntimeCaptureToken;
    const record = createCaptureRecord("route-a-post-write", "Route A post-write target");
    record.pageUrl = route.url;
    record.attachment.source.url = route.url;
    chrome.runtime.sentMessages.length = 0;
    vi.mocked(chrome.tabs.sendMessage).mockClear();
    onActiveSessionChanged.mockClear();

    const commit = dispatchRuntime(controller, {
      type: "ui-attach:session-commit-capture",
      token,
      record,
    }, sender);
    await postWriteSubjectLookupEntered.promise;
    route.url = `${ORIGIN}/spa/b`;
    const navigation = controller.handleNavigationCommitted({
      tabId: route.tabId,
      frameId: 0,
      parentFrameId: -1,
      documentId: route.documentId,
      url: route.url,
    }, false);
    releasePostWriteSubjectLookup.resolve(undefined);

    await expect(commit).resolves.toMatchObject({
      ok: true,
      data: { itemId: record.attachment.id },
    });
    await navigation;
    expect(terminalStoreMutations).toBe(1);
    expect(chrome.runtime.sentMessages).not.toContainEqual(expect.objectContaining({
      type: UI_ATTACH_SESSION_UPDATED,
    }));
    expect(vi.mocked(chrome.tabs.sendMessage).mock.calls.some(([, message]) => (
      isRecord(message) && message.type === UI_ATTACH_OVERLAY_STATE &&
      Array.isArray(message.items) && message.items.length > 0
    ))).toBe(false);
    expect(onActiveSessionChanged).not.toHaveBeenCalled();
    const projectionRegistry = await chrome.storage.session.get(OVERLAY_PROJECTIONS_SESSION_KEY);
    expect(JSON.stringify(projectionRegistry)).not.toContain('"pathname":"/spa/b"');
    const activeItems = await chrome.storage.session.get(OVERLAY_ACTIVE_ITEMS_SESSION_KEY);
    expect(JSON.stringify(activeItems)).not.toContain(record.attachment.id);
  });

  test("keeps a post-write projection route-bound when navigation interrupts registry persistence", async () => {
    const chrome = createChromeHarness();
    await chrome.storage.local.set({
      [OVERLAY_PROJECTION_AUTHORITY_GENERATION_KEY]: 1,
    });
    const store = createStoreHarness();
    const route = configureTopFrameRuntimeCaptureRoute(chrome, `${ORIGIN}/spa/a`);
    const projectionPersistenceEntered = createDeferred<void>();
    const releaseProjectionPersistence = createDeferred<void>();
    const projectionRegistryWrites: unknown[] = [];
    let terminalStoreMutations = 0;
    let deferProjectionPersistence = true;
    const originalSessionSet = chrome.storage.session.set;
    chrome.storage.session.set = vi.fn(async (items) => {
      if (Object.hasOwn(items, OVERLAY_PROJECTIONS_SESSION_KEY)) {
        projectionRegistryWrites.push(structuredClone(items[OVERLAY_PROJECTIONS_SESSION_KEY]));
        await originalSessionSet(items);
        if (terminalStoreMutations === 1 && deferProjectionPersistence) {
          deferProjectionPersistence = false;
          projectionPersistenceEntered.resolve(undefined);
          await releaseProjectionPersistence.promise;
        }
        return;
      }
      await originalSessionSet(items);
    });
    store.commitCapture = vi.fn(async (_token, committedRecord, authority) => {
      expect(authority?.isCurrent()).toBe(true);
      terminalStoreMutations += 1;
      return {
        ok: true,
        value: {
          itemId: committedRecord.attachment.id,
          label: "A",
          readback: createSessionReadback(committedRecord),
        },
      };
    });
    const controller = createBackgroundController({
      chrome,
      store,
      ensureContentScript: vi.fn(async () => true),
    });
    await activateTopFrameRuntimeCaptureRoute(controller, route);
    const sender = createTopFrameRuntimeCaptureSender(route);
    const begun = await dispatchRuntime(controller, {
      type: "ui-attach:session-begin-capture",
      replaceItemId: null,
    }, sender);
    if (!begun.ok) throw new Error(`capture begin failed: ${begun.code}`);
    const token = begun.data as RuntimeCaptureToken;
    const record = createCaptureRecord("route-a-persist", "Route A persisted target");
    record.pageUrl = route.url;
    record.attachment.source.url = route.url;
    chrome.runtime.sentMessages.length = 0;
    vi.mocked(chrome.tabs.sendMessage).mockClear();

    const commit = dispatchRuntime(controller, {
      type: "ui-attach:session-commit-capture",
      token,
      record,
    }, sender);
    await projectionPersistenceEntered.promise;
    route.url = `${ORIGIN}/spa/b`;
    releaseProjectionPersistence.resolve(undefined);

    await expect(commit).resolves.toMatchObject({
      ok: true,
      data: { itemId: record.attachment.id },
    });
    expect(terminalStoreMutations).toBe(1);
    expect(chrome.runtime.sentMessages).not.toContainEqual(expect.objectContaining({
      type: UI_ATTACH_SESSION_UPDATED,
    }));
    expect(vi.mocked(chrome.tabs.sendMessage).mock.calls.some(([, message]) => (
      isRecord(message) && message.type === UI_ATTACH_OVERLAY_STATE &&
      Array.isArray(message.items) && message.items.length > 0
    ))).toBe(false);
    const projectionWritesJson = JSON.stringify(projectionRegistryWrites);
    expect(projectionWritesJson).toContain(record.attachment.id);
    expect(projectionWritesJson).toContain('"pathname":"/spa/a"');
    expect(projectionWritesJson).not.toContain('"pathname":"/spa/b"');
    const projectionRegistry = await chrome.storage.session.get(OVERLAY_PROJECTIONS_SESSION_KEY);
    expect(JSON.stringify(projectionRegistry)).toContain(record.attachment.id);
    expect(JSON.stringify(projectionRegistry)).toContain('"pathname":"/spa/a"');
    expect(JSON.stringify(projectionRegistry)).not.toContain('"pathname":"/spa/b"');
    const activeItems = await chrome.storage.session.get(OVERLAY_ACTIVE_ITEMS_SESSION_KEY);
    expect(JSON.stringify(activeItems)).not.toContain(record.attachment.id);
    await controller.handleNavigationCommitted({
      tabId: route.tabId,
      frameId: 0,
      parentFrameId: -1,
      documentId: route.documentId,
      url: route.url,
    }, false);
    const postNavigationRegistry = await chrome.storage.session.get(
      OVERLAY_PROJECTIONS_SESSION_KEY,
    );
    expect(JSON.stringify(postNavigationRegistry)).not.toContain('"pathname":"/spa/b"');
  });

  test("does not bind a nested endpoint item when only its terminal route matches after ancestor navigation", async () => {
    const chrome = createChromeHarness();
    await chrome.storage.local.set({
      [OVERLAY_PROJECTION_AUTHORITY_GENERATION_KEY]: 1,
    });
    const store = createStoreHarness();
    const route = configureTopFrameRuntimeCaptureRoute(chrome, `${ORIGIN}/spa/a`);
    const originalGetFrame = chrome.webNavigation.getFrame;
    const originalGetAllFrames = chrome.webNavigation.getAllFrames;
    chrome.webNavigation.getFrame = vi.fn(async (details) => {
      if (details.tabId === 8 && details.frameId === 11) {
        return {
          frameId: 11,
          parentFrameId: 0,
          documentId: "other-child-document-01234567",
          url: `${ORIGIN}/shared-child`,
        };
      }
      return await originalGetFrame(details);
    });
    chrome.webNavigation.getAllFrames = vi.fn(async ({ tabId }) => tabId === 8
      ? [
          {
            frameId: 0,
            parentFrameId: -1,
            documentId: "other-top-document-01234567",
            url: `${ORIGIN}/host-b`,
          },
          {
            frameId: 11,
            parentFrameId: 0,
            documentId: "other-child-document-01234567",
            url: `${ORIGIN}/shared-child`,
          },
        ]
      : originalGetAllFrames({ tabId }));
    const otherOldRecord = createCaptureRecord("other-old-route", "Other old route target");
    otherOldRecord.origin = ORIGIN;
    otherOldRecord.pageUrl = `${ORIGIN}/shared-child`;
    otherOldRecord.attachment.source.url = otherOldRecord.pageUrl;
    otherOldRecord.tabId = 8;
    otherOldRecord.frameId = 11;
    otherOldRecord.routeChain = [
      { origin: ORIGIN, pathname: "/host-a" },
      { origin: ORIGIN, pathname: "/shared-child" },
    ];
    store.commitCapture = vi.fn(async (_token, committedRecord) => ({
      ok: true,
      value: {
        itemId: committedRecord.attachment.id,
        label: "B",
        readback: createSessionReadbackMany([otherOldRecord, committedRecord]),
      },
    }));
    const controller = createBackgroundController({
      chrome,
      store,
      ensureContentScript: vi.fn(async () => true),
    });
    await activateTopFrameRuntimeCaptureRoute(controller, route);
    const sender = createTopFrameRuntimeCaptureSender(route);
    const begun = await dispatchRuntime(controller, {
      type: "ui-attach:session-begin-capture",
      replaceItemId: null,
    }, sender);
    if (!begun.ok) throw new Error(`capture begin failed: ${begun.code}`);
    const record = createCaptureRecord("current-route", "Current route target");
    record.pageUrl = route.url;
    record.attachment.source.url = route.url;
    vi.mocked(chrome.tabs.sendMessage).mockClear();

    await expect(dispatchRuntime(controller, {
      type: "ui-attach:session-commit-capture",
      token: begun.data as RuntimeCaptureToken,
      record,
    }, sender)).resolves.toMatchObject({ ok: true });

    const otherEndpointStates = vi.mocked(chrome.tabs.sendMessage).mock.calls
      .filter(([tabId, message]) => tabId === 8 && isRecord(message) &&
        message.type === UI_ATTACH_OVERLAY_STATE)
      .map(([, message]) => message as { items?: Array<{ itemId?: string }> });
    expect(otherEndpointStates.length).toBeGreaterThan(0);
    expect(otherEndpointStates.every((message) => (
      !message.items?.some((item) => item.itemId === otherOldRecord.attachment.id)
    ))).toBe(true);
    const registry = await chrome.storage.session.get(OVERLAY_PROJECTIONS_SESSION_KEY);
    const registryJson = JSON.stringify(registry);
    expect(registryJson.includes('"pathname":"/shared-child"') &&
      registryJson.includes(otherOldRecord.attachment.id)).toBe(false);
  });

  test.each([
    ["matching full chain", "matching", true],
    ["missing chain", "missing", false],
    ["own undefined chain", "undefined", false],
    ["malformed chain", "malformed", false],
    ["empty chain", "empty", false],
    ["same terminal with another ancestor", "ancestor", false],
    ["over-bound chain", "over-bound", false],
  ] as const)("filters nested authority-bound records with %s", async (_name, variant, included) => {
    const chrome = createChromeHarness();
    await chrome.storage.local.set({
      [OVERLAY_PROJECTION_AUTHORITY_GENERATION_KEY]: 1,
    });
    const store = createStoreHarness();
    const route = configureTopFrameRuntimeCaptureRoute(chrome, `${ORIGIN}/spa/a`);
    const originalGetFrame = chrome.webNavigation.getFrame;
    const originalGetAllFrames = chrome.webNavigation.getAllFrames;
    const childDocumentId = "matrix-child-document-01234567";
    chrome.webNavigation.getFrame = vi.fn(async (details) => {
      if (details.tabId === 8 && details.frameId === 11) {
        return {
          frameId: 11,
          parentFrameId: 0,
          documentId: childDocumentId,
          url: `${ORIGIN}/shared-child`,
        };
      }
      return await originalGetFrame(details);
    });
    chrome.webNavigation.getAllFrames = vi.fn(async ({ tabId }) => tabId === 8
      ? [
          {
            frameId: 0,
            parentFrameId: -1,
            documentId: "matrix-top-document-01234567",
            url: `${ORIGIN}/host-b`,
          },
          {
            frameId: 11,
            parentFrameId: 0,
            documentId: childDocumentId,
            url: `${ORIGIN}/shared-child`,
          },
        ]
      : originalGetAllFrames({ tabId }));
    const nestedRecord = createCaptureRecord(`matrix-${variant}`, `Matrix ${variant}`);
    nestedRecord.origin = ORIGIN;
    nestedRecord.pageUrl = `${ORIGIN}/shared-child`;
    nestedRecord.attachment.source.url = nestedRecord.pageUrl;
    nestedRecord.tabId = 8;
    nestedRecord.frameId = 11;
    const untypedRecord = nestedRecord as OriginCaptureRecord & { routeChain?: unknown };
    switch (variant) {
      case "matching":
        nestedRecord.routeChain = [
          { origin: ORIGIN, pathname: "/host-b" },
          { origin: ORIGIN, pathname: "/shared-child" },
        ];
        break;
      case "missing":
        delete nestedRecord.routeChain;
        break;
      case "undefined":
        untypedRecord.routeChain = undefined;
        break;
      case "malformed":
        untypedRecord.routeChain = [
          { origin: ORIGIN, pathname: "/host-b" },
          { origin: ORIGIN, pathname: 7 },
        ];
        break;
      case "empty":
        nestedRecord.routeChain = [];
        break;
      case "ancestor":
        nestedRecord.routeChain = [
          { origin: ORIGIN, pathname: "/host-a" },
          { origin: ORIGIN, pathname: "/shared-child" },
        ];
        break;
      case "over-bound":
        nestedRecord.routeChain = Array.from({ length: 34 }, (_, index) => ({
          origin: ORIGIN,
          pathname: index === 33 ? "/shared-child" : `/ancestor-${index}`,
        }));
        break;
    }
    store.commitCapture = vi.fn(async (_token, committedRecord) => {
      const readback = createSessionReadbackMany([nestedRecord, committedRecord]);
      if (variant === "undefined") {
        Object.defineProperty(readback.file!.session.attachments[0]!.sourceRecord, "routeChain", {
          configurable: true,
          enumerable: true,
          value: undefined,
          writable: true,
        });
      }
      return {
        ok: true,
        value: {
          itemId: committedRecord.attachment.id,
          label: "B",
          readback,
        },
      };
    });
    const controller = createBackgroundController({
      chrome,
      store,
      ensureContentScript: vi.fn(async () => true),
    });
    await activateTopFrameRuntimeCaptureRoute(controller, route);
    const sender = createTopFrameRuntimeCaptureSender(route);
    const begun = await dispatchRuntime(controller, {
      type: "ui-attach:session-begin-capture",
      replaceItemId: null,
    }, sender);
    if (!begun.ok) throw new Error(`capture begin failed: ${begun.code}`);
    const currentRecord = createCaptureRecord(`matrix-current-${variant}`, "Current route target");
    currentRecord.pageUrl = route.url;
    currentRecord.attachment.source.url = route.url;
    vi.mocked(chrome.tabs.sendMessage).mockClear();

    await expect(dispatchRuntime(controller, {
      type: "ui-attach:session-commit-capture",
      token: begun.data as RuntimeCaptureToken,
      record: currentRecord,
    }, sender)).resolves.toMatchObject({ ok: true });

    const stateDelivery = vi.mocked(chrome.tabs.sendMessage).mock.calls.find(
      ([tabId, message, options]) => tabId === 8 && isRecord(message) &&
        message.type === UI_ATTACH_OVERLAY_STATE && options?.frameId === 11 &&
        options.documentId === childDocumentId,
    );
    expect(stateDelivery).toBeDefined();
    const state = stateDelivery?.[1] as {
      items?: Array<{ itemId?: string }>;
      projection?: { version?: unknown; projectionId?: unknown; revision?: unknown };
    };
    expect(state.items?.some((item) => item.itemId === nestedRecord.attachment.id) ?? false)
      .toBe(included);
    const registry = await chrome.storage.session.get(OVERLAY_PROJECTIONS_SESSION_KEY);
    const registryContainsItem = JSON.stringify(registry).includes(nestedRecord.attachment.id);
    expect(registryContainsItem).toBe(included);

    if (!included) {
      const projection = state.projection;
      if (!projection) throw new Error("empty nested projection was not delivered");
      const projectionRef = {
        version: projection.version,
        projectionId: projection.projectionId,
        revision: projection.revision,
      };
      const childSender: UiAttachChromeMessageSender = {
        url: `${ORIGIN}/shared-child`,
        frameId: 11,
        documentId: childDocumentId,
        tab: { id: 8, url: `${ORIGIN}/host-b`, windowId: 1 },
      };
      await expect(dispatchRuntime(controller, {
        type: UI_ATTACH_OVERLAY_PROJECTION_ACK,
        projection: projectionRef,
      }, childSender)).resolves.toMatchObject({ ok: true, data: { accepted: true } });
      vi.mocked(store.removeItem).mockClear();
      await expect(dispatchRuntime(controller, {
        type: UI_ATTACH_OVERLAY_ACTION_REQUEST,
        action: "remove",
        itemId: nestedRecord.attachment.id,
        projection: projectionRef,
      }, childSender)).resolves.toMatchObject({ ok: false });
      expect(store.removeItem).not.toHaveBeenCalled();
    }
  });

  test("fails closed when a nested authority-bound endpoint has no complete live route chain", async () => {
    const chrome = createChromeHarness();
    await chrome.storage.local.set({
      [OVERLAY_PROJECTION_AUTHORITY_GENERATION_KEY]: 1,
    });
    const store = createStoreHarness();
    const route = configureTopFrameRuntimeCaptureRoute(chrome, `${ORIGIN}/spa/a`);
    const originalGetFrame = chrome.webNavigation.getFrame;
    const originalGetAllFrames = chrome.webNavigation.getAllFrames;
    chrome.webNavigation.getFrame = vi.fn(async (details) => details.tabId === 8 &&
        details.frameId === 11
      ? {
          frameId: 11,
          parentFrameId: 0,
          documentId: "unreconstructable-child-document",
          url: `${ORIGIN}/shared-child`,
        }
      : originalGetFrame(details));
    chrome.webNavigation.getAllFrames = vi.fn(async ({ tabId }) => tabId === 8
      ? undefined
      : originalGetAllFrames({ tabId }));
    const nestedRecord = createCaptureRecord("unreconstructable", "Unreconstructable route");
    nestedRecord.origin = ORIGIN;
    nestedRecord.pageUrl = `${ORIGIN}/shared-child`;
    nestedRecord.attachment.source.url = nestedRecord.pageUrl;
    nestedRecord.tabId = 8;
    nestedRecord.frameId = 11;
    nestedRecord.routeChain = [
      { origin: ORIGIN, pathname: "/host-b" },
      { origin: ORIGIN, pathname: "/shared-child" },
    ];
    store.commitCapture = vi.fn(async (_token, committedRecord) => ({
      ok: true,
      value: {
        itemId: committedRecord.attachment.id,
        label: "B",
        readback: createSessionReadbackMany([nestedRecord, committedRecord]),
      },
    }));
    const controller = createBackgroundController({
      chrome,
      store,
      ensureContentScript: vi.fn(async () => true),
    });
    await activateTopFrameRuntimeCaptureRoute(controller, route);
    const sender = createTopFrameRuntimeCaptureSender(route);
    const begun = await dispatchRuntime(controller, {
      type: "ui-attach:session-begin-capture",
      replaceItemId: null,
    }, sender);
    if (!begun.ok) throw new Error(`capture begin failed: ${begun.code}`);
    const currentRecord = createCaptureRecord("live-route-current", "Current route target");
    currentRecord.pageUrl = route.url;
    currentRecord.attachment.source.url = route.url;
    vi.mocked(chrome.tabs.sendMessage).mockClear();

    await expect(dispatchRuntime(controller, {
      type: "ui-attach:session-commit-capture",
      token: begun.data as RuntimeCaptureToken,
      record: currentRecord,
    }, sender)).resolves.toMatchObject({ ok: true });

    expect(vi.mocked(chrome.tabs.sendMessage).mock.calls.some(([tabId, message]) =>
      tabId === 8 && JSON.stringify(message).includes(nestedRecord.attachment.id)))
      .toBe(false);
    const registry = await chrome.storage.session.get(OVERLAY_PROJECTIONS_SESSION_KEY);
    expect(JSON.stringify(registry)).not.toContain(nestedRecord.attachment.id);
  });

  test("keeps a route-bound capture current across query and hash-only navigation", async () => {
    const chrome = createChromeHarness();
    const store = createStoreHarness();
    const route = configureTopFrameRuntimeCaptureRoute(
      chrome,
      `${ORIGIN}/spa/a?before=1#old`,
    );
    const beforeWriteEntered = createDeferred<void>();
    const releaseBeforeWrite = createDeferred<void>();
    let terminalStoreMutations = 0;
    const commitCapture: ExtensionSessionStore["commitCapture"] = async (
      _token,
      committedRecord,
      authority,
    ) => {
      expect(authority?.isCurrent()).toBe(true);
      await authority?.beforeWrite?.();
      if (!authority?.isCurrent()) {
        return {
          ok: false,
          code: "STALE_CAPTURE_OPERATION",
          error: "Capture operation is stale.",
        };
      }
      terminalStoreMutations += 1;
      return {
        ok: true,
        value: {
          itemId: committedRecord.attachment.id,
          label: "A",
          readback: createSessionReadback(committedRecord),
        },
      };
    };
    store.commitCapture = vi.fn(commitCapture);
    const controller = createBackgroundController({
      chrome,
      store,
      ensureContentScript: vi.fn(async () => true),
      captureCommitGate: {
        beforeWrite: async () => {
          beforeWriteEntered.resolve(undefined);
          await releaseBeforeWrite.promise;
        },
        afterWrite: async () => undefined,
      },
    });
    await activateTopFrameRuntimeCaptureRoute(controller, route);
    const sender = createTopFrameRuntimeCaptureSender(route);
    const begun = await dispatchRuntime(controller, {
      type: "ui-attach:session-begin-capture",
      replaceItemId: null,
    }, sender);
    if (!begun.ok) throw new Error(`capture begin failed: ${begun.code}`);
    const token = begun.data as RuntimeCaptureToken;
    const record = createCaptureRecord("route-a-query", "Route A query target");
    record.pageUrl = route.url;
    record.attachment.source.url = route.url;

    const commit = dispatchRuntime(controller, {
      type: "ui-attach:session-commit-capture",
      token,
      record,
    }, sender);
    await beforeWriteEntered.promise;
    route.url = `${ORIGIN}/spa/a?after=2#new`;
    const navigation = controller.handleNavigationCommitted({
      tabId: route.tabId,
      frameId: 0,
      parentFrameId: -1,
      documentId: route.documentId,
      url: route.url,
    });
    releaseBeforeWrite.resolve(undefined);

    await expect(commit).resolves.toMatchObject({
      ok: true,
      data: { itemId: record.attachment.id },
    });
    await navigation;
    expect(terminalStoreMutations).toBe(1);
    expect(chrome.runtime.sentMessages).toContainEqual({
      type: UI_ATTACH_SESSION_UPDATED,
      origin: ORIGIN,
      itemId: record.attachment.id,
    });
  });

  test("rejects an old worker route token when a new controller has no matching active lease", async () => {
    const chrome = createChromeHarness();
    const store = createStoreHarness();
    const route = configureTopFrameRuntimeCaptureRoute(chrome, `${ORIGIN}/spa/a`);
    const oldController = createBackgroundController({
      chrome,
      store,
      ensureContentScript: vi.fn(async () => true),
    });
    await activateTopFrameRuntimeCaptureRoute(oldController, route);
    const sender = createTopFrameRuntimeCaptureSender(route);
    const begun = await dispatchRuntime(oldController, {
      type: "ui-attach:session-begin-capture",
      replaceItemId: null,
    }, sender);
    if (!begun.ok) throw new Error(`capture begin failed: ${begun.code}`);
    const token = begun.data as RuntimeCaptureToken;
    const newController = createBackgroundController({
      chrome,
      store,
      ensureContentScript: vi.fn(async () => true),
    });
    await activateTopFrameRuntimeCaptureRoute(newController, route);
    vi.mocked(store.commitCapture).mockClear();
    const record = createCaptureRecord("new-worker", "New worker target");
    record.pageUrl = route.url;
    record.attachment.source.url = route.url;

    await expect(dispatchRuntime(newController, {
      type: "ui-attach:session-commit-capture",
      token,
      record,
    }, sender)).resolves.toMatchObject({
      ok: false,
      code: "STALE_CAPTURE_OPERATION",
    });
    expect(store.commitCapture).not.toHaveBeenCalled();
  });

  test("rejects a legacy capture token without route authority at the command parser", async () => {
    const chrome = createChromeHarness();
    const store = createStoreHarness();
    const controller = createBackgroundController({ chrome, store });

    await expect(dispatchRuntime(controller, {
      type: "ui-attach:session-commit-capture",
      token: TOKEN,
      record: createCaptureRecord("legacy-token", "Legacy token target"),
    }, createSender(`${ORIGIN}/settings`))).resolves.toMatchObject({
      ok: false,
      code: "INVALID_COMMAND",
      issues: expect.arrayContaining([
        { path: "token.routeLease", message: expect.any(String) },
      ]),
    });
    expect(store.commitCapture).not.toHaveBeenCalled();
  });

  test("rejects missing, malformed, and over-bound route authority branches at the parser", async () => {
    const chrome = createChromeHarness();
    const store = createStoreHarness();
    const controller = createBackgroundController({ chrome, store });
    const sender = createSender(`${ORIGIN}/settings`);
    const topSegment = RUNTIME_TOKEN.routeLease.segments[0]!;
    const cases: Array<{ token: unknown; issuePath: string }> = [
      {
        token: { ...RUNTIME_TOKEN, routeLease: undefined },
        issuePath: "token.routeLease",
      },
      {
        token: { ...RUNTIME_TOKEN, routeLease: [] },
        issuePath: "token.routeLease",
      },
      {
        token: {
          ...RUNTIME_TOKEN,
          routeLease: { ...RUNTIME_TOKEN.routeLease, extra: true },
        },
        issuePath: "token.routeLease",
      },
      {
        token: {
          ...RUNTIME_TOKEN,
          routeLease: { ...RUNTIME_TOKEN.routeLease, segments: [] },
        },
        issuePath: "token.routeLease.segments",
      },
      {
        token: {
          ...RUNTIME_TOKEN,
          routeLease: {
            ...RUNTIME_TOKEN.routeLease,
            segments: [{ ...topSegment, documentId: "" }],
          },
        },
        issuePath: "token.routeLease.segments[0].documentId",
      },
      {
        token: {
          ...RUNTIME_TOKEN,
          routeLease: {
            ...RUNTIME_TOKEN.routeLease,
            segments: [{ ...topSegment, pathname: "/settings?mode=stale" }],
          },
        },
        issuePath: "token.routeLease.segments[0].pathname",
      },
      {
        token: {
          ...RUNTIME_TOKEN,
          routeLease: {
            ...RUNTIME_TOKEN.routeLease,
            segments: [
              topSegment,
              { ...topSegment, documentId: "document-2" },
            ],
          },
        },
        issuePath: "token.routeLease.segments[1].frameId",
      },
      {
        token: {
          ...RUNTIME_TOKEN,
          routeLease: {
            ...RUNTIME_TOKEN.routeLease,
            selectedFrameId: 33,
            segments: Array.from({ length: 34 }, (_, frameId) => ({
              frameId,
              documentId: `document-${frameId}`,
              origin: ORIGIN,
              pathname: "/settings",
            })),
          },
        },
        issuePath: "token.routeLease.segments",
      },
    ];

    for (const { token, issuePath } of cases) {
      await expect(dispatchRuntime(controller, {
        type: "ui-attach:session-commit-capture",
        token,
        record: createCaptureRecord("invalid-route-lease", "Invalid route lease"),
      }, sender)).resolves.toMatchObject({
        ok: false,
        code: "INVALID_COMMAND",
        issues: expect.arrayContaining([
          { path: issuePath, message: expect.any(String) },
        ]),
      });
    }
    expect(store.commitCapture).not.toHaveBeenCalled();
  });

  test("projects a committed SPA capture only into the sender's exact live route", async () => {
    const chrome = createChromeHarness();
    const store = createStoreHarness();
    const routeA = createCaptureRecord("route-a", "Route A target");
    routeA.pageUrl = `${ORIGIN}/spa/a`;
    routeA.tabId = 7;
    routeA.frameId = 0;
    const routeB = createCaptureRecord("route-b", "Route B target");
    routeB.pageUrl = `${ORIGIN}/spa/b`;
    const controller = createBackgroundController({ chrome, store });
    chrome.tabs.query = vi.fn(async () => [{ id: 7, url: `${ORIGIN}/spa/b`, windowId: 1 }]);
    chrome.webNavigation.getAllFrames = vi.fn(async () => [{
      frameId: 0,
      parentFrameId: -1,
      url: `${ORIGIN}/spa/b`,
      documentId: "spa-document-01234567",
    }]);
    store.commitCapture = vi.fn(async (_token, committedRecord) => ({
      ok: true,
      value: {
        itemId: "att_route-b",
        label: "B",
        readback: createSessionReadbackMany([routeA, committedRecord]),
      },
    }));
    await dispatchRuntime(
      controller,
      { type: "ui-attach:element-selection-set", enabled: true, tabId: 7 },
      createExtensionSender(),
    );
    const staleDocumentUrlSender = {
      ...createSender(`${ORIGIN}/spa/a`),
      documentId: "spa-document-01234567",
      tab: { id: 7, url: `${ORIGIN}/spa/b`, windowId: 1 },
    };
    const begun = await dispatchRuntime(controller, {
      type: "ui-attach:session-begin-capture",
      replaceItemId: null,
    }, staleDocumentUrlSender);
    if (!begun.ok) throw new Error("capture begin failed");
    let postCommitFrameInventoryReads = 0;
    chrome.webNavigation.getAllFrames = vi.fn(async () => {
      postCommitFrameInventoryReads += 1;
      return postCommitFrameInventoryReads < 3
        ? undefined
        : [{
            frameId: 0,
            parentFrameId: -1,
            url: `${ORIGIN}/spa/b`,
            documentId: "spa-document-01234567",
          }];
    });
    chrome.webNavigation.getFrame = vi.fn(async ({ frameId }) => frameId === 0
      ? {
          parentFrameId: -1,
          url: `${ORIGIN}/spa/b`,
          documentId: "spa-document-01234567",
        }
      : undefined);
    vi.mocked(chrome.tabs.sendMessage).mockClear();

    await expect(dispatchRuntime(controller, {
      type: "ui-attach:session-commit-capture",
      token: begun.data,
      record: routeB,
    }, staleDocumentUrlSender)).resolves.toMatchObject({
      ok: true,
      data: { itemId: "att_route-b" },
    });

    const delivered = vi.mocked(chrome.tabs.sendMessage).mock.calls
      .map(([, message]) => message)
      .find(isOverlayStateMessage);
    expect(delivered).toMatchObject({
      projection: {
        subject: {
          tabId: 7,
          frameId: 0,
          documentId: "spa-document-01234567",
          origin: ORIGIN,
          pathname: "/spa/b",
        },
      },
      activeItemId: "att_route-b",
      items: [{ itemId: "att_route-b" }],
    });
    expect(postCommitFrameInventoryReads).toBeGreaterThanOrEqual(3);
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
    const liveFrames = [{
      frameId: 0,
      parentFrameId: -1,
      url: `${ORIGIN}/host`,
      documentId: "top-doc",
    }, {
      frameId: 3,
      parentFrameId: 0,
      url: `${OTHER_ORIGIN}/embedded`,
      documentId: "frame-doc",
    }];
    chrome.webNavigation.getAllFrames = vi.fn(async () => liveFrames);
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
      replaceItemId: null,
    }, sender);
    if (!begun.ok) throw new Error("capture begin failed");
    chrome.webNavigation.getAllFrames = vi.fn()
      .mockResolvedValueOnce(liveFrames)
      .mockResolvedValueOnce(undefined)
      .mockResolvedValue(liveFrames);
    store.commitCapture = vi.fn(async (_token, committedRecord) => {
      return {
        ok: true,
        value: {
          itemId: committedRecord.attachment.id,
          label: "A",
          readback: createReadback(committedRecord),
        },
      };
    });
    const committed = await dispatchRuntime(controller, {
      type: "ui-attach:session-commit-capture",
      token: begun.data,
      record,
    }, sender);

    expect(store.beginCapture).toHaveBeenCalledWith(OTHER_ORIGIN, null);
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
    expect(store.commitCapture).toHaveBeenCalledWith(expect.objectContaining(frameToken), {
      ...record,
      tabId: 7,
      frameId: 3,
      routeChain: [
        { origin: ORIGIN, pathname: "/host" },
        { origin: OTHER_ORIGIN, pathname: "/embedded" },
      ],
    }, expect.any(Object));
  });

  test("persists the validated nested runtime route chain through every real-store readback", async () => {
    const chrome = createChromeHarness();
    const ids = ["epoch-real-nested", "operation-real-nested"];
    const store = createExtensionSessionStore({
      storage: chrome.storage.local,
      now: () => new Date("2026-08-24T05:00:00.000Z"),
      randomUUID: () => ids.shift() ?? "unexpected-real-nested-id",
    });
    const controller = createBackgroundController({ chrome, store });
    chrome.tabs.query = vi.fn(async () => [{ id: 7, url: `${ORIGIN}/host`, windowId: 1 }]);
    chrome.tabs.sendMessage = vi.fn(async () => undefined);
    const routeChain = [
      { origin: ORIGIN, pathname: "/host" },
      { origin: OTHER_ORIGIN, pathname: "/embedded" },
    ];
    const liveFrames = [{
      frameId: 0,
      parentFrameId: -1,
      url: `${ORIGIN}/host`,
      documentId: "top-doc",
    }, {
      frameId: 3,
      parentFrameId: 0,
      url: `${OTHER_ORIGIN}/embedded`,
      documentId: "frame-doc",
    }];
    chrome.webNavigation.getAllFrames = vi.fn(async ({ tabId }) => tabId === 7 ? liveFrames : []);
    chrome.webNavigation.getFrame = vi.fn(async ({ tabId, frameId }) => {
      const frame = tabId === 7
        ? liveFrames.find((candidate) => candidate.frameId === frameId)
        : undefined;
      return frame
        ? { parentFrameId: frame.parentFrameId, url: frame.url, documentId: frame.documentId }
        : undefined;
    });
    await expect(dispatchRuntime(
      controller,
      embeddedFrameSelectionCommand({
        pagePathname: "/host",
        frameOrigin: OTHER_ORIGIN,
      }),
      createExtensionSender(),
    )).resolves.toMatchObject({ ok: true });
    const sender: UiAttachChromeMessageSender & { url: string } = {
      documentId: "frame-doc",
      frameId: 3,
      url: `${OTHER_ORIGIN}/embedded`,
      tab: { id: 7, url: `${ORIGIN}/host` },
    };
    const begun = await dispatchRuntime(controller, {
      type: "ui-attach:session-begin-capture",
      replaceItemId: null,
    }, sender);
    if (!begun.ok) throw new Error(`capture begin failed: ${begun.code}`);
    const record = createCaptureRecord("frame-action", "Frame action");
    record.origin = OTHER_ORIGIN;
    record.pageUrl = `${OTHER_ORIGIN}/embedded`;
    record.attachment.source.url = record.pageUrl;
    record.attachment.policy.allowedDomains = [OTHER_ORIGIN];
    delete record.routeChain;
    expect(Object.hasOwn(record, "routeChain")).toBe(false);

    const committed = await dispatchRuntime(controller, {
      type: "ui-attach:session-commit-capture",
      token: begun.data,
      record,
    }, sender);

    expect(committed).toMatchObject({ ok: true, data: { origin: OTHER_ORIGIN } });
    expect(Object.hasOwn(record, "routeChain")).toBe(false);
    const freshStore = createExtensionSessionStore({ storage: chrome.storage.local });
    const durable = await freshStore.read(OTHER_ORIGIN);
    expect(durable).toMatchObject({ ok: true });
    if (!durable.ok) throw new Error(durable.error);
    const canonicalRecord = durable.value.file?.session.attachments[0]?.sourceRecord;
    expect(canonicalRecord).toMatchObject({
      origin: OTHER_ORIGIN,
      tabId: 7,
      frameId: 3,
      routeChain,
    });
    expect(durable.value.legacyRecord).toMatchObject({ routeChain });
    const raw = await chrome.storage.local.get(null);
    expect(raw[`ui-attach:session:v1:${OTHER_ORIGIN}`]).toMatchObject({
      session: {
        attachments: [{ sourceRecord: { routeChain } }],
      },
    });
    expect(raw[`ui-attach:capture:${OTHER_ORIGIN}`]).toMatchObject({ routeChain });
    expect(raw["ui-attach:capture:latest"]).toMatchObject({ routeChain });
  });

  test("binds one-shot coarse diagnostics to the exact durable session across controller restart", async () => {
    const chrome = createChromeHarness();
    const route = configureTopFrameRuntimeCaptureRoute(chrome, `${ORIGIN}/settings`);
    let id = 0;
    const store = createExtensionSessionStore({
      storage: chrome.storage.local,
      now: () => new Date("2026-08-30T06:00:00.000Z"),
      randomUUID: () => `diagnostics-runtime-${++id}`,
    });
    const onActiveSessionChanged = vi.fn(async (_data: ActiveSessionCommandData) => undefined);
    const controller = createBackgroundController({ chrome, store, onActiveSessionChanged });
    const sender = createTopFrameRuntimeCaptureSender(route);
    const record = createCaptureRecord("diagnostics-runtime", "Diagnostics runtime target");
    record.pageUrl = route.url;
    record.attachment.source.url = route.url;

    await expect(dispatchRuntime(controller, {
      type: "ui-attach:element-selection-set",
      enabled: true,
      tabId: route.tabId,
      collectBasicDiagnostics: true,
    }, createExtensionSender())).resolves.toEqual({ ok: true, data: { enabled: true } });
    const begun = await dispatchRuntime(controller, {
      type: "ui-attach:session-begin-capture",
      replaceItemId: null,
    }, sender);
    if (!begun.ok) throw new Error(`capture begin failed: ${begun.code}`);

    await expect(dispatchRuntime(controller, {
      type: "ui-attach:session-commit-capture",
      token: begun.data,
      record,
      metadataDiagnosticsDevice: {
        status: "collected",
        deviceClass: "desktop",
        viewportClass: "large",
        touch: "coarse",
      },
    }, sender)).resolves.toMatchObject({
      ok: true,
      data: { itemId: record.attachment.id },
    });

    const durable = await store.read(ORIGIN);
    if (!durable.ok || !durable.value.file) throw new Error("durable capture readback failed");
    const diagnosticsKey = getMetadataDiagnosticsSessionStorageKey(ORIGIN);
    const binding = (await chrome.storage.session.get(diagnosticsKey))[diagnosticsKey];
    expect(binding).toEqual({
      schemaVersion: "0.1.0",
      kind: "ui-attach.metadata-diagnostics-session-binding",
      origin: ORIGIN,
      epoch: durable.value.epoch,
      observedItemId: record.attachment.id,
      fingerprint: [{
        itemId: record.attachment.id,
        capturedAt: record.capturedAt,
      }],
      sidecar: {
        schemaVersion: "0.1.0",
        kind: "ui-attach.metadata-only-diagnostics",
        captureId: durable.value.file.session.id,
        scope: "capture",
        observedAt: record.capturedAt,
        consent: "explicit_capture",
        authority: "capture_time",
        replay: {
          status: "collected",
          attemptCount: 0,
          verifiedCount: 0,
          ambiguousCount: 0,
          missingCount: 0,
        },
        device: {
          status: "collected",
          deviceClass: "desktop",
          viewportClass: "large",
          touch: "coarse",
        },
        network: { status: "not_requested" },
        console: { status: "not_requested" },
        executionAuthority: {
          grantedByCapture: false,
          browserControl: false,
          liveDomMutation: false,
        },
      },
    });
    expect(JSON.stringify(binding)).not.toMatch(
      /viewportWidth|touchPoints|userAgent|pageUrl|localPath|1920/u,
    );

    const active = await dispatchRuntime(controller, {
      type: "ui-attach:session-get-active",
    }, createExtensionSender());
    expect(active).toMatchObject({
      ok: true,
      data: {
        metadataDiagnostics: {
          captureId: durable.value.file.session.id,
          device: {
            status: "collected",
            deviceClass: "desktop",
            viewportClass: "large",
            touch: "coarse",
          },
        },
      },
    });

    onActiveSessionChanged.mockClear();
    await expect(dispatchRuntime(controller, {
      type: "ui-attach:session-update-intent",
      origin: ORIGIN,
      epoch: durable.value.epoch,
      itemId: record.attachment.id,
      intent: "Keep the capture-bound diagnostics",
    }, createExtensionSender())).resolves.toMatchObject({ ok: true });
    expect(onActiveSessionChanged).toHaveBeenLastCalledWith(expect.objectContaining({
      metadataDiagnostics: expect.objectContaining({
        captureId: durable.value.file.session.id,
        device: {
          status: "collected",
          deviceClass: "desktop",
          viewportClass: "large",
          touch: "coarse",
        },
      }),
    }));

    const restartedController = createBackgroundController({ chrome, store });
    await expect(dispatchRuntime(restartedController, {
      type: "ui-attach:session-get-active",
    }, createExtensionSender())).resolves.toMatchObject({
      ok: true,
      data: {
        metadataDiagnostics: {
          captureId: durable.value.file.session.id,
          device: { status: "collected" },
        },
      },
    });

    route.url = `${ORIGIN}/other-page`;
    const otherPage = await dispatchRuntime(restartedController, {
      type: "ui-attach:session-get-active",
    }, createExtensionSender());
    expect(otherPage).toMatchObject({
      ok: true,
      data: { activePage: { origin: ORIGIN, pathname: "/other-page" } },
    });
    if (!otherPage.ok) throw new Error(otherPage.error);
    expect(Object.hasOwn(otherPage.data, "metadataDiagnostics")).toBe(false);

    route.url = `${ORIGIN}/settings`;
    await expect(dispatchRuntime(restartedController, {
      type: "ui-attach:session-get-active",
    }, createExtensionSender())).resolves.toMatchObject({
      ok: true,
      data: {
        activePage: { origin: ORIGIN, pathname: "/settings" },
        metadataDiagnostics: {
          captureId: durable.value.file.session.id,
          device: { status: "collected" },
        },
      },
    });

    await expect(dispatchRuntime(controller, {
      type: "ui-attach:element-selection-set",
      enabled: true,
      tabId: route.tabId,
    }, createExtensionSender())).resolves.toEqual({ ok: true, data: { enabled: true } });
    const unarmed = await dispatchRuntime(controller, {
      type: "ui-attach:session-begin-capture",
      replaceItemId: null,
    }, sender);
    if (!unarmed.ok) throw new Error(`unarmed capture begin failed: ${unarmed.code}`);
    expect(Object.hasOwn(unarmed.data, "collectBasicDiagnostics")).toBe(false);
    const nextRecord = createCaptureRecord("diagnostics-next", "Unarmed next target");
    nextRecord.pageUrl = route.url;
    nextRecord.attachment.source.url = route.url;
    await expect(dispatchRuntime(controller, {
      type: "ui-attach:session-commit-capture",
      token: unarmed.data,
      record: nextRecord,
    }, sender)).resolves.toMatchObject({ ok: true });

    expect((await chrome.storage.session.get(diagnosticsKey))[diagnosticsKey]).toBeUndefined();
    const afterUnarmedCapture = await dispatchRuntime(controller, {
      type: "ui-attach:session-get-active",
    }, createExtensionSender());
    expect(afterUnarmedCapture).toMatchObject({ ok: true });
    if (!afterUnarmedCapture.ok) throw new Error(afterUnarmedCapture.error);
    expect(Object.hasOwn(afterUnarmedCapture.data, "metadataDiagnostics")).toBe(false);
  });

  test("fails closed and retries diagnostics cleanup after an item removal already committed", async () => {
    const chrome = createChromeHarness();
    const route = configureTopFrameRuntimeCaptureRoute(chrome, `${ORIGIN}/settings`);
    let id = 0;
    const store = createExtensionSessionStore({
      storage: chrome.storage.local,
      now: () => new Date("2026-08-30T06:00:00.000Z"),
      randomUUID: () => `diagnostics-remove-${++id}`,
    });
    const onActiveSessionChanged = vi.fn(async (_data: ActiveSessionCommandData) => undefined);
    const controller = createBackgroundController({ chrome, store, onActiveSessionChanged });
    const sender = createTopFrameRuntimeCaptureSender(route);
    const record = createCaptureRecord("diagnostics-remove", "Diagnostics removal target");
    record.pageUrl = route.url;
    record.attachment.source.url = route.url;

    await expect(dispatchRuntime(controller, {
      type: "ui-attach:element-selection-set",
      enabled: true,
      tabId: route.tabId,
      collectBasicDiagnostics: true,
    }, createExtensionSender())).resolves.toEqual({ ok: true, data: { enabled: true } });
    const begun = await dispatchRuntime(controller, {
      type: "ui-attach:session-begin-capture",
      replaceItemId: null,
    }, sender);
    if (!begun.ok) throw new Error(`capture begin failed: ${begun.code}`);
    await expect(dispatchRuntime(controller, {
      type: "ui-attach:session-commit-capture",
      token: begun.data,
      record,
      metadataDiagnosticsDevice: {
        status: "collected",
        deviceClass: "desktop",
        viewportClass: "large",
        touch: "none",
      },
    }, sender)).resolves.toMatchObject({ ok: true });

    const durable = await store.read(ORIGIN);
    if (!durable.ok || !durable.value.file || !durable.value.epoch) {
      throw new Error("durable capture readback failed");
    }
    const diagnosticsKey = getMetadataDiagnosticsSessionStorageKey(ORIGIN);
    expect((await chrome.storage.session.get(diagnosticsKey))[diagnosticsKey]).toBeDefined();

    const originalSessionRemove = chrome.storage.session.remove;
    let rejectDiagnosticsCleanup = true;
    chrome.storage.session.remove = vi.fn(async (keys) => {
      const removesDiagnostics = Array.isArray(keys)
        ? keys.includes(diagnosticsKey)
        : keys === diagnosticsKey;
      if (rejectDiagnosticsCleanup && removesDiagnostics) {
        rejectDiagnosticsCleanup = false;
        throw new Error("simulated diagnostics cleanup failure");
      }
      await originalSessionRemove(keys);
    });
    onActiveSessionChanged.mockClear();

    const command = {
      type: "ui-attach:session-remove-item" as const,
      origin: ORIGIN,
      epoch: durable.value.epoch,
      itemId: record.attachment.id,
    };
    await expect(dispatchRuntime(controller, command, createExtensionSender())).resolves.toMatchObject({
      ok: false,
      code: "STORAGE_ERROR",
    });
    const afterRejectedCleanup = await store.read(ORIGIN);
    expect(afterRejectedCleanup).toMatchObject({
      ok: true,
      value: { file: { session: { attachments: [] } } },
    });
    expect((await chrome.storage.session.get(diagnosticsKey))[diagnosticsKey]).toBeDefined();
    expect(onActiveSessionChanged).not.toHaveBeenCalled();

    await expect(dispatchRuntime(controller, {
      type: "ui-attach:element-selection-set",
      enabled: true,
      tabId: route.tabId,
      collectBasicDiagnostics: true,
    }, createExtensionSender())).resolves.toEqual({ ok: true, data: { enabled: true } });
    const replacementBegun = await dispatchRuntime(controller, {
      type: "ui-attach:session-begin-capture",
      replaceItemId: null,
    }, sender);
    if (!replacementBegun.ok) throw new Error(`replacement capture begin failed: ${replacementBegun.code}`);
    const replacement = createCaptureRecord("diagnostics-replacement", "Replacement diagnostics target");
    replacement.pageUrl = route.url;
    replacement.attachment.source.url = route.url;
    await expect(dispatchRuntime(controller, {
      type: "ui-attach:session-commit-capture",
      token: replacementBegun.data,
      record: replacement,
      metadataDiagnosticsDevice: {
        status: "collected",
        deviceClass: "desktop",
        viewportClass: "large",
        touch: "none",
      },
    }, sender)).resolves.toMatchObject({ ok: true });
    const replacementBinding = (await chrome.storage.session.get(diagnosticsKey))[diagnosticsKey];
    expect(replacementBinding).toMatchObject({
      observedItemId: replacement.attachment.id,
      fingerprint: [{ itemId: replacement.attachment.id }],
    });
    onActiveSessionChanged.mockClear();

    await expect(dispatchRuntime(controller, command, createExtensionSender())).resolves.toMatchObject({
      ok: true,
      data: { file: { session: { attachments: [{ id: replacement.attachment.id }] } } },
    });
    expect((await chrome.storage.session.get(diagnosticsKey))[diagnosticsKey]).toEqual(replacementBinding);
    expect(onActiveSessionChanged).toHaveBeenCalledOnce();
  });

  test("panel mutations delegate to the store and tab changes publish active origin only", async () => {
    const chrome = createChromeHarness();
    const store = createStoreHarness();
    const controller = createBackgroundController({ chrome, store });
    const readback = createReadback(createCaptureRecord("save", "Save changes"));
    store.updateIntent = vi.fn(async () => ({ ok: true, value: readback }));
    store.removeItem = vi.fn(async () => ({ ok: true, value: readback }));

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
    const clear = await dispatchRuntime(controller, {
      type: "ui-attach:session-clear",
      origin: ORIGIN,
      epoch: "epoch-1",
      operationId: "clear-1",
    }, createExtensionSender());

    expect(store.updateIntent).toHaveBeenCalledWith(ORIGIN, "epoch-1", "att_save", "Explain save");
    expect(store.removeItem).toHaveBeenCalledWith(ORIGIN, "epoch-1", "att_save");
    expect(clear).toMatchObject({ ok: false, code: "ACTIVE_PAGE_UNAVAILABLE" });
    expect(store.clearOrigins).not.toHaveBeenCalled();

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

  test("reconciles durable panel intent and removal mutations into the active Agent projection", async () => {
    const chrome = createChromeHarness();
    configureSingleClearPage(chrome);
    const store = createStoreHarness();
    const updatedRecord = createCaptureRecord("save", "Save changes");
    updatedRecord.tabId = 7;
    updatedRecord.frameId = 0;
    updatedRecord.pageUrl = `${ORIGIN}/settings`;
    updatedRecord.attachment.source.url = updatedRecord.pageUrl;
    updatedRecord.intent = "Explain save";
    const updatedReadback = createSessionReadback(updatedRecord);
    const removedReadback = createSessionReadbackMany([]);
    let currentReadback = updatedReadback;
    store.read = vi.fn(async () => ({ ok: true, value: currentReadback }));
    store.updateIntent = vi.fn(async () => {
      currentReadback = updatedReadback;
      return { ok: true, value: updatedReadback };
    });
    store.removeItem = vi.fn(async () => {
      currentReadback = removedReadback;
      return { ok: true, value: removedReadback };
    });
    const publishedInputs: LocalAgentBridgePublishInput[] = [];
    const publisher = createLocalAgentBridgeSessionPublisher({
      publishSessionContext: vi.fn(async (input) => {
        publishedInputs.push(structuredClone(input));
        return true;
      }),
      clearSessionContext: vi.fn(async () => undefined),
    });
    const onActiveSessionChanged = vi.fn((data: ActiveSessionCommandData) =>
      publisher.reconcile(data));
    const controller = createBackgroundController({
      chrome,
      store,
      onActiveSessionChanged,
    });

    await expect(dispatchRuntime(controller, {
      type: "ui-attach:session-update-intent",
      origin: ORIGIN,
      epoch: "epoch-1",
      itemId: updatedRecord.attachment.id,
      intent: "Explain save",
    }, createExtensionSender())).resolves.toMatchObject({ ok: true });
    expect(onActiveSessionChanged).toHaveBeenLastCalledWith(expect.objectContaining({
      enabled: true,
      origin: ORIGIN,
      readback: expect.objectContaining({
        file: expect.objectContaining({
          session: expect.objectContaining({
            attachments: [expect.objectContaining({
              sourceRecord: expect.objectContaining({ intent: "Explain save" }),
            })],
          }),
        }),
      }),
    }));
    expect(publishedInputs.at(-1)).toMatchObject({
      attachmentCount: 1,
      capture: {
        targets: [{
          attachmentId: updatedRecord.attachment.id,
          taskNote: "Explain save",
        }],
      },
    });

    await expect(dispatchRuntime(controller, {
      type: "ui-attach:session-remove-item",
      origin: ORIGIN,
      epoch: "epoch-1",
      itemId: updatedRecord.attachment.id,
    }, createExtensionSender())).resolves.toMatchObject({ ok: true });
    expect(onActiveSessionChanged).toHaveBeenCalledTimes(2);
    expect(onActiveSessionChanged).toHaveBeenLastCalledWith(expect.objectContaining({
      enabled: true,
      origin: ORIGIN,
      readback: expect.objectContaining({
        file: expect.objectContaining({
          session: expect.objectContaining({ attachments: [] }),
        }),
      }),
    }));
    expect(publishedInputs.at(-1)).toMatchObject({
      attachmentCount: 0,
      agentCopy: null,
    });
  });

  test("keeps a durable panel intent mutation successful when Agent publication fails", async () => {
    const chrome = createChromeHarness();
    configureSingleClearPage(chrome);
    const record = createCaptureRecord("save", "Save changes");
    record.intent = "Explain save";
    const readback = createSessionReadback(record);
    const store = createStoreHarness();
    store.read = vi.fn(async () => ({ ok: true, value: readback }));
    store.updateIntent = vi.fn(async () => ({ ok: true, value: readback }));
    const onActiveSessionChanged = vi.fn(async () => {
      throw new Error("Agent owner unavailable");
    });
    const controller = createBackgroundController({
      chrome,
      store,
      onActiveSessionChanged,
    });

    await expect(dispatchRuntime(controller, {
      type: "ui-attach:session-update-intent",
      origin: ORIGIN,
      epoch: "epoch-1",
      itemId: record.attachment.id,
      intent: "Explain save",
    }, createExtensionSender())).resolves.toMatchObject({ ok: true });
    expect(onActiveSessionChanged).toHaveBeenCalledOnce();
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
    chrome.webNavigation.getFrame = vi.fn(async ({ tabId, frameId }) =>
      tabId === 7 && frameId === 0
        ? { documentId: "sync-document", parentFrameId: -1, url: `${ORIGIN}/settings` }
        : undefined);
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
    expect(chrome.tabs.sendMessage).toHaveBeenCalledWith(7, expect.objectContaining({
      type: UI_ATTACH_OVERLAY_STATE,
      origin: ORIGIN,
      projection: expect.objectContaining({
        subject: expect.objectContaining({ documentId: "sync-document" }),
      }),
      activeItemId: "att_cancel",
      items: [
        { itemId: "att_save", attachmentId: "att_save", label: "1", taskNote: "Update Save changes" },
        { itemId: "att_cancel", attachmentId: "att_cancel", label: "2", taskNote: "Update Cancel" },
      ],
    }), { documentId: "sync-document", frameId: 0 });
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
      routeChain: [
        { origin: ORIGIN, pathname: "/host" },
        { origin: ORIGIN, pathname: "/settings" },
      ],
    };
    save.attachment.selectionPoint = {
      kind: "element_relative_pointer",
      xRatio: 0.25,
      yRatio: 0.75,
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
      documentId: "frame-new",
    });

    expect(response).toEqual({
      ok: true,
      data: {
        origin: ORIGIN,
        projection: expect.objectContaining({
          subject: expect.objectContaining({
            tabId: 8,
            frameId: 5,
            documentId: "frame-new",
          }),
        }),
        activeItemId: null,
        items: [{
          itemId: "att_save",
          attachmentId: "att_save",
          label: "1",
          taskNote: "Update Save changes",
          anchor: { xRatio: 0.25, yRatio: 0.75 },
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
    expect(chrome.tabs.sendMessage).toHaveBeenCalledWith(8, expect.objectContaining({
      type: UI_ATTACH_OVERLAY_STATE,
      origin: ORIGIN,
      projection: expect.objectContaining({
        subject: expect.objectContaining({ documentId: "document-reopened-01234567" }),
      }),
      activeItemId: "att_save",
      items: [{
        itemId: "att_save",
        attachmentId: "att_save",
        label: "1",
        taskNote: "Update Save changes",
      }],
    }), { documentId: "document-reopened-01234567", frameId: 0 });
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
      documentId: "content-view-document-01234567",
    });

    expect(response).toEqual({
      ok: true,
      data: {
        origin: ORIGIN,
        projection: expect.objectContaining({
          subject: expect.objectContaining({
            documentId: "content-view-document-01234567",
          }),
        }),
        activeItemId: null,
        items: [{
          itemId: "att_save",
          attachmentId: "att_save",
          label: "1",
          taskNote: "Update Likes 10",
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
      expect(response).toMatchObject({ ok: false, code: "UNTRUSTED_SENDER" });
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

  test.each([
    ["missing", {}],
    ["own undefined", { routeChain: undefined }],
    ["malformed", {
      routeChain: [
        { origin: ORIGIN, pathname: "/host" },
        { origin: FRAME_ORIGIN, pathname: 7 },
      ],
    }],
    ["empty", { routeChain: [] }],
    ["over-bound", {
      routeChain: Array.from({ length: 34 }, (_, index) => ({
        origin: index === 33 ? FRAME_ORIGIN : ORIGIN,
        pathname: index === 33 ? "/docs/mcp/reference/index.html" : `/ancestor-${index}`,
      })),
    }],
  ] as const)("rejects an embedded saved route with %s routeChain before storage lookup", async (_label, extra) => {
    const chrome = createChromeHarness();
    const store = createStoreHarness();
    const controller = createBackgroundController({ chrome, store });

    for (const type of [
      "ui-attach:saved-session-resolve-route",
      "ui-attach:saved-session-restore-route",
    ] as const) {
      await expect(dispatchRuntime(controller, {
        type,
        origin: FRAME_ORIGIN,
        pathname: "/docs/mcp/reference/index.html",
        frameKind: "embedded",
        ...extra,
      }, createExtensionSender())).resolves.toMatchObject({
        ok: false,
        code: "INVALID_COMMAND",
        issues: expect.arrayContaining([expect.objectContaining({ path: "routeChain" })]),
      });
    }
    expect(store.read).not.toHaveBeenCalled();
  });

  test.each([
    "ui-attach:saved-session-resolve-route",
    "ui-attach:saved-session-restore-route",
  ] as const)("accepts an exact 33-segment saved route at the %s parser boundary", async (type) => {
    const chrome = createChromeHarness();
    const store = createStoreHarness();
    store.read = vi.fn(async () => ({
      ok: false as const,
      code: "STORAGE_FAILURE" as const,
      error: "decisive parser boundary probe",
    }));
    const controller = createBackgroundController({ chrome, store });
    const routeChain = Array.from({ length: 33 }, (_, index) => ({
      origin: index === 32 ? FRAME_ORIGIN : ORIGIN,
      pathname: index === 32 ? "/docs/mcp/reference/index.html" : `/ancestor-${index}`,
    }));

    await expect(dispatchRuntime(controller, {
      type,
      origin: FRAME_ORIGIN,
      pathname: "/docs/mcp/reference/index.html",
      frameKind: "embedded",
      routeChain,
    }, createExtensionSender())).resolves.toMatchObject({
      ok: false,
      code: "STORAGE_FAILURE",
    });
    expect(store.read).toHaveBeenCalledWith(FRAME_ORIGIN);
  });

  test.each([
    ["missing", "missing", false],
    ["own undefined", "undefined", false],
    ["malformed", "malformed", false],
    ["empty", "empty", false],
    ["valid two-segment", "valid", true],
    ["over-bound", "over-bound", false],
  ] as const)("treats a stored embedded saved route with %s routeChain consistently", async (
    _label,
    variant,
    accepted,
  ) => {
    for (const type of [
      "ui-attach:saved-session-resolve-route",
      "ui-attach:saved-session-restore-route",
    ] as const) {
      const chrome = createChromeHarness();
      const store = createStoreHarness();
      const pathname = "/docs/mcp/reference/index.html";
      const routeChain = [
        { origin: ORIGIN, pathname: "/host" },
        { origin: FRAME_ORIGIN, pathname },
      ];
      const save = {
        ...createCaptureRecord("save", "Save changes"),
        origin: FRAME_ORIGIN,
        pageUrl: `${FRAME_ORIGIN}${pathname}`,
        tabId: 8,
        frameId: 5,
        routeChain,
      };
      save.attachment.source.url = save.pageUrl;
      save.attachment.policy.allowedDomains = [FRAME_ORIGIN];
      const untypedSave = save as typeof save & { routeChain?: unknown };
      switch (variant) {
        case "missing":
        case "undefined":
          delete untypedSave.routeChain;
          break;
        case "malformed":
          untypedSave.routeChain = [
            { origin: ORIGIN, pathname: "/host" },
            { origin: FRAME_ORIGIN, pathname: 7 },
          ];
          break;
        case "empty":
          untypedSave.routeChain = [];
          break;
        case "over-bound":
          untypedSave.routeChain = Array.from({ length: 34 }, (_, index) => ({
            origin: index === 33 ? FRAME_ORIGIN : ORIGIN,
            pathname: index === 33 ? pathname : `/ancestor-${index}`,
          }));
          break;
        case "valid":
          break;
      }
      const readback = createSessionReadbackMany([save]);
      if (variant === "undefined") {
        Object.defineProperty(readback.file!.session.attachments[0]!.sourceRecord, "routeChain", {
          configurable: true,
          enumerable: true,
          value: undefined,
          writable: true,
        });
      }
      store.read = vi.fn(async () => ({ ok: true, value: readback }));
      chrome.tabs.query = vi.fn(async () => [{
        id: 8,
        url: `${ORIGIN}/host`,
        windowId: 1,
      }]);
      chrome.tabs.update = vi.fn(async () => ({
        id: 8,
        url: `${ORIGIN}/host`,
        windowId: 1,
      }));
      const frames = [
        { frameId: 0, parentFrameId: -1, url: `${ORIGIN}/host`, documentId: "top-doc" },
        {
          frameId: 5,
          parentFrameId: 0,
          url: `${FRAME_ORIGIN}${pathname}`,
          documentId: "frame-doc",
        },
      ];
      chrome.webNavigation.getAllFrames = vi.fn(async ({ tabId }) => tabId === 8 ? frames : []);
      chrome.webNavigation.getFrame = vi.fn(async ({ tabId, frameId }) => {
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
                pathname,
                items: [{ itemId: save.attachment.id, status: "restored" }],
              },
            }
      ));
      const ensureContentScript = vi.fn(async () => true);
      const controller = createBackgroundController({ chrome, store, ensureContentScript });

      const response = await dispatchRuntime(controller, {
        type,
        origin: FRAME_ORIGIN,
        pathname,
        frameKind: "embedded",
        routeChain,
      }, createExtensionSender());

      expect(response).toMatchObject({ ok: accepted });
      if (accepted && type === "ui-attach:saved-session-restore-route") {
        expect(response).toMatchObject({
          data: { items: [{ itemId: save.attachment.id, status: "restored" }] },
        });
      } else {
        expect(chrome.tabs.update).not.toHaveBeenCalled();
        expect(chrome.tabs.sendMessage).not.toHaveBeenCalled();
      }
    }
  });

  test("retries transient frame discovery while resolving a newly opened saved route", async () => {
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
      routeChain,
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
      routeChain,
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
    const routeChain = [
      { origin: ORIGIN, pathname: "/host" },
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
      routeChain,
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
    chrome.webNavigation.getFrame = vi.fn(async ({ tabId, frameId }) =>
      tabId === 7 && frameId === 0
        ? { documentId: "serialized-document", parentFrameId: -1, url: `${ORIGIN}/settings` }
        : undefined);
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

    expect(chrome.tabs.sendMessage).toHaveBeenNthCalledWith(2, 7, expect.objectContaining({
      type: UI_ATTACH_OVERLAY_STATE,
      origin: ORIGIN,
      projection: expect.objectContaining({
        subject: expect.objectContaining({ documentId: "serialized-document" }),
      }),
      activeItemId: "att_cancel",
      items: [
        { itemId: "att_save", attachmentId: "att_save", label: "1", taskNote: "Update Save changes" },
        { itemId: "att_cancel", attachmentId: "att_cancel", label: "2", taskNote: "Update Cancel" },
      ],
    }), { documentId: "serialized-document", frameId: 0 });
  });

  test("clears removed overlays using the pre-mutation readback after a controller restart", async () => {
    const chrome = createChromeHarness();
    chrome.webNavigation.getFrame = vi.fn(async ({ tabId, frameId }) =>
      tabId === 7 && frameId === 0
        ? { documentId: "remove-document", parentFrameId: -1, url: `${ORIGIN}/settings` }
        : undefined);
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
    let current = previous;
    store.read = vi.fn(async () => ({ ok: true, value: current }));
    store.removeItem = vi.fn(async () => {
      current = remaining;
      return { ok: true, value: remaining };
    });
    const controller = createBackgroundController({ chrome, store });

    await dispatchRuntime(controller, {
      type: "ui-attach:session-remove-item",
      origin: ORIGIN,
      epoch: "epoch-1",
      itemId: "att_save",
    }, createExtensionSender());

    expect(chrome.tabs.sendMessage).toHaveBeenCalledWith(7, expect.objectContaining({
      type: UI_ATTACH_OVERLAY_STATE,
      origin: ORIGIN,
      projection: expect.objectContaining({
        subject: expect.objectContaining({ documentId: "remove-document" }),
      }),
      activeItemId: null,
      items: [{
        itemId: "att_cancel",
        attachmentId: "att_cancel",
        label: "1",
        taskNote: "Update Cancel",
      }],
    }), { documentId: "remove-document", frameId: 0 });
  });

  test("keeps clear pending until an exact zero-marker ACK and rejects wrong document or authority", async () => {
    const chrome = createChromeHarness();
    configureSingleClearPage(chrome);
    const record = { ...createCaptureRecord("save", "Save changes"), tabId: 7, frameId: 0 };
    const store = createStoreHarness();
    store.read = vi.fn(async () => ({ ok: true, value: createSessionReadback(record) }));
    const controller = createBackgroundController({ chrome, store });
    const oldProjection = await restoreAndAcknowledgeProjection(
      controller,
      createExactClearSender(chrome),
    );
    let tombstone: Record<string, unknown> | null = null;
    chrome.tabs.sendMessage = vi.fn(async (_tabId, message) => {
      if (isRecord(message) && message.type === UI_ATTACH_CLEAR_PROJECTION) tombstone = message;
      return undefined;
    });
    let settled = false;
    const clearing = dispatchRuntime(controller, {
      type: "ui-attach:session-clear",
      origin: ORIGIN,
      epoch: "epoch-1",
      operationId: "clear-deferred-ack",
    }, createExtensionSender()).finally(() => {
      settled = true;
    });
    await vi.waitFor(() => expect(tombstone).not.toBeNull());
    await flushMicrotasks();
    expect(settled).toBe(false);
    const clear = tombstone!.clear;

    await expect(dispatchRuntime(
      controller,
      exactZeroClearAck(clear),
      createExactClearSender(chrome, "wrong-document"),
    )).resolves.toMatchObject({ ok: false, code: "UNTRUSTED_SENDER" });
    await expect(dispatchRuntime(controller, exactZeroClearAck({
      ...(clear as Record<string, unknown>),
      generation: Number((clear as Record<string, unknown>).generation) + 1,
    }), createExactClearSender(chrome))).resolves.toEqual({
      ok: true,
      data: { accepted: false },
    });
    expect(settled).toBe(false);

    await expect(dispatchRuntime(
      controller,
      exactZeroClearAck(clear),
      createExactClearSender(chrome),
    )).resolves.toEqual({ ok: true, data: { accepted: true } });
    await expect(clearing).resolves.toMatchObject({ ok: true });
    expect(store.finalizeClearOperation).toHaveBeenCalledWith(expect.objectContaining({
      operationId: "clear-deferred-ack",
    }));
    await expect(dispatchRuntime(controller, {
      type: UI_ATTACH_OVERLAY_ACTION_REQUEST,
      action: "more",
      itemId: record.attachment.id,
      projection: oldProjection,
    }, createExactClearSender(chrome))).resolves.toMatchObject({
      ok: false,
      code: "UNTRUSTED_SENDER",
    });
    await expect(dispatchRuntime(
      controller,
      { type: "ui-attach:element-selection-get" },
      createExtensionSender(),
    )).resolves.toEqual({ ok: true, data: { enabled: false } });
  });

  test("blocks every old acknowledged overlay action while clear waits for content readiness", async () => {
    const chrome = createChromeHarness();
    configureSingleClearPage(chrome);
    const record = { ...createCaptureRecord("save", "Save changes"), tabId: 7, frameId: 0 };
    const store = createStoreHarness();
    store.read = vi.fn(async () => ({ ok: true, value: createSessionReadback(record) }));
    const ensureStarted = createDeferred<void>();
    const releaseEnsure = createDeferred<void>();
    const ensureContentScript = vi.fn(async () => {
      ensureStarted.resolve(undefined);
      await releaseEnsure.promise;
      return true;
    });
    const controller = createBackgroundController({ chrome, store, ensureContentScript });
    const oldProjection = await restoreAndAcknowledgeProjection(
      controller,
      createExactClearSender(chrome),
    );
    vi.mocked(store.removeItem).mockClear();
    vi.mocked(store.updateIntent).mockClear();
    chrome.tabs.sendMessage = vi.fn(async (_tabId, message) => {
      if (isRecord(message) && message.type === UI_ATTACH_CLEAR_PROJECTION) {
        void Promise.resolve().then(() => dispatchRuntime(
          controller,
          exactZeroClearAck(message.clear),
          createExactClearSender(chrome),
        ));
      }
      return undefined;
    });

    const clearing = dispatchRuntime(controller, {
      type: "ui-attach:session-clear",
      origin: ORIGIN,
      epoch: "epoch-1",
      operationId: "clear-action-barrier",
    }, createExtensionSender());
    await ensureStarted.promise;
    for (const action of ["remove", "save", "edit", "more"] as const) {
      const response = await dispatchRuntime(controller, {
        type: UI_ATTACH_OVERLAY_ACTION_REQUEST,
        action,
        itemId: record.attachment.id,
        projection: oldProjection,
        ...(action === "save" ? { taskNote: "stale edit" } : {}),
      }, createExactClearSender(chrome));
      expect(response).toMatchObject({ ok: false, code: "CLEAR_IN_PROGRESS" });
    }
    expect(store.removeItem).not.toHaveBeenCalled();
    expect(store.updateIntent).not.toHaveBeenCalled();
    expect(chrome.sidePanel?.open).not.toHaveBeenCalled();

    releaseEnsure.resolve(undefined);
    await expect(clearing).resolves.toMatchObject({ ok: true });
  });

  test.each([
    { action: "save" as const, blockedAt: "endpoint" as const },
    { action: "remove" as const, blockedAt: "store" as const },
  ])("C3 generation3 invalidates an overlay $action blocked at $blockedAt before mutation", async ({
    action,
    blockedAt,
  }) => {
    const chrome = createChromeHarness();
    configureSingleClearPage(chrome);
    const record = { ...createCaptureRecord("save", "Save changes"), tabId: 7, frameId: 0 };
    const readback = createSessionReadback(record);
    const store = createStoreHarness();
    store.read = vi.fn(async () => ({ ok: true, value: readback }));
    let controller: ReturnType<typeof createBackgroundController>;
    controller = createBackgroundController({ chrome, store });
    const projection = await restoreAndAcknowledgeProjection(
      controller,
      createExactClearSender(chrome),
    );
    vi.mocked(store.updateIntent).mockClear();
    vi.mocked(store.removeItem).mockClear();

    const actionBlocked = createDeferred<void>();
    const releaseAction = createDeferred<void>();
    if (blockedAt === "endpoint") {
      const originalGetFrame = chrome.webNavigation.getFrame;
      let blockNext = true;
      chrome.webNavigation.getFrame = vi.fn(async (details) => {
        if (blockNext) {
          blockNext = false;
          actionBlocked.resolve(undefined);
          await releaseAction.promise;
        }
        return await originalGetFrame(details);
      });
    } else {
      let blockNext = true;
      store.read = vi.fn(async () => {
        if (blockNext) {
          blockNext = false;
          actionBlocked.resolve(undefined);
          await releaseAction.promise;
        }
        return { ok: true, value: readback };
      });
    }
    chrome.tabs.sendMessage = vi.fn(async (_tabId, message) => {
      if (isRecord(message) && message.type === UI_ATTACH_CLEAR_PROJECTION) {
        void Promise.resolve().then(() => dispatchRuntime(
          controller,
          exactZeroClearAck(message.clear),
          createExactClearSender(chrome),
        ));
      }
      return undefined;
    });

    const mutation = dispatchRuntime(controller, {
      type: UI_ATTACH_OVERLAY_ACTION_REQUEST,
      action,
      itemId: record.attachment.id,
      projection,
      ...(action === "save" ? { taskNote: "must not commit" } : {}),
    }, createExactClearSender(chrome));
    await actionBlocked.promise;
    const clearing = dispatchRuntime(controller, {
      type: "ui-attach:session-clear",
      origin: ORIGIN,
      epoch: "epoch-1",
      operationId: `clear-generation3-${action}`,
    }, createExtensionSender());
    releaseAction.resolve(undefined);

    await expect(mutation).resolves.toMatchObject({ ok: false, code: "CLEAR_IN_PROGRESS" });
    expect(store.updateIntent).not.toHaveBeenCalled();
    expect(store.removeItem).not.toHaveBeenCalled();
    await expect(clearing).resolves.toMatchObject({ ok: true });
  });

  test("C3 generation3 globally blocks an acknowledged cross-origin child before discovery", async () => {
    const chrome = createChromeHarness();
    chrome.runtime.id = WIDGET_RUNTIME_ID;
    const frames = [
      {
        frameId: 0,
        parentFrameId: -1,
        documentId: "generation3-top",
        url: `${ORIGIN}/settings`,
      },
      {
        frameId: 3,
        parentFrameId: 0,
        documentId: "generation3-child",
        url: `${FRAME_ORIGIN}/embedded`,
      },
    ];
    chrome.tabs.query = vi.fn(async () => [{ id: 7, url: `${ORIGIN}/settings`, windowId: 1 }]);
    chrome.webNavigation.getFrame = vi.fn(async ({ frameId }) =>
      frames.find((frame) => frame.frameId === (frameId ?? 0)));
    chrome.webNavigation.getAllFrames = vi.fn(async () => frames);
    const topRecord = { ...createCaptureRecord("top", "Top"), tabId: 7, frameId: 0 };
    const childRecord = { ...createCaptureRecord("child", "Child"), tabId: 7, frameId: 3 };
    childRecord.origin = FRAME_ORIGIN;
    childRecord.pageUrl = `${FRAME_ORIGIN}/embedded`;
    childRecord.attachment.source.url = childRecord.pageUrl;
    childRecord.attachment.policy.allowedDomains = [FRAME_ORIGIN];
    const readbacks = new Map([
      [ORIGIN, createSessionReadback(topRecord)],
      [FRAME_ORIGIN, createSessionReadback(childRecord)],
    ]);
    const store = createStoreHarness();
    store.read = vi.fn(async (origin) => ({ ok: true, value: readbacks.get(origin)! }));
    let controller: ReturnType<typeof createBackgroundController>;
    controller = createBackgroundController({ chrome, store });
    const childSender: UiAttachChromeMessageSender = {
      id: chrome.runtime.id,
      url: `${FRAME_ORIGIN}/embedded`,
      frameId: 3,
      documentId: "generation3-child",
      tab: { id: 7, url: `${ORIGIN}/settings`, windowId: 1 },
    };
    const childProjection = await restoreAndAcknowledgeProjection(controller, childSender);
    vi.mocked(store.updateIntent).mockClear();
    vi.mocked(store.removeItem).mockClear();
    vi.mocked(chrome.sidePanel!.open).mockClear();

    const discoveryStarted = createDeferred<void>();
    const releaseDiscovery = createDeferred<void>();
    chrome.webNavigation.getAllFrames = vi.fn(async () => {
      discoveryStarted.resolve(undefined);
      await releaseDiscovery.promise;
      return frames;
    });
    chrome.tabs.sendMessage = vi.fn(async (_tabId, message) => {
      if (isRecord(message) && message.type === UI_ATTACH_CLEAR_PROJECTION &&
          isRecord(message.clear) && isRecord(message.clear.subject)) {
        const subject = message.clear.subject;
        void Promise.resolve().then(() => dispatchRuntime(
          controller,
          exactZeroClearAck(message.clear),
          {
            id: chrome.runtime.id,
            url: `${String(subject.origin)}${String(subject.pathname)}`,
            frameId: Number(subject.frameId),
            documentId: String(subject.documentId),
            tab: { id: 7, url: `${ORIGIN}/settings`, windowId: 1 },
          },
        ));
      }
      return undefined;
    });

    const clearing = dispatchRuntime(controller, {
      type: "ui-attach:session-clear",
      origin: ORIGIN,
      epoch: "epoch-1",
      operationId: "clear-generation3-pre-discovery",
    }, createExtensionSender());
    await discoveryStarted.promise;
    const responses = await Promise.all((["remove", "save", "edit", "more"] as const).map(
      (action) => dispatchRuntime(controller, {
        type: UI_ATTACH_OVERLAY_ACTION_REQUEST,
        action,
        itemId: childRecord.attachment.id,
        projection: childProjection,
        ...(action === "save" ? { taskNote: "must not commit" } : {}),
      }, childSender),
    ));

    expect(responses).toEqual(Array.from({ length: 4 }, () =>
      expect.objectContaining({ ok: false, code: "CLEAR_IN_PROGRESS" })));
    expect(store.updateIntent).not.toHaveBeenCalled();
    expect(store.removeItem).not.toHaveBeenCalled();
    expect(chrome.sidePanel?.open).not.toHaveBeenCalled();
    expect(vi.mocked(chrome.tabs.sendMessage).mock.calls.some(([, message]) =>
      isRecord(message) && message.type === UI_ATTACH_IN_PAGE_WIDGET_ACTION
    )).toBe(false);

    releaseDiscovery.resolve(undefined);
    await expect(clearing).resolves.toMatchObject({ ok: true });
  });

  test("C3 generation3 invalidates Edit while show is awaiting and never queues a widget action", async () => {
    const fixture = await createInPageWidgetFixture();
    const lifecycle = await connectInPageWidgetLifecycle(fixture);
    const ensureStarted = createDeferred<void>();
    const releaseEnsure = createDeferred<void>();
    let blockNextEnsure = true;
    fixture.ensureContentScript.mockImplementation(async () => {
      if (blockNextEnsure) {
        blockNextEnsure = false;
        ensureStarted.resolve(undefined);
        await releaseEnsure.promise;
      }
      return true;
    });
    const previousSend = fixture.chrome.tabs.sendMessage;
    fixture.chrome.tabs.sendMessage = vi.fn(async (...args) => {
      const message = args[1];
      if (isRecord(message) && message.type === UI_ATTACH_CLEAR_PROJECTION) {
        void Promise.resolve().then(() => dispatchRuntime(
          fixture.controller,
          exactZeroClearAck(message.clear),
          createInPageWidgetContentSender(),
        ));
        return undefined;
      }
      return await previousSend(...args);
    });

    const edit = dispatchRuntime(fixture.controller, {
      type: UI_ATTACH_OVERLAY_ACTION_REQUEST,
      action: "edit",
      itemId: fixture.itemId,
      projection: WIDGET_OVERLAY_PROJECTION,
    }, createInPageWidgetContentSender());
    await ensureStarted.promise;
    const clearing = dispatchRuntime(fixture.controller, {
      type: "ui-attach:session-clear",
      origin: ORIGIN,
      epoch: "epoch-1",
      operationId: "clear-generation3-edit-show",
    }, createExtensionSender());
    releaseEnsure.resolve(undefined);

    await expect(edit).resolves.toMatchObject({ ok: false, code: "CLEAR_IN_PROGRESS" });
    expect(readPostedWidgetActions(lifecycle.port)).toEqual([]);
    await expect(clearing).resolves.toMatchObject({ ok: true });
    expect(readPostedWidgetActions(lifecycle.port)).toEqual([]);
  });

  test("C3 generation3 invalidates More at final validation before side-panel open", async () => {
    const validationStarted = createDeferred<void>();
    const releaseValidation = createDeferred<void>();
    const onActiveSessionChanged = vi.fn(async () => {
      validationStarted.resolve(undefined);
      await releaseValidation.promise;
    });
    const fixture = await createInPageWidgetFixture({ onActiveSessionChanged });
    await expect(dispatchRuntime(
      fixture.controller,
      createInPageWidgetCommandEnvelope(fixture.init, {
        type: "ui-attach:widget-surface-release",
      }),
      fixture.widgetSender,
    )).resolves.toEqual({ ok: true, data: null });
    fixture.chrome.tabs.sendMessage = vi.fn(async (_tabId, message) => {
      if (isRecord(message) && message.type === UI_ATTACH_IN_PAGE_WIDGET_ENSURE) {
        return { ok: true, data: { delegated: true, surfaceOwner: "sdk" } };
      }
      if (isRecord(message) && message.type === UI_ATTACH_CLEAR_PROJECTION) {
        void Promise.resolve().then(() => dispatchRuntime(
          fixture.controller,
          exactZeroClearAck(message.clear),
          createInPageWidgetContentSender(),
        ));
      }
      return undefined;
    });
    onActiveSessionChanged.mockClear();

    const more = dispatchRuntime(fixture.controller, {
      type: UI_ATTACH_OVERLAY_ACTION_REQUEST,
      action: "more",
      itemId: fixture.itemId,
      projection: WIDGET_OVERLAY_PROJECTION,
    }, createInPageWidgetContentSender());
    await validationStarted.promise;
    const clearing = dispatchRuntime(fixture.controller, {
      type: "ui-attach:session-clear",
      origin: ORIGIN,
      epoch: "epoch-1",
      operationId: "clear-generation3-more-validation",
    }, createExtensionSender());
    releaseValidation.resolve(undefined);

    await expect(more).resolves.toMatchObject({ ok: false, code: "CLEAR_IN_PROGRESS" });
    expect(fixture.chrome.sidePanel?.open).not.toHaveBeenCalled();
    await expect(clearing).resolves.toMatchObject({ ok: true });
  });

  test("C3 generation3 rejects old and new panel mutations across readiness", async () => {
    const chrome = createChromeHarness();
    configureSingleClearPage(chrome);
    const readiness = createDeferred<boolean>();
    const record = { ...createCaptureRecord("save", "Save changes"), tabId: 7, frameId: 0 };
    const store = createStoreHarness();
    store.read = vi.fn(async () => ({ ok: true, value: createSessionReadback(record) }));
    let controller: ReturnType<typeof createBackgroundController>;
    controller = createBackgroundController({ chrome, store, storageAccessReady: readiness.promise });
    chrome.tabs.sendMessage = vi.fn(async (_tabId, message) => {
      if (isRecord(message) && message.type === UI_ATTACH_CLEAR_PROJECTION) {
        void Promise.resolve().then(() => dispatchRuntime(
          controller,
          exactZeroClearAck(message.clear),
          createExactClearSender(chrome),
        ));
      }
      return undefined;
    });
    const update = {
      type: "ui-attach:session-update-intent",
      origin: ORIGIN,
      epoch: "epoch-1",
      itemId: record.attachment.id,
      intent: "must not commit",
    } as const;
    const remove = {
      type: "ui-attach:session-remove-item",
      origin: ORIGIN,
      epoch: "epoch-1",
      itemId: record.attachment.id,
    } as const;
    const lifecycle = {
      type: "ui-attach:session-update-annotation-lifecycle",
      origin: ORIGIN,
      epoch: "epoch-1",
      itemId: record.attachment.id,
      annotationId: "opaque-clear-barrier-annotation",
      expectedState: "open",
      nextState: "resolved",
    } as const;
    const oldRequests = [
      dispatchRuntime(controller, update, createExtensionSender()),
      dispatchRuntime(controller, lifecycle, createExtensionSender()),
      dispatchRuntime(controller, remove, createExtensionSender()),
    ];
    const clearing = dispatchRuntime(controller, {
      type: "ui-attach:session-clear",
      origin: ORIGIN,
      epoch: "epoch-1",
      operationId: "clear-generation3-panel-readiness",
    }, createExtensionSender());
    const newRequests = [
      dispatchRuntime(controller, update, createExtensionSender()),
      dispatchRuntime(controller, lifecycle, createExtensionSender()),
      dispatchRuntime(controller, remove, createExtensionSender()),
    ];
    readiness.resolve(true);

    const responses = await Promise.all([...oldRequests, ...newRequests]);
    expect(responses).toEqual(Array.from({ length: 6 }, () =>
      expect.objectContaining({ ok: false, code: "CLEAR_IN_PROGRESS" })));
    expect(store.updateIntent).not.toHaveBeenCalled();
    expect(store.updateAnnotationLifecycle).not.toHaveBeenCalled();
    expect(store.removeItem).not.toHaveBeenCalled();
    await expect(clearing).resolves.toMatchObject({ ok: true });
  });

  test.each([
    {
      command: {
        type: "ui-attach:widget-task-note-save" as const,
        expectedEpoch: "epoch-1",
        itemId: "att_save",
        taskNote: "must not commit",
      },
      mutation: "updateIntent" as const,
    },
    {
      command: {
        type: "ui-attach:widget-annotation-lifecycle-set" as const,
        expectedEpoch: "epoch-1",
        itemId: "att_save",
        annotationId: "opaque-clear-barrier-annotation",
        expectedState: "open" as const,
        nextState: "resolved" as const,
      },
      mutation: "updateAnnotationLifecycle" as const,
    },
    {
      command: {
        type: "ui-attach:widget-item-remove" as const,
        expectedEpoch: "epoch-1",
        itemId: "att_save",
      },
      mutation: "removeItem" as const,
    },
  ])("C3 generation3 rejects old and new $command.type before widget mutation", async ({
    command,
    mutation,
  }) => {
    const fixture = await createInPageWidgetFixture();
    const originalGetFrame = fixture.chrome.webNavigation.getFrame;
    const contextStarted = createDeferred<void>();
    const releaseContext = createDeferred<void>();
    let topFrameReads = 0;
    fixture.chrome.webNavigation.getFrame = vi.fn(async (details) => {
      if (details.tabId === WIDGET_TAB_ID && details.frameId === 0) {
        topFrameReads += 1;
        if (topFrameReads === 2) {
          contextStarted.resolve(undefined);
          await releaseContext.promise;
        }
      }
      return await originalGetFrame(details);
    });
    const previousSend = fixture.chrome.tabs.sendMessage;
    fixture.chrome.tabs.sendMessage = vi.fn(async (...args) => {
      const message = args[1];
      if (isRecord(message) && message.type === UI_ATTACH_CLEAR_PROJECTION) {
        void Promise.resolve().then(() => dispatchRuntime(
          fixture.controller,
          exactZeroClearAck(message.clear),
          createInPageWidgetContentSender(),
        ));
        return undefined;
      }
      return await previousSend(...args);
    });
    vi.mocked(fixture.store.updateIntent).mockClear();
    vi.mocked(fixture.store.removeItem).mockClear();

    const oldRequest = dispatchRuntime(
      fixture.controller,
      createInPageWidgetCommandEnvelope(fixture.init, command),
      fixture.widgetSender,
    );
    await contextStarted.promise;
    const clearing = dispatchRuntime(fixture.controller, {
      type: "ui-attach:session-clear",
      origin: ORIGIN,
      epoch: "epoch-1",
      operationId: `clear-generation3-widget-${mutation}`,
    }, createExtensionSender());
    const newRequest = dispatchRuntime(
      fixture.controller,
      createInPageWidgetCommandEnvelope(fixture.init, command),
      fixture.widgetSender,
    );
    releaseContext.resolve(undefined);

    await expect(Promise.all([oldRequest, newRequest])).resolves.toEqual([
      expect.objectContaining({ ok: false, code: "CLEAR_IN_PROGRESS" }),
      expect.objectContaining({ ok: false, code: "CLEAR_IN_PROGRESS" }),
    ]);
    expect(fixture.store[mutation]).not.toHaveBeenCalled();
    await expect(clearing).resolves.toMatchObject({ ok: true });
  });

  test.each(["STORAGE_ERROR", "INVALID_STORAGE"] as const)(
    "C3 generation3 retries restart barrier authority after %s",
    async (fault) => {
      const chrome = createChromeHarness();
      configureSingleClearPage(chrome);
      const record = { ...createCaptureRecord("save", "Save changes"), tabId: 7, frameId: 0 };
      const store = createStoreHarness();
      store.read = vi.fn(async () => ({ ok: true, value: createSessionReadback(record) }));
      const first = createBackgroundController({ chrome, store });
      const projection = await restoreAndAcknowledgeProjection(
        first,
        createExactClearSender(chrome),
      );
      await chrome.storage.local.set({
        [CLEAR_PROJECTION_JOURNAL_STORAGE_KEY]: {
          version: 1,
          operations: [{
            version: 1,
            operationId: `clear-generation3-restart-${fault.toLowerCase()}`,
            authority: null,
            requestedOrigins: [ORIGIN],
            origins: [],
            subjectDiscovery: "complete",
            targets: [],
          }],
        },
      });
      const originalGet = chrome.storage.local.get;
      let failNextJournalRead = true;
      let journalReads = 0;
      chrome.storage.local.get = vi.fn(async (keys) => {
        if (keys === CLEAR_PROJECTION_JOURNAL_STORAGE_KEY) {
          journalReads += 1;
          if (failNextJournalRead) {
            failNextJournalRead = false;
            if (fault === "STORAGE_ERROR") throw new Error("transient storage fault");
            return {
              [CLEAR_PROJECTION_JOURNAL_STORAGE_KEY]: { version: 99, operations: [] },
            };
          }
        }
        return await originalGet(keys);
      });
      const restarted = createBackgroundController({ chrome, store });
      vi.mocked(store.removeItem).mockClear();
      const remove = {
        type: UI_ATTACH_OVERLAY_ACTION_REQUEST,
        action: "remove" as const,
        itemId: record.attachment.id,
        projection,
      };

      await expect(dispatchRuntime(
        restarted,
        remove,
        createExactClearSender(chrome),
      )).resolves.toMatchObject({ ok: false, code: "CLEAR_IN_PROGRESS" });
      await expect(dispatchRuntime(
        restarted,
        remove,
        createExactClearSender(chrome),
      )).resolves.toMatchObject({ ok: false, code: "CLEAR_IN_PROGRESS" });
      expect(journalReads).toBe(2);
      expect(store.removeItem).not.toHaveBeenCalled();
    },
  );

  test("C3 generation3 rearms a one-shot alarm after a transient pending-read fault", async () => {
    const clock = vi.spyOn(Date, "now").mockReturnValue(3_000_000);
    try {
      const chrome = createChromeHarness();
      configureSingleClearPage(chrome, "generation3-alarm-document");
      const subject = {
        tabId: 7,
        frameId: 0,
        documentId: "generation3-alarm-document",
        origin: ORIGIN,
        pathname: "/settings",
      };
      const durableReference = {
        version: 1,
        authorityId: "generation3-alarm-authority",
        operationId: "clear-generation3-alarm-fault",
        generation: 1,
        origin: ORIGIN,
        afterEpoch: "generation3-alarm-after",
        subject,
        projectionId: "generation3-alarm-projection",
        revision: 1,
      };
      await chrome.storage.local.set({
        [CLEAR_PROJECTION_JOURNAL_STORAGE_KEY]: {
          version: 1,
          operations: [{
            version: 1,
            operationId: durableReference.operationId,
            authority: {
              authorityId: durableReference.authorityId,
              operationId: durableReference.operationId,
              generation: durableReference.generation,
            },
            requestedOrigins: [ORIGIN],
            origins: [{ origin: ORIGIN, originAfterEpoch: durableReference.afterEpoch }],
            subjectDiscovery: "complete",
            targets: [{
              subject,
              removedItemIds: ["att_save"],
              projectionId: durableReference.projectionId,
              revision: durableReference.revision,
              state: "delivered",
              attemptCount: 1,
              nextAttemptAt: 3_001_000,
            }],
          }],
        },
      });
      const canonical: CaptureClearOperationV1 = {
        version: 1,
        operationId: durableReference.operationId,
        authorityId: durableReference.authorityId,
        generation: durableReference.generation,
        phase: "canonical_committed",
        origins: [{
          origin: ORIGIN,
          beforeEpoch: "epoch-1",
          afterEpoch: durableReference.afterEpoch,
          canonical: "committed",
        }],
        createdAt: "2026-08-18T00:00:00.000Z",
        updatedAt: "2026-08-18T00:00:00.000Z",
      };
      const store = createStoreHarness();
      let activeCanonical: CaptureClearOperationV1 | null = canonical;
      store.listClearOperations = vi.fn(async () => ({
        ok: true,
        value: activeCanonical ? [structuredClone(activeCanonical)] : [],
      }));
      store.finalizeClearOperation = vi.fn(async () => {
        const finalized = activeCanonical!;
        activeCanonical = null;
        return { ok: true, value: finalized };
      });
      const originalGet = chrome.storage.local.get;
      let faultOnThirdJournalRead = false;
      let journalReadsAfterFire = 0;
      chrome.storage.local.get = vi.fn(async (keys) => {
        if (faultOnThirdJournalRead && keys === CLEAR_PROJECTION_JOURNAL_STORAGE_KEY) {
          journalReadsAfterFire += 1;
          if (journalReadsAfterFire === 1) throw new Error("transient pending journal fault");
        }
        return await originalGet(keys);
      });
      let controller: ReturnType<typeof createBackgroundController>;
      const deliveredRefs: unknown[] = [];
      chrome.tabs.sendMessage = vi.fn(async (_tabId, message) => {
        if (!isRecord(message) || message.type !== UI_ATTACH_CLEAR_PROJECTION) return undefined;
        deliveredRefs.push(message.clear);
        void Promise.resolve().then(() => dispatchRuntime(
          controller,
          exactZeroClearAck(message.clear),
          createExactClearSender(chrome, subject.documentId),
        ));
        return undefined;
      });
      controller = createBackgroundController({
        chrome,
        store,
        ensureContentScript: vi.fn(async () => true),
      });
      controller.register();

      await vi.waitFor(() => expect(chrome.alarms.create).toHaveBeenCalledWith(
        "ui-attach:clear-projection-retry",
        { delayInMinutes: 1_000 / 60_000 },
      ));
      vi.mocked(chrome.alarms.create).mockClear();
      const alarmListener = vi.mocked(chrome.alarms.onAlarm.addListener).mock.calls[0]?.[0] as
        | ((alarm: { name: string }) => void)
        | undefined;
      clock.mockReturnValue(3_001_000);
      faultOnThirdJournalRead = true;
      alarmListener?.({ name: "ui-attach:clear-projection-retry" });

      await vi.waitFor(() => expect(chrome.alarms.create).toHaveBeenCalledWith(
        "ui-attach:clear-projection-retry",
        { delayInMinutes: 1_000 / 60_000 },
      ));
      expect(deliveredRefs).toEqual([]);

      clock.mockReturnValue(3_002_000);
      faultOnThirdJournalRead = false;
      alarmListener?.({ name: "ui-attach:clear-projection-retry" });
      await vi.waitFor(() => expect(activeCanonical).toBeNull());
      expect(deliveredRefs).toEqual([durableReference]);
      expect((await chrome.storage.local.get(CLEAR_PROJECTION_JOURNAL_STORAGE_KEY))[
        CLEAR_PROJECTION_JOURNAL_STORAGE_KEY
      ]).toBeUndefined();
      expect(chrome.alarms.clear).toHaveBeenCalledWith("ui-attach:clear-projection-retry");
    } finally {
      clock.mockRestore();
    }
  });

  test.each([
    { cut: "commitOrigins" as const },
    { cut: "completeSubjectDiscovery" as const },
  ])("C3 generation4 rearms after the first $cut durable exit cut", async ({ cut }) => {
    const clock = vi.spyOn(Date, "now").mockReturnValue(4_000_000);
    try {
      const chrome = createChromeHarness();
      configureSingleClearPage(chrome, `generation4-${cut}-document`);
      const record = { ...createCaptureRecord("save", "Save changes"), tabId: 7, frameId: 0 };
      const store = createStoreHarness();
      store.read = vi.fn(async () => ({ ok: true, value: createSessionReadback(record) }));
      const controller = createBackgroundController({
        chrome,
        store,
        ensureContentScript: vi.fn(async () => true),
      });
      const sender = createExactClearSender(chrome, `generation4-${cut}-document`);
      const projection = await restoreAndAcknowledgeProjection(controller, sender);
      controller.register();
      await vi.waitFor(() => expect(chrome.alarms.clear).toHaveBeenCalledWith(
        "ui-attach:clear-projection-retry",
      ));
      vi.mocked(chrome.alarms.create).mockClear();
      vi.mocked(chrome.alarms.clear).mockClear();

      const operationId = `clear-generation4-${cut}`;
      const originalGet = chrome.storage.local.get;
      const originalSet = chrome.storage.local.set;
      let failBoundWrite = cut === "commitOrigins";
      let failNextJournalRead = false;
      let armDiscoveryReadFault = cut === "completeSubjectDiscovery";
      chrome.storage.local.get = vi.fn(async (keys) => {
        if (failNextJournalRead && keys === CLEAR_PROJECTION_JOURNAL_STORAGE_KEY) {
          failNextJournalRead = false;
          throw new Error("first completeSubjectDiscovery storage read failed");
        }
        return await originalGet(keys);
      });
      chrome.storage.local.set = vi.fn(async (items) => {
        const journal = items[CLEAR_PROJECTION_JOURNAL_STORAGE_KEY];
        const operation = isRecord(journal) && Array.isArray(journal.operations)
          ? journal.operations.find((candidate) =>
              isRecord(candidate) && candidate.operationId === operationId
            )
          : null;
        const isFirstBoundWrite = isRecord(operation) && operation.authority !== null;
        if (isFirstBoundWrite && failBoundWrite) {
          failBoundWrite = false;
          throw new Error("first commitOrigins storage write failed");
        }
        await originalSet(items);
        if (isFirstBoundWrite && armDiscoveryReadFault) {
          armDiscoveryReadFault = false;
          failNextJournalRead = true;
        }
      });

      const deliveredRefs: unknown[] = [];
      chrome.tabs.sendMessage = vi.fn(async (_tabId, message) => {
        if (!isRecord(message) || message.type !== UI_ATTACH_CLEAR_PROJECTION) return undefined;
        deliveredRefs.push(message.clear);
        void Promise.resolve().then(() => dispatchRuntime(
          controller,
          exactZeroClearAck(message.clear),
          sender,
        ));
        return undefined;
      });

      await expect(dispatchRuntime(controller, {
        type: "ui-attach:session-clear",
        origin: ORIGIN,
        epoch: "epoch-1",
        operationId,
      }, createExtensionSender())).resolves.toMatchObject({
        ok: false,
        code: "STORAGE_ERROR",
      });
      await vi.waitFor(() => expect(chrome.alarms.create).toHaveBeenCalledWith(
        "ui-attach:clear-projection-retry",
        { delayInMinutes: 1_000 / 60_000 },
      ));
      expect(deliveredRefs).toEqual([]);

      vi.mocked(store.removeItem).mockClear();
      await expect(dispatchRuntime(controller, {
        type: UI_ATTACH_OVERLAY_ACTION_REQUEST,
        action: "remove",
        itemId: record.attachment.id,
        projection,
      }, sender)).resolves.toMatchObject({ ok: false, code: "CLEAR_IN_PROGRESS" });
      expect(store.removeItem).not.toHaveBeenCalled();

      const journalBeforeFire = (await chrome.storage.local.get(
        CLEAR_PROJECTION_JOURNAL_STORAGE_KEY,
      ))[CLEAR_PROJECTION_JOURNAL_STORAGE_KEY];
      const canonicalBeforeFire = await store.listClearOperations();
      expect(canonicalBeforeFire.ok).toBe(true);
      const canonicalOperation = canonicalBeforeFire.ok ? canonicalBeforeFire.value[0] : undefined;
      const projectionOperation = isRecord(journalBeforeFire) &&
          Array.isArray(journalBeforeFire.operations)
        ? journalBeforeFire.operations[0]
        : undefined;
      const projectionTarget = isRecord(projectionOperation) &&
          Array.isArray(projectionOperation.targets)
        ? projectionOperation.targets[0]
        : undefined;
      expect(canonicalOperation).toBeDefined();
      expect(projectionTarget).toBeDefined();
      const expectedReference = {
        version: 1,
        authorityId: canonicalOperation!.authorityId,
        operationId,
        generation: canonicalOperation!.generation,
        origin: ORIGIN,
        afterEpoch: canonicalOperation!.origins[0]!.afterEpoch,
        subject: (projectionTarget as Record<string, unknown>).subject,
        projectionId: (projectionTarget as Record<string, unknown>).projectionId,
        revision: (projectionTarget as Record<string, unknown>).revision,
      };

      clock.mockReturnValue(4_001_000);
      clearProjectionAlarmListener(chrome)?.({ name: "ui-attach:clear-projection-retry" });
      await vi.waitFor(async () => {
        expect((await chrome.storage.local.get(CLEAR_PROJECTION_JOURNAL_STORAGE_KEY))[
          CLEAR_PROJECTION_JOURNAL_STORAGE_KEY
        ]).toBeUndefined();
      });
      expect(deliveredRefs).toEqual([expectedReference]);
      expect(store.finalizeClearOperation).toHaveBeenCalledWith(expect.objectContaining({
        operationId,
        authorityId: canonicalOperation!.authorityId,
        generation: canonicalOperation!.generation,
      }));
      expect(await store.listClearOperations()).toEqual({ ok: true, value: [] });
      expect(chrome.alarms.clear).toHaveBeenCalledWith("ui-attach:clear-projection-retry");
    } finally {
      clock.mockRestore();
    }
  });

  test.each([
    { cut: "finalizeClearOperation" as const },
    { cut: "removeOperation" as const },
  ])("C3 generation4 rearms all-conflict cleanup after the first $cut failure", async ({ cut }) => {
    const clock = vi.spyOn(Date, "now").mockReturnValue(4_100_000);
    try {
      const chrome = createChromeHarness();
      configureSingleClearPage(chrome, `generation4-conflict-${cut}-document`);
      const record = { ...createCaptureRecord("save", "Save changes"), tabId: 7, frameId: 0 };
      const store = createStoreHarness();
      store.read = vi.fn(async () => ({ ok: true, value: createSessionReadback(record) }));
      const operationId = `clear-generation4-conflict-${cut}`;
      let activeCanonical: CaptureClearOperationV1 | null = null;
      store.clearOrigins = vi.fn(async (request) => {
        activeCanonical = {
          version: 1,
          operationId,
          authorityId: `generation4-conflict-${cut}-authority`,
          generation: 1,
          phase: "canonical_committed",
          origins: request.origins.map((entry) => ({
            origin: entry.origin,
            beforeEpoch: entry.epoch,
            afterEpoch: `generation4-conflict-${cut}-after`,
            canonical: "conflict" as const,
          })),
          createdAt: "2026-08-18T00:00:00.000Z",
          updatedAt: "2026-08-18T00:00:00.000Z",
        };
        return { ok: true, value: structuredClone(activeCanonical) };
      });
      store.listClearOperations = vi.fn(async () => ({
        ok: true,
        value: activeCanonical ? [structuredClone(activeCanonical)] : [],
      }));
      let finalizeAttempts = 0;
      store.finalizeClearOperation = vi.fn(async () => {
        finalizeAttempts += 1;
        if (cut === "finalizeClearOperation" && finalizeAttempts === 1) {
          return { ok: false, code: "STORAGE_ERROR" as const, error: "transient C1 finalize" };
        }
        if (!activeCanonical) {
          return { ok: false, code: "ITEM_NOT_FOUND" as const, error: "missing" };
        }
        const finalized = structuredClone(activeCanonical);
        activeCanonical = null;
        return { ok: true, value: finalized };
      });
      const controller = createBackgroundController({
        chrome,
        store,
        ensureContentScript: vi.fn(async () => true),
      });
      const sender = createExactClearSender(chrome, `generation4-conflict-${cut}-document`);
      const projection = await restoreAndAcknowledgeProjection(controller, sender);
      controller.register();
      await vi.waitFor(() => expect(chrome.alarms.clear).toHaveBeenCalledWith(
        "ui-attach:clear-projection-retry",
      ));
      vi.mocked(chrome.alarms.create).mockClear();
      vi.mocked(chrome.alarms.clear).mockClear();
      vi.mocked(chrome.tabs.sendMessage).mockClear();

      const originalRemove = chrome.storage.local.remove;
      let failProvisionalRemove = cut === "removeOperation";
      chrome.storage.local.remove = vi.fn(async (keys) => {
        if (failProvisionalRemove && (
          keys === CLEAR_PROJECTION_JOURNAL_STORAGE_KEY ||
          (Array.isArray(keys) && keys.includes(CLEAR_PROJECTION_JOURNAL_STORAGE_KEY))
        )) {
          failProvisionalRemove = false;
          throw new Error("first C3 removeOperation storage write failed");
        }
        await originalRemove(keys);
      });

      await expect(dispatchRuntime(controller, {
        type: "ui-attach:session-clear",
        origin: ORIGIN,
        epoch: "epoch-1",
        operationId,
      }, createExtensionSender())).resolves.toMatchObject({
        ok: false,
        code: "STALE_SESSION",
      });
      await vi.waitFor(() => expect(chrome.alarms.create).toHaveBeenCalledWith(
        "ui-attach:clear-projection-retry",
        { delayInMinutes: 1_000 / 60_000 },
      ));
      expect((await chrome.storage.local.get(CLEAR_PROJECTION_JOURNAL_STORAGE_KEY))[
        CLEAR_PROJECTION_JOURNAL_STORAGE_KEY
      ]).toBeDefined();

      vi.mocked(store.removeItem).mockClear();
      await expect(dispatchRuntime(controller, {
        type: UI_ATTACH_OVERLAY_ACTION_REQUEST,
        action: "remove",
        itemId: record.attachment.id,
        projection,
      }, sender)).resolves.toMatchObject({ ok: false, code: "CLEAR_IN_PROGRESS" });
      expect(store.removeItem).not.toHaveBeenCalled();

      clock.mockReturnValue(4_101_000);
      clearProjectionAlarmListener(chrome)?.({ name: "ui-attach:clear-projection-retry" });
      await vi.waitFor(async () => {
        const journal = (await chrome.storage.local.get(CLEAR_PROJECTION_JOURNAL_STORAGE_KEY))[
          CLEAR_PROJECTION_JOURNAL_STORAGE_KEY
        ];
        if (cut === "removeOperation") expect(journal).toBeDefined();
        else expect(journal).toBeUndefined();
      });
      expect(activeCanonical).toBeNull();
      expect(store.finalizeClearOperation).toHaveBeenCalledTimes(
        cut === "finalizeClearOperation" ? 2 : 1,
      );
      expect(vi.mocked(chrome.tabs.sendMessage).mock.calls.some(([, message]) =>
        isRecord(message) && message.type === UI_ATTACH_CLEAR_PROJECTION
      )).toBe(false);
      if (cut === "finalizeClearOperation") {
        expect(chrome.alarms.clear).toHaveBeenCalledWith("ui-attach:clear-projection-retry");
      }

      const postRecoveryMutation = dispatchRuntime(controller, {
        type: UI_ATTACH_OVERLAY_ACTION_REQUEST,
        action: "remove",
        itemId: record.attachment.id,
        projection,
      }, sender);
      if (cut === "removeOperation") {
        await expect(postRecoveryMutation).resolves.toMatchObject({
          ok: false,
          code: "CLEAR_IN_PROGRESS",
        });
      } else {
        await expect(postRecoveryMutation).resolves.not.toMatchObject({
          code: "CLEAR_IN_PROGRESS",
        });
      }
      expect(store.removeItem).toHaveBeenCalledTimes(cut === "removeOperation" ? 0 : 1);
    } finally {
      clock.mockRestore();
    }
  });

  test("C4 preserves resumable provisional cleanup when C1 is absent after a C3 read fault", async () => {
    const clock = vi.spyOn(Date, "now").mockReturnValue(4_200_000);
    try {
      const chrome = createChromeHarness();
      configureSingleClearPage(chrome, "generation4-provisional-document");
      const record = { ...createCaptureRecord("save", "Save changes"), tabId: 7, frameId: 0 };
      const store = createStoreHarness();
      store.read = vi.fn(async () => ({ ok: true, value: createSessionReadback(record) }));
      let failNextJournalRead = false;
      store.clearOrigins = vi.fn(async () => {
        failNextJournalRead = true;
        return { ok: false, code: "STORAGE_ERROR" as const, error: "C1 unavailable" };
      });
      store.listClearOperations = vi.fn(async () => ({ ok: true, value: [] }));
      const controller = createBackgroundController({
        chrome,
        store,
        ensureContentScript: vi.fn(async () => true),
      });
      const sender = createExactClearSender(chrome, "generation4-provisional-document");
      const projection = await restoreAndAcknowledgeProjection(controller, sender);
      controller.register();
      await vi.waitFor(() => expect(chrome.alarms.clear).toHaveBeenCalledWith(
        "ui-attach:clear-projection-retry",
      ));
      vi.mocked(chrome.alarms.create).mockClear();
      vi.mocked(chrome.alarms.clear).mockClear();

      const originalGet = chrome.storage.local.get;
      chrome.storage.local.get = vi.fn(async (keys) => {
        if (failNextJournalRead && keys === CLEAR_PROJECTION_JOURNAL_STORAGE_KEY) {
          failNextJournalRead = false;
          throw new Error("first provisional C3 listOperations read failed");
        }
        return await originalGet(keys);
      });
      const operationId = "clear-generation4-provisional-read";
      await expect(dispatchRuntime(controller, {
        type: "ui-attach:session-clear",
        origin: ORIGIN,
        epoch: "epoch-1",
        operationId,
      }, createExtensionSender())).resolves.toMatchObject({
        ok: false,
        code: "STORAGE_ERROR",
      });
      await vi.waitFor(() => expect(chrome.alarms.create).toHaveBeenCalledWith(
        "ui-attach:clear-projection-retry",
        { delayInMinutes: 1_000 / 60_000 },
      ));
      expect((await chrome.storage.local.get(CLEAR_PROJECTION_JOURNAL_STORAGE_KEY))[
        CLEAR_PROJECTION_JOURNAL_STORAGE_KEY
      ]).toBeDefined();

      vi.mocked(store.removeItem).mockClear();
      await expect(dispatchRuntime(controller, {
        type: UI_ATTACH_OVERLAY_ACTION_REQUEST,
        action: "remove",
        itemId: record.attachment.id,
        projection,
      }, sender)).resolves.toMatchObject({ ok: false, code: "CLEAR_IN_PROGRESS" });
      expect(store.removeItem).not.toHaveBeenCalled();

      clock.mockReturnValue(4_201_000);
      clearProjectionAlarmListener(chrome)?.({ name: "ui-attach:clear-projection-retry" });
      await vi.waitFor(async () => {
        expect((await chrome.storage.local.get(CLEAR_PROJECTION_JOURNAL_STORAGE_KEY))[
          CLEAR_PROJECTION_JOURNAL_STORAGE_KEY
        ]).toBeDefined();
      });
      expect(store.finalizeClearOperation).not.toHaveBeenCalled();

      await expect(dispatchRuntime(controller, {
        type: UI_ATTACH_OVERLAY_ACTION_REQUEST,
        action: "remove",
        itemId: record.attachment.id,
        projection,
      }, sender)).resolves.toMatchObject({ ok: false, code: "CLEAR_IN_PROGRESS" });
      expect(store.removeItem).not.toHaveBeenCalled();
    } finally {
      clock.mockRestore();
    }
  });

  test("C3 generation5 keeps a newer durable retry alarm authoritative over a stale startup snapshot", async () => {
    const clock = vi.spyOn(Date, "now").mockReturnValue(5_000_000);
    try {
      const chrome = createChromeHarness();
      configureSingleClearPage(chrome, "generation5-alarm-authority-document");
      let activeAlarm: { name: string; delayInMinutes: number } | null = null;
      chrome.alarms.create = vi.fn((name, alarmInfo) => {
        activeAlarm = { name, delayInMinutes: alarmInfo.delayInMinutes ?? 0 };
      });
      chrome.alarms.clear = vi.fn(async (name) => {
        const existed = activeAlarm?.name === name;
        if (existed) activeAlarm = null;
        return existed;
      });

      const record = { ...createCaptureRecord("save", "Save changes"), tabId: 7, frameId: 0 };
      const store = createStoreHarness();
      store.read = vi.fn(async () => ({ ok: true, value: createSessionReadback(record) }));
      const controller = createBackgroundController({
        chrome,
        store,
        ensureContentScript: vi.fn(async () => true),
      });
      const sender = createExactClearSender(chrome, "generation5-alarm-authority-document");
      const projection = await restoreAndAcknowledgeProjection(controller, sender);

      const originalGet = chrome.storage.local.get;
      let journalReads = 0;
      let startupEmptySnapshotCaptured!: () => void;
      const capturedStartupEmptySnapshot = new Promise<void>((resolve) => {
        startupEmptySnapshotCaptured = resolve;
      });
      let releaseStartupEmptySnapshot!: () => void;
      const startupEmptySnapshotRelease = new Promise<void>((resolve) => {
        releaseStartupEmptySnapshot = resolve;
      });
      chrome.storage.local.get = vi.fn(async (keys) => {
        if (keys !== CLEAR_PROJECTION_JOURNAL_STORAGE_KEY) return await originalGet(keys);
        journalReads += 1;
        const captured = await originalGet(keys);
        if (journalReads === 3) {
          startupEmptySnapshotCaptured();
          await startupEmptySnapshotRelease;
        }
        return captured;
      });

      controller.register();
      await capturedStartupEmptySnapshot;
      expect(activeAlarm).toBeNull();

      const operationId = "clear-generation5-alarm-authority";
      const originalSet = chrome.storage.local.set;
      let failFirstBoundWrite = true;
      chrome.storage.local.set = vi.fn(async (items) => {
        const journal = items[CLEAR_PROJECTION_JOURNAL_STORAGE_KEY];
        const operation = isRecord(journal) && Array.isArray(journal.operations)
          ? journal.operations.find((candidate) =>
              isRecord(candidate) && candidate.operationId === operationId
            )
          : null;
        if (failFirstBoundWrite && isRecord(operation) && operation.authority !== null) {
          failFirstBoundWrite = false;
          throw new Error("first generation5 commitOrigins storage write failed");
        }
        await originalSet(items);
      });

      await expect(dispatchRuntime(controller, {
        type: "ui-attach:session-clear",
        origin: ORIGIN,
        epoch: "epoch-1",
        operationId,
      }, createExtensionSender())).resolves.toMatchObject({
        ok: false,
        code: "STORAGE_ERROR",
      });
      await vi.waitFor(() => expect(activeAlarm).toEqual({
        name: "ui-attach:clear-projection-retry",
        delayInMinutes: 1_000 / 60_000,
      }));

      vi.mocked(store.removeItem).mockClear();
      await expect(dispatchRuntime(controller, {
        type: UI_ATTACH_OVERLAY_ACTION_REQUEST,
        action: "remove",
        itemId: record.attachment.id,
        projection,
      }, sender)).resolves.toMatchObject({ ok: false, code: "CLEAR_IN_PROGRESS" });
      expect(store.removeItem).not.toHaveBeenCalled();

      const journalBeforeRelease = (await originalGet(CLEAR_PROJECTION_JOURNAL_STORAGE_KEY))[
        CLEAR_PROJECTION_JOURNAL_STORAGE_KEY
      ];
      const canonicalBeforeRelease = await store.listClearOperations();
      expect(canonicalBeforeRelease.ok).toBe(true);
      const canonicalOperation = canonicalBeforeRelease.ok
        ? canonicalBeforeRelease.value[0]
        : undefined;
      const projectionOperation = isRecord(journalBeforeRelease) &&
          Array.isArray(journalBeforeRelease.operations)
        ? journalBeforeRelease.operations[0]
        : undefined;
      const projectionTarget = isRecord(projectionOperation) &&
          Array.isArray(projectionOperation.targets)
        ? projectionOperation.targets[0]
        : undefined;
      expect(canonicalOperation).toBeDefined();
      expect(projectionTarget).toBeDefined();
      const expectedReference = {
        version: 1,
        authorityId: canonicalOperation!.authorityId,
        operationId,
        generation: canonicalOperation!.generation,
        origin: ORIGIN,
        afterEpoch: canonicalOperation!.origins[0]!.afterEpoch,
        subject: (projectionTarget as Record<string, unknown>).subject,
        projectionId: (projectionTarget as Record<string, unknown>).projectionId,
        revision: (projectionTarget as Record<string, unknown>).revision,
      };

      releaseStartupEmptySnapshot();
      await flushAsyncWork();
      expect(activeAlarm).toEqual({
        name: "ui-attach:clear-projection-retry",
        delayInMinutes: 1_000 / 60_000,
      });

      const deliveredRefs: unknown[] = [];
      chrome.tabs.sendMessage = vi.fn(async (_tabId, message) => {
        if (!isRecord(message) || message.type !== UI_ATTACH_CLEAR_PROJECTION) return undefined;
        deliveredRefs.push(message.clear);
        void Promise.resolve().then(() => dispatchRuntime(
          controller,
          exactZeroClearAck(message.clear),
          sender,
        ));
        return undefined;
      });
      clock.mockReturnValue(5_001_000);
      clearProjectionAlarmListener(chrome)?.({ name: "ui-attach:clear-projection-retry" });

      await vi.waitFor(async () => {
        expect((await originalGet(CLEAR_PROJECTION_JOURNAL_STORAGE_KEY))[
          CLEAR_PROJECTION_JOURNAL_STORAGE_KEY
        ]).toBeUndefined();
      });
      expect(deliveredRefs).toEqual([expectedReference]);
      expect(await store.listClearOperations()).toEqual({ ok: true, value: [] });
      expect(activeAlarm).toBeNull();

      await expect(dispatchRuntime(controller, {
        type: UI_ATTACH_OVERLAY_ACTION_REQUEST,
        action: "remove",
        itemId: record.attachment.id,
        projection,
      }, sender)).resolves.not.toMatchObject({ code: "CLEAR_IN_PROGRESS" });
    } finally {
      clock.mockRestore();
    }
  });

  test("C3 generation6 replays a consumed alarm wake after the active reconcile settles", async () => {
    const clock = vi.spyOn(Date, "now").mockReturnValue(6_000_000);
    try {
      const chrome = createChromeHarness();
      configureSingleClearPage(chrome, "generation6-consumed-wake-document");
      let activeAlarm: { name: string; delayInMinutes: number } | null = null;
      chrome.alarms.create = vi.fn((name, alarmInfo) => {
        activeAlarm = { name, delayInMinutes: alarmInfo.delayInMinutes ?? 0 };
      });
      chrome.alarms.clear = vi.fn(async (name) => {
        const existed = activeAlarm?.name === name;
        if (existed) activeAlarm = null;
        return existed;
      });

      const record = { ...createCaptureRecord("save", "Save changes"), tabId: 7, frameId: 0 };
      const store = createStoreHarness();
      store.read = vi.fn(async () => ({ ok: true, value: createSessionReadback(record) }));
      const controller = createBackgroundController({
        chrome,
        store,
        ensureContentScript: vi.fn(async () => true),
      });
      const sender = createExactClearSender(chrome, "generation6-consumed-wake-document");
      const projection = await restoreAndAcknowledgeProjection(controller, sender);

      const originalGet = chrome.storage.local.get;
      let journalReads = 0;
      let startupEmptySnapshotCaptured!: () => void;
      const capturedStartupEmptySnapshot = new Promise<void>((resolve) => {
        startupEmptySnapshotCaptured = resolve;
      });
      let releaseStartupEmptySnapshot!: () => void;
      const startupEmptySnapshotRelease = new Promise<void>((resolve) => {
        releaseStartupEmptySnapshot = resolve;
      });
      chrome.storage.local.get = vi.fn(async (keys) => {
        if (keys !== CLEAR_PROJECTION_JOURNAL_STORAGE_KEY) return await originalGet(keys);
        journalReads += 1;
        const captured = await originalGet(keys);
        if (journalReads === 3) {
          startupEmptySnapshotCaptured();
          await startupEmptySnapshotRelease;
        }
        return captured;
      });

      controller.register();
      await capturedStartupEmptySnapshot;
      expect(activeAlarm).toBeNull();

      const operationId = "clear-generation6-consumed-wake";
      const originalSet = chrome.storage.local.set;
      let failFirstBoundWrite = true;
      chrome.storage.local.set = vi.fn(async (items) => {
        const journal = items[CLEAR_PROJECTION_JOURNAL_STORAGE_KEY];
        const operation = isRecord(journal) && Array.isArray(journal.operations)
          ? journal.operations.find((candidate) =>
              isRecord(candidate) && candidate.operationId === operationId
            )
          : null;
        if (failFirstBoundWrite && isRecord(operation) && operation.authority !== null) {
          failFirstBoundWrite = false;
          throw new Error("first generation6 commitOrigins storage write failed");
        }
        await originalSet(items);
      });

      await expect(dispatchRuntime(controller, {
        type: "ui-attach:session-clear",
        origin: ORIGIN,
        epoch: "epoch-1",
        operationId,
      }, createExtensionSender())).resolves.toMatchObject({
        ok: false,
        code: "STORAGE_ERROR",
      });
      await vi.waitFor(() => expect(activeAlarm).toEqual({
        name: "ui-attach:clear-projection-retry",
        delayInMinutes: 1_000 / 60_000,
      }));

      vi.mocked(store.removeItem).mockClear();
      await expect(dispatchRuntime(controller, {
        type: UI_ATTACH_OVERLAY_ACTION_REQUEST,
        action: "remove",
        itemId: record.attachment.id,
        projection,
      }, sender)).resolves.toMatchObject({ ok: false, code: "CLEAR_IN_PROGRESS" });
      expect(store.removeItem).not.toHaveBeenCalled();

      const journalBeforeFire = (await originalGet(CLEAR_PROJECTION_JOURNAL_STORAGE_KEY))[
        CLEAR_PROJECTION_JOURNAL_STORAGE_KEY
      ];
      const canonicalBeforeFire = await store.listClearOperations();
      expect(canonicalBeforeFire.ok).toBe(true);
      const canonicalOperation = canonicalBeforeFire.ok
        ? canonicalBeforeFire.value[0]
        : undefined;
      const projectionOperation = isRecord(journalBeforeFire) &&
          Array.isArray(journalBeforeFire.operations)
        ? journalBeforeFire.operations[0]
        : undefined;
      const projectionTarget = isRecord(projectionOperation) &&
          Array.isArray(projectionOperation.targets)
        ? projectionOperation.targets[0]
        : undefined;
      expect(canonicalOperation).toBeDefined();
      expect(projectionTarget).toBeDefined();
      const expectedReference = {
        version: 1,
        authorityId: canonicalOperation!.authorityId,
        operationId,
        generation: canonicalOperation!.generation,
        origin: ORIGIN,
        afterEpoch: canonicalOperation!.origins[0]!.afterEpoch,
        subject: (projectionTarget as Record<string, unknown>).subject,
        projectionId: (projectionTarget as Record<string, unknown>).projectionId,
        revision: (projectionTarget as Record<string, unknown>).revision,
      };

      const deliveredRefs: unknown[] = [];
      chrome.tabs.sendMessage = vi.fn(async (_tabId, message) => {
        if (!isRecord(message) || message.type !== UI_ATTACH_CLEAR_PROJECTION) return undefined;
        deliveredRefs.push(message.clear);
        void Promise.resolve().then(() => dispatchRuntime(
          controller,
          exactZeroClearAck(message.clear),
          sender,
        ));
        return undefined;
      });

      activeAlarm = null;
      clock.mockReturnValue(6_001_000);
      clearProjectionAlarmListener(chrome)?.({ name: "ui-attach:clear-projection-retry" });
      await flushMicrotasks();
      expect(deliveredRefs).toEqual([]);
      expect((await originalGet(CLEAR_PROJECTION_JOURNAL_STORAGE_KEY))[
        CLEAR_PROJECTION_JOURNAL_STORAGE_KEY
      ]).toBeDefined();

      releaseStartupEmptySnapshot();
      await vi.waitFor(async () => {
        expect((await originalGet(CLEAR_PROJECTION_JOURNAL_STORAGE_KEY))[
          CLEAR_PROJECTION_JOURNAL_STORAGE_KEY
        ]).toBeUndefined();
      });
      expect(deliveredRefs).toEqual([expectedReference]);
      expect(await store.listClearOperations()).toEqual({ ok: true, value: [] });
      expect(activeAlarm).toBeNull();

      await expect(dispatchRuntime(controller, {
        type: UI_ATTACH_OVERLAY_ACTION_REQUEST,
        action: "remove",
        itemId: record.attachment.id,
        projection,
      }, sender)).resolves.not.toMatchObject({ code: "CLEAR_IN_PROGRESS" });
    } finally {
      clock.mockRestore();
    }
  });

  test("C3 generation6 commits a newer conservative alarm after an awaited clear settles", async () => {
    const clock = vi.spyOn(Date, "now").mockReturnValue(6_100_000);
    try {
      const chrome = createChromeHarness();
      configureSingleClearPage(chrome, "generation6-clear-await-document");
      let activeAlarm: { name: string; delayInMinutes: number } | null = null;
      chrome.alarms.create = vi.fn((name, alarmInfo) => {
        activeAlarm = { name, delayInMinutes: alarmInfo.delayInMinutes ?? 0 };
      });
      let clearStarted!: () => void;
      const awaitedClearStarted = new Promise<void>((resolve) => {
        clearStarted = resolve;
      });
      let releaseClear!: () => void;
      const clearRelease = new Promise<void>((resolve) => {
        releaseClear = resolve;
      });
      chrome.alarms.clear = vi.fn(async (name) => {
        clearStarted();
        await clearRelease;
        const existed = activeAlarm?.name === name;
        if (existed) activeAlarm = null;
        return existed;
      });

      const record = { ...createCaptureRecord("save", "Save changes"), tabId: 7, frameId: 0 };
      const store = createStoreHarness();
      store.read = vi.fn(async () => ({ ok: true, value: createSessionReadback(record) }));
      const controller = createBackgroundController({
        chrome,
        store,
        ensureContentScript: vi.fn(async () => true),
      });
      const sender = createExactClearSender(chrome, "generation6-clear-await-document");
      await restoreAndAcknowledgeProjection(controller, sender);
      controller.register();
      await awaitedClearStarted;

      const operationId = "clear-generation6-clear-await";
      const originalSet = chrome.storage.local.set;
      let failFirstBoundWrite = true;
      chrome.storage.local.set = vi.fn(async (items) => {
        const journal = items[CLEAR_PROJECTION_JOURNAL_STORAGE_KEY];
        const operation = isRecord(journal) && Array.isArray(journal.operations)
          ? journal.operations.find((candidate) =>
              isRecord(candidate) && candidate.operationId === operationId
            )
          : null;
        if (failFirstBoundWrite && isRecord(operation) && operation.authority !== null) {
          failFirstBoundWrite = false;
          throw new Error("first generation6 clear-await commitOrigins storage write failed");
        }
        await originalSet(items);
      });

      await expect(dispatchRuntime(controller, {
        type: "ui-attach:session-clear",
        origin: ORIGIN,
        epoch: "epoch-1",
        operationId,
      }, createExtensionSender())).resolves.toMatchObject({
        ok: false,
        code: "STORAGE_ERROR",
      });
      expect(chrome.alarms.create).not.toHaveBeenCalled();
      expect(activeAlarm).toBeNull();

      releaseClear();
      await vi.waitFor(() => expect(activeAlarm).toEqual({
        name: "ui-attach:clear-projection-retry",
        delayInMinutes: 1_000 / 60_000,
      }));
    } finally {
      clock.mockRestore();
    }
  });

  test("worker recreation loads an unbound durable clear barrier before any C1 resume", async () => {
    const chrome = createChromeHarness();
    configureSingleClearPage(chrome);
    const record = { ...createCaptureRecord("save", "Save changes"), tabId: 7, frameId: 0 };
    const store = createStoreHarness();
    store.read = vi.fn(async () => ({ ok: true, value: createSessionReadback(record) }));
    const first = createBackgroundController({ chrome, store });
    const projection = await restoreAndAcknowledgeProjection(
      first,
      createExactClearSender(chrome),
    );
    await chrome.storage.local.set({
      [CLEAR_PROJECTION_JOURNAL_STORAGE_KEY]: {
        version: 1,
        operations: [{
          version: 1,
          operationId: "clear-unbound-barrier",
          authority: null,
          requestedOrigins: [ORIGIN],
          origins: [],
          subjectDiscovery: "complete",
          targets: [{
            subject: {
              tabId: 7,
              frameId: 0,
              documentId: "clear-document",
              origin: ORIGIN,
              pathname: "/settings",
            },
            removedItemIds: [record.attachment.id],
            projectionId: "unbound-barrier-projection",
            revision: 1,
            state: "pending",
            attemptCount: 0,
            nextAttemptAt: 0,
          }],
        }],
      },
    });
    expect(parseClearProjectionJournal((await chrome.storage.local.get(
      CLEAR_PROJECTION_JOURNAL_STORAGE_KEY,
    ))[CLEAR_PROJECTION_JOURNAL_STORAGE_KEY])).not.toBeNull();
    const restarted = createBackgroundController({ chrome, store });
    vi.mocked(store.removeItem).mockClear();

    await expect(dispatchRuntime(restarted, {
      type: UI_ATTACH_OVERLAY_ACTION_REQUEST,
      action: "remove",
      itemId: record.attachment.id,
      projection,
    }, createExactClearSender(chrome))).resolves.toMatchObject({
      ok: false,
      code: "CLEAR_IN_PROGRESS",
    });
    expect(store.removeItem).not.toHaveBeenCalled();
    expect(store.clearOrigins).not.toHaveBeenCalled();
  });

  test("worker recreation keeps an active-origin clear barrier off another origin in the same tab", async () => {
    const chrome = createChromeHarness();
    const frames = [
      {
        frameId: 0,
        parentFrameId: -1,
        documentId: "active-origin-top-document",
        url: `${ORIGIN}/settings`,
      },
      {
        frameId: 3,
        parentFrameId: 0,
        documentId: "active-origin-child-document",
        url: `${FRAME_ORIGIN}/embedded`,
      },
    ];
    chrome.tabs.query = vi.fn(async () => [{ id: 7, url: `${ORIGIN}/settings`, windowId: 1 }]);
    chrome.webNavigation.getFrame = vi.fn(async ({ frameId }) =>
      frames.find((frame) => frame.frameId === (frameId ?? 0)));
    chrome.webNavigation.getAllFrames = vi.fn(async () => frames);
    const topRecord = { ...createCaptureRecord("top", "Top"), tabId: 7, frameId: 0 };
    const childRecord = { ...createCaptureRecord("child", "Child"), tabId: 7, frameId: 3 };
    childRecord.origin = FRAME_ORIGIN;
    childRecord.pageUrl = `${FRAME_ORIGIN}/embedded`;
    childRecord.attachment.source.url = childRecord.pageUrl;
    childRecord.attachment.policy.allowedDomains = [FRAME_ORIGIN];
    const readbacks = new Map([
      [ORIGIN, createSessionReadback(topRecord)],
      [FRAME_ORIGIN, createSessionReadback(childRecord, FRAME_ORIGIN)],
    ]);
    const store = createStoreHarness();
    store.read = vi.fn(async (origin) => ({ ok: true, value: readbacks.get(origin)! }));
    store.updateIntent = vi.fn(async (origin, _epoch, _itemId, intent) => {
      const record = origin === FRAME_ORIGIN ? childRecord : topRecord;
      record.intent = intent;
      const value = createSessionReadback(record, origin);
      readbacks.set(origin, value);
      return { ok: true, value };
    });
    const childSender: UiAttachChromeMessageSender = {
      id: chrome.runtime.id,
      url: `${FRAME_ORIGIN}/embedded`,
      frameId: 3,
      documentId: "active-origin-child-document",
      tab: { id: 7, url: `${ORIGIN}/settings`, windowId: 1 },
    };
    const first = createBackgroundController({ chrome, store });
    const childProjection = await restoreAndAcknowledgeProjection(first, childSender);
    await chrome.storage.local.set({
      [CLEAR_PROJECTION_JOURNAL_STORAGE_KEY]: {
        version: 1,
        operations: [{
          version: 1,
          operationId: "active-origin-restart-barrier",
          authority: null,
          request: {
            nonce: "active-origin-restart-request",
            barrierScope: "active-origin",
            endpoint: {
              tabId: 7,
              frameId: 0,
              documentId: "active-origin-top-document",
              origin: ORIGIN,
              pathname: "/settings",
            },
            origins: [{ origin: ORIGIN, beforeEpoch: "epoch-1" }],
          },
          requestedOrigins: [ORIGIN],
          origins: [],
          subjectDiscovery: "complete",
          targets: [{
            subject: {
              tabId: 7,
              frameId: 0,
              documentId: "active-origin-top-document",
              origin: ORIGIN,
              pathname: "/settings",
            },
            removedItemIds: [topRecord.attachment.id],
            projectionId: "active-origin-restart-clear-projection",
            revision: 1,
            state: "pending",
            attemptCount: 0,
            nextAttemptAt: 0,
          }],
        }],
      },
    });
    expect(parseClearProjectionJournal((await chrome.storage.local.get(
      CLEAR_PROJECTION_JOURNAL_STORAGE_KEY,
    ))[CLEAR_PROJECTION_JOURNAL_STORAGE_KEY])).not.toBeNull();
    const restarted = createBackgroundController({ chrome, store });
    vi.mocked(store.updateIntent).mockClear();

    const otherOriginMutation = await dispatchRuntime(restarted, {
      type: UI_ATTACH_OVERLAY_ACTION_REQUEST,
      action: "save",
      itemId: childRecord.attachment.id,
      projection: childProjection,
      taskNote: "other origin remains writable",
    }, childSender);
    expect(otherOriginMutation).toMatchObject({ ok: false, code: "UNTRUSTED_SENDER" });
    expect(otherOriginMutation).not.toMatchObject({ code: "CLEAR_IN_PROGRESS" });
    expect(store.updateIntent).not.toHaveBeenCalled();

    await expect(dispatchRuntime(restarted, {
      type: "ui-attach:session-update-intent",
      origin: ORIGIN,
      epoch: "epoch-1",
      itemId: topRecord.attachment.id,
      intent: "must remain blocked",
    }, createExtensionSender())).resolves.toMatchObject({
      ok: false,
      code: "CLEAR_IN_PROGRESS",
    });
    expect(store.updateIntent).not.toHaveBeenCalled();
    expect(store.clearOrigins).not.toHaveBeenCalled();
  });

  test("late exact ACK after request timeout finalizes C1 and removes the durable journal", async () => {
    const chrome = createChromeHarness();
    configureSingleClearPage(chrome);
    const record = { ...createCaptureRecord("save", "Save changes"), tabId: 7, frameId: 0 };
    const store = createStoreHarness();
    store.read = vi.fn(async () => ({ ok: true, value: createSessionReadback(record) }));
    let tombstone: Record<string, unknown> | null = null;
    chrome.tabs.sendMessage = vi.fn(async (_tabId, message) => {
      if (isRecord(message) && message.type === UI_ATTACH_CLEAR_PROJECTION) tombstone = message;
      return undefined;
    });
    const controller = createBackgroundController({ chrome, store });

    await expect(dispatchRuntime(controller, {
      type: "ui-attach:session-clear",
      origin: ORIGIN,
      epoch: "epoch-1",
      operationId: "clear-late-ack",
    }, createExtensionSender())).resolves.toMatchObject({
      ok: false,
      code: "CONTENT_UNAVAILABLE",
    });
    expect(tombstone).not.toBeNull();
    expect((await chrome.storage.local.get(CLEAR_PROJECTION_JOURNAL_STORAGE_KEY))[
      CLEAR_PROJECTION_JOURNAL_STORAGE_KEY
    ]).toBeDefined();

    await expect(dispatchRuntime(
      controller,
      exactZeroClearAck(tombstone!.clear),
      createExactClearSender(chrome),
    )).resolves.toEqual({ ok: true, data: { accepted: true } });
    expect(await store.listClearOperations()).toEqual({ ok: true, value: [] });
    expect((await chrome.storage.local.get(CLEAR_PROJECTION_JOURNAL_STORAGE_KEY))[
      CLEAR_PROJECTION_JOURNAL_STORAGE_KEY
    ]).toBeUndefined();
  });

  test("C4 same-ID retry after worker recreation reuses the durable ref before discovery", async () => {
    const chrome = createChromeHarness();
    configureSingleClearPage(chrome);
    const record = { ...createCaptureRecord("save", "Save changes"), tabId: 7, frameId: 0 };
    const store = createStoreHarness();
    store.read = vi.fn(async () => ({ ok: true, value: createSessionReadback(record) }));
    const ensureContentScript = vi.fn(async () => true);
    let firstReference: unknown = null;
    chrome.tabs.sendMessage = vi.fn(async (_tabId, message) => {
      if (isRecord(message) && message.type === UI_ATTACH_CLEAR_PROJECTION) {
        firstReference = structuredClone(message.clear);
      }
      return undefined;
    });
    const first = createBackgroundController({ chrome, store, ensureContentScript });

    await expect(dispatchRuntime(first, {
      type: "ui-attach:session-clear",
      origin: ORIGIN,
      epoch: "epoch-1",
      operationId: "clear-c4-retry",
    }, createExtensionSender())).resolves.toMatchObject({
      ok: false,
      code: "CONTENT_UNAVAILABLE",
    });
    expect(firstReference).not.toBeNull();

    vi.mocked(chrome.webNavigation.getAllFrames).mockClear();
    vi.mocked(chrome.tabs.sendMessage).mockClear();
    const restartedEnsure = vi.fn(async () => true);
    let restarted: ReturnType<typeof createBackgroundController>;
    chrome.tabs.sendMessage = vi.fn(async (_tabId, message) => {
      if (isRecord(message) && message.type === UI_ATTACH_CLEAR_PROJECTION) {
        void Promise.resolve().then(() => dispatchRuntime(
          restarted,
          exactZeroClearAck(message.clear),
          createExactClearSender(chrome),
        ));
      }
      return undefined;
    });
    restarted = createBackgroundController({ chrome, store, ensureContentScript: restartedEnsure });

    await expect(dispatchRuntime(restarted, {
      type: "ui-attach:session-clear",
      origin: ORIGIN,
      epoch: "epoch-1",
      operationId: "clear-c4-other",
    }, createExtensionSender())).resolves.toMatchObject({
      ok: false,
      code: "CLEAR_IN_PROGRESS",
    });
    expect(chrome.webNavigation.getAllFrames).not.toHaveBeenCalled();
    expect(vi.mocked(chrome.tabs.sendMessage).mock.calls.some(([, message]) =>
      isRecord(message) && message.type === UI_ATTACH_CLEAR_PROJECTION
    )).toBe(false);
    expect(store.clearOrigins).toHaveBeenCalledTimes(1);

    const retried = await dispatchRuntime(restarted, {
      type: "ui-attach:session-clear",
      origin: ORIGIN,
      epoch: "epoch-1",
      operationId: "clear-c4-retry",
    }, createExtensionSender());

    expect(retried).toMatchObject({
      ok: true,
      data: { clearPending: false, activeClearOperationId: null },
    });
    expect(chrome.webNavigation.getAllFrames).not.toHaveBeenCalled();
    expect(store.clearOrigins).toHaveBeenCalledTimes(1);
    const retriedReference = vi.mocked(chrome.tabs.sendMessage).mock.calls
      .map(([, message]) => isRecord(message) && message.type === UI_ATTACH_CLEAR_PROJECTION
        ? message.clear
        : null)
      .find((value) => value !== null);
    expect(retriedReference).toEqual(firstReference);
    expect(await store.listClearOperations()).toEqual({ ok: true, value: [] });
    expect((await chrome.storage.local.get(CLEAR_PROJECTION_JOURNAL_STORAGE_KEY))[
      CLEAR_PROJECTION_JOURNAL_STORAGE_KEY
    ]).toBeUndefined();
  });

  test("C4 resumes a pre-C1 journal snapshot without rediscovery or a replacement ref", async () => {
    const chrome = createChromeHarness();
    configureSingleClearPage(chrome);
    const operationId = "clear-c4-pre-c1";
    const provisional = boundClearProjectionOperation(operationId, "clear-document");
    provisional.authority = null;
    provisional.origins = [];
    provisional.targets = provisional.targets.map((target) => ({
      ...target,
      state: "pending" as const,
      attemptCount: 0,
      nextAttemptAt: 0,
    }));
    await chrome.storage.local.set({
      [CLEAR_PROJECTION_JOURNAL_STORAGE_KEY]: clearProjectionJournal(provisional),
    });
    const record = { ...createCaptureRecord("save", "Save changes"), tabId: 7, frameId: 0 };
    const store = createStoreHarness();
    store.read = vi.fn(async () => ({ ok: true, value: createSessionReadback(record) }));
    let controller: ReturnType<typeof createBackgroundController>;
    let deliveredReference: Record<string, unknown> | null = null;
    chrome.tabs.sendMessage = vi.fn(async (_tabId, message) => {
      if (isRecord(message) && message.type === UI_ATTACH_CLEAR_PROJECTION &&
          isRecord(message.clear)) {
        deliveredReference = structuredClone(message.clear);
        void Promise.resolve().then(() => dispatchRuntime(
          controller,
          exactZeroClearAck(message.clear),
          createExactClearSender(chrome),
        ));
      }
      return undefined;
    });
    controller = createBackgroundController({ chrome, store });

    await expect(dispatchRuntime(controller, {
      type: "ui-attach:session-clear",
      origin: ORIGIN,
      epoch: "epoch-1",
      operationId,
    }, createExtensionSender())).resolves.toMatchObject({
      ok: true,
      data: { clearPending: false, activeClearOperationId: null },
    });
    expect(chrome.webNavigation.getAllFrames).not.toHaveBeenCalled();
    expect(store.clearOrigins).toHaveBeenCalledTimes(1);
    expect(deliveredReference).toMatchObject({
      operationId,
      projectionId: provisional.targets[0]!.projectionId,
      revision: provisional.targets[0]!.revision,
      subject: provisional.targets[0]!.subject,
    });
  });

  test("C4 generation2 keeps an unbound startup journal linearized with same-ID resume", async () => {
    const chrome = createChromeHarness();
    configureSingleClearPage(chrome);
    const operationId = "clear-c4-startup-race";
    const provisional = boundClearProjectionOperation(operationId, "clear-document");
    provisional.authority = null;
    provisional.origins = [];
    provisional.targets = provisional.targets.map((target) => ({
      ...target,
      state: "pending" as const,
      attemptCount: 0,
      nextAttemptAt: 0,
    }));
    await chrome.storage.local.set({
      [CLEAR_PROJECTION_JOURNAL_STORAGE_KEY]: clearProjectionJournal(provisional),
    });
    const record = { ...createCaptureRecord("save", "Save changes"), tabId: 7, frameId: 0 };
    const store = createStoreHarness();
    store.read = vi.fn(async () => ({ ok: true, value: createSessionReadback(record) }));
    const startupRead = createDeferred<void>();
    const releaseStartupRead = createDeferred<void>();
    const originalListClearOperations = store.listClearOperations;
    let deferFirstCanonicalRead = true;
    store.listClearOperations = vi.fn(async () => {
      if (deferFirstCanonicalRead) {
        deferFirstCanonicalRead = false;
        startupRead.resolve(undefined);
        await releaseStartupRead.promise;
      }
      return originalListClearOperations();
    });
    let controller: ReturnType<typeof createBackgroundController>;
    let deliveredReference: Record<string, unknown> | null = null;
    chrome.tabs.sendMessage = vi.fn(async (_tabId, message) => {
      if (isRecord(message) && message.type === UI_ATTACH_CLEAR_PROJECTION &&
          isRecord(message.clear)) {
        deliveredReference = structuredClone(message.clear);
      }
      return undefined;
    });
    controller = createBackgroundController({ chrome, store });
    controller.register();
    await startupRead.promise;
    await flushAsyncWork();
    vi.mocked(chrome.webNavigation.getAllFrames).mockClear();

    const retry = dispatchRuntime(controller, {
      type: "ui-attach:session-clear",
      origin: ORIGIN,
      epoch: "epoch-1",
      operationId,
    }, createExtensionSender());
    await vi.waitFor(() => expect(store.clearOrigins).toHaveBeenCalledOnce());
    await expect(dispatchRuntime(controller, {
      type: "ui-attach:session-clear",
      origin: ORIGIN,
      epoch: "epoch-1",
      operationId: "clear-c4-startup-other",
    }, createExtensionSender())).resolves.toMatchObject({
      ok: false,
      code: "CLEAR_IN_PROGRESS",
    });
    expect(chrome.webNavigation.getAllFrames).not.toHaveBeenCalled();
    releaseStartupRead.resolve(undefined);
    await vi.waitFor(() => expect(deliveredReference).not.toBeNull());
    await expect(dispatchRuntime(
      controller,
      exactZeroClearAck(deliveredReference),
      createExactClearSender(chrome),
    )).resolves.toEqual({ ok: true, data: { accepted: true } });

    await expect(retry).resolves.toMatchObject({
      ok: true,
      data: { clearPending: false, activeClearOperationId: null },
    });
    expect(store.clearOrigins).toHaveBeenCalledOnce();
    expect(deliveredReference).toMatchObject({
      operationId,
      projectionId: provisional.targets[0]!.projectionId,
      revision: provisional.targets[0]!.revision,
      subject: provisional.targets[0]!.subject,
    });
    expect(await store.listClearOperations()).toEqual({ ok: true, value: [] });
    expect((await chrome.storage.local.get(CLEAR_PROJECTION_JOURNAL_STORAGE_KEY))[
      CLEAR_PROJECTION_JOURNAL_STORAGE_KEY
    ]).toBeUndefined();
  });

  test("C4 generation2 rejects non-primary epoch drift before any C1 clear", async () => {
    const chrome = createChromeHarness();
    configureSingleClearPage(chrome);
    const otherOrigin = "https://other.example.test";
    const operationId = "clear-c4-other-epoch";
    const provisional = boundClearProjectionOperation(operationId, "clear-document");
    provisional.authority = null;
    provisional.request = {
      ...provisional.request!,
      origins: [
        { origin: ORIGIN, beforeEpoch: "epoch-1" },
        { origin: otherOrigin, beforeEpoch: "epoch-2" },
      ],
    };
    provisional.requestedOrigins = [ORIGIN, otherOrigin];
    provisional.origins = [];
    provisional.targets = provisional.targets.map((target) => ({
      ...target,
      state: "pending" as const,
      attemptCount: 0,
      nextAttemptAt: 0,
    }));
    await chrome.storage.local.set({
      [CLEAR_PROJECTION_JOURNAL_STORAGE_KEY]: clearProjectionJournal(provisional),
    });
    const store = createStoreHarness();
    store.read = vi.fn(async (origin) => ({
      ok: true,
      value: {
        ...createSessionReadback(createCaptureRecord("save", "Save changes")),
        origin,
        epoch: origin === otherOrigin ? "epoch-3" : "epoch-1",
      },
    }));
    const controller = createBackgroundController({ chrome, store });

    await expect(dispatchRuntime(controller, {
      type: "ui-attach:session-clear",
      origin: ORIGIN,
      epoch: "epoch-1",
      operationId,
    }, createExtensionSender())).resolves.toMatchObject({
      ok: false,
      code: "STALE_SESSION",
    });
    expect(store.clearOrigins).not.toHaveBeenCalled();
    expect(chrome.webNavigation.getAllFrames).not.toHaveBeenCalled();
    expect((await chrome.storage.local.get(CLEAR_PROJECTION_JOURNAL_STORAGE_KEY))[
      CLEAR_PROJECTION_JOURNAL_STORAGE_KEY
    ]).toBeDefined();
  });

  test.each([
    ["document", "replacement-document", "/settings"],
    ["pathname", "clear-document", "/replacement"],
  ])("C4 generation2 rejects exact request endpoint %s drift", async (_name, documentId, pathname) => {
    const chrome = createChromeHarness();
    configureSingleClearPage(chrome, documentId, pathname);
    const operationId = `clear-c4-endpoint-${_name}`;
    const provisional = boundClearProjectionOperation(operationId, "clear-document");
    provisional.authority = null;
    provisional.origins = [];
    provisional.targets = provisional.targets.map((target) => ({
      ...target,
      state: "pending" as const,
      attemptCount: 0,
      nextAttemptAt: 0,
    }));
    await chrome.storage.local.set({
      [CLEAR_PROJECTION_JOURNAL_STORAGE_KEY]: clearProjectionJournal(provisional),
    });
    const store = createStoreHarness();
    store.read = vi.fn(async () => ({
      ok: true,
      value: createSessionReadback(createCaptureRecord("save", "Save changes")),
    }));
    const controller = createBackgroundController({ chrome, store });

    await expect(dispatchRuntime(controller, {
      type: "ui-attach:session-clear",
      origin: ORIGIN,
      epoch: "epoch-1",
      operationId,
    }, createExtensionSender())).resolves.toMatchObject({
      ok: false,
      code: "ACTIVE_PAGE_UNAVAILABLE",
    });
    expect(store.clearOrigins).not.toHaveBeenCalled();
    expect(chrome.webNavigation.getAllFrames).not.toHaveBeenCalled();
  });

  test("C4 generation2 preserves a legacy unbound journal that lacks request identity", async () => {
    const chrome = createChromeHarness();
    configureSingleClearPage(chrome);
    const operationId = "clear-c4-legacy-request";
    const provisional = boundClearProjectionOperation(operationId, "clear-document") as
      ClearProjectionOperation & { request?: ClearProjectionOperation["request"] };
    provisional.authority = null;
    provisional.origins = [];
    delete provisional.request;
    await chrome.storage.local.set({
      [CLEAR_PROJECTION_JOURNAL_STORAGE_KEY]: clearProjectionJournal(
        provisional as ClearProjectionOperation,
      ),
    });
    const store = createStoreHarness();
    const controller = createBackgroundController({ chrome, store });

    await expect(dispatchRuntime(controller, {
      type: "ui-attach:session-clear",
      origin: ORIGIN,
      epoch: "epoch-1",
      operationId,
    }, createExtensionSender())).resolves.toMatchObject({
      ok: false,
      code: "STORAGE_ERROR",
    });
    expect(store.clearOrigins).not.toHaveBeenCalled();
    expect((await chrome.storage.local.get(CLEAR_PROJECTION_JOURNAL_STORAGE_KEY))[
      CLEAR_PROJECTION_JOURNAL_STORAGE_KEY
    ]).toBeDefined();
  });

  test("C4 generation2 stale empty barrier settlement cannot delete a newer same-ID attempt", async () => {
    const chrome = createChromeHarness();
    configureSingleClearPage(chrome);
    const originalGetAllFrames = chrome.webNavigation.getAllFrames;
    const staleSettleStarted = createDeferred<void>();
    const releaseStaleSettle = createDeferred<void>();
    let captureEmptySettle = false;
    let failFirstDiscovery = true;
    chrome.webNavigation.getAllFrames = vi.fn(async (details) => {
      if (failFirstDiscovery) {
        failFirstDiscovery = false;
        captureEmptySettle = true;
        return undefined;
      }
      return originalGetAllFrames(details);
    });
    const originalStorageGet = chrome.storage.local.get;
    chrome.storage.local.get = vi.fn(async (keys) => {
      if (captureEmptySettle && keys === CLEAR_PROJECTION_JOURNAL_STORAGE_KEY) {
        captureEmptySettle = false;
        const captured = await originalStorageGet(keys);
        staleSettleStarted.resolve(undefined);
        await releaseStaleSettle.promise;
        return captured;
      }
      return originalStorageGet(keys);
    });
    const record = { ...createCaptureRecord("save", "Save changes"), tabId: 7, frameId: 0 };
    const store = createStoreHarness();
    store.read = vi.fn(async () => ({ ok: true, value: createSessionReadback(record) }));
    const c1Started = createDeferred<void>();
    const releaseC1 = createDeferred<void>();
    const originalClearOrigins = store.clearOrigins;
    store.clearOrigins = vi.fn(async (request) => {
      c1Started.resolve(undefined);
      await releaseC1.promise;
      return originalClearOrigins(request);
    });
    let controller: ReturnType<typeof createBackgroundController>;
    chrome.tabs.sendMessage = vi.fn(async (_tabId, message) => {
      if (isRecord(message) && message.type === UI_ATTACH_CLEAR_PROJECTION) {
        void Promise.resolve().then(() => dispatchRuntime(
          controller,
          exactZeroClearAck(message.clear),
          createExactClearSender(chrome),
        ));
      }
      return undefined;
    });
    controller = createBackgroundController({ chrome, store });
    const operationId = "clear-c4-barrier-empty";
    const oldAttempt = dispatchRuntime(controller, {
      type: "ui-attach:session-clear",
      origin: ORIGIN,
      epoch: "epoch-1",
      operationId,
    }, createExtensionSender());
    await staleSettleStarted.promise;

    const newAttempt = dispatchRuntime(controller, {
      type: "ui-attach:session-clear",
      origin: ORIGIN,
      epoch: "epoch-1",
      operationId,
    }, createExtensionSender());
    await c1Started.promise;
    releaseStaleSettle.resolve(undefined);
    await expect(oldAttempt).resolves.toMatchObject({
      ok: false,
      code: "ACTIVE_PAGE_UNAVAILABLE",
    });
    await expect(dispatchRuntime(controller, {
      type: "ui-attach:session-remove-item",
      origin: ORIGIN,
      epoch: "epoch-1",
      itemId: record.attachment.id,
    }, createExtensionSender())).resolves.toMatchObject({
      ok: false,
      code: "CLEAR_IN_PROGRESS",
    });
    expect(store.removeItem).not.toHaveBeenCalled();
    releaseC1.resolve(undefined);
    await expect(newAttempt).resolves.toMatchObject({
      ok: true,
      data: { clearPending: false, activeClearOperationId: null },
    });
  });

  test("C4 generation2 stale nonempty barrier settlement cannot revive a finalized attempt", async () => {
    const chrome = createChromeHarness();
    configureSingleClearPage(chrome);
    const staleSettleStarted = createDeferred<void>();
    const releaseStaleSettle = createDeferred<void>();
    const originalStorageGet = chrome.storage.local.get;
    let captureNonemptySettle = false;
    chrome.storage.local.get = vi.fn(async (keys) => {
      if (captureNonemptySettle && keys === CLEAR_PROJECTION_JOURNAL_STORAGE_KEY) {
        captureNonemptySettle = false;
        const captured = await originalStorageGet(keys);
        staleSettleStarted.resolve(undefined);
        await releaseStaleSettle.promise;
        return captured;
      }
      return originalStorageGet(keys);
    });
    const record = { ...createCaptureRecord("save", "Save changes"), tabId: 7, frameId: 0 };
    const store = createStoreHarness();
    store.read = vi.fn(async () => ({ ok: true, value: createSessionReadback(record) }));
    let tombstone: Record<string, unknown> | null = null;
    chrome.tabs.sendMessage = vi.fn(async (_tabId, message) => {
      if (isRecord(message) && message.type === UI_ATTACH_CLEAR_PROJECTION &&
          isRecord(message.clear)) {
        tombstone = structuredClone(message.clear);
        captureNonemptySettle = true;
      }
      return undefined;
    });
    const controller = createBackgroundController({ chrome, store });
    const clearing = dispatchRuntime(controller, {
      type: "ui-attach:session-clear",
      origin: ORIGIN,
      epoch: "epoch-1",
      operationId: "clear-c4-barrier-nonempty",
    }, createExtensionSender());
    await staleSettleStarted.promise;
    await expect(dispatchRuntime(
      controller,
      exactZeroClearAck(tombstone),
      createExactClearSender(chrome),
    )).resolves.toEqual({ ok: true, data: { accepted: true } });
    expect((await originalStorageGet(CLEAR_PROJECTION_JOURNAL_STORAGE_KEY))[
      CLEAR_PROJECTION_JOURNAL_STORAGE_KEY
    ]).toBeUndefined();
    releaseStaleSettle.resolve(undefined);
    await expect(clearing).resolves.toMatchObject({
      ok: false,
      code: "CONTENT_UNAVAILABLE",
    });

    await expect(dispatchRuntime(controller, {
      type: "ui-attach:session-remove-item",
      origin: ORIGIN,
      epoch: "epoch-1",
      itemId: record.attachment.id,
    }, createExtensionSender())).resolves.not.toMatchObject({ code: "CLEAR_IN_PROGRESS" });
    expect(store.removeItem).toHaveBeenCalledOnce();
  });

  test.each([
    ["document", "replacement-document", "/settings"],
    ["pathname", "clear-document", "/replacement"],
  ])("C4 generation3 fences panel pre-C1 resume across %s navigation during store.read", async (
    _name,
    nextDocumentId,
    nextPathname,
  ) => {
    const chrome = createChromeHarness();
    configureSingleClearPage(chrome);
    const operationId = `clear-c4-resume-nav-${_name}`;
    const provisional = boundClearProjectionOperation(operationId, "clear-document");
    provisional.authority = null;
    provisional.origins = [];
    provisional.targets = provisional.targets.map((target) => ({
      ...target,
      state: "pending" as const,
      attemptCount: 0,
      nextAttemptAt: 0,
    }));
    const durableBefore = clearProjectionJournal(provisional);
    await chrome.storage.local.set({
      [CLEAR_PROJECTION_JOURNAL_STORAGE_KEY]: durableBefore,
    });
    const store = createStoreHarness();
    const readStarted = createDeferred<void>();
    const releaseRead = createDeferred<void>();
    store.read = vi.fn(async () => {
      readStarted.resolve(undefined);
      await releaseRead.promise;
      return {
        ok: true,
        value: createSessionReadback(createCaptureRecord("save", "Save changes")),
      };
    });
    const controller = createBackgroundController({ chrome, store });
    const clearing = dispatchRuntime(controller, {
      type: "ui-attach:session-clear",
      origin: ORIGIN,
      epoch: "epoch-1",
      operationId,
    }, createExtensionSender());
    await readStarted.promise;
    configureSingleClearPage(chrome, nextDocumentId, nextPathname);
    const navigation = controller.handleNavigationCommitted({
      tabId: 7,
      frameId: 0,
      documentId: nextDocumentId,
      url: `${ORIGIN}${nextPathname}`,
    });
    releaseRead.resolve(undefined);

    await expect(clearing).resolves.toMatchObject({ ok: false });
    expect(store.clearOrigins).not.toHaveBeenCalled();
    await navigation;
    expect((await chrome.storage.local.get(CLEAR_PROJECTION_JOURNAL_STORAGE_KEY))[
      CLEAR_PROJECTION_JOURNAL_STORAGE_KEY
    ]).toEqual(durableBefore);
  });

  test("C4 generation3 fences widget pre-C1 resume when its cached document navigates", async () => {
    const fixture = await createInPageWidgetFixture();
    const operationId = "clear-c4-widget-resume-nav";
    const provisional = boundClearProjectionOperation(operationId, WIDGET_TOP_DOCUMENT_ID);
    provisional.authority = null;
    provisional.request = {
      ...provisional.request!,
      endpoint: {
        ...provisional.request!.endpoint,
        tabId: WIDGET_TAB_ID,
        documentId: WIDGET_TOP_DOCUMENT_ID,
      },
    };
    provisional.origins = [];
    provisional.targets = provisional.targets.map((target) => ({
      ...target,
      subject: {
        ...target.subject,
        tabId: WIDGET_TAB_ID,
        documentId: WIDGET_TOP_DOCUMENT_ID,
      },
      state: "pending" as const,
      attemptCount: 0,
      nextAttemptAt: 0,
    }));
    const durableBefore = clearProjectionJournal(provisional);
    await fixture.chrome.storage.local.set({
      [CLEAR_PROJECTION_JOURNAL_STORAGE_KEY]: durableBefore,
    });
    const readStarted = createDeferred<void>();
    const releaseRead = createDeferred<void>();
    fixture.store.read = vi.fn(async () => {
      readStarted.resolve(undefined);
      await releaseRead.promise;
      return {
        ok: true,
        value: createSessionReadback(createCaptureRecord("save", "Save changes")),
      };
    });
    const clearing = dispatchRuntime(
      fixture.controller,
      createInPageWidgetCommandEnvelope(fixture.init, {
        type: "ui-attach:widget-session-clear",
        expectedEpoch: "epoch-1",
        operationId,
        scope: "live-page",
      }),
      fixture.widgetSender,
    );
    await readStarted.promise;
    fixture.frameState.topDocumentId = "widget-replacement-document";
    const navigation = fixture.controller.handleNavigationCommitted({
      tabId: WIDGET_TAB_ID,
      frameId: 0,
      documentId: "widget-replacement-document",
      url: `${ORIGIN}/settings`,
    });
    releaseRead.resolve(undefined);

    await expect(clearing).resolves.toMatchObject({ ok: false });
    expect(fixture.store.clearOrigins).not.toHaveBeenCalled();
    await navigation;
    expect((await fixture.chrome.storage.local.get(CLEAR_PROJECTION_JOURNAL_STORAGE_KEY))[
      CLEAR_PROJECTION_JOURNAL_STORAGE_KEY
    ]).toEqual(durableBefore);
  });

  test("C4 generation3 fences fresh panel clear when navigation lands during C3 prepare", async () => {
    const chrome = createChromeHarness();
    configureSingleClearPage(chrome);
    const record = { ...createCaptureRecord("save", "Save changes"), tabId: 7, frameId: 0 };
    const store = createStoreHarness();
    store.read = vi.fn(async () => ({ ok: true, value: createSessionReadback(record) }));
    const preparePersisted = createDeferred<void>();
    const releasePrepare = createDeferred<void>();
    const originalStorageSet = chrome.storage.local.set;
    chrome.storage.local.set = vi.fn(async (values) => {
      await originalStorageSet(values);
      if (Object.hasOwn(values, CLEAR_PROJECTION_JOURNAL_STORAGE_KEY)) {
        preparePersisted.resolve(undefined);
        await releasePrepare.promise;
      }
    });
    const controller = createBackgroundController({ chrome, store });
    const clearing = dispatchRuntime(controller, {
      type: "ui-attach:session-clear",
      origin: ORIGIN,
      epoch: "epoch-1",
      operationId: "clear-c4-fresh-panel-nav",
    }, createExtensionSender());
    await preparePersisted.promise;
    configureSingleClearPage(chrome, "replacement-document", "/replacement");
    const navigation = controller.handleNavigationCommitted({
      tabId: 7,
      frameId: 0,
      documentId: "replacement-document",
      url: `${ORIGIN}/replacement`,
    });
    releasePrepare.resolve(undefined);

    await expect(clearing).resolves.toMatchObject({ ok: false });
    expect(store.clearOrigins).not.toHaveBeenCalled();
    await navigation;
    expect((await chrome.storage.local.get(CLEAR_PROJECTION_JOURNAL_STORAGE_KEY))[
      CLEAR_PROJECTION_JOURNAL_STORAGE_KEY
    ]).toBeUndefined();
    expect(await store.listClearOperations()).toEqual({ ok: true, value: [] });
    store.clearOrigins = vi.fn(async () => ({
      ok: false as const,
      code: "STORAGE_ERROR" as const,
      error: "stop after proving the replacement clear reached C1",
    }));
    await expect(dispatchRuntime(controller, {
      type: "ui-attach:session-clear",
      origin: ORIGIN,
      epoch: "epoch-1",
      operationId: "clear-c4-fresh-panel-nav-replacement",
    }, createExtensionSender())).resolves.toMatchObject({
      ok: false,
      code: "STORAGE_ERROR",
    });
    expect(store.clearOrigins).toHaveBeenCalledWith(expect.objectContaining({
      operationId: "clear-c4-fresh-panel-nav-replacement",
    }));
  });

  test("C4 generation3 fences fresh widget clear after cached page navigation", async () => {
    const fixture = await createInPageWidgetFixture();
    const preparePersisted = createDeferred<void>();
    const releasePrepare = createDeferred<void>();
    const originalStorageSet = fixture.chrome.storage.local.set;
    fixture.chrome.storage.local.set = vi.fn(async (values) => {
      await originalStorageSet(values);
      if (Object.hasOwn(values, CLEAR_PROJECTION_JOURNAL_STORAGE_KEY)) {
        preparePersisted.resolve(undefined);
        await releasePrepare.promise;
      }
    });
    const clearing = dispatchRuntime(
      fixture.controller,
      createInPageWidgetCommandEnvelope(fixture.init, {
        type: "ui-attach:widget-session-clear",
        expectedEpoch: "epoch-1",
        operationId: "clear-c4-fresh-widget-nav",
        scope: "live-page",
      }),
      fixture.widgetSender,
    );
    await preparePersisted.promise;
    fixture.frameState.topDocumentId = "widget-replacement-document";
    const navigation = fixture.controller.handleNavigationCommitted({
      tabId: WIDGET_TAB_ID,
      frameId: 0,
      documentId: "widget-replacement-document",
      url: `${ORIGIN}/settings`,
    });
    releasePrepare.resolve(undefined);

    await expect(clearing).resolves.toMatchObject({ ok: false });
    expect(fixture.store.clearOrigins).not.toHaveBeenCalled();
    await navigation;
    expect((await fixture.chrome.storage.local.get(CLEAR_PROJECTION_JOURNAL_STORAGE_KEY))[
      CLEAR_PROJECTION_JOURNAL_STORAGE_KEY
    ]).toBeUndefined();
    expect(await fixture.store.listClearOperations()).toEqual({ ok: true, value: [] });
    fixture.store.clearOrigins = vi.fn(async () => ({
      ok: false as const,
      code: "STORAGE_ERROR" as const,
      error: "stop after proving the replacement clear reached C1",
    }));
    await expect(dispatchRuntime(fixture.controller, {
      type: "ui-attach:session-clear",
      origin: ORIGIN,
      epoch: "epoch-1",
      operationId: "clear-c4-fresh-widget-nav-replacement",
    }, createExtensionSender())).resolves.toMatchObject({
      ok: false,
      code: "STORAGE_ERROR",
    });
    expect(fixture.store.clearOrigins).toHaveBeenCalledWith(expect.objectContaining({
      operationId: "clear-c4-fresh-widget-nav-replacement",
    }));
  });

  test("C4 generation3 fences fresh multi-frame clear on child document replacement", async () => {
    const chrome = createChromeHarness();
    const childRecord = { ...createCaptureRecord("child", "Child"), tabId: 7, frameId: 3 };
    childRecord.pageUrl = `${ORIGIN}/child`;
    const topRecord = { ...createCaptureRecord("top", "Top"), tabId: 7, frameId: 0 };
    chrome.tabs.query = vi.fn(async () => [{ id: 7, url: `${ORIGIN}/settings`, windowId: 1 }]);
    chrome.webNavigation.getAllFrames = vi.fn(async () => [
      { frameId: 0, parentFrameId: -1, documentId: "top-document", url: `${ORIGIN}/settings` },
      { frameId: 3, parentFrameId: 0, documentId: "child-document", url: `${ORIGIN}/child` },
    ]);
    chrome.webNavigation.getFrame = vi.fn(async ({ frameId }) => frameId === 3
      ? { frameId: 3, parentFrameId: 0, documentId: "child-document", url: `${ORIGIN}/child` }
      : { frameId: 0, parentFrameId: -1, documentId: "top-document", url: `${ORIGIN}/settings` });
    const store = createStoreHarness();
    store.read = vi.fn(async () => ({
      ok: true,
      value: createSessionReadbackMany([topRecord, childRecord]),
    }));
    const preparePersisted = createDeferred<void>();
    const releasePrepare = createDeferred<void>();
    const originalStorageSet = chrome.storage.local.set;
    chrome.storage.local.set = vi.fn(async (values) => {
      await originalStorageSet(values);
      if (Object.hasOwn(values, CLEAR_PROJECTION_JOURNAL_STORAGE_KEY)) {
        preparePersisted.resolve(undefined);
        await releasePrepare.promise;
      }
    });
    const controller = createBackgroundController({ chrome, store });
    const clearing = dispatchRuntime(controller, {
      type: "ui-attach:session-clear",
      origin: ORIGIN,
      epoch: "epoch-1",
      operationId: "clear-c4-fresh-child-nav",
    }, createExtensionSender());
    await preparePersisted.promise;
    const navigation = controller.handleNavigationCommitted({
      tabId: 7,
      frameId: 3,
      documentId: "child-replacement-document",
      url: `${ORIGIN}/child`,
    });
    releasePrepare.resolve(undefined);

    await expect(clearing).resolves.toMatchObject({ ok: false });
    expect(store.clearOrigins).not.toHaveBeenCalled();
    await navigation;
    expect((await chrome.storage.local.get(CLEAR_PROJECTION_JOURNAL_STORAGE_KEY))[
      CLEAR_PROJECTION_JOURNAL_STORAGE_KEY
    ]).toBeUndefined();
    expect(await store.listClearOperations()).toEqual({ ok: true, value: [] });
    store.clearOrigins = vi.fn(async () => ({
      ok: false as const,
      code: "STORAGE_ERROR" as const,
      error: "stop after proving the replacement clear reached C1",
    }));
    await expect(dispatchRuntime(controller, {
      type: "ui-attach:session-clear",
      origin: ORIGIN,
      epoch: "epoch-1",
      operationId: "clear-c4-fresh-child-nav-replacement",
    }, createExtensionSender())).resolves.toMatchObject({
      ok: false,
      code: "STORAGE_ERROR",
    });
    expect(store.clearOrigins).toHaveBeenCalledWith(expect.objectContaining({
      operationId: "clear-c4-fresh-child-nav-replacement",
    }));
  });

  test("C4 generation4 retires a crash-cut modern unbound request after worker restart sees endpoint replacement", async () => {
    const chrome = createChromeHarness();
    configureSingleClearPage(chrome, "replacement-document", "/replacement");
    const operationId = "clear-c4-restart-retire";
    const provisional = boundClearProjectionOperation(operationId, "clear-document");
    provisional.authority = null;
    provisional.origins = [];
    provisional.targets = provisional.targets.map((target) => ({
      ...target,
      state: "pending" as const,
      attemptCount: 0,
      nextAttemptAt: 0,
    }));
    await chrome.storage.local.set({
      [CLEAR_PROJECTION_JOURNAL_STORAGE_KEY]: clearProjectionJournal(provisional),
    });
    const store = createStoreHarness();
    const controller = createBackgroundController({ chrome, store });
    controller.register();

    await vi.waitFor(async () => expect((await chrome.storage.local.get(
      CLEAR_PROJECTION_JOURNAL_STORAGE_KEY,
    ))[CLEAR_PROJECTION_JOURNAL_STORAGE_KEY]).toBeUndefined());
    expect(store.clearOrigins).not.toHaveBeenCalled();

    store.clearOrigins = vi.fn(async () => ({
      ok: false as const,
      code: "STORAGE_ERROR" as const,
      error: "stop after proving the replacement clear reached C1",
    }));
    await expect(dispatchRuntime(controller, {
      type: "ui-attach:session-clear",
      origin: ORIGIN,
      epoch: "epoch-1",
      operationId: "clear-c4-after-restart-retire",
    }, createExtensionSender())).resolves.toMatchObject({
      ok: false,
      code: "STORAGE_ERROR",
    });
    expect(store.clearOrigins).toHaveBeenCalledWith(expect.objectContaining({
      operationId: "clear-c4-after-restart-retire",
    }));
  });

  test("C4 generation4 serializes provisional retirement before same-ID retry can create C1", async () => {
    const chrome = createChromeHarness();
    configureSingleClearPage(chrome);
    const record = { ...createCaptureRecord("save", "Save changes"), tabId: 7, frameId: 0 };
    const store = createStoreHarness();
    store.read = vi.fn(async () => ({ ok: true, value: createSessionReadback(record) }));
    store.clearOrigins = vi.fn(async (request) => {
      const durable = (await chrome.storage.local.get(CLEAR_PROJECTION_JOURNAL_STORAGE_KEY))[
        CLEAR_PROJECTION_JOURNAL_STORAGE_KEY
      ] as { operations?: ClearProjectionOperation[] } | undefined;
      expect(durable?.operations?.[0]?.request?.endpoint.documentId).toBe("replacement-document");
      expect(durable?.operations?.[0]?.operationId).toBe(request.operationId);
      return {
        ok: false as const,
        code: "STORAGE_ERROR" as const,
        error: "stop after observing serialized C1 admission",
      };
    });
    const preparePersisted = createDeferred<void>();
    const releasePrepare = createDeferred<void>();
    const removeStarted = createDeferred<void>();
    const releaseRemove = createDeferred<void>();
    const originalStorageSet = chrome.storage.local.set;
    chrome.storage.local.set = vi.fn(async (values) => {
      await originalStorageSet(values);
      if (Object.hasOwn(values, CLEAR_PROJECTION_JOURNAL_STORAGE_KEY)) {
        preparePersisted.resolve(undefined);
        await releasePrepare.promise;
      }
    });
    const originalStorageRemove = chrome.storage.local.remove;
    let pauseFirstProjectionRemove = true;
    chrome.storage.local.remove = vi.fn(async (keys) => {
      if (pauseFirstProjectionRemove && (
        keys === CLEAR_PROJECTION_JOURNAL_STORAGE_KEY ||
        (Array.isArray(keys) && keys.includes(CLEAR_PROJECTION_JOURNAL_STORAGE_KEY))
      )) {
        pauseFirstProjectionRemove = false;
        removeStarted.resolve(undefined);
        await releaseRemove.promise;
      }
      await originalStorageRemove(keys);
    });
    const controller = createBackgroundController({ chrome, store });
    const command = {
      type: "ui-attach:session-clear" as const,
      origin: ORIGIN,
      epoch: "epoch-1",
      operationId: "clear-c4-retire-same-id",
    };
    const clearing = dispatchRuntime(controller, command, createExtensionSender());
    await preparePersisted.promise;
    configureSingleClearPage(chrome, "replacement-document", "/replacement");
    const navigation = controller.handleNavigationCommitted({
      tabId: 7,
      frameId: 0,
      documentId: "replacement-document",
      url: `${ORIGIN}/replacement`,
    });
    releasePrepare.resolve(undefined);
    await vi.waitFor(() => expect(chrome.storage.local.remove).toHaveBeenCalled());
    await removeStarted.promise;

    const retry = dispatchRuntime(controller, command, createExtensionSender());
    await flushMicrotasks();
    expect(store.clearOrigins).not.toHaveBeenCalled();
    releaseRemove.resolve(undefined);

    await expect(clearing).resolves.toMatchObject({ ok: false });
    await navigation;
    await expect(retry).resolves.toMatchObject({ ok: false, code: "STORAGE_ERROR" });
    expect(store.clearOrigins).toHaveBeenCalledTimes(1);
    expect(await store.listClearOperations()).toEqual({ ok: true, value: [] });
  });

  test("C4 generation4 preserves fail-closed pending state when provisional retirement storage fails", async () => {
    const chrome = createChromeHarness();
    configureSingleClearPage(chrome);
    const record = { ...createCaptureRecord("save", "Save changes"), tabId: 7, frameId: 0 };
    const store = createStoreHarness();
    store.read = vi.fn(async () => ({ ok: true, value: createSessionReadback(record) }));
    const preparePersisted = createDeferred<void>();
    const releasePrepare = createDeferred<void>();
    const originalStorageSet = chrome.storage.local.set;
    chrome.storage.local.set = vi.fn(async (values) => {
      await originalStorageSet(values);
      if (Object.hasOwn(values, CLEAR_PROJECTION_JOURNAL_STORAGE_KEY)) {
        preparePersisted.resolve(undefined);
        await releasePrepare.promise;
      }
    });
    const originalStorageRemove = chrome.storage.local.remove;
    chrome.storage.local.remove = vi.fn(async (keys) => {
      if (keys === CLEAR_PROJECTION_JOURNAL_STORAGE_KEY ||
          (Array.isArray(keys) && keys.includes(CLEAR_PROJECTION_JOURNAL_STORAGE_KEY))) {
        throw new Error("provisional retirement storage failure");
      }
      await originalStorageRemove(keys);
    });
    const controller = createBackgroundController({ chrome, store });
    const clearing = dispatchRuntime(controller, {
      type: "ui-attach:session-clear",
      origin: ORIGIN,
      epoch: "epoch-1",
      operationId: "clear-c4-retire-remove-fault",
    }, createExtensionSender());
    await preparePersisted.promise;
    const durableBefore = (await chrome.storage.local.get(CLEAR_PROJECTION_JOURNAL_STORAGE_KEY))[
      CLEAR_PROJECTION_JOURNAL_STORAGE_KEY
    ];
    configureSingleClearPage(chrome, "replacement-document", "/replacement");
    const navigation = controller.handleNavigationCommitted({
      tabId: 7,
      frameId: 0,
      documentId: "replacement-document",
      url: `${ORIGIN}/replacement`,
    });
    releasePrepare.resolve(undefined);

    await expect(clearing).resolves.toMatchObject({ ok: false, code: "STORAGE_ERROR" });
    await navigation;
    expect(chrome.storage.local.remove).toHaveBeenCalled();
    expect((await chrome.storage.local.get(CLEAR_PROJECTION_JOURNAL_STORAGE_KEY))[
      CLEAR_PROJECTION_JOURNAL_STORAGE_KEY
    ]).toEqual(durableBefore);
    expect(store.clearOrigins).not.toHaveBeenCalled();
    await expect(dispatchRuntime(controller, {
      type: "ui-attach:session-clear",
      origin: ORIGIN,
      epoch: "epoch-1",
      operationId: "clear-c4-retire-remove-fault-new-id",
    }, createExtensionSender())).resolves.toMatchObject({
      ok: false,
      code: "CLEAR_IN_PROGRESS",
    });
  });

  test("C4 generation4 never retires a legacy unbound request after endpoint replacement", async () => {
    const chrome = createChromeHarness();
    configureSingleClearPage(chrome, "replacement-document", "/replacement");
    const provisional = boundClearProjectionOperation("clear-c4-legacy-unbound", "clear-document");
    provisional.authority = null;
    provisional.request = null;
    provisional.origins = [];
    const durableBefore = clearProjectionJournal(provisional);
    await chrome.storage.local.set({
      [CLEAR_PROJECTION_JOURNAL_STORAGE_KEY]: durableBefore,
    });
    const store = createStoreHarness();
    const controller = createBackgroundController({ chrome, store });
    controller.register();
    await flushAsyncWork();

    expect((await chrome.storage.local.get(CLEAR_PROJECTION_JOURNAL_STORAGE_KEY))[
      CLEAR_PROJECTION_JOURNAL_STORAGE_KEY
    ]).toEqual(durableBefore);
    expect(store.clearOrigins).not.toHaveBeenCalled();
    expect(chrome.storage.local.remove).not.toHaveBeenCalledWith(CLEAR_PROJECTION_JOURNAL_STORAGE_KEY);
  });

  test("C4 generation5 preserves newer same-ID C3 when cross-context C1 creation lands inside retirement RMW", async () => {
    const chrome = createChromeHarness();
    configureSingleClearPage(chrome);
    const record = { ...createCaptureRecord("save", "Save changes"), tabId: 7, frameId: 0 };
    const store = createStoreHarness();
    store.read = vi.fn(async () => ({ ok: true, value: createSessionReadback(record) }));
    let canonicalOperations: CaptureClearOperationV1[] = [];
    store.listClearOperations = vi.fn(async () => ({
      ok: true,
      value: structuredClone(canonicalOperations),
    }));
    const preparePersisted = createDeferred<void>();
    const releasePrepare = createDeferred<void>();
    const originalStorageGet = chrome.storage.local.get;
    const originalStorageSet = chrome.storage.local.set;
    let replacementArmed = false;
    let retirementJournalReads = 0;
    let newerJournal: { version: 1; operations: ClearProjectionOperation[] } | null = null;
    chrome.storage.local.get = vi.fn(async (keys) => {
      if (replacementArmed && keys === CLEAR_PROJECTION_JOURNAL_STORAGE_KEY) {
        retirementJournalReads += 1;
        if (retirementJournalReads === 3) {
          const durable = (await originalStorageGet(keys))[
            CLEAR_PROJECTION_JOURNAL_STORAGE_KEY
          ] as { version: 1; operations: ClearProjectionOperation[] };
          const newer = structuredClone(durable.operations[0]!);
          newer.request!.nonce = "request-newer-cross-context";
          newer.request!.endpoint.documentId = "replacement-document";
          newer.request!.endpoint.pathname = "/replacement";
          newer.targets = newer.targets.map((target) => ({
            ...target,
            subject: {
              ...target.subject,
              documentId: "replacement-document",
              pathname: "/replacement",
            },
          }));
          newerJournal = { version: 1, operations: [newer] };
          canonicalOperations = [{
            version: 1,
            operationId: newer.operationId,
            authorityId: "authority-newer-cross-context",
            generation: 2,
            phase: "canonical_committed",
            origins: [{
              origin: ORIGIN,
              beforeEpoch: "epoch-1",
              afterEpoch: "epoch-newer-cross-context",
              canonical: "committed",
            }],
            createdAt: "2026-08-18T00:00:00.000Z",
            updatedAt: "2026-08-18T00:00:01.000Z",
          }];
          await originalStorageSet({
            [CLEAR_PROJECTION_JOURNAL_STORAGE_KEY]: newerJournal,
          });
        }
      }
      return originalStorageGet(keys);
    });
    chrome.storage.local.set = vi.fn(async (values) => {
      await originalStorageSet(values);
      if (Object.hasOwn(values, CLEAR_PROJECTION_JOURNAL_STORAGE_KEY)) {
        preparePersisted.resolve(undefined);
        await releasePrepare.promise;
      }
    });
    const controller = createBackgroundController({ chrome, store });
    const operationId = "clear-c4-cross-context-retire";
    const clearing = dispatchRuntime(controller, {
      type: "ui-attach:session-clear",
      origin: ORIGIN,
      epoch: "epoch-1",
      operationId,
    }, createExtensionSender());
    await preparePersisted.promise;
    configureSingleClearPage(chrome, "replacement-document", "/replacement");
    const navigation = controller.handleNavigationCommitted({
      tabId: 7,
      frameId: 0,
      documentId: "replacement-document",
      url: `${ORIGIN}/replacement`,
    });
    replacementArmed = true;
    releasePrepare.resolve(undefined);

    await expect(clearing).resolves.toMatchObject({ ok: false, code: "STORAGE_ERROR" });
    expect(store.clearOrigins).not.toHaveBeenCalled();
    await navigation;
    expect(newerJournal).not.toBeNull();
    expect((await originalStorageGet(CLEAR_PROJECTION_JOURNAL_STORAGE_KEY))[
      CLEAR_PROJECTION_JOURNAL_STORAGE_KEY
    ]).toEqual(newerJournal);
    await expect(store.listClearOperations()).resolves.toEqual({
      ok: true,
      value: canonicalOperations,
    });
  });

  test("send failure stays durable and an exact restore wake retries after worker recreation", async () => {
    const clock = vi.spyOn(Date, "now").mockReturnValue(2_000_000);
    try {
      const chrome = createChromeHarness();
      configureSingleClearPage(chrome);
      const record = { ...createCaptureRecord("save", "Save changes"), tabId: 7, frameId: 0 };
      const store = createStoreHarness();
      store.read = vi.fn(async () => ({ ok: true, value: createSessionReadback(record) }));
      chrome.tabs.sendMessage = vi.fn(async (_tabId, message) => {
        if (isRecord(message) && message.type === UI_ATTACH_CLEAR_PROJECTION) {
          throw new Error("content unavailable");
        }
        return undefined;
      });
      const first = createBackgroundController({ chrome, store });
      await expect(dispatchRuntime(first, {
        type: "ui-attach:session-clear",
        origin: ORIGIN,
        epoch: "epoch-1",
        operationId: "clear-restart-retry",
      }, createExtensionSender())).resolves.toMatchObject({
        ok: false,
        code: "CONTENT_UNAVAILABLE",
      });
      expect((await chrome.storage.local.get(CLEAR_PROJECTION_JOURNAL_STORAGE_KEY))[
        CLEAR_PROJECTION_JOURNAL_STORAGE_KEY
      ]).toBeDefined();

      let restarted: ReturnType<typeof createBackgroundController>;
      let retried = false;
      chrome.tabs.sendMessage = vi.fn(async (_tabId, message) => {
        if (isRecord(message) && message.type === UI_ATTACH_CLEAR_PROJECTION) {
          retried = true;
          void Promise.resolve().then(() => dispatchRuntime(
            restarted,
            exactZeroClearAck(message.clear),
            createExactClearSender(chrome),
          ));
        }
        return undefined;
      });
      restarted = createBackgroundController({ chrome, store });
      clock.mockReturnValue(2_001_000);
      await dispatchRuntime(
        restarted,
        { type: "ui-attach:overlays-restore-get" },
        createExactClearSender(chrome),
      );
      await vi.waitFor(() => expect(
        retried && vi.mocked(store.finalizeClearOperation).mock.calls.length > 0,
      ).toBe(true));
      await flushAsyncWork();
      expect((await chrome.storage.local.get(CLEAR_PROJECTION_JOURNAL_STORAGE_KEY))[
        CLEAR_PROJECTION_JOURNAL_STORAGE_KEY
      ]).toBeUndefined();
    } finally {
      clock.mockRestore();
    }
  });

  test("startup binds a pre-C1 target snapshot after a crash cut between canonical commit and C3 bind", async () => {
    const chrome = createChromeHarness();
    configureSingleClearPage(chrome);
    await chrome.storage.local.set({
      [CLEAR_PROJECTION_JOURNAL_STORAGE_KEY]: {
        version: 1,
        operations: [{
          version: 1,
          operationId: "clear-crash-cut",
          authority: null,
          requestedOrigins: [ORIGIN],
          origins: [],
          subjectDiscovery: "complete",
          targets: [{
            subject: {
              tabId: 7,
              frameId: 0,
              documentId: "clear-document",
              origin: ORIGIN,
              pathname: "/settings",
            },
            removedItemIds: ["att_save"],
            projectionId: "crash-cut-projection",
            revision: 1,
            state: "pending",
            attemptCount: 0,
            nextAttemptAt: 0,
          }],
        }],
      },
    });
    const canonical: CaptureClearOperationV1 = {
      version: 1,
      operationId: "clear-crash-cut",
      authorityId: "crash-cut-authority",
      generation: 7,
      phase: "canonical_committed",
      origins: [{
        origin: ORIGIN,
        beforeEpoch: "epoch-1",
        afterEpoch: "epoch-after-crash-cut",
        canonical: "committed",
      }],
      createdAt: "2026-08-18T00:00:00.000Z",
      updatedAt: "2026-08-18T00:00:00.000Z",
    };
    const store = createStoreHarness();
    let activeCanonical: CaptureClearOperationV1 | null = canonical;
    store.listClearOperations = vi.fn(async () => ({
      ok: true,
      value: activeCanonical ? [structuredClone(activeCanonical)] : [],
    }));
    store.finalizeClearOperation = vi.fn(async () => {
      const finalized = activeCanonical!;
      activeCanonical = null;
      return { ok: true, value: finalized };
    });
    let controller: ReturnType<typeof createBackgroundController>;
    chrome.tabs.sendMessage = vi.fn(async (_tabId, message) => {
      if (isRecord(message) && message.type === UI_ATTACH_CLEAR_PROJECTION) {
        void Promise.resolve().then(() => dispatchRuntime(
          controller,
          exactZeroClearAck(message.clear),
          createExactClearSender(chrome),
        ));
      }
      return undefined;
    });
    controller = createBackgroundController({ chrome, store });
    controller.register();

    await waitFor(() => vi.mocked(chrome.tabs.sendMessage).mock.calls.some(([, message]) =>
      isRecord(message) && message.type === UI_ATTACH_CLEAR_PROJECTION
    ));
    await waitFor(() => activeCanonical === null);
    await flushAsyncWork();
    expect(store.clearOrigins).not.toHaveBeenCalled();
    expect((await chrome.storage.local.get(CLEAR_PROJECTION_JOURNAL_STORAGE_KEY))[
      CLEAR_PROJECTION_JOURNAL_STORAGE_KEY
    ]).toBeUndefined();
  });

  test("drains a due 33rd target and schedules durable alarm retry without another wake", async () => {
    const chrome = createChromeHarness();
    const frames = Array.from({ length: 33 }, (_, frameId) => ({
      frameId,
      parentFrameId: frameId === 0 ? -1 : 0,
      documentId: `alarm-document-${String(frameId).padStart(2, "0")}`,
      url: `${ORIGIN}/alarm/${frameId}`,
    }));
    chrome.webNavigation.getFrame = vi.fn(async ({ frameId }) =>
      frames.find((frame) => frame.frameId === (frameId ?? 0)));
    await chrome.storage.local.set({
      [CLEAR_PROJECTION_JOURNAL_STORAGE_KEY]: {
        version: 1,
        operations: [{
          version: 1,
          operationId: "clear-alarm-batch",
          authority: {
            authorityId: "alarm-authority",
            operationId: "clear-alarm-batch",
            generation: 1,
          },
          requestedOrigins: [ORIGIN],
          origins: [{ origin: ORIGIN, originAfterEpoch: "alarm-after-epoch" }],
          subjectDiscovery: "complete",
          targets: frames.map((frame) => ({
            subject: {
              tabId: 7,
              frameId: frame.frameId,
              documentId: frame.documentId,
              origin: ORIGIN,
              pathname: `/alarm/${frame.frameId}`,
            },
            removedItemIds: [],
            projectionId: `alarm-projection-${String(frame.frameId).padStart(2, "0")}`,
            revision: 1,
            state: "pending",
            attemptCount: 0,
            nextAttemptAt: 0,
          })),
        }],
      },
    });
    const canonical: CaptureClearOperationV1 = {
      version: 1,
      operationId: "clear-alarm-batch",
      authorityId: "alarm-authority",
      generation: 1,
      phase: "canonical_committed",
      origins: [{
        origin: ORIGIN,
        beforeEpoch: "epoch-before-alarm",
        afterEpoch: "alarm-after-epoch",
        canonical: "committed",
      }],
      createdAt: "2026-08-18T00:00:00.000Z",
      updatedAt: "2026-08-18T00:00:00.000Z",
    };
    const store = createStoreHarness();
    store.listClearOperations = vi.fn(async () => ({ ok: true, value: [canonical] }));
    chrome.tabs.sendMessage = vi.fn(async (_tabId, message) => {
      if (isRecord(message) && message.type === UI_ATTACH_CLEAR_PROJECTION) {
        throw new Error("retry later");
      }
      return undefined;
    });
    const controller = createBackgroundController({
      chrome,
      store,
      ensureContentScript: vi.fn(async () => true),
    });
    controller.register();

    await vi.waitFor(() => expect(vi.mocked(chrome.tabs.sendMessage).mock.calls.filter(
      ([, message]) => isRecord(message) && message.type === UI_ATTACH_CLEAR_PROJECTION,
    ).length).toBeGreaterThanOrEqual(33));
    const clearDeliveries = vi.mocked(chrome.tabs.sendMessage).mock.calls.filter(([, message]) =>
      isRecord(message) && message.type === UI_ATTACH_CLEAR_PROJECTION
    );
    expect(clearDeliveries).toHaveLength(33);
    expect(chrome.alarms.create).toHaveBeenCalledWith(
      "ui-attach:clear-projection-retry",
      expect.objectContaining({ delayInMinutes: expect.any(Number) }),
    );
  });

  test("alarm wake retries the same durable ref after ACK timeout and finalizes on exact zero ACK", async () => {
    const clock = vi.spyOn(Date, "now").mockReturnValue(1_000_000);
    try {
      const chrome = createChromeHarness();
      configureSingleClearPage(chrome, "alarm-timeout-document");
      await chrome.storage.local.set({
        [CLEAR_PROJECTION_JOURNAL_STORAGE_KEY]: {
          version: 1,
          operations: [{
            version: 1,
            operationId: "clear-alarm-timeout",
            authority: {
              authorityId: "alarm-timeout-authority",
              operationId: "clear-alarm-timeout",
              generation: 1,
            },
            requestedOrigins: [ORIGIN],
            origins: [{ origin: ORIGIN, originAfterEpoch: "alarm-timeout-after" }],
            subjectDiscovery: "complete",
            targets: [{
              subject: {
                tabId: 7,
                frameId: 0,
                documentId: "alarm-timeout-document",
                origin: ORIGIN,
                pathname: "/settings",
              },
              removedItemIds: ["att_save"],
              projectionId: "alarm-timeout-projection",
              revision: 1,
              state: "pending",
              attemptCount: 0,
              nextAttemptAt: 0,
            }],
          }],
        },
      });
      const canonical: CaptureClearOperationV1 = {
        version: 1,
        operationId: "clear-alarm-timeout",
        authorityId: "alarm-timeout-authority",
        generation: 1,
        phase: "canonical_committed",
        origins: [{
          origin: ORIGIN,
          beforeEpoch: "epoch-before-timeout",
          afterEpoch: "alarm-timeout-after",
          canonical: "committed",
        }],
        createdAt: "2026-08-18T00:00:00.000Z",
        updatedAt: "2026-08-18T00:00:00.000Z",
      };
      const store = createStoreHarness();
      let activeCanonical: CaptureClearOperationV1 | null = canonical;
      store.listClearOperations = vi.fn(async () => ({
        ok: true,
        value: activeCanonical ? [canonical] : [],
      }));
      store.finalizeClearOperation = vi.fn(async () => {
        activeCanonical = null;
        return { ok: true, value: canonical };
      });
      let controller: ReturnType<typeof createBackgroundController>;
      const deliveredRefs: unknown[] = [];
      chrome.tabs.sendMessage = vi.fn(async (_tabId, message) => {
        if (!isRecord(message) || message.type !== UI_ATTACH_CLEAR_PROJECTION) return undefined;
        deliveredRefs.push(message.clear);
        if (deliveredRefs.length === 2) {
          void Promise.resolve().then(() => dispatchRuntime(
            controller,
            exactZeroClearAck(message.clear),
            createExactClearSender(chrome, "alarm-timeout-document"),
          ));
        }
        return undefined;
      });
      controller = createBackgroundController({
        chrome,
        store,
        ensureContentScript: vi.fn(async () => true),
      });
      controller.register();

      await vi.waitFor(() => expect(chrome.alarms.create).toHaveBeenCalledWith(
        "ui-attach:clear-projection-retry",
        { delayInMinutes: 1_000 / 60_000 },
      ), { timeout: 2_000 });
      expect(deliveredRefs).toHaveLength(1);
      clock.mockReturnValue(1_001_000);
      const alarmListener = vi.mocked(chrome.alarms.onAlarm.addListener).mock.calls[0]?.[0] as
        | ((alarm: { name: string }) => void)
        | undefined;
      alarmListener?.({ name: "ui-attach:clear-projection-retry" });

      await vi.waitFor(() => expect(activeCanonical).toBeNull());
      expect(deliveredRefs).toHaveLength(2);
      expect(deliveredRefs[1]).toEqual(deliveredRefs[0]);
      expect((await chrome.storage.local.get(CLEAR_PROJECTION_JOURNAL_STORAGE_KEY))[
        CLEAR_PROJECTION_JOURNAL_STORAGE_KEY
      ]).toBeUndefined();
      expect(chrome.alarms.clear).toHaveBeenCalledWith("ui-attach:clear-projection-retry");
    } finally {
      clock.mockRestore();
    }
  });

  test("journal capacity failure happens before canonical clear mutation", async () => {
    const chrome = createChromeHarness();
    configureSingleClearPage(chrome);
    await chrome.storage.local.set({
      [CLEAR_PROJECTION_JOURNAL_STORAGE_KEY]: {
        version: 1,
        operations: Array.from({ length: 16 }, (_, index) => ({
          version: 1,
          operationId: `existing-clear-${String(index).padStart(2, "0")}`,
          authority: null,
          requestedOrigins: [`https://existing-${index}.example.test`],
          origins: [],
          subjectDiscovery: "pending",
          targets: [],
        })),
      },
    });
    const record = { ...createCaptureRecord("save", "Save changes"), tabId: 7, frameId: 0 };
    const store = createStoreHarness();
    store.read = vi.fn(async () => ({ ok: true, value: createSessionReadback(record) }));
    const controller = createBackgroundController({ chrome, store });

    await expect(dispatchRuntime(controller, {
      type: "ui-attach:session-clear",
      origin: ORIGIN,
      epoch: "epoch-1",
      operationId: "clear-over-capacity",
    }, createExtensionSender())).resolves.toMatchObject({
      ok: false,
      code: "SESSION_FULL",
    });
    expect(store.clearOrigins).not.toHaveBeenCalled();
  });

  test("preserves the first pre-C1 manifest and blocks later operation ids", async () => {
    const chrome = createChromeHarness();
    configureSingleClearPage(chrome);
    const record = { ...createCaptureRecord("save", "Save changes"), tabId: 7, frameId: 0 };
    const store = createStoreHarness();
    store.read = vi.fn(async () => ({ ok: true, value: createSessionReadback(record) }));
    store.clearOrigins = vi.fn(async () => ({
      ok: false,
      code: "STALE_SESSION",
      error: "pre-manifest stale",
    }));
    store.listClearOperations = vi.fn(async () => ({ ok: true, value: [] }));
    const controller = createBackgroundController({ chrome, store });

    for (let index = 0; index < 17; index += 1) {
      await expect(dispatchRuntime(controller, {
        type: "ui-attach:session-clear",
        origin: ORIGIN,
        epoch: "epoch-1",
        operationId: `clear-pre-manifest-${String(index).padStart(2, "0")}`,
      }, createExtensionSender())).resolves.toMatchObject(index === 0
        ? { ok: false, code: "STALE_SESSION" }
        : { ok: false, code: "CLEAR_IN_PROGRESS" });
    }
    expect(store.clearOrigins).toHaveBeenCalledTimes(1);
    expect((await chrome.storage.local.get(CLEAR_PROJECTION_JOURNAL_STORAGE_KEY))[
      CLEAR_PROJECTION_JOURNAL_STORAGE_KEY
    ]).toBeDefined();
  });

  test("C4 fails closed when partial C1 authority has no durable C3 target reference", async () => {
    const chrome = createChromeHarness();
    configureSingleClearPage(chrome);
    const record = { ...createCaptureRecord("save", "Save changes"), tabId: 7, frameId: 0 };
    const store = createStoreHarness();
    store.read = vi.fn(async () => ({ ok: true, value: createSessionReadback(record) }));
    let active: CaptureClearOperationV1 = {
      version: 1,
      operationId: "clear-partial-storage",
      authorityId: "partial-storage-authority",
      generation: 1,
      phase: "prepared",
      origins: [{
        origin: ORIGIN,
        beforeEpoch: "epoch-1",
        afterEpoch: "epoch-after-partial-storage",
        canonical: "pending",
      }],
      createdAt: "2026-08-18T00:00:00.000Z",
      updatedAt: "2026-08-18T00:00:00.000Z",
    };
    let clearCalls = 0;
    store.clearOrigins = vi.fn(async () => {
      clearCalls += 1;
      if (clearCalls === 1) {
        return { ok: false, code: "STORAGE_ERROR", error: "partial write" };
      }
      active = {
        ...active,
        phase: "canonical_committed",
        origins: active.origins.map((origin) => ({ ...origin, canonical: "committed" as const })),
      };
      return { ok: true, value: structuredClone(active) };
    });
    store.listClearOperations = vi.fn(async () => ({
      ok: true,
      value: [structuredClone(active)],
    }));
    chrome.tabs.sendMessage = vi.fn(async (_tabId, message) => {
      if (isRecord(message) && message.type === UI_ATTACH_CLEAR_PROJECTION) {
        throw new Error("keep retry durable");
      }
      return undefined;
    });
    const controller = createBackgroundController({ chrome, store });

    await expect(dispatchRuntime(controller, {
      type: "ui-attach:session-clear",
      origin: ORIGIN,
      epoch: "epoch-1",
      operationId: active.operationId,
    }, createExtensionSender())).resolves.toMatchObject({
      ok: false,
      code: "STORAGE_ERROR",
    });
    expect(store.clearOrigins).not.toHaveBeenCalled();
    expect((await chrome.storage.local.get(CLEAR_PROJECTION_JOURNAL_STORAGE_KEY))[
      CLEAR_PROJECTION_JOURNAL_STORAGE_KEY
    ]).toBeUndefined();
  });

  test("navigation rejects the old document ACK and retries an atomic replacement subject", async () => {
    const chrome = createChromeHarness();
    let liveDocumentId = "old-clear-document";
    let livePathname = "/settings";
    chrome.tabs.query = vi.fn(async () => [{
      id: 7,
      url: `${ORIGIN}${livePathname}`,
      windowId: 1,
    }]);
    chrome.webNavigation.getAllFrames = vi.fn(async () => [{
      frameId: 0,
      parentFrameId: -1,
      documentId: liveDocumentId,
      url: `${ORIGIN}${livePathname}`,
    }]);
    chrome.webNavigation.getFrame = vi.fn(async ({ documentId }) =>
      !documentId || documentId === liveDocumentId
        ? {
            parentFrameId: -1,
            documentId: liveDocumentId,
            url: `${ORIGIN}${livePathname}`,
          }
        : undefined);
    const record = { ...createCaptureRecord("save", "Save changes"), tabId: 7, frameId: 0 };
    const store = createStoreHarness();
    store.read = vi.fn(async () => ({ ok: true, value: createSessionReadback(record) }));
    let oldTombstone: Record<string, unknown> | null = null;
    let replacementTombstone: Record<string, unknown> | null = null;
    let failFirst = true;
    chrome.tabs.sendMessage = vi.fn(async (_tabId, message) => {
      if (!isRecord(message) || message.type !== UI_ATTACH_CLEAR_PROJECTION) return undefined;
      if (failFirst) {
        failFirst = false;
        oldTombstone = message;
        throw new Error("old document disappeared");
      }
      replacementTombstone = message;
      return undefined;
    });
    const controller = createBackgroundController({ chrome, store });
    await expect(dispatchRuntime(controller, {
      type: "ui-attach:session-clear",
      origin: ORIGIN,
      epoch: "epoch-1",
      operationId: "clear-navigation",
    }, createExtensionSender())).resolves.toMatchObject({
      ok: false,
      code: "CONTENT_UNAVAILABLE",
    });

    liveDocumentId = "new-clear-document";
    livePathname = "/settings/next";
    await controller.handleNavigationCommitted({
      tabId: 7,
      frameId: 0,
      parentFrameId: -1,
      documentId: liveDocumentId,
      url: `${ORIGIN}${livePathname}`,
    });
    await waitFor(() => replacementTombstone !== null);
    expect(replacementTombstone!.clear).toMatchObject({
      revision: 2,
      subject: {
        tabId: 7,
        frameId: 0,
        documentId: liveDocumentId,
        origin: ORIGIN,
        pathname: livePathname,
      },
    });
    await expect(dispatchRuntime(
      controller,
      exactZeroClearAck(oldTombstone!.clear),
      createExactClearSender(chrome, "old-clear-document"),
    )).resolves.toMatchObject({ ok: false, code: "UNTRUSTED_SENDER" });
    await expect(dispatchRuntime(
      controller,
      exactZeroClearAck(replacementTombstone!.clear),
      createExactClearSender(chrome, liveDocumentId, livePathname),
    )).resolves.toEqual({ ok: true, data: { accepted: true } });
    expect((await chrome.storage.local.get(CLEAR_PROJECTION_JOURNAL_STORAGE_KEY))[
      CLEAR_PROJECTION_JOURNAL_STORAGE_KEY
    ]).toBeUndefined();
  });

  test("startup reconcile cannot reclaim a provisional while its C1 mutation is in flight", async () => {
    const chrome = createChromeHarness();
    configureSingleClearPage(chrome);
    const record = { ...createCaptureRecord("save", "Save changes"), tabId: 7, frameId: 0 };
    const store = createStoreHarness();
    store.read = vi.fn(async () => ({ ok: true, value: createSessionReadback(record) }));
    const canonicalStarted = createDeferred<void>();
    const releaseCanonical = createDeferred<void>();
    const originalClearOrigins = store.clearOrigins;
    store.clearOrigins = vi.fn(async (request) => {
      canonicalStarted.resolve(undefined);
      await releaseCanonical.promise;
      return originalClearOrigins(request);
    });
    let controller: ReturnType<typeof createBackgroundController>;
    chrome.tabs.sendMessage = vi.fn(async (_tabId, message) => {
      if (isRecord(message) && message.type === UI_ATTACH_CLEAR_PROJECTION) {
        void Promise.resolve().then(() => dispatchRuntime(
          controller,
          exactZeroClearAck(message.clear),
          createExactClearSender(chrome),
        ));
      }
      return undefined;
    });
    controller = createBackgroundController({ chrome, store });
    const clearing = dispatchRuntime(controller, {
      type: "ui-attach:session-clear",
      origin: ORIGIN,
      epoch: "epoch-1",
      operationId: "clear-reconcile-race",
    }, createExtensionSender());
    await canonicalStarted.promise;
    controller.register();
    await flushAsyncWork();
    expect((await chrome.storage.local.get(CLEAR_PROJECTION_JOURNAL_STORAGE_KEY))[
      CLEAR_PROJECTION_JOURNAL_STORAGE_KEY
    ]).toBeDefined();

    releaseCanonical.resolve(undefined);
    await expect(clearing).resolves.toMatchObject({ ok: true });
    expect(store.clearOrigins).toHaveBeenCalledOnce();
  });

  test("partial multi-origin canonical clear projects only committed origins", async () => {
    const chrome = createChromeHarness();
    chrome.tabs.query = vi.fn(async () => [{ id: 7, url: `${ORIGIN}/settings`, windowId: 1 }]);
    const frames = [
      { frameId: 0, parentFrameId: -1, url: `${ORIGIN}/settings`, documentId: "partial-top" },
      { frameId: 3, parentFrameId: 0, url: `${FRAME_ORIGIN}/embedded`, documentId: "partial-frame" },
    ];
    chrome.webNavigation.getAllFrames = vi.fn(async () => frames);
    chrome.webNavigation.getFrame = vi.fn(async ({ frameId }) =>
      frames.find((frame) => frame.frameId === (frameId ?? 0)));
    const topRecord = { ...createCaptureRecord("top", "Top"), tabId: 7, frameId: 0 };
    const frameRecord = { ...createCaptureRecord("frame", "Frame"), tabId: 7, frameId: 3 };
    frameRecord.origin = FRAME_ORIGIN;
    frameRecord.pageUrl = `${FRAME_ORIGIN}/embedded`;
    frameRecord.attachment.source.url = frameRecord.pageUrl;
    frameRecord.attachment.policy.allowedDomains = [FRAME_ORIGIN];
    const previousByOrigin = new Map([
      [ORIGIN, createSessionReadback(topRecord)],
      [FRAME_ORIGIN, createSessionReadback(frameRecord)],
    ]);
    const store = createStoreHarness();
    store.read = vi.fn(async (origin) => ({
      ok: true,
      value: previousByOrigin.get(origin)!,
    }));
    let activeOperation: CaptureClearOperationV1 | null = null;
    store.clearOrigins = vi.fn(async (request) => {
      activeOperation = {
        version: 1,
        operationId: request.operationId,
        authorityId: "partial-authority",
        generation: 1,
        phase: "canonical_partial",
        origins: request.origins.map((entry) => ({
          origin: entry.origin,
          beforeEpoch: entry.epoch,
          afterEpoch: `after-${entry.origin}`,
          canonical: entry.origin === ORIGIN ? "committed" as const : "conflict" as const,
        })).sort((left, right) => left.origin < right.origin ? -1 : 1),
        createdAt: "2026-08-18T00:00:00.000Z",
        updatedAt: "2026-08-18T00:00:00.000Z",
      };
      return { ok: true, value: structuredClone(activeOperation) };
    });
    store.listClearOperations = vi.fn(async () => ({
      ok: true,
      value: activeOperation ? [structuredClone(activeOperation)] : [],
    }));
    store.finalizeClearOperation = vi.fn(async () => {
      const finalized = activeOperation!;
      activeOperation = null;
      return { ok: true, value: finalized };
    });
    const projectedOrigins: string[] = [];
    let controller: ReturnType<typeof createBackgroundController>;
    chrome.tabs.sendMessage = vi.fn(async (_tabId, message) => {
      if (isRecord(message) && message.type === UI_ATTACH_CLEAR_PROJECTION &&
          isRecord(message.clear)) {
        projectedOrigins.push(String(message.clear.origin));
        void Promise.resolve().then(() => dispatchRuntime(
          controller,
          exactZeroClearAck(message.clear),
          createExactClearSender(chrome, "partial-top"),
        ));
      }
      return undefined;
    });
    controller = createBackgroundController({ chrome, store });

    await expect(dispatchRuntime(controller, {
      type: "ui-attach:session-clear",
      origin: ORIGIN,
      epoch: "epoch-1",
      operationId: "clear-partial",
    }, createExtensionSender())).resolves.toMatchObject({
      ok: false,
      code: "STALE_SESSION",
    });
    expect(projectedOrigins).toEqual([ORIGIN]);
    expect(store.clearOrigins).toHaveBeenCalledOnce();
  });

  test("clears every page overlay after session clear without relying on in-memory endpoints", async () => {
    const chrome = createChromeHarness();
    chrome.tabs.query = vi.fn(async () => [{ id: 7, url: `${ORIGIN}/settings`, windowId: 1 }]);
    chrome.webNavigation.getAllFrames = vi.fn(async () => [{
      frameId: 0,
      parentFrameId: -1,
      documentId: "clear-document",
      url: `${ORIGIN}/settings`,
    }]);
    chrome.webNavigation.getFrame = vi.fn(async ({ tabId, frameId }) =>
      tabId === 7 && frameId === 0
        ? { documentId: "clear-document", parentFrameId: -1, url: `${ORIGIN}/settings` }
        : undefined);
    const store = createStoreHarness();
    const save = { ...createCaptureRecord("save", "Save changes"), tabId: 7, frameId: 0 };
    const previous = createSessionReadbackMany([save]);
    store.read = vi.fn(async () => ({ ok: true, value: previous }));
    let controller: ReturnType<typeof createBackgroundController>;
    chrome.tabs.sendMessage = vi.fn(async (_tabId, message) => {
      if (isRecord(message) && message.type === UI_ATTACH_CLEAR_PROJECTION) {
        void Promise.resolve().then(() => dispatchRuntime(controller, {
          type: UI_ATTACH_CLEAR_PROJECTION_ACK,
          clear: message.clear,
          readback: {
            appliedItemIds: [],
            markerCount: 0,
            selectionPreviewActive: false,
            digest: UI_ATTACH_EMPTY_APPLIED_ITEM_IDS_DIGEST,
          },
        }, {
          id: chrome.runtime.id,
          url: `${ORIGIN}/settings`,
          frameId: 0,
          documentId: "clear-document",
          tab: { id: 7, url: `${ORIGIN}/settings`, windowId: 1 },
        }));
      }
      return undefined;
    });
    controller = createBackgroundController({ chrome, store });

    await dispatchRuntime(controller, {
      type: "ui-attach:session-clear",
      origin: ORIGIN,
      epoch: "epoch-1",
      operationId: "clear-1",
    }, createExtensionSender());

    expect(store.clearOrigins).toHaveBeenCalledWith({
      operationId: "clear-1",
      origins: [{ origin: ORIGIN, epoch: "epoch-1" }],
    });
    expect(chrome.tabs.sendMessage).toHaveBeenCalledWith(7, expect.objectContaining({
      type: UI_ATTACH_CLEAR_PROJECTION,
      clear: expect.objectContaining({
        origin: ORIGIN,
        subject: expect.objectContaining({ documentId: "clear-document" }),
      }),
    }), { documentId: "clear-document", frameId: 0 });
  });

  test("clears stored selections and overlays across every live frame origin on the active page", async () => {
    const chrome = createChromeHarness();
    chrome.tabs.query = vi.fn(async () => [{ id: 7, url: `${ORIGIN}/settings`, windowId: 1 }]);
    chrome.webNavigation.getAllFrames = vi.fn(async () => [
      { frameId: 0, parentFrameId: -1, url: `${ORIGIN}/settings`, documentId: "top-doc" },
      { frameId: 3, parentFrameId: 0, url: `${FRAME_ORIGIN}/embedded`, documentId: "frame-doc" },
      { frameId: 4, parentFrameId: 0, url: `${ORIGIN}/inline`, documentId: "inline-doc" },
    ]);
    chrome.webNavigation.getFrame = vi.fn(async ({ frameId }) => ([
      { frameId: 0, parentFrameId: -1, url: `${ORIGIN}/settings`, documentId: "top-doc" },
      { frameId: 3, parentFrameId: 0, url: `${FRAME_ORIGIN}/embedded`, documentId: "frame-doc" },
      { frameId: 4, parentFrameId: 0, url: `${ORIGIN}/inline`, documentId: "inline-doc" },
    ].find((frame) => frame.frameId === frameId)));
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
    const ensureContentScript = vi.fn(async () => true);
    let controller: ReturnType<typeof createBackgroundController>;
    chrome.tabs.sendMessage = vi.fn(async (_tabId, message, options) => {
      if (isRecord(message) && message.type === UI_ATTACH_CLEAR_PROJECTION) {
        const frame = options?.frameId === 3
          ? { origin: FRAME_ORIGIN, pathname: "/embedded", documentId: "frame-doc" }
          : options?.frameId === 4
            ? { origin: ORIGIN, pathname: "/inline", documentId: "inline-doc" }
            : { origin: ORIGIN, pathname: "/settings", documentId: "top-doc" };
        void Promise.resolve().then(() => dispatchRuntime(controller, {
          type: UI_ATTACH_CLEAR_PROJECTION_ACK,
          clear: message.clear,
          readback: {
            appliedItemIds: [],
            markerCount: 0,
            selectionPreviewActive: false,
            digest: UI_ATTACH_EMPTY_APPLIED_ITEM_IDS_DIGEST,
          },
        }, {
          id: chrome.runtime.id,
          url: `${frame.origin}${frame.pathname}`,
          frameId: options?.frameId ?? 0,
          documentId: frame.documentId,
          tab: { id: 7, url: `${ORIGIN}/settings`, windowId: 1 },
        }));
      }
      return undefined;
    });
    controller = createBackgroundController({ chrome, store, ensureContentScript });

    await dispatchRuntime(controller, {
      type: "ui-attach:session-clear",
      origin: ORIGIN,
      epoch: "epoch-1",
      operationId: "clear-page",
    }, createExtensionSender());

    expect(store.clearOrigins).toHaveBeenCalledOnce();
    expect(store.clearOrigins).toHaveBeenCalledWith({
      operationId: "clear-page",
      origins: [
        { origin: ORIGIN, epoch: "epoch-1" },
        { origin: FRAME_ORIGIN, epoch: "epoch-1" },
      ],
    });
    expect(ensureContentScript).toHaveBeenCalledWith(7, 0, "top-doc");
    expect(ensureContentScript).toHaveBeenCalledWith(7, 3, "frame-doc");
    expect(ensureContentScript).toHaveBeenCalledWith(7, 4, "inline-doc");
    expect(chrome.tabs.sendMessage).toHaveBeenCalledWith(7, expect.objectContaining({
      type: UI_ATTACH_CLEAR_PROJECTION,
      clear: expect.objectContaining({
        origin: ORIGIN,
        subject: expect.objectContaining({ documentId: "top-doc" }),
      }),
    }), { documentId: "top-doc", frameId: 0 });
    expect(chrome.tabs.sendMessage).toHaveBeenCalledWith(7, expect.objectContaining({
      type: UI_ATTACH_CLEAR_PROJECTION,
      clear: expect.objectContaining({
        origin: FRAME_ORIGIN,
        subject: expect.objectContaining({ documentId: "frame-doc" }),
      }),
    }), { documentId: "frame-doc", frameId: 3 });
    expect(chrome.tabs.sendMessage).toHaveBeenCalledWith(7, expect.objectContaining({
      type: UI_ATTACH_CLEAR_PROJECTION,
      clear: expect.objectContaining({
        origin: ORIGIN,
        subject: expect.objectContaining({ documentId: "inline-doc" }),
      }),
    }), { documentId: "inline-doc", frameId: 4 });
  });

  test("widget active-origin clear excludes another live frame origin", async () => {
    const fixture = await createInPageWidgetFixture();
    const liveFrames = [
      {
        frameId: 0,
        parentFrameId: -1,
        url: `${ORIGIN}/settings`,
        documentId: WIDGET_TOP_DOCUMENT_ID,
      },
      {
        frameId: 3,
        parentFrameId: 0,
        url: `${FRAME_ORIGIN}/embedded`,
        documentId: "other-origin-frame-document",
      },
    ];
    fixture.chrome.webNavigation.getAllFrames = vi.fn(async () => liveFrames);
    const getFrame = fixture.chrome.webNavigation.getFrame;
    fixture.chrome.webNavigation.getFrame = vi.fn(async (details) => (
      details.frameId === 3
        ? liveFrames[1]
        : getFrame(details)
    ));
    const topRecord = {
      ...createCaptureRecord("top-site", "Top site"),
      tabId: WIDGET_TAB_ID,
      frameId: 0,
      pageUrl: `${ORIGIN}/settings`,
    };
    topRecord.attachment.source.url = `${ORIGIN}/settings`;
    const frameRecord = {
      ...createCaptureRecord("other-site", "Other site"),
      origin: FRAME_ORIGIN,
      tabId: WIDGET_TAB_ID,
      frameId: 3,
      pageUrl: `${FRAME_ORIGIN}/embedded`,
    };
    frameRecord.attachment.source.url = `${FRAME_ORIGIN}/embedded`;
    frameRecord.attachment.policy.allowedDomains = [FRAME_ORIGIN];
    const beforeByOrigin = new Map([
      [ORIGIN, createSessionReadback(topRecord)],
      [FRAME_ORIGIN, createSessionReadback(frameRecord, FRAME_ORIGIN)],
    ]);
    const clearedOrigins = new Map<string, string>();
    fixture.store.read = vi.fn(async (origin) => {
      const clearedEpoch = clearedOrigins.get(origin);
      return clearedEpoch
        ? {
            ok: true as const,
            value: {
              origin,
              epoch: clearedEpoch,
              clearPending: false,
              activeClearOperationId: null,
              file: null,
              legacyRecord: null,
            },
          }
        : { ok: true as const, value: beforeByOrigin.get(origin)! };
    });
    const clearOrigins = fixture.store.clearOrigins.bind(fixture.store);
    fixture.store.clearOrigins = vi.fn(async (request) => {
      const result = await clearOrigins(request);
      if (result.ok) {
        for (const origin of result.value.origins) {
          if (origin.canonical === "committed") {
            clearedOrigins.set(origin.origin, origin.afterEpoch);
          }
        }
      }
      return result;
    });
    fixture.chrome.tabs.sendMessage = vi.fn(async (_tabId, message, options) => {
      if (isRecord(message) && message.type === UI_ATTACH_CLEAR_PROJECTION) {
        void Promise.resolve().then(() => dispatchRuntime(fixture.controller, {
          type: UI_ATTACH_CLEAR_PROJECTION_ACK,
          clear: message.clear,
          readback: {
            appliedItemIds: [],
            markerCount: 0,
            selectionPreviewActive: false,
            digest: UI_ATTACH_EMPTY_APPLIED_ITEM_IDS_DIGEST,
          },
        }, {
          id: fixture.chrome.runtime.id,
          url: `${ORIGIN}/settings`,
          frameId: options?.frameId ?? 0,
          documentId: options?.documentId,
          tab: { id: WIDGET_TAB_ID, url: `${ORIGIN}/settings`, windowId: WIDGET_WINDOW_ID },
        }));
      }
      return undefined;
    });

    const response = await dispatchRuntime(
      fixture.controller,
      createInPageWidgetCommandEnvelope(fixture.init, {
        type: "ui-attach:widget-session-clear",
        expectedEpoch: "epoch-1",
        operationId: "widget-clear-active-origin",
        scope: "active-origin",
      }),
      fixture.widgetSender,
    );

    expect(response).toMatchObject({ ok: true, data: { origin: ORIGIN, file: null } });
    expect(fixture.store.clearOrigins).toHaveBeenCalledWith({
      operationId: "widget-clear-active-origin",
      origins: [{ origin: ORIGIN, epoch: "epoch-1" }],
    });
    expect(fixture.ensureContentScript).toHaveBeenCalledWith(
      WIDGET_TAB_ID,
      0,
      WIDGET_TOP_DOCUMENT_ID,
    );
    expect(fixture.ensureContentScript).not.toHaveBeenCalledWith(
      WIDGET_TAB_ID,
      3,
      "other-origin-frame-document",
    );
    expect(clearedOrigins.has(FRAME_ORIGIN)).toBe(false);
  });

  test("widget active-origin clear binds a selected cross-origin frame without blocking another origin", async () => {
    const fixture = await createInPageWidgetFixture();
    const liveFrames = [
      {
        frameId: 0,
        parentFrameId: -1,
        url: `${ORIGIN}/settings`,
        documentId: WIDGET_TOP_DOCUMENT_ID,
      },
      {
        frameId: 3,
        parentFrameId: 0,
        url: `${FRAME_ORIGIN}/embedded`,
        documentId: "selected-frame-document",
      },
    ];
    fixture.chrome.webNavigation.getAllFrames = vi.fn(async () => liveFrames);
    const originalGetFrame = fixture.chrome.webNavigation.getFrame;
    fixture.chrome.webNavigation.getFrame = vi.fn(async (details) => details.frameId === 3
      ? liveFrames[1]
      : originalGetFrame(details));
    const topRecord = {
      ...createCaptureRecord("save", "Top active origin"),
      tabId: WIDGET_TAB_ID,
      frameId: 0,
      pageUrl: `${ORIGIN}/settings`,
    };
    topRecord.attachment.source.url = `${ORIGIN}/settings`;
    const frameRecord = {
      ...createCaptureRecord("frame-active-origin", "Frame active origin"),
      origin: FRAME_ORIGIN,
      tabId: WIDGET_TAB_ID,
      frameId: 3,
      pageUrl: `${FRAME_ORIGIN}/embedded`,
      routeChain: [
        { origin: ORIGIN, pathname: "/settings" },
        { origin: FRAME_ORIGIN, pathname: "/embedded" },
      ],
    };
    frameRecord.attachment.source.url = `${FRAME_ORIGIN}/embedded`;
    frameRecord.attachment.policy.allowedDomains = [FRAME_ORIGIN];
    let topReadback = createSessionReadback(topRecord);
    const frameReadback = {
      ...createSessionReadback(frameRecord, FRAME_ORIGIN),
      epoch: "frame-epoch-1",
    };
    const clearedOrigins = new Map<string, string>();
    fixture.store.read = vi.fn(async (origin) => {
      const clearedEpoch = clearedOrigins.get(origin);
      if (clearedEpoch) {
        return {
          ok: true as const,
          value: {
            origin,
            epoch: clearedEpoch,
            clearPending: false,
            activeClearOperationId: null,
            file: null,
            legacyRecord: null,
          },
        };
      }
      return {
        ok: true as const,
        value: origin === FRAME_ORIGIN ? frameReadback : topReadback,
      };
    });
    fixture.store.updateIntent = vi.fn(async (origin, _epoch, _itemId, intent) => {
      const record = origin === FRAME_ORIGIN ? frameRecord : topRecord;
      record.intent = intent;
      const value = {
        ...createSessionReadback(record, origin),
        ...(origin === FRAME_ORIGIN ? { epoch: "frame-epoch-1" } : {}),
      };
      if (origin === ORIGIN) topReadback = value;
      return { ok: true, value };
    });
    await expect(dispatchRuntime(
      fixture.controller,
      createInPageWidgetCommandEnvelope(fixture.init, {
        type: "ui-attach:widget-frame-scope-select",
        frameId: 3,
        documentId: "selected-frame-document",
        origin: FRAME_ORIGIN,
        pathname: "/embedded",
        expectedGeneration: 0,
      }),
      fixture.widgetSender,
    )).resolves.toEqual({ ok: true, data: { enabled: false } });

    const clearEntered = createDeferred<void>();
    const releaseClear = createDeferred<void>();
    const clearOrigins = fixture.store.clearOrigins.bind(fixture.store);
    fixture.store.clearOrigins = vi.fn(async (request) => {
      clearEntered.resolve(undefined);
      await releaseClear.promise;
      const result = await clearOrigins(request);
      if (result.ok) {
        for (const origin of result.value.origins) {
          if (origin.canonical === "committed") {
            clearedOrigins.set(origin.origin, origin.afterEpoch);
          }
        }
      }
      return result;
    });
    fixture.chrome.tabs.sendMessage = vi.fn(async (_tabId, message, options) => {
      if (isRecord(message) && message.type === UI_ATTACH_CLEAR_PROJECTION) {
        void Promise.resolve().then(() => dispatchRuntime(fixture.controller, {
          type: UI_ATTACH_CLEAR_PROJECTION_ACK,
          clear: message.clear,
          readback: {
            appliedItemIds: [],
            markerCount: 0,
            selectionPreviewActive: false,
            digest: UI_ATTACH_EMPTY_APPLIED_ITEM_IDS_DIGEST,
          },
        }, {
          id: fixture.chrome.runtime.id,
          url: `${FRAME_ORIGIN}/embedded`,
          frameId: options?.frameId ?? 3,
          documentId: options?.documentId,
          tab: { id: WIDGET_TAB_ID, url: `${ORIGIN}/settings`, windowId: WIDGET_WINDOW_ID },
        }));
      }
      return undefined;
    });
    fixture.ensureContentScript.mockClear();
    vi.mocked(fixture.store.updateIntent).mockClear();

    const clearing = dispatchRuntime(
      fixture.controller,
      createInPageWidgetCommandEnvelope(fixture.init, {
        type: "ui-attach:widget-session-clear",
        expectedEpoch: "frame-epoch-1",
        operationId: "widget-clear-selected-frame-origin",
        scope: "active-origin",
      }),
      fixture.widgetSender,
    );
    await clearEntered.promise;

    await expect(dispatchRuntime(
      fixture.controller,
      createInPageWidgetCommandEnvelope(fixture.init, {
        type: "ui-attach:widget-task-note-save",
        expectedEpoch: "frame-epoch-1",
        itemId: frameRecord.attachment.id,
        taskNote: "must remain blocked",
      }),
      fixture.widgetSender,
    )).resolves.toMatchObject({ ok: false, code: "CLEAR_IN_PROGRESS" });
    await expect(dispatchRuntime(fixture.controller, {
      type: UI_ATTACH_OVERLAY_ACTION_REQUEST,
      action: "save",
      itemId: topRecord.attachment.id,
      projection: WIDGET_OVERLAY_PROJECTION,
      taskNote: "top origin remains writable",
    }, createInPageWidgetContentSender())).resolves.toMatchObject({ ok: true });
    await expect(dispatchRuntime(fixture.controller, {
      type: "ui-attach:session-update-intent",
      origin: FRAME_ORIGIN,
      epoch: "frame-epoch-1",
      itemId: frameRecord.attachment.id,
      intent: "same origin stays blocked",
    }, createExtensionSender())).resolves.toMatchObject({
      ok: false,
      code: "CLEAR_IN_PROGRESS",
    });
    expect(fixture.store.updateIntent).toHaveBeenCalledTimes(1);

    releaseClear.resolve(undefined);
    await expect(clearing).resolves.toMatchObject({
      ok: true,
      data: { origin: FRAME_ORIGIN, file: null },
    });
    expect(fixture.store.clearOrigins).toHaveBeenCalledWith({
      operationId: "widget-clear-selected-frame-origin",
      origins: [{ origin: FRAME_ORIGIN, epoch: "frame-epoch-1" }],
    });
    expect(clearedOrigins.has(ORIGIN)).toBe(false);
    expect(fixture.ensureContentScript).toHaveBeenCalledWith(
      WIDGET_TAB_ID,
      3,
      "selected-frame-document",
    );
    expect(fixture.ensureContentScript).not.toHaveBeenCalledWith(
      WIDGET_TAB_ID,
      0,
      WIDGET_TOP_DOCUMENT_ID,
    );
    const clearSubjects = vi.mocked(fixture.chrome.tabs.sendMessage).mock.calls.flatMap(
      ([, message]) => isRecord(message) && message.type === UI_ATTACH_CLEAR_PROJECTION &&
          isRecord(message.clear) && isRecord(message.clear.subject)
        ? [message.clear.subject]
        : [],
    );
    expect(clearSubjects).toEqual([
      expect.objectContaining({
        frameId: 3,
        documentId: "selected-frame-document",
        origin: FRAME_ORIGIN,
        pathname: "/embedded",
      }),
    ]);
  });

  test("widget active-origin clear rejects a same-origin substitute for the selected frame", async () => {
    const fixture = await createInPageWidgetFixture();
    const selectedFrame = {
      frameId: 3,
      parentFrameId: 0,
      url: `${FRAME_ORIGIN}/embedded`,
      documentId: "selected-exact-frame-document",
    };
    const topFrame = {
      frameId: 0,
      parentFrameId: -1,
      url: `${ORIGIN}/settings`,
      documentId: WIDGET_TOP_DOCUMENT_ID,
    };
    fixture.chrome.webNavigation.getAllFrames = vi.fn(async () => [topFrame, selectedFrame]);
    const originalGetFrame = fixture.chrome.webNavigation.getFrame;
    fixture.chrome.webNavigation.getFrame = vi.fn(async (details) => details.frameId === 3
      ? selectedFrame
      : originalGetFrame(details));
    const frameRecord = {
      ...createCaptureRecord("exact-frame", "Exact frame"),
      origin: FRAME_ORIGIN,
      tabId: WIDGET_TAB_ID,
      frameId: 3,
      pageUrl: `${FRAME_ORIGIN}/embedded`,
    };
    frameRecord.attachment.source.url = `${FRAME_ORIGIN}/embedded`;
    frameRecord.attachment.policy.allowedDomains = [FRAME_ORIGIN];
    fixture.store.read = vi.fn(async (origin) => ({
      ok: true,
      value: createSessionReadback(frameRecord, origin),
    }));
    await expect(dispatchRuntime(
      fixture.controller,
      createInPageWidgetCommandEnvelope(fixture.init, {
        type: "ui-attach:widget-frame-scope-select",
        frameId: 3,
        documentId: "selected-exact-frame-document",
        origin: FRAME_ORIGIN,
        pathname: "/embedded",
        expectedGeneration: 0,
      }),
      fixture.widgetSender,
    )).resolves.toEqual({ ok: true, data: { enabled: false } });
    fixture.chrome.webNavigation.getAllFrames = vi.fn(async () => [
      topFrame,
      {
        frameId: 4,
        parentFrameId: 0,
        url: `${FRAME_ORIGIN}/embedded`,
        documentId: "same-origin-substitute-document",
      },
    ]);
    vi.mocked(fixture.store.clearOrigins).mockClear();

    await expect(dispatchRuntime(
      fixture.controller,
      createInPageWidgetCommandEnvelope(fixture.init, {
        type: "ui-attach:widget-session-clear",
        expectedEpoch: "epoch-1",
        operationId: "widget-clear-exact-frame-missing",
        scope: "active-origin",
      }),
      fixture.widgetSender,
    )).resolves.toMatchObject({ ok: false, code: "FRAME_UNAVAILABLE" });
    expect(fixture.store.clearOrigins).not.toHaveBeenCalled();
  });

  test("widget active-origin retry rejects a durable live-page clear with the same operation ID", async () => {
    const fixture = await createInPageWidgetFixture();
    const operationId = "widget-clear-scope-collision";
    const projection = boundClearProjectionOperation(operationId, WIDGET_TOP_DOCUMENT_ID);
    projection.request = {
      ...projection.request!,
      barrierScope: "live-page",
      endpoint: {
        ...projection.request!.endpoint,
        tabId: WIDGET_TAB_ID,
        documentId: WIDGET_TOP_DOCUMENT_ID,
      },
      origins: [
        { origin: ORIGIN, beforeEpoch: "epoch-1" },
        { origin: FRAME_ORIGIN, beforeEpoch: "frame-epoch-1" },
      ],
    };
    projection.requestedOrigins = [ORIGIN, FRAME_ORIGIN];
    projection.origins = [
      { origin: ORIGIN, originAfterEpoch: "cleared-origin" },
      { origin: FRAME_ORIGIN, originAfterEpoch: "cleared-frame-origin" },
    ];
    projection.targets = [
      {
        ...projection.targets[0]!,
        subject: {
          ...projection.targets[0]!.subject,
          tabId: WIDGET_TAB_ID,
          documentId: WIDGET_TOP_DOCUMENT_ID,
        },
      },
      {
        ...projection.targets[0]!,
        subject: {
          tabId: WIDGET_TAB_ID,
          frameId: 3,
          documentId: "scope-collision-frame-document",
          origin: FRAME_ORIGIN,
          pathname: "/embedded",
        },
        removedItemIds: ["att_frame"],
        projectionId: "scope-collision-frame-projection",
      },
    ];
    await fixture.chrome.storage.local.set({
      [CLEAR_PROJECTION_JOURNAL_STORAGE_KEY]: clearProjectionJournal(projection),
    });
    const canonical: CaptureClearOperationV1 = {
      version: 1,
      operationId,
      authorityId: projection.authority!.authorityId,
      generation: projection.authority!.generation,
      phase: "canonical_committed",
      origins: [
        {
          origin: ORIGIN,
          beforeEpoch: "epoch-1",
          afterEpoch: "cleared-origin",
          canonical: "committed",
        },
        {
          origin: FRAME_ORIGIN,
          beforeEpoch: "frame-epoch-1",
          afterEpoch: "cleared-frame-origin",
          canonical: "committed",
        },
      ],
      createdAt: "2026-08-18T00:00:00.000Z",
      updatedAt: "2026-08-18T00:00:00.000Z",
    };
    fixture.store.listClearOperations = vi.fn(async () => ({ ok: true, value: [canonical] }));
    vi.mocked(fixture.store.clearOrigins).mockClear();
    vi.mocked(fixture.store.finalizeClearOperation).mockClear();
    vi.mocked(fixture.chrome.tabs.sendMessage).mockClear();
    vi.mocked(fixture.chrome.webNavigation.getAllFrames).mockClear();

    await expect(dispatchRuntime(
      fixture.controller,
      createInPageWidgetCommandEnvelope(fixture.init, {
        type: "ui-attach:widget-session-clear",
        expectedEpoch: "epoch-1",
        operationId,
        scope: "active-origin",
      }),
      fixture.widgetSender,
    )).resolves.toMatchObject({ ok: false, code: "STALE_SESSION" });
    expect(fixture.store.clearOrigins).not.toHaveBeenCalled();
    expect(fixture.store.finalizeClearOperation).not.toHaveBeenCalled();
    expect(fixture.chrome.tabs.sendMessage).not.toHaveBeenCalled();
    expect((await fixture.chrome.storage.local.get(CLEAR_PROJECTION_JOURNAL_STORAGE_KEY))[
      CLEAR_PROJECTION_JOURNAL_STORAGE_KEY
    ]).toBeDefined();
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
    const projectionDescriptor = createTestOverlayProjectionDescriptor(
      window.location.origin,
      window.location.pathname,
    );
    chrome.runtime.onMessage.addListener = vi.fn((listener) => runtimeListeners.push(listener));
    chrome.runtime.sendMessage = vi.fn(async (message: unknown) => {
      if (!isRecord(message)) return undefined;
      if (message.type === "ui-attach:content-settings-get") {
        return {
          ok: true,
          data: { disclosureMode: "agent_safe", elementSelectionEnabled: false },
        };
      }
      if (message.type === UI_ATTACH_OVERLAY_VISIBILITY_GET) {
        return { ok: true, data: { visible: true } };
      }
      if (message.type === UI_ATTACH_OVERLAY_PROJECTION_ACK) {
        return { ok: true, data: { accepted: true } };
      }
      if (message.type === "ui-attach:overlays-restore-get") {
        return {
          ok: true,
          data: {
            origin: window.location.origin,
            projection: projectionDescriptor,
            activeItemId: "att_save",
            items: [{
              itemId: "att_save",
              attachmentId: "att_save",
              label: "1",
              taskNote: "Update Save changes",
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
    expect(overlay?.querySelector(".ui-attach-label")?.textContent).toBe("1");
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

  test("refreshes replay locators after a minimal overlay state update", async () => {
    vi.resetModules();
    vi.doMock("./capture", () => ({ captureElementTarget: vi.fn() }));
    const runtimeListeners: Array<(
      message: unknown,
      sender: UiAttachChromeMessageSender,
      sendResponse: (response?: unknown) => void,
    ) => boolean | void> = [];
    const chrome = createChromeHarness();
    const projectionDescriptor = createTestOverlayProjectionDescriptor(
      window.location.origin,
      window.location.pathname,
    );
    chrome.runtime.onMessage.addListener = vi.fn((listener) => runtimeListeners.push(listener));
    let restoreCalls = 0;
    chrome.runtime.sendMessage = vi.fn(async (message: unknown) => {
      if (!isRecord(message)) return undefined;
      if (message.type === "ui-attach:content-settings-get") {
        return {
          ok: true,
          data: { disclosureMode: "agent_safe", elementSelectionEnabled: false },
        };
      }
      if (message.type === UI_ATTACH_OVERLAY_VISIBILITY_GET) {
        return { ok: true, data: { visible: true } };
      }
      if (message.type === UI_ATTACH_OVERLAY_PROJECTION_ACK) {
        return { ok: true, data: { accepted: true } };
      }
      if (message.type === "ui-attach:overlays-restore-get") {
        restoreCalls += 1;
        const testId = restoreCalls === 1 ? "old-target" : "new-target";
        return {
          ok: true,
          data: {
            origin: window.location.origin,
            projection: projectionDescriptor,
            activeItemId: "att_save",
            items: [{
              itemId: "att_save",
              attachmentId: "att_save",
              label: "1",
              taskNote: "Update Save changes",
              locators: [{
                strategy: "playwright.testId",
                value: `page.getByTestId("${testId}")`,
                confidence: 0.9,
              }],
            }],
          },
        };
      }
      return undefined;
    });
    vi.stubGlobal("chrome", chrome);
    document.body.innerHTML = [
      '<button data-testid="old-target">Old</button>',
      '<button data-testid="new-target">New</button>',
    ].join("");
    const [oldTarget, newTarget] = Array.from(document.querySelectorAll<HTMLElement>("button"));
    if (!oldTarget || !newTarget) throw new Error("restore target fixture missing");
    oldTarget.getBoundingClientRect = () => ({
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
    newTarget.getBoundingClientRect = () => ({
      x: 200,
      y: 20,
      width: 100,
      height: 36,
      top: 20,
      left: 200,
      right: 300,
      bottom: 56,
      toJSON: () => ({}),
    }) as DOMRect;

    await import("./content");
    await flushAsyncWork();
    let overlay = Array.from(
      document.querySelectorAll<HTMLElement>("[data-ui-attach-overlay-root]"),
    ).at(-1)?.shadowRoot?.querySelector<HTMLElement>(".ui-attach-overlay");
    expect(overlay?.style.left).toBe("10px");

    runtimeListeners[0]({
      type: UI_ATTACH_OVERLAY_STATE,
      origin: window.location.origin,
      projection: projectionDescriptor,
      activeItemId: "att_save",
      items: [{
        itemId: "att_save",
        attachmentId: "att_save",
        label: "1",
        taskNote: "Update Save changes",
      }],
    }, createSender(`${ORIGIN}/settings`), () => undefined);
    await flushAsyncWork();
    overlay = Array.from(
      document.querySelectorAll<HTMLElement>("[data-ui-attach-overlay-root]"),
    ).at(-1)?.shadowRoot?.querySelector<HTMLElement>(".ui-attach-overlay");
    expect(restoreCalls).toBe(2);
    expect(overlay?.style.left).toBe("200px");

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
    const projectionDescriptor = createTestOverlayProjectionDescriptor(
      window.location.origin,
      window.location.pathname,
    );
    chrome.runtime.onMessage.addListener = vi.fn((listener) => runtimeListeners.push(listener));
    let restoreCalls = 0;
    chrome.runtime.sendMessage = vi.fn(async (message: unknown) => {
      if (!isRecord(message)) return undefined;
      if (message.type === "ui-attach:content-settings-get") {
        return {
          ok: true,
          data: { disclosureMode: "agent_safe", elementSelectionEnabled: false },
        };
      }
      if (message.type === UI_ATTACH_OVERLAY_VISIBILITY_GET) {
        return { ok: true, data: { visible: true } };
      }
      if (message.type === UI_ATTACH_OVERLAY_PROJECTION_ACK) {
        return { ok: true, data: { accepted: true } };
      }
      if (message.type === "ui-attach:overlays-restore-get") {
        restoreCalls += 1;
        return restoreCalls === 1
          ? staleRestore.promise
          : {
              ok: true,
              data: {
                origin: window.location.origin,
                projection: projectionDescriptor,
                activeItemId: null,
                items: [],
              },
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
      projection: projectionDescriptor,
      activeItemId: null,
      items: [],
    }, createSender(`${ORIGIN}/settings`), () => undefined);
    staleRestore.resolve({
      ok: true,
      data: {
        origin: window.location.origin,
        projection: projectionDescriptor,
        activeItemId: "att_save",
        items: [{
          itemId: "att_save",
          attachmentId: "att_save",
          label: "1",
          taskNote: "Update Save changes",
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
          data: { disclosureMode: "agent_safe", elementSelectionEnabled: true },
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
            data: { disclosureMode: "agent_safe", elementSelectionEnabled: false },
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
        elementSelectionEnabled: true,
        extra: SECRET,
      },
      { type: UI_ATTACH_CONTENT_SETTINGS_UPDATED, disclosureMode: "full_debug" },
      {
        type: UI_ATTACH_CONTENT_SETTINGS_UPDATED,
        disclosureMode: "full_debug",
        elementSelectionEnabled: "true",
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
      elementSelectionEnabled: true,
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
            data: { disclosureMode: "agent_safe", elementSelectionEnabled: true },
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
      elementSelectionEnabled: false,
    }, createSender(`${ORIGIN}/settings`), () => undefined);
    startupSettings.resolve({
      ok: true,
      data: { disclosureMode: "full_debug", elementSelectionEnabled: true },
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

describe("in-page widget capability boundary", () => {
  test("delegates toolbar activation to an SDK-owned page surface without minting a widget lease", async () => {
    const chrome = createChromeHarness();
    chrome.runtime.id = WIDGET_RUNTIME_ID;
    chrome.tabs.query = vi.fn(async () => [{
      id: WIDGET_TAB_ID,
      url: `${ORIGIN}/settings`,
      windowId: WIDGET_WINDOW_ID,
    }]);
    chrome.webNavigation.getFrame = vi.fn(async ({ tabId, frameId }) => (
      tabId === WIDGET_TAB_ID && frameId === 0
        ? {
            documentId: WIDGET_TOP_DOCUMENT_ID,
            parentFrameId: -1,
            url: `${ORIGIN}/settings`,
          }
        : undefined
    ));
    chrome.tabs.sendMessage = vi.fn(async (_tabId, message) => (
      isRecord(message) && message.type === UI_ATTACH_IN_PAGE_WIDGET_ENSURE
        ? { ok: true, data: { delegated: true, surfaceOwner: "sdk" } }
        : undefined
    ));
    const ensureContentScript = vi.fn(async () => true);
    const controller = createBackgroundController({
      chrome,
      store: createStoreHarness(),
      ensureContentScript,
    });

    await expect(controller.showInPageWidget(WIDGET_TAB_ID)).resolves.toBe(true);
    expect(chrome.tabs.sendMessage).toHaveBeenCalledTimes(1);
    expect(chrome.tabs.sendMessage).toHaveBeenCalledWith(
      WIDGET_TAB_ID,
      { type: UI_ATTACH_IN_PAGE_WIDGET_ENSURE },
      { frameId: 0, documentId: WIDGET_TOP_DOCUMENT_ID },
    );
    expect(vi.mocked(chrome.tabs.sendMessage).mock.calls.some(([, message]) => (
      parseInPageWidgetInitMessage(message) !== null
    ))).toBe(false);
  });

  test("shows the widget through the exact top document", async () => {
    const fixture = await createInPageWidgetFixture();

    expect(fixture.ensureContentScript).toHaveBeenCalledWith(
      WIDGET_TAB_ID,
      0,
      WIDGET_TOP_DOCUMENT_ID,
    );
    expect(fixture.chrome.tabs.sendMessage).toHaveBeenCalledWith(
      WIDGET_TAB_ID,
      { type: UI_ATTACH_IN_PAGE_WIDGET_ENSURE },
      { frameId: 0, documentId: WIDGET_TOP_DOCUMENT_ID },
    );
    expect(fixture.chrome.tabs.sendMessage).toHaveBeenCalledWith(
      WIDGET_TAB_ID,
      expect.objectContaining({
        type: UI_ATTACH_IN_PAGE_WIDGET_INIT,
        surfaceId: fixture.init.surfaceId,
        capability: fixture.init.capability,
      }),
      { frameId: 0, documentId: WIDGET_TOP_DOCUMENT_ID },
    );
  });

  test("arms and revokes one-shot diagnostics while widget selection is already active", async () => {
    const fixture = await createInPageWidgetFixture();

    await expect(dispatchRuntime(
      fixture.controller,
      createInPageWidgetCommandEnvelope(fixture.init, {
        type: "ui-attach:widget-selection-set",
        enabled: true,
        intent: "explicit",
        expectedGeneration: 0,
      }),
      fixture.widgetSender,
    )).resolves.toEqual({
      ok: true,
      data: { enabled: true, generation: 1, resumeAllowed: true },
    });
    await expect(dispatchRuntime(
      fixture.controller,
      createInPageWidgetCommandEnvelope(fixture.init, {
        type: "ui-attach:widget-basic-diagnostics-set",
        enabled: true,
        expectedGeneration: 1,
      }),
      fixture.widgetSender,
    )).resolves.toEqual({
      ok: true,
      data: { enabled: true, generation: 1, resumeAllowed: true },
    });

    const armed = await dispatchRuntime(fixture.controller, {
      type: "ui-attach:session-begin-capture",
      replaceItemId: null,
    }, createInPageWidgetContentSender());
    expect(armed).toMatchObject({
      ok: true,
      data: { collectBasicDiagnostics: true },
    });

    const consumed = await dispatchRuntime(fixture.controller, {
      type: "ui-attach:session-begin-capture",
      replaceItemId: null,
    }, createInPageWidgetContentSender());
    expect(consumed).toMatchObject({ ok: true });
    if (!consumed.ok) throw new Error(`capture begin failed: ${consumed.code}`);
    expect(Object.hasOwn(consumed.data, "collectBasicDiagnostics")).toBe(false);

    await dispatchRuntime(
      fixture.controller,
      createInPageWidgetCommandEnvelope(fixture.init, {
        type: "ui-attach:widget-basic-diagnostics-set",
        enabled: true,
        expectedGeneration: 1,
      }),
      fixture.widgetSender,
    );
    await dispatchRuntime(
      fixture.controller,
      createInPageWidgetCommandEnvelope(fixture.init, {
        type: "ui-attach:widget-basic-diagnostics-set",
        enabled: false,
        expectedGeneration: 1,
      }),
      fixture.widgetSender,
    );
    const revoked = await dispatchRuntime(fixture.controller, {
      type: "ui-attach:session-begin-capture",
      replaceItemId: null,
    }, createInPageWidgetContentSender());
    expect(revoked).toMatchObject({ ok: true });
    if (!revoked.ok) throw new Error(`capture begin failed: ${revoked.code}`);
    expect(Object.hasOwn(revoked.data, "collectBasicDiagnostics")).toBe(false);
  });

  test("serializes a delayed diagnostics arm before the next capture begin", async () => {
    const fixture = await createInPageWidgetFixture();
    await expect(dispatchRuntime(
      fixture.controller,
      createInPageWidgetCommandEnvelope(fixture.init, {
        type: "ui-attach:widget-selection-set",
        enabled: true,
        intent: "explicit",
        expectedGeneration: 0,
      }),
      fixture.widgetSender,
    )).resolves.toMatchObject({ ok: true, data: { enabled: true, generation: 1 } });

    const authorityReadEntered = createDeferred<void>();
    const releaseAuthorityRead = createDeferred<void>();
    const blockingIntentStore = createSelectionIntentStore({
      authorityStorage: {
        ...fixture.chrome.storage.local,
        get: vi.fn(async (keys) => {
          authorityReadEntered.resolve(undefined);
          await releaseAuthorityRead.promise;
          return await fixture.chrome.storage.local.get(keys);
        }),
      },
      poisonStorage: fixture.chrome.storage.session,
      randomUUID: () => "diagnostics-arm-blocker-authority",
    });
    const blockingAuthorityRead = blockingIntentStore.read();
    await authorityReadEntered.promise;

    const arming = dispatchRuntime(
      fixture.controller,
      createInPageWidgetCommandEnvelope(fixture.init, {
        type: "ui-attach:widget-basic-diagnostics-set",
        enabled: true,
        expectedGeneration: 1,
      }),
      fixture.widgetSender,
    );
    await flushAsyncWork();
    let beginSettled = false;
    const beginning = dispatchRuntime(fixture.controller, {
      type: "ui-attach:session-begin-capture",
      replaceItemId: null,
    }, createInPageWidgetContentSender()).finally(() => {
      beginSettled = true;
    });
    await flushMicrotasks();
    expect(beginSettled).toBe(false);

    releaseAuthorityRead.resolve(undefined);
    await expect(blockingAuthorityRead).resolves.toMatchObject({ ok: true });
    await expect(arming).resolves.toMatchObject({
      ok: true,
      data: { enabled: true, generation: 1 },
    });
    await expect(beginning).resolves.toMatchObject({
      ok: true,
      data: { collectBasicDiagnostics: true },
    });
  });

  test("keeps a diagnostics arm queued behind an already validating capture begin", async () => {
    const fixture = await createInPageWidgetFixture();
    await expect(dispatchRuntime(
      fixture.controller,
      createInPageWidgetCommandEnvelope(fixture.init, {
        type: "ui-attach:widget-selection-set",
        enabled: true,
        intent: "explicit",
        expectedGeneration: 0,
      }),
      fixture.widgetSender,
    )).resolves.toMatchObject({ ok: true, data: { enabled: true, generation: 1 } });

    const routeReadEntered = createDeferred<void>();
    const releaseRouteRead = createDeferred<void>();
    const originalGetAllFrames = fixture.chrome.webNavigation.getAllFrames;
    let delayNextRouteRead = true;
    fixture.chrome.webNavigation.getAllFrames = vi.fn(async (details) => {
      if (delayNextRouteRead) {
        delayNextRouteRead = false;
        routeReadEntered.resolve(undefined);
        await releaseRouteRead.promise;
      }
      return await originalGetAllFrames(details);
    });

    const beginning = dispatchRuntime(fixture.controller, {
      type: "ui-attach:session-begin-capture",
      replaceItemId: null,
    }, createInPageWidgetContentSender());
    await routeReadEntered.promise;
    let armSettled = false;
    const arming = dispatchRuntime(
      fixture.controller,
      createInPageWidgetCommandEnvelope(fixture.init, {
        type: "ui-attach:widget-basic-diagnostics-set",
        enabled: true,
        expectedGeneration: 1,
      }),
      fixture.widgetSender,
    ).finally(() => {
      armSettled = true;
    });
    await flushMicrotasks();
    expect(armSettled).toBe(false);

    releaseRouteRead.resolve(undefined);
    const first = await beginning;
    expect(first).toMatchObject({ ok: true });
    if (!first.ok) throw new Error(first.error);
    expect(Object.hasOwn(first.data, "collectBasicDiagnostics")).toBe(false);
    await expect(arming).resolves.toMatchObject({
      ok: true,
      data: { enabled: true, generation: 1 },
    });

    await expect(dispatchRuntime(fixture.controller, {
      type: "ui-attach:session-begin-capture",
      replaceItemId: null,
    }, createInPageWidgetContentSender())).resolves.toMatchObject({
      ok: true,
      data: { collectBasicDiagnostics: true },
    });
  });

  test("linearizes a queued diagnostics arm then revoke before the next begin", async () => {
    const fixture = await createInPageWidgetFixture();
    await expect(dispatchRuntime(
      fixture.controller,
      createInPageWidgetCommandEnvelope(fixture.init, {
        type: "ui-attach:widget-selection-set",
        enabled: true,
        intent: "explicit",
        expectedGeneration: 0,
      }),
      fixture.widgetSender,
    )).resolves.toMatchObject({ ok: true, data: { enabled: true, generation: 1 } });

    const authorityReadEntered = createDeferred<void>();
    const releaseAuthorityRead = createDeferred<void>();
    const blockingIntentStore = createSelectionIntentStore({
      authorityStorage: {
        ...fixture.chrome.storage.local,
        get: vi.fn(async (keys) => {
          authorityReadEntered.resolve(undefined);
          await releaseAuthorityRead.promise;
          return await fixture.chrome.storage.local.get(keys);
        }),
      },
      poisonStorage: fixture.chrome.storage.session,
      randomUUID: () => "diagnostics-revoke-blocker-authority",
    });
    const blockingAuthorityRead = blockingIntentStore.read();
    await authorityReadEntered.promise;

    const arming = dispatchRuntime(
      fixture.controller,
      createInPageWidgetCommandEnvelope(fixture.init, {
        type: "ui-attach:widget-basic-diagnostics-set",
        enabled: true,
        expectedGeneration: 1,
      }),
      fixture.widgetSender,
    );
    await flushMicrotasks();
    const revoking = dispatchRuntime(
      fixture.controller,
      createInPageWidgetCommandEnvelope(fixture.init, {
        type: "ui-attach:widget-basic-diagnostics-set",
        enabled: false,
        expectedGeneration: 1,
      }),
      fixture.widgetSender,
    );
    releaseAuthorityRead.resolve(undefined);
    await expect(blockingAuthorityRead).resolves.toMatchObject({ ok: true });
    await expect(arming).resolves.toMatchObject({ ok: true });
    await expect(revoking).resolves.toMatchObject({ ok: true });

    const begun = await dispatchRuntime(fixture.controller, {
      type: "ui-attach:session-begin-capture",
      replaceItemId: null,
    }, createInPageWidgetContentSender());
    expect(begun).toMatchObject({ ok: true });
    if (!begun.ok) throw new Error(begun.error);
    expect(Object.hasOwn(begun.data, "collectBasicDiagnostics")).toBe(false);
  });

  test("rejects stale and stop-restart ABA diagnostics generations without changing the marker", async () => {
    const fixture = await createInPageWidgetFixture();
    await expect(dispatchRuntime(
      fixture.controller,
      createInPageWidgetCommandEnvelope(fixture.init, {
        type: "ui-attach:widget-selection-set",
        enabled: true,
        intent: "explicit",
        expectedGeneration: 0,
      }),
      fixture.widgetSender,
    )).resolves.toMatchObject({ ok: true, data: { enabled: true, generation: 1 } });

    await expect(dispatchRuntime(
      fixture.controller,
      createInPageWidgetCommandEnvelope(fixture.init, {
        type: "ui-attach:widget-basic-diagnostics-set",
        enabled: true,
        expectedGeneration: 0,
      }),
      fixture.widgetSender,
    )).resolves.toMatchObject({ ok: false, code: "WIDGET_STATE_UNAVAILABLE" });
    let begun = await dispatchRuntime(fixture.controller, {
      type: "ui-attach:session-begin-capture",
      replaceItemId: null,
    }, createInPageWidgetContentSender());
    expect(begun).toMatchObject({ ok: true });
    if (!begun.ok) throw new Error(begun.error);
    expect(Object.hasOwn(begun.data, "collectBasicDiagnostics")).toBe(false);

    await expect(dispatchRuntime(
      fixture.controller,
      createInPageWidgetCommandEnvelope(fixture.init, {
        type: "ui-attach:widget-selection-set",
        enabled: false,
        intent: "explicit",
        expectedGeneration: 1,
      }),
      fixture.widgetSender,
    )).resolves.toMatchObject({ ok: true, data: { enabled: false, generation: 2 } });
    await expect(dispatchRuntime(
      fixture.controller,
      createInPageWidgetCommandEnvelope(fixture.init, {
        type: "ui-attach:widget-selection-set",
        enabled: true,
        intent: "explicit",
        expectedGeneration: 2,
      }),
      fixture.widgetSender,
    )).resolves.toMatchObject({ ok: true, data: { enabled: true, generation: 3 } });
    await expect(dispatchRuntime(
      fixture.controller,
      createInPageWidgetCommandEnvelope(fixture.init, {
        type: "ui-attach:widget-basic-diagnostics-set",
        enabled: true,
        expectedGeneration: 1,
      }),
      fixture.widgetSender,
    )).resolves.toMatchObject({ ok: false, code: "WIDGET_STATE_UNAVAILABLE" });

    begun = await dispatchRuntime(fixture.controller, {
      type: "ui-attach:session-begin-capture",
      replaceItemId: null,
    }, createInPageWidgetContentSender());
    expect(begun).toMatchObject({ ok: true });
    if (!begun.ok) throw new Error(begun.error);
    expect(Object.hasOwn(begun.data, "collectBasicDiagnostics")).toBe(false);

    await expect(dispatchRuntime(
      fixture.controller,
      createInPageWidgetCommandEnvelope(fixture.init, {
        type: "ui-attach:widget-basic-diagnostics-set",
        enabled: true,
        expectedGeneration: 3,
      }),
      fixture.widgetSender,
    )).resolves.toMatchObject({ ok: true });
    await expect(dispatchRuntime(
      fixture.controller,
      createInPageWidgetCommandEnvelope(fixture.init, {
        type: "ui-attach:widget-basic-diagnostics-set",
        enabled: false,
        expectedGeneration: 2,
      }),
      fixture.widgetSender,
    )).resolves.toMatchObject({ ok: false, code: "WIDGET_STATE_UNAVAILABLE" });
    await expect(dispatchRuntime(fixture.controller, {
      type: "ui-attach:session-begin-capture",
      replaceItemId: null,
    }, createInPageWidgetContentSender())).resolves.toMatchObject({
      ok: true,
      data: { collectBasicDiagnostics: true },
    });

    await expect(dispatchRuntime(
      fixture.controller,
      createInPageWidgetCommandEnvelope(fixture.init, {
        type: "ui-attach:widget-basic-diagnostics-set",
        enabled: true,
        expectedGeneration: 2,
      }),
      fixture.widgetSender,
    )).resolves.toMatchObject({ ok: false, code: "WIDGET_STATE_UNAVAILABLE" });
    const stillUnarmed = await dispatchRuntime(fixture.controller, {
      type: "ui-attach:session-begin-capture",
      replaceItemId: null,
    }, createInPageWidgetContentSender());
    expect(stillUnarmed).toMatchObject({ ok: true });
    if (!stillUnarmed.ok) throw new Error(stillUnarmed.error);
    expect(Object.hasOwn(stillUnarmed.data, "collectBasicDiagnostics")).toBe(false);
  });

  test("registers only the runtime-owned exact widget iframe document", async () => {
    const fixture = await createInPageWidgetFixture();
    const registration = createInPageWidgetRegistration(fixture.init);

    await expect(dispatchRuntime(
      fixture.controller,
      registration,
      fixture.widgetSender,
    )).resolves.toEqual({ ok: true, data: { registered: true } });

    const untrustedSenders: UiAttachChromeMessageSender[] = [
      { ...fixture.widgetSender, id: "other-extension" },
      { ...fixture.widgetSender, documentId: "stale-widget-document" },
      { ...fixture.widgetSender, url: `${WIDGET_URL}?surface=spoofed` },
    ];
    for (const sender of untrustedSenders) {
      await expect(dispatchRuntime(
        fixture.controller,
        registration,
        sender,
      )).resolves.toMatchObject({ ok: false, code: "UNTRUSTED_SENDER" });
    }
  });

  test("accepts an exact capability-bound widget when Chrome omits child-frame inventory", async () => {
    const fixture = await createInPageWidgetFixture();
    const originalGetFrame = fixture.chrome.webNavigation.getFrame;
    fixture.chrome.webNavigation.getFrame = vi.fn(async (details) => (
      details.frameId === 0 ? originalGetFrame(details) : undefined
    ));

    await expect(dispatchRuntime(
      fixture.controller,
      createInPageWidgetRegistration(fixture.init),
      fixture.widgetSender,
    )).resolves.toEqual({ ok: true, data: { registered: true } });
  });

  test("accepts an exact capability-bound widget when Chrome rejects child-frame inventory", async () => {
    const fixture = await createInPageWidgetFixture();
    const originalGetFrame = fixture.chrome.webNavigation.getFrame;
    fixture.chrome.webNavigation.getFrame = vi.fn(async (details) => {
      if (details.frameId === 0) return originalGetFrame(details);
      throw new Error("No frame with id");
    });

    await expect(dispatchRuntime(
      fixture.controller,
      createInPageWidgetRegistration(fixture.init),
      fixture.widgetSender,
    )).resolves.toEqual({ ok: true, data: { registered: true } });
  });

  test("reports a bounded registration handler phase when a Chrome API throws synchronously", async () => {
    const fixture = await createInPageWidgetFixture();
    const originalGetFrame = fixture.chrome.webNavigation.getFrame;
    fixture.chrome.webNavigation.getFrame = vi.fn((details) => {
      if (details.frameId !== 0) throw new Error("Extension context changed");
      return originalGetFrame(details);
    });

    await expect(dispatchRuntime(
      fixture.controller,
      createInPageWidgetRegistration(fixture.init),
      fixture.widgetSender,
    )).resolves.toMatchObject({
      ok: false,
      code: "CAPTURE_FAILED",
      issues: [{ path: "widget", message: "WIDGET_REGISTER_HANDLER_EXCEPTION" }],
    });
  });

  test("retries a transient top-frame inventory rejection without weakening sender checks", async () => {
    const fixture = await createInPageWidgetFixture();
    const originalGetFrame = fixture.chrome.webNavigation.getFrame;
    let rejectedTopLookup = false;
    fixture.chrome.webNavigation.getFrame = vi.fn(async (details) => {
      if (details.frameId === 0 && !rejectedTopLookup) {
        rejectedTopLookup = true;
        throw new Error("Frame inventory is refreshing");
      }
      return originalGetFrame(details);
    });

    await expect(dispatchRuntime(
      fixture.controller,
      createInPageWidgetRegistration(fixture.init),
      fixture.widgetSender,
    )).resolves.toEqual({ ok: true, data: { registered: true } });
    expect(rejectedTopLookup).toBe(true);
  });

  test("reports persistent top-frame inventory failure after bounded retries", async () => {
    const fixture = await createInPageWidgetFixture();
    const originalGetFrame = fixture.chrome.webNavigation.getFrame;
    fixture.chrome.webNavigation.getFrame = vi.fn(async (details) => {
      if (details.frameId === 0) throw new Error("Frame inventory remains unavailable");
      return originalGetFrame(details);
    });

    await expect(dispatchRuntime(
      fixture.controller,
      createInPageWidgetRegistration(fixture.init),
      fixture.widgetSender,
    )).resolves.toMatchObject({
      ok: false,
      code: "UNTRUSTED_SENDER",
      issues: [{ path: "widget", message: "WIDGET_REGISTER_TOP_INVENTORY" }],
    });
    expect(fixture.chrome.webNavigation.getFrame).toHaveBeenCalledTimes(3);
  });

  test("rejects a registration whose lease is revoked while frame inventory is pending", async () => {
    const fixture = await createInPageWidgetFixture();
    const originalGetFrame = fixture.chrome.webNavigation.getFrame;
    const lookupStarted = createDeferred<void>();
    const releaseLookup = createDeferred<Awaited<ReturnType<typeof originalGetFrame>>>();
    let delayed = false;
    fixture.chrome.webNavigation.getFrame = vi.fn(async (details) => {
      if (details.frameId === 0 && !delayed) {
        delayed = true;
        lookupStarted.resolve(undefined);
        return releaseLookup.promise;
      }
      return originalGetFrame(details);
    });

    const registering = dispatchRuntime(
      fixture.controller,
      createInPageWidgetRegistration(fixture.init),
      fixture.widgetSender,
    );
    await lookupStarted.promise;
    await fixture.controller.handleNavigationCommitted({
      tabId: WIDGET_TAB_ID,
      frameId: 0,
      parentFrameId: -1,
      documentId: "replacement-top-document",
      url: `${ORIGIN}/replacement`,
    });
    releaseLookup.resolve({
      documentId: WIDGET_TOP_DOCUMENT_ID,
      parentFrameId: -1,
      url: `${ORIGIN}/settings`,
    });

    await expect(registering).resolves.toMatchObject({
      ok: false,
      code: "UNTRUSTED_SENDER",
      issues: [{ path: "widget", message: "WIDGET_REGISTER_LEASE" }],
    });
  });

  test("does not revive a dormant lease whose restore overlaps terminal tab navigation", async () => {
    const originalSetTimeout = globalThis.setTimeout;
    let firstConnectExpiry: (() => void) | null = null;
    const setTimeoutSpy = vi.spyOn(globalThis, "setTimeout").mockImplementation((handler, delay, ...args) => {
      if (delay === 6_000 && typeof handler === "function" && firstConnectExpiry === null) {
        firstConnectExpiry = () => handler(...args);
        return 60_003 as ReturnType<typeof setTimeout>;
      }
      return originalSetTimeout(handler, delay, ...args);
    });
    try {
      const fixture = await createInPageWidgetFixture();
      expect(firstConnectExpiry).toEqual(expect.any(Function));
      firstConnectExpiry?.();
      await flushAsyncWork();

      const restoreWriteStarted = createDeferred<void>();
      const releaseRestoreWrite = createDeferred<void>();
      const originalSessionSet = fixture.chrome.storage.session.set;
      let delayedRestoreWrite = false;
      fixture.chrome.storage.session.set = vi.fn(async (values) => {
        if (!delayedRestoreWrite && Object.hasOwn(values, IN_PAGE_WIDGET_LEASE_STORAGE_KEY)) {
          delayedRestoreWrite = true;
          restoreWriteStarted.resolve(undefined);
          await releaseRestoreWrite.promise;
        }
        await originalSessionSet(values);
      });

      const registering = dispatchRuntime(
        fixture.controller,
        createInPageWidgetRegistration(fixture.init),
        fixture.widgetSender,
      );
      await restoreWriteStarted.promise;
      const navigating = fixture.controller.handleNavigationCommitted({
        tabId: WIDGET_TAB_ID,
        frameId: 0,
        parentFrameId: -1,
        documentId: "replacement-top-document",
        url: `${ORIGIN}/replacement`,
      });
      releaseRestoreWrite.resolve(undefined);

      await navigating;
      await expect(registering).resolves.toMatchObject({
        ok: false,
        code: "UNTRUSTED_SENDER",
        issues: [{ path: "widget", message: "WIDGET_REGISTER_LEASE" }],
      });
      await expect(dispatchRuntime(
        fixture.controller,
        createInPageWidgetRegistration(fixture.init),
        fixture.widgetSender,
      )).resolves.toMatchObject({
        ok: false,
        code: "UNTRUSTED_SENDER",
        issues: [{ path: "widget", message: "WIDGET_REGISTER_LEASE" }],
      });
    } finally {
      setTimeoutSpy.mockRestore();
    }
  });

  test("keeps a widget lease across transient tab loading until a new top document commits", async () => {
    const fixture = await createInPageWidgetFixture();
    await expect(dispatchRuntime(
      fixture.controller,
      createInPageWidgetRegistration(fixture.init),
      fixture.widgetSender,
    )).resolves.toEqual({ ok: true, data: { registered: true } });
    const lifecycle = await connectInPageWidgetLifecycle(fixture);
    const disconnectListener = vi.mocked(lifecycle.disconnectEvent.addListener).mock.calls[0]?.[0] as
      | (() => void)
      | undefined;
    vi.useFakeTimers();
    try {
      disconnectListener?.();
      await expect(fixture.controller.handleTabUpdated(
        WIDGET_TAB_ID,
        { status: "loading", url: `${ORIGIN}/settings` },
        { id: WIDGET_TAB_ID, url: `${ORIGIN}/settings`, windowId: WIDGET_WINDOW_ID },
      )).resolves.toBeUndefined();
      await vi.advanceTimersByTimeAsync(6_001);

      const replacementDocumentId = "widget-document-after-transient-loading";
      fixture.frameState.widgetDocumentId = replacementDocumentId;
      await expect(dispatchRuntime(
        fixture.controller,
        createInPageWidgetRegistration(fixture.init),
        { ...fixture.widgetSender, documentId: replacementDocumentId },
      )).resolves.toEqual({ ok: true, data: { registered: true } });
      const invalidations = await fixture.chrome.storage.local.get(
        IN_PAGE_WIDGET_LEASE_INVALIDATIONS_LOCAL_KEY,
      );
      expect(invalidations[IN_PAGE_WIDGET_LEASE_INVALIDATIONS_LOCAL_KEY] ?? []).toEqual([]);
      const storedLease = await fixture.chrome.storage.session.get(IN_PAGE_WIDGET_LEASE_STORAGE_KEY);
      expect(storedLease[IN_PAGE_WIDGET_LEASE_STORAGE_KEY]).toMatchObject({
        leases: [{ surfaceId: fixture.init.surfaceId, tabId: WIDGET_TAB_ID }],
      });
    } finally {
      vi.useRealTimers();
    }
  });

  test("does not block a dormant lease restore while another tab is terminating", async () => {
    const originalSetTimeout = globalThis.setTimeout;
    let firstConnectExpiry: (() => void) | null = null;
    const setTimeoutSpy = vi.spyOn(globalThis, "setTimeout").mockImplementation((handler, delay, ...args) => {
      if (delay === 6_000 && typeof handler === "function" && firstConnectExpiry === null) {
        firstConnectExpiry = () => handler(...args);
        return 60_005 as ReturnType<typeof setTimeout>;
      }
      return originalSetTimeout(handler, delay, ...args);
    });
    try {
      const fixture = await createInPageWidgetFixture();
      expect(firstConnectExpiry).toEqual(expect.any(Function));
      firstConnectExpiry?.();
      await flushAsyncWork();

      const otherTabRevokeStarted = createDeferred<void>();
      const releaseOtherTabRevoke = createDeferred<void>();
      const originalSessionGet = fixture.chrome.storage.session.get;
      let delayedOtherTabRevoke = false;
      fixture.chrome.storage.session.get = vi.fn(async (keys) => {
        if (!delayedOtherTabRevoke && keys === IN_PAGE_WIDGET_LEASE_STORAGE_KEY) {
          delayedOtherTabRevoke = true;
          otherTabRevokeStarted.resolve(undefined);
          await releaseOtherTabRevoke.promise;
        }
        return await originalSessionGet(keys);
      });

      const otherTabId = WIDGET_TAB_ID + 1;
      const terminatingOtherTab = fixture.controller.handleNavigationCommitted({
        tabId: otherTabId,
        frameId: 0,
        parentFrameId: -1,
        documentId: "other-replacement-top-document",
        url: `${OTHER_ORIGIN}/replacement`,
      });
      await otherTabRevokeStarted.promise;
      const registering = dispatchRuntime(
        fixture.controller,
        createInPageWidgetRegistration(fixture.init),
        fixture.widgetSender,
      );
      releaseOtherTabRevoke.resolve(undefined);

      await terminatingOtherTab;
      await expect(registering).resolves.toEqual({ ok: true, data: { registered: true } });
    } finally {
      setTimeoutSpy.mockRestore();
    }
  });

  test("does not preserve a replacement lease after terminal surface release", async () => {
    const originalSetTimeout = globalThis.setTimeout;
    let firstConnectExpiry: (() => void) | null = null;
    const setTimeoutSpy = vi.spyOn(globalThis, "setTimeout").mockImplementation((handler, delay, ...args) => {
      if (delay === 6_000 && typeof handler === "function" && firstConnectExpiry === null) {
        firstConnectExpiry = () => handler(...args);
        return 60_004 as ReturnType<typeof setTimeout>;
      }
      return originalSetTimeout(handler, delay, ...args);
    });
    try {
      const fixture = await createInPageWidgetFixture();
      expect(firstConnectExpiry).toEqual(expect.any(Function));
      firstConnectExpiry?.();
      await flushAsyncWork();

      const restoreWriteStarted = createDeferred<void>();
      const releaseRestoreWrite = createDeferred<void>();
      const originalSessionSet = fixture.chrome.storage.session.set;
      let delayedRestoreWrite = false;
      fixture.chrome.storage.session.set = vi.fn(async (values) => {
        if (!delayedRestoreWrite && Object.hasOwn(values, IN_PAGE_WIDGET_LEASE_STORAGE_KEY)) {
          delayedRestoreWrite = true;
          restoreWriteStarted.resolve(undefined);
          await releaseRestoreWrite.promise;
        }
        await originalSessionSet(values);
      });
      const originalGetFrame = fixture.chrome.webNavigation.getFrame;
      const releaseLookupStarted = createDeferred<void>();
      const releaseLookup = createDeferred<Awaited<ReturnType<typeof originalGetFrame>>>();
      let delayedReleaseLookup = false;
      fixture.chrome.webNavigation.getFrame = vi.fn(async (details) => {
        if (details.frameId === 0 && !delayedReleaseLookup) {
          delayedReleaseLookup = true;
          releaseLookupStarted.resolve(undefined);
          return releaseLookup.promise;
        }
        return originalGetFrame(details);
      });

      const releasing = dispatchRuntime(
        fixture.controller,
        createInPageWidgetCommandEnvelope(fixture.init, {
          type: "ui-attach:widget-surface-release",
        }),
        fixture.widgetSender,
      );
      await restoreWriteStarted.promise;
      const replacementRegistration = dispatchRuntime(
        fixture.controller,
        createInPageWidgetRegistration(fixture.init),
        fixture.widgetSender,
      );
      releaseRestoreWrite.resolve(undefined);
      await releaseLookupStarted.promise;
      await expect(replacementRegistration).resolves.toEqual({
        ok: true,
        data: { registered: true },
      });
      releaseLookup.resolve({
        documentId: WIDGET_TOP_DOCUMENT_ID,
        parentFrameId: -1,
        url: `${ORIGIN}/settings`,
      });

      await expect(releasing).resolves.toEqual({ ok: true, data: null });
      await expect(dispatchRuntime(
        fixture.controller,
        createInPageWidgetRegistration(fixture.init),
        fixture.widgetSender,
      )).resolves.toMatchObject({
        ok: false,
        code: "UNTRUSTED_SENDER",
        issues: [{ path: "widget", message: "WIDGET_REGISTER_LEASE" }],
      });
      await expect(dispatchRuntime(
        fixture.controller,
        { type: UI_ATTACH_OVERLAY_VISIBILITY_GET },
        createInPageWidgetContentSender(),
      )).resolves.toEqual({ ok: true, data: { visible: false } });
    } finally {
      setTimeoutSpy.mockRestore();
    }
  });

  test("reports an exact lease failure after a terminal surface release", async () => {
    const fixture = await createInPageWidgetFixture();
    await expect(dispatchRuntime(
      fixture.controller,
      createInPageWidgetCommandEnvelope(fixture.init, {
        type: "ui-attach:widget-surface-release",
      }),
      fixture.widgetSender,
    )).resolves.toEqual({ ok: true, data: null });

    await expect(dispatchRuntime(
      fixture.controller,
      createInPageWidgetRegistration(fixture.init),
      fixture.widgetSender,
    )).resolves.toMatchObject({
      ok: false,
      code: "UNTRUSTED_SENDER",
      issues: [{ path: "widget", message: "WIDGET_REGISTER_LEASE" }],
    });
  });

  test("accepts child-frame inventory without a duplicated documentId witness", async () => {
    const fixture = await createInPageWidgetFixture();
    fixture.frameState.widgetDocumentId = undefined;

    await expect(dispatchRuntime(
      fixture.controller,
      createInPageWidgetRegistration(fixture.init),
      fixture.widgetSender,
    )).resolves.toEqual({ ok: true, data: { registered: true } });
  });

  test("keeps session read and annotation mutations bound to the leased tab without caller origin", async () => {
    const fixture = await createInPageWidgetFixture();
    fixture.chrome.tabs.query = vi.fn(async () => [{
      id: 8,
      url: `${ORIGIN}/another-active-page`,
      windowId: WIDGET_WINDOW_ID,
    }]);
    const readEnvelope = createInPageWidgetCommandEnvelope(fixture.init, {
      type: "ui-attach:widget-session-read",
    });
    const spoofedSaveEnvelope = createInPageWidgetCommandEnvelope(fixture.init, {
      type: "ui-attach:widget-task-note-save",
      expectedEpoch: "epoch-1",
      itemId: fixture.itemId,
      taskNote: "Bounded task note",
      origin: OTHER_ORIGIN,
    });
    const saveEnvelope = createInPageWidgetCommandEnvelope(fixture.init, {
      type: "ui-attach:widget-task-note-save",
      expectedEpoch: "epoch-1",
      itemId: fixture.itemId,
      taskNote: "Bounded task note",
    });
    const lifecycleEnvelope = createInPageWidgetCommandEnvelope(fixture.init, {
      type: "ui-attach:widget-annotation-lifecycle-set",
      expectedEpoch: "epoch-1",
      itemId: fixture.itemId,
      annotationId: "opaque-widget-annotation-a",
      expectedState: "open",
      nextState: "resolved",
    });

    expect(Object.hasOwn(readEnvelope.command, "origin")).toBe(false);
    await expect(dispatchRuntime(
      fixture.controller,
      readEnvelope,
      fixture.widgetSender,
    )).resolves.toMatchObject({
      ok: true,
      data: {
        origin: ORIGIN,
        activePage: {
          tabId: WIDGET_TAB_ID,
          frameId: 0,
          documentId: WIDGET_TOP_DOCUMENT_ID,
        },
      },
    });
    expect(fixture.store.read).toHaveBeenCalledWith(ORIGIN);

    await expect(dispatchRuntime(
      fixture.controller,
      spoofedSaveEnvelope,
      fixture.widgetSender,
    )).resolves.toMatchObject({ ok: false, code: "UNTRUSTED_SENDER" });
    expect(fixture.store.updateIntent).not.toHaveBeenCalled();

    expect(Object.hasOwn(saveEnvelope.command, "origin")).toBe(false);
    await expect(dispatchRuntime(
      fixture.controller,
      saveEnvelope,
      fixture.widgetSender,
    )).resolves.toMatchObject({ ok: true });
    expect(fixture.store.updateIntent).toHaveBeenCalledWith(
      ORIGIN,
      "epoch-1",
      fixture.itemId,
      "Bounded task note",
      expect.objectContaining({
        isCurrent: expect.any(Function),
        refresh: expect.any(Function),
      }),
    );
    await expect(dispatchRuntime(
      fixture.controller,
      lifecycleEnvelope,
      fixture.widgetSender,
    )).resolves.toMatchObject({ ok: true });
    expect(fixture.store.updateAnnotationLifecycle).toHaveBeenCalledWith(
      ORIGIN,
      "epoch-1",
      fixture.itemId,
      "opaque-widget-annotation-a",
      "open",
      "resolved",
      expect.objectContaining({
        isCurrent: expect.any(Function),
        refresh: expect.any(Function),
      }),
    );
  });

  test("rejects a widget lifecycle mutation when document authority changes before durable write", async () => {
    const fixture = await createInPageWidgetFixture();
    const enteredStore = createDeferred<void>();
    const releaseStore = createDeferred<void>();
    const record = createCaptureRecord("save", "Save changes");
    record.origin = ORIGIN;
    record.pageUrl = `${ORIGIN}/settings`;
    record.tabId = WIDGET_TAB_ID;
    record.frameId = 0;
    fixture.store.updateAnnotationLifecycle = vi.fn(async (
      _origin,
      _epoch,
      _itemId,
      _annotationId,
      _expectedState,
      _nextState,
      authority?: SessionMutationAuthority,
    ) => {
      enteredStore.resolve();
      await releaseStore.promise;
      if (!authority?.isCurrent() || !await authority.refresh(record) || !authority.isCurrent()) {
        return {
          ok: false as const,
          code: "STALE_SESSION" as const,
          message: "Session mutation authority is stale.",
        };
      }
      return { ok: true as const, value: createSessionReadback(record) };
    });
    const lifecycleEnvelope = createInPageWidgetCommandEnvelope(fixture.init, {
      type: "ui-attach:widget-annotation-lifecycle-set",
      expectedEpoch: "epoch-1",
      itemId: fixture.itemId,
      annotationId: "opaque-widget-annotation-a",
      expectedState: "open",
      nextState: "resolved",
    });

    const pending = dispatchRuntime(
      fixture.controller,
      lifecycleEnvelope,
      fixture.widgetSender,
    );
    await enteredStore.promise;
    fixture.frameState.topDocumentId = "widget-replacement-document";
    releaseStore.resolve();

    await expect(pending).resolves.toMatchObject({ ok: false, code: "STALE_SESSION" });
  });

  test("restores the widget lease for a replacement document after its lifecycle port disconnects", async () => {
    const fixture = await createInPageWidgetFixture();
    const lifecycle = await connectInPageWidgetLifecycle(fixture);

    expect(lifecycle.port.disconnect).not.toHaveBeenCalled();
    const disconnectListener = vi.mocked(lifecycle.disconnectEvent.addListener).mock.calls[0]?.[0] as
      | (() => void)
      | undefined;
    disconnectListener?.();

    await expect(dispatchRuntime(
      fixture.controller,
      { type: UI_ATTACH_OVERLAY_VISIBILITY_GET },
      createInPageWidgetContentSender(),
    )).resolves.toEqual({ ok: true, data: { visible: true } });

    const replacementDocumentId = "widget-document-replacement";
    fixture.frameState.widgetDocumentId = replacementDocumentId;
    const replacementSender = {
      ...fixture.widgetSender,
      documentId: replacementDocumentId,
    };

    await expect(dispatchRuntime(
      fixture.controller,
      createInPageWidgetRegistration(fixture.init),
      replacementSender,
    )).resolves.toEqual({ ok: true, data: { registered: true } });
  });

  test("lists and selects live frame scopes through the leased tab without caller tab authority", async () => {
    const onActiveSessionChanged = vi.fn(async () => undefined);
    const fixture = await createInPageWidgetFixture();
    const topRecords = ["top-one", "top-two", "top-three", "stale-same-route"].map((id) => {
      const record = createCaptureRecord(id, id);
      record.origin = ORIGIN;
      record.pageUrl = `${ORIGIN}/settings`;
      record.tabId = WIDGET_TAB_ID;
      record.frameId = 0;
      return record;
    });
    const childRecords = ["child-one", "child-two", "child-three", "child-four"].map((id) => {
      const record = createCaptureRecord(id, id);
      record.origin = OTHER_ORIGIN;
      record.pageUrl = `${OTHER_ORIGIN}/editor`;
      record.tabId = WIDGET_TAB_ID;
      record.frameId = 9;
      record.routeChain = [
        { origin: ORIGIN, pathname: "/settings" },
        { origin: OTHER_ORIGIN, pathname: "/editor" },
      ];
      return record;
    });
    fixture.store.read = vi.fn(async (origin) => ({
      ok: true,
      value: createSessionReadbackMany(origin === OTHER_ORIGIN ? childRecords : topRecords),
    }));
    fixture.chrome.webNavigation.getAllFrames = vi.fn(async ({ tabId }) => tabId === WIDGET_TAB_ID
      ? [
          {
            frameId: 0,
            parentFrameId: -1,
            documentId: WIDGET_TOP_DOCUMENT_ID,
            url: `${ORIGIN}/settings`,
          },
          {
            frameId: 3,
            parentFrameId: 0,
            documentId: "child-frame-document",
            url: `${OTHER_ORIGIN}/editor`,
          },
        ]
      : []);
    const originalGetFrame = fixture.chrome.webNavigation.getFrame;
    fixture.chrome.webNavigation.getFrame = vi.fn(async (details) => details.tabId === WIDGET_TAB_ID &&
        details.frameId === 3
      ? {
          frameId: 3,
          parentFrameId: 0,
          documentId: "child-frame-document",
          url: `${OTHER_ORIGIN}/editor`,
        }
      : originalGetFrame(details));
    await fixture.chrome.storage.local.set({
      [OVERLAY_PROJECTION_AUTHORITY_GENERATION_KEY]: 50,
    });
    await fixture.chrome.storage.session.set({
      [OVERLAY_PROJECTIONS_SESSION_KEY]: {
        generation: 50,
        records: [{
          projection: {
            version: 1,
            projectionId: "top-scope-projection",
            revision: 1,
            sessionEpoch: "epoch-1",
            subject: {
              tabId: WIDGET_TAB_ID,
              frameId: 0,
              documentId: WIDGET_TOP_DOCUMENT_ID,
              origin: ORIGIN,
              pathname: "/settings",
            },
          },
          itemIds: ["att_top-one", "att_top-two", "att_top-three"],
          activeItemId: "att_top-three",
          delivery: "acknowledged",
          updatedAt: 1,
        }],
      },
    });
    fixture.controller = createBackgroundController({
      chrome: fixture.chrome,
      store: fixture.store,
      ensureContentScript: fixture.ensureContentScript,
      onActiveSessionChanged,
    });
    await expect(dispatchRuntime(
      fixture.controller,
      createInPageWidgetRegistration(fixture.init),
      fixture.widgetSender,
    )).resolves.toEqual({ ok: true, data: { registered: true } });
    const childContentSender: UiAttachChromeMessageSender = {
      ...createInPageWidgetContentSender(),
      url: `${OTHER_ORIGIN}/editor`,
      frameId: 3,
      documentId: "child-frame-document",
    };
    await expect(dispatchRuntime(fixture.controller, {
      type: "ui-attach:overlay-scope-visibility-get",
    }, createInPageWidgetContentSender())).resolves.toEqual({ ok: true, data: { visible: true } });
    await expect(dispatchRuntime(fixture.controller, {
      type: "ui-attach:overlay-scope-visibility-get",
    }, childContentSender)).resolves.toEqual({ ok: true, data: { visible: false } });
    const listed = await dispatchRuntime(
      fixture.controller,
      createInPageWidgetCommandEnvelope(fixture.init, {
        type: "ui-attach:widget-frame-scope-list",
      }),
      fixture.widgetSender,
    );
    expect(listed).toEqual({
      ok: true,
      data: {
        currentFrameId: 0,
        scopes: [
          expect.objectContaining({
            frameId: 0,
            depth: 0,
            selectable: true,
            itemCount: 3,
            itemIds: ["att_top-one", "att_top-two", "att_top-three"],
          }),
          expect.objectContaining({
            frameId: 3,
            depth: 1,
            requiresHostPermission: true,
            selectable: true,
            itemCount: 4,
            itemIds: ["att_child-one", "att_child-two", "att_child-three", "att_child-four"],
          }),
        ],
      },
    });
    expect((listed as { data?: object }).data).not.toHaveProperty("tabId");

    await expect(dispatchRuntime(
      fixture.controller,
      createInPageWidgetCommandEnvelope(fixture.init, {
        type: "ui-attach:widget-frame-scope-select",
        tabId: WIDGET_TAB_ID,
        frameId: 3,
        documentId: "child-frame-document",
        origin: OTHER_ORIGIN,
        pathname: "/editor",
        expectedGeneration: 0,
      }),
      fixture.widgetSender,
    )).resolves.toMatchObject({ ok: false, code: "UNTRUSTED_SENDER" });

    vi.mocked(fixture.chrome.tabs.sendMessage).mockClear();
    await expect(dispatchRuntime(
      fixture.controller,
      createInPageWidgetCommandEnvelope(fixture.init, {
        type: "ui-attach:widget-frame-scope-select",
        frameId: 3,
        documentId: "child-frame-document",
        origin: OTHER_ORIGIN,
        pathname: "/editor",
        expectedGeneration: 0,
      }),
      fixture.widgetSender,
    )).resolves.toEqual({ ok: true, data: { enabled: false } });
    await expect(dispatchRuntime(
      fixture.controller,
      createInPageWidgetCommandEnvelope(fixture.init, {
        type: "ui-attach:widget-session-read",
      }),
      fixture.widgetSender,
    )).resolves.toMatchObject({
      ok: true,
      data: { activePage: { frameId: 3, documentId: "child-frame-document" } },
    });
    expect(onActiveSessionChanged).toHaveBeenCalledWith(expect.objectContaining({
      activePage: expect.objectContaining({
        tabId: WIDGET_TAB_ID,
        frameId: 3,
        documentId: "child-frame-document",
        origin: OTHER_ORIGIN,
        pathname: "/editor",
      }),
    }));
    expect(fixture.ensureContentScript).toHaveBeenCalledWith(
      WIDGET_TAB_ID,
      3,
      "child-frame-document",
    );
    expect(vi.mocked(fixture.chrome.tabs.sendMessage).mock.calls.filter(([, message, target]) => (
      isRecord(message) && message.type === UI_ATTACH_OVERLAY_RESTORE_REFRESH &&
      target?.frameId === 3 && target.documentId === "child-frame-document"
    ))).toHaveLength(1);
    expect(vi.mocked(fixture.chrome.tabs.sendMessage).mock.calls.filter(([, message]) => (
      isRecord(message) && message.type === "ui-attach:overlay-scope-visibility-updated"
    ))).toEqual([
      [WIDGET_TAB_ID, {
        type: "ui-attach:overlay-scope-visibility-updated",
        visible: false,
      }, { frameId: 0, documentId: WIDGET_TOP_DOCUMENT_ID }],
      [WIDGET_TAB_ID, {
        type: "ui-attach:overlay-scope-visibility-updated",
        visible: true,
      }, { frameId: 3, documentId: "child-frame-document" }],
    ]);
    await expect(dispatchRuntime(fixture.controller, {
      type: "ui-attach:overlay-scope-visibility-get",
    }, createInPageWidgetContentSender())).resolves.toEqual({ ok: true, data: { visible: false } });
    await expect(dispatchRuntime(fixture.controller, {
      type: "ui-attach:overlay-scope-visibility-get",
    }, childContentSender)).resolves.toEqual({ ok: true, data: { visible: true } });

    await expect(dispatchRuntime(
      fixture.controller,
      createInPageWidgetCommandEnvelope(fixture.init, {
        type: "ui-attach:widget-frame-scope-list",
      }),
      fixture.widgetSender,
    )).resolves.toMatchObject({
      ok: true,
      data: { currentFrameId: 3 },
    });

    await expect(dispatchRuntime(
      fixture.controller,
      createInPageWidgetCommandEnvelope(fixture.init, {
        type: "ui-attach:widget-selection-set",
        enabled: true,
        intent: "explicit",
        expectedGeneration: 0,
      }),
      fixture.widgetSender,
    )).resolves.toEqual({
      ok: true,
      data: { enabled: true, generation: 1, resumeAllowed: true },
    });
    expect(fixture.ensureContentScript).toHaveBeenLastCalledWith(WIDGET_TAB_ID, 3);

    await expect(dispatchRuntime(
      fixture.controller,
      createInPageWidgetCommandEnvelope(fixture.init, {
        type: "ui-attach:widget-selection-set",
        enabled: false,
        intent: "explicit",
        expectedGeneration: 1,
      }),
      fixture.widgetSender,
    )).resolves.toEqual({
      ok: true,
      data: { enabled: false, generation: 2, resumeAllowed: false },
    });
    await expect(dispatchRuntime(
      fixture.controller,
      createInPageWidgetCommandEnvelope(fixture.init, {
        type: "ui-attach:widget-frame-scope-list",
      }),
      fixture.widgetSender,
    )).resolves.toMatchObject({
      ok: true,
      data: { currentFrameId: 3 },
    });

    fixture.ensureContentScript.mockClear();
    await expect(dispatchRuntime(
      fixture.controller,
      createInPageWidgetCommandEnvelope(fixture.init, {
        type: "ui-attach:widget-selection-set",
        enabled: true,
        intent: "explicit",
        expectedGeneration: 2,
      }),
      fixture.widgetSender,
    )).resolves.toEqual({
      ok: true,
      data: { enabled: true, generation: 3, resumeAllowed: true },
    });
    expect(fixture.ensureContentScript).toHaveBeenLastCalledWith(WIDGET_TAB_ID, 3);
  });

  test.each([
    ["missing", undefined, false],
    ["same terminal with another ancestor", [
      { origin: ORIGIN, pathname: "/host-a" },
      { origin: OTHER_ORIGIN, pathname: "/shared-child" },
    ], false],
    ["valid route with unavailable live inventory", [
      { origin: ORIGIN, pathname: "/settings" },
      { origin: OTHER_ORIGIN, pathname: "/shared-child" },
    ], true],
  ] as const)("fails closed for a nested %s scope in widget and Agent current scope", async (
    _name,
    routeChain,
    inventoryUnavailable,
  ) => {
    const rawStates: ActiveSessionCommandData[] = [];
    const publishedInputs: unknown[] = [];
    const publisher = createLocalAgentBridgeSessionPublisher({
      publishSessionContext: vi.fn(async (input) => {
        publishedInputs.push(structuredClone(input));
        return true;
      }),
      clearSessionContext: vi.fn(async () => undefined),
    });
    const fixture = await createInPageWidgetFixture({
      onActiveSessionChanged: async (data) => {
        rawStates.push(structuredClone(data));
        await publisher.reconcile(data);
      },
    });
    const childFrameId = 3;
    const childDocumentId = "route-chain-child-document";
    const oldRecord = createCaptureRecord(`widget-${_name}`, `Widget ${_name}`);
    oldRecord.origin = OTHER_ORIGIN;
    oldRecord.pageUrl = `${OTHER_ORIGIN}/shared-child`;
    oldRecord.attachment.source.url = oldRecord.pageUrl;
    oldRecord.tabId = WIDGET_TAB_ID;
    oldRecord.frameId = childFrameId;
    if (routeChain === undefined) {
      delete oldRecord.routeChain;
    } else {
      oldRecord.routeChain = routeChain.map((segment) => ({ ...segment }));
    }
    const emptyTopReadback: ActiveSessionReadback = {
      origin: ORIGIN,
      epoch: null,
      clearPending: false,
      activeClearOperationId: null,
      file: null,
      legacyRecord: null,
    };
    fixture.store.read = vi.fn(async (origin) => ({
      ok: true,
      value: origin === OTHER_ORIGIN
        ? createSessionReadback(oldRecord)
        : emptyTopReadback,
    }));
    const frames = [
      {
        frameId: 0,
        parentFrameId: -1,
        documentId: WIDGET_TOP_DOCUMENT_ID,
        url: `${ORIGIN}/settings`,
      },
      {
        frameId: childFrameId,
        parentFrameId: 0,
        documentId: childDocumentId,
        url: `${OTHER_ORIGIN}/shared-child`,
      },
    ];
    fixture.chrome.webNavigation.getAllFrames = vi.fn(async ({ tabId }) =>
      tabId === WIDGET_TAB_ID ? frames : []);
    const originalGetFrame = fixture.chrome.webNavigation.getFrame;
    fixture.chrome.webNavigation.getFrame = vi.fn(async (details) =>
      details.tabId === WIDGET_TAB_ID && details.frameId === childFrameId
        ? frames[1]
        : details.tabId === WIDGET_TAB_ID && details.frameId === 0
          ? frames[0]
          : originalGetFrame(details));
    rawStates.length = 0;
    publishedInputs.length = 0;

    const listed = await dispatchRuntime(
      fixture.controller,
      createInPageWidgetCommandEnvelope(fixture.init, {
        type: "ui-attach:widget-frame-scope-list",
      }),
      fixture.widgetSender,
    );
    expect(listed).toMatchObject(inventoryUnavailable
      ? {
          ok: true,
          data: {
            scopes: [
              expect.objectContaining({ frameId: 0 }),
              expect.objectContaining({ frameId: childFrameId }),
            ],
          },
        }
      : {
          ok: true,
          data: {
            scopes: [
              expect.objectContaining({ frameId: 0, itemCount: 0, itemIds: [] }),
              expect.objectContaining({ frameId: childFrameId, itemCount: 0, itemIds: [] }),
            ],
          },
        });

    vi.mocked(fixture.chrome.tabs.sendMessage).mockClear();
    await expect(dispatchRuntime(
      fixture.controller,
      createInPageWidgetCommandEnvelope(fixture.init, {
        type: "ui-attach:widget-frame-scope-select",
        frameId: childFrameId,
        documentId: childDocumentId,
        origin: OTHER_ORIGIN,
        pathname: "/shared-child",
        expectedGeneration: 0,
      }),
      fixture.widgetSender,
    )).resolves.toEqual({ ok: true, data: { enabled: false } });
    if (inventoryUnavailable) {
      fixture.chrome.webNavigation.getAllFrames = vi.fn(async () => undefined);
      await fixture.controller.handleNavigationCommitted({
        tabId: WIDGET_TAB_ID,
        frameId: 0,
        parentFrameId: -1,
        documentId: WIDGET_TOP_DOCUMENT_ID,
        url: `${ORIGIN}/settings`,
      }, false);
    }
    await expect(dispatchRuntime(
      fixture.controller,
      createInPageWidgetCommandEnvelope(fixture.init, {
        type: "ui-attach:widget-session-read",
      }),
      fixture.widgetSender,
    )).resolves.toMatchObject({
      ok: true,
      data: {
        activePage: { frameId: childFrameId, pathname: "/shared-child" },
        currentItemIds: [],
      },
    });
    expect(rawStates.filter((state) => state.activePage?.frameId === childFrameId).at(-1))
      .toMatchObject({ currentItemIds: [] });
    expect(publishedInputs.at(-1)).toMatchObject({ attachmentCount: 0, agentCopy: null });
    expect(JSON.stringify(publishedInputs.at(-1))).not.toContain(oldRecord.attachment.id);
    expect(vi.mocked(fixture.chrome.tabs.sendMessage).mock.calls
      .filter(([, message, target]) => isRecord(message) &&
        message.type === UI_ATTACH_OVERLAY_STATE && target?.frameId === childFrameId)
      .every(([, message]) => !JSON.stringify(message).includes(oldRecord.attachment.id)))
      .toBe(true);
    const registry = await fixture.chrome.storage.session.get(OVERLAY_PROJECTIONS_SESSION_KEY);
    expect(JSON.stringify(registry)).not.toContain(oldRecord.attachment.id);
  });

  test("revokes an acknowledged child projection when its live ancestor route changes before the navigation event", async () => {
    const rawStates: ActiveSessionCommandData[] = [];
    const publishedInputs: unknown[] = [];
    const publisher = createLocalAgentBridgeSessionPublisher({
      publishSessionContext: vi.fn(async (input) => {
        publishedInputs.push(structuredClone(input));
        return true;
      }),
      clearSessionContext: vi.fn(async () => undefined),
    });
    const fixture = await createInPageWidgetFixture({
      onActiveSessionChanged: async (data) => {
        rawStates.push(structuredClone(data));
        await publisher.reconcile(data);
      },
    });
    const childFrameId = 3;
    const childDocumentId = "stale-ancestor-child-document";
    const childRecord = createCaptureRecord("stale-ancestor", "Stale ancestor target");
    childRecord.origin = OTHER_ORIGIN;
    childRecord.pageUrl = `${OTHER_ORIGIN}/shared-child`;
    childRecord.attachment.source.url = childRecord.pageUrl;
    childRecord.attachment.locatorBundle.stability.verifiedValue =
      childRecord.attachment.locatorBundle.primary?.value ?? null;
    childRecord.tabId = WIDGET_TAB_ID;
    childRecord.frameId = childFrameId;
    childRecord.routeChain = [
      { origin: ORIGIN, pathname: "/settings" },
      { origin: OTHER_ORIGIN, pathname: "/shared-child" },
    ];
    const emptyTopReadback: ActiveSessionReadback = {
      origin: ORIGIN,
      epoch: null,
      clearPending: false,
      activeClearOperationId: null,
      file: null,
      legacyRecord: null,
    };
    fixture.store.read = vi.fn(async (origin) => ({
      ok: true,
      value: origin === OTHER_ORIGIN
        ? createSessionReadback(childRecord, OTHER_ORIGIN)
        : emptyTopReadback,
    }));
    let topPathname = "/settings";
    fixture.chrome.tabs.query = vi.fn(async ({ active }) => active
      ? [{ id: WIDGET_TAB_ID, url: `${ORIGIN}${topPathname}`, windowId: WIDGET_WINDOW_ID }]
      : []);
    const liveFrames = () => [{
      frameId: 0,
      parentFrameId: -1,
      documentId: WIDGET_TOP_DOCUMENT_ID,
      url: `${ORIGIN}${topPathname}`,
    }, {
      frameId: childFrameId,
      parentFrameId: 0,
      documentId: childDocumentId,
      url: `${OTHER_ORIGIN}/shared-child`,
    }];
    fixture.chrome.webNavigation.getAllFrames = vi.fn(async ({ tabId }) =>
      tabId === WIDGET_TAB_ID ? liveFrames() : []);
    const originalGetFrame = fixture.chrome.webNavigation.getFrame;
    fixture.chrome.webNavigation.getFrame = vi.fn(async (details) => {
      if (details.tabId !== WIDGET_TAB_ID) return originalGetFrame(details);
      return liveFrames().find((frame) => frame.frameId === details.frameId);
    });
    const childSender: UiAttachChromeMessageSender = {
      id: WIDGET_RUNTIME_ID,
      origin: OTHER_ORIGIN,
      url: `${OTHER_ORIGIN}/shared-child`,
      frameId: childFrameId,
      documentId: childDocumentId,
      tab: {
        id: WIDGET_TAB_ID,
        url: `${ORIGIN}${topPathname}`,
        windowId: WIDGET_WINDOW_ID,
      },
    };
    await expect(dispatchRuntime(
      fixture.controller,
      createInPageWidgetCommandEnvelope(fixture.init, {
        type: "ui-attach:widget-frame-scope-select",
        frameId: childFrameId,
        documentId: childDocumentId,
        origin: OTHER_ORIGIN,
        pathname: "/shared-child",
        expectedGeneration: 0,
      }),
      fixture.widgetSender,
    )).resolves.toEqual({ ok: true, data: { enabled: false } });
    const projection = await restoreAndAcknowledgeProjection(fixture.controller, childSender);
    const initialRegistry = await fixture.chrome.storage.session.get(
      OVERLAY_PROJECTIONS_SESSION_KEY,
    );
    expect(JSON.stringify(initialRegistry)).toContain(childRecord.attachment.id);
    rawStates.length = 0;
    publishedInputs.length = 0;
    vi.mocked(fixture.store.removeItem).mockClear();
    const ackPersistenceEntered = createDeferred<void>();
    const releaseAckPersistence = createDeferred<void>();
    const originalSessionSet = fixture.chrome.storage.session.set;
    let deferredAckPersistence = false;
    fixture.chrome.storage.session.set = vi.fn(async (values) => {
      await originalSessionSet(values);
      if (!deferredAckPersistence && Object.hasOwn(values, OVERLAY_PROJECTIONS_SESSION_KEY)) {
        deferredAckPersistence = true;
        ackPersistenceEntered.resolve(undefined);
        await releaseAckPersistence.promise;
      }
    });
    const ackAcrossAncestorChange = dispatchRuntime(fixture.controller, {
      type: UI_ATTACH_OVERLAY_PROJECTION_ACK,
      projection,
    }, childSender);
    await ackPersistenceEntered.promise;

    topPathname = "/host-b";
    if (childSender.tab) childSender.tab.url = `${ORIGIN}${topPathname}`;
    if (fixture.widgetSender.tab) fixture.widgetSender.tab.url = `${ORIGIN}${topPathname}`;
    releaseAckPersistence.resolve(undefined);
    const persistedAck = await ackAcrossAncestorChange;
    expect(persistedAck).toEqual({ ok: true, data: { accepted: false } });

    const [localAuthority, registryAfterAckWaiter] = await Promise.all([
      fixture.chrome.storage.local.get(OVERLAY_PROJECTION_AUTHORITY_GENERATION_KEY),
      fixture.chrome.storage.session.get(OVERLAY_PROJECTIONS_SESSION_KEY),
    ]);
    expect(registryAfterAckWaiter[OVERLAY_PROJECTIONS_SESSION_KEY]).toEqual(
      expect.objectContaining({
        generation: localAuthority[OVERLAY_PROJECTION_AUTHORITY_GENERATION_KEY],
        records: expect.arrayContaining([expect.objectContaining({
          projection: expect.objectContaining(projection),
          itemIds: [childRecord.attachment.id],
          delivery: "pending",
        })]),
      }),
    );

    const restartedController = createBackgroundController({
      chrome: fixture.chrome,
      store: fixture.store,
      ensureContentScript: fixture.ensureContentScript,
    });
    const restartedAck = await dispatchRuntime(restartedController, {
      type: UI_ATTACH_OVERLAY_PROJECTION_ACK,
      projection,
    }, childSender);
    const restartedAction = await dispatchRuntime(restartedController, {
      type: UI_ATTACH_OVERLAY_ACTION_REQUEST,
      action: "remove",
      itemId: childRecord.attachment.id,
      projection,
    }, childSender);
    expect(restartedAck).toEqual({ ok: true, data: { accepted: false } });
    expect(restartedAction).toMatchObject({ ok: false, code: "UNTRUSTED_SENDER" });
    expect(fixture.store.removeItem).not.toHaveBeenCalled();

    await fixture.controller.handleNavigationCommitted({
      tabId: WIDGET_TAB_ID,
      frameId: 0,
      parentFrameId: -1,
      documentId: WIDGET_TOP_DOCUMENT_ID,
      url: `${ORIGIN}${topPathname}`,
    }, false);
    const listed = await dispatchRuntime(
      fixture.controller,
      createInPageWidgetCommandEnvelope(fixture.init, {
        type: "ui-attach:widget-frame-scope-list",
      }),
      fixture.widgetSender,
    );
    const session = await dispatchRuntime(
      fixture.controller,
      createInPageWidgetCommandEnvelope(fixture.init, {
        type: "ui-attach:widget-session-read",
      }),
      fixture.widgetSender,
    );
    const registryAfterNavigation = await fixture.chrome.storage.session.get(
      OVERLAY_PROJECTIONS_SESSION_KEY,
    );

    expect(listed).toMatchObject({
      ok: true,
      data: {
        scopes: expect.arrayContaining([
          expect.objectContaining({ frameId: childFrameId, itemCount: 0, itemIds: [] }),
        ]),
      },
    });
    expect(session).toMatchObject({ ok: true, data: { currentItemIds: [] } });
    expect(rawStates).toEqual(expect.arrayContaining([
      expect.objectContaining({ currentItemIds: [] }),
    ]));
    expect(JSON.stringify(publishedInputs)).not.toContain(childRecord.attachment.id);
    expect(JSON.stringify(registryAfterNavigation)).not.toContain(childRecord.attachment.id);
  });

  test("EA-01B-CLEAR-C2 fences an in-flight widget enable before clear validation", async () => {
    const fixture = await createInPageWidgetFixture();
    let finishInjection!: (ready: boolean) => void;
    fixture.ensureContentScript.mockClear();
    fixture.ensureContentScript.mockImplementationOnce(() => new Promise<boolean>((resolve) => {
      finishInjection = resolve;
    }));

    const enabling = dispatchRuntime(
      fixture.controller,
      createInPageWidgetCommandEnvelope(fixture.init, {
        type: "ui-attach:widget-selection-set",
        enabled: true,
        intent: "explicit",
        expectedGeneration: 0,
      }),
      fixture.widgetSender,
    );
    await vi.waitFor(() => expect(fixture.ensureContentScript).toHaveBeenCalled());
    fixture.chrome.webNavigation.getAllFrames = vi.fn(async () => undefined);

    await expect(dispatchRuntime(
      fixture.controller,
      createInPageWidgetCommandEnvelope(fixture.init, {
        type: "ui-attach:widget-session-clear",
        expectedEpoch: "epoch-1",
        operationId: "widget-clear-stops-selection",
        scope: "live-page",
      }),
      fixture.widgetSender,
    )).resolves.toMatchObject({ ok: false, code: "ACTIVE_PAGE_UNAVAILABLE" });
    finishInjection(true);

    await expect(enabling).resolves.toMatchObject({
      ok: false,
      code: "WIDGET_STATE_UNAVAILABLE",
    });
    await expect(dispatchRuntime(
      fixture.controller,
      createInPageWidgetCommandEnvelope(fixture.init, {
        type: "ui-attach:widget-selection-read",
      }),
      fixture.widgetSender,
    )).resolves.toEqual({
      ok: true,
      data: { enabled: false, generation: 1, resumeAllowed: false },
    });
  });

  test("EA-01B-CLEAR-C2 rejects an old resume after clear and requires an explicit new start", async () => {
    const fixture = await createInPageWidgetFixture();

    await expect(dispatchRuntime(
      fixture.controller,
      createInPageWidgetCommandEnvelope(fixture.init, {
        type: "ui-attach:widget-selection-set",
        enabled: true,
        intent: "explicit",
        expectedGeneration: 0,
      }),
      fixture.widgetSender,
    )).resolves.toEqual({
      ok: true,
      data: { enabled: true, generation: 1, resumeAllowed: true },
    });

    const getAllFrames = fixture.chrome.webNavigation.getAllFrames;
    fixture.chrome.webNavigation.getAllFrames = vi.fn(async () => undefined);
    await expect(dispatchRuntime(
      fixture.controller,
      createInPageWidgetCommandEnvelope(fixture.init, {
        type: "ui-attach:widget-session-clear",
        expectedEpoch: "epoch-1",
        operationId: "widget-clear-blocks-old-resume",
        scope: "live-page",
      }),
      fixture.widgetSender,
    )).resolves.toMatchObject({ ok: false, code: "ACTIVE_PAGE_UNAVAILABLE" });
    fixture.chrome.webNavigation.getAllFrames = getAllFrames;

    await expect(dispatchRuntime(
      fixture.controller,
      createInPageWidgetCommandEnvelope(fixture.init, {
        type: "ui-attach:widget-selection-set",
        enabled: true,
        intent: "resume",
        expectedGeneration: 1,
      }),
      fixture.widgetSender,
    )).resolves.toEqual({
      ok: true,
      data: { enabled: false, generation: 2, resumeAllowed: false },
    });

    await expect(dispatchRuntime(
      fixture.controller,
      createInPageWidgetCommandEnvelope(fixture.init, {
        type: "ui-attach:widget-selection-set",
        enabled: true,
        intent: "explicit",
        expectedGeneration: 2,
      }),
      fixture.widgetSender,
    )).resolves.toEqual({
      ok: true,
      data: { enabled: true, generation: 3, resumeAllowed: true },
    });
  });

  test("EA-01B-CLEAR-C2 cancels a frame-scope mutation queued before clear", async () => {
    const fixture = await createInPageWidgetFixture();
    const contentDeliveryStarted = createDeferred<void>();
    const contentDelivery = createDeferred<boolean>();
    fixture.ensureContentScript.mockImplementationOnce(async () => {
      contentDeliveryStarted.resolve(undefined);
      return contentDelivery.promise;
    });

    const enabling = dispatchRuntime(
      fixture.controller,
      createInPageWidgetCommandEnvelope(fixture.init, {
        type: "ui-attach:widget-selection-set",
        enabled: true,
        intent: "explicit",
        expectedGeneration: 0,
      }),
      fixture.widgetSender,
    );
    await contentDeliveryStarted.promise;

    const scopeSelection = dispatchRuntime(
      fixture.controller,
      createInPageWidgetCommandEnvelope(fixture.init, {
        type: "ui-attach:widget-frame-scope-select",
        frameId: 0,
        documentId: WIDGET_TOP_DOCUMENT_ID,
        origin: ORIGIN,
        pathname: "/settings",
        expectedGeneration: 0,
      }),
      fixture.widgetSender,
    );
    const liveFrames = [{
      frameId: 0,
      parentFrameId: -1,
      documentId: WIDGET_TOP_DOCUMENT_ID,
      url: `${ORIGIN}/settings`,
    }];
    fixture.chrome.webNavigation.getAllFrames = vi.fn()
      .mockResolvedValueOnce(undefined)
      .mockResolvedValue(liveFrames);

    await expect(dispatchRuntime(
      fixture.controller,
      createInPageWidgetCommandEnvelope(fixture.init, {
        type: "ui-attach:widget-session-clear",
        expectedEpoch: "epoch-1",
        operationId: "widget-clear-cancels-queued-scope",
        scope: "live-page",
      }),
      fixture.widgetSender,
    )).resolves.toMatchObject({ ok: false, code: "ACTIVE_PAGE_UNAVAILABLE" });
    contentDelivery.resolve(true);

    await expect(enabling).resolves.toMatchObject({
      ok: false,
      code: "WIDGET_STATE_UNAVAILABLE",
    });
    await expect(scopeSelection).resolves.toMatchObject({
      ok: false,
      code: "WIDGET_STATE_UNAVAILABLE",
    });
    await expect(dispatchRuntime(
      fixture.controller,
      createInPageWidgetCommandEnvelope(fixture.init, {
        type: "ui-attach:widget-selection-read",
      }),
      fixture.widgetSender,
    )).resolves.toEqual({
      ok: true,
      data: { enabled: false, generation: 1, resumeAllowed: false },
    });
  });

  test("serializes a pending action after asynchronous frame enumeration", async () => {
    const fixture = await createInPageWidgetFixture();
    const enumerationStarted = createDeferred<void>();
    const enumeration = createDeferred<Array<{
      frameId: number;
      parentFrameId: number;
      documentId: string;
      url: string;
    }>>();
    fixture.chrome.webNavigation.getAllFrames = vi.fn(async () => {
      enumerationStarted.resolve(undefined);
      return enumeration.promise;
    });

    const selection = dispatchRuntime(
      fixture.controller,
      createInPageWidgetCommandEnvelope(fixture.init, {
        type: "ui-attach:widget-frame-scope-select",
        frameId: 0,
        documentId: WIDGET_TOP_DOCUMENT_ID,
        origin: ORIGIN,
        pathname: "/settings",
        expectedGeneration: 0,
      }),
      fixture.widgetSender,
    );
    await enumerationStarted.promise;
    let actionSettled = false;
    const action = dispatchRuntime(fixture.controller, {
      type: UI_ATTACH_OVERLAY_ACTION_REQUEST,
      action: "more",
      itemId: fixture.itemId,
      projection: WIDGET_OVERLAY_PROJECTION,
    }, createInPageWidgetContentSender()).finally(() => { actionSettled = true; });
    await flushAsyncWork();
    expect(actionSettled).toBe(false);
    enumeration.resolve([{
      frameId: 0,
      parentFrameId: -1,
      documentId: WIDGET_TOP_DOCUMENT_ID,
      url: `${ORIGIN}/settings`,
    }]);

    await expect(selection).resolves.toEqual({ ok: true, data: { enabled: false } });
    await expect(action).resolves.toEqual({ ok: true, data: null });
  });

  test("publishes a session update after a page marker removes an item", async () => {
    const fixture = await createInPageWidgetFixture();
    const previousResult = await fixture.store.read(ORIGIN);
    if (!previousResult.ok) throw new Error("expected a readable widget session");
    const previous = previousResult.value;
    const remaining: ActiveSessionReadback = {
      ...previous,
      file: previous.file && {
        ...previous.file,
        session: {
          ...previous.file.session,
          attachments: previous.file.session.attachments.filter(
            (item) => item.id !== fixture.itemId,
          ),
        },
      },
      legacyRecord: null,
    };
    fixture.store.read = vi.fn()
      .mockResolvedValueOnce({ ok: true, value: previous })
      .mockResolvedValue({ ok: true, value: remaining });
    fixture.store.removeItem = vi.fn(async () => ({ ok: true, value: remaining }));
    fixture.chrome.runtime.sentMessages.length = 0;

    await expect(dispatchRuntime(fixture.controller, {
      type: UI_ATTACH_OVERLAY_ACTION_REQUEST,
      action: "remove",
      itemId: fixture.itemId,
      projection: WIDGET_OVERLAY_PROJECTION,
    }, createInPageWidgetContentSender())).resolves.toEqual({ ok: true, data: null });

    expect(fixture.chrome.runtime.sentMessages).toContainEqual({
      type: UI_ATTACH_SESSION_UPDATED,
      origin: ORIGIN,
      itemId: fixture.itemId,
    });
  });

  test.each(["save", "remove"] as const)(
    "keeps overlay %s authorized when a duplicate capture has a distinct session item id",
    async (action) => {
      const fixture = await createInPageWidgetFixture();
      const initialResult = await fixture.store.read(ORIGIN);
      expect(initialResult.ok).toBe(true);
      if (!initialResult.ok || !initialResult.value.file) return;

      const originalItem = initialResult.value.file.session.attachments[0];
      if (!originalItem) throw new Error("expected a source overlay item");
      const duplicateItem = {
        ...structuredClone(originalItem),
        id: `${originalItem.id}-2`,
        labels: ["B"],
      };
      const duplicateReadback: ActiveSessionReadback = {
        ...structuredClone(initialResult.value),
        file: {
          ...structuredClone(initialResult.value.file),
          session: {
            ...structuredClone(initialResult.value.file.session),
            attachments: [structuredClone(originalItem), duplicateItem],
          },
        },
        legacyRecord: duplicateItem.sourceRecord as OriginCaptureRecord,
      };
      const remainingReadback: ActiveSessionReadback = {
        ...structuredClone(duplicateReadback),
        file: {
          ...structuredClone(duplicateReadback.file!),
          session: {
            ...structuredClone(duplicateReadback.file!.session),
            attachments: [structuredClone(originalItem)],
          },
        },
        legacyRecord: originalItem.sourceRecord as OriginCaptureRecord,
      };
      let currentReadback = duplicateReadback;
      fixture.store.read = vi.fn(async () => ({
        ok: true as const,
        value: structuredClone(currentReadback),
      }));

      const projection = await restoreAndAcknowledgeProjection(
        fixture.controller,
        createInPageWidgetContentSender(),
      );
      const taskNote = "Update duplicate Save changes";
      const replacementRecord = structuredClone(
        duplicateItem.sourceRecord,
      ) as OriginCaptureRecord;
      replacementRecord.attachment.id = "att_replacement";
      const refreshAuthority = async (
        authority: SessionMutationAuthority | undefined,
      ): Promise<boolean> => {
        if (!authority) return false;
        return await authority.refresh(duplicateItem.sourceRecord as OriginCaptureRecord);
      };

      if (action === "save") {
        fixture.store.updateIntent = vi.fn(async (_origin, _epoch, itemId, intent, authority) => {
          expect(itemId).toBe(duplicateItem.id);
          expect(await authority?.refresh(replacementRecord)).toBe(false);
          if (!await refreshAuthority(authority)) {
            return { ok: false as const, code: "STALE_SESSION" as const, error: "stale" };
          }
          const updated = structuredClone(duplicateReadback);
          const updatedItem = updated.file!.session.attachments.find((item) => item.id === itemId);
          if (!updatedItem) throw new Error("expected duplicate item in update readback");
          updatedItem.sourceRecord.intent = intent;
          currentReadback = updated;
          return { ok: true as const, value: updated };
        });
      } else {
        fixture.store.removeItem = vi.fn(async (_origin, _epoch, itemId, authority) => {
          expect(itemId).toBe(duplicateItem.id);
          expect(await authority?.refresh(replacementRecord)).toBe(false);
          if (!await refreshAuthority(authority)) {
            return { ok: false as const, code: "STALE_SESSION" as const, error: "stale" };
          }
          currentReadback = remainingReadback;
          return { ok: true as const, value: remainingReadback };
        });
      }

      await expect(dispatchRuntime(fixture.controller, {
        type: UI_ATTACH_OVERLAY_ACTION_REQUEST,
        action,
        itemId: duplicateItem.id,
        projection,
        ...(action === "save" ? { taskNote } : {}),
      }, createInPageWidgetContentSender())).resolves.toEqual({ ok: true, data: null });

      if (action === "save") {
        expect(currentReadback.file?.session.attachments.find((item) => item.id === duplicateItem.id)
          ?.sourceRecord.intent).toBe(taskNote);
      } else {
        expect(currentReadback.file?.session.attachments.some((item) => item.id === duplicateItem.id))
          .toBe(false);
      }
    },
  );

  test.each(["save", "remove", "lifecycle"] as const)(
    "keeps widget %s authorized when a duplicate capture has a distinct session item id",
    async (action) => {
      const fixture = await createInPageWidgetFixture();
      const initialResult = await fixture.store.read(ORIGIN);
      expect(initialResult.ok).toBe(true);
      if (!initialResult.ok || !initialResult.value.file) return;
      const initialFile = initialResult.value.file;
      const originalItem = initialFile.session.attachments[0];
      if (!originalItem) throw new Error("expected a source widget item");
      const originalV3Item = {
        ...structuredClone(originalItem),
        updatedAt: originalItem.createdAt,
        annotationId: "annotation-original",
        annotationLifecycle: { state: "open" as const, resolvedAt: null },
      };
      const duplicateItem = {
        ...structuredClone(originalV3Item),
        id: `${originalItem.id}-2`,
        labels: ["B"],
        sourceRecord: structuredClone(originalItem.sourceRecord),
        annotationId: "annotation-duplicate",
      };
      const duplicateReadback: ActiveSessionReadback = {
        ...structuredClone(initialResult.value),
        file: {
          ...structuredClone(initialFile),
          schemaVersion: "0.3.0",
          session: {
            ...structuredClone(initialFile.session),
            attachments: [originalV3Item, duplicateItem],
          },
        },
        legacyRecord: duplicateItem.sourceRecord as OriginCaptureRecord,
      };
      const remainingReadback: ActiveSessionReadback = {
        ...structuredClone(duplicateReadback),
        file: {
          ...structuredClone(duplicateReadback.file!),
          session: {
            ...structuredClone(duplicateReadback.file!.session),
            attachments: [structuredClone(originalV3Item)],
          },
        },
        legacyRecord: originalV3Item.sourceRecord as OriginCaptureRecord,
      };
      let currentReadback = duplicateReadback;
      fixture.store.read = vi.fn(async () => ({
        ok: true as const,
        value: structuredClone(currentReadback),
      }));
      const replacementRecord = structuredClone(
        duplicateItem.sourceRecord,
      ) as OriginCaptureRecord;
      replacementRecord.attachment.id = "att_replacement";
      const refreshAuthority = async (
        authority: SessionMutationAuthority | undefined,
      ): Promise<boolean> => {
        if (!authority) return false;
        expect(await authority.refresh(replacementRecord)).toBe(false);
        return await authority.refresh(duplicateItem.sourceRecord as OriginCaptureRecord);
      };

      if (action === "save") {
        fixture.store.updateIntent = vi.fn(async (_origin, _epoch, itemId, intent, authority) => {
          expect(itemId).toBe(duplicateItem.id);
          if (!await refreshAuthority(authority)) {
            return { ok: false as const, code: "STALE_SESSION" as const, error: "stale" };
          }
          const updated = structuredClone(duplicateReadback);
          const updatedItem = updated.file!.session.attachments.find((item) => item.id === itemId);
          if (!updatedItem) throw new Error("expected duplicate item in widget update readback");
          updatedItem.sourceRecord.intent = intent;
          currentReadback = updated;
          return { ok: true as const, value: updated };
        });
      } else if (action === "remove") {
        fixture.store.removeItem = vi.fn(async (_origin, _epoch, itemId, authority) => {
          expect(itemId).toBe(duplicateItem.id);
          if (!await refreshAuthority(authority)) {
            return { ok: false as const, code: "STALE_SESSION" as const, error: "stale" };
          }
          currentReadback = remainingReadback;
          return { ok: true as const, value: remainingReadback };
        });
      } else {
        fixture.store.updateAnnotationLifecycle = vi.fn(async (
          _origin,
          _epoch,
          itemId,
          _annotationId,
          _expectedState,
          nextState,
          authority,
        ) => {
          expect(itemId).toBe(duplicateItem.id);
          if (!await refreshAuthority(authority)) {
            return { ok: false as const, code: "STALE_SESSION" as const, error: "stale" };
          }
          const updated = structuredClone(duplicateReadback);
          const updatedItem = updated.file!.session.attachments.find((item) => item.id === itemId);
          if (!updatedItem) throw new Error("expected duplicate item in widget lifecycle readback");
          updatedItem.annotationLifecycle = nextState === "resolved"
            ? { state: "resolved", resolvedAt: "2026-09-05T00:00:01.000Z" }
            : { state: "open", resolvedAt: null };
          currentReadback = updated;
          return { ok: true as const, value: updated };
        });
      }

      const command = action === "save"
        ? {
            type: "ui-attach:widget-task-note-save" as const,
            expectedEpoch: "epoch-1",
            itemId: duplicateItem.id,
            taskNote: "Update duplicate Save changes",
          }
        : action === "remove"
          ? {
              type: "ui-attach:widget-item-remove" as const,
              expectedEpoch: "epoch-1",
              itemId: duplicateItem.id,
            }
          : {
              type: "ui-attach:widget-annotation-lifecycle-set" as const,
              expectedEpoch: "epoch-1",
              itemId: duplicateItem.id,
              annotationId: duplicateItem.annotationId,
              expectedState: "open" as const,
              nextState: "resolved" as const,
            };

      await expect(dispatchRuntime(
        fixture.controller,
        createInPageWidgetCommandEnvelope(fixture.init, command),
        fixture.widgetSender,
      )).resolves.toMatchObject({ ok: true });
    },
  );

  test("serializes an overlay action arriving during the second frame-scope enumeration", async () => {
    const fixture = await createInPageWidgetFixture();
    const lifecycle = await connectInPageWidgetLifecycle(fixture);
    const childFrameId = 3;
    const childDocumentId = "serialized-child-document";
    const secondEnumerationStarted = createDeferred<void>();
    const secondEnumeration = createDeferred<Array<{
      frameId: number;
      parentFrameId: number;
      documentId: string;
      url: string;
    }>>();
    const frames = [{
      frameId: 0,
      parentFrameId: -1,
      documentId: WIDGET_TOP_DOCUMENT_ID,
      url: `${ORIGIN}/settings`,
    }, {
      frameId: childFrameId,
      parentFrameId: 0,
      documentId: childDocumentId,
      url: `${OTHER_ORIGIN}/editor`,
    }];
    let enumerationCount = 0;
    fixture.chrome.webNavigation.getAllFrames = vi.fn(async () => {
      enumerationCount += 1;
      if (enumerationCount === 2) {
        secondEnumerationStarted.resolve(undefined);
        return secondEnumeration.promise;
      }
      return frames;
    });

    const selection = dispatchRuntime(
      fixture.controller,
      createInPageWidgetCommandEnvelope(fixture.init, {
        type: "ui-attach:widget-frame-scope-select",
        frameId: childFrameId,
        documentId: childDocumentId,
        origin: OTHER_ORIGIN,
        pathname: "/editor",
        expectedGeneration: 0,
      }),
      fixture.widgetSender,
    );
    await secondEnumerationStarted.promise;
    let actionSettled = false;
    const action = dispatchRuntime(fixture.controller, {
      type: UI_ATTACH_OVERLAY_ACTION_REQUEST,
      action: "more",
      itemId: fixture.itemId,
      projection: WIDGET_OVERLAY_PROJECTION,
    }, createInPageWidgetContentSender()).finally(() => { actionSettled = true; });
    await flushAsyncWork();
    expect(actionSettled).toBe(false);

    secondEnumeration.resolve(frames);
    await expect(selection).resolves.toEqual({ ok: true, data: { enabled: false } });
    await expect(action).resolves.toEqual({ ok: true, data: null });
    await waitForPostedWidgetActionCount(lifecycle.port, 1);
    await expect(dispatchRuntime(
      fixture.controller,
      createInPageWidgetCommandEnvelope(fixture.init, {
        type: "ui-attach:widget-session-read",
      }),
      fixture.widgetSender,
    )).resolves.toMatchObject({
      ok: true,
      data: { origin: ORIGIN, activePage: { frameId: 0 } },
    });
    const posted = readPostedWidgetActions(lifecycle.port)[0];
    const messageListener = vi.mocked(lifecycle.messageEvent.addListener).mock.calls[0]?.[0];
    if (posted && messageListener) {
      messageListener({
        type: UI_ATTACH_IN_PAGE_WIDGET_ACTION_ACK,
        surfaceId: fixture.init.surfaceId,
        actionId: posted.actionId,
        outcome: "consumed",
      });
    }
  });

  test("serializes an overlay action arriving during widget selection delivery", async () => {
    const fixture = await createInPageWidgetFixture();
    const lifecycle = await connectInPageWidgetLifecycle(fixture);
    const contentDeliveryStarted = createDeferred<void>();
    const contentDelivery = createDeferred<boolean>();
    fixture.ensureContentScript.mockImplementationOnce(async () => {
      contentDeliveryStarted.resolve(undefined);
      return contentDelivery.promise;
    });

    const selection = dispatchRuntime(
      fixture.controller,
      createInPageWidgetCommandEnvelope(fixture.init, {
        type: "ui-attach:widget-selection-set",
        enabled: true,
        intent: "explicit",
        expectedGeneration: 0,
      }),
      fixture.widgetSender,
    );
    await contentDeliveryStarted.promise;
    let actionSettled = false;
    const action = dispatchRuntime(fixture.controller, {
      type: UI_ATTACH_OVERLAY_ACTION_REQUEST,
      action: "more",
      itemId: fixture.itemId,
      projection: WIDGET_OVERLAY_PROJECTION,
    }, createInPageWidgetContentSender()).finally(() => { actionSettled = true; });
    await flushAsyncWork();
    expect(actionSettled).toBe(false);

    contentDelivery.resolve(true);
    await expect(selection).resolves.toEqual({
      ok: true,
      data: { enabled: true, generation: 1, resumeAllowed: true },
    });
    await expect(action).resolves.toEqual({ ok: true, data: null });
    await waitForPostedWidgetActionCount(lifecycle.port, 1);
    const posted = readPostedWidgetActions(lifecycle.port)[0];
    const messageListener = vi.mocked(lifecycle.messageEvent.addListener).mock.calls[0]?.[0];
    if (posted && messageListener) {
      messageListener({
        type: UI_ATTACH_IN_PAGE_WIDGET_ACTION_ACK,
        surfaceId: fixture.init.surfaceId,
        actionId: posted.actionId,
        outcome: "consumed",
      });
    }
  });

  test("cancels a running widget selection mutation when its surface is released", async () => {
    const fixture = await createInPageWidgetFixture();
    const contentDeliveryStarted = createDeferred<void>();
    const contentDelivery = createDeferred<boolean>();
    fixture.ensureContentScript.mockImplementationOnce(async () => {
      contentDeliveryStarted.resolve(undefined);
      return contentDelivery.promise;
    });
    vi.mocked(fixture.chrome.tabs.sendMessage).mockClear();

    const selection = dispatchRuntime(
      fixture.controller,
      createInPageWidgetCommandEnvelope(fixture.init, {
        type: "ui-attach:widget-selection-set",
        enabled: true,
        intent: "explicit",
        expectedGeneration: 0,
      }),
      fixture.widgetSender,
    );
    await contentDeliveryStarted.promise;
    await expect(dispatchRuntime(
      fixture.controller,
      createInPageWidgetCommandEnvelope(fixture.init, {
        type: "ui-attach:widget-surface-release",
      }),
      fixture.widgetSender,
    )).resolves.toEqual({ ok: true, data: null });
    contentDelivery.resolve(true);

    await expect(selection).resolves.toMatchObject({
      ok: false,
      code: "WIDGET_STATE_UNAVAILABLE",
    });
    expect(vi.mocked(fixture.chrome.tabs.sendMessage).mock.calls.some(([, message]) => (
      isRecord(message) && message.type === UI_ATTACH_CONTENT_SETTINGS_UPDATED &&
      message.elementSelectionEnabled === true
    ))).toBe(false);
    await expect(dispatchRuntime(
      fixture.controller,
      createInPageWidgetRegistration(fixture.init),
      fixture.widgetSender,
    )).resolves.toMatchObject({ ok: false, code: "UNTRUSTED_SENDER" });
  });

  test("R4-HANDOFF-01 rejects an old overlay action when show replaces its released lease", async () => {
    const fixture = await createInPageWidgetFixture();
    const oldInit = fixture.init;
    const showEnsureStarted = createDeferred<void>();
    const showEnsure = createDeferred<{ ok: true; data: null }>();
    const originalSendMessage = fixture.chrome.tabs.sendMessage;
    let deferNextEnsure = true;
    fixture.chrome.tabs.sendMessage = vi.fn(async (tabId, message, options) => {
      if (deferNextEnsure && isRecord(message) && message.type === UI_ATTACH_IN_PAGE_WIDGET_ENSURE) {
        deferNextEnsure = false;
        showEnsureStarted.resolve(undefined);
        return showEnsure.promise;
      }
      return await originalSendMessage(tabId, message, options);
    });

    const action = dispatchRuntime(fixture.controller, {
      type: UI_ATTACH_OVERLAY_ACTION_REQUEST,
      action: "more",
      itemId: fixture.itemId,
      projection: WIDGET_OVERLAY_PROJECTION,
    }, createInPageWidgetContentSender());
    await showEnsureStarted.promise;

    await expect(dispatchRuntime(
      fixture.controller,
      createInPageWidgetCommandEnvelope(oldInit, {
        type: "ui-attach:widget-surface-release",
      }),
      fixture.widgetSender,
    )).resolves.toEqual({ ok: true, data: null });
    await expect(fixture.controller.showInPageWidget(WIDGET_TAB_ID)).resolves.toBe(true);
    const replacementInit = vi.mocked(fixture.chrome.tabs.sendMessage).mock.calls
      .map((call) => parseInPageWidgetInitMessage(call[1]))
      .find((message): message is InPageWidgetInitMessage => (
        message !== null && message.surfaceId !== oldInit.surfaceId
      ));
    if (!replacementInit) throw new Error("replacement in-page widget init was not sent");
    fixture.init = replacementInit;
    const replacementLifecycle = await connectInPageWidgetLifecycle(fixture);

    showEnsure.resolve({ ok: true, data: null });
    const actionResponse = await action;
    await flushAsyncWork();

    expect(actionResponse).toMatchObject({ ok: false, code: "UNTRUSTED_SENDER" });
    expect(readPostedWidgetActions(replacementLifecycle.port)).toEqual([]);
    await expect(dispatchRuntime(
      fixture.controller,
      createInPageWidgetCommandEnvelope(replacementInit, {
        type: "ui-attach:widget-session-read",
      }),
      fixture.widgetSender,
    )).resolves.toMatchObject({
      ok: true,
      data: { origin: ORIGIN, activePage: { frameId: 0 } },
    });
    const persisted = await fixture.chrome.storage.session.get(IN_PAGE_WIDGET_LEASE_STORAGE_KEY);
    expect(persisted[IN_PAGE_WIDGET_LEASE_STORAGE_KEY]).toMatchObject({
      leases: [{
        surfaceId: replacementInit.surfaceId,
        actionContext: null,
        frameContext: null,
      }],
    });
  });

  test("R4-SHOW-01 singleflights concurrent widget creation and permits a clean retry", async () => {
    const fixture = await createInPageWidgetFixture();
    await expect(dispatchRuntime(
      fixture.controller,
      createInPageWidgetCommandEnvelope(fixture.init, {
        type: "ui-attach:widget-surface-release",
      }),
      fixture.widgetSender,
    )).resolves.toEqual({ ok: true, data: null });
    const concurrentEnsure = createDeferred<{ ok: true; data: null }>();
    const ensureStarted = createDeferred<void>();
    const originalSendMessage = fixture.chrome.tabs.sendMessage;
    fixture.chrome.tabs.sendMessage = vi.fn(async (tabId, message, options) => {
      if (isRecord(message) && message.type === UI_ATTACH_IN_PAGE_WIDGET_ENSURE) {
        ensureStarted.resolve(undefined);
        return concurrentEnsure.promise;
      }
      return await originalSendMessage(tabId, message, options);
    });

    const first = fixture.controller.showInPageWidget(WIDGET_TAB_ID);
    const second = fixture.controller.showInPageWidget(WIDGET_TAB_ID);
    await ensureStarted.promise;
    concurrentEnsure.resolve({ ok: true, data: null });

    await expect(Promise.all([first, second])).resolves.toEqual([true, true]);
    const concurrentInits = vi.mocked(fixture.chrome.tabs.sendMessage).mock.calls
      .map((call) => parseInPageWidgetInitMessage(call[1]))
      .filter((message): message is InPageWidgetInitMessage => message !== null);
    expect(concurrentInits).toHaveLength(1);
    const persisted = await fixture.chrome.storage.session.get(IN_PAGE_WIDGET_LEASE_STORAGE_KEY);
    expect(persisted[IN_PAGE_WIDGET_LEASE_STORAGE_KEY]).toMatchObject({
      leases: [{ surfaceId: concurrentInits[0]?.surfaceId }],
    });

    const concurrentInit = concurrentInits[0];
    if (!concurrentInit) throw new Error("singleflight widget init was not sent");
    fixture.init = concurrentInit;
    await expect(dispatchRuntime(
      fixture.controller,
      createInPageWidgetCommandEnvelope(concurrentInit, {
        type: "ui-attach:widget-surface-release",
      }),
      fixture.widgetSender,
    )).resolves.toEqual({ ok: true, data: null });
    let retryAttempt = 0;
    fixture.chrome.tabs.sendMessage = vi.fn(async (tabId, message, options) => {
      if (isRecord(message) && message.type === UI_ATTACH_IN_PAGE_WIDGET_ENSURE) {
        retryAttempt += 1;
        if (retryAttempt === 1) throw new Error("injected ensure failure");
      }
      return await originalSendMessage(tabId, message, options);
    });

    await expect(fixture.controller.showInPageWidget(WIDGET_TAB_ID)).resolves.toBe(false);
    await expect(fixture.controller.showInPageWidget(WIDGET_TAB_ID)).resolves.toBe(true);
    expect(retryAttempt).toBe(2);
  });

  test("recovers a transiently missing top document id after synchronizing content readiness", async () => {
    const fixture = await createInPageWidgetFixture();
    await expect(dispatchRuntime(
      fixture.controller,
      createInPageWidgetCommandEnvelope(fixture.init, {
        type: "ui-attach:widget-surface-release",
      }),
      fixture.widgetSender,
    )).resolves.toEqual({ ok: true, data: null });
    const originalGetFrame = fixture.chrome.webNavigation.getFrame;
    let topFrameReads = 0;
    fixture.chrome.webNavigation.getFrame = vi.fn(async (details) => {
      if (details.tabId === WIDGET_TAB_ID && details.frameId === 0) {
        topFrameReads += 1;
        if (topFrameReads === 1) return undefined;
      }
      return await originalGetFrame(details);
    });
    fixture.ensureContentScript.mockClear();
    vi.mocked(fixture.chrome.tabs.sendMessage).mockClear();

    await expect(fixture.controller.showInPageWidget(WIDGET_TAB_ID)).resolves.toBe(true);

    expect(topFrameReads).toBe(2);
    expect(fixture.ensureContentScript.mock.calls).toEqual([
      [WIDGET_TAB_ID, 0],
      [WIDGET_TAB_ID, 0, WIDGET_TOP_DOCUMENT_ID],
    ]);
    const initCalls = vi.mocked(fixture.chrome.tabs.sendMessage).mock.calls
      .filter((call) => parseInPageWidgetInitMessage(call[1]) !== null);
    expect(initCalls).toHaveLength(1);
    expect(initCalls[0]?.[2]).toEqual({
      frameId: 0,
      documentId: WIDGET_TOP_DOCUMENT_ID,
    });
  });

  test.each(["release", "navigation", "disconnect-expiry"] as const)(
    "EA-01A-R5-TERMINAL-CANCEL fences a detached show after %s cleanup",
    async (cleanup) => {
      const fixture = await createInPageWidgetFixture();
      const initialInit = fixture.init;
      let disconnectListener: (() => void) | undefined;
      let disconnectExpiry: (() => void) | null = null;
      let setTimeoutSpy: ReturnType<typeof vi.spyOn> | null = null;
      if (cleanup === "disconnect-expiry") {
        const lifecycle = await connectInPageWidgetLifecycle(fixture);
        disconnectListener = vi.mocked(lifecycle.disconnectEvent.addListener).mock.calls[0]?.[0] as
          | (() => void)
          | undefined;
        const originalSetTimeout = globalThis.setTimeout;
        setTimeoutSpy = vi.spyOn(globalThis, "setTimeout").mockImplementation(
          (handler, delay, ...args) => {
            if (delay === 6_000 && typeof handler === "function") {
              disconnectExpiry = () => handler(...args);
              return 60_101 as ReturnType<typeof setTimeout>;
            }
            return originalSetTimeout(handler, delay, ...args);
          },
        );
      }

      const staleContentReady = createDeferred<boolean>();
      const staleContentStarted = createDeferred<void>();
      fixture.ensureContentScript.mockImplementationOnce(async () => {
        staleContentStarted.resolve(undefined);
        return staleContentReady.promise;
      });
      vi.mocked(fixture.chrome.tabs.sendMessage).mockClear();

      const staleShow = fixture.controller.showInPageWidget(WIDGET_TAB_ID);
      await staleContentStarted.promise;
      try {
        if (cleanup === "release") {
          await expect(dispatchRuntime(
            fixture.controller,
            createInPageWidgetCommandEnvelope(initialInit, {
              type: "ui-attach:widget-surface-release",
            }),
            fixture.widgetSender,
          )).resolves.toEqual({ ok: true, data: null });
        } else if (cleanup === "navigation") {
          await expect(fixture.controller.handleNavigationCommitted({
            tabId: WIDGET_TAB_ID,
            frameId: 0,
            parentFrameId: -1,
            documentId: "replacement-top-document",
            url: `${ORIGIN}/full-navigation`,
          })).resolves.toBeUndefined();
        } else {
          disconnectListener?.();
          expect(disconnectExpiry).toEqual(expect.any(Function));
          disconnectExpiry?.();
          await flushAsyncWork();
        }
      } finally {
        setTimeoutSpy?.mockRestore();
      }

      await expect(fixture.controller.showInPageWidget(WIDGET_TAB_ID)).resolves.toBe(true);
      const replacementInits = vi.mocked(fixture.chrome.tabs.sendMessage).mock.calls
        .map((call) => parseInPageWidgetInitMessage(call[1]))
        .filter((message): message is InPageWidgetInitMessage => message !== null);
      expect(replacementInits).toHaveLength(1);
      const replacementInit = replacementInits[0];
      if (!replacementInit) throw new Error("replacement in-page widget init was not sent");

      staleContentReady.resolve(true);
      await expect(staleShow).resolves.toBe(false);
      const allInits = vi.mocked(fixture.chrome.tabs.sendMessage).mock.calls
        .map((call) => parseInPageWidgetInitMessage(call[1]))
        .filter((message): message is InPageWidgetInitMessage => message !== null);
      expect(allInits).toEqual([replacementInit]);
      const persisted = await fixture.chrome.storage.session.get(IN_PAGE_WIDGET_LEASE_STORAGE_KEY);
      expect(persisted[IN_PAGE_WIDGET_LEASE_STORAGE_KEY]).toMatchObject({
        leases: [{ surfaceId: replacementInit.surfaceId }],
      });
    },
  );

  test.each(["rejected", "malformed"] as const)(
    "EA-01A-R5-LEASE-POISON fail-closes a %s local invalidation read now and after restart",
    async (failureMode) => {
      const fixture = await createInPageWidgetFixture();
      await flushAsyncWork();
      const originalLocalGet = fixture.chrome.storage.local.get;
      const invalidationRead = createDeferred<Record<string, unknown>>();
      let invalidationReadCount = 0;
      fixture.chrome.storage.local.get = vi.fn((keys) => {
        if (keys !== IN_PAGE_WIDGET_LEASE_INVALIDATIONS_LOCAL_KEY) {
          return originalLocalGet(keys);
        }
        invalidationReadCount += 1;
        if (invalidationReadCount > 1) throw new Error("unexpected widget invalidation read");
        return invalidationRead.promise;
      });
      const settleInvalidationRead = (read: ReturnType<
        typeof createDeferred<Record<string, unknown>>
      >) => {
        if (failureMode === "rejected") {
          read.reject(new Error("injected widget invalidation read failure"));
        } else {
          read.resolve({
            [IN_PAGE_WIDGET_LEASE_INVALIDATIONS_LOCAL_KEY]: [{
              surfaceId: fixture.init.surfaceId,
              tabId: "malformed",
            }],
          });
        }
      };

      const controller = createBackgroundController({
        chrome: fixture.chrome,
        store: fixture.store,
        ensureContentScript: fixture.ensureContentScript,
      });
      const registration = dispatchRuntime(
        controller,
        createInPageWidgetRegistration(fixture.init),
        fixture.widgetSender,
      );
      await waitFor(() => invalidationReadCount === 1);
      settleInvalidationRead(invalidationRead);
      await expect(registration).resolves.toMatchObject({
        ok: false,
        code: "UNTRUSTED_SENDER",
      });
      const restarted = createBackgroundController({
        chrome: fixture.chrome,
        store: fixture.store,
        ensureContentScript: fixture.ensureContentScript,
      });
      await expect(dispatchRuntime(
        restarted,
        createInPageWidgetRegistration(fixture.init),
        fixture.widgetSender,
      )).resolves.toMatchObject({ ok: false, code: "UNTRUSTED_SENDER" });

      expect(invalidationReadCount).toBe(1);
      const durablePoison = await originalLocalGet(
        IN_PAGE_WIDGET_LEASE_INVALIDATION_AUTHORITY_POISON_LOCAL_KEY,
      );
      expect(durablePoison[
        IN_PAGE_WIDGET_LEASE_INVALIDATION_AUTHORITY_POISON_LOCAL_KEY
      ]).toEqual({ authority: "unavailable" });
      const staleSession = await fixture.chrome.storage.session.get(
        IN_PAGE_WIDGET_LEASE_STORAGE_KEY,
      );
      expect(staleSession[IN_PAGE_WIDGET_LEASE_STORAGE_KEY]).toMatchObject({
        leases: [{ surfaceId: fixture.init.surfaceId }],
      });
    },
  );

  test.each(["rejected", "malformed"] as const)(
    "EA-01A-R5-SCOPE-TOMBSTONE fail-closes a %s local invalidation read now and after restart",
    async (failureMode) => {
      const fixture = await createInPageWidgetFixture();
      await flushAsyncWork();
      const childFrameId = 3;
      const childDocumentId = "stale-resumable-child";
      const staleScope = {
        tabId: WIDGET_TAB_ID,
        windowId: WIDGET_WINDOW_ID,
        target: {
          frameId: childFrameId,
          frameOrigin: OTHER_ORIGIN,
          framePathname: "/editor",
          documentId: childDocumentId,
          parentFrameId: 0,
          parentDocumentId: WIDGET_TOP_DOCUMENT_ID,
          parentFrameOrigin: ORIGIN,
          parentFramePathname: "/settings",
        },
        expectedPage: { origin: ORIGIN, pathname: "/settings" },
      };
      await fixture.chrome.storage.session.set({
        [FRAME_SCOPE_SESSION_KEY]: [staleScope],
      });
      fixture.chrome.permissions.contains = vi.fn(async () => true);
      fixture.chrome.webNavigation.getAllFrames = vi.fn(async () => [{
        frameId: 0,
        parentFrameId: -1,
        documentId: WIDGET_TOP_DOCUMENT_ID,
        url: `${ORIGIN}/settings`,
      }, {
        frameId: childFrameId,
        parentFrameId: 0,
        documentId: childDocumentId,
        url: `${OTHER_ORIGIN}/editor`,
      }]);
      const originalGetFrame = fixture.chrome.webNavigation.getFrame;
      fixture.chrome.webNavigation.getFrame = vi.fn(async (details) => (
        details.tabId === WIDGET_TAB_ID && details.frameId === childFrameId
          ? {
              frameId: childFrameId,
              parentFrameId: 0,
              documentId: childDocumentId,
              url: `${OTHER_ORIGIN}/editor`,
            }
          : originalGetFrame(details)
      ));
      vi.mocked(fixture.chrome.webNavigation.getFrame).mockClear();

      const originalLocalGet = fixture.chrome.storage.local.get;
      const invalidationRead = createDeferred<Record<string, unknown>>();
      let invalidationReadCount = 0;
      fixture.chrome.storage.local.get = vi.fn((keys) => {
        if (keys !== FRAME_SCOPE_INVALIDATIONS_LOCAL_KEY) return originalLocalGet(keys);
        invalidationReadCount += 1;
        if (invalidationReadCount > 1) throw new Error("unexpected frame-scope invalidation read");
        return invalidationRead.promise;
      });
      const settleInvalidationRead = (read: ReturnType<
        typeof createDeferred<Record<string, unknown>>
      >) => {
        if (failureMode === "rejected") {
          read.reject(new Error("injected frame-scope invalidation read failure"));
        } else {
          read.resolve({
            [FRAME_SCOPE_INVALIDATIONS_LOCAL_KEY]: [{
              ...staleScope,
              tabId: "malformed",
            }],
          });
        }
      };

      const controller = createBackgroundController({
        chrome: fixture.chrome,
        store: fixture.store,
        ensureContentScript: fixture.ensureContentScript,
      });
      const listed = dispatchRuntime(
        controller,
        { type: "ui-attach:frame-scope-list" },
        createExtensionSender(),
      );
      await waitFor(() => invalidationReadCount === 1);
      settleInvalidationRead(invalidationRead);
      await expect(listed).resolves.toMatchObject({
        ok: true,
        data: { currentFrameId: 0 },
      });
      const restarted = createBackgroundController({
        chrome: fixture.chrome,
        store: fixture.store,
        ensureContentScript: fixture.ensureContentScript,
      });
      await expect(dispatchRuntime(
        restarted,
        { type: "ui-attach:frame-scope-list" },
        createExtensionSender(),
      )).resolves.toMatchObject({ ok: true, data: { currentFrameId: 0 } });

      expect(invalidationReadCount).toBe(1);
      const durablePoison = await originalLocalGet(
        FRAME_SCOPE_INVALIDATION_AUTHORITY_POISON_LOCAL_KEY,
      );
      expect(durablePoison[
        FRAME_SCOPE_INVALIDATION_AUTHORITY_POISON_LOCAL_KEY
      ]).toEqual({ authority: "unavailable" });
      expect(vi.mocked(fixture.chrome.webNavigation.getFrame).mock.calls.some(([details]) => (
        details.frameId === childFrameId
      ))).toBe(false);
      const staleSession = await fixture.chrome.storage.session.get(FRAME_SCOPE_SESSION_KEY);
      expect(staleSession[FRAME_SCOPE_SESSION_KEY]).toEqual([staleScope]);
    },
  );

  test.each(["rejected", "malformed"] as const)(
    "EA-01A-R6-LEASE-AUTHORITY keeps an old tombstone authoritative after a %s read and unrelated-tab writes",
    async (failureMode) => {
      const fixture = await createInPageWidgetFixture();
      await flushAsyncWork();
      const unrelatedTabId = WIDGET_TAB_ID + 1;
      const unrelatedWindowId = WIDGET_WINDOW_ID + 1;
      const unrelatedDocumentId = "unrelated-widget-document";
      const unrelatedUrl = `${OTHER_ORIGIN}/unrelated`;
      const staleInvalidation = {
        surfaceId: fixture.init.surfaceId,
        tabId: WIDGET_TAB_ID,
      };
      await fixture.chrome.storage.local.set({
        [IN_PAGE_WIDGET_LEASE_INVALIDATIONS_LOCAL_KEY]: [staleInvalidation],
      });
      const originalLocalGet = fixture.chrome.storage.local.get;
      let invalidationReadFailed = false;
      fixture.chrome.storage.local.get = vi.fn((keys) => {
        if (keys !== IN_PAGE_WIDGET_LEASE_INVALIDATIONS_LOCAL_KEY || invalidationReadFailed) {
          return originalLocalGet(keys);
        }
        invalidationReadFailed = true;
        if (failureMode === "rejected") {
          return Promise.reject(new Error("injected widget invalidation read failure"));
        }
        return Promise.resolve({
          [IN_PAGE_WIDGET_LEASE_INVALIDATIONS_LOCAL_KEY]: [{
            ...staleInvalidation,
            tabId: "malformed",
          }],
        });
      });
      fixture.chrome.tabs.query = vi.fn(async () => [{
        id: unrelatedTabId,
        url: unrelatedUrl,
        windowId: unrelatedWindowId,
      }]);
      const originalGetFrame = fixture.chrome.webNavigation.getFrame;
      fixture.chrome.webNavigation.getFrame = vi.fn(async (details) => (
        details.tabId === unrelatedTabId && details.frameId === 0
          ? {
              frameId: 0,
              parentFrameId: -1,
              documentId: unrelatedDocumentId,
              url: unrelatedUrl,
            }
          : originalGetFrame(details)
      ));
      const controller = createBackgroundController({
        chrome: fixture.chrome,
        store: fixture.store,
        ensureContentScript: fixture.ensureContentScript,
      });

      await expect(dispatchRuntime(
        controller,
        createInPageWidgetRegistration(fixture.init),
        fixture.widgetSender,
      )).resolves.toMatchObject({ ok: false, code: "UNTRUSTED_SENDER" });
      await expect(controller.showInPageWidget(unrelatedTabId)).resolves.toBe(true);
      await expect(controller.handleTabUpdated(
        unrelatedTabId,
        { status: "loading", url: `${OTHER_ORIGIN}/navigated` },
        { id: unrelatedTabId, url: unrelatedUrl, windowId: unrelatedWindowId },
      )).resolves.toBeUndefined();
      await flushAsyncWork();
      const durableAuthority = await originalLocalGet(
        IN_PAGE_WIDGET_LEASE_INVALIDATION_AUTHORITY_POISON_LOCAL_KEY,
      );
      expect(durableAuthority[
        IN_PAGE_WIDGET_LEASE_INVALIDATION_AUTHORITY_POISON_LOCAL_KEY
      ]).toEqual({ authority: "unavailable" });

      await expect(dispatchRuntime(
        controller,
        createInPageWidgetRegistration(fixture.init),
        fixture.widgetSender,
      )).resolves.toMatchObject({ ok: false, code: "UNTRUSTED_SENDER" });
      const restarted = createBackgroundController({
        chrome: fixture.chrome,
        store: fixture.store,
        ensureContentScript: fixture.ensureContentScript,
      });
      await expect(dispatchRuntime(
        restarted,
        createInPageWidgetRegistration(fixture.init),
        fixture.widgetSender,
      )).resolves.toMatchObject({ ok: false, code: "UNTRUSTED_SENDER" });
    },
  );

  test.each(["rejected", "malformed"] as const)(
    "EA-01A-R6-SCOPE-AUTHORITY keeps an old scope tombstone authoritative after a %s read and unrelated-tab writes",
    async (failureMode) => {
      const fixture = await createInPageWidgetFixture();
      await flushAsyncWork();
      const childFrameId = 3;
      const unrelatedTabId = WIDGET_TAB_ID + 1;
      const unrelatedChildFrameId = 4;
      const staleScope = {
        tabId: WIDGET_TAB_ID,
        windowId: WIDGET_WINDOW_ID,
        target: {
          frameId: childFrameId,
          frameOrigin: OTHER_ORIGIN,
          framePathname: "/editor",
          documentId: "stale-authority-child",
          parentFrameId: 0,
        },
        expectedPage: { origin: ORIGIN, pathname: "/settings" },
      };
      const unrelatedScope = {
        tabId: unrelatedTabId,
        windowId: WIDGET_WINDOW_ID + 1,
        target: {
          frameId: unrelatedChildFrameId,
          frameOrigin: OTHER_ORIGIN,
          framePathname: "/unrelated-child",
          documentId: "unrelated-authority-child",
          parentFrameId: 0,
        },
        expectedPage: { origin: ORIGIN, pathname: "/unrelated" },
      };
      await fixture.chrome.storage.session.set({ [FRAME_SCOPE_SESSION_KEY]: [staleScope] });
      await fixture.chrome.storage.local.set({
        [FRAME_SCOPE_INVALIDATIONS_LOCAL_KEY]: [staleScope],
      });
      const originalLocalGet = fixture.chrome.storage.local.get;
      let invalidationReadFailed = false;
      fixture.chrome.storage.local.get = vi.fn((keys) => {
        if (keys !== FRAME_SCOPE_INVALIDATIONS_LOCAL_KEY || invalidationReadFailed) {
          return originalLocalGet(keys);
        }
        invalidationReadFailed = true;
        if (failureMode === "rejected") {
          return Promise.reject(new Error("injected frame-scope invalidation read failure"));
        }
        return Promise.resolve({
          [FRAME_SCOPE_INVALIDATIONS_LOCAL_KEY]: [{ ...staleScope, tabId: "malformed" }],
        });
      });
      let activeTabId = unrelatedTabId;
      fixture.chrome.tabs.query = vi.fn(async () => activeTabId === unrelatedTabId
        ? [{
            id: unrelatedTabId,
            url: `${ORIGIN}/unrelated`,
            windowId: unrelatedScope.windowId,
          }]
        : [{ id: WIDGET_TAB_ID, url: `${ORIGIN}/settings`, windowId: WIDGET_WINDOW_ID }]);
      const framesByTab = new Map([
        [WIDGET_TAB_ID, [{
          frameId: 0,
          parentFrameId: -1,
          documentId: WIDGET_TOP_DOCUMENT_ID,
          url: `${ORIGIN}/settings`,
        }, {
          frameId: childFrameId,
          parentFrameId: 0,
          documentId: staleScope.target.documentId,
          url: `${OTHER_ORIGIN}/editor`,
        }]],
        [unrelatedTabId, [{
          frameId: 0,
          parentFrameId: -1,
          documentId: "unrelated-authority-top",
          url: `${ORIGIN}/unrelated`,
        }, {
          frameId: unrelatedChildFrameId,
          parentFrameId: 0,
          documentId: unrelatedScope.target.documentId,
          url: `${OTHER_ORIGIN}/unrelated-child`,
        }]],
      ]);
      fixture.chrome.webNavigation.getAllFrames = vi.fn(async ({ tabId }) => (
        framesByTab.get(tabId) ?? []
      ));
      fixture.chrome.webNavigation.getFrame = vi.fn(async ({ tabId, frameId }) => (
        framesByTab.get(tabId)?.find((frame) => frame.frameId === frameId)
      ));
      fixture.chrome.permissions.contains = vi.fn(async () => true);
      const controller = createBackgroundController({
        chrome: fixture.chrome,
        store: fixture.store,
        ensureContentScript: fixture.ensureContentScript,
      });

      await expect(dispatchRuntime(controller, {
        type: "ui-attach:frame-scope-select",
        tabId: unrelatedTabId,
        frameId: unrelatedChildFrameId,
        documentId: unrelatedScope.target.documentId,
        origin: OTHER_ORIGIN,
        pathname: "/unrelated-child",
        startSelection: false,
      }, createExtensionSender())).resolves.toEqual({ ok: true, data: { enabled: false } });
      const durableAuthority = await originalLocalGet([
        FRAME_SCOPE_INVALIDATIONS_LOCAL_KEY,
        FRAME_SCOPE_INVALIDATION_AUTHORITY_POISON_LOCAL_KEY,
      ]);
      expect(durableAuthority[FRAME_SCOPE_INVALIDATIONS_LOCAL_KEY]).toEqual([staleScope]);
      expect(durableAuthority[FRAME_SCOPE_INVALIDATION_AUTHORITY_POISON_LOCAL_KEY]).toEqual({
        authority: "unavailable",
      });
      // Model an older already-issued session writer completing after the unrelated write.
      await fixture.chrome.storage.session.set({ [FRAME_SCOPE_SESSION_KEY]: [staleScope] });
      activeTabId = WIDGET_TAB_ID;
      await flushAsyncWork();

      await expect(dispatchRuntime(
        controller,
        { type: "ui-attach:frame-scope-list" },
        createExtensionSender(),
      )).resolves.toMatchObject({ ok: true, data: { currentFrameId: 0 } });
      const restarted = createBackgroundController({
        chrome: fixture.chrome,
        store: fixture.store,
        ensureContentScript: fixture.ensureContentScript,
      });
      await expect(dispatchRuntime(
        restarted,
        { type: "ui-attach:frame-scope-list" },
        createExtensionSender(),
      )).resolves.toMatchObject({ ok: true, data: { currentFrameId: 0 } });
    },
  );

  test("EA-01A-R7-STICKY-POISON keeps lease poison after an older controller's accepted snapshot arrives", async () => {
    const fixture = await createInPageWidgetFixture();
    await flushAsyncWork();
    const originalSessionRemove = fixture.chrome.storage.session.remove;
    fixture.chrome.storage.session.remove = vi.fn(async (keys) => {
      const requested = Array.isArray(keys) ? keys : [keys];
      if (requested.includes(IN_PAGE_WIDGET_LEASE_STORAGE_KEY)) {
        throw new Error("injected stale lease cleanup failure");
      }
      await originalSessionRemove(keys);
    });
    const originalLocalGet = fixture.chrome.storage.local.get;
    const originalLocalSet = fixture.chrome.storage.local.set;
    const oldSnapshotStarted = createDeferred<void>();
    const finishOldSnapshot = createDeferred<void>();
    let oldSnapshotDeferred = false;
    fixture.chrome.storage.local.set = vi.fn(async (values) => {
      const snapshot = values[IN_PAGE_WIDGET_LEASE_INVALIDATIONS_LOCAL_KEY];
      if (!oldSnapshotDeferred && Array.isArray(snapshot) && snapshot.some((entry) => (
        isRecord(entry) && entry.surfaceId === fixture.init.surfaceId
      ))) {
        oldSnapshotDeferred = true;
        oldSnapshotStarted.resolve(undefined);
        await finishOldSnapshot.promise;
      }
      await originalLocalSet(values);
    });

    const oldRelease = dispatchRuntime(
      fixture.controller,
      createInPageWidgetCommandEnvelope(fixture.init, {
        type: "ui-attach:widget-surface-release",
      }),
      fixture.widgetSender,
    );
    await oldSnapshotStarted.promise;

    let failNextSnapshotRead = true;
    fixture.chrome.storage.local.get = vi.fn((keys) => {
      if (keys === IN_PAGE_WIDGET_LEASE_INVALIDATIONS_LOCAL_KEY && failNextSnapshotRead) {
        failNextSnapshotRead = false;
        return Promise.reject(new Error("injected widget invalidation read failure"));
      }
      return originalLocalGet(keys);
    });
    const poisonWriter = createBackgroundController({
      chrome: fixture.chrome,
      store: fixture.store,
      ensureContentScript: fixture.ensureContentScript,
    });
    await expect(dispatchRuntime(
      poisonWriter,
      createInPageWidgetRegistration(fixture.init),
      fixture.widgetSender,
    )).resolves.toMatchObject({ ok: false, code: "UNTRUSTED_SENDER" });
    await expect(poisonWriter.handleTabUpdated(
      WIDGET_TAB_ID,
      { status: "loading", url: `${ORIGIN}/poisoned-navigation` },
      { id: WIDGET_TAB_ID, url: `${ORIGIN}/poisoned-navigation`, windowId: WIDGET_WINDOW_ID },
    )).resolves.toBeUndefined();
    const poisonBeforeOldSnapshot = await originalLocalGet(
      IN_PAGE_WIDGET_LEASE_INVALIDATION_AUTHORITY_POISON_LOCAL_KEY,
    );

    finishOldSnapshot.resolve(undefined);
    await expect(oldRelease).resolves.toMatchObject({ ok: false, code: "STORAGE_ERROR" });
    await flushAsyncWork();
    expect(poisonBeforeOldSnapshot[
      IN_PAGE_WIDGET_LEASE_INVALIDATION_AUTHORITY_POISON_LOCAL_KEY
    ]).toEqual({ authority: "unavailable" });
    const durable = await originalLocalGet([
      IN_PAGE_WIDGET_LEASE_INVALIDATIONS_LOCAL_KEY,
      IN_PAGE_WIDGET_LEASE_INVALIDATION_AUTHORITY_POISON_LOCAL_KEY,
    ]);
    expect(durable[IN_PAGE_WIDGET_LEASE_INVALIDATIONS_LOCAL_KEY]).toMatchObject([{
      surfaceId: fixture.init.surfaceId,
      tabId: WIDGET_TAB_ID,
    }]);
    expect(durable[
      IN_PAGE_WIDGET_LEASE_INVALIDATION_AUTHORITY_POISON_LOCAL_KEY
    ]).toEqual({ authority: "unavailable" });

    fixture.chrome.storage.local.get = originalLocalGet;
    const restarted = createBackgroundController({
      chrome: fixture.chrome,
      store: fixture.store,
      ensureContentScript: fixture.ensureContentScript,
    });
    await expect(dispatchRuntime(
      restarted,
      createInPageWidgetRegistration(fixture.init),
      fixture.widgetSender,
    )).resolves.toMatchObject({ ok: false, code: "UNTRUSTED_SENDER" });
  });

  test("EA-01A-R7-STICKY-POISON keeps scope poison after an older controller's accepted empty snapshot arrives", async () => {
    const fixture = await createInPageWidgetFixture();
    await flushAsyncWork();
    const staleScope = {
      tabId: WIDGET_TAB_ID,
      windowId: WIDGET_WINDOW_ID,
      target: {
        frameId: 3,
        frameOrigin: OTHER_ORIGIN,
        framePathname: "/editor",
        documentId: "sticky-poison-child",
        parentFrameId: 0,
      },
      expectedPage: { origin: ORIGIN, pathname: "/settings" },
    };
    await fixture.chrome.storage.session.set({ [FRAME_SCOPE_SESSION_KEY]: [staleScope] });
    await fixture.chrome.storage.local.set({
      [FRAME_SCOPE_INVALIDATIONS_LOCAL_KEY]: [staleScope],
    });
    fixture.chrome.tabs.query = vi.fn(async () => [{
      id: WIDGET_TAB_ID,
      url: `${ORIGIN}/settings`,
      windowId: WIDGET_WINDOW_ID,
    }]);
    fixture.chrome.webNavigation.getAllFrames = vi.fn(async () => [{
      frameId: 0,
      parentFrameId: -1,
      documentId: WIDGET_TOP_DOCUMENT_ID,
      url: `${ORIGIN}/settings`,
    }, {
      frameId: staleScope.target.frameId,
      parentFrameId: 0,
      documentId: staleScope.target.documentId,
      url: `${OTHER_ORIGIN}/editor`,
    }]);
    const staleWriter = createBackgroundController({
      chrome: fixture.chrome,
      store: fixture.store,
      ensureContentScript: fixture.ensureContentScript,
    });
    const originalLocalGet = fixture.chrome.storage.local.get;
    const originalLocalSet = fixture.chrome.storage.local.set;
    const oldSnapshotStarted = createDeferred<void>();
    const finishOldSnapshot = createDeferred<void>();
    let oldSnapshotDeferred = false;
    fixture.chrome.storage.local.set = vi.fn(async (values) => {
      const snapshot = values[FRAME_SCOPE_INVALIDATIONS_LOCAL_KEY];
      if (!oldSnapshotDeferred && Array.isArray(snapshot) && snapshot.length === 0) {
        oldSnapshotDeferred = true;
        oldSnapshotStarted.resolve(undefined);
        await finishOldSnapshot.promise;
      }
      await originalLocalSet(values);
    });
    const scopeCommand = {
      type: "ui-attach:frame-scope-select",
      tabId: WIDGET_TAB_ID,
      frameId: staleScope.target.frameId,
      documentId: staleScope.target.documentId,
      origin: OTHER_ORIGIN,
      pathname: "/editor",
      startSelection: false,
    } as const;
    const oldSelection = dispatchRuntime(
      staleWriter,
      scopeCommand,
      createExtensionSender(),
    );
    await oldSnapshotStarted.promise;

    let failNextSnapshotRead = true;
    fixture.chrome.storage.local.get = vi.fn((keys) => {
      if (keys === FRAME_SCOPE_INVALIDATIONS_LOCAL_KEY && failNextSnapshotRead) {
        failNextSnapshotRead = false;
        return Promise.reject(new Error("injected frame-scope invalidation read failure"));
      }
      return originalLocalGet(keys);
    });
    const poisonWriter = createBackgroundController({
      chrome: fixture.chrome,
      store: fixture.store,
      ensureContentScript: fixture.ensureContentScript,
    });
    await expect(dispatchRuntime(
      poisonWriter,
      scopeCommand,
      createExtensionSender(),
    )).resolves.toEqual({ ok: true, data: { enabled: false } });
    const poisonBeforeOldSnapshot = await originalLocalGet(
      FRAME_SCOPE_INVALIDATION_AUTHORITY_POISON_LOCAL_KEY,
    );

    finishOldSnapshot.resolve(undefined);
    await expect(oldSelection).resolves.toEqual({ ok: true, data: { enabled: false } });
    await flushAsyncWork();
    expect(poisonBeforeOldSnapshot[
      FRAME_SCOPE_INVALIDATION_AUTHORITY_POISON_LOCAL_KEY
    ]).toEqual({ authority: "unavailable" });
    const durable = await originalLocalGet([
      FRAME_SCOPE_INVALIDATIONS_LOCAL_KEY,
      FRAME_SCOPE_INVALIDATION_AUTHORITY_POISON_LOCAL_KEY,
    ]);
    expect(durable[FRAME_SCOPE_INVALIDATIONS_LOCAL_KEY]).toEqual([]);
    expect(durable[FRAME_SCOPE_INVALIDATION_AUTHORITY_POISON_LOCAL_KEY]).toEqual({
      authority: "unavailable",
    });

    fixture.chrome.storage.local.get = originalLocalGet;
    const restarted = createBackgroundController({
      chrome: fixture.chrome,
      store: fixture.store,
      ensureContentScript: fixture.ensureContentScript,
    });
    await expect(dispatchRuntime(
      restarted,
      { type: "ui-attach:frame-scope-list" },
      createExtensionSender(),
    )).resolves.toMatchObject({ ok: true, data: { currentFrameId: 0 } });
  });

  test("EA-01A-R7-STICKY-POISON migrates both legacy unavailable markers without a recovery window", async () => {
    const leaseFixture = await createInPageWidgetFixture();
    await flushAsyncWork();
    await leaseFixture.chrome.storage.local.set({
      [IN_PAGE_WIDGET_LEASE_INVALIDATIONS_LOCAL_KEY]: { authority: "unavailable" },
    });
    const leaseRestart = createBackgroundController({
      chrome: leaseFixture.chrome,
      store: leaseFixture.store,
      ensureContentScript: leaseFixture.ensureContentScript,
    });
    await expect(dispatchRuntime(
      leaseRestart,
      createInPageWidgetRegistration(leaseFixture.init),
      leaseFixture.widgetSender,
    )).resolves.toMatchObject({ ok: false, code: "UNTRUSTED_SENDER" });
    const migratedLeasePoison = await leaseFixture.chrome.storage.local.get(
      IN_PAGE_WIDGET_LEASE_INVALIDATION_AUTHORITY_POISON_LOCAL_KEY,
    );
    expect(migratedLeasePoison[
      IN_PAGE_WIDGET_LEASE_INVALIDATION_AUTHORITY_POISON_LOCAL_KEY
    ]).toEqual({ authority: "unavailable" });

    const scopeFixture = await createInPageWidgetFixture();
    await flushAsyncWork();
    await scopeFixture.chrome.storage.local.set({
      [FRAME_SCOPE_INVALIDATIONS_LOCAL_KEY]: { authority: "unavailable" },
    });
    const scopeRestart = createBackgroundController({
      chrome: scopeFixture.chrome,
      store: scopeFixture.store,
      ensureContentScript: scopeFixture.ensureContentScript,
    });
    await expect(dispatchRuntime(
      scopeRestart,
      { type: "ui-attach:frame-scope-list" },
      createExtensionSender(),
    )).resolves.toMatchObject({ ok: true, data: { currentFrameId: 0 } });
    const migratedScopePoison = await scopeFixture.chrome.storage.local.get(
      FRAME_SCOPE_INVALIDATION_AUTHORITY_POISON_LOCAL_KEY,
    );
    expect(migratedScopePoison[
      FRAME_SCOPE_INVALIDATION_AUTHORITY_POISON_LOCAL_KEY
    ]).toEqual({ authority: "unavailable" });
  });

  test("EA-01A-R7-STICKY-POISON persists fail-closed state when either poison authority read fails", async () => {
    const leaseFixture = await createInPageWidgetFixture();
    await flushAsyncWork();
    const originalLeaseLocalGet = leaseFixture.chrome.storage.local.get;
    let leasePoisonReadFailed = false;
    leaseFixture.chrome.storage.local.get = vi.fn((keys) => {
      if (keys === IN_PAGE_WIDGET_LEASE_INVALIDATION_AUTHORITY_POISON_LOCAL_KEY &&
          !leasePoisonReadFailed) {
        leasePoisonReadFailed = true;
        return Promise.reject(new Error("injected widget poison authority read failure"));
      }
      return originalLeaseLocalGet(keys);
    });
    const leaseController = createBackgroundController({
      chrome: leaseFixture.chrome,
      store: leaseFixture.store,
      ensureContentScript: leaseFixture.ensureContentScript,
    });
    await expect(dispatchRuntime(
      leaseController,
      createInPageWidgetRegistration(leaseFixture.init),
      leaseFixture.widgetSender,
    )).resolves.toMatchObject({ ok: false, code: "UNTRUSTED_SENDER" });
    const leasePoison = await originalLeaseLocalGet(
      IN_PAGE_WIDGET_LEASE_INVALIDATION_AUTHORITY_POISON_LOCAL_KEY,
    );
    expect(leasePoison[
      IN_PAGE_WIDGET_LEASE_INVALIDATION_AUTHORITY_POISON_LOCAL_KEY
    ]).toEqual({ authority: "unavailable" });

    const scopeFixture = await createInPageWidgetFixture();
    await flushAsyncWork();
    const staleScope = {
      tabId: WIDGET_TAB_ID,
      windowId: WIDGET_WINDOW_ID,
      target: {
        frameId: 3,
        frameOrigin: OTHER_ORIGIN,
        framePathname: "/editor",
        documentId: "poison-read-failed-child",
        parentFrameId: 0,
      },
      expectedPage: { origin: ORIGIN, pathname: "/settings" },
    };
    await scopeFixture.chrome.storage.session.set({ [FRAME_SCOPE_SESSION_KEY]: [staleScope] });
    const originalScopeLocalGet = scopeFixture.chrome.storage.local.get;
    let scopePoisonReadFailed = false;
    scopeFixture.chrome.storage.local.get = vi.fn((keys) => {
      if (keys === FRAME_SCOPE_INVALIDATION_AUTHORITY_POISON_LOCAL_KEY &&
          !scopePoisonReadFailed) {
        scopePoisonReadFailed = true;
        return Promise.reject(new Error("injected scope poison authority read failure"));
      }
      return originalScopeLocalGet(keys);
    });
    const scopeController = createBackgroundController({
      chrome: scopeFixture.chrome,
      store: scopeFixture.store,
      ensureContentScript: scopeFixture.ensureContentScript,
    });
    await expect(dispatchRuntime(
      scopeController,
      { type: "ui-attach:frame-scope-list" },
      createExtensionSender(),
    )).resolves.toMatchObject({ ok: true, data: { currentFrameId: 0 } });
    const scopePoison = await originalScopeLocalGet(
      FRAME_SCOPE_INVALIDATION_AUTHORITY_POISON_LOCAL_KEY,
    );
    expect(scopePoison[FRAME_SCOPE_INVALIDATION_AUTHORITY_POISON_LOCAL_KEY]).toEqual({
      authority: "unavailable",
    });
  });

  test("EA-01A-R7-GEN2-WIDGET-UNDEFINED poisons an own legacy snapshot key whose value is undefined", async () => {
    const fixture = await createInPageWidgetFixture();
    await flushAsyncWork();
    await fixture.chrome.storage.local.set({
      [IN_PAGE_WIDGET_LEASE_INVALIDATIONS_LOCAL_KEY]: undefined,
    });
    const current = createBackgroundController({
      chrome: fixture.chrome,
      store: fixture.store,
      ensureContentScript: fixture.ensureContentScript,
    });

    await expect(dispatchRuntime(
      current,
      createInPageWidgetRegistration(fixture.init),
      fixture.widgetSender,
    )).resolves.toMatchObject({ ok: false, code: "UNTRUSTED_SENDER" });
    const durable = await fixture.chrome.storage.local.get([
      IN_PAGE_WIDGET_LEASE_INVALIDATIONS_LOCAL_KEY,
      IN_PAGE_WIDGET_LEASE_INVALIDATION_AUTHORITY_POISON_LOCAL_KEY,
    ]);
    expect(Object.hasOwn(durable, IN_PAGE_WIDGET_LEASE_INVALIDATIONS_LOCAL_KEY)).toBe(true);
    expect(durable[IN_PAGE_WIDGET_LEASE_INVALIDATIONS_LOCAL_KEY]).toBeUndefined();
    expect(durable[
      IN_PAGE_WIDGET_LEASE_INVALIDATION_AUTHORITY_POISON_LOCAL_KEY
    ]).toEqual({ authority: "unavailable" });
    const staleSession = await fixture.chrome.storage.session.get(
      IN_PAGE_WIDGET_LEASE_STORAGE_KEY,
    );
    expect(staleSession[IN_PAGE_WIDGET_LEASE_STORAGE_KEY]).toMatchObject({
      leases: [{ surfaceId: fixture.init.surfaceId }],
    });

    const recreated = createBackgroundController({
      chrome: fixture.chrome,
      store: fixture.store,
      ensureContentScript: fixture.ensureContentScript,
    });
    await expect(dispatchRuntime(
      recreated,
      createInPageWidgetRegistration(fixture.init),
      fixture.widgetSender,
    )).resolves.toMatchObject({ ok: false, code: "UNTRUSTED_SENDER" });
  });

  test("EA-01A-R6-TERMINAL-CANCEL retires a session-persisted lease stalled on INIT without harming its replacement", async () => {
    const fixture = await createInPageWidgetFixture();
    await expect(dispatchRuntime(
      fixture.controller,
      createInPageWidgetCommandEnvelope(fixture.init, {
        type: "ui-attach:widget-surface-release",
      }),
      fixture.widgetSender,
    )).resolves.toEqual({ ok: true, data: null });
    vi.mocked(fixture.chrome.tabs.sendMessage).mockClear();
    const staleInitStarted = createDeferred<InPageWidgetInitMessage>();
    const finishStaleInit = createDeferred<{ ok: true; data: null }>();
    const originalSendMessage = fixture.chrome.tabs.sendMessage;
    let staleInitDeferred = false;
    fixture.chrome.tabs.sendMessage = vi.fn(async (tabId, message, options) => {
      const init = parseInPageWidgetInitMessage(message);
      if (init && !staleInitDeferred) {
        staleInitDeferred = true;
        staleInitStarted.resolve(init);
        return finishStaleInit.promise;
      }
      return await originalSendMessage(tabId, message, options);
    });

    const staleShow = fixture.controller.showInPageWidget(WIDGET_TAB_ID);
    const staleInit = await staleInitStarted.promise;
    const stalePersisted = await fixture.chrome.storage.session.get(
      IN_PAGE_WIDGET_LEASE_STORAGE_KEY,
    );
    expect(stalePersisted[IN_PAGE_WIDGET_LEASE_STORAGE_KEY]).toMatchObject({
      leases: [{ surfaceId: staleInit.surfaceId }],
    });
    await expect(fixture.controller.handleNavigationCommitted({
      tabId: WIDGET_TAB_ID,
      frameId: 0,
      parentFrameId: -1,
      documentId: "replacement-top-document",
      url: `${ORIGIN}/terminal-navigation`,
    })).resolves.toBeUndefined();
    await expect(fixture.controller.showInPageWidget(WIDGET_TAB_ID)).resolves.toBe(true);
    const replacementInit = vi.mocked(fixture.chrome.tabs.sendMessage).mock.calls
      .map((call) => parseInPageWidgetInitMessage(call[1]))
      .find((message): message is InPageWidgetInitMessage => (
        message !== null && message.surfaceId !== staleInit.surfaceId
      ));
    if (!replacementInit) throw new Error("replacement in-page widget init was not sent");
    finishStaleInit.resolve({ ok: true, data: null });

    await expect(staleShow).resolves.toBe(false);
    await flushAsyncWork();
    const persisted = await fixture.chrome.storage.session.get(IN_PAGE_WIDGET_LEASE_STORAGE_KEY);
    expect(persisted[IN_PAGE_WIDGET_LEASE_STORAGE_KEY]).toMatchObject({
      leases: [{ surfaceId: replacementInit.surfaceId }],
    });
    const restarted = createBackgroundController({
      chrome: fixture.chrome,
      store: fixture.store,
      ensureContentScript: fixture.ensureContentScript,
    });
    await expect(dispatchRuntime(
      restarted,
      createInPageWidgetRegistration(replacementInit),
      fixture.widgetSender,
    )).resolves.toEqual({ ok: true, data: { registered: true } });
  });

  test("EA-01A-R6-LEASE-BOUND emits a global fail-closed value instead of 65 tombstones", async () => {
    const fixture = await createInPageWidgetFixture();
    await flushAsyncWork();
    await fixture.chrome.storage.local.set({
      [IN_PAGE_WIDGET_LEASE_INVALIDATIONS_LOCAL_KEY]: Array.from({ length: 64 }, (_, index) => ({
        surfaceId: crypto.randomUUID(),
        tabId: 100 + index,
      })),
    });
    const controller = createBackgroundController({
      chrome: fixture.chrome,
      store: fixture.store,
      ensureContentScript: fixture.ensureContentScript,
    });
    await expect(dispatchRuntime(
      controller,
      createInPageWidgetRegistration(fixture.init),
      fixture.widgetSender,
    )).resolves.toEqual({ ok: true, data: { registered: true } });
    const originalSessionRemove = fixture.chrome.storage.session.remove;
    fixture.chrome.storage.session.remove = vi.fn(async (keys) => {
      if (keys === IN_PAGE_WIDGET_LEASE_STORAGE_KEY || (
        Array.isArray(keys) && keys.includes(IN_PAGE_WIDGET_LEASE_STORAGE_KEY)
      )) throw new Error("injected stale lease cleanup failure");
      await originalSessionRemove(keys);
    });

    await expect(controller.handleNavigationCommitted({
      tabId: WIDGET_TAB_ID,
      frameId: 0,
      parentFrameId: -1,
      documentId: "bounded-replacement-top-document",
      url: `${ORIGIN}/bounded-navigation`,
    })).resolves.toBeUndefined();
    const stored = await fixture.chrome.storage.local.get([
      IN_PAGE_WIDGET_LEASE_INVALIDATIONS_LOCAL_KEY,
      IN_PAGE_WIDGET_LEASE_INVALIDATION_AUTHORITY_POISON_LOCAL_KEY,
    ]);
    expect(stored[IN_PAGE_WIDGET_LEASE_INVALIDATIONS_LOCAL_KEY]).toHaveLength(64);
    expect(stored[IN_PAGE_WIDGET_LEASE_INVALIDATION_AUTHORITY_POISON_LOCAL_KEY]).toEqual({
      authority: "unavailable",
    });
  });

  test("EA-01A-R6-SCOPE-BOUND emits a global fail-closed value instead of 65 tombstones", async () => {
    const fixture = await createInPageWidgetFixture();
    await flushAsyncWork();
    const liveScope = {
      tabId: WIDGET_TAB_ID,
      windowId: WIDGET_WINDOW_ID,
      target: {
        frameId: 3,
        frameOrigin: OTHER_ORIGIN,
        framePathname: "/bounded",
        documentId: "bounded-live-child",
        parentFrameId: 0,
      },
      expectedPage: { origin: ORIGIN, pathname: "/settings" },
    };
    const invalidations = Array.from({ length: 64 }, (_, index) => ({
      ...liveScope,
      tabId: 100 + index,
      target: { ...liveScope.target, documentId: `bounded-child-${index}` },
    }));
    await fixture.chrome.storage.local.set({
      [FRAME_SCOPE_INVALIDATIONS_LOCAL_KEY]: invalidations,
    });
    await fixture.chrome.storage.session.set({ [FRAME_SCOPE_SESSION_KEY]: [liveScope] });
    const controller = createBackgroundController({
      chrome: fixture.chrome,
      store: fixture.store,
      ensureContentScript: fixture.ensureContentScript,
    });

    await expect(controller.handleTabUpdated(
      WIDGET_TAB_ID,
      { status: "loading", url: `${ORIGIN}/bounded-navigation` },
      { id: WIDGET_TAB_ID, url: `${ORIGIN}/bounded-navigation`, windowId: WIDGET_WINDOW_ID },
    )).resolves.toBeUndefined();
    const stored = await fixture.chrome.storage.local.get([
      FRAME_SCOPE_INVALIDATIONS_LOCAL_KEY,
      FRAME_SCOPE_INVALIDATION_AUTHORITY_POISON_LOCAL_KEY,
    ]);
    expect(stored[FRAME_SCOPE_INVALIDATIONS_LOCAL_KEY]).toHaveLength(64);
    expect(stored[FRAME_SCOPE_INVALIDATION_AUTHORITY_POISON_LOCAL_KEY]).toEqual({
      authority: "unavailable",
    });
  });

  test("R4-SCOPE-01 retires a cancelled child scope persisted during terminal release", async () => {
    const fixture = await createInPageWidgetFixture();
    const childFrameId = 3;
    const childDocumentId = "cancelled-resumable-child";
    const frames = [{
      frameId: 0,
      parentFrameId: -1,
      documentId: WIDGET_TOP_DOCUMENT_ID,
      url: `${ORIGIN}/settings`,
    }, {
      frameId: childFrameId,
      parentFrameId: 0,
      documentId: childDocumentId,
      url: `${OTHER_ORIGIN}/editor`,
    }];
    fixture.chrome.webNavigation.getAllFrames = vi.fn(async () => frames);
    const originalGetFrame = fixture.chrome.webNavigation.getFrame;
    fixture.chrome.webNavigation.getFrame = vi.fn(async (details) => (
      details.tabId === WIDGET_TAB_ID && details.frameId === childFrameId
        ? frames[1]
        : originalGetFrame(details)
    ));
    const scopePersisted = createDeferred<void>();
    const finishScopePersistence = createDeferred<void>();
    const originalSessionSet = fixture.chrome.storage.session.set;
    let deferredScopeWrite = false;
    fixture.chrome.storage.session.set = vi.fn(async (values) => {
      await originalSessionSet(values);
      if (!deferredScopeWrite && Object.hasOwn(values, FRAME_SCOPE_SESSION_KEY)) {
        deferredScopeWrite = true;
        scopePersisted.resolve(undefined);
        await finishScopePersistence.promise;
      }
    });

    const selection = dispatchRuntime(
      fixture.controller,
      createInPageWidgetCommandEnvelope(fixture.init, {
        type: "ui-attach:widget-frame-scope-select",
        frameId: childFrameId,
        documentId: childDocumentId,
        origin: OTHER_ORIGIN,
        pathname: "/editor",
        expectedGeneration: 0,
      }),
      fixture.widgetSender,
    );
    await scopePersisted.promise;
    await expect(dispatchRuntime(
      fixture.controller,
      createInPageWidgetCommandEnvelope(fixture.init, {
        type: "ui-attach:widget-surface-release",
      }),
      fixture.widgetSender,
    )).resolves.toEqual({ ok: true, data: null });
    finishScopePersistence.resolve(undefined);

    await expect(selection).resolves.toMatchObject({
      ok: false,
      code: "WIDGET_STATE_UNAVAILABLE",
    });
    const storedScopes = await fixture.chrome.storage.session.get(FRAME_SCOPE_SESSION_KEY);
    expect(storedScopes[FRAME_SCOPE_SESSION_KEY]).toEqual([]);

    const restarted = createBackgroundController({
      chrome: fixture.chrome,
      store: fixture.store,
      ensureContentScript: fixture.ensureContentScript,
    });
    vi.mocked(fixture.chrome.tabs.sendMessage).mockClear();
    await expect(restarted.showInPageWidget(WIDGET_TAB_ID)).resolves.toBe(true);
    const restartedInit = vi.mocked(fixture.chrome.tabs.sendMessage).mock.calls
      .map((call) => parseInPageWidgetInitMessage(call[1]))
      .find((message): message is InPageWidgetInitMessage => message !== null);
    if (!restartedInit) throw new Error("restarted in-page widget init was not sent");
    await expect(dispatchRuntime(
      restarted,
      createInPageWidgetCommandEnvelope(restartedInit, {
        type: "ui-attach:widget-frame-scope-list",
      }),
      fixture.widgetSender,
    )).resolves.toMatchObject({ ok: true, data: { currentFrameId: 0 } });
  });

  test("R4-PERSIST-01 durable-fences a child scope when session cleanup fails", async () => {
    const fixture = await createInPageWidgetFixture();
    const childFrameId = 3;
    const childDocumentId = "persist-failed-resumable-child";
    const frames = [{
      frameId: 0,
      parentFrameId: -1,
      documentId: WIDGET_TOP_DOCUMENT_ID,
      url: `${ORIGIN}/settings`,
    }, {
      frameId: childFrameId,
      parentFrameId: 0,
      documentId: childDocumentId,
      url: `${OTHER_ORIGIN}/editor`,
    }];
    fixture.chrome.webNavigation.getAllFrames = vi.fn(async () => frames);
    const originalGetFrame = fixture.chrome.webNavigation.getFrame;
    fixture.chrome.webNavigation.getFrame = vi.fn(async (details) => (
      details.tabId === WIDGET_TAB_ID && details.frameId === childFrameId
        ? frames[1]
        : originalGetFrame(details)
    ));
    const scopePersisted = createDeferred<void>();
    const finishScopePersistence = createDeferred<void>();
    const originalSessionSet = fixture.chrome.storage.session.set;
    let remembered = false;
    let cleanupWriteFailures = 0;
    fixture.chrome.storage.session.set = vi.fn(async (values) => {
      if (Object.hasOwn(values, FRAME_SCOPE_SESSION_KEY)) {
        const scopes = values[FRAME_SCOPE_SESSION_KEY];
        if (!remembered && Array.isArray(scopes) && scopes.length > 0) {
          remembered = true;
          await originalSessionSet(values);
          scopePersisted.resolve(undefined);
          await finishScopePersistence.promise;
          return;
        }
        if (remembered && Array.isArray(scopes) && scopes.length === 0) {
          cleanupWriteFailures += 1;
          throw new Error("injected scope cleanup write failure");
        }
      }
      await originalSessionSet(values);
    });

    const selection = dispatchRuntime(
      fixture.controller,
      createInPageWidgetCommandEnvelope(fixture.init, {
        type: "ui-attach:widget-frame-scope-select",
        frameId: childFrameId,
        documentId: childDocumentId,
        origin: OTHER_ORIGIN,
        pathname: "/editor",
        expectedGeneration: 0,
      }),
      fixture.widgetSender,
    );
    await scopePersisted.promise;
    await expect(dispatchRuntime(
      fixture.controller,
      createInPageWidgetCommandEnvelope(fixture.init, {
        type: "ui-attach:widget-surface-release",
      }),
      fixture.widgetSender,
    )).resolves.toEqual({ ok: true, data: null });
    finishScopePersistence.resolve(undefined);
    await expect(selection).resolves.toMatchObject({
      ok: false,
      code: "WIDGET_STATE_UNAVAILABLE",
    });
    expect(cleanupWriteFailures).toBe(1);
    const staleSession = await fixture.chrome.storage.session.get(FRAME_SCOPE_SESSION_KEY);
    expect(staleSession[FRAME_SCOPE_SESSION_KEY]).toMatchObject([{
      tabId: WIDGET_TAB_ID,
      target: { frameId: childFrameId, documentId: childDocumentId },
    }]);
    const durableFence = await fixture.chrome.storage.local.get(
      FRAME_SCOPE_INVALIDATIONS_LOCAL_KEY,
    );
    expect(durableFence[FRAME_SCOPE_INVALIDATIONS_LOCAL_KEY]).toMatchObject([{
      tabId: WIDGET_TAB_ID,
      target: { frameId: childFrameId, documentId: childDocumentId },
    }]);

    vi.mocked(fixture.chrome.tabs.sendMessage).mockClear();
    await expect(fixture.controller.showInPageWidget(WIDGET_TAB_ID)).resolves.toBe(true);
    const replacementInit = vi.mocked(fixture.chrome.tabs.sendMessage).mock.calls
      .map((call) => parseInPageWidgetInitMessage(call[1]))
      .find((message): message is InPageWidgetInitMessage => message !== null);
    if (!replacementInit) throw new Error("replacement widget init was not sent");
    await expect(dispatchRuntime(
      fixture.controller,
      createInPageWidgetCommandEnvelope(replacementInit, {
        type: "ui-attach:widget-frame-scope-list",
      }),
      fixture.widgetSender,
    )).resolves.toMatchObject({ ok: true, data: { currentFrameId: 0 } });

    const restarted = createBackgroundController({
      chrome: fixture.chrome,
      store: fixture.store,
      ensureContentScript: fixture.ensureContentScript,
    });
    await expect(dispatchRuntime(
      restarted,
      createInPageWidgetCommandEnvelope(replacementInit, {
        type: "ui-attach:widget-frame-scope-list",
      }),
      fixture.widgetSender,
    )).resolves.toMatchObject({ ok: true, data: { currentFrameId: 0 } });
  });

  test("R4-PERSIST-01 preserves a newer independently remembered scope across old cleanup", async () => {
    const fixture = await createInPageWidgetFixture();
    let childFrameId = 3;
    let childDocumentId = "old-resumable-child";
    const childFrames = [{
      frameId: childFrameId,
      parentFrameId: 0,
      documentId: childDocumentId,
      url: `${OTHER_ORIGIN}/editor`,
    }];
    const frames = () => [{
      frameId: 0,
      parentFrameId: -1,
      documentId: WIDGET_TOP_DOCUMENT_ID,
      url: `${ORIGIN}/settings`,
    }, ...childFrames];
    fixture.chrome.webNavigation.getAllFrames = vi.fn(async () => frames());
    const originalGetFrame = fixture.chrome.webNavigation.getFrame;
    fixture.chrome.webNavigation.getFrame = vi.fn(async (details) => {
      const child = childFrames.find((frame) => frame.frameId === details.frameId);
      return details.tabId === WIDGET_TAB_ID && child ? child : originalGetFrame(details);
    });
    const oldScopePersisted = createDeferred<void>();
    const finishOldScopePersistence = createDeferred<void>();
    const newScopePersisted = createDeferred<void>();
    const originalSessionSet = fixture.chrome.storage.session.set;
    let deferredRemember = false;
    fixture.chrome.storage.session.set = vi.fn(async (values) => {
      await originalSessionSet(values);
      if (!deferredRemember && Object.hasOwn(values, FRAME_SCOPE_SESSION_KEY) &&
          Array.isArray(values[FRAME_SCOPE_SESSION_KEY]) &&
          values[FRAME_SCOPE_SESSION_KEY].length > 0) {
        deferredRemember = true;
        oldScopePersisted.resolve(undefined);
        await finishOldScopePersistence.promise;
      }
      if (deferredRemember && Object.hasOwn(values, FRAME_SCOPE_SESSION_KEY) &&
          Array.isArray(values[FRAME_SCOPE_SESSION_KEY]) &&
          values[FRAME_SCOPE_SESSION_KEY].some((scope) => isRecord(scope) &&
            isRecord(scope.target) && scope.target.documentId === "new-resumable-child")) {
        newScopePersisted.resolve(undefined);
      }
    });
    const oldFenceStarted = createDeferred<void>();
    const finishOldFence = createDeferred<void>();
    const originalLocalSet = fixture.chrome.storage.local.set;
    let oldFenceDeferred = false;
    fixture.chrome.storage.local.set = vi.fn(async (values) => {
      await originalLocalSet(values);
      if (!oldFenceDeferred && Object.hasOwn(values, FRAME_SCOPE_INVALIDATIONS_LOCAL_KEY) &&
          Array.isArray(values[FRAME_SCOPE_INVALIDATIONS_LOCAL_KEY]) &&
          values[FRAME_SCOPE_INVALIDATIONS_LOCAL_KEY].length > 0) {
        oldFenceDeferred = true;
        oldFenceStarted.resolve(undefined);
        await finishOldFence.promise;
      }
    });

    const oldSelection = dispatchRuntime(
      fixture.controller,
      createInPageWidgetCommandEnvelope(fixture.init, {
        type: "ui-attach:widget-frame-scope-select",
        frameId: childFrameId,
        documentId: childDocumentId,
        origin: OTHER_ORIGIN,
        pathname: "/editor",
        expectedGeneration: 0,
      }),
      fixture.widgetSender,
    );
    await oldScopePersisted.promise;
    await expect(dispatchRuntime(
      fixture.controller,
      createInPageWidgetCommandEnvelope(fixture.init, {
        type: "ui-attach:widget-surface-release",
      }),
      fixture.widgetSender,
    )).resolves.toEqual({ ok: true, data: null });
    vi.mocked(fixture.chrome.tabs.sendMessage).mockClear();
    await expect(fixture.controller.showInPageWidget(WIDGET_TAB_ID)).resolves.toBe(true);
    const replacementInit = vi.mocked(fixture.chrome.tabs.sendMessage).mock.calls
      .map((call) => parseInPageWidgetInitMessage(call[1]))
      .find((message): message is InPageWidgetInitMessage => message !== null);
    if (!replacementInit) throw new Error("replacement widget init was not sent");
    finishOldScopePersistence.resolve(undefined);
    await waitFor(() => oldFenceDeferred);
    childFrameId = 4;
    childDocumentId = "new-resumable-child";
    childFrames.push({
      frameId: childFrameId,
      parentFrameId: 0,
      documentId: childDocumentId,
      url: `${OTHER_ORIGIN}/editor`,
    });
    const newSelection = dispatchRuntime(
      fixture.controller,
      createInPageWidgetCommandEnvelope(replacementInit, {
        type: "ui-attach:widget-frame-scope-select",
        frameId: childFrameId,
        documentId: childDocumentId,
        origin: OTHER_ORIGIN,
        pathname: "/editor",
        expectedGeneration: 0,
      }),
      fixture.widgetSender,
    );

    await newScopePersisted.promise;
    finishOldFence.resolve(undefined);
    await oldFenceStarted.promise;
    await expect(newSelection).resolves.toEqual({ ok: true, data: { enabled: false } });
    await expect(oldSelection).resolves.toMatchObject({
      ok: false,
      code: "WIDGET_STATE_UNAVAILABLE",
    });
    await expect(dispatchRuntime(
      fixture.controller,
      createInPageWidgetCommandEnvelope(replacementInit, {
        type: "ui-attach:widget-frame-scope-list",
      }),
      fixture.widgetSender,
    )).resolves.toMatchObject({ ok: true, data: { currentFrameId: childFrameId } });
    const storedScopes = await fixture.chrome.storage.session.get(FRAME_SCOPE_SESSION_KEY);
    expect(storedScopes[FRAME_SCOPE_SESSION_KEY]).toMatchObject([{
      tabId: WIDGET_TAB_ID,
      target: { frameId: childFrameId, documentId: childDocumentId },
    }]);

    const restarted = createBackgroundController({
      chrome: fixture.chrome,
      store: fixture.store,
      ensureContentScript: fixture.ensureContentScript,
    });
    await expect(dispatchRuntime(
      restarted,
      createInPageWidgetCommandEnvelope(replacementInit, {
        type: "ui-attach:widget-frame-scope-list",
      }),
      fixture.widgetSender,
    )).resolves.toMatchObject({ ok: true, data: { currentFrameId: childFrameId } });
  });

  test("R4-SESSION-01 fences and retires a frame context cancelled by navigation", async () => {
    const fixture = await createInPageWidgetFixture();
    const childFrameId = 3;
    const childDocumentId = "cancelled-frame-context";
    const frames = [{
      frameId: 0,
      parentFrameId: -1,
      documentId: WIDGET_TOP_DOCUMENT_ID,
      url: `${ORIGIN}/settings`,
    }, {
      frameId: childFrameId,
      parentFrameId: 0,
      documentId: childDocumentId,
      url: `${OTHER_ORIGIN}/editor`,
    }];
    fixture.chrome.webNavigation.getAllFrames = vi.fn(async () => frames);
    const originalGetFrame = fixture.chrome.webNavigation.getFrame;
    fixture.chrome.webNavigation.getFrame = vi.fn(async (details) => (
      details.tabId === WIDGET_TAB_ID && details.frameId === childFrameId
        ? frames[1]
        : originalGetFrame(details)
    ));
    const transientContextPersisted = createDeferred<void>();
    const finishTransientPersistence = createDeferred<void>();
    const originalSessionSet = fixture.chrome.storage.session.set;
    let deferredTransientWrite = false;
    fixture.chrome.storage.session.set = vi.fn(async (values) => {
      await originalSessionSet(values);
      const snapshot = values[IN_PAGE_WIDGET_LEASE_STORAGE_KEY];
      const transientLease = isRecord(snapshot) && Array.isArray(snapshot.leases)
        ? snapshot.leases.find((lease) => isRecord(lease) &&
          isRecord(lease.frameContext) && lease.frameContext.documentId === childDocumentId)
        : undefined;
      if (!deferredTransientWrite && transientLease) {
        deferredTransientWrite = true;
        transientContextPersisted.resolve(undefined);
        await finishTransientPersistence.promise;
      }
    });

    const selection = dispatchRuntime(
      fixture.controller,
      createInPageWidgetCommandEnvelope(fixture.init, {
        type: "ui-attach:widget-frame-scope-select",
        frameId: childFrameId,
        documentId: childDocumentId,
        origin: OTHER_ORIGIN,
        pathname: "/editor",
        expectedGeneration: 0,
      }),
      fixture.widgetSender,
    );
    await transientContextPersisted.promise;
    const navigation = fixture.controller.handleNavigationCommitted({
      tabId: WIDGET_TAB_ID,
      frameId: 0,
      parentFrameId: -1,
      documentId: WIDGET_TOP_DOCUMENT_ID,
      url: `${ORIGIN}/settings`,
    });
    await flushMicrotasks();
    await flushMicrotasks();

    await expect(dispatchRuntime(
      fixture.controller,
      createInPageWidgetCommandEnvelope(fixture.init, {
        type: "ui-attach:widget-session-read",
      }),
      fixture.widgetSender,
    )).resolves.toMatchObject({ ok: false, code: "ACTIVE_PAGE_UNAVAILABLE" });

    finishTransientPersistence.resolve(undefined);
    await expect(selection).resolves.toMatchObject({
      ok: false,
      code: "WIDGET_STATE_UNAVAILABLE",
    });
    await expect(navigation).resolves.toBeUndefined();
    await expect(dispatchRuntime(
      fixture.controller,
      createInPageWidgetCommandEnvelope(fixture.init, {
        type: "ui-attach:widget-session-read",
      }),
      fixture.widgetSender,
    )).resolves.toMatchObject({
      ok: true,
      data: { origin: ORIGIN, activePage: { frameId: 0, documentId: WIDGET_TOP_DOCUMENT_ID } },
    });
    const persisted = await fixture.chrome.storage.session.get(IN_PAGE_WIDGET_LEASE_STORAGE_KEY);
    expect(persisted[IN_PAGE_WIDGET_LEASE_STORAGE_KEY]).toMatchObject({
      leases: [{ surfaceId: fixture.init.surfaceId, frameContext: null }],
    });

    const restarted = createBackgroundController({
      chrome: fixture.chrome,
      store: fixture.store,
      ensureContentScript: fixture.ensureContentScript,
    });
    await expect(dispatchRuntime(
      restarted,
      createInPageWidgetRegistration(fixture.init),
      fixture.widgetSender,
    )).resolves.toEqual({ ok: true, data: { registered: true } });
    await expect(dispatchRuntime(
      restarted,
      createInPageWidgetCommandEnvelope(fixture.init, {
        type: "ui-attach:widget-session-read",
      }),
      fixture.widgetSender,
    )).resolves.toMatchObject({
      ok: true,
      data: { origin: ORIGIN, activePage: { frameId: 0, documentId: WIDGET_TOP_DOCUMENT_ID } },
    });
  });

  test("R4-PERSIST-02 poisons stale frame context when compensation and revoke both fail", async () => {
    const fixture = await createInPageWidgetFixture();
    const childFrameId = 3;
    const childDocumentId = "poisoned-frame-context";
    const frames = [{
      frameId: 0,
      parentFrameId: -1,
      documentId: WIDGET_TOP_DOCUMENT_ID,
      url: `${ORIGIN}/settings`,
    }, {
      frameId: childFrameId,
      parentFrameId: 0,
      documentId: childDocumentId,
      url: `${OTHER_ORIGIN}/editor`,
    }];
    fixture.chrome.webNavigation.getAllFrames = vi.fn(async () => frames);
    const originalGetFrame = fixture.chrome.webNavigation.getFrame;
    fixture.chrome.webNavigation.getFrame = vi.fn(async (details) => (
      details.tabId === WIDGET_TAB_ID && details.frameId === childFrameId
        ? frames[1]
        : originalGetFrame(details)
    ));
    const transientContextPersisted = createDeferred<void>();
    const finishTransientPersistence = createDeferred<void>();
    const originalSessionSet = fixture.chrome.storage.session.set;
    const originalSessionRemove = fixture.chrome.storage.session.remove;
    let transientDeferred = false;
    let failAfterTransient = false;
    let compensationWriteFailures = 0;
    let revokeFailures = 0;
    fixture.chrome.storage.session.set = vi.fn(async (values) => {
      const snapshot = values[IN_PAGE_WIDGET_LEASE_STORAGE_KEY];
      const transientLease = isRecord(snapshot) && Array.isArray(snapshot.leases)
        ? snapshot.leases.find((lease) => isRecord(lease) &&
          isRecord(lease.frameContext) && lease.frameContext.documentId === childDocumentId)
        : undefined;
      if (!transientDeferred && transientLease) {
        transientDeferred = true;
        await originalSessionSet(values);
        transientContextPersisted.resolve(undefined);
        await finishTransientPersistence.promise;
        return;
      }
      if (failAfterTransient && Object.hasOwn(values, IN_PAGE_WIDGET_LEASE_STORAGE_KEY)) {
        compensationWriteFailures += 1;
        throw new Error("injected context compensation write failure");
      }
      await originalSessionSet(values);
    });
    fixture.chrome.storage.session.remove = vi.fn(async (keys) => {
      const requested = Array.isArray(keys) ? keys : [keys];
      if (failAfterTransient && requested.includes(IN_PAGE_WIDGET_LEASE_STORAGE_KEY)) {
        revokeFailures += 1;
        throw new Error("injected lease revoke failure");
      }
      await originalSessionRemove(keys);
    });

    const selection = dispatchRuntime(
      fixture.controller,
      createInPageWidgetCommandEnvelope(fixture.init, {
        type: "ui-attach:widget-frame-scope-select",
        frameId: childFrameId,
        documentId: childDocumentId,
        origin: OTHER_ORIGIN,
        pathname: "/editor",
        expectedGeneration: 0,
      }),
      fixture.widgetSender,
    );
    await transientContextPersisted.promise;
    failAfterTransient = true;
    const navigation = fixture.controller.handleNavigationCommitted({
      tabId: WIDGET_TAB_ID,
      frameId: 0,
      parentFrameId: -1,
      documentId: WIDGET_TOP_DOCUMENT_ID,
      url: `${ORIGIN}/settings`,
    });
    await flushMicrotasks();
    await flushMicrotasks();
    finishTransientPersistence.resolve(undefined);

    await expect(selection).resolves.toMatchObject({
      ok: false,
      code: "WIDGET_STATE_UNAVAILABLE",
    });
    await expect(navigation).resolves.toBeUndefined();
    expect(compensationWriteFailures).toBeGreaterThanOrEqual(1);
    expect(revokeFailures).toBeGreaterThanOrEqual(1);
    const stalePersisted = await fixture.chrome.storage.session.get(
      IN_PAGE_WIDGET_LEASE_STORAGE_KEY,
    );
    expect(stalePersisted[IN_PAGE_WIDGET_LEASE_STORAGE_KEY]).toMatchObject({
      leases: [{
        surfaceId: fixture.init.surfaceId,
        frameContext: { frameId: childFrameId, documentId: childDocumentId },
      }],
    });
    const durableFence = await fixture.chrome.storage.local.get(
      IN_PAGE_WIDGET_LEASE_INVALIDATIONS_LOCAL_KEY,
    );
    expect(durableFence[IN_PAGE_WIDGET_LEASE_INVALIDATIONS_LOCAL_KEY]).toMatchObject([{
      tabId: WIDGET_TAB_ID,
      surfaceId: fixture.init.surfaceId,
    }]);

    const restarted = createBackgroundController({
      chrome: fixture.chrome,
      store: fixture.store,
      ensureContentScript: fixture.ensureContentScript,
    });
    await expect(dispatchRuntime(
      restarted,
      createInPageWidgetRegistration(fixture.init),
      fixture.widgetSender,
    )).resolves.toMatchObject({ ok: false, code: "UNTRUSTED_SENDER" });

    fixture.chrome.storage.session.set = originalSessionSet;
    fixture.chrome.storage.session.remove = originalSessionRemove;
    vi.mocked(fixture.chrome.tabs.sendMessage).mockClear();
    await expect(fixture.controller.showInPageWidget(WIDGET_TAB_ID)).resolves.toBe(true);
    const replacementInit = vi.mocked(fixture.chrome.tabs.sendMessage).mock.calls
      .map((call) => parseInPageWidgetInitMessage(call[1]))
      .find((message): message is InPageWidgetInitMessage => message !== null);
    if (!replacementInit) throw new Error("replacement widget init was not sent");
    const replacementPersisted = await fixture.chrome.storage.session.get(
      IN_PAGE_WIDGET_LEASE_STORAGE_KEY,
    );
    expect(replacementPersisted[IN_PAGE_WIDGET_LEASE_STORAGE_KEY]).toMatchObject({
      leases: [{
        surfaceId: replacementInit.surfaceId,
        frameContext: null,
      }],
    });
    expect(replacementPersisted[IN_PAGE_WIDGET_LEASE_STORAGE_KEY]).not.toMatchObject({
      leases: [{ surfaceId: fixture.init.surfaceId }],
    });
    const clearedFence = await fixture.chrome.storage.local.get(
      IN_PAGE_WIDGET_LEASE_INVALIDATIONS_LOCAL_KEY,
    );
    expect(clearedFence[IN_PAGE_WIDGET_LEASE_INVALIDATIONS_LOCAL_KEY] ?? []).toEqual([]);
    const restartedReplacement = createBackgroundController({
      chrome: fixture.chrome,
      store: fixture.store,
      ensureContentScript: fixture.ensureContentScript,
    });
    await expect(dispatchRuntime(
      restartedReplacement,
      createInPageWidgetRegistration(replacementInit),
      fixture.widgetSender,
    )).resolves.toEqual({ ok: true, data: { registered: true } });
  });

  test("fails closed when a pending head arrives during the session store read", async () => {
    const fixture = await createInPageWidgetFixture();
    const staleReadStarted = createDeferred<void>();
    const staleRead = createDeferred<{ ok: true; value: ActiveSessionReadback }>();
    const liveRecord = createCaptureRecord("save", "Live save");
    liveRecord.origin = ORIGIN;
    liveRecord.pageUrl = `${ORIGIN}/settings`;
    liveRecord.tabId = WIDGET_TAB_ID;
    liveRecord.frameId = 0;
    const staleRecord = { ...liveRecord, intent: { taskNote: "stale session" } };
    let readCount = 0;
    fixture.store.read = vi.fn(async () => {
      readCount += 1;
      if (readCount === 2) {
        staleReadStarted.resolve(undefined);
        return staleRead.promise;
      }
      return { ok: true as const, value: createSessionReadback(liveRecord) };
    });

    const session = dispatchRuntime(
      fixture.controller,
      createInPageWidgetCommandEnvelope(fixture.init, {
        type: "ui-attach:widget-session-read",
      }),
      fixture.widgetSender,
    );
    await staleReadStarted.promise;
    await expect(dispatchRuntime(fixture.controller, {
      type: UI_ATTACH_OVERLAY_ACTION_REQUEST,
      action: "more",
      itemId: fixture.itemId,
      projection: WIDGET_OVERLAY_PROJECTION,
    }, createInPageWidgetContentSender())).resolves.toEqual({ ok: true, data: null });
    staleRead.resolve({ ok: true, value: createSessionReadback(staleRecord) });

    await expect(session).resolves.toMatchObject({
      ok: false,
      code: "ACTIVE_PAGE_UNAVAILABLE",
    });
  });

  test("fails a session read whose surface is released during the store read", async () => {
    const fixture = await createInPageWidgetFixture();
    const readStarted = createDeferred<void>();
    const delayedRead = createDeferred<{ ok: true; value: ActiveSessionReadback }>();
    const current = await fixture.store.read(ORIGIN);
    if (!current.ok) throw new Error("fixture session missing");
    let readCount = 0;
    fixture.store.read = vi.fn(async () => {
      readCount += 1;
      if (readCount === 2) {
        readStarted.resolve(undefined);
        return delayedRead.promise;
      }
      return current;
    });

    const session = dispatchRuntime(
      fixture.controller,
      createInPageWidgetCommandEnvelope(fixture.init, {
        type: "ui-attach:widget-session-read",
      }),
      fixture.widgetSender,
    );
    await readStarted.promise;
    await expect(dispatchRuntime(
      fixture.controller,
      createInPageWidgetCommandEnvelope(fixture.init, {
        type: "ui-attach:widget-surface-release",
      }),
      fixture.widgetSender,
    )).resolves.toEqual({ ok: true, data: null });
    delayedRead.resolve(current);

    await expect(session).resolves.toMatchObject({
      ok: false,
      code: "ACTIVE_PAGE_UNAVAILABLE",
    });
    await expect(dispatchRuntime(
      fixture.controller,
      createInPageWidgetRegistration(fixture.init),
      fixture.widgetSender,
    )).resolves.toMatchObject({ ok: false, code: "UNTRUSTED_SENDER" });
  });

  test("hides markers after disconnect grace while preserving a repairable widget lease", async () => {
    const fixture = await createInPageWidgetFixture();
    const lifecycle = await connectInPageWidgetLifecycle(fixture);
    const disconnectListener = vi.mocked(lifecycle.disconnectEvent.addListener).mock.calls[0]?.[0] as
      | (() => void)
      | undefined;
    vi.useFakeTimers();
    try {
      disconnectListener?.();
      await vi.advanceTimersByTimeAsync(6_001);

      await expect(dispatchRuntime(
        fixture.controller,
        { type: UI_ATTACH_OVERLAY_VISIBILITY_GET },
        createInPageWidgetContentSender(),
      )).resolves.toEqual({ ok: true, data: { visible: false } });

      const replacementDocumentId = "widget-document-after-grace";
      fixture.frameState.widgetDocumentId = replacementDocumentId;
      await expect(dispatchRuntime(
        fixture.controller,
        createInPageWidgetRegistration(fixture.init),
        { ...fixture.widgetSender, documentId: replacementDocumentId },
      )).resolves.toEqual({ ok: true, data: { registered: true } });
    } finally {
      vi.useRealTimers();
    }
  });

  test("restores a digest-bound widget lease after Service Worker recreation", async () => {
    const fixture = await createInPageWidgetFixture();
    const recreated = createBackgroundController({
      chrome: fixture.chrome,
      store: fixture.store,
      ensureContentScript: fixture.ensureContentScript,
    });

    await expect(dispatchRuntime(
      recreated,
      createInPageWidgetRegistration(fixture.init),
      fixture.widgetSender,
    )).resolves.toEqual({ ok: true, data: { registered: true } });
    await expect(dispatchRuntime(
      recreated,
      {
        ...createInPageWidgetRegistration(fixture.init),
        capability: "B".repeat(43),
      },
      fixture.widgetSender,
    )).resolves.toMatchObject({ ok: false, code: "UNTRUSTED_SENDER" });
  });

  test("rebinds a same-document widget and revokes it for a full navigation", async () => {
    const fixture = await createInPageWidgetFixture();
    const lifecycle = await connectInPageWidgetLifecycle(fixture);
    fixture.chrome.tabs.sendMessage = vi.fn(async (_tabId, message) => (
      isRecord(message) && (
        message.type === UI_ATTACH_IN_PAGE_WIDGET_ENSURE ||
        message.type === UI_ATTACH_IN_PAGE_WIDGET_INIT
      ) ? { ok: true, data: null } : undefined
    ));

    await fixture.controller.handleNavigationCommitted({
      tabId: WIDGET_TAB_ID,
      frameId: 0,
      parentFrameId: -1,
      documentId: WIDGET_TOP_DOCUMENT_ID,
      url: `${ORIGIN}/next`,
    });
    expect(lifecycle.port.disconnect).not.toHaveBeenCalled();
    expect(fixture.chrome.tabs.sendMessage).not.toHaveBeenCalled();

    fixture.frameState.topDocumentId = "next-document";
    await fixture.controller.handleNavigationCommitted({
      tabId: WIDGET_TAB_ID,
      frameId: 0,
      parentFrameId: -1,
      documentId: "next-document",
      url: `${ORIGIN}/full-next`,
    });
    vi.mocked(fixture.chrome.tabs.sendMessage).mockClear();
    await fixture.controller.handleTabUpdated(
      WIDGET_TAB_ID,
      { status: "complete" },
      { id: WIDGET_TAB_ID, windowId: WIDGET_WINDOW_ID, url: `${ORIGIN}/full-next` },
    );
    expect(lifecycle.port.disconnect).toHaveBeenCalledOnce();
    expect(fixture.chrome.tabs.sendMessage).not.toHaveBeenCalledWith(
      WIDGET_TAB_ID,
      expect.objectContaining({ type: UI_ATTACH_IN_PAGE_WIDGET_INIT }),
      expect.anything(),
    );
  });

  test("wakes the widget after a same-document route rebind so it reads the new empty scope", async () => {
    const fixture = await createInPageWidgetFixture();
    const originalGetFrame = fixture.chrome.webNavigation.getFrame;
    const originalGetAllFrames = fixture.chrome.webNavigation.getAllFrames;
    let topPathname = "/settings";
    fixture.chrome.webNavigation.getFrame = vi.fn(async (details) => {
      const frame = await originalGetFrame(details);
      return frame && details.tabId === WIDGET_TAB_ID && details.frameId === 0
        ? { ...frame, url: `${ORIGIN}${topPathname}` }
        : frame;
    });
    fixture.chrome.webNavigation.getAllFrames = vi.fn(async (details) => {
      const frames = await originalGetAllFrames(details);
      return frames?.map((frame) => frame.frameId === 0
        ? { ...frame, url: `${ORIGIN}${topPathname}` }
        : frame);
    });
    fixture.chrome.runtime.sentMessages.length = 0;

    await expect(dispatchRuntime(fixture.controller, {
      type: "ui-attach:overlays-sync",
      origin: ORIGIN,
      activeItemId: fixture.itemId,
    }, createExtensionSender())).resolves.toMatchObject({ ok: true });
    expect((await fixture.chrome.storage.session.get(OVERLAY_ACTIVE_ITEMS_SESSION_KEY))[
      OVERLAY_ACTIVE_ITEMS_SESSION_KEY
    ]).toEqual([{ origin: ORIGIN, itemId: fixture.itemId }]);

    topPathname = "/next";
    await fixture.controller.handleNavigationCommitted({
      tabId: WIDGET_TAB_ID,
      frameId: 0,
      parentFrameId: -1,
      documentId: WIDGET_TOP_DOCUMENT_ID,
      url: `${ORIGIN}${topPathname}`,
    }, false);

    const routeBSession = await dispatchRuntime(
      fixture.controller,
      createInPageWidgetCommandEnvelope(fixture.init, {
        type: "ui-attach:widget-session-read",
      }),
      fixture.widgetSender,
    );
    expect(routeBSession).toMatchObject({
      ok: true,
      data: {
        activePage: { pathname: "/next" },
        currentItemIds: [],
      },
    });
    expect(routeBSession).not.toMatchObject({
      data: { selectedItemId: expect.any(String) },
    });
    expect((await fixture.chrome.storage.session.get(OVERLAY_PROJECTIONS_SESSION_KEY))[
      OVERLAY_PROJECTIONS_SESSION_KEY
    ]).toMatchObject({ records: [] });
    expect(fixture.chrome.runtime.sentMessages.filter((message) => (
      message.type === UI_ATTACH_OVERLAY_PROJECTION_UPDATED
    ))).toEqual([{ type: UI_ATTACH_OVERLAY_PROJECTION_UPDATED }]);
  });

  test("keeps post-write route-A capture state out of the route-B widget and Agent publisher", async () => {
    const afterWriteEntered = createDeferred<void>();
    const releaseAfterWrite = createDeferred<void>();
    const rawStates: ActiveSessionCommandData[] = [];
    const publishedStates: Array<{ route: string; attachmentCount: number }> = [];
    let clearCount = 0;
    const publisher = createLocalAgentBridgeSessionPublisher({
      publishSessionContext: vi.fn(async (input) => {
        publishedStates.push({
          route: input.page.route,
          attachmentCount: input.attachmentCount,
        });
        return true;
      }),
      clearSessionContext: vi.fn(async () => {
        clearCount += 1;
      }),
    });
    const fixture = await createInPageWidgetFixture({
      captureCommitGate: {
        beforeWrite: async () => undefined,
        afterWrite: async () => {
          afterWriteEntered.resolve(undefined);
          await releaseAfterWrite.promise;
        },
      },
      onActiveSessionChanged: async (data) => {
        rawStates.push(structuredClone(data));
        await publisher.reconcile(data);
      },
    });
    const originalGetFrame = fixture.chrome.webNavigation.getFrame;
    const originalGetAllFrames = fixture.chrome.webNavigation.getAllFrames;
    let topPathname = "/settings";
    fixture.chrome.webNavigation.getFrame = vi.fn(async (details) => {
      const frame = await originalGetFrame(details);
      return frame && details.tabId === WIDGET_TAB_ID && details.frameId === 0
        ? { ...frame, url: `${ORIGIN}${topPathname}` }
        : frame;
    });
    fixture.chrome.webNavigation.getAllFrames = vi.fn(async (details) => {
      const frames = await originalGetAllFrames(details);
      return frames?.map((frame) => frame.frameId === 0
        ? { ...frame, url: `${ORIGIN}${topPathname}` }
        : frame);
    });
    const route: TopFrameRuntimeCaptureRoute = {
      tabId: WIDGET_TAB_ID,
      documentId: WIDGET_TOP_DOCUMENT_ID,
      url: `${ORIGIN}/settings`,
    };
    await activateTopFrameRuntimeCaptureRoute(fixture.controller, route);
    const sender = createTopFrameRuntimeCaptureSender(route);
    const begun = await dispatchRuntime(fixture.controller, {
      type: "ui-attach:session-begin-capture",
      replaceItemId: null,
    }, sender);
    if (!begun.ok) throw new Error(`capture begin failed: ${begun.code}`);
    const record = createCaptureRecord("widget-post-write", "Widget post-write target");
    record.pageUrl = route.url;
    record.attachment.source.url = route.url;
    rawStates.length = 0;
    publishedStates.length = 0;
    clearCount = 0;

    const commit = dispatchRuntime(fixture.controller, {
      type: "ui-attach:session-commit-capture",
      token: begun.data as RuntimeCaptureToken,
      record,
    }, sender);
    await afterWriteEntered.promise;
    topPathname = "/next";
    route.url = `${ORIGIN}${topPathname}`;
    releaseAfterWrite.resolve(undefined);

    await expect(commit).resolves.toMatchObject({
      ok: true,
      data: { itemId: record.attachment.id },
    });
    expect(rawStates).toEqual([]);
    expect(publishedStates).toEqual([]);

    await fixture.controller.handleNavigationCommitted({
      tabId: WIDGET_TAB_ID,
      frameId: 0,
      parentFrameId: -1,
      documentId: WIDGET_TOP_DOCUMENT_ID,
      url: route.url,
    }, false);
    const routeBStates = rawStates.filter((state) => state.activePage?.pathname === "/next");
    expect(routeBStates.length).toBeGreaterThan(0);
    expect(routeBStates.every((state) => (
      state.currentItemIds?.length === 0 && state.selectedItemId === undefined
    ))).toBe(true);
    expect(publishedStates.some((state) => (
      state.route === `${ORIGIN}/settings` && state.attachmentCount > 0
    ))).toBe(false);
    expect(clearCount).toBeGreaterThan(0);
  });

  test("retries a transient old top route for a bound widget read after History rebind", async () => {
    const fixture = await createInPageWidgetFixture();
    const originalGetFrame = fixture.chrome.webNavigation.getFrame;
    const originalGetAllFrames = fixture.chrome.webNavigation.getAllFrames;
    let topPathname = "/settings";
    fixture.chrome.webNavigation.getFrame = vi.fn(async (details) => {
      const frame = await originalGetFrame(details);
      return frame && details.tabId === WIDGET_TAB_ID && details.frameId === 0
        ? { ...frame, url: `${ORIGIN}${topPathname}` }
        : frame;
    });
    fixture.chrome.webNavigation.getAllFrames = vi.fn(async (details) => {
      const frames = await originalGetAllFrames(details);
      return frames?.map((frame) => frame.frameId === 0
        ? { ...frame, url: `${ORIGIN}${topPathname}` }
        : frame);
    });
    topPathname = "/next";
    await fixture.controller.handleNavigationCommitted({
      tabId: WIDGET_TAB_ID,
      frameId: 0,
      parentFrameId: -1,
      documentId: WIDGET_TOP_DOCUMENT_ID,
      url: `${ORIGIN}${topPathname}`,
    }, false);

    const liveGetFrame = fixture.chrome.webNavigation.getFrame;
    let staleRouteObserved = false;
    fixture.chrome.webNavigation.getFrame = vi.fn(async (details) => {
      const frame = await liveGetFrame(details);
      if (frame && details.frameId === 0 && !staleRouteObserved) {
        staleRouteObserved = true;
        return { ...frame, url: `${ORIGIN}/settings` };
      }
      return frame;
    });

    await expect(dispatchRuntime(
      fixture.controller,
      createInPageWidgetCommandEnvelope(fixture.init, {
        type: "ui-attach:widget-session-read",
      }),
      fixture.widgetSender,
    )).resolves.toMatchObject({
      ok: true,
      data: {
        activePage: { pathname: "/next" },
        currentItemIds: [],
      },
    });
    expect(staleRouteObserved).toBe(true);
  });

  test("C4 projects the same journal-only authoritative pair into widget active", async () => {
    const fixture = await createInPageWidgetFixture();
    await fixture.chrome.storage.local.set({
      [CLEAR_PROJECTION_JOURNAL_STORAGE_KEY]: clearProjectionJournal(
        boundClearProjectionOperation("clear-c4-widget-status", WIDGET_TOP_DOCUMENT_ID),
      ),
    });

    await expect(dispatchRuntime(
      fixture.controller,
      createInPageWidgetCommandEnvelope(fixture.init, {
        type: "ui-attach:widget-session-read",
      }),
      fixture.widgetSender,
    )).resolves.toMatchObject({
      ok: true,
      data: {
        readback: {
          clearPending: true,
          activeClearOperationId: "clear-c4-widget-status",
        },
      },
    });
  });

  test("reconciles an existing selection after widget invitation and refresh transitions", async () => {
    const localAgentBridge = createLocalAgentBridgeHarness();
    const onActiveSessionChanged = vi.fn(async () => undefined);
    const fixture = await createInPageWidgetFixture({
      localAgentBridge,
      onActiveSessionChanged,
    });

    await expect(dispatchRuntime(
      fixture.controller,
      createInPageWidgetCommandEnvelope(fixture.init, {
        type: "ui-attach:widget-bridge-create-invitation",
      }),
      fixture.widgetSender,
    )).resolves.toMatchObject({ ok: true, data: { pending: true } });
    expect(onActiveSessionChanged).toHaveBeenCalledTimes(1);
    expect(onActiveSessionChanged).toHaveBeenLastCalledWith(expect.objectContaining({
      enabled: true,
      origin: ORIGIN,
      currentItemIds: [fixture.itemId],
    }));

    vi.mocked(localAgentBridge.refreshConnection).mockResolvedValueOnce({
      connected: true,
      instanceId: "instance-1",
      pending: false,
      approvalMode: "browser_session",
      requestText: null,
      expiresAt: null,
      sharedTargetCount: null,
      sharedSequence: null,
    });
    vi.mocked(localAgentBridge.readStatus).mockResolvedValueOnce({
      connected: true,
      instanceId: "instance-1",
      pending: false,
      approvalMode: null,
      requestText: null,
      expiresAt: null,
      sharedTargetCount: 1,
      sharedSequence: 1,
    });
    await expect(dispatchRuntime(
      fixture.controller,
      createInPageWidgetCommandEnvelope(fixture.init, {
        type: "ui-attach:widget-bridge-refresh",
      }),
      fixture.widgetSender,
    )).resolves.toMatchObject({
      ok: true,
      data: { connected: true, sharedTargetCount: 1, sharedSequence: 1 },
    });
    expect(onActiveSessionChanged).toHaveBeenCalledTimes(2);
  });

  test("finishes terminal navigation with cleared Agent context after an in-flight ACK publish", async () => {
    const publishStarted = createDeferred<void>();
    const finishPublish = createDeferred<void>();
    const events: string[] = [];
    let deferNextPublish = false;
    const publisher = createLocalAgentBridgeSessionPublisher({
      publishSessionContext: vi.fn(async (input) => {
        events.push(`publish:${input.page.route}:${input.attachmentCount}`);
        if (deferNextPublish) {
          deferNextPublish = false;
          publishStarted.resolve(undefined);
          await finishPublish.promise;
        }
        return true;
      }),
      clearSessionContext: vi.fn(async () => {
        events.push("clear");
      }),
    });
    const fixture = await createInPageWidgetFixture({
      onActiveSessionChanged: (data) => publisher.reconcile(data),
    });
    const sender = createInPageWidgetContentSender();
    const restored = await dispatchRuntime(fixture.controller, {
      type: "ui-attach:overlays-restore-get",
    }, sender);
    if (!isOverlayRestoreResponse(restored)) throw new Error("overlay projection restore failed");
    deferNextPublish = true;
    const ack = dispatchRuntime(fixture.controller, {
      type: UI_ATTACH_OVERLAY_PROJECTION_ACK,
      projection: {
        version: restored.data.projection.version,
        projectionId: restored.data.projection.projectionId,
        revision: restored.data.projection.revision,
      },
    }, sender);
    await publishStarted.promise;

    const navigation = fixture.controller.handleNavigationCommitted({
      tabId: WIDGET_TAB_ID,
      frameId: 0,
      parentFrameId: -1,
      documentId: "replacement-document",
      url: `${ORIGIN}/replacement`,
    });
    finishPublish.resolve(undefined);
    await Promise.all([ack, navigation]);

    expect(events[0]).toBe(`publish:${ORIGIN}/settings:1`);
    expect(events.at(-1)).toBe("clear");
  });

  test("does not leave the old route published across same-document widget navigation", async () => {
    const publishStarted = createDeferred<void>();
    const finishPublish = createDeferred<void>();
    const events: string[] = [];
    let deferNextPublish = false;
    const publisher = createLocalAgentBridgeSessionPublisher({
      publishSessionContext: vi.fn(async (input) => {
        events.push(`publish:${input.page.route}:${input.attachmentCount}`);
        if (deferNextPublish) {
          deferNextPublish = false;
          publishStarted.resolve(undefined);
          await finishPublish.promise;
        }
        return true;
      }),
      clearSessionContext: vi.fn(async () => {
        events.push("clear");
      }),
    });
    const fixture = await createInPageWidgetFixture({
      onActiveSessionChanged: (data) => publisher.reconcile(data),
    });
    const originalGetFrame = fixture.chrome.webNavigation.getFrame;
    let topPathname = "/settings";
    fixture.chrome.webNavigation.getFrame = vi.fn(async (details) => {
      const frame = await originalGetFrame(details);
      return frame && details.tabId === WIDGET_TAB_ID && details.frameId === 0
        ? { ...frame, url: `${ORIGIN}${topPathname}` }
        : frame;
    });
    const sender = createInPageWidgetContentSender();
    const restored = await dispatchRuntime(fixture.controller, {
      type: "ui-attach:overlays-restore-get",
    }, sender);
    if (!isOverlayRestoreResponse(restored)) throw new Error("overlay projection restore failed");
    deferNextPublish = true;
    const ack = dispatchRuntime(fixture.controller, {
      type: UI_ATTACH_OVERLAY_PROJECTION_ACK,
      projection: {
        version: restored.data.projection.version,
        projectionId: restored.data.projection.projectionId,
        revision: restored.data.projection.revision,
      },
    }, sender);
    await publishStarted.promise;

    topPathname = "/same-document-next";
    const navigation = fixture.controller.handleNavigationCommitted({
      tabId: WIDGET_TAB_ID,
      frameId: 0,
      parentFrameId: -1,
      documentId: WIDGET_TOP_DOCUMENT_ID,
      url: `${ORIGIN}${topPathname}`,
    }, false);
    finishPublish.resolve(undefined);
    await Promise.all([ack, navigation]);

    expect(events[0]).toBe(`publish:${ORIGIN}/settings:1`);
    expect(events.slice(1)).toContain("clear");
    expect(events.at(-1)).not.toBe(`publish:${ORIGIN}/settings:1`);
  });

  test("does not leave a selected child endpoint published when that frame navigates", async () => {
    const publishStarted = createDeferred<void>();
    const finishPublish = createDeferred<void>();
    const events: string[] = [];
    let deferNextPublish = false;
    const publisher = createLocalAgentBridgeSessionPublisher({
      publishSessionContext: vi.fn(async (input) => {
        events.push(`publish:${input.page.route}:${input.attachmentCount}`);
        if (deferNextPublish) {
          deferNextPublish = false;
          publishStarted.resolve(undefined);
          await finishPublish.promise;
        }
        return true;
      }),
      clearSessionContext: vi.fn(async () => {
        events.push("clear");
      }),
    });
    const fixture = await createInPageWidgetFixture({
      onActiveSessionChanged: (data) => publisher.reconcile(data),
    });
    const childRecord = createCaptureRecord("save", "Selected child target");
    childRecord.origin = OTHER_ORIGIN;
    childRecord.pageUrl = `${OTHER_ORIGIN}/editor`;
    childRecord.tabId = WIDGET_TAB_ID;
    childRecord.frameId = 3;
    childRecord.routeChain = [
      { origin: ORIGIN, pathname: "/settings" },
      { origin: OTHER_ORIGIN, pathname: "/editor" },
    ];
    const childReadback = createSessionReadback(childRecord);
    const emptyTopReadback: ActiveSessionReadback = {
      origin: ORIGIN,
      epoch: null,
      clearPending: false,
      activeClearOperationId: null,
      file: null,
      legacyRecord: null,
    };
    fixture.store.read = vi.fn(async (origin) => ({
      ok: true,
      value: origin === OTHER_ORIGIN ? childReadback : emptyTopReadback,
    }));
    const originalGetFrame = fixture.chrome.webNavigation.getFrame;
    let childDocumentId = "selected-child-document";
    let childPathname = "/editor";
    fixture.chrome.webNavigation.getFrame = vi.fn(async (details) => {
      if (details.tabId === WIDGET_TAB_ID && details.frameId === 5) {
        return {
          frameId: 5,
          parentFrameId: 0,
          documentId: childDocumentId,
          url: `${OTHER_ORIGIN}${childPathname}`,
        };
      }
      return originalGetFrame(details);
    });
    fixture.chrome.webNavigation.getAllFrames = vi.fn(async ({ tabId }) => tabId === WIDGET_TAB_ID
      ? [{
          frameId: 0,
          parentFrameId: -1,
          documentId: WIDGET_TOP_DOCUMENT_ID,
          url: `${ORIGIN}/settings`,
        }, {
          frameId: 5,
          parentFrameId: 0,
          documentId: childDocumentId,
          url: `${OTHER_ORIGIN}${childPathname}`,
        }]
      : []);
    await expect(dispatchRuntime(
      fixture.controller,
      createInPageWidgetCommandEnvelope(fixture.init, {
        type: "ui-attach:widget-frame-scope-select",
        frameId: 5,
        documentId: childDocumentId,
        origin: OTHER_ORIGIN,
        pathname: childPathname,
        expectedGeneration: 0,
      }),
      fixture.widgetSender,
    )).resolves.toEqual({ ok: true, data: { enabled: false } });
    await expect(dispatchRuntime(
      fixture.controller,
      createInPageWidgetCommandEnvelope(fixture.init, {
        type: "ui-attach:widget-session-read",
      }),
      fixture.widgetSender,
    )).resolves.toMatchObject({
      ok: true,
      data: {
        origin: OTHER_ORIGIN,
        activePage: {
          frameId: 5,
          documentId: childDocumentId,
        },
      },
    });
    const childSender: UiAttachChromeMessageSender = {
      ...createInPageWidgetContentSender(),
      origin: OTHER_ORIGIN,
      url: `${OTHER_ORIGIN}${childPathname}`,
      frameId: 5,
      documentId: childDocumentId,
    };
    const restored = await dispatchRuntime(fixture.controller, {
      type: "ui-attach:overlays-restore-get",
    }, childSender);
    if (!isOverlayRestoreResponse(restored)) throw new Error("child overlay restore failed");
    events.length = 0;
    deferNextPublish = true;
    const ack = dispatchRuntime(fixture.controller, {
      type: UI_ATTACH_OVERLAY_PROJECTION_ACK,
      projection: {
        version: restored.data.projection.version,
        projectionId: restored.data.projection.projectionId,
        revision: restored.data.projection.revision,
      },
    }, childSender);
    await publishStarted.promise;

    childDocumentId = "replacement-child-document";
    childPathname = "/replacement-editor";
    const navigation = fixture.controller.handleNavigationCommitted({
      tabId: WIDGET_TAB_ID,
      frameId: 5,
      parentFrameId: 0,
      documentId: childDocumentId,
      url: `${OTHER_ORIGIN}${childPathname}`,
    });
    finishPublish.resolve(undefined);
    await Promise.all([ack, navigation]);

    expect(events[0]).toBe(`publish:${OTHER_ORIGIN}/editor:0`);
    expect(events.slice(1)).toContain("clear");
    expect(events.at(-1)).not.toBe(`publish:${OTHER_ORIGIN}/editor:0`);
  });

  test("publishes the selected page context when an existing widget is explicitly refreshed", async () => {
    const onActiveSessionChanged = vi.fn(async () => undefined);
    const fixture = await createInPageWidgetFixture({ onActiveSessionChanged });
    onActiveSessionChanged.mockClear();

    await expect(fixture.controller.showInPageWidget(WIDGET_TAB_ID)).resolves.toBe(true);
    await fixture.controller.refreshInPageWidgetContext(WIDGET_TAB_ID);

    expect(onActiveSessionChanged).toHaveBeenCalledOnce();
    expect(onActiveSessionChanged).toHaveBeenCalledWith(expect.objectContaining({
      enabled: true,
      activePage: expect.objectContaining({
        tabId: WIDGET_TAB_ID,
        frameId: 0,
        documentId: WIDGET_TOP_DOCUMENT_ID,
        origin: ORIGIN,
        pathname: "/settings",
      }),
    }));
  });

  test("forwards an owned exact-endpoint More action over the private port", async () => {
    const fixture = await createInPageWidgetFixture();
    const lifecycle = await connectInPageWidgetLifecycle(fixture);
    const contentSender = createInPageWidgetContentSender();
    const request = {
      type: UI_ATTACH_OVERLAY_ACTION_REQUEST,
      action: "more",
      itemId: fixture.itemId,
      projection: WIDGET_OVERLAY_PROJECTION,
    } as const;

    await expect(dispatchRuntime(
      fixture.controller,
      request,
      contentSender,
    )).resolves.toEqual({ ok: true, data: null });
    await waitForPostedWidgetActionCount(lifecycle.port, 1);
    expect(lifecycle.port.postMessage).toHaveBeenCalledTimes(1);
    expect(lifecycle.port.postMessage).toHaveBeenCalledWith({
      type: UI_ATTACH_IN_PAGE_WIDGET_ACTION,
      surfaceId: fixture.init.surfaceId,
      actionId: expect.any(String),
      action: "more",
      itemId: fixture.itemId,
    });
    const forwarded = vi.mocked(lifecycle.port.postMessage).mock.calls[0]?.[0];
    expect(forwarded).not.toHaveProperty("capability");
    expect(request).not.toHaveProperty("capability");

    const rejectedRequests = [
      [request, { ...contentSender, frameId: 1 }],
      [request, { ...contentSender, documentId: "stale-content-document" }],
      [request, { ...contentSender, url: `${ORIGIN}/stale-route` }],
      [{ ...request, itemId: "att_not_owned" }, contentSender],
      [request, { ...contentSender, id: "other-extension" }],
    ] as const;
    for (const [rejectedRequest, rejectedSender] of rejectedRequests) {
      await expect(dispatchRuntime(
        fixture.controller,
        rejectedRequest,
        rejectedSender,
      )).resolves.toMatchObject({ ok: false, code: "UNTRUSTED_SENDER" });
    }
    expect(lifecycle.port.postMessage).toHaveBeenCalledTimes(1);
    const action = readPostedWidgetActions(lifecycle.port)[0];
    const portMessageListener = vi.mocked(lifecycle.messageEvent.addListener).mock.calls[0]?.[0];
    if (action && portMessageListener) {
      portMessageListener({
        type: UI_ATTACH_IN_PAGE_WIDGET_ACTION_ACK,
        surfaceId: fixture.init.surfaceId,
        actionId: action.actionId,
        outcome: "consumed",
      });
    }
  });

  test("replays one actionId after reconnect and accepts its ACK only from the current port", async () => {
    const fixture = await createInPageWidgetFixture();
    fixture.controller.register();
    vi.mocked(fixture.chrome.tabs.sendMessage).mockClear();
    const connectListener = vi.mocked(fixture.chrome.runtime.onConnect.addListener).mock.calls[0]?.[0] as
      | ((port: UiAttachChromePort) => void)
      | undefined;
    if (!connectListener) throw new Error("runtime connect listener was not registered");

    await expect(dispatchRuntime(fixture.controller, {
      type: UI_ATTACH_OVERLAY_ACTION_REQUEST,
      action: "more",
      itemId: fixture.itemId,
      projection: WIDGET_OVERLAY_PROJECTION,
    }, createInPageWidgetContentSender())).resolves.toEqual({ ok: true, data: null });

    expect(fixture.chrome.tabs.sendMessage).toHaveBeenCalledWith(
      WIDGET_TAB_ID,
      { type: UI_ATTACH_IN_PAGE_WIDGET_ENSURE },
      { frameId: 0, documentId: WIDGET_TOP_DOCUMENT_ID },
    );
    expect(fixture.chrome.tabs.sendMessage).toHaveBeenCalledWith(
      WIDGET_TAB_ID,
      expect.objectContaining({
        type: UI_ATTACH_IN_PAGE_WIDGET_INIT,
        surfaceId: fixture.init.surfaceId,
      }),
      { frameId: 0, documentId: WIDGET_TOP_DOCUMENT_ID },
    );

    const firstDisconnect = createEventHarness<() => void>();
    const firstMessage = createEventHarness<(message: unknown) => void>();
    const firstPort = {
      name: createInPageWidgetLifecyclePortName(fixture.init.surfaceId, fixture.init.capability),
      sender: fixture.widgetSender,
      disconnect: vi.fn(),
      postMessage: vi.fn(),
      onDisconnect: firstDisconnect,
      onMessage: firstMessage,
    } satisfies UiAttachChromePort;
    connectListener(firstPort);
    await waitForPostedWidgetActionCount(firstPort, 1);
    const firstAction = readPostedWidgetActions(firstPort)[0];
    if (!firstAction) throw new Error("first lifecycle action was not delivered");
    expect(firstPort.postMessage).toHaveBeenCalledWith({
      type: UI_ATTACH_IN_PAGE_WIDGET_ACTION,
      surfaceId: fixture.init.surfaceId,
      actionId: firstAction.actionId,
      action: "more",
      itemId: fixture.itemId,
    });
    expect(vi.mocked(firstPort.postMessage).mock.calls.filter(([message]) => (
      isRecord(message) && message.type === UI_ATTACH_IN_PAGE_WIDGET_ACTION
    ))).toHaveLength(1);

    const firstDisconnectListener = vi.mocked(firstDisconnect.addListener).mock.calls[0]?.[0] as
      | (() => void)
      | undefined;
    firstDisconnectListener?.();
    const secondMessage = createEventHarness<(message: unknown) => void>();
    const secondPort = {
      ...firstPort,
      disconnect: vi.fn(),
      postMessage: vi.fn(),
      onDisconnect: createEventHarness<() => void>(),
      onMessage: secondMessage,
    } satisfies UiAttachChromePort;
    connectListener(secondPort);
    await waitForPostedWidgetActionCount(secondPort, 1);
    const replayedAction = readPostedWidgetActions(secondPort)[0];
    expect(replayedAction).toEqual(firstAction);

    const secondRequest = dispatchRuntime(fixture.controller, {
      type: UI_ATTACH_OVERLAY_ACTION_REQUEST,
      action: "edit",
      itemId: fixture.itemId,
      projection: WIDGET_OVERLAY_PROJECTION,
    }, createInPageWidgetContentSender());
    await expect(secondRequest).resolves.toEqual({ ok: true, data: null });
    const oldPortMessageListener = vi.mocked(firstMessage.addListener).mock.calls[0]?.[0];
    oldPortMessageListener?.({
      type: UI_ATTACH_IN_PAGE_WIDGET_ACTION_ACK,
      surfaceId: fixture.init.surfaceId,
      actionId: firstAction.actionId,
      outcome: "consumed",
    });
    await flushAsyncWork();
    expect(readPostedWidgetActions(secondPort)).toHaveLength(1);

    const currentPortMessageListener = vi.mocked(secondMessage.addListener).mock.calls[0]?.[0];
    currentPortMessageListener?.({
      type: UI_ATTACH_IN_PAGE_WIDGET_ACTION_ACK,
      surfaceId: fixture.init.surfaceId,
      actionId: firstAction.actionId,
      outcome: "consumed",
    });
    await waitForPostedWidgetActionCount(secondPort, 2);
    const secondAction = readPostedWidgetActions(secondPort)[1];
    if (!secondAction) throw new Error("second lifecycle action was not delivered");
    expect(secondAction.actionId).not.toBe(firstAction.actionId);
    currentPortMessageListener?.({
      type: UI_ATTACH_IN_PAGE_WIDGET_ACTION_ACK,
      surfaceId: fixture.init.surfaceId,
      actionId: secondAction.actionId,
      outcome: "consumed",
    });
  });

  test("isolates a lifecycle port whose READY delivery throws and retries on a fresh port", async () => {
    const fixture = await createInPageWidgetFixture();
    fixture.controller.register();
    const connectListener = vi.mocked(fixture.chrome.runtime.onConnect.addListener).mock.calls[0]?.[0] as
      | ((port: UiAttachChromePort) => void)
      | undefined;
    if (!connectListener) throw new Error("runtime connect listener was not registered");
    await expect(dispatchRuntime(fixture.controller, {
      type: UI_ATTACH_OVERLAY_ACTION_REQUEST,
      action: "more",
      itemId: fixture.itemId,
      projection: WIDGET_OVERLAY_PROJECTION,
    }, createInPageWidgetContentSender())).resolves.toEqual({ ok: true, data: null });

    const brokenPort = {
      name: createInPageWidgetLifecyclePortName(fixture.init.surfaceId, fixture.init.capability),
      sender: fixture.widgetSender,
      disconnect: vi.fn(),
      postMessage: vi.fn(() => {
        throw new Error("READY transport failed");
      }),
      onDisconnect: createEventHarness<() => void>(),
      onMessage: createEventHarness<(message: unknown) => void>(),
    } satisfies UiAttachChromePort;
    connectListener(brokenPort);
    await flushAsyncWork();
    expect(brokenPort.disconnect).toHaveBeenCalledOnce();

    const freshMessage = createEventHarness<(message: unknown) => void>();
    const freshPort = {
      ...brokenPort,
      disconnect: vi.fn(),
      postMessage: vi.fn(),
      onDisconnect: createEventHarness<() => void>(),
      onMessage: freshMessage,
    } satisfies UiAttachChromePort;
    connectListener(freshPort);
    await waitForPostedWidgetActionCount(freshPort, 1);
    const replayed = readPostedWidgetActions(freshPort)[0];
    if (!replayed) throw new Error("pending action was not replayed after READY failure");
    const messageListener = vi.mocked(freshMessage.addListener).mock.calls[0]?.[0];
    messageListener?.({
      type: UI_ATTACH_IN_PAGE_WIDGET_ACTION_ACK,
      surfaceId: fixture.init.surfaceId,
      actionId: replayed.actionId,
      outcome: "consumed",
    });
  });

  test("keeps a replacement lifecycle port usable when disconnecting the pending old port throws", async () => {
    const fixture = await createInPageWidgetFixture();
    const lifecycle = await connectInPageWidgetLifecycle(fixture);
    await expect(dispatchRuntime(fixture.controller, {
      type: UI_ATTACH_OVERLAY_ACTION_REQUEST,
      action: "more",
      itemId: fixture.itemId,
      projection: WIDGET_OVERLAY_PROJECTION,
    }, createInPageWidgetContentSender())).resolves.toEqual({ ok: true, data: null });
    await waitForPostedWidgetActionCount(lifecycle.port, 1);
    const pendingAction = readPostedWidgetActions(lifecycle.port)[0];
    if (!pendingAction) throw new Error("pending widget action was not delivered");
    lifecycle.port.disconnect.mockImplementationOnce(() => {
      throw new Error("old transport disconnect failed");
    });

    const connectListener = vi.mocked(fixture.chrome.runtime.onConnect.addListener).mock.calls[0]?.[0] as
      | ((port: UiAttachChromePort) => void)
      | undefined;
    if (!connectListener) throw new Error("runtime connect listener was not registered");
    const nextMessage = createEventHarness<(message: unknown) => void>();
    const nextPort = {
      name: createInPageWidgetLifecyclePortName(fixture.init.surfaceId, fixture.init.capability),
      sender: fixture.widgetSender,
      disconnect: vi.fn(),
      postMessage: vi.fn(),
      onDisconnect: createEventHarness<() => void>(),
      onMessage: nextMessage,
    } satisfies UiAttachChromePort;
    connectListener(nextPort);

    await flushAsyncWork();
    expect(nextPort.postMessage).toHaveBeenCalledWith({
      type: UI_ATTACH_IN_PAGE_WIDGET_READY,
      surfaceId: fixture.init.surfaceId,
    });
    await waitForPostedWidgetActionCount(nextPort, 1);
    expect(readPostedWidgetActions(nextPort)[0]).toEqual(pendingAction);
    const nextMessageListener = vi.mocked(nextMessage.addListener).mock.calls[0]?.[0];
    nextMessageListener?.({
      type: UI_ATTACH_IN_PAGE_WIDGET_ACTION_ACK,
      surfaceId: fixture.init.surfaceId,
      actionId: pendingAction.actionId,
      outcome: "consumed",
    });
  });

  test("retries a timed-out head and terminates the surface on an explicit rejection", async () => {
    const fixture = await createInPageWidgetFixture();
    const lifecycle = await connectInPageWidgetLifecycle(fixture);
    const originalSetTimeout = globalThis.setTimeout;
    let actionTimeout: (() => void) | null = null;
    const setTimeoutSpy = vi.spyOn(globalThis, "setTimeout").mockImplementation(
      (handler, delay, ...args) => {
        if (delay === 4_000 && typeof handler === "function") {
          actionTimeout = () => handler(...args);
          return 40_001 as ReturnType<typeof setTimeout>;
        }
        return originalSetTimeout(handler, delay, ...args);
      },
    );
    try {
      await expect(dispatchRuntime(fixture.controller, {
        type: UI_ATTACH_OVERLAY_ACTION_REQUEST,
        action: "more",
        itemId: fixture.itemId,
        projection: WIDGET_OVERLAY_PROJECTION,
      }, createInPageWidgetContentSender())).resolves.toEqual({ ok: true, data: null });
      await waitForPostedWidgetActionCount(lifecycle.port, 1);
      const firstAction = readPostedWidgetActions(lifecycle.port)[0];
      if (!firstAction) throw new Error("timed action was not delivered");
      await expect(dispatchRuntime(fixture.controller, {
        type: UI_ATTACH_OVERLAY_ACTION_REQUEST,
        action: "edit",
        itemId: fixture.itemId,
        projection: WIDGET_OVERLAY_PROJECTION,
      }, createInPageWidgetContentSender())).resolves.toEqual({ ok: true, data: null });
      expect(readPostedWidgetActions(lifecycle.port)).toHaveLength(1);

      expect(actionTimeout).toEqual(expect.any(Function));
      actionTimeout?.();
      await flushAsyncWork();
      expect(lifecycle.port.disconnect).toHaveBeenCalledOnce();
      await expect(dispatchRuntime(
        fixture.controller,
        createInPageWidgetCommandEnvelope(fixture.init, {
          type: "ui-attach:widget-selection-set",
          enabled: false,
          intent: "explicit",
          expectedGeneration: 0,
        }),
        fixture.widgetSender,
      )).resolves.toMatchObject({ ok: false, code: "WIDGET_STATE_UNAVAILABLE" });
      await expect(dispatchRuntime(
        fixture.controller,
        createInPageWidgetCommandEnvelope(fixture.init, {
          type: "ui-attach:widget-frame-scope-select",
          frameId: 0,
          documentId: WIDGET_TOP_DOCUMENT_ID,
          origin: ORIGIN,
          pathname: "/settings",
          expectedGeneration: 0,
        }),
        fixture.widgetSender,
      )).resolves.toMatchObject({ ok: false, code: "WIDGET_STATE_UNAVAILABLE" });

      const connectListener = vi.mocked(fixture.chrome.runtime.onConnect.addListener).mock.calls[0]?.[0] as
        | ((port: UiAttachChromePort) => void)
        | undefined;
      if (!connectListener) throw new Error("runtime connect listener was not registered");
      const nextMessage = createEventHarness<(message: unknown) => void>();
      const nextPort = {
        name: createInPageWidgetLifecyclePortName(fixture.init.surfaceId, fixture.init.capability),
        sender: fixture.widgetSender,
        disconnect: vi.fn(),
        postMessage: vi.fn(),
        onDisconnect: createEventHarness<() => void>(),
        onMessage: nextMessage,
      } satisfies UiAttachChromePort;
      connectListener(nextPort);
      await waitForPostedWidgetActionCount(nextPort, 1);
      const replayed = readPostedWidgetActions(nextPort)[0];
      expect(replayed).toEqual(firstAction);

      const nextPortMessageListener = vi.mocked(nextMessage.addListener).mock.calls[0]?.[0];
      nextPortMessageListener?.({
        type: UI_ATTACH_IN_PAGE_WIDGET_ACTION_ACK,
        surfaceId: fixture.init.surfaceId,
        actionId: firstAction.actionId,
        outcome: "rejected",
      });
      await flushAsyncWork();
      expect(readPostedWidgetActions(nextPort)).toHaveLength(1);
      expect(nextPort.disconnect).toHaveBeenCalledOnce();
      await expect(dispatchRuntime(
        fixture.controller,
        createInPageWidgetRegistration(fixture.init),
        fixture.widgetSender,
      )).resolves.toMatchObject({ ok: false, code: "UNTRUSTED_SENDER" });
    } finally {
      setTimeoutSpy.mockRestore();
    }
  });

  test("persists a terminal fence when an explicitly rejected surface cannot be revoked", async () => {
    const fixture = await createInPageWidgetFixture();
    const lifecycle = await connectInPageWidgetLifecycleRaw(fixture);
    await expect(dispatchRuntime(fixture.controller, {
      type: UI_ATTACH_OVERLAY_ACTION_REQUEST,
      action: "more",
      itemId: fixture.itemId,
      projection: WIDGET_OVERLAY_PROJECTION,
    }, createInPageWidgetContentSender())).resolves.toEqual({ ok: true, data: null });
    await waitForPostedWidgetActionCount(lifecycle.port, 1);
    const delivered = readPostedWidgetActions(lifecycle.port)[0];
    if (!delivered) throw new Error("rejected action was not delivered");
    const originalSessionRemove = fixture.chrome.storage.session.remove;
    fixture.chrome.storage.session.remove = vi.fn(async (keys) => {
      if (keys === IN_PAGE_WIDGET_LEASE_STORAGE_KEY || (
        Array.isArray(keys) && keys.includes(IN_PAGE_WIDGET_LEASE_STORAGE_KEY)
      )) {
        throw new Error("lease revoke unavailable");
      }
      await originalSessionRemove(keys);
    });

    const messageListener = vi.mocked(lifecycle.messageEvent.addListener).mock.calls[0]?.[0];
    messageListener?.({
      type: UI_ATTACH_IN_PAGE_WIDGET_ACTION_ACK,
      surfaceId: fixture.init.surfaceId,
      actionId: delivered.actionId,
      outcome: "rejected",
    });
    await waitFor(() => vi.mocked(lifecycle.port.disconnect).mock.calls.length === 1);
    await flushAsyncWork();

    const restarted = createBackgroundController({
      chrome: fixture.chrome,
      store: fixture.store,
      ensureContentScript: fixture.ensureContentScript,
    });
    await expect(dispatchRuntime(
      restarted,
      createInPageWidgetRegistration(fixture.init),
      fixture.widgetSender,
    )).resolves.toMatchObject({
      ok: false,
      code: "UNTRUSTED_SENDER",
      issues: [{ path: "widget", message: "WIDGET_REGISTER_LEASE" }],
    });
  });

  test("single-flights rapid More A/B validation and delivers FIFO exactly once", async () => {
    const fixture = await createInPageWidgetFixture();
    const lifecycle = await connectInPageWidgetLifecycle(fixture);
    await flushAsyncWork();
    const first = createCaptureRecord("save", "Save changes");
    const second = createCaptureRecord("cancel", "Cancel");
    for (const record of [first, second]) {
      record.origin = ORIGIN;
      record.pageUrl = `${ORIGIN}/settings`;
      record.tabId = WIDGET_TAB_ID;
      record.frameId = 0;
    }
    const current = createSessionReadbackMany([first, second]);
    fixture.store.read = vi.fn(async () => ({ ok: true as const, value: current }));
    const actionProjection = await restoreAndAcknowledgeProjection(
      fixture.controller,
      createInPageWidgetContentSender(),
    );
    const validationRead = createDeferred<{
      ok: true;
      value: ActiveSessionReadback;
    }>();
    const validationStarted = createDeferred<void>();
    const secondActionReadStarted = createDeferred<void>();
    let readCount = 0;
    fixture.store.read = vi.fn(async () => {
      readCount += 1;
      if (readCount === 2) {
        validationStarted.resolve(undefined);
        return validationRead.promise;
      }
      if (readCount === 3) secondActionReadStarted.resolve(undefined);
      return { ok: true as const, value: current };
    });

    const actionA = dispatchRuntime(fixture.controller, {
      type: UI_ATTACH_OVERLAY_ACTION_REQUEST,
      action: "more",
      itemId: first.attachment.id,
      projection: actionProjection,
    }, createInPageWidgetContentSender());
    await flushAsyncWork();
    await validationStarted.promise;
    const actionB = dispatchRuntime(fixture.controller, {
      type: UI_ATTACH_OVERLAY_ACTION_REQUEST,
      action: "more",
      itemId: first.attachment.id,
      projection: actionProjection,
    }, createInPageWidgetContentSender());
    await flushAsyncWork();
    await secondActionReadStarted.promise;
    await flushAsyncWork();
    expect(fixture.store.read).toHaveBeenCalledTimes(3);
    validationRead.resolve({ ok: true, value: current });

    await expect(Promise.all([actionA, actionB])).resolves.toEqual([
      { ok: true, data: null },
      { ok: true, data: null },
    ]);
    await waitForPostedWidgetActionCount(lifecycle.port, 1);
    const firstAction = readPostedWidgetActions(lifecycle.port)[0];
    const portMessageListener = vi.mocked(lifecycle.messageEvent.addListener).mock.calls[0]?.[0];
    if (!firstAction || !portMessageListener) throw new Error("first FIFO action was not delivered");
    expect(readPostedWidgetActions(lifecycle.port)).toEqual([
      expect.objectContaining({ action: "more", itemId: first.attachment.id }),
    ]);
    portMessageListener({
      type: UI_ATTACH_IN_PAGE_WIDGET_ACTION_ACK,
      surfaceId: fixture.init.surfaceId,
      actionId: firstAction.actionId,
      outcome: "consumed",
    });
    await waitForPostedWidgetActionCount(lifecycle.port, 2);
    const actions = readPostedWidgetActions(lifecycle.port);
    expect(actions).toEqual([
      expect.objectContaining({ action: "more", itemId: first.attachment.id }),
      expect.objectContaining({ action: "more", itemId: first.attachment.id }),
    ]);
    const secondAction = actions[1];
    if (secondAction) {
      portMessageListener({
        type: UI_ATTACH_IN_PAGE_WIDGET_ACTION_ACK,
        surfaceId: fixture.init.surfaceId,
        actionId: secondAction.actionId,
        outcome: "consumed",
      });
    }
  });

  test("keeps each cross-origin action context authoritative until its exact port ACK", async () => {
    const fixture = await createInPageWidgetFixture();
    const frameId = 3;
    const frameDocumentId = "cross-origin-frame-document";
    const framePathname = "/embedded-editor";
    let secondProjection = {
      version: 1 as const,
      projectionId: "0fa134d2-490d-4d1e-ac8f-a4ccab38bcb0",
      revision: 1,
    };
    const first = createCaptureRecord("save", "Save changes");
    first.origin = ORIGIN;
    first.pageUrl = `${ORIGIN}/settings`;
    first.tabId = WIDGET_TAB_ID;
    first.frameId = 0;
    const second = createCaptureRecord("cancel", "Cancel");
    second.origin = OTHER_ORIGIN;
    second.pageUrl = `${OTHER_ORIGIN}${framePathname}`;
    second.tabId = WIDGET_TAB_ID;
    second.frameId = frameId;
    second.routeChain = [
      { origin: ORIGIN, pathname: "/settings" },
      { origin: OTHER_ORIGIN, pathname: framePathname },
    ];
    const firstReadback = createSessionReadback(first);
    const secondReadback = createSessionReadback(second);
    let currentFirstReadback = firstReadback;
    fixture.store.read = vi.fn(async (origin) => ({
      ok: true,
      value: origin === OTHER_ORIGIN ? secondReadback : currentFirstReadback,
    }));
    fixture.store.updateIntent = vi.fn(async (_origin, _epoch, _itemId, intent) => {
      currentFirstReadback = createSessionReadback({ ...first, intent });
      return { ok: true, value: currentFirstReadback };
    });
    const originalGetFrame = fixture.chrome.webNavigation.getFrame;
    fixture.chrome.webNavigation.getFrame = vi.fn(async (details) => details.tabId === WIDGET_TAB_ID &&
        details.frameId === frameId
      ? {
          documentId: frameDocumentId,
          parentFrameId: 0,
          url: `${OTHER_ORIGIN}${framePathname}`,
        }
      : originalGetFrame(details));
    fixture.chrome.webNavigation.getAllFrames = vi.fn(async ({ tabId }) => tabId === WIDGET_TAB_ID
      ? [{
          frameId: 0,
          parentFrameId: -1,
          documentId: WIDGET_TOP_DOCUMENT_ID,
          url: `${ORIGIN}/settings`,
        }, {
          frameId,
          parentFrameId: 0,
          documentId: frameDocumentId,
          url: `${OTHER_ORIGIN}${framePathname}`,
        }]
      : []);
    await fixture.chrome.storage.local.set({
      [OVERLAY_PROJECTION_AUTHORITY_GENERATION_KEY]: 10,
    });
    await fixture.chrome.storage.session.set({
      [OVERLAY_PROJECTIONS_SESSION_KEY]: {
        generation: 10,
        records: [{
          projection: WIDGET_OVERLAY_PROJECTION_DESCRIPTOR,
          itemIds: [first.attachment.id],
          activeItemId: null,
          delivery: "acknowledged",
          updatedAt: 1,
        }, {
          projection: {
            ...secondProjection,
            sessionEpoch: "epoch-1",
            subject: {
              tabId: WIDGET_TAB_ID,
              frameId,
              documentId: frameDocumentId,
              origin: OTHER_ORIGIN,
              pathname: framePathname,
            },
          },
          itemIds: [second.attachment.id],
          activeItemId: null,
          delivery: "acknowledged",
          updatedAt: 2,
        }],
      },
    });
    fixture.controller = createBackgroundController({
      chrome: fixture.chrome,
      store: fixture.store,
      ensureContentScript: fixture.ensureContentScript,
    });
    vi.mocked(fixture.chrome.tabs.sendMessage).mockClear();
    expect(await fixture.controller.showInPageWidget(WIDGET_TAB_ID)).toBe(true);
    const recreatedInit = vi.mocked(fixture.chrome.tabs.sendMessage).mock.calls
      .map((call) => parseInPageWidgetInitMessage(call[1]))
      .find((message): message is InPageWidgetInitMessage => message !== null);
    if (!recreatedInit) throw new Error("recreated in-page widget init was not sent");
    fixture.init = recreatedInit;
    Object.assign(WIDGET_OVERLAY_PROJECTION, await restoreAndAcknowledgeProjection(
      fixture.controller,
      createInPageWidgetContentSender(),
    ));
    const childSender: UiAttachChromeMessageSender = {
      ...createInPageWidgetContentSender(),
      url: `${OTHER_ORIGIN}${framePathname}`,
      frameId,
      documentId: frameDocumentId,
    };
    const lifecycle = await connectInPageWidgetLifecycle(fixture);
    const portMessageListener = vi.mocked(lifecycle.messageEvent.addListener).mock.calls[0]?.[0] as
      | ((message: unknown) => void)
      | undefined;
    if (!portMessageListener) throw new Error("widget lifecycle message listener was not registered");

    const actionA = dispatchRuntime(fixture.controller, {
      type: UI_ATTACH_OVERLAY_ACTION_REQUEST,
      action: "more",
      itemId: first.attachment.id,
      projection: WIDGET_OVERLAY_PROJECTION,
    }, createInPageWidgetContentSender());
    await expect(actionA).resolves.toEqual({ ok: true, data: null });
    await flushAsyncWork();
    await waitForPostedWidgetActionCount(lifecycle.port, 1);
    const postedA = readPostedWidgetActions(lifecycle.port)[0];
    if (!postedA) throw new Error("first widget action was not posted");

    await expect(dispatchRuntime(fixture.controller, {
      type: UI_ATTACH_OVERLAY_PROJECTION_ACK,
      projection: secondProjection,
    }, childSender)).resolves.toEqual({ ok: true, data: { accepted: true } });

    const actionB = dispatchRuntime(fixture.controller, {
      type: UI_ATTACH_OVERLAY_ACTION_REQUEST,
      action: "edit",
      itemId: second.attachment.id,
      projection: secondProjection,
    }, childSender);
    await expect(actionB).resolves.toEqual({ ok: true, data: null });
    await flushAsyncWork();
    expect(readPostedWidgetActions(lifecycle.port)).toHaveLength(1);
    await expect(dispatchRuntime(
      fixture.controller,
      createInPageWidgetCommandEnvelope(fixture.init, {
        type: "ui-attach:widget-session-read",
      }),
      fixture.widgetSender,
    )).resolves.toMatchObject({
      ok: true,
      data: {
        origin: ORIGIN,
        activePage: { origin: ORIGIN, frameId: 0 },
        readback: {
          file: { session: { attachments: [{ id: first.attachment.id }] } },
        },
      },
    });

    portMessageListener({
      type: UI_ATTACH_IN_PAGE_WIDGET_ACTION_ACK,
      surfaceId: "123e4567-e89b-42d3-a456-426614174000",
      actionId: postedA.actionId,
      outcome: "consumed",
    });
    portMessageListener({
      type: UI_ATTACH_IN_PAGE_WIDGET_ACTION_ACK,
      surfaceId: fixture.init.surfaceId,
      actionId: "a9f62671-7d3a-45c9-992d-44435ae38a74",
      outcome: "consumed",
    });
    await flushAsyncWork();
    expect(readPostedWidgetActions(lifecycle.port)).toHaveLength(1);

    portMessageListener({
      type: UI_ATTACH_IN_PAGE_WIDGET_ACTION_ACK,
      surfaceId: fixture.init.surfaceId,
      actionId: postedA.actionId,
      outcome: "consumed",
    });
    await flushAsyncWork();
    await waitForPostedWidgetActionCount(lifecycle.port, 2);
    const postedB = readPostedWidgetActions(lifecycle.port)[1];
    if (!postedB) throw new Error("second widget action was not posted");
    await expect(dispatchRuntime(
      fixture.controller,
      createInPageWidgetCommandEnvelope(fixture.init, {
        type: "ui-attach:widget-session-read",
      }),
      fixture.widgetSender,
    )).resolves.toMatchObject({
      ok: true,
      data: {
        origin: OTHER_ORIGIN,
        activePage: { origin: OTHER_ORIGIN, frameId },
        readback: {
          file: { session: { attachments: [{ id: second.attachment.id }] } },
        },
      },
    });
    await fixture.controller.handleNavigationCommitted({
      tabId: WIDGET_TAB_ID,
      frameId: 0,
      parentFrameId: -1,
      documentId: WIDGET_TOP_DOCUMENT_ID,
      url: `${ORIGIN}/settings?same-document=1`,
    });
    await expect(dispatchRuntime(
      fixture.controller,
      createInPageWidgetCommandEnvelope(fixture.init, {
        type: "ui-attach:widget-session-read",
      }),
      fixture.widgetSender,
    )).resolves.toMatchObject({
      ok: true,
      data: {
        origin: OTHER_ORIGIN,
        activePage: { origin: OTHER_ORIGIN, frameId },
      },
    });
    const disconnectListener = vi.mocked(lifecycle.disconnectEvent.addListener).mock.calls[0]?.[0] as
      | (() => void)
      | undefined;
    disconnectListener?.();
    await expect(dispatchRuntime(fixture.controller, {
      type: UI_ATTACH_OVERLAY_ACTION_REQUEST,
      action: "save",
      itemId: first.attachment.id,
      taskNote: "Do not overwrite the pending child action context",
      projection: WIDGET_OVERLAY_PROJECTION,
    }, createInPageWidgetContentSender())).resolves.toEqual({ ok: true, data: null });
    await expect(dispatchRuntime(
      fixture.controller,
      createInPageWidgetCommandEnvelope(fixture.init, {
        type: "ui-attach:widget-session-read",
      }),
      fixture.widgetSender,
    )).resolves.toMatchObject({
      ok: true,
      data: {
        origin: OTHER_ORIGIN,
        activePage: { origin: OTHER_ORIGIN, frameId },
      },
    });
    await expect(dispatchRuntime(
      fixture.controller,
      createInPageWidgetCommandEnvelope(fixture.init, {
        type: "ui-attach:widget-surface-release",
      }),
      fixture.widgetSender,
    )).resolves.toEqual({ ok: true, data: null });
  });

  test("bounds pending More actions while the widget lifecycle port is unavailable", async () => {
    const fixture = await createInPageWidgetFixture();
    const sender = createInPageWidgetContentSender();
    const responses = [];
    for (let index = 0; index < 65; index += 1) {
      responses.push(await dispatchRuntime(fixture.controller, {
        type: UI_ATTACH_OVERLAY_ACTION_REQUEST,
        action: "more",
        itemId: fixture.itemId,
        projection: WIDGET_OVERLAY_PROJECTION,
      }, sender));
    }

    expect(responses.slice(0, 64)).toEqual(
      Array.from({ length: 64 }, () => ({ ok: true, data: null })),
    );
    expect(responses[64]).toMatchObject({ ok: false, code: "WIDGET_UNAVAILABLE" });
  });

  test("drops an old validating queue after History change without deleting its valid replacement", async () => {
    const fixture = await createInPageWidgetFixture();
    const lifecycle = await connectInPageWidgetLifecycle(fixture);
    await flushAsyncWork();
    const first = createCaptureRecord("save", "Save changes");
    const second = createCaptureRecord("cancel", "Cancel");
    for (const record of [first, second]) {
      record.origin = ORIGIN;
      record.pageUrl = `${ORIGIN}/settings`;
      record.tabId = WIDGET_TAB_ID;
      record.frameId = 0;
    }
    const current = createSessionReadbackMany([first, second]);
    const oldValidation = createDeferred<{ ok: true; value: ActiveSessionReadback }>();
    const oldValidationStarted = createDeferred<void>();
    let readCount = 0;
    fixture.store.read = vi.fn(async () => {
      readCount += 1;
      if (readCount === 2) {
        oldValidationStarted.resolve(undefined);
        return oldValidation.promise;
      }
      return { ok: true as const, value: current };
    });

    const oldAction = dispatchRuntime(fixture.controller, {
      type: UI_ATTACH_OVERLAY_ACTION_REQUEST,
      action: "more",
      itemId: first.attachment.id,
      projection: WIDGET_OVERLAY_PROJECTION,
    }, createInPageWidgetContentSender());
    await flushAsyncWork();
    await oldValidationStarted.promise;
    await fixture.controller.handleNavigationCommitted({
      tabId: WIDGET_TAB_ID,
      frameId: 0,
      parentFrameId: -1,
      documentId: WIDGET_TOP_DOCUMENT_ID,
      url: `${ORIGIN}/different-history-route`,
    });
    await fixture.controller.handleNavigationCommitted({
      tabId: WIDGET_TAB_ID,
      frameId: 0,
      parentFrameId: -1,
      documentId: WIDGET_TOP_DOCUMENT_ID,
      url: `${ORIGIN}/settings`,
    });
    oldValidation.resolve({ ok: true, value: current });
    await expect(oldAction).resolves.toEqual({ ok: true, data: null });
    const nextProjection = await restoreAndAcknowledgeProjection(
      fixture.controller,
      createInPageWidgetContentSender(),
    );
    const newAction = dispatchRuntime(fixture.controller, {
      type: UI_ATTACH_OVERLAY_ACTION_REQUEST,
      action: "more",
      itemId: first.attachment.id,
      projection: nextProjection,
    }, createInPageWidgetContentSender());
    await expect(newAction).resolves.toEqual({ ok: true, data: null });
    await waitForPostedWidgetActionCount(lifecycle.port, 1);
    const actions = readPostedWidgetActions(lifecycle.port);
    expect(actions).toEqual([
      expect.objectContaining({ action: "more", itemId: first.attachment.id }),
    ]);
    const portMessageListener = vi.mocked(lifecycle.messageEvent.addListener).mock.calls[0]?.[0];
    if (actions[0] && portMessageListener) {
      portMessageListener({
        type: UI_ATTACH_IN_PAGE_WIDGET_ACTION_ACK,
        surfaceId: fixture.init.surfaceId,
        actionId: actions[0].actionId,
        outcome: "consumed",
      });
    }
  });

  test("does not deliver a validating More action after its surface is released", async () => {
    const fixture = await createInPageWidgetFixture();
    const lifecycle = await connectInPageWidgetLifecycle(fixture);
    await flushAsyncWork();
    const validationFrame = createDeferred<void>();
    const validationStarted = createDeferred<void>();
    const getFrame = fixture.chrome.webNavigation.getFrame;
    let firstValidation = true;
    fixture.chrome.webNavigation.getFrame = vi.fn(async (details) => {
      if (firstValidation) {
        firstValidation = false;
        validationStarted.resolve(undefined);
        await validationFrame.promise;
      }
      return await getFrame(details);
    });
    const action = dispatchRuntime(fixture.controller, {
      type: UI_ATTACH_OVERLAY_ACTION_REQUEST,
      action: "more",
      itemId: fixture.itemId,
      projection: WIDGET_OVERLAY_PROJECTION,
    }, createInPageWidgetContentSender());
    await flushAsyncWork();
    await validationStarted.promise;

    await expect(dispatchRuntime(
      fixture.controller,
      createInPageWidgetCommandEnvelope(fixture.init, {
        type: "ui-attach:widget-surface-release",
      }),
      fixture.widgetSender,
    )).resolves.toEqual({ ok: true, data: null });
    validationFrame.resolve(undefined);
    await expect(action).resolves.toMatchObject({ ok: false, code: "UNTRUSTED_SENDER" });
    expect(vi.mocked(lifecycle.port.postMessage).mock.calls.some(([message]) => (
      isRecord(message) && message.type === UI_ATTACH_IN_PAGE_WIDGET_ACTION
    ))).toBe(false);
    await expect(dispatchRuntime(
      fixture.controller,
      createInPageWidgetRegistration(fixture.init),
      fixture.widgetSender,
    )).resolves.toMatchObject({ ok: false, code: "UNTRUSTED_SENDER" });
  });

  test("finishes durable revoke when the pending lifecycle port disconnect throws", async () => {
    const fixture = await createInPageWidgetFixture();
    const lifecycle = await connectInPageWidgetLifecycle(fixture);
    await expect(dispatchRuntime(fixture.controller, {
      type: UI_ATTACH_OVERLAY_ACTION_REQUEST,
      action: "more",
      itemId: fixture.itemId,
      projection: WIDGET_OVERLAY_PROJECTION,
    }, createInPageWidgetContentSender())).resolves.toEqual({ ok: true, data: null });
    await waitForPostedWidgetActionCount(lifecycle.port, 1);
    lifecycle.port.disconnect.mockImplementationOnce(() => {
      throw new Error("terminal disconnect failed");
    });

    await expect(fixture.controller.handleNavigationCommitted({
      tabId: WIDGET_TAB_ID,
      frameId: 0,
      parentFrameId: -1,
      documentId: "replacement-top-document",
      url: `${ORIGIN}/full-navigation`,
    })).resolves.toBeUndefined();
    const restarted = createBackgroundController({
      chrome: fixture.chrome,
      store: fixture.store,
      ensureContentScript: fixture.ensureContentScript,
    });
    await expect(dispatchRuntime(
      restarted,
      createInPageWidgetRegistration(fixture.init),
      fixture.widgetSender,
    )).resolves.toMatchObject({ ok: false, code: "UNTRUSTED_SENDER" });
  });

  test("does not deliver a validating More action after disconnected lease expiry", async () => {
    const fixture = await createInPageWidgetFixture();
    const lifecycle = await connectInPageWidgetLifecycle(fixture);
    const current = await fixture.store.read(ORIGIN);
    if (!current.ok) throw new Error("fixture session missing");
    await flushAsyncWork();
    const validationRead = createDeferred<{ ok: true; value: ActiveSessionReadback }>();
    const validationStarted = createDeferred<void>();
    let readCount = 0;
    fixture.store.read = vi.fn(async () => {
      readCount += 1;
      if (readCount === 2) {
        validationStarted.resolve(undefined);
        return validationRead.promise;
      }
      return current;
    });
    const action = dispatchRuntime(fixture.controller, {
      type: UI_ATTACH_OVERLAY_ACTION_REQUEST,
      action: "more",
      itemId: fixture.itemId,
      projection: WIDGET_OVERLAY_PROJECTION,
    }, createInPageWidgetContentSender());
    await flushAsyncWork();
    await validationStarted.promise;
    const originalSetTimeout = globalThis.setTimeout;
    let disconnectExpiry: (() => void) | null = null;
    const setTimeoutSpy = vi.spyOn(globalThis, "setTimeout").mockImplementation((handler, delay, ...args) => {
      if (delay === 6_000 && typeof handler === "function") {
        disconnectExpiry = () => handler(...args);
        return 60_002 as ReturnType<typeof setTimeout>;
      }
      return originalSetTimeout(handler, delay, ...args);
    });
    try {
      const disconnectListener = vi.mocked(lifecycle.disconnectEvent.addListener).mock.calls[0]?.[0] as
        | (() => void)
        | undefined;
      disconnectListener?.();
      expect(disconnectExpiry).toEqual(expect.any(Function));
      disconnectExpiry?.();
      await flushAsyncWork();
      validationRead.resolve(current);
      await expect(action).resolves.toEqual({ ok: true, data: null });
      expect(vi.mocked(lifecycle.port.postMessage).mock.calls.some(([message]) => (
        isRecord(message) && message.type === UI_ATTACH_IN_PAGE_WIDGET_ACTION
      ))).toBe(false);
    } finally {
      setTimeoutSpy.mockRestore();
    }
  });

  test.each(["release", "navigation", "revoke", "disconnect-expiry"] as const)(
    "settles a posted action waiter immediately on %s cleanup",
    async (cleanup) => {
      const fixture = await createInPageWidgetFixture();
      const lifecycle = await connectInPageWidgetLifecycle(fixture);
      const originalSetTimeout = globalThis.setTimeout;
      let disconnectExpiry: (() => void) | null = null;
      const setTimeoutSpy = vi.spyOn(globalThis, "setTimeout").mockImplementation(
        (handler, delay, ...args) => {
          if (delay === 4_000) return 40_001 as ReturnType<typeof setTimeout>;
          if (delay === 6_000 && typeof handler === "function") {
            disconnectExpiry = () => handler(...args);
            return 60_001 as ReturnType<typeof setTimeout>;
          }
          return originalSetTimeout(handler, delay, ...args);
        },
      );
      const clearTimeoutSpy = vi.spyOn(globalThis, "clearTimeout");
      try {
        await expect(dispatchRuntime(fixture.controller, {
          type: UI_ATTACH_OVERLAY_ACTION_REQUEST,
          action: "more",
          itemId: fixture.itemId,
          projection: WIDGET_OVERLAY_PROJECTION,
        }, createInPageWidgetContentSender())).resolves.toEqual({ ok: true, data: null });
        await waitForPostedWidgetActionCount(lifecycle.port, 1);

        if (cleanup === "release") {
          await dispatchRuntime(
            fixture.controller,
            createInPageWidgetCommandEnvelope(fixture.init, {
              type: "ui-attach:widget-surface-release",
            }),
            fixture.widgetSender,
          );
        } else if (cleanup === "navigation") {
          await fixture.controller.handleNavigationCommitted({
            tabId: WIDGET_TAB_ID,
            frameId: 0,
            parentFrameId: -1,
            documentId: WIDGET_TOP_DOCUMENT_ID,
            url: `${ORIGIN}/navigated-away`,
          });
        } else if (cleanup === "revoke") {
          await fixture.controller.handleNavigationCommitted({
            tabId: WIDGET_TAB_ID,
            frameId: 0,
            parentFrameId: -1,
            documentId: "replacement-top-document",
            url: `${ORIGIN}/full-navigation`,
          });
        } else {
          const disconnectListener = vi.mocked(
            lifecycle.disconnectEvent.addListener,
          ).mock.calls[0]?.[0] as (() => void) | undefined;
          disconnectListener?.();
          expect(disconnectExpiry).toEqual(expect.any(Function));
          disconnectExpiry?.();
          await flushAsyncWork();
          await expect(dispatchRuntime(
            fixture.controller,
            createInPageWidgetRegistration(fixture.init),
            fixture.widgetSender,
          )).resolves.toEqual({ ok: true, data: { registered: true } });
        }

        expect(clearTimeoutSpy).toHaveBeenCalledWith(40_001);
      } finally {
        clearTimeoutSpy.mockRestore();
        setTimeoutSpy.mockRestore();
      }
    },
  );

  test("opens authoritative extension details in the side panel when the page surface belongs to SDK", async () => {
    const onActiveSessionChanged = vi.fn(async () => undefined);
    const fixture = await createInPageWidgetFixture({ onActiveSessionChanged });
    await expect(dispatchRuntime(
      fixture.controller,
      createInPageWidgetCommandEnvelope(fixture.init, {
        type: "ui-attach:widget-surface-release",
      }),
      fixture.widgetSender,
    )).resolves.toEqual({ ok: true, data: null });
    fixture.chrome.tabs.sendMessage = vi.fn(async (_tabId, message) => isRecord(message) &&
        message.type === UI_ATTACH_IN_PAGE_WIDGET_ENSURE
      ? { ok: true, data: { delegated: true, surfaceOwner: "sdk" } }
      : undefined);
    onActiveSessionChanged.mockClear();

    await expect(dispatchRuntime(fixture.controller, {
      type: UI_ATTACH_OVERLAY_ACTION_REQUEST,
      action: "more",
      itemId: fixture.itemId,
      projection: WIDGET_OVERLAY_PROJECTION,
    }, createInPageWidgetContentSender())).resolves.toEqual({ ok: true, data: null });

    expect(fixture.chrome.sidePanel?.open).toHaveBeenCalledOnce();
    expect(onActiveSessionChanged).toHaveBeenCalledWith(expect.objectContaining({
      enabled: true,
      origin: ORIGIN,
      selectedItemId: fixture.itemId,
      activePage: expect.objectContaining({
        tabId: WIDGET_TAB_ID,
        frameId: 0,
        documentId: WIDGET_TOP_DOCUMENT_ID,
      }),
      readback: expect.objectContaining({ epoch: "epoch-1" }),
    }));
  });

  test("does not open More fallback after navigation races side-panel reconciliation", async () => {
    const reconcileStarted = createDeferred<void>();
    const finishReconcile = createDeferred<void>();
    const onActiveSessionChanged = vi.fn(async () => {
      reconcileStarted.resolve(undefined);
      await finishReconcile.promise;
    });
    const fixture = await createInPageWidgetFixture({ onActiveSessionChanged });
    await expect(dispatchRuntime(
      fixture.controller,
      createInPageWidgetCommandEnvelope(fixture.init, {
        type: "ui-attach:widget-surface-release",
      }),
      fixture.widgetSender,
    )).resolves.toEqual({ ok: true, data: null });
    fixture.chrome.tabs.sendMessage = vi.fn(async (_tabId, message) => isRecord(message) &&
        message.type === UI_ATTACH_IN_PAGE_WIDGET_ENSURE
      ? { ok: true, data: { delegated: true, surfaceOwner: "sdk" } }
      : undefined);
    onActiveSessionChanged.mockClear();

    const more = dispatchRuntime(fixture.controller, {
      type: UI_ATTACH_OVERLAY_ACTION_REQUEST,
      action: "more",
      itemId: fixture.itemId,
      projection: WIDGET_OVERLAY_PROJECTION,
    }, createInPageWidgetContentSender());
    await reconcileStarted.promise;
    const originalGetFrame = fixture.chrome.webNavigation.getFrame;
    fixture.chrome.webNavigation.getFrame = vi.fn(async (details) => {
      const frame = await originalGetFrame(details);
      return frame && details.tabId === WIDGET_TAB_ID && details.frameId === 0
        ? { ...frame, url: `${ORIGIN}/navigated-during-reconcile` }
        : frame;
    });
    finishReconcile.resolve(undefined);

    await expect(more).resolves.toMatchObject({ ok: false, code: "UNTRUSTED_SENDER" });
    expect(fixture.chrome.sidePanel?.open).not.toHaveBeenCalled();
  });

  test("R4-FALLBACK-01 compensates active state when navigation races fallback persistence", async () => {
    const onActiveSessionChanged = vi.fn(async () => undefined);
    const fixture = await createInPageWidgetFixture({ onActiveSessionChanged });
    await expect(dispatchRuntime(
      fixture.controller,
      createInPageWidgetCommandEnvelope(fixture.init, {
        type: "ui-attach:widget-surface-release",
      }),
      fixture.widgetSender,
    )).resolves.toEqual({ ok: true, data: null });
    fixture.chrome.tabs.sendMessage = vi.fn(async (_tabId, message) => isRecord(message) &&
        message.type === UI_ATTACH_IN_PAGE_WIDGET_ENSURE
      ? { ok: true, data: { delegated: true, surfaceOwner: "sdk" } }
      : undefined);
    onActiveSessionChanged.mockClear();
    const projectionBefore = await fixture.chrome.storage.session.get(
      OVERLAY_PROJECTIONS_SESSION_KEY,
    );
    const activePersisted = createDeferred<void>();
    const finishActivePersistence = createDeferred<void>();
    const originalSessionSet = fixture.chrome.storage.session.set;
    let deferredActiveWrite = false;
    fixture.chrome.storage.session.set = vi.fn(async (values) => {
      await originalSessionSet(values);
      if (!deferredActiveWrite && Object.hasOwn(values, OVERLAY_ACTIVE_ITEMS_SESSION_KEY)) {
        deferredActiveWrite = true;
        activePersisted.resolve(undefined);
        await finishActivePersistence.promise;
      }
    });

    const more = dispatchRuntime(fixture.controller, {
      type: UI_ATTACH_OVERLAY_ACTION_REQUEST,
      action: "more",
      itemId: fixture.itemId,
      projection: WIDGET_OVERLAY_PROJECTION,
    }, createInPageWidgetContentSender());
    await activePersisted.promise;
    const originalGetFrame = fixture.chrome.webNavigation.getFrame;
    fixture.chrome.webNavigation.getFrame = vi.fn(async (details) => {
      const frame = await originalGetFrame(details);
      return frame && details.tabId === WIDGET_TAB_ID && details.frameId === 0
        ? { ...frame, url: `${ORIGIN}/navigated-during-active-persist` }
        : frame;
    });
    finishActivePersistence.resolve(undefined);

    await expect(more).resolves.toMatchObject({ ok: false, code: "UNTRUSTED_SENDER" });
    expect(fixture.chrome.sidePanel?.open).not.toHaveBeenCalled();
    expect(onActiveSessionChanged).not.toHaveBeenCalled();
    const activeAfter = await fixture.chrome.storage.session.get(
      OVERLAY_ACTIVE_ITEMS_SESSION_KEY,
    );
    expect(activeAfter[OVERLAY_ACTIVE_ITEMS_SESSION_KEY] ?? []).toEqual([]);
    const projectionAfter = await fixture.chrome.storage.session.get(
      OVERLAY_PROJECTIONS_SESSION_KEY,
    );
    expect(projectionAfter).toEqual(projectionBefore);
  });

  test("drops a queued More action after a same-document History route change", async () => {
    const fixture = await createInPageWidgetFixture();
    await expect(dispatchRuntime(fixture.controller, {
      type: UI_ATTACH_OVERLAY_ACTION_REQUEST,
      action: "more",
      itemId: fixture.itemId,
      projection: WIDGET_OVERLAY_PROJECTION,
    }, createInPageWidgetContentSender())).resolves.toEqual({ ok: true, data: null });

    await fixture.controller.handleNavigationCommitted({
      tabId: WIDGET_TAB_ID,
      frameId: 0,
      parentFrameId: -1,
      documentId: WIDGET_TOP_DOCUMENT_ID,
      url: `${ORIGIN}/different-history-route`,
    });
    await fixture.controller.handleNavigationCommitted({
      tabId: WIDGET_TAB_ID,
      frameId: 0,
      parentFrameId: -1,
      documentId: WIDGET_TOP_DOCUMENT_ID,
      url: `${ORIGIN}/settings`,
    });
    const lifecycle = await connectInPageWidgetLifecycleRaw(fixture);
    await flushAsyncWork();

    expect(vi.mocked(lifecycle.port.postMessage).mock.calls.some(([message]) => (
      isRecord(message) && message.type === UI_ATTACH_IN_PAGE_WIDGET_ACTION
    ))).toBe(false);
  });

  test.each(["item-removed", "epoch-replaced"] as const)(
    "drops a queued More action when authoritative state is %s before READY",
    async (stateChange) => {
      const fixture = await createInPageWidgetFixture();
      await expect(dispatchRuntime(fixture.controller, {
        type: UI_ATTACH_OVERLAY_ACTION_REQUEST,
        action: "more",
        itemId: fixture.itemId,
        projection: WIDGET_OVERLAY_PROJECTION,
      }, createInPageWidgetContentSender())).resolves.toEqual({ ok: true, data: null });

      const record = createCaptureRecord("save", "Save changes");
      record.origin = ORIGIN;
      record.pageUrl = `${ORIGIN}/settings`;
      record.tabId = WIDGET_TAB_ID;
      record.frameId = 0;
      const replacement = stateChange === "item-removed"
        ? {
            ...createSessionReadback(record),
            file: createSessionReadback(record).file ? {
              ...createSessionReadback(record).file!,
              session: { ...createSessionReadback(record).file!.session, attachments: [] },
            } : null,
          }
        : { ...createSessionReadback(record), epoch: "epoch-replacement" };
      fixture.store.read = vi.fn(async () => ({ ok: true, value: replacement }));
      const lifecycle = await connectInPageWidgetLifecycleRaw(fixture);
      await flushAsyncWork();

      expect(vi.mocked(lifecycle.port.postMessage).mock.calls.some(([message]) => (
        isRecord(message) && message.type === UI_ATTACH_IN_PAGE_WIDGET_ACTION
      ))).toBe(false);
    },
  );

  test("restores a dormant widget lease when its first lifecycle port connects after grace", async () => {
    const originalSetTimeout = globalThis.setTimeout;
    let firstConnectExpiry: (() => void) | null = null;
    const setTimeoutSpy = vi.spyOn(globalThis, "setTimeout").mockImplementation((handler, delay, ...args) => {
      if (delay === 6_000 && typeof handler === "function") {
        firstConnectExpiry = () => handler(...args);
        return 60_001 as ReturnType<typeof setTimeout>;
      }
      return originalSetTimeout(handler, delay, ...args);
    });
    try {
      const fixture = await createInPageWidgetFixture();
      await expect(dispatchRuntime(fixture.controller, {
        type: UI_ATTACH_OVERLAY_ACTION_REQUEST,
        action: "more",
        itemId: fixture.itemId,
        projection: WIDGET_OVERLAY_PROJECTION,
      }, createInPageWidgetContentSender())).resolves.toEqual({ ok: true, data: null });
      expect(firstConnectExpiry).toEqual(expect.any(Function));
      firstConnectExpiry?.();
      await flushAsyncWork();
      fixture.controller.register();
      const connectListener = vi.mocked(fixture.chrome.runtime.onConnect.addListener).mock.calls[0]?.[0] as
        | ((port: UiAttachChromePort) => void)
        | undefined;
      if (!connectListener) throw new Error("runtime connect listener was not registered");
      const readyPosted = createDeferred<void>();
      const port = {
        name: createInPageWidgetLifecyclePortName(fixture.init.surfaceId, fixture.init.capability),
        sender: fixture.widgetSender,
        disconnect: vi.fn(),
        postMessage: vi.fn((message: unknown) => {
          if (isRecord(message) && message.type === UI_ATTACH_IN_PAGE_WIDGET_READY) {
            readyPosted.resolve(undefined);
          }
        }),
        onDisconnect: createEventHarness<() => void>(),
      } satisfies UiAttachChromePort;
      connectListener(port);
      await readyPosted.promise;

      expect(port.disconnect).not.toHaveBeenCalled();
      expect(port.postMessage).toHaveBeenCalledWith({
        type: UI_ATTACH_IN_PAGE_WIDGET_READY,
        surfaceId: fixture.init.surfaceId,
      });
      expect(vi.mocked(port.postMessage).mock.calls.some(([message]) => (
        isRecord(message) && message.type === UI_ATTACH_IN_PAGE_WIDGET_ACTION
      ))).toBe(false);
    } finally {
      setTimeoutSpy.mockRestore();
    }
  });

  test("pins a lifecycle lease while its sender inventory is being validated", async () => {
    const originalSetTimeout = globalThis.setTimeout;
    let firstConnectExpiry: (() => void) | null = null;
    const setTimeoutSpy = vi.spyOn(globalThis, "setTimeout").mockImplementation((handler, delay, ...args) => {
      if (delay === 6_000 && typeof handler === "function" && firstConnectExpiry === null) {
        firstConnectExpiry = () => handler(...args);
        return 60_002 as ReturnType<typeof setTimeout>;
      }
      return originalSetTimeout(handler, delay, ...args);
    });
    try {
      const fixture = await createInPageWidgetFixture();
      expect(firstConnectExpiry).toEqual(expect.any(Function));
      const originalGetFrame = fixture.chrome.webNavigation.getFrame;
      const lookupStarted = createDeferred<void>();
      const releaseLookup = createDeferred<Awaited<ReturnType<typeof originalGetFrame>>>();
      let delayed = false;
      fixture.chrome.webNavigation.getFrame = vi.fn(async (details) => {
        if (details.frameId === 0 && !delayed) {
          delayed = true;
          lookupStarted.resolve(undefined);
          return releaseLookup.promise;
        }
        return originalGetFrame(details);
      });
      fixture.controller.register();
      const connectListener = vi.mocked(fixture.chrome.runtime.onConnect.addListener).mock.calls[0]?.[0] as
        | ((port: UiAttachChromePort) => void)
        | undefined;
      if (!connectListener) throw new Error("runtime connect listener was not registered");
      const port = {
        name: createInPageWidgetLifecyclePortName(fixture.init.surfaceId, fixture.init.capability),
        sender: fixture.widgetSender,
        disconnect: vi.fn(),
        postMessage: vi.fn(),
        onDisconnect: createEventHarness<() => void>(),
        onMessage: createEventHarness<(message: unknown) => void>(),
      } satisfies UiAttachChromePort;

      connectListener(port);
      await lookupStarted.promise;
      firstConnectExpiry?.();
      releaseLookup.resolve({
        documentId: WIDGET_TOP_DOCUMENT_ID,
        parentFrameId: -1,
        url: `${ORIGIN}/settings`,
      });
      await waitFor(() => vi.mocked(port.postMessage).mock.calls.some(([message]) => (
        isRecord(message) && message.type === UI_ATTACH_IN_PAGE_WIDGET_READY
      )));

      expect(port.disconnect).not.toHaveBeenCalled();
      expect(port.postMessage).toHaveBeenCalledWith({
        type: UI_ATTACH_IN_PAGE_WIDGET_READY,
        surfaceId: fixture.init.surfaceId,
      });
    } finally {
      setTimeoutSpy.mockRestore();
    }
  });

  test("keeps a lease pinned until every overlapping widget operation completes", async () => {
    const originalSetTimeout = globalThis.setTimeout;
    const expiryCallbacks: Array<() => void> = [];
    const setTimeoutSpy = vi.spyOn(globalThis, "setTimeout").mockImplementation((handler, delay, ...args) => {
      if (delay === 6_000 && typeof handler === "function") {
        expiryCallbacks.push(() => handler(...args));
        return (61_000 + expiryCallbacks.length) as ReturnType<typeof setTimeout>;
      }
      return originalSetTimeout(handler, delay, ...args);
    });
    try {
      const fixture = await createInPageWidgetFixture();
      const current = await fixture.store.read(ORIGIN);
      if (!current.ok) throw new Error("fixture session missing");
      const saveStarted = createDeferred<void>();
      const releaseSave = createDeferred<typeof current>();
      fixture.store.updateIntent = vi.fn(async () => {
        saveStarted.resolve(undefined);
        return releaseSave.promise;
      });

      const saving = dispatchRuntime(
        fixture.controller,
        createInPageWidgetCommandEnvelope(fixture.init, {
          type: "ui-attach:widget-task-note-save",
          expectedEpoch: current.value.epoch,
          itemId: fixture.itemId,
          taskNote: "Pinned save",
        }),
        fixture.widgetSender,
      );
      await saveStarted.promise;
      await expect(dispatchRuntime(
        fixture.controller,
        createInPageWidgetRegistration(fixture.init),
        fixture.widgetSender,
      )).resolves.toEqual({ ok: true, data: { registered: true } });
      for (const expire of [...expiryCallbacks]) expire();
      await flushAsyncWork();

      await expect(dispatchRuntime(
        fixture.controller,
        { type: UI_ATTACH_OVERLAY_VISIBILITY_GET },
        createInPageWidgetContentSender(),
      )).resolves.toEqual({ ok: true, data: { visible: true } });
      releaseSave.resolve(current);
      await expect(saving).resolves.toMatchObject({ ok: true });

      const finalExpiry = expiryCallbacks.at(-1);
      expect(finalExpiry).toEqual(expect.any(Function));
      finalExpiry?.();
      await flushAsyncWork();
      await expect(dispatchRuntime(
        fixture.controller,
        { type: UI_ATTACH_OVERLAY_VISIBILITY_GET },
        createInPageWidgetContentSender(),
      )).resolves.toEqual({ ok: true, data: { visible: false } });
    } finally {
      setTimeoutSpy.mockRestore();
    }
  });

  test("removes an owned marker authoritatively without a widget port and confirms readback", async () => {
    const onActiveSessionChanged = vi.fn(async () => undefined);
    const fixture = await createInPageWidgetFixture({ onActiveSessionChanged });
    const record = createCaptureRecord("save", "Save changes");
    record.origin = ORIGIN;
    record.pageUrl = `${ORIGIN}/settings`;
    record.tabId = WIDGET_TAB_ID;
    record.frameId = 0;
    let current = createSessionReadback(record);
    fixture.store.read = vi.fn(async () => ({ ok: true, value: current }));
    fixture.store.removeItem = vi.fn(async () => {
      current = {
        ...current,
        file: current.file ? {
          ...current.file,
          session: { ...current.file.session, attachments: [] },
        } : null,
      };
      return { ok: true, value: current };
    });
    vi.mocked(fixture.chrome.tabs.sendMessage).mockClear();
    onActiveSessionChanged.mockClear();

    await expect(dispatchRuntime(fixture.controller, {
      type: UI_ATTACH_OVERLAY_ACTION_REQUEST,
      action: "remove",
      itemId: fixture.itemId,
      projection: WIDGET_OVERLAY_PROJECTION,
    }, createInPageWidgetContentSender())).resolves.toEqual({ ok: true, data: null });

    expect(fixture.store.removeItem).toHaveBeenCalledWith(
      ORIGIN,
      "epoch-1",
      fixture.itemId,
      expect.objectContaining({
        isCurrent: expect.any(Function),
        refresh: expect.any(Function),
      }),
    );
    expect(fixture.store.read).toHaveBeenCalledTimes(4);
    expect(vi.mocked(fixture.store.removeItem).mock.invocationCallOrder[0])
      .toBeLessThan(vi.mocked(fixture.store.read).mock.invocationCallOrder[1]!);
    expect(vi.mocked(fixture.store.read).mock.invocationCallOrder[1])
      .toBeLessThan(vi.mocked(fixture.store.read).mock.invocationCallOrder[2]!);
    expect(vi.mocked(fixture.chrome.tabs.sendMessage).mock.calls.map(([, message]) => message))
      .toContainEqual(expect.objectContaining({
        type: UI_ATTACH_OVERLAY_STATE,
        origin: ORIGIN,
        activeItemId: null,
        items: [],
      }));
    expect(onActiveSessionChanged).toHaveBeenCalledWith(expect.objectContaining({
      origin: ORIGIN,
      readback: expect.objectContaining({
        file: expect.objectContaining({ session: expect.objectContaining({ attachments: [] }) }),
      }),
    }));
  });

  test("marker removal reports diagnostics cleanup failure and a panel retry retires the residue", async () => {
    const onActiveSessionChanged = vi.fn(async () => undefined);
    const fixture = await createInPageWidgetFixture({ onActiveSessionChanged });
    const record = createCaptureRecord("save", "Save changes");
    record.origin = ORIGIN;
    record.pageUrl = `${ORIGIN}/settings`;
    record.tabId = WIDGET_TAB_ID;
    record.frameId = 0;
    let current = createSessionReadback(record);
    fixture.store.read = vi.fn(async () => ({ ok: true, value: structuredClone(current) }));
    fixture.store.removeItem = vi.fn(async () => {
      current = {
        ...current,
        file: current.file ? {
          ...current.file,
          session: { ...current.file.session, attachments: [] },
        } : null,
      };
      return { ok: true, value: structuredClone(current) };
    });
    const diagnosticsKey = getMetadataDiagnosticsSessionStorageKey(ORIGIN);
    await fixture.chrome.storage.session.set({ [diagnosticsKey]: { pending: true } });
    const originalSessionRemove = fixture.chrome.storage.session.remove;
    let rejectDiagnosticsCleanup = true;
    fixture.chrome.storage.session.remove = vi.fn(async (keys) => {
      const removesDiagnostics = Array.isArray(keys)
        ? keys.includes(diagnosticsKey)
        : keys === diagnosticsKey;
      if (rejectDiagnosticsCleanup && removesDiagnostics) {
        rejectDiagnosticsCleanup = false;
        throw new Error("simulated diagnostics cleanup failure");
      }
      await originalSessionRemove(keys);
    });
    vi.mocked(fixture.chrome.tabs.sendMessage).mockClear();
    onActiveSessionChanged.mockClear();

    await expect(dispatchRuntime(fixture.controller, {
      type: UI_ATTACH_OVERLAY_ACTION_REQUEST,
      action: "remove",
      itemId: fixture.itemId,
      projection: WIDGET_OVERLAY_PROJECTION,
    }, createInPageWidgetContentSender())).resolves.toMatchObject({
      ok: false,
      code: "STORAGE_ERROR",
    });
    expect(current.file?.session.attachments).toEqual([]);
    expect((await fixture.chrome.storage.session.get(diagnosticsKey))[diagnosticsKey]).toBeDefined();
    expect(onActiveSessionChanged).not.toHaveBeenCalled();

    await expect(dispatchRuntime(fixture.controller, {
      type: "ui-attach:session-remove-item",
      origin: ORIGIN,
      epoch: current.epoch!,
      itemId: fixture.itemId,
    }, createExtensionSender())).resolves.toMatchObject({ ok: true });
    expect((await fixture.chrome.storage.session.get(diagnosticsKey))[diagnosticsKey]).toBeUndefined();
    expect(onActiveSessionChanged).toHaveBeenCalledOnce();
  });

  test("does not report marker removal success when authoritative readback still owns the item", async () => {
    const onActiveSessionChanged = vi.fn(async () => undefined);
    const fixture = await createInPageWidgetFixture({ onActiveSessionChanged });
    const record = createCaptureRecord("save", "Save changes");
    record.origin = ORIGIN;
    record.pageUrl = `${ORIGIN}/settings`;
    record.tabId = WIDGET_TAB_ID;
    record.frameId = 0;
    const unchanged = createSessionReadback(record);
    const removed = {
      ...unchanged,
      file: unchanged.file ? {
        ...unchanged.file,
        session: { ...unchanged.file.session, attachments: [] },
      } : null,
    };
    fixture.store.read = vi.fn(async () => ({ ok: true, value: unchanged }));
    fixture.store.removeItem = vi.fn(async () => ({ ok: true, value: removed }));
    vi.mocked(fixture.chrome.tabs.sendMessage).mockClear();
    onActiveSessionChanged.mockClear();

    await expect(dispatchRuntime(fixture.controller, {
      type: UI_ATTACH_OVERLAY_ACTION_REQUEST,
      action: "remove",
      itemId: fixture.itemId,
      projection: WIDGET_OVERLAY_PROJECTION,
    }, createInPageWidgetContentSender())).resolves.toMatchObject({
      ok: false,
      code: "CAPTURE_FAILED",
    });

    expect(fixture.store.removeItem).toHaveBeenCalledOnce();
    expect(fixture.store.read).toHaveBeenCalledTimes(2);
    expect(vi.mocked(fixture.chrome.tabs.sendMessage).mock.calls.some(([, message]) => (
      isRecord(message) && message.type === UI_ATTACH_OVERLAY_STATE
    ))).toBe(false);
    expect(onActiveSessionChanged).not.toHaveBeenCalled();
  });

  test("reports a confirmed marker removal without syncing or reconciling a navigated document", async () => {
    const onActiveSessionChanged = vi.fn(async () => undefined);
    const fixture = await createInPageWidgetFixture({ onActiveSessionChanged });
    const record = createCaptureRecord("save", "Save changes");
    record.origin = ORIGIN;
    record.pageUrl = `${ORIGIN}/settings`;
    record.tabId = WIDGET_TAB_ID;
    record.frameId = 0;
    const previous = createSessionReadback(record);
    const removed = {
      ...previous,
      file: previous.file ? {
        ...previous.file,
        session: { ...previous.file.session, attachments: [] },
      } : null,
    };
    const confirmation = createDeferred<{ ok: true; value: ActiveSessionReadback }>();
    let readCount = 0;
    fixture.store.read = vi.fn(async () => {
      readCount += 1;
      return readCount === 1 ? { ok: true as const, value: previous } : confirmation.promise;
    });
    fixture.store.removeItem = vi.fn(async () => ({ ok: true, value: removed }));
    const originalGetFrame = fixture.chrome.webNavigation.getFrame;
    let livePathname = "/settings";
    fixture.chrome.webNavigation.getFrame = vi.fn(async (details) => {
      const frame = await originalGetFrame(details);
      return frame && details.tabId === WIDGET_TAB_ID && details.frameId === 0
        ? { ...frame, url: `${ORIGIN}${livePathname}` }
        : frame;
    });
    vi.mocked(fixture.chrome.tabs.sendMessage).mockClear();
    onActiveSessionChanged.mockClear();

    const remove = dispatchRuntime(fixture.controller, {
      type: UI_ATTACH_OVERLAY_ACTION_REQUEST,
      action: "remove",
      itemId: fixture.itemId,
      projection: WIDGET_OVERLAY_PROJECTION,
    }, createInPageWidgetContentSender());
    await waitFor(() => vi.mocked(fixture.store.removeItem).mock.calls.length === 1);
    livePathname = "/navigated-after-remove";
    confirmation.resolve({ ok: true, value: removed });

    await expect(remove).resolves.toEqual({ ok: true, data: null });
    expect(vi.mocked(fixture.chrome.tabs.sendMessage).mock.calls.some(([, message]) => (
      isRecord(message) && message.type === UI_ATTACH_OVERLAY_STATE
    ))).toBe(false);
    expect(onActiveSessionChanged).not.toHaveBeenCalled();
  });

  test("saves an owned marker note through CAS readback and preserves durable active state", async () => {
    const onActiveSessionChanged = vi.fn(async () => undefined);
    const fixture = await createInPageWidgetFixture({ onActiveSessionChanged });
    const lifecycle = await connectInPageWidgetLifecycle(fixture);
    const record = createCaptureRecord("save", "Save changes");
    record.origin = ORIGIN;
    record.pageUrl = `${ORIGIN}/settings`;
    record.tabId = WIDGET_TAB_ID;
    record.frameId = 0;
    record.intent = "Old note";
    let current = createSessionReadback(record);
    fixture.store.read = vi.fn(async () => ({ ok: true, value: current }));
    fixture.store.updateIntent = vi.fn(async (origin, epoch, itemId, intent) => {
      const updatedRecord = { ...record, intent };
      current = createSessionReadback(updatedRecord);
      return { ok: true, value: current };
    });

    await expect(dispatchRuntime(
      fixture.controller,
      createInPageWidgetCommandEnvelope(fixture.init, {
        type: "ui-attach:widget-overlay-active",
        itemId: fixture.itemId,
      }),
      fixture.widgetSender,
    )).resolves.toEqual({ ok: true, data: null });
    const saveProjection = await restoreAndAcknowledgeProjection(
      fixture.controller,
      createInPageWidgetContentSender(),
    );
    vi.mocked(fixture.chrome.tabs.sendMessage).mockClear();
    vi.mocked(fixture.store.read).mockClear();
    vi.mocked(fixture.store.updateIntent).mockClear();
    lifecycle.port.postMessage.mockClear();
    onActiveSessionChanged.mockClear();

    await expect(dispatchRuntime(fixture.controller, {
      type: UI_ATTACH_OVERLAY_ACTION_REQUEST,
      action: "save",
      itemId: fixture.itemId,
      taskNote: "Updated marker note",
      projection: saveProjection,
    }, createInPageWidgetContentSender())).resolves.toEqual({ ok: true, data: null });

    expect(fixture.store.updateIntent).toHaveBeenCalledWith(
      ORIGIN,
      "epoch-1",
      fixture.itemId,
      "Updated marker note",
      expect.objectContaining({
        isCurrent: expect.any(Function),
        refresh: expect.any(Function),
      }),
    );
    expect(vi.mocked(fixture.store.read).mock.invocationCallOrder[0])
      .toBeLessThan(vi.mocked(fixture.store.updateIntent).mock.invocationCallOrder[0]!);
    const overlayStates = vi.mocked(fixture.chrome.tabs.sendMessage).mock.calls
      .map(([, message]) => message)
      .filter((message) => isRecord(message) && message.type === UI_ATTACH_OVERLAY_STATE);
    expect(overlayStates).toContainEqual(expect.objectContaining({
      type: UI_ATTACH_OVERLAY_STATE,
      origin: ORIGIN,
      activeItemId: fixture.itemId,
      items: [{
        itemId: fixture.itemId,
        attachmentId: fixture.itemId,
        label: "1",
        taskNote: "Updated marker note",
      }],
    }));
    expect(lifecycle.port.postMessage).not.toHaveBeenCalled();
    expect(onActiveSessionChanged).toHaveBeenCalledWith(expect.objectContaining({
      origin: ORIGIN,
      selectedItemId: fixture.itemId,
      readback: expect.objectContaining({ epoch: "epoch-1" }),
    }));
  });

  test("reports a committed marker save truthfully without syncing or reconciling a navigated document", async () => {
    const onActiveSessionChanged = vi.fn(async () => undefined);
    const fixture = await createInPageWidgetFixture({ onActiveSessionChanged });
    const record = createCaptureRecord("save", "Save changes");
    record.origin = ORIGIN;
    record.pageUrl = `${ORIGIN}/settings`;
    record.tabId = WIDGET_TAB_ID;
    record.frameId = 0;
    record.intent = "Old note";
    const previous = createSessionReadback(record);
    const updated = createSessionReadback({ ...record, intent: "Committed during navigation" });
    const confirmation = createDeferred<{ ok: true; value: ActiveSessionReadback }>();
    let readCount = 0;
    fixture.store.read = vi.fn(async () => {
      readCount += 1;
      return readCount === 1 ? { ok: true as const, value: previous } : confirmation.promise;
    });
    fixture.store.updateIntent = vi.fn(async () => ({ ok: true, value: updated }));
    const originalGetFrame = fixture.chrome.webNavigation.getFrame;
    let livePathname = "/settings";
    fixture.chrome.webNavigation.getFrame = vi.fn(async (details) => {
      const frame = await originalGetFrame(details);
      return frame && details.tabId === WIDGET_TAB_ID && details.frameId === 0
        ? { ...frame, url: `${ORIGIN}${livePathname}` }
        : frame;
    });
    vi.mocked(fixture.chrome.tabs.sendMessage).mockClear();
    onActiveSessionChanged.mockClear();

    const save = dispatchRuntime(fixture.controller, {
      type: UI_ATTACH_OVERLAY_ACTION_REQUEST,
      action: "save",
      itemId: fixture.itemId,
      taskNote: "Committed during navigation",
      projection: WIDGET_OVERLAY_PROJECTION,
    }, createInPageWidgetContentSender());
    await waitFor(() => vi.mocked(fixture.store.updateIntent).mock.calls.length === 1);
    livePathname = "/navigated-after-save";
    confirmation.resolve({ ok: true, value: updated });

    await expect(save).resolves.toEqual({ ok: true, data: null });
    expect(vi.mocked(fixture.chrome.tabs.sendMessage).mock.calls.some(([, message]) => (
      isRecord(message) && message.type === UI_ATTACH_OVERLAY_STATE
    ))).toBe(false);
    expect(onActiveSessionChanged).not.toHaveBeenCalled();
  });

  test("hydrates persisted active state before the first marker save after a worker restart", async () => {
    const sessionState: Record<string, unknown> = {
      [OVERLAY_ACTIVE_ITEMS_SESSION_KEY]: [{ origin: ORIGIN, itemId: "att_save" }],
    };
    const onActiveSessionChanged = vi.fn(async () => undefined);
    const fixture = await createInPageWidgetFixture({
      onActiveSessionChanged,
      configureChrome: (chrome) => {
        chrome.storage.session.get = vi.fn(async (key) => (
          typeof key === "string" && key in sessionState
            ? { [key]: sessionState[key] }
            : {}
        ));
        chrome.storage.session.set = vi.fn(async (values) => {
          Object.assign(sessionState, values);
        });
      },
    });
    const restartedController = createBackgroundController({
      chrome: fixture.chrome,
      store: fixture.store,
      onActiveSessionChanged,
    });
    const record = createCaptureRecord("save", "Save changes");
    record.origin = ORIGIN;
    record.pageUrl = `${ORIGIN}/settings`;
    record.tabId = WIDGET_TAB_ID;
    record.frameId = 0;
    record.intent = "Old note";
    let current = createSessionReadback(record);
    fixture.store.read = vi.fn(async () => ({ ok: true, value: current }));
    fixture.store.updateIntent = vi.fn(async (_origin, _epoch, _itemId, intent) => {
      current = createSessionReadback({ ...record, intent });
      return { ok: true, value: current };
    });
    const restartedProjection = await restoreAndAcknowledgeProjection(
      restartedController,
      createInPageWidgetContentSender(),
    );
    vi.mocked(fixture.chrome.tabs.sendMessage).mockClear();
    onActiveSessionChanged.mockClear();

    await expect(dispatchRuntime(restartedController, {
      type: UI_ATTACH_OVERLAY_ACTION_REQUEST,
      action: "save",
      itemId: fixture.itemId,
      taskNote: "First save after restart",
      projection: restartedProjection,
    }, createInPageWidgetContentSender())).resolves.toEqual({ ok: true, data: null });

    const overlayStates = vi.mocked(fixture.chrome.tabs.sendMessage).mock.calls
      .map(([, message]) => message)
      .filter((message) => isRecord(message) && message.type === UI_ATTACH_OVERLAY_STATE);
    expect(overlayStates).toContainEqual(expect.objectContaining({
      activeItemId: fixture.itemId,
      items: [expect.objectContaining({
        itemId: fixture.itemId,
        taskNote: "First save after restart",
      })],
    }));
    expect(sessionState[OVERLAY_ACTIVE_ITEMS_SESSION_KEY]).toEqual([
      { origin: ORIGIN, itemId: fixture.itemId },
    ]);
    expect(vi.mocked(fixture.chrome.tabs.sendMessage).mock.calls.some(([, message]) => (
      isRecord(message) && (
        message.type === UI_ATTACH_IN_PAGE_WIDGET_ENSURE ||
        message.type === UI_ATTACH_IN_PAGE_WIDGET_INIT
      )
    ))).toBe(false);
    expect(onActiveSessionChanged).not.toHaveBeenCalled();
  });

  test("persists pending versus acknowledged projections across worker recreation", async () => {
    const fixture = await createInPageWidgetFixture();
    const sender = createInPageWidgetContentSender();
    const record = createCaptureRecord("save", "Save changes");
    record.origin = ORIGIN;
    record.pageUrl = `${ORIGIN}/settings`;
    record.tabId = WIDGET_TAB_ID;
    record.frameId = 0;
    record.intent = "Old note";
    let current = createSessionReadback(record);
    fixture.store.read = vi.fn(async () => ({ ok: true, value: current }));
    fixture.store.updateIntent = vi.fn(async (_origin, _epoch, _itemId, intent) => {
      current = createSessionReadback({ ...record, intent });
      return { ok: true, value: current };
    });

    vi.mocked(fixture.chrome.tabs.sendMessage).mockClear();
    await expect(dispatchRuntime(fixture.controller, {
      type: "ui-attach:overlays-sync",
      origin: ORIGIN,
      activeItemId: null,
    }, createExtensionSender())).resolves.toEqual({ ok: true, data: null });
    const pendingState = vi.mocked(fixture.chrome.tabs.sendMessage).mock.calls
      .map(([, message]) => message)
      .find(isOverlayStateMessage);
    if (!pendingState) throw new Error("pending overlay projection was not delivered");
    const pendingProjection = {
      version: pendingState.projection.version,
      projectionId: pendingState.projection.projectionId,
      revision: pendingState.projection.revision,
    };
    const restartedPending = createBackgroundController({
      chrome: fixture.chrome,
      store: fixture.store,
      ensureContentScript: fixture.ensureContentScript,
    });
    await expect(dispatchRuntime(restartedPending, {
      type: UI_ATTACH_OVERLAY_ACTION_REQUEST,
      action: "save",
      itemId: record.attachment.id,
      taskNote: "Must remain rejected without ACK",
      projection: pendingProjection,
    }, sender)).resolves.toMatchObject({
      ok: false,
      code: "OVERLAY_PROJECTION_REACK_REQUIRED",
    });
    expect(fixture.store.updateIntent).not.toHaveBeenCalled();

    const acknowledgedProjection = await restoreAndAcknowledgeProjection(
      restartedPending,
      sender,
    );
    await expect(dispatchRuntime(restartedPending, {
      type: UI_ATTACH_OVERLAY_ACTION_REQUEST,
      action: "save",
      itemId: record.attachment.id,
      taskNote: "Reject stale revision",
      projection: {
        ...acknowledgedProjection,
        revision: acknowledgedProjection.revision + 1,
      },
    }, sender)).resolves.toMatchObject({
      ok: false,
      code: "UNTRUSTED_SENDER",
    });
    await expect(dispatchRuntime(restartedPending, {
      type: UI_ATTACH_OVERLAY_ACTION_REQUEST,
      action: "save",
      itemId: record.attachment.id,
      taskNote: "Reject stale projection ID",
      projection: {
        ...acknowledgedProjection,
        projectionId: "11dbfe8e-ce2a-4bec-9761-226faf44ccaf",
      },
    }, sender)).resolves.toMatchObject({
      ok: false,
      code: "UNTRUSTED_SENDER",
    });
    const restartedAcknowledged = createBackgroundController({
      chrome: fixture.chrome,
      store: fixture.store,
      ensureContentScript: fixture.ensureContentScript,
    });
    await expect(dispatchRuntime(restartedAcknowledged, {
      type: UI_ATTACH_OVERLAY_ACTION_REQUEST,
      action: "save",
      itemId: record.attachment.id,
      taskNote: "Must re-ACK after acknowledged restart",
      projection: acknowledgedProjection,
    }, sender)).resolves.toMatchObject({
      ok: false,
      code: "OVERLAY_PROJECTION_REACK_REQUIRED",
    });
    expect(fixture.store.updateIntent).not.toHaveBeenCalled();

    const reacknowledgedProjection = await restoreAndAcknowledgeProjection(
      restartedAcknowledged,
      sender,
    );
    expect(reacknowledgedProjection).toEqual({
      ...acknowledgedProjection,
      revision: acknowledgedProjection.revision + 1,
    });
    await expect(dispatchRuntime(restartedAcknowledged, {
      type: UI_ATTACH_OVERLAY_ACTION_REQUEST,
      action: "save",
      itemId: record.attachment.id,
      taskNote: "Saved only after live re-ACK",
      projection: reacknowledgedProjection,
    }, sender)).resolves.toEqual({ ok: true, data: null });
    expect(fixture.store.updateIntent).toHaveBeenCalledTimes(1);
    expect(fixture.store.updateIntent).toHaveBeenCalledWith(
      ORIGIN,
      "epoch-1",
      record.attachment.id,
      "Saved only after live re-ACK",
      expect.objectContaining({
        isCurrent: expect.any(Function),
        refresh: expect.any(Function),
      }),
    );
  });

  test("reconciles the Agent session after an exact live overlay projection ACK", async () => {
    const onActiveSessionChanged = vi.fn(async () => undefined);
    const fixture = await createInPageWidgetFixture({ onActiveSessionChanged });
    const sender = createInPageWidgetContentSender();
    const restored = await dispatchRuntime(fixture.controller, {
      type: "ui-attach:overlays-restore-get",
    }, sender);
    if (!isOverlayRestoreResponse(restored)) {
      throw new Error("overlay projection restore failed");
    }
    const projection = {
      version: restored.data.projection.version,
      projectionId: restored.data.projection.projectionId,
      revision: restored.data.projection.revision,
    };
    onActiveSessionChanged.mockClear();
    const staleDocumentUrlSender = {
      ...sender,
      url: `${ORIGIN}/spa/a`,
    };

    await expect(dispatchRuntime(fixture.controller, {
      type: UI_ATTACH_OVERLAY_PROJECTION_ACK,
      projection,
    }, staleDocumentUrlSender)).resolves.toEqual({ ok: true, data: { accepted: true } });

    expect(onActiveSessionChanged).toHaveBeenCalledTimes(1);
    expect(onActiveSessionChanged).toHaveBeenLastCalledWith(expect.objectContaining({
      enabled: true,
      origin: ORIGIN,
      currentItemIds: [fixture.itemId],
      activePage: expect.objectContaining({
        tabId: WIDGET_TAB_ID,
        frameId: 0,
        documentId: WIDGET_TOP_DOCUMENT_ID,
      }),
    }));
    expect(fixture.chrome.runtime.sentMessages).toContainEqual({
      type: UI_ATTACH_OVERLAY_PROJECTION_UPDATED,
    });
  });

  test("reuses an identical live restore projection until its exact ACK publishes current items", async () => {
    const onActiveSessionChanged = vi.fn(async () => undefined);
    const fixture = await createInPageWidgetFixture({ onActiveSessionChanged });
    const sender = createInPageWidgetContentSender();
    const save = createCaptureRecord("save", "Save changes");
    const cancel = createCaptureRecord("cancel", "Cancel");
    for (const record of [save, cancel]) {
      record.origin = ORIGIN;
      record.pageUrl = `${ORIGIN}/settings`;
      record.tabId = WIDGET_TAB_ID;
      record.frameId = 0;
    }
    const cancelPrimary = cancel.attachment.locatorBundle.primary;
    if (cancelPrimary && cancel.attachment.locatorBundle.stability) {
      cancel.attachment.locatorBundle.stability.verifiedValue = cancelPrimary.value;
    }
    const current = createSessionReadbackMany([save, cancel]);
    fixture.store.read = vi.fn(async () => ({ ok: true, value: current }));
    onActiveSessionChanged.mockClear();

    const first = await dispatchRuntime(fixture.controller, {
      type: "ui-attach:overlays-restore-get",
    }, sender);
    const duplicate = await dispatchRuntime(fixture.controller, {
      type: "ui-attach:overlays-restore-get",
    }, sender);
    if (!isOverlayRestoreResponse(first) || !isOverlayRestoreResponse(duplicate)) {
      throw new Error("overlay projection restore failed");
    }
    expect(duplicate.data.projection).toEqual(first.data.projection);
    const projection = {
      version: first.data.projection.version,
      projectionId: first.data.projection.projectionId,
      revision: first.data.projection.revision,
    };

    await expect(dispatchRuntime(fixture.controller, {
      type: UI_ATTACH_OVERLAY_PROJECTION_ACK,
      projection,
    }, sender)).resolves.toEqual({ ok: true, data: { accepted: true } });

    expect(onActiveSessionChanged).toHaveBeenCalledTimes(1);
    expect(onActiveSessionChanged).toHaveBeenLastCalledWith(expect.objectContaining({
      enabled: true,
      origin: ORIGIN,
      currentItemIds: [save.attachment.id, cancel.attachment.id],
    }));
    await expect(dispatchRuntime(
      fixture.controller,
      createInPageWidgetCommandEnvelope(fixture.init, {
        type: "ui-attach:widget-session-read",
      }),
      fixture.widgetSender,
    )).resolves.toMatchObject({
      ok: true,
      data: {
        currentItemIds: [save.attachment.id, cancel.attachment.id],
      },
    });
    const registry = await fixture.chrome.storage.session.get(
      OVERLAY_PROJECTIONS_SESSION_KEY,
    );
    expect(registry[OVERLAY_PROJECTIONS_SESSION_KEY]).toMatchObject({
      records: [{
        projection: first.data.projection,
        itemIds: [save.attachment.id, cancel.attachment.id],
        delivery: "acknowledged",
      }],
    });
  });

  test("asks an exact live restored marker to re-ACK after worker recreation before removing it", async () => {
    const fixture = await createInPageWidgetFixture();
    const sender = createInPageWidgetContentSender();
    const record = createCaptureRecord("save", "Save changes");
    record.origin = ORIGIN;
    record.pageUrl = `${ORIGIN}/settings`;
    record.tabId = WIDGET_TAB_ID;
    record.frameId = 0;
    let current = createSessionReadback(record);
    fixture.store.read = vi.fn(async () => ({ ok: true, value: current }));
    fixture.store.removeItem = vi.fn(async () => {
      current = createSessionReadbackMany([]);
      return { ok: true, value: current };
    });

    const projection = await restoreAndAcknowledgeProjection(fixture.controller, sender);
    const authority = await fixture.chrome.storage.local.get(
      OVERLAY_PROJECTION_AUTHORITY_GENERATION_KEY,
    );
    const registry = await fixture.chrome.storage.session.get(OVERLAY_PROJECTIONS_SESSION_KEY);
    expect(authority[OVERLAY_PROJECTION_AUTHORITY_GENERATION_KEY]).toEqual(expect.any(Number));
    expect(registry[OVERLAY_PROJECTIONS_SESSION_KEY]).toMatchObject({
      generation: authority[OVERLAY_PROJECTION_AUTHORITY_GENERATION_KEY],
      records: [{
        projection: {
          ...projection,
          sessionEpoch: "epoch-1",
          subject: {
            tabId: WIDGET_TAB_ID,
            frameId: 0,
            documentId: WIDGET_TOP_DOCUMENT_ID,
            origin: ORIGIN,
            pathname: "/settings",
          },
        },
        itemIds: [record.attachment.id],
        delivery: "acknowledged",
      }],
    });
    const restarted = createBackgroundController({
      chrome: fixture.chrome,
      store: fixture.store,
      ensureContentScript: fixture.ensureContentScript,
    });

    await expect(dispatchRuntime(restarted, {
      type: UI_ATTACH_OVERLAY_ACTION_REQUEST,
      action: "remove",
      itemId: record.attachment.id,
      projection,
    }, sender)).resolves.toMatchObject({
      ok: false,
      code: "OVERLAY_PROJECTION_REACK_REQUIRED",
    });
    expect(fixture.store.removeItem).not.toHaveBeenCalled();

    await expect(dispatchRuntime(restarted, {
      type: UI_ATTACH_OVERLAY_PROJECTION_ACK,
      projection,
    }, sender)).resolves.toEqual({ ok: true, data: { accepted: true } });
    await expect(dispatchRuntime(restarted, {
      type: UI_ATTACH_OVERLAY_ACTION_REQUEST,
      action: "remove",
      itemId: record.attachment.id,
      projection,
    }, sender)).resolves.toEqual({ ok: true, data: null });
    expect(fixture.store.removeItem).toHaveBeenCalledOnce();
  });

  test("rejects an ACK whose detached record is replaced during final endpoint validation", async () => {
    const fixture = await createInPageWidgetFixture();
    const sender = createInPageWidgetContentSender();
    const save = createCaptureRecord("save", "Save changes");
    const cancel = createCaptureRecord("cancel", "Cancel");
    for (const record of [save, cancel]) {
      record.origin = ORIGIN;
      record.pageUrl = `${ORIGIN}/settings`;
      record.tabId = WIDGET_TAB_ID;
      record.frameId = 0;
    }
    const current = createSessionReadbackMany([save, cancel]);
    fixture.store.read = vi.fn(async () => ({ ok: true, value: current }));
    const originalGetFrame = fixture.chrome.webNavigation.getFrame;
    const finalEndpointValidation = createDeferred<{
      documentId: string;
      parentFrameId: number;
      url: string;
    }>();
    const finalEndpointValidationStarted = createDeferred<void>();
    const originalRead = fixture.store.read;
    let armFinalEndpointValidation = false;
    let ackReadObserved = false;
    fixture.store.read = vi.fn(async (origin) => {
      const result = await originalRead(origin);
      if (!ackReadObserved) {
        ackReadObserved = true;
        armFinalEndpointValidation = true;
      }
      return result;
    });
    fixture.chrome.webNavigation.getFrame = vi.fn(async (details) => {
      if (details.tabId === WIDGET_TAB_ID && details.frameId === 0 &&
          armFinalEndpointValidation) {
        armFinalEndpointValidation = false;
        finalEndpointValidationStarted.resolve(undefined);
        return finalEndpointValidation.promise;
      }
      return originalGetFrame(details);
    });

    const ack = dispatchRuntime(fixture.controller, {
      type: UI_ATTACH_OVERLAY_PROJECTION_ACK,
      projection: WIDGET_OVERLAY_PROJECTION,
    }, sender);
    await finalEndpointValidationStarted.promise;
    await expect(dispatchRuntime(fixture.controller, {
      type: "ui-attach:overlays-sync",
      origin: ORIGIN,
      activeItemId: null,
    }, createExtensionSender())).resolves.toEqual({ ok: true, data: null });
    finalEndpointValidation.resolve({
      documentId: WIDGET_TOP_DOCUMENT_ID,
      parentFrameId: -1,
      url: `${ORIGIN}/settings`,
    });

    await expect(ack).resolves.toEqual({ ok: true, data: { accepted: false } });
  });

  test("rejects an ACK whose record is replaced while acknowledged persistence is pending", async () => {
    const fixture = await createInPageWidgetFixture();
    const sender = createInPageWidgetContentSender();
    const save = createCaptureRecord("save", "Save changes");
    const cancel = createCaptureRecord("cancel", "Cancel");
    for (const record of [save, cancel]) {
      record.origin = ORIGIN;
      record.pageUrl = `${ORIGIN}/settings`;
      record.tabId = WIDGET_TAB_ID;
      record.frameId = 0;
    }
    const current = createSessionReadbackMany([save, cancel]);
    fixture.store.read = vi.fn(async () => ({ ok: true, value: current }));
    const ackPersistence = createDeferred<void>();
    fixture.chrome.storage.session.set = vi.fn()
      .mockImplementationOnce(async () => ackPersistence.promise)
      .mockImplementation(async () => undefined);
    const originalGetFrame = fixture.chrome.webNavigation.getFrame;
    const replacementSubjectResolved = createDeferred<void>();
    let topFrameReads = 0;
    fixture.chrome.webNavigation.getFrame = vi.fn(async (details) => {
      const frame = await originalGetFrame(details);
      if (details.tabId === WIDGET_TAB_ID && details.frameId === 0) {
        topFrameReads += 1;
        if (topFrameReads === 3) replacementSubjectResolved.resolve(undefined);
      }
      return frame;
    });
    vi.mocked(fixture.chrome.tabs.sendMessage).mockClear();

    const oldAck = dispatchRuntime(fixture.controller, {
      type: UI_ATTACH_OVERLAY_PROJECTION_ACK,
      projection: WIDGET_OVERLAY_PROJECTION,
    }, sender);
    await waitFor(() => vi.mocked(fixture.chrome.storage.session.set).mock.calls.length === 1);
    const replacementSync = dispatchRuntime(fixture.controller, {
      type: "ui-attach:overlays-sync",
      origin: ORIGIN,
      activeItemId: null,
    }, createExtensionSender());
    await replacementSubjectResolved.promise;
    await flushAsyncWork();
    expect(vi.mocked(fixture.chrome.tabs.sendMessage).mock.calls.some(([, message]) => (
      isRecord(message) && message.type === UI_ATTACH_OVERLAY_STATE
    ))).toBe(false);
    ackPersistence.resolve(undefined);

    await expect(oldAck).resolves.toEqual({ ok: true, data: { accepted: false } });
    await expect(replacementSync).resolves.toEqual({ ok: true, data: null });
    const replacementState = vi.mocked(fixture.chrome.tabs.sendMessage).mock.calls
      .map(([, message]) => message)
      .find(isOverlayStateMessage);
    if (!replacementState) throw new Error("replacement projection was not delivered");
    const registryWrites = vi.mocked(fixture.chrome.storage.session.set).mock.calls
      .map(([values]) => values[OVERLAY_PROJECTIONS_SESSION_KEY])
      .filter(isRecord);
    expect(registryWrites).toHaveLength(2);
    expect(registryWrites[0]).toMatchObject({
      generation: 4,
      records: [{
        projection: { ...WIDGET_OVERLAY_PROJECTION },
        delivery: "acknowledged",
      }],
    });
    expect(registryWrites[1]).toMatchObject({
      generation: 5,
      records: [{
        projection: {
          projectionId: replacementState.projection.projectionId,
          revision: replacementState.projection.revision,
        },
        delivery: "pending",
      }],
    });
    await expect(dispatchRuntime(fixture.controller, {
      type: UI_ATTACH_OVERLAY_ACTION_REQUEST,
      action: "more",
      itemId: save.attachment.id,
      projection: {
        version: replacementState.projection.version,
        projectionId: replacementState.projection.projectionId,
        revision: replacementState.projection.revision,
      },
    }, sender)).resolves.toMatchObject({
      ok: false,
      code: "OVERLAY_PROJECTION_REACK_REQUIRED",
    });
  });

  test("does not return a detached ACK rejection before its replacement registry fence is durable", async () => {
    const fixture = await createInPageWidgetFixture();
    const sender = createInPageWidgetContentSender();
    const save = createCaptureRecord("save", "Save changes");
    const cancel = createCaptureRecord("cancel", "Cancel");
    for (const record of [save, cancel]) {
      record.origin = ORIGIN;
      record.pageUrl = `${ORIGIN}/settings`;
      record.tabId = WIDGET_TAB_ID;
      record.frameId = 0;
    }
    const current = createSessionReadbackMany([save, cancel]);
    fixture.store.read = vi.fn(async () => ({ ok: true, value: current }));
    const durableLocalSet = fixture.chrome.storage.local.set;
    const durableSessionSet = fixture.chrome.storage.session.set;
    const acknowledgedSnapshot = createDeferred<void>();
    const replacementFence = createDeferred<void>();
    const replacementFenceStarted = createDeferred<void>();
    let projectionLocalWrites = 0;
    fixture.chrome.storage.local.set = vi.fn(async (values) => {
      if (Object.hasOwn(values, OVERLAY_PROJECTION_AUTHORITY_GENERATION_KEY)) {
        projectionLocalWrites += 1;
        if (projectionLocalWrites === 2) {
          replacementFenceStarted.resolve(undefined);
          await replacementFence.promise;
        }
      }
      await durableLocalSet(values);
    });
    let projectionSessionWrites = 0;
    fixture.chrome.storage.session.set = vi.fn(async (values) => {
      if (Object.hasOwn(values, OVERLAY_PROJECTIONS_SESSION_KEY)) {
        projectionSessionWrites += 1;
        if (projectionSessionWrites === 1) await acknowledgedSnapshot.promise;
      }
      await durableSessionSet(values);
    });
    vi.mocked(fixture.chrome.tabs.sendMessage).mockClear();

    let oldAckSettled = false;
    const oldAck = dispatchRuntime(fixture.controller, {
      type: UI_ATTACH_OVERLAY_PROJECTION_ACK,
      projection: WIDGET_OVERLAY_PROJECTION,
    }, sender).finally(() => {
      oldAckSettled = true;
    });
    await waitFor(() => projectionSessionWrites === 1);
    const replacementSync = dispatchRuntime(fixture.controller, {
      type: "ui-attach:overlays-sync",
      origin: ORIGIN,
      activeItemId: null,
    }, createExtensionSender());
    await flushAsyncWork();
    acknowledgedSnapshot.resolve(undefined);
    await replacementFenceStarted.promise;
    await flushAsyncWork();

    expect(oldAckSettled).toBe(false);
    replacementFence.resolve(undefined);
    await expect(oldAck).resolves.toEqual({ ok: true, data: { accepted: false } });
    await expect(replacementSync).resolves.toEqual({ ok: true, data: null });
    const replacementState = vi.mocked(fixture.chrome.tabs.sendMessage).mock.calls
      .map(([, message]) => message)
      .find(isOverlayStateMessage);
    if (!replacementState) throw new Error("replacement projection was not delivered");

    const restarted = createBackgroundController({
      chrome: fixture.chrome,
      store: fixture.store,
      ensureContentScript: fixture.ensureContentScript,
    });
    await expect(dispatchRuntime(restarted, {
      type: UI_ATTACH_OVERLAY_ACTION_REQUEST,
      action: "save",
      itemId: save.attachment.id,
      taskNote: "Old acknowledged authority must stay fenced",
      projection: WIDGET_OVERLAY_PROJECTION,
    }, sender)).resolves.toMatchObject({
      ok: false,
      code: "UNTRUSTED_SENDER",
    });
    await expect(dispatchRuntime(restarted, {
      type: UI_ATTACH_OVERLAY_ACTION_REQUEST,
      action: "save",
      itemId: save.attachment.id,
      taskNote: "Replacement remains pending until its own ACK",
      projection: {
        version: replacementState.projection.version,
        projectionId: replacementState.projection.projectionId,
        revision: replacementState.projection.revision,
      },
    }, sender)).resolves.toMatchObject({
      ok: false,
      code: "OVERLAY_PROJECTION_REACK_REQUIRED",
    });
    expect(fixture.store.updateIntent).not.toHaveBeenCalled();
  });

  test("fences an old acknowledged restart when a pending registry snapshot cannot persist", async () => {
    const fixture = await createInPageWidgetFixture();
    const sender = createInPageWidgetContentSender();
    fixture.chrome.storage.session.set = vi.fn(async () => {
      throw new Error("session registry unavailable");
    });
    vi.mocked(fixture.chrome.tabs.sendMessage).mockClear();
    vi.mocked(fixture.store.updateIntent).mockClear();

    const syncResponse = await dispatchRuntime(fixture.controller, {
      type: "ui-attach:overlays-sync",
      origin: ORIGIN,
      activeItemId: null,
    }, createExtensionSender());
    const restarted = createBackgroundController({
      chrome: fixture.chrome,
      store: fixture.store,
      ensureContentScript: fixture.ensureContentScript,
    });
    const restartedAction = await dispatchRuntime(restarted, {
      type: UI_ATTACH_OVERLAY_ACTION_REQUEST,
      action: "save",
      itemId: fixture.itemId,
      taskNote: "Must not revive the old acknowledged projection",
      projection: WIDGET_OVERLAY_PROJECTION,
    }, sender);

    expect(syncResponse).toMatchObject({ ok: false, code: "CAPTURE_FAILED" });
    expect(vi.mocked(fixture.chrome.tabs.sendMessage).mock.calls.some(([, message]) => (
      isRecord(message) && message.type === UI_ATTACH_OVERLAY_STATE
    ))).toBe(false);
    expect(restartedAction).toMatchObject({ ok: false, code: "UNTRUSTED_SENDER" });
    expect(fixture.store.updateIntent).not.toHaveBeenCalled();
  });

  test("keeps an ACK pending when its session snapshot cannot persist", async () => {
    const fixture = await createInPageWidgetFixture();
    const sender = createInPageWidgetContentSender();
    const restored = await dispatchRuntime(fixture.controller, {
      type: "ui-attach:overlays-restore-get",
    }, sender);
    if (!isOverlayRestoreResponse(restored)) throw new Error("overlay restore failed");
    const projection = {
      version: restored.data.projection.version,
      projectionId: restored.data.projection.projectionId,
      revision: restored.data.projection.revision,
    };
    fixture.chrome.storage.session.set = vi.fn(async () => {
      throw new Error("session registry unavailable");
    });

    await expect(dispatchRuntime(fixture.controller, {
      type: UI_ATTACH_OVERLAY_PROJECTION_ACK,
      projection,
    }, sender)).resolves.toEqual({ ok: true, data: { accepted: false } });
    await expect(dispatchRuntime(fixture.controller, {
      type: UI_ATTACH_OVERLAY_ACTION_REQUEST,
      action: "save",
      itemId: fixture.itemId,
      taskNote: "Must remain pending after failed ACK persistence",
      projection,
    }, sender)).resolves.toMatchObject({
      ok: false,
      code: "OVERLAY_PROJECTION_REACK_REQUIRED",
    });
    expect(fixture.store.updateIntent).not.toHaveBeenCalled();
  });

  test("removes session authority and fail-closes the worker when the local fence cannot advance", async () => {
    const fixture = await createInPageWidgetFixture();
    const sender = createInPageWidgetContentSender();
    const restored = await dispatchRuntime(fixture.controller, {
      type: "ui-attach:overlays-restore-get",
    }, sender);
    if (!isOverlayRestoreResponse(restored)) throw new Error("overlay restore failed");
    const projection = {
      version: restored.data.projection.version,
      projectionId: restored.data.projection.projectionId,
      revision: restored.data.projection.revision,
    };
    fixture.chrome.storage.local.set = vi.fn(async () => {
      throw new Error("local authority unavailable");
    });
    fixture.chrome.storage.session.remove = vi.fn(async () => undefined);

    await expect(dispatchRuntime(fixture.controller, {
      type: UI_ATTACH_OVERLAY_PROJECTION_ACK,
      projection,
    }, sender)).resolves.toEqual({ ok: true, data: { accepted: false } });
    expect(fixture.chrome.storage.session.remove).toHaveBeenCalledWith(
      OVERLAY_PROJECTIONS_SESSION_KEY,
    );
    await expect(dispatchRuntime(fixture.controller, {
      type: UI_ATTACH_OVERLAY_ACTION_REQUEST,
      action: "more",
      itemId: fixture.itemId,
      projection,
    }, sender)).resolves.toMatchObject({ ok: false, code: "UNTRUSTED_SENDER" });
  });

  test("does not hydrate old acknowledged authority when both local fencing and session removal fail", async () => {
    const fixture = await createInPageWidgetFixture();
    const sender = createInPageWidgetContentSender();
    fixture.chrome.storage.local.set = vi.fn(async () => {
      throw new Error("local authority unavailable");
    });
    fixture.chrome.storage.session.remove = vi.fn(async () => {
      throw new Error("session registry unavailable");
    });

    await expect(dispatchRuntime(fixture.controller, {
      type: UI_ATTACH_OVERLAY_PROJECTION_ACK,
      projection: WIDGET_OVERLAY_PROJECTION,
    }, sender)).resolves.toEqual({ ok: true, data: { accepted: false } });

    const restarted = createBackgroundController({
      chrome: fixture.chrome,
      store: fixture.store,
      ensureContentScript: fixture.ensureContentScript,
    });
    await expect(dispatchRuntime(restarted, {
      type: UI_ATTACH_OVERLAY_ACTION_REQUEST,
      action: "save",
      itemId: fixture.itemId,
      taskNote: "Old durable ACK must require a live re-ACK",
      projection: WIDGET_OVERLAY_PROJECTION,
    }, sender)).resolves.toMatchObject({
      ok: false,
      code: "OVERLAY_PROJECTION_REACK_REQUIRED",
    });
    expect(fixture.store.updateIntent).not.toHaveBeenCalled();
  });

  test("never matches a stored projection across a different origin or pathname subject", async () => {
    const fixture = await createInPageWidgetFixture();
    const mismatchedProjection = {
      ...WIDGET_OVERLAY_PROJECTION_DESCRIPTOR,
      subject: {
        ...WIDGET_OVERLAY_PROJECTION_DESCRIPTOR.subject,
        origin: OTHER_ORIGIN,
        pathname: "/other-route",
      },
    };
    await fixture.chrome.storage.local.set({
      [OVERLAY_PROJECTION_AUTHORITY_GENERATION_KEY]: 2,
    });
    await fixture.chrome.storage.session.set({
      [OVERLAY_PROJECTIONS_SESSION_KEY]: {
        generation: 2,
        records: [{
          projection: mismatchedProjection,
          itemIds: [fixture.itemId],
          activeItemId: null,
          delivery: "pending",
          updatedAt: 2,
        }],
      },
    });
    fixture.controller = createBackgroundController({
      chrome: fixture.chrome,
      store: fixture.store,
      ensureContentScript: fixture.ensureContentScript,
    });

    await expect(dispatchRuntime(fixture.controller, {
      type: UI_ATTACH_OVERLAY_PROJECTION_ACK,
      projection: WIDGET_OVERLAY_PROJECTION,
    }, createInPageWidgetContentSender())).resolves.toEqual({
      ok: true,
      data: { accepted: false },
    });
  });

  test("rotates projection identity instead of overflowing a safe-integer revision", async () => {
    const fixture = await createInPageWidgetFixture();
    const overflowProjectionId = "projection-before-safe-integer-overflow";
    await fixture.chrome.storage.local.set({
      [OVERLAY_PROJECTION_AUTHORITY_GENERATION_KEY]: 2,
    });
    await fixture.chrome.storage.session.set({
      [OVERLAY_PROJECTIONS_SESSION_KEY]: {
        generation: 2,
        records: [{
          projection: {
            ...WIDGET_OVERLAY_PROJECTION_DESCRIPTOR,
            projectionId: overflowProjectionId,
            revision: Number.MAX_SAFE_INTEGER,
          },
          itemIds: [fixture.itemId],
          activeItemId: null,
          delivery: "acknowledged",
          updatedAt: 2,
        }],
      },
    });
    fixture.controller = createBackgroundController({
      chrome: fixture.chrome,
      store: fixture.store,
      ensureContentScript: fixture.ensureContentScript,
    });

    const restored = await dispatchRuntime(fixture.controller, {
      type: "ui-attach:overlays-restore-get",
    }, createInPageWidgetContentSender());
    expect(restored).toMatchObject({
      ok: true,
      data: { projection: { revision: 1 } },
    });
    if (!isOverlayRestoreResponse(restored)) throw new Error("overlay restore failed");
    expect(restored.data.projection.projectionId).not.toBe(overflowProjectionId);
  });

  test("serializes a rapid active change before marker save snapshots durable emphasis", async () => {
    const sessionState: Record<string, unknown> = {};
    const onActiveSessionChanged = vi.fn(async () => undefined);
    const fixture = await createInPageWidgetFixture({
      onActiveSessionChanged,
      configureChrome: (chrome) => {
        chrome.storage.session.get = vi.fn(async (key) => (
          typeof key === "string" && key in sessionState
            ? { [key]: sessionState[key] }
            : {}
        ));
        chrome.storage.session.set = vi.fn(async (values) => {
          Object.assign(sessionState, values);
        });
      },
    });
    const lifecycle = await connectInPageWidgetLifecycle(fixture);
    const save = createCaptureRecord("save", "Save changes");
    const cancel = createCaptureRecord("cancel", "Cancel");
    const cancelPrimary = cancel.attachment.locatorBundle.primary;
    if (cancelPrimary && cancel.attachment.locatorBundle.stability) {
      cancel.attachment.locatorBundle.stability = {
        ...cancel.attachment.locatorBundle.stability,
        verifiedBy: cancelPrimary.strategy,
        verifiedValue: cancelPrimary.value,
      };
    }
    for (const record of [save, cancel]) {
      record.origin = ORIGIN;
      record.pageUrl = `${ORIGIN}/settings`;
      record.tabId = WIDGET_TAB_ID;
      record.frameId = 0;
    }
    save.intent = "Old note";
    const initial = createSessionReadbackMany([save, cancel]);
    let current = initial;
    let readCount = 0;
    const activeRead = createDeferred<ReturnType<ExtensionSessionStore["read"]> extends Promise<infer T>
      ? T
      : never>();
    fixture.store.read = vi.fn(async () => {
      readCount += 1;
      return readCount === 1
        ? activeRead.promise
        : { ok: true as const, value: current };
    });
    fixture.store.updateIntent = vi.fn(async (_origin, _epoch, _itemId, intent) => {
      current = createSessionReadbackMany([{ ...save, intent }, cancel]);
      return { ok: true, value: current };
    });
    vi.mocked(fixture.chrome.tabs.sendMessage).mockClear();
    lifecycle.port.postMessage.mockClear();

    const activeChange = dispatchRuntime(
      fixture.controller,
      createInPageWidgetCommandEnvelope(fixture.init, {
        type: "ui-attach:widget-overlay-active",
        itemId: cancel.attachment.id,
      }),
      fixture.widgetSender,
    );
    await waitFor(() => vi.mocked(fixture.store.read).mock.calls.length === 1);
    const saveNote = dispatchRuntime(fixture.controller, {
      type: UI_ATTACH_OVERLAY_ACTION_REQUEST,
      action: "save",
      itemId: save.attachment.id,
      taskNote: "Queued save note",
      projection: WIDGET_OVERLAY_PROJECTION,
    }, createInPageWidgetContentSender());
    await flushMicrotasks();
    expect(fixture.store.updateIntent).not.toHaveBeenCalled();
    activeRead.resolve({ ok: true, value: initial });
    await waitFor(() => vi.mocked(fixture.store.updateIntent).mock.calls.length === 1);

    await expect(Promise.all([activeChange, saveNote])).resolves.toEqual([
      { ok: true, data: null },
      { ok: true, data: null },
    ]);
    const overlayStates = vi.mocked(fixture.chrome.tabs.sendMessage).mock.calls
      .map(([, message]) => message)
      .filter((message) => isRecord(message) && message.type === UI_ATTACH_OVERLAY_STATE);
    expect(overlayStates.at(-1)).toMatchObject({
      activeItemId: cancel.attachment.id,
      items: [
        expect.objectContaining({ itemId: save.attachment.id, taskNote: "Queued save note" }),
        expect.objectContaining({ itemId: cancel.attachment.id }),
      ],
    });
    expect(sessionState[OVERLAY_ACTIVE_ITEMS_SESSION_KEY]).toEqual([
      { origin: ORIGIN, itemId: cancel.attachment.id },
    ]);
    expect(onActiveSessionChanged).toHaveBeenLastCalledWith(expect.objectContaining({
      selectedItemId: cancel.attachment.id,
    }));
    expect(lifecycle.port.postMessage).not.toHaveBeenCalled();
  });

  test("fails marker-note save closed for stale, mismatched, unowned, or stale-route state", async () => {
    const onActiveSessionChanged = vi.fn(async () => undefined);
    const fixture = await createInPageWidgetFixture({ onActiveSessionChanged });
    const lifecycle = await connectInPageWidgetLifecycle(fixture);
    const record = createCaptureRecord("save", "Save changes");
    record.origin = ORIGIN;
    record.pageUrl = `${ORIGIN}/settings`;
    record.tabId = WIDGET_TAB_ID;
    record.frameId = 0;
    record.intent = "Old note";
    const unchanged = createSessionReadback(record);
    fixture.store.read = vi.fn(async () => ({ ok: true, value: unchanged }));
    const request = {
      type: UI_ATTACH_OVERLAY_ACTION_REQUEST,
      action: "save",
      itemId: fixture.itemId,
      taskNote: "Rejected note",
      projection: WIDGET_OVERLAY_PROJECTION,
    } as const;

    fixture.store.updateIntent = vi.fn(async () => ({
      ok: false as const,
      code: "STALE_SESSION" as const,
      error: "stale",
    }));
    await expect(dispatchRuntime(
      fixture.controller,
      request,
      createInPageWidgetContentSender(),
    )).resolves.toMatchObject({ ok: false, code: "STALE_SESSION" });

    fixture.store.updateIntent = vi.fn(async () => ({ ok: true, value: unchanged }));
    await expect(dispatchRuntime(
      fixture.controller,
      request,
      createInPageWidgetContentSender(),
    )).resolves.toMatchObject({ ok: false, code: "CAPTURE_FAILED" });

    const updateCallsBeforeUntrusted = vi.mocked(fixture.store.updateIntent).mock.calls.length;
    await expect(dispatchRuntime(
      fixture.controller,
      { ...request, itemId: "att_not_owned" },
      createInPageWidgetContentSender(),
    )).resolves.toMatchObject({ ok: false, code: "UNTRUSTED_SENDER" });
    await expect(dispatchRuntime(
      fixture.controller,
      request,
      { ...createInPageWidgetContentSender(), url: `${ORIGIN}/stale-route` },
    )).resolves.toMatchObject({ ok: false, code: "UNTRUSTED_SENDER" });

    expect(fixture.store.updateIntent).toHaveBeenCalledTimes(updateCallsBeforeUntrusted);
    expect(vi.mocked(fixture.chrome.tabs.sendMessage).mock.calls.some(([, message]) => (
      isRecord(message) && message.type === UI_ATTACH_OVERLAY_STATE
    ))).toBe(false);
    expect(onActiveSessionChanged).not.toHaveBeenCalled();
    expect(lifecycle.port.postMessage).not.toHaveBeenCalled();
  });

  test.each(["save", "remove"] as const)(
    "revalidates the full nested route inside the %s store mutation boundary",
    async (action) => {
      const nested = await createNestedOverlayAuthorityFixture();
      const authorityEntered = createDeferred<NonNullable<Parameters<
        ExtensionSessionStore["removeItem"]
      >[3]>>();
      const releaseAuthority = createDeferred<void>();
      let terminalWrites = 0;
      if (action === "save") {
        nested.fixture.store.updateIntent = vi.fn(async (
          _origin,
          _epoch,
          _itemId,
          _intent,
          authority,
        ) => {
          if (!authority) throw new Error("missing session mutation authority");
          authorityEntered.resolve(authority);
          await releaseAuthority.promise;
          if (await authority.refresh(nested.childRecord) && authority.isCurrent()) {
            terminalWrites += 1;
            return { ok: true as const, value: nested.childReadback };
          }
          return { ok: false as const, code: "STALE_SESSION" as const, error: "stale route" };
        });
      } else {
        nested.fixture.store.removeItem = vi.fn(async (
          _origin,
          _epoch,
          _itemId,
          authority,
        ) => {
          if (!authority) throw new Error("missing session mutation authority");
          authorityEntered.resolve(authority);
          await releaseAuthority.promise;
          if (await authority.refresh(nested.childRecord) && authority.isCurrent()) {
            terminalWrites += 1;
            return { ok: true as const, value: nested.childReadback };
          }
          return { ok: false as const, code: "STALE_SESSION" as const, error: "stale route" };
        });
      }

      const response = dispatchRuntime(nested.fixture.controller, {
        type: UI_ATTACH_OVERLAY_ACTION_REQUEST,
        action,
        itemId: nested.childRecord.attachment.id,
        ...(action === "save" ? { taskNote: "Must not cross ancestor navigation" } : {}),
        projection: nested.projection,
      }, nested.sender);
      const authority = await Promise.race([
        authorityEntered.promise,
        response.then((value) => {
          throw new Error(`overlay action settled before store authority: ${JSON.stringify(value)}`);
        }),
      ]);
      expect(authority.isCurrent()).toBe(true);
      nested.setTopPathname("/host-b");
      releaseAuthority.resolve(undefined);

      await expect(response).resolves.toMatchObject({ ok: false, code: "STALE_SESSION" });
      expect(authority.isCurrent()).toBe(false);
      expect(terminalWrites).toBe(0);
    },
  );

  test.each(["edit", "more"] as const)(
    "revalidates the full nested route after persisting %s context and before widget delivery",
    async (action) => {
      const nested = await createNestedOverlayAuthorityFixture();
      const lifecycle = await connectInPageWidgetLifecycle(nested.fixture);
      const actionContextPersisted = createDeferred<void>();
      const releasePersistence = createDeferred<void>();
      const originalSessionSet = nested.fixture.chrome.storage.session.set;
      let interceptNextLeaseWrite = true;
      nested.fixture.chrome.storage.session.set = vi.fn(async (values) => {
        await originalSessionSet(values);
        if (interceptNextLeaseWrite && Object.hasOwn(values, IN_PAGE_WIDGET_LEASE_STORAGE_KEY)) {
          interceptNextLeaseWrite = false;
          actionContextPersisted.resolve(undefined);
          await releasePersistence.promise;
        }
      });
      lifecycle.port.postMessage.mockClear();
      vi.mocked(nested.fixture.chrome.sidePanel.open).mockClear();

      const response = dispatchRuntime(nested.fixture.controller, {
        type: UI_ATTACH_OVERLAY_ACTION_REQUEST,
        action,
        itemId: nested.childRecord.attachment.id,
        projection: nested.projection,
      }, nested.sender);
      await actionContextPersisted.promise;
      nested.setTopPathname("/host-b");
      releasePersistence.resolve(undefined);

      await expect(response).resolves.toEqual({ ok: true, data: null });
      await flushAsyncWork();
      await flushAsyncWork();
      expect(readPostedWidgetActions(lifecycle.port)).toEqual([]);
      expect(nested.fixture.chrome.sidePanel.open).not.toHaveBeenCalled();
    },
  );

  test("opens immediately on the unique live child-frame session restored after reload", async () => {
    const fixture = await createInPageWidgetFixture();
    const currentChildFrameId = 5;
    const currentChildDocumentId = "child-document-current";
    const childRecord = createCaptureRecord("save", "Save changes");
    childRecord.origin = OTHER_ORIGIN;
    childRecord.pageUrl = `${OTHER_ORIGIN}/editor`;
    childRecord.tabId = WIDGET_TAB_ID;
    childRecord.frameId = 3;
    childRecord.routeChain = [
      { origin: ORIGIN, pathname: "/settings" },
      { origin: OTHER_ORIGIN, pathname: "/editor" },
    ];
    let childReadback = createSessionReadback(childRecord);
    const emptyTopReadback: ActiveSessionReadback = {
      origin: ORIGIN,
      epoch: null,
      clearPending: false,
      activeClearOperationId: null,
      file: null,
      legacyRecord: null,
    };
    fixture.store.read = vi.fn(async (origin) => ({
      ok: true,
      value: origin === OTHER_ORIGIN
        ? childReadback
        : emptyTopReadback,
    }));
    fixture.store.updateIntent = vi.fn(async (_origin, _epoch, _itemId, intent) => {
      const updatedRecord = { ...childRecord, intent };
      childReadback = createSessionReadback(updatedRecord);
      return { ok: true, value: childReadback };
    });
    fixture.store.removeItem = vi.fn(async () => {
      childReadback = {
        ...childReadback,
        file: childReadback.file ? {
          ...childReadback.file,
          session: { ...childReadback.file.session, attachments: [] },
        } : null,
        legacyRecord: null,
      };
      return { ok: true, value: childReadback };
    });
    fixture.chrome.webNavigation.getAllFrames = vi.fn(async ({ tabId }) => tabId === WIDGET_TAB_ID
      ? [
          {
            frameId: 0,
            parentFrameId: -1,
            documentId: WIDGET_TOP_DOCUMENT_ID,
            url: `${ORIGIN}/settings`,
          },
          {
            frameId: currentChildFrameId,
            parentFrameId: 0,
            documentId: currentChildDocumentId,
            url: `${OTHER_ORIGIN}/editor`,
          },
        ]
      : []);
    const originalGetFrame = fixture.chrome.webNavigation.getFrame;
    fixture.chrome.webNavigation.getFrame = vi.fn(async (details) =>
      details.tabId === WIDGET_TAB_ID && details.frameId === currentChildFrameId
        ? {
            frameId: currentChildFrameId,
            parentFrameId: 0,
            documentId: currentChildDocumentId,
            url: `${OTHER_ORIGIN}/editor`,
          }
        : originalGetFrame(details));

    await expect(dispatchRuntime(
      fixture.controller,
      createInPageWidgetCommandEnvelope(fixture.init, {
        type: "ui-attach:widget-session-read",
      }),
      fixture.widgetSender,
    )).resolves.toMatchObject({
      ok: true,
      data: {
        origin: OTHER_ORIGIN,
        activePage: {
          frameId: currentChildFrameId,
          documentId: currentChildDocumentId,
        },
        readback: {
          file: {
            session: {
              attachments: [{ id: childRecord.attachment.id }],
            },
          },
        },
      },
    });

    const replacementSender: UiAttachChromeMessageSender = {
      id: WIDGET_RUNTIME_ID,
      url: `${OTHER_ORIGIN}/editor`,
      frameId: currentChildFrameId,
      documentId: currentChildDocumentId,
      tab: {
        id: WIDGET_TAB_ID,
        url: `${ORIGIN}/settings`,
        windowId: WIDGET_WINDOW_ID,
      },
    };
    const replacementProjection = await restoreAndAcknowledgeProjection(
      fixture.controller,
      replacementSender,
    );
    const lifecycle = await connectInPageWidgetLifecycle(fixture);
    await expect(dispatchRuntime(fixture.controller, {
      type: UI_ATTACH_OVERLAY_ACTION_REQUEST,
      action: "more",
      itemId: childRecord.attachment.id,
      projection: replacementProjection,
    }, replacementSender)).resolves.toEqual({ ok: true, data: null });
    await waitForPostedWidgetActionCount(lifecycle.port, 1);
    const postedMore = readPostedWidgetActions(lifecycle.port)[0];
    const lifecycleMessageListener = vi.mocked(lifecycle.messageEvent.addListener).mock.calls[0]?.[0];
    if (!postedMore || !lifecycleMessageListener) {
      throw new Error("child-frame More action was not delivered");
    }
    lifecycleMessageListener({
      type: UI_ATTACH_IN_PAGE_WIDGET_ACTION_ACK,
      surfaceId: fixture.init.surfaceId,
      actionId: postedMore.actionId,
      outcome: "consumed",
    });
    await flushAsyncWork();
    await expect(dispatchRuntime(fixture.controller, {
      type: UI_ATTACH_OVERLAY_ACTION_REQUEST,
      action: "save",
      itemId: childRecord.attachment.id,
      taskNote: "Saved after document replacement",
      projection: replacementProjection,
    }, replacementSender)).resolves.toEqual({ ok: true, data: null });
    expect(fixture.store.updateIntent).toHaveBeenCalledWith(
      OTHER_ORIGIN,
      "epoch-1",
      childRecord.attachment.id,
      "Saved after document replacement",
      expect.objectContaining({
        isCurrent: expect.any(Function),
        refresh: expect.any(Function),
      }),
    );
    const postSaveProjection = await restoreAndAcknowledgeProjection(
      fixture.controller,
      replacementSender,
    );
    vi.mocked(fixture.chrome.tabs.sendMessage).mockClear();
    await expect(dispatchRuntime(fixture.controller, {
      type: UI_ATTACH_OVERLAY_ACTION_REQUEST,
      action: "remove",
      itemId: childRecord.attachment.id,
      projection: postSaveProjection,
    }, replacementSender)).resolves.toEqual({ ok: true, data: null });
    expect(fixture.store.removeItem).toHaveBeenCalledWith(
      OTHER_ORIGIN,
      "epoch-1",
      childRecord.attachment.id,
      expect.objectContaining({
        isCurrent: expect.any(Function),
        refresh: expect.any(Function),
      }),
    );
    expect(vi.mocked(fixture.chrome.tabs.sendMessage).mock.calls).toContainEqual([
      WIDGET_TAB_ID,
      expect.objectContaining({
        type: UI_ATTACH_OVERLAY_STATE,
        origin: OTHER_ORIGIN,
        items: [],
      }),
      {
        frameId: currentChildFrameId,
        documentId: currentChildDocumentId,
      },
    ]);

    await expect(dispatchRuntime(
      fixture.controller,
      createInPageWidgetCommandEnvelope(fixture.init, {
        type: "ui-attach:widget-frame-scope-select",
        frameId: 0,
        documentId: WIDGET_TOP_DOCUMENT_ID,
        origin: ORIGIN,
        pathname: "/settings",
        expectedGeneration: 0,
      }),
      fixture.widgetSender,
    )).resolves.toEqual({ ok: true, data: { enabled: false } });
    await expect(dispatchRuntime(
      fixture.controller,
      createInPageWidgetCommandEnvelope(fixture.init, {
        type: "ui-attach:widget-frame-scope-list",
      }),
      fixture.widgetSender,
    )).resolves.toMatchObject({
      ok: true,
      data: { currentFrameId: 0 },
    });
    await expect(dispatchRuntime(
      fixture.controller,
      createInPageWidgetCommandEnvelope(fixture.init, {
        type: "ui-attach:widget-session-read",
      }),
      fixture.widgetSender,
    )).resolves.toMatchObject({
      ok: true,
      data: {
        origin: ORIGIN,
        activePage: { frameId: 0, documentId: WIDGET_TOP_DOCUMENT_ID },
        readback: { file: null },
      },
    });
  });

  test("syncs the remaining restored markers into the unique replacement frame after remove", async () => {
    const fixture = await createInPageWidgetFixture();
    const currentChildFrameId = 5;
    const currentChildDocumentId = "child-document-current";
    let childRecords = [
      createCaptureRecord("save", "Save changes"),
      createCaptureRecord("cancel", "Cancel"),
      createCaptureRecord("other", "Other"),
    ];
    for (const record of childRecords) {
      const locator = `#${record.attachment.id}`;
      record.origin = OTHER_ORIGIN;
      record.pageUrl = `${OTHER_ORIGIN}/editor`;
      record.tabId = WIDGET_TAB_ID;
      record.frameId = 3;
      record.routeChain = [
        { origin: ORIGIN, pathname: "/settings" },
        { origin: OTHER_ORIGIN, pathname: "/editor" },
      ];
      record.attachment.locatorBundle = {
        ...record.attachment.locatorBundle,
        primary: { strategy: "css", value: locator, confidence: 0.95 },
        candidates: [],
        stability: {
          ...record.attachment.locatorBundle.stability!,
          uniqueness: true,
          replayVerified: true,
          verifiedBy: "css",
          verifiedValue: locator,
        },
      };
    }
    const emptyTopReadback: ActiveSessionReadback = {
      origin: ORIGIN,
      epoch: null,
      clearPending: false,
      activeClearOperationId: null,
      file: null,
      legacyRecord: null,
    };
    const readChild = (): ActiveSessionReadback => createSessionReadbackMany(childRecords);
    fixture.store.read = vi.fn(async (origin) => ({
      ok: true,
      value: origin === OTHER_ORIGIN ? readChild() : emptyTopReadback,
    }));
    fixture.store.removeItem = vi.fn(async (_origin, _epoch, itemId) => {
      childRecords = childRecords.filter((record) => record.attachment.id !== itemId);
      return { ok: true, value: readChild() };
    });
    fixture.chrome.webNavigation.getAllFrames = vi.fn(async ({ tabId }) => tabId === WIDGET_TAB_ID
      ? [
          {
            frameId: 0,
            parentFrameId: -1,
            documentId: WIDGET_TOP_DOCUMENT_ID,
            url: `${ORIGIN}/settings`,
          },
          {
            frameId: currentChildFrameId,
            parentFrameId: 0,
            documentId: currentChildDocumentId,
            url: `${OTHER_ORIGIN}/editor`,
          },
        ]
      : []);
    const originalGetFrame = fixture.chrome.webNavigation.getFrame;
    fixture.chrome.webNavigation.getFrame = vi.fn(async (details) =>
      details.tabId === WIDGET_TAB_ID && details.frameId === currentChildFrameId
        ? {
            frameId: currentChildFrameId,
            parentFrameId: 0,
            documentId: currentChildDocumentId,
            url: `${OTHER_ORIGIN}/editor`,
          }
        : originalGetFrame(details));
    const replacementSender: UiAttachChromeMessageSender = {
      id: WIDGET_RUNTIME_ID,
      url: `${OTHER_ORIGIN}/editor`,
      frameId: currentChildFrameId,
      documentId: currentChildDocumentId,
      tab: {
        id: WIDGET_TAB_ID,
        url: `${ORIGIN}/settings`,
        windowId: WIDGET_WINDOW_ID,
      },
    };
    const projection = await restoreAndAcknowledgeProjection(
      fixture.controller,
      replacementSender,
    );
    const removedId = childRecords[1]!.attachment.id;
    vi.mocked(fixture.chrome.tabs.sendMessage).mockClear();

    await expect(dispatchRuntime(fixture.controller, {
      type: UI_ATTACH_OVERLAY_ACTION_REQUEST,
      action: "remove",
      itemId: removedId,
      projection,
    }, replacementSender)).resolves.toEqual({ ok: true, data: null });

    const stateDelivery = vi.mocked(fixture.chrome.tabs.sendMessage).mock.calls.find(
      ([, message, options]) => isOverlayStateMessage(message) &&
        options?.frameId === currentChildFrameId &&
        options.documentId === currentChildDocumentId,
    );
    expect(stateDelivery?.[1]).toMatchObject({
      type: UI_ATTACH_OVERLAY_STATE,
      origin: OTHER_ORIGIN,
      items: [
        { itemId: childRecords[0]!.attachment.id, label: "1" },
        { itemId: childRecords[1]!.attachment.id, label: "2" },
      ],
    });
  });

  test("rejects a stale child document until its unique live replacement is projected and acknowledged", async () => {
    const fixture = await createInPageWidgetFixture();
    await connectInPageWidgetLifecycle(fixture);
    const topRecord = createCaptureRecord("top", "Top target");
    topRecord.origin = ORIGIN;
    topRecord.pageUrl = `${ORIGIN}/settings`;
    topRecord.tabId = WIDGET_TAB_ID;
    topRecord.frameId = 0;
    const childRecord = createCaptureRecord("save", "Save changes");
    childRecord.origin = OTHER_ORIGIN;
    childRecord.pageUrl = `${OTHER_ORIGIN}/editor`;
    childRecord.tabId = WIDGET_TAB_ID;
    childRecord.frameId = 3;
    childRecord.routeChain = [
      { origin: ORIGIN, pathname: "/settings" },
      { origin: OTHER_ORIGIN, pathname: "/editor" },
    ];
    fixture.store.read = vi.fn(async (origin) => ({
      ok: true,
      value: origin === OTHER_ORIGIN
        ? createSessionReadback(childRecord, OTHER_ORIGIN)
        : createSessionReadback(topRecord, ORIGIN),
    }));
    const originalGetFrame = fixture.chrome.webNavigation.getFrame;
    let childDocumentId = "child-document-current";
    fixture.chrome.webNavigation.getFrame = vi.fn(async (details) => details.tabId === WIDGET_TAB_ID &&
        details.frameId === 3
      ? {
          documentId: childDocumentId,
          parentFrameId: 0,
          url: `${OTHER_ORIGIN}/editor`,
        }
      : originalGetFrame(details));
    const childSender: UiAttachChromeMessageSender = {
      id: WIDGET_RUNTIME_ID,
      url: `${OTHER_ORIGIN}/editor`,
      frameId: 3,
      documentId: childDocumentId,
      tab: {
        id: WIDGET_TAB_ID,
        url: `${ORIGIN}/settings`,
        windowId: WIDGET_WINDOW_ID,
      },
    };
    fixture.chrome.webNavigation.getAllFrames = vi.fn(async ({ tabId }) => tabId === WIDGET_TAB_ID
      ? [
          {
            frameId: 0,
            parentFrameId: -1,
            documentId: WIDGET_TOP_DOCUMENT_ID,
            url: `${ORIGIN}/settings`,
          },
          {
            frameId: 3,
            parentFrameId: 0,
            documentId: childDocumentId,
            url: `${OTHER_ORIGIN}/editor`,
          },
        ]
      : []);
    const childProjection = await restoreAndAcknowledgeProjection(
      fixture.controller,
      childSender,
    );

    await expect(dispatchRuntime(fixture.controller, {
      type: UI_ATTACH_OVERLAY_ACTION_REQUEST,
      action: "edit",
      itemId: childRecord.attachment.id,
      projection: childProjection,
    }, childSender)).resolves.toEqual({ ok: true, data: null });

    childDocumentId = "child-document-replaced";
    await fixture.controller.handleNavigationCommitted({
      tabId: WIDGET_TAB_ID,
      frameId: 3,
      parentFrameId: 0,
      documentId: childDocumentId,
      url: `${OTHER_ORIGIN}/editor`,
    });
    await expect(dispatchRuntime(fixture.controller, {
      type: UI_ATTACH_OVERLAY_ACTION_REQUEST,
      action: "edit",
      itemId: childRecord.attachment.id,
      projection: childProjection,
    }, childSender)).resolves.toMatchObject({ ok: false, code: "UNTRUSTED_SENDER" });
    let replacementSession: Awaited<ReturnType<typeof dispatchRuntime>> | undefined;
    for (let attempt = 0; attempt < 20; attempt += 1) {
      replacementSession = await dispatchRuntime(
        fixture.controller,
        createInPageWidgetCommandEnvelope(fixture.init, {
          type: "ui-attach:widget-session-read",
        }),
        fixture.widgetSender,
      );
      if (replacementSession?.ok) break;
      await flushAsyncWork();
    }
    expect(replacementSession).toMatchObject({
      ok: true,
      data: {
        origin: OTHER_ORIGIN,
        activePage: { frameId: 3, documentId: childDocumentId },
      },
    });
    const replacementSender = { ...childSender, documentId: childDocumentId };
    const replacementProjection = await restoreAndAcknowledgeProjection(
      fixture.controller,
      replacementSender,
    );
    await expect(dispatchRuntime(fixture.controller, {
      type: UI_ATTACH_OVERLAY_ACTION_REQUEST,
      action: "edit",
      itemId: childRecord.attachment.id,
      projection: replacementProjection,
    }, replacementSender)).resolves.toEqual({ ok: true, data: null });
  });

  test("fails closed for wrong capabilities, stale documents, and unknown widget commands", async () => {
    const fixture = await createInPageWidgetFixture();
    vi.mocked(fixture.store.read).mockClear();
    vi.mocked(fixture.store.updateIntent).mockClear();
    const wrongCapabilityEnvelope = {
      ...createInPageWidgetCommandEnvelope(fixture.init, {
        type: "ui-attach:widget-session-read",
      }),
      capability: fixture.init.capability === "A".repeat(43)
        ? "B".repeat(43)
        : "A".repeat(43),
    };
    const unknownCommandEnvelope = createInPageWidgetCommandEnvelope(fixture.init, {
      type: "ui-attach:widget-export-everything",
    });

    await expect(dispatchRuntime(
      fixture.controller,
      wrongCapabilityEnvelope,
      fixture.widgetSender,
    )).resolves.toMatchObject({ ok: false, code: "UNTRUSTED_SENDER" });
    await expect(dispatchRuntime(
      fixture.controller,
      unknownCommandEnvelope,
      fixture.widgetSender,
    )).resolves.toMatchObject({ ok: false, code: "UNTRUSTED_SENDER" });

    fixture.frameState.topDocumentId = "navigated-top-document";
    await expect(dispatchRuntime(
      fixture.controller,
      createInPageWidgetRegistration(fixture.init),
      fixture.widgetSender,
    )).resolves.toMatchObject({ ok: false, code: "UNTRUSTED_SENDER" });
    expect(fixture.store.read).not.toHaveBeenCalled();
    expect(fixture.store.updateIntent).not.toHaveBeenCalled();
  });
});

function createChromeHarness(): UiAttachChrome & {
  runtime: UiAttachChrome["runtime"] & { sentMessages: Array<Record<string, unknown>> };
} {
  const runtimeSentMessages: Array<Record<string, unknown>> = [];
  const localValues: Record<string, unknown> = {};
  const sessionValues: Record<string, unknown> = {};
  return {
    action: {
      onClicked: createEventHarness(),
      setBadgeText: vi.fn(async () => undefined),
      setTitle: vi.fn(async () => undefined),
    },
    alarms: {
      create: vi.fn(),
      clear: vi.fn(async () => true),
      onAlarm: createEventHarness(),
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
        postMessage: vi.fn(),
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
        get: vi.fn(async (keys) => {
          if (keys === null) return { ...localValues };
          const requested = Array.isArray(keys) ? keys : [keys];
          return Object.fromEntries(requested.flatMap((key) => (
            Object.hasOwn(localValues, key) ? [[key, localValues[key]]] : []
          )));
        }),
        set: vi.fn(async (items) => {
          Object.assign(localValues, items);
        }),
        remove: vi.fn(async (keys) => {
          for (const key of Array.isArray(keys) ? keys : [keys]) delete localValues[key];
        }),
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

test("fails closed when the widget cannot open the native side panel", async () => {
  const fixture = await createInPageWidgetFixture({
    configureChrome(chrome) {
      chrome.sidePanel!.open = vi.fn(async () => {
        throw new Error("side panel unavailable");
      });
    },
  });

  await expect(dispatchRuntime(
    fixture.controller,
    createInPageWidgetCommandEnvelope(fixture.init, {
      type: "ui-attach:widget-side-panel-open",
    }),
    fixture.widgetSender,
  )).resolves.toMatchObject({
    ok: false,
    code: "CAPTURE_FAILED",
  });
  expect(fixture.chrome.sidePanel?.open).toHaveBeenCalledWith({ windowId: WIDGET_WINDOW_ID });
});

test("reports success when the widget opens the native side panel", async () => {
  const fixture = await createInPageWidgetFixture();

  await expect(dispatchRuntime(
    fixture.controller,
    createInPageWidgetCommandEnvelope(fixture.init, {
      type: "ui-attach:widget-side-panel-open",
    }),
    fixture.widgetSender,
  )).resolves.toEqual({ ok: true, data: null });
  expect(fixture.chrome.sidePanel?.open).toHaveBeenCalledWith({ windowId: WIDGET_WINDOW_ID });
});

test("returns a bounded timeout when the widget side panel never settles", async () => {
  const fixture = await createInPageWidgetFixture();
  const openSidePanel = vi.fn(() => new Promise<void>(() => undefined));
  fixture.chrome.sidePanel!.open = openSidePanel;
  vi.useFakeTimers();
  try {
    const pending = dispatchRuntime(
      fixture.controller,
      createInPageWidgetCommandEnvelope(fixture.init, {
        type: "ui-attach:widget-side-panel-open",
      }),
      fixture.widgetSender,
    );
    await waitFor(() => openSidePanel.mock.calls.length === 1);
    await vi.advanceTimersByTimeAsync(3_999);
    let settled = false;
    void pending.then(() => {
      settled = true;
    });
    await flushMicrotasks();
    expect(settled).toBe(false);

    await vi.advanceTimersByTimeAsync(1);
    await expect(pending).resolves.toEqual({
      ok: false,
      code: "SIDE_PANEL_OPEN_TIMEOUT",
      error: "MeanThis side panel did not respond within 4 seconds. Try again.",
    });
    expect(openSidePanel).toHaveBeenCalledTimes(1);
  } finally {
    vi.useRealTimers();
  }
});

test.each([
  ["resolve", (deferred: ReturnType<typeof createDeferred<void>>) => deferred.resolve(undefined)],
  ["reject", (deferred: ReturnType<typeof createDeferred<void>>) => deferred.reject(new Error("late"))],
] as const)("consumes a late side-panel %s after timeout", async (_outcome, settle) => {
  const fixture = await createInPageWidgetFixture();
  const deferred = createDeferred<void>();
  const openSidePanel = vi.fn(() => deferred.promise);
  fixture.chrome.sidePanel!.open = openSidePanel;
  vi.useFakeTimers();
  try {
    const pending = dispatchRuntime(
      fixture.controller,
      createInPageWidgetCommandEnvelope(fixture.init, {
        type: "ui-attach:widget-side-panel-open",
      }),
      fixture.widgetSender,
    );
    await waitFor(() => openSidePanel.mock.calls.length === 1);
    await vi.advanceTimersByTimeAsync(4_000);
    await expect(pending).resolves.toMatchObject({
      ok: false,
      code: "SIDE_PANEL_OPEN_TIMEOUT",
    });

    settle(deferred);
    await flushMicrotasks();
    expect(openSidePanel).toHaveBeenCalledTimes(1);
  } finally {
    vi.useRealTimers();
  }
});

test.each([
  "after-canonical-before-marker",
  "after-canonical-ledger-read-unknown",
  "after-publish-before-ACK",
] as const)(
  "recovers an exact committed Agent lifecycle proposal after %s failure",
  async (failurePoint) => {
  const bridge = createLocalAgentBridgeHarness();
  const operationId = "11111111-1111-4111-8111-111111111111";
  const fingerprint = "a".repeat(64);
  const reference = {
    operationId,
    fingerprint,
    ownerGeneration: 2,
    connectionGeneration: 3,
  };
  const approvedAt = new Date(Date.now() - 1_000).toISOString();
  const appliedAt = new Date().toISOString();
  const expiresAt = new Date(Date.now() + 60_000).toISOString();
  let pendingView!: ReturnType<typeof createControlView>;
  let terminal = false;
  let publishAllowed = false;
  let recoveryUnknownOnce = failurePoint === "after-canonical-ledger-read-unknown";
  const control = {
    readAuthority: vi.fn(async () => ({ ownerGeneration: 2, connectionGeneration: 3 })),
    readNext: vi.fn(async () => terminal ? null : pendingView),
    claim: vi.fn(async () => createControlClaim(pendingView, approvedAt, expiresAt)),
    reject: vi.fn(),
    finalize: vi.fn(async (_reference, _approval, receipt) => {
      terminal = true;
      return {
        record: {
          ...pendingView.record,
          phase: "applied" as const,
          approvedAt,
          status: {
            schemaVersion: "0.1.0" as const,
            kind: "ui-attach.annotation-lifecycle-operation-status" as const,
            operationId,
            fingerprint: reference.fingerprint,
            status: "succeeded" as const,
            observedAt: receipt.observedAt,
            receiptId: receipt.receiptId,
            resultingState: "resolved" as const,
            executionAuthority: falseExecutionAuthority(),
          },
          receipt,
        },
        reference,
      };
    }),
  };
  bridge.annotationLifecycleControl = control;
  const fixture = await createInPageWidgetFixture({
    localAgentBridge: bridge,
    onActiveSessionChanged: async () => publishAllowed,
    annotationLifecycleExecutionGate: {
      afterApproved: async () => undefined,
      afterCanonicalCommit: async () => {
        if (failurePoint === "after-canonical-before-marker" ||
            failurePoint === "after-canonical-ledger-read-unknown") {
          throw new Error("simulated service worker stop after canonical commit");
        }
      },
      afterCommitted: async () => undefined,
    },
  });
  const initialResult = await fixture.store.read(ORIGIN);
  expect(initialResult.ok).toBe(true);
  if (!initialResult.ok || !initialResult.value.file || !initialResult.value.epoch) return;
  const initial = structuredClone(initialResult.value);
  initial.file = {
    ...initial.file,
    schemaVersion: "0.3.0",
    session: {
      ...initial.file.session,
      attachments: initial.file.session.attachments.map((candidate) => ({
        ...candidate,
        annotationId: `annotation:${candidate.id}`,
        annotationLifecycle: { state: "open" as const, resolvedAt: null },
      })),
    },
  };
  let currentReadback = structuredClone(initial);
  fixture.store.read = vi.fn(async () => ({ ok: true, value: structuredClone(currentReadback) }));
  const item = initial.file.session.attachments[0]!;
  pendingView = createControlView({
    operationId,
    fingerprint,
    reference,
    captureId: initial.file.session.id,
    annotationId: item.annotationId,
    expiresAt,
  });
  const resolvedReadback = structuredClone(initial);
  const resolvedItem = resolvedReadback.file!.session.attachments[0]!;
  resolvedItem.annotationLifecycle = {
    state: "resolved",
    resolvedAt: appliedAt,
  };
  resolvedItem.updatedAt = appliedAt;
  resolvedReadback.file!.session.updatedAt = appliedAt;
  fixture.store.applyAnnotationLifecycleOperation = vi.fn(async (input, authority) => {
    if (currentReadback.file!.session.attachments[0]!.annotationLifecycle?.state === "open") {
      expect(authority.isCurrent()).toBe(true);
      expect(await authority.refresh(item.sourceRecord as OriginCaptureRecord)).toBe(true);
    } else {
      expect(authority.isCurrent()).toBe(false);
      expect(await authority.refresh(item.sourceRecord as OriginCaptureRecord)).toBe(false);
      if (recoveryUnknownOnce) {
        recoveryUnknownOnce = false;
        return { ok: false, code: "STORAGE_ERROR" as const, error: "transient ledger read failure" };
      }
    }
    currentReadback = structuredClone(resolvedReadback);
    return {
      ok: true,
      value: {
        readback: resolvedReadback,
        receipt: {
          schemaVersion: "0.1.0",
          kind: "ui-attach.annotation-lifecycle-operation-ledger-receipt",
          operationId,
          requestHash: reference.fingerprint,
          epoch: input.epoch,
          itemId: item.id,
          annotationId: item.annotationId,
          previousState: "open",
          nextState: "resolved",
          appliedAt,
        },
      },
    };
  });

  await expect(dispatchRuntime(
    fixture.controller,
    createInPageWidgetCommandEnvelope(fixture.init, {
      type: "ui-attach:widget-lifecycle-control-read-next",
    }),
    fixture.widgetSender,
  )).resolves.toMatchObject({
    ok: true,
    data: {
      itemId: item.id,
      operationId,
      fingerprint: reference.fingerprint,
      nextState: "resolved",
    },
  });

  await expect(dispatchRuntime(
    fixture.controller,
    createInPageWidgetCommandEnvelope(fixture.init, {
      type: "ui-attach:widget-lifecycle-control-approve",
      reference,
      userActivation: false,
    }),
    fixture.widgetSender,
  )).resolves.toMatchObject({ ok: false, code: "UNTRUSTED_SENDER" });
  expect(control.claim).not.toHaveBeenCalled();

  await expect(dispatchRuntime(
    fixture.controller,
    createInPageWidgetCommandEnvelope(fixture.init, {
      type: "ui-attach:widget-lifecycle-control-approve",
      reference,
      userActivation: true,
    }),
    fixture.widgetSender,
  )).resolves.toMatchObject({
    ok: false,
    code: failurePoint === "after-publish-before-ACK" ? "CAPTURE_FAILED" : "STORAGE_ERROR",
  });
  expect(fixture.store.applyAnnotationLifecycleOperation).toHaveBeenCalledTimes(1);
  expect(control.claim).toHaveBeenCalledWith(reference);
  expect(control.finalize).not.toHaveBeenCalled();
  expect(Object.keys(await fixture.chrome.storage.session.get(null)).some((key) =>
    key.startsWith("ui-attach:annotation-lifecycle-control-execution:v1:")
  )).toBe(true);

  publishAllowed = true;
  if (failurePoint === "after-canonical-ledger-read-unknown") {
    await expect(dispatchRuntime(
      fixture.controller,
      createInPageWidgetCommandEnvelope(fixture.init, {
        type: "ui-attach:widget-lifecycle-control-read-next",
      }),
      fixture.widgetSender,
    )).resolves.toMatchObject({ ok: false, code: "STALE_SESSION" });
    expect(control.finalize).not.toHaveBeenCalled();
    expect(Object.keys(await fixture.chrome.storage.session.get(null)).some((key) =>
      key.startsWith("ui-attach:annotation-lifecycle-control-execution:v1:")
    )).toBe(true);
  }
  const recoveryResponse = await dispatchRuntime(
    fixture.controller,
    createInPageWidgetCommandEnvelope(fixture.init, {
      type: "ui-attach:widget-lifecycle-control-read-next",
    }),
    fixture.widgetSender,
  );
  expect(fixture.store.applyAnnotationLifecycleOperation).toHaveBeenCalledTimes(
    failurePoint === "after-canonical-ledger-read-unknown"
      ? 3
      : failurePoint === "after-canonical-before-marker"
        ? 2
        : 1,
  );
  expect(recoveryResponse).toEqual({ ok: true, data: null });
  expect(control.finalize).toHaveBeenCalledWith(
    reference,
    { approvedAt, expiresAt },
    expect.objectContaining({
      operationId,
      fingerprint: reference.fingerprint,
      status: "succeeded",
      observedAt: appliedAt,
      resultingState: "resolved",
      executionAuthority: falseExecutionAuthority(),
    }),
  );
  expect(Object.keys(await fixture.chrome.storage.session.get(null)).some((key) =>
    key.startsWith("ui-attach:annotation-lifecycle-control-execution:v1:")
  )).toBe(false);
  },
);

test("does not orphan a committed lifecycle execution when navigation wins after service-worker restart", async () => {
  const bridge = createLocalAgentBridgeHarness();
  const operationId = "13131313-1313-4313-8313-131313131313";
  const fingerprint = "8".repeat(64);
  const reference = {
    operationId,
    fingerprint,
    ownerGeneration: 2,
    connectionGeneration: 3,
  };
  const approvedAt = new Date(Date.now() - 1_000).toISOString();
  const appliedAt = new Date().toISOString();
  const expiresAt = new Date(Date.now() + 60_000).toISOString();
  let pendingView!: ReturnType<typeof createControlView>;
  let published: ActiveSessionCommandData | null = null;
  const publishedSnapshots: ActiveSessionCommandData[] = [];
  const startupPublishEntered = createDeferred<void>();
  const releaseStartupPublish = createDeferred<void>();
  let gateStartupPublish = true;
  let terminal = false;
  const finalize = vi.fn(async (_reference, _approval, receipt) => {
    const publishedItem = published?.readback?.file?.session.attachments.find((candidate) =>
      candidate.annotationId === pendingView.record.proposal.annotationId
    );
    if (
      !published || published.origin !== ORIGIN ||
      published.readback?.file?.session.id !== pendingView.record.proposal.captureId ||
      publishedItem?.annotationLifecycle.state !== "resolved" ||
      publishedItem.updatedAt !== receipt.observedAt
    ) {
      throw new Error("RECEIPT_MISMATCH");
    }
    terminal = true;
    return {
      record: {
        ...pendingView.record,
        phase: "applied" as const,
        approvedAt,
        status: {
          ...pendingView.record.status,
          status: "succeeded" as const,
          observedAt: receipt.observedAt,
          receiptId: receipt.receiptId,
          resultingState: "resolved" as const,
        },
        receipt,
      },
      reference,
    };
  });
  bridge.annotationLifecycleControl = {
    readAuthority: vi.fn(async () => ({ ownerGeneration: 2, connectionGeneration: 3 })),
    readNext: vi.fn(async () => terminal ? null : pendingView),
    claim: vi.fn(async () => createControlClaim(pendingView, approvedAt, expiresAt)),
    reject: vi.fn(),
    finalize,
  };
  const fixture = await createInPageWidgetFixture({
    localAgentBridge: bridge,
    annotationLifecycleExecutionGate: {
      afterApproved: async () => undefined,
      afterCanonicalCommit: async () => undefined,
      afterCommitted: async () => {
        throw new Error("simulated service worker stop after committed marker");
      },
    },
  });
  const initialResult = await fixture.store.read(ORIGIN);
  expect(initialResult.ok).toBe(true);
  if (!initialResult.ok || !initialResult.value.file || !initialResult.value.epoch) return;
  const initial = structuredClone(initialResult.value);
  initial.file = {
    ...initial.file,
    schemaVersion: "0.3.0",
    session: {
      ...initial.file.session,
      attachments: initial.file.session.attachments.map((candidate) => ({
        ...candidate,
        annotationId: `annotation:${candidate.id}`,
        annotationLifecycle: { state: "open" as const, resolvedAt: null },
      })),
    },
  };
  let currentReadback = structuredClone(initial);
  fixture.store.read = vi.fn(async () => ({ ok: true, value: structuredClone(currentReadback) }));
  const item = initial.file.session.attachments[0]!;
  pendingView = createControlView({
    operationId,
    fingerprint,
    reference,
    captureId: initial.file.session.id,
    annotationId: item.annotationId,
    expiresAt,
  });
  const resolvedReadback = structuredClone(initial);
  const resolvedItem = resolvedReadback.file!.session.attachments[0]!;
  resolvedItem.annotationLifecycle = { state: "resolved", resolvedAt: appliedAt };
  resolvedItem.updatedAt = appliedAt;
  resolvedReadback.file!.session.updatedAt = appliedAt;
  fixture.store.applyAnnotationLifecycleOperation = vi.fn(async (input, authority) => {
    expect(await authority.refresh(item.sourceRecord as OriginCaptureRecord)).toBe(true);
    currentReadback = structuredClone(resolvedReadback);
    return {
      ok: true,
      value: {
        readback: structuredClone(resolvedReadback),
        receipt: {
          schemaVersion: "0.1.0" as const,
          kind: "ui-attach.annotation-lifecycle-operation-ledger-receipt" as const,
          operationId,
          requestHash: reference.fingerprint,
          epoch: input.epoch,
          itemId: item.id,
          annotationId: item.annotationId,
          previousState: "open" as const,
          nextState: "resolved" as const,
          appliedAt,
        },
      },
    };
  });

  await expect(dispatchRuntime(
    fixture.controller,
    createInPageWidgetCommandEnvelope(fixture.init, {
      type: "ui-attach:widget-lifecycle-control-read-next",
    }),
    fixture.widgetSender,
  )).resolves.toMatchObject({ ok: true, data: { operationId } });
  await expect(dispatchRuntime(
    fixture.controller,
    createInPageWidgetCommandEnvelope(fixture.init, {
      type: "ui-attach:widget-lifecycle-control-approve",
      reference,
      userActivation: true,
    }),
    fixture.widgetSender,
  )).resolves.toMatchObject({ ok: false, code: "STORAGE_ERROR" });
  expect(finalize).not.toHaveBeenCalled();

  const restarted = createBackgroundController({
    chrome: fixture.chrome,
    store: fixture.store,
    ensureContentScript: fixture.ensureContentScript,
    runtimeFeatures: [createLocalAgentBridgeRuntimeFeature(bridge)],
    onActiveSessionChanged: async (data) => {
      published = structuredClone(data);
      publishedSnapshots.push(structuredClone(data));
      if (gateStartupPublish && data.enabled) {
        gateStartupPublish = false;
        startupPublishEntered.resolve(undefined);
        await releaseStartupPublish.promise;
      }
      return true;
    },
  });
  restarted.register();
  await startupPublishEntered.promise;
  const navigation = restarted.handleTabUpdated(
    WIDGET_TAB_ID,
    { status: "loading", url: `${ORIGIN}/replacement-after-restart` },
    { id: WIDGET_TAB_ID, windowId: 1, url: `${ORIGIN}/replacement-after-restart` },
  );
  releaseStartupPublish.resolve(undefined);
  await navigation;

  expect(publishedSnapshots.some((snapshot) => (
    snapshot.readback?.file?.session.attachments[0]?.annotationLifecycle.state === "resolved" &&
    snapshot.readback.file.session.attachments[0]?.updatedAt === appliedAt
  ))).toBe(true);
  expect(published).toEqual({
    enabled: false,
    origin: null,
    activePage: null,
    readback: null,
  });
  expect(publishedSnapshots.at(-2)?.readback?.file?.session.attachments[0]?.annotationLifecycle).toEqual({
    state: "resolved",
    resolvedAt: appliedAt,
  });
  expect(finalize).toHaveBeenCalledOnce();
  expect(Object.keys(await fixture.chrome.storage.session.get(null)).some((key) =>
    key.startsWith("ui-attach:annotation-lifecycle-control-execution:v1:")
  )).toBe(false);
});

test("reconciles an exact committed lifecycle change after Owner generation rotation without ACKing the old Owner", async () => {
  const bridge = createLocalAgentBridgeHarness();
  const operationId = "66666666-6666-4666-8666-666666666666";
  const fingerprint = "7".repeat(64);
  const reference = {
    operationId,
    fingerprint,
    ownerGeneration: 2,
    connectionGeneration: 3,
  };
  const approvedAt = new Date(Date.now() - 1_000).toISOString();
  const appliedAt = new Date().toISOString();
  const expiresAt = new Date(Date.now() + 60_000).toISOString();
  let pendingView!: ReturnType<typeof createControlView>;
  let ownerAuthority = { ownerGeneration: 2, connectionGeneration: 3 };
  let ownerTerminal = false;
  const control = {
    readAuthority: vi.fn(async () => ownerAuthority),
    readNext: vi.fn(async () => ownerTerminal ? null : pendingView),
    claim: vi.fn(async () => createControlClaim(pendingView, approvedAt, expiresAt)),
    reject: vi.fn(),
    finalize: vi.fn(),
  };
  bridge.annotationLifecycleControl = control;
  const published: ActiveSessionCommandData[] = [];
  const fixture = await createInPageWidgetFixture({
    localAgentBridge: bridge,
    onActiveSessionChanged: async (data) => {
      published.push(structuredClone(data));
      return true;
    },
    annotationLifecycleExecutionGate: {
      afterApproved: async () => undefined,
      afterCanonicalCommit: async () => undefined,
      afterCommitted: async () => {
        throw new Error("simulated worker stop after committed marker");
      },
    },
  });
  const initialResult = await fixture.store.read(ORIGIN);
  expect(initialResult.ok).toBe(true);
  if (!initialResult.ok || !initialResult.value.file || !initialResult.value.epoch) return;
  const initial = structuredClone(initialResult.value);
  initial.file = {
    ...initial.file,
    schemaVersion: "0.3.0",
    session: {
      ...initial.file.session,
      attachments: initial.file.session.attachments.map((candidate) => ({
        ...candidate,
        annotationId: `annotation:${candidate.id}`,
        annotationLifecycle: { state: "open" as const, resolvedAt: null },
      })),
    },
  };
  let currentReadback = structuredClone(initial);
  fixture.store.read = vi.fn(async () => ({ ok: true, value: structuredClone(currentReadback) }));
  const item = initial.file.session.attachments[0]!;
  pendingView = createControlView({
    operationId,
    fingerprint,
    reference,
    captureId: initial.file.session.id,
    annotationId: item.annotationId,
    expiresAt,
  });
  const resolvedReadback = structuredClone(initial);
  const resolvedItem = resolvedReadback.file!.session.attachments[0]!;
  resolvedItem.annotationLifecycle = { state: "resolved", resolvedAt: appliedAt };
  resolvedItem.updatedAt = appliedAt;
  resolvedReadback.file!.session.updatedAt = appliedAt;
  fixture.store.applyAnnotationLifecycleOperation = vi.fn(async (input, authority) => {
    expect(await authority.refresh(item.sourceRecord as OriginCaptureRecord)).toBe(true);
    currentReadback = structuredClone(resolvedReadback);
    return {
      ok: true,
      value: {
        readback: structuredClone(resolvedReadback),
        receipt: {
          schemaVersion: "0.1.0" as const,
          kind: "ui-attach.annotation-lifecycle-operation-ledger-receipt" as const,
          operationId,
          requestHash: reference.fingerprint,
          epoch: input.epoch,
          itemId: item.id,
          annotationId: item.annotationId,
          previousState: "open" as const,
          nextState: "resolved" as const,
          appliedAt,
        },
      },
    };
  });

  await expect(dispatchRuntime(
    fixture.controller,
    createInPageWidgetCommandEnvelope(fixture.init, {
      type: "ui-attach:widget-lifecycle-control-read-next",
    }),
    fixture.widgetSender,
  )).resolves.toMatchObject({ ok: true, data: { operationId } });
  await expect(dispatchRuntime(
    fixture.controller,
    createInPageWidgetCommandEnvelope(fixture.init, {
      type: "ui-attach:widget-lifecycle-control-approve",
      reference,
      userActivation: true,
    }),
    fixture.widgetSender,
  )).resolves.toMatchObject({ ok: false, code: "STORAGE_ERROR" });
  expect(control.finalize).not.toHaveBeenCalled();

  ownerAuthority = { ownerGeneration: 4, connectionGeneration: 5 };
  ownerTerminal = true;
  await expect(dispatchRuntime(
    fixture.controller,
    createInPageWidgetCommandEnvelope(fixture.init, {
      type: "ui-attach:widget-lifecycle-control-read-next",
    }),
    fixture.widgetSender,
  )).resolves.toEqual({ ok: true, data: null });

  expect(published).toHaveLength(1);
  expect(published[0]?.readback?.file?.session.attachments[0]?.annotationLifecycle).toEqual({
    state: "resolved",
    resolvedAt: appliedAt,
  });
  expect(control.finalize).not.toHaveBeenCalled();
  expect(Object.keys(await fixture.chrome.storage.session.get(null)).some((key) =>
    key.startsWith("ui-attach:annotation-lifecycle-control-execution:v1:")
  )).toBe(false);
});

test.each(["unavailable", "mismatched"] as const)(
  "does not mutate an approved Agent lifecycle execution when Owner authority is %s",
  async (authorityState) => {
  const bridge = createLocalAgentBridgeHarness();
  const operationId = "77777777-7777-4777-8777-777777777777";
  const fingerprint = "e".repeat(64);
  const reference = {
    operationId,
    fingerprint,
    ownerGeneration: 2,
    connectionGeneration: 3,
  };
  const control = {
    readAuthority: vi.fn(async () => {
      if (authorityState === "unavailable") throw new Error("owner unavailable");
      return { ownerGeneration: 9, connectionGeneration: 10 };
    }),
    readNext: vi.fn(async () => null),
    claim: vi.fn(),
    reject: vi.fn(),
    finalize: vi.fn(),
  };
  bridge.annotationLifecycleControl = control;
  const fixture = await createInPageWidgetFixture({ localAgentBridge: bridge });
  fixture.store.applyAnnotationLifecycleOperation = vi.fn(async () => ({
    ok: false,
    code: "ANNOTATION_LIFECYCLE_NOT_COMMITTED" as const,
    error: "No exact lifecycle ledger receipt exists.",
  }));
  const initialResult = await fixture.store.read(ORIGIN);
  expect(initialResult.ok).toBe(true);
  if (!initialResult.ok || !initialResult.value.file || !initialResult.value.epoch) return;
  const initial = structuredClone(initialResult.value);
  initial.file = {
    ...initial.file,
    schemaVersion: "0.3.0",
    session: {
      ...initial.file.session,
      attachments: initial.file.session.attachments.map((candidate) => ({
        ...candidate,
        annotationId: `annotation:${candidate.id}`,
        annotationLifecycle: { state: "open" as const, resolvedAt: null },
      })),
    },
  };
  fixture.store.read = vi.fn(async () => ({ ok: true, value: structuredClone(initial) }));
  const item = initial.file.session.attachments[0]!;
  const approvedAt = new Date(Date.now() - 1_000).toISOString();
  const expiresAt = new Date(Date.now() + 60_000).toISOString();
  const view = createControlView({
    operationId,
    fingerprint,
    reference,
    captureId: initial.file.session.id,
    annotationId: item.annotationId,
    expiresAt,
  });
  const executionStore = createAnnotationLifecycleControlExecutionStore({
    storage: fixture.chrome.storage.session,
  });
  await executionStore.saveApproved({
    schemaVersion: "0.1.0",
    kind: "ui-attach.annotation-lifecycle-approved-operation",
    phase: "approved",
    proposal: view.record.proposal,
    reference,
    approval: {
      approvedAt,
      expiresAt,
    },
    origin: ORIGIN,
    epoch: initial.epoch,
    itemId: item.id,
    surfaceId: fixture.init.surfaceId,
    tabId: WIDGET_TAB_ID,
    frameId: 0,
    documentId: WIDGET_TOP_DOCUMENT_ID,
    pathname: "/settings",
    routeLeaseHash: "f".repeat(64),
    terminalStatus: null,
    terminalObservedAt: null,
    committedReceipt: null,
  });

  await expect(dispatchRuntime(
    fixture.controller,
    createInPageWidgetCommandEnvelope(fixture.init, {
      type: "ui-attach:widget-lifecycle-control-read-next",
    }),
    fixture.widgetSender,
  )).resolves.toEqual({ ok: true, data: null });

  expect(control.readAuthority).toHaveBeenCalled();
  expect(fixture.store.applyAnnotationLifecycleOperation).toHaveBeenCalledTimes(1);
  const recoveryAuthority = vi.mocked(fixture.store.applyAnnotationLifecycleOperation).mock.calls[0]?.[1];
  expect(recoveryAuthority?.isCurrent()).toBe(false);
  await expect(recoveryAuthority?.refresh(item.sourceRecord as OriginCaptureRecord)).resolves.toBe(false);
  expect(control.finalize).not.toHaveBeenCalled();
  expect(control.reject).not.toHaveBeenCalled();
  if (authorityState === "unavailable") {
    await expect(executionStore.read(ORIGIN, operationId)).resolves.toMatchObject({
      phase: "approved",
      reference,
    });
  } else {
    await expect(executionStore.read(ORIGIN, operationId)).resolves.toBeNull();
  }
  },
);

test("does not mutate after the trusted click when Owner authority rotates at the final write gate", async () => {
  const bridge = createLocalAgentBridgeHarness();
  const operationId = "99999999-9999-4999-8999-999999999999";
  const fingerprint = "8".repeat(64);
  const reference = {
    operationId,
    fingerprint,
    ownerGeneration: 2,
    connectionGeneration: 3,
  };
  const approvedAt = new Date(Date.now() - 1_000).toISOString();
  const expiresAt = new Date(Date.now() + 60_000).toISOString();
  let pendingView!: ReturnType<typeof createControlView>;
  let mutationStarted = false;
  let mutationAuthorityReads = 0;
  const control = {
    readAuthority: vi.fn(async () => {
      if (!mutationStarted) return { ownerGeneration: 2, connectionGeneration: 3 };
      mutationAuthorityReads += 1;
      return mutationAuthorityReads === 1
        ? { ownerGeneration: 2, connectionGeneration: 3 }
        : { ownerGeneration: 4, connectionGeneration: 5 };
    }),
    readNext: vi.fn(async () => pendingView),
    claim: vi.fn(async () => createControlClaim(pendingView, approvedAt, expiresAt)),
    reject: vi.fn(),
    finalize: vi.fn(),
  };
  bridge.annotationLifecycleControl = control;
  const fixture = await createInPageWidgetFixture({ localAgentBridge: bridge });
  const initialResult = await fixture.store.read(ORIGIN);
  expect(initialResult.ok).toBe(true);
  if (!initialResult.ok || !initialResult.value.file || !initialResult.value.epoch) return;
  const initial = structuredClone(initialResult.value);
  initial.file = {
    ...initial.file,
    schemaVersion: "0.3.0",
    session: {
      ...initial.file.session,
      attachments: initial.file.session.attachments.map((candidate) => ({
        ...candidate,
        annotationId: `annotation:${candidate.id}`,
        annotationLifecycle: { state: "open" as const, resolvedAt: null },
      })),
    },
  };
  fixture.store.read = vi.fn(async () => ({ ok: true, value: structuredClone(initial) }));
  const item = initial.file.session.attachments[0]!;
  pendingView = createControlView({
    operationId,
    fingerprint,
    reference,
    captureId: initial.file.session.id,
    annotationId: item.annotationId,
    expiresAt,
  });
  fixture.store.applyAnnotationLifecycleOperation = vi.fn(async (_input, authority) => {
    mutationStarted = true;
    expect(await authority.refresh(item.sourceRecord as OriginCaptureRecord)).toBe(true);
    expect(await authority.refresh(item.sourceRecord as OriginCaptureRecord)).toBe(false);
    return {
      ok: false,
      code: "ANNOTATION_LIFECYCLE_NOT_COMMITTED" as const,
      error: "Owner authority rotated before the canonical write.",
    };
  });

  await expect(dispatchRuntime(
    fixture.controller,
    createInPageWidgetCommandEnvelope(fixture.init, {
      type: "ui-attach:widget-lifecycle-control-read-next",
    }),
    fixture.widgetSender,
  )).resolves.toMatchObject({ ok: true, data: { operationId } });

  await expect(dispatchRuntime(
    fixture.controller,
    createInPageWidgetCommandEnvelope(fixture.init, {
      type: "ui-attach:widget-lifecycle-control-approve",
      reference,
      userActivation: true,
    }),
    fixture.widgetSender,
  )).resolves.toMatchObject({ ok: false, code: "STALE_SESSION" });

  expect(mutationAuthorityReads).toBe(2);
  expect(fixture.store.applyAnnotationLifecycleOperation).toHaveBeenCalledTimes(1);
  const after = await fixture.store.read(ORIGIN);
  expect(after).toEqual({ ok: true, value: initial });
  expect(initial.file.session.attachments[0]?.annotationLifecycle).toEqual({
    state: "open",
    resolvedAt: null,
  });
});

test("does not persist a lifecycle delivery that races a canonical clear", async () => {
  const bridge = createLocalAgentBridgeHarness();
  const operationId = "88888888-8888-4888-8888-888888888888";
  const fingerprint = "9".repeat(64);
  const reference = {
    operationId,
    fingerprint,
    ownerGeneration: 2,
    connectionGeneration: 3,
  };
  const pendingRead = createDeferred<ReturnType<typeof createControlView>>();
  const control = {
    readAuthority: vi.fn(async () => ({ ownerGeneration: 2, connectionGeneration: 3 })),
    readNext: vi.fn(() => pendingRead.promise),
    claim: vi.fn(),
    reject: vi.fn(),
    finalize: vi.fn(),
  };
  bridge.annotationLifecycleControl = control;
  const fixture = await createInPageWidgetFixture({ localAgentBridge: bridge });
  const initialResult = await fixture.store.read(ORIGIN);
  expect(initialResult.ok).toBe(true);
  if (!initialResult.ok || !initialResult.value.file || !initialResult.value.epoch) return;
  const initial = structuredClone(initialResult.value);
  initial.file = {
    ...initial.file,
    schemaVersion: "0.3.0",
    session: {
      ...initial.file.session,
      attachments: initial.file.session.attachments.map((candidate) => ({
        ...candidate,
        annotationId: `annotation:${candidate.id}`,
        annotationLifecycle: { state: "open" as const, resolvedAt: null },
      })),
    },
  };
  fixture.store.read = vi.fn(async () => ({ ok: true, value: structuredClone(initial) }));
  const item = initial.file.session.attachments[0]!;
  const pendingView = createControlView({
    operationId,
    fingerprint,
    reference,
    captureId: initial.file.session.id,
    annotationId: item.annotationId,
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
  });

  const reading = dispatchRuntime(
    fixture.controller,
    createInPageWidgetCommandEnvelope(fixture.init, {
      type: "ui-attach:widget-lifecycle-control-read-next",
    }),
    fixture.widgetSender,
  );
  await waitFor(() => control.readNext.mock.calls.length === 1);
  const readsBeforeClear = vi.mocked(fixture.store.read).mock.calls.length;
  const clearing = dispatchRuntime(
    fixture.controller,
    createInPageWidgetCommandEnvelope(fixture.init, {
      type: "ui-attach:widget-session-clear",
      expectedEpoch: initial.epoch,
      operationId: "widget-clear-races-lifecycle-delivery",
      scope: "live-page",
    }),
    fixture.widgetSender,
  );
  await waitFor(() => vi.mocked(fixture.store.read).mock.calls.length > readsBeforeClear);
  pendingRead.resolve(pendingView);

  await expect(reading).resolves.toMatchObject({ ok: false, code: "CLEAR_IN_PROGRESS" });
  expect(Object.keys(await fixture.chrome.storage.session.get(null)).some((key) =>
    key.startsWith("ui-attach:annotation-lifecycle-control-delivery:v1:")
  )).toBe(false);
  const clearResult = await clearing;
  expect(clearResult).not.toMatchObject({
    ok: false,
    error: "MeanThis could not cancel pending Agent lifecycle approvals before clearing.",
  });
});

test("rejects a durably delivered pending Agent lifecycle proposal on top-document navigation", async () => {
  const bridge = createLocalAgentBridgeHarness();
  const operationId = "44444444-4444-4444-8444-444444444444";
  const fingerprint = "c".repeat(64);
  const reference = {
    operationId,
    fingerprint,
    ownerGeneration: 2,
    connectionGeneration: 3,
  };
  let pendingView!: ReturnType<typeof createControlView>;
  const reject = vi.fn(async () => ({
    record: {
      ...pendingView.record,
      phase: "rejected" as const,
      status: {
        ...pendingView.record.status,
        status: "rejected" as const,
        observedAt: "2026-09-01T00:00:02.000Z",
        receiptId: `mailbox-rejected-${reference.fingerprint.slice(0, 16)}`,
        resultingState: null,
      },
    },
    reference,
  }));
  bridge.annotationLifecycleControl = {
    readAuthority: vi.fn(async () => ({ ownerGeneration: 2, connectionGeneration: 3 })),
    readNext: vi.fn(async () => pendingView),
    claim: vi.fn(),
    reject,
    finalize: vi.fn(),
  };
  const fixture = await createInPageWidgetFixture({ localAgentBridge: bridge });
  const initialResult = await fixture.store.read(ORIGIN);
  expect(initialResult.ok).toBe(true);
  if (!initialResult.ok || !initialResult.value.file) return;
  const initial = structuredClone(initialResult.value);
  initial.file = {
    ...initial.file,
    schemaVersion: "0.3.0",
    session: {
      ...initial.file.session,
      attachments: initial.file.session.attachments.map((candidate) => ({
        ...candidate,
        annotationId: `annotation:${candidate.id}`,
        annotationLifecycle: { state: "open" as const, resolvedAt: null },
      })),
    },
  };
  fixture.store.read = vi.fn(async () => ({ ok: true, value: structuredClone(initial) }));
  const item = initial.file.session.attachments[0]!;
  pendingView = createControlView({
    operationId,
    fingerprint,
    reference,
    captureId: initial.file.session.id,
    annotationId: item.annotationId,
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
  });

  await expect(dispatchRuntime(
    fixture.controller,
    createInPageWidgetCommandEnvelope(fixture.init, {
      type: "ui-attach:widget-lifecycle-control-read-next",
    }),
    fixture.widgetSender,
  )).resolves.toMatchObject({ ok: true, data: { operationId } });
  expect(Object.keys(await fixture.chrome.storage.session.get(null)).some((key) =>
    key.startsWith("ui-attach:annotation-lifecycle-control-delivery:v1:")
  )).toBe(true);

  await fixture.controller.handleNavigationCommitted({
    tabId: WIDGET_TAB_ID,
    frameId: 0,
    parentFrameId: -1,
    documentId: "replacement-top-document",
    url: `${ORIGIN}/replacement`,
  });

  expect(reject).toHaveBeenCalledWith(reference);
  expect(Object.keys(await fixture.chrome.storage.session.get(null)).some((key) =>
    key.startsWith("ui-attach:annotation-lifecycle-control-delivery:v1:")
  )).toBe(false);
});

test("reports reject cleanup failure and retires the exact durable delivery on the next read", async () => {
  const bridge = createLocalAgentBridgeHarness();
  const operationId = "12121212-1212-4212-8212-121212121212";
  const fingerprint = "6".repeat(64);
  const reference = {
    operationId,
    fingerprint,
    ownerGeneration: 2,
    connectionGeneration: 3,
  };
  let pendingView!: ReturnType<typeof createControlView>;
  let terminal = false;
  const reject = vi.fn(async () => {
    terminal = true;
    return {
      record: {
        ...pendingView.record,
        phase: "rejected" as const,
        status: {
          ...pendingView.record.status,
          status: "rejected" as const,
          observedAt: new Date().toISOString(),
          receiptId: `mailbox-rejected-${reference.fingerprint.slice(0, 16)}`,
          resultingState: null,
        },
      },
      reference,
    };
  });
  bridge.annotationLifecycleControl = {
    readAuthority: vi.fn(async () => ({ ownerGeneration: 2, connectionGeneration: 3 })),
    readNext: vi.fn(async () => terminal ? null : pendingView),
    claim: vi.fn(),
    reject,
    finalize: vi.fn(),
  };
  const fixture = await createInPageWidgetFixture({ localAgentBridge: bridge });
  const initialResult = await fixture.store.read(ORIGIN);
  expect(initialResult.ok).toBe(true);
  if (!initialResult.ok || !initialResult.value.file) return;
  const initial = structuredClone(initialResult.value);
  initial.file = {
    ...initial.file,
    schemaVersion: "0.3.0",
    session: {
      ...initial.file.session,
      attachments: initial.file.session.attachments.map((candidate) => ({
        ...candidate,
        annotationId: `annotation:${candidate.id}`,
        annotationLifecycle: { state: "open" as const, resolvedAt: null },
      })),
    },
  };
  fixture.store.read = vi.fn(async () => ({ ok: true, value: structuredClone(initial) }));
  const item = initial.file.session.attachments[0]!;
  pendingView = createControlView({
    operationId,
    fingerprint,
    reference,
    captureId: initial.file.session.id,
    annotationId: item.annotationId,
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
  });

  await expect(dispatchRuntime(
    fixture.controller,
    createInPageWidgetCommandEnvelope(fixture.init, {
      type: "ui-attach:widget-lifecycle-control-read-next",
    }),
    fixture.widgetSender,
  )).resolves.toMatchObject({ ok: true, data: { operationId } });
  const originalSessionRemove = fixture.chrome.storage.session.remove;
  fixture.chrome.storage.session.remove = vi.fn(async () => {
    throw new Error("simulated durable delivery cleanup failure");
  });

  await expect(dispatchRuntime(
    fixture.controller,
    createInPageWidgetCommandEnvelope(fixture.init, {
      type: "ui-attach:widget-lifecycle-control-reject",
      reference,
      userActivation: true,
    }),
    fixture.widgetSender,
  )).resolves.toMatchObject({ ok: false, code: "STORAGE_ERROR" });
  expect(reject).toHaveBeenCalledWith(reference);
  expect(Object.keys(await fixture.chrome.storage.session.get(null)).some((key) =>
    key.startsWith("ui-attach:annotation-lifecycle-control-delivery:v1:")
  )).toBe(true);

  fixture.chrome.storage.session.remove = originalSessionRemove;
  await expect(dispatchRuntime(
    fixture.controller,
    createInPageWidgetCommandEnvelope(fixture.init, {
      type: "ui-attach:widget-lifecycle-control-read-next",
    }),
    fixture.widgetSender,
  )).resolves.toEqual({ ok: true, data: null });
  expect(Object.keys(await fixture.chrome.storage.session.get(null)).some((key) =>
    key.startsWith("ui-attach:annotation-lifecycle-control-delivery:v1:")
  )).toBe(false);
});

test("rejects a durably delivered pending Agent lifecycle proposal before removing its target", async () => {
  const bridge = createLocalAgentBridgeHarness();
  const operationId = "55555555-5555-4555-8555-555555555555";
  const fingerprint = "d".repeat(64);
  const reference = {
    operationId,
    fingerprint,
    ownerGeneration: 2,
    connectionGeneration: 3,
  };
  let pendingView!: ReturnType<typeof createControlView>;
  let terminal = false;
  const events: string[] = [];
  const reject = vi.fn(async () => {
    events.push("reject");
    terminal = true;
    return {
      record: {
        ...pendingView.record,
        phase: "rejected" as const,
        status: {
          ...pendingView.record.status,
          status: "rejected" as const,
          observedAt: "2026-09-01T00:00:02.000Z",
          receiptId: `mailbox-rejected-${reference.fingerprint.slice(0, 16)}`,
          resultingState: null,
        },
      },
      reference,
    };
  });
  bridge.annotationLifecycleControl = {
    readAuthority: vi.fn(async () => ({ ownerGeneration: 2, connectionGeneration: 3 })),
    readNext: vi.fn(async () => terminal ? null : pendingView),
    claim: vi.fn(),
    reject,
    finalize: vi.fn(),
  };
  const fixture = await createInPageWidgetFixture({ localAgentBridge: bridge });
  const initialResult = await fixture.store.read(ORIGIN);
  expect(initialResult.ok).toBe(true);
  if (!initialResult.ok || !initialResult.value.file) return;
  const initial = structuredClone(initialResult.value);
  initial.file = {
    ...initial.file,
    schemaVersion: "0.3.0",
    session: {
      ...initial.file.session,
      attachments: initial.file.session.attachments.map((candidate) => ({
        ...candidate,
        annotationId: `annotation:${candidate.id}`,
        annotationLifecycle: { state: "open" as const, resolvedAt: null },
      })),
    },
  };
  let current = structuredClone(initial);
  fixture.store.read = vi.fn(async () => ({ ok: true, value: structuredClone(current) }));
  const item = initial.file.session.attachments[0]!;
  pendingView = createControlView({
    operationId,
    fingerprint,
    reference,
    captureId: initial.file.session.id,
    annotationId: item.annotationId,
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
  });
  fixture.store.removeItem = vi.fn(async () => {
    events.push("remove");
    current = structuredClone(initial);
    current.file!.session.attachments = [];
    return { ok: true, value: structuredClone(current) };
  });

  await expect(dispatchRuntime(
    fixture.controller,
    createInPageWidgetCommandEnvelope(fixture.init, {
      type: "ui-attach:widget-lifecycle-control-read-next",
    }),
    fixture.widgetSender,
  )).resolves.toMatchObject({ ok: true, data: { operationId } });

  await expect(dispatchRuntime(
    fixture.controller,
    createInPageWidgetCommandEnvelope(fixture.init, {
      type: "ui-attach:widget-item-remove",
      expectedEpoch: initial.epoch,
      itemId: item.id,
    }),
    fixture.widgetSender,
  )).resolves.toMatchObject({ ok: true });

  expect(events).toEqual(["reject", "remove"]);
  expect(Object.keys(await fixture.chrome.storage.session.get(null)).some((key) =>
    key.startsWith("ui-attach:annotation-lifecycle-control-delivery:v1:")
  )).toBe(false);
});

test("widget item removal fails closed until diagnostics cleanup can be retried", async () => {
  const fixture = await createInPageWidgetFixture();
  const initialResult = await fixture.store.read(ORIGIN);
  if (!initialResult.ok || !initialResult.value.file || !initialResult.value.epoch) {
    throw new Error("widget session readback failed");
  }
  let current = structuredClone(initialResult.value);
  fixture.store.read = vi.fn(async () => ({ ok: true, value: structuredClone(current) }));
  fixture.store.removeItem = vi.fn(async () => {
    current = structuredClone(current);
    current.file!.session.attachments = [];
    return { ok: true, value: structuredClone(current) };
  });
  const diagnosticsKey = getMetadataDiagnosticsSessionStorageKey(ORIGIN);
  await fixture.chrome.storage.session.set({ [diagnosticsKey]: { pending: true } });
  const originalSessionRemove = fixture.chrome.storage.session.remove;
  let rejectDiagnosticsCleanup = true;
  fixture.chrome.storage.session.remove = vi.fn(async (keys) => {
    const removesDiagnostics = Array.isArray(keys)
      ? keys.includes(diagnosticsKey)
      : keys === diagnosticsKey;
    if (rejectDiagnosticsCleanup && removesDiagnostics) {
      rejectDiagnosticsCleanup = false;
      throw new Error("simulated diagnostics cleanup failure");
    }
    await originalSessionRemove(keys);
  });
  const command = createInPageWidgetCommandEnvelope(fixture.init, {
    type: "ui-attach:widget-item-remove",
    expectedEpoch: initialResult.value.epoch,
    itemId: fixture.itemId,
  });

  await expect(dispatchRuntime(
    fixture.controller,
    command,
    fixture.widgetSender,
  )).resolves.toMatchObject({ ok: false, code: "STORAGE_ERROR" });
  expect(current.file?.session.attachments).toEqual([]);
  expect((await fixture.chrome.storage.session.get(diagnosticsKey))[diagnosticsKey]).toBeDefined();

  await expect(dispatchRuntime(
    fixture.controller,
    command,
    fixture.widgetSender,
  )).resolves.toMatchObject({ ok: true });
  expect((await fixture.chrome.storage.session.get(diagnosticsKey))[diagnosticsKey]).toBeUndefined();
});

function createControlView(input: {
  operationId: string;
  fingerprint: string;
  reference: {
    operationId: string;
    fingerprint: string;
    ownerGeneration: number;
    connectionGeneration: number;
  };
  captureId: string;
  annotationId: string;
  expiresAt: string;
}) {
  const proposal = {
    schemaVersion: "0.1.0" as const,
    kind: "ui-attach.annotation-lifecycle-operation" as const,
    operationId: input.operationId,
    instanceId: "instance-0123456789ab",
    captureId: input.captureId,
    expectedSequence: 4,
    annotationId: input.annotationId,
    expectedState: "open" as const,
    nextState: "resolved" as const,
  };
  const fingerprintInput = createAnnotationLifecycleOperationFingerprintInput(proposal);
  if (!fingerprintInput) throw new Error("Invalid lifecycle proposal fixture.");
  const fingerprint = createHash("sha256").update(fingerprintInput).digest("hex");
  input.reference.fingerprint = fingerprint;
  return {
    record: {
      proposal,
      fingerprint,
      phase: "awaiting_user" as const,
      status: {
        schemaVersion: "0.1.0" as const,
        kind: "ui-attach.annotation-lifecycle-operation-status" as const,
        operationId: input.operationId,
        fingerprint,
        status: "pending" as const,
        observedAt: "2026-09-01T00:00:00.000Z",
        receiptId: null,
        resultingState: null,
        executionAuthority: falseExecutionAuthority(),
      },
      createdAt: "2026-09-01T00:00:00.000Z",
      expiresAt: input.expiresAt,
      approvedAt: null,
      ownerGeneration: input.reference.ownerGeneration,
      connectionGeneration: input.reference.connectionGeneration,
      receipt: null,
    },
    reference: input.reference,
  };
}

function createControlClaim(
  view: ReturnType<typeof createControlView>,
  approvedAt: string,
  expiresAt: string,
) {
  return {
    record: {
      ...view.record,
      phase: "executing" as const,
      approvedAt,
      status: {
        ...view.record.status,
        status: "applying" as const,
        observedAt: approvedAt,
      },
    },
    reference: view.reference,
    approval: { approvedAt, expiresAt },
  };
}

function falseExecutionAuthority() {
  return { grantedByCapture: false as const, browserControl: false as const, liveDomMutation: false as const };
}

interface InPageWidgetTestFixture {
  chrome: ReturnType<typeof createChromeHarness>;
  controller: ReturnType<typeof createBackgroundController>;
  ensureContentScript: ReturnType<typeof vi.fn>;
  frameState: { topDocumentId: string; widgetDocumentId: string | undefined };
  init: InPageWidgetInitMessage;
  itemId: string;
  store: ReturnType<typeof createStoreHarness>;
  widgetSender: UiAttachChromeMessageSender;
}

async function createInPageWidgetFixture(options: {
  localAgentBridge?: LocalAgentBridgeClient;
  captureCommitGate?: {
    beforeWrite(operationId: string): Promise<void>;
    afterWrite(operationId: string): Promise<void>;
  };
  annotationLifecycleExecutionGate?: {
    afterApproved(operationId: string): Promise<void>;
    afterCanonicalCommit(operationId: string): Promise<void>;
    afterCommitted(operationId: string): Promise<void>;
  };
  onActiveSessionChanged?(data: ActiveSessionCommandData): Promise<boolean | void>;
  configureChrome?(chrome: ReturnType<typeof createChromeHarness>): void;
} = {}): Promise<InPageWidgetTestFixture> {
  let fixtureReady = false;
  const chrome = createChromeHarness();
  options.configureChrome?.(chrome);
  chrome.runtime.id = WIDGET_RUNTIME_ID;
  chrome.tabs.query = vi.fn(async ({ active }) => active
    ? [{ id: WIDGET_TAB_ID, url: `${ORIGIN}/settings`, windowId: WIDGET_WINDOW_ID }]
    : []);
  const frameState = {
    topDocumentId: WIDGET_TOP_DOCUMENT_ID,
    widgetDocumentId: WIDGET_DOCUMENT_ID,
  };
  chrome.webNavigation.getFrame = vi.fn(async ({ tabId, frameId }) => {
    if (tabId !== WIDGET_TAB_ID) return undefined;
    if (frameId === 0) {
      return {
        documentId: frameState.topDocumentId,
        parentFrameId: -1,
        url: `${ORIGIN}/settings`,
      };
    }
    if (frameId === WIDGET_FRAME_ID) {
      return {
        documentId: frameState.widgetDocumentId,
        parentFrameId: 0,
        url: WIDGET_URL,
      };
    }
    return undefined;
  });
  chrome.webNavigation.getAllFrames = vi.fn(async ({ tabId }) => tabId === WIDGET_TAB_ID
    ? [{
        frameId: 0,
        parentFrameId: -1,
        documentId: frameState.topDocumentId,
        url: `${ORIGIN}/settings`,
      }]
    : []);
  chrome.tabs.sendMessage = vi.fn(async (_tabId, message) => (
    isRecord(message) && (
      message.type === UI_ATTACH_IN_PAGE_WIDGET_ENSURE ||
      message.type === UI_ATTACH_IN_PAGE_WIDGET_INIT
    )
      ? { ok: true, data: null }
      : undefined
  ));
  const itemRecord = createCaptureRecord("save", "Save changes");
  itemRecord.origin = ORIGIN;
  itemRecord.pageUrl = `${ORIGIN}/settings`;
  itemRecord.tabId = WIDGET_TAB_ID;
  itemRecord.frameId = 0;
  const store = createStoreHarness();
  store.read = vi.fn(async () => ({ ok: true, value: createSessionReadback(itemRecord) }));
  store.updateIntent = vi.fn(async () => ({
    ok: true,
    value: createSessionReadback(itemRecord),
  }));
  await chrome.storage.local.set({
    [OVERLAY_PROJECTION_AUTHORITY_GENERATION_KEY]: 1,
  });
  await chrome.storage.session.set({
    [OVERLAY_PROJECTIONS_SESSION_KEY]: {
      generation: 1,
      records: [{
        projection: WIDGET_OVERLAY_PROJECTION_DESCRIPTOR,
        itemIds: ["att_save", "att_cancel"],
        activeItemId: null,
        delivery: "acknowledged",
        updatedAt: 1,
      }],
    },
  });
  const ensureContentScript = vi.fn(async () => true);
  const controller = createBackgroundController({
    chrome,
    store,
    ensureContentScript,
    ...(options.captureCommitGate ? { captureCommitGate: options.captureCommitGate } : {}),
    ...(options.annotationLifecycleExecutionGate
      ? { annotationLifecycleExecutionGate: options.annotationLifecycleExecutionGate }
      : {}),
    ...(options.localAgentBridge
      ? { runtimeFeatures: [createLocalAgentBridgeRuntimeFeature(options.localAgentBridge)] }
      : {}),
    ...(options.onActiveSessionChanged
      ? {
          onActiveSessionChanged: async (data: ActiveSessionCommandData) => {
            return fixtureReady ? await options.onActiveSessionChanged?.(data) : undefined;
          },
        }
      : {}),
  });

  expect(await controller.showInPageWidget(WIDGET_TAB_ID)).toBe(true);
  const liveProjection = await restoreAndAcknowledgeProjection(
    controller,
    createInPageWidgetContentSender(),
  );
  Object.assign(WIDGET_OVERLAY_PROJECTION, liveProjection);
  fixtureReady = true;
  const init = vi.mocked(chrome.tabs.sendMessage).mock.calls
    .map((call) => parseInPageWidgetInitMessage(call[1]))
    .find((message): message is InPageWidgetInitMessage => message !== null);
  if (!init) throw new Error("in-page widget init was not sent");
  const widgetSender: UiAttachChromeMessageSender = {
    id: WIDGET_RUNTIME_ID,
    origin: `chrome-extension://${WIDGET_RUNTIME_ID}`,
    url: WIDGET_URL,
    frameId: WIDGET_FRAME_ID,
    documentId: WIDGET_DOCUMENT_ID,
    tab: {
      id: WIDGET_TAB_ID,
      url: `${ORIGIN}/settings`,
      windowId: WIDGET_WINDOW_ID,
    },
  };
  return {
    chrome,
    controller,
    ensureContentScript,
    frameState,
    init,
    itemId: itemRecord.attachment.id,
    store,
    widgetSender,
  };
}

function createInPageWidgetRegistration(init: InPageWidgetInitMessage) {
  return {
    type: UI_ATTACH_IN_PAGE_WIDGET_REGISTER,
    surfaceId: init.surfaceId,
    capability: init.capability,
  } as const;
}

function createInPageWidgetCommandEnvelope(init: InPageWidgetInitMessage, command: object) {
  return {
    type: UI_ATTACH_IN_PAGE_WIDGET_COMMAND,
    surfaceId: init.surfaceId,
    capability: init.capability,
    command,
  } as const;
}

function createInPageWidgetContentSender(): UiAttachChromeMessageSender {
  return {
    id: WIDGET_RUNTIME_ID,
    url: `${ORIGIN}/settings`,
    frameId: 0,
    documentId: WIDGET_TOP_DOCUMENT_ID,
    tab: {
      id: WIDGET_TAB_ID,
      url: `${ORIGIN}/settings`,
      windowId: WIDGET_WINDOW_ID,
    },
  };
}

async function connectInPageWidgetLifecycle(fixture: InPageWidgetTestFixture) {
  const lifecycle = await connectInPageWidgetLifecycleRaw(fixture);
  vi.mocked(lifecycle.port.postMessage).mockClear();
  return lifecycle;
}

async function connectInPageWidgetLifecycleRaw(fixture: InPageWidgetTestFixture) {
  fixture.controller.register();
  const connectListener = vi.mocked(fixture.chrome.runtime.onConnect.addListener).mock.calls[0]?.[0] as
    | ((port: UiAttachChromePort) => void)
    | undefined;
  if (!connectListener) throw new Error("runtime connect listener was not registered");
  const disconnectEvent = createEventHarness<() => void>();
  const messageEvent = createEventHarness<(message: unknown) => void>();
  const port = {
    name: createInPageWidgetLifecyclePortName(
      fixture.init.surfaceId,
      fixture.init.capability,
    ),
    sender: fixture.widgetSender,
    disconnect: vi.fn(),
    postMessage: vi.fn(),
    onDisconnect: disconnectEvent,
    onMessage: messageEvent,
  } satisfies UiAttachChromePort;
  connectListener(port);
  await waitFor(() => vi.mocked(port.postMessage).mock.calls.some(([message]) => (
    isRecord(message) && message.type === UI_ATTACH_IN_PAGE_WIDGET_READY &&
    message.surfaceId === fixture.init.surfaceId
  )));
  return { disconnectEvent, messageEvent, port };
}

function readPostedWidgetActions(port: UiAttachChromePort) {
  return vi.mocked(port.postMessage!).mock.calls
    .map(([message]) => parseInPageWidgetActionMessage(message))
    .filter((message) => message !== null);
}

async function waitForPostedWidgetActionCount(
  port: UiAttachChromePort,
  expected: number,
): Promise<void> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    if (readPostedWidgetActions(port).length === expected) return;
    await flushAsyncWork();
  }
  throw new Error(`expected ${expected} posted widget actions`);
}

function createLocalAgentBridgeHarness(): LocalAgentBridgeClient {
  const pendingStatus = {
    connected: false,
    instanceId: null,
    pending: true,
    approvalMode: "browser_session" as const,
    requestText: "bounded request",
    expiresAt: "2026-07-18T01:27:43.939Z",
    sharedTargetCount: null,
    sharedSequence: null,
  };
  return {
    readStatus: vi.fn(async () => pendingStatus),
    createConnectionRequest: vi.fn(async () => pendingStatus),
    refreshConnection: vi.fn(async () => pendingStatus),
    refreshConnectionAndHeartbeat: vi.fn(async () => pendingStatus),
    publish: vi.fn(async () => true),
    disconnect: vi.fn(async () => undefined),
  };
}

function createStoreHarness(): ExtensionSessionStore & { calls: string[] } {
  const calls: string[] = [];
  const clearOperations = new Map<string, CaptureClearOperationV1>();
  let clearGeneration = 0;
  const store: ExtensionSessionStore & { calls: string[] } = {
    calls,
    list: vi.fn(async () => {
      calls.push("list");
      return { ok: true, value: [] };
    }),
    listClearOperations: vi.fn(async () => ({
      ok: true,
      value: [...clearOperations.values()].map((operation) => structuredClone(operation)),
    })),
    finalizeClearOperation: vi.fn(async (reference) => {
      const operation = clearOperations.get(reference.operationId);
      if (!operation) {
        return { ok: false, code: "ITEM_NOT_FOUND", error: "missing" };
      }
      if (operation.authorityId !== reference.authorityId ||
          operation.generation !== reference.generation) {
        return { ok: false, code: "STALE_SESSION", error: "stale" };
      }
      clearOperations.delete(reference.operationId);
      return { ok: true, value: structuredClone(operation) };
    }),
    clearAll: vi.fn(async () => {
      calls.push("clearAll");
      return { ok: true, value: { clearedOrigins: [] } };
    }),
    read: vi.fn(async (origin: string) => {
      calls.push(`read:${origin}`);
      return { ok: true, value: createReadback(createCaptureRecord("save", "Save changes"), origin) };
    }),
    inspectCapture: vi.fn(async (origin: string) => {
      calls.push(`inspect:${origin}`);
      const read = await store.read(origin);
      return read.ok
        ? { ok: true, value: { readback: read.value, receiptItemId: null } }
        : read;
    }),
    beginCapture: vi.fn(async (origin: string, replaceItemId: string | null = null) => {
      calls.push(`begin:${origin}`);
      const readback = createSessionReadback(createCaptureRecord("save", "Save changes"));
      const replacementItem = replaceItemId === null
        ? null
        : readback.file?.session.attachments.find((item) => item.id === replaceItemId) ?? null;
      if (replaceItemId !== null && replacementItem === null) {
        return { ok: false as const, code: "ITEM_NOT_FOUND" as const, error: "missing" };
      }
      return {
        ok: true as const,
        value: {
          ...TOKEN,
          origin,
          replacement: replacementItem === null
            ? null
            : {
                itemId: replacementItem.id,
                createdAt: replacementItem.createdAt,
                capturedAt: replacementItem.sourceRecord.capturedAt,
              },
        },
      };
    }),
    commitCapture: vi.fn(async (token: CaptureToken, record: OriginCaptureRecord) => {
      calls.push(`commit:${token.operationId}:${record.origin}`);
      return {
        ok: true,
        value: { itemId: record.attachment.id, label: "A", readback: createReadback(record) },
      };
    }),
    updateIntent: vi.fn(async (origin, epoch, itemId, intent) => {
      calls.push(`update:${origin}:${epoch}:${itemId}:${intent}`);
      return { ok: true, value: createReadback(createCaptureRecord("save", "Save changes"), origin) };
    }),
    updateAnnotationLifecycle: vi.fn(async (
      origin,
      epoch,
      itemId,
      annotationId,
      expectedState,
      nextState,
    ) => {
      calls.push(
        `lifecycle:${origin}:${epoch}:${itemId}:${annotationId}:${expectedState}:${nextState}`,
      );
      return { ok: true, value: createReadback(createCaptureRecord("save", "Save changes"), origin) };
    }),
    applyAnnotationLifecycleOperation: vi.fn(async (input) => ({
      ok: true,
      value: {
        readback: createSessionReadback(createCaptureRecord("save", "Save changes")),
        receipt: {
          schemaVersion: "0.1.0",
          kind: "ui-attach.annotation-lifecycle-operation-ledger-receipt",
          operationId: input.operationId,
          requestHash: input.requestHash,
          epoch: input.epoch,
          itemId: input.itemId,
          annotationId: input.annotationId,
          previousState: input.expectedState,
          nextState: input.nextState,
          appliedAt: "2026-09-01T00:00:01.000Z",
        },
      },
    })),
    removeItem: vi.fn(async (origin, epoch, itemId) => {
      calls.push(`remove:${origin}:${epoch}:${itemId}`);
      return { ok: true, value: createReadback(createCaptureRecord("save", "Save changes"), origin) };
    }),
    clear: vi.fn(async (origin, epoch, operationId) => {
      calls.push(`clear:${origin}:${epoch}:${operationId}`);
      return { ok: true, value: createReadback(createCaptureRecord("save", "Save changes"), origin) };
    }),
    clearOrigins: vi.fn(async (request) => {
      calls.push(`clearOrigins:${request.operationId}`);
      clearGeneration += 1;
      const operation: CaptureClearOperationV1 = {
        version: 1,
        operationId: request.operationId,
        authorityId: "clear-authority-1",
        generation: clearGeneration,
        phase: "canonical_committed",
        origins: request.origins.map((entry) => ({
          origin: entry.origin,
          beforeEpoch: entry.epoch,
          afterEpoch: `cleared-${entry.origin}`,
          canonical: "committed" as const,
        })).sort((left, right) => left.origin < right.origin ? -1 : 1),
        createdAt: "2026-08-18T00:00:00.000Z",
        updatedAt: "2026-08-18T00:00:00.000Z",
      };
      clearOperations.set(operation.operationId, operation);
      return { ok: true, value: structuredClone(operation) };
    }),
  };
  return store;
}

interface TopFrameRuntimeCaptureRoute {
  tabId: number;
  documentId: string;
  url: string;
}

function configureTopFrameRuntimeCaptureRoute(
  chrome: ReturnType<typeof createChromeHarness>,
  initialUrl: string,
): TopFrameRuntimeCaptureRoute {
  const route = {
    tabId: 7,
    documentId: "runtime-capture-document-01234567",
    url: initialUrl,
  };
  chrome.tabs.query = vi.fn(async () => [{
    id: route.tabId,
    url: route.url,
    windowId: 1,
  }]);
  chrome.tabs.sendMessage = vi.fn(async () => undefined);
  chrome.webNavigation.getAllFrames = vi.fn(async ({ tabId }) => tabId === route.tabId
    ? [{
        frameId: 0,
        parentFrameId: -1,
        documentId: route.documentId,
        url: route.url,
      }]
    : []);
  chrome.webNavigation.getFrame = vi.fn(async ({ tabId, frameId, documentId }) => (
    tabId === route.tabId && (frameId ?? 0) === 0 &&
      (documentId === undefined || documentId === route.documentId)
      ? {
          frameId: 0,
          parentFrameId: -1,
          documentId: route.documentId,
          url: route.url,
        }
      : undefined
  ));
  return route;
}

async function activateTopFrameRuntimeCaptureRoute(
  controller: ReturnType<typeof createBackgroundController>,
  route: TopFrameRuntimeCaptureRoute,
): Promise<void> {
  const url = new URL(route.url);
  await expect(dispatchRuntime(controller, {
    type: "ui-attach:frame-scope-select",
    tabId: route.tabId,
    frameId: 0,
    documentId: route.documentId,
    origin: url.origin,
    pathname: url.pathname,
    startSelection: true,
  }, createExtensionSender())).resolves.toEqual({
    ok: true,
    data: { enabled: true },
  });
}

function createTopFrameRuntimeCaptureSender(
  route: TopFrameRuntimeCaptureRoute,
): UiAttachChromeMessageSender {
  return {
    ...createSender(route.url, route.tabId),
    documentId: route.documentId,
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

function clearProjectionAlarmListener(
  chrome: ReturnType<typeof createChromeHarness>,
): ((alarm: { name: string }) => void) | undefined {
  return vi.mocked(chrome.alarms.onAlarm.addListener).mock.calls[0]?.[0] as
    | ((alarm: { name: string }) => void)
    | undefined;
}

async function dispatchRuntime(
  controller: ReturnType<typeof createBackgroundController>,
  command: SessionCommand | unknown,
  sender: UiAttachChromeMessageSender,
): Promise<SessionCommandResponse<unknown>> {
  const response = await controller.handleRuntimeMessage(command, sender);
  return response as SessionCommandResponse<unknown>;
}

function configureSingleClearPage(
  chrome: ReturnType<typeof createChromeHarness>,
  documentId = "clear-document",
  pathname = "/settings",
): void {
  const url = `${ORIGIN}${pathname}`;
  chrome.tabs.query = vi.fn(async () => [{ id: 7, url, windowId: 1 }]);
  chrome.webNavigation.getAllFrames = vi.fn(async () => [{
    frameId: 0,
    parentFrameId: -1,
    documentId,
    url,
  }]);
  chrome.webNavigation.getFrame = vi.fn(async ({ tabId, frameId, documentId: requested }) =>
    tabId === 7 && (frameId ?? 0) === 0 && (!requested || requested === documentId)
      ? { parentFrameId: -1, documentId, url }
      : undefined);
}

function createExactClearSender(
  chrome: ReturnType<typeof createChromeHarness>,
  documentId = "clear-document",
  pathname = "/settings",
): UiAttachChromeMessageSender {
  const url = `${ORIGIN}${pathname}`;
  return {
    id: chrome.runtime.id,
    url,
    frameId: 0,
    documentId,
    tab: { id: 7, url, windowId: 1 },
  };
}

function exactZeroClearAck(clear: unknown) {
  return {
    type: UI_ATTACH_CLEAR_PROJECTION_ACK,
    clear,
    readback: {
      appliedItemIds: [],
      markerCount: 0,
      selectionPreviewActive: false,
      digest: UI_ATTACH_EMPTY_APPLIED_ITEM_IDS_DIGEST,
    },
  };
}

function clearProjectionJournal(operation: ClearProjectionOperation) {
  return { version: 1 as const, operations: [operation] };
}

function boundClearProjectionOperation(
  operationId: string,
  documentId: string,
): ClearProjectionOperation {
  return {
    version: 1,
    operationId,
    authority: {
      authorityId: `authority-${operationId}`,
      operationId,
      generation: 1,
    },
    request: {
      nonce: `request-${operationId}`,
      endpoint: {
        tabId: 7,
        frameId: 0,
        documentId,
        origin: ORIGIN,
        pathname: "/settings",
      },
      origins: [{ origin: ORIGIN, beforeEpoch: "epoch-1" }],
    },
    requestedOrigins: [ORIGIN],
    origins: [{ origin: ORIGIN, originAfterEpoch: `after-${operationId}` }],
    subjectDiscovery: "complete",
    targets: [{
      subject: {
        tabId: 7,
        frameId: 0,
        documentId,
        origin: ORIGIN,
        pathname: "/settings",
      },
      removedItemIds: ["att_save"],
      projectionId: `projection-${operationId}`,
      revision: 1,
      state: "delivered",
      attemptCount: 1,
      nextAttemptAt: Number.MAX_SAFE_INTEGER,
    }],
  };
}

async function restoreAndAcknowledgeProjection(
  controller: ReturnType<typeof createBackgroundController>,
  sender: UiAttachChromeMessageSender,
) {
  const restored = await dispatchRuntime(controller, {
    type: "ui-attach:overlays-restore-get",
  }, sender);
  if (!isOverlayRestoreResponse(restored)) {
    throw new Error("overlay projection restore failed");
  }
  const projection = {
    version: restored.data.projection.version,
    projectionId: restored.data.projection.projectionId,
    revision: restored.data.projection.revision,
  };
  await expect(dispatchRuntime(controller, {
    type: UI_ATTACH_OVERLAY_PROJECTION_ACK,
    projection,
  }, sender)).resolves.toEqual({ ok: true, data: { accepted: true } });
  return projection;
}

async function createNestedOverlayAuthorityFixture() {
  const fixture = await createInPageWidgetFixture();
  const childFrameId = 5;
  const childDocumentId = "nested-authority-child-document";
  const childRecord = createCaptureRecord("save", "Save changes");
  childRecord.origin = OTHER_ORIGIN;
  childRecord.pageUrl = `${OTHER_ORIGIN}/editor`;
  childRecord.attachment.source.url = childRecord.pageUrl;
  childRecord.tabId = WIDGET_TAB_ID;
  childRecord.frameId = 3;
  childRecord.routeChain = [
    { origin: ORIGIN, pathname: "/settings" },
    { origin: OTHER_ORIGIN, pathname: "/editor" },
  ];
  const childReadback = createSessionReadback(childRecord, OTHER_ORIGIN);
  const emptyTopReadback: ActiveSessionReadback = {
    origin: ORIGIN,
    epoch: null,
    clearPending: false,
    activeClearOperationId: null,
    file: null,
    legacyRecord: null,
  };
  fixture.store.read = vi.fn(async (origin) => ({
    ok: true,
    value: origin === OTHER_ORIGIN ? childReadback : emptyTopReadback,
  }));
  let topPathname = "/settings";
  const liveFrames = () => [{
    frameId: 0,
    parentFrameId: -1,
    documentId: WIDGET_TOP_DOCUMENT_ID,
    url: `${ORIGIN}${topPathname}`,
  }, {
    frameId: childFrameId,
    parentFrameId: 0,
    documentId: childDocumentId,
    url: `${OTHER_ORIGIN}/editor`,
  }];
  fixture.chrome.webNavigation.getAllFrames = vi.fn(async ({ tabId }) =>
    tabId === WIDGET_TAB_ID ? liveFrames() : []);
  const originalGetFrame = fixture.chrome.webNavigation.getFrame;
  fixture.chrome.webNavigation.getFrame = vi.fn(async (details) => {
    if (details.tabId !== WIDGET_TAB_ID) return originalGetFrame(details);
    if (details.frameId === 0) return liveFrames()[0];
    if (details.frameId === childFrameId) return liveFrames()[1];
    return originalGetFrame(details);
  });
  await expect(dispatchRuntime(
    fixture.controller,
    createInPageWidgetCommandEnvelope(fixture.init, {
      type: "ui-attach:widget-frame-scope-select",
      frameId: childFrameId,
      documentId: childDocumentId,
      origin: OTHER_ORIGIN,
      pathname: "/editor",
      expectedGeneration: 0,
    }),
    fixture.widgetSender,
  )).resolves.toEqual({ ok: true, data: { enabled: false } });
  await expect(dispatchRuntime(
    fixture.controller,
    createInPageWidgetCommandEnvelope(fixture.init, { type: "ui-attach:widget-session-read" }),
    fixture.widgetSender,
  )).resolves.toMatchObject({
    ok: true,
    data: { activePage: { frameId: childFrameId, documentId: childDocumentId } },
  });
  const sender: UiAttachChromeMessageSender = {
    id: WIDGET_RUNTIME_ID,
    origin: OTHER_ORIGIN,
    url: `${OTHER_ORIGIN}/editor`,
    frameId: childFrameId,
    documentId: childDocumentId,
    tab: {
      id: WIDGET_TAB_ID,
      url: `${ORIGIN}/settings`,
      windowId: WIDGET_WINDOW_ID,
    },
  };
  const projection = await restoreAndAcknowledgeProjection(fixture.controller, sender);
  const projectionRegistry = await fixture.chrome.storage.session.get(
    OVERLAY_PROJECTIONS_SESSION_KEY,
  );
  expect(projectionRegistry).toEqual(expect.objectContaining({
    [OVERLAY_PROJECTIONS_SESSION_KEY]: expect.objectContaining({
      records: expect.arrayContaining([expect.objectContaining({
        delivery: "acknowledged",
        itemIds: [childRecord.attachment.id],
        projection: expect.objectContaining({
          projectionId: projection.projectionId,
          subject: expect.objectContaining({
            tabId: WIDGET_TAB_ID,
            frameId: childFrameId,
            documentId: childDocumentId,
            origin: OTHER_ORIGIN,
            pathname: "/editor",
          }),
        }),
      })]),
    }),
  }));
  return {
    childReadback,
    childRecord,
    fixture,
    projection,
    sender,
    setTopPathname(pathname: string) {
      topPathname = pathname;
    },
  };
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
