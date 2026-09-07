import type { CaptureSessionFileV3 } from "@meanthis/hub-core";
import { serializeCaptureSessionFile } from "./session-file";
import type { CaptureSessionMetaV1, CaptureReceipt } from "./session-state";

/**
 * Dormant durable contract for a future, user-approved annotation lifecycle
 * control plane. Nothing imports this module from an extension production
 * entry yet, and these helpers never perform storage or browser operations.
 */
export const ANNOTATION_LIFECYCLE_OPERATION_LEDGER_SCHEMA_VERSION = "0.1.0" as const;
export const ANNOTATION_LIFECYCLE_OPERATION_LEDGER_KIND =
  "ui-attach.annotation-lifecycle-operation-ledger" as const;
export const ANNOTATION_LIFECYCLE_OPERATION_LEDGER_RECEIPT_KIND =
  "ui-attach.annotation-lifecycle-operation-ledger-receipt" as const;
export const ANNOTATION_LIFECYCLE_OPERATION_LEDGER_MAX_RECEIPTS = 64 as const;

const SESSION_KEY_PREFIX = "ui-attach:session:v1:";
const SESSION_META_KEY_PREFIX = `${SESSION_KEY_PREFIX}meta:`;
export const ANNOTATION_LIFECYCLE_OPERATION_LEDGER_STORAGE_PREFIX =
  "ui-attach:annotation-lifecycle-operation-ledger:v1:" as const;
const MAX_IDENTIFIER_LENGTH = 128;
const MAX_META_RECEIPTS = 64;
const IDENTIFIER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const UUID_V4_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const HASH_PATTERN = /^[0-9a-f]{64}$/;
const OVERBOUND_ARRAY = Symbol("overbound-array");

export type AnnotationLifecycleLedgerState = "open" | "resolved";

export interface AnnotationLifecycleOperationLedgerReceiptV1 {
  schemaVersion: typeof ANNOTATION_LIFECYCLE_OPERATION_LEDGER_SCHEMA_VERSION;
  kind: typeof ANNOTATION_LIFECYCLE_OPERATION_LEDGER_RECEIPT_KIND;
  operationId: string;
  requestHash: string;
  epoch: string;
  itemId: string;
  annotationId: string;
  previousState: AnnotationLifecycleLedgerState;
  nextState: AnnotationLifecycleLedgerState;
  appliedAt: string;
}

export interface AnnotationLifecycleOperationLedgerV1 {
  schemaVersion: typeof ANNOTATION_LIFECYCLE_OPERATION_LEDGER_SCHEMA_VERSION;
  kind: typeof ANNOTATION_LIFECYCLE_OPERATION_LEDGER_KIND;
  receipts: AnnotationLifecycleOperationLedgerReceiptV1[];
}

export type AnnotationLifecycleOperationLedgerErrorCode =
  | "INVALID_VALUE"
  | "OVERBOUND"
  | "OPERATION_ID_CONFLICT"
  | "MISSING_RECEIPT"
  | "STALE_READBACK";

export type AnnotationLifecycleOperationLedgerResult<T> =
  | { ok: true; value: T }
  | { ok: false; code: AnnotationLifecycleOperationLedgerErrorCode; path: string };

export interface AnnotationLifecycleOperationAtomicPayloadInput {
  origin: string;
  operationId: string;
  requestHash: string;
  expectedPreviousState: AnnotationLifecycleLedgerState;
  expectedNextState: AnnotationLifecycleLedgerState;
  file: unknown;
  meta: unknown;
  ledger: unknown;
}

export interface AnnotationLifecycleOperationReadbackInput {
  origin: string;
  operationId: string;
  requestHash: string;
  expectedPreviousState: AnnotationLifecycleLedgerState;
  expectedNextState: AnnotationLifecycleLedgerState;
  values: unknown;
}

export interface AnnotationLifecycleOperationDurableReadback {
  origin: string;
  epoch: string;
  file: CaptureSessionFileV3;
  meta: CaptureSessionMetaV1;
  ledger: AnnotationLifecycleOperationLedgerV1;
  receipt: AnnotationLifecycleOperationLedgerReceiptV1;
}

const RECEIPT_KEYS = [
  "schemaVersion",
  "kind",
  "operationId",
  "requestHash",
  "epoch",
  "itemId",
  "annotationId",
  "previousState",
  "nextState",
  "appliedAt",
] as const;
const LEDGER_KEYS = ["schemaVersion", "kind", "receipts"] as const;
const META_KEYS = [
  "epoch",
  "clearPending",
  "activeClearOperationId",
  "lastCompletedClearOperationId",
  "receipts",
] as const;

export function createEmptyAnnotationLifecycleOperationLedger(): AnnotationLifecycleOperationLedgerV1 {
  return {
    schemaVersion: ANNOTATION_LIFECYCLE_OPERATION_LEDGER_SCHEMA_VERSION,
    kind: ANNOTATION_LIFECYCLE_OPERATION_LEDGER_KIND,
    receipts: [],
  };
}

export function parseAnnotationLifecycleOperationLedgerReceipt(
  value: unknown,
): AnnotationLifecycleOperationLedgerResult<AnnotationLifecycleOperationLedgerReceiptV1> {
  const record = readExactDataRecord(value, RECEIPT_KEYS);
  if (!record) return invalid("$");
  if (
    record.schemaVersion !== ANNOTATION_LIFECYCLE_OPERATION_LEDGER_SCHEMA_VERSION ||
    record.kind !== ANNOTATION_LIFECYCLE_OPERATION_LEDGER_RECEIPT_KIND ||
    !isUuidV4(record.operationId) ||
    !isHash(record.requestHash) ||
    !isIdentifier(record.epoch) ||
    !isIdentifier(record.itemId) ||
    !isIdentifier(record.annotationId) ||
    !isLifecycleState(record.previousState) ||
    !isLifecycleState(record.nextState) ||
    record.previousState === record.nextState ||
    !isCanonicalDate(record.appliedAt)
  ) {
    return invalid("$");
  }
  return {
    ok: true,
    value: {
      schemaVersion: ANNOTATION_LIFECYCLE_OPERATION_LEDGER_SCHEMA_VERSION,
      kind: ANNOTATION_LIFECYCLE_OPERATION_LEDGER_RECEIPT_KIND,
      operationId: record.operationId,
      requestHash: record.requestHash,
      epoch: record.epoch,
      itemId: record.itemId,
      annotationId: record.annotationId,
      previousState: record.previousState,
      nextState: record.nextState,
      appliedAt: record.appliedAt,
    },
  } as AnnotationLifecycleOperationLedgerResult<AnnotationLifecycleOperationLedgerReceiptV1>;
}

export function parseAnnotationLifecycleOperationLedger(
  value: unknown,
): AnnotationLifecycleOperationLedgerResult<AnnotationLifecycleOperationLedgerV1> {
  const record = readExactDataRecord(value, LEDGER_KEYS);
  if (!record) return invalid("$");
  if (
    record.schemaVersion !== ANNOTATION_LIFECYCLE_OPERATION_LEDGER_SCHEMA_VERSION ||
    record.kind !== ANNOTATION_LIFECYCLE_OPERATION_LEDGER_KIND
  ) return invalid("$");
  const receiptValues = readDenseDataArray(
    record.receipts,
    ANNOTATION_LIFECYCLE_OPERATION_LEDGER_MAX_RECEIPTS,
  );
  if (receiptValues === OVERBOUND_ARRAY) return overbound("$.receipts");
  if (!receiptValues) return invalid("$.receipts");
  const receipts: AnnotationLifecycleOperationLedgerReceiptV1[] = [];
  const operations = new Map<string, string>();
  for (const [index, receiptValue] of receiptValues.entries()) {
    const parsed = parseAnnotationLifecycleOperationLedgerReceipt(receiptValue);
    if (!parsed.ok) return { ...parsed, path: `$.receipts[${index}]` };
    const previousHash = operations.get(parsed.value.operationId);
    if (previousHash !== undefined) {
      return previousHash === parsed.value.requestHash
        ? invalid(`$.receipts[${index}].operationId`)
        : conflict(`$.receipts[${index}].operationId`);
    }
    operations.set(parsed.value.operationId, parsed.value.requestHash);
    receipts.push(parsed.value);
  }
  return {
    ok: true,
    value: {
      schemaVersion: ANNOTATION_LIFECYCLE_OPERATION_LEDGER_SCHEMA_VERSION,
      kind: ANNOTATION_LIFECYCLE_OPERATION_LEDGER_KIND,
      receipts,
    },
  };
}

export function appendAnnotationLifecycleOperationLedgerReceipt(
  ledgerValue: unknown,
  receiptValue: unknown,
): AnnotationLifecycleOperationLedgerResult<AnnotationLifecycleOperationLedgerV1> {
  const ledger = parseAnnotationLifecycleOperationLedger(ledgerValue);
  if (!ledger.ok) return ledger;
  const receipt = parseAnnotationLifecycleOperationLedgerReceipt(receiptValue);
  if (!receipt.ok) return receipt;
  const existing = ledger.value.receipts.find(
    (candidate) => candidate.operationId === receipt.value.operationId,
  );
  if (existing) {
    return sameReceipt(existing, receipt.value)
      ? ledger
      : conflict("$.operationId");
  }
  if (ledger.value.receipts.length >= ANNOTATION_LIFECYCLE_OPERATION_LEDGER_MAX_RECEIPTS) {
    return overbound("$.receipts");
  }
  return {
    ok: true,
    value: {
      ...ledger.value,
      receipts: [...ledger.value.receipts, receipt.value],
    },
  };
}

export function getAnnotationLifecycleOperationLedgerStorageKey(origin: string): string | null {
  return isCanonicalOrigin(origin)
    ? `${ANNOTATION_LIFECYCLE_OPERATION_LEDGER_STORAGE_PREFIX}${origin}`
    : null;
}

export function getAnnotationLifecycleOperationLedgerPurgeKeys(origin: string): string[] | null {
  const ledgerKey = getAnnotationLifecycleOperationLedgerStorageKey(origin);
  return ledgerKey ? [ledgerKey] : null;
}

/**
 * Builds the single object a future storage.set call would receive. The helper
 * performs no write and accepts only an exact terminal state/receipt readback.
 */
export function createAnnotationLifecycleOperationAtomicStoragePayload(
  input: AnnotationLifecycleOperationAtomicPayloadInput,
): AnnotationLifecycleOperationLedgerResult<Record<string, unknown>> {
  const parsedInput = readExactDataRecord(
    input,
    [
      "origin",
      "operationId",
      "requestHash",
      "expectedPreviousState",
      "expectedNextState",
      "file",
      "meta",
      "ledger",
    ],
  );
  if (
    !parsedInput ||
    typeof parsedInput.origin !== "string" ||
    !isUuidV4(parsedInput.operationId) ||
    !isHash(parsedInput.requestHash) ||
    !isLifecycleState(parsedInput.expectedPreviousState) ||
    !isLifecycleState(parsedInput.expectedNextState) ||
    parsedInput.expectedPreviousState === parsedInput.expectedNextState
  ) return invalid("$");
  const keys = getStorageKeys(parsedInput.origin);
  if (!keys) return invalid("$.origin");
  const file = parseV3File(parsedInput.file, parsedInput.origin);
  if (!file.ok) return file;
  const meta = parseMeta(parsedInput.meta);
  if (!meta.ok) return meta;
  const ledger = parseAnnotationLifecycleOperationLedger(parsedInput.ledger);
  if (!ledger.ok) return ledger;
  const payload: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
  payload[keys.sessionKey] = file.value;
  payload[keys.metaKey] = meta.value;
  payload[keys.ledgerKey] = ledger.value;
  const readback = parseAnnotationLifecycleOperationAtomicReadback({
    origin: parsedInput.origin,
    operationId: parsedInput.operationId,
    requestHash: parsedInput.requestHash,
    expectedPreviousState: parsedInput.expectedPreviousState,
    expectedNextState: parsedInput.expectedNextState,
    values: payload,
  });
  return readback.ok ? { ok: true, value: payload } : readback;
}

/** Parse an exact three-key storage.get result and cross-check terminal truth. */
export function parseAnnotationLifecycleOperationAtomicReadback(
  input: AnnotationLifecycleOperationReadbackInput,
): AnnotationLifecycleOperationLedgerResult<AnnotationLifecycleOperationDurableReadback> {
  const parsedInput = readExactDataRecord(
    input,
    [
      "origin",
      "operationId",
      "requestHash",
      "expectedPreviousState",
      "expectedNextState",
      "values",
    ],
  );
  if (
    !parsedInput ||
    typeof parsedInput.origin !== "string" ||
    !isUuidV4(parsedInput.operationId) ||
    !isHash(parsedInput.requestHash) ||
    !isLifecycleState(parsedInput.expectedPreviousState) ||
    !isLifecycleState(parsedInput.expectedNextState) ||
    parsedInput.expectedPreviousState === parsedInput.expectedNextState
  ) return invalid("$");
  const keys = getStorageKeys(parsedInput.origin);
  if (!keys) return invalid("$.origin");
  const values = readExactDataRecord(
    parsedInput.values,
    [keys.sessionKey, keys.metaKey, keys.ledgerKey],
  );
  if (!values) return invalid("$.values");
  const file = parseV3File(values[keys.sessionKey], parsedInput.origin);
  if (!file.ok) return file;
  const meta = parseMeta(values[keys.metaKey]);
  if (!meta.ok) return meta;
  const ledger = parseAnnotationLifecycleOperationLedger(values[keys.ledgerKey]);
  if (!ledger.ok) return ledger;
  const receipt = ledger.value.receipts.find(
    (candidate) => candidate.operationId === parsedInput.operationId,
  );
  if (!receipt) return { ok: false, code: "MISSING_RECEIPT", path: "$.operationId" };
  if (receipt.requestHash !== parsedInput.requestHash) {
    return conflict("$.requestHash");
  }
  if (
    receipt.previousState !== parsedInput.expectedPreviousState ||
    receipt.nextState !== parsedInput.expectedNextState
  ) return stale("$.transition");
  if (meta.value.clearPending || receipt.epoch !== meta.value.epoch) {
    return stale("$.epoch");
  }
  const item = file.value.session.attachments.find((candidate) => candidate.id === receipt.itemId);
  if (
    !item ||
    item.annotationId !== receipt.annotationId ||
    item.annotationLifecycle.state !== receipt.nextState ||
    item.updatedAt !== receipt.appliedAt ||
    file.value.session.updatedAt !== receipt.appliedAt ||
    (receipt.nextState === "resolved"
      ? item.annotationLifecycle.resolvedAt !== receipt.appliedAt
      : item.annotationLifecycle.resolvedAt !== null)
  ) {
    return stale("$.receipt");
  }
  return {
    ok: true,
    value: {
      origin: parsedInput.origin,
      epoch: meta.value.epoch,
      file: file.value,
      meta: meta.value,
      ledger: ledger.value,
      receipt,
    },
  };
}

function parseV3File(
  value: unknown,
  origin: string,
): AnnotationLifecycleOperationLedgerResult<CaptureSessionFileV3> {
  const serialized = serializeCaptureSessionFile(value);
  if (
    !serialized.ok ||
    serialized.value.file.schemaVersion !== "0.3.0" ||
    serialized.value.file.session.origin !== origin
  ) return invalid("$.file");
  return { ok: true, value: serialized.value.file };
}

function parseMeta(
  value: unknown,
): AnnotationLifecycleOperationLedgerResult<CaptureSessionMetaV1> {
  const record = readExactDataRecord(value, META_KEYS);
  if (
    !record ||
    !isIdentifier(record.epoch) ||
    typeof record.clearPending !== "boolean" ||
    !isNullableIdentifier(record.activeClearOperationId) ||
    !isNullableIdentifier(record.lastCompletedClearOperationId) ||
    record.clearPending !== (record.activeClearOperationId !== null)
  ) return invalid("$.meta");
  const receiptValues = readDenseDataArray(record.receipts, MAX_META_RECEIPTS);
  if (receiptValues === OVERBOUND_ARRAY) return overbound("$.meta.receipts");
  if (!receiptValues) return invalid("$.meta.receipts");
  const receipts: CaptureReceipt[] = [];
  for (const value of receiptValues) {
    const parsed = parseMetaReceipt(value);
    if (!parsed) return invalid("$.meta.receipts");
    receipts.push(parsed);
  }
  return {
    ok: true,
    value: {
      epoch: record.epoch,
      clearPending: record.clearPending,
      activeClearOperationId: record.activeClearOperationId,
      lastCompletedClearOperationId: record.lastCompletedClearOperationId,
      receipts,
    } as CaptureSessionMetaV1,
  };
}

function parseMetaReceipt(value: unknown): CaptureReceipt | null {
  const base = readDataRecordWithOptional(value, ["operationId", "itemId"], ["annotationId"]);
  if (!base || !isIdentifier(base.operationId) || !isIdentifier(base.itemId)) return null;
  if (
    Object.hasOwn(base, "annotationId") &&
    base.annotationId !== null &&
    !isIdentifier(base.annotationId)
  ) return null;
  return {
    operationId: base.operationId,
    itemId: base.itemId,
    ...(Object.hasOwn(base, "annotationId")
      ? { annotationId: base.annotationId as string | null }
      : {}),
  };
}

function getStorageKeys(origin: string): {
  sessionKey: string;
  metaKey: string;
  ledgerKey: string;
} | null {
  const ledgerKey = getAnnotationLifecycleOperationLedgerStorageKey(origin);
  return ledgerKey
    ? {
        sessionKey: `${SESSION_KEY_PREFIX}${origin}`,
        metaKey: `${SESSION_META_KEY_PREFIX}${origin}`,
        ledgerKey,
      }
    : null;
}

function sameReceipt(
  left: AnnotationLifecycleOperationLedgerReceiptV1,
  right: AnnotationLifecycleOperationLedgerReceiptV1,
): boolean {
  return RECEIPT_KEYS.every((key) => left[key] === right[key]);
}

function readExactDataRecord<const K extends readonly string[]>(
  value: unknown,
  keys: K,
): ({ [P in K[number]]: unknown }) | null {
  const record = readDataRecordWithOptional(value, keys, []);
  return record as ({ [P in K[number]]: unknown }) | null;
}

function readDataRecordWithOptional(
  value: unknown,
  required: readonly string[],
  optional: readonly string[],
): Record<string, unknown> | null {
  try {
    if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) return null;
    const descriptors = Object.getOwnPropertyDescriptors(value);
    const allowed = new Set([...required, ...optional]);
    const ownKeys = Reflect.ownKeys(descriptors);
    if (
      ownKeys.some((key) => typeof key !== "string" || !allowed.has(key)) ||
      required.some((key) => !Object.hasOwn(descriptors, key))
    ) return null;
    const result: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
    for (const key of ownKeys) {
      if (typeof key !== "string") return null;
      const descriptor = descriptors[key];
      if (!descriptor?.enumerable || !Object.hasOwn(descriptor, "value") || descriptor.value === undefined) {
        return null;
      }
      result[key] = descriptor.value;
    }
    return result;
  } catch {
    return null;
  }
}

function readDenseDataArray(
  value: unknown,
  max: number,
): unknown[] | null | typeof OVERBOUND_ARRAY {
  try {
    if (!Array.isArray(value)) return null;
    const descriptors = Object.getOwnPropertyDescriptors(value);
    const lengthDescriptor = Object.getOwnPropertyDescriptor(value, "length");
    if (!lengthDescriptor || !Object.hasOwn(lengthDescriptor, "value")) return null;
    const length = lengthDescriptor.value;
    if (!Number.isSafeInteger(length) || length < 0) return null;
    if (length > max) return OVERBOUND_ARRAY;
    const expected = new Set(["length", ...Array.from({ length }, (_, index) => String(index))]);
    const keys = Reflect.ownKeys(descriptors);
    if (keys.some((key) => typeof key !== "string" || !expected.has(key)) || keys.length !== expected.size) {
      return null;
    }
    const result: unknown[] = [];
    for (let index = 0; index < length; index += 1) {
      const descriptor = descriptors[String(index)];
      if (!descriptor?.enumerable || !Object.hasOwn(descriptor, "value") || descriptor.value === undefined) {
        return null;
      }
      result.push(descriptor.value);
    }
    return result;
  } catch {
    return null;
  }
}

function isCanonicalOrigin(value: string): boolean {
  if (typeof value !== "string" || value.length > 2_048) return false;
  try {
    const url = new URL(value);
    return (
      (url.protocol === "https:" || url.protocol === "http:") &&
      url.username === "" &&
      url.password === "" &&
      url.origin === value
    );
  } catch {
    return false;
  }
}

function isCanonicalDate(value: unknown): value is string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)) {
    return false;
  }
  try {
    return new Date(value).toISOString() === value;
  } catch {
    return false;
  }
}

function isLifecycleState(value: unknown): value is AnnotationLifecycleLedgerState {
  return value === "open" || value === "resolved";
}

function isIdentifier(value: unknown): value is string {
  return typeof value === "string" &&
    value.length <= MAX_IDENTIFIER_LENGTH &&
    IDENTIFIER_PATTERN.test(value);
}

function isNullableIdentifier(value: unknown): value is string | null {
  return value === null || isIdentifier(value);
}

function isUuidV4(value: unknown): value is string {
  return typeof value === "string" && value.length <= MAX_IDENTIFIER_LENGTH && UUID_V4_PATTERN.test(value);
}

function isHash(value: unknown): value is string {
  return typeof value === "string" && HASH_PATTERN.test(value);
}

function invalid(path: string): AnnotationLifecycleOperationLedgerResult<never> {
  return { ok: false, code: "INVALID_VALUE", path };
}

function overbound(path: string): AnnotationLifecycleOperationLedgerResult<never> {
  return { ok: false, code: "OVERBOUND", path };
}

function conflict(path: string): AnnotationLifecycleOperationLedgerResult<never> {
  return { ok: false, code: "OPERATION_ID_CONFLICT", path };
}

function stale(path: string): AnnotationLifecycleOperationLedgerResult<never> {
  return { ok: false, code: "STALE_READBACK", path };
}
