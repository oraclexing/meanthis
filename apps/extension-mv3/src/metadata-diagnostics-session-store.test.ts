import { describe, expect, test } from "vitest";
import {
  UI_ATTACH_METADATA_DIAGNOSTICS_KIND,
  UI_ATTACH_METADATA_DIAGNOSTICS_SCHEMA_VERSION,
  type MetadataDiagnosticsV1,
} from "@meanthis/schema";
import type { ExtensionStorageArea } from "./capture-store";
import {
  METADATA_DIAGNOSTICS_SESSION_KIND,
  METADATA_DIAGNOSTICS_SESSION_SCHEMA_VERSION,
  createMetadataDiagnosticsSessionStore,
  canBindMetadataDiagnosticsSessionIdentity,
  getMetadataDiagnosticsSessionStorageKey,
  type MetadataDiagnosticsSessionBindingV1,
  type MetadataDiagnosticsSessionFingerprintItemV1,
} from "./metadata-diagnostics-session-store";

const ORIGIN = "https://app.example.test";
const OTHER_ORIGIN = "https://admin.example.test";
const EPOCH = "epoch-1";
const CAPTURE_ID = "capture-1";
const OBSERVED_ITEM_ID = "item-b";
const FINGERPRINT: MetadataDiagnosticsSessionFingerprintItemV1[] = [
  { itemId: "item-a", capturedAt: "2026-08-31T00:00:00.000Z" },
  { itemId: "item-b", capturedAt: "2026-08-31T00:01:00.000Z" },
];

const SIDECAR = {
  schemaVersion: UI_ATTACH_METADATA_DIAGNOSTICS_SCHEMA_VERSION,
  kind: UI_ATTACH_METADATA_DIAGNOSTICS_KIND,
  captureId: CAPTURE_ID,
  scope: "capture",
  observedAt: "2026-08-31T00:01:00.000Z",
  consent: "explicit_capture",
  authority: "capture_time",
  replay: {
    status: "collected",
    attemptCount: 1,
    verifiedCount: 1,
    ambiguousCount: 0,
    missingCount: 0,
  },
  device: {
    status: "collected",
    deviceClass: "desktop",
    viewportClass: "large",
    touch: "none",
  },
  network: { status: "not_requested" },
  console: { status: "not_requested" },
  executionAuthority: {
    grantedByCapture: false,
    browserControl: false,
    liveDomMutation: false,
  },
} satisfies MetadataDiagnosticsV1;

function binding(
  overrides: Partial<MetadataDiagnosticsSessionBindingV1> = {},
): MetadataDiagnosticsSessionBindingV1 {
  return {
    schemaVersion: METADATA_DIAGNOSTICS_SESSION_SCHEMA_VERSION,
    kind: METADATA_DIAGNOSTICS_SESSION_KIND,
    origin: ORIGIN,
    epoch: EPOCH,
    observedItemId: OBSERVED_ITEM_ID,
    fingerprint: FINGERPRINT.map((item) => ({ ...item })),
    sidecar: structuredClone(SIDECAR),
    ...overrides,
  };
}

class MemoryStorage implements ExtensionStorageArea {
  readonly values = new Map<string, unknown>();
  readonly removedKeys: string[][] = [];
  getCalls = 0;
  setCalls = 0;
  removeCalls = 0;
  failGet = false;
  failSet = false;
  failRemove = false;
  noOpSet = false;
  noOpRemove = false;
  getAllOverride: (() => Record<string, unknown>) | undefined;

  async get(keys: string | string[] | null): Promise<Record<string, unknown>> {
    this.getCalls += 1;
    if (this.failGet) throw new Error("secret storage get failure");
    if (keys === null && this.getAllOverride) return this.getAllOverride();
    if (keys === null) return Object.fromEntries(this.values);
    const requested = Array.isArray(keys) ? keys : [keys];
    return Object.fromEntries(requested.map((key) => [key, this.values.get(key)]));
  }

  async set(items: Record<string, unknown>): Promise<void> {
    this.setCalls += 1;
    if (this.failSet) throw new Error("secret storage set failure");
    if (this.noOpSet) return;
    for (const [key, value] of Object.entries(items)) this.values.set(key, value);
  }

  async remove(keys: string | string[]): Promise<void> {
    this.removeCalls += 1;
    if (this.failRemove) throw new Error("secret storage remove failure");
    const requested = Array.isArray(keys) ? keys : [keys];
    this.removedKeys.push([...requested]);
    if (this.noOpRemove) return;
    for (const key of requested) this.values.delete(key);
  }

  peek(key: string): unknown {
    return this.values.get(key);
  }
}

describe("metadata diagnostics session store", () => {
  test("writes a canonical sidecar, reads only the exact current binding, and removes it", async () => {
    const storage = new MemoryStorage();
    const store = createMetadataDiagnosticsSessionStore({ storage });
    const value = binding();

    await expect(store.write(value)).resolves.toBe(true);
    expect(storage.peek(getMetadataDiagnosticsSessionStorageKey(ORIGIN))).toEqual(value);
    expect(JSON.stringify(storage.peek(getMetadataDiagnosticsSessionStorageKey(ORIGIN))))
      .not.toContain("viewportWidth");

    await expect(store.read(ORIGIN, EPOCH, CAPTURE_ID, FINGERPRINT)).resolves.toEqual(SIDECAR);
    await expect(store.readBinding(ORIGIN, EPOCH, CAPTURE_ID, FINGERPRINT)).resolves.toEqual({
      observedItemId: OBSERVED_ITEM_ID,
      sidecar: SIDECAR,
    });
    await expect(store.read(OTHER_ORIGIN, EPOCH, CAPTURE_ID, FINGERPRINT)).resolves.toBeNull();
    await expect(store.read(ORIGIN, "epoch-stale", CAPTURE_ID, FINGERPRINT)).resolves.toBeNull();
    await expect(store.read(ORIGIN, EPOCH, "capture-stale", FINGERPRINT)).resolves.toBeNull();
    await expect(store.read(ORIGIN, EPOCH, CAPTURE_ID, [FINGERPRINT[1], FINGERPRINT[0]]))
      .resolves.toBeNull();
    await expect(store.read(ORIGIN, EPOCH, CAPTURE_ID, [
      ...FINGERPRINT,
      { itemId: "item-c", capturedAt: "2026-08-31T00:03:00.000Z" },
    ])).resolves.toBeNull();

    await expect(store.remove(ORIGIN)).resolves.toBe(true);
    expect(storage.peek(getMetadataDiagnosticsSessionStorageKey(ORIGIN))).toBeUndefined();
    await expect(store.read(ORIGIN, EPOCH, CAPTURE_ID, FINGERPRINT)).resolves.toBeNull();
    await expect(store.remove(ORIGIN)).resolves.toBe(true);
  });

  test("invalidates a stale fingerprint when the same origin and epoch receive a new binding", async () => {
    const storage = new MemoryStorage();
    const store = createMetadataDiagnosticsSessionStore({ storage });
    const first = binding();
    const second = binding({
      observedItemId: "item-new",
      fingerprint: [{ itemId: "item-new", capturedAt: "2026-08-31T00:04:00.000Z" }],
      sidecar: {
        ...SIDECAR,
        captureId: "capture-2",
        observedAt: "2026-08-31T00:04:00.000Z",
      },
    });

    await expect(store.write(first)).resolves.toBe(true);
    await expect(store.write(second)).resolves.toBe(true);
    await expect(store.read(ORIGIN, EPOCH, CAPTURE_ID, FINGERPRINT)).resolves.toBeNull();
    await expect(store.read(ORIGIN, EPOCH, "capture-2", second.fingerprint)).resolves.toEqual({
      ...SIDECAR,
      captureId: "capture-2",
      observedAt: "2026-08-31T00:04:00.000Z",
    });
  });

  test("removes only a binding that is stale against the current canonical session identity", async () => {
    const storage = new MemoryStorage();
    const store = createMetadataDiagnosticsSessionStore({ storage });
    const key = getMetadataDiagnosticsSessionStorageKey(ORIGIN);
    await expect(store.write(binding())).resolves.toBe(true);

    await expect(store.removeUnlessCurrent(ORIGIN, async () => ({
      epoch: EPOCH,
      captureId: CAPTURE_ID,
      fingerprint: FINGERPRINT,
    }))).resolves.toBe(true);
    expect(storage.peek(key)).toEqual(binding());
    expect(storage.removeCalls).toBe(0);

    await expect(store.removeUnlessCurrent(ORIGIN, async () => ({
      epoch: EPOCH,
      captureId: "capture-current",
      fingerprint: [{ itemId: "item-current", capturedAt: "2026-08-31T00:04:00.000Z" }],
    }))).resolves.toBe(true);
    expect(storage.peek(key)).toBeUndefined();
    expect(storage.removedKeys).toEqual([[key]]);
  });

  test("rejects hostile current identity without invoking accessors or deleting the binding", async () => {
    const storage = new MemoryStorage();
    const store = createMetadataDiagnosticsSessionStore({ storage });
    const key = getMetadataDiagnosticsSessionStorageKey(ORIGIN);
    await expect(store.write(binding())).resolves.toBe(true);
    let getterCalls = 0;
    const hostile = {
      epoch: EPOCH,
      captureId: CAPTURE_ID,
      fingerprint: FINGERPRINT,
    };
    Object.defineProperty(hostile, "captureId", {
      enumerable: true,
      get: () => {
        getterCalls += 1;
        return CAPTURE_ID;
      },
    });

    await expect(store.removeUnlessCurrent(ORIGIN, async () => hostile)).resolves.toBe(false);
    expect(getterCalls).toBe(0);
    expect(storage.peek(key)).toEqual(binding());
    expect(storage.removeCalls).toBe(0);
  });

  test.each([false, true])("serializes a replacement write behind stale cleanup (unrepresentable=%s)", async (unrepresentable) => {
    const storage = new MemoryStorage();
    const store = createMetadataDiagnosticsSessionStore({ storage });
    const key = getMetadataDiagnosticsSessionStorageKey(ORIGIN);
    const replacement = binding({
      observedItemId: "item-current",
      fingerprint: [{ itemId: "item-current", capturedAt: "2026-08-31T00:04:00.000Z" }],
      sidecar: {
        ...SIDECAR,
        captureId: "capture-current",
        observedAt: "2026-08-31T00:04:00.000Z",
      },
    });
    await expect(store.write(binding())).resolves.toBe(true);
    let announceRead!: () => void;
    const readStarted = new Promise<void>((resolve) => {
      announceRead = resolve;
    });
    let releaseRead!: () => void;
    const readBarrier = new Promise<void>((resolve) => {
      releaseRead = resolve;
    });

    const staleCleanup = store.removeUnlessCurrent(ORIGIN, async () => {
      announceRead();
      await readBarrier;
      return unrepresentable ? null : {
        epoch: EPOCH,
        captureId: CAPTURE_ID,
        fingerprint: [],
      };
    });
    await readStarted;
    const replacementWrite = store.write(replacement);
    releaseRead();

    await expect(staleCleanup).resolves.toBe(true);
    await expect(replacementWrite).resolves.toBe(true);
    expect(storage.peek(key)).toEqual(replacement);
    expect(storage.removedKeys).toEqual([[key]]);
  });

  test.each([
    ["own undefined", (value: Record<string, unknown>) => {
      Object.defineProperty(value, "epoch", { enumerable: true, value: undefined });
    }],
    ["missing observed item", (value: Record<string, unknown>) => {
      delete value.observedItemId;
    }],
    ["own undefined observed item", (value: Record<string, unknown>) => {
      Object.defineProperty(value, "observedItemId", { enumerable: true, value: undefined });
    }],
    ["unknown observed item", (value: Record<string, unknown>) => {
      value.observedItemId = "item-unknown";
    }],
    ["observed item timestamp mismatch", (value: Record<string, unknown>) => {
      value.observedItemId = "item-a";
    }],
    ["accessor", (value: Record<string, unknown>) => {
      Object.defineProperty(value, "sidecar", {
        enumerable: true,
        get: () => {
          throw new Error("sidecar getter must not run");
        },
      });
    }],
    ["symbol", (value: Record<string, unknown>) => {
      Object.defineProperty(value, Symbol("secret"), { enumerable: true, value: "secret" });
    }],
    ["unknown key", (value: Record<string, unknown>) => {
      Object.defineProperty(value, "rawUrl", { enumerable: true, value: "https://secret.test" });
    }],
    ["malformed origin", (value: Record<string, unknown>) => {
      value.origin = "https://app.example.test/path";
    }],
    ["overbound fingerprint", (value: Record<string, unknown>) => {
      value.fingerprint = Array.from({ length: 27 }, (_, index) => ({
        itemId: `item-${index}`,
        capturedAt: "2026-08-31T00:00:00.000Z",
      }));
    }],
    ["malformed sidecar", (value: Record<string, unknown>) => {
      value.sidecar = { ...SIDECAR, device: { status: "not_requested", raw: "secret" } };
    }],
    ["disallowed device status", (value: Record<string, unknown>) => {
      value.sidecar = { ...SIDECAR, device: { status: "not_requested" } };
    }],
    ["network collection", (value: Record<string, unknown>) => {
      value.sidecar = {
        ...SIDECAR,
        network: { status: "collected", requestCount: 1, failureCount: 0, windowMs: 1 },
      };
    }],
  ])("rejects %s without writing", async (_label, mutate) => {
    const storage = new MemoryStorage();
    const store = createMetadataDiagnosticsSessionStore({ storage });
    const value = binding() as unknown as Record<string, unknown>;
    mutate(value);

    await expect(store.write(value)).resolves.toBe(false);
    expect(storage.setCalls).toBe(0);
  });

  test("rejects accessor input without invoking any getter", async () => {
    const storage = new MemoryStorage();
    const store = createMetadataDiagnosticsSessionStore({ storage });
    let getterCalls = 0;
    const value = binding() as unknown as Record<string, unknown>;
    Object.defineProperty(value, "sidecar", {
      enumerable: true,
      get: () => {
        getterCalls += 1;
        return SIDECAR;
      },
    });
    Object.defineProperty(value, "observedItemId", {
      enumerable: true,
      get: () => {
        getterCalls += 1;
        return OBSERVED_ITEM_ID;
      },
    });
    const fingerprint = value.fingerprint as MetadataDiagnosticsSessionFingerprintItemV1[];
    Object.defineProperty(fingerprint[0], "itemId", {
      enumerable: true,
      get: () => {
        getterCalls += 1;
        return "secret-item";
      },
    });

    await expect(store.write(value)).resolves.toBe(false);
    await expect(store.read(ORIGIN, EPOCH, CAPTURE_ID, fingerprint)).resolves.toBeNull();
    expect(getterCalls).toBe(0);
  });

  test("accepts only the explicitly allowed unavailable device status", async () => {
    const storage = new MemoryStorage();
    const store = createMetadataDiagnosticsSessionStore({ storage });
    const value = binding({
      sidecar: { ...SIDECAR, device: { status: "not_available" } },
    });

    await expect(store.write(value)).resolves.toBe(true);
    await expect(store.read(ORIGIN, EPOCH, CAPTURE_ID, FINGERPRINT)).resolves.toEqual(value.sidecar);
  });

  test("requires exact set and remove readback", async () => {
    const noOpStorage = new MemoryStorage();
    noOpStorage.noOpSet = true;
    const noOpStore = createMetadataDiagnosticsSessionStore({ storage: noOpStorage });
    await expect(noOpStore.write(binding())).resolves.toBe(false);

    const storage = new MemoryStorage();
    const store = createMetadataDiagnosticsSessionStore({ storage });
    await expect(store.write(binding())).resolves.toBe(true);
    storage.values.set(getMetadataDiagnosticsSessionStorageKey(ORIGIN), { malformed: true });
    await expect(store.remove(ORIGIN)).resolves.toBe(true);
    expect(storage.peek(getMetadataDiagnosticsSessionStorageKey(ORIGIN))).toBeUndefined();
  });

  test("returns null or false on every storage failure without exposing the error", async () => {
    const storage = new MemoryStorage();
    const store = createMetadataDiagnosticsSessionStore({ storage });

    storage.failGet = true;
    await expect(store.read(ORIGIN, EPOCH, CAPTURE_ID, FINGERPRINT)).resolves.toBeNull();
    storage.failGet = false;

    storage.failSet = true;
    await expect(store.write(binding())).resolves.toBe(false);
    storage.failSet = false;

    await expect(store.write(binding())).resolves.toBe(true);
    storage.failGet = true;
    await expect(store.write(binding())).resolves.toBe(false);
    storage.failGet = false;

    storage.failRemove = true;
    await expect(store.remove(ORIGIN)).resolves.toBe(false);
    expect(storage.peek(getMetadataDiagnosticsSessionStorageKey(ORIGIN))).toBeTruthy();
  });

  test("clearAll removes only canonical diagnostics keys and preserves unrelated session keys", async () => {
    const storage = new MemoryStorage();
    const store = createMetadataDiagnosticsSessionStore({ storage });
    const other = binding({ origin: OTHER_ORIGIN });
    const unrelatedKey = "ui-attach:session:v1:https://other.example.test";
    storage.values.set(unrelatedKey, { rawText: "preserve me" });
    storage.values.set("ui-attach:other-session-state", { keep: true });

    await expect(store.write(binding())).resolves.toBe(true);
    await expect(store.write(other)).resolves.toBe(true);
    await expect(store.clearAll()).resolves.toBe(true);

    expect(storage.removedKeys).toHaveLength(1);
    expect(storage.removedKeys[0]).toEqual([
      getMetadataDiagnosticsSessionStorageKey(ORIGIN),
      getMetadataDiagnosticsSessionStorageKey(OTHER_ORIGIN),
    ]);
    expect(storage.peek(getMetadataDiagnosticsSessionStorageKey(ORIGIN))).toBeUndefined();
    expect(storage.peek(getMetadataDiagnosticsSessionStorageKey(OTHER_ORIGIN))).toBeUndefined();
    expect(storage.peek(unrelatedKey)).toEqual({ rawText: "preserve me" });
    expect(storage.peek("ui-attach:other-session-state")).toEqual({ keep: true });
  });

  test("clearAll fails closed on hostile get results without invoking getters or deleting anything", async () => {
    const storage = new MemoryStorage();
    const store = createMetadataDiagnosticsSessionStore({ storage });
    await expect(store.write(binding())).resolves.toBe(true);
    const key = getMetadataDiagnosticsSessionStorageKey(ORIGIN);
    const persisted = storage.peek(key);

    let getterCalls = 0;
    storage.getAllOverride = () => {
      const hostile = { [key]: persisted } as Record<string, unknown>;
      Object.defineProperty(hostile, "unrelatedGetter", {
        enumerable: true,
        get: () => {
          getterCalls += 1;
          return "secret";
        },
      });
      return hostile;
    };
    await expect(store.clearAll()).resolves.toBe(false);
    expect(getterCalls).toBe(0);
    expect(storage.removeCalls).toBe(0);
    expect(storage.peek(key)).toBe(persisted);

    storage.getAllOverride = () => {
      const hostile = { [key]: persisted } as Record<string, unknown>;
      Object.defineProperty(hostile, Symbol("secret"), {
        enumerable: true,
        value: "secret",
      });
      return hostile;
    };
    await expect(store.clearAll()).resolves.toBe(false);
    expect(storage.removeCalls).toBe(0);
    expect(storage.peek(key)).toBe(persisted);
  });

  test("clearAll fails closed when storage get or remove fails", async () => {
    const storage = new MemoryStorage();
    const store = createMetadataDiagnosticsSessionStore({ storage });
    await expect(store.write(binding())).resolves.toBe(true);
    const key = getMetadataDiagnosticsSessionStorageKey(ORIGIN);

    storage.failGet = true;
    await expect(store.clearAll()).resolves.toBe(false);
    expect(storage.removeCalls).toBe(0);
    storage.failGet = false;

    storage.failRemove = true;
    await expect(store.clearAll()).resolves.toBe(false);
    expect(storage.peek(key)).toBeTruthy();
    expect(storage.removeCalls).toBe(1);
    storage.failRemove = false;
    storage.noOpRemove = true;
    await expect(store.clearAll()).resolves.toBe(false);
    expect(storage.peek(key)).toBeTruthy();
  });
});

test.each([[128, true], [129, false], [132, false]])(
  "diagnostics identity expressibility checks the item-id boundary (%i)", (length, accepted) => {
    expect(canBindMetadataDiagnosticsSessionIdentity(ORIGIN, {
      epoch: EPOCH,
      captureId: CAPTURE_ID,
      fingerprint: [{ itemId: "x".repeat(length), capturedAt: "2026-08-31T00:00:00.000Z" }],
    })).toBe(accepted);
  },
);
