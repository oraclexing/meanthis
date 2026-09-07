import { describe, expect, test, vi } from "vitest";
import { createCaptureRecord, createSessionFile } from "../test/session-fixtures";
import type { ExtensionStorageArea, OriginCaptureRecord } from "./capture-store";
import {
  FIRST_CAPTURE_DISCLOSURE_ID,
  FIRST_CAPTURE_DISCLOSURE_STORAGE_KEY,
} from "./first-capture-disclosure";
import { createSessionMeta } from "./session-state";
import { createExtensionSessionStore } from "./session-store";
import { CAPTURE_CLEAR_AUTHORITY_STORAGE_KEY } from "./clear-operation";
import {
  RELATION_SHORTCUTS_KEY,
  TIME_DISPLAY_PREFERENCE_KEY,
} from "./settings-preferences";
import { getAnnotationLifecycleOperationLedgerStorageKey } from "./annotation-lifecycle-operation-ledger";

const ORIGIN = "https://app.example.test";
const OTHER_ORIGIN = "https://admin.example.test";
const SESSION_KEY = `ui-attach:session:v1:${ORIGIN}`;
const SESSION_META_KEY = `ui-attach:session:v1:meta:${ORIGIN}`;
const ORIGIN_CAPTURE_KEY = `ui-attach:capture:${ORIGIN}`;
const LATEST_CAPTURE_KEY = "ui-attach:capture:latest";
const OTHER_SESSION_KEY = `ui-attach:session:v1:${OTHER_ORIGIN}`;
const OTHER_SESSION_META_KEY = `ui-attach:session:v1:meta:${OTHER_ORIGIN}`;

describe("extension queued session store", () => {
  test("reads legacy V1 without identity and persists V3 only after a substantive note mutation", async () => {
    const storage = new RecordingStorage();
    const legacyRecord = createCaptureRecord("legacy", "Legacy target");
    const legacyFile = createSessionFile([legacyRecord]);
    const meta = createSessionMeta("epoch-legacy");
    storage.seed({
      [SESSION_KEY]: legacyFile,
      [SESSION_META_KEY]: meta,
    });
    const store = createExtensionSessionStore({
      storage,
      now: sequenceClock(
        "2026-07-11T10:09:00.000Z",
        "2026-07-11T10:10:00.000Z",
      ),
      createAnnotationId: () => "opaque-migrated-annotation-a",
    });

    const read = await store.read(ORIGIN);
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    expect(read.value.file).toEqual(legacyFile);
    expect(read.value.file?.session.attachments[0]).not.toHaveProperty("annotationId");
    expect(storage.setCalls).toHaveLength(0);

    const noOp = await store.updateIntent(
      ORIGIN,
      meta.epoch,
      legacyFile.session.attachments[0].id,
      legacyFile.session.attachments[0].sourceRecord.intent,
    );
    expect(noOp.ok).toBe(true);
    if (!noOp.ok) return;
    expect(noOp.value.file).toEqual(legacyFile);

    const changed = await store.updateIntent(
      ORIGIN,
      meta.epoch,
      legacyFile.session.attachments[0].id,
      "Substantive migrated note",
    );
    expect(changed.ok).toBe(true);
    if (!changed.ok) return;
    expect(changed.value.file).toMatchObject({
      schemaVersion: "0.3.0",
      session: {
        createdAt: legacyFile.session.createdAt,
        attachments: [{
          id: legacyFile.session.attachments[0].id,
          annotationId: "opaque-migrated-annotation-a",
          createdAt: legacyFile.session.attachments[0].createdAt,
          updatedAt: "2026-07-11T10:10:00.000Z",
          annotationLifecycle: { state: "open", resolvedAt: null },
        }],
      },
    });
  });

  test("persists annotation identity across reload, note edits, retry, and recapture without reusing it after delete", async () => {
    const storage = new RecordingStorage();
    const store = createExtensionSessionStore({
      storage,
      now: sequenceClock(
        "2026-07-11T02:00:00.000Z",
        "2026-07-11T02:00:00.000Z",
        "2026-07-11T02:01:00.000Z",
        "2026-07-11T02:02:00.000Z",
        "2026-07-11T02:03:00.000Z",
        "2026-07-11T02:04:00.000Z",
        "2026-07-11T02:05:00.000Z",
      ),
      randomUUID: sequenceUuid("epoch-identity", "op-create", "op-refresh", "op-recreate"),
      createAnnotationId: sequenceUuid(
        "opaque-random-annotation-a",
        "opaque-random-annotation-b",
      ),
    });
    const begun = await store.beginCapture(ORIGIN);
    expect(begun.ok).toBe(true);
    if (!begun.ok) return;
    const created = await store.commitCapture(
      begun.value,
      createCaptureRecord("save", "Save changes"),
    );
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    const createdItem = created.value.readback.file?.session.attachments[0];
    expect(createdItem).toMatchObject({
      id: "att_save",
      annotationId: "opaque-random-annotation-a",
      createdAt: "2026-07-11T02:00:00.000Z",
      updatedAt: "2026-07-11T02:00:00.000Z",
    });

    const retry = await store.commitCapture(
      begun.value,
      createCaptureRecord("changed-retry", "Must not replace identity"),
    );
    expect(retry.ok).toBe(true);
    if (!retry.ok) return;
    expect(retry.value.readback.file?.session.attachments[0]).toEqual(createdItem);

    const noOp = await store.updateIntent(
      ORIGIN,
      begun.value.epoch,
      created.value.itemId,
      createdItem!.sourceRecord.intent,
    );
    expect(noOp.ok).toBe(true);
    if (!noOp.ok) return;
    expect(noOp.value.file?.session.attachments[0]).toEqual(createdItem);

    const edited = await store.updateIntent(
      ORIGIN,
      begun.value.epoch,
      created.value.itemId,
      "Clarify the saved annotation",
    );
    expect(edited.ok).toBe(true);
    if (!edited.ok) return;
    expect(edited.value.file?.session.attachments[0]).toMatchObject({
      annotationId: "opaque-random-annotation-a",
      createdAt: "2026-07-11T02:00:00.000Z",
      updatedAt: "2026-07-11T02:02:00.000Z",
    });

    const refreshToken = await store.beginCapture(ORIGIN, created.value.itemId);
    expect(refreshToken.ok).toBe(true);
    if (!refreshToken.ok) return;
    const refreshedRecord = createCaptureRecord("fresh-dom-id", "Fresh save");
    refreshedRecord.capturedAt = "2026-07-11T10:05:00.000Z";
    refreshedRecord.attachment.capturedAt = refreshedRecord.capturedAt;
    const refreshed = await store.commitCapture(refreshToken.value, refreshedRecord);
    expect(refreshed.ok).toBe(true);
    if (!refreshed.ok) return;
    expect(refreshed.value.readback.file?.session.attachments[0]).toMatchObject({
      id: "att_save",
      annotationId: "opaque-random-annotation-a",
      createdAt: "2026-07-11T02:00:00.000Z",
      updatedAt: "2026-07-11T02:03:00.000Z",
    });

    const reloaded = createExtensionSessionStore({
      storage,
      createAnnotationId: () => "must-not-replace-reloaded-identity",
    });
    const readback = await reloaded.read(ORIGIN);
    expect(readback.ok).toBe(true);
    if (!readback.ok) return;
    expect(readback.value.file?.session.attachments[0]).toMatchObject({
      annotationId: "opaque-random-annotation-a",
      createdAt: "2026-07-11T02:00:00.000Z",
      updatedAt: "2026-07-11T02:03:00.000Z",
    });

    const removed = await store.removeItem(ORIGIN, begun.value.epoch, created.value.itemId);
    expect(removed.ok).toBe(true);
    if (!removed.ok) return;
    expect(removed.value.file?.session.attachments).toEqual([]);
    const recreateToken = await store.beginCapture(ORIGIN);
    expect(recreateToken.ok).toBe(true);
    if (!recreateToken.ok) return;
    const recreated = await store.commitCapture(
      recreateToken.value,
      createCaptureRecord("save", "Save changes"),
    );
    expect(recreated.ok).toBe(true);
    if (!recreated.ok) return;
    expect(recreated.value.readback.file?.session.attachments[0]).toMatchObject({
      id: "att_save",
      annotationId: "opaque-random-annotation-b",
      createdAt: "2026-07-11T02:05:00.000Z",
      updatedAt: "2026-07-11T02:05:00.000Z",
    });
  });

  test("persists resolve and reopen across store recreation with exact identity readback", async () => {
    const storage = new RecordingStorage();
    const store = createExtensionSessionStore({
      storage,
      now: sequenceClock(
        "2026-07-11T03:00:00.000Z",
        "2026-07-11T03:01:00.000Z",
      ),
      randomUUID: sequenceUuid("epoch-lifecycle", "op-lifecycle"),
      createAnnotationId: () => "opaque-lifecycle-store-a",
    });
    const begun = await store.beginCapture(ORIGIN);
    expect(begun.ok).toBe(true);
    if (!begun.ok) return;
    const created = await store.commitCapture(
      begun.value,
      createCaptureRecord("save", "Save changes"),
    );
    expect(created.ok).toBe(true);
    if (!created.ok) return;

    const resolved = await store.updateAnnotationLifecycle(
      ORIGIN,
      begun.value.epoch,
      created.value.itemId,
      "opaque-lifecycle-store-a",
      "open",
      "resolved",
    );

    expect(resolved.ok).toBe(true);
    if (!resolved.ok) return;
    expect(resolved.value.file?.session.attachments[0]).toMatchObject({
      id: created.value.itemId,
      annotationId: "opaque-lifecycle-store-a",
      updatedAt: "2026-07-11T03:01:00.000Z",
      annotationLifecycle: {
        state: "resolved",
        resolvedAt: "2026-07-11T03:01:00.000Z",
      },
    });

    const reloaded = createExtensionSessionStore({
      storage,
      now: () => new Date("2026-07-11T03:02:00.000Z"),
    });
    const beforeReopen = await reloaded.read(ORIGIN);
    expect(beforeReopen.ok).toBe(true);
    if (!beforeReopen.ok) return;
    expect(beforeReopen.value.file?.session.attachments[0]).toEqual(
      resolved.value.file?.session.attachments[0],
    );

    const reopened = await reloaded.updateAnnotationLifecycle(
      ORIGIN,
      begun.value.epoch,
      created.value.itemId,
      "opaque-lifecycle-store-a",
      "resolved",
      "open",
    );

    expect(reopened.ok).toBe(true);
    if (!reopened.ok) return;
    expect(reopened.value.file?.session.attachments[0]).toMatchObject({
      id: created.value.itemId,
      annotationId: "opaque-lifecycle-store-a",
      updatedAt: "2026-07-11T03:02:00.000Z",
      annotationLifecycle: {
        state: "open",
        resolvedAt: null,
      },
    });
    const finalReadback = await reloaded.read(ORIGIN);
    expect(finalReadback.ok).toBe(true);
    if (!finalReadback.ok) return;
    expect(finalReadback.value.file).toEqual(reopened.value.file);
  });

  test("atomically commits lifecycle session, meta, and operation ledger with exact durable readback", async () => {
    const storage = new RecordingStorage();
    const store = createExtensionSessionStore({
      storage,
      now: sequenceClock(
        "2026-09-01T03:00:00.000Z",
        "2026-09-01T03:00:20.000Z",
      ),
      randomUUID: sequenceUuid("epoch-control", "capture-control"),
      createAnnotationId: () => "annotation-control",
    });
    const begun = await store.beginCapture(ORIGIN);
    if (!begun.ok) throw new Error(begun.error);
    const created = await store.commitCapture(
      begun.value,
      createCaptureRecord("control", "Control target"),
    );
    if (!created.ok) throw new Error(created.error);
    storage.clearCalls();
    const authority = {
      isCurrent: vi.fn(() => true),
      refresh: vi.fn(async () => true),
    };
    const input = {
      origin: ORIGIN,
      epoch: begun.value.epoch,
      itemId: created.value.itemId,
      annotationId: "annotation-control",
      expectedState: "open" as const,
      nextState: "resolved" as const,
      operationId: "11111111-1111-4111-8111-111111111111",
      requestHash: "a".repeat(64),
    };
    const applied = await store.applyAnnotationLifecycleOperation(input, authority);
    expect(applied.ok && applied.value).toMatchObject({
      readback: {
        file: {
          session: {
            attachments: [{
              id: created.value.itemId,
              annotationId: "annotation-control",
              annotationLifecycle: {
                state: "resolved",
                resolvedAt: "2026-09-01T03:00:20.000Z",
              },
            }],
          },
        },
      },
      receipt: {
        operationId: input.operationId,
        requestHash: input.requestHash,
        previousState: "open",
        nextState: "resolved",
        appliedAt: "2026-09-01T03:00:20.000Z",
      },
    });
    const ledgerKey = getAnnotationLifecycleOperationLedgerStorageKey(ORIGIN)!;
    expect(storage.setCalls).toHaveLength(1);
    expect(Object.keys(storage.setCalls[0]!).sort()).toEqual([
      SESSION_KEY,
      SESSION_META_KEY,
      ledgerKey,
    ].sort());
    expect(storage.getCalls.at(-1)).toEqual([SESSION_KEY, SESSION_META_KEY, ledgerKey]);
    expect(authority.refresh).toHaveBeenCalledTimes(2);

    storage.clearCalls();
    const replay = await store.applyAnnotationLifecycleOperation(input, {
      isCurrent: vi.fn(() => false),
      refresh: vi.fn(async () => false),
    });
    expect(replay).toEqual(applied);
    expect(storage.setCalls).toHaveLength(0);

    const cleared = await store.clear(ORIGIN, begun.value.epoch, "clear-control");
    expect(cleared.ok).toBe(true);
    expect(storage.peek(ledgerKey)).toBeUndefined();
  });

  test.each(["during-refresh", "immediately-before-write"] as const)(
    "does not commit lifecycle state when mutation authority expires %s",
    async (expiryPoint) => {
      const storage = new RecordingStorage();
      const store = createExtensionSessionStore({
        storage,
        now: sequenceClock(
          "2026-09-01T03:10:00.000Z",
          "2026-09-01T03:10:20.000Z",
        ),
        randomUUID: sequenceUuid(`epoch-${expiryPoint}`, `capture-${expiryPoint}`),
        createAnnotationId: () => `annotation-${expiryPoint}`,
      });
      const begun = await store.beginCapture(ORIGIN);
      if (!begun.ok) throw new Error(begun.error);
      const created = await store.commitCapture(
        begun.value,
        createCaptureRecord(`control-${expiryPoint}`, "Control target"),
      );
      if (!created.ok) throw new Error(created.error);
      const canonicalBefore = storage.peek(SESSION_KEY);
      const metaBefore = storage.peek(SESSION_META_KEY);
      storage.clearCalls();
      let current = true;
      let currentChecks = 0;
      const authority = {
        isCurrent: vi.fn(() => {
          currentChecks += 1;
          return expiryPoint === "immediately-before-write"
            ? currentChecks < 3
            : current;
        }),
        refresh: vi.fn(async () => {
          if (expiryPoint === "during-refresh") current = false;
          return true;
        }),
      };

      await expect(store.applyAnnotationLifecycleOperation({
        origin: ORIGIN,
        epoch: begun.value.epoch,
        itemId: created.value.itemId,
        annotationId: `annotation-${expiryPoint}`,
        expectedState: "open",
        nextState: "resolved",
        operationId: expiryPoint === "during-refresh"
          ? "22222222-2222-4222-8222-222222222222"
          : "33333333-3333-4333-8333-333333333333",
        requestHash: expiryPoint === "during-refresh" ? "b".repeat(64) : "c".repeat(64),
      }, authority)).resolves.toMatchObject({
        ok: false,
        code: "ANNOTATION_LIFECYCLE_NOT_COMMITTED",
      });

      expect(authority.refresh).toHaveBeenCalledTimes(
        expiryPoint === "during-refresh" ? 1 : 2,
      );
      expect(storage.setCalls).toHaveLength(0);
      expect(storage.peek(SESSION_KEY)).toEqual(canonicalBefore);
      expect(storage.peek(SESSION_META_KEY)).toEqual(metaBefore);
      expect(storage.peek(getAnnotationLifecycleOperationLedgerStorageKey(ORIGIN)!)).toBeUndefined();
    },
  );

  test("does not write when lifecycle identity or expected state is stale", async () => {
    const storage = new RecordingStorage();
    const store = createExtensionSessionStore({
      storage,
      now: sequenceClock(
        "2026-07-11T04:00:00.000Z",
        "2026-07-11T04:01:00.000Z",
        "2026-07-11T04:02:00.000Z",
      ),
      randomUUID: sequenceUuid("epoch-lifecycle-stale", "op-lifecycle-stale"),
      createAnnotationId: () => "opaque-lifecycle-store-stale",
    });
    const begun = await store.beginCapture(ORIGIN);
    expect(begun.ok).toBe(true);
    if (!begun.ok) return;
    const created = await store.commitCapture(
      begun.value,
      createCaptureRecord("save", "Save changes"),
    );
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    const setCallsBefore = storage.setCalls.length;

    await expect(store.updateAnnotationLifecycle(
      ORIGIN,
      begun.value.epoch,
      created.value.itemId,
      "opaque-wrong-lifecycle-identity",
      "open",
      "resolved",
    )).resolves.toMatchObject({ ok: false, code: "STALE_SESSION" });
    await expect(store.updateAnnotationLifecycle(
      ORIGIN,
      begun.value.epoch,
      created.value.itemId,
      "opaque-lifecycle-store-stale",
      "resolved",
      "open",
    )).resolves.toMatchObject({ ok: false, code: "STALE_SESSION" });

    expect(storage.setCalls).toHaveLength(setCallsBefore);
    const readback = await store.read(ORIGIN);
    expect(readback.ok).toBe(true);
    if (!readback.ok) return;
    expect(readback.value.file?.session.attachments[0]).toMatchObject({
      annotationId: "opaque-lifecycle-store-stale",
      annotationLifecycle: { state: "open", resolvedAt: null },
    });
  });

  test("rejects an ABA retry after hard delete and same-item recreation without changing durable V3 state", async () => {
    const storage = new RecordingStorage();
    const store = createExtensionSessionStore({
      storage,
      now: sequenceClock(
        "2026-08-30T05:00:00.000Z",
        "2026-08-30T05:01:00.000Z",
        "2026-08-30T05:02:00.000Z",
      ),
      randomUUID: sequenceUuid("epoch-aba", "operation-a", "operation-b"),
      createAnnotationId: sequenceUuid("annotation-a", "annotation-b"),
    });
    const tokenA = await store.beginCapture(ORIGIN);
    if (!tokenA.ok) throw new Error(tokenA.error);
    const committedA = await store.commitCapture(
      tokenA.value,
      createCaptureRecord("same-item", "Original A"),
    );
    if (!committedA.ok) throw new Error(committedA.error);
    expect(committedA.value).toMatchObject({
      itemId: "att_same-item",
      readback: {
        file: {
          schemaVersion: "0.3.0",
          session: { attachments: [{ annotationId: "annotation-a" }] },
        },
      },
    });

    const removed = await store.removeItem(
      ORIGIN,
      tokenA.value.epoch,
      committedA.value.itemId,
    );
    if (!removed.ok) throw new Error(removed.error);
    expect(removed.value.file?.session.attachments).toEqual([]);
    const tokenB = await store.beginCapture(ORIGIN);
    if (!tokenB.ok) throw new Error(tokenB.error);
    const committedB = await store.commitCapture(
      tokenB.value,
      createCaptureRecord("same-item", "Replacement B"),
    );
    if (!committedB.ok) throw new Error(committedB.error);
    expect(committedB.value).toMatchObject({
      itemId: "att_same-item",
      readback: {
        file: {
          schemaVersion: "0.3.0",
          session: { attachments: [{ annotationId: "annotation-b" }] },
        },
      },
    });

    const beforeReplay = {
      session: storage.peek(SESSION_KEY),
      meta: storage.peek(SESSION_META_KEY),
      originProjection: storage.peek(ORIGIN_CAPTURE_KEY),
      latestProjection: storage.peek(LATEST_CAPTURE_KEY),
    };
    const beforeReplayBytes = {
      session: JSON.stringify(beforeReplay.session),
      meta: JSON.stringify(beforeReplay.meta),
      originProjection: JSON.stringify(beforeReplay.originProjection),
      latestProjection: JSON.stringify(beforeReplay.latestProjection),
    };
    expect(beforeReplay.meta).toMatchObject({
      receipts: [
        { operationId: "operation-a", itemId: "att_same-item", annotationId: "annotation-a" },
        { operationId: "operation-b", itemId: "att_same-item", annotationId: "annotation-b" },
      ],
    });
    storage.clearCalls();

    const recreatedStore = createExtensionSessionStore({
      storage,
      now: () => new Date("2026-08-30T05:03:00.000Z"),
      createAnnotationId: () => "must-not-be-created",
    });
    await expect(recreatedStore.commitCapture(
      tokenA.value,
      createCaptureRecord("stale-retry", "Stale A retry"),
    )).resolves.toMatchObject({
      ok: false,
      code: "STALE_CAPTURE_OPERATION",
    });
    expect(storage.setCalls).toEqual([]);
    expect(storage.removeCalls).toEqual([]);

    const postCallbackStore = createExtensionSessionStore({ storage });
    await expect(postCallbackStore.read(ORIGIN)).resolves.toMatchObject({
      ok: true,
      value: {
        epoch: "epoch-aba",
        file: {
          schemaVersion: "0.3.0",
          session: {
            attachments: [{
              id: "att_same-item",
              annotationId: "annotation-b",
              sourceRecord: {
                attachment: { element: { accessibleName: "Replacement B" } },
              },
            }],
          },
        },
      },
    });
    expect({
      session: storage.peek(SESSION_KEY),
      meta: storage.peek(SESSION_META_KEY),
      originProjection: storage.peek(ORIGIN_CAPTURE_KEY),
      latestProjection: storage.peek(LATEST_CAPTURE_KEY),
    }).toEqual(beforeReplay);
    expect({
      session: JSON.stringify(storage.peek(SESSION_KEY)),
      meta: JSON.stringify(storage.peek(SESSION_META_KEY)),
      originProjection: JSON.stringify(storage.peek(ORIGIN_CAPTURE_KEY)),
      latestProjection: JSON.stringify(storage.peek(LATEST_CAPTURE_KEY)),
    }).toEqual(beforeReplayBytes);
    expect(storage.setCalls).toEqual([]);
    expect(storage.removeCalls).toEqual([]);
  });

  test("commits session, receipt metadata, and compatibility projections together", async () => {
    const storage = new RecordingStorage();
    const store = createExtensionSessionStore({
      storage,
      now: sequenceClock("2026-07-11T02:00:00.000Z"),
      randomUUID: sequenceUuid("epoch-1", "op-1"),
      createAnnotationId: () => "annotation-receipt-1",
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
    expect(lastSet[SESSION_META_KEY]).toEqual({
      epoch: "epoch-1",
      clearPending: false,
      activeClearOperationId: null,
      lastCompletedClearOperationId: null,
      receipts: [{
        operationId: "op-1",
        itemId: "att_save",
        annotationId: "annotation-receipt-1",
      }],
    });
  });

  test("recreates the store for exact V3 readback, idempotent retry, clear, and restart", async () => {
    const storage = new RecordingStorage();
    const original = createExtensionSessionStore({
      storage,
      now: () => new Date("2026-08-30T04:00:00.000Z"),
      randomUUID: sequenceUuid("epoch-restart", "operation-restart"),
      createAnnotationId: () => "annotation-restart-stable",
    });
    const token = await original.beginCapture(ORIGIN);
    if (!token.ok) throw new Error(token.error);
    const committed = await original.commitCapture(
      token.value,
      createCaptureRecord("restart", "Restart target"),
    );
    expect(committed).toMatchObject({ ok: true });
    expect(storage.setCalls.at(-1)).toEqual(expect.objectContaining({
      [SESSION_KEY]: expect.objectContaining({ schemaVersion: "0.3.0" }),
      [SESSION_META_KEY]: expect.objectContaining({
        receipts: [{
          operationId: "operation-restart",
          itemId: "att_restart",
          annotationId: "annotation-restart-stable",
        }],
      }),
      [ORIGIN_CAPTURE_KEY]: expect.any(Object),
      [LATEST_CAPTURE_KEY]: expect.any(Object),
    }));

    let recreated = createExtensionSessionStore({
      storage,
      now: () => new Date("2026-08-30T04:01:00.000Z"),
      randomUUID: sequenceUuid("epoch-after-clear"),
      createAnnotationId: () => "must-not-reallocate-on-retry",
    });
    await expect(recreated.read(ORIGIN)).resolves.toMatchObject({
      ok: true,
      value: {
        epoch: "epoch-restart",
        file: {
          schemaVersion: "0.3.0",
          session: {
            attachments: [{
              id: "att_restart",
              annotationId: "annotation-restart-stable",
              annotationLifecycle: { state: "open", resolvedAt: null },
            }],
          },
        },
      },
    });
    const retryPayload = createCaptureRecord("changed-retry", "Must be ignored");
    await expect(recreated.commitCapture(token.value, retryPayload)).resolves.toMatchObject({
      ok: true,
      value: { itemId: "att_restart" },
    });

    recreated = createExtensionSessionStore({
      storage,
      randomUUID: sequenceUuid("epoch-after-clear"),
    });
    await expect(recreated.read(ORIGIN)).resolves.toMatchObject({
      ok: true,
      value: {
        file: {
          session: { attachments: [{ annotationId: "annotation-restart-stable" }] },
        },
      },
    });
    await expect(recreated.clear(ORIGIN, "epoch-restart", "clear-after-restart")).resolves.toMatchObject({
      ok: true,
      value: { epoch: "epoch-after-clear", file: null, legacyRecord: null },
    });

    const afterClearRestart = createExtensionSessionStore({ storage });
    await expect(afterClearRestart.read(ORIGIN)).resolves.toEqual({
      ok: true,
      value: {
        origin: ORIGIN,
        epoch: "epoch-after-clear",
        clearPending: false,
        activeClearOperationId: null,
        file: null,
        legacyRecord: null,
      },
    });
  });

  test("preserves V2 on a no-op edit and a hard delete without synthesizing V3 lifecycle", async () => {
    const storage = new RecordingStorage();
    const record = createCaptureRecord("legacy-v2", "Legacy V2 target");
    const file = createV2SessionFile(record, "annotation-legacy-v2");
    storage.seed({
      [SESSION_KEY]: file,
      [SESSION_META_KEY]: createSessionMeta("epoch-legacy-v2"),
    });
    const store = createExtensionSessionStore({
      storage,
      now: sequenceClock("2026-08-30T04:10:00.000Z", "2026-08-30T04:11:00.000Z"),
    });

    await expect(store.read(ORIGIN)).resolves.toMatchObject({
      ok: true,
      value: { file: { schemaVersion: "0.2.0" } },
    });
    expect(storage.setCalls).toEqual([]);
    await expect(store.updateIntent(
      ORIGIN,
      "epoch-legacy-v2",
      record.attachment.id,
      record.intent,
    )).resolves.toMatchObject({
      ok: true,
      value: { file: { schemaVersion: "0.2.0" } },
    });
    expect(JSON.stringify(storage.peek(SESSION_KEY))).not.toContain("annotationLifecycle");
    const removed = await store.removeItem(
      ORIGIN,
      "epoch-legacy-v2",
      record.attachment.id,
    );
    if (!removed.ok) throw new Error(JSON.stringify(removed));
    expect(removed).toMatchObject({
      ok: true,
      value: { file: { schemaVersion: "0.2.0", session: { attachments: [] } } },
    });
    expect(JSON.stringify(storage.peek(SESSION_KEY))).not.toContain("annotationLifecycle");
  });

  test("keeps a V1 item-id-only receipt idempotent across store recreation", async () => {
    const storage = new RecordingStorage();
    const record = createCaptureRecord("legacy-receipt", "Legacy receipt target");
    const file = createSessionFile([record]);
    storage.seed({
      [SESSION_KEY]: file,
      [SESSION_META_KEY]: {
        ...createSessionMeta("epoch-legacy-receipt"),
        receipts: [{ operationId: "operation-legacy-receipt", itemId: record.attachment.id }],
      },
    });
    const token = {
      origin: ORIGIN,
      epoch: "epoch-legacy-receipt",
      operationId: "operation-legacy-receipt",
      replacement: null,
    };
    const store = createExtensionSessionStore({
      storage,
      now: () => new Date("2026-08-30T04:20:00.000Z"),
      createAnnotationId: () => "must-not-upgrade-v1-receipt",
    });

    await expect(store.commitCapture(token, createCaptureRecord("changed", "Ignored retry")))
      .resolves.toMatchObject({
        ok: true,
        value: { itemId: record.attachment.id, readback: { file: { schemaVersion: "0.1.0" } } },
      });
    expect(storage.peek(SESSION_META_KEY)).toMatchObject({
      receipts: [{ operationId: "operation-legacy-receipt", itemId: record.attachment.id }],
    });
    expect(JSON.stringify(storage.peek(SESSION_META_KEY))).not.toContain("annotationId");
    const recreated = createExtensionSessionStore({ storage });
    await expect(recreated.inspectCapture(ORIGIN, "operation-legacy-receipt")).resolves
      .toMatchObject({
        ok: true,
        value: { receiptItemId: record.attachment.id, readback: { file: { schemaVersion: "0.1.0" } } },
      });
  });

  test("fails closed for an ambiguous V2 item-id-only receipt with zero writes", async () => {
    const storage = new RecordingStorage();
    const record = createCaptureRecord("v2-receipt", "V2 receipt target");
    storage.seed({
      [SESSION_KEY]: createV2SessionFile(record, "annotation-v2-receipt"),
      [SESSION_META_KEY]: {
        ...createSessionMeta("epoch-v2-receipt"),
        receipts: [{ operationId: "operation-v2-receipt", itemId: record.attachment.id }],
      },
    });
    const store = createExtensionSessionStore({
      storage,
      now: () => new Date("2026-08-30T04:21:00.000Z"),
    });
    storage.clearCalls();

    await expect(store.commitCapture({
      origin: ORIGIN,
      epoch: "epoch-v2-receipt",
      operationId: "operation-v2-receipt",
      replacement: null,
    }, createCaptureRecord("changed", "Ignored retry"))).resolves.toMatchObject({
      ok: false,
      code: "STALE_CAPTURE_OPERATION",
    });
    expect(storage.setCalls).toEqual([]);
    expect(storage.removeCalls).toEqual([]);
    expect(storage.peek(SESSION_KEY)).toEqual(createV2SessionFile(record, "annotation-v2-receipt"));
  });

  test("rejects a capture whose route authority expires at the pre-write boundary", async () => {
    const storage = new RecordingStorage();
    const previous = createCaptureRecord("existing", "Existing capture");
    const previousFile = createSessionFile([previous]);
    const previousMeta = createSessionMeta("epoch-1");
    storage.seed({
      [SESSION_KEY]: previousFile,
      [SESSION_META_KEY]: previousMeta,
      [ORIGIN_CAPTURE_KEY]: previous,
      [LATEST_CAPTURE_KEY]: previous,
    });
    const store = createExtensionSessionStore({
      storage,
      now: sequenceClock("2026-07-11T02:01:00.000Z"),
      randomUUID: sequenceUuid("op-route-race"),
    });
    const begun = await store.beginCapture(ORIGIN);
    expect(begun.ok).toBe(true);
    if (!begun.ok) return;
    let current = true;

    const committed = await store.commitCapture(
      begun.value,
      createCaptureRecord("stale", "Stale route capture"),
      {
        isCurrent: () => current,
        beforeWrite: async () => {
          current = false;
        },
      },
    );

    expect(committed).toMatchObject({ ok: false, code: "STALE_CAPTURE_OPERATION" });
    expect(storage.peek(SESSION_KEY)).toEqual(previousFile);
    expect(storage.peek(SESSION_META_KEY)).toEqual(previousMeta);
    expect(storage.peek(ORIGIN_CAPTURE_KEY)).toEqual(previous);
    expect(storage.peek(LATEST_CAPTURE_KEY)).toEqual(previous);
    expect(storage.setCalls).toHaveLength(0);
  });

  test("refreshes live route authority inside the store lock immediately before canonical storage", async () => {
    const storage = new RecordingStorage();
    const previous = createCaptureRecord("existing-live", "Existing live capture");
    const previousFile = createSessionFile([previous]);
    const previousMeta = createSessionMeta("epoch-live");
    storage.seed({
      [SESSION_KEY]: previousFile,
      [SESSION_META_KEY]: previousMeta,
      [ORIGIN_CAPTURE_KEY]: previous,
      [LATEST_CAPTURE_KEY]: previous,
    });
    const store = createExtensionSessionStore({
      storage,
      now: sequenceClock("2026-07-11T02:02:00.000Z"),
      randomUUID: sequenceUuid("op-live-route-race"),
    });
    const begun = await store.beginCapture(ORIGIN);
    expect(begun.ok).toBe(true);
    if (!begun.ok) return;
    const calls: string[] = [];

    const committed = await store.commitCapture(
      begun.value,
      createCaptureRecord("stale-live", "Stale live route capture"),
      {
        isCurrent: () => {
          calls.push("isCurrent");
          return true;
        },
        beforeWrite: async () => {
          calls.push("beforeWrite");
        },
        refresh: async () => {
          calls.push("refresh");
          return false;
        },
      },
    );

    expect(committed).toMatchObject({ ok: false, code: "STALE_CAPTURE_OPERATION" });
    expect(calls).toEqual(["isCurrent", "beforeWrite", "isCurrent", "refresh"]);
    expect(storage.peek(SESSION_KEY)).toEqual(previousFile);
    expect(storage.peek(SESSION_META_KEY)).toEqual(previousMeta);
    expect(storage.peek(ORIGIN_CAPTURE_KEY)).toEqual(previous);
    expect(storage.peek(LATEST_CAPTURE_KEY)).toEqual(previous);
    expect(storage.setCalls).toHaveLength(0);
  });

  test("rejects an intent update when live mutation authority expires before canonical storage", async () => {
    const storage = new RecordingStorage();
    const saved = createCaptureRecord("save-authority", "Saved authority target");
    const file = createSessionFile([saved]);
    const meta = createSessionMeta("epoch-live");
    storage.seed({
      [SESSION_KEY]: file,
      [SESSION_META_KEY]: meta,
      [ORIGIN_CAPTURE_KEY]: saved,
      [LATEST_CAPTURE_KEY]: saved,
    });
    const store = createExtensionSessionStore({ storage });
    const refreshedRecords: OriginCaptureRecord[] = [];

    const updated = await store.updateIntent(
      ORIGIN,
      "epoch-live",
      saved.attachment.id,
      "Must not persist",
      {
        isCurrent: () => true,
        refresh: async (record) => {
          refreshedRecords.push(record);
          return false;
        },
      },
    );

    expect(updated).toMatchObject({ ok: false, code: "STALE_SESSION" });
    expect(refreshedRecords).toEqual([expect.objectContaining({
      attachment: expect.objectContaining({ id: saved.attachment.id }),
      intent: saved.intent,
    })]);
    expect(storage.peek(SESSION_KEY)).toEqual(file);
    expect(storage.peek(SESSION_META_KEY)).toEqual(meta);
    expect(storage.peek(ORIGIN_CAPTURE_KEY)).toEqual(saved);
    expect(storage.peek(LATEST_CAPTURE_KEY)).toEqual(saved);
    expect(storage.setCalls).toHaveLength(0);
    expect(storage.removeCalls).toHaveLength(0);
  });

  test("rejects item removal when live mutation authority expires before privacy projections", async () => {
    const storage = new RecordingStorage();
    const survivor = createCaptureRecord("save", "Surviving target");
    const saved = createCaptureRecord("cancel", "Remove authority target");
    const file = createSessionFile([survivor, saved]);
    const meta = createSessionMeta("epoch-live");
    storage.seed({
      [SESSION_KEY]: file,
      [SESSION_META_KEY]: meta,
      [ORIGIN_CAPTURE_KEY]: saved,
      [LATEST_CAPTURE_KEY]: saved,
    });
    const store = createExtensionSessionStore({ storage });
    const refreshedRecords: OriginCaptureRecord[] = [];

    const removed = await store.removeItem(
      ORIGIN,
      "epoch-live",
      saved.attachment.id,
      {
        isCurrent: () => true,
        refresh: async (record) => {
          refreshedRecords.push(record);
          return false;
        },
      },
    );

    expect(removed).toMatchObject({ ok: false, code: "STALE_SESSION" });
    expect(refreshedRecords).toEqual([expect.objectContaining({
      attachment: expect.objectContaining({ id: saved.attachment.id }),
    })]);
    expect(storage.peek(SESSION_KEY)).toEqual(file);
    expect(storage.peek(SESSION_META_KEY)).toEqual(meta);
    expect(storage.peek(ORIGIN_CAPTURE_KEY)).toEqual(saved);
    expect(storage.peek(LATEST_CAPTURE_KEY)).toEqual(saved);
    expect(storage.setCalls).toHaveLength(0);
    expect(storage.removeCalls).toHaveLength(0);
  });

  test("preserves bounded content parts through canonical commits without synthesizing them", async () => {
    const storage = new RecordingStorage();
    const store = createExtensionSessionStore({
      storage,
      now: sequenceClock(
        "2026-07-11T02:00:00.000Z",
        "2026-07-11T02:01:00.000Z",
      ),
      randomUUID: sequenceUuid("epoch-1", "op-1", "op-2"),
    });
    const contentParts: NonNullable<
      OriginCaptureRecord["attachment"]["element"]["contentParts"]
    > = [
      {
        kind: "link",
        tagName: "a",
        role: "link",
        text: "Tibo",
        accessibleName: "Tibo",
      },
      {
        kind: "text",
        tagName: "p",
        role: null,
        text: "Structured capture body",
        accessibleName: null,
      },
      {
        kind: "button",
        tagName: "button",
        role: "button",
        text: "Reply",
        accessibleName: "Reply to Tibo",
      },
    ];
    const structured = createCaptureRecord("save", "Structured capture");
    structured.attachment.element.contentParts = contentParts;

    const firstToken = await store.beginCapture(ORIGIN);
    expect(firstToken.ok).toBe(true);
    if (!firstToken.ok) return;
    const firstCommit = await store.commitCapture(firstToken.value, structured);
    expect(firstCommit.ok).toBe(true);
    if (!firstCommit.ok) return;

    const plain = createCaptureRecord("cancel", "Plain capture");
    expect(plain.attachment.element).not.toHaveProperty("contentParts");
    const secondToken = await store.beginCapture(ORIGIN);
    expect(secondToken.ok).toBe(true);
    if (!secondToken.ok) return;
    const secondCommit = await store.commitCapture(secondToken.value, plain);
    expect(secondCommit.ok).toBe(true);
    if (!secondCommit.ok) return;

    const attachments = secondCommit.value.readback.file?.session.attachments;
    expect(attachments).toHaveLength(2);
    const committedParts = attachments?.[0]?.sourceRecord.attachment.element.contentParts;
    expect(committedParts).toEqual(contentParts);
    expect(committedParts).toHaveLength(3);
    for (const part of committedParts ?? []) {
      expect(new TextEncoder().encode(part.tagName).byteLength).toBeLessThanOrEqual(128);
      expect(new TextEncoder().encode(part.role ?? "").byteLength).toBeLessThanOrEqual(256);
      expect(new TextEncoder().encode(part.text ?? "").byteLength).toBeLessThanOrEqual(16_384);
      expect(new TextEncoder().encode(part.accessibleName ?? "").byteLength)
        .toBeLessThanOrEqual(16_384);
    }
    expect(attachments?.[1]?.sourceRecord.attachment.element)
      .not.toHaveProperty("contentParts");
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

  test("fails closed when stored-session listing encounters accessors or hostile proxies", async () => {
    const sessionGetter = vi.fn(() => createSessionFile([]));
    const accessorValues: Record<string, unknown> = {};
    Object.defineProperty(accessorValues, SESSION_KEY, {
      configurable: true,
      enumerable: true,
      get: sessionGetter,
    });
    const accessorStorage = new DirectReadStorage(accessorValues);

    await expect(createExtensionSessionStore({ storage: accessorStorage }).list()).resolves.toEqual({
      ok: false,
      code: "INVALID_SESSION_FILE",
      error: "Stored capture session listing is invalid.",
    });
    expect(sessionGetter).not.toHaveBeenCalled();
    expect(accessorStorage.setCalls).toEqual([]);
    expect(accessorStorage.removeCalls).toEqual([]);

    const nestedGetter = vi.fn(() => "ui-attach.capture-session");
    const nestedSession = createSessionFile([]) as unknown as Record<string, unknown>;
    Object.defineProperty(nestedSession, "kind", {
      configurable: true,
      enumerable: true,
      get: nestedGetter,
    });
    const valueGetTrap = vi.fn(() => {
      throw new Error("hostile nested get");
    });
    const nestedStorage = new DirectReadStorage({
      [SESSION_KEY]: new Proxy(nestedSession, { get: valueGetTrap }),
    });
    await expect(createExtensionSessionStore({ storage: nestedStorage }).list()).resolves
      .toMatchObject({ ok: false, code: "INVALID_SESSION_FILE" });
    expect(nestedGetter).not.toHaveBeenCalled();
    expect(valueGetTrap).not.toHaveBeenCalled();
    expect(nestedStorage.setCalls).toEqual([]);
    expect(nestedStorage.removeCalls).toEqual([]);

    const ownKeysTrap = vi.fn(() => {
      throw new Error("hostile ownKeys");
    });
    const hostileValues = new Proxy({} as Record<string, unknown>, { ownKeys: ownKeysTrap });
    const hostileStorage = new DirectReadStorage(hostileValues);
    await expect(createExtensionSessionStore({ storage: hostileStorage }).list()).resolves.toEqual({
      ok: false,
      code: "INVALID_SESSION_FILE",
      error: "Stored capture session listing is invalid.",
    });
    expect(ownKeysTrap).toHaveBeenCalledTimes(1);
    expect(hostileStorage.setCalls).toEqual([]);
    expect(hostileStorage.removeCalls).toEqual([]);

    await expect(createExtensionSessionStore({
      storage: new DirectReadStorage({}),
    }).list()).resolves.toEqual({ ok: true, value: [] });
  });

  test("list fails closed on a throwing getOwnPropertyDescriptor proxy without invoking getters", async () => {
    const ordinaryGetter = vi.fn(() => "ui-attach.capture-session");
    const session = createSessionFile([]) as unknown as Record<string, unknown>;
    Object.defineProperty(session, "kind", {
      configurable: true,
      enumerable: true,
      get: ordinaryGetter,
    });
    const getTrap = vi.fn(() => {
      throw new Error("hostile list get");
    });
    const descriptorTrap = vi.fn(() => {
      throw new Error("hostile list descriptor");
    });
    const storage = new DirectReadStorage({
      [SESSION_KEY]: new Proxy(session, {
        get: getTrap,
        getOwnPropertyDescriptor: descriptorTrap,
      }),
    });

    await expect(createExtensionSessionStore({ storage }).list()).resolves.toEqual({
      ok: false,
      code: "INVALID_SESSION_FILE",
      error: "Stored capture session listing is invalid.",
    });
    expect(descriptorTrap).toHaveBeenCalledTimes(1);
    expect(ordinaryGetter).not.toHaveBeenCalled();
    expect(getTrap).not.toHaveBeenCalled();
    expect(storage.setCalls).toEqual([]);
    expect(storage.removeCalls).toEqual([]);
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

  test("recapturing a verified target adds an independent annotation", async () => {
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
    expect(second.value).toMatchObject({ itemId: "att_save-2", label: "B" });
    expect(second.value.readback.file?.session.attachments).toHaveLength(2);
    expect(second.value.readback.file?.session.attachments[0]).toMatchObject({
      id: "att_save",
      labels: ["A"],
      sourceRecord: {
        intent: "Keep this instruction",
        capturedAt: "2026-07-11T10:00:00.000Z",
      },
    });
    expect(second.value.readback.file?.session.attachments[1]).toMatchObject({
      id: "att_save-2",
      labels: ["B"],
      sourceRecord: {
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
        { operationId: "op-2", itemId: "att_save-2" },
      ],
    });
  });

  test("explicit replacement refreshes canonical data and compatibility projections in place", async () => {
    const storage = new RecordingStorage();
    const store = createExtensionSessionStore({
      storage,
      now: sequenceClock(
        "2026-07-11T02:00:00.000Z",
        "2026-07-11T02:01:00.000Z",
        "2026-07-11T02:02:00.000Z",
      ),
      randomUUID: sequenceUuid("epoch-1", "op-1", "op-refresh"),
    });
    const firstToken = await store.beginCapture(ORIGIN);
    expect(firstToken.ok).toBe(true);
    if (!firstToken.ok) return;
    const first = await store.commitCapture(
      firstToken.value,
      createCaptureRecord("save", "Save changes"),
    );
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    const intent = await store.updateIntent(
      ORIGIN,
      firstToken.value.epoch,
      first.value.itemId,
      "Keep this instruction",
    );
    expect(intent.ok).toBe(true);

    const refreshToken = await store.beginCapture(ORIGIN, "att_save");
    expect(refreshToken.ok).toBe(true);
    if (!refreshToken.ok) return;
    expect(refreshToken.value.replacement).toMatchObject({ itemId: "att_save" });
    const refreshed = createCaptureRecord("dynamic-save", "Fresh save");
    refreshed.capturedAt = "2026-07-11T10:05:00.000Z";
    refreshed.attachment.capturedAt = refreshed.capturedAt;
    refreshed.attachment.sourceAnchor = {
      schemaVersion: "0.1.0",
      kind: "ui-attach.opaque-source-anchor",
      buildId: "A".repeat(43),
      sourceId: "B".repeat(43),
    };

    const committed = await store.commitCapture(refreshToken.value, refreshed);

    expect(committed.ok).toBe(true);
    if (!committed.ok) return;
    expect(committed.value).toMatchObject({ itemId: "att_save", label: "A" });
    expect(committed.value.readback.file?.session.attachments[0]).toMatchObject({
      id: "att_save",
      labels: ["A"],
      createdAt: "2026-07-11T02:00:00.000Z",
      sourceRecord: {
        intent: "Keep this instruction",
        capturedAt: "2026-07-11T10:05:00.000Z",
        attachment: {
          id: "att_save",
          sourceAnchor: refreshed.attachment.sourceAnchor,
        },
      },
    });
    expect(storage.peek(ORIGIN_CAPTURE_KEY)).toMatchObject({
      intent: "Keep this instruction",
      capturedAt: "2026-07-11T10:05:00.000Z",
      attachment: {
        id: "att_save",
        sourceAnchor: refreshed.attachment.sourceAnchor,
      },
    });
    expect(storage.peek(LATEST_CAPTURE_KEY)).toEqual(storage.peek(ORIGIN_CAPTURE_KEY));

    const inspection = await store.inspectCapture(ORIGIN, refreshToken.value.operationId);
    expect(inspection.ok).toBe(true);
    if (!inspection.ok) return;
    expect(inspection.value).toMatchObject({
      receiptItemId: "att_save",
      readback: {
        file: {
          session: {
            attachments: [{
              id: "att_save",
              sourceRecord: { capturedAt: "2026-07-11T10:05:00.000Z" },
            }],
          },
        },
      },
    });

    const canonicalFile = storage.peek(SESSION_KEY);
    const canonicalOriginProjection = storage.peek(ORIGIN_CAPTURE_KEY);
    const canonicalLatestProjection = storage.peek(LATEST_CAPTURE_KEY);
    const changedRetry = createCaptureRecord("delete", "Changed retry");
    changedRetry.attachment.context.selectorHints = ["must-not-rewrite-canonical-state"];

    const retried = await store.commitCapture(refreshToken.value, changedRetry);

    expect(retried.ok).toBe(true);
    if (!retried.ok) return;
    expect(retried.value).toMatchObject({ itemId: "att_save", label: "A" });
    expect(retried.value.readback.file?.session.attachments).toHaveLength(1);
    expect(storage.peek(SESSION_KEY)).toEqual(canonicalFile);
    expect(storage.peek(ORIGIN_CAPTURE_KEY)).toEqual(canonicalOriginProjection);
    expect(storage.peek(LATEST_CAPTURE_KEY)).toEqual(canonicalLatestProjection);
  });

  test("rejects a missing explicit replacement before issuing a token", async () => {
    const storage = new RecordingStorage();
    storage.seed({
      [SESSION_KEY]: createSessionFile([createCaptureRecord("save", "Save changes")]),
      [SESSION_META_KEY]: createSessionMeta("epoch-1"),
    });
    const store = createExtensionSessionStore({
      storage,
      randomUUID: sequenceUuid("op-missing"),
    });

    await expect(store.beginCapture(ORIGIN, "att_missing")).resolves.toMatchObject({
      ok: false,
      code: "ITEM_NOT_FOUND",
    });
  });

  test("rejects a 27th annotation even when it points at an existing stable target", async () => {
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
    expect(refreshed).toMatchObject({ ok: false, code: "SESSION_FULL" });

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

  test.each([
    ["missing field", () => {
      const meta = createSessionMeta("epoch-poison");
      delete (meta as Partial<typeof meta>).receipts;
      return meta;
    }],
    ["own undefined", () => ({ ...createSessionMeta("epoch-poison"), receipts: undefined })],
    ["null", () => ({ ...createSessionMeta("epoch-poison"), receipts: null })],
    ["extra field", () => ({ ...createSessionMeta("epoch-poison"), extra: true })],
    ["over-bound receipts", () => ({
      ...createSessionMeta("epoch-poison"),
      receipts: Array.from({ length: 65 }, (_, index) => ({
        operationId: `operation-${index}`,
        itemId: "att_save",
      })),
    })],
    ["sparse receipts", () => ({
      ...createSessionMeta("epoch-poison"),
      receipts: new Array(1),
    })],
    ["receipt extra field", () => ({
      ...createSessionMeta("epoch-poison"),
      receipts: [{ operationId: "operation-1", itemId: "att_save", extra: true }],
    })],
    ["receipt own undefined identity", () => ({
      ...createSessionMeta("epoch-poison"),
      receipts: [{ operationId: "operation-1", itemId: "att_save", annotationId: undefined }],
    })],
    ["receipt malformed identity", () => ({
      ...createSessionMeta("epoch-poison"),
      receipts: [{ operationId: "operation-1", itemId: "att_save", annotationId: " bad " }],
    })],
  ] as const)("rejects %s metadata with zero writes", async (_name, createPoison) => {
    const storage = new RecordingStorage();
    storage.seed({
      [SESSION_KEY]: createSessionFile([createCaptureRecord("save", "Save")]),
      [SESSION_META_KEY]: createPoison(),
    });
    const store = createExtensionSessionStore({ storage });

    await expect(store.read(ORIGIN)).resolves.toMatchObject({
      ok: false,
      code: "INVALID_SESSION_FILE",
    });
    expect(storage.setCalls).toEqual([]);
    expect(storage.removeCalls).toEqual([]);
  });

  test.each([
    ["missing identity", { operationId: "operation-valid", itemId: "att_save" }],
    ["null identity", {
      operationId: "operation-valid",
      itemId: "att_save",
      annotationId: null,
    }],
    ["canonical identity", {
      operationId: "operation-valid",
      itemId: "att_save",
      annotationId: "annotation-valid-receipt",
    }],
  ] as const)("accepts an exact receipt with %s", async (_name, receipt) => {
    const storage = new RecordingStorage();
    storage.seed({
      [SESSION_KEY]: createSessionFile([createCaptureRecord("save", "Save")]),
      [SESSION_META_KEY]: {
        ...createSessionMeta("epoch-valid-receipt"),
        receipts: [receipt],
      },
    });
    const store = createExtensionSessionStore({ storage });

    await expect(store.inspectCapture(ORIGIN, "operation-valid")).resolves.toMatchObject({
      ok: true,
      value: { receiptItemId: "att_save" },
    });
    expect(storage.setCalls).toEqual([]);
    expect(storage.removeCalls).toEqual([]);
  });

  test.each([
    [SESSION_KEY, "session file"],
    [SESSION_META_KEY, "session metadata"],
    [ORIGIN_CAPTURE_KEY, "compatibility capture"],
  ] as const)("distinguishes missing %s from own undefined %s", async (key) => {
    const storage = new RecordingStorage();
    storage.seed({ [key]: undefined });
    const store = createExtensionSessionStore({ storage });

    await expect(store.read(ORIGIN)).resolves.toMatchObject({
      ok: false,
      code: "INVALID_SESSION_FILE",
    });
    expect(storage.setCalls).toEqual([]);
    expect(storage.removeCalls).toEqual([]);
  });

  test("rejects metadata and receipt accessors without invoking them or writing", async () => {
    const outerGetter = vi.fn(() => createSessionMeta("epoch-outer-accessor"));
    const metadataGetter = vi.fn(() => []);
    const receiptIndexGetter = vi.fn(() => ({
      operationId: "operation-index-accessor",
      itemId: "att_save",
    }));
    const receiptGetter = vi.fn(() => "annotation-must-not-be-read");
    const outerValues: Record<string, unknown> = {};
    Object.defineProperty(outerValues, SESSION_META_KEY, {
      configurable: true,
      enumerable: true,
      get: outerGetter,
    });
    const outerStorage = new DirectReadStorage(outerValues);
    await expect(createExtensionSessionStore({ storage: outerStorage }).read(ORIGIN)).resolves
      .toMatchObject({ ok: false, code: "INVALID_SESSION_FILE" });
    expect(outerGetter).not.toHaveBeenCalled();
    expect(outerStorage.setCalls).toEqual([]);
    expect(outerStorage.removeCalls).toEqual([]);

    const metadataWithAccessor = createSessionMeta("epoch-accessor");
    Object.defineProperty(metadataWithAccessor, "receipts", {
      configurable: true,
      enumerable: true,
      get: metadataGetter,
    });
    const firstStorage = new DirectReadStorage({
      [SESSION_META_KEY]: metadataWithAccessor,
    });
    await expect(createExtensionSessionStore({ storage: firstStorage }).read(ORIGIN)).resolves
      .toMatchObject({ ok: false, code: "INVALID_SESSION_FILE" });
    expect(metadataGetter).not.toHaveBeenCalled();
    expect(firstStorage.setCalls).toEqual([]);
    expect(firstStorage.removeCalls).toEqual([]);

    const accessorReceipts = new Array(1);
    Object.defineProperty(accessorReceipts, "0", {
      configurable: true,
      enumerable: true,
      get: receiptIndexGetter,
    });
    const indexStorage = new DirectReadStorage({
      [SESSION_META_KEY]: {
        ...createSessionMeta("epoch-index-accessor"),
        receipts: accessorReceipts,
      },
    });
    await expect(createExtensionSessionStore({ storage: indexStorage }).read(ORIGIN)).resolves
      .toMatchObject({ ok: false, code: "INVALID_SESSION_FILE" });
    expect(receiptIndexGetter).not.toHaveBeenCalled();
    expect(indexStorage.setCalls).toEqual([]);
    expect(indexStorage.removeCalls).toEqual([]);

    const receipt = { operationId: "operation-accessor", itemId: "att_save" };
    Object.defineProperty(receipt, "annotationId", {
      configurable: true,
      enumerable: true,
      get: receiptGetter,
    });
    const secondStorage = new DirectReadStorage({
      [SESSION_META_KEY]: {
        ...createSessionMeta("epoch-accessor"),
        receipts: [receipt],
      },
    });
    await expect(createExtensionSessionStore({ storage: secondStorage }).read(ORIGIN)).resolves
      .toMatchObject({ ok: false, code: "INVALID_SESSION_FILE" });
    expect(receiptGetter).not.toHaveBeenCalled();
    expect(secondStorage.setCalls).toEqual([]);
    expect(secondStorage.removeCalls).toEqual([]);
  });

  test.each([
    ["commit now() throw", "commit", () => { throw new Error("clock unavailable"); }],
    ["update invalid Date", "update", () => new Date(Number.NaN)],
    ["remove toISOString throw", "remove", () => ({
      toISOString() { throw new Error("clock conversion unavailable"); },
    } as Date)],
  ] as const)("returns INVALID_SESSION_FILE with zero terminal writes for %s", async (
    _name,
    operation,
    now,
  ) => {
    const storage = new RecordingStorage();
    const record = createCaptureRecord("clock", "Clock target");
    storage.seed({
      [SESSION_KEY]: createSessionFile([record]),
      [SESSION_META_KEY]: createSessionMeta("epoch-clock"),
    });
    const store = createExtensionSessionStore({
      storage,
      now,
      randomUUID: () => "operation-clock",
    });
    const token = await store.beginCapture(ORIGIN);
    if (!token.ok) throw new Error(token.error);
    storage.clearCalls();

    const result = operation === "commit"
      ? await store.commitCapture(token.value, createCaptureRecord("new-clock", "New clock"))
      : operation === "update"
        ? await store.updateIntent(ORIGIN, "epoch-clock", record.attachment.id, "Changed")
        : await store.removeItem(ORIGIN, "epoch-clock", record.attachment.id);
    expect(result).toMatchObject({ ok: false, code: "INVALID_SESSION_FILE" });
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
  test("fails closed when clear-operation listing encounters accessors or hostile proxies", async () => {
    const outerGetter = vi.fn(() => ({
      version: 1,
      authorityId: "clear-authority-accessor",
      generation: 1,
      activeOperations: [],
    }));
    const outerValues: Record<string, unknown> = {};
    Object.defineProperty(outerValues, CAPTURE_CLEAR_AUTHORITY_STORAGE_KEY, {
      configurable: true,
      enumerable: true,
      get: outerGetter,
    });
    const outerStorage = new DirectReadStorage(outerValues);
    await expect(createExtensionSessionStore({ storage: outerStorage }).listClearOperations())
      .resolves.toEqual({
        ok: false,
        code: "INVALID_SESSION_FILE",
        error: "Stored clear authority is invalid.",
      });
    expect(outerGetter).not.toHaveBeenCalled();
    expect(outerStorage.setCalls).toEqual([]);
    expect(outerStorage.removeCalls).toEqual([]);

    const activeOperationsGetter = vi.fn(() => []);
    const accessorAuthority: Record<string, unknown> = {
      version: 1,
      authorityId: "clear-authority-nested-accessor",
      generation: 1,
    };
    Object.defineProperty(accessorAuthority, "activeOperations", {
      configurable: true,
      enumerable: true,
      get: activeOperationsGetter,
    });
    const authorityGetTrap = vi.fn(() => {
      throw new Error("hostile nested authority get");
    });
    const nestedStorage = new DirectReadStorage({
      [CAPTURE_CLEAR_AUTHORITY_STORAGE_KEY]: new Proxy(accessorAuthority, {
        get: authorityGetTrap,
      }),
    });
    await expect(createExtensionSessionStore({ storage: nestedStorage }).listClearOperations())
      .resolves.toMatchObject({ ok: false, code: "INVALID_SESSION_FILE" });
    expect(activeOperationsGetter).not.toHaveBeenCalled();
    expect(authorityGetTrap).not.toHaveBeenCalled();
    expect(nestedStorage.setCalls).toEqual([]);
    expect(nestedStorage.removeCalls).toEqual([]);

    const authorityOwnKeysTrap = vi.fn(() => {
      throw new Error("hostile authority ownKeys");
    });
    const hostileAuthority = new Proxy({} as Record<string, unknown>, {
      ownKeys: authorityOwnKeysTrap,
    });
    const hostileStorage = new DirectReadStorage({
      [CAPTURE_CLEAR_AUTHORITY_STORAGE_KEY]: hostileAuthority,
    });
    await expect(createExtensionSessionStore({ storage: hostileStorage }).listClearOperations())
      .resolves.toMatchObject({ ok: false, code: "INVALID_SESSION_FILE" });
    expect(authorityOwnKeysTrap).toHaveBeenCalledTimes(1);
    expect(hostileStorage.setCalls).toEqual([]);
    expect(hostileStorage.removeCalls).toEqual([]);

    await expect(createExtensionSessionStore({
      storage: new DirectReadStorage({}),
    }).listClearOperations()).resolves.toEqual({ ok: true, value: [] });
  });

  test("listClearOperations fails closed on a throwing getOwnPropertyDescriptor proxy", async () => {
    const ordinaryGetter = vi.fn(() => []);
    const authority: Record<string, unknown> = {
      version: 1,
      authorityId: "clear-authority-descriptor",
      generation: 1,
    };
    Object.defineProperty(authority, "activeOperations", {
      configurable: true,
      enumerable: true,
      get: ordinaryGetter,
    });
    const getTrap = vi.fn(() => {
      throw new Error("hostile clear-authority get");
    });
    const descriptorTrap = vi.fn(() => {
      throw new Error("hostile clear-authority descriptor");
    });
    const storage = new DirectReadStorage({
      [CAPTURE_CLEAR_AUTHORITY_STORAGE_KEY]: new Proxy(authority, {
        get: getTrap,
        getOwnPropertyDescriptor: descriptorTrap,
      }),
    });

    await expect(createExtensionSessionStore({ storage }).listClearOperations()).resolves.toEqual({
      ok: false,
      code: "INVALID_SESSION_FILE",
      error: "Stored clear authority is invalid.",
    });
    expect(descriptorTrap).toHaveBeenCalledTimes(1);
    expect(ordinaryGetter).not.toHaveBeenCalled();
    expect(getTrap).not.toHaveBeenCalled();
    expect(storage.setCalls).toEqual([]);
    expect(storage.removeCalls).toEqual([]);
  });

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
      {
        type: "remove",
        keys: [
          SESSION_KEY,
          ORIGIN_CAPTURE_KEY,
          getAnnotationLifecycleOperationLedgerStorageKey(ORIGIN)!,
        ],
      },
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

  test("finalizes exact clear authority and permits a seventeenth operation after restart", async () => {
    const storage = new RecordingStorage();
    let uuidIndex = 0;
    const randomUUID = () => `clear-id-${++uuidIndex}`;
    let store = createExtensionSessionStore({ storage, randomUUID });
    let epoch: string | null = null;

    for (let generation = 1; generation <= 16; generation += 1) {
      const operationId = `clear-${generation}`;
      const cleared = await store.clearOrigins({
        operationId,
        origins: [{ origin: ORIGIN, epoch }],
      });
      expect(cleared).toMatchObject({ ok: true, value: { generation } });
      if (!cleared.ok) throw new Error("clear fixture failed");
      epoch = cleared.value.origins[0]!.afterEpoch;
      await expect(store.finalizeClearOperation({
        authorityId: cleared.value.authorityId,
        operationId,
        generation,
      })).resolves.toMatchObject({ ok: true, value: { operationId, generation } });
    }

    store = createExtensionSessionStore({ storage, randomUUID });
    const seventeenth = await store.clearOrigins({
      operationId: "clear-17",
      origins: [{ origin: ORIGIN, epoch }],
    });
    expect(seventeenth).toMatchObject({ ok: true, value: { generation: 17 } });
    if (!seventeenth.ok) throw new Error("seventeenth clear fixture failed");
    await expect(store.finalizeClearOperation({
      authorityId: "wrong-authority",
      operationId: seventeenth.value.operationId,
      generation: seventeenth.value.generation,
    })).resolves.toMatchObject({ ok: false, code: "STALE_SESSION" });
    await expect(store.finalizeClearOperation({
      authorityId: seventeenth.value.authorityId,
      operationId: seventeenth.value.operationId,
      generation: seventeenth.value.generation + 1,
    })).resolves.toMatchObject({ ok: false, code: "STALE_SESSION" });
    await expect(store.finalizeClearOperation({
      authorityId: seventeenth.value.authorityId,
      operationId: seventeenth.value.operationId,
      generation: seventeenth.value.generation,
    })).resolves.toMatchObject({ ok: true });
    expect(storage.peek(CAPTURE_CLEAR_AUTHORITY_STORAGE_KEY)).toMatchObject({
      generation: 17,
      activeOperations: [],
    });
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
      requestedKeys.flatMap((key) => this.values.has(key)
        ? [[key, structuredClone(this.values.get(key))] as const]
        : []),
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

class DirectReadStorage implements ExtensionStorageArea {
  readonly setCalls: Array<Record<string, unknown>> = [];
  readonly removeCalls: string[][] = [];

  constructor(private readonly values: Record<string, unknown>) {}

  async get(_keys: string | string[] | null): Promise<Record<string, unknown>> {
    return this.values;
  }

  async set(items: Record<string, unknown>): Promise<void> {
    this.setCalls.push(items);
  }

  async remove(keys: string | string[]): Promise<void> {
    this.removeCalls.push(Array.isArray(keys) ? [...keys] : [keys]);
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

function createV2SessionFile(record: OriginCaptureRecord, annotationId: string) {
  const file = createSessionFile([record]);
  return {
    ...file,
    schemaVersion: "0.2.0" as const,
    session: {
      ...file.session,
      attachments: file.session.attachments.map((item) => ({
        ...item,
        annotationId,
        updatedAt: item.createdAt,
      })),
    },
  };
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
