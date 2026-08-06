import { describe, expect, test } from "vitest";
import { createCaptureRecord, createSessionFile } from "../test/session-fixtures";
import type { ExtensionStorageArea, OriginCaptureRecord } from "./capture-store";
import {
  FIRST_CAPTURE_DISCLOSURE_ID,
  FIRST_CAPTURE_DISCLOSURE_STORAGE_KEY,
} from "./first-capture-disclosure";
import { createSessionMeta } from "./session-state";
import { createExtensionSessionStore } from "./session-store";
import {
  RELATION_SHORTCUTS_KEY,
  TIME_DISPLAY_PREFERENCE_KEY,
} from "./settings-preferences";

const ORIGIN = "https://app.example.test";
const OTHER_ORIGIN = "https://admin.example.test";
const SESSION_KEY = `ui-attach:session:v1:${ORIGIN}`;
const SESSION_META_KEY = `ui-attach:session:v1:meta:${ORIGIN}`;
const ORIGIN_CAPTURE_KEY = `ui-attach:capture:${ORIGIN}`;
const LATEST_CAPTURE_KEY = "ui-attach:capture:latest";
const OTHER_SESSION_KEY = `ui-attach:session:v1:${OTHER_ORIGIN}`;
const OTHER_SESSION_META_KEY = `ui-attach:session:v1:meta:${OTHER_ORIGIN}`;

describe("extension queued session store", () => {
  test("commits session, receipt metadata, and compatibility projections together", async () => {
    const storage = new RecordingStorage();
    const store = createExtensionSessionStore({
      storage,
      now: sequenceClock("2026-07-11T02:00:00.000Z"),
      randomUUID: sequenceUuid("epoch-1", "op-1"),
    });

    const begun = await store.beginCapture(ORIGIN);
    expect(begun.ok).toBe(true);
    if (!begun.ok) return;
    const committed = await store.commitCapture(
      begun.value,
      createCaptureRecord("save", "Save changes"),
    );

    expect(committed.ok).toBe(true);
    if (!committed.ok) return;
    expect(committed.value.itemId).toBe("att_save");
    expect(committed.value.label).toBe("A");
    expect(committed.value.readback.file?.session.attachments).toHaveLength(1);
    const lastSet = storage.setCalls.at(-1)!;
    expect(Object.keys(lastSet).sort()).toEqual([
      ORIGIN_CAPTURE_KEY,
      LATEST_CAPTURE_KEY,
      SESSION_KEY,
      SESSION_META_KEY,
    ]);
    expect(lastSet[SESSION_META_KEY]).toMatchObject({
      epoch: "epoch-1",
      clearPending: false,
      receipts: [{ operationId: "op-1", itemId: "att_save" }],
    });
  });

  test("reads legacy-only origin records without migration or global latest leakage", async () => {
    const storage = new RecordingStorage();
    const record = createCaptureRecord("save", "Save changes");
    const other = createCaptureRecord("other", "Other");
    other.origin = OTHER_ORIGIN;
    storage.seed({
      [ORIGIN_CAPTURE_KEY]: record,
      [LATEST_CAPTURE_KEY]: other,
    });
    const store = createExtensionSessionStore({ storage });

    const read = await store.read(ORIGIN);

    expect(read.ok).toBe(true);
    if (!read.ok) return;
    expect(read.value).toMatchObject({
      origin: ORIGIN,
      epoch: null,
      clearPending: false,
      file: null,
      legacyRecord: { origin: ORIGIN },
    });
    expect(storage.setCalls).toEqual([]);
    expect(read.value.legacyRecord).not.toEqual(other);
  });

  test("lists every stored origin session without returning captured content", async () => {
    const storage = new RecordingStorage();
    storage.seed({
      [SESSION_KEY]: createSessionFile([createCaptureRecord("save", "Save changes")]),
      [SESSION_META_KEY]: createSessionMeta("epoch-app"),
      [OTHER_SESSION_KEY]: createSessionFileForOrigin(OTHER_ORIGIN, []),
      [OTHER_SESSION_META_KEY]: createSessionMeta("epoch-admin"),
      "ui-attach:disclosure-mode": "agent_safe",
    });
    const store = createExtensionSessionStore({ storage });

    await expect(store.list()).resolves.toEqual({
      ok: true,
      value: [
        {
          origin: OTHER_ORIGIN,
          epoch: "epoch-admin",
          attachmentCount: 0,
          state: "ready",
          clearPending: false,
          activeClearOperationId: null,
        },
        {
          origin: ORIGIN,
          epoch: "epoch-app",
          attachmentCount: 1,
          state: "ready",
          clearPending: false,
          activeClearOperationId: null,
        },
      ],
    });
  });

  test("lists and clears legacy-only capture data without an active page", async () => {
    const storage = new RecordingStorage();
    const legacy = createCaptureRecord("save", "Save changes");
    storage.seed({
      [ORIGIN_CAPTURE_KEY]: legacy,
      [LATEST_CAPTURE_KEY]: legacy,
    });
    const store = createExtensionSessionStore({
      storage,
      randomUUID: sequenceUuid("epoch-recovered"),
    });

    await expect(store.list()).resolves.toEqual({
      ok: true,
      value: [{
        origin: ORIGIN,
        epoch: null,
        attachmentCount: 1,
        state: "legacy",
        clearPending: false,
        activeClearOperationId: null,
      }],
    });
    await expect(store.clear(ORIGIN, null, "clear-legacy")).resolves.toMatchObject({
      ok: true,
      value: { origin: ORIGIN, file: null, legacyRecord: null },
    });
    expect(storage.peek(ORIGIN_CAPTURE_KEY)).toBeUndefined();
    expect(storage.peek(LATEST_CAPTURE_KEY)).toBeUndefined();
  });

  test("surfaces an orphaned session for cleanup and clears it with a null epoch", async () => {
    const storage = new RecordingStorage();
    const orphaned = createSessionFile([]);
    orphaned.session.title = null;
    storage.seed({
      [SESSION_KEY]: orphaned,
    });
    const store = createExtensionSessionStore({
      storage,
      randomUUID: sequenceUuid("epoch-recovered"),
    });

    await expect(store.list()).resolves.toEqual({
      ok: true,
      value: [{
        origin: ORIGIN,
        epoch: null,
        attachmentCount: 0,
        state: "needs_cleanup",
        clearPending: false,
        activeClearOperationId: null,
      }],
    });
    await expect(store.clear(ORIGIN, null, "clear-orphan")).resolves.toMatchObject({ ok: true });
    expect(storage.peek(SESSION_KEY)).toBeUndefined();
  });

  test("reports corrupt stored sessions with an unknown count instead of guessing empty", async () => {
    const storage = new RecordingStorage();
    storage.seed({
      [SESSION_KEY]: { corrupt: true },
      [SESSION_META_KEY]: { also: "corrupt" },
    });
    const store = createExtensionSessionStore({ storage });

    await expect(store.list()).resolves.toEqual({
      ok: true,
      value: [{
        origin: ORIGIN,
        epoch: null,
        attachmentCount: null,
        state: "needs_cleanup",
        clearPending: false,
        activeClearOperationId: null,
      }],
    });
  });

  test("clears every stored capture origin while preserving unrelated extension preferences", async () => {
    const storage = new RecordingStorage();
    const latest = createCaptureRecord("save", "Save changes");
    storage.seed({
      [SESSION_KEY]: createSessionFile([latest]),
      [SESSION_META_KEY]: createSessionMeta("epoch-app"),
      [ORIGIN_CAPTURE_KEY]: latest,
      [LATEST_CAPTURE_KEY]: latest,
      [OTHER_SESSION_KEY]: createSessionFileForOrigin(
        OTHER_ORIGIN,
        [createCaptureRecord("other", "Other")],
      ),
      [OTHER_SESSION_META_KEY]: createSessionMeta("epoch-admin"),
      "ui-attach:disclosure-mode": "agent_safe",
      "ui-attach:panel-theme": "dark",
      "ui-attach:handoff-format:single-target": "compact",
      "ui-attach:handoff-format:multi-target": "exact",
      [TIME_DISPLAY_PREFERENCE_KEY]: "local",
      [RELATION_SHORTCUTS_KEY]: [{
        id: "same-spacing",
        label: "Keep spacing",
        template: "Keep {selected} the same distance from {reference}.",
      }],
      "ui-attach.local-agent-bridge.installation.v1": { installationId: "installation-id" },
    });
    const store = createExtensionSessionStore({ storage });

    await expect(store.clearAll()).resolves.toEqual({
      ok: true,
      value: { clearedOrigins: [OTHER_ORIGIN, ORIGIN] },
    });
    await expect(store.list()).resolves.toEqual({ ok: true, value: [] });
    expect(storage.peek("ui-attach:disclosure-mode")).toBe("agent_safe");
    expect(storage.peek("ui-attach:panel-theme")).toBe("dark");
    expect(storage.peek("ui-attach:handoff-format:single-target")).toBe("compact");
    expect(storage.peek("ui-attach:handoff-format:multi-target")).toBe("exact");
    expect(storage.peek(TIME_DISPLAY_PREFERENCE_KEY)).toBe("local");
    expect(storage.peek(RELATION_SHORTCUTS_KEY)).toEqual([{
      id: "same-spacing",
      label: "Keep spacing",
      template: "Keep {selected} the same distance from {reference}.",
    }]);
    expect(storage.peek("ui-attach.local-agent-bridge.installation.v1")).toEqual({
      installationId: "installation-id",
    });
  });

  test("rejects unsupported origins before deriving storage keys", async () => {
    const storage = new RecordingStorage();
    const store = createExtensionSessionStore({ storage });

    await expect(store.read("chrome-extension://extension-id")).resolves.toMatchObject({
      ok: false,
      code: "UNSUPPORTED_ORIGIN",
    });
    await expect(store.beginCapture("https://app.example.test/")).resolves.toMatchObject({
      ok: false,
      code: "UNSUPPORTED_ORIGIN",
    });
    expect(storage.getCalls).toEqual([]);
    expect(storage.setCalls).toEqual([]);
  });

  test("dedupes repeated commits while the receipt is still retained", async () => {
    const storage = new RecordingStorage();
    const store = createExtensionSessionStore({
      storage,
      now: sequenceClock("2026-07-11T02:00:00.000Z", "2026-07-11T02:01:00.000Z"),
      randomUUID: sequenceUuid("epoch-1", "op-1"),
    });
    const begun = await store.beginCapture(ORIGIN);
    expect(begun.ok).toBe(true);
    if (!begun.ok) return;

    const first = await store.commitCapture(begun.value, createCaptureRecord("save", "Save"));
    const second = await store.commitCapture(begun.value, createCaptureRecord("save", "Save"));

    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    expect(second.value.itemId).toBe("att_save");
    expect(second.value.readback.file?.session.attachments.map((item) => item.id)).toEqual([
      "att_save",
    ]);
  });

  test("deduped commits do not rewrite compatibility projections from changed retry payloads", async () => {
    const storage = new RecordingStorage();
    const store = createExtensionSessionStore({
      storage,
      now: sequenceClock("2026-07-11T02:00:00.000Z", "2026-07-11T02:01:00.000Z"),
      randomUUID: sequenceUuid("epoch-1", "op-1"),
    });
    const begun = await store.beginCapture(ORIGIN);
    expect(begun.ok).toBe(true);
    if (!begun.ok) return;
    const original = createCaptureRecord("save", "Save");
    const first = await store.commitCapture(begun.value, original);
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    const originalFile = storage.peek(SESSION_KEY);
    const originalOriginProjection = storage.peek(ORIGIN_CAPTURE_KEY);
    const originalLatestProjection = storage.peek(LATEST_CAPTURE_KEY);

    const changedRetry = createCaptureRecord("delete", "Changed retry");
    changedRetry.attachment.context.selectorHints = ["changed-retry-payload"];
    const second = await store.commitCapture(begun.value, changedRetry);

    expect(second.ok).toBe(true);
    if (!second.ok) return;
    expect(storage.peek(SESSION_KEY)).toEqual(originalFile);
    expect(storage.peek(ORIGIN_CAPTURE_KEY)).toEqual(originalOriginProjection);
    expect(storage.peek(LATEST_CAPTURE_KEY)).toEqual(originalLatestProjection);
    expect(second.value.readback.legacyRecord).toEqual(originalOriginProjection);
    expect(second.value.readback.file?.session.attachments).toEqual(
      first.value.readback.file?.session.attachments,
    );
  });

  test("recapturing a verified target refreshes projections while retaining its label and intent", async () => {
    const storage = new RecordingStorage();
    const store = createExtensionSessionStore({
      storage,
      now: sequenceClock(
        "2026-07-11T02:00:00.000Z",
        "2026-07-11T02:01:00.000Z",
        "2026-07-11T02:02:00.000Z",
      ),
      randomUUID: sequenceUuid("epoch-1", "op-1", "op-2"),
    });
    const firstToken = await store.beginCapture(ORIGIN);
    expect(firstToken.ok).toBe(true);
    if (!firstToken.ok) return;
    const first = await store.commitCapture(
      firstToken.value,
      withStableTestIdIdentity(createCaptureRecord("save", "Save changes"), "save"),
    );
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    const savedIntent = await store.updateIntent(
      ORIGIN,
      firstToken.value.epoch,
      first.value.itemId,
      "Keep this instruction",
    );
    expect(savedIntent.ok).toBe(true);
    const secondToken = await store.beginCapture(ORIGIN);
    expect(secondToken.ok).toBe(true);
    if (!secondToken.ok) return;
    const refreshed = withStableTestIdIdentity(
      createCaptureRecord("save", "Save changes"),
      "save",
    );
    refreshed.capturedAt = "2026-07-11T10:05:00.000Z";
    refreshed.attachment.capturedAt = refreshed.capturedAt;
    refreshed.attachment.element.bbox = { x: 30, y: 40, width: 140, height: 44 };

    const second = await store.commitCapture(secondToken.value, refreshed);

    expect(second.ok).toBe(true);
    if (!second.ok) return;
    expect(second.value).toMatchObject({ itemId: "att_save", label: "A" });
    expect(second.value.readback.file?.session.attachments).toHaveLength(1);
    expect(second.value.readback.file?.session.attachments[0]).toMatchObject({
      id: "att_save",
      labels: ["A"],
      sourceRecord: {
        intent: "Keep this instruction",
        capturedAt: "2026-07-11T10:05:00.000Z",
        attachment: { element: { bbox: { x: 30, y: 40, width: 140, height: 44 } } },
      },
    });
    expect(storage.peek(ORIGIN_CAPTURE_KEY)).toMatchObject({
      capturedAt: "2026-07-11T10:05:00.000Z",
    });
    expect(storage.peek(LATEST_CAPTURE_KEY)).toMatchObject({
      capturedAt: "2026-07-11T10:05:00.000Z",
    });
    expect(storage.peek(SESSION_META_KEY)).toMatchObject({
      receipts: [
        { operationId: "op-1", itemId: "att_save" },
        { operationId: "op-2", itemId: "att_save" },
      ],
    });
  });

  test("allows a full session to recapture a stable target but rejects a distinct 27th item", async () => {
    const records = Array.from({ length: 26 }, (_, index) => {
      const id = index === 0 ? "save" : `item_${index + 1}`;
      const name = index === 0 ? "Save changes" : `Item ${index + 1}`;
      const record = createCaptureRecord(id, name);
      return index === 0 ? withStableTestIdIdentity(record, "save") : record;
    });
    const storage = new RecordingStorage();
    storage.seed({
      [SESSION_KEY]: createSessionFile(records),
      [SESSION_META_KEY]: createSessionMeta("epoch-1"),
    });
    const store = createExtensionSessionStore({
      storage,
      now: sequenceClock("2026-07-11T02:00:00.000Z", "2026-07-11T02:01:00.000Z"),
      randomUUID: sequenceUuid("op-refresh", "op-27"),
    });

    const refreshToken = await store.beginCapture(ORIGIN);
    expect(refreshToken.ok).toBe(true);
    if (!refreshToken.ok) return;
    const refreshed = await store.commitCapture(
      refreshToken.value,
      withStableTestIdIdentity(createCaptureRecord("save", "Save changes"), "save"),
    );
    expect(refreshed.ok).toBe(true);
    if (!refreshed.ok) return;
    expect(refreshed.value.itemId).toBe("att_save");
    expect(refreshed.value.readback.file?.session.attachments).toHaveLength(26);

    const distinctToken = await store.beginCapture(ORIGIN);
    expect(distinctToken.ok).toBe(true);
    if (!distinctToken.ok) return;
    const distinct = await store.commitCapture(
      distinctToken.value,
      createCaptureRecord("item_27", "Item 27"),
    );
    expect(distinct).toMatchObject({ ok: false, code: "SESSION_FULL" });
    const readback = await store.read(ORIGIN);
    expect(readback.ok).toBe(true);
    if (!readback.ok) return;
    expect(readback.value.file?.session.attachments).toHaveLength(26);
  });

  test("serializes concurrent commits and keeps the queue usable after a rejection", async () => {
    const storage = new RecordingStorage();
    const store = createExtensionSessionStore({
      storage,
      now: sequenceClock(
        "2026-07-11T02:00:00.000Z",
        "2026-07-11T02:01:00.000Z",
        "2026-07-11T02:02:00.000Z",
      ),
      randomUUID: sequenceUuid("epoch-1", "op-1", "op-2", "op-3"),
    });

    const firstToken = await store.beginCapture(ORIGIN);
    const secondToken = await store.beginCapture(ORIGIN);
    expect(firstToken.ok).toBe(true);
    expect(secondToken.ok).toBe(true);
    if (!firstToken.ok || !secondToken.ok) return;

    const [first, second] = await Promise.all([
      store.commitCapture(firstToken.value, createCaptureRecord("save", "Save")),
      store.commitCapture(secondToken.value, createCaptureRecord("cancel", "Cancel")),
    ]);

    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    expect(second.value.readback.file?.session.attachments.map((item) => item.id)).toEqual([
      "att_save",
      "att_cancel",
    ]);

    const failedToken = await store.beginCapture(ORIGIN);
    expect(failedToken.ok).toBe(true);
    if (!failedToken.ok) return;
    storage.failNextSet("quota exceeded");
    const failed = await store.commitCapture(
      failedToken.value,
      createCaptureRecord("delete", "Delete"),
    );
    expect(failed).toMatchObject({ ok: false, code: "STORAGE_ERROR" });
    await expect(store.read(ORIGIN)).resolves.toMatchObject({
      ok: true,
      value: {
        file: { session: { attachments: [{ id: "att_save" }, { id: "att_cancel" }] } },
      },
    });

    const laterToken = await store.beginCapture(ORIGIN);
    expect(laterToken.ok).toBe(true);
    if (!laterToken.ok) return;
    const later = await store.commitCapture(
      laterToken.value,
      createCaptureRecord("delete", "Delete"),
    );
    expect(later.ok).toBe(true);
    if (!later.ok) return;
    expect(later.value.readback.file?.session.attachments.map((item) => item.id)).toEqual([
      "att_save",
      "att_cancel",
      "att_delete",
    ]);
  });

  test("rejects stale epochs and preserves invalid stored sessions", async () => {
    const storage = new RecordingStorage();
    storage.seed({
      [SESSION_KEY]: { kind: "not-a-session" },
      [SESSION_META_KEY]: createSessionMeta("epoch-1"),
    });
    const store = createExtensionSessionStore({
      storage,
      now: sequenceClock("2026-07-11T02:00:00.000Z"),
      randomUUID: sequenceUuid("op-1"),
    });

    await expect(store.beginCapture(ORIGIN)).resolves.toMatchObject({
      ok: false,
      code: "INVALID_SESSION_FILE",
    });
    expect(storage.peek(SESSION_KEY)).toEqual({ kind: "not-a-session" });

    storage.clearCalls();
    storage.seed({
      [SESSION_KEY]: createSessionFile([createCaptureRecord("save", "Save")]),
      [SESSION_META_KEY]: createSessionMeta("epoch-live"),
    });
    const stale = await store.updateIntent(ORIGIN, "epoch-old", "att_save", "Stale");
    expect(stale).toMatchObject({ ok: false, code: "STALE_SESSION" });
    expect(storage.setCalls).toEqual([]);
  });

  test("removing an already-absent item succeeds for the same epoch without changing readback", async () => {
    const storage = new RecordingStorage();
    const file = createSessionFile([
      createCaptureRecord("save", "Save"),
      createCaptureRecord("cancel", "Cancel"),
    ]);
    const meta = createSessionMeta("epoch-live");
    const legacy = createCaptureRecord("cancel", "Cancel");
    storage.seed({
      [SESSION_KEY]: file,
      [SESSION_META_KEY]: meta,
      [ORIGIN_CAPTURE_KEY]: legacy,
    });
    const store = createExtensionSessionStore({ storage });
    const before = await store.read(ORIGIN);
    expect(before.ok).toBe(true);
    if (!before.ok) return;

    const removed = await store.removeItem(ORIGIN, "epoch-live", "att_missing");

    expect(removed.ok).toBe(true);
    if (!removed.ok) return;
    expect(removed.value).toEqual(before.value);
    expect(storage.peek(SESSION_KEY)).toEqual(file);
    expect(storage.peek(SESSION_META_KEY)).toEqual(meta);
    expect(storage.peek(ORIGIN_CAPTURE_KEY)).toEqual(legacy);
  });

  test("removing the projected item purges its origin and matching global compatibility records", async () => {
    const storage = new RecordingStorage();
    const save = createCaptureRecord("save", "Save");
    const cancel = createCaptureRecord("cancel", "Cancel");
    storage.seed({
      [SESSION_KEY]: createSessionFile([save, cancel]),
      [SESSION_META_KEY]: createSessionMeta("epoch-live"),
      [ORIGIN_CAPTURE_KEY]: cancel,
      [LATEST_CAPTURE_KEY]: cancel,
    });
    const store = createExtensionSessionStore({
      storage,
      now: sequenceClock("2026-07-11T02:05:00.000Z"),
    });

    const removed = await store.removeItem(ORIGIN, "epoch-live", "att_cancel");

    expect(removed.ok).toBe(true);
    if (!removed.ok) return;
    expect(removed.value.file?.session.attachments.map((item) => item.id)).toEqual(["att_save"]);
    expect(removed.value.legacyRecord).toBeNull();
    expect(storage.peek(ORIGIN_CAPTURE_KEY)).toBeUndefined();
    expect(storage.peek(LATEST_CAPTURE_KEY)).toBeUndefined();
    expect(storage.operations.slice(-2)).toEqual([
      { type: "remove", keys: [ORIGIN_CAPTURE_KEY, LATEST_CAPTURE_KEY] },
      { type: "set", keys: [SESSION_KEY, SESSION_META_KEY] },
    ]);
  });

  test("keeps a failed canonical Remove retryable after privacy-first projection purge", async () => {
    const storage = new RecordingStorage();
    const save = createCaptureRecord("save", "Save");
    const cancel = createCaptureRecord("cancel", "Cancel");
    const original = createSessionFile([save, cancel]);
    storage.seed({
      [SESSION_KEY]: original,
      [SESSION_META_KEY]: createSessionMeta("epoch-live"),
      [ORIGIN_CAPTURE_KEY]: cancel,
      [LATEST_CAPTURE_KEY]: cancel,
    });
    const store = createExtensionSessionStore({
      storage,
      now: sequenceClock("2026-07-11T02:05:00.000Z"),
    });
    storage.failNextSet("canonical write interrupted");

    await expect(store.removeItem(ORIGIN, "epoch-live", "att_cancel")).resolves.toMatchObject({
      ok: false,
      code: "STORAGE_ERROR",
    });
    expect(storage.peek(SESSION_KEY)).toEqual(original);
    expect(storage.peek(ORIGIN_CAPTURE_KEY)).toBeUndefined();
    expect(storage.peek(LATEST_CAPTURE_KEY)).toBeUndefined();

    const retried = await store.removeItem(ORIGIN, "epoch-live", "att_cancel");
    expect(retried.ok).toBe(true);
    if (!retried.ok) return;
    expect(retried.value.file?.session.attachments.map((item) => item.id)).toEqual(["att_save"]);
    expect(retried.value.legacyRecord).toBeNull();
  });

  test("removing a non-projected item preserves the newer compatibility record", async () => {
    const storage = new RecordingStorage();
    const save = createCaptureRecord("save", "Save");
    const cancel = createCaptureRecord("cancel", "Cancel");
    storage.seed({
      [SESSION_KEY]: createSessionFile([save, cancel]),
      [SESSION_META_KEY]: createSessionMeta("epoch-live"),
      [ORIGIN_CAPTURE_KEY]: cancel,
      [LATEST_CAPTURE_KEY]: cancel,
    });
    const store = createExtensionSessionStore({
      storage,
      now: sequenceClock("2026-07-11T02:05:00.000Z"),
    });

    const removed = await store.removeItem(ORIGIN, "epoch-live", "att_save");

    expect(removed.ok).toBe(true);
    if (!removed.ok) return;
    expect(removed.value.file?.session.attachments.map((item) => item.id)).toEqual(["att_cancel"]);
    expect(removed.value.legacyRecord?.attachment.id).toBe("att_cancel");
    expect(storage.peek(ORIGIN_CAPTURE_KEY)).toEqual(cancel);
    expect(storage.peek(LATEST_CAPTURE_KEY)).toEqual(cancel);
  });

  test("fails closed on corrupt metadata during ordinary reads without writes", async () => {
    const storage = new RecordingStorage();
    storage.seed({
      [SESSION_KEY]: createSessionFile([createCaptureRecord("save", "Save")]),
      [SESSION_META_KEY]: { corrupt: true },
    });
    const store = createExtensionSessionStore({ storage });

    const read = await store.read(ORIGIN);

    expect(read).toMatchObject({ ok: false, code: "INVALID_SESSION_FILE" });
    expect(storage.setCalls).toEqual([]);
    expect(storage.removeCalls).toEqual([]);
  });

  test("marks inconsistent pending-clear metadata for recoverable cleanup", async () => {
    const storage = new RecordingStorage();
    storage.seed({
      [SESSION_KEY]: createSessionFile([createCaptureRecord("save", "Save")]),
      [SESSION_META_KEY]: {
        ...createSessionMeta("epoch-stuck"),
        clearPending: true,
        activeClearOperationId: null,
      },
    });
    const store = createExtensionSessionStore({
      storage,
      randomUUID: sequenceUuid("epoch-recovered"),
    });

    await expect(store.list()).resolves.toMatchObject({
      ok: true,
      value: [{
        origin: ORIGIN,
        epoch: null,
        attachmentCount: 1,
        state: "needs_cleanup",
        clearPending: false,
        activeClearOperationId: null,
      }],
    });
    await expect(store.clear(ORIGIN, null, "clear-stuck")).resolves.toMatchObject({ ok: true });
    expect(storage.peek(SESSION_KEY)).toBeUndefined();
  });

  test("returns clear-in-progress before normalizing an invalid stale commit record", async () => {
    const storage = new RecordingStorage();
    storage.seed({
      [SESSION_KEY]: createSessionFile([createCaptureRecord("save", "Save")]),
      [SESSION_META_KEY]: {
        ...createSessionMeta("epoch-pending"),
        clearPending: true,
        activeClearOperationId: "clear-1",
      },
    });
    const store = createExtensionSessionStore({ storage });

    const committed = await store.commitCapture(
      { origin: ORIGIN, epoch: "epoch-old", operationId: "op-old" },
      createInvalidCaptureRecord(),
    );

    expect(committed).toMatchObject({ ok: false, code: "CLEAR_IN_PROGRESS" });
    expect(storage.setCalls).toEqual([]);
    expect(storage.removeCalls).toEqual([]);
  });

  test("exposes active clear operation id in exact readback shape", async () => {
    const storage = new RecordingStorage();
    storage.seed({
      [SESSION_META_KEY]: {
        ...createSessionMeta("epoch-clear"),
        clearPending: true,
        activeClearOperationId: "clear-1",
      },
    });
    const store = createExtensionSessionStore({ storage });

    const read = await store.read(ORIGIN);

    expect(read).toEqual({
      ok: true,
      value: {
        origin: ORIGIN,
        epoch: "epoch-clear",
        clearPending: true,
        activeClearOperationId: "clear-1",
        file: null,
        legacyRecord: null,
      },
    });
  });
});

describe("extension session clear recovery", () => {
  test("writes pending clear before remove, resumes after interruption, and blocks work", async () => {
    const storage = new RecordingStorage();
    const store = createExtensionSessionStore({
      storage,
      now: sequenceClock("2026-07-11T02:00:00.000Z"),
      randomUUID: sequenceUuid("epoch-1", "op-1", "epoch-clear", "op-blocked"),
    });
    const begun = await store.beginCapture(ORIGIN);
    expect(begun.ok).toBe(true);
    if (!begun.ok) return;
    const committed = await store.commitCapture(begun.value, createCaptureRecord("save", "Save"));
    expect(committed.ok).toBe(true);
    if (!committed.ok) return;

    storage.failNextRemove("remove interrupted");
    const interrupted = await store.clear(ORIGIN, "epoch-1", "clear-1");

    expect(interrupted).toMatchObject({ ok: false, code: "STORAGE_ERROR" });
    expect(storage.peek(SESSION_META_KEY)).toMatchObject({
      epoch: "epoch-clear",
      clearPending: true,
      activeClearOperationId: "clear-1",
    });
    await expect(store.beginCapture(ORIGIN)).resolves.toMatchObject({
      ok: false,
      code: "CLEAR_IN_PROGRESS",
    });
    await expect(store.read(ORIGIN)).resolves.toMatchObject({
      ok: true,
      value: { epoch: "epoch-clear", clearPending: true },
    });

    const retried = await store.clear(ORIGIN, "epoch-1", "clear-1");

    expect(retried.ok).toBe(true);
    if (!retried.ok) return;
    expect(retried.value).toMatchObject({
      epoch: "epoch-clear",
      clearPending: false,
      file: null,
      legacyRecord: null,
    });
    expect(storage.peek(SESSION_KEY)).toBeUndefined();
    expect(storage.peek(ORIGIN_CAPTURE_KEY)).toBeUndefined();
    expect(storage.peek(LATEST_CAPTURE_KEY)).toBeUndefined();
  });

  test("leaves the session untouched when clear phase 1 pending write fails", async () => {
    const storage = new RecordingStorage();
    const store = createExtensionSessionStore({
      storage,
      now: sequenceClock("2026-07-11T02:00:00.000Z"),
      randomUUID: sequenceUuid("epoch-1", "op-1", "epoch-clear"),
    });
    const begun = await store.beginCapture(ORIGIN);
    expect(begun.ok).toBe(true);
    if (!begun.ok) return;
    const committed = await store.commitCapture(begun.value, createCaptureRecord("save", "Save"));
    expect(committed.ok).toBe(true);
    if (!committed.ok) return;
    const originalSession = storage.peek(SESSION_KEY);
    const originalMeta = storage.peek(SESSION_META_KEY);
    const originalProjection = storage.peek(ORIGIN_CAPTURE_KEY);
    const originalLatest = storage.peek(LATEST_CAPTURE_KEY);
    storage.clearCalls();
    storage.failNextSet("phase 1 interrupted");

    const interrupted = await store.clear(ORIGIN, "epoch-1", "clear-1");

    expect(interrupted).toMatchObject({ ok: false, code: "STORAGE_ERROR" });
    expect(storage.removeCalls).toEqual([]);
    expect(storage.peek(SESSION_KEY)).toEqual(originalSession);
    expect(storage.peek(SESSION_META_KEY)).toEqual(originalMeta);
    expect(storage.peek(ORIGIN_CAPTURE_KEY)).toEqual(originalProjection);
    expect(storage.peek(LATEST_CAPTURE_KEY)).toEqual(originalLatest);
  });

  test("keeps pending metadata when clear phase 3 final write fails and retry completes", async () => {
    const storage = new RecordingStorage();
    const store = createExtensionSessionStore({
      storage,
      now: sequenceClock("2026-07-11T02:00:00.000Z"),
      randomUUID: sequenceUuid("epoch-1", "op-1", "epoch-clear"),
    });
    const begun = await store.beginCapture(ORIGIN);
    expect(begun.ok).toBe(true);
    if (!begun.ok) return;
    const committed = await store.commitCapture(begun.value, createCaptureRecord("save", "Save"));
    expect(committed.ok).toBe(true);
    if (!committed.ok) return;
    storage.clearCalls();
    storage.failSetCall(2, "phase 3 interrupted");

    const interrupted = await store.clear(ORIGIN, "epoch-1", "clear-1");

    expect(interrupted).toMatchObject({ ok: false, code: "STORAGE_ERROR" });
    expect(storage.peek(SESSION_META_KEY)).toMatchObject({
      epoch: "epoch-clear",
      clearPending: true,
      activeClearOperationId: "clear-1",
    });
    expect(storage.peek(SESSION_KEY)).toBeUndefined();
    expect(storage.peek(ORIGIN_CAPTURE_KEY)).toBeUndefined();
    expect(storage.peek(LATEST_CAPTURE_KEY)).toBeUndefined();

    const retried = await store.clear(ORIGIN, "epoch-1", "clear-1");

    expect(retried).toMatchObject({
      ok: true,
      value: { epoch: "epoch-clear", clearPending: false, file: null, legacyRecord: null },
    });
  });

  test("clears in pending-remove-complete order with exact keys and guarded latest removal", async () => {
    const storage = new RecordingStorage();
    const other = createCaptureRecord("other", "Other");
    other.origin = OTHER_ORIGIN;
    storage.seed({
      [SESSION_KEY]: createSessionFile([createCaptureRecord("save", "Save")]),
      [SESSION_META_KEY]: createSessionMeta("epoch-1"),
      [ORIGIN_CAPTURE_KEY]: createCaptureRecord("save", "Save"),
      [LATEST_CAPTURE_KEY]: other,
      [FIRST_CAPTURE_DISCLOSURE_STORAGE_KEY]: {
        disclosureId: FIRST_CAPTURE_DISCLOSURE_ID,
        acknowledged: true,
      },
    });
    const store = createExtensionSessionStore({
      storage,
      randomUUID: sequenceUuid("epoch-clear"),
    });

    const cleared = await store.clear(ORIGIN, "epoch-1", "clear-1");

    expect(cleared.ok).toBe(true);
    expect(storage.operations).toEqual([
      { type: "set", keys: [SESSION_META_KEY] },
      { type: "remove", keys: [SESSION_KEY, ORIGIN_CAPTURE_KEY] },
      { type: "set", keys: [SESSION_META_KEY] },
    ]);
    expect(storage.peek(LATEST_CAPTURE_KEY)).toEqual(other);
    expect(storage.peek(FIRST_CAPTURE_DISCLOSURE_STORAGE_KEY)).toEqual({
      disclosureId: FIRST_CAPTURE_DISCLOSURE_ID,
      acknowledged: true,
    });
  });

  test("does not let an old completed clear delete a later session", async () => {
    const storage = new RecordingStorage();
    const store = createExtensionSessionStore({
      storage,
      now: sequenceClock("2026-07-11T02:00:00.000Z", "2026-07-11T02:01:00.000Z"),
      randomUUID: sequenceUuid("epoch-1", "op-1", "epoch-2", "op-2"),
    });
    const begun = await store.beginCapture(ORIGIN);
    expect(begun.ok).toBe(true);
    if (!begun.ok) return;
    const committed = await store.commitCapture(begun.value, createCaptureRecord("save", "Save"));
    expect(committed.ok).toBe(true);
    if (!committed.ok) return;
    const cleared = await store.clear(ORIGIN, "epoch-1", "clear-1");
    expect(cleared.ok).toBe(true);
    if (!cleared.ok) return;

    const laterToken = await store.beginCapture(ORIGIN);
    expect(laterToken.ok).toBe(true);
    if (!laterToken.ok) return;
    const later = await store.commitCapture(
      laterToken.value,
      createCaptureRecord("cancel", "Cancel"),
    );
    expect(later.ok).toBe(true);
    if (!later.ok) return;

    const oldRetry = await store.clear(ORIGIN, "epoch-1", "clear-1");

    expect(oldRetry.ok).toBe(true);
    if (!oldRetry.ok) return;
    expect(oldRetry.value.file?.session.attachments.map((item) => item.id)).toEqual([
      "att_cancel",
    ]);
  });

  test("recovers corrupt session values with epoch-null clear and guarded latest removal", async () => {
    const storage = new RecordingStorage();
    const matching = createCaptureRecord("save", "Save");
    const other = createCaptureRecord("other", "Other");
    other.origin = OTHER_ORIGIN;
    storage.seed({
      [SESSION_KEY]: { corrupt: true },
      [SESSION_META_KEY]: { also: "corrupt" },
      [ORIGIN_CAPTURE_KEY]: matching,
      [LATEST_CAPTURE_KEY]: other,
    });
    const store = createExtensionSessionStore({
      storage,
      randomUUID: sequenceUuid("epoch-recovery"),
    });

    const recovered = await store.clear(ORIGIN, null, "clear-corrupt");

    expect(recovered.ok).toBe(true);
    if (!recovered.ok) return;
    expect(storage.peek(SESSION_KEY)).toBeUndefined();
    expect(storage.peek(SESSION_META_KEY)).toMatchObject({
      epoch: "epoch-recovery",
      clearPending: false,
      lastCompletedClearOperationId: "clear-corrupt",
    });
    expect(storage.peek(ORIGIN_CAPTURE_KEY)).toBeUndefined();
    expect(storage.peek(LATEST_CAPTURE_KEY)).toEqual(other);
  });

  test("rejects epoch-null recovery clear for a healthy valid session without deleting it", async () => {
    const storage = new RecordingStorage();
    const file = createSessionFile([createCaptureRecord("save", "Save")]);
    const meta = createSessionMeta("epoch-live");
    const matching = createCaptureRecord("save", "Save");
    storage.seed({
      [SESSION_KEY]: file,
      [SESSION_META_KEY]: meta,
      [ORIGIN_CAPTURE_KEY]: matching,
      [LATEST_CAPTURE_KEY]: matching,
    });
    const store = createExtensionSessionStore({
      storage,
      randomUUID: sequenceUuid("epoch-recovery"),
    });

    const rejected = await store.clear(ORIGIN, null, "clear-null-epoch");

    expect(rejected).toMatchObject({ ok: false, code: "STALE_SESSION" });
    expect(storage.peek(SESSION_KEY)).toEqual(file);
    expect(storage.peek(SESSION_META_KEY)).toEqual(meta);
    expect(storage.peek(ORIGIN_CAPTURE_KEY)).toEqual(matching);
    expect(storage.peek(LATEST_CAPTURE_KEY)).toEqual(matching);
    expect(storage.removeCalls).toEqual([]);
  });
});

class RecordingStorage implements ExtensionStorageArea {
  private values = new Map<string, unknown>();
  private nextSetError: string | null = null;
  private setFailures = new Map<number, string>();
  private nextRemoveError: string | null = null;
  readonly getCalls: Array<string | string[] | null> = [];
  readonly setCalls: Array<Record<string, unknown>> = [];
  readonly removeCalls: string[][] = [];
  readonly operations: Array<{ type: "set" | "remove"; keys: string[] }> = [];

  seed(items: Record<string, unknown>): void {
    for (const [key, value] of Object.entries(items)) {
      this.values.set(key, structuredClone(value));
    }
  }

  peek(key: string): unknown {
    return structuredClone(this.values.get(key));
  }

  clearCalls(): void {
    this.getCalls.length = 0;
    this.setCalls.length = 0;
    this.removeCalls.length = 0;
    this.operations.length = 0;
    this.setFailures.clear();
  }

  failNextSet(message: string): void {
    this.nextSetError = message;
  }

  failSetCall(callNumber: number, message: string): void {
    this.setFailures.set(callNumber, message);
  }

  failNextRemove(message: string): void {
    this.nextRemoveError = message;
  }

  async get(keys: string | string[] | null): Promise<Record<string, unknown>> {
    this.getCalls.push(Array.isArray(keys) ? [...keys] : keys);
    if (keys === null) {
      return Object.fromEntries(
        Array.from(this.values, ([key, value]) => [key, structuredClone(value)]),
      );
    }
    const requestedKeys = Array.isArray(keys) ? keys : [keys];
    return Object.fromEntries(
      requestedKeys.map((key) => [key, structuredClone(this.values.get(key))]),
    );
  }

  async set(items: Record<string, unknown>): Promise<void> {
    this.operations.push({ type: "set", keys: Object.keys(items) });
    this.setCalls.push(structuredClone(items));
    if (this.nextSetError) {
      const message = this.nextSetError;
      this.nextSetError = null;
      throw new Error(message);
    }
    const callError = this.setFailures.get(this.setCalls.length);
    if (callError) {
      this.setFailures.delete(this.setCalls.length);
      throw new Error(callError);
    }
    for (const [key, value] of Object.entries(items)) {
      this.values.set(key, structuredClone(value));
    }
  }

  async remove(keys: string | string[]): Promise<void> {
    const requestedKeys = Array.isArray(keys) ? keys : [keys];
    this.operations.push({ type: "remove", keys: [...requestedKeys] });
    this.removeCalls.push([...requestedKeys]);
    if (this.nextRemoveError) {
      const message = this.nextRemoveError;
      this.nextRemoveError = null;
      throw new Error(message);
    }
    for (const key of requestedKeys) {
      this.values.delete(key);
    }
  }
}

function createSessionFileForOrigin(origin: string, records: OriginCaptureRecord[]) {
  const file = createSessionFile(records);
  file.session.origin = origin;
  if (records.length === 0) file.session.title = null;
  for (const item of file.session.attachments) {
    item.sourceRecord.origin = origin;
    item.sourceRecord.pageUrl = `${origin}/settings`;
    if (item.sourceRecord.attachment.source.kind === "web") {
      item.sourceRecord.attachment.source.url = `${origin}/settings`;
    }
    item.sourceRecord.attachment.policy.allowedDomains = [origin];
  }
  return file;
}

function sequenceClock(...timestamps: string[]): () => Date {
  let index = 0;
  return () => new Date(timestamps[Math.min(index++, timestamps.length - 1)]);
}

function sequenceUuid(...values: string[]): () => string {
  let index = 0;
  return () => values[Math.min(index++, values.length - 1)];
}

function createInvalidCaptureRecord(): OriginCaptureRecord {
  return {
    ...createCaptureRecord("invalid", "Invalid"),
    attachment: {} as OriginCaptureRecord["attachment"],
  };
}

function withStableTestIdIdentity(
  record: OriginCaptureRecord,
  testId: string,
): OriginCaptureRecord {
  const value = `page.getByTestId("${testId}")`;
  record.attachment.locatorBundle.candidates = [
    ...record.attachment.locatorBundle.candidates,
    { strategy: "playwright.testId", value, confidence: 0.86 },
  ];
  record.replayAttempts = [
    ...(record.replayAttempts ?? []),
    {
      strategy: "playwright.testId",
      value,
      replayVerified: true,
      uniqueness: true,
      failureReason: null,
      matchCount: 1,
      visible: true,
    },
  ];
  return record;
}
