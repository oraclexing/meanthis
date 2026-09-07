import { createHash } from "node:crypto";
import {
  ANNOTATION_LIFECYCLE_CONTROL_SCHEMA_VERSION,
  ANNOTATION_LIFECYCLE_OPERATION_STATUS_KIND,
  createAnnotationLifecycleOperationFingerprintInput,
  parseAnnotationLifecycleOperationProposal,
  parseAnnotationLifecycleOperationReceipt,
  type AnnotationLifecycleOperationProposalV1,
  type AnnotationLifecycleOperationReceiptV1,
  type AnnotationLifecycleOperationStatusV1,
  type AnnotationLifecycleOperationTerminalStatus,
  type AnnotationLifecycleState,
} from "@meanthis/schema";

export const ANNOTATION_LIFECYCLE_CONTROL_DEFAULT_TTL_MS = 60_000 as const;
export const ANNOTATION_LIFECYCLE_CONTROL_MAX_TTL_MS = 600_000 as const;
export const ANNOTATION_LIFECYCLE_CONTROL_DEFAULT_MAX_OPERATIONS = 64 as const;
export const ANNOTATION_LIFECYCLE_CONTROL_MAX_OPERATIONS = 1_024 as const;

export type AnnotationLifecycleMailboxPhase =
  | "awaiting_user" | "approved" | "executing" | "applied"
  | "rejected" | "expired" | "blocked" | "unknown" | "stale";

export interface AnnotationLifecycleControlBinding {
  ownerGeneration: number;
  connectionGeneration: number;
  instanceId: string;
  captureId: string;
  sequence: number;
  annotationId: string;
  state: AnnotationLifecycleState;
}

export interface AnnotationLifecycleOperationReference {
  operationId: string;
  fingerprint: string;
  ownerGeneration: number;
  connectionGeneration: number;
}

export interface AnnotationLifecycleOperationApproval {
  approvedAt: string;
  expiresAt: string;
}

export interface AnnotationLifecycleControlRecord {
  proposal: AnnotationLifecycleOperationProposalV1;
  fingerprint: string;
  phase: AnnotationLifecycleMailboxPhase;
  status: AnnotationLifecycleOperationStatusV1;
  createdAt: string;
  expiresAt: string;
  approvedAt: string | null;
  ownerGeneration: number;
  connectionGeneration: number;
  receipt: AnnotationLifecycleOperationReceiptV1 | null;
}

export type AnnotationLifecycleControlFailureCode =
  | "INVALID_PROPOSAL" | "INVALID_BINDING" | "INVALID_REFERENCE"
  | "INVALID_APPROVAL" | "INVALID_RECEIPT"
  | "OWNER_GENERATION_MISMATCH" | "CONNECTION_GENERATION_MISMATCH"
  | "INSTANCE_MISMATCH" | "CAPTURE_MISMATCH" | "SEQUENCE_MISMATCH"
  | "ANNOTATION_MISMATCH" | "STATE_MISMATCH" | "FINGERPRINT_MISMATCH"
  | "APPROVAL_MISMATCH" | "RECEIPT_MISMATCH" | "OPERATION_ID_CONFLICT"
  | "TERMINAL_CONFLICT" | "INVALID_TRANSITION" | "CAPACITY_EXCEEDED"
  | "NOT_FOUND" | "EXPIRED";

export type AnnotationLifecycleControlResult =
  | { ok: true; idempotent: boolean; record: AnnotationLifecycleControlRecord }
  | { ok: false; code: AnnotationLifecycleControlFailureCode };

export interface AnnotationLifecycleControlState {
  readonly size: number;
  submit(proposal: unknown, binding: unknown): AnnotationLifecycleControlResult;
  read(reference: unknown): AnnotationLifecycleControlResult;
  listActive(): AnnotationLifecycleControlRecord[];
  approve(reference: unknown, approval: unknown): AnnotationLifecycleControlResult;
  approveCurrent(reference: unknown): AnnotationLifecycleControlResult;
  reject(reference: unknown, observedAt: unknown): AnnotationLifecycleControlResult;
  rejectCurrent(reference: unknown): AnnotationLifecycleControlResult;
  markExecuting(reference: unknown, approval: unknown): AnnotationLifecycleControlResult;
  finalize(reference: unknown, approval: unknown, receipt: unknown): AnnotationLifecycleControlResult;
  rotateGenerations(next: { ownerGeneration: number; connectionGeneration: number }): void;
}

interface StateOptions {
  ownerGeneration: number;
  connectionGeneration: number;
  ttlMs?: number;
  maxOperations?: number;
  now?: () => number;
}

interface StoredOperation {
  fingerprint: string;
  record: AnnotationLifecycleControlRecord;
  expiresAtMs: number;
  expiredFromExecuting: boolean;
  executingObservedAt: string | null;
}

const BINDING_KEYS = ["ownerGeneration", "connectionGeneration", "instanceId", "captureId", "sequence", "annotationId", "state"] as const;
const REFERENCE_KEYS = ["operationId", "fingerprint", "ownerGeneration", "connectionGeneration"] as const;
const APPROVAL_KEYS = ["approvedAt", "expiresAt"] as const;
const FINGERPRINT_PATTERN = /^[0-9a-f]{64}$/;
const UUID_V4_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const CANONICAL_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

/**
 * Bounded, dormant owner mailbox. It records control-plane phases only and
 * grants no browser, DOM, source, cloud, extension, or durable-write authority.
 * Records are retained for the process lifetime; capacity fails closed rather
 * than evicting an executing operation or losing an exact terminal replay.
 */
export function createAnnotationLifecycleControlState(options: StateOptions): AnnotationLifecycleControlState {
  let ownerGeneration = positive(options.ownerGeneration, "ownerGeneration");
  let connectionGeneration = positive(options.connectionGeneration, "connectionGeneration");
  const ttlMs = bounded(options.ttlMs ?? ANNOTATION_LIFECYCLE_CONTROL_DEFAULT_TTL_MS, 1, ANNOTATION_LIFECYCLE_CONTROL_MAX_TTL_MS, "ttlMs");
  const maxOperations = bounded(options.maxOperations ?? ANNOTATION_LIFECYCLE_CONTROL_DEFAULT_MAX_OPERATIONS, 1, ANNOTATION_LIFECYCLE_CONTROL_MAX_OPERATIONS, "maxOperations");
  const now = options.now ?? Date.now;
  const operations = new Map<string, StoredOperation>();

  const resolve = (input: unknown): { stored: StoredOperation } | { failure: AnnotationLifecycleControlFailureCode } => {
    const reference = parseReference(input);
    if (!reference) return { failure: "INVALID_REFERENCE" };
    const stored = operations.get(reference.operationId);
    if (!stored) return { failure: "NOT_FOUND" };
    const mismatch = compareReference(reference, stored.record);
    return mismatch ? { failure: mismatch } : { stored };
  };

  const expireActive = (stored: StoredOperation, at: number): boolean => {
    if (at < stored.expiresAtMs || terminal(stored.record.phase)) return false;
    stored.expiredFromExecuting = stored.record.phase === "executing";
    stored.record = localTerminal(stored.record, "expired", at);
    return true;
  };

  return {
    get size() { return operations.size; },

    submit(proposalInput, bindingInput) {
      const parsed = parseAnnotationLifecycleOperationProposal(proposalInput);
      if (!parsed.ok) return fail("INVALID_PROPOSAL");
      const binding = parseBinding(bindingInput);
      if (!binding) return fail("INVALID_BINDING");
      const bytes = createAnnotationLifecycleOperationFingerprintInput(parsed.value);
      if (!bytes) return fail("INVALID_PROPOSAL");
      const fingerprint = createHash("sha256").update(bytes).digest("hex");
      const existing = operations.get(parsed.value.operationId);
      if (existing) {
        if (existing.fingerprint !== fingerprint) return fail("OPERATION_ID_CONFLICT");
        if (binding.ownerGeneration !== existing.record.ownerGeneration) {
          return fail("OWNER_GENERATION_MISMATCH");
        }
        if (binding.connectionGeneration !== existing.record.connectionGeneration) {
          return fail("CONNECTION_GENERATION_MISMATCH");
        }
        expireActive(existing, clock(now));
        return success(existing.record, true);
      }
      const mismatch = compareBinding(parsed.value, binding, ownerGeneration, connectionGeneration);
      if (mismatch) return fail(mismatch);
      if (operations.size >= maxOperations) return fail("CAPACITY_EXCEEDED");
      const createdAtMs = clock(now);
      const createdAt = iso(createdAtMs);
      const expiresAtMs = createdAtMs + ttlMs;
      const record = freezeRecord({
        proposal: parsed.value,
        fingerprint,
        phase: "awaiting_user",
        status: makeStatus(parsed.value, fingerprint, "pending", createdAt, null, null),
        createdAt,
        expiresAt: iso(expiresAtMs),
        approvedAt: null,
        ownerGeneration,
        connectionGeneration,
        receipt: null,
      });
      operations.set(parsed.value.operationId, {
        fingerprint,
        record,
        expiresAtMs,
        expiredFromExecuting: false,
        executingObservedAt: null,
      });
      return success(record, false);
    },

    read(reference) {
      const result = resolve(reference);
      if ("failure" in result) return fail(result.failure);
      expireActive(result.stored, clock(now));
      return success(result.stored.record, true);
    },

    listActive() {
      const at = clock(now);
      const active: AnnotationLifecycleControlRecord[] = [];
      for (const stored of operations.values()) {
        expireActive(stored, at);
        if (!terminal(stored.record.phase)) active.push(stored.record);
      }
      return active;
    },

    approve(reference, approvalInput) {
      const result = resolve(reference);
      if ("failure" in result) return fail(result.failure);
      const approval = parseApproval(approvalInput);
      if (!approval) return fail("INVALID_APPROVAL");
      const at = clock(now);
      if (expireActive(result.stored, at)) return fail("EXPIRED");
      const current = result.stored.record;
      if (current.phase === "approved") {
        return approvalMatches(approval, current) ? success(current, true) : fail("APPROVAL_MISMATCH");
      }
      if (current.phase !== "awaiting_user") return fail("INVALID_TRANSITION");
      if (approval.expiresAt !== current.expiresAt || approval.approvedAt !== iso(at) || Date.parse(approval.approvedAt) >= result.stored.expiresAtMs) {
        return fail("APPROVAL_MISMATCH");
      }
      result.stored.record = transition(current, "approved", "approved", approval.approvedAt, approval.approvedAt);
      return success(result.stored.record, false);
    },

    approveCurrent(reference) {
      const result = resolve(reference);
      if ("failure" in result) return fail(result.failure);
      const at = clock(now);
      if (expireActive(result.stored, at)) return fail("EXPIRED");
      const current = result.stored.record;
      if (current.phase === "approved") return success(current, true);
      if (current.phase !== "awaiting_user" || at >= result.stored.expiresAtMs) {
        return fail("INVALID_TRANSITION");
      }
      const approvedAt = iso(at);
      result.stored.record = transition(
        current,
        "approved",
        "approved",
        approvedAt,
        approvedAt,
      );
      return success(result.stored.record, false);
    },

    reject(reference, observedAtInput) {
      const result = resolve(reference);
      if ("failure" in result) return fail(result.failure);
      if (typeof observedAtInput !== "string" || !canonical(observedAtInput)) {
        return fail("INVALID_RECEIPT");
      }
      const at = clock(now);
      if (expireActive(result.stored, at)) return fail("EXPIRED");
      const current = result.stored.record;
      if (current.phase === "rejected") {
        return current.status.observedAt === observedAtInput
          ? success(current, true)
          : fail("TERMINAL_CONFLICT");
      }
      if (current.phase !== "awaiting_user" || observedAtInput !== iso(at)) {
        return fail("INVALID_TRANSITION");
      }
      result.stored.record = localTerminal(current, "rejected", at);
      return success(result.stored.record, false);
    },

    rejectCurrent(reference) {
      const result = resolve(reference);
      if ("failure" in result) return fail(result.failure);
      const at = clock(now);
      if (expireActive(result.stored, at)) return fail("EXPIRED");
      const current = result.stored.record;
      if (current.phase === "rejected") return success(current, true);
      if (current.phase !== "awaiting_user") return fail("INVALID_TRANSITION");
      result.stored.record = localTerminal(current, "rejected", at);
      return success(result.stored.record, false);
    },

    markExecuting(reference, approvalInput) {
      const result = resolve(reference);
      if ("failure" in result) return fail(result.failure);
      const approval = parseApproval(approvalInput);
      if (!approval) return fail("INVALID_APPROVAL");
      const at = clock(now);
      if (expireActive(result.stored, at)) return fail("EXPIRED");
      const current = result.stored.record;
      if (!approvalMatches(approval, current)) return fail("APPROVAL_MISMATCH");
      if (current.phase === "executing") return success(current, true);
      if (current.phase !== "approved") return fail("INVALID_TRANSITION");
      result.stored.executingObservedAt = iso(at);
      result.stored.record = transition(
        current,
        "executing",
        "applying",
        result.stored.executingObservedAt,
        current.approvedAt,
      );
      return success(result.stored.record, false);
    },

    finalize(reference, approvalInput, receiptInput) {
      const result = resolve(reference);
      if ("failure" in result) return fail(result.failure);
      const approval = parseApproval(approvalInput);
      if (!approval) return fail("INVALID_APPROVAL");
      const parsed = parseAnnotationLifecycleOperationReceipt(receiptInput);
      if (!parsed.ok) return fail("INVALID_RECEIPT");
      const at = clock(now);
      expireActive(result.stored, at);
      const current = result.stored.record;
      if (!approvalMatches(approval, current)) return fail("APPROVAL_MISMATCH");
      const receipt = parsed.value;
      if (receipt.operationId !== current.proposal.operationId || receipt.fingerprint !== current.fingerprint || (receipt.status === "succeeded" && receipt.resultingState !== current.proposal.nextState)) {
        return fail("RECEIPT_MISMATCH");
      }
      if (terminal(current.phase)) {
        if (
          current.phase === "expired" && current.receipt === null &&
          result.stored.expiredFromExecuting &&
          result.stored.executingObservedAt !== null &&
          Date.parse(receipt.observedAt) >= Date.parse(result.stored.executingObservedAt) &&
          Date.parse(receipt.observedAt) < result.stored.expiresAtMs
        ) {
          result.stored.record = freezeRecord({
            ...current,
            phase: receiptPhase(receipt.status),
            status: makeStatus(
              current.proposal,
              current.fingerprint,
              receipt.status,
              receipt.observedAt,
              receipt.receiptId,
              receipt.resultingState,
            ),
            receipt,
          });
          return success(result.stored.record, false);
        }
        return current.receipt && receiptsEqual(current.receipt, receipt)
          ? success(current, true)
          : fail("TERMINAL_CONFLICT");
      }
      if (current.phase !== "executing") return fail("INVALID_TRANSITION");
      const receiptObservedAt = Date.parse(receipt.observedAt);
      if (
        receiptObservedAt < Date.parse(current.status.observedAt) ||
        receiptObservedAt >= result.stored.expiresAtMs || receiptObservedAt > at
      ) {
        return fail("RECEIPT_MISMATCH");
      }
      result.stored.record = freezeRecord({
        ...current,
        phase: receiptPhase(receipt.status),
        status: makeStatus(current.proposal, current.fingerprint, receipt.status, receipt.observedAt, receipt.receiptId, receipt.resultingState),
        receipt,
      });
      return success(result.stored.record, false);
    },

    rotateGenerations(next) {
      const nextOwner = positive(next.ownerGeneration, "ownerGeneration");
      const nextConnection = positive(next.connectionGeneration, "connectionGeneration");
      if (nextOwner < ownerGeneration || nextConnection < connectionGeneration || (nextOwner === ownerGeneration && nextConnection === connectionGeneration)) {
        throw new Error("Annotation lifecycle control generations must advance.");
      }
      const at = clock(now);
      for (const stored of operations.values()) {
        if (!terminal(stored.record.phase)) stored.record = localTerminal(stored.record, "stale", at);
      }
      ownerGeneration = nextOwner;
      connectionGeneration = nextConnection;
    },
  };
}

function fail(code: AnnotationLifecycleControlFailureCode): AnnotationLifecycleControlResult { return { ok: false, code }; }
function success(record: AnnotationLifecycleControlRecord, idempotent: boolean): AnnotationLifecycleControlResult { return { ok: true, idempotent, record }; }

function compareBinding(proposal: AnnotationLifecycleOperationProposalV1, binding: AnnotationLifecycleControlBinding, owner: number, connection: number): AnnotationLifecycleControlFailureCode | null {
  if (binding.ownerGeneration !== owner) return "OWNER_GENERATION_MISMATCH";
  if (binding.connectionGeneration !== connection) return "CONNECTION_GENERATION_MISMATCH";
  if (binding.instanceId !== proposal.instanceId) return "INSTANCE_MISMATCH";
  if (binding.captureId !== proposal.captureId) return "CAPTURE_MISMATCH";
  if (binding.sequence !== proposal.expectedSequence) return "SEQUENCE_MISMATCH";
  if (binding.annotationId !== proposal.annotationId) return "ANNOTATION_MISMATCH";
  if (binding.state !== proposal.expectedState) return "STATE_MISMATCH";
  return null;
}

function compareReference(reference: AnnotationLifecycleOperationReference, record: AnnotationLifecycleControlRecord): AnnotationLifecycleControlFailureCode | null {
  if (reference.ownerGeneration !== record.ownerGeneration) return "OWNER_GENERATION_MISMATCH";
  if (reference.connectionGeneration !== record.connectionGeneration) return "CONNECTION_GENERATION_MISMATCH";
  if (reference.fingerprint !== record.fingerprint) return "FINGERPRINT_MISMATCH";
  return null;
}

function parseBinding(value: unknown): AnnotationLifecycleControlBinding | null {
  const v = exact(value, BINDING_KEYS);
  if (!v || !isPositive(v.ownerGeneration) || !isPositive(v.connectionGeneration) || typeof v.instanceId !== "string" || typeof v.captureId !== "string" || !isPositive(v.sequence) || typeof v.annotationId !== "string" || (v.state !== "open" && v.state !== "resolved")) return null;
  return v as unknown as AnnotationLifecycleControlBinding;
}

function parseReference(value: unknown): AnnotationLifecycleOperationReference | null {
  const v = exact(value, REFERENCE_KEYS);
  if (!v || typeof v.operationId !== "string" || !UUID_V4_PATTERN.test(v.operationId) || typeof v.fingerprint !== "string" || !FINGERPRINT_PATTERN.test(v.fingerprint) || !isPositive(v.ownerGeneration) || !isPositive(v.connectionGeneration)) return null;
  return v as unknown as AnnotationLifecycleOperationReference;
}

function parseApproval(value: unknown): AnnotationLifecycleOperationApproval | null {
  const v = exact(value, APPROVAL_KEYS);
  if (!v || typeof v.approvedAt !== "string" || typeof v.expiresAt !== "string" || !canonical(v.approvedAt) || !canonical(v.expiresAt)) return null;
  return v as unknown as AnnotationLifecycleOperationApproval;
}

function exact<const K extends readonly string[]>(value: unknown, keys: K): { [P in K[number]]: unknown } | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  try {
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) return null;
    const descriptors = Object.getOwnPropertyDescriptors(value);
    const ownKeys = Reflect.ownKeys(descriptors);
    if (ownKeys.length !== keys.length || ownKeys.some((key) => typeof key !== "string" || !keys.includes(key))) return null;
    const result = Object.create(null) as { [P in K[number]]: unknown };
    for (const key of keys) {
      const descriptor = descriptors[key];
      if (!descriptor?.enumerable || !Object.hasOwn(descriptor, "value") || descriptor.value === undefined) return null;
      result[key as K[number]] = descriptor.value;
    }
    return result;
  } catch { return null; }
}

function approvalMatches(approval: AnnotationLifecycleOperationApproval, record: AnnotationLifecycleControlRecord): boolean {
  return record.approvedAt !== null && approval.approvedAt === record.approvedAt && approval.expiresAt === record.expiresAt;
}

function transition(record: AnnotationLifecycleControlRecord, phase: "approved" | "executing", status: "approved" | "applying", observedAt: string, approvedAt: string | null): AnnotationLifecycleControlRecord {
  return freezeRecord({ ...record, phase, status: makeStatus(record.proposal, record.fingerprint, status, observedAt, null, null), approvedAt });
}

function localTerminal(record: AnnotationLifecycleControlRecord, phase: "expired" | "rejected" | "stale", at: number): AnnotationLifecycleControlRecord {
  const receiptId = `mailbox-${phase}-${record.fingerprint.slice(0, 16)}`;
  return freezeRecord({ ...record, phase, status: makeStatus(record.proposal, record.fingerprint, phase, iso(at), receiptId, null) });
}

function makeStatus(proposal: AnnotationLifecycleOperationProposalV1, fingerprint: string, status: AnnotationLifecycleOperationStatusV1["status"], observedAt: string, receiptId: string | null, resultingState: AnnotationLifecycleState | null): AnnotationLifecycleOperationStatusV1 {
  return {
    schemaVersion: ANNOTATION_LIFECYCLE_CONTROL_SCHEMA_VERSION,
    kind: ANNOTATION_LIFECYCLE_OPERATION_STATUS_KIND,
    operationId: proposal.operationId,
    fingerprint, status, observedAt, receiptId, resultingState,
    executionAuthority: { grantedByCapture: false, browserControl: false, liveDomMutation: false },
  };
}

function freezeRecord(record: AnnotationLifecycleControlRecord): AnnotationLifecycleControlRecord {
  Object.freeze(record.proposal);
  Object.freeze(record.status.executionAuthority);
  Object.freeze(record.status);
  if (record.receipt) { Object.freeze(record.receipt.executionAuthority); Object.freeze(record.receipt); }
  return Object.freeze(record);
}

function receiptPhase(status: AnnotationLifecycleOperationTerminalStatus): "applied" | "rejected" | "expired" | "blocked" | "unknown" {
  if (status === "succeeded") return "applied";
  if (status === "rejected") return "rejected";
  if (status === "expired") return "expired";
  if (status === "blocked") return "blocked";
  return "unknown";
}

function terminal(phase: AnnotationLifecycleMailboxPhase): boolean { return !["awaiting_user", "approved", "executing"].includes(phase); }
function receiptsEqual(a: AnnotationLifecycleOperationReceiptV1, b: AnnotationLifecycleOperationReceiptV1): boolean {
  return a.schemaVersion === b.schemaVersion && a.kind === b.kind && a.operationId === b.operationId && a.fingerprint === b.fingerprint && a.receiptId === b.receiptId && a.status === b.status && a.observedAt === b.observedAt && a.resultingState === b.resultingState && a.readbackAuthority === b.readbackAuthority && a.executionAuthority.grantedByCapture === b.executionAuthority.grantedByCapture && a.executionAuthority.browserControl === b.executionAuthority.browserControl && a.executionAuthority.liveDomMutation === b.executionAuthority.liveDomMutation;
}

function clock(now: () => number): number {
  const value = now();
  if (!Number.isSafeInteger(value) || value < 0 || value > 8_640_000_000_000_000) throw new Error("Invalid annotation lifecycle control clock.");
  return value;
}
function iso(value: number): string {
  const date = new Date(value).toISOString();
  if (!CANONICAL_DATE_PATTERN.test(date)) throw new Error("Annotation lifecycle control time is outside the canonical date range.");
  return date;
}
function canonical(value: string): boolean { const at = Date.parse(value); return CANONICAL_DATE_PATTERN.test(value) && Number.isFinite(at) && new Date(at).toISOString() === value; }
function positive(value: number, name: string): number { return bounded(value, 1, Number.MAX_SAFE_INTEGER, name); }
function bounded(value: number, min: number, max: number, name: string): number { if (!Number.isSafeInteger(value) || value < min || value > max) throw new Error(`Invalid annotation lifecycle control ${name}.`); return value; }
function isPositive(value: unknown): value is number { return Number.isSafeInteger(value) && (value as number) > 0; }
