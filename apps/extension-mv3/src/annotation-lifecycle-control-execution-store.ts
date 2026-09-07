import {
  parseAnnotationLifecycleOperationProposal,
  type AnnotationLifecycleOperationTerminalStatus,
  type AnnotationLifecycleOperationProposalV1,
} from "@meanthis/schema";
import type { ExtensionStorageArea } from "./capture-store";
import {
  parseAnnotationLifecycleOperationLedgerReceipt,
  type AnnotationLifecycleOperationLedgerReceiptV1,
} from "./annotation-lifecycle-operation-ledger";
import {
  parseAnnotationLifecycleOperationApproval,
  parseAnnotationLifecycleOperationReference,
  type AnnotationLifecycleOperationApprovalV1,
  type AnnotationLifecycleOperationReferenceV1,
} from "./annotation-lifecycle-control-client";

export const ANNOTATION_LIFECYCLE_CONTROL_EXECUTION_STORAGE_PREFIX =
  "ui-attach:annotation-lifecycle-control-execution:v1:" as const;
export const ANNOTATION_LIFECYCLE_CONTROL_EXECUTION_SCHEMA_VERSION = "0.1.0" as const;
export const ANNOTATION_LIFECYCLE_CONTROL_EXECUTION_KIND =
  "ui-attach.annotation-lifecycle-approved-operation" as const;

const UUID_V4_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const HASH_PATTERN = /^[0-9a-f]{64}$/u;
const IDENTIFIER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const MAX_DOCUMENT_ID_LENGTH = 256;
const MAX_PATHNAME_LENGTH = 2_048;
const MAX_EXECUTION_RECORDS = 64;
const MAX_APPROVAL_TTL_MS = 600_000;

export interface ApprovedAnnotationLifecycleOperationV1 {
  schemaVersion: typeof ANNOTATION_LIFECYCLE_CONTROL_EXECUTION_SCHEMA_VERSION;
  kind: typeof ANNOTATION_LIFECYCLE_CONTROL_EXECUTION_KIND;
  phase: "approved" | "terminal" | "committed";
  proposal: AnnotationLifecycleOperationProposalV1;
  reference: AnnotationLifecycleOperationReferenceV1;
  approval: AnnotationLifecycleOperationApprovalV1;
  origin: string;
  epoch: string;
  itemId: string;
  surfaceId: string;
  tabId: number;
  frameId: number;
  documentId: string;
  pathname: string;
  routeLeaseHash: string;
  terminalStatus: Exclude<AnnotationLifecycleOperationTerminalStatus, "succeeded"> | null;
  terminalObservedAt: string | null;
  committedReceipt: AnnotationLifecycleOperationLedgerReceiptV1 | null;
}

export interface AnnotationLifecycleControlExecutionStore {
  listAll(): Promise<ApprovedAnnotationLifecycleOperationV1[]>;
  read(origin: string, operationId: string): Promise<ApprovedAnnotationLifecycleOperationV1 | null>;
  saveApproved(
    record: ApprovedAnnotationLifecycleOperationV1,
  ): Promise<ApprovedAnnotationLifecycleOperationV1>;
  markCommitted(
    origin: string,
    operationId: string,
    fingerprint: string,
    receipt: AnnotationLifecycleOperationLedgerReceiptV1,
  ): Promise<ApprovedAnnotationLifecycleOperationV1>;
  markTerminal(
    origin: string,
    operationId: string,
    fingerprint: string,
    status: Exclude<AnnotationLifecycleOperationTerminalStatus, "succeeded">,
    observedAt: string,
  ): Promise<ApprovedAnnotationLifecycleOperationV1>;
  remove(origin: string, operationId: string): Promise<void>;
  purgeOrigin(origin: string): Promise<void>;
  purgeTab(tabId: number): Promise<void>;
  purgeAll(): Promise<void>;
}

const RECORD_KEYS = [
  "schemaVersion",
  "kind",
  "phase",
  "proposal",
  "reference",
  "approval",
  "origin",
  "epoch",
  "itemId",
  "surfaceId",
  "tabId",
  "frameId",
  "documentId",
  "pathname",
  "routeLeaseHash",
  "terminalStatus",
  "terminalObservedAt",
  "committedReceipt",
] as const;

const storageMutationTails = new WeakMap<ExtensionStorageArea, Promise<void>>();

export function createAnnotationLifecycleControlExecutionStore(options: {
  storage: ExtensionStorageArea;
}): AnnotationLifecycleControlExecutionStore {
  return {
    listAll,
    read,
    saveApproved,
    markCommitted,
    markTerminal,
    remove,
    purgeOrigin,
    purgeTab,
    purgeAll,
  };

  function listAll(): Promise<ApprovedAnnotationLifecycleOperationV1[]> {
    return runExclusive(async () => {
      const values = await options.storage.get(null);
      const records = readExecutionListing(values);
      if (!records) throw new Error("Invalid annotation lifecycle execution storage listing.");
      return records;
    });
  }

  async function read(
    origin: string,
    operationId: string,
  ): Promise<ApprovedAnnotationLifecycleOperationV1 | null> {
    const key = executionStorageKey(origin, operationId);
    if (!key) throw new Error("Invalid annotation lifecycle execution key.");
    const values = await options.storage.get(key);
    const entry = readExactOptionalEntry(values, key);
    if (!entry.ok) throw new Error("Invalid annotation lifecycle execution readback.");
    if (!entry.present) return null;
    const parsed = parseApprovedAnnotationLifecycleOperation(entry.value);
    if (!parsed || parsed.origin !== origin || parsed.proposal.operationId !== operationId) {
      throw new Error("Invalid annotation lifecycle execution record.");
    }
    return parsed;
  }

  function saveApproved(
    recordValue: ApprovedAnnotationLifecycleOperationV1,
  ): Promise<ApprovedAnnotationLifecycleOperationV1> {
    const record = parseApprovedAnnotationLifecycleOperation(recordValue);
    if (!record || record.phase !== "approved") {
      return Promise.reject(new Error("Invalid approved annotation lifecycle operation."));
    }
    return runExclusive(async () => {
      const current = await read(record.origin, record.proposal.operationId);
      if (current) {
        if (!sameRecord(current, record)) {
          throw new Error("Annotation lifecycle execution record conflict.");
        }
        return current;
      }
      const values = await options.storage.get(null);
      const records = readExecutionListing(values);
      if (!records) {
        throw new Error("Invalid annotation lifecycle execution storage listing.");
      }
      if (records.length >= MAX_EXECUTION_RECORDS) {
        throw new Error("Annotation lifecycle execution storage capacity exceeded.");
      }
      return await writeExact(record);
    });
  }

  function markCommitted(
    origin: string,
    operationId: string,
    fingerprint: string,
    receiptValue: AnnotationLifecycleOperationLedgerReceiptV1,
  ): Promise<ApprovedAnnotationLifecycleOperationV1> {
    if (!executionStorageKey(origin, operationId) || !HASH_PATTERN.test(fingerprint)) {
      return Promise.reject(new Error("Invalid annotation lifecycle execution binding."));
    }
    const receipt = parseAnnotationLifecycleOperationLedgerReceipt(receiptValue);
    if (!receipt.ok) {
      return Promise.reject(new Error("Invalid annotation lifecycle execution receipt."));
    }
    return runExclusive(async () => {
      const current = await read(origin, operationId);
      if (!current || current.reference.fingerprint !== fingerprint) {
        throw new Error("Annotation lifecycle execution binding is stale.");
      }
      if (current.phase === "terminal") {
        throw new Error("Terminal annotation lifecycle execution cannot be committed.");
      }
      if (!receiptMatches(current, receipt.value)) {
        throw new Error("Annotation lifecycle execution receipt does not match approval.");
      }
      const committed: ApprovedAnnotationLifecycleOperationV1 = {
        ...current,
        phase: "committed",
        terminalStatus: null,
        terminalObservedAt: null,
        committedReceipt: receipt.value,
      };
      if (current.phase === "committed") {
        if (!sameRecord(current, committed)) {
          throw new Error("Annotation lifecycle execution receipt conflict.");
        }
        return current;
      }
      return await writeExact(committed);
    });
  }

  function markTerminal(
    origin: string,
    operationId: string,
    fingerprint: string,
    status: Exclude<AnnotationLifecycleOperationTerminalStatus, "succeeded">,
    observedAt: string,
  ): Promise<ApprovedAnnotationLifecycleOperationV1> {
    if (
      !executionStorageKey(origin, operationId) || !HASH_PATTERN.test(fingerprint) ||
      !isFailureTerminalStatus(status) || !isCanonicalDate(observedAt)
    ) {
      return Promise.reject(new Error("Invalid annotation lifecycle execution binding."));
    }
    return runExclusive(async () => {
      const current = await read(origin, operationId);
      if (!current || current.reference.fingerprint !== fingerprint) {
        throw new Error("Annotation lifecycle execution binding is stale.");
      }
      if (current.phase === "committed") {
        throw new Error("Committed annotation lifecycle execution cannot become terminal failure.");
      }
      const terminal: ApprovedAnnotationLifecycleOperationV1 = {
        ...current,
        phase: "terminal",
        terminalStatus: status,
        terminalObservedAt: observedAt,
        committedReceipt: null,
      };
      if (current.phase === "terminal") {
        if (!sameRecord(current, terminal)) {
          throw new Error("Annotation lifecycle execution terminal intent conflict.");
        }
        return current;
      }
      return await writeExact(terminal);
    });
  }

  function remove(origin: string, operationId: string): Promise<void> {
    const key = executionStorageKey(origin, operationId);
    if (!key) return Promise.reject(new Error("Invalid annotation lifecycle execution key."));
    return runExclusive(async () => {
      await options.storage.remove(key);
      const values = await options.storage.get(key);
      const entry = readExactOptionalEntry(values, key);
      if (!entry.ok || entry.present) {
        throw new Error("Annotation lifecycle execution removal readback failed.");
      }
    });
  }

  function purgeOrigin(origin: string): Promise<void> {
    const prefix = executionOriginPrefix(origin);
    if (!prefix) return Promise.reject(new Error("Invalid annotation lifecycle execution origin."));
    return runExclusive(() => purgeMatchingKeys((key) => key.startsWith(prefix)));
  }

  function purgeAll(): Promise<void> {
    return runExclusive(() => purgeMatchingKeys((key) =>
      key.startsWith(ANNOTATION_LIFECYCLE_CONTROL_EXECUTION_STORAGE_PREFIX)
    ));
  }

  function purgeTab(tabId: number): Promise<void> {
    if (!isChromeId(tabId)) {
      return Promise.reject(new Error("Invalid annotation lifecycle execution tab."));
    }
    return runExclusive(async () => {
      const values = await options.storage.get(null);
      const records = readExecutionListing(values);
      if (!records) throw new Error("Invalid annotation lifecycle execution storage listing.");
      const selected = records.filter((record) => record.tabId === tabId).map((record) =>
        executionStorageKey(record.origin, record.proposal.operationId)!
      );
      if (selected.length === 0) return;
      await options.storage.remove(selected);
      const readback = await options.storage.get(null);
      const remaining = readExecutionListing(readback);
      if (!remaining || remaining.some((record) => record.tabId === tabId)) {
        throw new Error("Annotation lifecycle execution purge readback failed.");
      }
    });
  }

  async function purgeMatchingKeys(matches: (key: string) => boolean): Promise<void> {
    const values = await options.storage.get(null);
    const keys = readOwnEnumerableDataKeys(values);
    if (!keys) throw new Error("Invalid annotation lifecycle execution storage listing.");
    const selected = keys.filter(matches);
    if (selected.length === 0) return;
    await options.storage.remove(selected);
    const readback = await options.storage.get(null);
    const remaining = readOwnEnumerableDataKeys(readback);
    if (!remaining || remaining.some(matches)) {
      throw new Error("Annotation lifecycle execution purge readback failed.");
    }
  }

  async function writeExact(
    record: ApprovedAnnotationLifecycleOperationV1,
  ): Promise<ApprovedAnnotationLifecycleOperationV1> {
    const key = executionStorageKey(record.origin, record.proposal.operationId);
    if (!key) throw new Error("Invalid annotation lifecycle execution key.");
    await options.storage.set({ [key]: record });
    const readback = await read(record.origin, record.proposal.operationId);
    if (!readback || !sameRecord(readback, record)) {
      throw new Error("Annotation lifecycle execution write readback failed.");
    }
    return readback;
  }

  function runExclusive<T>(operation: () => Promise<T>): Promise<T> {
    const previous = storageMutationTails.get(options.storage) ?? Promise.resolve();
    const result = previous.then(operation, operation);
    storageMutationTails.set(options.storage, result.then(() => undefined, () => undefined));
    return result;
  }
}

function readExecutionListing(value: unknown): ApprovedAnnotationLifecycleOperationV1[] | null {
  const keys = readOwnEnumerableDataKeys(value);
  if (!keys) return null;
  const record = readExactDataRecord(value, keys);
  if (!record) return null;
  const selectedKeys = keys.filter((key) =>
    key.startsWith(ANNOTATION_LIFECYCLE_CONTROL_EXECUTION_STORAGE_PREFIX)
  );
  if (selectedKeys.length > MAX_EXECUTION_RECORDS) return null;
  const operations: ApprovedAnnotationLifecycleOperationV1[] = [];
  const operationIds = new Set<string>();
  for (const key of selectedKeys) {
    const parsed = parseApprovedAnnotationLifecycleOperation(record[key]);
    if (!parsed || executionStorageKey(parsed.origin, parsed.proposal.operationId) !== key ||
        operationIds.has(parsed.proposal.operationId)) return null;
    operationIds.add(parsed.proposal.operationId);
    operations.push(parsed);
  }
  operations.sort((left, right) =>
    left.approval.approvedAt.localeCompare(right.approval.approvedAt) ||
    left.proposal.operationId.localeCompare(right.proposal.operationId)
  );
  return operations;
}

export function parseApprovedAnnotationLifecycleOperation(
  value: unknown,
): ApprovedAnnotationLifecycleOperationV1 | null {
  const record = readExactDataRecord(value, RECORD_KEYS);
  if (!record) return null;
  const proposal = parseAnnotationLifecycleOperationProposal(record.proposal);
  const reference = parseAnnotationLifecycleOperationReference(record.reference);
  const approval = parseAnnotationLifecycleOperationApproval(record.approval);
  const approvalTtlMs = approval
    ? Date.parse(approval.expiresAt) - Date.parse(approval.approvedAt)
    : Number.NaN;
  const committedReceipt = record.committedReceipt === null
    ? { ok: true as const, value: null }
    : parseAnnotationLifecycleOperationLedgerReceipt(record.committedReceipt);
  if (
    record.schemaVersion !== ANNOTATION_LIFECYCLE_CONTROL_EXECUTION_SCHEMA_VERSION ||
    record.kind !== ANNOTATION_LIFECYCLE_CONTROL_EXECUTION_KIND ||
    (record.phase !== "approved" && record.phase !== "terminal" &&
      record.phase !== "committed") ||
    !proposal.ok || !reference || !approval || !committedReceipt.ok ||
    !Number.isFinite(approvalTtlMs) || approvalTtlMs <= 0 ||
    approvalTtlMs > MAX_APPROVAL_TTL_MS ||
    !isCanonicalOrigin(record.origin) || !isIdentifier(record.epoch) ||
    !isIdentifier(record.itemId) || !isUuidV4(record.surfaceId) ||
    !isChromeId(record.tabId) || !isChromeId(record.frameId) ||
    !isBoundedText(record.documentId, MAX_DOCUMENT_ID_LENGTH) ||
    !isCanonicalPathname(record.pathname, record.origin) ||
    typeof record.routeLeaseHash !== "string" || !HASH_PATTERN.test(record.routeLeaseHash) ||
    !(record.terminalStatus === null || isFailureTerminalStatus(record.terminalStatus)) ||
    !(record.terminalObservedAt === null || isCanonicalDate(record.terminalObservedAt)) ||
    proposal.value.operationId !== reference.operationId ||
    reference.fingerprint !== (committedReceipt.value?.requestHash ?? reference.fingerprint) ||
    (record.phase === "approved" && (
      record.terminalStatus !== null || record.terminalObservedAt !== null ||
      committedReceipt.value !== null
    )) ||
    (record.phase === "terminal" && (
      record.terminalStatus === null || record.terminalObservedAt === null ||
      committedReceipt.value !== null
    )) ||
    (record.phase === "committed" && (
      record.terminalStatus !== null || record.terminalObservedAt !== null ||
      committedReceipt.value === null
    ))
  ) return null;
  const result: ApprovedAnnotationLifecycleOperationV1 = {
    schemaVersion: ANNOTATION_LIFECYCLE_CONTROL_EXECUTION_SCHEMA_VERSION,
    kind: ANNOTATION_LIFECYCLE_CONTROL_EXECUTION_KIND,
    phase: record.phase,
    proposal: proposal.value,
    reference,
    approval,
    origin: record.origin,
    epoch: record.epoch,
    itemId: record.itemId,
    surfaceId: record.surfaceId,
    tabId: record.tabId,
    frameId: record.frameId,
    documentId: record.documentId,
    pathname: record.pathname,
    routeLeaseHash: record.routeLeaseHash,
    terminalStatus: record.terminalStatus,
    terminalObservedAt: record.terminalObservedAt,
    committedReceipt: committedReceipt.value,
  };
  return committedReceipt.value === null || receiptMatches(result, committedReceipt.value)
    ? result
    : null;
}

function receiptMatches(
  record: ApprovedAnnotationLifecycleOperationV1,
  receipt: AnnotationLifecycleOperationLedgerReceiptV1,
): boolean {
  return receipt.operationId === record.proposal.operationId &&
    receipt.requestHash === record.reference.fingerprint &&
    receipt.epoch === record.epoch && receipt.itemId === record.itemId &&
    receipt.annotationId === record.proposal.annotationId &&
    receipt.previousState === record.proposal.expectedState &&
    receipt.nextState === record.proposal.nextState;
}

function executionOriginPrefix(origin: string): string | null {
  return isCanonicalOrigin(origin)
    ? `${ANNOTATION_LIFECYCLE_CONTROL_EXECUTION_STORAGE_PREFIX}${encodeURIComponent(origin)}:`
    : null;
}

function executionStorageKey(origin: string, operationId: string): string | null {
  const prefix = executionOriginPrefix(origin);
  return prefix && isUuidV4(operationId) ? `${prefix}${operationId}` : null;
}

function isCanonicalOrigin(value: unknown): value is string {
  if (typeof value !== "string" || value.length === 0 || value.length > 2_048) return false;
  try {
    const url = new URL(value);
    return (url.protocol === "http:" || url.protocol === "https:") && url.origin === value;
  } catch {
    return false;
  }
}

function isCanonicalPathname(value: unknown, origin: unknown): value is string {
  if (typeof value !== "string" || value.length === 0 || value.length > MAX_PATHNAME_LENGTH ||
      typeof origin !== "string") return false;
  try {
    return new URL(value, origin).pathname === value;
  } catch {
    return false;
  }
}

function isIdentifier(value: unknown): value is string {
  return typeof value === "string" && IDENTIFIER_PATTERN.test(value);
}

function isUuidV4(value: unknown): value is string {
  return typeof value === "string" && UUID_V4_PATTERN.test(value);
}

function isChromeId(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function isBoundedText(value: unknown, maxLength: number): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= maxLength &&
    !/[\u0000-\u001f\u007f]/u.test(value);
}

function isFailureTerminalStatus(
  value: unknown,
): value is Exclude<AnnotationLifecycleOperationTerminalStatus, "succeeded"> {
  return value === "failed" || value === "blocked" || value === "expired" ||
    value === "cancelled" || value === "rejected" || value === "stale" ||
    value === "conflict";
}

function isCanonicalDate(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) && new Date(timestamp).toISOString() === value;
}

function sameRecord(
  left: ApprovedAnnotationLifecycleOperationV1,
  right: ApprovedAnnotationLifecycleOperationV1,
): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function readExactOptionalEntry(
  value: unknown,
  key: string,
): { ok: true; present: false } | { ok: true; present: true; value: unknown } | { ok: false } {
  const record = readExactDataRecord(value, []);
  if (record) return { ok: true, present: false };
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
    if (keys.some((key) => typeof key !== "string")) return null;
    for (const descriptor of Object.values(descriptors)) {
      if (!descriptor.enumerable || !Object.hasOwn(descriptor, "value") || descriptor.value === undefined) {
        return null;
      }
    }
    return keys as string[];
  } catch {
    return null;
  }
}

function readExactDataRecord(
  value: unknown,
  keys: readonly string[],
): Record<string, unknown> | null {
  try {
    if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) return null;
    const descriptors = Object.getOwnPropertyDescriptors(value);
    const ownKeys = Reflect.ownKeys(descriptors);
    if (ownKeys.length !== keys.length || ownKeys.some((key) =>
      typeof key !== "string" || !keys.includes(key)
    )) return null;
    const result: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
    for (const key of keys) {
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
