import { describe, expect, it, vi } from "vitest";
import type { ExtensionStorageArea } from "./capture-store";
import {
  ANNOTATION_LIFECYCLE_CONTROL_EXECUTION_STORAGE_PREFIX,
  createAnnotationLifecycleControlExecutionStore,
  parseApprovedAnnotationLifecycleOperation,
} from "./annotation-lifecycle-control-execution-store";

const ORIGIN = "https://example.com";
const OPERATION_ID = "11111111-1111-4111-8111-111111111111";
const FINGERPRINT = "a".repeat(64);

describe("annotation lifecycle control execution store", () => {
  it("persists approved then committed state with exact readback and idempotent replay", async () => {
    const storage = new MemoryStorage();
    const store = createAnnotationLifecycleControlExecutionStore({ storage });
    const approved = createApprovedRecord();

    await expect(store.saveApproved(approved)).resolves.toEqual(approved);
    await expect(store.saveApproved(approved)).resolves.toEqual(approved);
    expect(storage.set).toHaveBeenCalledTimes(1);

    const receipt = createLedgerReceipt();
    const committed = await store.markCommitted(ORIGIN, OPERATION_ID, FINGERPRINT, receipt);
    expect(committed).toEqual({ ...approved, phase: "committed", committedReceipt: receipt });
    await expect(store.markCommitted(ORIGIN, OPERATION_ID, FINGERPRINT, receipt))
      .resolves.toEqual(committed);
    expect(storage.set).toHaveBeenCalledTimes(2);
    await expect(store.read(ORIGIN, OPERATION_ID)).resolves.toEqual(committed);
    await expect(store.listAll()).resolves.toEqual([committed]);
  });

  it("persists exact terminal intent before ACK and never terminalizes a commit", async () => {
    const storage = new MemoryStorage();
    const store = createAnnotationLifecycleControlExecutionStore({ storage });
    const approved = createApprovedRecord();
    await store.saveApproved(approved);

    const terminal = await store.markTerminal(
      ORIGIN,
      OPERATION_ID,
      FINGERPRINT,
      "cancelled",
      "2026-09-01T00:00:02.000Z",
    );
    expect(terminal).toEqual({
      ...approved,
      phase: "terminal",
      terminalStatus: "cancelled",
      terminalObservedAt: "2026-09-01T00:00:02.000Z",
    });
    await expect(store.markTerminal(
      ORIGIN,
      OPERATION_ID,
      FINGERPRINT,
      "cancelled",
      "2026-09-01T00:00:02.000Z",
    )).resolves.toEqual(terminal);
    await expect(store.markTerminal(
      ORIGIN,
      OPERATION_ID,
      FINGERPRINT,
      "blocked",
      "2026-09-01T00:00:03.000Z",
    )).rejects.toThrow(/conflict/i);
    await expect(store.markCommitted(ORIGIN, OPERATION_ID, FINGERPRINT, createLedgerReceipt()))
      .rejects.toThrow(/terminal/i);

    const second = createApprovedRecord({
      origin: "https://other.example",
      operationId: "22222222-2222-4222-8222-222222222222",
    });
    await store.saveApproved(second);
    const secondReceipt = {
      ...createLedgerReceipt(),
      operationId: second.proposal.operationId,
      itemId: second.itemId,
    };
    const committed = await store.markCommitted(
      second.origin,
      second.proposal.operationId,
      FINGERPRINT,
      secondReceipt,
    );
    await expect(store.markTerminal(
      committed.origin,
      committed.proposal.operationId,
      FINGERPRINT,
      "cancelled",
      "2026-09-01T00:00:03.000Z",
    )).rejects.toThrow(/cannot become terminal/i);
  });

  it("rejects conflicts, accessors, own undefined, malformed and stale commit bindings", async () => {
    const storage = new MemoryStorage();
    const store = createAnnotationLifecycleControlExecutionStore({ storage });
    const approved = createApprovedRecord();
    await store.saveApproved(approved);

    await expect(store.saveApproved({ ...approved, itemId: "item-2" })).rejects.toThrow(/conflict/i);
    await expect(store.markCommitted(ORIGIN, OPERATION_ID, "b".repeat(64), createLedgerReceipt()))
      .rejects.toThrow(/binding/i);
    await expect(store.markCommitted(
      ORIGIN,
      OPERATION_ID,
      FINGERPRINT,
      { ...createLedgerReceipt(), itemId: "item-2" },
    )).rejects.toThrow(/receipt/i);

    let getterCalls = 0;
    const accessor = Object.defineProperty({}, "schemaVersion", {
      enumerable: true,
      get() {
        getterCalls += 1;
        return "0.1.0";
      },
    });
    expect(parseApprovedAnnotationLifecycleOperation(accessor)).toBeNull();
    expect(getterCalls).toBe(0);
    expect(parseApprovedAnnotationLifecycleOperation({ ...approved, phase: undefined })).toBeNull();
    expect(parseApprovedAnnotationLifecycleOperation({ ...approved, extra: true })).toBeNull();
    expect(parseApprovedAnnotationLifecycleOperation({
      ...approved,
      approval: { ...approved.approval, expiresAt: approved.approval.approvedAt },
    })).toBeNull();
    expect(parseApprovedAnnotationLifecycleOperation({
      ...approved,
      approval: { ...approved.approval, expiresAt: "2026-09-01T00:10:00.001Z" },
    })).toBeNull();
  });

  it("purges exact origins, removes exact operations and verifies terminal absence", async () => {
    const storage = new MemoryStorage();
    const store = createAnnotationLifecycleControlExecutionStore({ storage });
    const first = createApprovedRecord();
    const second = createApprovedRecord({
      origin: "https://other.example",
      operationId: "22222222-2222-4222-8222-222222222222",
    });
    await store.saveApproved(first);
    await store.saveApproved(second);

    await store.purgeOrigin(ORIGIN);
    await expect(store.read(ORIGIN, OPERATION_ID)).resolves.toBeNull();
    await expect(store.read(second.origin, second.proposal.operationId)).resolves.toEqual(second);

    await store.remove(second.origin, second.proposal.operationId);
    await expect(store.read(second.origin, second.proposal.operationId)).resolves.toBeNull();
    expect(Object.keys(await storage.get(null)).some((key) =>
      key.startsWith(ANNOTATION_LIFECYCLE_CONTROL_EXECUTION_STORAGE_PREFIX)
    )).toBe(false);
  });

  it("purges only execution records owned by an invalidated tab", async () => {
    const storage = new MemoryStorage();
    const store = createAnnotationLifecycleControlExecutionStore({ storage });
    const first = createApprovedRecord();
    const second = createApprovedRecord({
      origin: "https://other.example",
      operationId: "22222222-2222-4222-8222-222222222222",
      tabId: 9,
    });
    await store.saveApproved(first);
    await store.saveApproved(second);
    await store.purgeTab(5);
    await expect(store.read(first.origin, first.proposal.operationId)).resolves.toBeNull();
    await expect(store.read(second.origin, second.proposal.operationId)).resolves.toEqual(second);
  });

  it("lists exact bounded records deterministically and rejects malformed matching entries", async () => {
    const storage = new MemoryStorage();
    const store = createAnnotationLifecycleControlExecutionStore({ storage });
    const later = createApprovedRecord({
      origin: "https://other.example",
      operationId: "22222222-2222-4222-8222-222222222222",
      approvedAt: "2026-09-01T00:00:01.000Z",
    });
    const earlier = createApprovedRecord();
    await store.saveApproved(later);
    await store.saveApproved(earlier);
    await expect(store.listAll()).resolves.toEqual([earlier, later]);

    storage.values.set(
      `${ANNOTATION_LIFECYCLE_CONTROL_EXECUTION_STORAGE_PREFIX}malformed`,
      { ...earlier, phase: undefined },
    );
    await expect(store.listAll()).rejects.toThrow(/listing/i);
  });

  it("allows exact replay at capacity and rejects a new 65th record without writing", async () => {
    const storage = new MemoryStorage();
    const store = createAnnotationLifecycleControlExecutionStore({ storage });
    const records = Array.from({ length: 64 }, (_, index) => createApprovedRecord({
      origin: `https://site-${index}.example`,
      operationId: uuid(index + 1),
      approvedAt: new Date(Date.parse("2026-09-01T00:00:00.000Z") + index).toISOString(),
    }));
    for (const record of records) await store.saveApproved(record);
    expect(storage.set).toHaveBeenCalledTimes(64);
    await expect(store.listAll()).resolves.toHaveLength(64);

    await expect(store.saveApproved(structuredClone(records[63])))
      .resolves.toEqual(records[63]);
    expect(storage.set).toHaveBeenCalledTimes(64);
    await expect(store.saveApproved({ ...records[63], itemId: "conflicting-item" }))
      .rejects.toThrow(/conflict/i);
    expect(storage.set).toHaveBeenCalledTimes(64);

    const sixtyFifth = createApprovedRecord({
      origin: "https://site-64.example",
      operationId: uuid(65),
      approvedAt: "2026-09-01T00:00:01.000Z",
    });
    await expect(store.saveApproved(sixtyFifth)).rejects.toThrow(/capacity/i);
    expect(storage.set).toHaveBeenCalledTimes(64);
    await expect(store.read(sixtyFifth.origin, sixtyFifth.proposal.operationId))
      .resolves.toBeNull();
  });

  it("rejects a new save against malformed or overbound listings without writing", async () => {
    const malformedStorage = new MemoryStorage();
    const malformedStore = createAnnotationLifecycleControlExecutionStore({
      storage: malformedStorage,
    });
    const malformed = createApprovedRecord();
    malformedStorage.values.set(
      executionStorageKey(malformed.origin, malformed.proposal.operationId),
      { ...malformed, phase: undefined },
    );
    const candidate = createApprovedRecord({
      origin: "https://new.example",
      operationId: uuid(100),
    });
    await expect(malformedStore.saveApproved(candidate)).rejects.toThrow(/listing/i);
    expect(malformedStorage.set).not.toHaveBeenCalled();

    const overboundStorage = new MemoryStorage();
    const overboundStore = createAnnotationLifecycleControlExecutionStore({
      storage: overboundStorage,
    });
    for (let index = 0; index < 65; index += 1) {
      const record = createApprovedRecord({
        origin: `https://overbound-${index}.example`,
        operationId: uuid(1_000 + index),
      });
      overboundStorage.values.set(
        executionStorageKey(record.origin, record.proposal.operationId),
        record,
      );
    }
    await expect(overboundStore.saveApproved(candidate)).rejects.toThrow(/listing/i);
    expect(overboundStorage.set).not.toHaveBeenCalled();
  });

  it("fails closed when storage readback does not match the write", async () => {
    const storage = new MemoryStorage();
    const originalGet = storage.get;
    storage.get = vi.fn(async (keys) => {
      const values = await originalGet(keys);
      if (storage.set.mock.calls.length > 0 && typeof keys === "string") return {};
      return values;
    });
    const store = createAnnotationLifecycleControlExecutionStore({ storage });
    await expect(store.saveApproved(createApprovedRecord())).rejects.toThrow(/readback/i);
  });
});

function createApprovedRecord(overrides: {
  origin?: string;
  operationId?: string;
  tabId?: number;
  approvedAt?: string;
} = {}) {
  const operationId = overrides.operationId ?? OPERATION_ID;
  return {
    schemaVersion: "0.1.0" as const,
    kind: "ui-attach.annotation-lifecycle-approved-operation" as const,
    phase: "approved" as const,
    proposal: {
      schemaVersion: "0.1.0" as const,
      kind: "ui-attach.annotation-lifecycle-operation" as const,
      operationId,
      instanceId: "instance-0123456789ab",
      captureId: "capture-1",
      expectedSequence: 3,
      annotationId: "annotation:1",
      expectedState: "open" as const,
      nextState: "resolved" as const,
    },
    reference: {
      operationId,
      fingerprint: FINGERPRINT,
      ownerGeneration: 4,
      connectionGeneration: 7,
    },
    approval: {
      approvedAt: overrides.approvedAt ?? "2026-09-01T00:00:00.000Z",
      expiresAt: "2026-09-01T00:01:00.000Z",
    },
    origin: overrides.origin ?? ORIGIN,
    epoch: "epoch-1",
    itemId: "item-1",
    surfaceId: "33333333-3333-4333-a333-333333333333",
    tabId: overrides.tabId ?? 5,
    frameId: 0,
    documentId: "doc-1",
    pathname: "/page",
    routeLeaseHash: "b".repeat(64),
    terminalStatus: null,
    terminalObservedAt: null,
    committedReceipt: null,
  };
}

function createLedgerReceipt() {
  return {
    schemaVersion: "0.1.0" as const,
    kind: "ui-attach.annotation-lifecycle-operation-ledger-receipt" as const,
    operationId: OPERATION_ID,
    requestHash: FINGERPRINT,
    epoch: "epoch-1",
    itemId: "item-1",
    annotationId: "annotation:1",
    previousState: "open" as const,
    nextState: "resolved" as const,
    appliedAt: "2026-09-01T00:00:01.000Z",
  };
}

function uuid(index: number): string {
  return `00000000-0000-4000-8000-${index.toString(16).padStart(12, "0")}`;
}

function executionStorageKey(origin: string, operationId: string): string {
  return `${ANNOTATION_LIFECYCLE_CONTROL_EXECUTION_STORAGE_PREFIX}${encodeURIComponent(origin)}:${operationId}`;
}

class MemoryStorage implements ExtensionStorageArea {
  readonly values = new Map<string, unknown>();
  get = vi.fn(async (keys: string | string[] | null): Promise<Record<string, unknown>> => {
    const selected = keys === null
      ? [...this.values.keys()]
      : Array.isArray(keys) ? keys : [keys];
    return Object.fromEntries(selected.flatMap((key) =>
      this.values.has(key) ? [[key, structuredClone(this.values.get(key))]] : []
    ));
  });
  set = vi.fn(async (items: Record<string, unknown>): Promise<void> => {
    for (const [key, value] of Object.entries(items)) this.values.set(key, structuredClone(value));
  });
  remove = vi.fn(async (keys: string | string[]): Promise<void> => {
    for (const key of Array.isArray(keys) ? keys : [keys]) this.values.delete(key);
  });
}
