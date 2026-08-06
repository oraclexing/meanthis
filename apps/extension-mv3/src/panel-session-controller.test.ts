import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { CaptureSessionFileV1 } from "@meanthis/hub-core";
import type { ActiveSessionCommandData, SessionCommandResponse } from "./messages";
import type { OriginCaptureRecord } from "./capture-store";
import type { ActiveSessionReadback } from "./session-store";
import {
  createCaptureRecord,
  createSessionFile,
} from "../test/session-fixtures";
import {
  createPanelSessionController,
  type PanelSessionClient,
} from "./panel-session-controller";

const ORIGIN = "https://app.example.test";
const OTHER_ORIGIN = "https://other.example.test";
const THIRD_ORIGIN = "https://third.example.test";

describe("panel session controller intent and recovery", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  test("debounces intent writes at exactly 250ms and emits deterministic snapshots", async () => {
    const harness = createControllerHarness();
    const snapshots: string[] = [];
    harness.controller.subscribe((snapshot) => {
      snapshots.push(`${snapshot.status.kind}:${snapshot.selectedItemId}:${snapshot.intentDirty}`);
    });

    await harness.controller.initialize();
    harness.controller.setIntent("Explain cancel");
    await vi.advanceTimersByTimeAsync(249);
    expect(harness.client.calls).toEqual(["getActive"]);

    await vi.advanceTimersByTimeAsync(1);

    expect(harness.client.calls).toEqual([
      "getActive",
      "update:https://app.example.test:epoch-1:att_cancel:Explain cancel",
    ]);
    expect(harness.controller.getSnapshot()).toMatchObject({
      selectedItemId: "att_cancel",
      intent: "Explain cancel",
      intentDirty: false,
      status: { kind: "success", message: "Intent saved." },
    });
    expect(snapshots[0]).toBe("empty:null:false");
    expect(snapshots.at(-1)).toBe("success:att_cancel:false");
  });

  test("carries active page identity and initially selects its latest capture", async () => {
    const harness = createControllerHarness();
    const other = { ...createCaptureRecord("other", "Other page"), tabId: 1, frameId: 0 };
    other.pageUrl = `${ORIGIN}/other`;
    harness.file = createSessionFile([
      createCaptureRecord("save", "Save changes"),
      createCaptureRecord("cancel", "Cancel"),
      other,
    ]);
    harness.queueActive(createActiveData(
      createReadback(harness.file),
      { tabId: 1, frameId: 0, origin: ORIGIN, pathname: "/settings" },
    ));

    await harness.controller.initialize();

    expect(harness.controller.getSnapshot()).toMatchObject({
      activePage: { tabId: 1, frameId: 0, origin: ORIGIN, pathname: "/settings" },
      selectedItemId: "att_cancel",
    });
  });

  test("selection and export flush dirty intent first, and failed flush blocks both", async () => {
    const harness = createControllerHarness();
    await harness.controller.initialize();

    harness.controller.setIntent("Needs save");
    harness.client.updateIntent = vi.fn(async () => ({
      ok: false,
      code: "STORAGE_ERROR",
      error: "write failed",
    }));

    await harness.controller.selectItem("att_save");
    const exported = await harness.controller.readExport();

    expect(harness.client.updateIntent).toHaveBeenCalledTimes(2);
    expect(harness.controller.getSnapshot()).toMatchObject({
      selectedItemId: "att_cancel",
      intentDirty: true,
      status: { kind: "error", message: "write failed" },
    });
    expect(exported).toEqual({
      ok: false,
      code: "INVALID_SESSION_FILE",
      error: "write failed",
    });
    expect(harness.client.calls).toEqual(["getActive"]);
  });

  test("in-flight autosave response never overwrites a newer local intent", async () => {
    const harness = createControllerHarness();
    await harness.controller.initialize();
    const save = createDeferred<SessionCommandResponse<ActiveSessionReadback>>();
    harness.client.updateIntent = vi.fn(async (origin, epoch, itemId, intent) => {
      harness.client.calls.push(`update:${origin}:${epoch}:${itemId}:${intent}`);
      return save.promise;
    });

    harness.controller.setIntent("First draft");
    await vi.advanceTimersByTimeAsync(250);
    harness.controller.setIntent("Newer draft");
    save.resolve({
      ok: true,
      data: createReadback(updateIntentInFile(harness.file, "att_cancel", "First draft")),
    });
    await flushMicrotasks();

    expect(harness.controller.getSnapshot()).toMatchObject({
      selectedItemId: "att_cancel",
      intent: "Newer draft",
      intentDirty: true,
    });
  });

  test("readExport fails safely when an in-flight save resolves after a newer edit", async () => {
    const harness = createControllerHarness();
    await harness.controller.initialize();
    const save = createDeferred<SessionCommandResponse<ActiveSessionReadback>>();
    harness.client.updateIntent = vi.fn(async (origin, epoch, itemId, intent) => {
      harness.client.calls.push(`update:${origin}:${epoch}:${itemId}:${intent}`);
      return save.promise;
    });

    harness.controller.setIntent("Export me");
    const exported = harness.controller.readExport();
    harness.controller.setIntent("Do not overwrite me");
    save.resolve({
      ok: true,
      data: createReadback(updateIntentInFile(harness.file, "att_cancel", "Export me")),
    });
    const result = await exported;

    expect(result).toEqual({
      ok: false,
      code: "INVALID_SESSION_FILE",
      error: "Intent changed before export. Save again and retry.",
    });
    expect(harness.controller.getSnapshot()).toMatchObject({
      intent: "Do not overwrite me",
      intentDirty: true,
    });
  });

  test("active-origin change keeps old origin and item in recovery until retry or discard", async () => {
    const harness = createControllerHarness();
    await harness.controller.initialize();
    harness.controller.setIntent("Old intent");
    harness.client.updateIntent = vi.fn(async (origin, epoch, itemId, intent) => {
      harness.client.calls.push(`update:${origin}:${epoch}:${itemId}:${intent}`);
      return { ok: false, code: "STORAGE_ERROR", error: "offline" };
    });
    harness.queueActive(createActiveData(createReadback(createSessionFile([
      createCaptureRecord("other", "Other"),
    ]), OTHER_ORIGIN)));

    await harness.controller.refreshActiveOrigin();

    expect(harness.controller.getSnapshot()).toMatchObject({
      origin: ORIGIN,
      selectedItemId: "att_cancel",
      recovery: {
        oldOrigin: ORIGIN,
        oldEpoch: "epoch-1",
        itemId: "att_cancel",
        intent: "Old intent",
        pendingOrigin: OTHER_ORIGIN,
      },
    });
    await harness.controller.selectItem("att_save");
    expect(harness.controller.getSnapshot().selectedItemId).toBe("att_cancel");

    harness.client.updateIntent = vi.fn(async (origin, epoch, itemId, intent) => {
      harness.client.calls.push(`retry:${origin}:${epoch}:${itemId}:${intent}`);
      return { ok: true, data: createReadback(harness.file) };
    });
    harness.queueActive(createActiveData(createReadback(createSessionFile([
      createCaptureRecord("other", "Other"),
    ]), OTHER_ORIGIN)));
    await harness.controller.retryDirtyIntent();

    expect(harness.client.calls).toContain(
      "retry:https://app.example.test:epoch-1:att_cancel:Old intent",
    );
    expect(harness.controller.getSnapshot()).toMatchObject({
      origin: OTHER_ORIGIN,
      selectedItemId: "att_other",
      recovery: null,
    });

    harness.controller.setIntent("Discard me");
    harness.client.updateIntent = vi.fn(async () => ({
      ok: false,
      code: "STORAGE_ERROR",
      error: "offline",
    }));
    harness.queueActive(createActiveData(createReadback(harness.file, OTHER_ORIGIN)));
    await harness.controller.refreshActiveOrigin();
    harness.queueActive(createActiveData(createReadback(harness.file, OTHER_ORIGIN)));
    await harness.controller.discardDirtyIntent();
    expect(harness.controller.getSnapshot().recovery).toBeNull();
  });

  test("discard recovery refuses to jump to a fresh third origin", async () => {
    const harness = createControllerHarness();
    await harness.controller.initialize();
    harness.controller.setIntent("Old intent");
    harness.client.updateIntent = vi.fn(async () => ({
      ok: false,
      code: "STORAGE_ERROR",
      error: "offline",
    }));
    harness.queueActive(createActiveData(createReadback(createSessionFile([
      createCaptureRecord("other", "Other"),
    ]), OTHER_ORIGIN)));
    await harness.controller.refreshActiveOrigin();

    harness.queueActive(createActiveData(createReadback(createSessionFile([
      createCaptureRecord("third", "Third"),
    ]), THIRD_ORIGIN)));
    await harness.controller.discardDirtyIntent();

    expect(harness.controller.getSnapshot()).toMatchObject({
      origin: ORIGIN,
      recovery: {
        oldOrigin: ORIGIN,
        pendingOrigin: OTHER_ORIGIN,
      },
      status: {
        kind: "error",
        message: "Active origin changed again. Refresh before discarding the recovered intent.",
      },
    });
  });
});

describe("panel session controller mutations and export readbacks", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  test("refresh cancels pending debounce before awaiting active readback", async () => {
    const harness = createControllerHarness();
    await harness.controller.initialize();
    const active = createDeferred<SessionCommandResponse<ActiveSessionCommandData>>();
    harness.client.getActive = vi.fn(async () => {
      harness.client.calls.push("getActive:deferred");
      return active.promise;
    });
    harness.client.updateIntent = vi.fn(async (origin, epoch, itemId, intent) => {
      harness.client.calls.push(`update:${origin}:${epoch}:${itemId}:${intent}`);
      return { ok: true, data: createReadback(harness.file) };
    });

    harness.controller.setIntent("Pending debounce");
    const refresh = harness.controller.refreshActiveOrigin();
    await vi.advanceTimersByTimeAsync(250);

    expect(harness.client.calls).not.toContain(
      "update:https://app.example.test:epoch-1:att_cancel:Pending debounce",
    );
    active.resolve({ ok: true, data: createActiveData(createReadback(harness.file)) });
    await refresh;
  });

  test("two refreshes resolving out of order only apply the latest request", async () => {
    const harness = createControllerHarness();
    await harness.controller.initialize();
    const first = createDeferred<SessionCommandResponse<ActiveSessionCommandData>>();
    const second = createDeferred<SessionCommandResponse<ActiveSessionCommandData>>();
    const readbacks = [first, second];
    harness.client.getActive = vi.fn(async () => {
      harness.client.calls.push("getActive:deferred");
      const next = readbacks.shift();
      if (!next) throw new Error("unexpected getActive");
      return next.promise;
    });

    const firstRefresh = harness.controller.refreshActiveOrigin();
    const secondRefresh = harness.controller.refreshActiveOrigin();
    second.resolve({
      ok: true,
      data: createActiveData(createReadback(createSessionFile([
        createCaptureRecord("other", "Other"),
      ]), OTHER_ORIGIN)),
    });
    await secondRefresh;
    first.resolve({ ok: true, data: createActiveData(createReadback(harness.file, ORIGIN)) });
    await firstRefresh;

    expect(harness.controller.getSnapshot()).toMatchObject({
      origin: OTHER_ORIGIN,
      selectedItemId: "att_other",
    });
  });

  test("same-page refresh preserves an explicit selection", async () => {
    const harness = createControllerHarness();
    await harness.controller.initialize();
    await harness.controller.selectItem("att_save");
    harness.queueActive(createActiveData(
      createReadback(harness.file),
      { tabId: 1, frameId: 0, origin: ORIGIN, pathname: "/settings" },
    ));

    await harness.controller.refreshActiveOrigin();

    expect(harness.controller.getSnapshot()).toMatchObject({
      activePage: { tabId: 1, frameId: 0, origin: ORIGIN, pathname: "/settings" },
      selectedItemId: "att_save",
    });
  });

  test("initialization restores the background-owned active overlay selection", async () => {
    const harness = createControllerHarness();
    harness.queueActive({
      ...createActiveData(createReadback(harness.file)),
      selectedItemId: "att_save",
    });

    await harness.controller.initialize();

    expect(harness.controller.getSnapshot()).toMatchObject({
      selectedItemId: "att_save",
      intent: "Update Save changes",
    });
  });

  test("returning to an embedded page restores its last explicit selection", async () => {
    const harness = createControllerHarness();
    const restoredFrameFile = createSessionFile([
      { ...createCaptureRecord("a", "Edit screens"), tabId: 1, frameId: 2 },
      { ...createCaptureRecord("b", "List design systems"), tabId: 1, frameId: 2 },
      { ...createCaptureRecord("c", "Project Management"), tabId: 1, frameId: 2 },
      { ...createCaptureRecord("d", "Get project"), tabId: 1, frameId: 2 },
    ]);
    const framePage = {
      tabId: 7,
      frameId: 2,
      origin: ORIGIN,
      pathname: "/settings",
      documentId: "frame-document-1",
    };
    harness.file = restoredFrameFile;
    harness.queueActive(createActiveData(createReadback(restoredFrameFile), framePage));
    await harness.controller.initialize();
    await harness.controller.selectItem("att_b");

    const otherFile = createSessionFile([createCaptureRecord("other", "Other")]);
    harness.queueActive(createActiveData(
      createReadback(otherFile, OTHER_ORIGIN, "epoch-other"),
      {
        tabId: 8,
        frameId: 0,
        origin: OTHER_ORIGIN,
        pathname: "/other",
        documentId: "other-document",
      },
    ));
    await harness.controller.refreshActiveOrigin();
    harness.queueActive(createActiveData(createReadback(restoredFrameFile), framePage));

    await harness.controller.refreshActiveOrigin();

    expect(harness.controller.getSnapshot()).toMatchObject({
      activePage: framePage,
      selectedItemId: "att_b",
      intent: "Update List design systems",
    });
  });

  test("a same-route document refresh preserves its previous explicit selection", async () => {
    const harness = createControllerHarness();
    harness.queueActive(createActiveData(
      createReadback(harness.file),
      {
        tabId: 1,
        frameId: 0,
        origin: ORIGIN,
        pathname: "/settings",
        documentId: "original-document",
      },
    ));
    await harness.controller.initialize();
    await harness.controller.selectItem("att_save");

    harness.queueActive(createActiveData(
      createReadback(harness.file),
      {
        tabId: 1,
        frameId: 0,
        origin: ORIGIN,
        pathname: "/settings",
        documentId: "replacement-document",
      },
    ));

    await harness.controller.refreshActiveOrigin();

    expect(harness.controller.getSnapshot()).toMatchObject({
      selectedItemId: "att_save",
      intent: "Update Save changes",
    });
  });

  test("capture refresh selects the committed item on the active page", async () => {
    const harness = createControllerHarness();
    await harness.controller.initialize();
    harness.queueActive(createActiveData(
      createReadback(harness.file),
      { tabId: 1, frameId: 0, origin: ORIGIN, pathname: "/settings" },
    ));

    await harness.controller.refreshActiveOrigin("att_save");

    expect(harness.controller.getSnapshot()).toMatchObject({
      selectedItemId: "att_save",
      intent: "Update Save changes",
    });
  });

  test("capture refresh ignores a committed item outside the active page", async () => {
    const harness = createControllerHarness();
    const account = { ...createCaptureRecord("account", "Account"), tabId: 1, frameId: 0 };
    account.pageUrl = `${ORIGIN}/account`;
    harness.file = createSessionFile([
      createCaptureRecord("save", "Save changes"),
      createCaptureRecord("cancel", "Cancel"),
      account,
    ]);
    await harness.controller.initialize();
    harness.queueActive(createActiveData(
      createReadback(harness.file),
      { tabId: 1, frameId: 0, origin: ORIGIN, pathname: "/account" },
    ));

    await harness.controller.refreshActiveOrigin("att_save");

    expect(harness.controller.getSnapshot()).toMatchObject({
      selectedItemId: "att_account",
      intent: "Update Account",
    });
  });

  test("pathname change selects the latest capture on the new current page", async () => {
    const harness = createControllerHarness();
    const account = { ...createCaptureRecord("account", "Account"), tabId: 1, frameId: 0 };
    account.pageUrl = `${ORIGIN}/account`;
    harness.file = createSessionFile([
      createCaptureRecord("save", "Save changes"),
      createCaptureRecord("cancel", "Cancel"),
      account,
    ]);
    await harness.controller.initialize();
    await harness.controller.selectItem("att_save");
    harness.queueActive(createActiveData(
      createReadback(harness.file),
      { tabId: 1, frameId: 0, origin: ORIGIN, pathname: "/account" },
    ));

    await harness.controller.refreshActiveOrigin();

    expect(harness.controller.getSnapshot()).toMatchObject({
      activePage: { tabId: 1, frameId: 0, origin: ORIGIN, pathname: "/account" },
      selectedItemId: "att_account",
      intent: "Update Account",
    });
  });

  test("dirty refresh getActive failure cannot replace newer local status", async () => {
    const harness = createControllerHarness();
    await harness.controller.initialize();
    const active = createDeferred<SessionCommandResponse<ActiveSessionCommandData>>();
    harness.client.getActive = vi.fn(async () => {
      harness.client.calls.push("getActive:deferred-failure");
      return active.promise;
    });

    harness.controller.setIntent("Before refresh");
    const refresh = harness.controller.refreshActiveOrigin();
    harness.controller.setIntent("Newer local status");
    active.resolve({
      ok: false,
      code: "CAPTURE_FAILED",
      error: "stale active failure",
    });
    await refresh;

    expect(harness.controller.getSnapshot()).toMatchObject({
      intent: "Newer local status",
      intentDirty: true,
      status: { kind: "ready", message: "Unsaved intent." },
    });
  });

  test("dirty same-origin refresh applies the successful save response instead of stale active readback", async () => {
    const harness = createControllerHarness();
    await harness.controller.initialize();
    const staleBeforeSave = harness.file;
    harness.controller.setIntent("Same-origin saved intent");
    harness.queueActive(createActiveData(createReadback(staleBeforeSave)));
    harness.client.updateIntent = vi.fn(async (origin, epoch, itemId, intent) => {
      harness.client.calls.push(`update:${origin}:${epoch}:${itemId}:${intent}`);
      const saved = updateIntentInFile(staleBeforeSave, itemId, intent);
      return { ok: true, data: createReadback(saved, origin, epoch) };
    });

    await harness.controller.refreshActiveOrigin();

    expect(harness.controller.getSnapshot()).toMatchObject({
      origin: ORIGIN,
      selectedItemId: "att_cancel",
      intent: "Same-origin saved intent",
      intentDirty: false,
      file: {
        session: {
          attachments: expect.arrayContaining([
            expect.objectContaining({
              id: "att_cancel",
              sourceRecord: expect.objectContaining({ intent: "Same-origin saved intent" }),
            }),
          ]),
        },
      },
    });
  });

  test("dirty same-origin route change saves the old intent then applies the fresh active page", async () => {
    const harness = createControllerHarness();
    const account = { ...createCaptureRecord("account", "Account"), tabId: 1, frameId: 0 };
    account.pageUrl = `${ORIGIN}/account`;
    harness.file = createSessionFile([
      createCaptureRecord("save", "Save changes"),
      createCaptureRecord("cancel", "Cancel"),
      account,
    ]);
    await harness.controller.initialize();
    harness.controller.setIntent("Saved before route change");
    harness.queueActive(createActiveData(
      createReadback(harness.file),
      { tabId: 1, frameId: 0, origin: ORIGIN, pathname: "/account" },
    ));
    harness.client.updateIntent = vi.fn(async (origin, epoch, itemId, intent) => ({
      ok: true,
      data: createReadback(updateIntentInFile(harness.file, itemId, intent), origin, epoch),
    }));

    await harness.controller.refreshActiveOrigin();

    expect(harness.controller.getSnapshot()).toMatchObject({
      activePage: { tabId: 1, frameId: 0, origin: ORIGIN, pathname: "/account" },
      selectedItemId: "att_account",
      intent: "Update Account",
      intentDirty: false,
      file: {
        session: {
          attachments: expect.arrayContaining([
            expect.objectContaining({
              id: "att_cancel",
              sourceRecord: expect.objectContaining({ intent: "Saved before route change" }),
            }),
          ]),
        },
      },
    });
  });

  test("dirty cross-origin refresh applies the new active origin after successful old-origin save", async () => {
    const harness = createControllerHarness();
    await harness.controller.initialize();
    harness.controller.setIntent("Old-origin saved intent");
    const otherFile = createSessionFile([createCaptureRecord("other", "Other")]);
    harness.queueActive(createActiveData(createReadback(otherFile, OTHER_ORIGIN, "epoch-other")));
    harness.client.updateIntent = vi.fn(async (origin, epoch, itemId, intent) => {
      harness.client.calls.push(`update:${origin}:${epoch}:${itemId}:${intent}`);
      return {
        ok: true,
        data: createReadback(updateIntentInFile(harness.file, itemId, intent), origin, epoch),
      };
    });

    await harness.controller.refreshActiveOrigin();

    expect(harness.controller.getSnapshot()).toMatchObject({
      origin: OTHER_ORIGIN,
      epoch: "epoch-other",
      selectedItemId: "att_other",
      intent: "Update Other",
      intentDirty: false,
    });
  });

  test("removing selected item chooses next then previous and empty state for the last item", async () => {
    const harness = createControllerHarness();
    await harness.controller.initialize();

    harness.client.removeItem = vi.fn(async (origin, epoch, itemId) => {
      harness.client.calls.push(`remove:${origin}:${epoch}:${itemId}`);
      harness.file = createSessionFile([
        createCaptureRecord("save", "Save changes"),
      ]);
      return { ok: true, data: createReadback(harness.file) };
    });
    await harness.controller.selectItem("att_save");
    await harness.controller.selectItem("att_cancel");
    await harness.controller.removeItem("att_cancel");
    expect(harness.controller.getSnapshot().selectedItemId).toBe("att_save");

    harness.file = createSessionFile([
      createCaptureRecord("save", "Save changes"),
      createCaptureRecord("cancel", "Cancel"),
      createCaptureRecord("delete", "Delete"),
    ]);
    harness.queueActive(createActiveData(createReadback(harness.file)));
    await harness.controller.refreshActiveOrigin();
    await harness.controller.selectItem("att_cancel");
    harness.client.removeItem = vi.fn(async (origin, epoch, itemId) => {
      harness.client.calls.push(`remove:${origin}:${epoch}:${itemId}`);
      harness.file = createSessionFile([
        createCaptureRecord("save", "Save changes"),
        createCaptureRecord("delete", "Delete"),
      ]);
      return { ok: true, data: createReadback(harness.file) };
    });
    await harness.controller.removeItem("att_cancel");
    expect(harness.controller.getSnapshot().selectedItemId).toBe("att_delete");

    harness.client.removeItem = vi.fn(async (origin, epoch, itemId) => {
      harness.client.calls.push(`remove:${origin}:${epoch}:${itemId}`);
      return { ok: true, data: createReadback(emptySessionFile()) };
    });
    await harness.controller.removeItem("att_delete");
    await harness.controller.removeItem("att_save");
    expect(harness.controller.getSnapshot()).toMatchObject({
      selectedItemId: null,
      status: { kind: "success", message: "Session item removed." },
    });
  });

  test("remove and clear successes announce exact controller status messages after readback", async () => {
    const harness = createControllerHarness();
    await harness.controller.initialize();

    await harness.controller.removeItem("att_save");
    expect(harness.controller.getSnapshot()).toMatchObject({
      file: { session: { attachments: [{ id: "att_cancel" }] } },
      status: { kind: "success", message: "Session item removed." },
    });

    await harness.controller.clearSession("clear-1");
    expect(harness.controller.getSnapshot()).toMatchObject({
      file: { session: { attachments: [] } },
      selectedItemId: null,
      status: { kind: "success", message: "Session cleared." },
    });
  });

  test("dirty selected remove and clear wait for the DOM caller to confirm discard", async () => {
    const harness = createControllerHarness();
    await harness.controller.initialize();
    harness.controller.setIntent("Dirty intent");

    await harness.controller.removeItem("att_cancel");
    await harness.controller.clearSession("clear-1");

    expect(harness.client.calls).toEqual(["getActive"]);
    expect(harness.controller.getSnapshot()).toMatchObject({
      selectedItemId: "att_cancel",
      intentDirty: true,
      status: {
        kind: "error",
        message: "Discard the unsaved selected intent before changing this session.",
      },
    });
  });

  test("clear preserves operation id across retry and treats CLEAR_IN_PROGRESS as saving", async () => {
    const harness = createControllerHarness();
    await harness.controller.initialize();
    harness.client.clear = vi.fn(async (origin, epoch, operationId) => {
      harness.client.calls.push(`clear:${origin}:${epoch}:${operationId}`);
      return {
        ok: false,
        code: "CLEAR_IN_PROGRESS",
        error: "A session clear is already in progress.",
      };
    });

    await harness.controller.clearSession("clear-123");
    await harness.controller.clearSession("clear-ignored");

    expect(harness.client.calls.slice(-2)).toEqual([
      "clear:https://app.example.test:epoch-1:clear-123",
      "clear:https://app.example.test:epoch-1:clear-123",
    ]);
    expect(harness.controller.getSnapshot()).toMatchObject({
      clearPending: true,
      status: {
        kind: "saving",
        message: "A session clear is already in progress.",
      },
    });
  });

  test("remove late response applies after blocking newer local intent", async () => {
    const harness = createControllerHarness();
    await harness.controller.initialize();
    const removed = createDeferred<SessionCommandResponse<ActiveSessionReadback>>();
    harness.client.removeItem = vi.fn(async (origin, epoch, itemId) => {
      harness.client.calls.push(`remove:${origin}:${epoch}:${itemId}`);
      return removed.promise;
    });

    const removing = harness.controller.removeItem("att_save");
    await flushMicrotasks();
    harness.controller.setIntent("Keep this edit");
    removed.resolve({
      ok: true,
      data: createReadback(removeItemFromFile(harness.file, "att_save")),
    });
    await removing;

    expect(harness.controller.getSnapshot()).toMatchObject({
      selectedItemId: "att_cancel",
      intent: "Update Cancel",
      intentDirty: false,
      file: { session: { attachments: [{ id: "att_cancel" }] } },
    });
  });

  test("clear success is authoritative after local intent and view changes while pending", async () => {
    const harness = createControllerHarness();
    await harness.controller.initialize();
    const cleared = createDeferred<SessionCommandResponse<ActiveSessionReadback>>();
    harness.client.clear = vi.fn(async (origin, epoch, operationId) => {
      harness.client.calls.push(`clear:${origin}:${epoch}:${operationId}`);
      return cleared.promise;
    });

    const clearing = harness.controller.clearSession("clear-late");
    await flushMicrotasks();
    expect(harness.controller.getSnapshot()).toMatchObject({
      sessionMutationPending: true,
      status: { kind: "saving", message: "Clearing capture session." },
    });
    harness.controller.setIntent("Keep after clear");
    harness.controller.setViewMode("full_debug");
    cleared.resolve({ ok: true, data: createReadback(emptySessionFile()) });
    await clearing;

    expect(harness.controller.getSnapshot()).toMatchObject({
      sessionMutationPending: false,
      selectedItemId: null,
      viewMode: "full_debug",
      intent: "",
      intentDirty: false,
      file: { session: { attachments: [] } },
      status: { kind: "success", message: "Session cleared." },
    });
  });

  test("remove mutation blocks local intent edits until the response settles", async () => {
    const harness = createControllerHarness();
    await harness.controller.initialize();
    const removed = createDeferred<SessionCommandResponse<ActiveSessionReadback>>();
    harness.client.removeItem = vi.fn(async (origin, epoch, itemId) => {
      harness.client.calls.push(`remove:${origin}:${epoch}:${itemId}`);
      return removed.promise;
    });

    const removing = harness.controller.removeItem("att_save");
    await flushMicrotasks();
    expect(harness.controller.getSnapshot()).toMatchObject({
      sessionMutationPending: true,
      intent: "Update Cancel",
      intentDirty: false,
    });
    harness.controller.setIntent("Blocked during remove");
    expect(harness.controller.getSnapshot()).toMatchObject({
      sessionMutationPending: true,
      intent: "Update Cancel",
      intentDirty: false,
    });

    removed.resolve({ ok: true, data: createReadback(removeItemFromFile(harness.file, "att_save")) });
    await removing;

    expect(harness.controller.getSnapshot()).toMatchObject({
      sessionMutationPending: false,
      file: { session: { attachments: [{ id: "att_cancel" }] } },
    });
  });

  test("readExport rejects while remove or clear mutation is in flight", async () => {
    const removeHarness = createControllerHarness();
    await removeHarness.controller.initialize();
    const removed = createDeferred<SessionCommandResponse<ActiveSessionReadback>>();
    removeHarness.client.removeItem = vi.fn(async () => removed.promise);

    const removing = removeHarness.controller.removeItem("att_save");
    await flushMicrotasks();
    await expect(removeHarness.controller.readExport()).resolves.toEqual({
      ok: false,
      code: "INVALID_SESSION_FILE",
      error: "Session mutation is still in progress. Try again after it finishes.",
    });
    removed.resolve({ ok: true, data: createReadback(removeItemFromFile(removeHarness.file, "att_save")) });
    await removing;

    const clearHarness = createControllerHarness();
    await clearHarness.controller.initialize();
    const cleared = createDeferred<SessionCommandResponse<ActiveSessionReadback>>();
    clearHarness.client.clear = vi.fn(async () => cleared.promise);

    const clearing = clearHarness.controller.clearSession("clear-export");
    await flushMicrotasks();
    await expect(clearHarness.controller.readExport()).resolves.toEqual({
      ok: false,
      code: "INVALID_SESSION_FILE",
      error: "Session mutation is still in progress. Try again after it finishes.",
    });
    cleared.resolve({ ok: true, data: createReadback(emptySessionFile()) });
    await clearing;
  });

  test("clear uses a new operation id after authoritative nonpending readback", async () => {
    const harness = createControllerHarness();
    await harness.controller.initialize();
    harness.client.clear = vi.fn(async (origin, epoch, operationId) => {
      harness.client.calls.push(`clear:${origin}:${epoch}:${operationId}`);
      return {
        ok: false,
        code: "STORAGE_ERROR",
        error: "storage uncertain",
      };
    });
    harness.queueActive(createActiveData(createReadback(harness.file)));

    await harness.controller.clearSession("clear-uncertain");
    harness.queueActive(createActiveData(createReadback(harness.file)));
    await harness.controller.clearSession("clear-new");

    expect(harness.client.calls.filter((call) => call.startsWith("clear:"))).toEqual([
      "clear:https://app.example.test:epoch-1:clear-uncertain",
      "clear:https://app.example.test:epoch-1:clear-new",
    ]);
  });

  test("clear failure readback with completed clear lets a new session use a new caller id", async () => {
    const harness = createControllerHarness();
    await harness.controller.initialize();
    const recreated = createSessionFile([
      createCaptureRecord("new", "New capture"),
    ]);
    harness.client.clear = vi.fn(async (origin, epoch, operationId) => {
      harness.client.calls.push(`clear:${origin}:${epoch}:${operationId}`);
      return {
        ok: false,
        code: "STORAGE_ERROR",
        error: "storage uncertain",
      };
    });
    harness.queueActive(createActiveData(createReadback(recreated, ORIGIN, "epoch-2")));

    await harness.controller.clearSession("clear-completed");
    await harness.controller.clearSession("clear-new-session");

    expect(harness.client.calls.filter((call) => call.startsWith("clear:"))).toEqual([
      "clear:https://app.example.test:epoch-1:clear-completed",
      "clear:https://app.example.test:epoch-2:clear-new-session",
    ]);
  });

  test("clear error readback restores authoritative clear-pending operation id", async () => {
    const harness = createControllerHarness();
    await harness.controller.initialize();
    harness.client.clear = vi.fn(async (origin, epoch, operationId) => {
      harness.client.calls.push(`clear:${origin}:${epoch}:${operationId}`);
      return {
        ok: false,
        code: "STORAGE_ERROR",
        error: "storage uncertain",
      };
    });
    harness.queueActive(createActiveData({
      ...createReadback(harness.file),
      clearPending: true,
      activeClearOperationId: "clear-authoritative",
    }));

    await harness.controller.clearSession("clear-original");
    expect(harness.controller.getSnapshot()).toMatchObject({
      clearPending: true,
      sessionMutationPending: false,
      status: {
        kind: "saving",
        message: "A session clear is already in progress.",
      },
    });

    await harness.controller.clearSession("clear-new");
    expect(harness.client.calls.filter((call) => call.startsWith("clear:"))).toEqual([
      "clear:https://app.example.test:epoch-1:clear-original",
      "clear:https://app.example.test:epoch-1:clear-authoritative",
    ]);
  });

  test("clear error readback applies authoritative session then preserves original error", async () => {
    const harness = createControllerHarness();
    await harness.controller.initialize();
    harness.client.clear = vi.fn(async (origin, epoch, operationId) => {
      harness.client.calls.push(`clear:${origin}:${epoch}:${operationId}`);
      return {
        ok: false,
        code: "STORAGE_ERROR",
        error: "storage uncertain",
      };
    });
    harness.queueActive(createActiveData(createReadback(removeItemFromFile(harness.file, "att_save"))));

    await harness.controller.clearSession("clear-original");

    expect(harness.controller.getSnapshot()).toMatchObject({
      clearPending: false,
      sessionMutationPending: false,
      file: { session: { attachments: [{ id: "att_cancel" }] } },
      status: { kind: "error", message: "storage uncertain" },
    });
  });

  test("clear error readback rejection keeps safe status and retained operation id", async () => {
    const harness = createControllerHarness();
    await harness.controller.initialize();
    const activeReadback = createDeferred<SessionCommandResponse<ActiveSessionCommandData>>();
    harness.client.clear = vi.fn(async (origin, epoch, operationId) => {
      harness.client.calls.push(`clear:${origin}:${epoch}:${operationId}`);
      return {
        ok: false,
        code: "STORAGE_ERROR",
        error: "storage uncertain",
      };
    });
    harness.client.getActive = vi.fn(async () => {
      harness.client.calls.push("getActive:deferred-reject");
      return activeReadback.promise;
    });

    const clearing = harness.controller.clearSession("clear-original");
    await flushMicrotasks();
    activeReadback.reject(new Error("secret readback failure"));
    await expect(clearing).resolves.toBeUndefined();
    expect(harness.controller.getSnapshot()).toMatchObject({
      sessionMutationPending: false,
      status: { kind: "error", message: "Panel action failed. Try again." },
    });

    const secondReadback = createDeferred<SessionCommandResponse<ActiveSessionCommandData>>();
    harness.client.getActive = vi.fn(async () => {
      harness.client.calls.push("getActive:second");
      return secondReadback.promise;
    });
    const retry = harness.controller.clearSession("clear-new");
    await flushMicrotasks();
    secondReadback.resolve({ ok: true, data: createActiveData(createReadback(harness.file)) });
    await retry;

    expect(harness.client.calls.filter((call) => call.startsWith("clear:"))).toEqual([
      "clear:https://app.example.test:epoch-1:clear-original",
      "clear:https://app.example.test:epoch-1:clear-original",
    ]);
  });

  test("clear keeps operation id through clearPending readback until authoritative completion", async () => {
    const harness = createControllerHarness();
    await harness.controller.initialize();
    harness.client.clear = vi.fn(async (origin, epoch, operationId) => {
      harness.client.calls.push(`clear:${origin}:${epoch}:${operationId}`);
      return {
        ok: false,
        code: "STORAGE_ERROR",
        error: "storage uncertain",
      };
    });
    harness.queueActive(createActiveData({
      ...createReadback(harness.file),
      clearPending: true,
    }));

    await harness.controller.clearSession("clear-original");
    harness.queueActive(createActiveData({
      ...createReadback(harness.file),
      clearPending: true,
    }));
    await harness.controller.refreshActiveOrigin();
    expect(harness.controller.getSnapshot()).toMatchObject({
      clearPending: true,
      status: {
        kind: "saving",
        message: "A session clear is already in progress.",
      },
    });
    await harness.controller.clearSession("clear-new-caller");

    expect(harness.client.calls.filter((call) => call.startsWith("clear:"))).toEqual([
      "clear:https://app.example.test:epoch-1:clear-original",
      "clear:https://app.example.test:epoch-1:clear-original",
    ]);
  });

  test("reopened clear-pending controller resumes with authoritative active clear id", async () => {
    const harness = createControllerHarness();
    harness.queueActive(createActiveData({
      origin: ORIGIN,
      epoch: "epoch-clear",
      clearPending: true,
      activeClearOperationId: "clear-1",
      file: null,
      legacyRecord: null,
    }));

    await harness.controller.initialize();
    await harness.controller.clearSession("clear-new");

    expect(harness.client.calls.filter((call) => call.startsWith("clear:"))).toEqual([
      "clear:https://app.example.test:epoch-clear:clear-1",
    ]);
  });

  test("initializes and refreshes with explicit clearPending truth from authoritative readback", async () => {
    const harness = createControllerHarness();
    harness.queueActive(createActiveData({
      ...createReadback(harness.file),
      clearPending: true,
    }));

    await harness.controller.initialize();
    expect(harness.controller.getSnapshot()).toMatchObject({
      clearPending: true,
      status: {
        kind: "saving",
        message: "A session clear is already in progress.",
      },
    });

    harness.queueActive(createActiveData(createReadback(harness.file)));
    await harness.controller.refreshActiveOrigin();
    expect(harness.controller.getSnapshot()).toMatchObject({
      clearPending: false,
      status: { kind: "ready" },
    });
  });

  test("unsupported active pages are distinct from supported origins with no session", async () => {
    const harness = createControllerHarness();
    harness.queueActive({
      enabled: false,
      origin: null,
      readback: null,
    });

    await harness.controller.initialize();
    expect(harness.controller.getSnapshot()).toMatchObject({
      activeSupported: false,
      origin: null,
      status: {
        kind: "empty",
        message: "This page is not supported. Open an HTTP(S) page to capture UI.",
      },
    });

    harness.queueActive({
      enabled: true,
      origin: ORIGIN,
      readback: null,
    });
    await harness.controller.refreshActiveOrigin();
    expect(harness.controller.getSnapshot()).toMatchObject({
      activeSupported: true,
      origin: ORIGIN,
      status: {
        kind: "empty",
        message: "No session for this origin. Capture an element to start one.",
      },
    });
  });

  test("discard recovery applies complete supported no-session active data", async () => {
    const harness = createControllerHarness();
    await harness.controller.initialize();
    harness.controller.setIntent("Recover this");
    harness.client.updateIntent = vi.fn(async () => ({
      ok: false,
      code: "STORAGE_ERROR",
      error: "offline",
    }));
    harness.queueActive({
      enabled: true,
      origin: OTHER_ORIGIN,
      readback: null,
    });
    await harness.controller.refreshActiveOrigin();

    harness.queueActive({
      enabled: true,
      origin: OTHER_ORIGIN,
      readback: null,
    });
    await harness.controller.discardDirtyIntent();

    expect(harness.controller.getSnapshot()).toMatchObject({
      activeSupported: true,
      origin: OTHER_ORIGIN,
      file: null,
      selectedItemId: null,
      recovery: null,
      status: {
        kind: "empty",
        message: "No session for this origin. Capture an element to start one.",
      },
    });
  });

  test("readExport uses fresh active readback and rejects pending, stale, or origin-mismatched sessions", async () => {
    const harness = createControllerHarness();
    await harness.controller.initialize();
    const first = await harness.controller.readExport();
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    expect(first.value.text).toBe(`${JSON.stringify(first.value.file, null, 2)}\n`);
    expect(harness.client.calls).toEqual(["getActive", "getActive"]);

    harness.queueActive(createActiveData({
      ...createReadback(harness.file),
      origin: OTHER_ORIGIN,
    }));
    const mismatched = await harness.controller.readExport();
    expect(mismatched).toEqual({
      ok: false,
      code: "INVALID_SESSION_FILE",
      error: "Active origin changed before export. Refresh the panel and try again.",
    });

    harness.queueActive(createActiveData({
      ...createReadback(harness.file),
      clearPending: true,
    }));
    const pending = await harness.controller.readExport();
    expect(pending).toEqual({
      ok: false,
      code: "INVALID_SESSION_FILE",
      error: "Session clear is still in progress. Try again after it finishes.",
    });
  });

  test("remove success still applies after View as changes within the same active session", async () => {
    const harness = createControllerHarness();
    await harness.controller.initialize();
    const removed = createDeferred<SessionCommandResponse<ActiveSessionReadback>>();
    harness.client.removeItem = vi.fn(async (origin, epoch, itemId) => {
      harness.client.calls.push(`remove:${origin}:${epoch}:${itemId}`);
      return removed.promise;
    });

    const removing = harness.controller.removeItem("att_save");
    await flushMicrotasks();
    harness.controller.setViewMode("full_debug");
    removed.resolve({
      ok: true,
      data: createReadback(removeItemFromFile(harness.file, "att_save")),
    });
    await removing;

    expect(harness.controller.getSnapshot()).toMatchObject({
      origin: ORIGIN,
      epoch: "epoch-1",
      viewMode: "full_debug",
      file: { session: { attachments: [{ id: "att_cancel" }] } },
      sessionMutationPending: false,
    });
  });

  test("clear success from an old active origin cannot overwrite a refreshed origin", async () => {
    const harness = createControllerHarness();
    await harness.controller.initialize();
    const cleared = createDeferred<SessionCommandResponse<ActiveSessionReadback>>();
    harness.client.clear = vi.fn(async (origin, epoch, operationId) => {
      harness.client.calls.push(`clear:${origin}:${epoch}:${operationId}`);
      return cleared.promise;
    });

    const clearing = harness.controller.clearSession("clear-old-origin");
    await flushMicrotasks();
    harness.queueActive(createActiveData(createReadback(createSessionFile([
      createCaptureRecord("other", "Other"),
    ]), OTHER_ORIGIN, "epoch-other")));
    await harness.controller.refreshActiveOrigin();
    cleared.resolve({ ok: true, data: createReadback(emptySessionFile(ORIGIN), ORIGIN, "epoch-1") });
    await clearing;

    expect(harness.controller.getSnapshot()).toMatchObject({
      origin: OTHER_ORIGIN,
      epoch: "epoch-other",
      selectedItemId: "att_other",
      clearPending: false,
      sessionMutationPending: false,
      status: { kind: "ready", message: "Capture session ready." },
    });
  });

  test("CLEAR_IN_PROGRESS from an old active origin cannot mark a refreshed origin pending", async () => {
    const harness = createControllerHarness();
    await harness.controller.initialize();
    const blocked = createDeferred<SessionCommandResponse<ActiveSessionReadback>>();
    harness.client.clear = vi.fn(async (origin, epoch, operationId) => {
      harness.client.calls.push(`clear:${origin}:${epoch}:${operationId}`);
      return blocked.promise;
    });

    const clearing = harness.controller.clearSession("clear-old-origin");
    await flushMicrotasks();
    harness.queueActive(createActiveData(createReadback(createSessionFile([
      createCaptureRecord("other", "Other"),
    ]), OTHER_ORIGIN, "epoch-other")));
    await harness.controller.refreshActiveOrigin();
    blocked.resolve({
      ok: false,
      code: "CLEAR_IN_PROGRESS",
      error: "A session clear is already in progress.",
    });
    await clearing;

    expect(harness.controller.getSnapshot()).toMatchObject({
      origin: OTHER_ORIGIN,
      epoch: "epoch-other",
      clearPending: false,
      sessionMutationPending: false,
      status: { kind: "ready", message: "Capture session ready." },
    });
  });

  test("uncertain clear failure from an old active origin cannot reconcile over a refreshed origin", async () => {
    const harness = createControllerHarness();
    await harness.controller.initialize();
    const failed = createDeferred<SessionCommandResponse<ActiveSessionReadback>>();
    harness.client.clear = vi.fn(async (origin, epoch, operationId) => {
      harness.client.calls.push(`clear:${origin}:${epoch}:${operationId}`);
      return failed.promise;
    });

    const clearing = harness.controller.clearSession("clear-old-origin");
    await flushMicrotasks();
    harness.queueActive(createActiveData(createReadback(createSessionFile([
      createCaptureRecord("other", "Other"),
    ]), OTHER_ORIGIN, "epoch-other")));
    await harness.controller.refreshActiveOrigin();
    failed.resolve({
      ok: false,
      code: "STORAGE_ERROR",
      error: "old origin failed",
    });
    await clearing;

    expect(harness.controller.getSnapshot()).toMatchObject({
      origin: OTHER_ORIGIN,
      epoch: "epoch-other",
      clearPending: false,
      sessionMutationPending: false,
      status: { kind: "ready", message: "Capture session ready." },
    });
    expect(harness.client.calls.filter((call) => call.startsWith("getActive"))).toEqual([
      "getActive",
      "getActive",
    ]);
  });

  test("readExport does not apply a stale readback when local state changes in flight", async () => {
    const harness = createControllerHarness();
    await harness.controller.initialize();
    const active = createDeferred<SessionCommandResponse<ActiveSessionCommandData>>();
    harness.client.getActive = vi.fn(async () => {
      harness.client.calls.push("getActive:export");
      return active.promise;
    });

    const exported = harness.controller.readExport();
    await flushMicrotasks();
    harness.controller.setIntent("Edited while exporting");
    active.resolve({ ok: true, data: createActiveData(createReadback(harness.file)) });
    const result = await exported;

    expect(result).toEqual({
      ok: false,
      code: "INVALID_SESSION_FILE",
      error: "Panel state changed before export. Save again and retry.",
    });
    expect(harness.controller.getSnapshot()).toMatchObject({
      intent: "Edited while exporting",
      intentDirty: true,
    });
  });

  test("snapshots deep clone file, legacy record, status, and recovery", async () => {
    const harness = createControllerHarness();
    await harness.controller.initialize();
    const first = harness.controller.getSnapshot();
    first.status.message = "corrupted";
    if (first.file) first.file.session.origin = "https://corrupted.example.test";
    if (first.legacyRecord) first.legacyRecord.origin = "https://corrupted.example.test";

    expect(harness.controller.getSnapshot()).toMatchObject({
      origin: ORIGIN,
      status: { message: "Capture session ready." },
      file: { session: { origin: ORIGIN } },
      legacyRecord: { origin: ORIGIN },
    });

    harness.controller.setIntent("Dirty recovery");
    harness.client.updateIntent = vi.fn(async () => ({
      ok: false,
      code: "STORAGE_ERROR",
      error: "offline",
    }));
    harness.queueActive(createActiveData(createReadback(createSessionFile([
      createCaptureRecord("other", "Other"),
    ]), OTHER_ORIGIN)));
    await harness.controller.refreshActiveOrigin();
    const recovered = harness.controller.getSnapshot();
    if (recovered.recovery) {
      recovered.recovery.oldOrigin = "https://corrupted.example.test";
      recovered.recovery.intent = "corrupted";
    }

    expect(harness.controller.getSnapshot()).toMatchObject({
      recovery: {
        oldOrigin: ORIGIN,
        intent: "Dirty recovery",
      },
    });
  });
});

function createControllerHarness() {
  const file = createSessionFile([
    createCaptureRecord("save", "Save changes"),
    createCaptureRecord("cancel", "Cancel", "full_debug"),
  ]);
  const activeQueue: ActiveSessionCommandData[] = [];
  const client: PanelSessionClient & { calls: string[] } = {
    calls: [],
    async getActive() {
      client.calls.push("getActive");
      return { ok: true, data: activeQueue.shift() ?? createActiveData(createReadback(harness.file)) };
    },
    async updateIntent(origin, epoch, itemId, intent) {
      client.calls.push(`update:${origin}:${epoch}:${itemId}:${intent}`);
      harness.file = updateIntentInFile(harness.file, itemId, intent);
      return { ok: true, data: createReadback(harness.file, origin, epoch) };
    },
    async removeItem(origin, epoch, itemId) {
      client.calls.push(`remove:${origin}:${epoch}:${itemId}`);
      harness.file = removeItemFromFile(harness.file, itemId);
      return { ok: true, data: createReadback(harness.file, origin, epoch) };
    },
    async clear(origin, epoch, operationId) {
      client.calls.push(`clear:${origin}:${epoch}:${operationId}`);
      harness.file = emptySessionFile(origin);
      return { ok: true, data: createReadback(harness.file, origin, epoch) };
    },
  };
  const harness = {
    file,
    client,
    controller: createPanelSessionController({
      client,
      setTimeout: (callback, delay) => setTimeout(callback, delay),
      clearTimeout: (id) => clearTimeout(id),
    }),
    queueActive(active: ActiveSessionCommandData) {
      activeQueue.push(active);
    },
  };
  return harness;
}

function createActiveData(
  readback: ActiveSessionReadback | null,
  activePage = readback === null
    ? null
    : { tabId: 1, frameId: 0, origin: readback.origin, pathname: "/settings" },
): ActiveSessionCommandData {
  return {
    enabled: readback !== null,
    origin: readback?.origin ?? null,
    activePage,
    readback,
  };
}

function createReadback(
  file: CaptureSessionFileV1,
  origin = ORIGIN,
  epoch = "epoch-1",
): ActiveSessionReadback {
  const normalizedFile = origin === file.session.origin
    ? file
    : {
        ...file,
        session: {
          ...file.session,
          origin,
          attachments: file.session.attachments.map((item) => ({
            ...item,
            sourceRecord: rebaseRecordOrigin(item.sourceRecord as OriginCaptureRecord, origin),
          })),
        },
      };
  return {
    origin,
    epoch,
    clearPending: false,
    activeClearOperationId: null,
    file: normalizedFile,
    legacyRecord: normalizedFile.session.attachments.at(-1)?.sourceRecord as OriginCaptureRecord | null,
  };
}

function rebaseRecordOrigin(record: OriginCaptureRecord, origin: string): OriginCaptureRecord {
  return {
    ...record,
    origin,
    pageUrl: rebaseUrlOrigin(record.pageUrl, origin),
    attachment: {
      ...record.attachment,
      source: {
        ...record.attachment.source,
        url: rebaseUrlOrigin(record.attachment.source.url, origin),
      },
      policy: {
        ...record.attachment.policy,
        allowedDomains: [origin],
      },
    },
  };
}

function rebaseUrlOrigin(value: string | null, origin: string): string | null {
  if (value === null) return null;
  const source = new URL(value);
  return new URL(`${source.pathname}${source.search}${source.hash}`, `${origin}/`).href;
}

function updateIntentInFile(
  file: CaptureSessionFileV1,
  itemId: string,
  intent: string,
): CaptureSessionFileV1 {
  return {
    ...file,
    session: {
      ...file.session,
      attachments: file.session.attachments.map((item) =>
        item.id === itemId
          ? { ...item, sourceRecord: { ...item.sourceRecord, intent } }
          : item,
      ),
    },
  };
}

function removeItemFromFile(file: CaptureSessionFileV1, itemId: string): CaptureSessionFileV1 {
  return {
    ...file,
    session: {
      ...file.session,
      attachments: file.session.attachments.filter((item) => item.id !== itemId),
    },
  };
}

function emptySessionFile(origin = ORIGIN): CaptureSessionFileV1 {
  return {
    ...createSessionFile([]),
    session: {
      ...createSessionFile([]).session,
      origin,
      attachments: [],
    },
  };
}

interface Deferred<T> {
  promise: Promise<T>;
  resolve(value: T): void;
  reject(error: unknown): void;
}

function createDeferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((innerResolve, innerReject) => {
    resolve = innerResolve;
    reject = innerReject;
  });
  return { promise, resolve, reject };
}

async function flushMicrotasks(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}
