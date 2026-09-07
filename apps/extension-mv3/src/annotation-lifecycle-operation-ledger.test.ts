import type { CaptureSessionFileV3 } from "@meanthis/hub-core";
import { describe, expect, test, vi } from "vitest";
import { createCaptureRecord, createSessionFile } from "../test/session-fixtures";
import {
  ANNOTATION_LIFECYCLE_OPERATION_LEDGER_KIND,
  ANNOTATION_LIFECYCLE_OPERATION_LEDGER_MAX_RECEIPTS,
  ANNOTATION_LIFECYCLE_OPERATION_LEDGER_RECEIPT_KIND,
  ANNOTATION_LIFECYCLE_OPERATION_LEDGER_SCHEMA_VERSION,
  appendAnnotationLifecycleOperationLedgerReceipt,
  createAnnotationLifecycleOperationAtomicStoragePayload,
  createEmptyAnnotationLifecycleOperationLedger,
  getAnnotationLifecycleOperationLedgerPurgeKeys,
  getAnnotationLifecycleOperationLedgerStorageKey,
  parseAnnotationLifecycleOperationAtomicReadback,
  parseAnnotationLifecycleOperationLedger,
  parseAnnotationLifecycleOperationLedgerReceipt,
  type AnnotationLifecycleOperationLedgerReceiptV1,
} from "./annotation-lifecycle-operation-ledger";

const ORIGIN = "https://app.example.test";
const OPERATION_ID = "11111111-1111-4111-8111-111111111111";
const REQUEST_HASH = "a".repeat(64);
const APPLIED_AT = "2026-08-31T10:00:01.000Z";

describe("dormant annotation lifecycle operation ledger", () => {
  test("parses and detaches the exact private receipt schema", () => {
    expect(parseAnnotationLifecycleOperationLedgerReceipt(createReceipt())).toEqual({
      ok: true,
      value: createReceipt(),
    });
  });

  test.each([
    ["missing", omit(createReceipt(), "epoch")],
    ["own undefined", { ...createReceipt(), epoch: undefined }],
    ["null", { ...createReceipt(), epoch: null }],
    ["extra", { ...createReceipt(), origin: ORIGIN }],
    ["uuid", { ...createReceipt(), operationId: "operation-1" }],
    ["hash", { ...createReceipt(), requestHash: "A".repeat(64) }],
    ["item", { ...createReceipt(), itemId: "x".repeat(129) }],
    ["date", { ...createReceipt(), appliedAt: "+012026-08-31T10:00:01.000Z" }],
    ["transition", { ...createReceipt(), nextState: "open" }],
  ])("rejects %s receipt input", (_name, input) => {
    expect(parseAnnotationLifecycleOperationLedgerReceipt(input).ok).toBe(false);
  });

  test("rejects accessors without invoking them", () => {
    const getter = vi.fn(() => "epoch-1");
    const receipt = createReceipt() as Record<string, unknown>;
    Object.defineProperty(receipt, "epoch", { enumerable: true, get: getter });
    expect(parseAnnotationLifecycleOperationLedgerReceipt(receipt).ok).toBe(false);
    expect(getter).not.toHaveBeenCalled();

    const receiptsGetter = vi.fn(() => [createReceipt()]);
    const ledger = {
      schemaVersion: ANNOTATION_LIFECYCLE_OPERATION_LEDGER_SCHEMA_VERSION,
      kind: ANNOTATION_LIFECYCLE_OPERATION_LEDGER_KIND,
    } as Record<string, unknown>;
    Object.defineProperty(ledger, "receipts", { enumerable: true, get: receiptsGetter });
    expect(parseAnnotationLifecycleOperationLedger(ledger).ok).toBe(false);
    expect(receiptsGetter).not.toHaveBeenCalled();
  });

  test("is idempotent for the same receipt and rejects operation reuse with changed request hash", () => {
    const first = appendAnnotationLifecycleOperationLedgerReceipt(
      createEmptyAnnotationLifecycleOperationLedger(),
      createReceipt(),
    );
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    const replay = appendAnnotationLifecycleOperationLedgerReceipt(first.value, createReceipt());
    expect(replay).toEqual(first);
    expect(appendAnnotationLifecycleOperationLedgerReceipt(first.value, {
      ...createReceipt(),
      requestHash: "b".repeat(64),
    })).toEqual({ ok: false, code: "OPERATION_ID_CONFLICT", path: "$.operationId" });
  });

  test("never trims or overwrites a full ledger", () => {
    const receipts = Array.from(
      { length: ANNOTATION_LIFECYCLE_OPERATION_LEDGER_MAX_RECEIPTS },
      (_, index) => createReceipt({
        operationId: `11111111-1111-4111-8${index.toString().padStart(3, "0")}-111111111111`,
      }),
    );
    const ledger = {
      ...createEmptyAnnotationLifecycleOperationLedger(),
      receipts,
    };
    expect(parseAnnotationLifecycleOperationLedger(ledger).ok).toBe(true);
    expect(appendAnnotationLifecycleOperationLedgerReceipt(ledger, createReceipt({
      operationId: "22222222-2222-4222-8222-222222222222",
    }))).toEqual({ ok: false, code: "OVERBOUND", path: "$.receipts" });
    expect(parseAnnotationLifecycleOperationLedger({
      ...ledger,
      receipts: [...receipts, createReceipt({
        operationId: "22222222-2222-4222-8222-222222222222",
      })],
    })).toEqual({ ok: false, code: "OVERBOUND", path: "$.receipts" });
  });

  test.each([
    ["resolved", "open", "resolved"],
    ["reopened", "resolved", "open"],
  ] as const)("builds and reparses an exact three-key atomic payload when %s", (
    _name,
    previousState,
    nextState,
  ) => {
    const receipt = createReceipt({ previousState, nextState });
    const ledgerResult = appendAnnotationLifecycleOperationLedgerReceipt(
      createEmptyAnnotationLifecycleOperationLedger(),
      receipt,
    );
    expect(ledgerResult.ok).toBe(true);
    if (!ledgerResult.ok) return;
    const payload = createAnnotationLifecycleOperationAtomicStoragePayload({
      origin: ORIGIN,
      operationId: OPERATION_ID,
      ...transitionBinding(previousState, nextState),
      file: createV3File(nextState),
      meta: createMeta(),
      ledger: ledgerResult.value,
    });
    expect(payload.ok).toBe(true);
    if (!payload.ok) return;
    expect(Object.keys(payload.value)).toEqual([
      `ui-attach:session:v1:${ORIGIN}`,
      `ui-attach:session:v1:meta:${ORIGIN}`,
      `ui-attach:annotation-lifecycle-operation-ledger:v1:${ORIGIN}`,
    ]);
    const readback = parseAnnotationLifecycleOperationAtomicReadback({
      origin: ORIGIN,
      operationId: OPERATION_ID,
      ...transitionBinding(previousState, nextState),
      values: payload.value,
    });
    expect(readback.ok).toBe(true);
    if (readback.ok) {
      expect(readback.value.receipt.nextState).toBe(nextState);
      expect(readback.value.file.session.updatedAt).toBe(APPLIED_AT);
    }
  });

  test("rejects state without a receipt and a receipt without matching terminal state", () => {
    expect(createAnnotationLifecycleOperationAtomicStoragePayload({
      origin: ORIGIN,
      operationId: OPERATION_ID,
      ...transitionBinding(),
      file: createV3File("resolved"),
      meta: createMeta(),
      ledger: createEmptyAnnotationLifecycleOperationLedger(),
    })).toEqual({ ok: false, code: "MISSING_RECEIPT", path: "$.operationId" });

    const ledger = {
      ...createEmptyAnnotationLifecycleOperationLedger(),
      receipts: [createReceipt()],
    };
    expect(createAnnotationLifecycleOperationAtomicStoragePayload({
      origin: ORIGIN,
      operationId: OPERATION_ID,
      ...transitionBinding(),
      file: createV3File("open"),
      meta: createMeta(),
      ledger,
    })).toEqual({ ok: false, code: "STALE_READBACK", path: "$.receipt" });
  });

  test("rejects epoch drift, clear-pending state, and extra storage readback keys", () => {
    const base = createAtomicFixture();
    expect(base.ok).toBe(true);
    if (!base.ok) return;
    const metaKey = `ui-attach:session:v1:meta:${ORIGIN}`;
    expect(parseAnnotationLifecycleOperationAtomicReadback({
      origin: ORIGIN,
      operationId: OPERATION_ID,
      ...transitionBinding(),
      values: {
        ...base.value,
        [metaKey]: { ...base.value[metaKey] as object, epoch: "epoch-2" },
      },
    })).toEqual({ ok: false, code: "STALE_READBACK", path: "$.epoch" });
    expect(parseAnnotationLifecycleOperationAtomicReadback({
      origin: ORIGIN,
      operationId: OPERATION_ID,
      ...transitionBinding(),
      values: {
        ...base.value,
        [metaKey]: {
          ...base.value[metaKey] as object,
          clearPending: true,
          activeClearOperationId: "clear-1",
        },
      },
    })).toEqual({ ok: false, code: "STALE_READBACK", path: "$.epoch" });
    expect(parseAnnotationLifecycleOperationAtomicReadback({
      origin: ORIGIN,
      operationId: OPERATION_ID,
      ...transitionBinding(),
      values: { ...base.value, extra: true },
    })).toEqual({ ok: false, code: "INVALID_VALUE", path: "$.values" });
  });

  test("does not invoke getters while parsing the exact storage triplet", () => {
    const base = createAtomicFixture();
    expect(base.ok).toBe(true);
    if (!base.ok) return;
    const sessionKey = `ui-attach:session:v1:${ORIGIN}`;
    const getter = vi.fn(() => base.value[sessionKey]);
    const values = { ...base.value } as Record<string, unknown>;
    Object.defineProperty(values, sessionKey, { enumerable: true, get: getter });
    expect(parseAnnotationLifecycleOperationAtomicReadback({
      origin: ORIGIN,
      operationId: OPERATION_ID,
      ...transitionBinding(),
      values,
    }).ok).toBe(false);
    expect(getter).not.toHaveBeenCalled();
  });

  test("rejects atomic wrapper accessors and own undefined without invoking them", () => {
    const base = createAtomicFixture();
    expect(base.ok).toBe(true);
    if (!base.ok) return;
    const inputGetter = vi.fn(() => ORIGIN);
    const readbackInput = {
      operationId: OPERATION_ID,
      ...transitionBinding(),
      values: base.value,
    } as Record<string, unknown>;
    Object.defineProperty(readbackInput, "origin", {
      enumerable: true,
      get: inputGetter,
    });
    expect(parseAnnotationLifecycleOperationAtomicReadback(readbackInput as never))
      .toEqual({ ok: false, code: "INVALID_VALUE", path: "$" });
    expect(inputGetter).not.toHaveBeenCalled();

    const payloadGetter = vi.fn(() => createV3File("resolved"));
    const payloadInput = {
      origin: ORIGIN,
      operationId: OPERATION_ID,
      ...transitionBinding(),
      meta: createMeta(),
      ledger: {
        ...createEmptyAnnotationLifecycleOperationLedger(),
        receipts: [createReceipt()],
      },
    } as Record<string, unknown>;
    Object.defineProperty(payloadInput, "file", {
      enumerable: true,
      get: payloadGetter,
    });
    expect(createAnnotationLifecycleOperationAtomicStoragePayload(payloadInput as never))
      .toEqual({ ok: false, code: "INVALID_VALUE", path: "$" });
    expect(payloadGetter).not.toHaveBeenCalled();
    expect(parseAnnotationLifecycleOperationAtomicReadback({
      origin: ORIGIN,
      operationId: OPERATION_ID,
      ...transitionBinding(),
      requestHash: undefined,
      values: base.value,
    })).toEqual({ ok: false, code: "INVALID_VALUE", path: "$" });
  });

  test("binds readback to the exact request hash and expected transition", () => {
    const base = createAtomicFixture();
    expect(base.ok).toBe(true);
    if (!base.ok) return;
    expect(parseAnnotationLifecycleOperationAtomicReadback({
      origin: ORIGIN,
      operationId: OPERATION_ID,
      ...transitionBinding(),
      requestHash: "b".repeat(64),
      values: base.value,
    })).toEqual({ ok: false, code: "OPERATION_ID_CONFLICT", path: "$.requestHash" });
    expect(parseAnnotationLifecycleOperationAtomicReadback({
      origin: ORIGIN,
      operationId: OPERATION_ID,
      ...transitionBinding("resolved", "open"),
      values: base.value,
    })).toEqual({ ok: false, code: "STALE_READBACK", path: "$.transition" });
  });

  test("exposes only the origin-scoped ledger key for clear purge", () => {
    expect(getAnnotationLifecycleOperationLedgerStorageKey(ORIGIN)).toBe(
      `ui-attach:annotation-lifecycle-operation-ledger:v1:${ORIGIN}`,
    );
    expect(getAnnotationLifecycleOperationLedgerPurgeKeys(ORIGIN)).toEqual([
      `ui-attach:annotation-lifecycle-operation-ledger:v1:${ORIGIN}`,
    ]);
    expect(getAnnotationLifecycleOperationLedgerPurgeKeys(`${ORIGIN}/path`)).toBeNull();
  });
});

function createReceipt(
  overrides: Partial<AnnotationLifecycleOperationLedgerReceiptV1> = {},
): AnnotationLifecycleOperationLedgerReceiptV1 {
  return {
    schemaVersion: ANNOTATION_LIFECYCLE_OPERATION_LEDGER_SCHEMA_VERSION,
    kind: ANNOTATION_LIFECYCLE_OPERATION_LEDGER_RECEIPT_KIND,
    operationId: OPERATION_ID,
    requestHash: REQUEST_HASH,
    epoch: "epoch-1",
    itemId: "att_save",
    annotationId: "annotation-1",
    previousState: "open",
    nextState: "resolved",
    appliedAt: APPLIED_AT,
    ...overrides,
  };
}

function createMeta(): Record<string, unknown> {
  return {
    epoch: "epoch-1",
    clearPending: false,
    activeClearOperationId: null,
    lastCompletedClearOperationId: null,
    receipts: [],
  };
}

function createV3File(state: "open" | "resolved"): CaptureSessionFileV3 {
  const base = createSessionFile([createCaptureRecord("save", "Save changes")]);
  return {
    ...base,
    schemaVersion: "0.3.0",
    session: {
      ...base.session,
      updatedAt: APPLIED_AT,
      attachments: base.session.attachments.map((item) => ({
        ...item,
        annotationId: "annotation-1",
        updatedAt: APPLIED_AT,
        annotationLifecycle: state === "resolved"
          ? { state: "resolved", resolvedAt: APPLIED_AT }
          : { state: "open", resolvedAt: null },
      })),
    },
  };
}

function createAtomicFixture() {
  const ledger = {
    ...createEmptyAnnotationLifecycleOperationLedger(),
    receipts: [createReceipt()],
  };
  return createAnnotationLifecycleOperationAtomicStoragePayload({
    origin: ORIGIN,
    operationId: OPERATION_ID,
    ...transitionBinding(),
    file: createV3File("resolved"),
    meta: createMeta(),
    ledger,
  });
}

function transitionBinding(
  expectedPreviousState: "open" | "resolved" = "open",
  expectedNextState: "open" | "resolved" = "resolved",
) {
  return {
    requestHash: REQUEST_HASH,
    expectedPreviousState,
    expectedNextState,
  };
}

function omit<T extends Record<string, unknown>, K extends keyof T>(value: T, key: K): Omit<T, K> {
  const result = { ...value };
  delete result[key];
  return result;
}
