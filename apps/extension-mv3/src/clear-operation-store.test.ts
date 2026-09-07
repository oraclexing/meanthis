import { describe, expect, test } from "vitest";
import { createCaptureRecord, createSessionFile } from "../test/session-fixtures";
import type { ExtensionStorageArea, OriginCaptureRecord } from "./capture-store";
import {
  CAPTURE_CLEAR_AUTHORITY_STORAGE_KEY,
} from "./clear-operation";
import { createSessionMeta } from "./session-state";
import { createExtensionSessionStore } from "./session-store";

const APP_ORIGIN = "https://app.example.test";
const ADMIN_ORIGIN = "https://admin.example.test";
const APP_SESSION_KEY = `ui-attach:session:v1:${APP_ORIGIN}`;
const APP_META_KEY = `ui-attach:session:v1:meta:${APP_ORIGIN}`;
const ADMIN_SESSION_KEY = `ui-attach:session:v1:${ADMIN_ORIGIN}`;
const ADMIN_META_KEY = `ui-attach:session:v1:meta:${ADMIN_ORIGIN}`;

describe("EA-01B-CLEAR-C1 canonical clear operation", () => {
  test("persists the operation manifest before mutating any origin", async () => {
    const storage = seededStorage();
    const store = createExtensionSessionStore({
      storage,
      now: sequenceClock("2026-08-18T01:00:00.000Z", "2026-08-18T01:00:01.000Z"),
      randomUUID: sequenceUuid("authority-1", "epoch-admin-next", "epoch-app-next"),
    });

    const cleared = await store.clearOrigins({
      operationId: "clear-page-1",
      origins: [
        { origin: APP_ORIGIN, epoch: "epoch-app" },
        { origin: ADMIN_ORIGIN, epoch: "epoch-admin" },
      ],
    });

    expect(cleared).toMatchObject({
      ok: true,
      value: {
        operationId: "clear-page-1",
        authorityId: "authority-1",
        generation: 1,
        phase: "canonical_committed",
        origins: [
          { origin: ADMIN_ORIGIN, beforeEpoch: "epoch-admin", afterEpoch: "epoch-admin-next", canonical: "committed" },
          { origin: APP_ORIGIN, beforeEpoch: "epoch-app", afterEpoch: "epoch-app-next", canonical: "committed" },
        ],
      },
    });
    const firstMutation = storage.operations[0];
    expect(firstMutation).toEqual({
      type: "set",
      keys: [CAPTURE_CLEAR_AUTHORITY_STORAGE_KEY],
    });
    expect(firstMutation.keys).not.toContain(APP_META_KEY);
    expect(firstMutation.keys).not.toContain(ADMIN_META_KEY);
  });

  test("records partial canonical progress and resumes only pending origins after restart", async () => {
    const storage = seededStorage();
    const firstStore = createExtensionSessionStore({
      storage,
      now: sequenceClock("2026-08-18T02:00:00.000Z", "2026-08-18T02:00:01.000Z"),
      randomUUID: sequenceUuid("authority-1", "epoch-admin-next", "epoch-app-next"),
    });
    storage.failRemoveCall(2, "app clear interrupted");

    const interrupted = await firstStore.clearOrigins({
      operationId: "clear-page-2",
      origins: [
        { origin: APP_ORIGIN, epoch: "epoch-app" },
        { origin: ADMIN_ORIGIN, epoch: "epoch-admin" },
      ],
    });

    expect(interrupted).toMatchObject({
      ok: true,
      value: {
        authorityId: "authority-1",
        generation: 1,
        phase: "canonical_partial",
        origins: [
          { origin: ADMIN_ORIGIN, canonical: "committed" },
          { origin: APP_ORIGIN, canonical: "pending" },
        ],
      },
    });
    expect(storage.peek(ADMIN_SESSION_KEY)).toBeUndefined();
    expect(storage.peek(APP_SESSION_KEY)).toBeDefined();
    const removesBeforeRestart = storage.removeCalls.length;

    const restartedStore = createExtensionSessionStore({
      storage,
      now: sequenceClock("2026-08-18T02:01:00.000Z"),
      randomUUID: sequenceUuid("must-not-rotate-authority"),
    });
    await expect(restartedStore.listClearOperations()).resolves.toMatchObject({
      ok: true,
      value: [{
        operationId: "clear-page-2",
        authorityId: "authority-1",
        generation: 1,
        phase: "canonical_partial",
      }],
    });
    const recovered = await restartedStore.clearOrigins({
      operationId: "clear-page-2",
      origins: [
        { origin: APP_ORIGIN, epoch: "epoch-app" },
        { origin: ADMIN_ORIGIN, epoch: "epoch-admin" },
      ],
    });

    expect(recovered).toMatchObject({
      ok: true,
      value: {
        authorityId: "authority-1",
        generation: 1,
        phase: "canonical_committed",
        origins: [
          { origin: ADMIN_ORIGIN, afterEpoch: "epoch-admin-next", canonical: "committed" },
          { origin: APP_ORIGIN, afterEpoch: "epoch-app-next", canonical: "committed" },
        ],
      },
    });
    expect(storage.removeCalls.length).toBe(removesBeforeRestart + 1);
    expect(storage.peek(APP_SESSION_KEY)).toBeUndefined();
  });

  test("recovers a committed origin when its manifest progress write was interrupted", async () => {
    const storage = seededStorage();
    const firstStore = createExtensionSessionStore({
      storage,
      now: sequenceClock("2026-08-18T02:30:00.000Z"),
      randomUUID: sequenceUuid("authority-1", "epoch-app-next"),
    });
    storage.failSetCall(4, "manifest progress interrupted");
    const request = {
      operationId: "clear-page-crash-cut",
      origins: [{ origin: APP_ORIGIN, epoch: "epoch-app" }],
    };

    await expect(firstStore.clearOrigins(request)).resolves.toMatchObject({
      ok: false,
      code: "STORAGE_ERROR",
    });
    expect(storage.peek(APP_SESSION_KEY)).toBeUndefined();
    expect(storage.peek(CAPTURE_CLEAR_AUTHORITY_STORAGE_KEY)).toMatchObject({
      activeOperations: [{
        operationId: request.operationId,
        phase: "prepared",
        origins: [{ canonical: "pending", afterEpoch: "epoch-app-next" }],
      }],
    });

    const restartedStore = createExtensionSessionStore({
      storage,
      now: sequenceClock("2026-08-18T02:31:00.000Z"),
      randomUUID: sequenceUuid("must-not-be-used"),
    });
    await expect(restartedStore.clearOrigins(request)).resolves.toMatchObject({
      ok: true,
      value: {
        authorityId: "authority-1",
        generation: 1,
        phase: "canonical_committed",
        origins: [{ canonical: "committed", afterEpoch: "epoch-app-next" }],
      },
    });
  });

  test("does not mutate sessions when the prepared manifest cannot be persisted", async () => {
    const storage = seededStorage();
    const appFile = storage.peek(APP_SESSION_KEY);
    const adminFile = storage.peek(ADMIN_SESSION_KEY);
    const store = createExtensionSessionStore({
      storage,
      now: sequenceClock("2026-08-18T03:00:00.000Z"),
      randomUUID: sequenceUuid("authority-1", "epoch-admin-next", "epoch-app-next"),
    });
    storage.failNextSet("manifest unavailable");

    const failed = await store.clearOrigins({
      operationId: "clear-page-3",
      origins: [
        { origin: APP_ORIGIN, epoch: "epoch-app" },
        { origin: ADMIN_ORIGIN, epoch: "epoch-admin" },
      ],
    });

    expect(failed).toMatchObject({ ok: false, code: "STORAGE_ERROR" });
    expect(storage.removeCalls).toEqual([]);
    expect(storage.peek(APP_SESSION_KEY)).toEqual(appFile);
    expect(storage.peek(ADMIN_SESSION_KEY)).toEqual(adminFile);
  });

  test("deduplicates an exact retry and rejects an overlapping operation", async () => {
    const storage = seededStorage();
    const store = createExtensionSessionStore({
      storage,
      now: sequenceClock("2026-08-18T04:00:00.000Z", "2026-08-18T04:00:01.000Z"),
      randomUUID: sequenceUuid("authority-1", "epoch-app-next"),
    });
    const request = {
      operationId: "clear-page-4",
      origins: [{ origin: APP_ORIGIN, epoch: "epoch-app" }],
    };

    const first = await store.clearOrigins(request);
    expect(first).toMatchObject({ ok: true, value: { generation: 1, phase: "canonical_committed" } });
    const removesAfterFirst = storage.removeCalls.length;

    const repeated = await store.clearOrigins(request);
    expect(repeated).toEqual(first);
    expect(storage.removeCalls).toHaveLength(removesAfterFirst);

    await expect(store.clearOrigins({
      operationId: "clear-page-other",
      origins: [{ origin: APP_ORIGIN, epoch: "epoch-app-next" }],
    })).resolves.toMatchObject({ ok: false, code: "CLEAR_IN_PROGRESS" });
  });

  test("advances one durable global generation for a disjoint operation", async () => {
    const storage = seededStorage();
    const store = createExtensionSessionStore({
      storage,
      now: sequenceClock("2026-08-18T05:00:00.000Z", "2026-08-18T05:00:01.000Z"),
      randomUUID: sequenceUuid("authority-1", "epoch-app-next", "epoch-admin-next"),
    });

    await expect(store.clearOrigins({
      operationId: "clear-app",
      origins: [{ origin: APP_ORIGIN, epoch: "epoch-app" }],
    })).resolves.toMatchObject({
      ok: true,
      value: { authorityId: "authority-1", generation: 1 },
    });
    await expect(store.clearOrigins({
      operationId: "clear-admin",
      origins: [{ origin: ADMIN_ORIGIN, epoch: "epoch-admin" }],
    })).resolves.toMatchObject({
      ok: true,
      value: { authorityId: "authority-1", generation: 2 },
    });
    await expect(store.listClearOperations()).resolves.toMatchObject({
      ok: true,
      value: [
        { operationId: "clear-app", generation: 1, phase: "canonical_committed" },
        { operationId: "clear-admin", generation: 2, phase: "canonical_committed" },
      ],
    });
    expect(storage.peek(CAPTURE_CLEAR_AUTHORITY_STORAGE_KEY)).toMatchObject({
      authorityId: "authority-1",
      generation: 2,
      activeOperations: [
        {
          operationId: "clear-app",
          generation: 1,
          phase: "canonical_committed",
          origins: [{ origin: APP_ORIGIN, canonical: "committed" }],
        },
        {
          operationId: "clear-admin",
          generation: 2,
          phase: "canonical_committed",
          origins: [{ origin: ADMIN_ORIGIN, canonical: "committed" }],
        },
      ],
    });
  });

  test("serializes concurrent stores against one durable authority", async () => {
    const storage = seededStorage();
    const firstStore = createExtensionSessionStore({
      storage,
      now: sequenceClock("2026-08-18T05:30:00.000Z"),
      randomUUID: sequenceUuid("authority-1", "epoch-app-next"),
    });
    const secondStore = createExtensionSessionStore({
      storage,
      now: sequenceClock("2026-08-18T05:30:01.000Z"),
      randomUUID: sequenceUuid("authority-2", "epoch-other"),
    });

    const [first, second] = await Promise.all([
      firstStore.clearOrigins({
        operationId: "clear-concurrent-a",
        origins: [{ origin: APP_ORIGIN, epoch: "epoch-app" }],
      }),
      secondStore.clearOrigins({
        operationId: "clear-concurrent-b",
        origins: [{ origin: APP_ORIGIN, epoch: "epoch-app" }],
      }),
    ]);

    expect(first).toMatchObject({
      ok: true,
      value: { operationId: "clear-concurrent-a", generation: 1 },
    });
    expect(second).toMatchObject({ ok: false, code: "CLEAR_IN_PROGRESS" });
    await expect(secondStore.listClearOperations()).resolves.toMatchObject({
      ok: true,
      value: [{ operationId: "clear-concurrent-a", generation: 1 }],
    });
  });

  test("assigns distinct generations to concurrent disjoint stores", async () => {
    const storage = seededStorage();
    const firstStore = createExtensionSessionStore({
      storage,
      now: sequenceClock("2026-08-18T05:40:00.000Z"),
      randomUUID: sequenceUuid("authority-1", "epoch-app-next"),
    });
    const secondStore = createExtensionSessionStore({
      storage,
      now: sequenceClock("2026-08-18T05:40:01.000Z"),
      randomUUID: sequenceUuid("epoch-admin-next"),
    });

    const [first, second] = await Promise.all([
      firstStore.clearOrigins({
        operationId: "clear-concurrent-app",
        origins: [{ origin: APP_ORIGIN, epoch: "epoch-app" }],
      }),
      secondStore.clearOrigins({
        operationId: "clear-concurrent-admin",
        origins: [{ origin: ADMIN_ORIGIN, epoch: "epoch-admin" }],
      }),
    ]);

    expect(first).toMatchObject({ ok: true, value: { authorityId: "authority-1", generation: 1 } });
    expect(second).toMatchObject({ ok: true, value: { authorityId: "authority-1", generation: 2 } });
    await expect(firstStore.listClearOperations()).resolves.toMatchObject({
      ok: true,
      value: [
        { operationId: "clear-concurrent-app", generation: 1 },
        { operationId: "clear-concurrent-admin", generation: 2 },
      ],
    });
  });

  test("keeps the full prepared journal in one authoritative storage item", async () => {
    const storage = seededStorage();
    storage.rejectMultiKeyClearWrites = true;
    const store = createExtensionSessionStore({
      storage,
      now: sequenceClock("2026-08-18T06:00:00.000Z"),
      randomUUID: sequenceUuid("authority-1", "epoch-app-next"),
    });

    await expect(store.clearOrigins({
      operationId: "clear-single-key-journal",
      origins: [{ origin: APP_ORIGIN, epoch: "epoch-app" }],
    })).resolves.toMatchObject({
      ok: true,
      value: { phase: "canonical_committed" },
    });
    expect(storage.setCalls.filter((items) =>
      Object.hasOwn(items, CAPTURE_CLEAR_AUTHORITY_STORAGE_KEY))).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          [CAPTURE_CLEAR_AUTHORITY_STORAGE_KEY]: expect.objectContaining({
            activeOperations: [expect.objectContaining({
              operationId: "clear-single-key-journal",
              phase: "prepared",
            })],
          }),
        }),
      ]),
    );
  });

  test("rejects ambiguous ids and non-canonical persisted timestamps", async () => {
    const storage = seededStorage();
    const store = createExtensionSessionStore({ storage });

    await expect(store.clearOrigins({
      operationId: "   ",
      origins: [{ origin: APP_ORIGIN, epoch: "epoch-app" }],
    })).resolves.toMatchObject({ ok: false, code: "INVALID_SESSION_FILE" });
    storage.seed({
      [CAPTURE_CLEAR_AUTHORITY_STORAGE_KEY]: {
        version: 1,
        authorityId: "authority-1",
        generation: 1,
        activeOperations: [{
          version: 1,
          operationId: "clear-date-only",
          authorityId: "authority-1",
          generation: 1,
          phase: "prepared",
          origins: [{
            origin: APP_ORIGIN,
            beforeEpoch: "epoch-app",
            afterEpoch: "epoch-app-next",
            canonical: "pending",
          }],
          createdAt: "2026-08-18",
          updatedAt: "2026-08-18",
        }],
      },
    });
    await expect(store.listClearOperations()).resolves.toMatchObject({
      ok: false,
      code: "INVALID_SESSION_FILE",
    });
  });

  test("keeps updatedAt monotonic when the wall clock moves backward", async () => {
    const storage = seededStorage();
    const store = createExtensionSessionStore({
      storage,
      now: sequenceClock("2026-08-18T07:00:00.000Z", "2026-08-18T06:00:00.000Z"),
      randomUUID: sequenceUuid("authority-1", "epoch-app-next"),
    });

    await expect(store.clearOrigins({
      operationId: "clear-clock-rollback",
      origins: [{ origin: APP_ORIGIN, epoch: "epoch-app" }],
    })).resolves.toMatchObject({
      ok: true,
      value: {
        createdAt: "2026-08-18T07:00:00.000Z",
        updatedAt: "2026-08-18T07:00:00.000Z",
      },
    });
    await expect(store.listClearOperations()).resolves.toMatchObject({
      ok: true,
      value: [{ operationId: "clear-clock-rollback" }],
    });
  });
});

function seededStorage(): RecordingStorage {
  const storage = new RecordingStorage();
  storage.seed({
    [APP_SESSION_KEY]: createSessionFileForOrigin(APP_ORIGIN, [createCaptureRecord("app", "App")]),
    [APP_META_KEY]: createSessionMeta("epoch-app"),
    [ADMIN_SESSION_KEY]: createSessionFileForOrigin(
      ADMIN_ORIGIN,
      [createCaptureRecord("admin", "Admin")],
    ),
    [ADMIN_META_KEY]: createSessionMeta("epoch-admin"),
  });
  return storage;
}

class RecordingStorage implements ExtensionStorageArea {
  private values = new Map<string, unknown>();
  private nextSetError: string | null = null;
  private setFailures = new Map<number, string>();
  private removeFailures = new Map<number, string>();
  readonly setCalls: Array<Record<string, unknown>> = [];
  readonly removeCalls: string[][] = [];
  readonly operations: Array<{ type: "set" | "remove"; keys: string[] }> = [];
  rejectMultiKeyClearWrites = false;

  seed(items: Record<string, unknown>): void {
    for (const [key, value] of Object.entries(items)) {
      this.values.set(key, structuredClone(value));
    }
  }

  peek(key: string): unknown {
    return structuredClone(this.values.get(key));
  }

  failNextSet(message: string): void {
    this.nextSetError = message;
  }

  failSetCall(callNumber: number, message: string): void {
    this.setFailures.set(callNumber, message);
  }

  failRemoveCall(callNumber: number, message: string): void {
    this.removeFailures.set(callNumber, message);
  }

  async get(keys: string | string[] | null): Promise<Record<string, unknown>> {
    if (keys === null) {
      return Object.fromEntries(
        Array.from(this.values, ([key, value]) => [key, structuredClone(value)]),
      );
    }
    const requestedKeys = Array.isArray(keys) ? keys : [keys];
    return Object.fromEntries(
      requestedKeys
        .filter((key) => this.values.has(key))
        .map((key) => [key, structuredClone(this.values.get(key))]),
    );
  }

  async set(items: Record<string, unknown>): Promise<void> {
    this.operations.push({ type: "set", keys: Object.keys(items) });
    this.setCalls.push(structuredClone(items));
    if (this.rejectMultiKeyClearWrites &&
        Object.hasOwn(items, CAPTURE_CLEAR_AUTHORITY_STORAGE_KEY) &&
        Object.keys(items).length > 1) {
      const [first] = Object.entries(items);
      if (first) this.values.set(first[0], structuredClone(first[1]));
      throw new Error("clear journal write was not atomic");
    }
    if (this.nextSetError) {
      const message = this.nextSetError;
      this.nextSetError = null;
      throw new Error(message);
    }
    const error = this.setFailures.get(this.setCalls.length);
    if (error) {
      this.setFailures.delete(this.setCalls.length);
      throw new Error(error);
    }
    for (const [key, value] of Object.entries(items)) {
      this.values.set(key, structuredClone(value));
    }
  }

  async remove(keys: string | string[]): Promise<void> {
    const requestedKeys = Array.isArray(keys) ? keys : [keys];
    this.operations.push({ type: "remove", keys: [...requestedKeys] });
    this.removeCalls.push([...requestedKeys]);
    const error = this.removeFailures.get(this.removeCalls.length);
    if (error) {
      this.removeFailures.delete(this.removeCalls.length);
      throw new Error(error);
    }
    for (const key of requestedKeys) this.values.delete(key);
  }
}

function createSessionFileForOrigin(origin: string, records: OriginCaptureRecord[]) {
  const file = createSessionFile(records);
  file.session.origin = origin;
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
