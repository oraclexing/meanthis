// @vitest-environment jsdom

import { afterEach, describe, expect, test, vi } from "vitest";
import type { PersistentOverlayControllerOptions } from "@meanthis/web-picker";
import { CAPTURE_COMPARISON_FIELDS } from "./capture-comparison";
import {
  OVERLAY_ACTION_ITEM_ID_MAX_LENGTH,
  UI_ATTACH_CAPTURE_OBSERVATION_GET,
  UI_ATTACH_CLEAR_PROJECTION,
  UI_ATTACH_CLEAR_PROJECTION_ACK,
  UI_ATTACH_CONTENT_PROTOCOL_VERSION,
  UI_ATTACH_EMPTY_APPLIED_ITEM_IDS_DIGEST,
  UI_ATTACH_OVERLAY_ACTION_REQUEST,
  UI_ATTACH_OVERLAY_PROJECTION_ACK,
  UI_ATTACH_OVERLAY_STATE,
  UI_ATTACH_OVERLAY_SCOPE_VISIBILITY_UPDATED,
  UI_ATTACH_OVERLAY_VISIBILITY_UPDATED,
  isClearProjectionAckMessage,
  isClearProjectionTombstoneMessage,
  isCaptureObservationGetMessage,
  isCaptureObservationResponse,
  isContentReadyGetMessage,
  isOverlayActionRequestMessage,
  isOverlayProjectionAckMessage,
  isOverlayScopeVisibilityUpdatedMessage,
  isOverlayRestoreResponse,
  isOverlayStateMessage,
  isOverlayVisibilityUpdatedMessage,
} from "./messages";

const projection = {
  version: 1 as const,
  projectionId: "2f55d1c2-6d30-4b39-a13f-8a93658148ee",
  revision: 1,
};

const projectionDescriptor = {
  ...projection,
  sessionEpoch: "epoch-1",
  subject: {
    tabId: 7,
    frameId: 0,
    documentId: "document-current-01234567",
    origin: "https://app.example.test",
    pathname: "/settings",
  },
};

const clearReference = {
  version: 1 as const,
  authorityId: "clear-authority-1",
  operationId: "clear-operation-1",
  generation: 2,
  origin: projectionDescriptor.subject.origin,
  afterEpoch: "epoch-after-clear",
  subject: projectionDescriptor.subject,
  projectionId: "clear-projection-1",
  revision: 1,
};

const validCaptureObservation = {
  capturedAt: "2026-09-05T00:00:00.000Z",
  fields: {},
  unavailableFields: [...CAPTURE_COMPARISON_FIELDS],
};

describe("capture observation protocol", () => {
  test("requires exact bounded request keys and canonical page scope", () => {
    const request = {
      type: UI_ATTACH_CAPTURE_OBSERVATION_GET,
      origin: "https://app.example.test",
      pathname: "/settings",
      itemId: "item-1",
      attachmentId: "attachment-1",
    };
    expect(isCaptureObservationGetMessage(request)).toBe(true);
    expect(isCaptureObservationGetMessage({ ...request, extra: true })).toBe(false);
    expect(isCaptureObservationGetMessage({ ...request, itemId: "i".repeat(257) })).toBe(false);
    expect(isCaptureObservationGetMessage({ ...request, attachmentId: "a".repeat(257) })).toBe(false);
    expect(isCaptureObservationGetMessage({ ...request, pathname: "/settings?tab=1" })).toBe(false);
    expect(isCaptureObservationGetMessage(Object.create(request))).toBe(false);
  });

  test("requires an observation only for observed responses", () => {
    const base = {
      itemId: "item-1",
      attachmentId: "attachment-1",
      origin: "https://app.example.test",
      pathname: "/settings",
    };
    expect(isCaptureObservationResponse({
      ok: true,
      data: { ...base, status: "observed", observation: validCaptureObservation },
    })).toBe(true);
    for (const status of ["checking", "missing", "ambiguous", "stale", "unavailable"] as const) {
      expect(isCaptureObservationResponse({
        ok: true,
        data: { ...base, status, observation: null },
      })).toBe(true);
      expect(isCaptureObservationResponse({
        ok: true,
        data: { ...base, status, observation: validCaptureObservation },
      })).toBe(false);
    }
    expect(isCaptureObservationResponse({
      ok: true,
      data: { ...base, status: "observed", observation: null },
    })).toBe(false);
    expect(isCaptureObservationResponse({
      ok: true,
      data: { ...base, status: "observed", observation: validCaptureObservation, extra: true },
    })).toBe(false);
  });
});

describe("clear projection protocol", () => {
  test("accepts only an exact bounded tombstone and canonical zero-marker ACK", () => {
    expect(isClearProjectionTombstoneMessage({
      type: UI_ATTACH_CLEAR_PROJECTION,
      clear: clearReference,
    })).toBe(true);
    expect(isClearProjectionAckMessage({
      type: UI_ATTACH_CLEAR_PROJECTION_ACK,
      clear: clearReference,
      readback: {
        appliedItemIds: [],
        markerCount: 0,
        selectionPreviewActive: false,
        digest: UI_ATTACH_EMPTY_APPLIED_ITEM_IDS_DIGEST,
      },
    })).toBe(true);
  });

  test.each([
    ["extra tombstone claim", {
      type: UI_ATTACH_CLEAR_PROJECTION,
      clear: clearReference,
      removedItemIds: ["caller-claimed"],
    }],
    ["wrong origin", {
      type: UI_ATTACH_CLEAR_PROJECTION,
      clear: { ...clearReference, origin: "https://other.example.test" },
    }],
    ["unsafe generation", {
      type: UI_ATTACH_CLEAR_PROJECTION,
      clear: { ...clearReference, generation: Number.MAX_SAFE_INTEGER + 1 },
    }],
    ["oversized document", {
      type: UI_ATTACH_CLEAR_PROJECTION,
      clear: {
        ...clearReference,
        subject: { ...clearReference.subject, documentId: "d".repeat(257) },
      },
    }],
    ["untrimmed authority", {
      type: UI_ATTACH_CLEAR_PROJECTION,
      clear: { ...clearReference, authorityId: " authority-1" },
    }],
    ["untrimmed document", {
      type: UI_ATTACH_CLEAR_PROJECTION,
      clear: {
        ...clearReference,
        subject: { ...clearReference.subject, documentId: "document-1 " },
      },
    }],
  ])("rejects %s", (_label, message) => {
    expect(isClearProjectionTombstoneMessage(message)).toBe(false);
  });

  test.each([
    ["nonzero marker", { markerCount: 1 }],
    ["active preview", { selectionPreviewActive: true }],
    ["claimed applied id", { appliedItemIds: ["item-a"] }],
    ["wrong digest", { digest: "0".repeat(64) }],
  ])("rejects a zero-marker ACK with %s", (_label, override) => {
    expect(isClearProjectionAckMessage({
      type: UI_ATTACH_CLEAR_PROJECTION_ACK,
      clear: clearReference,
      readback: {
        appliedItemIds: [],
        markerCount: 0,
        selectionPreviewActive: false,
        digest: UI_ATTACH_EMPTY_APPLIED_ITEM_IDS_DIGEST,
        ...override,
      },
    })).toBe(false);
  });

  test("requires own exact keys for content ready and every clear protocol layer", () => {
    const inheritedReady = Object.create({
      type: "ui-attach:content-ready-get",
      protocolVersion: UI_ATTACH_CONTENT_PROTOCOL_VERSION,
    });
    const inheritedReference = Object.create(clearReference);
    const inheritedSubject = Object.create(clearReference.subject);
    const inheritedReadback = Object.create({
      appliedItemIds: [],
      markerCount: 0,
      selectionPreviewActive: false,
      digest: UI_ATTACH_EMPTY_APPLIED_ITEM_IDS_DIGEST,
    });

    expect(isContentReadyGetMessage(inheritedReady)).toBe(false);
    expect(isClearProjectionTombstoneMessage(Object.create({
      type: UI_ATTACH_CLEAR_PROJECTION,
      clear: clearReference,
    }))).toBe(false);
    expect(isClearProjectionTombstoneMessage({
      type: UI_ATTACH_CLEAR_PROJECTION,
      clear: inheritedReference,
    })).toBe(false);
    expect(isClearProjectionTombstoneMessage({
      type: UI_ATTACH_CLEAR_PROJECTION,
      clear: { ...clearReference, subject: inheritedSubject },
    })).toBe(false);
    expect(isClearProjectionAckMessage(Object.create({
      type: UI_ATTACH_CLEAR_PROJECTION_ACK,
      clear: clearReference,
      readback: inheritedReadback,
    }))).toBe(false);
    expect(isClearProjectionAckMessage({
      type: UI_ATTACH_CLEAR_PROJECTION_ACK,
      clear: clearReference,
      readback: inheritedReadback,
    })).toBe(false);
    expect(isClearProjectionTombstoneMessage({
      type: UI_ATTACH_CLEAR_PROJECTION,
      clear: { ...clearReference, authorityId: "a".repeat(129) },
    })).toBe(false);
    expect(isClearProjectionAckMessage({
      type: UI_ATTACH_CLEAR_PROJECTION_ACK,
      clear: clearReference,
      readback: {
        appliedItemIds: ["caller-claimed"],
        markerCount: 0,
        selectionPreviewActive: false,
        digest: UI_ATTACH_EMPTY_APPLIED_ITEM_IDS_DIGEST,
      },
    })).toBe(false);
  });
});

describe("overlay projection protocol", () => {
  test("requires an exact versioned projection on state, ACK, restore, and actions", () => {
    expect(isOverlayStateMessage({
      type: UI_ATTACH_OVERLAY_STATE,
      origin: projectionDescriptor.subject.origin,
      projection: projectionDescriptor,
      activeItemId: null,
      items: [],
    })).toBe(true);
    expect(isOverlayProjectionAckMessage({
      type: UI_ATTACH_OVERLAY_PROJECTION_ACK,
      projection,
    })).toBe(true);
    expect(isOverlayActionRequestMessage({
      type: UI_ATTACH_OVERLAY_ACTION_REQUEST,
      action: "more",
      itemId: "item-a",
      projection,
    })).toBe(true);
    expect(isOverlayRestoreResponse({
      ok: true,
      data: {
        origin: projectionDescriptor.subject.origin,
        projection: projectionDescriptor,
        activeItemId: null,
        items: [],
      },
    })).toBe(true);
  });

  test("rejects missing, stale-shaped, and mismatched projection identity", () => {
    expect(isOverlayStateMessage({
      type: UI_ATTACH_OVERLAY_STATE,
      origin: projectionDescriptor.subject.origin,
      activeItemId: null,
      items: [],
    })).toBe(false);
    expect(isOverlayProjectionAckMessage({
      type: UI_ATTACH_OVERLAY_PROJECTION_ACK,
      projection: { ...projection, revision: 0 },
    })).toBe(false);
    expect(isOverlayActionRequestMessage({
      type: UI_ATTACH_OVERLAY_ACTION_REQUEST,
      action: "more",
      itemId: "item-a",
    })).toBe(false);
    expect(isOverlayRestoreResponse({
      ok: true,
      data: {
        origin: "https://other.example.test",
        projection: projectionDescriptor,
        activeItemId: null,
        items: [],
      },
    })).toBe(false);
  });
});

describe("isOverlayActionRequestMessage", () => {
  test.each(["edit", "remove", "more"] as const)(
    "accepts an exact bounded %s request",
    (action) => {
      expect(isOverlayActionRequestMessage({
        type: UI_ATTACH_OVERLAY_ACTION_REQUEST,
        action,
        itemId: "item-a",
        projection,
      })).toBe(true);
    },
  );

  test("accepts an item id at the exact length limit", () => {
    expect(isOverlayActionRequestMessage({
      type: UI_ATTACH_OVERLAY_ACTION_REQUEST,
      action: "edit",
      itemId: "a".repeat(OVERLAY_ACTION_ITEM_ID_MAX_LENGTH),
      projection,
    })).toBe(true);
  });

  test("accepts only an exact bounded save request", () => {
    expect(isOverlayActionRequestMessage({
      type: UI_ATTACH_OVERLAY_ACTION_REQUEST,
      action: "save",
      itemId: "item-a",
      taskNote: "Update this control.",
      projection,
    })).toBe(true);
    expect(isOverlayActionRequestMessage({
      type: UI_ATTACH_OVERLAY_ACTION_REQUEST,
      action: "save",
      itemId: "item-a",
      taskNote: "x".repeat(16_385),
      projection,
    })).toBe(false);
    expect(isOverlayActionRequestMessage({
      type: UI_ATTACH_OVERLAY_ACTION_REQUEST,
      action: "edit",
      itemId: "item-a",
      taskNote: "must be rejected",
      projection,
    })).toBe(false);
  });

  test.each([
    ["empty item id", { type: UI_ATTACH_OVERLAY_ACTION_REQUEST, action: "edit", itemId: "" }],
    [
      "oversized item id",
      {
        type: UI_ATTACH_OVERLAY_ACTION_REQUEST,
        action: "edit",
        itemId: "a".repeat(OVERLAY_ACTION_ITEM_ID_MAX_LENGTH + 1),
      },
    ],
    [
      "C0 control character",
      { type: UI_ATTACH_OVERLAY_ACTION_REQUEST, action: "remove", itemId: "item\nsecret" },
    ],
    [
      "C1 control character",
      { type: UI_ATTACH_OVERLAY_ACTION_REQUEST, action: "more", itemId: "item\u0085secret" },
    ],
    ["unknown action", { type: UI_ATTACH_OVERLAY_ACTION_REQUEST, action: "copy", itemId: "item-a" }],
    [
      "extra field",
      {
        type: UI_ATTACH_OVERLAY_ACTION_REQUEST,
        action: "edit",
        itemId: "item-a",
        pageText: "must not cross the boundary",
      },
    ],
    ["missing item id", { type: UI_ATTACH_OVERLAY_ACTION_REQUEST, action: "edit" }],
  ])("rejects %s", (_label, message) => {
    expect(isOverlayActionRequestMessage(message)).toBe(false);
  });
});

describe("isOverlayVisibilityUpdatedMessage", () => {
  test("keeps the legacy visibility wire shape exact", () => {
    expect(isOverlayVisibilityUpdatedMessage({
      type: UI_ATTACH_OVERLAY_VISIBILITY_UPDATED,
      visible: true,
      displayMode: "markers",
    })).toBe(false);
    expect(isOverlayVisibilityUpdatedMessage({
      type: UI_ATTACH_OVERLAY_VISIBILITY_UPDATED,
      visible: true,
    })).toBe(true);
    expect(isOverlayVisibilityUpdatedMessage({
      type: UI_ATTACH_OVERLAY_VISIBILITY_UPDATED,
      visible: true,
      displayMode: "always",
    })).toBe(false);
  });
});

describe("isOverlayScopeVisibilityUpdatedMessage", () => {
  test("accepts only the exact per-frame visibility wire shape", () => {
    expect(isOverlayScopeVisibilityUpdatedMessage({
      type: UI_ATTACH_OVERLAY_SCOPE_VISIBILITY_UPDATED,
      visible: false,
    })).toBe(true);
    expect(isOverlayScopeVisibilityUpdatedMessage({
      type: UI_ATTACH_OVERLAY_SCOPE_VISIBILITY_UPDATED,
      visible: false,
      frameId: 3,
    })).toBe(false);
    expect(isOverlayScopeVisibilityUpdatedMessage({
      type: UI_ATTACH_OVERLAY_SCOPE_VISIBILITY_UPDATED,
      visible: 0,
    })).toBe(false);
  });
});

describe("overlay task-note state messages", () => {
  const stateItem = {
    itemId: "item-a",
    attachmentId: "att_a",
    label: "1",
    taskNote: "Update this control.",
  };

  test("requires an exact bounded task note in live state", () => {
    expect(isOverlayStateMessage({
      type: UI_ATTACH_OVERLAY_STATE,
      origin: "https://app.example.test",
      projection: projectionDescriptor,
      activeItemId: "item-a",
      items: [stateItem],
    })).toBe(true);
    const { taskNote: _missing, ...withoutTaskNote } = stateItem;
    expect(isOverlayStateMessage({
      type: UI_ATTACH_OVERLAY_STATE,
      origin: "https://app.example.test",
      projection: projectionDescriptor,
      activeItemId: "item-a",
      items: [withoutTaskNote],
    })).toBe(false);
    expect(isOverlayStateMessage({
      type: UI_ATTACH_OVERLAY_STATE,
      origin: "https://app.example.test",
      projection: projectionDescriptor,
      activeItemId: "item-a",
      items: [{ ...stateItem, taskNote: "x".repeat(16_385) }],
    })).toBe(false);
  });

  test("requires the same exact bounded task note in restore data", () => {
    const restoreItem = {
      ...stateItem,
      locators: [{
        strategy: "playwright.role" as const,
        value: 'page.getByRole("button", { name: "Save" })',
        confidence: 0.9,
      }],
    };
    expect(isOverlayRestoreResponse({
      ok: true,
      data: {
        origin: "https://app.example.test",
        projection: projectionDescriptor,
        activeItemId: "item-a",
        items: [restoreItem],
      },
    })).toBe(true);
    const { taskNote: _missing, ...withoutTaskNote } = restoreItem;
    expect(isOverlayRestoreResponse({
      ok: true,
      data: {
        origin: "https://app.example.test",
        projection: projectionDescriptor,
        activeItemId: "item-a",
        items: [withoutTaskNote],
      },
    })).toBe(false);
    expect(isOverlayRestoreResponse({
      ok: true,
      data: {
        origin: "https://app.example.test",
        projection: projectionDescriptor,
        activeItemId: "item-a",
        items: [{ ...restoreItem, taskNote: "x".repeat(16_385) }],
      },
    })).toBe(false);
  });

  test("rejects unbounded or ambiguous live-state item identities", () => {
    const validItems = [
      stateItem,
      {
        itemId: "item-b",
        attachmentId: stateItem.attachmentId,
        label: "2",
        taskNote: "A second annotation on the same DOM target.",
      },
    ];
    const state = {
      type: UI_ATTACH_OVERLAY_STATE,
      origin: "https://app.example.test",
      projection: projectionDescriptor,
      activeItemId: "item-b",
      items: validItems,
    };
    expect(isOverlayStateMessage(state)).toBe(true);
    expect(isOverlayStateMessage({
      ...state,
      items: Array.from({ length: 27 }, (_, index) => ({
        ...stateItem,
        itemId: `item-${index}`,
        label: String(index + 1),
      })),
    })).toBe(false);
    expect(isOverlayStateMessage({
      ...state,
      items: [stateItem, { ...stateItem, taskNote: "duplicate id" }],
    })).toBe(false);
    expect(isOverlayStateMessage({
      ...state,
      items: [stateItem, { ...validItems[1], label: "1" }],
    })).toBe(false);
    expect(isOverlayStateMessage({ ...state, activeItemId: "item-missing" })).toBe(false);
    for (const invalidLabel of ["", "0", "27", "A"]) {
      expect(isOverlayStateMessage({
        ...state,
        items: [{ ...stateItem, label: invalidLabel }],
        activeItemId: null,
      })).toBe(false);
    }
    for (const invalidItem of [
      { ...stateItem, itemId: `item\nsecret` },
      { ...stateItem, itemId: "x".repeat(OVERLAY_ACTION_ITEM_ID_MAX_LENGTH + 1) },
      { ...stateItem, attachmentId: `attachment\u0085secret` },
      { ...stateItem, attachmentId: "x".repeat(OVERLAY_ACTION_ITEM_ID_MAX_LENGTH + 1) },
    ]) {
      expect(isOverlayStateMessage({
        ...state,
        items: [invalidItem],
        activeItemId: null,
      })).toBe(false);
    }
  });

  test("applies the same identity and locator bounds to restore data", () => {
    const locator = {
      strategy: "playwright.text" as const,
      value: "page.getByText(\n  'Save changes',\n)",
      confidence: 0.9,
    };
    const restoreItem = { ...stateItem, locators: [locator] };
    const response = {
      ok: true,
      data: {
        origin: "https://app.example.test",
        projection: projectionDescriptor,
        activeItemId: "item-a",
        items: [restoreItem],
      },
    };
    expect(isOverlayRestoreResponse(response)).toBe(true);
    expect(isOverlayRestoreResponse({
      ...response,
      data: {
        ...response.data,
        items: [restoreItem, { ...restoreItem, taskNote: "duplicate id" }],
      },
    })).toBe(false);
    expect(isOverlayRestoreResponse({
      ...response,
      data: {
        ...response.data,
        items: [restoreItem, {
          ...restoreItem,
          itemId: "item-b",
          attachmentId: restoreItem.attachmentId,
          label: "1",
        }],
      },
    })).toBe(false);
    expect(isOverlayRestoreResponse({
      ...response,
      data: { ...response.data, activeItemId: "item-missing" },
    })).toBe(false);
    expect(isOverlayRestoreResponse({
      ...response,
      data: {
        ...response.data,
        items: [{
          ...restoreItem,
          locators: [{ ...locator, value: "x".repeat(16_385) }],
        }],
      },
    })).toBe(false);
  });
});

describe("content overlay action requests", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.doUnmock("@meanthis/web-picker");
    vi.resetModules();
    document.body.replaceChildren();
    document.querySelectorAll("[data-ui-attach-ignore]").forEach((element) => element.remove());
  });

  test("uses the shared anchored editor and keeps authoritative save failures open", async () => {
    vi.resetModules();
    let overlayOptions: PersistentOverlayControllerOptions | undefined;
    let createRealOverlayController:
      | typeof import("@meanthis/web-picker").createPersistentOverlayController
      | undefined;
    const overlayController = {
      sync: vi.fn(),
      refresh: vi.fn(),
      dispose: vi.fn(),
    };
    vi.doMock("@meanthis/web-picker", async (importOriginal) => {
      const actual = await importOriginal<typeof import("@meanthis/web-picker")>();
      createRealOverlayController = actual.createPersistentOverlayController;
      return {
        ...actual,
        createPersistentOverlayController: vi.fn((options: PersistentOverlayControllerOptions) => {
        overlayOptions = options;
        return overlayController;
        }),
      };
    });
    const runtimeListeners: Array<(
      message: unknown,
      sender: unknown,
      sendResponse: (response?: unknown) => void,
    ) => boolean | void> = [];
    const sentMessages: unknown[] = [];
    const sendMessage = vi.fn((message: unknown) => {
      sentMessages.push(message);
      if (isOverlayProjectionAckMessage(message)) {
        return Promise.resolve({ ok: true, data: { accepted: true } });
      }
      if (isOverlayActionRequestMessage(message) && message.action === "more") {
        return Promise.reject(new Error("background unavailable"));
      }
      if (isOverlayActionRequestMessage(message) && message.action === "save") {
        return message.itemId === "item-save" && message.taskNote === "Updated note"
          ? Promise.resolve({ ok: true, data: null })
          : Promise.reject(new Error("background unavailable"));
      }
      return Promise.resolve(undefined);
    });
    const getMessage = vi.fn((key: string) => ({
      edit: "编辑",
      remove_selected_element: "移除所选元素",
      annotation_details: "查看标注详情",
      open_annotation_actions: "打开标注操作",
      task_note_added: "有任务说明",
    })[key] ?? "");
    vi.stubGlobal("chrome", {
      i18n: { getMessage },
      runtime: {
        connect: vi.fn(),
        getURL: vi.fn((path: string) => `chrome-extension://test/${path}`),
        onMessage: {
          addListener: vi.fn((listener) => runtimeListeners.push(listener)),
        },
        sendMessage,
      },
    });
    document.body.innerHTML = '<button id="page-action">Private page text</button>';

    await import("./content");
    await flushAsyncWork();
    if (!overlayOptions) throw new Error("persistent overlay options missing");
    expect(overlayOptions.actionLabels).toEqual({
      edit: "编辑",
      remove: "移除所选元素",
      more: "查看标注详情",
      open: "打开标注操作",
      notePresent: "有任务说明",
    });
    expect(overlayOptions.onEdit).toBeUndefined();
    expect(overlayOptions.editor?.onSave).toEqual(expect.any(Function));
    const contentProjectionDescriptor = {
      ...projectionDescriptor,
      subject: {
        ...projectionDescriptor.subject,
        origin: window.location.origin,
        pathname: window.location.pathname,
      },
    };
    for (const listener of runtimeListeners) listener({
      type: UI_ATTACH_OVERLAY_STATE,
      origin: contentProjectionDescriptor.subject.origin,
      projection: contentProjectionDescriptor,
      activeItemId: null,
      items: [],
    }, {}, () => undefined);
    await flushAsyncWork();
    expect(sentMessages).toContainEqual({
      type: UI_ATTACH_OVERLAY_PROJECTION_ACK,
      projection,
    });
    sentMessages.length = 0;
    overlayController.sync.mockClear();

    overlayOptions.onEdit?.("item-edit");
    overlayOptions.onRemove?.("item-remove");
    overlayOptions.onMore?.("item-more");
    overlayOptions.onEdit?.("x".repeat(OVERLAY_ACTION_ITEM_ID_MAX_LENGTH + 1));
    overlayOptions.onRemove?.("item\u0000control");
    await expect(overlayOptions.editor?.onSave("item-save", "Updated note"))
      .resolves.toBeUndefined();
    await expect(overlayOptions.editor?.onSave("item-save-failed", "Rejected note"))
      .rejects.toThrow("ui-attach capture failed.");
    await flushAsyncWork();

    expect(sentMessages).toEqual([
      {
        type: UI_ATTACH_OVERLAY_ACTION_REQUEST,
        action: "remove",
        itemId: "item-remove",
        projection,
      },
      {
        type: UI_ATTACH_OVERLAY_ACTION_REQUEST,
        action: "more",
        itemId: "item-more",
        projection,
      },
      {
        type: UI_ATTACH_OVERLAY_ACTION_REQUEST,
        action: "save",
        itemId: "item-save",
        taskNote: "Updated note",
        projection,
      },
      {
        type: UI_ATTACH_OVERLAY_ACTION_REQUEST,
        action: "save",
        itemId: "item-save-failed",
        taskNote: "Rejected note",
        projection,
      },
    ]);
    expect(JSON.stringify(sentMessages)).not.toContain("Private page text");
    expect(overlayController.sync).not.toHaveBeenCalled();
    expect(document.querySelector("#page-action")?.textContent).toBe("Private page text");

    if (!createRealOverlayController) throw new Error("real persistent overlay factory missing");
    const target = document.querySelector<HTMLElement>("#page-action");
    if (!target) throw new Error("page target missing");
    target.getBoundingClientRect = () => ({
      x: 20,
      y: 30,
      width: 160,
      height: 40,
      top: 30,
      left: 20,
      right: 180,
      bottom: 70,
      toJSON: () => ({}),
    }) as DOMRect;
    const realOverlays = createRealOverlayController(overlayOptions);
    realOverlays.sync([{
      itemId: "item-save",
      label: "1",
      taskNote: "Old note",
      target,
    }], "item-save");
    const realShadow = Array.from(document.querySelectorAll<HTMLElement>(
      "[data-ui-attach-overlay-root]",
    )).at(-1)?.shadowRoot;
    realShadow?.querySelector<HTMLButtonElement>(".ui-attach-label")?.click();
    realShadow?.querySelector<HTMLButtonElement>("[data-action='edit']")?.click();
    let editor = realShadow?.querySelector<HTMLElement>("[data-ui-attach-anchored-editor]");
    expect(editor).not.toBeNull();
    const note = editor?.querySelector<HTMLTextAreaElement>("textarea");
    if (!note) throw new Error("shared anchored editor textarea missing");
    note.value = "Updated note";
    editor?.querySelector<HTMLButtonElement>("[data-action='save-note']")?.click();
    await vi.waitFor(() => {
      expect(realShadow?.querySelector("[data-ui-attach-anchored-editor]")).toBeNull();
    });

    expect(realOverlays.openEditor("item-save")).toBe(true);
    editor = realShadow?.querySelector<HTMLElement>("[data-ui-attach-anchored-editor]");
    expect(editor?.querySelector<HTMLTextAreaElement>("textarea")?.value).toBe("Updated note");
    const rejectedNote = editor?.querySelector<HTMLTextAreaElement>("textarea");
    if (!rejectedNote) throw new Error("reopened editor textarea missing");
    rejectedNote.value = "Rejected note";
    editor?.querySelector<HTMLButtonElement>("[data-action='save-note']")?.click();
    await vi.waitFor(() => {
      const rejectedEditor = realShadow?.querySelector<HTMLElement>(
        "[data-ui-attach-anchored-editor]",
      );
      expect(rejectedEditor).not.toBeNull();
      expect(rejectedEditor?.querySelector<HTMLTextAreaElement>("textarea")?.disabled).toBe(false);
    });
    realOverlays.closeEditor();
    expect(realOverlays.openEditor("item-save")).toBe(true);
    expect(realShadow?.querySelector<HTMLTextAreaElement>(
      "[data-ui-attach-anchored-editor] textarea",
    )?.value).toBe("Updated note");
    realOverlays.dispose();

    for (const listener of runtimeListeners) {
      listener({ type: "ui-attach:content-deactivate" }, {}, () => undefined);
    }
  });
});

async function flushAsyncWork(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}
