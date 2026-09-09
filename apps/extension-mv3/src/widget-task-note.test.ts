import { afterEach, expect, test, vi } from "vitest";
import type { CaptureSessionFile, CaptureSessionFileV3 } from "@meanthis/hub-core";
import { createAnnotationSurfaceController } from "@meanthis/web-picker";
import { createCaptureRecord, createSessionFile } from "../test/session-fixtures";
import type { OriginCaptureRecord } from "./capture-store";
import type { SessionCommandResponse } from "./messages";
import { buildPanelAgentCopy } from "./panel-model";
import { createPanelSessionController, type PanelSessionClient } from "./panel-session-controller";
import type { ActiveSessionReadback } from "./session-store";
import { createPanelAnnotationSurfaceAdapter, toPanelAnnotationSurfaceReadback } from "./widget-annotation-adapter";

afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
});

test.each(["legacy", "current"] as const)("%s task-note draft survives autosave notifications and continued typing", async (version) => {
  const harness = await createHarness(version);
  try {
    const { controller, surface, pending, itemId } = harness;
    expect(surface.setTaskNote(itemId, "ABxCDEy")).toBe(true);
    await vi.advanceTimersByTimeAsync(250);

    expect(pending[0].intent).toBe("ABxCDEy");
    expect(controller.getSnapshot().intent).toBe("ABxCDEy");
    expect(surface.getSnapshot().taskNote).toBe("ABxCDEy");
    expect(harness.storedNote()).toBe("ABCDE");

    surface.setTaskNote(itemId, `${surface.getSnapshot().taskNote}Z`);
    pending[0].succeed();
    await vi.advanceTimersByTimeAsync(250);
    expect(surface.getSnapshot().taskNote).toBe("ABxCDEyZ");
    expect(pending[1].intent).toBe("ABxCDEyZ");

    pending[1].succeed();
    await vi.advanceTimersByTimeAsync(0);
    expect(controller.getSnapshot()).toMatchObject({ intent: "ABxCDEyZ", intentDirty: false });
    expect(surface.getSnapshot().taskNote).toBe("ABxCDEyZ");
    expect(harness.storedNote()).toBe("ABxCDEyZ");
    expect(await surface.copy()).toContain("ABxCDEyZ");
  } finally {
    harness.dispose();
  }
});

test.each(["legacy", "current"] as const)("%s task-note draft remains available after a failed autosave and an explicit retry", async (version) => {
  const harness = await createHarness(version);
  try {
    const { controller, surface, pending, itemId } = harness;
    surface.setTaskNote(itemId, "Keep this unsaved note");
    await vi.advanceTimersByTimeAsync(250);
    pending[0].fail();
    await vi.advanceTimersByTimeAsync(0);

    expect(controller.getSnapshot()).toMatchObject({
      intent: "Keep this unsaved note",
      intentDirty: true,
      status: { kind: "error" },
    });
    expect(surface.getSnapshot().taskNote).toBe("Keep this unsaved note");
    expect(harness.storedNote()).toBe("ABCDE");

    const retry = surface.save(itemId);
    expect(pending[1].intent).toBe("Keep this unsaved note");
    pending[1].succeed();
    await expect(retry).resolves.toBe(true);
    expect(harness.storedNote()).toBe("Keep this unsaved note");
    expect(controller.getSnapshot().intentDirty).toBe(false);
    expect(await surface.copy()).toContain("Keep this unsaved note");
  } finally {
    harness.dispose();
  }
});

test("a dirty task note never becomes another item's note when the visible scope changes", async () => {
  const harness = await createHarness("current");
  try {
    harness.surface.setTaskNote(harness.itemId, "Only belongs to the selected item");
    const before = harness.controller.getSnapshot();
    const other = createCaptureRecord("cancel", "Cancel");
    other.intent = "Other saved note";
    const nextFile = createVersionedFile("current", [createCaptureRecord("save", "Save changes"), other]);
    const projected = toPanelAnnotationSurfaceReadback({ ...before, file: nextFile }, ["att_cancel"]);
    expect(projected.activeItemId).toBe("att_cancel");
    expect(projected.items).toEqual([expect.objectContaining({ itemId: "att_cancel", taskNote: "Other saved note" })]);
    expect(nextFile.session.attachments[0].sourceRecord.intent).not.toBe(before.intent);
  } finally {
    harness.dispose();
  }
});

function createVersionedFile(version: "legacy" | "current", records: OriginCaptureRecord[]): CaptureSessionFile {
  const legacy = createSessionFile(records);
  if (version === "legacy") return legacy;
  return {
    ...legacy,
    schemaVersion: "0.3.0",
    session: {
      ...legacy.session,
      attachments: legacy.session.attachments.map((item, index) => ({
        ...item,
        annotationId: `annotation:${index + 1}`,
        updatedAt: item.createdAt,
        annotationLifecycle: { state: "open", resolvedAt: null },
      })),
    },
  } satisfies CaptureSessionFileV3;
}

async function createHarness(version: "legacy" | "current") {
  vi.useFakeTimers();
  const origin = "https://app.example.test";
  const record = createCaptureRecord("save", "Save changes");
  record.intent = "ABCDE";
  let file = createVersionedFile(version, [record]);
  const readback = (): ActiveSessionReadback => ({
    origin, epoch: "epoch-1", clearPending: false, activeClearOperationId: null, file,
    legacyRecord: file.session.attachments[0].sourceRecord as OriginCaptureRecord,
  });
  const pending: Array<{ intent: string; succeed(): void; fail(): void }> = [];
  const unsupported = async () => ({ ok: false as const, code: "RUNTIME_ERROR" as const, error: "Unexpected command." });
  const client: PanelSessionClient = {
    getActive: async () => ({
      ok: true,
      data: { enabled: true, origin, activePage: { tabId: 1, frameId: 0, origin, pathname: "/settings" }, readback: readback() },
    }),
    updateIntent: async (_origin, _epoch, itemId, intent) => new Promise<SessionCommandResponse<ActiveSessionReadback>>((resolve) => {
      pending.push({
        intent,
        succeed() {
          file = {
            ...file,
            session: {
              ...file.session,
              attachments: file.session.attachments.map((item) => item.id === itemId
                ? { ...item, sourceRecord: { ...item.sourceRecord, intent } }
                : item),
            },
          } as CaptureSessionFile;
          resolve({ ok: true, data: readback() });
        },
        fail() { resolve({ ok: false, code: "RUNTIME_ERROR", error: "Storage unavailable." }); },
      });
    }),
    updateAnnotationLifecycle: unsupported,
    removeItem: unsupported,
    clear: unsupported,
  };
  const controller = createPanelSessionController({
    client,
    setTimeout: (callback, delay) => setTimeout(callback, delay),
    clearTimeout: (id) => clearTimeout(id as ReturnType<typeof setTimeout>),
  });
  const adapter = createPanelAnnotationSurfaceAdapter({
    controller,
    activateOverlay: async () => undefined,
    copy: async (detail, snapshot) => {
      const result = buildPanelAgentCopy({
        file: snapshot.file,
        attachmentIds: snapshot.selectedItemId ? [snapshot.selectedItemId] : [],
        selectedItemId: snapshot.selectedItemId,
        selectedRecord: snapshot.legacyRecord,
        viewMode: "agent_safe",
        intent: snapshot.intent,
        outputDetail: detail,
      });
      if (!result.ok) throw new Error(result.error);
      return { text: result.text, copied: true, count: result.attachmentCount };
    },
    createOperationId: () => "operation-test",
    strings: { operationFailed: "Failed.", sessionNotReady: "Not ready.", taskNoteSaveFailed: "Save failed." },
  });
  const surface = createAnnotationSurfaceController({ adapter, initialReadiness: "ready", initialMode: "editing" });
  // Match the production entry's subscription; controller-only tests miss this projection.
  const stop = controller.subscribe((snapshot) => surface.applyReadback(toPanelAnnotationSurfaceReadback(snapshot)));
  await controller.initialize();
  return {
    controller, surface, pending,
    itemId: controller.getSnapshot().selectedItemId!,
    storedNote: () => file.session.attachments[0].sourceRecord.intent,
    dispose() { stop(); surface.dispose(); },
  };
}
