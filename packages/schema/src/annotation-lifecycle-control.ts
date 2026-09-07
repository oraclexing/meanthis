/**
 * Shared, disabled-by-default contract for a future Agent -> local extension
 * annotation lifecycle control plane.
 *
 * This module intentionally does not expose a transport, an MCP tool, a
 * browser entry point, or an approval mechanism.  It only defines the small
 * value objects that a future control plane may exchange after it has added
 * its own authentication, user approval, durable operation ledger, and
 * terminal readback.  In particular, a valid value here is not browser or
 * DOM authority.
 */

export const ANNOTATION_LIFECYCLE_CONTROL_SCHEMA_VERSION = "0.1.0" as const;
export const ANNOTATION_LIFECYCLE_OPERATION_PROPOSAL_KIND =
  "ui-attach.annotation-lifecycle-operation" as const;
export const ANNOTATION_LIFECYCLE_OPERATION_STATUS_KIND =
  "ui-attach.annotation-lifecycle-operation-status" as const;
export const ANNOTATION_LIFECYCLE_OPERATION_RECEIPT_KIND =
  "ui-attach.annotation-lifecycle-operation-receipt" as const;

export const ANNOTATION_LIFECYCLE_CONTROL_FINGERPRINT_DOMAIN =
  "ui-attach.annotation-lifecycle-operation-fingerprint/v1" as const;

export const ANNOTATION_LIFECYCLE_CONTROL_MAX_ID_LENGTH = 128 as const;
export const ANNOTATION_LIFECYCLE_CONTROL_MAX_CANONICAL_BYTES = 16_384 as const;

export type AnnotationLifecycleState = "open" | "resolved";

/** The only operation a future control plane may propose. */
export interface AnnotationLifecycleOperationProposalV1 {
  schemaVersion: typeof ANNOTATION_LIFECYCLE_CONTROL_SCHEMA_VERSION;
  kind: typeof ANNOTATION_LIFECYCLE_OPERATION_PROPOSAL_KIND;
  operationId: string;
  instanceId: string;
  captureId: string;
  expectedSequence: number;
  annotationId: string;
  expectedState: AnnotationLifecycleState;
  nextState: AnnotationLifecycleState;
}

export type AnnotationLifecycleOperationProgressStatus =
  | "pending"
  | "approved"
  | "applying";

export type AnnotationLifecycleOperationTerminalStatus =
  | "succeeded"
  | "failed"
  | "blocked"
  | "expired"
  | "cancelled"
  | "rejected"
  | "stale"
  | "conflict";

export type AnnotationLifecycleOperationReadbackAuthority =
  | "current_snapshot"
  | "durable_ledger";

export type AnnotationLifecycleOperationStatusValue =
  | AnnotationLifecycleOperationProgressStatus
  | AnnotationLifecycleOperationTerminalStatus;

/**
 * A status observation is bound to the proposal fingerprint.  `receiptId`
 * appears only after a terminal outcome; `resultingState` appears only for a
 * successful local readback.  Neither field grants browser or DOM authority.
 */
export interface AnnotationLifecycleOperationStatusV1 {
  schemaVersion: typeof ANNOTATION_LIFECYCLE_CONTROL_SCHEMA_VERSION;
  kind: typeof ANNOTATION_LIFECYCLE_OPERATION_STATUS_KIND;
  operationId: string;
  fingerprint: string;
  status: AnnotationLifecycleOperationStatusValue;
  observedAt: string;
  receiptId: string | null;
  resultingState: AnnotationLifecycleState | null;
  executionAuthority: AnnotationLifecycleControlExecutionAuthorityV1;
}

/**
 * Terminal receipt for an operation.  This proves only the contract-level
 * outcome and, for `succeeded`, that the extension reported a durable local
 * readback.  The extension/browser must still be the authority for any real
 * mutation and user approval.
 */
export interface AnnotationLifecycleOperationReceiptV1 {
  schemaVersion: typeof ANNOTATION_LIFECYCLE_CONTROL_SCHEMA_VERSION;
  kind: typeof ANNOTATION_LIFECYCLE_OPERATION_RECEIPT_KIND;
  operationId: string;
  fingerprint: string;
  receiptId: string;
  status: AnnotationLifecycleOperationTerminalStatus;
  observedAt: string;
  resultingState: AnnotationLifecycleState | null;
  readbackAuthority: AnnotationLifecycleOperationReadbackAuthority;
  executionAuthority: AnnotationLifecycleControlExecutionAuthorityV1;
}

/** Always false in this schema; this file cannot grant any execution power. */
export interface AnnotationLifecycleControlExecutionAuthorityV1 {
  grantedByCapture: false;
  browserControl: false;
  liveDomMutation: false;
}

export type AnnotationLifecycleControlIssueCode =
  | "invalid_type"
  | "missing_field"
  | "unknown_field"
  | "invalid_value"
  | "overbound"
  | "invalid_date"
  | "invalid_fingerprint"
  | "invalid_status_relation";

export interface AnnotationLifecycleControlIssue {
  code: AnnotationLifecycleControlIssueCode;
  path: string;
}

export interface AnnotationLifecycleControlValidationSuccess<T> {
  ok: true;
  value: T;
}

export interface AnnotationLifecycleControlValidationFailure {
  ok: false;
  issues: AnnotationLifecycleControlIssue[];
}

export type AnnotationLifecycleOperationProposalParseResult =
  | AnnotationLifecycleControlValidationSuccess<AnnotationLifecycleOperationProposalV1>
  | AnnotationLifecycleControlValidationFailure;

export type AnnotationLifecycleOperationStatusParseResult =
  | AnnotationLifecycleControlValidationSuccess<AnnotationLifecycleOperationStatusV1>
  | AnnotationLifecycleControlValidationFailure;

export type AnnotationLifecycleOperationReceiptParseResult =
  | AnnotationLifecycleControlValidationSuccess<AnnotationLifecycleOperationReceiptV1>
  | AnnotationLifecycleControlValidationFailure;

const encoder = new TextEncoder();
const MAX_ISSUES = 32;
const UUID_V4_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const INSTANCE_ID_PATTERN = /^instance-[0-9a-f]{12}$/;
const CAPTURE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const ANNOTATION_ID_PATTERN = /^[A-Za-z0-9._:-]{1,128}$/;
const RECEIPT_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const FINGERPRINT_PATTERN = /^[0-9a-f]{64}$/;
const CANONICAL_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

const PROPOSAL_KEYS = [
  "schemaVersion",
  "kind",
  "operationId",
  "instanceId",
  "captureId",
  "expectedSequence",
  "annotationId",
  "expectedState",
  "nextState",
] as const;

const STATUS_KEYS = [
  "schemaVersion",
  "kind",
  "operationId",
  "fingerprint",
  "status",
  "observedAt",
  "receiptId",
  "resultingState",
  "executionAuthority",
] as const;

const RECEIPT_KEYS = [
  "schemaVersion",
  "kind",
  "operationId",
  "fingerprint",
  "receiptId",
  "status",
  "observedAt",
  "resultingState",
  "readbackAuthority",
  "executionAuthority",
] as const;

const EXECUTION_AUTHORITY_KEYS = [
  "grantedByCapture",
  "browserControl",
  "liveDomMutation",
] as const;

const TERMINAL_STATUSES: readonly AnnotationLifecycleOperationTerminalStatus[] = [
  "succeeded",
  "failed",
  "blocked",
  "expired",
  "cancelled",
  "rejected",
  "stale",
  "conflict",
];

const PROGRESS_STATUSES: readonly AnnotationLifecycleOperationProgressStatus[] = [
  "pending",
  "approved",
  "applying",
];

/** Parse and detach a proposal using own enumerable data descriptors only. */
export function parseAnnotationLifecycleOperationProposal(
  value: unknown,
): AnnotationLifecycleOperationProposalParseResult {
  const issues = new IssueCollector();
  const detached = detachRecord(value, "$", issues);
  if (!detached) return issues.failure();

  checkExactKeys(detached, PROPOSAL_KEYS, "$", issues);
  checkRequiredKeys(detached, PROPOSAL_KEYS, "$", issues);
  checkLiteral(detached, "schemaVersion", ANNOTATION_LIFECYCLE_CONTROL_SCHEMA_VERSION, issues);
  checkLiteral(detached, "kind", ANNOTATION_LIFECYCLE_OPERATION_PROPOSAL_KIND, issues);
  checkUuidV4(readData(detached, "operationId"), "operationId", issues);
  checkId(readData(detached, "instanceId"), INSTANCE_ID_PATTERN, "instanceId", issues);
  checkId(readData(detached, "captureId"), CAPTURE_ID_PATTERN, "captureId", issues);
  checkPositiveSafeInteger(readData(detached, "expectedSequence"), "expectedSequence", issues);
  checkId(readData(detached, "annotationId"), ANNOTATION_ID_PATTERN, "annotationId", issues);
  checkState(readData(detached, "expectedState"), "expectedState", issues);
  checkState(readData(detached, "nextState"), "nextState", issues);

  const expectedState = readData(detached, "expectedState");
  const nextState = readData(detached, "nextState");
  if (isState(expectedState) && isState(nextState) && expectedState === nextState) {
    issues.add("invalid_value", "$.nextState");
  }

  if (!issues.ok()) return issues.failure();
  return {
    ok: true,
    value: {
      schemaVersion: ANNOTATION_LIFECYCLE_CONTROL_SCHEMA_VERSION,
      kind: ANNOTATION_LIFECYCLE_OPERATION_PROPOSAL_KIND,
      operationId: readData(detached, "operationId") as string,
      instanceId: readData(detached, "instanceId") as string,
      captureId: readData(detached, "captureId") as string,
      expectedSequence: readData(detached, "expectedSequence") as number,
      annotationId: readData(detached, "annotationId") as string,
      expectedState: expectedState as AnnotationLifecycleState,
      nextState: nextState as AnnotationLifecycleState,
    },
  };
}

/** Parse and detach a non-terminal or terminal status observation. */
export function parseAnnotationLifecycleOperationStatus(
  value: unknown,
): AnnotationLifecycleOperationStatusParseResult {
  const issues = new IssueCollector();
  const detached = detachRecord(value, "$", issues);
  if (!detached) return issues.failure();

  checkExactKeys(detached, STATUS_KEYS, "$", issues);
  checkRequiredKeys(detached, STATUS_KEYS, "$", issues);
  checkLiteral(detached, "schemaVersion", ANNOTATION_LIFECYCLE_CONTROL_SCHEMA_VERSION, issues);
  checkLiteral(detached, "kind", ANNOTATION_LIFECYCLE_OPERATION_STATUS_KIND, issues);
  checkUuidV4(readData(detached, "operationId"), "operationId", issues);
  checkFingerprint(readData(detached, "fingerprint"), "fingerprint", issues);
  checkStatus(readData(detached, "status"), "status", issues);
  checkCanonicalIsoDate(readData(detached, "observedAt"), "observedAt", issues);
  checkNullableId(readData(detached, "receiptId"), "receiptId", issues);
  checkNullableState(readData(detached, "resultingState"), "resultingState", issues);
  const authority = detachRecord(readData(detached, "executionAuthority"), "$.executionAuthority", issues);
  if (authority) {
    checkExactKeys(authority, EXECUTION_AUTHORITY_KEYS, "$.executionAuthority", issues);
    checkRequiredKeys(authority, EXECUTION_AUTHORITY_KEYS, "$.executionAuthority", issues);
    for (const key of EXECUTION_AUTHORITY_KEYS) {
      checkLiteral(authority, key, false, issues);
    }
  }
  checkStatusRelation(
    readData(detached, "status"),
    readData(detached, "receiptId"),
    readData(detached, "resultingState"),
    issues,
  );

  if (!issues.ok()) return issues.failure();
  return {
    ok: true,
    value: {
      schemaVersion: ANNOTATION_LIFECYCLE_CONTROL_SCHEMA_VERSION,
      kind: ANNOTATION_LIFECYCLE_OPERATION_STATUS_KIND,
      operationId: readData(detached, "operationId") as string,
      fingerprint: readData(detached, "fingerprint") as string,
      status: readData(detached, "status") as AnnotationLifecycleOperationStatusValue,
      observedAt: readData(detached, "observedAt") as string,
      receiptId: readData(detached, "receiptId") as string | null,
      resultingState: readData(detached, "resultingState") as AnnotationLifecycleState | null,
      executionAuthority: {
        grantedByCapture: false,
        browserControl: false,
        liveDomMutation: false,
      },
    },
  };
}

/** Parse and detach a terminal receipt. */
export function parseAnnotationLifecycleOperationReceipt(
  value: unknown,
): AnnotationLifecycleOperationReceiptParseResult {
  const issues = new IssueCollector();
  const detached = detachRecord(value, "$", issues);
  if (!detached) return issues.failure();

  checkExactKeys(detached, RECEIPT_KEYS, "$", issues);
  checkRequiredKeys(detached, RECEIPT_KEYS, "$", issues);
  checkLiteral(detached, "schemaVersion", ANNOTATION_LIFECYCLE_CONTROL_SCHEMA_VERSION, issues);
  checkLiteral(detached, "kind", ANNOTATION_LIFECYCLE_OPERATION_RECEIPT_KIND, issues);
  checkUuidV4(readData(detached, "operationId"), "operationId", issues);
  checkFingerprint(readData(detached, "fingerprint"), "fingerprint", issues);
  checkTerminalStatus(readData(detached, "status"), "status", issues);
  checkCanonicalIsoDate(readData(detached, "observedAt"), "observedAt", issues);
  checkId(readData(detached, "receiptId"), RECEIPT_ID_PATTERN, "receiptId", issues);
  checkNullableState(readData(detached, "resultingState"), "resultingState", issues);
  checkReadbackAuthority(readData(detached, "readbackAuthority"), "readbackAuthority", issues);
  const authority = detachRecord(readData(detached, "executionAuthority"), "$.executionAuthority", issues);
  if (authority) {
    checkExactKeys(authority, EXECUTION_AUTHORITY_KEYS, "$.executionAuthority", issues);
    checkRequiredKeys(authority, EXECUTION_AUTHORITY_KEYS, "$.executionAuthority", issues);
    for (const key of EXECUTION_AUTHORITY_KEYS) {
      checkLiteral(authority, key, false, issues);
    }
  }
  checkReceiptRelation(
    readData(detached, "status"),
    readData(detached, "resultingState"),
    readData(detached, "readbackAuthority"),
    issues,
  );

  if (!issues.ok()) return issues.failure();
  return {
    ok: true,
    value: {
      schemaVersion: ANNOTATION_LIFECYCLE_CONTROL_SCHEMA_VERSION,
      kind: ANNOTATION_LIFECYCLE_OPERATION_RECEIPT_KIND,
      operationId: readData(detached, "operationId") as string,
      fingerprint: readData(detached, "fingerprint") as string,
      receiptId: readData(detached, "receiptId") as string,
      status: readData(detached, "status") as AnnotationLifecycleOperationTerminalStatus,
      observedAt: readData(detached, "observedAt") as string,
      resultingState: readData(detached, "resultingState") as AnnotationLifecycleState | null,
      readbackAuthority: readData(detached, "readbackAuthority") as AnnotationLifecycleOperationReadbackAuthority,
      executionAuthority: {
        grantedByCapture: false,
        browserControl: false,
        liveDomMutation: false,
      },
    },
  };
}

function checkReadbackAuthority(
  value: unknown,
  path: string,
  issues: IssueCollector,
): void {
  if (value !== "current_snapshot" && value !== "durable_ledger") {
    issues.add("invalid_value", `$.${path}`);
  }
}

export function isAnnotationLifecycleOperationProposal(
  value: unknown,
): value is AnnotationLifecycleOperationProposalV1 {
  return parseAnnotationLifecycleOperationProposal(value).ok;
}

export function isAnnotationLifecycleOperationStatus(
  value: unknown,
): value is AnnotationLifecycleOperationStatusV1 {
  return parseAnnotationLifecycleOperationStatus(value).ok;
}

export function isAnnotationLifecycleOperationReceipt(
  value: unknown,
): value is AnnotationLifecycleOperationReceiptV1 {
  return parseAnnotationLifecycleOperationReceipt(value).ok;
}

/** Serialize the detached canonical representation. */
export function serializeAnnotationLifecycleOperationProposal(
  value: unknown,
): { ok: true; value: string } | AnnotationLifecycleControlValidationFailure {
  const parsed = parseAnnotationLifecycleOperationProposal(value);
  if (!parsed.ok) return parsed;
  return { ok: true, value: JSON.stringify(parsed.value) };
}

export function serializeAnnotationLifecycleOperationStatus(
  value: unknown,
): { ok: true; value: string } | AnnotationLifecycleControlValidationFailure {
  const parsed = parseAnnotationLifecycleOperationStatus(value);
  if (!parsed.ok) return parsed;
  return { ok: true, value: JSON.stringify(parsed.value) };
}

export function serializeAnnotationLifecycleOperationReceipt(
  value: unknown,
): { ok: true; value: string } | AnnotationLifecycleControlValidationFailure {
  const parsed = parseAnnotationLifecycleOperationReceipt(value);
  if (!parsed.ok) return parsed;
  return { ok: true, value: JSON.stringify(parsed.value) };
}

/**
 * Create the bytes to hash for an operation fingerprint.
 *
 * Every field is UTF-8 encoded and prefixed with a 32-bit big-endian byte
 * length.  The domain is the first length-prefixed field, followed by the
 * proposal fields in the fixed order below.  No JSON, locale formatting, or
 * caller object is involved, so equivalent detached proposals produce the
 * same bytes and a caller cannot smuggle separators into the input.
 */
export function createAnnotationLifecycleOperationFingerprintInput(
  proposal: unknown,
): Uint8Array | null {
  const parsed = parseAnnotationLifecycleOperationProposal(proposal);
  if (!parsed.ok) return null;
  const value = parsed.value;
  const fields = [
    ANNOTATION_LIFECYCLE_CONTROL_FINGERPRINT_DOMAIN,
    value.schemaVersion,
    value.kind,
    value.operationId,
    value.instanceId,
    value.captureId,
    String(value.expectedSequence),
    value.annotationId,
    value.expectedState,
    value.nextState,
  ];
  const encoded = fields.map((field) => encoder.encode(field));
  const total = encoded.reduce((sum, field) => sum + 4 + field.byteLength, 0);
  const result = new Uint8Array(total);
  const view = new DataView(result.buffer);
  let offset = 0;
  for (const field of encoded) {
    view.setUint32(offset, field.byteLength, false);
    offset += 4;
    result.set(field, offset);
    offset += field.byteLength;
  }
  return result;
}

function checkStatusRelation(
  status: unknown,
  receiptId: unknown,
  resultingState: unknown,
  issues: IssueCollector,
): void {
  if (!isStatusValue(status)) return;
  const terminal = isTerminalStatus(status);
  const hasReceipt = typeof receiptId === "string";
  const hasResult = isState(resultingState);
  if (terminal !== hasReceipt || (status === "succeeded") !== hasResult) {
    issues.add("invalid_status_relation", "$.status");
  }
  if (status !== "succeeded" && hasResult) {
    issues.add("invalid_status_relation", "$.resultingState");
  }
}

function checkReceiptRelation(
  status: unknown,
  resultingState: unknown,
  readbackAuthority: unknown,
  issues: IssueCollector,
): void {
  if (!isTerminalStatus(status)) return;
  const hasResult = isState(resultingState);
  if ((status === "succeeded") !== hasResult) {
    issues.add("invalid_status_relation", "$.resultingState");
  }
  if (status !== "succeeded" && hasResult) {
    issues.add("invalid_status_relation", "$.resultingState");
  }
  if (status !== "succeeded" && readbackAuthority !== "current_snapshot") {
    issues.add("invalid_status_relation", "$.readbackAuthority");
  }
}

function checkExactKeys(
  value: Record<string, unknown>,
  expected: readonly string[],
  path: string,
  issues: IssueCollector,
): void {
  const actual = Object.keys(value);
  const expectedSet = new Set(expected);
  for (const key of actual) {
    if (!expectedSet.has(key)) issues.add("unknown_field", `${path}.${key}`);
  }
}

function checkRequiredKeys(
  value: Record<string, unknown>,
  expected: readonly string[],
  path: string,
  issues: IssueCollector,
): void {
  for (const key of expected) {
    if (!Object.hasOwn(value, key)) issues.add("missing_field", `${path}.${key}`);
  }
}

function checkLiteral(
  value: Record<string, unknown>,
  key: string,
  expected: unknown,
  issues: IssueCollector,
): void {
  if (readData(value, key) !== expected) issues.add("invalid_value", `$.${key}`);
}

function checkUuidV4(value: unknown, path: string, issues: IssueCollector): void {
  if (typeof value !== "string") {
    issues.add("invalid_value", `$.${path}`);
    return;
  }
  if (value.length > ANNOTATION_LIFECYCLE_CONTROL_MAX_ID_LENGTH) {
    issues.add("overbound", `$.${path}`);
  } else if (!UUID_V4_PATTERN.test(value)) {
    issues.add("invalid_value", `$.${path}`);
  }
}

function checkId(
  value: unknown,
  pattern: RegExp,
  path: string,
  issues: IssueCollector,
): void {
  if (typeof value !== "string") {
    issues.add("invalid_value", `$.${path}`);
    return;
  }
  if (value.length > ANNOTATION_LIFECYCLE_CONTROL_MAX_ID_LENGTH) {
    issues.add("overbound", `$.${path}`);
  } else if (!pattern.test(value)) {
    issues.add("invalid_value", `$.${path}`);
  }
}

function checkPositiveSafeInteger(value: unknown, path: string, issues: IssueCollector): void {
  if (!Number.isSafeInteger(value)) {
    issues.add("invalid_value", `$.${path}`);
    return;
  }
  if ((value as number) <= 0) issues.add("invalid_value", `$.${path}`);
}

function checkState(value: unknown, path: string, issues: IssueCollector): void {
  if (!isState(value)) issues.add("invalid_value", `$.${path}`);
}

function checkNullableState(value: unknown, path: string, issues: IssueCollector): void {
  if (value !== null && !isState(value)) issues.add("invalid_value", `$.${path}`);
}

function checkFingerprint(value: unknown, path: string, issues: IssueCollector): void {
  if (typeof value !== "string") {
    issues.add("invalid_fingerprint", `$.${path}`);
  } else if (!FINGERPRINT_PATTERN.test(value)) {
    issues.add(value.length > 64 ? "overbound" : "invalid_fingerprint", `$.${path}`);
  }
}

function checkCanonicalIsoDate(value: unknown, path: string, issues: IssueCollector): void {
  if (typeof value !== "string") {
    issues.add("invalid_date", `$.${path}`);
    return;
  }
  try {
    if (
      !CANONICAL_DATE_PATTERN.test(value) ||
      new Date(value).toISOString() !== value
    ) issues.add("invalid_date", `$.${path}`);
  } catch {
    issues.add("invalid_date", `$.${path}`);
  }
}

function checkStatus(value: unknown, path: string, issues: IssueCollector): void {
  if (!isStatusValue(value)) issues.add("invalid_value", `$.${path}`);
}

function checkTerminalStatus(value: unknown, path: string, issues: IssueCollector): void {
  if (!isTerminalStatus(value)) issues.add("invalid_value", `$.${path}`);
}

function checkNullableId(value: unknown, path: string, issues: IssueCollector): void {
  if (value !== null) checkId(value, RECEIPT_ID_PATTERN, path, issues);
}

function isState(value: unknown): value is AnnotationLifecycleState {
  return value === "open" || value === "resolved";
}

function isTerminalStatus(value: unknown): value is AnnotationLifecycleOperationTerminalStatus {
  return typeof value === "string" &&
    (TERMINAL_STATUSES as readonly string[]).includes(value);
}

function isStatusValue(value: unknown): value is AnnotationLifecycleOperationStatusValue {
  return typeof value === "string" &&
    ([...PROGRESS_STATUSES, ...TERMINAL_STATUSES] as readonly string[]).includes(value);
}

function detachRecord(
  value: unknown,
  path: string,
  issues: IssueCollector,
): Record<string, unknown> | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    issues.add("invalid_type", path);
    return null;
  }
  try {
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      issues.add("invalid_type", path);
      return null;
    }
    const descriptors = Object.getOwnPropertyDescriptors(value);
    const detached: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
    for (const key of Reflect.ownKeys(descriptors)) {
      if (typeof key !== "string") {
        issues.add("unknown_field", path);
        continue;
      }
      const descriptor = descriptors[key];
      if (!descriptor || !descriptor.enumerable || !Object.hasOwn(descriptor, "value")) {
        issues.add("invalid_type", `${path}.${key}`);
        continue;
      }
      Object.defineProperty(detached, key, {
        configurable: true,
        enumerable: true,
        writable: true,
        value: descriptor.value,
      });
    }
    return detached;
  } catch {
    issues.add("invalid_type", path);
    return null;
  }
}

function readData(value: Record<string, unknown>, key: string): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  return descriptor && descriptor.enumerable && Object.hasOwn(descriptor, "value")
    ? descriptor.value
    : undefined;
}

class IssueCollector {
  private readonly issues: AnnotationLifecycleControlIssue[] = [];

  add(code: AnnotationLifecycleControlIssueCode, path: string): void {
    if (this.issues.length < MAX_ISSUES) this.issues.push({ code, path });
  }

  ok(): boolean {
    return this.issues.length === 0;
  }

  failure(): AnnotationLifecycleControlValidationFailure {
    return { ok: false, issues: this.issues.slice() };
  }
}
