import {
  validateMetadataDiagnosticsV1,
  type MetadataDiagnosticsV1,
} from "@meanthis/schema";
import type { ExtensionStorageArea } from "./capture-store";

/** The version of the extension-private diagnostics binding projection. */
export const METADATA_DIAGNOSTICS_SESSION_SCHEMA_VERSION = "0.1.0" as const;
export const METADATA_DIAGNOSTICS_SESSION_KIND =
  "ui-attach.metadata-diagnostics-session-binding" as const;

/** Prefix for the one origin-scoped entry in chrome.storage.session. */
export const METADATA_DIAGNOSTICS_SESSION_STORAGE_KEY_PREFIX =
  "ui-attach:metadata-diagnostics-session:v1:" as const;

/** A session has at most the same number of items as the capture session. */
export const METADATA_DIAGNOSTICS_SESSION_MAX_FINGERPRINT_ITEMS = 26 as const;

export interface MetadataDiagnosticsSessionFingerprintItemV1 {
  itemId: string;
  capturedAt: string;
}

export interface MetadataDiagnosticsSessionBindingV1 {
  schemaVersion: typeof METADATA_DIAGNOSTICS_SESSION_SCHEMA_VERSION;
  kind: typeof METADATA_DIAGNOSTICS_SESSION_KIND;
  origin: string;
  epoch: string;
  /** Internal item authority. This is never exposed in MetadataDiagnosticsV1. */
  observedItemId: string;
  fingerprint: MetadataDiagnosticsSessionFingerprintItemV1[];
  sidecar: MetadataDiagnosticsV1;
}

export interface MetadataDiagnosticsSessionReadBindingV1 {
  observedItemId: string;
  sidecar: MetadataDiagnosticsV1;
}

export interface MetadataDiagnosticsSessionCurrentIdentityV1 {
  epoch: string;
  captureId: string;
  fingerprint: MetadataDiagnosticsSessionFingerprintItemV1[];
}

/**
 * Reports whether the diagnostics binding schema can express this identity.
 * False alone does not authorize deletion; callers must first verify canonical
 * session state before treating an unsupported identity as having no binding.
 */
export function canBindMetadataDiagnosticsSessionIdentity(origin: string, value: unknown): boolean {
  return parseCurrentIdentity(origin, value) !== null;
}

export interface MetadataDiagnosticsSessionStore {
  /** Return the sidecar only when every supplied identity field matches. */
  read(
    origin: string,
    epoch: string,
    captureId: string,
    fingerprint: readonly MetadataDiagnosticsSessionFingerprintItemV1[],
  ): Promise<MetadataDiagnosticsV1 | null>;
  /** Return the public sidecar together with its extension-private item authority. */
  readBinding(
    origin: string,
    epoch: string,
    captureId: string,
    fingerprint: readonly MetadataDiagnosticsSessionFingerprintItemV1[],
  ): Promise<MetadataDiagnosticsSessionReadBindingV1 | null>;
  /** Persist one validated binding and report exact storage readback success. */
  write(binding: unknown): Promise<boolean>;
  /** Remove one origin entry and report exact storage absence readback success. */
  remove(origin: string): Promise<boolean>;
  /** Remove an entry only when it is not the exact current canonical session binding. */
  removeUnlessCurrent(
    origin: string,
    readCurrent: () => Promise<MetadataDiagnosticsSessionCurrentIdentityV1 | null | undefined>,
  ): Promise<boolean>;
  /** Remove every diagnostics entry while preserving all unrelated session keys. */
  clearAll(): Promise<boolean>;
}

const BINDING_KEYS = [
  "schemaVersion",
  "kind",
  "origin",
  "epoch",
  "observedItemId",
  "fingerprint",
  "sidecar",
] as const;
const FINGERPRINT_ITEM_KEYS = ["itemId", "capturedAt"] as const;
const OPAQUE_ID_PATTERN = /^[A-Za-z0-9._:-]{1,128}$/u;
const MAX_ORIGIN_LENGTH = 2_048;
const MAX_BINDING_BYTES = 32_768;
const encoder = new TextEncoder();

// All instances sharing one ExtensionStorageArea serialize their set/remove
// plus readback sequence. This prevents a late remove or write in another
// store instance from making an otherwise successful readback misleading.
const mutationTails = new WeakMap<object, Promise<void>>();

export function createMetadataDiagnosticsSessionStore(options: {
  storage: ExtensionStorageArea;
}): MetadataDiagnosticsSessionStore {
  const storage = options?.storage as unknown;

  const readBinding = (
    origin: string,
    epoch: string,
    captureId: string,
    fingerprint: readonly MetadataDiagnosticsSessionFingerprintItemV1[],
  ): Promise<MetadataDiagnosticsSessionReadBindingV1 | null> => {
    const request = normalizeReadRequest(origin, epoch, captureId, fingerprint);
    if (!request || !isStorageKey(storage)) return Promise.resolve(null);
    const key = getMetadataDiagnosticsSessionStorageKey(request.origin);
    return enqueue(storage, async () => {
      try {
        const values = await (storage as ExtensionStorageArea).get(key);
        const raw = readStorageValue(values, key);
        if (raw === undefined) return null;
        const stored = parseBinding(raw);
        if (!stored || !sameBindingIdentity(stored, request)) return null;
        return {
          observedItemId: stored.observedItemId,
          sidecar: stored.sidecar,
        };
      } catch {
        return null;
      }
    });
  };

  return {
    read(origin, epoch, captureId, fingerprint) {
      return readBinding(origin, epoch, captureId, fingerprint).then(
        (binding) => binding?.sidecar ?? null,
      );
    },

    readBinding,

    write(value) {
      const binding = parseBinding(value);
      if (!binding || !isStorageKey(storage)) return Promise.resolve(false);
      const key = getMetadataDiagnosticsSessionStorageKey(binding.origin);
      return enqueue(storage, async () => {
        try {
          await (storage as ExtensionStorageArea).set({ [key]: binding });
          const values = await (storage as ExtensionStorageArea).get(key);
          const raw = readStorageValue(values, key);
          const readback = raw === undefined ? null : parseBinding(raw);
          return readback !== null && sameBinding(readback, binding);
        } catch {
          return false;
        }
      });
    },

    remove(origin) {
      if (!isCanonicalHttpOrigin(origin) || !isStorageKey(storage)) {
        return Promise.resolve(false);
      }
      const key = getMetadataDiagnosticsSessionStorageKey(origin);
      return enqueue(storage, async () => {
        try {
          await (storage as ExtensionStorageArea).remove(key);
          const values = await (storage as ExtensionStorageArea).get(key);
          return isStorageKeyAbsent(values, key);
        } catch {
          return false;
        }
      });
    },

    removeUnlessCurrent(origin, readCurrent) {
      if (!isCanonicalHttpOrigin(origin) || !isStorageKey(storage) || typeof readCurrent !== "function") {
        return Promise.resolve(false);
      }
      const key = getMetadataDiagnosticsSessionStorageKey(origin);
      return enqueue(storage, async () => {
        try {
          // Read canonical identity while holding the same metadata mutation
          // queue used by capture writes. A newer capture may commit while this
          // callback runs, but its sidecar write cannot overtake this cleanup.
          const currentValue = await readCurrent();
          if (currentValue === undefined) return false;
          const current = currentValue === null
            ? null
            : parseCurrentIdentity(origin, currentValue);
          if (currentValue !== null && !current) return false;
          const values = await (storage as ExtensionStorageArea).get(key);
          const raw = readStorageValue(values, key);
          if (raw === undefined) return true;
          const stored = parseBinding(raw);
          if (stored && current && sameBindingIdentity(stored, current)) return true;
          await (storage as ExtensionStorageArea).remove(key);
          const readback = await (storage as ExtensionStorageArea).get(key);
          return isStorageKeyAbsent(readback, key);
        } catch {
          return false;
        }
      });
    },

    clearAll() {
      if (!isStorageKey(storage)) return Promise.resolve(false);
      return enqueue(storage, async () => {
        try {
          const values = await (storage as ExtensionStorageArea).get(null);
          const diagnosticsKeys = listDiagnosticsStorageKeys(values);
          if (!diagnosticsKeys) return false;
          if (diagnosticsKeys.length === 0) return true;

          // The candidate list is built exclusively from canonical origin
          // suffixes. Unrelated session keys are never passed to remove().
          await (storage as ExtensionStorageArea).remove(diagnosticsKeys);
          const readback = await (storage as ExtensionStorageArea).get(null);
          const remainingDiagnosticsKeys = listDiagnosticsStorageKeys(readback);
          return remainingDiagnosticsKeys !== null && remainingDiagnosticsKeys.length === 0;
        } catch {
          return false;
        }
      });
    },
  };
}

export function getMetadataDiagnosticsSessionStorageKey(origin: string): string {
  return `${METADATA_DIAGNOSTICS_SESSION_STORAGE_KEY_PREFIX}${origin}`;
}

function parseBinding(value: unknown): MetadataDiagnosticsSessionBindingV1 | null {
  const record = readExactPlainDataRecord(value, BINDING_KEYS);
  if (!record) return null;

  const schemaVersion = record.schemaVersion;
  const kind = record.kind;
  const origin = record.origin;
  const epoch = record.epoch;
  const observedItemId = record.observedItemId;
  const sidecarValue = record.sidecar;
  if (
    schemaVersion !== METADATA_DIAGNOSTICS_SESSION_SCHEMA_VERSION ||
    kind !== METADATA_DIAGNOSTICS_SESSION_KIND ||
    !isCanonicalHttpOrigin(origin) ||
    !isOpaqueIdentifier(epoch) ||
    !isOpaqueIdentifier(observedItemId)
  ) return null;

  const fingerprint = parseFingerprint(record.fingerprint);
  if (!fingerprint) return null;

  // The production schema performs a descriptor-only validation and returns
  // a detached, fixed-order snapshot. No caller object is persisted below.
  const validation = validateMetadataDiagnosticsV1(sidecarValue);
  if (!validation.ok) return null;
  const sidecar = validation.value;
  const observedItem = fingerprint.find((item) => item.itemId === observedItemId);
  if (
    !observedItem ||
    observedItem.capturedAt !== sidecar.observedAt ||
    sidecar.authority !== "capture_time" ||
    (sidecar.device.status !== "collected" && sidecar.device.status !== "not_available") ||
    sidecar.network.status !== "not_requested" ||
    sidecar.console.status !== "not_requested" ||
    sidecar.executionAuthority.grantedByCapture !== false ||
    sidecar.executionAuthority.browserControl !== false ||
    sidecar.executionAuthority.liveDomMutation !== false
  ) return null;

  const canonical: MetadataDiagnosticsSessionBindingV1 = {
    schemaVersion: METADATA_DIAGNOSTICS_SESSION_SCHEMA_VERSION,
    kind: METADATA_DIAGNOSTICS_SESSION_KIND,
    origin,
    epoch,
    observedItemId,
    fingerprint,
    sidecar,
  };
  return hasSafeBindingSize(canonical) ? canonical : null;
}

function parseFingerprint(
  value: unknown,
): MetadataDiagnosticsSessionFingerprintItemV1[] | null {
  const values = readExactDenseDataArray(value);
  if (!values || values.length > METADATA_DIAGNOSTICS_SESSION_MAX_FINGERPRINT_ITEMS) {
    return null;
  }

  const seenItemIds = new Set<string>();
  const fingerprint: MetadataDiagnosticsSessionFingerprintItemV1[] = [];
  for (const item of values) {
    const record = readExactPlainDataRecord(item, FINGERPRINT_ITEM_KEYS);
    if (!record) return null;
    const itemId = record.itemId;
    const capturedAt = record.capturedAt;
    if (
      !isOpaqueIdentifier(itemId) ||
      !isCanonicalIsoDate(capturedAt) ||
      seenItemIds.has(itemId)
    ) return null;
    seenItemIds.add(itemId);
    fingerprint.push({ itemId, capturedAt });
  }
  return fingerprint;
}

interface BindingIdentity {
  origin: string;
  epoch: string;
  captureId: string;
  fingerprint: MetadataDiagnosticsSessionFingerprintItemV1[];
}

function normalizeReadRequest(
  origin: unknown,
  epoch: unknown,
  captureId: unknown,
  fingerprint: unknown,
): BindingIdentity | null {
  if (!isCanonicalHttpOrigin(origin) || !isOpaqueIdentifier(epoch) || !isOpaqueIdentifier(captureId)) {
    return null;
  }
  const normalizedFingerprint = parseFingerprint(fingerprint);
  if (!normalizedFingerprint) return null;
  return { origin, epoch, captureId, fingerprint: normalizedFingerprint };
}

function parseCurrentIdentity(
  origin: string,
  value: unknown,
): BindingIdentity | null {
  const record = readExactPlainDataRecord(value, ["epoch", "captureId", "fingerprint"]);
  return record
    ? normalizeReadRequest(origin, record.epoch, record.captureId, record.fingerprint)
    : null;
}

function sameBindingIdentity(
  left: MetadataDiagnosticsSessionBindingV1,
  right: BindingIdentity,
): boolean {
  return left.origin === right.origin &&
    left.epoch === right.epoch &&
    left.sidecar.captureId === right.captureId &&
    sameFingerprint(left.fingerprint, right.fingerprint);
}

function sameBinding(
  left: MetadataDiagnosticsSessionBindingV1,
  right: MetadataDiagnosticsSessionBindingV1,
): boolean {
  return left.origin === right.origin &&
    left.epoch === right.epoch &&
    left.observedItemId === right.observedItemId &&
    left.sidecar.captureId === right.sidecar.captureId &&
    sameFingerprint(left.fingerprint, right.fingerprint) &&
    left.schemaVersion === right.schemaVersion &&
    left.kind === right.kind &&
    canonicalSidecarBytes(left.sidecar) === canonicalSidecarBytes(right.sidecar);
}

function sameFingerprint(
  left: readonly MetadataDiagnosticsSessionFingerprintItemV1[],
  right: readonly MetadataDiagnosticsSessionFingerprintItemV1[],
): boolean {
  return left.length === right.length && left.every((item, index) => {
    const other = right[index];
    return other !== undefined &&
      item.itemId === other.itemId &&
      item.capturedAt === other.capturedAt;
  });
}

function canonicalSidecarBytes(value: MetadataDiagnosticsV1): string {
  // `value` is always the detached result of validateMetadataDiagnosticsV1.
  // JSON.stringify therefore cannot invoke a caller-owned accessor here.
  return JSON.stringify(value);
}

function hasSafeBindingSize(value: MetadataDiagnosticsSessionBindingV1): boolean {
  try {
    return encoder.encode(JSON.stringify(value)).byteLength <= MAX_BINDING_BYTES;
  } catch {
    return false;
  }
}

function readStorageValue(values: unknown, key: string): unknown {
  if (!isPlainRecord(values)) return undefined;
  try {
    const descriptor = Object.getOwnPropertyDescriptor(values, key);
    if (!descriptor || !descriptor.enumerable || !Object.hasOwn(descriptor, "value")) {
      return undefined;
    }
    return descriptor.value;
  } catch {
    return undefined;
  }
}

function isStorageKeyAbsent(values: unknown, key: string): boolean {
  if (!isPlainRecord(values)) return false;
  try {
    const descriptor = Object.getOwnPropertyDescriptor(values, key);
    if (!descriptor) return true;
    // Some test doubles materialize a requested-but-missing key as
    // `{ [key]: undefined }`; Chrome's actual result omits it.
    return descriptor.enumerable === true &&
      Object.hasOwn(descriptor, "value") &&
      descriptor.value === undefined;
  } catch {
    return false;
  }
}

/**
 * Inspect a complete storage result without invoking any accessor. A normal
 * unrelated data key is intentionally ignored and preserved. Any malformed
 * own descriptor, symbol, or malformed diagnostics namespace key aborts the
 * clear before deletion so a hostile get(null) result cannot broaden it.
 */
function listDiagnosticsStorageKeys(values: unknown): string[] | null {
  if (!isPlainRecord(values)) return null;
  try {
    const descriptors = Object.getOwnPropertyDescriptors(values) as unknown as Record<PropertyKey, PropertyDescriptor>;
    const ownKeys = Reflect.ownKeys(descriptors);
    if (ownKeys.some((key) => typeof key !== "string")) return null;

    const diagnosticsKeys: string[] = [];
    for (const key of ownKeys as string[]) {
      const descriptor = descriptors[key];
      if (
        !descriptor ||
        !descriptor.enumerable ||
        !Object.hasOwn(descriptor, "value") ||
        descriptor.value === undefined
      ) return null;
      if (!key.startsWith(METADATA_DIAGNOSTICS_SESSION_STORAGE_KEY_PREFIX)) continue;
      const suffix = key.slice(METADATA_DIAGNOSTICS_SESSION_STORAGE_KEY_PREFIX.length);
      if (!isCanonicalHttpOrigin(suffix)) return null;
      diagnosticsKeys.push(key);
    }
    return diagnosticsKeys;
  } catch {
    return null;
  }
}

function readExactPlainDataRecord(
  value: unknown,
  expectedKeys: readonly string[],
): Record<string, unknown> | null {
  if (!isPlainRecord(value)) return null;
  try {
    const descriptors = Object.getOwnPropertyDescriptors(value) as unknown as Record<PropertyKey, PropertyDescriptor>;
    const ownKeys = Reflect.ownKeys(descriptors);
    if (ownKeys.some((key) => typeof key !== "string")) return null;
    const expected = new Set(expectedKeys);
    const names = ownKeys as string[];
    if (names.length !== expectedKeys.length || names.some((key) => !expected.has(key))) {
      return null;
    }

    const snapshot: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
    for (const key of names) {
      const descriptor = descriptors[key];
      if (
        !descriptor ||
        !descriptor.enumerable ||
        !Object.hasOwn(descriptor, "value") ||
        descriptor.value === undefined
      ) return null;
      snapshot[key] = descriptor.value;
    }
    return snapshot;
  } catch {
    return null;
  }
}

function readExactDenseDataArray(value: unknown): unknown[] | null {
  if (!Array.isArray(value)) return null;
  try {
    if (Object.getPrototypeOf(value) !== Array.prototype) return null;
    const descriptors = Object.getOwnPropertyDescriptors(value) as unknown as Record<PropertyKey, PropertyDescriptor>;
    const ownKeys = Reflect.ownKeys(descriptors);
    if (ownKeys.some((key) => typeof key !== "string")) return null;
    const lengthDescriptor = descriptors.length;
    if (
      !lengthDescriptor ||
      lengthDescriptor.enumerable ||
      !Object.hasOwn(lengthDescriptor, "value") ||
      !Number.isSafeInteger(lengthDescriptor.value) ||
      (lengthDescriptor.value as number) < 0 ||
      (lengthDescriptor.value as number) > METADATA_DIAGNOSTICS_SESSION_MAX_FINGERPRINT_ITEMS
    ) return null;
    const length = lengthDescriptor.value as number;
    const expected = new Set(["length", ...Array.from({ length }, (_, index) => String(index))]);
    const names = ownKeys as string[];
    if (names.length !== expected.size || names.some((key) => !expected.has(key))) return null;

    const result: unknown[] = [];
    for (let index = 0; index < length; index += 1) {
      const descriptor = descriptors[String(index)];
      if (!descriptor || !descriptor.enumerable || !Object.hasOwn(descriptor, "value") ||
          descriptor.value === undefined) return null;
      result.push(descriptor.value);
    }
    return result;
  } catch {
    return null;
  }
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  try {
    const prototype = Object.getPrototypeOf(value);
    return prototype === Object.prototype || prototype === null;
  } catch {
    return false;
  }
}

function isObjectLike(value: unknown): value is object {
  return (typeof value === "object" && value !== null) || typeof value === "function";
}

function isStorageKey(value: unknown): value is object {
  return isObjectLike(value);
}

function isOpaqueIdentifier(value: unknown): value is string {
  return typeof value === "string" && OPAQUE_ID_PATTERN.test(value);
}

function isCanonicalHttpOrigin(value: unknown): value is string {
  if (typeof value !== "string" || value.length > MAX_ORIGIN_LENGTH) return false;
  try {
    const parsed = new URL(value);
    return (parsed.protocol === "http:" || parsed.protocol === "https:") &&
      parsed.origin === value;
  } catch {
    return false;
  }
}

function isCanonicalIsoDate(value: unknown): value is string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(value)) {
    return false;
  }
  try {
    return new Date(value).toISOString() === value;
  } catch {
    return false;
  }
}

function enqueue<T>(storage: object, operation: () => Promise<T>): Promise<T> {
  const previous = mutationTails.get(storage) ?? Promise.resolve();
  const result = previous.catch(() => undefined).then(operation);
  mutationTails.set(storage, result.then(() => undefined, () => undefined));
  return result;
}
