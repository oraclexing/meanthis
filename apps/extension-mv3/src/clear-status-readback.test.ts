import { describe, expect, test, vi } from "vitest";
import type { CaptureClearOperationV1 } from "./clear-operation";
import type { ClearProjectionOperation } from "./clear-projection-store";
import {
  authoritativeClearPairForOrigin,
  combineAuthoritativeClearSnapshot,
  projectAuthoritativeClearReadback,
  projectAuthoritativeStoredSessions,
  readStableAuthoritativeClearSnapshot,
} from "./clear-status-readback";

const ORIGIN = "https://app.example.test";
const OPERATION_ID = "clear-1";
const AUTHORITY = {
  authorityId: "authority-1",
  operationId: OPERATION_ID,
  generation: 1,
};

describe("authoritative clear status readback", () => {
  test.each([
    ["journal only", [], [projectionOperation()], true],
    ["canonical only", [canonicalOperation()], [], true],
    ["both", [canonicalOperation()], [projectionOperation()], true],
    ["idle", [], [], false],
  ] as const)("combines %s", (_name, canonical, projection, pending) => {
    const combined = combineAuthoritativeClearSnapshot(canonical, projection);
    expect(combined).toMatchObject({ ok: true });
    if (!combined.ok) throw new Error(combined.message);
    expect(authoritativeClearPairForOrigin(combined.value, ORIGIN)).toEqual({
      clearPending: pending,
      activeClearOperationId: pending ? OPERATION_ID : null,
    });
  });

  test("fails closed on operation-ID, origin-owner, and authority conflicts", () => {
    expect(combineAuthoritativeClearSnapshot(
      [canonicalOperation()],
      [projectionOperation({ authority: { ...AUTHORITY, authorityId: "other" } })],
    )).toMatchObject({ ok: false, code: "CONFLICT" });
    expect(combineAuthoritativeClearSnapshot(
      [canonicalOperation()],
      [projectionOperation({ requestedOrigins: ["https://other.example.test"] })],
    )).toMatchObject({ ok: false, code: "CONFLICT" });
    expect(combineAuthoritativeClearSnapshot(
      [canonicalOperation()],
      [projectionOperation({ operationId: "clear-2", authority: null })],
    )).toMatchObject({ ok: false, code: "CONFLICT" });
  });

  test("fails closed when either source faults", async () => {
    await expect(readStableAuthoritativeClearSnapshot({
      readCanonical: vi.fn(async () => ({ ok: false })),
      readProjection: vi.fn(async () => ({ ok: true, value: [] })),
    })).resolves.toMatchObject({ ok: false, code: "SOURCE_FAILURE" });
    await expect(readStableAuthoritativeClearSnapshot({
      readCanonical: vi.fn(async () => ({ ok: true, value: [] })),
      readProjection: vi.fn(async () => ({ ok: false })),
    })).resolves.toMatchObject({ ok: false, code: "SOURCE_FAILURE" });
    await expect(readStableAuthoritativeClearSnapshot({
      readCanonical: vi.fn(async () => { throw new Error("read failed"); }),
      readProjection: vi.fn(async () => ({ ok: true, value: [] })),
    })).resolves.toMatchObject({ ok: false, code: "SOURCE_FAILURE" });
  });

  test("retries a changing sandwich instead of accepting one accidental empty snapshot", async () => {
    const canonicalReads = [[], [canonicalOperation()], [canonicalOperation()], [canonicalOperation()]];
    const projectionReads = [[], [projectionOperation()], [projectionOperation()], [projectionOperation()]];
    const result = await readStableAuthoritativeClearSnapshot({
      readCanonical: vi.fn(async () => ({ ok: true, value: canonicalReads.shift() ?? [] })),
      readProjection: vi.fn(async () => ({ ok: true, value: projectionReads.shift() ?? [] })),
    });
    expect(result).toMatchObject({ ok: true });
    if (!result.ok) throw new Error(result.message);
    expect(authoritativeClearPairForOrigin(result.value, ORIGIN)).toEqual({
      clearPending: true,
      activeClearOperationId: OPERATION_ID,
    });
  });

  test("projects one authoritative pair into active readback and stored summaries", () => {
    const combined = combineAuthoritativeClearSnapshot([], [projectionOperation()]);
    if (!combined.ok) throw new Error(combined.message);
    expect(projectAuthoritativeClearReadback({
      origin: ORIGIN,
      epoch: "after-1",
      clearPending: false,
      activeClearOperationId: null,
      file: null,
      legacyRecord: null,
    }, combined.value)).toMatchObject({
      clearPending: true,
      activeClearOperationId: OPERATION_ID,
    });
    expect(projectAuthoritativeStoredSessions([], combined.value)).toEqual([{
      origin: ORIGIN,
      epoch: "after-1",
      attachmentCount: null,
      state: "needs_cleanup",
      clearPending: true,
      activeClearOperationId: OPERATION_ID,
    }]);
  });

  test.each([
    ["missing operation id", [{ ...canonicalOperation(), operationId: undefined }], []],
    ["empty origin ownership", [{ ...canonicalOperation(), origins: [] }], []],
    ["duplicate canonical origins", [{
      ...canonicalOperation(),
      origins: [canonicalOperation().origins[0]!, canonicalOperation().origins[0]!],
    }], []],
    ["duplicate committed journal origins", [], [{
      ...projectionOperation(),
      origins: [projectionOperation().origins[0]!, projectionOperation().origins[0]!],
    }]],
    ["overbound journal origin", [], [{
      ...projectionOperation(),
      requestedOrigins: [ORIGIN],
      origins: [{ origin: "https://other.example.test", originAfterEpoch: "after-other" }],
    }]],
    ["bound too early", [{
      ...canonicalOperation(),
      phase: "prepared",
      origins: [{ ...canonicalOperation().origins[0]!, canonical: "pending" }],
    }], [projectionOperation()]],
    ["duplicate authority generation", [
      canonicalOperation(),
      canonicalOperation({
        operationId: "clear-2",
        origins: [{
          ...canonicalOperation().origins[0]!,
          origin: "https://other.example.test",
        }],
      }),
    ], []],
    ["committed epoch mismatch", [canonicalOperation()], [projectionOperation({
      origins: [{ origin: ORIGIN, originAfterEpoch: "different-after" }],
    })]],
  ])("fails closed on malformed source value: %s", (_name, canonical, projection) => {
    expect(combineAuthoritativeClearSnapshot(
      canonical as CaptureClearOperationV1[],
      projection as ClearProjectionOperation[],
    )).toMatchObject({ ok: false, code: "CONFLICT" });
  });

  test("fails closed when structural comparison or cloning throws", async () => {
    const cyclic: unknown[] = [];
    cyclic.push(cyclic);
    await expect(readStableAuthoritativeClearSnapshot({
      readCanonical: vi.fn(async () => ({ ok: true, value: cyclic as CaptureClearOperationV1[] })),
      readProjection: vi.fn(async () => ({ ok: true, value: [] })),
    })).resolves.toMatchObject({ ok: false, code: "SOURCE_FAILURE" });

    const source = canonicalOperation();
    const combined = combineAuthoritativeClearSnapshot([source], []);
    expect(combined).toMatchObject({ ok: true });
    if (!combined.ok) throw new Error(combined.message);
    combined.value.operations[0]!.canonical!.origins[0]!.afterEpoch = "mutated";
    expect(source.origins[0]!.afterEpoch).toBe("after-1");
  });
});

function canonicalOperation(
  overrides: Partial<CaptureClearOperationV1> = {},
): CaptureClearOperationV1 {
  return {
    version: 1,
    operationId: OPERATION_ID,
    authorityId: AUTHORITY.authorityId,
    generation: AUTHORITY.generation,
    phase: "canonical_committed",
    origins: [{
      origin: ORIGIN,
      beforeEpoch: "before-1",
      afterEpoch: "after-1",
      canonical: "committed",
    }],
    createdAt: "2026-08-18T00:00:00.000Z",
    updatedAt: "2026-08-18T00:00:00.000Z",
    ...overrides,
  };
}

function projectionOperation(
  overrides: Partial<ClearProjectionOperation> = {},
): ClearProjectionOperation {
  return {
    version: 1,
    operationId: OPERATION_ID,
    authority: AUTHORITY,
    request: null,
    requestedOrigins: [ORIGIN],
    origins: [{ origin: ORIGIN, originAfterEpoch: "after-1" }],
    subjectDiscovery: "complete",
    targets: [],
    ...overrides,
  };
}
