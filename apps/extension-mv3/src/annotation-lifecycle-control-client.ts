import {
  UI_ATTACH_LOCAL_BRIDGE_ORIGIN,
  parseAnnotationLifecycleOperationProposal,
  parseAnnotationLifecycleOperationReceipt,
  parseAnnotationLifecycleOperationStatus,
  type AnnotationLifecycleOperationProposalV1,
  type AnnotationLifecycleOperationReceiptV1,
  type AnnotationLifecycleOperationStatusV1,
} from "@meanthis/schema";

const CONTROL_TIMEOUT_MS = 3_000;
const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const UUID_V4_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const HASH_PATTERN = /^[0-9a-f]{64}$/;
const CANONICAL_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

export type AnnotationLifecycleControlPhase =
  | "awaiting_user" | "approved" | "executing" | "applied"
  | "rejected" | "expired" | "blocked" | "unknown" | "stale";

export interface AnnotationLifecycleOperationReferenceV1 {
  operationId: string;
  fingerprint: string;
  ownerGeneration: number;
  connectionGeneration: number;
}

export interface AnnotationLifecycleOperationApprovalV1 {
  approvedAt: string;
  expiresAt: string;
}

export interface AnnotationLifecycleControlRecordV1 {
  proposal: AnnotationLifecycleOperationProposalV1;
  fingerprint: string;
  phase: AnnotationLifecycleControlPhase;
  status: AnnotationLifecycleOperationStatusV1;
  createdAt: string;
  expiresAt: string;
  approvedAt: string | null;
  ownerGeneration: number;
  connectionGeneration: number;
  receipt: AnnotationLifecycleOperationReceiptV1 | null;
}

export interface AnnotationLifecycleOperationViewV1 {
  record: AnnotationLifecycleControlRecordV1;
  reference: AnnotationLifecycleOperationReferenceV1;
}

export interface AnnotationLifecycleOperationClaimV1 extends AnnotationLifecycleOperationViewV1 {
  approval: AnnotationLifecycleOperationApprovalV1;
}

export interface AnnotationLifecycleControlAuthorityV1 {
  ownerGeneration: number;
  connectionGeneration: number;
}

export interface AnnotationLifecycleControlTransport {
  readAuthority(token: string): Promise<AnnotationLifecycleControlAuthorityV1>;
  readNext(token: string): Promise<AnnotationLifecycleOperationViewV1 | null>;
  claim(
    token: string,
    reference: AnnotationLifecycleOperationReferenceV1,
  ): Promise<AnnotationLifecycleOperationClaimV1>;
  reject(
    token: string,
    reference: AnnotationLifecycleOperationReferenceV1,
  ): Promise<AnnotationLifecycleOperationViewV1>;
  finalize(
    token: string,
    reference: AnnotationLifecycleOperationReferenceV1,
    approval: AnnotationLifecycleOperationApprovalV1,
    receipt: AnnotationLifecycleOperationReceiptV1,
  ): Promise<AnnotationLifecycleOperationViewV1>;
}

export function createAnnotationLifecycleControlTransport(
  dependencies: { fetch: typeof globalThis.fetch },
): AnnotationLifecycleControlTransport {
  async function request(
    token: string,
    path: string,
    method: "GET" | "POST",
    body?: unknown,
  ): Promise<unknown> {
    if (!TOKEN_PATTERN.test(token)) throw new Error("Invalid local bridge control token.");
    const response = await dependencies.fetch(`${UI_ATTACH_LOCAL_BRIDGE_ORIGIN}${path}`, {
      method,
      redirect: "error",
      signal: AbortSignal.timeout(CONTROL_TIMEOUT_MS),
      headers: {
        authorization: `Bearer ${token}`,
        ...(method === "POST" ? { "content-type": "application/json" } : {}),
      },
      ...(method === "POST" ? { body: JSON.stringify(body) } : {}),
    });
    if (!response.ok) {
      if (method === "GET" && response.status === 404) return null;
      throw new Error("Annotation lifecycle control request was rejected.");
    }
    return await response.json() as unknown;
  }

  return {
    async readAuthority(token) {
      const value = await request(token, "/v1/annotation-lifecycle/authority", "GET");
      const envelope = readEnvelope(
        value,
        "ui-attach.annotation-lifecycle-control-authority",
      );
      const authority = envelope ? parseAnnotationLifecycleControlAuthority(envelope.data) : null;
      if (!authority) throw new Error("Invalid annotation lifecycle control authority.");
      return authority;
    },

    async readNext(token) {
      const value = await request(token, "/v1/annotation-lifecycle/proposals", "GET");
      if (value === null) return null;
      const envelope = readEnvelope(
        value,
        "ui-attach.annotation-lifecycle-operation-delivery",
      );
      if (!envelope) throw new Error("Invalid annotation lifecycle operation delivery.");
      if (envelope.data === null) return null;
      const parsed = parseAnnotationLifecycleOperationView(envelope.data);
      if (!parsed) throw new Error("Invalid annotation lifecycle operation delivery.");
      return parsed;
    },

    async claim(token, reference) {
      const parsedReference = parseAnnotationLifecycleOperationReference(reference);
      if (!parsedReference) throw new Error("Invalid annotation lifecycle operation reference.");
      const value = await request(
        token,
        `/v1/annotation-lifecycle/proposals/${parsedReference.operationId}/claim`,
        "POST",
        parsedReference,
      );
      const envelope = readEnvelope(
        value,
        "ui-attach.annotation-lifecycle-operation-claimed",
      );
      const parsed = envelope ? parseAnnotationLifecycleOperationClaim(envelope.data) : null;
      if (!parsed) throw new Error("Invalid annotation lifecycle operation claim.");
      return parsed;
    },

    async reject(token, reference) {
      const parsedReference = parseAnnotationLifecycleOperationReference(reference);
      if (!parsedReference) throw new Error("Invalid annotation lifecycle operation reference.");
      const value = await request(
        token,
        `/v1/annotation-lifecycle/proposals/${parsedReference.operationId}/reject`,
        "POST",
        parsedReference,
      );
      const envelope = readEnvelope(
        value,
        "ui-attach.annotation-lifecycle-operation-rejected",
      );
      const parsed = envelope ? parseAnnotationLifecycleOperationView(envelope.data) : null;
      if (!parsed) throw new Error("Invalid annotation lifecycle operation rejection.");
      return parsed;
    },

    async finalize(token, reference, approval, receipt) {
      const parsedReference = parseAnnotationLifecycleOperationReference(reference);
      const parsedApproval = parseAnnotationLifecycleOperationApproval(approval);
      const parsedReceipt = parseAnnotationLifecycleOperationReceipt(receipt);
      if (!parsedReference || !parsedApproval || !parsedReceipt.ok) {
        throw new Error("Invalid annotation lifecycle operation result.");
      }
      const value = await request(
        token,
        `/v1/annotation-lifecycle/proposals/${parsedReference.operationId}/result`,
        "POST",
        { reference: parsedReference, approval: parsedApproval, receipt: parsedReceipt.value },
      );
      const envelope = readEnvelope(
        value,
        "ui-attach.annotation-lifecycle-operation-finalized",
      );
      const parsed = envelope ? parseAnnotationLifecycleOperationView(envelope.data) : null;
      if (!parsed) throw new Error("Invalid annotation lifecycle operation result.");
      return parsed;
    },
  };
}

export function parseAnnotationLifecycleControlAuthority(
  value: unknown,
): AnnotationLifecycleControlAuthorityV1 | null {
  const authority = readExactDataRecord(value, ["ownerGeneration", "connectionGeneration"]);
  if (
    !authority || !isPositiveInteger(authority.ownerGeneration) ||
    !isPositiveInteger(authority.connectionGeneration)
  ) return null;
  return {
    ownerGeneration: authority.ownerGeneration,
    connectionGeneration: authority.connectionGeneration,
  };
}

function isPositiveInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

export function parseAnnotationLifecycleOperationView(
  value: unknown,
): AnnotationLifecycleOperationViewV1 | null {
  const view = readExactDataRecord(value, ["record", "reference"]);
  if (!view) return null;
  const record = parseRecord(view.record);
  const reference = parseAnnotationLifecycleOperationReference(view.reference);
  if (
    !record || !reference ||
    reference.operationId !== record.proposal.operationId ||
    reference.fingerprint !== record.fingerprint ||
    reference.ownerGeneration !== record.ownerGeneration ||
    reference.connectionGeneration !== record.connectionGeneration
  ) return null;
  return { record, reference };
}

export function parseAnnotationLifecycleOperationClaim(
  value: unknown,
): AnnotationLifecycleOperationClaimV1 | null {
  const claim = readExactDataRecord(value, ["record", "reference", "approval"]);
  if (!claim) return null;
  const view = parseAnnotationLifecycleOperationView({
    record: claim.record,
    reference: claim.reference,
  });
  const approval = parseAnnotationLifecycleOperationApproval(claim.approval);
  if (
    !view || !approval || view.record.phase !== "executing" ||
    view.record.approvedAt !== approval.approvedAt ||
    view.record.expiresAt !== approval.expiresAt
  ) return null;
  return { ...view, approval };
}

function parseRecord(value: unknown): AnnotationLifecycleControlRecordV1 | null {
  const record = readExactDataRecord(value, [
    "proposal", "fingerprint", "phase", "status", "createdAt", "expiresAt", "approvedAt",
    "ownerGeneration", "connectionGeneration", "receipt",
  ]);
  if (!record) return null;
  const proposal = parseAnnotationLifecycleOperationProposal(record.proposal);
  const status = parseAnnotationLifecycleOperationStatus(record.status);
  const receipt = record.receipt === null
    ? { ok: true as const, value: null }
    : parseAnnotationLifecycleOperationReceipt(record.receipt);
  if (
    !proposal.ok || !status.ok || !receipt.ok ||
    typeof record.fingerprint !== "string" || !HASH_PATTERN.test(record.fingerprint) ||
    !isPhase(record.phase) || !isCanonicalDate(record.createdAt) ||
    !isCanonicalDate(record.expiresAt) ||
    (record.approvedAt !== null && !isCanonicalDate(record.approvedAt)) ||
    !isPositiveSafeInteger(record.ownerGeneration) ||
    !isPositiveSafeInteger(record.connectionGeneration) ||
    status.value.operationId !== proposal.value.operationId ||
    status.value.fingerprint !== record.fingerprint ||
    (receipt.value !== null && (
      receipt.value.operationId !== proposal.value.operationId ||
      receipt.value.fingerprint !== record.fingerprint
    )) ||
    !phaseRelation(record.phase, status.value.status, record.approvedAt, receipt.value)
  ) return null;
  return {
    proposal: proposal.value,
    fingerprint: record.fingerprint,
    phase: record.phase,
    status: status.value,
    createdAt: record.createdAt,
    expiresAt: record.expiresAt,
    approvedAt: record.approvedAt,
    ownerGeneration: record.ownerGeneration,
    connectionGeneration: record.connectionGeneration,
    receipt: receipt.value,
  };
}

export function parseAnnotationLifecycleOperationReference(
  value: unknown,
): AnnotationLifecycleOperationReferenceV1 | null {
  const record = readExactDataRecord(value, [
    "operationId", "fingerprint", "ownerGeneration", "connectionGeneration",
  ]);
  if (
    !record || typeof record.operationId !== "string" || !UUID_V4_PATTERN.test(record.operationId) ||
    typeof record.fingerprint !== "string" || !HASH_PATTERN.test(record.fingerprint) ||
    !isPositiveSafeInteger(record.ownerGeneration) ||
    !isPositiveSafeInteger(record.connectionGeneration)
  ) return null;
  return record as unknown as AnnotationLifecycleOperationReferenceV1;
}

export function parseAnnotationLifecycleOperationApproval(
  value: unknown,
): AnnotationLifecycleOperationApprovalV1 | null {
  const record = readExactDataRecord(value, ["approvedAt", "expiresAt"]);
  if (!record || !isCanonicalDate(record.approvedAt) || !isCanonicalDate(record.expiresAt)) {
    return null;
  }
  return record as unknown as AnnotationLifecycleOperationApprovalV1;
}

function readEnvelope(
  value: unknown,
  kind: string,
): { data: unknown } | null {
  const envelope = readExactDataRecord(value, ["schemaVersion", "kind", "ok", "data"]);
  return envelope && envelope.schemaVersion === "0.1.0" &&
      envelope.kind === kind && envelope.ok === true
    ? { data: envelope.data }
    : null;
}

function phaseRelation(
  phase: AnnotationLifecycleControlPhase,
  status: AnnotationLifecycleOperationStatusV1["status"],
  approvedAt: unknown,
  receipt: AnnotationLifecycleOperationReceiptV1 | null,
): boolean {
  if (phase === "awaiting_user") return status === "pending" && approvedAt === null && receipt === null;
  if (phase === "approved") return status === "approved" && typeof approvedAt === "string" && receipt === null;
  if (phase === "executing") return status === "applying" && typeof approvedAt === "string" && receipt === null;
  if (phase === "applied") return status === "succeeded" && receipt?.status === "succeeded";
  if (phase === "rejected") return status === "rejected" && (receipt === null || receipt.status === "rejected");
  if (phase === "expired") return status === "expired" && receipt === null;
  if (phase === "blocked") return status === "blocked" && receipt?.status === "blocked";
  if (phase === "stale") return status === "stale" && receipt === null;
  return receipt !== null && status === receipt.status;
}

function isPhase(value: unknown): value is AnnotationLifecycleControlPhase {
  return value === "awaiting_user" || value === "approved" || value === "executing" ||
    value === "applied" || value === "rejected" || value === "expired" ||
    value === "blocked" || value === "unknown" || value === "stale";
}

function isCanonicalDate(value: unknown): value is string {
  if (typeof value !== "string" || !CANONICAL_DATE_PATTERN.test(value)) return false;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) && new Date(timestamp).toISOString() === value;
}

function isPositiveSafeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
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
    if (
      ownKeys.length !== keys.length ||
      ownKeys.some((key) => typeof key !== "string" || !keys.includes(key))
    ) return null;
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
