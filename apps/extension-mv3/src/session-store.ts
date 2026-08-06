import type { CaptureSessionFileV1 } from "@meanthis/hub-core";
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
  updateSessionIntent,
  type CaptureSessionMetaV1,
  type CaptureToken,
  type SessionState,
  type SessionStateErrorCode,
} from "./session-state";

const LATEST_CAPTURE_KEY = "ui-attach:capture:latest";
const SESSION_KEY_PREFIX = "ui-attach:session:v1:";
const SESSION_META_KEY_PREFIX = `${SESSION_KEY_PREFIX}meta:`;
const ORIGIN_CAPTURE_KEY_PREFIX = "ui-attach:capture:";

export interface ActiveSessionReadback {
  origin: string;
  epoch: string | null;
  clearPending: boolean;
  activeClearOperationId: string | null;
  file: CaptureSessionFileV1 | null;
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
  clearAll(): Promise<SessionStoreResult<{ clearedOrigins: string[] }>>;
  read(origin: string): Promise<SessionStoreResult<ActiveSessionReadback>>;
  beginCapture(origin: string): Promise<SessionStoreResult<CaptureToken>>;
  commitCapture(
    token: CaptureToken,
    record: OriginCaptureRecord,
  ): Promise<SessionStoreResult<{ readback: ActiveSessionReadback; itemId: string; label: string }>>;
  updateIntent(
    origin: string,
    epoch: string,
    itemId: string,
    intent: string,
  ): Promise<SessionStoreResult<ActiveSessionReadback>>;
  removeItem(
    origin: string,
    epoch: string,
    itemId: string,
  ): Promise<SessionStoreResult<ActiveSessionReadback>>;
  clear(
    origin: string,
    epoch: string | null,
    operationId: string,
  ): Promise<SessionStoreResult<ActiveSessionReadback>>;
}

export type SessionStoreResult<T> =
  | { ok: true; value: T }
  | {
      ok: false;
      code: SessionStateErrorCode | "STORAGE_ERROR" | "UNSUPPORTED_ORIGIN";
      error: string;
      issues?: Array<{ path: string; message: string }>;
    };

interface StoredState {
  state: SessionState;
  legacyRecord: OriginCaptureRecord | null;
}

export function createExtensionSessionStore(options: {
  storage: ExtensionStorageArea;
  now?: () => Date;
  randomUUID?: () => string;
}): ExtensionSessionStore {
  const storage = options.storage;
  const now = options.now ?? (() => new Date());
  const randomUUID = options.randomUUID ?? (() => crypto.randomUUID());
  let mutationTail: Promise<void> = Promise.resolve();

  function enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const run = mutationTail.then(operation, operation);
    mutationTail = run.then(
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
      return { ok: true, value: listStoredOriginSessions(values) };
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
          (key) => key.startsWith(SESSION_KEY_PREFIX) || key.startsWith(ORIGIN_CAPTURE_KEY_PREFIX),
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

    async beginCapture(origin) {
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
        return beginSessionCapture(state, origin, randomUUID());
      });
    },

    async commitCapture(token, record) {
      const originResult = validateOrigin(token.origin);
      if (!originResult.ok) return originResult;
      return enqueue(async () => {
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
        const committed = commitSessionCapture(
          loaded.value.state,
          token,
          normalizedRecord,
          now().toISOString(),
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
        const label = committedItem?.labels.find((candidate) => candidate.trim().length > 0);
        if (!label) {
          return stateFailure("INVALID_SESSION_FILE", "Capture commit did not retain an item label.");
        }

        const compatibilityProjection = duplicateReceipt
          ? {}
          : getLatestCaptureStorageEntries(normalizedRecord);
        const legacyRecord = duplicateReceipt ? loaded.value.legacyRecord : normalizedRecord;
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

    async updateIntent(origin, epoch, itemId, intent) {
      const originResult = validateOrigin(origin);
      if (!originResult.ok) return originResult;
      return enqueue(async () => {
        const loaded = await loadStoredState(storage, origin);
        if (!loaded.ok) return loaded;
        const updated = updateSessionIntent(
          loaded.value.state,
          epoch,
          itemId,
          intent,
          now().toISOString(),
        );
        if (!updated.ok) return updated;
        const written = await writeState(storage, origin, updated.value);
        if (!written.ok) return written;
        return { ok: true, value: toReadback(origin, updated.value, loaded.value.legacyRecord) };
      });
    },

    async removeItem(origin, epoch, itemId) {
      const originResult = validateOrigin(origin);
      if (!originResult.ok) return originResult;
      return enqueue(async () => {
        const loaded = await loadStoredState(storage, origin);
        if (!loaded.ok) return loaded;
        const removedItem = loaded.value.state.file?.session.attachments.find(
          (item) => item.id === itemId,
        ) ?? null;
        const removed = removeSessionItem(loaded.value.state, epoch, itemId, now().toISOString());
        if (!removed.ok) return removed;
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
  };
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

  const metaValue = values[getMetaKey(origin)];
  const fileValue = values[getSessionKey(origin)];
  const meta = metaValue === undefined ? createSessionMeta("") : parseMeta(metaValue);
  if (!meta) {
    return stateFailure("INVALID_SESSION_FILE", "Stored capture session metadata is invalid.");
  }

  const file =
    fileValue === undefined ? { ok: true as const, value: null } : parseSessionFile(fileValue, origin);
  if (!file.ok) return file;
  return {
    ok: true,
    value: {
      state: { file: file.value, meta },
      legacyRecord: parseLegacyRecord(values[getCaptureStorageKey(origin)], origin),
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
  removedRecord: CaptureSessionFileV1["session"]["attachments"][number]["sourceRecord"],
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
  removedRecord: CaptureSessionFileV1["session"]["attachments"][number]["sourceRecord"],
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
): SessionStoreResult<CaptureSessionFileV1> {
  const serialized = serializeCaptureSessionFile(value);
  if (!serialized.ok) return serialized;
  if (serialized.value.file.session.origin !== origin) {
    return stateFailure("INVALID_SESSION_FILE", "Stored capture session origin is invalid.");
  }
  return { ok: true, value: serialized.value.file };
}

function parseMeta(value: unknown): CaptureSessionMetaV1 | null {
  if (typeof value !== "object" || value === null) return null;
  const record = value as Partial<CaptureSessionMetaV1>;
  if (
    typeof record.epoch !== "string" ||
    typeof record.clearPending !== "boolean" ||
    (record.activeClearOperationId !== null &&
      typeof record.activeClearOperationId !== "string") ||
    (record.lastCompletedClearOperationId !== null &&
      typeof record.lastCompletedClearOperationId !== "string") ||
    !Array.isArray(record.receipts)
  ) {
    return null;
  }
  const activeClearOperationId = record.activeClearOperationId;
  if (
    record.clearPending !== (
      typeof activeClearOperationId === "string" && activeClearOperationId.length > 0
    )
  ) {
    return null;
  }
  const receipts = record.receipts.filter(
    (receipt): receipt is { operationId: string; itemId: string } =>
      typeof receipt === "object" &&
      receipt !== null &&
      typeof (receipt as { operationId?: unknown }).operationId === "string" &&
      typeof (receipt as { itemId?: unknown }).itemId === "string",
  );
  if (receipts.length !== record.receipts.length) return null;
  return {
    epoch: record.epoch,
    clearPending: record.clearPending,
    activeClearOperationId,
    lastCompletedClearOperationId: record.lastCompletedClearOperationId,
    receipts,
  };
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
