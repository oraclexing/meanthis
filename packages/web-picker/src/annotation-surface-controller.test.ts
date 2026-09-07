import type { AttachmentFeedbackDetail } from "@meanthis/prompt";
import { describe, expect, test, vi } from "vitest";
import {
  createAnnotationSurfaceController,
  formatAnnotationLabel,
  type AnnotationSurfaceAdapter,
  type AnnotationSurfaceItem,
  type AnnotationSurfaceReadback,
} from "./annotation-surface-controller";

interface AdapterHarness {
  adapter: AnnotationSurfaceAdapter;
  calls: string[];
  readback(): AnnotationSurfaceReadback;
}

const adapterFactories = [
  ["memory", createMemoryAdapter],
  ["transport", createTransportAdapter],
] as const;

describe("createAnnotationSurfaceController", () => {
  test.each(adapterFactories)(
    "keeps the annotation action contract identical through the %s adapter",
    async (_name, createAdapter) => {
      const harness = createAdapter();
      const controller = createAnnotationSurfaceController({
        adapter: harness.adapter,
        initialMode: "ready",
        setTimeout: (callback, delay) => globalThis.setTimeout(callback, delay),
        clearTimeout: (id) => globalThis.clearTimeout(id as number),
      });

      controller.applyReadback(harness.readback());
      expect(controller.getSnapshot()).toMatchObject({
        readiness: "hydrating",
        mode: "ready",
        activeItemId: "item-2",
      });
      await expect(controller.edit("item-1")).resolves.toBe(false);
      expect(harness.calls).toEqual([]);

      controller.setReadiness("ready");
      await expect(controller.edit("item-1")).resolves.toBe(true);
      expect(controller.getSnapshot()).toMatchObject({
        mode: "editing",
        activeItemId: "item-1",
        taskNote: "First note",
      });

      controller.setTaskNote("item-1", "Updated note");
      await expect(controller.save("item-1")).resolves.toBe(true);
      expect(controller.getSnapshot()).toMatchObject({
        mode: "details",
        taskNote: "Updated note",
        status: { kind: "success", message: "Task note saved." },
      });

      await expect(controller.more("item-2")).resolves.toBe(true);
      expect(controller.getSnapshot()).toMatchObject({
        mode: "details",
        activeItemId: "item-2",
      });

      await expect(controller.remove("item-2")).resolves.toBe(true);
      expect(controller.getSnapshot().items.map((item) => item.itemId)).toEqual(["item-1"]);
      expect(controller.getSnapshot()).toMatchObject({
        activeItemId: "item-1",
        status: { kind: "success", message: "Annotation removed." },
      });

      await expect(controller.requestClear()).resolves.toBe(false);
      expect(controller.getSnapshot()).toMatchObject({
        clearConfirmationRequired: true,
        items: [{ itemId: "item-1" }],
      });
      await expect(controller.requestClear()).resolves.toBe(true);
      expect(controller.getSnapshot()).toMatchObject({
        mode: "ready",
        activeItemId: null,
        clearConfirmationRequired: false,
        items: [],
        status: { kind: "success", message: "Annotations cleared." },
      });

      expect(harness.calls).toEqual([
        "activate:item-1",
        "stage:item-1:Updated note",
        "save:item-1:Updated note",
        "activate:item-2",
        "remove:item-2",
        "clear",
      ]);
      controller.dispose();
    },
  );

  test("rejects mutation success when authoritative readback does not confirm it", async () => {
    const harness = createMemoryAdapter();
    harness.adapter.remove = async () => harness.readback();
    harness.adapter.clear = async () => harness.readback();
    const controller = readyController(harness.adapter, harness.readback());

    await expect(controller.remove("item-1")).resolves.toBe(false);
    expect(controller.getSnapshot().status).toEqual({
      kind: "error",
      message: "Annotation was not removed. Refresh and try again.",
    });

    await controller.requestClear();
    await expect(controller.requestClear()).resolves.toBe(false);
    expect(controller.getSnapshot().status).toEqual({
      kind: "error",
      message: "Annotations were not cleared. Refresh and try again.",
    });
    expect(controller.getSnapshot().items).toHaveLength(2);
    controller.dispose();
  });

  test("toggles an identified annotation open and resolved from authoritative readback", async () => {
    const harness = createMemoryAdapter({ withLifecycle: true });
    const controller = readyController(harness.adapter, harness.readback());

    await expect(controller.setAnnotationLifecycle("item-1", "resolved")).resolves.toBe(true);
    expect(controller.getSnapshot()).toMatchObject({
      busyAction: null,
      status: { kind: "success", message: "Annotation resolved." },
    });
    expect(controller.getSnapshot().items[0]).toMatchObject({
      itemId: "item-1",
      annotationLifecycle: {
        state: "resolved",
        resolvedAt: expect.any(String),
      },
    });

    await expect(controller.setAnnotationLifecycle("item-1", "open")).resolves.toBe(true);
    expect(controller.getSnapshot()).toMatchObject({
      busyAction: null,
      status: { kind: "success", message: "Annotation reopened." },
    });
    expect(controller.getSnapshot().items[0]).toMatchObject({
      itemId: "item-1",
      annotationLifecycle: { state: "open", resolvedAt: null },
    });
    expect(harness.calls).toEqual(["lifecycle:item-1:resolved", "lifecycle:item-1:open"]);
    controller.dispose();
  });

  test.each([
    ["stale state", (harness: AdapterHarness) => harness.readback()],
    ["missing item", (harness: AdapterHarness): AnnotationSurfaceReadback => ({
      items: harness.readback().items.filter((item) => item.itemId !== "item-1"),
      activeItemId: "item-2",
    })],
    ["malformed lifecycle", (harness: AdapterHarness): AnnotationSurfaceReadback => ({
      items: harness.readback().items.map((item) => item.itemId === "item-1"
        ? { ...item, annotationLifecycle: { state: "resolved", resolvedAt: null } }
        : item),
      activeItemId: "item-1",
    })],
  ])("rejects lifecycle success when authoritative readback has %s", async (_name, readback) => {
    const harness = createMemoryAdapter({ withLifecycle: true });
    harness.adapter.setAnnotationLifecycle = vi.fn(async () => readback(harness));
    const controller = readyController(harness.adapter, harness.readback());

    await expect(controller.setAnnotationLifecycle("item-1", "resolved")).resolves.toBe(false);
    expect(controller.getSnapshot()).toMatchObject({
      busyAction: null,
      status: {
        kind: "error",
        message: "Annotation state was not updated. Refresh and try again.",
      },
    });
    expect(controller.getSnapshot().items[0]).toMatchObject({
      annotationLifecycle: { state: "open", resolvedAt: null },
    });
    expect(harness.adapter.setAnnotationLifecycle).toHaveBeenCalledWith("item-1", "resolved");
    controller.dispose();
  });

  test("does not call a lifecycle adapter for legacy annotations without identity", async () => {
    const harness = createMemoryAdapter();
    const setAnnotationLifecycle = vi.fn(async () => harness.readback());
    harness.adapter.setAnnotationLifecycle = setAnnotationLifecycle;
    const controller = readyController(harness.adapter, harness.readback());

    await expect(controller.setAnnotationLifecycle("item-1", "resolved")).resolves.toBe(false);
    expect(setAnnotationLifecycle).not.toHaveBeenCalled();
    expect(controller.getSnapshot().status).toBeNull();
    controller.dispose();
  });

  test("exposes lifecycle as an independent busy action while its mutation is pending", async () => {
    const harness = createMemoryAdapter({ withLifecycle: true });
    let release!: (readback: AnnotationSurfaceReadback) => void;
    harness.adapter.setAnnotationLifecycle = vi.fn(() => new Promise<AnnotationSurfaceReadback>((resolve) => {
      release = resolve;
    }));
    const controller = readyController(harness.adapter, harness.readback());

    const pending = controller.setAnnotationLifecycle("item-1", "resolved");
    expect(controller.getSnapshot().busyAction).toBe("lifecycle");
    release({
      ...harness.readback(),
      items: harness.readback().items.map((item) => item.itemId === "item-1"
        ? { ...item, annotationLifecycle: { state: "resolved", resolvedAt: "2026-08-31T00:00:00.000Z" } }
        : item),
    });
    await expect(pending).resolves.toBe(true);
    expect(controller.getSnapshot().busyAction).toBeNull();
    controller.dispose();
  });

  test("keeps a zero-item pending clear retryable until the same operation reaches idle", async () => {
    const harness = createMemoryAdapter();
    let clearAttempt = 0;
    harness.adapter.clear = vi.fn(async (
      operationId?: string,
    ): Promise<AnnotationSurfaceReadback> => {
      clearAttempt += 1;
      if (clearAttempt === 1) {
        expect(operationId).toBeUndefined();
        return {
          items: [],
          activeItemId: null,
          clearStatus: { clearState: "pending", operationId: "clear-op-1" },
        };
      }
      expect(operationId).toBe("clear-op-1");
      return {
        items: [],
        activeItemId: null,
        clearStatus: { clearState: "idle", operationId: null },
      };
    });
    const controller = readyController(harness.adapter, {
      items: [harness.readback().items[0]!],
      activeItemId: "item-1",
    });

    await expect(controller.requestClear()).resolves.toBe(false);
    await expect(controller.requestClear()).resolves.toBe(false);
    expect(controller.getSnapshot()).toMatchObject({
      items: [],
      clearConfirmationRequired: false,
      clearStatus: { clearState: "pending", operationId: "clear-op-1" },
      status: {
        kind: "info",
        message: "Clearing page annotations is still pending. Retry to confirm completion.",
      },
    });

    await expect(controller.requestClear()).resolves.toBe(true);
    expect(harness.adapter.clear).toHaveBeenNthCalledWith(1, undefined);
    expect(harness.adapter.clear).toHaveBeenNthCalledWith(2, "clear-op-1");
    expect(controller.getSnapshot()).toMatchObject({
      items: [],
      clearStatus: { clearState: "idle", operationId: null },
      status: { kind: "success", message: "Annotations cleared." },
    });
    controller.dispose();
  });

  test("normalizes omitted clear status to legacy immediate completion and clones pending ids", async () => {
    const harness = createMemoryAdapter();
    const clear = vi.fn(async () => ({ items: [], activeItemId: null }));
    harness.adapter.clear = clear;
    const pending = {
      items: [],
      activeItemId: null,
      clearStatus: { clearState: "pending", operationId: "clear-op-cloned" },
    } as const;
    const controller = readyController(harness.adapter, pending);

    (pending.clearStatus as { operationId: string }).operationId = "mutated-after-apply";
    expect(controller.getSnapshot().clearStatus).toEqual({
      clearState: "pending",
      operationId: "clear-op-cloned",
    });
    await expect(controller.requestClear()).resolves.toBe(true);
    expect(clear).toHaveBeenCalledWith("clear-op-cloned");
    expect(controller.getSnapshot().clearStatus).toEqual({
      clearState: "idle",
      operationId: null,
    });
    controller.dispose();
  });

  test("rejects inherited or extra-key pending clear states before retrying", async () => {
    const harness = createMemoryAdapter();
    const clear = vi.fn(async () => ({ items: [], activeItemId: null }));
    harness.adapter.clear = clear;
    const inheritedPending = Object.create({
      clearState: "pending",
      operationId: "inherited-operation",
    }) as AnnotationSurfaceReadback["clearStatus"];
    const controller = readyController(harness.adapter, {
      items: [],
      activeItemId: null,
      clearStatus: inheritedPending,
    });

    expect(controller.getSnapshot().clearStatus).toEqual({
      clearState: "idle",
      operationId: null,
    });
    await expect(controller.requestClear()).resolves.toBe(false);
    expect(clear).not.toHaveBeenCalled();

    controller.applyReadback({
      items: [],
      activeItemId: null,
      clearStatus: {
        clearState: "pending",
        operationId: "operation-with-extra-key",
        extra: true,
      } as unknown as AnnotationSurfaceReadback["clearStatus"],
    });
    expect(controller.getSnapshot().clearStatus).toEqual({
      clearState: "idle",
      operationId: null,
    });
    controller.dispose();
  });

  test("saves a non-active inline marker without changing the durable active item or mode", async () => {
    const harness = createMemoryAdapter();
    const savedReadback: AnnotationSurfaceReadback = {
      ...harness.readback(),
      // The adapter is permitted to report the mutated item as active. Inline
      // editing deliberately preserves the caller's durable panel selection.
      activeItemId: "item-1",
      items: harness.readback().items.map((item) => item.itemId === "item-1"
        ? { ...item, taskNote: "Inline note" }
        : item),
    };
    harness.adapter.saveTaskNote = vi.fn(async () => savedReadback);
    const controller = readyController(harness.adapter, harness.readback());
    controller.setMode("selecting");

    await expect(controller.saveInline("item-1", "Inline note")).resolves.toBe(true);
    expect(harness.adapter.saveTaskNote).toHaveBeenCalledWith("item-1", "Inline note");
    expect(controller.getSnapshot()).toMatchObject({
      activeItemId: "item-2",
      mode: "selecting",
    });
    expect(controller.getSnapshot().items).toContainEqual(
      expect.objectContaining({ itemId: "item-1", taskNote: "Inline note" }),
    );
    controller.dispose();
  });

  test("keeps the non-active inline marker and durable selection unchanged when save fails", async () => {
    const harness = createMemoryAdapter();
    harness.adapter.saveTaskNote = vi.fn(async () => {
      throw new Error("offline");
    });
    const controller = readyController(harness.adapter, harness.readback());
    controller.setMode("selecting");

    await expect(controller.saveInline("item-1", "Inline note")).resolves.toBe(false);
    expect(controller.getSnapshot()).toMatchObject({
      activeItemId: "item-2",
      mode: "selecting",
    });
    expect(controller.getSnapshot().items).toContainEqual(
      expect.objectContaining({ itemId: "item-1", taskNote: "First note" }),
    );
    controller.dispose();
  });

  test("fences a deferred save after an imperative cancellation", async () => {
    const harness = createMemoryAdapter();
    let releaseSave!: (readback: AnnotationSurfaceReadback) => void;
    harness.adapter.saveTaskNote = vi.fn(() => new Promise<AnnotationSurfaceReadback>((resolve) => {
      releaseSave = resolve;
    }));
    const controller = readyController(harness.adapter, harness.readback());
    const staleReadback = harness.readback();

    const saving = controller.save("item-2");
    expect(controller.getSnapshot().busyAction).toBe("save");
    controller.cancelPendingAction();
    controller.applyReadback({ items: [], activeItemId: null });
    releaseSave(staleReadback);

    await expect(saving).resolves.toBe(false);
    expect(controller.getSnapshot()).toMatchObject({
      items: [],
      activeItemId: null,
      busyAction: null,
      status: null,
    });
    controller.dispose();
  });

  test("gates copy on readiness and owns the manual-copy fallback", async () => {
    const harness = createMemoryAdapter();
    harness.adapter.copy = vi.fn(async (detail: AttachmentFeedbackDetail) => ({
      copied: false,
      count: 2,
      text: `handoff:${detail}`,
    }));
    const controller = createAnnotationSurfaceController({
      adapter: harness.adapter,
      initialMode: "ready",
    });
    controller.applyReadback(harness.readback());

    await expect(controller.copy()).resolves.toBeNull();
    expect(harness.adapter.copy).not.toHaveBeenCalled();

    controller.setReadiness("ready");
    controller.setOutputDetail("standard");
    await expect(controller.copy()).resolves.toBe("handoff:standard");
    expect(controller.getSnapshot()).toMatchObject({
      mode: "ready",
      manualCopyText: "handoff:standard",
      status: { kind: "error", message: "Copy was blocked. Copy the text manually." },
    });
    controller.dispose();
  });

  test("stops selection only when a confirmed clear is about to mutate", async () => {
    const harness = createMemoryAdapter();
    const clear = harness.adapter.clear.bind(harness.adapter);
    const order: string[] = [];
    harness.adapter.clear = async () => {
      order.push("clear");
      return clear();
    };
    const controller = createAnnotationSurfaceController({
      adapter: harness.adapter,
      initialMode: "selecting",
      initialReadiness: "ready",
      beforeClear: async () => {
        order.push("stop-selection");
      },
    });
    controller.applyReadback(harness.readback());

    await expect(controller.requestClear()).resolves.toBe(false);
    expect(order).toEqual([]);

    await expect(controller.requestClear()).resolves.toBe(true);
    expect(order).toEqual(["stop-selection", "clear"]);
    expect(controller.getSnapshot()).toMatchObject({ mode: "ready", items: [] });
    controller.dispose();
  });

  test("expires clear confirmation without mutating the adapter", async () => {
    vi.useFakeTimers();
    try {
      const harness = createMemoryAdapter();
      const controller = readyController(harness.adapter, harness.readback());

      await controller.requestClear();
      expect(controller.getSnapshot().clearConfirmationRequired).toBe(true);
      vi.advanceTimersByTime(4_000);

      expect(controller.getSnapshot().clearConfirmationRequired).toBe(false);
      expect(harness.calls).not.toContain("clear");
      expect(controller.getSnapshot().items).toHaveLength(2);
      controller.dispose();
    } finally {
      vi.useRealTimers();
    }
  });

  test("formats the shared page annotation label contract", () => {
    expect([0, 1, 2, 25].map(formatAnnotationLabel)).toEqual(["1", "2", "3", "26"]);
    expect(() => formatAnnotationLabel(-1)).toThrow();
    expect(() => formatAnnotationLabel(26)).toThrow();
  });
});

function readyController(adapter: AnnotationSurfaceAdapter, readback: AnnotationSurfaceReadback) {
  const controller = createAnnotationSurfaceController({
    adapter,
    initialMode: "ready",
    setTimeout: (callback, delay) => globalThis.setTimeout(callback, delay),
    clearTimeout: (id) => globalThis.clearTimeout(id as number),
  });
  controller.applyReadback(readback);
  controller.setReadiness("ready");
  return controller;
}

function createMemoryAdapter(options: { withLifecycle?: boolean } = {}): AdapterHarness {
  let items: AnnotationSurfaceItem[] = [
    {
      itemId: "item-1",
      label: "1",
      name: "Target A",
      taskNote: "First note",
      ...(options.withLifecycle
        ? { annotationLifecycle: { state: "open" as const, resolvedAt: null } }
        : {}),
    },
    {
      itemId: "item-2",
      label: "2",
      name: "Target B",
      taskNote: "Second note",
      ...(options.withLifecycle
        ? { annotationLifecycle: { state: "open" as const, resolvedAt: null } }
        : {}),
    },
  ];
  let activeItemId: string | null = "item-2";
  const calls: string[] = [];
  const readback = (): AnnotationSurfaceReadback => ({
    items: items.map((item) => ({ ...item })),
    activeItemId,
  });
  const adapter: AnnotationSurfaceAdapter = {
    async activate(itemId) {
      calls.push(`activate:${itemId}`);
      activeItemId = itemId;
      return readback();
    },
    stageTaskNote(itemId, note) {
      calls.push(`stage:${itemId}:${note}`);
      items = items.map((item) => item.itemId === itemId ? { ...item, taskNote: note } : item);
    },
    async saveTaskNote(itemId, note) {
      calls.push(`save:${itemId}:${note}`);
      return readback();
    },
    async remove(itemId) {
      calls.push(`remove:${itemId}`);
      items = items.filter((item) => item.itemId !== itemId);
      activeItemId = items[0]?.itemId ?? null;
      return readback();
    },
    async clear() {
      calls.push("clear");
      items = [];
      activeItemId = null;
      return readback();
    },
    async setAnnotationLifecycle(itemId, nextState) {
      calls.push(`lifecycle:${itemId}:${nextState}`);
      const item = items.find((candidate) => candidate.itemId === itemId);
      if (!item?.annotationLifecycle) throw new Error("Annotation lifecycle unavailable.");
      item.annotationLifecycle = nextState === "resolved"
        ? { state: "resolved", resolvedAt: "2026-08-31T00:00:00.000Z" }
        : { state: "open", resolvedAt: null };
      return readback();
    },
    async copy(detail) {
      return { copied: true, count: items.length, text: `handoff:${detail}` };
    },
  };
  return { adapter, calls, readback };
}

function createTransportAdapter(): AdapterHarness {
  const memory = createMemoryAdapter();
  const defer = async <T>(action: () => T | Promise<T>): Promise<T> => {
    await Promise.resolve();
    return action();
  };
  return {
    ...memory,
    adapter: {
      activate: (itemId) => defer(() => memory.adapter.activate(itemId)),
      stageTaskNote: (itemId, note) => memory.adapter.stageTaskNote(itemId, note),
      saveTaskNote: (itemId, note) => defer(() => memory.adapter.saveTaskNote(itemId, note)),
      remove: (itemId) => defer(() => memory.adapter.remove(itemId)),
      clear: () => defer(() => memory.adapter.clear()),
      copy: (detail) => defer(() => memory.adapter.copy(detail)),
    },
  };
}
