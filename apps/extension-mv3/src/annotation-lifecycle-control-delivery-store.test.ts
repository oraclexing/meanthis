import { describe, expect, test } from "vitest";
import type { ExtensionStorageArea } from "./capture-store";
import {
  ANNOTATION_LIFECYCLE_CONTROL_DELIVERY_KIND,
  ANNOTATION_LIFECYCLE_CONTROL_DELIVERY_SCHEMA_VERSION,
  createAnnotationLifecycleControlDeliveryStore,
  getAnnotationLifecycleControlDeliveryStorageKey,
  type DeliveredAnnotationLifecycleOperationV1,
} from "./annotation-lifecycle-control-delivery-store";

const ORIGIN = "https://app.example.test";
const SURFACE_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const OPERATION_ID = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const FINGERPRINT = "1".repeat(64);
const DELIVERED_AT = "2026-09-01T00:00:00.000Z";
const EXPIRES_AT = "2026-09-01T00:10:00.000Z";

function delivered(
  overrides: Partial<DeliveredAnnotationLifecycleOperationV1> = {},
): DeliveredAnnotationLifecycleOperationV1 {
  return {
    schemaVersion: ANNOTATION_LIFECYCLE_CONTROL_DELIVERY_SCHEMA_VERSION,
    kind: ANNOTATION_LIFECYCLE_CONTROL_DELIVERY_KIND,
    reference: {
      operationId: OPERATION_ID,
      fingerprint: FINGERPRINT,
      ownerGeneration: 1,
      connectionGeneration: 2,
    },
    origin: ORIGIN,
    surfaceId: SURFACE_ID,
    tabId: 7,
    frameId: 0,
    documentId: "top-document-a",
    pathname: "/workspace",
    deliveredAt: DELIVERED_AT,
    expiresAt: EXPIRES_AT,
    ...overrides,
  };
}

describe("annotation lifecycle control delivery store", () => {
  test("persists, lists, reads, and removes one exact awaiting-user delivery", async () => {
    const storage = new MemoryStorage();
    const store = createAnnotationLifecycleControlDeliveryStore({ storage });
    const record = delivered();

    await expect(store.save(record)).resolves.toEqual(record);
    const key = getAnnotationLifecycleControlDeliveryStorageKey(SURFACE_ID, OPERATION_ID);
    expect(key).not.toBeNull();
    expect(storage.peek(key!)).toEqual(record);
    expect(JSON.stringify(storage.peek(key!))).not.toContain("proposal");
    expect(JSON.stringify(storage.peek(key!))).not.toContain("label");
    expect(JSON.stringify(storage.peek(key!))).not.toContain("?secret=");

    await expect(store.read(SURFACE_ID, OPERATION_ID)).resolves.toEqual(record);
    await expect(store.listAll()).resolves.toEqual([record]);

    await expect(store.remove(SURFACE_ID, OPERATION_ID)).resolves.toBeUndefined();
    await expect(store.read(SURFACE_ID, OPERATION_ID)).resolves.toBeNull();
    await expect(store.remove(SURFACE_ID, OPERATION_ID)).resolves.toBeUndefined();
  });

  test("makes exact re-save idempotent and rejects a conflicting delivery", async () => {
    const storage = new MemoryStorage();
    const store = createAnnotationLifecycleControlDeliveryStore({ storage });
    const record = delivered();

    await store.save(record);
    await expect(store.save(structuredClone(record))).resolves.toEqual(record);
    expect(storage.setCalls).toBe(1);

    await expect(store.save(delivered({
      deliveredAt: "2026-09-01T00:00:01.000Z",
    }))).rejects.toThrow("conflict");
    await expect(store.read(SURFACE_ID, OPERATION_ID)).resolves.toEqual(record);
  });

  test("lists at most 64 records deterministically and rejects overflow", async () => {
    const storage = new MemoryStorage();
    const store = createAnnotationLifecycleControlDeliveryStore({ storage });
    const records = Array.from({ length: 64 }, (_, index) => delivered({
      reference: {
        operationId: uuid(index + 1),
        fingerprint: (index + 1).toString(16).padStart(64, "0"),
        ownerGeneration: 1,
        connectionGeneration: 1,
      },
      surfaceId: uuid(10_000 + index),
      deliveredAt: new Date(Date.parse(DELIVERED_AT) + (63 - index) * 1_000).toISOString(),
    }));
    for (const record of records) await store.save(record);

    const listed = await store.listAll();
    expect(listed).toHaveLength(64);
    expect(listed.map((record) => record.deliveredAt)).toEqual(
      [...records].sort((left, right) =>
        left.deliveredAt.localeCompare(right.deliveredAt) ||
        left.surfaceId.localeCompare(right.surfaceId) ||
        left.reference.operationId.localeCompare(right.reference.operationId)
      ).map((record) => record.deliveredAt),
    );

    await expect(store.save(delivered({
      reference: {
        operationId: uuid(65),
        fingerprint: "f".repeat(64),
        ownerGeneration: 1,
        connectionGeneration: 1,
      },
      surfaceId: uuid(20_000),
    }))).rejects.toThrow("capacity");
    expect(storage.setCalls).toBe(64);
  });

  test.each([
    ["missing field", (value: Record<string, unknown>) => {
      delete value.documentId;
    }],
    ["own undefined", (value: Record<string, unknown>) => {
      Object.defineProperty(value, "documentId", { enumerable: true, value: undefined });
    }],
    ["unknown key", (value: Record<string, unknown>) => {
      value.label = "secret";
    }],
    ["null", (value: Record<string, unknown>) => {
      value.reference = null;
    }],
    ["bad operation id", (value: Record<string, unknown>) => {
      value.reference = { ...value.reference as object, operationId: "not-a-uuid" };
    }],
    ["bad fingerprint", (value: Record<string, unknown>) => {
      value.reference = { ...value.reference as object, fingerprint: "a".repeat(63) };
    }],
    ["nested own undefined", (value: Record<string, unknown>) => {
      const reference = value.reference as Record<string, unknown>;
      Object.defineProperty(reference, "fingerprint", { enumerable: true, value: undefined });
    }],
    ["nested extra key", (value: Record<string, unknown>) => {
      (value.reference as Record<string, unknown>).raw = "secret";
    }],
    ["origin with path", (value: Record<string, unknown>) => {
      value.origin = `${ORIGIN}/workspace`;
    }],
    ["pathname with query", (value: Record<string, unknown>) => {
      value.pathname = "/workspace?secret=1";
    }],
    ["noncanonical date", (value: Record<string, unknown>) => {
      value.deliveredAt = "2026-09-01T00:00:00Z";
    }],
    ["noncanonical expiry", (value: Record<string, unknown>) => {
      value.expiresAt = "2026-09-01T00:01:00Z";
    }],
    ["expired before delivery", (value: Record<string, unknown>) => {
      value.expiresAt = DELIVERED_AT;
    }],
    ["overbound delivery lifetime", (value: Record<string, unknown>) => {
      value.expiresAt = "2026-09-01T00:10:00.001Z";
    }],
    ["negative tab", (value: Record<string, unknown>) => {
      value.tabId = -1;
    }],
    ["overbound document", (value: Record<string, unknown>) => {
      value.documentId = "a".repeat(257);
    }],
  ])("rejects %s without writing", async (_label, mutate) => {
    const storage = new MemoryStorage();
    const store = createAnnotationLifecycleControlDeliveryStore({ storage });
    const value = structuredClone(delivered()) as unknown as Record<string, unknown>;
    mutate(value);

    await expect(store.save(value)).rejects.toThrow("Invalid");
    expect(storage.setCalls).toBe(0);
  });

  test("rejects top-level and nested accessors without invoking getters", async () => {
    const storage = new MemoryStorage();
    const store = createAnnotationLifecycleControlDeliveryStore({ storage });
    let getterCalls = 0;
    const topLevel = structuredClone(delivered()) as unknown as Record<string, unknown>;
    Object.defineProperty(topLevel, "documentId", {
      enumerable: true,
      get: () => {
        getterCalls += 1;
        return "secret-document";
      },
    });
    await expect(store.save(topLevel)).rejects.toThrow("Invalid");

    const nested = structuredClone(delivered()) as unknown as Record<string, unknown>;
    Object.defineProperty(nested.reference as object, "fingerprint", {
      enumerable: true,
      get: () => {
        getterCalls += 1;
        return FINGERPRINT;
      },
    });
    await expect(store.save(nested)).rejects.toThrow("Invalid");
    expect(getterCalls).toBe(0);
    expect(storage.setCalls).toBe(0);
  });

  test("fails closed on malformed storage listings and exact-remove readback failure", async () => {
    const storage = new MemoryStorage();
    const store = createAnnotationLifecycleControlDeliveryStore({ storage });
    const record = delivered();
    const key = getAnnotationLifecycleControlDeliveryStorageKey(SURFACE_ID, OPERATION_ID)!;
    storage.values.set(key, { ...record, rawUrl: `${ORIGIN}/workspace?secret=1` });
    await expect(store.listAll()).rejects.toThrow("listing");
    await expect(store.save(record)).rejects.toThrow("listing");

    storage.values.set(key, record);
    storage.noOpRemove = true;
    await expect(store.remove(SURFACE_ID, OPERATION_ID)).rejects.toThrow("readback");
  });

  test("rejects a storage listing accessor without invoking it", async () => {
    const storage = new MemoryStorage();
    const store = createAnnotationLifecycleControlDeliveryStore({ storage });
    let getterCalls = 0;
    const key = getAnnotationLifecycleControlDeliveryStorageKey(SURFACE_ID, OPERATION_ID)!;
    storage.getAllOverride = () => {
      const listing: Record<string, unknown> = {};
      Object.defineProperty(listing, key, {
        enumerable: true,
        get: () => {
          getterCalls += 1;
          return delivered();
        },
      });
      return listing;
    };

    await expect(store.listAll()).rejects.toThrow("listing");
    expect(getterCalls).toBe(0);
  });
});

function uuid(index: number): string {
  return `00000000-0000-4000-8000-${index.toString(16).padStart(12, "0")}`;
}

class MemoryStorage implements ExtensionStorageArea {
  readonly values = new Map<string, unknown>();
  setCalls = 0;
  noOpRemove = false;
  getAllOverride: (() => Record<string, unknown>) | undefined;

  async get(keys: string | string[] | null): Promise<Record<string, unknown>> {
    if (keys === null && this.getAllOverride) return this.getAllOverride();
    if (keys === null) return Object.fromEntries(this.values);
    const requested = Array.isArray(keys) ? keys : [keys];
    return Object.fromEntries(
      requested.filter((key) => this.values.has(key)).map((key) => [key, this.values.get(key)]),
    );
  }

  async set(items: Record<string, unknown>): Promise<void> {
    this.setCalls += 1;
    for (const [key, value] of Object.entries(items)) this.values.set(key, value);
  }

  async remove(keys: string | string[]): Promise<void> {
    if (this.noOpRemove) return;
    for (const key of Array.isArray(keys) ? keys : [keys]) this.values.delete(key);
  }

  peek(key: string): unknown {
    return this.values.get(key);
  }
}
