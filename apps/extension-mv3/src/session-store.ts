import {
  isCaptureSessionAnnotationId,
  type CaptureSessionAnnotationLifecycleStateV3,
  type CaptureSessionFile,
} from "@meanthis/hub-core";
import {
  CAPTURE_CLEAR_AUTHORITY_STORAGE_KEY,
  CAPTURE_CLEAR_MAX_ACTIVE_OPERATIONS,
  deriveCaptureClearCanonicalPhase,
  normalizeCaptureClearRequest,
  parseCaptureClearAuthority,
  parseCaptureClearOperationReference,
  sameCaptureClearRequest,
  type CaptureClearAuthorityV1,
  type CaptureClearOperationRequest,
  type CaptureClearOperationReference,
  type CaptureClearOperationV1,
} from "./clear-operation";
import {
  getCaptureStorageKey,
  getLatestCaptureStorageEntries,
  normalizeCaptureRecord,
  type ExtensionStorageArea,
  type OriginCaptureRecord,
} from "./capture-store";
import { serializeCaptureSessionFile } from "./session-file";
import {
  beginCapture as beginSessionCapture,
  commitCapture as commitSessionCapture,
  completeClearSession,
  createSessionMeta,
  removeSessionItem,
  startClearSession,
  updateSessionAnnotationLifecycle,
  updateSessionIntent,
  type CaptureSessionMetaV1,
  type CaptureToken,
  type SessionState,
  type SessionStateErrorCode,
} from "./session-state";
import {
  ANNOTATION_LIFECYCLE_OPERATION_LEDGER_RECEIPT_KIND,
  ANNOTATION_LIFECYCLE_OPERATION_LEDGER_SCHEMA_VERSION,
  ANNOTATION_LIFECYCLE_OPERATION_LEDGER_STORAGE_PREFIX,
  appendAnnotationLifecycleOperationLedgerReceipt,
  createAnnotationLifecycleOperationAtomicStoragePayload,
  createEmptyAnnotationLifecycleOperationLedger,
  getAnnotationLifecycleOperationLedgerStorageKey,
  parseAnnotationLifecycleOperationAtomicReadback,
  parseAnnotationLifecycleOperationLedger,
  type AnnotationLifecycleOperationLedgerReceiptV1,
} from "./annotation-lifecycle-operation-ledger";

const LATEST_CAPTURE_KEY = "ui-attach:capture:latest";
const SESSION_KEY_PREFIX = "ui-attach:session:v1:";
const SESSION_META_KEY_PREFIX = `${SESSION_KEY_PREFIX}meta:`;
const ORIGIN_CAPTURE_KEY_PREFIX = "ui-attach:capture:";
const SESSION_META_MAX_RECEIPTS = 64;
const SESSION_META_MAX_IDENTIFIER_LENGTH = 128;
const STORED_DATA_MAX_DEPTH = 128;
const STORED_DATA_MAX_NODES = 100_000;

export interface ActiveSessionReadback {
  origin: string;
  epoch: string | null;
  clearPending: boolean;
  activeClearOperationId: string | null;
  file: CaptureSessionFile | null;
  legacyRecord: OriginCaptureRecord | null;
}

export interface StoredOriginSessionSummary {
  origin: string;
  epoch: string | null;
  attachmentCount: number | null;
  state: "ready" | "legacy" | "needs_cleanup";
  clearPending: boolean;
  activeClearOperationId: string | null;
}

export interface ExtensionSessionStore {
  list(): Promise<SessionStoreResult<StoredOriginSessionSummary[]>>;
  listClearOperations(): Promise<SessionStoreResult<CaptureClearOperationV1[]>>;
  finalizeClearOperation(
    reference: CaptureClearOperationReference,
  ): Promise<SessionStoreResult<CaptureClearOperationV1>>;
  clearAll(): Promise<SessionStoreResult<{ clearedOrigins: string[] }>>;
  read(origin: string): Promise<SessionStoreResult<ActiveSessionReadback>>;
  inspectCapture(
    origin: string,
    operationId: string,
  ): Promise<SessionStoreResult<{
    readback: ActiveSessionReadback;
    receiptItemId: string | null;
  }>>;
  beginCapture(
    origin: string,
    replaceItemId?: string | null,
  ): Promise<SessionStoreResult<CaptureToken>>;
  commitCapture(
    token: CaptureToken,
    record: OriginCaptureRecord,
    authority?: CaptureCommitAuthority,
  ): Promise<SessionStoreResult<{ readback: ActiveSessionReadback; itemId: string; label: string }>>;
  updateIntent(
    origin: string,
    epoch: string,
    itemId: string,
    intent: string,
    authority?: SessionMutationAuthority,
  ): Promise<SessionStoreResult<ActiveSessionReadback>>;
  updateAnnotationLifecycle(
    origin: string,
    epoch: string,
    itemId: string,
    annotationId: string,
    expectedState: CaptureSessionAnnotationLifecycleStateV3,
    nextState: CaptureSessionAnnotationLifecycleStateV3,
    authority?: SessionMutationAuthority,
  ): Promise<SessionStoreResult<ActiveSessionReadback>>;
  applyAnnotationLifecycleOperation(
    input: AnnotationLifecycleOperationMutation,
    authority: SessionMutationAuthority,
  ): Promise<SessionStoreResult<{
    readback: ActiveSessionReadback;
    receipt: AnnotationLifecycleOperationLedgerReceiptV1;
  }>>;
  removeItem(
    origin: string,
    epoch: string,
    itemId: string,
    authority?: SessionMutationAuthority,
  ): Promise<SessionStoreResult<ActiveSessionReadback>>;
  clear(
    origin: string,
    epoch: string | null,
    operationId: string,
  ): Promise<SessionStoreResult<ActiveSessionReadback>>;
  clearOrigins(
    request: CaptureClearOperationRequest,
  ): Promise<SessionStoreResult<CaptureClearOperationV1>>;
}

export interface AnnotationLifecycleOperationMutation {
  origin: string;
  epoch: string;
  itemId: string;
  annotationId: string;
  expectedState: CaptureSessionAnnotationLifecycleStateV3;
  nextState: CaptureSessionAnnotationLifecycleStateV3;
  operationId: string;
  requestHash: string;
}

export interface CaptureCommitAuthority {
  isCurrent(): boolean;
  beforeWrite?(): Promise<void>;
  refresh?(): Promise<boolean>;
}

export interface SessionMutationAuthority {
  isCurrent(): boolean;
  refresh(record: OriginCaptureRecord): Promise<boolean>;
}

export type SessionStoreResult<T> =
  | { ok: true; value: T }
  | {
      ok: false;
      code:
        | SessionStateErrorCode
        | "STORAGE_ERROR"
        | "UNSUPPORTED_ORIGIN"
        | "ANNOTATION_LIFECYCLE_NOT_COMMITTED";
      error: string;
      issues?: Array<{ path: string; message: string }>;
    };

interface StoredState {
  state: SessionState;
  legacyRecord: OriginCaptureRecord | null;
}

const SESSION_STORAGE_MUTATION_LOCK_NAME = "meanthis:extension-session-store:v1";
let sessionStorageMutationTail: Promise<void> = Promise.resolve();

export function createExtensionSessionStore(options: {
  storage: ExtensionStorageArea;
  now?: () => Date;
  randomUUID?: () => string;
  createAnnotationId?: () => string;
}): ExtensionSessionStore {
  const storage = options.storage;
  const now = options.now ?? (() => new Date());
  const randomUUID = options.randomUUID ?? (() => crypto.randomUUID());
  const createAnnotationId = options.createAnnotationId ?? (() => crypto.randomUUID());

  function enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const run = sessionStorageMutationTail.then(
      () => withCrossContextSessionLock(operation),
      () => withCrossContextSessionLock(operation),
    );
    sessionStorageMutationTail = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  return {
    async list() {
      let values: Record<string, unknown>;
      try {
        values = await storage.get(null);
      } catch (error) {
        return storageFailure(error);
      }
      const safeValues = prepareStoredOriginSessionListing(values);
      if (!safeValues.ok) {
        return stateFailure("INVALID_SESSION_FILE", "Stored capture session listing is invalid.");
      }
      return { ok: true, value: listStoredOriginSessions(safeValues.value) };
    },

    async listClearOperations() {
      let authorityValues: Record<string, unknown>;
      try {
        authorityValues = await storage.get(CAPTURE_CLEAR_AUTHORITY_STORAGE_KEY);
      } catch (error) {
        return storageFailure(error);
      }
      const authorityEntry = readOwnDataProperty(
        authorityValues,
        CAPTURE_CLEAR_AUTHORITY_STORAGE_KEY,
      );
      if (authorityEntry === null || (authorityEntry.present && authorityEntry.value === undefined)) {
        return stateFailure("INVALID_SESSION_FILE", "Stored clear authority is invalid.");
      }
      if (!authorityEntry.present) return { ok: true, value: [] };
      const safeAuthority = cloneStoredDataValue(authorityEntry.value);
      if (!safeAuthority.ok) {
        return stateFailure("INVALID_SESSION_FILE", "Stored clear authority is invalid.");
      }
      let authority: CaptureClearAuthorityV1 | null;
      try {
        authority = parseCaptureClearAuthority(safeAuthority.value);
      } catch {
        authority = null;
      }
      if (!authority) {
        return stateFailure("INVALID_SESSION_FILE", "Stored clear authority is invalid.");
      }
      const operations = authority.activeOperations.map((operation) => structuredClone(operation));
      operations.sort((left, right) => left.generation - right.generation);
      return { ok: true, value: operations };
    },

    async finalizeClearOperation(referenceValue) {
      return enqueue(async () => {
        const reference = parseCaptureClearOperationReference(referenceValue);
        if (!reference) {
          return stateFailure("INVALID_SESSION_FILE", "Clear operation reference is invalid.");
        }
        let stored: Record<string, unknown>;
        try {
          stored = await storage.get(CAPTURE_CLEAR_AUTHORITY_STORAGE_KEY);
        } catch (error) {
          return storageFailure(error);
        }
        const rawAuthority = stored[CAPTURE_CLEAR_AUTHORITY_STORAGE_KEY];
        if (rawAuthority === undefined) {
          return stateFailure("ITEM_NOT_FOUND", "Clear operation was not found.");
        }
        const authority = parseCaptureClearAuthority(rawAuthority);
        if (!authority) {
          return stateFailure("INVALID_SESSION_FILE", "Stored clear authority is invalid.");
        }
        const operation = authority.activeOperations.find((candidate) =>
          candidate.operationId === reference.operationId
        );
        if (!operation) {
          return stateFailure("ITEM_NOT_FOUND", "Clear operation was not found.");
        }
        if (authority.authorityId !== reference.authorityId ||
            operation.authorityId !== reference.authorityId ||
            operation.generation !== reference.generation) {
          return stateFailure("STALE_SESSION", "Clear operation authority is stale.");
        }
        if (operation.origins.some((entry) => entry.canonical === "pending")) {
          return stateFailure("CLEAR_IN_PROGRESS", "Clear operation is not terminal.");
        }
        const finalized: CaptureClearAuthorityV1 = {
          ...authority,
          activeOperations: authority.activeOperations.filter((candidate) =>
            candidate.operationId !== operation.operationId
          ),
        };
        const persisted = await trySet(storage, {
          [CAPTURE_CLEAR_AUTHORITY_STORAGE_KEY]: finalized,
        });
        return persisted.ok
          ? { ok: true, value: structuredClone(operation) }
          : persisted;
      });
    },

    async clearAll() {
      return enqueue(async () => {
        let values: Record<string, unknown>;
        try {
          values = await storage.get(null);
        } catch (error) {
          return storageFailure(error);
        }
        const clearedOrigins = listStoredOriginSessions(values).map((summary) => summary.origin);
        const keys = Object.keys(values).filter(
          (key) => key.startsWith(SESSION_KEY_PREFIX) ||
            key.startsWith(ORIGIN_CAPTURE_KEY_PREFIX) ||
            key.startsWith(ANNOTATION_LIFECYCLE_OPERATION_LEDGER_STORAGE_PREFIX),
        );
        if (keys.length > 0) {
          try {
            await storage.remove(keys);
          } catch (error) {
            return storageFailure(error);
          }
        }
        return { ok: true, value: { clearedOrigins } };
      });
    },

    async read(origin) {
      return readActive(storage, origin);
    },

    async inspectCapture(origin, operationId) {
      const originResult = validateOrigin(origin);
      if (!originResult.ok) return originResult;
      return enqueue(async () => {
        const loaded = await loadStoredState(storage, origin);
        if (!loaded.ok) return loaded;
        const receipt = loaded.value.state.meta.receipts.find(
          (candidate) => candidate.operationId === operationId,
        );
        return {
          ok: true,
          value: {
            readback: toReadback(origin, loaded.value.state, loaded.value.legacyRecord),
            receiptItemId: receipt?.itemId ?? null,
          },
        };
      });
    },

    async beginCapture(origin, replaceItemId = null) {
      const originResult = validateOrigin(origin);
      if (!originResult.ok) return originResult;
      return enqueue(async () => {
        const loaded = await loadStoredState(storage, origin);
        if (!loaded.ok) return loaded;
        const state = loaded.value.state;
        if (state.meta.clearPending) {
          return stateFailure("CLEAR_IN_PROGRESS", "A session clear is already in progress.");
        }
        if (!state.meta.epoch) {
          state.meta = createSessionMeta(randomUUID());
          const written = await trySet(storage, { [getMetaKey(origin)]: state.meta });
          if (!written.ok) return written;
        }
        return beginSessionCapture(state, origin, randomUUID(), replaceItemId);
      });
    },

    async commitCapture(token, record, authority) {
      const originResult = validateOrigin(token.origin);
      if (!originResult.ok) return originResult;
      return enqueue(async () => {
        if (authority && !authority.isCurrent()) return staleCaptureOperation();
        const loaded = await loadStoredState(storage, token.origin);
        if (!loaded.ok) return loaded;
        if (loaded.value.state.meta.clearPending) {
          return stateFailure("CLEAR_IN_PROGRESS", "A session clear is already in progress.");
        }

        let normalizedRecord: OriginCaptureRecord;
        try {
          normalizedRecord = normalizeCaptureRecord(record);
        } catch (error) {
          return stateFailure("INVALID_SESSION_FILE", errorMessage(error));
        }
        const duplicateReceipt = loaded.value.state.meta.receipts.find(
          (candidate) => candidate.operationId === token.operationId,
        );
        const committedAt = sessionMutationTimestamp(now);
        if (!committedAt.ok) return committedAt;
        const committed = commitSessionCapture(
          loaded.value.state,
          token,
          normalizedRecord,
          committedAt.value,
          createAnnotationId,
        );
        if (!committed.ok) return committed;
        if (!committed.value.file) {
          return stateFailure("INVALID_SESSION_FILE", "Capture commit did not create a session.");
        }
        const receipt = committed.value.meta.receipts.find(
          (candidate) => candidate.operationId === token.operationId,
        );
        if (!receipt) {
          return stateFailure("ITEM_NOT_FOUND", "Capture receipt was not retained.");
        }
        const committedItem = committed.value.file.session.attachments.find(
          (item) => item.id === receipt.itemId,
        );
        if (!committedItem) {
          return stateFailure("ITEM_NOT_FOUND", "Capture receipt item was not retained.");
        }
        const label = committedItem?.labels.find((candidate) => candidate.trim().length > 0);
        if (!label) {
          return stateFailure("INVALID_SESSION_FILE", "Capture commit did not retain an item label.");
        }

        const canonicalSourceRecord = structuredClone(
          committedItem.sourceRecord,
        ) as unknown as Omit<OriginCaptureRecord, "markdown" | "summary">;
        const canonicalRecord: OriginCaptureRecord = {
          ...normalizedRecord,
          ...canonicalSourceRecord,
          markdown: normalizedRecord.markdown,
          ...(normalizedRecord.summary !== undefined
            ? { summary: normalizedRecord.summary }
            : {}),
        };
        const compatibilityProjection = duplicateReceipt
          ? {}
          : getLatestCaptureStorageEntries(canonicalRecord);
        const legacyRecord = duplicateReceipt
          ? loaded.value.legacyRecord
          : compatibilityProjection[getCaptureStorageKey(token.origin)] as OriginCaptureRecord;
        if (authority?.beforeWrite) {
          try {
            await authority.beforeWrite();
          } catch (error) {
            return storageFailure(error);
          }
        }
        if (authority && !authority.isCurrent()) return staleCaptureOperation();
        if (authority?.refresh) {
          try {
            if (!await authority.refresh()) return staleCaptureOperation();
          } catch (error) {
            return storageFailure(error);
          }
        }
        if (authority && !authority.isCurrent()) return staleCaptureOperation();
        const written = await trySet(storage, {
          [getSessionKey(token.origin)]: committed.value.file,
          [getMetaKey(token.origin)]: committed.value.meta,
          ...compatibilityProjection,
        });
        if (!written.ok) return written;
        return {
          ok: true,
          value: {
            readback: toReadback(token.origin, committed.value, legacyRecord),
            itemId: receipt.itemId,
            label,
          },
        };
      });
    },

    async updateIntent(origin, epoch, itemId, intent, authority) {
      const originResult = validateOrigin(origin);
      if (!originResult.ok) return originResult;
      return enqueue(async () => {
        const loaded = await loadStoredState(storage, origin);
        if (!loaded.ok) return loaded;
        const currentItem = loaded.value.state.file?.session.attachments.find(
          (item) => item.id === itemId,
        ) ?? null;
        const updatedAt = sessionMutationTimestamp(now);
        if (!updatedAt.ok) return updatedAt;
        const updated = updateSessionIntent(
          loaded.value.state,
          epoch,
          itemId,
          intent,
          updatedAt.value,
          createAnnotationId,
        );
        if (!updated.ok) return updated;
        if (authority && currentItem) {
          if (!authority.isCurrent()) return staleSessionMutation();
          try {
            if (!await authority.refresh(currentItem.sourceRecord as OriginCaptureRecord)) {
              return staleSessionMutation();
            }
          } catch (error) {
            return storageFailure(error);
          }
          if (!authority.isCurrent()) return staleSessionMutation();
        }
        const written = await writeState(storage, origin, updated.value);
        if (!written.ok) return written;
        return { ok: true, value: toReadback(origin, updated.value, loaded.value.legacyRecord) };
      });
    },

    async updateAnnotationLifecycle(
      origin,
      epoch,
      itemId,
      annotationId,
      expectedState,
      nextState,
      authority,
    ) {
      const originResult = validateOrigin(origin);
      if (!originResult.ok) return originResult;
      return enqueue(async () => {
        const loaded = await loadStoredState(storage, origin);
        if (!loaded.ok) return loaded;
        const currentItem = loaded.value.state.file?.session.attachments.find(
          (item) => item.id === itemId,
        ) ?? null;
        const updatedAt = sessionMutationTimestamp(now);
        if (!updatedAt.ok) return updatedAt;
        const updated = updateSessionAnnotationLifecycle(
          loaded.value.state,
          epoch,
          itemId,
          annotationId,
          expectedState,
          nextState,
          updatedAt.value,
        );
        if (!updated.ok) return updated;
        if (authority && currentItem) {
          if (!authority.isCurrent()) return staleSessionMutation();
          try {
            if (!await authority.refresh(currentItem.sourceRecord as OriginCaptureRecord)) {
              return staleSessionMutation();
            }
          } catch (error) {
            return storageFailure(error);
          }
          if (!authority.isCurrent()) return staleSessionMutation();
        }
        const written = await writeState(storage, origin, updated.value);
        if (!written.ok) return written;
        return { ok: true, value: toReadback(origin, updated.value, loaded.value.legacyRecord) };
      });
    },

    async applyAnnotationLifecycleOperation(inputValue, authority) {
      const input = parseAnnotationLifecycleOperationMutation(inputValue);
      if (!input) {
        return stateFailure("INVALID_SESSION_FILE", "Annotation lifecycle operation is invalid.");
      }
      const originResult = validateOrigin(input.origin);
      if (!originResult.ok) return originResult;
      return enqueue(async () => {
        const ledgerKey = getAnnotationLifecycleOperationLedgerStorageKey(input.origin);
        if (!ledgerKey) {
          return stateFailure("INVALID_SESSION_FILE", "Annotation lifecycle ledger origin is invalid.");
        }
        const storageKeys = [
          getSessionKey(input.origin),
          getMetaKey(input.origin),
          getCaptureStorageKey(input.origin),
          ledgerKey,
        ];
        let values: Record<string, unknown>;
        try {
          values = await storage.get(storageKeys);
        } catch (error) {
          return storageFailure(error);
        }
        const loaded = parseStoredStateValues(values, input.origin);
        if (!loaded.ok) return loaded;
        const ledgerEntry = readOwnDataProperty(values, ledgerKey);
        if (ledgerEntry === null || (ledgerEntry.present && ledgerEntry.value === undefined)) {
          return stateFailure("INVALID_SESSION_FILE", "Stored annotation lifecycle ledger is invalid.");
        }
        const ledger = ledgerEntry.present
          ? parseAnnotationLifecycleOperationLedger(ledgerEntry.value)
          : { ok: true as const, value: createEmptyAnnotationLifecycleOperationLedger() };
        if (!ledger.ok) return operationLedgerFailure(ledger.code);

        const existing = ledger.value.receipts.find(
          (candidate) => candidate.operationId === input.operationId,
        );
        if (existing) {
          let exactValues: Record<string, unknown>;
          try {
            exactValues = await storage.get([
              getSessionKey(input.origin),
              getMetaKey(input.origin),
              ledgerKey,
            ]);
          } catch (error) {
            return storageFailure(error);
          }
          const exact = parseAnnotationLifecycleOperationAtomicReadback({
            origin: input.origin,
            operationId: input.operationId,
            requestHash: input.requestHash,
            expectedPreviousState: input.expectedState,
            expectedNextState: input.nextState,
            values: exactValues,
          });
          if (!exact.ok) return operationLedgerFailure(exact.code);
          return {
            ok: true,
            value: {
              readback: toReadback(
                input.origin,
                { file: exact.value.file, meta: exact.value.meta },
                loaded.value.legacyRecord,
              ),
              receipt: exact.value.receipt,
            },
          };
        }

        const currentItem = loaded.value.state.file?.session.attachments.find(
          (item) => item.id === input.itemId,
        ) ?? null;
        if (!currentItem || !authority.isCurrent()) return annotationLifecycleNotCommitted();
        try {
          if (!await authority.refresh(currentItem.sourceRecord as OriginCaptureRecord)) {
            return annotationLifecycleNotCommitted();
          }
        } catch (error) {
          return storageFailure(error);
        }
        if (!authority.isCurrent()) return annotationLifecycleNotCommitted();
        const appliedAt = sessionMutationTimestamp(now);
        if (!appliedAt.ok) return appliedAt;
        const updated = updateSessionAnnotationLifecycle(
          loaded.value.state,
          input.epoch,
          input.itemId,
          input.annotationId,
          input.expectedState,
          input.nextState,
          appliedAt.value,
        );
        if (!updated.ok) return updated;
        const receipt: AnnotationLifecycleOperationLedgerReceiptV1 = {
          schemaVersion: ANNOTATION_LIFECYCLE_OPERATION_LEDGER_SCHEMA_VERSION,
          kind: ANNOTATION_LIFECYCLE_OPERATION_LEDGER_RECEIPT_KIND,
          operationId: input.operationId,
          requestHash: input.requestHash,
          epoch: input.epoch,
          itemId: input.itemId,
          annotationId: input.annotationId,
          previousState: input.expectedState,
          nextState: input.nextState,
          appliedAt: appliedAt.value,
        };
        const nextLedger = appendAnnotationLifecycleOperationLedgerReceipt(
          ledger.value,
          receipt,
        );
        if (!nextLedger.ok) return operationLedgerFailure(nextLedger.code);
        const payload = createAnnotationLifecycleOperationAtomicStoragePayload({
          origin: input.origin,
          operationId: input.operationId,
          requestHash: input.requestHash,
          expectedPreviousState: input.expectedState,
          expectedNextState: input.nextState,
          file: updated.value.file,
          meta: updated.value.meta,
          ledger: nextLedger.value,
        });
        if (!payload.ok) return operationLedgerFailure(payload.code);
        try {
          if (!await authority.refresh(currentItem.sourceRecord as OriginCaptureRecord)) {
            return annotationLifecycleNotCommitted();
          }
        } catch (error) {
          return storageFailure(error);
        }
        if (!authority.isCurrent()) return annotationLifecycleNotCommitted();
        const written = await trySet(storage, payload.value);
        if (!written.ok) return written;
        let readbackValues: Record<string, unknown>;
        try {
          readbackValues = await storage.get([
            getSessionKey(input.origin),
            getMetaKey(input.origin),
            ledgerKey,
          ]);
        } catch (error) {
          return storageFailure(error);
        }
        const readback = parseAnnotationLifecycleOperationAtomicReadback({
          origin: input.origin,
          operationId: input.operationId,
          requestHash: input.requestHash,
          expectedPreviousState: input.expectedState,
          expectedNextState: input.nextState,
          values: readbackValues,
        });
        if (!readback.ok) return operationLedgerFailure(readback.code);
        return {
          ok: true,
          value: {
            readback: toReadback(
              input.origin,
              { file: readback.value.file, meta: readback.value.meta },
              loaded.value.legacyRecord,
            ),
            receipt: readback.value.receipt,
          },
        };
      });
    },

    async removeItem(origin, epoch, itemId, authority) {
      const originResult = validateOrigin(origin);
      if (!originResult.ok) return originResult;
      return enqueue(async () => {
        const loaded = await loadStoredState(storage, origin);
        if (!loaded.ok) return loaded;
        const removedItem = loaded.value.state.file?.session.attachments.find(
          (item) => item.id === itemId,
        ) ?? null;
        const removedAt = sessionMutationTimestamp(now);
        if (!removedAt.ok) return removedAt;
        const removed = removeSessionItem(loaded.value.state, epoch, itemId, removedAt.value);
        if (!removed.ok) return removed;
        if (authority && removedItem) {
          if (!authority.isCurrent()) return staleSessionMutation();
          try {
            if (!await authority.refresh(removedItem.sourceRecord as OriginCaptureRecord)) {
              return staleSessionMutation();
            }
          } catch (error) {
            return storageFailure(error);
          }
          if (!authority.isCurrent()) return staleSessionMutation();
        }
        // Privacy-bearing compatibility projections are purged first. If the canonical
        // write then fails, the source session stays authoritative and the same Remove
        // command remains retryable without re-exposing the deleted projection.
        const projection = removedItem
          ? await removeMatchingItemProjections(storage, origin, removedItem.sourceRecord, removed.value)
          : { ok: true as const, value: loaded.value.legacyRecord };
        if (!projection.ok) return projection;
        const written = await writeState(storage, origin, removed.value);
        if (!written.ok) return written;
        return { ok: true, value: toReadback(origin, removed.value, projection.value) };
      });
    },

    async clear(origin, epoch, operationId) {
      const originResult = validateOrigin(origin);
      if (!originResult.ok) return originResult;
      return enqueue(async () => {
        if (epoch === null) {
          const loaded = await loadStoredState(storage, origin);
          if (loaded.ok) {
            if (loaded.value.state.meta.epoch) {
              return stateFailure("STALE_SESSION", "Clear request belongs to a stale epoch.");
            }
            return recoverClear(storage, origin, operationId, randomUUID());
          }
          if (loaded.code !== "INVALID_SESSION_FILE") return loaded;
          return recoverClear(storage, origin, operationId, randomUUID());
        }

        const loaded = await loadStoredState(storage, origin);
        if (!loaded.ok) return loaded;
        const current = loaded.value.state;
        if (
          !current.meta.clearPending &&
          current.meta.lastCompletedClearOperationId === operationId
        ) {
          return { ok: true, value: toReadback(origin, current, loaded.value.legacyRecord) };
        }

        const pending =
          current.meta.clearPending && current.meta.activeClearOperationId === operationId
            ? { ok: true as const, value: current }
            : startClearSession(current, epoch, operationId, randomUUID());
        if (!pending.ok) return pending;

        if (!current.meta.clearPending) {
          const pendingWrite = await trySet(storage, {
            [getMetaKey(origin)]: pending.value.meta,
          });
          if (!pendingWrite.ok) return pendingWrite;
        }

        const removed = await removeSessionAndMatchingProjections(storage, origin);
        if (!removed.ok) return removed;

        const completed = completeClearSession(
          { file: null, meta: pending.value.meta },
          pending.value.meta.epoch,
          operationId,
        );
        if (!completed.ok) return completed;
        const completedWrite = await trySet(storage, {
          [getMetaKey(origin)]: completed.value.meta,
        });
        if (!completedWrite.ok) return completedWrite;
        return readActive(storage, origin);
      });
    },

    async clearOrigins(request) {
      return enqueue(async () => {
        const normalized = normalizeCaptureClearRequest(request);
        if (!normalized) {
          for (const entry of request.origins ?? []) {
            const originResult = validateOrigin(entry.origin);
            if (!originResult.ok) return originResult;
          }
          return stateFailure("INVALID_SESSION_FILE", "Clear operation request is invalid.");
        }

        let stored: Record<string, unknown>;
        try {
          stored = await storage.get(CAPTURE_CLEAR_AUTHORITY_STORAGE_KEY);
        } catch (error) {
          return storageFailure(error);
        }

        const rawAuthority = stored[CAPTURE_CLEAR_AUTHORITY_STORAGE_KEY];
        const existingAuthority = rawAuthority === undefined
          ? null
          : parseCaptureClearAuthority(rawAuthority);
        if (rawAuthority !== undefined && !existingAuthority) {
          return stateFailure("INVALID_SESSION_FILE", "Stored clear authority is invalid.");
        }

        let operation: CaptureClearOperationV1;
        let authority: CaptureClearAuthorityV1;
        const existingOperation = existingAuthority?.activeOperations.find(
          (candidate) => candidate.operationId === normalized.operationId,
        );
        if (existingAuthority && existingOperation) {
          if (!sameCaptureClearRequest(existingOperation, normalized)) {
            return stateFailure("INVALID_SESSION_FILE", "Stored clear operation is invalid.");
          }
          operation = structuredClone(existingOperation);
          authority = existingAuthority;
        } else {
          const activeOperations = existingAuthority?.activeOperations ?? [];
          const requestedOrigins = new Set(normalized.origins.map((entry) => entry.origin));
          if (activeOperations.some((active) =>
            active.origins.some((entry) => requestedOrigins.has(entry.origin)))) {
            return stateFailure("CLEAR_IN_PROGRESS", "A clear operation already owns this origin.");
          }
          if (activeOperations.length >= CAPTURE_CLEAR_MAX_ACTIVE_OPERATIONS) {
            return stateFailure("SESSION_FULL", "Too many clear operations are active.");
          }
          if (existingAuthority?.generation === Number.MAX_SAFE_INTEGER) {
            return stateFailure("SESSION_FULL", "Clear authority generation is exhausted.");
          }

          const authorityId = existingAuthority?.authorityId ?? randomUUID();
          const generation = (existingAuthority?.generation ?? 0) + 1;
          const loadedOrigins: Array<{
            origin: string;
            beforeEpoch: string | null;
            afterEpoch: string;
          }> = [];
          for (const entry of normalized.origins) {
            const loaded = await loadStoredState(storage, entry.origin);
            if (!loaded.ok) return loaded;
            const currentEpoch = loaded.value.state.meta.epoch || null;
            if (currentEpoch !== entry.epoch) {
              return stateFailure("STALE_SESSION", "Clear request belongs to a stale epoch.");
            }
            loadedOrigins.push({
              origin: entry.origin,
              beforeEpoch: entry.epoch,
              afterEpoch: randomUUID(),
            });
          }

          const timestamp = clearTimestamp(now);
          if (!timestamp) {
            return stateFailure("INVALID_SESSION_FILE", "Clear operation clock is invalid.");
          }
          operation = {
            version: 1,
            operationId: normalized.operationId,
            authorityId,
            generation,
            phase: "prepared",
            origins: loadedOrigins.map((entry) => ({
              ...entry,
              canonical: "pending" as const,
            })),
            createdAt: timestamp,
            updatedAt: timestamp,
          };
          authority = {
            version: 1,
            authorityId,
            generation,
            activeOperations: [
              ...activeOperations,
              operation,
            ],
          };
          const prepared = await trySet(storage, {
            [CAPTURE_CLEAR_AUTHORITY_STORAGE_KEY]: authority,
          });
          if (!prepared.ok) return prepared;
        }

        if (operation.phase === "canonical_committed") {
          return { ok: true, value: operation };
        }

        for (const target of operation.origins) {
          if (target.canonical !== "pending") continue;
          const cleared = await clearOriginWithPreparedEpoch(
            storage,
            target.origin,
            target.beforeEpoch,
            target.afterEpoch,
            operation.operationId,
          );
          if (!cleared.ok) {
            if (cleared.code === "STALE_SESSION" || cleared.code === "CLEAR_IN_PROGRESS") {
              target.canonical = "conflict";
            } else if (cleared.code !== "STORAGE_ERROR") {
              return cleared;
            }
            operation.phase = deriveCaptureClearCanonicalPhase(operation.origins);
            operation.updatedAt = clearTimestamp(now, operation.updatedAt) ?? operation.updatedAt;
            authority = replaceClearOperation(authority, operation);
            const recorded = await trySet(storage, {
              [CAPTURE_CLEAR_AUTHORITY_STORAGE_KEY]: authority,
            });
            if (!recorded.ok) return recorded;
            return { ok: true, value: operation };
          }
          target.canonical = "committed";
          operation.phase = deriveCaptureClearCanonicalPhase(operation.origins);
          operation.updatedAt = clearTimestamp(now, operation.updatedAt) ?? operation.updatedAt;
          authority = replaceClearOperation(authority, operation);
          const recorded = await trySet(storage, {
            [CAPTURE_CLEAR_AUTHORITY_STORAGE_KEY]: authority,
          });
          if (!recorded.ok) return recorded;
        }

        return { ok: true, value: operation };
      });
    },
  };
}

function staleCaptureOperation(): SessionStoreResult<never> {
  return stateFailure(
    "STALE_CAPTURE_OPERATION",
    "Capture operation belongs to a stale page route.",
  );
}

function staleSessionMutation(): SessionStoreResult<never> {
  return stateFailure("STALE_SESSION", "Session mutation authority is stale.");
}

function annotationLifecycleNotCommitted(): SessionStoreResult<never> {
  return {
    ok: false,
    code: "ANNOTATION_LIFECYCLE_NOT_COMMITTED",
    error: "Annotation lifecycle operation is definitively absent from the durable ledger.",
  };
}

function operationLedgerFailure(
  code: "INVALID_VALUE" | "OVERBOUND" | "OPERATION_ID_CONFLICT" | "MISSING_RECEIPT" | "STALE_READBACK",
): SessionStoreResult<never> {
  return stateFailure(
    code === "OVERBOUND" ? "SESSION_FULL" : "STALE_SESSION",
    "Annotation lifecycle operation durable readback is invalid.",
  );
}

function parseAnnotationLifecycleOperationMutation(
  value: unknown,
): AnnotationLifecycleOperationMutation | null {
  const record = readExactDataRecord(value, [
    "origin", "epoch", "itemId", "annotationId", "expectedState", "nextState",
    "operationId", "requestHash",
  ]);
  if (
    !record ||
    typeof record.origin !== "string" ||
    typeof record.epoch !== "string" || record.epoch.length === 0 || record.epoch.length > 128 ||
    typeof record.itemId !== "string" || record.itemId.length === 0 || record.itemId.length > 128 ||
    !isCaptureSessionAnnotationId(record.annotationId) ||
    (record.expectedState !== "open" && record.expectedState !== "resolved") ||
    (record.nextState !== "open" && record.nextState !== "resolved") ||
    record.expectedState === record.nextState ||
    typeof record.operationId !== "string" ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(record.operationId) ||
    typeof record.requestHash !== "string" || !/^[0-9a-f]{64}$/.test(record.requestHash)
  ) return null;
  return record as unknown as AnnotationLifecycleOperationMutation;
}

async function withCrossContextSessionLock<T>(operation: () => Promise<T>): Promise<T> {
  const locks = globalThis.navigator?.locks;
  if (!locks) return operation();
  return locks.request(SESSION_STORAGE_MUTATION_LOCK_NAME, { mode: "exclusive" }, operation);
}

function replaceClearOperation(
  authority: CaptureClearAuthorityV1,
  operation: CaptureClearOperationV1,
): CaptureClearAuthorityV1 {
  return {
    ...authority,
    activeOperations: authority.activeOperations.map((candidate) =>
      candidate.operationId === operation.operationId ? structuredClone(operation) : candidate),
  };
}

function clearTimestamp(now: () => Date, floor?: string): string | null {
  try {
    const value = now().toISOString();
    return floor && value < floor ? floor : value;
  } catch {
    return null;
  }
}

function sessionMutationTimestamp(now: () => Date): SessionStoreResult<string> {
  try {
    return { ok: true, value: now().toISOString() };
  } catch {
    return stateFailure("INVALID_SESSION_FILE", "Session mutation clock is invalid.");
  }
}

async function clearOriginWithPreparedEpoch(
  storage: ExtensionStorageArea,
  origin: string,
  beforeEpoch: string | null,
  afterEpoch: string,
  operationId: string,
): Promise<SessionStoreResult<ActiveSessionReadback>> {
  const loaded = await loadStoredState(storage, origin);
  if (!loaded.ok) return loaded;
  const current = loaded.value.state;
  if (!current.meta.clearPending && current.meta.lastCompletedClearOperationId === operationId) {
    if (current.meta.epoch !== afterEpoch) {
      return stateFailure("STALE_SESSION", "Completed clear epoch does not match its manifest.");
    }
    return { ok: true, value: toReadback(origin, current, loaded.value.legacyRecord) };
  }

  let pending: SessionState;
  if (current.meta.clearPending) {
    if (current.meta.activeClearOperationId !== operationId || current.meta.epoch !== afterEpoch) {
      return stateFailure("CLEAR_IN_PROGRESS", "A different session clear is already in progress.");
    }
    pending = current;
  } else if (beforeEpoch === null) {
    if (current.meta.epoch) {
      return stateFailure("STALE_SESSION", "Clear request belongs to a stale epoch.");
    }
    pending = {
      file: current.file,
      meta: {
        ...createSessionMeta(afterEpoch),
        clearPending: true,
        activeClearOperationId: operationId,
      },
    };
  } else {
    const started = startClearSession(current, beforeEpoch, operationId, afterEpoch);
    if (!started.ok) return started;
    pending = started.value;
  }

  if (!current.meta.clearPending) {
    const pendingWrite = await trySet(storage, { [getMetaKey(origin)]: pending.meta });
    if (!pendingWrite.ok) return pendingWrite;
  }
  const removed = await removeSessionAndMatchingProjections(storage, origin);
  if (!removed.ok) return removed;
  const completed = completeClearSession(
    { file: null, meta: pending.meta },
    afterEpoch,
    operationId,
  );
  if (!completed.ok) return completed;
  const completedWrite = await trySet(storage, { [getMetaKey(origin)]: completed.value.meta });
  if (!completedWrite.ok) return completedWrite;
  return readActive(storage, origin);
}

async function readActive(
  storage: ExtensionStorageArea,
  origin: string,
): Promise<SessionStoreResult<ActiveSessionReadback>> {
  const originResult = validateOrigin(origin);
  if (!originResult.ok) return originResult;
  const loaded = await loadStoredState(storage, origin);
  if (!loaded.ok) return loaded;
  return {
    ok: true,
    value: toReadback(origin, loaded.value.state, loaded.value.legacyRecord),
  };
}

async function loadStoredState(
  storage: ExtensionStorageArea,
  origin: string,
): Promise<SessionStoreResult<StoredState>> {
  let values: Record<string, unknown>;
  try {
    values = await storage.get([getSessionKey(origin), getMetaKey(origin), getCaptureStorageKey(origin)]);
  } catch (error) {
    return storageFailure(error);
  }

  return parseStoredStateValues(values, origin);
}

function parseStoredStateValues(
  values: Record<string, unknown>,
  origin: string,
): SessionStoreResult<StoredState> {
  const metaEntry = readOwnDataProperty(values, getMetaKey(origin));
  const fileEntry = readOwnDataProperty(values, getSessionKey(origin));
  const legacyEntry = readOwnDataProperty(values, getCaptureStorageKey(origin));
  if (metaEntry === null || fileEntry === null || legacyEntry === null) {
    return stateFailure("INVALID_SESSION_FILE", "Stored capture session state is invalid.");
  }
  const meta = !metaEntry.present
    ? createSessionMeta("")
    : metaEntry.value === undefined
      ? null
      : parseMeta(metaEntry.value);
  if (!meta) {
    return stateFailure("INVALID_SESSION_FILE", "Stored capture session metadata is invalid.");
  }

  const file = !fileEntry.present
    ? { ok: true as const, value: null }
    : fileEntry.value === undefined
      ? stateFailure("INVALID_SESSION_FILE", "Stored capture session file is invalid.")
      : parseSessionFile(fileEntry.value, origin);
  if (!file.ok) return file;
  if (legacyEntry.present && legacyEntry.value === undefined) {
    return stateFailure("INVALID_SESSION_FILE", "Stored compatibility capture is invalid.");
  }
  return {
    ok: true,
    value: {
      state: { file: file.value, meta },
      legacyRecord: legacyEntry.present
        ? parseLegacyRecord(legacyEntry.value, origin)
        : null,
    },
  };
}

async function writeState(
  storage: ExtensionStorageArea,
  origin: string,
  state: SessionState,
): Promise<SessionStoreResult<void>> {
  return trySet(storage, {
    [getSessionKey(origin)]: state.file,
    [getMetaKey(origin)]: state.meta,
  });
}

async function recoverClear(
  storage: ExtensionStorageArea,
  origin: string,
  operationId: string,
  nextEpoch: string,
): Promise<SessionStoreResult<ActiveSessionReadback>> {
  const pendingMeta: CaptureSessionMetaV1 = {
    ...createSessionMeta(nextEpoch),
    clearPending: true,
    activeClearOperationId: operationId,
  };
  const pendingWrite = await trySet(storage, { [getMetaKey(origin)]: pendingMeta });
  if (!pendingWrite.ok) return pendingWrite;

  const removed = await removeSessionAndMatchingProjections(storage, origin);
  if (!removed.ok) return removed;

  const completed = completeClearSession({ file: null, meta: pendingMeta }, nextEpoch, operationId);
  if (!completed.ok) return completed;
  const completedWrite = await trySet(storage, { [getMetaKey(origin)]: completed.value.meta });
  if (!completedWrite.ok) return completedWrite;
  return readActive(storage, origin);
}

async function removeSessionAndMatchingProjections(
  storage: ExtensionStorageArea,
  origin: string,
): Promise<SessionStoreResult<void>> {
  let values: Record<string, unknown>;
  try {
    values = await storage.get([LATEST_CAPTURE_KEY]);
  } catch (error) {
    return storageFailure(error);
  }
  const keys = [getSessionKey(origin), getCaptureStorageKey(origin)];
  const operationLedgerKey = getAnnotationLifecycleOperationLedgerStorageKey(origin);
  if (!operationLedgerKey) {
    return stateFailure("INVALID_SESSION_FILE", "Annotation lifecycle ledger origin is invalid.");
  }
  keys.push(operationLedgerKey);
  const latest = parseLegacyRecord(values[LATEST_CAPTURE_KEY], origin);
  if (latest) {
    keys.push(LATEST_CAPTURE_KEY);
  }
  try {
    await storage.remove(keys);
    return { ok: true, value: undefined };
  } catch (error) {
    return storageFailure(error);
  }
}

async function removeMatchingItemProjections(
  storage: ExtensionStorageArea,
  origin: string,
  removedRecord: CaptureSessionFile["session"]["attachments"][number]["sourceRecord"],
  nextState: SessionState,
): Promise<SessionStoreResult<OriginCaptureRecord | null>> {
  const originCaptureKey = getCaptureStorageKey(origin);
  let values: Record<string, unknown>;
  try {
    values = await storage.get([originCaptureKey, LATEST_CAPTURE_KEY]);
  } catch (error) {
    return storageFailure(error);
  }

  const originProjection = parseLegacyRecord(values[originCaptureKey], origin);
  const globalProjection = parseLegacyRecord(values[LATEST_CAPTURE_KEY], origin);
  const sessionIsEmpty = (nextState.file?.session.attachments.length ?? 0) === 0;
  const removeOriginProjection = Object.hasOwn(values, originCaptureKey) && (
    sessionIsEmpty || (originProjection !== null && projectionMatchesRemovedItem(originProjection, removedRecord))
  );
  const removeGlobalProjection = globalProjection !== null && (
    sessionIsEmpty || projectionMatchesRemovedItem(globalProjection, removedRecord)
  );
  const keys = [
    ...(removeOriginProjection ? [originCaptureKey] : []),
    ...(removeGlobalProjection ? [LATEST_CAPTURE_KEY] : []),
  ];
  if (keys.length > 0) {
    try {
      await storage.remove(keys);
    } catch (error) {
      return storageFailure(error);
    }
  }
  return { ok: true, value: removeOriginProjection ? null : originProjection };
}

function projectionMatchesRemovedItem(
  projection: OriginCaptureRecord,
  removedRecord: CaptureSessionFile["session"]["attachments"][number]["sourceRecord"],
): boolean {
  return projection.origin === removedRecord.origin &&
    projection.pageUrl === removedRecord.pageUrl &&
    projection.attachment.id === removedRecord.attachment.id &&
    projection.capturedAt === removedRecord.capturedAt &&
    (projection.tabId ?? null) === (removedRecord.tabId ?? null) &&
    (projection.frameId ?? null) === (removedRecord.frameId ?? null);
}

async function trySet(
  storage: ExtensionStorageArea,
  items: Record<string, unknown>,
): Promise<SessionStoreResult<void>> {
  try {
    await storage.set(items);
    return { ok: true, value: undefined };
  } catch (error) {
    return storageFailure(error);
  }
}

function parseSessionFile(
  value: unknown,
  origin: string,
): SessionStoreResult<CaptureSessionFile> {
  const serialized = serializeCaptureSessionFile(value);
  if (!serialized.ok) return serialized;
  if (serialized.value.file.session.origin !== origin) {
    return stateFailure("INVALID_SESSION_FILE", "Stored capture session origin is invalid.");
  }
  return { ok: true, value: serialized.value.file };
}

function parseMeta(value: unknown): CaptureSessionMetaV1 | null {
  const record = readExactDataRecord(value, [
    "epoch",
    "clearPending",
    "activeClearOperationId",
    "lastCompletedClearOperationId",
    "receipts",
  ]);
  if (!record) return null;
  if (
    !isBoundedIdentifier(record.epoch) ||
    typeof record.clearPending !== "boolean" ||
    (record.activeClearOperationId !== null &&
      !isBoundedIdentifier(record.activeClearOperationId)) ||
    (record.lastCompletedClearOperationId !== null &&
      !isBoundedIdentifier(record.lastCompletedClearOperationId))
  ) {
    return null;
  }
  const activeClearOperationId = record.activeClearOperationId as string | null;
  if (
    record.clearPending !== (
      typeof activeClearOperationId === "string" && activeClearOperationId.length > 0
    )
  ) {
    return null;
  }
  const receiptValues = readDenseDataArray(record.receipts, SESSION_META_MAX_RECEIPTS);
  if (!receiptValues) return null;
  const receipts: CaptureSessionMetaV1["receipts"] = [];
  for (const receiptValue of receiptValues) {
    const receipt = readExactDataRecord(
      receiptValue,
      ["operationId", "itemId"],
      ["annotationId"],
    );
    if (
      !receipt ||
      !isBoundedIdentifier(receipt.operationId) ||
      !isNonEmptyString(receipt.itemId)
    ) return null;
    if (
      Object.hasOwn(receipt, "annotationId") &&
      receipt.annotationId !== null &&
      !isCaptureSessionAnnotationId(receipt.annotationId)
    ) return null;
    receipts.push({
      operationId: receipt.operationId,
      itemId: receipt.itemId,
      ...(Object.hasOwn(receipt, "annotationId")
        ? { annotationId: receipt.annotationId as string | null }
        : {}),
    });
  }
  return {
    epoch: record.epoch as string,
    clearPending: record.clearPending,
    activeClearOperationId,
    lastCompletedClearOperationId: record.lastCompletedClearOperationId as string | null,
    receipts,
  };
}

function readOwnDataProperty(
  value: object,
  key: PropertyKey,
): { present: false } | { present: true; value: unknown } | null {
  try {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor) return { present: false };
    if (!("value" in descriptor)) return null;
    return { present: true, value: descriptor.value };
  } catch {
    return null;
  }
}

function prepareStoredOriginSessionListing(
  values: Record<string, unknown>,
): SessionStoreResult<Record<string, unknown>> {
  if (typeof values !== "object" || values === null) {
    return stateFailure("INVALID_SESSION_FILE", "Stored capture session listing is invalid.");
  }
  let ownKeys: PropertyKey[];
  try {
    ownKeys = Reflect.ownKeys(values);
  } catch {
    return stateFailure("INVALID_SESSION_FILE", "Stored capture session listing is invalid.");
  }
  const stringKeys = ownKeys.filter((key): key is string => typeof key === "string");
  const keySet = new Set(stringKeys);
  const origins = new Set<string>();
  for (const key of stringKeys) {
    const candidate = key.startsWith(SESSION_META_KEY_PREFIX)
      ? null
      : key.startsWith(SESSION_KEY_PREFIX)
        ? key.slice(SESSION_KEY_PREFIX.length)
        : key.startsWith(ORIGIN_CAPTURE_KEY_PREFIX) && key !== LATEST_CAPTURE_KEY
          ? key.slice(ORIGIN_CAPTURE_KEY_PREFIX.length)
          : null;
    if (candidate && validateOrigin(candidate).ok) origins.add(candidate);
  }

  const safeValues: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
  for (const origin of origins) {
    const sessionKey = getSessionKey(origin);
    const metaKey = getMetaKey(origin);
    const captureKey = getCaptureStorageKey(origin);
    const keys = keySet.has(sessionKey)
      ? [sessionKey, ...(keySet.has(metaKey) ? [metaKey] : [])]
      : [captureKey];
    for (const key of keys) {
      const entry = readOwnDataProperty(values, key);
      if (!entry?.present || entry.value === undefined) {
        return stateFailure("INVALID_SESSION_FILE", "Stored capture session listing is invalid.");
      }
      const cloned = cloneStoredDataValue(entry.value);
      if (!cloned.ok) {
        return stateFailure("INVALID_SESSION_FILE", "Stored capture session listing is invalid.");
      }
      safeValues[key] = cloned.value;
    }
  }
  return { ok: true, value: safeValues };
}

function cloneStoredDataValue(
  value: unknown,
): { ok: true; value: unknown } | { ok: false } {
  const state = {
    nodes: 0,
    seen: new WeakSet<object>(),
  };
  return cloneStoredDataValueInner(value, state, 0);
}

function cloneStoredDataValueInner(
  value: unknown,
  state: { nodes: number; seen: WeakSet<object> },
  depth: number,
): { ok: true; value: unknown } | { ok: false } {
  state.nodes += 1;
  if (state.nodes > STORED_DATA_MAX_NODES || depth > STORED_DATA_MAX_DEPTH) {
    return { ok: false };
  }
  if (value === undefined || typeof value === "function" || typeof value === "symbol") {
    return { ok: false };
  }
  if (typeof value !== "object" || value === null) return { ok: true, value };
  if (state.seen.has(value)) return { ok: false };
  state.seen.add(value);

  let isArray: boolean;
  let ownKeys: PropertyKey[];
  try {
    isArray = Array.isArray(value);
    ownKeys = Reflect.ownKeys(value);
  } catch {
    return { ok: false };
  }
  if (isArray) {
    const lengthEntry = readOwnDataProperty(value, "length");
    if (!lengthEntry?.present || !Number.isSafeInteger(lengthEntry.value) ||
        (lengthEntry.value as number) < 0) {
      return { ok: false };
    }
    const length = lengthEntry.value as number;
    if (length > STORED_DATA_MAX_NODES) return { ok: false };
    const expectedKeys = new Set<PropertyKey>([
      "length",
      ...Array.from({ length }, (_, index) => String(index)),
    ]);
    if (ownKeys.length !== expectedKeys.size || ownKeys.some((key) => !expectedKeys.has(key))) {
      return { ok: false };
    }
    const result: unknown[] = [];
    for (let index = 0; index < length; index += 1) {
      const entry = readOwnDataProperty(value, String(index));
      if (!entry?.present || entry.value === undefined) return { ok: false };
      const cloned = cloneStoredDataValueInner(entry.value, state, depth + 1);
      if (!cloned.ok) return cloned;
      result.push(cloned.value);
    }
    return { ok: true, value: result };
  }

  const result: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
  for (const key of ownKeys) {
    if (typeof key !== "string") return { ok: false };
    const entry = readOwnDataProperty(value, key);
    if (!entry?.present || entry.value === undefined) return { ok: false };
    const cloned = cloneStoredDataValueInner(entry.value, state, depth + 1);
    if (!cloned.ok) return cloned;
    result[key] = cloned.value;
  }
  return { ok: true, value: result };
}

function readExactDataRecord(
  value: unknown,
  requiredKeys: readonly string[],
  optionalKeys: readonly string[] = [],
): Record<string, unknown> | null {
  if (typeof value !== "object" || value === null) return null;
  try {
    if (Array.isArray(value)) return null;
  } catch {
    return null;
  }
  let ownKeys: PropertyKey[];
  try {
    ownKeys = Reflect.ownKeys(value);
  } catch {
    return null;
  }
  const allowed = new Set([...requiredKeys, ...optionalKeys]);
  if (
    ownKeys.some((key) => typeof key !== "string" || !allowed.has(key)) ||
    requiredKeys.some((key) => !ownKeys.includes(key))
  ) return null;
  const result: Record<string, unknown> = {};
  for (const key of ownKeys) {
    if (typeof key !== "string") return null;
    const property = readOwnDataProperty(value, key);
    if (!property?.present || property.value === undefined) return null;
    result[key] = property.value;
  }
  return result;
}

function readDenseDataArray(value: unknown, maxLength: number): unknown[] | null {
  try {
    if (!Array.isArray(value)) return null;
  } catch {
    return null;
  }
  const lengthProperty = readOwnDataProperty(value, "length");
  if (
    !lengthProperty?.present ||
    !Number.isSafeInteger(lengthProperty.value) ||
    (lengthProperty.value as number) < 0 ||
    (lengthProperty.value as number) > maxLength
  ) return null;
  const length = lengthProperty.value as number;
  let ownKeys: PropertyKey[];
  try {
    ownKeys = Reflect.ownKeys(value);
  } catch {
    return null;
  }
  const allowed = new Set<PropertyKey>([
    "length",
    ...Array.from({ length }, (_, index) => String(index)),
  ]);
  if (ownKeys.length !== allowed.size || ownKeys.some((key) => !allowed.has(key))) return null;
  const result: unknown[] = [];
  for (let index = 0; index < length; index += 1) {
    const property = readOwnDataProperty(value, String(index));
    if (!property?.present || property.value === undefined) return null;
    result.push(property.value);
  }
  return result;
}

function isBoundedIdentifier(value: unknown): value is string {
  return typeof value === "string" &&
    value.length > 0 &&
    value.length <= SESSION_META_MAX_IDENTIFIER_LENGTH &&
    value.trim() === value &&
    !/[\u0000-\u001f\u007f]/u.test(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function parseLegacyRecord(value: unknown, origin: string): OriginCaptureRecord | null {
  if (!isOriginCaptureRecord(value, origin)) return null;
  try {
    return normalizeCaptureRecord(value);
  } catch {
    return null;
  }
}

function toReadback(
  origin: string,
  state: SessionState,
  legacyRecord: OriginCaptureRecord | null,
): ActiveSessionReadback {
  return {
    origin,
    epoch: state.meta.epoch || null,
    clearPending: state.meta.clearPending,
    activeClearOperationId: state.meta.activeClearOperationId,
    file: state.file,
    legacyRecord,
  };
}

function validateOrigin(origin: string): SessionStoreResult<string> {
  try {
    const url = new URL(origin);
    if ((url.protocol === "http:" || url.protocol === "https:") && url.origin === origin) {
      return { ok: true, value: origin };
    }
  } catch {
    // Fall through to unsupported origin.
  }
  return {
    ok: false,
    code: "UNSUPPORTED_ORIGIN",
    error: "Only canonical HTTP(S) origins are supported.",
  };
}

function getSessionKey(origin: string): string {
  return `${SESSION_KEY_PREFIX}${origin}`;
}

function getMetaKey(origin: string): string {
  return `${SESSION_META_KEY_PREFIX}${origin}`;
}

function listStoredOriginSessions(values: Record<string, unknown>): StoredOriginSessionSummary[] {
  const origins = new Set<string>();
  for (const key of Object.keys(values)) {
    const candidate = key.startsWith(SESSION_META_KEY_PREFIX)
      ? null
      : key.startsWith(SESSION_KEY_PREFIX)
        ? key.slice(SESSION_KEY_PREFIX.length)
        : key.startsWith(ORIGIN_CAPTURE_KEY_PREFIX) && key !== LATEST_CAPTURE_KEY
          ? key.slice(ORIGIN_CAPTURE_KEY_PREFIX.length)
          : null;
    if (candidate && validateOrigin(candidate).ok) origins.add(candidate);
  }

  return Array.from(origins, (origin): StoredOriginSessionSummary => {
    const sessionKey = getSessionKey(origin);
    const metaKey = getMetaKey(origin);
    const captureKey = getCaptureStorageKey(origin);
    if (Object.hasOwn(values, sessionKey)) {
      const file = parseSessionFile(values[sessionKey], origin);
      const meta = Object.hasOwn(values, metaKey) ? parseMeta(values[metaKey]) : null;
      const validState = file.ok && meta !== null && meta.epoch.length > 0;
      return {
        origin,
        epoch: validState ? meta.epoch : null,
        attachmentCount: file.ok ? file.value.session.attachments.length : null,
        state: validState ? "ready" : "needs_cleanup",
        clearPending: meta?.clearPending ?? false,
        activeClearOperationId: meta?.activeClearOperationId ?? null,
      };
    }

    const legacy = parseLegacyRecord(values[captureKey], origin);
    return {
      origin,
      epoch: null,
      attachmentCount: legacy ? 1 : null,
      state: legacy ? "legacy" : "needs_cleanup",
      clearPending: false,
      activeClearOperationId: null,
    };
  }).sort((left, right) => left.origin < right.origin ? -1 : left.origin > right.origin ? 1 : 0);
}

function isOriginCaptureRecord(value: unknown, origin: string): value is OriginCaptureRecord {
  return (
    typeof value === "object" &&
    value !== null &&
    "origin" in value &&
    value.origin === origin &&
    "attachment" in value &&
    typeof value.attachment === "object" &&
    value.attachment !== null
  );
}

function stateFailure(
  code: SessionStateErrorCode,
  error: string,
  issues?: Array<{ path: string; message: string }>,
): { ok: false; code: SessionStateErrorCode; error: string; issues?: Array<{ path: string; message: string }> } {
  return issues === undefined ? { ok: false, code, error } : { ok: false, code, error, issues };
}

function storageFailure(error: unknown): { ok: false; code: "STORAGE_ERROR"; error: string } {
  return {
    ok: false,
    code: "STORAGE_ERROR",
    error: `Extension storage operation failed: ${errorMessage(error)}`,
  };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
