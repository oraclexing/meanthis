import { describe, expect, test } from "vitest";
import {
  ANNOTATION_LIFECYCLE_CONTROL_FINGERPRINT_DOMAIN,
  ANNOTATION_LIFECYCLE_OPERATION_PROPOSAL_KIND,
  ANNOTATION_LIFECYCLE_OPERATION_RECEIPT_KIND,
  ANNOTATION_LIFECYCLE_OPERATION_STATUS_KIND,
  ANNOTATION_LIFECYCLE_CONTROL_SCHEMA_VERSION,
  createAnnotationLifecycleOperationFingerprintInput,
  parseAnnotationLifecycleOperationProposal,
  parseAnnotationLifecycleOperationReceipt,
  parseAnnotationLifecycleOperationStatus,
  serializeAnnotationLifecycleOperationProposal,
} from "./annotation-lifecycle-control";

const proposal = {
  schemaVersion: ANNOTATION_LIFECYCLE_CONTROL_SCHEMA_VERSION,
  kind: ANNOTATION_LIFECYCLE_OPERATION_PROPOSAL_KIND,
  operationId: "11111111-1111-4111-8111-111111111111",
  instanceId: "instance-0123456789ab",
  captureId: "capture_01",
  expectedSequence: 7,
  annotationId: "annotation_01",
  expectedState: "open" as const,
  nextState: "resolved" as const,
};

const executionAuthority = {
  grantedByCapture: false as const,
  browserControl: false as const,
  liveDomMutation: false as const,
};

const validStatus = {
  schemaVersion: ANNOTATION_LIFECYCLE_CONTROL_SCHEMA_VERSION,
  kind: ANNOTATION_LIFECYCLE_OPERATION_STATUS_KIND,
  operationId: proposal.operationId,
  fingerprint: "a".repeat(64),
  status: "pending" as const,
  observedAt: "2026-09-01T00:00:00.000Z",
  receiptId: null,
  resultingState: null,
  executionAuthority,
};

const validReceipt = {
  schemaVersion: ANNOTATION_LIFECYCLE_CONTROL_SCHEMA_VERSION,
  kind: ANNOTATION_LIFECYCLE_OPERATION_RECEIPT_KIND,
  operationId: proposal.operationId,
  fingerprint: "a".repeat(64),
  receiptId: "receipt_01",
  status: "succeeded" as const,
  observedAt: "2026-09-01T00:00:01.000Z",
  resultingState: "resolved" as const,
  readbackAuthority: "durable_ledger" as const,
  executionAuthority,
};

describe("annotation lifecycle control schema", () => {
  test("accepts and detaches a valid proposal without changing its input", () => {
    const before = structuredClone(proposal);
    const parsed = parseAnnotationLifecycleOperationProposal(proposal);

    expect(parsed).toEqual({ ok: true, value: proposal });
    expect(proposal).toEqual(before);
    expect(serializeAnnotationLifecycleOperationProposal(proposal)).toEqual({
      ok: true,
      value: JSON.stringify(proposal),
    });
  });

  test("rejects missing, undefined, null, extra, inherited, and accessor fields without invoking getters", () => {
    expect(parseAnnotationLifecycleOperationProposal({
      ...proposal,
      annotationId: undefined,
    }).ok).toBe(false);
    expect(parseAnnotationLifecycleOperationProposal({
      ...proposal,
      annotationId: null,
    }).ok).toBe(false);
    expect(parseAnnotationLifecycleOperationProposal({
      ...proposal,
      unexpected: true,
    }).ok).toBe(false);
    const undefinedField = parseAnnotationLifecycleOperationProposal({
      ...proposal,
      annotationId: undefined,
    });
    expect(undefinedField.ok).toBe(false);
    if (!undefinedField.ok) expect(undefinedField.issues).toEqual(expect.arrayContaining([
      { code: "invalid_value", path: "$.annotationId" },
    ]));

    const inherited = Object.create({ annotationId: proposal.annotationId }) as Record<string, unknown>;
    for (const [key, value] of Object.entries(proposal)) {
      if (key !== "annotationId") inherited[key] = value;
    }
    expect(parseAnnotationLifecycleOperationProposal(inherited).ok).toBe(false);

    let getterCalls = 0;
    const accessor = { ...proposal } as Record<string, unknown>;
    Object.defineProperty(accessor, "annotationId", {
      configurable: true,
      enumerable: true,
      get() {
        getterCalls += 1;
        return proposal.annotationId;
      },
    });
    expect(parseAnnotationLifecycleOperationProposal(accessor).ok).toBe(false);
    expect(getterCalls).toBe(0);
  });

  test("rejects invalid ids, sequence bounds, and same-state transitions", () => {
    const invalidCases: unknown[] = [
      { ...proposal, operationId: "not-a-uuid" },
      { ...proposal, operationId: "1".repeat(129) },
      { ...proposal, instanceId: "contains space" },
      { ...proposal, instanceId: "instance_01" },
      { ...proposal, captureId: "capture/one" },
      { ...proposal, annotationId: "" },
      { ...proposal, expectedSequence: 0 },
      { ...proposal, expectedSequence: -1 },
      { ...proposal, expectedSequence: Number.MAX_SAFE_INTEGER + 1 },
      { ...proposal, expectedSequence: Number.NaN },
      { ...proposal, expectedState: "resolved", nextState: "resolved" },
      { ...proposal, expectedState: "unknown" },
    ];
    for (const candidate of invalidCases) {
      expect(parseAnnotationLifecycleOperationProposal(candidate).ok).toBe(false);
      expect(createAnnotationLifecycleOperationFingerprintInput(candidate)).toBeNull();
    }
  });

  test("fingerprint input is domain-separated, fixed-order, UTF-8 length-prefixed bytes", () => {
    const bytes = createAnnotationLifecycleOperationFingerprintInput(proposal);
    expect(bytes).toBeInstanceOf(Uint8Array);
    expect(bytes).not.toBeNull();
    const input = bytes as Uint8Array;
    const view = new DataView(input.buffer, input.byteOffset, input.byteLength);
    const fields = [
      ANNOTATION_LIFECYCLE_CONTROL_FINGERPRINT_DOMAIN,
      proposal.schemaVersion,
      proposal.kind,
      proposal.operationId,
      proposal.instanceId,
      proposal.captureId,
      String(proposal.expectedSequence),
      proposal.annotationId,
      proposal.expectedState,
      proposal.nextState,
    ];
    let offset = 0;
    for (const field of fields) {
      const encoded = new TextEncoder().encode(field);
      expect(view.getUint32(offset, false)).toBe(encoded.byteLength);
      offset += 4;
      expect(Array.from(input.slice(offset, offset + encoded.byteLength))).toEqual(
        Array.from(encoded),
      );
      offset += encoded.byteLength;
    }
    expect(offset).toBe(input.byteLength);

    const second = createAnnotationLifecycleOperationFingerprintInput({
      ...proposal,
      expectedSequence: 8,
    });
    expect(Array.from(second ?? [])).not.toEqual(Array.from(input));
    expect(Array.from(createAnnotationLifecycleOperationFingerprintInput(proposal) ?? []))
      .toEqual(Array.from(input));
  });

  test("accepts progress and terminal statuses only with their exact field relations", () => {
    expect(parseAnnotationLifecycleOperationStatus(validStatus)).toEqual({
      ok: true,
      value: {
        ...validStatus,
        executionAuthority,
      },
    });

    const terminalStatus = parseAnnotationLifecycleOperationStatus({
      ...validStatus,
      status: "succeeded",
      receiptId: "receipt_01",
      resultingState: "resolved",
    });
    expect(terminalStatus.ok).toBe(true);

    const invalidRelations = [
      { ...validStatus, status: "pending", receiptId: "receipt_01" },
      { ...validStatus, status: "pending", resultingState: "resolved" },
      { ...validStatus, status: "succeeded", receiptId: "receipt_01" },
      { ...validStatus, status: "succeeded", resultingState: "resolved" },
      { ...validStatus, status: "unknown" },
      { ...validStatus, observedAt: "not-a-date" },
      { ...validStatus, executionAuthority: { ...executionAuthority, browserControl: true } },
    ];
    for (const candidate of invalidRelations) {
      expect(parseAnnotationLifecycleOperationStatus(candidate).ok).toBe(false);
    }
  });

  test("requires receipt terminal status and all-false execution authority", () => {
    expect(parseAnnotationLifecycleOperationReceipt(validReceipt)).toEqual({
      ok: true,
      value: {
        ...validReceipt,
        executionAuthority,
      },
    });

    const invalidReceipts = [
      { ...validReceipt, status: "pending" },
      { ...validReceipt, status: "failed", resultingState: "resolved" },
      { ...validReceipt, status: "failed", resultingState: null, readbackAuthority: "durable_ledger" },
      { ...validReceipt, receiptId: "" },
      { ...validReceipt, fingerprint: "b".repeat(63) },
      { ...validReceipt, observedAt: "2026-02-30T00:00:00.000Z" },
      { ...validReceipt, observedAt: "+012026-09-01T02:00:30.000Z" },
      { ...validReceipt, readbackAuthority: "snapshot" },
      { ...validReceipt, readbackAuthority: undefined },
      { ...validReceipt, executionAuthority: { ...executionAuthority, liveDomMutation: true } },
      { ...validReceipt, extra: true },
    ];
    for (const candidate of invalidReceipts) {
      expect(parseAnnotationLifecycleOperationReceipt(candidate).ok).toBe(false);
    }
    expect(parseAnnotationLifecycleOperationReceipt({
      ...validReceipt,
      status: "failed",
      resultingState: null,
      readbackAuthority: "current_snapshot",
    }).ok).toBe(true);

    let getterCalls = 0;
    const authorityWithGetter = {
      ...validReceipt,
      executionAuthority: { ...executionAuthority },
    } as Record<string, unknown>;
    Object.defineProperty(authorityWithGetter.executionAuthority, "browserControl", {
      configurable: true,
      enumerable: true,
      get() {
        getterCalls += 1;
        return false;
      },
    });
    expect(parseAnnotationLifecycleOperationReceipt(authorityWithGetter).ok).toBe(false);
    expect(getterCalls).toBe(0);
  });
});
