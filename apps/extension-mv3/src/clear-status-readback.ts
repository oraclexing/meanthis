import {
  parseCaptureClearOperation,
  type CaptureClearOperationV1,
} from "./clear-operation";
import {
  parseClearProjectionJournal,
  type ClearProjectionAuthorityReference,
  type ClearProjectionOperation,
} from "./clear-projection-store";
import type {
  ActiveSessionReadback,
  StoredOriginSessionSummary,
} from "./session-store";

export interface AuthoritativeClearOperation {
  operationId: string;
  origins: string[];
  authority: ClearProjectionAuthorityReference | null;
  canonical: CaptureClearOperationV1 | null;
  projection: ClearProjectionOperation | null;
}

export interface AuthoritativeClearSnapshot {
  operations: AuthoritativeClearOperation[];
}

export interface AuthoritativeClearPair {
  clearPending: boolean;
  activeClearOperationId: string | null;
}

export type AuthoritativeClearStatusResult<T> =
  | { ok: true; value: T }
  | {
      ok: false;
      code: "SOURCE_FAILURE" | "CONFLICT" | "UNSTABLE_SNAPSHOT";
      message: string;
    };

export interface ClearStatusSourceResult<T> {
  ok: boolean;
  value?: T;
}

export function combineAuthoritativeClearSnapshot(
  canonicalOperations: readonly CaptureClearOperationV1[],
  projectionOperations: readonly ClearProjectionOperation[],
): AuthoritativeClearStatusResult<AuthoritativeClearSnapshot> {
  try {
    return combineValidatedAuthoritativeClearSnapshot(canonicalOperations, projectionOperations);
  } catch {
    return conflict("Clear authority source values could not be inspected safely.");
  }
}

function combineValidatedAuthoritativeClearSnapshot(
  canonicalValues: readonly CaptureClearOperationV1[],
  projectionValues: readonly ClearProjectionOperation[],
): AuthoritativeClearStatusResult<AuthoritativeClearSnapshot> {
  if (!Array.isArray(canonicalValues) || !Array.isArray(projectionValues)) {
    return conflict("Clear authority sources must be operation arrays.");
  }
  const canonicalOperations: CaptureClearOperationV1[] = [];
  for (const value of canonicalValues) {
    const parsed = parseCaptureClearOperation(value);
    if (!parsed) return conflict("Canonical clear authority contains an invalid operation.");
    canonicalOperations.push(parsed);
  }
  const projectionJournal = parseClearProjectionJournal({
    version: 1,
    operations: projectionValues,
  });
  if (!projectionJournal) {
    return conflict("Projection clear authority contains an invalid operation.");
  }
  const projectionOperations = projectionJournal.operations;
  const canonicalById = uniqueOperationsById(canonicalOperations);
  const projectionById = uniqueOperationsById(projectionOperations);
  if (!canonicalById || !projectionById) {
    return conflict("A clear operation ID is duplicated within an authority source.");
  }

  const operationIds = [...new Set([
    ...canonicalById.keys(),
    ...projectionById.keys(),
  ])].sort(ordinalCompare);
  const operations: AuthoritativeClearOperation[] = [];
  const operationIdByOrigin = new Map<string, string>();
  const operationIdByAuthority = new Map<string, string>();

  for (const operationId of operationIds) {
    const canonical = canonicalById.get(operationId) ?? null;
    const projection = projectionById.get(operationId) ?? null;
    const canonicalOrigins = canonical?.origins.map((entry) => entry.origin) ?? null;
    const projectionOrigins = projection?.requestedOrigins ?? null;
    if (canonicalOrigins && projectionOrigins &&
        !sameSortedStringSet(canonicalOrigins, projectionOrigins)) {
      return conflict(`Clear operation ${operationId} has conflicting origin ownership.`);
    }

    if (canonical && projection?.authority && (
      projection.authority.operationId !== canonical.operationId ||
      projection.authority.authorityId !== canonical.authorityId ||
      projection.authority.generation !== canonical.generation
    )) {
      return conflict(`Clear operation ${operationId} has conflicting authority IDs.`);
    }

    if (canonical && projection?.authority) {
      if (canonical.origins.some((entry) => entry.canonical === "pending")) {
        return conflict(`Clear operation ${operationId} bound projection authority too early.`);
      }
      const committed = canonical.origins
        .filter((entry) => entry.canonical === "committed")
        .map((entry) => ({ origin: entry.origin, originAfterEpoch: entry.afterEpoch }));
      if (!sameCommittedOrigins(committed, projection.origins)) {
        return conflict(`Clear operation ${operationId} has conflicting committed epochs.`);
      }
    }

    const origins = [...(canonicalOrigins ?? projectionOrigins ?? [])].sort(ordinalCompare);
    if (origins.length === 0) {
      return conflict(`Clear operation ${operationId} owns no origin.`);
    }
    for (const origin of origins) {
      const existingOperationId = operationIdByOrigin.get(origin);
      if (existingOperationId && existingOperationId !== operationId) {
        return conflict(`Origin ${origin} is owned by multiple clear operation IDs.`);
      }
      operationIdByOrigin.set(origin, operationId);
    }

    const authority = projection?.authority ?? (canonical
      ? {
          authorityId: canonical.authorityId,
          operationId: canonical.operationId,
          generation: canonical.generation,
        }
      : null);
    if (authority) {
      const authorityKey = `${authority.authorityId}\u0000${authority.generation}`;
      const existingOperationId = operationIdByAuthority.get(authorityKey);
      if (existingOperationId && existingOperationId !== operationId) {
        return conflict("A clear authority generation is bound to multiple operation IDs.");
      }
      operationIdByAuthority.set(authorityKey, operationId);
    }

    operations.push({
      operationId,
      origins,
      authority,
      canonical: canonical ? structuredClone(canonical) : null,
      projection: projection ? structuredClone(projection) : null,
    });
  }

  return { ok: true, value: { operations } };
}

export async function readStableAuthoritativeClearSnapshot(options: {
  readCanonical(): Promise<ClearStatusSourceResult<readonly CaptureClearOperationV1[]>>;
  readProjection(): Promise<ClearStatusSourceResult<readonly ClearProjectionOperation[]>>;
  maxAttempts?: number;
}): Promise<AuthoritativeClearStatusResult<AuthoritativeClearSnapshot>> {
  const maxAttempts = options.maxAttempts ?? 3;
  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    const canonicalBefore = await safeRead(options.readCanonical);
    if (!canonicalBefore.ok || !canonicalBefore.value) return sourceFailure("canonical");
    const projectionBefore = await safeRead(options.readProjection);
    if (!projectionBefore.ok || !projectionBefore.value) return sourceFailure("projection");
    const canonicalAfter = await safeRead(options.readCanonical);
    if (!canonicalAfter.ok || !canonicalAfter.value) return sourceFailure("canonical");
    const projectionAfter = await safeRead(options.readProjection);
    if (!projectionAfter.ok || !projectionAfter.value) return sourceFailure("projection");

    try {
      if (sameStructuralSnapshot(canonicalBefore.value, canonicalAfter.value) &&
          sameStructuralSnapshot(projectionBefore.value, projectionAfter.value)) {
        return combineAuthoritativeClearSnapshot(canonicalAfter.value, projectionAfter.value);
      }
    } catch {
      return sourceFailure("canonical");
    }
  }
  return {
    ok: false,
    code: "UNSTABLE_SNAPSHOT",
    message: "Clear authority changed throughout the read window.",
  };
}

export function authoritativeClearPairForOrigin(
  snapshot: AuthoritativeClearSnapshot,
  origin: string,
): AuthoritativeClearPair {
  const operation = snapshot.operations.find((candidate) => candidate.origins.includes(origin));
  return operation
    ? { clearPending: true, activeClearOperationId: operation.operationId }
    : { clearPending: false, activeClearOperationId: null };
}

export function projectAuthoritativeClearReadback(
  readback: ActiveSessionReadback,
  snapshot: AuthoritativeClearSnapshot,
): ActiveSessionReadback {
  return {
    ...readback,
    ...authoritativeClearPairForOrigin(snapshot, readback.origin),
  };
}

export function projectAuthoritativeStoredSessions(
  summaries: readonly StoredOriginSessionSummary[],
  snapshot: AuthoritativeClearSnapshot,
): StoredOriginSessionSummary[] {
  const projected = new Map(summaries.map((summary) => [
    summary.origin,
    {
      ...summary,
      ...authoritativeClearPairForOrigin(snapshot, summary.origin),
    },
  ]));
  for (const operation of snapshot.operations) {
    for (const origin of operation.origins) {
      if (projected.has(origin)) continue;
      projected.set(origin, {
        origin,
        epoch: projectedEpoch(operation, origin),
        attachmentCount: null,
        state: "needs_cleanup",
        clearPending: true,
        activeClearOperationId: operation.operationId,
      });
    }
  }
  return [...projected.values()].sort((left, right) => ordinalCompare(left.origin, right.origin));
}

function projectedEpoch(operation: AuthoritativeClearOperation, origin: string): string | null {
  const committed = operation.projection?.origins.find((entry) => entry.origin === origin);
  if (committed) return committed.originAfterEpoch;
  const canonical = operation.canonical?.origins.find((entry) => entry.origin === origin);
  if (!canonical) return null;
  return canonical.canonical === "committed" ? canonical.afterEpoch : canonical.beforeEpoch;
}

function uniqueOperationsById<T extends { operationId: string }>(
  operations: readonly T[],
): Map<string, T> | null {
  const byId = new Map<string, T>();
  for (const operation of operations) {
    if (byId.has(operation.operationId)) return null;
    byId.set(operation.operationId, operation);
  }
  return byId;
}

function sameSortedStringSet(left: readonly string[], right: readonly string[]): boolean {
  if (left.length !== right.length) return false;
  const sortedLeft = [...left].sort(ordinalCompare);
  const sortedRight = [...right].sort(ordinalCompare);
  return sortedLeft.every((value, index) => value === sortedRight[index]);
}

function sameCommittedOrigins(
  left: readonly { origin: string; originAfterEpoch: string }[],
  right: readonly { origin: string; originAfterEpoch: string }[],
): boolean {
  if (left.length !== right.length) return false;
  const key = (entry: { origin: string; originAfterEpoch: string }) =>
    `${entry.origin}\u0000${entry.originAfterEpoch}`;
  const rightKeys = right.map(key).sort(ordinalCompare);
  return left.map(key).sort(ordinalCompare).every((value, index) =>
    value === rightKeys[index]
  );
}

async function safeRead<T>(
  read: () => Promise<ClearStatusSourceResult<T>>,
): Promise<ClearStatusSourceResult<T>> {
  try {
    const result = await read();
    if (!result.ok || result.value === undefined) return result;
    const value = structuredClone(result.value);
    JSON.stringify(value);
    return { ok: true, value };
  } catch {
    return { ok: false };
  }
}

function sameStructuralSnapshot(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function sourceFailure(source: "canonical" | "projection"): AuthoritativeClearStatusResult<never> {
  return {
    ok: false,
    code: "SOURCE_FAILURE",
    message: `The ${source} clear authority could not be read.`,
  };
}

function conflict(message: string): AuthoritativeClearStatusResult<never> {
  return { ok: false, code: "CONFLICT", message };
}

function ordinalCompare(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
