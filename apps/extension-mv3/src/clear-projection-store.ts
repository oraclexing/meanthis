import type { ExtensionStorageArea } from "./capture-store";
import { UI_ATTACH_EMPTY_APPLIED_ITEM_IDS_DIGEST } from "./messages";

export const CLEAR_PROJECTION_JOURNAL_STORAGE_KEY =
  "ui-attach:clear-projection-journal:v1";
export const CLEAR_PROJECTION_MAX_ACTIVE_OPERATIONS = 16;
export const CLEAR_PROJECTION_MAX_ORIGINS = 64;
export const CLEAR_PROJECTION_MAX_SUBJECTS = 128;
export const CLEAR_PROJECTION_MAX_REMOVED_ITEM_IDS = 26;

const CLEAR_PROJECTION_LOCK_NAME = CLEAR_PROJECTION_JOURNAL_STORAGE_KEY;
const CONTROL_CHARACTER_PATTERN = /[\u0000-\u001f\u007f]/u;
const MAX_ID_LENGTH = 128;
const MAX_DOCUMENT_ID_LENGTH = 256;
const MAX_PROJECTION_ID_LENGTH = 64;
const MAX_ORIGIN_LENGTH = 2_048;
const MAX_PATHNAME_LENGTH = 8_192;

export interface ClearProjectionAuthorityReference {
  authorityId: string;
  operationId: string;
  generation: number;
}

export interface ClearProjectionCommittedOrigin {
  origin: string;
  originAfterEpoch: string;
}

export interface ClearProjectionPrepareInput {
  operationId: string;
  requestedOrigins: string[];
  request: ClearProjectionRequest;
  targets?: ClearProjectionTargetInput[];
}

export interface ClearProjectionRequestOrigin {
  origin: string;
  beforeEpoch: string | null;
}

export type ClearProjectionBarrierScope = "live-page" | "active-origin";

export interface ClearProjectionRequest {
  nonce: string;
  endpoint: ClearProjectionSubject;
  origins: ClearProjectionRequestOrigin[];
  barrierScope?: ClearProjectionBarrierScope;
}

export type ClearProjectionSubjectDiscovery = "pending" | "complete";
export type ClearProjectionTargetState =
  | "pending"
  | "delivered"
  | "acknowledged"
  | "superseded";

export interface ClearProjectionSubject {
  tabId: number;
  frameId: number;
  documentId: string;
  origin: string;
  pathname: string;
}

export interface ClearProjectionTarget {
  subject: ClearProjectionSubject;
  removedItemIds: string[];
  projectionId: string;
  revision: number;
  state: ClearProjectionTargetState;
  attemptCount: number;
  nextAttemptAt: number;
}

export interface ClearProjectionOperation {
  version: 1;
  operationId: string;
  authority: ClearProjectionAuthorityReference | null;
  request: ClearProjectionRequest | null;
  requestedOrigins: string[];
  origins: ClearProjectionCommittedOrigin[];
  subjectDiscovery: ClearProjectionSubjectDiscovery;
  targets: ClearProjectionTarget[];
}

export interface ClearProjectionJournal {
  version: 1;
  operations: ClearProjectionOperation[];
}

export interface ClearProjectionTargetInput {
  subject: ClearProjectionSubject;
  removedItemIds: string[];
  projectionId: string;
  revision: number;
  nextAttemptAt: number;
}

export interface ClearProjectionTargetReference {
  subject: ClearProjectionSubject;
  projectionId: string;
  revision: number;
}

export interface ClearProjectionDeliveryInput extends ClearProjectionTargetReference {
  expectedAttemptCount: number;
  nextAttemptAt: number;
}

export interface ClearProjectionZeroMarkerReadback {
  appliedItemIds: [];
  markerCount: 0;
  selectionPreviewActive: false;
  digest: typeof UI_ATTACH_EMPTY_APPLIED_ITEM_IDS_DIGEST;
}

export interface ClearProjectionAcknowledgementInput extends ClearProjectionTargetReference {
  readback: ClearProjectionZeroMarkerReadback;
}

export interface ClearProjectionReplacementInput {
  previous: ClearProjectionTargetReference;
  target: ClearProjectionTargetInput;
}

export interface PendingClearProjection extends ClearProjectionTarget {
  authority: ClearProjectionAuthorityReference;
  originAfterEpoch: string;
}

export type ClearProjectionStoreErrorCode =
  | "INVALID_INPUT"
  | "INVALID_STORAGE"
  | "STORAGE_ERROR"
  | "LIMIT_EXCEEDED"
  | "CONFLICT"
  | "STALE_REFERENCE"
  | "OPERATION_NOT_FOUND"
  | "OPERATION_NOT_BOUND"
  | "TARGET_NOT_FOUND"
  | "INVALID_TRANSITION";

export type ClearProjectionStoreResult<T> =
  | { ok: true; value: T }
  | { ok: false; code: ClearProjectionStoreErrorCode; message: string };

export interface ClearProjectionStore {
  prepare(
    input: ClearProjectionPrepareInput,
    lease?: ClearProjectionOperationLease,
  ): Promise<ClearProjectionStoreResult<ClearProjectionOperation>>;
  commitOrigins(
    authority: ClearProjectionAuthorityReference,
    origins: ClearProjectionCommittedOrigin[],
    lease?: ClearProjectionOperationLease,
  ): Promise<ClearProjectionStoreResult<ClearProjectionOperation>>;
  completeSubjectDiscovery(
    authority: ClearProjectionAuthorityReference,
    lease?: ClearProjectionOperationLease,
  ): Promise<ClearProjectionStoreResult<ClearProjectionOperation>>;
  upsertTarget(
    authority: ClearProjectionAuthorityReference,
    target: ClearProjectionTargetInput,
    lease?: ClearProjectionOperationLease,
  ): Promise<ClearProjectionStoreResult<ClearProjectionTarget>>;
  markDelivered(
    authority: ClearProjectionAuthorityReference,
    delivery: ClearProjectionDeliveryInput,
    lease?: ClearProjectionOperationLease,
  ): Promise<ClearProjectionStoreResult<ClearProjectionTarget>>;
  acknowledge(
    authority: ClearProjectionAuthorityReference,
    acknowledgement: ClearProjectionAcknowledgementInput,
    lease?: ClearProjectionOperationLease,
  ): Promise<ClearProjectionStoreResult<ClearProjectionTarget>>;
  supersede(
    authority: ClearProjectionAuthorityReference,
    target: ClearProjectionTargetReference,
    lease?: ClearProjectionOperationLease,
  ): Promise<ClearProjectionStoreResult<ClearProjectionTarget>>;
  replaceTarget(
    authority: ClearProjectionAuthorityReference,
    replacement: ClearProjectionReplacementInput,
    lease?: ClearProjectionOperationLease,
  ): Promise<ClearProjectionStoreResult<ClearProjectionTarget>>;
  listOperations(): Promise<ClearProjectionStoreResult<ClearProjectionOperation[]>>;
  listPending(now: number): Promise<ClearProjectionStoreResult<PendingClearProjection[]>>;
  removeOperation(
    reference: ClearProjectionAuthorityReference | string,
    lease?: ClearProjectionOperationLease,
  ): Promise<ClearProjectionStoreResult<ClearProjectionOperation | null>>;
  removeExactUnboundOperation(
    expected: ClearProjectionOperation,
    guard?: () => boolean,
    lease?: ClearProjectionOperationLease,
  ): Promise<ClearProjectionStoreResult<ClearProjectionOperation>>;
}

declare const CLEAR_PROJECTION_OPERATION_LEASE_BRAND: unique symbol;

export interface ClearProjectionOperationLease {
  readonly operationId: string;
  readonly [CLEAR_PROJECTION_OPERATION_LEASE_BRAND]: true;
}

export interface ClearProjectionStoreOptions {
  storage: ExtensionStorageArea;
  withLock?<T>(operation: () => Promise<T>): Promise<T>;
}

// A single tail protects every helper instance in this JavaScript module. The
// Web Lock additionally protects read-modify-write cycles across live contexts.
let moduleMutationTail: Promise<void> = Promise.resolve();
const operationCoordinatorTails = new Map<string, Promise<void>>();
const activeOperationLeases = new WeakSet<object>();

export async function withClearProjectionOperationLease<T>(
  operationId: string,
  operation: (lease: ClearProjectionOperationLease) => Promise<T>,
): Promise<T> {
  if (!isBoundedTrimmedId(operationId, MAX_ID_LENGTH)) {
    throw new Error("Invalid clear projection operation id.");
  }
  const previous = operationCoordinatorTails.get(operationId) ?? Promise.resolve();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const tail = previous.catch(() => undefined).then(() => gate);
  operationCoordinatorTails.set(operationId, tail);
  await previous.catch(() => undefined);
  const lease = { operationId } as ClearProjectionOperationLease;
  activeOperationLeases.add(lease);
  try {
    return await operation(lease);
  } finally {
    activeOperationLeases.delete(lease);
    release();
    void tail.finally(() => {
      if (operationCoordinatorTails.get(operationId) === tail) {
        operationCoordinatorTails.delete(operationId);
      }
    });
  }
}

export function createClearProjectionStore(
  options: ClearProjectionStoreOptions,
): ClearProjectionStore {
  const withLock = options.withLock ?? withDefaultWebLock;

  return {
    prepare(inputValue, lease) {
      if (isRecord(inputValue) && Array.isArray(inputValue.requestedOrigins) &&
          inputValue.requestedOrigins.length > CLEAR_PROJECTION_MAX_ORIGINS) {
        return resolvedFailure("LIMIT_EXCEEDED", "Too many requested origins.");
      }
      if (isRecord(inputValue) && Array.isArray(inputValue.targets) &&
          inputValue.targets.length > CLEAR_PROJECTION_MAX_SUBJECTS) {
        return resolvedFailure("LIMIT_EXCEEDED", "Too many provisional cleanup subjects.");
      }
      const input = normalizePrepareInput(inputValue);
      if (!input) return resolvedFailure("INVALID_INPUT", "Invalid provisional clear operation.");
      return mutate(input.operationId, lease, async (journal) => {
        const existing = journal.operations.find((operation) =>
          operation.operationId === input.operationId
        );
        if (existing) {
          return sameStringArray(existing.requestedOrigins, input.requestedOrigins) &&
              sameRequest(existing.request, input.request) &&
              sameTargetSnapshots(existing.targets, input.targets ?? [])
            ? unchanged(cloneOperation(existing))
            : mutationFailure("CONFLICT", "Clear operation scope conflicts with the journal.");
        }
        if (journal.operations.length >= CLEAR_PROJECTION_MAX_ACTIVE_OPERATIONS) {
          return mutationFailure("LIMIT_EXCEEDED", "The clear projection journal is full.");
        }
        if (journal.operations.some((operation) =>
          operation.requestedOrigins.some((origin) => input.requestedOrigins.includes(origin)))) {
          return mutationFailure("CONFLICT", "A clear operation already owns this origin.");
        }
        const operation: ClearProjectionOperation = {
          version: 1,
          operationId: input.operationId,
          authority: null,
          request: cloneRequest(input.request),
          requestedOrigins: input.requestedOrigins,
          origins: [],
          subjectDiscovery: input.targets === undefined ? "pending" : "complete",
          targets: (input.targets ?? []).map((target) => ({
            ...target,
            state: "pending" as const,
            attemptCount: 0,
          })),
        };
        journal.operations.push(operation);
        journal.operations.sort(compareOperations);
        return changed(cloneOperation(operation));
      });
    },

    commitOrigins(authorityValue, originValues, lease) {
      const authority = parseAuthorityReference(authorityValue);
      if (!authority || !Array.isArray(originValues)) {
        return resolvedFailure("INVALID_INPUT", "Invalid clear origin commit.");
      }
      if (originValues.length === 0) {
        return resolvedFailure("INVALID_INPUT", "At least one committed origin is required.");
      }
      if (originValues.length > CLEAR_PROJECTION_MAX_ORIGINS) {
        return resolvedFailure("LIMIT_EXCEEDED", "Too many committed origins.");
      }
      const origins = normalizeCommittedOrigins(originValues);
      if (!origins) return resolvedFailure("INVALID_INPUT", "Invalid committed origin.");
      return mutate(authority.operationId, lease, async (journal) => {
        const current = journal.operations.find((operation) =>
          operation.operationId === authority.operationId
        );
        if (!current) {
          return mutationFailure("OPERATION_NOT_FOUND", "Clear operation was not prepared.");
        }
        if (current.authority && !sameAuthority(current.authority, authority)) {
          return mutationFailure("STALE_REFERENCE", "Clear operation authority is stale.");
        }
        if (!current.authority && journal.operations.some((operation) =>
          operation.authority?.authorityId === authority.authorityId &&
          operation.authority.generation === authority.generation
        )) {
          return mutationFailure("CONFLICT", "Clear authority generation is already bound.");
        }
        if (origins.some((origin) => !current.requestedOrigins.includes(origin.origin))) {
          return mutationFailure("CONFLICT", "Committed origin was not in the prepared scope.");
        }
        const merged = new Map(current.origins.map((entry) => [entry.origin, entry]));
        let hasNewOrigin = false;
        for (const origin of origins) {
          const previous = merged.get(origin.origin);
          if (previous && previous.originAfterEpoch !== origin.originAfterEpoch) {
            return mutationFailure("CONFLICT", "Committed origin epoch conflicts with the journal.");
          }
          if (!previous) {
            hasNewOrigin = true;
            merged.set(origin.origin, origin);
          }
        }
        const bindsAuthority = current.authority === null;
        if (!hasNewOrigin && !bindsAuthority) return unchanged(cloneOperation(current));
        if (current.subjectDiscovery === "complete" && !bindsAuthority) {
          return mutationFailure(
            "INVALID_TRANSITION",
            "Cannot add origins after subject discovery is complete.",
          );
        }
        if (merged.size > CLEAR_PROJECTION_MAX_ORIGINS) {
          return mutationFailure("LIMIT_EXCEEDED", "Too many committed origins.");
        }
        current.authority = cloneAuthority(authority);
        current.origins = Array.from(merged.values()).sort(compareOrigins);
        const committedOrigins = new Set(current.origins.map((entry) => entry.origin));
        current.targets = current.targets.filter((target) =>
          committedOrigins.has(target.subject.origin)
        );
        return changed(cloneOperation(current));
      });
    },

    completeSubjectDiscovery(authorityValue, lease) {
      const authority = parseAuthorityReference(authorityValue);
      if (!authority) return resolvedFailure("INVALID_INPUT", "Invalid clear authority reference.");
      return mutate(authority.operationId, lease, async (journal) => {
        const operation = requireOperation(journal, authority);
        if (!operation.ok) return mutationFromFailure(operation.result);
        const current = operation.value;
        if (current.subjectDiscovery === "complete") return unchanged(cloneOperation(current));
        if (current.origins.length === 0) {
          return mutationFailure(
            "INVALID_TRANSITION",
            "Canonical origins must be committed before discovery completes.",
          );
        }
        current.subjectDiscovery = "complete";
        return changed(cloneOperation(current));
      });
    },

    upsertTarget(authorityValue, targetValue, lease) {
      const authority = parseAuthorityReference(authorityValue);
      if (!authority || !isRecord(targetValue)) {
        return resolvedFailure("INVALID_INPUT", "Invalid clear projection target.");
      }
      if (Array.isArray(targetValue.removedItemIds) &&
          targetValue.removedItemIds.length > CLEAR_PROJECTION_MAX_REMOVED_ITEM_IDS) {
        return resolvedFailure("LIMIT_EXCEEDED", "Too many removed item ids.");
      }
      const target = normalizeTargetInput(targetValue);
      if (!target) return resolvedFailure("INVALID_INPUT", "Invalid clear projection target.");
      return mutate(authority.operationId, lease, async (journal) => {
        const operation = requireOperation(journal, authority);
        if (!operation.ok) return mutationFromFailure(operation.result);
        const current = operation.value;
        if (!current.origins.some((entry) => entry.origin === target.subject.origin)) {
          return mutationFailure("CONFLICT", "Target origin has not been canonically committed.");
        }
        const existing = current.targets.find((entry) =>
          sameSubject(entry.subject, target.subject)
        );
        if (existing) {
          if (sameTargetCreation(existing, target)) return unchanged(cloneTarget(existing));
          return mutationFailure("CONFLICT", "The exact subject already has different cleanup work.");
        }
        if (current.subjectDiscovery === "complete") {
          return mutationFailure(
            "INVALID_TRANSITION",
            "Cannot add a target after subject discovery is complete.",
          );
        }
        if (current.targets.length >= CLEAR_PROJECTION_MAX_SUBJECTS) {
          return mutationFailure("LIMIT_EXCEEDED", "Too many exact cleanup subjects.");
        }
        const stored: ClearProjectionTarget = {
          ...target,
          state: "pending",
          attemptCount: 0,
        };
        current.targets.push(stored);
        current.targets.sort(compareTargets);
        return changed(cloneTarget(stored));
      });
    },

    markDelivered(authorityValue, deliveryValue, lease) {
      const authority = parseAuthorityReference(authorityValue);
      const delivery = parseDeliveryInput(deliveryValue);
      if (!authority || !delivery) {
        return resolvedFailure("INVALID_INPUT", "Invalid clear projection delivery.");
      }
      return mutate(authority.operationId, lease, async (journal) => {
        const operation = requireOperation(journal, authority);
        if (!operation.ok) return mutationFromFailure(operation.result);
        const target = findExactTarget(operation.value, delivery);
        if (!target) return mutationFailure("TARGET_NOT_FOUND", "Exact cleanup target not found.");
        if (target.state === "acknowledged" || target.state === "superseded") {
          return mutationFailure("INVALID_TRANSITION", "Cleanup target is already terminal.");
        }
        if (target.attemptCount === delivery.expectedAttemptCount + 1 &&
            target.state === "delivered" && target.nextAttemptAt === delivery.nextAttemptAt) {
          return unchanged(cloneTarget(target));
        }
        if (target.attemptCount !== delivery.expectedAttemptCount) {
          return mutationFailure("CONFLICT", "Cleanup delivery attempt is stale.");
        }
        if (target.attemptCount === Number.MAX_SAFE_INTEGER) {
          return mutationFailure("LIMIT_EXCEEDED", "Cleanup delivery attempts are exhausted.");
        }
        target.state = "delivered";
        target.attemptCount += 1;
        target.nextAttemptAt = delivery.nextAttemptAt;
        return changed(cloneTarget(target));
      });
    },

    acknowledge(authorityValue, acknowledgementValue, lease) {
      const authority = parseAuthorityReference(authorityValue);
      const acknowledgement = parseAcknowledgementInput(acknowledgementValue);
      if (!authority || !acknowledgement) {
        return resolvedFailure("INVALID_INPUT", "Invalid zero-marker acknowledgement.");
      }
      return mutate(authority.operationId, lease, async (journal) => {
        const operation = requireOperation(journal, authority);
        if (!operation.ok) return mutationFromFailure(operation.result);
        const target = findExactTarget(operation.value, acknowledgement);
        if (!target) return mutationFailure("TARGET_NOT_FOUND", "Exact cleanup target not found.");
        if (target.state === "acknowledged") return unchanged(cloneTarget(target));
        if (target.state !== "delivered") {
          return mutationFailure(
            "INVALID_TRANSITION",
            "Only a delivered cleanup target can be acknowledged.",
          );
        }
        target.state = "acknowledged";
        return changed(cloneTarget(target));
      });
    },

    supersede(authorityValue, targetValue, lease) {
      const authority = parseAuthorityReference(authorityValue);
      const targetReference = parseTargetReference(targetValue);
      if (!authority || !targetReference) {
        return resolvedFailure("INVALID_INPUT", "Invalid cleanup target reference.");
      }
      return mutate(authority.operationId, lease, async (journal) => {
        const operation = requireOperation(journal, authority);
        if (!operation.ok) return mutationFromFailure(operation.result);
        const target = findExactTarget(operation.value, targetReference);
        if (!target) return mutationFailure("TARGET_NOT_FOUND", "Exact cleanup target not found.");
        if (target.state === "superseded") return unchanged(cloneTarget(target));
        if (target.state === "acknowledged") {
          return mutationFailure("INVALID_TRANSITION", "Acknowledged cleanup cannot be superseded.");
        }
        target.state = "superseded";
        return changed(cloneTarget(target));
      });
    },

    replaceTarget(authorityValue, replacementValue, lease) {
      const authority = parseAuthorityReference(authorityValue);
      if (!authority || !isRecord(replacementValue) ||
          !hasExactKeys(replacementValue, ["previous", "target"]) ||
          !isRecord(replacementValue.target)) {
        return resolvedFailure("INVALID_INPUT", "Invalid cleanup target replacement.");
      }
      const previous = parseTargetReference(replacementValue.previous);
      const target = normalizeTargetInput(replacementValue.target);
      if (!previous || !target) {
        return resolvedFailure("INVALID_INPUT", "Invalid cleanup target replacement.");
      }
      return mutate(authority.operationId, lease, async (journal) => {
        const operation = requireOperation(journal, authority);
        if (!operation.ok) return mutationFromFailure(operation.result);
        const current = operation.value;
        const oldTarget = findExactTarget(current, previous);
        const existing = current.targets.find((entry) => sameSubject(entry.subject, target.subject));
        if (!oldTarget) {
          return existing && sameTargetCreation(existing, target)
            ? unchanged(cloneTarget(existing))
            : mutationFailure("TARGET_NOT_FOUND", "Exact cleanup target not found.");
        }
        if (oldTarget.state === "acknowledged") {
          return mutationFailure("INVALID_TRANSITION", "Acknowledged cleanup cannot be replaced.");
        }
        if (oldTarget.subject.tabId !== target.subject.tabId ||
            oldTarget.subject.frameId !== target.subject.frameId ||
            oldTarget.subject.origin !== target.subject.origin ||
            sameSubject(oldTarget.subject, target.subject) ||
            !current.origins.some((entry) => entry.origin === target.subject.origin)) {
          return mutationFailure("CONFLICT", "Replacement is not the next exact document subject.");
        }
        if (existing) {
          return mutationFailure("CONFLICT", "Replacement subject already has different work.");
        }
        const replacement: ClearProjectionTarget = {
          ...target,
          state: "pending",
          attemptCount: 0,
        };
        current.targets[current.targets.indexOf(oldTarget)] = replacement;
        current.targets.sort(compareTargets);
        return changed(cloneTarget(replacement));
      });
    },

    async listOperations() {
      const journal = await readJournal();
      return journal.ok
        ? success(journal.value.operations.map(cloneOperation))
        : journal;
    },

    async listPending(now) {
      if (!isNonNegativeSafeInteger(now)) {
        return failure("INVALID_INPUT", "Invalid cleanup due time.");
      }
      const journal = await readJournal();
      if (!journal.ok) return journal;
      const pending: PendingClearProjection[] = [];
      for (const operation of journal.value.operations) {
        if (operation.authority === null) continue;
        const epochs = new Map(operation.origins.map((entry) => [
          entry.origin,
          entry.originAfterEpoch,
        ]));
        for (const target of operation.targets) {
          if ((target.state !== "pending" && target.state !== "delivered") ||
              target.nextAttemptAt > now) continue;
          const originAfterEpoch = epochs.get(target.subject.origin);
          if (originAfterEpoch === undefined) {
            return failure("INVALID_STORAGE", "Cleanup target has no committed origin.");
          }
          pending.push({
            ...cloneTarget(target),
            authority: cloneAuthority(operation.authority),
            originAfterEpoch,
          });
        }
      }
      return success(pending);
    },

    removeOperation(referenceValue, lease) {
      const authority = typeof referenceValue === "string"
        ? null
        : parseAuthorityReference(referenceValue);
      const operationId = typeof referenceValue === "string" &&
          isBoundedTrimmedId(referenceValue, MAX_ID_LENGTH)
        ? referenceValue
        : authority?.operationId ?? null;
      if (!operationId) return resolvedFailure("INVALID_INPUT", "Invalid clear operation reference.");
      return mutate(operationId, lease, async (journal) => {
        const index = journal.operations.findIndex((operation) =>
          operation.operationId === operationId
        );
        if (index < 0) return unchanged(null);
        const operation = journal.operations[index]!;
        if ((authority === null && operation.authority !== null) ||
            (authority !== null &&
              (operation.authority === null || !sameAuthority(operation.authority, authority)))) {
          return mutationFailure("STALE_REFERENCE", "Clear operation authority is stale.");
        }
        if (operation.authority !== null &&
            (operation.subjectDiscovery !== "complete" || operation.targets.some((target) =>
              target.state !== "acknowledged" && target.state !== "superseded"
            ))) {
          return mutationFailure(
            "INVALID_TRANSITION",
            "Bound clear operation still owns nonterminal cleanup work.",
          );
        }
        const removed = cloneOperation(operation);
        journal.operations.splice(index, 1);
        return changed(removed);
      });
    },

    removeExactUnboundOperation(expectedValue, guard, lease) {
      const expected = parseOperation(expectedValue);
      if (!expected || expected.authority !== null || expected.request === null ||
          (guard !== undefined && typeof guard !== "function")) {
        return resolvedFailure("INVALID_INPUT", "Invalid exact unbound clear operation removal.");
      }
      return mutate(expected.operationId, lease, async (journal) => {
        const index = journal.operations.findIndex((operation) =>
          operation.operationId === expected.operationId
        );
        const current = index < 0 ? null : journal.operations[index]!;
        if (!current || current.authority !== null || current.request === null ||
            !sameOperationSnapshot(current, expected)) {
          return mutationFailure(
            "STALE_REFERENCE",
            "Unbound clear operation changed before exact retirement.",
          );
        }
        let guardAccepted = true;
        try {
          guardAccepted = guard === undefined || guard() === true;
        } catch {
          guardAccepted = false;
        }
        if (!guardAccepted) {
          return mutationFailure(
            "STALE_REFERENCE",
            "Unbound clear operation retirement guard is stale.",
          );
        }
        const removed = cloneOperation(current);
        journal.operations.splice(index, 1);
        return changed(removed);
      });
    },
  };

  async function readJournal(): Promise<ClearProjectionStoreResult<ClearProjectionJournal>> {
    try {
      const values = await options.storage.get(CLEAR_PROJECTION_JOURNAL_STORAGE_KEY);
      const raw = values[CLEAR_PROJECTION_JOURNAL_STORAGE_KEY];
      if (raw === undefined) return success({ version: 1, operations: [] });
      const parsed = parseClearProjectionJournal(raw);
      return parsed
        ? success(parsed)
        : failure("INVALID_STORAGE", "Invalid durable clear projection journal.");
    } catch {
      return failure("STORAGE_ERROR", "Clear projection journal storage is unavailable.");
    }
  }

  function mutate<T>(
    operationId: string,
    lease: ClearProjectionOperationLease | undefined,
    operation: (journal: ClearProjectionJournal) => Promise<MutationResult<T>>,
  ): Promise<ClearProjectionStoreResult<T>> {
    const run = async (): Promise<ClearProjectionStoreResult<T>> => {
      try {
        return await withLock(async () => {
          const journal = await readJournal();
          if (!journal.ok) return journal;
          const mutation = await operation(journal.value);
          if (!mutation.changed) return mutation.result;
          if (journal.value.operations.length === 0) {
            await options.storage.remove(CLEAR_PROJECTION_JOURNAL_STORAGE_KEY);
          } else {
            await options.storage.set({
              [CLEAR_PROJECTION_JOURNAL_STORAGE_KEY]: cloneJournal(journal.value),
            });
          }
          return mutation.result;
        });
      } catch {
        return failure("STORAGE_ERROR", "Clear projection journal storage is unavailable.");
      }
    };
    const coordinatedRun = () => {
      const result = moduleMutationTail.then(run, run);
      moduleMutationTail = result.then(() => undefined, () => undefined);
      return result;
    };
    return isCurrentOperationLease(operationId, lease)
      ? coordinatedRun()
      : withClearProjectionOperationLease(operationId, coordinatedRun);
  }
}

function isCurrentOperationLease(
  operationId: string,
  lease: ClearProjectionOperationLease | undefined,
): lease is ClearProjectionOperationLease {
  return lease !== undefined && lease.operationId === operationId && activeOperationLeases.has(lease);
}

export function parseClearProjectionJournal(value: unknown): ClearProjectionJournal | null {
  if (!isRecord(value) || !hasExactKeys(value, ["version", "operations"]) ||
      value.version !== 1 || !Array.isArray(value.operations) ||
      value.operations.length > CLEAR_PROJECTION_MAX_ACTIVE_OPERATIONS) return null;
  const operations: ClearProjectionOperation[] = [];
  const operationIds = new Set<string>();
  const authorityGenerations = new Set<string>();
  for (const candidate of value.operations) {
    const operation = parseOperation(candidate);
    if (!operation || operationIds.has(operation.operationId)) return null;
    if (operation.authority) {
      const authorityGeneration = authorityGenerationKey(operation.authority);
      if (authorityGenerations.has(authorityGeneration)) return null;
      authorityGenerations.add(authorityGeneration);
    }
    operationIds.add(operation.operationId);
    operations.push(operation);
  }
  if (!isStrictlySorted(operations, compareOperations)) return null;
  return { version: 1, operations };
}

function parseOperation(value: unknown): ClearProjectionOperation | null {
  if (!isRecord(value) || !(hasExactKeys(value, [
    "version",
    "operationId",
    "authority",
    "requestedOrigins",
    "origins",
    "subjectDiscovery",
    "targets",
  ]) || hasExactKeys(value, [
    "version",
    "operationId",
    "authority",
    "request",
    "requestedOrigins",
    "origins",
    "subjectDiscovery",
    "targets",
  ])) || value.version !== 1) return null;
  const authority = value.authority === null ? null : parseAuthorityReference(value.authority);
  const requestedOrigins = parseRequestedOrigins(value.requestedOrigins);
  const request = "request" in value
    ? value.request === null ? null : parseStoredRequest(value.request)
    : null;
  if (!isBoundedTrimmedId(value.operationId, MAX_ID_LENGTH) ||
      (value.authority !== null && !authority) || !requestedOrigins ||
      ("request" in value && value.request !== null && !request) ||
      (request !== null && !sameStringArray(
        request.origins.map((origin) => origin.origin),
        requestedOrigins,
      )) ||
      (authority !== null && authority.operationId !== value.operationId) ||
      !Array.isArray(value.origins) ||
      value.origins.length > CLEAR_PROJECTION_MAX_ORIGINS ||
      (value.subjectDiscovery !== "pending" && value.subjectDiscovery !== "complete") ||
      !Array.isArray(value.targets) || value.targets.length > CLEAR_PROJECTION_MAX_SUBJECTS) {
    return null;
  }
  const origins: ClearProjectionCommittedOrigin[] = [];
  const originNames = new Set<string>();
  for (const candidate of value.origins) {
    const origin = parseCommittedOrigin(candidate);
    if (!origin || originNames.has(origin.origin)) return null;
    originNames.add(origin.origin);
    origins.push(origin);
  }
  if (!isStrictlySorted(origins, compareOrigins) ||
      origins.some((origin) => !requestedOrigins.includes(origin.origin)) ||
      (authority === null && origins.length > 0) ||
      (authority !== null && origins.length === 0) ||
      (authority !== null && value.subjectDiscovery === "complete" && origins.length === 0)) {
    return null;
  }
  const targets: ClearProjectionTarget[] = [];
  const subjectKeys = new Set<string>();
  for (const candidate of value.targets) {
    const target = parseTarget(candidate);
    if (!target || (authority === null
      ? !requestedOrigins.includes(target.subject.origin)
      : !originNames.has(target.subject.origin))) return null;
    const key = subjectKey(target.subject);
    if (subjectKeys.has(key)) return null;
    subjectKeys.add(key);
    targets.push(target);
  }
  if (!isStrictlySorted(targets, compareTargets)) return null;
  return {
    version: 1,
    operationId: value.operationId,
    authority,
    request,
    requestedOrigins,
    origins,
    subjectDiscovery: value.subjectDiscovery,
    targets,
  };
}

function parseAuthorityReference(value: unknown): ClearProjectionAuthorityReference | null {
  if (!isRecord(value) || !hasExactKeys(value, [
    "authorityId",
    "operationId",
    "generation",
  ]) || !isBoundedTrimmedId(value.authorityId, MAX_ID_LENGTH) ||
      !isBoundedTrimmedId(value.operationId, MAX_ID_LENGTH) ||
      !isPositiveSafeInteger(value.generation)) return null;
  return {
    authorityId: value.authorityId,
    operationId: value.operationId,
    generation: value.generation,
  };
}

function normalizePrepareInput(value: unknown): ClearProjectionPrepareInput | null {
  if (!isRecord(value) || !(hasExactKeys(value, ["operationId", "requestedOrigins", "request"]) ||
      hasExactKeys(value, ["operationId", "requestedOrigins", "request", "targets"])) ||
      !isBoundedTrimmedId(value.operationId, MAX_ID_LENGTH) ||
      !Array.isArray(value.requestedOrigins) || value.requestedOrigins.length === 0 ||
      value.requestedOrigins.length > CLEAR_PROJECTION_MAX_ORIGINS) return null;
  const requestedOrigins = normalizeRequestedOrigins(value.requestedOrigins);
  if (!requestedOrigins) return null;
  const request = normalizeRequest(value.request, requestedOrigins);
  if (!request) return null;
  if (!("targets" in value)) return {
    operationId: value.operationId,
    requestedOrigins,
    request,
  };
  if (!Array.isArray(value.targets) || value.targets.length > CLEAR_PROJECTION_MAX_SUBJECTS) {
    return null;
  }
  const targets: ClearProjectionTargetInput[] = [];
  const subjectKeys = new Set<string>();
  for (const candidate of value.targets) {
    if (!isRecord(candidate)) return null;
    const target = normalizeTargetInput(candidate);
    if (!target || !requestedOrigins.includes(target.subject.origin)) return null;
    const key = subjectKey(target.subject);
    if (subjectKeys.has(key)) return null;
    subjectKeys.add(key);
    targets.push(target);
  }
  targets.sort((left, right) => compareSubjects(left.subject, right.subject));
  return { operationId: value.operationId, requestedOrigins, request, targets };
}

function normalizeRequest(
  value: unknown,
  requestedOrigins: readonly string[],
): ClearProjectionRequest | null {
  if (!isRecord(value) || !(hasExactKeys(value, ["nonce", "endpoint", "origins"]) ||
      hasExactKeys(value, ["nonce", "endpoint", "origins", "barrierScope"])) ||
      !isBoundedTrimmedId(value.nonce, MAX_ID_LENGTH) || !Array.isArray(value.origins) ||
      value.origins.length === 0 || value.origins.length > CLEAR_PROJECTION_MAX_ORIGINS) return null;
  const barrierScope = parseBarrierScope(value);
  if (barrierScope === null) return null;
  const endpoint = parseSubject(value.endpoint);
  if (!endpoint) return null;
  const origins: ClearProjectionRequestOrigin[] = [];
  const seen = new Set<string>();
  for (const candidate of value.origins) {
    const origin = parseRequestOrigin(candidate);
    if (!origin || seen.has(origin.origin)) return null;
    seen.add(origin.origin);
    origins.push(origin);
  }
  origins.sort((left, right) => ordinalCompare(left.origin, right.origin));
  if (!sameStringArray(origins.map((origin) => origin.origin), requestedOrigins) ||
      !seen.has(endpoint.origin)) return null;
  return {
    nonce: value.nonce,
    endpoint,
    origins,
    ...(barrierScope ? { barrierScope } : {}),
  };
}

function parseStoredRequest(value: unknown): ClearProjectionRequest | null {
  if (!isRecord(value) || !(hasExactKeys(value, ["nonce", "endpoint", "origins"]) ||
      hasExactKeys(value, ["nonce", "endpoint", "origins", "barrierScope"])) ||
      !isBoundedTrimmedId(value.nonce, MAX_ID_LENGTH) || !Array.isArray(value.origins) ||
      value.origins.length === 0 || value.origins.length > CLEAR_PROJECTION_MAX_ORIGINS) return null;
  const barrierScope = parseBarrierScope(value);
  if (barrierScope === null) return null;
  const endpoint = parseSubject(value.endpoint);
  if (!endpoint) return null;
  const origins: ClearProjectionRequestOrigin[] = [];
  const seen = new Set<string>();
  for (const candidate of value.origins) {
    const origin = parseRequestOrigin(candidate);
    if (!origin || seen.has(origin.origin)) return null;
    seen.add(origin.origin);
    origins.push(origin);
  }
  if (!isStrictlySorted(origins, (left, right) => ordinalCompare(left.origin, right.origin)) ||
      !seen.has(endpoint.origin)) return null;
  return {
    nonce: value.nonce,
    endpoint,
    origins,
    ...(barrierScope ? { barrierScope } : {}),
  };
}

function parseBarrierScope(
  value: Record<string, unknown>,
): ClearProjectionBarrierScope | undefined | null {
  if (!("barrierScope" in value)) return undefined;
  return value.barrierScope === "live-page" || value.barrierScope === "active-origin"
    ? value.barrierScope
    : null;
}

function parseRequestOrigin(value: unknown): ClearProjectionRequestOrigin | null {
  if (!isRecord(value) || !hasExactKeys(value, ["origin", "beforeEpoch"]) ||
      !isCanonicalHttpOrigin(value.origin) ||
      (value.beforeEpoch !== null && !isBoundedTrimmedId(value.beforeEpoch, MAX_ID_LENGTH))) {
    return null;
  }
  return { origin: value.origin, beforeEpoch: value.beforeEpoch };
}

function normalizeRequestedOrigins(value: unknown[]): string[] | null {
  const origins = new Set<string>();
  for (const candidate of value) {
    if (!isCanonicalHttpOrigin(candidate)) return null;
    origins.add(candidate);
  }
  return Array.from(origins).sort(ordinalCompare);
}

function parseRequestedOrigins(value: unknown): string[] | null {
  if (!Array.isArray(value) || value.length === 0 ||
      value.length > CLEAR_PROJECTION_MAX_ORIGINS) return null;
  const origins: string[] = [];
  for (const candidate of value) {
    if (!isCanonicalHttpOrigin(candidate)) return null;
    origins.push(candidate);
  }
  return isStrictlySorted(origins, ordinalCompare) ? origins : null;
}

function normalizeCommittedOrigins(
  values: unknown[],
): ClearProjectionCommittedOrigin[] | null {
  const byOrigin = new Map<string, ClearProjectionCommittedOrigin>();
  for (const value of values) {
    const parsed = parseCommittedOrigin(value);
    if (!parsed) return null;
    const previous = byOrigin.get(parsed.origin);
    if (previous && previous.originAfterEpoch !== parsed.originAfterEpoch) return null;
    byOrigin.set(parsed.origin, parsed);
  }
  return Array.from(byOrigin.values()).sort(compareOrigins);
}

function parseCommittedOrigin(value: unknown): ClearProjectionCommittedOrigin | null {
  if (!isRecord(value) || !hasExactKeys(value, ["origin", "originAfterEpoch"]) ||
      !isCanonicalHttpOrigin(value.origin) ||
      !isBoundedTrimmedId(value.originAfterEpoch, MAX_ID_LENGTH)) return null;
  return { origin: value.origin, originAfterEpoch: value.originAfterEpoch };
}

function normalizeTargetInput(value: Record<string, unknown>): ClearProjectionTargetInput | null {
  if (!hasExactKeys(value, [
    "subject",
    "removedItemIds",
    "projectionId",
    "revision",
    "nextAttemptAt",
  ])) return null;
  const subject = parseSubject(value.subject);
  const removedItemIds = normalizeRemovedItemIds(value.removedItemIds);
  if (!subject || !removedItemIds || !isProjectionId(value.projectionId) ||
      !isPositiveSafeInteger(value.revision) ||
      !isNonNegativeSafeInteger(value.nextAttemptAt)) return null;
  return {
    subject,
    removedItemIds,
    projectionId: value.projectionId,
    revision: value.revision,
    nextAttemptAt: value.nextAttemptAt,
  };
}

function parseTarget(value: unknown): ClearProjectionTarget | null {
  if (!isRecord(value) || !hasExactKeys(value, [
    "subject",
    "removedItemIds",
    "projectionId",
    "revision",
    "state",
    "attemptCount",
    "nextAttemptAt",
  ])) return null;
  const subject = parseSubject(value.subject);
  const removedItemIds = parseStoredRemovedItemIds(value.removedItemIds);
  if (!subject || !removedItemIds || !isProjectionId(value.projectionId) ||
      !isPositiveSafeInteger(value.revision) || !isTargetState(value.state) ||
      !isNonNegativeSafeInteger(value.attemptCount) ||
      !isNonNegativeSafeInteger(value.nextAttemptAt) ||
      (value.state === "pending" && value.attemptCount !== 0) ||
      ((value.state === "delivered" || value.state === "acknowledged") &&
        value.attemptCount === 0)) return null;
  return {
    subject,
    removedItemIds,
    projectionId: value.projectionId,
    revision: value.revision,
    state: value.state,
    attemptCount: value.attemptCount,
    nextAttemptAt: value.nextAttemptAt,
  };
}

function parseSubject(value: unknown): ClearProjectionSubject | null {
  if (!isRecord(value) || !hasExactKeys(value, [
    "tabId",
    "frameId",
    "documentId",
    "origin",
    "pathname",
  ]) || !isNonNegativeSafeInteger(value.tabId) ||
      !isNonNegativeSafeInteger(value.frameId) ||
      !isBoundedTrimmedId(value.documentId, MAX_DOCUMENT_ID_LENGTH) ||
      !isCanonicalHttpOrigin(value.origin) ||
      !isCanonicalPathname(value.pathname, value.origin)) return null;
  return {
    tabId: value.tabId,
    frameId: value.frameId,
    documentId: value.documentId,
    origin: value.origin,
    pathname: value.pathname,
  };
}

function normalizeRemovedItemIds(value: unknown): string[] | null {
  if (!Array.isArray(value) || value.length > CLEAR_PROJECTION_MAX_REMOVED_ITEM_IDS) return null;
  const ids = new Set<string>();
  for (const candidate of value) {
    if (!isBoundedTrimmedId(candidate, MAX_ID_LENGTH)) return null;
    ids.add(candidate);
  }
  return Array.from(ids).sort(ordinalCompare);
}

function parseStoredRemovedItemIds(value: unknown): string[] | null {
  if (!Array.isArray(value) || value.length > CLEAR_PROJECTION_MAX_REMOVED_ITEM_IDS) return null;
  const ids: string[] = [];
  for (const candidate of value) {
    if (!isBoundedTrimmedId(candidate, MAX_ID_LENGTH)) return null;
    ids.push(candidate);
  }
  return isStrictlySorted(ids, ordinalCompare) ? ids : null;
}

function parseTargetReference(value: unknown): ClearProjectionTargetReference | null {
  if (!isRecord(value) || !hasExactKeys(value, ["subject", "projectionId", "revision"])) {
    return null;
  }
  const subject = parseSubject(value.subject);
  if (!subject || !isProjectionId(value.projectionId) ||
      !isPositiveSafeInteger(value.revision)) return null;
  return { subject, projectionId: value.projectionId, revision: value.revision };
}

function parseDeliveryInput(value: unknown): ClearProjectionDeliveryInput | null {
  if (!isRecord(value) || !hasExactKeys(value, [
    "subject",
    "projectionId",
    "revision",
    "expectedAttemptCount",
    "nextAttemptAt",
  ])) return null;
  const reference = parseTargetReference({
    subject: value.subject,
    projectionId: value.projectionId,
    revision: value.revision,
  });
  if (!reference || !isNonNegativeSafeInteger(value.expectedAttemptCount) ||
      !isNonNegativeSafeInteger(value.nextAttemptAt)) return null;
  return {
    ...reference,
    expectedAttemptCount: value.expectedAttemptCount,
    nextAttemptAt: value.nextAttemptAt,
  };
}

function parseAcknowledgementInput(value: unknown): ClearProjectionAcknowledgementInput | null {
  if (!isRecord(value) || !hasExactKeys(value, [
    "subject",
    "projectionId",
    "revision",
    "readback",
  ])) return null;
  const reference = parseTargetReference({
    subject: value.subject,
    projectionId: value.projectionId,
    revision: value.revision,
  });
  const readback = parseZeroMarkerReadback(value.readback);
  return reference && readback ? { ...reference, readback } : null;
}

function parseZeroMarkerReadback(value: unknown): ClearProjectionZeroMarkerReadback | null {
  if (!isRecord(value) || !hasExactKeys(value, [
    "appliedItemIds",
    "markerCount",
    "selectionPreviewActive",
    "digest",
  ]) || !Array.isArray(value.appliedItemIds) || value.appliedItemIds.length !== 0 ||
      value.markerCount !== 0 ||
      value.selectionPreviewActive !== false ||
      value.digest !== UI_ATTACH_EMPTY_APPLIED_ITEM_IDS_DIGEST) return null;
  return {
    appliedItemIds: [],
    markerCount: 0,
    selectionPreviewActive: false,
    digest: value.digest,
  };
}

type ClearProjectionStoreFailure = Extract<
  ClearProjectionStoreResult<never>,
  { ok: false }
>;

type MutationResult<T> =
  | { changed: true; result: { ok: true; value: T } }
  | { changed: false; result: ClearProjectionStoreResult<T> };

function changed<T>(value: T): MutationResult<T> {
  return { changed: true, result: { ok: true, value } };
}

function unchanged<T>(value: T): MutationResult<T> {
  return { changed: false, result: success(value) };
}

function mutationFailure<T>(
  code: ClearProjectionStoreErrorCode,
  message: string,
): MutationResult<T> {
  return { changed: false, result: failure(code, message) };
}

function mutationFromFailure<T>(result: ClearProjectionStoreFailure): MutationResult<T> {
  return { changed: false, result };
}

function success<T>(value: T): ClearProjectionStoreResult<T> {
  return { ok: true, value };
}

function failure<T>(
  code: ClearProjectionStoreErrorCode,
  message: string,
): ClearProjectionStoreResult<T> {
  return { ok: false, code, message };
}

function resolvedFailure<T>(
  code: ClearProjectionStoreErrorCode,
  message: string,
): Promise<ClearProjectionStoreResult<T>> {
  return Promise.resolve(failure(code, message));
}

function requireOperation(
  journal: ClearProjectionJournal,
  authority: ClearProjectionAuthorityReference,
): { ok: true; value: ClearProjectionOperation } | {
  ok: false;
  result: ClearProjectionStoreFailure;
} {
  const operation = journal.operations.find((candidate) =>
    candidate.operationId === authority.operationId
  );
  if (!operation) {
    return {
      ok: false,
      result: {
        ok: false,
        code: "OPERATION_NOT_FOUND",
        message: "Clear operation was not prepared.",
      },
    };
  }
  if (operation.authority === null) {
    return {
      ok: false,
      result: {
        ok: false,
        code: "OPERATION_NOT_BOUND",
        message: "Clear operation authority is not bound.",
      },
    };
  }
  if (sameAuthority(operation.authority, authority)) return { ok: true, value: operation };
  return {
    ok: false,
    result: {
      ok: false,
      code: "STALE_REFERENCE",
      message: "Clear operation authority is stale.",
    },
  };
}

function findExactTarget(
  operation: ClearProjectionOperation,
  reference: ClearProjectionTargetReference,
): ClearProjectionTarget | null {
  return operation.targets.find((target) =>
    sameSubject(target.subject, reference.subject) &&
    target.projectionId === reference.projectionId &&
    target.revision === reference.revision
  ) ?? null;
}

function sameTargetCreation(
  existing: ClearProjectionTarget,
  input: ClearProjectionTargetInput,
): boolean {
  return existing.projectionId === input.projectionId && existing.revision === input.revision &&
    sameStringArray(existing.removedItemIds, input.removedItemIds) &&
    (existing.attemptCount > 0 || existing.nextAttemptAt === input.nextAttemptAt);
}

function sameTargetSnapshots(
  existing: readonly ClearProjectionTarget[],
  input: readonly ClearProjectionTargetInput[],
): boolean {
  return existing.length === input.length && existing.every((target, index) => {
    const candidate = input[index];
    return candidate !== undefined && sameSubject(target.subject, candidate.subject) &&
      target.projectionId === candidate.projectionId && target.revision === candidate.revision &&
      sameStringArray(target.removedItemIds, candidate.removedItemIds) &&
      (target.attemptCount > 0 || target.nextAttemptAt === candidate.nextAttemptAt);
  });
}

function sameAuthority(
  left: ClearProjectionAuthorityReference,
  right: ClearProjectionAuthorityReference,
): boolean {
  return left.authorityId === right.authorityId && left.operationId === right.operationId &&
    left.generation === right.generation;
}

function sameOperationSnapshot(
  left: ClearProjectionOperation,
  right: ClearProjectionOperation,
): boolean {
  return left.version === right.version && left.operationId === right.operationId &&
    (left.authority === null
      ? right.authority === null
      : right.authority !== null && sameAuthority(left.authority, right.authority)) &&
    (left.request === null
      ? right.request === null
      : right.request !== null && sameRequest(left.request, right.request)) &&
    sameStringArray(left.requestedOrigins, right.requestedOrigins) &&
    left.origins.length === right.origins.length && left.origins.every((origin, index) => {
      const candidate = right.origins[index];
      return candidate !== undefined && origin.origin === candidate.origin &&
        origin.originAfterEpoch === candidate.originAfterEpoch;
    }) && left.subjectDiscovery === right.subjectDiscovery &&
    left.targets.length === right.targets.length && left.targets.every((target, index) => {
      const candidate = right.targets[index];
      return candidate !== undefined && sameSubject(target.subject, candidate.subject) &&
        sameStringArray(target.removedItemIds, candidate.removedItemIds) &&
        target.projectionId === candidate.projectionId && target.revision === candidate.revision &&
        target.state === candidate.state && target.attemptCount === candidate.attemptCount &&
        target.nextAttemptAt === candidate.nextAttemptAt;
    });
}

function sameRequest(
  left: ClearProjectionRequest | null,
  right: ClearProjectionRequest,
): boolean {
  return left !== null && left.nonce === right.nonce &&
    (left.barrierScope ?? "live-page") === (right.barrierScope ?? "live-page") &&
    sameSubject(left.endpoint, right.endpoint) && left.origins.length === right.origins.length &&
    left.origins.every((origin, index) => {
      const candidate = right.origins[index];
      return candidate !== undefined && candidate.origin === origin.origin &&
        candidate.beforeEpoch === origin.beforeEpoch;
    });
}

function sameSubject(left: ClearProjectionSubject, right: ClearProjectionSubject): boolean {
  return left.tabId === right.tabId && left.frameId === right.frameId &&
    left.documentId === right.documentId && left.origin === right.origin &&
    left.pathname === right.pathname;
}

function sameStringArray(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

async function withDefaultWebLock<T>(operation: () => Promise<T>): Promise<T> {
  const locks = globalThis.navigator?.locks;
  if (!locks) return operation();
  return locks.request(CLEAR_PROJECTION_LOCK_NAME, { mode: "exclusive" }, operation);
}

function isBoundedTrimmedId(value: unknown, maximumLength: number): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= maximumLength &&
    value.trim() === value && !CONTROL_CHARACTER_PATTERN.test(value);
}

function isProjectionId(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 &&
    value.length <= MAX_PROJECTION_ID_LENGTH && !CONTROL_CHARACTER_PATTERN.test(value);
}

function isCanonicalHttpOrigin(value: unknown): value is string {
  if (typeof value !== "string" || value.length === 0 || value.length > MAX_ORIGIN_LENGTH) {
    return false;
  }
  try {
    const url = new URL(value);
    return (url.protocol === "http:" || url.protocol === "https:") && url.origin === value;
  } catch {
    return false;
  }
}

function isCanonicalPathname(value: unknown, origin: string): value is string {
  if (typeof value !== "string" || value.length === 0 || value.length > MAX_PATHNAME_LENGTH ||
      !value.startsWith("/")) return false;
  try {
    const url = new URL(value, `${origin}/`);
    return url.origin === origin && url.pathname === value && url.search === "" && url.hash === "";
  } catch {
    return false;
  }
}

function isPositiveSafeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function isNonNegativeSafeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function isTargetState(value: unknown): value is ClearProjectionTargetState {
  return value === "pending" || value === "delivered" || value === "acknowledged" ||
    value === "superseded";
}

function compareOperations(
  left: ClearProjectionOperation,
  right: ClearProjectionOperation,
): number {
  return ordinalCompare(left.operationId, right.operationId);
}

function compareOrigins(
  left: ClearProjectionCommittedOrigin,
  right: ClearProjectionCommittedOrigin,
): number {
  return ordinalCompare(left.origin, right.origin);
}

function compareTargets(left: ClearProjectionTarget, right: ClearProjectionTarget): number {
  return compareSubjects(left.subject, right.subject);
}

function compareSubjects(left: ClearProjectionSubject, right: ClearProjectionSubject): number {
  return left.tabId - right.tabId || left.frameId - right.frameId ||
    ordinalCompare(left.documentId, right.documentId) ||
    ordinalCompare(left.origin, right.origin) || ordinalCompare(left.pathname, right.pathname);
}

function ordinalCompare(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function isStrictlySorted<T>(
  values: readonly T[],
  compare: (left: T, right: T) => number,
): boolean {
  return values.every((value, index) => index === 0 || compare(values[index - 1]!, value) < 0);
}

function authorityGenerationKey(authority: ClearProjectionAuthorityReference): string {
  return `${authority.authorityId}\u0000${authority.generation}`;
}

function subjectKey(subject: ClearProjectionSubject): string {
  return [
    subject.tabId,
    subject.frameId,
    subject.documentId,
    subject.origin,
    subject.pathname,
  ].join("\u0000");
}

function cloneAuthority(
  authority: ClearProjectionAuthorityReference,
): ClearProjectionAuthorityReference {
  return { ...authority };
}

function cloneSubject(subject: ClearProjectionSubject): ClearProjectionSubject {
  return { ...subject };
}

function cloneRequest(request: ClearProjectionRequest): ClearProjectionRequest {
  return {
    nonce: request.nonce,
    endpoint: cloneSubject(request.endpoint),
    origins: request.origins.map((origin) => ({ ...origin })),
    ...(request.barrierScope ? { barrierScope: request.barrierScope } : {}),
  };
}

function cloneTarget(target: ClearProjectionTarget): ClearProjectionTarget {
  return {
    ...target,
    subject: cloneSubject(target.subject),
    removedItemIds: [...target.removedItemIds],
  };
}

function cloneOperation(operation: ClearProjectionOperation): ClearProjectionOperation {
  return {
    ...operation,
    authority: operation.authority ? cloneAuthority(operation.authority) : null,
    request: operation.request ? cloneRequest(operation.request) : null,
    requestedOrigins: [...operation.requestedOrigins],
    origins: operation.origins.map((origin) => ({ ...origin })),
    targets: operation.targets.map(cloneTarget),
  };
}

function cloneJournal(journal: ClearProjectionJournal): ClearProjectionJournal {
  return { version: 1, operations: journal.operations.map(cloneOperation) };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const keys = Object.keys(value);
  return keys.length === expected.length && expected.every((key) => Object.hasOwn(value, key));
}
