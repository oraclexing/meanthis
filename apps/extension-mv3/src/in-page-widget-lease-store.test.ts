import { describe, expect, test, vi } from "vitest";
import type { ExtensionStorageArea } from "./capture-store";
import {
  IN_PAGE_WIDGET_LEASE_STORAGE_KEY,
  createInPageWidgetLeaseStore,
} from "./in-page-widget-lease-store";

const NOW = Date.UTC(2026, 7, 13, 3, 30, 0);
const SURFACE_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const SURFACE_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const CAPABILITY_A = "A".repeat(43);
const CAPABILITY_B = "B".repeat(43);

describe("createInPageWidgetLeaseStore", () => {
  test("persists only an exact SHA-256-bound lease and restores it with the raw capability", async () => {
    const storage = new MemoryStorage();
    const store = createInPageWidgetLeaseStore({ storage, ttlMs: 60_000 });

    const saved = await store.save(leaseInput(SURFACE_A, CAPABILITY_A), NOW);

    expect(saved).toEqual({
      surfaceId: SURFACE_A,
      capabilityDigest: "0f007385b6f9d4b7eeb2748605afe1a984a0a3bfa3f014d09e2a784ce9e5cd1a",
      tabId: 7,
      windowId: 3,
      documentId: "top-document-a",
      origin: "https://app.example.test",
      pathname: "/workspace",
      expiresAt: NOW + 60_000,
      actionContext: null,
    });
    const persisted = storage.peek(IN_PAGE_WIDGET_LEASE_STORAGE_KEY);
    expect(persisted).toEqual({ schemaVersion: "1", leases: [saved] });
    expect(JSON.stringify(persisted)).not.toContain(CAPABILITY_A);
    expect(JSON.stringify(persisted)).not.toContain("capability\"");

    await expect(store.restore(SURFACE_A, CAPABILITY_A, NOW + 1)).resolves.toEqual({
      ...saved,
      expiresAt: NOW + 60_001,
    });
    await expect(store.restore(SURFACE_A, CAPABILITY_B, NOW + 1)).resolves.toBeNull();
    await expect(store.restore(SURFACE_A, CAPABILITY_A, NOW + 2)).resolves.toMatchObject({
      surfaceId: SURFACE_A,
      expiresAt: NOW + 60_002,
    });
    expect(JSON.stringify(storage.peek(IN_PAGE_WIDGET_LEASE_STORAGE_KEY)))
      .not.toContain(CAPABILITY_A);
  });

  test("restores separate action and manually selected frame contexts after worker recreation", async () => {
    const storage = new MemoryStorage();
    const store = createInPageWidgetLeaseStore({ storage });
    await store.save({
      ...leaseInput(SURFACE_A, CAPABILITY_A),
      actionContext: {
        frameId: 11,
        documentId: "child-document-a",
        origin: "https://frame.example.test",
        pathname: "/editor",
      },
      frameContext: {
        frameId: 0,
        documentId: "top-document-a",
        origin: "https://app.example.test",
        pathname: "/workspace",
      },
    }, NOW);

    await expect(store.restore(SURFACE_A, CAPABILITY_A, NOW + 1)).resolves.toMatchObject({
      actionContext: {
        frameId: 11,
        documentId: "child-document-a",
        origin: "https://frame.example.test",
        pathname: "/editor",
      },
      frameContext: {
        frameId: 0,
        documentId: "top-document-a",
        origin: "https://app.example.test",
        pathname: "/workspace",
      },
    });
    expect(JSON.stringify(storage.peek(IN_PAGE_WIDGET_LEASE_STORAGE_KEY)))
      .not.toContain(CAPABILITY_A);
  });

  test("revokes one lease without removing another", async () => {
    const storage = new MemoryStorage();
    const store = createInPageWidgetLeaseStore({ storage });
    await store.save(leaseInput(SURFACE_A, CAPABILITY_A), NOW);
    await store.save({
      ...leaseInput(SURFACE_B, CAPABILITY_B),
      tabId: 8,
      documentId: "top-document-b",
    }, NOW);

    await store.revoke(SURFACE_A);

    await expect(store.restore(SURFACE_A, CAPABILITY_A, NOW + 1)).resolves.toBeNull();
    await expect(store.restore(SURFACE_B, CAPABILITY_B, NOW + 1)).resolves.toMatchObject({
      surfaceId: SURFACE_B,
      tabId: 8,
    });
    expect((storage.peek(IN_PAGE_WIDGET_LEASE_STORAGE_KEY) as { leases: unknown[] }).leases)
      .toHaveLength(1);
  });

  test("revokes every persisted lease for one navigated tab", async () => {
    const storage = new MemoryStorage();
    const store = createInPageWidgetLeaseStore({ storage });
    await store.save(leaseInput(SURFACE_A, CAPABILITY_A), NOW);
    await store.save({
      ...leaseInput(SURFACE_B, CAPABILITY_B),
      documentId: "top-document-b",
    }, NOW);
    const surfaceC = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
    await store.save({
      ...leaseInput(surfaceC, "C".repeat(43)),
      tabId: 8,
      documentId: "top-document-c",
    }, NOW);

    await store.revokeTab(7);

    await expect(store.restore(SURFACE_A, CAPABILITY_A, NOW + 1)).resolves.toBeNull();
    await expect(store.restore(SURFACE_B, CAPABILITY_B, NOW + 1)).resolves.toBeNull();
    await expect(store.restore(surfaceC, "C".repeat(43), NOW + 1)).resolves.toMatchObject({
      tabId: 8,
    });
    expect((storage.peek(IN_PAGE_WIDGET_LEASE_STORAGE_KEY) as { leases: unknown[] }).leases)
      .toHaveLength(1);
  });

  test("atomically replaces an older surface bound to the same tab", async () => {
    const storage = new MemoryStorage();
    const store = createInPageWidgetLeaseStore({ storage });
    await store.save(leaseInput(SURFACE_A, CAPABILITY_A), NOW);

    await store.save({
      ...leaseInput(SURFACE_B, CAPABILITY_B),
      documentId: "replacement-document",
    }, NOW + 1);

    await expect(store.restore(SURFACE_A, CAPABILITY_A, NOW + 2)).resolves.toBeNull();
    await expect(store.restore(SURFACE_B, CAPABILITY_B, NOW + 2)).resolves.toMatchObject({
      surfaceId: SURFACE_B,
      tabId: 7,
      documentId: "replacement-document",
    });
    expect((storage.peek(IN_PAGE_WIDGET_LEASE_STORAGE_KEY) as { leases: unknown[] }).leases)
      .toHaveLength(1);
  });

  test("replaces the same surface and prunes expired leases before applying the count bound", async () => {
    const storage = new MemoryStorage();
    const store = createInPageWidgetLeaseStore({ storage, ttlMs: 100, maxEntries: 2 });
    await store.save(leaseInput(SURFACE_A, CAPABILITY_A), NOW);
    await store.save({
      ...leaseInput(SURFACE_B, CAPABILITY_B),
      tabId: 8,
      documentId: "top-document-b",
    }, NOW + 50);
    await store.save({
      ...leaseInput(SURFACE_A, CAPABILITY_B),
      tabId: 9,
      documentId: "top-document-c",
    }, NOW + 101);

    const persisted = storage.peek(IN_PAGE_WIDGET_LEASE_STORAGE_KEY) as {
      schemaVersion: string;
      leases: Array<{ surfaceId: string; tabId: number }>;
    };
    expect(persisted.leases).toEqual([
      expect.objectContaining({ surfaceId: SURFACE_B, tabId: 8 }),
      expect.objectContaining({ surfaceId: SURFACE_A, tabId: 9 }),
    ]);
    await expect(store.restore(SURFACE_A, CAPABILITY_B, NOW + 102)).resolves.toMatchObject({
      tabId: 9,
    });
  });

  test("evicts the earliest-expiring lease when a valid snapshot reaches capacity", async () => {
    const storage = new MemoryStorage();
    const store = createInPageWidgetLeaseStore({ storage, ttlMs: 1_000, maxEntries: 2 });
    const surfaceC = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
    await store.save(leaseInput(SURFACE_A, CAPABILITY_A), NOW);
    await store.save({
      ...leaseInput(SURFACE_B, CAPABILITY_B),
      tabId: 8,
      documentId: "top-document-b",
    }, NOW + 1);
    await store.save({
      ...leaseInput(surfaceC, "C".repeat(43)),
      tabId: 9,
      documentId: "top-document-c",
    }, NOW + 2);

    await expect(store.restore(SURFACE_A, CAPABILITY_A, NOW + 3)).resolves.toBeNull();
    await expect(store.restore(SURFACE_B, CAPABILITY_B, NOW + 3)).resolves.toMatchObject({
      tabId: 8,
    });
    await expect(store.restore(surfaceC, "C".repeat(43), NOW + 3)).resolves.toMatchObject({
      tabId: 9,
    });
  });

  test("rejects save input before hashing or writing", async () => {
    const storage = new MemoryStorage();
    const digest = vi.fn(async () => "0".repeat(64));
    const store = createInPageWidgetLeaseStore({ storage, digest });
    const valid = leaseInput(SURFACE_A, CAPABILITY_A);
    const invalidInputs = [
      { ...valid, surfaceId: "not-a-uuid" },
      { ...valid, capability: "secret" },
      { ...valid, tabId: -1 },
      { ...valid, windowId: 1.5 },
      { ...valid, documentId: "" },
      { ...valid, documentId: "x".repeat(257) },
      { ...valid, origin: "https://app.example.test/path" },
      { ...valid, origin: "chrome-extension://extension-id" },
      { ...valid, pathname: "workspace" },
      { ...valid, pathname: "/workspace?secret=1" },
      { ...valid, extra: "unexpected" },
    ];

    for (const input of invalidInputs) {
      await expect(store.save(input as never, NOW)).rejects.toThrow(/invalid/i);
    }
    expect(digest).not.toHaveBeenCalled();
    expect(storage.peek(IN_PAGE_WIDGET_LEASE_STORAGE_KEY)).toBeUndefined();
  });

  test.each([
    undefined,
    null,
    [],
    { schemaVersion: "2", leases: [] },
    { schemaVersion: "1", leases: [] },
    { schemaVersion: "1", leases: [], extra: true },
    { schemaVersion: "1", leases: "not-an-array" },
    { schemaVersion: "1", leases: [{ surfaceId: SURFACE_A }] },
    { schemaVersion: "1", leases: [persistedLease({ extra: true })] },
    {
      schemaVersion: "1",
      leases: [persistedLease({ capabilityDigest: "A".repeat(64) })],
    },
    {
      schemaVersion: "1",
      leases: [persistedLease({ origin: "https://app.example.test/path" })],
    },
    {
      schemaVersion: "1",
      leases: [persistedLease(), persistedLease()],
    },
    {
      schemaVersion: "1",
      leases: [
        persistedLease(),
        persistedLease({
          surfaceId: SURFACE_B,
          capabilityDigest: "412dc46cc9e3cb26f29f7c1415c556349af62904c5d15b0a2d8cfdc5cfa22b34",
        }),
      ],
    },
  ])("fails closed for a malformed persisted snapshot %#", async (snapshot) => {
    const storage = new MemoryStorage({ [IN_PAGE_WIDGET_LEASE_STORAGE_KEY]: snapshot });
    const store = createInPageWidgetLeaseStore({ storage });

    await expect(store.restore(SURFACE_A, CAPABILITY_A, NOW)).resolves.toBeNull();

    expect(storage.peek(IN_PAGE_WIDGET_LEASE_STORAGE_KEY)).toBeUndefined();
  });

  test("removes the whole snapshot when any entry is expired or beyond the configured TTL", async () => {
    const cases = [
      persistedLease({ expiresAt: NOW }),
      persistedLease({ expiresAt: NOW + 300_001 }),
    ];
    for (const lease of cases) {
      const storage = new MemoryStorage({
        [IN_PAGE_WIDGET_LEASE_STORAGE_KEY]: { schemaVersion: "1", leases: [lease] },
      });
      const store = createInPageWidgetLeaseStore({ storage, ttlMs: 300_000 });
      await expect(store.restore(SURFACE_A, CAPABILITY_A, NOW)).resolves.toBeNull();
      expect(storage.peek(IN_PAGE_WIDGET_LEASE_STORAGE_KEY)).toBeUndefined();
    }
  });

  test("fails closed when persisted count exceeds the configured maximum", async () => {
    const storage = new MemoryStorage({
      [IN_PAGE_WIDGET_LEASE_STORAGE_KEY]: {
        schemaVersion: "1",
        leases: [
          persistedLease(),
          persistedLease({
            surfaceId: SURFACE_B,
            capabilityDigest: "412dc46cc9e3cb26f29f7c1415c556349af62904c5d15b0a2d8cfdc5cfa22b34",
            tabId: 8,
          }),
        ],
      },
    });
    const store = createInPageWidgetLeaseStore({ storage, maxEntries: 1 });

    await expect(store.restore(SURFACE_A, CAPABILITY_A, NOW)).resolves.toBeNull();
    expect(storage.peek(IN_PAGE_WIDGET_LEASE_STORAGE_KEY)).toBeUndefined();
  });

  test("does not mutate a valid authority if capability hashing fails during restore", async () => {
    const storage = new MemoryStorage({
      [IN_PAGE_WIDGET_LEASE_STORAGE_KEY]: {
        schemaVersion: "1",
        leases: [persistedLease()],
      },
    });
    const store = createInPageWidgetLeaseStore({
      storage,
      digest: async () => {
        throw new Error("digest unavailable");
      },
    });

    await expect(store.restore(SURFACE_A, CAPABILITY_A, NOW)).resolves.toBeNull();
    expect(storage.peek(IN_PAGE_WIDGET_LEASE_STORAGE_KEY)).toEqual({
      schemaVersion: "1",
      leases: [persistedLease()],
    });
  });

  test("recovers a trusted save by replacing a malformed snapshot", async () => {
    const storage = new MemoryStorage({
      [IN_PAGE_WIDGET_LEASE_STORAGE_KEY]: { schemaVersion: "1", leases: "tampered" },
    });
    const store = createInPageWidgetLeaseStore({ storage });

    await store.save(leaseInput(SURFACE_A, CAPABILITY_A), NOW);

    await expect(store.restore(SURFACE_A, CAPABILITY_A, NOW + 1)).resolves.toMatchObject({
      surfaceId: SURFACE_A,
    });
    expect(JSON.stringify(storage.peek(IN_PAGE_WIDGET_LEASE_STORAGE_KEY)))
      .not.toContain(CAPABILITY_A);
  });

  test("serializes concurrent save and revoke mutations without resurrecting a lease", async () => {
    const storage = new DelayedStorage();
    const store = createInPageWidgetLeaseStore({ storage });

    const save = store.save(leaseInput(SURFACE_A, CAPABILITY_A), NOW);
    const revoke = store.revoke(SURFACE_A);
    await Promise.all([save, revoke]);

    expect(storage.peek(IN_PAGE_WIDGET_LEASE_STORAGE_KEY)).toBeUndefined();
  });

  test("serializes mutations across store instances sharing one worker storage area", async () => {
    const storage = new DelayedStorage();
    const firstStore = createInPageWidgetLeaseStore({ storage });
    const secondStore = createInPageWidgetLeaseStore({ storage });

    await Promise.all([
      firstStore.save(leaseInput(SURFACE_A, CAPABILITY_A), NOW),
      secondStore.save({
        ...leaseInput(SURFACE_B, CAPABILITY_B),
        tabId: 8,
        documentId: "top-document-b",
      }, NOW),
    ]);

    await expect(firstStore.restore(SURFACE_A, CAPABILITY_A, NOW + 1)).resolves.toMatchObject({
      surfaceId: SURFACE_A,
    });
    await expect(secondStore.restore(SURFACE_B, CAPABILITY_B, NOW + 1)).resolves.toMatchObject({
      surfaceId: SURFACE_B,
    });
    expect((storage.peek(IN_PAGE_WIDGET_LEASE_STORAGE_KEY) as { leases: unknown[] }).leases)
      .toHaveLength(2);
  });

  test("validates option bounds eagerly", () => {
    const storage = new MemoryStorage();
    expect(() => createInPageWidgetLeaseStore({ storage, maxEntries: 0 })).toThrow(/maxEntries/);
    expect(() => createInPageWidgetLeaseStore({ storage, maxEntries: 65 })).toThrow(/maxEntries/);
    expect(() => createInPageWidgetLeaseStore({ storage, ttlMs: 0 })).toThrow(/ttlMs/);
    expect(() => createInPageWidgetLeaseStore({ storage, ttlMs: 3_600_001 })).toThrow(/ttlMs/);
  });

  test("rejects timestamps whose renewed expiry would exceed the safe integer range", async () => {
    const storage = new MemoryStorage({
      [IN_PAGE_WIDGET_LEASE_STORAGE_KEY]: {
        schemaVersion: "1",
        leases: [persistedLease()],
      },
    });
    const digest = vi.fn(async () => "0".repeat(64));
    const store = createInPageWidgetLeaseStore({ storage, digest });

    await expect(store.save(
      leaseInput(SURFACE_B, CAPABILITY_B),
      Number.MAX_SAFE_INTEGER,
    )).rejects.toThrow(/invalid/i);
    await expect(store.restore(
      SURFACE_A,
      CAPABILITY_A,
      Number.MAX_SAFE_INTEGER,
    )).resolves.toBeNull();

    expect(digest).not.toHaveBeenCalled();
    expect(storage.peek(IN_PAGE_WIDGET_LEASE_STORAGE_KEY)).toEqual({
      schemaVersion: "1",
      leases: [persistedLease()],
    });
  });

  test("rejects invalid revoke identifiers without touching storage", async () => {
    const storage = new MemoryStorage();
    const store = createInPageWidgetLeaseStore({ storage });
    await expect(store.revoke("invalid")).rejects.toThrow(/surface id/i);
    await expect(store.revokeTab(-1)).rejects.toThrow(/tab id/i);
    expect(storage.peek(IN_PAGE_WIDGET_LEASE_STORAGE_KEY)).toBeUndefined();
  });
});

function leaseInput(surfaceId: string, capability: string) {
  return {
    surfaceId,
    capability,
    tabId: 7,
    windowId: 3,
    documentId: "top-document-a",
    origin: "https://app.example.test",
    pathname: "/workspace",
  };
}

function persistedLease(overrides: Record<string, unknown> = {}) {
  return {
    surfaceId: SURFACE_A,
    capabilityDigest: "0f007385b6f9d4b7eeb2748605afe1a984a0a3bfa3f014d09e2a784ce9e5cd1a",
    tabId: 7,
    windowId: 3,
    documentId: "top-document-a",
    origin: "https://app.example.test",
    pathname: "/workspace",
    expiresAt: NOW + 300_000,
    ...overrides,
  };
}

class MemoryStorage implements ExtensionStorageArea {
  protected readonly values = new Map<string, unknown>();

  constructor(seed: Record<string, unknown> = {}) {
    for (const [key, value] of Object.entries(seed)) this.values.set(key, structuredClone(value));
  }

  peek(key: string): unknown {
    return structuredClone(this.values.get(key));
  }

  async get(keys: string | string[] | null): Promise<Record<string, unknown>> {
    const requested = keys === null ? [...this.values.keys()] : Array.isArray(keys) ? keys : [keys];
    return Object.fromEntries(requested.map((key) => [key, structuredClone(this.values.get(key))]));
  }

  async set(items: Record<string, unknown>): Promise<void> {
    for (const [key, value] of Object.entries(items)) this.values.set(key, structuredClone(value));
  }

  async remove(keys: string | string[]): Promise<void> {
    for (const key of Array.isArray(keys) ? keys : [keys]) this.values.delete(key);
  }
}

class DelayedStorage extends MemoryStorage {
  override async get(keys: string | string[] | null): Promise<Record<string, unknown>> {
    await Promise.resolve();
    return super.get(keys);
  }

  override async set(items: Record<string, unknown>): Promise<void> {
    await Promise.resolve();
    await super.set(items);
  }
}
