// @vitest-environment jsdom

import { afterEach, describe, expect, test, vi } from "vitest";
import {
  createPersistentOverlayController,
  type PersistentOverlayController,
  type PersistentOverlayControllerOptions,
} from "@meanthis/web-picker";
import { createContentOverlayCoordinator } from "./content-overlays";
import {
  UI_ATTACH_CLEAR_PROJECTION,
  UI_ATTACH_CLEAR_PROJECTION_ACK,
  UI_ATTACH_EMPTY_APPLIED_ITEM_IDS_DIGEST,
} from "./messages";

const TEST_PROJECTION = {
  version: 1 as const,
  projectionId: "7926a257-f9c1-4ca4-8d3a-e7f81c8c411d",
  revision: 1,
  sessionEpoch: "epoch-1",
  subject: {
    tabId: 7,
    frameId: 0,
    documentId: "content-overlay-document",
    origin: "https://app.example.test",
    pathname: "/settings",
  },
};

describe("createContentOverlayCoordinator", () => {
  test("keeps bindings while hidden and renders them when marker visibility is enabled", () => {
    const target = document.createElement("button");
    document.body.append(target);
    const overlays = createOverlayHarness();
    const coordinator = createContentOverlayCoordinator(overlays, { initiallyVisible: false });

    coordinator.commitTarget(target, {
      origin: "https://app.example.test",
      epoch: "epoch-1",
      itemId: "att_save",
      annotationLabel: "1",
    }, { xRatio: 0.25, yRatio: 0.75 });
    expect(coordinator.hasTarget(target)).toBe(true);
    expect(coordinator.resolveTarget(target)).toEqual({ kind: "exact", itemId: "att_save" });
    expect(overlays.sync).toHaveBeenLastCalledWith([], null);

    coordinator.setVisible(true);
    expect(overlays.sync).toHaveBeenLastCalledWith(
      [{
        itemId: "att_save",
        label: "1",
        taskNote: "",
        target,
        anchor: { xRatio: 0.25, yRatio: 0.75 },
      }],
      "att_save",
    );

    coordinator.setVisible(false);
    expect(overlays.sync).toHaveBeenLastCalledWith([], null);
    expect(coordinator.hasTarget(target)).toBe(true);
  });

  test("adds element selections immediately and applies exact cleanup state", () => {
    const target = document.createElement("button");
    document.body.append(target);
    const overlays = createOverlayHarness();
    const coordinator = createContentOverlayCoordinator(overlays);

    coordinator.commitTarget(target, {
      origin: "https://app.example.test",
      epoch: "epoch-1",
      itemId: "att_save",
      annotationLabel: "1",
    });
    expect(coordinator.hasTarget(target)).toBe(true);
    expect(overlays.sync).toHaveBeenLastCalledWith(
      [{ itemId: "att_save", label: "1", taskNote: "", target }],
      "att_save",
    );

    coordinator.applyState({
      type: "ui-attach:overlay-state",
      origin: "https://app.example.test",
      projection: TEST_PROJECTION,
      activeItemId: null,
      items: [],
    });
    expect(coordinator.hasTarget(target)).toBe(false);
    expect(coordinator.resolveTarget(target)).toEqual({ kind: "none" });
    expect(overlays.sync).toHaveBeenLastCalledWith([], null);
  });

  test("reads actual production markers and selection preview state independently", () => {
    const first = document.createElement("button");
    const second = document.createElement("button");
    const hovered = document.createElement("input");
    document.body.append(first, second, hovered);
    const overlays = createPersistentOverlayController({ root: document });
    const coordinator = createContentOverlayCoordinator(overlays);

    coordinator.bindRestored(
      { itemId: "item-b", attachmentId: "att-b", label: "B", taskNote: "" },
      first,
    );
    coordinator.bindRestored(
      { itemId: "item-a", attachmentId: "att-a", label: "A", taskNote: "" },
      second,
    );
    expect(coordinator.readStatus()).toEqual({
      appliedItemIds: ["item-a", "item-b"],
      markerCount: 2,
      selectionPreviewActive: false,
    });

    coordinator.applySelectionPreview(hovered);
    expect(coordinator.readStatus()).toEqual({
      appliedItemIds: ["item-a", "item-b", "ui-attach-selection-preview"],
      markerCount: 3,
      selectionPreviewActive: true,
    });
    const overlayHost = document.querySelector<HTMLElement>("[data-ui-attach-overlay-root]");
    overlayHost?.shadowRoot
      ?.querySelector("[data-item-id='ui-attach-selection-preview'] .ui-attach-marker-capsule")
      ?.remove();
    expect(coordinator.readStatus()).toEqual({
      appliedItemIds: ["item-a", "item-b"],
      markerCount: 2,
      selectionPreviewActive: true,
    });

    coordinator.applySelectionPreview(null);
    expect(coordinator.readStatus()).toEqual({
      appliedItemIds: ["item-a", "item-b"],
      markerCount: 2,
      selectionPreviewActive: false,
    });
    coordinator.applyState({
      type: "ui-attach:overlay-state",
      origin: "https://app.example.test",
      projection: TEST_PROJECTION,
      activeItemId: null,
      items: [],
    });
    expect(coordinator.readStatus()).toEqual({
      appliedItemIds: [],
      markerCount: 0,
      selectionPreviewActive: false,
    });

    overlays.dispose();
  });

  test("fails closed instead of normalizing an invalid shared status test double", () => {
    const overlays = createOverlayHarness();
    vi.mocked(overlays.readStatus).mockReturnValue({
      itemIds: ["item-b", "item-b"],
      markerCount: 7,
    });
    const coordinator = createContentOverlayCoordinator(overlays);

    expect(() => coordinator.readStatus()).toThrowError(
      "Persistent overlay readback violated the shared status contract.",
    );
  });

  test("keeps the authoritative receipt label when restore wins the commit race", () => {
    const target = document.createElement("button");
    document.body.append(target);
    const overlays = createOverlayHarness();
    const coordinator = createContentOverlayCoordinator(overlays);

    coordinator.bindRestored(
      {
        itemId: "annotation-1",
        attachmentId: "heading",
        label: "1",
        taskNote: "Restored note",
        anchor: { xRatio: 0.25, yRatio: 0.75 },
      },
      target,
    );
    coordinator.commitTarget(target, {
      origin: "https://app.example.test",
      epoch: "epoch-1",
      itemId: "annotation-1",
      annotationLabel: "1",
    }, { xRatio: 0.25, yRatio: 0.75 });

    expect(overlays.sync).toHaveBeenLastCalledWith(
      [{
        itemId: "annotation-1",
        label: "1",
        taskNote: "",
        target,
        anchor: { xRatio: 0.25, yRatio: 0.75 },
      }],
      "annotation-1",
    );
  });

  test("fails closed when one live element is bound to multiple session items", () => {
    const target = document.createElement("button");
    document.body.append(target);
    const coordinator = createContentOverlayCoordinator(createOverlayHarness());

    coordinator.bindRestored(
      { itemId: "att_save", attachmentId: "att_save", label: "A", taskNote: "" },
      target,
    );
    coordinator.bindRestored(
      { itemId: "att_cancel", attachmentId: "att_cancel", label: "B", taskNote: "" },
      target,
    );

    expect(coordinator.resolveTarget(target)).toEqual({ kind: "ambiguous" });
  });

  test("replaces a restored binding when the page rerenders the target", () => {
    const original = document.createElement("button");
    const replacement = document.createElement("button");
    document.body.append(original, replacement);
    const overlays = createOverlayHarness();
    const coordinator = createContentOverlayCoordinator(overlays);

    coordinator.applyState({
      type: "ui-attach:overlay-state",
      origin: "https://app.example.test",
      projection: TEST_PROJECTION,
      activeItemId: "att_save",
      items: [{ itemId: "att_save", attachmentId: "att_save", label: "A", taskNote: "Old note" }],
    });
    coordinator.bindRestored(
      { itemId: "att_save", attachmentId: "att_save", label: "A", taskNote: "Old note" },
      original,
    );
    coordinator.bindRestored(
      { itemId: "att_save", attachmentId: "att_save", label: "A", taskNote: "Updated note" },
      replacement,
    );

    expect(overlays.sync).toHaveBeenLastCalledWith(
      [{ itemId: "att_save", label: "A", taskNote: "Updated note", target: replacement }],
      "att_save",
    );
  });

  test("removes a stale binding while preserving active emphasis for a later rebind", () => {
    const target = document.createElement("button");
    const replacement = document.createElement("button");
    document.body.append(target, replacement);
    const overlays = createOverlayHarness();
    const coordinator = createContentOverlayCoordinator(overlays);
    coordinator.applyState({
      type: "ui-attach:overlay-state",
      origin: "https://app.example.test",
      projection: TEST_PROJECTION,
      activeItemId: "att_save",
      items: [{ itemId: "att_save", attachmentId: "att_save", label: "A", taskNote: "" }],
    });
    coordinator.bindRestored(
      { itemId: "att_save", attachmentId: "att_save", label: "A", taskNote: "" },
      target,
    );

    coordinator.unbindRestored("att_save");

    expect(coordinator.hasTarget(target)).toBe(false);
    expect(overlays.sync).toHaveBeenLastCalledWith([], "att_save");

    coordinator.bindRestored(
      { itemId: "att_save", attachmentId: "att_save", label: "A", taskNote: "" },
      replacement,
    );
    expect(overlays.sync).toHaveBeenLastCalledWith(
      [{ itemId: "att_save", label: "A", taskNote: "", target: replacement }],
      "att_save",
    );
  });

  test("previews another bound target without changing the persisted active target", () => {
    const save = document.createElement("button");
    const cancel = document.createElement("button");
    document.body.append(save, cancel);
    const overlays = createOverlayHarness();
    const coordinator = createContentOverlayCoordinator(overlays);

    coordinator.bindRestored(
      { itemId: "att_save", attachmentId: "att_save", label: "A", taskNote: "" },
      save,
    );
    coordinator.bindRestored(
      { itemId: "att_cancel", attachmentId: "att_cancel", label: "B", taskNote: "" },
      cancel,
    );
    coordinator.applyState({
      type: "ui-attach:overlay-state",
      origin: "https://app.example.test",
      projection: TEST_PROJECTION,
      activeItemId: "att_cancel",
      items: [
        { itemId: "att_save", attachmentId: "att_save", label: "A", taskNote: "" },
        { itemId: "att_cancel", attachmentId: "att_cancel", label: "B", taskNote: "" },
      ],
    });

    coordinator.applyPreview("att_save");
    expect(overlays.sync).toHaveBeenLastCalledWith([
      { itemId: "att_save", label: "A", taskNote: "", target: save },
      { itemId: "att_cancel", label: "B", taskNote: "", target: cancel },
    ], "att_cancel");
    expect(overlays.setTemporaryHighlight).toHaveBeenLastCalledWith("att_save");

    coordinator.applyPreview(null);
    expect(overlays.sync).toHaveBeenLastCalledWith([
      { itemId: "att_save", label: "A", taskNote: "", target: save },
      { itemId: "att_cancel", label: "B", taskNote: "", target: cancel },
    ], "att_cancel");
  });

  test("adds one translucent selection target before capture and restores persisted emphasis", () => {
    const saved = document.createElement("button");
    const hovered = document.createElement("input");
    document.body.append(saved, hovered);
    const overlays = createOverlayHarness();
    const coordinator = createContentOverlayCoordinator(overlays);

    coordinator.bindRestored(
      { itemId: "att_save", attachmentId: "att_save", label: "A", taskNote: "" },
      saved,
    );
    coordinator.applyState({
      type: "ui-attach:overlay-state",
      origin: "https://app.example.test",
      projection: TEST_PROJECTION,
      activeItemId: "att_save",
      items: [{ itemId: "att_save", attachmentId: "att_save", label: "A", taskNote: "" }],
    });

    coordinator.applySelectionPreview(hovered);
    expect(overlays.sync).toHaveBeenLastCalledWith([
      { itemId: "att_save", label: "A", taskNote: "", target: saved },
      {
        itemId: "ui-attach-selection-preview",
        label: "Select",
        interactive: false,
        target: hovered,
      },
    ], "att_save");
    expect(overlays.setTemporaryHighlight).toHaveBeenLastCalledWith("ui-attach-selection-preview");

    coordinator.applySelectionPreview(null);
    expect(overlays.sync).toHaveBeenLastCalledWith(
      [{ itemId: "att_save", label: "A", taskNote: "", target: saved }],
      "att_save",
    );
  });

  test("arms capture hover intent before syncing a committed preview target", () => {
    const target = document.createElement("button");
    document.body.append(target);
    const overlays = createOverlayHarness();
    const coordinator = createContentOverlayCoordinator(overlays);
    coordinator.applySelectionPreview(target);
    vi.mocked(overlays.sync).mockClear();

    coordinator.commitTarget(target, {
      origin: "https://app.example.test",
      epoch: "epoch-1",
      itemId: "annotation-1",
      annotationLabel: "1",
    }, { xRatio: 0.5, yRatio: 0.5 });

    expect(overlays.suppressActionsUntilPointerReentry).toHaveBeenCalledOnce();
    expect(overlays.suppressActionsUntilPointerReentry).toHaveBeenCalledWith("annotation-1");
    expect(vi.mocked(overlays.suppressActionsUntilPointerReentry!).mock.invocationCallOrder[0])
      .toBeLessThan(vi.mocked(overlays.sync).mock.invocationCallOrder[0]!);
  });

  test("guards only the new annotation when a previewed target is already bound", () => {
    const target = document.createElement("button");
    document.body.append(target);
    const overlays = createOverlayHarness();
    const coordinator = createContentOverlayCoordinator(overlays);
    coordinator.bindRestored(
      { itemId: "annotation-1", attachmentId: "heading", label: "1", taskNote: "" },
      target,
    );
    coordinator.applySelectionPreview(target);
    vi.mocked(overlays.suppressActionsUntilPointerReentry!).mockClear();

    coordinator.commitTarget(target, {
      origin: "https://app.example.test",
      epoch: "epoch-1",
      itemId: "annotation-2",
      annotationLabel: "2",
    }, { xRatio: 0.75, yRatio: 0.5 });

    expect(overlays.suppressActionsUntilPointerReentry).toHaveBeenCalledOnce();
    expect(overlays.suppressActionsUntilPointerReentry).toHaveBeenCalledWith("annotation-2");
    expect(overlays.suppressActionsUntilPointerReentry).not.toHaveBeenCalledWith("annotation-1");
  });

  test("keeps a commit without a matching live selection preview immediately hoverable", () => {
    const previewed = document.createElement("button");
    const committed = document.createElement("button");
    document.body.append(previewed, committed);
    const overlays = createOverlayHarness();
    const coordinator = createContentOverlayCoordinator(overlays);
    coordinator.applySelectionPreview(previewed);
    vi.mocked(overlays.suppressActionsUntilPointerReentry!).mockClear();

    coordinator.commitTarget(committed, {
      origin: "https://app.example.test",
      epoch: "epoch-1",
      itemId: "annotation-programmatic",
      annotationLabel: "1",
    });

    expect(overlays.suppressActionsUntilPointerReentry).not.toHaveBeenCalled();
  });

  test("previews both relationship targets and restores the persisted active target", () => {
    const save = document.createElement("button");
    const cancel = document.createElement("button");
    document.body.append(save, cancel);
    const overlays = createOverlayHarness();
    const coordinator = createContentOverlayCoordinator(overlays);

    coordinator.bindRestored(
      { itemId: "att_save", attachmentId: "att_save", label: "A", taskNote: "" },
      save,
    );
    coordinator.bindRestored(
      { itemId: "att_cancel", attachmentId: "att_cancel", label: "B", taskNote: "" },
      cancel,
    );
    coordinator.applyState({
      type: "ui-attach:overlay-state",
      origin: "https://app.example.test",
      projection: TEST_PROJECTION,
      activeItemId: "att_cancel",
      items: [
        { itemId: "att_save", attachmentId: "att_save", label: "A", taskNote: "" },
        { itemId: "att_cancel", attachmentId: "att_cancel", label: "B", taskNote: "" },
      ],
    });

    coordinator.applyRelationPreview("att_save", "att_cancel");
    expect(overlays.sync).toHaveBeenLastCalledWith([
      { itemId: "att_save", label: "A", taskNote: "", target: save },
      { itemId: "att_cancel", label: "B", taskNote: "", target: cancel },
    ], "att_cancel", {
      sourceItemId: "att_save",
      referenceItemId: "att_cancel",
    });

    coordinator.applyPreview(null);
    expect(overlays.sync).toHaveBeenLastCalledWith([
      { itemId: "att_save", label: "A", taskNote: "", target: save },
      { itemId: "att_cancel", label: "B", taskNote: "", target: cancel },
    ], "att_cancel");
  });

  test("clears an ephemeral preview when persisted overlay state changes", () => {
    const save = document.createElement("button");
    const cancel = document.createElement("button");
    document.body.append(save, cancel);
    const overlays = createOverlayHarness();
    const coordinator = createContentOverlayCoordinator(overlays);

    coordinator.bindRestored(
      { itemId: "att_save", attachmentId: "att_save", label: "A", taskNote: "" },
      save,
    );
    coordinator.bindRestored(
      { itemId: "att_cancel", attachmentId: "att_cancel", label: "B", taskNote: "" },
      cancel,
    );
    coordinator.applyPreview("att_save");
    coordinator.applyState({
      type: "ui-attach:overlay-state",
      origin: "https://app.example.test",
      projection: TEST_PROJECTION,
      activeItemId: "att_cancel",
      items: [{ itemId: "att_cancel", attachmentId: "att_cancel", label: "B", taskNote: "" }],
    });

    expect(overlays.sync).toHaveBeenLastCalledWith(
      [{ itemId: "att_cancel", label: "B", taskNote: "", target: cancel }],
      "att_cancel",
    );
  });
});

describe("content overlay action feedback", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.doUnmock("@meanthis/web-picker");
    vi.doUnmock("./content-overlays");
    vi.resetModules();
    document.body.replaceChildren();
    document.querySelectorAll("[data-ui-attach-ignore]").forEach((element) => element.remove());
  });

  test("keeps the applied projection but renders markers only for the active frame scope", async () => {
    vi.resetModules();
    const setVisible = vi.fn();
    vi.doMock("./content-overlays", async (importOriginal) => {
      const actual = await importOriginal<typeof import("./content-overlays")>();
      return {
        ...actual,
        createContentOverlayCoordinator: vi.fn(() => ({
          setVisible,
          setDisplayMode: vi.fn(),
          commitTarget: vi.fn(),
          hasTarget: vi.fn(() => false),
          resolveTarget: vi.fn(() => ({ kind: "none" })),
          bindRestored: vi.fn(),
          unbindRestored: vi.fn(),
          applyState: vi.fn(),
          applyPreview: vi.fn(),
          applyRelationPreview: vi.fn(),
          applySelectionPreview: vi.fn(),
          readStatus: vi.fn(() => ({
            appliedItemIds: ["item-saved"],
            markerCount: 1,
            selectionPreviewActive: false,
          })),
        })),
      };
    });
    vi.doMock("@meanthis/web-picker", async (importOriginal) => {
      const actual = await importOriginal<typeof import("@meanthis/web-picker")>();
      return {
        ...actual,
        createPersistentOverlayController: vi.fn(() => ({
          sync: vi.fn(),
          refresh: vi.fn(),
          dispose: vi.fn(),
          setActionsEnabled: vi.fn(),
          setDisplayMode: vi.fn(),
        })),
      };
    });
    const runtimeListeners: Array<(
      message: unknown,
      sender: unknown,
      sendResponse: (response?: unknown) => void,
    ) => boolean | void> = [];
    const sendMessage = vi.fn((message: unknown) => {
      const type = isRecord(message) ? message.type : null;
      if (type === "ui-attach:content-settings-get") {
        return Promise.resolve({
          ok: true,
          data: { disclosureMode: "agent_safe", elementSelectionEnabled: false },
        });
      }
      if (type === "ui-attach:overlay-visibility-get" ||
          type === "ui-attach:overlay-scope-visibility-get") {
        return Promise.resolve({ ok: true, data: { visible: true } });
      }
      if (type === "ui-attach:overlay-display-mode-get") {
        return Promise.resolve({ ok: true, data: { displayMode: "hover" } });
      }
      if (type === "ui-attach:overlay-projection-ack") {
        return Promise.resolve({ ok: true, data: { accepted: true } });
      }
      if (type === "ui-attach:overlays-restore-get") return Promise.resolve(undefined);
      return Promise.resolve(undefined);
    });
    vi.stubGlobal("chrome", {
      i18n: { getMessage: vi.fn(() => "") },
      runtime: {
        connect: vi.fn(),
        getURL: vi.fn((path: string) => `chrome-extension://test/${path}`),
        onMessage: { addListener: vi.fn((listener) => runtimeListeners.push(listener)) },
        sendMessage,
      },
    });
    document.body.innerHTML = '<button data-testid="saved-target">Saved target</button>';

    await import("./content");
    await flushContentAsyncWork();
    setVisible.mockClear();

    for (const listener of runtimeListeners) listener({
      type: "ui-attach:overlay-scope-visibility-updated",
      visible: false,
    }, {}, () => undefined);
    expect(setVisible).toHaveBeenLastCalledWith(false);

    for (const listener of runtimeListeners) listener({
      type: "ui-attach:overlay-scope-visibility-updated",
      visible: true,
    }, {}, () => undefined);
    expect(setVisible).toHaveBeenLastCalledWith(true);
  });

  test("shows safe feedback for action failure and keeps actions unavailable after ACK rejection", async () => {
    vi.resetModules();
    let overlayOptions: PersistentOverlayControllerOptions | undefined;
    vi.doMock("@meanthis/web-picker", async (importOriginal) => {
      const actual = await importOriginal<typeof import("@meanthis/web-picker")>();
      return {
        ...actual,
        createPersistentOverlayController: vi.fn((options: PersistentOverlayControllerOptions) => {
          overlayOptions = options;
          return {
            sync: vi.fn(),
            refresh: vi.fn(),
            dispose: vi.fn(),
          };
        }),
      };
    });
    const runtimeListeners: Array<(
      message: unknown,
      sender: unknown,
      sendResponse: (response?: unknown) => void,
    ) => boolean | void> = [];
    let ackAccepted = true;
    let restoreRequests = 0;
    const sendMessage = vi.fn((message: unknown) => {
      const type = typeof message === "object" && message !== null && "type" in message
        ? (message as { type?: unknown }).type
        : null;
      if (type === "ui-attach:overlay-visibility-get") {
        return Promise.resolve({ ok: true, data: { visible: true } });
      }
      if (type === "ui-attach:overlay-projection-ack") {
        return Promise.resolve({ ok: true, data: { accepted: ackAccepted } });
      }
      if (type === "ui-attach:overlays-restore-get") {
        restoreRequests += 1;
        return Promise.resolve(undefined);
      }
      const action = typeof message === "object" && message !== null &&
          "action" in message ? (message as { action?: unknown }).action : null;
      return action === "remove" || action === "more"
        ? Promise.resolve({ ok: false, code: "CAPTURE_FAILED", error: "private detail" })
        : Promise.resolve(undefined);
    });
    vi.stubGlobal("chrome", {
      i18n: { getMessage: vi.fn(() => "") },
      runtime: {
        connect: vi.fn(),
        getURL: vi.fn((path: string) => `chrome-extension://test/${path}`),
        onMessage: { addListener: vi.fn((listener) => runtimeListeners.push(listener)) },
        sendMessage,
      },
    });
    document.body.innerHTML = '<button id="page-action">Private page text</button>';

    await import("./content");
    await flushContentAsyncWork();
    if (!overlayOptions) throw new Error("persistent overlay options missing");
    const projection = {
      ...TEST_PROJECTION,
      subject: {
        ...TEST_PROJECTION.subject,
        origin: window.location.origin,
        pathname: window.location.pathname,
      },
    };
    for (const listener of runtimeListeners) listener({
      type: "ui-attach:overlay-state",
      origin: window.location.origin,
      projection,
      activeItemId: null,
      items: [],
    }, {}, () => undefined);
    await flushContentAsyncWork();
    await (overlayOptions.onRemove as ((itemId: string) => Promise<void>) | undefined)?.("item-remove");
    await (overlayOptions.onMore as ((itemId: string) => Promise<void>) | undefined)?.("item-more");

    const feedbackHost = document.querySelector<HTMLElement>(
      "[data-ui-attach-overlay-action-failure]",
    );
    expect(feedbackHost).not.toBeNull();
    expect(feedbackHost?.shadowRoot?.querySelector("[role='alert']")?.textContent)
      .toBe("MeanThis could not complete this annotation action.");
    expect(feedbackHost?.shadowRoot?.textContent).not.toContain("private detail");
    expect(feedbackHost?.shadowRoot?.textContent).not.toContain("Private page text");

    ackAccepted = false;
    const restoreRequestsBeforeRejection = restoreRequests;
    sendMessage.mockClear();
    for (const listener of runtimeListeners) listener({
      type: "ui-attach:overlay-state",
      origin: window.location.origin,
      projection: { ...projection, revision: 2 },
      activeItemId: null,
      items: [],
    }, {}, () => undefined);
    await flushContentAsyncWork();
    await (overlayOptions.onMore as ((itemId: string) => Promise<void>) | undefined)?.(
      "item-after-rejected-ack",
    );
    expect(sendMessage).toHaveBeenCalledWith({
      type: "ui-attach:overlay-projection-ack",
      projection: {
        version: 1,
        projectionId: TEST_PROJECTION.projectionId,
        revision: 2,
      },
    });
    expect(sendMessage.mock.calls.some(([message]) => (
      typeof message === "object" && message !== null && "action" in message
    ))).toBe(false);
    expect(restoreRequests).toBeGreaterThan(restoreRequestsBeforeRejection);
    expect(document.querySelector("[data-ui-attach-overlay-action-failure]")).not.toBeNull();

    runtimeListeners[0]?.(
      { type: "ui-attach:content-deactivate" },
      {},
      () => undefined,
    );
    expect(document.querySelector("[data-ui-attach-overlay-action-failure]")).toBeNull();
  });

  test("re-ACKs the exact applied projection once after a worker restart and retries the marker action", async () => {
    vi.resetModules();
    let overlayOptions: PersistentOverlayControllerOptions | undefined;
    vi.doMock("@meanthis/web-picker", async (importOriginal) => {
      const actual = await importOriginal<typeof import("@meanthis/web-picker")>();
      return {
        ...actual,
        createPersistentOverlayController: vi.fn((options: PersistentOverlayControllerOptions) => {
          overlayOptions = options;
          return {
            sync: vi.fn(),
            refresh: vi.fn(),
            dispose: vi.fn(),
            setActionsEnabled: vi.fn(),
          };
        }),
      };
    });
    const runtimeListeners: Array<(
      message: unknown,
      sender: unknown,
      sendResponse: (response?: unknown) => void,
    ) => boolean | void> = [];
    let actionAttempts = 0;
    const sendMessage = vi.fn((message: unknown) => {
      const type = isRecord(message) ? message.type : null;
      if (type === "ui-attach:content-settings-get") {
        return Promise.resolve({
          ok: true,
          data: { disclosureMode: "agent_safe", elementSelectionEnabled: false },
        });
      }
      if (type === "ui-attach:overlay-visibility-get") {
        return Promise.resolve({ ok: true, data: { visible: true } });
      }
      if (type === "ui-attach:overlay-display-mode-get") {
        return Promise.resolve({ ok: true, data: { displayMode: "hover" } });
      }
      if (type === "ui-attach:overlay-projection-ack") {
        return Promise.resolve({ ok: true, data: { accepted: true } });
      }
      if (type === "ui-attach:overlays-restore-get") return Promise.resolve(undefined);
      if (type === "ui-attach:overlay-action-request") {
        actionAttempts += 1;
        return Promise.resolve(actionAttempts === 1
          ? {
              ok: false,
              code: "OVERLAY_PROJECTION_REACK_REQUIRED",
              error: "Projection acknowledgement is required.",
            }
          : { ok: true, data: null });
      }
      return Promise.resolve(undefined);
    });
    vi.stubGlobal("chrome", {
      i18n: { getMessage: vi.fn(() => "") },
      runtime: {
        connect: vi.fn(),
        getURL: vi.fn((path: string) => `chrome-extension://test/${path}`),
        onMessage: { addListener: vi.fn((listener) => runtimeListeners.push(listener)) },
        sendMessage,
      },
    });
    document.body.innerHTML = '<button id="page-action">Page action</button>';

    await import("./content");
    await flushContentAsyncWork();
    if (!overlayOptions) throw new Error("persistent overlay options missing");
    const projection = {
      ...TEST_PROJECTION,
      subject: {
        ...TEST_PROJECTION.subject,
        origin: window.location.origin,
        pathname: window.location.pathname,
      },
    };
    for (const listener of runtimeListeners) listener({
      type: "ui-attach:overlay-state",
      origin: window.location.origin,
      projection,
      activeItemId: null,
      items: [],
    }, {}, () => undefined);
    await flushContentAsyncWork();
    sendMessage.mockClear();

    await (overlayOptions.onRemove as ((itemId: string) => Promise<void>) | undefined)?.(
      "restored-item",
    );

    const actionMessages = sendMessage.mock.calls
      .map(([message]) => message)
      .filter((message) => isRecord(message) && message.type === "ui-attach:overlay-action-request");
    expect(actionMessages).toHaveLength(2);
    expect(actionMessages[0]).toEqual(actionMessages[1]);
    expect(sendMessage).toHaveBeenCalledWith({
      type: "ui-attach:overlay-projection-ack",
      projection: {
        version: projection.version,
        projectionId: projection.projectionId,
        revision: projection.revision,
      },
    });
    expect(document.querySelector("[data-ui-attach-overlay-action-failure]")).toBeNull();
  });

  test("clears an applied restore when SPA navigation wins the pending ACK race", async () => {
    vi.resetModules();
    vi.doUnmock("@meanthis/web-picker");
    const runtimeListeners: Array<(
      message: unknown,
      sender: unknown,
      sendResponse: (response?: unknown) => void,
    ) => boolean | void> = [];
    let resolveAck!: (value: unknown) => void;
    const pendingAck = new Promise<unknown>((resolve) => {
      resolveAck = resolve;
    });
    const originalPath = window.location.pathname;
    const projection = {
      ...TEST_PROJECTION,
      subject: {
        ...TEST_PROJECTION.subject,
        origin: window.location.origin,
        pathname: originalPath,
      },
    };
    const sendMessage = vi.fn((message: unknown) => {
      const type = typeof message === "object" && message !== null && "type" in message
        ? (message as { type?: unknown }).type
        : null;
      if (type === "ui-attach:content-settings-get") {
        return Promise.resolve({
          ok: true,
          data: { disclosureMode: "agent_safe", elementSelectionEnabled: false },
        });
      }
      if (type === "ui-attach:overlay-visibility-get") {
        return Promise.resolve({ ok: true, data: { visible: true } });
      }
      if (type === "ui-attach:overlay-projection-ack") return pendingAck;
      if (type === "ui-attach:overlays-restore-get") {
        return Promise.resolve({
          ok: true,
          data: {
            origin: window.location.origin,
            projection,
            activeItemId: "item-save",
            items: [{
              itemId: "item-save",
              attachmentId: "att-save",
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
      }
      return Promise.resolve(undefined);
    });
    vi.stubGlobal("chrome", {
      i18n: { getMessage: vi.fn(() => "") },
      runtime: {
        connect: vi.fn(),
        getURL: vi.fn((path: string) => `chrome-extension://test/${path}`),
        onMessage: { addListener: vi.fn((listener) => runtimeListeners.push(listener)) },
        sendMessage,
      },
    });
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

    try {
      await import("./content");
      await vi.waitFor(() => {
        const overlay = Array.from(
          document.querySelectorAll<HTMLElement>("[data-ui-attach-overlay-root]"),
        ).at(-1)?.shadowRoot?.querySelector(".ui-attach-overlay");
        expect(overlay).not.toBeNull();
      });

      window.history.pushState({}, "", "/r1-pending-ack-navigation");
      window.dispatchEvent(new PopStateEvent("popstate"));
      await flushContentAsyncWork();
      const overlayAfterNavigation = Array.from(
        document.querySelectorAll<HTMLElement>("[data-ui-attach-overlay-root]"),
      ).at(-1)?.shadowRoot?.querySelector(".ui-attach-overlay");
      expect(overlayAfterNavigation).toBeNull();

      resolveAck({ ok: true, data: { accepted: true } });
      await flushContentAsyncWork();
      const overlayAfterLateAck = Array.from(
        document.querySelectorAll<HTMLElement>("[data-ui-attach-overlay-root]"),
      ).at(-1)?.shadowRoot?.querySelector(".ui-attach-overlay");
      expect(overlayAfterLateAck).toBeNull();
    } finally {
      runtimeListeners[0]?.(
        { type: "ui-attach:content-deactivate" },
        {},
        () => undefined,
      );
      window.history.replaceState({}, "", originalPath);
    }
  });

  test("applies an exact clear tombstone, reads zero connected markers, and fences old restore", async () => {
    vi.resetModules();
    vi.doUnmock("@meanthis/web-picker");
    const runtimeListeners: Array<(
      message: unknown,
      sender: unknown,
      sendResponse: (response?: unknown) => void,
    ) => boolean | void> = [];
    const subject = {
      ...TEST_PROJECTION.subject,
      origin: window.location.origin,
      pathname: window.location.pathname,
    };
    let restoreEpoch = "epoch-before-clear";
    let restoreRevision = 1;
    const sendMessage = vi.fn((message: unknown) => {
      const type = isRecord(message) ? message.type : null;
      if (type === "ui-attach:content-settings-get") {
        return Promise.resolve({
          ok: true,
          data: { disclosureMode: "agent_safe", elementSelectionEnabled: false },
        });
      }
      if (type === "ui-attach:overlay-visibility-get") {
        return Promise.resolve({ ok: true, data: { visible: true } });
      }
      if (type === "ui-attach:overlay-display-mode-get") {
        return Promise.resolve({ ok: true, data: { displayMode: "hover" } });
      }
      if (type === "ui-attach:overlay-projection-ack") {
        return Promise.resolve({ ok: true, data: { accepted: true } });
      }
      if (type === "ui-attach:overlays-restore-get") {
        return Promise.resolve({
          ok: true,
          data: {
            origin: window.location.origin,
            projection: {
              ...TEST_PROJECTION,
              projectionId: `restore-${restoreEpoch}`,
              revision: restoreRevision,
              sessionEpoch: restoreEpoch,
              subject,
            },
            activeItemId: "item-save",
            items: [{
              itemId: "item-save",
              attachmentId: "att-save",
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
      }
      if (type === UI_ATTACH_CLEAR_PROJECTION_ACK) {
        return Promise.resolve({ ok: true, data: { accepted: true } });
      }
      return Promise.resolve(undefined);
    });
    vi.stubGlobal("chrome", {
      i18n: { getMessage: vi.fn(() => "") },
      runtime: {
        connect: vi.fn(),
        getURL: vi.fn((path: string) => `chrome-extension://test/${path}`),
        onMessage: { addListener: vi.fn((listener) => runtimeListeners.push(listener)) },
        sendMessage,
      },
    });
    document.body.innerHTML = '<button data-testid="save">Save changes</button>';
    const button = document.querySelector<HTMLElement>("button");
    if (!button) throw new Error("clear projection target fixture missing");
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
    await vi.waitFor(() => expect(readRealMarkerCount()).toBe(1));
    const clear = {
      version: 1 as const,
      authorityId: "authority-1",
      operationId: "clear-page-1",
      generation: 1,
      origin: window.location.origin,
      afterEpoch: "epoch-after-clear",
      subject,
      projectionId: "clear-projection-1",
      revision: 1,
    };
    runtimeListeners[0]?.({ type: UI_ATTACH_CLEAR_PROJECTION, clear }, {}, () => undefined);
    await vi.waitFor(() => expect(readRealMarkerCount()).toBe(0));
    expect(sendMessage).toHaveBeenCalledWith({
      type: UI_ATTACH_CLEAR_PROJECTION_ACK,
      clear,
      readback: {
        appliedItemIds: [],
        markerCount: 0,
        selectionPreviewActive: false,
        digest: UI_ATTACH_EMPTY_APPLIED_ITEM_IDS_DIGEST,
      },
    });

    await dispatchContentMessage(runtimeListeners, { type: "ui-attach:overlay-restore-refresh" });
    await flushContentAsyncWork();
    expect(readRealMarkerCount()).toBe(0);

    restoreEpoch = clear.afterEpoch;
    restoreRevision = 2;
    await dispatchContentMessage(runtimeListeners, { type: "ui-attach:overlay-restore-refresh" });
    await vi.waitFor(() => expect(readRealMarkerCount()).toBe(1));
    runtimeListeners[0]?.({ type: "ui-attach:content-deactivate" }, {}, () => undefined);
  });
});

function readRealMarkerCount(): number {
  const host = Array.from(document.querySelectorAll<HTMLElement>(
    "[data-ui-attach-overlay-root]",
  )).at(-1);
  return host?.shadowRoot?.querySelectorAll(".ui-attach-overlay").length ?? 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

async function dispatchContentMessage(
  listeners: Array<(
    message: unknown,
    sender: unknown,
    sendResponse: (response?: unknown) => void,
  ) => boolean | void>,
  message: unknown,
): Promise<unknown> {
  return await new Promise((resolve) => {
    const keepAlive = listeners[0]?.(message, {}, resolve);
    if (keepAlive !== true) resolve(undefined);
  });
}

function createOverlayHarness(): PersistentOverlayController {
  return {
    sync: vi.fn(),
    readStatus: vi.fn(() => ({ itemIds: [], markerCount: 0 })),
    setTemporaryHighlight: vi.fn(),
    suppressActionsUntilPointerReentry: vi.fn(),
    refresh: vi.fn(),
    dispose: vi.fn(),
  };
}

async function flushContentAsyncWork(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}
