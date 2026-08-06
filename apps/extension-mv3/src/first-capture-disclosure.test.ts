import { describe, expect, test } from "vitest";
import type { ExtensionStorageArea } from "./capture-store";
import {
  FIRST_CAPTURE_DISCLOSURE_ID,
  FIRST_CAPTURE_DISCLOSURE_STORAGE_KEY,
  createFirstCaptureDisclosureStore,
} from "./first-capture-disclosure";

describe("first capture disclosure store", () => {
  test("requires acknowledgement for the current disclosure id", async () => {
    expect(FIRST_CAPTURE_DISCLOSURE_ID).toBe("ui-attach.first-capture.v3");
    const storage = new MemoryStorage();
    const store = createFirstCaptureDisclosureStore({ storage });

    await expect(store.isAcknowledged()).resolves.toBe(false);

    await store.acknowledge();

    expect(storage.peek(FIRST_CAPTURE_DISCLOSURE_STORAGE_KEY)).toEqual({
      disclosureId: FIRST_CAPTURE_DISCLOSURE_ID,
      acknowledged: true,
    });
    await expect(store.isAcknowledged()).resolves.toBe(true);
    await expect(createFirstCaptureDisclosureStore({
      storage,
      disclosureId: "ui-attach.first-capture.v4",
    }).isAcknowledged()).resolves.toBe(false);
  });
});

class MemoryStorage implements ExtensionStorageArea {
  private readonly values = new Map<string, unknown>();

  peek(key: string): unknown {
    return structuredClone(this.values.get(key));
  }

  async get(keys: string | string[] | null): Promise<Record<string, unknown>> {
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
    for (const [key, value] of Object.entries(items)) {
      this.values.set(key, structuredClone(value));
    }
  }

  async remove(keys: string | string[]): Promise<void> {
    for (const key of Array.isArray(keys) ? keys : [keys]) {
      this.values.delete(key);
    }
  }
}
