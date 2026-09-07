import type { CaptureSessionFileV2, CaptureSessionFileV3 } from "@meanthis/hub-core";
import { describe, expect, test } from "vitest";
import { createCaptureRecord, createSessionFile } from "../test/session-fixtures";
import {
  beginCapture,
  commitCapture,
  completeClearSession,
  createSessionMeta,
  removeSessionItem,
  startClearSession,
  updateSessionAnnotationLifecycle,
  updateSessionIntent,
  type SessionState,
} from "./session-state";

describe("extension capture session state", () => {
  test("creates an opaque annotation identity with equal item creation and update timestamps", () => {
    const initial = { file: null, meta: createSessionMeta("epoch-identity") };
    const token = beginCapture(initial, "https://app.example.test", "op-identity");
    expect(token.ok).toBe(true);
    if (!token.ok) return;

    const committed = commitCapture(
      initial,
      token.value,
      createCaptureRecord("save", "Save changes"),
      "2026-07-11T01:00:00.000Z",
      () => "opaque-random-annotation-a",
    );

    expect(committed.ok).toBe(true);
    if (!committed.ok) return;
    expect(committed.value.file).toMatchObject({
      schemaVersion: "0.3.0",
      session: {
        attachments: [{
          id: "att_save",
          annotationId: "opaque-random-annotation-a",
          createdAt: "2026-07-11T01:00:00.000Z",
          updatedAt: "2026-07-11T01:00:00.000Z",
          annotationLifecycle: {
            state: "open",
            resolvedAt: null,
          },
        }],
      },
    });
  });

  test("rejects an old receipt after hard-delete and same-item-id recreation", () => {
    const initial: SessionState = {
      file: null,
      meta: createSessionMeta("epoch-receipt-aba"),
    };
    const originalRecord = createCaptureRecord("save", "Save changes");
    const originalToken = beginCapture(
      initial,
      originalRecord.origin,
      "op-original-save",
    );
    expect(originalToken.ok).toBe(true);
    if (!originalToken.ok) return;
    const original = commitCapture(
      initial,
      originalToken.value,
      originalRecord,
      "2026-07-11T01:00:00.000Z",
      () => "opaque-original-annotation",
    );
    expect(original.ok).toBe(true);
    if (!original.ok) return;
    expect(original.value.meta.receipts.at(-1)).toEqual({
      operationId: "op-original-save",
      itemId: "att_save",
      annotationId: "opaque-original-annotation",
    });

    const ordinaryRetry = commitCapture(
      original.value,
      originalToken.value,
      originalRecord,
      "2026-07-11T01:00:30.000Z",
      () => "must-not-allocate-on-idempotent-retry",
    );
    expect(ordinaryRetry.ok).toBe(true);
    if (!ordinaryRetry.ok) return;
    expect(ordinaryRetry.value.file).toEqual(original.value.file);
    expect(ordinaryRetry.value.meta.receipts.at(-1)).toEqual({
      operationId: "op-original-save",
      itemId: "att_save",
      annotationId: "opaque-original-annotation",
    });

    const removed = removeSessionItem(
      ordinaryRetry.value,
      ordinaryRetry.value.meta.epoch,
      "att_save",
      "2026-07-11T01:01:00.000Z",
    );
    expect(removed.ok).toBe(true);
    if (!removed.ok) return;
    const recreateToken = beginCapture(
      removed.value,
      originalRecord.origin,
      "op-recreated-save",
    );
    expect(recreateToken.ok).toBe(true);
    if (!recreateToken.ok) return;
    const recreated = commitCapture(
      removed.value,
      recreateToken.value,
      createCaptureRecord("save", "Save changes recreated"),
      "2026-07-11T01:02:00.000Z",
      () => "opaque-recreated-annotation",
    );
    expect(recreated.ok).toBe(true);
    if (!recreated.ok) return;
    expect(recreated.value.file?.session.attachments[0]).toMatchObject({
      id: "att_save",
      annotationId: "opaque-recreated-annotation",
    });
    const beforeReplay = structuredClone(recreated.value);

    const replayedOldReceipt = commitCapture(
      recreated.value,
      originalToken.value,
      originalRecord,
      "2026-07-11T01:03:00.000Z",
      () => "must-not-allocate-on-stale-replay",
    );

    expect(replayedOldReceipt).toMatchObject({
      ok: false,
      code: "STALE_CAPTURE_OPERATION",
    });
    expect(recreated.value).toEqual(beforeReplay);
    expect(recreated.value.file?.session.attachments[0]).toMatchObject({
      id: "att_save",
      annotationId: "opaque-recreated-annotation",
    });
  });

  test("keeps a legacy V1 item-id-only receipt idempotent", () => {
    const file = createSessionFile([createCaptureRecord("save", "Save changes")]);
    const legacy: SessionState = {
      file,
      meta: {
        ...createSessionMeta("epoch-legacy-receipt"),
        receipts: [{ operationId: "op-legacy-save", itemId: "att_save" }],
      },
    };
    const token = beginCapture(legacy, file.session.origin, "op-legacy-save");
    expect(token.ok).toBe(true);
    if (!token.ok) return;

    const retried = commitCapture(
      legacy,
      token.value,
      createCaptureRecord("save", "Save changes"),
      "2026-07-11T01:05:00.000Z",
      () => "must-not-upgrade-legacy-receipt",
    );

    expect(retried.ok).toBe(true);
    if (!retried.ok) return;
    expect(retried.value.file).toEqual(file);
    expect(retried.value.meta.receipts.at(-1)).toEqual({
      operationId: "op-legacy-save",
      itemId: "att_save",
    });

    const migrated = updateSessionIntent(
      retried.value,
      retried.value.meta.epoch,
      "att_save",
      "Migrate the retained V1 annotation",
      "2026-07-11T01:06:00.000Z",
      () => "opaque-migrated-legacy-receipt",
    );
    expect(migrated.ok).toBe(true);
    if (!migrated.ok) return;
    expect(migrated.value.file?.schemaVersion).toBe("0.3.0");
    expect(migrated.value.meta.receipts.at(-1)).toEqual({
      operationId: "op-legacy-save",
      itemId: "att_save",
      annotationId: "opaque-migrated-legacy-receipt",
    });

    const retryAfterMigration = commitCapture(
      migrated.value,
      token.value,
      createCaptureRecord("save", "Save changes"),
      "2026-07-11T01:07:00.000Z",
      () => "must-not-allocate-after-legacy-migration",
    );
    expect(retryAfterMigration.ok).toBe(true);
    if (!retryAfterMigration.ok) return;
    expect(retryAfterMigration.value.file).toEqual(migrated.value.file);
    expect(retryAfterMigration.value.meta.receipts.at(-1)).toEqual({
      operationId: "op-legacy-save",
      itemId: "att_save",
      annotationId: "opaque-migrated-legacy-receipt",
    });
  });

  test("fails closed for an ambiguous item-id-only receipt on an existing V2 annotation", () => {
    const legacyV2 = createV2State("epoch-v2-legacy-receipt");
    legacyV2.meta.receipts = [{ operationId: "op-v2-legacy", itemId: "att_save" }];
    const before = structuredClone(legacyV2);
    const token = beginCapture(
      legacyV2,
      legacyV2.file!.session.origin,
      "op-v2-legacy",
    );
    expect(token.ok).toBe(true);
    if (!token.ok) return;

    const retried = commitCapture(
      legacyV2,
      token.value,
      createCaptureRecord("save", "Save changes"),
      "2026-07-11T01:08:00.000Z",
      () => "must-not-backfill-ambiguous-v2-receipt",
    );

    expect(retried).toMatchObject({ ok: false, code: "STALE_CAPTURE_OPERATION" });
    expect(legacyV2).toEqual(before);
  });

  test.each([
    ["own undefined", (receipt: Record<string, unknown>) => {
      receipt.annotationId = undefined;
    }, "INVALID_SESSION_FILE"],
    ["null", (receipt: Record<string, unknown>) => {
      receipt.annotationId = null;
    }, "STALE_CAPTURE_OPERATION"],
    ["extra field", (receipt: Record<string, unknown>) => {
      receipt.extra = true;
    }, "INVALID_SESSION_FILE"],
    ["malformed string", (receipt: Record<string, unknown>) => {
      receipt.annotationId = "not valid whitespace";
    }, "INVALID_SESSION_FILE"],
  ])("fails closed for %s receipt identity", (_name, mutate, code) => {
    const state = createStateWithIdentity("opaque-receipt-shape");
    const receipt = state.meta.receipts[0] as unknown as Record<string, unknown>;
    mutate(receipt);
    const before = structuredClone(state);
    const token = beginCapture(state, state.file!.session.origin, "op-identity");

    if (code === "INVALID_SESSION_FILE") {
      expect(token).toMatchObject({ ok: false, code });
      expect(state).toEqual(before);
      return;
    }
    expect(token.ok).toBe(true);
    if (!token.ok) return;
    const retried = commitCapture(
      state,
      token.value,
      createCaptureRecord("save", "Save changes"),
      "2026-07-11T01:09:00.000Z",
    );
    expect(retried).toMatchObject({ ok: false, code });
    expect(state).toEqual(before);
  });

  test("advances item updatedAt only for a real note edit and preserves immutable identity", () => {
    const initial = createStateWithIdentity("opaque-random-annotation-a");
    const itemBefore = structuredClone(initial.file!.session.attachments[0]);

    const noOp = updateSessionIntent(
      initial,
      initial.meta.epoch,
      itemBefore.id,
      itemBefore.sourceRecord.intent,
      "2026-07-11T01:05:00.000Z",
      () => "must-not-be-used",
    );
    expect(noOp.ok).toBe(true);
    if (!noOp.ok) return;
    expect(noOp.value.file?.session.attachments[0]).toEqual(itemBefore);

    const changed = updateSessionIntent(
      noOp.value,
      noOp.value.meta.epoch,
      itemBefore.id,
      "Clarify the save action",
      "2026-07-11T01:05:00.000Z",
      () => "must-not-be-used",
    );
    expect(changed.ok).toBe(true);
    if (!changed.ok) return;
    expect(changed.value.file?.session.attachments[0]).toMatchObject({
      id: itemBefore.id,
      annotationId: "opaque-random-annotation-a",
      createdAt: itemBefore.createdAt,
      updatedAt: "2026-07-11T01:05:00.000Z",
      sourceRecord: { intent: "Clarify the save action" },
    });
    const staleClockEdit = updateSessionIntent(
      changed.value,
      changed.value.meta.epoch,
      itemBefore.id,
      "Clarify the save action again",
      "2026-07-11T01:04:00.000Z",
      () => "must-not-be-used",
    );
    expect(staleClockEdit.ok).toBe(true);
    if (!staleClockEdit.ok) return;
    expect(staleClockEdit.value.file?.session.attachments[0]).toMatchObject({
      annotationId: "opaque-random-annotation-a",
      createdAt: itemBefore.createdAt,
      updatedAt: "2026-07-11T01:05:00.001Z",
    });
    expect(initial.file!.session.attachments[0]).toEqual(itemBefore);
  });

  test("successful explicit recapture preserves identity and creation time while advancing item time", () => {
    const initial = createStateWithIdentity("opaque-random-annotation-a");
    const original = structuredClone(initial.file!.session.attachments[0]);
    const token = beginCapture(
      initial,
      initial.file!.session.origin,
      "op-recapture-identity",
      original.id,
    );
    expect(token.ok).toBe(true);
    if (!token.ok) return;
    const refreshed = createCaptureRecord("fresh-dom-id", "Save changes now");
    refreshed.capturedAt = "2026-07-11T10:05:00.000Z";
    refreshed.attachment.capturedAt = refreshed.capturedAt;

    const committed = commitCapture(
      initial,
      token.value,
      refreshed,
      original.updatedAt,
      () => "must-not-replace-existing-identity",
    );

    expect(committed.ok).toBe(true);
    if (!committed.ok) return;
    expect(committed.value.file?.session.attachments[0]).toMatchObject({
      id: original.id,
      annotationId: "opaque-random-annotation-a",
      createdAt: original.createdAt,
      updatedAt: "2026-07-11T01:00:00.001Z",
      sourceRecord: { capturedAt: "2026-07-11T10:05:00.000Z" },
    });
  });

  test("rejects extended-year V3 mutation timestamps without changing state", () => {
    const initial = createStateWithIdentity("opaque-random-annotation-bounded-year");
    const original = structuredClone(initial);
    const item = initial.file!.session.attachments[0];

    const edited = updateSessionIntent(
      initial,
      initial.meta.epoch,
      item.id,
      "Extended-year instruction",
      "+010000-01-01T00:00:00.000Z",
    );
    expect(edited).toMatchObject({ ok: false, code: "INVALID_SESSION_FILE" });
    expect(initial).toEqual(original);

    const token = beginCapture(
      initial,
      initial.file!.session.origin,
      "op-recapture-extended",
      item.id,
    );
    expect(token.ok).toBe(true);
    if (!token.ok) return;
    const recaptured = commitCapture(
      initial,
      token.value,
      createCaptureRecord("fresh-extended", "Extended target"),
      "+010000-01-01T00:00:00.000Z",
    );
    expect(recaptured).toMatchObject({ ok: false, code: "INVALID_SESSION_FILE" });
    expect(initial).toEqual(original);
  });

  test("fails closed when edit or recapture cannot advance the maximum canonical timestamp", () => {
    const maximumTimestamp = "9999-12-31T23:59:59.999Z";
    const initial = createStateWithIdentityAt(
      "opaque-random-annotation-maximum",
      maximumTimestamp,
    );
    const original = structuredClone(initial);
    const item = initial.file!.session.attachments[0];
    let edited: ReturnType<typeof updateSessionIntent> | undefined;

    expect(() => {
      edited = updateSessionIntent(
        initial,
        initial.meta.epoch,
        item.id,
        "Cannot move beyond maximum",
        maximumTimestamp,
      );
    }).not.toThrow();
    expect(edited).toMatchObject({ ok: false, code: "INVALID_SESSION_FILE" });
    expect(initial).toEqual(original);

    const token = beginCapture(
      initial,
      initial.file!.session.origin,
      "op-recapture-maximum",
      item.id,
    );
    expect(token.ok).toBe(true);
    if (!token.ok) return;
    let recaptured: ReturnType<typeof commitCapture> | undefined;
    expect(() => {
      recaptured = commitCapture(
        initial,
        token.value,
        createCaptureRecord("fresh-maximum", "Maximum target"),
        maximumTimestamp,
      );
    }).not.toThrow();
    expect(recaptured).toMatchObject({ ok: false, code: "INVALID_SESSION_FILE" });
    expect(initial).toEqual(original);
  });

  test("strictly advances substantive add and hard-delete when the supplied clock is stale", () => {
    const initial = createStateWithIdentity("opaque-random-annotation-stale-mutations");
    const addToken = beginCapture(
      initial,
      initial.file!.session.origin,
      "op-stale-add",
    );
    expect(addToken.ok).toBe(true);
    if (!addToken.ok) return;

    const added = commitCapture(
      initial,
      addToken.value,
      createCaptureRecord("cancel", "Cancel changes"),
      "2026-07-11T00:59:00.000Z",
      () => "opaque-random-annotation-stale-added",
    );
    expect(added.ok).toBe(true);
    if (!added.ok) return;
    expect(added.value.file?.session.updatedAt).toBe("2026-07-11T01:00:00.001Z");
    expect(added.value.file?.session.attachments[1]).toMatchObject({
      annotationId: "opaque-random-annotation-stale-added",
      createdAt: "2026-07-11T01:00:00.001Z",
      updatedAt: "2026-07-11T01:00:00.001Z",
    });

    const removed = removeSessionItem(
      added.value,
      added.value.meta.epoch,
      "att_cancel",
      "2026-07-11T00:58:00.000Z",
    );
    expect(removed.ok).toBe(true);
    if (!removed.ok) return;
    expect(removed.value.file?.session.updatedAt).toBe("2026-07-11T01:00:00.002Z");
    expect(removed.value.file?.session.attachments).toHaveLength(1);
  });

  test("uses the session clock as the strict baseline when editing or recapturing an older item", () => {
    const initial = createStateWithIdentity("opaque-random-annotation-older-a");
    const addToken = beginCapture(initial, initial.file!.session.origin, "op-newer-b");
    expect(addToken.ok).toBe(true);
    if (!addToken.ok) return;
    const withNewerItem = commitCapture(
      initial,
      addToken.value,
      createCaptureRecord("cancel", "Cancel changes"),
      "2026-07-11T01:01:00.000Z",
      () => "opaque-random-annotation-newer-b",
    );
    expect(withNewerItem.ok).toBe(true);
    if (!withNewerItem.ok) return;

    const edited = updateSessionIntent(
      withNewerItem.value,
      withNewerItem.value.meta.epoch,
      "att_save",
      "Edit the older target",
      "2026-07-11T00:59:00.000Z",
    );
    expect(edited.ok).toBe(true);
    if (!edited.ok) return;
    expect(edited.value.file?.session.updatedAt).toBe("2026-07-11T01:01:00.001Z");
    expect(edited.value.file?.session.attachments[0].updatedAt).toBe(
      "2026-07-11T01:01:00.001Z",
    );

    const recaptureToken = beginCapture(
      edited.value,
      edited.value.file!.session.origin,
      "op-recapture-older-a",
      "att_save",
    );
    expect(recaptureToken.ok).toBe(true);
    if (!recaptureToken.ok) return;
    const recaptured = commitCapture(
      edited.value,
      recaptureToken.value,
      createCaptureRecord("fresh-save", "Save changes now"),
      "2026-07-11T00:58:00.000Z",
    );
    expect(recaptured.ok).toBe(true);
    if (!recaptured.ok) return;
    expect(recaptured.value.file?.session.updatedAt).toBe("2026-07-11T01:01:00.002Z");
    expect(recaptured.value.file?.session.attachments[0].updatedAt).toBe(
      "2026-07-11T01:01:00.002Z",
    );
  });

  test("fails older-item edit and recapture when the session clock is already maximum", () => {
    const maximumTimestamp = "9999-12-31T23:59:59.999Z";
    const initial = createStateWithIdentity("opaque-random-annotation-before-maximum");
    const addToken = beginCapture(initial, initial.file!.session.origin, "op-maximum-session");
    expect(addToken.ok).toBe(true);
    if (!addToken.ok) return;
    const atMaximum = commitCapture(
      initial,
      addToken.value,
      createCaptureRecord("cancel", "Cancel changes"),
      maximumTimestamp,
      () => "opaque-random-annotation-at-maximum",
    );
    expect(atMaximum.ok).toBe(true);
    if (!atMaximum.ok) return;
    const originalBytes = JSON.stringify(atMaximum.value);

    const edited = updateSessionIntent(
      atMaximum.value,
      atMaximum.value.meta.epoch,
      "att_save",
      "Cannot edit beyond the session maximum",
      maximumTimestamp,
    );
    expect(edited).toMatchObject({ ok: false, code: "INVALID_SESSION_FILE" });
    expect(JSON.stringify(atMaximum.value)).toBe(originalBytes);

    const recaptureToken = beginCapture(
      atMaximum.value,
      atMaximum.value.file!.session.origin,
      "op-recapture-at-session-maximum",
      "att_save",
    );
    expect(recaptureToken.ok).toBe(true);
    if (!recaptureToken.ok) return;
    const recaptured = commitCapture(
      atMaximum.value,
      recaptureToken.value,
      createCaptureRecord("fresh-maximum", "Fresh maximum target"),
      maximumTimestamp,
    );
    expect(recaptured).toMatchObject({ ok: false, code: "INVALID_SESSION_FILE" });
    expect(JSON.stringify(atMaximum.value)).toBe(originalBytes);
  });

  test("fails closed when add or hard-delete cannot advance the maximum canonical timestamp", () => {
    const maximumTimestamp = "9999-12-31T23:59:59.999Z";
    const initial = createStateWithIdentityAt(
      "opaque-random-annotation-maximum-mutations",
      maximumTimestamp,
    );
    const originalBytes = JSON.stringify(initial);
    const addToken = beginCapture(
      initial,
      initial.file!.session.origin,
      "op-maximum-add",
    );
    expect(addToken.ok).toBe(true);
    if (!addToken.ok) return;

    const added = commitCapture(
      initial,
      addToken.value,
      createCaptureRecord("cancel", "Cancel changes"),
      maximumTimestamp,
      () => "must-not-allocate-at-maximum",
    );
    expect(added).toMatchObject({ ok: false, code: "INVALID_SESSION_FILE" });
    expect(JSON.stringify(initial)).toBe(originalBytes);

    const removed = removeSessionItem(
      initial,
      initial.meta.epoch,
      "att_save",
      maximumTimestamp,
    );
    expect(removed).toMatchObject({ ok: false, code: "INVALID_SESSION_FILE" });
    expect(JSON.stringify(initial)).toBe(originalBytes);
  });

  test("hard delete drops annotation identity and recapturing the same attachment never reuses it", () => {
    const initial = createStateWithIdentity("opaque-random-annotation-a");
    const removed = removeSessionItem(
      initial,
      initial.meta.epoch,
      "att_save",
      "2026-07-11T01:07:00.000Z",
    );
    expect(removed.ok).toBe(true);
    if (!removed.ok) return;
    expect(removed.value.file?.session.attachments).toEqual([]);
    const token = beginCapture(removed.value, "https://app.example.test", "op-after-delete");
    expect(token.ok).toBe(true);
    if (!token.ok) return;

    const recaptured = commitCapture(
      removed.value,
      token.value,
      createCaptureRecord("save", "Save changes"),
      "2026-07-11T01:08:00.000Z",
      () => "opaque-random-annotation-b",
    );

    expect(recaptured.ok).toBe(true);
    if (!recaptured.ok) return;
    expect(recaptured.value.file?.session.attachments[0]).toMatchObject({
      id: "att_save",
      annotationId: "opaque-random-annotation-b",
    });
    expect(recaptured.value.file?.session.attachments[0]).not.toHaveProperty(
      "annotationId",
      "opaque-random-annotation-a",
    );
  });

  test("reads legacy V1 unchanged and migrates it only on a substantive mutation", () => {
    const legacyRecord = createCaptureRecord("save", "Save changes");
    const legacyFile = createSessionFile([legacyRecord]);
    const legacy: SessionState = { file: legacyFile, meta: createSessionMeta("epoch-v1") };
    const legacyItem = structuredClone(legacyFile.session.attachments[0]);

    const noOp = updateSessionIntent(
      legacy,
      legacy.meta.epoch,
      legacyItem.id,
      legacyItem.sourceRecord.intent,
      "2026-07-11T10:09:00.000Z",
      () => "must-not-migrate-a-no-op",
    );
    expect(noOp.ok).toBe(true);
    if (!noOp.ok) return;
    expect(noOp.value.file).toEqual(legacyFile);
    expect(noOp.value.file?.schemaVersion).toBe("0.1.0");
    expect(noOp.value.file?.session.attachments[0]).not.toHaveProperty("annotationId");

    const migrated = updateSessionIntent(
      noOp.value,
      noOp.value.meta.epoch,
      legacyItem.id,
      "Migrated instruction",
      "2026-07-11T10:10:00.000Z",
      () => "opaque-migrated-annotation-a",
    );
    expect(migrated.ok).toBe(true);
    if (!migrated.ok) return;
    expect(migrated.value.file).toMatchObject({
      schemaVersion: "0.3.0",
      session: {
        createdAt: legacyFile.session.createdAt,
        attachments: [{
          id: legacyItem.id,
          annotationId: "opaque-migrated-annotation-a",
          createdAt: legacyItem.createdAt,
          updatedAt: "2026-07-11T10:10:00.000Z",
          annotationLifecycle: {
            state: "open",
            resolvedAt: null,
          },
          sourceRecord: {
            capturedAt: legacyItem.sourceRecord.capturedAt,
            intent: "Migrated instruction",
          },
        }],
      },
    });
    expect(legacy.file).toEqual(legacyFile);
  });

  test("keeps the whole legacy file unchanged when identity allocation fails during migration", () => {
    const legacyFile = createSessionFile([
      createCaptureRecord("save", "Save changes"),
      createCaptureRecord("cancel", "Cancel"),
    ]);
    const legacy: SessionState = { file: legacyFile, meta: createSessionMeta("epoch-v1-failure") };
    const original = structuredClone(legacy);
    const originalJson = JSON.stringify(legacy);
    const createFailingAllocator = () => {
      let calls = 0;
      return () => {
        calls += 1;
        if (calls === 1) return "opaque-partial-allocation";
        throw new Error("identity allocator unavailable");
      };
    };

    const editResult = updateSessionIntent(
      legacy,
      legacy.meta.epoch,
      legacyFile.session.attachments[0].id,
      "Must not partially migrate",
      "2026-07-11T10:10:00.000Z",
      createFailingAllocator(),
    );

    expect(editResult).toMatchObject({ ok: false, code: "INVALID_SESSION_FILE" });
    expect(legacy).toEqual(original);
    expect(JSON.stringify(legacy)).toBe(originalJson);
    expect(legacy.file?.schemaVersion).toBe("0.1.0");
    expect(legacy.file?.session.attachments.every(
      (item) => !("annotationId" in item),
    )).toBe(true);

    const token = beginCapture(
      legacy,
      legacyFile.session.origin,
      "op-v1-recapture-allocation-failure",
      legacyFile.session.attachments[0].id,
    );
    expect(token.ok).toBe(true);
    if (!token.ok) return;
    const recaptureResult = commitCapture(
      legacy,
      token.value,
      createCaptureRecord("fresh-save", "Fresh Save changes"),
      "2026-07-11T10:11:00.000Z",
      createFailingAllocator(),
    );

    expect(recaptureResult).toMatchObject({ ok: false, code: "INVALID_SESSION_FILE" });
    expect(legacy).toEqual(original);
    expect(JSON.stringify(legacy)).toBe(originalJson);
    expect(legacy.file?.schemaVersion).toBe("0.1.0");
  });

  test("keeps V1 and V2 hard deletes on their original schema without synthesizing lifecycle", () => {
    const legacyV1File = createSessionFile([
      createCaptureRecord("save", "Save changes"),
      createCaptureRecord("cancel", "Cancel"),
    ]);
    const legacyV1: SessionState = {
      file: legacyV1File,
      meta: createSessionMeta("epoch-v1-delete"),
    };
    const removedV1 = removeSessionItem(
      legacyV1,
      legacyV1.meta.epoch,
      legacyV1File.session.attachments[1].id,
      "2026-07-11T10:12:00.000Z",
    );
    expect(removedV1.ok).toBe(true);
    if (!removedV1.ok) return;
    expect(removedV1.value.file?.schemaVersion).toBe("0.1.0");
    expect(removedV1.value.file?.session.attachments[0]).not.toHaveProperty(
      "annotationLifecycle",
    );

    const legacyV2 = createV2State("epoch-v2-delete");
    const v2Before = structuredClone(legacyV2.file as CaptureSessionFileV2);
    const noOpV2 = updateSessionIntent(
      legacyV2,
      legacyV2.meta.epoch,
      v2Before.session.attachments[0].id,
      v2Before.session.attachments[0].sourceRecord.intent,
      "2026-07-11T10:12:00.000Z",
      () => "must-not-be-used",
    );
    expect(noOpV2.ok).toBe(true);
    if (!noOpV2.ok) return;
    expect(noOpV2.value.file).toEqual(v2Before);

    const removedV2 = removeSessionItem(
      noOpV2.value,
      noOpV2.value.meta.epoch,
      v2Before.session.attachments[1].id,
      "2026-07-11T10:12:00.000Z",
    );
    expect(removedV2.ok).toBe(true);
    if (!removedV2.ok) return;
    expect(removedV2.value.file?.schemaVersion).toBe("0.2.0");
    expect(removedV2.value.file?.session.attachments[0]).toMatchObject({
      annotationId: v2Before.session.attachments[0].annotationId,
      createdAt: v2Before.session.attachments[0].createdAt,
      updatedAt: v2Before.session.attachments[0].updatedAt,
    });
    expect(removedV2.value.file?.session.attachments[0]).not.toHaveProperty(
      "annotationLifecycle",
    );
  });

  test.each([
    ["V1", () => {
      const file = createSessionFile([createCaptureRecord("save", "Save changes")]);
      return { file, meta: createSessionMeta("epoch-last-v1") } satisfies SessionState;
    }, "0.1.0", "2026-07-11T10:01:00.000Z"],
    ["V2", () => createSingleItemV2State("epoch-last-v2"), "0.2.0",
      "2026-07-11T10:01:00.000Z"],
    ["V3", () => {
      const state = createStateWithIdentity("opaque-last-v3");
      state.file!.session.title = state.file!.session.attachments[0].sourceRecord.pageTitle;
      return state;
    }, "0.3.0", "2026-07-11T01:01:00.000Z"],
  ])("hard-deletes the last %s item into a canonical empty version-preserving file", (
    _name,
    createState,
    schemaVersion,
    deletedAt,
  ) => {
    const state = createState();
    const before = structuredClone(state);
    const itemId = state.file!.session.attachments[0].id;

    const removed = removeSessionItem(state, state.meta.epoch, itemId, deletedAt);

    expect(removed.ok).toBe(true);
    if (!removed.ok) return;
    expect(removed.value.file).toMatchObject({
      schemaVersion,
      session: {
        title: null,
        updatedAt: deletedAt,
        attachments: [],
      },
    });
    expect(state).toEqual(before);

    const missingRetry = removeSessionItem(
      removed.value,
      removed.value.meta.epoch,
      itemId,
      "2026-07-11T10:02:00.000Z",
    );
    expect(missingRetry.ok).toBe(true);
    if (!missingRetry.ok) return;
    expect(missingRetry.value).toEqual(removed.value);
  });

  test("atomically upgrades V2 on add while preserving existing identity and timestamps", () => {
    const legacyV2 = createV2State("epoch-v2-add");
    const before = structuredClone(legacyV2.file as CaptureSessionFileV2);
    const token = beginCapture(legacyV2, before.session.origin, "op-v2-add");
    expect(token.ok).toBe(true);
    if (!token.ok) return;

    const added = commitCapture(
      legacyV2,
      token.value,
      createCaptureRecord("delete", "Delete"),
      "2026-07-11T10:12:00.000Z",
      () => "opaque-v3-new-annotation",
    );

    expect(added.ok).toBe(true);
    if (!added.ok) return;
    expect(added.value.file?.schemaVersion).toBe("0.3.0");
    expect(added.value.file?.session.attachments.slice(0, 2)).toEqual(
      before.session.attachments.map((item) => ({
        ...item,
        annotationLifecycle: { state: "open", resolvedAt: null },
      })),
    );
    expect(added.value.file?.session.attachments[2]).toMatchObject({
      id: "att_delete",
      annotationId: "opaque-v3-new-annotation",
      annotationLifecycle: { state: "open", resolvedAt: null },
    });
    expect(legacyV2.file).toEqual(before);
  });

  test("upgrades V2 edit and recapture without changing retained identities or lifecycle", () => {
    const editState = createV2State("epoch-v2-edit");
    const editBefore = structuredClone(editState.file as CaptureSessionFileV2);
    const edited = updateSessionIntent(
      editState,
      editState.meta.epoch,
      editBefore.session.attachments[0].id,
      "Upgrade this V2 note",
      "2026-07-11T10:12:00.000Z",
      () => "must-not-replace-v2-identity",
    );
    expect(edited.ok).toBe(true);
    if (!edited.ok) return;
    const editedFile = edited.value.file as CaptureSessionFileV3;
    expect(editedFile.schemaVersion).toBe("0.3.0");
    expect(editedFile.session.attachments[0]).toMatchObject({
      annotationId: editBefore.session.attachments[0].annotationId,
      createdAt: editBefore.session.attachments[0].createdAt,
      annotationLifecycle: { state: "open", resolvedAt: null },
      sourceRecord: { intent: "Upgrade this V2 note" },
    });
    expect(editedFile.session.attachments[1]).toEqual({
      ...editBefore.session.attachments[1],
      annotationLifecycle: { state: "open", resolvedAt: null },
    });

    const recaptureState = createV2State("epoch-v2-recapture");
    const recaptureBefore = structuredClone(recaptureState.file as CaptureSessionFileV2);
    const token = beginCapture(
      recaptureState,
      recaptureBefore.session.origin,
      "op-v2-recapture",
      recaptureBefore.session.attachments[0].id,
    );
    expect(token.ok).toBe(true);
    if (!token.ok) return;
    const refreshed = createCaptureRecord("fresh-save", "Save now");
    const recaptured = commitCapture(
      recaptureState,
      token.value,
      refreshed,
      "2026-07-11T10:12:00.000Z",
      () => "must-not-replace-v2-identity",
    );
    expect(recaptured.ok).toBe(true);
    if (!recaptured.ok) return;
    const recapturedFile = recaptured.value.file as CaptureSessionFileV3;
    expect(recapturedFile.session.attachments).toHaveLength(2);
    expect(recapturedFile.session.attachments[0]).toMatchObject({
      id: recaptureBefore.session.attachments[0].id,
      annotationId: recaptureBefore.session.attachments[0].annotationId,
      createdAt: recaptureBefore.session.attachments[0].createdAt,
      annotationLifecycle: { state: "open", resolvedAt: null },
    });
    expect(recapturedFile.session.attachments[1]).toEqual({
      ...recaptureBefore.session.attachments[1],
      annotationLifecycle: { state: "open", resolvedAt: null },
    });
  });

  test("upgrades V1 on add and assigns identities to retained and new items", () => {
    const legacyFile = createSessionFile([createCaptureRecord("save", "Save changes")]);
    const legacy: SessionState = {
      file: legacyFile,
      meta: createSessionMeta("epoch-v1-add"),
    };
    const token = beginCapture(legacy, legacyFile.session.origin, "op-v1-add");
    expect(token.ok).toBe(true);
    if (!token.ok) return;
    const ids = ["opaque-v1-retained", "opaque-v1-new"];
    let allocation = 0;

    const added = commitCapture(
      legacy,
      token.value,
      createCaptureRecord("cancel", "Cancel"),
      "2026-07-11T10:12:00.000Z",
      () => ids[allocation++]!,
    );

    expect(added.ok).toBe(true);
    if (!added.ok) return;
    const file = added.value.file as CaptureSessionFileV3;
    expect(file.schemaVersion).toBe("0.3.0");
    expect(file.session.attachments.map((item) => item.annotationId)).toEqual(ids);
    expect(file.session.attachments.every((item) => (
      item.annotationLifecycle.state === "open" &&
      item.annotationLifecycle.resolvedAt === null
    ))).toBe(true);
  });

  test("upgrades all V1 attachments before recapture and never drops retained items", () => {
    const legacyFile = createSessionFile([
      createCaptureRecord("save", "Save changes"),
      createCaptureRecord("cancel", "Cancel"),
      createCaptureRecord("delete", "Delete"),
    ]);
    const legacy: SessionState = {
      file: legacyFile,
      meta: createSessionMeta("epoch-v1-recapture"),
    };
    const token = beginCapture(
      legacy,
      legacyFile.session.origin,
      "op-v1-recapture",
      legacyFile.session.attachments[1].id,
    );
    expect(token.ok).toBe(true);
    if (!token.ok) return;
    const ids = ["opaque-v1-a", "opaque-v1-b", "opaque-v1-c"];
    let allocation = 0;
    const refreshed = createCaptureRecord("fresh-cancel", "Cancel now");
    refreshed.capturedAt = "2026-07-11T10:12:00.000Z";
    refreshed.attachment.capturedAt = refreshed.capturedAt;

    const recaptured = commitCapture(
      legacy,
      token.value,
      refreshed,
      "2026-07-11T10:12:00.000Z",
      () => ids[allocation++]!,
    );

    expect(recaptured.ok).toBe(true);
    if (!recaptured.ok) return;
    expect(recaptured.value.file?.schemaVersion).toBe("0.3.0");
    expect(recaptured.value.file?.session.attachments).toHaveLength(3);
    expect(recaptured.value.file?.session.attachments.map((item) => item.id)).toEqual([
      "att_save",
      "att_cancel",
      "att_delete",
    ]);
    expect(recaptured.value.file?.session.attachments.map((item) => (
      "annotationId" in item ? item.annotationId : null
    ))).toEqual(ids);
    expect(recaptured.value.file?.session.attachments.every((item) => (
      "annotationLifecycle" in item &&
      item.annotationLifecycle.state === "open" &&
      item.annotationLifecycle.resolvedAt === null
    ))).toBe(true);
    expect(recaptured.value.file?.session.attachments[1].sourceRecord.capturedAt).toBe(
      refreshed.capturedAt,
    );
  });

  test("preserves resolved lifecycle through V3 edit, recapture, and add", () => {
    const initial = createStateWithTwoItems();
    const file = initial.file as CaptureSessionFileV3;
    file.session.attachments[0].annotationLifecycle = {
      state: "resolved",
      resolvedAt: file.session.attachments[0].updatedAt,
    };
    const resolvedBefore = structuredClone(file.session.attachments[0].annotationLifecycle);

    const edited = updateSessionIntent(
      initial,
      initial.meta.epoch,
      file.session.attachments[0].id,
      "Keep this resolved annotation closed",
      "2026-07-11T01:02:00.000Z",
    );
    expect(edited.ok).toBe(true);
    if (!edited.ok) return;
    expect(
      (edited.value.file as CaptureSessionFileV3).session.attachments[0].annotationLifecycle,
    ).toEqual(resolvedBefore);

    const recaptureToken = beginCapture(
      edited.value,
      edited.value.file!.session.origin,
      "op-resolved-recapture",
      edited.value.file!.session.attachments[0].id,
    );
    expect(recaptureToken.ok).toBe(true);
    if (!recaptureToken.ok) return;
    const recaptured = commitCapture(
      edited.value,
      recaptureToken.value,
      createCaptureRecord("fresh-save", "Fresh Save"),
      "2026-07-11T01:03:00.000Z",
    );
    expect(recaptured.ok).toBe(true);
    if (!recaptured.ok) return;
    expect(
      (recaptured.value.file as CaptureSessionFileV3).session.attachments[0]
        .annotationLifecycle,
    ).toEqual(resolvedBefore);
    expect(recaptured.value.file?.session.attachments).toHaveLength(2);

    const addToken = beginCapture(
      recaptured.value,
      recaptured.value.file!.session.origin,
      "op-after-resolved",
    );
    expect(addToken.ok).toBe(true);
    if (!addToken.ok) return;
    const added = commitCapture(
      recaptured.value,
      addToken.value,
      createCaptureRecord("delete", "Delete"),
      "2026-07-11T01:04:00.000Z",
      () => "opaque-after-resolved",
    );
    expect(added.ok).toBe(true);
    if (!added.ok) return;
    const addedFile = added.value.file as CaptureSessionFileV3;
    expect(addedFile.session.attachments[0].annotationLifecycle).toEqual(resolvedBefore);
    expect(addedFile.session.attachments[2].annotationLifecycle).toEqual({
      state: "open",
      resolvedAt: null,
    });
  });

  test("resolves and reopens the same V3 annotation with authoritative timestamps", () => {
    const initial = createStateWithIdentity("opaque-lifecycle-a");
    const before = structuredClone(initial);
    const item = (initial.file as CaptureSessionFileV3).session.attachments[0];

    const resolved = updateSessionAnnotationLifecycle(
      initial,
      initial.meta.epoch,
      item.id,
      item.annotationId,
      "open",
      "resolved",
      "2026-07-11T01:02:00.000Z",
    );

    expect(resolved.ok).toBe(true);
    if (!resolved.ok) return;
    expect(initial).toEqual(before);
    expect(resolved.value.file).toMatchObject({
      schemaVersion: "0.3.0",
      session: {
        updatedAt: "2026-07-11T01:02:00.000Z",
        attachments: [{
          id: item.id,
          annotationId: "opaque-lifecycle-a",
          createdAt: item.createdAt,
          updatedAt: "2026-07-11T01:02:00.000Z",
          annotationLifecycle: {
            state: "resolved",
            resolvedAt: "2026-07-11T01:02:00.000Z",
          },
        }],
      },
    });

    const reopened = updateSessionAnnotationLifecycle(
      resolved.value,
      resolved.value.meta.epoch,
      item.id,
      item.annotationId,
      "resolved",
      "open",
      "2026-07-11T01:03:00.000Z",
    );

    expect(reopened.ok).toBe(true);
    if (!reopened.ok) return;
    expect(reopened.value.file).toMatchObject({
      schemaVersion: "0.3.0",
      session: {
        updatedAt: "2026-07-11T01:03:00.000Z",
        attachments: [{
          id: item.id,
          annotationId: "opaque-lifecycle-a",
          createdAt: item.createdAt,
          updatedAt: "2026-07-11T01:03:00.000Z",
          annotationLifecycle: {
            state: "open",
            resolvedAt: null,
          },
        }],
      },
    });
  });

  test.each([
    ["wrong annotation identity", "opaque-other", "open", "resolved"],
    ["stale expected state", "opaque-lifecycle-stale", "resolved", "open"],
    ["non-transition", "opaque-lifecycle-stale", "open", "open"],
  ] as const)("rejects lifecycle mutation atomically: %s", (
    _name,
    annotationId,
    expectedState,
    nextState,
  ) => {
    const initial = createStateWithIdentity("opaque-lifecycle-stale");
    const before = structuredClone(initial);
    const item = (initial.file as CaptureSessionFileV3).session.attachments[0];

    const result = updateSessionAnnotationLifecycle(
      initial,
      initial.meta.epoch,
      item.id,
      annotationId,
      expectedState,
      nextState,
      "2026-07-11T01:02:00.000Z",
    );

    expect(result).toMatchObject({ ok: false, code: "STALE_SESSION" });
    expect(initial).toEqual(before);
  });

  test("upgrades an identity-bearing V2 item while resolving it", () => {
    const initial = createSingleItemV2State("epoch-lifecycle-v2");
    const before = structuredClone(initial);
    const item = (initial.file as CaptureSessionFileV2).session.attachments[0];

    const result = updateSessionAnnotationLifecycle(
      initial,
      initial.meta.epoch,
      item.id,
      item.annotationId,
      "open",
      "resolved",
      "2026-07-11T10:02:00.000Z",
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(initial).toEqual(before);
    expect(result.value.file).toMatchObject({
      schemaVersion: "0.3.0",
      session: {
        updatedAt: "2026-07-11T10:02:00.000Z",
        attachments: [{
          id: item.id,
          annotationId: item.annotationId,
          createdAt: item.createdAt,
          updatedAt: "2026-07-11T10:02:00.000Z",
          annotationLifecycle: {
            state: "resolved",
            resolvedAt: "2026-07-11T10:02:00.000Z",
          },
        }],
      },
    });
  });

  test("does not invent annotation identity for a V1 lifecycle mutation", () => {
    const file = createSessionFile([createCaptureRecord("save", "Save changes")]);
    const initial: SessionState = {
      file,
      meta: createSessionMeta("epoch-lifecycle-v1"),
    };
    const before = structuredClone(initial);

    const result = updateSessionAnnotationLifecycle(
      initial,
      initial.meta.epoch,
      file.session.attachments[0].id,
      "opaque-not-present-in-v1",
      "open",
      "resolved",
      "2026-07-11T01:02:00.000Z",
    );

    expect(result).toMatchObject({ ok: false, code: "STALE_SESSION" });
    expect(initial).toEqual(before);
  });

  test.each([
    ["missing lifecycle", (file: CaptureSessionFileV3) => {
      delete (file.session.attachments[0] as Partial<
        CaptureSessionFileV3["session"]["attachments"][number]
      >).annotationLifecycle;
    }],
    ["own undefined lifecycle", (file: CaptureSessionFileV3) => {
      (file.session.attachments[0] as unknown as { annotationLifecycle: undefined })
        .annotationLifecycle = undefined;
    }],
    ["null lifecycle", (file: CaptureSessionFileV3) => {
      (file.session.attachments[0] as unknown as { annotationLifecycle: null })
        .annotationLifecycle = null;
    }],
    ["extra lifecycle field", (file: CaptureSessionFileV3) => {
      (file.session.attachments[0].annotationLifecycle as unknown as Record<string, unknown>)
        .extra = true;
    }],
    ["invalid lifecycle state", (file: CaptureSessionFileV3) => {
      (file.session.attachments[0].annotationLifecycle as unknown as { state: string }).state =
        "closed";
    }],
    ["extended-year item timestamp", (file: CaptureSessionFileV3) => {
      file.session.updatedAt = "+010000-01-01T00:00:00.000Z";
      file.session.attachments[0].updatedAt = "+010000-01-01T00:00:00.000Z";
    }],
  ])("fails malformed V3 state atomically before mutation: %s", (_name, mutate) => {
    const malformed = createStateWithIdentity("opaque-malformed-v3");
    mutate(malformed.file as CaptureSessionFileV3);
    const before = structuredClone(malformed);

    const result = updateSessionIntent(
      malformed,
      malformed.meta.epoch,
      malformed.file!.session.attachments[0].id,
      "Must not mutate malformed state",
      "2026-07-11T01:05:00.000Z",
    );

    expect(result).toMatchObject({ ok: false, code: "INVALID_SESSION_FILE" });
    expect(malformed).toEqual(before);
  });

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

  test("keeps repeated annotations on one verified target as independent session items", () => {
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
    refreshed.intent = "";
    refreshed.attachment.element.bbox = { x: 40, y: 60, width: 120, height: 40 };
    refreshed.attachment.selectionPoint = {
      kind: "element_relative_pointer",
      xRatio: 0.8,
      yRatio: 0.5,
    };

    const committed = commitCapture(
      withIntent.value,
      token.value,
      refreshed,
      "2026-07-11T01:03:00.000Z",
    );

    expect(committed.ok).toBe(true);
    if (!committed.ok) return;
    expect(committed.value.file?.session.attachments).toHaveLength(2);
    expect(committed.value.file?.session.updatedAt).toBe("2026-07-11T01:03:00.000Z");
    expect(committed.value.file?.session.attachments[0]).toMatchObject({
      id: "att_save",
      labels: ["A"],
      createdAt: "2026-07-11T01:00:00.000Z",
      sourceRecord: {
        intent: "Keep this instruction",
      },
    });
    expect(committed.value.file?.session.attachments[1]).toMatchObject({
      id: "att_save-2",
      labels: ["B"],
      sourceRecord: {
        intent: "",
        capturedAt: "2026-07-11T10:05:00.000Z",
        attachment: {
          selectionPoint: {
            kind: "element_relative_pointer",
            xRatio: 0.8,
            yRatio: 0.5,
          },
          element: { bbox: { x: 40, y: 60, width: 120, height: 40 } },
        },
      },
    });
    expect(committed.value.meta.receipts.at(-1)).toEqual({
      operationId: "op-refresh",
      itemId: "att_save-2",
      annotationId: (committed.value.file as CaptureSessionFileV3)
        .session.attachments[1].annotationId,
    });
    expect(withIntent.value.file?.session.attachments[0].sourceRecord.capturedAt).not.toBe(
      "2026-07-11T10:05:00.000Z",
    );
  });

  test("explicitly replaces an exact bound item without stable identity and preserves wrapper identity", () => {
    const initial = createStateWithItems(1);
    const withIntent = updateSessionIntent(
      initial,
      initial.meta.epoch,
      "att_save",
      "Keep this instruction",
      "2026-07-11T01:02:00.000Z",
    );
    expect(withIntent.ok).toBe(true);
    if (!withIntent.ok) return;
    const token = beginCapture(
      withIntent.value,
      withIntent.value.file!.session.origin,
      "op-explicit-refresh",
      "att_save",
    );
    expect(token.ok).toBe(true);
    if (!token.ok) return;
    const latestIntent = updateSessionIntent(
      withIntent.value,
      withIntent.value.meta.epoch,
      "att_save",
      "Latest instruction",
      "2026-07-11T01:02:30.000Z",
    );
    expect(latestIntent.ok).toBe(true);
    if (!latestIntent.ok) return;
    const refreshed = createCaptureRecord("dynamic-save", "Save changes now");
    refreshed.capturedAt = "2026-07-11T10:05:00.000Z";
    refreshed.attachment.capturedAt = refreshed.capturedAt;
    refreshed.attachment.sourceAnchor = {
      schemaVersion: "0.1.0",
      kind: "ui-attach.opaque-source-anchor",
      buildId: "A".repeat(43),
      sourceId: "B".repeat(43),
    };
    refreshed.attachment.element.contentParts = [{
      kind: "text",
      tagName: "span",
      role: null,
      text: "Fresh source mapped content",
      accessibleName: null,
    }];

    const committed = commitCapture(
      latestIntent.value,
      token.value,
      refreshed,
      "2026-07-11T01:03:00.000Z",
    );

    expect(committed.ok).toBe(true);
    if (!committed.ok) return;
    expect(committed.value.file?.session.attachments).toEqual([
      expect.objectContaining({
        id: "att_save",
        labels: ["A"],
        createdAt: "2026-07-11T01:00:00.000Z",
        sourceRecord: expect.objectContaining({
          intent: "Latest instruction",
          capturedAt: "2026-07-11T10:05:00.000Z",
          attachment: expect.objectContaining({
            id: "att_save",
            sourceAnchor: refreshed.attachment.sourceAnchor,
            element: expect.objectContaining({
              contentParts: refreshed.attachment.element.contentParts,
            }),
          }),
        }),
      }),
    ]);
  });

  test("fails closed when an explicit replacement item is missing before begin or commit", () => {
    const initial = createStateWithItems(1);
    expect(beginCapture(
      initial,
      initial.file!.session.origin,
      "op-missing",
      "att_missing",
    )).toMatchObject({ ok: false, code: "ITEM_NOT_FOUND" });

    const token = beginCapture(
      initial,
      initial.file!.session.origin,
      "op-stale",
      "att_save",
    );
    expect(token.ok).toBe(true);
    if (!token.ok) return;
    const removed = removeSessionItem(
      initial,
      initial.meta.epoch,
      "att_save",
      "2026-07-11T01:02:00.000Z",
    );
    expect(removed.ok).toBe(true);
    if (!removed.ok) return;

    expect(commitCapture(
      removed.value,
      token.value,
      createCaptureRecord("fresh", "Fresh"),
      "2026-07-11T01:03:00.000Z",
    )).toMatchObject({ ok: false, code: "ITEM_NOT_FOUND" });
  });

  test("rejects an explicit replacement token after the target capture version changes", () => {
    const initial = createStateWithItems(1);
    const staleToken = beginCapture(
      initial,
      initial.file!.session.origin,
      "op-stale-version",
      "att_save",
    );
    const freshToken = beginCapture(
      initial,
      initial.file!.session.origin,
      "op-fresh-version",
      "att_save",
    );
    expect(staleToken.ok).toBe(true);
    expect(freshToken.ok).toBe(true);
    if (!staleToken.ok || !freshToken.ok) return;
    const refreshedRecord = createCaptureRecord("save-new", "New save");
    refreshedRecord.capturedAt = "2026-07-11T10:05:00.000Z";
    refreshedRecord.attachment.capturedAt = refreshedRecord.capturedAt;
    const refreshed = commitCapture(
      initial,
      freshToken.value,
      refreshedRecord,
      "2026-07-11T01:02:00.000Z",
    );
    expect(refreshed.ok).toBe(true);
    if (!refreshed.ok) return;

    expect(commitCapture(
      refreshed.value,
      staleToken.value,
      createCaptureRecord("late", "Late"),
      "2026-07-11T01:03:00.000Z",
    )).toMatchObject({ ok: false, code: "STALE_CAPTURE_OPERATION" });
    expect(refreshed.value.file?.session.attachments[0].sourceRecord.capturedAt).toBe(
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
    expect(notBackward.value.file?.session.updatedAt).toBe("2026-07-11T01:05:00.001Z");
  });

  test("returns update lookup and size errors without changing state", () => {
    const state = createStateWithTwoItems();
    const stateBefore = structuredClone(state);
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
    expect(state).toEqual(stateBefore);
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
      annotationId: (retry.value.file as CaptureSessionFileV3)
        .session.attachments[1].annotationId,
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

function createStateWithIdentity(annotationId: string): SessionState {
  return createStateWithIdentityAt(annotationId, "2026-07-11T01:00:00.000Z");
}

function createStateWithIdentityAt(annotationId: string, committedAt: string): SessionState {
  const initial: SessionState = { file: null, meta: createSessionMeta("epoch-identity") };
  const token = beginCapture(initial, "https://app.example.test", "op-identity");
  if (!token.ok) throw new Error(token.error);
  const committed = commitCapture(
    initial,
    token.value,
    createCaptureRecord("save", "Save changes"),
    committedAt,
    () => annotationId,
  );
  if (!committed.ok) throw new Error(committed.error);
  return committed.value;
}

function createV2State(epoch: string): SessionState {
  const legacy = createSessionFile([
    createCaptureRecord("save", "Save changes"),
    createCaptureRecord("cancel", "Cancel"),
  ]);
  const file: CaptureSessionFileV2 = {
    ...legacy,
    schemaVersion: "0.2.0",
    session: {
      ...legacy.session,
      attachments: legacy.session.attachments.map((item, index) => ({
        ...item,
        annotationId: `opaque-v2-annotation-${index + 1}`,
        updatedAt: item.createdAt,
      })),
    },
  };
  return { file, meta: createSessionMeta(epoch) };
}

function createSingleItemV2State(epoch: string): SessionState {
  const legacy = createSessionFile([createCaptureRecord("save", "Save changes")]);
  const file: CaptureSessionFileV2 = {
    ...legacy,
    schemaVersion: "0.2.0",
    session: {
      ...legacy.session,
      attachments: legacy.session.attachments.map((item) => ({
        ...item,
        annotationId: "opaque-v2-annotation-1",
        updatedAt: item.createdAt,
      })),
    },
  };
  return { file, meta: createSessionMeta(epoch) };
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
