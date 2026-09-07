import { describe, expect, test, vi } from "vitest";
import type { ExtensionStorageArea } from "./capture-store";
import {
  SELECTION_INTENT_AUTHORITY_STORAGE_KEY,
  SELECTION_INTENT_POISON_STORAGE_KEY,
  createSelectionIntentStore,
} from "./selection-intent-store";

describe("EA-01B-CLEAR-C2 durable selection intent authority", () => {
  test("blocks stale resume after clear across a worker restart until explicit Start", async () => {
    const authority = new MemoryStorage();
    const poison = new MemoryStorage();
    const first = createSelectionIntentStore({
      authorityStorage: authority,
      poisonStorage: poison,
      randomUUID: () => "selection-authority-1",
    });

    await expect(first.startExplicit(7)).resolves.toMatchObject({
      ok: true,
      value: { generation: 1, desired: "enabled", clearOperationId: null, ownerTabId: 7 },
    });
    await expect(first.stop("clear-page-1")).resolves.toMatchObject({
      ok: true,
      value: { generation: 2, desired: "stopped", clearOperationId: "clear-page-1" },
    });

    const restarted = createSelectionIntentStore({
      authorityStorage: authority,
      poisonStorage: poison,
      randomUUID: () => "must-not-rotate-authority",
    });
    await expect(restarted.resume(7, 1)).resolves.toMatchObject({ ok: false, code: "STALE_INTENT" });
    await expect(restarted.resume(7, 2)).resolves.toMatchObject({ ok: false, code: "RESUME_BLOCKED" });
    await expect(restarted.startExplicit(7, 2)).resolves.toMatchObject({
      ok: true,
      value: {
        authorityId: "selection-authority-1",
        generation: 3,
        desired: "enabled",
        ownerTabId: 7,
      },
    });
    await expect(restarted.resume(8, 3)).resolves.toMatchObject({
      ok: false,
      code: "RESUME_BLOCKED",
    });
    await expect(restarted.resume(7, 3)).resolves.toMatchObject({
      ok: true,
      value: { generation: 3, desired: "enabled", ownerTabId: 7 },
    });
  });

  test("persists a secondary poison when the primary stop fence fails", async () => {
    const authority = new MemoryStorage();
    const poison = new MemoryStorage();
    const first = createSelectionIntentStore({
      authorityStorage: authority,
      poisonStorage: poison,
      randomUUID: () => "selection-authority-1",
    });
    await expect(first.startExplicit(7)).resolves.toMatchObject({ ok: true });
    authority.set = vi.fn(async () => { throw new Error("local unavailable"); });

    await expect(first.stop("clear-page-2")).resolves.toMatchObject({
      ok: false,
      code: "STORAGE_ERROR",
    });
    expect(await poison.get(SELECTION_INTENT_POISON_STORAGE_KEY)).toEqual({
      [SELECTION_INTENT_POISON_STORAGE_KEY]: true,
    });

    const restarted = createSelectionIntentStore({
      authorityStorage: authority,
      poisonStorage: poison,
    });
    await expect(restarted.read()).resolves.toMatchObject({ ok: false, code: "AUTHORITY_UNAVAILABLE" });
  });

  test("fails closed for malformed authority and poison read failure", async () => {
    const malformedAuthority = new MemoryStorage();
    malformedAuthority.seed({ [SELECTION_INTENT_AUTHORITY_STORAGE_KEY]: { version: 1 } });
    const malformed = createSelectionIntentStore({
      authorityStorage: malformedAuthority,
      poisonStorage: new MemoryStorage(),
    });
    await expect(malformed.read()).resolves.toMatchObject({
      ok: false,
      code: "AUTHORITY_UNAVAILABLE",
    });

    const poison = new MemoryStorage();
    poison.get = vi.fn(async () => { throw new Error("session unavailable"); });
    const unreadable = createSelectionIntentStore({
      authorityStorage: new MemoryStorage(),
      poisonStorage: poison,
    });
    await expect(unreadable.startExplicit(7)).resolves.toMatchObject({
      ok: false,
      code: "AUTHORITY_UNAVAILABLE",
    });

    const ownUndefinedAuthority = new MemoryStorage();
    ownUndefinedAuthority.seed({ [SELECTION_INTENT_AUTHORITY_STORAGE_KEY]: undefined });
    await expect(createSelectionIntentStore({
      authorityStorage: ownUndefinedAuthority,
      poisonStorage: new MemoryStorage(),
    }).read()).resolves.toMatchObject({ ok: false, code: "AUTHORITY_UNAVAILABLE" });

    const ownUndefinedPoison = new MemoryStorage();
    ownUndefinedPoison.seed({ [SELECTION_INTENT_POISON_STORAGE_KEY]: undefined });
    await expect(createSelectionIntentStore({
      authorityStorage: new MemoryStorage(),
      poisonStorage: ownUndefinedPoison,
    }).read()).resolves.toMatchObject({ ok: false, code: "AUTHORITY_UNAVAILABLE" });
  });

  test("poisons a transient authority read failure before a worker restart", async () => {
    const authority = new MemoryStorage();
    const poison = new MemoryStorage();
    const first = createSelectionIntentStore({
      authorityStorage: authority,
      poisonStorage: poison,
      randomUUID: () => "selection-authority-transient-read",
    });
    await expect(first.startExplicit(7)).resolves.toMatchObject({ ok: true });

    const originalGet = authority.get.bind(authority);
    authority.get = vi.fn()
      .mockRejectedValueOnce(new Error("temporary local read failure"))
      .mockImplementation(originalGet);
    const clearingWorker = createSelectionIntentStore({ authorityStorage: authority, poisonStorage: poison });
    await expect(clearingWorker.stop("clear-after-read-failure")).resolves.toMatchObject({
      ok: false,
      code: "AUTHORITY_UNAVAILABLE",
    });
    expect(await poison.get(SELECTION_INTENT_POISON_STORAGE_KEY)).toEqual({
      [SELECTION_INTENT_POISON_STORAGE_KEY]: true,
    });

    const restarted = createSelectionIntentStore({ authorityStorage: authority, poisonStorage: poison });
    await expect(restarted.resume(7, 1)).resolves.toMatchObject({
      ok: false,
      code: "AUTHORITY_UNAVAILABLE",
    });
  });

  test("poisons generation exhaustion and invalid terminal operation IDs", async () => {
    const exhaustedAuthority = new MemoryStorage();
    const exhaustedPoison = new MemoryStorage();
    exhaustedAuthority.seed({
      [SELECTION_INTENT_AUTHORITY_STORAGE_KEY]: {
        version: 1,
        authorityId: "selection-authority-exhausted",
        generation: Number.MAX_SAFE_INTEGER,
        desired: "enabled",
        clearOperationId: null,
        ownerTabId: 7,
      },
    });
    await expect(createSelectionIntentStore({
      authorityStorage: exhaustedAuthority,
      poisonStorage: exhaustedPoison,
    }).stop("clear-at-exhaustion")).resolves.toMatchObject({
      ok: false,
      code: "GENERATION_EXHAUSTED",
    });
    expect(await exhaustedPoison.get(SELECTION_INTENT_POISON_STORAGE_KEY)).toEqual({
      [SELECTION_INTENT_POISON_STORAGE_KEY]: true,
    });

    const invalidAuthority = new MemoryStorage();
    const invalidPoison = new MemoryStorage();
    const invalid = createSelectionIntentStore({
      authorityStorage: invalidAuthority,
      poisonStorage: invalidPoison,
      randomUUID: () => "selection-authority-invalid-id",
    });
    await expect(invalid.startExplicit(7)).resolves.toMatchObject({ ok: true });
    await expect(invalid.stop(" padded-operation ")).resolves.toMatchObject({
      ok: false,
      code: "AUTHORITY_UNAVAILABLE",
    });
    expect(await invalidPoison.get(SELECTION_INTENT_POISON_STORAGE_KEY)).toEqual({
      [SELECTION_INTENT_POISON_STORAGE_KEY]: true,
    });
  });
});

class MemoryStorage implements ExtensionStorageArea {
  private values = new Map<string, unknown>();

  seed(items: Record<string, unknown>): void {
    for (const [key, value] of Object.entries(items)) this.values.set(key, structuredClone(value));
  }

  async get(keys: string | string[] | null): Promise<Record<string, unknown>> {
    const selected = keys === null ? [...this.values.keys()] : Array.isArray(keys) ? keys : [keys];
    return Object.fromEntries(selected.flatMap((key) => this.values.has(key)
      ? [[key, structuredClone(this.values.get(key))]]
      : []));
  }

  async set(items: Record<string, unknown>): Promise<void> {
    this.seed(items);
  }

  async remove(keys: string | string[]): Promise<void> {
    for (const key of Array.isArray(keys) ? keys : [keys]) this.values.delete(key);
  }
}
