import { describe, expect, test, vi } from "vitest";
import {
  ANNOTATION_LIFECYCLE_CONTROL_SCHEMA_VERSION,
  ANNOTATION_LIFECYCLE_OPERATION_PROPOSAL_KIND,
  ANNOTATION_LIFECYCLE_OPERATION_STATUS_KIND,
} from "@meanthis/schema";
import {
  createAnnotationLifecycleControlTransport,
  parseAnnotationLifecycleOperationView,
} from "./annotation-lifecycle-control-client";

const reference = {
  operationId: "11111111-1111-4111-8111-111111111111",
  fingerprint: "a".repeat(64),
  ownerGeneration: 3,
  connectionGeneration: 5,
};
const record = {
  proposal: {
    schemaVersion: ANNOTATION_LIFECYCLE_CONTROL_SCHEMA_VERSION,
    kind: ANNOTATION_LIFECYCLE_OPERATION_PROPOSAL_KIND,
    operationId: reference.operationId,
    instanceId: "instance-0123456789ab",
    captureId: "capture_01",
    expectedSequence: 7,
    annotationId: "annotation_01",
    expectedState: "open" as const,
    nextState: "resolved" as const,
  },
  fingerprint: reference.fingerprint,
  phase: "awaiting_user" as const,
  status: {
    schemaVersion: ANNOTATION_LIFECYCLE_CONTROL_SCHEMA_VERSION,
    kind: ANNOTATION_LIFECYCLE_OPERATION_STATUS_KIND,
    operationId: reference.operationId,
    fingerprint: reference.fingerprint,
    status: "pending" as const,
    observedAt: "2026-09-01T03:00:00.000Z",
    receiptId: null,
    resultingState: null,
    executionAuthority: {
      grantedByCapture: false as const,
      browserControl: false as const,
      liveDomMutation: false as const,
    },
  },
  createdAt: "2026-09-01T03:00:00.000Z",
  expiresAt: "2026-09-01T03:01:00.000Z",
  approvedAt: null,
  ownerGeneration: 3,
  connectionGeneration: 5,
  receipt: null,
};

describe("extension annotation lifecycle control transport", () => {
  test("strictly parses an exact owner-bound operation view", () => {
    expect(parseAnnotationLifecycleOperationView({ record, reference })).toEqual({
      record,
      reference,
    });
    expect(parseAnnotationLifecycleOperationView({
      record: { ...record, approvedAt: undefined },
      reference,
    })).toBeNull();
    expect(parseAnnotationLifecycleOperationView({ record, reference, extra: true })).toBeNull();
  });

  test("polls, claims, rejects, and finalizes only exact bearer-bound routes", async () => {
    const approval = {
      approvedAt: "2026-09-01T03:00:10.000Z",
      expiresAt: record.expiresAt,
    };
    const blockedReceipt = {
      schemaVersion: ANNOTATION_LIFECYCLE_CONTROL_SCHEMA_VERSION,
      kind: "ui-attach.annotation-lifecycle-operation-receipt" as const,
      operationId: reference.operationId,
      fingerprint: reference.fingerprint,
      receiptId: "receipt-blocked",
      status: "blocked" as const,
      observedAt: "2026-09-01T03:00:20.000Z",
      resultingState: null,
      readbackAuthority: "current_snapshot" as const,
      executionAuthority: {
        grantedByCapture: false as const,
        browserControl: false as const,
        liveDomMutation: false as const,
      },
    };
    const fetch = vi.fn<typeof globalThis.fetch>();
    fetch
      .mockResolvedValueOnce(jsonResponse({
        schemaVersion: "0.1.0",
        kind: "ui-attach.annotation-lifecycle-control-authority",
        ok: true,
        data: { ownerGeneration: 2, connectionGeneration: 3 },
      }))
      .mockResolvedValueOnce(jsonResponse({
        schemaVersion: "0.1.0",
        kind: "ui-attach.annotation-lifecycle-operation-delivery",
        ok: true,
        data: { record, reference },
      }))
      .mockResolvedValueOnce(jsonResponse({
        schemaVersion: "0.1.0",
        kind: "ui-attach.annotation-lifecycle-operation-claimed",
        ok: true,
        data: {
          record: {
            ...record,
            phase: "executing",
            approvedAt: approval.approvedAt,
            status: {
              ...record.status,
              status: "applying",
              observedAt: approval.approvedAt,
            },
          },
          reference,
          approval,
        },
      }))
      .mockResolvedValueOnce(jsonResponse({
        schemaVersion: "0.1.0",
        kind: "ui-attach.annotation-lifecycle-operation-rejected",
        ok: true,
        data: {
          record: {
            ...record,
            phase: "rejected",
            status: {
              ...record.status,
              status: "rejected",
              observedAt: "2026-09-01T03:00:10.000Z",
              receiptId: `mailbox-rejected-${reference.fingerprint.slice(0, 16)}`,
            },
          },
          reference,
        },
      }))
      .mockResolvedValueOnce(jsonResponse({
        schemaVersion: "0.1.0",
        kind: "ui-attach.annotation-lifecycle-operation-finalized",
        ok: true,
        data: {
          record: {
            ...record,
            phase: "blocked",
            approvedAt: approval.approvedAt,
            status: {
              ...record.status,
              status: "blocked",
              observedAt: blockedReceipt.observedAt,
              receiptId: blockedReceipt.receiptId,
            },
            receipt: blockedReceipt,
          },
          reference,
        },
      }));
    const transport = createAnnotationLifecycleControlTransport({ fetch });
    const token = "CwsLCwsLCwsLCwsLCwsLCwsLCwsLCwsLCwsLCwsLCws";
    expect(await transport.readAuthority(token)).toEqual({
      ownerGeneration: 2,
      connectionGeneration: 3,
    });
    expect(await transport.readNext(token)).toMatchObject({ record: { phase: "awaiting_user" } });
    expect(await transport.claim(token, reference)).toMatchObject({
      record: { phase: "executing" },
      approval: { expiresAt: record.expiresAt },
    });
    expect(await transport.reject(token, reference)).toMatchObject({ record: { phase: "rejected" } });
    await transport.finalize(token, reference, approval, blockedReceipt);
    expect(fetch.mock.calls.map(([url, init]) => [String(url), init?.method ?? "GET"])).toEqual([
      ["http://127.0.0.1:38471/v1/annotation-lifecycle/authority", "GET"],
      ["http://127.0.0.1:38471/v1/annotation-lifecycle/proposals", "GET"],
      [`http://127.0.0.1:38471/v1/annotation-lifecycle/proposals/${reference.operationId}/claim`, "POST"],
      [`http://127.0.0.1:38471/v1/annotation-lifecycle/proposals/${reference.operationId}/reject`, "POST"],
      [`http://127.0.0.1:38471/v1/annotation-lifecycle/proposals/${reference.operationId}/result`, "POST"],
    ]);
    for (const [, init] of fetch.mock.calls) {
      expect((init?.headers as Record<string, string>).authorization).toBe(`Bearer ${token}`);
    }
  });
});

function jsonResponse(value: unknown): Response {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}
