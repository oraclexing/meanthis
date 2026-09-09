import type {
  CaptureSessionFileV1,
  CaptureSessionFileV2,
  CaptureSessionFileV3,
} from "@meanthis/hub-core";
import { describe, expect, test, vi } from "vitest";
import type { OriginCaptureRecord } from "./capture-store";
import type { ActiveSessionCommandData } from "./messages";
import type { ActiveSessionReadback } from "./session-store";
import { createCaptureRecord, createSessionFile } from "../test/session-fixtures";
import {
  createPanelSessionController,
  type PanelSessionClient,
  type PanelSessionSnapshot,
} from "./panel-session-controller";
import {
  createPanelAnnotationSurfaceAdapter,
  toPanelAnnotationSurfaceReadback,
} from "./widget-annotation-adapter";

const ORIGIN = "https://app.example.test";

const MALFORMED_WIDGET_CLEAR_PAIR_CASES: ReadonlyArray<[
  string,
  (snapshot: PanelSessionSnapshot) => unknown,
]> = [
  ["numeric zero", (snapshot) => ({
    ...snapshot,
    clearPending: 0,
    activeClearOperationId: null,
  })],
  ["empty string", (snapshot) => ({
    ...snapshot,
    clearPending: "",
    activeClearOperationId: null,
  })],
  ["undefined boolean", (snapshot) => ({
    ...snapshot,
    clearPending: undefined,
    activeClearOperationId: null,
  })],
  ["missing boolean", (snapshot) => {
    const { clearPending: _clearPending, ...missing } = snapshot;
    return missing;
  }],
  ["truthy number", (snapshot) => ({
    ...snapshot,
    clearPending: 1,
    activeClearOperationId: "operation-truthy",
  })],
  ["idle with id", (snapshot) => ({
    ...snapshot,
    clearPending: false,
    activeClearOperationId: "operation-idle",
  })],
  ["pending with null id", (snapshot) => ({
    ...snapshot,
    clearPending: true,
    activeClearOperationId: null,
  })],
  ["pending with whitespace id", (snapshot) => ({
    ...snapshot,
    clearPending: true,
    activeClearOperationId: " operation-whitespace ",
  })],
  ["pending with overbound id", (snapshot) => ({
    ...snapshot,
    clearPending: true,
    activeClearOperationId: "x".repeat(129),
  })],
];

interface StructuralWidgetClearPairFixture {
  value: PanelSessionSnapshot;
  getterCalls(): number;
}

const STRUCTURALLY_INVALID_WIDGET_CLEAR_PAIR_CASES: ReadonlyArray<[
  string,
  (snapshot: PanelSessionSnapshot) => StructuralWidgetClearPairFixture,
]> = [
  ["inherited pair", (snapshot) => {
    const { clearPending, activeClearOperationId, ...ownFields } = snapshot;
    return {
      value: Object.assign(Object.create({ clearPending, activeClearOperationId }), ownFields),
      getterCalls: () => 0,
    };
  }],
  ["accessor pair", (snapshot) => {
    let calls = 0;
    const value = { ...snapshot };
    Object.defineProperty(value, "clearPending", {
      configurable: true,
      enumerable: true,
      get() {
        calls += 1;
        return false;
      },
    });
    Object.defineProperty(value, "activeClearOperationId", {
      configurable: true,
      enumerable: true,
      get() {
        calls += 1;
        return null;
      },
    });
    return { value, getterCalls: () => calls } as StructuralWidgetClearPairFixture;
  }],
  ["extra string field", (snapshot) => ({
    value: { ...snapshot, unexpected: true } as PanelSessionSnapshot,
    getterCalls: () => 0,
  })],
  ["extra symbol field", (snapshot) => {
    const value = { ...snapshot };
    Object.defineProperty(value, Symbol("unexpected"), {
      configurable: true,
      enumerable: true,
      value: true,
    });
    return { value, getterCalls: () => 0 };
  }],
  ["non-enumerable pair field", (snapshot) => {
    const value = { ...snapshot };
    Object.defineProperty(value, "clearPending", {
      configurable: true,
      enumerable: false,
      writable: true,
      value: false,
    });
    return { value, getterCalls: () => 0 };
  }],
  ["structural proxy failure", (snapshot) => ({
    value: new Proxy({ ...snapshot }, {
      ownKeys() {
        throw new Error("structural trap");
      },
    }),
    getterCalls: () => 0,
  })],
];

describe("createPanelAnnotationSurfaceAdapter", () => {
  test("keeps full-session annotation numbers when the current page or authoritative scope hides earlier items", async () => {
    const harness = createHarness();
    await harness.controller.initialize();
    const first = createCaptureRecord("save", "Save changes");
    const second = createCaptureRecord("cancel", "Cancel");
    first.pageUrl = `${ORIGIN}/first`;
    first.attachment.source.url = first.pageUrl;
    second.pageUrl = `${ORIGIN}/second`;
    second.attachment.source.url = second.pageUrl;
    const file = createSessionFile([first, second]);
    const snapshot = {
      ...harness.controller.getSnapshot(),
      file,
      selectedItemId: "att_cancel",
      activePage: { tabId: 1, frameId: 0, origin: ORIGIN, pathname: "/second" },
    };
    expect(toPanelAnnotationSurfaceReadback(snapshot).items)
      .toMatchObject([{ itemId: "att_cancel", label: "2" }]);
    expect(toPanelAnnotationSurfaceReadback(snapshot, ["att_cancel"]).items)
      .toMatchObject([{ itemId: "att_cancel", label: "2" }]);
    expect(toPanelAnnotationSurfaceReadback({ ...snapshot, activePage: null }, ["att_save", "att_cancel"]).items)
      .toMatchObject([{ itemId: "att_save", label: "1" }, { itemId: "att_cancel", label: "2" }]);
    file.session.attachments.shift();
    expect(toPanelAnnotationSurfaceReadback(snapshot, ["att_cancel"]).items)
      .toMatchObject([{ itemId: "att_cancel", label: "1" }]);
  });

  test("reads a V2 snapshot without changing or inventing annotation identity", async () => {
    const harness = createHarness();
    await harness.controller.initialize();
    const record = createCaptureRecord("save", "Save changes");
    const file = createV2SessionFile([record]);
    const snapshot: PanelSessionSnapshot = {
      ...harness.controller.getSnapshot(),
      file,
      selectedItemId: "att_save",
    };
    const before = structuredClone(file);

    expect(toPanelAnnotationSurfaceReadback(snapshot)).toMatchObject({
      items: [{ itemId: "att_save", taskNote: record.intent }],
      activeItemId: "att_save",
    });
    expect(file).toEqual(before);
    expect(file.session.attachments[0]).toMatchObject({
      annotationId: "annotation:1",
      updatedAt: record.capturedAt,
    });
  });

  test("maps authenticated MV3 session operations to the shared annotation contract", async () => {
    const harness = createHarness();
    await harness.controller.initialize();
    const activateOverlay = vi.fn(async () => undefined);
    const copy = vi.fn(async (_detail, snapshot) => ({
      copied: true,
      count: snapshot.file?.session.attachments.length ?? 0,
      text: "handoff",
      readback: toPanelAnnotationSurfaceReadback(snapshot),
    }));
    const adapter = createPanelAnnotationSurfaceAdapter({
      controller: harness.controller,
      activateOverlay,
      copy,
      createOperationId: () => "operation-1",
      strings: {
        operationFailed: "operation failed",
        sessionNotReady: "session not ready",
        taskNoteSaveFailed: "save failed",
      },
    });

    const activated = await adapter.activate("att_save");
    expect(activateOverlay).toHaveBeenCalledWith("att_save");
    expect(activated.activeItemId).toBe("att_save");
    expect(activated.items.map((item) => item.label)).toEqual(["1", "2"]);

    adapter.stageTaskNote("att_save", "Move below the form.");
    const saved = await adapter.saveTaskNote("att_save", "Move below the form.");
    expect(saved.items.find((item) => item.itemId === "att_save")?.taskNote)
      .toBe("Move below the form.");

    const removed = await adapter.remove("att_cancel");
    expect(removed.items.map((item) => item.itemId)).toEqual(["att_save"]);
    expect(harness.client.calls).toContain("remove:att_cancel");

    await expect(adapter.copy("standard")).resolves.toMatchObject({ text: "handoff" });
    expect(copy).toHaveBeenCalledWith("standard", expect.objectContaining({
      selectedItemId: "att_save",
    }));

    const cleared = await adapter.clear();
    expect(cleared.items).toEqual([]);
    expect(cleared.clearStatus).toEqual({ clearState: "idle", operationId: null });
    expect(harness.client.calls).toContain("clear:operation-1");
  });

  test("projects V3 lifecycle and routes resolve through authoritative panel readback", async () => {
    const record = createCaptureRecord("save", "Save changes");
    const v2 = createV2SessionFile([record]);
    let file: CaptureSessionFileV3 = {
      ...v2,
      schemaVersion: "0.3.0",
      session: {
        ...v2.session,
        attachments: v2.session.attachments.map((item) => ({
          ...item,
          annotationLifecycle: { state: "open", resolvedAt: null },
        })),
      },
    };
    const calls: string[] = [];
    const client: PanelSessionClient = {
      getActive: vi.fn(async () => ({
        ok: true,
        data: createActiveData(createReadback(file as CaptureSessionFileV1)),
      })),
      updateIntent: vi.fn(),
      updateAnnotationLifecycle: vi.fn(async (
        origin,
        epoch,
        itemId,
        annotationId,
        expectedState,
        nextState,
      ) => {
        calls.push(`${itemId}:${annotationId}:${expectedState}:${nextState}`);
        file = {
          ...file,
          session: {
            ...file.session,
            updatedAt: "2026-08-31T00:01:00.000Z",
            attachments: file.session.attachments.map((item) => item.id === itemId
              ? {
                  ...item,
                  updatedAt: "2026-08-31T00:01:00.000Z",
                  annotationLifecycle: {
                    state: "resolved" as const,
                    resolvedAt: "2026-08-31T00:01:00.000Z",
                  },
                }
              : item),
          },
        };
        return { ok: true, data: createReadback(file as CaptureSessionFileV1, origin, epoch) };
      }),
      removeItem: vi.fn(),
      clear: vi.fn(),
    };
    const controller = createPanelSessionController({
      client,
      setTimeout: (callback, delay) => setTimeout(callback, delay),
      clearTimeout: (id) => clearTimeout(id as ReturnType<typeof setTimeout>),
    });
    await controller.initialize();
    const adapter = createPanelAnnotationSurfaceAdapter({
      controller,
      activateOverlay: vi.fn(async () => undefined),
      copy: vi.fn(async () => ({ copied: true, count: 1, text: "handoff" })),
      createOperationId: () => "operation-lifecycle",
      strings: {
        operationFailed: "operation failed",
        sessionNotReady: "session not ready",
        taskNoteSaveFailed: "save failed",
      },
    });

    expect(toPanelAnnotationSurfaceReadback(controller.getSnapshot())).toMatchObject({
      items: [{
        itemId: "att_save",
        annotationLifecycle: { state: "open", resolvedAt: null },
      }],
    });
    const readback = await adapter.setAnnotationLifecycle("att_save", "resolved");

    expect(calls).toEqual(["att_save:annotation:1:open:resolved"]);
    expect(readback).toMatchObject({
      items: [{
        itemId: "att_save",
        annotationLifecycle: {
          state: "resolved",
          resolvedAt: "2026-08-31T00:01:00.000Z",
        },
      }],
    });
  });

  test("forwards a supplied durable clear id without calling the generator", async () => {
    const harness = createHarness();
    await harness.controller.initialize();
    const createOperationId = vi.fn(() => "operation-generated");
    const adapter = createPanelAnnotationSurfaceAdapter({
      controller: harness.controller,
      activateOverlay: vi.fn(async () => undefined),
      copy: vi.fn(async () => ({ copied: true, count: 0, text: "" })),
      createOperationId,
      strings: {
        operationFailed: "operation failed",
        sessionNotReady: "session not ready",
        taskNoteSaveFailed: "save failed",
      },
    });

    await adapter.clear("operation-durable");

    expect(createOperationId).not.toHaveBeenCalled();
    expect(harness.client.calls).toContain("clear:operation-durable");
  });

  test("does not project an off-page site reference onto the current page", async () => {
    const harness = createHarness();
    await harness.controller.initialize();
    const activateOverlay = vi.fn(async () => undefined);
    const adapter = createPanelAnnotationSurfaceAdapter({
      controller: harness.controller,
      getCurrentScopeItemIds: () => ["att_save", "att_cancel"],
      getCurrentPageItemIds: () => ["att_save"],
      activateOverlay,
      copy: vi.fn(async () => ({ copied: true, count: 2, text: "handoff" })),
      createOperationId: () => "operation-1",
      strings: {
        operationFailed: "operation failed",
        sessionNotReady: "session not ready",
        taskNoteSaveFailed: "save failed",
      },
    });

    const activated = await adapter.activate("att_cancel");

    expect(activated.activeItemId).toBe("att_cancel");
    expect(activateOverlay).not.toHaveBeenCalled();
  });

  test("clears only the currently selected reference scope", async () => {
    const harness = createHarness();
    await harness.controller.initialize();
    const adapter = createPanelAnnotationSurfaceAdapter({
      controller: harness.controller,
      getCurrentScopeItemIds: () => ["att_save"],
      getCurrentPageItemIds: () => ["att_save"],
      activateOverlay: vi.fn(async () => undefined),
      copy: vi.fn(async () => ({ copied: true, count: 1, text: "handoff" })),
      createOperationId: () => "operation-1",
      strings: {
        operationFailed: "operation failed",
        sessionNotReady: "session not ready",
        taskNoteSaveFailed: "save failed",
      },
    });

    const cleared = await adapter.clear();

    expect(cleared.items).toEqual([]);
    expect(harness.client.calls).toContain("remove:att_save");
    expect(harness.client.calls).not.toContain("remove:att_cancel");
    expect(harness.client.calls.some((call) => call.startsWith("clear:"))).toBe(false);
    expect(harness.controller.getSnapshot().file?.session.attachments
      .some((item) => item.id === "att_cancel")).toBe(true);
  });

  test("clears every stored reference when the site scope is selected", async () => {
    const harness = createHarness();
    await harness.controller.initialize();
    const adapter = createPanelAnnotationSurfaceAdapter({
      controller: harness.controller,
      getCurrentScopeItemIds: () => ["att_save", "att_cancel"],
      getCurrentScopeKind: () => "site",
      getCurrentPageItemIds: () => ["att_save"],
      activateOverlay: vi.fn(async () => undefined),
      copy: vi.fn(async () => ({ copied: true, count: 2, text: "handoff" })),
      createOperationId: () => "operation-1",
      strings: {
        operationFailed: "operation failed",
        sessionNotReady: "session not ready",
        taskNoteSaveFailed: "save failed",
      },
    });

    const cleared = await adapter.clear();

    expect(cleared.items).toEqual([]);
    expect(harness.client.calls.filter((call) => call.startsWith("remove:"))).toEqual([]);
    expect(harness.client.calls).toContain("clear:operation-1:active-origin");
    expect(harness.controller.getSnapshot().file?.session.attachments).toEqual([]);
  });

  test.each(["remove", "clear"] as const)("reconciles %s after a notification supersedes a successful removal", async (action) => {
    const harness = createHarness();
    await harness.controller.initialize();
    const originalRemove = harness.client.removeItem.bind(harness.client);
    vi.spyOn(harness.client, "removeItem").mockImplementation(async (...args) => {
      // The notification reads before the deletion commits, but supersedes the
      // controller's mutation request. The successful mutation reply is ignored.
      await harness.controller.refreshActiveOrigin();
      return originalRemove(...args);
    });
    const adapter = createPanelAnnotationSurfaceAdapter({
      controller: harness.controller,
      getCurrentScopeItemIds: () => ["att_save", "att_cancel"],
      activateOverlay: vi.fn(async () => undefined),
      copy: vi.fn(async () => ({ copied: true, count: 0, text: "" })),
      createOperationId: () => "operation-1",
      strings: { operationFailed: "operation failed", sessionNotReady: "session not ready", taskNoteSaveFailed: "save failed" },
    });
    const result = action === "clear" ? await adapter.clear() : await adapter.remove("att_save");
    expect(result.items.map((item) => item.itemId)).toEqual(action === "clear" ? [] : ["att_cancel"]);
    expect(harness.client.calls.filter((call) => call.startsWith("remove:")))
      .toEqual(action === "clear" ? ["remove:att_save", "remove:att_cancel"] : ["remove:att_save"]);
  });

  test.each(["STORAGE_ERROR", "Capture diagnostics cleanup is pending retry."])("does not refresh away a removal error: %s", async (message) => {
    const harness = createHarness();
    await harness.controller.initialize();
    vi.spyOn(harness.client, "removeItem").mockResolvedValue({ ok: false, code: "STORAGE_ERROR", error: message });
    const refresh = vi.spyOn(harness.controller, "refreshActiveOrigin");
    const adapter = createPanelAnnotationSurfaceAdapter({
      controller: harness.controller, getCurrentScopeItemIds: () => ["att_save", "att_cancel"],
      activateOverlay: vi.fn(async () => undefined), copy: vi.fn(async () => ({ copied: true, count: 0, text: "" })),
      createOperationId: () => "operation-1",
      strings: { operationFailed: "operation failed", sessionNotReady: "session not ready", taskNoteSaveFailed: "save failed" },
    });
    await expect(adapter.clear()).rejects.toThrow(message);
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(harness.client.removeItem).toHaveBeenCalledTimes(1);
  });

  test.each(["stale", "navigated"] as const)("stops scoped clear when canonical reconciliation is %s", async (failure) => {
    const harness = createHarness();
    await harness.controller.initialize();
    const oldActive = await harness.client.getActive();
    const originalRemove = harness.client.removeItem.bind(harness.client);
    vi.spyOn(harness.client, "removeItem").mockImplementation(async (...args) => {
      await harness.controller.refreshActiveOrigin();
      const response = await originalRemove(...args);
      const currentActive = await harness.client.getActive();
      if (!currentActive.ok) throw new Error("fixture failed");
      vi.spyOn(harness.client, "getActive").mockResolvedValue(failure === "stale" ? oldActive : {
        ...currentActive,
        data: { ...currentActive.data, activePage: { tabId: 1, frameId: 0, origin: ORIGIN, pathname: "/other-page" } },
      });
      return response;
    });
    const refresh = vi.spyOn(harness.controller, "refreshActiveOrigin");
    const adapter = createPanelAnnotationSurfaceAdapter({
      controller: harness.controller, getCurrentScopeItemIds: () => ["att_save", "att_cancel"],
      activateOverlay: vi.fn(async () => undefined), copy: vi.fn(async () => ({ copied: true, count: 0, text: "" })),
      createOperationId: () => "operation-1",
      strings: { operationFailed: "operation failed", sessionNotReady: "session not ready", taskNoteSaveFailed: "save failed" },
    });
    await expect(adapter.clear()).rejects.toThrow(failure === "stale" ? "operation failed" : "session not ready");
    expect(refresh).toHaveBeenCalledTimes(failure === "stale" ? 4 : 3);
    expect(harness.client.removeItem).toHaveBeenCalledTimes(1);
  });

  test("projects the exact authoritative pending clear pair", async () => {
    const harness = createHarness();
    await harness.controller.initialize();
    const pending = {
      ...harness.controller.getSnapshot(),
      clearPending: true,
      activeClearOperationId: "operation-pending",
    };

    expect(toPanelAnnotationSurfaceReadback(pending).clearStatus).toEqual({
      clearState: "pending",
      operationId: "operation-pending",
    });
  });

  test("projects only the exact active frame scope and replaces a stale foreign selection", async () => {
    const harness = createHarness();
    await harness.controller.initialize();
    const topOne = { ...createCaptureRecord("top-one", "Top one"), tabId: 1, frameId: 0 };
    topOne.pageUrl = `${ORIGIN}/settings`;
    const topTwo = { ...createCaptureRecord("top-two", "Top two"), tabId: 1, frameId: 0 };
    topTwo.pageUrl = `${ORIGIN}/settings`;
    const childOne = { ...createCaptureRecord("child-one", "Child one"), tabId: 1, frameId: 3 };
    childOne.pageUrl = `${ORIGIN}/settings`;
    const snapshot: PanelSessionSnapshot = {
      ...harness.controller.getSnapshot(),
      file: createSessionFile([topOne, topTwo, childOne]),
      activePage: { tabId: 1, frameId: 0, origin: ORIGIN, pathname: "/settings" },
      selectedItemId: "att_child-one",
    };

    expect(toPanelAnnotationSurfaceReadback(snapshot)).toMatchObject({
      items: [
        { itemId: "att_top-one" },
        { itemId: "att_top-two" },
      ],
      activeItemId: "att_top-two",
    });

    expect(toPanelAnnotationSurfaceReadback({
      ...snapshot,
      activePage: {
        tabId: 1,
        frameId: 5,
        documentId: "replacement-child-document",
        origin: ORIGIN,
        pathname: "/settings",
      },
    }, ["att_child-one"])).toMatchObject({
      items: [{ itemId: "att_child-one" }],
      activeItemId: "att_child-one",
    });
  });

  test("rejects an impossible pending snapshot instead of projecting idle", async () => {
    const harness = createHarness();
    await harness.controller.initialize();
    const invalid = {
      ...harness.controller.getSnapshot(),
      clearPending: true,
      activeClearOperationId: null,
    };

    expect(() => toPanelAnnotationSurfaceReadback(invalid)).toThrow(
      "Invalid authoritative clear status.",
    );
  });

  test("accepts the current exact session snapshot including diagnostics authority", async () => {
    const harness = createHarness();
    await harness.controller.initialize();
    const snapshot = harness.controller.getSnapshot();

    expect(Object.hasOwn(snapshot, "metadataDiagnostics")).toBe(true);
    expect(toPanelAnnotationSurfaceReadback(snapshot).clearStatus).toEqual({
      clearState: "idle",
      operationId: null,
    });
  });

  test("rejects a stale snapshot shape that omits diagnostics authority", async () => {
    const harness = createHarness();
    await harness.controller.initialize();
    const { metadataDiagnostics: _metadataDiagnostics, ...staleSnapshot } =
      harness.controller.getSnapshot();

    expect(() => toPanelAnnotationSurfaceReadback(
      staleSnapshot as PanelSessionSnapshot,
    )).toThrow("Invalid authoritative clear status.");
  });

  test.each(MALFORMED_WIDGET_CLEAR_PAIR_CASES)(
    "rejects a non-authoritative clear pair instead of projecting it: %s",
    async (_label, createMalformedSnapshot) => {
      const harness = createHarness();
      await harness.controller.initialize();

      expect(() => toPanelAnnotationSurfaceReadback(
        createMalformedSnapshot(harness.controller.getSnapshot()) as PanelSessionSnapshot,
      )).toThrow("Invalid authoritative clear status.");
    },
  );

  test.each(STRUCTURALLY_INVALID_WIDGET_CLEAR_PAIR_CASES)(
    "rejects a structurally invalid clear pair: %s",
    async (_label, createInvalidSnapshot) => {
      const harness = createHarness();
      await harness.controller.initialize();
      const invalid = createInvalidSnapshot(harness.controller.getSnapshot());

      expect(() => toPanelAnnotationSurfaceReadback(invalid.value)).toThrow(
        "Invalid authoritative clear status.",
      );
      expect(invalid.getterCalls()).toBe(0);
    },
  );

  test("rejects activation unless the authoritative selected item matches", async () => {
    const harness = createHarness();
    await harness.controller.initialize();
    const adapter = createPanelAnnotationSurfaceAdapter({
      controller: harness.controller,
      activateOverlay: vi.fn(async () => undefined),
      copy: vi.fn(async () => ({ copied: true, count: 0, text: "" })),
      createOperationId: () => "operation-1",
      strings: {
        operationFailed: "operation failed",
        sessionNotReady: "session not ready",
        taskNoteSaveFailed: "save failed",
      },
    });

    await expect(adapter.activate("missing-item")).rejects.toThrow("session not ready");
  });

  test("starts copy from the visible snapshot without an async refresh first", async () => {
    const harness = createHarness();
    await harness.controller.initialize();
    harness.client.calls.length = 0;
    let copyStarted = false;
    const copy = vi.fn(() => {
      copyStarted = true;
      return Promise.resolve({ copied: true, count: 2, text: "handoff" });
    });
    const adapter = createPanelAnnotationSurfaceAdapter({
      controller: harness.controller,
      activateOverlay: vi.fn(async () => undefined),
      copy,
      createOperationId: () => "operation-1",
      strings: {
        operationFailed: "operation failed",
        sessionNotReady: "session not ready",
        taskNoteSaveFailed: "save failed",
      },
    });

    const copying = adapter.copy("compact");

    expect(copyStarted).toBe(true);
    expect(harness.client.calls).toEqual([]);
    await expect(copying).resolves.toMatchObject({ text: "handoff" });
    expect(copy).toHaveBeenCalledWith("compact", expect.objectContaining({
      selectedItemId: "att_cancel",
    }));
  });
});

function createHarness() {
  let file = createSessionFile([
    createCaptureRecord("save", "Save changes"),
    createCaptureRecord("cancel", "Cancel"),
  ]);
  const client: PanelSessionClient & { calls: string[] } = {
    calls: [],
    async getActive() {
      client.calls.push("getActive");
      return { ok: true, data: createActiveData(createReadback(file)) };
    },
    async updateIntent(origin, epoch, itemId, intent) {
      client.calls.push(`update:${itemId}:${intent}`);
      file = updateIntent(file, itemId, intent);
      return { ok: true, data: createReadback(file, origin, epoch) };
    },
    async updateAnnotationLifecycle() {
      return {
        ok: false,
        code: "STALE_SESSION",
        error: "Annotation lifecycle is unavailable in the legacy fixture.",
      };
    },
    async removeItem(origin, epoch, itemId) {
      client.calls.push(`remove:${itemId}`);
      file = removeItem(file, itemId);
      return { ok: true, data: createReadback(file, origin, epoch) };
    },
    async clear(origin, epoch, operationId, scope) {
      client.calls.push(scope
        ? `clear:${operationId}:${scope}`
        : `clear:${operationId}`);
      file = emptyFile(origin);
      return { ok: true, data: createReadback(file, origin, epoch ?? "epoch-1") };
    },
  };
  return {
    client,
    controller: createPanelSessionController({
      client,
      setTimeout: (callback, delay) => setTimeout(callback, delay),
      clearTimeout: (id) => clearTimeout(id as ReturnType<typeof setTimeout>),
    }),
  };
}

function createActiveData(readback: ActiveSessionReadback): ActiveSessionCommandData {
  return {
    enabled: true,
    origin: readback.origin,
    activePage: { tabId: 1, frameId: 0, origin: readback.origin, pathname: "/settings" },
    readback,
  };
}

function createReadback(
  file: CaptureSessionFileV1,
  origin = ORIGIN,
  epoch = "epoch-1",
): ActiveSessionReadback {
  return {
    origin,
    epoch,
    clearPending: false,
    activeClearOperationId: null,
    file,
    legacyRecord: file.session.attachments.at(-1)?.sourceRecord as OriginCaptureRecord | null,
  };
}

function updateIntent(
  file: CaptureSessionFileV1,
  itemId: string,
  intent: string,
): CaptureSessionFileV1 {
  return {
    ...file,
    session: {
      ...file.session,
      attachments: file.session.attachments.map((item) => item.id === itemId
        ? { ...item, sourceRecord: { ...item.sourceRecord, intent } }
        : item),
    },
  };
}

function removeItem(file: CaptureSessionFileV1, itemId: string): CaptureSessionFileV1 {
  return {
    ...file,
    session: {
      ...file.session,
      attachments: file.session.attachments.filter((item) => item.id !== itemId),
    },
  };
}

function emptyFile(origin: string): CaptureSessionFileV1 {
  const empty = createSessionFile([]);
  return { ...empty, session: { ...empty.session, origin, attachments: [] } };
}

function createV2SessionFile(records: OriginCaptureRecord[]): CaptureSessionFileV2 {
  const legacyFile = createSessionFile(records);
  return {
    ...legacyFile,
    schemaVersion: "0.2.0",
    session: {
      ...legacyFile.session,
      attachments: legacyFile.session.attachments.map((item, index) => ({
        ...item,
        annotationId: `annotation:${index + 1}`,
        updatedAt: item.createdAt,
      })),
    },
  };
}
