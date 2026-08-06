import { describe, expect, test } from "vitest";
import { createCaptureRecord } from "../test/session-fixtures";
import {
  beginCapture,
  commitCapture,
  completeClearSession,
  createSessionMeta,
  removeSessionItem,
  startClearSession,
  updateSessionIntent,
  type SessionState,
} from "./session-state";

describe("extension capture session state", () => {
  test("creates session-1 and assigns stable A/B labels to distinct targets", () => {
    const initial = { file: null, meta: createSessionMeta("epoch-1") };
    const firstToken = beginCapture(initial, "https://app.example.test", "op-1");
    expect(firstToken.ok).toBe(true);
    if (!firstToken.ok) return;

    const first = commitCapture(
      initial,
      firstToken.value,
      createCaptureRecord("save", "Save changes"),
      "2026-07-11T01:00:00.000Z",
    );
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    expect(first.value.file?.session).toMatchObject({
      id: "session-1",
      title: null,
      createdAt: "2026-07-11T01:00:00.000Z",
      updatedAt: "2026-07-11T01:00:00.000Z",
    });
    expect(first.value.file?.session.attachments[0]).toMatchObject({
      id: "att_save",
      labels: ["A"],
      createdAt: "2026-07-11T01:00:00.000Z",
    });
    expect(first.value.file?.session.attachments[0].sourceRecord).not.toHaveProperty("markdown");
    expect(first.value.file?.session.attachments[0].sourceRecord).not.toHaveProperty("summary");
    expect(first.value.file?.session.attachments[0].sourceRecord.capturedAt).toBe(
      "2026-07-11T10:00:00.000Z",
    );

    const secondToken = beginCapture(first.value, firstToken.value.origin, "op-2");
    expect(secondToken.ok).toBe(true);
    if (!secondToken.ok) return;
    const secondRecord = createCaptureRecord("save", "Save changes");
    secondRecord.attachment.locatorBundle.stability = {
      ...secondRecord.attachment.locatorBundle.stability,
      uniqueness: false,
      replayVerified: false,
      verifiedBy: null,
      verifiedValue: null,
    };
    const second = commitCapture(
      first.value,
      secondToken.value,
      secondRecord,
      "2026-07-11T01:01:00.000Z",
    );
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    expect(second.value.file?.session.attachments.map(({ id, labels }) => [id, labels])).toEqual([
      ["att_save", ["A"]],
      ["att_save-2", ["B"]],
    ]);
  });

  test("refreshes a recaptured verified target without changing its item, label, or intent", () => {
    const initial = createStateWithItems(1);
    addStoredStableTestIdIdentity(initial, "att_save", "save");
    const withIntent = updateSessionIntent(
      initial,
      initial.meta.epoch,
      "att_save",
      "Keep this instruction",
      "2026-07-11T01:02:00.000Z",
    );
    expect(withIntent.ok).toBe(true);
    if (!withIntent.ok) return;
    const token = beginCapture(withIntent.value, withIntent.value.file!.session.origin, "op-refresh");
    expect(token.ok).toBe(true);
    if (!token.ok) return;
    const refreshed = withStableTestIdIdentity(
      createCaptureRecord("save", "Save changes"),
      "save",
    );
    refreshed.pageUrl = "https://app.example.test/settings?tab=profile#actions";
    refreshed.capturedAt = "2026-07-11T10:05:00.000Z";
    refreshed.attachment.capturedAt = refreshed.capturedAt;
    refreshed.attachment.element.bbox = { x: 40, y: 60, width: 120, height: 40 };

    const committed = commitCapture(
      withIntent.value,
      token.value,
      refreshed,
      "2026-07-11T01:03:00.000Z",
    );

    expect(committed.ok).toBe(true);
    if (!committed.ok) return;
    expect(committed.value.file?.session.attachments).toHaveLength(1);
    expect(committed.value.file?.session.updatedAt).toBe("2026-07-11T01:03:00.000Z");
    expect(committed.value.file?.session.attachments[0]).toMatchObject({
      id: "att_save",
      labels: ["A"],
      createdAt: "2026-07-11T01:00:00.000Z",
      sourceRecord: {
        intent: "Keep this instruction",
        capturedAt: "2026-07-11T10:05:00.000Z",
        attachment: {
          element: { bbox: { x: 40, y: 60, width: 120, height: 40 } },
        },
      },
    });
    expect(committed.value.meta.receipts.at(-1)).toEqual({
      operationId: "op-refresh",
      itemId: "att_save",
    });
    expect(withIntent.value.file?.session.attachments[0].sourceRecord.capturedAt).not.toBe(
      "2026-07-11T10:05:00.000Z",
    );
  });

  test.each([
    ["another pathname", { pageUrl: "https://app.example.test/account" }],
    ["another tab", { tabId: 2 }],
  ])("does not merge the same verified locator on %s", (_name, overrides) => {
    const initial = createStateWithItems(1);
    addStoredStableTestIdIdentity(initial, "att_save", "save");
    const token = beginCapture(initial, initial.file!.session.origin, `op-${_name}`);
    expect(token.ok).toBe(true);
    if (!token.ok) return;
    const other = withStableTestIdIdentity(
      createCaptureRecord("save", "Save changes"),
      "save",
    );
    Object.assign(other, overrides);

    const committed = commitCapture(
      initial,
      token.value,
      other,
      "2026-07-11T01:03:00.000Z",
    );

    expect(committed.ok).toBe(true);
    if (!committed.ok) return;
    expect(committed.value.file?.session.attachments.map(({ id, labels }) => [id, labels])).toEqual([
      ["att_save", ["A"]],
      ["att_save-2", ["B"]],
    ]);
  });

  test("keeps sequential same-name controls separate without stable test-id identity", () => {
    const initial = createStateWithItems(1);
    const token = beginCapture(initial, initial.file!.session.origin, "op-next-save");
    expect(token.ok).toBe(true);
    if (!token.ok) return;

    const committed = commitCapture(
      initial,
      token.value,
      createCaptureRecord("save", "Save changes"),
      "2026-07-11T01:03:00.000Z",
    );

    expect(committed.ok).toBe(true);
    if (!committed.ok) return;
    expect(committed.value.file?.session.attachments.map(({ id, labels }) => [id, labels])).toEqual([
      ["att_save", ["A"]],
      ["att_save-2", ["B"]],
    ]);
  });

  test("rejects captures for a different origin without changing state", () => {
    const state = createStateWithTwoItems();
    const begin = beginCapture(state, "https://other.example.test", "op-other");
    expect(begin).toMatchObject({ ok: false, code: "STALE_SESSION" });

    const token = beginCapture(state, state.file!.session.origin, "op-bad-record");
    expect(token.ok).toBe(true);
    if (!token.ok) return;
    const record = createCaptureRecord("other", "Other origin");
    record.origin = "https://other.example.test";

    const committed = commitCapture(
      state,
      token.value,
      record,
      "2026-07-11T01:03:00.000Z",
    );

    expect(committed).toMatchObject({ ok: false, code: "STALE_CAPTURE_OPERATION" });
    expect(state.file!.session.attachments.map(({ id }) => id)).toEqual(["att_save", "att_cancel"]);
  });

  test("reuses the lowest free label without renumbering existing items", () => {
    const state = createStateWithTwoItems();
    const removed = removeSessionItem(
      state,
      state.meta.epoch,
      "att_save",
      "2026-07-11T01:03:00.000Z",
    );
    expect(removed.ok).toBe(true);
    if (!removed.ok) return;
    expect(removed.value.file?.session.attachments.map(({ id, labels }) => [id, labels])).toEqual([
      ["att_cancel", ["B"]],
    ]);

    const token = beginCapture(removed.value, removed.value.file!.session.origin, "op-3");
    expect(token.ok).toBe(true);
    if (!token.ok) return;
    const added = commitCapture(
      removed.value,
      token.value,
      createCaptureRecord("delete", "Delete"),
      "2026-07-11T01:04:00.000Z",
    );

    expect(added.ok).toBe(true);
    if (!added.ok) return;
    expect(added.value.file?.session.attachments.map(({ id, labels }) => [id, labels])).toEqual([
      ["att_cancel", ["B"]],
      ["att_delete", ["A"]],
    ]);
  });

  test("updates timestamps immutably and never moves updatedAt backward", () => {
    const state = createStateWithTwoItems();
    const originalItemCreatedAt = state.file!.session.attachments[0].createdAt;
    const unchanged = updateSessionIntent(
      state,
      state.meta.epoch,
      "att_save",
      "Update Save changes",
      "2026-07-11T01:04:00.000Z",
    );
    expect(unchanged.ok).toBe(true);
    if (!unchanged.ok) return;
    expect(unchanged.value.file?.session.updatedAt).toBe("2026-07-11T01:01:00.000Z");

    const changed = updateSessionIntent(
      unchanged.value,
      unchanged.value.meta.epoch,
      "att_save",
      "Confirm Save changes",
      "2026-07-11T01:05:00.000Z",
    );
    expect(changed.ok).toBe(true);
    if (!changed.ok) return;
    expect(changed.value.file?.session.updatedAt).toBe("2026-07-11T01:05:00.000Z");
    expect(changed.value.file?.session.attachments[0].createdAt).toBe(originalItemCreatedAt);
    expect(state.file!.session.attachments[0].sourceRecord.intent).toBe("Update Save changes");

    const notBackward = removeSessionItem(
      changed.value,
      changed.value.meta.epoch,
      "att_cancel",
      "2026-07-11T01:02:00.000Z",
    );
    expect(notBackward.ok).toBe(true);
    if (!notBackward.ok) return;
    expect(notBackward.value.file?.session.updatedAt).toBe("2026-07-11T01:05:00.000Z");
  });

  test("returns update lookup and size errors without changing state", () => {
    const state = createStateWithTwoItems();
    const missingUpdate = updateSessionIntent(
      state,
      state.meta.epoch,
      "missing",
      "Missing",
      "2026-07-11T01:06:00.000Z",
    );
    expect(missingUpdate).toMatchObject({ ok: false, code: "ITEM_NOT_FOUND" });
    const token = beginCapture(state, state.file!.session.origin, "op-too-large");
    expect(token.ok).toBe(true);
    if (!token.ok) return;
    const record = createCaptureRecord("large", "Large");
    record.intent = "x".repeat(1_100_000);
    const tooLarge = commitCapture(state, token.value, record, "2026-07-11T01:06:00.000Z");

    expect(tooLarge).toMatchObject({ ok: false, code: "SESSION_TOO_LARGE" });
    expect(state.file!.session.attachments).toHaveLength(2);
  });

  test("removing an already-absent item succeeds idempotently for the same epoch", () => {
    const state = createStateWithTwoItems();
    const originalFile = structuredClone(state.file);
    const originalMeta = structuredClone(state.meta);

    const missingRemove = removeSessionItem(
      state,
      state.meta.epoch,
      "missing",
      "2026-07-11T01:06:00.000Z",
    );

    expect(missingRemove.ok).toBe(true);
    if (!missingRemove.ok) return;
    expect(missingRemove.value.file).toEqual(originalFile);
    expect(missingRemove.value.meta).toEqual(originalMeta);
    expect(state.file).toEqual(originalFile);
    expect(state.meta).toEqual(originalMeta);
  });

  test("refuses the 27th item without changing state", () => {
    const full = createStateWithItems(26);
    const token = beginCapture(full, full.file!.session.origin, "op-27");
    expect(token.ok).toBe(true);
    if (!token.ok) return;

    const result = commitCapture(
      full,
      token.value,
      createCaptureRecord("item_27", "Item 27"),
      "2026-07-11T01:27:00.000Z",
    );

    expect(result).toMatchObject({ ok: false, code: "SESSION_FULL" });
    expect(full.file!.session.attachments).toHaveLength(26);
  });

  test("dedupes repeated operations and keeps the latest 64 receipts in order", () => {
    const first = createStateWithTwoItems();
    const retryToken = beginCapture(first, first.file!.session.origin, "op-2");
    expect(retryToken.ok).toBe(true);
    if (!retryToken.ok) return;
    const retry = commitCapture(
      first,
      retryToken.value,
      createCaptureRecord("cancel", "Cancel"),
      "2026-07-11T01:10:00.000Z",
    );
    expect(retry.ok).toBe(true);
    if (!retry.ok) return;
    expect(retry.value.file?.session.attachments).toHaveLength(2);
    expect(retry.value.meta.receipts.at(-1)).toEqual({
      operationId: "op-2",
      itemId: "att_cancel",
    });

    const manyReceipts = {
      file: first.file,
      meta: {
        ...first.meta,
        receipts: Array.from({ length: 65 }, (_unused, index) => ({
          operationId: `op-${index + 1}`,
          itemId: `att_${index + 1}`,
        })),
      },
    };
    const carried = updateSessionIntent(
      manyReceipts,
      manyReceipts.meta.epoch,
      "att_save",
      "Receipts retained",
      "2026-07-11T01:11:00.000Z",
    );
    expect(carried.ok).toBe(true);
    if (!carried.ok) return;
    expect(carried.value.meta.receipts).toHaveLength(64);
    expect(carried.value.meta.receipts[0].operationId).toBe("op-2");
    expect(carried.value.meta.receipts.at(-1)?.operationId).toBe("op-65");
    expect(carried.value.meta.receipts.some(({ operationId }) => operationId === "op-1")).toBe(
      false,
    );
  });

  test("rotates epoch and blocks all work while clear is pending", () => {
    const state = createStateWithTwoItems();
    const lateToken = beginCapture(state, state.file!.session.origin, "op-late");
    expect(lateToken.ok).toBe(true);
    if (!lateToken.ok) return;

    const started = startClearSession(state, state.meta.epoch, "clear-1", "epoch-2");
    expect(started.ok).toBe(true);
    if (!started.ok) return;
    expect(started.value.meta).toMatchObject({
      epoch: "epoch-2",
      clearPending: true,
      activeClearOperationId: "clear-1",
      receipts: [],
    });
    expect(beginCapture(started.value, state.file!.session.origin, "op-blocked")).toMatchObject({
      ok: false,
      code: "CLEAR_IN_PROGRESS",
    });
    expect(
      updateSessionIntent(
        started.value,
        started.value.meta.epoch,
        "att_save",
        "Blocked",
        "2026-07-11T01:08:00.000Z",
      ),
    ).toMatchObject({ ok: false, code: "CLEAR_IN_PROGRESS" });
    expect(
      updateSessionIntent(
        started.value,
        state.meta.epoch,
        "att_save",
        "Blocked stale update",
        "2026-07-11T01:08:00.000Z",
      ),
    ).toMatchObject({ ok: false, code: "CLEAR_IN_PROGRESS" });
    expect(
      removeSessionItem(
        started.value,
        state.meta.epoch,
        "att_save",
        "2026-07-11T01:08:00.000Z",
      ),
    ).toMatchObject({ ok: false, code: "CLEAR_IN_PROGRESS" });
    expect(
      commitCapture(
        started.value,
        lateToken.value,
        createCaptureRecord("late", "Late"),
        "2026-07-11T01:08:00.000Z",
      ),
    ).toMatchObject({ ok: false, code: "CLEAR_IN_PROGRESS" });

    const resumed = startClearSession(started.value, state.meta.epoch, "clear-1", "epoch-2");
    expect(resumed.ok).toBe(true);
    if (!resumed.ok) return;
    expect(resumed.value).toEqual(started.value);
  });

  test("completes clear idempotently and rejects stale clear requests", () => {
    const state = createStateWithTwoItems();
    const started = startClearSession(state, state.meta.epoch, "clear-1", "epoch-2");
    expect(started.ok).toBe(true);
    if (!started.ok) return;
    const completed = completeClearSession(started.value, "epoch-2", "clear-1");
    expect(completed.ok).toBe(true);
    if (!completed.ok) return;
    expect(completed.value).toMatchObject({
      file: null,
      meta: {
        epoch: "epoch-2",
        clearPending: false,
        activeClearOperationId: null,
        lastCompletedClearOperationId: "clear-1",
        receipts: [],
      },
    });

    const token = beginCapture(completed.value, "https://app.example.test", "op-after-clear");
    expect(token.ok).toBe(true);
    if (!token.ok) return;
    const later = commitCapture(
      completed.value,
      token.value,
      createCaptureRecord("after", "After clear"),
      "2026-07-11T02:00:00.000Z",
    );
    expect(later.ok).toBe(true);
    if (!later.ok) return;
    const repeatedComplete = completeClearSession(later.value, "epoch-2", "clear-1");
    expect(repeatedComplete.ok).toBe(true);
    if (!repeatedComplete.ok) return;
    expect(repeatedComplete.value.file?.session.attachments).toHaveLength(1);

    expect(completeClearSession(later.value, "epoch-1", "clear-other")).toMatchObject({
      ok: false,
      code: "STALE_SESSION",
    });
    expect(startClearSession(later.value, "epoch-1", "clear-other", "epoch-3")).toMatchObject({
      ok: false,
      code: "STALE_SESSION",
    });
  });
});

function createStateWithTwoItems(): SessionState {
  return createStateWithItems(2);
}

function createStateWithItems(count: number): SessionState {
  let state: SessionState = { file: null, meta: createSessionMeta("epoch-1") };
  for (let index = 1; index <= count; index += 1) {
    const id = index === 1 ? "save" : index === 2 ? "cancel" : `item_${index}`;
    const name = index === 1 ? "Save changes" : index === 2 ? "Cancel" : `Item ${index}`;
    const token = beginCapture(state, "https://app.example.test", `op-${index}`);
    if (!token.ok) {
      throw new Error(token.error);
    }
    const committed = commitCapture(
      state,
      token.value,
      createCaptureRecord(id, name),
      `2026-07-11T01:${String(index - 1).padStart(2, "0")}:00.000Z`,
    );
    if (!committed.ok) {
      throw new Error(committed.error);
    }
    state = committed.value;
  }
  return state;
}

function withStableTestIdIdentity(
  record: ReturnType<typeof createCaptureRecord>,
  testId: string,
): ReturnType<typeof createCaptureRecord> {
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

function addStoredStableTestIdIdentity(
  state: SessionState,
  itemId: string,
  testId: string,
): void {
  const item = state.file?.session.attachments.find((entry) => entry.id === itemId);
  if (!item) throw new Error(`Missing fixture item ${itemId}`);
  const record = withStableTestIdIdentity(
    createCaptureRecord(itemId.replace(/^att_/, ""), item.sourceRecord.attachment.element.accessibleName ?? ""),
    testId,
  );
  item.sourceRecord.attachment.locatorBundle = record.attachment.locatorBundle;
  item.sourceRecord.replayAttempts = record.replayAttempts;
}
