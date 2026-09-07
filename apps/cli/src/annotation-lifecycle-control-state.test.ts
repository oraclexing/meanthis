import { readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import {
  ANNOTATION_LIFECYCLE_CONTROL_SCHEMA_VERSION,
  ANNOTATION_LIFECYCLE_OPERATION_PROPOSAL_KIND,
  ANNOTATION_LIFECYCLE_OPERATION_RECEIPT_KIND,
} from "@meanthis/schema";
import { createAnnotationLifecycleControlState } from "./annotation-lifecycle-control-state";

const NOW = Date.parse("2026-09-01T02:00:00.000Z");
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
const binding = {
  ownerGeneration: 3, connectionGeneration: 5,
  instanceId: proposal.instanceId, captureId: proposal.captureId,
  sequence: proposal.expectedSequence, annotationId: proposal.annotationId,
  state: proposal.expectedState,
};

function fixture(options: { ttlMs?: number; maxOperations?: number } = {}) {
  let time = NOW;
  const state = createAnnotationLifecycleControlState({ ownerGeneration: 3, connectionGeneration: 5, now: () => time, ...options });
  const submitted = state.submit(proposal, binding);
  if (!submitted.ok) throw new Error(submitted.code);
  const reference = { operationId: proposal.operationId, fingerprint: submitted.record.fingerprint, ownerGeneration: 3, connectionGeneration: 5 };
  const approval = { approvedAt: "2026-09-01T02:00:10.000Z", expiresAt: submitted.record.expiresAt };
  return { state, submitted, reference, approval, setTime: (value: number) => { time = value; } };
}

function receipt(fingerprint: string, status: "succeeded" | "rejected" | "expired" | "blocked" | "failed" = "succeeded") {
  return {
    schemaVersion: ANNOTATION_LIFECYCLE_CONTROL_SCHEMA_VERSION,
    kind: ANNOTATION_LIFECYCLE_OPERATION_RECEIPT_KIND,
    operationId: proposal.operationId,
    fingerprint,
    receiptId: `receipt-${status}`,
    status,
    observedAt: "2026-09-01T02:00:20.000Z",
    resultingState: status === "succeeded" ? proposal.nextState : null,
    readbackAuthority: status === "succeeded" ? "durable_ledger" as const : "current_snapshot" as const,
    executionAuthority: { grantedByCapture: false, browserControl: false, liveDomMutation: false },
  };
}

function execute(f: ReturnType<typeof fixture>) {
  f.setTime(NOW + 10_000);
  expect(f.state.approve(f.reference, f.approval).ok).toBe(true);
  f.setTime(NOW + 20_000);
  expect(f.state.markExecuting(f.reference, f.approval).ok).toBe(true);
}

describe("dormant annotation lifecycle owner mailbox", () => {
  test("moves awaiting_user -> approved -> executing -> applied with exact all-false records", () => {
    const f = fixture();
    expect(f.submitted.record).toMatchObject({
      phase: "awaiting_user", createdAt: "2026-09-01T02:00:00.000Z",
      expiresAt: "2026-09-01T02:01:00.000Z", approvedAt: null,
      ownerGeneration: 3, connectionGeneration: 5,
      status: { status: "pending", receiptId: null, resultingState: null,
        executionAuthority: { grantedByCapture: false, browserControl: false, liveDomMutation: false } },
    });
    f.setTime(NOW + 10_000);
    const approved = f.state.approve(f.reference, f.approval);
    expect(approved.ok && approved.record.phase).toBe("approved");
    f.setTime(NOW + 20_000);
    const executing = f.state.markExecuting(f.reference, f.approval);
    expect(executing.ok && executing.record.phase).toBe("executing");
    const applied = f.state.finalize(f.reference, f.approval, receipt(f.reference.fingerprint));
    expect(applied.ok && applied.record).toMatchObject({
      phase: "applied",
      status: { status: "succeeded", receiptId: "receipt-succeeded", resultingState: "resolved" },
    });
  });

  test("lists only active records in creation order and lets the user reject before execution", () => {
    const f = fixture();
    expect(f.state.listActive()).toEqual([f.submitted.record]);
    f.setTime(NOW + 10_000);
    const rejected = f.state.reject(f.reference, "2026-09-01T02:00:10.000Z");
    expect(rejected.ok && rejected.record).toMatchObject({
      phase: "rejected",
      status: {
        status: "rejected",
        resultingState: null,
        receiptId: expect.stringMatching(/^mailbox-rejected-/),
      },
    });
    expect(f.state.listActive()).toEqual([]);
    const replay = f.state.reject(f.reference, "2026-09-01T02:00:10.000Z");
    expect(replay.ok && replay.idempotent).toBe(true);
    if (rejected.ok && replay.ok) expect(replay.record).toBe(rejected.record);
  });

  test("keeps object identity and timestamps for exact proposal, approval, and terminal replays", () => {
    const f = fixture();
    const submitReplay = f.state.submit(structuredClone(proposal), structuredClone(binding));
    expect(submitReplay.ok && submitReplay.idempotent).toBe(true);
    if (submitReplay.ok) expect(submitReplay.record).toBe(f.submitted.record);
    f.setTime(NOW + 10_000);
    const approved = f.state.approve(f.reference, f.approval);
    const approvedReplay = f.state.approve(structuredClone(f.reference), structuredClone(f.approval));
    expect(approved.ok && approvedReplay.ok && approvedReplay.idempotent).toBe(true);
    if (approved.ok && approvedReplay.ok) expect(approvedReplay.record).toBe(approved.record);
    f.setTime(NOW + 20_000);
    expect(f.state.markExecuting(f.reference, f.approval).ok).toBe(true);
    const terminalReceipt = receipt(f.reference.fingerprint);
    const terminal = f.state.finalize(f.reference, f.approval, terminalReceipt);
    const replay = f.state.finalize(structuredClone(f.reference), structuredClone(f.approval), structuredClone(terminalReceipt));
    expect(terminal.ok && replay.ok && replay.idempotent).toBe(true);
    if (terminal.ok && replay.ok) expect(replay.record).toBe(terminal.record);
    expect(f.state.finalize(f.reference, f.approval, {
      ...terminalReceipt,
      readbackAuthority: "current_snapshot",
    })).toEqual({ ok: false, code: "TERMINAL_CONFLICT" });
  });

  test("replays an accepted operation after live sequence/state drift without creating work", () => {
    const f = fixture();
    const replay = f.state.submit(structuredClone(proposal), {
      ...structuredClone(binding),
      sequence: binding.sequence + 9,
      state: "resolved",
    });
    expect(replay.ok && replay.idempotent).toBe(true);
    if (replay.ok) expect(replay.record).toBe(f.submitted.record);
    expect(f.state.size).toBe(1);

    expect(f.state.submit(structuredClone(proposal), {
      ...structuredClone(binding),
      ownerGeneration: binding.ownerGeneration + 1,
    })).toEqual({ ok: false, code: "OWNER_GENERATION_MISMATCH" });
  });

  test("rejects reused operation ids and every imprecise transition binding", () => {
    const f = fixture();
    expect(f.state.submit({ ...proposal, expectedSequence: 8 }, { ...binding, sequence: 8 }))
      .toEqual({ ok: false, code: "OPERATION_ID_CONFLICT" });
    expect(f.state.read({ ...f.reference, fingerprint: "0".repeat(64) }))
      .toEqual({ ok: false, code: "FINGERPRINT_MISMATCH" });
    expect(f.state.read({ ...f.reference, ownerGeneration: 4 }))
      .toEqual({ ok: false, code: "OWNER_GENERATION_MISMATCH" });
    f.setTime(NOW + 10_000);
    expect(f.state.approve(f.reference, { ...f.approval, approvedAt: "2026-09-01T02:00:09.999Z" }))
      .toEqual({ ok: false, code: "APPROVAL_MISMATCH" });
    expect(f.state.approve(f.reference, f.approval).ok).toBe(true);
    f.setTime(NOW + 20_000);
    expect(f.state.markExecuting(f.reference, f.approval).ok).toBe(true);
    expect(f.state.finalize(f.reference, f.approval, { ...receipt(f.reference.fingerprint), resultingState: "open" }))
      .toEqual({ ok: false, code: "RECEIPT_MISMATCH" });
    expect(f.state.finalize(f.reference, f.approval, {
      ...receipt(f.reference.fingerprint),
      observedAt: "2026-09-01T02:00:19.999Z",
    })).toEqual({ ok: false, code: "RECEIPT_MISMATCH" });
    expect(f.state.finalize(f.reference, f.approval, {
      ...receipt(f.reference.fingerprint),
      observedAt: "2026-09-01T02:01:00.000Z",
    })).toEqual({ ok: false, code: "RECEIPT_MISMATCH" });
    expect(f.state.finalize(f.reference, f.approval, {
      ...receipt(f.reference.fingerprint),
      observedAt: "2026-09-01T02:00:20.001Z",
    })).toEqual({ ok: false, code: "RECEIPT_MISMATCH" });
    const exact = receipt(f.reference.fingerprint);
    expect(f.state.finalize(f.reference, f.approval, exact).ok).toBe(true);
    expect(f.state.finalize(f.reference, f.approval, { ...exact, receiptId: "receipt-conflict" }))
      .toEqual({ ok: false, code: "TERMINAL_CONFLICT" });
  });

  test.each([
    ["missing", (value: Record<string, unknown>) => { delete value.readbackAuthority; }],
    ["unknown", (value: Record<string, unknown>) => { value.readbackAuthority = "snapshot"; }],
    ["durable authority on a non-success receipt", (value: Record<string, unknown>) => {
      value.readbackAuthority = "durable_ledger";
    }],
  ] as const)("fails closed for %s receipt authority", (_label, mutate) => {
    const f = fixture();
    execute(f);
    const candidate = receipt(f.reference.fingerprint, "failed") as Record<string, unknown>;
    mutate(candidate);
    expect(f.state.finalize(f.reference, f.approval, candidate)).toEqual({
      ok: false,
      code: "INVALID_RECEIPT",
    });
    expect(f.state.read(f.reference).record).toMatchObject({ phase: "executing" });
  });

  test.each([
    ["rejected", "rejected"], ["expired", "expired"],
    ["blocked", "blocked"], ["failed", "unknown"],
  ] as const)("maps %s receipts to the strict %s terminal", (receiptStatus, phase) => {
    const f = fixture();
    execute(f);
    const result = f.state.finalize(f.reference, f.approval, receipt(f.reference.fingerprint, receiptStatus));
    expect(result.ok && result.record.phase).toBe(phase);
    if (result.ok) {
      expect(result.record.status.status).toBe(receiptStatus);
      expect(result.record.status.resultingState).toBeNull();
    }
  });

  test("expires every active phase at >= so a lost executor cannot block the queue", () => {
    const pending = fixture({ ttlMs: 1_000 });
    pending.setTime(NOW + 1_000);
    const expired = pending.state.read(pending.reference);
    expect(expired.ok && expired.record.phase).toBe("expired");
    if (expired.ok) expect(pending.state.submit(proposal, binding)).toEqual({ ok: true, idempotent: true, record: expired.record });

    const executing = fixture({ ttlMs: 1_000 });
    const exactApproval = { approvedAt: "2026-09-01T02:00:00.500Z", expiresAt: executing.submitted.record.expiresAt };
    executing.setTime(NOW + 500);
    expect(executing.state.approve(executing.reference, exactApproval).ok).toBe(true);
    executing.setTime(NOW + 999);
    expect(executing.state.markExecuting(executing.reference, exactApproval).ok).toBe(true);
    executing.setTime(NOW + 60_000);
    const expiredExecution = executing.state.read(executing.reference);
    expect(expiredExecution.ok && expiredExecution.record.phase).toBe("expired");
    expect(executing.state.listActive()).toEqual([]);
    expect(executing.state.finalize(
      executing.reference,
      exactApproval,
      receipt(executing.reference.fingerprint),
    )).toEqual({ ok: false, code: "TERMINAL_CONFLICT" });

    const committedBeforeExpiry = {
      ...receipt(executing.reference.fingerprint),
      observedAt: "2026-09-01T02:00:00.999Z",
    };
    const reconciled = executing.state.finalize(
      executing.reference,
      exactApproval,
      committedBeforeExpiry,
    );
    expect(reconciled.ok && reconciled.record).toMatchObject({
      phase: "applied",
      status: {
        status: "succeeded",
        observedAt: committedBeforeExpiry.observedAt,
        resultingState: "resolved",
      },
      receipt: committedBeforeExpiry,
    });
  });

  test.each([
    ["rejected", "rejected"],
    ["expired", "expired"],
    ["blocked", "blocked"],
    ["failed", "unknown"],
  ] as const)("reconciles an exact pre-expiry %s receipt after executing expires", (status, phase) => {
    const f = fixture({ ttlMs: 1_000 });
    const exactApproval = {
      approvedAt: "2026-09-01T02:00:00.500Z",
      expiresAt: f.submitted.record.expiresAt,
    };
    f.setTime(NOW + 500);
    expect(f.state.approve(f.reference, exactApproval).ok).toBe(true);
    f.setTime(NOW + 999);
    expect(f.state.markExecuting(f.reference, exactApproval).ok).toBe(true);
    f.setTime(NOW + 1_000);
    expect(f.state.read(f.reference).record).toMatchObject({ phase: "expired" });

    const receiptBeforeExpiry = {
      ...receipt(f.reference.fingerprint, status),
      observedAt: "2026-09-01T02:00:00.999Z",
    };
    const reconciled = f.state.finalize(
      f.reference,
      exactApproval,
      receiptBeforeExpiry,
    );
    expect(reconciled.ok && reconciled.record).toMatchObject({
      phase,
      status: {
        status,
        observedAt: receiptBeforeExpiry.observedAt,
        resultingState: null,
      },
      receipt: receiptBeforeExpiry,
    });
  });

  test.each([
    ["before execution", "2026-09-01T02:00:00.998Z"],
    ["at expiry", "2026-09-01T02:00:01.000Z"],
    ["after expiry", "2026-09-01T02:00:01.001Z"],
  ] as const)("rejects expired executing receipt observedAt %s", (_label, observedAt) => {
    const f = fixture({ ttlMs: 1_000 });
    const exactApproval = {
      approvedAt: "2026-09-01T02:00:00.500Z",
      expiresAt: f.submitted.record.expiresAt,
    };
    f.setTime(NOW + 500);
    expect(f.state.approve(f.reference, exactApproval).ok).toBe(true);
    f.setTime(NOW + 999);
    expect(f.state.markExecuting(f.reference, exactApproval).ok).toBe(true);
    f.setTime(NOW + 1_000);
    expect(f.state.read(f.reference).record).toMatchObject({ phase: "expired" });

    expect(f.state.finalize(f.reference, exactApproval, {
      ...receipt(f.reference.fingerprint, "failed"),
      observedAt,
    })).toEqual({ ok: false, code: "TERMINAL_CONFLICT" });
    expect(f.state.read(f.reference).record).toMatchObject({ phase: "expired" });
  });

  test("rotation stales nonterminals and preserves exact terminal replay", () => {
    const pending = fixture();
    pending.state.rotateGenerations({ ownerGeneration: 4, connectionGeneration: 6 });
    expect(pending.state.read(pending.reference).record).toMatchObject({ phase: "stale", ownerGeneration: 3 });
    const complete = fixture();
    execute(complete);
    const rejectedReceipt = receipt(complete.reference.fingerprint, "rejected");
    const terminal = complete.state.finalize(complete.reference, complete.approval, rejectedReceipt);
    complete.state.rotateGenerations({ ownerGeneration: 4, connectionGeneration: 6 });
    const replay = complete.state.finalize(complete.reference, complete.approval, rejectedReceipt);
    expect(terminal.ok && replay.ok && replay.idempotent).toBe(true);
    if (terminal.ok && replay.ok) expect(replay.record).toBe(terminal.record);
  });

  test("fails closed at capacity without evicting executing or terminal records", () => {
    const f = fixture({ maxOperations: 1 });
    execute(f);
    const second = { ...proposal, operationId: "22222222-2222-4222-8222-222222222222", annotationId: "annotation_02" };
    expect(f.state.submit(second, { ...binding, annotationId: "annotation_02" }))
      .toEqual({ ok: false, code: "CAPACITY_EXCEEDED" });
    expect(f.state.read(f.reference).record).toMatchObject({ phase: "executing" });
    expect(f.state.finalize(f.reference, f.approval, receipt(f.reference.fingerprint)).ok).toBe(true);
    expect(f.state.submit(second, { ...binding, annotationId: "annotation_02" }))
      .toEqual({ ok: false, code: "CAPACITY_EXCEEDED" });
  });

  test("rejects getters, own undefined, null, and extra keys without invoking accessors", () => {
    const f = fixture();
    let getterCalls = 0;
    const accessor = { ...f.reference } as Record<string, unknown>;
    Object.defineProperty(accessor, "fingerprint", { enumerable: true, get() { getterCalls += 1; return f.reference.fingerprint; } });
    expect(f.state.read(accessor)).toEqual({ ok: false, code: "INVALID_REFERENCE" });
    expect(getterCalls).toBe(0);
    expect(f.state.read({ ...f.reference, fingerprint: undefined })).toEqual({ ok: false, code: "INVALID_REFERENCE" });
    expect(f.state.read({ ...f.reference, extra: true })).toEqual({ ok: false, code: "INVALID_REFERENCE" });
    expect(f.state.approve(f.reference, null)).toEqual({ ok: false, code: "INVALID_APPROVAL" });
    execute(f);
    const badReceipt = receipt(f.reference.fingerprint);
    let nestedCalls = 0;
    Object.defineProperty(badReceipt.executionAuthority, "browserControl", { enumerable: true, get() { nestedCalls += 1; return false; } });
    expect(f.state.finalize(f.reference, f.approval, badReceipt)).toEqual({ ok: false, code: "INVALID_RECEIPT" });
    expect(nestedCalls).toBe(0);
  });

  test("grants no browser, DOM, source, or cloud API", () => {
    const repositoryRoot = join(import.meta.dirname, "..", "..", "..");
    expect(collectTs([join(repositoryRoot, "apps", "cli", "src")])).toContain(
      join(repositoryRoot, "apps", "cli", "src", "annotation-lifecycle-control-state.ts"),
    );
    const f = fixture();
    const api = f.state as unknown as Record<string, unknown>;
    expect(Object.keys(api).sort()).toEqual([
      "approve", "approveCurrent", "finalize", "listActive", "markExecuting", "read", "reject",
      "rejectCurrent",
      "rotateGenerations", "size", "submit",
    ]);
    expect(api.browserControl).toBeUndefined();
    expect(api.domMutation).toBeUndefined();
    expect(api.sourceWrite).toBeUndefined();
    expect(api.cloudPublish).toBeUndefined();
  });
});

function collectTs(roots: string[]): string[] {
  const files: string[] = [];
  const visit = (directory: string) => readdirSync(directory, { withFileTypes: true }).forEach((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) visit(path);
    else if (entry.isFile() && entry.name.endsWith(".ts")) files.push(path);
  });
  roots.forEach(visit);
  return files;
}
