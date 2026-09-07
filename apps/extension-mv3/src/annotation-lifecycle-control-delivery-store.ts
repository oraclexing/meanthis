import type { ExtensionStorageArea } from "./capture-store";
import {
  parseAnnotationLifecycleOperationReference,
  type AnnotationLifecycleOperationReferenceV1,
} from "./annotation-lifecycle-control-client";

export const ANNOTATION_LIFECYCLE_CONTROL_DELIVERY_STORAGE_PREFIX =
  "ui-attach:annotation-lifecycle-control-delivery:v1:" as const;
export const ANNOTATION_LIFECYCLE_CONTROL_DELIVERY_SCHEMA_VERSION = "0.1.0" as const;
export const ANNOTATION_LIFECYCLE_CONTROL_DELIVERY_KIND =
  "ui-attach.annotation-lifecycle-delivered-operation" as const;
export const ANNOTATION_LIFECYCLE_CONTROL_DELIVERY_MAX_RECORDS = 64 as const;

const UUID_V4_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const CANONICAL_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u;
const MAX_ORIGIN_LENGTH = 2_048;
const MAX_PATHNAME_LENGTH = 2_048;
const MAX_DOCUMENT_ID_LENGTH = 256;
const MAX_RECORD_BYTES = 8_192;
const MAX_DELIVERY_TTL_MS = 600_000;
const encoder = new TextEncoder();

export interface DeliveredAnnotationLifecycleOperationV1 {
  schemaVersion: typeof ANNOTATION_LIFECYCLE_CONTROL_DELIVERY_SCHEMA_VERSION;
  kind: typeof ANNOTATION_LIFECYCLE_CONTROL_DELIVERY_KIND;
  reference: AnnotationLifecycleOperationReferenceV1;
  origin: string;
  surfaceId: string;
  tabId: number;
  frameId: number;
  documentId: string;
  pathname: string;
  deliveredAt: string;
  expiresAt: string;
}

export interface AnnotationLifecycleControlDeliveryStore {
  listAll(): Promise<DeliveredAnnotationLifecycleOperationV1[]>;
  read(
    surfaceId: string,
    operationId: string,
  ): Promise<DeliveredAnnotationLifecycleOperationV1 | null>;
  save(value: unknown): Promise<DeliveredAnnotationLifecycleOperationV1>;
  remove(surfaceId: string, operationId: string): Promise<void>;
}

const RECORD_KEYS = [
  "schemaVersion",
  "kind",
  "reference",
  "origin",
  "surfaceId",
  "tabId",
  "frameId",
  "documentId",
  "pathname",
  "deliveredAt",
  "expiresAt",
] as const;

// chrome.storage.session is shared by all helper instances in one worker.
// Serialize the write/readback and remove/readback pairs across those instances.
const storageMutationTails = new WeakMap<ExtensionStorageArea, Promise<void>>();

export function createAnnotationLifecycleControlDeliveryStore(options: {
  storage: ExtensionStorageArea;
}): AnnotationLifecycleControlDeliveryStore {
  return { listAll, read, save, remove };

  function listAll(): Promise<DeliveredAnnotationLifecycleOperationV1[]> {
    return runExclusive(async () => {
      const values = await options.storage.get(null);
      const records = readDeliveryListing(values);
      if (!records) {
        throw new Error("Invalid annotation lifecycle delivery storage listing.");
      }
      return records;
    });
  }

  async function read(
    surfaceId: string,
    operationId: string,
  ): Promise<DeliveredAnnotationLifecycleOperationV1 | null> {
    const key = getAnnotationLifecycleControlDeliveryStorageKey(surfaceId, operationId);
    if (!key) throw new Error("Invalid annotation lifecycle delivery key.");
    const values = await options.storage.get(key);
    const entry = readExactOptionalEntry(values, key);
    if (!entry.ok) throw new Error("Invalid annotation lifecycle delivery readback.");
    if (!entry.present) return null;
    const record = parseDeliveredAnnotationLifecycleOperation(entry.value);
    if (
      !record || record.surfaceId !== surfaceId ||
      record.reference.operationId !== operationId
    ) {
      throw new Error("Invalid annotation lifecycle delivery record.");
    }
    return record;
  }

  function save(value: unknown): Promise<DeliveredAnnotationLifecycleOperationV1> {
    const record = parseDeliveredAnnotationLifecycleOperation(value);
    if (!record) {
      return Promise.reject(new Error("Invalid annotation lifecycle delivery record."));
    }
    return runExclusive(async () => {
      const values = await options.storage.get(null);
      const records = readDeliveryListing(values);
      if (!records) {
        throw new Error("Invalid annotation lifecycle delivery storage listing.");
      }
      const current = records.find((candidate) =>
        candidate.surfaceId === record.surfaceId &&
        candidate.reference.operationId === record.reference.operationId
      );
      if (current) {
        if (!sameRecord(current, record)) {
          throw new Error("Annotation lifecycle delivery record conflict.");
        }
        return current;
      }
      if (records.length >= ANNOTATION_LIFECYCLE_CONTROL_DELIVERY_MAX_RECORDS) {
        throw new Error("Annotation lifecycle delivery storage capacity exceeded.");
      }

      const key = getAnnotationLifecycleControlDeliveryStorageKey(
        record.surfaceId,
        record.reference.operationId,
      );
      if (!key) throw new Error("Invalid annotation lifecycle delivery key.");
      await options.storage.set({ [key]: record });
      const readback = await read(record.surfaceId, record.reference.operationId);
      if (!readback || !sameRecord(readback, record)) {
        throw new Error("Annotation lifecycle delivery write readback failed.");
      }
      return readback;
    });
  }

  function remove(surfaceId: string, operationId: string): Promise<void> {
    const key = getAnnotationLifecycleControlDeliveryStorageKey(surfaceId, operationId);
    if (!key) {
      return Promise.reject(new Error("Invalid annotation lifecycle delivery key."));
    }
    return runExclusive(async () => {
      await options.storage.remove(key);
      const values = await options.storage.get(key);
      const entry = readExactOptionalEntry(values, key);
      if (!entry.ok || entry.present) {
        throw new Error("Annotation lifecycle delivery removal readback failed.");
      }
    });
  }

  function runExclusive<T>(operation: () => Promise<T>): Promise<T> {
    const previous = storageMutationTails.get(options.storage) ?? Promise.resolve();
    const result = previous.then(operation, operation);
    storageMutationTails.set(options.storage, result.then(() => undefined, () => undefined));
    return result;
  }
}

export function getAnnotationLifecycleControlDeliveryStorageKey(
  surfaceId: string,
  operationId: string,
): string | null {
  return isUuidV4(surfaceId) && isUuidV4(operationId)
    ? `${ANNOTATION_LIFECYCLE_CONTROL_DELIVERY_STORAGE_PREFIX}${surfaceId}:${operationId}`
    : null;
}

export function parseDeliveredAnnotationLifecycleOperation(
  value: unknown,
): DeliveredAnnotationLifecycleOperationV1 | null {
  const record = readExactDataRecord(value, RECORD_KEYS);
  if (!record) return null;
  const reference = parseAnnotationLifecycleOperationReference(record.reference);
  if (
    record.schemaVersion !== ANNOTATION_LIFECYCLE_CONTROL_DELIVERY_SCHEMA_VERSION ||
    record.kind !== ANNOTATION_LIFECYCLE_CONTROL_DELIVERY_KIND ||
    !reference || !isCanonicalOrigin(record.origin) || !isUuidV4(record.surfaceId) ||
    !isChromeId(record.tabId) || !isChromeId(record.frameId) ||
    !isBoundedText(record.documentId, MAX_DOCUMENT_ID_LENGTH) ||
    !isCanonicalPathname(record.pathname, record.origin) ||
    !isCanonicalDate(record.deliveredAt) || !isCanonicalDate(record.expiresAt) ||
    Date.parse(record.expiresAt) <= Date.parse(record.deliveredAt) ||
    Date.parse(record.expiresAt) - Date.parse(record.deliveredAt) > MAX_DELIVERY_TTL_MS
  ) return null;

  const result: DeliveredAnnotationLifecycleOperationV1 = {
    schemaVersion: ANNOTATION_LIFECYCLE_CONTROL_DELIVERY_SCHEMA_VERSION,
    kind: ANNOTATION_LIFECYCLE_CONTROL_DELIVERY_KIND,
    reference,
    origin: record.origin,
    surfaceId: record.surfaceId,
    tabId: record.tabId,
    frameId: record.frameId,
    documentId: record.documentId,
    pathname: record.pathname,
    deliveredAt: record.deliveredAt,
    expiresAt: record.expiresAt,
  };
  return hasSafeRecordSize(result) ? result : null;
}

function readDeliveryListing(
  value: unknown,
): DeliveredAnnotationLifecycleOperationV1[] | null {
  const keys = readOwnEnumerableDataKeys(value);
  if (!keys) return null;
  const data = readExactDataRecord(value, keys);
  if (!data) return null;
  const selectedKeys = keys.filter((key) =>
    key.startsWith(ANNOTATION_LIFECYCLE_CONTROL_DELIVERY_STORAGE_PREFIX)
  );
  if (selectedKeys.length > ANNOTATION_LIFECYCLE_CONTROL_DELIVERY_MAX_RECORDS) return null;

  const records: DeliveredAnnotationLifecycleOperationV1[] = [];
  for (const key of selectedKeys) {
    const parsedKey = parseStorageKey(key);
    const record = parseDeliveredAnnotationLifecycleOperation(data[key]);
    if (
      !parsedKey || !record || parsedKey.surfaceId !== record.surfaceId ||
      parsedKey.operationId !== record.reference.operationId
    ) return null;
    records.push(record);
  }
  records.sort((left, right) =>
    left.deliveredAt.localeCompare(right.deliveredAt) ||
    left.surfaceId.localeCompare(right.surfaceId) ||
    left.reference.operationId.localeCompare(right.reference.operationId)
  );
  return records;
}

function parseStorageKey(
  key: string,
): { surfaceId: string; operationId: string } | null {
  if (!key.startsWith(ANNOTATION_LIFECYCLE_CONTROL_DELIVERY_STORAGE_PREFIX)) return null;
  const suffix = key.slice(ANNOTATION_LIFECYCLE_CONTROL_DELIVERY_STORAGE_PREFIX.length);
  const parts = suffix.split(":");
  return parts.length === 2 && isUuidV4(parts[0]) && isUuidV4(parts[1])
    ? { surfaceId: parts[0], operationId: parts[1] }
    : null;
}

function isCanonicalOrigin(value: unknown): value is string {
  if (typeof value !== "string" || value.length === 0 || value.length > MAX_ORIGIN_LENGTH) {
    return false;
  }
  try {
    const url = new URL(value);
    return (url.protocol === "http:" || url.protocol === "https:") &&
      url.origin === value && url.pathname === "/" && url.search === "" &&
      url.hash === "" && url.username === "" && url.password === "";
  } catch {
    return false;
  }
}

function isCanonicalPathname(value: unknown, origin: unknown): value is string {
  if (
    typeof value !== "string" || value.length === 0 || value.length > MAX_PATHNAME_LENGTH ||
    !value.startsWith("/") || /[?#\u0000-\u001f\u007f]/u.test(value) ||
    typeof origin !== "string"
  ) return false;
  try {
    const url = new URL(value, origin);
    return url.origin === origin && url.pathname === value && url.search === "" && url.hash === "";
  } catch {
    return false;
  }
}

function isCanonicalDate(value: unknown): value is string {
  if (typeof value !== "string" || !CANONICAL_DATE_PATTERN.test(value)) return false;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) && new Date(timestamp).toISOString() === value;
}

function isUuidV4(value: unknown): value is string {
  return typeof value === "string" && UUID_V4_PATTERN.test(value);
}

function isChromeId(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function isBoundedText(value: unknown, maxLength: number): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= maxLength &&
    value.trim().length > 0 && !/[\u0000-\u001f\u007f]/u.test(value);
}

function hasSafeRecordSize(value: DeliveredAnnotationLifecycleOperationV1): boolean {
  try {
    return encoder.encode(JSON.stringify(value)).byteLength <= MAX_RECORD_BYTES;
  } catch {
    return false;
  }
}

function sameRecord(
  left: DeliveredAnnotationLifecycleOperationV1,
  right: DeliveredAnnotationLifecycleOperationV1,
): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function readExactOptionalEntry(
  value: unknown,
  key: string,
): { ok: true; present: false } | { ok: true; present: true; value: unknown } | { ok: false } {
  const empty = readExactDataRecord(value, []);
  if (empty) return { ok: true, present: false };
  const single = readExactDataRecord(value, [key]);
  return single ? { ok: true, present: true, value: single[key] } : { ok: false };
}

function readOwnEnumerableDataKeys(value: unknown): string[] | null {
  try {
    if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) return null;
    const descriptors = Object.getOwnPropertyDescriptors(value);
    const keys = Reflect.ownKeys(descriptors);
    if (keys.some((key) => {
      if (typeof key !== "string") return true;
      const descriptor = descriptors[key];
      return !descriptor?.enumerable || !Object.hasOwn(descriptor, "value") ||
        descriptor.value === undefined;
    })) return null;
    return keys as string[];
  } catch {
    return null;
  }
}

function readExactDataRecord(
  value: unknown,
  expected: readonly string[],
): Record<string, unknown> | null {
  try {
    if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) return null;
    const descriptors = Object.getOwnPropertyDescriptors(value);
    const keys = Reflect.ownKeys(descriptors);
    if (
      keys.length !== expected.length ||
      keys.some((key) => typeof key !== "string" || !expected.includes(key))
    ) return null;
    const result: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
    for (const key of expected) {
      const descriptor = descriptors[key];
      if (
        !descriptor?.enumerable || !Object.hasOwn(descriptor, "value") ||
        descriptor.value === undefined
      ) return null;
      result[key] = descriptor.value;
    }
    return result;
  } catch {
    return null;
  }
}
